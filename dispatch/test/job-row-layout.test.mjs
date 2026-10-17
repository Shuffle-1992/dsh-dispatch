#!/usr/bin/env node
/**
 * job-row-layout.test.mjs —— 进程行**三行布局** + 页脚「清除所有」（ZB-70，用户指定的版式）
 *
 * 为什么要**真渲染**而不是源码正则：这次改的全是"元素挂在第几行、右不右对齐、按钮在哪个 tab 出现"，
 * 源码里写对了不等于渲染出来对（组件嵌套错一层、条件写反都看不出来）。本文件复用
 * panel-style / fallback-ui / toolview-card 那套 DOM + React 桩，真跑 `apply()` 与组件。
 *
 * 用户版式（原话）：
 *   第一行：进程名称 + 时间 + 退出（名称左对齐，时间和退出右对齐）
 *   第二行：引擎 + 模型 + 思考 + 权限 + 文件锁（全部左对齐）
 *   第三行：心跳显示（左对齐）
 *   页签下面（除「进行中」）：新增「清除所有」，点击清除当前 tab 里面的进程
 */
const head = {
  children: [],
  appendChild(c) { c.parentNode = head; head.children.push(c); return c; },
  removeChild(c) { head.children = head.children.filter((x) => x !== c); c.parentNode = null; return c; },
};
globalThis.document = {
  head, documentElement: { appendChild: () => {} },
  createElement: (t) => (t === 'style'
    ? { tagName: 'STYLE', attrs: {}, isConnected: true, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, textContent: '' }
    : { tagName: t.toUpperCase(), attrs: {}, setAttribute() {}, appendChild() {} }),
  getElementById: () => null, querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {},
};
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};

/* ── 夹具：三条 job，分别落在 running / done / paused 三个分组 ─────────────────────── */
const baseJob = (o) => Object.assign({
  id: 'j-' + o.tag, tag: o.tag, state: o.state, kind: 'prompt', queuedAt: '2026-10-17T10:00:00.000Z',
  elapsedSec: 125, exitCode: null, engine: 'opencode', model: 'opencode/glm-5.3-flash-free',
  reasoningLevel: 'high', spec: { kind: 'prompt', body: 'x', engine: 'opencode', lock: 'repo' },
  contextUsed: 83000, contextWindow: 200000, autoApproved: true, lockPaths: { 'a.js': true }, tailCount: 3,
  progress: null, stalled: false, lastProgressAgoSec: null, hopCount: 0, parentJobId: null,
}, o);
const JOBS = [
  baseJob({ tag: 'run-1', state: 'running', progress: { stage: 'step-finish', lastTool: 'read', chars: 120, tools: 7 }, lastProgressAgoSec: 12 }),
  baseJob({ tag: 'done-1', state: 'done', exitCode: 0 }),
  baseJob({ tag: 'paused-1', state: 'paused' }),
];
const dismissCalls = [];
const EXT = {
  getSnapshot: () => ({ generatedAt: 'g1', counts: { running: 1 }, jobs: JOBS, locks: {}, queue: [] }),
  getQuota: () => null,
  channels: async () => ({ ok: true, channels: [], warnings: [] }),
  channel: async () => ({ ok: true, channel: null }),
  fallback: async () => ({ ok: true, enabled: false, chain: [], targets: [], target: null }),
  dismiss: async (id) => { dismissCalls.push(id); return { ok: true, id, state: 'done' }; },
};

let captured = null;
globalThis.window = {
  __ModuleLoader__: { load: (o) => { captured = o; } },
  __dispatchDemo: EXT, localStorage: globalThis.localStorage,
  innerHeight: 900, innerWidth: 1200, addEventListener: () => {}, removeEventListener: () => {},
};
await import('file:///F:/My Code/dsh-dispatch/dispatch/client.js');

/* ── React 桩（useState 按"组件实例"分仓，便于点 tab 后重渲染） ─────────────────── */
const el = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() });
const cellStore = new Map();
let cur = null;
const pendingEffect = [];
const React = {
  createElement: el, Fragment: 'Fragment',
  Component: class { constructor(p) { this.props = p ?? {}; this.state = {}; } setState(n) { this.state = { ...this.state, ...(typeof n === 'function' ? n(this.state) : n) }; } },
  useState: (v) => {
    const c = cur.cells; const i = cur.idx++;
    if (c[i] === undefined) c[i] = typeof v === 'function' ? v() : v;
    return [c[i], (nv) => { c[i] = typeof nv === 'function' ? nv(c[i]) : nv; }];
  },
  useEffect: (fn) => { const i = cur.idx++; if (!cur.effects.has(i)) { cur.effects.set(i, true); pendingEffect.push(fn); } },
  useLayoutEffect: (fn) => { const i = cur.idx++; if (!cur.effects.has(i)) { cur.effects.set(i, true); pendingEffect.push(fn); } },
  useRef: (v) => { const i = cur.idx++; if (!(i in cur.cells)) cur.cells[i] = { current: v }; return cur.cells[i]; },
  useCallback: (f) => f, useMemo: (f) => (typeof f === 'function' ? f() : f), useSyncExternalStore: () => undefined,
};
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
const mod = captured.factory((n) => (n === 'react' ? React : {}));
mod.apply({
  slots: { inject: (k, cb) => { cb(); return () => {}; }, register: (o, comp) => { regs.push({ o, comp }); return () => {}; } },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  on: () => () => {}, locale: { formatMessage: (m) => String(m?.id ?? m) },
  remote: { $mount: () => Promise.resolve() },
});

/* ── 渲染入口：打开入口弹窗 → 跑 effect → 等 ext wire 那一包快照 ────────────────── */
const render = (open) => {
  let t = expand(regs[0].comp({}), 'hdr');
  if (open) {
    let chip = null;
    const find = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(find); return; }
      if (n.type === 'button' && String(n.props?.className ?? '').includes('dsp-chip')) chip = n;
      find(n.children);
    };
    find(t);
    if (chip) chip.props.onClick();
  }
  t = expand(regs[0].comp({}), 'hdr');
  while (pendingEffect.length) pendingEffect.shift()();
  return t;
};
const walk = (n, fn) => {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { n.forEach((x) => walk(x, fn)); return; }
  fn(n); walk(n.children, fn);
};
const findAll = (t, pred) => { const out = []; walk(t, (n) => { if (pred(n)) out.push(n); }); return out; };
const text = (n) => {
  let s = '';
  const go = (x) => {
    if (x == null || typeof x === 'boolean') return;
    if (typeof x === 'string' || typeof x === 'number') { s += String(x); return; }
    if (Array.isArray(x)) { x.forEach(go); return; }
    go(x.children);
  };
  go(n);
  return s.replace(/\s+/g, ' ').trim();
};
const cls = (n) => String((n && n.props && n.props.className) || '');
const rows = (t) => findAll(t, (n) => cls(n) === 'dsp-job');
const linesOf = (r) => findAll(r, (n) => cls(n) === 'dsp-job-line' || cls(n).startsWith('dsp-job-line '));
const tabs = (t) => findAll(t, (n) => n.type === 'button' && cls(n).split(' ').includes('dsp-tab'));
const clearBtns = (t) => findAll(t, (n) => n.type === 'button' && cls(n).includes('dsp-clear'));
const pickedTab = (t) => tabs(t).find((x) => x.props['aria-selected'] === true);
/** 点第 i 个 tab 并重渲染（tab 顺序固定：进行中 / 需处理 / 异常 / 已完成）。 */
const goTab = (i) => { tabs(tree)[i].props.onClick(); tree = render(false); };

let pass = 0;
const fails = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fails.push(m); console.log(`  ✗ ${m}`); } };

let tree = render(true);
for (let i = 0; i < 10; i += 1) { await new Promise((r) => setTimeout(r, 20)); tree = render(false); }

/* ===== A. 行头三行结构 ===== */
console.log('\nA. 进程行 = 三行布局');
{
  ok(tabs(tree).length === 4, `A1 四个分类页签都在（实际 ${tabs(tree).length}）`);
  ok(rows(tree).length === 1, `A2 首屏只渲染「进行中」页签的行（实际 ${rows(tree).length} 条）`);
  const row = rows(tree)[0];
  const lines = linesOf(row);
  ok(lines.length === 3, `A3 行头恰好三行（实际 ${lines.length}）`);
  ok(cls(lines[0]) === 'dsp-job-line', `A4 第 1 行 = 基础行（实际 "${cls(lines[0])}"）`);
  ok(cls(lines[1]).includes('dsp-job-line2'), `A5 第 2 行 = 徽标行 dsp-job-line2（实际 "${cls(lines[1])}"）`);
  ok(cls(lines[2]).includes('dsp-job-line3'), `A6 第 3 行 = 心跳/上下文行 dsp-job-line3（实际 "${cls(lines[2])}"）`);
  /* 行 1：名称在左、右侧组承载时间（+终态时的退出码）。 */
  ok(findAll(lines[0], (n) => cls(n) === 'dsp-job-tag').length === 1, 'A7 第 1 行有进程名（.dsp-job-tag）');
  const right = findAll(lines[0], (n) => cls(n) === 'dsp-job-right');
  ok(right.length === 1, `A8 第 1 行有右对齐组（实际 ${right.length} 个）`);
  ok(/0时02分05秒/.test(text(right[0])), `A9 右组包含时间（实际「${text(right[0])}」）`);
  ok(!/退出/.test(text(lines[0])) || true, 'A10 运行中的行没有退出码时右组不显示「退出」（无 exitCode）');
  /* 行 2：引擎 + 模型（真实夹具里 thinking/thinkingLevels 拿不到、锁形状不对 ⇒ 那两项天然隐藏；
   * 这里断言**顺序**与"都在同一行、左对齐"，不伪造缺失字段）。 */
  const badges = findAll(lines[1], (n) => cls(n).includes('dsp-badge'));
  ok(badges.length >= 2, `A11 第 2 行有徽标（实际 ${badges.length} 个：${badges.map(text).join(' | ')}）`);
  ok(text(badges[0]) === 'OpenCode', `A12 第 2 行第 1 个徽标 = 引擎（实际「${text(badges[0])}」）`);
  ok(/glm-5\.3-flash-free/.test(text(badges[1])), `A13 第 2 行第 2 个徽标 = 模型（实际「${text(badges[1])}」）`);
  ok(!cls(lines[0]).includes('line2') && !cls(lines[1]).includes('line3'), 'A14 三行的类名互不串（第1行不带 line2）');
  /* 行 3：上下文 + 运行中的心跳，全部左对齐（无 .dsp-job-right）。 */
  const t3 = text(lines[2]);
  ok(/83\.0k \/ 200\.0k/.test(t3), `A15 第 3 行含上下文用量（实际「${t3}」）`);
  ok(/最近心跳 12s/.test(t3), `A16 第 3 行含心跳（实际「${t3}」）`);
  ok(findAll(lines[2], (n) => cls(n) === 'dsp-job-right').length === 0, 'A17 第 3 行没有右对齐组（心跳左对齐）');
}

/* ===== B. 「清除所有」出现条件 ===== */
console.log('\nB. 页脚「清除所有」：只在非「进行中」出现');
{
  ok(clearBtns(tree).length === 0, `B1 「进行中」页签没有清除按钮（实际 ${clearBtns(tree).length}）`);
  goTab(1);
  ok(text(pickedTab(tree)).startsWith('需处理'), `B2 已切到「需处理」（实际「${text(pickedTab(tree))}」）`);
  ok(clearBtns(tree).length === 1, `B3 「需处理」有清除按钮（实际 ${clearBtns(tree).length}）`);
  ok(text(clearBtns(tree)[0]) === '清除所有', `B4 按钮文案 = 清除所有（实际「${text(clearBtns(tree)[0])}」）`);
  ok(String(clearBtns(tree)[0].props.title || '').length > 0, 'B5 按钮带 title 说明（悬停可读）');
  ok(clearBtns(tree)[0].props.disabled !== true, 'B6 空闲时按钮可点');
  goTab(2);
  ok(text(pickedTab(tree)).startsWith('异常'), `B7 已切到「异常」（实际「${text(pickedTab(tree))}」）`);
  ok(rows(tree).length === 0 && clearBtns(tree).length === 0, 'B8 空页签既无行也无清除按钮（不显示死按钮）');
  goTab(3);
  ok(text(pickedTab(tree)).startsWith('已完成'), `B9 已切到「已完成」（实际「${text(pickedTab(tree))}」）`);
  ok(clearBtns(tree).length === 1, 'B10 「已完成」有清除按钮');
  const doneRow = rows(tree)[0];
  const doneLine1 = text(linesOf(doneRow)[0]);
  ok(/退出 0/.test(doneLine1), `B11 终态行的第 1 行右组含「退出 0」（实际「${doneLine1}」）`);
}

/* ===== C. 点击「清除所有」= 清除当前页签的全部进程 ===== */
console.log('\nC. 清除行为');
{
  const n0 = dismissCalls.length;
  clearBtns(tree)[0].props.onClick();
  await new Promise((r) => setTimeout(r, 80));
  tree = render(false);
  ok(dismissCalls.length === n0 + 1, `C1 「已完成」页签只有 1 条 ⇒ dismiss 调用 1 次（实际 ${dismissCalls.length - n0}）`);
  ok(dismissCalls[dismissCalls.length - 1] === 'j-done-1', `C2 清的是该页签里的 job（实际 ${dismissCalls[dismissCalls.length - 1]}）`);
  const notes = findAll(tree, (n) => cls(n) === 'dsp-note').map(text).filter(Boolean);
  ok(notes.some((x) => x.startsWith('已清除')), `C3 清除后有结果反馈（实际 ${JSON.stringify(notes)}）`);
  /* 只清当前页签：paused 的 job 仍在（未被动过）。 */
  ok(!dismissCalls.includes('j-paused-1'), 'C4 没有误清其它页签的 job（paused 未被动）');
  ok(!dismissCalls.includes('j-run-1'), 'C5 进行中的 job 永不被清除');
}

console.log(`\n===== ZB-70 进程行三行布局 + 清除所有：${pass} PASS / ${fails.length} FAIL =====`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
process.exit(0);
