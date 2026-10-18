export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// 75.4 → "01:15.4"
export function fmtTime(t, decimals = 1) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0')}`;
}

function fmtStamp(t, sep) {
  const ms = Math.round(Math.max(0, t) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
}

export function toSRT(subs) {
  return subs.map((s, i) =>
    `${i + 1}\n${fmtStamp(s.start, ',')} --> ${fmtStamp(s.end, ',')}\n${s.text}\n`
  ).join('\n');
}

export function toVTT(subs) {
  return 'WEBVTT\n\n' + subs.map(s =>
    `${fmtStamp(s.start, '.')} --> ${fmtStamp(s.end, '.')}\n${s.text}\n`
  ).join('\n');
}

function parseStamp(str) {
  const m = str.trim().match(/(?:(\d+):)?(\d+):(\d+)[,.](\d+)/);
  if (!m) return NaN;
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0').slice(0, 3)) / 1000;
}

// Parses both SRT and WebVTT.
export function parseSubtitles(text) {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    const idx = lines.findIndex(l => l.includes('-->'));
    if (idx < 0) continue;
    const [a, b] = lines[idx].split('-->');
    const start = parseStamp(a);
    const end = parseStamp(b);
    if (isNaN(start) || isNaN(end)) continue;
    const body = lines.slice(idx + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (body) out.push({ start, end, text: body });
  }
  return out;
}

// Float32 mono samples → 16-bit PCM WAV blob.
export function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// On claude.ai the page can't start downloads itself; the viewer's `downloads`
// capability asks them to save instead. Elsewhere a plain link click works.
let saver;
export async function download(blob, filename) {
  if (window.claude && window.claude.use) {
    if (saver === undefined) saver = await window.claude.use('downloads');
    if (saver) {
      try {
        await saver.save({ filename, data: blob });
        return true;
      } catch (e) {
        if (e.code === 'declined') return false;
        // .srt/.vtt aren't on the viewer's allowlist; plain text is
        if (e.code === 'rejected_extension' && /\.(srt|vtt)$/.test(filename)) return download(blob, `${filename}.txt`);
        throw new Error(`ບັນທຶກໄຟລ໌ບໍ່ໄດ້ (${e.code || e.message})`);
      }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}

export function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
