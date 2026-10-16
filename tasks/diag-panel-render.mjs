// 运行时排障：用**真实通道清单**（22 条）喂给真实 client.js，完整渲染后把三个下拉的
// option 实际内容打出来。目的：定位「面板显示不可用：-」到底是
//   ① 通道清单没到客户端（channels 为空 → 全部走 pinned 兜底）
//   ② 还是清单到了但 id 对不上（缺条目兜底）
// 用法：node tasks/diag-panel-render.mjs
import { createDispatcher } from '../dispatch/core/dispatch-core.mjs';

const ROOT = 'F:/My Code/dsh-dispatch';
const d = createDispatcher({
  runnerPath: `${ROOT}/collab-kit/zcode-run.mjs`,
  opencodeRunnerPath: `${ROOT}/collab-kit/opencode-run.mjs`,
  runnerCwd: 'F:/My Code/keysion dac vue',
  workRoot: `${ROOT}/dispatch/.data`,
});
const real = await d.listChannels();
console.log(`真实清单：${real.channels.length} 条`);

/* ---------------- 浏览器桩 ---------------- */
const head = { children: [], appendChild(c) { head.children.push(c); return c; }, removeChild(c) { head.children = head.children.filter((x) => x !== c); return c; } };
globalThis.document = {
  head, documentElement: { appendChild: () => {} },
  createElement: (t) => (t === 'style'
    ? { tagName: 'STYLE', attrs: {}, isConnected: true, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, textContent: '' }
    : { tagName: String(t).toUpperCase(), attrs: {}, setAttribute() {}, appendChild() {} }),
  getElementById: () => null, querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {},
};
const lsStore = new Map();
globalThis.localStorage = { getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, String(v)), removeItem: (k) => lsStore.delete(k) };

/* **模式开关**：模拟"挂载时 channels() 失败"（真机事故现场）—— 但 snapshot 带 channels。
 * 期望：面板不再永久残废，靠快照兜底把 22 条通道渲染出来。 */
const MODE = process.argv[2] ?? 'ok'; // ok | fail-channels
const CHANNEL_STATE = { provider: 'opencode/deepseek-v4.1-flash-free', model: null, reasoningLevel: 'agent' };
const calls = [];
globalThis.window = {
  __ModuleLoader__: { load: () => {} },
  __dispatchDemo: {
    getSnapshot: () => {
      calls.push('snapshot');
      return {
        generatedAt: 'x', counts: { running: 0, queued: 0 }, jobs: [], locks: {}, queue: [],
        channels: MODE === 'fail-channels' ? real.channels : undefined, // 快照兜底路径
        switch: { enabled: true },
      };
    },
    getQuota: () => null,
    channels: async () => {
      calls.push('channels');
      if (MODE === 'fail-channels') return { ok: false, error: '模拟：channels() 首次调用失败' };
      return { ok: true, channels: real.channels, warnings: real.warnings };
    },
    channel: async () => { calls.push('channel'); return { ok: true, channel: CHANNEL_STATE }; },
    fallback: async () => { calls.push('fallback'); return { ok: true, enabled: true, chain: ['opencode/glm-5.3-flash-free'], targets: [{ provider: 'opencode/glm-5.3-flash-free', model: null, reasoningLevel: 'agent' }], target: { provider: 'opencode/glm-5.3-flash-free', model: null, reasoningLevel: 'agent' } }; },
  },
  localStorage: globalThis.localStorage, innerHeight: 900, innerWidth: 1200,
  addEventListener: () => {}, removeEventListener: () => {},
};

let cur = null; let pendingEffects = [];
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  Fragment: 'Fragment',
  Component: class { constructor(p) { this.props = p ?? {}; this.state = {}; } setState(n) { this.state = { ...this.state, ...(typeof n === 'function' ? n(this.state) : n) }; } },
  useState: (v) => { const c = cur.cells; const i = cur.idx++; if (c[i] === undefined) c[i] = typeof v === 'function' ? v() : v; return [c[i], (nv) => { c[i] = typeof nv === 'function' ? nv(c[i]) : nv; }]; },
  useEffect: (fn) => { const i = cur.idx++; if (!cur.effects.has(i)) { cur.effects.set(i, true); pendingEffects.push(fn); } },
  useLayoutEffect: (fn) => { const i = cur.idx++; if (!cur.effects.has(i)) { cur.effects.set(i, true); pendingEffects.push(fn); } },
  useRef: (v) => { const i = cur.idx++; if (!(i in cur.cells)) cur.cells[i] = { current: v }; return cur.cells[i]; },
  useCallback: (f) => f, useMemo: (f) => (typeof f === 'function' ? f() : f), useSyncExternalStore: () => undefined,
};
const cellStore = new Map();
const expand = (node, path) => {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n, i) => expand(n, `${path}.${i}`));
  const kids = (node.children ?? []).map((c, i) => expand(c, `${path}.${i}`));
  const type = node.type;
  const props = { ...node.props, children: kids.length <= 1 ? kids[0] : kids };
  if (typeof type === 'function' && type.prototype && typeof type.prototype.render === 'function') {
    const inst = new type(props); inst.props = props; return expand(inst.render(), `${path}~${type.name}`);
  }
  if (typeof type === 'function') {
    const key = `${path}~${type.name || 'anon'}`;
    if (!cellStore.has(key)) cellStore.set(key, { cells: [], deps: new Map(), effects: new Map() });
    const prev = cur; cur = cellStore.get(key); cur.idx = 0;
    let out; try { out = type(props); } finally { cur = prev; }
    return expand(out, key);
  }
  return { ...node, children: kids };
};
const regs = [];
const mod = await import(new URL('../dispatch/client.js', import.meta.url).href);
void mod;
let captured = null;
/* client.js 已 import 过 ⇒ loader 已被调用一次，captured 在下面重新接 */
globalThis.window.__ModuleLoader__ = { load: (o) => { captured = o; } };
await import(new URL('../dispatch/client.js', import.meta.url).href + '?fresh=1');
captured.factory((n) => (n === 'react' ? React : {})).apply({
  slots: { inject: (k, cb) => { cb(); return () => {}; }, register: (o, comp) => { regs.push(comp); return () => {}; } },
  effect: (fn) => { const dd = fn(); return typeof dd === 'function' ? dd : () => {}; },
  on: () => () => {}, locale: { formatMessage: (m) => String(m?.id ?? m) },
  remote: { $mount: () => Promise.reject(new Error('no remote: 强制走 ext wire')) },
});
lsStore.set('dispatch:section:channel', 'true');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const render = () => {
  let t = expand(regs[0]({}), 'hdr');
  let chip = null;
  const w = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(w); return; } if (n.type === 'button' && String(n.props?.className ?? '').includes('dsp-chip')) chip = n; w(n.children); };
  w(t);
  if (chip) chip.props.onClick();
  t = expand(regs[0]({}), 'hdr');
  while (pendingEffects.length) pendingEffects.shift()();
  return t;
};
render();
/* 让异步的 channels()/channel()/fallback() 与 wire 轮询落地：
 * 每轮都"重跑挂起 effect → 重新渲染"，模拟真实 React 的"状态变化 → 再渲染"。 */
for (let i = 0; i < 8; i += 1) {
  await sleep(30);
  const t = expand(regs[0]({}), 'hdr');
  while (pendingEffects.length) pendingEffects.shift()();
  void t;
}
/* ★ 关键：快照是通过 wire.subscribe 的回调进 useEffect 的 setState。
 * 上面只跑了 effect（注册订阅），回调本身要么在注册时同步跑一次、要么靠 setInterval 轮询。
 * 故这里再显式"重跑一遍订阅回调"：重跑 effect 会重新注册（首次即 poll 一次），
 * 从而把 snapshot 灌进 state —— 这正是真实应用里每秒发生的事。 */
{
  const t = expand(regs[0]({}), 'hdr');
  void t;
  while (pendingEffects.length) pendingEffects.shift()();
}
await sleep(30);
const tree2 = expand(regs[0]({}), 'hdr');

const selects = []; const toggles = [];
const walk = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(walk); return; } if (n.type === 'select') selects.push(n); if (n.type === 'button' && String(n.props?.className ?? '').includes('dsp-toggle')) toggles.push(n); walk(n.children); };
walk(tree2);
const optsOf = (sel) => (sel.children ?? []).flatMap((c) => {
  if (!c || typeof c !== 'object') return [];
  const lbl = (o) => (Array.isArray(o.children) ? o.children.join('') : String(o.children ?? ''));
  if (c.type === 'optgroup') return (c.children ?? []).filter((x) => x && x.type === 'option').map((o) => ({ v: o.props.value, label: lbl(o), disabled: !!o.props.disabled }));
  return c.type === 'option' ? [{ v: c.props.value, label: lbl(c), disabled: !!c.props.disabled }] : [];
});

console.log(`\n模式=${MODE}`);
console.log(`数据源调用记录：${JSON.stringify(calls)}`);
console.log(`select 数量=${selects.length}  过滤开关数量=${toggles.length}`);
for (let i = 0; i < Math.min(selects.length, 3); i += 1) {
  const opts = optsOf(selects[i]);
  console.log(`\n--- select#${i} value=${JSON.stringify(selects[i].props.value)} 共 ${opts.length} 个 option`);
  console.log(`    含当前值？${opts.some((o) => o.v === selects[i].props.value) ? '是' : '★否'}`);
  for (const o of opts.slice(0, 6)) console.log(`      ${o.disabled ? '[置灰]' : '[可选]'} ${o.v}  ${o.label}`);
  if (opts.length > 6) console.log(`      … 还有 ${opts.length - 6} 个`);
}
const togglesInfo = toggles.map((b) => ({ label: (b.children ?? []).join(''), pressed: b.props['aria-pressed'] }));
console.log(`\n过滤开关：${JSON.stringify(togglesInfo)}`);
process.exit(0);
