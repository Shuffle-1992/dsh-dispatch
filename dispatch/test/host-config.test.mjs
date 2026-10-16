/**
 * host-config —— 双引擎（ZCode + OpenCode）Host 侧**配置 / 契约哨兵**（离线，不触网、不 spawn）。
 *
 * 覆盖本轮 Host 半边（`dispatch/index.js` + `dispatch/bin/dispatch.mjs`）的新增契约：
 *   ① `FIELDS`（配置字段唯一事实源）里新增 `maxConcurrentOpenCode`（def 2）与 `opencodeRunnerPath`（def ''），
 *      且**只声明一处**（`DEFAULTS` / `normalizeConfig` / 两条 schema 路径全部由它派生）；
 *   ② `normalizeConfig` 语义不变：**非法值 = warn + 安全默认，绝不抛、绝不返回 issues**
 *      （否则 cordis `resolveConfig` 直接 throw ⇒ 整个插件不激活，见 index.js:55-63 与 hardening.test.mjs A2）；
 *   ③ `Config['~standard'].validate` 契约照常可跑（Standard Schema v1，别踩 pitfalls.md 的启动事故）；
 *   ④ 工具 schema 新增 `engine` 且**不是 enum**（ZB-37 纪律：合法取值随清单/版本变，权威来源是
 *      `action=channels` 的 `channels[].engine`）；`provider` 描述提到 `opencode/<model>` 通道形态；
 *   ⑤ `bin/dispatch.mjs` 的 `--engine` 在用法注释与参数解析里都出现（源码锁，照既有测试风格）。
 *
 * 命名与术语：插件 `DSH 派发台`、工具 `dispatch`、执行器 `collab-kit/opencode-run.mjs`、引擎 id `zcode`/`opencode`。
 *
 * 为什么部分断言用「读源码 + 正则」：`FIELDS` / `TOOL_PARAMETERS` 都在 index.js 内部、未导出；
 * 直接 import 只拿得到 `Config` 与 `apply`。仓库既有先例（single-source.test.mjs 的源码锁范式）同款。
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(PKG, f), 'utf8');
const INDEX_SRC = read('index.js');
const CLI_SRC = read('bin/dispatch.mjs');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log(`  ✓ ${m}`); };

/** 取 `FIELDS` 里的一个字段条目（形如 `{ name: 'x', type: …, def: …, desc: '…' }`；描述里不含 `}`）。 */
function fieldEntries(name) {
  return [...INDEX_SRC.matchAll(new RegExp(`\\{ name: '${name}',([^}]*)\\}`, 'g'))].map((m) => m[0]);
}

/* ---------------- ① FIELDS：两个新字段（唯一事实源） ---------------- */
console.log('① FIELDS 新增字段（配置字段唯一事实源）');
{
  const f1 = fieldEntries('maxConcurrentOpenCode');
  ok(f1.length === 1, `maxConcurrentOpenCode 在 FIELDS 里**只声明一处**（实际 ${f1.length} 处）`);
  ok(/type: 'number'/.test(f1[0]), "…type='number'");
  ok(/def: 2\b/.test(f1[0]), '…默认值 def=2（免费层按 IP 限流 ⇒ 独立且更低的并发）');
  ok(/min: 1\b/.test(f1[0]) && /max: 8\b/.test(f1[0]), '…带 min=1 / max=8 边界（与 maxConcurrent 同风格）');
  ok(/OpenCode/.test(f1[0]) && /全局上限/.test(f1[0]), '…desc 说明「OpenCode 独立并发」且 `maxConcurrent` 仍是全局上限');

  const f2 = fieldEntries('opencodeRunnerPath');
  ok(f2.length === 1, `opencodeRunnerPath 在 FIELDS 里**只声明一处**（实际 ${f2.length} 处）`);
  ok(/type: 'string'/.test(f2[0]), "…type='string'");
  ok(/def: ''/.test(f2[0]), "…默认值 def=''（默认推断，不写死机器专有路径）");
  ok(!/[A-Za-z]:[\\/]/.test(f2[0]), '★ 默认值里**没有盘符路径**（机器专有路径属部署配置，由 profile patch 覆盖）');
  ok(/opencode-run\.mjs/.test(f2[0]), '…desc 指明执行器 `<本仓库>/collab-kit/opencode-run.mjs`');
  ok(/DSP_OPENCODE_RUNNER/.test(f2[0]), '…desc 写明留空时的默认推断（env DSP_OPENCODE_RUNNER → 仓库内脚本）');

  // 派生关系照旧（本次只在 FIELDS 加条目，别处不得手写这两个字段）
  ok(/const DEFAULTS = Object\.fromEntries\(FIELDS\.map\(\(f\) => \[f\.name, f\.def\]\)\)/.test(INDEX_SRC),
    'DEFAULTS 仍由 FIELDS 派生（没有第二份默认值表）');
  ok(/for \(const f of FIELDS\) shape\[f\.name\] = build\[f\.type\]\(f\)\.description\(f\.desc\)/.test(INDEX_SRC),
    'schemastery schema 仍由 FIELDS 派生');
  ok(/for \(const f of FIELDS\) \{/.test(INDEX_SRC), 'normalizeConfig 仍遍历 FIELDS（归一则单源）');
  ok(!/maxConcurrentOpenCode\s*[:=]\s*2/.test(INDEX_SRC.replace(/\{ name: 'maxConcurrentOpenCode'[^}]*\}/, '')),
    '★ FIELDS 之外没有第二处硬写 `maxConcurrentOpenCode = 2`');
}

/* ---------------- ②③ Config：非法值不抛 + Standard Schema 契约 ---------------- */
console.log('\n②③ Config 契约（非法值 warn + 安全默认；~standard.validate 可跑）');
{
  const { Config } = await import(new URL('../index.js', import.meta.url).href);
  ok(typeof Config?.['~standard']?.validate === 'function', 'Config 是 Standard Schema v1（~standard.validate 可调用）');

  const empty = Config['~standard'].validate({});
  ok(empty.issues === undefined, '空配置不返回 issues');
  ok(empty.value.maxConcurrentOpenCode === 2, '空配置 ⇒ maxConcurrentOpenCode 取默认 2');
  ok(empty.value.opencodeRunnerPath === '', "空配置 ⇒ opencodeRunnerPath 取默认 ''");
  ok(empty.value.maxConcurrent === 3, '既有字段默认值不受影响（maxConcurrent=3）');

  let threw = null;
  let bad = null;
  try {
    bad = Config['~standard'].validate({ maxConcurrentOpenCode: 0, opencodeRunnerPath: 123 });
  } catch (e) { threw = e; }
  ok(threw === null, `★ 非法值**不抛**（抛了就是 cordis 激活事故；实际 ${threw ? threw.message : '未抛'}）`);
  ok(bad.issues === undefined, '★ 非法值**不返回 issues**（issues ⇒ cordis resolveConfig throw ⇒ 插件 INACTIVE）');
  ok(bad.value.maxConcurrentOpenCode === 1, 'maxConcurrentOpenCode=0 → 夹到下限 min=1（不是回落 def）');
  ok(bad.value.opencodeRunnerPath === '', 'opencodeRunnerPath=123（非字符串）→ 安全默认空串');

  const str = Config['~standard'].validate({ maxConcurrentOpenCode: 'x' });
  ok(str.value.maxConcurrentOpenCode === 2, "maxConcurrentOpenCode='x'（非数字）→ 安全默认 2");

  const over = Config['~standard'].validate({ maxConcurrentOpenCode: 99, opencodeRunnerPath: 'C:\\x\\opencode-run.mjs' });
  ok(over.value.maxConcurrentOpenCode === 8, 'maxConcurrentOpenCode=99 → 夹到上限 max=8');
  ok(over.value.opencodeRunnerPath === 'C:\\x\\opencode-run.mjs', '合法字符串原样保留');

  // 回归：既有字段的归一半径未被本次改动带偏
  const legacy = Config['~standard'].validate({ maxConcurrent: 0, maxConsecutiveWakes: 2.5, demo: 'yes' });
  ok(legacy.value.maxConcurrent === 1 && legacy.value.maxConsecutiveWakes === 2 && legacy.value.demo === false,
    '既有字段归一半径不变（maxConcurrent 0→1 / maxConsecutiveWakes 2.5→2 / demo 字符串→false）');
}

/* ---------------- ④ agent 工具 schema：engine（非 enum）+ provider 描述 ---------------- */
console.log('\n④ 工具 schema（engine 非 enum；provider desc 含 opencode/）');
{
  const block = INDEX_SRC.match(/const TOOL_PARAMETERS = \{([\s\S]*?)\n\};/);
  ok(!!block, '能从 index.js 取出 TOOL_PARAMETERS 字面量块');
  const body = block[1];

  const eng = body.match(/\bengine: \{([\s\S]*?)\}/);
  ok(!!eng, '工具 schema 已有 `engine` 参数');
  ok(/type: 'string'/.test(eng[1]), "engine 是 optional string（无 required）");
  ok(!/\benum:\s*\[/.test(eng[1]), '★ `engine` **不用 enum**（ZB-37 纪律：enum 会挡住清单里枚举外的真实取值）');
  ok(/zcode/.test(eng[1]) && /opencode/.test(eng[1]), 'engine desc 说明取值为 zcode | opencode');
  ok(/不用传|不必传/.test(eng[1]) && /provider/.test(eng[1]),
    'engine desc 说明通常不用传（传 provider: opencode/<model> 即自动识别）');

  const prov = body.match(/\bprovider: \{([\s\S]*?)\}/);
  ok(!!prov, '仍能取到 provider 参数');
  ok(prov[1].includes('opencode/'), '★ provider desc 含 `opencode/` 免费模型通道形态');
  ok(/action=channels/.test(prov[1]), 'provider desc 仍指向 action=channels 作为权威清单');

  // 双引擎教学文本（增量不删既有 ZCode 说明）
  ok(/opencode\/<model>/.test(INDEX_SRC), 'action=dispatch 长描述提到 `opencode/<model>`');
  ok(/--auto/.test(INDEX_SRC), '说明 OpenCode 不支持 `--auto`（子代理不会自动放行所有权限）');
  ok(/不\*\*支持\*\* `mode` \/ `memoryBench`|不支持.*mode.*memoryBench/.test(INDEX_SRC),
    '说明 `mode` / `memoryBench` 对 OpenCode 不适用');
  ok(/channels\[\]\.engine/.test(INDEX_SRC), 'action=channels 描述提到 channels[].engine');
  ok(/探测式/.test(INDEX_SRC), '★ 免费模型清单标注为「探测式」，不写死枚举（防 ZB-31 式漂移）');
  ok(/variant/.test(INDEX_SRC) && /--variant/.test(INDEX_SRC), '思考强度专条补了 OpenCode 的 variant / --variant');
  ok(/跨引擎降级/.test(INDEX_SRC), '降级链专条补了跨引擎混排（换引擎＝新会话，不 resume）');
  ok(/GLM-5\.3 系用 `low`/.test(INDEX_SRC) && /deepseek 系可用 `disabled`/.test(INDEX_SRC),
    '既有 ZCode 档位说明**未被改动**（low|high|max / disabled|low|high|max 原样保留）');
}

/* ---------------- ⑤ CLI：--engine 与引擎标记（源码锁） ---------------- */
console.log('\n⑤ bin/dispatch.mjs（--engine 参数 + 通道行引擎标记）');
{
  const header = CLI_SRC.split('*/')[0];
  ok(/--engine zcode\|opencode/.test(header), '用法注释里有 `--engine zcode|opencode`');
  ok(/opencode\/deepseek-v4\.1-flash-free/.test(header), '用法注释里有 OpenCode 通道形态示例');
  ok(/--opencode-runner/.test(header) && /DSP_OPENCODE_RUNNER/.test(header),
    '用法注释里有 OpenCode 执行器路径覆盖（--opencode-runner / DSP_OPENCODE_RUNNER）');
  ok(/if \(opt\.engine\) spec\.engine = opt\.engine;/.test(CLI_SRC), '`--engine` 透传进 spec');
  ok(/if \(opt\.provider\) spec\.provider = opt\.provider;/.test(CLI_SRC), '`--provider opencode/<model>` 原样透传（core 自动识别）');
  ok(!/\benum:\s*\[/.test(CLI_SRC), '★ CLI 侧没有任何 provider/engine 枚举（不写死通道取值）');
  ok(/\[opencode\]/.test(CLI_SRC), 'channels 子命令输出带 `[opencode]` 引擎标记');
  ok(/opt\['opencode-runner'\]/.test(CLI_SRC), 'makeDispatcher 支持 --opencode-runner / DSP_OPENCODE_RUNNER');
  ok(/\.\.\.\(opencodeRunnerPath \? \{ opencodeRunnerPath \} : \{\}\)/.test(CLI_SRC),
    '★ opencodeRunnerPath 为空时**整项不传**（传空串会被 core 当成"配了但没有"）');
}

/* ---------------- ⑥ README：双引擎配置表与说明（文档一致性） ---------------- */
console.log('\n⑥ README 双引擎段落');
{
  const README = read('README.md');
  ok(/\|\s*`maxConcurrentOpenCode`\s*\|/.test(README), 'README 配置表有 `maxConcurrentOpenCode` 行');
  ok(/\|\s*`opencodeRunnerPath`\s*\|/.test(README), 'README 配置表有 `opencodeRunnerPath` 行');
  ok(/opencode-run\.mjs/.test(README) && /engine/.test(README), 'README 双引擎说明提到执行器与通道 engine');
  ok(/--auto/.test(README), 'README 明示默认不开 `--auto`');
  ok(/不读写用户自己的 OpenCode|不读.*OpenCode 配置/.test(README), 'README 明示不读写用户自己的 OpenCode 配置与数据');
}

console.log(`\n===== host-config（双引擎 Host 侧契约）：${pass} PASS / 0 FAIL =====`);
