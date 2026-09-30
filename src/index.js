import { ensureSchema } from './db.js';
import { checkPassword, clearSessionCookie, isLoggedIn, makeSessionCookie } from './auth.js';
import { quota, verifySignature } from './line.js';
import {
  UserError,
  cancelReminder,
  createReminder,
  handleLineEvents,
  listContacts,
  listReminders,
  runSchedule,
  updateContact,
} from './reminders.js';

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...init.headers },
  });

const body = (request) => request.json().catch(() => ({}));

async function handleApi(request, env, url, ctx) {
  const { pathname } = url;
  const { method } = request;
  await ensureSchema(env);

  // LINE 的通知（有人加好友等），用 LINE 的簽名確認身分，不需要登入
  if (pathname === '/api/line/webhook' && method === 'POST') {
    const raw = await request.text();
    if (!(await verifySignature(env, raw, request.headers.get('X-Line-Signature')))) {
      return json({ error: '簽名不正確' }, { status: 401 });
    }
    const { events = [] } = JSON.parse(raw);
    ctx.waitUntil(handleLineEvents(env, events).catch(console.error));
    return json({ ok: true });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const { password } = await body(request);
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    const result = await checkPassword(env, ip, password);
    if (!result.ok) return json(result, { status: 401 });
    return json({ ok: true }, { headers: { 'Set-Cookie': await makeSessionCookie(env) } });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    return json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie() } });
  }

  // 以下都要先登入
  if (!(await isLoggedIn(request, env))) return json({ error: '請先登入' }, { status: 401 });

  if (pathname === '/api/me') return json({ ok: true, lineReady: Boolean(env.LINE_CHANNEL_ACCESS_TOKEN) });

  if (pathname === '/api/reminders' && method === 'GET') return json(await listReminders(env));
  if (pathname === '/api/reminders' && method === 'POST') {
    const { content, contactId, sendAt } = await body(request);
    return json({ id: await createReminder(env, { content, contactId, sendAt }) });
  }
  let m = pathname.match(/^\/api\/reminders\/(\d+)\/cancel$/);
  if (m && method === 'POST') {
    await cancelReminder(env, Number(m[1]));
    return json({ ok: true });
  }

  if (pathname === '/api/contacts' && method === 'GET') return json(await listContacts(env));
  m = pathname.match(/^\/api\/contacts\/(\d+)$/);
  if (m && method === 'POST') {
    const { nickname, isSelf } = await body(request);
    await updateContact(env, Number(m[1]), { nickname, isSelf });
    return json({ ok: true });
  }

  if (pathname === '/api/quota') return json(await quota(env));

  return json({ error: '找不到' }, { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url, ctx);
      } catch (err) {
        if (err instanceof UserError) return json({ error: err.message }, { status: 400 });
        console.error(err);
        return json({ error: '系統發生錯誤，請稍後再試' }, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    await ensureSchema(env);
    await runSchedule(env);
  },
};
