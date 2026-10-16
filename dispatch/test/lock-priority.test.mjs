/**
 * ZB-17 回归测试：**文件锁任务优先放行**（用户要求）。
 *
 * 用户要求：
 *   「整仓库锁（repo.lock）与文件锁（files/*.lock）之间关系，如果有多个并发，
 *    优先执行文件锁的进程，整仓库锁的进程后执行；整仓库锁的进程执行时，
 *    文件锁的待执行进程都等待。优先放行文件锁的进程。」
 *
 * 旧实现是严格 FIFO + 队头阻塞（队头拿不到锁就 break），
 * 导致整仓库锁任务排前面时，后面本可并行的文件锁任务全被堵住。
 *
 * 新实现：按优先级扫描队列取第一个能拿到锁的 —— 文件锁任务优先，同类内保持 FIFO。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../core/dispatch-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs');
process.env.DSP_FAKE_RUNNER = FAKE_RUNNER;

const tempDirs = [];
const newWorkRoot = () => {
  const d = mkdtempSync(join(tmpdir(), 'dsp-prio-'));
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
const runningIds = (d) => d.list().filter((j) => j.state === 'running').map((j) => j.tag).sort();
const F = (n) => `F:/proj/${n}`;

test('★ 文件锁任务优先：整仓库锁在队头也不阻塞后面的文件锁任务', async () => {
  process.env.FAKE_SLEEP_MS = '900';
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  /* 先让一个"占位"任务持整仓库锁，制造"整仓库锁正在跑"的局面 */
  const holder = d.dispatch({ kind: 'prompt', prompt: 'h', tag: 'HOLDER' }); // 默认 = 整仓库锁
  await waitFor(() => d.get(holder.id).state === 'running', 'HOLDER running');

  /* 现在队头放一个**整仓库锁**任务（拿不到锁 ⇒ 旧实现会在此 break），
   * 后面放两个**文件锁**任务（本可并行，但旧实现被队头堵住）。 */
  const whole = d.dispatch({ kind: 'prompt', prompt: 'w', tag: 'WHOLE' });        // 整仓库锁（排队）
  const f1 = d.dispatch({ kind: 'prompt', prompt: '1', write: [F('a.ts')], tag: 'F1' });
  const f2 = d.dispatch({ kind: 'prompt', prompt: '2', write: [F('b.ts')], tag: 'F2' });

  // 队列顺序应为 [WHOLE, F1, F2]（WHOLE 在前，制造队头阻塞场景）
  assert.deepEqual(d.snapshot().queue.map((id) => d.get(id).tag), ['WHOLE', 'F1', 'F2'],
    '队列顺序：WHOLE 在 F1/F2 之前');

  /* 关键：HOLDER 持整仓库锁期间，F1/F2 与整仓库锁**跨层级冲突** ⇒ 都该等待；
   * 但等 HOLDER 一释放，应**优先放行 F1/F2**（而不是先跑 WHOLE）。 */
  assert.equal(d.get(f1.id).state, 'queued', 'F1 等整仓库锁（跨层级冲突）');
  assert.equal(d.get(f2.id).state, 'queued', 'F2 同上');

  await waitTerminal(d, holder.id); // HOLDER 释放

  // 释放后：F1/F2 应立刻并行起来，而 WHOLE 仍在等（因为 F1/F2 持文件锁 ⇒ 与整仓库锁冲突）
  await waitFor(() => runningIds(d).length > 0, '有人跑起来');
  const nowRunning = runningIds(d);
  assert.deepEqual(nowRunning, ['F1', 'F2'], `应优先放行文件锁任务，实际跑的是 ${JSON.stringify(nowRunning)}`);
  assert.equal(d.get(whole.id).state, 'queued', 'WHOLE（整仓库锁）仍在等待 —— 符合"文件锁优先"');

  await Promise.all([waitTerminal(d, f1.id), waitTerminal(d, f2.id), waitTerminal(d, whole.id)]);
  assert.ok(!existsSync(d.lockPaths.repo), '结束后仓库锁释放');
  assert.equal(d.listFileLocks().length, 0, '结束后文件锁释放');
  delete process.env.FAKE_SLEEP_MS;
});

test('整仓库锁执行时，文件锁任务等待（跨层级互斥，非优先级问题）', async () => {
  process.env.FAKE_SLEEP_MS = '700';
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  const whole = d.dispatch({ kind: 'prompt', prompt: 'w', tag: 'WHOLE' }); // 先派 ⇒ 先拿到整仓库锁
  await waitFor(() => d.get(whole.id).state === 'running', 'WHOLE running');
  const f1 = d.dispatch({ kind: 'prompt', prompt: '1', write: [F('a.ts')], tag: 'F1' });
  assert.equal(d.get(f1.id).state, 'queued', '整仓库锁执行时，文件锁任务必须等待');
  await waitTerminal(d, whole.id);
  await waitTerminal(d, f1.id);
  delete process.env.FAKE_SLEEP_MS;
});

test('同类内保持 FIFO：多个文件锁任务按队列顺序放行', async () => {
  process.env.FAKE_SLEEP_MS = '500';
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1 });
  /* maxConcurrent=1 ⇒ 逐个跑，正好检验文件锁任务之间的 FIFO 顺序 */
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', write: [F('a.ts')], tag: 'A' });
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', write: [F('b.ts')], tag: 'B' });
  const c = d.dispatch({ kind: 'prompt', prompt: 'c', write: [F('c.ts')], tag: 'C' });
  const ja = await waitTerminal(d, a.id);
  const jb = await waitTerminal(d, b.id);
  const jc = await waitTerminal(d, c.id);
  assert.ok(Date.parse(jb.startedAt) >= Date.parse(ja.finishedAt), 'B 在 A 之后');
  assert.ok(Date.parse(jc.startedAt) >= Date.parse(jb.finishedAt), 'C 在 B 之后（同类保持 FIFO）');
  delete process.env.FAKE_SLEEP_MS;
});

test('文件锁任务优先于整仓库锁：整仓库锁排在前面也不会先跑', async () => {
  process.env.FAKE_SLEEP_MS = '600';
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 2 });
  /* 先派整仓库锁（会立刻 running，占住），再派文件锁（排队）；
   * 释放后文件锁应优先 —— 但这里整仓库锁已跑完，故直接验证"文件锁先于后续整仓库锁" */
  const whole1 = d.dispatch({ kind: 'prompt', prompt: 'w1', tag: 'WHOLE1' });
  await waitFor(() => d.get(whole1.id).state === 'running', 'WHOLE1 running');
  const whole2 = d.dispatch({ kind: 'prompt', prompt: 'w2', tag: 'WHOLE2' }); // 整仓库锁，排队
  const f = d.dispatch({ kind: 'prompt', prompt: 'f', write: [F('x.ts')], tag: 'F' }); // 文件锁，排队
  assert.deepEqual(d.snapshot().queue.map((id) => d.get(id).tag), ['WHOLE2', 'F'], '队列：WHOLE2 在 F 前');
  await waitTerminal(d, whole1.id);
  await waitFor(() => runningIds(d).includes('F'), 'F 应优先跑起来');
  assert.ok(!runningIds(d).includes('WHOLE2'), 'WHOLE2 应仍在等（文件锁优先）');
  await Promise.all([waitTerminal(d, f.id), waitTerminal(d, whole2.id)]);
  delete process.env.FAKE_SLEEP_MS;
});
