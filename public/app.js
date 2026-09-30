const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function show(view) {
  $('login').hidden = view !== 'login';
  $('home').hidden = view !== 'home';
  if (view === 'login') $('password').focus();
}

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

$('mic').addEventListener('click', () => {
  $('mic-hint').textContent = '語音功能會在第三階段加入';
});

const { status } = await api('/api/me');
show(status === 200 ? 'home' : 'login');
