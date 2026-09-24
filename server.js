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

function cronDowField(day) {
  if (!day || day === 'all') return '*';
  const idx = DOW.indexOf(day);
  return idx >= 0 ? String(idx) : '*';
}

function scheduleReminders(config) {
  scheduledTasks.forEach(t => t.stop());
  scheduledTasks = [];
  if (!config || !config.subscription) return;

  if (config.weight && config.weight.enabled && config.weight.time) {
    const [h, m] = config.weight.time.split(':').map(Number);
    scheduledTasks.push(cron.schedule(`${m} ${h} * * ${cronDowField(config.weight.day)}`, () =>
      sendReminder(config, 'Weight check-in', "Don't forget to log today's weight.", 'weight')));
  }
  if (config.photo && config.photo.enabled && config.photo.time) {
    const [h, m] = config.photo.time.split(':').map(Number);
    scheduledTasks.push(cron.schedule(`${m} ${h} * * ${cronDowField(config.photo.day)}`, () =>
      sendReminder(config, 'Progress photo', 'Time to take today\'s progress photo.', 'photo')));
  }
  if (config.shot && config.shot.enabled && config.shot.time) {
    const [h, m] = config.shot.time.split(':').map(Number);
    scheduledTasks.push(cron.schedule(`${m} ${h} * * ${cronDowField(config.shot.day)}`, () =>
      sendReminder(config, 'Injection day', "It's shot day — don't forget your injection.", 'shot')));
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

// ---------- Withings scale integration ----------
// On-demand only: nothing runs in the background and nothing is ever saved
// automatically. The app must be open and the person must tap "Check for
// new weigh-in" — then they see the raw reading and decide whether to keep
// it. This is deliberate: this scale is shared with other people in the
// house, and only a human, not a distance-from-last-weight guess, should
// decide whether a given reading is really theirs.
const WITHINGS_CLIENT_ID = process.env.WITHINGS_CLIENT_ID;
const WITHINGS_CLIENT_SECRET = process.env.WITHINGS_CLIENT_SECRET;
const WITHINGS_REDIRECT_URI = process.env.WITHINGS_REDIRECT_URI;
const TOKENS_FILE = path.join(DATA_DIR, 'withings-tokens.json');
const POLL_STATE_FILE = path.join(DATA_DIR, 'withings-poll-state.json');

function loadJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function saveJsonFile(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function kgToLbs(kg) { return Math.round(kg * 2.20462 * 10) / 10; }
function formatLocalDateTime(date) {
  const pad = n => String(n).padStart(2, '0');
  return {
    dateStr: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    timeStr: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

app.get('/withings/authorize', (req, res) => {
  if (!WITHINGS_CLIENT_ID || !WITHINGS_REDIRECT_URI) {
    return res.status(500).send('Withings integration not configured (missing client ID or redirect URI env vars).');
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: WITHINGS_CLIENT_ID,
    scope: 'user.metrics',
    redirect_uri: WITHINGS_REDIRECT_URI,
    state: Math.random().toString(36).slice(2),
  });
  res.redirect(`https://account.withings.com/oauth2_user/authorize2?${params.toString()}`);
});

app.get('/withings/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code.');
  try {
    const params = new URLSearchParams({
      action: 'requesttoken',
      client_id: WITHINGS_CLIENT_ID,
      client_secret: WITHINGS_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: WITHINGS_REDIRECT_URI,
    });
    const r = await fetch('https://wbsapi.withings.net/v2/oauth2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await r.json();
    if (data.status !== 0) throw new Error('Withings error status ' + data.status);
    const body = data.body;
    saveJsonFile(TOKENS_FILE, {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: Date.now() + body.expires_in * 1000,
      userid: body.userid,
    });
    // Only ever surface readings from the moment of connecting forward —
    // never backfill years of mixed-household scale history.
    saveJsonFile(POLL_STATE_FILE, { lastupdate: Math.floor(Date.now() / 1000) });
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Connected to Withings</h2><p>You can close this tab and go back to the app.</p></body></html>');
  } catch (e) {
    console.error('withings callback failed', e);
    res.status(500).send('Failed to connect to Withings: ' + e.message);
  }
});

async function getWithingsAccessToken() {
  const tokens = loadJsonFile(TOKENS_FILE, null);
  if (!tokens) return null;
  if (Date.now() < tokens.expires_at - 60000) return tokens.access_token;
  const params = new URLSearchParams({
    action: 'requesttoken',
    client_id: WITHINGS_CLIENT_ID,
    client_secret: WITHINGS_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });
  const r = await fetch('https://wbsapi.withings.net/v2/oauth2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await r.json();
  if (data.status !== 0) { console.error('withings token refresh failed', data); return null; }
  const body = data.body;
  saveJsonFile(TOKENS_FILE, {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + body.expires_in * 1000,
    userid: body.userid,
  });
  return body.access_token;
}

app.get('/withings/status', checkAuth, (req, res) => {
  res.json({ connected: !!loadJsonFile(TOKENS_FILE, null) });
});

// Called only when the person taps "Check for new weigh-in" in the app.
// Returns raw candidate readings since the last check — never writes them
// anywhere and never decides on the person's behalf. Advances the
// lastupdate marker immediately so the same reading isn't offered twice,
// regardless of whether the person accepts or dismisses it.
app.get('/withings/check', checkAuth, async (req, res) => {
  const accessToken = await getWithingsAccessToken();
  if (!accessToken) return res.status(400).json({ error: 'not connected' });
  const pollState = loadJsonFile(POLL_STATE_FILE, { lastupdate: 0 });
  try {
    const params = new URLSearchParams({ action: 'getmeas', meastypes: '1', lastupdate: String(pollState.lastupdate) });
    const r = await fetch('https://wbsapi.withings.net/measure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Bearer ' + accessToken },
      body: params.toString(),
    });
    const data = await r.json();
    if (data.status !== 0) return res.status(502).json({ error: 'withings error ' + data.status });
    const groups = ((data.body && data.body.measuregrps) || []).slice().sort((a, b) => a.date - b.date);
    const readings = [];
    for (const grp of groups) {
      const weightMeasure = (grp.measures || []).find(m => m.type === 1);
      if (!weightMeasure) continue;
      const lbs = kgToLbs(weightMeasure.value * Math.pow(10, weightMeasure.unit));
      const { dateStr, timeStr } = formatLocalDateTime(new Date(grp.date * 1000));
      readings.push({ id: 'withings-' + grp.grpid, date: dateStr, time: timeStr, weight: lbs });
    }
    if (data.body && data.body.updatetime) saveJsonFile(POLL_STATE_FILE, { lastupdate: data.body.updatetime });
    res.json({ readings });
  } catch (e) {
    console.error('withings check error', e);
    res.status(500).json({ error: 'check failed' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(3000, () => console.log('glp1-backup listening on 3000'));
