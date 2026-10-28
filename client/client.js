// dsh-mini-remote 网页客户端：在 DSH 设置页加一个「遥控设置」标签页。
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
    var useRef = React.useRef;

    /**
     * 主输入设备有没有「悬停」能力。
     *
     * 顶上那条横条要不要自动收起来，取决于这一条：**触摸屏没有悬停这回事**，藏起来就成了
     * 摸不到的东西——而它上面挂着「← 返回列表」，是那一屏唯一的出口。
     * 和 `lib/page.html` 那条镜像顶栏同一条口径（那边用媒体查询，这边是 inline style，
     * 所以在加载时算一次就够）。
     *
     * **算不出来就当作没有悬停** → 横条常驻。宁可多占一行，不可让人出不去。
     */
    var HAS_HOVER = (function () {
      try {
        return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
      } catch (err) {
        return false;
      }
    })();

    var PAIRING_PATH = '/mini-remote/pairing';
    var TOKEN_PATH = '/mini-remote/token';
    var TUNNEL_PATH = '/mini-remote/tunnel';
    var SELF_RELAY_PATH = '/mini-remote/self-relay';
    var B_RELAY_PATH = '/mini-remote/b-relay';
    var SERVE_PATH = '/mini-remote/serve';
    var FEISHU_PATH = '/mini-remote/feishu';
    // **这里原来有一条本机取票的地址常量**：面板点开时拿它去换一张「本机电脑端界面」的票。
    // 2026-10-17 退休了——那段道理写在 `MiniRemotePanel` 的注释里。宿主侧那条路由一个字没动
    // （还在 lib/index.js 上，跨机那条路复用的取票/嵌框/过门也照旧），只是界面上没人走它了。
    // 「允许别的电脑连接」那个开关（宿主侧路由，只允许本机调用，见 lib/index.js）。
    // 它收 `{ enabled }`，回的也是整份配对信息（和公网那个开关同形状）。
    // 关着的时候，配对和跨机取票两条路由一条都不接——这是用户能读懂的"关"。
    var REMOTE_ACCESS_PATH = '/mini-remote/remote-access';
    var AGENT_ACCESS_PATH = '/mini-remote/agent-access';
    var AGENT_LIST_PATH = '/mini-remote/agent-list';
    var B_PROJECTS_PATH = '/mini-remote/b-projects';
    var B_PROJECT_PATH = '/mini-remote/b-project';
    var B_BROWSE_PATH = '/mini-remote/b-browse';
    var B_PROJECT_SESSION_PATH = '/mini-remote/b-project/new-session';
    var AGENT_CODE_PATH = '/mini-remote/agent-pair-code';
    var AGENT_REVOKE_PATH = '/mini-remote/agent-revoke';
    var B_AGENT_STATUS_PATH = '/mini-remote/b-agent/status';
    var B_AGENT_PAIR_PATH = '/mini-remote/b-agent/pair';
    var B_AGENT_MODE_PATH = '/mini-remote/b-agent/mode';
    var B_AGENT_OPTIONS_PATH = '/mini-remote/b-agent/options';
    // 「设备名册」那三条（宿主侧路由，只允许本机调用，见 lib/index.js）：
    //   GET  /mini-remote/devices        → { ok:true, devices:[{id,name,kind,createdAt,lastSeen}] }
    //   POST /mini-remote/devices/rename → { id, name } → { ok:true, device }
    //   POST /mini-remote/devices/revoke → { id }       → { ok:true, id, dropped }
    // **回执里永远没有 keyHash、也没有凭据本身**——名册那份东西只在电脑上、只在服务端。
    var DEVICES_PATH = '/mini-remote/devices';
    var DEVICES_CLEANUP_PATH = '/mini-remote/devices/cleanup';
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
    // 「自检」那一条（宿主侧路由，只允许本机调用，见 lib/index.js）：
    //   GET /mini-remote/selfcheck → 这台电脑在跑哪一版、哪些接口在、开关什么状态
    // **返回值里没有一个字节的凭据**：它只数条数、只报"在不在听、绑了哪些地址"。
    var SELFCHECK_PATH = '/mini-remote/selfcheck';

    // 侧栏那个图标和中间那一整屏面板共用的一个键。
    // 契约就是这么定的：侧栏条目的 `id` 按原样去寻址 main 槽里 key 相同的那个面板
    // （dsh-client-ui-sidebar 的契约原文：Each list id addresses the matching main panel）。
    var PANEL_ID = 'mini-remote';

    // 颜色走 DSH 主题变量（真名前缀是 --dsw-alias-，深浅色自动跟随）。
    // 每个变量都带一个浅色兜底值，变量缺失时界面仍然可读。
    var styles = {
      card: { background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 12, padding: '20px 24px', width: '100%', maxWidth: 640, boxSizing: 'border-box' },
      title: { fontWeight: 600, fontSize: 16, lineHeight: 1.4, marginBottom: 4 },
      muted: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.6 },
      warn: { color: 'var(--dsw-alias-state-warn-primary,#b45309)', fontSize: 12, lineHeight: 1.5, marginTop: 4 },
      loading: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 13, marginTop: 12 },
      error: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', fontSize: 13, lineHeight: 1.6, marginTop: 12 },
      block: { marginTop: 24 },
      entryTitle: { fontWeight: 600, fontSize: 14, lineHeight: 1.5 },
      // 连接方式条目（内网/Tailscale/公网…）的次级标题：组→项两级，和区块标题拉开。
      entryTitleSub: { fontWeight: 500, fontSize: 13, lineHeight: 1.5 },
      link: { color: 'var(--dsw-alias-brand-primary,#2563eb)', fontSize: 12, textDecoration: 'underline', display: 'inline-block', marginTop: 4 },
      entryRow: { display: 'flex', alignItems: 'flex-start', gap: 14, marginTop: 10, flexWrap: 'wrap' },
      qr: { width: 160, height: 160, flex: 'none', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', background: '#fff' },
      qrFallback: { width: 160, minHeight: 160, flex: 'none', boxSizing: 'border-box', padding: 12, borderRadius: 10, border: '1px dashed var(--dsw-alias-border-l3,#d1d5db)', color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.5 },
      // 地址与「复制」同一行：输入框 flex 伸展（下限 180，再窄就换行），按钮贴住它。
      urlCol: { flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      input: { font: 'inherit', width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', background: 'var(--dsw-alias-bg-base,#fff)', color: 'var(--dsw-alias-label-primary,inherit)' },
      btn: { font: 'inherit', cursor: 'pointer', alignSelf: 'flex-start', height: 32, padding: '0 14px', borderRadius: 8, fontSize: 13, border: '1px solid var(--dsw-alias-button-ghost-active-border,var(--dsw-alias-border-l2,#d1d5db))', background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)' },
      toggleRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 13, cursor: 'pointer' },
      // cloudflared 的报错是多行原文，换行要留住，否则一长条读不了。
      detail: { color: 'var(--dsw-alias-state-warn-primary,#b45309)', fontSize: 12, lineHeight: 1.6, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      // 「远程窗口」面板：整屏嵌一个 iframe。取票那一步失败时，这两种样式就是全部内容
      // ——那时它得读起来像一句话，而不是一个空框。
      panelMsg: { boxSizing: 'border-box', padding: '80px 24px', textAlign: 'center', color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 14, lineHeight: 1.6 },
      // 名单那一屏（2026-10-17）：**面板的第一屏**。行样式复用设置页那几样
      // （deviceRow/deviceName/remoteUrl），这里只多一个居中的容器和一行标题。
      listWrap: { boxSizing: 'border-box', width: '100%', maxWidth: 760, margin: '0 auto', padding: '28px 24px' },
      listHead: { fontWeight: 600, fontSize: 14, marginBottom: 6 },
      // 「某一台的界面」那一屏：顶上一条横条（「← 返回列表」+ 这台电脑叫什么 + 「再试一次」），
      // 下面才是那个铺满的框。**横条在每一种状态下都要在**（正在换票、出错、框没起来），
      // 不然用户会卡在那一屏里出不来。
      //
      // **框正常显示时它会自动收起**（鼠标碰顶才滑出，2026-10-17 用户要求）：
      // 那一行平时占着四十来像素，而这块面板是拿来"看另一台电脑的界面"的，能多给一行是一行。
      // 收起用 `max-height: 0`、**不是透明**——透明还占着高度，框就长不上来（同 lib/page.html 那套）。
      screen: { position: 'relative', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', width: '100%', height: '100%', minHeight: 320 },
      /** 收起时最上面那条 16px 的感应带：鼠标碰到就把它勾出来。 */
      screenHot: { position: 'absolute', left: 0, right: 0, top: 0, height: 16, zIndex: 2 },
      /** 横条外壳：收起时高度归零，占位跟着让出来（高度是过渡的，不跳）。 */
      screenBarWrap: { flex: 'none', overflow: 'hidden', transition: 'max-height .25s ease' },
      screenBar: { flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-l2,#e5e7eb)' },
      screenName: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#8b93a1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      // —— 远程窗口里「挑目录 / 登记工作区」的弹层（2026-10-19 加）。
      // 盖在整屏上（`position: fixed`），因为要压住那个跨源 iframe——它自己是个独立文档，
      // 用 `position: absolute` 会被它盖住。
      browseOverlay: {
        position: 'fixed', left: 0, right: 0, top: 0, bottom: 0, zIndex: 100,
        background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: 16, boxSizing: 'border-box',
      },
      browseSheet: {
        width: '100%', maxWidth: 520, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        background: 'var(--dsw-alias-bg-base,#fff)', borderRadius: 12, overflow: 'hidden',
        boxShadow: '0 12px 40px rgba(0,0,0,.25)',
      },
      browseHead: {
        flex: 'none', display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 12px', borderBottom: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
      },
      browseTitle: {
        flex: '1 1 auto', fontSize: 12, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      browseBody: { flex: '1 1 auto', overflowY: 'auto', padding: 8 },
      browseRow: {
        display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
        margin: '2px 0', borderRadius: 8, border: '1px solid transparent',
        background: 'transparent', cursor: 'pointer', fontSize: 13,
        color: 'var(--dsw-alias-label-primary,#1f2328)', overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      browseNote: { padding: '8px 10px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#8b93a1)' },
      browseErr: { padding: '8px 10px', fontSize: 12, color: 'var(--dsw-alias-label-danger,#c62828)' },
      // 「新建文件夹」那一行：输入框 + 建 + 取消。
      browseMkdirRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px' },
      browseInput: {
        flex: '1 1 auto', minWidth: 0, padding: '6px 8px', fontSize: 13,
        border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 8,
        background: 'var(--dsw-alias-bg-base,#fff)', color: 'inherit',
      },
      // 框铺满面板：**父容器高度拿不准**（可能是定高，也可能是被内容撑开的），
      // 所以外层那一条给一个 320 的兜底高度，这一条自己 flex 撑满剩下的那一块。
      frameWrap: { position: 'relative', boxSizing: 'border-box', width: '100%', flex: '1 1 auto', minHeight: 320 },
      frame: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, display: 'block', background: 'var(--dsw-alias-bg-base,#fff)' },
      // 自动重取那一次（2026-10-17 补）：**框上面先摆一条看得见的说明**，框还是照旧铺满下面。
      // 为什么非得有这一条：重试期间那一块本来就是白的/空的，不说话就等于"无声地又转一圈"，
      // 用户会以为界面卡住了（见 REMOTE_AUTO_RETRY_TEXT）。
      frameBox: { display: 'flex', flexDirection: 'column', boxSizing: 'border-box', width: '100%', flex: '1 1 auto', minHeight: 0 },
      frameNote: { flex: 'none', padding: '6px 12px', fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary,#8b93a1)', borderBottom: '1px solid var(--dsw-alias-border-l2,#e5e7eb)' },
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
      // 「自检」那一块的摘要行：整块里最该被看见的一行（哪一版 · 进程何时起的 · 接口几条在）。
      // 用正文色而不是灰字——它要和上面那些说明文字拉开一点层次。
      selfSummary: { fontSize: 12, lineHeight: 1.7, marginTop: 8, color: 'var(--dsw-alias-label-primary,inherit)', wordBreak: 'break-word' },
      // 「自检」里那几样机器味的东西（接口清单、数据目录）：等宽字体 + 保留换行。
      // 一长条路径和十几个接口名用正文那套字读起来分不清，而它们就是要一眼扫过去的。
      code: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12, lineHeight: 1.7, marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--dsw-alias-label-tertiary,#8b93a1)' },
    };

    // 按钮的两个变体：**主操作**（实心品牌色）和**危险操作**（红字红边）。
    // 只换观感，标签和禁用逻辑不动。
    styles.btnPrimary = Object.assign({}, styles.btn, {
      background: 'var(--dsw-alias-brand-primary,#2563eb)',
      border: '1px solid var(--dsw-alias-brand-primary,#2563eb)',
      color: '#fff',
    });
    styles.btnDanger = Object.assign({}, styles.btn, {
      border: '1px solid var(--dsw-alias-state-error-primary,#dc2626)',
      color: 'var(--dsw-alias-state-error-primary,#dc2626)',
    });
    // 等宽输入框：只给地址、口令、配对码、文件路径这类要逐字符核对的内容。
    // 名字、飞书配置这类普通文本用 styles.input（正文字体）。
    styles.monoInput = Object.assign({}, styles.input, {
      fontFamily: 'ui-monospace,Menlo,monospace',
      fontSize: 12,
    });

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

    /**
     * **把「远程窗口」这一趟彻底清干净**（2026-10-19 提出来）。
     *
     * 原本这段只写在退出这一屏那一处（`leaveRemotePanel`）。提成独立函数是因为它有了
     * 第二个调用者：**测试**。那批用例假设「每个场景互不影响」，而保活会让状态跨场景
     * 留下——它们每次开始前必须能把这几样清掉。
     *
     * 这个函数**只清状态、不碰任何渲染**：单独加上它跑一遍测试，应该一条都不红。
     */
    function resetRemoteSession() {
      remoteTarget = null;
      remoteWin = null;
      remoteBusyId = '';
      remoteProblems = {};
    }

    // —— 「框没打开就自动重取一张票、再试一次」用的两样（2026-10-17 补）。
    //
    // 为什么要有它：2026-10-17 拆掉了"面板每 25 秒自己换一张票"那个机制（票只在开门那一下
    // 用一次，之后那一枚窗口会话 cookie 没有寿命——见 `MiniRemotePanel` 里那一段）。拆得对，
    // 但当时**没有补上任何自动恢复**：只剩下用户手点「再试一次」。于是又多出一个洞——
    // **框的第一次加载被拖过票的寿命（30 秒）时**，票在那一刻已经作废，框就白着，
    // 而旧机制那一下"到点重取"本来能顺带把它救回来。这一条就是补上的那个约束。

    /**
     * 这一次「人按下去」的自动重取**用掉了没有**。
     *
     * 只有 20 秒兜底到点那一下会花掉它（每花一次就自动重取一张票、再给框一次机会）。
     * **每一次人主动发起的取票都会把它重置**（名单上点一台 / 设置页点「重连」/ 那一屏的
     * 「再试一次」，都不带 `auto`，见 `fetchRemoteTicket`）——所以"自动重试"永远跟着一次
     * 人的动作，最多一次，**绝不会变成"每 20 秒自己转一圈"那种新的无界行为**。
     */
    var remoteAutoRetrySpent = false;

    /**
     * 屏幕上这一趟正在转的圈 / 立着的框，是不是"第一次没打开、自动再试一次"那一次。
     *
     * 由自动那一次取票置起（`{ auto: true }`），由框真正 load 回来那一下放下。
     * 界面照它换一句话说（见 `REMOTE_AUTO_RETRY_TEXT`）——**不许无声地又转一圈**。
     */
    var remoteAutoRetry = false;

    /** 谁想知道上面这几样变了（面板要先重画一遍）。 */
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
     * 那一屏等多久还没打开，就算"框没打开"：先自动重取一张票再试一次，第二次到点才给人话。
     *
     * 为什么需要它：框里是**另一个源**（那台电脑的地址），我们一个字节都读不到
     * （2026-10-16 在无头 Edge 上量过：跨源的 `contentDocument` 是 null）。能等的只有
     * "框自己有没有 load"。量出来的事实是——**502、端口上没人应答都会照常 load**
     * （浏览器把错误页也算一次成功的文档），只有"连上了却一直不回话"这种才是真等不到。
     * 所以这一条**不是**用来判"对面坏了没有"的，它兜的是"一个空白框永远挂在那儿"。
     *
     * 到点之后做什么（2026-10-17 补的那条约束）：
     *   · 这一次人的动作**还没用过**自动重取 → 先自动重取一张票、再给框一次机会
     *     ——票是一次性的、30 秒就作废，"第一次加载被拖过 30 秒"那个洞就靠这一下救回来
     *     （见 `remoteAutoRetrySpent`）；
     *   · 自动那一趟也没成、又到点 → 才把框换成一句人话 + 「再试一次」，**不能是个转不完的圈**。
     */
    var REMOTE_FRAME_WAIT_MS = 20000;

    /**
     * 自动重取那一次在屏幕上写的那句话（2026-10-17 补）。
     *
     * 为什么非有不可：换票那一刻和重试那个框的这 20 秒里，那一块本来就是白的/空的
     * （`MiniRemotePanel` 里那两处渲染用它顶着）。不说话就等于"无声地又转一圈"，
     * 用户会以为界面卡住了——这正是这一条补丁自己要防的坏法。
     */
    var REMOTE_AUTO_RETRY_TEXT = '第一次没打开，正在再试一次…';

    /**
     * 去宿主那儿换一张票，最多等多久（**这一条请求自己的超时**）。
     *
     * 为什么定 15 秒：宿主那一半替我们去问那台电脑时**自己有一条 8 秒的上限**
     * （lib/index.js 的 `REMOTE_CALL_TIMEOUT_MS` 与 `callRemote` 里那个 `AbortSignal.timeout`），
     * 所以正常情况下最坏 ~8 秒就会带着一句人话回来。15 秒 = 那条上限 + 一段余量
     * （宿主进程正忙、本机这一跳排在长任务后面）。**比 8 秒小是不对的**：那会把
     * "慢一点但会成"的正当请求掐掉，用户白点一次。
     *
     * 这一条防的是**另一个形状**的坏：宿主整个不回话（本机这个服务卡住、这一跳根本没被处理）
     * ——那种情况下请求不会自己失败，界面就永远停在"正在向那台电脑换一张通行证…"，
     * 那正是这个功能最要防的"转不完的圈"。到点主动掐掉，换成一句人话 + 「再试一次」。
     */
    var REMOTE_TICKET_WAIT_MS = 15000;

    /**
     * 等不到宿主回话时，那一屏上写的那句话（落到 `remoteProblems[id]` 里走现成那条路：
     * **一句人话 + 「再试一次」+ 顶上那条「← 返回列表」**，见 remoteProblemPanel 与 remoteScreen）。
     */
    var REMOTE_TIMEOUT_TEXT = '等这台电脑上的遥控服务回话，等了 ' + Math.round(REMOTE_TICKET_WAIT_MS / 1000) + ' 秒还没等到。\n'
      + '它可能正忙，或者这会儿本机的服务卡住了。点下面的「再试一次」再换一张通行证。';

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
     *
     * ## 等不到回话：这一条请求**自己带一个超时**
     *
     * 见 `REMOTE_TICKET_WAIT_MS`。到点我们主动掐掉这一趟，而且**认得出是"我们等不及了"**
     * ——那不是网络自己断的，给的人话也必须是另一句（"等了 15 秒还没等到"）。
     *
     * ## 三个入口 + 一个自动入口（2026-10-17 补）
     *
     * 人按的三个（名单上点一台 / 设置页点「重连」/ 那一屏的「再试一次」）都不带 `opts`；
     * 第四个是**框没打开时那一下自动重取**，带 `{ auto: true }`（见 `remoteAutoRetrySpent`）。
     * 两者的差别只有一处：自动那一次**不重置**那份预算，所以自动重取绝不会自己接着自己转。
     */
    function fetchRemoteTicket(id, name, opts) {
      // **是不是"框没打开"那一下的自动重取**（2026-10-17 补，见 remoteAutoRetrySpent/remoteAutoRetry）。
      // 人按的每一次（不带 auto）都把那份预算重置：自动重取于是**永远跟着一次人的动作、最多一次**；
      // 而「再试一次」是人按的，所以它照旧可以一直点下去（无限次）。
      var auto = !!(opts && opts.auto);
      remoteAutoRetry = auto;
      if (!auto) remoteAutoRetrySpent = false;
      remoteBusyId = id;
      // 手上前一张票作废：它要么是**上一台**的，要么已经过期了。留着它唯一的后果是
      // 屏幕上出现一台用户没在看的电脑。
      remoteWin = null;
      // 上一次那句话先撤掉：正在重试的时候，那一行不该还挂着上一次的结论。
      delete remoteProblems[id];
      notifyRemote();
      // `spent`：这一趟已经落地（成功/失败/超时）。一立起来，**后面再来什么回音都不改了**
      // ——超时之后才回来的那份回执，拿它去开框等于让屏幕上突然冒出一个用户已经放弃的界面。
      var spent = false;
      var stopper = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = null;
      /**
       * 这一趟落地成"没成"：一句人话进 `remoteProblems[id]`，并清掉"正在换票"。
       * 和别的失败走的是**同一条路**——那一屏照旧是人话 + 「再试一次」+ 「← 返回列表」。
       */
      var fail = function (text) {
        if (spent) return { ok: false, error: text, revoked: false };
        spent = true;
        clearTimeout(timer);
        remoteBusyId = '';
        remoteProblems[id] = { text: text, revoked: false };
        notifyRemote();
        return { ok: false, error: text, revoked: false };
      };
      // **这一条请求自己的超时**（时长与理由见 REMOTE_TICKET_WAIT_MS）。
      // 掐不掉那条请求时（老浏览器没有 AbortController）状态也照落：迟到的回执被 `spent`
      // 挡住，界面绝不会停在"正在换票…"上。
      timer = setTimeout(function () {
        if (stopper) stopper.abort();
        fail(REMOTE_TIMEOUT_TEXT);
      }, REMOTE_TICKET_WAIT_MS);
      return fetch(REMOTE_WINDOW_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id }),
        signal: stopper ? stopper.signal : undefined,
      }).then(function (res) {
        return res.json().then(
          function (b) { return { status: res.status, body: b }; },
          function () { return { status: res.status, body: null }; },
        );
      }).then(function (r) {
        if (spent) return { ok: false, error: REMOTE_TIMEOUT_TEXT, revoked: false };
        spent = true;
        clearTimeout(timer);
        var b = (r.body && typeof r.body === 'object') ? r.body : null;
        remoteBusyId = '';
        if (b && b.ok === true && typeof b.url === 'string' && b.url) {
          remoteWin = {
            id: id,
            name: name || '',
            url: b.url,
            at: Date.now(),
            // 票的寿命（宿主说了算，真机上是 30 秒）。**界面不再照它定期重取**：票只在
            // "开这一台"那一刻用一次（进门那一下兑成窗口会话 cookie），地址一旦交给框就不再变。
            // 留着这两个字段是如实记下宿主回执的形状，也方便出事时对时间。
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
        if (spent) return { ok: false, error: REMOTE_TIMEOUT_TEXT, revoked: false };
        return fail('连不上这台电脑上的遥控服务：' + ((err && err.message) || String(err)));
      });
    }

    /**
     * 从「某一台的界面」**退回名单**：手上这一趟放下，人还留在我们这一屏里（2026-10-17）。
     *
     * 和下面的 `leaveRemotePanel` 是两件事：那个是**离开这一屏**（回到进来之前那一屏），
     * 这个是**只上一层**。两处都用到它：界面顶上那枚「← 返回列表」，和"再点一下侧栏那一条"
     * （见 onDocumentClick）。
     */
    function leaveRemoteScreen() {
      // **只清"在看哪一台"，不清 `remoteWin`**（2026-10-19 保活）：那一屏的 iframe 要留着。
      // 「彻底放下这一趟」只有一处——`resetRemoteSession`（退出这一屏时调）。
      remoteTarget = null;
      notifyRemote();
    }

    /**
     * 从名单上点开一台：**先记住是哪一台**，再去换一张票（那一下的成败都落在这一份状态里）。
     *
     * 顺序是刻意的：先写 `remoteTarget` 再取票，取票失败时那一屏才说得清"是哪一台没成"
     * ——照票去画的话，屏幕上会出现上一台电脑的界面（见 `remoteTarget` 那段）。
     * 设置页那一块（`connectRemote`）走的是同一条路的前两步，第三步它自己接（切到这一屏 + 关掉设置页）。
     */
    function openRemoteScreen(one) {
      if (remoteBusyId) return;
      // **同一台、而且那一屏还活着 → 直接回去，不重新取票**（2026-10-19 保活）。
      // 重新取票不只是白跑一趟，还会把整个界面重载一遍——那正是要省掉的等待。
      if (remoteWin && remoteWin.url && remoteWin.id === one.id) {
        remoteTarget = { id: one.id, name: one.name || remoteWin.name || '' };
        notifyRemote();
        return;
      }
      remoteTarget = { id: one.id, name: one.name || '' };
      fetchRemoteTicket(one.id, one.name);
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
      // 页面分组的展开状态：外部访问默认展开；B 端协作、飞书默认收起。
      // 只留在本次设置页会话里，不持久化，也不做异常自动展开。
      var externalGroupState = useState(true);
      var externalGroupOpen = externalGroupState[0];
      var setExternalGroupOpen = externalGroupState[1];
      var agentGroupState = useState(false);
      var agentGroupOpen = agentGroupState[0];
      var setAgentGroupOpen = agentGroupState[1];
      var feishuGroupState = useState(false);
      var feishuGroupOpen = feishuGroupState[0];
      var setFeishuGroupOpen = feishuGroupState[1];
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
      var devicesOpenState = useState(false);
      var devicesOpen = devicesOpenState[0];
      var setDevicesOpen = devicesOpenState[1];
      var cleanupAskState = useState(false);
      var cleanupAsk = cleanupAskState[0];
      var setCleanupAsk = cleanupAskState[1];
      var cleanupNoteState = useState(null);
      var cleanupNote = cleanupNoteState[0];
      var setCleanupNote = cleanupNoteState[1];
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
      // B 端执行：配对码 + 这一块的错误。名单在 info.agent 里跟配对信息一起下来。
      var agentCodeState = useState(null);
      var agentCode = agentCodeState[0];
      var setAgentCode = agentCodeState[1];
      var agentErrState = useState(null);
      var agentError = agentErrState[0];
      var setAgentError = agentErrState[1];
      var agentConfirmState = useState(null);
      var agentConfirming = agentConfirmState[0];
      var setAgentConfirming = agentConfirmState[1];
      // B 端执行端（这一侧）：地址、配对码、授权目录草稿 + 错误。
      var bUrlState = useState('');
      var bUrl = bUrlState[0];
      var setBUrl = bUrlState[1];
      var bCodeState = useState('');
      var bCode = bCodeState[0];
      var setBCode = bCodeState[1];
      var bRootsState = useState('');
      var bRoots = bRootsState[0];
      var setBRoots = bRootsState[1];
      var bErrState = useState(null);
      var bError = bErrState[0];
      var setBError = bErrState[1];
      var bWriteState = useState(false);
      var bAllowWrite = bWriteState[0];
      var setBAllowWrite = bWriteState[1];
      var bShellState = useState(false);
      var bAllowShell = bShellState[0];
      var setBAllowShell = bShellState[1];
      var bManageState = useState(false);
      var bAllowManage = bManageState[0];
      var setBAllowManage = bManageState[1];
      // 自建中继：表单草稿、最近一次服务端状态、错误和“测试通过”提示。
      // token 永远不回显；草稿里留空表示沿用已保存的那一枚。
      var relayDraftState = useState(null);
      var relayDraft = relayDraftState[0];
      var setRelayDraft = relayDraftState[1];
      var relayInfoState = useState(null);
      var relayInfo = relayInfoState[0];
      var setRelayInfo = relayInfoState[1];
      var relayErrState = useState(null);
      var relayError = relayErrState[0];
      var setRelayError = relayErrState[1];
      var relayNoteState = useState(null);
      var relayNote = relayNoteState[0];
      var setRelayNote = relayNoteState[1];
      var relayInitRef = useRef(false);
      var relayGuideState = useState(false);
      var relayGuideOpen = relayGuideState[0];
      var setRelayGuideOpen = relayGuideState[1];
      var relayOpenState = useState(false);
      var relayOpen = relayOpenState[0];
      var setRelayOpen = relayOpenState[1];
      // B 固定地址：激活码只作为密码框草稿，服务端从不回显已保存的那一枚。
      var bActivationState = useState('');
      var bActivation = bActivationState[0];
      var setBActivation = bActivationState[1];
      var bRelayErrState = useState(null);
      var bRelayError = bRelayErrState[0];
      var setBRelayError = bRelayErrState[1];
      // Cloudflare 命名隧道：固定域名 + token。token 不回显，留空表示沿用已保存的。
      var namedTunnelState = useState({ token: '', publicUrl: '' });
      var namedTunnel = namedTunnelState[0];
      var setNamedTunnel = namedTunnelState[1];
      var namedGuideState = useState(false);
      var namedGuideOpen = namedGuideState[0];
      var setNamedGuideOpen = namedGuideState[1];
      var aRelayInviteState = useState('');
      var aRelayInvite = aRelayInviteState[0];
      var setARelayInvite = aRelayInviteState[1];
      // 恢复倒计时要每秒重画一次；只在有 nextRetryAt 时开定时器。
      var namedTickState = useState(0);
      var setNamedTick = namedTickState[1];
      // 按钮点下去到 React 重渲染之间还有一小段；用 ref 挡住同一瞬间的第二次点击。
      var bPairingRef = useRef(false);
      // B 项目：门牌列表 + 新建表单 + 当前打开的文件面板。
      var bProjectNameState = useState('');
      var bProjectName = bProjectNameState[0];
      var setBProjectName = bProjectNameState[1];
      var bProjectRootState = useState('');
      var bProjectRoot = bProjectRootState[0];
      var setBProjectRoot = bProjectRootState[1];
      var bProjectErrorState = useState(null);
      var bProjectError = bProjectErrorState[0];
      var setBProjectError = bProjectErrorState[1];
      var bProjectViewState = useState(null);
      var bProjectView = bProjectViewState[0];
      var setBProjectView = bProjectViewState[1];
      var bProjectRemoveState = useState(null);
      var bProjectRemoving = bProjectRemoveState[0];
      var setBProjectRemoving = bProjectRemoveState[1];
      // 新建表单的展开与创建中都是纯界面状态：收起保留草稿，成功才清空并收起。
      var bProjectCreateOpenState = useState(false);
      var bProjectCreateOpen = bProjectCreateOpenState[0];
      var setBProjectCreateOpen = bProjectCreateOpenState[1];
      var bProjectCreatingState = useState(false);
      var bProjectCreating = bProjectCreatingState[0];
      var setBProjectCreating = bProjectCreatingState[1];
      // 新建 B 项目时挑 B 上的文件夹（和远程窗口挑 A 路径那套同一个思路）。
      var bBrowseState = useState(null);
      var bBrowse = bBrowseState[0];
      var setBBrowse = bBrowseState[1];
      var bProjectCreatedState = useState(null);
      var bProjectCreated = bProjectCreatedState[0];
      var setBProjectCreated = bProjectCreatedState[1];

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
      // 「自检」那一块（2026-10-17）：这台电脑在跑哪一版、哪些接口在、开关什么状态。
      // 一个快照 + 一个「重新自检」按钮——手机服务可能刚起来、路由可能刚变，
      // 用户得能当场再看一眼，而不是关掉这一页再进来一次。
      var selfState = useState(null);
      var selfcheck = selfState[0];
      var setSelfcheck = selfState[1];
      var selfErrState = useState(null);
      var selfError = selfErrState[0];
      var setSelfError = selfErrState[1];
      // 默认收起：这一块是"出问题时才来看"的体检报告，收起时只留摘要一行、
      // 错误、进程过期警告和「重新自检」——正常时它就安静地占一行；
      // 要看接口清单和路径那些细节，点「展开自检」。
      var selfOpenState = useState(false);
      var selfOpen = selfOpenState[0];
      var setSelfOpen = selfOpenState[1];

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
            if (r.body && typeof r.body === 'object') {
              setInfo(r.body);
              if (r.body.bAgent) {
                setBUrl(r.body.bAgent.url || '');
                setBRoots((r.body.bAgent.roots || []).join('\n'));
                setBAllowWrite(Boolean(r.body.bAgent.allowWrite));
                setBAllowShell(Boolean(r.body.bAgent.allowShell));
                setBAllowManage(Boolean(r.body.bAgent.allowManage));
              }
            } else setFailure('读不到配对信息：这台电脑上的服务返回了 HTTP ' + r.status + '。');
          })
          .catch(function (err) {
            if (!alive) return;
            setFailure('连不上这台电脑上的遥控服务：' + ((err && err.message) || String(err)));
          });
        return function () { alive = false; };
      }, []);

      // B 端名单自动刷新：B 刚配对完，用户不刷新页面也能看见它上线/掉线。
      useEffect(function () {
        var allowed = Boolean(info && info.agent && info.agent.allowed);
        if (!allowed) return undefined;
        var alive = true;
        var tick = function () {
          fetch(AGENT_LIST_PATH)
            .then(function (res) { return res.json(); })
            .then(function (body) {
              if (!alive || !body || !body.ok || !body.agent) return;
              setInfo(function (prev) {
                return prev ? Object.assign({}, prev, { agent: body.agent }) : prev;
              });
            })
            .catch(function () { /* 页面里静默失败，下一轮再试 */ });
        };
        var timer = setInterval(tick, 5000);
        return function () { alive = false; clearInterval(timer); };
      }, [Boolean(info && info.agent && info.agent.allowed)]);

      // B 端执行端的状态也要自己刷新：配对响应只代表“那一刻”，
      // 第一次轮询成功之前它会是“还没连上”；不刷新的话，B 页会一直停在旧快照。
      useEffect(function () {
        var hasB = Boolean(info && info.bAgent);
        if (!hasB) return undefined;
        var alive = true;
        var tick = function () {
          fetch(B_AGENT_STATUS_PATH)
            .then(function (res) { return res.json(); })
            .then(function (body) {
              if (!alive || !body || !body.ok || !body.bAgent) return;
              setInfo(function (prev) {
                return prev ? Object.assign({}, prev, { bAgent: body.bAgent }) : prev;
              });
            })
            .catch(function () { /* 静默失败，下一轮再试 */ });
        };
        var timer = setInterval(tick, 5000);
        return function () { alive = false; clearInterval(timer); };
      }, [Boolean(info && info.bAgent)]);

      // B 固定地址的进程会自己退出/重连，设置页不刷新也要看到新状态。
      // 只在开启时轮询；关着时一条请求都不发。
      useEffect(function () {
        if (!info || !info.bRelay || !info.bRelay.enabled) return undefined;
        var alive = true;
        var tick = function () {
          fetch(B_RELAY_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'status' }),
          })
            .then(function (res) { return res.json(); })
            .then(function (body) {
              if (!alive || !body || !body.bRelay) return;
              setInfo(function (prev) {
                return prev ? Object.assign({}, prev, { bRelay: body.bRelay }) : prev;
              });
            })
            .catch(function () { /* 静默失败，下一轮再试 */ });
        };
        var timer = setInterval(tick, 3000);
        return function () { alive = false; clearInterval(timer); };
      }, [Boolean(info && info.bRelay && info.bRelay.enabled)]);

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

      // 自建中继的草稿只在第一次拿到服务端状态时填一次；之后以用户在这一页
      // 改的为准，后台刷新不能把他的输入抹掉。token 永远是空的。
      useEffect(function () {
        if (relayInitRef.current) return;
        var r = info && info.selfRelay;
        if (!r) return;
        relayInitRef.current = true;
        setRelayInfo(r);
        setRelayDraft({
          serverAddr: typeof r.serverAddr === 'string' ? r.serverAddr : '',
          serverPort: Number(r.serverPort || 443),
          token: '',
          publicHost: typeof r.publicHost === 'string' ? r.publicHost : '',
          transport: r.transport || 'wss',
          frpcPath: '',
        });
      }, [info]);

      // 命名隧道：公网地址只在用户还没填的时候回填，token 永远从空开始。
      // 不用「只填一次」的 ref：状态第一次到达时可能还没有 publicUrl，之后刷新
      // 到了就该补上；但用户已经改过的地址不能被后台刷新抹掉。
      useEffect(function () {
        var t = info && info.tunnel;
        if (!t) return;
        setNamedTunnel(function (d) {
          if (d.publicUrl) return d;
          return Object.assign({}, d, { publicUrl: typeof t.publicUrl === 'string' ? t.publicUrl : '' });
        });
      }, [info]);

      // 命名隧道恢复倒计时：每秒动一下，让 nextRetryAt 的剩余秒数真的会变。
      useEffect(function () {
        var retryAt = info && info.tunnel && info.tunnel.nextRetryAt;
        if (!retryAt) return undefined;
        var timer = setInterval(function () { setNamedTick(function (v) { return v + 1; }); }, 1000);
        return function () { clearInterval(timer); };
      }, [info && info.tunnel && info.tunnel.nextRetryAt]);

      var runRelay = function (action) {
        if (busy || !relayDraft) return;
        setBusy(true);
        setRelayError(null);
        setRelayNote(null);
        fetch(SELF_RELAY_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({}, relayDraft, {
            action: action,
            transport: 'wss',
            serverPort: 443,
          })),
        })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (r.body && r.body.selfRelay) setRelayInfo(r.body.selfRelay);
            if (r.body && r.body.ok) {
              setRelayNote(action === 'test' ? '公网测试通过。' : (action === 'stop' ? '已停止。' : '已保存。'));
            } else {
              setRelayError((r.body && r.body.error) || ('操作失败：HTTP ' + r.status));
            }
          })
          .catch(function (err) {
            setRelayError('操作失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      var runBRelay = function (action) {
        if (busy) return;
        setBusy(true);
        setBRelayError(null);
        var body = { action: action };
        if (action === 'start' && bActivation.trim()) body.activationCode = bActivation.trim();
        fetch(B_RELAY_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (res) {
            return res.json().then(
              function (payload) { return { status: res.status, body: payload }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            var payload = (r.body && typeof r.body === 'object') ? r.body : null;
            if (payload && payload.bRelay) {
              setInfo(function (prev) {
                return prev ? Object.assign({}, prev, { bRelay: payload.bRelay }) : prev;
              });
            }
            if (payload && payload.ok && action === 'start') setBActivation('');
            if (!payload || !payload.ok) {
              setBRelayError((payload && payload.error) || ('B 固定地址操作失败：HTTP ' + r.status));
            }
          })
          .catch(function (err) {
            setBRelayError('B 固定地址操作失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

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
        // 自检同理：它读的是这台电脑自己的底细（版本、进程、路由、开关、端口），
        // 和"手机连不连得上"一点关系都没有——所以配对信息一回来就一起读。
        loadSelfcheck();
        return undefined;
      }, [info]);

      /** 清理 30 天未使用的设备；结果用一句话报给用户。 */
      var cleanupOldDevices = function () {
        if (busy) return;
        setBusy(true);
        setDevicesError(null);
        setCleanupNote(null);
        fetch(DEVICES_CLEANUP_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (!r.body || !r.body.ok) throw new Error((r.body && r.body.error) || ('清理失败：HTTP ' + r.status));
            setCleanupAsk(false);
            setCleanupNote(r.body.removed > 0
              ? ('清掉了 ' + r.body.removed + ' 台 30 天没用过的设备。')
              : '没有 30 天没用过的设备，名单没动。');
            return loadDevices();
          })
          .catch(function (err) { setDevicesError((err && err.message) || String(err)); })
          .then(function () { setBusy(false); });
      };

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

      /**
       * 读「自检」那一份（`GET /mini-remote/selfcheck`，只允许本机）。
       *
       * 三种结局分开说，一种都不许含糊：
       *   · 读到了 → 把那一份摊开；
       *   · **404/405 = 这条路不在这儿**（宿主那一半是旧版）。这一支要单独说，因为
       *     服务端回的是给程序看的 `not found`，原样摆出来用户读不懂，而它能得到的
       *     最有用的信息恰恰是那句话：**装是装上了，但跑的还是旧的，重启一次 DSH**。
       *   · 别的错（网络断了、服务没起来）→ 照登原因。
       *
       * 读不到**不吞**：这一块照样出现，只是那句原因摆在那儿（见 selfcheckBlock）。
       */
      var loadSelfcheck = function () {
        return fetch(SELFCHECK_PATH)
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            var b = (r.body && typeof r.body === 'object') ? r.body : null;
            if (b && b.ok === true) {
              setSelfcheck(b);
              setSelfError(null);
            } else if (r.status === 404 || r.status === 405) {
              setSelfError('这台电脑上的服务没有「自检」这个接口（HTTP ' + r.status + '）。'
                + '装上的是新版、跑的却可能是旧版——重启一次 DSH 才会加载新版本。');
            } else {
              setSelfError((b && b.error) || ('读自检失败：服务返回了 HTTP ' + r.status + '。'));
            }
          })
          .catch(function (err) {
            setSelfError('读自检失败：' + ((err && err.message) || String(err)));
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
      /**
       * 这个地址能不能用来跨机打开（2026-10-18，依据见 `docs/` 那份调研报告）。
       *
       * ## 为什么在填地址这一步就拦
       *
       * `http://` 的地址**能配对、也能取票**，但点开那一屏是**白的**：进门那一刻要种一枚
       * 窗口会话 cookie，它是 `SameSite=None; Secure`（跨站子框架里非这样不可），而浏览器
       * 在非 https 的地址上会把这枚 cookie **直接丢掉**，之后每个请求都过不去。
       *
       * 这个失败**不在配对的时刻发生**，而是延后到"点开那一行"——用户会以为是界面坏了。
       * 所以宁可当场拒绝，把原因说在源头。
       *
       * ## 回环地址例外
       *
       * 浏览器把 `127.0.0.1` / `localhost` / `[::1]` 当作可信来源，`Secure` 那一条对它们
       * 不适用。留这个口子是为了本机自测（在同一台机器上验证跨机链路时，地址就是回环）。
       *
       * @param {string} raw 用户填的原文
       * @returns {string|null} 不能用的原因（人话）；能用回 `null`
       */
      function baseUrlRejection(raw) {
        var text = String(raw || '').trim();
        if (!text) return null;   // 空地址有它自己那一句提示
        var m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
        if (!m) return '地址要以 http:// 或 https:// 开头——就是那台电脑「遥控设置」页里那条。';
        var scheme = m[1].toLowerCase();
        if (scheme === 'https') return null;
        if (scheme !== 'http') return '只支持 http:// 和 https:// 两种地址。';
        // 拆出主机看是不是回环（`[::1]:3090` 这种要先把方括号里的整段取出来）
        var rest = text.slice(m[0].length);
        var hostPort = rest.split('/')[0];
        var host = hostPort.charAt(0) === '['
          ? hostPort.slice(0, hostPort.indexOf(']') + 1)
          : hostPort.split(':')[0];
        host = host.toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') return null;
        return '这台电脑的地址要用 https://（Tailscale 那条就是）。'
          + 'http:// 能配对、也能取票，但打开那一屏会是白的——进门要种的那枚会话凭据，'
          + '浏览器在非 https 的地址上会直接丢掉。';
      }

      var saveAdd = function () {
        if (!addDraft || busy) return;
        var baseUrl = (addDraft.baseUrl || '').trim();
        var token = (addDraft.token || '').trim();
        if (!baseUrl) {
          setAddError('要填那台电脑的地址——就是它的「遥控设置」页那条（必须是 https://；'
            + '只有填本机回环地址时才可以用 http://）。不要带 /mini 和它后面的参数。');
          return;
        }
        var rejected = baseUrlRejection(baseUrl);
        if (rejected) {
          setAddError(rejected);
          return;
        }
        if (!token) {
          setAddError('要填那台电脑的口令（在它的「遥控设置」里能复制到）。');
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
      var toggleTunnel = function (enabled, extra) {
        if (busy) return;
        setBusy(true);
        fetch(TUNNEL_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ enabled: enabled }, extra || {})),
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

      /** B 端执行总开关。 */
      var toggleAgentAccess = function (enabled) {
        if (busy) return;
        setBusy(true);
        setAgentError(null);
        fetch(AGENT_ACCESS_PATH, {
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
            else setAgentError('切换「作为 A 端」失败：服务返回了 HTTP ' + r.status + '。');
          })
          .catch(function (err) {
            setAgentError('切换「作为 A 端」失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      /** 生成一次性配对码。 */
      var makeAgentCode = function () {
        if (busy) return;
        setBusy(true);
        setAgentError(null);
        fetch(AGENT_CODE_PATH, { method: 'POST' })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (r.body && r.body.ok) setAgentCode(r.body);
            else setAgentError((r.body && r.body.error) || ('生成配对码失败：HTTP ' + r.status));
          })
          .catch(function (err) {
            setAgentError('生成配对码失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      /** 撤销一台 B 端：先进入二次确认。 */
      var askAgentRevoke = function (id) {
        if (busy) return;
        setAgentError(null);
        setAgentConfirming(id);
      };
      var cancelAgentRevoke = function () { setAgentConfirming(null); };

      /** 撤销一台 B 端。 */
      var revokeAgent = function (id) {
        if (busy) return;
        setBusy(true);
        setAgentError(null);
        setAgentConfirming(null);
        fetch(AGENT_REVOKE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: id }),
        })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (r.body && typeof r.body === 'object' && r.body.agents) { setInfo(r.body); setFailure(null); }
            else setAgentError((r.body && r.body.error) || ('撤销失败：HTTP ' + r.status));
          })
          .catch(function (err) {
            setAgentError('撤销失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      /** B 端执行端：配对并开启。 */
      var pairBAgent = function () {
        if (busy || bPairingRef.current) return;
        bPairingRef.current = true;
        setBusy(true);
        setBError(null);
        fetch(B_AGENT_PAIR_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: bUrl, code: bCode, roots: bRoots, allowWrite: bAllowWrite, allowShell: bAllowShell, allowManage: bAllowManage }),
        })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (r.body && r.body.ok && r.body.bAgent) {
              setInfo(function (prev) { return Object.assign({}, prev || {}, { bAgent: r.body.bAgent }); });
              setBCode('');
              setBUrl(r.body.bAgent.url || bUrl);
              setBRoots((r.body.bAgent.roots || []).join('\n'));
            } else {
              setBError((r.body && r.body.error) || ('配对失败：HTTP ' + r.status));
            }
          })
          .catch(function (err) {
            setBError('配对失败：' + ((err && err.message) || String(err)));
          })
          .then(function () {
            bPairingRef.current = false;
            setBusy(false);
          });
      };

      function joinBPath(base, name) {
        var s = String(base || '').replace(/[\\/]+$/, '');
        var n = String(name || '').replace(/^[\\/]+/, '');
        return s ? (s + '\\' + n) : n;
      }

      /** 新建 B 项目时，从 B 的授权根开始挑文件夹。 */
      var openBBrowse = function () {
        setBProjectError(null);
        setBBrowse({ open: true, path: '', roots: [], entries: [], error: null, busy: true, mkdirOpen: false, mkdirName: '' });
        fetch(B_BROWSE_PATH)
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!body || !body.ok) throw new Error((body && body.error) || '列不出 B 的目录');
            setBBrowse({
              open: true, path: '', roots: body.roots || [], entries: [],
              error: null, busy: false, mkdirOpen: false, mkdirName: '',
            });
          })
          .catch(function (err) {
            setBBrowse({
              open: true, path: '', roots: [], entries: [],
              error: (err && err.message) || String(err), busy: false, mkdirOpen: false, mkdirName: '',
            });
          });
      };

      /** 进入 B 上的某个目录。 */
      var browseBTo = function (path) {
        setBBrowse(function (cur) {
          return Object.assign({}, cur || {}, { path: path, busy: true, error: null, entries: [], mkdirOpen: false });
        });
        fetch(B_BROWSE_PATH + '?path=' + encodeURIComponent(path))
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!body || !body.ok) throw new Error((body && body.error) || '列不出这个目录');
            setBBrowse(function (cur) {
              return Object.assign({}, cur || {}, {
                open: true, path: body.path || path, roots: body.roots || [],
                entries: body.entries || [], error: null, busy: false, mkdirOpen: false,
              });
            });
          })
          .catch(function (err) {
            setBBrowse(function (cur) {
              return Object.assign({}, cur || {}, {
                open: true, path: path, entries: [], error: (err && err.message) || String(err), busy: false,
              });
            });
          });
      };

      var closeBBrowse = function () { setBBrowse(null); };

      var chooseBBrowse = function () {
        if (!bBrowse || !bBrowse.path) return;
        setBProjectRoot(bBrowse.path);
        setBBrowse(null);
      };

      var setBBrowseMkdir = function (open) {
        setBBrowse(function (cur) { return Object.assign({}, cur || {}, { mkdirOpen: open, mkdirName: open ? (cur && cur.mkdirName) || '' : '' }); });
      };

      var setBBrowseName = function (name) {
        setBBrowse(function (cur) { return Object.assign({}, cur || {}, { mkdirName: name }); });
      };

      /** 在 B 的当前目录下建一个新文件夹，然后进去。 */
      var mkdirBBrowse = function () {
        if (!bBrowse || !bBrowse.path || !String(bBrowse.mkdirName || '').trim()) return;
        var target = joinBPath(bBrowse.path, String(bBrowse.mkdirName).trim());
        setBBrowse(function (cur) { return Object.assign({}, cur || {}, { busy: true, error: null }); });
        fetch(B_BROWSE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: target }),
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!body || !body.ok) throw new Error((body && body.error) || '建不了文件夹');
            browseBTo(target);
          })
          .catch(function (err) {
            setBBrowse(function (cur) {
              return Object.assign({}, cur || {}, { busy: false, error: (err && err.message) || String(err) });
            });
          });
      };

      /** 在 B 项目里新建会话：创建时就带 b-agent，避免先建默认模式再切的问题。 */
      var newBProjectSession = function (project) {
        if (!project || busy) return;
        setBProjectError(null);
        setBusy(true);
        fetch(B_PROJECT_SESSION_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: project.id }),
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!body || !body.ok) throw new Error((body && body.error) || '建不了 B 会话');
            setBProjectCreated({ projectId: project.id, sessionId: body.sessionId });
            // 创建和打开分两步：服务端只建，客户端拿 id 再打开。直接 startSession
            // 在这个宿主上会把 DSH 带崩，拆开更稳。
            if (uiWorkspaceFace && typeof uiWorkspaceFace.openSession === 'function') {
              try {
                uiWorkspaceFace.openSession(body.sessionId);
              } catch (err) {
                setBProjectError('会话建好了，但打开失败：' + ((err && err.message) || String(err)));
              }
            }
          })
          .catch(function (err) { setBProjectError((err && err.message) || String(err)); })
          .then(function () { setBusy(false); });
      };

      /** 打开一个 B 项目的文件面板，默认从项目根开始。 */
      var openBProject = function (project) {
        if (!project) return;
        setBProjectError(null);
        setBProjectView({ project: project, path: project.bRoot, entries: [], file: null, error: null, loading: true });
        fetch(B_PROJECT_PATH + '?action=list&id=' + encodeURIComponent(project.id))
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!body || !body.ok) throw new Error((body && body.error) || '列不出 B 的文件');
            setBProjectView({
              project: project, path: body.listing.path || project.bRoot,
              entries: body.listing.entries || [], file: null, error: null, loading: false,
            });
          })
          .catch(function (err) {
            setBProjectView({
              project: project, path: project.bRoot, entries: [], file: null,
              error: (err && err.message) || String(err), loading: false,
            });
          });
      };

      /** 在 B 项目里进入子目录。 */
      var enterBProjectDir = function (dirPath) {
        var view = bProjectView;
        if (!view) return;
        setBProjectView(Object.assign({}, view, { path: dirPath, file: null, error: null, loading: true, entries: [] }));
        fetch(B_PROJECT_PATH + '?action=list&id=' + encodeURIComponent(view.project.id) + '&path=' + encodeURIComponent(dirPath))
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!body || !body.ok) throw new Error((body && body.error) || '列不出这个目录');
            setBProjectView({
              project: view.project, path: body.listing.path || dirPath,
              entries: body.listing.entries || [], file: null, error: null, loading: false,
            });
          })
          .catch(function (err) {
            setBProjectView(Object.assign({}, view, { path: dirPath, entries: [], file: null, loading: false, error: (err && err.message) || String(err) }));
          });
      };

      /** 读一个 B 项目的文本文件。 */
      var readBProjectFile = function (filePath) {
        var view = bProjectView;
        if (!view) return;
        setBProjectView(Object.assign({}, view, { file: null, error: null, loading: true }));
        fetch(B_PROJECT_PATH + '?action=read&id=' + encodeURIComponent(view.project.id) + '&path=' + encodeURIComponent(filePath))
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!body || !body.ok) throw new Error((body && body.error) || '读不了这个文件');
            setBProjectView({
              project: view.project, path: view.path, entries: view.entries,
              file: body.file, error: null, loading: false,
            });
          })
          .catch(function (err) {
            setBProjectView(Object.assign({}, view, { file: null, loading: false, error: (err && err.message) || String(err) }));
          });
      };

      /** 新建 B 项目：A 建门牌 + 工作区，B 建真实目录。 */
      var createBProject = function () {
        if (busy) return;
        setBProjectError(null);
        setBusy(true);
        setBProjectCreating(true);
        fetch(B_PROJECTS_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: bProjectName, bRoot: bProjectRoot }),
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!body || !body.ok) throw new Error((body && body.error) || '建不了 B 项目');
            setInfo(function (prev) {
              if (!prev || !prev.agent) return prev;
              return Object.assign({}, prev, { agent: Object.assign({}, prev.agent, { projects: body.projects || [] }) });
            });
            setBProjectName('');
            setBProjectRoot('');
            setBProjectCreateOpen(false);
          })
          .catch(function (err) { setBProjectError((err && err.message) || String(err)); })
          .then(function () {
            setBProjectCreating(false);
            setBusy(false);
          });
      };

      /** 移除 B 项目：只删 A 的门牌和工作区，不动 B 的文件。 */
      var removeBProject = function (id) {
        if (busy) return;
        setBProjectError(null);
        setBusy(true);
        setBProjectRemoving(null);
        fetch(B_PROJECTS_PATH, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: id }),
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!body || !body.ok) throw new Error((body && body.error) || '移除失败');
            setInfo(function (prev) {
              if (!prev || !prev.agent) return prev;
              return Object.assign({}, prev, { agent: Object.assign({}, prev.agent, { projects: body.projects || [] }) });
            });
            setBProjectView(function (view) { return view && view.project && view.project.id === id ? null : view; });
          })
          .catch(function (err) { setBProjectError((err && err.message) || String(err)); })
          .then(function () { setBusy(false); });
      };

      /** B 端执行端：开/关。 */
      var toggleBAgent = function (enabled) {
        if (busy) return;
        setBusy(true);
        setBError(null);
        fetch(B_AGENT_MODE_PATH, {
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
            if (r.body && r.body.ok && r.body.bAgent) {
              setInfo(function (prev) { return Object.assign({}, prev || {}, { bAgent: r.body.bAgent }); });
              if (r.body.bAgent.error) setBError(r.body.bAgent.error);
            } else {
              setBError((r.body && r.body.error) || ('切换失败：HTTP ' + r.status));
            }
          })
          .catch(function (err) {
            setBError('切换失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      /** B 端执行端：写文件权限。 */
      var setBAgentWrite = function (enabled) {
        if (busy) return;
        setBusy(true);
        setBError(null);
        setBAllowWrite(Boolean(enabled));
        fetch(B_AGENT_OPTIONS_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ allowWrite: Boolean(enabled) }),
        })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (r.body && r.body.ok && r.body.bAgent) {
              setInfo(function (prev) { return Object.assign({}, prev || {}, { bAgent: r.body.bAgent }); });
              setBAllowWrite(Boolean(r.body.bAgent.allowWrite));
              if (r.body.bAgent.error) setBError(r.body.bAgent.error);
            } else {
              setBError((r.body && r.body.error) || ('切换写文件失败：HTTP ' + r.status));
            }
          })
          .catch(function (err) {
            setBError('切换写文件失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      /** B 端执行端：执行命令权限。 */
      var setBAgentShell = function (enabled) {
        if (busy) return;
        setBusy(true);
        setBError(null);
        setBAllowShell(Boolean(enabled));
        fetch(B_AGENT_OPTIONS_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ allowShell: Boolean(enabled) }),
        })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (r.body && r.body.ok && r.body.bAgent) {
              setInfo(function (prev) { return Object.assign({}, prev || {}, { bAgent: r.body.bAgent }); });
              setBAllowShell(Boolean(r.body.bAgent.allowShell));
              if (r.body.bAgent.error) setBError(r.body.bAgent.error);
            } else {
              setBError((r.body && r.body.error) || ('切换执行命令失败：HTTP ' + r.status));
            }
          })
          .catch(function (err) {
            setBError('切换执行命令失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      /** B 端执行端：文件夹管理权限。 */
      var setBAgentManage = function (enabled) {
        if (busy) return;
        setBusy(true);
        setBError(null);
        setBAllowManage(Boolean(enabled));
        fetch(B_AGENT_OPTIONS_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ allowManage: Boolean(enabled) }),
        })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (r.body && r.body.ok && r.body.bAgent) {
              setInfo(function (prev) { return Object.assign({}, prev || {}, { bAgent: r.body.bAgent }); });
              setBAllowManage(Boolean(r.body.bAgent.allowManage));
              if (r.body.bAgent.error) setBError(r.body.bAgent.error);
            } else {
              setBError((r.body && r.body.error) || ('切换文件夹管理失败：HTTP ' + r.status));
            }
          })
          .catch(function (err) {
            setBError('切换文件夹管理失败：' + ((err && err.message) || String(err)));
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
        h('div', { style: styles.title }, '遥控设置'),
        h('div', { style: styles.muted }, '手机扫码即可连接，密码已编入二维码。'),
        h('div', { style: styles.warn }, '本页包含连接密码，请勿截图或转发。'),
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
          open: devicesOpen,
          toggleOpen: function () { setDevicesOpen(function (v) { return !v; }); },
          cleanupAsk: cleanupAsk,
          askCleanup: function () { setCleanupAsk(true); setCleanupNote(null); },
          cancelCleanup: function () { setCleanupAsk(false); },
          cleanup: cleanupOldDevices,
          cleanupNote: cleanupNote,
        }, {
          // 跨机那个总开关（2026-10-16 第二步）。和 serve/feishu/dev 一样摊平成一个
          // 对象传：状态在 `info.remote` 里跟配对信息一起下来，动作就是上面那个 POST。
          toggle: toggleRemoteAccess,
        }, {
          // B 端执行：开关 + 配对码 + 名单/撤销。地址取第一条手机地址的源，
          // 因为 B 的 agent 路由和手机服务在同一个服务器上。
          toggle: toggleAgentAccess,
          makeCode: makeAgentCode,
          revoke: revokeAgent,
          askRevoke: askAgentRevoke,
          cancelRevoke: cancelAgentRevoke,
          confirming: agentConfirming,
          code: agentCode,
          error: agentError,
          busy: busy,
          urls: (function () {
            var seen = {};
            var out = [];
            var entries = info && Array.isArray(info.entries) ? info.entries : [];
            entries.forEach(function (entry) {
              try {
                var origin = entry && entry.url ? new URL(entry.url).origin : '';
                if (!origin || seen[origin]) return;
                seen[origin] = true;
                out.push({ label: entry.label || entry.kind || '地址', url: origin });
              } catch (err) { /* 跳过坏地址 */ }
            });
            return out;
          })(),
        }, {
          // B 端这一侧：作为执行端。地址/码/目录都是本机草稿，token 永远不回显。
          toggle: toggleBAgent,
          pair: pairBAgent,
          url: bUrl,
          code: bCode,
          roots: bRoots,
          setUrl: setBUrl,
          setCode: setBCode,
          setRoots: setBRoots,
          allowWrite: bAllowWrite,
          setWrite: setBAgentWrite,
          allowShell: bAllowShell,
          setShell: setBAgentShell,
          allowManage: bAllowManage,
          setManage: setBAgentManage,
          error: bError,
          busy: busy,
        }, {
          // B 项目：门牌列表、新建、移除、B 文件面板。
          projects: (info && info.agent && info.agent.projects) || [],
          connected: Boolean(info && info.agent && Array.isArray(info.agent.agents) && info.agent.agents.some(function (one) { return one && one.online; })),
          name: bProjectName,
          root: bProjectRoot,
          setName: setBProjectName,
          setRoot: setBProjectRoot,
          error: bProjectError,
          busy: busy,
          view: bProjectView,
          setView: setBProjectView,
          removing: bProjectRemoving,
          setRemoving: setBProjectRemoving,
          create: createBProject,
          createOpen: bProjectCreateOpen,
          setCreateOpen: setBProjectCreateOpen,
          creating: bProjectCreating,
          remove: removeBProject,
          open: openBProject,
          enter: enterBProjectDir,
          read: readBProjectFile,
          browse: bBrowse,
          openBrowse: openBBrowse,
          browseTo: browseBTo,
          closeBrowse: closeBBrowse,
          chooseBrowse: chooseBBrowse,
          setBrowseMkdir: setBBrowseMkdir,
          setBrowseName: setBBrowseName,
          mkdirBrowse: mkdirBBrowse,
          created: bProjectCreated,
          newSession: newBProjectSession,
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
        }, {
          // 「自检」那一块：一份快照 + 展开/收起 + 重新自检。读不到时 error 里那句话
          // 就摆在这一块里（它照样出现，见 selfcheckBlock）。
          data: selfcheck,
          error: selfError,
          open: selfOpen,
          toggle: function () { setSelfOpen(function (v) { return !v; }); },
          reload: loadSelfcheck,
        }, {
          externalOpen: externalGroupOpen,
          toggleExternal: function () { setExternalGroupOpen(function (v) { return !v; }); },
          agentOpen: agentGroupOpen,
          toggleAgent: function () { setAgentGroupOpen(function (v) { return !v; }); },
          feishuOpen: feishuGroupOpen,
          toggleFeishu: function () { setFeishuGroupOpen(function (v) { return !v; }); },
        }, {
          draft: relayDraft,
          info: relayInfo,
          note: relayNote,
          error: relayError,
          setDraft: setRelayDraft,
          open: relayOpen,
          toggleOpen: function () { setRelayOpen(function (v) { return !v; }); },
          guideOpen: relayGuideOpen,
          toggleGuide: function () { setRelayGuideOpen(function (v) { return !v; }); },
          save: function () { runRelay('save'); },
          start: function () { runRelay('start'); },
          test: function () { runRelay('test'); },
          stop: function () { runRelay('stop'); },
        }, {
          token: namedTunnel.token,
          publicUrl: namedTunnel.publicUrl,
          setToken: function (v) { setNamedTunnel(function (d) { return Object.assign({}, d, { token: v }); }); },
          setPublicUrl: function (v) { setNamedTunnel(function (d) { return Object.assign({}, d, { publicUrl: v }); }); },
          guideOpen: namedGuideOpen,
          toggleGuide: function () { setNamedGuideOpen(function (v) { return !v; }); },
        }, {
          invite: aRelayInvite,
          setInvite: setARelayInvite,
          save: function (enabled) {
            toggleTunnel(true, { mode: 'quick', relayEnabled: enabled, relayInviteCode: aRelayInvite });
          },
        }, {
          activationCode: bActivation,
          setActivationCode: setBActivation,
          error: bRelayError,
          start: function () { runBRelay('start'); },
          stop: function () { runBRelay('stop'); },
          copy: copy,
        }),
      );
    }

    function content(info, failure, copied, copy, busy, toggle, pwd, serve, feishu, dev, remote, agent, bAgent, bProject, rmt, self, groups, relay, named, aRelay, bRelay) {
      if (failure) return h('div', { style: styles.error }, failure);
      if (!info) return h('div', { style: styles.loading }, '正在读取配对信息…');

      var mobile = [];
      var external = [];
      var computers = [];
      var agentGroup = [];
      var feishuGroup = [];
      var relayUi = {
        enabled: Boolean(info.relay && info.relay.enabled),
        state: info.relay && info.relay.state,
        publicUrl: info.relay && info.relay.publicUrl,
        error: info.relay && info.relay.error,
        hasInviteCode: Boolean(info.relay && info.relay.hasInviteCode),
        invite: aRelay ? aRelay.invite : '',
        setInvite: aRelay ? aRelay.setInvite : function () {},
        save: aRelay ? aRelay.save : function () {},
      };
      if (info.ok === false) {
        mobile.push(h('div', { key: 'err', style: styles.error }, info.error || '读取配对信息失败。'));
      } else {
        var entries = Array.isArray(info.entries) ? info.entries : [];
        if (!entries.length) {
          mobile.push(h('div', { key: 'none', style: styles.muted }, '这台电脑暂时没有手机能连上的地址。'));
        } else {
          mobile.push(h('div', { key: 'conn', style: Object.assign({}, styles.entryTitle, { marginTop: 24 }) }, '连接方式'));
          for (var i = 0; i < entries.length; i += 1) mobile.push(entryBlock(entries[i], i, copied, copy));
        }
        // 密码紧跟在那几条二维码后面：它是这些链接背后的钥匙，放在一起才讲得通。
        if (typeof info.token === 'string' && info.token) mobile.push(passwordBlock(info, copied, copy, pwd));
      }
      // Tailscale 那一行：**没探到的时候也要出现**。原来它是直接不显示的，
      // 用户看到的不是「你没有 Tailscale」，而是「这里什么都没有」——他不知道
      // 自己缺了什么，也就不会去装。而他恰恰是最需要这条路的人。
      if (info.tailscale) external.push(tailscaleBlock(info.tailscale));
      // 出错时也要把开关露出来：不然「隧道起不来」会让整个面板变成一条报错，
      // 用户连关掉它的地方都找不到。
      if (info.tunnel) external.push(tunnelBlock(info.tunnel, busy, toggle, {
        token: named.token,
        publicUrl: named.publicUrl,
        setToken: named.setToken,
        setPublicUrl: named.setPublicUrl,
        guideOpen: named.guideOpen,
        toggleGuide: named.toggleGuide,
        retry: function () { toggle(true, { action: 'retry' }); },
        save: function () {
          toggle(true, { mode: 'named', namedToken: named.token, publicUrl: named.publicUrl });
        },
        stop: function () { toggle(false, { mode: 'named' }); },
      }, relayUi));
      if (info.bRelay && bRelay) external.push(bRelayBlock(info.bRelay, bRelay, busy));
      if (info.selfRelay && relay) {
        external.push(selfRelayBlock({
          draft: relay.draft,
          info: relay.info || info.selfRelay,
          note: relay.note,
          error: relay.error,
          setDraft: relay.setDraft,
          open: relay.open,
          toggleOpen: relay.toggleOpen,
          guideOpen: relay.guideOpen,
          toggleGuide: relay.toggleGuide,
        }, busy, {
          save: relay.save,
          start: relay.start,
          test: relay.test,
          stop: relay.stop,
        }));
      }
      // HTTPS 那一块：**不管配对信息成功还是失败都要出现**。失败时尤其要出现——
      // tailnet 没开 Serve 的时候，用户需要的正是那条开启链接，而那时候面板上
      // 其它东西多半也在报错，正好是他最需要指路的时候。
      if (info.serve || serve.error) external.push(serveBlock(info.serve, serve, busy));
      // 飞书那一块：**只要服务端带了 feishu 就出现**（成功、失败、服务还没起来那几条
      // 路径上都带着它）。它是独立的一条通路，手机服务有没有起来都不该拦着用户改它。
      // 草稿还没填好时 feishuBlock 返回 null：不摆一个只有标题的空组。
      var feishuNode = info.feishu ? feishuBlock(info.feishu, feishu) : null;
      if (feishuNode) feishuGroup.push(feishuNode);
      // 「电脑与设备」：先说谁可以连进来，再列已经登记的设备，最后是本机可以连谁。
      if (info.remote && remote) computers.push(remoteBlock(info.remote, busy, remote.toggle));
      if (dev && (dev.list !== null || dev.error)) computers.push(devicesBlock(dev));
      if (rmt && (rmt.list !== null || rmt.error)) computers.push(remotesBlock(rmt));
      // 「B 端协作」：A 侧总开关与配对、B 侧执行端、B 项目，保持这个内部顺序。
      if (info.agent && agent) agentGroup.push(agentBlock(info.agent, agent));
      if (info.bAgent && bAgent) agentGroup.push(bAgentBlock(info.bAgent, bAgent));
      if (info.agent && bProject && info.agent.allowed) agentGroup.push(bProjectBlock(info.agent, bProject));

      return h('div', null, [
        settingsGroup('mobile', '手机连接', true, null, mobile),
        settingsGroup('external', '外部访问', groups.externalOpen, groups.toggleExternal, external),
        settingsGroup('computers', '电脑与设备', true, null, computers),
        settingsGroup('agent', 'A/B 端协作', groups.agentOpen, groups.toggleAgent, agentGroup),
        settingsGroup('feishu', '飞书', groups.feishuOpen, groups.toggleFeishu, feishuGroup, true),
        // 自检沿用自身的展开/收起，不再套一层组折叠；永远排在最末。
        self ? selfcheckBlock(self) : null,
      ]);
    }

    /**
     * 设置页的组壳：只加标题和折叠按钮，各区块内部结构与 key 原样保留。
     * 单区块组展开时复用区块自己的标题，不在组壳上重复显示同一个标题。
     */
    function settingsGroup(key, title, open, toggle, children, single) {
      if (!children.length) return null;
      return h('div', { key: 'group-' + key, style: { marginTop: 24 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          single && open ? null : h('div', { style: styles.entryTitle }, title),
          toggle ? h('button', {
            type: 'button',
            onClick: toggle,
            style: Object.assign({}, styles.btn, { marginLeft: 'auto' }),
          }, open ? '收起' : '展开') : null,
        ),
        open ? h('div', null, children) : null,
      );
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
              type: 'button', disabled: Boolean(d.busy), onClick: function () { d.revoke(one.id); }, style: styles.btnDanger,
            }, d.busy ? '撤销中…' : '确认撤销'),
            h('button', {
              type: 'button', disabled: Boolean(d.busy), onClick: function () { d.cancelRevoke(); }, style: styles.btn,
            }, '取消'),
          ) : null,
        );
      });

      var open = Boolean(d.open);
      var cleanup = Boolean(d.cleanupAsk);
      return h('div', { key: 'devices', style: styles.block },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('div', { style: Object.assign({}, styles.entryTitle, { margin: 0 }) }, '设备' + (list.length ? '（' + list.length + '）' : '')),
          h('button', { type: 'button', style: styles.btn, onClick: d.toggleOpen }, open ? '收起' : '展开'),
          open && list.length
            ? h('button', { type: 'button', style: styles.btn, onClick: d.askCleanup }, '清理 30 天未使用')
            : null,
        ),
        open ? h('div', { style: styles.muted },
          '设备首次扫码时自动登记，之后无需重复扫码；撤销后需重新扫码。') : null,
        d.error ? h('div', { style: styles.error }, d.error) : null,
        d.cleanupNote ? h('div', { style: styles.detail }, d.cleanupNote) : null,
        cleanup ? h('div', null,
          h('div', { style: styles.warn }, '仅清理创建时间和最近使用时间均早于 30 天的设备；清理后需重新扫码。'),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
            h('button', { type: 'button', style: styles.btnDanger, disabled: Boolean(d.busy), onClick: d.cleanup }, d.busy ? '清理中…' : '确认清理'),
            h('button', { type: 'button', style: styles.btn, disabled: Boolean(d.busy), onClick: d.cancelCleanup }, '取消'),
          ),
        ) : null,
        open
          ? (rows.length
            ? h('div', null, rows)
            : (d.error ? null : h('div', { style: styles.muted, marginTop: 10 }, '这台电脑上还没有登记过的设备。')))
          : null,
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
     * 点那一行 = 打开那台电脑的界面（先取票，见 `connectRemote`）：取票 → 把地址交给框 →
     * 切到「远程窗口」那一屏 → 把设置页这个浮层关掉。**2026-10-17 起那一屏点开的第一层
     * 也是同一份名单**（见 MiniRemotePanel）：在这儿点，就跳过名单直接进那一台。
     * 行里另给两个动作：「重连」（票是一次性的、30 秒就过期，"再换一张"总得有个明确入口）
     * 和「断开」。
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
              type: 'button', disabled: Boolean(r.busy), onClick: function () { r.forget(one.id); }, style: styles.btnDanger,
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
        field('那台电脑的地址（它「遥控设置」页那条，不带 /mini）', r.add.baseUrl, 'http://…', function (v) {
          r.setAddDraft(Object.assign({}, r.add, { baseUrl: v }));
        }, 'text', true),
        field('那台电脑的口令（在它的「遥控设置」里复制）', r.add.token, '', function (v) {
          r.setAddDraft(Object.assign({}, r.add, { token: v }));
        }, 'password', true),
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
        h('div', { style: styles.muted }, '本机可以连接的电脑。配对完成后，点击某一台即可在「远程窗口」面板中打开它的界面。'),
        h('div', { style: styles.warn }, '对方电脑需先开启「允许别的电脑连接」，且双方网络可达（同一局域网或同一 Tailscale 网络）。'),
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
     * 「自检」那一块（2026-10-17）：**这台电脑到底在跑什么**。
     *
     * ## 为什么值得摆在设置页上
     *
     * 那天排两台真机的故障都卡在同一件事上——**看不见那台机器在跑什么**：一台的桌面端
     * 连开了一整天，加载的是"新功能写下来之前"的代码；另一台装的插件是旧版本，新接口
     * 根本没出现。当时只能靠用户来回反馈、靠一个个地址去敲。这一块把那些答案摆在一处：
     * 哪一版、宿主进程什么时候起的、哪些接口在、开关什么状态、服务听哪儿、数据在哪。
     *
     * ## 那一句警告**不展开也得看得见**
     *
     * 「进程比代码旧」是那次故障最常见的样子（装是装上了，跑的却还是旧的），而它对应的
     * 动作只有一个：重启 DSH。所以那句话摆在摘要上面、**不受展开/收起影响**——
     * 要用户点开才看得见，等于把它藏起来。
     *
     * ## 读不到也要出现
     *
     * 这一块**没有"读不到就不显示"这一档**：读不到（宿主是旧版、服务没起来）时，
     * 那句原因就摆在这儿，下面照样有一个「重新自检」。整块消失的话，用户看到的是
     * 「设置页上根本没有自检」——那和"没装这个功能"分不清。
     *
     * ## 除了那一句警告，别的都不许用感叹号或大红字
     *
     * 它是体检报告，不是警报：正常的时候（插件是最新的）就该安静地读过去。
     */
    function selfcheckBlock(sc) {
      var st = sc.data;
      var code = (st && st.code) || {};
      var proc = (st && st.process) || {};
      var phone = (st && st.phoneService) || {};
      var rosters = (st && st.rosters) || {};

      /** 运行了多久，说成人话（诊断的时候"连开了多久"本身就是一个线索）。 */
      function uptimeLine(sec) {
        var n = Number(sec);
        if (!isFinite(n) || n < 0) return '';
        if (n < 120) return '（刚起来 ' + Math.round(n) + ' 秒）';
        var mins = Math.round(n / 60);
        if (mins < 120) return '（已运行 ' + mins + ' 分钟）';
        var hours = Math.floor(mins / 60);
        var rest = mins % 60;
        return '（已运行 ' + hours + ' 小时' + (rest ? ' ' + rest + ' 分' : '') + '）';
      }

      /**
       * 多久以前，说成人话。
       *
       * 诊断的时候「三分钟前」比「19:42:07」有用：用户记不住自己什么时候点过什么，
       * 但他知道"刚才"和"昨天"的区别。
       */
      function agoText(ms) {
        var n = Number(ms);
        if (!isFinite(n)) return '';
        var sec = Math.round((Date.now() - n) / 1000);
        if (sec < 60) return '刚刚';
        var min = Math.round(sec / 60);
        if (min < 60) return min + ' 分钟前';
        var hour = Math.round(min / 60);
        if (hour < 24) return hour + ' 小时前';
        return Math.round(hour / 24) + ' 天前';
      }

      /** 接口那一行的说法：几条在、几条不在。空表只说"未知"，不编一个 0。 */
      function routeLine(routes) {
        var list = Array.isArray(routes) ? routes : [];
        if (!list.length) return '未知';
        var live = list.filter(function (one) { return one && one.mounted !== false; });
        return live.length === list.length
          ? ('一共 ' + list.length + ' 条，都在')
          : ('一共 ' + list.length + ' 条，其中 ' + (list.length - live.length) + ' 条不在');
      }

      function list(labels) {
        return labels.filter(Boolean).join('、');
      }

      if (!st) {
        // 还没读到 / 读不到：这一块照旧出现，把那句原因摆出来（尤其是"没有这个接口
        // = 宿主是旧版"那一条，它是这一块最有用的一句话）。
        return h('div', { key: 'selfcheck', style: styles.block },
          h('div', { style: styles.entryTitle }, '自检'),
          h('div', { style: styles.muted }, '仅本机可读取，不包含密码或密钥。'),
          h('div', { style: Object.assign({}, styles.error, styles.say) },
            sc.error || '正在自检…'),
          h('div', { style: { marginTop: 12 } },
            h('button', { type: 'button', onClick: sc.reload, style: styles.btn }, '重新自检')),
        );
      }

      // 「进程比代码旧」——这一句不受展开/收起影响（见上面那段）。
      var alert = code.stale === true && code.message
        ? h('div', { style: styles.warn }, code.message)
        : null;

      // 最近出错的那一叠（自检里的 `errors`：**最新在前**，最多 20 条）。
      // 空数组是正常的——那是"这次开机以来没出过错"，不是"取不到"。
      var errorRows = Array.isArray(st.errors) ? st.errors : [];

      var summary = h('div', { style: styles.selfSummary },
        '插件版本 ' + (st.version || '未知')
        + ' · 宿主进程启动于 ' + (formatTime(proc.startedAtMs) || '未知')
        + ' · 接口' + routeLine(st.routes)
        // 有错才提一句：绝大多数的正常时刻，这一行不该被"最近出错 0 条"这种噪音占满。
        + (errorRows.length ? ' · 最近出错 ' + errorRows.length + ' 条' : ''),
      );

      var routePaths = Array.isArray(st.routes) ? st.routes : [];
      var details = h('div', null,
        h('div', { style: styles.muted },
          '宿主进程（就是跑着这个插件的那个 DSH）启动于：' + (formatTime(proc.startedAtMs) || '未知')
          + uptimeLine(proc.uptimeSec)),
        h('div', { style: styles.muted },
          '插件文件最后改动于：' + (formatTime(code.modifiedAtMs) || '未知')
          + (code.file ? '（' + code.file + '）' : '')),
        h('div', { style: styles.muted },
          '接口清单一共 ' + routePaths.length + ' 条' + (routePaths.length ? '：' : '（读不到）')),
        routePaths.length
          // 一行一条要占掉十几行（这一块默认是展开的），挤在一起又读不清：
          // 用顿号连起来让它自己折行，一眼扫得完，又不会把面板撑得老长。
          ? h('div', { style: styles.code }, routePaths.map(function (one) {
            return String(one && one.path) + (one && one.mounted === false ? '（现在不在）' : '');
          }).join('、'))
          : null,
        h('div', { style: styles.muted },
          '「允许别的电脑连接」：' + (st.allowRemoteComputers ? '开' : '关（默认关）')),
        h('div', { style: styles.muted },
          '手机服务：' + (phone.listening
            ? ('在听端口 ' + phone.port + '，绑了 ' + ((phone.addresses || []).join('、') || '未知'))
            : ('没起来' + (phone.error ? '（' + phone.error + '）' : '')))),
        h('div', { style: styles.muted },
          '跨机那两条接口在手机服务那一半也挂了一份：'
          + list([
            phone.hostHalf && phone.hostHalf.pair ? '配对 在' : '配对 不在',
            phone.hostHalf && phone.hostHalf.remoteWindow ? '取票 在' : '取票 不在',
          ])),
        h('div', { style: styles.muted }, '数据目录（这台电脑上的那份，不随插件卸载而删）：'),
        h('div', { style: styles.code }, String(st.dataDir || '未知')),
        h('div', { style: styles.muted },
          '名册（只报条数，不报内容）：设备 ' + (rosters.devices === null || rosters.devices === undefined ? '未知' : rosters.devices + ' 条')
          + ' · 我能连的电脑 ' + (rosters.remotes === null || rosters.remotes === undefined ? '未知' : rosters.remotes + ' 条')),
        // 最近出错：这一块是「刚才到底发生了什么」的唯一出口。
        // 错误原来只打到 stdout——用户看着图形界面，终端里写了什么他一个字都看不到。
        errorRows.length
          ? h('div', null,
            h('div', { style: styles.muted },
              '最近出错（最新在前，' + agoText(errorRows[0] && errorRows[0].at) + '），不落盘、重启就清空：'),
            h('div', { style: styles.code }, errorRows.slice(0, 5).map(function (one) {
              return '· ' + String((one && one.message) || '');
            }).join('\n')
            + (errorRows.length > 5 ? '\n…还有 ' + (errorRows.length - 5) + ' 条' : '')),
            h('div', { style: styles.muted },
              '要看更早的，去启动这个 DSH 的那个终端找 [dsh-mini-remote] 开头的行。'),
          )
          : h('div', { style: styles.muted }, '最近没有出错记录。'),
      );

      return h('div', { key: 'selfcheck', style: styles.block },
        h('div', { style: styles.entryTitle }, '自检'),
        h('div', { style: styles.muted }, '仅本机可读取，不包含密码或密钥。'),
        alert,
        summary,
        sc.error ? h('div', { style: Object.assign({}, styles.error, styles.say) }, sc.error) : null,
        sc.open ? details : null,
        h('div', { style: { marginTop: 12 } },
          h('button', { type: 'button', onClick: sc.toggle, style: styles.btn },
            sc.open ? '收起自检' : '展开自检'),
          h('button', {
            type: 'button',
            onClick: sc.reload,
            style: Object.assign({}, styles.btn, { marginLeft: 8 }),
          }, '重新自检'),
        ),
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
            style: styles.btnPrimary,
          }, fs.busy ? '保存中…' : '保存'),
        ),
        // 失败才留一行，并写清是哪一环出的问题。
        fs.error ? h('div', { style: styles.error }, fs.error) : null,
        // 后台那六步：**默认收起**。配过一次的人不用再看，摊开着只会把要填的几个框挤下去；
        // 第一次配的人被飞书后台绕住时，这里是他唯一不用另开文档的地方。
        // 收起时留一句事实性摘要，让人知道展开后是什么。
        fs.guideOpen ? null : h('div', { style: Object.assign({}, styles.muted, { marginTop: 12 }) },
          '首次配置需在飞书开放平台完成六步。'),
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

    /** 一个输入行：标签在上、输入框在下。mono = true 时用等宽字体（地址/口令这类逐字符核对的内容）。 */
    function field(label, value, placeholder, onChange, type, mono) {
      return h('div', { key: label, style: { marginTop: 10 } },
        h('div', { style: styles.muted }, label),
        h('input', {
          type: type,
          value: value,
          placeholder: placeholder,
          spellCheck: false,
          autoComplete: 'off',
          onChange: function (e) { onChange(e.target.value); },
          style: Object.assign({}, mono ? styles.monoInput : styles.input, { marginTop: 4 }),
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
        h('div', { style: styles.muted }, '与上方 Tailscale 是同一台电脑的同一服务，区别仅在连接是否加密；地址无需端口。'),
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
        h('div', { style: styles.muted }, '开启后，其他电脑可凭本机密码配对，远程打开本机的电脑端界面。'),
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
          : '未开启（默认）。其他电脑无法连接，配对请求也不受理。'),
        on ? h('div', { style: styles.warn }, '那台电脑拿到的是你这台电脑的完整界面：会话记录、模型设置、插件都在里面。只给你信得过的电脑开。') : null,
      );
    }

    /**
     * B 端执行那一块（2026-10-22）。
     *
     * A 端只做三件事：总开关、发配对码、看名单/撤销。文件夹和读写权限由 B 端本地给，
     * 这里**不提供**“替 B 选目录”的入口——那等于 A 能替 B 扩大权限。
     */
    function agentBlock(st, a) {
      var on = Boolean(st && st.allowed);
      var agents = Array.isArray(st && st.agents) ? st.agents : [];
      var code = a && a.code;
      var urls = Array.isArray(a && a.urls) ? a.urls : [];
      var presetLine = null;
      if (on) {
        if (st.presetError) presetLine = h('div', { style: styles.warn }, 'B 端预设没注册成功：' + st.presetError);
        else if (st.presetRegistered) presetLine = h('div', { style: styles.detail }, 'B 端预设已注册。新会话里可以选「B 端执行」。');
        else presetLine = h('div', { style: styles.muted }, 'B 端预设还在注册；如果一直这样，重启 DSH 后再看。');
      }
      return h('div', { key: 'agent', style: styles.block },
        h('div', { style: styles.entryTitle }, '作为 A 端'),
        h('div', { style: styles.muted }, '可让 A 端电脑的 DSH 写入、修改 B 端电脑。'),
        h('div', { style: styles.muted }, 'B 端只需安装本插件；会话、模型与其他插件仍保留在 A 端。'),
        h('label', { style: styles.toggleRow },
          h('input', {
            type: 'checkbox',
            checked: on,
            disabled: Boolean(a && a.busy),
            onChange: function (e) { a.toggle(e.target.checked); },
          }),
          h('span', null, on ? '已开启' : '开启'),
        ),
        h('div', { style: styles.muted }, on
          ? '已开启。生成一个配对码，让 B 端在它自己的设置页里输入；配对后这里会出现那台电脑。'
          : '没开（默认）。B 端连不进来，也拿不到任何文件任务。'),
        on ? presetLine : null,
        on ? h('div', { style: styles.muted, marginTop: 10 }, 'B 端要填的地址（选一条 B 能访问的）：') : null,
        on && urls.length
          ? h('div', null, urls.map(function (one) {
            return h('div', { key: one.url, style: styles.detail }, one.label + '：' + one.url);
          }))
          : (on ? h('div', { style: styles.warn }, '现在没有可用的地址；先确认手机服务已经起来，或者先配好手机那条路。') : null),
        on ? h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h('button', { type: 'button', style: styles.btn, disabled: Boolean(a && a.busy), onClick: a.makeCode }, '生成配对码'),
          code && code.ok ? h('span', { style: styles.detail }, '配对码：' + code.code + '（10 分钟内有效）') : null,
        ) : null,
        a && a.error ? h('div', { style: styles.warn }, a.error) : null,
        on
          ? (agents.length
            ? h('div', null, agents.map(function (one) {
              var confirming = a && a.confirming === one.id;
              return h('div', { key: one.id, style: { marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-subtle, #ddd)' } },
                h('div', null, (one.name || 'B 端电脑') + ' · ' + (one.online ? '在线' : '离线')),
                h('div', { style: styles.muted }, '授权目录：' + ((one.roots && one.roots.length) ? one.roots.join('、') : '（没报）')),
                confirming
                  ? h('div', null,
                    h('div', { style: styles.warn }, '撤销后，这台 B 端要重新生成配对码才能再连。确定吗？'),
                    h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
                      h('button', { type: 'button', style: styles.btnDanger, disabled: Boolean(a && a.busy), onClick: function () { a.revoke(one.id); } }, '确认撤销'),
                      h('button', { type: 'button', style: styles.btn, disabled: Boolean(a && a.busy), onClick: a.cancelRevoke }, '取消'),
                    ),
                  )
                  : h('button', { type: 'button', style: styles.btn, disabled: Boolean(a && a.busy), onClick: function () { a.askRevoke(one.id); } }, '撤销'),
              );
            }))
            : h('div', { style: styles.muted, marginTop: 10 }, '还没有 B 端连过来。'))
          : null,
        on ? h('div', { style: styles.warn }, 'B 端有文件读、写、文件夹管理、命令和终端；每项由 B 自己开。删除/移动的 confirm 是模型层二次确认，不是人工审批；真正的授权是 B 上的开关。') : null,
      );
    }

    /**
     * B 端这一侧的「作为执行端」（2026-10-22）。和 A 端那块是两件事：
     * 这块是把自己的电脑交出去，所以地址、配对码、授权目录都在这一页填，
     * A 端不能替它填。
     */
    function bAgentBlock(st, a) {
      var on = Boolean(st && st.mode);
      var pollText = st && st.lastPollAt
        ? ('最近成功轮询：' + Math.max(0, Math.round((Date.now() - st.lastPollAt) / 1000)) + ' 秒前')
        : '还没有成功轮询';
      var status = st && st.connected ? '已连上 A，等待任务。' : (st && st.error ? st.error : '还没连上 A。（尝试 Ctrl+F5 强制刷新）');
      return h('div', { key: 'bAgent', style: styles.block },
        h('div', { style: styles.entryTitle }, '作为 B 端'),
        h('div', { style: styles.muted }, '接受 A 端电脑 DSH 操作。'),
        h('div', { style: styles.muted }, 'A 的会话和插件不会同步到本机；授权目录与权限仅在本页设置。'),
        h('label', { style: styles.toggleRow },
          h('input', {
            type: 'checkbox',
            checked: on,
            disabled: Boolean(a && a.busy),
            onChange: function (e) { a.toggle(e.target.checked); },
          }),
          h('span', null, on ? '已开启' : '开启'),
        ),
        h('div', { style: on ? styles.detail : styles.muted }, status),
        h('div', { style: styles.muted }, pollText),
        st && st.lastError ? h('div', { style: styles.detail }, '最后一次错误：' + st.lastError) : null,
        a && a.error ? h('div', { style: styles.warn }, a.error) : null,
        h('div', { style: styles.muted, marginTop: 10 }, 'A 的地址（例如 http://100.x.x.x:3090）'),
        h('input', {
          value: a ? a.url : '',
          spellCheck: false,
          placeholder: 'http://…:3090',
          style: styles.monoInput,
          onChange: function (e) { a.setUrl(e.target.value); },
        }),
        h('div', { style: styles.muted, marginTop: 10 }, 'A 端设置页生成的 6 位配对码'),
        h('input', {
          value: a ? a.code : '',
          inputMode: 'numeric',
          maxLength: 6,
          placeholder: '6 位数字',
          style: styles.monoInput,
          onChange: function (e) { a.setCode(e.target.value); },
        }),
        h('div', { style: styles.muted, marginTop: 10 }, '授权给 A 的文件夹，一行一个'),
        h('textarea', {
          value: a ? a.roots : '',
          spellCheck: false,
          placeholder: 'D:\\work\nD:\\资料',
          style: Object.assign({}, styles.monoInput, { minHeight: 72, width: '100%', resize: 'vertical' }),
          onChange: function (e) { a.setRoots(e.target.value); },
        }),
        h('label', { style: styles.toggleRow },
          h('input', {
            type: 'checkbox',
            checked: Boolean(a && a.allowWrite),
            disabled: Boolean(a && a.busy),
            onChange: function (e) { a.setWrite(e.target.checked); },
          }),
          h('span', null, '允许 A 写这些文件夹'),
        ),
        h('label', { style: styles.toggleRow },
          h('input', {
            type: 'checkbox',
            checked: Boolean(a && a.allowShell),
            disabled: Boolean(a && a.busy),
            onChange: function (e) { a.setShell(e.target.checked); },
          }),
          h('span', null, '允许 A 在这台电脑上执行命令'),
        ),
        h('div', { style: styles.warn }, '开启后，A 可在本机执行命令，影响范围不限于授权目录。默认关闭。'),
        h('label', { style: styles.toggleRow },
          h('input', {
            type: 'checkbox',
            checked: Boolean(a && a.allowManage),
            disabled: Boolean(a && a.busy),
            onChange: function (e) { a.setManage(e.target.checked); },
          }),
          h('span', null, '允许 A 建目录、移动、复制、删除'),
        ),
        h('div', { style: { marginTop: 10 } },
          h('button', { type: 'button', style: styles.btnPrimary, disabled: Boolean(a && a.busy), onClick: a.pair }, '配对并开启'),
        ),
        h('div', { style: styles.warn }, '开了之后，A 的 AI 能读写你授权的文件夹；执行命令还没开。不要授权整个盘。'),
        h('div', { style: styles.warn }, '删除/移动会要求模型带 confirm，这是模型层的二次确认，不是人工审批；真正的授权是你上面的开关。'),
      );
    }

    /**
     * B 项目：A 上只放「门牌」，真实文件在 B。
     *
     * 这一块同时承担两件事：建/删项目，和看 B 的真实文件。原生工作区里看到的是
     * A 的占位目录，所以文件不能靠原生树，得在这里列。
     */
    function bProjectBlock(st, a) {
      var projects = Array.isArray(a && a.projects) ? a.projects : [];
      var connected = Boolean(a && a.connected);
      var view = a && a.view;

      function joinB(base, name) {
        var s = String(base || '').replace(/[\\/]+$/, '');
        return s ? (s + '\\' + name) : name;
      }
      function parentOf(p) {
        var s = String(p || '').replace(/[\\/]+$/, '');
        var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
        return i > 0 ? s.slice(0, i) : s;
      }
      function fileSize(n) {
        var v = Number(n);
        if (!isFinite(v)) return '-';
        if (v < 1024) return v + 'B';
        if (v < 1024 * 1024) return Math.round(v / 1024) + 'KB';
        return Math.round(v / 1024 / 1024) + 'MB';
      }

      if (view) {
        var rows = [];
        var atRoot = String(view.path).toLowerCase() === String(view.project.bRoot).toLowerCase();
        if (!atRoot) {
          rows.push(h('button', {
            key: '..', type: 'button', style: styles.btn,
            onClick: function () { a.enter(parentOf(view.path)); },
          }, '.. 上一级'));
        }
        (view.entries || []).forEach(function (e) {
          var full = joinB(view.path, e.name);
          var isDir = e.type === 'dir';
          rows.push(h('button', {
            key: full, type: 'button', style: styles.browseRow,
            onClick: function () { if (isDir) a.enter(full); else a.read(full); },
          },
            h('span', null, (isDir ? '📁 ' : '📄 ') + e.name),
            h('span', { style: styles.muted }, isDir ? '目录' : fileSize(e.size)),
          ));
        });

        return h('div', { key: 'bProject', style: styles.block },
          h('div', { style: styles.entryTitle }, 'B 项目文件 · ' + (view.project.name || 'B 项目')),
          a.error ? h('div', { style: Object.assign({}, styles.error, styles.say) }, a.error) : null,
          h('div', { style: styles.muted }, view.path),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 } },
            h('button', { type: 'button', style: styles.btn, onClick: function () { a.open(view.project); } }, '刷新'),
            h('button', { type: 'button', style: styles.btn, onClick: function () { if (view.file) a.read(view.file.path); } }, '重读文件'),
            h('button', { type: 'button', style: styles.btn, onClick: function () { a.setView(null); } }, '收起文件面板'),
          ),
          view.loading ? h('div', { style: styles.muted }, '正在读 B…') : null,
          view.error ? h('div', { style: styles.warn }, view.error) : null,
          view.file
            ? h('div', null,
              h('div', { style: styles.detail }, view.file.path),
              h('pre', { style: styles.code }, view.file.content || '（空文件）'),
            )
            : null,
          view.file ? null : h('div', { style: { marginTop: 8 } }, rows.length ? rows : h('div', { style: styles.muted }, '这个目录是空的。')),
          h('div', { style: styles.warn }, '这里改的是 B 的真实文件；A 上的原生文件树看到的是门牌占位目录，不是 B 的内容。'),
        );
      }

      var list = projects.length
        ? h('div', null, projects.map(function (p) {
          var confirming = a.removing === p.id;
          return h('div', { key: p.id, style: styles.deviceRow },
            h('div', { style: styles.deviceMain },
              h('div', { style: styles.deviceName }, 'B · ' + (p.name || 'B 项目')),
              h('div', { style: styles.remoteUrl }, p.bRoot),
            ),
            confirming
              ? h('div', { style: styles.deviceConfirm },
                h('div', { style: styles.warn }, '只删 A 上的门牌和工作区，B 的真实文件不动。确定吗？'),
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  h('button', { type: 'button', style: styles.btnDanger, disabled: Boolean(a.busy), onClick: function () { a.remove(p.id); } }, '确认移除'),
                  h('button', { type: 'button', style: styles.btn, disabled: Boolean(a.busy), onClick: function () { a.setRemoving(null); } }, '取消'),
                ),
              )
              : h('div', { style: Object.assign({}, styles.deviceActs, { flexWrap: 'wrap' }) },
                h('button', {
                  type: 'button', style: styles.btn,
                  disabled: Boolean(a.busy),
                  onClick: function () { a.newSession(p); },
                }, '新建 B 会话'),
                h('button', { type: 'button', style: styles.btn, onClick: function () { a.open(p); } }, '浏览 B 文件'),
                h('button', { type: 'button', style: styles.btn, onClick: function () { a.setRemoving(p.id); } }, '移除'),
              ),
            a.created && a.created.projectId === p.id
              ? h('div', { style: Object.assign({}, styles.detail, styles.deviceConfirm) },
                '已建好 B 会话（' + a.created.sessionId + '）。去左侧「B · ' + (p.name || '项目') + '」里打开它；这条会话从创建起就是 B 预设，不会经过 run_code。')
              : null,
          );
        }))
        : h('div', { style: styles.muted, marginTop: 10 }, '还没有 B 项目。');

      var browseModal = null;
      if (a.browse && a.browse.open) {
        var b = a.browse;
        var browseRows = [];
        // 加载、失败、空目录是三种互斥状态：不能出现“报错 + 没有子目录”。
        if (b.busy) {
          browseRows.push(h('div', { key: 'busy', style: styles.browseNote }, '正在读 B…'));
        } else if (b.error) {
          browseRows.push(h('div', { key: 'err', style: styles.browseErr }, b.error));
        } else if (!b.path) {
          browseRows.push(h('div', { key: 'note', style: styles.browseNote }, '挑一个 B 上的目录。'));
          (b.roots || []).forEach(function (root, i) {
            browseRows.push(h('button', {
              key: 'r' + i, type: 'button', style: styles.browseRow,
              onClick: function () { a.browseTo(root); },
            }, root));
          });
          if (!(b.roots || []).length) {
            browseRows.push(h('div', { key: 'none', style: styles.browseNote }, 'B 端没有报授权目录，先在 B 设置里加一行。'));
          }
        } else {
          (b.entries || []).filter(function (e) { return e.type === 'dir'; }).forEach(function (e, i) {
            browseRows.push(h('button', {
              key: 'd' + i, type: 'button', style: styles.browseRow,
              onClick: function () { a.browseTo(joinB(b.path, e.name)); },
            }, '📁 ' + e.name));
          });
          if (!(b.entries || []).some(function (e) { return e.type === 'dir'; })) {
            browseRows.push(h('div', { key: 'empty', style: styles.browseNote }, '这个目录下面没有子目录。'));
          }
        }

        // 固定的“当前目录”栏：路径完整可见，「上一级」不再混在目录列表里。
        var currentBar = b.path ? h('div', {
          key: 'current',
          style: { flex: 'none', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px' },
        },
          h('div', { style: styles.muted }, '当前目录'),
          h('div', { style: Object.assign({}, styles.remoteUrl, { flex: '1 1 220px', minWidth: 0 }) }, b.path),
          h('button', {
            type: 'button', style: styles.btn,
            disabled: Boolean(b.busy),
            onClick: function () { var p = parentOf(b.path); a.browseTo(p); },
          }, '← 上一级'),
        ) : null;

        // 新建文件夹单独占一块，不与目录条目混在一起。
        var mkdirArea = b.path && !b.busy && !b.error ? h('div', {
          key: 'mkdirArea', style: { flex: 'none', padding: '0 8px 8px' },
        },
          h('button', {
            type: 'button', style: styles.browseRow,
            onClick: function () { a.setBrowseMkdir(!b.mkdirOpen); },
          }, '＋ 新建文件夹'),
          b.mkdirOpen ? h('div', { style: Object.assign({}, styles.browseMkdirRow, { flexWrap: 'wrap' }) },
            h('input', {
              type: 'text', value: b.mkdirName || '', placeholder: '新文件夹的名字',
              autoComplete: 'off', style: styles.browseInput,
              onChange: function (e) { a.setBrowseName(e && e.target ? e.target.value : ''); },
            }),
            h('button', {
              type: 'button', style: styles.btn,
              disabled: Boolean(b.busy) || !String(b.mkdirName || '').trim(),
              onClick: a.mkdirBrowse,
            }, '建'),
            h('button', {
              type: 'button', style: styles.btn,
              onClick: function () { a.setBrowseMkdir(false); },
            }, '取消'),
          ) : null,
        ) : null;

        browseModal = h('div', { key: 'browse', style: styles.browseOverlay },
          h('div', { style: styles.browseSheet },
            h('div', { style: styles.browseHead },
              h('div', { style: styles.browseTitle }, '选择 B 上的文件夹'),
              h('button', { type: 'button', style: styles.btn, onClick: a.closeBrowse }, '关闭'),
            ),
            currentBar,
            h('div', { style: styles.browseBody }, browseRows),
            mkdirArea,
            // 固定确认区：完整路径在左，唯一主操作在右；加载或失败时不可确认。
            h('div', { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px' } },
              h('div', { style: Object.assign({}, styles.remoteUrl, { flex: '1 1 220px', minWidth: 0 }) }, b.path || '尚未选择目录'),
              h('button', {
                type: 'button', style: styles.btnPrimary,
                disabled: !b.path || Boolean(b.busy) || Boolean(b.error),
                onClick: a.chooseBrowse,
              }, '就选这个目录'),
            ),
          ),
        );
      }

      var createUi = a.createOpen ? h('div', { style: { marginTop: 12 } },
        h('div', { style: styles.entryTitle }, '新建 B 项目'),
        field('项目名称', a.name, '项目名，例如 我的项目', function (v) {
          a.setName(v);
        }, 'text'),
        h('div', { style: { marginTop: 10 } },
          h('div', { style: styles.muted }, 'B 端目录'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 } },
            h('input', {
              value: a.root, spellCheck: false, placeholder: 'B 上的完整目录，例如 D:\\work\\我的项目',
              style: Object.assign({}, styles.monoInput, { flex: '1 1 240px', width: 'auto', minWidth: 180 }),
              onChange: function (e) { a.setRoot(e.target.value); },
            }),
            h('button', {
              type: 'button', style: styles.btn,
              disabled: !connected,
              onClick: a.openBrowse,
            }, '选择 B 文件夹'),
          ),
        ),
        h('div', { style: { marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', {
            type: 'button', style: styles.btnPrimary,
            disabled: Boolean(a.busy) || !a.name.trim() || !a.root.trim() || !connected,
            onClick: a.create,
          }, a.creating ? '创建中…' : '新建 B 项目'),
          h('button', {
            type: 'button', style: styles.btn,
            disabled: Boolean(a.creating),
            onClick: function () { a.setCreateOpen(false); },
          }, '取消'),
        ),
        h('div', { style: styles.warn }, 'B 上这个目录不存在时，需要 B 先打开「允许 A 建目录、移动、复制、删除」；A 只建门牌，不复制文件。'),
        h('div', { style: styles.detail }, '建好后去 DSH 工作区列表找「B · 项目名」；没出现就刷新一下。打开后如果没自动切到「B 端执行」，手动选一次。'),
      ) : h('div', { style: { marginTop: 12 } },
        h('button', {
          type: 'button', style: styles.btn,
          disabled: !connected,
          onClick: function () { a.setCreateOpen(true); },
        }, '新建 B 项目'),
      );

      return h('div', { key: 'bProject', style: styles.block },
        h('div', { style: styles.entryTitle }, 'B 项目'),
        // 创建、移除、新建会话共用的错误都归到区块顶部，不冒充“创建失败”。
        a.error ? h('div', { style: Object.assign({}, styles.error, styles.say) }, a.error) : null,
        h('div', { style: styles.muted }, '将 B 端目录登记为 A 的工作区；A 仅保存路径映射，不复制文件；打开项目后自动切到 B 端执行。'),
        connected ? null : h('div', { style: styles.warn }, 'B 端现在没连上；先把上面「作为 B 端」配对并开启。'),
        createUi,
        list,
        browseModal,
      );
    }

    /**
     * B 固定地址：服务方代建的 Cloudflare 命名隧道。
     *
     * 用户只输入一次性激活码。固定域名和 tunnel token 都由控制面开通时下发；
     * token 只进 cloudflared 进程环境，不回到这个界面，也不写进本地身份文件。
     */
    function bRelayBlock(st, relay, busy) {
      var running = st.state === 'running';
      var claiming = st.state === 'claiming' || Boolean(st.busy);
      var hostname = typeof st.hostname === 'string' ? st.hostname : '';
      var url = typeof st.url === 'string' ? st.url : (hostname ? 'https://' + hostname : '');
      var errorText = relay.error || st.lastError || null;
      var statusText;
      if (running) statusText = '已连接。手机可以用下面的固定地址。';
      else if (claiming) statusText = '正在开通并连接 B 固定地址…';
      else if (st.state === 'released') statusText = '已停止。服务方仍保留固定地址对应的资源。';
      else if (st.state === 'error') statusText = '没有连接成功。';
      else if (st.enabled) statusText = '已开启，正在准备。';
      else statusText = '未开启。填写激活码后开启。';
      var pill = h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: 999,
          fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
          color: running ? '#15803d' : (errorText ? '#b91c1c' : '#6b7280'),
          background: running ? '#dcfce7' : (errorText ? '#fee2e2' : '#f3f4f6'),
        },
      }, running ? '已连接' : (claiming ? '连接中' : (errorText ? '未连接' : '未开启')));
      var canStart = Boolean(String(relay.activationCode || '').trim() || st.hasActivationCode);
      var codeInput = running ? null : h('label', { style: { display: 'block', marginTop: 10 } },
        h('div', { style: styles.muted }, '激活码'),
        h('input', {
          type: 'password',
          value: relay.activationCode || '',
          placeholder: st.hasActivationCode ? '激活码已保存；要换再填一次' : '输入 B 一次性激活码',
          spellCheck: false,
          disabled: Boolean(busy),
          onChange: function (e) { relay.setActivationCode(e.target.value); },
          style: Object.assign({}, styles.monoInput, { marginTop: 4 }),
        }),
      );
      var actions = running || claiming
        ? h('button', {
          type: 'button', disabled: Boolean(busy),
          style: Object.assign({}, styles.btn, { color: '#b91c1c' }),
          onClick: relay.stop,
        }, '停止 B 固定地址')
        : h('button', {
          type: 'button', disabled: Boolean(busy) || !canStart,
          style: styles.btnPrimary,
          onClick: relay.start,
        }, claiming ? '连接中…' : '开启 B 固定地址');

      return h('div', { key: 'b-relay', style: styles.block },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('div', { style: styles.entryTitle }, 'B 固定地址（服务方代建）'),
          pill,
        ),
        h('div', { style: styles.muted },
          '用一次性激活码开通 Cloudflare 命名隧道，得到一个固定的 dsh-everywhere.com 地址。'
          + '和上面的快速隧道、A 中继、自建中继互不影响。'),
        codeInput,
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 } }, actions),
        h('div', { style: { marginTop: 10 } },
          h('div', { style: styles.muted }, statusText),
          errorText ? h('div', { style: styles.detail }, errorText) : null,
          errorText && st.errorCode ? h('div', { style: styles.muted }, '错误码：' + st.errorCode) : null,
          st.restarting && st.nextRetryAt
            ? h('div', { style: styles.muted }, 'cloudflared 退出后会按退避自动重连。')
            : null,
        ),
        url ? h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h('input', {
            readOnly: true, value: url, spellCheck: false,
            onFocus: function (e) { try { e.target.select(); } catch (err) { /* 忽略 */ } },
            style: Object.assign({}, styles.monoInput, { flex: '1 1 260px', width: 'auto', minWidth: 0 }),
          }),
          h('button', { type: 'button', style: styles.btn, onClick: function () { relay.copy(url); } }, '复制 B 地址'),
        ) : null,
        running ? h('div', { style: styles.warn },
          '流量经 Cloudflare，不是端到端加密。停止会释放租约，但不会自动删除 Tunnel/CNAME。') : null,
      );
    }

    /**
     * 自建中继：用户自己的服务器 + 域名。
     *
     * 这一块只负责“填四项、保存、开启、测试”。服务器那一半由 relay-server/
     * 的一次性安装脚本完成，不在这里做远程安装。
     */
    function selfRelayBlock(relay, busy, run) {
      var draft = relay.draft;
      if (!draft) return null;
      var info = relay.info || {};
      var configured = Boolean(info.configured);
      var running = Boolean(info.running);
      var connected = Boolean(info.connected);
      var locked = Boolean(busy || running);
      var set = function (key, value) {
        run.setDraft(Object.assign({}, draft, { [key]: value }));
      };
      var field = function (label, key, opts) {
        var o = opts || {};
        return h('label', { style: { display: 'block', marginTop: 10 } },
          h('div', { style: styles.muted }, label),
          h('input', {
            type: o.secret ? 'password' : 'text',
            value: draft[key] == null ? '' : String(draft[key]),
            placeholder: o.placeholder || '',
            spellCheck: false,
            disabled: locked,
            onChange: function (e) { set(key, e.target.value); },
            style: Object.assign({}, styles.input, { marginTop: 4 }),
          }),
        );
      };
      var pill = function (text, fg, bg) {
        return h('span', {
          style: {
            display: 'inline-flex', alignItems: 'center', padding: '2px 8px',
            borderRadius: 999, fontSize: 12, fontWeight: 600, color: fg, background: bg,
            whiteSpace: 'nowrap',
          },
        }, text);
      };
      var statePill = !configured
        ? pill('未配置', '#6b7280', '#f3f4f6')
        : running && connected
          ? pill('已连接', '#15803d', '#dcfce7')
          : running
            ? pill('连接中', '#b45309', '#fef3c7')
            : pill('已停止', '#6b7280', '#f3f4f6');
      var copyUrl = function () {
        try {
          if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(info.url);
          }
        } catch (err) { /* 剪贴板不可用：输入框里仍可手动复制 */ }
      };
      var actions = running
        ? [
          h('button', { type: 'button', disabled: Boolean(busy), style: styles.btn, onClick: function () { run.test(); } }, '测试连接'),
          h('button', {
            type: 'button', disabled: Boolean(busy),
            style: Object.assign({}, styles.btn, { color: '#b91c1c' }),
            onClick: function () { run.stop(); },
          }, '停止'),
        ]
        : [
          h('button', { type: 'button', disabled: Boolean(busy), style: styles.btnPrimary, onClick: function () { run.start(); } }, '保存并开启'),
          h('button', { type: 'button', disabled: Boolean(busy), style: styles.btn, onClick: function () { run.test(); } }, '测试连接'),
        ];

      var header = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
          h('div', { style: styles.entryTitle }, '自建中继'),
          statePill,
        ),
        h('button', { type: 'button', style: styles.btn, onClick: relay.toggleOpen }, relay.open ? '收起' : '展开'),
      );

      if (!relay.open) {
        var summary = !configured
          ? '未配置。展开后填写控制域名、token 和公网域名。'
          : running && connected
            ? '已连接：' + info.url
            : running
              ? 'frpc 正在运行，公网还没确认。'
              : '已停止。展开后可修改配置或重新开启。';
        return h('div', { key: 'self-relay', style: styles.block },
          header,
          h('div', { style: Object.assign({}, styles.muted, { marginTop: 8 }) }, summary),
        );
      }

      return h('div', { key: 'self-relay', style: styles.block },
        header,
        h('div', { style: Object.assign({}, styles.muted, { marginTop: 8 }) },
          '用自己的服务器和域名，地址固定，不经过第三方中继。服务器先按 relay-server/README 配好，再填这里。'),
        h('div', {
          style: {
            marginTop: 10, padding: 12, borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
            background: 'var(--dsw-alias-bg-layer-1,#fff)',
          },
        },
          field('中继控制域名', 'serverAddr', { placeholder: 'frp.example.com' }),
          field('frp token', 'token', { secret: true, placeholder: configured ? '留空 = 沿用已保存的 token' : '从服务器安装脚本输出里复制' }),
          field('公网域名', 'publicHost', { placeholder: 'remote.example.com' }),
          h('div', { style: { marginTop: 8, color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.6 } },
            '两个域名都解析到同一台服务器；控制端口固定 443，A 端只需要出站 443。'
            + (running ? ' 修改配置前请先停止。' : '')),
        ),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 } }, actions),
        h('div', {
          style: {
            display: 'grid', gap: 4, marginTop: 12, paddingTop: 10,
            borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
          },
        },
          h('div', { style: styles.muted }, 'frpc 进程：' + (running ? '运行中' : '未运行')),
          h('div', { style: styles.muted }, '公网链路：' + (connected ? '已通' : (running ? '未确认' : '未开启'))),
        ),
        info.url ? h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h('input', {
            readOnly: true, value: info.url, spellCheck: false,
            onFocus: function (e) { try { e.target.select(); } catch (err) { /* 忽略 */ } },
            style: Object.assign({}, styles.monoInput, { flex: '1 1 240px', width: 'auto', minWidth: 0 }),
          }),
          h('button', { type: 'button', style: styles.btn, onClick: copyUrl }, '复制'),
        ) : null,
        relay.note ? h('div', { style: styles.muted, marginTop: 8 }, relay.note) : null,
        relay.error ? h('div', { style: styles.detail }, relay.error) : null,
        h('div', { style: { marginTop: 8, color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.6 } },
          '公网入口受 token/Bearer/票据保护；域名对外提供服务前，请确认备案和当地要求。'),
        // 配置指引默认收起：配过的人不用看，第一次配的人被服务器和 DNS 绕住时，
        // 这里是不用另开文档的唯一入口。
        relay.guideOpen ? null : h('div', { style: Object.assign({}, styles.muted, { marginTop: 12 }) },
          '第一次配置需要：一台干净服务器、两条域名解析、一次 frpc 配置。'),
        h('div', { style: { marginTop: 12 } },
          h('button', { type: 'button', onClick: relay.toggleGuide, style: styles.btn },
            relay.guideOpen ? '收起配置指引' : '配置指引（服务器 + 域名 + frpc）'),
        ),
        relay.guideOpen ? selfRelayGuide() : null,
      );
    }

    /**
     * 自建中继的配置指引。
     *
     * 面向“第一次装插件、有一台干净服务器和域名”的用户；步骤和
     * `relay-server/README.md` 对齐，不在界面里另编一套。
     */
    function selfRelayGuide() {
      var aiPrompt = [
        '我已经能通过 SSH 登录服务器。如果当前会话还没有 SSH 连接，请先问我要登录命令，不要猜密码。',
        '服务器 IP、系统版本、80/443 占用、已装软件，请你自己登录后检查，不要让我重复填。',
        '',
        '我的主域名：<填写，例如 example.com>',
        '',
        '请按下面规则帮我设计并配置自建中继：',
        '1. 需要两个不同的域名：控制域名（frpc 连它）和公网域名（手机、B 端、远程窗口打开）。',
        '2. 控制域名建议 frp.<主域名> 或 control.<主域名>；公网域名建议 remote.<主域名>。公网域名也可以用主域名本身，但主域名已有网站时不要占用。',
        '3. 两个域名都必须是 A 记录指向这台服务器；控制域名只承载 frpc 控制连接，公网域名只承载网页流量。',
        '4. 如果你有 DNSPod / Cloudflare 的 DNS API 权限，可以帮我创建记录；没有就给我两条记录的精确值（主机记录、类型 A、记录值、TTL 600），让我自己加。不要猜我的 DNS 账号，也不要问账号密码。',
        '5. 先检查 80/443 是否空闲、DNS 是否生效、云安全组是否放行；任何一项不满足就停下来告诉我。',
        '6. 如果本机插件目录里有 relay-server/，优先用里面的 install.sh；没有就按 relay-server/README.md 手工配置。',
        '7. 安装 frps 0.71.1，只监听 127.0.0.1:7000，vhostHTTPPort=8080，使用随机 token 鉴权。',
        '8. 控制域名走 443 WebSocket + TLS，转发到 127.0.0.1:7000；公网域名走 443，转发到 127.0.0.1:8080。',
        '9. 用 Caddy 自动申请证书；如果服务器已有 Nginx，不要自动改，先停下来把建议配置给我看。',
        '10. 不要动服务器上已有的网站，不要重启原站服务；需要改 Nginx 时先备份并先跑 nginx -t。',
        '11. 完成后验证：frps 正常运行、两张证书有效、公网域名返回 502 或 200（A 端还没连时 502 正常）。',
        '12. 最后只把实际选用的控制域名和公网域名、frp token、执行过的命令和验证结果告诉我；token 不要写进日志或公开地方。',
        '',
        '如果缺少主域名、DNS 权限或 SSH 登录方式，先问我，不要自己编一个域名或密码。',
      ].join('\n');

      var copyPrompt = function () {
        try {
          if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(aiPrompt);
          }
        } catch (err) { /* 剪贴板不可用：下面的文本框仍可手动全选 */ }
      };

      var sections = [
        ['方法一：自己在服务器上执行（推荐先看这一种）', [
          '适合：你有一台干净的 Ubuntu/Debian 服务器，愿意复制一两条命令。',
        ]],
        ['第 1 步：准备服务器和端口', [
          '1. 买一台 Ubuntu 22.04/24.04 或 Debian 11/12 的服务器，2 核 2G 就够。',
          '2. 在云厂商控制台的「防火墙 / 安全组」里放行 22、80、443。7000 不用对外开放。',
          '3. 确认服务器上 80/443 没有被别的网站占用；已经有网站的机器不要跑自动安装。',
          '4. 记下服务器公网 IP，后面 DNS 和 SSH 都要用。',
        ]],
        ['第 2 步：加两条 DNS 解析', [
          '1. 登录 DNSPod（或腾讯云「DNS 解析 DNSPod」），点开你的域名，进入「记录管理」。',
          '2. 点左上角蓝色的「添加记录」，不要点「新手快速解析」。',
          '3. 第一条填：主机记录 frp；记录类型 A；线路类型 默认；记录值 服务器公网 IP；TTL 600；权重和优先级留空。保存。',
          '4. 再点一次「添加记录」，第二条填：主机记录 remote；记录类型 A；线路类型 默认；记录值同一个服务器 IP；TTL 600；权重和优先级留空。保存。',
          '5. 主机记录只填 frp / remote，不要填 frp.example.com 这种完整域名；不要改已有的 @、www 记录。',
          '6. 如果列表里已经有 frp 或 remote，点「修改」改那条，不要再新增一条重复的。',
          '7. 等 1～10 分钟，在电脑上执行 nslookup frp.example.com 8.8.8.8 和 nslookup remote.example.com 8.8.8.8；两个都返回服务器 IP 才算好。',
          '如果域名用的是 Cloudflare 或其他 CDN，先关掉代理（灰色云），让解析直接指向服务器；否则证书申请会失败。',
        ]],
        ['第 3 步：先让这台电脑能登录服务器', [
          '有两种办法，选一种即可。',
          '办法 A：用云厂商控制台的「网页终端 / OrcaTerm」登录。不用配 SSH，适合第一次用。',
          '办法 B：配置 SSH 密钥免密登录，之后一条 ssh 命令就能进。Windows PowerShell 里执行：',
          'ssh-keygen -t ed25519 -f $env:USERPROFILE\\.ssh\\dsh_relay',
          'type $env:USERPROFILE\\.ssh\\dsh_relay.pub | ssh root@服务器IP "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"',
          '然后在本机 ~/.ssh/config 里加：Host relay / HostName 服务器IP / User root / IdentityFile ~/.ssh/dsh_relay',
          '测试：ssh relay。能直接进去、不再问密码，就配好了。',
          '不要把 root 密码贴在聊天里；用密钥，装完可以撤掉。',
        ]],
        ['第 4 步：把 relay-server 传到服务器', [
          '插件包里有一个 relay-server/ 目录。tgz 安装包解压后在 package/relay-server；npm 安装在 node_modules/dsh-mini-remote/relay-server。',
          '用 WinSCP 把整个 relay-server 文件夹拖到服务器，或在本机 PowerShell 执行：',
          'scp -r "本机路径\\relay-server" root@服务器IP:/root/',
          '然后登录服务器：ssh relay（或 ssh root@服务器IP）',
          'cd /root/relay-server',
        ]],
        ['第 5 步：先体检，再安装', [
          '先跑体检，不要直接安装：',
          'sudo bash install.sh --check --host remote.example.com --control-host frp.example.com',
          '看到「检查通过」再正式安装：',
          'sudo bash install.sh --host remote.example.com --control-host frp.example.com',
          '脚本会装 frps + Caddy、申请两张证书、启动服务，最后打印 frp token。token 只显示一次，先复制到安全的地方。',
          '如果提示 80/443 被占用，不要强行继续；要么换干净服务器，要么按 relay-server/README.md 手工加 Nginx。',
        ]],
        ['第 6 步：回插件填写并开启', [
          '中继控制域名：frp.example.com',
          'frp token：安装脚本打印的那一串',
          '公网域名：remote.example.com',
          '控制端口固定 443，传输方式固定 WebSocket + TLS；点「保存并开启」。',
          '状态变成「已连接」、公网链路「已通」后，点「测试连接」；手机连接里会出现「自建中继」二维码。',
        ]],
        ['方法二：让当前 DSH 会话的模型帮你配', [
          '适合：你不想自己看 Linux 命令，但愿意把服务器的 SSH 登录方式交给当前会话。',
          '注意：只给你信任的会话；优先用 SSH 密钥，不要粘贴云账号密码。装完以后可以撤掉临时权限。',
        ]],
        ['第 1 步：域名和 DNS（有权限可以交给 AI）', [
          'AI 不能凭空登录 DNSPod；如果你把 DNSPod / Cloudflare 的 DNS API 权限交给它，它可以代你创建记录；没有权限就按下面自己加。',
          '你也可以先让 AI 建议两个子域名（例如 frp.example.com 和 remote.example.com），再按它给的记录去加。',
          '1. 登录 DNSPod 或腾讯云「DNS 解析 DNSPod」，点开域名，进入「记录管理」。',
          '2. 点「添加记录」，第一条：主机记录 frp；类型 A；线路 默认；记录值 服务器公网 IP；TTL 600；权重和优先级留空；保存。',
          '3. 再点「添加记录」，第二条：主机记录 remote；类型 A；线路 默认；记录值同一个服务器 IP；TTL 600；权重和优先级留空；保存。',
          '4. 主机记录只填 frp / remote，不要填完整域名；不要动已有 @、www；已有同名记录就改，不要重复添加。',
          '5. 等 1～10 分钟，自己先确认：nslookup frp.example.com 8.8.8.8 和 nslookup remote.example.com 8.8.8.8 都返回服务器 IP。',
          '6. 确认后告诉当前会话「DNS 已加好」，再让它继续；它会在服务器上再查一次解析，避免证书申请失败。',
          '如果域名走 Cloudflare/CDN，先把代理关掉（灰色云），让记录直接指向服务器。',
        ]],
        ['第 2 步：确认当前会话能登录服务器', [
          '如果当前会话已经能通过 SSH 登录服务器，这一步可以跳过：服务器 IP、系统版本、80/443 占用，让模型自己登录后检查，不用你重复填。',
          '如果还没配 SSH，先按方法一第 3 步配一次；不要把 root 密码发给模型。',
          '配好后，把登录命令（例如 ssh relay）告诉模型；如果模型已经有连接，直接说「已经能 SSH，请自己检查服务器」。',
          '你仍然需要给它一个主域名；控制域名和公网域名可以让它按规则建议，但 DNS 记录要么它用 API 创建，要么给你精确值让你自己加。',
        ]],
        ['第 3 步：复制下面这段提示词', [
          '把尖括号里的内容换成你的真实信息，然后发给当前 DSH 会话。',
          '如果 SSH 还没配好，模型会先问你怎么登录；不要让它猜密码。',
        ]],
        ['第 4 步：模型做完后', [
          '它会告诉你 frp token、执行过的命令和验证结果。',
          '把 token 填回上面的「frp token」，公网域名和控制域名保持和提示词里一致，点「保存并开启」。',
          '如果模型说 80/443 被占用、DNS 没生效或证书失败，先解决那一项，不要跳过。',
        ]],
      ];

      var out = [h('div', { key: 'self-relay-guide-intro', style: Object.assign({}, styles.muted, { marginTop: 12 }) },
        '按下面顺序做。第一次大约 10 分钟；命令和 relay-server/README.md 保持一致。')];
      for (var i = 0; i < sections.length; i += 1) {
        out.push(h('div', { key: 'self-relay-guide-' + i, style: Object.assign({}, styles.entryTitle, { marginTop: 12 }) }, sections[i][0]));
        for (var j = 0; j < sections[i][1].length; j += 1) {
          out.push(h('div', { key: 'self-relay-guide-' + i + '-' + j, style: styles.muted }, sections[i][1][j]));
        }
      }
      out.push(h('div', { key: 'self-relay-ai-prompt-label', style: Object.assign({}, styles.muted, { marginTop: 12 }) },
        '发给当前 DSH 会话的提示词（先替换尖括号内容）：'));
      out.push(h('textarea', {
        key: 'self-relay-ai-prompt',
        readOnly: true,
        value: aiPrompt,
        spellCheck: false,
        onFocus: function (e) { try { e.target.select(); } catch (err) { /* 忽略 */ } },
        style: Object.assign({}, styles.monoInput, {
          marginTop: 6, width: '100%', minHeight: 220, resize: 'vertical',
          fontSize: 12, lineHeight: 1.6,
        }),
      }));
      out.push(h('div', { key: 'self-relay-ai-copy', style: { marginTop: 8 } },
        h('button', { type: 'button', style: styles.btn, onClick: copyPrompt }, '复制提示词'),
      ));
      return h('div', { key: 'self-relay-guide' }, out);
    }

    function tunnelBlock(tunnel, busy, toggle, named, aRelay) {
      var namedActive = Boolean(tunnel.enabled && tunnel.mode === 'named');
      var quickEnabled = Boolean(tunnel.enabled && !namedActive);
      var working = Boolean(busy || tunnel.starting);
      var quickStatus;
      if (working && !namedActive) quickStatus = '正在打开…第一次要先下载一个 50MB 左右的组件，可能要等一会儿。';
      else if (namedActive) quickStatus = '当前使用下面的固定地址，临时隧道没有启用。';
      else if (tunnel.up && quickEnabled) quickStatus = '已开启。上方「公网」即外部访问地址；首次开启约需 30 秒，域名生效后再扫码。';
      else if (quickEnabled) quickStatus = tunnel.error
        ? '开着，但公网那边连不上。手机现在走这条路会打不开——下面那段就是它说的话。'
        : '已开启，但还没拿到公网地址。';
      else quickStatus = '未开启。手机与电脑不在同一网络时无法连接；可改用 Tailscale 或下面的固定地址。';

      var retryIn = tunnel.nextRetryAt
        ? Math.max(0, Math.ceil((Number(tunnel.nextRetryAt) - Date.now()) / 1000))
        : 0;
      var namedStatus;
      if (tunnel.phase === 'paused') namedStatus = tunnel.lastErrorKind === 'proxy'
        ? '自动重试已暂停：代理/TUN 把 Cloudflare 边缘解析成了假地址。先关掉代理，再点「立即重试」。'
        : '自动重试已暂停。检查下面的原因，改好后点「立即重试」。';
      else if (tunnel.phase === 'restarting') namedStatus = tunnel.lastErrorKind === 'proxy'
        ? '代理/TUN 正在拦截 Cloudflare 边缘；关掉代理后会自动重试。'
        : retryIn > 0
        ? '隧道断了，正在恢复，约 ' + retryIn + ' 秒后重试。'
        : '隧道断了，正在恢复。';
      else if (tunnel.phase === 'failed') namedStatus = '固定隧道没有启动成功。下面这段是原因，改好后再点「保存并重启」。';
      else if (tunnel.phase === 'degraded') namedStatus = tunnel.lastErrorKind === 'dns' || tunnel.lastErrorKind === 'dns-local'
        ? '隧道进程还活着，但这台电脑解析不了固定域名；手机走运营商 DNS 可能仍然能用。'
        : tunnel.lastErrorKind === 'origin'
          ? '隧道通了，但本机手机服务没应答；先检查 3090 端口和插件服务。'
          : tunnel.lastErrorKind === 'hostname'
            ? '公网地址和 Cloudflare 的 Public Hostname 对不上，先检查域名。'
            : '隧道还在，但公网探测失败；正在继续观察。';
      else if (working && namedActive) namedStatus = '正在连接 Cloudflare 固定隧道…';
      else if (namedActive && tunnel.up) namedStatus = '已连接。手机用上面的固定地址，DSH 重启后也不用重新扫码。';
      else if (namedActive) namedStatus = tunnel.error
        ? '固定隧道开着，但公网那边连不上。下面那段是 cloudflared 的原话。'
        : '固定隧道已开启，但还没连上 Cloudflare。';
      else namedStatus = '未启用。需要先在 Cloudflare 创建命名隧道，把 Public Hostname 指向本机端口。';

      return h('div', { key: 'tunnel', style: styles.block },
        h('div', { style: styles.entryTitle }, '公网访问'),
        h('div', { style: styles.muted }, '不想装 Tailscale 的话就打开这个：走 Cloudflare 的免费隧道，手机在外面用流量也能连进来。'),
        h('div', { style: Object.assign({}, styles.entryTitle, { marginTop: 14 }) }, '临时地址（快速隧道）'),
        h('label', { style: styles.toggleRow },
          h('input', {
            type: 'checkbox',
            checked: quickEnabled,
            disabled: Boolean(busy || tunnel.starting || namedActive),
            onChange: function (e) { toggle(e.target.checked, { mode: 'quick' }); },
          }),
          h('span', null, quickEnabled ? '已开启' : '开启'),
        ),
        h('div', { style: quickEnabled && tunnel.error ? styles.detail : styles.muted }, quickStatus),
        quickEnabled && tunnel.error ? h('div', { style: styles.detail }, tunnel.error) : null,
        quickEnabled ? h('div', { style: styles.muted }, '每次重启 DSH 后地址会变化，需重新扫码。') : null,
        quickEnabled ? h('div', { style: styles.warn }, '开着的时候这个服务就挂在公网上了。密码仍然是唯一的门，别把地址或二维码发出去。') : null,

        h('div', { style: Object.assign({}, styles.entryTitle, { marginTop: 18 }) }, '固定地址中继（A）'),
        h('div', { style: styles.muted }, '在快速隧道前面套一层我们的 Worker 中继，得到一个固定的 <id>.dsh-mini-remote.com 地址。流量经过中继，不是端到端加密；首次开通需要邀请码。'),
        h('label', { style: styles.toggleRow },
          h('input', {
            type: 'checkbox',
            checked: Boolean(aRelay && aRelay.enabled),
            disabled: Boolean(busy || namedActive || !quickEnabled),
            onChange: function (e) { aRelay.save(e.target.checked); },
          }),
          h('span', null, aRelay && aRelay.enabled ? '已开启' : '开启'),
        ),
        h('div', { style: styles.muted }, (function () {
          if (!aRelay || !aRelay.enabled) return '未开启。先开启上面的快速隧道，再打开这一项。';
          if (aRelay.state === 'active') return '已连接：' + (aRelay.publicUrl || '固定地址');
          if (aRelay.state === 'paused') return '自动登记已暂停：' + (aRelay.error || '检查邀请码或 Worker。');
          if (aRelay.state === 'degraded') return '中继暂时异常，正在重试：' + (aRelay.error || '');
          return '正在等待快速隧道地址并登记…';
        })()),
        h('div', { style: { marginTop: 8 } },
          h('input', {
            type: 'text',
            value: aRelay.invite,
            placeholder: aRelay.hasInviteCode ? '邀请码已保存；要换再填一次' : '首次开通的邀请码',
            onChange: function (e) { aRelay.setInvite(e.target.value); },
            style: styles.input,
          }),
        ),
        h('div', { style: { marginTop: 8 } },
          h('button', {
            type: 'button',
            disabled: Boolean(busy || namedActive || !quickEnabled),
            style: styles.btn,
            onClick: function () { aRelay.save(true); },
          }, '保存固定中继'),
        ),
        aRelay && aRelay.enabled ? h('div', { style: styles.warn }, '固定中继会看到明文流量；它不是端到端加密。别把地址或二维码发出去。') : null,

        h('div', { style: Object.assign({}, styles.entryTitle, { marginTop: 18 }) }, '固定地址（Cloudflare 命名隧道）'),
        h('div', { style: styles.muted },
          '在 Cloudflare Zero Trust 创建命名隧道，把 Public Hostname 指向 http://127.0.0.1:3090，再复制隧道 token 填到这里。地址固定，DSH 重启不用重新扫码。'),
        field('公网地址', named.publicUrl, 'https://dsh.example.com', named.setPublicUrl, 'text', true),
        field('隧道 token', named.token,
          tunnel.hasToken ? '已经存过一份了，留空就不改动它' : '粘贴 cloudflared tunnel run --token 的值',
          named.setToken, 'password', true),
        h('div', { style: namedActive && tunnel.error ? styles.detail : styles.muted }, namedStatus),
        namedActive && tunnel.error ? h('div', { style: styles.detail }, tunnel.error) : null,
        h('div', { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            disabled: working,
            style: styles.btnPrimary,
            onClick: named.save,
          }, working ? '处理中…' : (namedActive ? '保存并重启' : '保存并开启')),
          h('button', {
            type: 'button',
            disabled: working || !namedActive,
            style: styles.btn,
            onClick: named.stop,
          }, '停止'),
          (tunnel.phase === 'paused' || tunnel.phase === 'failed'
            || tunnel.phase === 'degraded' || tunnel.phase === 'restarting')
            ? h('button', {
              type: 'button',
              disabled: Boolean(busy),
              style: styles.btn,
              onClick: named.retry,
            }, '立即重试')
            : null,
        ),
        namedActive ? h('div', { style: styles.warn },
          '固定地址也经过 Cloudflare，Cloudflare 在边缘能看到明文；它不是端到端加密。别把地址或二维码发出去。') : null,
        // 固定域名第一次配置比快速隧道多几步：域名、Zero Trust、隧道、路由。
        // 默认收起，配过的人不用再看；第一次配的人不用另开文档。
        named.guideOpen ? null : h('div', { style: Object.assign({}, styles.muted, { marginTop: 12 }) },
          '第一次配置需要：一个 Cloudflare 域名、一条命名隧道、一个 Public Hostname。'),
        h('div', { style: { marginTop: 12 } },
          h('button', { type: 'button', style: styles.btn, onClick: named.toggleGuide },
            named.guideOpen ? '收起配置指引' : '配置指引（Cloudflare 六步）'),
        ),
        named.guideOpen ? namedTunnelGuide() : null,
      );
    }

    /**
     * 固定域名（Cloudflare 命名隧道）的配置指引。
     *
     * 按 2026-10-27 实机走通的那条路写：Cloudflare Registrar 买域名 →
     * Zero Trust 建隧道 → 已发布应用 → 插件填 token。域名一律用 example.com，
     * 用户换成自己的；不在界面里写死某一个人的域名。
     */
    function namedTunnelGuide() {
      var sections = [
        ['一、准备域名', [
          '在 Cloudflare Registrar 买一个域名，或把已有域名接入 Cloudflare；首页看到状态是 Active 才能继续。',
          '域名只用来做固定地址，不需要建站、不需要邮箱；新域名最省事。',
          '如果域名已有网站，不要为了试这个功能去迁整个域名的 NS，先确认现有记录能一起搬。',
        ]],
        ['二、进 Zero Trust', [
          '打开 https://one.dash.cloudflare.com/ 。',
          '有的账号第一次进会要求起团队名，随便填一个英文名，计划选 Free；有的账号会直接进控制台，没看到这一步就跳过，不影响隧道。',
          '团队名不是域名，也不影响隧道，只是 Cloudflare Access 的标识。',
        ]],
        ['三、创建命名隧道，复制 token', [
          '左侧 Networks → Tunnels → Create a tunnel，选 Cloudflared，名字例如 dsh-mini-remote。',
          '保存后页面会给一条安装命令，里面有 --token eyJ...；只复制 token 这一串。',
          '不要安装 Windows 服务，也不要手动运行那条命令——插件会自己启动 cloudflared。',
        ]],
        ['四、添加已发布应用（Public Hostname）', [
          '点隧道名字进入详情，点 Add route / 添加路由，选「已发布应用」。',
          '子域填 dsh；域名选你的域名，例如 example.com；路径留空。',
          '服务类型选 HTTP，服务 URL 填 http://127.0.0.1:3090；端口要和插件实际监听的一致。',
          '保存后完整主机名是 dsh.example.com，路由会从「无路由」变成 1，Cloudflare 自动创建 CNAME。',
        ]],
        ['五、回插件填写并开启', [
          '公网地址填 https://dsh.example.com，不要带路径，也不要少 https://。',
          '隧道 token 粘贴 --token 后面那一串；保存并开启。',
          '状态变成「已连接」后，手机连接里会出现「公网（固定）」。',
        ]],
        ['六、验证', [
          '在电脑上执行 nslookup dsh.example.com 8.8.8.8，能返回 Cloudflare 地址就对了。',
          '再执行 curl.exe -I https://dsh.example.com，能返回 HTTP 状态码就说明公网入口通了。',
          '手机用流量打开二维码；如果本机提示解析不了域名，多半是本地 DNS 缓存，手机走运营商 DNS 通常没问题。',
        ]],
        ['七、注意', [
          'token 是密码，不要截图或发人；泄露后在 Cloudflare 里轮换。',
          'Cloudflare 在边缘能看到明文，不是端到端加密。',
          '这条路解决地址固定，不解决国内速度；国内日常仍建议用自建 frp。',
          '404 多半是公网地址和 Public Hostname 不一致；502 多半是本机端口没开或填错。',
        ]],
      ];
      var out = [h('div', { key: 'named-guide-intro', style: Object.assign({}, styles.muted, { marginTop: 12 }) },
        '按下面顺序做，第一次大约 10 分钟；域名和端口换成你自己的。')];
      for (var i = 0; i < sections.length; i += 1) {
        out.push(h('div', { key: 'named-guide-' + i, style: Object.assign({}, styles.entryTitle, { marginTop: 12 }) }, sections[i][0]));
        for (var j = 0; j < sections[i][1].length; j += 1) {
          out.push(h('div', { key: 'named-guide-' + i + '-' + j, style: styles.muted }, sections[i][1][j]));
        }
      }
      return h('div', { key: 'named-guide' }, out);
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
        h('div', { style: styles.muted }, '当前连接密码，扫码时自动携带；也可在此查看或更换。'),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h('input', {
            readOnly: true,
            value: shown,
            spellCheck: false,
            // 点一下全选：想复制走的时候不用一格一格拖。
            onFocus: function (e) { try { e.target.select(); } catch (err) { /* 忽略 */ } },
            style: Object.assign({}, styles.monoInput, { flex: '1 1 240px', width: 'auto' }),
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
            style: Object.assign({}, styles.monoInput, { flex: '1 1 240px', width: 'auto' }),
          }),
          h('button', {
            type: 'button',
            disabled: Boolean(pwd.busy),
            onClick: pwd.savePassword,
            style: styles.btnPrimary,
          }, pwd.busy ? '保存中…' : '保存'),
        ),
        pwd.pwdError ? h('div', { style: styles.error }, pwd.pwdError) : null,
      );
    }

    function entryBlock(entry, index, copied, copy) {
      var url = typeof entry.url === 'string' ? entry.url : '';
      var done = url !== '' && copied === url;
      return h('div', { key: entry.kind || String(index), style: styles.block },
        h('div', { style: styles.entryTitleSub }, entry.label || entry.kind || '手机'),
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
              // 地址带着 token，单行放不下会截断；悬停给全文。
              title: url,
              spellCheck: false,
              // 点一下就把整条地址选中，方便直接 Ctrl+C。
              onFocus: function (e) { try { e.target.select(); } catch (err) { /* 忽略 */ } },
              style: Object.assign({}, styles.monoInput, { flex: '1 1 180px', width: 'auto', minWidth: 180 }),
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
     * ## 这一屏有两层（2026-10-17 起）
     *
     *   · **上面一层：一份「其他电脑」名单**（`MiniRemoteList`）。侧栏那枚图标点开先看到
     *     的就是它——一行一台，点一行就把那一台的界面显示在这一屏里。
     *   · **下面一层：选中那一台的「电脑端界面」**（另一个源，经它自己的镜像门嵌进来）。
     *
     * ## 为什么不再显示"本机"了（用户拍板的一条产品修正）
     *
     * 原来点开显示的是**本机**的电脑端界面——那是跨机还没做出来时的中间验证（脚手架）：
     * 用它证明"取票 → 嵌框 → 过门"这一套真的能通。跨机做通之后它就没意义了，
     * 用户的原话是：「远程窗口我们为什么要设置为显示当前电脑的dsh页面，这没有意义啊」
     * ——**人就坐在这台电脑前面，为什么还要在这块面板里再看一遍自己的界面。**
     *
     * 所以本机那条**从界面上退休**：面板挂载时不再去换本机那张票。**底下那套零件一个字没删**
     * ——宿主侧那条路由还在 `lib/index.js` 上，跨机这条路复用的取票/嵌框/过门也照旧
     * （`lib/` 里一个字都没动）。
     *
     * ## 为什么要先取一张票，而不是直接把地址写进 src
     *
     * 那个地址后面要跟凭据。**令牌绝不能进 iframe 地址**——浏览历史、截图、别人拿到这台
     * 电脑就能翻出来。所以走两条腿：
     *   · 宿主那一半（同一台电脑、本来就拿着令牌）去换一张**一次性票**（30 秒、用完即废）；
     *   · 界面这半边只拿得到「票 + 地址」，拼进 src 的只有票。
     *
     * 票进门那一刻会被兑现成一枚**窗口会话 cookie**（框里那些请求全靠它认人），
     * 而票自己**只授权那一次**；地址里留着的那张票之后只用来回答「这一页是我嵌出来的吗」
     * ——桌面端是**跨站**嵌进来的，只能靠票来定「许不许被嵌」。**令牌全程没进过浏览器。**
     *
     * **票在"开这一台"那一刻换一次，之后不动**（2026-10-17 改）：名单上点一台、设置页点
     * 「重连」、那一屏的「再试一次」——三个入口各换一次（都在 `fetchRemoteTicket` 里）。
     * **面板自己不会再去换第二张**：那一枚窗口会话 cookie 没有时间限制，按票的寿命定期
     * 重取只会把**框整个重载一遍**（来龙去脉写在下面那个"原来有个 effect"那一段里）。
     */
    /**
     * 面板里那一份「其他电脑」名单（2026-10-17）：侧栏那枚图标点开之后看到的**第一屏**。
     *
     * 它是 `MiniRemotePanel` 里那一段的"画法"，不是另一个组件：hook 全排在面板那一头
     * （见那里的注释），这里只管把已经读到的三样东西画出来。
     *
     * ## 三种结局，一个转不完的圈都没有
     *
     *   · 读到了、有内容 → 一行一台（名字 + 地址 + 最近一次成功）；
     *   · 读到了、一台也没有 → 「还没连过别的电脑。去『设置 → 遥控设置 → 其他电脑』里加一台。」；
     *   · 读不到 → 照登原因（和设置页那一块同一条口径：404/405 = 宿主是旧版，下一步重启 DSH）。
     *
     * "读不到"和"一台都没有"是两件事，**绝不能说成同一句**：把读失败说成"还没连过"，
     * 用户会去重配一台其实早就配好的电脑。
     */
    function remoteListScreen(list, error, again) {
      if (error) {
        return h('div', { style: styles.panelMsg },
          h('div', { style: Object.assign({}, styles.muted, styles.say) }, error),
          h('div', { style: { marginTop: 18 } }, again),
        );
      }
      if (list === null) return h('div', { style: styles.panelMsg }, '正在读取「其他电脑」名单…');
      if (!list.length) {
        return h('div', { style: styles.panelMsg },
          h('div', null, '还没连过别的电脑。去『设置 → 遥控设置 → 其他电脑』里加一台。'),
          h('div', { style: { marginTop: 18 } }, again),
        );
      }

      var rows = list.map(function (one) {
        var lastOk = formatTime(one.lastOk);
        var working = remoteBusyId === one.id;
        return h('div', {
          key: one.id,
          style: Object.assign({}, styles.deviceRow, { cursor: 'pointer' }),
          onClick: function () { openRemoteScreen(one); },
        },
          h('div', { style: styles.deviceMain },
            h('div', { style: styles.deviceName }, one.name ? one.name : '（这台电脑没有名字）'),
            h('div', { style: styles.remoteUrl }, one.baseUrl || ''),
            h('div', { style: styles.muted }, lastOk ? '最近成功 ' + lastOk : '最近成功 还没有记录'),
          ),
          working ? h('div', { style: styles.muted }, '取票中…') : null,
        );
      });

      return h('div', { style: styles.listWrap },
        h('div', { style: styles.listHead }, '其他电脑'),
        h('div', { style: styles.muted }, '点一台，就把它的界面显示在这儿。'),
        h('div', null, rows),
        h('div', { style: { marginTop: 12 } }, again),
      );
    }

    function MiniRemotePanel() {
      // —— 名单那一层要的三样东西。**hook 全排在函数开头**：这一屏有两层，下面按
      //    「在看某一台 / 在看名单」分两头返回；hook 排在分支之后的话，切换那一瞬间
      //    React 会看到 hook 个数变了（那是真机上会炸的一种错）。
      var listState = useState(null);   // null = 还在读；[] = 读到了，一台也没有
      var list = listState[0];
      var setList = listState[1];
      var listErrorState = useState(null);
      var listError = listErrorState[0];
      var setListError = listErrorState[1];
      var tryState = useState(0);       // 每按一次「重新读一遍」+1 = 重读一次
      var tries = tryState[0];
      var setTries = tryState[1];
      // 框一直没打开时的兜底（见 REMOTE_FRAME_WAIT_MS）：到点把空白框换成一句人话。
      var stallState = useState(false);
      var stalled = stallState[0];
      var setStalled = stallState[1];
      // 兜底那个定时器的把手。**它必须活在 effect 外面**：要把它掐掉的那一下在 `onLoad` 里，
      // 和立钟的那个 effect 隔着一次渲染——留在一个只属于那个 effect 的闭包里，`onLoad` 够不着。
      // 2026-10-17 修的就是这个：框加载好了，那个钟却还挂着，到点照样把正常的界面换掉。
      var stallTimerRef = useRef(null);
      // **哪个地址已经成功加载过一次**（2026-10-20 补）。
      //
      // 2026-10-17 那次修的是"onLoad 时清掉那个钟"，但没修全：`onLoad` **一辈子只会响一次**，
      // 而 effect 会因为 `remoteUrl` 变化**重新立钟**——新的那口钟没有任何 onLoad 来清它，
      // 20 秒一到照样把已经好好显示着的界面换成「一直没打开」。用户的症状正是这个：
      // 窗口先正常打开、过一会儿突然消失、跳回报错。
      //
      // 现在的口径：**同一个地址只要成功加载过，就不许再立钟**。记的是地址（不是布尔），
      // 所以换了新票（新地址）时兜底照常工作——那时确实还没加载过。
      var frameLoadedRef = useRef('');
      // 顶上那条横条现在是不是滑出来了（见 `remoteScreen`）。**只有"框正常显示 + 有悬停能力"
      // 时才可能收起**，其余状态它常驻——出错那一屏全靠它的「再试一次」。
      var barState = useState(false);
      var barOpen = barState[0];
      var setBarOpen = barState[1];
      // 两个定时器：显示等 0.18 秒（鼠标可能只是路过屏幕顶部），收起等 0.2 秒
      // （光标常常是从感应带往下挪进横条里，中途路过那一下不该算"离开"）。
      var barShowTimer = useRef(null);
      var barHideTimer = useRef(null);
      // 订阅「其他电脑」那三样（哪一台在换、换到没有、为什么没成）：变了就重画一遍。
      // 值本身不用，`setPoke` 那一下就是目的。
      var pokeState = useState(0);
      var setPoke = pokeState[1];

      // —— 远程窗口里「挑目录 / 登记工作区」（2026-10-19 加）。
      //
      // 为什么需要它：远程窗口嵌的是**对面那台电脑的官方界面**，它那个「新建工作区」走官方
      // `directoryPicker/pick`——官方实现是 `dialog.showOpenDialog`，**在对面那台的屏幕上**
      // 弹系统对话框。用户坐在这一台前面，看不到也点不到，请求挂到超时只报一句
      // `HTTP 502`。手机页早就绕开这件事了（自己读目录，见 lib/browse.js），这里把同一套
      // 能力接到远程窗口：**这一台**列对面的目录、选一个、让对面登记成工作区。
      //
      // **必须用 useState**：`var` 在组件里每次渲染都会重置，值留不住。
      var browseOpenState = useState(false);
      var browseOpen = browseOpenState[0];
      var setBrowseOpen = browseOpenState[1];
      var browseAtState = useState('');
      var browseAt = browseAtState[0];
      var setBrowseAt = browseAtState[1];
      var browseRootsState = useState(null);
      var browseRoots = browseRootsState[0];
      var setBrowseRoots = browseRootsState[1];
      var browseDataState = useState(null);
      var browseData = browseDataState[0];
      var setBrowseData = browseDataState[1];
      var browseBusyState = useState(false);
      var browseBusy = browseBusyState[0];
      var setBrowseBusy = browseBusyState[1];
      var browseErrState = useState('');
      var browseErr = browseErrState[0];
      var setBrowseErr = browseErrState[1];
      // 「新建文件夹」：输入框露不露、里面打的字。
      var mkdirOpenState = useState(false);
      var mkdirOpen = mkdirOpenState[0];
      var setMkdirOpen = mkdirOpenState[1];
      var mkdirNameState = useState('');
      var mkdirName = mkdirNameState[0];
      var setMkdirName = mkdirNameState[1];

      useEffect(function () {
        return subscribeRemote(function () { setPoke(function (n) { return n + 1; }); });
      }, []);

      /**
       * 读名单。**读的是设置页那一块同一个接口**（`GET /mini-remote/remotes`）：两边不可能各说各话。
       *
       * 为什么这一屏要自己读一遍：设置页那一份住在设置页的浮层里，这一份住在 main 槽里
       * ——两个组件在不同的槽里，互相看不见（和上面那份跨机状态同一个理由）。
       *
       * 为什么挂在 `[tries]` 上：这一屏可能一直挂在后台（面板没被卸载），而用户是在设置页里
       * 把电脑加进去的。给一个明确的"再看一眼"的入口（那枚「重新读一遍」），比指望外壳
       * 什么时候重挂一遍可靠。
       */
      useEffect(function () {
        var alive = true;
        setListError(null);
        fetch(REMOTES_PATH)
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (!alive) return;
            var b = (r.body && typeof r.body === 'object') ? r.body : null;
            if (b && b.ok && Array.isArray(b.remotes)) { setList(b.remotes); return; }
            // 宿主那一半是旧版（接口都不在）时，服务端回的是给程序看的 `not found`：
            // 原样摆出来用户读不懂，而下一步只有一句话——重启。和设置页那一块说法一致。
            setListError(r.status === 404 || r.status === 405
              ? '读「其他电脑」名单失败：这台电脑上的服务没有这个接口（HTTP ' + r.status + '）。重启一次 DSH 再试。'
              : ((b && b.error) || ('读「其他电脑」名单失败：服务返回了 HTTP ' + r.status + '。')));
          })
          .catch(function (err) {
            if (!alive) return;
            setListError('读「其他电脑」名单失败：' + ((err && err.message) || String(err)));
          });
        return function () { alive = false; };
      }, [tries]);

      // 保活（2026-10-19）：`remoteTarget` 空、但上一台那一屏还活着时，用 `remoteWin` 兜底
      // 算出 id / 名字 / 地址——这样 `remoteScreen` 照旧被渲染出来（它自己会藏起来），
      // iframe 于是不会被卸载。「彻底清」只在 `resetRemoteSession` 那一处收口。
      var liveWin = (remoteWin && remoteWin.url) ? remoteWin : null;
      var remoteId = remoteTarget ? remoteTarget.id : (liveWin ? liveWin.id : '');
      var remoteName = remoteTarget ? remoteTarget.name : (liveWin ? liveWin.name : '');
      var remoteUrl = (liveWin && liveWin.id === remoteId && liveWin.url) ? liveWin.url : '';

      // 名单那一屏要用的「重新读一遍」。**提到前面来**：`remoteScreen` 在"在看名单"时
      // 要把名单一起画出来（保活那一层），那时它得拿到这一枚。
      var again = h('button', {
        type: 'button',
        onClick: function () { setTries(function (n) { return n + 1; }); },
        style: styles.btn,
      }, '重新读一遍');

      // 换一台 / 退回名单 / 重新进来：顶上那条回到收起状态。
      // 不重置的话，下次点开是展开的——而"展开"本该只由鼠标碰顶那一下产生。
      //
      // **只在真的展开着时才写**：本来就收起的时候这一下是空操作，别拿它去换一次重渲染
      // （替身 React 里 setState 不做同值跳过，真机上也只是白白多画一帧）。
      useEffect(function () {
        if (barOpen) setBarOpen(false);
        clearTimeout(barShowTimer.current);
        clearTimeout(barHideTimer.current);
        barShowTimer.current = null;
        barHideTimer.current = null;
      }, [remoteId]);

      // 卸载时把两个钟收掉：留着它们，200 毫秒后会在一个已经没了的组件上 setState。
      useEffect(function () {
        return function () {
          clearTimeout(barShowTimer.current);
          clearTimeout(barHideTimer.current);
        };
      }, []);

      /** 把顶上那条勾出来。等 0.18 秒：鼠标可能只是路过屏幕顶部。 */
      function scheduleBarShow() {
        if (barShowTimer.current) return;
        clearTimeout(barHideTimer.current);
        barHideTimer.current = null;
        barShowTimer.current = setTimeout(function () {
          barShowTimer.current = null;
          setBarOpen(true);
        }, 180);
      }

      /** 收起来。等 0.2 秒：光标常常是从感应带往下挪进横条里，中途路过那一下不算离开。 */
      function scheduleBarHide() {
        clearTimeout(barShowTimer.current);
        barShowTimer.current = null;
        clearTimeout(barHideTimer.current);
        barHideTimer.current = setTimeout(function () {
          barHideTimer.current = null;
          setBarOpen(false);
        }, 200);
      }

      /** 光标已经进到横条上了：那个 0.2 秒的钟撤掉，别把它收走。 */
      function cancelBarHide() {
        clearTimeout(barHideTimer.current);
        barHideTimer.current = null;
      }

      /**
       * 那一屏的外框：**顶上有条横条**（「← 返回列表」+ 这是哪一台 + 一枚「再试一次」），
       * 下面才是内容。
       *
       * ## 什么时候常驻、什么时候能收起（2026-10-17 用户要求）
       *
       * 收起（鼠标碰顶才滑出）**只在一种状态下成立：框真的显示出来了**。
       * 正在换票、对方撤销了、框一直没起来——那几屏本来就是空白，横条上挂着唯一的出路
       * （「← 返回列表」和「再试一次」），**藏起来等于把人关在里面**。所以那几种一律常驻。
       *
       * 没有悬停能力的设备（触摸屏）也一律常驻：触摸没有"碰一下顶"这回事，
       * 藏了就是摸不到（和 `lib/page.html` 那条镜像顶栏同一条口径）。
       *
       * ## 感应带那 16px 不能省
       *
       * 鼠标一进到框里那份文档，事件就进了那份文档，外层一个都收不到——不盖一条的话，
       * 最上面就没有任何东西能"碰到"。它透明、只 16px，压在框顶上那道空白上。
       * 收起时横条的**位置跟着让出来**（`max-height: 0`），框自己长上来填满，不跳。
       *
       * 顶上那枚「再试一次」**永远在**：它兜的是这一屏最没法自己判的两种情形
       * ——对面回的是一张错误页，或者文档到了里面却是空的。跨源的框读不到里面
       * （量过的事实：`contentDocument` 是 null），"里面是不是坏的"我们**看不见，也不猜**；
       * 能保证的是：**不管框里是什么，用户手上永远有一条出去的路**。
       *
       * @param {string} name 那台电脑叫什么
       * @param {*} inner 横条下面那一块（框 / 一句人话 / 「正在换票」）
       * @param {boolean} canAutoHide 横条允许自动收起吗——**只有"框已经显示出来"时传 true**
       */
      /**
       * 远程窗口里「挑目录 / 登记工作区」（2026-10-19 加）——四个动作。
       *
       * 这三个请求都打到**本机**（`/mini-remote/remotes/browse*`、`/remotes/workspaces`），
       * 由宿主带着对面那台电脑的设备凭据去调它。面板**不能直连对面**：它在 `dsh-app://`
       * 里，而对面那些接口没发 CORS 头，跨站直连会被浏览器拦掉。
       */
      function closeRemoteBrowse() {
        setBrowseOpen(false);
        setBrowseAt('');
        setBrowseData(null);
        setBrowseBusy(false);
        setBrowseErr('');
      }

      /** 打开：先拉「常用位置」（主目录 / 最近用过 / 磁盘）。 */
      function openRemoteBrowse() {
        if (!remoteId) return;
        setBrowseOpen(true);
        setBrowseAt('');
        setBrowseData(null);
        setBrowseErr('');
        if (browseRoots) return;          // 开过一次就够，不必每回都重拉
        setBrowseBusy(true);
        api('/mini-remote/remotes/browse/roots?id=' + encodeURIComponent(remoteId))
          .then(function (body) { setBrowseRoots(body); setBrowseBusy(false); })
          .catch(function (err) {
            setBrowseBusy(false);
            setBrowseErr((err && err.message) || String(err));
          });
      }

      /** 进到某个目录（传 `''` = 回「常用位置」那一屏）。 */
      function remoteBrowseTo(p) {
        setBrowseAt(p || '');
        setBrowseData(null);
        setBrowseErr('');
        if (!p) return;
        setBrowseBusy(true);
        api('/mini-remote/remotes/browse?id=' + encodeURIComponent(remoteId)
          + '&path=' + encodeURIComponent(p))
          .then(function (body) { setBrowseData(body); setBrowseBusy(false); })
          .catch(function (err) {
            setBrowseBusy(false);
            setBrowseErr((err && err.message) || String(err));
          });
      }

      /** 把当前这个目录登记成对面那台电脑的工作区。 */
      function remoteBrowsePick() {
        var at = browseAt;
        if (!at || browseBusy) return;
        setBrowseBusy(true);
        setBrowseErr('');
        postJson('/mini-remote/remotes/workspaces', { id: remoteId, path: at })
          .then(function (r) {
            var b = (r.body && typeof r.body === 'object') ? r.body : null;
            if (!b || b.ok !== true) {
              setBrowseBusy(false);
              setBrowseErr((b && b.error) || ('登记失败：服务返回了 HTTP ' + r.status + '。'));
              return undefined;
            }
            // 登记成功：收起弹层、清掉缓存，让对面那台下次进来看到新工作区。
            setBrowseOpen(false);
            setBrowseBusy(false);
            setBrowseAt('');
            setBrowseData(null);
            setBrowseRoots(null);
            return undefined;
          })
          .catch(function (err) {
            setBrowseBusy(false);
            setBrowseErr('登记失败：' + ((err && err.message) || String(err)));
          });
      }

      /** 在当前这个目录下新建一个文件夹；建完刷新这一屏，让新文件夹当场看得见。 */
      function remoteBrowseMkdir() {
        var at = browseAt;
        var name = String(mkdirName || '').trim();
        if (!at || !name || browseBusy) return;
        setBrowseBusy(true);
        setBrowseErr('');
        postJson('/mini-remote/remotes/browse/mkdir', { id: remoteId, path: at, name: name })
          .then(function (r) {
            var b = (r.body && typeof r.body === 'object') ? r.body : null;
            if (!b || b.ok !== true) {
              setBrowseBusy(false);
              setBrowseErr((b && b.error) || ('建文件夹失败：服务返回了 HTTP ' + r.status + '。'));
              return undefined;
            }
            setMkdirOpen(false);
            setMkdirName('');
            setBrowseBusy(false);
            remoteBrowseTo(at);
            return undefined;
          })
          .catch(function (err) {
            setBrowseBusy(false);
            setBrowseErr('建文件夹失败：' + ((err && err.message) || String(err)));
          });
      }

      function remoteScreen(name, inner, canAutoHide) {
        // 两个条件都得成立才收：这一屏允许（canAutoHide）且这台设备能悬停（HAS_HOVER）。
        var collapsible = Boolean(canAutoHide) && HAS_HOVER;
        var hidden = collapsible && !barOpen;

        var root = h('div', { style: styles.screen },
          // 感应带：盖在最顶上那 16px 上（见上面那段"不能省"）。
          collapsible ? h('div', {
            style: styles.screenHot,
            onMouseEnter: scheduleBarShow,
            // 显示这一屏那一刻鼠标可能就停在顶上（那时不会再有 mouseenter）——动一下也算数。
            onMouseMove: scheduleBarShow,
            onMouseLeave: scheduleBarHide,
          }) : null,
          h('div', {
            style: Object.assign({}, styles.screenBarWrap, { maxHeight: hidden ? 0 : 100 }),
            onMouseEnter: cancelBarHide,
            onMouseLeave: collapsible ? scheduleBarHide : null,
            // Tab 走到横条里那几枚按钮上时也要把它亮出来——
            // 不留"焦点在这、按钮看不见"的坑（手机镜像页那条也是这么兜的）。
            onFocus: collapsible
              ? function () { cancelBarHide(); setBarOpen(true); }
              : null,
          },
            h('div', { style: styles.screenBar },
              h('button', {
                type: 'button',
                onClick: function () { leaveRemoteScreen(); },
                style: styles.btn,
              }, '← 返回列表'),
              h('div', { style: styles.screenName }, name ? name : '另一台电脑'),
              // 「新建工作区」（2026-10-19 加）：对面官方界面里那个按钮会**在对面屏幕上**
              // 弹系统对话框，这边点不到。这一枚走我们自己的路：列对面对面的目录、让对面登记。
              h('button', {
                type: 'button',
                onClick: function () { openRemoteBrowse(); },
                style: Object.assign({}, styles.btn, { flex: 'none' }),
              }, '新建工作区'),
              h('button', {
                type: 'button',
                disabled: Boolean(remoteBusyId),
                onClick: function () {
                  // 正在换票就别再叠一趟（和名单上点一行同一个口径，见 openRemoteScreen）：
                  // 同时飞两条取票请求，后回来的那张票会把前一张盖掉。
                  if (remoteBusyId) return;
                  fetchRemoteTicket(remoteId, remoteName);
                },
                // 靠右（marginLeft auto）：台名那一格会被挤扁，这一枚不许跟着一起被挤掉。
                style: Object.assign({}, styles.btn, { marginLeft: 'auto', flex: 'none' }),
              }, '再试一次'),
            ),
          ),
          inner,
          // 目录选择弹层：**关掉就整个不渲染**，不常驻。
          browseOpen ? (function () {
            var rows = [];
            if (browseErr) rows.push(h('div', { key: 'err', style: styles.browseErr }, browseErr));
            if (browseBusy) {
              rows.push(h('div', { key: 'busy', style: styles.browseNote }, '正在读取…'));
            } else if (!browseAt) {
              if (!browseRoots) {
                rows.push(h('div', { key: 'none', style: styles.browseNote }, '正在读取常用位置…'));
              } else {
                rows.push(h('div', { key: 'note', style: styles.browseNote },
                  '挑一个文件夹，登记成那台电脑的工作区。'));
                var pairs = [['主目录', browseRoots.home]]
                  .concat((browseRoots.recent || []).map(function (p) { return ['最近用过', p]; }))
                  .concat((browseRoots.drives || []).map(function (p) { return ['磁盘', p]; }));
                pairs.forEach(function (pair, i) {
                  if (!pair[1]) return;
                  rows.push(h('button', {
                    key: 'r' + i, type: 'button',
                    onClick: function () { remoteBrowseTo(pair[1]); },
                    style: styles.browseRow,
                  }, pair[0] + '：' + pair[1]));
                });
              }
            } else if (!browseData) {
              rows.push(h('div', { key: 'none', style: styles.browseNote }, '正在读取…'));
            } else {
              var chain = browseData.ancestors || [];
              var up = chain.length > 1 ? chain[chain.length - 2].path : '';
              rows.push(h('button', {
                key: 'up', type: 'button',
                onClick: function () { remoteBrowseTo(up); },
                style: styles.browseRow,
              }, '← 上一级'));
              rows.push(h('button', {
                key: 'mkdir', type: 'button',
                onClick: function () { setMkdirOpen(true); setMkdirName(''); },
                style: styles.browseRow,
              }, '＋ 新建文件夹'));
              if (mkdirOpen) {
                rows.push(h('div', { key: 'mkdirRow', style: styles.browseMkdirRow },
                  h('input', {
                    type: 'text',
                    value: mkdirName,
                    placeholder: '新文件夹的名字',
                    autoComplete: 'off',
                    onChange: function (e) { setMkdirName(e && e.target ? e.target.value : ''); },
                    style: styles.browseInput,
                  }),
                  h('button', {
                    type: 'button',
                    disabled: browseBusy || !String(mkdirName || '').trim(),
                    onClick: remoteBrowseMkdir,
                    style: styles.btn,
                  }, '建'),
                  h('button', {
                    type: 'button',
                    onClick: function () { setMkdirOpen(false); setMkdirName(''); },
                    style: styles.btn,
                  }, '取消'),
                ));
              }
              rows.push(h('button', {
                key: 'pick', type: 'button',
                onClick: remoteBrowsePick,
                style: Object.assign({}, styles.browseRow, { fontWeight: '600' }),
              }, '就选这个目录'));
              var dirs = browseData.dirs || [];
              dirs.forEach(function (d, i) {
                rows.push(h('button', {
                  key: 'd' + i, type: 'button',
                  onClick: function () { remoteBrowseTo(d.path); },
                  style: styles.browseRow,
                }, d.name));
              });
              if (!dirs.length) {
                rows.push(h('div', { key: 'empty', style: styles.browseNote }, '这个目录下面没有子目录。'));
              }
              if (browseData.truncated) {
                rows.push(h('div', { key: 'cut', style: styles.browseNote },
                  '只列了前 ' + dirs.length + ' 个，共 ' + browseData.total + ' 个。'));
              }
            }
            return h('div', { key: 'browse', style: styles.browseOverlay },
              h('div', { style: styles.browseSheet },
                h('div', { style: styles.browseHead },
                  h('div', { style: styles.browseTitle }, browseAt ? browseAt : '挑一个文件夹'),
                  h('button', { type: 'button', onClick: closeRemoteBrowse, style: styles.btn }, '关闭'),
                ),
                h('div', { style: styles.browseBody }, rows),
              ),
            );
          })() : null,
        );

        // 保活（2026-10-19）：正在看那一台 → 照旧只返回它。
        if (remoteTarget) return root;

        // 在看名单、但上一台那一屏还活着（`liveWin` 兜底出来的）：**把它藏着留在 DOM 里**，
        // 名单画在上面。藏着而不是拆掉——`display:none` 不会卸载 iframe，切回来只是露出来，
        // 不走一遍「取票 + 重新加载」。（真正要彻底放下这一趟时走 `resetRemoteSession`，
        // 那时 `remoteWin` 被清、这一屏才真的被拆掉。）
        return h('div', { style: { position: 'relative', width: '100%', height: '100%' } },
          h('div', { key: 'kept-screen', style: { display: 'none' } }, root),
          remoteListScreen(list, listError, again),
        );
      }

      // —— **这里原来有一个"票不新鲜了就现换一张"的 effect**（2026-10-17 拆掉）。
      //
      // 它看着很稳妥（票是一次性的、30 秒就过期），后果却是：**票一变，框的地址就变，
      // 于是整个框重载一遍**——用户只是想一直看着那一台电脑，屏幕上却是每约 25 秒
      // （30 秒寿命 − 5 秒余量）刷新一次。而"重新取票"根本不必要：
      //
      //   · 票**只在第一次打开那一刻**需要：那一下进门的请求把它兑成一枚**窗口会话 cookie**
      //     （lib/server.js:1639-1643 种的那一枚），框里之后的请求（静态资源、`api/*`、
      //     WebSocket）全靠那枚 cookie 认人，**票不再参与**；
      //   · 那枚 cookie **没有时间限制**：会话体只有"形状 + 本进程签名"两项判据，没有
      //     到期时刻（lib/mirror.js:1131-1147），密钥是每个宿主进程现生成的
      //     （lib/mirror.js:1112）；`lib/mirror.js:1200` 写着"没有固定寿命，跟着这个宿主进程走"，
      //     lib/server.js:1640-1643 也**故意不写 Max-Age**。它只在两件事上失效：**DSH 重启**、
      //     或者**对面把这条设备记录撤销了**（lib/mirror.js:1108-1110 + 每次放行现查名册）；
      //   · 地址里留着的那张票随后只用来回答"这一页是我嵌出来的吗"（取景判据），而兑过的票
      //     进 `grants` 之后**同样没有寿命**（lib/mirror.js:1229/1293）——所以**同一条地址
      //     再加载一次照样进得去**，不需要换一张新票。
      //
      // 所以票改成"**开这一台那一刻换一次，之后不动**"：三个入口各换一次（名单上点一台 /
      // 设置页点「重连」/ 那一屏的「再试一次」，都在 `fetchRemoteTicket` 里）。
      // **面板自己不再换第二张**——地址不变，框就不重载。要重新开一扇窗（对面重启过、
      // 撤销过又配回来了），入口是「重连」和「再试一次」，都是用户按下去的动作。

      // 框等不到 load：到点**先自动重取一张票再试一次**，第二次到点才说人话
      // （见 REMOTE_FRAME_WAIT_MS 与 remoteAutoRetrySpent 里那两条）。
      //
      // **这个兜底只兜"框里一直没有任何文档"这一种**：框一旦 load 过（哪怕对面回的是一张
      // 错误页），`onLoad` 那一下就把这个钟掐掉——**它之后永远不许再响**。
      // 2026-10-17 之前它只在依赖变化/卸载时清，于是真机形态里出现过这种坏法：框明明
      // 已经加载好了，t≈20s 那一屏照样被换成「一直没打开」——一句错话盖住正常的界面。
      //
      // 那条"错误页 / 空白文档也算回来了"的取舍照旧没变（见下面 onLoad 那一段）：跨源读不到
      // 里面，判不出来就不猜。补上自动重取**不等于**能做这个判断——自动重取兜的只是
      // "框里一个文档都没有"这一种；另外两种的出路是顶上那枚永远在的「再试一次」。
      useEffect(function () {
        if (!remoteId || !remoteUrl) return undefined;
        // **这个地址已经成功加载过 → 不立钟**（2026-10-20，见 `frameLoadedRef` 那段）。
        // 少这一条，`remoteUrl` 一变就重新立一口没人清的钟，20 秒后把好好的界面换掉。
        if (frameLoadedRef.current === remoteUrl) {
          setStalled(false);
          return undefined;
        }
        setStalled(false);
        stallTimerRef.current = setTimeout(function () {
          // **先自动重取一张票、再试一次（只这一次）**：票是一次性的、真机上 30 秒就作废，
          // 第一次加载被拖过那 30 秒时套着旧票重载是白费，换一张新的才有救（2026-10-17 补）。
          // 花掉那份预算的意思是"这一次人的动作里到此为止"：它绝不会自己接着自己转下去。
          if (!remoteAutoRetrySpent) {
            remoteAutoRetrySpent = true;
            // 票一换、地址就变：框整个重立一次，这个 effect 会照新地址再挂一个钟
            // ——所以"第二次到点"是真的又过了这 20 秒，不是紧接着。
            fetchRemoteTicket(remoteId, remoteName, { auto: true });
            return;
          }
          // 自动那一趟也没成：**这才**把框换成那句人话 + 「再试一次」（下面 stalled 那一支）。
          setStalled(true);
        }, REMOTE_FRAME_WAIT_MS);
        return function () {
          // 换一台 / 返回列表 / 卸载都走这里：手上那个钟照旧清掉（别留下会自己响的定时器）。
          clearTimeout(stallTimerRef.current);
          stallTimerRef.current = null;
        };
      }, [remoteId, remoteUrl]);

      if (remoteId) {
        var problem = remoteProblems[remoteId];
        if (remoteBusyId === remoteId) {
          // 自动重取那一次要说清是"第一次没打开、正在再试一次"（见 REMOTE_AUTO_RETRY_TEXT）：
          // 换票那一刻那一块本来就是空的，不说话就等于无声地又转一圈。
          return remoteScreen(remoteName, h('div', { style: styles.panelMsg },
            remoteAutoRetry ? REMOTE_AUTO_RETRY_TEXT : '正在向那台电脑换一张通行证…'));
        }
        if (problem) {
          return remoteScreen(remoteName, remoteProblemPanel(remoteId, remoteName, problem));
        }
        // 手上还没有这一台的地址（正在换票，或者还没换）：**这时一个框都不立**。
        // 地址一拿到就只认它——**不再按票的寿命判"新不新鲜"**（那正是"每 25 秒把框
        // 重载一遍"的来路，见上面那一段）：票在框第一次加载那一刻就兑成了窗口会话 cookie，
        // 那枚 cookie 没有时间限制。
        if (!remoteUrl) {
          return remoteScreen(remoteName, h('div', { style: styles.panelMsg }, '正在向那台电脑换一张通行证…'));
        }
        // **不再把框换掉**（2026-10-20 改）：`stalled` 时只在框上面叠一条提示（见下面那段）。
        //
        // 原来的做法是把整个框替换成"一直没打开"+「再试一次」。问题在于：跨源读不到框里，
        // **我们判断不了它到底开没开**——对面界面里只要有一个资源迟迟不完成，`onLoad` 就
        // 永远不触发（跨源 iframe 的 load 要等它自己的文档加载完），于是**界面明明正常显示着，
        // 20 秒一到却被我们换掉**。用户看到的就是「窗口先打开、过一会儿突然消失、跳回报错」。
        //
        // 现在留下来让人自己看：真白着，他一眼就知道，点「再试一次」；开着就继续用。
        return remoteScreen(remoteName, h('div', { style: styles.frameBox },
          stalled
            ? h('div', { style: styles.frameNote },
              '等了 ' + Math.round(REMOTE_FRAME_WAIT_MS / 1000) + ' 秒还没收到「加载完成」的信号。'
              + '如果下面一直白着，点顶上横条里的「再试一次」；看着正常就忽略这条。')
            : null,
          // 重试那一次的说明条（见 REMOTE_AUTO_RETRY_TEXT）：框上面先顶一条，框照旧铺满下面。
          // 框 load 回来那一下它就收掉（见 onLoad）。
          remoteAutoRetry ? h('div', { style: styles.frameNote }, REMOTE_AUTO_RETRY_TEXT) : null,
          h('div', { style: styles.frameWrap },
            h('iframe', {
              src: remoteUrl,
              title: '另一台电脑的界面',
              // 框里是另一个源，里面一个字节都读不到（量过：跨源的 contentDocument 是 null）。
              // 所以"它回来了没有"只能靠这一下——但**502 和连不上也会照常 load**，
              // 所以它只用来取消下面那个兜底，不用来宣布成功。
              //
              // **它触发的意思是"框里有一个文档了"，不是"那台电脑的界面打开了"。**
              // 取舍（2026-10-17）：这一下必须把兜底掐掉——不清的话，一个加载好好的界面
              // 也会在 20 秒后被一句「一直没打开」盖住（那才是用户真被伤到的那一面）。
              // 代价（照旧没变，也**不打算靠猜去补**）：对面回一张错误页（502 之类）、或者
              // 文档到了里面是空的，都算"回来了"，这一屏不会换成我们那句人话。
              // 出路是顶上那枚**永远在**的「再试一次」（见 remoteScreen）。
              onLoad: function () {
                clearTimeout(stallTimerRef.current);
                stallTimerRef.current = null;
                // **记下"这个地址成功加载过"**（2026-10-20，见 `frameLoadedRef` 那段）：
                // 之后同一个地址再触发 effect 也不会立钟，界面不会被一句错话盖掉。
                frameLoadedRef.current = remoteUrl;
                setStalled(false);
                // 框真的回来了：那句"正在再试一次"就该收掉（见 remoteAutoRetry）。
                if (remoteAutoRetry) {
                  remoteAutoRetry = false;
                  notifyRemote();
                }
              },
              style: styles.frame,
            }))), true);
      }

      // 没在看某一台：**名单**（这一屏的第一层）。
      return remoteListScreen(list, listError, again);
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
    var uiWorkspaceFace = null;   // 官方会话/工作区界面服务 ctx.uiWorkspace
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
      // 退出就把"另一台电脑"这一趟放下：下次点侧栏那一条，看到的是**名单**（这一屏的第一层）。
      // 不放的话，隔了半天再点那一条会去开一台早就没在看的电脑。
      if (remoteTarget || remoteWin) {
        // 退出这一屏 = **彻底放下**（和「返回列表」不同：那一个只清一半、留着那一屏保活）。
        resetRemoteSession();
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
     * 「再点一下侧栏那一条」——**上一层**（2026-10-17 改）。
     *
     * 这一屏有两层：上面是「其他电脑」名单，下面是其中一台的界面。所以这一下：
     *   · 人在**某一台的界面**里 → 退回**名单**（还在这一屏里，和顶上那枚「← 返回列表」同一件事）；
     *   · 人已经在**名单**上 → 退出这一屏，回到进来之前那一屏。
     * 一层一层退，用户不用先找到那枚按钮才出得去。
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
      // 在某一台的界面里：这一下是**退回名单**（还在这一屏里）；已经在名单上才是退出。
      if (remoteTarget) { leaveRemoteScreen(); return; }
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
        ctx.inject(['uiWorkspace'], function (scope) {
          uiWorkspaceFace = scope.uiWorkspace || null;
        });
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
            label: () => '遥控设置',
          },
          MiniRemoteSettingsTab,
        );
      });
    }

    exports.name = 'dsh-mini-remote';
    exports.inject = ['slots'];
    exports.apply = apply;
    // 给测试用：把「远程窗口」那一趟彻底清干净（见 `resetRemoteSession` 那段说明）。
    // 生产路径上没有调用者——`leaveRemotePanel` 走同一个函数，但不经过这个出口。
    exports.resetRemoteSession = resetRemoteSession;
    return module.exports;
  }
});
