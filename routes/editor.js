// Backend for the Lao video editor (public/editor.html). Editing and rendering
// happen entirely in the browser; the server only proxies requests to OpenAI
// (Whisper subtitles, translation, voiceover), Azure Speech (Lao voiceover) and
// ElevenLabs (cloned voices) so API keys never reach the client. It also keeps
// the long-lived presets: cloned voices (with their samples) and text styles.
const crypto = require('crypto');
const express = require('express');
const { load, save } = require('../db');
const { requireAuth } = require('./auth');
const tts = require('../services/tts');
const clone = require('../services/voiceclone');

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

function elevenKey() {
  return process.env.ELEVENLABS_API_KEY || load().editor.elevenlabs_api_key || '';
}

function localUrl() {
  const u = process.env.LOCAL_VOICE_URL || load().editor.local_voice_url || 'http://127.0.0.1:7861';
  return u.replace(/\/+$/, '');
}

function mask(v) {
  if (!v) return '';
  if (v.length <= 8) return '••••••••';
  return v.slice(0, 4) + '••••••••' + v.slice(-4);
}

router.get('/status', async (req, res) => {
  const ed = load().editor;
  const az = azureCreds();
  const health = await clone.localHealth(localUrl());
  res.json({
    local: Boolean(health),
    localReady: Boolean(health && health.ready),
    localLoading: Boolean(health && health.loading),
    localError: (health && health.error) || '',
    localUrl: localUrl(),
    whisper: Boolean(apiKey()),
    fromEnv: Boolean(process.env.OPENAI_API_KEY),
    key: mask(ed.openai_api_key),
    azure: Boolean(az.key && az.region),
    azureFromEnv: Boolean(process.env.AZURE_SPEECH_KEY),
    azureKey: mask(ed.azure_speech_key),
    azureRegion: az.region,
    eleven: Boolean(elevenKey()),
    elevenFromEnv: Boolean(process.env.ELEVENLABS_API_KEY),
    elevenKey: mask(ed.elevenlabs_api_key)
  });
});

const SETTING_KEYS = ['openai_api_key', 'azure_speech_key', 'azure_speech_region', 'elevenlabs_api_key', 'local_voice_url'];

router.post('/settings', (req, res) => {
  const region = req.body && req.body.azure_speech_region;
  if (typeof region === 'string' && !/^[a-z0-9]*$/.test(region.trim().toLowerCase())) {
    return res.status(400).json({ error: 'Azure region ບໍ່ຖືກຕ້ອງ (ເຊັ່ນ southeastasia)' });
  }
  const url = req.body && req.body.local_voice_url;
  if (typeof url === 'string' && url.trim() && !/^https?:\/\/[^\s/]+$/.test(url.trim().replace(/\/+$/, ''))) {
    return res.status(400).json({ error: 'URL ເຊີບເວີສຽງບໍ່ຖືກຕ້ອງ (ເຊັ່ນ http://127.0.0.1:7861)' });
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
    } else if (engine === 'clone') {
      const preset = load().editor.voices.find(v => v.id === voice);
      if (!preset) return res.status(400).json({ error: 'ບໍ່ພົບພຣີເຊັດສຽງນີ້ (ອາດຖືກລຶບແລ້ວ)' });
      if (!preset.voiceId) return res.status(400).json({ error: 'ສຽງນີ້ຍັງບໍ່ໄດ້ໂຄລນ — ກົດ "ໂຄລນໃໝ່" ໃນແຖບສຽງໂຄລນ' });
      if (preset.provider === 'local') {
        const az = azureCreds();
        const out = await clone.localSpeak({
          url: localUrl(), preset, text: clean, rate: r,
          azure: az.key && az.region ? az : null, azureSpeak: tts.azureSpeak
        });
        return res.type(out.type).send(out.audio);
      }
      const key = elevenKey();
      if (!key) return res.status(400).json({ error: 'ຍັງບໍ່ໄດ້ຕັ້ງ ElevenLabs API Key' });
      audio = await clone.speak({ key, preset, text: clean, rate: r });
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

// ---------------------------------------------------------------- cloned voice presets
const newPresetId = () => crypto.randomBytes(6).toString('hex');

function publicVoice(v) {
  return {
    id: v.id,
    name: v.name,
    provider: v.provider || 'elevenlabs',
    baseVoice: v.baseVoice || 'lo-LA-KeomanyNeural',
    description: v.description || '',
    model: v.model || clone.DEFAULT_MODEL(),
    settings: { ...clone.DEFAULT_SETTINGS, ...(v.settings || {}) },
    samples: (v.samples || []).map(s => ({ label: s.label, bytes: s.bytes })),
    imported: Boolean(v.imported),
    cloned: Boolean(v.voiceId),
    createdAt: v.createdAt
  };
}

function findVoice(req, res) {
  const v = load().editor.voices.find(x => x.id === req.params.id);
  if (!v) res.status(404).json({ error: 'ບໍ່ພົບພຣີເຊັດສຽງນີ້' });
  return v;
}

function cleanName(v, max = 60) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '';
}

router.get('/voices', (req, res) => {
  res.json({
    voices: load().editor.voices.map(publicVoice),
    models: clone.MODELS,
    defaultModel: clone.DEFAULT_MODEL(),
    baseVoices: clone.LOCAL_BASE_VOICES
  });
});

// multipart/form-data: provider, name, description, consent, removeNoise,
// model, baseVoice, voiceId?, files[]
router.post('/voices',
  express.raw({ type: 'multipart/form-data', limit: clone.MAX_SAMPLES * clone.MAX_SAMPLE_BYTES }),
  async (req, res) => {
    let form;
    try {
      form = await new Response(req.body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
    } catch (e) {
      return res.status(400).json({ error: 'ອ່ານຂໍ້ມູນທີ່ສົ່ງມາບໍ່ໄດ້' });
    }
    const name = cleanName(form.get('name'));
    const description = cleanName(form.get('description'), 300);
    const importId = cleanName(form.get('voiceId'), 64);
    const model = clone.MODELS[form.get('model')] ? form.get('model') : clone.DEFAULT_MODEL();
    const provider = form.get('provider') === 'local' ? 'local' : 'elevenlabs';
    const baseVoice = clone.LOCAL_BASE_VOICES[form.get('baseVoice')] ? form.get('baseVoice') : 'lo-LA-KeomanyNeural';
    const key = elevenKey();
    if (provider === 'elevenlabs' && !key) return res.status(400).json({ error: 'ຍັງບໍ່ໄດ້ຕັ້ງ ElevenLabs API Key (ກົດ ⚙)' });
    if (provider === 'local' && importId) return res.status(400).json({ error: 'ການນຳເຂົ້າ Voice ID ໃຊ້ໄດ້ກັບ ElevenLabs ເທົ່ານັ້ນ' });
    if (!name) return res.status(400).json({ error: 'ໃສ່ຊື່ສຽງກ່ອນ' });
    if (form.get('consent') !== '1') {
      return res.status(400).json({ error: 'ຕ້ອງຢືນຢັນວ່າເປັນສຽງຂອງທ່ານເອງ ຫຼື ໄດ້ຮັບອະນຸຍາດຈາກເຈົ້າຂອງສຽງ' });
    }

    const db = load();
    const preset = {
      id: newPresetId(), name, description, provider, model,
      ...(provider === 'local' ? { baseVoice } : {}),
      settings: { ...clone.DEFAULT_SETTINGS },
      samples: [], consent: true, createdAt: new Date().toISOString()
    };

    try {
      if (importId) {
        // voice already made on elevenlabs.io (e.g. a Professional Voice Clone)
        if (!/^[A-Za-z0-9]+$/.test(importId)) return res.status(400).json({ error: 'Voice ID ບໍ່ຖືກຕ້ອງ' });
        await clone.getVoice({ key, voiceId: importId });
        preset.voiceId = importId;
        preset.imported = true;
      } else {
        const files = [];
        for (const f of form.getAll('files')) {
          if (typeof f === 'string') continue;
          const type = (f.type || '').split(';')[0].toLowerCase();
          if (!clone.SAMPLE_TYPES[type]) return res.status(400).json({ error: `ບໍ່ຮອງຮັບໄຟລ໌ສຽງປະເພດນີ້: ${f.name}` });
          if (f.size > clone.MAX_SAMPLE_BYTES) return res.status(400).json({ error: `ໄຟລ໌ໃຫຍ່ເກີນ 20 MB: ${f.name}` });
          files.push({ name: f.name, type, data: Buffer.from(await f.arrayBuffer()) });
        }
        if (!files.length) return res.status(400).json({ error: 'ຕ້ອງມີໄຟລ໌ສຽງຕົວຢ່າງຢ່າງໜ້ອຍ 1 ໄຟລ໌' });
        if (files.length > clone.MAX_SAMPLES) return res.status(400).json({ error: `ສົ່ງໄດ້ສູງສຸດ ${clone.MAX_SAMPLES} ໄຟລ໌` });
        preset.samples = clone.saveSamples(preset.id, files);
        preset.voiceId = provider === 'local'
          ? await clone.localClone({ url: localUrl(), samples: files })
          : await clone.cloneVoice({
            key, name: `LaoCut · ${name}`, description, removeNoise: form.get('removeNoise') === '1',
            samples: files
          });
      }
    } catch (e) {
      clone.removeSamples(preset.id);
      return res.status(502).json({ error: e.message });
    }
    db.editor.voices.push(preset);
    save();
    res.json({ voice: publicVoice(preset) });
  }
);

router.patch('/voices/:id', (req, res) => {
  const v = findVoice(req, res);
  if (!v) return;
  const b = req.body || {};
  if (b.name !== undefined) {
    const name = cleanName(b.name);
    if (!name) return res.status(400).json({ error: 'ຊື່ບໍ່ຖືກຕ້ອງ' });
    v.name = name;
  }
  if (b.description !== undefined) v.description = cleanName(b.description, 300);
  if (b.baseVoice !== undefined) {
    if (!clone.LOCAL_BASE_VOICES[b.baseVoice]) return res.status(400).json({ error: 'ບໍ່ພົບສຽງພື້ນຖານນີ້' });
    v.baseVoice = b.baseVoice;
  }
  if (b.model !== undefined) {
    if (!clone.MODELS[b.model]) return res.status(400).json({ error: 'ບໍ່ຮອງຮັບໂມເດລນີ້' });
    v.model = b.model;
  }
  if (b.settings && typeof b.settings === 'object') {
    const cur = { ...clone.DEFAULT_SETTINGS, ...(v.settings || {}) };
    for (const k of ['stability', 'similarity', 'style']) {
      if (b.settings[k] !== undefined) cur[k] = Math.min(1, Math.max(0, Number(b.settings[k]) || 0));
    }
    if (b.settings.speakerBoost !== undefined) cur.speakerBoost = Boolean(b.settings.speakerBoost);
    v.settings = cur;
  }
  save();
  res.json({ voice: publicVoice(v) });
});

// Clone again from the samples kept on this server.
router.post('/voices/:id/reclone', async (req, res) => {
  const v = findVoice(req, res);
  if (!v) return;
  const local = v.provider === 'local';
  const key = elevenKey();
  if (!local && !key) return res.status(400).json({ error: 'ຍັງບໍ່ໄດ້ຕັ້ງ ElevenLabs API Key' });
  if (!v.samples || !v.samples.length) return res.status(400).json({ error: 'ສຽງນີ້ນຳເຂົ້າຈາກ Voice ID, ບໍ່ມີໄຟລ໌ຕົວຢ່າງໃຫ້ໂຄລນໃໝ່' });
  try {
    const samples = clone.readSamples(v);
    const old = v.voiceId;
    v.voiceId = local
      ? await clone.localClone({ url: localUrl(), samples })
      : await clone.cloneVoice({ key, name: `LaoCut · ${v.name}`, description: v.description, removeNoise: false, samples });
    save();
    if (old && old !== v.voiceId) {
      if (local) clone.localDelete({ url: localUrl(), voiceId: old });
      else clone.deleteVoice({ key, voiceId: old }).catch(() => {});
    }
    res.json({ voice: publicVoice(v) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/voices/:id/samples/:n', (req, res) => {
  const v = findVoice(req, res);
  if (!v) return;
  const s = clone.samplePath(v, Number(req.params.n));
  if (!s) return res.status(404).json({ error: 'ບໍ່ພົບໄຟລ໌' });
  res.type(s.type).sendFile(s.path);
});

router.delete('/voices/:id', async (req, res) => {
  const v = findVoice(req, res);
  if (!v) return;
  const db = load();
  db.editor.voices = db.editor.voices.filter(x => x !== v);
  save();
  clone.removeSamples(v.id);
  // an imported voice belongs to the user's ElevenLabs library: leave it there
  const key = elevenKey();
  let remote = 'skipped';
  if (v.provider === 'local') {
    if (v.voiceId) await clone.localDelete({ url: localUrl(), voiceId: v.voiceId });
  } else if (key && v.voiceId && !v.imported) {
    remote = await clone.deleteVoice({ key, voiceId: v.voiceId }).then(() => 'deleted', () => 'failed');
  }
  res.json({ ok: true, remote });
});

// ---------------------------------------------------------------- saved text style presets
const MAX_TEXT_PRESETS = 200;

router.get('/text-presets', (req, res) => {
  res.json({ presets: load().editor.textPresets });
});

router.put('/text-presets', (req, res) => {
  const list = req.body && req.body.presets;
  if (!Array.isArray(list) || list.length > MAX_TEXT_PRESETS || JSON.stringify(list).length > 90 * 1024) {
    return res.status(400).json({ error: 'ຂໍ້ມູນພຣີເຊັດບໍ່ຖືກຕ້ອງ' });
  }
  const clean = [];
  for (const p of list) {
    if (!p || typeof p !== 'object' || !p.style || typeof p.style !== 'object') continue;
    const id = cleanName(p.id, 32);
    const name = cleanName(p.name, 40);
    if (!id || !name) continue;
    const style = {};
    for (const [k, v] of Object.entries(p.style)) {
      if (/^[a-zA-Z]{1,24}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)) {
        style[k] = typeof v === 'string' ? v.slice(0, 80) : v;
      }
    }
    clean.push({ id, name, style, createdAt: cleanName(p.createdAt, 40) });
  }
  load().editor.textPresets = clean;
  save();
  res.json({ presets: clean });
});

module.exports = router;
