import { VoiceChat } from './voice.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') show('login');
  return { status: res.status, data };
}

// 時間一律用台灣時間顯示
const fmt = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});
const when = (ms) => fmt.format(new Date(ms));

function show(view) {
  $('login').hidden = view !== 'login';
  $('home').hidden = view !== 'home';
  if (view === 'login') $('password').focus();
  if (view === 'home') refresh();
}

// ---------- 登入 ----------

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  $('login-msg').textContent = '';
  const { status, data } = await api('/api/login', { password: $('password').value });
  btn.disabled = false;
  if (status === 200) {
    $('password').value = '';
    show('home');
    return;
  }
  if (data.lockedMinutes) $('login-msg').textContent = `錯誤太多次，請 ${data.lockedMinutes} 分鐘後再試`;
  else if (data.triesLeft) $('login-msg').textContent = `密碼不對，還可以再試 ${data.triesLeft} 次`;
  else $('login-msg').textContent = data.error || '登入失敗';
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', {});
  show('login');
});

// ---------- 提醒清單 ----------

export async function refresh() {
  const [{ data: reminders }, quota] = await Promise.all([api('/api/reminders'), api('/api/quota')]);
  if (quota.status === 200 && quota.data.limit) {
    $('quota').textContent = `本月 LINE 已用 ${quota.data.used} / ${quota.data.limit} 則`;
  }
  if (!Array.isArray(reminders)) return;
  const pending = reminders.filter((r) => r.status === 'pending' || r.status === 'sending');
  const done = reminders.filter((r) => r.status === 'sent' || r.status === 'failed');
  const who = (r) => (r.is_self ? '給我自己' : `給 ${esc(r.contact_name)}`);
  const item = (r) => {
    const badge =
      r.status === 'sent' ? `<span class="badge sent">已送出</span>`
      : r.status === 'failed' ? `<span class="badge failed">未送出</span>`
      : r.status === 'sending' ? `<span class="badge">傳送中</span>`
      : `<button class="ghost small" data-cancel="${r.id}">取消</button>`;
    const meta = r.status === 'sent' ? `${who(r)} · ${when(r.sent_at)} 送出`
      : r.status === 'failed' ? `${who(r)} · ${esc(r.error)}`
      : `${who(r)} · ${when(r.send_at)}`;
    return `<div class="item ${r.status === 'pending' ? '' : 'done'}"><div class="body"><div class="what">${esc(r.content)}</div><div class="meta">${meta}</div></div>${badge}</div>`;
  };
  $('list').innerHTML =
    (pending.length ? `<h3>即將提醒</h3>${pending.map(item).join('')}` : `<p class="empty">目前沒有提醒</p>`) +
    (done.length ? `<h3>已處理（一星期後自動刪除）</h3>${done.map(item).join('')}` : '');
}

$('list').addEventListener('click', async (e) => {
  const id = e.target.dataset.cancel;
  if (!id || !confirm('確定要取消這則提醒嗎？')) return;
  const { status, data } = await api(`/api/reminders/${id}/cancel`, {});
  if (status !== 200) alert(data.error || '取消失敗');
  refresh();
});

// ---------- 打字新增 ----------

const pad = (n) => String(n).padStart(2, '0');
function localInputValue(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function fillContacts(select) {
  const { data } = await api('/api/contacts');
  const list = Array.isArray(data) ? data : [];
  select.innerHTML = list.length
    ? list.map((c) => `<option value="${c.id}">${c.is_self ? '我自己' : esc(c.nickname || c.line_name || '未命名')}</option>`).join('')
    : `<option value="">還沒有聯絡人，請先加官方帳號好友</option>`;
}

$('open-type').addEventListener('click', async () => {
  $('t-msg').textContent = '';
  const soon = new Date(Date.now() + 60 * 60e3);
  $('t-time').value = localInputValue(soon);
  await fillContacts($('t-contact'));
  $('type-dialog').showModal();
  $('t-content').focus();
});

$('type-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { status, data } = await api('/api/reminders', {
    content: $('t-content').value,
    contactId: Number($('t-contact').value),
    sendAt: new Date($('t-time').value).getTime(),
  });
  if (status !== 200) {
    $('t-msg').textContent = data.error || '建立失敗';
    return;
  }
  $('t-content').value = '';
  $('type-dialog').close();
  refresh();
});

// ---------- 聯絡人 ----------

async function renderContacts() {
  const { data } = await api('/api/contacts');
  const list = Array.isArray(data) ? data : [];
  $('contacts').innerHTML = list.length
    ? list.map((c) => `
      <div class="contact" data-id="${c.id}">
        <div class="name">LINE 名稱：${esc(c.line_name || '（讀不到）')}${c.kind === 'group' ? '（群組）' : ''}</div>
        <div class="line">
          <input type="text" placeholder="取個小名，例如：小明" value="${esc(c.nickname || '')}">
          <button class="primary small" data-save>儲存</button>
        </div>
        ${c.kind === 'user' ? `<label class="self"><input type="radio" name="self" ${c.is_self ? 'checked' : ''}> 這是我自己</label>` : ''}
      </div>`).join('')
    : `<p class="empty">還沒有人加官方帳號好友</p>`;
}

$('open-contacts').addEventListener('click', async () => {
  await renderContacts();
  $('contacts-dialog').showModal();
});

$('contacts').addEventListener('click', async (e) => {
  const box = e.target.closest('.contact');
  if (!box || !(e.target.matches('[data-save]') || e.target.matches('input[type=radio]'))) return;
  const isSelf = box.querySelector('input[type=radio]')?.checked || false;
  await api(`/api/contacts/${box.dataset.id}`, { nickname: box.querySelector('input[type=text]').value, isSelf });
  if (e.target.matches('[data-save]')) {
    e.target.textContent = '已儲存';
    setTimeout(() => (e.target.textContent = '儲存'), 1200);
  }
});

document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => {
  b.closest('dialog').close();
  refresh();
}));

// ---------- 語音 ----------

const HINTS = {
  idle: '點一下麥克風，開始說你想提醒的事',
  connecting: '連線中…',
  listening: '請說，我在聽（再按一次結束）',
  speaking: 'AI 說話中…（再按一次結束）',
};

const voice = new VoiceChat({
  onState(state) {
    $('mic').classList.toggle('live', state !== 'idle');
    $('mic').setAttribute('aria-label', state === 'idle' ? '開始對話' : '結束對話');
    $('mic-hint').textContent = HINTS[state];
  },
  onCreated: () => refresh(),
  onError(message) {
    $('mic-hint').textContent = message;
  },
});

$('mic').addEventListener('click', () => {
  if (voice.active) voice.stop();
  else voice.start();
});

setInterval(() => !$('home').hidden && refresh(), 30e3);

const { status } = await api('/api/me');
show(status === 200 ? 'home' : 'login');
