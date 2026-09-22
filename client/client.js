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
        }),
      );
    }

    function content(info, failure, copied, copy, busy, toggle, pwd) {
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
      return h('div', null, blocks);
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
