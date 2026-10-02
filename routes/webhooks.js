// Receives real-time events pushed by Meta for Facebook Messenger, Instagram DM
// and WhatsApp Cloud API. These endpoints are public (Meta calls them directly)
// and are protected only by the verify token / signature, never by session auth.
const express = require('express');
const { load } = require('../db');
const store = require('../services/store');

const router = express.Router();

// Meta calls this once with a GET to verify the webhook URL you register.
router.get('/', (req, res) => {
  const { settings } = load();
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === settings.webhook_verify_token) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Facebook Messenger + Instagram DM share this payload shape ("messaging" entries).
function handleMetaMessaging(body) {
  const platform = body.object === 'instagram' ? 'instagram' : 'facebook';
  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const senderId = event.sender?.id;
      const text = event.message?.text;
      if (!senderId || !text) continue; // ignore read receipts, attachments-only, etc.

      const conv = store.findOrCreateConversation({
        platform,
        externalId: senderId,
        contactName: senderId
      });
      store.addMessage({ conversationId: conv.id, direction: 'in', text, timestamp: event.timestamp });
    }
  }
}

// WhatsApp Cloud API payload shape.
function handleWhatsApp(body) {
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contacts = value.contacts || [];
      for (const message of value.messages || []) {
        if (message.type !== 'text') continue; // other types (image/audio/...) not handled in this demo
        const from = message.from;
        const contact = contacts.find(c => c.wa_id === from);
        const conv = store.findOrCreateConversation({
          platform: 'whatsapp',
          externalId: from,
          contactName: contact?.profile?.name || from
        });
        store.addMessage({
          conversationId: conv.id,
          direction: 'in',
          text: message.text?.body || '',
          timestamp: Number(message.timestamp) * 1000
        });
      }
    }
  }
}

router.post('/', (req, res) => {
  const body = req.body;
  try {
    if (body.object === 'page') handleMetaMessaging(body);
    else if (body.object === 'instagram') handleMetaMessaging(body);
    else if (body.object === 'whatsapp_business_account') handleWhatsApp(body);
  } catch (err) {
    console.error('[webhook] error handling event:', err);
  }
  // Always 200 quickly — Meta retries aggressively on non-200 responses.
  res.sendStatus(200);
});

module.exports = router;
