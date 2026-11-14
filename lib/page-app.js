  // ---------------- 语音输入：已移除 ----------------
  //
  // 输入框旁边原来有个 🎤，走的是浏览器的 SpeechRecognition。它在手机上**用不了**：
  // 浏览器把语音识别和 getUserMedia 一样限制在安全上下文里，而本插件三条连接路径
  // （内网 / Tailscale / 隧道未开）全是明文 http://。依据见 W3C bug 30176：
  // https://www.w3.org/Bugs/Public/show_bug.cgi?id=30176
  //
  // 更糟的是浏览器把这种情况报成 `not-allowed`，和「用户拒绝了权限」同一个错误码，
  // 于是用户看到的是「麦克风权限被拒绝」，去浏览器设置里翻也找不到能改的东西。
  //
  // 2026-09-21 用户裁决：**拿掉这个图标**。留着按了没用，比没有更糟。
  // 想用说的，用手机键盘自带的 🎤 听写键——不挑连接、不要权限，设置里也写了这一句。
  // 别把它加回来，除非先有了一条受信任的 https 路径（比如开了证书的 tailscale serve）。

  // ---------------- 设置 ----------------
  var sheet = $('settings');
  $('btnSettings').addEventListener('click', function () {
    sheet.classList.add('open');
    $('connHint').textContent = state.connected ? '已连接' : '未连接';
    // 权限档位那块也在这儿重读一次：它显示的是「现在在哪一档」的实时状态（电脑端
    // 随时能改），而且启动时那一次要是没读成，不重读就整块再也不出现。
    loadPermissions(state.boundSessionId);
    // 版本号那行也现读一次：它只在设置页里看得见，没必要开机就为它跑一趟。
    // （watchBuild 是同一个 script 块里的函数声明，这里调得到。）
    watchBuild();
    // 繁忙时的发送行为也现读一次：**电脑上随时能改**，开机读那一次会过期。
    loadBusyEnter();
    // 进阶设置（电脑端界面）同样现读。它还会被电脑端从小标签关掉——
    // 手机上那份状态不能一直停在「开着」。
    loadMirror();
  });
  $('btnClose').addEventListener('click', function () { sheet.classList.remove('open'); });
  // 顶部吸顶那个关闭口（2026-10-05 设置页改整屏时加的）。
  $('btnSettingsClose').addEventListener('click', function () { sheet.classList.remove('open'); });
  sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.classList.remove('open'); });

  // ---------------- 子智能体 ----------------
  //
  // 数据全从 /mini/api/subagents 那三条来（见 lib/server.js）。三条都在电脑上的
  // **同一个进程里直接问 DSH**，不经过 WebSocket——靠进程里这层关系拿到的东西
  // （清单、某一道自己的运行记录）反而比桌面前端更直接：桌面那边只能隔着一条
  // 只开了两个口子的线路，清单和记录得靠投影另推一份过来。
  //
  // 两条纪律，和主会话一模一样：**读不到就说读不到，不编**；**数字算不出来就空着**。
  var saPanel = $('subagents');
  var saRows = [];        // 最近一次读到的清单，点行时按 id 找回来
  var saCurrent = null;   // 正在看运行记录的那一道；null = 现在在看清单
  var saCache = null;
  var saCacheSession = null;
  var saCacheAt = 0;
  var saInflight = null;
  var SA_CACHE_TTL = 5000;

  var saDocBody = null, saDocTurns = [], saGroupOpen = {}, saEntryOpen = {};
  function saToList() {
    saCurrent = null; saDocBody = null; saDocTurns = [];
    saPanel.classList.remove('doc-open');
    $('subagentsDoc').hidden = true; $('subagentsList').hidden = false; $('subagentsBack').hidden = true;
    $('subagentsStatus').hidden = true; $('subagentsTitle').textContent = '子智能体';
  }
  function saToDoc(row) {
    saCurrent = row; saDocBody = null; saDocTurns = []; saGroupOpen = {}; saEntryOpen = {};
    saPanel.classList.add('doc-open');
    $('subagentsList').hidden = true; $('subagentsDoc').hidden = false; $('subagentsBack').hidden = false;
    $('subagentsStatus').hidden = false; $('subagentsTitle').textContent = row.label || shortSessionId(row.id);
    $('subagentsStatus').textContent = (row.running ? 'running' : '已结束') + ' · 只读';
  }

  /** 用量（token 数）。读不到就是 null，页面上写「—」——写 0 会被读成「一次都没跑过」。 */
  function saTokens(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—';
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(1) + 'k';
    return (n / 1000000).toFixed(1) + 'M';
  }
  /** 耗时。同样：读不到写「—」。 */
  function saDuration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
    return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
  }
  /** 目录读不动的那三种原因，翻成人话。认不出来就照原样说，不编一个像样的理由。 */
  function saReason(r) {
    if (r === 'corrupt') return '那一支的目录坏了';
    if (r === 'unsupported') return '那条记录是更新的格式，这个版本读不了';
    return '那一支暂时读不到（' + r + '）';
  }

  function saRowHtml(s) {
    // 有一支目录读不动：DSH 会以一行「诊断」如实说原因。这里也如实转达，
    // 不假装那一支里没有人——吞掉的表现是「明明有子代理却一个都不显示」。
    if (s.diagnostic) {
      return '<div class="sa-row sa-plain"><span class="dot err"></span>'
        + '<span class="sa-main"><span class="sa-name">有一支读不出来</span>'
        + '<span class="sa-sub">' + escapeHtml(saReason(s.diagnostic)) + '</span></span></div>';
    }
    // 状态点用既有 .dot，和顶栏那颗同一套：在跑 = run；没在跑但最近跑完过 = ok；
    // 其余 = 灰。**没有动画**——那圈呼吸闪动在规格里已经被砍掉了（见 .dot 的注释）。
    var dot = s.running ? 'dot run' : (s.lastTurnCompleted ? 'dot ok' : 'dot');
    var kind = s.mode === 'continuable' ? '可续接' : '一次性';
    return '<button class="sa-row" type="button" data-sa="' + escapeHtml(s.id) + '">'
      + '<span class="' + dot + '"></span>'
      + '<span class="sa-main"><span class="sa-name">' + escapeHtml(s.label || shortSessionId(s.id)) + '</span>'
      + '<span class="sa-sub">' + kind + ' · ' + (s.running ? '在跑' : '已结束') + '</span></span>'
      + '<span class="sa-num">' + saTokens(s.tokens) + '<br>' + saDuration(s.durationMs) + '</span>'
      + '</button>';
  }

  function saRenderList(body) {
    var listEl = $('subagentsList');
    // 这两句空态都落在 .sa-list 里，而那个容器用负 16px 把内容拽到贴屏边
    // （为了让分隔线横贯整屏）——所以得补上 sa-none-indent 把 16px 加回来，
    // 否则这行字会顶到屏幕最左边。这个类是早就写好的，之前没给空态用上。
    if (!body || !body.ok) {
      listEl.innerHTML = '<div class="sa-none sa-none-indent">'
        + escapeHtml((body && body.error) || '读不到子智能体。') + '</div>';
      return;
    }
    saRows = body.subagents || [];
    if (!saRows.length) {
      listEl.innerHTML = '<div class="sa-none sa-none-indent">这个会话还没有派出过子智能体。</div>';
      return;
    }
    listEl.innerHTML = saRows.map(saRowHtml).join('');
    var btns = listEl.querySelectorAll('[data-sa]');
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () { saOpenDoc(btn.getAttribute('data-sa')); });
      })(btns[i]);
    }
  }

  function saLoad(force) {
    var sessionId = state.boundSessionId || '';
    if (!force && saCache && saCacheSession === sessionId && Date.now() - saCacheAt < SA_CACHE_TTL) {
      saRenderList(saCache);
      return;
    }
    if (!force && saInflight && saInflight.sessionId === sessionId) return;
    $('subagentsList').innerHTML = '<div class="sa-none sa-none-indent">正在读取…</div>';
    var request = api('/mini/api/subagents');
    saInflight = { sessionId: sessionId, request: request };
    request.then(function (body) {
      if (state.boundSessionId === sessionId && body && body.ok) {
        saCache = body;
        saCacheSession = sessionId;
        saCacheAt = Date.now();
      }
      saRenderList(body);
    }).catch(function (err) {
      $('subagentsList').innerHTML = '<div class="sa-none sa-none-indent">'
        + escapeHtml(err && err.message || '没读出来。') + '</div>';
    }).finally(function () {
      if (saInflight && saInflight.request === request) saInflight = null;
    });
  }

  // 连接后趁页面空闲预取当前会话的子代理清单。首次读取可能很慢，不能把这段等待
  // 放到用户点入口之后；入口点击时会复用 saInflight，和导航工作区同一套策略。
  function prefetchSubagents() {
    var sessionId = state.boundSessionId || '';
    if (!sessionId || saCacheSession === sessionId || saInflight) return;
    var request = api('/mini/api/subagents');
    saInflight = { sessionId: sessionId, request: request };
    request.then(function (body) {
      if (state.boundSessionId !== sessionId || !body || !body.ok) return;
      saCache = body;
      saCacheSession = sessionId;
      saCacheAt = Date.now();
      if (saPanel.classList.contains('open') && !saCurrent) saRenderList(body);
    }).catch(function () {
      // 预取失败不影响入口；用户点开时仍会重试。
    }).finally(function () {
      if (saInflight && saInflight.request === request) saInflight = null;
    });
  }

  function saOpenDoc(childId) {
    var row = null;
    for (var i = 0; i < saRows.length; i++) if (saRows[i].id === childId) row = saRows[i];
    if (!row) return; saToDoc(row);
    $('subagentsDoc').innerHTML = '<div class="sa-none">正在读取它的会话…</div>';
    // 各自接住失败，Promise.all 才会等两边都结束；失败时绝不画半页。
    var load = function (path) { return api(path).then(function (body) { return body; }, function (err) { return { ok: false, error: err && err.message || '没读出来。' }; }); };
    var id = encodeURIComponent(childId);
    Promise.all([load('/mini/api/subagent?id=' + id), load('/mini/api/subagent-trajectory?childId=' + id)]).then(function (rs) {
      if (saCurrent !== row) return;
      var a = rs[0], b = rs[1], errors = [];
      if (!a || a.ok !== true) errors.push('对话：' + ((a && a.error) || '没读出来。'));
      if (!b || b.ok !== true || !Array.isArray(b.turns)) errors.push('轨迹：' + ((b && b.error) || '没读出来。'));
      if (errors.length) { $('subagentsDoc').innerHTML = '<div class="sa-none">' + escapeHtml(errors.join('；')) + '</div>'; return; }
      saRenderDoc(a, b.turns);
    });
  }

  /** 运行记录里的一条。长相和主会话**完全一样**：气泡/正文/指令行/完工卡片共用同一批样式。 */
  function saEntryHtml(e) {
    if (e.role === 'notice') return noticeBlock(e);
    if (e.role === 'command') return commandBlock(e);
    if (e.role === 'user') {
      return '<div class="bubble user">' + escapeHtml(e.text || '')
        + '<span class="meta">' + timeLabel(e.timestamp) + '</span></div>';
    }
    return '<div class="said"><div class="md">' + mdToHtml(e.text || '') + '</div>'
      + '<div class="reply-foot"><span class="time">' + timeLabel(e.timestamp) + '</span></div></div>';
  }

  // 子智能体自己的折叠开关只在画它的时候借用，绝不污染主会话那一份。
  function saWithTraj(fn) {
    var groups = trajGroupOpen, entries = trajEntryOpen;
    trajGroupOpen = saGroupOpen; trajEntryOpen = saEntryOpen;
    try { return fn(); } finally { trajGroupOpen = groups; trajEntryOpen = entries; }
  }

  /** 一轮里照主会话页的顺序：指令 → 过程 → 回答；没轮次的排最后（2026-11-05）。 */
  function saTimelineHtml(entries, groups) {
    var turnOf = function (v) { return typeof v === 'number' && isFinite(v) ? v : Number.MAX_SAFE_INTEGER; };
    var blocks = [];
    (entries || []).forEach(function (e, i) {
      e = e || {};
      blocks.push({ turn: turnOf(e.turn), phase: e.role === 'user' ? 0 : 2, i: i, html: saEntryHtml(e) });
    });
    (groups || []).forEach(function (g, i) {
      g = g || {};
      blocks.push({ turn: turnOf(g.turn), phase: 1, i: i, html: saWithTraj(function () { return trajGroupHtml(g); }) });
    });
    blocks.sort(function (a, b) { return a.turn - b.turn || a.phase - b.phase || a.i - b.i; });
    return blocks.map(function (b) { return b.html; }).join('');
  }

  function saRenderDoc(body, turns) {
    var docEl = $('subagentsDoc');
    saDocBody = body; saDocTurns = turns || [];
    $('subagentsStatus').textContent = (body.running ? 'running' : '已结束') + ' · 只读';
    var entries = body.entries || [], html = '';
    if (body.reclaimed) {
      html += '<div class="sa-none">它的运行记录已经不在电脑上了，只能看到它当时发回来的那条完工通知。</div>';
    } else if (!entries.length && !saDocTurns.length) html += '<div class="sa-none">它还没有任何记录。</div>';
    if (body.truncated) html += '<div class="history-note">' + escapeHtml(body.note || '只显示最近一段。') + '</div>';
    html += saTimelineHtml(entries, saDocTurns);
    // 操作区在正文末尾（只读记录本身不提供编辑入口）。
    html += body.mode === 'continuable' ? saActsHtml(body)
      : '<div class="sa-none">这是一次性子智能体：跑完就结束了，接不了话，'
        + '只能看它跑过什么。</div>';
    docEl.innerHTML = html;
    saBindActs(body);
  }

  function saActsHtml(body) {
    var html = '';
    // 停：只对「正在跑的、可续接的」那一轮有意义。已经停稳的子智能体没有可停的东西。
    if (body.running) {
      html += '<div class="sa-acts"><button class="btn" id="saStop">停止这一轮</button></div>';
    }
    // 继续说话：只有「可续接」才有；拒绝理由由服务端翻成人话。
    html += '<div class="sa-ask">'
      + '<input id="saAskText" type="text" placeholder="跟它说一句…" autocomplete="off"'
      + ' autocapitalize="off" autocorrect="off" spellcheck="false">'
      + '<button class="btn primary" id="saSend">发送</button></div>';
    return html;
  }

  function saBindActs(body) {
    var stop = $('saStop');
    if (stop) stop.addEventListener('click', function () { saStop(body, stop); });
    var send = $('saSend');
    if (send) send.addEventListener('click', function () { saAsk(body, send); });
  }

  function saStop(body, btn) {
    btn.disabled = true;
    api('/mini/api/subagent/stop', {
      method: 'POST',
      body: JSON.stringify({ id: body.id, mode: body.mode }),
    }).then(function () {
      // 递进去不等于停稳（和主会话那条一样）：重读一次，等它的状态自己翻过来。
      toast('已经让它停下这一轮。');
      saOpenDoc(body.id);
    }).catch(function (err) {
      toast(err && err.message || '停不下来。');
      btn.disabled = false;
    });
  }

  function saAsk(body, btn) {
    var input = $('saAskText');
    var text = input ? input.value.trim() : '';
    if (!text) { toast('先说点什么。'); return; }
    btn.disabled = true;
    api('/mini/api/subagent/ask', {
      method: 'POST',
      body: JSON.stringify({ id: body.id, mode: body.mode, text: text }),
    }).then(function () {
      toast('已经递过去了。');
      saOpenDoc(body.id);
    }).catch(function (err) {
      toast(err && err.message || '没送出去。');
      btn.disabled = false;
    });
  }

  $('btnSubagents').addEventListener('click', function () {
    saToList();
    saPanel.classList.add('open');
    saLoad();
  });
  $('subagentsClose').addEventListener('click', function () { saPanel.classList.remove('open'); });

  // ---------------- 插件页面（2026-10-04） ----------------
  // 从设置里点「插件」→ 立刻盖到设置上面（#plugins 的 z-index 比 #settings 高一档）；
  // 关掉它就回到设置，不用退出设置再去找。分层和两条留白见上面 #plugins 那段 CSS。
  var pluginsPanel = $('plugins');
  $('btnPlugins').addEventListener('click', function () {
    pluginsPanel.classList.add('open');
    loadPlugins();
  });
  $('pluginsClose').addEventListener('click', function () { pluginsPanel.classList.remove('open'); });
  // 点浮层空白处也关掉（和子智能体面板同一套）。
  pluginsPanel.addEventListener('click', function (e) {
    if (e.target === pluginsPanel) pluginsPanel.classList.remove('open');
  });

  function loadPlugins() {
    var listEl = $('pluginsList');
    listEl.innerHTML = pluginNote('正在读取插件列表…');
    api('/mini/api/plugins').then(function (r) {
      listEl.innerHTML = renderPlugins(r || {});
    }).catch(function (err) {
      listEl.innerHTML = pluginNote('读不到插件列表：' + escapeHtml(err.message || '出错了'), true);
    });
  }

  /**
   * 三块，和 PC 的「插件」页 + 「内置插件」页对齐：
   *
   *   官方          —— 能装还没装的（npm 包那一层）
   *   已安装 · 内置 —— **Cordis Loader 的实时条目表**，分「全局插件」和「会话插件」。
   *                    这才是 DSH 的本体粒度：一整套系统是几百个插件模块拼起来的。
   *                    （2026-10-04 用户指出：内置插件拿 npm 包充数是不对的，那只有几个。）
   *   已安装 · 第三方 —— 用户自己装的包。DSH 自家的包不在这里列——它们在上面
   *                    以「模块」的身份出现，那才是「一切皆插件」该有的样子。
   */
  function renderPlugins(r) {
    var bundles = r.bundles || [];
    var official = bundles.filter(function (b) { return b.optional && !b.installed; });
    var third = bundles.filter(function (b) {
      return b.installed && b.name.indexOf('@deepseek-ai/') !== 0;
    });
    var entries = r.entries || [];
    var presets = r.presets || [];
    var sessionRows = 0;
    presets.forEach(function (p) { sessionRows += (p.rows || []).length; });

    var html = '';
    if (r.bundlesError) html += pluginNote('包清单读不到：' + escapeHtml(r.bundlesError), true);
    if (r.officialError) html += pluginNote('官方卡片读不到：' + escapeHtml(r.officialError), true);
    // 官方那一栏是两样拼的（PC 也是这个次序）：可开关的官方包在前，
    // 注册了设置卡片的官方插件（终端 / Agent 循环 / 子智能体 / 网页搜索）在后。
    html += pluginGroup('官方', official.concat(r.official || []), officialRow);

    if (r.builtinError) {
      html += pluginNote('内置插件读不到：' + escapeHtml(r.builtinError), true);
    } else {
      // 内置这一层自己也是一个可折的分组，里面再套「全局插件」「会话插件」两层。
      var inner = '';
      if (entries.length) inner += pluginGroup('全局插件', entries, invRow, 2);
      if (sessionRows) {
        // 这一层的数目是**四个预设各自行数之和**：同一个插件被好几个预设都带上，
        // 所以会重复计（实测共 95 行、其实只有 32 个不重复的插件）。
        // 这里**不再拿括号去解释**（2026-10-05 用户要那句去掉）——下面每个预设
        // 各报各的数（29/30/6/30），加起来就是这个数，顺着看下去就能对上。
        var sessionInner = '';
        presets.forEach(function (p) {
          var rows = p.rows || [];
          if (!rows.length) return;
          if (p.broken) sessionInner += pluginNote('这个预设的组合读不出来：' + escapeHtml(p.broken), true);
          var body = rows.map(invRow).join('');
          // 只有一个预设就不必再套一层；多预设才把预设名露出来（PC 那边是个下拉）。
          // 「（默认）」照 PC 标上：它说的是「不指定模式时按它来」，用户得有这个参照。
          sessionInner += presets.length > 1
            ? pluginFold(p.name + (p.isDefault ? '（默认）' : ''), rows.length, body, 2)
            : body;
        });
        inner += pluginFold('会话插件', sessionRows, sessionInner, 2);
      }
      html += inner
        ? pluginFold('已安装 · 内置', entries.length + sessionRows, inner, 1)
        : pluginNote('这台电脑没报出内置插件。');
    }

    html += pluginGroup('已安装 · 第三方', third, bundleRow);
    if (!html) html = pluginNote('没有插件。');
    return html;
  }

  function pluginNote(text, isErr) {
    return '<div class="' + (isErr ? 'plugin-note' : 'sa-none sa-none-indent') + '">' + text + '</div>';
  }

  /**
   * 一层**可折叠**的分组。默认收起——HTML 里不写 open 属性就自然是收着的，
   * 「默认折叠」不需要额外的代码去保证。没有正文的空层整个不画（点开是个空壳没意义）。
   *
   * `depth` 只影响字号轻重（1 = 官方 / 已安装那一级，2 = 里面那两级）。
   * `note` 是接在计数后面的小注（比如「32 个不重复，4 个预设各算各的」）。
   */
  function pluginFold(title, count, bodyHtml, depth, note) {
    if (!bodyHtml) return '';
    return '<details class="plugin-fold depth-' + (depth || 1) + '"><summary>'
      + escapeHtml(title) + ' ' + count + (note ? '（' + escapeHtml(note) + '）' : '')
      + '</summary>' + bodyHtml + '</details>';
  }

  /** 一堆插件：可折的一层。空的那堆整个不画（不占地方、也不说假话）。 */
  function pluginGroup(title, rows, rowFn, depth) {
    if (!rows.length) return '';
    return pluginFold(title, rows.length, rows.map(rowFn).join(''), depth);
  }

  function rowHtml(name, desc, badge, descCls) {
    return '<div class="plugin-row">'
      + '<div class="plugin-info">'
      + '<span class="plugin-name">' + escapeHtml(name) + '</span>'
      + (desc ? '<span class="plugin-desc' + (descCls || '') + '">' + escapeHtml(desc) + '</span>' : '')
      + '</div>'
      + (badge ? '<span class="plugin-badge ' + badge[0] + '">' + escapeHtml(badge[1]) + '</span>' : '')
      + '</div>';
  }

  /**
   * 一行「包」（官方 / 第三方）。显示名用服务端给的 `title`（本地化标题），
   * 没有就是包名——官方插件在 PC 上显示的正是「智能体团队」这类中文名。
   */
  function bundleRow(b) {
    var desc = b.description || '';
    if (b.problem) desc = desc ? desc + ' · ' + b.problem : b.problem;
    return rowHtml(b.title || b.name, desc,
      [b.enabled ? 'on' : 'off', b.enabled ? '已启用' : '已停用'],
      b.problem ? ' plugin-problem' : '');
  }

  /**
   * 官方那一栏的一行：两种东西都在这里。
   *   · 包（bundles）——带启用状态，能开关；
   *   · 设置卡片（cards）——不是开关，是一张设置页，所以没有状态徽标（PC 上也是这样）。
   */
  function officialRow(item) {
    if (item.kind === 'card') return rowHtml(item.title, item.description || '', null);
    return bundleRow(item);
  }

  /**
   * 一行「内置插件」（Loader 条目 / 预设组合行）。`title` 是服务端压好的短名
   * （`@deepseek-ai/dsh-tool-fs` → `tool-fs`），照 PC 的内置插件面板。
   */
  function invRow(e) {
    return rowHtml(e.title || e.moduleName, e.description || '', invBadge(e));
  }

  /** 运行时状态。**问不到就不编**——预设没挂载时那一行本来就没有运行状态。 */
  function invBadge(e) {
    if (e.phase === 'failed') return ['err', '失败'];
    if (e.conditional) return ['off', '按条件'];
    if (!e.enabled) return ['off', '已停用'];
    if (e.phase === 'active') return ['on', '运行中'];
    if (e.phase === 'loading' || e.phase === 'pending') return ['off', '加载中'];
    return null;
  }
  $('subagentsBack').addEventListener('click', saToList);
  function saRepaintTraj() {
    var doc = $('subagentsDoc'), top = doc.scrollTop;
    saRenderDoc(saDocBody, saDocTurns); doc.scrollTop = top;
  }
  $('subagentsDoc').addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null; if (!t) return;
    if (t.closest('[data-traj-max]')) { openTrajPanel(saDocTurns); return; } var row = t.closest('[data-traj-entry]'), i, j, es;
    if (row) {
      var id = row.getAttribute('data-traj-entry'), found = null;
      for (i = 0; i < saDocTurns.length && !found; i++) for (j = 0, es = saDocTurns[i].entries || []; j < es.length; j++) {
        if (String(es[j].id) === String(id)) { found = es[j]; break; }
      }
      if (!found) return;
      saWithTraj(function () { saEntryOpen[id] = !trajEntryIsOpen(found); }); saRepaintTraj(); return;
    }
    var head = t.closest('[data-traj-group]');
    if (!head) return;
    var turn = head.getAttribute('data-traj-group'), group = null;
    for (i = 0; i < saDocTurns.length; i++) if (String(saDocTurns[i].turn) === String(turn)) { group = saDocTurns[i]; break; }
    if (!group) return;
    saWithTraj(function () { saGroupOpen[turn] = !trajGroupIsOpen(group); }); saRepaintTraj();
  });
  saPanel.addEventListener('click', function (e) {
    if (e.target === saPanel) saPanel.classList.remove('open');
  });

  // ---------------- 权限档位 ----------------
  //
  // 这是把 PC 端那道授权闸门搬到了手机上：**手机从此能指挥 Agent 把电脑提到
  // 完全权限**。闸门还在（要 token / 密码），但它守的那扇门换了一扇——
  // 拿到手机的人等于拿到了这台电脑的写权限。这是功能本身的代价，不是瑕疵。
  //
  // 所以「完全权限」那一档要点两次。用页面内的两步确认、不用 window.confirm：
  // 那种弹窗在微信这类内嵌浏览器里会被直接屏蔽，而在屏蔽的情况下万一返回
  // 真值就等于确认被跳过了——不安全的方向上不能赌。
  //
  // 档位名和标签都是**服务端读出来再给过来的**：有哪些档位、什么顺序、哪个要
  // 确认，这一侧一个都不写死。服务端那边负责把标识符（read-only 这类 DSH 自己的
  // 键名）翻成中文——服务给的 optionOf() 只回键名，三个中文是 DSH 网页界面里的
  // 客户端翻译，服务里没有，所以那张表放在 lib/permissions.js。
  // 映射不到时会退回标识符本身，所以这里拿到的一定是个真名字，不会是空格。
  // 页面只管显示拿到的东西。
  var permOptions = null;   // null = 还没读到（或这台电脑没这个能力）
  var permFor = null;       // 手上这一份 currentValue 是**哪个会话**的
  var permArmed = '';       // 哪一档正在等「再点一次」

  /**
   * 读一次档位盘。
   *
   * **这是个要反复读的动作，不是启动时读一次就够。** 三个理由：
   *   · 答案会变——电脑端随时能改档位，而这一块的作用就是「标出现在是哪一档」；
   *   · 一次读不到就会永远缺这一块——宿主刚重启、绑定会话还没装进 `ctx.agents`
   *     那段时间里，服务端如实回 `no-session`（见 lib/permissions.js 的 listPresets）。
   *     启动时那一次正好撞上，不重读就再也回不来，只有整页刷新能让它出现。
   *     所以设置抽屉每次打开都重读（见上面「设置」那一段）；
   *   · **`currentValue` 是每个会话各一份的**（宿主的 `permission/preset` 记在会话自己
   *     的日志里，`service.current(session)` 读的是这个会话那份投影）。换了会话就不能
   *     拿上一个会话那一档接着显示——那是在说一个假话。所以换会话也要重读
   *     （见 applySnapshot 里换会话那一段）。
   *
   * 传参就是「按这个会话读」；不传是「还是这个会话，重读一次」。
   *
   * 读不到时**只在这块本来就空着的情况下才藏起来**：已经画出来的档位不许因为一次
   * 读失败当场消失——那是把「此刻读不到」错当成「这台电脑没有这个能力」。
   * 换了会话则相反：那一份高亮**必须**当场撤掉，因为它不是这个会话的值。
   * 档位列表本身留着不动——那是宿主的本子，所有会话共用一份。
   */
  function loadPermissions(forSession) {
    var session = forSession === undefined ? permFor : (forSession || null);
    if (session !== permFor) {
      permFor = session;
      permArmed = '';   // 「再点一次」那半次确认也是上一个会话的，不跟着走
      if (permOptions) {
        permOptions.currentValue = '';
        renderPerms();
      }
    }
    api('/mini/api/permissions').then(function (body) {
      // 请求飞在路上时用户又切走了：这一份属于上一个会话，扔掉。
      if (session !== permFor) return;
      if (!body || !body.ok) {
        if (!permOptions) $('permBlock').hidden = true;
        return;
      }
      permOptions = body;
      renderPerms();
    }).catch(function () {
      if (session !== permFor) return;
      // 附加能力缺了不该影响发指令：一个档位都没读到过时，整块不显示。
      if (!permOptions) $('permBlock').hidden = true;
    });
  }

  function renderPerms() {
    if (!permOptions) return;
    $('permBlock').hidden = false;
    var seg = $('segPerm');
    seg.innerHTML = (permOptions.options || []).map(function (o) {
      var cls = [];
      if (o.value === permOptions.currentValue) cls.push('active');
      if (o.value === permArmed) cls.push('armed');
      return '<button type="button" data-perm="' + escapeHtml(o.value) + '"'
        + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '>'
        + escapeHtml(o.value === permArmed ? '再点一次：' + o.name : o.name)
        + '</button>';
    }).join('');
    $('permHint').textContent = permHintText();
  }

  /**
   * 提示语。
   *
   * 服务没给说明文字时**不硬编一句**——本机三个档位的 description 全是空的。
   * 那就在这一行显示出当前档位的名字（这个名字是真的，来自服务端），
   * 而不是编一段「Agent 只能读」这种我没法保证准确的话。
   * 「现在在哪一档」主要由按钮的高亮表示，这一行只是补充。
   */
  function permHintText() {
    if (!permOptions) return '';
    var cur = (permOptions.options || []).filter(function (o) {
      return o.value === permOptions.currentValue;
    })[0];
    if (!cur) return '作用在当前会话上';
    return cur.description || ('当前：' + cur.name);
  }

  function tapPerm(name) {
    if (!permOptions) return;
    // 点的就是当前这一档：什么都不做。不这么做的话，一次误触会往会话日志里
    // 记一条没有意义的切换。
    if (name === permOptions.currentValue) return;
    var opt = (permOptions.options || []).filter(function (o) { return o.value === name; })[0];
    if (!opt) return;

    if (opt.dangerous && permArmed !== name) {
      permArmed = name;
      renderPerms();
      toast('再点一次「' + opt.name + '」就切过去');
      return;
    }
    permArmed = '';
    api('/mini/api/permissions', { method: 'POST', body: JSON.stringify({ name: name }) })
      .then(function (body) {
        if (!body || !body.ok) return;
        // 服务端把切换后的最新状态一起回来了，直接重画，不用再补一趟。
        permOptions = body;
        renderPerms();
        toast('已切到「' + opt.name + '」');
      })
      .catch(function (err) {
        permArmed = '';
        renderPerms();
        toast(err.message);
      });
  }

  loadPermissions(state.boundSessionId);

  // 档位按钮的点击。
  //
  // 监听挂在**容器**上，不挂在按钮上——`renderPerms()` 每次都整块换 innerHTML，
  // 挂按钮上的监听会被下一次重画冲掉。挂在容器上就不受影响。
  //
  // 这个坑真机踩到过：三档看得见、点下去毫无反应，因为 `tapPerm` 一次都没被调用。
  // 单元测试没抓住它，是因为测试直接调 `tapPerm` 验逻辑，而真机上缺的是**接线**——
  // 逻辑对、没人喊它。
  $('segPerm').addEventListener('click', function (e) {
    var btn = e.target;
    // 按钮里现在只有文字，点到的就是按钮本身；这个循环是防将来往里塞图标。
    while (btn && btn !== this && !(btn.dataset && btn.dataset.perm)) btn = btn.parentNode;
    if (!btn || btn === this) return;
    tapPerm(btn.dataset.perm);
  });

  Array.prototype.forEach.call($('segMode').children, function (btn) {
    btn.addEventListener('click', function () {
      state.mode = btn.dataset.mode;
      $('hintMode').textContent = modeHint();
      localStorage.setItem('dshMiniMode', state.mode);
      syncSeg();
      render();
      // 切到「完整」：订上并把已有的过程拉下来；切走：退订、停推。
      syncTrajectorySubscription();
      // 离开「单帧」时正文流式才成立：连接是在单帧里建的就没带 stream=1，这里补一次重连。
      syncStreamSubscription();
    });
  });
  Array.prototype.forEach.call($('segSound').children, function (btn) {
    btn.addEventListener('click', function () {
      state.sound = btn.dataset.sound === 'on';
      localStorage.setItem('dshMiniSound', state.sound ? 'on' : 'off');
      if (state.sound) unlockAudio();
      syncSeg();
    });
  });

  // ---------------- 外观（深色 / 浅色 / 跟随系统） ----------------
  // 只改 <html> 上的 data-theme，样式表里两套令牌各管各的。这里不碰任何具体颜色，
  // 免得以后加第三套主题还要回来改这一段。
  // 首屏那次由 <head> 里那一小段负责（不然会闪）；这一段管切换和"跟着系统变"。
  function resolvedTheme() {
    if (state.theme !== 'auto') return state.theme;
    var dark = !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
    return dark ? 'dark' : 'light';
  }
  function applyTheme() {
    var use = resolvedTheme() === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', use);
    // 手机状态栏那块颜色也跟着走，否则浅色页配一条深色状态栏，像没画完。
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', use === 'light' ? '#eaf3fc' : '#0a0f16');
  }
  // ---------------- 流式输出（开 / 关） ----------------
  //
  // 关着时和以前一模一样（等整段落定）；开着时正文一个字一个字冒出来（见 trajectory-live
  // 那一段的 `kind: 'text'` 分支）。
  //
  // **切完要重连一次**：`stream=1` 是在建立连接时带上的，服务端据此决定这条连接要不要
  // 收正文帧。就地改 state 不够——那条已经连着的流不知道你要改了。
  Array.prototype.forEach.call($('segStreaming').children, function (btn) {
    btn.addEventListener('click', function () {
      if (state.mode === 'minimal') return;   // 单帧不跟，按钮是灰的
      var want = btn.dataset.streaming === 'on';
      if (want !== state.streaming) {
        state.streaming = want;
        localStorage.setItem('dshMiniStreaming', want ? 'on' : 'off');
        // 关掉时把屏幕上可能残留的流式影子撤掉，不然会停在半句话上直到下一条消息。
        if (!want) state.live = '';
        syncSeg();
        render();
      }
      // **值没变也要对一次订阅**（2026-10-22）：开关本来就存着「开」，但连接是在
      // 单帧里建的、没带 stream=1——点一下等于「重连一次」，不然它会一直显示「开」
      // 却一个正文帧都收不到。已经对上了就什么都不做。
      syncStreamSubscription();
    });
  });

  Array.prototype.forEach.call($('segTheme').children, function (btn) {
    btn.addEventListener('click', function () {
      state.theme = btn.dataset.theme;
      localStorage.setItem('dshMiniTheme', state.theme);
      applyTheme();
      syncSeg();
    });
  });
  if (window.matchMedia) {
    var themeMq = window.matchMedia('(prefers-color-scheme: dark)');
    var onThemeMq = function () { if (state.theme === 'auto') applyTheme(); };
    if (themeMq.addEventListener) themeMq.addEventListener('change', onThemeMq);
    else if (themeMq.addListener) themeMq.addListener(onThemeMq);
  }
  applyTheme();   // 补上首屏那次没做的一件事：把状态栏颜色对齐

  // ---------------- 字体大小（小 / 标准 / 大） ----------------
  function applyFontSize() {
    var sizes = { small: '13px', normal: '15.5px', large: '18px' };
    document.documentElement.style.setProperty('--font-base', sizes[state.fontSize] || sizes.normal);
  }
  Array.prototype.forEach.call($('segFont').children, function (btn) {
    btn.addEventListener('click', function () {
      state.fontSize = btn.dataset.font;
      localStorage.setItem('dshMiniFont', state.fontSize);
      applyFontSize();
      syncSeg();
    });
  });
  applyFontSize();  // 首屏应用

  function syncSeg() {
    Array.prototype.forEach.call($('segMode').children, function (b) {
      b.classList.toggle('active', b.dataset.mode === state.mode);
    });
    Array.prototype.forEach.call($('segStreaming').children, function (b) {
      b.classList.toggle('active', (b.dataset.streaming === 'on') === state.streaming);
      // 单帧模式不跟流式（用户 2026-10-21 拍板）：那一屏只看最终那一句，
      // 开关在这里灰掉，但**不改存的值**——切回聊天/完整它还是你上次的选择。
      b.disabled = state.mode === 'minimal';
    });
    Array.prototype.forEach.call($('segSound').children, function (b) {
      b.classList.toggle('active', (b.dataset.sound === 'on') === state.sound);
    });
    Array.prototype.forEach.call($('segTheme').children, function (b) {
      b.classList.toggle('active', b.dataset.theme === state.theme);
    });
    Array.prototype.forEach.call($('segFont').children, function (b) {
      b.classList.toggle('active', b.dataset.font === state.fontSize);
    });
  }

  // 会话切换挪到左侧导航栏了（原来这里是设置里的下拉框）。

  // ---------------- 锁屏也能提醒（系统通知） ----------------
  //
  // 页内的响铃和震动只在页面看得见的时候有用。人把手机放下、屏幕锁了，那两样都
  // 叫不醒他——要叫醒他只能发系统通知。
  //
  // 这条路以前是关着的，三层原因叠在一起：
  //   1. 通知权限只能在「安全上下文」（HTTPS 或 localhost）里申请。当时三条连接
  //      路径全是明文 HTTP，浏览器连这个 API 都不给；
  //   2. 就算拿到权限，new Notification() 在大多数移动浏览器上会抛 TypeError，
  //      移动端唯一正确的入口是 service worker 的 showNotification；
  //   3. service worker 同样要求 HTTPS。
  // 2026-09-25 Tailscale 那条路接上 HTTPS，第 1、3 条同时成立，这条路才通。
  //
  // **所以这一行只在加密连接下露出来。** 明文下露出来，用户点一下只会碰一鼻子灰
  // ——那正是 2026-09-21 把它整行撤掉的理由，那条理由现在仍然成立。
  //
  // 电脑端的外部推送（Bark / ntfy / Telegram）是另一条路：从服务器发出去，不经
  // 浏览器，明文连接下也照常能用。两者不冲突，各管一段。
  var NOTIFY_OK = window.isSecureContext
    && 'serviceWorker' in navigator
    && 'Notification' in window;

  function notifySystem(text) {
    if (!state.notify || !NOTIFY_OK) return;
    if (Notification.permission !== 'granted') return;
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.showNotification('回复到了', {
        body: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        // 带上 tag：同一条回复重复到达时替换掉旧的，别堆一屏。
        tag: 'dsh-reply',
        renotify: true,
        // 地址由页面给。不能拿 service worker 自己的 location 拼——那是那个 .js
        // 文件的地址，用户点通知会打开一份源码。
        data: { url: location.href },
      });
    }).catch(function () { /* 发不出去就算了，不该影响主流程 */ });
  }

  function syncNotify() {
    Array.prototype.forEach.call($('segNotify').children, function (b) {
      b.classList.toggle('active', (b.dataset.notify === 'on') === state.notify);
    });
  }

  /**
   * 繁忙时的发送行为（2026-10-05 用户要求搬进手机设置）。
   *
   * 这是 PC「设置 → 通用」里那一条的同款：智能体跑着的时候，你发的话是
   * 排队等这一轮跑完，还是当场插进去让它调整方向。**两端共用宿主那一份设置**，
   * 所以这里改完，电脑上也是这个值——这是用户拍板要的（同一个开关，别两端各存一份）。
   *
   * **读不到就整条不画**：拿不到宿主设置时把那一行藏起来，不摆一个点了没用的开关。
   * 这和插件页「宁可少画，不凭空多画」是同一条口径。
   *
   * 写的时候带上服务端给的 revision（乐观锁）：万一电脑上刚改过，这次写入会被挡下来，
   * 而不是把对方那次改动悄悄盖掉——那种覆盖用户看不见，最难查。
   */
  var busyEnter = { current: 'queue', revision: null, ready: false };
  function paintBusyEnter() {
    Array.prototype.forEach.call($('segBusyEnter').children, function (b) {
      b.classList.toggle('active', b.dataset.busy === busyEnter.current);
    });
  }
  function loadBusyEnter() {
    api('/mini/api/busy-enter').then(function (r) {
      if (!r || !r.ok) {
        // 这台电脑没提供这个设置（老版本 DSH、或设置文档里没这一项）。
        // 藏起来就好，不用报错——那不是「出错」，是「这里本来就没有」。
        $('rowBusyEnter').hidden = true;
        return;
      }
      busyEnter.current = r.current === 'steer' ? 'steer' : 'queue';
      busyEnter.revision = typeof r.revision === 'number' ? r.revision : null;
      busyEnter.ready = true;
      $('rowBusyEnter').hidden = false;
      paintBusyEnter();
    }).catch(function () {
      $('rowBusyEnter').hidden = true;
    });
  }
  $('segBusyEnter').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-busy]') : null;
    if (!btn || !busyEnter.ready) return;
    var next = btn.dataset.busy;
    if (next === busyEnter.current) return;
    // 先画再发：这一下是用户自己按的，立刻有反馈；发失败了再画回去并说清。
    var prev = busyEnter.current;
    busyEnter.current = next;
    paintBusyEnter();
    api('/mini/api/busy-enter', {
      method: 'POST',
      body: JSON.stringify({ value: next }),
    }).then(function (r) {
      if (r && r.ok) {
        toast(r.current === 'steer' ? '繁忙时改为插话发送' : '繁忙时改为排队发送');
        busyEnter.revision = typeof r.revision === 'number' ? r.revision : busyEnter.revision;
        return;
      }
      // 失败要画回去——留着那个没生效的选中态，用户会以为改成功了。
      busyEnter.current = prev;
      paintBusyEnter();
      toast(r && r.reason === 'unavailable' ? '这台电脑改不了这一项' : '没能改成，再试一次');
    }).catch(function () {
      busyEnter.current = prev;
      paintBusyEnter();
      toast('没能改成，检查一下连接');
    });
  });

  /**
   * 「进阶设置（电脑端界面）」（2026-10-06 用户要求）。
   *
   * 手机上这张遥控页是**专门为手机做的**，所以电脑上那些插件贡献的设置页它进不去。
   * 这一项是退路：**把电脑端的界面整个搬过来看**——同一份界面，不迁移、不逐个适配。
   * 服务端怎么把这个界面转出来的，写在 lib/mirror.js 开头。
   *
   * **它是个权限开关，不是普通偏好。** 打开它 = 这个令牌的权限从「我们这张手机页
   * 暴露的那点事」扩到整个电脑端设置面（模型配置、凭据页、插件装卸、会话记录……）。
   * 所以三件事一个都不能省：
   *   ① 默认关；
   *   ② 后果写在提示里，而且要等**第二次点击**才真开（`armed`）——照「完全权限」
   *      那一档的规矩，理由也一样（页内两步，不用 window.confirm：那种弹窗在微信
   *      这类内嵌浏览器里会被直接屏蔽，屏蔽时万一返回真值就等于确认被跳过）；
   *   ③ 关着的时候**入口那一行也不显示**——不是露一个点了没用的按钮。
   *
   * 读不到就整块不画：这台电脑没这个能力时（没拿到 DSH_WEB_URL），
   * 藏起来就好，不摆一个假开关。
   */
  var mirror = { available: false, enabled: false, armed: false, ready: false };

  function paintMirror() {
    $('rowMirror').hidden = !mirror.available;
    if (!mirror.available) {
      $('rowMirrorOpen').hidden = true;
      return;
    }
    Array.prototype.forEach.call($('segMirror').children, function (b) {
      b.classList.toggle('active', (b.dataset.mirror === 'on') === mirror.enabled);
    });
    $('mirrorHint').textContent = mirror.enabled
      ? '已打开。手机现在能进整个电脑设置面'
      : mirror.armed
        ? '打开的后果：手机将获得完整的电脑设置权限。再点一次「开」确认'
        : '打开电脑上的 DSH 界面，改那些手机上没有的设置';
    $('rowMirrorOpen').hidden = !mirror.enabled;
  }

  /**
   * 镜像入口那个地址。
   *
   * **尾斜杠不能省**：那个界面外壳写着 `<base href="./">`，在 `/mini/mirror` 上它
   * 解析成 `/mini/`，在 `/mini/mirror/` 上才是 `/mini/mirror/`——差这一个字符，
   * 里面引用的脚本会全 404、界面白屏（真浏览器验出来的）。
   *
   *
   * **地址里不带令牌**（2026-10-16 第二步）：这个框是同源文档，设备 cookie 会自动跟着
   * 它的每一条请求走（文档本身、静态资源、界面自己发的 `/api/*`），入口那一下不再需要
   * 顺手写 cookie。上游收到的东西里一个字节的凭据都没有——第一步已经钉住。
   */
  function mirrorUrl() {
    return '/mini/mirror/';
  }

  /**
   * 点「打开」：把那一整屏显示出来，并**在那一刻**才给框设地址（没点之前不加载）。
   *
   * 这一版为什么能成：**没有跳转、没有新标签、没有弹窗**——浏览器没有任何东西可以拦。
   * 前两版都在赌「跳转」这个动作（详见页面里 `#mirrorView` 上面那段注释）。
   */
  function openMirror() {
    if (!mirror.enabled) return;
    // **先给一句提示，再显示那一屏。**
    //
    // 这一句不是装饰，是**诊断**（2026-10-06 用户三次报「点了没反应」之后加的）：
    // 三种情况从此分得开——看到提示且界面出来＝成了；只看到提示＝显示那一步的问题；
    // 连提示都没有＝点击压根没到按钮上。前三次就是分不开这三种，才一路猜错。
    toast('正在打开电脑端界面…');
    // **顺序要紧：先把这一层显示出来，再给框设地址。**
    //
    // 反过来的话，那个界面是**在 `display:none` 里开始加载的**——在不可见的上下文里
    // 渲染出来的东西，要等用户点一下触发重绘才画全（真机上就是「图标旁边的文字
    // 点一下才出来」）。2026-10-06 查出：**直接打开镜像没有这个毛病**，
    // 差别就在这两行的先后。
    $('mirrorView').hidden = false;
    $('mirrorFrame').src = mirrorUrl();
  }

  function closeMirror() {
    $('mirrorView').hidden = true;
    // 收起状态一起复位：下次进来从「看不见」开始（鼠标若正好停在顶上，
    // 那一下 mousemove 会把它勾出来，见下面的接线）。
    mirrorBarOff();
    // 把地址清掉：那一屏里是个完整应用（还在跑、还连着），关掉就该真停，
    // 而不是留在后台继续占内存和连接。
    $('mirrorFrame').src = 'about:blank';
  }

  // 按钮和**整行**都绑：那个按钮只有 54×40，手指容易点偏；整行点下去都算数。
  $('btnMirrorOpen').addEventListener('click', openMirror);
  $('rowMirrorOpen').addEventListener('click', function (e) {
    // 点在按钮上时上面那个监听已经处理了，别处理两遍。
    if (e.target === $('btnMirrorOpen')) return;
    openMirror();
  });
  $('mirrorClose').addEventListener('click', closeMirror);

  /**
   * 顶栏的「收 / 放」（2026-10-15 用户要的甲案：鼠标移到屏幕顶部才滑出来）。
   *
   * 为什么非要有那条 16px 感应带、为什么手机不走这一套：样式表里那一段说清了。
   * 这里只说两件必须做对的事：
   *
   * ① **贴到顶上先停 0.18 秒再滑出**。鼠标路过顶边去点官方界面时（右上角那个
   *    「打开右侧边栏」就在第 28px），不该把它勾出来；停这么一下就不会误触发。
   *
   * ② **「返回」永远可达**——它是唯一回手机页的出口，绝不能藏死：
   *    · 鼠标碰到顶上 16px 就出来（滑出只是一次 0.18 秒的等待）；光标停在感应带上
   *      不动也没关系：显示之后感应带还在最上面，鼠标一动就再勾一次；
   *    · 键盘 Tab 停在「返回」上时也把它亮出来（下面 focus 那一条），
   *      不留一个「焦点在这、按钮看不见」的坑；
   *    · 滑出时横条**占自己的位置**、不盖在官方界面上，谁也挡不住它；
   *    · 手机上它压根不藏（触摸没有悬停，藏了就等于摸不到）。
   */
  var mirrorHot = $('mirrorHot');
  var mirrorBar = $('mirrorBar');
  var barShowTimer = null;
  var barHideTimer = null;

  function mirrorBarOn() { $('mirrorView').classList.toggle('bar-on', true); }
  function mirrorBarOff() { $('mirrorView').classList.toggle('bar-on', false); }

  if (mirrorHot && mirrorBar && mirrorHot.addEventListener) {
    function barScheduleShow() {
      if (barShowTimer) return;
      clearTimeout(barHideTimer);
      barShowTimer = setTimeout(function () { barShowTimer = null; mirrorBarOn(); }, 180);
    }
    // 收的时候也先等 0.2 秒：鼠标可能是从感应带往下挪进横条里（那条就贴在它下面），
    // 中途路过那一下不该被判成「离开了」。
    function barScheduleHide() {
      clearTimeout(barShowTimer);
      barShowTimer = null;
      clearTimeout(barHideTimer);
      barHideTimer = setTimeout(mirrorBarOff, 200);
    }
    // **桌面与触摸走两套事件**（2026-10-18）：桌面有悬停，鼠标贴到顶上滑出、移开收回；
    // 触摸没有悬停这回事，改成"点一下切换"——点顶部那条把手拉出来，再点一下收回去。
    // 判定用媒体查询，和样式表里同一套条件（`hover:hover and pointer:fine` = 有鼠标）。
    var barHasHover = !!(window.matchMedia
      && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
    if (barHasHover) {
      mirrorHot.addEventListener('mouseenter', barScheduleShow);
      // 显示这一屏那一刻鼠标可能就停在顶上（那时不会再有 mouseenter）——动一下也算数。
      mirrorHot.addEventListener('mousemove', barScheduleShow);
      mirrorHot.addEventListener('mouseleave', barScheduleHide);
      mirrorBar.addEventListener('mouseenter', function () { clearTimeout(barHideTimer); });
      mirrorBar.addEventListener('mouseleave', barScheduleHide);
    } else {
      // 触摸：按住拖动不算（不在 iframe 里），只有"点"才切换。
      mirrorHot.addEventListener('click', function () {
        if ($('mirrorView').classList.contains('bar-on')) mirrorBarOff();
        else mirrorBarOn();
      });
    }
  }
  // Tab 走到「返回」上要看得见它。
  $('mirrorClose').addEventListener('focus', mirrorBarOn);

  /**
   * 框里那一页自己发的「返回手机页」。
   *
   * **为什么需要**：镜像那一屏里，框中的文档正常情况下是电脑端界面（它有自己的退出方式），
   * 但**打不开的时候**它是我们自己发的一页提示（见 lib/server.js 的 sendMirrorUnavailable）
   * ——那一页里除了浏览器自己的返回，没有别的出口，用户会卡在一个提示页上。
   * 所以那一页的「返回」按钮往这里发一条消息，我们把这整屏收起来。
   *
   * 只认这一条字符串，且只认同源：这个监听**只做「收屏」这一件事**，别的消息一概不理。
   */
  window.addEventListener('message', function (e) {
    if (e.origin === location.origin && e.data === 'mini-mirror-close') closeMirror();
  });

  function loadMirror() {
    api('/mini/api/mirror').then(function (r) {
      if (!r || !r.ok || !r.available) {
        mirror.available = false;
        paintMirror();
        return;
      }
      mirror.available = true;
      mirror.enabled = r.enabled === true;
      mirror.ready = true;
      paintMirror();
    }).catch(function () {
      mirror.available = false;
      mirror.armed = false;
      paintMirror();
    });
  }

  function tapMirror(next) {
    if (!mirror.ready) return;
    if (next === 'off') {
      // 关掉不需要确认：往「更安全」的方向走，不用拦。
      mirror.armed = false;
      if (!mirror.enabled) { paintMirror(); return; }
      mirror.enabled = false;
      paintMirror();
      api('/mini/api/mirror', { method: 'POST', body: JSON.stringify({ enabled: false }) })
        .then(function (r) {
          if (r && r.ok) { toast('已关掉电脑端界面'); return; }
          mirror.enabled = true;
          paintMirror();
          toast('没能关掉，再试一次');
        })
        .catch(function () {
          mirror.enabled = true;
          paintMirror();
          toast('没能关掉，检查一下连接');
        });
      return;
    }
    // 开：第一次点只是「举起来」，把后果摆出来；再点一次才真开。
    if (!mirror.enabled && !mirror.armed) {
      mirror.armed = true;
      paintMirror();
      return;
    }
    if (mirror.enabled) return;
    mirror.armed = false;
    mirror.enabled = true;
    paintMirror();
    api('/mini/api/mirror', { method: 'POST', body: JSON.stringify({ enabled: true }) })
      .then(function (r) {
        if (r && r.ok) { toast('已打开，点下面的「打开」进去'); return; }
        mirror.enabled = false;
        paintMirror();
        toast(r && r.reason === 'unavailable' ? '这台电脑没有这个能力' : '没能打开，再试一次');
      })
      .catch(function () {
        mirror.enabled = false;
        paintMirror();
        toast('没能打开，检查一下连接');
      });
  }

  $('segMirror').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-mirror]') : null;
    if (!btn) return;
    tapMirror(btn.dataset.mirror);
  });

  if (NOTIFY_OK) {
    // 先注册 service worker。**这一步不申请权限**——权限要用户主动点一下才给，
    // 页面一加载就弹窗会被浏览器直接拒掉，而且很讨厌。
    //
    // 注册成功才把那一行露出来。注册不上就继续藏着：露一个点了没用的开关，
    // 比没有更让人困惑。
    //
    // **2026-09-25 用户裁决：这一行不露出来了。**
    //
    // 试到底了：手机锁屏后系统冻结后台页面，那条实时连接跟着断掉，回复根本到不了页面，
    // 也就没人去发通知。这是手机系统的调度，插件绕不过去；service worker 也救不了——
    // 它是被事件唤醒的，没有事件它就不存在。
    //
    // 用户原话：「类似功能我们以后考虑做成 APP 时再加，浏览器里不放了。」
    //
    // **代码全部留着，只是不露出来。** service worker 照常注册（已经验证过在加密连接下
    // 能正常工作），通知那段逻辑照常挂在回复到达的分支里。将来做 App 里的锁屏提醒，
    // 这里的知识直接能用。
    //
    // 要重新打开：把下面两行取消注释。**但先把名字想清楚**——别再用「锁屏也能提醒」
    // 这种它做不到的说法，那是这一轮踩过的坑。
    navigator.serviceWorker.register('/mini/sw.js?v=' + BUILD).catch(function () {});
    // $('rowNotify').style.display = '';
    // $('notifyHint').textContent = notifyHintText();
    // syncNotify();

    // 浏览器现在给的是什么状态，就说什么话。
    //
    // **不能只说「打开时会问一次」**——2026-09-25 用户点了「开」，浏览器什么都没问，
    // 界面上也一点变化都没有，看上去就是「点了没用」。真实原因是这个网站的通知权限
    // 早就被拒过，而 requestPermission() 在这种情况下**不会再弹**，直接回 denied。
    // 所以每一种状态都得有对应的一句话，用户才能自己判断下一步该干什么。
    function notifyHintText() {
      var p = Notification.permission;
      if (p === 'granted') return '回复到了发一条系统通知';
      if (p === 'denied') return '权限被拒过，浏览器不会再问。去浏览器设置里允许，或清掉本站数据后重新扫码';
      return '打开时浏览器会问一次要不要允许';
    }

    // 申请通知权限。**两种写法都要兼容**：新浏览器返回 Promise，老一点的和一些厂商
    // 定制内核只认回调式——直接 .then() 会抛，表现同样是「点了没反应」。
    // 回调式在所有支持这个 API 的浏览器上都会被调用（包括那些同时支持 Promise 的），
    // 所以以它为主，Promise 只当兜底。
    function askNotifyPermission() {
      var settled = false;
      function settle(perm) {
        if (settled) return;
        settled = true;
        if (perm !== 'granted') {
          $('notifyHint').textContent = '浏览器没给通知权限（现在是「' + (perm || '没反应')
            + '」）。去浏览器设置里允许，或清掉本站数据后重新扫码。';
          syncNotify();
          return;
        }
        state.notify = true;
        localStorage.setItem('dshMiniNotify', 'on');
        $('notifyHint').textContent = notifyHintText();
        syncNotify();
      }
      try {
        var r = Notification.requestPermission(settle);
        if (r && typeof r.then === 'function') r.then(settle).catch(function () {});
      } catch (err) {
        $('notifyHint').textContent = '这个浏览器问不出通知权限。要去浏览器的设置里手动开。';
        return;
      }
      // 有些内核两条路都不回来。等三秒给个交代，别让用户对着一个没反应的开关发呆。
      setTimeout(function () {
        if (!settled) {
          $('notifyHint').textContent = '浏览器没弹权限询问（现在是「' + Notification.permission
            + '」）。去浏览器设置里允许，或清掉本站数据后重新扫码。';
        }
      }, 3000);
    }

    $('segNotify').addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.notify !== 'on') {
        state.notify = false;
        localStorage.setItem('dshMiniNotify', 'off');
        syncNotify();
        return;
      }
      // 已经允许过了就别再问——问了也不会弹，只会让用户以为坏了。
      if (Notification.permission === 'granted') {
        state.notify = true;
        localStorage.setItem('dshMiniNotify', 'on');
        $('notifyHint').textContent = notifyHintText();
        syncNotify();
        return;
      }
      askNotifyPermission();
    });
  }

  $('btnReconnect').addEventListener('click', function () {
    connect();
    toast('正在重连…');
  });

  /**
   * 「重新输入令牌」：把闸门露出来，让用户再贴一枚令牌进来。
   *
   * **这一下不再清除任何东西**（2026-10-16 第二步）：身份已经是一枚 HttpOnly 的设备
   * cookie，页面看不到也删不掉它——真正的「把这台设备赶出去」在电脑那边（名册里删掉
   * 它，下一步做进设置页）。按钮原来叫「清除 token」，那个名字从这一刻起就是假的。
   */
  $('btnForget').addEventListener('click', function () {
    sheet.classList.remove('open');
    showGate();
  });

  // ---------------- token 闸门 ----------------
  function showGate() {
    $('gate').classList.add('open');
    $('gateErr').textContent = '';
    setTimeout(function () { $('gateInput').focus(); }, 120);
  }
  $('gateBtn').addEventListener('click', submitGate);
  $('gateInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitGate();
  });
  /**
   * 把手里这枚令牌交回**门口那一次**（和扫码进来是同一条路）。
   *
   * 为什么不在这里校验一次、把它留在手里：令牌留在手里就等于**撤销失效**——名册里
   * 把这条记录删掉之后，这台设备还会拿令牌进门。所以这里只是**跳一次**：服务端在门口
   * 认这枚令牌、换成设备 cookie（HttpOnly），页面自己一个字节都不记。
   * 令牌不对时服务端会重新发下门禁页；下面启动那一段看地址里那枚 token 就知道要报什么。
   */
  function submitGate() {
    var value = $('gateInput').value.trim();
    if (!value) { $('gateErr').textContent = '请先粘贴 token'; return; }
    $('gateErr').textContent = '校验中…';
    location.replace(location.pathname + '?token=' + encodeURIComponent(value));
  }

  /**
   * 待办条（2026-11-14）：输入框上方一行「3/7 · 正在：…」，点开看全部。
   *
   * 数据从电脑那侧来（`/mini/api/todos`），因为清单本来就存在轨迹里；
   * 手机不在本地另存一份，**免得两边各说一个进度**。
   */
  var todoState = { line: '', items: [], open: false, sessionId: '' };

  function paintTodo() {
    var bar = $('todoBar'), btn = $('todoSummary'), list = $('todoList');
    if (!bar || !btn || !list) return;
    if (!todoState.items.length) { bar.hidden = true; return; }
    bar.hidden = false;
    btn.textContent = todoState.line || (todoState.items.length + ' 项待办');
    list.hidden = !todoState.open;
    if (!todoState.open) return;
    list.innerHTML = todoState.items.map(function (one) {
      var mark = one.status === 'completed' ? '✓' : one.status === 'in_progress' ? '▶' : '·';
      return '<div class="todo-row todo-' + escapeHtml(one.status) + '"><span class="todo-mark">' + mark
        + '</span>' + escapeHtml(one.text) + '</div>';
    }).join('');
  }

  function loadTodos() {
    var id = state.boundSessionId;
    if (!id) { todoState.items = []; paintTodo(); return; }
    fetch('/mini/api/todos?sessionId=' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (!j || j.ok !== true) return;
        var sessionChanged = todoState.sessionId !== id;
        todoState.sessionId = id;
        // 「跑着的时候空清单不许把条子清掉」这条判据在 todo-summary.js 里，单测钉着。
        var next = mergeTodoState(
          { items: todoState.items, line: todoState.line },
          { items: Array.isArray(j.items) ? j.items : [], line: j.line || '' },
          { running: !!state.running, sessionChanged: sessionChanged },
        );
        if (!next.changed) return;
        todoState.items = next.items;
        todoState.line = next.line;
        paintTodo();
      })
      .catch(function () {});
  }

  var todoBtn = $('todoSummary');
  if (todoBtn) {
    todoBtn.addEventListener('click', function () {
      todoState.open = !todoState.open;
      paintTodo();
    });
  }

  // 凭据遮挡的展开/收起：整页绑一次（2026-11-14）。
  initSecrets();
  // 公式：新内容进来就排一次（流式追加，不可能每处都记得调）。
  watchMath();

  // ---------------- presence 与心跳 ----------------
  document.addEventListener('visibilitychange', function () {
    var hidden = document.hidden;
    if (state.entered) {
      api('/mini/api/presence', {
        method: 'POST',
        body: JSON.stringify({ state: hidden ? 'background' : 'foreground' })
      }).catch(function () {});
    }
    if (!hidden) { render(); connectIfDead(); }
  });
  setInterval(function () {
    if (state.entered) api('/mini/api/heartbeat', { method: 'POST', body: '{}' }).catch(function () {});
  }, 30000);

  function connectIfDead() {
    // 切回前台时 EventSource 可能已经悄悄死了，探一下。
    if (!state.entered) return;
    if (es && es.readyState === EventSource.OPEN) return;
    connect();
  }

  /**
   * 服务器换过代码就自己刷新一次。
   *
   * 为什么非要有：这个页面是**启动时读进内存**才发出去的（改了要重启 DSH），而立绘是
   * **每次请求现读盘**的（文件一改就生效）。于是"页面和图不是同一时刻换的"这件事真的
   * 会发生——2026-09-29 用户在手机上看到「原来的两条腿变成 4 条腿了」：手里那份页面还是
   * 旧的（写死按两格、244 像素宽去切），硬盘上的图已经是六格的了，122 像素的窗口里于是
   * 挤进三个压扁的小人，看着就是一堆腿。
   *
   * `/mini/api/version` 报的是**服务器现在这份代码**的构建号：和手里这份一样就什么都不做，
   * 不一样说明页面过期了，刷一次就好（刷新后拿到的新页面自带正确的切帧规则）。
   * **正在打字就先不刷**——用户没发出去的话不能被吞掉，等下一轮再说。
   */
  function watchBuild() {
    if (!state.entered) return;
    api('/mini/api/version').then(function (r) {
      // 设置页底部那行版本。**问到才显示**——问不到就整行不出现，
      // 不拿「unknown」糊一行上去（那个字对用户没意义，还像页面坏了）。
      // 产品名写全称（DeepSeek Harness）：缩写 DSH 只有我们自己人认。
      // 大小写照 DSH 自己的界面串（实测 49 处全是这个写法）。
      if (r && r.dshVersion && r.dshVersion !== 'unknown') {
        var el = $('dshVersion');
        if (el) { el.textContent = 'DeepSeek Harness ' + r.dshVersion; el.hidden = false; }
      }
      if (!r || !r.build || r.build === BUILD) return;
      if (inputEl.value && inputEl.value.trim()) return;
      location.reload();
    }).catch(function () { /* 读不到就当没这回事，别把页面弄崩 */ });
  }

  // 复制按钮：整篇、单条气泡、代码块共用一套。
  // 用事件委托——回复区每次都是整块重绘的，逐个绑会漏。
  // （原来这里是「点回复区任意位置复制全文」，它直接用了 navigator.clipboard，
  //   在明文 HTTP 下那个接口是 undefined，点了什么都不会发生；而且它会和
  //   新加的按钮打架，所以换成显式按钮。）
  replyEl.addEventListener('click', function (e) {
    // 长指令气泡的「展开 / 收起」：只动这一块，不重画整串历史。
    var more = e.target && e.target.closest ? e.target.closest('.bubble-more') : null;
    if (more) {
      var key = more.getAttribute('data-more') || '';
      var text = more.parentNode && more.parentNode.querySelector
        ? more.parentNode.querySelector('.bubble-text') : null;
      if (!text) return;
      var expanded = more.getAttribute('aria-expanded') !== 'true';
      more.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      more.textContent = expanded ? '收起' : '展开';
      text.classList.toggle('clamped', !expanded);
      if (expanded) expandedUserMsgs[key] = true; else delete expandedUserMsgs[key];
      return;
    }
    var quote = e.target && e.target.closest ? e.target.closest('[data-quote]') : null;
    if (quote) {
      // 引用追问：把这条折成几行塞进输入框，光标停在末尾，接着问就行（2026-11-14）。
      e.preventDefault();
      var input = $('input');
      if (!input) return;
      input.value = quoteText(quote.getAttribute('data-quote') || '') + (input.value || '');
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length) } catch (err) {}
      toast('已引用，接着问就行');
      return;
    }
    var btn = e.target && e.target.closest ? e.target.closest('.copy') : null;
    if (!btn) return;
    e.preventDefault();
    copyText(btn.getAttribute('data-copy') || '', btn);
  });

  // main 的滚动：一句提示的露 / 收，和「再放一屏」，都挂在这一根线上（见 onMainScroll）。
  // **这根线不能省**：逻辑写得再对，没挂上去就是「一点反应都没有」，
  // 而这种坏光看代码是看不出来的。
  // 位置也有讲究：绑在这里，不绑在 atBottom 那片函数旁边——页面测试会把那一段
  // 整块抠出来求值，测试里的假 mainEl 没有 addEventListener，写在那边好几个测试当场报错。
  mainEl.addEventListener('scroll', onMainScroll);

  // 「回到底部」浮标（2026-10-08）也挂在这一根滚动线上，但**另起一条监听**：
  // onMainScroll 被页面测试整块抠出来跑（chatPager 那个替身只给了 state / replyEl /
  // mainEl / timeLabel，没有 $），把浮标并进去会让那几个测试当场报 ReferenceError。
  mainEl.addEventListener('scroll', paintToBottom);
  // 首屏先定一次：刚进来是空页，按判据算「在底部」，浮标该是收着的。
  paintToBottom();

  // 点它：**瞬时**到底，不做平滑滚动。
  //
  // 两条理由，都是「跟现成的东西保持一致」而不是我挑的：
  //   · 用户原话就是「瞬间」；
  //   · 电脑端那颗也是瞬时的（ChatView 里 reading.followTail → viewport.scrollToBottom
  //     → follow.toBottom(..., 'instant')）；
  //   · 本页「按发送回底部」本来就是直接赋值（见 send 里那句
  //     mainEl.scrollTop = mainEl.scrollHeight），同一件事用同一套动作，
  //     用户不会看到「有时滑一下、有时直接跳」两种脾气。
  //
  // 赋值本身会发一次 scroll 事件，浮标自己就收了；这里再补一次是防「本来就在最底、
  // 位置没变所以不发事件」那一种——补一下，状态就是确定的。
  $('toBottom').addEventListener('click', function () {
    mainEl.scrollTop = mainEl.scrollHeight;
    paintToBottom();
  });

  // ---------------- 启动 ----------------
  syncSeg();
  autoGrow();
  if (!state.entered) {
    // 服务端没放行：这是一张只用来输入令牌的门禁页。
    // 地址里那枚 token = 刚才手输（或扫码）交上来的那一枚，它没被认下来才会走到这儿——
    // 报一句人话，并把地址栏擦掉（不把输错的令牌留在那儿）。
    var bad = params.get('token');
    if (bad) history.replaceState(null, '', location.pathname);
    showGate();
    if (bad) $('gateErr').textContent = 'token 不正确，请核对后重试';
    // 被撤销的那台设备：**说清发生了什么、下一步做什么**。不说的话，用户看到的
    // 只是一张"要令牌"的页面——他昨天还能用，今天莫名其妙进不去了。
    if (DEVICE_REVOKED) $('gateRevoked').hidden = false;
  } else {
    preloadPoses();
    connect();
  }
  // 任何一次触摸都顺手解锁音频，避免用户第一次收到回复时没声音。
  document.addEventListener('touchstart', unlockAudio, { once: true });
  document.addEventListener('click', unlockAudio, { once: true });

  // -------------------------------------------------------------------------
  // 模型与思考强度（2026-09-25 用户要求：手机上要能改每个会话的模型和强度）
  //
  // 顶栏那一行显示当前用的模型，点它弹出面板可以改。强度按当前模型自己声明的
  // 档位长；模型不支持调强度时那一行不出现。
  //
  // **位置很重要**：必须写在这个外层函数**里面**——`state` 是它内部的变量，
  // 写到 `})();` 后面就看不见了，结果会是「永远不显示」而且一句错都不报。
  // 另外**不能再开一个 script 块**：这个页面的测试用贪婪正则抽取脚本，
  // 多一个块就会把中间的 HTML 整段当成 JS 解析。这个坑踩过一次，别再来一次。
  // -------------------------------------------------------------------------
  ;(function () {
    var bar = document.getElementById('modelBar')
    var text = document.getElementById('modelBarText')
    if (!bar || !text) return

    var catalog = null  // 服务端给的模型目录
    var current = null  // 服务端记的当前选择 {provider, model, reasoningEffort}
    // 上下文窗口用量 {used, window}，服务端给。取不到就是 null——那时整段不显示。
    var contextUsage = null
    // 刚改完、服务端还没确认的那个值。为什么要多这一个：服务端记的「当前模型」是在
    // **下一次请求**时才更新的，所以改完立刻回头去读，读到的还是旧名字。先信
    // set-model 的返回值，等服务端追上了再让它接管。
    var pending = null
    var busy = false   // 防止连点两下发出两个互相打架的请求

    // ---- 顶栏 ------------------------------------------------------------
    function groupName(id) {
      var gs = (catalog && catalog.groups) || []
      for (var i = 0; i < gs.length; i++) { if (gs[i].id === id) return gs[i].name }
      return id || ''
    }
    /**
     * 上下文用量那一句人话。**不编**：分子分母缺任一个就返回空串，界面据此整段不显示
     * （和「模型：还没问到」同一条口径——不知道就说不知道，不拿别的数凑）。
     *
     * 超过 100% 时按 100% 显示：它是"下一次请求大概要花多少"，压不压缩由电脑决定；
     * 把 105% 端给用户，只会让人以为哪里出错了。
     */
    function contextLabel(used, capacity) {
      if (typeof used !== 'number' || typeof capacity !== 'number') return ''
      if (!(used > 0) || !(capacity > 0)) return ''
      var pct = Math.round(used / capacity * 100)
      if (pct > 100) pct = 100
      return pct + '%'
    }

    function sel() { return pending || current || null }

    function renderBar() {
      var s = sel()
      if (!s || !s.model) {
        // 问不到这个会话用哪个模型时，如实说一句——既不装作没这个功能，也不编一个。
        // 点它还照样能打开面板挑一个，挑完就写得进去。
        text.textContent = '模型：还没问到'
        bar.style.display = 'flex'
        return
      }
      // 来源名要用 DSH 给的那个（「DeepSeek」「opencode go」「mimo」），不是内部 id
      var parts = [groupName(s.provider), s.model]
      if (s.reasoningEffort) parts.push('思考 ' + s.reasoningEffort)
      // 上下文用得怎么样。取不到就什么都不加——不显示 0%，也不写"未知"占位。
      var ctxText = contextLabel(contextUsage && contextUsage.used, contextUsage && contextUsage.window)
      if (ctxText) parts.push(ctxText)
      text.textContent = parts.join(' · ')
      bar.style.display = 'flex'
    }

    // ---- 选择面板 --------------------------------------------------------
    function el(tag, css, txt) {
      var e = document.createElement(tag)
      if (css) e.style.cssText = css
      if (txt != null) e.textContent = txt
      return e
    }
    var ROW = 'display:block;width:100%;text-align:left;background:none;border:0;font:inherit;'
      + 'color:inherit;padding:11px 2px;border-bottom:1px solid var(--line,#333)'
    var HEAD = 'padding:14px 2px 4px;font-size:12px;color:var(--dim,#888)'
    var CHIP = 'margin:0 6px 6px 0;padding:5px 13px;border:1px solid var(--line,#444);'
      + 'border-radius:var(--r,2px);background:none;font:inherit;color:inherit;font-size:13px'

    // 面板用代码建出来、挂在 body 末尾，而不是写进页面结构里——这样这一整块的
    // 改动全部落在脚本内部，不用动 HTML，也就不会碰到别的部分。
    var mask = el('div', 'position:fixed;inset:0;background:var(--scrim);z-index:69;display:none')
    var sheet = el('div', 'position:fixed;left:0;right:0;bottom:0;z-index:70;display:none;'
      + 'max-height:72vh;overflow-y:auto;background:var(--bg,#1b1b1b);'
      + 'border-top:1px solid var(--line,#444);border-radius:var(--r,2px) var(--r,2px) 0 0;'
      + 'padding:10px 14px calc(16px + env(safe-area-inset-bottom))')
    document.body.appendChild(mask)
    document.body.appendChild(sheet)

    function renderSheet() {
      sheet.textContent = ''
      var s = sel() || {}
      sheet.appendChild(el('div', 'font-size:13px;color:var(--dim,#888);padding:2px 2px 6px',
        '这个会话用哪个模型'))
      if (!catalog) { sheet.appendChild(el('div', 'padding:12px 2px', '还没读到模型列表。')); return }

      var groups = catalog.groups || []
      for (var gi = 0; gi < groups.length; gi++) {
        var grp = groups[gi]
        sheet.appendChild(el('div', HEAD, grp.name || grp.id))
        var models = grp.models || []
        for (var mi = 0; mi < models.length; mi++) {
          var mod = models[mi]
          var isCur = s.provider === grp.id && s.model === mod.id
          var b = el('button', ROW, (isCur ? '✓ ' : '') + (mod.name || mod.id))
          if (isCur) b.style.fontWeight = '600'
          b.addEventListener('click', picker(grp.id, mod.id))
          sheet.appendChild(b)

          // 强度只在**当前这个模型**下面出现，而且只画它自己声明的档位——DeepSeek 是
          // off/low/high/max，opencode 和 mimo 是 minimal…max，两套不一样，不能合并成
          // 一个统一的说法。模型没声明强度时（五十个里有四十三个）这里什么都不画，
          // 不给一个拖了没反应的控件。
          var r = mod.reasoning
          if (isCur && r && r.efforts && r.efforts.length) {
            var box = el('div', 'padding:8px 2px 12px;border-bottom:1px solid var(--line,#333)')
            for (var ei = 0; ei < r.efforts.length; ei++) {
              var ef = r.efforts[ei]
              var on = s.reasoningEffort === ef.id
              var c = el('button', CHIP + (on ? ';border-color:currentColor;font-weight:600' : ''),
                (on ? '✓ ' : '') + (ef.name || ef.id))
              c.addEventListener('click', picker(grp.id, mod.id, ef.id))
              box.appendChild(c)
            }
            sheet.appendChild(box)
          }
        }
      }

      // 某个来源读不到时如实说出来，不要假装整份目录都是全的
      var fails = catalog.failures || []
      for (var fi = 0; fi < fails.length; fi++) {
        sheet.appendChild(el('div', 'padding:10px 2px;font-size:13px;color:var(--dim,#888)',
          '⚠ ' + (fails[fi].name || fails[fi].id) + '：' + (fails[fi].message || '读不到')))
      }

      var close = el('button', ROW + ';border-bottom:0;text-align:center;color:var(--dim,#888)', '关闭')
      close.addEventListener('click', closeSheet)
      sheet.appendChild(close)
    }

    // 把参数用闭包封起来。循环里直接写回调会全都指向最后一项——这是老坑了。
    function picker(provider, model, effort) {
      return function () { if (!busy) pick(provider, model, effort) }
    }

    function pick(provider, model, effort) {
      var body = { provider: provider, model: model }
      if (effort) body.reasoningEffort = effort
      busy = true
      fetch('/mini/api/set-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
        .then(function (r) { return r.json().catch(function () { return null }) })
        .then(function (d) {
          busy = false
          if (!d || !d.ok) { alert('没改成：' + ((d && d.error) || '电脑那边没答应')); return }
          var v = d.selected || body
          pending = { provider: v.provider, model: v.model, reasoningEffort: v.reasoningEffort || null }
          renderBar()
          renderSheet()
        })
        .catch(function () { busy = false; alert('没改成：连不上电脑。') })
    }

    function openSheet() { renderSheet(); mask.style.display = 'block'; sheet.style.display = 'block' }
    function closeSheet() { mask.style.display = 'none'; sheet.style.display = 'none' }

    // ---- 读目录 ----------------------------------------------------------
    function load() {
      if (!state.entered) return
      fetch('/mini/api/models', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (d) {
          if (!d || !d.ok) return
          catalog = d
          // **问不到就说问不到，绝不用目录默认值兜底。**
          //
          // 上一版这里写的是「没记下就显示目录默认值」，看着体贴，实际是编的：
          // 目录那个默认值等于「上一次选过的模型」，于是用户切到一个用别的模型的
          // 会话，顶栏显示的还是上一个模型——一个像模像样的错答案，比空着坏得多。
          current = (d.current && d.current.model) ? d.current : null
          // 用量跟着模型一起回来（同一条接口）。**不校验内容**：给它什么显示什么，
          // 拿不准的由下面那个纯函数挡掉。刷新频率就是这一条接口的频率（15 秒一次）。
          contextUsage = d.context || null
          // 服务端追上了就撤掉本地那个临时值，之后一律以服务端的为准
          if (pending && current && current.provider === pending.provider
              && current.model === pending.model) pending = null
          renderBar()
          if (sheet.style.display !== 'none') renderSheet()
        })
        .catch(function () { /* 读不到就保持原样，不显示错的东西 */ })
    }

    bar.style.cursor = 'pointer'
    bar.addEventListener('click', openSheet)
    mask.addEventListener('click', closeSheet)

    // 手机切了会话要**立刻**跟上，不能等下面那个 15 秒的轮询——那段时间里顶栏显示的
    // 是上一个会话的模型，看上去就像新会话用错了模型。页面自己把「现在是哪个会话」
    // 存在 state.boundSessionId 里（状态广播一到就更新），盯着它很便宜。
    var lastSession = state.boundSessionId || null
    setInterval(function () {
      var id = state.boundSessionId || null
      if (id === lastSession) return
      lastSession = id
      pending = null   // 上一个会话身上那个临时值，跟这个会话没关系，必须扔掉
      load()
    }, 1000)

    load()
    // 在电脑上改了模型，手机这边也要跟上。**轮询很土，但这里是诚实的做法**：
    // 显示一个过期的模型名比不显示更糟——用户会以为自己改的没生效。
    setInterval(function () { if (!document.hidden) load() }, 15000)
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load() })
    // 上面那个轮询管"显示的东西新不新"，这个管"**手里这份页面**是不是过期了"——
    // 插件重启过就要刷一次，不然页面会拿着旧的切帧规则去切新的立绘（见 watchBuild 注释）。
    // 30 秒的间隔够用：它防的是"重启之后一直拿着旧页面"，不是实时性。
    setInterval(watchBuild, 30000)
    // 手机把页面挂到后台时定时器会被压住，切回来那一刻补一次检查。
    document.addEventListener('visibilitychange', function () { if (!document.hidden) watchBuild() })
  })();

  /** 点消息里的图 → 全屏预览（2026-11-05）；文件链接仍走原来那条只读抽屉。 */
  function openImgView(src) {
    var box = $('imgView'), img = $('imgViewImg');
    if (!box || !img || !src) return;
    img.src = src; box.classList.remove('zoom'); box.hidden = false;
  }
  document.addEventListener('click', function (e) {
    var t = e.target, box = $('imgView');
    // 存到手机（2026-11-14）：走浏览器下载，落到「下载」目录。
    // 为什么不写相册：写相册要原生那边申请媒体库权限，一张图不值得多一次授权。
    if (t && t.id === 'imgViewSave') {
      var img = $('imgViewImg');
      var src = img && img.getAttribute('src');
      if (!src) return;
      var a = document.createElement('a');
      a.href = src;
      a.download = '图片-' + Date.now() + '.jpg';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('已存到「下载」');
      return;
    }
    if (t && t.classList && t.classList.contains('md-img')) { openImgView(t.getAttribute('src')); return; }
    if (box && !box.hidden && t && (t.id === 'imgView' || t.id === 'imgViewImg' || t.id === 'imgViewClose')) {
      box.hidden = true; box.classList.remove('zoom'); $('imgViewImg').removeAttribute('src');
    }
  });
  document.addEventListener('dblclick', function (e) {
    var box = $('imgView');
    if (box && !box.hidden && e.target && e.target.id === 'imgViewImg') box.classList.toggle('zoom');
  });

  /**
   * 安卓原生壳用：系统分享进来的内容**放进输入框**，不直接发送（2026-11-06）。
   * 文件已经在原生层传完，这里只挂 uploadId；挂好之后和用户自己选的附件完全一样，
   * 发送那条路一个字都不用改。返回挂上的文件数，原生靠它判断成功与否。
   */
  window.miniComposeShare = function (payload) {
    if (!payload) return 0;
    var text = typeof payload.text === 'string' ? payload.text : '';
    if (text) {
      inputEl.value = inputEl.value ? inputEl.value.replace(/\s*$/, '') + '\n' + text : text;
      autoGrow();
    }
    var list = Array.isArray(payload.uploads) ? payload.uploads : [];
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (!item || !item.uploadId) continue;
      state.uploads.push({
        uploadId: String(item.uploadId),
        name: String(item.name || '文件'),
        bytes: Number(item.bytes) || 0,
        file: null,
      });
    }
    renderAttach();
    return list.length;
  };
})();
