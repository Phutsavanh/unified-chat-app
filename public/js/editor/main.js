import {
  state, emit, subscribe, commit, checkpoint, undo, redo, ASPECTS, DEFAULT_TEXT_STYLE,
  videoLayout, totalDuration, selectedClip, findClip, clipDuration, clipSpeed, sortTrack, newId, subDisplay, CLIP_DEFAULTS,
  persistMedia, deleteMedia, loadSaved, loadProject, resetProject
} from './store.js';
import { Player, LOOKS } from './player.js';
import { Timeline, escapeHtml } from './timeline.js';
import { mixTimelineAudio, transcribe, detectSpeech, alignScript, refineSegments } from './autosub.js';
import { exportVideo, supportedFormats } from './exporter.js';
import { initVoiceover } from './voiceover.js';
import { initVoiceClone } from './voiceclone.js';
import { allFonts, customFonts, loadCustomFonts, addFontFile, removeFont } from './fonts.js';
import { LAO_FONTS, normalizeLao, toLaoDigits, toArabicDigits, splitAtFraction, hasThaiScript } from './lao.js';
import { fmtTime, toSRT, toVTT, parseSubtitles, download, clamp } from './util.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const canvas = $('#preview');
const player = new Player(canvas);
const timeline = new Timeline($('#timeline'), {
  seek: t => player.seek(t),
  onDropMedia: (id, track, at) => addMediaToTimeline(id, at, track)
});

// ---------------------------------------------------------------- feedback
function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 3500);
  setTimeout(() => el.remove(), 4000);
}

function busy(msg, frac) {
  const o = $('#busy');
  if (msg === false) { o.hidden = true; return; }
  o.hidden = false;
  $('#busyMsg').textContent = msg;
  $('#busyBar').style.width = `${Math.round((frac ?? 0) * 100)}%`;
}

// ---------------------------------------------------------------- media
function probe(m) {
  return new Promise(resolve => {
    if (m.type === 'image') {
      const img = new Image();
      img.onload = () => {
        m.width = img.naturalWidth; m.height = img.naturalHeight;
        m.thumb = thumbFrom(img, img.naturalWidth, img.naturalHeight);
        resolve(m);
      };
      img.onerror = () => resolve(m);
      img.src = m.url;
      return;
    }
    const el = document.createElement(m.type === 'audio' ? 'audio' : 'video');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!m.duration) m.broken = true;
      resolve(m);
    };
    const timer = setTimeout(finish, 15000);
    const grabThumb = () => {
      m.duration = el.duration;
      if (m.type === 'audio') return finish();
      m.width = el.videoWidth; m.height = el.videoHeight;
      el.onseeked = () => { m.thumb = thumbFrom(el, el.videoWidth, el.videoHeight); finish(); };
      el.currentTime = Math.min(1, m.duration / 2);
    };
    el.preload = 'auto';
    el.muted = true;
    el.src = m.url;
    el.onloadedmetadata = () => {
      if (isFinite(el.duration)) return grabThumb();
      // WebM without a duration header: seeking far ahead makes the browser find it
      el.ontimeupdate = () => {
        if (!isFinite(el.duration)) return;
        el.ontimeupdate = null;
        el.currentTime = 0;
        grabThumb();
      };
      el.currentTime = 1e9;
    };
    el.onerror = () => { m.broken = true; finish(); };
  });
}

function thumbFrom(src, w, h) {
  const c = document.createElement('canvas');
  c.height = 72; c.width = Math.round(72 * (w / h || 16 / 9));
  try {
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  } catch (e) { return ''; }
}

function mediaType(file) {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  if (/\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name)) return 'video';
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name)) return 'audio';
  if (/\.(srt|vtt)$/i.test(file.name)) return 'subtitle';
  return null;
}

async function importFiles(files) {
  for (const file of files) {
    const type = mediaType(file);
    if (type === 'subtitle') { importSubtitleFile(file); continue; }
    if (!type) { toast(`ບໍ່ຮອງຮັບໄຟລ໌: ${file.name}`, 'error'); continue; }
    const m = { id: newId(), name: file.name, type, blob: file, url: URL.createObjectURL(file) };
    await probe(m);
    if (m.broken) { toast(`ເບົາເຊີເປີດໄຟລ໌ນີ້ບໍ່ໄດ້: ${file.name}`, 'error'); continue; }
    state.media.set(m.id, m);
    persistMedia(m);
  }
  renderMedia();
}

// Media made inside the app (AI voiceover). `hidden` keeps per-line clips out
// of the library; unused hidden files are cleaned up on the next load.
async function createMedia(blob, name, hidden) {
  const file = new File([blob], `${name}.mp3`, { type: blob.type || 'audio/mpeg' });
  const m = { id: newId(), name, type: 'audio', blob: file, url: URL.createObjectURL(file), hidden };
  await probe(m);
  if (m.broken) throw new Error('ອ່ານໄຟລ໌ສຽງທີ່ສ້າງບໍ່ໄດ້');
  return m;
}

function discardMedia(m) {
  URL.revokeObjectURL(m.url);
}

function adoptMedia(m) {
  state.media.set(m.id, m);
  persistMedia(m);
  if (!m.hidden) renderMedia();
}

function addMediaToTimeline(id, at = null, track = null) {
  const m = state.media.get(id);
  if (!m) return;
  commit(p => {
    if (m.type === 'audio') {
      p.tracks.audio.push({ id: newId(), mediaId: id, start: at ?? state.time, in: 0, out: m.duration, volume: 1 });
      sortTrack('audio');
      return;
    }
    if (!p.tracks.video.length && m.width && m.height) p.aspect = closestAspect(m.width / m.height);
    const clip = {
      id: newId(), mediaId: id, in: 0, out: m.type === 'image' ? 3 : m.duration,
      volume: 1, fit: 'contain', bg: 'blur'
    };
    let index = p.tracks.video.length;
    if (at !== null) {
      const l = videoLayout().findIndex(x => at < (x.start + x.end) / 2);
      if (l >= 0) index = l;
    }
    p.tracks.video.splice(index, 0, clip);
  });
  player.resize();
  toast(`ເພີ່ມ "${m.name}" ແລ້ວ`);
}

function closestAspect(r) {
  let best = '16:9', bd = Infinity;
  for (const [k, [w, h]] of Object.entries(ASPECTS)) {
    const d = Math.abs(Math.log(r / (w / h)));
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

async function removeMedia(id) {
  const used = [...state.project.tracks.video, ...state.project.tracks.audio].some(c => c.mediaId === id);
  if (used && !confirm('ໄຟລ໌ນີ້ຖືກໃຊ້ຢູ່ໃນ timeline. ລຶບອອກທັງໝົດບໍ?')) return;
  commit(p => {
    p.tracks.video = p.tracks.video.filter(c => c.mediaId !== id);
    p.tracks.audio = p.tracks.audio.filter(c => c.mediaId !== id);
  });
  const m = state.media.get(id);
  player.forget(id);
  state.media.delete(id);
  if (m) URL.revokeObjectURL(m.url);
  deleteMedia(id);
  renderMedia();
}

function renderMedia() {
  const list = $('#mediaList');
  const items = [...state.media.values()].filter(m => !m.hidden);
  list.innerHTML = items.length ? items.map(m => `
    <div class="media-item" draggable="true" data-id="${m.id}" title="${escapeHtml(m.name)}">
      <div class="media-thumb" style="${m.thumb ? `background-image:url(${m.thumb})` : ''}">
        ${m.type === 'audio' ? '<span class="media-ico">♪</span>' : ''}
        <span class="media-dur">${m.type === 'image' ? 'ຮູບ' : fmtTime(m.duration, 0)}</span>
        <button class="media-add" data-act="add" title="ເພີ່ມໃສ່ timeline">+</button>
        <button class="media-del" data-act="del" title="ລຶບ">×</button>
      </div>
      <div class="media-name">${escapeHtml(m.name)}</div>
    </div>`).join('')
    : '<div class="empty-hint">ຍັງບໍ່ມີໄຟລ໌<br>ກົດ "ນຳເຂົ້າ" ຫຼື ລາກໄຟລ໌ມາວາງ</div>';
}

$('#mediaList').addEventListener('click', e => {
  const item = e.target.closest('.media-item');
  if (!item) return;
  const act = e.target.dataset.act;
  if (act === 'add') addMediaToTimeline(item.dataset.id);
  if (act === 'del') removeMedia(item.dataset.id);
});
$('#mediaList').addEventListener('dblclick', e => {
  const item = e.target.closest('.media-item');
  if (item) addMediaToTimeline(item.dataset.id);
});
$('#mediaList').addEventListener('dragstart', e => {
  const item = e.target.closest('.media-item');
  if (item) e.dataTransfer.setData('text/x-media-id', item.dataset.id);
});
$('#importBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', e => { importFiles([...e.target.files]); e.target.value = ''; });

// drop files anywhere on the page
window.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); document.body.classList.add('file-drop'); } });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('file-drop'); });
window.addEventListener('drop', e => {
  document.body.classList.remove('file-drop');
  if (e.dataTransfer.files.length) { e.preventDefault(); importFiles([...e.dataTransfer.files]); }
});

// ---------------------------------------------------------------- text
const TEXT_PRESETS = [
  { name: 'ພື້ນຖານ', style: {} },
  { name: 'ຫົວຂໍ້ເຫຼືອງ', style: { color: '#facc15', size: 64, strokeWidth: 5, anim: 'pop' } },
  { name: 'ກ່ອງດຳ', style: { bg: true, strokeWidth: 0, bgOpacity: 0.7, shadow: false } },
  { name: 'ປ້າຍແດງ', style: { bg: true, bgColor: '#dc2626', bgOpacity: 1, strokeWidth: 0, shadow: false } },
  { name: 'ນີອອນ', style: { color: '#67e8f9', stroke: '#0e7490', strokeWidth: 3, font: 'Noto Sans Lao Looped' } },
  { name: 'ທາງການ', style: { font: 'Noto Serif Lao', bold: false, strokeWidth: 0, shadow: true } },
  { name: 'ເພັດສະລາດ', style: { font: 'Phetsarath', color: '#fde68a', stroke: '#78350f' } },
  { name: 'ພິມດີດ', style: { anim: 'type', bg: true, strokeWidth: 0, bgOpacity: 0.5 } }
];

function presetCss(style) {
  const s = { ...DEFAULT_TEXT_STYLE, ...style };
  return `font-family:'${s.font}';font-weight:${s.bold ? 700 : 400};color:${s.color};` +
    (s.strokeWidth ? `-webkit-text-stroke:1px ${s.stroke};` : '') +
    (s.bg ? `background:${s.bgColor};` : '');
}

$('#textPresets').innerHTML = TEXT_PRESETS.map((p, i) =>
  `<button class="preset" data-i="${i}"><span style="${presetCss(p.style)}">ສະບາຍດີ</span><small>${p.name}</small></button>`).join('');

function addTextWithStyle(style) {
  const id = newId();
  commit(pr => {
    pr.tracks.text.push({
      id, start: state.time, end: state.time + 3, text: 'ພິມຂໍ້ຄວາມຂອງທ່ານ',
      style: { ...DEFAULT_TEXT_STYLE, ...style }
    });
    sortTrack('text');
  });
  select('text', id);
  setTimeout(() => { const ta = $('#props textarea'); if (ta) { ta.focus(); ta.select(); } }, 0);
}

// Subtitles keep their own position and line length; the rest of the look is copied.
function applyStyleToSubs(style, name) {
  commit(p => {
    const keep = { y: p.subStyle.y, maxChars: p.subStyle.maxChars, laoDigits: p.subStyle.laoDigits };
    p.subStyle = { ...p.subStyle, ...style, ...keep };
  });
  toast(`ໃຊ້ຮູບແບບ "${name}" ກັບຊັບທັງໝົດແລ້ວ`, 'ok');
}

$('#textPresets').addEventListener('click', e => {
  const b = e.target.closest('.preset');
  if (b) addTextWithStyle(TEXT_PRESETS[b.dataset.i].style);
});

// ---------------------------------------------------------------- my presets (font preset creator)
// Saved on the server so they last across browsers; localStorage is the
// fallback when the editor runs without the server.
const PRESETS_KEY = 'laocut-text-presets';
const STYLE_KEYS = Object.keys(DEFAULT_TEXT_STYLE);
let myPresets = [];
let draft = { ...DEFAULT_TEXT_STYLE, ...TEXT_PRESETS[1].style };
let editingPreset = null;

function pickStyle(st) {
  const out = {};
  for (const k of STYLE_KEYS) if (st[k] !== undefined) out[k] = st[k];
  return out;
}

async function loadPresets() {
  let local = [];
  try { local = JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]'); } catch (e) { /* ignore */ }
  myPresets = local;
  try {
    const r = await fetch('/api/editor/text-presets');
    if (r.ok) {
      const server = (await r.json()).presets;
      const ids = new Set(server.map(p => p.id));
      const onlyLocal = local.filter(p => !ids.has(p.id)); // made while offline
      myPresets = [...server, ...onlyLocal];
      if (onlyLocal.length) storePresets();
    }
  } catch (e) { /* static page: local only */ }
  renderMyPresets();
}

async function storePresets() {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(myPresets)); } catch (e) { /* ignore */ }
  try {
    await fetch('/api/editor/text-presets', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ presets: myPresets })
    });
  } catch (e) { /* offline */ }
}

function renderMyPresets() {
  $('#myPresets').innerHTML = myPresets.length ? myPresets.map((p, i) => `
    <div class="preset mine" data-i="${i}" title="${escapeHtml(p.name)}">
      <span style="${presetCss(p.style)}">ສະບາຍດີ</span><small>${escapeHtml(p.name)}</small>
      <div class="preset-tools">
        <button data-act="subs" title="ໃຊ້ກັບຊັບທັງໝົດ">CC</button>
        <button data-act="edit" title="ແກ້ໄຂໃນຕົວສ້າງ">✎</button>
        <button data-act="del" title="ລຶບ">×</button>
      </div>
    </div>`).join('')
    : '<div class="empty-hint">ຍັງບໍ່ມີ — ອອກແບບໃນ "ສ້າງພຣີເຊັດຟອນ" ແລ້ວກົດບັນທຶກ</div>';
  renderSubPresetPicker();
}

$('#myPresets').addEventListener('click', e => {
  const item = e.target.closest('.preset.mine');
  if (!item) return;
  const p = myPresets[item.dataset.i];
  const act = e.target.dataset.act;
  if (act === 'del') {
    if (!confirm(`ລຶບພຣີເຊັດ "${p.name}"?`)) return;
    myPresets.splice(Number(item.dataset.i), 1);
    storePresets();
    renderMyPresets();
  } else if (act === 'subs') applyStyleToSubs(p.style, p.name);
  else if (act === 'edit') {
    draft = { ...DEFAULT_TEXT_STYLE, ...p.style };
    editingPreset = p.id;
    $('#presetName').value = p.name;
    renderCreator();
    $('#presetName').scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else addTextWithStyle(p.style);
});

function drawPresetPreview() {
  const cv = $('#presetPreview');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.save();
  // a narrow virtual frame makes the text big enough to judge the font;
  // only the middle band of it is shown
  const W = cv.width, H = 720;
  ctx.translate(0, -(H - cv.height) / 2);
  const st = { ...draft, x: 0.5, y: 0.5, anim: 'none' };
  player.drawText.call({ ctx }, $('#presetSample').value || 'ສະບາຍດີ', st, 1, 3, W, H);
  ctx.restore();
}

function renderCreator() {
  const fields = styleFields(false).filter(f => !['x', 'y'].includes(f.k));
  // `local`: the draft isn't part of the project, so no undo steps or saves
  const f = form(fields, draft, () => drawPresetPreview(), { local: true });
  const box = document.createElement('div');
  box.innerHTML = f.html;
  $('#presetForm').replaceChildren(box);
  f.bind(box);
  drawPresetPreview();
}

$('#presetSample').addEventListener('input', drawPresetPreview);
$('#presetSaveBtn').addEventListener('click', () => {
  const name = $('#presetName').value.trim();
  if (!name) { $('#presetName').focus(); return toast('ຕັ້ງຊື່ພຣີເຊັດກ່ອນ', 'warn'); }
  const existing = myPresets.find(p => p.id === editingPreset) || myPresets.find(p => p.name === name);
  if (existing) {
    if (existing.name !== name || existing.id !== editingPreset) {
      if (!confirm(`ບັນທຶກທັບພຣີເຊັດ "${existing.name}"?`)) return;
    }
    existing.name = name;
    existing.style = pickStyle(draft);
  } else {
    myPresets.push({ id: newId(), name, style: pickStyle(draft), createdAt: new Date().toISOString() });
  }
  editingPreset = null;
  $('#presetName').value = '';
  storePresets();
  renderMyPresets();
  toast(`ບັນທຶກພຣີເຊັດ "${name}" ແລ້ວ ✓`, 'ok');
});
$('#presetFromSelBtn').addEventListener('click', () => {
  const sel = state.selection;
  const c = selectedClip();
  if (sel && sel.track === 'text' && c) draft = { ...DEFAULT_TEXT_STYLE, ...c.style };
  else draft = { ...DEFAULT_TEXT_STYLE, ...pickStyle(state.project.subStyle) };
  editingPreset = null;
  renderCreator();
  toast(sel && sel.track === 'text' ? 'ດຶງຮູບແບບຈາກຂໍ້ຄວາມທີ່ເລືອກແລ້ວ' : 'ດຶງຮູບແບບຈາກຊັບໄຕເຕິ້ນແລ້ວ');
});
$('#presetAddTextBtn').addEventListener('click', () => addTextWithStyle(pickStyle(draft)));
$('#presetToSubsBtn').addEventListener('click', () => applyStyleToSubs(pickStyle(draft), $('#presetName').value.trim() || 'ໃໝ່'));

// "Save as preset" from the properties panel
function saveStyleAsPreset(style) {
  const name = prompt('ຊື່ພຣີເຊັດ:', '');
  if (!name || !name.trim()) return;
  myPresets.push({ id: newId(), name: name.trim().slice(0, 40), style: pickStyle(style), createdAt: new Date().toISOString() });
  storePresets();
  renderMyPresets();
  toast(`ບັນທຶກພຣີເຊັດ "${name.trim()}" ແລ້ວ ✓ (ແຖບ T ຂໍ້ຄວາມ)`, 'ok');
}

function renderSubPresetPicker() {
  const sel = $('#props select[data-act=subPreset]');
  if (sel) sel.innerHTML = subPresetOptions();
}
function subPresetOptions() {
  return '<option value="">ໃຊ້ພຣີເຊັດ...</option>' +
    TEXT_PRESETS.map((p, i) => `<option value="b${i}">${p.name}</option>`).join('') +
    myPresets.map((p, i) => `<option value="m${i}">⭐ ${escapeHtml(p.name)}</option>`).join('');
}

// ---------------------------------------------------------------- my fonts
function renderFonts() {
  $('#fontList').innerHTML = customFonts.length ? customFonts.map(f => `
    <div class="font-item"><span style="font-family:'${f.family}'">${escapeHtml(f.family)} — ສະບາຍດີ Aa</span>
      <button data-id="${f.id}" title="ລຶບຟອນ">×</button></div>`).join('')
    : '<div class="hint">ຍັງບໍ່ມີຟອນທີ່ເພີ່ມເອງ</div>';
}
$('#fontAddBtn').addEventListener('click', () => $('#fontInput').click());
$('#fontInput').addEventListener('change', async e => {
  for (const file of [...e.target.files]) {
    try {
      const f = await addFontFile(file);
      toast(`ເພີ່ມຟອນ "${f.family}" ແລ້ວ ✓`, 'ok');
    } catch (err) { toast(`${file.name}: ${err.message}`, 'error'); }
  }
  e.target.value = '';
  renderFonts();
  renderCreator();
  emit('selection');
});
$('#fontList').addEventListener('click', async e => {
  const id = e.target.dataset.id;
  if (!id || !confirm('ລຶບຟອນນີ້? ຂໍ້ຄວາມທີ່ໃຊ້ຟອນນີ້ຈະກັບໄປໃຊ້ຟອນພື້ນຖານ')) return;
  await removeFont(id);
  renderFonts();
  renderCreator();
  emit('selection');
});

// ---------------------------------------------------------------- selection & properties
function select(track, id) {
  state.selection = track ? { track, id } : null;
  emit('selection');
}

const MOTIONS = [['none', 'ບໍ່ມີ'], ['in', 'ຊູມເຂົ້າຊ້າໆ'], ['out', 'ຊູມອອກຊ້າໆ'], ['left', 'ເລື່ອນໄປຊ້າຍ'], ['right', 'ເລື່ອນໄປຂວາ']];
const ANIMS = [['none', 'ບໍ່ມີ'], ['fade', 'ຈາງເຂົ້າ-ອອກ'], ['pop', 'ເດັ້ງ'], ['type', 'ພິມດີດ (ທີລະຕົວ)']];

function styleFields(isSub) {
  return [
    { k: 'font', label: 'ຟອນ', type: 'select', options: allFonts().map(f => [f.family, f.label]) },
    { k: 'size', label: 'ຂະໜາດ', type: 'range', min: 12, max: 140 },
    { k: 'bold', label: 'ໂຕໜາ', type: 'check' },
    { k: 'color', label: 'ສີຕົວອັກສອນ', type: 'color' },
    { k: 'stroke', label: 'ສີຂອບ', type: 'color' },
    { k: 'strokeWidth', label: 'ຄວາມໜາຂອບ', type: 'range', min: 0, max: 12 },
    { k: 'shadow', label: 'ເງົາ', type: 'check' },
    { k: 'bg', label: 'ພື້ນຫຼັງ', type: 'check' },
    { k: 'bgColor', label: 'ສີພື້ນຫຼັງ', type: 'color' },
    { k: 'bgOpacity', label: 'ຄວາມທຶບພື້ນຫຼັງ', type: 'range', min: 0, max: 1, step: 0.05 },
    ...(isSub ? [] : [{ k: 'x', label: 'ຕຳແໜ່ງ ຊ້າຍ-ຂວາ', type: 'range', min: 0, max: 1, step: 0.01 }]),
    { k: 'y', label: 'ຕຳແໜ່ງ ເທິງ-ລຸ່ມ', type: 'range', min: 0, max: 1, step: 0.01 },
    { k: 'anim', label: 'ແອນິເມຊັນ', type: 'select', options: ANIMS },
    ...(isSub ? [
      { k: 'maxChars', label: 'ຕົວອັກສອນສູງສຸດ/ແຖວ (ຕອນສ້າງອັດຕະໂນມັດ)', type: 'number', min: 10, max: 120 },
      { k: 'laoDigits', label: 'ສະແດງຕົວເລກເປັນເລກລາວ (໑໒໓)', type: 'check' }
    ] : [])
  ];
}

function fieldHtml(f, v) {
  const id = `f_${f.k}`;
  switch (f.type) {
    case 'select':
      return `<label>${f.label}<select data-k="${f.k}">${f.options.map(([val, lab]) =>
        `<option value="${val}"${val === v ? ' selected' : ''}>${lab}</option>`).join('')}</select></label>`;
    case 'range':
      return `<label>${f.label} <output>${f.step && f.step < 1 ? Number(v).toFixed(2) : v}</output>
        <input type="range" data-k="${f.k}" min="${f.min}" max="${f.max}" step="${f.step || 1}" value="${v}"></label>`;
    case 'check':
      return `<label class="check"><input type="checkbox" data-k="${f.k}"${v ? ' checked' : ''}> ${f.label}</label>`;
    case 'color':
      return `<label class="color">${f.label}<input type="color" data-k="${f.k}" value="${v}"></label>`;
    case 'number':
      return `<label>${f.label}<input type="number" data-k="${f.k}" min="${f.min ?? ''}" max="${f.max ?? ''}" step="${f.step || 1}" value="${v}"></label>`;
    case 'textarea':
      return `<label>${f.label}<textarea data-k="${f.k}" rows="3" lang="lo">${escapeHtml(v)}</textarea></label>`;
    case 'time':
      return `<label>${f.label}<input type="number" data-k="${f.k}" step="0.05" min="0" value="${Number(v).toFixed(2)}"></label>`;
    default: return '';
  }
}

// Renders a form bound to `target`. Edits apply live; one undo step per field edit.
function form(fields, target, onChange, { local = false } = {}) {
  const html = fields.map(f => fieldHtml(f, target[f.k])).join('');
  return { html, bind(root) {
    let fresh = true;
    root.addEventListener('focusin', () => { fresh = true; });
    root.addEventListener('pointerdown', () => { fresh = true; });
    root.addEventListener('input', e => {
      const k = e.target.dataset.k;
      if (!k) return;
      const f = fields.find(x => x.k === k);
      if (!f) return;
      if (fresh && !local) { checkpoint(); fresh = false; }
      let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      if (f.type === 'range' || f.type === 'number' || f.type === 'time') v = Number(v);
      target[k] = v;
      const out = e.target.parentElement.querySelector('output');
      if (out) out.textContent = f.step && f.step < 1 ? v.toFixed(2) : v;
      onChange && onChange(k, v);
      if (!local) emit('edit');
    });
    root.addEventListener('change', () => {
      onChange && onChange('change');
      if (!local) emit('project');
    });
  } };
}

// Start/end typed by hand: keep a sane range and the track in time order.
function fixTiming(track, c) {
  return k => {
    if (k !== 'change') return;
    c.start = Math.max(0, c.start || 0);
    if (track !== 'audio' && !(c.end > c.start + 0.1)) c.end = c.start + 0.1;
    sortTrack(track);
  };
}

function renderProps() {
  const root = $('#props');
  const c = selectedClip();
  const sel = state.selection;
  let title = 'ໂປຣເຈັກ';
  const parts = [];

  const subPresetRow = `<div class="row props-presets"><select data-act="subPreset">${subPresetOptions()}</select>` +
    `<button data-act="savePreset" data-src="subs" title="ບັນທຶກຮູບແບບຊັບນີ້ເປັນພຣີເຊັດ">💾</button></div>`;
  if (!c) {
    parts.push(`<div class="props-section"><h4>ຮູບແບບຊັບໄຕເຕິ້ນ (ທຸກແຖວ)</h4>`, subPresetRow, form(styleFields(true), state.project.subStyle), `</div>`);
  } else if (sel.track === 'video') {
    const m = state.media.get(c.mediaId);
    const isImage = m && m.type === 'image';
    title = isImage ? 'ຮູບພາບ' : 'ຄລິບວິດີໂອ';
    // older projects: fill in the newer adjustment fields
    for (const [k, v] of Object.entries(CLIP_DEFAULTS)) if (c[k] === undefined) c[k] = v;
    const keepRange = k => {
      if (k === 'out' || k === 'change') c.out = Math.max(c.in + 0.1, c.out || 0);
      if (k === 'speed' && m && m.type === 'video') c.speed = clamp(c.speed, 0.25, 4);
    };
    const basic = [
      ...(isImage ? [{ k: 'out', label: 'ໄລຍະເວລາ (ວິນາທີ)', type: 'time' }] : []),
      ...(m && m.type === 'video' ? [
        { k: 'volume', label: 'ລະດັບສຽງ', type: 'range', min: 0, max: 2, step: 0.05 },
        { k: 'speed', label: 'ຄວາມໄວ (x)', type: 'range', min: 0.25, max: 4, step: 0.25 }
      ] : []),
      { k: 'fit', label: 'ການຈັດວາງ', type: 'select', options: [['contain', 'ພໍດີ (ເຫັນທັງໝົດ)'], ['cover', 'ເຕັມຈໍ (ຕັດຂອບ)']] },
      { k: 'bg', label: 'ພື້ນຫຼັງ', type: 'select', options: [['blur', 'ມົວ (ແບບ CapCut)'], ['black', 'ສີດຳ']] }
    ];
    const color = [
      { k: 'filter', label: 'ຟິວເຕີສີ', type: 'select', options: Object.entries(LOOKS).map(([k, v]) => [k, v[0]]) },
      { k: 'brightness', label: 'ຄວາມແຈ້ງ', type: 'range', min: 0.3, max: 2, step: 0.05 },
      { k: 'contrast', label: 'ຄອນທຣາສ', type: 'range', min: 0.3, max: 2, step: 0.05 },
      { k: 'saturate', label: 'ຄວາມອີ່ມສີ', type: 'range', min: 0, max: 3, step: 0.05 }
    ];
    const transform = [
      { k: 'zoom', label: 'ຂະຫຍາຍ / ຊູມ', type: 'range', min: 0.3, max: 3, step: 0.05 },
      { k: 'posX', label: 'ເລື່ອນ ຊ້າຍ-ຂວາ', type: 'range', min: -1, max: 1, step: 0.01 },
      { k: 'posY', label: 'ເລື່ອນ ເທິງ-ລຸ່ມ', type: 'range', min: -1, max: 1, step: 0.01 },
      { k: 'rotate', label: 'ໝຸນ (ອົງສາ)', type: 'range', min: -180, max: 180, step: 1 },
      { k: 'flipH', label: 'ປີ້ນຊ້າຍ-ຂວາ (ກະຈົກ)', type: 'check' },
      { k: 'motion', label: 'ການເຄື່ອນໄຫວ (Ken Burns)', type: 'select', options: MOTIONS }
    ];
    const fades = [
      { k: 'fadeIn', label: 'ຈາງເຂົ້າ (ວິ)', type: 'range', min: 0, max: 3, step: 0.1 },
      { k: 'fadeOut', label: 'ຈາງອອກ (ວິ)', type: 'range', min: 0, max: 3, step: 0.1 }
    ];
    parts.push(`<div class="props-info">${escapeHtml(m ? m.name : '')}<br>ໃຊ້ຊ່ວງ ${fmtTime(c.in)} – ${fmtTime(c.out)} · ຍາວ ${fmtTime(clipDuration(c))}</div>`,
      form(basic, c, keepRange),
      `<div class="props-section"><h4>🎨 ປັບສີ</h4>`, form(color, c), `</div>`,
      `<div class="props-section"><h4>⤢ ຂະໜາດ / ຕຳແໜ່ງ</h4>`, form(transform, c), `</div>`,
      `<div class="props-section"><h4>◐ ຈາງເຂົ້າ-ອອກ (ພາບ ແລະ ສຽງ)</h4>`, form(fades, c), `</div>`,
      `<div class="props-section row"><button data-act="resetClip">↺ ລ້າງການປັບແຕ່ງ</button><button data-act="applyAll" title="ໃຊ້ສີ/ຂະໜາດ/ຈາງ ແບບນີ້ກັບທຸກຄລິບໃນແທຣັກຫຼັກ">ໃຊ້ກັບທຸກຄລິບ</button></div>`);
  } else if (sel.track === 'audio') {
    const m = state.media.get(c.mediaId);
    title = c.tts ? 'ສຽງພາກ' : 'ສຽງ / ເພງ';
    for (const k of ['speed', 'fadeIn', 'fadeOut']) if (c[k] === undefined) c[k] = CLIP_DEFAULTS[k];
    const timing = fixTiming('audio', c);
    parts.push(`<div class="props-info">${escapeHtml(m ? m.name : '')}<br>ຍາວ ${fmtTime(clipDuration(c))}</div>`,
      form([{ k: 'start', label: 'ເລີ່ມທີ່ (ວິນາທີ)', type: 'time' },
        { k: 'volume', label: 'ລະດັບສຽງ', type: 'range', min: 0, max: 2, step: 0.05 },
        { k: 'speed', label: 'ຄວາມໄວ (x) — ສຽງບໍ່ປ່ຽນ', type: 'range', min: 0.5, max: 2, step: 0.05 },
        { k: 'fadeIn', label: 'ຈາງເຂົ້າ (ວິ)', type: 'range', min: 0, max: 5, step: 0.1 },
        { k: 'fadeOut', label: 'ຈາງອອກ (ວິ)', type: 'range', min: 0, max: 5, step: 0.1 }], c, timing));
  } else if (sel.track === 'text') {
    title = 'ຂໍ້ຄວາມ';
    parts.push(form([{ k: 'text', label: 'ຂໍ້ຄວາມ', type: 'textarea' },
      { k: 'start', label: 'ເລີ່ມ (ວິ)', type: 'time' }, { k: 'end', label: 'ຈົບ (ວິ)', type: 'time' }], c, fixTiming('text', c)),
      `<div class="props-section"><h4>ຮູບແບບ</h4>`,
      `<div class="row props-presets"><button data-act="savePreset" data-src="text" class="wide">💾 ບັນທຶກຮູບແບບນີ້ເປັນພຣີເຊັດ</button></div>`,
      form(styleFields(false), c.style), `</div>`);
  } else if (sel.track === 'subs') {
    title = 'ແຖວຊັບໄຕເຕິ້ນ';
    parts.push(form([{ k: 'text', label: 'ຂໍ້ຄວາມ', type: 'textarea' },
      ...(c.tr ? [{ k: 'tr', label: 'ຄຳແປ (ແຖວທີສອງ)', type: 'textarea' }] : []),
      { k: 'start', label: 'ເລີ່ມ (ວິ)', type: 'time' }, { k: 'end', label: 'ຈົບ (ວິ)', type: 'time' }], c, fixTiming('subs', c)),
      `<div class="props-section"><h4>ຮູບແບບຊັບ (ໃຊ້ກັບທຸກແຖວ)</h4>`, subPresetRow, form(styleFields(true), state.project.subStyle), `</div>`);
  }

  root.innerHTML = `<h3>${title}</h3>` + parts.map(p => typeof p === 'string' ? p : `<div class="form" data-form>${p.html}</div>`).join('');
  const forms = parts.filter(p => typeof p !== 'string');
  $$('[data-form]', root).forEach((el, i) => forms[i].bind(el));
}

const LOOK_KEYS = ['filter', 'brightness', 'contrast', 'saturate', 'zoom', 'posX', 'posY', 'rotate', 'flipH', 'motion', 'fadeIn', 'fadeOut'];
$('#props').addEventListener('change', e => {
  if (e.target.dataset.act !== 'subPreset' || !e.target.value) return;
  const v = e.target.value;
  const p = v[0] === 'b' ? TEXT_PRESETS[v.slice(1)] : myPresets[v.slice(1)];
  if (p) applyStyleToSubs({ ...DEFAULT_TEXT_STYLE, ...p.style }, p.name);
});
$('#props').addEventListener('click', e => {
  const act = e.target.dataset.act;
  if (act === 'savePreset') {
    const c = selectedClip();
    saveStyleAsPreset(e.target.dataset.src === 'text' && c ? c.style : state.project.subStyle);
    return;
  }
  const c = selectedClip();
  if (!act || !c) return;
  if (act === 'resetClip') commit(() => { for (const k of LOOK_KEYS) c[k] = CLIP_DEFAULTS[k]; });
  if (act === 'applyAll') {
    commit(p => { for (const o of p.tracks.video) if (o !== c) for (const k of LOOK_KEYS) o[k] = c[k]; });
    toast(`ໃຊ້ການປັບແຕ່ງນີ້ກັບ ${state.project.tracks.video.length} ຄລິບແລ້ວ`, 'ok');
  }
});

// ---------------------------------------------------------------- canvas: drag text to move
canvas.addEventListener('pointerdown', e => {
  const r = canvas.getBoundingClientRect();
  const sx = canvas.width / r.width, sy = canvas.height / r.height;
  const hit = player.hitTest((e.clientX - r.left) * sx, (e.clientY - r.top) * sy);
  if (!hit) { select(null); return; }
  select(hit.track, hit.id);
  const style = hit.track === 'text' ? findClip('text', hit.id).style : state.project.subStyle;
  const x0 = e.clientX, y0 = e.clientY, ox = style.x, oy = style.y;
  let moved = false;
  const move = ev => {
    if (!moved) { checkpoint(); moved = true; }
    if (hit.track === 'text') style.x = clamp(ox + (ev.clientX - x0) / r.width, 0, 1);
    style.y = clamp(oy + (ev.clientY - y0) / r.height, 0, 1);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (moved) emit('project');
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// ---------------------------------------------------------------- editing actions
// Splits on a copy of the tracks so a failed split leaves no empty undo step.
function splitAtPlayhead() {
  const t = state.time;
  const sel = state.selection;
  const track = sel ? sel.track : 'video';
  const tracks = JSON.parse(JSON.stringify(state.project.tracks));
  if (!splitTrack(tracks, track, sel && sel.id, t)) {
    toast('ວາງເສັ້ນເວລາໄວ້ເທິງຄລິບກ່ອນຈຶ່ງຕັດໄດ້', 'warn');
    return;
  }
  commit(p => { p.tracks = tracks; });
}

function splitTrack(tracks, track, id, t) {
  const MIN = 0.05;
  if (track === 'video') {
    const idx = videoLayout().findIndex(x => (!id || x.clip.id === id) && t > x.start + MIN && t < x.end - MIN);
    if (idx < 0) return false;
    const c = tracks.video[idx];
    const cut = c.in + (t - videoLayout()[idx].start) * clipSpeed(c);
    tracks.video.splice(idx + 1, 0, { ...c, id: newId(), in: cut });
    c.out = cut;
    return true;
  }
  const list = tracks[track];
  const c = list.find(x => x.id === id);
  if (!c) return false;
  const end = track === 'audio' ? c.start + clipDuration(c) : c.end;
  if (t <= c.start + MIN || t >= end - MIN) return false;
  if (track === 'audio') {
    const cut = c.in + (t - c.start) * clipSpeed(c);
    list.push({ ...c, id: newId(), start: t, in: cut });
    c.out = cut;
  } else {
    const b = JSON.parse(JSON.stringify(c));
    b.id = newId();
    b.start = t;
    if (track === 'subs') {
      const [first, rest] = splitAtFraction(c.text, (t - c.start) / (c.end - c.start));
      if (first && rest) { c.text = first; b.text = rest; }
      delete c.tr;
      delete b.tr;
    }
    c.end = t;
    list.push(b);
  }
  list.sort((x, y) => x.start - y.start);
  return true;
}

// "Delete left/right of the playhead" (CapCut's Q / W): trims the selected
// clip — or the main-track clip under the playhead — to the playhead.
function trimToPlayhead(side) {
  const t = state.time;
  const MIN = 0.05;
  let sel = state.selection;
  if (!sel) {
    const l = videoLayout().find(x => t > x.start && t < x.end);
    if (l) sel = { track: 'video', id: l.clip.id };
  }
  const c = sel && findClip(sel.track, sel.id);
  if (!c) { toast('ເລືອກຄລິບ ຫຼື ວາງເສັ້ນເວລາໄວ້ເທິງຄລິບກ່ອນ', 'warn'); return; }
  const start = sel.track === 'video' ? videoLayout().find(x => x.clip.id === c.id).start : c.start;
  const end = sel.track === 'video' || sel.track === 'audio' ? start + clipDuration(c) : c.end;
  if (t <= start + MIN || t >= end - MIN) { toast('ເສັ້ນເວລາຕ້ອງຢູ່ພາຍໃນຄລິບທີ່ເລືອກ', 'warn'); return; }
  commit(() => {
    if (sel.track === 'video' || sel.track === 'audio') {
      const src = c.in + (t - start) * clipSpeed(c);
      if (side === 'left') { c.in = src; if (sel.track === 'audio') c.start = t; } else c.out = src;
    } else if (side === 'left') c.start = t;
    else c.end = t;
    if (sel.track !== 'video') sortTrack(sel.track);
  });
  state.selection = sel;
  // on the magnetic track the rest slides left: keep the playhead on the cut
  if (side === 'left' && sel.track === 'video') player.seek(start);
}

function saveSnapshot() {
  const prev = player.exporting;
  player.exporting = true; // no selection outline
  player.draw(state.time);
  player.exporting = prev;
  canvas.toBlob(b => b && download(b, `${state.project.name} ${fmtTime(state.time, 2).replace(':', '-')}.png`), 'image/png');
}

function deleteSelected() {
  const sel = state.selection;
  if (!sel) return;
  commit(p => { p.tracks[sel.track] = p.tracks[sel.track].filter(c => c.id !== sel.id); });
  select(null);
}

function duplicateSelected() {
  const sel = state.selection;
  const c = selectedClip();
  if (!c) return;
  const b = JSON.parse(JSON.stringify(c));
  b.id = newId();
  commit(p => {
    const list = p.tracks[sel.track];
    if (sel.track === 'video') list.splice(list.indexOf(c) + 1, 0, b);
    else {
      const len = sel.track === 'audio' ? clipDuration(c) : c.end - c.start;
      b.start = (sel.track === 'audio' ? c.start + len : c.end);
      if (sel.track !== 'audio') b.end = b.start + len;
      list.push(b);
      sortTrack(sel.track);
    }
  });
  select(sel.track, b.id);
}

function addSubtitleAtPlayhead() {
  const t = state.time;
  const subs = state.project.tracks.subs;
  const next = subs.find(s => s.start > t);
  if (subs.some(s => t >= s.start && t < s.end)) { toast('ມີຊັບຢູ່ຕຳແໜ່ງນີ້ແລ້ວ', 'warn'); return; }
  const id = newId();
  commit(p => {
    p.tracks.subs.push({ id, start: t, end: Math.min(t + 2, next ? next.start : t + 2), text: 'ພິມຊັບໄຕເຕິ້ນ' });
    sortTrack('subs');
  });
  select('subs', id);
  setTimeout(() => { const ta = $('#props textarea'); if (ta) { ta.focus(); ta.select(); } }, 0);
}

// ---------------------------------------------------------------- auto subtitles
let aiReady = false;
let aiStatus = {};

async function refreshStatus() {
  try {
    const r = await fetch('/api/editor/status');
    if (r.status === 401) { location.href = '/login.html'; return; }
    const s = await r.json();
    aiStatus = s;
    aiReady = s.whisper;
    voiceover.renderStatus();
    voiceclone.renderStatus();
    $('#elevenKeyInput').value = s.elevenKey || '';
    $('#localUrlInput').value = s.localUrl || '';
    $('#elevenKeyInput').disabled = s.elevenFromEnv;
    $('#azureKeyInput').value = s.azureKey || '';
    $('#azureKeyInput').disabled = s.azureFromEnv;
    $('#azureRegionInput').value = s.azureRegion || '';
    $('#aiStatus').innerHTML = s.whisper
      ? '<span class="dot ok"></span> ເຊື່ອມຕໍ່ AI (Whisper) ແລ້ວ'
      : '<span class="dot"></span> ຍັງບໍ່ໄດ້ຕັ້ງ API Key — <a href="#" id="openSettings2">ຕັ້ງຄ່າ</a>';
    $('#apiKeyInput').value = s.key || '';
    $('#apiKeyInput').disabled = s.fromEnv;
    $('#apiKeyEnvNote').hidden = !s.fromEnv;
    const link = $('#openSettings2');
    if (link) link.onclick = e => { e.preventDefault(); openModal('settingsModal'); };
  } catch (e) {
    // opened without the LaoCut server (e.g. as a static page): editing still works
    const msg = '<span class="dot"></span> ບໍ່ໄດ້ເຊື່ອມຕໍ່ເຊີບເວີ — ຟັງຊັນ AI ໃຊ້ບໍ່ໄດ້, ການຕັດຕໍ່ອື່ນໆໃຊ້ໄດ້ປົກກະຕິ';
    $('#aiStatus').innerHTML = msg;
    $('#ttsStatus').innerHTML = msg;
    voiceclone.renderStatus();
  }
}

function applyGeneratedSubs(segs, replace) {
  commit(p => {
    const fresh = segs.map(s => ({ id: newId(), start: s.start, end: s.end, text: s.text }));
    if (replace) p.tracks.subs = fresh;
    else {
      // keep existing lines; drop generated ones that overlap them
      const keep = p.tracks.subs;
      p.tracks.subs = keep.concat(fresh.filter(f => !keep.some(k => f.start < k.end && f.end > k.start)));
    }
    sortTrack('subs');
  });
  $('[data-tab=subs]').click();
}

$('#autoSubBtn').addEventListener('click', async () => {
  if (!aiReady) { openModal('settingsModal'); return; }
  const lang = $('#subLang').value;
  const replace = $('#subReplace').checked;
  if (!replace && state.project.tracks.subs.length && !confirm('ຈະເພີ່ມຊັບໃໝ່ໃສ່ບ່ອນທີ່ຍັງວ່າງ. ສືບຕໍ່ບໍ?')) return;
  try {
    busy('ກຳລັງກຽມສຽງ...', 0);
    const samples = await mixTimelineAudio({ includeMusic: $('#subMusic').checked, onProgress: busy });
    const raw = await transcribe(samples, { lang, prompt: $('#subPrompt').value.trim(), onProgress: busy });
    const segs = refineSegments(raw, { maxChars: state.project.subStyle.maxChars, modernHo: $('#subModernHo').checked });
    busy(false);
    if (!segs.length) { toast('ບໍ່ພົບສຽງເວົ້າ', 'warn'); return; }
    applyGeneratedSubs(segs, replace);
    toast(`ສ້າງຊັບສຳເລັດ ${segs.length} ແຖວ ✓`, 'ok');
    if (lang === 'lo' && segs.some(s => hasThaiScript(s.text))) {
      toast('ບາງແຖວອອກມາເປັນອັກສອນໄທ — ລອງໃສ່ຄຳແນະນຳ (prompt) ເປັນພາສາລາວ ແລ້ວສ້າງໃໝ່', 'warn');
    }
  } catch (e) {
    busy(false);
    toast(e.message, 'error');
  }
});

$('#alignBtn').addEventListener('click', async () => {
  const script = $('#scriptInput').value.trim();
  try {
    busy('ກຳລັງວິເຄາະສຽງເວົ້າ...', 0);
    const samples = await mixTimelineAudio({ onProgress: busy });
    const regions = detectSpeech(samples, { maxLen: 6 });
    busy(false);
    if (!regions.length) { toast('ບໍ່ພົບສຽງເວົ້າ', 'warn'); return; }
    const segs = script
      ? alignScript(script, regions, state.project.subStyle.maxChars)
      : regions.map(r => ({ ...r, text: '...' }));
    applyGeneratedSubs(segs, $('#subReplace').checked);
    toast(script ? `ຈັດເວລາແລ້ວ ${segs.length} ແຖວ — ກວດເບິ່ງ ແລະ ປັບເລັກນ້ອຍ` : `ສ້າງຊ່ອງວ່າງ ${segs.length} ແຖວ ຕາມສຽງເວົ້າ — ພິມຂໍ້ຄວາມໃສ່ໄດ້ເລີຍ`, 'ok');
  } catch (e) {
    busy(false);
    toast(e.message, 'error');
  }
});

const TRANSLATE_BATCH = 60;

$('#translateBtn').addEventListener('click', async () => {
  if (!aiReady) { openModal('settingsModal'); return; }
  const subs = state.project.tracks.subs;
  if (!subs.length) { toast('ຍັງບໍ່ມີຊັບ', 'warn'); return; }
  const from = $('#subLang').value;
  const to = $('#trTo').value;
  const mode = $('#trMode').value;
  if (from === to) { toast('ພາສາຕົ້ນສະບັບ ແລະ ພາສາປາຍທາງ ຄືກັນ', 'warn'); return; }
  const ids = subs.map(s => s.id);
  const lines = subs.map(s => s.text.replace(/\n/g, ' '));
  try {
    const out = [];
    for (let i = 0; i < lines.length; i += TRANSLATE_BATCH) {
      busy(`ກຳລັງແປ ${i + 1}–${Math.min(i + TRANSLATE_BATCH, lines.length)} / ${lines.length}...`, i / lines.length);
      const r = await fetch('/api/editor/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, lines: lines.slice(i, i + TRANSLATE_BATCH) })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      out.push(...data.lines);
    }
    busy(false);
    commit(p => {
      for (const s of p.tracks.subs) {
        const i = ids.indexOf(s.id);
        if (i < 0) continue;
        const tr = to === 'lo' ? normalizeLao(out[i]) : out[i];
        if (mode === 'replace') { s.text = tr; delete s.tr; } else s.tr = tr;
      }
    });
    $('[data-tab=subs]').click();
    toast(`ແປແລ້ວ ${out.length} ແຖວ ✓`, 'ok');
  } catch (e) {
    busy(false);
    toast(e.message, 'error');
  }
});

// ---------------------------------------------------------------- subtitle list
function renderSubList() {
  const subs = state.project.tracks.subs;
  $('#subCount').textContent = subs.length;
  $('#subList').innerHTML = subs.length ? subs.map((s, i) => `
    <div class="sub-item" data-id="${s.id}">
      <div class="sub-meta">
        <button class="sub-time" data-act="seek">${i + 1}. ${fmtTime(s.start)} → ${fmtTime(s.end)}</button>
        <span class="sub-actions">
          <button data-act="merge" title="ລວມກັບແຖວຖັດໄປ">⤓</button>
          <button data-act="del" title="ລຶບ">×</button>
        </span>
      </div>
      <textarea rows="2" lang="lo" data-act="text">${escapeHtml(s.text)}</textarea>
      ${s.tr ? `<textarea rows="1" class="sub-tr" data-act="tr" title="ຄຳແປ">${escapeHtml(s.tr)}</textarea>` : ''}
    </div>`).join('')
    : '<div class="empty-hint">ຍັງບໍ່ມີຊັບ. ໃຊ້ແຖບ "ສ້າງຊັບອັດຕະໂນມັດ" ຫຼື ກົດ "+ ຊັບ" ທີ່ timeline</div>';
  highlightActiveSub(true);
}

let lastActiveSub = null;
function highlightActiveSub(force) {
  const cur = state.project.tracks.subs.find(s => state.time >= s.start && state.time < s.end);
  const id = cur ? cur.id : null;
  if (id === lastActiveSub && !force) return;
  lastActiveSub = id;
  $$('#subList .sub-item.active').forEach(el => el.classList.remove('active'));
  if (id) {
    const el = $(`#subList .sub-item[data-id="${id}"]`);
    if (el) {
      el.classList.add('active');
      if (state.playing) el.scrollIntoView({ block: 'nearest' });
    }
  }
}

let subTyping = null;
$('#subList').addEventListener('click', e => {
  const item = e.target.closest('.sub-item');
  if (!item) return;
  const id = item.dataset.id;
  const act = e.target.dataset.act;
  const s = findClip('subs', id);
  if (act === 'seek') { player.seek(s.start + 0.01); select('subs', id); }
  if (act === 'del') commit(p => { p.tracks.subs = p.tracks.subs.filter(x => x.id !== id); });
  if (act === 'merge') {
    const list = state.project.tracks.subs;
    const i = list.indexOf(s);
    if (i < list.length - 1) commit(() => {
      const n = list[i + 1];
      s.text = `${s.text} ${n.text}`.trim();
      if (s.tr || n.tr) s.tr = `${s.tr || ''} ${n.tr || ''}`.trim();
      s.end = n.end;
      list.splice(i + 1, 1);
    });
  }
});
$('#subList').addEventListener('focusin', e => {
  if (e.target.dataset.act !== 'text' && e.target.dataset.act !== 'tr') return;
  const id = e.target.closest('.sub-item').dataset.id;
  subTyping = id;
  const s = findClip('subs', id);
  if (state.time < s.start || state.time >= s.end) player.seek(s.start + 0.01);
});
$('#subList').addEventListener('input', e => {
  const act = e.target.dataset.act;
  if (act !== 'text' && act !== 'tr') return;
  const s = findClip('subs', e.target.closest('.sub-item').dataset.id);
  if (subTyping) { checkpoint(); subTyping = null; }
  s[act] = e.target.value;
  emit('edit');
});

$('#replaceBtn').addEventListener('click', () => {
  const find = $('#findInput').value;
  if (!find) return;
  const rep = $('#replaceInput').value;
  let n = 0;
  commit(p => {
    for (const s of p.tracks.subs) {
      const parts = s.text.split(find);
      if (parts.length > 1) { n += parts.length - 1; s.text = parts.join(rep); }
    }
  });
  toast(`ແທນທີ່ ${n} ບ່ອນ`);
});

function mapSubs(fn, msg) {
  commit(p => { for (const s of p.tracks.subs) s.text = fn(s.text); });
  toast(msg, 'ok');
}
$('#fixLaoBtn').addEventListener('click', () => mapSubs(t => normalizeLao(t), 'ແກ້ໄຂ ສະຫຼະອຳ ແລະ ຍະຫວ່າງ ແລ້ວ'));
$('#modernHoBtn').addEventListener('click', () => mapSubs(t => normalizeLao(t, { modernHoLetters: true }), 'ປ່ຽນ ຫນ/ຫມ → ໜ/ໝ ແລ້ວ'));
$('#laoDigitsBtn').addEventListener('click', () => mapSubs(toLaoDigits, 'ປ່ຽນເປັນເລກລາວແລ້ວ'));
$('#arabicDigitsBtn').addEventListener('click', () => mapSubs(toArabicDigits, 'ປ່ຽນເປັນເລກອາຣັບແລ້ວ'));
$('#clearTrBtn').addEventListener('click', () => {
  commit(p => { for (const s of p.tracks.subs) delete s.tr; });
  toast('ລຶບຄຳແປແລ້ວ');
});
$('#shiftBtn').addEventListener('click', () => {
  const d = Number($('#shiftInput').value) || 0;
  commit(p => { for (const s of p.tracks.subs) { s.start = Math.max(0, s.start + d); s.end = Math.max(s.start + 0.1, s.end + d); } });
  toast(`ເລື່ອນເວລາຊັບ ${d > 0 ? '+' : ''}${d} ວິ`);
});
$('#clearSubsBtn').addEventListener('click', () => {
  if (confirm('ລຶບຊັບທັງໝົດບໍ?')) commit(p => { p.tracks.subs = []; });
});

async function importSubtitleFile(file) {
  const segs = parseSubtitles(await file.text());
  if (!segs.length) { toast('ອ່ານໄຟລ໌ຊັບບໍ່ໄດ້', 'error'); return; }
  applyGeneratedSubs(segs, true);
  toast(`ນຳເຂົ້າຊັບ ${segs.length} ແຖວ`, 'ok');
}
$('#importSrtBtn').addEventListener('click', () => $('#srtInput').click());
$('#srtInput').addEventListener('change', e => { if (e.target.files[0]) importSubtitleFile(e.target.files[0]); e.target.value = ''; });
const subsForExport = () => {
  const digits = state.project.subStyle.laoDigits;
  return state.project.tracks.subs.map(s => ({ ...s, text: digits ? toLaoDigits(subDisplay(s)) : subDisplay(s) }));
};
$('#exportSrtBtn').addEventListener('click', () => {
  if (!state.project.tracks.subs.length) return toast('ຍັງບໍ່ມີຊັບ', 'warn');
  download(new Blob(['\ufeff' + toSRT(subsForExport())], { type: 'text/plain;charset=utf-8' }), `${state.project.name}.srt`);
});
$('#exportVttBtn').addEventListener('click', () => {
  if (!state.project.tracks.subs.length) return toast('ຍັງບໍ່ມີຊັບ', 'warn');
  download(new Blob([toVTT(subsForExport())], { type: 'text/vtt;charset=utf-8' }), `${state.project.name}.vtt`);
});

// ---------------------------------------------------------------- modals
function openModal(id) { $(`#${id}`).hidden = false; }
function closeModal(id) { $(`#${id}`).hidden = true; }
$$('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.closest('.modal').id)));
$('#settingsBtn').addEventListener('click', () => openModal('settingsModal'));
$('#saveSettingsBtn').addEventListener('click', async () => {
  const r = await fetch('/api/editor/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      openai_api_key: $('#apiKeyInput').value,
      azure_speech_key: $('#azureKeyInput').value,
      azure_speech_region: $('#azureRegionInput').value,
      elevenlabs_api_key: $('#elevenKeyInput').value,
      local_voice_url: $('#localUrlInput').value.trim()
    })
  });
  if (r.ok) { toast('ບັນທຶກແລ້ວ', 'ok'); closeModal('settingsModal'); await refreshStatus(); voiceclone.refresh(); }
  else toast((await r.json().catch(() => ({}))).error || 'ບັນທຶກບໍ່ສຳເລັດ', 'error');
});

$('#exportBtn').addEventListener('click', () => {
  const formats = supportedFormats();
  const uniq = [...new Set(formats.map(f => f[1]))];
  $('#exportFormat').innerHTML = uniq.map(f => `<option value="${f}">${f.toUpperCase()}</option>`).join('') || '<option>-</option>';
  const [w, h] = ASPECTS[state.project.aspect];
  $('#exportRes').innerHTML = [[1, 'ມາດຕະຖານ'], [1.5, 'ຄົມຊັດ'], [0.5, 'ໄຟລ໌ນ້ອຍ']].map(([s, l]) =>
    `<option value="${s}">${l} — ${Math.round(w * s)}×${Math.round(h * s)}</option>`).join('');
  $('#exportInfo').textContent = `ຄວາມຍາວ ${fmtTime(totalDuration())} · ການສົ່ງອອກໃຊ້ເວລາເທົ່າກັບຄວາມຍາວວິດີໂອ — ຫ້າມປິດ ຫຼື ສະຫຼັບໄປແຖບອື່ນ`;
  $('#exportProgress').hidden = true;
  $('#startExportBtn').disabled = !formats.length || totalDuration() <= 0;
  openModal('exportModal');
});
$('#startExportBtn').addEventListener('click', async () => {
  $('#startExportBtn').disabled = true;
  $('#exportProgress').hidden = false;
  try {
    const res = await exportVideo(player, {
      scale: Number($('#exportRes').value),
      format: $('#exportFormat').value,
      onProgress: f => {
        $('#exportBar').style.width = `${Math.round(f * 100)}%`;
        $('#exportPct').textContent = `${Math.round(f * 100)}%`;
      }
    });
    if (res) {
      download(res.blob, `${state.project.name}.${res.ext}`);
      toast('ສົ່ງອອກວິດີໂອສຳເລັດ ✓', 'ok');
      closeModal('exportModal');
    }
  } catch (e) {
    toast(e.message, 'error');
  }
  $('#startExportBtn').disabled = false;
  $('#exportProgress').hidden = true;
});
$('#cancelExportBtn').addEventListener('click', () => { exportVideo.cancel && exportVideo.cancel(); closeModal('exportModal'); });

const voiceover = initVoiceover({
  $, toast, busy, openModal, createMedia, discardMedia, adoptMedia,
  getStatus: () => aiStatus
});

const voiceclone = initVoiceClone({
  $, toast, busy, openModal, createMedia, adoptMedia,
  getStatus: () => aiStatus,
  refreshStatus: () => refreshStatus(),
  onVoicesChanged: list => voiceover.setCloneVoices(list)
});

// ---------------------------------------------------------------- top bar & transport
$('#projectName').addEventListener('change', e => commit(p => { p.name = e.target.value.trim() || 'ໂປຣເຈັກ'; }));
$('#aspectSelect').addEventListener('change', e => { commit(p => { p.aspect = e.target.value; }); player.resize(); });
$('#newProjectBtn').addEventListener('click', () => { if (confirm('ເລີ່ມໂປຣເຈັກໃໝ່? (ໄຟລ໌ສື່ຍັງຢູ່)')) resetProject(); });
$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
$('#playBtn').addEventListener('click', () => player.toggle());
$('#backBtn').addEventListener('click', () => player.seek(0));
$('#prevFrame').addEventListener('click', () => player.seek(state.time - 1 / 30));
$('#nextFrame').addEventListener('click', () => player.seek(state.time + 1 / 30));
$('#fullscreenBtn').addEventListener('click', () => $('#stage').requestFullscreen && $('#stage').requestFullscreen());
$('#splitBtn').addEventListener('click', splitAtPlayhead);
$('#deleteBtn').addEventListener('click', deleteSelected);
$('#dupBtn').addEventListener('click', duplicateSelected);
$('#addSubBtn').addEventListener('click', addSubtitleAtPlayhead);
$('#trimLeftBtn').addEventListener('click', () => trimToPlayhead('left'));
$('#trimRightBtn').addEventListener('click', () => trimToPlayhead('right'));
$('#snapshotBtn').addEventListener('click', saveSnapshot);
$('#zoomRange').addEventListener('input', e => { state.zoom = Number(e.target.value); emit('zoom'); });

$$('.tabs button').forEach(b => b.addEventListener('click', () => {
  $$('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  $$('.tab-panel').forEach(p => p.hidden = p.id !== `tab-${b.dataset.tab}`);
}));

document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (!$('#busy').hidden || $$('.modal').some(m => !m.hidden)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.code === 'Space') {
    e.preventDefault();
    if (e.target.tagName === 'BUTTON') e.target.blur();
    player.toggle();
  }
  else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (mod && e.key.toLowerCase() === 'b' || (!mod && e.key.toLowerCase() === 's')) { e.preventDefault(); splitAtPlayhead(); }
  else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
  else if (e.key === 'ArrowLeft') player.seek(state.time - (e.shiftKey ? 1 : 1 / 30));
  else if (e.key === 'ArrowRight') player.seek(state.time + (e.shiftKey ? 1 : 1 / 30));
  else if (e.key === 'Home') player.seek(0);
  else if (e.key === 'End') player.seek(totalDuration());
  else if (e.key.toLowerCase() === 't' && !mod) addSubtitleAtPlayhead();
  else if (e.key.toLowerCase() === 'q' && !mod) trimToPlayhead('left');
  else if (e.key.toLowerCase() === 'w' && !mod) trimToPlayhead('right');
  else if (e.key === '+' || e.key === '=') { state.zoom = clamp(state.zoom * 1.25, 4, 400); emit('zoom'); }
  else if (e.key === '-') { state.zoom = clamp(state.zoom / 1.25, 4, 400); emit('zoom'); }
});

// ---------------------------------------------------------------- render wiring
function renderTop() {
  $('#projectName').value = state.project.name;
  $('#aspectSelect').value = state.project.aspect;
  $('#stage').dataset.aspect = state.project.aspect;
}

function renderTransport() {
  $('#timeNow').textContent = fmtTime(state.time, 2);
  $('#timeTotal').textContent = fmtTime(totalDuration(), 2);
  $('#playBtn').textContent = state.playing ? '❚❚' : '▶';
}

subscribe(kind => {
  if (kind === 'time') { timeline.renderPlayhead(); renderTransport(); highlightActiveSub(); return; }
  if (kind === 'play') { renderTransport(); return; }
  if (kind === 'zoom') { $('#zoomRange').value = state.zoom; timeline.render(); return; }
  if (kind === 'drag' || kind === 'edit') { timeline.render(); renderTransport(); return; }
  timeline.render();
  renderTransport();
  renderProps();
  if (kind === 'project') { renderTop(); renderSubList(); if (!player.exporting) player.resize(); }
});

// ---------------------------------------------------------------- boot
(async function boot() {
  // make sure every Lao font is ready before the first canvas draw
  if (document.fonts) {
    Promise.all(LAO_FONTS.flatMap(f => [document.fonts.load(`400 40px "${f.family}"`, 'ລາວ'), document.fonts.load(`700 40px "${f.family}"`, 'ລາວ')])).catch(() => {});
  }
  await loadCustomFonts();
  renderFonts();
  renderCreator();
  loadPresets();
  if (!('Segmenter' in Intl)) toast('ເບົາເຊີນີ້ບໍ່ຮອງຮັບການຕັດຄຳລາວ — ແນະນຳ Chrome/Edge ລຸ້ນໃໝ່', 'warn');

  const saved = await loadSaved();
  if (saved.media.length) busy('ກຳລັງເປີດໂປຣເຈັກເກົ່າ...', 0.3);
  for (const rec of saved.media) {
    const m = { ...rec, url: URL.createObjectURL(rec.blob) };
    await probe(m);
    if (!m.broken) state.media.set(m.id, m);
  }
  busy(false);
  if (saved.project) {
    loadProject(saved.project);
    const t = state.project.tracks;
    t.video = t.video.filter(c => state.media.has(c.mediaId));
    t.audio = t.audio.filter(c => state.media.has(c.mediaId));
  }
  // per-line voiceover files no clip uses any more (replaced or deleted)
  const used = new Set(state.project.tracks.audio.map(c => c.mediaId));
  for (const m of [...state.media.values()]) {
    if (m.hidden && !used.has(m.id)) {
      state.media.delete(m.id);
      URL.revokeObjectURL(m.url);
      deleteMedia(m.id);
    }
  }
  player.resize();
  renderMedia();
  emit('project');
  refreshStatus();
})();
