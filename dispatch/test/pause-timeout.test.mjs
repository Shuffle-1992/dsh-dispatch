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

test('timeoutMin 校验：>0 合法（ZB-118 起有实际上的限），非正数/超限报错', () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1 });
  assert.throws(() => d.dispatch({ kind: 'prompt', prompt: 'x', timeoutMin: 0 }), TypeError);
  assert.throws(() => d.dispatch({ kind: 'prompt', prompt: 'x', timeoutMin: -3 }), TypeError);
  /* ZB-118（GLM-5.3 审查 MED）：**有意改变旧语义** —— 原先"无上限"，但 Node 的 setTimeout
   * 上限是 2^31-1 ms，超过会被**静默钳成 1ms** ⇒ 看门狗一启动就开火误杀。
   * 现在显式挡掉（上限约 35791 分钟 ≈ 24.8 天）；1 天这类正常大值仍然合法。 */
  assert.throws(() => d.dispatch({ kind: 'prompt', prompt: 'x', timeoutMin: 99999 }), TypeError,
    '超过 Node 定时器上限必须报错（否则看门狗误杀）');
  const j = d.dispatch({ kind: 'prompt', prompt: 'x', timeoutMin: 1440 }); // 1 天
  assert.ok(j && j.id, '正常大值合法（1440 分钟 = 1 天；runner 生效下限 1 分钟）');
  return waitTerminal(d, j.id);
});

/* ── ZB-112（用户真机指出）：「额度非常充足，显示额度不够」──
 * 现场：GLM-5.3-Flash 审查任务跑满 25 分钟被 runner 杀（exit=124），面板却显示"已暂停：额度耗尽"，
 * 而实际额度 88%/91%。根因：任务跑久了输出里必然有 429/限流字样（它自己派的子代理撞的、重试过的），
 * `classifyPause` 从文本里扫到 `/429/` 就判 quota-exhausted —— 超时被"猜"成了额度耗尽。
 * 钉住：**超时是确定事实（exit 124 + `(超时)` 标记），必须优先判定，绝不从文本猜额度**。 */
test('ZB-112：超时 + 输出里含 429 ⇒ 仍 failed（绝不判额度耗尽）', async () => {
  /* 注意 fake-runner 的实现：设了 FAKE_PAUSE_TEXT 就**提前** `process.exit(FAKE_EXIT_CODE ?? 1)`，
   * 所以这里必须显式给 FAKE_EXIT_CODE=124 才能造出"超时 + stderr 有 429"的组合
   * （另一条既有测试用 FAKE_TIMEOUT_DONE 覆盖"done 行带 `(超时)`"的形态）。 */
  setEnv({ FAKE_SLEEP_MS: '30', FAKE_EXIT_CODE: '124', FAKE_PAUSE_TEXT: 'HTTP 429 rate limited (retry-after 600)' });
  delEnv('FAKE_TIMEOUT_DONE');
  try {
    const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1 });
    const j = d.dispatch({ kind: 'prompt', prompt: 'x', tag: 'zt', timeoutMin: 5 });
    const done = await waitTerminal(d, j.id);
    assert.equal(done.state, 'failed', '超时不是暂停（ZB-28 既有语义：failed + timedOut 字段）');
    assert.equal(done.exitCode, 124);
    assert.equal(done.timedOut, true);
    assert.equal(done.timedOutBy, 'runner');
    assert.notEqual(done.pauseReason, 'quota-exhausted', '★ 绝不把"跑太久被超时"报成"额度耗尽"');
    assert.notEqual(done.state, 'paused', '超时不该进 paused 队列等人工处理');
  } finally {
    delEnv('FAKE_SLEEP_MS', 'FAKE_EXIT_CODE', 'FAKE_PAUSE_TEXT');
  }
});
