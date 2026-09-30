import { checkPassword, clearSessionCookie, isLoggedIn, makeSessionCookie } from './auth.js';

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...init.headers },
  });

async function handleApi(request, env, url) {
  const { pathname } = url;

  if (pathname === '/api/login' && request.method === 'POST') {
    const { password } = await request.json().catch(() => ({}));
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    const result = await checkPassword(env, ip, password);
    if (!result.ok) return json(result, { status: 401 });
    return json({ ok: true }, { headers: { 'Set-Cookie': await makeSessionCookie(env) } });
  }

  if (pathname === '/api/logout' && request.method === 'POST') {
    return json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie() } });
  }

  // 以下都要先登入
  if (!(await isLoggedIn(request, env))) return json({ error: '請先登入' }, { status: 401 });

  if (pathname === '/api/me') return json({ ok: true });

  return json({ error: '找不到' }, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        console.error(err);
        return json({ error: '系統發生錯誤，請稍後再試' }, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    // 第二階段會在這裡檢查並送出到期的提醒
  },
};
