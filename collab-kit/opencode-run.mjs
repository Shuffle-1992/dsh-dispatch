/**
 * OpenCode 无头派发器（DSH 派发台 → **本机真实 OpenCode CLI**；协议见 collab-kit/run-line-protocol.mjs）。
 *
 * 用途：把一条自足任务交给本机真实的 `opencode run --format json` 执行，把 NDJSON 事件流聚合成
 *      结构化结果（文本 / 工具 / 用量 / 上下文 / 会话 id），产物落盘、退出码透传，并按派发台的
 *      **汇总行协议**打印 `[opencode-run] …` 行供 `dispatch/core/dispatch-core.mjs` 解析。
 *
 * ⚠️ 本方案的全部价值在于「请求真的来自 OpenCode 本体」：
 *   · **不伪装身份**（不伪造 User-Agent、不伪造 ses_* session id、不塞假工具定义）；
 *   · **不读写用户自己的 OpenCode 配置/数据**（`~\.config\opencode\`、`~\.local\share\opencode\`
 *     含 `opencode.db`）—— 本脚本只**执行** `opencode` 命令、只**读** `opencode models` 的输出；
 *     产物一律写到任务自己的 `<cwd>/collab/logs/`；
 *   · **`--auto` 默认关**（只有调用方显式传 `--auto` 才透传，且会打可审计告知行）；
 *   · 免费层按 IP 限流 ⇒ 本脚本不自造并发、不重试轰炸；
 *   · **同一个 run 期间绝不再起第二个 opencode 进程**（实测会让 run 零输出退出，见 ④）。
 *
 * 用法：
 *   node "<dispatch>/collab-kit/opencode-run.mjs" --prompt "Reply with exactly: PONG" --tag smoke
 *   node "<dispatch>/collab-kit/opencode-run.mjs" --task "F:\proj\collab\tasks\T1.md" --tag T1 --cwd "F:\proj"
 *   node "<dispatch>/collab-kit/opencode-run.mjs" --target "<目标描述>" --tag T2          # 本版按 prompt 处理
 *   node "<dispatch>/collab-kit/opencode-run.mjs" --resume ses_xxx --prompt "继续" --tag T3
 *   node "<dispatch>/collab-kit/opencode-run.mjs" --list-models                            # 只读探测
 *   node "<dispatch>/collab-kit/opencode-run.mjs" --version
 *
 * 参数：
 *   --task <abs>          任务包文件（**读文件内联成 prompt**，避免 CLI 找不到路径）；与 --prompt 同时给出时 --task 优先
 *   --prompt <text>       直接指令
 *   --target <text>       目标模式（**本版按 prompt 处理**：OpenCode 无 ZCode 那种自续跑 target 语义，
 *                         不伪造；原因打印在 stderr）。与 --prompt/--task 互斥（同时给出即报错）。
 *   --model <id>          `opencode/<model>`；默认 opencode/deepseek-v4.1-flash-free
 *                         （无 `opencode/` 前缀时自动补全；续跑时**不传** `-m`，见下）
 *   --variant <v>         思考强度（OpenCode 的 `--variant`，如 high/max/minimal）；**传了才加**，不传不加
 *   --cwd <path>          工作目录（⇒ 透传 `--dir`；默认当前工作目录）
 *   --tag <name>          日志/结果文件标签（默认时间戳）
 *   --timeout-min <n>     超时分钟（默认 45，必须 > 0；到点杀进程树、exit 124）
 *   --resume <sessionId>  续会话（⇒ `-s <id>`）；**续跑时绝不传 `-m/--model`**（安全默认，理由见下）
 *   --memory-ban          在最终 prompt 末尾追加「不写 ZCode 记忆库」禁令，并打印 memory-ban=on 行
 *   --auto                **默认关**。显式传入才把它透传给 `opencode run` —— 会放行所有未显式拒绝的权限
 *                         （危险），仅在可信工作目录里使用；开启时 stdout 打
 *                         `auto=on（已放行所有未显式拒绝的权限；请确保工作目录可信）` 可审计告知行。
 *   --list-models         只读探测：**stdout 只有裸模型 id**（每行一个，core 逐行当模型 id 解析），exit 0
 *   --list-providers      同 --list-models（派发台对两种引擎共用一个探测入口时的别名）
 *   --with-variants       配合 --list-models：**追加**打印 `variants <model>=<a,b>` 行（默认不打，
 *                         保持 stdout 纯净；协议已登记该行。来源 = `opencode models --verbose` 的
 *                         每个模型 JSON 的 `variants` 键，为空对象/探测不到就**如实不打**）
 *   --version             打印 OpenCode 版本号（一行），exit 0
 *   --help / -h           用法，exit 0
 *   （不支持，识别到即 exit 1：`--memory-bench`、`--mode`；未知参数一律 fail-fast，列出参数名）
 *   （兼容令牌，仅记 stderr 说明后忽略：`--provider opencode`、`--no-ledger`；`--reasoning-level <v>`
 *     作为 `--variant` 的别名（`agent` ⇒ 不传 variant，用 OpenCode 默认档））
 *
 * 已实测事实（2026-10-16 本机，OpenCode 1.19.2；原始输出见任务交付说明）：
 *   ① `-s <id>` 与 `-m <model>` **同时给不报错**（第 2 轮独立进程回「42」，sessionID 相同）。
 *      但本脚本仍按契约采用**安全默认**：`--resume` 时**不传** `-m`（沿用原会话模型），并在 stderr 说明；
 *      若调用方显式给了 `--model` 与 `--resume`，会打印警告说明它被忽略。
 *   ② `--variant high` 被免费模型接受（exit 0）；本脚本不编造档位表：传了就透传，上游报错原样透传给用户。
 *   ③ 上下文窗口可探测：`opencode models --verbose` 的每个模型 JSON 带 `limit.context`
 *      （deepseek-v4.1-flash-free = 200000）。探测不到 ⇒ **整行不打**（不编造）。
 *      `variants`（非空时）与 `limit.context` 同源，只读探测。
 *   ④ ⚠️ **run 进行中再起第二个 opencode 进程（如探测）会让当前 run 静默死**（本机对照实验，详见文件中部
 *      META_CACHE 注释）：`opencode run` 进行中再起 `opencode models --verbose` ⇒ run 零输出 exit 1
 *      （stdout/stderr 各 0 字节）。**勿误读为「并发 OpenCode 都危险」**：同机并发的**两个独立 `opencode run`
 *      本身实测可行**（Lead 对照实验 2/2 成功、各自独立工作目录）；危险源是「同一进程链里在 run 期间又起
 *      一个 opencode」。⇒ 故本脚本的探测一律**顺序执行 + 落缓存**（`%TEMP%\dsh-opencode-model-meta.json`，TTL 6h）。
 *   ⑤ **会话按工作目录作用域**：同一 sessionID 在**它创建时的目录**里 `-s` 续跑正常（实测回 42）；
 *      换一个 `--dir` 续跑会挂住/静默失败。⇒ 调用方必须把 sessionId 与它的 cwd 一起持久化，续跑传同一个 `--cwd`。
 *   ⑥ 写文件任务在**非交互**（stdin=ignore）下**无需 `--auto`** 即可成功（实测 exit 0 + 文件落实）——
 *      先前观测到的"写类任务静默失败"已定位为 ④ 的并发探测所致，与权限审批无关。
 *   ⑦ **收尾只认子进程 'close'；强制兜底必须挂在 `--timeout-min` 之后**（Lead e2e 抓到的功能性 BUG）：
 *      旧版有个**固定 15s** 兜底，会把「慢但正常」的调用当挂死 —— `opencode/glm-5.3-flash-free` 首响
 *      实测 ~14.2s（冷启动+排队），15.0s 就被收尾 ⇒ exit 1 + stdout/stderr 各 0 字节（误杀！）。
 *      现在兜底 = `timeoutMin*60_000 + SETTLE_GRACE_MS(120s)`；`--timeout-min` 到点才是超时（exit 124 +
 *      `(超时)`），只是 close 迟到的兜底走 `settleForced`（退出码取子进程真实码，**不自称超时**）。
 *
 * 产物（照 zcode-run.mjs 既有落点与命名）：
 *   <cwd>/collab/logs/opencode-run-{tag}-{ts}.out.log      原始 stdout NDJSON（逐行原样）
 *   <cwd>/collab/logs/opencode-run-{tag}-{ts}.err.log      原始 stderr（逐行原样）
 *   <cwd>/collab/logs/opencode-run-{tag}-{ts}.result.json  解析后的结构化结果
 *   （**不写** dispatch-runs.jsonl 台账 —— 那是 ZCode 侧的；OpenCode 用量由派发台从 stdout 行聚合）
 *
 * 退出码：0 成功；上游 CLI 的退出码透传（失败）；124 超时；1 参数/环境错误（如找不到 opencode）。
 *
 * ── 给派发台 core 的交接备注 ───────────────────────────────────────────────
 * 1. 本脚本的输出行协议**以 `collab-kit/run-line-protocol.mjs` 为唯一权威**（本文件直接 import 它的
 *    `prefixFor('opencode')` 取前缀，绝不写死 `[opencode-run]` 字面量在别处）。
 * 2. 本文件**只打印已登记的行形状**（start / provider / variant / memory-ban / usage / context /
 *    progress / out / err / result / done / cli / task / resume）。唯一例外：`--auto` 时的
 *    `auto=on（…）` 告知行（Lead 裁决要求可审计，协议未登记该形状 ⇒ core 侧按未知行处理，无副作用）。
 *    除它以外，若确需新增形状，**先改协议文件与 core 的解析器，再改本文件** —— 绝不自行新增。
 * 3. `--target` 没有登记行（协议里没有 target= 行），因此「按 prompt 处理」的说明打在 **stderr**，
 *    避免 core 把 stdout 上未知形状的 `[opencode-run]` 行记成 warning。
 * 4. 未知事件类型 / JSON 解析失败：**绝不抛异常终止整轮** —— 原样写 out.log、记进 result.json 的
 *    `unknownEvents`，进度照常。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prefixFor } from './run-line-protocol.mjs';

/* 前缀唯一来源（协议文件）；注意 stderr 上的诊断行也用同一前缀 —— 与 zcode-run.mjs 的纪律一致
 * （core 只对 stdout 做逐行协议解析，stderr 是诊断通道）。 */
export const PREFIX = prefixFor('opencode');
/** 行协议里的引擎标识（start 行的 `mode=` 字段固定为它）。 */
export const ENGINE = 'opencode';
export const DEFAULT_MODEL = 'opencode/deepseek-v4.1-flash-free';
export const DEFAULT_TIMEOUT_MIN = 45;
/**
 * 兜底收尾宽限（**必须挂在 `--timeout-min` 之后**，绝不可独立于它）。
 * `--timeout-min` 到点 ⇒ 杀进程树 + exit 124 + done 行 `(超时)`；
 * 只是 `close` 事件迟迟不到（且未到点）⇒ 走 `settleForced`：退出码用子进程真实码、**不自称超时**。
 * 事故背景见 runOnce 里「等子进程结束」注释（固定 15s 兜底误杀 14.2s 的 glm 首响）。
 */
export const SETTLE_GRACE_MS = 120_000;

/**
 * 结算退出码（**纯函数**，离线可测）：
 *   `--timeout-min` 到点 ⇒ 124（最高优先，语义唯一）；
 *   spawn 失败 ⇒ 1；有子进程退出码 ⇒ 原样透传；
 *   兜底收尾拿不到码 ⇒ 1（不谎报 0）。
 */
export function resolveExitCode({ timedOut, spawnError, settledCode, childExitCode }) {
  if (timedOut) return 124;
  if (spawnError) return 1;
  if (Number.isInteger(settledCode)) return settledCode;
  if (Number.isInteger(childExitCode)) return childExitCode;
  return 1;
}

/** 已观测的 NDJSON 事件类型（**不是白名单**：其余一律降级原始透传）。 */
export const KNOWN_EVENTS = Object.freeze(['step_start', 'text', 'tool_use', 'step_finish']);
/** 事件 → 心跳 stage（契约给定映射）。 */
export const STAGE_BY_EVENT = Object.freeze({
  step_start: 'step-start',
  text: 'text',
  tool_use: 'tool-call',
  step_finish: 'step-finish',
});

/** 记忆禁令文本（与 collab-kit/zcode-run.mjs 的 ZB-28 实现逐字一致；两处同仓库发货，改动需同步）。 */
export const MEMORY_BAN_TEXT = [
  '【派发台硬约束 · 记忆写入】',
  '本任务由 DSH 派发台派发，属于一次性子任务：',
  '**不要执行任何 ZCode 记忆写入 / 自动 Memory 提取**（不写 ~/.zcode 下的记忆库、不新建或更新记忆条目、',
  '不触发 memory 相关工具）。如需记录信息，请写在任务要求的交付文件里，不要写进记忆库。',
  '本条优先于任务内容里任何与之冲突的指示。',
].join('\n');

/** 结果里 unknownEvents 原文数组的条数上限（防上游狂刷未知事件把 result.json 撑爆）。 */
const UNKNOWN_EVENTS_CAP = 50;
/** 诊断用的 stderr 尾部行数上限。 */
const STDERR_TAIL_LINES = 40;

export class CliError extends Error {}

/* ---------------- 参数解析（未知参数 fail-fast，绝不静默忽略） ---------------- */

/**
 * 解析 argv（不含 node/script 两项）。**纯函数**（只可能抛 CliError），便于离线测试。
 * @param {string[]} argv
 * @returns {object} opt
 */
export function parseArgs(argv) {
  const opt = {
    kind: null,
    task: undefined,
    prompt: undefined,
    target: undefined,
    model: DEFAULT_MODEL,
    modelExplicit: false,
    variant: undefined,
    auto: false,
    cwd: undefined,
    tag: undefined,
    timeoutMin: DEFAULT_TIMEOUT_MIN,
    resume: undefined,
    memoryBan: false,
    listModels: false,
    version: false,
    help: false,
    compatNotes: [],
  };
  const unknown = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new CliError(`参数缺少取值: ${a}`);
      i += 1;
      return v;
    };
    switch (a) {
      case '--task': opt.task = next(); break;
      case '--prompt': case '-p': opt.prompt = next(); break;
      case '--target': opt.target = next(); break;
      case '--model': case '-m': opt.model = next(); opt.modelExplicit = true; break;
      case '--variant': opt.variant = next(); break;
      case '--cwd': opt.cwd = next(); break;
      case '--tag': opt.tag = next(); break;
      case '--timeout-min': opt.timeoutMin = Number(next()); break;
      case '--resume': opt.resume = next(); break;
      case '--memory-ban': opt.memoryBan = true; break;
      /* --auto：**默认关**，只有调用方显式传才透传（Lead 裁决方案 B）。
       * OpenCode 的 `--auto` 会放行所有未显式拒绝的权限 ⇒ 必须在 stdout 打可审计的告知行。 */
      case '--auto': opt.auto = true; break;
      case '--list-models': case '--list-providers': opt.listModels = true; break;
      case '--with-variants': opt.withVariants = true; break;
      case '--version': case '-v': opt.version = true; break;
      case '--help': case '-h': opt.help = true; break;
      /* 明确不支持：fail-fast 报错（契约要求，绝不静默忽略）。 */
      case '--memory-bench':
        throw new CliError('opencode-run 不支持 --memory-bench（OpenCode 无 ZCode 记忆库/自动 Memory 提取概念）');
      case '--mode':
        next();
        throw new CliError('opencode-run 不支持 --mode（OpenCode 无 build/edit/plan/yolo 模式概念）');
      /* 兼容令牌（仅记 stderr 说明后忽略，仍然「大声」，不是静默忽略）。 */
      case '--provider': {
        const v = String(next()).trim();
        if (v !== 'opencode') {
          throw new CliError(`--provider 只接受 opencode（收到: ${v}）—— OpenCode 引擎由本脚本自身决定`);
        }
        opt.compatNotes.push('--provider opencode 已忽略（本脚本即 OpenCode 引擎）');
        break;
      }
      case '--no-ledger':
        opt.compatNotes.push('--no-ledger 已忽略（opencode-run 本就不写 dispatch-runs.jsonl 台账）');
        break;
      case '--reasoning-level': {
        const v = next();
        const level = String(v).trim();
        /* OpenCode 没有「Agent决定」这一档：agent ⇒ 不传 variant（用 OpenCode 默认），其余当 variant 透传。 */
        if (level === 'agent') {
          opt.compatNotes.push('--reasoning-level agent ⇒ opencode-run 不传 --variant（OpenCode 无该概念，用其默认档）');
        } else {
          opt.variant = level;
          opt.compatNotes.push(`--reasoning-level ${level} ⇒ 按 OpenCode 的 --variant ${level} 透传`);
        }
        break;
      }
      default:
        unknown.push(a);
    }
  }
  if (unknown.length) {
    throw new CliError(`未知参数: ${unknown.join(', ')}（用法见 ${PREFIX} --help）`);
  }
  /* `--with-variants` 只在探测模式下有意义：单独给会让人以为带上了档位信息 ⇒ fail-fast。 */
  if (opt.withVariants && !opt.listModels) {
    throw new CliError('--with-variants 仅在 --list-models / --list-providers 下有效');
  }
  if (opt.help || opt.listModels || opt.version) return opt;

  const given = [opt.task, opt.prompt, opt.target].filter((v) => v !== undefined);
  if (given.length === 0) throw new CliError('必须给出 --task / --prompt / --target 之一');
  if (opt.target !== undefined && (opt.prompt !== undefined || opt.task !== undefined)) {
    throw new CliError('--target 与 --prompt/--task 互斥（OpenCode 无 ZCode 目标模式的等价输入面），请二选一');
  }
  if (opt.task !== undefined) opt.kind = 'task';
  else if (opt.target !== undefined) opt.kind = 'target';
  else opt.kind = 'prompt';

  if (!Number.isFinite(opt.timeoutMin) || opt.timeoutMin <= 0) {
    throw new CliError(`--timeout-min 必须是 > 0 的数字（收到: ${argv.join(' ')}）`);
  }
  if (opt.resume !== undefined && String(opt.resume).trim() === '') {
    throw new CliError('--resume 需要一个非空 sessionId');
  }
  if (opt.variant !== undefined && String(opt.variant).trim() === '') {
    throw new CliError('--variant 需要一个非空取值');
  }
  return opt;
}

/** 规范化模型 id：无 `provider/` 前缀时补 `opencode/`（派发台通道 id 形态见协议 OPENCODE_ID_RE）。 */
export function normalizeModelId(model) {
  const s = String(model ?? '').trim();
  if (s === '') return DEFAULT_MODEL;
  return s.includes('/') ? s : `opencode/${s}`;
}

/**
 * 构造 `opencode` 的参数表（**纯函数**，便于离线测试断言「续跑不传 -m」）。
 * 顺序：run <message> [-s id | -m model] [--variant v] [--dir cwd] --format json
 * ⚠️ 续跑时绝不传 `-m/--model`（契约安全默认；实测 -s 与 -m 同给虽不报错，仍按契约取安全默认）。
 */
export function buildRunArgs(opt) {
  const args = ['run', String(opt.prompt ?? '')];
  if (opt.resume) args.push('-s', String(opt.resume));
  else args.push('-m', normalizeModelId(opt.model));
  if (opt.variant) args.push('--variant', String(opt.variant));
  if (opt.auto) args.push('--auto'); // 仅显式传入才加（默认关）
  if (opt.cwd) args.push('--dir', String(opt.cwd));
  args.push('--format', 'json');
  return args;
}

/* ---------------- NDJSON 聚合（未知类型/坏行绝不抛） ---------------- */

/**
 * 创建一个 NDJSON 聚合器。`handleLine(raw)` 永不抛异常：
 *   · 已知事件 → 累积（sessionId / text / tools / tokens / cost / context）；
 *   · 未知 type 或 JSON 坏行 → 记进 unknownEvents/warnings 并返回，继续本轮。
 */
export function createAggregator() {
  const texts = [];
  const tools = [];
  const unknownEvents = [];
  const warnings = [];
  const eventCounts = Object.create(null);
  const usage = {
    requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0,
  };
  const seen = { input: false, output: false, cacheRead: false, reasoning: false, total: false };
  let sessionId = null;
  let cost = null;
  let costSeen = false;
  let contextUsed = null;
  let unknownEventCount = 0;
  let parseErrorCount = 0;
  let lastEventAt = null;
  /** 实时计数（心跳逐事件读取，避免每行重建 summary 对象）。 */
  const counters = { sessionId: null, chars: 0, tools: 0 };

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const noteUnknown = (line) => {
    unknownEventCount += 1;
    if (unknownEvents.length < UNKNOWN_EVENTS_CAP) unknownEvents.push(line);
  };

  function handleLine(raw) {
    const line = typeof raw === 'string' ? raw.replace(/\r$/, '') : '';
    if (line.trim() === '') return { type: null, known: false, empty: true };
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      /* 硬约束：单行解析失败绝不止损整轮 —— 记 warning + unknownEvents，原样已在 out.log。 */
      parseErrorCount += 1;
      warnings.push(`JSON 解析失败（该行已原样保留在 out.log）: ${line.slice(0, 200)}`);
      noteUnknown(line);
      return { type: null, known: false, parseError: true };
    }
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
      parseErrorCount += 1;
      warnings.push(`事件不是 JSON 对象（已原样保留在 out.log）: ${line.slice(0, 200)}`);
      noteUnknown(line);
      return { type: null, known: false, parseError: true };
    }
    const type = typeof ev.type === 'string' ? ev.type : '(无 type)';
    const part = ev.part !== null && typeof ev.part === 'object' ? ev.part : null;
    const sid = typeof ev.sessionID === 'string' && ev.sessionID !== ''
      ? ev.sessionID
      : (typeof part?.sessionID === 'string' && part.sessionID !== '' ? part.sessionID : null);
    if (sid && sessionId === null) sessionId = sid;
    counters.sessionId = sessionId;
    eventCounts[type] = (eventCounts[type] ?? 0) + 1;
    lastEventAt = Date.now();

    if (!KNOWN_EVENTS.includes(type)) {
      /* 硬约束：未知 type 一律降级为原始透传（记 unknownEvents + 原样写 out.log），绝不抛。 */
      noteUnknown(line);
      warnings.push(`未知事件类型 ${type}（降级为原始透传，继续本轮）`);
      return { type, known: false };
    }

    if (type === 'text') {
      const t = typeof part?.text === 'string' ? part.text : '';
      if (t !== '') { texts.push(t); counters.chars += t.length; }
      return { type, known: true, text: t };
    }
    if (type === 'tool_use') {
      const tool = {
        tool: typeof part?.tool === 'string' ? part.tool : null,
        callID: typeof part?.callID === 'string' ? part.callID : null,
        status: typeof part?.state?.status === 'string' ? part.state.status : null,
      };
      if (part?.state && typeof part.state === 'object') {
        if (part.state.input !== undefined) tool.input = part.state.input;
        if (part.state.output !== undefined) tool.output = part.state.output;
      }
      tools.push(tool);
      counters.tools = tools.length;
      return { type, known: true, tool };
    }
    if (type === 'step_finish') {
      usage.requests += 1;
      const tk = part?.tokens !== null && typeof part?.tokens === 'object' ? part.tokens : null;
      if (tk) {
        /* tokens 可能缺字段（上游结构变化）⇒ 逐字段判存，绝不让 undefined/NaN 渗进求和。 */
        const input = num(tk.input);
        const output = num(tk.output);
        const reasoning = num(tk.reasoning);
        const total = num(tk.total);
        const cacheRead = num(tk.cache?.read);
        if (input !== null) { usage.inputTokens += input; seen.input = true; }
        if (output !== null) { usage.outputTokens += output; seen.output = true; }
        if (reasoning !== null) { usage.reasoningTokens += reasoning; seen.reasoning = true; }
        if (total !== null) { usage.totalTokens += total; seen.total = true; }
        if (cacheRead !== null) { usage.cacheReadTokens += cacheRead; seen.cacheRead = true; }
        /* 上下文占用 = 本轮最后一个 step_finish 的 input+output+reasoning+cache.read（缺项按 0）。 */
        contextUsed = (input ?? 0) + (output ?? 0) + (reasoning ?? 0) + (cacheRead ?? 0);
      }
      const c = num(part?.cost);
      if (c !== null) { cost = (cost ?? 0) + c; costSeen = true; }
      return { type, known: true, reason: typeof part?.reason === 'string' ? part.reason : null, tokens: tk };
    }
    return { type, known: true }; // step_start
  }

  function summary() {
    return {
      sessionId,
      response: texts.join(''),
      responseChars: texts.join('').length,
      tools,
      toolCount: tools.length,
      usage: { ...usage },
      usageSeen: { ...seen },
      cost: costSeen ? cost : null,
      eventCounts: { ...eventCounts },
      unknownEvents: [...unknownEvents],
      unknownEventCount,
      parseErrorCount,
      warnings: [...warnings],
      contextUsed,
      /* turnCount = step_finish 条数（每个 step 一次模型回合）；无 step_finish 时 null。 */
      turnCount: usage.requests > 0 ? usage.requests : null,
      lastEventAt,
    };
  }

  return { handleLine, summary, counters };
}

/** 一次性聚合整段 NDJSON 文本（离线测试入口）。 */
export function aggregateNdjson(text, agg = createAggregator()) {
  for (const line of String(text ?? '').split(/\r?\n/)) agg.handleLine(line);
  return agg.summary();
}

/* ---------------- 行格式化（纯函数；与 run-line-protocol.mjs 的行语法逐字对齐） ---------------- */

/** usage 行：没有的字段一律 `-`（契约要求，且 tokens 可能缺字段）。 */
export function formatUsageLine(usage = {}, seen = {}) {
  const f = (v, ok) => (ok && Number.isFinite(v) ? String(v) : '-');
  return `${PREFIX} usage requests=${f(usage.requests, Number.isFinite(usage.requests) && usage.requests > 0)}` +
    ` in=${f(usage.inputTokens, seen.input)} out=${f(usage.outputTokens, seen.output)}` +
    ` cacheRead=${f(usage.cacheReadTokens, seen.cacheRead)}`;
}

/** context 行；窗口未知（探测不到）⇒ 返回 null，调用方**整行不打**（不编造）。 */
export function formatContextLine(used, windowSize, turnCount) {
  if (!Number.isFinite(used) || !Number.isFinite(windowSize) || windowSize <= 0) return null;
  const pct = ((used / windowSize) * 100).toFixed(1);
  return `${PREFIX} context used=${Math.round(used)} (${pct}% of ${Math.round(windowSize)})` +
    ` turnCount=${Number.isFinite(turnCount) ? Math.round(turnCount) : '-'}`;
}

/** 心跳行（stage/elapsed/chars/tools/[lastTool]/stageAgo/[session]）；无 session 时省略 session=。 */
export function formatProgressLine(progress, startedMs, nowMs = Date.now()) {
  const elapsedSec = Math.max(0, Math.round((nowMs - startedMs) / 1000));
  const stageAgoSec = Math.max(0, Math.round((nowMs - (Number.isFinite(progress?.at) ? progress.at : startedMs)) / 1000));
  return `${PREFIX} progress stage=${progress?.stage ?? '?'} elapsed=${elapsedSec}s` +
    ` chars=${Number.isFinite(progress?.chars) ? progress.chars : 0}` +
    ` tools=${Number.isFinite(progress?.tools) ? progress.tools : 0}` +
    (progress?.lastTool ? ` lastTool=${progress.lastTool}` : '') +
    ` stageAgo=${stageAgoSec}s` +
    (progress?.sessionId ? ` session=${progress.sessionId}` : '');
}

export function formatDoneLine({ exit, timedOut, elapsedSec, sessionId, model, responseChars }) {
  return `${PREFIX} done exit=${exit}${timedOut ? ' (超时)' : ''} elapsed=${Number(elapsedSec).toFixed(1)}s` +
    (sessionId ? ` session=${sessionId}` : '') +
    (model ? ` model=${model}` : '') +
    (Number.isFinite(responseChars) ? ` responseChars=${responseChars}` : '');
}

/* ---------------- `opencode models` 探测（只读；失败一律降级，不猜） ---------------- */

/** `opencode models` 纯文本输出 → id 数组（每行一个 `provider/model`）。 */
export function parseModelsPlain(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(s));
}

/** 只保留 OpenCode 通道形态的 id（协议 OPENCODE_ID_RE 的等价判据；其余过滤并在 stderr 说明）。 */
export function filterOpenCodeIds(ids) {
  return ids.filter((id) => /^opencode\/[A-Za-z0-9._:-]+$/.test(id));
}

/**
 * `opencode models --verbose` 输出 → Map(id → {contextWindow, outputLimit, variants, status})。
 * 输出形态：每个模型一行 id，紧跟一个 pretty-printed JSON 块（`{` 顶格起、`}` 顶格止）。
 * 解析失败的模型直接跳过（**不猜**）。
 */
export function parseModelsVerbose(text) {
  const out = new Map();
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const id = lines[i].trim();
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(id)) continue;
    if ((lines[i + 1] ?? '').trim() !== '{') continue;
    let depth = 0;
    let started = false;
    const buf = [];
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      buf.push(lines[j]);
      for (const ch of lines[j]) {
        if (ch === '{') { depth += 1; started = true; } else if (ch === '}') depth -= 1;
      }
      if (started && depth <= 0) { end = j; break; }
    }
    if (end < 0) continue;
    i = end;
    try {
      const meta = JSON.parse(buf.join('\n'));
      out.set(id, {
        contextWindow: Number.isFinite(meta?.limit?.context) ? meta.limit.context : null,
        outputLimit: Number.isFinite(meta?.limit?.output) ? meta.limit.output : null,
        variants: meta?.variants && typeof meta.variants === 'object' && !Array.isArray(meta.variants)
          ? Object.keys(meta.variants)
          : [],
        status: typeof meta?.status === 'string' ? meta.status : null,
      });
    } catch {
      /* 单个模型元数据解析失败：跳过（不猜、不影响其它模型） */
    }
  }
  return out;
}

/* ---------------- OpenCode 可执行文件解析与 spawn 形态 ---------------- */

/**
 * 解析 opencode 可执行文件（**只读探测**：existsSync / `where`，不执行任何 opencode 子命令）。
 * 顺序：env OPENCODE_CLI → npm 全局 shim 指向的真实二进制 → npm shim 本体 → `where opencode`。
 * 返回绝对路径或裸命令名；找不到返回 null（调用方 exit 1 并给可读错误）。
 */
export function findOpencodeCli(env = process.env, deps = {}) {
  const exists = deps.existsSync ?? existsSync;
  const runWhere = deps.whereSync ?? (() => {
    try {
      const r = spawnSync('where', ['opencode'], { encoding: 'utf8', timeout: 10_000 });
      return r.status === 0 ? String(r.stdout ?? '') : '';
    } catch {
      return '';
    }
  });
  const candidates = [];
  const explicit = typeof env.OPENCODE_CLI === 'string' ? env.OPENCODE_CLI.trim() : '';
  if (explicit) {
    /* 显式覆盖：允许「绝对路径」或「裸命令名」（后者交给 PATH，由 spawnSpec 决定形态）。 */
    if (!isAbsolute(explicit) && !/[\\/]/.test(explicit)) return explicit;
    candidates.push(explicit);
  }
  const appData = env.APPDATA ?? (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Roaming') : '');
  if (appData) {
    const npmDir = join(appData, 'npm');
    /* npm 生成的 opencode.cmd 实际指向 opencode-ai 包内的真实 .exe（本机实测），
     * 直接 spawn .exe 可避开 cmd.exe 的转义面（prompt 里带引号/中文也安全）。 */
    candidates.push(join(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'));
    candidates.push(join(npmDir, 'node_modules', 'opencode-ai', 'node_modules', 'opencode-windows-x64', 'bin', 'opencode.exe'));
    candidates.push(join(npmDir, 'opencode.exe'));
    candidates.push(join(npmDir, 'opencode'));
    candidates.push(join(npmDir, 'opencode.cmd'));
  }
  for (const c of candidates) {
    if (c && exists(c)) return resolve(c);
  }
  const fromWhere = String(runWhere() ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && !/\.ps1$/i.test(s));
  for (const c of fromWhere) {
    if (exists(c)) return resolve(c);
  }
  return null;
}

/** 首行 shebang 判定（无扩展名的 node 脚本 shim，如 `node_modules/opencode-ai/bin/opencode`）。 */
function looksLikeNodeScript(file) {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 200);
    return head.startsWith('#!') && /node/i.test(head.split('\n')[0]);
  } catch {
    return false;
  }
}

/**
 * 由可执行文件路径决定 spawn 形态：
 *   .exe / 其它原生 → 直接 spawn；
 *   .js/.mjs/.cjs 或 shebang 为 node 的脚本 → process.execPath 带上脚本；
 *   .cmd/.bat → 经 cmd.exe（Windows 上 Node ≥18.20 不能直接 spawn 批处理）。
 * 返回 { cmd, argv }（**不改全局**，便于测试）。
 */
export function spawnSpec(cli, args) {
  const lower = String(cli).toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    return { cmd: comspec, argv: ['/d', '/s', '/c', String(cli), ...args.map(String)] };
  }
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return { cmd: process.execPath, argv: [String(cli), ...args.map(String)] };
  }
  if (!/\.[A-Za-z0-9]+$/.test(lower) && existsSync(cli) && looksLikeNodeScript(cli)) {
    return { cmd: process.execPath, argv: [String(cli), ...args.map(String)] };
  }
  return { cmd: String(cli), argv: args.map(String) };
}

/** 同步跑一个 opencode 子命令（只读探测用）。永不抛：失败返回 { ok:false, ... }。 */
export function runCliSync(cli, args, timeoutMs = 30_000) {
  const spec = spawnSpec(cli, args);
  try {
    const r = spawnSync(spec.cmd, spec.argv, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      ok: r.status === 0,
      status: r.status ?? null,
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? ''),
      error: r.error ? String(r.error.message ?? r.error) : null,
    };
  } catch (e) {
    return { ok: false, status: null, stdout: '', stderr: '', error: String(e?.message ?? e) };
  }
}

/* ---------------- 模型元数据探测（上下文窗口 / variants）：**顺序执行 + 落缓存** ----------------
 *
 * ⚠️ 真机事故（2026-10-16 本机实测，必看）：**本脚本不能在 `opencode run` 进行中再起第二个 opencode 进程
 *   （例如并发跑探测）** —— 这会让那个 run **零输出静默 exit 1**（stdout/stderr 全空、无任何事件），
 *   表现为「任务莫名失败」；同一命令单独跑（无并发）100% 成功。
 *   实测对照（同机、同模型、同 prompt、stdin=ignore、同目录）：
 *     · 脚本**并发**探测版本 → exit 1 / 15.0s / 零事件（可复现）
 *     · `OPENCODE_CONTEXT_WINDOW=200000` 跳过探测 → exit 0 / 7.0s / 正常回 OK
 *     · 直接用 `spawn` 单独跑同一 prompt → exit 0 / 13.0s / 正常
 *   ⚠️ **勿过度推广（Lead 对照实验已否掉）**：同机**并发的两个独立 `opencode run` 本身实测可行**（2/2 成功、
 *   各自独立工作目录，`tools/oc-concurrency-probe.mjs` 可复跑）。危险源是「同一进程链里在 run 期间又起一个
 *   opencode」，不是「两个 run 并存」⇒ core 的 OpenCode 并发上限无需因此降为 1。
 *   因此本脚本的探测一律**在 run 之前或之后顺序执行**，且结果落**系统临时目录**缓存（默认 TTL 6h），
 *   绝大多数派发不再探测。
 *
 * 缓存位置：`%TEMP%/dsh-opencode-model-meta.json`（**不碰用户自己的 OpenCode 配置/数据目录**）。
 * 可用 `OPENCODE_META_CACHE_FILE` 覆盖路径（离线测试用），`OPENCODE_CONTEXT_WINDOW=<n>` 直接给定窗口并跳过探测。
 */
const META_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function metaCachePath(env = process.env) {
  const explicit = typeof env.OPENCODE_META_CACHE_FILE === 'string' ? env.OPENCODE_META_CACHE_FILE.trim() : '';
  return explicit !== '' ? resolve(explicit) : join(tmpdir(), 'dsh-opencode-model-meta.json');
}

/** 读缓存；过期/损坏/换了 CLI 一律当没有（**不抛**）。 */
export function readMetaCache(cli, env = process.env, nowMs = Date.now()) {
  try {
    const j = JSON.parse(readFileSync(metaCachePath(env), 'utf8'));
    if (!j || typeof j !== 'object' || j.cli !== cli) return null;
    if (!Number.isFinite(j.fetchedAt) || nowMs - j.fetchedAt > META_CACHE_TTL_MS) return null;
    if (!j.models || typeof j.models !== 'object') return null;
    return j.models;
  } catch {
    return null;
  }
}

function writeMetaCache(cli, models, env = process.env) {
  try {
    writeFileSync(metaCachePath(env), JSON.stringify({ fetchedAt: Date.now(), cli, models }));
  } catch { /* 缓存写失败不影响主流程 */ }
}

/** 顺序探测模型元数据（id → {contextWindow, variants}）；失败返回 null（调用方降级，不猜）。 */
export function probeModelMeta(cli) {
  const r = runCliSync(cli, ['models', '--verbose'], 60_000);
  if (!r.ok) return null;
  const map = parseModelsVerbose(r.stdout);
  if (map.size === 0) return null;
  const models = {};
  for (const [id, m] of map) models[id] = { contextWindow: m.contextWindow, variants: m.variants };
  return models;
}

/** 取模型元数据：缓存优先，其次顺序探测（并回写缓存）。 */
function loadModelMeta(cli) {
  const cached = readMetaCache(cli);
  if (cached) return cached;
  const probed = probeModelMeta(cli);
  if (probed) writeMetaCache(cli, probed);
  return probed;
}

/** 解析上下文窗口：env 覆盖 → 缓存 → 顺序探测；探测不到返回 null（⇒ 不打 context 行）。 */
function resolveContextWindow(cli, model, env = process.env) {
  const forced = Number(env.OPENCODE_CONTEXT_WINDOW);
  if (Number.isFinite(forced) && forced > 0) return forced;
  const meta = loadModelMeta(cli);
  if (!meta) return null;
  const hit = meta[model];
  return Number.isFinite(hit?.contextWindow) ? hit.contextWindow : null;
}

/** 杀进程树（Windows 用 taskkill /T；其余平台杀进程组）。永不抛。 */
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
    } catch { /* ignore */ }
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
}

/* ---------------- 主流程 ---------------- */

const HELP = `用法:
  node collab-kit/opencode-run.mjs (--prompt <text> | --target <text> | --task <abs-path>) [选项]
  node collab-kit/opencode-run.mjs --list-models | --list-providers | --version | --help

选项:
  --prompt <text>       直接指令
  --target <text>       目标模式（本版按 prompt 处理；OpenCode 无 ZCode 的自续跑 target 语义）
  --task <abs>          任务包文件（读文件内联成 prompt；与 --prompt 同时给出时 --task 优先）
  --model <id>          模型 id（默认 ${DEFAULT_MODEL}；无 opencode/ 前缀会自动补全）
  --variant <v>         思考强度（OpenCode --variant，如 high/max/minimal）；传了才加
  --cwd <path>          工作目录（透传 --dir；日志写在 <cwd>/collab/logs/）
  --tag <name>          日志/结果文件标签（默认时间戳）
  --timeout-min <n>     超时分钟（默认 ${DEFAULT_TIMEOUT_MIN}，必须 > 0；到点杀进程树、exit 124）
  --resume <sessionId>  续会话（-s；**续跑不传 -m**，沿用原会话模型）
  --memory-ban          在 prompt 末尾追加「不写 ZCode 记忆库」禁令
  --auto                **默认关**；显式传入才透传 OpenCode 的 --auto（放行所有未显式拒绝的权限！）
                        仅在**可信工作目录**里使用；开启时 stdout 会打 auto=on 告知行
  --list-models         只读探测：**stdout 只有裸模型 id**（一行一个），exit 0
  --list-providers      同 --list-models
  --with-variants       配合 --list-models：追加「variants <model>=<a,b>」行（协议已登记；默认不打）
  --version             打印 OpenCode 版本号（一行），exit 0
  --help, -h            本用法

不支持（识别到即 exit 1）: --memory-bench / --mode
退出码: 0 成功 | 上游 CLI 退出码透传（失败）| 124 超时 | 1 参数/环境错误
`;

/** 组装最终 prompt（task 内联 / target 按 prompt / prompt 直用）+ memory-ban 注入。纯函数。 */
export function buildPrompt(opt, cwd) {
  let prompt = opt.prompt ?? '';
  let taskPath = '';
  if (opt.task !== undefined) {
    taskPath = isAbsolute(opt.task) ? resolve(opt.task) : resolve(cwd, opt.task);
    if (!existsSync(taskPath)) throw new CliError(`任务包不存在: ${taskPath}`);
    const body = readFileSync(taskPath, 'utf8');
    prompt =
      `请严格按下面的任务包执行（任务包文件：${taskPath}）。\n` +
      '你是本项目唯一的业务代码写入者；任务包里的「禁止」与「交付物」是硬约束。\n' +
      '完成后必须把交付文档写到任务包指定的路径，并在最终回复里给出：交付清单 / 可复跑命令 / 原始输出 / 未决问题。\n\n' +
      '===== 任务包开始 =====\n' +
      body +
      '\n===== 任务包结束 =====';
  } else if (opt.target !== undefined) {
    /* 契约：本版按 prompt 处理（OpenCode 无 ZCode 那种自续跑 target 语义），不伪造。 */
    prompt = String(opt.target);
  }
  if (opt.memoryBan) prompt = `${prompt}\n\n${MEMORY_BAN_TEXT}`;
  return { prompt, taskPath, kind: opt.kind };
}

/**
 * `--list-models` / `--list-providers`：只读探测。
 * **stdout 只有裸模型 id（一行一个）** —— core 的探测侧要把每行当模型 id 解析，
 * 混入 `[opencode-run] …` 行会被当成第 13+ 个「模型」（Lead 实测发现的互操作缺陷）。
 * 档位（variants）只在显式 `--with-variants` 时**追加**打印（协议已登记的 `variants` 行）。
 */
async function listModels(cli, withVariants = false) {
  const plain = runCliSync(cli, ['models'], 60_000);
  if (!plain.ok && plain.stdout.trim() === '') {
    process.stderr.write(`${PREFIX} 读取 \`opencode models\` 失败: ${plain.error ?? `exit=${plain.status}`}\n`);
    if (plain.stderr.trim()) process.stderr.write(plain.stderr);
    return 1;
  }
  const all = parseModelsPlain(plain.stdout);
  const ids = filterOpenCodeIds(all);
  const dropped = all.filter((id) => !ids.includes(id));
  for (const id of ids) process.stdout.write(`${id}\n`);
  if (dropped.length > 0) {
    /* 过滤是「大声」的：core 的引擎判据只认 opencode/*（协议 OPENCODE_ID_RE），其余不会成为 OpenCode 通道。 */
    process.stderr.write(
      `${PREFIX} 提示：过滤掉 ${dropped.length} 个非 opencode/* 的模型 id（引擎判据 OPENCODE_ID_RE 只认 opencode/*）: ` +
        `${dropped.slice(0, 8).join(', ')}${dropped.length > 8 ? ' …' : ''}\n`,
    );
  }
  /* variants（思考强度档位）来自 `opencode models --verbose` 的真实元数据 —— 探测不到就不打，绝不编造。
   * **默认不打**（保持 stdout 纯净，只有裸 id）；仅在 `--with-variants` 时追加。 */
  if (withVariants) {
    const verbose = runCliSync(cli, ['models', '--verbose'], 60_000);
    if (verbose.ok) {
      const meta = parseModelsVerbose(verbose.stdout);
      for (const id of ids) {
        const vs = meta.get(id)?.variants ?? [];
        if (vs.length > 0) process.stdout.write(`${PREFIX} variants ${id}=${vs.join(',')}\n`);
      }
    } else {
      process.stderr.write(`${PREFIX} variants 探测失败（${verbose.error ?? `exit=${verbose.status}`}）：本轮不输出 variants 行\n`);
    }
  }
  return 0;
}

async function printVersion(cli) {
  const r = runCliSync(cli, ['--version'], 30_000);
  const line = r.stdout.trim().split(/\r?\n/)[0] ?? '';
  if (line === '') {
    process.stderr.write(`${PREFIX} 读取 \`opencode --version\` 失败: ${r.error ?? `exit=${r.status}`}\n`);
    if (r.stderr.trim()) process.stderr.write(r.stderr);
    return 1;
  }
  process.stdout.write(`${line}\n`);
  return 0;
}

/**
 * 执行一次真实派发。
 * @returns {Promise<number>} 退出码
 */
async function runOnce(opt, cli) {
  const cwd = resolve(opt.cwd ?? process.cwd());
  if (!existsSync(cwd)) {
    process.stderr.write(`${PREFIX} 工作目录不存在: ${cwd}\n`);
    return 1;
  }
  let assembled;
  try {
    assembled = buildPrompt(opt, cwd);
  } catch (e) {
    process.stderr.write(`${PREFIX} ${e instanceof CliError ? e.message : `组装 prompt 失败: ${e?.message ?? e}`}\n`);
    return 1;
  }
  const { prompt, taskPath } = assembled;
  const model = normalizeModelId(opt.model);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = opt.tag || stamp;
  const logs = join(cwd, 'collab', 'logs');
  mkdirSync(logs, { recursive: true });
  const base = join(logs, `opencode-run-${tag}-${stamp}`);
  const outLog = `${base}.out.log`;
  const errLog = `${base}.err.log`;
  const resultFile = `${base}.result.json`;

  for (const n of opt.compatNotes) process.stderr.write(`${PREFIX} 兼容：${n}\n`);
  if (opt.kind === 'target') {
    process.stderr.write(
      `${PREFIX} 说明：--target 按 prompt 处理（OpenCode 无 ZCode 的自续跑目标语义，本版不伪造目标模式）\n`,
    );
  }

  /* ── 启动行（契约 1~6，顺序固定） ── */
  process.stdout.write(`${PREFIX} tag=${tag} mode=${ENGINE} cwd=${cwd}\n`);
  process.stdout.write(`${PREFIX} cli=${cli}\n`);
  if (taskPath) process.stdout.write(`${PREFIX} task=${taskPath}\n`);
  process.stdout.write(`${PREFIX} provider=${ENGINE} model=${model}\n`);
  if (opt.variant) process.stdout.write(`${PREFIX} variant=${opt.variant} model=${model}\n`);
  if (opt.memoryBan) process.stdout.write(`${PREFIX} memory-ban=on（已在提示词末尾追加记忆禁令）\n`);
  /* --auto 的**可审计告知行**（Lead 裁决要求；协议未登记该形状 ⇒ core 侧按未知行处理，无副作用）。 */
  if (opt.auto) {
    process.stdout.write(`${PREFIX} auto=on（已放行所有未显式拒绝的权限；请确保工作目录可信）\n`);
  }
  if (opt.resume) {
    process.stdout.write(`${PREFIX} resume=${opt.resume}\n`);
    /* 契约安全默认：续跑不传 -m。实测 -s 与 -m 同给不报错，但仍按契约取安全默认并说明。 */
    process.stderr.write(
      `${PREFIX} 说明：--resume 时不传 -m/--model（沿用原会话模型；实测同给亦可，本脚本取安全默认）\n`,
    );
    if (opt.modelExplicit) {
      process.stderr.write(`${PREFIX} 警告：--model ${model} 对 --resume 不生效（已忽略，续跑沿用原会话模型）\n`);
    }
  }

  const args = buildRunArgs({ ...opt, prompt, cwd });
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const spec = spawnSpec(cli, args);

  writeFileSync(outLog, '');
  writeFileSync(errLog, '');
  const outFd = openSync(outLog, 'a');
  const errFd = openSync(errLog, 'a');

  /* ── 心跳（契约 9）：立即打一行（保证短任务也能被面板看到），其后每 10s 一行 ── */
  const progress = {
    stage: 'spawn', at: startedMs, chars: 0, tools: 0, lastTool: null, sessionId: null,
  };
  const heartbeat = setInterval(() => {
    process.stdout.write(`${formatProgressLine(progress, startedMs)}\n`);
  }, 10_000);
  process.stdout.write(`${formatProgressLine(progress, startedMs)}\n`);

  /* ── 上下文窗口：**顺序**解析（缓存优先 → 否则探测），绝不与 run 并发（见文件中部事故注释）。
   * 探测期间把 stage 标成 probe-models，面板能看出「在准备，不是在发呆」。 ── */
  const progressStageBeforeProbe = progress.stage;
  progress.stage = 'probe-models';
  progress.at = Date.now();
  let contextWindow = null;
  try {
    contextWindow = resolveContextWindow(cli, model);
  } catch {
    contextWindow = null; // 探测异常不影响主流程（⇒ 不打 context 行）
  }
  progress.stage = progressStageBeforeProbe;
  progress.at = Date.now();

  const agg = createAggregator();
  /* stdout/stderr 逐行**原样**落盘（out.log = 原始 NDJSON 流，err.log = 原始 stderr）——
   * 这样「未知事件降级透传」与「上游原始错误原样保留」两条硬约束都有落盘凭据。 */
  let child = null;
  let spawnError = null;
  try {
    child = spawn(spec.cmd, spec.argv, {
      cwd,
      env: { ...process.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    spawnError = e;
  }

  const stderrTail = [];
  let timedOut = false;
  let timer = null;
  const closed = new Promise((resolvePromise) => {
    if (!child) { resolvePromise({ code: null, signal: null }); return; }
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolvePromise(v); } };
    child.on('error', (e) => { spawnError = spawnError ?? e; done({ code: null, signal: null }); });
    child.on('close', (code, signal) => done({ code, signal }));
  });

  if (child) {
    const rlOut = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rlOut.on('line', (line) => {
      try { writeSync(outFd, `${line}\n`); } catch { /* 日志写失败不打断本轮 */ }
      const res = agg.handleLine(line);
      if (res?.known && STAGE_BY_EVENT[res.type]) {
        const st = STAGE_BY_EVENT[res.type];
        if (progress.stage !== st) { progress.stage = st; progress.at = Date.now(); }
        if (res.type === 'tool_use' && res.tool?.tool) progress.lastTool = res.tool.tool;
      }
      progress.chars = agg.counters.chars;
      progress.tools = agg.counters.tools;
      if (agg.counters.sessionId) progress.sessionId = agg.counters.sessionId;
    });
    const rlErr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    rlErr.on('line', (line) => {
      try { writeSync(errFd, `${line}\n`); } catch { /* ignore */ }
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    });
    timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opt.timeoutMin * 60_000);
  }

  /* ── 等子进程结束 ──────────────────────────────────────────────────────────────
   * ⚠️ 真机事故（Lead e2e 抓到的功能性 BUG，2026-10-16）：这里原先写着一个**固定 15s** 的兜底
   *   `setTimeout(…, 15_000)`。它把「慢但正常」的调用当挂死：`glm-5.3-flash-free` 首响要 ~14.2s
   *   （冷启动+排队），于是 15.0s 就被强制收尾 ⇒ exit 1 + stdout/stderr 各 0 字节（readline 是异步消费的，
   *   收尾时还来不及落盘），看起来像「静默退出」。**这是误杀，不是防挂死。**
   *   现在：正常收尾只认 `closed`；强制兜底必须**挂在 `--timeout-min` 之后再加宽限**
   *   （timeoutMin*60_000 + SETTLE_GRACE_MS，与 core 的 watchdog 宽限语义一致），
   *   且兜底时**绝不自称超时**（超时只由 `--timeout-min` 到点触发，exit 124 + `(超时)`）。 */
  let settleTimer = null;
  const settleDeadlineMs = opt.timeoutMin * 60_000 + SETTLE_GRACE_MS;
  const settled = await Promise.race([
    closed,
    new Promise((r) => { settleTimer = setTimeout(() => r({ code: null, signal: null, forced: true }), settleDeadlineMs); }),
  ]);
  if (settleTimer) clearTimeout(settleTimer); // 必须清：否则 race 的败者会让进程多挂 sett-time
  if (timer) clearTimeout(timer);
  clearInterval(heartbeat);
  try { closeSync(outFd); } catch { /* ignore */ }
  try { closeSync(errFd); } catch { /* ignore */ }

  const elapsedSec = (Date.now() - startedMs) / 1000;
  const summary = agg.summary();
  /* 兜底收尾（`--timeout-min` 未到点、只是 closed 迟迟不到）：用**子进程真实退出码**，拿不到才 1；
   * 仍在运行时先终止它，免得留下僵尸 opencode。 */
  const forcedSettle = settled.forced === true;
  let forcedKilled = false;
  if (forcedSettle && child && child.exitCode === null && child.signalCode === null) {
    killTree(child.pid);
    forcedKilled = true;
  }
  const childExitCode = Number.isInteger(child?.exitCode) ? child.exitCode : null;
  const exitCode = resolveExitCode({
    timedOut,
    spawnError: Boolean(spawnError),
    settledCode: settled.code,
    childExitCode,
  });
  const warnings = [...summary.warnings];
  if (forcedSettle) {
    warnings.push(
      `closed 事件在 ${(settleDeadlineMs / 1000).toFixed(0)}s 内未到达（--timeout-min 未到点）⇒ 兜底收尾 ` +
        `settleForced=true，退出码取子进程真实码（拿不到才 1）${forcedKilled ? '；已终止仍存活的进程树' : ''}`,
    );
  }
  /* contextWindow 已在 spawn 之前顺序解析好（缓存/顺序探测）；探测失败 = null ⇒ 不打 context 行（不编造）。 */

  const result = {
    tag,
    engine: ENGINE,
    kind: opt.kind,
    model,
    modelApplied: !opt.resume, // 续跑不传 -m ⇒ 实际模型沿用原会话
    variant: opt.variant ?? null,
    variantApplied: Boolean(opt.variant),
    sessionId: summary.sessionId,
    response: summary.response,
    tools: summary.tools,
    usage: { ...summary.usage },
    cost: summary.cost,
    elapsedSec: Number(elapsedSec.toFixed(1)),
    exit: exitCode,
    timedOut,
    /* 兜底收尾是与「超时」**不同**的一件事：timedOut=124 才是 --timeout-min 到点。 */
    settleForced: forcedSettle,
    settleForcedAfterSec: forcedSettle ? Number((settleDeadlineMs / 1000).toFixed(0)) : null,
    settleForcedKilled: forcedSettle ? forcedKilled : null,
    eventCounts: summary.eventCounts,
    unknownEvents: summary.unknownEvents,
    unknownEventCount: summary.unknownEventCount,
    parseErrorCount: summary.parseErrorCount,
    cwd,
    cli,
    startedAt,
    finishedAt: new Date().toISOString(),
    promptChars: prompt.length,
    responseChars: summary.responseChars,
    contextUsed: summary.contextUsed,
    contextWindow: Number.isFinite(contextWindow) ? contextWindow : null,
    turnCount: summary.turnCount,
    resume: opt.resume ?? null,
    stderrTail,
    warnings,
  };
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);

  /* ── 收尾行（契约 7 / 8 / 10 / 11） ── */
  process.stdout.write(`${formatUsageLine(summary.usage, summary.usageSeen)}\n`);
  const ctxLine = formatContextLine(summary.contextUsed, contextWindow, summary.turnCount);
  if (ctxLine) process.stdout.write(`${ctxLine}\n`);
  process.stdout.write(`${PREFIX} out=${outLog}\n`);
  process.stdout.write(`${PREFIX} err=${errLog}\n`);
  process.stdout.write(`${PREFIX} result=${resultFile}\n`);
  process.stdout.write(
    `${formatDoneLine({
      exit: exitCode,
      timedOut,
      elapsedSec,
      sessionId: summary.sessionId,
      model,
      responseChars: summary.responseChars,
    })}\n`,
  );

  /* ── 失败：上游**原始**错误原样透传到 stderr 与 err 日志（不改写/不美化；403/FreeTierError 尤其如此）── */
  if (exitCode !== 0) {
    if (spawnError) {
      process.stderr.write(`${PREFIX} 无法启动 opencode（${spec.cmd}）: ${spawnError?.message ?? spawnError}\n`);
    }
    let rawErr = '';
    try { rawErr = readFileSync(errLog, 'utf8'); } catch { /* ignore */ }
    if (rawErr !== '') {
      process.stderr.write(rawErr.endsWith('\n') || rawErr.endsWith('\r') ? rawErr : `${rawErr}\n`);
    } else {
      /* 上游也可能把错误放 stdout（NDJSON 事件里）⇒ 原样透传最后几行。 */
      let rawOut = '';
      try { rawOut = readFileSync(outLog, 'utf8'); } catch { /* ignore */ }
      const tail = rawOut.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-5);
      if (tail.length > 0) process.stderr.write(`${tail.join('\n')}\n`);
    }
    /* ⚠️ ZB-71（2026-10-18 真机实测）：**错误事件必须单独透传**。
     * 现场：免费模型被 Cloudflare 判定「abusive traffic」⇒ 上游发 `{"type":"error",…,"statusCode":403,…}`
     * 事件，err.log 是 **0 字节**（错误只在 stdout NDJSON 里），于是 core 的 classifyPause **看不到原文**
     * ⇒ 既没有可读的暂停原因、又被顺序派发/降级链当成"可换模型再试"的错误**反复重试**（实测撞了 10 遍）。
     * 现在把 error 事件的 `error.data.message` 与 statusCode 摘出来单独写一行 stderr（**原文照抄，不改写**），
     * 让 classifyPause 能认出来。 */
    const errEv = (summary.unknownEvents ?? []).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.type === 'error');
    if (errEv.length > 0) {
      const first = errEv[0];
      const msg = first?.error?.data?.message ?? first?.error?.message ?? '';
      const status = first?.error?.data?.statusCode ?? first?.error?.statusCode ?? '';
      process.stderr.write(`${PREFIX} 上游错误事件：${status ? `HTTP ${status} · ` : ''}${String(msg).replace(/\s+/g, ' ').slice(0, 300)}\n`);
    }
    if (timedOut) {
      process.stderr.write(`${PREFIX} 超时（${opt.timeoutMin}min）已终止进程树；stderr 尾部见 ${errLog}\n`);
    } else if (!spawnError) {
      process.stderr.write(`${PREFIX} 上游 opencode 退出码 ${exitCode}；原始输出见 ${errLog} / ${outLog}\n`);
    }
    /* ── 诊断：**先客观事实，再列可能原因（不断言）** ──
     * Lead 要求：不要像旧版那样直接断言「一定是并发进程」（那次 glm 失败其实是 15s 固定兜底误杀）。
     * 事实 = 退出码 / 耗时 / stdout 字节 / stderr 字节 / 事件数 / 是否超时 / 是否兜底收尾。 */
    const sizeOf = (p) => { try { return statSync(p).size; } catch { return -1; } };
    const outBytes = sizeOf(outLog);
    const errBytes = sizeOf(errLog);
    const eventKinds = Object.keys(summary.eventCounts ?? {}).length;
    process.stderr.write(
      `${PREFIX} 诊断：exit=${exitCode} elapsed=${elapsedSec.toFixed(1)}s stdout=${outBytes}B stderr=${errBytes}B ` +
        `事件类型数=${eventKinds} 超时=${timedOut ? '是' : '否'} 兜底收尾=${forcedSettle ? '是' : '否'}\n`,
    );
    if (outBytes === 0 && errBytes === 0 && !timedOut && !spawnError) {
      process.stderr.write(
        `${PREFIX} 诊断：上游**零输出**退出（stdout/stderr 都是 0 字节）。**可能**原因（本脚本不断言是哪一条）：` +
          '① 同一进程链里、run 进行中又起了一个 opencode 进程（曾实测到会打掉 run）；' +
          '② 上游排队/冷启动较慢、而进程被提前收尾（若上面「兜底收尾=是」则属此类）；' +
          '③ 上游 CLI 版本/配置问题、启动期崩溃。' +
          '排查：确认没有同链并发的 opencode 子进程；用同 argv、同工作目录手动重跑一次；' +
          '需要上游日志时自行加 `--print-logs --log-level DEBUG`（本脚本不默认加）。\n',
      );
    }
  }
  return exitCode;
}

/** 顶层入口（可执行时调用）。 */
async function main(argv) {
  let opt;
  try {
    opt = parseArgs(argv);
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`${PREFIX} ${e.message}\n`);
      process.stderr.write(`${PREFIX} 用法见: node collab-kit/opencode-run.mjs --help\n`);
      return 1;
    }
    process.stderr.write(`${PREFIX} 参数解析异常: ${e?.stack ?? e}\n`);
    return 1;
  }
  if (opt.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const cli = findOpencodeCli();
  if (!cli) {
    process.stderr.write(
      `${PREFIX} 找不到 opencode 可执行文件（已查 OPENCODE_CLI / npm 全局目录 / PATH）。\n` +
        `${PREFIX} 安装: npm install -g opencode-ai    或用 OPENCODE_CLI 指定路径。\n`,
    );
    return 1;
  }
  if (opt.listModels) return listModels(cli, opt.withVariants === true);
  if (opt.version) return printVersion(cli);
  return runOnce(opt, cli);
}

/** 仅当本文件是被直接执行（而非被测试 import）时才跑主流程。 */
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
      /* 兜底：stdout 写管道是异步的，用 process.exitCode 让事件循环自然排空；
       * 若仍有残留句柄，2s 后强制退出（unref 的定时器自身不阻止进程退出）。 */
      setTimeout(() => process.exit(code), 2_000).unref();
    })
    .catch((e) => {
      process.stderr.write(`${PREFIX} 未捕获异常: ${e?.stack ?? e}\n`);
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 2_000).unref();
    });
}

export default {
  PREFIX,
  ENGINE,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MIN,
  SETTLE_GRACE_MS,
  KNOWN_EVENTS,
  STAGE_BY_EVENT,
  MEMORY_BAN_TEXT,
  CliError,
  parseArgs,
  normalizeModelId,
  buildRunArgs,
  buildPrompt,
  resolveExitCode,
  createAggregator,
  aggregateNdjson,
  formatUsageLine,
  formatContextLine,
  formatProgressLine,
  formatDoneLine,
  parseModelsPlain,
  parseModelsVerbose,
  filterOpenCodeIds,
  findOpencodeCli,
  spawnSpec,
  runCliSync,
};
