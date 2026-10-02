const express = require('express');
const { load, save } = require('../db');
const store = require('../services/store');
const graph = require('../services/graph');
const { requireAuth } = require('./auth');

const router = express.Router();
router.use(requireAuth);

// ---- Conversations ----
router.get('/conversations', (req, res) => {
  res.json(store.listConversations());
});

router.get('/conversations/:id/messages', (req, res) => {
  const id = Number(req.params.id);
  store.markRead(id);
  res.json(store.listMessages(id));
});

router.post('/conversations/:id/send', async (req, res) => {
  const id = Number(req.params.id);
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'ข้อความว่างเปล่า' });

  const db = load();
  const conv = db.conversations.find(c => c.id === id);
  if (!conv) return res.status(404).json({ error: 'ไม่พบการสนทนา' });

  // Demo-seeded conversations aren't wired to a real account — sending just
  // echoes locally so the UI can be tried out before any API is configured.
  if (!conv.isDemo) {
    try {
      if (conv.platform === 'whatsapp') {
        await graph.sendWhatsAppMessage(conv.externalId, text);
      } else if (conv.platform === 'facebook' || conv.platform === 'instagram') {
        await graph.sendPageMessage(conv.externalId, text);
      } else {
        return res.status(400).json({ error: 'ไม่รู้จักแพลตฟอร์มนี้' });
      }
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message;
      return res.status(502).json({ error: `ส่งข้อความไม่สำเร็จ: ${detail}` });
    }
  }

  const msg = store.addMessage({ conversationId: id, direction: 'out', text, senderName: 'คุณ' });
  res.json(msg);
});

// ---- Settings ----
router.get('/settings', (req, res) => {
  const db = load();
  // never echo secrets back in full
  const s = { ...db.settings };
  for (const key of ['fb_page_access_token', 'fb_app_secret', 'wa_access_token']) {
    if (s[key]) s[key] = mask(s[key]);
  }
  res.json(s);
});

function mask(v) {
  if (v.length <= 8) return '••••••••';
  return v.slice(0, 4) + '••••••••' + v.slice(-4);
}

router.post('/settings', (req, res) => {
  const db = load();
  const allowedKeys = Object.keys(db.settings);
  for (const key of allowedKeys) {
    if (req.body[key] !== undefined && !String(req.body[key]).includes('••••')) {
      db.settings[key] = req.body[key];
    }
  }
  save();
  res.json({ ok: true });
});

// ---- Demo data ----
router.post('/demo/seed', (req, res) => {
  const samples = [
    {
      platform: 'whatsapp', externalId: 'demo-wa-1', contactName: 'สมชาย (WhatsApp)',
      messages: [
        ['in', 'สวัสดีครับ สนใจสินค้าตัวนี้อยู่ครับ'],
        ['out', 'สวัสดีค่ะ สินค้ายังมีอยู่ค่ะ สนใจสีไหนคะ'],
        ['in', 'สีดำครับ ราคาเท่าไหร่ครับ']
      ]
    },
    {
      platform: 'facebook', externalId: 'demo-fb-1', contactName: 'Nok Suda (Messenger)',
      messages: [
        ['in', 'ทักมาจาก Facebook Page ค่ะ'],
        ['out', 'สวัสดีค่ะ ยินดีให้บริการค่ะ'],
        ['in', 'อยากสอบถามเรื่องการจัดส่งค่ะ']
      ]
    },
    {
      platform: 'instagram', externalId: 'demo-ig-1', contactName: '@nice.shop (Instagram)',
      messages: [
        ['in', 'ทัก DM มาจาก IG ค่ะ สินค้าในรูปนี้ยังมีไหมคะ'],
        ['out', 'มีค่ะ พร้อมส่งเลยค่ะ']
      ]
    }
  ];

  for (const s of samples) {
    const conv = store.findOrCreateConversation({
      platform: s.platform,
      externalId: s.externalId,
      contactName: s.contactName,
      isDemo: true
    });
    for (const [direction, text] of s.messages) {
      store.addMessage({ conversationId: conv.id, direction, text });
    }
  }
  res.json({ ok: true });
});

module.exports = router;
