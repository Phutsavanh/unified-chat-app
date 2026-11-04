// Tiny JSON-file datastore. No native modules, so installation never breaks on any OS.
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

function defaultData() {
  return {
    admins: [],
    settings: {
      fb_page_access_token: '',
      fb_app_secret: '',
      ig_business_id: '',
      wa_phone_number_id: '',
      wa_access_token: '',
      wa_business_account_id: '',
      webhook_verify_token: 'change_this_verify_token',
      graph_api_version: 'v21.0'
    },
    editor: {
      openai_api_key: '',
      azure_speech_key: '',
      azure_speech_region: '',
      elevenlabs_api_key: '',
      local_voice_url: '',
      voices: [],       // cloned voice presets (see routes/editor.js)
      textPresets: []   // saved text/subtitle style presets
    },
    conversations: [],
    messages: [],
    nextConvId: 1,
    nextMsgId: 1
  };
}

let cache = null;

function load() {
  if (cache) return cache;
  if (!fs.existsSync(DB_PATH)) {
    cache = defaultData();
    save();
    return cache;
  }
  try {
    cache = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    cache = defaultData();
  }
  // backfill any missing keys if the schema grows later
  const defaults = defaultData();
  for (const key of Object.keys(defaults)) {
    if (!(key in cache)) cache[key] = defaults[key];
  }
  for (const group of ['settings', 'editor']) {
    for (const key of Object.keys(defaults[group])) {
      if (!(key in cache[group])) cache[group][key] = defaults[group][key];
    }
  }
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(cache, null, 2));
}

module.exports = { load, save };
