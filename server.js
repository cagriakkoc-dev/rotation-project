// Rotasyon Defteri - Backend
// Statik frontend'i sunar + /api/storage üzerinden Upstash Redis'e (REST API) bağlanan
// basit bir key-value depolama katmanı sağlar. Frontend'deki window.storage shim'i
// bu uçları çağırıyor.
//
// Kimlik doğrulama: HTTP Basic Auth yerine gerçek bir giriş formu + oturum çerezi
// kullanıyoruz — çünkü iOS'ta "Ana Ekrana Ekle" ile açılan bağımsız (standalone)
// pencereler, Basic Auth'un native tarayıcı penceresini Anahtarlık'a bağlamıyor.
// Form tabanlı giriş + çerez, hem normal Safari'de hem Ana Ekran kısayolunda
// güvenilir şekilde hatırlanıyor.

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const APP_USERNAME = process.env.APP_USERNAME || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD; // boş bırakılırsa auth devre dışı kalır (önerilmez)
const SESSION_SECRET = process.env.SESSION_SECRET || (APP_PASSWORD || 'rotasyon-varsayilan-anahtar');

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.warn('[UYARI] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN tanımlı değil. Depolama çalışmayacak.');
}

// --- Oturum çerezi yardımcıları ---
const COOKIE_NAME = 'rotasyon_session';
const COOKIE_MAX_AGE_DAYS = 365;

function sessionToken() {
  return crypto.createHash('sha256').update(APP_USERNAME + ':' + APP_PASSWORD + ':' + SESSION_SECRET).digest('hex');
}
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}
function setSessionCookie(res) {
  const maxAge = COOKIE_MAX_AGE_DAYS * 24 * 60 * 60;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${sessionToken()}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax`);
}

// --- Giriş sayfası (auth'tan ÖNCE tanımlı, herkes erişebilir) ---
app.get('/login', (req, res) => {
  if (!APP_PASSWORD) return res.redirect('/');
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME] === sessionToken()) return res.redirect('/');
  const error = req.query.error ? '<p style="color:#E0684F;font-family:IBM Plex Mono,monospace;font-size:13px;margin-top:10px;">Kullanıcı adı veya parola hatalı.</p>' : '';
  res.send(`<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Giriş — Rotasyon Portföyü</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0A1628;font-family:-apple-system,'Inter',sans-serif;}
  .card{background:#132A48;border:1px solid #294869;border-radius:14px;padding:32px 28px;width:100%;max-width:340px;}
  h1{color:#F1F5FA;font-size:20px;margin:0 0 6px 0;}
  p.sub{color:#8CA0BC;font-size:13px;margin:0 0 22px 0;}
  label{display:block;color:#8CA0BC;font-family:'IBM Plex Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;}
  input{width:100%;box-sizing:border-box;padding:11px 12px;margin-bottom:16px;border-radius:8px;border:1px solid #294869;background:#0F2039;color:#F1F5FA;font-size:15px;}
  input:focus{outline:none;border-color:#2FB380;}
  button{width:100%;padding:12px;border:none;border-radius:9px;background:#2FB380;color:#062318;font-weight:700;font-size:15px;cursor:pointer;}
</style></head>
<body>
  <div class="card">
    <h1>Rotasyon Portföyü</h1>
    <p class="sub">Devam etmek için giriş yapın</p>
    <form method="POST" action="/login">
      <label>Kullanıcı Adı</label>
      <input type="text" name="username" autocomplete="username" autofocus>
      <label>Parola</label>
      <input type="password" name="password" autocomplete="current-password">
      <button type="submit">Giriş Yap</button>
      ${error}
    </form>
  </div>
</body></html>`);
});

app.post('/login', (req, res) => {
  if (!APP_PASSWORD) return res.redirect('/');
  const { username, password } = req.body || {};
  if (username === APP_USERNAME && password === APP_PASSWORD) {
    setSessionCookie(res);
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/`);
  res.redirect('/login');
});

// Render'ın kendi sağlık kontrolü (health check) auth istemeden buraya erişebilmeli
app.get('/healthz', (req, res) => res.send('ok'));

// --- Kimlik doğrulama middleware'i (oturum çerezi kontrolü) ---
function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return next(); // parola set edilmemişse korumasız çalışır
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME] === sessionToken()) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return res.redirect('/login');
}
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
