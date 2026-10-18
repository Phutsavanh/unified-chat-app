require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');

const { router: authRouter } = require('./routes/auth');
const apiRouter = require('./routes/api');
const webhooksRouter = require('./routes/webhooks');
const editorRouter = require('./routes/editor');
const store = require('./services/store');
const { load } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
store.attachIo(io);

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'unified-chat-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));

// Webhooks must stay public (Meta calls these directly, no session cookie).
app.use('/webhook', webhooksRouter);

app.use('/api/auth', authRouter);
app.use('/api/editor', editorRouter);
app.use('/api', apiRouter);

function hasAdmin() {
  return load().admins.length > 0;
}

// Route visitors to the right page: create-the-first-account (setup),
// sign in (login), or straight into the dashboard if already logged in.
app.get('/setup.html', (req, res, next) => {
  if (hasAdmin()) return res.redirect('/login.html');
  next();
});
app.get('/login.html', (req, res, next) => {
  if (!hasAdmin()) return res.redirect('/setup.html');
  if (req.session.adminId) return res.redirect('/');
  next();
});

// The video editor sits behind the same admin login as the inbox.
app.get('/editor.html', (req, res, next) => {
  if (!req.session.adminId) return res.redirect(hasAdmin() ? '/login.html' : '/setup.html');
  next();
});
app.get('/editor', (req, res) => res.redirect('/editor.html'));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  if (!hasAdmin()) return res.redirect('/setup.html');
  if (!req.session.adminId) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

io.on('connection', () => {});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Unified Chat App running at http://localhost:${PORT}`);
});
