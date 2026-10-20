#!/usr/bin/env node
/**
 * thinking-verify.test.mjs —— ZB-75 真机需求回归：**逐模型档位声明 + 派发后核对档位 + 向上改档**
 *
 * 用户三条要求（2026-10-20）：
 *   ① 面板/Qoder 档位要**逐模型**（Qwen3.8-Flash = low/medium/xhigh；DeepSeek-Flash = low/high/max）；
 *   ② **派发后要核对思考档位是否符合设置**（Qoder 引擎不回报实际档位 ⇒ 用户设"极高"实际变"关闭思考"
 *      这类静默降级必须被发现）；
 *   ③ 不符时**向上改档位重试**（"优先向上改档位"）。
 *
 * 本文件钉住这三条的**核心判据**：
 *   A. 逐模型声明表存在且取值与 Qoder GUI 一致（不写死到别处、面板自动跟随）；
 *   B. `thinking-observed` 行能被 core 解析并落到 job（执行器→core 的链路）；
 *   C. 核对判据：请求要思考 + 观测 silent ⇒ 报不符；请求不思考 / 无观测 ⇒ **不算不符**（不误报）；
 *   D. 向上建议：给该模型支持的、比当前更强的**最近**一档；已是最强 ⇒ 不给建议（不瞎指）。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../core/dispatch-core.mjs';

let pass = 0;
const fails = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fails.push(m); console.log(`  ✗ ${m}`); } };

const HERE = dirname(fileURLToPath(import.meta.url));
const roots = [];
const cleanup = () => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } };

const coreSrc = readFileSync(join(HERE, '..', 'core', 'dispatch-core.mjs'), 'utf8');
const code = coreSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const qoderSrc = readFileSync(join(HERE, '..', '..', 'collab-kit', 'qoder-run.mjs'), 'utf8');

console.log('\nA. 逐模型档位声明（用户从 Qoder GUI 提供的真实矩阵）');
{
  const m = /const QODER_MODEL_LEVELS = \{([\s\S]*?)\n\};/.exec(code);
  ok(!!m, 'A1 声明表 QODER_MODEL_LEVELS 存在（逐模型档位只此一处，面板自动跟随）');
  const body = m ? m[1] : '';
  ok(/'Qwen3\.8-Flash': \['low', 'medium', 'xhigh'\]/.test(body),
    "A2 ★ Qwen3.8-Flash = low/medium/xhigh（与 Qoder GUI 模型卡片一致）");
  ok(/'DeepSeek-Flash': \['low', 'high', 'max'\]/.test(body),
    "A3 ★ DeepSeek-Flash = low/high/max（与 Qoder GUI 模型卡片一致）");
  /* 通道构造必须**优先**用它，且标注 scope（否则面板会静默退回引擎级 8 档 —— 就是用户看到的问题）。 */
  ok(/QODER_MODEL_LEVELS\[name\]/.test(code) && /thinkingLevelsScope: 'model'/.test(code),
    'A4 ★ 通道构造优先用逐模型声明，并标注 scope=model');
  ok(/thinkingLevelsScope: 'engine'/.test(code),
    'A5 未声明的模型退回引擎级并集并标注 scope=engine（诚实降级，不谎称逐模型精确）');
}

console.log('\nB. 执行器 → core 的观测信号链路');
{
  ok(/thinking-observed=\$\{/.test(qoderSrc), 'B1 执行器打 thinking-observed 行（观测到的思考状态）');
  ok(/let thinkingBlocks = 0/.test(qoderSrc) && /thinkingBlocks \+= 1/.test(qoderSrc),
    'B2 执行器统计 thinking 内容块（唯一可观测信号：none 恒 0 块、其余档位恒有块）');
  ok(/res\.thinkingObserved\.exec\(text\)/.test(code), 'B3 core 解析 thinking-observed 行');
  ok(/job\.thinkingObserved = parsed\.thinkingObserved/.test(code), 'B4 解析结果落到 job.thinkingObserved');
  /* 关键：绝不把**请求值**当成观测值（否则核对退化成"永远通过"）。 */
  ok(!/thinkingObserved: opt\.reasoningEffort/.test(qoderSrc),
    'B5 ★ 观测值不取自请求值（否则核对=永远通过，等于没核对）');
}

console.log('\nC. 核对判据（不误报是关键）');
{
  ok(/function checkThinkingApplied\(job\)/.test(code), 'C1 核对函数存在');
  ok(/THINK_OFF_LEVELS\.has\(String\(requested\)\)/.test(code),
    'C2 ★ 请求本身就是"不思考"档（none/disabled）⇒ 不算不符（silent 符合预期）');
  ok(/if \(observed !== 'silent'\) return \{ mismatch: false/.test(code),
    'C3 观测到 thinking ⇒ 相符');
  ok(/if \(observed == null\)[\s\S]{0,160}checkable: false/.test(code),
    'C4 ★ 没有观测信号 ⇒ 不判定为不符（"无法核对" ≠ "通过"，也 ≠ "不符"）');
  ok(/requested === 'agent'/.test(code), 'C5 `agent`（Agent决定）不参与核对（无预期档位可比）');
  /* 结论必须**可见**（进 parseWarnings + 结构化字段），不能只算不报。 */
  ok(/job\.parseWarnings\.push\(thinkCheck\.warning\)/.test(code),
    'C6 ★ 不符结论进 parseWarnings（面板/CLI 可见）');
  ok(/job\.thinkingMismatch = \{ requested:/.test(code),
    'C7 ★ 同时落结构化字段 thinkingMismatch（含 requested/observed/suggested）');
}

console.log('\nD. 向上改档建议（用户："优先向上改档位"）');
{
  ok(/const LEVEL_STRENGTH = \[/.test(code), 'D1 强度序 LEVEL_STRENGTH 存在（仅用于排序，不做合法性校验）');
  ok(/function suggestStrongerLevel\(job, cur\)/.test(code), 'D2 向上建议函数存在');
  /* D3 断言"**最近的**更强档"（而不是最强档）—— 用户要的是"优先向上改一档"（渐进），
   * 一次拉满会白烧额度。原实现找最强档（low → xhigh）与预期不符，已修。 */
  ok(/if \(s > ci && s < bestS\) \{ bestS = s; best = lv; \}/.test(code),
    'D3 ★ 只找比当前更强、且**最近**的一档（绝不向下/平级，也不直接拉满）');
  ok(/if \(!supported\) return null;/.test(code), 'D4 ★ 拿不到该模型支持集 ⇒ 不给建议（不猜档位）');
  ok(/if \(ci < 0\) return null;/.test(code), 'D5 语义档位（auto/agent）不参与向上比较');
  /* 建议必须来自**该模型支持的集合**（否则会建议一个必然被拒的档位）。 */
  ok(/const declared = QODER_MODEL_LEVELS\[bare\];/.test(code),
    'D6 ★ 支持集优先取逐模型声明（建议不会越出该模型的真实可选范围）');
}

console.log('\nE. 真机行为：端到端（假执行器 → 核对 → 结论）');
{
  const dir = mkdtempSync(join(tmpdir(), 'dsp-thinkverify-'));
  roots.push(dir);
  /* 假执行器：按 env 决定打哪种 thinking-observed 行（模拟"请求极高、实际关闭思考"的真机事故）。 */
  const runner = join(dir, 'fake-runner.mjs');
  writeFileSync(runner, `
const mode = process.env.DSP_FAKE_THINK || 'thinking';
const lv = process.env.DSP_FAKE_LEVEL || 'xhigh';
process.stdout.write('[qoder-run] tag=x mode=prompt cwd=.\\n');
if (mode === 'silent') process.stdout.write('[qoder-run] thinking-observed=silent blocks=0 chars=0 requested=' + lv + '\\n');
else process.stdout.write('[qoder-run] thinking-observed=thinking blocks=1 chars=90 requested=' + lv + '\\n');
process.stdout.write('[qoder-run] done exit=0 elapsed=1.0s session=ses_test responseChars=2\\n');
process.exit(0);
`, 'utf8');
  /* ⚠️ 关键：Qoder 引擎走的是 **`qoderRunnerPath`**（不是 `runnerPath` —— 后者只对 zcode 生效）。
   * 用 `runnerPath` 注入会静默跑**真实 qoder-run.mjs**（实测踩到：观测值变成默认 'thinking'）。 */
  const mk = (name) => createDispatcher({
    runnerPath: runner,
    qoderRunnerPath: runner,
    channelsProbeImpl: () => '',
    channelsImpl: async () => ({ channels: [], warnings: [] }),
    workRoot: join(dir, 'work', name),
    jobsFile: join(dir, 'state', name, 'jobs.json'),
  });
  const waitSettled = async (d, id, ms = 20000) => {
    const t0 = Date.now();
    for (;;) { const j = d.get(id); if (j && ['done', 'failed', 'killed', 'interrupted', 'paused'].includes(j.state)) return j; if (Date.now() - t0 > ms) return d.get(id); await new Promise((r) => setTimeout(r, 25)); }
  };
  const dispatch = async (d, spec) => { const j = d.dispatch(spec); return waitSettled(d, j.id ?? j?.job?.id); };

  const base = { kind: 'prompt', prompt: 'x', provider: 'qoder/Qwen3.8-Flash', lock: 'none', timeoutMin: 1 };

  process.env.DSP_FAKE_THINK = 'silent';
  process.env.DSP_FAKE_LEVEL = 'xhigh';
  const d1 = mk('mismatch');
  try {
    const j = await dispatch(d1, { ...base, reasoningLevel: 'xhigh' });
    ok(j.thinkingObserved === 'silent', `E1 观测值落到 job（实际 ${JSON.stringify(j.thinkingObserved)}）`);
    ok(!!j.thinkingMismatch, 'E2 ★ 请求 xhigh + 实际 silent ⇒ 报不符（真机"极高变关闭思考"场景）');
    ok(j.thinkingMismatch && j.thinkingMismatch.requested === 'xhigh', `E3 mismatch.requested=xhigh（实际 ${JSON.stringify(j.thinkingMismatch?.requested)}）`);
    /* Qwen3.8-Flash 声明是 low/medium/xhigh ⇒ xhigh 已是最强 ⇒ **不给**向上建议（不瞎指）。 */
    ok(j.thinkingMismatch && j.thinkingMismatch.suggested === null,
      `E4 ★ 已是最强档（xhigh）⇒ 不给向上建议（实际 ${JSON.stringify(j.thinkingMismatch?.suggested)}）`);
    ok((j.parseWarnings ?? []).some((w) => /思考档位核对不符/.test(w)), 'E5 结论进了 parseWarnings（可见）');
    /* 任务本身是成功的（只是档位没生效）⇒ 不该被判失败。 */
    ok(j.state === 'done', `E6 ★ 档位不符**不**改判任务状态（任务本身 done，实际 ${j.state}）`);
  } finally { d1.dispose?.(); }

  /* 请求 low + 实际 silent ⇒ 应建议**向上**到 medium（该模型 low 之上最近的一档）。 */
  process.env.DSP_FAKE_LEVEL = 'low';
  const d2 = mk('upward');
  try {
    const j = await dispatch(d2, { ...base, reasoningLevel: 'low' });
    ok(!!j.thinkingMismatch, 'E7 请求 low + 实际 silent ⇒ 报不符');
    ok(j.thinkingMismatch && j.thinkingMismatch.suggested === 'medium',
      `E8 ★ 向上建议 = medium（low 之上该模型支持的最近一档，实际 ${JSON.stringify(j.thinkingMismatch?.suggested)}）`);
  } finally { d2.dispose?.(); }

  /* 请求 none（本就不思考）+ 实际 silent ⇒ **不算不符**（不误报）。 */
  process.env.DSP_FAKE_LEVEL = 'none';
  const d3 = mk('noop');
  try {
    const j = await dispatch(d3, { ...base, reasoningLevel: 'none' });
    ok(!j.thinkingMismatch, 'E9 ★ 请求 none + 实际 silent ⇒ 相符（不误报）');
    ok(!(j.parseWarnings ?? []).some((w) => /思考档位核对不符/.test(w)), 'E10 不产生核对警告');
  } finally { d3.dispose?.(); }

  /* 观测到 thinking ⇒ 相符。 */
  process.env.DSP_FAKE_THINK = 'thinking';
  process.env.DSP_FAKE_LEVEL = 'xhigh';
  const d4 = mk('ok');
  try {
    const j = await dispatch(d4, { ...base, reasoningLevel: 'xhigh' });
    ok(!j.thinkingMismatch, 'E11 ★ 观测到 thinking ⇒ 相符');
  } finally { d4.dispose?.(); }

  delete process.env.DSP_FAKE_THINK;
  delete process.env.DSP_FAKE_LEVEL;
  cleanup();
}

console.log(`\n===== ZB-75 逐模型档位 + 核对 + 向上改档：${pass} PASS / ${fails.length} FAIL =====`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
process.exit(0);
