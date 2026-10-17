/**
 * ZB-08 回归测试：细粒度文件锁（write 声明）+ 并发语义 + wait 动作。
 *
 * 背景（用户观察 + 实测）：单写者锁锁住**整个进程**，但进程大部分时间并非在写。
 * 实测 T18（lock=both，27 分钟）期间，只要 repo / 只要 memory 的两个任务全程干等，
 * 三者 started/finished 首尾相接、无一毫秒重叠。
 *
 * 本文件的第一约束是**安全底线**：未声明 write ⇒ 必须回退到 repo/memory 粗粒度锁。
 * 细粒度是"声明了才生效的可选优化"，绝不是"默认放宽"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../core/dispatch-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs');
process.env.DSP_FAKE_RUNNER = FAKE_RUNNER;

const tempDirs = [];
function newWorkRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'dsp-fslock-'));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`waitFor(${what}) 超时`);
}
const TERMINAL = ['done', 'failed', 'killed', 'interrupted'];
async function waitTerminal(d, id, timeoutMs = 20000) {
  await waitFor(() => {
    const j = d.get(id);
    return j && (TERMINAL.includes(j.state) || j.state === 'paused');
  }, `terminal:${id}`, timeoutMs);
  return d.get(id);
}

/* 两个绝对路径，落在被测 workRoot 之外也无所谓：锁只按路径判定，不要求文件真实存在 */
const FILE_A = join('F:', 'proj', 'src', 'a.ts');
const FILE_B = join('F:', 'proj', 'docs', 'b.md');
const FILE_A2 = join('F:', 'proj', 'src', 'A.TS'); // 大小写不同 ⇒ Windows 上应视为同一文件

test('安全底线：未声明 write 的任务仍走整仓库粗粒度锁（不退化互斥）', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 8 });
  /* ZB-16：lock 枚举改为 repo|none；不传 write 时默认锁整仓库 ⇒ 彼此互斥。 */
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', lock: 'repo', tag: 'A' });
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', lock: 'repo', tag: 'B' });
  // maxConcurrent 已放到 8，但整仓库锁彼此互斥 ⇒ B 必须排队
  assert.equal(d.get(b.id).state, 'queued', 'B 应与 A 串行（粗粒度锁未被绕过）');
  const ja = await waitTerminal(d, a.id);
  await waitTerminal(d, b.id);
  assert.ok(TERMINAL.includes(ja.state));
  assert.ok(!existsSync(d.lockPaths.repo), '结束后 repo 锁应释放');
  assert.ok(!existsSync(join(d.workRoot, 'locks', 'memory.lock')), 'memory 锁已删除，不应出现');
  assert.equal(d.listFileLocks().length, 0, '未声明 write ⇒ 不产生文件锁');
});

test('声明不同 write 文件 ⇒ 可并行（这是本改造的收益）', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', write: [FILE_A], tag: 'A' });
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', write: [FILE_B], tag: 'B' });
  /* dispatch() 是**同步**拿锁+启动的 ⇒ 这里直接读状态/锁表（不再轮询 running 瞬时态：
   * 慢机/负载抖动时轮询可能整个错过窗口，waitFor 会等到超时 = 偶发假红）。 */
  assert.equal(d.get(a.id).state, 'running', 'A 已启动');
  assert.equal(d.get(b.id).state, 'running', 'B 已启动（不同文件 ⇒ 无锁冲突）');
  const locks = d.listFileLocks();
  assert.equal(locks.length, 2, '两个文件各有一把锁');
  /* 与 snapshot 用例同理：listFileLocks 返回**归一化后**的路径（win32 上整体小写 + /）。 */
  const norm = (p) => (process.platform === 'win32' ? String(p).replace(/\\/g, '/').toLowerCase() : String(p).replace(/\\/g, '/'));
  const files = locks.map((l) => l.file).sort();
  assert.deepEqual(files, [norm(FILE_A), norm(FILE_B)].sort(), '锁的文件正是声明的那两个（归一化形态）');
  const who = Object.fromEntries(locks.map((l) => [l.file, l.tag]));
  assert.equal(who[norm(FILE_A)], 'A', 'a.ts 由 A 持有');
  assert.equal(who[norm(FILE_B)], 'B', 'b.md 由 B 持有');
  const [ra, rb] = await Promise.all([waitTerminal(d, a.id), waitTerminal(d, b.id)]);
  /* "可并行"的稳定判据：两者执行区间重叠（原断言读的是瞬时 running 状态，语义相同但会错过窗口）。 */
  assert.ok(ra.startedAt && rb.startedAt, 'A/B 都真正启动过（startedAt 已落库）');
  assert.equal(
    Date.parse(ra.startedAt) < Date.parse(rb.finishedAt) && Date.parse(rb.startedAt) < Date.parse(ra.finishedAt),
    true,
    `A/B 执行区间应重叠（不同文件集并行），实际 A=[${ra.startedAt},${ra.finishedAt}] B=[${rb.startedAt},${rb.finishedAt}]`,
  );
  assert.equal(d.listFileLocks().length, 0, '任务结束后文件锁全部释放');
});

test('声明同一 write 文件 ⇒ 后者排队（细粒度互斥仍成立）', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', write: [FILE_A], tag: 'A' });
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', write: [FILE_A], tag: 'B' });
  assert.equal(d.get(b.id).state, 'queued', 'B 写同一文件 ⇒ 应排队');
  /* A 释放后 B 才起步：等两者都落终态，再用**时间戳**断言原语义
   * （原实现是轮询瞬时 running 状态，慢机上可能错过 B 的窗口）。 */
  const ja = await waitTerminal(d, a.id);
  const jb = await waitTerminal(d, b.id);
  assert.ok(Date.parse(jb.startedAt) >= Date.parse(ja.finishedAt), 'B 必须在 A 释放文件锁之后才开始');
  assert.equal(d.listFileLocks().length, 0, '结束后文件锁清空');
});

/* 另一个"部分重叠"用例的构造有误：A 写 {a,b} 而 C 写 c.ts，二者无交集 ⇒ C 放行；
 * 但为了让"重叠者排队"也被覆盖，这里再加一个写 {a} 的 D，它应与 A 重叠而排队。 */
test('部分重叠的 write 集合：重叠者排队，不重叠者放行', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', write: [FILE_A, FILE_B], tag: 'A' });
  const c = d.dispatch({ kind: 'prompt', prompt: 'c', write: ['F:/proj/src/c.ts'], tag: 'C' }); // 与 A 无交集
  const e = d.dispatch({ kind: 'prompt', prompt: 'e', write: [FILE_A], tag: 'E' }); // 与 A 重叠（都写 a.ts）
  assert.equal(d.get(c.id).state, 'running', 'C 与 A 无交集 ⇒ 应放行并行');
  assert.equal(d.get(e.id).state, 'queued', 'E 与 A 都写 a.ts ⇒ 应排队');
  assert.equal(d.listFileLocks().length, 3, 'A 持 2 把 + C 持 1 把');
  await Promise.all([waitTerminal(d, a.id), waitTerminal(d, c.id)]);
  await waitTerminal(d, e.id); // A 释放后 E 才跑
  assert.equal(d.listFileLocks().length, 0, '全部释放');
});

test('write 路径归一化：大小写与分隔符差异视为同一文件', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', write: [FILE_A], tag: 'A' });
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', write: [FILE_A2.replace(/\//g, '\\')], tag: 'B' });
  assert.equal(d.get(b.id).state, 'queued', '仅大小写/分隔符不同的路径应视为同一文件 ⇒ 排队');
  await Promise.all([waitTerminal(d, a.id), waitTerminal(d, b.id)]);
});

test('write 非法值被拒（非字符串 / 空串 / 非数组）', () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 2 });
  assert.throws(() => d.dispatch({ kind: 'prompt', prompt: 'x', write: 'not-an-array' }), TypeError);
  assert.throws(() => d.dispatch({ kind: 'prompt', prompt: 'x', write: [123] }), TypeError);
  assert.throws(() => d.dispatch({ kind: 'prompt', prompt: 'x', write: ['  '] }), TypeError);
  // 空数组合法（= 未声明）⇒ 回退粗粒度，不抛
  const j = d.dispatch({ kind: 'prompt', prompt: 'x', write: [] });
  assert.ok(j && j.id, '空数组按未声明处理（回退粗粒度锁）');
});

test('write 声明的加锁顺序固定（防死锁：多任务交叉声明同一组文件）', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  // 两个任务以**相反顺序**声明同一组文件；若加锁顺序不固定，可能形成循环等待
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', write: [FILE_A, FILE_B], tag: 'A' });
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', write: [FILE_B, FILE_A], tag: 'B' });
  assert.equal(d.get(b.id).state, 'queued', 'B 排队（不是死锁）');
  await Promise.all([waitTerminal(d, a.id), waitTerminal(d, b.id)]);
  assert.equal(d.listFileLocks().length, 0, '两任务都结束后无遗留锁（未死锁）');
});

test('lockBlockersFor：能报出被什么挡住（"为什么在排队"）', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', lock: 'repo', tag: 'A' });
  const blockers = d.lockBlockersFor({ kind: 'prompt', prompt: 'b', lock: 'repo' });
  assert.ok(blockers.includes('repo'), `应报出被 repo 挡住，实际=${JSON.stringify(blockers)}`);
  /* ZB-16：整仓库锁持有期间，**文件锁任务也应排队**（跨层级冲突，实测缺口已修）。
   * 故这里不再断言"直接跑"，而是断言被 cross 挡住。 */
  const blocked2 = d.lockBlockersFor({ kind: 'prompt', prompt: 'b', write: [FILE_B] });
  assert.ok(blocked2.some((b) => b.startsWith('cross:')), `文件锁任务应被整仓库锁挡住，实际=${JSON.stringify(blocked2)}`);
  const b = d.dispatch({ kind: 'prompt', prompt: 'b', write: [FILE_B], tag: 'B' });
  assert.equal(d.get(b.id).state, 'queued', '整仓库锁持有期间，文件锁任务排队（保守：无法证明无交集）');
  await waitTerminal(d, a.id);
  await waitTerminal(d, b.id);
});

test('文件锁目录与快照：fileLocks 出现在 snapshot 里（UI 展示来源）', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4 });
  const a = d.dispatch({ kind: 'prompt', prompt: 'a', write: [FILE_A], tag: 'A' });
  /* dispatch 同步拿锁+启动 ⇒ 立刻读快照（不再轮询 running 瞬时态）。 */
  assert.equal(d.get(a.id).state, 'running', 'A 已启动并持文件锁');
  const snap = d.snapshot();
  assert.ok(Array.isArray(snap.fileLocks), 'snapshot.fileLocks 应是数组');
  assert.equal(snap.fileLocks.length, 1);
  /* 注意：listFileLocks/snapshot 返回的是**归一化后**的路径（小写盘符 + 正斜杠），
   * 这正是 normalizeForLock 的语义 —— 大小写与分隔符差异在 Windows 上是同一个文件。
   * 所以这里断言归一化形态，而不是原始 Windows 形态。 */
  assert.equal(snap.fileLocks[0].file, 'f:/proj/src/a.ts', '路径应已归一化（小写盘符 + /）');
  assert.equal(snap.fileLocks[0].tag, 'A');
  assert.ok(typeof snap.fileLocks[0].heldSec === 'number' && snap.fileLocks[0].heldSec >= 0);
  assert.ok(existsSync(d.fileLockDir), 'fileLockDir 应指向真实存在的目录');
  await waitTerminal(d, a.id);
});
