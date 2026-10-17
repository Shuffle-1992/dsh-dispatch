/**
 * ZB-28 回归测试：锁排队可观测（用户要求「被整仓锁挡住时不再盲等」）。
 *
 * queued job 的 lockWait 结构（core/dispatch-core.mjs 的 lockWaitFor，经 serialize 挂出）：
 *   position / queuedTotal / ahead / aheadIds / blockers[] / estWaitSec / estWaitNote
 *
 * 本文件钉住的语义：
 *   · blockers 指认到持有者（jobId/tag/state/已运行秒/timeoutMin/剩余上界）
 *   · 跨层级阻塞（整仓库锁 vs 文件锁）以 cross: 条目计入 blockers
 *   · ahead = **同类**（文件锁任务 / 整仓库锁任务，与 pump 放行优先级同尺）前方任务数
 *   · estWaitSec 仅当每个阻塞者都声明 timeoutMin 时可估（上界 = timeoutMin*60+宽限−已运行）；
 *     否则 null（不猜），note 说明原因
 *   · 非 queued job 的 lockWait 恒 null
 *   · wire 层 list 动作（slimJob）把 lockWait 原样透传给工具/面板
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../core/dispatch-core.mjs';
import { createActionHandler } from '../wire.host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs');
process.env.DSP_FAKE_RUNNER = FAKE_RUNNER;
process.env.FAKE_SLEEP_MS = '120';

const tempDirs = [];
const newWorkRoot = () => {
  const d = mkdtempSync(join(tmpdir(), 'dsp-lockq-'));
  tempDirs.push(d);
  return d;
};
test.after(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'failed', 'killed', 'interrupted'];
async function waitFor(pred, what, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`waitFor(${what}) 超时`);
}
async function waitTerminal(d, id, timeoutMs = 20000) {
  await waitFor(() => {
    const j = d.get(id);
    return j && (TERMINAL.includes(j.state) || j.state === 'paused');
  }, `terminal:${id}`, timeoutMs);
  return d.get(id);
}

test('★ 整仓锁挡住：blockers 指认持有者；阻塞者无 timeoutMin ⇒ estWaitSec=null 不猜', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', tag: 'HOLDER' });
  /* dispatch 同步拿锁+启动 ⇒ 不再轮询 running 瞬时态（慢机上会错过窗口 → waitFor 触顶假红）。 */
  assert.equal(d.get(a.id).state, 'running', 'A 已启动并持整仓锁');
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', tag: 'WAITER' });
  assert.equal(d.get(b.id).state, 'queued');
  const lw = d.get(b.id).lockWait;
  assert.ok(lw, 'queued job 应带 lockWait');
  assert.equal(lw.position, 1, '队列位次（1 起）');
  assert.equal(lw.queuedTotal, 1);
  assert.equal(lw.ahead, 0, '前方无同类任务');
  assert.deepEqual(lw.aheadIds, []);
  assert.equal(lw.blockers.length, 1, '被 repo 锁挡住');
  assert.equal(lw.blockers[0].lock, 'repo');
  assert.equal(lw.blockers[0].holderJobId, a.id, '指认到持有者');
  assert.equal(lw.blockers[0].holderTag, 'HOLDER');
  assert.equal(lw.blockers[0].holderState, 'running');
  assert.equal(lw.blockers[0].holderTimeoutMin, null, 'A 没声明 timeoutMin');
  assert.equal(lw.estWaitSec, null, '跑多久不可知 ⇒ 不猜');
  assert.ok(lw.estWaitNote.includes('不猜测'), 'note 说明为什么是 null');
  await Promise.all([waitTerminal(d, a.id), waitTerminal(d, b.id)]);
});

test('estWaitSec：阻塞者声明 timeoutMin ⇒ 给剩余上界（timeoutMin*60+宽限−已运行）', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1, timeoutGraceSec: 0 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', tag: 'HOLDER', timeoutMin: 1 });
  assert.equal(d.get(a.id).state, 'running', 'A 已启动并持整仓锁');
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', tag: 'WAITER' });
  const lw = d.get(b.id).lockWait;
  assert.equal(lw.blockers.length, 1);
  assert.equal(lw.blockers[0].holderTimeoutMin, 1);
  const remain = lw.blockers[0].holderRemainingSec;
  assert.ok(remain != null && remain > 0 && remain <= 60, `剩余上界应在 (0,60] 秒（实际 ${remain}）`);
  assert.ok(lw.estWaitSec != null && lw.estWaitSec <= 60, `estWaitSec 有值且 ≤ 60（实际 ${lw.estWaitSec}）`);
  assert.ok(lw.estWaitNote.includes('上界'), 'note 说明这是上界估计');
  await Promise.all([waitTerminal(d, a.id), waitTerminal(d, b.id)]);
});

test('ahead：同类前方任务计数（文件锁类与整仓库锁类分开数，与 pump 优先级同尺）', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1 });
  const h = d.dispatch({ kind: 'prompt', prompt: 'h', tag: 'H' }); // 整仓库，占住并发与锁
  assert.equal(d.get(h.id).state, 'running', 'H 已启动并持整仓锁');
  const r1 = d.dispatch({ kind: 'prompt', prompt: 'r1', tag: 'R1' }); // 整仓库 queued
  const f1 = d.dispatch({ kind: 'prompt', prompt: 'f1', tag: 'F1', write: ['F:/proj/x.ts'] }); // 文件锁 queued
  const r2 = d.dispatch({ kind: 'prompt', prompt: 'r2', tag: 'R2' }); // 整仓库 queued
  assert.equal(d.get(r1.id).state, 'queued');
  assert.equal(d.get(f1.id).state, 'queued');
  assert.equal(d.get(r2.id).state, 'queued');
  const lw1 = d.get(r1.id).lockWait;
  assert.equal(lw1.ahead, 0, 'r1 前方没有同类整仓库任务（文件锁任务不算同类）');
  const lw2 = d.get(r2.id).lockWait;
  assert.equal(lw2.ahead, 1, 'r2 前方同类只有 r1');
  assert.deepEqual(lw2.aheadIds, [r1.id]);
  assert.equal(lw2.position, 3, '全局队列位次');
  await Promise.all([h, r1, f1, r2].map((x) => waitTerminal(d, x.id)));
});

test('文件锁挡住：blockers.lock 以 file: 开头并指认持有者；无冲突者不排队', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', tag: 'A', write: ['F:/proj/a.ts'] });
  assert.equal(d.get(a.id).state, 'running', 'A 已启动并持文件锁');
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', tag: 'B', write: ['F:/proj/a.ts'] });
  assert.equal(d.get(b.id).state, 'queued', '写同一文件 ⇒ 排队');
  const lw = d.get(b.id).lockWait;
  assert.equal(lw.blockers.length, 1);
  assert.ok(lw.blockers[0].lock.startsWith('file:'), `文件锁条目（实际 ${lw.blockers[0].lock}）`);
  assert.ok(lw.blockers[0].lock.includes('a.ts'), '条目带归一化文件路径');
  assert.equal(lw.blockers[0].holderJobId, a.id);
  const c = d.dispatch({ kind: 'prompt', prompt: 'c', tag: 'C', write: ['F:/proj/b.ts'] });
  assert.equal(d.get(c.id).state, 'running', '写其它文件 ⇒ 无冲突直接跑');
  await Promise.all([a, b, c].map((x) => waitTerminal(d, x.id)));
});

test('跨层级：整仓库锁持有期间，文件锁任务的 blockers 给出 cross 条目并指认持有者', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', tag: 'WHOLE' }); // 整仓库
  assert.equal(d.get(a.id).state, 'running', 'A 已启动并持整仓锁');
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', tag: 'FILE', write: ['F:/proj/y.ts'] });
  assert.equal(d.get(b.id).state, 'queued', '整仓库锁涵盖所有文件 ⇒ 文件锁任务等待');
  const lw = d.get(b.id).lockWait;
  assert.equal(lw.blockers.length, 1);
  assert.ok(lw.blockers[0].lock.startsWith('cross:repo:'), `cross 条目（实际 ${lw.blockers[0].lock}）`);
  assert.equal(lw.blockers[0].holderJobId, a.id);
  assert.equal(lw.blockers[0].holderTag, 'WHOLE');
  await Promise.all([waitTerminal(d, a.id), waitTerminal(d, b.id)]);
});

test('非 queued 恒 null；wire 层 list 动作（slimJob）原样透传 lockWait', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1 });
  const handle = createActionHandler(d, {});
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', tag: 'A' });
  assert.equal(d.get(a.id).state, 'running', 'A 已启动');
  assert.equal(d.get(a.id).lockWait, null, 'running 的 lockWait=null');
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', tag: 'B' });
  const listed = await handle('list', {});
  assert.equal(listed.ok, true);
  const jb = listed.jobs.find((j) => j.id === b.id);
  assert.ok(jb && jb.lockWait, 'wire list 透传 lockWait（工具与面板都吃这份）');
  assert.equal(jb.lockWait.blockers[0].holderJobId, a.id);
  await Promise.all([waitTerminal(d, a.id), waitTerminal(d, b.id)]);
  assert.equal(d.get(a.id).lockWait, null, '终态的 lockWait=null');
});
