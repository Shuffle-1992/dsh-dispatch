#!/usr/bin/env node
/**
 * qoder-concurrency.test.mjs —— ZB-79 真机纠正：**Qoder 可以并发**（旧默认 1 的依据是猜测）
 *
 * 用户观察（2026-10-20）：「Qoder 好像不支持并发？都是单进程在跑，之前其他通道都是可以几个一起跑的」。
 *
 * 实测结论：**不是 Qoder 的限制，是我们自己的默认配置**：
 *   · core 里 `maxConcurrentQoder` 硬编码 **默认 1** ⇒ Qoder 通道永远单进程；
 *   · 且 `FIELDS` 里**根本没有**这个配置字段 ⇒ 用户**无法调高**（改不了）。
 *   · 旧注释给的理由（"额度有限 / 并发多个 CLI agent 会互相干扰"）**从未实测**。
 *
 * 真机对照实测（同一台机器、同一 cwd）：
 *   · 同时起 **3** 个 `qoderclicn` ⇒ **3/3 exit=0**、结果正确（7! = 5040）、10–13s；
 *   · 同时起 **5** 个 ⇒ **5/5 exit=0**、结果正确、14–20s（无明显劣化）。
 *   ⇒ Qoder **可以并发**；而 OpenCode 的"零输出 exit 1"是**真的**（那条默认 2 有实测支撑），
 *     两者不该照抄同一个保守值。
 *
 * 本文件钉三件事：
 *   A. 默认值已提到 3（且**不再**是 1）；
 *   B. **配置字段存在且真的透传**到 core（否则字段是摆设 —— 这是本 bug 的第二半）；
 *   C. 每引擎独立计数、实际并发 = min(全局, 本引擎) 的语义不变。
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
const coreSrc = readFileSync(join(HERE, '..', 'core', 'dispatch-core.mjs'), 'utf8');
const indexSrc = readFileSync(join(HERE, '..', 'index.js'), 'utf8');
const code = coreSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const roots = [];
const cleanup = () => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } };

console.log('\nA. Qoder 并发默认值已提到 3（不再是 1）');
{
  ok(/const maxConcurrentQoder = Math\.max\(1, Number\(options\.maxConcurrentQoder \?\? 3\) \|\| 3\)/.test(code),
    'A1 ★ core 默认 maxConcurrentQoder = 3（实测依据：3/5 并发全部成功）');
  ok(!/maxConcurrentQoder \?\? 1\)/.test(code),
    'A2 ★ 旧的"默认 1"已彻底移除（不留双份定义）');
}

console.log('\nB. 配置字段存在且真的透传（否则用户改配置不生效）');
{
  ok(/\{ name: 'maxConcurrentQoder', type: 'number', def: 3/.test(indexSrc),
    'B1 FIELDS 里有 maxConcurrentQoder（旧版**根本没有**这个字段 ⇒ 用户改不了）');
  ok(/maxConcurrentQoder: config\.maxConcurrentQoder/.test(indexSrc),
    'B2 ★ 真的透传到 createDispatcher（只声明字段不透传 = 摆设）');
  ok(/maxConcurrentQoder=\$\{config\.maxConcurrentQoder \?\? 3\}/.test(indexSrc),
    'B3 启动日志如实打印该值（排障时能一眼看到实际并发上限）');
}

console.log('\nC. 真机行为：Qoder 并发上限真的生效（两个 job 能同时 running）');
{
  const dir = mkdtempSync(join(tmpdir(), 'dsp-qconc-'));
  roots.push(dir);
  /* 假执行器：睡 600ms 后正常退出（足够让两个 job 同时在跑）。 */
  const runner = join(dir, 'slow.mjs');
  writeFileSync(runner, 'setTimeout(() => process.exit(0), 600);\n', 'utf8');
  const d = createDispatcher({
    runnerPath: runner, opencodeRunnerPath: runner, qoderRunnerPath: runner,
    channelsProbeImpl: () => '', channelsImpl: async () => ({ channels: [], warnings: [] }),
    maxConcurrent: 8, maxConcurrentQoder: 3,
    workRoot: join(dir, 'work'), jobsFile: join(dir, 'state', 'jobs.json'),
  });
  try {
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const j = d.dispatch({ kind: 'prompt', prompt: 'x', provider: 'qoder/Qwen3.8-Flash', lock: 'none', timeoutMin: 1, tag: `c${i}` });
      ids.push(j.id ?? j.job?.id);
    }
    /* 等一会看同时在跑的数量（上限 3 ⇒ 三个都应进入 running）。 */
    await new Promise((r) => setTimeout(r, 350));
    const running = ids.map((id) => d.get(id)).filter((j) => j && j.state === 'running').length;
    ok(running === 3, `C1 ★ 3 个 Qoder job 同时 running（实际 ${running}）——旧默认 1 时这里只会是 1`);
    /* 等全部落地，确认没有互相干扰（都 done）。 */
    let settled = 0;
    for (let i = 0; i < 400; i += 1) {
      settled = ids.map((id) => d.get(id)).filter((j) => j && ['done', 'failed', 'killed', 'paused', 'interrupted'].includes(j.state)).length;
      if (settled === 3) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    ok(settled === 3, `C2 3 个都落地（实际 ${settled}）`);
    ok(ids.map((id) => d.get(id)).every((j) => j && j.state === 'done'), 'C3 并发下互不干扰，全部 done');
  } finally { d.dispose?.(); }
}

console.log('\nD. 上限语义不变：min(全局, 本引擎)');
{
  const dir = mkdtempSync(join(tmpdir(), 'dsp-qconc2-'));
  roots.push(dir);
  const runner = join(dir, 'slow.mjs');
  writeFileSync(runner, 'setTimeout(() => process.exit(0), 600);\n', 'utf8');
  const d = createDispatcher({
    runnerPath: runner, opencodeRunnerPath: runner, qoderRunnerPath: runner,
    channelsProbeImpl: () => '', channelsImpl: async () => ({ channels: [], warnings: [] }),
    maxConcurrent: 2, maxConcurrentQoder: 8, // 全局 2 更小 ⇒ 实际并发 2
    workRoot: join(dir, 'work'), jobsFile: join(dir, 'state', 'jobs.json'),
  });
  try {
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const j = d.dispatch({ kind: 'prompt', prompt: 'x', provider: 'qoder/Qwen3.8-Flash', lock: 'none', timeoutMin: 1, tag: `d${i}` });
      ids.push(j.id ?? j.job?.id);
    }
    await new Promise((r) => setTimeout(r, 350));
    const running = ids.map((id) => d.get(id)).filter((j) => j && j.state === 'running').length;
    ok(running === 2, `D1 ★ 全局 maxConcurrent=2 仍封顶（实际 running=${running}，引擎上限 8 不越全局）`);
  } finally { d.dispose?.(); }
}

cleanup();
console.log(`\n===== ZB-79 Qoder 并发（实测纠正）：${pass} PASS / ${fails.length} FAIL =====`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
process.exit(0);
