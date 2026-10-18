// UI for the asset tabs: audio (music, sound effects, online search),
// stickers, effects, transitions, filters and colour adjustments.
import { state, commit, checkpoint, emit, newId, sortTrack, videoLayout, selectedClip } from '../store.js';
import { encodeWav, fmtTime } from '../util.js';
import { escapeHtml } from '../timeline.js';
import { MUSIC, SFX, SFX_CATS, renderMusic, renderSfx, SAMPLE_RATE } from './audio.js';
import {
  FILTERS, ADJUST_DEFAULT, ADJUST_FIELDS, EFFECTS, EFFECT_CATS, TRANSITIONS, EMOJI, BADGES,
  filterThumb, badgeThumb
} from './visual.js';

const I = n => `<svg class="i"><use href="#i-${n}"/></svg>`;
const LICENSE_NAMES = { cc0: 'CC0', pdm: 'ສາທາລະນະ', by: 'CC BY' };

export function initLibrary({ $, $$, toast, busy, createMedia, adoptMedia, select, isOffline }) {
  // ---------------------------------------------------------------- segmented controls
  for (const seg of $$('.seg')) {
    seg.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      $$('button', seg).forEach(x => x.classList.toggle('active', x === b));
      const panel = seg.closest('.tab-panel');
      $$('[data-pane]', panel).forEach(p => { p.hidden = p.dataset.pane !== b.dataset.v; });
    });
  }

  // ---------------------------------------------------------------- audio preview
  let previewCtx = null;
  let previewSrc = null;
  let previewEl = null;
  function stopPreview() {
    if (previewSrc) { try { previewSrc.stop(); } catch (e) { /* already stopped */ } previewSrc = null; }
    if (previewEl) { previewEl.pause(); previewEl = null; }
    $$('.lib-play.playing').forEach(b => { b.classList.remove('playing'); b.innerHTML = I('play'); });
  }
  function playSamples(samples, btn) {
    stopPreview();
    previewCtx = previewCtx || new AudioContext();
    const buf = previewCtx.createBuffer(1, samples.length, SAMPLE_RATE);
    buf.copyToChannel(samples, 0);
    previewSrc = previewCtx.createBufferSource();
    previewSrc.buffer = buf;
    previewSrc.connect(previewCtx.destination);
    previewSrc.onended = () => { if (btn) { btn.classList.remove('playing'); btn.innerHTML = I('play'); } };
    previewSrc.start();
    if (btn) { btn.classList.add('playing'); btn.innerHTML = I('pause'); }
  }

  const rendered = new Map(); // library id → samples
  async function samplesFor(kind, item) {
    const key = `${kind}:${item.id}`;
    if (!rendered.has(key)) rendered.set(key, kind === 'music' ? await renderMusic(item) : await renderSfx(item));
    return rendered.get(key);
  }

  async function addAudioMedia(m, label) {
    commit(p => {
      p.tracks.audio.push({ id: newId(), mediaId: m.id, start: state.time, in: 0, out: m.duration, volume: label === 'music' ? 0.5 : 1 });
      sortTrack('audio');
    });
    toast(`ເພີ່ມ "${m.name}" ທີ່ ${fmtTime(state.time)} ແລ້ວ ✓`, 'ok');
  }

  async function ensureBuiltIn(kind, item) {
    let m = [...state.media.values()].find(x => x.libId === `${kind}:${item.id}`);
    if (!m) {
      busy(kind === 'music' ? 'ກຳລັງສ້າງເພງ...' : 'ກຳລັງສ້າງສຽງ...', 0.5);
      try {
        const blob = encodeWav(await samplesFor(kind, item), SAMPLE_RATE);
        m = await createMedia(blob, item.name, { libId: `${kind}:${item.id}` });
        adoptMedia(m);
      } finally {
        busy(false);
      }
    }
    return m;
  }

  async function addBuiltIn(kind, item) {
    addAudioMedia(await ensureBuiltIn(kind, item), kind);
  }

  function libRow(kind, item, meta) {
    return `<div class="lib-row" data-kind="${kind}" data-id="${item.id}">
      <button class="lib-play icon" data-act="play" aria-label="ຟັງ">${I('play')}</button>
      <div class="lib-info"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(meta)}</small></div>
      <button class="lib-add icon" data-act="add" aria-label="ເພີ່ມ">${I('plus')}</button>
    </div>`;
  }

  $('#musicList').innerHTML = MUSIC.map(t => libRow('music', t, t.mood)).join('');
  let sfxCat = 'all';
  function renderSfxList() {
    $('#sfxCats').innerHTML = SFX_CATS.map(([id, name]) => `<button class="chip${id === sfxCat ? ' active' : ''}" data-cat="${id}">${name}</button>`).join('');
    $('#sfxList').innerHTML = SFX.filter(x => sfxCat === 'all' || x.cat === sfxCat).map(x => libRow('sfx', x, `${x.dur.toFixed(1)} ວິ`)).join('');
  }
  renderSfxList();
  $('#sfxCats').addEventListener('click', e => {
    const b = e.target.closest('[data-cat]');
    if (b) { sfxCat = b.dataset.cat; renderSfxList(); }
  });

  async function onLibClick(e) {
    const btn = e.target.closest('[data-act]');
    const row = e.target.closest('.lib-row');
    if (!btn || !row) return;
    const { kind, id } = row.dataset;
    try {
      if (kind === 'music' || kind === 'sfx') {
        const item = (kind === 'music' ? MUSIC : SFX).find(x => x.id === id);
        if (btn.dataset.act === 'play') {
          if (btn.classList.contains('playing')) return stopPreview();
          btn.innerHTML = '<span class="mini-spin"></span>';
          playSamples(await samplesFor(kind, item), btn);
        } else {
          await addBuiltIn(kind, item);
        }
      } else if (kind === 'online') {
        const r = audioResults.find(x => String(x.id) === id);
        if (btn.dataset.act === 'play') {
          if (btn.classList.contains('playing')) return stopPreview();
          stopPreview();
          previewEl = new Audio(fileUrl(r.url));
          previewEl.play().catch(() => toast('ຫຼິ້ນໄຟລ໌ນີ້ບໍ່ໄດ້', 'error'));
          previewEl.onended = stopPreview;
          btn.classList.add('playing'); btn.innerHTML = I('pause');
        } else {
          busy('ກຳລັງດາວໂຫຼດ...', 0.4);
          try {
            const blob = await fetchFile(r.url);
            const m = await createMedia(blob, r.title, { credit: creditFor(r), license: r.license });
            adoptMedia(m);
            addAudioMedia(m, 'online');
          } finally {
            busy(false);
          }
        }
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  for (const id of ['#musicList', '#sfxList', '#audioResults']) $(id).addEventListener('click', onLibClick);

  // ---------------------------------------------------------------- online search (server only)
  const fileUrl = url => `/api/editor/library/file?url=${encodeURIComponent(url)}`;
  async function fetchFile(url) {
    const r = await fetch(fileUrl(url));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.blob();
  }
  function creditFor(r) {
    const lic = r.license === 'by' ? `CC BY ${r.licenseVersion}`.trim() : LICENSE_NAMES[r.license] || r.license;
    return `"${r.title}"${r.creator ? ` by ${r.creator}` : ''} — ${lic}${r.landing ? ` — ${r.landing}` : ''}`;
  }
  async function search(type, q, png) {
    if (isOffline()) throw new Error('ການຄົ້ນຫາອອນລາຍຕ້ອງໃຊ້ກັບເຊີບເວີ LaoCut');
    const qs = new URLSearchParams({ type, q });
    if (png) qs.set('png', '1');
    const r = await fetch(`/api/editor/library/search?${qs}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data.results;
  }

  let audioResults = [];
  $('#audioSearchForm').addEventListener('submit', async e => {
    e.preventDefault();
    const q = $('#audioSearch').value.trim();
    if (!q) return;
    $('#audioResults').innerHTML = '<div class="empty-hint">ກຳລັງຄົ້ນຫາ...</div>';
    try {
      audioResults = await search('audio', q);
      $('#audioResults').innerHTML = audioResults.length
        ? audioResults.map(r => libRow('online', { id: r.id, name: r.title },
          `${r.duration ? fmtTime(r.duration, 0) + ' · ' : ''}${LICENSE_NAMES[r.license] || r.license}${r.creator ? ' · ' + r.creator : ''}`)).join('')
        : '<div class="empty-hint">ບໍ່ພົບຜົນ — ລອງຄຳພາສາອັງກິດ</div>';
    } catch (err) {
      $('#audioResults').innerHTML = `<div class="empty-hint">${escapeHtml(err.message)}</div>`;
    }
  });

  // ---------------------------------------------------------------- stickers
  function addSticker(fields) {
    const id = newId();
    commit(p => {
      p.tracks.stickers.push({ id, start: state.time, end: state.time + 3, x: 0.5, y: 0.42, size: 0.28, rot: 0, anim: 'pop', ...fields });
      sortTrack('stickers');
    });
    select('stickers', id);
  }

  let emojiCat = Object.keys(EMOJI)[0];
  function renderEmoji() {
    $('#emojiCats').innerHTML = Object.keys(EMOJI).map(c => `<button class="chip${c === emojiCat ? ' active' : ''}" data-cat="${c}">${c}</button>`).join('');
    $('#emojiGrid').innerHTML = EMOJI[emojiCat].map(e => `<button class="emoji" data-e="${e}" title="ເພີ່ມ">${e}</button>`).join('');
  }
  renderEmoji();
  $('#emojiCats').addEventListener('click', e => { const b = e.target.closest('[data-cat]'); if (b) { emojiCat = b.dataset.cat; renderEmoji(); } });
  $('#emojiGrid').addEventListener('click', e => { const b = e.target.closest('[data-e]'); if (b) addSticker({ kind: 'emoji', value: b.dataset.e, size: 0.22 }); });

  let badgesDrawn = false;
  function renderBadges() {
    if (badgesDrawn) return;
    badgesDrawn = true;
    $('#badgeGrid').innerHTML = BADGES.map(b => `<button class="tile" data-badge="${b.id}">
      <span class="tile-art" style="background-image:url(${badgeThumb(b.id)})"></span><small>${b.name}</small></button>`).join('');
  }
  $('#badgeGrid').addEventListener('click', e => { const b = e.target.closest('[data-badge]'); if (b) addSticker({ kind: 'badge', value: b.dataset.badge, size: 0.4 }); });

  let imageResults = [];
  $('#imageSearchForm').addEventListener('submit', async e => {
    e.preventDefault();
    const q = $('#imageSearch').value.trim();
    if (!q) return;
    $('#imageResults').innerHTML = '<div class="empty-hint">ກຳລັງຄົ້ນຫາ...</div>';
    try {
      imageResults = await search('image', q, $('#imagePng').checked);
      $('#imageResults').innerHTML = imageResults.length
        ? imageResults.map(r => `<button class="tile" data-img="${r.id}" title="${escapeHtml(creditFor(r))}">
            <span class="tile-art checker" style="background-image:url('${escapeHtml(r.thumb || r.url)}')"></span>
            <small>${escapeHtml(LICENSE_NAMES[r.license] || r.license)}</small></button>`).join('')
        : '<div class="empty-hint">ບໍ່ພົບຜົນ — ລອງຄຳພາສາອັງກິດ</div>';
    } catch (err) {
      $('#imageResults').innerHTML = `<div class="empty-hint">${escapeHtml(err.message)}</div>`;
    }
  });
  $('#imageResults').addEventListener('click', async e => {
    const b = e.target.closest('[data-img]');
    if (!b) return;
    const r = imageResults.find(x => String(x.id) === b.dataset.img);
    busy('ກຳລັງດາວໂຫຼດຮູບ...', 0.4);
    try {
      const blob = await fetchFile(r.url);
      const m = await createMedia(blob, r.title, { type: 'image', hidden: true, credit: creditFor(r), license: r.license });
      adoptMedia(m);
      addSticker({ kind: 'image', mediaId: m.id, size: 0.35, anim: 'none' });
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy(false);
    }
  });

  // ---------------------------------------------------------------- effects
  let fxCat = 'all';
  const fxIcon = { motion: 'trans', light: 'sparkles', retro: 'film', frame: 'full', particle: 'sparkles' };
  function renderEffects() {
    $('#effectCats').innerHTML = EFFECT_CATS.map(([id, n]) => `<button class="chip${id === fxCat ? ' active' : ''}" data-cat="${id}">${n}</button>`).join('');
    $('#effectGrid').innerHTML = EFFECTS.filter(x => fxCat === 'all' || x.cat === fxCat).map(x =>
      `<button class="tile fx-tile fx-${x.cat}" data-fx="${x.id}"><span class="tile-art">${I(fxIcon[x.cat])}</span><small>${x.name}</small></button>`).join('');
  }
  renderEffects();
  $('#effectCats').addEventListener('click', e => { const b = e.target.closest('[data-cat]'); if (b) { fxCat = b.dataset.cat; renderEffects(); } });
  $('#effectGrid').addEventListener('click', e => {
    const b = e.target.closest('[data-fx]');
    if (!b) return;
    const id = newId();
    commit(p => {
      p.tracks.effects.push({ id, start: state.time, end: state.time + 3, fx: b.dataset.fx, amount: 1 });
      sortTrack('effects');
    });
    select('effects', id);
    toast(`ເພີ່ມເອັບເຟັກ "${(EFFECTS.find(x => x.id === b.dataset.fx) || {}).name}" ແລ້ວ`, 'ok');
  });

  // ---------------------------------------------------------------- targets for clip-level looks
  function targetClip() {
    const sel = selectedClip();
    if (sel && state.selection.track === 'video') return sel;
    const l = videoLayout().find(x => state.time >= x.start && state.time < x.end) || videoLayout()[0];
    return l ? l.clip : null;
  }
  // a transition lives on the clip after a cut: the selected clip, else the cut nearest the playhead
  function targetCut() {
    const layout = videoLayout();
    const sel = selectedClip();
    if (sel && state.selection.track === 'video') {
      const i = layout.findIndex(l => l.clip === sel);
      if (i > 0) return layout[i].clip;
      if (i === 0 && layout[1]) return layout[1].clip;
    }
    let best = null;
    for (let i = 1; i < layout.length; i++) {
      if (!best || Math.abs(layout[i].start - state.time) < Math.abs(best.start - state.time)) best = layout[i];
    }
    return best ? best.clip : null;
  }
  const clipName = c => {
    const i = state.project.tracks.video.indexOf(c);
    const m = state.media.get(c.mediaId);
    return `ຄລິບ ${i + 1}${m ? ' · ' + m.name : ''}`;
  };

  // ---------------------------------------------------------------- transitions
  function renderTransitions() {
    const c = targetCut();
    const cur = c && c.trans ? c.trans.type : null;
    $('#transTarget').innerHTML = c
      ? `ຈຸດຕໍ່ກ່ອນ <b>${escapeHtml(clipName(c))}</b>`
      : '<span class="warn">ຕ້ອງມີຢ່າງໜ້ອຍ 2 ຄລິບໃນແທຣັກວິດີໂອຫຼັກ</span>';
    $('#transGrid').innerHTML = TRANSITIONS.map(x =>
      `<button class="tile tr-tile tr-${x.id}${x.id === cur ? ' active' : ''}" data-tr="${x.id}" ${c ? '' : 'disabled'}>
        <span class="tile-art"><i class="a"></i><i class="b"></i></span><small>${x.name}</small></button>`).join('');
  }
  $('#transDur').addEventListener('input', e => { $('#transDurOut').textContent = `${Number(e.target.value).toFixed(1)} ວິ`; });
  $('#transGrid').addEventListener('click', e => {
    const b = e.target.closest('[data-tr]');
    const c = targetCut();
    if (!b || !c) return;
    const dur = Number($('#transDur').value);
    commit(() => { c.trans = { type: b.dataset.tr, dur }; });
    toast('ໃສ່ທຣານຊິຊັນແລ້ວ ✓', 'ok');
  });
  $('#transAllBtn').addEventListener('click', () => {
    const c = targetCut();
    if (!c || !c.trans) return toast('ເລືອກທຣານຊິຊັນໃຫ້ຈຸດໜຶ່ງກ່ອນ', 'warn');
    const t = { ...c.trans };
    commit(p => { p.tracks.video.forEach((x, i) => { if (i > 0) x.trans = { ...t }; }); });
    toast('ໃຊ້ກັບທຸກຈຸດຕໍ່ແລ້ວ ✓', 'ok');
  });
  $('#transRemoveBtn').addEventListener('click', () => {
    const c = targetCut();
    if (c && c.trans) commit(() => { delete c.trans; });
  });

  // ---------------------------------------------------------------- filters
  let thumbsDone = false;
  function renderFilters() {
    const c = targetClip();
    const cur = c && c.filter ? c.filter.id : 'none';
    $('#filterTarget').innerHTML = c ? `ກຳລັງແກ້: <b>${escapeHtml(clipName(c))}</b>` : '<span class="warn">ເພີ່ມວິດີໂອ ຫຼື ຮູບກ່ອນ</span>';
    $('#filterAmt').value = c && c.filter ? c.filter.amount ?? 1 : 1;
    $('#filterAmtOut').textContent = `${Math.round($('#filterAmt').value * 100)}%`;
    if (!thumbsDone) {
      thumbsDone = true;
      $('#filterGrid').innerHTML = FILTERS.map(f => `<button class="tile" data-filter="${f.id}">
        <span class="tile-art" style="background-image:url(${filterThumb(f)})"></span><small>${f.name}</small></button>`).join('');
    }
    $$('#filterGrid [data-filter]').forEach(b => { b.classList.toggle('active', b.dataset.filter === cur); b.disabled = !c; });
  }
  $('#filterGrid').addEventListener('click', e => {
    const b = e.target.closest('[data-filter]');
    const c = targetClip();
    if (!b || !c) return;
    commit(() => {
      if (b.dataset.filter === 'none') delete c.filter;
      else c.filter = { id: b.dataset.filter, amount: Number($('#filterAmt').value) || 1 };
    });
  });
  let amtFresh = true;
  $('#filterAmt').addEventListener('pointerdown', () => { amtFresh = true; });
  $('#filterAmt').addEventListener('input', e => {
    $('#filterAmtOut').textContent = `${Math.round(e.target.value * 100)}%`;
    const c = targetClip();
    if (!c || !c.filter) return;
    if (amtFresh) { checkpoint(); amtFresh = false; }
    c.filter.amount = Number(e.target.value);
    emit('edit');
  });
  $('#filterAllBtn').addEventListener('click', () => {
    const c = targetClip();
    if (!c) return;
    const f = c.filter ? { ...c.filter } : null;
    commit(p => { for (const x of p.tracks.video) { if (f) x.filter = { ...f }; else delete x.filter; } });
    toast('ໃຊ້ຟິວເຕີກັບທຸກຄລິບແລ້ວ ✓', 'ok');
  });

  // ---------------------------------------------------------------- adjustments
  function renderAdjust() {
    const c = targetClip();
    $('#adjustTarget').innerHTML = c ? `ກຳລັງແກ້: <b>${escapeHtml(clipName(c))}</b>` : '<span class="warn">ເພີ່ມວິດີໂອ ຫຼື ຮູບກ່ອນ</span>';
    const a = { ...ADJUST_DEFAULT, ...(c && c.adj) };
    $('#adjustSliders').innerHTML = ADJUST_FIELDS.map(([k, label]) => {
      const min = k === 'vignette' || k === 'blur' ? 0 : -100;
      return `<label>${label} <output>${a[k]}</output>
        <input type="range" data-adj="${k}" min="${min}" max="100" step="1" value="${a[k]}" ${c ? '' : 'disabled'}></label>`;
    }).join('');
  }
  let adjFresh = true;
  $('#adjustSliders').addEventListener('pointerdown', () => { adjFresh = true; });
  $('#adjustSliders').addEventListener('input', e => {
    const k = e.target.dataset.adj;
    const c = targetClip();
    if (!k || !c) return;
    if (adjFresh) { checkpoint(); adjFresh = false; }
    c.adj = { ...ADJUST_DEFAULT, ...c.adj, [k]: Number(e.target.value) };
    e.target.parentElement.querySelector('output').textContent = e.target.value;
    emit('edit');
  });
  $('#adjustSliders').addEventListener('dblclick', e => {
    // double-click a slider to reset just that value
    const k = e.target.dataset && e.target.dataset.adj;
    const c = targetClip();
    if (k && c) commit(() => { c.adj = { ...ADJUST_DEFAULT, ...c.adj, [k]: 0 }; });
  });
  $('#adjustResetBtn').addEventListener('click', () => { const c = targetClip(); if (c) commit(() => { delete c.adj; }); });
  $('#adjustAllBtn').addEventListener('click', () => {
    const c = targetClip();
    if (!c) return;
    const a = c.adj ? { ...c.adj } : null;
    commit(p => { for (const x of p.tracks.video) { if (a) x.adj = { ...a }; else delete x.adj; } });
    toast('ໃຊ້ການປັບແຕ່ງກັບທຸກຄລິບແລ້ວ ✓', 'ok');
  });

  return {
    // called when the project or selection changes, or a tab opens
    refresh(tab) {
      if (tab === 'stickers') renderBadges();
      if (!tab || tab === 'transitions') renderTransitions();
      if (!tab || tab === 'filters') renderFilters();
      if (!tab || tab === 'adjust') renderAdjust();
    },
    stopPreview,
    addLibraryAudio: (kind, id) => ensureBuiltIn(kind, (kind === 'music' ? MUSIC : SFX).find(x => x.id === id))
  };
}
