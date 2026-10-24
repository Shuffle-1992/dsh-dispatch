/**
 * ZB-114 回归：persist 热路径节流 —— **不丢终态**
 *
 * 来源：GLM-5.3 与 GLM-5.3-Flash 两份独立审查的**共同发现**（最高置信度）：
 *   `handleLine` 每收到一条 runner 输出行就 `persist()`，而 persist 每次都要
 *   「读整个 jobs.json → JSON.parse → 全量淘汰 → JSON.stringify(pretty) → atomicWrite」。
 *   任务输出密集时（每秒几十行）主线程同步 I/O 被放大成 O(行数 × 文件大小)。
 *
 * 修法：只对这条热路径做 200ms 合并落盘（`persistThrottled`），
 * 终态/状态变更/用户操作仍走 `persist()` 立即落盘。
 *
 * 本文件钉三件事：
 *   A. 热路径确实改成了节流版（源码锁，防止有人改回去）；
 *   B. `persist()`（立即）会取消挂起的节流批，避免重复写；
 *   C. **行为**：job 落地后**立刻**读 jobs.json，终态必须已在盘上（节流绝不能吞终态）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../core/dispatch-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = readFileSync(join(HERE, '..', 'core', 'dispatch-core.mjs'), 'utf8');
const FAKE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs');
process.env.DSP_FAKE_RUNNER = FAKE_RUNNER;

const tempDirs = [];
const newWorkRoot = () => {
  const d = mkdtempSync(join(tmpdir(), 'dsp-persist-'));
  tempDirs.push(d);
  return d;
};
test.after(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const setEnv = (o) => { for (const [k, v] of Object.entries(o)) process.env[k] = v; };
const delEnv = (...ks) => { for (const k of ks) delete process.env[k]; };
const waitTerminal = async (d, id, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const j = d.get(id);
    if (j && ['done', 'failed', 'killed', 'paused'].includes(j.state)) return j;
    if (Date.now() - t0 > ms) throw new Error(`waitTerminal 超时：${id} 仍是 ${j?.state}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/* ── A. 源码锁：热路径必须是节流版 ── */
test('ZB-114 ①：handleLine 热路径改用 persistThrottled（不是 persist）', () => {
  assert.match(CORE, /function persistThrottled\(\)/, '存在 persistThrottled');
  assert.match(CORE, /PERSIST_THROTTLE_MS = 200/, '节流窗口 200ms');
  assert.match(CORE, /persistTimer\.unref\?\.\(\)/, '定时器 unref（不阻止进程退出）');
  /* handleLine 尾部必须是 persistThrottled()，不能退回 persist()（源码是 CRLF，用 \r?\n） */
  const m = CORE.match(/if \(isTerminal\(job\)\) return;[^\r\n]*\r?\n([\s\S]{0,1200}?)emit\('job-updated', job\);/);
  assert.ok(m, '能取出 handleLine 尾段');
  assert.match(m[1], /persistThrottled\(\)/, '★ 热路径用节流版');
  assert.doesNotMatch(m[1], /^\s*persist\(\);$/m, '★ 热路径不能再直接 persist()');
});

/* ── B. 立即落盘会取消挂起的节流批 ── */
test('ZB-114 ②：persist() 立即落盘时取消挂起的节流批', () => {
  const fn = CORE.match(/function persist\(\) \{([\s\S]{0,700}?)if \(existsSync\(jobsFile\)\)/);
  assert.ok(fn, '能取出 persist 开头');
  assert.match(fn[1], /clearTimeout\(persistTimer\)/, '★ 取消挂起的定时器');
  assert.match(fn[1], /persistDirty = false/, '★ 清脏标记（避免重复写）');
});

/* ── C. 行为：终态必须立即落盘（节流不能吞掉它） ── */
test('ZB-114 ③：job 落地后立刻读 jobs.json，终态已在盘上', async () => {
  setEnv({ FAKE_SLEEP_MS: '20' });
  delEnv('FAKE_EXIT_CODE', 'FAKE_PAUSE_TEXT', 'FAKE_TIMEOUT_DONE');
  try {
    const workRoot = newWorkRoot();
    const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot, maxConcurrent: 1 });
    const j = d.dispatch({ kind: 'prompt', prompt: 'x', tag: 'pt', timeoutMin: 5 });
    const done = await waitTerminal(d, j.id);
    assert.equal(done.state, 'done');
    /* 关键：**立刻**读盘（不等 200ms 节流窗口）—— 终态必须已经写下去。
     * 落盘位置是 `<workRoot>/state/jobs.json`（core 的 dirState）。 */
    const jobsFile = join(workRoot, 'state', 'jobs.json');
    assert.ok(existsSync(jobsFile), 'jobs.json 存在');
    const onDisk = JSON.parse(readFileSync(jobsFile, 'utf8'));
    const rec = (onDisk.jobs ?? []).find((x) => x.id === j.id);
    assert.ok(rec, '★ 盘上有该 job 的记录');
    assert.equal(rec.state, 'done', '★ 终态已落盘（没被节流吞掉）');
    assert.ok(rec.finishedAt, '★ 终态的 finishedAt 也在盘上');
  } finally {
    delEnv('FAKE_SLEEP_MS');
  }
});
