// Preview engine: one hidden <video>/<audio> element per media file, kept in
// sync with the timeline clock and composited onto a canvas together with
// text overlays and subtitles. The same canvas is recorded for export.
import { state, ASPECTS, videoLayout, totalDuration, emit, subDisplay } from './store.js';
import { wrapText, graphemes, toLaoDigits } from './lao.js';
import { hexToRgba } from './util.js';

export class Player {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.els = new Map();      // mediaId → element
    this.gains = new Map();    // mediaId → GainNode
    this.audioCtx = null;
    this.recordDest = null;
    this.hitBoxes = [];        // [{ track, id, box }] from the last frame
    this.clockStart = 0;
    this.timeAtStart = 0;
    this.onEnded = null;
    this.endAt = null;
    this.resize();
    const loop = () => { this.tick(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  resize(scale = 1) {
    const [w, h] = ASPECTS[state.project.aspect] || ASPECTS['16:9'];
    // assigning width clears the canvas, so only touch it when it changes
    const W = Math.round(w * scale), H = Math.round(h * scale);
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
  }

  element(media) {
    let el = this.els.get(media.id);
    if (el) return el;
    if (media.type === 'image') {
      el = new Image();
      el.src = media.url;
    } else {
      el = document.createElement(media.type === 'audio' ? 'audio' : 'video');
      el.src = media.url;
      el.preload = 'auto';
      el.playsInline = true;
      el.crossOrigin = 'anonymous';
      if (this.audioCtx) this.connect(media.id, el);
    }
    this.els.set(media.id, el);
    return el;
  }

  forget(mediaId) {
    const el = this.els.get(mediaId);
    if (el && el.pause) el.pause();
    this.els.delete(mediaId);
    this.gains.delete(mediaId);
  }

  // Audio goes through Web Audio so clip volume can exceed 100% and the mix
  // can be captured during export. Must be created from a user gesture.
  ensureAudio() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.audioCtx.createGain();
      this.master.connect(this.audioCtx.destination);
      this.recordDest = this.audioCtx.createMediaStreamDestination();
      this.master.connect(this.recordDest);
      for (const [id, el] of this.els) if (el instanceof HTMLMediaElement) this.connect(id, el);
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
  }

  connect(id, el) {
    if (this.gains.has(id)) return;
    try {
      const src = this.audioCtx.createMediaElementSource(el);
      const g = this.audioCtx.createGain();
      src.connect(g).connect(this.master);
      this.gains.set(id, g);
    } catch (e) { /* already connected */ }
  }

  setVolume(id, el, v) {
    const g = this.gains.get(id);
    if (g) { g.gain.value = v; el.volume = 1; } else el.volume = Math.min(1, v);
  }

  play() {
    this.ensureAudio();
    if (state.time >= totalDuration() - 0.05) state.time = 0;
    state.playing = true;
    this.clockStart = performance.now();
    this.timeAtStart = state.time;
    emit('play');
  }

  pause() {
    state.playing = false;
    for (const el of this.els.values()) if (el.pause) el.pause();
    emit('play');
  }

  toggle() { state.playing ? this.pause() : this.play(); }

  seek(t) {
    state.time = Math.max(0, Math.min(t, Math.max(totalDuration(), 0)));
    if (state.playing) { this.clockStart = performance.now(); this.timeAtStart = state.time; }
    emit('time');
  }

  tick() {
    const total = totalDuration();
    if (state.playing) {
      state.time = this.timeAtStart + (performance.now() - this.clockStart) / 1000;
      const stopAt = this.endAt ?? total;
      if (state.time >= stopAt) {
        state.time = stopAt;
        this.pause();
        if (this.onEnded) this.onEnded();
      }
      emit('time');
    }
    this.sync();
    this.draw(state.time);
  }

  sync() {
    const t = state.time;
    const active = new Set();
    const play = (mediaId, el, srcTime, vol) => {
      active.add(mediaId);
      if (!(el instanceof HTMLMediaElement) || el.readyState === 0) return;
      this.setVolume(mediaId, el, vol);
      if (state.playing) {
        if (Math.abs(el.currentTime - srcTime) > 0.3) el.currentTime = srcTime;
        if (el.paused) el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        if (!el.seeking && Math.abs(el.currentTime - srcTime) > 0.02) el.currentTime = srcTime;
      }
    };

    for (const l of videoLayout()) {
      if (t >= l.start && t < l.end) {
        const m = state.media.get(l.clip.mediaId);
        if (m && m.type === 'video') play(m.id, this.element(m), l.clip.in + (t - l.start), l.clip.volume ?? 1);
        break;
      }
    }
    for (const c of state.project.tracks.audio) {
      const d = c.out - c.in;
      // load upcoming clips early (voiceover lines are many short files)
      if (state.playing && c.start > t && c.start - t < 1.5) {
        const m = state.media.get(c.mediaId);
        if (m) this.element(m);
      }
      if (t >= c.start && t < c.start + d) {
        const m = state.media.get(c.mediaId);
        if (m) play(m.id, this.element(m), c.in + (t - c.start), c.volume ?? 1);
      }
    }
    for (const [id, el] of this.els) {
      if (!active.has(id) && el.pause && !el.paused) el.pause();
    }
  }

  draw(t) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    this.hitBoxes = [];

    const cur = videoLayout().find(l => t >= l.start && t < l.end);
    if (cur) {
      const m = state.media.get(cur.clip.mediaId);
      if (m) {
        const el = this.element(m);
        const ready = m.type === 'image' ? el.complete && el.naturalWidth : el.readyState >= 2;
        if (ready) this.drawMedia(el, m, cur.clip, W, H);
      }
    }

    for (const c of state.project.tracks.text) {
      if (t >= c.start && t < c.end) {
        const box = this.drawText(c.text, c.style, t - c.start, c.end - c.start, W, H);
        if (box) this.hitBoxes.push({ track: 'text', id: c.id, box });
      }
    }
    const ss = state.project.subStyle;
    for (const s of state.project.tracks.subs) {
      if (t >= s.start && t < s.end) {
        const text = ss.laoDigits ? toLaoDigits(subDisplay(s)) : subDisplay(s);
        const box = this.drawText(text, ss, t - s.start, s.end - s.start, W, H);
        if (box) this.hitBoxes.push({ track: 'subs', id: s.id, box });
      }
    }

    const sel = state.selection;
    if (sel && !this.exporting) {
      const hb = this.hitBoxes.find(h => h.track === sel.track && h.id === sel.id);
      if (hb) {
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = Math.max(2, W / 600);
        ctx.setLineDash([8, 6]);
        ctx.strokeRect(hb.box.x, hb.box.y, hb.box.w, hb.box.h);
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  drawMedia(el, m, clip, W, H) {
    const { ctx } = this;
    const sw = m.type === 'image' ? el.naturalWidth : el.videoWidth;
    const sh = m.type === 'image' ? el.naturalHeight : el.videoHeight;
    if (!sw || !sh) return;
    const contain = Math.min(W / sw, H / sh);
    const cover = Math.max(W / sw, H / sh);
    if ((clip.fit || 'contain') === 'contain' && clip.bg === 'blur' && 'filter' in ctx) {
      ctx.save();
      ctx.filter = `blur(${Math.round(W / 40)}px) brightness(0.7)`;
      const dw = sw * cover * 1.1, dh = sh * cover * 1.1;
      ctx.drawImage(el, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.restore();
    }
    const k = (clip.fit === 'cover') ? cover : contain;
    const dw = sw * k, dh = sh * k;
    ctx.drawImage(el, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  // Draws a wrapped, Lao-aware text block. Returns its bounding box.
  drawText(text, st, local, dur, W, H) {
    if (!text || !text.trim()) return null;
    const { ctx } = this;
    const unit = Math.min(W, H) / 720;
    const px = st.size * unit;
    let alpha = 1, scale = 1, shown = text;
    if (st.anim === 'fade') alpha = Math.min(1, local / 0.3, (dur - local) / 0.3);
    if (st.anim === 'pop') {
      const p = Math.min(1, local / 0.25);
      scale = 0.5 + 0.5 * p + 0.15 * Math.sin(p * Math.PI); // overshoot, lands on 1
      alpha = Math.min(1, local / 0.12);
    }
    if (st.anim === 'type') {
      const g = graphemes(text);
      shown = g.slice(0, Math.ceil(g.length * Math.min(1, local / Math.max(0.3, dur * 0.6)))).join('');
    }

    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = `${st.bold ? 700 : 400} ${px}px "${st.font}", "Noto Sans Lao", "Noto Sans Thai", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const maxW = W * 0.88;
    // wrap the full text so lines don't jump while typing
    const fullLines = wrapText(ctx, text, maxW);
    let lines = fullLines;
    if (shown !== text) {
      lines = [];
      let left = shown.length;
      for (const l of fullLines) {
        if (left <= 0) break;
        lines.push(l.slice(0, left));
        left -= l.length + 1;
      }
    }
    // Lao vowels and tone marks stack above and below; give lines room.
    const lh = px * 1.6;
    const widths = fullLines.map(l => ctx.measureText(l).width);
    const bw = Math.max(...widths) + px * 0.8;
    const bh = fullLines.length * lh + px * 0.3;
    const cx = st.x * W, cy = st.y * H;
    const box = { x: cx - (bw * scale) / 2, y: cy - (bh * scale) / 2, w: bw * scale, h: bh * scale };

    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    if (st.bg) {
      ctx.fillStyle = hexToRgba(st.bgColor || '#000000', st.bgOpacity ?? 0.6);
      roundRect(ctx, -bw / 2, -bh / 2, bw, bh, px * 0.25);
      ctx.fill();
    }
    const y0 = -((fullLines.length - 1) * lh) / 2;
    lines.forEach((line, i) => {
      const y = y0 + i * lh;
      if (st.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = px * 0.15;
        ctx.shadowOffsetY = px * 0.05;
      }
      if (st.strokeWidth > 0) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = st.strokeWidth * unit * 2;
        ctx.strokeStyle = st.stroke;
        ctx.strokeText(line, 0, y);
        ctx.shadowColor = 'transparent';
      }
      ctx.fillStyle = st.color;
      ctx.fillText(line, 0, y);
    });
    ctx.restore();
    return box;
  }

  hitTest(x, y) {
    for (let i = this.hitBoxes.length - 1; i >= 0; i--) {
      const { box } = this.hitBoxes[i];
      if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return this.hitBoxes[i];
    }
    return null;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
