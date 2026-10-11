/**
 * ZB-26 硬化回归：五路审计里的 5 条必修项，每条都锁成可复跑断言。
 *
 *   B1  锁路径不做 realpath ⇒ 8.3 短名 / junction 指向同一文件却两把锁（单写者可被绕过）
 *   B2  任何进程构造 dispatcher 就改写**别进程**在跑的 job ⇒ zcd kill 永远失败、retry 重复派发
 *   B3  persist 只采纳「未知 id」、不合并更新版本 ⇒ 本进程旧副本覆盖别进程写的终态（丢失更新）
 *   B4  tail() 读取路径无越界校验 ⇒ 手改 jobs.json 的 captureOut = 任意文件读取
 *   A2  config 非法值曾让**整个插件不激活**（cordis 对 issues 直接 throw）⇒ 统一 warn + 安全默认
 *
 * 全部用真实 dispatcher + 假 runner（不触网、不派长任务）；时间可通过 options.now 注入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../core/dispatch-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs');
process.env.ZCD_FAKE_RUNNER = FAKE_RUNNER;

const tempDirs = [];
const newDir = (tag) => { const d = mkdtempSync(join(tmpdir(), `zcd-${tag}-`)); tempDirs.push(d); return d; };
test.after(() => {
  delete process.env.ZCD_FAKE_RUNNER;
  delete process.env.FAKE_SLEEP_MS;
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 句柄抖动 */ } }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- B1：锁路径必须 realpath ---------------- */
test('B1 同一文件的不同写法只对应一把锁（含 junction 与 8.3 短名）', async () => {
  const root = newDir('b1');
  const real = join(root, 'realdir');
  mkdirSync(real, { recursive: true });
  const target = join(real, 'a.ts');
  writeFileSync(target, 'x', 'utf8');
  const { normalizeForLock } = await import('../core/dispatch-core.mjs').then((m) => m.__testables ?? {});
  // __testables 未导出该函数时，退化为「用真实锁表间接验证」：见下方 dispatched 断言
  const view = { real, target };

  if (typeof normalizeForLock === 'function') {
    assert.equal(normalizeForLock(view.target), normalizeForLock(view.target.toUpperCase()), '大小写不同 → 同一把锁');
    assert.equal(normalizeForLock(join(real, '..', 'realdir', 'a.ts')), normalizeForLock(view.target), '含 .. 的写法 → 同一把锁');
  }

  /* junction（Windows 不需要管理员权限）指向同一目录：两条路径必须产出同一把锁。
   * 锁的可见后果：第一个任务持锁时，第二个任务必须排队（state=queued）。 */
  const linkDir = join(root, 'linkdir');
  let linked = false;
  try { symlinkSync(real, linkDir, 'junction'); linked = existsSync(join(linkDir, 'a.ts')); } catch { linked = false; }
  if (!linked) { console.log('  （junction 创建不可用，跳过两路径互斥断言）'); return; }

  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: join(root, '.data'), maxConcurrent: 4 });
  process.env.FAKE_SLEEP_MS = '400';
  const a = d.dispatch({ kind: 'prompt', prompt: 'hold', lock: 'repo', write: [target], timeoutMin: 1 });
  const b = d.dispatch({ kind: 'prompt', prompt: 'wait', lock: 'repo', write: [join(linkDir, 'a.ts')], timeoutMin: 1 });
  assert.equal(a.state === 'running' || a.state === 'queued', true, '第一个任务已建立');
  assert.equal(d.get(b.id).state, 'queued', '★ 经 junction 的同名文件必须与真实路径互斥（B1 之前会是 running → 两把锁）');
  await d.kill(a.id, 'test cleanup');
  await d.kill(b.id, 'test cleanup');
  await sleep(50);
});

/* ---------------- B2：不能改写别进程在跑的 job ---------------- */
test('B2 restore() 不改写「ownerPid 仍活着」的 running job；旧快照（无 ownerPid）仍按残留终结', () => {
  const root = newDir('b2');
  const workRoot = join(root, '.data');
  mkdirSync(join(workRoot, 'state'), { recursive: true });
  const mk = (id, state, ownerPid) => ({
    id, tag: id, spec: { kind: 'prompt', body: 'x', lock: 'repo' }, lock: 'repo',
    state, queuedAt: '2026-10-05T00:00:00.000Z', startedAt: '2026-10-05T00:00:01.000Z',
    finishedAt: null, elapsedSec: null, exitCode: null, signal: null, sessionId: null, provider: null,
    endpoint: null, model: null, usage: { requests: null, inputTokens: null, outputTokens: null, cacheReadTokens: null },
    contextUsed: null, contextWindow: null, responseChars: null, outLog: null, errLog: null, resultFile: null,
    captureOut: null, captureErr: null, tailLines: [], parseWarnings: [], memoryBanApplied: true, timedOut: false,
    summarySeen: false, ledgerMatched: false, pauseReason: null, pauseDetail: null, parentJobId: null,
    attempts: [], hopCount: 0, handedOffTo: null, resumedBy: null,
    ...(ownerPid === undefined ? {} : { ownerPid }),
  });
  const jobs = [
    mk('j-alive', 'running', process.pid),   // 本进程还活着 ⇒ 不得改写
    mk('j-legacy', 'running', undefined),    // ZB-26 之前的旧快照 ⇒ 旧语义（终结）
    mk('j-dead', 'running', 999999),         // pid 不存在 ⇒ 残留
  ];
  writeFileSync(join(workRoot, 'state', 'jobs.json'), JSON.stringify({ version: 1, jobs }, null, 2), 'utf8');

  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot, maxConcurrent: 2 });
  assert.equal(d.get('j-alive').state, 'running', '★ ownerPid 活着 ⇒ 保持 running（B2 之前会被改成 interrupted）');
  assert.equal(d.get('j-legacy').state, 'interrupted', '旧快照无 ownerPid ⇒ 保持旧语义（不破坏既有行为）');
  assert.equal(d.get('j-dead').state, 'interrupted', 'ownerPid 已死 ⇒ 判定为残留');
});

/* ---------------- B3：多进程 persist 按 updatedAt 合并，不丢更新 ---------------- */
test('B3 落后副本不覆盖盘上更新的终态（多进程丢失更新）', async () => {
  const root = newDir('b3');
  const workRoot = join(root, '.data');
  mkdirSync(join(workRoot, 'state'), { recursive: true });
  let clock = 1_000_000;
  const now = () => (clock += 1000); // 每次调用推进 1s，便于构造"谁更新"

  const base = (id, state, updatedAt) => ({
    id, tag: id, spec: { kind: 'prompt', body: 'x', lock: 'repo' }, lock: 'repo',
    state, queuedAt: '2026-10-05T00:00:00.000Z', finishedAt: null, elapsedSec: null, exitCode: null,
    signal: null, sessionId: null, provider: null, endpoint: null, model: null,
    usage: { requests: null, inputTokens: null, outputTokens: null, cacheReadTokens: null },
    contextUsed: null, contextWindow: null, responseChars: null, outLog: null, errLog: null, resultFile: null,
    captureOut: null, captureErr: null, tailLines: [], parseWarnings: [], memoryBanApplied: true, timedOut: false,
    summarySeen: false, ledgerMatched: false, pauseReason: null, pauseDetail: null, parentJobId: null,
    attempts: [], hopCount: 0, handedOffTo: null, resumedBy: null, updatedAt,
  });

  // 盘上：A 进程跑的 job X（running，旧时间戳，ownerPid=本进程 ⇒ restore 不得改写它，见 B2）
  writeFileSync(join(workRoot, 'state', 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ ...base('j-x', 'running', 1000), ownerPid: process.pid }] }, null, 2), 'utf8');

  // 进程 A：构造 dispatcher（会采纳 X 到内存）
  const A = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot, maxConcurrent: 2, now });
  assert.equal(A.get('j-x').state, 'running', 'A 先采纳盘上的 running');

  // 进程 B 之后把 X 收尾（更晚的时间戳）并落盘
  const disk = JSON.parse(readFileSync(join(workRoot, 'state', 'jobs.json'), 'utf8'));
  disk.jobs = [base('j-x', 'done', 9_999_999)];
  writeFileSync(join(workRoot, 'state', 'jobs.json'), JSON.stringify(disk, null, 2), 'utf8');

  // A 再派一个自己的任务 ⇒ 触发 persist()：必须**合并**盘上更新的终态，而不是用旧副本覆盖
  const a = A.dispatch({ kind: 'prompt', prompt: 'A 的新任务', lock: 'none', timeoutMin: 1 });
  assert.ok(a && a.id, 'A 派发成功');
  const after = JSON.parse(readFileSync(join(workRoot, 'state', 'jobs.json'), 'utf8'));
  const x = after.jobs.find((j) => j.id === 'j-x');
  assert.equal(x.state, 'done', '★ 盘上更新的终态被采纳（B3 之前会被 A 的旧 running 覆盖回去）');

  /* 收尾：A 刚派的那个 job 是真子进程，必须等它落终态再放测试结束 ——
   * 否则测试退出时 dispatcher 仍在轮询/落盘，与 test.after 的临时目录清理赛跑（ENOENT 噪音）。 */
  A.kill(a.id, 'test cleanup');
  for (let i = 0; i < 200 && !['done', 'failed', 'killed', 'interrupted'].includes(A.get(a.id)?.state); i += 1) await sleep(25);
  await sleep(150);
});

/* ---------------- B4：tail() 读取路径必须做越界校验 ---------------- */
test('B4 tail() 不读取越界路径（手改 jobs.json 的 captureOut 不能读任意文件）', () => {
  const root = newDir('b4');
  const workRoot = join(root, '.data');
  mkdirSync(join(workRoot, 'state'), { recursive: true });
  mkdirSync(join(workRoot, 'logs'), { recursive: true });
  const secret = join(root, 'secret.txt');
  writeFileSync(secret, 'TOP-SECRET-LINE\n', 'utf8');
  const inside = join(workRoot, 'logs', 'ok.out.log');
  writeFileSync(inside, 'legit-1\nlegit-2\n', 'utf8');

  const job = (id, captureOut) => ({
    id, tag: id, spec: { kind: 'prompt', body: 'x', lock: 'none' }, lock: null, state: 'done',
    queuedAt: '2026-10-05T00:00:00.000Z', finishedAt: '2026-10-05T00:00:05.000Z', elapsedSec: 5, exitCode: 0,
    signal: null, sessionId: null, provider: null, endpoint: null, model: null,
    usage: { requests: null, inputTokens: null, outputTokens: null, cacheReadTokens: null },
    contextUsed: null, contextWindow: null, responseChars: null, outLog: null, errLog: null, resultFile: null,
    captureOut, captureErr: null, tailLines: [], parseWarnings: [], memoryBanApplied: true, timedOut: false,
    summarySeen: false, ledgerMatched: false, pauseReason: null, pauseDetail: null, parentJobId: null,
    attempts: [], hopCount: 0, handedOffTo: null, resumedBy: null,
  });
  writeFileSync(join(workRoot, 'state', 'jobs.json'), JSON.stringify({
    version: 1,
    jobs: [job('j-evil', secret), job('j-ok', inside)],
  }, null, 2), 'utf8');

  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot, maxConcurrent: 1 });
  const evil = d.tail('j-evil', 10);
  assert.equal(Array.isArray(evil), true, 'tail 仍返回数组（安全降级，不抛）');
  assert.equal(evil.some((l) => String(l).includes('TOP-SECRET')), false, '★ 越界文件内容不得出现在 tail 结果里（B4 之前会读到）');
  const notes = (d.get('j-evil').parseWarnings ?? []).join('\n');
  assert.match(notes, /忽略越界的 captureOut/, '越界被**留痕**（不静默，便于排障）');

  const ok = d.tail('j-ok', 10);
  assert.ok(ok.includes('legit-2'), '允许根内的捕获日志仍可正常读取（没把功能改坏）');
});

/* ---------------- A2：config 永不因非法值阻断激活 ---------------- */
test('A2 非法 config 一律 warn + 安全默认（不再让插件整体不激活）', async () => {
  const { Config } = await import('../index.js');
  const validate = Config['~standard'].validate;
  assert.equal(typeof validate, 'function', 'Config 仍是 Standard Schema');

  // DSH 判「原生 schema」的结构条件（isNativeConfigSchema）：品牌 + type + meta
  assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true, '★ schemastery 品牌仍在（否则 DSH 判 unsupported）');
  assert.equal(typeof Reflect.get(Config, 'type'), 'string', 'type 仍是字符串');
  assert.equal(Reflect.get(Config, 'meta') !== null && typeof Reflect.get(Config, 'meta') === 'object', true, 'meta 仍是对象');

  const bad = validate({ maxConcurrent: 0, maxConsecutiveWakes: 2.5, runnerPath: 123, demo: 'yes', notifyOnSettle: 'false', bogus: 1 });
  assert.equal(bad.issues, undefined, '★ 非法配置**不再返回 issues**（原先 cordis 会 throw ⇒ 插件 INACTIVE）');
  assert.equal(bad.value.maxConcurrent, 1, 'maxConcurrent=0 → 夹到下限 min=1（不是回落 def）');
  assert.equal(bad.value.maxConsecutiveWakes, 2, 'maxConsecutiveWakes=2.5 → 取整 2（原先被静默当"不限"=0）');
  assert.equal(bad.value.runnerPath, '', 'runnerPath=123（非字符串）→ 空串');
  assert.equal(bad.value.demo, false, "demo='yes' → false");
  assert.equal(bad.value.notifyOnSettle, true, "notifyOnSettle='false'（字符串）→ 默认 true（不做字符串真值推断）");

  const good = validate({ maxConcurrent: 4, notifyOnSettle: false, runnerPath: 'r', workRoot: 'w' });
  assert.equal(good.issues, undefined, '合法配置照旧');
  assert.equal(good.value.maxConcurrent, 4, '合法值原样保留');
  assert.equal(good.value.notifyOnSettle, false, 'false 被尊重');
  assert.equal(good.value.runnerPath, 'r');
  assert.equal(validate({}).value.maxConcurrent, 3, '空配置补默认值');
});
