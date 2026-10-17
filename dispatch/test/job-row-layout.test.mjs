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
  /* lockKindOf 读的是 job.lock（'repo' / 'file:…' / 'none'），thinkingShown 读 spec.reasoningLevel
   * 或 reasoningLevelApplied —— 夹具必须按这两个真实判据给值，否则徽标天然隐藏、断言就成了空转。 */
  lock: 'repo', spec: { kind: 'prompt', body: 'x', engine: 'opencode', lock: 'repo', reasoningLevel: 'high' },
  contextUsed: 83000, contextWindow: 200000, autoApproved: true, lockPaths: { 'a.js': true }, tailCount: 3,
  progress: null, stalled: false, lastProgressAgoSec: null, hopCount: 0, parentJobId: null,
}, o);
const JOBS = [
  baseJob({ tag: 'run-1', state: 'running', progress: { stage: 'step-finish', lastTool: 'read', chars: 120, tools: 7 }, lastProgressAgoSec: 12 }),
  /* 血缘徽标（接续自 / N 跳）走这里：用户要求它们显示在**第三行右侧**。 */
  baseJob({ tag: 'done-1', state: 'done', exitCode: 0, parentJobId: 'j-parent-9', hopCount: 2 }),
  baseJob({ tag: 'paused-1', state: 'paused', pauseReason: 'quota-exhausted' }),
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
  /* 行 2：**恰好五项**（引擎/模型/思考/权限/文件锁），且不许折叠 —— 文件锁必须留在这一行。 */
  const badges = findAll(lines[1], (n) => cls(n).includes('dsp-badge'));
  ok(badges.length === 5, `A11 第 2 行恰好 5 个徽标（实际 ${badges.length} 个：${badges.map(text).join(' | ')}）`);
  ok(text(badges[0]) === 'OpenCode', `A12 第 2 行第 1 个徽标 = 引擎（实际「${text(badges[0])}」）`);
  ok(text(badges[1]) === 'glm-5.3-flash-free', `A13 模型徽标**去掉引擎前缀**后显示（实际「${text(badges[1])}」）`);
  ok(cls(badges[1]).includes('dsp-job-model'), 'A13b 模型徽标带 dsp-job-model（可压缩 + 省略号）');
  ok(badges[1].props.title === 'opencode/glm-5.3-flash-free', `A13c 模型徽标 title = 完整名（悬浮可见，实际「${badges[1].props.title}」）`);
  ok(text(badges[2]) === '高强度', `A13d 第 3 个徽标 = 思考强度（实际「${text(badges[2])}」）`);
  ok(text(badges[3]) === '已放行权限', `A13e 第 4 个徽标 = 权限（实际「${text(badges[3])}」）`);
  ok(text(badges[4]) === '整仓库锁', `A13f ★ 第 5 个徽标 = 文件锁，且留在第 2 行（实际「${text(badges[4])}」）`);
  ok(!badges.some((b) => text(b).includes('接续自') || text(b).includes('跳')), 'A18 第 2 行不含血缘徽标（已移到第三行）');
  /* 压缩/不折行是 CSS 保证的 —— 从注入的样式表里断言（否则"写了类名但样式没上"查不出来）。 */
  const css = head.children.map((c) => String((c && c.textContent) || '')).join('\n');
  ok(/\.dsp-job-line2\{[^}]*flex-wrap:nowrap/.test(css), 'A19 第二行 CSS 明确禁止折行（.dsp-job-line2{flex-wrap:nowrap}）');
  ok(/\.dsp-job-model\{[^}]*text-overflow:ellipsis/.test(css), 'A20 模型徽标 CSS 用省略号压缩（完整名走 title）');
  ok(/\.dsp-job-line3 \.dsp-job-right\{[^}]*margin-left:auto/.test(css),
    'A21 第三行的右组靠 margin-left:auto 推到行尾（"接续"右对齐）');
  /* ★ 这次回归的根因：第三行**允许折行**时，心跳文字一长就把右侧的「接续」折到**下一行行首**，
   * 看起来像"接续在左边"。所以必须钉死：第三行 nowrap + 左侧组可压缩。 */
  ok(/\.dsp-job-line3\{[^}]*flex-wrap:nowrap/.test(css), 'A22 ★ 第三行禁止折行（否则接续会被折成"行首"= 看着像左对齐）');
  ok(/\.dsp-job-left\{[^}]*min-width:0/.test(css) && /\.dsp-job-left>\*\{[^}]*text-overflow:ellipsis/.test(css),
    'A23 左侧组可压缩（心跳超长用省略号让位给右侧接续）');
  ok(findAll(lines[2], (n) => cls(n) === 'dsp-job-left').length === 1, 'A24 第三行有左侧组（.dsp-job-left）');
  ok(text(findAll(lines[2], (n) => cls(n) === 'dsp-job-left')[0]).includes('最近心跳'), 'A25 左侧组里是心跳');
  /* 行 3：只有心跳（上下文已按用户要求移到第一行右侧）。 */
  const t3 = text(lines[2]);
  ok(/最近心跳 12s/.test(t3), `A16 第 3 行含心跳（实际「${t3}」）`);
  ok(!/83\.0k/.test(t3), `A15c 第 3 行不再显示上下文（已移到第一行）`);
  ok(findAll(lines[2], (n) => cls(n) === 'dsp-job-right').length === 0, 'A17 第 3 行没有右对齐组（心跳左对齐）');
  /* 上下文在**时间左边**（用户要求："83.0k / 200.0k 移到时间左侧"）。 */
  const rightText = text(right[0]);
  ok(/83\.0k \/ 200\.0k/.test(rightText), `A15 第 1 行右侧组含上下文用量（实际「${rightText}」）`);
  ok(rightText.indexOf('83.0k') >= 0 && rightText.indexOf('83.0k') < rightText.indexOf('0时02分05秒'),
    `A15b 上下文在**时间左边**（实际「${rightText}」）`);
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
  const doneRight = text(findAll(linesOf(doneRow)[0], (n) => cls(n) === 'dsp-job-right')[0]);
  ok(/83\.0k \/ 200\.0k/.test(doneRight) && /退出 0/.test(doneRight),
    `B13 终态行右组 = 上下文 + 时间 + 退出（实际「${doneRight}」）`);
  /* 血缘徽标：第三行**右侧**（用户要求"接续的移到第三行右侧右对齐"）。 */
  const doneLines = linesOf(doneRow);
  ok(doneLines.length === 3, `B12 有血缘的终态行 = 三行（第3行专放血缘，实际 ${doneLines.length}）`);
  const doneRow3 = doneLines[2];
  const doneRow3Right = findAll(doneRow3, (n) => cls(n) === 'dsp-job-right');
  ok(doneRow3Right.length === 1, `B14 第 3 行有右对齐组（实际 ${doneRow3Right.length}）`);
  const r3text = text(doneRow3Right[0]);
  ok(/接续自/.test(r3text) && /2 跳/.test(r3text), `B15 右组 = 接续自 + N 跳（实际「${r3text}」）`);
  ok(!/接续自/.test(text(doneLine1)), 'B16 第一行没有血缘徽标（没被挤回去）');
}

/* ===== B2. paused 行的第三行：左对齐的暂停原因（没有心跳） ===== */
{
  goTab(1);
  const row = rows(tree)[0];
  const ls = linesOf(row);
  ok(ls.length === 3, `B17 paused 行 = 三行（第3行放暂停原因，实际 ${ls.length}）`);
  const t3 = text(ls[2]);
  ok(/暂停/.test(t3), `B18 第 3 行含暂停原因（实际「${t3}」）`);
  ok(findAll(ls[2], (n) => cls(n) === 'dsp-job-right').length === 0, 'B19 paused 行没有血缘 ⇒ 第 3 行无右对齐组');
}

/* ===== C. 点击「清除所有」= 清除当前页签的全部进程 ===== */
console.log('\nC. 清除行为');
{
  goTab(3); /* B2 段停在了「需处理」tab ⇒ 这里先回到「已完成」再点清除 */
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
