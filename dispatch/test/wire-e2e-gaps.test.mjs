/**
 * 审计 C 补强 · B：三个新功能的**非 happy path**（ZB-61 / ZB-62 / ZB-63）。
 *
 * A 文件（wire-actions）盖的是 wire action 层的行为；本文件盖的是三处点名的盲区：
 *   ① ZB-61：**真 core `list()`**（不是桩）× brief 投影/排序/dismissed 过滤 + `limit` 边界
 *      + **模型可见文本**的体量与字段齐备性（ZB-61 的初衷 = 模型别再收到被截断的巨型 JSON）；
 *   ② ZB-62：**非 idle → inject** 路径的 inserted 对账（复刻"inject 内部同步 emit"的真机时序）
 *      + `deliveredIds`/`pendingInsert` 的**上限淘汰**（长跑进程不许无界增长）；
 *   ③ ZB-63：`client.js` 注册的槽位 key 与 `index.js` 里 defineTool 的**工具名一致**
 *      （key 拼错 ⇒ 卡片静默不生效，这是唯一生死线）。
 *
 * ⚠️ 已知可达性限制（如实标注，不假装覆盖）：
 *   · 纯 node 里 `defineTool` 解析不到（宿主 `@deepseek-ai/dsh-tools` 在 app.asar 内，见
 *     index.js:172 头注释）⇒ 工具**不注册**、`output.render` 不可达。本文件先尝试用
 *     `apply(ctx.tools.register)` 捕获真实 tool 对象；捕获不到就按 render 的契约
 *     （`JSON.stringify(value, null, 2)`，index.js:456）度量**同一个 payload**，并在末尾列出未覆盖。
 *   · 真宿主里的 keyed 槽位派发（key 是否真按工具名匹配）无法在 node 里验证，只验证"两侧字符串一致"。
 *
 * 跑法：node dispatch/test/wire-e2e-gaps.test.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../core/dispatch-core.mjs';
import { createActionHandler } from '../wire.host.mjs';
import { createSettleNotifier } from '../notify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const FAKE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs');

let pass = 0;
const fail = [];
const uncovered = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const eq = (a, b, m) => ok(Object.is(a, b), `${m}（实际 ${JSON.stringify(a)}）`);
const deq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}（实际 ${JSON.stringify(a)}）`);
const has = (s, sub, m) => ok(typeof s === 'string' && s.includes(sub), `${m}（实际 ${JSON.stringify(typeof s === 'string' ? s.slice(0, 200) : s)}）`);

const tempDirs = [];
const live = [];
const newDir = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tempDirs.push(d); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLED = new Set(['done', 'failed', 'killed', 'interrupted', 'paused']);
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(20); }
  throw new Error(`waitFor 超时：${what}`);
}
async function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) prev[k] = process.env[k];
  try { Object.assign(process.env, env); return await fn(); } finally {
    for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}
function mkApi({ workRoot = newDir('dsp-gap-'), maxConcurrent = 4 } = {}) {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot, maxConcurrent });
  live.push({ d });
  return { d, api: createActionHandler(d, { switchPath: join(workRoot, 'sw.json'), ledgerPath: join(workRoot, 'ledger.jsonl') }) };
}
const settle = (d, id, ms = 20000) => waitFor(() => { const j = d.get(id); return j && SETTLED.has(j.state) ? j : null; }, ms, `job ${id} 落地`);
async function dispatchSettled(api, d, params) {
  const r = await api('dispatch', params);
  if (!r.ok) throw new Error(`dispatch 失败：${r.error}`);
  return { r, job: await settle(d, r.job.id) };
}
/** 60 条合成 job（形态与 core serialize 一致）——只用于 limit 边界与"模型可见文本"体量度量。 */
function makeJob(i) {
  const at = new Date(Date.UTC(2026, 9, 17, 9, 0, i)).toISOString();
  return {
    id: `j-gap-${String(i).padStart(3, '0')}`, state: 'done', engine: 'zcode', model: 'GLM-5.3',
    provider: 'plan', queuedAt: at, startedAt: at, finishedAt: at, elapsedSec: 1.5, exitCode: 0,
    responseChars: 8, turnCount: 1, contextRatio: 0.02, tailLines: ['a', 'b'], lockPaths: {},
    progress: { stage: 'done' }, parseWarnings: [], usage: { requests: 1, inputTokens: 9 },
    attempts: [], hopCount: 0,
    spec: { kind: 'prompt', prompt: `P${i}-` + '长'.repeat(1200), model: 'GLM-5.3', provider: 'plan', cwd: 'F:\\w', lock: 'repo', timeoutMin: 5, write: [] },
  };
}
const stubApi = (jobs, dir) => createActionHandler({ jobsFile: join(dir, 'jobs.json'), list: () => jobs.map((j) => JSON.parse(JSON.stringify(j))) }, {});

/* ═════════════════════ ① ZB-61：真 core list × brief ═════════════════════ */
async function part61() {
  console.log('① ZB-61：真 core `list()` × brief 投影 / 排序 / dismissed / limit 边界');

  /* ---- 1a. 真 core list 的排序：running → queued → 其余（按 queuedAt 倒序） ---- */
  {
    const { d, api } = mkApi({ maxConcurrent: 1 });
    /* 先造两条落地 job：done 与 paused（paused 也算落地，core 的 order 表里它与终态同秩）。 */
    const c = await withEnv({ FAKE_SLEEP_MS: '0' }, () => dispatchSettled(api, d, { kind: 'prompt', prompt: 'C', tag: 'C', timeoutMin: 1 }));
    const dd = await withEnv({ FAKE_SLEEP_MS: '0', FAKE_EXIT_CODE: '1', FAKE_PAUSE_TEXT: 'quota_exceeded' },
      () => dispatchSettled(api, d, { kind: 'prompt', prompt: 'D', tag: 'D', timeoutMin: 1 }));
    eq(c.job.state, 'done', 'C 落地为 done');
    eq(dd.job.state, 'paused', 'D 落地为 paused');
    eq(c.job.id, d.get(c.job.id).id, '真 core 返回的 job 可被 get 复核');

    /* dismissed 过滤（真 dispatcher + 真 dismissed.json）：先把 paused 的 D 关掉。 */
    const beforeDismiss = await api('list', {});
    eq(beforeDismiss.total, 2, 'dismiss 前 total = 2（真 core list 的条数）');
    const dr = await api('dismiss', { id: dd.job.id });
    eq(dr.ok, true, 'dismiss paused 的 job ok:true（paused 也算落地）');
    const afterDismiss = await api('list', {});
    eq(afterDismiss.total, 1, 'dismiss 后 total 减 1（真 core list × 过滤生效）');
    ok(!afterDismiss.jobs.some((j) => j.id === dd.job.id), '被 dismiss 的 job 不在真 core list 的结果里');
    ok(afterDismiss.jobs.some((j) => j.id === c.job.id), '未 dismiss 的 job 仍在（不是清空）');

    /* 活动项排在最前：running(0) < queued(1) < 其余。 */
    await withEnv({ FAKE_SLEEP_MS: '4000' }, async () => {
      const ra = await api('dispatch', { kind: 'prompt', prompt: 'A', tag: 'A', timeoutMin: 1 });
      const rb = await api('dispatch', { kind: 'prompt', prompt: 'B', tag: 'B', timeoutMin: 1 });
      eq(ra.ok && rb.ok, true, 'A/B 均已入队（maxConcurrent=1 ⇒ B 排队）');
      await waitFor(() => d.get(ra.job.id)?.state === 'running', 5000, 'A running');
      const l = await api('list', {});
      eq(l.total, 3, 'total = 3 条**真实** job（不是桩造的）');
      const states = l.jobs.map((j) => j.state);
      eq(states[0], 'running', 'running 排在第一位');
      eq(states[1], 'queued', 'queued 紧随其后（并发已满，B 在排队）');
      eq(states[2], 'done', '落地 job 在最后');
      /* 同秩内按 queuedAt 倒序：这里 C 比 D 早、D 已 dismiss，故只剩一条，无法比较；
       * 用"新派发的活动项必然在旧落地项之前"作为可观察结论。 */
      ok(l.jobs[0].id === ra.job.id && l.jobs[1].id === rb.job.id, '活动项就是刚派发的那两条');
      /* brief 投影：真 job 上也要没有"大字段"。 */
      for (const j of l.jobs) {
        ok(!('spec' in j), `brief 形状不含 spec（${j.id}）`);
        ok(!('lockPaths' in j) && !('usage' in j) && !('parseWarnings' in j), `brief 形状不含 lockPaths/usage/parseWarnings（${j.id}）`);
        ok('state' in j && 'tag' in j && 'kind' in j && typeof j.tailCount === 'number', `brief 保留选动作必需的字段（${j.id}）`);
      }
      eq(l.jobs[2].tailCount, 10, '真 job 的 tailCount 来自实际输出行数（可据此决定要不要 tail）');
      const full = await api('list', { full: true });
      ok(full.jobs.every((j) => j.spec && typeof j.spec.body === 'string' && j.spec.body.length > 0), 'full=true 时每条都带 spec.body（旧形状在真 job 上仍然可用）');
      ok(full.jobs.every((j) => 'progress' in j && 'usage' in j), 'full=true 时带 progress/usage');
      eq(full.shape, 'full', 'shape=full');
      eq(l.shape, 'brief', 'shape=brief（默认）');
      /* 清理活动项，避免带着 running 离场。 */
      d.kill(ra.job.id, 'test'); d.kill(rb.job.id, 'test');
      await settle(d, ra.job.id); await settle(d, rb.job.id);
    });
  }

  /* ---- 1b. limit 边界（用桩：真 core 造不出 >50 条 job；wire 层逻辑才是被测对象） ---- */
  {
    const dir = newDir('dsp-gap-lim-');
    const jobs = Array.from({ length: 60 }, (_, i) => makeJob(i));
    const api = stubApi(jobs, dir);
    const l0 = await api('list', {});
    eq(l0.jobs.length, 50, 'limit 缺省 ⇒ 50 条');
    eq(l0.total, 60, 'total 是全量条数（不是本页条数）');
    has(l0.note, '已省略 10 条', 'note 写明省略了多少（不静默截断）');
    has(l0.note, 'full=true', 'note 告诉调用方怎么取完整形状');
    eq((await api('list', { limit: 0 })).jobs.length, 50, 'limit=0 ⇒ 回默认 50（不当成"空列表"）');
    eq((await api('list', { limit: 'abc' })).jobs.length, 50, "limit 非数字 ⇒ 回默认 50（不抛）");
    eq((await api('list', { limit: -3 })).jobs.length, 50, 'limit 负数 ⇒ 回默认 50');
    eq((await api('list', { limit: 9999 })).jobs.length, 60, 'limit 超上限 ⇒ 只受实际条数约束');
    const l3 = await api('list', { limit: 3 });
    eq(l3.jobs.length, 3, 'limit=3 生效');
    has(l3.note, '已省略 57 条', '省略数按 limit 重算');
    eq((await api('list', { limit: 200 })).jobs.length, 60, 'limit=上限(200) ⇒ 全量、无 note');
    eq((await api('list', { limit: 200 })).note, undefined, '无省略时不给 note');
  }

  /* ---- 1c. 模型可见文本：render 可达就直接调，否则按契约（JSON.stringify(v,null,2)）度量同一 payload ---- */
  {
    const dir = newDir('dsp-gap-text-');
    const jobs = Array.from({ length: 60 }, (_, i) => makeJob(i));
    const api = stubApi(jobs, dir);
    const briefAll = await api('list', { limit: 60 }); // 全量页：无省略 ⇒ 不该有 note
    const briefPage = await api('list', {}); // 默认页：50/60 ⇒ 必须有省略提示
    const full = await api('list', { full: true, limit: 60 });
    eq(briefAll.note, undefined, '60/60 全部返回时不加 note（没有省略就不吓唬调用方）');
    has(briefPage.note, '已省略 10 条', '50/60 时确实带省略提示');
    const box = await tryCaptureHostTool();
    const render = (value) => {
      if (box.tool && typeof box.tool.output?.render === 'function') {
        const out = box.tool.output.render({ action: 'list' }, value);
        return (Array.isArray(out) ? out : []).map((b) => b?.text ?? '').join('');
      }
      return JSON.stringify(value, null, 2); // index.js:456 的契约
    };
    const briefText = render(briefAll);
    const pageText = render(briefPage);
    const fullText = render(full);
    has(briefText, '"total"', '模型可见文本里有 total');
    has(briefText, '"counts"', '模型可见文本里有 counts');
    has(pageText, '已省略', '★ 有省略时，模型可见文本里带省略提示（模型知道"还有更多"，不会以为自己看到了全部）');
    has(briefText, '"shape"', '模型可见文本里有 shape（brief/full 可辨认）');
    ok(briefText.length < 30_000, `60 条 brief 的模型可见文本 < 30 KB（实际 ${(briefText.length / 1024).toFixed(1)} KB）`);
    ok(fullText.length > briefText.length * 3, `full 文本显著更大（${(fullText.length / 1024).toFixed(1)} KB vs ${(briefText.length / 1024).toFixed(1)} KB）⇒ 紧凑形状正是防宿主 spill 截断的那一步`);
    ok(box.tool === null || box.tool === undefined ? true : typeof box.tool.output.render === 'function', '捕获到 tool 时它确实有 output.render');
    if (!box.tool) {
      uncovered.push('ZB-61 的 output.render **真实调用**未覆盖（纯 node 下 defineTool 未解析，见 box.why）；已按契约度量同一 payload。');
      console.log(`  · 说明：真实 output.render 不可达（${box.why}）；上面用 render 契约（JSON.stringify(value,null,2)）度量同一 payload。`);
    } else {
      console.log('  · 已捕获真实 tool 对象：上面调用的是**真实 output.render**。');
    }
  }
}
/** 尝试用 apply() 的 ctx.tools.register 捕获真实 tool 对象（宿主包可达时才有）。 */
async function tryCaptureHostTool() {
  const root = newDir('dsp-gap-tool-');
  const logs = [];
  let tool = null;
  let why = '';
  try {
    const { apply } = await import('../index.js');
    const ctx = {
      effect() {}, logger: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) },
      get() { return undefined; }, on() { return () => {}; }, inject() {},
      tools: { register(t) { tool = t; return () => {}; } },
    };
    apply(ctx, { demo: false, maxConcurrent: 1, runnerPath: FAKE_RUNNER, workRoot: root, switchPath: join(root, 'sw.json'), ledgerPath: join(root, 'ledger.jsonl') });
    if (!tool) why = (logs.find(([lv]) => lv === 'warn')?.[1] ?? 'defineTool 未解析（工具未注册）').slice(0, 120);
  } catch (e) { why = `apply 抛错：${e?.message ?? e}`; }
  return { tool, why };
}

/* ═════════════════════ ② ZB-62：inject 路径 + 上限淘汰 ═════════════════════ */
function notifyHarness({ agentStatus = 'idle', config = {} } = {}) {
  const dir = newDir('dsp-gap-wake-');
  const subs = new Set();
  const jobs = new Map();
  const dispatcher = {
    jobsFile: join(dir, 'jobs.json'),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    get(id) { return jobs.get(id) ?? null; },
    settle(job) { jobs.set(job.id, job); for (const fn of [...subs]) fn({ type: 'job-updated', job }); },
  };
  const calls = [];
  const agent = {
    id: 'sess-gap', status: agentStatus, calls, onSend: null,
    followup(m) { calls.push(['followup', m]); if (this.onSend) this.onSend(m); },
    inject(m) { calls.push(['inject', m]); if (this.onSend) this.onSend(m); },
  };
  const handlers = new Map();
  const ctx = {
    on(ev, fn) { const l = handlers.get(ev) ?? []; l.push(fn); handlers.set(ev, l); return () => { const a = handlers.get(ev) ?? []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }; },
  };
  const logs = [];
  const notifier = createSettleNotifier({
    dispatcher, agents: { get: (id) => (id === 'sess-gap' ? agent : undefined) },
    log: (lv, m) => logs.push([lv, m]), config, ctx,
  });
  const fire = (ev, payload) => { for (const fn of [...(handlers.get(ev) ?? [])]) fn(payload); };
  return { dir, dispatcher, agent, notifier, logs, fire, calls };
}
async function part62() {
  console.log('\n② ZB-62：非 idle → inject 的 inserted 对账（复刻真机同步时序）');
  {
    const h = notifyHarness({ agentStatus: 'busy' });
    h.agent.onSend = (m) => h.fire('agent/inbox/inserted', { agent: h.agent, message: m }); // 宿主在 inject 内部同步发事件
    h.notifier.track('j-i1', 'sess-gap');
    h.dispatcher.settle({ id: 'j-i1', state: 'done', exitCode: 0, spec: { kind: 'prompt', tag: 'T' } });
    deq(h.calls.map((c) => c[0]), ['inject'], '忙碌会话走 inject（不开新一轮）');
    const s = h.notifier.stats();
    eq(s.delivered, 1, 'delivered=1');
    eq(s.inject, 1, '注入路径计数正确');
    eq(s.followup, 0, '没有误记 followup');
    eq(s.insertAcked, 1, '★ 同步 inserted 对上了账（先登记 id、再投递）');
    eq(s.unconfirmed, 0, '未确认归零（消息确实进了 Inbox）');
    eq(s.tracked, 0, '投递后归属释放（owners 不随历史 job 增长）');
    const m = h.calls[0][1];
    eq(m.role, 'user', '通知消息 role=user（与 dsh-tool-jobs 同形）');
    eq(m.source.kind, 'dispatch', 'source.kind=dispatch（客户端据此渲染成"通知触发"卡片）');
    eq(m.source.form, 'notice', 'source.form=notice（换别的串会让客户端 contextBody 抛错）');
    ok(typeof m.id === 'string' && m.id.length > 0, '消息带可对账的 id');
    ok(typeof m.source.summary === 'string' && m.source.summary.length > 0 && m.source.summary.length <= 120, '折叠行摘要在客户端上限内');
    h.notifier.dispose();
  }

  console.log('\n②b ZB-62：deliveredIds / pendingInsert 有上限（长跑不许无界增长）');
  {
    const h = notifyHarness({ agentStatus: 'idle' });
    const N = 1100; // 大于实现上限(1000)即可证明"会淘汰最旧"，不写死具体常量
    const ids = [];
    for (let i = 0; i < N; i += 1) {
      h.notifier.track(`j-cap-${i}`, 'sess-gap');
      h.dispatcher.settle({ id: `j-cap-${i}`, state: 'done', exitCode: 0, spec: { kind: 'prompt', tag: `t${i}` } });
      ids.push(h.calls.at(-1)[1].id);
    }
    const s1 = h.notifier.stats();
    eq(s1.delivered, N, `投递 ${N} 条全部记账`);
    ok(s1.unconfirmed < N && s1.unconfirmed > 0, `pendingInsert 有界（${s1.unconfirmed} < ${N}）`);
    eq(s1.tracked, 0, 'owners 不随投递数增长（每条投递后即释放）');
    const acked0 = s1.insertAcked;
    h.fire('agent/inbox/inserted', { agent: h.agent, message: { id: ids[0] } });
    eq(h.notifier.stats().insertAcked, acked0, '★ 最早那条已不在对账表里（被淘汰 ⇒ 不再计数）');
    h.fire('agent/inbox/inserted', { agent: h.agent, message: { id: ids.at(-1) } });
    eq(h.notifier.stats().insertAcked, acked0 + 1, '最新那条仍能对上账（淘汰只丢最旧，不动最新）');
    eq(h.notifier.stats().unconfirmed, s1.unconfirmed - 1, '确认后未确认数减 1');
    h.notifier.dispose();
  }
}

/* ═════════════════════ ③ ZB-63：槽位 key 与工具名一致 ═════════════════════ */
async function part63() {
  console.log('\n③ ZB-63：client 槽位 key ↔ index.js 工具名（key 拼错 = 卡片静默不生效）');
  const SRC = join(PKG, 'client.js');
  /* 客户端 key：真加载 client.js + 桩 ctx，从 register 的注册对象里读（行为证据，不匹配源码文本）。 */
  const head = { children: [], appendChild(c) { head.children.push(c); return c; }, removeChild() {} };
  globalThis.document = {
    head, documentElement: { appendChild: () => {} },
    createElement: (t) => (t === 'style'
      ? { tagName: 'STYLE', attrs: {}, isConnected: true, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, textContent: '' }
      : { tagName: t.toUpperCase(), attrs: {}, setAttribute() {}, appendChild() {} }),
    getElementById: () => null, querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {},
  };
  const ls = new Map();
  globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: { load: (o) => { captured = o; } },
    localStorage: globalThis.localStorage, innerHeight: 900, innerWidth: 1200, addEventListener: () => {}, removeEventListener: () => {},
  };
  await import(`file:///${SRC.replace(/\\/g, '/')}`);
  ok(!!captured && captured.id === 'dsh-dispatch', 'client.js 经 __ModuleLoader__ 注册（id=dsh-dispatch）');
  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    Fragment: 'Fragment', Component: class { constructor(p) { this.props = p ?? {}; this.state = {}; } setState() {} },
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
    useCallback: (f) => f, useMemo: (f) => (typeof f === 'function' ? f() : f), useSyncExternalStore: () => undefined,
  };
  const regs = [];
  let applyErr = null;
  try {
    const mod = captured.factory((n) => (n === 'react' ? ReactStub : {}));
    mod.apply({
      slots: { inject: (k, cb) => { cb(); return () => {}; }, register: (o, comp) => { regs.push({ o, comp }); return () => {}; } },
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
      on: () => () => {}, locale: { formatMessage: (m) => String(m?.id ?? m) }, remote: { $mount: () => Promise.resolve() },
    });
  } catch (e) { applyErr = e; }
  eq(applyErr, null, `client.js 的 apply() 不抛错${applyErr ? `（实际：${applyErr.message}）` : ''}`);
  const tv = regs.find((r) => r.o && r.o.name === 'tool.call.toolview');
  ok(!!tv, 'client.js 真的注册了 keyed 槽位 tool.call.toolview（不是只写在注释里）');
  const slotKey = tv?.o?.key;
  ok(typeof slotKey === 'string' && slotKey.length > 0, `槽位 key 是非空字符串（${JSON.stringify(slotKey)}）`);

  /* 宿主工具名：先尝试真实 tool 对象，否则从 defineTool 字面量取（纯 node 下唯一可得来源，如实标注）。 */
  const box = await tryCaptureHostTool();
  let hostName = box.tool?.name ?? null;
  let how = 'apply(ctx.tools.register) 捕获的真实 tool 对象';
  if (!hostName) {
    const src = readFileSync(join(PKG, 'index.js'), 'utf8');
    const m = src.match(/register\(defineTool\(\{[\s\S]{0,300}?name:\s*'([^']+)'/);
    hostName = m ? m[1] : null;
    how = 'index.js 里 defineTool 的 name 字面量（工具对象不可达）';
    uncovered.push('ZB-63 的宿主工具名取自 index.js 源码文本（纯 node 下 tool 对象不可达）；已尽量缩小到 defineTool 字面块。');
  }
  ok(typeof hostName === 'string' && hostName.length > 0, `取到宿主工具名（${JSON.stringify(hostName)}，来源：${how}）`);
  eq(slotKey, hostName, `★ 槽位 key === 工具名（${JSON.stringify(slotKey)} vs ${JSON.stringify(hostName)}）—— 不一致则卡片静默不生效`);
  /* 反向保护：key 不能是"槽位名"或别的常量（拼错的最常见形态）。 */
  ok(slotKey !== 'tool.call.toolview', '槽位 key 没有被错写成槽位名本身');
  const comp = regs.filter((r) => r.o?.name === 'tool.call.toolview' && typeof r.comp === 'function');
  eq(comp.length, 1, '同一个槽位只注册了一次（重复注册会让宿主派发歧义）');
}

try {
  await part61();
  await part62();
  await part63();
} finally {
  for (const { d } of live) {
    for (const j of d.list() ?? []) {
      if (!SETTLED.has(j.state)) { try { d.kill(j.id, 'test-teardown'); } catch { /* 已结束 */ } }
    }
  }
  const end = Date.now() + 10000;
  while (Date.now() < end && live.some(({ d }) => (d.list() ?? []).some((j) => !SETTLED.has(j.state)))) await sleep(50);
  await sleep(150);
  for (const dir of tempDirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄抖动 */ } }
}

console.log(`\n===== 新功能非 happy path：${pass} PASS / ${fail.length} FAIL =====`);
if (uncovered.length) { console.log('未覆盖（如实标注）：'); for (const u of uncovered) console.log(`  · ${u}`); }
if (fail.length) { for (const m of fail) console.log(`  ✗ ${m}`); }
process.exit(fail.length ? 1 : 0);
