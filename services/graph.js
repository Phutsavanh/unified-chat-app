// Thin wrapper around Meta Graph API calls used by Messenger, Instagram and WhatsApp Cloud API.
const axios = require('axios');
const { load } = require('../db');

function base() {
  const { settings } = load();
  return `https://graph.facebook.com/${settings.graph_api_version}`;
}

// Facebook Messenger & Instagram DM both send through the Page's /me/messages
// endpoint once the IG professional account is linked to the Page.
async function sendPageMessage(recipientId, text) {
  const { settings } = load();
  if (!settings.fb_page_access_token) {
    throw new Error('ยังไม่ได้ตั้งค่า Facebook Page Access Token ในหน้า Settings');
  }
  const url = `${base()}/me/messages`;
  const { data } = await axios.post(url, {
    recipient: { id: recipientId },
    message: { text }
  }, {
    params: { access_token: settings.fb_page_access_token }
  });
  return data;
}

async function sendWhatsAppMessage(to, text) {
  const { settings } = load();
  if (!settings.wa_access_token || !settings.wa_phone_number_id) {
    throw new Error('ยังไม่ได้ตั้งค่า WhatsApp Access Token / Phone Number ID ในหน้า Settings');
  }
  const url = `${base()}/${settings.wa_phone_number_id}/messages`;
  const { data } = await axios.post(url, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  }, {
    headers: { Authorization: `Bearer ${settings.wa_access_token}` }
  });
  return data;
}

module.exports = { sendPageMessage, sendWhatsAppMessage };
