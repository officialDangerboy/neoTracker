require('dotenv').config();
const express = require('express');
const session = require('express-session');
const connectMongo = require('connect-mongo');
const MongoStore = connectMongo.create ? connectMongo : connectMongo(session);

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;  // Railway sets PORT automatically
const MONGO_URI = process.env.MONGO_URI || '';

if (!MONGO_URI) {
  console.error('❌ MONGO_URI not set in .env or environment variables');
  process.exit(1);
}

// ── MongoDB ──────────────────────────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => { console.error('❌ MongoDB:', err.message); process.exit(1); });

// ── Schemas ──────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true, maxlength: 60 },
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:  { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const hitSchema = new mongoose.Schema({
  lat:     { type: Number, default: null },
  lon:     { type: Number, default: null },
  acc:     { type: Number, default: null },
  device:  { type: String, default: 'Unknown' },
  browser: { type: String, default: 'Unknown' },
  ip:      { type: String, default: '' },
  time:    { type: Date, default: Date.now }
});

const linkSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  dest:      { type: String, required: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
  hits:      [hitSchema]
});

const User = mongoose.model('User', userSchema);
const Link = mongoose.model('Link', linkSchema);

// ── Captcha store ────────────────────────────────────────────────────
const captchas = {};

// ── Middleware ───────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.set('trust proxy', 1); // Required for Railway/proxied deployments
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change_this_in_production_' + Math.random(),
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: MONGO_URI,
    ttl: 7 * 24 * 60 * 60, // 7 days in seconds
    autoRemove: 'native'
  }),
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

// Rate limiters
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'Too many attempts, try again in 15 minutes' }, standardHeaders: true, legacyHeaders: false });
const apiLimiter  = rateLimit({ windowMs: 60*1000, max: 60, message: { error: 'Too many requests' } });
const hitLimiter  = rateLimit({ windowMs: 60*1000, max: 10, keyGenerator: (req) => req.params.id + '_' + (req.ip||''), message: { error: 'Too many hits' } });

app.use('/api/', apiLimiter);

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}
function isValidId(id) { return mongoose.Types.ObjectId.isValid(id); }

// ── CAPTCHA ──────────────────────────────────────────────────────────
app.get('/api/captcha', (req, res) => {
  const n1 = Math.floor(Math.random()*9)+1;
  const n2 = Math.floor(Math.random()*9)+1;
  const token = uuidv4();
  captchas[token] = { answer: String(n1+n2), expires: Date.now()+5*60*1000 };
  const now = Date.now();
  Object.keys(captchas).forEach(k => { if (captchas[k].expires < now) delete captchas[k]; });

  const W=160, H=52;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle='#0f1117'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='rgba(0,255,136,0.07)'; ctx.lineWidth=1;
  for(let x=0;x<W;x+=16){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke()}
  for(let y=0;y<H;y+=16){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke()}
  for(let i=0;i<50;i++){ctx.fillStyle=`rgba(0,255,136,${Math.random()*0.25})`;ctx.fillRect(Math.random()*W,Math.random()*H,2,2)}
  for(let l=0;l<3;l++){
    ctx.strokeStyle=`rgba(0,255,136,${0.08+Math.random()*0.12})`;ctx.lineWidth=1;ctx.beginPath();
    for(let x=0;x<=W;x+=8){const y=H/2+Math.sin(x*0.12+l*2)*12+(Math.random()-.5)*8;x===0?ctx.moveTo(x,y):ctx.lineTo(x,y)}
    ctx.stroke();
  }
  const text=`${n1} + ${n2} = ?`; ctx.font='bold 21px monospace'; let xPos=10;
  for(const ch of text){
    ctx.save();ctx.translate(xPos,H/2+7);ctx.rotate((Math.random()-.5)*0.3);
    ctx.fillStyle=`hsl(${145+Math.random()*20},100%,${60+Math.random()*15}%)`;
    ctx.fillText(ch,0,0);ctx.restore();xPos+=ctx.measureText(ch).width+2;
  }
  const buf = canvas.toBuffer('image/png');
  res.set({'Content-Type':'image/png','X-Captcha-Token':token,'Cache-Control':'no-store'});
  res.send(buf);
});

// ── AUTH ─────────────────────────────────────────────────────────────
app.post('/api/signup', authLimiter, async (req, res) => {
  try {
    const { name, email, password, confirmPassword, captchaToken, captchaAnswer } = req.body;
    if (!name?.trim()||!email?.trim()||!password||!confirmPassword) return res.status(400).json({ error:'All fields are required' });
    if (name.trim().length<2) return res.status(400).json({ error:'Name must be at least 2 characters' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error:'Invalid email address' });
    if (password.length<8) return res.status(400).json({ error:'Password must be at least 8 characters' });
    if (password!==confirmPassword) return res.status(400).json({ error:'Passwords do not match' });
    const cap = captchas[captchaToken];
    if (!cap||cap.expires<Date.now()) return res.status(400).json({ error:'Captcha expired — click the image to refresh' });
    if (cap.answer!==String(captchaAnswer).trim()) return res.status(400).json({ error:'Wrong captcha answer — try again' });
    delete captchas[captchaToken];
    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(400).json({ error:'Email already registered' });
    const hash = await bcrypt.hash(password, 12);
    const user = await User.create({ name:name.trim(), email:email.toLowerCase().trim(), password:hash });
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error:'Session error' });
      req.session.userId = user._id.toString();
      req.session.userName = user.name;
      res.json({ ok:true, name:user.name });
    });
  } catch(e) { console.error('Signup error:',e); res.status(500).json({ error:'Server error' }); }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email?.trim()||!password) return res.status(400).json({ error:'Email and password required' });
    if (password.length<8) return res.status(400).json({ error:'Password must be at least 8 characters' });
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    const dummyHash = '$2a$12$dummy.hash.to.prevent.timing.attacks.xxxxxxxxx';
    const match = user ? await bcrypt.compare(password,user.password) : await bcrypt.compare(password,dummyHash);
    if (!user||!match) return res.status(401).json({ error:'Invalid email or password' });
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error:'Session error' });
      req.session.userId = user._id.toString();
      req.session.userName = user.name;
      res.json({ ok:true, name:user.name });
    });
  } catch(e) { console.error('Login error:',e); res.status(500).json({ error:'Server error' }); }
});

app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy(() => { res.clearCookie('connect.sid'); res.json({ ok:true }); });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn:false });
  res.json({ loggedIn:true, name:req.session.userName, id:req.session.userId });
});

// ── LINKS ─────────────────────────────────────────────────────────────
app.post('/api/links/create', requireAuth, async (req, res) => {
  try {
    let { dest, expiresIn } = req.body;
    if (!dest?.trim()) return res.status(400).json({ error:'Destination URL required' });
    if (!/^https?:\/\//i.test(dest)) dest = 'https://'+dest;
    try { new URL(dest); } catch { return res.status(400).json({ error:'Invalid URL' }); }
    const hours = Math.min(Math.max(parseInt(expiresIn)||1,1),24);
    const link = await Link.create({ userId:req.session.userId, dest:dest.trim(), expiresAt:new Date(Date.now()+hours*3600000), hits:[] });
    const trackUrl = `${req.protocol}://${req.get('host')}/go/${link._id}`;
    res.json({ id:link._id, trackUrl, expiresAt:link.expiresAt });
  } catch(e) { console.error('Create link error:',e); res.status(500).json({ error:'Server error' }); }
});

app.get('/api/links', requireAuth, async (req, res) => {
  try {
    const links = await Link.find({ userId:req.session.userId }).select('-hits').sort({ createdAt:-1 }).lean();
    const result = await Promise.all(links.map(async l => {
      const hitCount = (await Link.findById(l._id).select('hits').lean())?.hits?.length || 0;
      return { id:l._id, dest:l.dest, expiresAt:l.expiresAt, createdAt:l.createdAt, expired:new Date(l.expiresAt)<new Date(), hitCount, lastHit:null };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

app.get('/api/links/:id/hits', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error:'Invalid ID' });
    const link = await Link.findOne({ _id:req.params.id, userId:req.session.userId }).lean();
    if (!link) return res.status(404).json({ error:'Not found' });
    res.json({ dest:link.dest, expiresAt:link.expiresAt, expired:new Date(link.expiresAt)<new Date(), hits:link.hits });
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

app.delete('/api/links/:id', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error:'Invalid ID' });
    const result = await Link.deleteOne({ _id:req.params.id, userId:req.session.userId });
    if (result.deletedCount===0) return res.status(404).json({ error:'Not found' });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

// ── TRACKING ──────────────────────────────────────────────────────────
app.get('/go/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.sendFile(path.join(__dirname,'public','expired.html'));
    const link = await Link.findById(req.params.id).select('expiresAt').lean();
    if (!link||new Date(link.expiresAt)<new Date()) return res.sendFile(path.join(__dirname,'public','expired.html'));
    res.sendFile(path.join(__dirname,'public','landing.html'));
  } catch(e) { res.sendFile(path.join(__dirname,'public','expired.html')); }
});

app.get('/api/hits/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error:'invalid' });
    const link = await Link.findById(req.params.id).select('dest expiresAt').lean();
    if (!link) return res.status(404).json({ error:'not found' });
    if (new Date(link.expiresAt)<new Date()) return res.status(410).json({ error:'expired' });
    res.json({ dest:link.dest });
  } catch(e) { res.status(500).json({ error:'error' }); }
});

app.post('/api/hit/:id', hitLimiter, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error:'invalid' });
    const link = await Link.findById(req.params.id).select('expiresAt dest').lean();
    if (!link) return res.status(404).json({ error:'not found' });
    if (new Date(link.expiresAt)<new Date()) return res.status(410).json({ error:'expired' });

    let { lat, lon, acc } = req.body;
    lat = (lat!==null&&lat!==undefined&&!isNaN(parseFloat(lat))) ? parseFloat(lat) : null;
    lon = (lon!==null&&lon!==undefined&&!isNaN(parseFloat(lon))) ? parseFloat(lon) : null;
    acc = (acc!==null&&acc!==undefined&&!isNaN(parseInt(acc)))   ? parseInt(acc)   : null;
    if (lat!==null&&(lat<-90||lat>90))   lat=null;
    if (lon!==null&&(lon<-180||lon>180)) lon=null;

    const ua = req.headers['user-agent']||'';
    let device='Unknown';
    if      (/iPhone/.test(ua))    device='iPhone';
    else if (/iPad/.test(ua))      device='iPad';
    else if (/Android/.test(ua))   device='Android';
    else if (/Windows/.test(ua))   device='Windows PC';
    else if (/Macintosh/.test(ua)) device='Mac';
    else if (/Linux/.test(ua))     device='Linux';

    let browser='Unknown';
    if      (/Edg\//.test(ua))     browser='Edge';
    else if (/OPR\//.test(ua))     browser='Opera';
    else if (/Chrome\//.test(ua))  browser='Chrome';
    else if (/Firefox\//.test(ua)) browser='Firefox';
    else if (/Safari\//.test(ua))  browser='Safari';

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress||'';
    await Link.findByIdAndUpdate(req.params.id, { $push:{ hits:{ lat,lon,acc,device,browser,ip,time:new Date() } } });
    console.log(`[HIT] ${req.params.id} → ${lat},${lon} | ${device}/${browser} | ${ip}`);
    res.json({ dest:link.dest });
  } catch(e) { console.error('Hit error:',e); res.status(500).json({ error:'error' }); }
});

// ── Health check ──────────────────────────────────────────────────────
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

// ── Pages ─────────────────────────────────────────────────────────────
app.get('/',          (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/dashboard', (req,res) => res.sendFile(path.join(__dirname,'public','dashboard.html')));
app.get('/donate',    (req,res) => res.sendFile(path.join(__dirname,'public','donate.html')));
app.use((req,res) => res.status(404).json({ error:'Not found' }));

// ── Start ─────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ GeoTrack running → port - ${PORT}`));