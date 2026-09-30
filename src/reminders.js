import { profileName, pushText, reminderText, replyText } from './line.js';

const WEEK_MINUTES = 7 * 24 * 60;

// ---------- 聯絡人 ----------

export async function saveContactFromLine(env, source) {
  const lineId = source.type === 'group' ? source.groupId : source.type === 'room' ? source.roomId : source.userId;
  if (!lineId) return;
  const name = await profileName(env, source);
  await env.DB.prepare(
    `INSERT INTO contacts (line_id, kind, line_name, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(line_id) DO UPDATE SET line_name = COALESCE(?3, line_name)`
  ).bind(lineId, source.type, name, Date.now()).run();
}

export async function listContacts(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, kind, line_name, nickname, is_self FROM contacts ORDER BY is_self DESC, nickname IS NULL, created_at'
  ).all();
  return results;
}

export async function updateContact(env, id, { nickname, isSelf }) {
  if (isSelf) await env.DB.prepare('UPDATE contacts SET is_self = 0').run();
  await env.DB.prepare('UPDATE contacts SET nickname = ?2, is_self = ?3 WHERE id = ?1')
    .bind(id, nickname?.trim() || null, isSelf ? 1 : 0)
    .run();
}

// LINE 傳來的事件：有人加好友、把帳號拉進群組
export async function handleLineEvents(env, events) {
  for (const ev of events) {
    if (ev.type === 'follow' || ev.type === 'join') {
      await saveContactFromLine(env, ev.source);
      if (ev.replyToken) {
        await replyText(env, ev.replyToken, '你好！之後 kai 設定給你的提醒，會從這裡傳給你。').catch(console.error);
      }
    } else if (ev.type === 'message') {
      // 傳訊息也順便記下來，避免漏掉在接上之前就加好友的人
      await saveContactFromLine(env, ev.source);
    }
  }
}

// ---------- 提醒 ----------

export async function createReminder(env, { content, contactId, sendAt }) {
  content = String(content || '').trim();
  sendAt = Number(sendAt);
  if (!content) throw new UserError('提醒內容是空的');
  if (content.length > 500) throw new UserError('提醒內容太長了');
  if (!Number.isFinite(sendAt)) throw new UserError('時間看不懂');
  if (sendAt < Date.now() - 60e3) throw new UserError('這個時間已經過去了');
  const contact = await env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(contactId).first();
  if (!contact) throw new UserError('找不到這位聯絡人');
  const row = await env.DB.prepare(
    'INSERT INTO reminders (content, contact_id, send_at, created_at) VALUES (?, ?, ?, ?) RETURNING id'
  ).bind(content, contactId, sendAt, Date.now()).first();
  return row.id;
}

export async function listReminders(env) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.content, r.send_at, r.status, r.sent_at, r.error,
            COALESCE(c.nickname, c.line_name, '未命名') AS contact_name, c.is_self
     FROM reminders r JOIN contacts c ON c.id = r.contact_id
     WHERE r.status != 'cancelled'
     ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.send_at`
  ).all();
  return results;
}

export async function cancelReminder(env, id) {
  const { meta } = await env.DB.prepare("UPDATE reminders SET status = 'cancelled', sent_at = ?2 WHERE id = ?1 AND status = 'pending'")
    .bind(id, Date.now())
    .run();
  if (!meta.changes) throw new UserError('這則提醒已經送出或不存在');
}

// 每分鐘執行：送出到期的提醒，並刪掉一星期前送出的
export async function runSchedule(env, now = Date.now()) {
  // 上次傳到一半被中斷的，放回去重送（LINE 會認出同一則，不會重複收到）
  await env.DB.prepare("UPDATE reminders SET status = 'pending' WHERE status = 'sending' AND send_at < ?")
    .bind(now - 5 * 60e3)
    .run();

  const { results: due } = await env.DB.prepare(
    `SELECT r.id, r.content, r.send_at, c.line_id FROM reminders r JOIN contacts c ON c.id = r.contact_id
     WHERE r.status = 'pending' AND r.send_at <= ? ORDER BY r.send_at LIMIT 50`
  ).bind(now).all();

  for (const r of due) {
    // 先標記「傳送中」，避免同一則被送兩次
    const { meta } = await env.DB.prepare("UPDATE reminders SET status = 'sending' WHERE id = ? AND status = 'pending'").bind(r.id).run();
    if (!meta.changes) continue;
    try {
      await pushText(env, r.line_id, reminderText(r.content), await retryKey(r.id));
      await env.DB.prepare("UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ?").bind(Date.now(), r.id).run();
    } catch (err) {
      console.error(err);
      if (err.status === 409) {
        // 已經送過了（重送時 LINE 會這樣回）
        await env.DB.prepare("UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ?").bind(Date.now(), r.id).run();
        continue;
      }
      if ((!err.status || err.status >= 500) && now - r.send_at < 30 * 60e3) {
        // 暫時連不上 LINE：下一分鐘再試，最多重試 30 分鐘
        await env.DB.prepare("UPDATE reminders SET status = 'pending' WHERE id = ?").bind(r.id).run();
        continue;
      }
      await env.DB.prepare("UPDATE reminders SET status = 'failed', sent_at = ?, error = ? WHERE id = ?")
        .bind(Date.now(), friendlyError(err), r.id)
        .run();
    }
  }

  await env.DB.prepare("DELETE FROM reminders WHERE status IN ('sent', 'failed', 'cancelled') AND sent_at < ?")
    .bind(now - (Number(env.KEEP_SENT_MINUTES) || WEEK_MINUTES) * 60e3)
    .run();
}

async function retryKey(id) {
  // LINE 要求 UUID 格式；用提醒編號算出固定的一組
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('reminder:' + id)));
  const hex = [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function friendlyError(err) {
  if (err.status === 429) return '本月 LINE 免費則數用完了';
  if (err.status === 400 || err.status === 403) return '對方可能封鎖了官方帳號或已退出群組';
  if (err.status === 401) return 'LINE 金鑰不正確';
  return '傳送失敗，請稍後再試';
}

export class UserError extends Error {}
