const express = require('express');
const bcrypt = require('bcryptjs');
const { load, save } = require('../db');

const router = express.Router();

function hasAdmin() {
  return load().admins.length > 0;
}

// Tells the frontend whether to show the signup (first run) or login screen.
router.get('/status', (req, res) => {
  res.json({ hasAdmin: hasAdmin() });
});

// First-run signup: only works while no admin account exists yet. Once an
// admin is created this route always refuses, so it can't be used to add
// more accounts later (use the dashboard's change-password flow for that).
router.post('/setup', (req, res) => {
  if (hasAdmin()) {
    return res.status(403).json({ error: 'มีบัญชีแอดมินอยู่แล้ว กรุณาเข้าสู่ระบบ' });
  }
  const { username, password } = req.body || {};
  if (!username || username.trim().length < 3) {
    return res.status(400).json({ error: 'username ต้องมีอย่างน้อย 3 ตัวอักษร' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'password ต้องมีอย่างน้อย 6 ตัวอักษร' });
  }
  const db = load();
  const admin = {
    id: 1,
    username: username.trim(),
    passwordHash: bcrypt.hashSync(password, 10)
  };
  db.admins.push(admin);
  save();
  req.session.adminId = admin.id;
  res.json({ ok: true, username: admin.username });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const db = load();
  const admin = db.admins.find(a => a.username === username);
  if (!admin || !bcrypt.compareSync(password || '', admin.passwordHash)) {
    return res.status(401).json({ error: 'username หรือ password ไม่ถูกต้อง' });
  }
  req.session.adminId = admin.id;
  res.json({ ok: true, username: admin.username });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.adminId) return res.status(401).json({ error: 'not logged in' });
  const db = load();
  const admin = db.admins.find(a => a.id === req.session.adminId);
  if (!admin) return res.status(401).json({ error: 'not logged in' });
  res.json({ username: admin.username });
});

router.post('/change-password', (req, res) => {
  if (!req.session.adminId) return res.status(401).json({ error: 'not logged in' });
  const { currentPassword, newPassword } = req.body || {};
  const db = load();
  const admin = db.admins.find(a => a.id === req.session.adminId);
  if (!admin || !bcrypt.compareSync(currentPassword || '', admin.passwordHash)) {
    return res.status(401).json({ error: 'รหัสผ่านเดิมไม่ถูกต้อง' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร' });
  }
  admin.passwordHash = bcrypt.hashSync(newPassword, 10);
  save();
  res.json({ ok: true });
});

function requireAuth(req, res, next) {
  if (!req.session.adminId) return res.status(401).json({ error: 'not logged in' });
  next();
}

module.exports = { router, requireAuth };
