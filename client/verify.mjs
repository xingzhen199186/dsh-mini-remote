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

// ---------------------------------------------------------------- 结果

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length) {
  for (const { label, err } of failures) console.log(`  ✗ ${label}: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
}
