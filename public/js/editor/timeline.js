// Multi-track timeline: text, subtitles, main video (magnetic) and audio.
// Drag a clip to move it, drag its edges to trim, click the ruler to seek.
import { state, emit, commit, checkpoint, videoLayout, totalDuration, findClip, clipDuration, sortTrack, trackFlag } from './store.js';
import { fmtTime, clamp } from './util.js';
import { EFFECTS, BADGES, TRANSITIONS } from './library/visual.js';

export const TRACKS = [
  { key: 'effects', label: 'ເອັບເຟັກ', icon: 'sparkles' },
  { key: 'stickers', label: 'ສະຕິກເກີ', icon: 'smile' },
  { key: 'text', label: 'ຂໍ້ຄວາມ', icon: 'type' },
  { key: 'subs', label: 'ຊັບໄຕເຕິ້ນ', icon: 'cc' },
  { key: 'video', label: 'ວິດີໂອຫຼັກ', icon: 'film' },
  { key: 'audio', label: 'ສຽງ / ເພງ', icon: 'music' }
];

const MIN_LEN = 0.1;

export class Timeline {
  constructor(root, { seek, onDropMedia, onTransitionClick }) {
    this.root = root;
    this.seek = seek;
    this.onTransitionClick = onTransitionClick;
    this.onDropMedia = onDropMedia;
    root.innerHTML = `
      <div class="tl-labels">
        <div class="tl-label tl-label-ruler"></div>
        ${TRACKS.map(t => `<div class="tl-label tl-row-${t.key}" data-track="${t.key}">
          <span class="ico"><svg class="i"><use href="#i-${t.icon}"/></svg></span><span class="tl-name">${t.label}</span>
          <span class="tl-ctrls">
            ${t.key === 'audio' ? '' : `<button data-flag="hidden" title="ເຊື່ອງ / ສະແດງ" aria-label="ເຊື່ອງ"><svg class="i"><use href="#i-eye"/></svg></button>`}
            ${t.key === 'video' || t.key === 'audio' ? `<button data-flag="mute" title="ປິດ / ເປີດສຽງ" aria-label="ປິດສຽງ"><svg class="i"><use href="#i-volume"/></svg></button>` : ''}
            <button data-flag="locked" title="ລັອກ / ປົດລັອກ" aria-label="ລັອກ"><svg class="i"><use href="#i-lock"/></svg></button>
          </span></div>`).join('')}
      </div>
      <div class="tl-scroll">
        <div class="tl-inner">
          <div class="tl-ruler"></div>
          ${TRACKS.map(t => `<div class="tl-row tl-row-${t.key}" data-track="${t.key}"></div>`).join('')}
          <div class="tl-playhead"><div class="tl-playhead-knob"></div></div>
        </div>
      </div>`;
    this.scroll = root.querySelector('.tl-scroll');
    this.inner = root.querySelector('.tl-inner');
    this.ruler = root.querySelector('.tl-ruler');
    this.playhead = root.querySelector('.tl-playhead');
    this.rows = Object.fromEntries(TRACKS.map(t => [t.key, root.querySelector(`.tl-row[data-track=${t.key}]`)]));
    this.bind();
    root.querySelector('.tl-labels').addEventListener('click', e => {
      const b = e.target.closest('[data-flag]');
      if (!b) return;
      const track = b.closest('[data-track]').dataset.track;
      const flag = b.dataset.flag;
      commit(p => {
        p.trackState = p.trackState || {};
        p.trackState[track] = { ...p.trackState[track], [flag]: !trackFlag(track, flag) };
      });
    });
  }

  px(t) { return t * state.zoom; }
  time(px) { return px / state.zoom; }

  clientToTime(clientX) {
    const r = this.inner.getBoundingClientRect();
    return Math.max(0, this.time(clientX - r.left));
  }

  render() {
    for (const t of TRACKS) {
      const label = this.root.querySelector(`.tl-label[data-track=${t.key}]`);
      for (const b of label.querySelectorAll('[data-flag]')) b.classList.toggle('on', trackFlag(t.key, b.dataset.flag));
      const off = trackFlag(t.key, 'hidden') || trackFlag(t.key, 'locked');
      this.rows[t.key].classList.toggle('dim', off);
      this.rows[t.key].classList.toggle('locked', trackFlag(t.key, 'locked'));
    }
    const total = totalDuration();
    const width = this.px(total) + Math.max(this.scroll.clientWidth, 600);
    this.inner.style.width = `${width}px`;
    this.renderRuler(width);

    const sel = state.selection;
    const mk = (track, c, start, end, label, extra = '') => {
      const isSel = sel && sel.track === track && sel.id === c.id;
      return `<div class="clip clip-${track}${isSel ? ' selected' : ''}" data-track="${track}" data-id="${c.id}"
        style="left:${this.px(start)}px;width:${Math.max(4, this.px(end - start))}px;${extra}">
        <div class="h l"></div><span class="clip-label">${escapeHtml(label)}</span><div class="h r"></div></div>`;
    };

    this.rows.video.innerHTML = videoLayout().map(l => {
      const m = state.media.get(l.clip.mediaId);
      const w = waveform(m, l.clip.in, l.clip.out, '#9cc3ff');
      const bg = m && m.thumb
        ? (w ? `background-image:url('${w}'), url(${m.thumb});background-size:100% 30%, auto 100%;background-position:center bottom, left center;background-repeat:no-repeat, repeat-x;`
          : `background-image:url(${m.thumb});`)
        : '';
      return mk('video', l.clip, l.start, l.end, `${m ? m.name : '?'} · ${fmtTime(l.end - l.start)}`, bg);
    }).join('') || `<div class="tl-empty">ລາກວິດີໂອ ຫຼື ຮູບ ມາວາງບ່ອນນີ້</div>`;

    // overlapping items (music + voiceover, several stickers...) stack into lanes
    const laned = (key, end, label, style = () => '') => {
      const clips = state.project.tracks[key];
      const { lane, count } = lanes(clips, end);
      const laneH = 26;
      const rowH = `${Math.max(34, count * laneH + 8)}px`;
      this.rows[key].style.height = rowH;
      this.root.querySelector(`.tl-label.tl-row-${key}`).style.height = rowH;
      this.rows[key].innerHTML = clips.map(c => {
        const pos = count > 1 ? `top:${4 + lane.get(c.id) * laneH}px;bottom:auto;height:${laneH - 4}px;` : '';
        return mk(key, c, c.start, end(c), label(c), pos + style(c));
      }).join('');
    };
    laned('audio', c => c.start + clipDuration(c), c => (state.media.get(c.mediaId) || { name: '?' }).name, c => {
      const w = waveform(state.media.get(c.mediaId), c.in, c.out, '#8ff0bf');
      return w ? `background-image:url('${w}'), linear-gradient(180deg, #2a6a4c, #22573f);background-size:100% 70%, auto;background-position:center bottom, 0 0;background-repeat:no-repeat;` : '';
    });
    laned('text', c => c.end, c => c.text);
    laned('effects', c => c.end, c => (EFFECTS.find(e => e.id === c.fx) || {}).name || c.fx);
    laned('stickers', c => c.end, c => (c.kind === 'emoji' ? c.value
      : c.kind === 'badge' ? (BADGES.find(b => b.id === c.value) || {}).name
      : (state.media.get(c.mediaId) || {}).name) || 'ສະຕິກເກີ');
    // transition markers sit on the cut between two main-track clips
    this.rows.video.insertAdjacentHTML('beforeend', videoLayout().map((l, i) => {
      if (!i || !l.clip.trans) return '';
      const name = (TRANSITIONS.find(x => x.id === l.clip.trans.type) || {}).name || '';
      return `<div class="trans-mark" data-id="${l.clip.id}" title="ທຣານຊິຊັນ: ${escapeHtml(name)}" style="left:${this.px(l.start)}px"></div>`;
    }).join(''));
    this.rows.subs.innerHTML = state.project.tracks.subs.map(c => mk('subs', c, c.start, c.end, c.text)).join('');
    this.renderPlayhead();
  }

  renderRuler(width) {
    const z = state.zoom;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const major = steps.find(s => s * z >= 80) || 600;
    const minor = major / (major >= 1 ? 5 : 2);
    let html = '';
    for (let t = 0; this.px(t) < width; t += minor) {
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      html += `<div class="tick${isMajor ? ' major' : ''}" style="left:${this.px(t)}px">${isMajor ? `<span>${fmtTime(t, major < 1 ? 1 : 0)}</span>` : ''}</div>`;
    }
    this.ruler.innerHTML = html;
  }

  renderPlayhead() {
    const x = this.px(state.time);
    this.playhead.style.transform = `translateX(${x}px)`;
    if (state.playing) {
      const { scrollLeft, clientWidth } = this.scroll;
      if (x > scrollLeft + clientWidth - 40 || x < scrollLeft) this.scroll.scrollLeft = x - 80;
    }
  }

  snapPoints(exclude) {
    const pts = [0, state.time];
    for (const l of videoLayout()) pts.push(l.start, l.end);
    for (const k of ['audio', 'text', 'subs', 'stickers', 'effects']) {
      for (const c of state.project.tracks[k]) {
        if (c.id === exclude) continue;
        pts.push(c.start, k === 'audio' ? c.start + clipDuration(c) : c.end);
      }
    }
    return pts;
  }

  snap(t, pts) {
    const thr = 8 / state.zoom;
    let best = t, bd = thr;
    for (const p of pts) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  bind() {
    // seek by clicking/dragging on the ruler or empty track space
    const scrub = e => {
      this.seek(this.clientToTime(e.clientX));
      const move = ev => this.seek(this.clientToTime(ev.clientX));
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    this.ruler.addEventListener('pointerdown', scrub);
    this.playhead.addEventListener('pointerdown', scrub);

    this.inner.addEventListener('pointerdown', e => {
      const mark = e.target.closest('.trans-mark');
      if (mark) {
        state.selection = { track: 'video', id: mark.dataset.id };
        emit('selection');
        if (this.onTransitionClick) this.onTransitionClick();
        return;
      }
      const clipEl = e.target.closest('.clip');
      if (!clipEl) {
        if (e.target.closest('.tl-row')) {
          state.selection = null;
          emit('selection');
          scrub(e);
        }
        return;
      }
      e.preventDefault();
      const track = clipEl.dataset.track;
      const id = clipEl.dataset.id;
      if (trackFlag(track, 'locked')) return;
      state.selection = { track, id };
      emit('selection');
      const mode = e.target.classList.contains('l') ? 'trimL' : e.target.classList.contains('r') ? 'trimR' : 'move';
      this.drag(e, track, id, mode, clipEl);
    });

    // zoom with ctrl/cmd + wheel
    this.scroll.addEventListener('wheel', e => {
      if (!(e.ctrlKey || e.metaKey)) {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          this.scroll.scrollLeft += e.deltaY;
        }
        return;
      }
      e.preventDefault();
      const t = this.clientToTime(e.clientX);
      const before = e.clientX - this.scroll.getBoundingClientRect().left;
      state.zoom = clamp(state.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 4, 400);
      emit('zoom');
      this.scroll.scrollLeft = this.px(t) - before;
    }, { passive: false });

    // drop media from the library
    for (const [key, row] of Object.entries(this.rows)) {
      row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('drop'); });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', e => {
        e.preventDefault();
        row.classList.remove('drop');
        const mediaId = e.dataTransfer.getData('text/x-media-id');
        if (mediaId) this.onDropMedia(mediaId, key, this.clientToTime(e.clientX));
      });
    }
  }

  drag(e, track, id, mode, clipEl) {
    const c = findClip(track, id);
    if (!c) return;
    const x0 = e.clientX;
    const orig = { ...c };
    const media = state.media.get(c.mediaId);
    const maxSrc = media && media.type !== 'image' ? media.duration : Infinity;
    const sp = c.speed || 1;
    const pts = this.snapPoints(id);
    let changed = false;
    const origStart = track === 'video' ? videoLayout().find(l => l.clip.id === id).start : c.start;

    const move = ev => {
      const dt = this.time(ev.clientX - x0);
      if (!changed && Math.abs(ev.clientX - x0) < 3) return;
      if (!changed) { checkpoint(); changed = true; }

      if (track === 'video') {
        if (mode === 'move') {
          clipEl.style.transform = `translateX(${ev.clientX - x0}px)`;
          clipEl.classList.add('dragging');
          return;
        }
        // dt is timeline time; the source moves `speed` times as fast
        if (mode === 'trimL') c.in = clamp(orig.in + dt * sp, 0, orig.out - MIN_LEN * sp);
        else c.out = clamp(orig.out + dt * sp, orig.in + MIN_LEN * sp, maxSrc);
      } else if (track === 'audio') {
        const len = (orig.out - orig.in) / sp;
        if (mode === 'move') {
          let s = Math.max(0, orig.start + dt);
          const se = this.snap(s + len, pts) - len;
          s = Math.abs(se - s) < Math.abs(this.snap(s, pts) - s) ? se : this.snap(s, pts);
          c.start = Math.max(0, s);
        } else if (mode === 'trimL') {
          const d = clamp(dt, -orig.in / sp, len - MIN_LEN);
          const ns = this.snap(orig.start + d, pts);
          const dd = clamp(ns - orig.start, -orig.in / sp, len - MIN_LEN);
          c.in = orig.in + dd * sp; c.start = orig.start + dd;
        } else {
          const ne = this.snap(orig.start + len + dt, pts);
          c.out = clamp(orig.in + (ne - orig.start) * sp, orig.in + MIN_LEN * sp, maxSrc);
        }
      } else {
        const len = orig.end - orig.start;
        if (mode === 'move') {
          let s = Math.max(0, orig.start + dt);
          const sStart = this.snap(s, pts);
          const sEnd = this.snap(s + len, pts) - len;
          s = Math.abs(sStart - s) <= Math.abs(sEnd - s) ? sStart : sEnd;
          c.start = Math.max(0, s); c.end = c.start + len;
        } else if (mode === 'trimL') {
          c.start = clamp(this.snap(orig.start + dt, pts), 0, orig.end - MIN_LEN);
        } else {
          c.end = Math.max(orig.start + MIN_LEN, this.snap(orig.end + dt, pts));
        }
      }
      emit('drag');
    };

    const up = ev => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!changed) {
        // plain click on a clip: move playhead into it if outside
        const start = track === 'video' ? origStart : c.start;
        const end = track === 'video' ? origStart + clipDuration(c) : track === 'audio' ? c.start + clipDuration(c) : c.end;
        if (state.time < start || state.time >= end) this.seek(this.clientToTime(ev.clientX));
        return;
      }
      if (track === 'video' && mode === 'move') {
        const list = state.project.tracks.video;
        const from = list.indexOf(c);
        const center = origStart + clipDuration(c) / 2 + this.time(ev.clientX - x0);
        const others = videoLayout().filter(l => l.clip !== c);
        // compare against clip midpoints as the user sees them on screen
        let to = others.findIndex(l => center < (l.start + l.end) / 2);
        if (to < 0) to = others.length;
        list.splice(from, 1);
        list.splice(to, 0, c);
      }
      if (track !== 'video') sortTrack(track);
      emit('project');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}

// Waveform of a media range as an SVG data URI, cached per range. `peaks`
// holds one max-amplitude value per 1/50 s (computed after import).
const waveCache = new Map();
function waveform(m, from, to, color) {
  if (!m || !m.peaks) return '';
  const key = `${m.id}:${from.toFixed(2)}:${to.toFixed(2)}:${color}`;
  if (waveCache.has(key)) return waveCache.get(key);
  const a = Math.max(0, Math.floor(from * 50)), b = Math.min(m.peaks.length, Math.ceil(to * 50));
  const n = Math.min(240, Math.max(2, b - a));
  let top = '', bottom = '';
  for (let i = 0; i < n; i++) {
    let peak = 0;
    const s = a + Math.floor((i / n) * (b - a)), e = a + Math.floor(((i + 1) / n) * (b - a));
    for (let j = s; j <= e && j < b; j++) peak = Math.max(peak, m.peaks[j]);
    const h = Math.max(1, Math.min(1, peak) * 48);
    top += `${i},${(50 - h).toFixed(1)} `;
    bottom = `${i},${(50 + h).toFixed(1)} ` + bottom;
  }
  // double quotes inside (percent-encoded below) so it can sit in url('...') within a style="" attribute
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n - 1} 100" preserveAspectRatio="none"><polygon points="${top}${bottom}" fill="${color}" fill-opacity=".75"/></svg>`;
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  if (waveCache.size > 400) waveCache.clear();
  waveCache.set(key, url);
  return url;
}

// Greedy interval partitioning: each clip goes in the first lane that is free.
function lanes(clips, end) {
  const ends = [];
  const lane = new Map();
  for (const c of [...clips].sort((a, b) => a.start - b.start)) {
    let i = ends.findIndex(e => e <= c.start + 1e-3);
    if (i < 0) i = ends.length;
    ends[i] = end(c);
    lane.set(c.id, i);
  }
  return { lane, count: Math.max(1, ends.length) };
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
