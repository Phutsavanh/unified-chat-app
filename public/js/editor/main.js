import {
  state, emit, subscribe, commit, checkpoint, undo, redo, ASPECTS, DEFAULT_TEXT_STYLE,
  videoLayout, totalDuration, selectedClip, findClip, clipDuration, sortTrack, newId, subDisplay,
  persistMedia, deleteMedia, loadSaved, loadProject, resetProject, DEFAULT_TF, DEFAULT_ANIM, trackFlag
} from './store.js';
import { Player } from './player.js';
import { Timeline, escapeHtml } from './timeline.js';
import { mixTimelineAudio, transcribe, detectSpeech, alignScript, refineSegments } from './autosub.js';
import { exportVideo, supportedFormats } from './exporter.js';
import { initVoiceover } from './voiceover.js';
import { initLibrary } from './library/panels.js';
import { aiBackend, AIUnavailable, writeScript, proofreadLines, translateLines, postCaption } from './ai.js';
import { initAssistant } from './assistant.js';
import { EFFECTS, FILTERS, TRANSITIONS } from './library/visual.js';
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

// In-page confirmation (window.confirm is blocked inside some embeds).
function ask(message, yes = 'ຕົກລົງ') {
  return new Promise(resolve => {
    $('#confirmMsg').textContent = message;
    $('#confirmYes').textContent = yes;
    $('#confirmModal').hidden = false;
    const done = v => {
      $('#confirmModal').hidden = true;
      $('#confirmYes').onclick = $('#confirmNo').onclick = null;
      resolve(v);
    };
    $('#confirmYes').onclick = () => done(true);
    $('#confirmNo').onclick = () => done(false);
    $('#confirmYes').focus();
  });
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
    queuePeaks(m);
  }
  renderMedia();
}

// Media made or fetched inside the app (voiceover, library sounds, online
// files). `hidden` keeps per-line clips out of the library; unused hidden
// files are cleaned up on the next load. `credit` is shown on export.
const EXT = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'image/png': 'png', 'image/jpeg': 'jpg' };
async function createMedia(blob, name, opts = {}) {
  if (typeof opts === 'boolean') opts = { hidden: opts };
  const { type = 'audio', hidden = false, ...extra } = opts;
  const mime = blob.type || (type === 'image' ? 'image/png' : 'audio/mpeg');
  const file = new File([blob], `${name}.${EXT[mime] || mime.split('/')[1] || 'bin'}`, { type: mime });
  const m = { id: newId(), name, type, blob: file, url: URL.createObjectURL(file), hidden, ...extra };
  await probe(m);
  if (m.broken || (type === 'image' && !m.width)) throw new Error('ອ່ານໄຟລ໌ນີ້ບໍ່ໄດ້');
  return m;
}

function discardMedia(m) {
  URL.revokeObjectURL(m.url);
}

function adoptMedia(m) {
  state.media.set(m.id, m);
  persistMedia(m);
  queuePeaks(m);
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
  if (used && !(await ask('ໄຟລ໌ນີ້ຖືກໃຊ້ຢູ່ໃນ timeline. ລຶບອອກທັງໝົດບໍ?', 'ລຶບ'))) return;
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
        ${m.type === 'audio' ? '<span class="media-ico"><svg class="i"><use href="#i-music"/></svg></span>' : ''}
        <span class="media-dur">${m.type === 'image' ? 'ຮູບ' : fmtTime(m.duration, 0)}</span>
        <button class="media-add" data-act="add" title="ເພີ່ມໃສ່ timeline" aria-label="ເພີ່ມໃສ່ timeline"><svg class="i"><use href="#i-plus"/></svg></button>
        <button class="media-del" data-act="del" title="ລຶບ" aria-label="ລຶບ"><svg class="i"><use href="#i-x"/></svg></button>
      </div>
      <div class="media-name">${escapeHtml(m.name)}</div>
    </div>`).join('')
    : '<div class="empty-hint">ຍັງບໍ່ມີໄຟລ໌<br>ກົດ "ນຳເຂົ້າ" ຫຼື ລາກໄຟລ໌ມາວາງ</div>';
}

$('#mediaList').addEventListener('click', e => {
  const item = e.target.closest('.media-item');
  if (!item) return;
  // the click can land on the icon inside the button
  const act = e.target.closest('[data-act]')?.dataset.act;
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
$('#welcomeImportBtn').addEventListener('click', () => $('#fileInput').click());
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

$('#textPresets').innerHTML = TEXT_PRESETS.map((p, i) => {
  const s = { ...DEFAULT_TEXT_STYLE, ...p.style };
  const css = `font-family:'${s.font}';font-weight:${s.bold ? 700 : 400};color:${s.color};` +
    (s.strokeWidth ? `-webkit-text-stroke:1px ${s.stroke};` : '') +
    (s.bg ? `background:${s.bgColor};` : '');
  return `<button class="preset" data-i="${i}"><span style="${css}">ສະບາຍດີ</span><small>${p.name}</small></button>`;
}).join('');

$('#textPresets').addEventListener('click', e => {
  const b = e.target.closest('.preset');
  if (!b) return;
  const p = TEXT_PRESETS[b.dataset.i];
  const id = newId();
  commit(pr => {
    pr.tracks.text.push({
      id, start: state.time, end: state.time + 3, text: 'ພິມຂໍ້ຄວາມຂອງທ່ານ',
      style: { ...DEFAULT_TEXT_STYLE, ...p.style }
    });
    sortTrack('text');
  });
  select('text', id);
  setTimeout(() => { const ta = $('#props textarea'); if (ta) { ta.focus(); ta.select(); } }, 0);
});

// ---------------------------------------------------------------- selection & properties
function select(track, id) {
  state.selection = track ? { track, id } : null;
  emit('selection');
}

const FONT_OPTIONS = LAO_FONTS.map(f => [f.family, f.label]);
const STICKER_ANIMS = [['none', 'ບໍ່ມີ'], ['pop', 'ເດັ້ງເຂົ້າ'], ['bounce', 'ກະໂດດ'], ['pulse', 'ເຕັ້ນ'], ['float', 'ລອຍ'], ['wiggle', 'ສັ່ນໄປມາ'], ['spin', 'ໝູນ']];
const ANIMS = [['none', 'ບໍ່ມີ'], ['fade', 'ຈາງເຂົ້າ-ອອກ'], ['pop', 'ເດັ້ງ'], ['type', 'ພິມດີດ (ທີລະຕົວ)']];

function styleFields(isSub) {
  return [
    { k: 'font', label: 'ຟອນ', type: 'select', options: FONT_OPTIONS },
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
function form(fields, target, onChange) {
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
      if (fresh) { checkpoint(); fresh = false; }
      let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      if (f.type === 'range' || f.type === 'number' || f.type === 'time') v = Number(v);
      target[k] = v;
      const out = e.target.parentElement.querySelector('output');
      if (out) out.textContent = f.step && f.step < 1 ? v.toFixed(2) : v;
      onChange && onChange(k, v);
      emit('edit');
    });
    root.addEventListener('change', () => {
      onChange && onChange('change');
      emit('project');
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

// CapCut-style tabs inside the properties panel
let propsTab = 'video';
const propsTabs = tabs => `<div class="ptabs">${tabs.map(([id, name]) => `<button data-ptab="${id}" class="${id === propsTab ? 'active' : ''}">${name}</button>`).join('')}</div>`;
const audioFields = () => [
  { k: 'volume', label: 'ລະດັບສຽງ', type: 'range', min: 0, max: 2, step: 0.05 },
  { k: 'fadeIn', label: 'ຄ່ອຍໆດັງຂຶ້ນ (ວິ)', type: 'range', min: 0, max: 5, step: 0.1 },
  { k: 'fadeOut', label: 'ຄ່ອຍໆເບົາລົງ (ວິ)', type: 'range', min: 0, max: 5, step: 0.1 }
];
const speedPanel = c => `<div class="props-info">ຄວາມຍາວ ${fmtTime(clipDuration(c))} (ຕົ້ນສະບັບ ${fmtTime(c.out - c.in)})</div>
  <div class="speed-presets">${[0.25, 0.5, 1, 1.5, 2, 3, 4].map(v => `<button data-speed="${v}" class="${(c.speed || 1) === v ? 'active' : ''}">${v}x</button>`).join('')}</div>`;
const ANIM_TYPES = [['none', 'ບໍ່ມີ'], ...TRANSITIONS.map(t => [t.id, t.name])];
const animFields = () => [
  { k: 'inType', label: 'ແອນິເມຊັນເຂົ້າ', type: 'select', options: ANIM_TYPES },
  { k: 'inDur', label: 'ໄລຍະເວລາເຂົ້າ (ວິ)', type: 'range', min: 0.1, max: 3, step: 0.1 },
  { k: 'outType', label: 'ແອນິເມຊັນອອກ', type: 'select', options: ANIM_TYPES },
  { k: 'outDur', label: 'ໄລຍະເວລາອອກ (ວິ)', type: 'range', min: 0.1, max: 3, step: 0.1 }
];

$('#props').addEventListener('click', e => {
  const tab = e.target.closest('[data-ptab]');
  if (tab) { propsTab = tab.dataset.ptab; renderProps(); return; }
  const sp = e.target.closest('[data-speed]');
  const c = selectedClip();
  if (sp && c) { commit(() => { c.speed = Number(sp.dataset.speed); }); return; }
  if (e.target.closest('[data-reset-tf]') && c) commit(() => { c.tf = { ...DEFAULT_TF }; });
});

function renderProps() {
  const root = $('#props');
  const c = selectedClip();
  const sel = state.selection;
  let title = 'ໂປຣເຈັກ';
  const parts = [];

  if (!c) {
    parts.push(`<div class="props-section"><h4>ຮູບແບບຊັບໄຕເຕິ້ນ (ທຸກແຖວ)</h4>`, form(styleFields(true), state.project.subStyle), `</div>`);
  } else if (sel.track === 'video') {
    const m = state.media.get(c.mediaId);
    const isVideo = m && m.type === 'video';
    title = isVideo ? 'ຄລິບວິດີໂອ' : 'ຮູບພາບ';
    const tabs = [['video', isVideo ? 'ວິດີໂອ' : 'ຮູບ'], ...(isVideo ? [['audio', 'ສຽງ'], ['speed', 'ຄວາມໄວ']] : []), ['anim', 'ແອນິເມຊັນ']];
    if (!tabs.some(t => t[0] === propsTab)) propsTab = 'video';
    parts.push(propsTabs(tabs));
    const look = [
      c.filter && `ຟິວເຕີ: ${(FILTERS.find(f => f.id === c.filter.id) || {}).name}`,
      c.adj && Object.values(c.adj).some(Boolean) && 'ປັບແຕ່ງສີແລ້ວ',
      c.trans && `ທຣານຊິຊັນ: ${(TRANSITIONS.find(x => x.id === c.trans.type) || {}).name}`
    ].filter(Boolean).join(' · ');
    if (propsTab === 'video') {
      if (!c.tf) c.tf = { ...DEFAULT_TF };
      parts.push(`<div class="props-info">${escapeHtml(m ? m.name : '')}<br>ໃຊ້ຊ່ວງ ${fmtTime(c.in)} – ${fmtTime(c.out)}${look ? `<br>${escapeHtml(look)}` : ''}</div>`,
        form([
          ...(isVideo ? [] : [{ k: 'out', label: 'ໄລຍະເວລາ (ວິນາທີ)', type: 'time' }]),
          { k: 'fit', label: 'ການຈັດວາງ', type: 'select', options: [['contain', 'ພໍດີ (ເຫັນທັງໝົດ)'], ['cover', 'ເຕັມຈໍ (ຕັດຂອບ)']] },
          { k: 'bg', label: 'ພື້ນຫຼັງ', type: 'select', options: [['blur', 'ມົວ (ແບບ CapCut)'], ['black', 'ສີດຳ']] }
        ], c, k => { if (k === 'out' || k === 'change') c.out = Math.max(c.in + 0.1, c.out || 0); }),
        `<div class="props-section"><h4>ການແປງ (Transform)</h4>`,
        form([
          { k: 'scale', label: 'ຂະໜາດ', type: 'range', min: 0.1, max: 3, step: 0.01 },
          { k: 'x', label: 'ຕຳແໜ່ງ X', type: 'range', min: -1, max: 1, step: 0.01 },
          { k: 'y', label: 'ຕຳແໜ່ງ Y', type: 'range', min: -1, max: 1, step: 0.01 },
          { k: 'rot', label: 'ໝູນ (ອົງສາ)', type: 'range', min: -180, max: 180, step: 1 },
          { k: 'opacity', label: 'ຄວາມທຶບ', type: 'range', min: 0, max: 1, step: 0.01 },
          { k: 'flip', label: 'ສະທ້ອນຊ້າຍ-ຂວາ', type: 'check' }
        ], c.tf),
        `<button class="wide" data-reset-tf>ຄືນຄ່າ Transform</button></div>`);
    } else if (propsTab === 'audio') {
      parts.push(form(audioFields(), c));
    } else if (propsTab === 'speed') {
      parts.push(speedPanel(c), form([{ k: 'speed', label: 'ຄວາມໄວ (x)', type: 'range', min: 0.25, max: 4, step: 0.05 }], c));
    } else {
      if (!c.anim) c.anim = { ...DEFAULT_ANIM };
      parts.push(form(animFields(), c.anim));
    }
  } else if (sel.track === 'audio') {
    const m = state.media.get(c.mediaId);
    title = 'ສຽງ / ເພງ';
    if (propsTab !== 'speed') propsTab = 'audio';
    parts.push(propsTabs([['audio', 'ສຽງ'], ['speed', 'ຄວາມໄວ']]), `<div class="props-info">${escapeHtml(m ? m.name : '')}${m && m.credit ? `<br><small>${escapeHtml(m.credit)}</small>` : ''}</div>`);
    if (propsTab === 'audio') parts.push(form([{ k: 'start', label: 'ເລີ່ມທີ່ (ວິນາທີ)', type: 'time' }, ...audioFields()], c, fixTiming('audio', c)));
    else parts.push(speedPanel(c), form([{ k: 'speed', label: 'ຄວາມໄວ (x)', type: 'range', min: 0.25, max: 4, step: 0.05 }], c));
  } else if (sel.track === 'text') {
    title = 'ຂໍ້ຄວາມ';
    parts.push(form([{ k: 'text', label: 'ຂໍ້ຄວາມ', type: 'textarea' },
      { k: 'start', label: 'ເລີ່ມ (ວິ)', type: 'time' }, { k: 'end', label: 'ຈົບ (ວິ)', type: 'time' }], c, fixTiming('text', c)),
      `<div class="props-section"><h4>ຮູບແບບ</h4>`, form(styleFields(false), c.style), `</div>`);
  } else if (sel.track === 'stickers') {
    title = 'ສະຕິກເກີ';
    parts.push(form([
      { k: 'size', label: 'ຂະໜາດ', type: 'range', min: 0.05, max: 1, step: 0.01 },
      { k: 'rot', label: 'ໝູນ (ອົງສາ)', type: 'range', min: -180, max: 180, step: 1 },
      { k: 'x', label: 'ຕຳແໜ່ງ ຊ້າຍ-ຂວາ', type: 'range', min: 0, max: 1, step: 0.01 },
      { k: 'y', label: 'ຕຳແໜ່ງ ເທິງ-ລຸ່ມ', type: 'range', min: 0, max: 1, step: 0.01 },
      { k: 'anim', label: 'ແອນິເມຊັນ', type: 'select', options: STICKER_ANIMS },
      { k: 'start', label: 'ເລີ່ມ (ວິ)', type: 'time' }, { k: 'end', label: 'ຈົບ (ວິ)', type: 'time' }
    ], c, fixTiming('stickers', c)));
  } else if (sel.track === 'effects') {
    title = 'ເອັບເຟັກ';
    parts.push(form([
      { k: 'fx', label: 'ເອັບເຟັກ', type: 'select', options: EFFECTS.map(e => [e.id, e.name]) },
      { k: 'amount', label: 'ຄວາມແຮງ', type: 'range', min: 0.1, max: 1, step: 0.05 },
      { k: 'start', label: 'ເລີ່ມ (ວິ)', type: 'time' }, { k: 'end', label: 'ຈົບ (ວິ)', type: 'time' }
    ], c, fixTiming('effects', c)));
  } else if (sel.track === 'subs') {
    title = 'ແຖວຊັບໄຕເຕິ້ນ';
    parts.push(form([{ k: 'text', label: 'ຂໍ້ຄວາມ', type: 'textarea' },
      ...(c.tr ? [{ k: 'tr', label: 'ຄຳແປ (ແຖວທີສອງ)', type: 'textarea' }] : []),
      { k: 'start', label: 'ເລີ່ມ (ວິ)', type: 'time' }, { k: 'end', label: 'ຈົບ (ວິ)', type: 'time' }], c, fixTiming('subs', c)),
      `<div class="props-section"><h4>ຮູບແບບຊັບ (ໃຊ້ກັບທຸກແຖວ)</h4>`, form(styleFields(true), state.project.subStyle), `</div>`);
  }

  root.innerHTML = `<h3>${title}</h3>` + parts.map(p => typeof p === 'string' ? p : `<div class="form" data-form>${p.html}</div>`).join('');
  const forms = parts.filter(p => typeof p !== 'string');
  $$('[data-form]', root).forEach((el, i) => forms[i].bind(el));
}

// ---------------------------------------------------------------- canvas: drag text to move
canvas.addEventListener('pointerdown', e => {
  const r = canvas.getBoundingClientRect();
  const sx = canvas.width / r.width, sy = canvas.height / r.height;
  const hit = player.hitTest((e.clientX - r.left) * sx, (e.clientY - r.top) * sy);
  if (!hit) { select(null); return; }
  select(hit.track, hit.id);
  const clip = findClip(hit.track, hit.id);
  const style = hit.track === 'text' ? clip.style : hit.track === 'stickers' ? clip : state.project.subStyle;
  const x0 = e.clientX, y0 = e.clientY, ox = style.x, oy = style.y;
  let moved = false;
  const move = ev => {
    if (!moved) { checkpoint(); moved = true; }
    if (hit.track !== 'subs') style.x = clamp(ox + (ev.clientX - x0) / r.width, 0, 1);
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
    const cut = c.in + (t - videoLayout()[idx].start) * (c.speed || 1);
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
    const cut = c.in + (t - c.start) * (c.speed || 1);
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

// Q / W in CapCut: delete the part of a clip left / right of the playhead.
function trimToPlayhead(side) {
  const t = state.time;
  const MIN = 0.05;
  const sel = state.selection;
  const track = sel ? sel.track : 'video';
  let target = null;
  if (track === 'video') {
    target = videoLayout().find(l => (!sel || l.clip.id === sel.id) && t > l.start + MIN && t < l.end - MIN);
  } else {
    const c = selectedClip();
    const end = c && (track === 'audio' ? c.start + clipDuration(c) : c.end);
    if (c && t > c.start + MIN && t < end - MIN) target = { clip: c, start: c.start };
  }
  if (!target) return toast('ວາງເສັ້ນເວລາໄວ້ເທິງຄລິບກ່ອນ', 'warn');
  const c = target.clip;
  const local = t - target.start;
  const sp = c.speed || 1;
  commit(() => {
    if (track === 'video' || track === 'audio') {
      if (side === 'left') { c.in += local * sp; if (track === 'audio') c.start = t; }
      else c.out = c.in + local * sp;
    } else if (side === 'left') c.start = t;
    else c.end = t;
  });
  if (side === 'left' && track === 'video') player.seek(target.start);
}

// Freeze frame: grab the current frame of the main clip and hold it for 3 s.
async function freezeFrame() {
  const t = state.time;
  const l = videoLayout().find(x => t >= x.start && t < x.end);
  const m = l && state.media.get(l.clip.mediaId);
  if (!m || m.type !== 'video') return toast('ວາງເສັ້ນເວລາໄວ້ເທິງຄລິບວິດີໂອກ່ອນ', 'warn');
  const el = player.element(m);
  if (el.readyState < 2) return toast('ລໍຖ້າວິດີໂອໂຫຼດກ່ອນ', 'warn');
  const c = document.createElement('canvas');
  c.width = el.videoWidth; c.height = el.videoHeight;
  c.getContext('2d').drawImage(el, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const img = await createMedia(blob, `ເຟຣມຄ້າງ ${fmtTime(t)}`, { type: 'image' });
  adoptMedia(img);
  const tracks = JSON.parse(JSON.stringify(state.project.tracks));
  const split = splitTrack(tracks, 'video', l.clip.id, t);
  const idx = tracks.video.findIndex(x => x.id === l.clip.id) + (split ? 1 : 0);
  tracks.video.splice(idx, 0, { id: newId(), mediaId: img.id, in: 0, out: 3, volume: 1, fit: l.clip.fit, bg: l.clip.bg, filter: l.clip.filter, adj: l.clip.adj });
  commit(p => { p.tracks = tracks; });
  toast('ເພີ່ມເຟຣມຄ້າງ 3 ວິ ແລ້ວ ✓', 'ok');
}

function videoTarget() {
  const c = selectedClip();
  if (c && state.selection.track === 'video') return c;
  const l = videoLayout().find(x => state.time >= x.start && state.time < x.end);
  return l ? l.clip : null;
}
function transformClip(fn) {
  const c = videoTarget();
  if (!c) return toast('ເລືອກຄລິບວິດີໂອກ່ອນ', 'warn');
  commit(() => { c.tf = { ...DEFAULT_TF, ...c.tf }; fn(c.tf); });
}

// Waveforms: one peak per 1/50 s, decoded at a low sample rate to save memory.
const peakQueue = [];
let peakBusy = false;
function queuePeaks(m) {
  if (m.type === 'image' || m.peaks || m.blob.size > 300 * 1024 * 1024) return;
  peakQueue.push(m);
  runPeaks();
}
async function runPeaks() {
  if (peakBusy) return;
  peakBusy = true;
  while (peakQueue.length) {
    const m = peakQueue.shift();
    try {
      const buf = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(await m.blob.arrayBuffer());
      const d = buf.getChannelData(0);
      const step = buf.sampleRate / 50;
      const peaks = new Float32Array(Math.ceil(d.length / step));
      let max = 0;
      for (let i = 0; i < peaks.length; i++) {
        let p = 0;
        for (let j = Math.floor(i * step), e = Math.min(d.length, (i + 1) * step); j < e; j += 2) p = Math.max(p, Math.abs(d[j]));
        peaks[i] = p;
        max = Math.max(max, p);
      }
      if (max > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
      m.peaks = peaks;
      emit('drag');
    } catch (e) {
      m.peaks = null; // no audio track, or a codec the browser can't decode
    }
  }
  peakBusy = false;
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
let offline = false;
const OFFLINE_MSG = 'ການຖອດສຽງ ແລະ ສຽງພາກ ຕ້ອງໃຊ້ເຊີບເວີ LaoCut + API Key (ເບິ່ງ README). ເຄື່ອງມືຂໍ້ຄວາມ AI ແລະ ຜູ້ຊ່ວຍ AI ໃຊ້ໄດ້ຢູ່ນີ້';
let aiStatus = {};

async function refreshStatus() {
  try {
    const r = await fetch('/api/editor/status');
    if (r.status === 401) { location.href = '/login.html'; return; }
    const s = await r.json();
    aiStatus = s;
    aiReady = s.whisper;
    renderAITextStatus();
    voiceover.renderStatus();
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
    offline = true;
    renderAITextStatus();
    $('#inboxLink').hidden = true;
    $('#settingsBtn').hidden = true;
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
  if (offline) { toast(OFFLINE_MSG, 'warn'); return; }
  if (!aiReady) { openModal('settingsModal'); return; }
  const lang = $('#subLang').value;
  const replace = $('#subReplace').checked;
  if (!replace && state.project.tracks.subs.length && !(await ask('ຈະເພີ່ມຊັບໃໝ່ໃສ່ບ່ອນທີ່ຍັງວ່າງ. ສືບຕໍ່ບໍ?', 'ສືບຕໍ່'))) return;
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

// Text AI: the server's OpenAI key, or Claude when the page runs on claude.ai.
const aiStatusOrNull = () => (offline ? null : aiStatus);
async function needTextAI() {
  if (await aiBackend(aiStatusOrNull())) return true;
  if (offline) toast('AI ໃຊ້ບໍ່ໄດ້ໃນໜ້ານີ້ — ເປີດລິ້ງໃນ claude.ai ຫຼື ໃຊ້ກັບເຊີບເວີ', 'warn');
  else openModal('settingsModal');
  return false;
}
async function renderAITextStatus() {
  const b = await aiBackend(aiStatusOrNull());
  $('#aiTextStatus').innerHTML = b === 'server' ? '<span class="dot ok"></span> ໃຊ້ OpenAI ຜ່ານເຊີບເວີ'
    : b === 'claude' ? '<span class="dot ok"></span> ໃຊ້ Claude (ຈາກບັນຊີ claude.ai ຂອງທ່ານ)'
      : '<span class="dot"></span> ຍັງບໍ່ມີ AI — ຕັ້ງ OpenAI Key ຫຼື ເປີດໃນ claude.ai';
}

$('#writeScriptBtn').addEventListener('click', async () => {
  const topic = $('#scriptTopic').value.trim();
  if (!topic) return toast('ພິມຫົວຂໍ້ວິດີໂອກ່ອນ', 'warn');
  if (!(await needTextAI())) return;
  busy('AI ກຳລັງຂຽນບົດ...', 0.3);
  try {
    const text = await writeScript({ topic, seconds: Number($('#scriptLen').value), tone: $('#scriptTone').value }, { status: aiStatusOrNull() });
    const clean = normalizeLao(text.replace(/^["'\s]+|["'\s]+$/g, '')).replace(/ ?\n ?/g, '\n');
    $('#scriptInput').value = clean;
    $('#ttsText').value = clean.replace(/\n/g, ' ');
    toast('ຂຽນບົດແລ້ວ — ກົດ "ຈັດເວລາຕາມສຽງເວົ້າ" ຫຼື ໄປແຖບສຽງພາກ', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busy(false);
  }
});

$('#proofreadBtn').addEventListener('click', async () => {
  const subs = state.project.tracks.subs;
  if (!subs.length) return toast('ຍັງບໍ່ມີຊັບ', 'warn');
  if (!(await needTextAI())) return;
  const ids = subs.map(s => s.id);
  try {
    const out = [];
    for (let i = 0; i < subs.length; i += TRANSLATE_BATCH) {
      busy(`AI ກຳລັງກວດຄຳຜິດ ${i + 1}–${Math.min(i + TRANSLATE_BATCH, subs.length)} / ${subs.length}...`, i / subs.length);
      out.push(...await proofreadLines(subs.slice(i, i + TRANSLATE_BATCH).map(s => s.text), { status: aiStatusOrNull() }));
    }
    let changed = 0;
    commit(p => {
      for (const s of p.tracks.subs) {
        const i = ids.indexOf(s.id);
        if (i < 0 || !out[i]) continue;
        const fixed = normalizeLao(out[i]);
        if (fixed !== s.text) { s.text = fixed; changed++; }
      }
    });
    toast(`ກວດແລ້ວ — ແກ້ ${changed} ແຖວ (Ctrl+Z ເພື່ອຍົກເລີກ)`, 'ok');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busy(false);
  }
});

async function makePost() {
  if (!(await needTextAI())) return;
  $('#postText').value = 'AI ກຳລັງຂຽນ...';
  openModal('postModal');
  try {
    const p = await postCaption({
      transcript: state.project.tracks.subs.map(s => s.text).join(' ') || state.project.tracks.text.map(t => t.text).join(' '),
      title: state.project.name,
      platform: $('#postPlatform').value
    }, { status: aiStatusOrNull() });
    const tags = Array.isArray(p.hashtags) ? p.hashtags.join(' ') : '';
    $('#postText').value = [p.title, '', p.caption, '', tags].filter(x => x !== undefined).join('\n').trim();
  } catch (e) {
    $('#postText').value = e.message;
  }
}
$('#postBtn').addEventListener('click', makePost);
$('#postRegenBtn').addEventListener('click', makePost);
$('#postCopyBtn').addEventListener('click', () => {
  $('#postText').select();
  navigator.clipboard?.writeText($('#postText').value).then(() => toast('ກັອບແລ້ວ', 'ok'), () => {});
});

$('#translateBtn').addEventListener('click', async () => {
  if (!(await needTextAI())) return;
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
      out.push(...await translateLines(lines.slice(i, i + TRANSLATE_BATCH), from, to, { status: aiStatusOrNull() }));
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
  $('#subCount').toggleAttribute('data-zero', !subs.length);
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
  const act = e.target.closest('[data-act]')?.dataset.act;
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
  ask('ລຶບຊັບທັງໝົດບໍ?', 'ລຶບທັງໝົດ').then(ok => ok && commit(p => { p.tracks.subs = []; }));
});

async function importSubtitleFile(file) {
  const segs = parseSubtitles(await file.text());
  if (!segs.length) { toast('ອ່ານໄຟລ໌ຊັບບໍ່ໄດ້', 'error'); return; }
  applyGeneratedSubs(segs, true);
  toast(`ນຳເຂົ້າຊັບ ${segs.length} ແຖວ`, 'ok');
}
$('#importSrtBtn').addEventListener('click', () => $('#srtInput').click());
$('#srtInput').addEventListener('change', e => { if (e.target.files[0]) importSubtitleFile(e.target.files[0]); e.target.value = ''; });
function saveOrToast(blob, name) {
  download(blob, name).catch(e => toast(e.message, 'error'));
}
const subsForExport = () => {
  const digits = state.project.subStyle.laoDigits;
  return state.project.tracks.subs.map(s => ({ ...s, text: digits ? toLaoDigits(subDisplay(s)) : subDisplay(s) }));
};
$('#exportSrtBtn').addEventListener('click', () => {
  if (!state.project.tracks.subs.length) return toast('ຍັງບໍ່ມີຊັບ', 'warn');
  saveOrToast(new Blob(['\ufeff' + toSRT(subsForExport())], { type: 'text/plain;charset=utf-8' }), `${state.project.name}.srt`);
});
$('#exportVttBtn').addEventListener('click', () => {
  if (!state.project.tracks.subs.length) return toast('ຍັງບໍ່ມີຊັບ', 'warn');
  saveOrToast(new Blob([toVTT(subsForExport())], { type: 'text/vtt;charset=utf-8' }), `${state.project.name}.vtt`);
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
      azure_speech_region: $('#azureRegionInput').value
    })
  });
  if (r.ok) { toast('ບັນທຶກແລ້ວ', 'ok'); closeModal('settingsModal'); refreshStatus(); }
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
  const used = new Set([...state.project.tracks.video, ...state.project.tracks.audio, ...state.project.tracks.stickers].map(c => c.mediaId));
  const credits = [...used].map(id => state.media.get(id)).filter(m => m && m.credit && m.license === 'by').map(m => m.credit);
  $('#creditsBox').hidden = !credits.length;
  $('#creditsText').value = credits.join('\n');
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
      if (await download(res.blob, `${state.project.name}.${res.ext}`)) toast('ສົ່ງອອກວິດີໂອສຳເລັດ ✓', 'ok');
      closeModal('exportModal');
    }
  } catch (e) {
    toast(e.message, 'error');
  }
  $('#startExportBtn').disabled = false;
  $('#exportProgress').hidden = true;
});
$('#copyCreditsBtn').addEventListener('click', () => {
  $('#creditsText').select();
  navigator.clipboard?.writeText($('#creditsText').value).then(() => toast('ກັອບແລ້ວ', 'ok'), () => {});
});
$('#cancelExportBtn').addEventListener('click', () => { exportVideo.cancel && exportVideo.cancel(); closeModal('exportModal'); });

const voiceover = initVoiceover({
  $, toast, busy, createMedia, discardMedia, adoptMedia,
  openModal: id => (offline ? toast(OFFLINE_MSG, 'warn') : openModal(id)),
  getStatus: () => aiStatus
});

// ---------------------------------------------------------------- top bar & transport
$('#projectName').addEventListener('change', e => commit(p => { p.name = e.target.value.trim() || 'ໂປຣເຈັກ'; }));
$('#aspectSelect').addEventListener('change', e => { commit(p => { p.aspect = e.target.value; }); player.resize(); });
$('#newProjectBtn').addEventListener('click', async () => {
  if (await ask('ເລີ່ມໂປຣເຈັກໃໝ່? ໄຟລ໌ສື່ຍັງຢູ່ໃນຄັງ, ຍົກເລີກ (Ctrl+Z) ໄດ້', 'ເລີ່ມໃໝ່')) resetProject();
});
$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
$('#playBtn').addEventListener('click', () => player.toggle());
$('#backBtn').addEventListener('click', () => player.seek(0));
$('#prevFrame').addEventListener('click', () => player.seek(state.time - 1 / 30));
$('#nextFrame').addEventListener('click', () => player.seek(state.time + 1 / 30));
$('#fullscreenBtn').addEventListener('click', () => $('#stage').requestFullscreen && $('#stage').requestFullscreen());
$('#splitBtn').addEventListener('click', splitAtPlayhead);
$('#trimLBtn').addEventListener('click', () => trimToPlayhead('left'));
$('#trimRBtn').addEventListener('click', () => trimToPlayhead('right'));
$('#freezeBtn').addEventListener('click', () => freezeFrame().catch(e => toast(e.message, 'error')));
$('#flipBtn').addEventListener('click', () => transformClip(tf => { tf.flip = !tf.flip; }));
$('#rotateBtn').addEventListener('click', () => transformClip(tf => { tf.rot = ((tf.rot + 90 + 180) % 360) - 180; }));
$('#zoomOutBtn').addEventListener('click', () => { state.zoom = clamp(state.zoom / 1.3, 4, 400); emit('zoom'); });
$('#zoomInBtn').addEventListener('click', () => { state.zoom = clamp(state.zoom * 1.3, 4, 400); emit('zoom'); });
$('#deleteBtn').addEventListener('click', deleteSelected);
$('#dupBtn').addEventListener('click', duplicateSelected);
$('#addSubBtn').addEventListener('click', addSubtitleAtPlayhead);
$('#zoomRange').addEventListener('input', e => { state.zoom = Number(e.target.value); emit('zoom'); });

const library = initLibrary({ $, $$, toast, busy, createMedia, adoptMedia, select, isOffline: () => offline });

function openTab(tab) {
  $$('.tabs button').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
  $$('.tab-panel').forEach(p => p.hidden = p.id !== `tab-${tab}`);
  library.refresh(tab);
}
$$('.tabs button').forEach(b => b.addEventListener('click', () => openTab(b.dataset.tab)));
timeline.onTransitionClick = () => openTab('transitions');
initAssistant({ $, toast, textPresets: TEXT_PRESETS, addLibraryAudio: library.addLibraryAudio, getStatus: aiStatusOrNull });

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
  else if (!mod && e.key.toLowerCase() === 'q') trimToPlayhead('left');
  else if (!mod && e.key.toLowerCase() === 'w') trimToPlayhead('right');
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
  else if (e.key === 'ArrowLeft') player.seek(state.time - (e.shiftKey ? 1 : 1 / 30));
  else if (e.key === 'ArrowRight') player.seek(state.time + (e.shiftKey ? 1 : 1 / 30));
  else if (e.key === 'Home') player.seek(0);
  else if (e.key === 'End') player.seek(totalDuration());
  else if (e.key.toLowerCase() === 't' && !mod) addSubtitleAtPlayhead();
  else if (e.key === '+' || e.key === '=') { state.zoom = clamp(state.zoom * 1.25, 4, 400); emit('zoom'); }
  else if (e.key === '-') { state.zoom = clamp(state.zoom / 1.25, 4, 400); emit('zoom'); }
});

// ---------------------------------------------------------------- render wiring
function renderTop() {
  $('#projectName').value = state.project.name;
  $('#aspectSelect').value = state.project.aspect;
  $('#stage').dataset.aspect = state.project.aspect;
  $('#aspectChip').textContent = state.project.aspect;
  const t = state.project.tracks;
  $('#stage').classList.toggle('empty', !t.video.length && !t.audio.length && !t.text.length && !t.subs.length);
}

function renderTransport() {
  $('#timeNow').textContent = fmtTime(state.time, 2);
  $('#timeTotal').textContent = fmtTime(totalDuration(), 2);
  $('#playBtn use').setAttribute('href', state.playing ? '#i-pause' : '#i-play');
}

subscribe(kind => {
  if (kind === 'time') { timeline.renderPlayhead(); renderTransport(); highlightActiveSub(); return; }
  if (kind === 'play') { renderTransport(); return; }
  if (kind === 'saved') {
    $('#savedAt').textContent = `ບັນທຶກອັດຕະໂນມັດ ${state.savedAt.toLocaleTimeString('lo-LA', { hour: '2-digit', minute: '2-digit' })}`;
    return;
  }
  if (kind === 'zoom') { $('#zoomRange').value = state.zoom; timeline.render(); return; }
  if (kind === 'drag' || kind === 'edit') { timeline.render(); renderTransport(); return; }
  timeline.render();
  renderTransport();
  renderProps();
  library.refresh();
  if (kind === 'project') { renderTop(); renderSubList(); if (!player.exporting) player.resize(); }
});

// ---------------------------------------------------------------- boot
(async function boot() {
  // make sure every Lao font is ready before the first canvas draw
  if (document.fonts) {
    Promise.all(LAO_FONTS.flatMap(f => [document.fonts.load(`400 40px "${f.family}"`, 'ລາວ'), document.fonts.load(`700 40px "${f.family}"`, 'ລາວ')])).catch(() => {});
  }
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
    t.stickers = t.stickers.filter(c => c.kind !== 'image' || state.media.has(c.mediaId));
  }
  // generated/downloaded files (per-line voiceover, sticker images) no clip uses any more
  const used = new Set([...state.project.tracks.audio, ...state.project.tracks.stickers].map(c => c.mediaId));
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
  for (const m of state.media.values()) queuePeaks(m);
})();
