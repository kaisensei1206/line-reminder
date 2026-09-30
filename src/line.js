// 和 LINE 溝通：驗證 LINE 傳來的通知、傳送訊息、查詢本月用量

const API = 'https://api.line.me/v2/bot';

async function lineFetch(env, path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${String(env.LINE_CHANNEL_ACCESS_TOKEN || "").trim()}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`LINE 回應 ${res.status}：${detail.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.headers.get('Content-Type')?.includes('json') ? res.json() : null;
}

// 確認通知真的是 LINE 送來的，不是別人假冒
export async function verifySignature(env, body, signature) {
  if (!env.LINE_CHANNEL_SECRET || !signature) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.LINE_CHANNEL_SECRET.trim()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const sig = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  return crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(body));
}

export function reminderText(content) {
  return `⏰ 提醒：${content}（由 kai 設定）`;
}

// retryKey 讓同一則提醒就算重試也只會送出一次
export function pushText(env, to, text, retryKey) {
  return lineFetch(env, '/message/push', {
    method: 'POST',
    headers: retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
}

export function replyText(env, replyToken, text) {
  return lineFetch(env, '/message/reply', {
    method: 'POST',
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  });
}

export async function profileName(env, source) {
  try {
    if (source.type === 'user') return (await lineFetch(env, `/profile/${source.userId}`)).displayName;
    if (source.type === 'group') return (await lineFetch(env, `/group/${source.groupId}/summary`)).groupName;
  } catch (err) {
    console.error(err);
  }
  return null;
}

export async function quota(env) {
  const [limit, usage] = await Promise.all([
    lineFetch(env, '/message/quota'),
    lineFetch(env, '/message/quota/consumption'),
  ]);
  return { used: usage.totalUsage, limit: limit.type === 'limited' ? limit.value : null };
}
