/**
 * ZB-40 回归测试：运行中可观测（心跳/当前阶段/"可能卡住"）+ 生命周期健壮性。
 *
 * 真机事故（2026-10-11）：三个作业用 `GLM-5.3` 在免费额度通道被上游判
 * `providerCode 1005 exceed quota limit`，轮次立刻失败；但 runner 只认 `turn.completed`，
 * 于是死等到 timeoutMin —— 外部表现是"running 35 分钟、零输出、额度不动"。
 *
 * 断言：
 *   ① 心跳行必须能被 parseRunnerLine 解析（含 stage/elapsed/chars/tools/lastTool/stageAgo/session）
 *   ② slimJob 依 lastProgressAt 给出 stalled / lastProgressAgoSec（>150s 且 running 才算卡住）
 *   ③ runner 侧：`turn.failed` 有显式分支（源码形态）、心跳打印模板存在、模型⇄权益校验存在
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunnerLine } from '../core/dispatch-core.mjs';
import { slimJob } from '../wire.host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GIFT = readFileSync(join(HERE, '..', '..', 'collab-kit', 'appserver-gift.mjs'), 'utf8');
const GIFT_JOB = readFileSync(join(HERE, '..', '..', 'collab-kit', 'appserver-gift-job.mjs'), 'utf8');
const RUNNER = readFileSync(join(HERE, '..', '..', 'collab-kit', 'zcode-run.mjs'), 'utf8');

test('ZB-40 ①：心跳行可被解析（完整形态 + 省略 lastTool/session）', () => {
  const full = '[zcode-run] progress stage=waiting-turn elapsed=120s chars=1024 tools=3 lastTool=Write stageAgo=8s session=sess_abc12345';
  const a = parseRunnerLine(full);
  assert.ok(a && a.progress, '应解析出 progress');
  assert.deepEqual(
    { ...a.progress, elapsedSec: a.progress.elapsedSec },
    { stage: 'waiting-turn', elapsedSec: 120, chars: 1024, tools: 3, lastTool: 'Write', stageAgoSec: 8, sessionId: 'sess_abc12345' },
  );
  assert.ok(Number.isFinite(a.lastProgressAt), '应带 lastProgressAt 时间戳');

  const min = parseRunnerLine('[zcode-run] progress stage=create-session elapsed=3s chars=0 tools=0 stageAgo=0s');
  assert.ok(min?.progress, '最小形态也应解析');
  assert.equal(min.progress.stage, 'create-session');
  assert.equal(min.progress.lastTool, null);
  assert.equal(min.progress.sessionId, null);

  /* 非心跳的 [zcode-run] 行仍是 null（未知形状→告警），不误判成 progress */
  assert.equal(parseRunnerLine('[zcode-run] 这不是已知形状'), null);
});

test('ZB-40 ②：slimJob 依心跳给出 stalled / lastProgressAgoSec', () => {
  const base = { id: 'j-x', state: 'running', spec: { kind: 'prompt', engine: 'opencode' }, tailLines: [] };
  const fresh = slimJob({ ...base, lastProgressAt: Date.now() - 5_000, progress: { stage: 'waiting-turn' } });
  assert.equal(fresh.stalled, false, '5s 前有心跳 ⇒ 不算卡住');
  assert.equal(fresh.lastProgressAgoSec, 5);
  assert.equal(fresh.progress.stage, 'waiting-turn');

  const stale = slimJob({ ...base, lastProgressAt: Date.now() - 300_000 });
  assert.equal(stale.stalled, true, '有心跳但 300s 没更新且 running ⇒ 标记可能卡住');

  /* ZB-120（真机测试修正语义）：**从没收到过心跳 ≠ 卡住**。
   * 原先这里断言 `true`（"也算可疑"），但真机证明这会把整类任务全标红：
   * 同一个 ZCode 引擎，print 模式（spawnSync 阻塞）从不发心跳、免费额度(app-server)模式却有。
   * 按"引擎会不会发心跳"去猜是错的（白名单站不住），改看**事实**：
   * `lastProgressAt` 无值 ⇒ 无从判断 ⇒ 不报（宁可不报，也不要全量误标）。 */
  const never = slimJob({ ...base });
  assert.equal(never.stalled, false, '★ running 但从未收到心跳 ⇒ 不报（无从判断，不是"可疑"）');
  assert.equal(never.lastProgressAgoSec, null, '无心跳 ⇒ 秒数为 null（不是 NaN）');

  const done = slimJob({ ...base, state: 'done', lastProgressAt: null });
  assert.equal(done.stalled, false, '终态不算卡住');

  /* ZB-120：**同一个 ZCode 引擎两种模式行为不同** —— print 模式无心跳 ⇒ 不报；
   * gift(app-server) 模式有心跳 ⇒ 超时照样能判卡住（这才是"看事实"的价值）。 */
  const zcodePrint = slimJob({ id: 'j-zp', state: 'running', spec: { kind: 'prompt', engine: 'zcode' }, tailLines: [], lastProgressAt: null });
  assert.equal(zcodePrint.stalled, false, '★ ZCode print 模式（无心跳）不误标');
  const zcodeGift = slimJob({ id: 'j-zg', state: 'running', spec: { kind: 'prompt', engine: 'zcode' }, tailLines: [], lastProgressAt: Date.now() - 300_000 });
  assert.equal(zcodeGift.stalled, true, '★ ZCode gift 模式（有心跳但停了 300s）能正确判卡住');
});

test('ZB-40 ③：runner 侧形态（turn.failed 分支 / 心跳模板 / 模型⇄权益校验）', () => {
  assert.ok(/case 'turn\.failed'/.test(GIFT), 'appserver-gift 有 turn.failed 分支（此前死等 turn.completed）');
  assert.ok(/providerError/.test(GIFT) && /providerCode/.test(GIFT), '把上游业务错误结构化带出');
  assert.ok(/\[zcode-run\] progress stage=/.test(GIFT_JOB), 'job 模块有心跳打印模板');
  assert.ok(/setInterval\(/.test(GIFT_JOB) && /clearInterval\(heartbeat\)/.test(GIFT_JOB), '心跳定时器有建立与清理');
  assert.ok(/模型替换/.test(RUNNER) && /readGiftQuota/.test(RUNNER), 'runner 做模型⇄权益校验（未授予模型会给 1005）');
});
