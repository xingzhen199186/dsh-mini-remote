  // ---------------- 左侧导航栏 ----------------
  // 数据分两层取：先列工作区（便宜），展开某个再去要它的会话（要读日志折标题，贵）。
  // 本机实测 35 个工作区、最多的一个有 452 个会话，一次全拉会卡住手机。
  var navList = null;      // 工作区列表，开一次取一次
  var navSessions = {};    // workspaceId -> { sessions, total, truncated }
  // 会话搜索（2026-11-14）：只按标题即时匹配，内容搜索往后放。
  var navQuery = '';
  var navFollowTimers = {}; // workspaceId -> 当前标题补齐轮询定时器
  var navExpanded = {};    // workspaceId -> 是否展开
  var navWsFetching = {};  // workspaceId -> 会话列表请求在途（同一工作区只发一趟）
  var navPresets = null;   // Agent 模式清单（2026-10-04：新建会话时手机上也要能选模式）
  var navPresetsLoaded = false;
  var navPickerWs = '';    // 正在挑模式的那个工作区（清单行内展开在它的「新建会话」下）
  // —— 会话条目的执行功能（2026-10-09）——
  /**
   * 「显示已归档」这枚筛选开关**摆在界面外**：用户 2026-10-09 要求——这个功能不需要，
   * 但既然做了，先别删、隐藏起来。
   *
   * 所以下面这一整套**一行都没删**，只是不再画到界面上：开关的渲染（renderNav 里
   * 那一段还在）、navShowArchived 这个状态、setShowArchived、拼请求时的 archived=1、
   * 服务端那条筛选口径、以及相关测试。
   *
   * **要恢复这个开关：把这一行的 false 改成 true 就行**，别的地方一处都不用动。
   */
  var SHOW_ARCHIVED_FILTER = false;
  /**
   * 「另有 N 条已归档、M 条还是空白的新会话」这句**也不摆到界面上**：
   * 用户 2026-10-09 要求——这句不需要显示，先不删、隐藏起来。
   *
   * 所以那句话的渲染、以及支撑它的两个数（hiddenArchived / hiddenBlank，服务端照旧在算、
   * 照旧随列表一起回来）**一行都没删**，只是不再画出来。
   * 注意闸住的**只是这半句**：同一块里前面那句「这个工作区里没有能列出来的会话。」
   * 照旧摆着——那是"会话全被筛掉了"这个情形的兜底文字，一起藏掉的话，
   * 工作区标题下面就是一片空白，用户会以为界面坏了。
   *
   * **要恢复这句话：把下面这一行的 false 改成 true 就行**，别的地方一处都不用动。
   */
  var SHOW_NAV_COUNT_HINT = false;
  var navShowArchived = false; // 筛选：默认**隐藏已归档**（官方默认项就是这个）
  var navActing = '';      // 正在行内展开动作条的那条会话 id
  var navRenaming = '';    // 正在改名字的那条会话 id
  var navConfirm = null;   // 归档确认：{ sessionId, title, activity }；非空就是弹着
  var navExtra = {};       // workspaceId -> 已经点了几次「展开其余」
  var navLimit = {};       // workspaceId -> 这次向服务端要了多少条（要更多时递增）

  /**
   * 「展开其余」一次多几条。**这个 5 是官方口径**，不是我们挑的：
   * PC 侧栏的文档原话是「默认只显示 5 条空闲 Session……每次点击『展开其余』最多再显示五条」。
   * 正在跑的会话不占这 5 条配额，始终显示——同一个来源。
   */
  var NAV_IDLE_QUOTA = 5;
  /** 一次向服务端要多少条。要少了「展开其余」很快就没得展开；要多了标题那一步很贵。 */
  var NAV_PAGE = 20;

  function openNav() {
    $('nav').classList.add('open');
    loadWorkspaces(false);
  }
  function closeNav() { $('nav').classList.remove('open'); }

  function loadWorkspaces(force) {
    if (navList && !force) { renderNav(); return; }
    if (!force && navPrefetchPromise) {
      $('navBody').innerHTML = '<div class="placeholder">正在读取…</div>';
      navPrefetchPromise.then(function () {
        if ($('nav').classList.contains('open')) renderNav();
      }).catch(function (err) {
        navList = null;
        $('navBody').innerHTML = '<div class="placeholder">读不到会话列表：'
          + escapeHtml(err.message) + '</div>';
      });
      return;
    }
    $('navBody').innerHTML = '<div class="placeholder">正在读取…</div>';
    // 带 refresh=1 是给 ⟳ 用的：绕过服务端的短时缓存，真去读一遍。
    // 不带的话服务端会把最近一次的结果直接给你，导航栏就不再「每次都要重新读取」。
    api('/mini/api/workspaces' + (force ? '?refresh=1' : '')).then(function (body) {
      navList = body.workspaces || [];
      navSessions = {};
      renderNav();
    }).catch(function (err) {
      navList = null;
      $('navBody').innerHTML = '<div class="placeholder">读不到会话列表：'
        + escapeHtml(err.message) + '</div>';
    });
  }

  // 导航栏不是首屏内容，但用户通常会在连上手机后很快点左上角。
  // 趁页面空闲先取一次；真正打开菜单时若已完成就直接画，不再把等待放在点击之后。
  var navPrefetchPromise = null;
  function prefetchWorkspaces() {
    // Agent 模式清单也是导航栏要用的、也几乎不变——顺手一起预取（见 prefetchPresets）。
    prefetchPresets();
    if (navList || navPrefetchPromise || navView !== 'tree' || !state.entered) return;
    var run = function () {
      navPrefetchPromise = api('/mini/api/workspaces').then(function (body) {
        navList = body.workspaces || [];
        navSessions = {};
        if ($('nav').classList.contains('open')) renderNav();
      }).finally(function () { navPrefetchPromise = null; });
      navPrefetchPromise.catch(function () {
        // 预取失败不改变导航栏原来的行为，用户打开时仍会再试一次。
      });
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 1200 });
    } else {
      setTimeout(run, 0);
    }
  }

  /**
   * Agent 模式清单（2026-10-04 用户要求：新建会话时手机上也要能选模式，PC 一直可以）。
   * 只取一次；读不到就如实记「没有可选的」——建会话那条路会直接建默认，
   * **不摆一个只有一项的选择题**，也不假装自己知道 DSH 有哪些模式。
   */
  function prefetchPresets() {
    if (navPresetsLoaded || !state.entered) return;
    navPresetsLoaded = true;
    api('/mini/api/agent-presets').then(function (body) {
      navPresets = body && body.ok ? body : { ok: false, reason: (body && body.reason) || 'failed' };
      if (navPickerWs && $('nav').classList.contains('open')) renderNav();
    }).catch(function () {
      navPresets = { ok: false, reason: 'failed' };
    });
  }

  function dayLabel(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return timeLabel(ts);
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '/' + d.getDate();
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  function renderNav() {
    // 目录浏览那一屏接管整个面板。它自己画返回按钮，所以不走下面这套。
    if (navView === 'browse') { renderBrowse(); return; }
    // 自愈：navigation-refresh（会话开跑/收工都会广播）清得掉数据、清不掉展开态，
    // 重画出来的就是永远停着的「正在读取…」——取列表的请求原来只在点击时发，
    // 没人补发就一直停着（真机报过：收起再展开才好，2026-10-03）。缺数据的补拉一次，
    // loadWsSessions 自带在途闩，重复调用不会发第二趟。
    Object.keys(navExpanded).forEach(function (id) { loadWsSessions(id); });
    var list = navList || [];
    // 「新建工作区」常驻在最上面：它是这一屏的入口，不该等有了会话才出现——
    // 一个工作区都还没有的人，恰恰最需要它。
    var cta = '<button class="nav-cta" type="button" data-new-ws="1">＋ 新建工作区</button>';
    // 搜索框常驻在最上面：会话多的工作区，翻列表比打字慢得多。
    var box = '<input class="nav-search" type="search" data-search="1" placeholder="搜索会话标题"'
      + ' value="' + escapeHtml(navQuery) + '">';
    if (navQuery.trim()) {
      $('navBody').innerHTML = box + navSearchHtml(navQuery);
      return;
    }
    // 「显示已归档」是**整屏一个**的口径，所以放在 CTA 下面、工作区上面：
    // 它管的不是某一个工作区，是所有工作区里"已归档的那些要不要出现"。
    // 默认关（官方的默认项就是"隐藏已归档"）。
    //
    // 整块由 SHOW_ARCHIVED_FILTER 闸住（见那个常量上的说明）：闸住时这一段一个字都不画，
    // **但渲染代码原样留着**——恢复就是改那一个词，不用重写。
    var filter = SHOW_ARCHIVED_FILTER
      ? '<button class="nav-filter' + (navShowArchived ? ' on' : '')
        + '" type="button" data-archived-toggle="1" aria-pressed="' + (navShowArchived ? 'true' : 'false')
        + '">' + (navShowArchived ? '✓ ' : '')
        + (navShowArchived ? '显示已归档（点一下收起来）' : '显示已归档') + '</button>'
      : '';
    if (!list.length) {
      $('navBody').innerHTML = box + cta + filter + '<div class="placeholder">电脑上还没有可以切换的会话。<br>'
        + '在电脑上开一个，这里就会出现了。</div>';
      return;
    }
    $('navBody').innerHTML = box + cta + filter + list.map(function (ws) {
      var open = Boolean(navExpanded[ws.id]);
      return '<div class="ws' + (open ? ' open' : '') + '" data-ws="' + escapeHtml(ws.id) + '">'
        + '<button class="ws-head" type="button">'
        + '<span class="caret">▶</span>'
        + '<span class="ws-title">' + escapeHtml(ws.title) + '</span>'
        + (ws.running ? '<span class="s-dot"></span>' : '')
        // 空工作区（通常是刚在手机上建的那个）不写「0」，写「还没有会话」：
        // 一个孤零零的 0 看着像出了错，说清楚反而让人知道下一步该干什么。
        + '<span class="ws-count">' + (ws.count || (ws.empty ? '新' : 0)) + '</span>'
        + '</button>'
        + '<div class="ws-body">' + (open ? sessionsHtml(ws.id) : '') + '</div>'
        + '</div>';
    }).join('');
  }

  /**
   * 按标题搜：工作区名命中就列出它的会话，会话名命中就直接列。
   *
   * 只翻**已经加载到手机上的**那些会话——没展开过的工作区这里搜不到，
   * 但会给一句实话，而不是假装"没有"。2026-11-14。
   */
  function navSearchHtml(query) {
    var found = searchSessions(navList || [], navSessions, query)
    if (found.empty) {
      return '<div class="placeholder">没找到叫「' + escapeHtml(found.query) + '」的会话。'
        + (found.hidden ? '<br>还有 ' + found.hidden + ' 个工作区的会话没加载，展开后才能搜到。' : '')
        + '</div>'
    }
    return '<div class="search-list">' + found.rows.map(function (one) {
      if (!one.id) return '<div class="search-row dim">' + escapeHtml(one.title) + '</div>'
      return '<button class="search-row" type="button" data-sess="' + escapeHtml(one.id) + '">'
        + '<span class="s-title">' + escapeHtml(one.title) + '</span>'
        + '<span class="search-ws">' + escapeHtml(one.ws) + '</span></button>'
    }).join('') + '</div>'
  }

  /** 这个工作区现在到底该摆出哪几条。**口径都在这里，一处说了算。** */
  function navVisible(wsId, got) {
    var ex = navExtra[wsId] || 0;
    var quota = NAV_IDLE_QUOTA * (ex + 1);
    var rows = [];
    var idleShown = 0;
    var idleTotal = 0;
    (got.sessions || []).forEach(function (s) {
      if (s.running === true) { rows.push(s); return; }
      idleTotal += 1;
      if (idleShown < quota) { rows.push(s); idleShown += 1; }
    });
    var remaining = Math.max(0, idleTotal - idleShown);
    return {
      rows: rows,
      quota: quota,
      // 页里还有没摆出来的，或者服务端说这个工作区还有没取回来的——两种都算"还有"
      more: remaining > 0 || got.truncated === true,
      remaining: remaining,
      expandable: remaining > 0 || got.truncated === true,
      // 按钮上那个数：官方口径是"每次最多再显示五条"，所以最多写 5。
      step: remaining > 0 ? Math.min(NAV_IDLE_QUOTA, remaining) : NAV_IDLE_QUOTA,
      collapsed: ex > 0 && !(remaining > 0 || got.truncated === true),
    };
  }

  /** 一条会话在行尾该显示什么。**一行只显示一个**：尾部那块地方只够一样。 */
  function navTail(s) {
    if (s.pending === 'approval') return '<span class="s-flag pending">待审批</span>';
    if (s.pending === 'plan') return '<span class="s-flag pending">计划待审</span>';
    if (s.pending === 'question') return '<span class="s-flag pending">待回答</span>';
    var badge = '';
    if (s.archived) badge = '<span class="s-flag">已归档</span>';
    else if (s.pinned) badge = '<span class="s-flag">已置顶</span>';
    return badge + '<span class="s-meta">' + dayLabel(s.createdAt) + '</span>';
  }

  /**
   * 动作条。**归档行不给置顶**——官方规定归档与置顶互斥（归档会把置顶一并丢掉），
   * 摆一个按了会被拒的按钮，比不摆更糟。
   *
   * 顺序照电脑端的槽位号摆（2026-10-09 从 0.2.0-rc.2 的 `dsh-client-ui-workspace` 读到原文）：
   * `sidebar.workspaces.session.menu.item` 上 pin=order 100、rename=200、**fork=300**、
   * archive=400。手机这一条横排也是一样的先后，用户从电脑换到手机上不用重新找。
   *
   * 分叉这一项**归档行也留着**：官方的菜单项没有"归档就不给分叉"这条判断
   * （只有 pin 那一个在归档行上返回 null），而且分叉出来的是一条独立的新会话。
   */
  function navActs(s) {
    var id = escapeHtml(s.id);
    var pin = s.archived
      ? ''
      : '<button type="button" data-act="pin" data-act-id="' + id + '" data-act-on="'
        + (s.pinned ? '1' : '0') + '">' + (s.pinned ? '取消置顶' : '置顶会话') + '</button>';
    var arc = s.archived
      ? '<button type="button" data-act="unarchive" data-act-id="' + id + '">取消归档</button>'
      : '<button type="button" class="danger" data-act="archive" data-act-id="' + id + '">归档会话</button>';
    return '<div class="sess-acts">'
      + pin
      + '<button type="button" data-act="rename" data-act-id="' + id + '">重命名</button>'
      + '<button type="button" data-act="fork" data-act-id="' + id + '">分叉会话</button>'
      + arc
      + '</div>'
      // 「分叉」是个电脑词，非技术用户看不出它会干什么。这句是**极短的说明**：
      // 只说两件事——从哪儿分（最近完成的一轮）、原会话会怎样（不动）。
      // 不加的话，用户能猜到的只有"分叉"两个字，而按下去是**在电脑上真建一个会话**，
      // 不是可以随便试的手势，所以这笔字值得花。
      + '<div class="sess-acts-hint">分叉＝从最近完成的一轮复制出一个新会话，原来这条不动。</div>';
  }

  function sessionsHtml(wsId) {
    // 「新建会话」永远排在最上面：不管这个工作区有几个会话、甚至一个都没有，
    // 这一行都在。放在列表末尾的话，一个 452 条会话的工作区要划到底才看得到。
    var html = '<button class="ws-new" type="button" data-newws="' + escapeHtml(wsId) + '">'
      + '＋ 新建会话</button>';
    // 模式清单（2026-10-04）：多于一种模式时，「新建会话」先把清单行内展开，
    // 点谁建谁；坏档如实标「不可用」——不装作能点。
    if (navPickerWs === wsId && navPresets && navPresets.ok && navPresets.presets.length > 1) {
      html += '<div class="ws-modes">' + navPresets.presets.map(function (m) {
        var title = '<b>' + escapeHtml(m.name || m.id) + '</b>';
        var desc = m.description
          ? '<span class="ws-mode-desc">' + escapeHtml(m.description) + '</span>' : '';
        var def = navPresets.defaultId === m.id ? '<span class="ws-mode-def">默认</span>' : '';
        if (m.broken) {
          return '<div class="ws-mode ws-mode-broken">' + title
            + '<span class="ws-mode-desc">不可用：' + escapeHtml(m.broken) + '</span></div>';
        }
        return '<button class="ws-mode" type="button" data-mode-ws="' + escapeHtml(wsId)
          + '" data-mode-preset="' + escapeHtml(m.id) + '">' + title + desc + def + '</button>';
      }).join('') + '</div>';
    }
    var got = navSessions[wsId];
    if (!got) return html + '<div class="placeholder">正在读取…</div>';
    if (!got.sessions.length) {
      // 「一条都没有」和「都被筛掉了」是两件事，得分开说——不然用户会以为
      // 自己的会话不见了（就在刚才，那还是他亲手归档的）。
      var hid = (got.hiddenArchived || 0) + (got.hiddenBlank || 0);
      if (hid > 0) {
        // 后半句（那两条条数）由 SHOW_NAV_COUNT_HINT 闸住（见那个常量上的说明）：
        // 闸住时只少这半句，**前面那句兜底照旧画**——全都不画就成了工作区标题下面
        // 一片空白，用户只会以为界面坏了。恢复就是改那一个词。
        var hint = SHOW_NAV_COUNT_HINT
          ? '<br>另有 ' + (got.hiddenArchived || 0) + ' 条已归档、'
            + (got.hiddenBlank || 0) + ' 条还是空白的新会话。'
          : '';
        return html + '<div class="placeholder">这个工作区里没有能列出来的会话。'
          + hint + '</div>';
      }
      return html + '<div class="placeholder">这个工作区还没有会话。</div>';
    }
    var cur = state.boundSessionId;
    var view = navVisible(wsId, got);
    html += view.rows.map(function (s) {
      var cls = 'sess';
      if (s.id === cur) cls += ' cur';
      // 已归档的行置灰，而且**点不开**——官方原话是「已归档对话暂时无法查看，
      // 请取消归档后查看」。留着可点会是更坏的结果：点进去是一个空会话。
      if (s.archived) cls += ' archived';
      if (navActing === s.id) cls += ' acting';
      if (navRenaming === s.id) cls += ' renaming';
      // 行首那颗点：**有等着的就显示等着的**（照 PC：「待处理交互的优先级高于
      // 共享 ongoing loading」）；没有等着才轮到"正在跑"。
      var dot = s.pending
        ? '<span class="s-dot pending"></span>'
        : (s.running ? '<span class="s-dot"></span>' : '');
      var row = '<div class="sess-line">'
        + '<button class="' + cls + '" type="button"'
        + ' data-sess="' + escapeHtml(s.id) + '">'
        + dot
        // 没有标题就用日期——原来退到取 id 的前 8 位当名字，而本机真有一个会话的 id
        // 以「session-」开头，于是整列都显示成一样的「session-」，等于没有名字。
        + '<span class="s-title">' + escapeHtml(s.title || '未命名会话') + '</span>'
        + navTail(s)
        + '</button>'
        // ⋯ 是**兄弟**不是子节点：塞进那个 button 里就成了"按钮里套按钮"，
        // 点它会同时触发"打开会话"，而且那种结构本身是无效的。
        + '<button class="s-more" type="button" aria-label="会话操作"'
        + ' data-more-menu="' + escapeHtml(s.id) + '">⋯</button>'
        + '</div>';
      if (navActing === s.id) row += navActs(s);
      if (navRenaming === s.id) {
        row += '<div class="sess-rename">'
          // 预填的是**真实标题**（没有就是空的），绝不是「未命名会话」那个显示占位——
          // 把占位当标题提交，就等于凭空把"未命名"三个字钉成一个真标题。
          + '<input id="renameInput" type="text" value="' + escapeHtml(s.title || '')
          + '" placeholder="给这个会话起个名字" aria-label="会话标题">'
          + '<button type="button" data-rename-cancel="1">取消</button>'
          + '<button type="button" data-rename-ok="1">确定</button>'
          + '</div>';
      }
      return row;
    }).join('');
    // 「展开其余 N 个 / 收起」。**这里原来是一句死话**（「只列了最近 N 条，共 M 条」），
    // 展不开也搜不了，用户只能去电脑上找。现在按官方口径真的展开。
    if (view.expandable) {
      html += '<button class="sess-more" type="button" data-more="' + escapeHtml(wsId) + '">'
        + '展开其余 ' + view.step + ' 个</button>';
    } else if (view.collapsed) {
      html += '<button class="sess-more" type="button" data-less="' + escapeHtml(wsId) + '">收起</button>';
    }
    return html;
  }

  /**
   * 会话列表里的一条（拿真实数据用，比如"当前标题是什么"）。
   * 找不到返回 null——调用方据此如实说"刷新一下再看看"，而不是凭空造一个。
   */
  function navSessionById(id) {
    var keys = Object.keys(navSessions);
    for (var i = 0; i < keys.length; i++) {
      var got = navSessions[keys[i]];
      var list = (got && got.sessions) || [];
      for (var j = 0; j < list.length; j++) {
        if (list[j].id === id) return { wsId: keys[i], row: list[j], got: got };
      }
    }
    return null;
  }

  function toggleActs(id) {
    navRenaming = '';
    navActing = navActing === id ? '' : id;
    renderNav();
  }

  function startRename(id) {
    navActing = '';
    navRenaming = id;
    renderNav();
    // 光标落在末尾：用户多半是想改几个字，不是想全部重打。
    var input = $('renameInput');
    if (input && input.focus) {
      try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
    }
  }

  /**
   * 提交改名。
   *
   * **这一步就是"不误钉"的全部**：官方 `SessionTitleService.rename` 的原文是
   * 「Appends a `session/title` event with the `user` source, which **pins** the title:
   * in-flight automatic generation is superseded and later user messages schedule none」
   * ——也就是说**传什么都会钉住**，哪怕跟当前那条自动标题一字不差。
   * 所以"没改"就**根本不发这一趟**（用户双击进来又原样退出的情形很常见）。
   */
  function renameSubmit() {
    var id = navRenaming;
    var found = navSessionById(id);
    if (!found) { navRenaming = ''; renderNav(); toast('这个会话不在了，刷新一下再看看'); return; }
    var input = $('renameInput');
    var next = input ? input.value : '';
    var current = typeof found.row.title === 'string' ? found.row.title : '';
    // 只比"归一化之后"的那一份（去空白）。官方那边也会 trim，比原始串会把
    // "结尾多了一个空格"当成真改动，那正是要避开的误钉。
    if (next.trim() === current.trim()) {
      navRenaming = '';
      renderNav();
      return;
    }
    if (!next.trim()) { toast('标题不能为空'); return; }
    return api('/mini/api/session/rename', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, title: next }),
    }).then(function (res) {
      navRenaming = '';
      // 用**服务端接受的那一份**改本地这一行：官方会归一化（去控制字符、按字节截断），
      // 界面要显示的是它认下来的那个标题，不是我们递过去的那串。
      found.row.title = res && typeof res.title === 'string' ? res.title : next;
      renderNav();
      toast('已改名');
    }).catch(function (err) { toast(err.message); });
  }

  /**
   * 分叉会话。电脑端那个功能在手机上等价的一下：在**最后一个已完成轮次**处复制出
   * 一个新会话，标题递增。
   *
   * 三件事照电脑端的原样，一件都不能走样：
   *   · **不打开新会话**：PC 那条路上 `navigation.forkSession()` 之后就结束了，
   *     没有任何切换动作。所以这里也**一个字都不碰 `state.boundSessionId`**。
   *   · **成功后刷新列表**：新会话是 PC 侧栏那种"排在源会话旁边"的普通行，得重新问一次
   *     服务端才看得见。而且必须带 `refresh=1`——服务端那份会话清册有 30 秒缓存，
   *     不绕过的话用户会看到"按了但什么都没多出来"（刚建的会话它还答不上来）。
   *   · **失败时说 Host 那句话**：`err.message` 就是服务端转发过来的原话
   *     （"没有已结束的轮次"那一种带上 Host 的英文原文），这里**不加工、不换词**。
   */
  function forkAct(id) {
    return api('/mini/api/session/fork', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id }),
    }).then(function (res) {
      navActing = '';
      var found = navSessionById(id);
      refreshSessions(found ? found.wsId : '', true);
      // 把新标题报出来：手机列表可能很长，"多了一条"这句话不如"多了一条叫什么"有用，
      // 标题里那个 (1) 也正是"它是刚才那条分出来的"最直接的凭据。
      toast(res && res.title ? '已分叉出「' + res.title + '」' : '已分叉出新会话');
    }).catch(function (err) { toast(err.message); });
  }

  /** 置顶 / 取消置顶。*/
  function pinAct(id, on) {
    return api('/mini/api/session/pin', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, pinned: on }),
    }).then(function () {
      var found = navSessionById(id);
      if (found) found.row.pinned = on;
      // 置顶会改整个列表的顺序，所以这次要重新问一遍服务端（别自己在本地排——
      // 官方的置顶顺序是"最近置顶的在前"，本地排不出那个顺序）。
      refreshSessions(found ? found.wsId : '');
      navActing = '';
      toast(on ? '已置顶' : '已取消置顶');
    }).catch(function (err) { toast(err.message); });
  }

  /**
   * 归档 / 取消归档。
   *
   * `stop` 那一次往返是**官方那条两段式流程**：不带它，会话还有工作在跑时服务端会拒绝，
   * 同时把"会停掉什么"按族带回来（见 lib/index.js 的 archiveSession）。
   * 拿到那一份就弹确认框问过用户再来一次——**不自己猜会停掉什么**。
   */
  function archiveAct(id, stop) {
    return api('/mini/api/session/archive', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, stop: stop === true }),
    }).then(function () {
      // **先把确认框收掉**，再动别的。漏了这一句的后果实测过：那一层是
      // fixed/inset:0，z-index 120——归档成功之后它仍然盖在整屏上，
      // 用户接下来点哪儿都是点到它（点哪儿都当成"取消"，什么都没发生）。
      navConfirm = null;
      renderNavConfirm();
      navActing = '';
      var found = navSessionById(id);
      if (found) { found.row.archived = true; found.row.pinned = false; }
      refreshSessions(found ? found.wsId : '');
      toastAction('会话已归档', '撤销', function () {
        api('/mini/api/session/unarchive', {
          method: 'POST', body: JSON.stringify({ sessionId: id }),
        }).then(function () {
          var f = navSessionById(id);
          if (f) f.row.archived = false;
          refreshSessions(f ? f.wsId : '');
          toast('已取消归档');
        }).catch(function (err) { toast(err.message); });
      });
    }).catch(function (err) {
      var body = err && err.body;
      if (err && err.status === 409 && body && body.reason === 'active') {
        var found = navSessionById(id);
        navConfirm = {
          sessionId: id,
          title: (found && found.row.title) || '',
          wsId: found ? found.wsId : '',
          activity: Array.isArray(body.activity) ? body.activity : [],
        };
        renderNavConfirm();
        return;
      }
      toast(err.message);
    });
  }

  /** 取消归档。说明里那句"不恢复置顶"是官方的规矩，如实说。 */
  function unarchiveAct(id) {
    return api('/mini/api/session/unarchive', {
      method: 'POST', body: JSON.stringify({ sessionId: id }),
    }).then(function () {
      navActing = '';
      var found = navSessionById(id);
      if (found) found.row.archived = false;
      refreshSessions(found ? found.wsId : '');
      toast('已取消归档');
    }).catch(function (err) { toast(err.message); });
  }

  /**
   * 官方那四族工作的中文说法。**四种一一对应，不多不少**——`kind` 是从
   * `SessionActivityKindMap`（turn / job / subagent / schedule）来的，认不出的
   * 如实写它的原名，不硬套一个近义词。
   */
  var ACTIVITY_COPY = {
    turn: '进行中的回合',
    job: '后台任务',
    subagent: '运行中的子智能体',
    schedule: '定时提醒',
  };

  function renderNavConfirm() {
    var el = $('navConfirm');
    if (!el) return;
    if (!navConfirm) { el.classList.remove('on'); return; }
    $('navConfirmDesc').textContent = '「' + (navConfirm.title || '这个会话')
      + '」还有正在进行的工作。归档会先停止这些工作；被停止的工作不会自动继续。'
      + '归档之后它就不在列表里了，接下来 6 秒里可以点提示上的「撤销」把它找回来；'
      + '过了这几秒，就得到电脑端才能取消归档。';
    var items = (navConfirm.activity || []).map(function (fam) {
      var name = ACTIVITY_COPY[fam.kind] || fam.kind;
      var labels = (fam.items || []).map(function (it) {
        return escapeHtml(it.label || it.id || '（没有名字）');
      });
      var head = '<b>' + escapeHtml(name) + '</b>：';
      // 一项一项列出来；带不下就如实说"共 N 项"，不假装只有这几项。
      var detail = labels.length ? labels.join('、') : '（没有名字）';
      var more = fam.count > labels.length ? '（共 ' + fam.count + ' 项）' : '';
      return '<li>' + head + detail + more + '</li>';
    }).join('');
    $('navConfirmList').innerHTML = items || '<li>（没能问出具体是哪几项工作）</li>';
    el.classList.add('on');
  }

  /**
   * 重新问一遍某个工作区的会话（置顶/归档之后顺序和状态都变了）。
   *
   * `force` 是给**分叉**用的：会话清册在服务端有 30 秒缓存，而分叉是"多出来一条"，
   * 缓存里根本没有它。不带 force 的那几处（置顶/归档）只要状态和顺序，缓存那份就够。
   *
   * **`loadWsSessions` 必须排在 `renderNav` 前面**（2026-10-09 活页面验证逮住的）：
   * renderNav 自己会给每个展开着的工作区起一趟 `loadWsSessions(id)`（**不带 force**），
   * 而那一趟会先把 `navWsFetching` 占住——后面这一趟带 force 的就被那道闩挡在门外，
   * 结果新会话压根没被取回来（界面看着像"按了没反应"）。先起带 force 的这一趟，
   * renderNav 顺手起的那一趟自然就被同一道闩挡掉了。
   */
  function refreshSessions(wsId, force) {
    if (!wsId) { loadWorkspaces(true); return; }
    delete navSessions[wsId];
    delete navWsFetching[wsId];
    loadWsSessions(wsId, force);
    renderNav();
  }

  /** 「展开其余」：页里还有就只是多摆几条；页里没了就去服务端多要一批。 */
  function expandMore(wsId) {
    var got = navSessions[wsId];
    var view = got ? navVisible(wsId, got) : null;
    if (view && view.remaining > 0) {
      navExtra[wsId] = (navExtra[wsId] || 0) + 1;
      renderNav();
      return;
    }
    // 页里已经摆完了，但服务端说这个工作区还有没取回来的：把这次要的条数翻上去。
    navExtra[wsId] = (navExtra[wsId] || 0) + 1;
    navLimit[wsId] = Math.min(100, (navLimit[wsId] || NAV_PAGE) + NAV_PAGE * 2);
    delete navSessions[wsId];
    delete navWsFetching[wsId];
    loadWsSessions(wsId);
  }

  function collapseMore(wsId) {
    navExtra[wsId] = 0;
    renderNav();
  }

  // 筛选一改，所有工作区那份数据就都不作数了（服务端按筛选给的是不同的列表）。
  // **展开次数也一起归零**：换了口径还停在"展开了 3 页"，用户会莫名其妙的。
  function setShowArchived(on) {
    navShowArchived = on === true;
    navSessions = {};
    navExtra = {};
    navLimit = {};
    navActing = '';
    navRenaming = '';
    Object.keys(navFollowTimers).forEach(function (id) { clearTimeout(navFollowTimers[id]); });
    navFollowTimers = {};
    renderNav();
  }

  // ---------------- 新建工作区：浏览电脑目录 ----------------
  //
  // 面板里有两个「屏」：工作区树（默认）和目录浏览。用一个变量记当前在哪一屏，
  // 而不是再开一层浮层——手机屏幕就这么大，多一层就多一次「怎么退回去」。
  //
  // 起点给「常用位置」（主目录 / 最近用过 / 磁盘），不是直接甩盘符：
  // 从 C:\ 一层层点进去找一个项目文件夹，是要人自己知道路径长什么样。
  var navView = 'tree';
  var browseRoots = null;   // 常用位置，开一次取一次
  var browseAt = null;      // 当前所在目录；null = 还在看常用位置
  var browseData = null;    // 当前目录的列表
  var browseMkdir = false;  // 是不是正在新建文件夹（那一行输入框露出来没有）
  var browseBusy = false;   // 防连点

  function dirName(p) {
    var parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(p);
  }

  function openBrowse() {
    navView = 'browse';
    browseAt = null;
    browseData = null;
    browseMkdir = false;
    renderNav();
    if (browseRoots) return;
    api('/mini/api/browse/roots').then(function (body) {
      browseRoots = body;
      renderNav();
    }).catch(function (err) {
      browseRoots = null;
      $('navBody').innerHTML = '<button class="nav-cta" type="button" data-browse-back="1">← 返回</button>'
        + '<div class="placeholder">读不到常用位置：' + escapeHtml(err.message) + '</div>';
    });
  }

  function browseTo(p) {
    navView = 'browse';
    browseAt = p;
    browseData = null;
    browseMkdir = false;
    renderNav();
    api('/mini/api/browse?path=' + encodeURIComponent(p)).then(function (body) {
      browseData = body;
      renderNav();
    }).catch(function (err) {
      browseData = { ok: false, error: err.message };
      renderNav();
    });
  }

  /** 目录浏览那一屏。路径来自服务端，这里只负责画。 */
  function renderBrowse() {
    var html = '<button class="nav-cta" type="button" data-browse-back="1">← 返回</button>';

    if (!browseAt) {
      if (!browseRoots) {
        $('navBody').innerHTML = html + '<div class="placeholder">正在读取…</div>';
        return;
      }
      // 顺序有讲究：主目录（最常用）→ 最近用过（第二常用）→ 磁盘（兜底）。
      // 磁盘排最后，因为「从盘符一层层点」正是我们要避免的那种走法。
      var rows = [{ name: '主目录', path: browseRoots.home, tag: '常用' }];
      (browseRoots.recent || []).forEach(function (p) {
        rows.push({ name: dirName(p), path: p, tag: '最近' });
      });
      (browseRoots.drives || []).forEach(function (p) {
        rows.push({ name: p, path: p, tag: '磁盘' });
      });
      html += '<div class="nav-note">挑一个文件夹，登记成工作区。</div>';
      html += rows.map(function (r) {
        return '<button class="sess" type="button" data-browse-to="' + escapeHtml(r.path) + '">'
          + '<span class="s-title">' + escapeHtml(r.name) + '</span>'
          + '<span class="s-meta">' + escapeHtml(r.tag) + '</span>'
          + '</button>';
      }).join('');
      $('navBody').innerHTML = html;
      return;
    }

    if (!browseData) {
      $('navBody').innerHTML = html + '<div class="placeholder">正在读取…</div>';
      return;
    }
    if (!browseData.ok) {
      // 读不到时**如实说**，不装作空目录——两者在界面上长得一模一样，
      // 而「没有权限」和「本来就是空的」对用户是两件事。
      $('navBody').innerHTML = html + '<div class="crumb"><span class="here">'
        + escapeHtml(dirName(browseAt)) + '</span></div>'
        + '<div class="placeholder">' + escapeHtml(browseData.error || '读不到这个目录。') + '</div>';
      return;
    }

    // 面包屑：能一路点回上去。最后一格是当前目录，不再可点。
    var chain = browseData.ancestors || [];
    html += '<div class="crumb">' + chain.map(function (a, i) {
      var last = i === chain.length - 1;
      var piece = last
        ? '<span class="here">' + escapeHtml(a.name) + '</span>'
        : '<button type="button" data-browse-to="' + escapeHtml(a.path) + '">'
          + escapeHtml(a.name) + '</button><span class="sep">›</span>';
      return piece;
    }).join('') + '</div>';

    html += '<button class="pick-here" type="button" data-pick="' + escapeHtml(browseData.path) + '">'
      + '就选这个目录</button>';

    if (browseMkdir) {
      // 内联输入，不用 window.prompt：prompt 在微信这类内嵌浏览器里会被直接
      // 屏蔽掉，那时候用户点「新建文件夹」什么都不发生，而且没有任何提示。
      html += '<div class="mkdir-row">'
        + '<input id="mkdirName" type="text" placeholder="新文件夹的名字" autocomplete="off">'
        + '<button type="button" data-mkdir-ok="1">建</button>'
        + '<button type="button" data-mkdir-cancel="1">取消</button>'
        + '</div>';
    } else {
      html += '<button class="ws-new" type="button" data-mkdir="1">＋ 新建文件夹</button>';
    }

    if (!browseData.dirs.length) {
      html += '<div class="placeholder">这个目录下面没有子目录。</div>';
    } else {
      html += browseData.dirs.map(function (d) {
        return '<button class="sess" type="button" data-browse-to="' + escapeHtml(d.path) + '">'
          + '<span class="s-title">' + escapeHtml(d.name) + '</span>'
          + '</button>';
      }).join('');
    }
    if (browseData.truncated) {
      html += '<div class="nav-note">只列了前 ' + browseData.dirs.length + ' 个，共 '
        + browseData.total + ' 个。</div>';
    }
    $('navBody').innerHTML = html;
  }

  /**
   * 「← 返回」：一级一级往外退，退法要跟用户心里的层级对上。
   *   在某个目录里 → 退回常用位置那一屏（往上几级有面包屑，不用返回键代劳）
   *   已经在常用位置 → 退回工作区树
   * 不这么做的话，从深层目录点返回会直接跳回工作区树，用户想换个盘得重新走一遍。
   */
  function closeBrowse() {
    if (browseAt) {
      browseAt = null;
      browseData = null;
      browseMkdir = false;
      renderNav();
      return;
    }
    navView = 'tree';
    renderNav();
  }

  function registerWorkspace(p) {
    if (browseBusy) return;
    browseBusy = true;
    api('/mini/api/workspaces', { method: 'POST', body: JSON.stringify({ path: p }) })
      .then(function (res) {
        browseBusy = false;
        navView = 'tree';
        browseAt = null;
        browseData = null;
        // 服务端把登记后的最新列表一起带回来了，直接用——不用再补一趟请求，
        // 也就不会出现「建好了但列表里还没有」。
        if (res && res.workspaces) navList = res.workspaces;
        navSessions = {};
        renderNav();
        toast(res && res.created
          ? '已登记《' + res.workspace.title + '》'
          : '《' + res.workspace.title + '》本来就在列表里');
      })
      .catch(function (err) {
        browseBusy = false;
        toast(err.message);
      });
  }

  function makeFolder() {
    var input = $('mkdirName');
    var name = input ? input.value : '';
    if (browseBusy) return;
    browseBusy = true;
    api('/mini/api/browse/mkdir', { method: 'POST', body: JSON.stringify({ path: browseAt, name: name }) })
      .then(function (res) {
        browseBusy = false;
        browseMkdir = false;
        browseTo(res.path);
      })
      .catch(function (err) {
        browseBusy = false;
        toast(err.message);
      });
  }

  // 标题补齐的节奏。服务端只等 250 毫秒就把列表先给出来（超时的标题留给后台），
  // 所以这里要接着问。**问几次由服务端说了算**，见 toggleWorkspace 里的说明。
  var TITLE_FOLLOW_MS = 2500;        // 每隔这么久问一次
  var TITLE_FOLLOW_LIMIT_MS = 30000; // 从展开算起，最多追这么久

  /**
   * 这份列表「还剩几条标题没读出来」。
   *
   * 优先用服务端给的 pending：那是事实（它知道还有几条日志没读完）。
   * **服务端没给这个字段时才退回数空标题**——那是「改了要重启」的半新状态下
   * （新页面配旧进程）唯一能用的判据。旧页面就是靠它补拉三次的，
   * 退回去至少有原来的效果，不会因为服务端换了版本就反而不追了。
   */
  function pendingCount(body) {
    if (body && typeof body.pending === 'number') return body.pending;
    return ((body && body.sessions) || []).filter(function (s) { return !s.title; }).length;
  }

  function toggleWorkspace(wsId) {
    if (navExpanded[wsId]) {
      delete navExpanded[wsId];
      renderNav();
      return;
    }
    navExpanded[wsId] = true;
    renderNav();
    loadWsSessions(wsId);
  }

  // 取一个工作区的会话列表。点击和 renderNav 的自愈（见 renderNav 顶部）都走这里：
  // navWsFetching 这道闩让同一工作区同时只有一趟在飞，别重复付读日志折标题的钱。
  // 15 秒兜底解锁是给「请求永远不回来」留的——闩本身不能变成新的卡死点，
  // 超过 15 秒就放行，让下一次渲染或点击还能再试（服务端有缓存，重发很便宜）。
  function loadWsSessions(wsId, force) {
    if (navSessions[wsId] || navWsFetching[wsId]) return;
    navWsFetching[wsId] = true;
    var bail = setTimeout(function () { delete navWsFetching[wsId]; }, 15000);
    var sessionsUrl = sessionsUrlOf(wsId, force);
    /**
     * 接着问，直到服务端说「一条都不剩」。
     *
     * 原来的写法是**固定补三次**（1.5 秒 / 3 秒 / 3 秒，共 7.5 秒），而一个工作区里
     * 四五个冷会话实测要 19 秒才读完——三次补拉盖不住，标题就是长不出来，
     * 用户只能退出去再进来。现在按服务端给的事实问：pending 归零就停。
     *
     * 30 秒是总时限：万一有一条日志坏了、永远读不出来，也不该没完没了地问下去。
     */
    function followTitles(cur, deadline) {
      if (!(pendingCount(cur) > 0) || Date.now() >= deadline) return;
      navFollowTimers[wsId] = setTimeout(function () {
        delete navFollowTimers[wsId];
        // 用户收起了、或者这份数据已经被刷新换掉，就放手：别跟人抢。
        if (navSessions[wsId] !== cur || !navExpanded[wsId]) return;
        api(sessionsUrlOf(wsId))
          .then(function (body) {
            if (navSessions[wsId] !== cur || !navExpanded[wsId]) return;
            navSessions[wsId] = body;
            renderNav();
            followTitles(body, deadline);
          })
          .catch(function () {
            // 追不到就算了：列表本身还在，日期也够用。
          });
      }, TITLE_FOLLOW_MS);
    }
    api(sessionsUrl)
      .then(function (body) {
        clearTimeout(bail);
        navSessions[wsId] = body;
        delete navWsFetching[wsId];
        renderNav();
        followTitles(body, Date.now() + TITLE_FOLLOW_LIMIT_MS);
      })
      .catch(function (err) {
        clearTimeout(bail);
        delete navWsFetching[wsId];
        navSessions[wsId] = { sessions: [], total: 0 };
        renderNav();
        toast(err.message);
      });
  }

  /**
   * 取一个工作区会话列表的地址。三个参数都是**这次的口径**：
   *   · `archived=1` 只在「显示已归档」打开时带——默认那一档是隐藏已归档（官方默认项）。
   *   · `limit` 只在"要过更多"时才带，平时不带。**不带就还是原来那条地址**：
   *     多带一个参数会让服务端每次都走一条不一样的路径，也没必要。
   *   · `refresh=1` 只在**刚刚多出一条会话**（分叉）时才带：服务端那份清册有 30 秒缓存，
   *     不绕过的话新会话不在里面。
   */
  function sessionsUrlOf(wsId, force) {
    var url = '/mini/api/workspaces/' + encodeURIComponent(wsId) + '/sessions';
    var parts = [];
    if (navShowArchived) parts.push('archived=1');
    if (navLimit[wsId]) parts.push('limit=' + navLimit[wsId]);
    if (force) parts.push('refresh=1');
    return parts.length ? url + '?' + parts.join('&') : url;
  }

  // 防连点。建会话**不是幂等的**——点两下就在电脑上真建出两个会话来，
  // 而手机上什么都看不出来（第二个只是把列表撑长了一行）。所以这里必须自己拦。
  // 服务端那道闸门拦不住这个：两个请求都是合法的。
  var creatingSession = false;

  function createSession(wsId, agentPreset) {
    // 2026-10-04 用户要求：新建会话时手机上也要能选 agent 模式（PC 一直可以）。
    // 多于一种模式、又没点名要哪种：先把清单行内展开让用户挑（照「新建文件夹」的
    // 先例，不弹窗）；只有一种、或读不到清单：直接建 DSH 的默认模式——
    // **不摆只有一个选项的选择题**，也不替用户猜。
    if (agentPreset === undefined && navPresets && navPresets.ok && navPresets.presets.length > 1) {
      navPickerWs = navPickerWs === wsId ? '' : wsId;
      renderNav();
      return Promise.resolve();
    }
    navPickerWs = '';
    if (creatingSession) return;
    creatingSession = true;
    Array.prototype.forEach.call($('navBody').querySelectorAll('.ws-new'), function (el) {
      el.disabled = true;
    });
    function done() {
      creatingSession = false;
      Array.prototype.forEach.call($('navBody').querySelectorAll('.ws-new'), function (el) {
        el.disabled = false;
      });
    }
    // POST 到工作区会话那条路径上：GET 是「列出来」，POST 是「建一个」。
    // 服务端建完会顺手 bind 并把新快照一起返回，所以这里一次请求就完成了
    // 「建 + 切过去」，不用再补一次 bind。
    //
    // **要把 promise 返回出去**：起了异步动作就该让调用方等得到它。
    // 不返回的话外面拿到的是 undefined，接不上任何后续。
    return api('/mini/api/workspaces/' + encodeURIComponent(wsId) + '/sessions', {
      method: 'POST',
      body: agentPreset ? JSON.stringify({ agentPreset: agentPreset }) : '{}',
    }).then(function (res) {
      done();
      // 接口把绑定后的快照一起给了，直接渲染——不这样的话，切过去的一瞬间
      // 屏幕上还留着上一个会话的正文。
      if (res && res.state) applySnapshot(res.state);
      else render();
      closeNav();
      toast('已在《' + ((res && res.workspaceTitle) || '工作区') + '》里建好新会话');
      // 让列表里立刻出现这条新会话。force 是为了绕过服务端那份 30 秒的缓存——
      // 刚建的会话它还不知道，不绕过的话切回来会「咦刚才那条呢」。
      loadWorkspaces(true);
    }).catch(function (err) {
      done();
      toast(err.message);
    });
  }

  function bindSession(id) {
    if (!id) return;
    api('/mini/api/bind', { method: 'POST', body: JSON.stringify({ sessionId: id }) })
      .then(function (res) {
        // 接口把切换后的快照一起返回了，直接用它渲染——不用干等 SSE 那一趟。
        // 不这样的话，切过去的一瞬间屏幕上还留着上一个会话的内容。
        if (res && res.state) applySnapshot(res.state);
        else { state.boundSessionId = id; render(); }
        closeNav();
        toast('已切换会话');
      })
      .catch(function (err) { toast(err.message); });
  }

  // 当前会话可能在电脑上被切走。这里只改高亮，不重绘整棵树——重绘会把
  // 用户正在划的滚动位置弹回顶部。
  function paintNavCurrent() {
    if (!$('nav').classList.contains('open')) return;
    var cur = state.boundSessionId;
    Array.prototype.forEach.call($('navBody').querySelectorAll('.sess'), function (el) {
      el.classList.toggle('cur', el.getAttribute('data-sess') === cur);
    });
  }

  // 归档确认面板。**它自己带两个按钮，不走 navBody 那套委托**：
  // 它在抽屉之外、是一整屏的浮层，混进列表的事件里只会让人以为它也是列表的一部分。
  //
  // 确认后**才**带 stop:true 重发——被停掉的工作不会自动继续，所以这一下必须是人按的。
  $('navConfirm').addEventListener('click', function (e) {
    var t = e.target;
    if (t === $('navConfirm') || (t && t.closest && t.closest('[data-nc-cancel]'))) {
      navConfirm = null;
      renderNavConfirm();
      return;
    }
    var ok = t && t.closest ? t.closest('[data-nc-ok]') : null;
    if (!ok || !navConfirm) return;
    // 按下去先禁掉：这一趟会在电脑上真停东西，连点两下没有第二件事可做。
    ok.disabled = true;
    archiveAct(navConfirm.sessionId, true);
  });
  // 改名那一行：手机键盘上是「回车」，桌面上是 Enter。不接这个键的话，
  // 用户打完字的第一反应（回车）什么都不会发生。
  $('navBody').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var t = e.target;
    if (!t || t.id !== 'renameInput') return;
    e.preventDefault();
    renameSubmit();
  });

  $('btnNav').addEventListener('click', openNav);
  $('btnNavClose').addEventListener('click', closeNav);
  $('btnNavRefresh').addEventListener('click', function () { loadWorkspaces(true); });
  $('nav').addEventListener('click', function (e) { if (e.target === $('nav')) closeNav(); });

  $('navBody').addEventListener('input', function (e) {
    if (!e.target || !e.target.matches || !e.target.matches('[data-search]')) return
    navQuery = e.target.value || ''
    paintNav()
    // 重画会把焦点丢掉：搜索时最要紧的是能接着打字。
    var again = document.querySelector('[data-search]')
    if (again) {
      again.focus()
      try { again.setSelectionRange(again.value.length, again.value.length) } catch (err) {}
    }
  });

  $('navBody').addEventListener('click', function (e) {
    var t = e.target;
    var at = function (sel) { return t && t.closest ? t.closest(sel) : null; };
    var sess = t && t.closest ? t.closest('.sess') : null;
    if (sess) {
      // 目录浏览那一屏里的 .sess 是「进这个目录」，不是「切到这个会话」。
      // 两屏共用同一个条目样式，所以要先看当前在哪一屏。
      if (navView === 'browse') { browseTo(sess.getAttribute('data-browse-to')); return; }
      // 已归档的**点不开**（官方原话：「已归档对话暂时无法查看，请取消归档后查看」）。
      // 留着能点更坏：点进去是一个空会话，用户只会以为会话被清空了。
      var bound = navSessionById(sess.getAttribute('data-sess'));
      if (bound && bound.row.archived) {
        toast('已归档的会话打不开，先取消归档');
        return;
      }
      bindSession(sess.getAttribute('data-sess'));
      return;
    }

    // —— 会话条目的执行入口（2026-10-09）。都排在下面那些之前，
    //    因为它们都挂在会话那一行上，和「新建会话 / 展开工作区」不是一类。 ——
    var menu = at('[data-more-menu]');
    if (menu) { toggleActs(menu.getAttribute('data-more-menu')); return; }
    var act = at('[data-act]');
    if (act) {
      var actId = act.getAttribute('data-act-id');
      var which = act.getAttribute('data-act');
      if (which === 'rename') startRename(actId);
      else if (which === 'fork') forkAct(actId);
      else if (which === 'pin') pinAct(actId, act.getAttribute('data-act-on') !== '1');
      else if (which === 'archive') archiveAct(actId, false);
      else if (which === 'unarchive') unarchiveAct(actId);
      return;
    }
    if (at('[data-rename-cancel]')) { navRenaming = ''; renderNav(); return; }
    if (at('[data-rename-ok]')) { renameSubmit(); return; }
    var more = at('[data-more]');
    if (more) { expandMore(more.getAttribute('data-more')); return; }
    var less = at('[data-less]');
    if (less) { collapseMore(less.getAttribute('data-less')); return; }
    if (at('[data-archived-toggle]')) { setShowArchived(!navShowArchived); return; }

    var newWs = at('[data-new-ws]');
    if (newWs) { openBrowse(); return; }
    var back = at('[data-browse-back]');
    if (back) { closeBrowse(); return; }
    var to = at('[data-browse-to]');
    if (to) { browseTo(to.getAttribute('data-browse-to')); return; }
    var pick = at('[data-pick]');
    if (pick) { registerWorkspace(pick.getAttribute('data-pick')); return; }
    if (at('[data-mkdir]')) { browseMkdir = true; renderNav(); return; }
    if (at('[data-mkdir-cancel]')) { browseMkdir = false; renderNav(); return; }
    if (at('[data-mkdir-ok]')) { makeFolder(); return; }

    // 模式清单里点一项：带着这个模式去建（2026-10-04，手机上也能选 agent 模式）。
    var mode = at('[data-mode-preset]');
    if (mode) {
      createSession(mode.getAttribute('data-mode-ws'), mode.getAttribute('data-mode-preset'));
      return;
    }
    // 「新建会话」要排在 ws-head 之前判：它在 ws-body 里面、不是 ws-head，
    // 顺序上无所谓，但放在前面更清楚——这一支是动作，那一支是展开/收起。
    var fresh = at('.ws-new');
    if (fresh) { createSession(fresh.getAttribute('data-newws')); return; }
    var head = at('.ws-head');
    if (!head) return;
    toggleWorkspace(head.parentNode.getAttribute('data-ws'));
  });

  // ---------------- SSE ----------------
  /** 从轨迹中取当前轮号：正在跑的那一组的轮号。没有就返回 null。 */
  function currentTrajectoryTurn() {
    var groups = state.trajectory || [];
    for (var i = groups.length - 1; i >= 0; i--) {
      var g = groups[i];
      if (g && g.state === 'running' && g.turn != null) return g.turn;
    }
    // 没有正在跑的，取最近一个有轮号的
    for (var j = groups.length - 1; j >= 0; j--) {
      var h = groups[j];
      if (h && h.turn != null) return h.turn;
    }
    return null;
  }

  /**
   * 这条流是谁——轨迹订阅按连接记，就得先有身份。
   *
   * 服务端手上只有一条条 SSE 连接（`res`），一次普通的 POST 认不出「我是哪条流」。
   * 所以由客户端自己报一个随机串，两处都带上：连流时的 `?clientId=…`，和之后每次
   * 开关订阅的 POST。不报也能用，只是那种连接订不了轨迹。
   *
   * 存 `sessionStorage`（不是 localStorage）：一个标签页一个身份，第二个标签页不会
   * 跟这一页抢同一条订阅；刷新后还在，免得每刷一次就多出一个「认不出」的连接。
   * 无痕模式下存取会抛，就地退回「本次运行内固定」——订不上，但不影响别的功能。
   */
  var clientId = '';
  try {
    clientId = sessionStorage.getItem('dshMiniClient') || '';
    if (!clientId) {
      clientId = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      sessionStorage.setItem('dshMiniClient', clientId);
    }
  } catch (e) {
    clientId = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  /** 服务端此刻认作「订了轨迹」的那个身份；空串 = 没订（切换模式的开关拿它判断）。 */
  var subscribedClientId = '';
  /**
   * 这条活连接**建的时候有没有带 `stream=1`**（2026-10-22）。
   *
   * 不能只用 `state.streaming` 判断：开关开着，但连接是在「单帧」模式下建的、
   * 或者是在切模式之前建的，它照样收不到正文帧。这里记的是「连上时真带了没有」，
   * 和当前想要的比一比，不一样就重连。
   */
  var streamSubscribed = false;
  var es = null;
  function connect() {
    if (es) { try { es.close(); } catch (e) {} es = null; }
    if (!state.entered) { showGate(); return; }
    setStatus('', '连接中…');
    // clientId 每条连接都带（订阅的 POST 靠它认出这条流）；full=1 只在「完整」模式带，
    // 服务端见到就自动把这条连接订上轨迹——断线重连沿用同一个地址，重新订上由服务端
    // 自己完成，客户端不用再握手一次。
    // **`stream=1`（2026-10-21）** = 「这台设备的流式开关是开的，正文也给我推」。
    // 不带它就一个正文帧都收不到——关掉流式**真的省流量**，不是前端收到了再丢掉。
    // **地址里不带令牌**（2026-10-16 第二步）：同源的 EventSource 会带上设备 cookie。
    // 「这一条连接该不该收正文帧」在建流这一刻定死；切模式 / 开关状态变了都要重连一次。
    var streamWanted = state.streaming && state.mode !== 'minimal';
    streamSubscribed = streamWanted;
    es = new EventSource('/mini/api/stream?clientId=' + encodeURIComponent(clientId)
      + (state.mode === 'full' ? '&full=1' : '')
      + (streamWanted ? '&stream=1' : ''));

    es.addEventListener('open', function () {
      state.connected = true;
      updateStatusUI();
      $('connHint').textContent = '已连接';
      prefetchWorkspaces();
      prefetchSubagents();
      if (state.mode === 'full') {
        // 首连与重连同一处：full=1 已让服务端订上这条连接，拿住身份，再对齐一次——
        // 断线那一段路上可能丢过帧，用这份 GET 把 epoch/seq 校正（换代就整个换新）。
        subscribedClientId = clientId;
        requestTrajectory();
      }
    });
    es.addEventListener('state', function (e) {
      state.connected = true;
      updateStatusUI();
      try { applySnapshot(JSON.parse(e.data)); } catch (err) {}
      prefetchWorkspaces();
      prefetchSubagents();
    });
    // 轨迹的增量帧。JSON 解析失败就丢——宁可等下一份 GET 对齐，也不拿半帧去拼。
    es.addEventListener('trajectory', function (e) {
      var frame;
      try { frame = JSON.parse(e.data); } catch (err) { return; }
      receiveTrajectoryFrame(frame);
    });
    // 活片段帧（2026-10-04 用户解禁：完整模式要「正在想的片段一点点顺出来」）。
    // 只进完整模式的轨迹组头；聊天/单帧、鲸鱼娘气泡一个字节都不碰。
    //
    // **2026-10-21 起多了一路正文**（`kind: 'text'`，配合设置页那个「流式」开关）：
    // 服务端把那一段新攒的字放在 `delta` 里推过来，这里**累加到 `state.live`**——
    // 也就是聊天与完整两个模式共用的那个「正在流出来的回答」槽位（`liveBlock` 渲染它）。
    // 落定帧（`trajectory`）一到就清空，由真条目接管，绝不把影子留在屏幕上。
    es.addEventListener('trajectory-live', function (e) {
      var frame;
      try { frame = JSON.parse(e.data); } catch (err) { return; }
      if (frame.sessionId && state.boundSessionId && frame.sessionId !== state.boundSessionId) return;
      if (frame.kind === 'text') {
        // 正文那一路：**单帧模式不跟**（用户 2026-10-21 拍板），所以这里先挡掉。
        if (state.mode === 'minimal') return;
        if (typeof frame.delta !== 'string' || !frame.delta) {
          // 空 delta = 服务端说「这一段写完了，别留残留」。
          state.streamReceived = false;
          livePaintedText = '';
          if (state.live) { state.live = ''; render(); }
          return;
        }
        state.streamReceived = true;
        state.live = (state.live || '') + frame.delta;
        // 只换流式那一块，别每 60 毫秒重拼整串历史；再按帧合并刷新（见 schedulePaintLive）。
        schedulePaintLive();
        return;
      }
      if (frame.kind === 'tool') {
        // 工具参数那一路：**只有完整模式 + 流式开关开着**才用。
        // 开关关着时服务端根本不会推（`?stream=1` 没带），这里是第二道闸，防着将来协议变化。
        if (!state.streaming) return;
        if (state.mode !== 'full') return;
        if (typeof frame.delta !== 'string' || !frame.delta) {
          if (state.liveTool) { state.liveTool = null; render(); }
          return;
        }
        var prev = state.liveTool || { name: '', args: '' };
        state.liveTool = {
          // `name` 只在第一个 delta 上带，后面沿用记着的那个。
          name: typeof frame.name === 'string' && frame.name ? frame.name : prev.name,
          args: (prev.args || '') + frame.delta,
        };
        render();
        return;
      }
      if (state.mode !== 'full') return;
      state.trajectoryLive = typeof frame.detail === 'string' ? frame.detail : '';
      render();
    });
    es.addEventListener('navigation-title', function (e) {
      var payload;
      try { payload = JSON.parse(e.data); } catch (err) { return; }
      if (!payload || typeof payload.workspaceId !== 'string' || typeof payload.sessionId !== 'string') return;
      var got = navSessions[payload.workspaceId];
      if (!got || !Array.isArray(got.sessions)) return;
      var row = got.sessions.find(function (item) { return item.id === payload.sessionId; });
      if (!row) return;
      row.title = typeof payload.title === 'string' ? payload.title : '';
      if (typeof got.pending === 'number' && got.pending > 0) got.pending -= 1;
      if (got.pending <= 0 && navFollowTimers[payload.workspaceId]) {
        clearTimeout(navFollowTimers[payload.workspaceId]);
        delete navFollowTimers[payload.workspaceId];
      }
      if (navExpanded[payload.workspaceId] && navView === 'tree') renderNav();
    });
    es.addEventListener('navigation-pending', function (e) {
      // 谁在等人变了。**只就地换那几行的尾部标记**，不重绘整棵树——
      // 重绘会把用户正在划的滚动位置弹回顶部（和 paintNavCurrent 同一条理由）。
      var map;
      try { map = JSON.parse(e.data); } catch (err) { return; }
      if (!map || typeof map !== 'object') return;
      var touched = false;
      Object.keys(navSessions).forEach(function (wsId) {
        var got = navSessions[wsId];
        if (!got || !Array.isArray(got.sessions)) return;
        got.sessions.forEach(function (s) {
          var next = typeof map[s.id] === 'string' ? map[s.id] : null;
          if (s.pending !== next) { s.pending = next; touched = true; }
        });
      });
      if (touched && $('nav').classList.contains('open') && navView === 'tree') renderNav();
    });
    es.addEventListener('subagent-metrics', function (e) {
      var payload;
      try { payload = JSON.parse(e.data); } catch (err) { return; }
      if (!payload || payload.parentSessionId !== state.boundSessionId) return;
      var row = null;
      for (var i = 0; i < saRows.length; i++) {
        if (saRows[i].id === payload.childId) { row = saRows[i]; break; }
      }
      if (!row) return;
      row.tokens = payload.tokens;
      row.durationMs = payload.durationMs;
      row.lastTurnCompleted = payload.lastTurnCompleted;
      if (saCache && saCacheSession === state.boundSessionId) {
        for (var k = 0; k < (saCache.subagents || []).length; k++) {
          if (saCache.subagents[k].id === payload.childId) {
            Object.assign(saCache.subagents[k], payload);
            break;
          }
        }
      }
      if (saPanel.classList.contains('open') && !saCurrent) saRenderList(saCache || { ok: true, subagents: saRows });
    });
    es.addEventListener('navigation-refresh', function () {
      navList = null;
      navSessions = {};
      saCache = null;
      saCacheSession = null;
      saCacheAt = 0;
      if ($('nav').classList.contains('open')) loadWorkspaces(false);
      else prefetchWorkspaces();
    });
    es.addEventListener('reply', function (e) {
      var payload = JSON.parse(e.data);
      // interrupted 必须带上：这条是「实时推过来的那一条」，走的是和刷新时
      // （/mini/api/state 的完整快照）不同的代码路径。漏了的话，被按停的那半句话
      // 在实时推送时不会标「已停止」，得刷新一下才出现——测试全绿但真机是坏的。
      var cut = payload.interrupted === true;
      state.latest = {
        text: payload.text, timestamp: payload.timestamp,
        sessionId: payload.sessionId, interrupted: cut,
      };
      // 完整模式画的也是这串聊天记录（renderFull 复用 renderChat），回复落定
      // 同样要追加进去，否则要等下一份快照才补上；单帧不画记录，照旧不进。
      if (state.mode !== 'minimal') {
        state.history = (state.history || []).concat([
          {
            role: 'assistant', text: payload.text, timestamp: payload.timestamp,
            sessionId: payload.sessionId, interrupted: cut,
            // 完整模式把轨迹块插回对话原位要用：从轨迹中取当前轮号。
            // 手机本地回显时轮还没开，先留空；服务端快照补上来时会带上真轮号。
            turn: currentTrajectoryTurn(),
          }
        ]);
      }
      // **落定的回答到了，流式的影子让位**（2026-10-22）。块结束时服务端会补发最后一截
      // 尾巴、并且**不再紧跟一个空帧**（那样会把刚补的字一起抹掉），清屏的责任在这里：
      // 先把 live 清掉再画，屏幕上只留真正的回答，不会出现「同一段话两遍」。
      state.live = '';
      state.liveTool = null;
      state.streamReceived = false;
      setRunning(false);
      render();
      if (!document.hidden) {
        playDing(); buzz();
      } else {
        // 页面在后台时，响铃和震动都叫不醒人——那两样只在页面看得见的时候有用。
        //
        // 原来这里指望系统通知兜底。2026-09-25 试到底了：**锁屏时系统会冻结后台页面**，
        // 实时连接断掉，这段代码根本轮不到执行。不锁屏的后台（切到别的应用）它倒是能用，
        // 但用户试过之后决定浏览器里不做这个功能了，理由和处置见下面「页面在后台时提醒」。
        //
        // 调用留着：开关不露出来了，state.notify 就永远是 false，这个函数会立刻返回。
        notifySystem(payload.text);
      }
    });
    // ——— 回答电脑的提问 ———
    //
    // 电脑那边提问时，插件把题目推一条 `question` 过来，答完 POST 回 /mini/api/answer。
    // 三条是用户定下的：一个一个答（答完这题才出下一题）、点错了能回头改、能自己打字。
    let ask = null
    function askRender() {
      if (!ask) return
      const q = ask.questions[ask.i]
      $('askHead').textContent = ask.questions.length > 1
        ? '电脑问你第 ' + (ask.i + 1) + ' 题，一共 ' + ask.questions.length + ' 题'
        : '电脑在问你一件事'
      $('askText').textContent = q.question || ''
      $('askDetail').textContent = q.detail || ''
      $('askDetail').style.display = q.detail ? '' : 'none'
      const picked = ask.picked[ask.i] || { selected: [], custom: '' }
      const box = $('askOpts')
      box.innerHTML = ''
      const options = Array.isArray(q.options) ? q.options : []
      options.forEach(function (o) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'opt' + (picked.selected.indexOf(o.label) >= 0 ? ' sel' : '')
        const name = document.createElement('span')
        name.textContent = o.label
        btn.appendChild(name)
        if (o.description) {
          const sub = document.createElement('small')
          sub.textContent = o.description
          btn.appendChild(sub)
        }
        btn.addEventListener('click', function () {
          // 允许多选的题就点一下选中、再点一下取消；单选的点谁就是谁。
          if (q.multiSelect) {
            const at = picked.selected.indexOf(o.label)
            if (at >= 0) picked.selected.splice(at, 1)
            else picked.selected.push(o.label)
          } else {
            picked.selected = [o.label]
          }
          // 选了选项就清掉"我自己说"——两者只留一个，免得电脑收到含糊的答案。
          picked.custom = ''
          ask.picked[ask.i] = picked
          askRender()
        })
        box.appendChild(btn)
      })
      $('askCustomWrap').style.display = ask.custom ? '' : 'none'
      $('askCustom').value = picked.custom || ''
      $('askBack').style.display = ask.i > 0 ? '' : 'none'
      $('askNext').textContent = ask.i === ask.questions.length - 1 ? '答好了，发回电脑' : '下一题'
      $('askCard').classList.add('on')
    }
    $('askOwn').addEventListener('click', function () {
      if (!ask) return
      ask.custom = !ask.custom
      $('askCustomWrap').style.display = ask.custom ? '' : 'none'
      if (ask.custom) $('askCustom').focus()
    })
    $('askCustom').addEventListener('input', function () {
      if (!ask) return
      const picked = ask.picked[ask.i] || { selected: [], custom: '' }
      picked.custom = $('askCustom').value
      picked.selected = []
      ask.picked[ask.i] = picked
      askRender()
    })
    $('askBack').addEventListener('click', function () {
      if (!ask || ask.i === 0) return
      ask.i -= 1
      askRender()
    })
    $('askNext').addEventListener('click', function () {
      if (!ask) return
      const picked = ask.picked[ask.i] || { selected: [], custom: '' }
      if (!picked.selected.length && !(picked.custom || '').trim()) {
        toast('先选一个，或者点「我自己说」写一句')
        return
      }
      if (ask.i < ask.questions.length - 1) {
        ask.i += 1
        askRender()
        return
      }
      // 最后一题答完：把所有题的答案一起交回去。
      const answers = ask.questions.map(function (q, k) {
        const one = ask.picked[k] || { selected: [], custom: '' }
        const answer = { id: q.id, selected: one.selected.slice() }
        if ((one.custom || '').trim()) answer.custom = one.custom.trim()
        return answer
      })
      // 三种结果说三句不同的话。**没成事就不收卡片**：收掉了就再也没地方说这句话，
      // 用户看到的只会是「点了没反应」。
      sendAnswer(ask.id, answers).then(function (verdict) {
        if (verdict === 'failed') {
          toast('没送出去，看一眼和电脑的连接，再点一次')
          return
        }
        ask = null
        $('askCard').classList.remove('on')
        if (verdict === 'late') toast('这道题已经交回电脑了，去电脑上答')
      })
    })
    // ——— 命令确认（审批）———
    //
    // 电脑要做需要拍板的事时，插件推一条 `approval` 过来，点了卡上的按钮再 POST 回
    // /mini/api/approval。和答题卡同样的三条讲究：没送出去就不收卡片（收掉了就再也
    // 没地方说这句话，用户看到的只会是"点了没反应"）；三种结果说三句不同的话；
    // 只认有 id 的帧，别的形状一律不理。
    let approve = null
    function approveShow(payload) {
      approve = { id: payload.id }
      $('approveTool').textContent = '它要让「' + (payload.toolName || '某个工具') + '」动手'
      $('approveReason').textContent = payload.reason || ''
      $('approveReason').style.display = payload.reason ? '' : 'none'
      // 命令原文：有就照原样显示。**没有就明说"没取到"，不静默藏起来**——
      // 用户要的就是看见命令，藏起来等于骗他；真没取到时他也一眼看得出是这条链没走通。
      $('approveCmd').textContent = payload.command || '（这条没取到命令原文）'
      $('approveCard').classList.add('on')
    }
    function approveDecide(allow) {
      if (!approve) return
      const id = approve.id
      sendApproval(id, allow).then(function (verdict) {
        if (verdict === 'failed') {
          toast('没送出去，看一眼和电脑的连接，再点一次')
          return
        }
        approve = null
        $('approveCard').classList.remove('on')
        if (verdict === 'late') toast('这条已经交回电脑了，去电脑上处理')
      })
    }
    $('approveAllow').addEventListener('click', function () { approveDecide(true) })
    $('approveDeny').addEventListener('click', function () { approveDecide(false) })
    es.addEventListener('approval', function (e) {
      let payload = null
      try { payload = JSON.parse(e.data) } catch (err) { return }
      if (!payload || !payload.id) return
      approveShow(payload)
    });
    es.addEventListener('question', function (e) {
      let payload = null
      try { payload = JSON.parse(e.data) } catch (err) { return }
      if (!payload || !payload.id || !Array.isArray(payload.questions) || !payload.questions.length) return
      ask = { id: payload.id, questions: payload.questions, i: 0, picked: {}, custom: false }
      askRender()
    });
    // 这道题在**别处**被答掉了（飞书那边回的），插件主动推一条状态过来。
    //
    // 没有这一条，卡片就干巴巴挂在屏幕上：用户在飞书里答完了，切回手机还看得见这道题，
    // 只能以为没生效、再答一次——那时候拿到的是「已经过期了」。所以这里就地收起来，
    // 并说一句它是怎么没的。**只在自己正显示着同一道题时动手**，别的题（编号对不上）
    // 一个字都不碰。
    es.addEventListener('question-done', function (e) {
      let payload = null
      try { payload = JSON.parse(e.data) } catch (err) { return }
      if (!payload || !payload.id) return
      if (!ask || ask.id !== payload.id) return
      ask = null
      $('askCard').classList.remove('on')
      // 谁答的由插件如实说（'feishu'）——猜不得，也不把「超时/断线」说成「已在别处答过」。
      if (payload.source === 'feishu') toast('这道题已经在飞书里答过了')
    });
    es.addEventListener('approval-done', function (e) {
      let payload = null
      try { payload = JSON.parse(e.data) } catch (err) { return }
      if (!payload || !payload.id) return
      if (!approve || approve.id !== payload.id) return
      approve = null
      $('approveCard').classList.remove('on')
      if (payload.source === 'feishu') toast('这条已经在飞书里处理过了')
    });
    es.addEventListener('status', function (e) {
      try { setRunning(JSON.parse(e.data).running); } catch (err) {}
    });
    es.addEventListener('error', function () {
      state.connected = false;
      updateStatusUI();
      $('connHint').textContent = '已断开，正在自动重连…';
      // EventSource 自己会重连，这里不用手动 close。
    });
  }

  // ---------------- 发送 ----------------
  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
  }

  // ---------------- 斜杠指令（在输入框里打 / 时弹出来的菜单） ----------------
  //
  // 手机上敲 `/` 要能看见这个会话有哪些指令、点一下就执行。这一块管三件事：
  // 菜单怎么出（paintCmdMenu）、点一条怎么处理（pickCommand）、执行本身
  // （runCommand，下面 send 那条路也用它）。
  //
  // 数据**按会话缓存**，理由见 state 里 commands* 那几个字段。
  //
  // 输入框本来的提示语。选了一条「要参数」的指令时它会被换成那句 hint，发出去之后
  // 要换回来——留着上一个指令的参数提示，下一个普通问题就顶着一句不相干的话。
  var INPUT_HINT = inputEl.placeholder || '';

  /**
   * 输入框里那个「还没打完的指令」。
   *
   * 命中时返回 `/` 后面那一段（只打了一个 `/` 就是空串），没命中返回 null。
   * 判据收得很紧：**整行**必须正好是「/ 加一串小写字母数字下划线横线」。出现空格、
   * 前面多了别的字、用了大写，都算没命中——菜单收起来，交给 send 里那条分流规则。
   *
   * 只认小写是因为 DSH 的指令名就是小写：把大写也当命中，用户会看到「打了没反应」
   * （过滤出零条 → 菜单收起），而真实原因只是他开着大写。
   */
  function slashQuery() {
    var m = /^\/([a-z0-9_-]*)$/.exec(inputEl.value);
    return m ? m[1] : null;
  }

  function hideCmdMenu() {
    var el = $('cmdMenu');
    if (!el) return;
    el.hidden = true;
    el.innerHTML = '';
  }

  /** 这个会话的指令表是不是还没有（或者需要重取）。 */
  function needCommands() {
    // 换了会话就得重取，见 state 里 commands* 的说明。
    if (state.commandsFor !== state.boundSessionId) return true;
    // 这个会话还什么都没拿到、也没失败过——第一次用到它的时候去取。
    return !state.commands && !state.commandsError;
  }

  function loadCommands() {
    // 正在取就别再发一次：菜单是跟着输入框每敲一个字重画的，不拦着的话
    // 打「/compact」会连发八个请求。
    if (state.commandsLoading) return;
    state.commandsLoading = true;
    // 记下这份数据是**给哪个会话**取的，而不是「请求是什么时候发的」——
    // 请求飞在路上时用户完全可能已经切走了，回来那一份就不作数了。
    var forSession = state.boundSessionId;
    state.commands = null;
    state.commandsError = '';
    api('/mini/api/commands').then(function (res) {
      state.commandsLoading = false;
      if (forSession !== state.boundSessionId) return;   // 不是这个会话的，扔掉
      state.commandsFor = forSession;
      if (res && res.ok) {
        state.commands = res.commands || [];
        state.commandsError = '';
      } else {
        // 服务端给了原因（多半是「这个会话现在没在跑」）就原样留着显示。
        // **不能显示成空列表**：那等于说「这个会话没有指令」，是另一回事。
        state.commandsError = (res && res.error) || '读不到指令列表';
      }
      paintCommandViews();
    }).catch(function (err) {
      state.commandsLoading = false;
      if (forSession !== state.boundSessionId) return;
      state.commandsFor = forSession;
      state.commands = null;
      state.commandsError = err.message || '读不到指令列表';
      paintCommandViews();
    });
  }

  /**
   * 指令表换了一份之后，**所有正在看着它的地方**都要重画。
   *
   * 现在有两处：打 / 弹出来的菜单，和统一操作面板里的那个列表。回调那一个由面板
   * 那一段自己挂上——因为它在这一段下面，而这一段会被测试单独抠出来跑（那时面板还不存在）。
   */
  var onCommandsReady = null;
  function paintCommandViews() {
    paintCmdMenu();
    if (onCommandsReady) onCommandsReady();
  }

  /**
   * 画（或收起）那只菜单。
   *
   * 它**每回都按输入框重算**，自己不记「现在是开着还是关着」：这样就不会出现
   * 「菜单和输入框对不上」的状态——比如程序清空输入框（点菜单、发完之后）不会触发
   * input 事件，那种时候没人替我们收菜单，只能自己出面对齐。
   */
  function paintCmdMenu() {
    var el = $('cmdMenu');
    if (!el) return;
    // 输入框被清空了 = 用户把刚才那条指令整个删了，这是「明确取消」那一步。
    // 放在这儿而不是 send() 里：清空之后他往往还要改写成普通提问，那次 send 不该再被拦。
    if (!inputEl.value.trim()) state.pendingCommand = null;
    var prefix = slashQuery();
    if (prefix === null) { hideCmdMenu(); return; }
    var wasOpen = !el.hidden;
    // 上次没取到时，**每次重新打开可以再试一次**（关着→打开这一下才重取，不是每敲一个
    // 字都取）。这一条是必须的：失败的原因多半是「这个会话现在没在跑」，而用户完全可能
    // 随后就发了条消息让它跑起来——那时再打 /，看到的却是上一句已经过时的话，
    // 他会以为这个功能坏了。
    if (needCommands() || (!wasOpen && state.commandsError)) loadCommands();
    el.hidden = false;
    if (state.commandsError) {
      el.innerHTML = '<div class="cmd-note">' + escapeHtml(state.commandsError) + '</div>';
      return;
    }
    if (!state.commands) {
      // 取回来之前先占个位——不然敲了 / 什么都不发生，看着像坏了。
      el.innerHTML = '<div class="cmd-note">正在读取可用的指令…</div>';
      return;
    }
    var rows = state.commands.filter(function (c) {
      return String(c.name || '').indexOf(prefix) === 0;
    });
    // 一条都对不上就收起来，**不写「没有匹配的指令」**：用户还在打字，打到一半没有
    // 匹配是常事，插一句提示只是噪音。真打错了指令，按发送时会被明确拒绝并说明。
    if (!rows.length) { hideCmdMenu(); return; }
    el.innerHTML = rows.map(function (c) {
      return '<button class="cmd-row" type="button" data-cmd="' + escapeHtml(c.name) + '">'
        + '<span class="cmd-name">/' + escapeHtml(c.name) + '</span>'
        + '<span class="cmd-desc">' + escapeHtml(c.description || '') + '</span></button>';
    }).join('');
  }

  /**
   * 菜单/面板里点了一条。
   *
   * 分两路，判据是服务端给的 hint（这条指令要不要参数）。两路都**不执行**，
   * 除非是打了 / 之后从菜单里点了一条不要参数的（那种当场跑，见 deferRun 的说明）：
   *   · 不要参数 —— 直接执行。让用户再按一次发送是白白多一步。
   *   · 要参数   —— 把 `/名字 ` 填进输入框，末尾留一个空格、光标停在后面，并把
   *     hint 那句话挂到输入框的 placeholder 上。
   *     **不自己编一句「请输入参数」**：只有服务端知道这条指令要什么，
   *     编一句就等于让用户照着一个错的提示去填。
   *
   * @param {string} name
   * @param {boolean} [deferRun] 面板那条路传 true：**一次点击不执行**，只把这一行放进
   *   输入框，由「发送」那一下确认（没有参数提示的指令也照此办理，宁可多问一句）。
   *   打 / 弹出来的那个菜单不传——它本来就是「扫一眼挑一个」，多一步反而碍事。
   */
  function pickCommand(name, deferRun) {
    var list = state.commands || [];
    var cmd = null;
    for (var i = 0; i < list.length; i++) { if (list[i].name === name) cmd = list[i]; }
    if (!cmd) return;
    hideCmdMenu();
    // 先把提示语还原，再按这一条决定要不要挂 hint——不然上一次点的那条「要参数」的
    // 指令留下的提示，会跟到这一条（不需要参数的）头上。
    inputEl.placeholder = INPUT_HINT;
    if (cmd.hint) {
      inputEl.value = '/' + cmd.name + ' ';
      inputEl.placeholder = cmd.hint;
      // 这一行「曾经是一条指令」：名字要是被删掉，send 不许拿它当普通提问发出去。
      state.pendingCommand = cmd.name;
      inputEl.focus();
      // 光标停在最后：停在名字中间的话，用户接着打的字会插进名字里去。
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      autoGrow();
      return;
    }
    if (deferRun) {
      // 面板那条路：只填不跑。等用户按「发送」——那就是明确的确认执行动作。
      inputEl.value = '/' + cmd.name;
      state.pendingCommand = cmd.name;
      inputEl.focus();
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      autoGrow();
      return;
    }
    // 当场执行：框里不留东西，也就不存在「曾是指令」这回事。
    state.pendingCommand = null;
    inputEl.value = '';
    autoGrow();
    runCommand('/' + cmd.name);
  }

  /**
   * 执行一条斜杠指令。
   *
   * 和普通消息走的是**两条不同的接口**：/mini/api/command 收的是完整的一行（含 /
   * 和参数），/mini/api/send 收的是「发给模型的一句话」。手机这边不替用户猜他打的是
   * 哪一个——猜错的代价是一次真花掉额度的提问，而且电脑端对不存在的指令是明确拒绝的，
   * 两边行为得一致。
   *
   * 接口只回一个 ok：这条指令**存不存在、跑得怎么样，都不在这里**。开始和结果由会话
   * 事件推回来（历史里出现 role:'command' 的条目，kind 从 running 变 success/error）。
   * 所以这里既不做乐观显示（会跟推来的那条重一份），也不报喜——只把「当场被拒」
   * 这一种情况说出来。
   */
  function runCommand(line) {
    api('/mini/api/command', { method: 'POST', body: JSON.stringify({ line: line }) })
      .then(function (res) {
        if (res && res.ok) return;
        // 被拒（没有这条指令 / 语法不对）的原因必须让用户看见，不能悄悄咽掉。
        toast((res && res.error) || '这条指令没跑起来');
      })
      .catch(function (err) { toast(err.message || '这条指令没跑起来'); });
  }

  $('cmdMenu').addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-cmd]') : null;
    if (btn) pickCommand(btn.getAttribute('data-cmd'));
  });

