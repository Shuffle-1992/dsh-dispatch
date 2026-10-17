// ZB-61 回归测试：`action=list` 的**紧凑形状 + 有界条数**。
//
// 现场问题（2026-10-17 真机）：一次 `dispatch action=list` 的工具结果被宿主
// `@deepseek-ai/dsh-spill-policy` 判为超预算 ⇒ **从中间截断**，模型只拿到首尾两段 +
// 「Omitted 70693 bytes」提示，中间的 job 完全读不到。实测本机 96 条历史 job：
// slimJob 形状 212 KB；紧凑形状 25.5 KB（前 50 条 ≈13 KB）。
//
// 本测试钉住三件事：
//   ① briefJob 是**纯投影**：只留"挑下一个动作"的字段，且**必须保留 lockWait**（ZB-28 排队可观测，
//      也是 lock-queue-visibility.test.mjs 依赖的既有契约）；
//   ② `list` 默认 brief + 默认 50 条 + 省略条数写进 note（**不静默截断**）；
//   ③ `full=true` 回到旧形状；`limit` 有上限。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { createActionHandler, briefJob, slimJob, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX } from '../wire.host.mjs';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log(`  ✓ ${m}`); };
const eq = (a, b, m) => { assert.equal(a, b, m); pass += 1; console.log(`  ✓ ${m}`); };

/** 造一条形态与 core serialize 后一致的 job（含长 body / lockPaths / progress / attempts）。 */
function makeJob(i, over = {}) {
  const state = over.state ?? 'done';
  const queuedAt = new Date(Date.UTC(2026, 9, 17, 9, 0, i)).toISOString();
  return {
    id: `j-test-${String(i).padStart(3, '0')}`,
    state,
    engine: 'opencode',
    model: 'opencode/deepseek-v4.1-flash-free',
    provider: 'opencode',
    queuedAt,
    startedAt: queuedAt,
    finishedAt: state === 'done' ? queuedAt : null,
    elapsedSec: 12.5,
    exitCode: state === 'done' ? 0 : null,
    responseChars: 42,
    turnCount: 2,
    contextRatio: 0.11,
    tailLines: ['a', 'b', 'c'],
    /* 大字段：正是必须被投影剪掉的部分 */
    lockPaths: { 'file:f:/proj/a.ts': 'F:/locks/hash.lock' },
    progress: { stage: 'run', elapsedSec: 10, chars: 5, tools: 31, lastTool: 'write', stageAgoSec: 0 },
    parseWarnings: ['w1', 'w2'],
    usage: { requests: 3, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 },
    attempts: state === 'done' ? [] : [{ jobId: 'j-test-000', provider: 'plan', model: 'GLM-5.3', reason: 'x', at: queuedAt }],
    hopCount: state === 'done' ? 0 : 1,
    spec: {
      kind: 'prompt',
      prompt: `P${i}-` + '长'.repeat(1900), // 2000 字级别的派发原文（真实数据里最大的一项）
      model: 'opencode/deepseek-v4.1-flash-free',
      provider: 'opencode',
      engine: 'opencode',
      auto: false,
      mode: null,
      cwd: 'F:\\My Code\\dsh-dispatch',
      lock: 'repo',
      timeoutMin: 5,
      reasoningLevel: 'disabled',
      memoryBench: false,
      tag: `T${i}`,
      write: [],
    },
    ...over,
  };
}

/** 最小 dispatcher 桩：createActionHandler 的 list 分支只用到 list()/jobsFile。 */
function fakeDispatcher(jobs, dir) {
  return {
    jobsFile: join(dir, 'jobs.json'),
    list: () => jobs.map((j) => JSON.parse(JSON.stringify(j))),
  };
}

const dir = mkdtempSync(join(tmpdir(), 'dsp-list-'));
try {
  const jobs = Array.from({ length: 60 }, (_, i) => makeJob(i));
  /* 让排序可断言：running → queued → paused → 终态（core 的 list() 已排序，这里桩里照排）。 */
  jobs[0].state = 'running';
  jobs[1].state = 'queued';
  jobs[2].state = 'paused';
  jobs[2].pauseReason = 'quota-exhausted';
  jobs[2].pauseDetail = 'Coding Plan 5h 窗口已满';
  jobs[3].lockWait = { position: 1, ahead: 1, aheadIds: ['j-test-000'], blockers: [{ lock: 'repo', holderJobId: 'j-test-000', holderTag: 'T0', runningSec: 30, estWaitSec: 120 }], estWaitSec: 120 };
  const d = fakeDispatcher(jobs, dir);
  const handle = createActionHandler(d, {});

  console.log('① briefJob：纯投影，剪掉大字段、留住选动作必需的字段');
  {
    const brief = briefJob(jobs[0]);
    ok(brief && brief.id === 'j-test-000', 'A1 保留 id');
    eq(brief.state, 'running', 'A2 保留 state');
    eq(brief.model, 'opencode/deepseek-v4.1-flash-free', 'A3 保留 model');
    eq(brief.tag, 'T0', 'A4 保留 tag');
    eq(brief.kind, 'prompt', 'A5 保留 kind');
    ok(!('spec' in brief), 'A6 不含 spec（派发原文不进列表）');
    ok(!('lockPaths' in brief), 'A7 不含 lockPaths（本机绝对路径）');
    ok(!('usage' in brief), 'A8 不含 usage');
    ok(!('parseWarnings' in brief), 'A9 不含 parseWarnings');
    eq(brief.tailCount, 3, 'A10 tailCount 仍然可见（知道有没有输出可取）');
    eq(brief.stage, 'run', 'A11 progress 只投影 stage');
    eq(brief.lastTool, 'write', 'A12 lastTool 保留');
    ok(briefJob(null) === null, 'A13 briefJob(null) → null（不抛）');
    ok(briefJob({}) !== null, 'A14 空 job 也返回记录（不抛）');
  }

  console.log('\n② list 默认：紧凑 + 有界 + 省略写进 note');
  {
    const res = await handle('list', {});
    eq(res.ok, true, 'B1 ok:true');
    eq(res.shape, 'brief', 'B2 shape=brief（默认紧凑）');
    eq(res.total, 60, 'B3 total = 全量条数');
    eq(res.jobs.length, LIST_LIMIT_DEFAULT, `B4 默认只回 ${LIST_LIMIT_DEFAULT} 条`);
    eq(res.counts.running, 1, 'B5 counts.running');
    eq(res.counts.queued, 1, 'B6 counts.queued');
    eq(res.counts.paused, 1, 'B7 counts.paused');
    eq(res.counts.done, 57, 'B8 counts.done');
    ok(typeof res.note === 'string' && res.note.includes('已省略 10 条'), 'B9 note 写明省略条数（不静默）');
    ok(res.note.includes('limit=') && res.note.includes('full=true'), 'B10 note 给出取更多/取完整的方法');
    ok(res.jobs.every((j) => !('spec' in j)), 'B11 每一条都不带 spec');
  }

  console.log('\n③ lockWait 必须透传（ZB-28 / lock-queue-visibility 的既有契约）');
  {
    const res = await handle('list', {});
    const jb = res.jobs.find((j) => j.id === 'j-test-003');
    ok(jb && jb.lockWait, 'C1 紧凑形状保留 lockWait');
    eq(jb.lockWait.blockers[0].holderTag, 'T0', 'C2 blockers 内容完整');
  }

  console.log('\n④ limit / full / 上限');
  {
    const five = await handle('list', { limit: 5 });
    eq(five.jobs.length, 5, 'D1 limit=5 生效');
    ok(five.note.includes('已省略 55 条'), 'D2 省略数按 limit 重算');
    const big = await handle('list', { limit: 9999 });
    eq(big.jobs.length, 60, 'D3 超上限时只受实际条数约束');
    eq(big.note, undefined, 'D4 全量返回时不给 note');
    const zero = await handle('list', { limit: 0 });
    eq(zero.jobs.length, LIST_LIMIT_DEFAULT, 'D5 limit=0 视为未给（回默认，不清空列表）');
    const full = await handle('list', { full: true, limit: 3 });
    eq(full.shape, 'full', 'D6 full=true → shape=full');
    ok(full.jobs.every((j) => j.spec && typeof j.spec.body === 'string' && j.spec.body.length > 0), 'D7 full 形状带 spec.body（旧行为保留）');
    ok(full.jobs.every((j) => 'progress' in j && 'usage' in j), 'D8 full 形状带 progress/usage');
    eq(full.jobs.length, 3, 'D9 full 同样受 limit 约束（避免又造出数百 KB）');
    ok(LIST_LIMIT_MAX >= 200, 'D10 上限常量存在且 ≥200');
  }

  console.log('\n⑤ 体积守卫：紧凑形状必须显著小于旧形状（否则本改动毫无意义）');
  {
    const briefSize = JSON.stringify((await handle('list', { limit: 60 })).jobs).length;
    const fullSize = JSON.stringify((await handle('list', { full: true, limit: 60 })).jobs).length;
    ok(briefSize * 4 < fullSize, `E1 紧凑 < 旧形状的 1/4（实际 ${briefSize} B vs ${fullSize} B）`);
    ok(briefSize < 30_000, `E2 60 条紧凑载荷 < 30 KB（实际 ${(briefSize / 1024).toFixed(1)} KB）`);
  }

  console.log('\n⑥ dismissed.json 仍在 list 里被过滤（既有行为不回退）');
  {
    /* ⚠️ dismissed 集合在 wire 层**按文件路径进程内缓存**（dismissedByFile），首次读取后不再重读
     * —— 这是既有设计（dismiss 动作写的是同一份缓存）。所以本用例必须换一个**新目录 + 新 handler**，
     * 并在第一次 list 之前就把 dismissed.json 放好，否则测的是"缓存不回读"而不是过滤逻辑。 */
    const dir2 = mkdtempSync(join(tmpdir(), 'dsp-list-dis-'));
    try {
      writeFileSync(join(dir2, 'dismissed.json'), JSON.stringify(['j-test-000', 'j-test-001']));
      const handle2 = createActionHandler(fakeDispatcher(jobs, dir2), {});
      const res = await handle2('list', { limit: 3 });
      ok(!res.jobs.some((j) => j.id === 'j-test-000'), 'F1 已关闭的 job 不出现在列表');
      eq(res.total, 58, 'F2 total 也不含已关闭的 job');
    } finally {
      try { rmSync(dir2, { recursive: true, force: true }); } catch { /* Windows 句柄抖动 */ }
    }
  }
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄抖动 */ }
}

console.log(`\nlist-compact: ${pass} 项断言全部通过`);
