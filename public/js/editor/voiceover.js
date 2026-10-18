// AI voiceover: text → speech through the server (Azure's Lao neural voices,
// or OpenAI), placed on the audio track. "Per subtitle" mode voices every line
// at its own start time and speeds a line up when it would run into the next.
import { state, commit, newId, sortTrack } from './store.js';
import { normalizeLao } from './lao.js';

export const VOICES = {
  azure: [
    ['lo-LA-KeomanyNeural', 'ແກ້ວມະນີ — ຍິງ (ລາວ)'],
    ['lo-LA-ChanthavongNeural', 'ຈັນທະວົງ — ຊາຍ (ລາວ)'],
    ['th-TH-PremwadeeNeural', 'Premwadee — ຍິງ (ໄທ)'],
    ['th-TH-NiwatNeural', 'Niwat — ຊາຍ (ໄທ)'],
    ['en-US-JennyNeural', 'Jenny — ຍິງ (English)'],
    ['en-US-GuyNeural', 'Guy — ຊາຍ (English)']
  ],
  openai: [
    ['nova', 'Nova — ຍິງ'], ['shimmer', 'Shimmer — ຍິງ'], ['coral', 'Coral — ຍິງ'],
    ['alloy', 'Alloy — ກາງ'], ['sage', 'Sage — ກາງ'],
    ['onyx', 'Onyx — ຊາຍ'], ['echo', 'Echo — ຊາຍ'], ['ash', 'Ash — ຊາຍ'], ['fable', 'Fable — ຊາຍ']
  ]
};

const PARALLEL = 3;

export function detectLang(text) {
  if (/[຀-໿]/.test(text)) return 'lo';
  if (/[฀-๿]/.test(text)) return 'th';
  return 'en';
}

export async function speak({ engine, voice, text, rate = 0, pitch = 0 }) {
  const lang = detectLang(text);
  const r = await fetch('/api/editor/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine, voice, rate, pitch, lang, text: lang === 'lo' ? normalizeLao(text) : text.trim() })
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return r.blob();
}

async function pool(items, n, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// Rate (in %) that makes a take of `dur` seconds, spoken at `rate`, fit `slot`.
function fittingRate(rate, dur, slot) {
  return Math.min(100, Math.ceil(((1 + rate / 100) * (dur / slot) * 1.05 - 1) * 100));
}

// Returns [{ sub, media }] with media probed but not yet added to the library.
async function voiceSubtitles(opts, { createMedia, discardMedia, onProgress }) {
  const subs = state.project.tracks.subs;
  const jobs = subs
    .map((s, i) => ({
      sub: s,
      text: (opts.useTr ? s.tr : s.text) || '',
      slot: (subs[i + 1] ? subs[i + 1].start : s.end + 1) - s.start
    }))
    .filter(j => j.text.trim() && j.text.trim() !== '...');
  if (!jobs.length) throw new Error(opts.useTr ? 'ຍັງບໍ່ມີແຖວຄຳແປ — ແປຊັບກ່ອນ' : 'ຍັງບໍ່ມີຊັບໃຫ້ພາກສຽງ');

  const results = [];
  let done = 0;
  await pool(jobs, PARALLEL, async j => {
    const name = `ສຽງພາກ ${j.text.slice(0, 24)}`;
    let media = await createMedia(await speak({ ...opts, text: j.text }), name, true);
    if (opts.fit && media.duration > j.slot * 1.03) {
      const rate = fittingRate(opts.rate, media.duration, j.slot);
      if (rate > opts.rate) {
        discardMedia(media);
        media = await createMedia(await speak({ ...opts, rate, text: j.text }), name, true);
      }
    }
    results.push({ sub: j.sub, media });
    onProgress(++done, jobs.length);
  });
  return results;
}

export function initVoiceover({ $, toast, busy, openModal, getStatus, createMedia, discardMedia, adoptMedia }) {
  const engineSel = $('#ttsEngine');
  const voiceSel = $('#ttsVoice');
  let preview = null; // { key, blob } of the last take, reused by "add"
  let audio = null;

  const opts = () => ({
    engine: engineSel.value,
    voice: voiceSel.value,
    rate: Number($('#ttsRate').value),
    pitch: engineSel.value === 'azure' ? Number($('#ttsPitch').value) : 0
  });

  function renderVoices() {
    voiceSel.innerHTML = VOICES[engineSel.value].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    $('#ttsPitchWrap').hidden = engineSel.value !== 'azure';
    renderStatus();
  }

  function ready() {
    const s = getStatus();
    return engineSel.value === 'azure' ? s.azure : s.whisper;
  }

  function renderStatus() {
    const ok = ready();
    $('#ttsStatus').innerHTML = ok
      ? '<span class="dot ok"></span> ພ້ອມໃຊ້ງານ'
      : `<span class="dot"></span> ຍັງບໍ່ໄດ້ຕັ້ງ ${engineSel.value === 'azure' ? 'Azure Speech Key' : 'OpenAI API Key'} — <a href="#" data-open-settings>ຕັ້ງຄ່າ</a>`;
    const link = $('#ttsStatus [data-open-settings]');
    if (link) link.onclick = e => { e.preventDefault(); openModal('settingsModal'); };
  }

  function checkLanguage(text) {
    const o = opts();
    if (o.engine !== 'azure') return;
    const lang = detectLang(text);
    if (!o.voice.startsWith(lang === 'lo' ? 'lo-' : lang === 'th' ? 'th-' : 'en-')) {
      toast('ພາສາຂອງຂໍ້ຄວາມບໍ່ກົງກັບສຽງທີ່ເລືອກ — ສຽງອາດອ່ານບໍ່ຖືກ', 'warn');
    }
  }

  async function take(text) {
    const key = JSON.stringify({ ...opts(), text });
    if (preview && preview.key === key) return preview.blob;
    const blob = await speak({ ...opts(), text });
    preview = { key, blob };
    return blob;
  }

  engineSel.addEventListener('change', renderVoices);
  for (const id of ['ttsRate', 'ttsPitch']) {
    $(`#${id}`).addEventListener('input', e => { $(`#${id}Out`).textContent = `${e.target.value > 0 ? '+' : ''}${e.target.value}%`; });
  }

  $('#ttsPreviewBtn').addEventListener('click', async () => {
    const text = $('#ttsText').value.trim();
    if (!text) return toast('ພິມຂໍ້ຄວາມກ່ອນ', 'warn');
    if (!ready()) return openModal('settingsModal');
    checkLanguage(text);
    try {
      busy('ກຳລັງສ້າງສຽງ...', 0.5);
      const blob = await take(text);
      busy(false);
      if (audio) { audio.pause(); URL.revokeObjectURL(audio.src); }
      audio = new Audio(URL.createObjectURL(blob));
      audio.play();
    } catch (e) {
      busy(false);
      toast(e.message, 'error');
    }
  });

  $('#ttsAddBtn').addEventListener('click', async () => {
    const text = $('#ttsText').value.trim();
    if (!text) return toast('ພິມຂໍ້ຄວາມກ່ອນ', 'warn');
    if (!ready()) return openModal('settingsModal');
    checkLanguage(text);
    try {
      busy('ກຳລັງສ້າງສຽງ...', 0.5);
      const media = await createMedia(await take(text), `ສຽງພາກ ${text.slice(0, 24)}`, false);
      busy(false);
      adoptMedia(media);
      commit(p => {
        p.tracks.audio.push({ id: newId(), mediaId: media.id, start: state.time, in: 0, out: media.duration, volume: 1, tts: 'text' });
        sortTrack('audio');
      });
      toast(`ເພີ່ມສຽງພາກ ${media.duration.toFixed(1)} ວິ ທີ່ເສັ້ນເວລາແລ້ວ ✓`, 'ok');
    } catch (e) {
      busy(false);
      toast(e.message, 'error');
    }
  });

  $('#ttsSubsBtn').addEventListener('click', async () => {
    if (!ready()) return openModal('settingsModal');
    const o = { ...opts(), useTr: $('#ttsUseTr').checked, fit: $('#ttsFit').checked };
    const sample = state.project.tracks.subs.map(s => (o.useTr ? s.tr : s.text) || '').join(' ');
    if (sample.trim()) checkLanguage(sample);
    try {
      busy('ກຳລັງສ້າງສຽງພາກ...', 0);
      const results = await voiceSubtitles(o, {
        createMedia,
        discardMedia,
        onProgress: (n, total) => busy(`ກຳລັງສ້າງສຽງພາກ ${n}/${total}...`, n / total)
      });
      busy(false);
      results.forEach(r => adoptMedia(r.media));
      const replace = $('#ttsReplace').checked;
      const duck = $('#ttsDuck').checked;
      commit(p => {
        if (replace) p.tracks.audio = p.tracks.audio.filter(c => c.tts !== 'subs');
        for (const { sub, media } of results) {
          p.tracks.audio.push({ id: newId(), mediaId: media.id, start: sub.start, in: 0, out: media.duration, volume: 1, tts: 'subs' });
        }
        sortTrack('audio');
        if (duck) for (const c of p.tracks.video) c.volume = Math.min(c.volume ?? 1, 0.2);
      });
      const late = results.filter(r => r.media.duration > (r.sub.end - r.sub.start) + 0.5).length;
      toast(`ພາກສຽງແລ້ວ ${results.length} ແຖວ ✓${late ? ` (${late} ແຖວຍາວກວ່າຊັບ)` : ''}`, 'ok');
    } catch (e) {
      busy(false);
      toast(e.message, 'error');
    }
  });

  renderVoices();
  return { renderStatus };
}
