// Multi-track timeline: text, subtitles, main video (magnetic) and audio.
// Drag a clip to move it, drag its edges to trim, click the ruler to seek.
import { state, emit, checkpoint, videoLayout, totalDuration, findClip, clipDuration, sortTrack } from './store.js';
import { fmtTime, clamp } from './util.js';

export const TRACKS = [
  { key: 'text', label: 'ຂໍ້ຄວາມ', icon: 'type' },
  { key: 'subs', label: 'ຊັບໄຕເຕິ້ນ', icon: 'cc' },
  { key: 'video', label: 'ວິດີໂອຫຼັກ', icon: 'film' },
  { key: 'audio', label: 'ສຽງ / ເພງ', icon: 'music' }
];

const MIN_LEN = 0.1;

export class Timeline {
  constructor(root, { seek, onDropMedia }) {
    this.root = root;
    this.seek = seek;
    this.onDropMedia = onDropMedia;
    root.innerHTML = `
      <div class="tl-labels">
        <div class="tl-label tl-label-ruler"></div>
        ${TRACKS.map(t => `<div class="tl-label tl-row-${t.key}"><span class="ico"><svg class="i"><use href="#i-${t.icon}"/></svg></span>${t.label}</div>`).join('')}
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
  }

  px(t) { return t * state.zoom; }
  time(px) { return px / state.zoom; }

  clientToTime(clientX) {
    const r = this.inner.getBoundingClientRect();
    return Math.max(0, this.time(clientX - r.left));
  }

  render() {
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
      const bg = m && m.thumb ? `background-image:url(${m.thumb});` : '';
      return mk('video', l.clip, l.start, l.end, `${m ? m.name : '?'} · ${fmtTime(l.end - l.start)}`, bg);
    }).join('') || `<div class="tl-empty">ລາກວິດີໂອ ຫຼື ຮູບ ມາວາງບ່ອນນີ້</div>`;

    // overlapping audio (music + voiceover) stacks into lanes
    const { lane, count } = audioLanes(state.project.tracks.audio);
    const laneH = 30;
    const rowH = `${Math.max(40, count * laneH + 8)}px`;
    this.rows.audio.style.height = rowH;
    this.root.querySelector('.tl-label.tl-row-audio').style.height = rowH;
    this.rows.audio.innerHTML = state.project.tracks.audio.map(c => {
      const m = state.media.get(c.mediaId);
      const pos = count > 1 ? `top:${4 + lane.get(c.id) * laneH}px;bottom:auto;height:${laneH - 4}px;` : '';
      return mk('audio', c, c.start, c.start + clipDuration(c), m ? m.name : '?', pos);
    }).join('');
    this.rows.text.innerHTML = state.project.tracks.text.map(c => mk('text', c, c.start, c.end, c.text)).join('');
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
    for (const k of ['audio', 'text', 'subs']) {
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
        if (mode === 'trimL') c.in = clamp(orig.in + dt, 0, orig.out - MIN_LEN);
        else c.out = clamp(orig.out + dt, orig.in + MIN_LEN, maxSrc);
      } else if (track === 'audio') {
        const len = orig.out - orig.in;
        if (mode === 'move') {
          let s = Math.max(0, orig.start + dt);
          const se = this.snap(s + len, pts) - len;
          s = Math.abs(se - s) < Math.abs(this.snap(s, pts) - s) ? se : this.snap(s, pts);
          c.start = Math.max(0, s);
        } else if (mode === 'trimL') {
          const d = clamp(dt, -orig.in, len - MIN_LEN);
          const ns = this.snap(orig.start + d, pts);
          const dd = clamp(ns - orig.start, -orig.in, len - MIN_LEN);
          c.in = orig.in + dd; c.start = orig.start + dd;
        } else {
          const ne = this.snap(orig.start + len + dt, pts);
          c.out = clamp(orig.in + (ne - orig.start), orig.in + MIN_LEN, maxSrc);
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

// Greedy interval partitioning: each clip goes in the first lane that is free.
function audioLanes(clips) {
  const ends = [];
  const lane = new Map();
  for (const c of [...clips].sort((a, b) => a.start - b.start)) {
    let i = ends.findIndex(e => e <= c.start + 1e-3);
    if (i < 0) i = ends.length;
    ends[i] = c.start + clipDuration(c);
    lane.set(c.id, i);
  }
  return { lane, count: Math.max(1, ends.length) };
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
