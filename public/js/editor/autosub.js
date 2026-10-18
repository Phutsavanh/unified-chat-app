// Automatic subtitles.
//  1. Mix the timeline's audio down to 16 kHz mono with OfflineAudioContext,
//     so timestamps already match the edited timeline (cuts, reorders).
//  2a. Online: send ~10-minute WAV chunks to the server → Whisper (language "lo").
//  2b. Offline: detect speech regions from loudness and either create empty
//      subtitle slots or spread a pasted Lao script across them.
//  3. Split long lines at Lao word boundaries and clean up common Lao encoding issues.
import { state, videoLayout, totalDuration } from './store.js';
import { encodeWav } from './util.js';
import { splitPhrases, graphemeLength, normalizeLao } from './lao.js';

const RATE = 16000;
const CHUNK_SEC = 600;
const decoded = new Map(); // mediaId → AudioBuffer

async function decodeMedia(m, ctx) {
  if (decoded.has(m.id)) return decoded.get(m.id);
  const buf = await m.blob.arrayBuffer();
  const audio = await ctx.decodeAudioData(buf).catch(() => null);
  decoded.set(m.id, audio);
  return audio;
}

export async function mixTimelineAudio({ includeMusic = false, onProgress = () => {} } = {}) {
  const total = totalDuration();
  if (total <= 0) throw new Error('ຍັງບໍ່ມີວິດີໂອໃນ timeline');
  const ctx = new OfflineAudioContext(1, Math.ceil(total * RATE), RATE);
  const jobs = videoLayout()
    .map(l => ({ m: state.media.get(l.clip.mediaId), start: l.start, clip: l.clip }))
    .filter(j => j.m && j.m.type === 'video');
  if (includeMusic) {
    for (const c of state.project.tracks.audio) {
      const m = state.media.get(c.mediaId);
      if (m) jobs.push({ m, start: c.start, clip: c });
    }
  }
  let n = 0;
  let any = false;
  for (const j of jobs) {
    onProgress(`ກຳລັງອ່ານສຽງ: ${j.m.name}`, n++ / jobs.length);
    const buf = await decodeMedia(j.m, ctx);
    if (!buf) continue;
    any = true;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = Math.min(2, j.clip.volume ?? 1) || 0;
    src.connect(g).connect(ctx.destination);
    src.start(j.start, j.clip.in, j.clip.out - j.clip.in);
  }
  if (!any) throw new Error('ບໍ່ພົບສຽງໃນວິດີໂອ (ຫຼື ເບົາເຊີອ່ານໄຟລ໌ນີ້ບໍ່ໄດ້)');
  onProgress('ກຳລັງລວມສຽງ...', 1);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

export async function transcribe(samples, { lang = 'lo', prompt = '', onProgress = () => {} } = {}) {
  const chunks = Math.ceil(samples.length / (CHUNK_SEC * RATE));
  const out = [];
  for (let i = 0; i < chunks; i++) {
    const offset = i * CHUNK_SEC;
    const slice = samples.subarray(i * CHUNK_SEC * RATE, (i + 1) * CHUNK_SEC * RATE);
    onProgress(`ກຳລັງຖອດຄວາມ (Whisper) ສ່ວນທີ ${i + 1}/${chunks}...`, i / chunks);
    const qs = new URLSearchParams({ lang });
    if (prompt) qs.set('prompt', prompt);
    const r = await fetch(`/api/editor/transcribe?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: encodeWav(slice, RATE)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    for (const s of data.segments) {
      // Whisper hallucinates text over silence/music; drop those.
      if (s.noSpeech > 0.75 && s.logprob < -0.8) continue;
      if (!s.text) continue;
      out.push({ start: s.start + offset, end: s.end + offset, text: s.text });
    }
  }
  return out;
}

// Loudness-based voice activity detection. Returns [{ start, end }].
export function detectSpeech(samples, { minGap = 0.35, minLen = 0.3, maxLen = 6 } = {}) {
  const frame = Math.round(RATE * 0.02);
  const n = Math.floor(samples.length / frame);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * frame; j < (i + 1) * frame; j++) s += samples[j] * samples[j];
    rms[i] = Math.sqrt(s / frame);
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.15)] || 0;
  const peak = sorted[Math.floor(n * 0.98)] || 0;
  const thr = Math.max(0.008, floor * 2.5, floor + (peak - floor) * 0.12);

  const regions = [];
  let start = -1, lastLoud = -1;
  for (let i = 0; i < n; i++) {
    const t = i * 0.02;
    if (rms[i] > thr) {
      if (start < 0) start = t;
      lastLoud = t;
    } else if (start >= 0 && t - lastLoud > minGap) {
      regions.push({ start, end: lastLoud + 0.1 });
      start = -1;
    }
  }
  if (start >= 0) regions.push({ start, end: lastLoud + 0.1 });

  const out = [];
  for (const r of regions) {
    if (r.end - r.start < minLen) continue;
    const parts = Math.ceil((r.end - r.start) / maxLen);
    const step = (r.end - r.start) / parts;
    for (let k = 0; k < parts; k++) out.push({ start: r.start + k * step, end: r.start + (k + 1) * step });
  }
  return out;
}

// Spread a script over speech regions in proportion to text length, as if
// the regions were glued together into one continuous stream of speech.
export function alignScript(script, regions, maxChars) {
  const phrases = script.split(/\n+/).flatMap(l => splitPhrases(l, maxChars)).filter(Boolean);
  if (!phrases.length || !regions.length) return [];
  const speech = regions.reduce((s, r) => s + (r.end - r.start), 0);
  const chars = phrases.reduce((s, p) => s + graphemeLength(p), 0);
  const toReal = v => {
    let acc = 0;
    for (const r of regions) {
      const d = r.end - r.start;
      if (v <= acc + d) return r.start + (v - acc);
      acc += d;
    }
    return regions[regions.length - 1].end;
  };
  let pos = 0;
  const out = phrases.map(text => {
    const len = (graphemeLength(text) / chars) * speech;
    const start = toReal(pos + 0.001);
    const end = Math.max(start + 0.4, toReal(pos + len));
    pos += len;
    return { start, end, text };
  });
  // A line change mid-speech looks wrong; move each boundary to a nearby pause.
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i], b = out[i + 1];
    const reach = Math.min(1.5, (b.end - a.start) * 0.25);
    let best = null;
    for (let k = 0; k < regions.length - 1; k++) {
      const gapStart = regions[k].end, gapEnd = regions[k + 1].start;
      const d = Math.abs(gapStart - a.end);
      if (d <= reach && gapStart > a.start + 0.3 && gapEnd < b.end - 0.3 && (!best || d < best.d)) {
        best = { d, gapStart, gapEnd };
      }
    }
    if (best) { a.end = best.gapStart; b.start = best.gapEnd; }
  }
  return out;
}

// Break long segments into readable lines, timing pieces by text length.
export function refineSegments(segs, { maxChars = 38, modernHo = false } = {}) {
  const out = [];
  for (const s of segs) {
    const text = normalizeLao(s.text, { modernHoLetters: modernHo });
    if (!text) continue;
    const pieces = graphemeLength(text) > maxChars ? splitPhrases(text, maxChars) : [text];
    const total = pieces.reduce((a, p) => a + graphemeLength(p), 0);
    let t = s.start;
    for (const p of pieces) {
      const d = (s.end - s.start) * (graphemeLength(p) / total);
      out.push({ start: t, end: t + d, text: p });
      t += d;
    }
  }
  // no overlaps
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].end) out[i - 1].end = out[i].start;
  }
  return out.filter(s => s.end - s.start > 0.05);
}
