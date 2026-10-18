// Text AI used by the assistant, script writer, proofreading, translation and
// post captions. Two backends with the same prompts:
//  - the LaoCut server (OpenAI key configured there), when it is reachable;
//  - Claude through the claude.ai viewer (`sample` capability) when the page
//    is published as an artifact, where there is no server.
// Speech-to-text and text-to-speech need audio models and stay server-only.

let samplerPromise = null;
function sampler() {
  if (!samplerPromise) {
    samplerPromise = window.claude && window.claude.use ? window.claude.use('sample').catch(() => null) : Promise.resolve(null);
  }
  return samplerPromise;
}

const SAMPLE_ERRORS = {
  not_granted: 'ທ່ານບໍ່ໄດ້ອະນຸຍາດໃຫ້ໜ້ານີ້ໃຊ້ Claude',
  sampling_disabled: 'ບັນຊີນີ້ໃຊ້ Claude ບໍ່ໄດ້',
  rate_limited: 'ໃຊ້ AI ຖີ່ເກີນໄປ — ລໍຖ້າບຶດໜຶ່ງແລ້ວລອງໃໝ່',
  refused: 'AI ປະຕິເສດຄຳຂໍນີ້ — ລອງປ່ຽນຄຳສັ່ງ',
  invalid_json: 'AI ຕອບບໍ່ຖືກຮູບແບບ — ລອງໃໝ່',
  prompt_too_large: 'ຂໍ້ມູນຍາວເກີນໄປ — ລອງແບ່ງເປັນສ່ວນ',
  session_expired: 'ກະລຸນາເຂົ້າສູ່ລະບົບ claude.ai ໃໝ່'
};

export class AIUnavailable extends Error {}

// whole reply, else a fenced block, else first bracket to last bracket
function parseLoose(text) {
  const tries = [text, (text.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1]];
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (start >= 0 && end > start) tries.push(text.slice(start, end + 1));
  for (const t of tries) {
    if (!t) continue;
    try { return JSON.parse(t); } catch (e) { /* next */ }
  }
  throw new Error(SAMPLE_ERRORS.invalid_json);
}

/**
 * @param {object} status  server status ({ whisper } = OpenAI key present) or null when offline
 * @returns 'server' | 'claude' | null
 */
export async function aiBackend(status) {
  if (status && status.whisper) return 'server';
  if (await sampler()) return 'claude';
  return null;
}

// prompt → text, or parsed JSON when json = true
export async function askAI(prompt, { json = false, status = null, onText, signal, quick = false } = {}) {
  const backend = await aiBackend(status);
  if (backend === 'server') {
    const r = await fetch('/api/editor/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, json }),
      signal
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    if (onText) onText({ text: data.text });
    return json ? parseLoose(data.text) : data.text;
  }
  if (backend === 'claude') {
    const s = await sampler();
    const opts = { signal, modelTier: quick ? 'quick' : 'default' };
    if (onText) opts.onText = onText;
    try {
      if (json) return await s.json(prompt, opts);
      return (await s(prompt, opts)).text;
    } catch (e) {
      if (e && e.code === 'cancelled') throw e;
      throw new Error((e && SAMPLE_ERRORS[e.code]) || `AI ຜິດພາດ (${(e && e.code) || e})`);
    }
  }
  throw new AIUnavailable('ຍັງບໍ່ມີ AI ໃຫ້ໃຊ້: ເປີດໂປຣແກຣມໃນ claude.ai ຫຼື ຕັ້ງ OpenAI Key ໃນເຊີບເວີ');
}

const LAO_RULES = 'Write Lao in Lao script only (never Thai script), with modern spelling (ໜ, ໝ, ຳ).';

export async function writeScript({ topic, seconds, tone }, opts) {
  return askAI(
    `Write a voice-over script in Lao for a short video.\nTopic: ${topic}\nLength: about ${seconds} seconds of speech ` +
    `(roughly ${Math.round(seconds * 2.2)} Lao words).\nTone: ${tone}.\n${LAO_RULES}\n` +
    'Put each spoken sentence on its own line. Start with a hook in the first line and end with a call to action. ' +
    'Reply with only the script lines, no title, no notes, no stage directions.',
    opts
  );
}

export async function proofreadLines(lines, opts) {
  const out = await askAI(
    `Proofread these Lao video subtitle lines. Fix spelling, tone marks, spacing and obvious speech-to-text mistakes; ` +
    `keep the meaning, keep each line short, and keep names and numbers. ${LAO_RULES}\n` +
    `Reply with only a JSON array of exactly ${lines.length} strings, one per input line in the same order.\n\n` +
    JSON.stringify(lines),
    { ...opts, json: true }
  );
  if (!Array.isArray(out) || out.length !== lines.length) throw new Error('AI ສົ່ງຄືນບໍ່ຄົບທຸກແຖວ — ລອງໃໝ່');
  return out.map(String);
}

export async function translateLines(lines, from, to, opts) {
  const names = { lo: 'Lao', th: 'Thai', en: 'English', vi: 'Vietnamese', zh: 'Simplified Chinese', ko: 'Korean', ja: 'Japanese', fr: 'French' };
  const out = await askAI(
    `Translate these video subtitle lines from ${names[from] || from} into ${names[to] || to}. Keep each line short and natural as a subtitle, ` +
    `keep names as they are.${to === 'lo' ? ' ' + LAO_RULES : ''}\n` +
    `Reply with only a JSON array of exactly ${lines.length} strings in the same order.\n\n${JSON.stringify(lines)}`,
    { ...opts, json: true }
  );
  if (!Array.isArray(out) || out.length !== lines.length) throw new Error('AI ສົ່ງຄືນບໍ່ຄົບທຸກແຖວ — ລອງໃໝ່');
  return out.map(String);
}

export async function postCaption({ transcript, title, platform }, opts) {
  return askAI(
    `Write a social media post in Lao for this video, for ${platform}.\nProject name: ${title}\n` +
    `What is said in the video (may be empty):\n${transcript.slice(0, 6000)}\n\n${LAO_RULES}\n` +
    'Reply with only a JSON object: {"title": string (catchy, max 70 characters), "caption": string (2-4 short lines), ' +
    '"hashtags": [5-10 strings starting with #, mixing Lao and English]}',
    { ...opts, json: true }
  );
}
