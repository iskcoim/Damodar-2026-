// Sharad Purnima 2026 — seva donations via KCM payment gateway (same key as prabhupada).
const crypto = require('crypto');
const fs     = require('fs');
const { createClient } = require('@supabase/supabase-js');

const FESTIVAL = 'Karthik Purnima Festival';
const TABLE    = 'sharadpurnima_donations';
const SAVE_FAILED = 'Sorry, we could not save this. Please try again, or WhatsApp us on +91 97910 02556.';

// All sevas use the open-amount scheme (2-52) so a single KCM catalog entry covers all.
// Preset prices are enforced server-side; the browser cannot override them.
const SEVAS = {
  'moonlit-kheer':      { scheme: '2-52', title: 'Moonlit Kheer Distribution', price: 1008  },
  'flower-decoration':  { scheme: '2-52', title: 'White Flower Decoration',    price: 2108  },
  'abhishek':           { scheme: '2-52', title: 'Special Abhishek Seva',       price: 5116  },
  'prasadam-feast':     { scheme: '2-52', title: 'Grand Karthik Purnima Feast', price: 10116 },
  'ghee-lamp':          { scheme: '2-52', title: 'Ghee Lamp Offering',          price: 501   },
  'general':            { scheme: '2-52', title: 'Your Offering',               price: null  },
};

const MAX_ATTEMPTS_PER_HOUR = 10;
const GATEWAY_URL = (process.env.KCM_PAYMENT_GATEWAY_URL || 'https://iskconcoimbatore.com/api/kcm-payment-gateway').replace(/\/$/, '');
const siteUrl = () => (process.env.SITE_URL || 'https://events.iskconcoimbatore.com').replace(/\/$/, '');

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)
  : null;
const localFile = process.env.PRABHUPADA_LOCAL_FILE;

function readLocal() {
  try { return JSON.parse(fs.readFileSync(localFile, 'utf8')); }
  catch { return {}; }
}

async function insert(row) {
  if (supabase) {
    const { error } = await supabase.from(TABLE).insert([row]);
    if (error) throw new Error(error.message);
    return;
  }
  if (!localFile) throw new Error('No database configured');
  const data = readLocal();
  if (!data[TABLE]) data[TABLE] = [];
  data[TABLE].unshift({ id: Date.now(), ...row, created_at: new Date().toISOString() });
  fs.writeFileSync(localFile, JSON.stringify(data, null, 2));
}

async function recentAttempts(phone) {
  const since = new Date(Date.now() - 3600000).toISOString();
  if (supabase) {
    const { count, error } = await supabase.from(TABLE).select('id', { count: 'exact', head: true }).eq('phone', phone).gte('created_at', since);
    if (error) throw new Error(error.message);
    return count || 0;
  }
  return ((readLocal()[TABLE]) || []).filter(d => d.phone === phone && d.created_at >= since).length;
}

async function updateDonation(reference, fields) {
  if (supabase) {
    const { error } = await supabase.from(TABLE).update(fields).eq('reference', reference);
    if (error) throw new Error(error.message);
    return;
  }
  const data = readLocal();
  const row = (data[TABLE] || []).find(d => d.reference === reference);
  if (row) Object.assign(row, fields);
  fs.writeFileSync(localFile, JSON.stringify(data, null, 2));
}

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
  try { res = await send(); } catch { res = await send(); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(`${res.status} ${json.error || 'gateway_error'}: ${json.message || ''}`);
  return json;
}

function pickContact(contacts, name) {
  const n = name.trim().toLowerCase();
  const full = c => `${c.first_Name} ${c.last_Name || ''}`.trim().toLowerCase();
  return contacts.find(c => full(c) === n)
    || contacts.find(c => c.first_Name.trim().toLowerCase() === n.split(/\s+/)[0])
    || contacts[0];
}

async function lookupNames(mobile) {
  const mobileNo = mobile.replace(/\D/g, '').slice(-10);
  const day = new Date().toISOString().slice(0, 10);
  try {
    const res = await gateway('POST', '/contacts/resolve', { mobileNo }, `sp-lookup-${mobileNo}-${day}`);
    const names = (res.contacts || []).map(c => `${c.first_Name || ''} ${c.last_Name || ''}`.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return [...new Set(names)].slice(0, 6);
  } catch (err) {
    if (/contact_name_required|422/.test(err.message)) return [];
    throw err;
  }
}

async function startPayment(row, seva) {
  const mobileNo = row.phone.replace(/\D/g, '').slice(-10);
  const { contacts } = await gateway('POST', '/contacts/resolve',
    { mobileNo, first_Name: row.name, email: row.email || '' },
    `sp-contact-${row.reference}`);
  const contact = pickContact(contacts, row.name);
  const session = await gateway('POST', '/checkout/sessions', {
    contact_id: contact.contact_id,
    mobileNo,
    first_Name: row.name,
    email: row.email || '',
    return_url: `${siteUrl()}/sharadpurnima?ref=${row.reference}`,
    items: [{ scheme_id: seva.scheme, quantity: 1, amount_rupees: row.amount }],
    remarks: `${row.reference} | ${FESTIVAL} | ${seva.title}`,
  }, `sp-checkout-${row.reference}`);
  const charged = Math.round(session.order.amount / 100);
  await updateDonation(row.reference, { session_id: session.session_id, contact_id: contact.contact_id });
  if (charged !== row.amount) throw new Error(`price mismatch: form ${row.amount}, gateway ${charged}`);
  return session.checkout;
}

const clean   = (v, max) => String(v ?? '').trim().slice(0, max);
const isMob   = v => /^[0-9+\-\s]{10,15}$/.test(v);
const isEmail = v => /^\S+@\S+\.\S+$/.test(v);
const hasLink = v => /(https?:\/\/|www\.|\.(com|net|org|ru|xyz|top|info)\b)/i.test(v);

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (clean(body.website, 200)) return res.status(200).json({ ok: true });
    const elapsed = Number(body.elapsed);
    if (Number.isFinite(elapsed) && elapsed > 0 && elapsed < 1500) {
      return res.status(400).json({ error: 'Please take a moment to check your details, then send again.' });
    }

    if (body.kind === 'lookup') {
      const phone = clean(body.phone, 20);
      if (!/^[6-9]\d{9}$/.test(phone.replace(/\D/g, '').slice(-10))) return res.status(400).json({ names: [] });
      if (!process.env.KCM_PAYMENT_GATEWAY_SECRET) return res.status(200).json({ names: [] });
      try { return res.status(200).json({ names: await lookupNames(phone) }); }
      catch (err) { console.error('SP lookup:', err.message); return res.status(200).json({ names: [] }); }
    }

    const name  = clean(body.name, 120);
    const phone = clean(body.phone, 20);
    const email = clean(body.email, 200).toLowerCase();
    if (!name || name.length < 3) return res.status(400).json({ error: 'Please enter your full name.' });
    if (hasLink(name))             return res.status(400).json({ error: 'Please check your name.' });
    if (!isMob(phone))             return res.status(400).json({ error: 'Please enter a valid mobile number.' });
    if (!/^[6-9]\d{9}$/.test(phone.replace(/\D/g, '').slice(-10))) return res.status(400).json({ error: 'Please enter a valid Indian mobile number.' });
    if (email && !isEmail(email))  return res.status(400).json({ error: 'Please check your email.' });

    const seva = Object.prototype.hasOwnProperty.call(SEVAS, body.seva) ? SEVAS[body.seva] : null;
    if (!seva) return res.status(400).json({ error: 'Please choose a seva.' });
    const amount = seva.price !== null ? seva.price : Math.round(Number(body.amount));
    if (!Number.isFinite(amount) || amount < 1 || amount > 10000000) return res.status(400).json({ error: 'Please enter a valid amount.' });

    if ((await recentAttempts(phone)) >= MAX_ATTEMPTS_PER_HOUR) {
      return res.status(429).json({ error: 'Too many attempts from this number. Please try again in an hour.' });
    }

    const reference = `SP-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const row = { festival: FESTIVAL, seva: seva.title, scheme_id: seva.scheme, name, phone, email: email || null, amount, reference, status: 'created' };
    await insert(row);

    let checkout = null;
    if (process.env.KCM_PAYMENT_GATEWAY_SECRET) {
      try { checkout = await startPayment(row, seva); }
      catch (err) {
        console.error(`SP gateway ${reference}:`, err.message);
        await updateDonation(reference, { failure_reason: String(err.message).slice(0, 300) }).catch(() => {});
      }
    }
    return res.status(200).json({ ok: true, reference, amount, seva: seva.title, checkout });
  } catch (err) {
    console.error('Sharadpurnima handler error:', err.message);
    return res.status(500).json({ error: SAVE_FAILED });
  }
};
