import { Redis } from '@upstash/redis';

const APP_PASS = process.env.APP_PASS || 'FER-BYG';
const KEY = 'ferbyg:state';
const MAX_HISTORY = 800;

function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function readState(redis) {
  const raw = await redis.get(KEY);
  if (!raw) return null;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
  return raw; // upstash auto-parses JSON
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const redis = getRedis();

  // Storage not connected yet -> tell client to run in local mode
  if (!redis) {
    return res.status(200).json({ ok: true, configured: false });
  }

  // Parse body early so we can also read the password from it (POST sends it in the body).
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const provided = req.headers['x-app-pass'] || (req.query && req.query.pass) || body.password || '';
  if (provided !== APP_PASS) {
    return res.status(403).json({ ok: false, error: 'clave incorrecta' });
  }

  try {
    if (req.method === 'GET') {
      const state = await readState(redis);
      if (!state) return res.status(200).json({ ok: true, configured: true, empty: true, version: 0 });
      return res.status(200).json({ ok: true, configured: true, ...state });
    }

    if (req.method === 'POST') {
      const country = req.headers['x-vercel-ip-country'] || '';
      const current = (await readState(redis)) || { version: 0, tasks: [], payments: [], history: [] };
      const version = (current.version || 0) + 1;

      const entries = Array.isArray(body.entries) ? body.entries : (body.entry ? [body.entry] : []);
      const now = Date.now();
      const stamped = entries.map(e => ({
        ts: now,
        name: (body.name || '—').slice(0, 40),
        country,
        action: String(e.action || '').slice(0, 200)
      }));
      const history = [...(current.history || []), ...stamped].slice(-MAX_HISTORY);

      const state = {
        version,
        tasks: Array.isArray(body.tasks) ? body.tasks : current.tasks,
        payments: Array.isArray(body.payments) ? body.payments : current.payments,
        blockTitles: (body.blockTitles && typeof body.blockTitles === 'object') ? body.blockTitles : (current.blockTitles || {}),
        history
      };
      await redis.set(KEY, JSON.stringify(state));
      return res.status(200).json({ ok: true, version, history });
    }

    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
}
