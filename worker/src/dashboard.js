/**
 * 固定地址运维台：静态页面，所有数据都走 /admin/relay/v1/*。
 * 页面本身不内联任何 secret；Cloudflare Access 在 Worker 前面登录。
 * 左侧导航切换“共享固定地址”和“专属固定地址”，避免把所有卡片堆在一页。
 */
export const dashboardHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>固定地址运维台</title>
<style>
:root{color-scheme:light;--bg:#f4f6f8;--panel:#fff;--line:#e3e7ec;--text:#172033;--muted:#6b7280;--accent:#1d4ed8;--accent-soft:#e8efff;--danger:#b91c1c;--ok:#047857;--warn:#92400e}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
button{font:inherit}
.topbar{height:60px;background:#111827;color:#fff;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 22px;position:sticky;top:0;z-index:5}
.topbar h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.2px}
.topbar .sub{color:#9ca3af;font-size:12px;margin-left:10px}
.topbar .actions{display:flex;align-items:center;gap:10px}
.layout{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:calc(100vh - 60px)}
.sidebar{background:#fff;border-right:1px solid var(--line);padding:16px 12px;display:flex;flex-direction:column;gap:18px}
.side-title{font-size:12px;color:var(--muted);padding:0 8px;letter-spacing:.08em}
.nav{display:flex;flex-direction:column;gap:4px}
.nav button{text-align:left;border:0;background:transparent;color:var(--text);padding:10px 10px;border-radius:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px}
.nav button:hover{background:#f3f4f6}
.nav button.active{background:var(--accent-soft);color:var(--accent);font-weight:600}
.nav .tag{font-size:11px;color:var(--muted);font-weight:400}
.side-note{margin-top:auto;font-size:12px;color:var(--muted);line-height:1.6;padding:10px 8px;border-top:1px solid var(--line)}
main{padding:22px;max-width:1260px;width:100%}
.page{display:none}.page.active{display:block}
.page-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-bottom:16px}
.page-head h2{font-size:20px;margin:0 0 4px}.page-head p{margin:0;color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.card h3{font-size:15px;margin:0 0 12px;font-weight:600}
.metric{background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:12px}
.metric .k{font-size:12px;color:var(--muted)}.metric .v{font-size:24px;font-weight:650;line-height:1.2;margin-top:2px}
.metric .v.ok{color:var(--ok)}.metric .v.bad{color:var(--danger)}
.muted{color:var(--muted)}.small{font-size:12px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
button.btn{background:#fff;border:1px solid var(--line);border-radius:8px;padding:7px 12px;cursor:pointer}
button.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.btn.danger{color:var(--danger);border-color:#fecaca}
button.btn:disabled{opacity:.5;cursor:not-allowed}
label.switch{display:flex;gap:9px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f1f3f5}
label.switch:last-child{border-bottom:0}
input[type=checkbox]{width:18px;height:18px;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:9px 6px;border-bottom:1px solid #eef1f4;vertical-align:top}
th{color:var(--muted);font-weight:500;white-space:nowrap}
code{background:#f3f4f6;padding:2px 6px;border-radius:4px;word-break:break-all}
.notice{border:1px solid #fde68a;background:#fffbeb;color:var(--warn);border-radius:8px;padding:10px;margin-top:10px}
.error{border:1px solid #fecaca;background:#fef2f2;color:#991b1b;border-radius:8px;padding:10px;margin-bottom:14px}
.ok{color:var(--ok)}.hidden{display:none}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#f3f4f6;color:#374151;white-space:nowrap}
.pill.active{background:#dcfce7;color:#166534}.pill.released{background:#fef3c7;color:#92400e}.pill.retired{background:#e5e7eb;color:#4b5563}
.table-wrap{overflow-x:auto}
@media(max-width:820px){
  .layout{grid-template-columns:1fr}
  .sidebar{border-right:0;border-bottom:1px solid var(--line);padding:10px 12px}
  .nav{flex-direction:row;overflow-x:auto}.nav button{white-space:nowrap}.side-note{display:none}
  main{padding:14px}.topbar{height:auto;padding:12px 14px;flex-wrap:wrap}
}
</style>
</head>
<body>
<header class="topbar">
  <div><h1>固定地址运维台<span class="sub">relay.dsh-mini-remote.com</span></h1></div>
  <div class="actions"><span id="lastUpdated" class="muted small" style="color:#9ca3af"></span><button class="btn" id="refresh">刷新</button></div>
</header>
<div class="layout">
  <aside class="sidebar">
    <div>
      <div class="side-title">路径</div>
      <nav class="nav" id="nav">
        <button data-page="overview" class="active">总览 <span class="tag">两条一起看</span></button>
        <button data-page="visual">可视化 <span class="tag">水位与趋势</span></button>
        <button data-page="shared">共享固定地址 <span class="tag">公共中转</span></button>
        <button data-page="dedicated">专属固定地址 <span class="tag">单独隧道</span></button>
      </nav>
    </div>
    <div class="side-note">共享固定地址走公共中转，开箱即用；专属固定地址为每台电脑单独开一条隧道，路径更短。</div>
  </aside>
  <main>
    <div id="error" class="error hidden"></div>

    <section class="page active" id="page-overview">
      <div class="page-head"><div><h2>总览</h2><p>两条公网路径的当前状态，点左侧可以进入各自详情。</p></div></div>
      <div class="card"><h3>共享固定地址</h3><div class="grid">
        <div class="metric"><div class="k">活跃实例</div><div class="v" id="aActive">—</div></div>
        <div class="metric"><div class="k">已撤销</div><div class="v" id="aRevoked">—</div></div>
        <div class="metric"><div class="k">未用邀请</div><div class="v" id="aInvites">—</div></div>
        <div class="metric"><div class="k">数据面</div><div class="v" id="aProxy">—</div></div>
      </div></div>
      <div class="card"><h3>专属固定地址</h3><div class="grid">
        <div class="metric"><div class="k">租约总数</div><div class="v" id="bTotal">—</div></div>
        <div class="metric"><div class="k">已连接</div><div class="v" id="bActive">—</div></div>
        <div class="metric"><div class="k">已释放</div><div class="v" id="bReleased">—</div></div>
        <div class="metric"><div class="k">已退休</div><div class="v" id="bRetired">—</div></div>
      </div></div>
    </section>

    <section class="page" id="page-visual">
      <div class="page-head"><div><h2>可视化</h2><p>容量水位、租约分布、最近趋势和异常。</p></div><div class="row"><button class="btn" id="refreshOps">立即采集</button></div></div>
      <div class="card"><h3>系统健康</h3><div class="grid">
        <div class="metric"><div class="k">共享数据面</div><div class="v" id="vAProxy">—</div></div>
        <div class="metric"><div class="k">专属控制面</div><div class="v" id="vBControl">—</div></div>
        <div class="metric"><div class="k">专属连接率</div><div class="v" id="vBRatio">—</div></div>
        <div class="metric"><div class="k">采集时间</div><div class="v" id="vCollected" style="font-size:14px;font-weight:500">—</div></div>
      </div></div>
      <div class="card"><h3>容量水位</h3><div id="vMeters" class="muted">读取中…</div></div>
      <div class="card"><h3>专属租约分布</h3><div id="vStates" class="muted">读取中…</div></div>
      <div class="card"><h3>最近趋势</h3><div id="vTrend" class="muted">还没有历史快照。点“立即采集”开始记录。</div></div>
      <div class="card"><h3>异常</h3><div id="vAnomalies" class="muted">没有异常。</div></div>
    </section>

    <section class="page" id="page-shared">
      <div class="page-head"><div><h2>共享固定地址</h2><p>所有用户共用公共中转；地址固定，流量经过中转。</p></div></div>
      <div class="card"><h3>运营开关</h3>
        <label class="switch"><input type="checkbox" id="registrationEnabled"> 允许新实例注册</label>
        <label class="switch"><input type="checkbox" id="inviteRequired"> 新实例必须带邀请码（关闭后为自服务注册）</label>
        <label class="switch"><input type="checkbox" id="proxyEnabled"> 数据面转发（关闭后所有固定地址返回离线页）</label>
        <label class="switch"><input type="checkbox" id="dailyReportEnabled"> 每天自动采集一次用量</label>
        <div class="muted small">每日任务在 Worker Cron 中运行；需要配置 CF_ANALYTICS_TOKEN 才能查到 Cloudflare 用量。</div>
      </div>
      <div class="card"><h3>今日用量</h3><div class="row"><button class="btn" id="refreshUsage">立即采集</button><span class="muted small">每天自动采集可在上方开关。</span></div><div id="usage" class="muted" style="margin-top:10px">还没有用量快照。</div></div>
      <div class="card"><h3>邀请</h3><div class="row"><button class="btn primary" id="newInvite">新建 7 天邀请码</button><span class="muted small">未使用、未过期的邀请码会列在下面。</span></div><div id="inviteResult" class="notice hidden"></div><div class="table-wrap"><table><thead><tr><th>邀请码</th><th>备注</th><th>到期</th></tr></thead><tbody id="invites"></tbody></table></div></div>
      <div class="card"><h3>实例</h3><div class="muted small" id="identityMeta"></div><div class="table-wrap"><table><thead><tr><th>id</th><th>状态</th><th>最近登记</th><th>创建</th><th></th></tr></thead><tbody id="identities"></tbody></table></div></div>
      <div class="card"><h3>最近审计</h3><div class="table-wrap"><table><thead><tr><th>时间</th><th>操作</th><th>目标</th><th>原因</th><th>操作者</th></tr></thead><tbody id="audit"></tbody></table></div></div>
    </section>

    <section class="page" id="page-dedicated">
      <div class="page-head"><div><h2>专属固定地址</h2><p>每台电脑单独一条命名隧道；这里只读查看，开通和释放由插件完成。</p></div></div>
      <div class="card"><h3>租约概览</h3><div class="grid">
        <div class="metric"><div class="k">租约总数</div><div class="v" id="bdTotal">—</div></div>
        <div class="metric"><div class="k">已连接</div><div class="v" id="bdActive">—</div></div>
        <div class="metric"><div class="k">已释放</div><div class="v" id="bdReleased">—</div></div>
        <div class="metric"><div class="k">已退休</div><div class="v" id="bdRetired">—</div></div>
      </div></div>
      <div class="card"><h3>新建激活码</h3><div class="row"><button class="btn primary" id="newBInvite">新建 7 天激活码</button><span class="muted small">给用户一次性开通专属固定地址；7 天内有效。</span></div><div id="bInviteResult" class="notice hidden"></div></div>
      <div class="card"><h3>租约</h3><div class="muted small" id="bMeta">读取中…</div><div class="table-wrap"><table><thead><tr><th>固定地址</th><th>状态</th><th>本机端口</th><th>最近登记</th><th>创建</th></tr></thead><tbody id="bLeases"></tbody></table></div></div>
    </section>
  </main>
</div>
<script>
const $=(id)=>document.getElementById(id);
const state={page:'overview'};
function esc(v){return String(v ?? '').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function time(ms){if(!ms)return '—';try{return new Date(Number(ms)).toLocaleString('zh-CN',{hour12:false})}catch{return '—'}}
function showError(e){$('error').textContent=e;$('error').classList.remove('hidden')}
function hideError(){$('error').classList.add('hidden')}
async function api(path,init){const r=await fetch(path,{headers:{'content-type':'application/json'},...init});const b=await r.json().catch(()=>({}));if(!r.ok||b.ok===false)throw new Error(b.error||('HTTP '+r.status));return b}
function page(p){state.page=p;document.querySelectorAll('.page').forEach((el)=>el.classList.toggle('active',el.id==='page-'+p));document.querySelectorAll('#nav button').forEach((b)=>b.classList.toggle('active',b.dataset.page===p));window.scrollTo({top:0,behavior:'smooth'})}
function setChecks(config){$('registrationEnabled').checked=!!config.registrationEnabled;$('inviteRequired').checked=config.inviteRequired!==false;$('proxyEnabled').checked=!!config.proxyEnabled;$('dailyReportEnabled').checked=!!config.dailyReportEnabled}
function usageHtml(u){
  if(!u)return '<span class="muted">还没有用量快照。开启每日任务并配置 token 后，这里会出现。</span>';
  if(u.error)return '<div class="error">'+esc(u.error)+'</div>';
  const rows=[['Workers 请求',u.workers?.requests,100000],['D1 读取行',u.d1?.rowsRead,5000000],['D1 写入行',u.d1?.rowsWritten,100000],['KV 请求',u.kv?.requests,100000]];
  return '<div class="muted small">采集时间：'+esc(time(u.collectedAt))+' · 日期 '+esc(u.day)+'</div><div class="table-wrap"><table><thead><tr><th>项目</th><th>用量</th><th>Free 上限</th><th>占比</th></tr></thead><tbody>'+rows.map(([n,v,l])=>{const p=l?Number(v||0)/l*100:0;return '<tr><td>'+esc(n)+'</td><td>'+esc(v??0)+'</td><td>'+esc(l)+'</td><td>'+p.toFixed(1)+'%</td></tr>'}).join('')+'</tbody></table></div>';
}
function renderB(b){
  const tbody=$('bLeases');
  if(!b||b.ok!==true){$('bMeta').textContent=b?.error||'没有专属固定地址数据。';tbody.innerHTML='<tr><td colspan="5" class="muted">—</td></tr>';return;}
  const rows=b.leases||[];const count=(s)=>rows.filter((x)=>x.state===s).length;
  $('bMeta').textContent='共 '+rows.length+' 条（最多显示 50 条）';
  $('bdTotal').textContent=rows.length;$('bdActive').textContent=count('active');$('bdReleased').textContent=count('released');$('bdRetired').textContent=count('retired');
  tbody.innerHTML=rows.map((x)=>'<tr><td><code>'+esc(x.hostname||'—')+'</code></td><td><span class="pill '+esc(x.state)+'">'+esc(x.state)+'</span></td><td>'+esc(x.originPort??'—')+'</td><td>'+esc(time(x.lastSeenAt))+'</td><td>'+esc(time(x.createdAt))+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">没有租约。</td></tr>';
}
function renderOverview(o,b){
  $('aActive').textContent=o.counts?.active??'—';$('aRevoked').textContent=o.counts?.revoked??'—';$('aInvites').textContent=o.counts?.unusedInvites??'—';$('aProxy').textContent=o.config?.proxyEnabled?'开启':'停用';$('aProxy').className='v '+(o.config?.proxyEnabled?'ok':'bad');
  const rows=b?.ok===true?(b.leases||[]):[];const count=(s)=>rows.filter((x)=>x.state===s).length;
  $('bTotal').textContent=b?.ok===true?rows.length:'—';$('bActive').textContent=b?.ok===true?count('active'):'—';$('bReleased').textContent=b?.ok===true?count('released'):'—';$('bRetired').textContent=b?.ok===true?count('retired'):'—';
}
function meter(label,value,max,unit){
  const v=Number(value||0),m=Number(max||0),p=m?Math.min(100,v/m*100):0;
  const color=p>=80?'#b91c1c':(p>=60?'#b45309':'#047857');
  return '<div style="margin:10px 0"><div class="row" style="justify-content:space-between"><span>'+esc(label)+'</span><span class="muted small">'+esc(v.toLocaleString('zh-CN'))+' / '+esc(m.toLocaleString('zh-CN'))+' '+(unit||'')+' · '+p.toFixed(1)+'%</span></div><div style="height:10px;background:#eef1f4;border-radius:999px;overflow:hidden;margin-top:5px"><div style="height:100%;width:'+p.toFixed(1)+'%;background:'+color+';border-radius:999px"></div></div></div>';
}
function stateRow(label,value,total,color){
  const p=total?Math.min(100,value/total*100):0;
  return '<div style="margin:10px 0"><div class="row" style="justify-content:space-between"><span>'+esc(label)+'</span><span class="muted small">'+esc(value)+'</span></div><div style="height:10px;background:#eef1f4;border-radius:999px;overflow:hidden;margin-top:5px"><div style="height:100%;width:'+p.toFixed(1)+'%;background:'+color+';border-radius:999px"></div></div></div>';
}
function trendSvg(history){
  const rows=(history||[]).slice(-30);
  if(rows.length<2)return '<span class="muted">至少需要两次采集才能画趋势。</span>';
  const w=720,h=190,pad=26;
  const maxW=Math.max(...rows.map((x)=>Number(x.workers||0)),1);
  const maxB=Math.max(...rows.map((x)=>Number(x.bTotal||0)),1);
  const x=(i)=>pad+(w-pad*2)*(i/(rows.length-1));
  const y=(v,m)=>h-pad-(h-pad*2)*(Number(v||0)/m);
  const line=(key,max,color)=>rows.map((r,i)=>x(i)+','+y(r[key],max)).join(' ');
  return '<svg viewBox="0 0 '+w+' '+h+'" style="width:100%;height:auto;max-height:220px" role="img" aria-label="最近趋势"><line x1="'+pad+'" y1="'+(h-pad)+'" x2="'+(w-pad)+'" y2="'+(h-pad)+'" stroke="#d1d5db"/><line x1="'+pad+'" y1="'+pad+'" x2="'+pad+'" y2="'+(h-pad)+'" stroke="#d1d5db"/><polyline fill="none" stroke="#1d4ed8" stroke-width="2" points="'+line('workers',maxW)+'"/><polyline fill="none" stroke="#047857" stroke-width="2" stroke-dasharray="5 4" points="'+line('bTotal',maxB)+'"/><text x="'+pad+'" y="16" font-size="11" fill="#1d4ed8">共享请求</text><text x="'+(pad+86)+'" y="16" font-size="11" fill="#047857">专属租约</text><text x="'+pad+'" y="'+(h-6)+'" font-size="11" fill="#6b7280">最近 '+rows.length+' 次采集</text></svg>';
}
function renderVisual(o,b,ops){
  const snap=ops?.snapshot||null;
  const usage=snap?.a?.usage||o.usage||null;
  const aCounts=snap?.a?.counts||o.counts||{};
  const bCounts=snap?.b?.counts||{total:(b?.leases||[]).length,active:(b?.leases||[]).filter((x)=>x.state==='active').length,released:(b?.leases||[]).filter((x)=>x.state==='released').length,retired:(b?.leases||[]).filter((x)=>x.state==='retired').length};
  $('vAProxy').textContent=o.config?.proxyEnabled?'开启':'停用';$('vAProxy').className='v '+(o.config?.proxyEnabled?'ok':'bad');
  $('vBControl').textContent=snap?.b?.ok===false?'连不上':(b?.ok===true?'正常':'未知');$('vBControl').className='v '+(snap?.b?.ok===false?'bad':'ok');
  $('vBRatio').textContent=bCounts.total?Math.round(bCounts.active/bCounts.total*100)+'%':'—';
  $('vCollected').textContent=snap?.collectedAt?time(snap.collectedAt):'还没有采集';
  $('vMeters').innerHTML=[
    meter('共享 Workers 请求',usage?.workers?.requests,100000,'次/天'),
    meter('共享 KV 请求',usage?.kv?.requests,100000,'次/天'),
    meter('共享 D1 读取行',usage?.d1?.rowsRead,5000000,'行/天'),
    meter('共享 D1 写入行',usage?.d1?.rowsWritten,100000,'行/天'),
    meter('专属 Tunnel 数量',bCounts.total,1000,'条'),
  ].join('');
  $('vStates').innerHTML=[
    stateRow('已连接',bCounts.active,bCounts.total,'#047857'),
    stateRow('已释放',bCounts.released,bCounts.total,'#b45309'),
    stateRow('已退休',bCounts.retired,bCounts.total,'#6b7280'),
  ].join('');
  $('vTrend').innerHTML=trendSvg(ops?.history);
  const list=snap?.anomalies||[];
  $('vAnomalies').innerHTML=list.length?list.map((x)=>'<div class="notice" style="border-color:'+(x.level==='error'?'#fecaca':'#fde68a')+';background:'+(x.level==='error'?'#fef2f2':'#fffbeb')+';color:'+(x.level==='error'?'#991b1b':'#92400e')+'">'+esc(x.text)+'</div>').join(''):'<span class="muted">没有异常。</span>';
}
async function load(){
  hideError();
  try{
    const [o,ids,audit,invites,b,ops]=await Promise.all([
      api('/admin/relay/v1/overview'),api('/admin/relay/v1/identities?limit=50'),api('/admin/relay/v1/audit?limit=30'),api('/admin/relay/v1/invites'),api('/admin/relay/v1/b/leases'),api('/admin/relay/v1/ops/snapshot'),
    ]);
    setChecks(o.config||{});renderOverview(o,b);renderB(b);renderVisual(o,b,ops);$('usage').innerHTML=usageHtml(o.usage);
    const rows=ids.identities||[];$('identityMeta').textContent='共 '+rows.length+' 条（最多显示 50 条）';
    $('identities').innerHTML=rows.map((x)=>'<tr><td><code>'+esc(x.id)+'</code></td><td>'+esc(x.state)+'</td><td>'+esc(time(x.last_seen_at))+'</td><td>'+esc(time(x.created_at))+'</td><td>'+(x.state==='active'?'<button class="btn danger" data-revoke="'+esc(x.id)+'">撤销</button>':'')+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">没有实例。</td></tr>';
    $('audit').innerHTML=(audit.audit||[]).map((a)=>'<tr><td>'+esc(time(a.at))+'</td><td>'+esc(a.action)+'</td><td>'+esc(a.target||'—')+'</td><td>'+esc(a.reason||'—')+'</td><td>'+esc(a.actor||'—')+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">没有审计记录。</td></tr>';
    const invRows=invites.invites||[];$('invites').innerHTML=invRows.map((x)=>'<tr><td>'+(x.code?'<code>'+esc(x.code)+'</code> <button class="btn" data-copy="'+esc(x.code)+'">复制</button>':'<span class="muted">旧码不可查看</span>')+'</td><td>'+esc(x.note||'—')+'</td><td>'+esc(time(x.expires_at))+'</td></tr>').join('')||'<tr><td colspan="3" class="muted">没有未使用的邀请码。</td></tr>';
    $('lastUpdated').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN',{hour12:false});
  }catch(e){showError('读取失败：'+e.message)}
}
async function saveConfig(key,value){try{const r=await api('/admin/relay/v1/config',{method:'POST',body:JSON.stringify({[key]:value})});setChecks(r.config);await load()}catch(e){showError('保存失败：'+e.message)}}
$('nav').addEventListener('click',(e)=>{const b=e.target.closest('button[data-page]');if(b)page(b.dataset.page)});
$('refresh').addEventListener('click',load);
$('registrationEnabled').addEventListener('change',(e)=>saveConfig('registrationEnabled',e.target.checked));
$('inviteRequired').addEventListener('change',(e)=>saveConfig('inviteRequired',e.target.checked));
$('proxyEnabled').addEventListener('change',(e)=>saveConfig('proxyEnabled',e.target.checked));
$('dailyReportEnabled').addEventListener('change',(e)=>saveConfig('dailyReportEnabled',e.target.checked));
$('newInvite').addEventListener('click',async()=>{try{const r=await api('/admin/relay/v1/invites',{method:'POST',body:JSON.stringify({expiresInDays:7})});$('inviteResult').classList.remove('hidden');$('inviteResult').innerHTML='新邀请码（只显示这一次）：<br><code>'+esc(r.code)+'</code>';await load()}catch(e){showError('创建邀请失败：'+e.message)}});
$('newBInvite').addEventListener('click',async()=>{try{const r=await api('/admin/relay/v1/b/invites',{method:'POST',body:JSON.stringify({expiresInDays:7,note:'ops-console'})});$('bInviteResult').classList.remove('hidden');$('bInviteResult').innerHTML='新激活码（只显示这一次）：<br><code>'+esc(r.code)+'</code><br><span class="small">固定地址：<code>'+esc(r.hostname)+'</code></span>';await load()}catch(e){showError('创建激活码失败：'+e.message)}});
document.addEventListener('click',async(e)=>{const copy=e.target?.dataset?.copy;if(copy){try{await navigator.clipboard.writeText(copy);e.target.textContent='已复制'}catch{}return}const id=e.target?.dataset?.revoke;if(!id)return;if(!confirm('确定撤销 '+id+'？撤销后固定地址立即失效。'))return;try{await api('/admin/relay/v1/revoke',{method:'POST',body:JSON.stringify({id,reason:'ops-console'})});await load()}catch(err){showError('撤销失败：'+err.message)}});
$('refreshOps').addEventListener('click',async()=>{try{const r=await api('/admin/relay/v1/ops/refresh',{method:'POST'});renderVisual(await api('/admin/relay/v1/overview'),await api('/admin/relay/v1/b/leases'),r);await load()}catch(e){showError('采集失败：'+e.message)}});
load();
</script>
</body></html>`
