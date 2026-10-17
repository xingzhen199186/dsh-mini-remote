// client/verify.mjs —— 手工验证 client/client.js 是否真的能用（零依赖、不需要测试框架）。
//
// 用法：node client/verify.mjs
//
// 做四件事：
//   1. 伪造 window.__ModuleLoader__，把整个文件 eval 一遍，确认模块外壳被注册；
//   2. 用 React 替身调用 factory，检查 exports（name / inject / apply）；
//   3. 用假的 ctx 调 apply，检查三个槽位的注册形状与组件：
//      main（keyed，key 对上面板）、sidebar.panellist（list，id/order/label + 图标）、
//      settings.section（设置页那一节）；
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

/**
 * 把一条「点击 → 发请求 → 回执 → 存状态 → 通知 → 重画」的链子走完。
 *
 * 这条链子全是微任务（`setImmediate` 之前微任务已经排干），一次 tick 通常就够；
 * 多走几步是为了让断言别看到**上一轮**的结果（那是"差一条"的经典成因）。
 */
const settlePanel = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

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
    /**
     * 渲染一次；重渲染会丢掉上一次登记的 effect（等价于依赖数组没变时不重跑）。
     *
     * `props` 是外壳递进来的那些（真机上设置页那一节会拿到 `{ close }`，见
     * dsh-client-ui-settings-general 的 `renderSlot("settings.section", { close })`）。
     */
    draw(Comp, props) { cursor = 0; pending = []; return Comp(props || {}); },
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
/** 按槽位名取注册的那一条；找不到就是漏注册了，让断言去报错。 */
const entryOf = (name) => registered.find(({ def }) => def.name === name) || { def: {}, Comp: undefined };
console.log('\n[3] apply(ctx) 的 slots 注册');
await check('apply(fakeCtx) 不抛错', () => {
  assert.doesNotThrow(() => mod.apply(fakeCtx));
});
await check('三个槽位都走 inject（等声明出现再注册）：main / sidebar.panellist / settings.section', () => {
  assert.deepEqual(injected, ['main', 'sidebar.panellist', 'settings.section']);
});
await check('register 一共调用了三次（图标一枚 + 面板一屏 + 设置页一节）', () => {
  assert.equal(registered.length, 3);
});

// —— main：keyed 槽。注册的键写在 `key` 上，不是 id。
await check('main 那条：def.name === "main"', () => {
  assert.equal(entryOf('main').def.name, 'main');
});
await check('main 那条：def.key === "mini-remote"（keyed 槽认的是 key）', () => {
  assert.equal(entryOf('main').def.key, 'mini-remote');
});
await check('main 那条：不写 keyed 槽用不到的 id', () => {
  assert.equal(entryOf('main').def.id, undefined);
});
await check('main 那条：第二个参数是面板组件函数', () => {
  assert.equal(typeof entryOf('main').Comp, 'function');
});

// —— main 那条面板（2026-10-17 改过）：**侧栏图标点开先看到一份「其他电脑」名单**。
//     点某一台，才去换**那一台**的票、把它的界面嵌进来。
//
//     原来点开这一屏显示的是**本机**的电脑端界面——那是跨机还没做出来时的脚手架。
//     下面第一、二条就是它「从界面上退休」的凭据：面板挂载只读名单，**一次本机取票都不许有**，
//     源码里也不许再出现那条地址。宿主侧那条路由一个字没动（见 lib/index.js）。
const REMOTE_TICKET_URL = 'http://192.168.1.9:19387/mini/mirror/?ticket=one-shot-remote-value';
const PANEL_FAR = {
  id: 'f'.repeat(32), name: '书房那台', baseUrl: 'http://192.168.1.9:19387',
  lastOk: new Date('2026-10-16T15:08:00+08:00').getTime(),
};
const PANEL_OLD = { id: 'e'.repeat(32), name: '', baseUrl: 'http://100.92.105.99:19387', lastOk: 0 };
const Panel = entryOf('main').Comp;

/**
 * 挂一次「那一整屏」：`reply({ url, init, n })` 给响应，`box.asks` 是这一趟发出去的全部请求。
 * 返回的 `box` 里那棵树会跟着重画走（重画之后读 `box.tree` 才是新的）。
 */
const mountPanel = async (reply) => {
  const hh = useHarness();
  const box = { asks: [], tree: null, harness: hh };
  setGlobal('fetch', (url, init) => {
    box.asks.push({ url, method: (init && init.method) || 'GET', body: init && init.body });
    return Promise.resolve(reply({ url, init, n: box.asks.length }));
  });
  hh.onUpdate(() => { box.tree = hh.draw(Panel); });
  box.tree = hh.draw(Panel);
  hh.runEffects();
  await settlePanel();
  return box;
};
/** 名单来一份的两条路：读到了（有/没有内容）和读不到。 */
const remotesOk = (remotes) => () => jsonResponse(200, { ok: true, remotes: remotes });
const panelRow = (box, id) => walk(box.tree).find((n) => n && n.props && n.props.key === id);

await check('点开先读「其他电脑」名单：GET /mini-remote/remotes（**不再去换本机那张票**）', async () => {
  // ⚠️ **反向验证的靶子**：把「打开名单」改回「显示本机」（面板挂载时 POST 那条本机取票），
  //    这一条必须变红——它就是"看本机那条路退休了没有"的看门人。
  const box = await mountPanel(remotesOk([PANEL_FAR]));
  assert.deepEqual(box.asks.map((a) => a.method + ' ' + a.url), ['GET /mini-remote/remotes'],
    '面板点开那一刻，发出去的**只能**是读名单那一条');
  assert.equal(box.asks.filter((a) => a.method === 'POST').length, 0,
    '**看本机那条路退休了**：面板点开不再换本机那张票（POST 一次都不该有）');
  box.harness.unmount();
});

await check('看本机那条取票路确实退休：client.js 里不再出现那条地址', () => {
  assert.doesNotMatch(source, /\/mini-remote\/window/,
    '界面上不再走本机取票那条路（宿主侧那条路由还留着，不在这个文件里——见 lib/index.js）');
});

await check('名单到了：一行一台，名字 + 地址 + 最近一次成功的时间', async () => {
  const box = await mountPanel(remotesOk([PANEL_FAR, PANEL_OLD]));
  const text = textOf(box.tree);
  assert.match(text, /书房那台/);
  assert.match(text, /http:\/\/192\.168\.1\.9:19387/, '地址要摆出来（用户拿它和对面核对）');
  assert.match(text, /最近成功 2026-10-16 15:08/, '要说清"最近一次成功"是哪一刻');
  assert.match(text, /最近成功 还没有记录/, '没成功过就说还没有记录，不编一个时间');
  assert.match(text, /（这台电脑没有名字）/, '名字空着（用地址当名字时也可能为空）也要有个说法');
  assert.doesNotMatch(text, /NaN|undefined|Invalid Date/);
  assert.equal(byType(box.tree, 'iframe').length, 0, '还没点哪一台，一个框都不许立');
  box.harness.unmount();
});

await check('一台也没连过：那句人话（去设置里加一台）+ 一个「重新读一遍」', async () => {
  const box = await mountPanel(remotesOk([]));
  const text = textOf(box.tree);
  assert.match(text, /还没连过别的电脑/);
  assert.match(text, /设置 → 手机遥控 → 其他电脑/);
  assert.ok(byType(box.tree, 'button').some((b) => textOf(b) === '重新读一遍'),
    '要给人一个"再看一眼"的入口（他可能刚在设置页里加完）');
  assert.equal(byType(box.tree, 'iframe').length, 0);
  box.harness.unmount();
});

await check('名单读不到：照登原因（接口都没有 = 重启），**不说成"还没连过"**', async () => {
  const box = await mountPanel(() => jsonResponse(404, { ok: false, error: 'not found' }));
  const text = textOf(box.tree);
  assert.match(text, /读「其他电脑」名单失败/);
  assert.match(text, /重启一次 DSH 再试/, '接口都没有（宿主是旧版）时，下一步只有一句话：重启');
  assert.doesNotMatch(text, /还没连过别的电脑/, '读不到 ≠ 一台都没有（说错了会让人去重配一台好着的）');
  box.harness.unmount();
});

await check('点某一台 → 换**那一台**的票，框的地址里只有票、没有令牌', async () => {
  const box = await mountPanel(({ url }) => (url === '/mini-remote/remotes'
    ? jsonResponse(200, { ok: true, remotes: [PANEL_FAR] })
    : jsonResponse(200, { ok: true, url: REMOTE_TICKET_URL, expiresIn: 30 })));
  const row = panelRow(box, PANEL_FAR.id);
  assert.ok(row, '名单上要有那一行');
  row.props.onClick();
  await settlePanel();
  const post = box.asks.filter((a) => a.method === 'POST');
  assert.equal(post.length, 1, '点一行 = 去换那一台的票');
  assert.equal(post[0].url, '/mini-remote/remotes/window');
  assert.deepEqual(JSON.parse(post[0].body), { id: PANEL_FAR.id });
  const iframe = byType(box.tree, 'iframe')[0];
  assert.ok(iframe, '票到手了就把那一台的框立起来');
  assert.equal(iframe.props.src, REMOTE_TICKET_URL);
  assert.match(iframe.props.src, /\?ticket=/, '进门的凭据只能是那张票');
  assert.doesNotMatch(iframe.props.src, /[?&]token=/,
    '框的地址里**不许出现令牌**——那会留在打开这台电脑的人的浏览历史里');
  // 看完这一台，从界面**回到名单**：顶上那枚按钮，而且人还在这一屏里（不退出面板）。
  const back = byType(box.tree, 'button').find((b) => textOf(b) === '← 返回列表');
  assert.ok(back, '界面顶上要有一条回名单的路');
  back.props.onClick();
  box.harness.runEffects();   // 回到名单那一层：名单的 effect 重新读一遍
  await settlePanel();
  assert.equal(byType(box.tree, 'iframe').length, 0, '回到名单就不该还嵌着那一台');
  assert.ok(panelRow(box, PANEL_FAR.id), '名单又回来了（这一屏没离开）');
  box.harness.unmount();
});

await check('**出错那几种状态下**也回得去：那句人话旁边就是「← 返回列表」', async () => {
  const box = await mountPanel(({ url }) => (url === '/mini-remote/remotes'
    ? jsonResponse(200, { ok: true, remotes: [PANEL_FAR] })
    : jsonResponse(502, { ok: false, error: '那台电脑已经不认这枚凭据了——多半是它那边把这条记录撤销了。' })));
  panelRow(box, PANEL_FAR.id).props.onClick();
  await settlePanel();
  const text = textOf(box.tree);
  assert.match(text, /这台电脑已经被对方撤销了，要重新配对/, '出错了要给人话（上一轮做好的那一条）');
  assert.match(text, /再试一次/, '还要给一个下一步');
  assert.equal(byType(box.tree, 'iframe').length, 0, '没换到票就别立框');
  const back = byType(box.tree, 'button').find((b) => textOf(b) === '← 返回列表');
  assert.ok(back, '出错的时候最需要的恰恰是"怎么回去"——这一条不能只在成功时才有');
  back.props.onClick();
  box.harness.runEffects();
  await settlePanel();
  assert.equal(byType(box.tree, 'iframe').length, 0);
  assert.ok(panelRow(box, PANEL_FAR.id), '退回名单，人没卡在那一屏里');
  box.harness.unmount();
});

// —— sidebar.panellist：list 槽。id 必须和 main 的 key 对上，侧栏点下来才找得到面板。
await check('panellist 那条：def.name === "sidebar.panellist"', () => {
  assert.equal(entryOf('sidebar.panellist').def.name, 'sidebar.panellist');
});
await check('panellist 那条：id === "mini-remote"，与 main 的 key 一致', () => {
  assert.equal(entryOf('sidebar.panellist').def.id, 'mini-remote');
  assert.equal(entryOf('sidebar.panellist').def.id, entryOf('main').def.key);
});
await check('panellist 那条：order 是数字（排在官方那两枚之后）', () => {
  assert.equal(typeof entryOf('sidebar.panellist').def.order, 'number');
  assert.equal(entryOf('sidebar.panellist').def.order, 20);
});
await check('panellist 那条：label() === "远程窗口"', () => {
  assert.equal(typeof entryOf('sidebar.panellist').def.label, 'function');
  assert.equal(entryOf('sidebar.panellist').def.label(), '远程窗口');
});
await check('侧栏图标：按侧栏给的 size 画，颜色跟着 currentColor', () => {
  const icon = entryOf('sidebar.panellist').Comp({ size: 18, active: true });
  const svg = byType(icon, 'svg')[0];
  assert.ok(svg, '图标应当是一个 svg');
  assert.equal(svg.props.width, 18, '边长要用侧栏给的那个');
  assert.equal(svg.props.height, 18);
  assert.match(JSON.stringify(svg.children), /currentColor/, '颜色不写死，跟着侧栏的选中态走');
});
await check('侧栏图标：拿不到 size 时有兜底，不会画成 NaN 宽', () => {
  const svg = byType(entryOf('sidebar.panellist').Comp({}), 'svg')[0];
  assert.equal(svg.props.width, 16);
});

// —— settings.section：原有那一条，形状不变。
await check('def.name === "settings.section"', () => {
  const settingsDef = entryOf('settings.section').def;
  assert.equal(settingsDef.name, 'settings.section');
});
await check('def.id === "mini-remote"', () => {
  assert.equal(entryOf('settings.section').def.id, 'mini-remote');
});
await check('def.order === 2', () => {
  assert.equal(entryOf('settings.section').def.order, 2);
});
await check('def.label 是函数（typeof === "function"）', () => {
  assert.equal(typeof entryOf('settings.section').def.label, 'function');
});
await check('def.label() === "手机遥控"', () => {
  assert.equal(entryOf('settings.section').def.label(), '手机遥控');
});
await check('第二个参数是组件函数', () => {
  Comp = entryOf('settings.section').Comp;
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
    assert.match(text, /回答末尾另起一行「会话：<标题>」/, '回答出自哪个会话，现在靠这行标记，指引得说清它在哪儿');
    assert.match(text, /取不到名字时写「未命名会话」/, '兜底文案要对得上 lib/lark.js 的 SESSION_TAG_FALLBACK');
    assert.doesNotMatch(text, /这块还没做/, '这功能已经做了，别留旧说法');
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

// 4f. 设备那一块（2026-10-16 第三步）：列出 / 改名 / 撤销（撤销要二次确认）
{
  console.log('\n[4f] 设备名单（列出 / 改名 / 撤销）');

  const ISO = '2026-10-16T06:20:00+08:00';
  const DEV_A = {
    id: 'a'.repeat(32),
    name: '妈妈那台',
    kind: 'phone',
    createdAt: new Date(ISO).getTime(),
    lastSeen: new Date(ISO).getTime() + 5 * 60 * 1000,
  };
  // 老记录（第三步之前写下的）没有 lastSeen：界面上要说「还没有记录」，**不许凭空编一个时间**。
  const DEV_B = {
    id: 'b'.repeat(32), name: '客厅的旧手机', kind: 'phone',
    createdAt: new Date(ISO).getTime(), lastSeen: 0,
  };

  const PAIRING_OK = {
    ok: true,
    port: 3090,
    token: TOKEN,
    entries: [{ kind: 'lan', label: '内网', hint: '手机连同一个 Wi-Fi 时用这个', url: URL_LAN, qr: QR }],
    tunnel: { enabled: false, up: false, starting: false, error: null },
  };

  /**
   * 挂一次这一节：GET /mini-remote/devices 回名单，两条动作按顺序回执。
   * `listReplies` 是**依次**回给「列名单」那几次 GET 的（改名/撤销之后都会重新列一次）。
   */
  const mountDevices = async (listReplies, actionReply) => {
    const hh = useHarness();
    const state = { gets: [], posts: [], tree: null };
    let listAt = 0;
    setGlobal('fetch', async (url, init) => {
      if (init && init.method === 'POST') {
        state.posts.push({ url, body: JSON.parse(init.body) });
        return jsonResponse(200, actionReply(state.posts.length));
      }
      state.gets.push(url);
      if (url === '/mini-remote/devices') {
        const reply = listReplies[Math.min(listAt, listReplies.length - 1)];
        listAt += 1;
        return jsonResponse(200, reply);
      }
      return jsonResponse(200, PAIRING_OK);
    });
    hh.onUpdate(() => { state.tree = hh.draw(Comp); });
    state.tree = hh.draw(Comp);
    hh.runEffects();   // 读配对信息
    await tick();
    hh.runEffects();   // 配对信息到了 → 读设备名单
    await tick();
    return state;
  };

  /**
   * 设备那一块的渲染树。**按 key 找，不按位置也不按文案**：上面还有二维码、密码、
   * 尾插、飞书那几块，位置会变；而 key='devices' 是这一块自己的记号。
   */
  const devicesBlockOf = (tree) => walk(tree).find((n) => n && n.props && n.props.key === 'devices');

  const twoDevices = { ok: true, devices: [DEV_A, DEV_B] };

  await check('名单到了就摆出来：名字、类型、创建时间、最近使用时间，一格不缺', async () => {
    const st = await mountDevices([twoDevices], () => ({ ok: true }));
    const text = textOf(st.tree);
    assert.match(text, /妈妈那台/);
    assert.match(text, /客厅的旧手机/);
    assert.match(text, /手机/, '类型要写出来（这一版只有手机）');
    assert.match(text, /创建于 2026-10-16 06:20/, '创建时间要说清是哪一刻');
    assert.match(text, /最近使用 2026-10-16 06:25/);
    // 老记录没有这个字段：说「还没有记录」，不许拿创建时间顶上（那是凭空造一次使用）。
    assert.match(text, /最近使用 还没有记录/);
    assert.doesNotMatch(text, /NaN|undefined|Invalid Date/);
  });

  await check('另一台电脑（kind: "desktop"）：类型那格说人话，不是原样打印 desktop', async () => {
    const st = await mountDevices(
      [{ ok: true, devices: [Object.assign({}, DEV_A, { kind: 'desktop' }), DEV_B] }],
      () => ({ ok: true }),
    );
    const text = textOf(devicesBlockOf(st.tree));
    assert.match(text, /另一台电脑/, '跨机配对进来的那台要说人话');
    assert.doesNotMatch(text, /desktop/, '内部的 kind 值不该原样摆到用户眼前');
    assert.match(text, /客厅的旧手机/, '同一张名单里别的设备照旧');
  });

  await check('每台两个动作：「改名」和「撤销」', async () => {
    const st = await mountDevices([twoDevices], () => ({ ok: true }));
    const buttons = byType(devicesBlockOf(st.tree), 'button');
    assert.equal(buttons.filter((b) => textOf(b) === '改名').length, 2);
    assert.equal(buttons.filter((b) => textOf(b) === '撤销').length, 2);
  });

  await check('点「改名」：就地变成输入框，原名字填在里面（不弹窗、不跳页）', async () => {
    const st = await mountDevices([twoDevices], () => ({ ok: true }));
    const first = byType(devicesBlockOf(st.tree), 'button').filter((b) => textOf(b) === '改名')[0];
    first.props.onClick();
    await tick();
    const inputs = byType(devicesBlockOf(st.tree), 'input').filter((n) => n.props.type === 'text');
    assert.equal(inputs.length, 1, '一次只编辑一台');
    assert.equal(inputs[0].props.value, '妈妈那台');
    assert.equal(byType(devicesBlockOf(st.tree), 'button').filter((b) => textOf(b) === '保存').length, 1);
  });

  await check('改完点「保存」：POST 改名那条（带 id 和新名字），然后**重新列一次**', async () => {
    const st = await mountDevices(
      [twoDevices, { ok: true, devices: [Object.assign({}, DEV_A, { name: '新名字' }), DEV_B] }],
      () => ({ ok: true, device: Object.assign({}, DEV_A, { name: '新名字' }) }),
    );
    byType(devicesBlockOf(st.tree), 'button').filter((b) => textOf(b) === '改名')[0].props.onClick();
    await tick();
    const input = byType(devicesBlockOf(st.tree), 'input').filter((n) => n.props.type === 'text')[0];
    input.props.onChange({ target: { value: '新名字' } });
    await tick();
    byType(devicesBlockOf(st.tree), 'button').filter((b) => textOf(b) === '保存')[0].props.onClick();
    await tick();
    await tick();
    assert.deepEqual(st.posts, [{ url: '/mini-remote/devices/rename', body: { id: DEV_A.id, name: '新名字' } }]);
    assert.equal(st.gets.filter((u) => u === '/mini-remote/devices').length, 2,
      '改完必须再列一次：屏幕上那份要来自服务端，不是我们以为改成了什么');
    assert.match(textOf(st.tree), /新名字/);
  });

  await check('点「撤销」**什么都不发**：只把后果摊在那一行下面（说的就是"要重新扫码"）', async () => {
    const st = await mountDevices([twoDevices], () => ({ ok: true }));
    byType(devicesBlockOf(st.tree), 'button').filter((b) => textOf(b) === '撤销')[0].props.onClick();
    await tick();
    assert.deepEqual(st.posts, [], '第一下不许把设备撤掉——一次点击就造成的后果太重了');
    const text = textOf(devicesBlockOf(st.tree));
    assert.match(text, /撤销后，这台设备要重新扫码才能再用。/, '确认框里要说清后果');
    assert.equal(byType(devicesBlockOf(st.tree), 'button').filter((b) => textOf(b) === '确认撤销').length, 1);
    assert.equal(byType(devicesBlockOf(st.tree), 'button').filter((b) => textOf(b) === '取消').length, 1);
  });

  await check('点「确认撤销」才真发：POST 撤销那条，成功之后那一行消失（重新列过）', async () => {
    const st = await mountDevices(
      [twoDevices, { ok: true, devices: [DEV_B] }],
      () => ({ ok: true, id: DEV_A.id, dropped: 1 }),
    );
    byType(devicesBlockOf(st.tree), 'button').filter((b) => textOf(b) === '撤销')[0].props.onClick();
    await tick();
    byType(devicesBlockOf(st.tree), 'button').filter((b) => textOf(b) === '确认撤销')[0].props.onClick();
    await tick();
    await tick();
    assert.deepEqual(st.posts, [{ url: '/mini-remote/devices/revoke', body: { id: DEV_A.id } }]);
    assert.equal(st.gets.filter((u) => u === '/mini-remote/devices').length, 2);
    const text = textOf(devicesBlockOf(st.tree));
    assert.doesNotMatch(text, /妈妈那台/, '撤销掉的那台要从名单上消失');
    assert.match(text, /客厅的旧手机/, '别的设备一样都不许动');
  });

  await check('「取消」之后什么也不发生（那一行还在，弹出来的后果收回去）', async () => {
    const st = await mountDevices([twoDevices], () => ({ ok: true }));
    byType(devicesBlockOf(st.tree), 'button').filter((b) => textOf(b) === '撤销')[0].props.onClick();
    await tick();
    byType(devicesBlockOf(st.tree), 'button').filter((b) => textOf(b) === '取消')[0].props.onClick();
    await tick();
    assert.deepEqual(st.posts, []);
    // 按**按钮**判，不按那句话判：这一块的说明里本来就写着"撤销之后那台设备要重新扫码"
    // （那一句常驻），所以拿文案去查"确认框收起来了没有"是查不出来的。
    const buttons = byType(devicesBlockOf(st.tree), 'button').map(textOf);
    assert.ok(!buttons.includes('确认撤销'), '取消之后不该还留着"确认撤销"');
    assert.equal(buttons.filter((b) => b === '撤销').length, 2, '两台的「撤销」都回到原位');
    assert.match(textOf(devicesBlockOf(st.tree)), /妈妈那台/);
  });

  await check('一台设备都没有时：说清"还没有登记过的设备"，不摊一个空壳', async () => {
    const st = await mountDevices([{ ok: true, devices: [] }], () => ({ ok: true }));
    const block = devicesBlockOf(st.tree);
    assert.ok(block, '这一块本身要在（它是"谁进得来"的账本）');
    assert.match(textOf(block), /还没有登记过的设备/);
  });

  await check('名单读不到时：把那句原因照登出来，不吞', async () => {
    const hh = useHarness();
    let tree = null;
    setGlobal('fetch', async (url, init) => {
      if (init && init.method === 'POST') return jsonResponse(200, { ok: true });
      if (url === '/mini-remote/devices') return jsonResponse(404, { error: 'not found' });
      return jsonResponse(200, PAIRING_OK);
    });
    hh.onUpdate(() => { tree = hh.draw(Comp); });
    tree = hh.draw(Comp);
    hh.runEffects();
    await tick();
    hh.runEffects();
    await tick();
    assert.match(textOf(tree), /读设备名单失败/, '读不到要说出来，不能假装"一台都没有"');
  });

  await check('动作失败时：服务端那句原因原样摆在那一块里（不谎报成功）', async () => {
    const st = await mountDevices(
      [twoDevices],
      () => ({ ok: false, error: '这台设备已经不在名册里了，刷新看看。' }),
    );
    byType(devicesBlockOf(st.tree), 'button').filter((b) => textOf(b) === '撤销')[0].props.onClick();
    await tick();
    byType(devicesBlockOf(st.tree), 'button').filter((b) => textOf(b) === '确认撤销')[0].props.onClick();
    await tick();
    await tick();
    assert.match(textOf(devicesBlockOf(st.tree)), /已经不在名册里了/);
  });
}

// 4g. 「允许别的电脑连接」那一节（2026-10-16 跨机第二步）
{
  console.log('\n[4g] 允许别的电脑连接（跨机那个开关）');

  // 这一节的 payload。**故意不给 tunnel / serve / feishu**：别的块多一个复选框，
  // 下面按顺序取第一个就会抓错——少给几块，这里就只剩跨机这一个（照 4e 那条）。
  const withRemote = (remote, extra) => Object.assign({
    ok: true,
    port: 3090,
    token: TOKEN,
    entries: [{ kind: 'lan', label: '内网', hint: '手机连同一个 Wi-Fi 时用这个', url: URL_LAN, qr: QR }],
    tunnel: null,
    serve: null,
    feishu: null,
    remote,
  }, extra || {});

  let tree = null;
  let posted = [];
  let postReply = null;
  let infoReply = null;
  const h = useHarness();
  h.onUpdate(() => { tree = h.draw(Comp); });

  const mount = async (payload) => {
    posted = [];
    infoReply = payload;
    setGlobal('fetch', async (url, init) => {
      if (init && init.method === 'POST') {
        posted.push({ url, body: JSON.parse(init.body) });
        // 服务端回的仍是整份配对信息（真机就是这样的）：开关那一格按这次请求翻转。
        return jsonResponse(200, withRemote(
          { allowed: JSON.parse(init.body).enabled },
          { devices: [] },
        ));
      }
      if (url === '/mini-remote/devices') return jsonResponse(200, { ok: true, devices: [] });
      return jsonResponse(200, postReply ?? infoReply);
    });
    postReply = null;
    tree = h.draw(Comp);
    h.runEffects();
    await tick();
    return tree;
  };

  /** 这一块的渲染树。**按 key 找**（上面还有二维码、密码那几块，位置会变）。 */
  const remoteBlockOf = (t) => walk(t).find((n) => n && n.props && n.props.key === 'remote');

  await check('默认关：开关未选中，并说清"连配对也不受理"', async () => {
    await mount(withRemote({ allowed: false }));
    const block = remoteBlockOf(tree);
    assert.ok(block, '这一块要出现（服务端给了 remote 就有得渲染）');
    const boxes = byType(block, 'input').filter((n) => n.props.type === 'checkbox');
    assert.equal(boxes.length, 1, '就一个开关');
    assert.equal(boxes[0].props.checked, false, '默认是关的');
    const text = textOf(block);
    assert.match(text, /允许别的电脑连接/);
    assert.match(text, /没开（默认）/, '要写明这是默认状态');
    assert.match(text, /连配对也不受理/, '"关"是一个整体状态，得说清它关的是什么');
  });

  await check('开着时：选中，并且把那句风险摆出来（那台电脑拿到的是完整界面）', async () => {
    await mount(withRemote({ allowed: true }));
    const block = remoteBlockOf(tree);
    const boxes = byType(block, 'input').filter((n) => n.props.type === 'checkbox');
    assert.equal(boxes[0].props.checked, true);
    const text = textOf(block);
    assert.match(text, /完整界面/, '用户很可能以为"只是看个窗口"，这一句必须说出来');
    assert.match(text, /只给你信得过的电脑开/);
    assert.match(text, /名单里把它撤销/, '关掉的办法要指到下面那份名单上');
  });

  await check('点开关 → POST /mini-remote/remote-access，body 是 {enabled}', async () => {
    await mount(withRemote({ allowed: false }));
    const box = byType(remoteBlockOf(tree), 'input').filter((n) => n.props.type === 'checkbox')[0];
    box.props.onChange({ target: { checked: true } });
    await tick();
    assert.deepEqual(posted, [{ url: '/mini-remote/remote-access', body: { enabled: true } }],
      '存的是这一个开关，地址和 body 都写死在这里');
    // 服务端回的那一份说了算：界面不许自己先把开关画成开着的
    const after = byType(remoteBlockOf(tree), 'input').filter((n) => n.props.type === 'checkbox')[0];
    assert.equal(after.props.checked, true, '存完拿服务端那份刷新');
  });

  await check('服务端没给 remote 字段时：整块不出现（不摆一个空壳）', async () => {
    const payload = withRemote(undefined);
    delete payload.remote;
    await mount(payload);
    assert.equal(remoteBlockOf(tree), undefined, '没有这一格就不画这一块');
  });

  await check('它排在设备名单前面（同一件事的两半：许不许连 / 已经连了谁）', async () => {
    await mount(withRemote({ allowed: false }));
    // 名单要等配对信息到了之后才拉，所以再来一轮（照 4f 那个夹具）
    h.runEffects();
    await tick();
    const nodes = walk(tree);
    const at = (key) => nodes.findIndex((n) => n && n.props && n.props.key === key);
    assert.ok(at('remote') >= 0, '总开关要在');
    assert.ok(at('devices') >= 0, '设备名单也要在');
    assert.ok(at('remote') < at('devices'), '总开关要排在名单前面');
  });
}

// 4h. 「其他电脑」那一块（2026-10-16 跨机第三步的界面）：列出 / 添加 / 打开那一屏 / 断开
{
  console.log('\n[4h] 其他电脑（列出 / 添加 / 打开那一屏 / 断开）');

  const ISO2 = '2026-10-16T07:05:00+08:00';
  const FAR = {
    id: 'f'.repeat(32),
    name: '书房那台',
    baseUrl: 'http://192.168.1.9:19387',
    addedAt: new Date(ISO2).getTime(),
    lastOk: new Date(ISO2).getTime() + 3 * 60 * 1000,
  };
  // 老记录没有 lastOk（刚加进来还没换过票）：界面上说「还没有记录」，**不许编一个时间**。
  const OLD = {
    id: 'e'.repeat(32), name: '', baseUrl: 'http://100.92.105.99:19387',
    addedAt: new Date(ISO2).getTime(), lastOk: 0,
  };
  /** 宿主换回来的那条地址（真机上是 `http://<对面>/mini/mirror/?ticket=…`）。 */
  const REMOTE_TICKET = 'http://192.168.1.9:19387/mini/mirror/?ticket=one-shot-remote';
  const LOCAL_TICKET = 'http://127.0.0.1:3090/mini/mirror/?ticket=one-shot-local';
  /** 宿主把对面的 401 翻成 502 之后带回来的那句话（lib/index.js 的 REMOTE_REVOKED_HINT）。 */
  const REVOKED_HINT = '那台电脑已经不认这枚凭据了——多半是它那边把这条记录撤销了。\n'
    + '要重新连，得拿那台电脑的口令在这儿重新添加一次。';

  const PAIRING_SIMPLE = {
    ok: true,
    port: 3090,
    token: TOKEN,
    entries: [{ kind: 'lan', label: '内网', hint: '手机连同一个 Wi-Fi 时用这个', url: URL_LAN, qr: QR }],
    tunnel: null,
  };

  // 「整屏显示别的电脑」要两样东西：官方布局服务的把手（`ctx.layout.selectPanel`）和设置页
  // 外壳递进来的 `close`（真机上是 `renderSlot("settings.section", { close })`）。照真机搭。
  const layoutCalls = [];
  let closedSettings = 0;
  const docListeners = [];
  setGlobal('document', {
    addEventListener: (type, fn) => { docListeners.push({ type, fn }); },
    removeEventListener: () => {},
  });
  const fakeLayout = {
    selectPanel: (id) => { layoutCalls.push(id); },
    panelInfo: {
      getSnapshot: () => ({ activePanelId: 'conversation' }),
      subscribe: () => () => {},
    },
  };
  mod.apply({
    // `ctx.inject` 递进来的是一个 scope（真机上它带 effect）：照它给 layout 和 effect。
    inject: (names, callback) => callback({
      layout: fakeLayout,
      effect: (fn) => { const off = fn(); return () => { if (typeof off === 'function') off(); }; },
    }),
    effect: (fn) => { const off = fn(); return () => { if (typeof off === 'function') off(); }; },
    slots: { inject: (name, callback) => callback(), register: () => () => {} },
  });
  const settingsProps = { close: () => { closedSettings += 1; } };

  /**
   * 把一轮「点击 → 发请求 → 回执 → 重画」走完。
   *
   * 一次 `tick()`（setImmediate）会把这之前排着的微任务排干，但这一条链子有五六跳
   * （fetch → json → 认回执 → 存状态 → 通知 → 重画），两跳经常只走到一半——那样断言
   * 看到的是**上一轮**的结果，测试会莫名其妙地"差一条"。多走几步最省事。
   */
  const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

  /**
   * 挂一次这一节：`GET /mini-remote/remotes` 依次回 `listReplies`，POST 交给 `actionReply`
   * （`{ url, body, n }` → 响应；给 `jsonResponse(...)` 原样用，给普通对象当 200 的回执；
   * 返回 rejected promise 就是"网络层失败"）。
   */
  const mountRemotes = async (listReplies, actionReply) => {
    const hh = useHarness();
    const state = { gets: [], posts: [], tree: null, harness: hh };
    let listAt = 0;
    setGlobal('fetch', async (url, init) => {
      if (init && init.method === 'POST') {
        const body = JSON.parse(init.body || '{}');
        state.posts.push({ url, body });
        const rep = await Promise.resolve(actionReply({ url, body, n: state.posts.length }));
        return (rep && typeof rep.json === 'function') ? rep : jsonResponse(200, rep);
      }
      state.gets.push(url);
      if (url === '/mini-remote/remotes') {
        const reply = listReplies[Math.min(listAt, listReplies.length - 1)];
        listAt += 1;
        return jsonResponse(reply.status, reply.body);
      }
      if (url === '/mini-remote/devices') return jsonResponse(200, { ok: true, devices: [] });
      return jsonResponse(200, PAIRING_SIMPLE);
    });
    hh.onUpdate(() => { state.tree = hh.draw(Comp, settingsProps); });
    state.tree = hh.draw(Comp, settingsProps);
    hh.runEffects();   // 读配对信息
    await tick();
    hh.runEffects();   // 配对信息到了 → 读设备名单 + 读「其他电脑」
    await tick();
    return state;
  };

  /** 这一块的渲染树。**按 key 找**（上面还有二维码、密码、设备那几块，位置会变）。 */
  const remotesBlockOf = (tree) => walk(tree).find((n) => n && n.props && n.props.key === 'remotes');
  /** 某台电脑那一行。**按它的 id 找**（行自己的 key 就是 id），不按位置也不按名字。 */
  const rowOf = (tree, id) => walk(remotesBlockOf(tree)).find((n) => n && n.props && n.props.key === id);
  const buttonIn = (node, label) => byType(node, 'button').find((b) => textOf(b) === label);
  /**
   * 那一整屏（main 槽里那个面板）单独拉一次，看它画了什么。
   *
   * 返回的是一个**可变的盒子**：重画之后 `box.tree` 跟着变。（`const { tree } =` 解构出来的
   * 是点之前那一棵树，点完再去读它就会读到旧的——这个坑已经踩过一次。）
   */
  const drawPanel = async () => {
    const hh = useHarness();
    const box = { tree: null, harness: hh };
    hh.onUpdate(() => { box.tree = hh.draw(entryOf('main').Comp); });
    box.tree = hh.draw(entryOf('main').Comp);
    hh.runEffects();
    await settlePanel();
    return box;
  };
  const listOf = (remotes) => [{ status: 200, body: { ok: true, remotes: remotes } }];
  const fresh = () => { layoutCalls.length = 0; closedSettings = 0; };

  await check('名单到了就摆出来：名字、地址、最近成功时间，一格不缺', async () => {
    const st = await mountRemotes(listOf([FAR, OLD]), () => ({ ok: true }));
    const text = textOf(remotesBlockOf(st.tree));
    assert.match(text, /书房那台/);
    assert.match(text, /http:\/\/192\.168\.1\.9:19387/, '地址要摆出来（用户要拿它和对面核对）');
    assert.match(text, /最近成功 2026-10-16 07:08/, '要说清"最近一次成功"是哪一刻');
    assert.match(text, /最近成功 还没有记录/, '没成功过就说还没有记录，不编一个时间');
    assert.match(text, /（这台电脑没有名字）/, '名字空着（用地址当名字时也可能为空）也要有个说法');
    assert.doesNotMatch(text, /NaN|undefined|Invalid Date/);
    st.harness.unmount();
  });

  await check('每台两个动作：「重连」和「断开」（就是用户要的那两个）', async () => {
    const st = await mountRemotes(listOf([FAR]), () => ({ ok: true }));
    assert.deepEqual(byType(rowOf(st.tree, FAR.id), 'button').map(textOf), ['重连', '断开']);
    st.harness.unmount();
  });

  await check('点「重连」→ POST /mini-remote/remotes/window（带上那一台的 id）', async () => {
    fresh();
    const st = await mountRemotes(listOf([FAR]), () => ({ ok: true, url: REMOTE_TICKET, expiresIn: 30 }));
    buttonIn(rowOf(st.tree, FAR.id), '重连').props.onClick();
    await settle();
    assert.deepEqual(st.posts, [{ url: '/mini-remote/remotes/window', body: { id: FAR.id } }],
      '「重连」= 再取一次票，地址和 body 都写死在这里');
    st.harness.unmount();
  });

  await check('取到票就把"那一整屏"打开：切到远程窗口 + **关掉设置页**', async () => {
    fresh();
    const st = await mountRemotes(listOf([FAR]), () => ({ ok: true, url: REMOTE_TICKET, expiresIn: 30 }));
    buttonIn(rowOf(st.tree, FAR.id), '重连').props.onClick();
    await settle();
    assert.deepEqual(layoutCalls, ['mini-remote'], '要切到 main 槽里我们那个 key');
    assert.equal(closedSettings, 1,
      '设置页是盖在界面上的浮层：不关掉它，切过去的那一屏还在它后面，用户看到的是"点了没反应"');
    st.harness.unmount();
  });

  await check('点那一行本身也算（不用非得点「重连」）；点在按钮上则不算', async () => {
    fresh();
    const st = await mountRemotes(listOf([FAR]), () => ({ ok: true, url: REMOTE_TICKET, expiresIn: 30 }));
    // 点在行里的按钮上：那是「断开」那一片，不该顺手去取票。
    rowOf(st.tree, FAR.id).props.onClick({ target: { closest: () => ({}) } });
    await settle();
    assert.deepEqual(st.posts, [], '点在按钮上不算"点这一行"');
    // 点在行的空白处（target 不是一个按钮）：走取票那一条。
    rowOf(st.tree, FAR.id).props.onClick({ target: { closest: () => null } });
    await settle();
    assert.equal(st.posts.length, 1);
    assert.equal(st.posts[0].url, '/mini-remote/remotes/window');
    st.harness.unmount();
  });

  await check('那一屏：把票的地址交给框，而且**不去要本机那张票**', async () => {
    fresh();
    const st = await mountRemotes(listOf([FAR]), ({ url }) => (url === '/mini-remote/window'
      ? { ok: true, url: LOCAL_TICKET, expiresIn: 30 }
      : { ok: true, url: REMOTE_TICKET, expiresIn: 30 }));
    buttonIn(rowOf(st.tree, FAR.id), '重连').props.onClick();
    await settle();
    const p = await drawPanel();
    const iframe = byType(p.tree, 'iframe')[0];
    assert.ok(iframe, '票到手了就该把框立起来');
    assert.equal(iframe.props.src, REMOTE_TICKET);
    assert.doesNotMatch(iframe.props.src, /[?&]token=/,
      '框的地址里**不许出现令牌**——那会留在打开这台电脑的人的浏览历史里');
    assert.ok(!st.posts.some((one) => one.url === '/mini-remote/window'),
      '选了别的电脑就不该再去要本机那一张票（那会白换一张，本机拿不出界面时还会平白报错）');
    p.harness.unmount();
    st.harness.unmount();
  });

  await check('票不新鲜时那一屏自己现换一张（**不拿一张过期的票去开一片空白**）', async () => {
    fresh();
    const st = await mountRemotes(listOf([FAR]), ({ url }) => (url === '/mini-remote/remotes/window'
      ? { ok: true, url: REMOTE_TICKET, expiresIn: 0 }   // expiresIn 0 = 手上这张立刻算过期
      : { ok: true, url: LOCAL_TICKET, expiresIn: 30 }));
    buttonIn(rowOf(st.tree, FAR.id), '重连').props.onClick();
    await settle();
    assert.equal(st.posts.length, 1);
    const p = await drawPanel();
    assert.equal(byType(p.tree, 'iframe').length, 0, '过期的那张票一个框都不许立');
    assert.match(textOf(p.tree), /正在向那台电脑换一张通行证…/, '正在换票时要说出来（这句有终点，不是转圈）');
    assert.equal(st.posts.length, 2, '面板自己现换了一张');
    assert.deepEqual(st.posts[1].body, { id: FAR.id });
    p.harness.unmount();
    st.harness.unmount();
  });

  await check('被对面撤销了：那一行写成「这台电脑已经被对方撤销了，要重新配对」+ 宿主原话', async () => {
    fresh();
    const st = await mountRemotes(listOf([FAR]), () => jsonResponse(502, { ok: false, error: REVOKED_HINT }));
    buttonIn(rowOf(st.tree, FAR.id), '重连').props.onClick();
    await settle();
    const text = textOf(rowOf(st.tree, FAR.id));
    assert.match(text, /这台电脑已经被对方撤销了，要重新配对/,
      '用户下一步该做的是重新配对，这一行必须这么说');
    assert.match(text, /已经不认这枚凭据/, '宿主那两行原话照登（里面写着拿口令重新添加）');
    assert.doesNotMatch(text, /正在向那台电脑换一张通行证|取票中/,
      '**不能停在"取票中"**——那就是"转不完的圈"（前车之鉴：502 让外壳永远停在 Loading plugins…）');
    assert.equal(layoutCalls.length, 0, '票没换到就别把人送到那一屏去');
    assert.equal(closedSettings, 0, '票没换到，设置页不许关（那句话得让人看得见）');
    st.harness.unmount();
  });

  await check('别的 502（对面没开那个开关）：照原话，**不许**说成"被撤销了"', async () => {
    fresh();
    const said = '那台电脑说：这台电脑没有允许别的电脑连接。要连的话，先在这台电脑的设置里打开「允许别的电脑连接」。';
    const st = await mountRemotes(listOf([FAR]), () => jsonResponse(502, { ok: false, error: said }));
    buttonIn(rowOf(st.tree, FAR.id), '重连').props.onClick();
    await settle();
    const text = textOf(rowOf(st.tree, FAR.id));
    assert.match(text, /没有允许别的电脑连接/, '宿主写好的那句话原样转述');
    assert.doesNotMatch(text, /已经被对方撤销了/, '别的错不能被认成"对面撤销了"——那会让人白配一次对');
    st.harness.unmount();
  });

  await check('连不上那台电脑：也要有一句人话（不是空白，也不是一直转）', async () => {
    fresh();
    const st = await mountRemotes(listOf([FAR]), () => Promise.reject(new Error('fetch failed')));
    buttonIn(rowOf(st.tree, FAR.id), '重连').props.onClick();
    await settle();
    const text = textOf(rowOf(st.tree, FAR.id));
    assert.match(text, /连不上这台电脑上的遥控服务/);
    assert.doesNotMatch(text, /正在向那台电脑换一张通行证|取票中/);
    st.harness.unmount();
  });

  await check('那一屏没开成时：**一句人话 + 一个「再试一次」**，不是空白框', async () => {
    fresh();
    // 前两次取票都失败（设置页点的那一次 + 那一屏自己进去时试的那一次），第三次才换成。
    const st = await mountRemotes(listOf([FAR]), ({ n }) => (n <= 2
      ? jsonResponse(502, { ok: false, error: REVOKED_HINT })
      : { ok: true, url: REMOTE_TICKET, expiresIn: 30 }));
    buttonIn(rowOf(st.tree, FAR.id), '重连').props.onClick();
    await settle();
    const p = await drawPanel();
    assert.match(textOf(p.tree), /这台电脑已经被对方撤销了，要重新配对/);
    assert.match(textOf(p.tree), /已经不认这枚凭据/);
    assert.match(textOf(p.tree), /再试一次/, '要给人一个下一步');
    assert.equal(byType(p.tree, 'iframe').length, 0, '没换到票就别立框');
    buttonIn(p.tree, '再试一次').props.onClick();
    await settle();
    assert.equal(st.posts.length, 3, '「再试一次」就是再取一次票');
    assert.equal(byType(p.tree, 'iframe')[0].props.src, REMOTE_TICKET, '这次换到了，框就立起来');
    p.harness.unmount();
    st.harness.unmount();
  });

  await check('换另一台失败时，那一屏**不许**接着放上一台的界面', async () => {
    fresh();
    const B = Object.assign({}, FAR, { id: 'b'.repeat(32), name: '客厅那台' });
    const st = await mountRemotes(listOf([FAR, B]), ({ body }) => (body.id === FAR.id
      ? { ok: true, url: REMOTE_TICKET, expiresIn: 30 }
      : jsonResponse(502, { ok: false, error: '连不上那台电脑' })));
    buttonIn(rowOf(st.tree, FAR.id), '重连').props.onClick();
    await settle();
    buttonIn(rowOf(st.tree, B.id), '重连').props.onClick();
    await settle();
    const p = await drawPanel();
    assert.equal(byType(p.tree, 'iframe').length, 0,
      '刚点的那台没换成票，屏幕上出现上一台的界面是最坏的一种错（用户不知道自己在看谁）');
    assert.match(textOf(p.tree), /连不上那台电脑/);
    p.harness.unmount();
    st.harness.unmount();
  });

  await check('点「断开」**什么都不发**：只把后果摊在那一行下面（说清对面还留着）', async () => {
    fresh();
    const st = await mountRemotes(listOf([FAR]), () => ({ ok: true }));
    buttonIn(rowOf(st.tree, FAR.id), '断开').props.onClick();
    await settle();
    assert.deepEqual(st.posts, [], '第一下不许真断开');
    const text = textOf(rowOf(st.tree, FAR.id));
    assert.match(text, /断开之后，这台电脑就不再连它了/);
    assert.match(text, /对面那台电脑上还留着/, '断开的语义是"这台电脑不管它了"，不是"收回了对面的权限"');
    assert.ok(buttonIn(rowOf(st.tree, FAR.id), '确认断开'));
    assert.ok(buttonIn(rowOf(st.tree, FAR.id), '取消'));
    st.harness.unmount();
  });

  await check('点「取消」：那一行回到原样，断开没发生', async () => {
    fresh();
    const st = await mountRemotes(listOf([FAR]), () => ({ ok: true }));
    buttonIn(rowOf(st.tree, FAR.id), '断开').props.onClick();
    await settle();
    buttonIn(rowOf(st.tree, FAR.id), '取消').props.onClick();
    await settle();
    assert.deepEqual(st.posts, []);
    assert.ok(!buttonIn(rowOf(st.tree, FAR.id), '确认断开'));
    assert.match(textOf(rowOf(st.tree, FAR.id)), /书房那台/);
    st.harness.unmount();
  });

  await check('点「确认断开」才真发：POST 断开那条，成功之后重列名单 + 把宿主那句话摆出来', async () => {
    fresh();
    const NOTE = '已经从这台电脑的列表里移除了，本地存的那枚凭据也一起删了。\n'
      + '那台电脑上还留着「这台电脑」那条记录——要彻底收回，得去它的「手机遥控」设置页里撤销那一台。';
    const st = await mountRemotes(
      [listOf([FAR])[0], { status: 200, body: { ok: true, remotes: [] } }],
      ({ url }) => (url === '/mini-remote/remotes/forget' ? { ok: true, id: FAR.id, note: NOTE } : { ok: true }),
    );
    buttonIn(rowOf(st.tree, FAR.id), '断开').props.onClick();
    await settle();
    buttonIn(rowOf(st.tree, FAR.id), '确认断开').props.onClick();
    await settle();
    assert.deepEqual(st.posts, [{ url: '/mini-remote/remotes/forget', body: { id: FAR.id } }]);
    assert.equal(st.gets.filter((u) => u === '/mini-remote/remotes').length, 2,
      '断完必须再列一次：屏幕上那份要来自服务端');
    const text = textOf(remotesBlockOf(st.tree));
    assert.doesNotMatch(text, /书房那台/, '断开的那台要从名单上消失');
    assert.match(text, /这台电脑还没连过别的电脑/);
    assert.match(text, /要彻底收回，得去它的「手机遥控」设置页里撤销那一台/,
      '宿主那句"对面还留着"要原样摆出来（最容易留下的误会）');
    st.harness.unmount();
  });

  await check('点「添加一台电脑」：摊开两个输入框（地址、口令）+ 一个可选的名字', async () => {
    fresh();
    const st = await mountRemotes(listOf([]), () => ({ ok: true }));
    buttonIn(remotesBlockOf(st.tree), '添加一台电脑').props.onClick();
    await settle();
    const inputs = byType(remotesBlockOf(st.tree), 'input');
    assert.equal(inputs.length, 3, '地址 + 口令 + 名字（名字可留空）');
    assert.deepEqual(inputs.map((n) => n.props.type), ['text', 'password', 'text'],
      '口令那一格必须打码');
    assert.ok(buttonIn(remotesBlockOf(st.tree), '确认添加'));
    st.harness.unmount();
  });

  await check('框空着点「确认添加」：当场说清，一个请求都不发', async () => {
    fresh();
    const st = await mountRemotes(listOf([]), () => ({ ok: true }));
    buttonIn(remotesBlockOf(st.tree), '添加一台电脑').props.onClick();
    await settle();
    buttonIn(remotesBlockOf(st.tree), '确认添加').props.onClick();
    await settle();
    assert.deepEqual(st.posts, []);
    assert.match(textOf(remotesBlockOf(st.tree)), /要填那台电脑的地址/);
    // 只填地址、口令空着：也要当场说清（口令是这一步唯一必须要的东西）。
    let inputs = byType(remotesBlockOf(st.tree), 'input');
    inputs[0].props.onChange({ target: { value: 'http://192.168.1.9:19387' } });
    await settle();
    buttonIn(remotesBlockOf(st.tree), '确认添加').props.onClick();
    await settle();
    assert.deepEqual(st.posts, []);
    assert.match(textOf(remotesBlockOf(st.tree)), /要填那台电脑的口令/);
    inputs = byType(remotesBlockOf(st.tree), 'input');
    assert.equal(inputs[0].props.value, 'http://192.168.1.9:19387', '当场说清之后，用户打的字还在');
    st.harness.unmount();
  });

  await check('填好点「确认添加」（**一次确认**）→ POST 添加那条，成功之后重列名单、收起表单', async () => {
    fresh();
    const st = await mountRemotes(
      [{ status: 200, body: { ok: true, remotes: [] } }, { status: 200, body: { ok: true, remotes: [FAR] } }],
      () => ({ ok: true, remote: FAR }),
    );
    buttonIn(remotesBlockOf(st.tree), '添加一台电脑').props.onClick();
    await settle();
    let inputs = byType(remotesBlockOf(st.tree), 'input');
    inputs[0].props.onChange({ target: { value: 'http://192.168.1.9:19387' } });
    await settle();
    inputs = byType(remotesBlockOf(st.tree), 'input');
    inputs[1].props.onChange({ target: { value: TOKEN } });
    await settle();
    inputs = byType(remotesBlockOf(st.tree), 'input');
    inputs[2].props.onChange({ target: { value: '书房那台' } });
    await settle();
    buttonIn(remotesBlockOf(st.tree), '确认添加').props.onClick();
    await settle();
    assert.deepEqual(st.posts, [{
      url: '/mini-remote/remotes/add',
      body: { name: '书房那台', baseUrl: 'http://192.168.1.9:19387', token: TOKEN },
    }]);
    assert.equal(st.gets.filter((u) => u === '/mini-remote/remotes').length, 2);
    assert.match(textOf(remotesBlockOf(st.tree)), /书房那台/, '加完那一台就在名单上');
    assert.ok(!buttonIn(remotesBlockOf(st.tree), '确认添加'), '加完表单收起来');
    st.harness.unmount();
  });

  await check('添加失败时：把对面那句话原样摆出来，而且**表单还开着**（不丢用户打的字）', async () => {
    fresh();
    const st = await mountRemotes(listOf([]), () => jsonResponse(502, { ok: false, error: '那台电脑说：口令不对。' }));
    buttonIn(remotesBlockOf(st.tree), '添加一台电脑').props.onClick();
    await settle();
    let inputs = byType(remotesBlockOf(st.tree), 'input');
    inputs[0].props.onChange({ target: { value: 'http://192.168.1.9:19387' } });
    await settle();
    inputs = byType(remotesBlockOf(st.tree), 'input');
    inputs[1].props.onChange({ target: { value: '错的口令' } });
    await settle();
    buttonIn(remotesBlockOf(st.tree), '确认添加').props.onClick();
    await settle();
    const text = textOf(remotesBlockOf(st.tree));
    assert.match(text, /口令不对/, '失败要说清是谁说的哪一句');
    const after = byType(remotesBlockOf(st.tree), 'input');
    assert.equal(after.length, 3, '失败之后表单不许自己收起来——用户打的那些字还在里面');
    assert.equal(after[0].props.value, 'http://192.168.1.9:19387');
    st.harness.unmount();
  });

  await check('名单读不到时：把那句原因照登出来，不说成"还没连过别的电脑"', async () => {
    fresh();
    const st = await mountRemotes([{ status: 404, body: { ok: false, error: 'not found' } }], () => ({ ok: true }));
    const text = textOf(remotesBlockOf(st.tree));
    assert.match(text, /读「其他电脑」名单失败/);
    assert.match(text, /重启一次 DSH 再试/, '接口都没有（宿主是旧版）时，下一步只有一句话：重启');
    assert.doesNotMatch(text, /这台电脑还没连过别的电脑/, '读不到 ≠ 一台都没有');
    st.harness.unmount();
  });

  await check('再点一下侧栏那一条：在某一台的界面里 → 退回**名单**（还在这一屏里）；名单上再点 → 退出', async () => {
    fresh();
    const st = await mountRemotes(listOf([FAR]), () => ({ ok: true, url: REMOTE_TICKET, expiresIn: 30 }));
    buttonIn(rowOf(st.tree, FAR.id), '重连').props.onClick();
    await settle();
    const onDocClick = docListeners.filter((one) => one.type === 'click').pop();
    assert.ok(onDocClick, '「再点一下」那一下要挂上');
    fakeLayout.panelInfo.getSnapshot = () => ({ activePanelId: 'mini-remote' });

    // ① 人在**某一台的界面**里：这一下是退回名单，**不许**把人送出这一屏。
    const onScreen = await drawPanel();
    assert.ok(byType(onScreen.tree, 'iframe'), '先确认人在那一台的界面里');
    const atPanel = layoutCalls.length;   // 上面设置页那一下已经切过面板了，从这儿往后数
    onDocClick.fn({
      target: { closest: () => ({ querySelector: () => ({}) }) },
      stopPropagation: () => {},
    });
    assert.equal(layoutCalls.length, atPanel, '这一下只上一层：不许切面板');
    const onList = await drawPanel();
    assert.equal(byType(onList.tree, 'iframe').length, 0, '退回名单就不该还嵌着那一台');
    assert.match(textOf(onList.tree), /书房那台/, '退回的是名单那一层');
    onScreen.harness.unmount();
    onList.harness.unmount();

    // ② 人已经站在**名单**上：这一下才是退出（回到进来之前那一屏）。
    onDocClick.fn({
      target: { closest: () => ({ querySelector: () => ({}) }) },
      stopPropagation: () => {},
    });
    assert.deepEqual(layoutCalls.slice(-1), ['conversation'],
      '退出要回到进来之前那一屏（进来之前是会话）');
    // 放下之后：再点开看到的是**名单**（不是刚才那一台，也不再是本机那一屏）。
    const box = await drawPanel();
    assert.equal(byType(box.tree, 'iframe').length, 0, '退出之后那一趟放下了：点开是名单');
    assert.match(textOf(box.tree), /书房那台/);
    box.harness.unmount();
    st.harness.unmount();
    fakeLayout.panelInfo.getSnapshot = () => ({ activePanelId: 'conversation' });
  });
}

// ---------------------------------------------------------------- 结果

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length) {
  for (const { label, err } of failures) console.log(`  ✗ ${label}: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
}
