  // ---------------- 上传附件 ----------------
  /** 把字节数说成人话。 */
  function humanSize(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function setAttachBusy(busy) {
    var btn = $('btnAttach');
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle('busy', busy);
  }

  /**
   * 把选中的文件传到电脑上。
   *
   * 文件本身直接当请求体发（fetch 支持把 File 当 body），不走 JSON、不做 base64——
   * base64 会把体积撑大三分之一，而这条路可能是手机流量。电脑那边是边收边落盘，
   * 不在内存里攒整份。
   *
   * 传完只拿回一张小票（uploadId）。真正的附件已经在电脑上了，手机上不留副本。
   */
  function uploadFile(file) {
    var name = file.name || '文件';
    // 本地上限和服务端是同一个数（由服务端注入），先拦一道省得白传一场。
    if (MAX_UPLOAD > 0 && file.size > MAX_UPLOAD) {
      toast('「' + name + '」有 ' + humanSize(file.size) + '，超过上限 ' + humanSize(MAX_UPLOAD));
      // 多选时是排队传的（见 filePick 的 change），所以这里也要回一个「承诺」——
      // 否则这一份被拦下会让整条链断掉，后面几张就再也传不出去了。
      return Promise.resolve();
    }
    setAttachBusy(true);
    // 返回这条链：多选时调用方靠它排队（一张传完再传下一张）。
    return api('/mini/api/upload?name=' + encodeURIComponent(name) + '&size=' + file.size,
      { method: 'POST', body: file })
      .then(function (res) {
        // 留着 File 本身只为了「点一下能预览」；发出去时 clearUploads 会一起丢掉。
        state.uploads.push({ uploadId: res.uploadId, name: res.name, bytes: res.bytes, file: file });
        renderAttach();
      })
      .catch(function (err) {
        toast(err.message || '上传失败');
      })
      .then(function () { setAttachBusy(false); });
  }

  /**
   * 附件小条。有东西才出现，没有就整块收起来——不占地方。
   *
   * 统一操作面板里那几行「已选文件」是**同一份数据、同一份 HTML**：都由这里画，
   * 都读 state.uploads。别在面板里另存一个附件数组——那样两处迟早对不上
   * （面板里删了一条，小条还挂着，用户就不知道该信哪个）。
   */
  function renderAttach() {
    var bar = $('attachBar');
    if (!bar) return;
    var list = state.uploads || [];
    var chips = list.map(function (f, i) {
      // 整条可点 = 预览；✕ 仍是独立那颗按钮（点它才是删）。
      return '<span class="chip"><button class="pv" type="button" data-preview="' + i + '">'
        + '<span class="nm">' + escapeHtml(f.name) + '</span>'
        + '<span class="sz">' + humanSize(f.bytes) + '</span></button>'
        + '<button class="x" type="button" data-drop="' + i + '" aria-label="去掉">×</button></span>';
    }).join('');
    bar.hidden = !list.length;
    bar.innerHTML = chips;
    var box = $('opsFiles');
    if (box) { box.hidden = !list.length; box.innerHTML = chips; }
  }

  /**
   * 去掉一条已选文件。小条和面板共用这一处，别写两份。
   *
   * 编号必须从**被点的按钮**上读（`closest('[data-drop]')`），不能读 e.target：
   * ✕ 是按钮里那个图形，手指落上去 e.target 就是图形本身，读它只能拿到 null，
   * 于是静默什么都不做（2026-09-28 实机报过的那个 bug）。
   */
  /** 点已选文件 → 预览（2026-11-05）。图片全屏看，文本进只读抽屉；读不了就说读不了。 */
  function previewUpload(i) {
    var f = (state.uploads || [])[Number(i)];
    if (!f || !f.file) { toast('这个文件在电脑上，手机上不留副本'); return; }
    if (/^image\//.test(f.file.type || '')) { openImgView(URL.createObjectURL(f.file)); return; }
    // 文本预览是整份读进内存的：太大就别读，免得手机卡住。
    if (f.file.size > 2 * 1024 * 1024) { toast('文件太大，手机上不预览'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var body = $('fileBody'), title = $('fileTitle'), panel = $('fileView');
      if (!body || !panel) return;
      if (title) title.textContent = f.name || '文件';
      body.innerHTML = '<pre class="file-pre">' + escapeHtml(String(reader.result || '')) + '</pre>';
      panel.classList.add('open');
    };
    reader.onerror = function () { toast('这个文件读不出来'); };
    reader.readAsText(f.file);
  }

  function dropUpload(btn) {
    state.uploads.splice(Number(btn.getAttribute('data-drop')), 1);
    renderAttach();
  }

  function send() {
    var text = inputEl.value.trim();
    var files = state.uploads || [];
    // 跑着的时候**照样能发**。原来这里有个 `|| state.running` 直接 return，
    // 于是手机上「正在跑就发不了」，只能干等；而 DSH 本身在跑着的时候是收的——
    // 那条会排进收件箱，等当前这一轮结束再跑。现在只是把「不许发」改成「排队」。
    //
    // 只带文件、一个字不写也是合法的：「这份文件你看一下」本来就是常见用法。
    // 两样都没有才算空。
    if (!text && !files.length) return;

    // **点过指令、又把名字删掉的那一行，不许当普通提问发出去。**
    //
    // 从面板/菜单点了一条「要参数」的指令之后，输入框里躺着 `/名字 参数`。用户要是把
    // 名字删了、只留参数，这一行就不再以 / 开头，原来会被当成一次普通提问发给模型——
    // 白花一次额度，而且他还以为自己跑的是那条指令。
    //
    // 拦在**清空输入框之前**：那一行字要留着，补回名字就能接着发。出路有两条，
    // 都在提示里说清楚了：补回开头的指令名，或者清空输入框（清空 = 明确取消这条指令，
    // 由 paintCmdMenu 在每次输入时把那枚标记撤掉）。
    if (text.charAt(0) !== '/' && state.pendingCommand) {
      toast('这是 /' + state.pendingCommand + ' 的参数，指令名被删掉了。'
        + '把 /' + state.pendingCommand + ' 补回开头，或者清空输入框改问别的。');
      return;
    }
    unlockAudio();
    // **发指令这个动作，无条件拉回底部。**
    //
    // 用户 2026-09-22 实机提的：「用户发送指令时，如果在手机端页面比较上面的位置，
    // 应该马上下滚回底部。」
    //
    // 这跟 atBottom 那条规则不冲突，两者管的不是一件事：那条管的是**页面自己在动**
    // （鲸鱼娘在跳、流式在写），别把正在翻历史的用户拽回来；这条管的是**用户自己按了发送**，
    // 那是主动动作，他想看自己刚发出去的那条、以及后面的回答，所以不管当时翻到哪儿都回底部。
    //
    // 这里先立即回到底。setRunning 随后展开「正在执行」还会增加页面高度，
    // 所以本地回显新气泡时由 scrollSentMessage 再贴底一次，不能只靠这一句。
    mainEl.scrollTop = mainEl.scrollHeight;
    inputEl.value = '';
    autoGrow();
    // 输入框空了，菜单得当场收起来：清空是程序改的 value，不会触发 input 事件，
    // 没人替我们重算，菜单就会挂在那儿配着一个空输入框。
    hideCmdMenu();
    inputEl.placeholder = INPUT_HINT;

    // **以 / 打头的走指令那条路，不再当普通消息发。**
    //
    // 这是用户拍板的：手机上打了一条不存在的指令，要跟电脑端一样被明确拒绝并说明原因，
    // 不能悄悄当成一次提问发给模型——那既让两边行为不一致，又等于把一次敲错变成一次
    // 真花掉额度的提问。
    //
    // 存不存在由服务端判（这边的指令表可能是缓存的旧值），所以这里不看列表，
    // 只认「trim 之后第一个字符是不是 /」。
    if (text.charAt(0) === '/') {
      // 附件跟不过去：指令接口收的只有那一行（见 runCommand 的说明）。
      // 这里**不动 state.uploads**——清掉就等于把用户刚传上来的文件悄悄扔了，
      // 而他还以为跟着发出去了。留在小条上看得见，想发就配一句话再发一次。
      if (files.length) toast('指令带不了附件，附件还留在下面');
      // 跑出去了，那枚「曾是指令」的标记就该撤掉：留着会拦住下一条普通提问。
      state.pendingCommand = null;
      runCommand(text);
      return;
    }

    var uploadIds = files.map(function (f) { return f.uploadId; });
    // 手机上先把附件收起来：小票已经交出去了，留着会让用户以为还能再发一次。
    state.uploads = [];
    renderAttach();
    // 聊天模式要在本地回显一条。附件也得看得见——不然发完一条只有文件、没写文字的
    // 指令，气泡是空的，用户会以为没发出去。
    var shown = files.length
      ? text + (text ? '\n' : '') + '📎 ' + files.map(function (f) { return f.name; }).join('、')
      : text;

    if (state.mode === 'minimal') {
      // 上一条回答**留着**，由 renderMinimal 在它下面加一条「正在执行」。
      // 原来这里把 latest 清成 null，加上渲染顺序，结果是发完指令旧结果整块消失。
      // 旧的顾虑（怕用户把上一轮的结果当成这次任务的回复）现在由那条分隔线解决：
      // 它明确标出「下面是正在跑的，上面是上一步的」。
      render();
    }
    setRunning(true);

    // 记下这一句：服务端有几秒会把它同时算进收件箱，队列那一下的误报靠它挡（见 paintQueue）。
    api('/mini/api/send', { method: 'POST', body: JSON.stringify({ text: text, uploadIds: uploadIds }) })
      .then(function (res) {
        // 服务端说这条排队了 / 插话了（发的时候正在跑），给一句话。
        // 队列那块也会跟着推过来，但那要等一个来回；先给个即时反馈，
        // 免得用户以为又石沉大海了。
        //
        // **两条要说不同的话**（2026-10-06）：插话是「下一个步骤边界就取走」，
        // 通常几秒；排队是「等这一轮跑完」，可能好几分钟。都回一句「已排队」
        // 就等于把插话也说成了排队——用户就是这么发现「插话好像没实现」的。
        if (res && res.steered) {
          toast('已插话，它下一步就看到');
          return;
        }
        if (res && res.queued) {
          toast('已排队，跑完这轮就轮到它');
          // **排队不算发出去，所以这里不回显气泡。** 用户 2026-09-22 实机提的：
          // 排队的指令立刻长成一条指令气泡，看着就像已经发出去了，其实还在队列里。
          // 它已经在下面的排队列表里露过面了，那就是它此刻该待的地方；
          // 轮到它真跑起来时，服务端会把它记进 history，气泡那时才出现。
          // 插话走的是同一条账（等它真被取走时才长气泡），所以这里一起 return。
          return;
        }
        // 真发出去了才回显。放在这里而不是发之前，是因为**发之前还不知道会不会排队**；
        // 顺带也解决了发送失败时屏幕上留一条假气泡的问题。
        if (state.mode !== 'minimal') {
          state.history = (state.history || []).concat([
            { role: 'user', text: shown, timestamp: Date.now(),
              // 完整模式把轨迹块插回对话原位要用：从轨迹中取当前轮号。
              // 手机本地回显时轮还没开，先留空；服务端快照补上来时会带上真轮号。
              turn: currentTrajectoryTurn() }
          ]);
          state.scrollSentMessage = true;
          state.scrollSentSession = state.boundSessionId;
          render();
          // 「已 N 秒 / 停止」那一行是在 render 之后才排好版的，补一帧贴底。
          if (typeof stickBottomSoon === 'function') stickBottomSoon();
        }
      })
      .catch(function (err) {
        setRunning(false);
        if (state.mode === 'minimal') render();
        toast(err.message || '发送失败');
        inputEl.value = text;
        autoGrow();
        // 附件也还回来。不然网络抖一下，用户刚传上去的文件就白传了，得重新选一次——
        // 而重新选一次意味着重新传一遍。
        state.uploads = files;
        renderAttach();
      });
  }

  // ---------------- 统一操作面板（输入框旁边那一个入口） ----------------
  //
  // 形态是用户 2026-10-02 定的：输入框旁边**一个**入口，点开是一张底部抽屉，
  // 上面「添加文件」、下面「调用指令」。原来这两件事各有各的门——回形针直接开文件
  // 选择器、打 `/` 才弹指令菜单——手机上没人知道打一个斜杠还能调指令。
  //
  // 四条复用纪律（都不许另起一套）：
  //   · 外壳 = 设置抽屉那一套（#settings.open + .sheet），不新建样式体系；
  //   · 指令数据 = state.commands 那份按会话缓存，与打 / 弹出来的菜单**同一份**，
  //     判据也共用 needCommands()，不写「面板专用」的第二套；
  //   · 指令行 = 现成的 pickCommand(name, true)，一次点击**不执行**；
  //   · 附件 = state.uploads + renderAttach()，面板里那几行就是小条那几行。
  //
  // 「指令带附件一起发」这一轮**不做**（手机的上传小票 DSH 的指令接口不认，见 onCommand
  // 那段说明）——所以对声明了要附件的指令，面板上如实标一句「手机暂时带不了附件」，
  // 不假装支持。
  var ops = $('ops');
  // 面板是不是开着。指令表换一份时要按它决定要不要重画列表（见 paintCommandViews）。
  var opsOpen = false;

  function openOps() {
    opsOpen = true;
    // 先把键盘收起来：这张抽屉贴着底边，键盘不收，它就被顶到看不见的地方。
    if (inputEl.blur) inputEl.blur();
    ops.classList.add('open');
    // 与打 / 时同一个判据：换了会话要重取，上次没取到过就再试一次。
    if (needCommands() || state.commandsError) loadCommands();
    paintOps();
  }

  function closeOps() {
    opsOpen = false;
    ops.classList.remove('open');
  }

  // ---------- 正文里点开的文件（2026-11-03） ----------
  // 只读抽屉：点正文里的路径 → 取 /mini/file → 原文或图片。文本塞进 <pre> 的
  // textContent，不拼 HTML——文件内容是数据，不是模板。
  var fileViewText = '';

  function closeFileView() {
    $('fileView').classList.remove('open');
    fileViewText = '';
  }

  function openFileView(path) {
    var panel = $('fileView');
    var body = $('fileBody');
    var title = $('fileTitle');
    fileViewText = '';
    title.textContent = String(path).split(/[\\/]/).pop() || '文件';
    body.innerHTML = '<div class="file-note">正在读取…</div>';
    panel.classList.add('open');
    fetch('/mini/file?p=' + encodeURIComponent(path), { credentials: 'same-origin' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (res) {
        if (!res.ok || !res.j || res.j.ok !== true) {
          body.innerHTML = '<div class="file-note">'
            + escapeHtml((res.j && res.j.error) || '读不到这个文件') + '</div>';
          return;
        }
        title.textContent = res.j.name || title.textContent;
        if (/\.(png|jpe?g|webp|gif|svg)$/i.test(res.j.name || path)) {
          body.innerHTML = '<img class="file-img" src="' + imageSrc(String(path)) + '" alt="">';
          return;
        }
        fileViewText = String(res.j.text || '');
        body.innerHTML = fileRenderHtml(res.j.name || path, fileViewText);
      })
      .catch(function () {
        body.innerHTML = '<div class="file-note">连不上电脑，稍后再试。</div>';
      });
  }

  // ---------- 轨迹面板（2026-11-03） ----------
  // 过程组窗口右下角「最大化」点开的就是它：整场会话的事件清单，点一条跳回聊天那一处。
  // 数据复用「完整」模式已经拉下来的 state.trajectory，不新开通道。
  var trajPanelEl = $('trajPanel');
  // 工具栏两颗开关：轮次 = 全部展开/收起；调用 = 工具行后面补输出预览。
  var trajTurnsOpen = true;
  var trajCallsCollapsed = false;
  // 列表一次最多渲染多少行；「加载更早」每次加 400（2026-11-04）。
  var trajPageLimit = 400;
  // 详情抽屉记住上次的高度档位（half / most / full）。
  var trajSnap = 'most';
  // 某一轮单独反着来（点了组头），键是轮号。
  var trajTurnFlip = {};
  // 面板里「思考」折叠块展开过哪几条（键是助手条目的 key）。
  var trajThinkOpen = {};
  // 时长模式：列的宽度按耗时走（2026-11-03）。
  var trajDurationMode = false;
  // 全量读取的在途会话、数据对应的轨迹序号，以及失败说明。
  var trajFullLoadingFor = null;
  var trajFullSeq = null;
  var trajFullNote = '';

  /** 相邻事件的时间差（毫秒）；没有就 null。 */
  function trajDuration(es, j) {
    var a = es[j] && es[j].timestamp;
    var b = es[j + 1] && es[j + 1].timestamp;
    if (typeof a !== 'number' || typeof b !== 'number' || b < a) return null;
    return b - a;
  }

  /** 一条的耗时：工具用「调用→结果」的真实间隔，其余退回相邻事件间隔。 */
  function trajEntryDuration(e, es, j) {
    if (typeof e.endedAt === 'number' && typeof e.timestamp === 'number') return e.endedAt - e.timestamp;
    return trajDuration(es, j);
  }

  /** 本地时间 HH:MM:SS（详情里的「开始」）。 */
  function trajClock(ms) {
    var d = new Date(ms);
    var p2 = function (n) { return n < 10 ? '0' + n : String(n); };
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }

  function fmtTrajDuration(ms) {
    if (ms == null) return '';
    if (ms < 1000) return Math.round(ms) + ' 毫秒';
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' 秒';
    return Math.floor(ms / 60000) + ' 分 ' + Math.round((ms % 60000) / 1000) + ' 秒';
  }

  function closeTrajPanel() {
    state.trajAlt = null;
    closeTrajDetail();
    if (trajPanelEl) trajPanelEl.classList.remove('open');
  }

  /** 面板的数据源：点开过最大化、读回了整份轨迹就用它，否则退回当前那一段。 */
  function trajGroups() {
    return state.trajAlt || state.trajFull || state.trajectory || [];
  }

  function trajEntryById(id) {
    var groups = trajGroups();
    for (var i = 0; i < groups.length; i++) {
      var es = groups[i].entries || [];
      for (var j = 0; j < es.length; j++) {
        if (String(es[j].id) === String(id)) return es[j];
      }
    }
    return null;
  }

  /** 条目连同它所在的数组和下标：算「到下一条的间隔」要用。 */
  function trajSpanOf(id) {
    var groups = trajGroups();
    for (var i = 0; i < groups.length; i++) {
      var es = groups[i].entries || [];
      for (var j = 0; j < es.length; j++) {
        if (String(es[j].id) === String(id)) return { e: es[j], es: es, j: j };
      }
    }
    return null;
  }

  function openTrajDetail(id) {
    var box = $('trajDetails');
    var e = trajEntryById(id);
    if (!box || !e) return;
    var title = trajKindLabel(e) + (isAssistantKind(e)
      ? (e.kind === 'think' ? ' · 思考' : '')
      : e.name ? ' · ' + trajToolTitle(e.name) : '');
    var titleEl = $('tdTitle');
    var bodyEl = $('tdBody');
    if (titleEl) titleEl.textContent = title;
    if (bodyEl) {
      var textOnly = e.kind === 'user' || e.kind === 'context' || e.kind === 'system';
      // 耗时和列表同口径：工具用真实结束时间，其余退回「到下一条的间隔」。
      var spot = trajSpanOf(id);
      var span = spot ? trajEntryDuration(spot.e, spot.es, spot.j) : null;
      var meta = '<div class="td-meta">'
        + (e.timestamp ? '开始 ' + trajClock(e.timestamp) : '开始 —')
        + (span != null ? ' · 耗时 ' + fmtTrajDuration(span) : '')
        + (e.tokens ? ' · ' + e.tokens + ' tok' : '')
        + (e.ttft != null ? ' · 首字 ' + fmtTrajDuration(e.ttft) : '')
        + (e.genMs > 0 && e.tokens ? ' · ' + Math.round(e.tokens / (e.genMs / 1000)) + ' tok/s' : '')
        + '</div>';
      bodyEl.innerHTML = meta + (textOnly
        ? (e.kind === 'user' && e.output ? mdToHtml(e.output) : escapeHtml(e.summary || ''))
        : trajEntryBody(e))
        + '<button class="traj-jump" type="button" data-tj-jump="1" data-tj-turn="'
        + escapeHtml(String(e.turn)) + '" data-tj-id="' + escapeHtml(String(e.id))
        + '">跳到对话</button>';
    }
    box.setAttribute('data-snap', trajSnap);
    box.hidden = false;
  }

  function closeTrajDetail() {
    var box = $('trajDetails');
    if (box) box.hidden = true;
  }

  /** 完整轨迹页的数据：打开时若轨迹序号变了，就重读整份日志。 */
  function ensureFullTrajectory() {
    var sid = state.boundSessionId
    if (!sid || typeof api !== 'function') return
    var seq = typeof state.trajectorySeq === 'number' ? state.trajectorySeq : 0
    if (state.trajFullFor === sid && trajFullSeq === seq) return
    if (trajFullLoadingFor === sid) return
    trajFullLoadingFor = sid
    trajFullNote = ''
    api('/mini/api/trajectory?full=1&sessionId=' + encodeURIComponent(sid))
      .catch(function () { return { ok: false, note: '读不到这个会话的完整过程。' } })
      .then(function (r) {
        if (trajFullLoadingFor === sid) trajFullLoadingFor = null
        if (state.boundSessionId !== sid) return
        var note = r && typeof r.note === 'string' ? r.note : ''
        if (!r || r.ok !== true || !Array.isArray(r.turns) || !r.turns.length || note) {
          // 空结果与带 note 的回包都不能盖住最近一段，也不能锁住下次重试。
          state.trajFull = null
          state.trajFullFor = null
          trajFullSeq = null
          trajFullNote = note || '读不到这个会话的完整过程。'
        } else {
          state.trajFull = r.turns
          state.trajFullFor = sid
          trajFullSeq = typeof r.seq === 'number' ? r.seq : seq
          trajFullNote = ''
          // 全量轨迹可能上千条：默认先收起轮次，只留一行行小标题，避免一开就卡。
          var total = 0
          for (var i = 0; i < r.turns.length; i += 1) total += (r.turns[i].entries || []).length
          if (total > 200) trajTurnsOpen = false
        }
        if (trajPanelEl && trajPanelEl.classList.contains('open')) {
          repaintTrajList()
          paintTrajStrip()
        }
      })
  }

  function openTrajPanel(altGroups) {
    if (!trajPanelEl) return;
    // 传了别人的轨迹就用它（子智能体）；没传就是当前会话自己那份。
    state.trajAlt = Array.isArray(altGroups) ? altGroups : null;
    trajPanelEl.classList.add('open');
    var filter = $('trajFilter');
    if (filter) filter.value = '';
    paintTrajList('', true);
    paintTrajStrip();
    if (!state.trajAlt) ensureFullTrajectory();
    // 完整模式下轨迹是按需拉的；第一次打开还没到就先要一份，到了再补画。
    if (!(state.trajectory || []).length && state.mode === 'full' && typeof requestTrajectory === 'function') {
      requestTrajectory();
      setTimeout(function () {
        if (trajPanelEl && trajPanelEl.classList.contains('open')) {
          paintTrajList(filter ? filter.value : '', true);
          paintTrajStrip();
        }
      }, 600);
    }
  }

  /** 重画清单但位置不动：点开关/展开条目时不该跳。 */
  function repaintTrajList() {
    var box = $('trajList');
    if (!box) return;
    var keep = box.scrollTop;
    paintTrajList($('trajFilter').value, false);
    box.scrollTop = keep;
  }

  /**
   * 列表里的行怎么排（照本体，2026-11-04 修正）：
   *   · 同一 step 的 思考 + 旁白 合成一条「助手」；
   *   · **工具各占一行**——本体上它们也是独立行，不是塞进助手里面；
   *   · 工具同时登记到前面那条助手的 calls 里，只用于详情里的「工具调用」清单。
   */
  function buildTrajItems(es) {
    var items = [];
    var cur = null;
    for (var i = 0; i < es.length; i += 1) {
      var e = es[i];
      if (e.kind === 'user' || e.kind === 'context' || e.kind === 'system') {
        cur = null;
        items.push({ type: 'entry', e: e, index: i });
        continue;
      }
      if (e.kind !== 'think' && e.kind !== 'say') {
        // 工具行独立成行；挂到同一 step 的助手下面，只当详情里的清单用。
        if (cur && cur.stepKey === String(e.step == null ? '' : e.step)) cur.calls.push(e);
        items.push({ type: 'entry', e: e, index: i });
        continue;
      }
      var stepKey = String(e.step == null ? '' : e.step);
      if (!cur || cur.stepKey !== stepKey) {
        cur = {
          type: 'assistant',
          key: String(e.turn) + ':' + String(e.id),
          stepKey: stepKey,
          think: [], says: [], calls: [],
          index: i, first: e, last: e,
        };
        items.push(cur);
      }
      cur.last = e;
      if (e.kind === 'think') cur.think.push(e);
      else cur.says.push(e);
    }
    return items;
  }

  /** 助手行那一行摘要：正文首行 → 思考首行 → 调用摘要 → 兜底词。 */
  function trajAssistantSummary(item) {
    var text = '';
    if (item.says.length) text = item.says[0].summary || trajFirstLine(item.says[0].output);
    if (!text && item.think.length) text = item.think[0].summary || trajFirstLine(item.think[0].output);
    var callText = '';
    // 「调用」这颗开关：收起的只是「N 个工具调用 · 名字」这截摘要，正文不动。
    if (item.calls.length && trajCallsCollapsed) {
      var names = [];
      for (var i = 0; i < item.calls.length; i += 1) {
        var n = trajToolTitle(item.calls[i].name || '');
        if (n && names.indexOf(n) < 0) names.push(n);
      }
      callText = item.calls.length + ' 个工具调用' + (names.length ? ' · ' + names.join('、') : '');
    }
    if (text && callText) return text + ' · ' + callText;
    return text || callText || '（仅工具调用）';
  }

  /** 助手条目里最早开始、最晚结束的耗时（用来给整行一个数）。 */
  function trajItemDuration(item) {
    if (!(typeof item.first.timestamp === 'number')) return null;
    if (typeof item.last.endedAt === 'number' && item.last.endedAt >= item.first.timestamp) {
      return item.last.endedAt - item.first.timestamp;
    }
    if (typeof item.last.timestamp === 'number' && item.last.timestamp >= item.first.timestamp) {
      return item.last.timestamp - item.first.timestamp;
    }
    return null;
  }

  /** 按 key 找回那条助手（面板里存的是 key，不是条目 id）。 */
  function findTrajAssistant(key) {
    var groups = trajGroups();
    for (var i = 0; i < groups.length; i += 1) {
      var items = buildTrajItems(groups[i].entries || []);
      for (var j = 0; j < items.length; j += 1) {
        if (items[j].type === 'assistant' && items[j].key === key) return items[j];
      }
    }
    return null;
  }

  /** 助手详情：思考折叠块 → 正文 → 这一条发起的工具调用列表（照本体的顺序）。 */
  function trajAssistantBody(item) {
    var html = '';
    var thinkText = '';
    for (var i = 0; i < item.think.length; i += 1) {
      if (item.think[i].output) thinkText += (thinkText ? '\n\n' : '') + item.think[i].output;
    }
    if (thinkText) {
      var open = trajThinkOpen[item.key] === true;
      html += '<div class="traj-think-block"><button class="traj-think-toggle" type="button"'
        + ' data-tj-think="' + escapeHtml(item.key) + '" aria-expanded="' + (open ? 'true' : 'false') + '">'
        + '思考 ' + (open ? '▾' : '▸') + '</button>'
        + (open ? '<div class="traj-think-body">' + mdToHtml(thinkText) + '</div>' : '') + '</div>';
    }
    for (var s = 0; s < item.says.length; s += 1) {
      if (item.says[s].output) html += '<div class="traj-say">' + mdToHtml(item.says[s].output) + '</div>';
    }
    if (item.calls.length) {
      html += '<div class="traj-calls"><div class="traj-calls-title">工具调用 · ' + item.calls.length + '</div>';
      for (var c = 0; c < item.calls.length; c += 1) {
        var call = item.calls[c];
        html += '<button class="traj-call" type="button" data-tj-id="' + escapeHtml(String(call.id)) + '">'
          + '<span class="traj-call-name">' + escapeHtml(trajToolTitle(call.name || '')) + '</span>'
          + '<span class="traj-call-args">' + escapeHtml(call.summary || '') + '</span></button>';
      }
      html += '</div>';
    }
    return html || '<div class="file-note">这条助手消息没有可展开的内容。</div>';
  }

  /** 这条助手里第一个带用量/模型的条目（用量只挂在消息的第一条上）。 */
  function trajItemUsage(item) {
    var all = item.think.concat(item.says, item.calls);
    for (var i = 0; i < all.length; i += 1) {
      if (all[i].usage || all[i].model) return all[i];
    }
    return null;
  }

  function fmtTokens(n) {
    if (typeof n !== 'number') return '';
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  /** 附件只列清单（名字、类型、大小）；打开原件要服务端另做接口。 */
  function trajAttachHtml(item) {
    var all = item.think.concat(item.says, item.calls);
    var list = [];
    for (var i = 0; i < all.length; i += 1) {
      if (Array.isArray(all[i].attachments)) list = list.concat(all[i].attachments);
    }
    if (!list.length) return '';
    var html = '<div class=traj-attach><div class=traj-attach-title>附件 · ' + list.length + '</div>';
    for (var j = 0; j < list.length; j += 1) {
      var it = list[j] || {};
      var size = typeof it.bytes === 'number' ? Math.max(1, Math.round(it.bytes / 1024)) + ' KB' : '';
      html += '<div class=traj-attach-row>'
        + '<span class=traj-attach-kind>' + (it.kind === 'image' ? '图片' : '文件') + '</span>'
        + '<span class=traj-attach-name>' + escapeHtml(it.name || '未命名') + '</span>'
        + '<span class=traj-attach-meta>' + escapeHtml(size) + '</span></div>';
    }
    return html + '</div>';
  }

  function openTrajAssistant(key) {
    var box = $('trajDetails');
    var item = findTrajAssistant(key);
    if (!box || !item) return;
    var titleEl = $('tdTitle');
    var bodyEl = $('tdBody');
    if (titleEl) {
      titleEl.textContent = '助手' + (item.calls.length ? ' · ' + item.calls.length + ' 个工具调用' : '');
    }
    if (bodyEl) {
      var metaLine = '<div class="td-meta">开始 '
        + (typeof item.first.timestamp === 'number' ? trajClock(item.first.timestamp) : '—')
        + ' · 耗时 ' + (fmtTrajDuration(trajItemDuration(item)) || '—') + '</div>';
      var usageEntry = trajItemUsage(item);
      var usageLine = '';
      if (usageEntry) {
        var u = usageEntry.usage || {};
        var bits = [];
        if (usageEntry.model) bits.push(usageEntry.model);
        if (typeof u.input === 'number') bits.push('输入 ' + fmtTokens(u.input));
        if (typeof u.output === 'number') bits.push('输出 ' + fmtTokens(u.output));
        if (typeof u.cacheRead === 'number' && u.cacheRead > 0) bits.push('缓存读 ' + fmtTokens(u.cacheRead));
        if (typeof u.cacheWrite === 'number' && u.cacheWrite > 0) bits.push('缓存写 ' + fmtTokens(u.cacheWrite));
        if (typeof u.reasoning === 'number' && u.reasoning > 0) bits.push('推理 ' + fmtTokens(u.reasoning));
        if (bits.length) usageLine = '<div class="td-meta">' + escapeHtml(bits.join(' · ')) + '</div>';
      }
      bodyEl.innerHTML = metaLine + usageLine
        + trajAssistantBody(item)
        + trajAttachHtml(item)
        + '<button class="traj-jump" type="button" data-tj-jump="1" data-tj-turn="'
        + escapeHtml(String(item.first.turn)) + '" data-tj-id="' + escapeHtml(String(item.first.id))
        + '">跳到对话</button>';
    }
    box.setAttribute('data-snap', trajSnap);
    box.hidden = false;
  }

  function paintTrajList(q, toBottom) {
    var list = $('trajList');
    if (!list) return;
    var groups = trajGroups();
    var kw = String(q || '').trim().toLowerCase();
    var noteHtml = trajFullNote
      ? '<div class="file-note">' + escapeHtml(trajFullNote) + '</div>' : '';
    if (!groups.length) {
      list.innerHTML = noteHtml || '<div class="file-note">这个会话还没有过程记录。</div>';
      return;
    }
    var out = [];
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var rows = [];
      var es = g.entries || [];
      // 这一轮是展开还是收起：全局开关，加上「单独点过组头」的例外。
      var flipped = trajTurnFlip[String(g.turn)];
      var turnOpen = flipped === undefined ? trajTurnsOpen : flipped;
      var items = buildTrajItems(es);
      for (var k = 0; k < items.length; k += 1) {
        var item = items[k];
        if (item.type === 'assistant') {
          var asum = trajAssistantSummary(item);
          if (kw && asum.toLowerCase().indexOf(kw) < 0) continue;
          rows.push('<button class="traj-item" type="button" data-tj-a="' + escapeHtml(item.key)
            + '" data-tj-turn="' + escapeHtml(String(g.turn)) + '">'
            + '<span class="t-kind k-assistant">助手</span>'
            + '<span class="t-body"><span class="t-sum">' + escapeHtml(asum) + '</span></span>'
            + '<span class="t-dur">' + fmtTrajDuration(trajItemDuration(item)) + '</span>'
            + '<span class="t-chev">›</span></button>');
          continue;
        }
        var e = item.e;
        if (trajCallsCollapsed && e.kind === 'tool') continue;
        var textOnly = e.kind === 'user' || e.kind === 'context' || e.kind === 'system';
        var name = trajToolTitle(e.name || '');
        var sum = e.summary || trajFirstLine(e.output);
        if (kw && (name + ' ' + sum + ' ' + (e.name || '')).toLowerCase().indexOf(kw) < 0) continue;
        rows.push('<button class="traj-item" type="button" data-tj-turn="' + escapeHtml(String(g.turn))
          + '" data-tj-id="' + escapeHtml(String(e.id)) + '">'
          + '<span class="t-kind ' + trajKindClass(e) + '">' + trajKindLabel(e) + '</span>'
          + '<span class="t-body">' + (name && !textOnly ? '<b class="t-name">' + escapeHtml(name) + '</b>' : '')
          + (sum ? '<span class="t-sum">' + escapeHtml(sum) + '</span>' : '') + '</span>'
          + '<span class="t-dur">' + fmtTrajDuration(trajEntryDuration(e, es, item.index)) + '</span>'
          + '<span class="t-chev">›</span></button>');
      }
      var head = '<button class="traj-item tj-head" type="button" data-tj-turnhead="'
        + escapeHtml(String(g.turn)) + '">' + (turnOpen ? '⌄' : '›') + ' 第 '
        + escapeHtml(String(g.turn)) + ' 轮 · ' + items.length + ' 条</button>';
      // 搜索时没有实际命中行，整轮（含轮次标题与收起摘要）都不出现。
      if (kw && !rows.length) continue;
      out.push(head);
      if (turnOpen) out.push.apply(out, rows);
    }
    // 分页：手机上一次塞几千行会卡（2026-11-04）。搜索不截断，结果本来就少。
    var flat = out;
    var more = '';
    if (!kw && flat.length > trajPageLimit) {
      flat = flat.slice(flat.length - trajPageLimit);
      more = '<button class="traj-item tj-head" type="button" data-tj-more="1">加载更早的 '
        + Math.min(400, out.length - trajPageLimit) + ' 条</button>';
    }
    list.innerHTML = noteHtml + more
      + (flat.length ? flat.join('') : '<div class="file-note">没有对得上的记录。</div>');
    // 打开时停在最底（最新）；搜索时回到顶部（结果从头看）。
    list.scrollTop = toBottom ? list.scrollHeight : 0;
  }

  /** 行左边的类型词（照本体的 kind）：用户 / 上下文 / 系统 / 助手 / 工具。 */
  function trajKindLabel(e) {
    if (e.kind === 'user') return '用户'
    if (e.kind === 'context') return '上下文'
    if (e.kind === 'system') return '系统'
    return isAssistantKind(e) ? '助手' : '工具'
  }

  function trajKindClass(e) {
    if (e.kind === 'user') return 'k-user'
    if (e.kind === 'context') return 'k-context'
    if (e.kind === 'system') return 'k-system'
    return isAssistantKind(e) ? 'k-assistant' : 'k-tool'
  }

  /** 刻度条的颜色分类：读/写/命令/搜/代码/子代理/思考，各占一档。 */
  function trajTone(e) {
    var n = String(e.name || '');
    if (e.kind === 'think') return 'think';
    if (n === 'read' || n === 'read_image' || n === 'web_fetch') return 'read';
    if (n === 'write' || n === 'edit' || n === 'apply_patch') return 'write';
    if (n === 'bash' || n === 'pwsh' || n === 'exec_command' || n === 'write_stdin'
      || /^terminal_/.test(n)) return 'cmd';
    if (n === 'web_search' || n === 'grep' || n === 'glob') return 'search';
    if (n === 'run_code') return 'code';
    if (/^subagent/.test(n)) return 'sub';
    return 'other';
  }

  /**
   * 时间线条（2026-11-03）：一次工具调用一根短刻度，轮与轮之间一道细线。
   * 等距排、不按真实耗时——手机上按时间比例会把长任务挤成一根线、短任务叠成一团。
   * 点刻度 = 点列表里那一条。
   */
  /** 一列的宽度：等宽模式固定 9px；时长模式按耗时取对数，封顶 48px。 */
  function trajColWidth(ms) {
    if (!trajDurationMode || typeof ms !== 'number') return 9;
    return Math.max(6, Math.min(48, Math.round(6 + Math.log(1 + ms / 40) * 5)));
  }

  function stripCol(turn, id, ms, lane, tone, cur, label) {
    var cells = ['', '', ''];
    if (tone) cells[lane] = tone;
    return '<button class="ts-col' + cur + '" style="width:' + trajColWidth(ms) + 'px" type="button"'
      + (id ? ' data-tj-turn="' + escapeHtml(String(turn)) + '" data-tj-id="' + escapeHtml(String(id)) + '"' : '')
      + ' aria-label="' + escapeHtml(label) + '">'
      + '<i class="' + cells[0] + '"></i>'
      + '<i class="' + cells[1] + '"></i>'
      + '<i class="' + cells[2] + '"></i></button>';
  }

  /** 三条轨道（输入 / 模型 / 工具）：输入那条画的是「发出去到模型开始动」的等待。 */
  function paintTrajStrip() {
    var box = $('trajStripIn');
    var strip = $('trajStrip');
    if (!box) return;
    var groups = trajGroups();
    var html = [];
    var times = [];
    var offset = 0;
    var lastTick = -999;
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var es = g.entries || [];
      if (!es.length) continue;
      var first = es[0];
      if (typeof first.timestamp === 'number' && offset - lastTick >= 46) {
        times.push({ x: offset, label: trajClock(first.timestamp) });
        lastTick = offset;
      }
      offset += 7;
      var cur = g.state === 'running' ? ' cur' : '';
      html.push('<span class="ts-sep" title="第 ' + escapeHtml(String(g.turn)) + ' 轮"></span>');
      for (var j = 0; j < es.length; j++) {
        var e = es[j];
        // 三条道：用户那句话进「输入」，思考进「模型」，工具进「工具」；其余不占刻度。
        if (e.kind === 'say' || e.kind === 'context' || e.kind === 'system') continue;
        var lane = e.kind === 'user' ? 0 : e.kind === 'think' ? 1 : 2;
        var tone = e.kind === 'user' ? 'tone-input' : 'tone-' + trajTone(e);
        html.push(stripCol(g.turn, e.id, trajEntryDuration(e, es, j), lane, tone, cur,
          e.kind === 'user' ? '用户' : e.kind === 'think' ? '思考' : trajToolTitle(e.name || '')));
        offset += trajColWidth(trajEntryDuration(e, es, j));
      }
    }
    box.innerHTML = html.length ? html.join('') : '';
    var rail = $('trajTimes');
    if (rail) {
      rail.innerHTML = times.map(function (tk) {
        return '<span class="ts-time" style="left:' + Math.round(tk.x) + 'px">' + escapeHtml(tk.label) + '</span>';
      }).join('');
    }
    // 打开时停在最右（最新）；用户自己滑到别处就随他。
    if (strip && html.length) strip.scrollLeft = strip.scrollWidth;
  }

  /** 点一条：关面板 →（必要时）切到完整 → 展开那一轮/那一条 → 滚到屏幕中间。 */
  function jumpToTraj(turn, id) {
    closeTrajPanel();
    if (state.mode !== 'full') {
      var btn = $('segMode') && $('segMode').querySelector
        ? $('segMode').querySelector('[data-mode="full"]') : null;
      if (btn && btn.click) btn.click();
      else { state.mode = 'full'; render(); }
    }
    if (turn !== null && turn !== undefined && turn !== '') trajGroupOpen[turn] = true;
    if (id) trajEntryOpen[id] = false;
    render();
    var el = replyEl.querySelector ? replyEl.querySelector('[data-traj-entry="' + id + '"]') : null;
    if (!el && replyEl.querySelector) el = replyEl.querySelector('[data-traj-group="' + turn + '"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
  }

  /**
   * 画面板里的指令列表。
   *
   * 和打 / 那个菜单同源（state.commands），但这里是「搜」不是「按前缀」：面板上那个框是
   * 一句话搜索框，名字和说明都匹配（桌面端也是名字和标题一起匹配）。顺手带个 `/c` 也算，
   * 那是用户平时打指令的手势。
   *
   * **取不到就说原因**，不显示成「一条都没有」——两件事，用户能做的也不同。
   */
  function paintOps() {
    var listEl = $('opsCmds');
    if (!listEl) return;
    if (state.commandsError) {
      listEl.innerHTML = '<div class="cmd-note">' + escapeHtml(state.commandsError) + '</div>';
      return;
    }
    if (!state.commands) {
      // 取回来之前先占个位——不然打开面板是一片空白，看着像坏了。
      listEl.innerHTML = '<div class="cmd-note">正在读取可用的指令…</div>';
      return;
    }
    var filterEl = $('opsFilter');
    var q = String((filterEl && filterEl.value) || '').trim().toLowerCase();
    if (q.charAt(0) === '/') q = q.slice(1);
    var rows = state.commands.filter(function (c) {
      if (!q) return true;
      return (String(c.name) + ' ' + String(c.description || '')).toLowerCase().indexOf(q) >= 0;
    });
    if (!rows.length) {
      listEl.innerHTML = '<div class="cmd-note">没有对得上的指令。</div>';
      return;
    }
    listEl.innerHTML = rows.map(function (c) {
      return '<button class="cmd-row" type="button" data-cmd="' + escapeHtml(c.name) + '">'
        + '<span class="cmd-top">'
        + '<span class="cmd-name">/' + escapeHtml(c.name) + '</span>'
        + '<span class="cmd-desc">' + escapeHtml(c.description || '') + '</span>'
        + '</span>'
        + (c.attachments ? '<span class="cmd-flag">手机暂时带不了附件</span>' : '')
        + '</button>';
    }).join('');
  }

  // 面板里点一行：**一次点击不执行**（deferRun）。要参数的把 hint 挂成占位提示、把
  // `/名字 ` 填进输入框；不要参数的也只填进去，等「发送」那一下——宁可多问一句，
  // 也不能点错一下就真跑掉。
  $('opsCmds').addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-cmd]') : null;
    if (!btn) return;
    closeOps();
    pickCommand(btn.getAttribute('data-cmd'), true);
  });

  $('opsFilter').addEventListener('input', paintOps);
  $('opsClose').addEventListener('click', closeOps);

  // 文件抽屉：关闭、点遮罩关、复制。复制优先用 clipboard API，没有就退回 execCommand。
  // `typeof document` 那道判断是给测试用的：切片测试环境里没有 document，不能在这里炸。
  if (typeof document !== 'undefined' && document.addEventListener) {
    $('fileClose').addEventListener('click', closeFileView);
    $('fileView').addEventListener('click', function (e) {
      if (e.target === $('fileView')) closeFileView();
    });
    $('fileCopy').addEventListener('click', function () {
      if (!fileViewText) return;
      var fallback = function () {
        var ta = document.createElement('textarea');
        ta.value = fileViewText;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (err) { /* 复制不了就算了，不弹窗打扰 */ }
        document.body.removeChild(ta);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(fileViewText).catch(fallback);
      } else {
        fallback();
      }
    });
    // 正文里的文件链接统一在 document 上接：聊天 / 轨迹 / 回答区各自重绘，逐条绑必漏。
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-file]') : null;
      if (!el) return;
      e.preventDefault();
      openFileView(el.getAttribute('data-file') || '');
    });
  }
  // 点抽屉外面那一层 = 关掉（和设置抽屉同一条规矩）。
  ops.addEventListener('click', function (e) { if (e.target === ops) closeOps(); });

  // 轨迹面板：关闭、搜索、点条目跳转。元素不在就整段跳过（切片测试里可能没有）。
  if (trajPanelEl) {
    $('trajClose').addEventListener('click', closeTrajPanel);
    $('tdClose').addEventListener('click', closeTrajDetail);
    // 抽屉的拖拽条：下滑关闭、上滑全屏、轻点换一档（2026-11-04）。
    var grab = $('tdGrab');
    if (grab) {
      var grabY = null;
      grab.addEventListener('pointerdown', function (e) {
        grabY = e.clientY;
        if (grab.setPointerCapture) grab.setPointerCapture(e.pointerId);
      });
      grab.addEventListener('pointerup', function (e) {
        if (grabY === null) return;
        var dy = e.clientY - grabY;
        grabY = null;
        var box = $('trajDetails');
        if (!box) return;
        if (dy > 60) { closeTrajDetail(); return; }
        var order = ['half', 'most', 'full'];
        var idx = order.indexOf(box.getAttribute('data-snap') || 'most');
        var next = dy < -60 ? 'full' : order[(idx + 1) % order.length];
        box.setAttribute('data-snap', next);
        trajSnap = next;
      });
    }
    $('tdBody').addEventListener('click', function (e) {
      var jump = e.target && e.target.closest ? e.target.closest('[data-tj-jump]') : null;
      if (jump) {
        closeTrajDetail();
        jumpToTraj(jump.getAttribute('data-tj-turn'), jump.getAttribute('data-tj-id'));
        return;
      }
      var think = e.target && e.target.closest ? e.target.closest('[data-tj-think]') : null;
      if (think) {
        var key = think.getAttribute('data-tj-think');
        trajThinkOpen[key] = trajThinkOpen[key] !== true;
        openTrajAssistant(key);
        return;
      }
      var call = e.target && e.target.closest ? e.target.closest('[data-tj-id]') : null;
      if (call) openTrajDetail(call.getAttribute('data-tj-id'));
    });
    trajPanelEl.addEventListener('click', function (e) {
      if (e.target === trajPanelEl) closeTrajPanel();
    });
    $('trajFilter').addEventListener('input', function () { paintTrajList(this.value, false); });
    $('trajList').addEventListener('click', function (e) {
      var more = e.target && e.target.closest ? e.target.closest('[data-tj-more]') : null;
      if (more) {
        trajPageLimit += 400;
        repaintTrajList();
        return;
      }
      var jump = e.target && e.target.closest ? e.target.closest('[data-tj-jump]') : null;
      if (jump) {
        jumpToTraj(jump.getAttribute('data-tj-turn'), jump.getAttribute('data-tj-id'));
        return;
      }
      var head = e.target && e.target.closest ? e.target.closest('[data-tj-turnhead]') : null;
      if (head) {
        var turn = head.getAttribute('data-tj-turnhead');
        var cur = trajTurnFlip[turn] === undefined ? trajTurnsOpen : trajTurnFlip[turn];
        trajTurnFlip[turn] = !cur;
        repaintTrajList();
        return;
      }
      var row = e.target && e.target.closest ? e.target.closest('[data-tj-id]') : null;
      if (!row) {
        var asst = e.target && e.target.closest ? e.target.closest('[data-tj-a]') : null;
        if (asst) openTrajAssistant(asst.getAttribute('data-tj-a'));
        return;
      }
      openTrajDetail(row.getAttribute('data-tj-id'));
    });
    $('trajDur').addEventListener('click', function () {
      trajDurationMode = !trajDurationMode;
      paintTrajStrip();
    });
    $('trajTurns').addEventListener('click', function () {
      trajTurnsOpen = !trajTurnsOpen;
      trajTurnFlip = {};
      repaintTrajList();
    });
    $('trajCalls').addEventListener('click', function () {
      trajCallsCollapsed = !trajCallsCollapsed;
      repaintTrajList();
    });
    $('trajStrip').addEventListener('click', function (e) {
      var mark = e.target && e.target.closest ? e.target.closest('[data-tj-id]') : null;
      if (!mark) return;
      jumpToTraj(mark.getAttribute('data-tj-turn'), mark.getAttribute('data-tj-id'));
    });
  }

  // 「添加文件」两件事：选文件、拍照。都走原来那个藏起来的 #filePick——手机上这两件事
  // 本来就是同一个系统选择器，区别只在「要不要限定图片、要不要调后置摄像头」。
  //
  // **多选只给「选文件」**（2026-10-05 用户要求：图库和文件里只能单选，改成多选）。
  // 拍照那一条不加 multiple：相机一次就出一张，摆个多选没有意义。
  function openFilePicker(camera) {
    var pick = $('filePick');
    if (!pick) return;
    if (camera) {
      pick.setAttribute('accept', 'image/*');
      pick.setAttribute('capture', 'environment');
      pick.removeAttribute('multiple');
    } else {
      pick.removeAttribute('accept');
      pick.removeAttribute('capture');
      pick.setAttribute('multiple', '');
    }
    pick.click();
  }
  $('opsPick').addEventListener('click', function () { openFilePicker(false); });
  $('opsShot').addEventListener('click', function () { openFilePicker(true); });

  // 面板里那行已选文件上的 ✕。走的是和小条同一个 dropUpload()。
  $('opsFiles').addEventListener('click', function (e) {
    var pv = e.target && e.target.closest ? e.target.closest('[data-preview]') : null;
    if (pv) { previewUpload(pv.getAttribute('data-preview')); return; }
    var btn = e.target && e.target.closest ? e.target.closest('[data-drop]') : null;
    if (!btn) return;
    dropUpload(btn);
  });

  // 指令表换了一份（换会话、第一次取到）时，面板开着就跟着重画。
  onCommandsReady = function () { if (opsOpen) paintOps(); };

  $('btnAttach').addEventListener('click', function () { openOps(); });
  $('filePick').addEventListener('change', function (e) {
    // 多选：一次可能挑了好几张，**一个接一个传**（2026-10-05 用户要求多选）。
    // 为什么不用并发：上传的「忙碌」是同一个开关（setAttachBusy 控制那个回形针），
    // 并发传的话最后一个传完就把按钮放开了，其实还有在飞的——用户会以为传完了。
    // 排队传则从头到尾都是忙的，什么时候能再点一目了然。
    var files = Array.prototype.slice.call(e.target.files || []);
    // 清掉 value：不清的话，连着选同一个文件第二次不会触发 change，
    // 用户会觉得「点了没反应」。
    e.target.value = '';
    if (!files.length) return;
    // **选完就回主页面**（2026-10-05 用户要求：选完文件点完成，直接回到主页面，
    // 不要停在这张「添加文件」面板上）。
    // 关在这里是安全的：文件是**后台在传**的，主页面上的附件小条会一条条冒出来；
    // 面板里那几行「已选文件」本来也只是同一份数据的另一处画法（见 renderAttach），
    // 关掉面板不会打断上传。
    closeOps();
    files.reduce(function (chain, f) {
      return chain.then(function () { return uploadFile(f); });
    }, Promise.resolve());
  });
  $('attachBar').addEventListener('click', function (e) {
    var pv = e.target.closest ? e.target.closest('[data-preview]') : null;
    if (pv) { previewUpload(pv.getAttribute('data-preview')); return; }
    var btn = e.target.closest ? e.target.closest('[data-drop]') : null;
    if (!btn) return;
    dropUpload(btn);
  });

  $('btnSend').addEventListener('click', send);

  inputEl.addEventListener('input', autoGrow);
  // 每敲一个字重算一次菜单。它自己会先看「是不是一个没打完的 / 名字」再决定动不动，
  // 所以这里不用加判据。
  inputEl.addEventListener('input', paintCmdMenu);
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
