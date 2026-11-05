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
    return { prabhupada_offerings: [], prabhupada_donations: [] };
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
    const amount = Math.round(Number(body.amount));
    if (!Number.isFinite(amount) || amount < 1 || amount > 10000000) return { error: 'Please choose or enter an amount.' };
    const reference = `PSD-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    return {
      table: TABLES.donation,
      row: { festival: FESTIVAL, seva: clean(body.seva, 80) || 'Festival expenses', name, phone, email: email || null, amount, reference },
      reply: { reference, amount },
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
      if (body.kind === 'upload') {
        const slot = await uploadSlot(body);
        return res.status(slot.error ? 400 : 200).json(slot);
      }
      const checked = validate(body);
      if (checked.error) return res.status(400).json({ error: checked.error });
      await insert(checked.table, checked.row);
      return res.status(200).json({ ok: true, ...checked.reply });
    }

    if (req.method === 'GET') {
      if (req.query && req.query.limits) {
        return res.status(200).json({ audio: UPLOADS.audio.maxBytes / MB, video: UPLOADS.video.maxBytes / MB, scan: UPLOADS.scan.maxBytes / MB });
      }
      if (!keyMatches(req.headers['x-admin-key'])) return res.status(401).json({ error: 'Incorrect staff key.' });
      const [offerings, donations] = await Promise.all([list(TABLES.offering), list(TABLES.donation)]);
      return res.status(200).json({ offerings: await withFileUrls(offerings), donations });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('Prabhupada form error:', err.message);
    return res.status(500).json({ error: SAVE_FAILED });
  }
};
