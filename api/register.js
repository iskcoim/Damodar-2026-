// Vercel serverless function — handles both POST (register) and GET (admin list)
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// The registrations list holds names, phones and addresses: only staff with ADMIN_KEY may read it
function keyMatches(given) {
  const expected = process.env.ADMIN_KEY;
  if (!expected || !given) return false;
  const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(hash(given), hash(expected));
}

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'POST') {
      const { name, phone, address, mentorName, mentor_name, email, area, capacity, prefWeek, notes } = req.body;
      if (!name || !phone || !address) {
        return res.status(400).json({ error: 'Please provide Name, Phone Number, and Address.' });
      }

      const assignedMentor = mentor_name || mentorName || 'General / None';
      const assignedArea   = area || (address ? address.substring(0, 80) : 'Coimbatore');
      const assignedCap    = capacity || 'Family / Group';

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
          console.error('Supabase insert error:', error.message);
        } else {
          dbSaved = true;
        }
      }

      return res.status(200).json({ ok: true, savedToDb: dbSaved });
    }

    if (req.method === 'GET') {
      if (!keyMatches(req.headers['x-admin-key'])) return res.status(401).json({ error: 'Incorrect password.' });
      if (!supabase) return res.status(200).json([]);
      const { data, error } = await supabase
        .from('damodara_registrations')
        .select('*')
        .order('id', { ascending: false });
      if (error) {
        console.error('Supabase fetch error:', error.message);
        return res.status(200).json([]);
      }
      return res.status(200).json(data);
    }

    res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error. Please try again or WhatsApp directly.' });
  }
};
