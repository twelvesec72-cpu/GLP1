const express = require('express');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const cron = require('node-cron');
const app = express();
app.use(express.json({ limit: '15mb' }));

const DATA_DIR = '/data';
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.json');
const API_KEY = process.env.API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,X-Api-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function checkAuth(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---------- weight / injection log backup (unchanged) ----------
app.post('/backup', checkAuth, (req, res) => {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = JSON.stringify(req.body, null, 2);
  fs.writeFileSync(path.join(DATA_DIR, 'latest.json'), payload);
  fs.writeFileSync(path.join(SNAP_DIR, `backup_${ts}.json`), payload);
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(SNAP_DIR)) {
    const fp = path.join(SNAP_DIR, f);
    if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
  }
  res.json({ status: 'ok', timestamp: ts });
});

app.get('/backup', checkAuth, (req, res) => {
  const latest = path.join(DATA_DIR, 'latest.json');
  if (!fs.existsSync(latest)) return res.status(404).json({ error: 'no backup yet' });
  res.sendFile(latest);
});

// ---------- progress photos (unchanged) ----------
app.post('/photos/:date', checkAuth, (req, res) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'bad date format, expected YYYY-MM-DD' });
  if (!req.body.image) return res.status(400).json({ error: 'missing image field (base64)' });
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  try {
    const buf = Buffer.from(req.body.image, 'base64');
    fs.writeFileSync(path.join(PHOTO_DIR, `${date}.jpg`), buf);
    res.json({ status: 'ok', date });
  } catch (e) {
    res.status(400).json({ error: 'could not decode image' });
  }
});

app.get('/photos', checkAuth, (req, res) => {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const dates = fs.readdirSync(PHOTO_DIR)
    .filter(f => f.endsWith('.jpg'))
    .map(f => f.replace(/\.jpg$/, ''))
    .sort();
  res.json({ dates });
});

app.get('/photos/:date', checkAuth, (req, res) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'bad date format' });
  const file = path.join(PHOTO_DIR, `${date}.jpg`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'no photo for that date' });
  res.type('image/jpeg').sendFile(file);
});

app.delete('/photos/:date', checkAuth, (req, res) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'bad date format' });
  const file = path.join(PHOTO_DIR, `${date}.jpg`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ status: 'ok' });
});

// ---------- reminders: push subscription + schedule ----------
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
let scheduledTasks = [];

function loadReminders() {
  if (!fs.existsSync(REMINDERS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8')); } catch (e) { return null; }
}

function saveReminders(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(config, null, 2));
}

function sendReminder(config, title, body, tag) {
  if (!config.subscription) return;
  webpush.sendNotification(config.subscription, JSON.stringify({ title, body, tag }))
    .catch(e => console.error('push send failed for', tag, e.message));
}

function scheduleReminders(config) {
  scheduledTasks.forEach(t => t.stop());
  scheduledTasks = [];
  if (!config || !config.subscription) return;

  if (config.weight && config.weight.enabled && config.weight.time) {
    const [h, m] = config.weight.time.split(':').map(Number);
    scheduledTasks.push(cron.schedule(`${m} ${h} * * *`, () =>
      sendReminder(config, 'Weight check-in', "Don't forget to log today's weight.", 'weight')));
  }
  if (config.photo && config.photo.enabled && config.photo.time) {
    const [h, m] = config.photo.time.split(':').map(Number);
    scheduledTasks.push(cron.schedule(`${m} ${h} * * *`, () =>
      sendReminder(config, 'Progress photo', 'Time to take today\'s progress photo.', 'photo')));
  }
  if (config.shot && config.shot.enabled && config.shot.time && config.shot.day) {
    const [h, m] = config.shot.time.split(':').map(Number);
    const dowIndex = DOW.indexOf(config.shot.day);
    if (dowIndex >= 0) {
      scheduledTasks.push(cron.schedule(`${m} ${h} * * ${dowIndex}`, () =>
        sendReminder(config, 'Injection day', "It's shot day — don't forget your injection.", 'shot')));
    }
  }
  console.log(`Scheduled ${scheduledTasks.length} reminder task(s)`);
}

app.post('/reminders', checkAuth, (req, res) => {
  const config = req.body;
  saveReminders(config);
  scheduleReminders(config);
  res.json({ status: 'ok' });
});

app.get('/reminders', checkAuth, (req, res) => {
  const config = loadReminders();
  if (!config) return res.status(404).json({ error: 'no reminders configured' });
  res.json(config);
});

app.get('/vapid-public-key', checkAuth, (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/reminders/test', checkAuth, (req, res) => {
  const config = loadReminders();
  if (!config || !config.subscription) return res.status(400).json({ error: 'no subscription saved yet' });
  sendReminder(config, 'Test reminder', 'If you can see this, push notifications are working.', 'test');
  res.json({ status: 'ok' });
});

// reschedule on container start in case of a restart
scheduleReminders(loadReminders());

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(3000, () => console.log('glp1-backup listening on 3000'));
