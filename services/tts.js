// Text-to-speech for the video editor's AI voiceover. Azure has native Lao
// neural voices; OpenAI's voices are multilingual but sound foreign in Lao.

// voice name → SSML language
const AZURE_VOICES = {
  'lo-LA-KeomanyNeural': 'lo-LA',
  'lo-LA-ChanthavongNeural': 'lo-LA',
  'th-TH-PremwadeeNeural': 'th-TH',
  'th-TH-NiwatNeural': 'th-TH',
  'en-US-JennyNeural': 'en-US',
  'en-US-GuyNeural': 'en-US'
};
const OPENAI_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
const MAX_TEXT = 3000;

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// rate and pitch are percentages relative to the voice's normal delivery
function buildSsml(text, voice, rate = 0, pitch = 0) {
  const pct = n => `${n >= 0 ? '+' : ''}${Math.round(n)}%`;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${AZURE_VOICES[voice]}">` +
    `<voice name="${voice}"><prosody rate="${pct(rate)}" pitch="${pct(pitch)}">${escapeXml(text)}</prosody></voice></speak>`;
}

async function failure(r, service) {
  const body = await r.text().catch(() => '');
  let msg = body.slice(0, 300);
  try { msg = JSON.parse(body).error.message || msg; } catch (e) { /* not JSON */ }
  if (r.status === 401 || r.status === 403) msg = 'API Key ບໍ່ຖືກຕ້ອງ ຫຼື ໝົດອາຍຸ';
  return new Error(`${service}: ${msg || `HTTP ${r.status}`}`);
}

async function azureSpeak({ key, region, voice, text, rate, pitch }) {
  // region becomes part of the hostname, so only allow plain region ids
  if (!/^[a-z0-9]+$/.test(region)) throw new Error('Azure region ບໍ່ຖືກຕ້ອງ (ເຊັ່ນ southeastasia)');
  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
      'User-Agent': 'LaoCut'
    },
    body: buildSsml(text, voice, rate, pitch),
    signal: AbortSignal.timeout(60 * 1000)
  });
  if (!r.ok) throw await failure(r, 'Azure');
  return Buffer.from(await r.arrayBuffer());
}

async function openaiSpeak({ key, voice, text, rate, lang }) {
  const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
  const body = {
    model,
    voice,
    input: text,
    response_format: 'mp3',
    speed: Math.min(4, Math.max(0.25, 1 + rate / 100))
  };
  // only the gpt-* speech models accept delivery instructions
  if (model.startsWith('gpt-') && lang === 'lo') {
    body.instructions = 'Speak in natural Lao (ພາສາລາວ) with a clear, friendly narrator tone.';
  }
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60 * 1000)
  });
  if (!r.ok) throw await failure(r, 'OpenAI');
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { AZURE_VOICES, OPENAI_VOICES, MAX_TEXT, buildSsml, azureSpeak, openaiSpeak };
