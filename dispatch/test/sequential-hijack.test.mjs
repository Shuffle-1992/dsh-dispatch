#!/usr/bin/env node
/**
 * sequential-hijack.test.mjs —— ZB-78 真机 bug 回归：**显式指定模型时，顺序链不许劫持它**
 *
 * 真机现场（2026-10-20 验证轮）：调 `dispatch({ provider: 'qoder/DeepSeek-Flash', thinking: 'max' })`
 * —— 通道 id 里**带着模型名**（工具文档推荐的常见传法）—— 落库却变成
 * `model: Qwen3.8-Flash` + `reasoningLevel: xhigh`（= 顺序列表第一项及其档位）。
 * **用户显式选定的模型与思考档位被静默改掉。**
 *
 * 根因：`sequentialChainForSpec()` 只检查 `spec.model`；而把 `qoder/<model>` 剥成 `model` 的
 * `normalizeEngineSpec()` 是在**更晚的** `dispatchRaw` 里才跑的 ⇒ 判断那一刻 `model` 仍是 null
 * ⇒ 顺序链以为"没指定模型"而接管。传 `model:` 的路径因 model 有值而侥幸正确。
 *
 * 本文件钉住四条等价传法的**行为一致性**（教学文档承诺：「显式指定了模型 ⇒ 顺序链不接管」）：
 *   A. `model: '<裸名>'`            ⇒ 保留
 *   B. `model: '<完整 id>'`         ⇒ 保留
 *   C. `provider: '<完整 id>'`      ⇒ ★ 保留（本 bug 的现场）
 *   D. 都不传                        ⇒ 顺序链接管（取列表第一项）—— 既有行为不能改坏
 * 外加：**档位也不许被顺序链覆盖**（真机现场 thinking=max 被改成 xhigh）。
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

console.log('\nA. 四种传法的一致性：显式指定模型 ⇒ 顺序链不接管');
{
  const dir = mkdtempSync(join(tmpdir(), 'dsp-hijack-'));
  roots.push(dir);
  const runner = join(dir, 'fake.mjs');
  writeFileSync(runner, 'process.exit(0);\n', 'utf8');
  const d = createDispatcher({
    runnerPath: runner, opencodeRunnerPath: runner, qoderRunnerPath: runner,
    channelsProbeImpl: () => '', channelsImpl: async () => ({ channels: [], warnings: [] }),
    workRoot: join(dir, 'work'), jobsFile: join(dir, 'state', 'jobs.json'),
  });
  const wait = async (id) => {
    for (let i = 0; i < 400; i += 1) {
      const j = d.get(id);
      if (j && ['done', 'failed', 'killed', 'paused', 'interrupted'].includes(j.state)) return j;
      await new Promise((r) => setTimeout(r, 25));
    }
    return d.get(id);
  };
  try {
    /* 顺序列表第一项 = Qwen3.8-Flash（与真机现场一致）⇒ 被劫持时会变成它。 */
    d.setSequential({ order: { qoder: ['qoder/Qwen3.8-Flash', 'qoder/DeepSeek-Flash'] } });
    const cases = [
      ['A 传 model 裸名', { provider: 'qoder', model: 'DeepSeek-Flash' }, 'DeepSeek-Flash'],
      ['B 传 model 完整 id', { provider: 'qoder', model: 'qoder/DeepSeek-Flash' }, 'DeepSeek-Flash'],
      ['C ★ 传 provider 完整 id（本 bug 现场）', { provider: 'qoder/DeepSeek-Flash' }, 'DeepSeek-Flash'],
    ];
    for (const [label, extra, want] of cases) {
      const j = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', timeoutMin: 1, tag: 'h', ...extra });
      const live = await wait(j.id ?? j.job?.id);
      ok(live.spec?.model === want,
        `${label} ⇒ model 保留为 ${want}（实际 ${JSON.stringify(live.spec?.model)}）`);
    }
    /* D：都不传 ⇒ 顺序链**应当**接管（既有行为，不能改坏）。 */
    const jd = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', timeoutMin: 1, tag: 'h', provider: 'qoder' });
    const liveD = await wait(jd.id ?? jd.job?.id);
    ok(liveD.spec?.model === 'Qwen3.8-Flash',
      `D 都不传 ⇒ 顺序链接管取第一项（实际 ${JSON.stringify(liveD.spec?.model)}）`);

    console.log('\nB. 档位也不许被顺序链覆盖');
    const jt = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', timeoutMin: 1, tag: 'h2', provider: 'qoder/DeepSeek-Flash', reasoningLevel: 'max' });
    const liveT = await wait(jt.id ?? jt.job?.id);
    ok(liveT.spec?.model === 'DeepSeek-Flash', `B1 model 保留（实际 ${JSON.stringify(liveT.spec?.model)}）`);
    ok(liveT.spec?.reasoningLevel === 'max',
      `B2 ★ 显式档位 max 保留（不被列表第一项的档位覆盖，实际 ${JSON.stringify(liveT.spec?.reasoningLevel)}）`);
    /* 反例：不传档位时，顺序链**可以**用列表第一项配的档位（既有语义）。 */
    d.setSequential({ order: { qoder: ['qoder/Qwen3.8-Flash'] }, levels: { qoder: ['xhigh'] } });
    const jd2 = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', timeoutMin: 1, tag: 'h3', provider: 'qoder' });
    const liveD2 = await wait(jd2.id ?? jd2.job?.id);
    ok(liveD2.spec?.model === 'Qwen3.8-Flash', 'B3 不指定 ⇒ 顺序链取第一项（既有行为保持）');
  } finally { d.dispose?.(); }
}

cleanup();
console.log(`\n===== ZB-78 顺序链不劫持显式模型：${pass} PASS / ${fails.length} FAIL =====`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
process.exit(0);
