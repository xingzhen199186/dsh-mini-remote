// dsh-mini-remote 网页客户端：在 DSH 设置页加一个「手机遥控」标签页。
//
// 手写，没有构建步骤：元素一律用 React.createElement 构造，样式全部内联。
// 外层 window.__ModuleLoader__.load({ id, factory }) 的写法照抄 dsh-pocket
// （见其 client/build.mjs 生成的 client/client.js），只把内容换成这里的。
//
// 数据来自同源 GET /mini-remote/pairing（host 侧 lib/index.js 注册的路由）：
//   { ok: true, port, token, entries: [{ kind, label, hint, url, qr }] }
//   { ok: false, error: '……' }   ← 403（不是本机）/ 503（还没起来）/ 500
// 注意：失败时 HTTP 状态码不是 200，但响应体仍是 JSON，里面带着真正的原因，
// 所以这里先解析响应体、再看 body.ok，不拿状态码覆盖原文。

window.__ModuleLoader__.load({
  id: "dsh-mini-remote",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // 客户端模块系统把 react 当模块提供，不是全局，必须 require。
    var React = require("react");

    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    var PAIRING_PATH = '/mini-remote/pairing';
    var TOKEN_PATH = '/mini-remote/token';
    var TUNNEL_PATH = '/mini-remote/tunnel';
    var SERVE_PATH = '/mini-remote/serve';
    var FEISHU_PATH = '/mini-remote/feishu';
    // 「远程窗口」取票那一条（宿主侧路由，只允许本机调用，见 lib/index.js）。
    // 它回 `{ ok:true, url:'http://127.0.0.1:<端口>/mini/mirror/?ticket=…', expiresIn:30 }`。
    var WINDOW_PATH = '/mini-remote/window';
    // 「允许别的电脑连接」那个开关（宿主侧路由，只允许本机调用，见 lib/index.js）。
    // 它收 `{ enabled }`，回的也是整份配对信息（和公网那个开关同形状）。
    // 关着的时候，配对和跨机取票两条路由一条都不接——这是用户能读懂的"关"。
    var REMOTE_ACCESS_PATH = '/mini-remote/remote-access';
    // 「设备名册」那三条（宿主侧路由，只允许本机调用，见 lib/index.js）：
    //   GET  /mini-remote/devices        → { ok:true, devices:[{id,name,kind,createdAt,lastSeen}] }
    //   POST /mini-remote/devices/rename → { id, name } → { ok:true, device }
    //   POST /mini-remote/devices/revoke → { id }       → { ok:true, id, dropped }
    // **回执里永远没有 keyHash、也没有凭据本身**——名册那份东西只在电脑上、只在服务端。
    var DEVICES_PATH = '/mini-remote/devices';
    var DEVICE_RENAME_PATH = '/mini-remote/devices/rename';
    var DEVICE_REVOKE_PATH = '/mini-remote/devices/revoke';
    // 「我能连的电脑」那四条（**B 侧**：这台电脑连得上去哪几台别的电脑。宿主侧路由，
    // 只允许本机调用，见 lib/index.js 与 lib/remotes.js）：
    //   GET  /mini-remote/remotes        → { ok:true, remotes:[{id,name,baseUrl,addedAt,lastOk}] }
    //   POST /mini-remote/remotes/add    → { name?, baseUrl, token } → { ok:true, remote }
    //   POST /mini-remote/remotes/window → { id } → { ok:true, url, expiresIn }   ← 取票（= 重连）
    //   POST /mini-remote/remotes/forget → { id } → { ok:true, id, note }         ← 断开（只动本地）
    // **回执里永远没有凭据**（见 lib/remotes.js 的 publicRecord）：界面拿得到的只有
    // id、名字、地址和两个时间；凭据只活在宿主进程里，去对面取票时放进请求头。
    var REMOTES_PATH = '/mini-remote/remotes';
    var REMOTE_ADD_PATH = '/mini-remote/remotes/add';
    var REMOTE_WINDOW_PATH = '/mini-remote/remotes/window';
    var REMOTE_FORGET_PATH = '/mini-remote/remotes/forget';

    // 侧栏那个图标和中间那一整屏面板共用的一个键。
    // 契约就是这么定的：侧栏条目的 `id` 按原样去寻址 main 槽里 key 相同的那个面板
    // （dsh-client-ui-sidebar 的契约原文：Each list id addresses the matching main panel）。
    var PANEL_ID = 'mini-remote';

    // 颜色走 DSH 主题变量（真名前缀是 --dsw-alias-，深浅色自动跟随）。
    // 每个变量都带一个浅色兜底值，变量缺失时界面仍然可读。
    var styles = {
      card: { background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 12, padding: '16px 20px', maxWidth: 560 },
      title: { fontWeight: 600, fontSize: 13, marginBottom: 4 },
      muted: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.5 },
      warn: { color: 'var(--dsw-alias-state-warn-primary,#b45309)', fontSize: 12, lineHeight: 1.5, marginTop: 4 },
      loading: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 13, marginTop: 12 },
      error: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', fontSize: 13, lineHeight: 1.6, marginTop: 12 },
      block: { borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', marginTop: 16, paddingTop: 16 },
      entryTitle: { fontWeight: 600, fontSize: 13 },
      link: { color: 'var(--dsw-alias-brand-primary,#2563eb)', fontSize: 12, textDecoration: 'underline', display: 'inline-block', marginTop: 4 },
      entryRow: { display: 'flex', alignItems: 'flex-start', gap: 14, marginTop: 10, flexWrap: 'wrap' },
      qr: { width: 180, height: 180, flex: 'none', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', background: '#fff' },
      qrFallback: { width: 180, minHeight: 180, flex: 'none', boxSizing: 'border-box', padding: 12, borderRadius: 10, border: '1px dashed var(--dsw-alias-border-l3,#d1d5db)', color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.5 },
      urlCol: { flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 },
      input: { font: 'inherit', width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12, padding: '7px 9px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', background: 'var(--dsw-alias-bg-base,#fff)', color: 'var(--dsw-alias-label-primary,inherit)' },
      btn: { font: 'inherit', cursor: 'pointer', alignSelf: 'flex-start', height: 30, padding: '0 14px', borderRadius: 999, fontSize: 12, border: '1px solid var(--dsw-alias-button-ghost-active-border,var(--dsw-alias-border-l2,#d1d5db))', background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)' },
      toggleRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 13, cursor: 'pointer' },
      // cloudflared 的报错是多行原文，换行要留住，否则一长条读不了。
      detail: { color: 'var(--dsw-alias-state-warn-primary,#b45309)', fontSize: 12, lineHeight: 1.6, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      // 「远程窗口」面板：整屏嵌一个 iframe。取票那一步失败时，这两种样式就是全部内容
      // ——那时它得读起来像一句话，而不是一个空框。
      panelMsg: { boxSizing: 'border-box', padding: '80px 24px', textAlign: 'center', color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 14, lineHeight: 1.6 },
      // 框铺满面板：**父容器高度拿不准**（可能是定高，也可能是被内容撑开的），
      // 所以外层给一个 320 的兜底高度，里面那个框绝对定位铺满——两种情况都不会塌成一条缝。
      frameWrap: { position: 'relative', boxSizing: 'border-box', width: '100%', height: '100%', minHeight: 320 },
      frame: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, display: 'block', background: 'var(--dsw-alias-bg-base,#fff)' },
      // 「设备」那一块：一行一台。名字和说明在左边（flex:1，窄面板下先让它占满），
      // 动作在右边；撤销那次「二次确认」就摊在这一行下面（这个文件里没有弹窗，
      // 全站都是页内两步——跟着来）。
      deviceRow: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 12 },
      deviceMain: { flex: '1 1 200px', minWidth: 0 },
      deviceName: { fontWeight: 600, fontSize: 13, wordBreak: 'break-word' },
      deviceActs: { display: 'flex', gap: 8, flex: 'none' },
      deviceConfirm: { flex: '1 1 100%', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
      // 「其他电脑」那一块：地址单独一行，等宽字体——一长条地址用正文那套字读起来费劲，
      // 而它又是这一行里最要紧的一条（用户要拿它和对面那台电脑上的地址对一眼）。
      remoteUrl: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12, lineHeight: 1.5, wordBreak: 'break-all', color: 'var(--dsw-alias-label-tertiary,#8b93a1)' },
      // 跨机那几句话可能带换行：宿主是**原样转述**对面说的话（`REMOTE_REVOKED_HINT`
      // 就有两行，"接不上那台电脑"那句也有两行）。不设 pre-wrap 的话两行会连成一句，
      // 读起来像中间漏了字。
      say: { fontSize: 12, lineHeight: 1.6, marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    };

    // —— 跨机 · 「其他电脑」这一块的**状态**（2026-10-16 跨机第三步的界面）。
    //
    // 为什么状态放在组件外面：点那一行的人在**设置页那一节**里，被打开的那一整屏在
    // **中间那个面板**里（main 槽里 key=PANEL_ID 的那一个）——两个组件在不同的槽里，
    // 互相看不见。所以这一份放在这里，两边都读它、两边都订它。
    //
    // 只有四样东西，而且**没有"永远转圈"这一档**：点开的是哪一台、正在换票的是哪一台、
    // 换到的那张票、换不到时那一句人话（见 fetchRemoteTicket）。

    /**
     * 用户点开的是**哪一台**（`{ id, name }`；null = 没在看别的电脑）。
     *
     * 它和下面那张票是两件事，分开存**是必须的**：换票失败时（对面撤销了、地址不通），
     * 票还是上一台的那一张——要是照票去画那一屏，屏幕上出现的会是**另一台电脑**的界面，
     * 而用户刚点的这台连一句话都没说。
     */
    var remoteTarget = null;
    /** 已经换到的那张票：`{ id, name, url, at, expiresIn }`；null = 手上没有票。 */
    var remoteWin = null;
    /** 正在为哪一台换票（`''` = 没有在换）。界面照它说「正在换票…」。 */
    var remoteBusyId = '';
    /** `id → { text, revoked }`：那台电脑上一次为什么没成，一句话。 */
    var remoteProblems = {};
    /** 谁想知道上面这三样变了（面板要先重画一遍）。 */
    var remoteWatchers = [];

    function notifyRemote() {
      var list = remoteWatchers.slice();
      for (var i = 0; i < list.length; i += 1) {
        try { list[i](); } catch (err) { /* 一个订阅者出事不该拦住别人 */ }
      }
    }

    /** 订阅那三样。返回退订函数——**组件卸载时必须退订**，否则留住一个死组件。 */
    function subscribeRemote(fn) {
      remoteWatchers.push(fn);
      return function () {
        var at = remoteWatchers.indexOf(fn);
        if (at >= 0) remoteWatchers.splice(at, 1);
      };
    }

    /**
     * 对面把这条记录撤销了时，界面上那句话。
     *
     * 它和宿主写的那句（`REMOTE_REVOKED_HINT`，"那台电脑已经不认这枚凭据了……"）**同时**
     * 出现：这一句说的是"现在是什么状况"，宿主那一句说的是"接下来怎么办"。用户手上真正
     * 能做的只有一件事——拿对面的口令重新配一次，所以这一句必须摆在这一行上。
     */
    var REMOTE_REVOKED_ROW = '这台电脑已经被对方撤销了，要重新配对';

    /**
     * 「对面撤销了」这个判据为什么只能认字。
     *
     * 宿主那一半把对面回的 **401 翻成了 502**，并且换成自己写的那句话（见 lib/index.js 的
     * `REMOTE_REVOKED_HINT`）——**401 本身到不了界面**。所以那句话是界面上唯一能认出
     * "对面撤销了"的信号，认它最独特的那半句。认不出（对面换了说法、或者是别的错）就
     * 照原话显示，**绝不猜**：猜错的代价是让人去重新配对一台其实好着的电脑。
     */
    var REMOTE_REVOKED_MARK = '已经不认这枚凭据';

    /**
     * 那一屏等多久还没打开，就把"空白框"换成一句人话。
     *
     * 为什么需要它：框里是**另一个源**（那台电脑的地址），我们一个字节都读不到
     * （2026-10-16 在无头 Edge 上量过：跨源的 `contentDocument` 是 null）。能等的只有
     * "框自己有没有 load"。量出来的事实是——**502、端口上没人应答都会照常 load**
     * （浏览器把错误页也算一次成功的文档），只有"连上了却一直不回话"这种才是真等不到。
     * 所以这一条**不是**用来判"对面坏了没有"的，它兜的是"一个空白框永远挂在那儿"：
     * 到点就把框换掉，给一句人话和一个「再试一次」——**不能是个转不完的圈**。
     */
    var REMOTE_FRAME_WAIT_MS = 20000;

    /**
     * 去宿主那儿换一张票（**「重连」就是再调一次它**）。返回 `Promise<{ok,error?}>`。
     *
     * ## 每一条路都以一句话结束
     *
     * 「转不完的圈」是这个功能最要防的一种坏法：方案里记着那个前车之鉴——宿主回 502
     * 时，界面外壳**不会重试**，于是永远停在「Loading plugins…」，不自愈。所以这个函数
     * **只有两种结局**：票放进 `remoteWin`，或者一句人能照着做的话放进 `remoteProblems[id]`。
     * 网络层失败、非 200、回执里没有地址，一条都不例外。
     *
     * ## 401 / 502 是怎么变成人话的
     *
     * 401 到不了这里（见 `REMOTE_REVOKED_MARK` 那一段），到的是宿主翻好的 502 +
     * 那句话：这里①**照原话显示**，②认出那句话之后**额外**把这一行标成"已经被对方
     * 撤销了"，让用户知道下一步是重新配对，而不是反复点「重连」。
     * 别的 502（对面 503 / 403 / 地址不通）宿主也各写好了人话（见 lib/index.js 的
     * `remoteStatusText` 与 `callRemote`），照原话显示即可——**界面这一层不自己编**。
     */
    function fetchRemoteTicket(id, name) {
      remoteBusyId = id;
      // 手上前一张票作废：它要么是**上一台**的，要么已经过期了。留着它唯一的后果是
      // 屏幕上出现一台用户没在看的电脑。
      remoteWin = null;
      // 上一次那句话先撤掉：正在重试的时候，那一行不该还挂着上一次的结论。
      delete remoteProblems[id];
      notifyRemote();
      return fetch(REMOTE_WINDOW_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id }),
      }).then(function (res) {
        return res.json().then(
          function (b) { return { status: res.status, body: b }; },
          function () { return { status: res.status, body: null }; },
        );
      }).then(function (r) {
        var b = (r.body && typeof r.body === 'object') ? r.body : null;
        remoteBusyId = '';
        if (b && b.ok === true && typeof b.url === 'string' && b.url) {
          remoteWin = {
            id: id,
            name: name || '',
            url: b.url,
            at: Date.now(),
            // 票的寿命由宿主说了算（真机上是 30 秒）。拿不到就按 0 算＝下次一定重取，
            // 宁可多要一张票，也不要拿一张过期的票去开那一屏。
            expiresIn: Number(b.expiresIn) || 0,
          };
          notifyRemote();
          return { ok: true };
        }
        var text = (b && b.error) || ('换票失败：这台电脑上的服务返回了 HTTP ' + r.status + '。');
        remoteProblems[id] = { text: text, revoked: text.indexOf(REMOTE_REVOKED_MARK) >= 0 };
        notifyRemote();
        return { ok: false, error: text, revoked: remoteProblems[id].revoked };
      }).catch(function (err) {
        remoteBusyId = '';
        var text = '连不上这台电脑上的遥控服务：' + ((err && err.message) || String(err));
        remoteProblems[id] = { text: text, revoked: false };
        notifyRemote();
        return { ok: false, error: text, revoked: false };
      });
    }

    /** 手上那张票是**这一台**的、而且还新鲜吗（留 5 秒余量：别拿一张正好在过期的票去开那一屏）。 */
    function remoteTicketFresh(id) {
      if (!remoteWin || remoteWin.id !== id || !remoteWin.url) return false;
      var ttl = Number(remoteWin.expiresIn) * 1000;
      if (!ttl) return false;
      return (Date.now() - remoteWin.at) < (ttl - 5000);
    }

    /**
     * 设置页那一节。
     *
     * `props.close` 是**设置页外壳递进来的**（dsh-client-ui-settings-general 的
     * `renderSlot("settings.section", { close: onClose })`）：设置页是一个盖在整个界面
     * 上的浮层，要"整屏显示别的电脑"就得先把它关掉——不关的话切过去的那一屏在它后面，
     * 用户看到的是"点了没反应"。拿不到（极简假壳里）也不要紧：那一块会如实说清
     * "点侧栏那枚图标去看"（见 connectRemote）。
     */
    function MiniRemoteSettingsTab(props) {
      var infoState = useState(null);
      var info = infoState[0];
      var setInfo = infoState[1];
      var failState = useState(null);
      var failure = failState[0];
      var setFailure = failState[1];
      var copyState = useState(null);
      var copied = copyState[0];
      var setCopied = copyState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      // 密码默认打码。面板虽然只有本机能看，但屏幕边上站着人的时候很多——
      // 一串明文密码摆在设置页上，截图、投屏、路过，都能带走它。
      var showState = useState(false);
      var showPwd = showState[0];
      var setShowPwd = showState[1];
      var draftState = useState('');
      var draft = draftState[0];
      var setDraft = draftState[1];
      var pwdErrState = useState(null);
      var pwdError = pwdErrState[0];
      var setPwdError = pwdErrState[1];
      // HTTPS 开关的失败信息单独存一份（不是复用上面的 failure）：它要多带一条
      // 「点这里去开启」的链接，一条字符串装不下。
      var serveErrState = useState(null);
      var serveError = serveErrState[0];
      var setServeError = serveErrState[1];
      // 飞书那一块的草稿：服务端那份到了先填进来，之后以用户在这一页改的为准。
      var feishuDraftState = useState(null);
      var feishuDraft = feishuDraftState[0];
      var setFeishuDraft = feishuDraftState[1];
      var feishuErrState = useState(null);
      var feishuError = feishuErrState[0];
      var setFeishuError = feishuErrState[1];
      // 配置指引的展开状态。**默认收起，而且不持久化**：每次进这一页都从头收起，
      // 免得给已经配好的人摊着一屏用不上的字。
      var guideState = useState(false);
      var guideOpen = guideState[0];
      var setGuideOpen = guideState[1];
      // 设备名册（第三步）：服务端那份名单、读不到时的原因，以及"正在改名"和
      // "正在二次确认撤销"这两个**一次只可能有一处**的状态。
      // 两个都存 id，不存整条记录——记录会随每次刷新变，存下来就会拿着一份旧名字去改。
      var devicesState = useState(null);
      var devices = devicesState[0];
      var setDevices = devicesState[1];
      var devErrState = useState(null);
      var devicesError = devErrState[0];
      var setDevicesError = devErrState[1];
      var renameState = useState(null);
      var renaming = renameState[0];
      var setRenaming = renameState[1];
      var confirmState = useState(null);
      var confirming = confirmState[0];
      var setConfirming = confirmState[1];
      // 「其他电脑」那一块（跨机第三步的界面）：我连得上哪几台电脑。名单从宿主那份来
      // （`GET /mini-remote/remotes`），动作两条——添加、断开（断开要二次确认）。
      // 「点这一行」和「重连」是同一件事：去宿主那儿换一张票（见 fetchRemoteTicket）。
      var remotesState = useState(null);
      var remotes = remotesState[0];
      var setRemotes = remotesState[1];
      var remotesErrState = useState(null);
      var remotesError = remotesErrState[0];
      var setRemotesError = remotesErrState[1];
      // 断开之后宿主给的那句话（说清"对面那台电脑上还留着这条记录"）。原样显示。
      var remoteNoteState = useState(null);
      var remoteNote = remoteNoteState[0];
      var setRemoteNote = remoteNoteState[1];
      // 添加那一块：`null` = 收着；一个草稿 = 摊开着（三个框 + 一次确认）。
      var addState = useState(null);
      var addDraft = addState[0];
      var setAddDraft = addState[1];
      var addErrState = useState(null);
      var addError = addErrState[0];
      var setAddError = addErrState[1];
      // 正在二次确认「断开」的那一台（存 id，不存整条记录——记录每次刷新都会变）。
      var forgetState = useState(null);
      var forgetting = forgetState[0];
      var setForgetting = forgetState[1];

      // 同源 GET，不带任何 token：这台电脑自己读得到，别人的电脑读不到。
      useEffect(function () {
        var alive = true;
        fetch(PAIRING_PATH)
          .then(function (res) {
            // 403 / 503 / 500 的响应体也是 JSON，里面写着原因，别按状态码丢掉。
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (!alive) return;
            if (r.body && typeof r.body === 'object') setInfo(r.body);
            else setFailure('读不到配对信息：这台电脑上的服务返回了 HTTP ' + r.status + '。');
          })
          .catch(function (err) {
            if (!alive) return;
            setFailure('连不上这台电脑上的遥控服务：' + ((err && err.message) || String(err)));
          });
        return function () { alive = false; };
      }, []);

      // 「已复制」只停留一会儿，然后自己变回「复制」。
      useEffect(function () {
        if (!copied) return undefined;
        var timer = setTimeout(function () { setCopied(null); }, 1500);
        return function () { clearTimeout(timer); };
      }, [copied]);

      // 服务端那份到了就把飞书的草稿填上。**只填一次**：用户在这一页改过之后，
      // 刷新回来的那份不许把他的编辑抹掉。appSecret 永远是空的——服务端从不把它
      // 送回来（见 saveFeishu 上面那段说明）。
      useEffect(function () {
        if (feishuDraft) return;
        var f = info && info.feishu;
        if (!f) return;
        setFeishuDraft({
          enabled: Boolean(f.enabled),
          appId: typeof f.appId === 'string' ? f.appId : '',
          appSecret: '',
          openIds: typeof f.openIds === 'string' ? f.openIds : '',
          chatIds: typeof f.chatIds === 'string' ? f.chatIds : '',
        });
      }, [info, feishuDraft]);

      var copy = function (url) {
        if (!url) return;
        var clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
        if (!clip || typeof clip.writeText !== 'function') return;
        try {
          var done = clip.writeText(url);
          // 失败就保持原样（不谎报「已复制」）——输入框里的地址仍可手动全选。
          if (done && typeof done.then === 'function') done.then(function () { setCopied(url); }, function () {});
          else setCopied(url);
        } catch (e) { /* 剪贴板不可用：保持原样 */ }
      };

      /**
       * 读设备名单。
       *
       * 每次动作之后都**重新读一遍服务端那份**，而不是在本地改一改数组（改名就把
       * 名字换掉、撤销就把那一行删掉）：屏幕上显示的必须就是服务端此刻认的那份名册。
       * 本地拼一份"看起来对"的列表，迟早和真名册分叉——而分叉的表现正是这一节最不能
       * 出的那种错：「界面上删了，那台手机还能进」。
       */
      var loadDevices = function () {
        return fetch(DEVICES_PATH)
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            var b = (r.body && typeof r.body === 'object') ? r.body : null;
            if (b && b.ok && Array.isArray(b.devices)) {
              setDevices(b.devices);
              setDevicesError(null);
            } else if (r.status === 404 || r.status === 405) {
              // **这条路不在这儿**（宿主那一半是旧版，或者设置页没走到我们那台服务器）。
              // 这一支单独写，是因为那种情况下服务端回的是一句给程序看的「not found」——
              // 原样摆在设置页上，用户看到的就是一条外星文，而下一步其实只有一句话：重启。
              setDevicesError('读设备名单失败：这台电脑上的服务没有这个接口（HTTP ' + r.status + '）。重启一次 DSH 再试。');
            } else {
              setDevicesError((b && b.error) || ('读设备名单失败：服务返回了 HTTP ' + r.status + '。'));
            }
          })
          .catch(function (err) {
            setDevicesError('读设备名单失败：' + ((err && err.message) || String(err)));
          });
      };

      /**
       * 名单在**配对信息到了之后**才拉。
       *
       * 判据只看"配对信息回来没有"，**不看它的 ok**：`ok:false` 说的是"这台电脑现在
       * 没有手机连得上的地址"（比如只绑了回环），而设备名册跟那件事一点关系都没有——
       * 地址连不上的时候，用户恰恰更需要看到名单、把旧设备撤掉。三条路由只要有
       * webServer 就在，和手机服务绑了哪个地址无关。
       */
      useEffect(function () {
        if (!info) return undefined;
        loadDevices();
        // 「其他电脑」那份名单和配对信息也没有关系（它是"我连得上谁"），同一趟一起读。
        loadRemotes();
        return undefined;
      }, [info]);

      /**
       * 一次 POST + 解析 JSON 的短写法。
       *
       * **只给这一节新加的两条动作（改名 / 撤销）用**：文件里别处那些各自还带着自己的
       * 失败分支（有的要把 appSecret 留着、有的要带一条开启链接），硬拧成一股反而看不清。
       * 这里两条的回执形状一样，才值得这一个函数。
       */
      var postJson = function (path, body) {
        return fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (res) {
          return res.json().then(
            function (b) { return { status: res.status, body: b }; },
            function () { return { status: res.status, body: null }; },
          );
        });
      };

      /** 点「改名」：把那台设备切到编辑态。**同时收起别的确认框**（一次只做一件事）。 */
      var startRename = function (one) {
        setConfirming(null);
        setDevicesError(null);
        setRenaming({ id: one.id, draft: typeof one.name === 'string' ? one.name : '' });
      };

      /** 存新名字。名字只是标签，存完照旧认人——所以这里不掐线、不重连。 */
      var saveRename = function () {
        if (!renaming) return;
        var next = (renaming.draft || '').trim();
        if (!next) {
          setDevicesError('名字不能是空的。');
          return;
        }
        setBusy(true);
        postJson(DEVICE_RENAME_PATH, { id: renaming.id, name: next })
          .then(function (r) {
            var b = (r.body && typeof r.body === 'object') ? r.body : null;
            if (!b || b.ok !== true) {
              setDevicesError((b && b.error) || ('改名失败：服务返回了 HTTP ' + r.status + '。'));
              return undefined;
            }
            setDevicesError(null);
            setRenaming(null);
            // **改完再列一次**：屏幕上那份必须来自服务端，不能是我们以为改成了什么。
            return loadDevices();
          })
          .catch(function (err) {
            setDevicesError('改名失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      /**
       * 真的撤销一台设备。**只有二次确认之后才会走到这儿**（见 devicesBlock：
       * 点「撤销」只是把那句后果摊出来，要点「确认撤销」才发这一条）。
       *
       * 服务端那一步会删记录 + 掐掉它手上的活连接（见 lib/index.js 与 lib/server.js
       * 的 dropDeviceConnections）。这边只管如实转述结果，成功之后重新列一次。
       */
      var revokeDevice = function (id) {
        setBusy(true);
        postJson(DEVICE_REVOKE_PATH, { id: id })
          .then(function (r) {
            var b = (r.body && typeof r.body === 'object') ? r.body : null;
            if (!b || b.ok !== true) {
              setDevicesError((b && b.error) || ('撤销失败：服务返回了 HTTP ' + r.status + '。'));
              return undefined;
            }
            setDevicesError(null);
            setConfirming(null);
            return loadDevices();
          })
          .catch(function (err) {
            setDevicesError('撤销失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      // 「其他电脑」那三样状态在组件**外面**（见那一块的开头）：变了就重画一遍。
      // 这一节里点一下「重连」，正在换票 / 换到了 / 没换成**都发生在这里**——
      // 那一行要当场跟着变（尤其是没换成时那句话，它就摆在这一行底下）。
      // 值本身不用，`setPoke` 那一下就是目的。
      var pokeRemoteState = useState(0);
      useEffect(function () {
        return subscribeRemote(function () { pokeRemoteState[1](function (n) { return n + 1; }); });
      }, []);

      /**
       * 读「我能连的电脑」那份名单。
       *
       * 和 `loadDevices` 同一条规矩：每次动作之后**重新读服务端那份**，不在本地改数组。
       * 「界面上删了、其实还留着」在这个功能里同样是最难查的一种错（那一行照旧能点开
       * 对面那台电脑）。
       */
      var loadRemotes = function () {
        return fetch(REMOTES_PATH)
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            var b = (r.body && typeof r.body === 'object') ? r.body : null;
            if (b && b.ok && Array.isArray(b.remotes)) {
              setRemotes(b.remotes);
              setRemotesError(null);
            } else if (r.status === 404 || r.status === 405) {
              // 这条路不在这儿：宿主那一半是旧版。服务端回的是给程序看的 `not found`，
              // 原样摆出来用户读不懂，而下一步只有一句话：重启。
              setRemotesError('读「其他电脑」名单失败：这台电脑上的服务没有这个接口（HTTP ' + r.status + '）。重启一次 DSH 再试。');
            } else {
              setRemotesError((b && b.error) || ('读「其他电脑」名单失败：服务返回了 HTTP ' + r.status + '。'));
            }
          })
          .catch(function (err) {
            setRemotesError('读「其他电脑」名单失败：' + ((err && err.message) || String(err)));
          });
      };

      /** 摊开添加那一块。**同时收起别的确认**（一次只做一件事，照上面的改名/撤销）。 */
      var openAdd = function () {
        setForgetting(null);
        setRemoteNote(null);
        setAddError(null);
        setAddDraft({ name: '', baseUrl: '', token: '' });
      };

      /**
       * 添加一台电脑：拿它的**口令**换一枚自己的凭据（换到了才落盘，见 lib/index.js）。
       *
       * 前端这两道拦的只是"太明显了"的空格（当场说清，不用等一趟网络）；真正的门在宿主
       * 那一边，这里改了那边不改照样进不去——和改密码那一块同一条口径。
       */
      var saveAdd = function () {
        if (!addDraft || busy) return;
        var baseUrl = (addDraft.baseUrl || '').trim();
        var token = (addDraft.token || '').trim();
        if (!baseUrl) {
          setAddError('要填那台电脑的地址——就是它的「手机遥控」页那条（http:// 地址:3090，或者 https:// 的 Tailscale 地址；'
            + '不要带 /mini 和它后面的参数）。');
          return;
        }
        if (!token) {
          setAddError('要填那台电脑的口令（在它的「手机遥控」设置里能复制到）。');
          return;
        }
        setAddError(null);
        setBusy(true);
        postJson(REMOTE_ADD_PATH, {
          name: (addDraft.name || '').trim(),
          baseUrl: baseUrl,
          token: token,
        })
          .then(function (r) {
            var b = (r.body && typeof r.body === 'object') ? r.body : null;
            if (!b || b.ok !== true) {
              setAddError((b && b.error) || ('添加失败：服务返回了 HTTP ' + r.status + '。'));
              return undefined;
            }
            setAddDraft(null);
            setRemoteNote(null);
            // **加完再列一次**：屏幕上那份必须来自服务端（名字是它给的默认值）。
            return loadRemotes();
          })
          .catch(function (err) {
            setAddError('添加失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      /**
       * 真的断开一台电脑：**只删这台电脑上的那一条**（对面那份记录照旧在，见 lib/remotes.js）。
       *
       * 只有二次确认之后才会走到这儿。成功之后把宿主给的那句话（`note`）摆出来——
       * 它说的是"对面还留着这条记录，要彻底收回得去那边撤销"。这是最容易留下的误会：
       * 用户以为断开等于收回了权限。
       */
      var forgetRemote = function (id) {
        setBusy(true);
        postJson(REMOTE_FORGET_PATH, { id: id })
          .then(function (r) {
            var b = (r.body && typeof r.body === 'object') ? r.body : null;
            if (!b || b.ok !== true) {
              setRemotesError((b && b.error) || ('断开失败：服务返回了 HTTP ' + r.status + '。'));
              return undefined;
            }
            setRemotesError(null);
            setForgetting(null);
            setRemoteNote(typeof b.note === 'string' ? b.note : null);
            // 那一台的"上一次为什么没成"跟着这条记录一起没了。
            delete remoteProblems[id];
            notifyRemote();
            return loadRemotes();
          })
          .catch(function (err) {
            setRemotesError('断开失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      /**
       * 「点这一行」和「重连」都走它：**取票 → 把地址交给那一整屏**。
       *
       * ## 为什么先取票、成功了才切过去
       *
       * 取票是这条路上唯一会失败的一步（对面关着、地址不通、被撤销了、它的界面拿不出来
       * ——见 lib/index.js 那几条路由）。**失败时用户还留在设置页上，那句话就摆在刚才点的
       * 那一行底下**——比先跳到一整屏空白再告诉他出事了好得多。
       *
       * ## 切不过去也不装作没事
       *
       * 切那一屏要两样东西：官方布局服务的把手（`layoutFace`），和设置页外壳递进来的
       * `close`（设置页是一个盖在界面上的浮层，不关掉它，切过去的那一屏还在它后面，
       * 用户看到的是"什么都没发生"）。两样缺一，就把"去侧栏那枚图标点一下"这条路指给他
       * ——票已经在手上了，那一下照旧打开。
       */
      var connectRemote = function (one) {
        if (remoteBusyId) return;
        // **先记住"要打开的是哪一台"**：换票失败时那一屏照它说话（不然会说上一台的事）。
        remoteTarget = { id: one.id, name: one.name || '' };
        fetchRemoteTicket(one.id, one.name).then(function (r) {
          if (!r.ok) return;
          if (goToRemotePanel()) return;
          remoteProblems[one.id] = {
            text: '票已经换到了，但这个界面没能自己切到那一屏。关掉设置页，点侧栏那枚「远程窗口」，'
              + '就能看到那台电脑的界面。',
            revoked: false,
          };
          notifyRemote();
        });
      };

      /** 把那一整屏打开：先切面板、再关设置页（顺序的理由见上面那一段）。 */
      var goToRemotePanel = function () {
        if (!layoutFace) return false;
        try {
          layoutFace.selectPanel(PANEL_ID);
        } catch (err) {
          // 布局服务认得的面板里没有我们那个 key（官方那一列还没装配好）：如实说。
          return false;
        }
        var close = props && props.close;
        if (typeof close === 'function') {
          try { close(); } catch (err) { /* 外壳不让我关：那一屏已经在后面打开了 */ }
        }
        return true;
      };
      // 不用等一趟网络；真正的门在服务端，这里改了那边不改也进不去。
      var MIN_PASSWORD_LEN = 12;

      // 换一个自己设的密码。
      var savePassword = function () {
        var next = (draft || '').trim();
        if (next.length < MIN_PASSWORD_LEN) {
          setPwdError('密码至少要 ' + MIN_PASSWORD_LEN + ' 位，现在这串只有 ' + next.length + ' 位。');
          return;
        }
        setPwdError(null);
        setBusy(true);
        fetch(TOKEN_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: next }),
        })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (r.status === 200 && r.body && r.body.ok !== false) {
              setDraft('');
              setInfo(r.body);
            } else {
              setPwdError((r.body && r.body.error) || ('改密码失败：服务返回了 HTTP ' + r.status + '。'));
            }
          })
          .catch(function (err) {
            setPwdError('改密码失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      // 开/关公网访问。这个请求可能要等十几秒（第一次要下载 cloudflared），
      // 所以期间把开关禁掉，免得连点几次起出好几条隧道。
      var toggleTunnel = function (enabled) {
        if (busy) return;
        setBusy(true);
        fetch(TUNNEL_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: enabled }),
        })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (r.body && typeof r.body === 'object') { setInfo(r.body); setFailure(null); }
            else setFailure('切换公网访问失败：服务返回了 HTTP ' + r.status + '。');
          })
          .catch(function (err) {
            setFailure('切换公网访问失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      /**
       * 开/关「允许别的电脑连接」。
       *
       * 和公网那个开关**同一个形状**：POST 一个 `{enabled}`，回来的还是整份配对信息
       * （服务端算好的那一份），界面直接拿它刷新——本地自己改状态的话，那个开关
       * 迟早和 settings.json 里那份分叉，而分叉的表现正是这一节最不能出的那种错：
       * 「界面上开着，其实关着」。
       *
       * 失败不动别的状态，只把那句话摆出来（`failure`）。**默认关**：用户不动它，
       * 这台电脑就不接受别的电脑连过来——装好不会自动打开。
       */
      var toggleRemoteAccess = function (enabled) {
        if (busy) return;
        setBusy(true);
        fetch(REMOTE_ACCESS_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: enabled }),
        })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (r.body && typeof r.body === 'object') { setInfo(r.body); setFailure(null); }
            else setFailure('切换「允许别的电脑连接」失败：服务返回了 HTTP ' + r.status + '。');
          })
          .catch(function (err) {
            setFailure('切换「允许别的电脑连接」失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      /**
       * 开/关 Tailscale 的 HTTPS 地址。
       *
       * 失败时**不复用上面那个 failure**：这条要多带一条「点这里去开启」的链接，
       * 一条字符串装不下。而那条链接恰恰是整个功能里门槛最高的一步——tailnet
       * 后台的一个一次性开关。Tailscale 官方把它印在报错里了，原样递给用户就行。
       *
       * 成功与否的判据是响应体里有没有 `reason`：serve 失败那条路带它，
       * 配对信息那条路不带。配对信息本身也可能是 `ok:false`（比如一条地址都没有），
       * 那种情况照旧交给 setInfo，让面板自己把它画成错误块。
       */
      var toggleServe = function (enabled) {
        if (busy) return;
        setBusy(true);
        setServeError(null);
        fetch(SERVE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: enabled }),
        })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            var b = (r.body && typeof r.body === 'object') ? r.body : null;
            if (!b) {
              setServeError({
                error: '切换 HTTPS 地址失败：服务返回了 HTTP ' + r.status + '。',
                enableLink: null,
              });
              return;
            }
            if (b.reason) {
              setServeError({ error: b.error || '开 HTTPS 地址失败了。', enableLink: b.enableLink || null });
              return;
            }
            setInfo(b);
            setFailure(null);
          })
          .catch(function (err) {
            setServeError({
              error: '切换 HTTPS 地址失败：' + ((err && err.message) || String(err)),
              enableLink: null,
            });
          })
          .then(function () { setBusy(false); });
      };

      /**
       * 存飞书那一块。
       *
       * **appSecret 那一格留空 = 不改动原来那份**。服务端从来不把它送回来（面板上
       * 天生是空的），要是把「空」解释成「清空凭据」，用户每存一次都得重新贴一遍密码，
       * 贴错一次就是一段查不出原因的鉴权失败。所以只在用户真填了东西时才把它发上去。
       *
       * 存完把那个框清掉：它已经落到服务端了，留在页面上只是多一份暴露面。
       */
      var saveFeishu = function () {
        if (!feishuDraft || busy) return;
        setFeishuError(null);
        setBusy(true);
        var body = {
          enabled: Boolean(feishuDraft.enabled),
          appId: feishuDraft.appId,
          openIds: feishuDraft.openIds,
          chatIds: feishuDraft.chatIds,
        };
        if (feishuDraft.appSecret) body.appSecret = feishuDraft.appSecret;
        fetch(FEISHU_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (res) {
            return res.json().then(
              function (b) { return { status: res.status, body: b }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            var b = (r.body && typeof r.body === 'object') ? r.body : null;
            if (!b) {
              setFeishuError('保存飞书配置失败：服务返回了 HTTP ' + r.status + '。');
              return;
            }
            setInfo(b);
            setFeishuError(null);
            setFeishuDraft(function (d) { return (d ? Object.assign({}, d, { appSecret: '' }) : d); });
          })
          .catch(function (err) {
            setFeishuError('保存飞书配置失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      return h('div', { style: styles.card },
        h('div', { style: styles.title }, '手机遥控'),
        h('div', { style: styles.muted }, '手机扫码就能用，不用输密码——密码已经编在二维码里了。'),
        h('div', { style: styles.warn }, '这个页面带着密码，别截图发出去。'),
        content(info, failure, copied, copy, busy, toggleTunnel, {
          showPwd: showPwd,
          setShowPwd: setShowPwd,
          draft: draft,
          setDraft: setDraft,
          busy: busy,
          pwdError: pwdError,
          savePassword: savePassword,
        }, {
          // **摊平再传**。serveError 自己是 `{error, enableLink}`，如果直接写成
          // `{error: serveError}`，serveBlock 里的 `err.error` 拿到的就是整个对象，
          // 而 `h('div', {}, 对象)` 渲染出来是一个**空**的 div——错误文字一个字都不
          // 显示，界面上看上去只是「点了没反应」。2026-09-24 就是这么踩进去的：
          // 状态和渲染全是对的，只有最后一步取错了字段。
          error: serveError ? serveError.error : null,
          enableLink: serveError ? serveError.enableLink : null,
          toggle: toggleServe,
        }, {
          draft: feishuDraft,
          setDraft: setFeishuDraft,
          error: feishuError,
          busy: busy,
          save: saveFeishu,
          guideOpen: guideOpen,
          toggleGuide: function () { setGuideOpen(function (v) { return !v; }); },
        }, {
          // 「设备」那一块：名单 + 两个动作 + 只属于这一块的失败原因。
          list: devices,
          error: devicesError,
          renaming: renaming,
          confirming: confirming,
          busy: busy,
          startRename: startRename,
          setRenaming: setRenaming,
          cancelRename: function () { setRenaming(null); setDevicesError(null); },
          saveRename: saveRename,
          askRevoke: function (id) { setRenaming(null); setDevicesError(null); setConfirming(id); },
          cancelRevoke: function () { setConfirming(null); },
          revoke: revokeDevice,
        }, {
          // 跨机那个总开关（2026-10-16 第二步）。和 serve/feishu/dev 一样摊平成一个
          // 对象传：状态在 `info.remote` 里跟配对信息一起下来，动作就是上面那个 POST。
          toggle: toggleRemoteAccess,
        }, {
          // 「其他电脑」那一块：名单 + 添加 + 两个动作，以及只属于那一块的两句话
          // （读名单失败的原因、断开之后那句"对面还留着"）。
          list: remotes,
          error: remotesError,
          note: remoteNote,
          add: addDraft,
          addError: addError,
          forgetting: forgetting,
          busy: busy,
          openAdd: openAdd,
          setAddDraft: setAddDraft,
          cancelAdd: function () { setAddDraft(null); setAddError(null); },
          saveAdd: saveAdd,
          askForget: function (id) { setAddDraft(null); setRemotesError(null); setForgetting(id); },
          cancelForget: function () { setForgetting(null); },
          forget: forgetRemote,
          connect: connectRemote,
        }),
      );
    }

    function content(info, failure, copied, copy, busy, toggle, pwd, serve, feishu, dev, remote, rmt) {
      if (failure) return h('div', { style: styles.error }, failure);
      if (!info) return h('div', { style: styles.loading }, '正在读取配对信息…');

      var blocks = [];
      if (info.ok === false) {
        blocks.push(h('div', { key: 'err', style: styles.error }, info.error || '读取配对信息失败。'));
      } else {
        var entries = Array.isArray(info.entries) ? info.entries : [];
        if (!entries.length) {
          blocks.push(h('div', { key: 'none', style: styles.muted }, '这台电脑暂时没有手机能连上的地址。'));
        } else {
          for (var i = 0; i < entries.length; i += 1) blocks.push(entryBlock(entries[i], i, copied, copy));
        }
        // 密码紧跟在那几条二维码后面：它是这些链接背后的钥匙，放在一起才讲得通。
        if (typeof info.token === 'string' && info.token) blocks.push(passwordBlock(info, copied, copy, pwd));
      }
      // Tailscale 那一行：**没探到的时候也要出现**。原来它是直接不显示的，
      // 用户看到的不是「你没有 Tailscale」，而是「这里什么都没有」——他不知道
      // 自己缺了什么，也就不会去装。而他恰恰是最需要这条路的人。
      if (info.tailscale) blocks.push(tailscaleBlock(info.tailscale));
      // 出错时也要把开关露出来：不然「隧道起不来」会让整个面板变成一条报错，
      // 用户连关掉它的地方都找不到。
      if (info.tunnel) blocks.push(tunnelBlock(info.tunnel, busy, toggle));
      // HTTPS 那一块：**不管配对信息成功还是失败都要出现**。失败时尤其要出现——
      // tailnet 没开 Serve 的时候，用户需要的正是那条开启链接，而那时候面板上
      // 其它东西多半也在报错，正好是他最需要指路的时候。
      if (info.serve || serve.error) blocks.push(serveBlock(info.serve, serve, busy));
      // 飞书那一块：**只要服务端带了 feishu 就出现**（成功、失败、服务还没起来那几条
      // 路径上都带着它）。它是独立的一条通路，手机服务有没有起来都不该拦着用户改它。
      if (info.feishu) blocks.push(feishuBlock(info.feishu, feishu));
      // 设备那一块：**放在最后**。它是"谁进得来"的账本，改名/撤销都在这里；
      // 名单还没读到（服务端没给 / 读失败）而报错也没有时，整块不出现——
      // 不摆一个空壳，也不把上面几块的位置动一寸。
      // 跨机那个总开关**紧挨在名单前面**：这两块说的是同一件事的两半——上面是
      // "许不许别的电脑连过来"，下面是"已经连过来的有哪几台"。顺序反过来的话，
      // 用户先在名单里看见一台不认识的电脑，才在上方找到那个总开关。
      if (info.remote && remote) blocks.push(remoteBlock(info.remote, busy, remote.toggle));
      if (dev && (dev.list !== null || dev.error)) blocks.push(devicesBlock(dev));
      // 「其他电脑」那一块：**排在「设备」后面**。两块说的是相反的两件事——上面那份是
      // "谁进得来"（别人连我这台），这一份是"我连得上谁"（我从这台去连别人）。顺序上先
      // 说别人进来的（那是权限边界，也是这一页的主语），再说我出去的。
      if (rmt && (rmt.list !== null || rmt.error)) blocks.push(remotesBlock(rmt));
      return h('div', null, blocks);
    }

    /** 时间戳 → 「2026-10-16 14:20」。取不到（0/坏值）回 null，由调用方去说「还没有记录」。 */
    function formatTime(ms) {
      var n = Number(ms);
      if (!n) return null;
      var t = new Date(n);
      if (isNaN(t.getTime())) return null;
      var p = function (v) { return (v < 10 ? '0' : '') + v; };
      return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate())
        + ' ' + p(t.getHours()) + ':' + p(t.getMinutes());
    }

    /**
     * 一台设备那一行里那句小字：**类型 · 创建时间 · 最近使用时间**。
     *
     * `lastSeen` 为 0 时说「还没有记录」而不是编一个时间：老记录（第三步之前写下的
     * 那几条）本来就没有这个字段，编成"创建时间"等于凭空造一次使用。
     */
    function deviceMeta(one) {
      // 类型只影响这一句小字（认人从不看它，见 lib/devices.js）。认得的两种说人话；
      // **认不出的不吞**——原样打出来，比一律写成"设备"容易查。
      var kind = one.kind === 'phone' ? '手机'
        : (one.kind === 'desktop' ? '另一台电脑' : String(one.kind || '设备'));
      var made = formatTime(one.createdAt);
      var seen = formatTime(one.lastSeen);
      var parts = [kind];
      parts.push(made ? '创建于 ' + made : '创建时间读不到');
      parts.push(seen ? '最近使用 ' + seen : '最近使用 还没有记录');
      return parts.join(' · ');
    }

    /**
     * 「设备」那一块：**谁进得来、什么时候进的、改个名字、撤销一台**（2026-10-16 第三步）。
     *
     * ## 为什么撤销的入口在电脑上（用户拍板的）
     *
     * 手机页上"删掉自己"有个死结：删完当场进不去，而下一步正是要在那台手机上做什么。
     * 电脑这边没这个问题——撤销的就是别人（或者手上这台的旧记录）。
     *
     * ## 撤销为什么要点两下
     *
     * 删了那台设备就得**重新扫码**（凭据找不回来，这是设计的一部分，不是缺陷）。
     * 一次点击就造成这个后果太重了，所以第一下只把后果摊在那一行下面，第二下
     * （「确认撤销」）才真的发出去。**不用 window.confirm**：那种弹窗在微信这类内嵌
     * 浏览器里会被直接屏蔽，屏蔽时万一返回真值就等于确认被跳过（手机页那边为同一件
     * 事写过同一段话）。
     *
     * ## 名字和撤销的性质不一样
     *
     * 名字只是标签（见 lib/devices.js 开头）：改了照旧认人。所以「改名」一个点击就够，
     * 不用确认。
     */
    function devicesBlock(d) {
      var list = Array.isArray(d.list) ? d.list : [];
      var rows = list.map(function (one) {
        var editing = Boolean(d.renaming && d.renaming.id === one.id);
        var asking = d.confirming === one.id;
        return h('div', { key: one.id, style: styles.deviceRow },
          h('div', { style: styles.deviceMain },
            editing
              ? h('input', {
                type: 'text',
                value: d.renaming.draft,
                spellCheck: false,
                placeholder: '给这台设备起个名字',
                disabled: Boolean(d.busy),
                onChange: function (e) { d.setRenaming({ id: one.id, draft: e.target.value }); },
                style: styles.input,
              })
              : h('div', { style: styles.deviceName }, one.name ? one.name : '（这台设备没有名字）'),
            h('div', { style: styles.muted }, deviceMeta(one)),
          ),
          h('div', { style: styles.deviceActs },
            editing
              ? h('button', {
                type: 'button', disabled: Boolean(d.busy), onClick: function () { d.saveRename(); }, style: styles.btn,
              }, d.busy ? '保存中…' : '保存')
              : h('button', {
                type: 'button', disabled: Boolean(d.busy), onClick: function () { d.startRename(one); }, style: styles.btn,
              }, '改名'),
            editing
              ? h('button', {
                type: 'button', disabled: Boolean(d.busy), onClick: function () { d.cancelRename(); }, style: styles.btn,
              }, '取消')
              : h('button', {
                type: 'button', disabled: Boolean(d.busy), onClick: function () { d.askRevoke(one.id); }, style: styles.btn,
              }, '撤销'),
          ),
          // 二次确认：**把后果写在按钮旁边**，不是写一句"确定吗"。
          asking ? h('div', { style: styles.deviceConfirm },
            h('div', { style: styles.warn }, '撤销后，这台设备要重新扫码才能再用。'),
            h('button', {
              type: 'button', disabled: Boolean(d.busy), onClick: function () { d.revoke(one.id); }, style: styles.btn,
            }, d.busy ? '撤销中…' : '确认撤销'),
            h('button', {
              type: 'button', disabled: Boolean(d.busy), onClick: function () { d.cancelRevoke(); }, style: styles.btn,
            }, '取消'),
          ) : null,
        );
      });

      return h('div', { key: 'devices', style: styles.block },
        h('div', { style: styles.entryTitle }, '设备'),
        h('div', { style: styles.muted },
          '每一台手机第一次扫码进来时会自动登记，之后不用再扫码。撤销之后，那台设备要重新扫码才能再用。'),
        d.error ? h('div', { style: styles.error }, d.error) : null,
        rows.length
          ? h('div', null, rows)
          : (d.error ? null : h('div', { style: styles.muted, marginTop: 10 }, '这台电脑上还没有登记过的设备。')),
      );
    }

    /**
     * 「其他电脑」那一块：**这台电脑连得上去哪几台别的电脑**（2026-10-16 跨机第三步的界面）。
     *
     * ## 和上面那一块正好相反
     *
     * 「设备」是**谁进得来**（别人连我这台）；这一块是**我连得上谁**（我从这台去连别人）。
     * 两块都摆在设置页上，所以标题得一眼分得开。
     *
     * ## 一行一台，那一行本身就是入口
     *
     * 点那一行 = 打开那台电脑的界面（先取票，见 `connectRemote`）——和本机那枚侧栏图标的
     * 做法一模一样：取票 → 把地址交给框 → 整屏 → 再点侧栏那一条退出。行里另给两个动作：
     * 「重连」（票是一次性的、30 秒就过期，"再换一张"总得有个明确入口）和「断开」。
     * **「重连」和"点这一行"是同一件事**（重连 = 再取一次票，见 lib/index.js 那一段）。
     *
     * ## 「断开」要点两下
     *
     * 照上面「撤销」的做法（这个文件里没有弹窗，全站都是页内两步）：第一下只把后果摊在
     * 那一行下面。**而且要说清"对面还留着"**——断开只动这台电脑，用户很容易以为它等于
     * 收回了对面的权限。
     *
     * ## 这一块上没有"转圈"
     *
     * 正在换票时那一行写「取票中…」，失败了就写一句人能照着做的话（`remoteProblems`；
     * 对面撤销了另有专门的一句）。**没有任何一格会永远停在"加载中"**——见 fetchRemoteTicket。
     */
    function remotesBlock(r) {
      var list = Array.isArray(r.list) ? r.list : [];

      var rows = list.map(function (one) {
        var asking = r.forgetting === one.id;
        var problem = remoteProblems[one.id];
        var working = remoteBusyId === one.id;
        var lastOk = formatTime(one.lastOk);
        return h('div', {
          key: one.id,
          style: Object.assign({}, styles.deviceRow, { cursor: 'pointer' }),
          // 点这一行 = 打开那台电脑的界面。**点在行里的按钮上不算"点这一行"**——
          // 不然一按「断开」就会顺手去取票（那是两件相反的事）。
          onClick: function (e) {
            var t = e && e.target;
            if (t && typeof t.closest === 'function' && t.closest('button')) return;
            r.connect(one);
          },
        },
          h('div', { style: styles.deviceMain },
            h('div', { style: styles.deviceName }, one.name ? one.name : '（这台电脑没有名字）'),
            h('div', { style: styles.remoteUrl }, one.baseUrl || ''),
            h('div', { style: styles.muted }, lastOk ? '最近成功 ' + lastOk : '最近成功 还没有记录'),
          ),
          h('div', { style: styles.deviceActs },
            h('button', {
              type: 'button',
              disabled: Boolean(r.busy || working),
              onClick: function () { r.connect(one); },
              style: styles.btn,
            }, working ? '取票中…' : '重连'),
            h('button', {
              type: 'button',
              disabled: Boolean(r.busy),
              onClick: function () { r.askForget(one.id); },
              style: styles.btn,
            }, '断开'),
          ),
          working ? h('div', { style: styles.muted }, '正在向那台电脑换一张通行证…') : null,
          // 上一次为什么没成。**另起一行**（`deviceConfirm` 那个 `flex:1 1 100%`），不然这句话
          // 会挤在按钮旁边，断成两截。对面撤销了这一条**单独一句**摆在最前面：用户下一步该做的
          // 是重新配对，而不是反复点「重连」；宿主那两行原文照登，里面写着"拿口令重新添加"。
          problem ? h('div', {
            style: problem.revoked
              ? Object.assign({}, styles.warn, styles.say, styles.deviceConfirm)
              : Object.assign({}, styles.error, styles.say, styles.deviceConfirm),
          }, problem.revoked ? REMOTE_REVOKED_ROW + '。' : problem.text) : null,
          problem && problem.revoked ? h('div', {
            style: Object.assign({}, styles.muted, styles.say, styles.deviceConfirm),
          }, problem.text) : null,
          asking ? h('div', { style: styles.deviceConfirm },
            h('div', { style: styles.warn }, '断开之后，这台电脑就不再连它了：这条记录和本地存的那枚凭据一起删掉。'
              + '对面那台电脑上还留着「这台电脑」这条记录——要彻底收回，得去它那边撤销那一台。'),
            h('button', {
              type: 'button', disabled: Boolean(r.busy), onClick: function () { r.forget(one.id); }, style: styles.btn,
            }, r.busy ? '断开中…' : '确认断开'),
            h('button', {
              type: 'button', disabled: Boolean(r.busy), onClick: function () { r.cancelForget(); }, style: styles.btn,
            }, '取消'),
          ) : null,
        );
      });

      // 添加那一块：两个框（地址、口令）+ 一个可选的名字，**一次确认**才发出去
      // （口令是密码性质的，打字打到一半就发一趟不合适）。口令打码，和别处一致。
      var addUi = r.add ? h('div', null,
        field('那台电脑的地址（它「手机遥控」页那条，不带 /mini）', r.add.baseUrl, 'http://…', function (v) {
          r.setAddDraft(Object.assign({}, r.add, { baseUrl: v }));
        }, 'text'),
        field('那台电脑的口令（在它的「手机遥控」设置里复制）', r.add.token, '', function (v) {
          r.setAddDraft(Object.assign({}, r.add, { token: v }));
        }, 'password'),
        field('给它起个名字（可留空，留空就用地址当名字）', r.add.name, '', function (v) {
          r.setAddDraft(Object.assign({}, r.add, { name: v }));
        }, 'text'),
        h('div', { style: { marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', {
            type: 'button', disabled: Boolean(r.busy), onClick: r.saveAdd, style: styles.btn,
          }, r.busy ? '配对中…' : '确认添加'),
          h('button', {
            type: 'button', disabled: Boolean(r.busy), onClick: r.cancelAdd, style: styles.btn,
          }, '取消'),
        ),
        r.addError ? h('div', { style: Object.assign({}, styles.error, styles.say) }, r.addError) : null,
      ) : null;

      return h('div', { key: 'remotes', style: styles.block },
        h('div', { style: styles.entryTitle }, '其他电脑'),
        h('div', { style: styles.muted }, '这台电脑连得上去的别的电脑。配对过一台之后，点它那一行就能'
          + '在这儿打开它的界面——和上面那份名单正好相反：上面是「谁进得来」，这里是「我连得上谁」。'),
        h('div', { style: styles.warn }, '要连的那台电脑得先把它的「允许别的电脑连接」打开，'
          + '而且两边要能在网络上互相够到（同一个 Wi-Fi、或者同一条 Tailscale 网络）。'),
        r.error ? h('div', { style: Object.assign({}, styles.error, styles.say) }, r.error) : null,
        // 断开之后宿主给的那句话：说清"对面还留着"（最容易留下的误会）。
        r.note ? h('div', { style: Object.assign({}, styles.muted, styles.say) }, r.note) : null,
        rows.length
          ? h('div', null, rows)
          : (r.error ? null : h('div', { style: styles.muted, marginTop: 10 }, '这台电脑还没连过别的电脑。')),
        h('div', { style: { marginTop: 12 } },
          h('button', { type: 'button', onClick: r.openAdd, style: styles.btn },
            r.add ? '收起这一块' : '添加一台电脑'),
        ),
        addUi,
      );
    }

    /**
     * 飞书那一块：开关、两个凭据、两个允许名单。
     *
     * 为什么两个名单必须摆在明面上：**都空着的时候谁都不认**（判据在 lib/lark.js 的
     * admitSource）——这是刻意的默认值，但用户不会自己猜到。所以名单空着时当场说清，
     * 并把「去哪儿抄自己的 open_id」写出来：发一条消息给这个机器人，DSH 那边的日志里
     * 会打印出来。飞书后台要绕几层菜单才看得到那个 id，等于给非技术用户加门槛。
     *
     * 按钮**只在有改动时才可点**，反馈靠它自己的禁用态（保存中…），不发「已保存」这种话。
     */
    function feishuBlock(st, fs) {
      var d = fs.draft;
      if (!d) return null;
      var status;
      if (!d.enabled) status = '没开。开了之后，在飞书里给这个机器人发消息，指令会交给电脑上的会话，回答再回到那条消息下面。';
      else if (st.error) status = '开着，但没连上。下面就是它说的话。';
      else if (st.starting) status = '正在建立连接…';
      else if (st.connected) status = '已连着。到飞书里给这个机器人发一条纯文本消息试试。';
      else if (st.running) status = '连接挂上了，还没连上飞书。飞书那边一般要等几秒；一直这样多半是网络或者凭据的问题。';
      else status = '开着，但连接还没挂上（保存一次试试）。';

      var listed = d.openIds.trim() !== '' || d.chatIds.trim() !== '';
      var changed = Boolean(
        d.enabled !== Boolean(st.enabled)
        || d.appId !== (st.appId || '')
        || d.openIds !== (st.openIds || '')
        || d.chatIds !== (st.chatIds || '')
        || d.appSecret !== ''
      );

      return h('div', { key: 'feishu', style: styles.block },
        h('div', { style: styles.entryTitle }, '飞书'),
        h('div', { style: styles.muted }, '在飞书里跟这个机器人说话，等于在这里的会话里说话。走长连接，不需要公网地址、也不需要域名。'),
        h('div', { style: styles.warn }, '要先在飞书开放平台建一个企业自建应用，并把它配成「用长连接收消息」。下面那份指引就是这件事的六步；按它点完，以后就不用再进后台了。'),
        h('label', { style: styles.toggleRow },
          h('input', {
            type: 'checkbox',
            checked: Boolean(d.enabled),
            disabled: Boolean(fs.busy),
            onChange: function (e) { fs.setDraft(Object.assign({}, d, { enabled: e.target.checked })); },
          }),
          h('span', null, d.enabled ? '已开启' : '开启'),
        ),
        h('div', { style: st.error ? styles.detail : styles.muted }, status),
        // 上一次保存之后长连接没起来的原因，原文照登。**开关即使被关掉也留着它**——
        // 那正说明用户刚才为什么把它关了，抹掉反而不好排查。
        st.error ? h('div', { style: styles.detail }, st.error) : null,
        // 上一次被白名单挡住的来源。**这一行是新用户能不能自己配通的关键**：
        // 名单默认是空的（谁都不认），而他不可能凭空知道自己的 open_id 长什么样——
        // 发一句、回到这一页刷新、照着抄进名单，再发一次就通了。
        st.rejected ? h('div', { style: styles.warn },
          '上一次被挡住的来源（照抄进下面的名单再保存）：' + (st.rejected.reason || '')) : null,
        field('appId', d.appId, 'cli_ 开头的那一串', function (v) {
          fs.setDraft(Object.assign({}, d, { appId: v }));
        }, 'text'),
        // appSecret 打码，而且**永远是空的**：服务端从不把它送回来。留空保存 = 不动原来那份。
        field('appSecret', d.appSecret, st.hasSecret ? '已经存过一份了，留空就不改动它' : 'App Secret', function (v) {
          fs.setDraft(Object.assign({}, d, { appSecret: v }));
        }, 'password'),
        field('允许的 open_id（一行一个，留空 = 不限这一项。两份都留空 = 谁都不认）', d.openIds, '', function (v) {
          fs.setDraft(Object.assign({}, d, { openIds: v }));
        }, 'text'),
        field('允许的 chat_id（一行一个，留空 = 不限这一项）', d.chatIds, '', function (v) {
          fs.setDraft(Object.assign({}, d, { chatIds: v }));
        }, 'text'),
        listed ? null : h('div', { style: styles.warn },
          '两个名单都空着 = 谁都不认。先给这个机器人发一条消息，再回到这一页刷新一下，'
          + '这里就会显示你的 open_id 和 chat_id，照抄进来保存。'),
        h('div', { style: styles.warn }, '只认单聊（你和他私聊），群里发的这一版不处理。'),
        h('div', { style: { marginTop: 12 } },
          h('button', {
            type: 'button',
            disabled: Boolean(fs.busy) || !changed,
            onClick: fs.save,
            style: styles.btn,
          }, fs.busy ? '保存中…' : '保存'),
        ),
        // 失败才留一行，并写清是哪一环出的问题。
        fs.error ? h('div', { style: styles.error }, fs.error) : null,
        // 后台那六步：**默认收起**。配过一次的人不用再看，摊开着只会把要填的几个框挤下去；
        // 第一次配的人被飞书后台绕住时，这里是他唯一不用另开文档的地方。
        h('div', { style: { marginTop: 12 } },
          h('button', { type: 'button', onClick: fs.toggleGuide, style: styles.btn },
            fs.guideOpen ? '收起配置指引' : '配置指引（飞书后台六步）'),
        ),
        fs.guideOpen ? feishuGuide() : null,
      );
    }

    /**
     * 配置指引的正文。
     *
     * 文案照 `tasks/飞书配置六步.md` 那份原样搬过来，**不在代码里另编一套**：
     * 两边写得不一样的话，用户按界面上说的做完，回头对着文档又会以为自己哪一步做错了。
     * 第 8 步（第一次被挡下、插件在飞书里把 open_id 和 chat_id 回给发消息的人）和上面
     * 「被挡下的来源」那一行说的是同一件事，两处必须对得上。
     *
     * 样式只复用这一页已有的那几种（标题、说明文字、链接），不新增颜色和圆角。
     */
    function feishuGuide() {
      var sections = [
        ['一、建应用并取凭据', [
          '1. 打开飞书开放平台 →「开发者后台」→ 创建企业自建应用，名字随意。',
          '建完先别走：左侧「应用能力」→「添加应用能力」里把机器人加上（漏了这步，飞书里搜不到它）。',
          '2. 在首页「凭证与基础信息」里复制 App ID 和 App Secret——就是要填进上面那一块的那两个值。'
            + 'App Secret 是密码性质的，别外传。',
        ]],
        ['二、告诉飞书「用长连接收消息」', [
          '3. 进「事件与回调」页，订阅方式选「使用长连接接收事件」，不要选要填「请求地址」的那种'
            + '（那种要求电脑能被公网访问）。',
          '4. 同一页点「添加事件」，搜 im.message.receive_v1 加上——意思是「有人给机器人发消息时通知我」。',
        ]],
        ['三、开三项权限', [
          '5. 进「权限管理」→「应用身份权限」（另一个标签「用户身份权限」不用管），搜索框只填 im.message 这半段，'
            + '带上后面的 :receive_as_bot 会搜出 0 条；勾这三项：',
          'im:message:receive_as_bot —— 接收发给机器人的消息',
          'im:message:send_as_bot —— 以机器人身份发消息',
          'im:message —— 回复某条消息',
          '勾完那个数字从 0 变成 3，就是勾对了。',
          'im.message.receive_v1 是事件，在第 4 步那个列表里配，权限页搜不到它。',
        ]],
        ['四、发布', [
          '6. 进「版本管理与发布」→ 创建版本 → 申请发布（自己用选「仅我可见」）。',
          '凡是改过能力、权限、事件，都要重新发布一次才生效，不发布一切不生效。',
          '「开发者小助手」会推给你一条通知（应用审批通过／已发布成功），收到就是生效了。',
          '企业里配了审批就得等管理员通过；自己一个人用通常自己就能批。',
        ]],
        ['五、在插件这边收尾', [
          '7. 打开上面那一块，开关打开，App ID / App Secret 填进去保存。',
          'App Secret 那一格保存后会自动清空，这是故意的（密钥不回显）：灰字变成「已经存过一份了，'
            + '留空就不改动它」就是存上了，以后改别的设置留空保存 = 不动原来那份。',
          '8. 在飞书里搜到这个机器人，给它发一句话：第一次一定被挡下（两份名单都留空时谁都不认）；'
            + '插件会直接在飞书里回你一句，把你的编号告诉你：open_id=ou_xxxxx（可能还带个 chat_id=oc_xxxxx），'
            + '并说明该填到哪一格。照着它回的那句填就行，不用再回电脑上看。',
          '9. 把那个编号填进「允许的 open_id」那一格（chat_id 可以留空），保存后再发一次就成了。',
        ]],
        ['六、用起来之后', [
          '回答是整段一次回来的，会等一会儿。',
          '回答落进手机页当前绑定的那个会话；回答末尾另起一行「会话：<标题>」写的就是它，'
            + '取不到名字时写「未命名会话」。',
          '一轮跑完才有回复；机器人同时只处理一轮。',
        ]],
        ['注意事项', [
          '不要把机器人拉进群：这版只处理单聊，进群后群里任何人发的消息都可能驱动你这台电脑；'
            + '群里被挡时不会回那句话（只对单聊回）。',
          'App Secret 在飞书后台重置过的话，插件这边要重新填一次。',
          '飞书要求「三秒内响应」，我们收到就记账、随后再答，所以偶尔会看到飞书重发同一条'
            + '——插件按消息编号去重，不会重复进会话。',
          '手机上那套（浏览器遥控）不受影响，两条路可以同时用。',
        ]],
      ];
      var out = [h('a', {
        key: 'guide-open',
        href: 'https://open.feishu.cn/',
        target: '_blank',
        rel: 'noreferrer',
        style: styles.link,
      }, '打开飞书开放平台')];
      for (var i = 0; i < sections.length; i += 1) {
        out.push(h('div', { key: sections[i][0], style: styles.entryTitle }, sections[i][0]));
        var lines = sections[i][1];
        for (var j = 0; j < lines.length; j += 1) {
          out.push(h('div', { key: sections[i][0] + j, style: styles.muted }, lines[j]));
        }
      }
      return h('div', { key: 'guide' }, out);
    }

    /** 飞书那一块的一个输入行。标签在上、输入框在下，和这一页其它地方一致。 */
    function field(label, value, placeholder, onChange, type) {
      return h('div', { key: label, style: { marginTop: 10 } },
        h('div', { style: styles.muted }, label),
        h('input', {
          type: type,
          value: value,
          placeholder: placeholder,
          spellCheck: false,
          autoComplete: 'off',
          onChange: function (e) { onChange(e.target.value); },
          style: Object.assign({}, styles.input, { marginTop: 4 }),
        }),
      );
    }

    /**
     * Tailscale 的 HTTPS 地址这一块。
     *
     * 为什么值得单独占一块：手机端有三样东西被明文 http 挡着——完成后提醒、
     * 语音输入、剪贴板的完整能力。浏览器只在加密连接上才给用。
     * 开了这个，Tailscale 那条路上就多出一个 https:// 地址，那三样才有得谈。
     *
     * **它不是第四条路**：同一台电脑、同一个服务、同一条 Tailscale 通道，
     * 只是把连接换成加密的。上面那条明文的照旧能用，也照旧显示。
     */
    function serveBlock(st, err, busy) {
      var on = Boolean(st && st.on);
      var installed = !st || st.installed !== false;
      var other = st && st.urlOfOtherPort ? st.urlOfOtherPort : null;
      var needsLogin = Boolean(st && st.needsLogin);
      // 服务端已经算好了该说哪句话，界面照说就行。
      var stateError = st && st.error ? st.error : null;
      var status;
      if (!installed) {
        status = '这台电脑上没装 Tailscale，所以开不了。上面那条「在外面用（Tailscale）」里有下载链接。';
      } else if (on) {
        status = '已开启。上面那条「Tailscale（加密）」就是它——出门在外用它，地址不用写端口。';
      } else if (needsLogin) {
        // 这一步的下一步动作和「没开」完全不同：他得先去登录，登录之后那个地址才会存在。
        // 合成一句「没开」，一个还没登录的人会反复点开关，怎么点都没反应。
        status = 'Tailscale 装了，但这个账号还没登录。先在电脑上登录一次——手机要连的那个地址，是登录之后才有的。';
      } else if (stateError) {
        status = '问不出来 Tailscale 现在是什么状态。';
      } else if (other) {
        // 不能含糊地说「没开」：用户会以为是自己这台电脑不支持。
        status = 'Tailscale 的 serve 配着，但它指的是别的端口，不是这个插件。想给手机用的话，把下面这个开关打开。';
      } else {
        // 2026-09-27 改口径：这段原来写的是「手机浏览器只在加密连接上才肯给用通知和麦克风」，
        // 那两样我们**都没有实现**（系统通知 2026-09-25 起入口就是藏着的，麦克风图标也已移除），
        // 拿它们当理由等于替自己许一个不存在的功能。加密本身是实打实的好处，就只说加密。
        status = '没开。开了之后 Tailscale 那条路上会多一个 https:// 地址——同一台电脑、同一个服务，'
          + '区别是这条连接本身是加密的（浏览器地址栏上会出现 https 那把锁）。'
          + '第一次开要在浏览器里确认一下（Tailscale 后台的一个开关），插件代不了你点。';
      }

      // 两条链接都是 Tailscale 官方给的，原样递过去。这是整个功能里门槛最高的两步：
      // 一次是登录，一次是给 tailnet 开 Serve。自己写一句「请到后台开启」等于把门槛加回去。
      var loginUrl = needsLogin && st.loginUrl ? st.loginUrl : null;
      var enableUrl = (err && err.enableLink) || (st && st.enableLink) || null;
      var shownError = (err && err.error) || stateError;

      return h('div', { key: 'serve', style: styles.block },
        h('div', { style: styles.entryTitle }, 'HTTPS 地址（Tailscale）'),
        h('div', { style: styles.muted }, '和上面那条 Tailscale 是同一台电脑，区别只在连接加不加密。地址好记，也不用写端口。'),
        h('label', { style: styles.toggleRow },
          h('input', {
            type: 'checkbox',
            checked: on,
            disabled: Boolean(busy) || !installed || needsLogin,
            onChange: function (e) { err.toggle(e.target.checked); },
          }),
          h('span', null, on ? '已开启' : '开启'),
        ),
        h('div', { style: shownError ? styles.detail : styles.muted }, status),
        loginUrl ? h('a', {
          href: loginUrl,
          target: '_blank',
          rel: 'noreferrer',
          style: styles.link,
        }, '点这里去登录（Tailscale 官方页面）') : null,
        enableUrl ? h('a', {
          href: enableUrl,
          target: '_blank',
          rel: 'noreferrer',
          style: styles.link,
        }, '点这里去开启（Tailscale 官方页面）') : null,
        // 失败原文照登，别吞。这条路上最可能的失败是「tailnet 还没开 Serve」，
        // 而那种情况 Tailscale 会印出一条开启链接——上面那条链接才是用户要的东西。
        err && err.error ? h('div', { style: styles.error }, err.error) : null,
      );
    }

    /**
     * 没探到 Tailscale 时的那一行：说清楚缺什么、去哪儿拿。
     *
     * 「装了没登录」和「根本没装」分开说——这两种情况的下一步动作完全不同，
     * 合成一句「请安装 Tailscale」会叫一个已经装了的人再去装一遍。
     */
    function tailscaleBlock(ts) {
      var installed = Boolean(ts.installed);
      return h('div', { key: 'tailscale', style: styles.block },
        h('div', { style: styles.entryTitle }, '在外面用（Tailscale）'),
        h('div', { style: styles.muted }, installed
          ? '这台电脑装了 Tailscale，但没登录（或者没开）。登录之后，手机在外面用流量也能连进来。'
          : '这台电脑上没装 Tailscale。装上并登录之后，手机在外面用流量也能连进来，不用连家里 Wi-Fi。'),
        h('a', {
          href: ts.download || 'https://tailscale.com/download',
          target: '_blank',
          rel: 'noreferrer',
          style: styles.link,
        }, installed ? '打开 Tailscale' : '下载 Tailscale'),
      );
    }

    /**
     * 「允许别的电脑连接」那一节（2026-10-16 跨机第二步）。
     *
     * ## 为什么它得在设置页里、而且默认关
     *
     * 打开它等于**把整个「电脑端界面」交给另一台电脑**（会话记录、模型配置、插件装卸
     * 全在里面）——比手机那条路能碰到的更多。这种边界不能替用户默认打开，所以：
     * 默认关，而且装好之后**不会自己打开**。
     *
     * ## 关着的时候要说清"关的是什么"
     *
     * 不是"少录一项配置"，而是**这台电脑不接受别的电脑连过来**：配对和取票两条都不接。
     * 说清楚这一句，用户才敢让它是关着的。
     *
     * ## 开着的时候要给一句实话
     *
     * 那台电脑拿到的是完整的桌面界面。用户很可能以为"只是看个窗口"，所以这一句风险
     * 必须摆出来——这是唯一一处能提前告诉他的地方。
     */
    function remoteBlock(st, busy, toggle) {
      var on = Boolean(st && st.allowed);
      return h('div', { key: 'remote', style: styles.block },
        h('div', { style: styles.entryTitle }, '允许别的电脑连接'),
        h('div', { style: styles.muted }, '打开之后，另一台电脑可以用这台电脑上的密码配一次对，'
          + '以后就能从那边打开你这台电脑的「电脑端界面」。'),
        h('label', { style: styles.toggleRow },
          h('input', {
            type: 'checkbox',
            checked: on,
            disabled: Boolean(busy),
            onChange: function (e) { toggle(e.target.checked); },
          }),
          h('span', null, on ? '已开启' : '开启'),
        ),
        h('div', { style: styles.muted }, on
          ? '已开启。别的电脑现在连得进来——不想让哪一台进，就在下面的名单里把它撤销。'
          : '没开（默认）。别的电脑连不进来，连配对也不受理——这台电脑现在只接受本机和手机。'),
        on ? h('div', { style: styles.warn }, '那台电脑拿到的是你这台电脑的完整界面：会话记录、模型设置、插件都在里面。只给你信得过的电脑开。') : null,
      );
    }

    function tunnelBlock(tunnel, busy, toggle) {
      var enabled = Boolean(tunnel.enabled);
      var working = Boolean(busy || tunnel.starting);
      var status;
      if (working) status = '正在打开…第一次要先下载一个 50MB 左右的组件，可能要等一会儿。';
      else if (tunnel.up) status = '已开启。上面那条「公网」就是出门用的地址。刚打开的话等半分钟再扫——Cloudflare 要先把这个域名公布出去。';
      // 「一直没拿到地址」和「拿到过、后来断了」是两回事：前者多半还在等，后者得重开一次。
      // 合成一句「还没拿到公网地址」的话，第二种情况的用户会一直等下去。
      else if (enabled) status = tunnel.error
        ? '开着，但公网那边连不上。手机现在走这条路会打不开——下面那段就是它说的话。'
        : '已开启，但还没拿到公网地址。';
      else status = '没开。手机不连家里 Wi-Fi 的时候就进不来（除非装了 Tailscale）。';

      return h('div', { key: 'tunnel', style: styles.block },
        h('div', { style: styles.entryTitle }, '公网访问'),
        h('div', { style: styles.muted }, '不想装 Tailscale 的话就打开这个：走 Cloudflare 的免费隧道，手机在外面用流量也能连进来。'),
        h('label', { style: styles.toggleRow },
          h('input', {
            type: 'checkbox',
            checked: enabled,
            // starting 也要禁掉：那说明**别的地方**（另一个标签页）正在起隧道，
            // 这时候再点一下会起出第二条。
            disabled: Boolean(busy || tunnel.starting),
            onChange: function (e) { toggle(e.target.checked); },
          }),
          h('span', null, enabled ? '已开启' : '开启'),
        ),
        h('div', { style: enabled && tunnel.error ? styles.detail : styles.muted }, status),
        // cloudflared 的原始报错，多行原文照登——排查时这就是全部线索。
        enabled && tunnel.error ? h('div', { style: styles.detail }, tunnel.error) : null,
        enabled ? h('div', { style: styles.warn }, '这个地址每次重启 DSH 都会换一个，换了之后回来重新扫一下码。') : null,
        enabled ? h('div', { style: styles.warn }, '开着的时候这个服务就挂在公网上了。密码仍然是唯一的门，别把地址或二维码发出去。') : null,
      );
    }

    /**
     * 密码这一块。
     *
     * 以前这里只有一句「手机扫码就能用，不用输密码」——话没错，但用户既看不到密码本身，
     * 也没法换一个自己记得住的。2026-09-22 用户报：「手机遥控页面里似乎根本没有密码，
     * 也无法自定义密码」。配对接口其实一直返回着 token，只是从来没人渲染它。
     */
    function passwordBlock(info, copied, copy, pwd) {
      var token = typeof info.token === 'string' ? info.token : '';
      var shown = pwd.showPwd ? token : token.replace(/./g, '•');
      var done = token !== '' && copied === token;
      var pending = typeof info.pendingToken === 'string' ? info.pendingToken : '';
      return h('div', { key: 'password', style: styles.block },
        h('div', { style: styles.entryTitle }, '密码'),
        h('div', { style: styles.muted }, '手机扫码时已经带着它了，不用手输。它就是这道门的钥匙——别截图发出去。'),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h('input', {
            readOnly: true,
            value: shown,
            spellCheck: false,
            // 点一下全选：想复制走的时候不用一格一格拖。
            onFocus: function (e) { try { e.target.select(); } catch (err) { /* 忽略 */ } },
            style: Object.assign({}, styles.input, { flex: '1 1 240px', width: 'auto' }),
          }),
          h('button', {
            type: 'button',
            onClick: function () { pwd.setShowPwd(!pwd.showPwd); },
            style: styles.btn,
          }, pwd.showPwd ? '藏起来' : '显示'),
          h('button', { type: 'button', onClick: function () { copy(token); }, style: styles.btn }, done ? '已复制' : '复制'),
        ),
        // 服务端刚存下、但还没重启，所以还没生效的那个。**必须和上面显示的那个分开说**：
        // 上面那串是此刻真正在用的，重启前手机上认的还是它。
        pending ? h('div', { style: styles.warn },
          '新密码已经存好了，但要重启一次 DSH 才会生效。在那之前手机上用的还是上面这个旧的；'
          + '重启之后，手机上要重新扫一次码。') : null,
        h('div', { style: styles.muted, marginTop: 14 }, '换一个自己记得住的（至少 12 位）：'),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h('input', {
            type: 'text',
            value: pwd.draft,
            placeholder: '想一个自己记得住的',
            spellCheck: false,
            onChange: function (e) { pwd.setDraft(e.target.value); },
            style: Object.assign({}, styles.input, { flex: '1 1 240px', width: 'auto' }),
          }),
          h('button', {
            type: 'button',
            disabled: Boolean(pwd.busy),
            onClick: pwd.savePassword,
            style: styles.btn,
          }, pwd.busy ? '保存中…' : '保存'),
        ),
        pwd.pwdError ? h('div', { style: styles.error }, pwd.pwdError) : null,
      );
    }

    function entryBlock(entry, index, copied, copy) {
      var url = typeof entry.url === 'string' ? entry.url : '';
      var done = url !== '' && copied === url;
      return h('div', { key: entry.kind || String(index), style: styles.block },
        h('div', { style: styles.entryTitle }, entry.label || entry.kind || '手机'),
        entry.hint ? h('div', { style: styles.muted }, entry.hint) : null,
        h('div', { style: styles.entryRow },
          // host 侧二维码画不出来时给的是 null，退化成只显示链接。
          entry.qr
            ? h('img', { src: entry.qr, alt: '手机遥控二维码', style: styles.qr })
            : h('div', { style: styles.qrFallback }, '二维码没画出来，用右边的链接也能进。'),
          h('div', { style: styles.urlCol },
            h('input', {
              readOnly: true,
              value: url,
              spellCheck: false,
              // 点一下就把整条地址选中，方便直接 Ctrl+C。
              onFocus: function (e) { try { e.target.select(); } catch (err) { /* 忽略 */ } },
              style: styles.input,
            }),
            h('button', { type: 'button', onClick: function () { copy(url); }, style: styles.btn }, done ? '已复制' : '复制'),
          ),
        ),
      );
    }

    /**
     * 那一屏开不成时的整屏内容：**一句人话 + 一个「再试一次」**。
     *
     * 这一屏绝对不能是"空白框 + 转圈"——那是这个功能最要防的坏法（方案里记着的前车之鉴：
     * 宿主回 502 时外壳不会重试，于是永远停在「Loading plugins…」，不自愈）。所以：
     * 说清是哪一台、为什么没成（宿主那句话原样转述）、下一步点哪儿。
     */
    function remoteProblemPanel(id, name, problem) {
      return h('div', { style: styles.panelMsg },
        problem.revoked ? h('div', null, REMOTE_REVOKED_ROW + '。') : null,
        h('div', { style: Object.assign({}, styles.muted, styles.say) }, problem.text),
        h('div', { style: { marginTop: 18 } },
          h('button', {
            type: 'button',
            onClick: function () { fetchRemoteTicket(id, name); },
            style: styles.btn,
          }, '再试一次'),
        ),
      );
    }

    /**
     * 「远程窗口」面板——侧栏那个图标点开之后，占满中间那一整列的那一屏。
     *
     * **这一屏嵌的是「电脑端界面」**（同一台电脑上的 DSH 界面，经我们自己的反代搬出来），
     * 不是手机页：官方那一层本来就是给宽屏做的，放进整屏面板正合适。
     *
     * 还有第二种用法（2026-10-16 跨机第三步）：设置页「其他电脑」里点开的那一台。
     * 同一屏、同一套动作——**票**已经在那一块里换好了（`remoteWin`），这里把地址交给框；
     * 「再点一下那一条退出」那套不用改，退出时顺手把"别的电脑"这一趟放下
     * （见 leaveRemotePanel）。
     *
     * ## 为什么要先取一张票，而不是直接把地址写进 src
     *
     * 那个地址后面要跟凭据。**令牌绝不能进 iframe 地址**——浏览历史、截图、别人拿到这台
     * 电脑就能翻出来。所以走两条腿：
     *   · 宿主那一半（同一台电脑、本来就拿着令牌）POST `/mini-remote/window` 换一张
     *     **一次性票**（30 秒、用完即废）；
     *   · 界面这半边只拿得到「票 + 地址」，拼进 src 的只有票。
     *
     * 票进门那一刻会被兑现成一枚**窗口会话 cookie**（框里那些请求全靠它认人），
     * 而票自己**只授权那一次**；地址里留着的那张票之后只用来回答「这一页是我嵌出来的吗」
     * ——桌面端是**跨站**嵌进来的，只能靠票来定「许不许被嵌」。**令牌全程没进过浏览器。**
     *
     * **挂在 useEffect 里**：面板每被打开一次就换一张新票（票是一次性的，上次那张早废了）。
     */
    function MiniRemotePanel() {
      // 本机那一扇：null = 还在换票；{ url } = 换到了；{ error } = 没换成，把原因说给用户听。
      // **选了「其他电脑」时这一趟不跑**：那一张票由设置页那一块去换（见 fetchRemoteTicket），
      // 这里只负责把它的地址交给框。
      var winState = useState(null);
      var win = winState[0];
      var setWin = winState[1];
      // 框一直没打开时的兜底（见 REMOTE_FRAME_WAIT_MS）：到点把空白框换成一句人话。
      var stallState = useState(false);
      var stalled = stallState[0];
      var setStalled = stallState[1];
      // 订阅「其他电脑」那三样（哪一台在换、换到没有、为什么没成）：变了就重画一遍。
      // 值本身不用，`setPoke` 那一下就是目的。
      var pokeState = useState(0);
      var setPoke = pokeState[1];

      useEffect(function () {
        return subscribeRemote(function () { setPoke(function (n) { return n + 1; }); });
      }, []);

      var remoteId = remoteTarget ? remoteTarget.id : '';
      var remoteName = remoteTarget ? remoteTarget.name : '';
      var remoteUrl = (remoteWin && remoteWin.id === remoteId && remoteWin.url) ? remoteWin.url : '';

      useEffect(function () {
        // 选了别的电脑：这一趟不该再去要**本机**那一张票（那会白换一张，而且本机拿不出
        // 可嵌的界面时还会平白报一句错）。
        if (remoteId) return undefined;
        var alive = true;
        fetch(WINDOW_PATH, { method: 'POST' })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (!alive) return;
            var b = (r.body && typeof r.body === 'object') ? r.body : null;
            if (b && b.ok && typeof b.url === 'string' && b.url) setWin({ url: b.url });
            else setWin({ error: (b && b.error) || ('换一张窗口通行证失败：服务返回了 HTTP ' + r.status + '。') });
          })
          .catch(function (err) {
            if (!alive) return;
            setWin({ error: '读不到这台电脑上的遥控服务：' + ((err && err.message) || String(err)) });
          });
        return function () { alive = false; };
      }, [remoteId]);

      // 手上那张票已经不新鲜了（面板是后来才打开的，比如点了侧栏那枚图标）：**现换一张**。
      // 票是一次性的、30 秒就过期，拿一张旧的去开只会开出一片空白——而空白框正是
      // 这一屏最不能出现的东西。
      useEffect(function () {
        if (!remoteId || remoteBusyId === remoteId || remoteTicketFresh(remoteId)) return undefined;
        fetchRemoteTicket(remoteId, remoteName);
        return undefined;
      }, [remoteId, remoteUrl]);

      // 框等不到 load：到点就说人话（见 REMOTE_FRAME_WAIT_MS 里量出来的那几条事实）。
      useEffect(function () {
        if (!remoteId || !remoteUrl) return undefined;
        setStalled(false);
        var timer = setTimeout(function () { setStalled(true); }, REMOTE_FRAME_WAIT_MS);
        return function () { clearTimeout(timer); };
      }, [remoteId, remoteUrl]);

      if (remoteId) {
        var problem = remoteProblems[remoteId];
        if (remoteBusyId === remoteId) return h('div', { style: styles.panelMsg }, '正在向那台电脑换一张通行证…');
        if (problem) return remoteProblemPanel(remoteId, remoteName, problem);
        // 票不在手上、或者手上那张已经不新鲜了：下面那个 effect 正在换一张新的。
        // **这时一个框都不立**——拿一张过期的票去开，只会开出一片空白（然后一直白着）。
        if (!remoteUrl || !remoteTicketFresh(remoteId)) {
          return h('div', { style: styles.panelMsg }, '正在向那台电脑换一张通行证…');
        }
        if (stalled) {
          return remoteProblemPanel(remoteId, remoteName, {
            revoked: false,
            text: '那台电脑的界面一直没打开（等了 ' + Math.round(REMOTE_FRAME_WAIT_MS / 1000) + ' 秒还没看到它）。\n'
              + '它可能刚重启、或者这会儿连不上。点下面的「再试一次」换一张通行证再开一次。',
          });
        }
        if (!remoteUrl) return h('div', { style: styles.panelMsg }, '正在准备远程窗口…');
        return h('div', { style: styles.frameWrap },
          h('iframe', {
            src: remoteUrl,
            title: '另一台电脑的界面',
            // 框里是另一个源，里面一个字节都读不到（量过：跨源的 contentDocument 是 null）。
            // 所以"它回来了没有"只能靠这一下——但**502 和连不上也会照常 load**，
            // 所以它只用来取消下面那个兜底，不用来宣布成功。
            onLoad: function () { setStalled(false); },
            style: styles.frame,
          }));
      }

      if (!win) return h('div', { style: styles.panelMsg }, '正在准备远程窗口…');
      if (win.error) return h('div', { style: styles.panelMsg }, win.error);
      return h('div', { style: styles.frameWrap },
        h('iframe', { src: win.url, title: '电脑端界面', style: styles.frame }));
    }

    // —— 「再点一下退出远程窗口」需要的三样东西：一个能跟官方布局服务说话的把手、
    //    「进远程窗口之前站在哪个面板」这份记忆，和「这一下点的是我们那一条」的认法。
    //
    // **为什么得自己接这一下**：侧栏那一行（按钮、onClick、悬停提示）是官方壳自己画的
    // ——dsh-client-ui-sidebar 的 PanelRow，它 onClick 里调的是官方自己的 selectPanel。
    // 我们注册的只是那一行里的**一枚图标**，拿不到那一行的点击回调。
    // 壳没有开关式的第二态：同一个 id 再选一次就是原值写入，画面不会变——这就是
    // 「点了没反应」的机制。所以退出那一下只能我们自己接。
    var layoutFace = null;        // 官方布局服务 ctx.layout；壳还没装配好时是 null
    var panelBeforeRemote = null; // 进远程窗口之前选中的面板；null = 会话视图（官方默认）

    // 我们那枚图标身上的记号。认「这一条是不是我们那一条」用 DOM 认，不认标题文字
    // ——标题是中文常量，换语言/改文案就失效了。
    var ICON_MARK = 'data-dsh-mini-remote';

    /** 记住「上一个不是远程窗口的面板」——退出时回到它。 */
    function rememberPanel() {
      if (!layoutFace) return;
      var info = layoutFace.panelInfo.getSnapshot();
      var id = info && info.activePanelId;
      if (id !== PANEL_ID) panelBeforeRemote = id;
    }

    /**
     * 退出远程窗口：回到进来之前那一个面板。
     * 拿不到（那个面板的插件被关了之类）就退回会话视图——官方把 null 当「没有选中任何
     * 全局面板」，也就是平时那一屏会话，不是别的东西。
     */
    function leaveRemotePanel() {
      // 退出就把"另一台电脑"这一趟放下：下次点侧栏那一条，看到的是**本机**那一屏
      // （和原来一模一样）。不放的话，隔了半天再点那一条会去开一台早就没在看的电脑。
      if (remoteTarget || remoteWin) {
        remoteTarget = null;
        remoteWin = null;
        notifyRemote();
      }
      if (!layoutFace) return;
      try {
        layoutFace.selectPanel(panelBeforeRemote);
      } catch (err) {
        try { layoutFace.selectPanel(null); } catch (err2) { /* 布局服务已经收摊：什么也不做 */ }
      }
    }

    /**
     * 「已经在远程窗口里，再点一下那一条 → 退出」。
     *
     * **为什么不接在图标上**（2026-10-15 在真页面上量出来的）：侧栏那一条是官方壳画的，
     * 我们在这条行里只有一枚 16×16 的图标，整行却有 252×36。点在文字「远程窗口」或
     * 行内空白上时，点子**根本不经过图标**（元素命中测绘：文字中心底下是官方的
     * span._panelTitle）；官方那一下又是同一个 id 原值写入，等于没动。
     * 实测同一页里：点图标 → 退出；点文字/行中心 → 什么也不发生。用户报的就是后者。
     *
     * 所以听整行。挂在 document 的**捕获**阶段，是从最早的地方下手：
     *   · 点的哪儿都在同一条路径上，文字、空白、键盘回车（click 落在按钮上）一起覆盖；
     *   · 同一个节点上别人 stopPropagation 也拦不掉我们（stopImmediatePropagation 才会）。
     * 只在「这一条已经是当前面板」时动手，否则原样放行，官方那一下照旧把人送进面板。
     */
    function onDocumentClick(e) {
      if (!layoutFace) return;
      var target = e.target;
      var row = target && typeof target.closest === 'function' ? target.closest('button') : null;
      if (!row || !row.querySelector('[' + ICON_MARK + ']')) return;   // 不是我们那一条
      var info = layoutFace.panelInfo.getSnapshot();
      if (!info || info.activePanelId !== PANEL_ID) return;            // 还没进去：让官方照常办
      e.stopPropagation();                                             // 拦掉官方「又选中自己」那一下
      leaveRemotePanel();
    }

    /**
     * 侧栏那排图标里的一个。侧栏把图标塞进一个正方格里，
     * 边长由它给（props.size，展开态 16、收起态 18），选中态由它自己画在按钮上，
     * 所以这里只管颜色跟着 currentColor 走、尺寸跟着 size 走。
     */
    function MiniRemoteIcon(props) {
      var size = typeof props.size === 'number' ? props.size : 16;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        focusable: 'false',
        // 「这一条是我们的」这个记号，给退出那一下的点击判定用（见 onDocumentClick）。
        'data-dsh-mini-remote': '1',
      },
        // 一块屏幕的形状（远程窗口），下面一小段底座。
        h('rect', { x: 1.75, y: 2.75, width: 12.5, height: 8.5, rx: 2, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M6.25 13.25h3.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      );
    }

    function apply(ctx) {
      // —— 「再点一下退出」的接线：拿官方布局服务的把手，并盯住「上一个面板」。
      // 布局服务（ctx.layout）由官方布局插件提供，不是我们依赖的槽位；照着官方插件
      // （dsh-client-ui-approval 等地）的写法用 ctx.inject 等它就绪，就绪前回调不跑、
      // 那两枚函数都是空操作。没有 ctx.inject 的极简假壳（比如离线校验里的那个替身）
      // 直接跳过这一段：图标照画、照常被壳选中，只是没有「再点一次退出」。
      if (typeof ctx.inject === 'function') {
        ctx.inject(['layout'], function (scope) {
          var layout = scope.layout;
          if (!layout || !layout.panelInfo) return;
          layoutFace = layout;
          scope.effect(function () {
            rememberPanel();
            return layout.panelInfo.subscribe(rememberPanel);
          }, 'dsh-mini-remote: 记住进入远程窗口之前的面板');
          // 退出那一下：整条行的点击（文字、空白、键盘回车都算），只在已是当前面板时动手。
          scope.effect(function () {
            document.addEventListener('click', onDocumentClick, true);
            return function () { document.removeEventListener('click', onDocumentClick, true); };
          }, 'dsh-mini-remote: 再点一下那一条就退出远程窗口');
        });
      }

      // —— 侧栏图标 + 中间那一屏面板，一对配套的槽位。
      // main 是 keyed 槽：注册的键写在 `key` 上（不是 id）。官方对这种槽的示例是
      //   ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: '…' }, Comp))
      // 已占用的键只有 `conversation`；`mini-remote` 是新键，不顶掉任何官方界面。
      // 两个槽都由别的插件声明（main 归 dsh-client-ui-layout、panellist 归 dsh-client-ui-sidebar），
      // 所以照上面 settings.section 的老规矩：等声明出现再注册。
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_ID }, MiniRemotePanel);
      });

      // sidebar.panellist 是 list 槽：要 `id`（必需），可选 `order` 和 `label`。
      // id 必须和 main 的 key 一模一样，侧栏点下来才找得到面板。
      // order 让它排在官方那两枚之后（官方用 0 和 10；缺省是 0）。
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            // 传函数：外壳用 resolveSlotLabel 求值（字符串也支持），跟设置页那条保持一致。
            label: () => '远程窗口',
          },
          MiniRemoteIcon,
        );
      });

      // settings.section 由设置域插件声明；这里等声明出现再注册。
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'mini-remote',
            order: 2,
            // 传函数：外壳用 resolveSlotLabel 求值（字符串也支持），函数是更稳的那个。
            label: () => '手机遥控',
          },
          MiniRemoteSettingsTab,
        );
      });
    }

    exports.name = 'dsh-mini-remote';
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  }
});
