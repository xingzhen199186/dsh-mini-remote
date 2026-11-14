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
        + '<div class="md">' + renderMasked(latest.text, mdToHtml) + '</div>'
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
    return '<div class="live"><div class="md">' + renderMasked(text, mdToHtml) + '</div></div>';
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
  /**
   * 「引用追问」（2026-11-14）：把这条消息折叠成几行引用，塞进输入框。
   *
   * 为什么不直接把原文全塞进去：一条回答常常几十行，整段塞进输入框会把
   * 你要问的问题挤到看不见的地方——引用只要**留下线索**就够。
   */
  function quoteText(text) {
    var lines = String(text || '').split('\n').map(function (one) { return one.trim(); }).filter(Boolean)
    var head = lines.slice(0, 2).join(' ')
    if (head.length > 80) head = head.slice(0, 80) + '…'
    var more = lines.length > 2 ? '（前两行，共 ' + lines.length + ' 行）' : ''
    return '> ' + head + more + '\n\n'
  }

  function quoteBtn(text) {
    return '<button class="quote-link" type="button" aria-label="引用" title="引用这一条接着问"'
      + ' data-quote="' + escapeHtml(text) + '">引用</button>'
  }

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
      + ' data-copy="' + escapeHtml(m.text) + '">' + ICON_COPY + '</button>'
      + quoteBtn(m.text);
    if (m.role === 'user') {
      // 自己的指令：仍然是气泡，靠右。自己敲的是纯文本，不走 markdown——
      // 不然打几个星号就变样了。
      // 长指令先折起来：露开头几行 + 一个「展开」，不让它把整屏撑满。
      var key = (state.boundSessionId || '') + '|' + (m.timestamp || 0);
      var longText = isLongUserText(m.text);
      var expanded = !!expandedUserMsgs[key];
      var body = '<div class="bubble-text'
        + (longText && !expanded ? ' clamped' : '') + '">' + renderMasked(m.text, linkify) + '</div>';
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
      + '<div class="md">' + renderMasked(m.text, mdToHtml) + '</div>'
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
    // 重画会换掉整块 HTML：人要是正在往上读，位置会被浏览器夹回去（2026-11-14 用户报的跳动）。
    // 记下原来的位置，画完还原；人在底部就照旧贴底。
    var keepTop = stick ? null : mainEl.scrollTop;
    replyEl.innerHTML = chatFrame(built, built.rows.join(''), (state.live || '').trim() ? liveBlock(state.live) : '');
    if (keepTop !== null) restoreScrollTop(keepTop);
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
      // **只有他真在底部时才补这一下**（2026-11-14 用户报的跳动）：
      // 原来是「离底不到一屏也算跟着看」，于是人停在上一轮回答开头读着，
      // 新回答一来就被按到页尾——位移正好一个可视高度，看起来就是"跳了一下"。
      if (!stick && !canPin && atBottom()) mainEl.scrollTop = mainEl.scrollHeight;
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
  /**
   * 重画之后把阅读位置还原（2026-11-14）。
   *
   * 整块 HTML 换掉的那一刻，浏览器会先把 scrollTop 夹回合法范围，再重新布局——
   * 人正在往上读的时候，这一下就是"页面忽然跳了"。还原成原来的像素位置即可；
   * 内容真的变短到放不下时，夹到新的底部（那是没有别的选择）。
   */
  function restoreScrollTop(top) {
    if (typeof top !== 'number') return;
    var max = Math.max(0, mainEl.scrollHeight - (mainEl.clientHeight || 0));
    mainEl.scrollTop = Math.min(top, max);
  }

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
      var keepTop = stick ? null : mainEl.scrollTop;
      replyEl.innerHTML = state.trajectoryLoading
        ? '<div class="history-note">正在读取这个会话的过程…</div>' + html
        : html;
      if (keepTop !== null) restoreScrollTop(keepTop);
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

