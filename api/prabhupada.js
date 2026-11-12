// Srila Prabhupada Tirobhava Mahotsava (Disappearance Day):
// POST saves offerings and seva pledges, and hands out upload slots for offering files.
// GET lists them for staff (needs the ADMIN_KEY environment variable).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const FESTIVAL = 'Srila Prabhupada Tirobhava Mahotsava 2026';
const TABLES = { offering: 'prabhupada_offerings', donation: 'prabhupada_donations' };
const BUCKET = 'prabhupada-offerings';
const SAVE_FAILED = 'Sorry, we could not save this. Please try again, or WhatsApp us on +91 90422 16108.';
const MB = 1024 * 1024;
// Plain media only: no HTML or SVG, which could run code when staff open them
const UPLOADS = {
  audio: { maxBytes: 50 * MB, exts: ['mp3', 'm4a', 'wav', 'ogg', 'oga', 'aac', 'opus', 'amr', 'webm'] },
  // 50 MB is Supabase's free plan ceiling. After upgrading, set PRABHUPADA_MAX_VIDEO_MB (see supabase-prabhupada.sql).
  video: { maxBytes: (Number(process.env.PRABHUPADA_MAX_VIDEO_MB) || 50) * MB, exts: ['mp4', 'mov', 'webm', '3gp', 'mkv', 'm4v'] },
  scan: { maxBytes: 25 * MB, exts: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf'] },
};
const EXT_BY_TYPE = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp', 'video/x-matroska': 'mkv', 'video/x-m4v': 'm4v',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/amr': 'amr',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
};
// Fixed-price schemes: the gateway charges its own catalog price, so `price` must match it.
// A mismatch is refused rather than charging a donor something other than what the card showed.
const SEVAS = {
  feast: { scheme: '3-72', title: 'Feast Sponsorship', price: 25001 },
  flower: { scheme: '3-73', title: 'Flower Decoration', price: 5001 },
  bhoga: { scheme: '3-74', title: 'Bhoga Offering', price: 1501 },
  book: { scheme: '3-75', title: 'Book Distribution', price: 1008 },
  general: { scheme: '3-76', title: 'General Donation', price: null },
};
const MAX_ATTEMPTS_PER_HOUR = 10; // each attempt creates a real order at the gateway
const GATEWAY_URL = (process.env.KCM_PAYMENT_GATEWAY_URL || 'https://iskconcoimbatore.com/api/kcm-payment-gateway').replace(/\/$/, '');
const siteUrl = () => (process.env.SITE_URL || 'https://events.iskconcoimbatore.com').replace(/\/$/, '');
const FILE_PATH = /^offerings\/[a-f0-9]{24}\.[a-z0-9]{2,5}$/;

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)
  : null;
// Only server.js (local testing) sets this. Vercel never does, so a live site with no database
// reports an error rather than telling someone their offering was saved.
const localFile = process.env.PRABHUPADA_LOCAL_FILE;

function readLocal() {
  try {
    return JSON.parse(fs.readFileSync(localFile, 'utf8'));
  } catch {
    return { prabhupada_offerings: [], prabhupada_donations: [], prabhupada_lookups: [] };
  }
}

async function insert(table, row) {
  if (supabase) {
    const { error } = await supabase.from(table).insert([row]);
    if (error) throw new Error(error.message);
    return;
  }
  if (!localFile) throw new Error('No database configured');
  const data = readLocal();
  data[table].unshift({ id: Date.now(), ...row, created_at: new Date().toISOString() });
  fs.writeFileSync(localFile, JSON.stringify(data, null, 2));
}

async function list(table) {
  if (supabase) {
    const { data, error } = await supabase.from(table).select('*').order('id', { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  }
  if (!localFile) throw new Error('No database configured');
  return readLocal()[table];
}

async function updateDonation(reference, fields) {
  if (supabase) {
    const { error } = await supabase.from(TABLES.donation).update(fields).eq('reference', reference);
    if (error) throw new Error(error.message);
    return;
  }
  const data = readLocal();
  const row = data[TABLES.donation].find((d) => d.reference === reference);
  if (row) Object.assign(row, fields);
  fs.writeFileSync(localFile, JSON.stringify(data, null, 2));
}

async function findDonation(reference) {
  if (supabase) {
    const { data, error } = await supabase.from(TABLES.donation).select('*').eq('reference', reference).limit(1);
    if (error) throw new Error(error.message);
    return data[0] || null;
  }
  return readLocal()[TABLES.donation].find((d) => d.reference === reference) || null;
}

async function recentAttempts(phone) {
  const since = new Date(Date.now() - 3600000).toISOString();
  if (supabase) {
    const { count, error } = await supabase.from(TABLES.donation).select('id', { count: 'exact', head: true }).eq('phone', phone).gte('created_at', since);
    if (error) throw new Error(error.message);
    return count || 0;
  }
  return readLocal()[TABLES.donation].filter((d) => d.phone === phone && d.created_at >= since).length;
}

/** One call to the KCM gateway. The secret never leaves this server. */
async function gateway(method, route, body, idempotencyKey) {
  const send = () => fetch(`${GATEWAY_URL}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.KCM_PAYMENT_GATEWAY_SECRET}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  let res;
  try {
    res = await send();
  } catch {
    res = await send(); // after a network failure the gateway asks for the same key and body again
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(`${res.status} ${json.error || 'gateway_error'}: ${json.message || ''}`);
  return json;
}

/** The contact whose name best matches what the donor typed, else the first (a family may share a mobile). */
function pickContact(contacts, name) {
  const n = name.trim().toLowerCase();
  const full = (c) => `${c.first_Name} ${c.last_Name || ''}`.trim().toLowerCase();
  return contacts.find((c) => full(c) === n)
    || contacts.find((c) => c.first_Name.trim().toLowerCase() === n.split(/\s+/)[0])
    || contacts[0];
}

const MAX_LOOKUPS_PER_HOUR = 20; // per visitor, so nobody can run through numbers collecting names
const visitorId = (req) => crypto.createHash('sha256')
  .update(`${process.env.ADMIN_KEY || ''}|${String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim()}`)
  .digest('hex').slice(0, 24);

/** Counts a lookup and says whether it is allowed. If the counter itself fails, the lookup is allowed. */
async function allowLookup(req) {
  const ip = visitorId(req);
  const since = new Date(Date.now() - 3600000).toISOString();
  try {
    if (supabase) {
      const { count, error } = await supabase.from('prabhupada_lookups').select('id', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', since);
      if (error) throw new Error(error.message);
      if ((count || 0) >= MAX_LOOKUPS_PER_HOUR) return false;
      await supabase.from('prabhupada_lookups').insert([{ ip }]);
      return true;
    }
    const data = readLocal();
    data.prabhupada_lookups = (data.prabhupada_lookups || []).filter((l) => l.created_at >= since);
    if (data.prabhupada_lookups.filter((l) => l.ip === ip).length >= MAX_LOOKUPS_PER_HOUR) return false;
    data.prabhupada_lookups.push({ ip, created_at: new Date().toISOString() });
    fs.writeFileSync(localFile, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('Lookup counter failed, allowing it:', err.message);
    return true;
  }
}

/**
 * Names already on the temple's records for this mobile, so the donor need not type theirs.
 * A pure lookup: with no name sent, the gateway never creates a contact.
 */
async function lookupNames(mobile) {
  const mobileNo = mobile.replace(/\D/g, '').slice(-10);
  const day = new Date().toISOString().slice(0, 10);
  try {
    const res = await gateway('POST', '/contacts/resolve', { mobileNo }, `lookup-${mobileNo}-${day}`);
    const names = (res.contacts || []).map((c) => `${c.first_Name || ''} ${c.last_Name || ''}`.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return [...new Set(names)].slice(0, 6);
  } catch (err) {
    if (/contact_name_required|422/.test(err.message)) return []; // a new donor
    throw err;
  }
}

/** Opens a checkout session for a saved donation. Returns what the browser needs to pay. */
async function startPayment(row, seva) {
  const mobileNo = row.phone.replace(/\D/g, '').slice(-10);
  const { contacts } = await gateway('POST', '/contacts/resolve', { mobileNo, first_Name: row.name, email: row.email || '' }, `contact-${row.reference}`);
  const contact = pickContact(contacts, row.name);
  const open = { scheme_id: seva.scheme, quantity: 1, amount_rupees: row.amount };
  const fixed = { scheme_id: seva.scheme, quantity: 1 };
  const request = (item, key) => gateway('POST', '/checkout/sessions', {
    contact_id: contact.contact_id,
    mobileNo,
    first_Name: row.name,
    email: row.email || '',
    return_url: `${siteUrl()}/srila-prabhupada/thank-you?ref=${row.reference}`,
    items: [item],
    remarks: `${row.reference} | Tirobhava Mahotsava | ${seva.title}`,
  }, key);
  // The gateway's catalog decides whether a scheme takes an amount. If our guess is wrong, it says
  // so without creating anything, and we ask once more the other way (the price check below still applies).
  let session;
  const first = seva.price === null ? open : fixed;
  try {
    session = await request(first, `checkout-${row.reference}`);
  } catch (err) {
    if (first === fixed && /amount_rupees is required/i.test(err.message)) session = await request(open, `checkout-${row.reference}-open`);
    else if (first === open && /amount_rupees.*(forbidden|not allowed|must not)/i.test(err.message)) session = await request(fixed, `checkout-${row.reference}-fixed`);
    else throw err;
  }
  const charged = Math.round(session.order.amount / 100);
  await updateDonation(row.reference, { session_id: session.session_id, contact_id: contact.contact_id });
  if (charged !== row.amount) throw new Error(`price mismatch: card ${row.amount}, gateway ${charged}`);
  return session.checkout;
}

/** Asks the gateway, the only source of truth, about a donation still awaiting payment. */
async function syncDonation(row) {
  if (row.status !== 'created' || !row.session_id || !process.env.KCM_PAYMENT_GATEWAY_SECRET) return row;
  try {
    const s = await gateway('GET', `/checkout/sessions/${encodeURIComponent(row.session_id)}`);
    // Paid only counts once the receipt exists
    const status = s.status === 'paid' && !s.receipt_id ? 'created' : s.status;
    if (status === row.status && !s.payment_id) return row;
    const fields = { status, receipt_id: s.receipt_id || null, payment_id: s.payment_id || null, paid_at: s.paid_at || null, failure_reason: s.failure_reason || null };
    await updateDonation(row.reference, fields);
    return { ...row, ...fields };
  } catch (err) {
    console.error(`Gateway status check for ${row.reference} failed:`, err.message);
    return row;
  }
}

/** Adds a short-lived link to each offering's file, for staff. */
async function withFileUrls(offerings) {
  const paths = offerings.map((o) => o.file_path).filter(Boolean);
  if (!paths.length) return offerings;
  if (!supabase) {
    return offerings.map((o) => (o.file_path ? { ...o, file_url: `/prabhupada_local_uploads/${path.basename(o.file_path)}` } : o));
  }
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
  if (error) throw new Error(error.message);
  const urls = new Map(data.map((d) => [d.path, d.signedUrl]));
  return offerings.map((o) => (o.file_path ? { ...o, file_url: urls.get(o.file_path) || null } : o));
}

/**
 * Files go straight from the browser to storage, as Vercel limits requests to 4.5 MB. They go in
 * small resumable pieces (the TUS protocol), so a weak connection can pick up where it stopped.
 */
async function uploadSlot(body) {
  const rule = UPLOADS[body.type];
  if (!rule) return { error: 'Please reload the page and try again.' };
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) return { error: 'Please choose your file again.' };
  if (size > rule.maxBytes) return { error: `This file is larger than ${rule.maxBytes / MB} MB. Please choose a smaller one.` };
  // Some phone galleries give files no extension, so fall back on the file's type
  const named = path.extname(String(body.name ?? '')).slice(1).toLowerCase();
  const ext = rule.exts.includes(named) ? named : EXT_BY_TYPE[String(body.contentType ?? '').split(';')[0].toLowerCase()];
  if (!rule.exts.includes(ext)) return { error: 'Please choose a different kind of file. This one is not supported.' };

  const filePath = `offerings/${crypto.randomBytes(12).toString('hex')}.${ext}`;
  if (supabase) {
    if (!process.env.SUPABASE_PUBLISHABLE_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY is not set');
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(filePath);
    if (error) throw new Error(error.message);
    return {
      ok: true,
      path: filePath,
      bucket: BUCKET,
      // The direct storage address is the one Supabase recommends for large files
      endpoint: `${process.env.SUPABASE_URL.replace(/\/$/, '').replace('.supabase.co', '.storage.supabase.co')}/storage/v1/upload/resumable/sign`,
      headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, 'x-signature': data.token },
    };
  }
  if (!localFile) throw new Error('No storage configured');
  return { ok: true, path: filePath, bucket: BUCKET, endpoint: '/api/prabhupada-tus', headers: {} };
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const isMobile = (v) => /^[0-9+\-\s]{10,15}$/.test(v);
const isEmail = (v) => /^\S+@\S+\.\S+$/.test(v);
const hasLink = (v) => /(https?:\/\/|www\.|\.(com|net|org|ru|xyz|top|info)\b)/i.test(v);

function checkOffering(body) {
  const type = ['text', 'audio', 'video', 'scan'].includes(body.type) ? body.type : 'text';
  const row = { offering_type: type, offering: null, file_path: null, file_name: null, link: null };

  if (type === 'text') {
    const offering = String(body.offering ?? '').trim();
    if (!offering) return { error: 'Please write your offering.' };
    if (offering.length > 5000) return { error: 'Please keep your offering under 5,000 characters.' };
    if ((offering.match(/https?:\/\/|www\./gi) ?? []).length >= 2) return { error: 'Please remove any web links from your offering.' };
    return { row: { ...row, offering } };
  }

  const link = clean(body.link, 500);
  if (type === 'video' && link) {
    if (!/^https:\/\/\S+$/.test(link)) return { error: 'Please check the link. It should start with https://' };
    return { row: { ...row, link } };
  }
  const filePath = clean(body.filePath, 100);
  if (!FILE_PATH.test(filePath)) return { error: 'Please choose your file again.' };
  return { row: { ...row, file_path: filePath, file_name: clean(body.fileName, 200) || null } };
}

/** Returns { error } for the visitor, or { table, row, reply } to save. */
function validate(body) {
  const name = clean(body.name, 120);
  const phone = clean(body.phone, 20);
  const email = clean(body.email, 200).toLowerCase();
  if (!name) return { error: 'Please enter your name.' };
  if (hasLink(name)) return { error: 'Please check your name.' };
  if (!isMobile(phone)) return { error: 'Please enter a valid mobile number.' };
  if (email && !isEmail(email)) return { error: 'Please check your email.' };

  if (body.kind === 'offering') {
    const checked = checkOffering(body);
    if (checked.error) return checked;
    return {
      table: TABLES.offering,
      row: { festival: FESTIVAL, name, phone, email: email || null, place: clean(body.place, 120) || null, may_share: body.mayShare === true, ...checked.row },
      reply: {},
    };
  }

  if (body.kind === 'donation') {
    const seva = Object.prototype.hasOwnProperty.call(SEVAS, body.seva) ? SEVAS[body.seva] : null;
    if (!seva) return { error: 'Please choose a seva.' };
    // Fixed-price sevas ignore whatever amount the browser sends
    const amount = seva.price === null ? Math.round(Number(body.amount)) : seva.price;
    if (!Number.isFinite(amount) || amount < 1 || amount > 10000000) return { error: 'Please enter an amount.' };
    if (name.length < 3) return { error: 'Please enter your full name, as it will appear on your receipt.' };
    if (!/^[6-9]\d{9}$/.test(phone.replace(/\D/g, '').slice(-10))) return { error: 'Please enter a valid Indian mobile number.' };
    const reference = `PSD-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    return {
      table: TABLES.donation,
      seva,
      row: { festival: FESTIVAL, seva: seva.title, scheme_id: seva.scheme, name, phone, email: email || null, amount, reference, status: 'created' },
      reply: { reference, amount, seva: seva.title },
    };
  }

  return { error: 'Please reload the page and try again.' };
}

function keyMatches(given) {
  const expected = process.env.ADMIN_KEY;
  if (!expected || !given) return false;
  const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(hash(given), hash(expected));
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      // Bots fill the hidden "website" field: pretend it worked
      if (clean(body.website, 200)) return res.status(200).json({ ok: true });
      const elapsed = Number(body.elapsed);
      if (Number.isFinite(elapsed) && elapsed > 0 && elapsed < 1500) {
        return res.status(400).json({ error: 'Please take a moment to check your details, then send again.' });
      }
      if (body.kind === 'lookup') {
        const phone = clean(body.phone, 20);
        if (!/^[6-9]\d{9}$/.test(phone.replace(/\D/g, '').slice(-10))) return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
        if (!process.env.KCM_PAYMENT_GATEWAY_SECRET) return res.status(200).json({ names: [] });
        if (!(await allowLookup(req))) return res.status(200).json({ names: [] });
        try {
          return res.status(200).json({ names: await lookupNames(phone) });
        } catch (err) {
          console.error('Name lookup failed:', err.message);
          return res.status(200).json({ names: [] }); // the donor simply types their name
        }
      }
      if (body.kind === 'upload') {
        const slot = await uploadSlot(body);
        return res.status(slot.error ? 400 : 200).json(slot);
      }
      const checked = validate(body);
      if (checked.error) return res.status(400).json({ error: checked.error });
      if (checked.seva && (await recentAttempts(checked.row.phone)) >= MAX_ATTEMPTS_PER_HOUR) {
        return res.status(429).json({ error: 'Too many attempts from this number. Please try again in an hour, or WhatsApp us on +91 90422 16108.' });
      }
      await insert(checked.table, checked.row);
      if (!checked.seva) return res.status(200).json({ ok: true, ...checked.reply });

      // The pledge is saved either way, so a gateway problem never loses a donor
      let checkout = null;
      if (process.env.KCM_PAYMENT_GATEWAY_SECRET) {
        try {
          checkout = await startPayment(checked.row, checked.seva);
        } catch (err) {
          console.error(`Gateway: ${checked.row.reference} could not start payment:`, err.message);
          await updateDonation(checked.row.reference, { failure_reason: String(err.message).slice(0, 300) }).catch(() => {});
        }
      }
      return res.status(200).json({ ok: true, ...checked.reply, checkout });
    }

    if (req.method === 'GET') {
      if (req.query && req.query.limits) {
        return res.status(200).json({ audio: UPLOADS.audio.maxBytes / MB, video: UPLOADS.video.maxBytes / MB, scan: UPLOADS.scan.maxBytes / MB });
      }
      if (req.query && req.query.ref) {
        const ref = String(req.query.ref);
        const found = /^PSD-[A-F0-9]{10}$/.test(ref) ? await findDonation(ref) : null;
        if (!found) return res.status(404).json({ error: 'We could not find this seva.' });
        const row = await syncDonation(found);
        // Only what the thank-you page shows, never the donor's contact details
        return res.status(200).json({ reference: row.reference, status: row.status, amount: row.amount, seva: row.seva, receipt_id: row.receipt_id || null, online: Boolean(row.session_id) });
      }
      if (!keyMatches(req.headers['x-admin-key'])) return res.status(401).json({ error: 'Incorrect staff key.' });
      const [offerings, donations] = await Promise.all([list(TABLES.offering), list(TABLES.donation)]);
      // Donors who close the page after paying still show correctly here
      const synced = await Promise.all(donations.map((d, i) => (i < 30 ? syncDonation(d) : d)));
      return res.status(200).json({ offerings: await withFileUrls(offerings), donations: synced });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('Prabhupada form error:', err.message);
    return res.status(500).json({ error: SAVE_FAILED });
  }
};
