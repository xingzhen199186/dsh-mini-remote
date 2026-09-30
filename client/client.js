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
    };

    function MiniRemoteSettingsTab() {
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

      // 和服务端那道校验是同一个数。前端先拦一道只是为了让「太短了」当场说出来，
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
        }),
      );
    }

    function content(info, failure, copied, copy, busy, toggle, pwd, serve, feishu) {
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
      return h('div', null, blocks);
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
        h('div', { style: styles.warn }, '要先在飞书开放平台建一个企业自建应用，并把它配成「用长连接收消息」。下面那份指引就是这件事的六步。'),
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
     * 第 8 步（第一次被白名单拒绝、插件把 open_id 报出来）和上面「被挡下的来源」那一行
     * 是同一件事，两处必须对得上。
     *
     * 样式只复用这一页已有的那几种（标题、说明文字、链接），不新增颜色和圆角。
     */
    function feishuGuide() {
      var sections = [
        ['一、建应用并取凭据', [
          '1. 打开飞书开放平台 →「开发者后台」→ 创建企业自建应用，名字随意。',
          '2. 进「凭证与基础信息」页，复制 App ID 和 App Secret 两个值。',
          '这两个值等下要填进上面那一块。App Secret 是密码性质的东西，别外传。',
        ]],
        ['二、告诉飞书「用长连接收消息」', [
          '3. 进「事件与回调」页，订阅方式选「使用长连接接收事件」。',
          '不要选需要填「请求地址」的那种——那种要求你的电脑能被公网访问，家用电脑做不到。',
          '4. 同一页点「添加事件」，搜 im.message.receive_v1 加上（意思是「收到消息时通知我」）。',
        ]],
        ['三、开三项权限', [
          '5. 进「权限管理」，开通这三项：',
          'im:message:receive_as_bot —— 接收发给机器人的消息',
          'im:message:send_as_bot —— 以机器人身份发消息',
          'im:message —— 回复某条消息',
        ]],
        ['四、发布', [
          '6. 进「版本管理与发布」→ 创建版本 → 申请发布。自己用就选「仅我可见」。',
        ]],
        ['五、在插件这边收尾', [
          '7. 打开 DSH 设置页里的飞书那一块，把开关打开，把 App ID / App Secret 填进去。',
          '8. 在飞书里搜到这个机器人，给它发一句话。第一次会被拒绝——这是正常的，'
            + '白名单默认是空的（默认拒绝，防止别人也能遥控你的电脑）。'
            + '插件会告诉你「来源不在白名单：open_id=ou_xxxxx」。',
          '9. 把那个 open_id 照抄填进白名单，再发一次。这次回答就会回到飞书里。',
        ]],
        ['注意事项', [
          '不要把机器人拉进群。现在只支持一对一私聊；而且一旦拉进群，群里任何人都能驱动你这台电脑。',
          'App Secret 若在飞书后台重置过，插件这边要重新填一次。',
          '飞书那边要求「三秒内响应」，我们是收到就记账、随后再答，所以偶尔会看到飞书重发同一条'
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

    function apply(ctx) {
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
