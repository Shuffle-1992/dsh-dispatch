/**
 * ZB-52 **顺序派发**（core 侧）+ **思考强度探测补齐** 的独立自测（零依赖，独立可跑）。
 * 运行：node dispatch/test/sequential-dispatch.test.mjs
 *
 * 被测源码：dispatch/core/dispatch-core.mjs（**本文件不修改任何源码**）。
 *
 * 覆盖三组：
 *   A. 状态与 API（getSequential / setSequential）：
 *      · 初始 {order:{zcode,opencode,qoder 三键恒在}, levels（与 order 同序的逐模型档位）, sequentialCount:0}
 *      · ★ **没有 enabled 开关**（第三轮用户要求：模型为空即顺序派发）⇒ setSequential({enabled}) 明确抛 TypeError
 *      · ★ order **按引擎合并**（回归：原实现整体替换会静默清空其它引擎）
 *      · 显式清空（[] / null）只清目标引擎；未知引擎键被丢弃（不得因 normalizeEngine 回退写进 zcode）
 *      · 去重且保持顺序、逐模型档位对齐/同 route 原位覆盖
 *      · 落盘 <workRoot>/state/sequential.json = {version:2, order:[{route, reasoningLevel}], updatedAt}
 *      · 重启后读回一致；v1 旧文件仍能读（mode 被忽略）；文件损坏/形状不对 ⇒ fail-open 且不抛
 *   B. 失败推进（advanceSequential，由 finalizeJob 触发）——用假执行器驱动，不跑真 CLI：
 *      · ★ 接管判据：模型为空 + 该引擎有列表 ⇒ **首次派发就用列表第一项**（不是引擎默认模型）；
 *        显式指定 model ⇒ 不被劫持；模型为空但没有列表 ⇒ 不接管（不注入模型）
 *      · failed（静默非 0 退出）⇒ 按面板顺序 a→b→c 交接重跑，逐个前进
 *      · ★ 回归钉：3 项列表必须**真的 spawn 3 次**（seqRuns 未移交给新 job 时会在第 2 跳提前停）
 *      · 列表用尽 ⇒ 留「已试完 N 个模型」warning、不再无限重试（spawn 次数封顶）
 *      · paused 不限暂停原因（quota / entitlement / signing）都延续
 *      · config-error **不**延续（停在 paused、不换模型）
 *      · 列表用尽 ⇒ 交回既有跨通道降级链（**单目标**也要生效：降级预算/起点回归钉）
 *      · ★ **降级目标也支持顺序派发**：目标 model 为空 + 该引擎有列表 ⇒ 降到该目标时从列表第一项起跑，
 *        列表跑完才继续**外层**降级链
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

/**
 * B 组**新语义的起跑方式**（第三轮：没有全局开关）：
 *   「模型」选「顺序派发」= 默认通道的 model 存**空值** ⇒ 派发时按该引擎的顺序列表从上到下试。
 * 注意：**不能再**用 `dispatch({model:'opencode/a'})` 模拟第一跳 —— 显式指定模型不会被劫持。
 */
function armSequential(d, provider, order) {
  d.setChannel({ provider, model: '' });
  return d.setSequential({ order });
}

const EMPTY_ORDER = () => ({ zcode: [], opencode: [], qoder: [] });
/* ZB-52（第二轮，用户要求「顺序思考强度档位设置」）：`getSequential()` 多了 `levels` ——
 * 与 `order` **同序**的逐模型档位数组（null = 该模型用引擎默认）；
 * 落盘 `sequential.json` 的 order 项也随之升级成 `{route, reasoningLevel}`（见对应断言）。 */
const EMPTY_LEVELS = () => ({ zcode: [], opencode: [], qoder: [] });
/* 第三轮：`enabled` 已从 API 移除（顺序派发由「模型为空」表达）⇒ 默认形状不再有它。 */
const DEFAULT_SEQ = () => ({ order: EMPTY_ORDER(), levels: EMPTY_LEVELS(), sequentialCount: 0 });

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
 * config-error / quota-exhausted / plan-not-entitled / provider-signing 都可用它驱动；
 * 也作为「降级目标顺序派发」里 qoder 引擎的假执行器（不跑真 CLI）。
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
  await scenario('A1 初始状态：三引擎键恒在 + 没有 enabled 开关 + sequentialCount=0', async () => {
    const d = makeDispatcher();
    const s = d.getSequential();
    eq(s.order, EMPTY_ORDER(), '初始 order = 三个引擎的空数组（客户端据此渲染）');
    eq(s.levels, EMPTY_LEVELS(), '初始 levels = 三个引擎的平行空数组');
    eq(Object.keys(s.order).sort(), ['opencode', 'qoder', 'zcode'], '*三个引擎键永远都在*');
    eq(s.sequentialCount, 0, '初始 sequentialCount=0');
    ok(!('enabled' in s), '*★ 不再有 enabled 字段*（第三轮用户要求去掉全局开关：模型为空即顺序派发）');
    eq(Object.keys(s).sort(), ['levels', 'order', 'sequentialCount'], 'API 对外形状 = {order, levels, sequentialCount}');
  });

  await scenario('A2 只传 order 可用；空 patch 不改状态', async () => {
    const d = makeDispatcher();
    const s1 = d.setSequential({ order: { zcode: ['plan::GLM-5.3'] } });
    eq(s1.order.zcode, ['plan::GLM-5.3'], '只传 order ⇒ 顺序生效');
    eq(s1.levels.zcode, [null], '只传 order ⇒ 该模型档位 null（用引擎默认）');
    const s2 = d.setSequential({});
    eq(s2, s1, '空 patch 不改变状态（仍返回当前状态）');
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
    eq(s.levels.opencode, [null, null, null], '纯字符串项 ⇒ 档位都是 null（引擎默认）');
  });

  await scenario('A7 逐模型档位：levels 与 order 同序；同一 route 原位覆盖档位', async () => {
    const d = makeDispatcher();
    const s = d.setSequential({
      order: {
        opencode: [
          { route: 'opencode/a', reasoningLevel: 'high' },
          'opencode/b',
          { route: 'opencode/c', thinking: 'low' },
          { route: 'opencode/d', reasoningLevel: 'bad level!' },
        ],
      },
    });
    eq(s.order.opencode, ['opencode/a', 'opencode/b', 'opencode/c', 'opencode/d'], 'order 保持给定次序');
    eq(
      s.levels.opencode,
      ['high', null, 'low', null],
      '*逐模型档位与 order 同序*：reasoningLevel / thinking 别名接受；非法档位归 null（不猜）',
    );
    /* 同一 route 出现两次 ⇒ 去重到首次位置，档位取**后出现的**（后者覆盖前者）。 */
    const s2 = d.setSequential({ order: { opencode: ['opencode/a', { route: 'opencode/a', reasoningLevel: 'max' }] } });
    eq(s2.order.opencode, ['opencode/a'], '同 route 去重');
    eq(s2.levels.opencode, ['max'], '同 route 的档位以后者为准（原位覆盖，不改变顺序）');
  });

  await scenario('A8 落盘形状：<workRoot>/state/sequential.json = {version:2, order:[{route,reasoningLevel}], updatedAt}', async () => {
    const workRoot = newTempDir();
    const d = makeDispatcher(workRoot);
    d.setSequential({ order: { zcode: ['plan::GLM-5.3'], opencode: [{ route: 'opencode/a', reasoningLevel: 'high' }] } });
    const file = join(workRoot, 'state', 'sequential.json');
    ok(existsSync(file), '落盘文件 <workRoot>/state/sequential.json 存在');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    eq(raw.version, 2, 'version=2（v2 去掉全局 mode）');
    ok(!('mode' in raw), '*落盘不再有 mode 字段*（没有全局开关）');
    eq(
      raw.order,
      {
        zcode: [{ route: 'plan::GLM-5.3', reasoningLevel: null }],
        opencode: [{ route: 'opencode/a', reasoningLevel: 'high' }],
      },
      '落盘 order 项 = {route, reasoningLevel}（档位逐模型）',
    );
    ok(typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt)), 'updatedAt 是合法时间戳');
    /* 对外形状与落盘形状不同：`getSequential().order` 仍是**字符串数组**（客户端既有渲染契约不变）。 */
    const s = d.getSequential();
    eq(s.order.zcode, ['plan::GLM-5.3'], '对外 order 仍是字符串数组（客户端渲染契约不变）');
    eq(s.levels.opencode, ['high'], '对外 levels 与 order 同序');
  });

  await scenario('A9 重启后读回：同一 workRoot 新建 dispatcher 与落盘一致（含 levels）', async () => {
    const workRoot = newTempDir();
    const d1 = makeDispatcher(workRoot);
    d1.setSequential({
      order: {
        zcode: ['plan::GLM-5.3'],
        opencode: ['opencode/a', { route: 'opencode/b', reasoningLevel: 'max' }],
      },
    });
    const d2 = makeDispatcher(workRoot);
    eq(d2.getSequential(), d1.getSequential(), '新 dispatcher 的 getSequential() 与重启前完全一致');
    eq(d2.getSequential().order.opencode, ['opencode/a', 'opencode/b'], '重启后顺序列表逐字保留（不重排/不改写）');
    eq(d2.getSequential().levels.opencode, [null, 'max'], '重启后逐模型档位也保留');
  });

  await scenario('A10 v1 旧文件仍能读（mode 被忽略，字符串项档位=null）', async () => {
    const workRoot = newTempDir();
    mkdirSync(join(workRoot, 'state'), { recursive: true });
    writeFileSync(
      join(workRoot, 'state', 'sequential.json'),
      JSON.stringify({
        version: 1,
        mode: true, // v1 的全局开关：新实现**忽略**它，不报错
        order: { zcode: ['plan::GLM-5.3'], opencode: ['opencode/a'] },
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );
    const d = createDispatcher({ runnerPath: process.execPath, workRoot });
    const s = d.getSequential();
    eq(s.order, { zcode: ['plan::GLM-5.3'], opencode: ['opencode/a'], qoder: [] }, 'v1 文件的 order 直接可用（向后兼容）');
    eq(s.levels, { zcode: [null], opencode: [null], qoder: [] }, 'v1 字符串项 ⇒ 档位 null（引擎默认，不猜）');
    ok(!('enabled' in s), 'v1 的 mode 不会复活成 enabled 字段');
  });

  await scenario('A11 fail-open：文件损坏 / 形状不对 ⇒ 默认空、不抛', async () => {
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
    eq(dCorrupt?.getSequential(), DEFAULT_SEQ(), '损坏 ⇒ fail-open 默认空 + 三引擎空顺序/空档位');

    const wr2 = newTempDir();
    mkdirSync(join(wr2, 'state'), { recursive: true });
    writeFileSync(
      join(wr2, 'state', 'sequential.json'),
      JSON.stringify({ version: 2, order: { zcode: 'not-an-array', bogus: ['x'] } }),
      'utf8',
    );
    const dBad = createDispatcher({ runnerPath: process.execPath, workRoot: wr2 });
    eq(dBad.getSequential(), DEFAULT_SEQ(), '形状不对（order 非数组）⇒ 归一成默认，不猜');
  });

  await scenario('A12 ★ setSequential({enabled}) 明确抛 TypeError（开关已废弃，不静默忽略）', async () => {
    const d = makeDispatcher();
    const before = d.getSequential();
    let e1 = null;
    try {
      d.setSequential({ enabled: true });
    } catch (e) {
      e1 = e;
    }
    ok(e1 instanceof TypeError, '*★ setSequential({enabled:true}) 抛 TypeError*（明确报错，不静默忽略）');
    ok(e1 && /enabled/.test(e1.message), '错误信息点名 enabled');
    ok(e1 && /废弃/.test(e1.message), '错误信息说明「已废弃」及替代方式（模型为空即顺序派发）');
    let e2 = null;
    try {
      d.setSequential({ enabled: false });
    } catch (e) {
      e2 = e;
    }
    ok(e2 instanceof TypeError, 'enabled:false 同样抛（字段整体废弃，不是只拒 true）');
    let e3 = null;
    try {
      d.setSequential({ enabled: true, order: { opencode: ['opencode/a'] } });
    } catch (e) {
      e3 = e;
    }
    ok(e3 instanceof TypeError, 'enabled + order 同一 patch 抛错');
    eq(d.getSequential(), before, '被拒的 patch 不得应用 order（先杀开关，状态零改动）');
  });

  await scenario('A13 入参校验：非对象 ⇒ TypeError', async () => {
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

/* ═══════════════════════════ B. 派发/失败推进（finalizeJob → advanceSequential） ═══════════════════════════ */

/* B0：**接管判据**（第三轮新语义的核心：模型为空即顺序派发；指定了模型就按指定跑）。 */
async function scenarioB0() {
  await scenario('B0a ★ 接管判据：模型为空 + 该引擎有列表 ⇒ 首次派发就用列表第一项', async () => {
    const dir = newTempDir();
    const workRoot = newTempDir();
    const fake = makeSilentFailRunner(dir, join(dir, 'b0a.log'));
    const cap = captureSpawn();
    const d = createDispatcher({ runnerPath: fake, opencodeRunnerPath: fake, workRoot, spawnImpl: cap.impl });
    armSequential(d, 'opencode', { opencode: ['opencode/a', 'opencode/b'] });

    const j = d.dispatch({ kind: 'prompt', prompt: 'ZB-52 B0a（不传 model）' });
    eq(j.spec.provider, 'opencode', '不传 provider ⇒ 用默认通道（opencode）');
    eq(j.spec.model, 'opencode/a', '*★ 首次派发由 core 定位到顺序列表第一项*（不是引擎默认模型）');
    eq(j.engine, 'opencode', '引擎落库 = opencode');
    await waitFor(() => cap.calls.length >= 1, '首跳 spawn');
    eq(argOf(cap.calls[0], '--model'), 'opencode/a', '首跳命令行 --model = 列表第一项');
    /* 收尾：让它跑完整个 2 项列表，避免残留运行中任务 */
    await waitFor(
      () => d.list().length === 2 && d.list().every((x) => x.state === 'failed'),
      'B0a 两项列表跑完',
      20000,
    );
  });

  await scenario('B0b ★ 接管判据：显式指定 model ⇒ 不被顺序列表劫持', async () => {
    const dir = newTempDir();
    const workRoot = newTempDir();
    const fake = makeSilentFailRunner(dir, join(dir, 'b0b.log'));
    const cap = captureSpawn();
    const d = createDispatcher({ runnerPath: fake, opencodeRunnerPath: fake, workRoot, spawnImpl: cap.impl });
    /* 有列表，但 dispatch 显式指定了 opencode/b ⇒ 必须按指定的跑，不得被列表改写/推进 */
    d.setSequential({ order: { opencode: ['opencode/a', 'opencode/b', 'opencode/c'] } });
    const j = d.dispatch({ kind: 'prompt', prompt: 'ZB-52 B0b', provider: 'opencode', model: 'opencode/b' });
    eq(j.spec.model, 'opencode/b', '显式 model 原样保留');
    await waitFor(
      () => {
        const x = d.get(j.id);
        return x && x.state === 'failed';
      },
      'B0b 显式 model 任务落 failed',
    );
    await sleep(300);
    eq(cap.calls.length, 1, '*★ 显式模型不触发顺序链*：只 spawn 1 次');
    eq(argOf(cap.calls[0], '--model'), 'opencode/b', '命令行 --model = 显式指定的那个');
    eq(d.list().length, 1, '没有交接出的第二个 job');
    ok(!d.get(j.id).parseWarnings.some((w) => w.includes('顺序派发')), '没有任何「顺序派发」warning');
  });

  await scenario('B0c 接管判据：模型为空但该引擎没有列表 ⇒ 不接管（不注入任何模型）', async () => {
    const dir = newTempDir();
    const workRoot = newTempDir();
    const fake = makeSilentFailRunner(dir, join(dir, 'b0c.log'));
    const cap = captureSpawn();
    const d = createDispatcher({ runnerPath: fake, opencodeRunnerPath: fake, workRoot, spawnImpl: cap.impl });
    d.setChannel({ provider: 'opencode', model: '' }); // 模型留空，但顺序列表为空
    const j = d.dispatch({ kind: 'prompt', prompt: 'ZB-52 B0c' });
    ok(!j.spec.model, '没有顺序列表 ⇒ 不注入模型（spec.model 保持空；不是引擎默认模型）');
    await waitFor(
      () => {
        const x = d.get(j.id);
        return x && x.state === 'failed';
      },
      'B0c 落 failed',
    );
    await sleep(300);
    eq(cap.calls.length, 1, '不接管 ⇒ 只有 1 次 spawn');
    eq(cap.calls[0].includes('--model'), false, '命令行不带 --model');
    eq(d.list().length, 1, '没有顺序推进产生的新 job');
  });
}

async function scenarioB1() {
  await scenario('B1 失败推进：失败 ⇒ 按顺序 a→b→c 交接，3 项列表真的 spawn 3 次后停止', async () => {
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
    armSequential(d, 'opencode', { opencode: ['opencode/a', 'opencode/b', 'opencode/c'] });

    const a = d.dispatch({ kind: 'prompt', prompt: 'ZB-52 顺序派发失败推进（假执行器立即静默失败）' });
    eq(a.spec.model, 'opencode/a', '首轮 job 的 spec.model = 顺序列表第 1 个（新语义：dispatch 自动定位）');

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
    eq(bNow.attempts[1]?.hopReason, 'seq-model', '顺序交接的 hopReason = seq-model（与降级链 auto-fallback 区分：独立跳数预算）');

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
      'a 的 parseWarnings 记录「顺序派发: 第 2/3 个模型 opencode/opencode/b」（warning 写在失败的前一个 job 上）',
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
    eq(cNow0.attempts[3]?.hopReason, 'seq-model', 'c 的交接 hopReason 同样是 seq-model');

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

    /* ── ★ 回归钉：3 项顺序列表必须真的 spawn 3 次 ──
     * 修前 bug：advanceSequential 里 retry 建**新 job** 后没把 seqRuns 里的"当前项"移交给新 job
     * ⇒ 新 job 失败时查不到自己的 run ⇒ 提前交回降级链（主通道只试了 2/3 个就跳走）。
     * 断言同时覆盖：spawn 次数、命令行 --model、假执行器内部 marker、job 总数。 */
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
    eq(cap.calls.length, 3, '*★ 回归钉：3 项列表必须真的 spawn 3 次*（修前会在第 2 跳提前停）');
    eq(d.list().length, 3, '总 job 数 = 3（a/b/c）');

    /* 列表用尽后必须停：给一点宽限再复核（spawn 次数与 job 数都不许再涨） */
    const spawns = cap.calls.length;
    await sleep(250);
    eq(cap.calls.length, spawns, '列表用尽后不再 spawn（不无限重试）');
    eq(d.list().length, 3, '总 job 数仍 = 3（不再产生新 job）');
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
    armSequential(d, 'opencode', { opencode: ['opencode/a', 'opencode/b'] });
    const j = d.dispatch({ kind: 'prompt', prompt: 'ZB-52 config-error 不延续' });
    eq(j.spec.model, 'opencode/a', '首跳 = 顺序列表第一项');

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
      armSequential(d, 'opencode', { opencode: ['opencode/a', 'opencode/b'] });
      const a = d.dispatch({ kind: 'prompt', prompt: `ZB-52 paused 延续（${c.reason}）` });
      eq(a.spec.model, 'opencode/a', `${c.reason}: 首跳 = 顺序列表第一项（模型为空即顺序派发）`);
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
  await scenario('B4 顺序列表用尽 ⇒ 交回既有跨通道降级链（单目标也要生效）', async () => {
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
      /* 降级链可用性替身：只有 plan 可用 —— 不猜，走 core 的 listChannels 契约。 */
      channelsImpl: async () => ({
        channels: [{ id: 'plan', enabled: true }],
        warnings: [],
      }),
    });
    d.setFallbackChain(['plan']);
    /* ⚠️ 本用例**刻意只给 1 个降级目标**（`['plan']`），是**回归钉**：
     * ① 原先 core 的 maybeAutoFallback 用**共享的 hopCount** 与 `fallbackTargets.length` 比较封顶，
     *    而顺序交接也会让 hopCount +1 ⇒ 「降级目标数（1）≤ 顺序跳数（1）」时降级被"已达目标数上限"拦住；
     * ② 原先起点算错（`findIndex` 返回 -1 时 `startIdx+1=0` 却从 1 起找）⇒ **唯一的降级目标被静默跳过**。
     * 现实现：降级只数自己的跳数（hopReason='auto-fallback'），且当前通道不在目标列表时从**头**找。 */
    armSequential(d, 'opencode', { opencode: ['opencode/a', 'opencode/b'] });

    const a = d.dispatch({ kind: 'prompt', prompt: 'ZB-52 顺序用尽→降级链' });
    eq(a.spec.model, 'opencode/a', '首跳 = 顺序列表第一项');
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
      '顺序列表用尽后，降级链接手（新 job provider=plan；单目标也真的降了）',
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

    /* 降级链目标也暂停 ⇒ 1 个目标已用尽 ⇒ 停在 paused、不再跳 */
    await waitFor(
      () => {
        const x = d.get(fbRef.id);
        return x && x.state === 'paused';
      },
      '降级链 job 也 paused（quota）',
    );
    const fb = d.get(fbRef.id);
    eq(fb.state, 'paused', '降级链目标同样 quota 暂停 ⇒ 停在 paused（不再无限跳）');
    /* 判别「真实用尽」而非「被顺序跳数挤掉」：降级 job 的 attempts 里确有 auto-fallback 交接记录。 */
    const fbAttempts = Array.isArray(fb.attempts) ? fb.attempts : [];
    const fallbackHops = fbAttempts.filter((x) => x.hopReason === 'auto-fallback').length;
    ok(fallbackHops >= 1, `降级 job 上确有 auto-fallback 交接记录（实际 ${fallbackHops} 条）⇒ 降级真的发生过`);
    ok(
      fb.parseWarnings.some((w) => w.includes('已达目标数上限')),
      `★ 降级预算是「真实用尽」而非「被顺序跳数挤掉」（1 个目标 + 已用 ${fallbackHops} 条降级记录）`,
    );
    const jobsBefore = d.list().length;
    await sleep(250);
    eq(d.list().length, jobsBefore, '降级用尽后不再产生新 job');
    eq(jobsBefore, 3, '至少 a/b + 降级链 job 三个 job（实际恰好 3 个：a、b、plan）');
  });
}

async function scenarioB5() {
  await scenario('B5 ★ 降级目标也顺序派发：降到 qoder 时从列表第一项起跑，列表跑完才继续外层降级链', async () => {
    const dir = newTempDir();
    const workRoot = newTempDir();
    /* 三个引擎共用一个「quota 暂停」假执行器：本用例只关心调度次序，不跑任何真 CLI。 */
    const pause = makePauseRunner(dir, 'fake-pause-all.mjs', 'quota_exceeded: plan quota used up (429)');
    const cap = captureSpawn();
    const d = createDispatcher({
      runnerPath: pause,
      opencodeRunnerPath: pause,
      qoderRunnerPath: pause, // 必须显式给：否则 qoder 会落到默认真执行器
      workRoot,
      spawnImpl: cap.impl,
      maxConcurrent: 4,
      /* 外层降级链：qoder（目标 model 为空 ⇒ 该目标走 qoder 顺序列表）→ plan → ch-c（**不可用**）。
       * ch-c 设为不可用是为了让用例只钉「qoder 列表跑完 ⇒ 继续外层链的 plan」这一点：
       * 无论降级链封顶怎么算，plan 之后都必然停下（不依赖多跳预算细节，也不与其它回归钉耦合）。 */
      channelsImpl: async () => ({
        channels: [
          { id: 'qoder', enabled: true },
          { id: 'plan', enabled: true },
          { id: 'ch-c', enabled: false, reason: 'down' },
        ],
        warnings: [],
      }),
    });
    d.setFallbackChain([{ provider: 'qoder', model: '' }, { provider: 'plan' }, { provider: 'ch-c' }]);
    armSequential(d, 'opencode', { opencode: ['opencode/a'], qoder: ['qoder/Fast', 'qoder/Auto'] });

    const a = d.dispatch({ kind: 'prompt', prompt: 'ZB-52 降级目标也顺序' });
    eq(a.spec.model, 'opencode/a', '主通道首跳 = opencode 列表第一项');

    /* 主通道列表只有 1 项 ⇒ 马上用尽 ⇒ 降到 qoder 这个「顺序派发目标」的第一项 */
    const fastRef = await waitFor(
      () => d.list().find((j) => j.spec?.provider === 'qoder' && j.spec?.model === 'Fast') ?? null,
      '主通道列表用尽后降到 qoder 顺序列表第一项（Fast）',
      20000,
    );
    const fast0 = d.get(fastRef.id);
    eq(fast0.engine, 'qoder', 'qoder 目标引擎 = qoder');
    eq(fast0.spec.provider, 'qoder', 'qoder 目标 provider = 裸引擎名 qoder');
    eq(fast0.spec.model, 'Fast', 'qoder 顺序第一项经前缀规整后 = 裸模型名 Fast（CLI 契约）');
    eq(fast0.parentJobId, a.id, 'qoder 首项由主通道用尽后降级而来');
    ok(
      d.get(a.id).parseWarnings.some((w) => w.includes('该目标为顺序派发') && w.includes('共 2 个模型')),
      '主通道用尽时留 warning：该降级目标为顺序派发（共 2 个模型）',
    );
    await waitFor(() => cap.calls.length >= 2, 'qoder 首项 spawn');
    eq(argOf(cap.calls[1], '--model'), 'Fast', 'qoder 首项实际以 --model Fast 传给执行器');

    /* qoder 列表内部推进：Fast → Auto */
    const autoRef = await waitFor(
      () => d.list().find((j) => j.parentJobId === fastRef.id) ?? null,
      'qoder Fast 暂停后推进到列表第 2 项（Auto）',
      20000,
    );
    eq(autoRef.spec.model, 'Auto', 'qoder 列表第 2 项 = Auto');
    eq(autoRef.spec.provider, 'qoder', '仍在 qoder 引擎/通道内');
    ok(
      d.get(fastRef.id).parseWarnings.some((w) => w.includes('顺序派发: 第 2/2 个模型')),
      'qoder 列表内部推进有「第 2/2 个模型」warning',
    );

    /* qoder 列表用尽 ⇒ 才继续**外层**降级链（下一个可用目标 plan） */
    const planRef = await waitFor(
      () => d.list().find((j) => j.spec?.provider === 'plan') ?? null,
      'qoder 顺序列表跑完后继续外层降级链（plan）',
      25000,
    );
    eq(planRef.engine, 'zcode', '外层降级目标 plan 的引擎 = zcode');
    eq(planRef.parentJobId, autoRef.id, 'plan 是在 qoder 列表**最后一项**之后才出现的（列表跑完才继续外层链）');
    ok(
      d.get(autoRef.id).parseWarnings.some((w) => w.includes('顺序派发: 已试完 2 个模型')),
      'qoder 列表用尽 warning 在最后一跳上',
    );
    ok(
      d.get(autoRef.id).parseWarnings.some((w) => w.includes('fallback-chain')),
      'qoder 列表用尽后才留 fallback-chain 交接 warning（继续外层链）',
    );

    /* 全部落定后核对「实际执行次序」= opencode 列表 → qoder 列表（Fast/Auto 裸名）→ 外层目标（无模型） */
    await waitFor(
      () => d.list().length >= 4 && d.list().every((j) => j.state !== 'running' && j.state !== 'queued'),
      'B5 全部任务落定（a / qoder Fast / qoder Auto / plan）',
      25000,
    );
    await sleep(300);
    eq(
      cap.calls.map((args) => argOf(args, '--model') ?? null),
      ['opencode/a', 'Fast', 'Auto', null],
      '*★ 实际执行序列：opencode 列表 → qoder 列表（Fast/Auto 裸模型名）→ 外层降级目标（无模型）*',
    );
    eq(d.list().filter((j) => j.spec?.provider === 'ch-c').length, 0, '外层目标里的不可用通道（ch-c）被跳过，没有产生 job');
    eq(d.get(planRef.id).state, 'paused', '外层链目标也暂停 ⇒ 停住（不无限跳）');
    const jobsN = d.list().length;
    const spawnN = cap.calls.length;
    await sleep(250);
    eq(d.list().length, jobsN, '外层链停住后不再产生新 job');
    eq(cap.calls.length, spawnN, '外层链停住后不再 spawn');
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
  await scenarioB0();
  await scenarioB1();
  await scenarioB2();
  await scenarioB3();
  await scenarioB4();
  await scenarioB5();
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
