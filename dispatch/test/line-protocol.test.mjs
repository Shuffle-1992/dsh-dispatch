#!/usr/bin/env node
/**
 * 行协议契约锁（OpenCode 双引擎接入）—— **离线、零依赖、可复跑**。
 *
 * 守的是三份东西：
 *   ① `collab-kit/run-line-protocol.mjs`（已冻结的唯一权威）—— **硬断言**，任何不符即失败；
 *   ② `dispatch/core/dispatch-core.mjs` 的解析/管道 —— **宽松模式**：别人在并行开发，
 *      能力未落盘时打印 `[SKIP] <原因>`（绝不 FAIL 崩掉）；落盘后同一份文件自动转为硬断言。
 *   ③ 「除引擎差异字段外两种前缀逐字相同」不是口号 —— 用同一组行分别加两种前缀，逐字段比对。
 *
 * 严格模式：`DSP_OC_STRICT=1 node dispatch/test/line-protocol.test.mjs`
 *   ⇒ 所有 SKIP 转为硬断言（用于「实现都落盘了」之后的最终验收）。
 *
 * 退出码：有 FAIL（或严格模式下的 SKIP）→ 1；否则 0。
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PROTOCOL_PATH = join(ROOT, 'collab-kit', 'run-line-protocol.mjs');
const CORE_PATH = join(ROOT, 'dispatch', 'core', 'dispatch-core.mjs');
const FAKE_OC_RUNNER = join(HERE, 'fixtures', 'fake-opencode-runner.mjs');
const FAKE_ZCODE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs');
const STRICT = process.env.DSP_OC_STRICT === '1';

/* ---------------- 迷你断言框架（逐项显式、末尾汇总、失败即非 0） ---------------- */
let passCount = 0;
let skipCount = 0;
let failCount = 0;
const skipped = [];

const check = (name, fn) => {
  try {
    fn();
    passCount += 1;
    console.log(`[PASS] ${name}`);
  } catch (e) {
    failCount += 1;
    console.log(`[FAIL] ${name}\n        → ${e?.message ?? e}`);
  }
};
/** 宽松断言：skipReason 非空且非严格模式 ⇒ SKIP（打印原因）；严格模式 ⇒ 当真跑，失败即 FAIL。 */
const soft = (name, skipReason, fn) => {
  if (skipReason && !STRICT) {
    skipCount += 1;
    skipped.push({ name, reason: skipReason });
    console.log(`[SKIP] ${name}\n        → ${skipReason}`);
    return;
  }
  check(name, fn);
};
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (actual, expected, msg) => {
  if (actual !== expected) throw new Error(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
};
const deep = (actual, expected, msg) => {
  const a = canonJSON(actual);
  const b = canonJSON(expected);
  if (a !== b) throw new Error(`${msg}（期望 ${b}，实际 ${a}）`);
};
/** 键序无关的规范化 JSON（对象按 key 排序；数组保序）——避免"同一个对象、构造函数键序不同"被误判失败。 */
function canonJSON(v) {
  if (Array.isArray(v)) return `[${v.map(canonJSON).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonJSON(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const section = (t) => console.log(`\n=== ${t} ===`);

/* ---------------- 载入被测模块 ---------------- */
let P = null;
try {
  P = await import(pathToFileURL(PROTOCOL_PATH).href);
} catch (e) {
  console.log(`[FAIL] 载入 collab-kit/run-line-protocol.mjs\n        → ${e?.message ?? e}`);
  console.log('\n[行协议契约锁] 致命：协议模块（冻结件）无法载入，后续断言全部无法进行。');
  process.exit(1);
}
let core = null;
try {
  core = await import(pathToFileURL(CORE_PATH).href);
} catch (e) {
  core = { __loadError: e?.message ?? String(e) };
}
const parseRunnerLine = typeof core?.parseRunnerLine === 'function' ? core.parseRunnerLine : null;
const coreSrc = (() => { try { return readFileSync(CORE_PATH, 'utf8'); } catch { return ''; } })();

/** core 是否已"认得" opencode 前缀（行为探针，不猜实现细节）。 */
const coreOpenCodeProbe = (() => {
  if (!parseRunnerLine) return { ok: false, why: `core 未导出 parseRunnerLine（${core?.__loadError ?? '导出缺失'}）` };
  try {
    const r = parseRunnerLine(`${P.RUN_PREFIX.opencode} done exit=0 elapsed=1.0s session=sess_probe provider=opencode model=opencode/probe`, 'opencode');
    if (r && r.summarySeen === true) return { ok: true, why: '' };
    return {
      ok: false,
      why: `parseRunnerLine 对 [opencode-run] done 行返回 ${JSON.stringify(r)}（无 summarySeen ⇒ 新前缀未被识别）`,
    };
  } catch (e) {
    return { ok: false, why: `core.parseRunnerLine 在 opencode 行上抛错：${e?.message ?? e}` };
  }
})();
/* 探针只回答"新前缀是否被识别"；未识别 ⇒ 给出可读 SKIP 原因（并行开发期正常状态）。 */
const OC_NOT_WIRED_REASON = coreOpenCodeProbe.ok
  ? null
  : 'core 尚未接入 opencode 前缀（并行开发期预期状态；落盘后本项自动转硬断言）';

console.log(`[行协议契约锁] 协议=${PROTOCOL_PATH}`);
console.log(`[行协议契约锁] core=${CORE_PATH}`);
console.log(`[行协议契约锁] core 探测：${coreOpenCodeProbe.ok ? 'opencode 前缀已识别' : `opencode 前缀尚未识别 —— ${coreOpenCodeProbe.why}`}`);
console.log(`[行协议契约锁] 模式=${STRICT ? '严格（SKIP 即失败）' : '宽松（能力缺失记 SKIP）'}`);

/* ================= ① 协议模块自身（硬断言：已冻结、已存在） ================= */
section('① run-line-protocol.mjs 自身（硬断言）');

check('①-1 ENGINES 恰好是 [zcode, opencode, qoder, codebuddy] 且顺序固定', () => {
  /* ZB-51：加入第三个引擎 qoder（通道形态 `qoder/<model>`）。
   * ZB-84：加入第四个引擎 codebuddy（通道形态 `codebuddy/<model>`）。
   * 顺序即优先级，**末尾追加**不改既有语义（默认引擎仍是 zcode）。 */
  deep([...P.ENGINES], ['zcode', 'opencode', 'qoder', 'codebuddy'], 'ENGINES 必须恰好是这四台引擎（顺序即优先级）');
  ok(Array.isArray(P.ENGINES), 'ENGINES 必须是数组');
});
check('①-2 DEFAULT_ENGINE 是 zcode', () => eq(P.DEFAULT_ENGINE, 'zcode', '默认引擎必须保持 zcode'));
check('①-3 RUN_PREFIX 每个引擎都有前缀', () => {
  eq(P.RUN_PREFIX.zcode, '[zcode-run]', 'zcode 前缀');
  eq(P.RUN_PREFIX.opencode, '[opencode-run]', 'opencode 前缀');
  eq(P.RUN_PREFIX.qoder, '[qoder-run]', 'qoder 前缀');
  /* 键集合必须与 ENGINES 一一对应 —— 这条是"加了引擎却忘了加前缀"的守门人。 */
  const keys = Object.keys(P.RUN_PREFIX).sort().join(',');
  eq(keys, [...P.ENGINES].sort().join(','), 'RUN_PREFIX 的键集合必须与 ENGINES 完全一致');
});
check('①-4 prefixFor("nonsense") 回退默认前缀 [zcode-run]', () => {
  eq(P.prefixFor('nonsense'), '[zcode-run]', '未知引擎必须回退默认前缀');
  eq(P.prefixFor('opencode'), '[opencode-run]', '已知引擎取自己的前缀');
  eq(P.prefixFor(undefined), '[zcode-run]', 'undefined 回退默认前缀');
  eq(P.prefixFor('  OPENCODE  '), '[opencode-run]', '大小写/空白应被归一');
});
check('①-5 isOpenCodeId 判据（opencode/x=true；plan=false；opencode/=false）', () => {
  eq(P.isOpenCodeId('opencode/x'), true, "isOpenCodeId('opencode/x')");
  eq(P.isOpenCodeId('plan'), false, "isOpenCodeId('plan')");
  eq(P.isOpenCodeId('opencode/'), false, "isOpenCodeId('opencode/')（斜杠后必须有模型名）");
  eq(P.isOpenCodeId('opencode/deepseek-v4.1-flash-free'), true, '真实免费模型 id');
  eq(P.isOpenCodeId('zcode/x'), false, 'zcode 前缀不算 opencode 通道');
  eq(P.isOpenCodeId(null), false, 'null 必须安全');
});
check('①-6 RUNNER_BASENAME / 行语法说明齐备', () => {
  eq(P.RUNNER_BASENAME.opencode, 'opencode-run.mjs', 'opencode 执行器候选文件名');
  eq(P.RUNNER_BASENAME.zcode, 'zcode-run.mjs', 'zcode 执行器候选文件名');
  ok(typeof P.LINE_GRAMMAR_NOTE === 'string' && P.LINE_GRAMMAR_NOTE.length > 0, 'LINE_GRAMMAR_NOTE 必须是非空字符串');
});
check('①-7 default export 与具名导出一致（两处不得漂移）', () => {
  const d = P.default;
  ok(d && typeof d === 'object', 'default export 必须是对象');
  deep([...d.ENGINES], [...P.ENGINES], 'default.ENGINES');
  eq(d.DEFAULT_ENGINE, P.DEFAULT_ENGINE, 'default.DEFAULT_ENGINE');
  deep({ ...d.RUN_PREFIX }, { ...P.RUN_PREFIX }, 'default.RUN_PREFIX');
  deep({ ...d.RUNNER_BASENAME }, { ...P.RUNNER_BASENAME }, 'default.RUNNER_BASENAME');
  eq(d.normalizeEngine, P.normalizeEngine, 'default.normalizeEngine');
  eq(d.prefixFor, P.prefixFor, 'default.prefixFor');
  eq(d.isOpenCodeId, P.isOpenCodeId, 'default.isOpenCodeId');
  eq(d.inferEngine, P.inferEngine, 'default.inferEngine');
  eq(d.normalizeEngineSpec, P.normalizeEngineSpec, 'default.normalizeEngineSpec');
});

/* ================= ② normalizeEngineSpec（硬断言） ================= */
section('② normalizeEngineSpec（硬断言）');

check('②-1 {provider:"opencode/m"} ⇒ {engine:opencode, provider:opencode, model:"opencode/m"}', () => {
  const out = P.normalizeEngineSpec({ provider: 'opencode/m' });
  deep(out, { engine: 'opencode', provider: 'opencode', model: 'opencode/m' }, '规整三元组');
});
check('②-2 显式 model 优先（provider=opencode/m + model=other ⇒ 保留 other）', () => {
  const out = P.normalizeEngineSpec({ provider: 'opencode/m', model: 'other' });
  eq(out.engine, 'opencode', 'engine');
  eq(out.provider, 'opencode', 'provider 被规整为 opencode');
  eq(out.model, 'other', '显式 model 必须优先于从 provider 拆出的 id');
});
check('②-3 {provider:"plan"} ⇒ engine:zcode 且 provider 不变', () => {
  const out = P.normalizeEngineSpec({ provider: 'plan' });
  eq(out.engine, 'zcode', 'engine');
  eq(out.provider, 'plan', 'provider 必须原样保留');
  ok(!('model' in out), `不得凭空补 model（实际 ${JSON.stringify(out)}）`);
});
check('②-4 幂等：对结果再跑一次，逐字相等', () => {
  const cases = [
    { provider: 'opencode/m' },
    { provider: 'opencode/m', model: 'other' },
    { provider: 'plan' },
    { provider: 'plan', model: 'GLM-5.3' },
    { engine: 'opencode', provider: 'opencode', model: 'opencode/m' },
    {},
  ];
  for (const c of cases) {
    const once = P.normalizeEngineSpec(c);
    const twice = P.normalizeEngineSpec(once);
    deep(twice, once, `幂等性（输入 ${JSON.stringify(c)}）`);
  }
});
check('②-5 不修改入参（原对象快照不变）', () => {
  for (const c of [{ provider: 'opencode/m' }, { provider: 'plan' }, { engine: 'opencode', provider: 'x' }]) {
    const before = JSON.stringify(c);
    P.normalizeEngineSpec(c);
    eq(JSON.stringify(c), before, `入参被就地修改（${before}）`);
  }
});

/* ================= ③ inferEngine（硬断言） ================= */
section('③ inferEngine（硬断言）');

check('③-1 显式合法 engine 优先', () => {
  eq(P.inferEngine({ engine: 'opencode', provider: 'plan' }), 'opencode', '显式 opencode 压过 zcode 形状的 provider');
  eq(P.inferEngine({ engine: 'zcode', provider: 'opencode/x' }), 'zcode', '显式 zcode 优先（调用方应先用 normalizeEngineSpec 消除矛盾）');
  eq(P.inferEngine({ engine: ' OPENCODE ' }), 'opencode', '显式值应归一（大小写/空白）');
});
check('③-2 opencode/… provider 判 opencode', () => {
  eq(P.inferEngine({ provider: 'opencode/glm-5.3-flash-free' }), 'opencode', 'opencode/ 形状的 provider');
});
check('③-3 其余（含非法 engine / 空）判 zcode', () => {
  eq(P.inferEngine({ provider: 'plan' }), 'zcode', '普通通道');
  eq(P.inferEngine({ provider: 'personal' }), 'zcode', 'personal 通道');
  eq(P.inferEngine({ engine: 'nonsense', provider: 'opencode/x' }), 'opencode', '非法 engine 视为未给，继续按 provider 推断');
  eq(P.inferEngine({}), 'zcode', '空对象');
  eq(P.inferEngine(undefined), 'zcode', 'undefined');
  eq(P.inferEngine(null), 'zcode', 'null');
});

/* ================= ④⑤⑥ core 解析（宽松：core 未落盘则 SKIP） ================= */
section('④ 同一组行 × 两种前缀 ⇒ 逐字段相等（宽松：依赖 core）');

/** progress 行会带 `lastProgressAt`（Date.now()），两次调用必不同 —— 它不是协议差异，比对时剔除。 */
const VOLATILE_KEYS = new Set(['lastProgressAt']);
const strip = (o) => {
  if (o == null || typeof o !== 'object') return o;
  const out = {};
  for (const k of Object.keys(o)) if (!VOLATILE_KEYS.has(k)) out[k] = o[k];
  return out;
};
const canon = (o) => canonJSON(strip(o));

/** 任务书钉死的 8 条公共行（两种引擎语法逐字相同）。 */
const SHARED_LINES = [
  ['done', (p) => `${p} done exit=0 elapsed=1.2s session=sess_x provider=opencode model=opencode/m responseChars=2`],
  ['usage', (p) => `${p} usage requests=1 in=100 out=50 cacheRead=10`],
  ['context', (p) => `${p} context used=1234 (0.6% of 200000) turnCount=2`],
  ['progress', (p) => `${p} progress stage=waiting-turn elapsed=3s chars=1024 tools=1 lastTool=write stageAgo=2s session=sess_x`],
  ['out', (p) => `${p} out=C:\\fake dir with space\\run.out.log`],
  ['err', (p) => `${p} err=C:\\fake dir with space\\run.err.log`],
  ['result', (p) => `${p} result=C:\\fake dir with space\\run.result.json`],
  ['memory-ban', (p) => `${p} memory-ban=on（已在提示词末尾注入记忆禁令）`],
];
/** 补充组：同类公共行（endpoint/start/resume/provider），同样必须两前缀一致。 */
const SHARED_LINES_EXTRA = [
  ['endpoint', (p) => `${p} endpoint=https://fake.example/api`],
  ['start', (p) => `${p} tag=fake mode=edit cwd=C:\\proj`],
  ['resume', (p) => `${p} resume=sess_x`],
  ['provider', (p) => `${p} provider=opencode model=opencode/m`],
];

for (const [label, mk] of [...SHARED_LINES, ...SHARED_LINES_EXTRA]) {
  soft(`④ ${label}：两种前缀解析结果逐字段相等`, OC_NOT_WIRED_REASON, () => {
    const z = parseRunnerLine(mk(P.RUN_PREFIX.zcode), 'zcode');
    const o = parseRunnerLine(mk(P.RUN_PREFIX.opencode), 'opencode');
    ok(z != null && o != null, `${label} 行必须被识别（zcode=${canon(z)}，opencode=${canon(o)}）；带已知前缀但识别失败应为 null 并记 warning`);
    ok(Object.keys(z).length > 0 && Object.keys(o).length > 0, `${label} 行解析结果不得为空对象（说明前缀被当普通行吞掉）`);
    deep(strip(o), strip(z), `${label} 行在两种前缀下的字段（已剔除易变字段 ${[...VOLATILE_KEYS].join(',')}；原始：zcode=${canon(z)} opencode=${canon(o)}）`);
  });
}

section('⑤ 引擎差异字段（宽松：依赖 core）');

soft('⑤-1 variants ⇔ reasoning-levels 落到同一个字段', OC_NOT_WIRED_REASON, () => {
  const zLine = `${P.RUN_PREFIX.zcode} reasoning-levels m=high,max`;
  const oLine = `${P.RUN_PREFIX.opencode} variants m=high,max`;
  const via = (line) => {
    const r = parseRunnerLine(line, line.startsWith(P.RUN_PREFIX.opencode) ? 'opencode' : 'zcode');
    if (r != null && Object.keys(r).length > 0) return { field: 'parseRunnerLine', value: r };
    const t = typeof core.parseProviderTable === 'function' ? core.parseProviderTable(line) : null;
    if (t && Object.keys(t.modelLevels ?? {}).length > 0) return { field: 'parseProviderTable.modelLevels', value: t.modelLevels };
    return { field: null, value: null };
  };
  const z = via(zLine);
  const o = via(oLine);
  ok(z.value != null, `zcode 基线行没被任何入口解析出档位表：${zLine}`);
  ok(o.value != null, `opencode 差异行没被解析出档位表：${oLine}（core 未镜像 variants 行）`);
  eq(o.field, z.field, `两种前缀必须落到同一个字段（zcode→${z.field}，opencode→${o.field}）`);
  deep(o.value, z.value, '差异行解析出的值必须相同（同一个 m=high,max）');
});

soft('⑤-2 variant=… model=… ⇒ reasoningLevelApplied + reasoningTarget 含 model', OC_NOT_WIRED_REASON, () => {
  const model = 'opencode/deepseek-v4.1-flash-free';
  const line = `${P.RUN_PREFIX.opencode} variant=high model=${model}`;
  const r = parseRunnerLine(line, 'opencode');
  ok(r != null, `该行必须被识别（不是 null）：${line}`);
  eq(r.reasoningLevelApplied, 'high', 'reasoningLevelApplied 必须取到 variant 值（与 zcode 的 reasoning-level 同字段）');
  ok(typeof r.reasoningTarget === 'string' && r.reasoningTarget.includes(model), `reasoningTarget 必须含 model（实际 ${JSON.stringify(r.reasoningTarget)}）`);
  /* 与 zcode 类比：字段集合必须一致（不得因引擎不同而换字段名）。 */
  const z = parseRunnerLine(`${P.RUN_PREFIX.zcode} reasoning-level=high target=plan/${model}`, 'zcode');
  ok(z != null, 'zcode 类比行必须可解析（基线）');
  deep(Object.keys(r).sort(), Object.keys(z).sort(), '差异行与 zcode 类比行的字段名集合必须一致');
});

section('⑥ 兼容语义（zcode 语义硬断言；opencode 语义依赖 core）');

check("⑥-1 parseRunnerLine('[zcode-run] 乱七八糟') === null（已知前缀 + 识别失败）", () => {
  ok(parseRunnerLine != null, `core 未导出 parseRunnerLine（${core?.__loadError ?? '导出缺失'}）`);
  eq(parseRunnerLine(`${P.RUN_PREFIX.zcode} 乱七八糟`), null, '带 [zcode-run] 前缀但格式未登记 ⇒ null');
});
soft("⑥-2 parseRunnerLine('[opencode-run] 乱七八糟') === null", OC_NOT_WIRED_REASON, () => {
  eq(parseRunnerLine(`${P.RUN_PREFIX.opencode} 乱七八糟`), null, '带 [opencode-run] 前缀但格式未登记 ⇒ null');
});
check("⑥-3 parseRunnerLine('普通输出') 为 {}（无已知前缀视作普通行）", () => {
  ok(parseRunnerLine != null, 'core 未导出 parseRunnerLine');
  deep(parseRunnerLine('普通输出'), {}, '无已知前缀的普通行必须返回空对象（不是 null）');
  deep(parseRunnerLine(''), {}, '空行同样是普通行');
});
check("⑥-4 opencode 行 + engine='zcode' ⇒ 按普通行处理（{}，不是 null）", () => {
  ok(parseRunnerLine != null, 'core 未导出 parseRunnerLine');
  const r = parseRunnerLine(`${P.RUN_PREFIX.opencode} done exit=0 elapsed=1.0s provider=opencode model=opencode/m`, 'zcode');
  deep(r, {}, '显式 zcode 引擎下，opencode 行不得被识别、也不得算「前缀识别失败」');
});
check('⑥-5 未知 engine 值不抛错（回退"两个前缀都试"）', () => {
  ok(parseRunnerLine != null, 'core 未导出 parseRunnerLine');
  let r;
  try {
    r = parseRunnerLine(`${P.RUN_PREFIX.zcode} usage requests=1 in=1 out=1 cacheRead=0`, 'nonsense');
  } catch (e) {
    throw new Error(`未知 engine 必须安全回退而不是抛错：${e?.message ?? e}`);
  }
  ok(r != null, '未知 engine 下 zcode 公共行仍应被识别（回退到默认引擎）');
});

/* ================= ⑦ 协议 ⇄ core 镜像一致性（防漂移） ================= */
section('⑦ 协议文件与 core 的镜像一致性（防漂移）');

const literalPrefixes = new Set([...coreSrc.matchAll(/\[(?:zcode|opencode)-run\]/g)].map((m) => m[0]));
const coreImportsProtocol = /run-line-protocol/.test(coreSrc);
const mirrorSkipReason = (coreImportsProtocol || literalPrefixes.has(P.RUN_PREFIX.opencode))
  ? null
  : 'core 源码里尚未出现 opencode 前缀（当前只有 [zcode-run]），协议⇄core 镜像暂无可断言 —— 并行开发期预期状态';

soft('⑦-1 core 覆盖 RUN_PREFIX 的每一个前缀', mirrorSkipReason, () => {
  const covered = new Set(literalPrefixes);
  if (coreImportsProtocol) for (const p of Object.values(P.RUN_PREFIX)) covered.add(p);
  const missing = Object.entries(P.RUN_PREFIX)
    .filter(([, p]) => !covered.has(p))
    .map(([engine, p]) => `${engine}(${p})`);
  ok(missing.length === 0,
    `core 未覆盖这些前缀：${missing.join(',')} —— 源码字面量=[${[...literalPrefixes].join(',')}]`
    + `${coreImportsProtocol ? '；已 import run-line-protocol' : '；未 import run-line-protocol'}`);
});
soft('⑦-2 不得"硬编码只认 zcode"（opencode 字面量缺失 ⇔ 必须从协议模块取前缀）', mirrorSkipReason, () => {
  const hardcodedOnlyZcode = literalPrefixes.has(P.RUN_PREFIX.zcode) && !literalPrefixes.has(P.RUN_PREFIX.opencode);
  ok(!hardcodedOnlyZcode || coreImportsProtocol,
    'core 里硬编码了 [zcode-run] 却没有任何 opencode 前缀来源（既无字面量、也未 import run-line-protocol）');
});
/* 信息行（不算失败）：core 已是双前缀来源，但仍有 zcode 硬编码正则 —— 层内双来源有漂移风险，提醒守门人复核。 */
if (coreImportsProtocol && literalPrefixes.has(P.RUN_PREFIX.zcode) && !literalPrefixes.has(P.RUN_PREFIX.opencode)) {
  console.log('        [WARN] core 已 import run-line-protocol，但源码里仍有 [zcode-run] 字面量（正则/RES 镜像）且无 [opencode-run] —— 请复核是否两条路径都能覆盖 opencode（本锁只断言覆盖，不裁决实现风格）');
}

/* ================= ⑧ 引擎管道接口（宽松：core 未落盘则 SKIP） ================= */
section('⑧ core 引擎管道（宽松：依赖 core）');

const pipeSkipReason = /opencode/i.test(coreSrc)
  ? null
  : 'core 源码尚未出现 opencode（引擎管道未落盘）—— 并行开发期预期状态';

soft('⑧-1 新增 createDispatcher 选项 opencodeRunnerPath / maxConcurrentOpenCode', pipeSkipReason, () => {
  ok(/opencodeRunnerPath/.test(coreSrc), 'core 源码里没有 opencodeRunnerPath（执行器路径不可注入 ⇒ OpenCode 通道无法用假执行器测试）');
  ok(/maxConcurrentOpenCode/.test(coreSrc), 'core 源码里没有 maxConcurrentOpenCode（OpenCode 并发上限，免费层按 IP 限流，必须与 ZCode 分开计数）');
});

if (pipeSkipReason == null) {
  /* 行为验证：listChannels 每个通道带 engine，顶层带 engines。 */
  const workRoot = mkdtempSync(join(tmpdir(), 'lp-core-'));
  try {
    const d = core.createDispatcher({
      workRoot,
      runnerPath: FAKE_ZCODE_RUNNER,
      opencodeRunnerPath: FAKE_OC_RUNNER,
      maxConcurrentOpenCode: 1,
      channelsProbeImpl: async () => '',
    });
    let res = null;
    let err = null;
    try {
      res = await d.listChannels();
    } catch (e) {
      err = e;
    }
    check('⑧-2 listChannels() 返回每个 channel 带 engine、顶层带 engines', () => {
      if (err) throw new Error(`listChannels() 抛错：${err?.message ?? err}`);
      const channels = Array.isArray(res) ? res : (res?.channels ?? []);
      const engines = Array.isArray(res) ? [] : (res?.engines ?? null);
      ok(Array.isArray(engines), `顶层必须带 engines 数组（实际键=${JSON.stringify(Object.keys(res ?? {}))}）`);
      ok(engines.includes('opencode'), `engines 必须含 opencode（实际 ${JSON.stringify(engines)}）`);
      const noEngine = channels.filter((c) => !c || c.engine == null);
      ok(noEngine.length === 0, `有 ${noEngine.length} 个 channel 缺 engine 字段：${JSON.stringify(noEngine.slice(0, 3))}`);
    });
  } catch (e) {
    check('⑧-2 listChannels() 返回每个 channel 带 engine、顶层带 engines', () => {
      throw new Error(`createDispatcher 无法构造（core 已认 opencode ⇒ 这是真缺口）：${e?.message ?? e}`);
    });
  } finally {
    try { rmSync(workRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
} else {
  soft('⑧-2 listChannels() 返回每个 channel 带 engine、顶层带 engines', pipeSkipReason, () => {});
}

/* ================= ⑨ 派发 spec 规整（宽松：core 未落盘则 SKIP） ================= */
section('⑨ dispatch({provider:"opencode/<model>"}) spec 规整（宽松：依赖 core + 假执行器）');

if (pipeSkipReason == null) {
  const workRoot = mkdtempSync(join(tmpdir(), 'lp-spec-'));
  try {
    const d = core.createDispatcher({
      workRoot,
      runnerPath: FAKE_ZCODE_RUNNER,
      opencodeRunnerPath: FAKE_OC_RUNNER,
      maxConcurrentOpenCode: 1,
      channelsProbeImpl: async () => '',
    });
    let job = null;
    let err = null;
    try {
      let out = d.dispatch({ kind: 'prompt', provider: 'opencode/glm-5.3-flash-free', prompt: 'PONG' });
      if (out && typeof out.then === 'function') out = await out;
      const id = out?.id ?? out?.job?.id;
      ok(id, `dispatch 必须返回带 id 的 job（实际 ${JSON.stringify(out)?.slice(0, 200)}）`);
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        const j = d.get(id);
        if (j && ['done', 'failed', 'killed', 'interrupted', 'paused'].includes(j.state)) { job = j; break; }
        await new Promise((r) => setTimeout(r, 25));
      }
      ok(job, '等待 job 落地超时（15s）');
    } catch (e) {
      err = e;
    }
    check('⑨-1 spec 规整为 {engine:opencode, provider:opencode, model:"opencode/<model>"} 且跑完', () => {
      if (err) throw new Error(`dispatch 抛错：${err?.message ?? err}`);
      eq(job.spec?.engine, 'opencode', 'job.spec.engine');
      eq(job.spec?.provider, 'opencode', 'job.spec.provider（应为规整后的裸引擎名）');
      eq(job.spec?.model, 'opencode/glm-5.3-flash-free', 'job.spec.model（保留完整模型 id）');
      eq(job.state, 'done', `假 opencode 执行器应让任务落地 done（实际 ${job.state}；tail=${JSON.stringify((job.tailLines ?? []).slice(-2))}）`);
    });
  } catch (e) {
    check('⑨-1 spec 规整为 {engine:opencode, provider:opencode, model:"opencode/<model>"} 且跑完', () => {
      throw new Error(`无法构造 dispatcher（core 已认 opencode ⇒ 这是真缺口）：${e?.message ?? e}`);
    });
  } finally {
    try { rmSync(workRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
} else {
  soft('⑨-1 spec 规整为 {engine:opencode, provider:opencode, model:"opencode/<model>"} 且跑完', pipeSkipReason, () => {});
}

/* ---------------- 汇总 ---------------- */
console.log('\n================ 汇总 ================');
if (skipped.length) {
  /* 同因合并（SKIP 往往成片出现：一个能力未落盘 ⇒ 一组断言同时跳过） */
  const byReason = new Map();
  for (const s of skipped) {
    if (!byReason.has(s.reason)) byReason.set(s.reason, []);
    byReason.get(s.reason).push(s.name);
  }
  console.log(`SKIP 清单（${skipped.length} 项，宽松模式下不计失败）：`);
  for (const [reason, names] of byReason) {
    console.log(`  · 原因：${reason}`);
    for (const n of names) console.log(`      - ${n}`);
  }
}
console.log(`[行协议契约锁] ${passCount + failCount + skipCount} 项：PASS ${passCount} / FAIL ${failCount} / SKIP ${skipCount}`);
if (STRICT && skipCount) console.log('[行协议契约锁] 严格模式：SKIP 视为失败（请把对应能力落盘后重跑）');
process.exit(failCount > 0 || (STRICT && skipCount > 0) ? 1 : 0);
