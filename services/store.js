// Normalizes conversations/messages from all 3 platforms into one shape so the
// frontend can render a single unified inbox regardless of source platform.
const { load, save } = require('../db');

let io = null;
function attachIo(socketIo) {
  io = socketIo;
}

function findOrCreateConversation({ platform, externalId, contactName, avatar, isDemo }) {
  const db = load();
  let conv = db.conversations.find(c => c.platform === platform && c.externalId === externalId);
  if (!conv) {
    conv = {
      id: db.nextConvId++,
      platform,
      externalId,
      contactName: contactName || externalId,
      avatar: avatar || '',
      lastMessage: '',
      lastTime: Date.now(),
      unreadCount: 0,
      isDemo: !!isDemo
    };
    db.conversations.push(conv);
    save();
  } else if (contactName && conv.contactName !== contactName) {
    conv.contactName = contactName;
    save();
  }
  return conv;
}

function addMessage({ conversationId, direction, text, senderName, timestamp }) {
  const db = load();
  const conv = db.conversations.find(c => c.id === conversationId);
  if (!conv) throw new Error('conversation not found');

  const msg = {
    id: db.nextMsgId++,
    conversationId,
    direction, // 'in' | 'out'
    text,
    senderName: senderName || conv.contactName,
    timestamp: timestamp || Date.now()
  };
  db.messages.push(msg);

  conv.lastMessage = text;
  conv.lastTime = msg.timestamp;
  if (direction === 'in') conv.unreadCount = (conv.unreadCount || 0) + 1;
  save();

  if (io) {
    io.emit('new_message', { message: msg, conversation: conv });
  }
  return msg;
}

function listConversations() {
  const db = load();
  return [...db.conversations].sort((a, b) => b.lastTime - a.lastTime);
}

function listMessages(conversationId) {
  const db = load();
  return db.messages
    .filter(m => m.conversationId === conversationId)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function markRead(conversationId) {
  const db = load();
  const conv = db.conversations.find(c => c.id === conversationId);
  if (conv) {
    conv.unreadCount = 0;
    save();
  }
  return conv;
}

module.exports = {
  attachIo,
  findOrCreateConversation,
  addMessage,
  listConversations,
  listMessages,
  markRead
};
