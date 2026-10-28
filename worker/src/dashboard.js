/**
 * A 中继运维台：静态页面，所有数据都走 /admin/relay/v1/*。
 * 页面本身不内联任何 secret；Cloudflare Access 在 Worker 前面登录。
 */
export const dashboardHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>A 中继运维台</title>
<style>
:root{color-scheme:light;--bg:#f6f7f9;--card:#fff;--line:#e5e7eb;--text:#111827;--muted:#6b7280;--accent:#2563eb;--danger:#dc2626;--ok:#059669}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{background:#111827;color:#fff;padding:18px 24px;display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}
header h1{font-size:18px;margin:0;font-weight:600}header .muted{color:#9ca3af}
main{max-width:1180px;margin:0 auto;padding:20px;display:grid;gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.card h2{font-size:15px;margin:0 0 12px;font-weight:600}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.metric{background:#f9fafb;border:1px solid var(--line);border-radius:8px;padding:12px}
.metric b{display:block;font-size:22px;line-height:1.2}.muted{color:var(--muted)}.small{font-size:12px}
button{font:inherit;border:1px solid var(--line);background:#fff;border-radius:7px;padding:7px 12px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:var(--danger);border-color:#fecaca}
button:disabled{opacity:.5;cursor:not-allowed}
label.switch{display:flex;gap:8px;align-items:center;padding:8px 0}
input[type=checkbox]{width:18px;height:18px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500}code{background:#f3f4f6;padding:2px 6px;border-radius:4px;word-break:break-all}
.notice{border:1px solid #fde68a;background:#fffbeb;color:#92400e;border-radius:8px;padding:10px;margin-top:10px}
.error{border:1px solid #fecaca;background:#fef2f2;color:#991b1b;border-radius:8px;padding:10px;margin-top:10px}
.ok{color:var(--ok)}.hidden{display:none}
</style>
</head>
<body>
<header>
  <div><h1>A 中继运维台</h1><div class="muted small">relay.dsh-mini-remote.com · 数据来自 Worker/D1/KV</div></div>
  <div class="row"><span id="who" class="muted small"></span><button id="refresh">刷新</button></div>
</header>
<main>
  <div id="error" class="error hidden"></div>
  <section class="card">
    <h2>总览</h2>
    <div class="grid">
      <div class="metric"><span class="muted">活跃实例</span><b id="activeCount">—</b></div>
      <div class="metric"><span class="muted">已撤销</span><b id="revokedCount">—</b></div>
      <div class="metric"><span class="muted">未用邀请</span><b id="inviteCount">—</b></div>
      <div class="metric"><span class="muted">数据面</span><b id="proxyState">—</b></div>
    </div>
  </section>

  <section class="card">
    <h2>专属固定地址</h2>
    <div class="muted small" id="bMeta">读取中…</div>
    <table><thead><tr><th>固定地址</th><th>状态</th><th>最近登记</th><th>创建</th></tr></thead><tbody id="bLeases"></tbody></table>
  </section>

  <section class="card">
    <h2>运营开关</h2>
    <label class="switch"><input type="checkbox" id="registrationEnabled"> 允许新实例注册</label>
    <label class="switch"><input type="checkbox" id="inviteRequired"> 新实例必须带邀请码（关闭后为自服务注册）</label>
    <label class="switch"><input type="checkbox" id="proxyEnabled"> 数据面转发（关闭后所有固定地址返回离线页）</label>
    <label class="switch"><input type="checkbox" id="dailyReportEnabled"> 每天自动采集一次用量</label>
    <div class="muted small">每日任务在 Worker Cron 中运行；需要配置 CF_ANALYTICS_TOKEN 才能查到 Cloudflare 用量。</div>
  </section>

  <section class="card">
    <h2>今日用量</h2>
    <div class="row"><button id="refreshUsage">立即采集</button><span class="muted small">每天自动采集可在上方开关。</span></div>
    <div id="usage" class="muted">还没有用量快照。</div>
  </section>

  <section class="card">
    <h2>邀请</h2>
    <div class="row"><button id="newInvite" class="primary">新建 7 天邀请码</button><span class="muted small">未使用、未过期的邀请码会列在下面。</span></div>
    <div id="inviteResult" class="notice hidden"></div>
    <table><thead><tr><th>邀请码</th><th>备注</th><th>到期</th><th></th></tr></thead><tbody id="invites"></tbody></table>
  </section>

  <section class="card">
    <h2>实例</h2>
    <div class="muted small" id="identityMeta"></div>
    <table><thead><tr><th>id</th><th>状态</th><th>最近登记</th><th>创建</th><th></th></tr></thead><tbody id="identities"></tbody></table>
  </section>

  <section class="card">
    <h2>最近审计</h2>
    <table><thead><tr><th>时间</th><th>操作</th><th>目标</th><th>原因</th><th>操作者</th></tr></thead><tbody id="audit"></tbody></table>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
function esc(v){return String(v ?? '').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function time(ms){if(!ms)return '—';try{return new Date(Number(ms)).toLocaleString('zh-CN',{hour12:false})}catch{return '—'}}
function showError(e){$('error').textContent=e;$('error').classList.remove('hidden')}
function hideError(){$('error').classList.add('hidden')}
async function api(path, init){
  const r=await fetch(path,{headers:{'content-type':'application/json'},...init});
  const b=await r.json().catch(()=>({}));
  if(!r.ok||b.ok===false) throw new Error(b.error||('HTTP '+r.status));
  return b;
}
function setChecks(config){
  $('registrationEnabled').checked=!!config.registrationEnabled;
  $('inviteRequired').checked=config.inviteRequired !== false;
  $('proxyEnabled').checked=!!config.proxyEnabled;
  $('dailyReportEnabled').checked=!!config.dailyReportEnabled;
}
function renderB(b){
  const tbody=$('bLeases');
  if(!b || b.ok!==true){
    $('bMeta').textContent=b?.error||'没有 B 控制面数据。';
    tbody.innerHTML='<tr><td colspan="4" class="muted">—</td></tr>';
    return;
  }
  const rows=b.leases||[];
  const count=(state)=>rows.filter((x)=>x.state===state).length;
  $('bMeta').textContent='共 '+rows.length+' 条 · active '+count('active')+' · released '+count('released')+' · retired '+count('retired');
  tbody.innerHTML=rows.map((x)=>'<tr><td><code>'+esc(x.hostname||'—')+'</code></td><td>'+esc(x.state)+'</td><td>'+esc(time(x.lastSeenAt))+'</td><td>'+esc(time(x.createdAt))+'</td></tr>').join('') || '<tr><td colspan="4" class="muted">没有租约。</td></tr>';
}
function usageHtml(u){
  if(!u) return '<span class="muted">还没有用量快照。开启每日任务并配置 token 后，这里会出现。</span>';
  if(u.error) return '<div class="error">'+esc(u.error)+'</div>';
  const rows=[['Workers 请求',u.workers?.requests,100000],['D1 读取行',u.d1?.rowsRead,5000000],['D1 写入行',u.d1?.rowsWritten,100000],['KV 请求',u.kv?.requests,100000]];
  return '<div class="muted small">采集时间：'+esc(time(u.collectedAt))+' · 日期 '+esc(u.day)+'</div><table><thead><tr><th>项目</th><th>用量</th><th>Free 上限</th><th>占比</th></tr></thead><tbody>'+rows.map(([n,v,l])=>{const p=l?Number(v||0)/l*100:0;return '<tr><td>'+esc(n)+'</td><td>'+esc(v??0)+'</td><td>'+esc(l)+'</td><td>'+p.toFixed(1)+'%</td></tr>'}).join('')+'</tbody></table>';
}
async function load(){
  hideError();
  try{
    const [o,ids,audit,invites]=await Promise.all([
      api('/admin/relay/v1/overview'),
      api('/admin/relay/v1/identities?limit=50'),
      api('/admin/relay/v1/audit?limit=30'),
      api('/admin/relay/v1/invites'),
    ]);
    setChecks(o.config||{});
    $('activeCount').textContent=o.counts?.active??'—';
    $('revokedCount').textContent=o.counts?.revoked??'—';
    $('inviteCount').textContent=o.counts?.unusedInvites??'—';
    $('proxyState').textContent=o.config?.proxyEnabled?'开启':'停用';
    $('proxyState').className=o.config?.proxyEnabled?'ok':'';
    $('usage').innerHTML=usageHtml(o.usage);
    renderB(o.b);
    const rows=ids.identities||[];
    $('identityMeta').textContent='共 '+rows.length+' 条（最多显示 50 条）';
    $('identities').innerHTML=rows.map((x)=>'<tr><td><code>'+esc(x.id)+'</code></td><td>'+esc(x.state)+'</td><td>'+esc(time(x.last_seen_at))+'</td><td>'+esc(time(x.created_at))+'</td><td>'+(x.state==='active'?'<button class="danger" data-revoke="'+esc(x.id)+'">撤销</button>':'')+'</td></tr>').join('');
    $('audit').innerHTML=(audit.audit||[]).map((a)=>'<tr><td>'+esc(time(a.at))+'</td><td>'+esc(a.action)+'</td><td>'+esc(a.target||'—')+'</td><td>'+esc(a.reason||'—')+'</td><td>'+esc(a.actor||'—')+'</td></tr>').join('');
    const invRows=invites.invites||[];
    $('invites').innerHTML=invRows.map((x)=>'<tr><td>'+(x.code?'<code>'+esc(x.code)+'</code> <button data-copy="'+esc(x.code)+'">复制</button>':'<span class="muted">旧码不可查看</span>')+'</td><td>'+esc(x.note||'—')+'</td><td>'+esc(time(x.expires_at))+'</td><td></td></tr>').join('') || '<tr><td colspan="4" class="muted">没有未使用的邀请码。</td></tr>';
  }catch(e){showError('读取失败：'+e.message)}
}
async function saveConfig(key,value){
  try{const r=await api('/admin/relay/v1/config',{method:'POST',body:JSON.stringify({[key]:value})});setChecks(r.config);await load()}catch(e){showError('保存失败：'+e.message)}
}
$('registrationEnabled').addEventListener('change',(e)=>saveConfig('registrationEnabled',e.target.checked));
$('inviteRequired').addEventListener('change',(e)=>saveConfig('inviteRequired',e.target.checked));
$('proxyEnabled').addEventListener('change',(e)=>saveConfig('proxyEnabled',e.target.checked));
$('dailyReportEnabled').addEventListener('change',(e)=>saveConfig('dailyReportEnabled',e.target.checked));
$('newInvite').addEventListener('click',async()=>{
  try{const r=await api('/admin/relay/v1/invites',{method:'POST',body:JSON.stringify({expiresInDays:7})});$('inviteResult').classList.remove('hidden');$('inviteResult').innerHTML='新邀请码（只显示这一次）：<br><code>'+esc(r.code)+'</code>';await load()}catch(e){showError('创建邀请失败：'+e.message)}
});
document.addEventListener('click',async(e)=>{
  const copy=e.target?.dataset?.copy;if(copy){try{await navigator.clipboard.writeText(copy);e.target.textContent='已复制'}catch{}return;}
  const id=e.target?.dataset?.revoke;if(!id)return;
  if(!confirm('确定撤销 '+id+'？撤销后固定地址立即失效。'))return;
  try{await api('/admin/relay/v1/revoke',{method:'POST',body:JSON.stringify({id,reason:'ops-console'})});await load()}catch(err){showError('撤销失败：'+err.message)}
});
$('refresh').addEventListener('click',load);
$('refreshUsage').addEventListener('click',async()=>{
  try{const r=await api('/admin/relay/v1/usage/refresh',{method:'POST'});if(r.error)showError(r.error);else{hideError();await load()}}catch(e){showError('采集失败：'+e.message)}
});
load();
</script>
</body></html>`
