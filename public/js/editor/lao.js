// Lao text helpers. Lao is written without spaces between words, so line
// wrapping and subtitle splitting must use a dictionary-based word segmenter
// (Intl.Segmenter) rather than splitting on spaces. Combining vowels and tone
// marks sit above/below the consonant, so "characters" are grapheme clusters.

const hasSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
const wordSeg = hasSegmenter ? new Intl.Segmenter('lo', { granularity: 'word' }) : null;
const graphemeSeg = hasSegmenter ? new Intl.Segmenter('lo', { granularity: 'grapheme' }) : null;

export const LAO_FONTS = [
  { family: 'Noto Sans Lao', label: 'Noto Sans Lao (ທັນສະໄໝ)' },
  { family: 'Noto Sans Lao Looped', label: 'Noto Sans Lao Looped (ມີຫົວ)' },
  { family: 'Noto Serif Lao', label: 'Noto Serif Lao (ທາງການ)' },
  { family: 'Phetsarath', label: 'Phetsarath (ເພັດສະລາດ)' }
];

export function graphemes(text) {
  if (!graphemeSeg) return Array.from(text);
  return Array.from(graphemeSeg.segment(text), s => s.segment);
}

export function graphemeLength(text) {
  return graphemes(text).length;
}

// Word-ish tokens, spaces kept as their own tokens so text can be rebuilt.
export function words(text) {
  if (!wordSeg) return text.split(/(\s+)/).filter(Boolean);
  return Array.from(wordSeg.segment(text), s => s.segment);
}

// Greedy wrap by measured width. Falls back to grapheme breaks for a single
// token wider than the line (long English words, URLs).
export function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const tok of words(para)) {
      const candidate = line + tok;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = tok.trimStart();
      if (ctx.measureText(line).width > maxWidth) {
        let part = '';
        for (const g of graphemes(line)) {
          if (part && ctx.measureText(part + g).width > maxWidth) {
            lines.push(part);
            part = g;
          } else {
            part += g;
          }
        }
        line = part;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

// Split text into chunks of at most ~maxChars graphemes, breaking only at word
// boundaries and preferring spaces/punctuation (Lao uses a space where English
// would use a comma or full stop).
export function splitPhrases(text, maxChars) {
  const toks = words(normalizeSpaces(text));
  const out = [];
  let cur = '';
  let curLen = 0;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const len = graphemeLength(tok);
    const isBreak = /^\s+$/.test(tok) || /^[.,!?;:…ໆ।]+$/.test(tok);
    if (curLen + len > maxChars && cur.trim()) {
      // look back for a soft break inside the current chunk
      const lastSpace = cur.lastIndexOf(' ');
      if (lastSpace > cur.length * 0.5) {
        out.push(cur.slice(0, lastSpace).trim());
        cur = cur.slice(lastSpace + 1);
        curLen = graphemeLength(cur);
      } else {
        out.push(cur.trim());
        cur = '';
        curLen = 0;
      }
    }
    if (isBreak && !cur.trim()) continue;
    cur += tok;
    curLen += len;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function normalizeSpaces(text) {
  return String(text).replace(/[​‌‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

// Common encoding problems in Lao text from speech-to-text and old fonts.
export function normalizeLao(text, { modernHoLetters = false } = {}) {
  let s = normalizeSpaces(text)
    .replace(/ໍາ/g, 'ຳ') // ໍ + າ  → ຳ (sara am typed as two marks)
    .replace(/າໍ/g, 'ຳ');
  if (modernHoLetters) {
    s = s.replace(/ຫນ/g, 'ໜ') // ຫນ → ໜ
      .replace(/ຫມ/g, 'ໝ');   // ຫມ → ໝ
  }
  return s;
}

export function toLaoDigits(text) {
  return String(text).replace(/[0-9]/g, d => String.fromCharCode(0x0ED0 + Number(d)));
}

export function toArabicDigits(text) {
  return String(text).replace(/[໐-໙]/g, d => String(d.charCodeAt(0) - 0x0ED0));
}

export function hasThaiScript(text) {
  return /[ก-๛]/.test(text);
}

// Split text at a word boundary closest to the given fraction (0..1).
export function splitAtFraction(text, frac) {
  const toks = words(text);
  const total = graphemeLength(text);
  let acc = 0;
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < toks.length; i++) {
    acc += graphemeLength(toks[i]);
    const diff = Math.abs(acc / total - frac);
    if (diff < bestDiff) { bestDiff = diff; best = i + 1; }
  }
  return [toks.slice(0, best).join('').trim(), toks.slice(best).join('').trim()];
}
