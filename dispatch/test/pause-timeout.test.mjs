/**
 * ZB-28 回归测试：paused 触发条件、超时终态与超时字段
 * （用户要求：把「paused 的全部触发条件、timeoutMin 上限与超时终态」写进文档**并落到 job 字段**）。
 *
 * 钉住的语义：
 *   · paused 触发 = 非 kill 请求 + 非 0 退出 + 输出命中暂停签名（四签名按优先级）；
 *     未命中但有输出 → failed + pauseReason='unknown'；pausedAt 落字段（= finishedAt）
 *   · runner 自身超时（--timeout-min 到点，done 行带 `(超时)`、exit=124）→ **failed**，
 *     timedOut=true + timedOutBy='runner'（此前 `(超时)` 标记被丢弃，无法与真失败区分）
 *   · dispatcher 看门狗（timeoutMin+宽限后仍未退出）→ **killed**，
 *     timedOut=true + timedOutBy='watchdog'；watchdogSec = 开火秒数落字段
 *   · timeoutMin 无上限（只校验 >0）—— 上限语义由文档说明，这里钉校验行为
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher, parseRunnerLine } from '../core/dispatch-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs');
process.env.DSP_FAKE_RUNNER = FAKE_RUNNER;

const tempDirs = [];
const newWorkRoot = () => {
  const d = mkdtempSync(join(tmpdir(), 'dsp-pt-'));
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
async function waitFor(pred, what, timeoutMs = 20000) {
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
const setEnv = (kv) => { for (const [k, v] of Object.entries(kv)) process.env[k] = v; };
const delEnv = (...ks) => { for (const k of ks) delete process.env[k]; };

test('parseRunnerLine：done 行的 `(超时)` 标记 → timedOut:true（exit=124）', () => {
  const withMark = parseRunnerLine('[zcode-run] done exit=124 (超时) elapsed=2700.0s session=s1 provider=plan model=M responseChars=2');
  assert.equal(withMark.exitCode, 124);
  assert.equal(withMark.timedOut, true);
  const noMark = parseRunnerLine('[zcode-run] done exit=0 elapsed=1.0s session=s1 provider=plan model=M responseChars=2');
  assert.ok(!noMark.timedOut, '无标记不带 timedOut');
  const minimal = parseRunnerLine('[zcode-run] done exit=124 (超时) elapsed=5.0s');
  assert.equal(minimal.timedOut, true, '最短形态（无 session 等可选字段）也带出标记');
});

test('★ 看门狗超时：killed + timedOut=true + timedOutBy=watchdog + watchdogSec 落字段', async () => {
  setEnv({ FAKE_SLEEP_MS: '6000' });
  delEnv('FAKE_EXIT_CODE', 'FAKE_PAUSE_TEXT', 'FAKE_TIMEOUT_DONE');
  try {
    const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1, timeoutGraceSec: 0 });
    const j = d.dispatch({ kind: 'prompt', prompt: 'x', tag: 'wd', timeoutMin: 0.03 }); // 1.8s 后看门狗开火
    assert.equal(d.get(j.id).watchdogSec, 1.8, 'watchdogSec = timeoutMin*60 + 宽限(0)');
    const done = await waitTerminal(d, j.id);
    assert.equal(done.state, 'killed', '看门狗强杀 → killed（不是 failed/interrupted）');
    assert.equal(done.timedOut, true);
    assert.equal(done.timedOutBy, 'watchdog');
    assert.ok(done.parseWarnings.some((w) => w.includes('watchdog')), '留痕：看门狗开火原因');
  } finally {
    delEnv('FAKE_SLEEP_MS');
  }
});

test('runner 自身超时：`(超时)` 标记 → failed（非 killed）+ timedOutBy=runner', async () => {
  setEnv({ FAKE_SLEEP_MS: '30', FAKE_TIMEOUT_DONE: '1' });
  delEnv('FAKE_EXIT_CODE', 'FAKE_PAUSE_TEXT');
  try {
    const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1 });
    const j = d.dispatch({ kind: 'prompt', prompt: 'x', tag: 'rt', timeoutMin: 5 });
    const done = await waitTerminal(d, j.id);
    assert.equal(done.state, 'failed', 'runner 超时 exit=124 且无暂停签名 → failed');
    assert.equal(done.exitCode, 124);
    assert.equal(done.timedOut, true);
    assert.equal(done.timedOutBy, 'runner', '与看门狗强杀（watchdog）区分');
  } finally {
    delEnv('FAKE_SLEEP_MS', 'FAKE_TIMEOUT_DONE');
  }
});

test('paused 触发：命中签名 → paused + pausedAt；未命中 → failed + pauseReason=unknown', async () => {
  setEnv({ FAKE_SLEEP_MS: '30', FAKE_EXIT_CODE: '1' });
  delEnv('FAKE_TIMEOUT_DONE');
  try {
    // 命中签名（额度耗尽）→ paused
    process.env.FAKE_PAUSE_TEXT = 'Error: quota_exceeded: plan quota is over for this window';
    const d1 = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1 });
    const j1 = d1.dispatch({ kind: 'prompt', prompt: 'x', tag: 'pz' });
    const p1 = await waitTerminal(d1, j1.id);
    assert.equal(p1.state, 'paused');
    assert.equal(p1.pauseReason, 'quota-exhausted');
    assert.ok(p1.pausedAt, 'pausedAt 落字段');
    assert.notEqual(new Date(p1.pausedAt).toString(), 'Invalid Date', 'pausedAt 是合法时间戳');
    assert.equal(p1.pausedAt, p1.finishedAt, 'pausedAt = 进入 paused 的时刻（finalize 时刻）');
    assert.ok(p1.pauseDetail.includes('quota_exceeded'), 'pauseDetail 留存命中的原文');

    // 未命中 → 保持 failed（Z1 语义），unknown 仅作信息字段
    process.env.FAKE_PAUSE_TEXT = 'some totally unknown crash';
    const d2 = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1 });
    const j2 = d2.dispatch({ kind: 'prompt', prompt: 'x', tag: 'pz2' });
    const p2 = await waitTerminal(d2, j2.id);
    assert.equal(p2.state, 'failed', '未命中签名保持 failed');
    assert.equal(p2.pauseReason, 'unknown');
    assert.equal(p2.pausedAt, null, '非 paused 的 pausedAt 恒 null');
  } finally {
    delEnv('FAKE_SLEEP_MS', 'FAKE_EXIT_CODE', 'FAKE_PAUSE_TEXT');
  }
});

test('timeoutMin 校验：>0 合法（无上限），非正数报错', () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1 });
  assert.throws(() => d.dispatch({ kind: 'prompt', prompt: 'x', timeoutMin: 0 }), TypeError);
  assert.throws(() => d.dispatch({ kind: 'prompt', prompt: 'x', timeoutMin: -3 }), TypeError);
  const j = d.dispatch({ kind: 'prompt', prompt: 'x', timeoutMin: 99999 });
  assert.ok(j && j.id, '大值合法（无上限；文档说明 runner 生效下限 1 分钟）');
  return waitTerminal(d, j.id);
});
