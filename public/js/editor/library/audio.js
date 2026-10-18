// Built-in audio library, synthesized in the browser with OfflineAudioContext.
// Nothing is downloaded, so there are no licensing questions and it works
// offline. Each generator returns mono samples; callers turn them into WAV.

const SR = 32000;

// deterministic randomness so a track sounds the same every time
function rng(seed) {
  let a = 0;
  for (const ch of seed) a = (a * 31 + ch.charCodeAt(0)) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noiseBuffer(ctx, seconds = 2) {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  const r = rng('noise');
  for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
  return b;
}

const hz = midi => 440 * Math.pow(2, (midi - 69) / 12);

// ---------------------------------------------------------------- building blocks
function env(ctx, node, t, { a = 0.005, peak = 1, d = 0.3, s = 0, hold = 0, r = 0.05 }) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  if (s > 0) {
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * s), t + a + d);
    g.gain.setValueAtTime(Math.max(0.0001, peak * s), t + a + d + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d + hold + r);
  } else {
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  node.connect(g);
  return g;
}

function osc(ctx, type, f, t, dur) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}

function noise(ctx, nb, t, dur) {
  const s = ctx.createBufferSource();
  s.buffer = nb;
  s.loop = true;
  s.start(t, Math.random() * 0.5);
  s.stop(t + dur + 0.05);
  return s;
}

function filt(ctx, type, f, q = 0.7) {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  return b;
}

// ---------------------------------------------------------------- drums & instruments
const kick = (ctx, out, t, v = 1) => {
  const o = osc(ctx, 'sine', 150, t, 0.4);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  env(ctx, o, t, { a: 0.002, peak: v, d: 0.35 }).connect(out);
};
const snare = (ctx, out, nb, t, v = 0.6) => {
  const n = noise(ctx, nb, t, 0.25);
  const bp = filt(ctx, 'bandpass', 1900, 0.8);
  n.connect(bp);
  env(ctx, bp, t, { a: 0.002, peak: v, d: 0.2 }).connect(out);
  const o = osc(ctx, 'triangle', 190, t, 0.15);
  env(ctx, o, t, { a: 0.002, peak: v * 0.5, d: 0.1 }).connect(out);
};
const clap = (ctx, out, nb, t, v = 0.5) => {
  for (let i = 0; i < 3; i++) {
    const n = noise(ctx, nb, t + i * 0.012, 0.15);
    const bp = filt(ctx, 'bandpass', 1500, 1.2);
    n.connect(bp);
    env(ctx, bp, t + i * 0.012, { a: 0.001, peak: v, d: i === 2 ? 0.15 : 0.02 }).connect(out);
  }
};
const hat = (ctx, out, nb, t, v = 0.2, open = false) => {
  const n = noise(ctx, nb, t, 0.3);
  const hp = filt(ctx, 'highpass', 7500);
  n.connect(hp);
  env(ctx, hp, t, { a: 0.001, peak: v, d: open ? 0.25 : 0.05 }).connect(out);
};
const tom = (ctx, out, t, f = 160, v = 0.6) => {
  const o = osc(ctx, 'sine', f, t, 0.4);
  o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.3);
  env(ctx, o, t, { a: 0.003, peak: v, d: 0.35 }).connect(out);
};
const bass = (ctx, out, t, midi, dur, v = 0.45, type = 'sawtooth') => {
  const o = osc(ctx, type, hz(midi), t, dur);
  const lp = filt(ctx, 'lowpass', 520, 2);
  o.connect(lp);
  env(ctx, lp, t, { a: 0.005, peak: v, d: 0.08, s: 0.6, hold: Math.max(0, dur - 0.14), r: 0.06 }).connect(out);
};
const pad = (ctx, out, t, midis, dur, v = 0.12, cutoff = 1400) => {
  for (const m of midis) {
    for (const det of [-7, 7]) {
      const o = osc(ctx, 'sawtooth', hz(m), t, dur + 0.4);
      o.detune.value = det;
      const lp = filt(ctx, 'lowpass', cutoff);
      o.connect(lp);
      env(ctx, lp, t, { a: Math.min(0.6, dur / 3), peak: v, d: 0.2, s: 0.85, hold: Math.max(0, dur - 0.8), r: 0.4 }).connect(out);
    }
  }
};
const pluck = (ctx, out, t, midi, v = 0.25, type = 'triangle', d = 0.35) => {
  const o = osc(ctx, type, hz(midi), t, d + 0.1);
  const lp = filt(ctx, 'lowpass', 3200);
  o.connect(lp);
  env(ctx, lp, t, { a: 0.003, peak: v, d }).connect(out);
};
const keys = (ctx, out, t, midis, dur, v = 0.12) => {
  for (const m of midis) {
    const o = osc(ctx, 'sine', hz(m), t, dur);
    const o2 = osc(ctx, 'triangle', hz(m) * 2, t, dur);
    const g2 = ctx.createGain();
    g2.gain.value = 0.25;
    o2.connect(g2);
    env(ctx, o, t, { a: 0.01, peak: v, d: dur * 0.9 }).connect(out);
    env(ctx, g2, t, { a: 0.01, peak: v, d: dur * 0.5 }).connect(out);
  }
};
// reedy khene-like voice: stacked square + saw through a nasal band-pass
const reed = (ctx, out, t, midi, dur, v = 0.1) => {
  for (const [type, mult] of [['square', 1], ['sawtooth', 1.002], ['square', 2.001]]) {
    const o = osc(ctx, type, hz(midi) * mult, t, dur + 0.1);
    const bp = filt(ctx, 'bandpass', 1200, 0.9);
    o.connect(bp);
    env(ctx, bp, t, { a: 0.04, peak: v * (mult > 1.5 ? 0.4 : 1), d: 0.1, s: 0.8, hold: Math.max(0, dur - 0.2), r: 0.08 }).connect(out);
  }
};

// ---------------------------------------------------------------- music
// chord = root midi + quality
const CH = {
  maj: [0, 4, 7], min: [0, 3, 7], min7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], dom7: [0, 4, 7, 10], sus2: [0, 2, 7], dom9: [0, 4, 10, 14]
};
const chord = (root, q) => CH[q].map(i => root + i);

export const MUSIC = [
  { id: 'lofi', name: 'Lofi ຜ່ອນຄາຍ', mood: 'ຊິວ · 80 BPM', bpm: 80, bars: 16, prog: [[57, 'min7'], [50, 'min7'], [55, 'dom7'], [48, 'maj7']], style: 'lofi' },
  { id: 'pop', name: 'Pop ສົດໃສ', mood: 'ມ່ວນ · 118 BPM', bpm: 118, bars: 16, prog: [[48, 'maj'], [55, 'maj'], [57, 'min'], [53, 'maj']], style: 'pop' },
  { id: 'funky', name: 'Funky ໂຍກຫົວ', mood: 'ຟັງກີ · 105 BPM', bpm: 105, bars: 16, prog: [[52, 'dom9'], [52, 'dom9'], [57, 'dom9'], [52, 'dom9']], style: 'funky' },
  { id: 'corporate', name: 'ນຳສະເໜີທຸລະກິດ', mood: 'ມືອາຊີບ · 100 BPM', bpm: 100, bars: 16, prog: [[48, 'maj'], [53, 'maj'], [57, 'min'], [55, 'maj']], style: 'corporate' },
  { id: 'cinematic', name: 'ຮູບເງົາ ຍິ່ງໃຫຍ່', mood: 'ອະລັງການ · 70 BPM', bpm: 70, bars: 12, prog: [[50, 'min'], [46, 'maj'], [53, 'maj'], [48, 'maj']], style: 'cinematic' },
  { id: 'edm', name: 'EDM ພະລັງ', mood: 'ເຕັ້ນ · 126 BPM', bpm: 126, bars: 16, prog: [[57, 'min'], [53, 'maj'], [48, 'maj'], [55, 'maj']], style: 'edm' },
  { id: 'khene', name: 'ລາຍແຄນ (ສະໄຕລ໌ລາວ)', mood: 'ພື້ນເມືອງ · 96 BPM', bpm: 96, bars: 16, prog: [[50, 'sus2']], style: 'khene' },
  { id: 'happy', name: 'ອູກູເລເລ ມ່ວນຊື່ນ', mood: 'ສະບາຍໃຈ · 110 BPM', bpm: 110, bars: 16, prog: [[48, 'maj'], [57, 'min'], [53, 'maj'], [55, 'maj']], style: 'happy' },
  { id: 'hiphop', name: 'Hip-hop Boom bap', mood: 'ເທ່ · 90 BPM', bpm: 90, bars: 16, prog: [[50, 'min7'], [46, 'maj7'], [43, 'min7'], [45, 'dom7']], style: 'hiphop' },
  { id: 'ambient', name: 'ບັນຍາກາດ ສະຫງົບ', mood: 'ສະມາທິ · 60 BPM', bpm: 60, bars: 10, prog: [[48, 'maj7'], [45, 'min7'], [53, 'maj7'], [50, 'min7']], style: 'ambient' },
  { id: 'travel', name: 'ທ່ອງທ່ຽວ Vlog', mood: 'ເບີກບານ · 112 BPM', bpm: 112, bars: 16, prog: [[55, 'maj'], [52, 'min'], [48, 'maj'], [50, 'maj']], style: 'pop' },
  { id: 'sad', name: 'ເສົ້າ ຊຶ້ງ', mood: 'ອາລົມ · 72 BPM', bpm: 72, bars: 12, prog: [[57, 'min'], [53, 'maj'], [48, 'maj'], [55, 'maj']], style: 'sad' }
];

const PENTA = [0, 2, 4, 7, 9]; // Lao/Thai music is largely pentatonic

export async function renderMusic(track) {
  const beat = 60 / track.bpm;
  const bar = beat * 4;
  const total = track.bars * bar + 1.5;
  const ctx = new OfflineAudioContext(1, Math.ceil(total * SR), SR);
  const nb = noiseBuffer(ctx);
  const r = rng(track.id);
  const master = ctx.createGain();
  master.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp).connect(ctx.destination);
  const drums = ctx.createGain(); drums.connect(master);
  const music = ctx.createGain(); music.connect(master);
  const st = track.style;

  for (let b = 0; b < track.bars; b++) {
    const t0 = b * bar;
    const [root, q] = track.prog[b % track.prog.length];
    const notes = chord(root, q);
    const intro = b < 2;

    // harmony
    if (st === 'lofi' || st === 'hiphop') keys(ctx, music, t0, notes.map(n => n + 12), bar * 0.95, 0.07);
    if (['pop', 'corporate', 'edm', 'cinematic', 'ambient', 'sad'].includes(st)) {
      pad(ctx, music, t0, notes.map(n => n + 12), bar, st === 'cinematic' ? 0.11 : 0.07, st === 'edm' ? 2400 : 1300);
    }
    if (st === 'happy') {
      for (let k = 0; k < 8; k++) {
        const strum = notes.map((n, i) => n + 12 + (i === 0 ? 12 : 0));
        strum.forEach((n, i) => pluck(ctx, music, t0 + k * beat / 2 + i * 0.012, n, k % 2 ? 0.07 : 0.11, 'triangle', 0.3));
      }
    }
    if (st === 'khene') {
      // drone on the tonic and fifth, like the khene's sounding pipes
      reed(ctx, music, t0, root, bar, 0.05);
      reed(ctx, music, t0, root + 7, bar, 0.035);
    }

    // bass
    if (st !== 'ambient' && st !== 'cinematic' && !intro) {
      if (st === 'funky') {
        [0, 0.75, 1.5, 2, 2.75, 3.5].forEach((p, i) => bass(ctx, music, t0 + p * beat, root - 12 + (i === 3 ? 12 : 0), beat * 0.3, 0.5, 'square'));
      } else if (st === 'edm') {
        for (let k = 0; k < 8; k++) bass(ctx, music, t0 + k * beat / 2 + beat / 4, root - 12, beat * 0.22, 0.45);
      } else {
        bass(ctx, music, t0, root - 12, beat * 1.8, 0.45, st === 'lofi' ? 'triangle' : 'sawtooth');
        bass(ctx, music, t0 + beat * 2, root - 12 + (b % 2 ? 7 : 0), beat * 1.8, 0.4, st === 'lofi' ? 'triangle' : 'sawtooth');
      }
    }

    // melody
    if (['pop', 'corporate', 'edm', 'khene', 'lofi', 'sad'].includes(st) && b >= 4) {
      const scaleRoot = track.prog[0][0] + 12;
      const steps = st === 'lofi' || st === 'sad' ? 4 : 8;
      for (let k = 0; k < steps; k++) {
        if (r() < (st === 'khene' ? 0.25 : 0.35)) continue;
        const deg = PENTA[Math.floor(r() * PENTA.length)] + (r() < 0.3 ? 12 : 0);
        const tt = t0 + k * (bar / steps);
        if (st === 'khene') reed(ctx, music, tt, scaleRoot + deg, bar / steps * 0.9, 0.06);
        else pluck(ctx, music, tt, scaleRoot + deg, st === 'edm' ? 0.12 : 0.16, st === 'edm' ? 'sawtooth' : 'triangle', st === 'sad' ? 0.8 : 0.3);
      }
    }

    // drums
    if (intro && st !== 'khene') continue;
    for (let k = 0; k < 16; k++) {
      const t = t0 + k * beat / 4 + (st === 'lofi' && k % 2 ? beat * 0.06 : 0); // lofi swing
      const beatPos = k / 4;
      switch (st) {
        case 'pop': case 'edm':
          if (k % 4 === 0) kick(ctx, drums, t, 0.9);
          if (k === 4 || k === 12) clap(ctx, drums, nb, t, 0.45);
          if (k % 2 === 1) hat(ctx, drums, nb, t, st === 'edm' ? 0.2 : 0.12, st === 'edm');
          break;
        case 'corporate': case 'happy':
          if (k === 0 || k === 8 || k === 10) kick(ctx, drums, t, 0.7);
          if (k === 4 || k === 12) snare(ctx, drums, nb, t, 0.35);
          if (k % 2 === 0) hat(ctx, drums, nb, t, 0.08);
          break;
        case 'funky':
          if (k === 0 || k === 6 || k === 10) kick(ctx, drums, t, 0.85);
          if (k === 4 || k === 12) snare(ctx, drums, nb, t, 0.5);
          hat(ctx, drums, nb, t, k % 2 ? 0.07 : 0.12);
          break;
        case 'lofi': case 'hiphop':
          if (k === 0 || k === 7 || k === 10) kick(ctx, drums, t, 0.8);
          if (k === 4 || k === 12) snare(ctx, drums, nb, t, st === 'lofi' ? 0.3 : 0.5);
          if (k % 2 === 0) hat(ctx, drums, nb, t, 0.07);
          break;
        case 'khene':
          // hand-drum feel: low tom on the beat, high tom off-beat
          if (k % 4 === 0) tom(ctx, drums, t, 110, 0.45);
          if (k % 4 === 2) tom(ctx, drums, t, 220, 0.25);
          if (k % 8 === 6) hat(ctx, drums, nb, t, 0.1, true);
          break;
        case 'cinematic':
          if (k === 0 && b % 2 === 0) { kick(ctx, drums, t, 1); tom(ctx, drums, t, 70, 0.8); }
          if (b % 4 === 3 && k >= 8 && k % 2 === 0) tom(ctx, drums, t, 90 + k * 6, 0.5);
          break;
        case 'sad':
          if (beatPos === 0) kick(ctx, drums, t, 0.5);
          if (k === 8) snare(ctx, drums, nb, t, 0.2);
          break;
      }
    }
  }

  if (st === 'lofi') {
    // vinyl crackle
    const n = noise(ctx, nb, 0, total);
    const hp = filt(ctx, 'highpass', 3000);
    const g = ctx.createGain();
    g.gain.value = 0.012;
    n.connect(hp).connect(g).connect(master);
  }
  const buf = await ctx.startRendering();
  return buf.getChannelData(0);
}

// ---------------------------------------------------------------- sound effects
const S = (id, name, cat, dur, build) => ({ id, name, cat, dur, build });

export const SFX = [
  S('whoosh', 'Whoosh ລົມພັດ', 'transition', 0.9, (c, o, nb) => {
    const n = noise(c, nb, 0, 0.9); const bp = filt(c, 'bandpass', 300, 1.2);
    bp.frequency.exponentialRampToValueAtTime(3000, 0.45); bp.frequency.exponentialRampToValueAtTime(500, 0.9);
    n.connect(bp); env(c, bp, 0, { a: 0.4, peak: 0.9, d: 0.5 }).connect(o);
  }),
  S('swoosh', 'Swoosh ສັ້ນ', 'transition', 0.4, (c, o, nb) => {
    const n = noise(c, nb, 0, 0.4); const hp = filt(c, 'bandpass', 800, 0.8);
    hp.frequency.exponentialRampToValueAtTime(6000, 0.3); n.connect(hp);
    env(c, hp, 0, { a: 0.12, peak: 0.8, d: 0.26 }).connect(o);
  }),
  S('riser', 'Riser ລຸ້ນຂຶ້ນ', 'transition', 2.6, (c, o, nb) => {
    const n = noise(c, nb, 0, 2.6); const lp = filt(c, 'lowpass', 400, 4);
    lp.frequency.exponentialRampToValueAtTime(9000, 2.5); n.connect(lp);
    const g = c.createGain(); g.gain.setValueAtTime(0.01, 0); g.gain.exponentialRampToValueAtTime(0.7, 2.5); g.gain.linearRampToValueAtTime(0, 2.6);
    lp.connect(g).connect(o);
    const s = osc(c, 'sawtooth', 200, 0, 2.6); s.frequency.exponentialRampToValueAtTime(1600, 2.5);
    const g2 = c.createGain(); g2.gain.setValueAtTime(0.001, 0); g2.gain.exponentialRampToValueAtTime(0.15, 2.5); g2.gain.linearRampToValueAtTime(0, 2.6);
    s.connect(g2).connect(o);
  }),
  S('downlifter', 'Downlifter ລົງ', 'transition', 2, (c, o, nb) => {
    const n = noise(c, nb, 0, 2); const lp = filt(c, 'lowpass', 8000, 3);
    lp.frequency.exponentialRampToValueAtTime(200, 2); n.connect(lp);
    env(c, lp, 0, { a: 0.01, peak: 0.6, d: 1.95 }).connect(o);
  }),
  S('boom', 'Boom ກະແທກ', 'impact', 1.8, (c, o, nb) => {
    const s = osc(c, 'sine', 90, 0, 1.8); s.frequency.exponentialRampToValueAtTime(32, 1.5);
    env(c, s, 0, { a: 0.003, peak: 1, d: 1.7 }).connect(o);
    const n = noise(c, nb, 0, 0.5); const lp = filt(c, 'lowpass', 900); n.connect(lp);
    env(c, lp, 0, { a: 0.002, peak: 0.6, d: 0.4 }).connect(o);
  }),
  S('drop', 'Bass drop', 'impact', 1.4, (c, o) => {
    const s = osc(c, 'sawtooth', 140, 0, 1.4); s.frequency.exponentialRampToValueAtTime(30, 1.3);
    const lp = filt(c, 'lowpass', 400); s.connect(lp);
    env(c, lp, 0, { a: 0.005, peak: 0.9, d: 1.35 }).connect(o);
  }),
  S('hit', 'Cinematic hit', 'impact', 2.2, (c, o, nb) => {
    kick(c, o, 0, 1); tom(c, o, 0, 60, 0.9);
    const n = noise(c, nb, 0, 2.2); const bp = filt(c, 'bandpass', 2500, 0.5); n.connect(bp);
    env(c, bp, 0, { a: 0.002, peak: 0.35, d: 2 }).connect(o);
  }),
  S('pop', 'Pop ປ໊ອບ', 'ui', 0.15, (c, o) => {
    const s = osc(c, 'sine', 700, 0, 0.12); s.frequency.exponentialRampToValueAtTime(180, 0.08);
    env(c, s, 0, { a: 0.002, peak: 0.9, d: 0.1 }).connect(o);
  }),
  S('click', 'Click ຄລິກ', 'ui', 0.06, (c, o, nb) => {
    const n = noise(c, nb, 0, 0.03); const hp = filt(c, 'highpass', 3000); n.connect(hp);
    env(c, hp, 0, { a: 0.001, peak: 0.8, d: 0.02 }).connect(o);
  }),
  S('ding', 'Ding ແຈ້ງເຕືອນ', 'ui', 1.6, (c, o) => {
    for (const [f, v] of [[1320, 0.5], [2640, 0.15], [3960, 0.06]]) env(c, osc(c, 'sine', f, 0, 1.6), 0, { a: 0.002, peak: v, d: 1.55 }).connect(o);
  }),
  S('notify', 'ແຈ້ງເຕືອນ 2 ໂນດ', 'ui', 0.9, (c, o) => {
    env(c, osc(c, 'sine', 880, 0, 0.3), 0, { a: 0.003, peak: 0.5, d: 0.28 }).connect(o);
    env(c, osc(c, 'sine', 1320, 0.15, 0.7), 0.15, { a: 0.003, peak: 0.5, d: 0.7 }).connect(o);
  }),
  S('coin', 'ຫຼຽນ / ໄດ້ຄະແນນ', 'ui', 0.5, (c, o) => {
    env(c, osc(c, 'square', 988, 0, 0.08), 0, { a: 0.002, peak: 0.25, d: 0.07 }).connect(o);
    env(c, osc(c, 'square', 1319, 0.08, 0.4), 0.08, { a: 0.002, peak: 0.25, d: 0.4 }).connect(o);
  }),
  S('error', 'ຜິດພາດ ບື້', 'ui', 0.5, (c, o) => {
    for (const t of [0, 0.22]) env(c, osc(c, 'square', 110, t, 0.18), t, { a: 0.005, peak: 0.3, d: 0.17 }).connect(o);
  }),
  S('swipe', 'Swipe ປັດຂຶ້ນ', 'ui', 0.3, (c, o) => {
    const s = osc(c, 'sine', 300, 0, 0.3); s.frequency.exponentialRampToValueAtTime(1500, 0.25);
    env(c, s, 0, { a: 0.01, peak: 0.5, d: 0.27 }).connect(o);
  }),
  S('tada', 'Ta-da! ສຳເລັດ', 'fun', 1.6, (c, o) => {
    const play = (t, d, v) => [60, 64, 67, 72].forEach(m => {
      const s = osc(c, 'sawtooth', hz(m + 12), t, d); const lp = filt(c, 'lowpass', 2500); s.connect(lp);
      env(c, lp, t, { a: 0.01, peak: v, d: 0.1, s: 0.7, hold: d - 0.2, r: 0.1 }).connect(o);
    });
    play(0, 0.15, 0.08); play(0.18, 1.3, 0.09);
  }),
  S('sparkle', 'ເວດມົນ ປະກາຍ', 'fun', 1.4, (c, o) => {
    const r = rng('sparkle');
    for (let i = 0; i < 18; i++) { const t = i * 0.06 + r() * 0.03; env(c, osc(c, 'sine', 2000 + r() * 3000, t, 0.3), t, { a: 0.002, peak: 0.12, d: 0.28 }).connect(o); }
  }),
  S('bubble', 'ຟອງນ້ຳ', 'fun', 0.6, (c, o) => {
    for (const t of [0, 0.15, 0.32]) {
      const s = osc(c, 'sine', 300, t, 0.12); s.frequency.exponentialRampToValueAtTime(1100, t + 0.1);
      env(c, s, t, { a: 0.005, peak: 0.4, d: 0.1 }).connect(o);
    }
  }),
  S('laser', 'Laser ເລເຊີ', 'fun', 0.35, (c, o) => {
    const s = osc(c, 'sawtooth', 1600, 0, 0.35); s.frequency.exponentialRampToValueAtTime(90, 0.3);
    env(c, s, 0, { a: 0.003, peak: 0.25, d: 0.32 }).connect(o);
  }),
  S('glitch', 'Glitch ສັນຍານຂັດ', 'fun', 0.7, (c, o) => {
    const r = rng('glitch');
    for (let t = 0; t < 0.65; t += 0.04) if (r() > 0.3) env(c, osc(c, 'square', 100 + r() * 2000, t, 0.03), t, { a: 0.001, peak: 0.18, d: 0.03 }).connect(o);
  }),
  S('shutter', 'ຊັດເຕີກ້ອງ', 'real', 0.25, (c, o, nb) => {
    for (const t of [0, 0.07]) { const n = noise(c, nb, t, 0.05); const bp = filt(c, 'bandpass', 3500, 1.5); n.connect(bp); env(c, bp, t, { a: 0.001, peak: 0.9, d: 0.04 }).connect(o); }
  }),
  S('typing', 'ພິມດີດ', 'real', 2.2, (c, o, nb) => {
    const r = rng('typing');
    for (let t = 0; t < 1.8; t += 0.09 + r() * 0.07) { const n = noise(c, nb, t, 0.02); const bp = filt(c, 'bandpass', 2500 + r() * 1500, 2); n.connect(bp); env(c, bp, t, { a: 0.001, peak: 0.6, d: 0.02 }).connect(o); }
    env(c, osc(c, 'sine', 2600, 1.9, 0.3), 1.9, { a: 0.002, peak: 0.3, d: 0.3 }).connect(o);
  }),
  S('heartbeat', 'ຫົວໃຈເຕັ້ນ', 'real', 2, (c, o) => {
    for (const t of [0, 0.25, 1, 1.25]) tom(c, o, t, 60, t % 1 ? 0.6 : 0.9);
  }),
  S('drumroll', 'ລົວກອງ', 'real', 2.6, (c, o, nb) => {
    let t = 0, gap = 0.12;
    while (t < 2) { snare(c, o, nb, t, 0.15 + t * 0.12); t += gap; gap = Math.max(0.035, gap * 0.93); }
    const n = noise(c, nb, 2.05, 0.6); const hp = filt(c, 'highpass', 4000); n.connect(hp);
    env(c, hp, 2.05, { a: 0.002, peak: 0.5, d: 0.5 }).connect(o); kick(c, o, 2.05, 0.9);
  }),
  S('applause', 'ຕົບມື', 'real', 3, (c, o, nb) => {
    const r = rng('applause');
    for (let i = 0; i < 90; i++) { const t = r() * 2.6; clap(c, o, nb, t, 0.08 + r() * 0.08); }
  }),
  S('countdown', 'ນັບຖອຍຫຼັງ 3-2-1', 'real', 3.4, (c, o) => {
    for (const t of [0, 1, 2]) env(c, osc(c, 'sine', 660, t, 0.2), t, { a: 0.003, peak: 0.4, d: 0.18 }).connect(o);
    env(c, osc(c, 'sine', 1320, 3, 0.4), 3, { a: 0.003, peak: 0.45, d: 0.38 }).connect(o);
  }),
  S('gong', 'ຄ້ອງ (ສຽງວັດ)', 'real', 4, (c, o) => {
    // inharmonic partials give a temple-gong colour
    for (const [f, v, d] of [[110, 0.5, 3.9], [174, 0.3, 3.2], [231, 0.22, 2.6], [297, 0.15, 2], [389, 0.08, 1.5]]) {
      env(c, osc(c, 'sine', f, 0, d), 0, { a: 0.01, peak: v, d }).connect(o);
    }
  })
];

export const SFX_CATS = [
  ['all', 'ທັງໝົດ'], ['transition', 'ປ່ຽນສາກ'], ['impact', 'ກະແທກ'], ['ui', 'ແຈ້ງເຕືອນ'], ['fun', 'ມ່ວນໆ'], ['real', 'ສຽງຈິງ']
];

export async function renderSfx(fx) {
  const ctx = new OfflineAudioContext(1, Math.ceil((fx.dur + 0.1) * SR), SR);
  const out = ctx.createGain();
  out.gain.value = 0.9;
  out.connect(ctx.destination);
  fx.build(ctx, out, noiseBuffer(ctx, 3));
  const buf = await ctx.startRendering();
  return buf.getChannelData(0);
}

export const SAMPLE_RATE = SR;
