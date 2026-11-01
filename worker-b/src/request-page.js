/**
 * 自助申请邀请码的公开页面。只做两件事：收邮箱、收验证码。
 * 页面不依赖框架，所有文案都是给人看的，不是给机器看的。
 */
export function requestPageHtml({ turnstileSiteKey = '' } = {}) {
  const turnstile = turnstileSiteKey
    ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : ''
  const widget = turnstileSiteKey
    ? '<div class="cf-turnstile" data-sitekey="' + escapeHtml(turnstileSiteKey) + '" data-callback="onTurnstile"></div>'
    : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>申请固定地址邀请码</title>
<style>
body{font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:640px;margin:8vh auto;padding:0 24px;color:#1f2937;background:#f8fafc}
h1{font-size:24px;margin:0 0 8px}
p{color:#475569}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;box-shadow:0 4px 20px rgba(15,23,42,.05)}
label{display:block;margin:16px 0 6px;font-size:14px;color:#334155}
input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}
button{margin-top:16px;padding:10px 16px;border:0;border-radius:8px;background:#0f172a;color:#fff;font:inherit;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
.note{font-size:13px;color:#64748b;margin-top:14px}
.error{color:#b91c1c;margin-top:12px;white-space:pre-wrap}
.ok{color:#166534;margin-top:12px;white-space:pre-wrap}
code{background:#f1f5f9;padding:2px 6px;border-radius:4px;word-break:break-all}
.hidden{display:none}
.link{margin-top:8px;background:transparent;color:#475569;padding:0;text-decoration:underline}
</style>
${turnstile}
</head>
<body>
<h1>申请固定地址邀请码</h1>
<p>免费申请。一个邮箱只能申请一次；同一网络 30 天内最多 2 个邮箱；验证邮箱后才会发放邀请码。</p>
<div class="card">
  <div id="step1">
    <label for="email">邮箱</label>
    <input id="email" type="email" autocomplete="email" placeholder="you@example.com">
    ${widget}
    <button id="send" type="button">发送验证码</button>
    <div class="note">验证码 10 分钟内有效。不要用一次性邮箱；同一邮箱不能重复申请，同一网络 30 天内最多 2 个。</div>
  </div>
  <div id="step2" class="hidden">
    <label for="code">邮箱验证码</label>
    <input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位数字">
    <button id="verify" type="button">验证并领取</button>
    <button id="restart" type="button" class="link">重新申请</button>
    <div class="note">验证通过后会显示邀请码；验证成功后 15 分钟内可用同一验证码重取。</div>
  </div>
  <div id="error" class="error"></div>
  <div id="result" class="ok"></div>
</div>
<script>
var requestId = '';
try { requestId = localStorage.getItem('bRelayApplicationId') || ''; } catch (_) {}
var turnstileToken = '';
function onTurnstile(token) { turnstileToken = token; }
function showError(text) { document.getElementById('error').textContent = text || ''; }
function post(path, body) {
  return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); });
}
document.getElementById('send').onclick = function () {
  showError('');
  var email = document.getElementById('email').value.trim();
  if (!email) { showError('先填邮箱。'); return; }
  var btn = this; btn.disabled = true;
  post('/api/b/v1/invite-request', { email: email, turnstileToken: turnstileToken }).then(function (r) {
    btn.disabled = false;
    if (!r.body || !r.body.ok) { showError((r.body && r.body.message) || '发送失败，请稍后再试。'); return; }
    requestId = r.body.applicationId || '';
    try { localStorage.setItem('bRelayApplicationId', requestId); } catch (_) {}
    document.getElementById('step1').classList.add('hidden');
    document.getElementById('step2').classList.remove('hidden');
    document.getElementById('result').textContent = '验证码已发送，去邮箱查看。';
  }).catch(function () { btn.disabled = false; showError('网络错误，请稍后再试。'); });
};
document.getElementById('verify').onclick = function () {
  showError('');
  var code = document.getElementById('code').value.trim();
  if (!requestId) { showError('先发送验证码。'); return; }
  var btn = this; btn.disabled = true;
  post('/api/b/v1/invite-verify', { applicationId: requestId, code: code }).then(function (r) {
    btn.disabled = false;
    if (!r.body || !r.body.ok) { showError((r.body && r.body.message) || '验证失败，请稍后再试。'); return; }
    document.getElementById('step2').classList.add('hidden');
    document.getElementById('result').textContent = '申请成功。邀请码：' + r.body.code + '\\n地址：' + r.body.hostname + '\\n请把邀请码粘贴到 DSH 的「专属固定地址」里。';
  }).catch(function () { btn.disabled = false; showError('网络错误，请稍后再试。'); });
};
document.getElementById('restart').onclick = function () {
  try { localStorage.removeItem('bRelayApplicationId'); } catch (_) {}
  requestId = '';
  document.getElementById('step2').classList.add('hidden');
  document.getElementById('step1').classList.remove('hidden');
  document.getElementById('result').textContent = '';
  showError('');
};
if (requestId) {
  document.getElementById('step1').classList.add('hidden');
  document.getElementById('step2').classList.remove('hidden');
  document.getElementById('result').textContent = '已恢复上次申请。输入邮箱验证码即可验证或重取邀请码。';
}
</script>
</body>
</html>`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}
