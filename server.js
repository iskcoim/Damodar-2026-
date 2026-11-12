const express = require('express');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const DATA_FILE = path.join(__dirname, 'registrations_local.json');

function readLocalRegistrations() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading local file:', e.message);
  }
  return [];
}

function saveLocalRegistration(entry) {
  try {
    const list = readLocalRegistrations();
    list.unshift(entry);
    fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('Error writing local file:', e.message);
  }
}

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  console.log('✅ Supabase client initialized.');
}

// POST /api/register
app.post('/api/register', async (req, res) => {
  const { name, phone, address, mentorName, mentor_name, email, area, capacity, prefWeek, notes } = req.body;
  if (!name || !phone || !address) {
    return res.status(400).json({ error: 'Please provide Name, Mobile Number, and Address.' });
  }

  const assignedMentor = mentor_name || mentorName || 'General / None';
  const assignedArea   = area || (address ? address.substring(0, 80) : 'Coimbatore');
  const assignedCap    = capacity || 'Family / Group';

  const entry = {
    id: Date.now(),
    name, phone, address,
    mentor_name: assignedMentor,
    area: assignedArea,
    capacity: assignedCap,
    email: email || '',
    pref_week: prefWeek || '',
    notes: notes || '',
    created_at: new Date().toISOString()
  };

  // Always save locally as backup
  saveLocalRegistration(entry);

  let dbSaved = false;
  if (supabase) {
    const { error } = await supabase.from('damodara_registrations').insert([{
      name,
      phone,
      email: email || null,
      area: assignedArea,
      address,
      capacity: assignedCap,
      mentor_name: assignedMentor,
      pref_week: prefWeek || null,
      notes: notes || null
    }]);
    if (error) {
      console.warn('Supabase save failed (saved to local backup):', error.message);
    } else {
      dbSaved = true;
    }
  }

  res.json({ ok: true, saved: true, dbSaved });
});

// GET /api/registrations (admin)
app.get('/api/registrations', async (req, res) => {
  if (req.headers['x-admin-key'] !== (process.env.ADMIN_KEY || 'local-test')) return res.status(401).json({ error: 'Incorrect password.' });
  if (supabase) {
    const { data, error } = await supabase
      .from('damodara_registrations')
      .select('*')
      .order('id', { ascending: false });
    if (!error) return res.json(data);
    console.warn('Supabase fetch failed, falling back to local file:', error.message);
  }
  const localRows = readLocalRegistrations();
  res.json(localRows);
});

// Srila Prabhupada Disappearance Day page. Saves to a local file when Supabase is not set up.
process.env.PRABHUPADA_LOCAL_FILE = path.join(__dirname, 'prabhupada_local.json');
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'local-test';
process.env.PRABHUPADA_MAX_VIDEO_MB = process.env.PRABHUPADA_MAX_VIDEO_MB || '500';
// A simulated payment gateway, so local testing never touches the real one
if (!process.env.KCM_PAYMENT_GATEWAY_SECRET) {
  process.env.KCM_PAYMENT_GATEWAY_SECRET = 'local-test';
  process.env.KCM_PAYMENT_GATEWAY_URL = `http://localhost:${PORT}/local-kcm`;
  // As on the live gateway, Book Distribution (3-75) takes an amount
  const CATALOG = { '3-72': 25001, '3-73': 5001, '3-74': 1501, '3-75': 0, '3-76': 0 };
  const sessions = new Map();
  // Sample donors: 9876543210 has one name on record, 9876500000 a family of two, others none
  const KNOWN = { '9876543210': [['Radha', 'Devi Dasi']], '9876500000': [['Krishna', 'Das'], ['Lalita', 'Devi']] };
  app.post('/local-kcm/contacts/resolve', (req, res) => {
    const known = KNOWN[req.body.mobileNo];
    if (known) return res.json({ success: true, contacts: known.map(([f, l], i) => ({ contact_id: `KCM-${i}`, first_Name: f, last_Name: l, mobileNo: req.body.mobileNo })) });
    if (!req.body.first_Name) return res.status(422).json({ success: false, error: 'contact_name_required' });
    res.json({ success: true, contacts: [{ contact_id: 'KCM-NEW', first_Name: req.body.first_Name, last_Name: '', mobileNo: req.body.mobileNo }] });
  });
  app.post('/local-kcm/checkout/sessions', (req, res) => {
    const [item] = req.body.items;
    const unit = CATALOG[item.scheme_id];
    if (unit === undefined) return res.status(422).json({ success: false, error: 'unknown_scheme' });
    if (unit > 0 && item.amount_rupees) return res.status(422).json({ success: false, error: 'amount_forbidden' });
    if (unit === 0 && !item.amount_rupees) return res.status(422).json({ success: false, error: 'invalid_schemes', message: `amount_rupees is required for open-amount scheme ${item.scheme_id}` });
    const rupees = process.env.LOCAL_KCM_PRICE_OFF ? unit + 1 : unit || item.amount_rupees;
    const id = `kpg_local${Date.now()}`;
    sessions.set(id, { status: 'created', amount: rupees });
    res.json({ success: true, session_id: id, order: { id: `order_${id}`, amount: rupees * 100 }, checkout: { key_id: 'rzp_test_local', amount: rupees * 100, currency: 'INR', order_id: `order_${id}`, callback_url: req.body.return_url } });
  });
  app.get('/local-kcm/checkout/sessions/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, session_id: req.params.id, ...s });
  });
  app.post('/local-kcm/simulate-paid/:id', (req, res) => {
    Object.assign(sessions.get(req.params.id) || {}, { status: 'paid', receipt_id: 'R-LOCAL-1', payment_id: 'pay_local', paid_at: new Date().toISOString() });
    res.json({ ok: true });
  });
}
app.all('/api/prabhupada', require('./api/prabhupada'));
// A small stand-in for Supabase's resumable uploads when testing locally
const LOCAL_UPLOADS = path.join(__dirname, 'prabhupada_local_uploads');
const localFilePath = (name) => (/^[a-f0-9]{24}\.[a-z0-9]{2,5}$/.test(name) ? path.join(LOCAL_UPLOADS, name) : null);
const tusBody = express.raw({ type: () => true, limit: '8mb' });
const tusAppend = (file, req) => {
  if (Buffer.isBuffer(req.body) && req.body.length) fs.appendFileSync(file, req.body);
  return fs.statSync(file).size;
};
app.post('/api/prabhupada-tus', tusBody, (req, res) => {
  const pairs = String(req.headers['upload-metadata'] || '').split(',').map((p) => p.trim().split(' '));
  const encoded = (pairs.find(([k]) => k === 'objectName') || [])[1] || '';
  const name = path.basename(Buffer.from(encoded, 'base64').toString());
  const file = localFilePath(name);
  if (!file) return res.status(400).end();
  fs.mkdirSync(LOCAL_UPLOADS, { recursive: true });
  fs.writeFileSync(file, '');
  fs.writeFileSync(`${file}.length`, String(req.headers['upload-length'] || 0));
  res.set({ 'Tus-Resumable': '1.0.0', Location: `/api/prabhupada-tus/${name}`, 'Upload-Offset': String(tusAppend(file, req)) }).status(201).end();
});
app.head('/api/prabhupada-tus/:file', (req, res) => {
  const file = localFilePath(req.params.file);
  if (!file || !fs.existsSync(file)) return res.status(404).end();
  res.set({ 'Tus-Resumable': '1.0.0', 'Cache-Control': 'no-store', 'Upload-Offset': String(fs.statSync(file).size), 'Upload-Length': fs.readFileSync(`${file}.length`, 'utf8') }).status(200).end();
});
app.patch('/api/prabhupada-tus/:file', tusBody, (req, res) => {
  const file = localFilePath(req.params.file);
  if (!file || !fs.existsSync(file)) return res.status(404).end();
  if (Number(req.headers['upload-offset']) !== fs.statSync(file).size) return res.status(409).end();
  res.set({ 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(tusAppend(file, req)) }).status(204).end();
});
app.get('/srila-prabhupada', (req, res) => {
  res.sendFile(path.join(__dirname, 'srila-prabhupada.html'));
});
app.get('/srila-prabhupada/offering', (req, res) => {
  res.sendFile(path.join(__dirname, 'srila-prabhupada-offering.html'));
});
app.get('/srila-prabhupada/thank-you', (req, res) => {
  res.sendFile(path.join(__dirname, 'srila-prabhupada-thank-you.html'));
});
app.get('/srila-prabhupada/donate', (req, res) => {
  res.sendFile(path.join(__dirname, 'srila-prabhupada-donate.html'));
});
app.get('/prabhupada-admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'prabhupada-admin.html'));
});

// Serve /admin console
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🪔  Damodar Month site → http://localhost:${PORT}\n`);
});
