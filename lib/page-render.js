  // ---------------- 渲染 ----------------
  function setStatus(kind, text) {
    dotEl.className = 'dot ' + kind;
    statusEl.textContent = text;
  }
  function updateStatusUI() {
    if (!state.connected) { setStatus('err', '未连接'); return; }
    if (state.running) { setStatus('run', '运行中…'); return; }
    setStatus('ok', '已连接');
  }
  function setRunning(running) {
    state.running = !!running;
    // 这里原来会把输入框和发送按钮一起禁用。现在不禁了：跑着的时候**可以接着发**，
    // 那条会排队（见 send 的说明）。禁掉输入框等于把「排队」这条路从界面上封死，
    // 而 DSH 本身在跑着的时候是收的。
    updateStatusUI();
    // 放这里而不是 render() 里：SSE 的 status 事件只调 setRunning、不重绘，
    // 漏了这一处的话「运行中」变了而鲸鱼娘不出现。
    // 另外它也是**唯一**会调 paintWork 的地方，而 paintWork 还要看 state.live
    // （流式一露头就把鲸鱼娘收起来）。快照每次都带 running，所以 applySnapshot
    // 会走到这儿、live 的变化也就跟着生效了——别把这个调用挪走。
    paintWork();
  }

  /**
   * 单帧模式：「这一条回答」有没有已经带用户滚过顶了。
   *
   * **用 timestamp 当身份**，因为它是这里唯一稳定、且只在真推了一条新回答时才变的字段
   * （`pushReply` 每次都现取 `Date.now()`；重连、SSE 重推、切模式、从后台回来
   * 都只是把同一条回答重新渲染一遍，timestamp 不变）。
   *
   * 用户 2026-09-23 提的：「手机端的单帧模式，回答出现的时候，页面应该跳到顶部，
   * 方便用户阅读。」不记这个的话：一条长结论渲染出来，用户看到的是最后一行，
   * 得自己往上翻才读得到开头。
   *
   * 记成「已经为哪一条滚过顶」而不是一个「刚跳过」的布尔量，是为了不误伤上面那几种
   * 重新渲染——那些时候用户可能正读到一半，把他弹回顶部比不跳还烦人。
   * 初始值 0：开机第一次渲染时任何一条回答的 timestamp 都比它大，于是会跳一次，
   * 正好是「打开页面从最新那条的开头读起」。
   */
  var scrolledReplyAt = 0;

  function renderMinimal() {
    mainEl.classList.remove('center');
    var latest = state.latest;
    var live = state.live || '';
    var parts = [];
    // 「正在执行」不拼进这块 HTML——它是常驻的 #work，由 paintWork() 控制显隐。
    // 但它仍然显示在回答**下方**，不顶掉回答：原来它排在最前面并且直接 return，
    // 于是刚发完指令，上一步的结果就整块消失，用户看不到自己上一步得到了什么。
    if (latest && latest.text) {
      // 「已停止」留在正文**上方**：它是给正文打的预防针（你收到的只是半句），
      // 得在读到正文之前看到。
      // 复制按钮则挪到正文**下方、靠左**——原来在上面靠右，手机上拇指够不着，
      // 而且会比正文先入眼。
      var stopped = latest.interrupted ? '<span class="stopped">已停止</span>' : '';
      parts.push((stopped ? '<div class="reply-bar">' + stopped + '</div>' : '')
        + '<div class="md">' + mdToHtml(latest.text) + '</div>'
        + '<div class="reply-foot">'
        + '<button class="copy" type="button" aria-label="复制全文" title="复制全文"'
        + ' data-copy="' + escapeHtml(latest.text) + '">' + ICON_COPY + '</button>'
        + '</div>');
    }
    // 刚跑完的那条指令也要露出来（判据和为什么见 commandTail）。
    // 「正在执行」那块照旧：它是常驻的 #work，跟这里没关系。
    var tail = commandTail();
    if (tail) parts.push(commandBlock(tail));
    // 子智能体刚完工的那条通知同理（判据见 noticeTail）。它出现在这里的时机很窄——
    // 通知一到，父级通常会被唤醒作答，那条回答很快就会把它顶掉——但那一段空窗里
    // 屏幕上什么都不变的话，用户会以为子智能体那边没消息。
    var note = noticeTail();
    if (note) parts.push(noticeBlock(note));
    if (live) parts.push(liveBlock(live));
    if (parts.length) {
      var stick = atBottom();
      replyEl.innerHTML = parts.join('');
      // 流式的时候得跟着往下滚，不然新写出来的内容在屏幕外面，看起来像卡住了。
      // 但只在用户本来就在底部时才跟——他翻上去看历史的时候别拽他回来。
      if (live && stick) mainEl.scrollTop = mainEl.scrollHeight;
      // 单帧模式专属：**答案落定的那一刻**跳到顶部，让人从第一行开始读。
      //
      // 判据是 timestamp 变了，不是「渲染了一次」——重连、SSE 重推、切模式、
      // 从后台回来都会重新渲染同一条回答，那些时候用户可能正读到一半，
      // 弹回顶部比不跳还烦人（见 scrolledReplyAt 的说明）。
      //
      // 和上面那条黏底不冲突，两者管的是不同时刻：流式那会儿（live 还在）
      // 答案没落定，该跟着往下走；落定之后才轮到这一条把它拉回开头。
      // 也别跟下面 send() 里那条「按了发送无条件回底部」搞混——那是用户自己的
      // 主动动作，他想看自己刚发出去的那条；这条是回答到了，他要读回答。
      if (latest && latest.timestamp && latest.timestamp !== scrolledReplyAt) {
        scrolledReplyAt = latest.timestamp;
        // 人本来就在底部（一直在看流式尾巴）：落定后留在底部，不拽回开头；
        // 其余情况照旧从第一行开始读（2026-11-03）。
        mainEl.scrollTop = stick ? mainEl.scrollHeight : 0;
      }
      return;
    }
    if (state.running) {
      replyEl.innerHTML = '';
      return;
    }
    // 正在去读这个会话的记录：这时候说「在下面输入一条指令」是不对的——
    // 这个会话其实有历史，只是还没读完。单帧模式只显示最后一条回复，
    // 那一条也在这份记录里。
    if (state.historyLoading) {
      replyEl.innerHTML = '<div class="placeholder">正在读取这个会话的记录…</div>';
      return;
    }
    replyEl.innerHTML = '<div class="placeholder">在下面输入一条指令，'
      + '这里只会显示 AI 的最终回复。<br>中间的工具调用和执行过程不会传过来。</div>';
  }

  /**
   * 正在流出来的那一段。
   *
   * **刻意和答案画得不一样**：上面一条虚线，末尾一个一闪一闪的竖条，而且**没有
   * 复制按钮**。这三样都在说同一句话——「这不是最终答案，还会变」。等真正的答案
   * 落定，这一整块会被换掉。
   *
   * 为什么要区分得这么清楚：流式阶段拿不到完整内容，没法提前知道模型这一步会不会
   * 去调工具。服务端已经先用一小段「按兵不动」把绝大多数中间旁白挡在外面了
   * （见 lib/index.js 的 STREAM_GRACE_MS），但那是启发式、不是判据。万一漏过来
   * 一句旁白，它会被撤回——那时候用户看到的应该是「刚才那段是过程，不作数」，
   * 而不是「我的回答怎么没了」。
   */
  /** 流式正文里有没有真字：只有空格/换行时不该占位置。 */
  function hasLiveText() {
    return typeof state.live === 'string' && state.live.trim() !== '';
  }

  function liveBlock(text) {
    return '<div class="live"><div class="md">' + mdToHtml(text) + '</div></div>';
  }

  /**
   * 历史里的一条指令（`role:'command'`）：这个会话执行了 /xxx，跑到哪一步了。
   *
   * 为什么单独一种长相：它既不是用户说的话，也不是 AI 说的话，而是**会话做的一个
   * 动作**。套上气泡就成了一句人说的话，会被当成回答去读；给它复制按钮也没有意义
   * （「/compact 执行中…」没有拿走的必要）。所以收成一行紧凑的条目：名字用等宽字体，
   * 后面直接跟结果。
   *
   * 三种状态里只有 running 是「还不知道结果」：服务端在这一条上**不报进度**，
   * 所以只能说「执行中…」——编一个百分比就是撒谎。
   *
   * 这两个函数夹在 liveBlock 和 renderChat 中间是有原因的，**别挪**：page.test.mjs
   * 是按源码里的锚点串切片的——聊天模式那一套从 liveBlock 那一段切到 render 那一段，
   * 单帧模式那一套从 scrolledReplyAt 那一段切到 renderChat 那一段，两把刀的交集就是
   * 这里。放到交集外面，总有一套测试一跑就 ReferenceError。
   * （顺带一句：这段注释里**不能**写出那几个锚点串的完整样子，否则 indexOf 会先命中
   *   注释、把切片截断，报出来的是「SyntaxError」而不是人话。）
   */
  function commandBlock(m) {
    // args 是名字后面**原样**的输入（含分隔空格），可能为空串——所以直接拼，
    // 不自己补一个空格：补了就把「用户到底敲了什么」改样了。
    var line = '/' + (m.name || '') + (m.args || '');
    var kind = m.kind === 'error' ? 'error' : (m.kind === 'success' ? 'success' : 'running');
    var res = kind === 'error' ? (m.text || '没跑起来')
      : (kind === 'success' ? (m.text || '完成') : '执行中…');
    return '<div class="cmd ' + kind + '">'
      + '<span class="cmd-line">' + escapeHtml(line) + '</span>'
      + '<span class="cmd-res">' + escapeHtml(res) + '</span></div>';
  }

  /**
   * 单帧模式要跟着显示的那条指令：**历史里最后一条**，而且得真的是一条指令。
   *
   * 为什么要单独处理：单帧模式整屏只留最新一条回复，而指令**不产生回复**——用户点一下
   * /compact，这里要是什么都不画，屏幕上就是一动不动，看着像点了个没反应的按钮。
   *
   * 用「最后一条」而不是「最近一条指令」：中间要是夹了别的消息（指令跑完模型又答了
   * 一句），那条指令已经不是最新的事了，再把它贴在最下面就成了过期通知。
   *
   * 最后还有一道时间判断，别删。单帧模式的回答是走 SSE 的 reply 那条路来的，它
   * **不往 history 里塞东西**（只有聊天模式才塞），所以 history 的尾巴会一直停在那条
   * 指令上。不加这一道，新回答到了之后底下还挂着一条「执行中…」，看着像它卡住了。
   */
  function commandTail() {
    var h = state.history || [];
    var last = h.length ? h[h.length - 1] : null;
    if (!last || last.role !== 'command') return null;
    var lt = (state.latest && state.latest.timestamp) || 0;
    if (lt && last.timestamp && last.timestamp < lt) return null;
    return last;
  }

  /**
   * 一个会话 id 的「能区分人的那一段」。
   *
   * **不能直接取 id 的开头几位**：本机的会话 id 长这样 `session-80fd8f3c-…`，
   * 开头八位永远是 `session-`，一排子智能体就会全叫同一个名字。导航栏那边踩过
   * 同一个坑，page.test.mjs 里有一条守卫专门钉着它。所以先把 `session-` 这段
   * 人人相同的前缀去掉，再取一段开头——留下的才是真能区分它们的字符。
   */
  function shortSessionId(id) {
    var s = String(id || '');
    if (s.slice(0, 8) === 'session-') s = s.slice(8);
    if (!s) s = String(id || '');
    return s.slice(0, 8);
  }

  /**
   * 子智能体完工的那张卡片（聊天记录里的一种条目）。
   *
   * 它是**第三样东西**：不是用户说的话，也不是模型的回答，而是「这个会话派出去的
   * 一件事有结果了」。所以既不套用户气泡、也不画成回答正文——套上气泡就变成
   * 「我说过这句话」，混进正文又会被读成模型的话，两种都是假的。
   *
   * 展开/收起交给原生 `<details>`：不写一行脚本、不加一个关键帧，键盘和读屏也都认。
   *
   * 正文**原样贴出来**（`white-space: pre-wrap`，见 .sa-card .sa-body），不再解析：
   * 这段话是 DSH 生成的——它先说清「谁、为什么结束」，再把子智能体最后的原话接上。
   * 那是**转述**，不该由我们这边的渲染器再加工一遍。
   */
  function noticeBlock(m) {
    var who = m.senderSessionId ? shortSessionId(m.senderSessionId) : '';
    var when = m.timestamp ? timeLabel(m.timestamp) : '';
    return '<details class="sa-card"><summary><b>子智能体完工</b>'
      + (who ? '<span>' + escapeHtml(who) + '</span>' : '')
      + (when ? '<span>' + escapeHtml(when) + '</span>' : '')
      + '</summary><div class="sa-body">' + escapeHtml(m.text || '') + '</div></details>';
  }

  /**
   * 单帧模式要跟着显示的那条通知：**历史里最后一条**，而且得真的是一条通知。
   *
   * 判据和 commandTail 完全一样，连那道时间判断都照抄，理由也一样：
   *   - 用「最后一条」而不是「最近一条」：中间要是夹了别的消息（父级被唤醒后又答了
   *     一句），那条通知已经不是最新的事了，再贴在最下面就成了过期通知；
   *   - 单帧模式的回答走 SSE 的 reply 那条路，**不往 history 里塞**，所以 history
   *     的尾巴会一直停在那条通知上——不挡一下，新回答到了之后底下还挂着它。
   */
  function noticeTail() {
    var h = state.history || [];
    var last = h.length ? h[h.length - 1] : null;
    if (!last || last.role !== 'notice') return null;
    var lt = (state.latest && state.latest.timestamp) || 0;
    if (lt && last.timestamp && last.timestamp < lt) return null;
    return last;
  }

  /**
   * 该不该自动滚到底。
   *
   * 用户 2026-09-22 实机提的：「有动画的时候手机端页面运动到上面都会自动调回底部，
   * 这种机制没必要吧。」原来每次重画都无条件滚到底，而鲸鱼娘一帧一动、流式一秒七次，
   * 于是想往上翻根本翻不动——手一松就被拽回去。
   *
   * 改成只在**本来就在底部**的时候才跟着滚：新内容进来时视野跟着走，
   * 用户自己翻上去看历史时就不打扰他。
   *
   * 注意：这个判断必须在改 innerHTML **之前**做。改写内容本身会把滚动位置顶回去，
   * 改完再问「在不在底部」永远是「在」。
   */
  function atBottom() {
    // 48px 是「差不多到底了」的容差。手指滚动的惯性、地址栏收起都会差几个像素，
    // 卡得太死会变成「我明明就在底部，它却不跟着走了」。
    return mainEl.scrollHeight - mainEl.scrollTop - (mainEl.clientHeight || 0) < 48;
  }

  /**
   * 「对齐开头」到底对齐谁：**正文第一行**，不是外面那层容器。
   *
   * 流式那段把虚线移到不占高度的 ::before 上，第一行和落定回答的第一行在同一高度；
   * 这条函数保证两边量的都是**正文第一行**，而不是外面那层容器。2026-10-22 真机报的
   * 「落定第一行往上跳 14px」就是按容器顶量出来的。
   *
   * 用户气泡没有 `.md`，它自己的内边距就是文字位置，直接返回气泡本身；
   * 被按停的回答前面有「已停止」那条，要让它露出来，不能只锚正文。
   */
  function firstContentLine(el) {
    if (!el || typeof el.querySelector !== 'function') return el;
    if (el.classList && el.classList.contains('bubble')) return el;
    var first = el.firstElementChild;
    if (first && first.classList && first.classList.contains('reply-bar')) return first;
    var md = el.querySelector('.md');
    if (!md) return el;
    return md.firstElementChild || md;
  }

  /**
   * 把某一块的**开头**对齐到视野顶部（聊天模式用，见 renderChat）。
   *
   * 用两个矩形的差值算，不用 `offsetTop`：`main` 上没有 `position: relative`，
   * `offsetTop` 会一路找到 body 去，算出来是错的。矩形差值不管定位上下文怎么变都对。
   *
   * 留 12px 空隙：`main` 自己带 16px 内边距，滚下去之后那段内边距就滚没了，
   * 不留缝的话回答的第一行会顶在屏幕最上沿，看着像被切掉了。
   */
  function pinToTop(el) {
    var line = firstContentLine(el);
    if (!line || typeof line.getBoundingClientRect !== 'function') return;
    if (typeof mainEl.getBoundingClientRect !== 'function') return;
    var gap = line.getBoundingClientRect().top - mainEl.getBoundingClientRect().top;
    // 这里**不用**为顶上那颗「往上滑看更早的」让高度：对齐开头只在「他本来就在底部」
    // 的时候做（见 scrollChat），而那时候那颗提示是收着的（见 chatNoteVisible）——
    // 让高度反而会凭空多出一段空白。
    mainEl.scrollTop += gap - 12;
  }

  /**
   * 聊天记录**一次铺多少条**，以及这次已经铺到多少条。
   *
   * 用户 2026-09-30 报的：在导航栏点一个没选中的会话，切过去很慢。查下来不是网络、
   * 也不是服务端取数（本机实测那三个接口 168 / 36 / 107 毫秒），而是这一页**一次把
   * 推上来的 200 条记录全铺出来**。这 200 条本来就已经在页面手里了——所以「往上多放
   * 一点」是个纯本地动作，不用再问服务端，也该是瞬时的。
   *
   * 40 这个数：一屏通常放得下三到五段长回答，40 条够铺六七屏；首屏只干五分之一的活，
   * 而往上翻的人一次也就看一屏，翻不到边界。
   */
  var CHAT_PAGE = 40;
  var chatWindow = CHAT_PAGE;   // 从最新那条往回数，这次铺了多少条
  var chatWindowFor = null;     // 上面这个数是哪个会话的（换会话要收回首屏，见 renderChat）
  var chatLoaded = 0;           // 本地一共有多少条可铺（滤掉排队那条之后），由 renderChat 记
  var chatGrowArmed = true;     // 这一轮靠近顶部已经放过一屏没有（见 maybeGrowChat）

  /** 触发线：离顶一屏的四分之一以内。放一屏和那颗提示共用这一条，别写成两个数。 */
  function chatEdge() {
    return Math.min(160, Math.max(60, (mainEl.clientHeight || 0) / 4));
  }

  /** 顶上那颗「往上滑看更早的」的元素（没铺出来就没有）。 */
  function moreNoteEl() {
    return replyEl.querySelector ? replyEl.querySelector('.more-note') : null;
  }

  /**
   * 那句提示现在该不该露脸：**近了顶部、又不在底部**。
   *
   * 两个条件缺一不可——
   *   · 离顶远了它就没用：再往上滑一下就自动放一屏，用不着它催；
   *   · 在底部时它必须收起来（用户 2026-09-30 真机提的那条）：那句话是催人往上滑的，
   *     人已经在最底下读内容了，它挂在那儿只剩挡视线。
   */
  function chatNoteVisible() {
    if (atBottom()) return false;
    return mainEl.scrollTop <= chatEdge();
  }

  /**
   * 把提示的露 / 收跟当前位置对齐。
   *
   * 这是**滚动时**的那一半。重画只在快照来的时候发生，而用户从中间一路滑到底
   * 是不会等快照的——不在滚动里收，那条提示就会一直挂在顶上（真机就是这么发现的）。
   */
  function paintChatNote() {
    var el = moreNoteEl();
    if (!el || !el.classList || typeof el.classList.toggle !== 'function') return;
    el.classList.toggle('hide', !chatNoteVisible());
  }

  /** 这一条用户消息是不是长到该折叠。按字数与行数估，手机宽度下 240 字约十几行。 */
  function isLongUserText(text) {
    var s = text || '';
    if (s.length > 240) return true;
    return s.split('\n').length > 9;
  }

  /** 展开过的用户消息（键 = 会话 + 时间戳）。重画时靠它把「收起」状态留住。 */
  var expandedUserMsgs = Object.create(null);

  /**
   * 一条消息的 HTML。从 renderChat 的逐条循环里提出来：完整模式要把每轮的过程组
   * **穿插进这串消息的原位**（renderFull → trajInterleave），聊天模式直接按顺序拼——
   * 两边画同一条消息必须是同一段代码，两处各写一遍迟早走样。
   */
  function chatMsgHtml(m) {
    // 指令行：这是会话做的一个动作，不是谁说的话，单独一种长相——
    // 不套气泡、不给复制按钮（见 commandBlock 的说明）。
    if (m.role === 'command') return commandBlock(m);
    // 子智能体完工的通知：同一类「会话做的事」，画成一张可展开的卡片
    // （见 noticeBlock 的说明）。它没有复制按钮，也没有气泡。
    if (m.role === 'notice') return noticeBlock(m);
    // 被按停的那一轮：标一句，别让人以为模型答到一半断了。
    var stopped = m.interrupted ? '<span class="stopped">已停止</span>' : '';
    // 两种消息都给复制按钮。自己敲的指令也常有「再发一遍」「拿去别处用」的时候，
    // 原来只给 AI 气泡，用户反馈自己的话复制不了。
    var copyBtn = '<button class="copy" type="button" aria-label="复制" title="复制"'
      + ' data-copy="' + escapeHtml(m.text) + '">' + ICON_COPY + '</button>';
    if (m.role === 'user') {
      // 自己的指令：仍然是气泡，靠右。自己敲的是纯文本，不走 markdown——
      // 不然打几个星号就变样了。
      // 长指令先折起来：露开头几行 + 一个「展开」，不让它把整屏撑满。
      var key = (state.boundSessionId || '') + '|' + (m.timestamp || 0);
      var longText = isLongUserText(m.text);
      var expanded = !!expandedUserMsgs[key];
      var body = '<div class="bubble-text'
        + (longText && !expanded ? ' clamped' : '') + '">' + linkify(m.text) + '</div>';
      var more = longText
        ? '<button class="bubble-more" type="button" data-more="' + escapeHtml(key)
          + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">'
          + (expanded ? '收起' : '展开') + '</button>'
        : '';
      return '<div class="bubble user">' + body + more
        + '<span class="meta">' + stopped + timeLabel(m.timestamp) + copyBtn + '</span></div>';
    }
    // AI 的回答：**不套气泡**（用户要求「参考单帧模式那样」）。
    // 于是一左一右、一个有框一个没框，正好分得清谁说的。
    return '<div class="said">'
      + (stopped ? '<div class="reply-bar">' + stopped + '</div>' : '')
      + '<div class="md">' + mdToHtml(m.text) + '</div>'
      + '<div class="reply-foot">' + copyBtn
      + '<span class="time">' + timeLabel(m.timestamp) + '</span></div></div>';
  }

  /**
   * 聊天那一串的「料」：滤掉排队那条、按窗口裁好、逐条变行。
   *
   * 返回的是**结构**（行数组 + 对应消息 + 滤后全量），不是拼好的字符串——
   * renderChat 直接按顺序拼；renderFull 拼之前要把每轮的过程组插进 rows 的
   * 原位（见 trajInterleave），只有结构在手才插得动。
   *
   * searchTurns 是「搜索命中的轮号」（只在完整模式搜索时给）：命中轮的消息
   * 哪怕在窗口外也要露出来（10.3-3，「命中组在原位强开」的原位得先在场）。
   */
  function buildChat(searchTurns) {
    // 换了会话就把窗口收回首屏：上一个会话铺到多少条都不该跟过来——那正是这次要修的慢。
    // 判据用会话 id 而不是 history 的引用：服务端每次推的都是整份新数组，比引用永远「变了」。
    if (chatWindowFor !== state.boundSessionId) {
      chatWindowFor = state.boundSessionId;
      chatWindow = CHAT_PAGE;
    }
    // **还在排队的那条不算「已发出」，这里要把它从聊天记录里滤掉。**
    //
    // 用户 2026-09-22 实机提的：「排队的指令在轮到之前不该出现在指令气泡里，
    // 就像发出去了一样，应该轮到再发出去。」
    //
    // 光在发送时不记账还不够。DSH 的一条排队消息可能被**领走一步、那一步又被驳回、
    // 于是退回队列**（dsh-agent 的原话：preserve queued and steering inbox items
    // instead of discarding them）。退回去的时候，早先那条「它开始跑了」的事件已经
    // 发过，聊天记录就此留下一笔——而队列里也还有它。实测抓到过同一个 id 两处都在。
    //
    // 所以判据不能是事件，得是**队列本身**：队列里有它，它就还没轮到。
    // 等它真跑起来、从队列里消失，这一笔自然就露出来了。
    var queuedIds = {};
    (state.queued || []).forEach(function (q) { if (q && q.id) queuedIds[q.id] = true; });
    var list = (state.history || []).filter(function (m) {
      return !(m.role === 'user' && m.id && queuedIds[m.id]);
    });
    // 先记「本地一共有多少条」再分支：下面那条「还没有对话记录」的路也要把数记成 0，
    // 不然中途清空一次（服务端正在重读）会留着一个旧的条数，让 maybeGrowChat 白忙一场。
    chatLoaded = list.length;
    if (!list.length && !state.running && !state.live && !(state.queued || []).length) {
      // 「正在读」和「确实没有」是两件事，分开说。点开一个插件没看过的会话时，
      // 服务端要去 DSH 的会话记录里读它那一段（最大的那条 20 MB、约半秒），
      // 这期间说「还没有对话记录」会让人以为这个会话本来就是空的。
      return {
        empty: state.historyLoading
          ? '<div class="placeholder">正在读取这个会话的记录…</div>'
          : '<div class="placeholder">还没有对话记录。</div>',
        moreNote: '', rows: [], list: [], all: [],
      };
    }
    // **只铺最近那几十条**，剩下的留在手里等用户往上滑（来由见 CHAT_PAGE 那段）。
    // 切在**滤掉排队那条之后**：不然被滤掉的那条会白占一个名额。
    var older = Math.max(0, chatLoaded - chatWindow);
    // 搜索命中轮把窗口上沿抬到自己（10.3-3）：不然命中的过程组按「组跟消息走」
    // 的规矩被裁在窗口外，搜得到、看不见。
    if (searchTurns && searchTurns.length) {
      for (var t = 0; t < list.length; t++) {
        if (list[t] && searchTurns.indexOf(String(list[t].turn)) >= 0 && t < older) {
          older = t;
          break;
        }
      }
    }
    var all = list;
    if (older) list = list.slice(older);
    // 「上面还有，往上滑」要贴在**看得到的顶上**，而且**离顶远了就收起来**——
    // 两处讲究见 .more-note 的样式注释。露 / 收在这里先按当前位置定一次，
    // 之后由滚动里的 paintChatNote 接着跟。
    var moreNote = older
      ? '<div class="more-note' + (chatNoteVisible() ? '' : ' hide') + '">往上滑看更早的</div>'
      : '';
    return { empty: null, moreNote: moreNote, rows: list.map(chatMsgHtml), list: list, all: all };
  }

  function renderChat() {
    mainEl.classList.remove('center');
    var built = buildChat();
    if (built.empty) {
      replyEl.innerHTML = built.empty;
      return;
    }
    // 先问「在不在底部」，再改内容——顺序反了永远是「在」（见 atBottom 的注释）。
    var stick = atBottom();
    replyEl.innerHTML = chatFrame(built, built.rows.join(''), (state.live || '').trim() ? liveBlock(state.live) : '');
    scrollChat(stick);
  }

  /**
   * 往上滑到接近顶部，就再放一屏出来。
   *
   * 判据是「离顶部一屏的四分之一以内」，不要求真滑到 0：手机上惯性滚动会滑过头，
   * 卡在 0 反而要等一次回弹才触发。60 是下限（矮屏上四分之一太小，拇指一带就滑过），
   * 160 是上限（高屏上别放得太早，太早等于提前干了下一屏的活）。
   */
  function maybeGrowChat() {
    // 单帧模式那边也在往 main 上滚（回答落定要跳到页面顶端），别把那一下当成「他在往上翻」；
    // 本地都放完了也没什么可放的。完整模式画的也是这串聊天记录，翻页照旧要能放。
    if (state.mode === 'minimal' || chatLoaded <= 0) return;
    if (chatWindow >= chatLoaded) return;
    if (mainEl.scrollTop > chatEdge()) {
      // 滑下来了，这一轮重新装填：**一次靠近只放一屏**。
      // 不装填的话，万一位置校正没顶住（iOS 顶上那截橡皮筋会把人拽回 0），
      // 一次手势就能把 200 条连着放完——那正好把这个改动白做了。
      chatGrowArmed = true;
      return;
    }
    if (!chatGrowArmed) return;
    chatGrowArmed = false;
    growChat();
  }

  /** main 每一次滚动：先对齐那句提示的露 / 收，再看要不要再放一屏。 */
  function onMainScroll() {
    paintChatNote();
    maybeGrowChat();
  }

  /**
   * 往前多放一屏。纯本地动作：那些记录本来就在页面手里，不再问服务端。
   *
   * **放完必须立刻把位置校回来**，这是整件事最容易做坏的一步：往前面插内容，
   * 浏览器不会替你补偿，用户正看着的那一屏会被整个推下去一屏。
   *
   * 补偿用「离底部多远」：这次加的东西全在顶上，底部那一截一个字没动，
   * 所以只要这个距离不变，他眼前那几行就一格都不会走。别去量「原来那条消息」的
   * 矩形来对齐——重画是整块换 innerHTML，那条消息已经不在文档里了，量不着。
   */
  function growChat() {
    var fromBottom = mainEl.scrollHeight - mainEl.scrollTop;
    chatWindow += CHAT_PAGE;
    // 完整模式要走 render() 总分发：直画 renderChat 会把后面那块轨迹区抹掉。
    // （位置补偿和聊天同一套：轨迹区每次重画高度不变，底部那一截没动。）
    if (state.mode === 'full') render();
    else renderChat();
    mainEl.scrollTop = mainEl.scrollHeight - fromBottom;
  }

  /**
   * 聊天模式里「已经为哪一次回答把开头对齐到顶部」。
   *
   * 取值是 `'live'`（正在流的那一段）或 `'done:<timestamp>'`（落定的那条）。
   * 记这个是为了**每条回答只对齐一次**——不记的话，用户往下读的时候每次重画
   * 都会把他拽回开头，比不对齐还烦人。
   *
   * 声明放在这里而不是跟 scrolledReplyAt 作伴：page.test.mjs 是从 `liveBlock`
   * 切到 `render()` 来跑聊天模式的，放前面就切不进来，一跑就是 ReferenceError。
   */
  var pinnedAnswerKey = '';
  // 落定回答是否已经见过要单独记：live 暂时清空时 latest 还是上一轮，
  // 不能把「从 live 变回 done」误当成新回答到达。
  var seenSettledKey = '';
  // 程序上次自动对齐后的位置。仍停在这里才算「跟着看」：长回答的开头离底部
  // 可能超过一屏，单靠 nearEnd 会把它误当成在翻旧历史；用户滚走后则不继承。
  var pinnedAnswerSpot = null;
  // 这条流式回答是否已经「填满一屏、对齐过开头并冻结」（2026-11-03 用户口径：
  // 先跟随尾巴长，长满一屏那一下停在开头，之后不再跟随）。
  var livePinned = false;

  /**
   * 聊天模式的滚动：**回答的开头才是要读的地方，不是末尾。**
   *
   * 用户 2026-09-24 提的：「聊天模式下，回答出现时，页面也应该停留在回答的开头
   * 而非末尾，这样用户不用往上滚到开头」。
   *
   * 和单帧模式那条的区别：单帧只有一条回答，所以它对齐的是 0（页面顶端）；
   * 聊天模式有一串历史，要对齐的是**最新那条回答自己的开头**。
   *
   * 回答分两个阶段，各对齐一次（记号记在 pinnedAnswerKey 里）：
   *
   *   · **正在流**（live 非空）——不满一屏时由 `followLive` 每帧贴底跟随（新字一直
   *     在屏幕里）；长满一屏的那一下把**正文第一行**对齐到顶部并冻结，之后不再跟。
   *     2026-11-03 用户口径：先跟着长，长满一屏再定住。
   *
   *   · **落定**（timestamp 变了）——对齐最后那条 `.said` 的**正文第一行**，
   *     让最终版从第一行开始读。完整模式也一样（2026-10-22 用户拍板，取代
   *     2026-10-08「退回这一轮过程开头」那条：现在停在正文第一行，过程组会被推到上方）。
   *
   *   · 人已经停在上一轮回答附近、离底部不到一屏，也算「跟着看」：会动他。
   *     如果新回答短到顶不上去（滚到底也到不了第一行），按 2026-10-22 用户口径
   *     **直接贴底**，而不是停在上一轮的开头。离底部还远（在翻旧记录）仍旧不碰。
   *
   * 为什么要记 key、而不是「每次都对齐」：用户往下读的时候，每次重画都把他拽回
   * 开头，比不对齐还烦人。这一点和单帧模式里 scrolledReplyAt 的道理是一样的。
   */
  function scrollChat(stick) {
    var liveNow = state.live || '';
    var settledKey = state.latest && state.latest.timestamp ? 'done:' + state.latest.timestamp : '';
    var newest = liveNow ? 'live' : settledKey;
    var isNew = liveNow ? newest !== pinnedAnswerKey : !!newest && newest !== seenSettledKey;
    // 发送时展开 #work 会增加页面高度，让发送开头那次贴底失效。
    // 本地回显后强制贴底一次；若回答已经到来，仍让下面的回答对齐规则优先。
    var followSent = state.scrollSentMessage === true
      && state.scrollSentSession === state.boundSessionId;
    state.scrollSentMessage = false;
    pinnedAnswerKey = newest;
    if (!liveNow && settledKey) seenSettledKey = settledKey;
    if (followSent && !isNew) {
      // 刚发出的指令可能在上一轮还在流式时回显：这时 liveNow 仍是上一轮，
      // 也要先把新指令露出来；只有“新回答已经开始”才让下面的回答对齐规则优先。
      pinnedAnswerSpot = null;
      mainEl.scrollTop = mainEl.scrollHeight;
      return;
    }
    if (newest && isNew) {
      // 新的一条流式回答：跟随状态归零。之后每一帧由 followLive 决定是继续贴底，
      // 还是「已经满一屏、对齐开头并冻结」。
      if (liveNow) livePinned = false;
      var followsPinned = pinnedAnswerSpot !== null
        && Math.abs(mainEl.scrollTop - pinnedAnswerSpot) < 48;
      // 上面已经记账，接下来不再重复处理这条回答——
      // 用户往下读的时候被反复拉回开头，比不对齐还烦人。
      // **只在「他本来就在底部跟着看」的时候才动他。**
      //
      // 这一条不能省：用户 2026-09-22 实机提过「有动画的时候手机端页面运动到上面
      // 都会自动调回底部，这种机制没必要吧」。他要是自己翻上去看历史了，
      // 我们把他拽到回答开头，和当初拽回底部是同一类冒犯。
      //
      // 注意 stick 是**改 innerHTML 之前**问的（见 atBottom 的注释），
      // 所以它答的是「他刚才在不在底部」，正是这里要问的。
      // 「离底部不到一屏」也算跟着看：用户报的正是「停在上一轮回答开头」这个位置，
      // 他不是在翻很远的历史。远于一屏仍旧不碰（2026-09-22 那条不打扰规则）。
      var view = mainEl.clientHeight || 0;
      var nearEnd = view > 0 && (mainEl.scrollHeight - mainEl.scrollTop - view) < view;
      if (!stick && !nearEnd && !followsPinned) {
        pinnedAnswerSpot = null;
        return;
      }
      var target = null;
      if (liveNow) {
        target = replyEl.querySelector ? replyEl.querySelector('.live') : null;
      } else if (replyEl.querySelectorAll) {
        var saids = replyEl.querySelectorAll('.said');
        target = saids.length ? saids[saids.length - 1] : null;
        // 完整模式也停在正文第一行：过程组留在上方，不把回答顶下去（2026-10-22 用户拍板）。
      }
      // 先算这一下「顶不顶得上去」：回答太短时，滚到底也到不了第一行。
      // 2026-10-22 用户指的特定情况就是这种——不要停在上一轮的开头，直接贴底。
      var line = firstContentLine(target);
      var lineTop = line && typeof line.getBoundingClientRect === 'function'
        ? line.getBoundingClientRect().top : 0;
      var mainTop = mainEl.getBoundingClientRect ? mainEl.getBoundingClientRect().top : 0;
      var desired = lineTop - mainTop - 12;
      var maxScroll = mainEl.scrollHeight - view;
      var canPin = !!line && view > 0 && (mainEl.scrollTop + desired <= maxScroll + 1);
      pinToTop(target);
      if (!stick && !canPin) mainEl.scrollTop = mainEl.scrollHeight;
      // 一上来就已经满一屏（比如重连后补到的长段落）：这次对齐就是那一停，
      // 之后 followLive 不再动滚动。
      if (liveNow && canPin) livePinned = true;
      if (line) pinnedAnswerSpot = mainEl.scrollTop;
      return;
    }
    // 没有新回答的时候照旧黏底（历史重排、切会话、用户自己发指令这些）。
    // 流式期间的跟随不在这里——它要每帧都做，交给 paintLive → followLive。
    if (stick && !liveNow) mainEl.scrollTop = mainEl.scrollHeight;
  }

  /**
   * 三种模式各自的提示语。「完整」= 聊天那一串 **+ 每一轮的过程组**，所以三句话
   * 必须跟着模式一起改——收在一处是防两处走样（渲染处和点击处各写一遍的旧写法，
   * 加第三种模式时漏一处，用户看到的就是「点了完整、说明还写着聊天」）。
   */
  function modeHint() {
    if (state.mode === 'chat') return '聊天：常规问答对话';
    if (state.mode === 'full') return '完整：附加每一步过程';
    return '单帧：只留最新一条回复';
  }

  /**
   * 「完整」的底座：聊天那一串**全部照画**（分批、往上滑补页、滚动对齐都照旧），
   * 每一轮的过程组**穿插进它那轮对话的原位**——指令之后、回答之前（10.3-1，
   * 对齐 DSH 聊天视图的 turn-process 位置，2026-10-03 用户裁决「一定要让执行
   * 轨迹的逻辑符合DSH本身」）。三层折叠那套跟着组走，落点规则见 trajInterleave。
   * 但**「正在读取」和「没有过程」必须分清**：loading=true 是服务端还在读会话记录，
   * 不是这个会话没有过程。这期间什么都不说，人就会以为没有过程——所以那句注记
   * 照旧垫在最前面。没轨迹且不在 loading 时一个过程组都不画（这时完整模式和聊天
   * 长得一样，是预期）。
   */
  function renderFull() {
    // 换了会话，用户手动拨过的折叠开关就作废——和聊天窗 chatWindowFor 同一个道理：
    // 两场会话的轮号会撞在一起，留在手里的开关会去拨新会话的组。
    if (trajFor !== state.boundSessionId) {
      trajFor = state.boundSessionId;
      trajGroupOpen = {};
      trajEntryOpen = {};
    }
    mainEl.classList.remove('center');
    // 重绘会把展开组的组内滚动容器整个换掉（scrollTop 归零，看着像「每次更新都跳回最上」）。
    // 先记下每个组的位置，画完再还原（2026-11-03）。
    var innerScroll = captureTrajScroll();
    var built = buildChat();
    var html;
    if (built.empty) {
      // 一条消息都没有（正在读/确实没有）：手里有过程组就兜底页尾（10.3-1 d）。
      // 这一路不滚动，和 renderChat 的空态同口径。
      html = built.empty + trajInterleave([], [], built.all).join('');
    } else {
      // 先问「在不在底部」，再改内容——顺序反了永远是「在」（见 atBottom 的注释）。
      var stick = atBottom();
      html = chatFrame(built, trajInterleave(built.rows, built.list, built.all).join(''),
        (state.live || '').trim() ? liveBlock(state.live) : '');
      replyEl.innerHTML = state.trajectoryLoading
        ? '<div class="history-note">正在读取这个会话的过程…</div>' + html
        : html;
      scrollChat(stick);
      restoreTrajScroll(innerScroll);
      bindTraj();
      initTrajFade();
      return;
    }
    if (state.trajectoryLoading) {
      html = '<div class="history-note">正在读取这个会话的过程…</div>' + html;
    }
    replyEl.innerHTML = html;
    restoreTrajScroll(innerScroll);
    bindTraj();
    initTrajFade();
  }

  /** 轨迹区的点击走一次容器委托就够（重绘都是全新 HTML，逐个绑必漏）。 */
  function bindTraj() {
    if (trajBound) return;
    trajBound = true;
    replyEl.addEventListener('click', onTrajectoryClick);
  }

  /** 组内滚动位置的记与还：重画后 scrollTop 归零，不还就会「每次更新都跳回最上」。 */
  function captureTrajScroll() {
    var map = {};
    if (!replyEl.querySelectorAll) return map;
    var list = replyEl.querySelectorAll('.traj-entries[data-traj-scroll]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var key = el.getAttribute('data-traj-scroll');
      if (key === null || key === '') continue;
      map[key] = {
        top: el.scrollTop,
        atBottom: el.scrollHeight - el.scrollTop - (el.clientHeight || 0) < 4,
      };
    }
    return map;
  }

  function restoreTrajScroll(map) {
    if (!replyEl.querySelectorAll || !map) return;
    var list = replyEl.querySelectorAll('.traj-entries[data-traj-scroll]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var saved = map[el.getAttribute('data-traj-scroll')];
      if (!saved) continue;
      el.scrollTop = saved.atBottom ? el.scrollHeight : saved.top;
    }
  }

  /**
   * 过程组的限高窗口：量一下能不能滚，能滚才开渐隐；滚到顶/底时对应那一端关掉。
   * 重绘会换掉整块 HTML，所以每次 renderFull 之后都重新量一遍。
   */
  function syncTrajFade(el) {
    if (!el || !el.classList) return;
    var can = el.scrollHeight > el.clientHeight + 1;
    el.classList.toggle('can-scroll', can);
    if (!can) {
      el.classList.remove('at-top');
      el.classList.remove('at-bottom');
      return;
    }
    el.classList.toggle('at-top', el.scrollTop <= 1);
    el.classList.toggle('at-bottom', el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
  }

  function initTrajFade() {
    if (!replyEl.querySelectorAll) return;
    var list = replyEl.querySelectorAll('.traj-entries');
    for (var i = 0; i < list.length; i++) {
      (function (el) {
        syncTrajFade(el);
        // scroll 不冒泡，但绑在容器自己身上就够；重绘会换新节点，不担心堆积。
        el.addEventListener('scroll', function () { syncTrajFade(el); }, { passive: true });
      })(list[i]);
    }
  }

  /**
   * 聊天那串的外框：截断说明排内容前面、流式那段接在最后、moreNote 贴顶。
   * 聊天与完整两个模式共用这一段——两处各写一遍的旧写法走样过（见 modeHint 的说明）。
   * liveHtml 由调用方给（完整模式的切片里没有 liveBlock，传空串就是「没有流式」）。
   *
   * 定义在 renderFull 之后是**测试切片的约束**：trajHarness 切的是
   * renderFull → applySnapshot，外框函数得在切片里才调得到；页面里函数提升，
   * 位置不影响 renderChat 调它。
   */
  function chatFrame(built, body, liveHtml) {
    var html = body;
    // 「这不是全部」要说在**内容前面**：用户往上翻到顶时，第一眼看到的就是它，
    // 免得以为这个会话只有这么点内容。读历史有上限（见服务端 HISTORY_MAX_*）。
    if (state.historyTruncated) {
      html = '<div class="history-note">'
        + escapeHtml(state.historyNote || '这个会话很大，只显示了最近一段。')
        + '</div>' + html;
    }
    // 「正在执行」不再追加一个气泡——它是常驻的 #work，排在整串消息下面。
    // 流式那段（live）接在所有行（含穿插的过程组）之后：过程在回答之前，
    // 正在流的半句就是「回答」那个位置（10.3-1）。
    if (liveHtml) html += liveHtml;
    return built.moreNote + html;
  }

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
      rows += '<div class="traj-io-row"><div class="traj-io-label">输入</div>'
        + '<div class="traj-io-body"><pre>' + escapeHtml(trajPretty(e.args)) + '</pre>'
        + trajTruncLine(tr.args, e.args) + '</div></div>';
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

