/**
 * 测试用**假 OpenCode 执行器**（零依赖）。范式照 `fake-runner.mjs`（zcode 侧），
 * 但打印的是 `[opencode-run]` 前缀的汇总行 —— 让 core / host / 自检脚本能在**不触网、
 * 不消耗免费额度**的前提下覆盖 OpenCode 分支。
 *
 * 注入方式（与 zcode 侧同构，避免两套心智模型）：
 *   · core：`createDispatcher({ opencodeRunnerPath: <本文件绝对路径> })`
 *   · 自检脚本：`spawnSync(process.execPath, [<本文件>, ...])`
 *
 * 环境变量开关：
 *   FAKE_OC_SKIP        逗号分隔，跳过某些行：progress,usage,context,unknown,out,err,result,endpoint,done
 *   FAKE_OC_EXIT        进程退出码 / done 行的 exit（默认 0）
 *   FAKE_OC_SLEEP_MS    模拟执行耗时（默认 120；别设大，测试要快）
 *   FAKE_OC_SESSION     done 行的 session（默认随机；续跑匹配需固定值）
 *   FAKE_OC_MODEL       provider/done 行的 model（默认 opencode/deepseek-v4.1-flash-free）
 *   FAKE_OC_VARIANT     置非空 = 打印 `variant=<v> model=<model>`（等价于真的传了 --variant）
 *   FAKE_OC_UNKNOWN_LINE 打印一行**未登记格式**：置 `1` = 用内置样式；置其它非空值 = **逐字打印该值**
 *   FAKE_OC_MEMORY_BAN_LINE 置 1 = 打印 `memory-ban=on`
 *   FAKE_OC_TIMEOUT_DONE    置 1 = done 行带 `(超时)` 且 exit=124（执行器自身超时形态）
 *   FAKE_OC_TAG         启动行 tag（默认 fake-oc）
 *   FAKE_OC_CLI         cli= 行的值（默认 opencode）
 *   FAKE_OC_ARGV_FILE   把本次 argv 以 JSON 落盘到 `<路径>.<pid>.json`（供「参数拼装」断言，默认不落盘）
 *
 * CLI 契约（与真实 `collab-kit/opencode-run.mjs` 对齐，**这样 core 的探测与派发可共用同一路径**）：
 *   --version           → 打印 `1.19.2` 后 exit 0
 *   --list-models       → 打印若干 `opencode/<model>` 行后 exit 0
 *   --help              → 打印用法后 exit 0
 *   未知参数            → stderr 报错 + exit 1
 *   --mode/--memory-bench → stderr 报「不支持」+ exit 1（真实执行器同款硬约束）
 *   --prompt/--target/--task/--model/--variant/--cwd/--tag/--timeout-min/--resume/--memory-ban → 正常跑一轮
 *
 * out/err/result 路径故意带空格，用于验证含空格路径的解析。
 */
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const env = process.env;
const argv = process.argv.slice(2);

/** 取值型参数 → 是否出现；未知参数一律 exit 1（真实执行器的严格契约）。 */
const FLAGS_WITH_VALUE = ['--prompt', '--target', '--task', '--model', '--variant', '--cwd', '--tag', '--timeout-min', '--resume'];
const FLAGS_BOOL = ['--memory-ban', '--help', '--version', '--list-models'];
const UNSUPPORTED = ['--mode', '--memory-bench'];

const argVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);

/* FAKE_OC_ARGV_FILE：把真实收到的 argv 落盘，供测试断言 core 的 opencode 参数拼装。
 * 默认不落盘；文件名带 pid 以防并发覆盖。 */
if (env.FAKE_OC_ARGV_FILE) {
  try {
    writeFileSync(`${env.FAKE_OC_ARGV_FILE}.${process.pid}.json`, JSON.stringify(argv));
  } catch { /* 落盘失败不影响被测行为 */ }
}

function die(msg) {
  console.error(`[opencode-run] error: ${msg}`);
  process.exit(1);
}

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (FLAGS_WITH_VALUE.includes(a)) { i += 1; continue; }
  if (FLAGS_BOOL.includes(a)) continue;
  if (UNSUPPORTED.includes(a)) die(`不支持的参数 ${a}（OpenCode 执行器不提供该能力）`);
  die(`未知参数 ${a}`);
}

/* ---------------- 只读探测分支（不耗额度；core 的通道探测走这里） ---------------- */
if (has('--help')) {
  console.log('[opencode-run] usage: opencode-run.mjs --prompt <text> --model opencode/<model> [--variant <v>] [--cwd <dir>] [--tag <t>] [--timeout-min <n>] [--resume <sessionID>] [--memory-ban]');
  console.log('[opencode-run]        opencode-run.mjs --list-models | --version');
  process.exit(0);
}
if (has('--version')) {
  console.log('1.19.2');
  process.exit(0);
}
if (has('--list-models')) {
  /* 与真实 `opencode models` 同形：一行一个 `opencode/<model>`。
   * 只打印**形状**，不写死 12 个（上游会变；写死会重演 ZB-31 档位表漂移坑）。 */
  for (const m of ['opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free', 'opencode/big-pickle']) {
    console.log(m);
  }
  process.exit(0);
}

/* ---------------- 一轮「派发」 ---------------- */
const sleepMs = Number(env.FAKE_OC_SLEEP_MS ?? 120);
const exitCode = Number(env.FAKE_OC_EXIT ?? 0);
const skip = new Set((env.FAKE_OC_SKIP ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const sess = env.FAKE_OC_SESSION ?? `ses_fake-oc-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const model = argVal('--model') ?? env.FAKE_OC_MODEL ?? 'opencode/deepseek-v4.1-flash-free';
const tag = argVal('--tag') ?? env.FAKE_OC_TAG ?? 'fake-oc';
const cwd = argVal('--cwd') ?? process.cwd();
const variant = argVal('--variant') ?? env.FAKE_OC_VARIANT;

const PE = '[opencode-run]';
console.log(`${PE} tag=${tag} mode=opencode cwd=${cwd}`);
console.log(`${PE} cli=${env.FAKE_OC_CLI ?? 'opencode'}`);
if (argVal('--task')) console.log(`${PE} task=${argVal('--task')}`);
console.log(`${PE} provider=opencode model=${model}`);
if (variant) console.log(`${PE} variant=${variant} model=${model}`);
if (env.FAKE_OC_MEMORY_BAN_LINE || has('--memory-ban')) console.log(`${PE} memory-ban=on（已在提示词末尾注入记忆禁令）`);
if (argVal('--resume')) console.log(`${PE} resume=${argVal('--resume')}`);

if (sleepMs > 0) await delay(sleepMs);

if (!skip.has('progress')) {
  console.log(`${PE} progress stage=waiting-turn elapsed=${Math.max(1, Math.round(sleepMs / 1000))}s chars=1024 tools=1 lastTool=write stageAgo=2s session=${sess}`);
}
if (!skip.has('unknown')) {
  if (env.FAKE_OC_UNKNOWN_LINE) {
    console.log(env.FAKE_OC_UNKNOWN_LINE === '1' ? `${PE} quantum-flux level=9 node=alpha` : env.FAKE_OC_UNKNOWN_LINE);
  }
}
if (!skip.has('usage')) console.log(`${PE} usage requests=1 in=100 out=50 cacheRead=10`);
if (!skip.has('context')) console.log(`${PE} context used=1234 (0.6% of 200000) turnCount=2`);
if (!skip.has('endpoint')) console.log(`${PE} endpoint=https://fake.example/opencode`);
if (!skip.has('out')) console.log(`${PE} out=C:\\fake dir with space\\oc.out.log`);
if (!skip.has('err')) console.log(`${PE} err=C:\\fake dir with space\\oc.err.log`);
if (!skip.has('result')) console.log(`${PE} result=C:\\fake dir with space\\oc.result.json`);

if (!skip.has('done')) {
  /* FAKE_OC_TIMEOUT_DONE=1：模仿真实执行器自身超时（exit=124 + `(超时)` 标记）。 */
  const doneExit = env.FAKE_OC_TIMEOUT_DONE ? 124 : exitCode;
  const doneMark = env.FAKE_OC_TIMEOUT_DONE ? ' (超时)' : '';
  console.log(
    `${PE} done exit=${doneExit}${doneMark} elapsed=${(sleepMs / 1000).toFixed(1)}s session=${sess}` +
      ` provider=opencode model=${model} responseChars=2`,
  );
}
process.exit(env.FAKE_OC_TIMEOUT_DONE ? 124 : exitCode);
