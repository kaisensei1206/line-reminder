// 登入：只有知道密碼的人（kai）能進入。
// 登入成功後發一張有簽名的「通行證」存在瀏覽器 cookie 裡，30 天內不用再登入。

const COOKIE = 'sid';
const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

const enc = new TextEncoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function sign(secret, data) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
}

// 用簽名比對，避免從比對花的時間猜出密碼
async function safeEqual(secret, a, b) {
  return (await sign(secret, 'cmp:' + a)) === (await sign(secret, 'cmp:' + b));
}

function sessionSecret(env) {
  // 改密碼後，舊的通行證會全部失效
  return 'session:' + env.APP_PASSWORD;
}

export async function makeSessionCookie(env, now = Date.now()) {
  const expires = now + SESSION_DAYS * 86400e3;
  const value = `${expires}.${await sign(sessionSecret(env), String(expires))}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function isLoggedIn(request, env, now = Date.now()) {
  if (!env.APP_PASSWORD) return false;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  if (!m) return false;
  const [expires, sig] = m[1].split('.');
  if (!expires || !sig || Number(expires) < now) return false;
  return sig === (await sign(sessionSecret(env), expires));
}

// 回傳 { ok, lockedMinutes }；連錯 5 次會鎖 15 分鐘
export async function checkPassword(env, ip, password, now = Date.now()) {
  if (!env.APP_PASSWORD) return { ok: false, error: '還沒設定登入密碼' };
  const row = await env.DB.prepare('SELECT fails, locked_until FROM login_attempts WHERE ip = ?').bind(ip).first();
  if (row && row.locked_until > now) {
    return { ok: false, lockedMinutes: Math.ceil((row.locked_until - now) / 60e3) };
  }
  const ok = typeof password === 'string' && (await safeEqual(sessionSecret(env), password, env.APP_PASSWORD));
  if (ok) {
    await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
    return { ok: true };
  }
  const fails = (row?.fails || 0) + 1;
  const lockedUntil = fails >= MAX_FAILS ? now + LOCK_MINUTES * 60e3 : 0;
  await env.DB.prepare(
    'INSERT INTO login_attempts (ip, fails, locked_until) VALUES (?1, ?2, ?3) ON CONFLICT(ip) DO UPDATE SET fails = ?2, locked_until = ?3'
  ).bind(ip, lockedUntil ? 0 : fails, lockedUntil).run();
  return lockedUntil ? { ok: false, lockedMinutes: LOCK_MINUTES } : { ok: false, triesLeft: MAX_FAILS - fails };
}
