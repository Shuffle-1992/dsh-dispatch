#!/usr/bin/env node
/**
 * split-mode.test.mjs —— ZB-82 用户要求：**分流模式**（主通道满 ⇒ 自动改派降级通道，用两条通道拿更大并发）
 *
 * 用户场景（原话）：「主通道和降级通道使用不同的通道时，可以分流提供一定的并发。比如我现在设置的」
 *   · 主通道 `qoder/DeepSeek-Flash` ⇒ Qoder 名额 3
 *   · 降级通道 `opencode/minimax-m3.1-flash-free` ⇒ OpenCode 名额 2
 *   ⇒ 分流后理论并发 **5**（3+2），而不是被主通道的 3 卡住。
 *
 * 设计要点（每条都有断言）：
 *   A. **默认关** ⇒ 既有行为一字不变（不开就绝不分流）；
 *   B. **只在主通道"将满"时**分流（`minFreeSlots` 控制提前量）；
 *   C. **同通道不分流**（同通道 = 同一份名额 ⇒ 分流是假动作，必须排除）；
 *   D. **显式指定通道不插手**（尊重调用方选择 —— 与"显式模型不被顺序链劫持"同一纪律）；
 *   E. **目标也满 ⇒ 老实排队**（不硬塞，避免把溢出堆到另一条也满的通道）；
 *   F. **判据用"在途数"（running+queued）** —— 否则连发多个时 running 还是 0，
 *      分流会慢一拍（用户连发 3 个，第 2/3 个必须在派发**那一刻**就被分流）；
 *   G. **留痕可见**：被分流的 job 带 `splitFrom` / `splitReason`（能看出"这不是用户选的通道"）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatcher } from '../core/dispatch-core.mjs';

let pass = 0;
const fails = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fails.push(m); console.log(`  ✗ ${m}`); } };

const roots = [];
const cleanup = () => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } };

/** 造一个"主通道 = qoder（名额 3）+ 降级目标 = opencode（名额 2）"的派发器（复刻用户设置）。 */
function mk() {
  const dir = mkdtempSync(join(tmpdir(), 'dsp-split-'));
  roots.push(dir);
  const slow = join(dir, 'slow.mjs');
  /* 假执行器：睡足够久，保证测试期间任务仍在 running（否则名额立刻空出来，测不出分流）。 */
  writeFileSync(slow, 'setTimeout(() => process.exit(0), 4000);\n', 'utf8');
  const d = createDispatcher({
    runnerPath: slow, opencodeRunnerPath: slow, qoderRunnerPath: slow,
    channelsProbeImpl: () => '', channelsImpl: async () => ({ channels: [], warnings: [] }),
    maxConcurrent: 8, maxConcurrentQoder: 3, maxConcurrentOpenCode: 2,
    workRoot: join(dir, 'work'), jobsFile: join(dir, 'state', 'jobs.json'),
  });
  /* 主通道 = qoder；降级目标 = opencode（与主通道**不同**）。 */
  d.setChannel({ provider: 'qoder', model: 'qoder/DeepSeek-Flash' });
  d.setFallbackTarget({ provider: 'opencode', model: 'opencode/minimax-m3.1-flash-free' });
  return d;
}
const P = { kind: 'prompt', prompt: 'x', lock: 'none', timeoutMin: 1 };

console.log('\nA. 默认关 ⇒ 绝不分流（既有行为一字不变）');
{
  const d = mk();
  try {
    const sm = d.getSplitMode();
    ok(sm.enabled === false, 'A1 默认 enabled=false');
    ok(sm.active === false && sm.reason === 'disabled', `A2 active=false 且 reason=disabled（实际 ${sm.reason}）`);
    /* 连发 5 个（主通道名额 3）⇒ 应全部落在 qoder，不出现 opencode。 */
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push(d.dispatch({ ...P, tag: `a${i}` }).id ?? d.dispatch({ ...P }).job?.id);
    const engines = ids.map((id) => d.get(id)?.engine).filter(Boolean);
    ok(engines.every((e) => e === 'qoder'), `A3 ★ 5 个全在 qoder（实际 ${JSON.stringify([...new Set(engines)])}）——关闭时绝不偷改通道`);
  } finally { d.dispose?.(); }
}

console.log('\nB. 开启后：主通道将满 ⇒ 自动分流到降级通道');
{
  const d = mk();
  try {
    d.setSplitMode({ enabled: true });
    const sm = d.getSplitMode();
    ok(sm.enabled === true && sm.active === true, `B1 开启后 active=true（实际 ${sm.active}）`);
    ok(sm.main.limit === 3 && sm.main.provider === 'qoder', `B2 主通道信息如实（qoder 名额 3，实际 ${JSON.stringify(sm.main)}）`);
    /* 连发 5 个：前 3 个占满 qoder，第 4/5 个应被分流到 opencode。 */
    const recs = [];
    for (let i = 0; i < 5; i += 1) {
      const j = d.dispatch({ ...P, tag: `b${i}` });
      const id = j.id ?? j.job?.id;
      recs.push({ id, engine: d.get(id)?.engine, provider: d.get(id)?.spec?.provider, splitFrom: d.get(id)?.spec?.splitFrom });
    }
    const qoderCount = recs.filter((r) => r.engine === 'qoder').length;
    const ocCount = recs.filter((r) => r.engine === 'opencode').length;
    ok(qoderCount === 3, `B3 ★ 前 3 个占满 qoder（实际 ${qoderCount}）`);
    ok(ocCount === 2, `B4 ★ 溢出 2 个被分流到 opencode（实际 ${ocCount}）——这就是"两条通道拿更大并发"`);
    const splitOnes = recs.filter((r) => r.engine === 'opencode');
    ok(splitOnes.every((r) => r.splitFrom === 'qoder'), `B5 ★ 被分流的 job 留痕 splitFrom=qoder（实际 ${JSON.stringify(splitOnes.map((r) => r.splitFrom))}）`);
  } finally { d.dispose?.(); }
}

console.log('\nC. 同通道不分流（分流必须是假动作之外的真分流）');
{
  const d = mk();
  try {
    /* 把降级目标设成**与主通道相同**的通道 ⇒ 应判为"无可分流目标"。 */
    d.setFallbackTarget({ provider: 'qoder', model: 'qoder/Qwen3.8-Flash' });
    d.setSplitMode({ enabled: true });
    const sm = d.getSplitMode();
    ok(sm.active === false && sm.reason === 'no-distinct-target',
      `C1 ★ 同通道 ⇒ active=false 且 reason=no-distinct-target（实际 ${sm.reason}）`);
    const recs = [];
    for (let i = 0; i < 5; i += 1) {
      const j = d.dispatch({ ...P, tag: `c${i}` });
      recs.push(d.get(j.id ?? j.job?.id)?.spec?.provider);
    }
    ok(recs.every((p) => p === 'qoder'), `C2 ★ 同通道时绝不分流（实际 ${JSON.stringify([...new Set(recs)])}）`);
  } finally { d.dispose?.(); }
}

console.log('\nC2. ★ ZB-83：**同引擎不同模型也不算可分流目标**（名额按引擎计）');
{
  const d = mk();
  try {
    /* 主通道 = qoder/DeepSeek-Flash；降级目标 = qoder/Qwen3.8-Flash ——
     * provider 不同，但**引擎都是 qoder** ⇒ 共享同一份 3 个名额 ⇒ 分流不增加并发。
     * 真机实测就踩到了这个：旧判据（比 provider）报 active=true ⇒ 给用户"并发变大了"的假象。 */
    d.setFallbackTarget({ provider: 'qoder/Qwen3.8-Flash' });
    d.setSplitMode({ enabled: true });
    const sm = d.getSplitMode();
    ok(sm.active === false && sm.reason === 'no-distinct-target',
      `C2a ★ 同引擎 ⇒ active=false（实际 ${sm.active} / reason=${sm.reason}）—— 不给"并发变大了"的假象`);
    ok((sm.distinctTargets ?? []).length === 0, 'C2b 同引擎的目标不进 distinctTargets');
    const recs = [];
    for (let i = 0; i < 5; i += 1) {
      const j = d.dispatch({ ...P, tag: `c2${i}` });
      recs.push(d.get(j.id ?? j.job?.id)?.spec?.provider);
    }
    ok(recs.every((p) => p === 'qoder'), `C2c ★ 同引擎时绝不改派（实际 ${JSON.stringify([...new Set(recs)])}）`);
  } finally { d.dispose?.(); }
}

console.log('\nD. 显式指定通道 ⇒ 不插手（尊重调用方选择）');
{
  const d = mk();
  try {
    d.setSplitMode({ enabled: true });
    /* 先占满主通道，确保"若会分流就一定会分流"的前提成立。 */
    for (let i = 0; i < 3; i += 1) d.dispatch({ ...P, tag: `d-fill${i}` });
    /* 调用方**显式**要 opencode ⇒ 它本来就该去 opencode（不算分流）；显式要 qoder ⇒ 必须留在 qoder。 */
    const j1 = d.dispatch({ ...P, provider: 'qoder/Qwen3.8-Flash', tag: 'd-explicit-qoder' });
    const live1 = d.get(j1.id ?? j1.job?.id);
    ok(live1?.spec?.provider === 'qoder' && live1?.spec?.splitFrom == null,
      `D1 ★ 显式要 qoder ⇒ 留在 qoder 且**无** splitFrom（实际 provider=${live1?.spec?.provider} splitFrom=${live1?.spec?.splitFrom}）`);
  } finally { d.dispose?.(); }
}

console.log('\nE. 目标也满 ⇒ 老实排队（不硬塞）');
{
  const d = mk();
  try {
    d.setSplitMode({ enabled: true });
    /* 连发 8 个：qoder 3 + opencode 2 = 5 能进；其余 3 个应**排队**而不是硬塞。 */
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      const j = d.dispatch({ ...P, tag: `e${i}` });
      ids.push(j.id ?? j.job?.id);
    }
    await new Promise((r) => setTimeout(r, 300));
    const states = ids.map((id) => d.get(id)?.state);
    const running = states.filter((s) => s === 'running').length;
    const queued = states.filter((s) => s === 'queued').length;
    ok(running === 5, `E1 ★ 恰好 5 个在跑（qoder 3 + opencode 2，实际 ${running}）`);
    ok(queued === 3, `E2 ★ 其余 3 个老实排队（实际 ${queued}）——不把溢出硬塞给已满的通道`);
  } finally { d.dispose?.(); }
}

console.log('\nF. 判据用"在途数"（连发时不能慢一拍）');
{
  const d = mk();
  try {
    d.setSplitMode({ enabled: true });
    /* 关键：**不等待**，连发。若判据只数 running，此刻 running=0 ⇒ 第 2/3 个不会被分流；
     * 用 running+queued 才能在第 4 个那一刻就分流。 */
    const recs = [];
    for (let i = 0; i < 4; i += 1) {
      const j = d.dispatch({ ...P, tag: `f${i}` });
      recs.push(d.get(j.id ?? j.job?.id)?.engine);
    }
    ok(recs[3] === 'opencode', `F1 ★ 连发第 4 个立即分流到 opencode（实际 ${JSON.stringify(recs)}）——只数 running 时会慢一拍`);
  } finally { d.dispose?.(); }
}

console.log('\nG. 参数校验与持久化');
{
  const d = mk();
  try {
    let threw = false;
    try { d.setSplitMode({ enabled: 'yes' }); } catch { threw = true; }
    ok(threw, 'G1 enabled 非布尔 ⇒ 报错（不静默当 false）');
    threw = false;
    try { d.setSplitMode({ minFreeSlots: 0 }); } catch { threw = true; }
    ok(threw, 'G2 minFreeSlots 越界 ⇒ 报错');
    /* 缺省字段沿用原值（不重置）—— 与 setChannel 的档位语义一致。 */
    d.setSplitMode({ enabled: true, minFreeSlots: 2 });
    const after = d.setSplitMode({ minFreeSlots: 3 });
    ok(after.enabled === true && after.minFreeSlots === 3, `G3 只改 minFreeSlots ⇒ enabled 保持 true（实际 ${JSON.stringify(after)}）`);
    /* minFreeSlots=2 ⇒ 主通道还剩 1 个名额时就开始分流（更早摊开）。 */
    const d2 = mk();
    d2.setSplitMode({ enabled: true, minFreeSlots: 2 });
    const r = [];
    for (let i = 0; i < 4; i += 1) {
      const j = d2.dispatch({ ...P, tag: `g${i}` });
      r.push(d2.get(j.id ?? j.job?.id)?.engine);
    }
    ok(r.filter((e) => e === 'opencode').length >= 1,
      `G4 ★ minFreeSlots=2 ⇒ 更早分流（前 4 个里已有 opencode，实际 ${JSON.stringify(r)}）`);
    d2.dispose?.();
  } finally { d.dispose?.(); }
}

cleanup();
console.log(`\n===== ZB-82 分流模式：${pass} PASS / ${fails.length} FAIL =====`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
process.exit(0);
