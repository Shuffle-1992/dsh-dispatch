#!/usr/bin/env node
/**
 * retry-model-switch.test.mjs —— ZB-71 真机 bug 回归：**顺序派发换模型必须真的换模型**
 *
 * 真机现场（2026-10-18，opencode 免费模型 403）：
 *   一个写任务失败后，顺序派发连跳 9 次，**10 次尝试的 result.json 里 model 全是
 *   `opencode/deepseek-v4.1-flash-free`** —— 顺序列表里配的另外 9 个模型一个都没试到。
 *
 * 根因：`retry()` 的"同通道续跑"判据只看「通道相同 + 引擎没变」。
 * 顺序派发换模型恰好满足这两条（同 provider、同引擎、只换 model）⇒ 落进 resume 分支
 * ⇒ `delete spec.model`（`--resume` 带 `--model` 必失败）把**目标模型丢掉**，新 job 仍跑旧模型。
 *
 * 本文件钉三件事：
 *   A. 换模型 ⇒ **不许**走 resume 分支（必须交接重跑，新 job 的 spec.model = 目标模型）；
 *   B. 不换模型（真续跑）⇒ 仍走 resume 分支（别把正常续跑改坏）；
 *   C. 暂停原因分类：`provider-blocked`（按 IP 封锁免费模型）能被认出来，且**不在同引擎内延续**。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatcher, classifyPause, __testables } from '../core/dispatch-core.mjs';

let pass = 0;
const fails = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fails.push(m); console.log(`  ✗ ${m}`); } };

const roots = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'dsp-retry-model-')); roots.push(d); return d; };
const cleanup = () => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } };

/** 假执行器：按 line-protocol 打一行"失败但带 sessionId"的 done 行，然后 exit 1。
 *  这样 job 会真的落到 paused（CONFIGURATION_ERROR）且 **sessionId 被解析出来** ——
 *  正是 retry 分支判据需要的两个前提（非 running + 有 sessionId），不必手工改存储对象
 *  （`get()` 返回的是克隆，改它不会落库）。 */
function fakeRunner(dir, { mode = 'fail-session' } = {}) {
  const p = join(dir, `fake-runner-${mode}.mjs`);
  const body = mode === 'fail-session'
    ? '[opencode-run] done exit=1 elapsed=0.1s session=ses_fake_1 model=opencode/deepseek-v4.1-flash-free responseChars=0\n'
      + 'process.exit(1);\n'
    : 'process.exit(0);\n';
  writeFileSync(p, `process.stderr.write(${JSON.stringify('[fake-runner] CONFIGURATION_ERROR')});\nprocess.stderr.write(${JSON.stringify('[fake-runner] CONFIGURATION_ERROR')} + "\\n");\nprocess.stdout.write(${JSON.stringify(body.split('\n')[0])} + "\\n");\nprocess.exit(1);\n`, 'utf8');
  return p;
}
const mkDispatcher = (dir, mode) => createDispatcher({
  runnerPath: fakeRunner(dir, { mode }), workRoot: join(dir, 'work'), jobsFile: join(dir, 'state', 'jobs.json'),
});

/** 轮询等 job 落到终态/paused（带总超时；不许固定 sleep）。
 *  ⚠️ 超时给足：本测试要**真 spawn 一个子进程**（假执行器），套件并行跑时 CPU 争抢会让
 *  spawn+退出明显变慢（实测单独跑 <1s，套件里偶发 >15s）⇒ 40s 余量，避免假红。 */
async function waitSettled(d, id, ms = 40000) {
  const t0 = Date.now();
  for (;;) {
    const j = d.get(id);
    if (j && (j.state === 'paused' || j.state === 'done' || j.state === 'failed' || j.state === 'killed' || j.state === 'interrupted')) return j;
    if (Date.now() - t0 > ms) return d.get(id);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 真跑一个失败任务并等落地（拿到带 sessionId 的 paused job）。
 *  返回前**确认真的落地了**（否则 retry 会抛"仍在 running"——那是测试的等待不足，不是源码缺陷）。 */
async function seedFailed(d, spec) {
  const j = d.dispatch(spec);
  const id = j.id ?? j?.job?.id;
  const settled = await waitSettled(d, id);
  if (settled && settled.state === 'running') {
    throw new Error(`测试前置失败：假执行器 ${id} 40s 内未落地（仍是 running）——属等待预算不足/机器过载，非源码缺陷`);
  }
  return id;
}

const OC = { kind: 'prompt', prompt: 'x', provider: 'opencode', engine: 'opencode', lock: 'none', timeoutMin: 1 };

console.log('\nA. 换模型 ⇒ 必须交接重跑（不许走 resume 分支）');
{
  const dir = mk();
  const d = mkDispatcher(dir, 'fail-session');
  try {
    const id = await seedFailed(d, { ...OC, model: 'opencode/deepseek-v4.1-flash-free' });
    const settled = d.get(id);
    ok(!!settled && settled.state !== 'running', `A0 任务已落地（实际 ${settled && settled.state}）`);
    ok(!!(settled && settled.sessionId), `A0b sessionId 已解析（实际 ${JSON.stringify(settled && settled.sessionId)}）`);
    const nj = d.retry(id, { provider: 'opencode', model: 'opencode/glm-5.3-flash-free' });
    ok(!!nj, 'A1 retry 返回了新 job');
    const m = nj && nj.spec && nj.spec.model;
    ok(m === 'opencode/glm-5.3-flash-free', `A2 ★ 新 job 的 model = 目标模型（实际 ${JSON.stringify(m)}）`);
    ok(nj && nj.spec && nj.spec.resume == null, 'A3 换模型时**不带** resume（--resume + --model 必失败）');
    ok(nj && nj.parentJobId === id, 'A4 新 job 记了 parentJobId（交接血缘）');
    ok(nj && Number(nj.hopCount ?? 0) === 1, `A5 hopCount 递增（实际 ${nj && nj.hopCount}）`);
  } finally { d.dispose?.(); }
}

console.log('\nB. 不换模型 ⇒ 仍走 resume 续跑（别把正常续跑改坏）');
{
  const dir = mk();
  const d = mkDispatcher(dir, 'fail-session');
  try {
    const id = await seedFailed(d, { ...OC, model: 'opencode/deepseek-v4.1-flash-free' });
    const settled = d.get(id);
    const sid = settled && settled.sessionId;
    const nj = d.retry(id, {});
    ok(!!nj, 'B1 retry 返回了新 job');
    /* sessionId 由执行器解析生成，不是固定值 ⇒ 断言"resume 等于该 job 自己的 sessionId"。 */
    ok(nj && nj.spec && nj.spec.resume === sid && !!sid,
      `B2 不换模型 ⇒ 同会话续跑（resume=${JSON.stringify(nj && nj.spec && nj.spec.resume)} = job 自己的 sessionId）`);
    ok(nj && nj.spec && nj.spec.model == null, 'B3 resume 分支不带 model（F2 纪律保持）');
  } finally { d.dispose?.(); }
}

console.log('\nC. 顺序派发起跑 + 暂停原因分类（ZB-71 第二处修复）');
{
  const dir = mk();
  const d = mkDispatcher(dir, 'fail-session');
  try {
    d.setSequential({ order: { opencode: [
      { route: 'opencode/deepseek-v4.1-flash-free', reasoningLevel: 'high' },
      { route: 'opencode/glm-5.3-flash-free', reasoningLevel: 'high' },
    ] } });
    const j = d.dispatch({ ...OC }); // model 为空 + 有顺序列表 ⇒ 顺序派发起跑
    const live = d.get(j.id ?? j?.job?.id);
    ok(live && live.spec && live.spec.model === 'opencode/deepseek-v4.1-flash-free',
      `C1 顺序派发起跑用列表第 1 项（实际 ${JSON.stringify(live && live.spec && live.spec.model)}）`);
  } finally { d.dispose?.(); }

  /* 真机原文（opencode-run 透传的 error 事件）——必须被识别成 provider-blocked。 */
  const REAL = "[opencode-run] 上游错误事件：HTTP 403 · OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address.";
  const c = classifyPause([REAL]);
  ok(c && c.reason === 'provider-blocked', `C2 ★ 403 FreeTierError ⇒ provider-blocked（实际 ${JSON.stringify(c && c.reason)}）`);
  const c2 = classifyPause(['{"type":"error","error":{"type":"FreeTierError","message":"free models aren\'t available"}}']);
  ok(c2 && c2.reason === 'provider-blocked', `C3 事件 JSON 原文也能认（实际 ${JSON.stringify(c2 && c2.reason)}）`);
  ok(__testables.AUTO_FALLBACK_REASONS.has('provider-blocked'), 'C4 provider-blocked 进自动降级链（换通道是唯一有效动作）');
  ok(__testables.NO_SEQUENTIAL_REASONS.has('provider-blocked'), 'C5 ★ provider-blocked **不在同引擎内延续**（同 IP 下换模型必然同样失败）');
  ok(__testables.NO_SEQUENTIAL_REASONS.has('config-error'), 'C6 config-error 仍不延续（既有语义保持）');
  ok(!__testables.NO_SEQUENTIAL_REASONS.has('quota-exhausted'), 'C7 quota-exhausted 仍可同引擎换模型（不误伤既有行为）');
}

cleanup();
console.log(`\n===== ZB-71 retry 换模型 + provider-blocked：${pass} PASS / ${fails.length} FAIL =====`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
process.exit(0);
