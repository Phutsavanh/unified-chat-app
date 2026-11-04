// Cloned-voice presets ("my voices") and script → voiceover.
//  - A preset is made once from sample audio (upload, microphone, or a file
//    already in the media library) and kept on the server, so it can be used
//    again in any later project.
//  - A script is cut into sentence-sized pieces, voiced in parallel, and laid
//    out back to back on the audio track (one clip per piece, so a bad take
//    can be redone or trimmed alone), optionally with matching subtitles.
import { state, commit, newId, sortTrack } from './store.js';
import { speak } from './voiceover.js';
import { refineSegments } from './autosub.js';
import { splitPhrases, graphemeLength, normalizeLao } from './lao.js';
import { encodeWav, download, fmtTime } from './util.js';
import { escapeHtml } from './timeline.js';

const CHUNK_CHARS = 240;        // graphemes per TTS request
const PARALLEL = 3;
const MAX_SAMPLE_SEC = 180;     // longer samples don't improve an instant clone
const SCRIPT_KEY = 'laocut-script-draft';
const TEST_LINE = 'ສະບາຍດີ, ນີ້ແມ່ນສຽງພາກຂອງຂ້ອຍ. ຍິນດີທີ່ໄດ້ຮູ້ຈັກທຸກຄົນ.';
const PROVIDER_KEY = 'laocut-clone-provider';

let actx = null;
function audioCtx() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  return actx;
}

async function decode(blob) {
  return audioCtx().decodeAudioData(await blob.arrayBuffer());
}

function toMono(ab, maxSec = Infinity) {
  const n = Math.min(ab.length, Math.floor(maxSec * ab.sampleRate));
  const out = new Float32Array(n);
  for (let c = 0; c < ab.numberOfChannels; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ab.numberOfChannels;
  }
  return out;
}

// Script → [{ text, pause }]. Paragraphs (line breaks) get a longer pause.
export function splitScript(script, gap = 0.25, max = CHUNK_CHARS) {
  const out = [];
  for (const para of normalizeLao(script).split(/\n+/)) {
    if (!para.trim()) continue;
    const sentences = para.split(/(?<=[.!?…।]["'»)]?)\s+/).flatMap(s => splitPhrases(s, max)).filter(s => s.trim());
    // join short sentences so each request still has some context
    const pieces = [];
    for (const s of sentences) {
      const last = pieces[pieces.length - 1];
      if (last && graphemeLength(last) + graphemeLength(s) + 1 <= max) pieces[pieces.length - 1] = `${last} ${s}`;
      else pieces.push(s);
    }
    pieces.forEach((text, i) => out.push({ text, pause: i === pieces.length - 1 ? gap * 2.5 : gap }));
  }
  if (out.length) out[out.length - 1].pause = 0;
  return out;
}

async function pool(items, n, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// Takes → one mono WAV with the pauses in between.
function mergeTakes(takes) {
  const rate = audioCtx().sampleRate;
  const total = takes.reduce((s, t) => s + Math.ceil((t.buffer.duration + t.pause) * rate), 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const t of takes) {
    const mono = toMono(t.buffer);
    out.set(mono, o);
    o += Math.ceil((t.buffer.duration + t.pause) * rate);
  }
  return encodeWav(out, rate);
}

export function initVoiceClone({ $, toast, busy, openModal, getStatus, refreshStatus, createMedia, adoptMedia, onVoicesChanged }) {
  let voices = [];
  let models = {};
  let baseVoices = {};
  let defaultModel = 'eleven_v3';
  let online = false;
  let samples = [];   // pending samples for a new preset: { name, blob, duration }
  let takes = null;   // last script result: [{ text, pause, blob, buffer }]
  let player = null;
  let recorder = null;

  // ------------------------------------------------------------ helpers
  async function api(path, opts = {}) {
    const r = await fetch(`/api/editor${path}`, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  function play(blobOrUrl) {
    if (player) { player.pause(); if (player.dataset.own) URL.revokeObjectURL(player.src); }
    const own = typeof blobOrUrl !== 'string';
    player = new Audio(own ? URL.createObjectURL(blobOrUrl) : blobOrUrl);
    if (own) player.dataset.own = '1';
    player.play().catch(() => {});
  }

  // provider: 'local' (free voice server on this computer) or 'elevenlabs'
  function ready(provider) {
    const s = getStatus();
    if (provider === 'local') {
      if (s.local) return true;
      toast('ເຊີບເວີສຽງຟຣີຍັງບໍ່ເປີດ — ເປີດ voice-server/start.bat (Windows) ຫຼື start.sh ແລ້ວກົດ "ກວດໃໝ່"', 'warn');
      return false;
    }
    if (!s.eleven) { openModal('settingsModal'); return false; }
    return true;
  }

  const modelLabel = id => (models[id] || id).split(' — ')[0];
  const voiceLabel = v => v.provider === 'local'
    ? `💻 ຟຣີ · ${(baseVoices[v.baseVoice] || v.baseVoice).split(' (')[0]}`
    : `☁ ${modelLabel(v.model)}`;
  const providerOf = id => (voices.find(v => v.id === id) || {}).provider;

  // ------------------------------------------------------------ status & list
  function renderStatus() {
    const s = getStatus();
    const el = $('#cloneStatus');
    if (!online) {
      el.innerHTML = '<span class="dot"></span> ບໍ່ໄດ້ເຊື່ອມຕໍ່ເຊີບເວີ — ການໂຄລນສຽງຕ້ອງເປີດຜ່ານເຊີບເວີ LaoCut';
      return;
    }
    const local = !s.local
      ? '<span class="dot"></span> ເຊີບເວີສຽງຟຣີ: ຍັງບໍ່ເປີດ — ເປີດ <code>voice-server/start.bat</code>'
      : s.localError ? `<span class="dot"></span> ເຊີບເວີສຽງຟຣີ: ໂຫຼດໂມເດລບໍ່ໄດ້ — ${escapeHtml(s.localError)}`
      : s.localReady ? '<span class="dot ok"></span> ເຊີບເວີສຽງຟຣີ: ພ້ອມ'
      : '<span class="dot"></span> ເຊີບເວີສຽງຟຣີ: ກຳລັງໂຫຼດໂມເດລ (ຄັ້ງທຳອິດດາວໂຫຼດ ~130 MB)...';
    const eleven = s.eleven
      ? '<span class="dot ok"></span> ElevenLabs: ເຊື່ອມຕໍ່ແລ້ວ'
      : '<span class="dot"></span> ElevenLabs (ເສຍເງິນ): ບໍ່ໄດ້ຕັ້ງ — <a href="#" data-open-settings>ຕັ້ງຄ່າ</a>';
    el.innerHTML = `<div>${local}</div><div>${eleven}</div>` +
      `<div class="hint">${voices.length} ສຽງ · <a href="#" data-recheck>↻ ກວດໃໝ່</a></div>`;
    const link = el.querySelector('[data-open-settings]');
    if (link) link.onclick = e => { e.preventDefault(); openModal('settingsModal'); };
    el.querySelector('[data-recheck]').onclick = async e => {
      e.preventDefault();
      await refreshStatus();
      renderList();
    };
  }

  async function refresh() {
    try {
      const data = await api('/voices');
      voices = data.voices;
      models = data.models;
      defaultModel = data.defaultModel;
      baseVoices = data.baseVoices || {};
      online = true;
    } catch (e) {
      online = false;
    }
    renderModels();
    renderList();
    renderStatus();
  }

  function renderModels() {
    $('#cloneModel').innerHTML = Object.entries(models).map(([id, label]) =>
      `<option value="${id}"${id === defaultModel ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
    $('#cloneBaseVoice').innerHTML = Object.entries(baseVoices).map(([id, label]) =>
      `<option value="${id}">${escapeHtml(label)}</option>`).join('');
  }

  // the create form shows only what applies to the chosen provider
  const providerSel = $('#cloneProvider');
  try { providerSel.value = localStorage.getItem(PROVIDER_KEY) || 'local'; } catch (e) { /* ignore */ }
  function renderProvider() {
    const local = providerSel.value === 'local';
    $('#cloneBaseWrap').hidden = !local;
    $('#cloneModelWrap').hidden = local;
    $('#cloneNoiseWrap').hidden = local;
    $('#cloneAdvanced').hidden = local;
    $('#cloneProviderHint').innerHTML = local
      ? 'ຟຣີ ບໍ່ຈຳກັດ: ສຽງລາວພື້ນຖານຂອງ Microsoft (ອອກສຽງລາວຖືກ) ຖືກປ່ຽນໃຫ້ເປັນສຽງຂອງທ່ານດ້ວຍ OpenVoice ໃນຄອມຂອງທ່ານເອງ. ' +
        'ເລືອກສຽງພື້ນຖານ <b>ເພດດຽວກັນ</b> ກັບເຈົ້າຂອງສຽງ. ສຽງຈະຄືປະມານໜຶ່ງ (ໂທນສຽງ), ຈັງຫວະການເວົ້າມາຈາກສຽງພື້ນຖານ.'
      : 'ສຽງຄືກວ່າ ລວມທັງຈັງຫວະ ແລະ ອາລົມ, ແຕ່ຕ້ອງໃຊ້ແຜນ Starter ($5/ເດືອນ) ຂຶ້ນໄປ. ຄວນຟັງການອອກສຽງລາວກ່ອນ.';
  }
  providerSel.addEventListener('change', () => {
    try { localStorage.setItem(PROVIDER_KEY, providerSel.value); } catch (e) { /* ignore */ }
    renderProvider();
  });
  renderProvider();

  function renderList() {
    const sel = $('#scriptVoice').value;
    $('#voiceList').innerHTML = voices.length ? voices.map(v => `
      <div class="voice-item${v.id === sel ? ' selected' : ''}" data-id="${v.id}">
        <div class="voice-row">
          <button class="voice-main" data-act="pick" title="ໃຊ້ສຽງນີ້ພາກສະຄຣິບ">
            <b>${escapeHtml(v.name)}</b>
            <small>${escapeHtml(voiceLabel(v))} · ${v.imported ? 'ນຳເຂົ້າຈາກ Voice ID' : `${v.samples.length} ໄຟລ໌ຕົວຢ່າງ`}</small>
          </button>
          <button data-act="test" title="ຟັງສຽງໂຄລນ">▶</button>
          <button data-act="edit" title="ຕັ້ງຄ່າສຽງນີ້">⚙</button>
        </div>
        <div class="voice-edit" hidden></div>
      </div>`).join('')
      : '<div class="empty-hint">ຍັງບໍ່ມີສຽງ — ສ້າງພຣີເຊັດສຽງທຳອິດຂອງທ່ານຢູ່ລຸ່ມນີ້ 👇</div>';
    $('#scriptVoice').innerHTML = voices.length
      ? voices.map(v => `<option value="${v.id}"${v.id === sel ? ' selected' : ''}>${escapeHtml(v.name)}</option>`).join('')
      : '<option value="">— ຍັງບໍ່ມີສຽງ —</option>';
    onVoicesChanged(voices);
  }

  function editForm(v) {
    const s = v.settings;
    const slider = (k, label, hint) => `<label>${label} <output>${s[k].toFixed(2)}</output>
      <input type="range" data-k="${k}" min="0" max="1" step="0.05" value="${s[k]}"></label>${hint ? `<p class="hint">${hint}</p>` : ''}`;
    const local = v.provider === 'local';
    const tuning = local ? `
      <label>ສຽງພື້ນຖານ <select data-f="baseVoice">${Object.entries(baseVoices).map(([id, l]) =>
        `<option value="${id}"${id === v.baseVoice ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select></label>
      <p class="hint">ສຽງພື້ນຖານກຳນົດສຳນຽງ ແລະ ຈັງຫວະ; ເລືອກເພດດຽວກັບເຈົ້າຂອງສຽງ ຈະຄືກວ່າ.</p>` : `
      <label>ໂມເດລ <select data-f="model">${Object.entries(models).map(([id, l]) =>
        `<option value="${id}"${id === v.model ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select></label>
      ${slider('stability', 'ຄວາມສະຖຽນ', 'ຕ່ຳ = ມີອາລົມ ແລະ ຫຼາກຫຼາຍ, ສູງ = ສະໝ່ຳສະເໝີ (v3 ໃຊ້ 3 ລະດັບ: 0 / 0.5 / 1)')}
      ${slider('similarity', 'ຄວາມຄືກັບສຽງຕົ້ນສະບັບ')}
      ${slider('style', 'ເນັ້ນສະໄຕລ໌ (ບໍ່ໃຊ້ກັບ v3)')}`;
    return `
      <label>ຊື່ <input data-f="name" lang="lo" maxlength="60" value="${escapeHtml(v.name)}"></label>
      <label>ໝາຍເຫດ <input data-f="description" lang="lo" maxlength="300" value="${escapeHtml(v.description)}"></label>
      ${tuning}
      ${v.samples.length ? `<div class="voice-samples">ຕົວຢ່າງເດີມ: ${v.samples.map((x, i) =>
        `<button data-act="sample" data-n="${i}" title="${escapeHtml(x.label)}">▶ ${i + 1}</button>`).join('')}</div>` : ''}
      <div class="row">
        <button data-act="save" class="primary">ບັນທຶກ</button>
        ${v.samples.length ? '<button data-act="reclone" title="ສ້າງສຽງໃໝ່ຈາກໄຟລ໌ຕົວຢ່າງທີ່ເກັບໄວ້ (ເຊັ່ນ ປ່ຽນບັນຊີ/Key)">↻ ໂຄລນໃໝ່</button>' : ''}
        <button data-act="del" class="danger">ລຶບ</button>
      </div>`;
  }

  async function testVoice(v, btn) {
    if (!ready(v.provider)) return;
    btn.disabled = true;
    try {
      play(await speak({ engine: 'clone', voice: v.id, text: TEST_LINE }));
    } catch (e) {
      toast(e.message, 'error');
    }
    btn.disabled = false;
  }

  $('#voiceList').addEventListener('click', async e => {
    const btn = e.target.closest('button');
    const item = e.target.closest('.voice-item');
    if (!btn || !item) return;
    const v = voices.find(x => x.id === item.dataset.id);
    const box = item.querySelector('.voice-edit');
    const act = btn.dataset.act;
    if (act === 'pick') {
      $('#scriptVoice').value = v.id;
      renderList();
      $('#scriptText').focus();
    } else if (act === 'test') {
      testVoice(v, btn);
    } else if (act === 'edit') {
      box.hidden = !box.hidden;
      if (!box.hidden) box.innerHTML = editForm(v);
    } else if (act === 'sample') {
      play(`/api/editor/voices/${v.id}/samples/${btn.dataset.n}`);
    } else if (act === 'save') {
      const settings = {};
      box.querySelectorAll('[data-k]').forEach(i => { settings[i.dataset.k] = Number(i.value); });
      const body = v.provider === 'local' ? {} : { settings };
      box.querySelectorAll('[data-f]').forEach(i => { body[i.dataset.f] = i.value; });
      try {
        const { voice } = await api(`/voices/${v.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        Object.assign(v, voice);
        renderList();
        toast('ບັນທຶກການຕັ້ງຄ່າສຽງແລ້ວ ✓', 'ok');
      } catch (err) { toast(err.message, 'error'); }
    } else if (act === 'reclone') {
      if (!ready(v.provider) || !confirm(`ໂຄລນສຽງ "${v.name}" ໃໝ່ຈາກໄຟລ໌ຕົວຢ່າງທີ່ເກັບໄວ້?`)) return;
      try {
        busy('ກຳລັງໂຄລນສຽງໃໝ່...', 0.5);
        await api(`/voices/${v.id}/reclone`, { method: 'POST' });
        busy(false);
        toast('ໂຄລນສຽງໃໝ່ສຳເລັດ ✓', 'ok');
      } catch (err) { busy(false); toast(err.message, 'error'); }
    } else if (act === 'del') {
      if (!confirm(`ລຶບພຣີເຊັດສຽງ "${v.name}"? ໄຟລ໌ຕົວຢ່າງຈະຖືກລຶບນຳ (ສຽງທີ່ວາງໃນ timeline ແລ້ວຍັງຢູ່)`)) return;
      try {
        await api(`/voices/${v.id}`, { method: 'DELETE' });
        voices = voices.filter(x => x !== v);
        renderList();
        renderStatus();
        toast('ລຶບແລ້ວ');
      } catch (err) { toast(err.message, 'error'); }
    }
  });
  $('#voiceList').addEventListener('input', e => {
    const out = e.target.dataset.k && e.target.parentElement.querySelector('output');
    if (out) out.textContent = Number(e.target.value).toFixed(2);
  });
  $('#scriptVoice').addEventListener('change', renderList);

  // ------------------------------------------------------------ new preset: samples
  async function addSample(blob, name) {
    try {
      // everything becomes mono WAV: both providers read it, and video
      // files or browser recordings are reduced to their voice track
      const buf = await decode(blob);
      const out = encodeWav(toMono(buf, MAX_SAMPLE_SEC), buf.sampleRate);
      name = name.replace(/\.[^.]+$/, '') + '.wav';
      samples.push({ name, blob: out, duration: Math.min(buf.duration, MAX_SAMPLE_SEC) });
      renderSamples();
    } catch (e) {
      toast(`ອ່ານສຽງຈາກໄຟລ໌ນີ້ບໍ່ໄດ້: ${name}`, 'error');
    }
  }

  function renderSamples() {
    const total = samples.reduce((s, x) => s + x.duration, 0);
    const advice = !samples.length ? ''
      : total < 30 ? '<span class="warn-text">ສັ້ນໄປ — ແນະນຳ 1 ນາທີຂຶ້ນໄປ</span>'
      : total < 60 ? 'ພໍໃຊ້ໄດ້ — 1–3 ນາທີຈະຄືກວ່າ'
      : '<span class="ok-text">ຄວາມຍາວດີແລ້ວ ✓</span>';
    $('#cloneSamples').innerHTML = samples.map((s, i) => `
      <div class="clone-sample">
        <button data-i="${i}" data-act="play" title="ຟັງ">▶</button>
        <span>${escapeHtml(s.name)}</span><small>${fmtTime(s.duration, 0)}</small>
        <button data-i="${i}" data-act="rm" title="ເອົາອອກ">×</button>
      </div>`).join('') + (samples.length ? `<div class="hint">ລວມ ${fmtTime(total, 0)} · ${advice}</div>` : '');
  }

  $('#cloneSamples').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const s = samples[b.dataset.i];
    if (b.dataset.act === 'play') play(s.blob);
    if (b.dataset.act === 'rm') { samples.splice(Number(b.dataset.i), 1); renderSamples(); }
  });

  $('#cloneFileBtn').addEventListener('click', () => $('#cloneFiles').click());
  $('#cloneFiles').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    busy('ກຳລັງອ່ານໄຟລ໌ສຽງ...', 0.5);
    for (const f of files) await addSample(f, f.name);
    busy(false);
  });

  // files already imported into the project
  const fillLibrary = () => {
    const opts = [...state.media.values()].filter(m => !m.hidden && m.type !== 'image');
    $('#cloneFromLib').innerHTML = '<option value="">+ ໃຊ້ສຽງຈາກໄຟລ໌ໃນຄັງສື່...</option>' +
      opts.map(m => `<option value="${m.id}">${escapeHtml(m.name)} (${fmtTime(m.duration, 0)})</option>`).join('');
  };
  $('#cloneFromLib').addEventListener('focus', fillLibrary);
  $('#cloneFromLib').addEventListener('pointerdown', fillLibrary);
  $('#cloneFromLib').addEventListener('change', async e => {
    const m = state.media.get(e.target.value);
    e.target.value = '';
    if (!m) return;
    busy('ກຳລັງແຍກສຽງຈາກໄຟລ໌...', 0.5);
    await addSample(m.blob, m.name);
    busy(false);
  });

  $('#cloneRecBtn').addEventListener('click', async () => {
    if (recorder) { recorder.stop(); return; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      toast('ເປີດໄມໂຄຣໂຟນບໍ່ໄດ້ — ກວດສອບການອະນຸຍາດຂອງເບົາເຊີ', 'error');
      return;
    }
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = ev => ev.data.size && chunks.push(ev.data);
    const t0 = Date.now();
    const btn = $('#cloneRecBtn');
    const timer = setInterval(() => { btn.textContent = `■ ຢຸດອັດ ${fmtTime((Date.now() - t0) / 1000, 0)}`; }, 250);
    btn.classList.add('recording');
    recorder.onstop = async () => {
      clearInterval(timer);
      stream.getTracks().forEach(t => t.stop());
      btn.classList.remove('recording');
      btn.textContent = '🎙 ອັດສຽງ';
      recorder = null;
      const blob = new Blob(chunks, { type: chunks[0] ? chunks[0].type : 'audio/webm' });
      await addSample(blob, `ອັດສຽງ ${new Date().toLocaleTimeString()}.webm`);
    };
    recorder.start(1000);
    toast('ກຳລັງອັດສຽງ... ອ່ານຂໍ້ຄວາມໃດໜຶ່ງດ້ວຍສຽງປົກກະຕິ 1–2 ນາທີ ແລ້ວກົດ "ຢຸດອັດ"');
  });

  $('#cloneCreateBtn').addEventListener('click', async () => {
    if (!online) return toast('ຕ້ອງເປີດຜ່ານເຊີບເວີ LaoCut', 'error');
    const provider = providerSel.value;
    if (!ready(provider)) return;
    const name = $('#cloneName').value.trim();
    const voiceId = provider === 'local' ? '' : $('#cloneVoiceId').value.trim();
    if (!name) { $('#cloneName').focus(); return toast('ໃສ່ຊື່ສຽງກ່ອນ', 'warn'); }
    if (!voiceId && !samples.length) return toast('ເພີ່ມສຽງຕົວຢ່າງກ່ອນ (ເລືອກໄຟລ໌ ຫຼື ອັດສຽງ)', 'warn');
    if (!$('#cloneConsent').checked) return toast('ກະລຸນາຢືນຢັນສິດໃນສຽງນີ້ກ່ອນ', 'warn');
    const fd = new FormData();
    fd.append('name', name);
    fd.append('provider', provider);
    fd.append('baseVoice', $('#cloneBaseVoice').value);
    fd.append('consent', '1');
    fd.append('model', $('#cloneModel').value);
    fd.append('removeNoise', $('#cloneNoise').checked ? '1' : '0');
    if (voiceId) fd.append('voiceId', voiceId);
    else for (const s of samples) fd.append('files', s.blob, s.name);
    try {
      busy(voiceId ? 'ກຳລັງນຳເຂົ້າສຽງ...'
        : provider === 'local' ? 'ກຳລັງໂຄລນສຽງໃນເຄື່ອງ... (ຄັ້ງທຳອິດອາດໃຊ້ເວລາຫຼາຍນາທີ ເພາະຕ້ອງດາວໂຫຼດໂມເດລ)'
          : 'ກຳລັງໂຄລນສຽງ... (ປະມານ 10–30 ວິນາທີ)', 0.5);
      const { voice } = await api('/voices', { method: 'POST', body: fd });
      busy(false);
      voices.push(voice);
      samples = [];
      renderSamples();
      $('#cloneName').value = '';
      $('#cloneVoiceId').value = '';
      $('#cloneConsent').checked = false;
      renderList();               // adds the option…
      $('#scriptVoice').value = voice.id;
      renderList();               // …then marks it selected
      renderStatus();
      toast(`ສ້າງພຣີເຊັດສຽງ "${voice.name}" ສຳເລັດ ✓ ກົດ ▶ ເພື່ອຟັງ`, 'ok');
    } catch (e) {
      busy(false);
      toast(e.message, 'error');
    }
  });

  // ------------------------------------------------------------ script → voiceover
  const scriptEl = $('#scriptText');
  try { scriptEl.value = localStorage.getItem(SCRIPT_KEY) || ''; } catch (e) { /* storage blocked */ }
  const countScript = () => {
    const n = graphemeLength(scriptEl.value.trim());
    $('#scriptCount').textContent = n ? `${n.toLocaleString()} ຕົວອັກສອນ · ~${fmtTime(n / 14, 0)}` : '';
  };
  scriptEl.addEventListener('input', () => {
    countScript();
    try { localStorage.setItem(SCRIPT_KEY, scriptEl.value); } catch (e) { /* ignore */ }
  });
  countScript();
  $('#scriptRate').addEventListener('input', e => {
    $('#scriptRateOut').textContent = `${e.target.value > 0 ? '+' : ''}${e.target.value}%`;
  });

  function scriptOpts() {
    const voice = $('#scriptVoice').value;
    if (!voice) { toast('ສ້າງ ຫຼື ເລືອກພຣີເຊັດສຽງກ່ອນ', 'warn'); return null; }
    if (!ready(providerOf(voice))) return null;
    const gap = Math.min(3, Math.max(0, Number($('#scriptGap').value) || 0));
    const pieces = splitScript(scriptEl.value, gap);
    if (!pieces.length) { toast('ວາງສະຄຣິບກ່ອນ', 'warn'); scriptEl.focus(); return null; }
    return { voice, rate: Number($('#scriptRate').value), pieces };
  }

  const voiceTake = async (o, text) => {
    const blob = await speak({ engine: 'clone', voice: o.voice, rate: o.rate, text });
    return { blob, buffer: await decode(blob) };
  };

  $('#scriptPreviewBtn').addEventListener('click', async () => {
    const o = scriptOpts();
    if (!o) return;
    try {
      busy('ກຳລັງສ້າງສຽງ...', 0.5);
      const t = await voiceTake(o, o.pieces[0].text);
      busy(false);
      play(t.blob);
    } catch (e) { busy(false); toast(e.message, 'error'); }
  });

  $('#scriptGenBtn').addEventListener('click', async () => {
    const o = scriptOpts();
    if (!o) return;
    const chars = o.pieces.reduce((s, p) => s + graphemeLength(p.text), 0);
    if (chars > 5000 && providerOf(o.voice) !== 'local' &&
      !confirm(`ສະຄຣິບຍາວ ${chars.toLocaleString()} ຕົວອັກສອນ (ໃຊ້ເຄຣດິດ ElevenLabs ຕາມຈຳນວນຕົວອັກສອນ). ສືບຕໍ່ບໍ?`)) return;
    const result = new Array(o.pieces.length);
    let done = 0;
    try {
      busy(`ກຳລັງພາກສຽງ 0/${o.pieces.length}...`, 0);
      await pool(o.pieces, PARALLEL, async (p, i) => {
        result[i] = { ...p, ...(await voiceTake(o, p.text)), voice: o.voice, rate: o.rate };
        done++;
        busy(`ກຳລັງພາກສຽງ ${done}/${o.pieces.length}...`, done / o.pieces.length);
      });
      busy(false);
      takes = result;
      await insertTakes();
      renderResult();
    } catch (e) {
      busy(false);
      toast(`${e.message}${done ? ` (ສຳເລັດ ${done}/${o.pieces.length})` : ''}`, 'error');
    }
  });

  // One clip per take, back to back from the playhead (or where the previous
  // script voiceover started, when replacing it).
  async function insertTakes() {
    const medias = [];
    for (const t of takes) medias.push(await createMedia(t.blob, `ສຽງໂຄລນ ${t.text.slice(0, 24)}`, true));
    medias.forEach(adoptMedia);
    const replace = $('#scriptReplace').checked;
    const makeSubs = $('#scriptSubs').checked;
    const old = state.project.tracks.audio.filter(c => c.tts === 'script');
    const start = replace && old.length ? Math.min(...old.map(c => c.start)) : state.time;
    let end = start;
    commit(p => {
      if (replace) {
        p.tracks.audio = p.tracks.audio.filter(c => c.tts !== 'script');
        p.tracks.subs = p.tracks.subs.filter(s => s.src !== 'script');
      }
      let t = start;
      const segs = [];
      takes.forEach((tk, i) => {
        const m = medias[i];
        p.tracks.audio.push({ id: newId(), mediaId: m.id, start: t, in: 0, out: m.duration, volume: 1, tts: 'script' });
        segs.push({ start: t, end: t + m.duration, text: tk.text });
        t += m.duration + tk.pause;
      });
      end = t;
      sortTrack('audio');
      if (makeSubs) {
        const lines = refineSegments(segs, { maxChars: p.subStyle.maxChars });
        // drop older lines that the new voiceover now covers
        p.tracks.subs = p.tracks.subs.filter(s => !lines.some(l => s.start < l.end && s.end > l.start));
        for (const l of lines) p.tracks.subs.push({ id: newId(), start: l.start, end: l.end, text: l.text, src: 'script' });
        sortTrack('subs');
      }
    });
    toast(`ວາງສຽງພາກ ${takes.length} ທ່ອນ (${fmtTime(end - start, 0)}) ທີ່ເສັ້ນເວລາແລ້ວ ✓`, 'ok');
  }

  function renderResult() {
    const box = $('#scriptResult');
    box.hidden = !takes;
    if (!takes) return;
    const total = takes.reduce((s, t) => s + t.buffer.duration + t.pause, 0);
    box.innerHTML = `
      <div class="row result-head"><b>ຜົນລັບ: ${takes.length} ທ່ອນ · ${fmtTime(total, 0)}</b></div>
      <div class="row">
        <button data-act="all">▶ ຟັງທັງໝົດ</button>
        <button data-act="wav">⤓ ດາວໂຫຼດ WAV</button>
        <button data-act="insert" title="ວາງໃສ່ timeline ອີກເທື່ອ (ຫຼັງແກ້ໄຂທ່ອນໃດໜຶ່ງ)">↧ ວາງໃສ່ timeline</button>
      </div>
      <div class="takes">${takes.map((t, i) => `
        <div class="take" data-i="${i}">
          <button data-act="play" title="ຟັງ">▶</button>
          <span>${escapeHtml(t.text)}</span>
          <small>${t.buffer.duration.toFixed(1)}ວິ</small>
          <button data-act="redo" title="ພາກທ່ອນນີ້ໃໝ່ (ໄດ້ສຽງອອກມາຕ່າງກັນເລັກນ້ອຍ)">↻</button>
        </div>`).join('')}</div>
      <p class="hint">ທ່ອນໃດອ່ານບໍ່ດີ ກົດ ↻ ແລ້ວ "ວາງໃສ່ timeline" ອີກເທື່ອ (ຕ້ອງເປີດ "ແທນທີ່..." ໄວ້).</p>`;
  }

  $('#scriptResult').addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b || !takes) return;
    const act = b.dataset.act;
    const i = Number(b.closest('.take')?.dataset.i);
    if (act === 'all') play(mergeTakes(takes));
    if (act === 'wav') download(mergeTakes(takes), `ສຽງພາກ ${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.wav`);
    if (act === 'insert') insertTakes().catch(err => toast(err.message, 'error'));
    if (act === 'play') play(takes[i].blob);
    if (act === 'redo') {
      if (!ready(providerOf(takes[i].voice))) return;
      b.disabled = true;
      try {
        const t = takes[i];
        Object.assign(t, await voiceTake(t, t.text));
        renderResult();
        play(t.blob);
      } catch (err) { toast(err.message, 'error'); b.disabled = false; }
    }
  });

  refresh();
  return { refresh, renderStatus };
}
