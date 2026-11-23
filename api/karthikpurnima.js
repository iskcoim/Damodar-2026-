// Karthik Purnima 2026 seva donations, through the KCM payment gateway.
// Works exactly like the Srila Prabhupada donations (api/prabhupada.js): the same Supabase table
// (prabhupada_donations, told apart by the festival column), the same gateway calls, name lookup
// and thank-you page with ?ref= status. Every seva uses scheme 2-52, which takes an amount.
// POST kind 'lookup' finds names for a mobile; POST kind 'donation' saves the pledge and opens checkout.
// GET ?ref=KP-XXXXXXXXXX is the public payment status for the thank-you page.
const crypto = require('crypto');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const FESTIVAL = 'Karthik Purnima 2026';
const TABLE = 'prabhupada_donations';
const SAVE_FAILED = 'Sorry, we could not save this. Please try again, or WhatsApp us on +91 90422 16108.';
const SCHEME = '2-52';

// Prices are set here on the server; whatever amount the browser sends is ignored.
const SEVAS = {
  'vaishnava-bhojan-10': { title: 'Vaishnava Bhojan · 10 Vaishnavas', price: 1501 },
  'vaishnava-bhojan-20': { title: 'Vaishnava Bhojan · 20 Vaishnavas', price: 3001 },
  'vaishnava-bhojan-40': { title: 'Vaishnava Bhojan · 40 Vaishnavas', price: 6001 },
  'vaishnava-bhojan-60': { title: 'Vaishnava Bhojan · 60 Vaishnavas', price: 9001 },
  'vaishnava-bhojan-108': { title: 'Vaishnava Bhojan · 108 Vaishnavas', price: 16108 },
  'adopt-cow-1m': { title: 'Adopt a Cow · 1 month', price: 2501 },
  'adopt-cow-3m': { title: 'Adopt a Cow · 3 months', price: 7501 },
  'adopt-cow-5m': { title: 'Adopt a Cow · 5 months', price: 12501 },
  'adopt-cow-1y': { title: 'Adopt a Cow · 1 year', price: 30001 },
  'annadhan-10': { title: 'Annadhan · 10 people', price: 501 },
  'annadhan-20': { title: 'Annadhan · 20 people', price: 1001 },
  'annadhan-50': { title: 'Annadhan · 50 people', price: 2501 },
  'annadhan-100': { title: 'Annadhan · 100 people', price: 5001 },
  'annadhan-200': { title: 'Annadhan · 200 people', price: 10001 },
  'feed-cows-1d': { title: 'Feed Cows · 1 day', price: 1101 },
  'feed-cows-3d': { title: 'Feed Cows · 3 days', price: 3301 },
  'feed-cows-7d': { title: 'Feed Cows · 7 days', price: 7701 },
  'feed-cows-15d': { title: 'Feed Cows · 15 days', price: 15001 },
  'feed-cows-30d': { title: 'Feed Cows · 30 days', price: 30001 },
  general: { title: 'Karthik Purnima Donation', price: null },
};
const MAX_ATTEMPTS_PER_HOUR = 10; // each attempt creates a real order at the gateway
const MAX_LOOKUPS_PER_HOUR = 20;
const GATEWAY_URL = (process.env.KCM_PAYMENT_GATEWAY_URL || 'https://iskconcoimbatore.com/api/kcm-payment-gateway').replace(/\/$/, '');
const siteUrl = () => (process.env.SITE_URL || 'https://events.iskconcoimbatore.com').replace(/\/$/, '');
const REF = /^KP-[A-F0-9]{10}$/;

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)
  : null;
// Only server.js (local testing) sets this; a live site with no database reports an error instead.
const localFile = process.env.PRABHUPADA_LOCAL_FILE;

function readLocal() {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(localFile, 'utf8')); } catch {}
  data[TABLE] = data[TABLE] || [];
  data.prabhupada_lookups = data.prabhupada_lookups || [];
  return data;
}
const writeLocal = (data) => fs.writeFileSync(localFile, JSON.stringify(data, null, 2));

async function insert(row) {
  if (supabase) {
    const { error } = await supabase.from(TABLE).insert([row]);
    if (error) throw new Error(error.message);
    return;
  }
  if (!localFile) throw new Error('No database configured');
  const data = readLocal();
  data[TABLE].unshift({ id: Date.now(), ...row, created_at: new Date().toISOString() });
  writeLocal(data);
}

async function updateDonation(reference, fields) {
  if (supabase) {
    const { error } = await supabase.from(TABLE).update(fields).eq('reference', reference);
    if (error) throw new Error(error.message);
    return;
  }
  const data = readLocal();
  const row = data[TABLE].find((d) => d.reference === reference);
  if (row) Object.assign(row, fields);
  writeLocal(data);
}

async function findDonation(reference) {
  if (supabase) {
    const { data, error } = await supabase.from(TABLE).select('*').eq('reference', reference).eq('festival', FESTIVAL).limit(1);
    if (error) throw new Error(error.message);
    return data[0] || null;
  }
  return readLocal()[TABLE].find((d) => d.reference === reference && d.festival === FESTIVAL) || null;
}

async function recentAttempts(phone) {
  const since = new Date(Date.now() - 3600000).toISOString();
  if (supabase) {
    const { count, error } = await supabase.from(TABLE).select('id', { count: 'exact', head: true }).eq('phone', phone).gte('created_at', since);
    if (error) throw new Error(error.message);
    return count || 0;
  }
  return readLocal()[TABLE].filter((d) => d.phone === phone && d.created_at >= since).length;
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

const visitorId = (req) => crypto.createHash('sha256')
  .update(`${process.env.ADMIN_KEY || ''}|${String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim()}`)
  .digest('hex').slice(0, 24);

/** Counts a lookup and says whether it is allowed (shared counter with the Prabhupada page). */
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
    data.prabhupada_lookups = data.prabhupada_lookups.filter((l) => l.created_at >= since);
    if (data.prabhupada_lookups.filter((l) => l.ip === ip).length >= MAX_LOOKUPS_PER_HOUR) return false;
    data.prabhupada_lookups.push({ ip, created_at: new Date().toISOString() });
    writeLocal(data);
    return true;
  } catch (err) {
    console.error('Lookup counter failed, allowing it:', err.message);
    return true;
  }
}

/** Names already on the temple's records for this mobile. With no name sent, nothing is created. */
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
  const open = { scheme_id: SCHEME, quantity: 1, amount_rupees: row.amount };
  const fixed = { scheme_id: SCHEME, quantity: 1 };
  const request = (item, key) => gateway('POST', '/checkout/sessions', {
    contact_id: contact.contact_id,
    mobileNo,
    first_Name: row.name,
    email: row.email || '',
    return_url: `${siteUrl()}/karthikpurnima/thank-you?ref=${row.reference}`,
    items: [item],
    remarks: `${row.reference} | Karthik Purnima | ${seva.title}`,
  }, key);
  // 2-52 takes an amount. Should the gateway say otherwise, ask once more the other way;
  // the price check below still refuses any charge that differs from the card.
  let session;
  try {
    session = await request(open, `checkout-${row.reference}`);
  } catch (err) {
    if (/amount_rupees.*(forbidden|not allowed|must not)/i.test(err.message)) session = await request(fixed, `checkout-${row.reference}-fixed`);
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
    const status = s.status === 'paid' && !s.receipt_id ? 'created' : s.status; // paid only once the receipt exists
    if (status === row.status && !s.payment_id) return row;
    const fields = { status, receipt_id: s.receipt_id || null, payment_id: s.payment_id || null, paid_at: s.paid_at || null, failure_reason: s.failure_reason || null };
    await updateDonation(row.reference, fields);
    return { ...row, ...fields };
  } catch (err) {
    console.error(`Gateway status check for ${row.reference} failed:`, err.message);
    return row;
  }
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const isMobile = (v) => /^[0-9+\-\s]{10,15}$/.test(v);
const isEmail = (v) => /^\S+@\S+\.\S+$/.test(v);
const hasLink = (v) => /(https?:\/\/|www\.|\.(com|net|org|ru|xyz|top|info)\b)/i.test(v);
const validIndian = (phone) => /^[6-9]\d{9}$/.test(phone.replace(/\D/g, '').slice(-10));

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const ref = String((req.query && req.query.ref) || '');
      const found = REF.test(ref) ? await findDonation(ref) : null;
      if (!found) return res.status(404).json({ error: 'We could not find this seva.' });
      const row = await syncDonation(found);
      // Only what the thank-you page shows, never the donor's contact details
      return res.status(200).json({ reference: row.reference, status: row.status, amount: row.amount, seva: row.seva, receipt_id: row.receipt_id || null, online: Boolean(row.session_id) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (clean(body.website, 200)) return res.status(200).json({ ok: true }); // bots fill the hidden field
    const elapsed = Number(body.elapsed);
    if (Number.isFinite(elapsed) && elapsed > 0 && elapsed < 1500) {
      return res.status(400).json({ error: 'Please take a moment to check your details, then send again.' });
    }

    if (body.kind === 'lookup') {
      const phone = clean(body.phone, 20);
      if (!validIndian(phone)) return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
      if (!process.env.KCM_PAYMENT_GATEWAY_SECRET) return res.status(200).json({ names: [] });
      if (!(await allowLookup(req))) return res.status(200).json({ names: [] });
      try {
        return res.status(200).json({ names: await lookupNames(phone) });
      } catch (err) {
        console.error('Name lookup failed:', err.message);
        return res.status(200).json({ names: [] }); // the donor simply types their name
      }
    }

    if (body.kind !== 'donation') return res.status(400).json({ error: 'Please reload the page and try again.' });
    const name = clean(body.name, 120);
    const phone = clean(body.phone, 20);
    const email = clean(body.email, 200).toLowerCase();
    if (name.length < 3) return res.status(400).json({ error: 'Please enter your full name, as it will appear on your receipt.' });
    if (hasLink(name)) return res.status(400).json({ error: 'Please check your name.' });
    if (!isMobile(phone) || !validIndian(phone)) return res.status(400).json({ error: 'Please enter a valid Indian mobile number.' });
    if (email && !isEmail(email)) return res.status(400).json({ error: 'Please check your email.' });

    const seva = Object.prototype.hasOwnProperty.call(SEVAS, body.seva) ? SEVAS[body.seva] : null;
    if (!seva) return res.status(400).json({ error: 'Please choose a seva.' });
    const amount = seva.price === null ? Math.round(Number(body.amount)) : seva.price;
    if (!Number.isFinite(amount) || amount < 1 || amount > 10000000) return res.status(400).json({ error: 'Please enter an amount.' });

    if ((await recentAttempts(phone)) >= MAX_ATTEMPTS_PER_HOUR) {
      return res.status(429).json({ error: 'Too many attempts from this number. Please try again in an hour, or WhatsApp us on +91 90422 16108.' });
    }

    const reference = `KP-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const row = { festival: FESTIVAL, seva: seva.title, scheme_id: SCHEME, name, phone, email: email || null, amount, reference, status: 'created' };
    await insert(row);

    // The pledge is saved either way, so a gateway problem never loses a donor
    let checkout = null;
    if (process.env.KCM_PAYMENT_GATEWAY_SECRET) {
      try {
        checkout = await startPayment(row, seva);
      } catch (err) {
        console.error(`Gateway: ${reference} could not start payment:`, err.message);
        await updateDonation(reference, { failure_reason: String(err.message).slice(0, 300) }).catch(() => {});
      }
    }
    return res.status(200).json({ ok: true, reference, amount, seva: seva.title, checkout });
  } catch (err) {
    console.error('Karthik Purnima form error:', err.message);
    return res.status(500).json({ error: SAVE_FAILED });
  }
};
