// Voice cloning for the editor's "my voices" presets, through ElevenLabs.
// A preset = one cloned voice (ElevenLabs voice_id) + the original sample
// files, which stay on this server so the voice can be cloned again later
// (new API key, new account, or a voice deleted on the ElevenLabs side).
const fs = require('fs');
const path = require('path');

const BASE = () => (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
const VOICES_DIR = path.join(__dirname, '..', 'data', 'voices');

// eleven_v3 has the widest language coverage; the others are offered for
// voices that sound better on them (and are cheaper/faster).
const MODELS = {
  eleven_v3: 'Eleven v3 — ຫຼາຍພາສາທີ່ສຸດ (ແນະນຳ)',
  eleven_multilingual_v2: 'Multilingual v2 — ສະຖຽນ',
  eleven_flash_v2_5: 'Flash v2.5 — ໄວ ແລະ ຖືກ',
  eleven_turbo_v2_5: 'Turbo v2.5'
};
const DEFAULT_MODEL = () => process.env.ELEVENLABS_MODEL || 'eleven_v3';

const DEFAULT_SETTINGS = { stability: 0.5, similarity: 0.85, style: 0, speakerBoost: true };

const MAX_SAMPLE_BYTES = 20 * 1024 * 1024;
const MAX_SAMPLES = 10;
const SAMPLE_TYPES = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'webm',
  'audio/flac': 'flac', 'audio/x-flac': 'flac'
};

function sampleDir(presetId) {
  // preset ids are generated here, but never trust a path segment
  if (!/^[a-z0-9]+$/i.test(presetId)) throw new Error('bad preset id');
  return path.join(VOICES_DIR, presetId);
}

function saveSamples(presetId, files) {
  const dir = sampleDir(presetId);
  fs.mkdirSync(dir, { recursive: true });
  return files.map((f, i) => {
    const name = `${i + 1}.${SAMPLE_TYPES[f.type] || 'bin'}`;
    fs.writeFileSync(path.join(dir, name), f.data);
    return { file: name, type: f.type, label: String(f.name || name).slice(0, 80), bytes: f.data.length };
  });
}

function readSamples(preset) {
  const dir = sampleDir(preset.id);
  return (preset.samples || []).map(s => ({
    name: s.label || s.file,
    type: s.type,
    data: fs.readFileSync(path.join(dir, path.basename(s.file)))
  }));
}

function samplePath(preset, index) {
  const s = (preset.samples || [])[index];
  if (!s) return null;
  const p = path.join(sampleDir(preset.id), path.basename(s.file));
  return fs.existsSync(p) ? { path: p, type: s.type } : null;
}

function removeSamples(presetId) {
  fs.rmSync(sampleDir(presetId), { recursive: true, force: true });
}

async function failure(r) {
  const body = await r.text().catch(() => '');
  let msg = body.slice(0, 300);
  try {
    const d = JSON.parse(body).detail;
    msg = (d && (d.message || (typeof d === 'string' ? d : JSON.stringify(d)))) || msg;
  } catch (e) { /* not JSON */ }
  if (r.status === 401) msg = 'API Key ບໍ່ຖືກຕ້ອງ ຫຼື ບໍ່ມີສິດໃຊ້ຟັງຊັນນີ້';
  if (r.status === 402) msg = 'ເຄຣດິດ ຫຼື ແຜນບໍລິການບໍ່ພໍ (ການໂຄລນສຽງຕ້ອງໃຊ້ແຜນ Starter ຂຶ້ນໄປ)';
  if (r.status === 429) msg = 'ສົ່ງຄຳຂໍຖີ່ເກີນໄປ — ລໍຖ້າບຶດໜຶ່ງແລ້ວລອງໃໝ່';
  return new Error(`ElevenLabs: ${msg || `HTTP ${r.status}`}`);
}

// Instant voice clone. Returns the new ElevenLabs voice_id.
async function cloneVoice({ key, name, description, removeNoise, samples }) {
  const form = new FormData();
  form.append('name', name);
  if (description) form.append('description', description);
  form.append('remove_background_noise', removeNoise ? 'true' : 'false');
  for (const s of samples) form.append('files', new Blob([s.data], { type: s.type }), s.name);
  const r = await fetch(`${BASE()}/v1/voices/add`, {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
    signal: AbortSignal.timeout(3 * 60 * 1000)
  });
  if (!r.ok) throw await failure(r);
  const data = await r.json();
  if (!data.voice_id) throw new Error('ElevenLabs: ບໍ່ໄດ້ຮັບ voice_id');
  return data.voice_id;
}

async function deleteVoice({ key, voiceId }) {
  const r = await fetch(`${BASE()}/v1/voices/${encodeURIComponent(voiceId)}`, {
    method: 'DELETE',
    headers: { 'xi-api-key': key },
    signal: AbortSignal.timeout(30 * 1000)
  });
  if (!r.ok && r.status !== 404) throw await failure(r);
}

// Checks that a voice id exists in the account (used when importing a voice
// made on the ElevenLabs website, e.g. a Professional Voice Clone).
async function getVoice({ key, voiceId }) {
  const r = await fetch(`${BASE()}/v1/voices/${encodeURIComponent(voiceId)}`, {
    headers: { 'xi-api-key': key },
    signal: AbortSignal.timeout(30 * 1000)
  });
  if (!r.ok) throw await failure(r);
  return r.json();
}

function voiceSettings(model, s, rate) {
  const st = { ...DEFAULT_SETTINGS, ...(s || {}) };
  const clamp01 = v => Math.min(1, Math.max(0, Number(v) || 0));
  const out = {
    stability: clamp01(st.stability),
    similarity_boost: clamp01(st.similarity)
  };
  if (model === 'eleven_v3') {
    // v3 only takes three stability levels: creative / natural / robust
    out.stability = [0, 0.5, 1].reduce((a, b) => Math.abs(b - out.stability) < Math.abs(a - out.stability) ? b : a);
  } else {
    out.style = clamp01(st.style);
    out.use_speaker_boost = st.speakerBoost !== false;
    // ElevenLabs accepts 0.7–1.2; bigger changes are done with clip speed in the editor
    out.speed = Math.min(1.2, Math.max(0.7, 1 + (Number(rate) || 0) / 100));
  }
  return out;
}

async function speak({ key, preset, text, rate }) {
  const model = preset.model || DEFAULT_MODEL();
  const r = await fetch(`${BASE()}/v1/text-to-speech/${encodeURIComponent(preset.voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: model, voice_settings: voiceSettings(model, preset.settings, rate) }),
    signal: AbortSignal.timeout(2 * 60 * 1000)
  });
  if (!r.ok) throw await failure(r);
  return Buffer.from(await r.arrayBuffer());
}

module.exports = {
  MODELS, DEFAULT_MODEL, DEFAULT_SETTINGS, MAX_SAMPLE_BYTES, MAX_SAMPLES, SAMPLE_TYPES,
  saveSamples, readSamples, samplePath, removeSamples,
  cloneVoice, deleteVoice, getVoice, speak, voiceSettings
};
