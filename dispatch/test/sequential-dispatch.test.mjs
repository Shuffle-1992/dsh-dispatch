/**
 * ZB-52 **顺序派发**（core 侧）+ **思考强度探测补齐** 的独立自测（零依赖，独立可跑）。
 * 运行：node dispatch/test/sequential-dispatch.test.mjs
 *
 * 被测源码：dispatch/core/dispatch-core.mjs（**本文件不修改任何源码**）。
 *
 * 覆盖三组：
 *   A. 状态与 API（getSequential / setSequential）：
 *      · 初始 {enabled:false, order:{zcode,opencode,qoder 三键恒在}, sequentialCount:0}
 *      · enabled / order 可只传其一（互不覆盖）
 *      · ★ order **按引擎合并**（回归：原实现整体替换会静默清空其它引擎）
 *      · 显式清空（[] / null）只清目标引擎
 *      · ★ 未知引擎键被丢弃（不得因 normalizeEngine 回退写进 zcode）
 *      · 去重且保持顺序；落盘 <workRoot>/state/sequential.json 形状
 *      · 重启后读回一致；文件损坏/形状不对 ⇒ fail-open 默认关且不抛
 *   B. 失败推进（advanceSequential，由 finalizeJob 触发）——用假执行器驱动，不跑真 CLI：
 *      · failed（静默非 0 退出）⇒ 按面板顺序 a→b→c 交接重跑，逐个前进
 *      · 列表用尽 ⇒ 留「已试完 N 个模型」warning、不再无限重试（spawn 次数封顶）
 *      · paused 不限暂停原因（quota / entitlement / signing）都延续
 *      · config-error **不**延续（停在 paused、不换模型）
 *      · 列表用尽 ⇒ 交回既有的跨通道降级链
 *   C. 思考强度探测补齐（用假执行器打印固定档位行，不跑 qoder/opencode 真 CLI）：
 *      · Qoder `reasoning-efforts` → 合进通道级 thinkingLevels
 *      · OpenCode `variants` → **逐模型** thinkingLevels（没报档位的模型不得被造出档位）
 *      · TTL 缓存 + 后台预热：首次 listChannels 档位可缺省（设计）、预热后出现、
 *        过期时立刻返回旧缓存并在后台重探
 *      · 两路探测确实被请求（假执行器落盘 marker）+ 超时值**源码级**断言
 *        （真机 --with-efforts 约 2 分钟，绝不在此端到端等）
 *
 * 纪律：只用 mkdtempSync 临时目录与 Node fs.writeFileSync 造假执行器（不用 PowerShell 写文件）；
 *       等待一律「轮询 + 总超时」，不用固定 sleep 当同步手段；连跑 3 次必须全绿。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { createDispatcher } from '../core/dispatch-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/* 隔离外部注入：runner 路径的环境变量优先级高于 options.runnerPath（见 createDispatcher 实现），
 * 若宿主环境残留 DSP_FAKE_RUNNER 会顶掉本文件显式传入的假执行器 ⇒ 测试结论失真。 */
const SAVED_ENV = {
  DSP_FAKE_RUNNER: process.env.DSP_FAKE_RUNNER,
  DSP_OPENCODE_RUNNER: process.env.DSP_OPENCODE_RUNNER,
  DSP_QODER_RUNNER: process.env.DSP_QODER_RUNNER,
};
delete process.env.DSP_FAKE_RUNNER;
delete process.env.DSP_OPENCODE_RUNNER;
delete process.env.DSP_QODER_RUNNER;

/* ---------------- 极简断言/计数框架（输出 PASS/FAIL 计数，退出码可靠） ---------------- */
let total = 0;
let pass = 0;
let fail = 0;
const failures = [];

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function ok(cond, msg) {
  total += 1;
  if (cond) {
    pass += 1;
    console.log(`ok ${total} - ${msg}`);
  } else {
    fail += 1;
    failures.push(msg);
    console.log(`not ok ${total} - ${msg}`);
  }
  return !!cond;
}

/** deepStrictEqual 断言。 */
function eq(actual, expected, msg) {
  const same = isDeepStrictEqual(actual, expected);
  return ok(same, same ? msg : `${msg}（实际=${safeJson(actual)} 期望=${safeJson(expected)}）`);
}

/** 一个可独立失败的分组：内部抛错只记 1 个失败，不打断后续分组。 */
async function scenario(name, fn) {
  console.log(`\n# ${name}`);
  try {
    await fn();
  } catch (e) {
    fail += 1;
    failures.push(`${name} 抛出异常: ${e?.stack ?? e}`);
    console.log(`not ok - ${name} 抛出异常: ${e?.message ?? e}`);
  }
}

/* ---------------- 临时目录 / 等待 / 假执行器工具 ---------------- */
const tempDirs = [];
function newTempDir(tag = 'dsp-seq-') {
  const dir = mkdtempSync(join(tmpdir(), tag));
  tempDirs.push(dir);
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待（pred 可为 async）：命中返回真值；总超时抛错。**不用固定 sleep 当同步手段**。 */
async function waitFor(pred, what, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try {
      v = await pred();
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() > end) throw new Error(`waitFor 超时（${timeoutMs}ms）：${what}`);
    await sleep(25);
  }
}

function writeScript(dir, fileName, src) {
  const p = join(dir, fileName);
  writeFileSync(p, src, 'utf8');
  return p;
}

function lineCount(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).length;
  } catch {
    return 0;
  }
}

function argOf(args, name) {
  const i = Array.isArray(args) ? args.indexOf(name) : -1;
  return i >= 0 ? args[i + 1] : null;
}

/** 记录 spawn 的 argv（同时透传给真实 spawn），用于断言「实际派发顺序 / 次数封顶」。 */
function captureSpawn() {
  const calls = [];
  return {
    calls,
    impl: (cmd, args, opts) => {
      calls.push(args);
      return nodeSpawn(cmd, args, opts);
    },
  };
}

/** A 组用：不派发任务的 dispatcher 只要求 runnerPath 非空（constructor 不 spawn）。 */
function makeDispatcher(workRoot = newTempDir()) {
  return createDispatcher({ runnerPath: process.execPath, workRoot });
}

const EMPTY_ORDER = () => ({ zcode: [], opencode: [], qoder: [] });
/* ZB-52（第二轮，用户要求「顺序思考强度档位设置」）：`getSequential()` 多了 `levels` ——
 * 与 `order` **同序**的逐模型档位数组（null = 该模型用引擎默认）；
 * 落盘 `sequential.json` 的 order 项也随之升级成 `{route, reasoningLevel}`（见对应断言）。 */
const EMPTY_LEVELS = () => ({ zcode: [], opencode: [], qoder: [] });
const DEFAULT_SEQ = () => ({ enabled: false, order: EMPTY_ORDER(), levels: EMPTY_LEVELS(), sequentialCount: 0 });

/* ---------------- 假执行器源码生成 ---------------- */

/**
 * OpenCode 假执行器：**静默失败**（零输出 + exit 1）
 * ⇒ core 归为 `failed`（不是 paused），用来驱动「顺序派发失败推进」。
 * 同时把每次调用收到的 --model 追加进 marker，供"实际顺序"断言。
 */
function makeSilentFailRunner(dir, markerPath) {
  const src = [
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    "const i = args.indexOf('--model');",
    "const model = i >= 0 ? args[i + 1] : '(none)';",
    `appendFileSync(${JSON.stringify(markerPath)}, model + '\\n');`,
    '/* 静默失败：不打印任何可解析行、也不带暂停签名 ⇒ failed */',
    'process.exit(1);',
    '',
  ].join('\n');
  return writeScript(dir, 'fake-oc-silent-fail.mjs', src);
}

/**
 * 暂停签名假执行器：打印一行固定文案 + exit 1 ⇒ core classifyPause 命中对应 pauseReason。
 * config-error / quota-exhausted / plan-not-entitled / provider-signing 都可用它驱动。
 */
function makePauseRunner(dir, fileName, text) {
  const src = [
    `console.log(${JSON.stringify(text)});`,
    'process.exit(1);',
    '',
  ].join('\n');
  return writeScript(dir, fileName, src);
}

/** Qoder 假执行器：`--list-models` / `--version` / `--list-models --with-efforts`（档位表）。 */
function makeQoderProbeRunner(dir, markerPath) {
  const src = [
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    'const has = (name) => args.includes(name);',
    "if (has('--list-models') && has('--with-efforts')) {",
    `  appendFileSync(${JSON.stringify(markerPath)}, 'probe --list-models --with-efforts\\n');`,
    "  console.log('[qoder-run] reasoning-efforts GLM-5.3=low,high,max');",
    "  console.log('[qoder-run] reasoning-efforts Qwen3.8-Max=low,medium,high');",
    '  process.exit(0);',
    '}',
    "if (has('--list-models')) {",
    "  console.log('GLM-5.3');",
    "  console.log('Qwen3.8-Max');",
    '  process.exit(0);',
    '}',
    "if (has('--version')) {",
    "  console.log('1.1.73');",
    '  process.exit(0);',
    '}',
    'process.exit(1);',
    '',
  ].join('\n');
  return writeScript(dir, 'fake-qoder-probe.mjs', src);
}

/**
 * OpenCode 假执行器：`--list-models` 返回 3 个模型；`--list-models --with-variants`
 * 只给其中 2 个报档位（**故意不给 opencode/model-c**，钉「没报档位的模型不得被造出档位」）。
 */
function makeOpenCodeProbeRunner(dir, markerPath) {
  const src = [
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    'const has = (name) => args.includes(name);',
    "if (has('--list-models') && has('--with-variants')) {",
    `  appendFileSync(${JSON.stringify(markerPath)}, 'probe --list-models --with-variants\\n');`,
    "  console.log('[opencode-run] variants opencode/model-a=low,high');",
    "  console.log('[opencode-run] variants opencode/model-b=minimal,max');",
    '  process.exit(0);',
    '}',
    "if (has('--list-models')) {",
    "  console.log('opencode/model-a');",
    "  console.log('opencode/model-b');",
    "  console.log('opencode/model-c');",
    '  process.exit(0);',
    '}',
    "if (has('--version')) {",
    "  console.log('1.19.2');",
    '  process.exit(0);',
    '}',
    'process.exit(1);',
    '',
  ].join('\n');
  return writeScript(dir, 'fake-opencode-probe.mjs', src);
}

/* ═══════════════════════════ A. 状态与 API ═══════════════════════════ */

async function scenarioA() {
  await scenario('A1 初始状态：三引擎键恒在 + 默认关 + sequentialCount=0', async () => {
    const d = makeDispatcher();
    const s = d.getSequential();
    eq(s.enabled, false, '初始 enabled=false');
    eq(s.order, EMPTY_ORDER(), '初始 order = 三个引擎的空数组（客户端据此渲染）');
    eq(Object.keys(s.order).sort(), ['opencode', 'qoder', 'zcode'], '*三个引擎键永远都在*');
    eq(s.sequentialCount, 0, '初始 sequentialCount=0');
  });

  await scenario('A2 patch 互不覆盖：enabled / order 可只传其一', async () => {
    const d = makeDispatcher();
    const s1 = d.setSequential({ enabled: true });
    eq(s1.enabled, true, '只传 enabled ⇒ 开关打开');
    eq(s1.order, EMPTY_ORDER(), '只传 enabled ⇒ order 不动（仍全空）');

    const s2 = d.setSequential({ order: { zcode: ['plan::GLM-5.3'] } });
    eq(s2.enabled, true, '只传 order ⇒ enabled 保持 true');
    eq(s2.order.zcode, ['plan::GLM-5.3'], '只传 order ⇒ 顺序生效');
    eq(s2.sequentialCount, 1, 'sequentialCount = 三个引擎条目总数');

    const d2 = makeDispatcher();
    const s3 = d2.setSequential({ order: { opencode: ['opencode/a'] } });
    eq(s3.enabled, false, '全新 dispatcher 只传 order ⇒ enabled 仍是默认 false（不得被顺手打开）');
  });

  await scenario('A3 ★ order 按引擎合并（回归：不得静默清空其它引擎）', async () => {
    const d = makeDispatcher();
    d.setSequential({ order: { zcode: ['plan::GLM-5.3'] } });
    const s1 = d.setSequential({ order: { opencode: ['opencode/a'] } });
    eq(s1.order.zcode, ['plan::GLM-5.3'], '*★ 再设 opencode 时 zcode 的顺序必须还在*（原实现整体替换会静默清空）');
    eq(s1.order.opencode, ['opencode/a'], '本次 patch 的 opencode 生效');
    eq(s1.order.qoder, [], '未涉及的引擎保持空');

    const s2 = d.setSequential({ order: { qoder: ['qoder/Fast'] } });
    eq(s2.order.zcode, ['plan::GLM-5.3'], '第三次 patch 后 zcode 仍在');
    eq(s2.order.opencode, ['opencode/a'], '第三次 patch 后 opencode 仍在');
    eq(s2.order.qoder, ['qoder/Fast'], '第三次 patch 的 qoder 生效');
    eq(s2.sequentialCount, 3, 'sequentialCount 累计三个引擎');
  });

  await scenario('A4 显式清空（[] / null）只清目标引擎，别人的不动', async () => {
    const d = makeDispatcher();
    d.setSequential({ order: { zcode: ['plan::GLM-5.3'], opencode: ['opencode/a'] } });
    const s1 = d.setSequential({ order: { zcode: [] } });
    eq(s1.order.zcode, [], '传空数组 ⇒ 该引擎被清空');
    eq(s1.order.opencode, ['opencode/a'], '清 zcode 不得动 opencode');
    d.setSequential({ order: { zcode: ['plan::GLM-5.3'] } });
    const s2 = d.setSequential({ order: { zcode: null } });
    eq(s2.order.zcode, [], '传 null 同样是显式清空');
    eq(s2.order.opencode, ['opencode/a'], '清 zcode（null）不得动 opencode');
  });

  await scenario('A5 ★ 未知引擎键被丢弃（绝不能回退写进 zcode）', async () => {
    const d = makeDispatcher();
    const s1 = d.setSequential({ order: { bogus: ['x'] } });
    eq(s1.order.zcode, [], '*★ 未知引擎键必须丢弃*：normalizeEngine("bogus") 会回退 zcode，但顺序配置不能因此写进 zcode');
    eq(s1.sequentialCount, 0, '未知引擎不产生任何条目');
    eq(Object.keys(s1.order).sort(), ['opencode', 'qoder', 'zcode'], 'order 仍只有三个已知引擎键');
    const s2 = d.setSequential({ order: { bogus2: ['y'], opencode: ['opencode/a'] } });
    eq(s2.order.opencode, ['opencode/a'], '同一 patch 里的合法引擎照常生效');
    eq(s2.order.zcode, [], '合法引擎生效时 zcode 仍为空（bogus2 没被写进去）');
  });

  await scenario('A6 去重且保持顺序（+ trim / 去空项）', async () => {
    const d = makeDispatcher();
    const s = d.setSequential({
      order: { opencode: ['opencode/b', 'opencode/a', 'opencode/b', ' opencode/c ', '', 'opencode/a'] },
    });
    eq(s.order.opencode, ['opencode/b', 'opencode/a', 'opencode/c'], '去重、去空、trim，且**保持首次出现顺序**（顺序=派发次序）');
  });

  await scenario('A7 落盘形状：<workRoot>/state/sequential.json = {version:1, mode, order, updatedAt}', async () => {
    const workRoot = newTempDir();
    const d = makeDispatcher(workRoot);
    d.setSequential({ enabled: true });
    d.setSequential({ order: { zcode: ['plan::GLM-5.3'], opencode: ['opencode/a'] } });
    const file = join(workRoot, 'state', 'sequential.json');
    ok(existsSync(file), '落盘文件 <workRoot>/state/sequential.json 存在');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    eq(raw.version, 1, 'version=1');
    eq(raw.mode, true, 'mode = 开关状态（true）');
    /* ZB-52：落盘项现为 `{route, reasoningLevel}`（档位可空）—— 面板按此项渲染"逐模型档位"。 */
    eq(raw.order, {
      zcode: [{ route: 'plan::GLM-5.3', reasoningLevel: null }],
      opencode: [{ route: 'opencode/a', reasoningLevel: null }],
    }, 'order 落盘 = 设置值（只含非空引擎；项为 {route, reasoningLevel}）');
    /* 旧格式（纯字符串数组）必须仍能读入 —— 向后兼容 */
    writeFileSync(file, JSON.stringify({ version: 1, mode: true, order: { opencode: ['opencode/x', 'opencode/y'] } }), 'utf8');
    const d2 = createDispatcher({ runnerPath: process.execPath, workRoot });
    eq(d2.getSequential().order.opencode, ['opencode/x', 'opencode/y'], '★ 旧格式（字符串数组）仍能读入');
    eq(d2.getSequential().levels.opencode, [null, null], '旧格式读入后档位为 null（= 引擎默认，不猜）');
    ok(typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt)), 'updatedAt 是合法时间戳');
  });

  await scenario('A8 重启后读回：同一 workRoot 新建 dispatcher 与落盘一致', async () => {
    const workRoot = newTempDir();
    const d1 = makeDispatcher(workRoot);
    d1.setSequential({ enabled: true, order: { zcode: ['plan::GLM-5.3'], opencode: ['opencode/a', 'opencode/b'] } });
    const d2 = makeDispatcher(workRoot);
    eq(d2.getSequential(), d1.getSequential(), '新 dispatcher 的 getSequential() 与重启前完全一致');
    eq(d2.getSequential().order.zcode, ['plan::GLM-5.3'], '重启后顺序列表逐字保留（不重排/不改写）');
  });

  await scenario('A9 fail-open：文件损坏 / 形状不对 ⇒ 默认关、不抛', async () => {
    const wr1 = newTempDir();
    mkdirSync(join(wr1, 'state'), { recursive: true });
    writeFileSync(join(wr1, 'state', 'sequential.json'), '{ 这不是 JSON ][', 'utf8');
    let threw = null;
    let dCorrupt = null;
    try {
      dCorrupt = createDispatcher({ runnerPath: process.execPath, workRoot: wr1 });
    } catch (e) {
      threw = e;
    }
    eq(threw, null, '损坏的 sequential.json 不得让 createDispatcher 抛错');
    eq(dCorrupt?.getSequential(), DEFAULT_SEQ(), '损坏 ⇒ fail-open 默认关 + 三引擎空顺序');

    const wr2 = newTempDir();
    mkdirSync(join(wr2, 'state'), { recursive: true });
    writeFileSync(
      join(wr2, 'state', 'sequential.json'),
      JSON.stringify({ mode: 'yes', order: { zcode: 'not-an-array', bogus: ['x'] } }),
      'utf8',
    );
    const dBad = createDispatcher({ runnerPath: process.execPath, workRoot: wr2 });
    eq(dBad.getSequential(), DEFAULT_SEQ(), '形状不对（mode 非布尔 / order 非数组）⇒ 归一成默认，不猜');
  });

  await scenario('A10 入参校验：非对象 ⇒ TypeError', async () => {
    const d = makeDispatcher();
    let e1 = null;
    try {
      d.setSequential(null);
    } catch (e) {
      e1 = e;
    }
    ok(e1 instanceof TypeError, 'setSequential(null) 抛 TypeError（不静默当"清空"）');
    let e2 = null;
    try {
      d.setSequential(undefined);
    } catch (e) {
      e2 = e;
    }
    ok(e2 instanceof TypeError, 'setSequential(undefined) 抛 TypeError');
  });
}

/* ═══════════════════════════ B. 失败推进（finalizeJob → advanceSequential） ═══════════════════════════ */

async function scenarioB1() {
  await scenario('B1 失败推进：失败 ⇒ 按顺序 a→b→c 交接，列表用尽后停止（不无限重试）', async () => {
    const dir = newTempDir();
    const workRoot = newTempDir();
    const marker = join(dir, 'spawn-models.log');
    const fake = makeSilentFailRunner(dir, marker);
    const cap = captureSpawn();
    const d = createDispatcher({
      runnerPath: fake,
      opencodeRunnerPath: fake,
      workRoot,
      spawnImpl: cap.impl,
      maxConcurrent: 4,
    });
    d.setSequential({ enabled: true, order: { opencode: ['opencode/a', 'opencode/b', 'opencode/c'] } });

    const a = d.dispatch({
      kind: 'prompt',
      prompt: 'ZB-52 顺序派发失败推进（假执行器立即静默失败）',
      provider: 'opencode',
      model: 'opencode/a',
    });
    eq(a.spec.model, 'opencode/a', '首轮 job 的 spec.model = 顺序列表第 1 个');

    /* 等 b 出现（a 失败后由 advanceSequential → retry 交接出来） */
    const bRef = await waitFor(() => d.list().find((j) => j.spec?.model === 'opencode/b') ?? null, 'a 失败后交接出 b（opencode/b）');
    const bNow = d.get(bRef.id);
    eq(bNow.spec.provider, 'opencode', 'b.spec.provider = 裸引擎名 opencode');
    eq(bNow.spec.model, 'opencode/b', 'b.spec.model = 顺序列表第 2 个');
    eq(bNow.engine, 'opencode', 'b.engine 落库 = opencode');
    eq(bNow.parentJobId, a.id, 'b.parentJobId 指向 a');
    eq(bNow.hopCount, 1, 'b.hopCount = 1');
    eq(bNow.attempts.length, 2, 'b.attempts 两条（原 job + 本次交接）');
    eq(bNow.attempts[1]?.reason, 'handoff-retry', 'b.attempts[1].reason = handoff-retry');

    await waitFor(
      () => {
        const j = d.get(bRef.id);
        return j && j.state === 'failed';
      },
      'b 落到 failed（静默非 0 退出）',
    );

    const aNow = d.get(a.id);
    eq(aNow.state, 'failed', 'a 归为 failed（无暂停签名 ⇒ 不是 paused）');
    eq(aNow.exitCode, 1, 'a.exitCode = 1');
    eq(aNow.pauseReason, null, '静默失败不伪造 pauseReason');
    eq(aNow.handedOffTo, bRef.id, 'a.handedOffTo 指向 b');
    ok(
      aNow.parseWarnings.some((w) => w.includes('顺序派发: 第 2/3 个模型') && w.includes('opencode/opencode/b')),
      'a 的 parseWarnings 记录「顺序派发: 第 2/3 个模型 opencode/opencode/b」',
    );
    ok(aNow.parseWarnings.some((w) => w.includes('退出码 1')), 'a 的顺序派发 warning 带失败原因「退出码 1」');

    /* 等 c 出现，并等它失败 */
    const cRef = await waitFor(() => d.list().find((j) => j.spec?.model === 'opencode/c') ?? null, 'b 失败后交接出 c（opencode/c）');
    const cNow0 = d.get(cRef.id);
    eq(cNow0.spec.model, 'opencode/c', 'c.spec.model = 顺序列表第 3 个');
    eq(cNow0.parentJobId, bRef.id, 'c.parentJobId 指向 b');
    eq(cNow0.hopCount, 2, 'c.hopCount = 2（a→b→c）');
    eq(cNow0.attempts.length, 4, 'c.attempts 4 条（继承 b 的 2 条 + 本次 2 条）');
    eq(cNow0.attempts[3]?.reason, 'handoff-retry', 'c.attempts[3].reason = handoff-retry');

    await waitFor(
      () => {
        const j = d.get(cRef.id);
        return j && j.state === 'failed';
      },
      'c 落到 failed',
    );
    /* 列表用尽 warning 在 c 的 finalizeJob 里同步写入 → 等它出现 */
    await waitFor(
      () => d.get(cRef.id).parseWarnings.some((w) => w.includes('顺序派发: 已试完 3 个模型')),
      'c 的 parseWarnings 出现「已试完 3 个模型」',
    );

    const bNow2 = d.get(bRef.id);
    ok(
      bNow2.parseWarnings.some((w) => w.includes('顺序派发: 第 3/3 个模型') && w.includes('opencode/opencode/c')),
      'b 的 parseWarnings 记录「顺序派发: 第 3/3 个模型 opencode/opencode/c」',
    );
    const cNow = d.get(cRef.id);
    eq(cNow.handedOffTo, null, 'c 之后没有下一跳（handedOffTo=null）');
    ok(
      cNow.parseWarnings.some((w) => w.includes('列表用尽')),
      'c 的 parseWarnings 记录「列表用尽」（交回降级链 / 停在此处）',
    );

    /* 实际 spawn 顺序 = 面板顺序（规则：数组顺序就是派发次序，不得重排） */
    eq(
      cap.calls.map((args) => argOf(args, '--model')),
      ['opencode/a', 'opencode/b', 'opencode/c'],
      '实际 spawn 的 --model 顺序与顺序列表一致',
    );
    eq(
      readFileSync(marker, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean),
      ['opencode/a', 'opencode/b', 'opencode/c'],
      '假执行器内部看到的调用顺序同样一致（排除"命令行对但没真跑"）',
    );

    /* 列表用尽后必须停：给一点宽限再复核（spawn 次数与 job 数都不许再涨） */
    const spawns = cap.calls.length;
    await sleep(250);
    eq(cap.calls.length, spawns, '列表用尽后不再 spawn（不无限重试）');
    eq(d.list().length, 3, '总 job 数 = 3（a/b/c，不再产生新 job）');
    eq(
      d.list().filter((j) => j.state === 'running' || j.state === 'queued').length,
      0,
      '没有仍在 running/queued 的 job',
    );
  });
}

async function scenarioB2() {
  await scenario('B2 config-error 不延续：整列表配置了也停在 paused、不换模型', async () => {
    const dir = newTempDir();
    const workRoot = newTempDir();
    const fake = makePauseRunner(dir, 'fake-oc-config-error.mjs', 'CONFIGURATION_ERROR: Select a model before continuing');
    const cap = captureSpawn();
    const d = createDispatcher({
      runnerPath: fake,
      opencodeRunnerPath: fake,
      workRoot,
      spawnImpl: cap.impl,
    });
    d.setSequential({ enabled: true, order: { opencode: ['opencode/a', 'opencode/b'] } });
    const j = d.dispatch({ kind: 'prompt', prompt: 'ZB-52 config-error 不延续', provider: 'opencode', model: 'opencode/a' });

    await waitFor(
      () => {
        const x = d.get(j.id);
        return x && x.state === 'paused';
      },
      'config-error 签名 ⇒ paused',
    );
    const pj = d.get(j.id);
    eq(pj.state, 'paused', 'config-error 命中暂停签名 ⇒ 状态 paused');
    eq(pj.pauseReason, 'config-error', 'pauseReason = config-error');
    eq(pj.handedOffTo, null, '不产生交接 job');
    ok(
      !pj.parseWarnings.some((w) => w.includes('顺序派发')),
      'config-error 不触发顺序派发（没有任何「顺序派发」warning）',
    );
    const spawns = cap.calls.length;
    await sleep(250);
    eq(spawns, 1, '只 spawn 一次：参数错误换模型也没用 ⇒ 不许换下一个模型');
    eq(cap.calls.length, 1, '宽限后仍只有 1 次 spawn');
    eq(d.list().length, 1, '只有原 job，没有交接出的新 job');
  });
}

async function scenarioB3() {
  await scenario('B3 paused 不限暂停原因都延续（quota / entitlement / signing）', async () => {
    const cases = [
      { reason: 'quota-exhausted', text: 'quota_exceeded: plan quota used up (429)' },
      { reason: 'plan-not-entitled', text: 'coding_plan_not_entitled: 当前账号未开通该套餐' },
      { reason: 'provider-signing', text: 'ClientRequestSigningV4Error: Client signing credential must contain one separator' },
    ];
    for (const c of cases) {
      const dir = newTempDir();
      const workRoot = newTempDir();
      const fake = makePauseRunner(dir, `fake-oc-${c.reason}.mjs`, c.text);
      const cap = captureSpawn();
      const d = createDispatcher({
        runnerPath: fake,
        opencodeRunnerPath: fake,
        workRoot,
        spawnImpl: cap.impl,
      });
      d.setSequential({ enabled: true, order: { opencode: ['opencode/a', 'opencode/b'] } });
      const a = d.dispatch({
        kind: 'prompt',
        prompt: `ZB-52 paused 延续（${c.reason}）`,
        provider: 'opencode',
        model: 'opencode/a',
      });
      await waitFor(
        () => {
          const x = d.get(a.id);
          return x && x.state === 'paused';
        },
        `${c.reason}: a 落到 paused`,
      );
      eq(d.get(a.id).pauseReason, c.reason, `${c.reason}: 暂停原因分类正确`);
      /* 关键：paused 也要换下一个模型（用户选定「任何失败都延续，除参数错误」） */
      const bRef = await waitFor(
        () => d.list().find((j) => j.parentJobId === a.id) ?? null,
        `${c.reason}: paused 后仍交接下一模型（第 2/2 个）`,
      );
      eq(bRef.spec.model, 'opencode/b', `${c.reason}: 交接目标是顺序列表第 2 个模型`);
      ok(
        d.get(a.id).parseWarnings.some((w) => w.includes('顺序派发: 第 2/2 个模型')),
        `${c.reason}: a 的 parseWarnings 记录第 2/2 个模型`,
      );
      await waitFor(
        () => {
          const x = d.get(bRef.id);
          return x && (x.state === 'paused' || x.state === 'failed');
        },
        `${c.reason}: b 落终态`,
      );
      eq(cap.calls.length, 2, `${c.reason}: spawn 恰 2 次（a + b，没有第三跳）`);
      const b = d.get(bRef.id);
      eq(b.state, 'paused', `${c.reason}: b 同样暂停（同一个假执行器文案）`);
      ok(
        b.parseWarnings.some((w) => w.includes('顺序派发: 已试完 2 个模型')),
        `${c.reason}: b 用尽列表的 warning 存在`,
      );
      eq(b.handedOffTo, null, `${c.reason}: 用尽后无下一跳`);
    }
  });
}

async function scenarioB4() {
  await scenario('B4 顺序列表用尽 ⇒ 交回既有跨通道降级链（先顺序、后降级）', async () => {
    const dir = newTempDir();
    const workRoot = newTempDir();
    const fake = makePauseRunner(dir, 'fake-oc-quota-fallback.mjs', 'quota_exceeded: plan quota used up (429)');
    const cap = captureSpawn();
    const d = createDispatcher({
      runnerPath: fake,
      opencodeRunnerPath: fake,
      workRoot,
      spawnImpl: cap.impl,
      maxConcurrent: 4,
      /* 降级链可用性替身：只有 plan 可用（ch-b/ch-c 不可用）—— 不猜，走 core 的 listChannels 契约。 */
      channelsImpl: async () => ({
        channels: [
          { id: 'plan', enabled: true },
          { id: 'ch-b', enabled: false, reason: 'down' },
          { id: 'ch-c', enabled: false, reason: 'down' },
        ],
        warnings: [],
      }),
    });
    d.setFallbackChain(['plan']);
    /* ⚠️ 本用例**刻意只给 1 个降级目标**（`['plan']`）：
     * 这是**回归钉**——原先 core 的 maybeAutoFallback 用**共享的 hopCount** 与
     * `fallbackTargets.length` 比较来封顶，而顺序交接也会让 hopCount +1，
     * 于是「降级目标数（1）≤ 顺序跳数（1）」时降级会在「已达目标数上限」门上被拦住 ⇒ 本用例会红。
     * 修法：降级链只数**自己的**跳数（attempts[].hopReason === 'auto-fallback'，见 countFallbackHops）。 */
    d.setSequential({ enabled: true, order: { opencode: ['opencode/a', 'opencode/b'] } });

    const a = d.dispatch({ kind: 'prompt', prompt: 'ZB-52 顺序用尽→降级链', provider: 'opencode', model: 'opencode/a' });
    await waitFor(
      () => {
        const x = d.get(a.id);
        return x && x.state === 'paused';
      },
      'a paused（quota）',
    );
    const bRef = await waitFor(() => d.list().find((j) => j.parentJobId === a.id) ?? null, 'a → b 顺序交接');
    await waitFor(
      () => {
        const x = d.get(bRef.id);
        return x && x.state === 'paused';
      },
      'b paused（quota）',
    );
    const b = d.get(bRef.id);
    ok(
      b.parseWarnings.some((w) => w.includes('顺序派发: 已试完 2 个模型')),
      'b 的 parseWarnings 记录顺序列表已用尽',
    );

    /* 列表用尽 ⇒ advanceSequential 返回 false ⇒ finalize 里交回降级链（provider=plan 的新 job） */
    const fbRef = await waitFor(
      () => d.list().find((j) => j.spec?.provider === 'plan') ?? null,
      '顺序列表用尽后，降级链接手（新 job provider=plan）',
      20000,
    );
    const fb0 = d.get(fbRef.id);
    eq(fb0.spec.provider, 'plan', '降级链目标 provider = plan（来自 setFallbackChain 目标列表）');
    eq(fb0.parentJobId, bRef.id, '降级链 job 的 parentJobId 指向顺序链最后一跳 b');
    eq(fb0.engine, 'zcode', '降级链目标按通道推断引擎 = zcode（跨引擎交接）');
    ok(
      d.get(bRef.id).parseWarnings.some((w) => w.includes('fallback-chain')),
      'b 上留「fallback-chain: 自动跳到 plan」warning（先顺序、后降级，不静默）',
    );

    /* 降级链目标也暂停 ⇒ 链里没有下一个可用通道 ⇒ 停在 paused、不再跳 */
    await waitFor(
      () => {
        const x = d.get(fbRef.id);
        return x && x.state === 'paused';
      },
      '降级链 job 也 paused（quota）',
    );
    const fb = d.get(fbRef.id);
    eq(fb.state, 'paused', '降级链目标同样 quota 暂停 ⇒ 停在 paused（不再无限跳）');
    /* ⚠️ 本用例只给 **1 个**降级目标（刻意收紧，见上面的回归钉）⇒ 降级**跑掉这一跳就用尽**。
     * 故这里钉两件事：
     *   ① 降级**确实发生了**（`fbRef` 存在，上面已断言）—— 修前它会被"已达目标数上限"拦住而根本不出现；
     *   ② 降级用尽后才出现「已达目标数上限」warning（**是真实用尽**，不是被顺序跳数挤掉的误判）。
     * 判别依据：attempts 里**确实有** auto-fallback 的降级交接记录 ⇒ 门是"用尽"而非"误拦"。 */
    const fbAttempts = Array.isArray(fb.attempts) ? fb.attempts : [];
    const fallbackHops = fbAttempts.filter((a) => a.hopReason === 'auto-fallback').length;
    ok(fallbackHops >= 1, `降级 job 上确有 auto-fallback 交接记录（实际 ${fallbackHops}）⇒ 降级真的发生过`);
    ok(
      fb.parseWarnings.some((w) => w.includes('已达目标数上限')),
      `★ 降级预算是「真实用尽」而非「被顺序跳数挤掉」（1 个目标 + 已用 ${fallbackHops} 跳）`,
    );
    const jobsBefore = d.list().length;
    await sleep(250);
    eq(d.list().length, jobsBefore, '降级用尽后不再产生新 job');
    ok(jobsBefore >= 3, `至少 a/b + 降级链 job 三个 job（实际 ${jobsBefore}）`);
  });
}

/* ═══════════════════════════ C. 思考强度探测补齐 ═══════════════════════════ */

async function scenarioC() {
  await scenario('C 思考强度探测：Qoder reasoning-efforts 并入 / OpenCode variants 逐模型 / 没报档位不造档位', async () => {
    const dir = newTempDir();
    const workRoot = newTempDir();
    const qoderMarker = join(dir, 'qoder-probe-marker.log');
    const ocMarker = join(dir, 'oc-probe-marker.log');
    const fakeQoder = makeQoderProbeRunner(dir, qoderMarker);
    const fakeOc = makeOpenCodeProbeRunner(dir, ocMarker);

    const zcodeTable = [
      'provider                          enabled  endpoint                            | models',
      'builtin:bigmodel-coding-plan      true     https://open.bigmodel.example/api   | GLM-5.3',
    ].join('\n');

    let fakeNow = Date.now();
    const d = createDispatcher({
      runnerPath: process.execPath,
      workRoot,
      opencodeRunnerPath: fakeOc,
      qoderRunnerPath: fakeQoder,
      channelsProbeImpl: async () => zcodeTable,
      zcodeConfigPath: join(dir, 'missing-config.json'),
      planCachePath: join(dir, 'missing-plan-cache.json'),
      personalProviderPath: join(dir, 'missing-personal.json'),
      now: () => fakeNow,
      maxConcurrent: 2,
    });

    const of = (r, engine) => r.channels.filter((c) => c.engine === engine);

    /* ── C1：首次调用立刻拿到通道；档位允许缺省（TTL 缓存 + 后台预热是**设计**，不是 bug） ── */
    const first = await d.listChannels();
    eq(
      of(first, 'opencode').map((c) => c.id),
      ['opencode/model-a', 'opencode/model-b', 'opencode/model-c'],
      '首次 listChannels 即拿到全部 OpenCode 通道（不因档位预热而缺失）',
    );
    ok(
      of(first, 'opencode').every((c) => !('thinkingLevels' in c)),
      '首次「后台预热」未完成 ⇒ 档位可缺省（设计如此；不是通道缺失/不是 bug）',
    );
    eq(
      of(first, 'qoder').map((c) => c.id),
      ['qoder/GLM-5.3', 'qoder/Qwen3.8-Max'],
      '首次 listChannels 即拿到 Qoder 通道',
    );
    ok(
      of(first, 'qoder').every((c) => !('thinkingLevels' in c)),
      '首次 Qoder 档位同样可缺省（后台预热）',
    );
    const planFirst = first.channels.find((c) => c.id === 'plan');
    ok(!!planFirst, '对照组：ZCode plan 别名仍在（本 fixture 没有 reasoning-levels 行）');
    ok(planFirst && !('thinkingLevels' in planFirst), '对照组：没有探测行时 plan 不写 thinkingLevels（不猜）');

    /* ── C2：轮询等待后台预热完成，断言解析与合入 ── */
    const warmed = await waitFor(
      async () => {
        const r = await d.listChannels();
        const oc = of(r, 'opencode');
        const ocA = oc.find((c) => c.id === 'opencode/model-a');
        const ocB = oc.find((c) => c.id === 'opencode/model-b');
        const ocC = oc.find((c) => c.id === 'opencode/model-c');
        const qd = of(r, 'qoder');
        const qOK = qd.length === 2 && qd.every((x) => Array.isArray(x.thinkingLevels) && x.thinkingLevels.length > 0);
        return ocA?.thinkingLevels && ocB?.thinkingLevels && ocC && !('thinkingLevels' in ocC) && qOK ? r : null;
      },
      '轮询 listChannels 直到后台预热出 thinkingLevels',
      20000,
    );

    const ocA = of(warmed, 'opencode').find((c) => c.id === 'opencode/model-a');
    const ocB = of(warmed, 'opencode').find((c) => c.id === 'opencode/model-b');
    const ocC = of(warmed, 'opencode').find((c) => c.id === 'opencode/model-c');
    eq(ocA.thinkingLevels, ['low', 'high'], '★ OpenCode 逐模型档位：opencode/model-a = low,high（按 variants 行原样）');
    eq(ocB.thinkingLevels, ['minimal', 'max'], '★ OpenCode 逐模型档位：opencode/model-b = minimal,max');
    eq('thinkingLevels' in ocC, false, '*★ 没报 variants 的 opencode/model-c 不得被造出档位*（真机有 4 个模型没有 variants）');
    eq(ocC.thinkingLevels, undefined, 'opencode/model-c.thinkingLevels = undefined（字段缺席，不是空数组）');
    ok(!!ocC, 'opencode/model-c 本身仍在通道清单里（不因缺档位而消失）');

    const qd = of(warmed, 'qoder');
    const qExpected = ['high', 'low', 'max', 'medium']; // 两行档位的并集（引擎级），排序后比较
    eq(
      [...(qd[0]?.thinkingLevels ?? [])].sort(),
      qExpected,
      '★ Qoder 通道 thinkingLevels = reasoning-efforts 各模型档位并集（引擎级，真机 --with-efforts 拿不到逐模型子集）',
    );
    eq([...(qd[1]?.thinkingLevels ?? [])].sort(), qExpected, 'Qoder 每个通道都带上同一份并集');
    ok(
      !warmed.channels.some((c) => Array.isArray(c.thinkingLevels) && c.thinkingLevels.length === 0),
      '任何通道都不得出现空档位数组（没有档位就不带字段）',
    );

    /* 两路探测确实被**请求**（假执行器落盘 marker）——这正是「原先根本没请求探测」的回归点 */
    ok(lineCount(qoderMarker) >= 1, '★ Qoder --list-models --with-efforts 探测确实被后台请求（marker 有记录）');
    ok(
      readFileSync(qoderMarker, 'utf8').includes('--with-efforts'),
      '★ Qoder 探测请求里带 --with-efforts（不是普通 --list-models）',
    );
    ok(lineCount(ocMarker) >= 1, '★ OpenCode --list-models --with-variants 探测确实被后台请求（marker 有记录）');
    ok(
      readFileSync(ocMarker, 'utf8').includes('--with-variants'),
      '★ OpenCode 探测请求里带 --with-variants（不是普通 --list-models）',
    );

    /* ── C3：TTL 过期 ⇒ 立刻返回旧缓存（不阻塞）并后台重探 ── */
    const ocBefore = lineCount(ocMarker);
    const qdBefore = lineCount(qoderMarker);
    fakeNow += 31 * 60 * 1000; // 越过 30 分钟 TTL
    const expiredCall = await d.listChannels();
    ok(
      Array.isArray(of(expiredCall, 'opencode').find((c) => c.id === 'opencode/model-a')?.thinkingLevels),
      'TTL 过期当次仍立刻返回**旧缓存**档位（不因重探阻塞通道清单）',
    );
    await waitFor(
      () => lineCount(ocMarker) > ocBefore && lineCount(qoderMarker) > qdBefore,
      'TTL 过期触发两路后台重探（marker 行数增长）',
      20000,
    );
    ok(
      lineCount(ocMarker) > ocBefore && lineCount(qoderMarker) > qdBefore,
      'TTL 过期后两路探测都被后台重新请求（缓存过期 ⇒ 重探，不是一直吃旧值）',
    );

    /* ── C4：超时值可配 = 源码级断言 ──
     * 真机 --with-efforts 约 2 分钟、--with-variants 也要跑 `models --verbose`，
     * 原实现把超时写死（Qoder 30s / OpenCode 15s）会把它们误杀。真实长探测不能在此端到端等，
     * 故这里钉源码里的**传参**（探测入口带显式大超时 + 函数签名可配），配合上面的 marker
     * 证明"确实请求了探测"，共同覆盖该修复。 */
    const coreSrc = readFileSync(join(HERE, '..', 'core', 'dispatch-core.mjs'), 'utf8');
    ok(
      coreSrc.includes("runQoderProbe(['--list-models', '--with-efforts'], 240000)"),
      '源码级：Qoder --with-efforts 探测以 240000ms 超时发起（原先写死 30s ⇒ 会被误杀）',
    );
    ok(
      coreSrc.includes("runOpenCodeProbe(['--list-models', '--with-variants'], 180000)"),
      '源码级：OpenCode --with-variants 探测以 180000ms 超时发起（原先写死 15s ⇒ 会被误杀）',
    );
    ok(
      /function runQoderProbe\(args, timeoutMs = 30000\)/.test(coreSrc),
      '源码级：runQoderProbe(args, timeoutMs) 超时可配（默认 30s）',
    );
    ok(
      /function runOpenCodeProbe\(args, timeoutMs = 15000\)/.test(coreSrc),
      '源码级：runOpenCodeProbe(args, timeoutMs) 超时可配（默认 15s）',
    );
  });
}

/* ═══════════════════════════ 入口 ═══════════════════════════ */

async function main() {
  await scenarioA();
  await scenarioB1();
  await scenarioB2();
  await scenarioB3();
  await scenarioB4();
  await scenarioC();
}

try {
  await main();
} catch (e) {
  fail += 1;
  failures.push(`主流程未捕获异常: ${e?.stack ?? e}`);
  console.log(`not ok - 主流程未捕获异常: ${e?.message ?? e}`);
} finally {
  /* 清理临时目录（Windows 上偶有句柄未释放，忽略即可） */
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
  /* 还原被隔离的环境变量（本进程即将退出；保持干净以便被 --test 聚合时不影响他人） */
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
}

console.log(`\n============================================`);
console.log(`PASS ${pass} / FAIL ${fail}（共 ${total} 条断言）`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
