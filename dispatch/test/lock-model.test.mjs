/**
 * ZB-16 回归测试：锁模型重设计（删除 memory 锁；repo 锁粒度由 write 决定）。
 *
 * 用户要求（本轮）：
 *   ① repo/memory 改中文名显示，memory 改为「Zcode 记忆锁」；
 *   ② 派发可明确是否 repo 锁、**明确 repo 锁哪些文件**；
 *   ③ **删除 memory 相关**（ZCode 记忆写入改由默认注入的提示词禁令约束）；
 *   ④ 不同进程锁不同文件、没有竞写关系的，**允许并发执行**；
 *   ⑤ 分区名改为「文件锁 / 记忆锁」。
 *
 * 本文件钉住 ③④ 的语义（锁模型）：
 *   · 默认（不传 write）  ⇒ 锁**整仓库**（repo.lock）
 *   · 声明 write          ⇒ 只锁那些文件 ⇒ 不同文件集可并发
 *   · lock='none'         ⇒ 不取锁
 *   · memory/both 已删除  ⇒ 传入应报错
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
  const d = mkdtempSync(join(tmpdir(), 'dsp-lock16-'));
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
const F = (n) => `F:/proj/${n}`;

test('memory / both 已删除：传入应报错（旧调用方立刻暴露，不静默降级）', () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 2 });
  assert.throws(() => d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'memory' }), TypeError);
  assert.throws(() => d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'both' }), TypeError);
  // 新枚举合法
  for (const lk of ['repo', 'none']) {
    const j = d.dispatch({ kind: 'prompt', prompt: 'x', lock: lk });
    assert.ok(j && j.id, `lock=${lk} 应被接受`);
  }
});

test('默认（不传 write）= 锁整仓库', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', tag: 'A' });
  /* dispatch 同步拿锁+启动 ⇒ 直接断言（不再轮询 running 瞬时态：慢机上会错过窗口 → 假红）。 */
  assert.equal(d.get(a.id).state, 'running', 'A 已启动');
  assert.equal(d.get(a.id).lock, 'repo', '默认应锁整仓库');
  assert.ok(existsSync(d.lockPaths.repo), 'repo.lock 应存在');
  assert.ok(!existsSync(join(d.workRoot, 'locks', 'memory.lock')), 'memory.lock 不应被创建');
  await waitTerminal(d, a.id);
  assert.ok(!existsSync(d.lockPaths.repo), '结束后释放');
});

test('★ 不同文件集可并发（用户要求 ④ 的核心）', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', write: [F('a.ts')], tag: 'A' });
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', write: [F('b.ts')], tag: 'B' });
  const c = d.dispatch({ kind: 'prompt', prompt: 'c', write: [F('c.ts')], tag: 'C' });
  /* 三路都无锁冲突 ⇒ dispatch 同步全部启动；直接读状态与锁表（不轮询瞬时态）。 */
  assert.deepEqual([a, b, c].map((x) => d.get(x.id).state), ['running', 'running', 'running'], 'A/B/C 三路并行');
  assert.equal(d.listFileLocks().length, 3, '三个文件各一把锁');
  const files = d.listFileLocks().map((l) => l.file).sort();
  assert.deepEqual(files, [F('a.ts'), F('b.ts'), F('c.ts')].map((s) => s.replace(/\\/g, '/').toLowerCase()).sort());
  const [ra, rb, rc] = await Promise.all([a, b, c].map((x) => waitTerminal(d, x.id)));
  assert.ok(ra.startedAt && rb.startedAt && rc.startedAt, '三者都真正启动过（startedAt 已落库）');
  assert.equal(d.listFileLocks().length, 0, '全部释放');
});

test('同一文件集互斥：后者排队（竞写关系必须串行）', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', write: [F('a.ts')], tag: 'A' });
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', write: [F('a.ts')], tag: 'B' });
  assert.equal(d.get(b.id).state, 'queued', 'B 写同一文件 ⇒ 排队');
  const ja = await waitTerminal(d, a.id);
  const jb = await waitTerminal(d, b.id);
  assert.ok(Date.parse(jb.startedAt) >= Date.parse(ja.finishedAt), 'B 必须在 A 释放后开始');
});

test('部分重叠的文件集：重叠者排队、不重叠者并行', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', write: [F('a.ts'), F('b.ts')], tag: 'A' });
  const c = d.dispatch({ kind: 'prompt', prompt: 'c', write: [F('c.ts')], tag: 'C' }); // 无交集
  const e = d.dispatch({ kind: 'prompt', prompt: 'e', write: [F('a.ts')], tag: 'E' }); // 与 A 重叠
  /* dispatch 同步判定：A 拿 {a,b}、C 拿 {c} 都能起；E 与 A 重叠 ⇒ 当场排队。 */
  assert.equal(d.get(a.id).state, 'running', 'A 已启动');
  assert.equal(d.get(c.id).state, 'running', 'C 与 A 无交集 ⇒ 直接跑（并行）');
  assert.equal(d.get(e.id).state, 'queued', 'E 与 A 重叠 ⇒ 排队');
  await Promise.all([waitTerminal(d, a.id), waitTerminal(d, c.id), waitTerminal(d, e.id)]);
  assert.equal(d.listFileLocks().length, 0, '全部释放');
});

test("lock='none'：明确不取锁 ⇒ 与任何任务都不互斥", async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', tag: 'A' });                    // 默认锁整仓库
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', lock: 'none', tag: 'B' });      // 不取锁
  /* 两者都应同步启动（none 不参与互斥）。 */
  assert.equal(d.get(a.id).state, 'running', 'A 已启动（整仓库锁）');
  assert.equal(d.get(b.id).state, 'running', 'B 不取锁 ⇒ 与 A 并行');
  assert.equal(d.get(b.id).lock, '', `none 不应持锁（实际 "${d.get(b.id).lock}"）`);
  await Promise.all([waitTerminal(d, a.id), waitTerminal(d, b.id)]);
});

test('锁文件里能看到"哪个进程锁哪些文件"（用户要求 ②）', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', write: [F('a.ts'), F('b.ts')], tag: 'job-A' });
  assert.equal(d.get(a.id).state, 'running', 'A 已启动并持文件锁');
  const locks = d.listFileLocks();
  assert.equal(locks.length, 2, '两个文件两把锁');
  for (const lk of locks) {
    assert.equal(lk.jobId, a.id, '锁体记录了持有进程 id');
    assert.equal(lk.tag, 'job-A', '锁体记录了 tag（UI 显示"哪个进程"）');
    assert.ok(typeof lk.heldSec === 'number' && lk.heldSec >= 0, '记录了持有时长');
  }
  const paths = d.snapshot().fileLocks.map((l) => l.file).sort();
  assert.deepEqual(paths, [F('a.ts'), F('b.ts')].map((s) => s.toLowerCase()).sort(), 'snapshot 暴露文件列表供 UI');
  await waitTerminal(d, a.id);
});

test('默认整仓库锁与文件锁互斥（整仓库涵盖所有文件）', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', tag: 'whole' });                    // 整仓库
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', write: [F('x.ts')], tag: 'file' }); // 某文件
  assert.equal(d.get(b.id).state, 'queued', '整仓库锁持有期间，文件锁任务应排队（保守：无法证明无交集）');
  await waitTerminal(d, a.id);
  await waitTerminal(d, b.id);
});
