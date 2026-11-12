
(function () {
  'use strict';

  var DEFAULT_MODE = '__DEFAULT_MODE__';
  var NEEDS_TOKEN = __NEEDS_TOKEN__;
  // 这台设备是**被撤销了**（名册里那条记录被删掉），还是从来没进过门？
  // 由服务端判（它才知道凭据兑不兑得出来），页面只负责把那句话说给用户听。
  var DEVICE_REVOKED = __DEVICE_REVOKED__;
  // 构建指纹，由服务端注入。拼在立绘地址后面，换了图浏览器就不会一直用缓存那张。
  var BUILD = '__BUILD__';
  // 单个文件的大小上限（字节），由服务端注入。页面里不写第二份——两处各写一个数，
  // 迟早会不一致，而那时候的表现是「页面让你传，服务端拒绝」。
  var MAX_UPLOAD = __MAX_UPLOAD__;

  // ---------------- 状态 ----------------
  var params = new URLSearchParams(location.search);
  var state = {
    /**
     * 进没进门——**由服务端说了算**（2026-10-16 第二步）。
     *
     * 服务端只在「没放行」的那一次渲染门禁页（needsToken=true）；放行时永远是 false。
     * 这是页面之后唯一需要的身份信息：真正的凭据是一枚 HttpOnly 的设备 cookie，
     * 页面看不见、也不该管它——浏览器自己会给同源的每一趟请求带上。
     */
    entered: !NEEDS_TOKEN,
    mode: localStorage.getItem('dshMiniMode') || DEFAULT_MODE || 'minimal',
    // 外观：'dark' | 'light' | 'auto'。默认深色——不给老用户换掉现在的样子；
    // 要浅色或跟着系统走，去设置页「外观」点一下。
    theme: localStorage.getItem('dshMiniTheme') || 'light',
    // 字体大小：'small' | 'normal' | 'large'。默认标准。
    fontSize: localStorage.getItem('dshMiniFont') || 'normal',
    sound: localStorage.getItem('dshMiniSound') !== 'off',
    // 锁屏也能提醒（系统通知）。默认关着——它要用户主动点一下才会申请权限，
    // 不能替他决定。明文连接下这一项永远是空转的，见下面「锁屏也能提醒」那一段。
    notify: localStorage.getItem('dshMiniNotify') === 'on',
    /**
     * **流式开关**（2026-10-21，用户要求做成全局切换）：开着时回答正文一个字一个字往外冒，
     * 关着时等整段落定再显示（就是原来的样子）。
     *
     * 默认**关**：先保住现在的观感，想试的人自己去设置页开。
     * **单帧模式不跟**（用户拍板）——那一屏就是"只看最终那一句"，流式反而毁掉它。
     * 开关状态存在本机（和主题、字号、声音一样），但它决定的是连上去要不要带 `stream=1`，
     * 所以关掉时服务端连正文帧都不发，是真省流量。
     */
    streaming: localStorage.getItem('dshMiniStreaming') === 'on',
    /**
     * **这一轮是不是真的收到过正文增量**（2026-10-22）。
     *
     * `state.streaming` 只是本机的开关偏好；连接上到底订没订上、帧有没有来，只有收到
     * 正文帧才算数。加这个记号是为了防止一种误伤：开关状态和连接状态短暂不一致时，
     * 一条 `state` 快照会把刚流出来的字按 `snap.live` 抹掉（快照那条是另一套旧机制，
     * 恒为空），用户看到的就是「流了一下，内容消失」。收到过正文帧就以帧为准。
     */
    streamReceived: false,
    /**
     * **正在拼的那个工具调用**（2026-10-21）：`{ name, args }`。
     * 模型一边写参数（JSON），轨迹的组头一边把半截命令/路径顺出来——
     * 和 PC 上「正在调用 bash · ls -la …」那种感觉对齐。
     * 落定（`tool/call` 进轨迹）时清空，由真条目接管。
     */
    liveTool: null,
    running: false,
    // 本地回显刚发出的指令后，下一次聊天渲染要贴底一次。
    scrollSentMessage: false,
    /** 刚发出去的那一句：服务端有几秒会把它同时算进收件箱，靠它挡住误报。 */
    lastSent: null,
    // 这条「刚发出、要贴底一次」属于哪个会话；切了会话就不再算数（2026-11-03）。
    scrollSentSession: null,
    subagentsRunning: false,
    /** 打开别人（子智能体）的轨迹时临时顶上的数据源；关了面板就清掉（2026-11-04）。 */
    trajAlt: null,
    sessions: [],
    // 排队中的指令（[{ id, text, placement }]）。跑着任务时接着发的那几条排在这儿，
    // 由服务端每次取快照时从 agent 的收件箱现读，手机不自己记。
    queued: [],
    boundSessionId: null,
    connected: false,
    lastReplyStamp: 0,
    // 传好了、还没发出去的文件（[{ uploadId, name, bytes }]）。
    // 只存服务端发回来的那张小票，不存附件本身——真正的东西已经在电脑上了。
    uploads: [],
    // 正在流出来的那一段。空字符串 = 这会儿没有东西要显示。
    live: '',
    /**
     * 模型此刻的自言自语（鲸鱼娘的台词）：{ text, at } 或 null。
     *
     * **和 live 严格分开**：live 非空时整块 #work 会让位（那是「回答正在往外冒」的
     * 规矩），台词要是塞进 live，会出现「该说话的时候鲸鱼娘不见了」。
     * 它也不进 #reply——2026-09-22 用户否掉的就是「过程的文字跑进回答区」。
     */
    thought: null,
    // 服务端正去读这个会话的完整记录（点开一个插件没看过的会话时会有这一下）。
    historyLoading: false,
    // 「这份历史只到最近一段」（服务端读历史有上限时会给这一句）。
    historyTruncated: false,
    historyNote: '',
    /**
     * 执行轨迹（「完整」模式里的过程）：一组一轮，形状与服务端
     * `GET /mini/api/trajectory` 的 `turns` 一字不差
     * （`[{ turn, state, reason, entries:[…] }]`）。
     *
     * **它和 latest / history 是两回事**：思考正文只活在 `entries[].output` 里，
     * 回答气泡那两条路（`state.latest` / `state.history`）一个字都不碰它——
     * 这是 2026-09-27 用户定的边界（思维链一个字都不上气泡）。
     *
     * 只在「完整」模式订阅、只在那里画；切回单帧/聊天就退订，不再收也不再画。
     */
    trajectory: [],
    trajectoryNote: '',        // 「这份轨迹不是全部」时服务端给的那句话（展示下一棒接手）
    trajectoryTruncated: false,
    trajectoryLoading: false,  // 服务端还在读会话记录（**不等于「没有过程」**）
    trajectoryEpoch: '',       // 服务换了一代（重启）就不能再往旧的那份上面接
    trajectorySeq: 0,          // 收到第几帧，用来认出「我漏了几帧」（只进不退）
    trajectoryLive: '',        // 活片段：正在想的那一句（只有完整模式有值，落盘即清）
    // 斜杠指令的列表（在输入框里打 / 时弹出来的那个菜单）。
    // **按绑定的会话缓存**：指令表是每个会话一份的，而这个会话没在跑时服务端一条都
    // 读不到（回 ok:false + 一句话）。所以换了会话必须重取——否则用户点到的是上一个
    // 会话的指令，点下去必然被拒，而他从屏幕上完全看不出为什么。
    commands: null,        // null = 还没取到
    commandsError: '',     // 取不到时服务端给的那句话，原样显示给用户
    commandsFor: null,     // 上面这份数据是哪个会话的
    commandsLoading: false, // 正在取（挡住重复请求，见 loadCommands）
    /**
     * 「输入框里这一行曾经是一条指令」——点过面板/菜单里某一条之后，这里记着它的名字。
     *
     * 用来堵一个真缺口：点了一条要参数的指令，用户把 `/名字 ` 里的名字删掉、只留参数，
     * 那一行就不再以 `/` 开头，会被当成普通提问发给模型，白花一次额度。
     * 有这枚标记时，send() 会把这一行拦下来，让他补回名字或**清空输入框**（= 明确取消）。
     */
    pendingCommand: null
  };
  /**
   * 地址里那一枚令牌**只是入场那一下**（2026-10-16 第二步）。
   *
   * 服务端在上面那一次请求里已经把它换成了设备凭据（HttpOnly cookie，浏览器自己带），
   * 页面从此不读它、不存它、也不再往任何请求里放它。这里只做一件事：把地址栏擦干净，
   * 免得被截图/分享带出去。
   */
  if (params.get('token')) history.replaceState(null, '', location.pathname);

  /**
   * ---------------- 执行轨迹：订阅与收帧（数据层） ----------------
   *
   * 轨迹**不走全量快照**：实测它的正文是回答正文的 90.7 倍（单轮最高约 946KB），
   * 而 `event: state` 是「每条广播都发整份」。所以它走单独的增量帧
   * （`event: trajectory`，每帧只带新加的几条和改了的几笔），且**只有「完整」模式的
   * 连接才订**——不看这块的人一个字节都不付。
   *
   * 三件事一起看才完整：切到「完整」时订上并 GET 一次当前状态；切回单帧/聊天就退订；
   * 断线重连把 clientId 和 `?full=1` 带在流地址上（服务端自动重新订上），重连后再
   * GET 一次对齐——帧里的 epoch 变了就整个重拉。
   *
   * 本片到「收进 state.trajectory」为止；画法（三层折叠）在 renderFull 后面那一片。
   * clientId / subscribedClientId 两个连接身份变量声明在下面 SSE 一节里——
   * 那一节被测试整段抠出来跑，身份必须跟流地址待在一起才找得到。
   */

  /**
   * 这一帧该不该接、接到哪一组。三道门：
   * 不是「完整」模式不接（退订之后可能还有在路上的旧帧）；
   * 不是当前这个会话不接（切会话了，旧会话的过程与新会话无关）。
   * 没有这一组就立一个（turn 号是帧给的，组里 entries 往后只增不减）。
   */
  function trajectoryKeyOf(frame) {
    if (state.mode !== 'full') return null;
    if (frame.sessionId && state.boundSessionId && frame.sessionId !== state.boundSessionId) return null;
    var turn = typeof frame.turn === 'number' ? frame.turn : null;
    for (var i = 0; i < state.trajectory.length; i++) {
      if (state.trajectory[i].turn === turn) return state.trajectory[i];
    }
    var group = { turn: turn, state: 'running', reason: null, entries: [] };
    state.trajectory.push(group);
    return group;
  }

  /**
   * 把一条增量补丁贴到已有条目上。**只改补丁里真有的字段**——「停了」那种补丁不该
   * 顺手把输出清空；截断信息是合并而不是替换（一条工具步可能参数超长、结果也超长）。
   * 写法和 lib/trajectory.js 的 applyTrajectoryPatch 一致：两端对同一笔补丁的理解
   * 必须一样，否则手机上会出现「明明有结果却还写着正在跑」。
   */
  function patchTrajectoryEntry(entry, patch) {
    if (!entry || !patch) return;
    if (typeof patch.state === 'string') entry.state = patch.state;
    if (Object.prototype.hasOwnProperty.call(patch, 'output')) entry.output = patch.output;
    if (Object.prototype.hasOwnProperty.call(patch, 'error')) entry.error = patch.error;
    if (typeof patch.endedAt === 'number') entry.endedAt = patch.endedAt;
    if (patch.usage) entry.usage = patch.usage;
    if (typeof patch.model === 'string') entry.model = patch.model;
    if (typeof patch.provider === 'string') entry.provider = patch.provider;
    if (Array.isArray(patch.attachments) && patch.attachments.length) entry.attachments = patch.attachments;
    if (patch.truncated) {
      entry.truncated = Object.assign({}, entry.truncated || {}, patch.truncated);
    }
  }

  /**
   * 一帧的落法，四步按顺序走：
   *
   * 1. **换代认新**：帧里 epoch 和手里记的不一样（服务重启过），旧的那份整份作废，
   *    用 GET 重拉——旧代的 seq 在新代里毫无意义，硬拼会出现「凭空多出半截过程」。
   * 2. **缺帧认补**：帧的 seq 比预期大出不止一格，中间丢过帧，GET 重拉；
   *    seq 只进不退（重连后服务端可能从头再发一轮）。
   * 3. **add 幂等**：同一条目按 id 认——收过就改成补丁，没收过才追加。
   *    同一帧送两遍（重连重放）不会长出两份，这是「帧重复」的硬要求。
   * 4. **组态只进结论**：一组的 running 是过程中的默认值，收下任何结论态就不再
   *    被后面的 running 盖回去（结论到了之后又来一条旧的 running 帧，不算输）。
   */
  function applyTrajectoryFrame(frame) {
    if (!frame || typeof frame !== 'object') return false;
    var epoch = typeof frame.epoch === 'string' ? frame.epoch : '';
    if (state.trajectoryEpoch && epoch && epoch !== state.trajectoryEpoch) {
      state.trajectoryEpoch = epoch;
      state.trajectorySeq = 0;
      state.trajectory = [];
      if (state.mode === 'full') requestTrajectory();
      return false;
    }
    if (!state.trajectoryEpoch && epoch) state.trajectoryEpoch = epoch;
    var seq = typeof frame.seq === 'number' ? frame.seq : 0;
    if (seq > 0 && state.trajectorySeq > 0 && seq > state.trajectorySeq + 1) {
      state.trajectorySeq = seq;
      if (state.mode === 'full') requestTrajectory();
      return false;
    }
    if (seq > state.trajectorySeq) state.trajectorySeq = seq;

    var group = trajectoryKeyOf(frame);
    if (!group) return false;

    var add = Array.isArray(frame.add) ? frame.add : [];
    for (var i = 0; i < add.length; i++) {
      var raw = add[i];
      if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
      var hit = null;
      for (var j = 0; j < group.entries.length; j++) {
        if (group.entries[j].id === raw.id) { hit = group.entries[j]; break; }
      }
      if (hit) {
        patchTrajectoryEntry(hit, raw);
      } else {
        group.entries.push({
          id: raw.id,
          turn: typeof raw.turn === 'number' ? raw.turn : group.turn,
          step: raw.step,
          // 六种条目照单全收（think / say / tool / user / context / system）。
          // 类型由服务端给定，客户端不改写；主页面由 trajInlineEntries 白名单过滤。
          kind: raw.kind,
          name: raw.name,
          args: raw.args,
          summary: raw.summary,
          output: raw.output,
          state: typeof raw.state === 'string' ? raw.state : 'running',
          error: raw.error || null,
          truncated: raw.truncated || null,
          timestamp: raw.timestamp,
          // 计时四件套 + 用量分项/模型/附件：丢了它们，详情里就是空的。
          endedAt: raw.endedAt,
          ttft: raw.ttft,
          genMs: raw.genMs,
          tokens: raw.tokens,
          usage: raw.usage,
          model: raw.model,
          provider: raw.provider,
          attachments: raw.attachments,
        });
      }
    }
    // 真条目进来了：活片段让位（服务端也会喊清，这里兜一道——影子不许盖住落定的字）。
    if (add.length) {
      state.trajectoryLive = '';
      // **只有 think 条目时不要撤正文**（2026-10-22 真机）：
      // 思考落定不代表回答落定。最终回答那一步通常带 reasoning，落定时会先来一条
      // think 条目；原来这里见 add 就清 `state.live`，屏幕上的正文会先消失一下，
      // 等 reply 到了再整段出现——看起来就是「流了一下，内容没了，然后全文蹦出来」。
      // 旁白（say）和工具（tool）落定时才让位：那两样才是「过程结束了」的信号。
      var onlyThink = true;
      for (var ai = 0; ai < add.length; ai += 1) {
        if (!add[ai] || add[ai].kind !== 'think') { onlyThink = false; break; }
      }
      if (!onlyThink) {
        state.live = '';
        // 工具调用落定了（真条目已经进轨迹）：那半截参数该让位，否则标题行会一直挂着
        // 一条已经执行完的命令。
        state.liveTool = null;
      }
    }
    var upd = Array.isArray(frame.update) ? frame.update : [];
    for (var k = 0; k < upd.length; k++) {
      var patch = upd[k];
      if (!patch || typeof patch.id !== 'string') continue;
      for (var m = 0; m < group.entries.length; m++) {
        if (group.entries[m].id === patch.id) { patchTrajectoryEntry(group.entries[m], patch); break; }
      }
    }
    if (typeof frame.state === 'string' && frame.state !== 'running') {
      group.state = frame.state;
      group.reason = frame.reason || null;
    } else if (group.state === 'running') {
      if (frame.reason) group.reason = frame.reason;
    }
    return true;
  }

  /** 一帧到了：落进手里那份，只在「完整」模式下重画。 */
  function receiveTrajectoryFrame(frame) {
    if (!applyTrajectoryFrame(frame)) return;
    render();
  }

  /**
   * 用一份 GET 结果把手里那份**整个换掉**（不是往里合）：GET 是服务端按当前记录
   * 重新汇总的全量视图，比任何增量拼接都新，换掉就不会「补丁叠在过期底稿上」。
   * `loading` 如实收下——它说的是「还在读会话记录」，不是「没有过程」。
   */
  function setTrajectoryFromGet(view) {
    if (!view || view.ok !== true) return;
    state.trajectoryEpoch = typeof view.epoch === 'string' ? view.epoch : state.trajectoryEpoch;
    state.trajectorySeq = typeof view.seq === 'number' ? view.seq : 0;
    state.trajectory = Array.isArray(view.turns) ? view.turns : [];
    state.trajectoryTruncated = view.truncated === true;
    state.trajectoryNote = typeof view.note === 'string' && view.note ? view.note : '';
    state.trajectoryLoading = view.loading === true;
    render();
  }

  /**
   * 拉一次当前过程。只在「完整」模式发；不是完整模式宁可什么都不说——去要一份
   * 自己没订的数据，等于给服务端添一次白跑。读完只有两种岔路：是完整模式且还是
   * 同一个会话才收下（发请求后切了会话/切了模式，这份就是旧账，直接丢），
   * 读不到就把原因写出来，不说「没有过程」。
   */
  function requestTrajectory() {
    if (state.mode !== 'full' || !state.entered) return;
    var sessionId = state.boundSessionId;
    if (!sessionId) {
      state.trajectory = [];
      state.trajectorySeq = 0;
      state.trajectoryLoading = false;
      return;
    }
    state.trajectoryLoading = true;
    api('/mini/api/trajectory?sessionId=' + encodeURIComponent(sessionId))
      .then(function (view) {
        if (state.mode !== 'full' || state.boundSessionId !== sessionId) return;
        setTrajectoryFromGet(view);
      })
      .catch(function () {
        if (state.mode !== 'full' || state.boundSessionId !== sessionId) return;
        state.trajectoryLoading = false;
        state.trajectoryNote = '读不到这个会话的过程。';
        render();
      });
  }

  /**
   * 正文流式的订阅侧动作：**连接建早了/建晚了，就补一次重连。**
   *
   * 两个真会走到的岔口：
   *   ① 页面在「单帧」里打开（默认），之后切到「聊天 / 完整」——旧连接没带 `stream=1`，
   *      不重连就永远收不到正文帧（2026-10-22 真机复现：开关明明显示「开」，回答仍整段出现）；
   *   ② 开关本来就存着「开」，点它一下不会改值——原来的提前 return 把重连也一起跳过了。
   * 只有「想要的」和「连接上真带的」不一致才重连，避免每点一下都重来。
   */
  function syncStreamSubscription() {
    if (!state.entered) return;
    var want = state.streaming && state.mode !== 'minimal';
    if (want !== streamSubscribed) connect();
  }

  /**
   * 模式开关的订阅侧动作，跟着「显示模式」按钮走：
   *
   * - 切到「完整」：连流时没带 `?full=1`（连流那一刻不是完整模式）就得补一次
   *   POST 订上，然后 GET 一次把手里的换成当前状态；已经订过就只 GET 对齐。
   * - 切走：POST 退订，同时把身份清掉——服务端那条连接已经不再推了，
   *   手里这个「已订」的记号必须同步作废，否则下次切回来会误以为还订着。
   * - POST 回 404：这条流已经不在了（服务重启或断流没重连），立刻重连一次；
   *   重连的地址自带 `?full=1`（当前就是完整模式），服务端会重新把这条连接订上。
   *   重连成功与否都不用在这里补救——`open` 里那一套会再走一遍。
   */
  function syncTrajectorySubscription() {
    if (!state.entered) return;
    var want = state.mode === 'full';
    if (!want) {
      if (subscribedClientId) {
        var was = subscribedClientId;
        subscribedClientId = '';
        api('/mini/api/trajectory/subscribe', {
          method: 'POST',
          body: JSON.stringify({ clientId: was, on: false }),
        }).catch(function () { /* 断了就断了：服务端本来就会随连接清理 */ });
      }
      return;
    }
    if (subscribedClientId) {
      requestTrajectory();
      return;
    }
    api('/mini/api/trajectory/subscribe', {
      method: 'POST',
      body: JSON.stringify({ clientId: clientId, on: true }),
    }).then(function () {
      if (state.mode !== 'full') return; // 刚要订又切走了，回包当没看见
      subscribedClientId = clientId;
      requestTrajectory();
    }).catch(function (err) {
      if (err && err.status === 404) connect();
    });
  }

  var $ = function (id) { return document.getElementById(id); };
  var mainEl = $('main'), replyEl = $('reply'), inputEl = $('input');
  var dotEl = $('dot'), statusEl = $('status');

  // ---------------- 小工具 ----------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // 复制按钮的两个图标。做成常量而不是散在各处：以后换图标只改这一处。
  // 形状（两个重叠的方框）和配色都在 CSS 的 .copy 里，这里只管画线。
  var ICON_COPY = '<svg viewBox="0 0 16 16" aria-hidden="true">'
    + '<rect x="5.6" y="1.6" width="8.8" height="8.8" rx="2.2"/>'
    + '<rect x="1.6" y="5.6" width="8.8" height="8.8" rx="2.2"/></svg>';
  var ICON_DONE = '<svg viewBox="0 0 16 16" aria-hidden="true">'
    + '<path d="M2.6 8.4l3.6 3.6 7.2-7.2"/></svg>';
  function linkify(text) {
    return escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>';
    });
  }

  function copyText(text, btn) {
    // 点一下换成对勾，过 1.4 秒自己变回来。
    // 连点的时候要 clearTimeout：不然后一个定时器会被前一个提前触发，
    // 图标在对勾和复制之间闪，或者干脆卡在对勾上不回来。
    var done = function () {
      if (!btn) return;
      btn.classList.add('done');
      btn.innerHTML = ICON_DONE;
      clearTimeout(btn._doneTimer);
      btn._doneTimer = setTimeout(function () {
        btn.classList.remove('done');
        btn.innerHTML = ICON_COPY;
      }, 1400);
    };
    var fallback = function () {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done(); else toast('复制不了，长按选中文字手动复制');
      } catch (err) {
        toast('复制不了，长按选中文字手动复制');
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }
  function timeLabel(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }
  var toastTimer;
  /**
   * 图片没加载出来时要说一声。
   *
   * 手机页认三种图片地址：完整的 http(s) 网址、一个裸名字（页面拼成 /mini/art/<名字>.webp），
   * 或者一张图在电脑上的路径（绝对路径或相对项目根）。三种都认不出来、或者那个文件根本不在，
   * 浏览器只会画一个破图标——用户看到的是"图没了"，却不知道原因（2026-09-28 他为此来过三次）。
   *
   * 为什么挂**捕获**阶段：图片的 error 事件不冒泡，挂冒泡阶段一个也收不到。
   */
  document.addEventListener('error', function (e) {
    var el = e.target
    if (!el || el.tagName !== 'IMG' || !el.classList || !el.classList.contains('md-img')) return
    el.classList.add('md-img-bad')
    toast('这张图手机看不到：那个位置没有这张图，或者它不是 PNG/JPG/WEBP/GIF')
  }, true)

  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    // 普通提示**一定是纯字**：上一版如果带着「撤销」那颗按钮，这里要把它连同
    // with-act 一起收掉，否则会留下一个按了没反应的按钮（它的回调早就过期了）。
    el.classList.remove('with-act');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }

  /**
   * 带一个动作的提示。目前只有一处用：归档成功后的「撤销」。
   *
   * 为什么单独一个函数、而不是给 toast 加参数：普通提示是**纯字、点不中**的
   * （见 #toast 的 pointer-events），带动作就得反过来——两种形状差别够大，
   * 混在一个函数里迟早会让某一条普通提示也莫名其妙能点。
   *
   * 停留 6 秒：短于这个数，用户看到"归档了"再去找按钮就已经没了；长于这个数，
   * 它会一直压着输入区上方那块地方。
   */
  function toastAction(msg, label, onTap) {
    var el = $('toast');
    el.textContent = '';
    var text = document.createElement('span');
    text.textContent = msg;
    el.appendChild(text);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-act';
    btn.textContent = label;
    btn.addEventListener('click', function () {
      el.classList.remove('show');
      el.classList.remove('with-act');
      clearTimeout(toastTimer);
      onTap();
    });
    el.appendChild(btn);
    el.classList.add('with-act');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('show');
      // 收掉的时候把 with-act 一起收：光藏起来的话，那层透明的提示仍然接着点击。
      setTimeout(function () { el.classList.remove('with-act'); }, 220);
    }, 6000);
  }
  /**
   * 每一趟请求带什么头。
   *
   * **一个凭据都不带**（2026-10-16 第二步）：进门那一下服务端已经把身份换成了设备 cookie
   * （HttpOnly），浏览器自己会给同源的每一趟请求带上它——请求头和地址里从此不再出现令牌。
   * 这也是「名册里删掉那条记录 = 那台设备当场什么都做不了」能成立的前提。
   */
  function authHeaders(isJson) {
    return isJson === false ? {} : { 'Content-Type': 'application/json' };
  }
  function api(path, options) {
    var opts = options || {};
    // 传文件的时候**不能**写 Content-Type: application/json——那是给 JSON 用的。
    // 硬写上去，服务端收到的就是一个错的文件类型声明，而浏览器也没机会自己定。
    var raw = typeof Blob !== 'undefined' && (opts.body instanceof Blob
      || (typeof FormData !== 'undefined' && opts.body instanceof FormData));
    opts.headers = Object.assign(authHeaders(!raw), opts.headers || {});
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) {
          var err = new Error(body.error || ('HTTP ' + r.status));
          // 状态码挂在错上带出去：调用方要区分「服务端说这题已经结束了」（409）和
          // 「压根没连上」（fetch 直接抛）——靠中文字面去猜太脆。
          err.status = r.status;
          // 整个响应体也挂上。归档那条要**读里面的 activity**（会停掉哪些工作）才能
          // 弹确认框——只靠状态码看不出"还有工作在跑"和"工作区服务拿不到"的区别。
          err.body = body;
          throw err;
        }
        return body;
      });
    });
  }

  // ---------------- 声音与震动 ----------------
  var audioCtx = null;
  function unlockAudio() {
    try {
      if (!audioCtx) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      // 播放一个静音脉冲，iOS 要求真正出过声才算解锁。
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      g.gain.value = 0;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.01);
    } catch (e) { /* 不支持就算了，不影响主流程 */ }
  }
  function playDing() {
    if (!state.sound || !audioCtx || audioCtx.state !== 'running') return;
    try {
      var t = audioCtx.currentTime;
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(880, t);
      o.frequency.setValueAtTime(1180, t + 0.11);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.36);
    } catch (e) { /* 忽略 */ }
  }
  function buzz() {
    if (state.sound && navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }

  // ---------------- 「正在执行」的鲸鱼娘 ----------------
  // 这些姿态是**装饰性**的：插件按设计只收「用户指令 + 最终回复」，拿不到 Agent
  // 此刻在干什么，所以轮播不是进度播报，只是让等待有点人味。
  // 气泡里的话也守着这条线——说的是「还在忙」，不谎报「已完成 60%」。
  //
  // **还有一条更硬的规矩：不许报忧。** 用户正在等结果，这时候冒出「出错了」
  // 「不对劲」之类的话，他会当真。可这些话跟 Agent 实际状态毫无关系，纯粹是
  // 轮到第几张图。原来第 4 条写的「这里有点不对劲」就是这么个东西，2026-09-22
  // 被用户指着问「这一句有问题还是什么」，已改掉。测试钉着这条：见 page.test.mjs
  // 的「鲸鱼娘说的话里不许出现让人以为出事的字眼」。
  //
  // 每个姿势是一张「并排若干帧」的雪碧图，flip 是**走完一整圈翻帧**的秒数
  // （代码里它就是 animation-duration：两帧时每帧占 flip/2，六帧时每帧占 flip/6）：
  // 敲键盘和小跑要快，端着茶等和托腮想事情要慢。节奏跟着动作走，才不像机器在闪。
  var POSES = [
    { file: 'work-1-ready', line: '收到，这就去办', flip: 0.5 },
    { file: 'work-2-reading', line: '先翻翻资料', flip: 1.5 },
    { file: 'work-3-typing', line: '正在写…', flip: 0.34 },
    // 这一句原来是「这里有点不对劲」。**那是错的，而且是有害的**：轮播是装饰性的，
    // 轮到哪张图跟 Agent 实际在干什么毫无关系，可用户正在等结果，看到手机上写
    // 「不对劲」只会以为出事了。用户 2026-09-22 实机指着这条问「这一句有问题还是
    // 什么」，并指定改成「让我检查检查」——姿态叫 checking（核对），这句正好相称：
    // 只说自己在看，不下判断。
    { file: 'work-4-checking', line: '让我检查检查', flip: 1.2 },
    { file: 'work-5-thinking', line: '嗯…让我想想', flip: 1.7 },
    // 跑从 2026-09-28 起是 6 帧：先把两帧画出来的头发摆动收小（甩幅 155.3 → 70.6），
    // 再用 tools/whale-sway.py 把这一趟切成六帧（甩幅 74.9），身体逐像素不动。
    // 时长仍是 flip 秒、不乘帧数，所以腿脚换帧的快慢和两帧时一模一样，六帧只是把头发那一趟切得更细。
    { file: 'work-6-running', line: '跑一遍看看', flip: 0.4, frames: 6 },
    // 用户 2026-09-22 要的「跑步的动作」。它**不是第 8 个姿势，而是姿势之间的过渡**：
    // 序列是「姿势1 → 冲刺 → 姿势2 → 冲刺 → …」，表达「她干完一件、跑去干下一件」。
    // 所以它带 gap: true——不进轮播循环，只在每个姿势后面闪一下。
    // **停留时长改过一次方向**：原本刻意比姿势短（怕它「成了又一个姿势」），
    // 但用户两次要求拉长，现在 GAP_MS 和 POSE_MS 一样是 3.6 秒。理由见 GAP_MS 的注释。
    // 它和上面那张小跑**刻意画得不一样**：侧面视角、身体前倾、步子拉得更开。
    // **不带词条**（line 是空串）——用户指定的，冲刺是纯动作，硬配一句话反而弱。
    // 文件名里的 8 只是个名字，**顺序由数组决定**，别拿它当序号。 */
    // **帧数 6（2026-09-29）**：原来只有 2 帧，头发只能整个姿势硬切过去。2 帧的摆动
    // 没法"流畅"——两帧之间没有中间态。现在这 6 帧的头发是拿冻结基准帧当底、
    // 用位移场程序化算出来的（tools/whale-sway.py），身体逐像素不动：
    // 越靠发梢摆得越大、相位越滞后，采样一个周期得到 6 帧。摆幅默认 15 像素、
    // 相位滞后 300°，量出来的甩幅 128.9（用户给的目标区间 110~140）。
    // **它只解决头发**：身体和腿仍然是那两帧，跑起来腿脚还是瞬间换的。
    { file: 'work-8-sprinting', line: '', flip: 0.28, gap: true, frames: 6 },
    // 最后一个只在任务真的跑够久了才进轮播——到那时候说这句话才是实话。
    // **它必须留在最后**：posePool 用的是 POSES.length - 1，靠位置认它。
    { file: 'work-7-waiting', line: '还在忙，再等我一会儿', flip: 2.0 }
  ];
  var POSE_MS = 3600;
  /** 冲刺那张停多久。
   *
   *  用户同一天提了两次，方向一致：2026-09-22 上午「间隙跑步动画的持续时间太短了」，
   *  从 1.4 秒拉到 2.4 秒；同日下午又说「出现时间可以再久一些」，再拉到 3.6 秒，
   *  **和一个正常姿势一样长**。
   *
   *  原先这里写着「过渡就该快，跟姿势一样长的话它就成了又一个姿势」——那个顾虑
   *  被用户两次要求推翻了：他要的就是看清这个动作，而 2.4 秒（约 8 个跑步循环）
   *  看着还是「一闪而过」。既然他愿意为它多等，就别再按「过渡」对待它。
   *  代价是整圈轮播从 48 秒变 57.6 秒，「还在忙」那张（SLOW_MS = 60 秒）会在
   *  第二圈开头才轮得到——比原来晚十几秒，可接受。
   *
   *  再要调就调这一个数，别再动 flip：那是跑步循环的快慢，跟停留时长是两回事。 */
  var GAP_MS = 3600;
  var SLOW_MS = 60000;

  /**
   * 说话那张立绘。**它不进 POSES。**
   *
   * POSES 是轮播的节目单，进去就要占一格（还要连带改 posePool 那套按位置认「还在忙」
   * 的写法）。这张是**按需插播**的：只在宿主侧推来台词时出现，说完就回原来的顺序。
   * 文件名里的 9 同样只是个名字，跟顺序无关。
   */
  var SPEAK_POSE = { file: 'work-9-talking', flip: 1.1 };
  /**
   * 一句台词占多久：**按字数算**，短的有起步时长，长的封顶。
   *
   * 用户 2026-09-26 选的是「一直说到它结束（最多 10 秒）」；2026-09-27 他觉得太短，
   * 问能不能再久一点。原来是一律 10 秒——短句够用，可长句在 2026-09-27 起会**完整显示**
   * （不再截断），一句 200 字的话念 10 秒根本念不完，她就已经回去干别的了。
   *
   * 所以：起步 15 秒，每多一个字多留 0.15 秒（≈ 一分钟 400 字，手机上舒服的默读速度），
   * 30 秒封顶——封顶是为了防「某一轮她再没说话、画面却一直卡在说话那张」。
   * 宿主侧只拿得到**整段**（一步一步来的，不是逐字），所以「结束」得自己收尾：
   * 下一句台词来了就把表往后推，一直没有新的或这一轮结束了，就到点放回轮播。
   */
  var SPEAK_MIN_MS = 15000;
  var SPEAK_PER_CHAR_MS = 150;
  var SPEAK_MAX_MS = 30000;

  /** 这句话该占多久（见上面三条）。 */
  function speakDuration(text) {
    var n = String(text || '').length;
    return Math.min(SPEAK_MAX_MS, Math.max(SPEAK_MIN_MS, n * SPEAK_PER_CHAR_MS));
  }

  var reducedMotion = false;
  try { reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  var work = {
    startedAt: 0, pose: 0, poseTimer: null, tickTimer: null, layers: [],
    // 说话那张立绘单独一层（不在 POSES 里，见 SPEAK_POSE）。
    speakLayer: null,
    // 正在说的那句台词，以及它最晚说到什么时候。
    speakText: '',
    speakUntil: 0,
    // 已经念过的那句话的身份（宿主侧的 at）。快照来得很密，不认这个的话
    // 同一句话会被反复「重新开始说」，动画一直从头播。
    speakAt: null,
  };

  /** 现在该用哪几条姿态：跑够一分钟才把「还在忙」放进来。 */
  function posePool() {
    return Date.now() - work.startedAt >= SLOW_MS ? POSES.length : POSES.length - 1;
  }

  /**
   * 轮播的完整顺序：**每个姿势之间插一次冲刺**。
   *
   *   姿势1 → 冲刺 → 姿势2 → 冲刺 → 姿势3 → …
   *
   * 用户 2026-09-22 要的效果是「她在干活」：一个姿势带着词条出场，
   * 然后跑动的她横穿过去，再出现下一个姿势。所以冲刺（带 gap 的那些）
   * 自己不进这个循环——它只在间隙里出现，而且每次姿势后面都跟一次。
   *
   * 返回的是 POSES 的下标序列，长度随「跑了多久」变（前 60 秒不含「还在忙」）。
   */
  function poseSequence() {
    var n = posePool();
    var gaps = [];
    for (var g = 0; g < POSES.length; g += 1) {
      if (POSES[g].gap) gaps.push(g);
    }
    var out = [];
    for (var i = 0; i < n; i += 1) {
      if (POSES[i].gap) continue;
      out.push(i);
      for (var k = 0; k < gaps.length; k += 1) out.push(gaps[k]);
    }
    return out;
  }

  /**
   * 立绘地址。**不带令牌**（2026-10-16 第二步）：进门之后浏览器手里有设备 cookie，
   * 同源的 <img> 自己会带上它。指纹照旧——换了图浏览器不会一直用缓存那张。
   */
  function artUrl(file) {
    return '/mini/art/' + file + '.webp?v=' + encodeURIComponent(BUILD);
  }

  /**
   * 把一句话写进气泡。
   *
   * 走的是和回答区同一个行内渲染（`mdInline`，见上面那段 Markdown 渲染）。它的顺序是
   * **先转义、再上标签**：模型原话里的尖括号仍然只是字面上的尖括号，不会被当成标签；
   * 只有它自己写的 `**粗体**`、`` `代码` ``、链接才会变成样式。留一个口子给"以后不加"。
   *
   * 之前这里是 `textContent`（一句纯文本），于是 `**重启把连接掐断**` 连星号一起端到了
   * 用户面前（2026-09-27 用户报的）。词条那几种是我们自己写的、不含 markdown，也一起走
   * 这个入口——两条路各写各的，早晚会分叉。
   */
  function paintBubble(line) {
    var text = line || '';
    $('workBubble').hidden = !text;
    $('workBubble').innerHTML = mdInline(text);
  }

  function paintPose(index) {
    for (var i = 0; i < work.layers.length; i += 1) {
      work.layers[i].classList.toggle('on', i === index);
    }
    // 轮播回来时把说话那张收掉——它在 POSES 之外，不归上面那个循环管。
    if (work.speakLayer) work.speakLayer.classList.toggle('on', false);
    // 有的姿势不带词条（比如那张冲刺）：词条是空串就把整个气泡收起来。
    // 留一个空泡泡在那儿比不放气泡更怪——那个尖角还指着她的头，像话没说出来。
    // 收起气泡不会让立绘挪位：.work-top 有 min-width 兜着，行宽不变。
    paintBubble(POSES[index].line);
  }

  /**
   * 换成说话那张，把台词写进气泡。
   *
   * 台词是**模型的原话**（宿主机只从旁白里取，模型自己想的那些不上手机），
   * 所以这里只做一件事：原样写出来，不加不减——渲染的那一步交给 `paintBubble`。
   */
  function paintSpeak(text) {
    paintBubble(text);
    // 说话那张没加载出来时（预热那次报错翻过这个开关）：台词照说，**但不动图层**——
    // 把正常那几张全关掉、换上一张空的，她会当场从屏幕上消失（2026-09-27 立的闸）。
    if (work.speakReady === false) return;
    for (var i = 0; i < work.layers.length; i += 1) work.layers[i].classList.toggle('on', false);
    if (work.speakLayer) work.speakLayer.classList.toggle('on', true);
  }

  /**
   * 宿主侧送来的新台词要不要现在就说。
   *
   * 判据是 at（那句话的身份）：**同一句只说一次**。快照广播来得很密，每来一条就重说
   * 一遍的话，说话这张立绘会一直从头播，看着像卡住不动。
   */
  function maybeSpeak() {
    var t = state.thought;
    if (!t || !t.text) return;
    if (t.at === work.speakAt) return;
    work.speakAt = t.at;
    work.speakText = t.text;
    // 每来一句新的就从这一刻重新算：时长按这句话有多长来（见 speakDuration）。
    work.speakUntil = Date.now() + speakDuration(t.text);
    paintSpeak(t.text);
  }

  function elapsedLabel(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return '已 ' + s + ' 秒';
    return '已 ' + Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  }

  function tickElapsed() {
    $('workElapsed').textContent = elapsedLabel(Date.now() - work.startedAt);
  }

  /** 立绘在页面一打开就全部加载好——不然第一次「正在执行」会闪一下空白。 */
  function preloadPoses() {
    var stage = $('workStage');
    stage.innerHTML = '';
    work.layers = [];
    for (var i = 0; i < POSES.length; i += 1) {
      var layer = document.createElement('div');
      layer.className = 'pose';
      // 帧数决定显示宽度和用哪套关键帧（CSS 里 2 帧是默认，6 帧挂在 [data-frames="6"]）。
      // **时长不跟着帧数放大**：一圈还是 flip 秒，这样腿脚换帧的快慢跟以前一样。
      layer.setAttribute('data-frames', POSES[i].frames || 2);
      layer.style.backgroundImage = 'url("' + artUrl(POSES[i].file) + '")';
      layer.style.animationDuration = POSES[i].flip + 's';
      stage.appendChild(layer);
      work.layers.push(layer);
      // #work 是 hidden（display:none），浏览器**不会**为它下载背景图。
      // 所以这里得拿一个游离的 <img> 主动拉一次，否则第一次「正在执行」会先闪空白。
      var warm = document.createElement('img');
      warm.src = artUrl(POSES[i].file);
    }
    // 说话那张一起建好、一起预热：等台词来了再新建图层，会说第一个字之前先闪一下空白。
    var speak = document.createElement('div');
    speak.className = 'pose';
    speak.setAttribute('data-frames', SPEAK_POSE.frames || 2);
    speak.style.backgroundImage = 'url("' + artUrl(SPEAK_POSE.file) + '")';
    speak.style.animationDuration = SPEAK_POSE.flip + 's';
    stage.appendChild(speak);
    work.speakLayer = speak;
    var warmSpeak = document.createElement('img');
    // 说话那张要是加载不出来（图还没画好、或者网络半路断了）：**别把舞台清空**。
    // 默认按「图在」处理，只有真报错才翻成 false——正常路径一个字都不变；
    // 翻成 false 之后就退成「台词照说、人照轮播」，而不是她整个消失（见 paintSpeak）。
    warmSpeak.onerror = function () { work.speakReady = false; };
    warmSpeak.src = artUrl(SPEAK_POSE.file);
    paintPose(0);
  }

  /**
   * 轮播往前走一步，然后按**这一步是什么**决定下次隔多久。
   *
   * 原来是一个固定的 setInterval，每 3.6 秒换一张。现在冲刺要停得短，
   * 固定间隔就做不到——所以改成自己排下一次的 setTimeout。
   * 停止时 stopWork 会把待排的那一次清掉，不会漏跑。
   */
  function nextPose() {
    // 正在说话：这一格让给她，轮播停在这儿等（work.pose 不动，所以恢复时接着的那一格
    // 就是被打断的那一格，而不是从头来）。到点或来了新台词都由 maybeSpeak 管。
    if (work.speakUntil) {
      var left = work.speakUntil - Date.now();
      if (left > 0) {
        paintSpeak(work.speakText);
        // 睡到「该收尾的那一刻」为止，不多不少：按 3.6 秒一格睡的话，
        // 这个上限会被拖到整格之后，最后那句台词要多挂将近一秒。
        work.poseTimer = setTimeout(nextPose, Math.min(POSE_MS, left));
        return;
      }
      work.speakUntil = 0;
      work.speakText = '';
    }
    var seq = poseSequence();
    work.pose = (work.pose + 1) % seq.length;
    var index = seq[work.pose];
    paintPose(index);
    work.poseTimer = setTimeout(nextPose, POSES[index].gap ? GAP_MS : POSE_MS);
  }

  function startWork() {
    // 已经在跑就别重来。状态广播来得很密，每次重置的话姿态会永远卡在第一张。
    if (work.startedAt) return;
    work.startedAt = Date.now();
    work.pose = 0;
    paintPose(0);
    tickElapsed();
    work.tickTimer = setInterval(tickElapsed, 1000);
    if (reducedMotion) return;   // 关掉动画的人就停在一张上，秒数照常走
    work.poseTimer = setTimeout(nextPose, POSE_MS);
  }

  /** 停止请求的兜底计时器。放在 stopWork 前面，别靠 var 提升兜着。 */
  var stopTimer = null;

  function stopWork() {
    work.startedAt = 0;
    // 说话状态跟着收掉：这一轮的话已经说完了，下一轮不该接着上一句。
    // **但 speakAt 留着**——那是对「哪句话已经念过」的记忆，清掉的话，万一宿主侧
    // 还留着上一轮的台词（广播没到），新一轮一开场它就会被当成新话说一遍。
    work.speakUntil = 0;
    work.speakText = '';
    // 轮播现在是自己排下一次的 setTimeout（见 nextPose），用 clearInterval 清
    // setTimeout 在浏览器里也行，但写 clearTimeout 更不容易让人误会。
    if (work.poseTimer) { clearTimeout(work.poseTimer); work.poseTimer = null; }
    if (work.tickTimer) { clearInterval(work.tickTimer); work.tickTimer = null; }
    // 跑完了就把按钮复位，下一次「正在执行」才是干干净净的一个「停止」。
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    paintStop(false);
  }

  // ---------------- 停止 ----------------
  //
  // cancel() 在服务端只是**递个请求**，不是「等它停」——真正停下要等驱动收敛，
  // 到那时候服务端才把 running 翻成 false 推过来。所以按下去之后按钮自己禁用、
  // 改文案，等那个状态翻：既让人看见「按到了」，也防连按好几下。
  function paintStop(stopping) {
    var b = $('btnStop');
    b.disabled = stopping;
    b.textContent = stopping ? '正在停…' : '停止';
  }

  function requestStop() {
    var b = $('btnStop');
    if (!state.running || b.disabled) return;
    paintStop(true);
    api('/mini/api/stop', { method: 'POST', body: '{}' })
      .then(function () {
        // 正常情况：几百毫秒内 status 事件就到了，stopWork() 会把按钮复位。
        // 但万一那一刻连接正好断了，就会永远卡在「正在停…」——留个兜底，
        // 十秒还没翻就把按钮放回去，让人能再按一次，而不是干瞪眼。
        stopTimer = setTimeout(function () {
          stopTimer = null;
          if (state.running) {
            paintStop(false);
            toast('还没停下来。可以再按一次，或者到电脑上看看。');
          }
        }, 10000);
      })
      .catch(function (err) {
        paintStop(false);
        toast(err.message || '停止失败');
      });
  }

  $('btnStop').addEventListener('click', requestStop);

  /**
   * 把手机上答的题交回电脑，回一句实话。
   *
   * 回的是三种结果，不是一个「成没成」——因为两种失败要说不同的话：
   *   'ok'      电脑收下了；
   *   'late'    这题已经交回电脑了（插件回 409），得让用户去电脑上答；
   *   'failed'  压根没发出去（连不上），卡片留着，手一按还能再试。
   *
   * 原来那一段是按下就先把卡片收掉、发失败也咽着不说（当时的理由是「电脑那边等不到
   * 会自己还给浏览器」）。可电脑那边还在等着，手机上却静悄悄——用户看到的只有
   * 「我点了，没反应」（2026-09-27 用户报的正是这一幕）。所以这里只做一件事：
   * 把实情如实报出来，怎么显示由上面那张卡片决定。
   */
  function sendAnswer(id, answers) {
    return api('/mini/api/answer', {
      method: 'POST',
      body: JSON.stringify({ id: id, answers: answers }),
    })
      .then(function () { return 'ok'; })
      .catch(function (err) {
        return err && err.status === 409 ? 'late' : 'failed';
      });
  }


  /** 手机把审批结论交回电脑。三种结果和上面那条一样：成了 / 晚了 / 没送出去。 */
  function sendApproval(id, allow) {
    return api('/mini/api/approval', {
      method: 'POST',
      body: JSON.stringify({ id: id, decision: allow ? 'allow' : 'deny' }),
    })
      .then(function () { return 'ok'; })
      .catch(function (err) {
        return err && err.status === 409 ? 'late' : 'failed';
      });
  }
  // ---------------- 排队中的指令 ----------------
  //
  // 跑着任务时接着发的那几条不会丢，而是排进 agent 的收件箱（`followup()` 的语义
  // 就是「排队一个后续轮次」），等当前这一轮结束再跑。既然收下了，就必须让用户看见
  // 它排在哪——尤其单帧模式下，你发出去的那句话在别处**一个字都看不见**
  // （那一模式只显示回复），没有这块就等于「发出去了没反应」。
  //
  // 队列每次由服务端现读 agent 的收件箱，手机不自己记一份，所以不存在两边对不上。
  function paintQueue() {
    var el = $('queue');
    var list = (state.queued || []).filter(function (q) {
      if (!q) return false;
      // 同一个 id 已经出现在聊天记录里，说明它被取走了——两处都在时，记录说了算。
      var inHistory = (state.history || []).some(function (m) {
        return m && m.role === 'user' && m.id && q.id && m.id === q.id;
      });
      if (inHistory) return false;
      // 刚发出去的那一句：服务端会把它短暂算进收件箱，看着就像"自己排到自己后面"。
      var sent = state.lastSent;
      if (sent && sent.text && sent.text === q.text && Date.now() - sent.at < 15000) return false;
      return true;
    });
    // 刻度尺上第一个点永远是**正在跑的那条**，后面每个点对应一条真排在队里的指令。
    //
    // 2026-09-27 用户裁决：**队列是空的就整块收起来，不显示。**
    // 上一版这里是「只要在跑就留着」，理由是一个金点表示"你这一轮正是第 1 步"；
    // 用户实际看到的是「排队中 0 条」配一个孤零零的点，判定为噪音。撤销。
    // （上面那段注释里"哪怕只有一格，秩序也在"的说法同样作废。）
    // 队列一出现，聊天区就矮一截；正看着底部的人会觉得"页面跳上去了"。画完贴回去。
    var wasAtBottom = typeof mainEl !== 'undefined' && mainEl
      && mainEl.scrollHeight - mainEl.scrollTop - (mainEl.clientHeight || 0) < 48;
    var repin = function () {
      if (wasAtBottom && typeof mainEl !== 'undefined' && mainEl) mainEl.scrollTop = mainEl.scrollHeight;
    };
    if (!list.length) { el.hidden = true; el.innerHTML = ''; repin(); return; }
    el.hidden = false;
    // 最多画 12 个点：再长这条尺子就成噪点了，超出缀一个省略号。
    var nodes = '<div class="q-node cur"><i></i><b>1</b></div>';
    var shown = Math.min(list.length, 11);
    for (var n = 0; n < shown; n += 1) {
      nodes += '<div class="q-node"><i></i><b>' + (n + 2) + '</b></div>';
    }
    if (list.length > shown) nodes += '<div class="q-node"><i></i><b>…</b></div>';
    var rows = '';
    for (var i = 0; i < list.length; i += 1) {
      // 插话和排队**要分得出来**（2026-10-06）：服务端每条都带 placement，
      // `next-step` 是插话（下一个步骤边界就取走，通常几秒），
      // `next-turn` 是排队（等这一轮跑完，可能几分钟）。原来两条画得一模一样。
      var isSteer = list[i].placement === 'next-step';
      rows += '<div class="q-row">'
        + (isSteer ? '<span class="q-tag">插话</span>' : '')
        + '<span class="q-text">' + escapeHtml(list[i].text) + '</span>'
        + '<button class="q-drop" type="button" data-drop="' + escapeHtml(list[i].id) + '"'
        + ' aria-label="撤掉这条"><svg viewBox="0 0 24 24" aria-hidden="true">'
        + '<path d="M6 6l12 12M18 6L6 18"/></svg></button></div>';
    }
    // 标题得跟着实际内容说：**只要有一条插话，「跑完这轮就轮到它们」就是假话**。
    // 三种情况各说各的，不糊一句通用的。
    var steerCount = 0;
    for (var k = 0; k < list.length; k += 1) {
      if (list[k].placement === 'next-step') steerCount += 1;
    }
    var waitCount = list.length - steerCount;
    var head = steerCount && waitCount
      ? '插话 ' + steerCount + ' 条（下一步就看到） · 排队 ' + waitCount + ' 条'
      : steerCount
        ? '插话 ' + steerCount + ' 条 · 它下一步就看到'
        : '排队中 ' + list.length + ' 条 · 跑完这轮就轮到它们';
    el.innerHTML = '<div class="q-head">' + head + '</div>'
      + '<div class="q-scale">' + nodes + '</div>' + rows;
    repin();
  }

  /**
   * 撤掉一条还在排队的指令。
   *
   * 撤不掉是正常情况之一：手机上这份队列是上一次推送时的样子，这中间它完全可能
   * 已经轮到自己开始跑了。那时候服务端会说「撤不回来了」，这里如实转达，
   * 并且刷新一次，让界面跟上真实状态——不能假装撤掉了。
   */
  function requestUnqueue(id) {
    // 成功失败都由服务端推一份最新的队列过来（失败时也要推——见 onUnqueue 的说明），
    // 所以这里不用自己去拉，只需要把失败原因转达给用户。
    api('/mini/api/unqueue', { method: 'POST', body: JSON.stringify({ id: id }) })
      .catch(function (err) { toast(err.message || '撤不回来'); });
  }

  $('queue').addEventListener('click', function (e) {
    // **必须从被点的元素往上找到那个真按钮。** ✗ 是画在按钮里面的 SVG 图形，手指落上去
    // 时 e.target 是图形本身，读不到按钮身上的编号。用户 2026-09-28 实机报「排队框的 ✗
    // 点了没反应」就是这么来的：旧写法 `e.target.getAttribute('data-drop')` 拿到 null，
    // 然后静默什么都不做。按钮只有 24×24、图形 12×12，所以旧写法几乎必然踩中。
    var hit = e.target && e.target.closest ? e.target.closest('.q-drop') : null;
    var id = hit ? hit.getAttribute('data-drop') : null;
    if (id) { requestUnqueue(id); return; }
    // 找到了按钮却没有编号：这是代码毛病。说一声，别静默——静默失败是最难查的那一类。
    if (hit) toast('这条撤不了：没带上编号');
  });

  /** 让「正在执行」那块跟着 state.running 显隐。 */
  /** 下一帧再贴一次底：刚露出来的内容要等布局落定，才知道真正的底部在哪。 */
  function stickBottomSoon() {
    var run = function () { mainEl.scrollTop = mainEl.scrollHeight; };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function paintWork() {
    var el = $('work');
    var queued = (state.queued || []).length;
    // 队列也算「还有活儿」。正常情况到不了「闲着但队列非空」（followup 总会唤醒驱动），
    // 但停掉当前这一轮之后、队列还没接上的那一小段就是这种状态——
    // 那块东西不该先消失一下再冒出来。
    //
    // 但**正在流式写回答的时候要收起来**：回答本身已经在屏幕上长出来了，
    // 底下再挂一只鲸鱼娘就是重复——用户要看的字正在往上冒，那块既占地方又抢注意力。
    // 用户 2026-09-22 实机提的：「内容开始流式生成的时候，鲸鱼娘的动画就可以消失了」。
    // 注意这里用 state.live 判断，不是「有没有在跑」——跑着但还没到吐字那一步
    // （比如正在调工具）时，鲸鱼娘还是要留着，那是它唯一该出现的时候。
    var busy = (state.running || queued > 0) && !state.live;
    // 「已 N 秒 / 停止」那一行重新露出来时，页面会凭空长高一截——只把 scrollTop
    // 设到当时的底部还不够，那一行就卡在视野外（2026-11-03 用户报的「不是真正贴底」）。
    // 露出来前人在底部（或刚发过指令），露出来之后补一次贴底。
    // `typeof` 那道判断是给切片测试用的：鲸鱼娘那组测试只抠了 paintWork，没有这两个函数。
    var wasHidden = el.hidden;
    var followBottom = typeof atBottom === 'function' ? atBottom() : true;
    el.hidden = !busy;
    if (busy) {
      startWork();
      // 台词每次随快照重算一遍。**必须放在 startWork 之后**：startWork 会先画第 0 张，
      // 反过来的话它会把这句台词盖掉，用户看到的是「收到，这就去办」而不是她的自说自话。
      maybeSpeak();
      if (wasHidden && (followBottom || state.scrollSentMessage)
        && typeof stickBottomSoon === 'function') stickBottomSoon();
    } else stopWork();
    paintQueue();
  }

