// Backend for the Lao video editor (public/editor.html). Editing and rendering
// happen entirely in the browser; the server only proxies audio to OpenAI
// Whisper for automatic subtitles so the API key never reaches the client.
const express = require('express');
const { load, save } = require('../db');
const { requireAuth } = require('./auth');

const router = express.Router();
router.use(requireAuth);

// Whisper rejects uploads over 25 MB. The client sends 16 kHz mono WAV chunks
// (~19 MB per 10 minutes), so this leaves headroom.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const LANGS = ['lo', 'th', 'en', 'vi', 'zh', 'ko', 'ja', 'fr'];

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

module.exports = router;
