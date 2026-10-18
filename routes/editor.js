// Backend for the Lao video editor (public/editor.html). Editing and rendering
// happen entirely in the browser; the server only proxies requests to OpenAI
// (Whisper for automatic subtitles, chat for translation) so the API key never
// reaches the client.
const express = require('express');
const { load, save } = require('../db');
const { requireAuth } = require('./auth');

const router = express.Router();
router.use(requireAuth);

// Whisper rejects uploads over 25 MB. The client sends 16 kHz mono WAV chunks
// (~19 MB per 10 minutes), so this leaves headroom.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const LANGS = ['lo', 'th', 'en', 'vi', 'zh', 'ko', 'ja', 'fr'];

const LANG_NAMES = {
  lo: 'Lao', th: 'Thai', en: 'English', vi: 'Vietnamese',
  zh: 'Simplified Chinese', ko: 'Korean', ja: 'Japanese', fr: 'French'
};
const TRANSLATE_MODEL = () => process.env.OPENAI_TRANSLATE_MODEL || 'gpt-4o-mini';
const MAX_TRANSLATE_LINES = 100;

// A short Lao prompt nudges Whisper into Lao script; without it Lao audio is
// sometimes transcribed in Thai script.
const DEFAULT_PROMPTS = {
  lo: 'ສະບາຍດີ. ນີ້ແມ່ນຄຳເວົ້າເປັນພາສາລາວ, ຂຽນດ້ວຍຕົວອັກສອນລາວ.',
  th: 'สวัสดีครับ นี่คือคำพูดภาษาไทย'
};

function apiKey() {
  return process.env.OPENAI_API_KEY || load().editor.openai_api_key || '';
}

function mask(v) {
  if (!v) return '';
  if (v.length <= 8) return '••••••••';
  return v.slice(0, 4) + '••••••••' + v.slice(-4);
}

router.get('/status', (req, res) => {
  res.json({
    whisper: Boolean(apiKey()),
    fromEnv: Boolean(process.env.OPENAI_API_KEY),
    key: mask(load().editor.openai_api_key)
  });
});

router.post('/settings', (req, res) => {
  const key = (req.body && req.body.openai_api_key || '').trim();
  if (key.includes('••••')) return res.json({ ok: true });
  const db = load();
  db.editor.openai_api_key = key;
  save();
  res.json({ ok: true, key: mask(key) });
});

router.post('/transcribe',
  express.raw({ type: ['audio/wav', 'audio/x-wav', 'application/octet-stream'], limit: MAX_AUDIO_BYTES }),
  async (req, res) => {
    const key = apiKey();
    if (!key) return res.status(400).json({ error: 'ຍັງບໍ່ໄດ້ຕັ້ງ OpenAI API Key' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) {
      return res.status(400).json({ error: 'ບໍ່ພົບຂໍ້ມູນສຽງ' });
    }

    const lang = LANGS.includes(req.query.lang) ? req.query.lang : 'lo';
    const prompt = String(req.query.prompt || DEFAULT_PROMPTS[lang] || '').slice(0, 800);

    const form = new FormData();
    form.append('file', new Blob([req.body], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', 'whisper-1');
    form.append('language', lang);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (prompt) form.append('prompt', prompt);

    try {
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(5 * 60 * 1000)
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (data.error && data.error.message) || `HTTP ${r.status}`;
        return res.status(502).json({ error: `Whisper: ${msg}` });
      }
      res.json({
        text: data.text || '',
        segments: (data.segments || []).map(s => ({
          start: s.start,
          end: s.end,
          text: (s.text || '').trim(),
          noSpeech: s.no_speech_prob,
          logprob: s.avg_logprob
        }))
      });
    } catch (e) {
      res.status(502).json({ error: `ເຊື່ອມຕໍ່ Whisper ບໍ່ໄດ້: ${e.message}` });
    }
  }
);

// Subtitle translation. Lines go as one JSON array so the model sees the
// surrounding context, and must come back with the same count and order.
router.post('/translate', async (req, res) => {
  const key = apiKey();
  if (!key) return res.status(400).json({ error: 'ຍັງບໍ່ໄດ້ຕັ້ງ OpenAI API Key' });
  const { lines, from, to } = req.body || {};
  if (!Array.isArray(lines) || !lines.length || lines.length > MAX_TRANSLATE_LINES ||
      !lines.every(l => typeof l === 'string' && l.length <= 1000)) {
    return res.status(400).json({ error: 'ຂໍ້ມູນຊັບບໍ່ຖືກຕ້ອງ' });
  }
  if (!LANG_NAMES[to] || (from && !LANG_NAMES[from])) {
    return res.status(400).json({ error: 'ບໍ່ຮອງຮັບພາສານີ້' });
  }

  let system = `You translate video subtitles${from ? ` from ${LANG_NAMES[from]}` : ''} into ${LANG_NAMES[to]}. ` +
    'The user sends {"lines": [...]}. Reply with JSON {"lines": [...]} containing exactly the same number ' +
    'of items in the same order, one translation per input line. Keep each line short and natural to read ' +
    'as a subtitle, keep names as they are, and add no notes or explanations.';
  if (to === 'lo') {
    system += ' Write only in Lao script (never Thai script) using modern Lao spelling such as ໜ and ໝ.';
  }

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TRANSLATE_MODEL(),
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify({ lines }) }
        ]
      }),
      signal: AbortSignal.timeout(2 * 60 * 1000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data.error && data.error.message) || `HTTP ${r.status}`;
      return res.status(502).json({ error: `OpenAI: ${msg}` });
    }
    let out;
    try {
      out = JSON.parse(data.choices[0].message.content).lines;
    } catch (e) {
      out = null;
    }
    if (!Array.isArray(out) || out.length !== lines.length) {
      return res.status(502).json({ error: 'ຜົນການແປບໍ່ຄົບຖ້ວນ, ກະລຸນາລອງໃໝ່' });
    }
    res.json({ lines: out.map(l => String(l).trim()) });
  } catch (e) {
    res.status(502).json({ error: `ເຊື່ອມຕໍ່ OpenAI ບໍ່ໄດ້: ${e.message}` });
  }
});

module.exports = router;
