#!/usr/bin/env node
/**
 * lock-none-free.test.mjs —— ZB-80 真机 bug 回归：**`lock: 'none'` 必须真的"不取锁"**
 *
 * 真机现场（2026-10-20 验证轮）：派发时显式传 `lock: 'none'`（教学文档承诺的"明确不取锁"），
 * 任务却**排在队列里等一个它根本不需要的锁** —— `lockWait.blockers` 显示
 * `cross:file:…/smoke`（**另一个会话**持有的文件锁）。用户看到的是"我明明说了不取锁，为什么在排队"。
 *
 * 根因：`crossLevelBlocked(job, locks)` 原先只看"**想要哪种锁**"（有 file ⇒ 查 repo 锁；
 * 否则 ⇒ 查 file 锁），**没有先判"到底想不想要锁"**。
 * `locksFor(spec)` 对 `lock:'none'` 返回**空数组**，而空数组落进 `else` 分支
 * ⇒ 被当成"想拿整仓库锁" ⇒ 去查别人的文件锁 ⇒ 挡住。
 *
 * 本文件钉三件事：
 *   A. `lock:'none'` 的任务**立即 running**（不被任何锁挡住）；
 *   B. `lock:'repo'` / 声明 write 的任务**仍正确排队**（不能为了修 A 而破坏互斥）；
 *   C. `lockWait` 对 `lock:'none'` 不再报出 blocker（观测与事实一致）。
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\nA. lock:none ⇒ 真的不取锁（不被任何人的锁挡住）');
{
  const dir = mkdtempSync(join(tmpdir(), 'dsp-nonelock-'));
  roots.push(dir);
  const slow = join(dir, 'slow.mjs');
  writeFileSync(slow, 'setTimeout(() => process.exit(0), 2500);\n', 'utf8');
  const d = createDispatcher({
    runnerPath: slow, opencodeRunnerPath: slow, qoderRunnerPath: slow,
    channelsProbeImpl: () => '', channelsImpl: async () => ({ channels: [], warnings: [] }),
    maxConcurrent: 8, maxConcurrentQoder: 8,
    workRoot: join(dir, 'work'), jobsFile: join(dir, 'state', 'jobs.json'),
  });
  try {
    /* ① 先让一个**持文件锁**的任务跑起来（模拟"另一个会话占着锁"）。 */
    const holder = d.dispatch({ kind: 'prompt', prompt: 'h', lock: 'repo', write: [join(dir, 'a.txt')], timeoutMin: 1, tag: 'holder' });
    await sleep(300);
    const hid = holder.id ?? holder.job?.id;
    ok(d.get(hid)?.state === 'running', 'A0 前置：持文件锁的任务已在 running');

    /* ② lock:'none' ⇒ 应当**立即 running**。 */
    const free = d.dispatch({ kind: 'prompt', prompt: 'f', lock: 'none', timeoutMin: 1, tag: 'none' });
    const fid = free.id ?? free.job?.id;
    await sleep(400);
    const f = d.get(fid);
    ok(f?.state === 'running', `A1 ★ lock:none 的任务立即 running（实际 ${f?.state}）——修复前会 queued 等别人的锁`);
    ok(!f?.lockWait || (f.lockWait.blockers ?? []).length === 0,
      `A2 ★ 不再报出 blocker（实际 ${JSON.stringify(f?.lockWait?.blockers?.map((b) => b.lock) ?? [])}）`);

    /* ③ 对照：lock:'repo' 仍**正确排队**（互斥语义不能被修坏）。 */
    const repo = d.dispatch({ kind: 'prompt', prompt: 'r', lock: 'repo', timeoutMin: 1, tag: 'repo' });
    await sleep(300);
    const r = d.get(repo.id ?? repo.job?.id);
    ok(r?.state === 'queued', `A3 ★ lock:repo 的任务仍正确排队（实际 ${r?.state}）——互斥语义保持`);
    ok((r?.lockWait?.blockers ?? []).length > 0, 'A4 lock:repo 的 lockWait 如实报出 blocker（观测与事实一致）');

    /* ④ 对照：声明 write 的文件锁任务，与 holder 争同一文件 ⇒ 也排队。 */
    const wf = d.dispatch({ kind: 'prompt', prompt: 'w', lock: 'repo', write: [join(dir, 'a.txt')], timeoutMin: 1, tag: 'wf' });
    await sleep(300);
    ok(d.get(wf.id ?? wf.job?.id)?.state === 'queued', 'A5 争同一文件的文件锁任务仍排队（细粒度互斥保持）');

    /* ⑤ lock:'none' 的任务不被"文件锁 vs 整仓库锁"跨层级判定牵连（同一判据两处入口一致）。 */
    const free2 = d.dispatch({ kind: 'prompt', prompt: 'f2', lock: 'none', timeoutMin: 1, tag: 'none2' });
    await sleep(300);
    ok(d.get(free2.id ?? free2.job?.id)?.state === 'running', 'A6 ★ 多个 lock:none 任务都能并发跑（互不阻塞）');
  } finally { d.dispose?.(); }
}

cleanup();
console.log(`\n===== ZB-80 lock:none 真的不取锁：${pass} PASS / ${fails.length} FAIL =====`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
process.exit(0);
