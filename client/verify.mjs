// client/verify.mjs —— 手工验证 client/client.js 是否真的能用（零依赖、不需要测试框架）。
//
// 用法：node client/verify.mjs
//
// 做四件事：
//   1. 伪造 window.__ModuleLoader__，把整个文件 eval 一遍，确认模块外壳被注册；
//   2. 用 React 替身调用 factory，检查 exports（name / inject / apply）；
//   3. 用假的 ctx 调 apply，检查注册进 settings.section 的 def 和组件；
//   4. 用替身 React 真渲染一遍组件：加载中 → ok:false → ok:true → 网络错误，
//      并点一次「复制」按钮，确认文案临时变成「已复制」。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'client.js'), 'utf8');

// ---------------------------------------------------------------- 小工具

const tick = () => new Promise((resolve) => setImmediate(resolve));

const setGlobal = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

/** 把渲染树摊平成纯文本，用来断言界面上出现了哪些字。 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf(node.children);
}

/** 收集渲染树里所有元素节点（深度优先）。 */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  out.push(node);
  walk(node.children, out);
  return out;
}

const byType = (tree, type) => walk(tree).filter((node) => node.type === type);

/**
 * 最小 React 替身 + 最小渲染循环。
 * createElement 返回普通对象；useState 真的能改状态并触发重渲染；
 * useEffect 不在渲染时执行，由 runEffects() 显式跑一次（和 React 一致）。
 */
function createHarness() {
  const cells = [];
  let cursor = 0;
  let pending = [];
  let cleanups = [];
  let onUpdate = null;

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(initial) {
      const i = cursor++;
      if (i >= cells.length) cells.push(typeof initial === 'function' ? initial() : initial);
      const set = (next) => {
        cells[i] = typeof next === 'function' ? next(cells[i]) : next;
        if (onUpdate) onUpdate();
      };
      return [cells[i], set];
    },
    useEffect(fn) { pending.push(fn); },
    useRef(initial) { return { current: initial }; },
  };

  return {
    React,
    /** 渲染一次；重渲染会丢掉上一次登记的 effect（等价于依赖数组没变时不重跑）。 */
    draw(Comp) { cursor = 0; pending = []; return Comp({}); },
    runEffects() {
      const fns = pending;
      pending = [];
      for (const fn of fns) {
        const dispose = fn();
        if (typeof dispose === 'function') cleanups.push(dispose);
      }
    },
    unmount() { for (const dispose of cleanups) dispose(); cleanups = []; },
    onUpdate(fn) { onUpdate = fn; },
  };
}

/**
 * 组件在 factory 里就把 React.useState/useEffect 绑进了工厂闭包，所以替身必须是
 * 一个稳定的门面对象，内部转发给「当前这一套状态」——否则第二套 harness 永远不生效。
 */
let active = null;
const ReactFacade = {
  createElement: (type, props, ...children) => active.React.createElement(type, props, ...children),
  useState: (initial) => active.React.useState(initial),
  useEffect: (fn) => active.React.useEffect(fn),
  useRef: (initial) => active.React.useRef(initial),
};

/** 新建一套状态单元并设为当前（每个渲染用例一套，互不干扰）。 */
function useHarness() {
  active = createHarness();
  return active;
}

/** 假的 fetch 响应。 */
const jsonResponse = (status, body) => ({
  status,
  json: async () => body,
});

// ---------------------------------------------------------------- 断言运行器

let passed = 0;
const failures = [];

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push({ label, err });
    console.log(`  ✗ ${label}`);
    console.log(`      ${err && err.message ? err.message : err}`);
  }
}

// ---------------------------------------------------------------- 1. 模块外壳

let captured = null;
setGlobal('window', { __ModuleLoader__: { load: (registration) => { captured = registration; } } });
(0, eval)(source); // 间接 eval：在全局作用域执行，模拟浏览器加载这个脚本

console.log('\n[1] 模块外壳 window.__ModuleLoader__.load');

await check('文件执行后捕获到一次注册', () => {
  assert.ok(captured, '没有调用 window.__ModuleLoader__.load');
});
await check('id === "dsh-mini-remote"', () => {
  assert.equal(captured.id, 'dsh-mini-remote');
});
await check('factory 是函数', () => {
  assert.equal(typeof captured.factory, 'function');
});

// ---------------------------------------------------------------- 2. factory / exports

const harness = useHarness();
const required = [];
const fakeRequire = (spec) => {
  required.push(spec);
  if (spec === 'react') return ReactFacade;
  throw new Error(`客户端模块只允许 require("react")，实际请求了 "${spec}"`);
};

let mod = null;
console.log('\n[2] factory(require) 的返回值');
await check('factory 不抛错并返回 exports', () => {
  mod = captured.factory(fakeRequire);
  assert.ok(mod && typeof mod === 'object');
});
await check('只 require 了 react（零运行时依赖）', () => {
  assert.deepEqual(required, ['react']);
});
await check('exports.name === "dsh-mini-remote"', () => {
  assert.equal(mod.name, 'dsh-mini-remote');
});
await check("exports.inject 深等于 ['slots']", () => {
  assert.deepEqual(mod.inject, ['slots']);
});
await check('exports.apply 是函数', () => {
  assert.equal(typeof mod.apply, 'function');
});

// ---------------------------------------------------------------- 3. apply / slots 注册

const injected = [];
const registered = [];
const fakeCtx = {
  slots: {
    inject(name, callback) { injected.push(name); return callback(); },
    register(def, Comp) { registered.push({ def, Comp }); return () => {}; },
  },
};

let Comp = null;
let def = null;
console.log('\n[3] apply(ctx) 的 slots 注册');
await check('apply(fakeCtx) 不抛错', () => {
  assert.doesNotThrow(() => mod.apply(fakeCtx));
});
await check('inject 的服务名是 "settings.section"', () => {
  assert.deepEqual(injected, ['settings.section']);
});
await check('register 只调用了一次', () => {
  assert.equal(registered.length, 1);
});
await check('def.name === "settings.section"', () => {
  def = registered[0].def;
  assert.equal(def.name, 'settings.section');
});
await check('def.id === "mini-remote"', () => {
  assert.equal(def.id, 'mini-remote');
});
await check('def.order === 2', () => {
  assert.equal(def.order, 2);
});
await check('def.label 是函数（typeof === "function"）', () => {
  assert.equal(typeof def.label, 'function');
});
await check('def.label() === "手机遥控"', () => {
  assert.equal(def.label(), '手机遥控');
});
await check('第二个参数是组件函数', () => {
  Comp = registered[0].Comp;
  assert.equal(typeof Comp, 'function');
});

// ---------------------------------------------------------------- 4. 渲染组件

const TOKEN = '0123456789abcdef0123456789abcdef';
const URL_LAN = `http://192.168.1.2:3090/mini?token=${TOKEN}`;
const URL_TS = `http://100.92.105.99:3090/mini?token=${TOKEN}`;
const QR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

console.log('\n[4] 组件渲染');

// 4a. 加载中
let resolveFetch = null;
setGlobal('fetch', () => new Promise((resolve) => { resolveFetch = resolve; }));
{
  const h4 = useHarness();
  let tree = null;
  h4.onUpdate(() => { tree = h4.draw(Comp); });
  await check('挂载时不抛错，并显示「正在读取配对信息…」', () => {
    tree = h4.draw(Comp);
    assert.notEqual(tree, undefined);
    assert.match(textOf(tree), /正在读取配对信息…/);
  });
  await check('useEffect 里发起了同源 GET /mini-remote/pairing', () => {
    h4.runEffects();
    assert.equal(typeof resolveFetch, 'function', 'useEffect 里没有发起 fetch');
  });
  await check('顶部两句说明都在', () => {
    const text = textOf(tree);
    assert.match(text, /手机扫码就能用，不用输密码——密码已经编在二维码里了。/);
    assert.match(text, /这个页面带着密码，别截图发出去。/);
  });
  await check('HTTP 403 + {ok:false,error} → 显示 error 原文', async () => {
    resolveFetch(jsonResponse(403, { ok: false, error: '配对信息只能在这台电脑上看。' }));
    await tick();
    assert.match(textOf(tree), /配对信息只能在这台电脑上看。/);
    assert.doesNotMatch(textOf(tree), /正在读取配对信息…/);
  });
}

// 4b. 网络错误（fetch 直接失败）
{
  const h4 = useHarness();
  setGlobal('fetch', () => Promise.reject(new Error('Failed to fetch')));
  let tree = null;
  h4.onUpdate(() => { tree = h4.draw(Comp); });
  await check('网络错误 → 显示失败原因，不吞掉', async () => {
    tree = h4.draw(Comp);
    h4.runEffects();
    await tick();
    assert.match(textOf(tree), /连不上这台电脑上的遥控服务：Failed to fetch/);
  });
}

// 4c. 成功：两条 entry（第二条没有二维码）
{
  const h4 = useHarness();
  setGlobal('fetch', async () => jsonResponse(200, {
    ok: true,
    port: 3090,
    token: TOKEN,
    entries: [
      { kind: 'lan', label: '内网', hint: '手机连同一个 Wi-Fi 时用这个', url: URL_LAN, qr: QR },
      { kind: 'tailscale', label: 'Tailscale', hint: '在外面也能用', url: URL_TS, qr: null },
    ],
  }));
  let tree = null;
  h4.onUpdate(() => { tree = h4.draw(Comp); });

  await check('ok:true 时渲染两块 entry（label + hint）', async () => {
    tree = h4.draw(Comp);
    h4.runEffects();
    await tick();
    const text = textOf(tree);
    assert.match(text, /内网/);
    assert.match(text, /手机连同一个 Wi-Fi 时用这个/);
    assert.match(text, /Tailscale/);
    assert.match(text, /在外面也能用/);
    assert.doesNotMatch(text, /正在读取配对信息…/);
  });

  await check('二维码渲染成 <img src={entry.qr}>（宽 180）', () => {
    const imgs = byType(tree, 'img');
    assert.equal(imgs.length, 1, '有 qr 的只有一条，qr:null 的那条应退化成文字');
    assert.equal(imgs[0].props.src, QR);
    assert.equal(imgs[0].props.style.width, 180);
  });

  await check('两条 URL 都在只读 <input> 里，不是纯文本 div', () => {
    // 按内容找，不按位置也不数总数：面板上还有别的输入框（密码、改密码那两处），
    // 数总数的话，每加一个输入框这里都要误报一次。
    const urls = byType(tree, 'input').filter((n) => n.props.value === URL_LAN || n.props.value === URL_TS);
    assert.equal(urls.length, 2);
    assert.equal(urls[0].props.readOnly, true);
    assert.equal(urls[1].props.readOnly, true);
  });

  await check('点输入框会全选地址', () => {
    let selected = false;
    const lan = byType(tree, 'input').find((n) => n.props.value === URL_LAN);
    lan.props.onFocus({ target: { select() { selected = true; } } });
    assert.equal(selected, true);
  });

  await check('qr 为 null 时退化成文字，界面不崩', () => {
    assert.match(textOf(tree), /二维码没画出来/);
  });

  await check('每条链接各有一个「复制」按钮，初始文案是「复制」', () => {
    // 同样按文案找，不数总数：密码那一块也有「复制」。
    const copies = byType(tree, 'button').filter((b) => textOf(b) === '复制');
    assert.ok(copies.length >= 2, '两条链接各要有一个「复制」按钮');
    assert.equal(textOf(copies[0]), '复制');
    assert.equal(textOf(copies[1]), '复制');
  });

  // 2026-09-22 用户报：「手机遥控页面里似乎根本没有密码，也无法自定义密码」。
  // 配对接口一直返回着 token，只是没人渲染它——这三项钉住它真的露出来了。
  await check('密码默认打码显示，不是明文', () => {
    const masked = TOKEN.replace(/./g, '•');
    const pw = byType(tree, 'input').find((n) => n.props.value === masked);
    assert.ok(pw, '默认该显示打码后的密码');
    assert.equal(pw.props.readOnly, true, '密码框只能看，不能改——改要走保存那条路');
    assert.ok(!byType(tree, 'input').some((n) => n.props.value === TOKEN), '没点「显示」之前不该出现明文');
  });

  await check('点「显示」→ 明文，再点「藏起来」→ 又打码', async () => {
    const masked = TOKEN.replace(/./g, '•');
    const showBtn = byType(tree, 'button').find((b) => textOf(b) === '显示');
    assert.ok(showBtn, '要有一个「显示」按钮');
    showBtn.props.onClick();
    await tick();
    tree = h4.draw(Comp);
    assert.ok(byType(tree, 'input').some((n) => n.props.value === TOKEN), '点过之后应显示明文');
    const hideBtn = byType(tree, 'button').find((b) => textOf(b) === '藏起来');
    assert.ok(hideBtn, '显示之后按钮该变成「藏起来」');
    hideBtn.props.onClick();
    await tick();
    tree = h4.draw(Comp);
    assert.ok(byType(tree, 'input').some((n) => n.props.value === masked), '再点一次该变回打码');
  });

  await check('点密码旁边的「复制」→ 复制的是密码本身', async () => {
    const written = [];
    setGlobal('navigator', { clipboard: { writeText: async (text) => { written.push(text); } } });
    // 链接那两个「复制」在前，密码那个在最后
    const copies = byType(tree, 'button').filter((b) => textOf(b) === '复制');
    copies[copies.length - 1].props.onClick();
    await tick();
    assert.deepEqual(written, [TOKEN]);
  });

  await check('点「复制」→ navigator.clipboard.writeText(url)，文案变「已复制」', async () => {
    const written = [];
    setGlobal('navigator', { clipboard: { writeText: async (text) => { written.push(text); } } });
    byType(tree, 'button')[0].props.onClick();
    await tick();
    assert.deepEqual(written, [URL_LAN]);
    const buttons = byType(tree, 'button');
    assert.equal(textOf(buttons[0]), '已复制');
    assert.equal(textOf(buttons[1]), '复制', '只改被点的那一个');
  });

  await check('复制失败时不谎报「已复制」', async () => {
    const h5 = useHarness();
    let tree5 = null;
    h5.onUpdate(() => { tree5 = h5.draw(Comp); });
    tree5 = h5.draw(Comp);
    h5.runEffects();
    await tick();
    setGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } });
    byType(tree5, 'button')[0].props.onClick();
    await tick();
    assert.equal(textOf(byType(tree5, 'button')[0]), '复制');
  });
}

// 4d. 公网访问：开关、状态、报错、以及 ok:false 时也要能关掉它
{
  const withTunnel = (tunnel, extra) => Object.assign({
    ok: true,
    port: 3090,
    token: TOKEN,
    entries: [{ kind: 'lan', label: '内网', hint: '手机连同一个 Wi-Fi 时用这个', url: URL_LAN, qr: QR }],
    tunnel,
  }, extra || {});

  const h6 = useHarness();
  let tree6 = null;
  let posted = [];
  h6.onUpdate(() => { tree6 = h6.draw(Comp); });

  const mount = async (payload) => {
    setGlobal('fetch', async (url, init) => {
      if (init && init.method === 'POST') {
        posted.push({ url, body: JSON.parse(init.body) });
        return jsonResponse(200, withTunnel({ enabled: JSON.parse(init.body).enabled, up: false, starting: false, error: null }));
      }
      return jsonResponse(200, payload);
    });
    tree6 = h6.draw(Comp);
    h6.runEffects();
    await tick();
  };

  await check('公网没开时：开关是未选中的，并且说明「出门进不来」', async () => {
    await mount(withTunnel({ enabled: false, up: false, starting: false, error: null }));
    const boxes = byType(tree6, 'input').filter((n) => n.props.type === 'checkbox');
    assert.equal(boxes.length, 1, '要有一个公网开关');
    assert.equal(boxes[0].props.checked, false);
    const text = textOf(tree6);
    assert.match(text, /公网访问/);
    assert.match(text, /手机不连家里 Wi-Fi 的时候就进不来/);
  });

  await check('公网开着且有地址时：开关选中，提示去看「公网」那条', async () => {
    await mount(withTunnel({ enabled: true, up: true, starting: false, error: null }));
    const boxes = byType(tree6, 'input').filter((n) => n.props.type === 'checkbox');
    assert.equal(boxes[0].props.checked, true);
    const text = textOf(tree6);
    assert.match(text, /上面那条「公网」/);
    assert.match(text, /每次重启 DSH 都会换一个/, '要提前说清楚地址会变');
    assert.match(text, /挂在公网上/, '开了要提醒它现在暴露在公网');
  });

  await check('公网开着但连不上时：原文报错照登，不吞掉', async () => {
    await mount(withTunnel({ enabled: true, up: false, starting: false, error: '所有下载源都没成功：\n  github.com — 超时' }));
    const text = textOf(tree6);
    assert.match(text, /开着，但公网那边连不上/, '要让用户知道这条路现在是死的');
    assert.match(text, /所有下载源都没成功/, '底层原因要透出来，否则没法排查');
    assert.match(text, /github\.com — 超时/);
  });

  // 2026-09-22 用户照着一个写着「已开启」的面板去扫码，扫出来是 Cloudflare 的 Error 1033。
  // 这两种情况必须分开说：**还在等地址**和**地址拿到过、后来断了**，用户的下一步动作不同。
  await check('公网开着、没有报错时：说的是「还没拿到地址」，不是「连不上」', async () => {
    await mount(withTunnel({ enabled: true, up: false, starting: false, error: null }));
    const text = textOf(tree6);
    assert.match(text, /已开启，但还没拿到公网地址/);
    assert.doesNotMatch(text, /公网那边连不上/, '还没报错就不该先吓唬人');
  });

  await check('正在打开时：开关禁用，避免连点起出好几条隧道', async () => {
    await mount(withTunnel({ enabled: true, up: false, starting: true, error: null }));
    const boxes = byType(tree6, 'input').filter((n) => n.props.type === 'checkbox');
    assert.equal(boxes[0].props.disabled, true);
    assert.match(textOf(tree6), /正在打开/);
  });

  await check('勾上开关 → POST /mini-remote/tunnel，body 是 {enabled:true}', async () => {
    posted = [];
    await mount(withTunnel({ enabled: false, up: false, starting: false, error: null }));
    const box = byType(tree6, 'input').filter((n) => n.props.type === 'checkbox')[0];
    box.props.onChange({ target: { checked: true } });
    await tick();
    assert.equal(posted.length, 1, '只该发一次请求');
    assert.equal(posted[0].url, '/mini-remote/tunnel');
    assert.deepEqual(posted[0].body, { enabled: true });
  });

  await check('关掉开关 → body 是 {enabled:false}', async () => {
    posted = [];
    await mount(withTunnel({ enabled: true, up: true, starting: false, error: null }));
    const box = byType(tree6, 'input').filter((n) => n.props.type === 'checkbox')[0];
    box.props.onChange({ target: { checked: false } });
    await tick();
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0].body, { enabled: false });
  });

  await check('整块面板报错时，公网开关仍然露得出来', async () => {
    // 否则「隧道起不来」会把面板变成一条报错，用户连关掉它的地方都找不到
    await mount(withTunnel(
      { enabled: true, up: false, starting: false, error: '找不到 cloudflared' },
      { ok: false, error: '公网访问没起来：找不到 cloudflared', entries: undefined },
    ));
    const boxes = byType(tree6, 'input').filter((n) => n.props.type === 'checkbox');
    assert.equal(boxes.length, 1, '报错时也得能点得动开关');
    assert.equal(boxes[0].props.checked, true);
    assert.match(textOf(tree6), /公网访问没起来/);
  });
}

// 4e. Tailscale 的 HTTPS 地址：开关、状态、以及「tailnet 没开 Serve」那条路
{
  const withServe = (serve, extra) => Object.assign({
    ok: true,
    port: 3090,
    token: TOKEN,
    entries: [{ kind: 'lan', label: '内网', hint: '手机连同一个 Wi-Fi 时用这个', url: URL_LAN, qr: QR }],
    // **故意不给 tunnel**：给了页面上就会有两个复选框（公网一个、HTTPS 一个），
    // 下面按顺序取第一个会抓到公网那个。少给一块，这里就只剩一个复选框，
    // 「抓对了没有」不再是个变量。两块同时在的顺序另有一条专门测。
    tunnel: null,
    serve,
  }, extra || {});

  let tree7 = null;
  let posted7 = [];
  // 这次 POST 返回什么，由每条用例自己定——失败那条路要回的是 serve 自己的形状
  // （带 reason 和 enableLink），不是配对信息。
  let postReply = null;
  let serveBox = () => [];

  // **每条用例一套全新的状态单元。** 脚手架的 `draw()` 只把 `cursor` 归零，
  // 不清 `cells`——所以上一条用例里「开开关失败了」留下的错误会一直挂在后面
  // 每一条上。2026-09-25 就是这么撞上的：一条用例本该只有一条链接，却数出两条。
  // 真机上不会这样（面板每次加载都是干净的），是脚手架复用了同一个组件实例。
  const mount7 = async (payload) => {
    const h = useHarness();
    posted7 = [];
    h.onUpdate(() => { tree7 = h.draw(Comp); });
    serveBox = () => byType(tree7, 'input').filter((n) => n.props.type === 'checkbox');
    setGlobal('fetch', async (url, init) => {
      if (init && init.method === 'POST') {
        posted7.push({ url, body: JSON.parse(init.body) });
        return jsonResponse(200, postReply);
      }
      return jsonResponse(200, payload);
    });
    tree7 = h.draw(Comp);
    h.runEffects();
    await tick();
  };

  await check('HTTPS 没开时：开关未选中，并说清楚开了能换来什么', async () => {
    await mount7(withServe({ installed: true, on: false, url: null, urlOfOtherPort: null, error: null }));
    const text = textOf(tree7);
    assert.match(text, /HTTPS 地址（Tailscale）/);
    // 光说「没开」没用，得说清楚**开了能换来什么**，否则用户没理由去开它。
    // 换来的是"连接加密"（地址栏上那把 https 的锁）——**不要再写通知和麦克风**：
    // 那两样我们都没实现（通知入口 2026-09-25 起藏着，麦克风图标已移除），
    // 2026-09-27 用户指出这是拿不存在的功能招揽。
    assert.match(text, /加密/);
    assert.match(text, /https/i);
    assert.doesNotMatch(text, /通知|麦克风/);
    // 还要说清楚它和上面那条明文 Tailscale 是同一台电脑，不是第四条路
    assert.match(text, /同一台电脑/);
  });

  await check('HTTPS 开着时：开关选中，并指向面板上那条加密地址', async () => {
    await mount7(withServe({
      installed: true, on: true, url: 'https://x.ts.net/', urlOfOtherPort: null, error: null,
    }));
    const text = textOf(tree7);
    assert.match(text, /已开启/);
    assert.match(text, /「Tailscale（加密）」/, '要告诉用户上面哪一条是它');
  });

  await check('serve 配着但指的是别的端口：说清楚，不能含糊成「没开」', async () => {
    // 含糊成「没开」的话，用户会以为是自己这台电脑不支持，然后放弃。
    await mount7(withServe({
      installed: true, on: false, url: null, urlOfOtherPort: 'https://x.ts.net/', error: null,
    }));
    const text = textOf(tree7);
    assert.match(text, /指的是别的端口/);
    assert.doesNotMatch(text, /^没开/, '不能只说没开');
  });

  await check('没装 Tailscale 时：开关禁用，别让人点了没反应', async () => {
    await mount7(withServe({ installed: false, on: false, url: null, urlOfOtherPort: null, error: null }));
    const text = textOf(tree7);
    assert.match(text, /没装 Tailscale/);
    assert.equal(serveBox().length, 1);
    assert.equal(serveBox()[0].props.disabled, true, '装都没装，开关该是灰的');
  });

  // 这条是整块界面上最要紧的一条。tailnet 没开 Serve 是整个功能里门槛最高的一步，
  // 而 Tailscale 官方把开启链接印在报错里了——把它原样递给用户，他点一下就完事。
  // 界面上如果只显示一句「失败了」，用户就卡死在这里。
  await check('tailnet 没开 Serve：报错要说明白，并且把开启链接做成可点的', async () => {
    postReply = {
      ok: false,
      reason: 'tailnet',
      error: 'Tailscale 的 Serve 功能还没在这个账号上打开。点下面这条链接开一下，然后回来再试一次。',
      enableLink: 'https://login.tailscale.com/f/serve?node=nKZqMyw1VE11CNTRL',
    };
    await mount7(withServe({ installed: true, on: false, url: null, urlOfOtherPort: null, error: null }));
    serveBox()[0].props.onChange({ target: { checked: true } });
    await tick();

    assert.equal(posted7.length, 1);
    assert.equal(posted7[0].url, '/mini-remote/serve');
    assert.deepEqual(posted7[0].body, { enabled: true });

    const text = textOf(tree7);
    assert.match(text, /Serve 功能还没在这个账号上打开/);
    const links = byType(tree7, 'a').filter((n) => String(n.props.href).includes('login.tailscale.com'));
    assert.equal(links.length, 1, '开启链接必须真的渲染成一个可点的链接');
    assert.equal(links[0].props.href, 'https://login.tailscale.com/f/serve?node=nKZqMyw1VE11CNTRL');
  });

  // 下面三条测的是「还没走完这一关的人，面板上能看到什么」。
  //
  // 起因是用户 2026-09-25 提的问题：这插件不是给一个人用的，别人上手之后，
  // 插件能不能自动带他走完这一步？不能（那是 tailnet 级、要浏览器会话的授权）。
  // 那就必须**在点开关之前**就把该去哪儿说清楚，而不是等他点了、等十几秒、
  // 失败了才知道。服务端早就算出了那两条链接，是界面把它们丢掉了。
  await check('serve 没开、但报错里有开启链接时：不用点开关就先给出来', async () => {
    await mount7(withServe({
      installed: true,
      on: false,
      url: null,
      urlOfOtherPort: null,
      error: null,
      enableLink: 'https://login.tailscale.com/f/serve?node=nKZqMyw1VE11CNTRL',
    }));
    const links = byType(tree7, 'a').filter((n) => String(n.props.href).includes('/f/serve'));
    assert.equal(links.length, 1, '还没点开关，这条链接就该在了');
    assert.equal(links[0].props.href, 'https://login.tailscale.com/f/serve?node=nKZqMyw1VE11CNTRL');
    assert.match(textOf(tree7), /插件代不了你点/, '要说清楚这一步得他自己在浏览器里点');
  });

  await check('装了但没登录：说的是「没登录」，并且给出登录链接', async () => {
    // 合成一句「没开」的话，一个还没登录的人会反复点开关——怎么点都不会有反应，
    // 因为手机要连的那个地址，是登录之后才存在的。
    await mount7(withServe({
      installed: true,
      on: false,
      url: null,
      urlOfOtherPort: null,
      error: 'Tailscale 装了，但这个账号还没登录。',
      needsLogin: true,
      loginUrl: 'https://login.tailscale.com/a/abc123def456',
    }));
    const text = textOf(tree7);
    assert.match(text, /还没登录/);
    assert.doesNotMatch(text, /^没开/, '不能含糊成「没开」');
    const links = byType(tree7, 'a').filter((n) => String(n.props.href).includes('login.tailscale.com'));
    assert.equal(links.length, 1);
    assert.equal(links[0].props.href, 'https://login.tailscale.com/a/abc123def456');
    assert.equal(serveBox()[0].props.disabled, true, '登录之前点开关没有意义，该是灰的');
  });

  await check('状态问不出来时：原文照登，不假装成「没开」', async () => {
    await mount7(withServe({
      installed: true,
      on: false,
      url: null,
      urlOfOtherPort: null,
      error: '问不出来 Tailscale serve 的现状。',
    }));
    assert.match(textOf(tree7), /问不出来/);
  });

  await check('成功开启后：面板换成新状态，开关变选中', async () => {
    postReply = withServe({
      installed: true, on: true, url: 'https://x.ts.net/', urlOfOtherPort: null, error: null,
    });
    await mount7(withServe({ installed: true, on: false, url: null, urlOfOtherPort: null, error: null }));
    serveBox()[0].props.onChange({ target: { checked: true } });
    await tick();
    assert.match(textOf(tree7), /已开启/);
  });

  await check('整块面板报错时，HTTPS 开关仍然露得出来', async () => {
    // 和公网那条同理：tailnet 没开 Serve 的时候，面板上其它东西多半也在报错，
    // 而那正是用户最需要看到那条开启链接的时候。
    await mount7(withServe(
      { installed: true, on: false, url: null, urlOfOtherPort: null, error: null },
      { ok: false, error: '没找到手机能连上的地址。', entries: undefined },
    ));
    assert.match(textOf(tree7), /HTTPS 地址（Tailscale）/);
    assert.equal(serveBox().length, 1);
  });

  await check('公网和 HTTPS 两块同时出现时，HTTPS 排在公网后面', async () => {
    // 顺序是有意的：三条连接路径（内网 / Tailscale / 公网）先说完，
    // 再补一句 Tailscale 那条路还能换成加密的。反过来的话用户会以为
    // HTTPS 是第四条路，而它其实只是同一条路上的一个开关。
    await mount7(withServe(
      { installed: true, on: false, url: null, urlOfOtherPort: null, error: null },
      { tunnel: { enabled: false, up: false, starting: false, error: null } },
    ));
    const text = textOf(tree7);
    assert.ok(
      text.indexOf('公网访问') < text.indexOf('HTTPS 地址（Tailscale）'),
      'HTTPS 那一块该排在公网后面',
    );
    assert.equal(serveBox().length, 2, '两块各有一个开关');
  });
}

// 4f. 飞书那一块：开关、两个凭据、两个名单，以及「被挡下的来源」那一行
{
  const withFeishu = (feishu, extra) => Object.assign({
    ok: true,
    port: 3090,
    token: TOKEN,
    entries: [{ kind: 'lan', label: '内网', hint: '手机连同一个 Wi-Fi 时用这个', url: URL_LAN, qr: QR }],
    // **故意不给 tunnel / serve**：那两块也各有一个复选框，这里少给两块，
    // 「抓到的复选框是飞书那个」就不再是个变量。
    tunnel: null,
    serve: null,
    feishu,
  }, extra || {});

  const FEISHU = {
    enabled: true,
    appId: 'cli_0123456789abcdef',
    openIds: 'ou_me',
    chatIds: '',
    hasSecret: true,
    starting: false,
    running: true,
    connected: true,
    rejected: null,
    error: null,
  };

  let tree8 = null;
  let posted8 = [];
  /** POST 那条要回什么；undefined = 照常回整份配对信息。 */
  let postReply8;

  // 这一块里的按钮不止一个（密码那一块也叫「保存」），所以先按标题框出这一块，
  // 再在块内找——按文案在全树里找会抓到别人家的按钮。
  const feishuSel = () => {
    const block = walk(tree8).find((n) => n.type === 'div' && textOf(n).trim().startsWith('飞书'));
    assert.ok(block, '面板上该有飞书那一块');
    const inputs = byType(block, 'input');
    return {
      block,
      text: textOf(block),
      box: inputs.filter((n) => n.props.type === 'checkbox'),
      password: inputs.find((n) => n.props.type === 'password'),
      save: byType(block, 'button').find((b) => /^保存/.test(textOf(b))),
    };
  };

  const mount8 = async (payload) => {
    const h = useHarness();
    posted8 = [];
    postReply8 = undefined;
    h.onUpdate(() => { tree8 = h.draw(Comp); });
    setGlobal('fetch', async (url, init) => {
      if (init && init.method === 'POST') {
        posted8.push({ url, body: JSON.parse(init.body) });
        return jsonResponse(200, postReply8 === undefined ? payload : postReply8);
      }
      return jsonResponse(200, payload);
    });
    tree8 = h.draw(Comp);
    h.runEffects();   // 读配对信息
    await tick();     // 信息到了 → 重渲染，rerun 一次让草稿填进来
    h.runEffects();
    await tick();
  };

  await check('飞书默认关着：开关未选中，两个名单空着时给出「怎么拿到自己 id」的那条路', async () => {
    await mount8(withFeishu(Object.assign({}, FEISHU, {
      enabled: false, running: false, connected: false, hasSecret: false, appId: '', openIds: '',
    })));
    const sel = feishuSel();
    assert.equal(sel.box.length, 1, '这一块该有一个开关');
    assert.equal(sel.box[0].props.checked, false, '默认是关的，不许自己偷偷连出去');
    assert.match(sel.text, /没开/);
    // 名单默认是空的（谁都不认），用户不可能凭空知道自己的 open_id 长什么样：
    // 面板必须当场告诉他「发一句 → 回这一页刷新 → 抄进来」这条流程。
    assert.match(sel.text, /刷新/, '要写清楚怎么把来源 id 弄出来');
    assert.match(sel.text, /open_id/);
    // 后台那几步（该订阅哪个事件之类）全在收起的那份指引里，上面这一行只负责指路。
    assert.match(sel.text, /指引/, '要告诉用户后台那些步骤在哪儿看');
  });

  await check('appSecret 是密码框，而且永远不回填（存过了也不显示）', async () => {
    await mount8(withFeishu(FEISHU));
    const sel = feishuSel();
    assert.ok(sel.password, '凭据那一格该是打码的');
    assert.equal(sel.password.props.value, '', '服务端不把 appSecret 送回来，这格就该是空的');
    assert.match(sel.password.props.placeholder, /留空/, '已经存过一份时要说明「留空 = 不动它」');
  });

  await check('没改动时保存按钮是禁用的（反馈靠禁用态，不发「已保存」）', async () => {
    await mount8(withFeishu(FEISHU));
    const sel = feishuSel();
    assert.ok(sel.save, '这一块要有一个保存按钮');
    assert.equal(sel.save.props.disabled, true, '没改东西就没什么可存的');
  });

  await check('勾上开关就能存：POST /mini-remote/feishu，凭据框空着就不发 appSecret', async () => {
    await mount8(withFeishu(Object.assign({}, FEISHU, { enabled: false })));
    feishuSel().box[0].props.onChange({ target: { checked: true } });
    await tick();
    assert.equal(feishuSel().save.props.disabled, false, '改了东西就该能存');
    feishuSel().save.props.onClick();
    await tick();
    assert.equal(posted8.length, 1);
    assert.equal(posted8[0].url, '/mini-remote/feishu');
    assert.equal(posted8[0].body.enabled, true);
    assert.equal(posted8[0].body.openIds, 'ou_me', '名单要一起存上去');
    assert.ok(!('appSecret' in posted8[0].body), '留空 = 不动原来那份，别拿空串把凭据覆盖掉');
  });

  await check('填了凭据才发上去，而且发完那一格要清空', async () => {
    await mount8(withFeishu(FEISHU));
    feishuSel().password.props.onChange({ target: { value: 'brand-new-secret' } });
    await tick();
    feishuSel().save.props.onClick();
    await tick();
    assert.equal(posted8[0].body.appSecret, 'brand-new-secret', '只有真填了才发上去');
    assert.equal(feishuSel().password.props.value, '', '存进去之后就别再摆在页面上了');
  });

  await check('被挡下的来源照登到面板上（含 open_id 原值）', async () => {
    // 这一行是整个配置流程能不能自己走通的关键：名单默认是空的，用户第一次发消息
    // 必然被挡，那时把他的 open_id 印出来，他才抄得进去。
    await mount8(withFeishu(Object.assign({}, FEISHU, {
      rejected: { reason: '来源不在白名单：open_id=ou_stranger、chat_id=oc_abc', at: 1 },
    })));
    const text = feishuSel().text;
    assert.match(text, /ou_stranger/, '原值要照登，不许加工');
    assert.match(text, /oc_abc/);
  });

  await check('配置指引默认收起：按钮在，六步正文一个字都不在页面上', async () => {
    await mount8(withFeishu(Object.assign({}, FEISHU, { enabled: false })));
    const text = feishuSel().text;
    assert.match(text, /配置指引/, '飞书这一块里要有那份指引的开关');
    assert.match(text, /六步/, '要写明是「飞书后台六步」，不然用户不知道这是给谁看的');
    // 按只可能出现在正文里的句子查，不按「事件与回调」这种别处也提过的词查。
    assert.doesNotMatch(text, /仅我可见/, '默认收起：正文不该摊在页面上');
    assert.doesNotMatch(text, /im:message:receive_as_bot/);
    assert.doesNotMatch(text, /添加应用能力/, '漏加机器人能力这一步也在正文里，收起时同样不该出现');
    assert.doesNotMatch(text, /不要把机器人拉进群/);
  });

  await check('点开配置指引：六步与注意事项在场；再点一次收回去', async () => {
    await mount8(withFeishu(Object.assign({}, FEISHU, { enabled: false })));
    const guideBtn = () => byType(feishuSel().block, 'button').find((b) => /配置指引/.test(textOf(b)));
    const closeBtn = () => byType(feishuSel().block, 'button').find((b) => /收起配置指引/.test(textOf(b)));

    guideBtn().props.onClick();
    await tick();
    const text = feishuSel().text;
    assert.match(text, /事件与回调/, '第二步要说清在哪儿设成长连接');
    assert.match(text, /添加应用能力/, '建应用那一步要写清去哪里加机器人能力，漏了这步飞书里搜不到机器人');
    assert.match(text, /漏了这步，飞书里搜不到它/, '漏加的后果要写在动作旁边，不能只说「要加」');
    assert.match(text, /im\.message\.receive_v1/, '订阅哪个事件是最容易漏的一步');
    assert.match(text, /im:message:receive_as_bot/);
    assert.match(text, /仅我可见/);
    assert.match(text, /不要把机器人拉进群/, '注意事项也在这一份里');
    assert.ok(closeBtn(), '点开之后按钮要变成「收起」');

    // 下面这几组钉的是 2026-10 实机跑通之后补进去的坑：每一条都对应一个具体动作或一个判断标志，
    // 改文案时不许把它们悄悄丢掉。判断标志（0→3、那条通知、那句灰字）是最省字也最经用的一类
    // 句子，删了用户就不知道自己到底做对了没有。
    assert.match(text, /搜索框只填 im\.message 这半段/, '权限页只搜半个 scope 名，是这个功能卡人最久的一步');
    assert.match(text, /带上后面的 :receive_as_bot 会搜出 0 条/, '要写清带上哪一段会搜不到，否则用户还是会连后半段一起搜');
    assert.match(text, /「应用身份权限」（另一个标签「用户身份权限」不用管）/, '说清三项在哪一档，顺带把另一个标签排掉');
    assert.match(text, /从 0 变成 3，就是勾对了/, '判断标志：勾全了才从 0 变 3');
    assert.match(text, /im\.message\.receive_v1 是事件，在第 4 步那个列表里配，权限页搜不到它/,
      '事件和权限是两个页面，这个混法最耽误时间');

    assert.match(text, /都要重新发布一次才生效，不发布一切不生效/, '改了不重新发布等于白改');
    assert.match(text, /「开发者小助手」会推给你一条通知（应用审批通过／已发布成功）/, '发布生效的可见信号，得说清去哪儿看');
    assert.match(text, /收到就是生效了/, '判断标志之二');
    assert.match(text, /企业里配了审批就得等管理员通过/, '有审批的企业里这一步会卡住，要提前说');

    // 第 5 步整段的行为在 2026-10 变了：不再让用户回电脑上抄 id，插件直接在飞书里回他一句。
    assert.match(text, /第一次一定被挡下（两份名单都留空时谁都不认）/, '第一次被挡是设计的一部分，不说清用户会以为配错了');
    assert.match(text, /插件会直接在飞书里回你一句/, '新路子：编号在飞书里当场给，不用回电脑上翻');
    assert.match(text, /你的编号告诉你/);
    assert.match(text, /open_id=ou_xxxxx/, '第 8 步要和插件在飞书里真回的那句话对得上');
    assert.match(text, /可能还带个 chat_id=oc_xxxxx/, 'chat_id 是「可能有」，不能写成一定有');
    assert.match(text, /照着它回的那句填就行，不用再回电脑上看/);
    assert.match(text, /填进「允许的 open_id」那一格（chat_id 可以留空）/);
    assert.match(text, /App Secret 那一格保存后会自动清空/, '密钥不回显，不说清用户会以为自己把它删掉了');
    assert.match(text, /留空就不改动它/, '判断标志之三：那句灰字是「存上了」的唯一凭据');
    assert.match(text, /留空保存 = 不动原来那份/);

    assert.match(text, /回答是整段一次回来的/, '整段回 = 要等一会儿，不预告用户会以为卡死了');
    assert.match(text, /回答落进手机页当前绑定的那个会话/, '回答落到哪个会话，是用户必然会问的第一个问题');
    assert.match(text, /这块还没做/, '看不到「在跟哪个会话说话」是已知缺口，不要含糊过去');
    assert.match(text, /机器人同时只处理一轮/);

    assert.match(text, /群里被挡时不会回那句话（只对单聊回）/,
      '那句提示只发给单聊，群里的人等不到——不写清楚会以为插件坏了');

    closeBtn().props.onClick();
    await tick();
    assert.doesNotMatch(feishuSel().text, /仅我可见/, '再点一次就该收回去');
    assert.doesNotMatch(feishuSel().text, /搜索框只填 im\.message/, '收起来之后新补的这些也不该留在页面上');
  });

  await check('保存失败时留一行，写清是哪一环', async () => {
    await mount8(withFeishu(Object.assign({}, FEISHU, { enabled: false })));
    postReply8 = 'not an object';
    feishuSel().box[0].props.onChange({ target: { checked: true } });
    await tick();
    feishuSel().save.props.onClick();
    await tick();
    assert.match(feishuSel().text, /保存飞书配置失败：服务返回了 HTTP 200。/, '失败要说清是哪一步');
  });

  await check('整块面板报错时，飞书这一块仍然露得出来', async () => {
    // 它是一条独立的通路，手机服务起没起来都不该拦着用户改它。
    await mount8(withFeishu(Object.assign({}, FEISHU, { enabled: false }), {
      ok: false, error: '没找到手机能连上的地址。', entries: undefined,
    }));
    assert.match(feishuSel().text, /飞书/);
    assert.equal(feishuSel().box.length, 1);
  });
}

// ---------------------------------------------------------------- 结果

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length) {
  for (const { label, err } of failures) console.log(`  ✗ ${label}: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
}
