// Rotasyon Defteri - Backend
// Statik frontend'i sunar + /api/storage üzerinden Upstash Redis'e (REST API) bağlanan
// basit bir key-value depolama katmanı sağlar. Frontend'deki window.storage shim'i
// bu uçları çağırıyor.

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const APP_USERNAME = process.env.APP_USERNAME || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD; // boş bırakılırsa auth devre dışı kalır (önerilmez)

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.warn('[UYARI] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN tanımlı değil. Depolama çalışmayacak.');
}

// --- Basit HTTP Basic Auth koruması (kişisel kullanım için yeterli) ---
function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return next(); // parola set edilmemişse korumasız çalışır
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sepIdx = decoded.indexOf(':');
    const user = decoded.slice(0, sepIdx);
    const pass = decoded.slice(sepIdx + 1);
    if (user === APP_USERNAME && pass === APP_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Rotasyon Defteri"');
  return res.status(401).send('Yetkisiz erişim.');
}
// Render'ın kendi sağlık kontrolü (health check) auth istemeden buraya erişebilmeli
app.get('/healthz', (req, res) => res.send('ok'));

app.use(requireAuth);

// --- Upstash Redis REST yardımcı fonksiyonu ---
async function upstash(pathParts) {
  const url = UPSTASH_URL + '/' + pathParts.map(encodeURIComponent).join('/');
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN }
  });
  if (!res.ok) {
    throw new Error('Upstash error: ' + res.status + ' ' + (await res.text()));
  }
  return res.json();
}

const KEY_PREFIX = 'rotasyon:';

// GET /api/storage/:key
app.get('/api/storage/:key', async (req, res) => {
  try {
    const result = await upstash(['get', KEY_PREFIX + req.params.key]);
    if (result.result === null) {
      return res.status(404).json({ error: 'not_found' });
    }
    res.json({ value: result.result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'storage_error', detail: String(e.message || e) });
  }
});

// POST /api/storage/:key  body: { value: string }
app.post('/api/storage/:key', async (req, res) => {
  try {
    const value = req.body && req.body.value;
    if (typeof value !== 'string') {
      return res.status(400).json({ error: 'value must be a string' });
    }
    await upstash(['set', KEY_PREFIX + req.params.key, value]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'storage_error', detail: String(e.message || e) });
  }
});

// DELETE /api/storage/:key
app.delete('/api/storage/:key', async (req, res) => {
  try {
    await upstash(['del', KEY_PREFIX + req.params.key]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'storage_error', detail: String(e.message || e) });
  }
});

// GET /api/storage?prefix=...
app.get('/api/storage', async (req, res) => {
  try {
    const pattern = KEY_PREFIX + (req.query.prefix || '') + '*';
    const result = await upstash(['keys', pattern]);
    const keys = (result.result || []).map(k => k.replace(KEY_PREFIX, ''));
    res.json({ keys });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'storage_error', detail: String(e.message || e) });
  }
});

// Statik frontend
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log('Rotasyon Defteri ' + PORT + ' portunda çalışıyor.');
});
