/**
 * ZCode 派发核心 自测（零依赖，node --test 语义，退出码可靠）。
 * 运行：node test/core.test.mjs
 *
 * 通过 env DSP_FAKE_RUNNER 注入假 runner（test/fixtures/fake-runner.mjs），
 * 不做任何真实派发；真实冒烟见交付文档。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { createDispatcher, parseRunnerLine } from '../core/dispatch-core.mjs';
/* ZB-44（双引擎）：**新增 import（独立一行，不改上面既有 import 行）** —— 用于钉住
 * 档位表行的引擎差异（zcode `reasoning-levels` / opencode `variants` 走同一段实现）。 */
import { parseProviderTable } from '../core/dispatch-core.mjs';
import { aggregate, fetchPlanQuota } from '../core/quota.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs');
const REAL_RUNNER_MISSING = join(HERE, 'fixtures', 'no-such-runner.mjs'); // 故意不存在

process.env.DSP_FAKE_RUNNER = FAKE_RUNNER;

const tempDirs = [];
function newWorkRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'dsp-test-'));
  tempDirs.push(dir);
  return dir;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitForTerminal(d, id, timeoutMs = 20000) {
  return new Promise((res, rej) => {
    /* ⚠️ 必须先查当前状态，再订阅事件。
     * 原因（ZB-51 实测）：某些失败是**同步**的 —— 例如"执行器不存在"会在 dispatch() 内立刻
     * finalizeJob ⇒ `job-updated` 在调用方拿到 id 之前就发完了。只靠订阅会永远等不到（20s 超时）。
     * 这也说明这个更快失败的路径是好事，测试助手补上状态检查即可。 */
    const cur = d.get(id);
    if (cur && ['done', 'failed', 'killed', 'interrupted'].includes(cur.state)) { res(cur); return; }
    const timer = setTimeout(() => {
      un();
      rej(new Error(`waitForTerminal(${id}) 超时 ${timeoutMs}ms，最后状态: ${JSON.stringify(d.get(id))}`));
    }, timeoutMs);
    const un = d.subscribe((ev) => {
      if (ev.type === 'job-updated' && ev.job.id === id && ['done', 'failed', 'killed', 'interrupted'].includes(ev.job.state)) {
        clearTimeout(timer);
        un();
        res(ev.job);
      }
    });
  });
}
async function waitFor(pred, what, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`waitFor(${what}) 超时`);
}

test('并发 3 个 dispatch（maxConcurrent=1）→ 执行区间不重叠且 FIFO', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1 });
  /* ZB-16：lock 枚举改为 repo|none（memory/both 已删除）。此处用默认（repo）即可 ——
   * 三个任务都要整仓库锁 ⇒ 在 maxConcurrent=1 下必然串行，测的就是这个。 */
  const j1 = d.dispatch({ kind: 'prompt', prompt: 'a', lock: 'repo', tag: 't1' });
  const j2 = d.dispatch({ kind: 'prompt', prompt: 'b', lock: 'repo', tag: 't2' });
  const j3 = d.dispatch({ kind: 'prompt', prompt: 'c', lock: 'repo', tag: 't3' });

  const snapMid = d.snapshot();
  assert.doesNotThrow(() => JSON.stringify(snapMid), 'snapshot 运行中必须可 JSON.stringify');
  assert.equal(snapMid.jobs.length, 3);
  assert.equal(snapMid.counts.queued, 2, '运行中应有 2 个排队');
  assert.ok(snapMid.locks.repo && snapMid.locks.repo.jobId === j1.id, 'repo 锁内容应含 jobId');

  const [a, b, c] = await Promise.all([
    waitForTerminal(d, j1.id), waitForTerminal(d, j2.id), waitForTerminal(d, j3.id),
  ]);
  for (const j of [a, b, c]) assert.equal(j.state, 'done');

  const intervals = [a, b, c].map((j) => ({ id: j.id, s: Date.parse(j.startedAt), e: Date.parse(j.finishedAt) }))
    .sort((x, y) => x.s - y.s);
  for (let i = 1; i < intervals.length; i += 1) {
    assert.ok(
      intervals[i].s >= intervals[i - 1].e,
      `执行区间重叠: job${i - 1} [${intervals[i - 1].s},${intervals[i - 1].e}] 与 job${i} [${intervals[i].s},${intervals[i].e}]`,
    );
  }
  // FIFO：启动顺序 = 派发顺序
  assert.deepEqual(intervals.map((x) => x.id), [j1.id, j2.id, j3.id]);
  // 解析完整性：假 runner 的汇总行都被吃掉
  assert.equal(a.sessionId.startsWith('sess_fake-'), true);
  assert.equal(a.usage.requests, 1);
  assert.equal(a.usage.inputTokens, 100);
  assert.equal(a.usage.outputTokens, 50);
  assert.equal(a.usage.cacheReadTokens, 10);
  assert.equal(a.contextUsed, 1234);
  assert.equal(a.contextWindow, 200000);
  assert.equal(a.responseChars, 2);
  assert.equal(a.outLog, 'C:\\fake dir with space\\run.out.log', '含空格路径解析');
  assert.equal(a.resultFile, 'C:\\fake dir with space\\run.result.json');
  assert.equal(a.provider, 'plan:bigmodel-coding-plan');
  assert.deepEqual(a.parseWarnings, []);
});

test('ZB-16 锁模型：不同文件集可并行、同文件集排队 FIFO、锁文件内容与释放', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  /* 旧版测的是 repo/memory 跨锁并行；ZB-16 删除 memory 后，等价语义由**文件级锁**表达：
   * A 锁 a.ts、B 锁 b.ts ⇒ 无竞写关系 ⇒ 可并行（这正是用户要的"不同文件允许并发"）。 */
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', write: ['F:/t/a.ts'], tag: 'A' });
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', write: ['F:/t/b.ts'], tag: 'B' });
  await waitFor(() => d.get(a.id).state === 'running' && d.get(b.id).state === 'running', 'A/B 并行运行');
  assert.ok(Date.parse(d.get(a.id).startedAt) < Date.now(), 'A 已启动');

  // 文件锁的锁体内容（原用例测 repo.lock 内容，现改为测文件锁锁体）
  const aLock = d.listFileLocks().find((l) => l.jobId === a.id);
  assert.ok(aLock, 'A 应持有一把文件锁');
  assert.equal(aLock.jobId, a.id);
  assert.equal(aLock.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(aLock.at)));

  // C 与 A 写同一文件 ⇒ 排队；E 与 A、C 都不同文件？—— E 写 a.ts 故也排队（FIFO）
  const c = d.dispatch({ kind: 'prompt', prompt: 'c', write: ['F:/t/a.ts'], tag: 'C' });
  const e = d.dispatch({ kind: 'prompt', prompt: 'e', write: ['F:/t/a.ts'], tag: 'E' });
  assert.equal(d.get(c.id).state, 'queued', 'C 等 a.ts 锁');
  assert.equal(d.get(e.id).state, 'queued', 'E 等 a.ts 锁');

  const [ja, jb, jc, je] = await Promise.all([
    waitForTerminal(d, a.id), waitForTerminal(d, b.id), waitForTerminal(d, c.id), waitForTerminal(d, e.id),
  ]);
  assert.match(ja.lock, /^file:.*a\.ts$/, 'A 持文件锁');
  assert.match(jb.lock, /^file:.*b\.ts$/, 'B 持另一文件锁');
  assert.ok(Date.parse(jc.startedAt) >= Date.parse(ja.finishedAt), 'C 必须在 A 释放 a.ts 之后');
  assert.ok(Date.parse(je.startedAt) >= Date.parse(jc.finishedAt), 'E 按 FIFO 在 C 之后');
  assert.equal(d.listFileLocks().length, 0, '结束后文件锁应全部释放');
  assert.ok(!existsSync(d.lockPaths.repo), 'repo 锁未被使用（本用例全走文件锁）');
});

test('kill()：running → killed 且退出码非 0；queued → 直接 killed 不再启动', async () => {
  process.env.FAKE_SLEEP_MS = '60000';
  try {
    const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1 });
    const a = d.dispatch({ kind: 'prompt', prompt: 'long', tag: 'kill-A' });
    const b = d.dispatch({ kind: 'prompt', prompt: 'long', tag: 'kill-B' });
    await waitFor(() => d.get(a.id).state === 'running', 'A running');
    assert.equal(d.get(b.id).state, 'queued');

    assert.equal(d.kill(b.id), true, 'queued kill 生效');
    assert.equal(d.get(b.id).state, 'killed');
    assert.equal(d.get(b.id).startedAt, null, 'queued 被 kill 不应启动');
    assert.equal(d.kill('no-such-id'), false);

    assert.equal(d.kill(a.id), true, 'running kill 生效');
    const ja = await waitForTerminal(d, a.id);
    assert.equal(ja.state, 'killed');
    assert.ok(ja.exitCode !== 0, `killed 退出码应非 0，实际 ${ja.exitCode}`);
    assert.ok(!existsSync(d.lockPaths.repo), 'kill 后锁释放');
    // 终态后再 kill → false
    assert.equal(d.kill(a.id), false);
  } finally {
    delete process.env.FAKE_SLEEP_MS;
  }
});

test('dispatcher 看门狗：超过 timeoutMin+grace 强杀并标 timedOut', async () => {
  process.env.FAKE_SLEEP_MS = '10000';
  try {
    const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), timeoutGraceSec: 0 });
    const j = d.dispatch({ kind: 'prompt', prompt: 'slow', timeoutMin: 0.02 }); // 1.2s
    const done = await waitForTerminal(d, j.id);
    assert.equal(done.state, 'killed');
    assert.equal(done.timedOut, true);
    assert.ok(done.elapsedSec < 5, `应在 ~1.2s 被杀，实际 ${done.elapsedSec}s`);
  } finally {
    delete process.env.FAKE_SLEEP_MS;
  }
});

test('台账回读合并：补缺字段、坏行不崩、sessionId 不匹配时不误绑', async () => {
  const work = newWorkRoot();
  const ledger = join(work, 'ledger.jsonl');
  writeFileSync(
    ledger,
    [
      JSON.stringify({ at: new Date().toISOString(), tag: 'old-run', requests: 9, inputTokens: 9 }),
      'THIS IS NOT JSON',
      JSON.stringify({
        at: new Date().toISOString(), tag: 'merge-test', mode: 'edit', kind: 'prompt', billing: 'zcode-plan',
        provider: 'plan:bigmodel-coding-plan', endpoint: 'https://ledger.example/api', model: 'GLM-5.3-Flash',
        sessionId: 'sess_ledger_A', exit: 0, elapsedSec: 9.9, requests: 7, inputTokens: 700,
        outputTokens: 70, cacheReadTokens: 7, contextUsed: 555, contextWindow: 200000, responseChars: null,
      }),
      '',
    ].join('\n'),
  );

  process.env.FAKE_SKIP = 'usage,context';
  process.env.FAKE_SESSION = 'sess_ledger_A';
  try {
    const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: work, ledgerPath: ledger });
    const a = d.dispatch({ kind: 'prompt', prompt: 'm', tag: 'merge-test' });
    const ja = await waitForTerminal(d, a.id);
    assert.equal(ja.ledgerMatched, true);
    assert.equal(ja.usage.requests, 7, 'usage 行缺失时应由台账补全');
    assert.equal(ja.usage.inputTokens, 700);
    assert.equal(ja.usage.outputTokens, 70);
    assert.equal(ja.usage.cacheReadTokens, 7);
    assert.equal(ja.contextUsed, 555, 'context 行缺失时由台账补全');
    assert.equal(ja.contextWindow, 200000);
    assert.equal(ja.billing, 'zcode-plan');
    assert.equal(ja.responseChars, 2, 'stdout 已解析的字段不被台账覆盖');
    assert.equal(ja.sessionId, 'sess_ledger_A');
    assert.ok(ja.parseWarnings.some((w) => w.includes('1 unparsable line')), '坏行应记 warning');
    assert.ok(!ja.parseWarnings.some((w) => w.includes('no [zcode-run] summary')), '有解析结果不应有 no-summary 警告');

    // 同 tag 但 sessionId 不同 → 不误绑旧记录
    process.env.FAKE_SESSION = 'sess_other_B';
    const b = d.dispatch({ kind: 'prompt', prompt: 'm2', tag: 'merge-test' });
    const jb = await waitForTerminal(d, b.id);
    assert.equal(jb.ledgerMatched, false, 'sessionId 不匹配不得绑定台账');
    assert.equal(jb.usage.requests, null, '无 usage 行且无台账匹配 → 保持 null');
    assert.ok(!jb.parseWarnings.some((w) => w.includes('no [zcode-run] summary')), '有 done 行就不该有 no-summary 警告');
  } finally {
    delete process.env.FAKE_SKIP;
    delete process.env.FAKE_SESSION;
  }
});

test('quota.aggregate：窗口边界（5h 半开/周一起/当日零点）、坏行计数、文件缺失不崩', async () => {
  const work = newWorkRoot();
  const ledger = join(work, 'ledger.jsonl');
  const now = new Date(2026, 8, 30, 12, 0, 0); // 本地 2026-09-30 12:00
  const nowMs = now.getTime();
  const start5h = nowMs - 5 * 60 * 60 * 1000;
  const dow = now.getDay();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((dow + 6) % 7)).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  assert.equal(new Date(monday).getDay(), 1, '周一基准');

  const rec = (atMs, model, billing, toks) =>
    JSON.stringify({
      at: new Date(atMs).toISOString(), tag: 'x', model, billing, requests: 1,
      inputTokens: toks[0], outputTokens: toks[1], cacheReadTokens: toks[2], elapsedSec: 10,
    });
  writeFileSync(
    ledger,
    [
      rec(start5h, 'M1', 'zcode-plan', [10, 1, 0]), // 恰在 5h 边界 → 不入 last5h（半开区间）
      rec(start5h + 1000, 'M1', 'zcode-plan', [20, 2, 0]), // 入全部窗口
      rec(monday, 'M2', 'personal-api-key', [30, 3, 0]), // 恰在周一零点 → 入 week
      rec(monday - 60000, 'M2', 'personal-api-key', [40, 4, 0]), // 上周日 → 仅 total
      rec(nowMs + 3600000, 'M1', 'zcode-plan', [50, 5, 0]), // 未来 → 仅 total
      'BROKEN LINE',
      '',
    ].join('\n'),
  );

  const agg = aggregate({ ledgerPath: ledger, now });
  assert.equal(agg.available, true);
  assert.equal(agg.skippedLines, 1);
  const w = agg.windows;
  assert.deepEqual([w.last5h.runs, w.last5h.inputTokens], [1, 20]);
  assert.deepEqual([w.week.runs, w.week.inputTokens], [3, 60]);
  assert.deepEqual([w.today.runs, w.today.inputTokens], [2, 30]);
  assert.deepEqual([w.total.runs, w.total.inputTokens], [5, 150]);
  assert.equal(w.last5h.since, new Date(start5h).toISOString());
  assert.equal(w.week.since, new Date(monday).toISOString());
  assert.equal(w.today.since, new Date(today).toISOString());
  assert.equal(w.last5h.totalTokens, 22); // 20+2+0
  assert.deepEqual(agg.byModel.M1.runs, 3);
  assert.deepEqual(agg.byModel.M2.runs, 2);
  assert.deepEqual(agg.byBilling['zcode-plan'].runs, 3);
  assert.deepEqual(agg.byBilling['personal-api-key'].runs, 2);

  // 台账缺失：零值 + available:false，不抛
  const missing = aggregate({ ledgerPath: join(work, 'nope.jsonl'), now });
  assert.equal(missing.available, false);
  assert.equal(missing.windows.total.runs, 0);
  assert.equal(missing.windows.total.totalTokens, 0);
  assert.equal(missing.skippedLines, 0);

  // fetchPlanQuota（Z3 起为真实实现）：注入指向不存在 CLI 的路径 → 引擎进程立即退出 →
  // available:false + 短因，不抛（真实打通证据见 tasks/Z3-delivery.md 与 test/quota-rpc.test.mjs）
  const pq = await fetchPlanQuota({ planKey: 'bigmodel-coding-plan', timeoutMs: 5000, cliPath: join(HERE, 'fixtures', 'no-such-cli.cjs') });
  assert.equal(pq.available, false);
  assert.ok(['app-server-exited', 'spawn-failed', 'timeout'].includes(pq.reason), `意外 reason: ${pq.reason}`);
});

test('restore()：上次残留 running/queued → interrupted（记录原因），队列继续可用', async () => {
  const work = newWorkRoot();
  const stateDir = join(work, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'jobs.json'),
    JSON.stringify({
      version: 1,
      savedAt: '2026-09-29T00:00:00.000Z',
      jobs: [
        { id: 'j-old-running', state: 'running', queuedAt: '2026-09-29T00:00:00.000Z', tag: 'stale-run', spec: {} },
        { id: 'j-old-queued', state: 'queued', queuedAt: '2026-09-29T00:00:01.000Z', tag: 'stale-queued', spec: {} },
      ],
    }),
  );
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: work });
  const jr = d.get('j-old-running');
  const jq = d.get('j-old-queued');
  assert.equal(jr.state, 'interrupted');
  assert.match(jr.interruptReason, /restarted/);
  assert.ok(jr.finishedAt);
  assert.equal(jq.state, 'interrupted');
  assert.match(jq.interruptReason, /restarted/);
  // 幂等：再次 restore 不重复改
  assert.deepEqual(d.restore(), []);
  // 队列继续可用：正常派发一个假任务
  const j = d.dispatch({ kind: 'prompt', prompt: 'after-restore', tag: 'post-restore' });
  const done = await waitForTerminal(d, j.id);
  assert.equal(done.state, 'done');
});

test('JOBS_FILE_CAP 淘汰终态时回收其捕获日志；越界路径被拒绝（ZB-05）', async () => {
  /* 背景：logs/<jobId>.{out,err}.log 每任务 2 个、原先淘汰时只删内存条目不删文件 ⇒ 无界增长。
   * 本用例锁两件事：① 淘汰即删（记录没了 → tail 再也指不到 → 文件是垃圾）；
   * ② jobs.json 可被手工编辑，captureOut 属不可信输入，越界路径必须被拒绝。 */
  const work = newWorkRoot();
  mkdirSync(join(work, 'state'), { recursive: true });
  mkdirSync(join(work, 'logs'), { recursive: true });

  const inLogs = join(work, 'logs', 'j-oldest.out.log');
  const inLogsErr = join(work, 'logs', 'j-oldest.err.log');
  writeFileSync(inLogs, 'captured stdout');
  writeFileSync(inLogsErr, 'captured stderr');
  const outside = join(work, 'OUTSIDE-must-survive.txt'); // 在 logs/ 之外
  writeFileSync(outside, 'do not delete me');

  const filler = [];
  for (let i = 0; i < 999; i++) {
    filler.push({ id: `j-fill-${i}`, state: 'done', queuedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`, spec: {} });
  }
  writeFileSync(join(work, 'state', 'jobs.json'), JSON.stringify({
    version: 1,
    savedAt: '2026-01-01T00:00:00.000Z',
    jobs: [
      // 两条最老 → 必然被优先淘汰
      { id: 'j-oldest', state: 'done', queuedAt: '2025-12-31T00:00:00.000Z', spec: {}, captureOut: inLogs, captureErr: inLogsErr },
      { id: 'j-evil', state: 'done', queuedAt: '2025-12-31T00:00:01.000Z', spec: {}, captureOut: outside },
      ...filler,
    ],
  }));

  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: work });
  assert.ok(existsSync(inLogs), '前置：捕获日志已就位');
  // 派发会触发 persist：磁盘 1001 条 + 新 job > 1000 ⇒ 淘汰最老的终态
  const j = d.dispatch({ kind: 'prompt', prompt: 'trigger-eviction', tag: 'evict' });
  await waitForTerminal(d, j.id);

  assert.equal(existsSync(inLogs), false, '① 被淘汰 job 的捕获日志必须回收');
  assert.equal(existsSync(inLogsErr), false, '① .err.log 同样回收');
  assert.equal(existsSync(outside), true, '② 越界路径（logs/ 之外）必须原样保留');
  assert.ok(!d.get('j-oldest'), '被淘汰的 job 不应再在内存中（get() 对未知 id 返回 null）');
  assert.ok(existsSync(join(work, 'state', 'jobs.json')), 'jobs.json 仍正常写盘');
});

test('snapshot() 纯 JSON 可序列化（无循环引用），终态后依旧', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1 });
  const j = d.dispatch({ kind: 'prompt', prompt: 'snap', tag: 'snap' });
  const done = await waitForTerminal(d, j.id);
  const snap = d.snapshot();
  const json = JSON.stringify(snap); // 循环引用会抛
  const back = JSON.parse(json);
  assert.equal(back.jobs.length, 1);
  assert.equal(back.jobs[0].id, j.id);
  assert.equal(back.jobs[0].state, 'done');
  assert.deepEqual(back.counts, { done: 1 });
  // get/tail 返回值同样可序列化
  JSON.stringify(d.get(j.id));
  const lines = d.tail(j.id, 10);
  assert.ok(Array.isArray(lines) && lines.length > 0, 'tail 应有捕获输出');
  assert.equal(done.exitCode, 0);
});

test('runner 路径无效 → state=failed、exitCode 记录、有 warning 不崩', async () => {
  const saved = process.env.DSP_FAKE_RUNNER;
  delete process.env.DSP_FAKE_RUNNER;
  try {
    const d = createDispatcher({ runnerPath: REAL_RUNNER_MISSING, workRoot: newWorkRoot() });
    const j = d.dispatch({ kind: 'prompt', prompt: 'boom', tag: 'boom' });
    const done = await waitForTerminal(d, j.id);
    assert.equal(done.state, 'failed');
    assert.ok(done.exitCode !== 0, `无效 runner 退出码应非 0，实际 ${done.exitCode}`);
    assert.ok(done.parseWarnings.length > 0, '应有 parseWarnings');
  } finally {
    process.env.DSP_FAKE_RUNNER = saved;
  }
});

test('parseRunnerLine 单元：真实 runner 各种行格式（含 - 值与三行分开的 out/err/result）', () => {
  /* ZB-28：`(超时)` 标记不再被丢弃 —— done 行带它时额外返回 timedOut:true（runner 自身超时）。 */
  assert.deepEqual(
    { ...parseRunnerLine('[zcode-run] done exit=124 (超时) elapsed=30.0s session=sess_1 provider=plan:bigmodel-coding-plan model=GLM-5.3 responseChars=88') },
    { exitCode: 124, runnerElapsedSec: 30, sessionId: 'sess_1', provider: 'plan:bigmodel-coding-plan', model: 'GLM-5.3', responseChars: 88, authoritative: true, summarySeen: true, timedOut: true },
  );
  assert.equal(parseRunnerLine('[zcode-run] usage requests=- in=5 out=- cacheRead=-').usage.requests, null);
  const ctx = parseRunnerLine('[zcode-run] context used=28290 (14.1% of 200000) turnCount=-');
  assert.deepEqual([ctx.contextUsed, ctx.contextWindow, ctx.turnCount], [28290, 200000, null]);
  const p = parseRunnerLine('[zcode-run] provider=plan:bigmodel-coding-plan models=GLM-5.3/GLM-5.3-Flash (BigModel（ZCode 套餐）)');
  assert.equal(p.models, 'GLM-5.3/GLM-5.3-Flash');
  assert.equal(p.provider, 'plan:bigmodel-coding-plan');
  const start = parseRunnerLine('[zcode-run] tag=z1-smoke mode=edit cwd=C:\\some dir');
  assert.equal(start.runnerTag, 'z1-smoke');
  assert.deepEqual(parseRunnerLine('[zcode-run] cli=C:\\Program Files\\ZCode\\zcode.cjs'), {}, 'cli 信息行识别但不入库');
  assert.deepEqual(parseRunnerLine('[zcode-run] task=C:\\t\\task.md'), {}, 'task 信息行识别但不入库');
  assert.equal(parseRunnerLine('[zcode-run] out=C:\\a b\\x.out.log').runnerOut, 'C:\\a b\\x.out.log');
  const combined = parseRunnerLine('[zcode-run] out=C:\\a b\\o.log err=C:\\a b\\e.log result=C:\\a b\\r.json');
  assert.deepEqual([combined.runnerOut, combined.runnerErr, combined.runnerResult], ['C:\\a b\\o.log', 'C:\\a b\\e.log', 'C:\\a b\\r.json']);
  assert.equal(parseRunnerLine('[zcode-run] 未知行格式 xyz'), null, '识别不了的 [zcode-run] 行返回 null');
  assert.deepEqual(parseRunnerLine('普通输出'), {});
});

test('清理临时目录', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  assert.ok(true);
});

/* ══════════════ 以下为 ZB-44（双引擎）**追加**的用例，不改动上面任何既有断言 ══════════════ */

test('ZB-44 parseRunnerLine(line, engine)：按引擎取前缀；省略 ⇒ 两个已知前缀都试；zcode 逐字不变', () => {
  /* ① 省略 engine ⇒ opencode 的 `[opencode-run]` 也能解析（老 jobs.json / 手工调用仍可用） */
  const ocDone = '[opencode-run] done exit=0 elapsed=0.2s session=ses_oc model=opencode/deepseek-v4.1-flash-free responseChars=4';
  const a = parseRunnerLine(ocDone);
  assert.equal(a.summarySeen, true, '省略引擎时 opencode 前缀照样识别');
  assert.equal(a.sessionId, 'ses_oc');
  assert.equal(a.model, 'opencode/deepseek-v4.1-flash-free');
  assert.equal(a.exitCode, 0);

  /* ② 显式引擎 ⇒ 只用该引擎的正则；**另一个前缀的行按普通输出返回 {}（不是 null）** */
  assert.deepEqual(parseRunnerLine('[zcode-run] done exit=0 elapsed=1.0s session=s1', 'opencode'), {},
    '显式 opencode 时，[zcode-run] 行是普通输出（不得记 parseWarning）');
  assert.deepEqual(parseRunnerLine('[opencode-run] done exit=0 elapsed=1.0s', 'zcode'), {},
    '显式 zcode 时，[opencode-run] 行是普通输出');
  assert.equal(parseRunnerLine('[opencode-run] done exit=0 elapsed=1.0s session=s2', 'opencode').sessionId, 's2');

  /* ③ 语义不变：带**已知前缀**但识别失败 ⇒ null；无已知前缀的普通行 ⇒ {} */
  assert.equal(parseRunnerLine('[opencode-run] 未知形状 xyz', 'opencode'), null);
  assert.equal(parseRunnerLine('[opencode-run] 未知形状 xyz'), null, '省略引擎时同样按"已知前缀+识别失败"记 null');
  assert.deepEqual(parseRunnerLine('[zcode-run] 未知形状 xyz', 'opencode'), {}, '另一个引擎的前缀不算"识别失败"');
  assert.deepEqual(parseRunnerLine('普通输出', 'opencode'), {});
  assert.deepEqual(parseRunnerLine('普通输出'), {});

  /* ④ zcode 关键形状复钉一遍（逐字不变） */
  assert.equal(parseRunnerLine('[zcode-run] done exit=0 elapsed=1.0s session=s1', 'zcode').sessionId, 's1');
  assert.equal(parseRunnerLine('[zcode-run] 未知行格式 xyz', 'zcode'), null);

  /* ⑤ opencode 的 usage / progress / variant 行各一条（variant ⇒ 复用既有 Applied/Target 字段） */
  assert.deepEqual(
    parseRunnerLine('[opencode-run] usage requests=1 in=10 out=2 cacheRead=0', 'opencode').usage,
    { requests: 1, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 },
  );
  assert.equal(
    parseRunnerLine('[opencode-run] progress stage=run elapsed=3s chars=8 tools=1 stageAgo=1s', 'opencode').progress.stage,
    'run',
  );
  const applied = parseRunnerLine('[opencode-run] variant=high model=opencode/glm-5.3-flash-free', 'opencode');
  assert.equal(applied.reasoningLevelApplied, 'high');
  assert.equal(applied.reasoningTarget, 'opencode/glm-5.3-flash-free', 'OpenCode 无 provider 注入 ⇒ target 用 model 填');

  /* ⑥ `variants` 是探测/声明行：识别为已知信息行（返回 {}），不落"无人识别"的 warning */
  assert.deepEqual(parseRunnerLine('[opencode-run] variants opencode/x=low,high', 'opencode'), {});
});

test('ZB-44 parseProviderTable(text, engine)：opencode 的 variants 与 zcode 的 reasoning-levels 走同一段实现', () => {
  const text = [
    'id'.padEnd(34) + 'enabled   端点/模型',
    'builtin:bigmodel-coding-plan'.padEnd(34) + 'true      https://x | GLM-5.3',
    '[zcode-run] reasoning-levels GLM-5.3=disabled,enabled',
    '[opencode-run] variants opencode/deepseek-v4.1-flash-free=low,high,max',
  ].join('\n');

  /* 省略引擎 ⇒ 两种档位表行都认（既有调用方零改动，且不挑引擎） */
  const both = parseProviderTable(text);
  assert.deepEqual(both.modelLevels['GLM-5.3'], ['disabled', 'enabled']);
  assert.deepEqual(both.modelLevels['opencode/deepseek-v4.1-flash-free'], ['low', 'high', 'max']);
  assert.equal(both.rows.length, 1, 'provider 表格行不受档位行影响');
  assert.equal(both.warnings.length, 0);

  /* 指定引擎 ⇒ 只认该引擎的档位行（不看错另外一个引擎的表） */
  const onlyZ = parseProviderTable(text, 'zcode');
  assert.deepEqual(onlyZ.modelLevels['GLM-5.3'], ['disabled', 'enabled']);
  assert.equal(onlyZ.modelLevels['opencode/deepseek-v4.1-flash-free'], undefined);
  const onlyO = parseProviderTable(text, 'opencode');
  assert.deepEqual(onlyO.modelLevels['opencode/deepseek-v4.1-flash-free'], ['low', 'high', 'max']);
  assert.equal(onlyO.modelLevels['GLM-5.3'], undefined);
});
