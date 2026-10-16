/**
 * ZB-44（双引擎）：**引擎路由 / 行协议 / 每引擎并发上限 / 通道清单降级** 的集成断言。
 *
 * 纪律（与验收要求一致）：全部用注入（`channelsProbeImpl` / `spawnImpl` / 自建临时假执行器脚本）——
 * **不触网、不 spawn 真的 opencode、不读写用户自己的 OpenCode 目录**
 * （`~\.config\opencode\`、`~\.local\share\opencode\`）。
 *
 * 覆盖：
 *   ④ `dispatch({provider:'opencode/<model>'})` ⇒ spec 规整为 {engine, provider:'opencode', model:'opencode/<model>'}
 *   ⑤ 引擎路由：zcode job spawn zcode runner、opencode job spawn OpenCode 执行器（断言 spawnImpl 收到的 argv）
 *   ⑥ `[opencode-run]` 前缀行（done / usage / progress / variants / variant）都能被 core 解析
 *   ⑦ 每引擎并发上限：3 个 opencode 排队 + maxConcurrentOpenCode=2 ⇒ 同时 running ≤2；
 *      穿插的 zcode 任务**不被** OpenCode 满员阻塞（本轮最关键的回归断言）
 *   ⑧ `validateSpec` 拒绝 opencode + mode / 非法 engine 值（可读报错，不静默）
 *   ⑨ 通道清单：OpenCode 探测失败 ⇒ zcode 通道照常返回 + warnings 可读；
 *      探测成功 ⇒ opencode 通道（id=模型 id）+ 顶层 engines + 通道→引擎快照落盘（内容不变不重写）
 *   ⑩⑪ auto（显式放行）的 argv / 可审计位 / auto=on 告知行
 *   ⑫ retry 链路上的 auto / engine / cwd 语义
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatcher } from '../core/dispatch-core.mjs';

const tempDirs = [];
function newDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'failed', 'killed', 'interrupted'];

async function waitTerminal(d, id, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const j = d.get(id);
    if (j && (TERMINAL.includes(j.state) || j.state === 'paused')) return j;
    await sleep(10);
  }
  throw new Error(`waitTerminal(${id}) 超时（最后状态：${d.get(id)?.state}）`);
}
async function waitFor(pred, what, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`waitFor(${what}) 超时`);
}

/* ---------------- 夹具：临时假执行器（用 node 写盘 —— pitfalls #3：不让工具写 BOM） ---------------- */

const FIXDIR = newDir('dsp-eng-fix-');
/** 只被 spawnImpl 的假实现"当路径"用（不真执行）。 */
const ZCODE_RUNNER = join(FIXDIR, 'fake-zcode-runner.mjs');
/** 会**真执行**它（只读探测 + 打协议行）。 */
const OPENCODE_RUNNER = join(FIXDIR, 'fake-opencode-run.mjs');

writeFileSync(ZCODE_RUNNER, [
  "process.stdout.write('[zcode-run] tag=fake mode=edit cwd=.\\n');",
  "process.stdout.write('[zcode-run] done exit=0 elapsed=0.1s session=ses_fake_zcode responseChars=2\\n');",
  '',
].join('\n'));

/* 假 OpenCode 执行器：探测子命令 + 任务执行都走这一个脚本（与真实执行器的接口一致：
 * `--list-models` 只吐裸模型 id；`--version` 吐版本；执行时打 `[opencode-run] …` 协议行）。 */
writeFileSync(OPENCODE_RUNNER, [
  "const argv = process.argv.slice(2);",
  "if (argv.includes('--version')) { process.stdout.write('9.9.9-test\\n'); process.exit(0); }",
  "if (argv.includes('--list-models') || argv.includes('--list-providers')) {",
  "  process.stdout.write('opencode/deepseek-v4.1-flash-free\\n');",
  "  process.stdout.write('opencode/glm-5.3-flash-free\\n');",
  "  process.stdout.write('[opencode-run] variants opencode/glm-5.3-flash-free=low,high,max\\n'); // 探测里混入协议行：core 不得当模型 id",
  "  process.exit(0);",
  "}",
  "process.stdout.write('[opencode-run] tag=oc-test mode=auto cwd=.\\n');",
  // 真机上执行器打的告知行（ZB-45）；这里逐字复用，用来验证 core 把它识别为"已知信息行"
  "if (argv.includes('--auto')) process.stdout.write('[opencode-run] auto=on（已放行所有未显式拒绝的权限；请确保工作目录可信）\\n');",
  "process.stdout.write('[opencode-run] variants opencode/deepseek-v4.1-flash-free=low,high,max\\n');",
  "process.stdout.write('[opencode-run] variant=high model=opencode/deepseek-v4.1-flash-free\\n');",
  "process.stdout.write('[opencode-run] progress stage=run elapsed=1s chars=12 tools=0 stageAgo=0s session=ses_fake_oc\\n');",
  "process.stdout.write('[opencode-run] usage requests=1 in=10 out=5 cacheRead=0\\n');",
  "process.stdout.write('[opencode-run] done exit=0 elapsed=1.0s session=ses_fake_oc model=opencode/deepseek-v4.1-flash-free responseChars=4\\n');",
  '',
].join('\n'));

/* ---------------- 夹具：假 spawnImpl（记录 argv；可"按住不放"，用于测并发上限） ---------------- */

function makeSpawn({ hold = false } = {}) {
  const spawned = [];
  const settle = (entry, code = 0) => {
    if (!entry || entry.settled) return;
    entry.settled = true;
    const pfx = entry.script === OPENCODE_RUNNER ? '[opencode-run]' : '[zcode-run]';
    entry.child.stdout.push(`${pfx} done exit=${code} elapsed=0.1s session=sess_${entry.index} responseChars=2\n`);
    entry.child.stdout.push(null);
    entry.child.stderr.push(null);
    entry.child.emit('close', code, null);
  };
  const impl = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.kill = () => {};
    const entry = { script: String(args[0]), args: args.slice(1), child, settled: false, index: spawned.length };
    spawned.push(entry);
    if (!hold) setImmediate(() => settle(entry));
    return child;
  };
  return { impl, spawned, settle };
}

/** 造一个"只认 zcode 探测"的 dispatcher 配置（opencode 路径按参数给）。 */
function mkDisp(workRoot, opts = {}) {
  const { impl, ...rest } = opts;
  return createDispatcher({
    runnerPath: ZCODE_RUNNER,
    workRoot,
    maxConcurrent: 4,
    ...(impl ? { spawnImpl: impl } : {}),
    ...rest,
  });
}

/** zcode 侧 `--list-providers` 的固定样例（含一行 provider 表格）。 */
const zcodeProbeSample = async () => [
  'id'.padEnd(34) + 'enabled   端点/模型',
  'builtin:bigmodel-coding-plan'.padEnd(34) + 'true      https://x | GLM-5.3',
].join('\n');

/** 把 config/cache/personal 都指向不存在的文件（保持 warnings 干净、只留被测的那条）。 */
const cleanPaths = (dir) => ({
  zcodeConfigPath: join(dir, 'no-config.json'),
  planCachePath: join(dir, 'no-cache.json'),
  personalProviderPath: join(dir, 'no-personal.json'),
});

/* ================================ ④ spec 规整 ================================ */

test('④ dispatch：provider="opencode/<model>" ⇒ spec 规整为三元组；显式 model 优先；其余仍 zcode', async () => {
  const { impl } = makeSpawn();
  const d = mkDisp(newDir('dsp-eng-'), { impl, opencodeRunnerPath: OPENCODE_RUNNER });

  const j = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', tag: 'oc1', provider: 'opencode/deepseek-v4.1-flash-free' });
  const spec = d.get(j.id).spec;
  assert.equal(spec.engine, 'opencode', 'provider 形态即判据 ⇒ engine=opencode');
  assert.equal(spec.provider, 'opencode', 'provider 规整为引擎名（不再带 /model）');
  assert.equal(spec.model, 'opencode/deepseek-v4.1-flash-free', '模型取自通道 id');
  assert.equal(d.get(j.id).engine, 'opencode', 'job 上落 engine 字段（面板/工具可见）');

  const j2 = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', tag: 'oc2', provider: 'opencode/a', model: 'opencode/b' });
  assert.equal(d.get(j2.id).spec.model, 'opencode/b', '★ 显式 model 优先于通道 id');

  /* 既有行为零改动：不传 engine / 不传 provider（默认通道 plan）⇒ zcode */
  const j3 = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', tag: 'z1' });
  assert.equal(d.get(j3.id).spec.engine, 'zcode', '默认引擎 = zcode');
  assert.equal(d.get(j3.id).engine, 'zcode');
  const j4 = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', tag: 'z2', provider: 'plan' });
  assert.equal(d.get(j4.id).spec.engine, 'zcode', 'provider=plan ⇒ zcode');

  for (const x of [j, j2, j3, j4]) {
    const done = await waitTerminal(d, x.id);
    assert.ok(TERMINAL.includes(done.state), `${x.id} 应到终态（实际 ${done.state}）`);
  }
});

/* ================================ ⑤ 引擎路由 ================================ */

test('⑤ 引擎路由：zcode job spawn zcode runner、opencode job spawn OpenCode 执行器（argv 各归各）', async () => {
  const { impl, spawned } = makeSpawn();
  const d = mkDisp(newDir('dsp-eng-route-'), { impl, opencodeRunnerPath: OPENCODE_RUNNER });

  const jz = d.dispatch({ kind: 'prompt', prompt: 'z', lock: 'none', tag: 'z' });
  const jo = d.dispatch({
    kind: 'prompt', prompt: 'o', lock: 'none', tag: 'o',
    provider: 'opencode/deepseek-v4.1-flash-free', reasoningLevel: 'high',
  });
  /* 思考强度 = 'agent'（Agent决定）⇒ **不覆盖**，不给 OpenCode 传 --variant */
  const joAgent = d.dispatch({
    kind: 'prompt', prompt: 'o2', lock: 'none', tag: 'o2',
    provider: 'opencode/glm-5.3-flash-free', reasoningLevel: 'agent',
  });
  await Promise.all([waitTerminal(d, jz.id), waitTerminal(d, jo.id), waitTerminal(d, joAgent.id)]);

  const zEntry = spawned.find((e) => e.script === ZCODE_RUNNER);
  const oEntries = spawned.filter((e) => e.script === OPENCODE_RUNNER);
  assert.ok(zEntry, '★ zcode job 必须 spawn zcode runner');
  assert.equal(oEntries.length, 2, '★ opencode job 必须 spawn OpenCode 执行器（不碰 zcode runner）');

  /* zcode 侧 argv 逐字不变：--prompt / --provider / --reasoning-level …（既有形态） */
  assert.equal(zEntry.args[0], '--prompt');
  assert.ok(zEntry.args.includes('--provider') && zEntry.args.includes('plan'), 'zcode 仍带 --provider plan');
  assert.ok(zEntry.args.includes('--reasoning-level'), 'zcode 仍带 --reasoning-level');

  /* OpenCode 侧 argv：只有 OpenCode 认识的参数；ZCode 专属与危险开关一律不得出现 */
  const oArgs = oEntries[0].args;
  assert.equal(oArgs[0], '--prompt', 'OpenCode 用 --prompt 传正文');
  const mi = oArgs.indexOf('--model');
  assert.ok(mi >= 0 && oArgs[mi + 1] === 'opencode/deepseek-v4.1-flash-free', 'OpenCode 收到模型 id');
  const vi = oArgs.indexOf('--variant');
  assert.ok(vi >= 0 && oArgs[vi + 1] === 'high', '具体档位 ⇒ --variant high');
  assert.ok(!oArgs.includes('--provider'), 'OpenCode 不接受 ZCode 的 --provider');
  assert.ok(!oArgs.includes('--mode'), 'OpenCode 不接受 ZCode 的 --mode');
  assert.ok(!oArgs.includes('--memory-bench'), 'OpenCode 不接受 --memory-bench');
  assert.ok(!oArgs.includes('--auto'), '★ 默认绝不加 --auto（硬约束）');
  assert.ok(!oEntries[1].args.includes('--variant'), "'agent' = Agent决定 ⇒ 不覆盖档位（不传 --variant）");
});

/* ================================ ⑥ 行协议（[opencode-run]） ================================ */

test('⑥ [opencode-run] 前缀行（done/usage/progress/variants/variant）全部被解析；落 job 字段无 warning', async () => {
  const d = mkDisp(newDir('dsp-eng-line-'), { opencodeRunnerPath: OPENCODE_RUNNER });
  const j = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', tag: 'line', provider: 'opencode/deepseek-v4.1-flash-free' });
  const done = await waitTerminal(d, j.id);

  assert.equal(done.state, 'done', `假 OpenCode 执行器应让它 done（实际 ${done.state}；warnings=${JSON.stringify(done.parseWarnings)}）`);
  assert.equal(done.engine, 'opencode', 'job.engine 落库');
  /* done 行 */
  assert.equal(done.summarySeen, true);
  assert.equal(done.sessionId, 'ses_fake_oc');
  assert.equal(done.model, 'opencode/deepseek-v4.1-flash-free');
  assert.equal(done.responseChars, 4);
  /* usage 行 */
  assert.equal(done.usage.requests, 1);
  assert.equal(done.usage.inputTokens, 10);
  assert.equal(done.usage.outputTokens, 5);
  assert.equal(done.usage.cacheReadTokens, 0);
  /* progress 行 */
  assert.equal(done.progress.stage, 'run');
  assert.equal(done.progress.sessionId, 'ses_fake_oc');
  /* variant 行 ⇒ 复用既有的 reasoningLevelApplied / reasoningTarget（target 用 model 填） */
  assert.equal(done.reasoningLevelApplied, 'high');
  assert.equal(done.reasoningTarget, 'opencode/deepseek-v4.1-flash-free', 'OpenCode 无 provider 注入 ⇒ target=modelId');
  /* variants 行是"探测/声明行"：识别但不入库、不落 warning；OpenCode 也没有台账回读噪声 */
  assert.deepEqual(done.parseWarnings, [], `不该有任何 warning（实际 ${JSON.stringify(done.parseWarnings)}）`);
  assert.equal(done.ledgerMatched, false);
});

/* ================================ ⑦ 每引擎并发上限 ================================ */

test('⑦ 每引擎并发：3 个 opencode + maxConcurrentOpenCode=2 ⇒ 同时 ≤2；穿插 zcode 不被满员阻塞', async () => {
  const { impl, spawned, settle } = makeSpawn({ hold: true });
  const d = mkDisp(newDir('dsp-eng-conc-'), { impl, opencodeRunnerPath: OPENCODE_RUNNER, maxConcurrent: 4, maxConcurrentOpenCode: 2 });

  let maxOcRunning = 0;
  const un = d.subscribe(() => {
    maxOcRunning = Math.max(maxOcRunning, d.snapshot().runningByEngine.opencode);
  });

  const oc = [1, 2, 3].map((i) => d.dispatch({ kind: 'prompt', prompt: `oc${i}`, lock: 'none', tag: `oc${i}`, provider: `opencode/m${i}` }));
  await waitFor(
    () => d.get(oc[0].id).state === 'running' && d.get(oc[1].id).state === 'running' && d.get(oc[2].id).state === 'queued',
    '前两个 opencode running、第三个按上限排队',
  );
  assert.equal(d.snapshot().runningByEngine.opencode, 2, 'OpenCode 同时在跑 = 上限 2');
  assert.equal(d.snapshot().maxConcurrentOpenCode, 2, 'snapshot 暴露每引擎上限');

  /* ★ 本轮最关键：OpenCode 名额占满，也不能把后面可运行的 zcode 任务堵死（旧实现 break ⇒ 会堵）。 */
  const z = d.dispatch({ kind: 'prompt', prompt: 'z', lock: 'none', tag: 'z-interleave' });
  await waitFor(() => d.get(z.id).state === 'running', '★ OpenCode 满员不得阻塞 zcode 任务（队头阻塞回归）');
  assert.equal(d.get(oc[2].id).state, 'queued', '第三个 OpenCode 仍在等名额');
  assert.equal(d.snapshot().runningByEngine.opencode, 2, 'zcode 启动后 OpenCode 仍只有 2 个');

  /* 腾出一个 OpenCode 名额 ⇒ 第三个才启动；同时运行的 OpenCode 恒 ≤2 */
  settle(spawned.find((e) => e.script === OPENCODE_RUNNER && !e.settled));
  await waitFor(() => d.get(oc[2].id).state === 'running', '腾出名额后第三个 opencode 启动');
  assert.ok(d.snapshot().runningByEngine.opencode <= 2, '同时运行的 OpenCode 不得超过 2');

  for (const e of spawned) settle(e); // 释放全部（含 zcode 的"按住"进程）
  const finals = await Promise.all([...oc.map((x) => waitTerminal(d, x.id)), waitTerminal(d, z.id)]);
  for (const f of finals) assert.equal(f.state, 'done', `${f.id} 应 done（实际 ${f.state}）`);
  un();
  assert.equal(maxOcRunning, 2, `★ 全程 OpenCode 并发峰值必须是 2（实际 ${maxOcRunning}）`);
  assert.equal(d.snapshot().runningByEngine.opencode, 0, '全部落地后无运行中的 OpenCode');
});

/* ================================ ⑧ validateSpec ================================ */

test('⑧ validateSpec：opencode + mode ⇒ 抛；非法 engine 值 ⇒ 抛（列合法值）；zcode 既有校验不变', () => {
  const { impl } = makeSpawn();
  const d = mkDisp(newDir('dsp-eng-val-'), { impl, opencodeRunnerPath: OPENCODE_RUNNER });

  assert.throws(
    () => d.dispatch({ kind: 'prompt', prompt: 'x', provider: 'opencode/deepseek-v4.1-flash-free', mode: 'edit' }),
    /engine=opencode 不支持 mode/,
    'OpenCode 没有 --mode ⇒ 必须可读报错，不静默丢弃',
  );
  assert.throws(
    () => d.dispatch({ kind: 'prompt', prompt: 'x', provider: 'opencode/x', memoryBench: true }),
    /memoryBench 仅支持 ZCode/,
    'memoryBench 是 ZCode 专属',
  );
  assert.throws(
    () => d.dispatch({ kind: 'prompt', prompt: 'x', engine: 'opencde' }),
    /spec\.engine 必须是 zcode\|opencode/,
    '拼错的引擎名必须报错并列出合法值',
  );
  /* zcode 侧既有校验逐字不变（抽两条最典型的：lock 枚举、memoryBench 仅 prompt） */
  assert.throws(() => d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'both' }), /spec\.lock 必须是 repo\|none/);
  assert.throws(() => d.dispatch({ kind: 'target', target: 'x', memoryBench: true }), /memoryBench 仅支持 kind=prompt/);
});

/* ================================ ⑨ 通道清单 + 引擎快照 ================================ */

test('⑨ 通道清单：OpenCode 探测失败 ⇒ zcode 照常 + warnings 可读；探测成功 ⇒ opencode 通道 + engines + 快照落盘', async () => {
  /* 9a）执行器不存在：OpenCode 通道为空，但 zcode 通道照常返回（整体绝不失败） */
  const workA = newDir('dsp-eng-ch-');
  const dA = mkDisp(workA, {
    channelsProbeImpl: zcodeProbeSample,
    opencodeRunnerPath: join(workA, 'no-such-opencode-run.mjs'),
    ...cleanPaths(workA),
  });
  const a = await dA.listChannels();
  const aIds = a.channels.map((c) => c.id);
  assert.deepEqual(a.engines, ['zcode', 'opencode', 'qoder'], '顶层 engines 恒定给出（供客户端分组）');
  /* ZB-51：ZCode 通道走**白名单**（用户决定只留 plan 与免费额度）⇒ 其余一律剔除。
   * ⚠️ 不硬性要求"恰好两条"：本 fixture 的精简探测样例里没有免费额度行，
   * 故实际只有 plan。用**不变式**断言（所有 zcode 通道都在白名单内）比数数更稳。 */
  const zcodeIds = aIds.filter((id) => !id.startsWith('opencode/') && !id.startsWith('qoder/'));
  assert.ok(zcodeIds.every((id) => ['plan', 'account:bigmodel-start-plan'].includes(id)),
    `★ ZCode 通道恒在白名单内（实际 ${JSON.stringify(zcodeIds)}）`);
  assert.ok(aIds.includes('plan'), 'plan 别名仍在');
  assert.equal(aIds.includes('personal'), false, '★ 白名单外的 personal 已剔除');
  assert.equal(aIds.includes('builtin:bigmodel-coding-plan'), false, '★ 白名单外的 builtin:* 已剔除');
  assert.ok((a.warnings ?? []).some((w) => /白名单/.test(w)), '剔除行为在 warnings 里留痕');
  assert.ok(a.channels.every((c) => c.engine === 'zcode'), '★ 探测失败 ⇒ 一个 opencode 通道都不给');
  assert.ok(
    a.warnings.some((w) => /OpenCode 执行器不存在/.test(w) && /ZCode 通道不受影响/.test(w)),
    `warnings 必须可读（实际 ${JSON.stringify(a.warnings)}）`,
  );
  assert.equal(a.opencodeVersion, null, '探测未跑 ⇒ 版本为 null（不猜）');

  /* 9b）真实探测（跑自建临时脚本，不碰真 opencode）：opencode 通道 + 版本 + 快照 */
  const workB = newDir('dsp-eng-ch2-');
  const dB = mkDisp(workB, { channelsProbeImpl: zcodeProbeSample, opencodeRunnerPath: OPENCODE_RUNNER, ...cleanPaths(workB) });
  const b = await dB.listChannels();
  const ocChannels = b.channels.filter((c) => c.engine === 'opencode');
  assert.deepEqual(
    ocChannels.map((c) => c.id),
    ['opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free'],
    '★ 模型 id 原样作通道 id；探测输出里混入的 `[opencode-run] variants …` 行不得被当成模型',
  );
  assert.equal(ocChannels[0].name, 'deepseek-v4.1-flash-free', 'name = 短名（去掉 opencode/ 前缀）');
  assert.equal(ocChannels[0].enabled, true);
  assert.equal(ocChannels[0].reason, null);
  assert.equal(ocChannels[0].endpoint, null);
  assert.deepEqual(ocChannels[0].models, ['opencode/deepseek-v4.1-flash-free']);
  /* ★ 顺序契约：**先 zcode 全部，再 opencode 全部**（引擎分组的前提）。
   * ZB-51：白名单后 zcode 只剩少数几条，故不能再用 `slice(0,3)` 硬编码数量 ——
   * 改为"按条数动态切"：前 zcLength 条必须全是 zcode，其后的第一条必须是 opencode。 */
  const zcLength = b.channels.filter((c) => c.engine === 'zcode').length;
  assert.ok(zcLength >= 1, `清单里有 zcode 通道（实际 ${zcLength}）`);
  assert.deepEqual(b.channels.slice(0, zcLength).map((c) => c.engine), Array(zcLength).fill('zcode'),
    '★ 顺序：zcode 全部在前（白名单内的那几条）');
  assert.equal(b.channels[zcLength]?.engine, 'opencode', '★ 紧接着就是 opencode 全部');
  assert.equal(b.opencodeVersion, '9.9.9-test', '--version 探测的版本落 opencodeVersion');

  /* 9c）通道→引擎快照：落盘形状 + 内容无变化不重写（startJob 同步读它，故必须持久化） */
  const snapFile = join(workB, 'state', 'channels.json');
  const raw1 = readFileSync(snapFile, 'utf8');
  const mtime1 = statSync(snapFile).mtimeMs;
  const snap1 = JSON.parse(raw1);
  assert.equal(snap1.version, 1);
  assert.equal(snap1.engineById['opencode/deepseek-v4.1-flash-free'], 'opencode');
  assert.equal(snap1.engineById['opencode/glm-5.3-flash-free'], 'opencode');
  assert.equal(snap1.engineById.plan, 'zcode');
  /* ZB-51：白名单外的 personal 已剔除 ⇒ 快照里也不该有它（快照来自同一份清单）。 */
  assert.equal(snap1.engineById.personal, undefined, '★ 快照里也没有白名单外的 personal');
  assert.deepEqual(snap1.engines, ['zcode', 'opencode', 'qoder']);
  assert.ok(Number.isFinite(snap1.updatedAt), 'updatedAt 是 ms 数值');
  await sleep(30);
  await dB.listChannels();
  assert.equal(readFileSync(snapFile, 'utf8'), raw1, '内容无变化 ⇒ 不重写（updatedAt 不变）');
  assert.equal(statSync(snapFile).mtimeMs, mtime1, 'mtime 未变 ⇒ 确实没重写');

  /* 9d）快照损坏 ⇒ fail-open（按 zcode），不抛 */
  writeFileSync(snapFile, '{ 这不是 JSON');
  const { impl } = makeSpawn();
  const dD = mkDisp(workB, { impl, opencodeRunnerPath: OPENCODE_RUNNER });
  const j = dD.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', tag: 'failopen', provider: 'some-unknown-channel' });
  assert.equal(dD.get(j.id).spec.engine, 'zcode', '★ 快照不可读 ⇒ fail-open 到默认引擎（既有行为不变）');
  await waitTerminal(dD, j.id);
});

/* ================================ ⑩⑪ ZB-45：显式放行 auto ================================ */

/** 找某次 spawn 的 argv（按 `--tag <tag>` 定位，避免与 prompt 正文里的同名字符串混淆）。 */
function argvOfTag(spawned, tag) {
  const hit = spawned.find((e) => {
    const i = e.args.indexOf('--tag');
    return i >= 0 && e.args[i + 1] === tag;
  });
  assert.ok(hit, `应能找到 tag=${tag} 的那次 spawn（实际 tag 列表：${JSON.stringify(spawned.map((e) => {
    const i = e.args.indexOf('--tag');
    return i >= 0 ? e.args[i + 1] : '(无)';
  }))}）`);
  return hit.args;
}

test('⑩ ZB-45 auto：默认 argv 不带 --auto；auto:true ⇒ 带 --auto 且 job.autoApproved 可审计；auto+zcode ⇒ 可读报错', async () => {
  const { impl, spawned } = makeSpawn();
  const d = mkDisp(newDir('dsp-eng-auto-'), { impl, opencodeRunnerPath: OPENCODE_RUNNER });

  /* (a) 默认（不传 auto）⇒ **绝不带** --auto（硬约束「不默认开 --auto」） */
  const j1 = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', tag: 'noauto', provider: 'opencode/deepseek-v4.1-flash-free' });
  await waitTerminal(d, j1.id);
  assert.ok(!argvOfTag(spawned, 'noauto').includes('--auto'), '★ 默认绝不带 --auto');
  assert.equal(d.get(j1.id).autoApproved, false, '未放行 ⇒ job.autoApproved=false（可审计）');
  assert.equal(d.get(j1.id).spec.auto, undefined, '未指定 ⇒ spec 里没有 auto');

  /* (b) auto:true ⇒ argv 带 --auto，且 job 上有可审计痕迹 */
  const j2 = d.dispatch({
    kind: 'prompt', prompt: 'x', lock: 'none', tag: 'withauto', auto: true,
    provider: 'opencode/deepseek-v4.1-flash-free',
  });
  await waitTerminal(d, j2.id);
  assert.ok(argvOfTag(spawned, 'withauto').includes('--auto'), '★ 显式放行 ⇒ 执行器收到 --auto');
  assert.equal(d.get(j2.id).autoApproved, true, '★ job.autoApproved 可审计（面板/CLI 能看出这次放行了权限）');
  assert.equal(d.get(j2.id).spec.auto, true, 'spec.auto 落库');
  /* auto:false 也有效（显式关闭 ≠ 未指定），同样不带 --auto */
  const j3 = d.dispatch({
    kind: 'prompt', prompt: 'x', lock: 'none', tag: 'autofalse', auto: false,
    provider: 'opencode/deepseek-v4.1-flash-free',
  });
  await waitTerminal(d, j3.id);
  assert.ok(!argvOfTag(spawned, 'autofalse').includes('--auto'), 'auto:false ⇒ 不带 --auto');
  assert.equal(d.get(j3.id).autoApproved, false);

  /* (c) auto:true + 不支持 auto 的引擎（zcode）⇒ 可读 TypeError（不静默失效） */
  assert.throws(
    () => d.dispatch({ kind: 'prompt', prompt: 'x', auto: true }),
    /auto 仅对 engine=opencode \/ engine=qoder 有意义/,
    '★ zcode（默认引擎）不接受 auto:true',
  );
  assert.throws(
    () => d.dispatch({ kind: 'prompt', prompt: 'x', provider: 'plan', auto: true }),
    /auto 仅对 engine=opencode \/ engine=qoder 有意义/,
    '显式 provider=plan 同理',
  );
  /* 非布尔值也拒（否则 auto:"true" 会被静默当成不放行） */
  assert.throws(
    () => d.dispatch({ kind: 'prompt', prompt: 'x', provider: 'opencode/x', auto: 'true' }),
    /spec\.auto 必须是布尔/,
  );
});

test('⑪ ZB-45 auto=on 告知行：被执行器打出时置 job.autoApproved，且不落"无人识别"warning', async () => {
  const d = mkDisp(newDir('dsp-eng-auto2-'), { opencodeRunnerPath: OPENCODE_RUNNER }); // 真跑临时假执行器
  const j = d.dispatch({
    kind: 'prompt', prompt: 'x', lock: 'none', tag: 'auto-on', auto: true,
    provider: 'opencode/deepseek-v4.1-flash-free',
  });
  const done = await waitTerminal(d, j.id);
  assert.equal(done.state, 'done', `应 done（实际 ${done.state}；warnings=${JSON.stringify(done.parseWarnings)}）`);
  assert.equal(done.autoApproved, true, '执行器打了 auto=on ⇒ 确认为真');
  assert.deepEqual(done.parseWarnings, [], '`auto=on` 是已知信息行（不得被记成"无人识别的行"）');
});

/* ================================ ⑫ ZB-45：retry 链路上的 auto / engine / cwd ================================ */

test('⑫ ZB-45 retry：auto 跨 retry 沿用（可被 opts.auto 覆盖）；opts.engine 生效且换引擎绝不 resume；resume 保持同一 cwd', async () => {
  const { impl, spawned } = makeSpawn();
  const CWD = newDir('dsp-eng-cwd-');
  const work = newDir('dsp-eng-retry-');
  const d = mkDisp(work, { impl, opencodeRunnerPath: OPENCODE_RUNNER });

  /* 一个"显式放行 + 指定 cwd"的 OpenCode 作业（假执行器让它 done 并留下 sessionId） */
  const j = d.dispatch({
    kind: 'prompt', prompt: 'x', lock: 'none', tag: 'r1', auto: true, cwd: CWD,
    provider: 'opencode/deepseek-v4.1-flash-free',
  });
  const jDone = await waitTerminal(d, j.id);
  assert.equal(jDone.state, 'done');
  assert.ok(jDone.sessionId, '假执行器回了 sessionId（后面 resume 要用）');
  assert.ok(argvOfTag(spawned, 'r1').includes('--cwd'), '原任务带 --cwd');

  /* (1) 同通道 resume：auto 沿用 + cwd 逐字相同 + 绝不带 --model（F2 家族纪律） */
  const r1 = d.retry(j.id);
  assert.equal(r1.spec.engine, 'opencode');
  assert.equal(r1.spec.resume, jDone.sessionId, '同通道有 sessionId ⇒ resume');
  assert.equal(r1.spec.auto, true, '★ auto 跨 retry 沿用（否则"放行"会在重试后静默失效）');
  assert.equal(r1.spec.cwd, CWD, '★ 续会话必须带**同一 cwd**（OpenCode 的 session 按工作目录作用域）');
  assert.equal(r1.parentJobId, j.id);
  await waitTerminal(d, r1.id);
  const r1Args = argvOfTag(spawned, r1.spec.tag);
  assert.equal(r1Args[r1Args.indexOf('--resume') + 1], jDone.sessionId, 'argv 里确实传了 --resume');
  assert.ok(!r1Args.includes('--model'), 'F2 家族纪律：--resume 绝不带 --model');
  assert.ok(r1Args.includes('--auto'), '★ resume 也保持放行级别');
  assert.equal(r1Args[r1Args.indexOf('--cwd') + 1], CWD, '★ argv 里 --cwd 与原任务逐字相同');

  /* (2) 显式 resume 入口（dispatch，不经 retry）也必须保住 cwd */
  const jr = d.dispatch({
    kind: 'prompt', prompt: 'continue', lock: 'none', tag: 'explicit-resume',
    provider: 'opencode/deepseek-v4.1-flash-free', resume: 'ses_previous', cwd: CWD,
  });
  const jrSpec = d.get(jr.id).spec;
  assert.equal(jrSpec.cwd, CWD, '★ 显式 resume 入口不得丢 cwd');
  assert.equal(jrSpec.resume, 'ses_previous');
  assert.equal(jrSpec.engine, 'opencode');
  await waitTerminal(d, jr.id);

  /* (3) 换通道（同引擎）交接：auto 沿用、不 resume */
  const j2 = d.dispatch({
    kind: 'prompt', prompt: 'x', lock: 'none', tag: 'r2', auto: true, cwd: CWD,
    provider: 'opencode/glm-5.3-flash-free',
  });
  await waitTerminal(d, j2.id);
  const h2 = d.retry(j2.id, { provider: 'opencode/deepseek-v4.1-flash-free' });
  assert.equal(h2.spec.engine, 'opencode', '换通道（同引擎）仍是 opencode');
  assert.equal(h2.spec.resume, undefined, '换通道 ⇒ 不 resume');
  assert.equal(h2.spec.auto, true, '换通道（同引擎）⇒ auto 沿用');
  await waitTerminal(d, h2.id);

  /* (4) 跨引擎交接：目标 provider 形态即判据 ⇒ engine=opencode 且绝不 resume */
  const jz = d.dispatch({ kind: 'prompt', prompt: 'z', lock: 'none', tag: 'z-src' });
  await waitTerminal(d, jz.id);
  const hz = d.retry(jz.id, { provider: 'opencode/deepseek-v4.1-flash-free' });
  assert.equal(hz.spec.engine, 'opencode', '★ 目标 provider=opencode/<model> ⇒ engine=opencode');
  assert.equal(hz.spec.provider, 'opencode');
  assert.equal(hz.spec.resume, undefined, '★ 换引擎 ⇒ 绝不 resume（跨引擎会话不通用）');
  assert.ok(!('auto' in hz.spec), '原任务是 zcode（无 auto）⇒ 交接目标不带 auto');
  await waitTerminal(d, hz.id);

  /* (5) opts.engine 显式跨引擎降级（opencode → zcode）：engine 听 opts.engine，且不 resume */
  const hz2 = d.retry(j.id, { engine: 'zcode', provider: 'plan' });
  assert.equal(hz2.spec.engine, 'zcode', 'opts.engine 显式优先');
  assert.equal(hz2.spec.resume, undefined, '换引擎 ⇒ 不走 resume');
  assert.ok(!('auto' in hz2.spec), 'auto 只对 opencode/qoder 有意义 ⇒ 交接给 zcode 时丢掉（否则整个 retry 会被 validateSpec 拒）');
  assert.ok(
    hz2.parseWarnings.some((w) => /显式放行（auto=true）/.test(w)),
    `放行级别被降级掉必须留痕（实际 ${JSON.stringify(hz2.parseWarnings)}）`,
  );
  await waitTerminal(d, hz2.id);

  /* (6) 显式同通道但 engine 变了 ⇒ 也绝不 resume（跨引擎 resume 必错） */
  const hz3 = d.retry(j.id, { engine: 'zcode' });
  assert.equal(hz3.spec.engine, 'zcode');
  assert.equal(hz3.spec.resume, undefined, '★ 显式改了引擎 ⇒ 即使同通道也不 resume');
  await waitTerminal(d, hz3.id);

  /* (7) `opts.auto` **显式覆盖**沿用值（两个方向都验） */
  const jNoAuto = d.dispatch({
    kind: 'prompt', prompt: 'x', lock: 'none', tag: 'noauto-src',
    provider: 'opencode/glm-5.3-flash-free',
  });
  await waitTerminal(d, jNoAuto.id);
  const hOn = d.retry(jNoAuto.id, { provider: 'opencode/deepseek-v4.1-flash-free', auto: true });
  assert.equal(hOn.spec.auto, true, '★ opts.auto=true 可**开启**放行（原任务未放行）');
  await waitTerminal(d, hOn.id);
  const hOff = d.retry(j.id, { auto: false }); // 原任务 auto:true（同通道 resume）
  assert.equal(hOff.spec.resume, jDone.sessionId, '仍是同通道 resume');
  assert.ok(!('auto' in hOff.spec), '★ opts.auto=false 可**关闭**放行（显式参数优先于沿用）');
  assert.equal(hOff.autoApproved, false);
  await waitTerminal(d, hOff.id);
});

/* ================================ 收尾 ================================ */

test('清理临时目录', () => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
  assert.ok(true);
});
