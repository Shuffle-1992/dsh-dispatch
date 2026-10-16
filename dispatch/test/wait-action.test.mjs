/**
 * ZB-08 回归测试：动作层的 wait（派发后能等结果，不必干等/轮询）。
 *
 * 用户问题：「会话派发一个 ZCode 进程，完成后会话能自动捕获继续任务么？」
 * 实测：dispatch 是 fire-and-forget（返回时 state=queued，无回调）。wait 就是补上这个缺口。
 *
 * 语义取舍（与 CLI 的 awaitJob 一致）：
 *   · 终态返回
 *   · paused **也返回**（不干等 —— paused 需要调用方决定 retry 续跑还是换通道交接）
 *   · 超时返回 timedOut:true + 当前状态，**绝不谎报完成**
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

const tempDirs = [];
const newWorkRoot = () => {
  const d = mkdtempSync(join(tmpdir(), 'dsp-wait-'));
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
function mkApi(opts = {}) {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 4, ...opts });
  return { d, api: createActionHandler(d, { switchPath: join(newWorkRoot(), 'sw.json') }) };
}

test('wait 等到终态：返回终态 job，timedOut=false', async () => {
  const { d, api } = mkApi();
  const dis = await api('dispatch', { kind: 'prompt', prompt: 'x', tag: 'W', timeoutMin: 1 });
  assert.equal(dis.ok, true);
  const r = await api('wait', { id: dis.job.id, timeoutSec: 15 });
  assert.equal(r.ok, true);
  assert.equal(r.timedOut, false, '应在超时前落地');
  assert.ok(TERMINAL.includes(r.job.state), `应为终态，实际=${r.job.state}`);
  assert.ok(typeof r.waitedSec === 'number' && r.waitedSec >= 0);
  assert.equal(r.job.id, dis.job.id);
});

test('wait 对已终态的 job：立即返回，不空转', async () => {
  const { d, api } = mkApi();
  const dis = await api('dispatch', { kind: 'prompt', prompt: 'x', tag: 'W2', timeoutMin: 1 });
  await api('wait', { id: dis.job.id, timeoutSec: 15 });
  const again = await api('wait', { id: dis.job.id, timeoutSec: 15 });
  assert.equal(again.ok, true);
  assert.equal(again.timedOut, false);
  assert.equal(again.waitedSec, 0, '已落地 ⇒ waitedSec 应为 0');
});

test('wait 缺 id / id 不存在：ok:false 且给出可读错误', async () => {
  const { api } = mkApi();
  const noId = await api('wait', {});
  assert.equal(noId.ok, false);
  assert.match(noId.error, /需要参数 id/);
  const gone = await api('wait', { id: 'j-nope' });
  assert.equal(gone.ok, false);
  assert.match(gone.error, /不存在/);
});

test('wait 超时：返回 timedOut=true + 当前状态，不谎报完成', async () => {
  const { d, api } = mkApi();
  // FAKE_SLEEP_MS 让 runner 睡久一点，保证 wait 超时先到
  const prev = process.env.FAKE_SLEEP_MS;
  process.env.FAKE_SLEEP_MS = '3000';
  try {
    const dis = await api('dispatch', { kind: 'prompt', prompt: 'x', tag: 'SLOW', timeoutMin: 1 });
    const r = await api('wait', { id: dis.job.id, timeoutSec: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.timedOut, true, '应如实报超时');
    assert.ok(TERMINAL.includes(r.job.state) === false, '超时的 job 不应被报成终态');
    assert.match(r.note, /等待超时/);
    assert.ok(['queued', 'running', 'paused'].includes(r.job.state), `超时态应仍在跑/排队，实际=${r.job.state}`);
    // 清理：等它落地，避免残留子进程
    await api('wait', { id: dis.job.id, timeoutSec: 20 });
  } finally {
    if (prev === undefined) delete process.env.FAKE_SLEEP_MS;
    else process.env.FAKE_SLEEP_MS = prev;
  }
});

test('wait 的 timeoutSec 非法：ok:false', async () => {
  const { api } = mkApi();
  const dis = await api('dispatch', { kind: 'prompt', prompt: 'x', tag: 'BAD', timeoutMin: 1 });
  const r = await api('wait', { id: dis.job.id, timeoutSec: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /正数/);
  await api('wait', { id: dis.job.id, timeoutSec: 15 });
});

test('paused 的 job：wait 立即返回 paused，不干等', async () => {
  const { api } = mkApi();
  const prevSleep = process.env.FAKE_SLEEP_MS;
  const prevExit = process.env.FAKE_EXIT_CODE;
  const prevPause = process.env.FAKE_PAUSE_TEXT;
  // 让假 runner 输出可识别的暂停原因并以非 0 退出 ⇒ job 落 paused
  process.env.FAKE_SLEEP_MS = '20';
  process.env.FAKE_EXIT_CODE = '1';
  process.env.FAKE_PAUSE_TEXT = 'quota_exceeded';
  try {
    const dis = await api('dispatch', { kind: 'prompt', prompt: 'x', tag: 'PAUSE', timeoutMin: 1 });
    const r = await api('wait', { id: dis.job.id, timeoutSec: 15 });
    assert.equal(r.ok, true);
    assert.equal(r.timedOut, false);
    assert.equal(r.job.state, 'paused', 'paused 也返回（不干等）');
    assert.equal(r.job.pauseReason, 'quota-exhausted');
  } finally {
    for (const [k, v] of [['FAKE_SLEEP_MS', prevSleep], ['FAKE_EXIT_CODE', prevExit], ['FAKE_PAUSE_TEXT', prevPause]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
