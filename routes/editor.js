// Backend for the Lao video editor (public/editor.html). Editing and rendering
// happen entirely in the browser; the server only proxies requests to OpenAI
// (Whisper subtitles, translation, voiceover) and Azure Speech (Lao voiceover)
// so API keys never reach the client.
const express = require('express');
const { load, save } = require('../db');
const { requireAuth } = require('./auth');
const tts = require('../services/tts');

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

function azureCreds() {
  const ed = load().editor;
  return {
    key: process.env.AZURE_SPEECH_KEY || ed.azure_speech_key || '',
    region: (process.env.AZURE_SPEECH_REGION || ed.azure_speech_region || '').trim().toLowerCase()
  };
}

function mask(v) {
  if (!v) return '';
  if (v.length <= 8) return '••••••••';
  return v.slice(0, 4) + '••••••••' + v.slice(-4);
}

router.get('/status', (req, res) => {
  const ed = load().editor;
  const az = azureCreds();
  res.json({
    whisper: Boolean(apiKey()),
    fromEnv: Boolean(process.env.OPENAI_API_KEY),
    key: mask(ed.openai_api_key),
    azure: Boolean(az.key && az.region),
    azureFromEnv: Boolean(process.env.AZURE_SPEECH_KEY),
    azureKey: mask(ed.azure_speech_key),
    azureRegion: az.region
  });
});

const SETTING_KEYS = ['openai_api_key', 'azure_speech_key', 'azure_speech_region'];

router.post('/settings', (req, res) => {
  const region = req.body && req.body.azure_speech_region;
  if (typeof region === 'string' && !/^[a-z0-9]*$/.test(region.trim().toLowerCase())) {
    return res.status(400).json({ error: 'Azure region ບໍ່ຖືກຕ້ອງ (ເຊັ່ນ southeastasia)' });
  }
  const db = load();
  for (const k of SETTING_KEYS) {
    const v = req.body && req.body[k];
    // masked values are what /status echoed back: leave the stored key alone
    if (typeof v !== 'string' || v.includes('••••')) continue;
    db.editor[k] = k === 'azure_speech_region' ? v.trim().toLowerCase() : v.trim();
  }
  save();
  res.json({ ok: true });
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

// ---- Online library: openly licensed audio and images from Openverse ----
// Only CC0, public domain and CC BY (credit required) results are offered.
const OPENVERSE = 'https://api.openverse.org/v1';
const LIBRARY_LICENSES = 'cc0,pdm,by';
const MAX_LIBRARY_FILE = 40 * 1024 * 1024;
// The file proxy only fetches URLs a recent search returned, so it can't be
// pointed at arbitrary (internal) addresses.
const searchedUrls = new Map(); // url → expiry (ms)

function rememberUrl(url) {
  if (!url || !/^https:\/\//.test(url)) return;
  if (searchedUrls.size > 5000) {
    const now = Date.now();
    for (const [u, exp] of searchedUrls) if (exp < now) searchedUrls.delete(u);
  }
  searchedUrls.set(url, Date.now() + 60 * 60 * 1000);
}

router.get('/library/search', async (req, res) => {
  const kind = req.query.type === 'image' ? 'images' : 'audio';
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.status(400).json({ error: 'ພິມຄຳຄົ້ນຫາກ່ອນ' });
  const params = new URLSearchParams({ q, license: LIBRARY_LICENSES, page_size: '24', mature: 'false' });
  if (kind === 'images' && req.query.png) params.set('extension', 'png');
  try {
    const r = await fetch(`${OPENVERSE}/${kind}/?${params}`, {
      headers: { 'User-Agent': 'LaoCut video editor', Accept: 'application/json' },
      signal: AbortSignal.timeout(20 * 1000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: `Openverse: ${data.detail || `HTTP ${r.status}`}` });
    const results = (data.results || []).filter(x => x.url).map(x => {
      rememberUrl(x.url);
      return {
        id: x.id,
        title: x.title || 'Untitled',
        creator: x.creator || '',
        license: x.license,
        licenseVersion: x.license_version || '',
        licenseUrl: x.license_url || '',
        landing: x.foreign_landing_url || '',
        source: x.source || x.provider || '',
        url: x.url,
        thumb: x.thumbnail || '',
        duration: x.duration ? x.duration / 1000 : null
      };
    });
    res.json({ results });
  } catch (e) {
    res.status(502).json({ error: `ເຊື່ອມຕໍ່ຄັງອອນລາຍບໍ່ໄດ້ (${e.message})` });
  }
});

router.get('/library/file', async (req, res) => {
  const url = String(req.query.url || '');
  const exp = searchedUrls.get(url);
  if (!exp || exp < Date.now()) return res.status(403).json({ error: 'ໄຟລ໌ນີ້ບໍ່ໄດ້ມາຈາກການຄົ້ນຫາ — ຄົ້ນຫາໃໝ່ອີກຄັ້ງ' });
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'LaoCut video editor' }, signal: AbortSignal.timeout(60 * 1000) });
    if (!r.ok) return res.status(502).json({ error: `ດາວໂຫຼດບໍ່ໄດ້ (HTTP ${r.status})` });
    if (Number(r.headers.get('content-length')) > MAX_LIBRARY_FILE) return res.status(413).json({ error: 'ໄຟລ໌ໃຫຍ່ເກີນ 40 MB' });
    const chunks = [];
    let size = 0;
    for await (const chunk of r.body) {
      size += chunk.length;
      if (size > MAX_LIBRARY_FILE) return res.status(413).json({ error: 'ໄຟລ໌ໃຫຍ່ເກີນ 40 MB' });
      chunks.push(chunk);
    }
    res.type(r.headers.get('content-type') || 'application/octet-stream').send(Buffer.concat(chunks));
  } catch (e) {
    res.status(502).json({ error: `ດາວໂຫຼດບໍ່ໄດ້ (${e.message})` });
  }
});

// AI voiceover. Returns MP3 bytes.
router.post('/tts', async (req, res) => {
  const { engine, voice, text, rate, pitch, lang } = req.body || {};
  const clean = typeof text === 'string' ? text.trim() : '';
  if (!clean || clean.length > tts.MAX_TEXT) {
    return res.status(400).json({ error: `ຂໍ້ຄວາມຕ້ອງມີ 1–${tts.MAX_TEXT} ຕົວອັກສອນ` });
  }
  const r = Math.min(100, Math.max(-50, Number(rate) || 0));
  const p = Math.min(30, Math.max(-30, Number(pitch) || 0));
  try {
    let audio;
    if (engine === 'azure') {
      if (!tts.AZURE_VOICES[voice]) return res.status(400).json({ error: 'ບໍ່ພົບສຽງນີ້' });
      const { key, region } = azureCreds();
      if (!key || !region) return res.status(400).json({ error: 'ຍັງບໍ່ໄດ້ຕັ້ງ Azure Speech Key / Region' });
      audio = await tts.azureSpeak({ key, region, voice, text: clean, rate: r, pitch: p });
    } else if (engine === 'openai') {
      if (!tts.OPENAI_VOICES.includes(voice)) return res.status(400).json({ error: 'ບໍ່ພົບສຽງນີ້' });
      const key = apiKey();
      if (!key) return res.status(400).json({ error: 'ຍັງບໍ່ໄດ້ຕັ້ງ OpenAI API Key' });
      audio = await tts.openaiSpeak({ key, voice, text: clean, rate: r, lang });
    } else {
      return res.status(400).json({ error: 'ບໍ່ຮອງຮັບລະບົບສຽງນີ້' });
    }
    res.type('audio/mpeg').send(audio);
  } catch (e) {
    const msg = e.name === 'TimeoutError' || e.message === 'fetch failed' ? `ເຊື່ອມຕໍ່ບໍລິການສຽງບໍ່ໄດ້ (${e.message})` : e.message;
    res.status(502).json({ error: msg });
  }
});

module.exports = router;
