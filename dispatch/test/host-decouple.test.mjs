/**
 * host-decouple —— 宿主半边「解耦/简化」执行轮（task-11）的**验收哨兵**（离线、不触网、不 spawn）。
 *
 * 覆盖 5 项改动（每项都在下面给出**改前/改后**都能跑的形状）：
 *   ① [P0-1] 通道探测**双跑**：`dispatch` 动作在"台账有近期限流"时不得调 `dispatcher.listChannels()`
 *      多于 1 次（core 的 listChannels 每次都会 spawn 探测，双跑 = 派发被阻塞数十秒）。
 *      用**假 dispatcher 计数**做硬证据；限流命中 / 未命中两种输入都断言 ≤1。
 *   ② [P0-3] remote 方法表**单源**：`REMOTE_METHODS`（唯一源）与 `FACE_METHOD_TABLE`（元数据）
 *      方法集完全相等，且 `TYPERT.invocations` 覆盖全部方法（此前缺 modelSwitchesGet/modelSwitchSet）。
 *   ③ [M2] 状态目录**单一所有者**：core 暴露 `statePath(name)`；wire 不再自己 `dirname(jobsFile)` 拼路径。
 *   ④ [M3] 台账「近期限流」解析入 core：`core/quota.mjs` 的 `recentRateLimited` 是唯一实现，
 *      wire 的 `recentQuotaExhausted` **引用同一函数**（引用级同一性，防第二份实现漂移）。
 *   ⑤ [F8] `validateSpec` 单次调用：非法 spec 仍抛可读 TypeError（行为不变），且调用点只剩一处，
 *      且必须发生在引擎规整**之前**（否则显式非法 engine 会被静默规整成 zcode）。
 *
 * 断言用「软计数」：失败不中断，跑完打印 ✗ 清单并以非零退出码结束（便于一次运行看到所有项的现状）。
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const read = (f) => readFileSync(join(PKG, f), 'utf8');
const WIRE_SRC = read('wire.host.mjs');
const CORE_SRC = read('core/dispatch-core.mjs');

const wire = await import(new URL('../wire.host.mjs', import.meta.url).href);
const coreQuota = await import(new URL('../core/quota.mjs', import.meta.url).href);
const coreMod = await import(new URL('../core/dispatch-core.mjs', import.meta.url).href);

let pass = 0;
const fails = [];
const ok = (cond, msg, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}${extra}`); return true; }
  fails.push(msg);
  console.log(`  ✗ ${msg}${extra}`);
  return false;
};

const tempDirs = [];
const newDir = (tag) => { const d = mkdtempSync(join(tmpdir(), `dsp-decouple-${tag}-`)); tempDirs.push(d); return d; };
process.on('exit', () => {
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 句柄抖动 */ } }
});

/* ───────────────────────── ① [P0-1] 探测双跑（计数断言） ───────────────────────── */

/** 写一份"刚撞过额度"的台账（字段形状 = runner 写的：at/provider/rateLimited）。 */
function writeRateLimitedLedger(dir) {
  const file = join(dir, 'dispatch-runs.jsonl');
  writeFileSync(file, `${JSON.stringify({
    at: new Date().toISOString(),
    provider: 'plan:bigmodel-coding-plan',
    rateLimited: true,
    retryAfterSec: 600,
  })}\n`, 'utf8');
  return file;
}

const CHANNELS = [
  { id: 'plan', name: '默认套餐', enabled: true, aliasOf: 'builtin:bigmodel-coding-plan', endpoint: 'https://x', models: ['GLM-5.3'] },
  { id: 'account:bigmodel-start-plan', name: '免费额度', enabled: true, endpoint: 'https://y', models: ['GLM-5.3-Flash'] },
];

/** 假 dispatcher：只实现 dispatch 分支真正用到的面，并统计 listChannels / getChannel 调用次数。 */
function fakeDispatcher({ defaultProvider = 'plan', counts }) {
  return {
    jobsFile: join(tmpdir(), 'dsp-decouple-fake', 'state', 'jobs.json'),
    async listChannels() {
      counts.listChannels += 1;
      return { channels: CHANNELS, warnings: [], engines: ['zcode', 'opencode', 'qoder'] };
    },
    async getChannel() {
      counts.getChannel += 1;
      return { provider: defaultProvider, model: null, reasoningLevel: null };
    },
    getFallbackChain() { return { enabled: false, targets: [], chain: [] }; },
    dispatch(spec) {
      counts.dispatch += 1;
      return {
        id: 'j-fake-1', state: 'queued', tag: null, spec: { ...spec },
        queuedAt: new Date().toISOString(), finishedAt: null, elapsedSec: null, exitCode: null,
        provider: null, model: null, usage: {}, tailLines: [], parseWarnings: [], attempts: [],
      };
    },
  };
}

console.log('① [P0-1] 探测次数（假 dispatcher 计数；核心断言：listChannels ≤ 1）');
{
  // 命中：台账有近期限流 + 目标通道撞顶 ⇒ guard/hint 都要通道清单（改前各拉一次 = 2）
  const hitDir = newDir('hit');
  const ledgerHit = writeRateLimitedLedger(hitDir);
  const countsHit = { listChannels: 0, getChannel: 0, dispatch: 0 };
  const handleHit = wire.createActionHandler(fakeDispatcher({ counts: countsHit }), { ledgerPath: ledgerHit, switchPath: join(hitDir, 'switch.json') });
  const resHit = await handleHit('dispatch', { kind: 'prompt', prompt: '只回答 OK', provider: 'plan' });
  ok(countsHit.listChannels <= 1, '限流命中：listChannels 调用次数 ≤ 1', `（实际 ${countsHit.listChannels}）`);
  ok(countsHit.dispatch === 1, '限流命中：仍然建了 job（提示/改派不阻塞派发）', `（实际 ${countsHit.dispatch}）`);
  ok(resHit?.ok === true && typeof resHit.job?.id === 'string', '限流命中：返回 { ok:true, job }');
  ok(resHit?.redirectedFrom === 'plan', '限流命中：仍带 redirectedFrom=plan（字段一字不改）');
  ok(typeof resHit?.warning === 'string' && resHit.warning.includes('已改派'), '限流命中：仍带 warning（含改派说明）');

  // 未命中：台账里没有限流条目 ⇒ 两个函数都应**在探测之前**早退（0 次）
  const missDir = newDir('miss');
  const ledgerMiss = join(missDir, 'dispatch-runs.jsonl');
  writeFileSync(ledgerMiss, `${JSON.stringify({ at: new Date().toISOString(), provider: 'plan:bigmodel-coding-plan' })}\n`, 'utf8');
  const countsMiss = { listChannels: 0, getChannel: 0, dispatch: 0 };
  const handleMiss = wire.createActionHandler(fakeDispatcher({ counts: countsMiss }), { ledgerPath: ledgerMiss, switchPath: join(missDir, 'switch.json') });
  const resMiss = await handleMiss('dispatch', { kind: 'prompt', prompt: '只回答 OK', provider: 'plan' });
  ok(countsMiss.listChannels <= 1, '限流未命中：listChannels 调用次数 ≤ 1', `（实际 ${countsMiss.listChannels}）`);
  ok(resMiss?.redirectedFrom === undefined && resMiss?.warning === undefined, '限流未命中：不带改派/提示字段（不误报）');

  // 台账文件不存在：不抛、不探测
  const noneDir = newDir('none');
  const countsNone = { listChannels: 0, getChannel: 0, dispatch: 0 };
  const handleNone = wire.createActionHandler(fakeDispatcher({ counts: countsNone }), { ledgerPath: join(noneDir, 'nope.jsonl'), switchPath: join(noneDir, 'switch.json') });
  const resNone = await handleNone('dispatch', { kind: 'prompt', prompt: 'x' });
  ok(countsNone.listChannels === 0 && resNone?.ok === true, '台账不存在：0 次探测且照常派发', `（listChannels=${countsNone.listChannels}）`);

  // 两个导出仍可用（channel-health 直接 import 它们，签名/行为不得变）
  const countsGuard = { listChannels: 0, getChannel: 0, dispatch: 0 };
  const guard = await wire.applyExhaustedChannelGuard(fakeDispatcher({ counts: countsGuard }), { kind: 'prompt', provider: 'plan' }, { ledgerPath: ledgerHit });
  ok(guard?.to === 'account:bigmodel-start-plan', 'applyExhaustedChannelGuard 仍返回改派目标（导出未变）');
  const countsHint = { listChannels: 0, getChannel: 0, dispatch: 0 };
  const hint = await wire.dispatchQuotaHint(fakeDispatcher({ counts: countsHint }), { kind: 'prompt', provider: 'plan' }, { ledgerPath: ledgerHit });
  ok(hint?.suggestedProvider === 'account:bigmodel-start-plan', 'dispatchQuotaHint 仍返回 suggestedProvider（导出未变）');
}

/* ───────────────────────── ② [P0-3] 方法表单源 ───────────────────────── */

console.log('\n② [P0-3] remote 方法表单源（REMOTE_METHODS ≡ FACE_METHOD_TABLE ≡ TYPERT）');
{
  const literal = WIRE_SRC.match(/const REMOTE_METHODS = (\[[^\]]*\]);/);
  ok(!!literal, 'REMOTE_METHODS 仍是**单行字面量数组**（single-source:76 钉住）');
  const remoteMethods = literal ? JSON.parse(literal[1].replace(/'/g, '"')) : [];
  const tableBlock = WIRE_SRC.match(/const FACE_METHOD_TABLE = \[([\s\S]*?)\n\];/);
  const tableMethods = tableBlock ? [...tableBlock[1].matchAll(/^\s*\['([a-zA-Z]+)',/gm)].map((m) => m[1]) : [];
  const sort = (a) => [...new Set(a)].sort().join(',');
  ok(tableMethods.length > 0, `能取出 FACE_METHOD_TABLE（${tableMethods.length} 行）`);
  ok(sort(tableMethods) === sort(remoteMethods), '★ FACE_METHOD_TABLE 与 REMOTE_METHODS 方法集**完全相等**',
    `（${tableMethods.length} vs ${remoteMethods.length}）`);
  const missing = remoteMethods.filter((m) => !tableMethods.includes(m));
  ok(missing.length === 0, 'REMOTE_METHODS 里没有缺元数据的方法', `（缺：${missing.join(',') || '无'}）`);

  const invocations = wire.TYPERT?.invocations ?? [];
  const invMethods = invocations.map((i) => i.method);
  ok(sort(invMethods) === sort(remoteMethods), 'TYPERT.invocations 覆盖全部 REMOTE_METHODS',
    `（${invMethods.length} vs ${remoteMethods.length}）`);
  ok(invMethods.includes('modelSwitchesGet') && invMethods.includes('modelSwitchSet'),
    '★ 此前缺的两个方法（modelSwitchesGet/modelSwitchSet）已进 TYPERT');
  const noCodec = invocations.filter((i) => !i.result || i.result.mode !== 'strict' || typeof i.result.create !== 'function');
  ok(noCodec.length === 0, '每个 invocation 都带 strict codec', `（缺：${noCodec.map((i) => i.method).join(',') || '无'}）`);
  const paramless = invocations.filter((i) => !Array.isArray(i.parameters));
  ok(paramless.length === 0, '每个 invocation 都带 parameters 数组');
  const members = wire.TYPERT?.model?.services?.[0]?.members ?? [];
  ok(sort(members.map((m) => m.name)) === sort(remoteMethods), 'TYPERT.model.services[].members 与方法集一致');
}

/* ───────────────────────── ③ [M2] statePath ───────────────────────── */

console.log('\n③ [M2] 状态目录单一所有者（core.statePath）');
{
  const { createDispatcher } = coreMod;
  const root = newDir('statepath');
  const d = createDispatcher({ runnerPath: join(HERE, 'fixtures', 'fake-runner.mjs'), workRoot: root });
  ok(typeof d.statePath === 'function', 'dispatcher 暴露 statePath(name)');
  // 缺 statePath（改前）时用占位值继续跑，让后面的项也能出结果（软断言不中断）
  const statePathOf = (name) => (typeof d.statePath === 'function' ? d.statePath(name) : `<no statePath:${name}>`);
  const p = statePathOf('dismissed.json');
  ok(p === join(dirname(d.jobsFile), 'dismissed.json'), 'statePath 就是 jobsFile 同目录（路径推导只此一处）', `（${p}）`);
  ok(statePathOf('wake-stats.json') === join(dirname(d.jobsFile), 'wake-stats.json'), 'statePath 对其它状态文件同样成立');
  ok(/dispatcher\.statePath\('dismissed\.json'\)/.test(WIRE_SRC), '★ wire.host.mjs 的 dismissed 路径改走 dispatcher.statePath');
  ok(!/const dismissedFileOf = \(dispatcher\) => join\(dirname\(dispatcher\.jobsFile\)/.test(WIRE_SRC),
    'wire 不再自己 dirname(jobsFile) 拼 dismissed 路径');
}

/* ───────────────────────── ④ [M3] 台账解析入 core ───────────────────────── */

console.log('\n④ [M3] 台账「近期限流」解析入 core（引用级单源）');
{
  ok(typeof coreQuota.recentRateLimited === 'function', 'core/quota.mjs 导出 recentRateLimited');
  ok(wire.recentQuotaExhausted === coreQuota.recentRateLimited,
    '★ wire.recentQuotaExhausted 与 core.recentRateLimited 是**同一个函数**（引用级）');

  const dir = newDir('ledger');
  const ledger = writeRateLimitedLedger(dir);
  const ex = wire.recentQuotaExhausted(ledger, Date.now());
  ok(ex && typeof ex === 'object' && ex['bigmodel-coding-plan']?.retryAfterSec === 600,
    '判据逐条保留：provider 归一（去 plan: 前缀）+ retryAfterSec 透传', `（${JSON.stringify(ex)}）`);
  ok(wire.matchQuotaExhausted({ id: 'plan', aliasOf: 'builtin:bigmodel-coding-plan' }, ex) !== null, '别名仍能命中（matchQuotaExhausted 未变）');
  ok(Object.keys(wire.recentQuotaExhausted(join(dir, 'nope.jsonl'), Date.now())).length === 0, '台账不存在 → 空对象（不抛）');
  const old = writeFileSync(join(dir, 'old.jsonl'), `${JSON.stringify({ at: new Date(Date.now() - 6 * 3600 * 1000).toISOString(), provider: 'plan:x', rateLimited: true })}\n`);
  ok(Object.keys(wire.recentQuotaExhausted(join(dir, 'old.jsonl'), Date.now())).length === 0, '窗口外条目不计入（5 小时）');
}

/* ───────────────────────── ⑤ [F8] validateSpec 单次 ───────────────────────── */

console.log('\n⑤ [F8] validateSpec 只调一次（且在引擎规整之前）');
{
  const { createDispatcher } = coreMod;
  const root = newDir('validate');
  const d = createDispatcher({ runnerPath: join(HERE, 'fixtures', 'fake-runner.mjs'), workRoot: root });

  let err1 = null;
  try { d.dispatch({ kind: 'prompt', prompt: 'x', engine: 'bogus' }); } catch (e) { err1 = e; }
  ok(err1 instanceof TypeError && /engine 必须是/.test(err1.message), '非法 engine 仍抛可读 TypeError（行为不变）', `（${err1?.message ?? '未抛'}）`);
  ok(d.list().length === 0, '非法 spec 不建 job（校验先于建 job）');

  let err2 = null;
  d.setChannel({ provider: 'opencode/deepseek-v4.1-flash-free' });
  try { d.dispatch({ kind: 'prompt', prompt: 'x', mode: 'edit' }); } catch (e) { err2 = e; }
  ok(err2 instanceof TypeError && /不支持 mode/.test(err2.message),
    '★ 通道默认通道为 opencode 时 mode 仍被拒（证明单次校验发生在补默认值之后）', `（${err2?.message ?? '未抛'}）`);
  ok(d.list().length === 0, '该拒绝同样不建 job');

  let err3 = null;
  try { d.dispatch({ kind: 'nope', prompt: 'x' }); } catch (e) { err3 = e; }
  ok(err3 instanceof TypeError && /spec\.kind/.test(err3.message), '非法 kind 仍抛可读 TypeError');

  // 调用点计数（源码锁）：定义 1 处 + 调用 1 处；且调用必须出现在 effEngineSpec 之前
  const callSites = [...CORE_SRC.matchAll(/^\s*validateSpec\(/gm)].length;
  ok(callSites === 1, '★ core 里 validateSpec 调用点只剩 1 处（改前为 2）', `（实际 ${callSites}）`);
  const dispatchRawBody = CORE_SRC.slice(CORE_SRC.indexOf('function dispatchRaw(spec'), CORE_SRC.indexOf('function dispatch(spec)'));
  const iValidate = dispatchRawBody.indexOf('validateSpec(spec)');
  const iNormalize = dispatchRawBody.indexOf('effEngineSpec(spec)');
  ok(iValidate >= 0 && iNormalize > iValidate, '★ dispatchRaw 先 validateSpec(spec) 再 effEngineSpec(spec)（校验看得见原始 engine）');
}

console.log(`\n===== host-decouple（解耦执行轮验收）：${pass} PASS / ${fails.length} FAIL =====`);
if (fails.length) {
  console.log('未通过：');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
}
assert.ok(true); // 保持 import 的 assert 被使用（软断言框架）
