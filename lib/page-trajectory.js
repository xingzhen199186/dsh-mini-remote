/**
 * 轨迹（思考 / 工具调用）的折叠与长相（2026-11-12 从 page-render 拆出来）。
 *
 * 完整模式下每组 = 一轮，组里是按顺序的思考与工具条目。数据和 PC 端一致，
 * 长相对齐桌面端的 turn-process；这里只管"怎么画、怎么折叠"，取数在别处。
 */

  // ---------------- 轨迹的折叠与长相（完整模式，对齐 PC） ----------------
  // 数据是上一棒收进 state.trajectory 的轮次组：组 {turn, state, entries[]}，
  // 条目 {kind:'think'|'tool', name, args, summary, output, state, …}，字段语义
  // 见 lib/trajectory.js 头上的说明（思考正文和工具结果都放 output）。
  // 长相对齐 DSH 桌面端的 turn-process（tasks/todo.md 11）：组头一行 = 图标 +
  // 状态词/标题（跑着是「正在…」活动词，收官是「已读取文件并调用工具」这类组合标题），
  // 条目一行 = 图标 + 「工具显示名 · 参数摘要」（思考行是「思考 · 首行」），
  // 点开才见正文（工具给「参数+结果」、思考给想的内容）。
  // 折叠口径不变：组级把「已结束的多条组」收成一行（running 还在长、error 要给人看、
  // 单条收了没信息量，这三种默认摊开）；条目级默认收。
  // 用户拨过的开关存在下面两个对象里（组按轮号、条目按 id），只在本会话内有效，
  // 换会话时在 renderFull 里清掉。
  var trajFor = null;        // 上次渲染时的会话 id（变了就清开关）
  var trajGroupOpen = {};    // 组级手动覆写：{ 轮号字符串: true|false }
  var trajEntryOpen = {};    // 条目级手动覆写：{ 条目 id: true|false }
  var trajBound = false;     // replyEl 上的委托绑过没有

  /**
   * 组默认摊不摊。收的条件是**两条一起成立**：条目够多（≥2）、已经跑完
   * （running 还在长，收了就看不见新条目；error 出错的组自己摊到条目级给人看，
   * 不用点）。用户手动拨过的开关优先于默认值。
   */
  function trajGroupIsOpen(g) {
    var key = String(g.turn);
    if (Object.prototype.hasOwnProperty.call(trajGroupOpen, key)) return trajGroupOpen[key];
    if (trajInlineEntries(g).length < 2) return true;
    if (g.state === 'running' || g.state === 'error') return true;
    return false;
  }
  /** 一条摊不摊：用户开关优先；没有开关时默认收（点开才见正文）。 */
  function trajEntryIsOpen(e) {
    if (Object.prototype.hasOwnProperty.call(trajEntryOpen, e.id)) return trajEntryOpen[e.id];
    return false;
  }

  /**
   * 组头的开关。key 是 data 属性上的字符串（getAttribute 回来一定是字符串，
   * 轮号是数字，两边统一按 String 比——有一边不转换就会拨空）。
   * 拨完立刻重画：开关唯一可见的效果就是下一次渲染，不重画等于点了没反应。
   */
  /** 点开关前后把被点的行钉住，避免展开/收起把它推走（2026-11-03）。 */
  function trajAnchorTop(selector) {
    var el = replyEl.querySelector ? replyEl.querySelector(selector) : null;
    return el && el.getBoundingClientRect ? el.getBoundingClientRect().top : null;
  }

  function trajRestoreAnchor(selector, before) {
    if (before === null) return;
    var el = replyEl.querySelector ? replyEl.querySelector(selector) : null;
    if (!el || !el.getBoundingClientRect) return;
    var moved = el.getBoundingClientRect().top - before;
    if (Math.abs(moved) > 1) mainEl.scrollTop += moved;
  }

  function toggleTrajGroup(turnKey) {
    var groups = state.trajectory || [];
    var selector = '[data-traj-group="' + turnKey + '"]';
    var before = trajAnchorTop(selector);
    for (var i = 0; i < groups.length; i++) {
      if (String(groups[i].turn) !== String(turnKey)) continue;
      trajGroupOpen[turnKey] = !trajGroupIsOpen(groups[i]);
      break;
    }
    render();
    trajRestoreAnchor(selector, before);
  }
  // 点的当下算开还是收，要按「含搜索强制摊开」的实况来（不然搜索摊开的条目点了
  // 收不回去）：先按 id 找到那条再取反；找不到时按手里原有的开关算，和原来一致。
  function toggleTrajEntry(id) {
    var open = trajEntryOpen[id] === true;
    var groups = state.trajectory || [];
    for (var i = 0; i < groups.length; i++) {
      var es = groups[i].entries || [];
      for (var j = 0; j < es.length; j++) {
        if (String(es[j].id) === String(id)) open = trajEntryIsOpen(es[j]);
      }
    }
    trajEntryOpen[id] = !open;
    // 条目都在限高窗口里，展开它的正文不该带动整页。（原来按条目顶做锚点补偿，
    // 窗口内一重排就会把整页滚到上面去——2026-11-03 用户报的那个跳。）
    // 整页位置原样记住、画完放回去；窗口内的位置由 capture/restoreTrajScroll 管。
    var keepTop = mainEl.scrollTop;
    render();
    mainEl.scrollTop = keepTop;
  }

  /**
   * 失败首行。reason 的第一行；reason 取不到就用错误名/错误码，都没有就如实说
   * 「失败」——**不编原因**（和 lib/trajectory.js readError 同一条口径）。
   */
  function trajErrLine(e) {
    if (!e || !e.error) return '';
    var r = typeof e.error.reason === 'string' ? e.error.reason : '';
    if (!r && typeof e.error.name === 'string' && e.error.name) r = e.error.name;
    if (!r && typeof e.error.code === 'string' && e.error.code) r = e.error.code;
    if (!r) return '失败';
    return r.split('\n')[0];
  }
  /** 组头上的失败首行：组里第一条带失败身份的条目的那一行。 */
  function trajGroupErrLine(g) {
    if (!g.entries) return '';
    for (var i = 0; i < g.entries.length; i++) {
      var line = trajErrLine(g.entries[i]);
      if (line) return line;
    }
    return '';
  }

  /**
   * 截断标注。N 是**原始总字符数**（truncated 里的 chars 才是留下的那段），措辞照
   * lib/trajectory.js clipForTrajectory 的原句。服务端在正文尾部写了同一句就不再
   * 重复；没写（truncated 字段在、句子不在）就地补上——绝不静默砍尾。
   */
  function trajTruncNote(t, text) {
    if (!t || typeof t.total !== 'number') return '';
    if (String(text).indexOf('已截断') >= 0) return '';
    return '\n… 已截断，共 ' + t.total + ' 字符';
  }

  /**
   * 一条的正文（照 PC 的展开卡）：
   *   思考 = 普通 Markdown 段落（PC 的 compact 变体：13px/20px、三级灰、左缩进 22px，
   *          **不是等宽**——它是想的东西，不是机器吐的字节）；
   *   工具 = 「输入 / 输出」两栏卡（标签小字灰、正文等宽、细线分隔）——输入是美化后
   *          的 JSON（两空格，解析不了就原样），输出是结果文本，出错整段红色。
   * 自动审查被拒（照 PC）：参数不显示，只说清楚为什么没跑。
   * 截断标注照旧如实跟在后面。
   */
  /**
   * 待办清单（todo_write）：把参数里的 todos 画成勾选列表。
   * 解析不了就返回空串，回落到原来的「输入 JSON」——不假装渲染成功。
   */
  function trajTodoHtml(raw) {
    var args;
    try { args = JSON.parse(raw); } catch (err) { return ''; }
    var todos = args && Array.isArray(args.todos) ? args.todos : null;
    if (!todos || !todos.length) return '';
    var items = [];
    for (var i = 0; i < todos.length; i++) {
      var t = todos[i] || {};
      var status = t.status;
      var mark = status === 'completed' ? '✓' : (status === 'in_progress' ? '▸' : '○');
      var cls = status === 'completed' ? ' is-done' : (status === 'in_progress' ? ' is-doing' : '');
      var text = t.content || t.activeForm || '';
      items.push('<li class="todo-item' + cls + '"><span class="todo-mark">' + mark
        + '</span><span class="todo-text">' + escapeHtml(String(text)) + '</span></li>');
    }
    return '<ul class="traj-todo">' + items.join('') + '</ul>';
  }

  /** 工具参数里的文件路径（读/写/编辑/看图都会带 path）；拿不到就空串。 */
  function trajFilePath(e) {
    if (!e || !e.args) return '';
    var a;
    try { a = JSON.parse(e.args); } catch (err) { return ''; }
    if (!a || typeof a !== 'object') return '';
    var p = a.path || a.file || a.file_path;
    return typeof p === 'string' ? p : '';
  }

  function isAssistantKind(e) { return e.kind === 'think' || e.kind === 'say'; }

  function trajEntryBody(e) {
    var tr = e.truncated || {};
    if (isAssistantKind(e)) {
      if (e.kind === 'say') return trajSayHtml(e);
      if (!e.output) return '';
      return '<div class="traj-think">' + mdToHtml(e.output) + trajTruncLine(tr.think, e.output) + '</div>';
    }
    if (e.error && e.error.name === 'AutoReviewDeniedError' && e.error.code === 'AUTO_REVIEW_DENIED') {
      var reason = typeof e.error.reason === 'string' && e.error.reason
        ? e.error.reason : 'Auto review 未授权此次操作';
      return '<div class="traj-io"><div class="traj-io-row"><div class="traj-io-label">输出</div>'
        + '<div class="traj-io-body traj-io-err"><pre>工具未执行。原因：'
        + escapeHtml(reason) + '</pre></div></div></div>';
    }
    var rows = '';
    // 读/写/编辑这类工具：参数里的那个文件给一个「打开」入口，复用正文那条只读抽屉。
    var filePath = trajFilePath(e);
    if (filePath) {
      rows += '<div class="traj-io-row"><div class="traj-io-label">文件</div>'
        + '<div class="traj-io-body"><button type="button" class="file-link" data-file="'
        + escapeHtml(filePath) + '">打开 ' + escapeHtml(filePath) + '</button>'
        + '</div></div>';
    }
    var todoHtml = e.name === 'todo_write' ? trajTodoHtml(e.args || '') : '';
    if (todoHtml) {
      rows += '<div class="traj-io-row"><div class="traj-io-label">清单</div>'
        + '<div class="traj-io-body">' + todoHtml + '</div></div>';
    } else if (e.args) {
      // 改文件这类调用：两段原文并排没意义，画成增删对照（2026-11-14）。
      var pair = editPair(e.args);
      var diff = pair ? diffHtml(pair.before, pair.after) : '';
      if (diff) {
        rows += '<div class="traj-io-row"><div class="traj-io-label">改动</div>'
          + '<div class="traj-io-body">' + diff + '</div></div>';
      } else {
        rows += '<div class="traj-io-row"><div class="traj-io-label">输入</div>'
          + '<div class="traj-io-body"><pre>' + escapeHtml(trajPretty(e.args)) + '</pre>'
          + trajTruncLine(tr.args, e.args) + '</div></div>';
      }
    }
    var outText = e.output;
    if (!outText && e.error) {
      // 照 PC 的 resultText 兜底：空内容且失败时，给一行「名字: 码」，不装作没有结果。
      outText = (e.error.name || 'Error') + (e.error.code ? ': ' + e.error.code : '');
    }
    if (outText) {
      rows += '<div class="traj-io-row"><div class="traj-io-label">输出</div>'
        + '<div class="traj-io-body' + (e.error ? ' traj-io-err' : '') + '"><pre>'
        + escapeHtml(outText) + '</pre>' + trajTruncLine(tr.output, e.output || '') + '</div></div>';
    }
    if (!rows) return '';
    return '<div class="traj-io">' + rows + '</div>';
  }

  /** 截断标注（如实）：单起一行小字。 */
  function trajTruncLine(t, text) {
    var note = trajTruncNote(t, text);
    return note ? '<div class="traj-io-note">' + escapeHtml(note.trim()) + '</div>' : '';
  }

  /** 参数按 PC 的 formatToolBody：能解析就美化 JSON（两空格），解析不了就原样。 */
  function trajPretty(raw) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch (err) {
      return String(raw);
    }
  }

  // —— PC 同款词典（照抄 DSH 桌面端 0.2.0-rc.1，一个字不自创）——
  // 动作分类：dsh-client-ui-chat 的 activity()（工具名 → 动作）。
  function trajActivity(name) {
    var n = String(name || '');
    if (n === 'read') return 'read';
    if (n === 'read_image') return 'readImage';
    if (n === 'grep' || n === 'glob' || /_inspect$/.test(n)) return 'search';
    if (n === 'write') return 'write';
    if (n === 'edit' || n === 'apply_patch') return 'edit';
    if (n === 'bash' || n === 'pwsh' || n === 'exec_command' || n === 'write_stdin'
      || /^terminal_/.test(n)) return 'commands';
    if (n === 'run_code') return 'code';
    if (n === 'web_search') return 'webSearch';
    if (n === 'web_fetch') return 'webFetch';
    if (n === 'subagent' || /^subagent_/.test(n)) return 'subagents';
    if (n === 'todo_write' || n === 'create_goal' || n === 'update_goal' || n === 'get_goal') {
      return 'plan';
    }
    if (n === 'ask_user_question' || n === 'request_user_input') return 'questions';
    return 'tools';
  }
  // 动作 → 完成词 / 活动词（dsh-client-ui-chat 的 message.stepProcess.done.* 与 .* 本体）。
  var TRAJ_DONE = {
    thinking: '已完成分析', read: '已读取文件', readImage: '已读取图片', write: '已写入文件',
    search: '已搜索代码', edit: '修改了文件', commands: '执行了命令', code: '运行了代码',
    webSearch: '已搜索网页', webFetch: '已访问网页', subagents: '已协调子智能体',
    plan: '更新了计划', questions: '向用户提出了问题', tools: '已调用工具',
  };
  var TRAJ_LIVE = {
    thinking: '正在分析请求', read: '正在读取文件', readImage: '正在读取图片', write: '正在写入文件',
    search: '正在搜索代码', edit: '正在编辑文件', commands: '正在运行命令', code: '正在运行代码',
    webSearch: '正在搜索网页', webFetch: '正在访问网页', subagents: '正在协调子智能体',
    plan: '正在更新计划', questions: '等待你的操作', tools: '正在调用工具',
  };
  // 工具显示名（dsh-client-ui-tool 的 tool.title.*）。认不出名字的走变体标题，
  // 变体也没有就落「工具调用」——和 PC 的 generic 同一口径。
  var TRAJ_TOOL_TITLE = {
    read: '读取', read_image: '读取图片', write: '写入', edit: '编辑', apply_patch: '编辑',
    bash: '运行命令', pwsh: '运行命令', exec_command: '运行命令', write_stdin: '运行命令',
    grep: '搜索文件内容', glob: '查找文件', run_code: '运行代码',
    web_search: '网页搜索', web_fetch: '网页获取',
    todo_write: '更新任务清单', ask_user_question: '提问', request_user_input: '提问',
    create_goal: '创建目标', get_goal: '查看目标', update_goal: '更新目标',
    subagent: '创建子智能体', list_agents: '查看子智能体', send_message: '发送消息',
    interrupt_agent: '中断智能体', wait_agent: '等待子智能体', spawn_teammate: '创建队友',
  };
  var TRAJ_VARIANT_TITLE = {
    read: '读取', readImage: '读取', webFetch: '读取', search: '搜索',
    write: '写入', edit: '编辑', commands: '运行命令', code: '代码',
    thinking: '工具调用', tools: '工具调用',
  };
  function trajToolTitle(name) {
    var n = String(name || '');
    if (TRAJ_TOOL_TITLE[n]) return TRAJ_TOOL_TITLE[n];
    return TRAJ_VARIANT_TITLE[trajActivity(n)] || '工具调用';
  }
  // 图标：手写细线 SVG（1.5px 描边、currentColor），和全页图标同一种画法；
  // 画的是 PC 那套图标的角色（思考/读/搜/改/命令/代码/网页/子代理/计划/提问/工具）。
  var TRAJ_ICO = {
    thinking: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="9" r="5"/><path d="M9.5 18h5M10.5 21h3"/></svg>',
    read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L21 21"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/></svg>',
    commands: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 7l5 5-5 5"/><path d="M12 17h7"/></svg>',
    code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 8l-5 4 5 4"/><path d="M15 8l5 4-5 4"/></svg>',
    webSearch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4c3 3 3 13 0 16c-3-3-3-13 0-16z"/></svg>',
    subagents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="3"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
    plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7l2 2 3-3M4 17l2 2 3-3"/><path d="M12 8h8M12 18h8"/></svg>',
    questions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="8"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .8-1 1.7"/><path d="M12 16.5h.01"/></svg>',
    tools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 4l1.5 4.5L18 10l-4.5 1.5L12 16l-1.5-4.5L6 10l4.5-1.5z"/></svg>',
  };
  function trajIco(kind) {
    return TRAJ_ICO[kind] || TRAJ_ICO.tools;
  }
  /** 折叠处给思考行的那一句：正文首行，压成一行、限 160 字（DSH 的行内摘要同款口径）。
      星号去掉（PC 同款：摘录是给人扫的，星号只会碍眼——5854）。 */
  function trajFirstLine(text) {
    var s = String(text == null ? '' : text).split('\n')[0].replace(/\s+/g, ' ').trim();
    s = s.replace(/\*\*/g, '');
    return s.length > 160 ? s.slice(0, 159) + '…' : s;
  }

  /**
   * 扫光的起点接「全局时钟」：页面每次整块重画都会把动画打回开头，每次都从头扫
   * 就成了频闪。带上当前时间在 1.5 秒周期里的位置（负 delay），重画之后接着
   * 上次的相位走，肉眼看不出断口。
   */
  function trajShimStyle() {
    return ' style="animation-delay:-' + ((Date.now() % 1500) / 1000).toFixed(3) + 's"';
  }
  /**
   * 收官标题：照抄 DSH 的 processTitle——工具条目按动作分类计数（多的在前，一样多按
   * 出现先后），取前三类拼完成词；两类共享「已」字时第二个去「已」用「并」连，
   * 三类用「，」连，超过三类加「等」；一条工具都没有（纯思考）落「已完成分析」。
   */
  function trajTitleOf(g) {
    var order = [];
    var count = {};
    var es = g.entries || [];
    for (var i = 0; i < es.length; i++) {
      if (!es[i] || es[i].kind !== 'tool') continue;
      var k = trajActivity(es[i].name || '');
      if (count[k] === undefined) { count[k] = 0; order.push(k); }
      count[k] += 1;
    }
    order.sort(function (a, b) { return count[b] - count[a]; });
    var labels = order.slice(0, 3).map(function (k) { return TRAJ_DONE[k]; });
    var first = labels[0];
    if (first === undefined) return { kind: 'thinking', text: TRAJ_DONE.thinking };
    if (labels[1] === undefined) return { kind: order[0], text: first };
    if (labels.length === 2) {
      var second = labels[1];
      if (first.indexOf('已') === 0 && second.indexOf('已') === 0) second = second.slice(1);
      return { kind: order[0], text: first + '并' + second };
    }
    return {
      kind: order[0],
      text: first + '，' + labels.slice(1).join('，') + (order.length > 3 ? '等' : ''),
    };
  }
  /**
   * 工具调用**正在拼的那半截参数**，压成一行给人看（2026-10-21）。
   *
   * 参数是 JSON（`{"path":"I:\\…","content":"…"}`），原样贴在标题行上是一屏噪音。
   * 这里只做两件事：**去掉键名和引号这类记号**、**留最后一截**——真正要看的是路径或命令
   * 那一段，它总在尾巴上。宁可短、宁可糙，也不要把一整坨 JSON 端给用户。
   */
  function liveToolTail(args) {
    var s = String(args || '');
    if (!s) return '';
    var tail = s
      .replace(/"[a-z_]+"\s*:\s*/gi, '')   // 键名
      .replace(/[[\]{}"]/g, '')            // 括号和引号
      .replace(/\\n/g, ' ')                // 转义换行
      .replace(/\s+/g, ' ')
      .trim();
    return tail.length > 120 ? '…' + tail.slice(-119) : tail;
  }

  /** 组头的图标与标题：跑着是活动词（正在…），收官是组合标题。 */
  function trajGroupTitle(g) {
    if (g.state === 'running') {
      var es = g.entries || [];
      var last = null;
      for (var i = es.length - 1; i >= 0; i--) {
        if (es[i] && es[i].state === 'running') { last = es[i]; break; }
      }
      // 还没有工具步在跑（正在想）就落「正在分析请求」——和 PC 的兜底同一个词。
      var kind = last && last.kind === 'tool' ? trajActivity(last.name || '') : 'thinking';
      // 活片段优先（正在想的那一句，随打字刷新，PC 的 label · detail 同款）；
      // 没有片段才退到条目自己的摘要。
      //
      // **2026-10-21 加一段**：模型正在拼工具参数时，把**半截命令**顺出来（流式开关
      // 开着才有这个数据）。优先于思考片段——因为走到工具这一步，思考已经结束了。
      var prose = '';
      if (state.liveTool && (state.liveTool.args || state.liveTool.name)) {
        kind = trajActivity(state.liveTool.name || '');
        prose = liveToolTail(state.liveTool.args);
      }
      prose = prose
        || state.trajectoryLive
        || (last && last.kind === 'think' ? trajFirstLine(last.output) : '');
      var plain = !prose && last ? (last.summary || '') : '';
      // 右边那半边是模型原话时走行内渲染：**加粗**、`代码` 要成样式，不是把记号原样贴在
      // 脸上（2026-10-06 用户报的，和 2026-09-27 气泡那回同一个根因）。
      // 工具摘要**不**走——那是命令/路径原文，一条「ls *.ts *.js」里的两个星号会被斜体
      // 规则吃掉（在真渲染器上试过），摘要就照旧只转义。
      var detail = prose ? mdInline(prose) : (plain ? escapeHtml(plain) : '');
      return { kind: kind, live: true, text: TRAJ_LIVE[kind], detailHtml: detail };
    }
    return trajTitleOf(g);
  }

  /**
   * 旁白那一段（对用户说的话，别的模式由鲸鱼娘气泡念，2026-10-04 起完整模式塞回轨迹）：
   * 照 PC 是过程里的一段正文——不带图标、不可点开，说完就摆在这儿。
   * 正文走 markdown 渲染（和回答区一个待遇：粗体、行内代码、列表都认），
   * 不是原样贴星号（同日用户顺手报的）。
   */
  function trajSayHtml(e) {
    var tr = e.truncated || {};
    return '<div class="traj-say">'
      + mdToHtml((e.output || '') + trajTruncNote(tr.output, e.output || '')) + '</div>';
  }

  /** 一行一条（PC 的成员行）：图标 +「显示名 · 摘要」，失败/进行中顶在这一行上。 */
  function trajEntryHtml(e) {
    if (e.kind === 'say') return trajSayHtml(e);
    var think = e.kind === 'think';
    var kind = think ? 'thinking' : trajActivity(e.name || '');
    var label = think ? '思考' : trajToolTitle(e.name || '');
    // 自动审查拒绝（照 PC）：行上摘要直接换成「Auto review 已拒绝」，别的都不重要了。
    var denial = e.error && e.error.name === 'AutoReviewDeniedError'
      && e.error.code === 'AUTO_REVIEW_DENIED';
    // 思考行展开后行上只留「思考」（照 PC：摘录是折叠态的预览，展开了就退场）；
    // 工具行不一样——展开后标题·摘要照旧留着（PC 的 keepContentWhenOpen）。
    var open = trajEntryIsOpen(e);
    var detail = denial ? 'Auto review 已拒绝'
      : think ? (open ? '' : trajFirstLine(e.output)) : (e.summary || '');
    // 跑着的行整行扫光（2026-10-04 用户点名：「某一行正在运行时会有一个渐变的效果
    // 闪过去」）。不跑的行一个字节不变——类名后缀为空时拼出来就是原样。
    var shim = e.state === 'running';
    var shimCls = shim ? ' traj-shimmer' : '';
    var shimSty = shim ? trajShimStyle() : '';
    // 内容段与状态段**分开**：内容段一行截断（照 PC 的折叠行——折叠行是给人扫的），
    // 出错/进行中的字样是独立的一段，不许被省略号吃掉（2026-10-04 真机返修）。
    var body = '<span class="traj-detail' + shimCls + '"' + shimSty
      + '>' + (detail ? ' · ' + escapeHtml(detail) : '') + '</span>';
    var chips = '';
    if (e.error) chips = ' · <span class="traj-err">' + escapeHtml(trajErrLine(e)) + '</span>';
    else if (e.state === 'running') chips = ' · <span class="traj-run">进行中</span>';
    var row = '<button type="button" class="traj-row" data-traj-entry="'
      + escapeHtml(e.id) + '"><span class="traj-ico">' + trajIco(kind) + '</span>'
      + '<span class="traj-name' + shimCls + '"' + shimSty + '>' + escapeHtml(label) + '</span>'
      + body + chips + '</button>';
    return '<div class="traj-entry">' + row
      + (trajEntryIsOpen(e) ? trajEntryBody(e) : '') + '</div>';
  }

  /**
   * 主页面窗口里只画这三种条目：思考 / 旁白 / 工具——保持它原来的样子。
   * 用户、上下文、系统三类只属于「完整轨迹页」（右下角最大化点开那层），
   * 不往主页面窗口里塞（2026-11-03 用户定的）。
   */
  function trajInlineEntries(g) {
    var es = (g && g.entries) || [];
    var out = [];
    for (var i = 0; i < es.length; i += 1) {
      var k = es[i] && es[i].kind;
      if (k === 'think' || k === 'say' || k === 'tool') out.push(es[i]);
    }
    return out;
  }

  /** 一个轮次组：PC 的组头一行（图标 + 状态词/标题），摊开时下面挂条目。 */
  function trajGroupHtml(g) {
    var open = trajGroupIsOpen(g);
    var t = trajGroupTitle(g);
    // 右半边（活片段/思考原话）在来源处已经渲染好、也转义过，见 trajGroupTitle；
    // 状态词与收官标题是我们自己拼的词，这里照旧转义。
    var title = t.live
      ? '<span class="traj-run traj-shimmer"' + trajShimStyle() + '>' + escapeHtml(t.text)
        + (t.detailHtml ? ' · ' + t.detailHtml : '') + '</span>'
      : '<span class="traj-title">' + escapeHtml(t.text) + '</span>';
    // 组头只显示状态词/标题，失败信息在下方条目行里显示，不重复。
    var inline = trajInlineEntries(g).filter(function (e) {
      // 还没有内容的旁白行不占位置：它会让窗口底部凭空多出一截空白（2026-11-04）。
      // 只有空白的旁白行同样不占位：流式中间那一下是空格或换行，画出来就是一块空白。
      return e.kind !== 'say' || String(e.output || e.summary || '').trim() !== '';
    });
    var head = '<button type="button" class="traj-head" data-traj-group="'
      + escapeHtml(String(g.turn)) + '"><span class="traj-ico">' + trajIco(t.kind) + '</span>'
      + '<span class="traj-chev">' + (open ? '▾' : '▸') + '</span>'
      + title + '</button>'
      + (open && inline.length
        ? '<button class="traj-max" type="button" data-traj-max="' + escapeHtml(String(g.turn)) + '"'
          + ' aria-label="看完整轨迹" title="看完整轨迹">'
          + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">'
          + '<path d="M9 4H4v5M15 20h5v-5M4 4l6 6M20 20l-6-6"/></svg></button>'
        : '');
    var entries = open && inline.length
      ? '<div class="traj-win"><div class="traj-entries" data-traj-scroll="' + escapeHtml(String(g.turn)) + '">'
        + inline.map(trajEntryHtml).join('') + '</div></div>'
      : '';
    return '<div class="traj-group">' + head + entries + '</div>';
  }

  /**
   * 把每轮的过程组插回它那轮对话的原位（10.3-1，对齐 DSH 的 turn-process 位置）。
   * 落点四条：
   *   a 该轮**第一个回答之前**——「指令 → 过程 → 回答」；
   *   b 该轮没有回答（跑着/失败）落该轮**簇尾**（活轮即页尾，新步骤从这里冒出来）；
   *   c 该轮有消息但都不在窗口里 → **不画**（组跟消息走，翻页上来自然带进来）；
   *   d 该轮一条消息都没有（排队被滤掉、本地回显没号）→ 兜底**页尾**。
   * rows[i] 与 list[i] 一一对应（list＝裁好窗的消息，all＝滤掉排队后的全量）。
   * 返回插好之后的新数组，不动入参。
   */

  function trajInterleave(rows, list, all) {
    var groups = (state.trajectory || []).filter(function (g) {
      // 空组也可能是「正在想」的那一轮：turn/start 刚到、条目要等这一步说完才落
      // （DSH 的事件就是这么给的）。它就是进展本身，不许因为还没条目就整组不画——
      // 真机上那正是「跑的时候一片安静、跑完一次性全冒出来」的观感
      // （2026-10-04 用户报的）。跑完还是空的才不画：那一组确实没有过程。
      return g && Array.isArray(g.entries) && (trajInlineEntries(g).length > 0 || g.state === 'running');
    });
    // 服务端那句「这不是全部」跟着轨迹内容走（11.1-C）：排在第一个过程组前面；
    // 一个过程组都没有（含轨迹读不到那条路）就兜底页尾——话必须说，位置不抢戏。
    var noteHtml = trajNoticeHtml();
    if (!groups.length) return rows.slice().concat(noteHtml ? [noteHtml] : []);
    var slots = [];
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var at = -1;
      // a：该轮第一个回答之前
      for (var j = 0; j < list.length && at < 0; j++) {
        if (list[j] && list[j].role === 'assistant' && sameTurn(list[j].turn, g.turn)) at = j;
      }
      // b：没有回答就落簇尾
      if (at < 0) {
        for (var k = list.length - 1; k >= 0; k--) {
          if (list[k] && sameTurn(list[k].turn, g.turn)) { at = k + 1; break; }
        }
      }
      if (at < 0) {
        // c/d：窗口里没有这一轮的消息——全量里有＝出窗不画；没有＝兜底页尾。
        var anywhere = false;
        for (var n = 0; n < (all || []).length; n++) {
          if (all[n] && sameTurn(all[n].turn, g.turn)) { anywhere = true; break; }
        }
        if (anywhere) continue;
        at = list.length;
      }
      slots.push({ at: at, turn: g.turn, html: trajGroupHtml(g) });
    }
    // 同一落点上的组按轮号排（兜底页尾时可能好几组），插的时候按落点从前往后放。
    slots.sort(function (x, y) { return x.at - y.at || x.turn - y.turn; });
    var out = [];
    var s = 0;
    var noted = false;
    for (var p = 0; p <= rows.length; p++) {
      while (s < slots.length && slots[s].at === p) {
        if (noteHtml && !noted) { out.push(noteHtml); noted = true; }
        out.push(slots[s++].html);
      }
      if (p < rows.length) out.push(rows[p]);
    }
    if (noteHtml && !noted) out.push(noteHtml);
    return out;
  }
  /** 轮号对得上吗：两边都要有号，再比字符串（号来自消息字段/组字段，类型不总一致）。 */
  function sameTurn(a, b) {
    return a != null && b != null && String(a) === String(b);
  }

  /**
   * 服务端「这份轨迹不是全部」的说明（state.trajectoryNote / trajectoryTruncated）。
   * 给了原句就原样显示；只有截断标志没给句子时补一句大实话兜底。**存在才显示**——
   * 一个字都没有时不许占地方，完整模式的观感必须和聊天一致。轨迹空了但服务端留了
   * 话（读取失败那条路）也要说：「读不到」不等于「没有过程」。
   */
  function trajNoticeHtml() {
    if (state.trajectoryNote) {
      return '<div class="traj-note">' + escapeHtml(state.trajectoryNote) + '</div>';
    }
    if (state.trajectoryTruncated) return '<div class="traj-note">这份轨迹不是全部。</div>';
    return '';
  }

  // 轨迹区的点击全走这一根委托。先认条目再认组头——行和头各带各的 data 属性，
  // 认错一个就拨错层。
  function onTrajectoryClick(e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    // 右下角「最大化」：先进它，不然会被当成组头/条目的点击。
    var maxBtn = t.closest('[data-traj-max]');
    if (maxBtn) { openTrajPanel(); return; }
    var row = t.closest('[data-traj-entry]');
    if (row) { toggleTrajEntry(row.getAttribute('data-traj-entry')); return; }
    var head = t.closest('[data-traj-group]');
    if (head) toggleTrajGroup(head.getAttribute('data-traj-group'));
  }

  /**
   * 「回到底部」那颗浮标的露 / 收。
   *
   * 判据直接用 atBottom()，不另设一个数。这样有个好处：**浮标出现的那一刻，正好
   * 就是页面停止自动跟随的那一刻**——两处要是各用各的容差（比如浮标 25px、跟随 48px），
   * 中间那段就会出现「浮标说没到底、页面却自己在往下滚」这种自相矛盾的样子。
   * 电脑端那颗用的是它自己的 25px 容差（useChatReading 里的 useScrollFollow(_, 25)），
   * 这里跟的是本页既有的 48px，因为本页的黏底判据就是它。
   *
   * **单帧模式下一律不出现**（用户 2026-10-08 要求）。那一模式整屏只留最新一条回答，
   * 回答落定的那一刻页面**故意**把它的开头对齐到顶部（见 renderMinimal 里
   * scrolledReplyAt 那一段），好让人从第一行读起。所以那儿「不在底部」是设计如此，
   * **不是「用户翻上去了」**——这时候挂一颗「回到底部」，等于劝用户把刚对齐好的
   * 开头再滚掉，正好把这个模式唯一要做的事抵消掉。
   * 聊天 / 完整是多帧（一串历史一条条往上排），那里不在底部就是用户自己翻上去的，
   * 照旧出现。所以这条判的是**模式**（state.mode），不是新设一个「离底多少像素」。
   *
   * 只改 hidden，**不碰任何位置和尺寸**：位置全在 CSS 的 sticky 里算好了（见样式表）。
   * 每次现取元素、取不到就静静退出——页面测试会把 render 那一段单独抠出来跑，
   * 那里给的 $ 是替身，不能假设它一定认得这个 id。
   */
  function paintToBottom() {
    var el = $('toBottom');
    if (!el) return;
    el.hidden = atBottom() || state.mode === 'minimal';
    // 正文还在流：给圆外挂一圈流光（只是状态指示，不改显隐、不改位置）。
    // 页面测试里的替身不一定有 classList，取不到就静静跳过。
    if (el.classList && el.classList.toggle) {
      el.classList.toggle('streaming', Boolean(state.live) && state.mode !== 'minimal');
    }
  }

  // 每个会话各自的滚动位置（切回去时还原）。挂在 state 上，切片测试里也拿得到。
  // 结构：{ <sessionId>: scrollTop }；切会话后等着还原的那一次放在 state.scrollRestore。

  function render() {
    $('hintMode').textContent = modeHint();
      if (state.mode === 'full') renderFull(); else if (state.mode === 'chat') renderChat(); else renderMinimal();
    // 切会话后的位置还原：有记录回原处，没记录贴底（2026-11-03）。
    applyScrollRestore();
    // 「完整」模式不放装饰（11.1-B）：给常驻的 #work 挂 bare，立绘、气泡、光流
    // 进度条由 CSS 藏掉，只留「已 N 秒 / 停止」。#work 不跟着 #reply 重画，
    // 所以这一下挂在总分发这里，切模式时各归各位。
    $('work').className = 'work' + (state.mode === 'full' ? ' bare' : '');
    // 重画之后滚动位置可能被浏览器夹回来（内容变短）——那种情况不一定发 scroll 事件，
    // 所以浮标的状态也在这里跟一次。放在最后：上面几句可能刚动过 scrollTop。
    paintToBottom();
  }

  /** 切会话后的滚动还原；只在目标会话还是当前会话时生效，用完即弃。 */
  function applyScrollRestore() {
    var restore = state.scrollRestore;
    if (!restore || restore.session !== state.boundSessionId) return;
    state.scrollRestore = null;
    var max = Math.max(0, mainEl.scrollHeight - (mainEl.clientHeight || 0));
    mainEl.scrollTop = typeof restore.top === 'number' ? Math.min(restore.top, max) : max;
  }

  /**
   * 只重画「正在流」那一块，不重画整串聊天（2026-10-22 真机）。
   *
   * 为什么非拆不可：正文每 60 毫秒来一帧，原来每一帧都走完整 `render()` ——手机要把
   * 整串历史重新拼一遍 HTML、重新算布局。主线程一旦跟不上，用户只看得见开头几帧，
   * 后面的字还在队列里排队；等落定的 `reply` 一到，整段回答一次性替换上来——看起来
   * 就是「流了一下，内容消失，然后全文蹦出来」。
   *
   * 这里只换 `.live .md` 的 innerHTML。第一次还没有 `.live` 时仍走完整 render（那一趟
   * 负责把块建出来并滚到它开头）；之后每帧都只碰这一小块。清空/落定/换模式仍走完整
   * render，别让这条快路把别的状态带偏。
   */
  var livePaintedText = null;
  function paintLive() {
    var md = replyEl.querySelector ? replyEl.querySelector('.live .md') : null;
    if (!md) { render(); return; }
    var text = state.live || '';
    if (text === livePaintedText) return;
    livePaintedText = text;
    // 「在不在底部」要在换内容之前问，换完高度就变了（同 atBottom 那段注释）。
    var wasAtBottom = atBottom();
    md.innerHTML = mdToHtml(text);
    followLive(wasAtBottom);
  }

  /** 流式刷新按帧合并：服务端约 60ms 推一次，但一帧最多重画一次（2026-11-03）。 */
  var livePaintQueued = false;
  function schedulePaintLive() {
    if (livePaintQueued) return;
    livePaintQueued = true;
    var run = function () { livePaintQueued = false; paintLive(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /**
   * 流式跟随（2026-11-03 用户口径）：不到一屏时贴底跟着长；满一屏那一下对齐正文第一行
   * 并冻结，之后不再跟。用户换内容前就不在底部（在往上读）也不跟。
   */
  function followLive(wasAtBottom) {
    var liveEl = replyEl.querySelector ? replyEl.querySelector('.live') : null;
    if (!liveEl || livePinned) return;
    var view = mainEl.clientHeight || 0;
    if (!view) return;
    var blockH = 0;
    if (liveEl.getBoundingClientRect) blockH = liveEl.getBoundingClientRect().height || 0;
    else blockH = liveEl.offsetHeight || 0;
    if (blockH >= view) {
      // 满一屏：对齐开头。顶不上去（页面还不够长）就继续贴底，等下一帧再试。
      var line = firstContentLine(liveEl);
      if (!line || typeof line.getBoundingClientRect !== 'function') return;
      var gap = line.getBoundingClientRect().top - mainEl.getBoundingClientRect().top;
      var maxScroll = mainEl.scrollHeight - view;
      if (mainEl.scrollTop + gap - 12 > maxScroll + 1) return;
      pinToTop(liveEl);
      livePinned = true;
      return;
    }
    if (!wasAtBottom) return;
    // 还没满一屏：每帧贴底，看起来就是页面跟着字往下走。
    mainEl.scrollTop = mainEl.scrollHeight;
  }

  function applySnapshot(snap) {
    if (!snap) return;
    if ('latest' in snap) state.latest = snap.latest;
    // 正在流出来的那一段。服务端只在自己决定要显示之后才写它，所以这里是空字符串
    // 不代表模型没在写，只代表「还不到显示的时候」。
    //
    // **2026-10-21 加一个前提**：流式开关开着时，这一段由 `trajectory-live` 的增量自己拼
    // （见那个 `kind: 'text'` 分支），快照里那个 `live` 是另一套东西（服务端按整段写的），
    // 照旧覆盖会把刚拼上去的字清掉、只剩最后一小截。落定由 `trajectory` 帧负责清，不靠这里。
    if ('live' in snap && !state.streaming && !state.streamReceived) state.live = snap.live || '';
    // 模型此刻的自言自语（鲸鱼娘的台词）。null = 这会儿没话说，气泡回到该姿势自己的词条。
    if ('thought' in snap) state.thought = snap.thought || null;
    if (snap.history) state.history = snap.history;
    // 「服务端正去读这个会话的完整记录」。点开一个没看过的会话时，那一串要读一会儿
    // 才补上来（最大的那条日志 20 MB、约半秒），这期间不能装作「这个会话是空的」。
    state.historyLoading = snap.historyLoading === true;
    // 「这份历史只到最近一段」。服务端读历史有上限（会话太大只读日志尾部），
    // 所以内容可能是截断的——**这件事必须跟着内容一起传上来**，不能只在服务端知道。
    state.historyTruncated = snap.historyTruncated === true;
    state.historyNote = snap.historyNote || '';
    if (snap.sessions) state.sessions = snap.sessions;
    if (Array.isArray(snap.queued)) state.queued = snap.queued;
    if ('boundSessionId' in snap) {
      var wasBound = state.boundSessionId;
      state.boundSessionId = snap.boundSessionId;
      if (state.boundSessionId !== wasBound) {
        // 记下旧会话看到哪儿，换过去之后按新会话自己记住的位置还原（2026-11-03）。
        state.sessionScroll = state.sessionScroll || {};
        if (wasBound && typeof mainEl !== 'undefined') state.sessionScroll[wasBound] = mainEl.scrollTop;
        var savedTop = state.sessionScroll[state.boundSessionId];
        state.scrollRestore = {
          session: state.boundSessionId,
          top: typeof savedTop === 'number' ? savedTop : null,
        };
        // 刚发出去那条「贴底一次」属于旧会话，不能拿来滚新会话。
        state.scrollSentMessage = false;
        state.scrollSentSession = null;
        // 完整轨迹属于上一个会话，切走就作废（面板下次打开会重新读）。
        state.trajFull = null;
        state.trajFullFor = null;
        saCache = null;
        saCacheSession = null;
        saCacheAt = 0;
      }
      // 手里那份轨迹属于上一个会话——换会话立刻作废：两场会话的轮号会撞在一起，
      // 不清掉就会把新会话的过程贴到旧会话那一组上。完整模式下再拉一份新的。
      if (state.boundSessionId !== wasBound) {
        state.trajectory = [];
        state.trajectorySeq = 0;
        if (state.mode === 'full') requestTrajectory();
      }
      // 换了会话，指令菜单那份缓存就作废了（指令表是每个会话一份的，这个会话没在跑
      // 时一条都读不到，见「斜杠指令」那一段）。重画一次，它自己会发现数据不属于
      // 这个会话、去重取——否则用户点到的是上一个会话的指令，点下去必然被拒。
      if (state.boundSessionId !== wasBound) paintCmdMenu();
      // 权限档位也是每个会话各一份的（宿主的 currentValue 读的是这个会话那份投影）。
      // 不重读的话，抽屉里显示的是上一个会话那一档——用户看到的就是一句假话。
      if (state.boundSessionId !== wasBound) loadPermissions(state.boundSessionId);
    }
    // running 也在快照里，而且算的是**当前绑定的那个会话**。不接的话，
    // 在导航栏切到别的会话时，那个会话会继承上一个会话的「正在执行」。
    if ('running' in snap) setRunning(snap.running);
    if ('subagentsRunning' in snap) {
      state.subagentsRunning = snap.subagentsRunning === true;
      $('btnSubagents').classList.toggle('subagent-running', state.subagentsRunning);
      $('btnSubagents').setAttribute('aria-label', state.subagentsRunning ? '子智能体（运行中）' : '子智能体');
    }
    paintNavCurrent();
    render();
  }
