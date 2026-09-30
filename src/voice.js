// 語音對話：向 Google 申請一張「一次性、幾分鐘就過期」的通行證給瀏覽器用，
// 這樣真正的 Gemini 金鑰只放在雲端，不會出現在手機上。

import { createReminder, listContacts, UserError } from './reminders.js';

export const MODEL = 'gemini-3.8-live';
const API_ROOT = 'https://generativelanguage.googleapis.com';
const TAIPEI = 8 * 3600e3; // 台灣時間 = UTC+8，沒有日光節約

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function taipeiParts(ms) {
  const d = new Date(ms + TAIPEI);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), w: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
const pad = (n) => String(n).padStart(2, '0');

// "2026-10-07T10:00"（台灣時間）→ 毫秒
export function parseTaipei(text) {
  const m = String(text || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - TAIPEI;
}

// 給 AI 看的日曆，讓「下週三」「後天」這類說法不會算錯
export function calendarText(now) {
  const t = taipeiParts(now);
  const lines = [`現在是 ${t.y} 年 ${t.mo} 月 ${t.d} 日 星期${WEEKDAYS[t.w]} ${pad(t.h)}:${pad(t.mi)}（台灣時間）。`];
  // 一週從星期一開始；「下週X」指下一個星期一開始的那一週
  const mondayOffset = (t.w + 6) % 7;
  for (let i = 0; i < 21; i++) {
    const p = taipeiParts(now + i * 86400e3);
    const week = Math.floor((i + mondayOffset) / 7);
    const label = ['本週', '下週', '下下週'][week];
    const extra = i === 0 ? '（今天）' : i === 1 ? '（明天）' : i === 2 ? '（後天）' : '';
    lines.push(`${p.y}-${pad(p.mo)}-${pad(p.d)} 星期${WEEKDAYS[p.w]}，${label}${WEEKDAYS[p.w]}${extra}`);
  }
  return lines.join('\n');
}

function contactNames(contacts) {
  return contacts
    .filter((c) => c.is_self || c.nickname || c.line_name)
    .map((c) => (c.is_self ? '我自己（kai 本人）' : c.nickname || c.line_name))
    .join('、');
}

export function systemInstruction(now, contacts) {
  return `你是 kai 的語音提醒小幫手。一律用台灣口語的繁體中文，句子簡短自然。

${calendarText(now)}

對話流程：
1. 收到「（開始）」時，只說：「嗨，有什麼我可以幫忙的？」
2. kai 會說要提醒的內容、時間、對象。「提醒我」表示對象是 kai 本人。缺少時間或內容時，簡短追問。
3. 資料齊全後，用一句話完整唸出來確認，包含幾月幾日、星期幾、上午或下午幾點幾分、對象、內容，最後問「對嗎？」。
   例如：「好的，10 月 7 日星期三早上 10 點，提醒你去繳信用卡卡費，對嗎？」
4. kai 說對、沒錯、好、可以之後，才呼叫 create_reminder。kai 說要改，就照他說的改完再確認一次。
5. 建立成功後說「好了，已經幫你設定好了。」然後問還有沒有其他要提醒的。失敗時照工具回傳的原因說明。

規則：
- 可以提醒的對象只有：${contactNames(contacts) || '（目前還沒有聯絡人）'}。
  如果 kai 說的人不在名單裡，告訴他找不到這個人，對方要先加 LINE 官方帳號「冷靜小羊的提醒幫手」為好友，並在 App 裡取好小名。不要建立提醒。
- 「一個小時後」「半小時後」這類說法，從現在時間往後算。沒說上午下午時，選最接近的未來時間，並在確認時講清楚。
- 已經過去的時間不能設定，請 kai 換一個時間。
- 不要回答和提醒無關的長篇問題，簡單帶回提醒的話題即可。`;
}

export const tools = [
  {
    functionDeclarations: [
      {
        name: 'create_reminder',
        description: 'kai 口頭確認無誤後，建立一則會用 LINE 傳送的提醒。',
        parameters: {
          type: 'OBJECT',
          properties: {
            content: { type: 'STRING', description: '提醒內容，例如「去繳信用卡卡費」，不要包含時間和對象' },
            recipient: { type: 'STRING', description: '提醒對象：kai 本人填「我」，其他人填名單上的名字' },
            datetime: { type: 'STRING', description: '台灣時間，格式 YYYY-MM-DDTHH:mm，例如 2026-10-07T10:00' },
          },
          required: ['content', 'recipient', 'datetime'],
        },
      },
    ],
  },
];

export async function voiceSession(env, now = Date.now()) {
  if (!env.GEMINI_API_KEY) throw new UserError('還沒設定 Gemini 金鑰');
  const contacts = await listContacts(env);
  const setup = {
    model: `models/${MODEL}`,
    generationConfig: { responseModalities: ['AUDIO'] },
    systemInstruction: { parts: [{ text: systemInstruction(now, contacts) }] },
    tools,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
  // 先用 v1beta，不行再試 v1alpha（Google 兩個版本都有提供一次性通行證）
  let version, name, lastError;
  for (const v of ['v1beta', 'v1alpha']) {
    const res = await fetch(`${API_ROOT}/${v}/auth_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY.trim() },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + 30 * 60e3).toISOString(),
        newSessionExpireTime: new Date(now + 2 * 60e3).toISOString(),
        // 整份設定（說話規則、建立提醒的工具）都鎖在通行證裡。
        // 只要通行證帶了設定，瀏覽器另外送的設定就會被忽略，所以一定要放完整。
        bidiGenerateContentSetup: setup,
      }),
    });
    if (res.ok) {
      ({ name } = await res.json());
      version = v;
      break;
    }
    const detail = await res.json().catch(() => ({}));
    lastError = { status: res.status, message: detail.error?.message || '' };
    console.error('Gemini token', v, res.status, JSON.stringify(detail));
    if (/API key not valid|API_KEY_INVALID/i.test(lastError.message)) break;
  }
  if (!name) {
    if (/API key not valid|API_KEY_INVALID/i.test(lastError.message)) throw new UserError('Gemini 金鑰不正確，請檢查是否完整複製');
    throw new UserError(`暫時無法開始語音（Google 回應 ${lastError.status}：${lastError.message.slice(0, 120)}）`);
  }
  return {
    url: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(name)}`,
    setup,
  };
}

function findContact(contacts, name) {
  const n = String(name || '').replace(/\s/g, '');
  if (!n || ['我', '我自己', 'kai', '自己'].includes(n.toLowerCase())) return contacts.find((c) => c.is_self);
  return (
    contacts.find((c) => c.nickname === n) ||
    contacts.find((c) => c.line_name === n) ||
    contacts.find((c) => (c.nickname && (c.nickname.includes(n) || n.includes(c.nickname))))
  );
}

// AI 呼叫 create_reminder 時，由瀏覽器轉交到這裡
export async function createFromVoice(env, { content, recipient, datetime }) {
  const contacts = await listContacts(env);
  const contact = findContact(contacts, recipient);
  if (!contact) {
    const self = /^(我|我自己|自己)$/.test(String(recipient || '').trim());
    return {
      ok: false,
      reason: self
        ? '還沒有在 App 的聯絡人裡標記哪一個是 kai 本人，請 kai 先到聯絡人勾選「這是我自己」。'
        : `找不到「${recipient}」。目前可以提醒的人有：${contactNames(contacts) || '沒有'}。`,
    };
  }
  const sendAt = parseTaipei(datetime);
  // AI 偶爾會對同一件事呼叫兩次，一樣的內容就不重複建立
  const dup = await env.DB.prepare(
    "SELECT id FROM reminders WHERE content = ? AND contact_id = ? AND send_at = ? AND status != 'cancelled' AND created_at > ?"
  ).bind(String(content || '').trim(), contact.id, sendAt, Date.now() - 10 * 60e3).first();
  if (dup) return { ok: true, id: dup.id };
  try {
    const id = await createReminder(env, { content, contactId: contact.id, sendAt });
    return { ok: true, id };
  } catch (err) {
    if (err instanceof UserError) return { ok: false, reason: err.message };
    throw err;
  }
}
