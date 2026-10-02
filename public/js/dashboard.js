const state = {
  conversations: [],
  activeId: null,
  filter: 'all'
};

const platformLabel = { whatsapp: 'WhatsApp', facebook: 'Messenger', instagram: 'Instagram', demo: 'Demo' };

async function api(path, opts) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('not logged in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

async function init() {
  const me = await api('/auth/me').catch(() => null);
  if (!me) return;
  document.getElementById('meUsername').textContent = me.username;

  document.getElementById('webhookUrlHint').textContent = window.location.origin + '/webhook';

  await loadConversations();
  connectSocket();
  bindUi();
}

async function loadConversations() {
  state.conversations = await api('/conversations');
  renderConvList();
}

function renderConvList() {
  const list = document.getElementById('convList');
  list.innerHTML = '';
  const filtered = state.conversations.filter(c => state.filter === 'all' || c.platform === state.filter);

  for (const conv of filtered) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (conv.id === state.activeId ? ' active' : '');
    item.onclick = () => openConversation(conv.id);

    item.innerHTML = `
      <div class="avatar ${conv.platform}">${initials(conv.contactName)}</div>
      <div class="conv-info">
        <div class="conv-name">${escapeHtml(conv.contactName)}</div>
        <div class="conv-last">${escapeHtml(conv.lastMessage || '')}</div>
      </div>
      <div class="conv-meta">
        <div class="conv-time">${formatTime(conv.lastTime)}</div>
        ${conv.unreadCount ? `<div class="badge-count">${conv.unreadCount}</div>` : ''}
      </div>
    `;
    list.appendChild(item);
  }
}

async function openConversation(id) {
  state.activeId = id;
  renderConvList();

  const conv = state.conversations.find(c => c.id === id);
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('chatView').classList.remove('hidden');
  document.getElementById('chatContactName').textContent = conv.contactName;
  const badge = document.getElementById('chatPlatformBadge');
  badge.textContent = platformLabel[conv.platform] || conv.platform;
  badge.className = 'platform-badge ' + conv.platform;

  const messages = await api(`/conversations/${id}/messages`);
  renderMessages(messages);
  conv.unreadCount = 0;
  renderConvList();
}

function renderMessages(messages) {
  const box = document.getElementById('messages');
  box.innerHTML = '';
  for (const m of messages) {
    const el = document.createElement('div');
    el.className = 'msg ' + m.direction;
    el.innerHTML = `${escapeHtml(m.text)}<div class="msg-time">${formatTime(m.timestamp)}</div>`;
    box.appendChild(el);
  }
  box.scrollTop = box.scrollHeight;
}

function connectSocket() {
  const socket = io();
  socket.on('new_message', ({ message, conversation }) => {
    const idx = state.conversations.findIndex(c => c.id === conversation.id);
    if (idx >= 0) state.conversations[idx] = conversation;
    else state.conversations.push(conversation);
    renderConvList();

    if (state.activeId === conversation.id) {
      appendMessage(message);
      conversation.unreadCount = 0;
    }
  });
}

function appendMessage(m) {
  const box = document.getElementById('messages');
  const el = document.createElement('div');
  el.className = 'msg ' + m.direction;
  el.innerHTML = `${escapeHtml(m.text)}<div class="msg-time">${formatTime(m.timestamp)}</div>`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function bindUi() {
  document.getElementById('logoutBtn').onclick = async () => {
    await api('/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  };

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.platform;
      renderConvList();
    };
  });

  document.getElementById('composerForm').onsubmit = async (e) => {
    e.preventDefault();
    const input = document.getElementById('composerInput');
    const text = input.value.trim();
    if (!text || !state.activeId) return;
    input.value = '';
    try {
      const msg = await api(`/conversations/${state.activeId}/send`, {
        method: 'POST',
        body: JSON.stringify({ text })
      });
      appendMessage(msg);
      const conv = state.conversations.find(c => c.id === state.activeId);
      if (conv) { conv.lastMessage = text; conv.lastTime = msg.timestamp; }
      renderConvList();
    } catch (err) {
      alert(err.message);
    }
  };

  document.getElementById('settingsBtn').onclick = openSettings;
  document.getElementById('closeSettingsBtn').onclick = closeSettings;

  document.getElementById('seedDemoBtn').onclick = async () => {
    await api('/demo/seed', { method: 'POST' });
    document.getElementById('seedStatus').textContent = 'โหลดข้อมูลตัวอย่างแล้ว ✓';
    await loadConversations();
  };

  document.getElementById('settingsForm').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = Object.fromEntries(new FormData(form).entries());
    const errorEl = document.getElementById('settingsError');
    const successEl = document.getElementById('settingsSuccess');
    errorEl.textContent = '';
    successEl.textContent = '';
    try {
      await api('/settings', { method: 'POST', body: JSON.stringify(payload) });
      successEl.textContent = 'บันทึกสำเร็จ';
    } catch (err) {
      errorEl.textContent = err.message;
    }
  };

  document.getElementById('pwForm').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = Object.fromEntries(new FormData(form).entries());
    const errorEl = document.getElementById('pwError');
    const successEl = document.getElementById('pwSuccess');
    errorEl.textContent = '';
    successEl.textContent = '';
    try {
      await api('/auth/change-password', { method: 'POST', body: JSON.stringify(payload) });
      successEl.textContent = 'เปลี่ยนรหัสผ่านสำเร็จ';
      form.reset();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  };
}

async function openSettings() {
  const settings = await api('/settings');
  const form = document.getElementById('settingsForm');
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements[key];
    if (input) input.value = value;
  }
  document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.add('hidden');
}

function initials(name) {
  return (name || '?').trim().slice(0, 1).toUpperCase();
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

init();
