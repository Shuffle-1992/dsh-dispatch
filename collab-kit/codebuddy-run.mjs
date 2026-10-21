#!/usr/bin/env node
/**
 * WorkBuddy / CodeBuddy 执行器（第四个引擎）：把一条自足任务交给本机真实的 WorkBuddy CLI
 * （`codebuddy`，npm 包 `@genie/agent-cli`）执行，把 `--output-format stream-json` 的 NDJSON
 * 事件流聚合成 **core 认识的行协议**输出。
 *
 * 为什么走**官方 CLI** 而不是反代（用户 2026-10-21 决策）：
 *   WorkBuddy 已开始限制"把账号登录态反代成 OpenAI/Anthropic 兼容接口"这类用法；官方 CLI 是
 *   产品自身的合法入口，不受此类限制影响。**本执行器不读写任何 WorkBuddy 凭据**，只 spawn 官方进程。
 *
 * 事实依据：全部来自 **真机抓包**（WorkBuddy 内置 CodeBuddy CLI v2.161.0，2026-10-21），
 * 不是文档推测。以下每条都有实测支撑：
 *
 *   · 调用形态：`codebuddy -p [--output-format stream-json] [--permission-mode X] [--model M]
 *     [--effort E] [--session-id S] [--add-dir D] … <正文>`
 *     —— `-p/--print` 是**布尔**旗标，正文是**位置参数**（与 Qoder 同形，与 OpenCode 的 `run <msg>` 不同）。
 *   · ⚠️ **启动坑（必踩）**：`bin/codebuddy` 默认 `require('../dist/codebuddy')`，而 WorkBuddy 的
 *     asar 解包里**只有 lite 包** `dist/codebuddy-lite-wb.mjs`（ESM, 9.4 MB）——
 *     不设 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` 就直接 `Error: Cannot find module '../dist/codebuddy'`。
 *     启动器内置逐级回退 `lite-wb → headless → full`，故**本执行器自动注入该环境变量**。
 *   · ⚠️ **入口形态**：`bin/codebuddy` 是**无扩展名**的 node 脚本（`#!/usr/bin/env node`）——
 *     Windows 下不能直接 spawn，必须前置 `process.execPath`（见 spawnTarget 的 shebang 判定）。
 *   · 事件谱（真机实测）：
 *       system/init → system/status → assistant → **result**
 *     `system/init` 在**鉴权失败之前**就会发出，字段实测为：
 *       type/subtype/uuid/session_id/**apiKeySource**（如 `www.workbuddy.cn`）/cwd/tools[44]/mcp_servers[]/
 *       model/permissionMode（**驼峰**，如 `acceptEdits`）/slash_commands[]/output_style
 *   · `result` 是权威收尾：`subtype`（`success` / `error_during_execution`）/`is_error`/`result`/
 *     `duration_ms`/`num_turns`/`usage{input_tokens,output_tokens,cache_read_input_tokens,…}`/
 *     `modelUsage{<model>:{contextWindow,maxOutputTokens,…}}`/`permission_denials[]`/`errors[]`/`total_cost_usd`。
 *   · ⚠️ **登录坑（与 Qoder 同类）**：CLI 登录态与**桌面应用登录态互相独立**。
 *     未登录时 `-p` 的 result 为 `is_error:true` 且 `errors:["Authentication required. Please use /login …"]`。
 *     CLI **没有** `login` 子命令 —— 登录是在**交互会话**里敲 `/login`（浏览器 OAuth，斜杠命令表里确有 `login`）。
 *   · ⚠️ **档位**：`--effort <level>`，合法值由 CLI 自己在 `--help` 里声明
 *     （实测 `minimal, low, medium, high, xhigh, max`）⇒ 本执行器**解析 help 文本**，不写死枚举。
 *   · ⚠️ **模型清单**：CLI **没有** `--list-models` 子命令 —— 但 `--help` 里声明了
 *     `Currently supported: (auto, glm-5v-turbo, …)` ⇒ 同样从 help 解析（CLI 自己声明，随版本更新）。
 *
 * 硬约束（与其他执行器一致）：
 *   · **不写用户自己的 agent 数据**（不写 `~/.workbuddy` / `~/.codebuddy*`），只读探测；
 *   · 未知事件类型 / 坏 JSON 行 **绝不止损整轮**（降级透明，记 warning 继续）；
 *   · 权限放行**默认关**：只有 core 显式传 `--auto` 才映射为 `--permission-mode bypassPermissions`。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prefixFor } from './run-line-protocol.mjs';
import { discoverEngine } from './engine-discover.mjs';

const PREFIX = prefixFor('codebuddy'); // `[codebuddy-run]`
const HERE = dirname(fileURLToPath(import.meta.url));

/** 输出协议行（core 按前缀解析；与另三个执行器同形）。 */
const out = (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
/** 人类可读的说明行（core 会把不认识的已知信息行降级处理，不会当错误）。 */
const note = (s) => out(`${PREFIX} ${s}`);

class CliError extends Error {}

/* ------------------------------------------------------------------ *
 * 启动环境（lite-wb 包）—— 本执行器的**唯一**必踩坑
 * ------------------------------------------------------------------ */

/**
 * 子进程环境：自动注入 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`。
 *
 * 为什么必须（真机实测）：WorkBuddy 解包目录里只有 `dist/codebuddy-lite-wb.mjs`，
 * 而 `bin/codebuddy` 默认 require `../dist/codebuddy` ⇒ 不设该变量直接 MODULE_NOT_FOUND。
 * 已显式设置则**尊重用户值**（不覆盖）：用户可能自备了完整 bundle。
 */
export function codebuddyEnv(env = process.env) {
  const merged = { ...env };
  const cur = String(merged.CODEBUDDY_FORCE_LITE_WB_BUNDLE ?? '').trim();
  if (!cur) merged.CODEBUDDY_FORCE_LITE_WB_BUNDLE = '1';
  return merged;
}

/* ------------------------------------------------------------------ *
 * CLI 发现（复用 engine-discover，避免两份候选表漂移）
 * ------------------------------------------------------------------ */

/** 异步版发现（main 里用）。环境变量 `CODEBUDDY_CLI` 最高优先（测试注入假 CLI 也用这个）。 */
export async function discoverCodebuddy(env = process.env) {
  const explicit = String(env.CODEBUDDY_CLI ?? '').trim();
  if (explicit) {
    const p = resolve(explicit);
    if (!existsSync(p)) throw new CliError(`CODEBUDDY_CLI 指向的文件不存在：${p}`);
    return { cli: p, version: null, reason: 'CODEBUDDY_CLI 显式指定', found: true };
  }
  const r = await discoverEngine('codebuddy', { env: codebuddyEnv(env), timeoutMs: 20000 });
  if (!r.found) throw new CliError(`未找到 WorkBuddy / CodeBuddy CLI。${r.reason}`);
  return { cli: r.entry, version: r.version, reason: r.reason, loggedIn: r.loggedIn, found: true };
}

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

export function parseArgs(argv) {
  const opt = {
    kind: null, task: null, prompt: null, target: null,
    model: null, cwd: null, tag: null, timeoutMin: 30,
    resume: null, auto: false, permissionMode: null,
    effort: null, addDirs: [], memoryBan: false,
    listModels: false, version: false, help: false,
    noSessionPersistence: false, maxTurns: null,
    withEfforts: false,
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
      case '--task': opt.task = next(); opt.kind = 'task'; break;
      case '--prompt': opt.prompt = next(); opt.kind = opt.kind ?? 'prompt'; break;
      case '--target': opt.target = next(); opt.kind = 'target'; break;
      case '--model': case '-m': opt.model = next(); break;
      case '--cwd': opt.cwd = next(); break;
      case '--add-dir': opt.addDirs.push(next()); break;
      case '--tag': opt.tag = next(); break;
      case '--timeout-min': opt.timeoutMin = Number(next()); break;
      case '--resume': opt.resume = next(); break;
      /* 思考强度：CLI 的原生旗标是 `--effort`；另两个别名是"另一个引擎叫法"，兼容以便 core 复用同一套传参。 */
      case '--effort': opt.effort = next(); break;
      case '--reasoning-effort':
        opt.effort = next();
        opt.compatNotes.push(`--reasoning-effort ${opt.effort} ⇒ 按 CodeBuddy 的 --effort ${opt.effort} 透传`);
        break;
      case '--reasoning-level': {
        const level = String(next()).trim();
        if (level === 'agent') {
          opt.compatNotes.push('--reasoning-level agent ⇒ 不传 --effort（用 CLI 默认档）');
        } else {
          opt.effort = level;
          opt.compatNotes.push(`--reasoning-level ${level} ⇒ 按 CodeBuddy 的 --effort ${level} 透传`);
        }
        break;
      }
      case '--permission-mode': opt.permissionMode = next(); break;
      case '--max-turns': opt.maxTurns = Number(next()); break;
      case '--memory-ban': opt.memoryBan = true; break;
      case '--no-session-persistence': opt.noSessionPersistence = true; break;
      /* --auto：**默认关**，只有 core 显式传才放行（硬约束「不默认开」）。 */
      case '--auto': opt.auto = true; break;
      case '--list-models': case '--list-providers': opt.listModels = true; break;
      /* 与 qoder-run 的 `--with-efforts` 同构：探测模式下**追加**打印档位表行。默认不打。 */
      case '--with-efforts': case '--with-variants': opt.withEfforts = true; break;
      case '--version': case '-v': opt.version = true; break;
      case '--help': case '-h': opt.help = true; break;
      /* 明确不支持 ⇒ fail-fast（绝不静默忽略，与另两个执行器同纪律）。 */
      case '--memory-bench':
        throw new CliError('codebuddy-run 不支持 --memory-bench（CodeBuddy 无 ZCode 记忆库/自动 Memory 提取概念）');
      case '--mode':
        next();
        throw new CliError('codebuddy-run 不支持 --mode（CodeBuddy 无 build/edit/plan/yolo 模式概念；权限用 --permission-mode）');
      /* 兼容令牌（记 stderr 说明后忽略，仍然"大声"）。 */
      case '--provider': {
        const v = String(next()).trim();
        if (v !== 'codebuddy' && v !== 'workbuddy') {
          throw new CliError(`--provider 只接受 codebuddy / workbuddy（收到: ${v}）—— CodeBuddy 引擎由本脚本自身决定`);
        }
        opt.compatNotes.push(`--provider ${v} 已忽略（本脚本即 CodeBuddy 引擎）`);
        break;
      }
      case '--no-ledger':
        opt.compatNotes.push('--no-ledger 已忽略（codebuddy-run 本就不写 dispatch-runs.jsonl 台账）');
        break;
      default:
        unknown.push(a);
    }
  }
  if (unknown.length) throw new CliError(`未知参数: ${unknown.join(', ')}（用法见 ${PREFIX} --help）`);
  if (opt.withEfforts && !opt.listModels) {
    throw new CliError('--with-efforts 仅在 --list-models / --list-providers 下有效');
  }
  return opt;
}

/* ------------------------------------------------------------------ *
 * 权限模式（**真机实测的映射与回落检测**）
 * ------------------------------------------------------------------ */

/**
 * CLI 参数值 → `init.permissionMode` 的回传值。
 *
 * ⚠️ 真机实测（2026-10-21）：CodeBuddy 的 `--permission-mode` 合法值是 **camelCase**
 * （`acceptEdits` / `bypassPermissions` / `default` / `plan` / `dontAsk` / `auto`），
 * 而 `init.permissionMode` 回传**同一个驼峰值** ⇒ 映射表是恒等映射。
 * 保留这张表是为了：① 接受 snake_case 输入（core/旧参数/人手工传）并归一；
 * ② 与 qoder-run 的 `detectPermissionFallback` 同构，将来若回传形态变化只改一处。
 */
export const PERMISSION_MODE_CANONICAL = {
  default: 'default',
  plan: 'plan',
  auto: 'auto',
  accept_edits: 'acceptEdits',
  accepted_edits: 'acceptEdits',
  acceptEdits: 'acceptEdits',
  bypass_permissions: 'bypassPermissions',
  bypassPermissions: 'bypassPermissions',
  dont_ask: 'dontAsk',
  dontAsk: 'dontAsk',
};

/** 把任意写法的权限模式归一成 CLI 认的驼峰值；未知写法**原样返回**（让 CLI 自己报错，不静默改写）。 */
export function canonicalPermissionMode(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return PERMISSION_MODE_CANONICAL[s] ?? PERMISSION_MODE_CANONICAL[s.toLowerCase()] ?? s;
}

/**
 * 决定本次要用的权限模式（纯函数，便于测试）。
 *   ① `--permission-mode` 显式给了 ⇒ 用它（归一后）；
 *   ② `--auto` ⇒ `bypassPermissions`（全放行，仅显式要求时）；
 *   ③ 默认 ⇒ **`acceptEdits`** —— 无头模式下这是"开箱即用"的关键（可改工作目录内文件）。
 */
export function decidePermissionMode(opt) {
  if (opt.permissionMode) return canonicalPermissionMode(opt.permissionMode);
  if (opt.auto) return 'bypassPermissions';
  return 'acceptEdits';
}

/**
 * 判断权限模式是否被**回落**。
 * @returns {{fellBack:boolean, expected:string, actual:string|null, warning:string|null}}
 */
export function detectPermissionFallback(requested, reportedMode) {
  const expected = canonicalPermissionMode(requested) ?? requested;
  const actual = reportedMode == null ? null : canonicalPermissionMode(reportedMode) ?? String(reportedMode);
  if (!actual) {
    return { fellBack: false, expected, actual: null, warning: `${PREFIX} 未从 init 事件读到 permissionMode，无法确认权限模式是否生效（请求 ${requested}）` };
  }
  if (actual === expected) return { fellBack: false, expected, actual, warning: null };
  return {
    fellBack: true,
    expected,
    actual,
    warning: `${PREFIX} 权限模式被回落：请求 ${requested}（回传应为 ${expected}），实际 init.permissionMode=${actual}`
      + '。若非默认模式未生效，写操作可能被静默拒绝（任务报成功但文件没变）。'
      + '处理：改用 --permission-mode bypassPermissions（= auto:true）明确全放行，或在 CodeBuddy 里信任该目录。',
  };
}

/* ------------------------------------------------------------------ *
 * 参数表构造（纯函数，便于离线测试断言）
 * ------------------------------------------------------------------ */

/**
 * 构造 CodeBuddy CLI 的参数表。
 * 形态：`-p --output-format stream-json [--model M] [--effort E] [--permission-mode X]
 *        [--add-dir D]… [--session-id S] [--max-turns N] [--no-session-persistence] <正文>`
 *
 * 正文是**位置参数**（放最后）。续跑用 `--session-id <id>`（`--resume` 是"选会话"语义，不用于续跑）。
 */
export function buildCodebuddyArgs(opt) {
  const args = ['-p', '--output-format', 'stream-json'];
  /* ⚠️ 顺序无关紧要，但正文必须最后 —— 它可能以 `-` 开头，放在旗标之间会被当成选项。 */
  if (opt.resume) args.push('--session-id', String(opt.resume));
  if (opt.model) args.push('--model', String(opt.model));
  if (opt.effort) args.push('--effort', String(opt.effort));
  args.push('--permission-mode', decidePermissionMode(opt));
  for (const d of opt.addDirs ?? []) args.push('--add-dir', String(d));
  if (opt.maxTurns != null && Number.isFinite(opt.maxTurns)) args.push('--max-turns', String(opt.maxTurns));
  if (opt.noSessionPersistence) args.push('--no-session-persistence');
  const body = opt.kind === 'target' ? String(opt.target ?? '') : String(opt.prompt ?? '');
  if (body) args.push(body);
  return args;
}

/* ------------------------------------------------------------------ *
 * stream-json 聚合器（未知类型/坏行绝不抛）
 * ------------------------------------------------------------------ */

const UNKNOWN_CAP = 20;

/**
 * 创建 stream-json 聚合器。`handleLine(raw)` **永不抛**：
 *   · 已知事件 → 累积（sessionId / 正文 / 工具 / token 用量 / 权限模式 / 思考块）；
 *   · 未知 type 或坏 JSON → 记 warning 后继续。
 */
export function createAggregator() {
  const warnings = [];
  const unknownEvents = [];
  const eventCounts = Object.create(null);
  const texts = [];
  const toolNames = [];
  /** **本次实际调用**的工具名（允许重复 —— 调用次数本身是信号）。 */
  const toolCalls = [];
  /** 观测到的思考块（档位是否真生效的唯一可观测信号）。 */
  let thinkingBlocks = 0;
  let thinkingChars = 0;
  let sessionId = null;
  let model = null;
  let permissionMode = null;
  let apiKeySource = null;
  let cliVersion = null;
  let outputStyle = null;
  let durationMs = null;
  let numTurns = null;
  let isError = null;
  let stopReason = null;
  let resultText = null;
  let permissionDenials = [];
  let errors = [];
  let totalCostUsd = null;
  let tokens = { in: null, out: null, cacheRead: null, cacheCreate: null };
  let contextWindow = null;
  let maxOutputTokens = null;
  let unknownCount = 0;
  let parseErrors = 0;
  const counters = { sessionId: null, chars: 0, tools: 0 };

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const noteUnknown = (line) => { unknownCount += 1; if (unknownEvents.length < UNKNOWN_CAP) unknownEvents.push(line); };

  function handleLine(raw) {
    const line = typeof raw === 'string' ? raw.replace(/\r$/, '') : '';
    if (line.trim() === '') return { type: null, known: false, empty: true };
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      /* 硬约束：单行解析失败绝不止损整轮 —— 原样已在 out.log。 */
      parseErrors += 1;
      warnings.push(`JSON 解析失败（该行已原样保留在 out.log）: ${line.slice(0, 200)}`);
      noteUnknown(line);
      return { type: null, known: false, parseError: true };
    }
    if (ev === null || typeof ev !== 'object') { noteUnknown(line); return { type: null, known: false }; }

    if (ev.session_id && !sessionId) { sessionId = String(ev.session_id); counters.sessionId = sessionId; }
    const type = typeof ev.type === 'string' ? ev.type : null;
    const subtype = typeof ev.subtype === 'string' ? ev.subtype : null;
    const key = subtype ? `${type}/${subtype}` : type;
    if (key) eventCounts[key] = (eventCounts[key] ?? 0) + 1;

    /* ---- system/init：引擎元信息 + 权限模式（回落检测的输入）----
     * 真机字段：uuid/session_id/apiKeySource/cwd/tools[]/mcp_servers[]/model/permissionMode/
     * slash_commands[]/output_style。**鉴权失败前也会发出**，可放心依赖。 */
    if (type === 'system' && subtype === 'init') {
      if (ev.apiKeySource) apiKeySource = String(ev.apiKeySource);
      if (ev.model) model = String(ev.model);
      if (ev.permissionMode) permissionMode = String(ev.permissionMode); // 注意：驼峰
      if (ev.output_style) outputStyle = String(ev.output_style);
      if (ev.version) cliVersion = String(ev.version);
      if (Array.isArray(ev.tools)) toolNames.push(...ev.tools.map(String));
      counters.tools = toolNames.length;
      return { type, subtype, known: true, init: true };
    }

    /* ---- assistant：text / thinking / tool_use 内容块（text 才是回答正文）----
     * 兼容两种形状：顶层 `content[]`（Qoder 风格）与 `message.content[]`（Claude 风格）。 */
    if (type === 'assistant') {
      const blocks = Array.isArray(ev.content) ? ev.content
        : (ev.message && Array.isArray(ev.message.content) ? ev.message.content : []);
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string') { texts.push(b.text); counters.chars += b.text.length; }
        else if (b.type === 'thinking' && typeof b.thinking === 'string') {
          if (b.thinking.trim()) { thinkingBlocks += 1; thinkingChars += b.thinking.length; }
        }
        else if (b.type === 'tool_use' && b.name) { toolNames.push(String(b.name)); toolCalls.push(String(b.name)); counters.tools = toolNames.length; }
      }
      return { type, known: true, assistant: true };
    }

    /* ---- result：权威收尾 ---- */
    if (type === 'result') {
      if (typeof ev.result === 'string') resultText = ev.result;
      if (typeof ev.is_error === 'boolean') isError = ev.is_error;
      if (typeof ev.subtype === 'string') stopReason = ev.subtype;
      if (ev.duration_ms != null) durationMs = num(ev.duration_ms);
      if (ev.num_turns != null) numTurns = num(ev.num_turns);
      if (ev.total_cost_usd != null) totalCostUsd = num(ev.total_cost_usd);
      if (Array.isArray(ev.permission_denials)) permissionDenials = ev.permission_denials;
      if (Array.isArray(ev.errors)) errors = ev.errors.map(String);
      const u = ev.usage ?? {};
      /* 真机 schema 自带真实 token（鉴权失败时全 0 —— 只把**非零**当有效信号，不谎报 0 消耗）。 */
      const pick = (v) => (num(v) != null && num(v) > 0 ? num(v) : null);
      tokens = {
        in: pick(u.input_tokens), out: pick(u.output_tokens),
        cacheRead: pick(u.cache_read_input_tokens), cacheCreate: pick(u.cache_creation_input_tokens),
      };
      if (ev.modelUsage && typeof ev.modelUsage === 'object') {
        const first = Object.keys(ev.modelUsage)[0];
        if (first) {
          if (!model) model = first;
          const mu = ev.modelUsage[first] ?? {};
          if (num(mu.contextWindow) != null) contextWindow = num(mu.contextWindow);
          if (num(mu.maxOutputTokens) != null) maxOutputTokens = num(mu.maxOutputTokens);
        }
      }
      if (ev.session_id && !sessionId) { sessionId = String(ev.session_id); counters.sessionId = sessionId; }
      return { type, known: true, result: true };
    }

    /* ---- 其它 system 子类型（status 等）：正常生命周期事件，降级透明（不落 warning）。 ---- */
    if (type === 'system') return { type, subtype, known: true, system: true };

    /* ---- `user` 事件（工具结果回灌）：正常生命周期事件，不是异常。 ---- */
    if (type === 'user') return { type, known: true, user: true };

    noteUnknown(line);
    return { type, known: false };
  }

  function summary() {
    const text = resultText != null ? resultText : texts.join('');
    const usedTokens = (tokens.in != null || tokens.cacheRead != null)
      ? (tokens.in ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheCreate ?? 0)
      : null;
    return {
      sessionId, model, permissionMode, apiKeySource, cliVersion, outputStyle,
      durationMs, numTurns, isError, stopReason, errors,
      response: text, responseChars: text.length,
      toolNames, toolCalls, permissionDenials,
      thinkingBlocks, thinkingChars,
      totalCostUsd, tokens, contextWindow, maxOutputTokens,
      contextUsed: usedTokens,
      eventCounts, unknownEvents, unknownEventCount: unknownCount, parseErrorCount: parseErrors,
      warnings,
    };
  }
  return { handleLine, summary, counters };
}

/* ------------------------------------------------------------------ *
 * 只读探测（--list-models / --version）
 * ------------------------------------------------------------------ */

export function whichOnPath(name, env = process.env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of String(env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const ext of exts) {
      const p = join(d, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** 读文件头若干字节（判断 shebang）。失败返回 ''。 */
function readHead(p, bytes = 128) {
  let fd;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd != null) { try { closeSync(fd); } catch { /* 尽力 */ } }
  }
}

const SHEBANG_CACHE = new Map();
/** 该文件是否是 node 脚本（以 `#!…node` 开头）。缓存：每个 CLI 只需读一次。 */
function isNodeShebang(p) {
  if (SHEBANG_CACHE.has(p)) return SHEBANG_CACHE.get(p);
  const head = readHead(p);
  /* ⚠️ 用 `.*` 而不是 `\S*`：真实 shebang 是 `#!/usr/bin/env node` —— `\S*` 会把
   * `/usr/bin/env` 整个吃掉，紧接着要匹配的 `\bnode\b` 面对的是空格，于是永远失配
   * （本引擎第一版就踩了这个坑，表现为"入口被判成 exe 而不前置 node"）。 */
  const yes = /^#!.*\bnode\b/.test(head);
  SHEBANG_CACHE.set(p, yes);
  return yes;
}

/**
 * 构造 spawn 目标（**唯一权威**，探测与执行共用）。
 *
 * ⚠️ 真机踩到（本引擎特有）：`bin/codebuddy` 是**无扩展名**的 node 脚本
 * （`#!/usr/bin/env node`）—— Windows 下直接 spawn 会失败，必须前置 `process.execPath`。
 * 判据用 **shebang** 而不是"无扩展名就算脚本"：`~/.local/bin/opencode` 这类 POSIX 安装脚本
 * 也可能是无扩展名的，若一律前置 node 就会把它们跑坏。
 * `.cmd` / `.bat` 必须经 shell（否则 EFTYPE）。
 */
export function spawnTarget(cli, args) {
  const base = basename(String(cli));
  const ext = extname(base).toLowerCase();
  const isScript = /\.(cjs|mjs|js)$/i.test(base) || (ext === '' && isNodeShebang(cli));
  if (isScript) return { cmd: process.execPath, argv: [cli, ...args], shell: false };
  const needShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(base);
  return { cmd: needShell ? `"${cli}"` : cli, argv: args, shell: needShell };
}

/** 跑一个只读子命令（带超时，不抛）。 */
export function probe(cli, args, timeoutMs = 20000) {
  const t = spawnTarget(cli, args);
  try {
    const r = spawnSync(t.cmd, t.argv, {
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell: t.shell,
      env: codebuddyEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (e) {
    return { code: null, stdout: '', stderr: e?.message ?? String(e) };
  }
}

/**
 * 从 CLI 自己的 `--help` 文本里解析**模型清单**。
 *
 * 为什么这么拿（**实测依据**，别改成写死表）：
 *   · CLI **没有** `--list-models` 子命令（`--help` 的子命令表里没有）；
 *   · 鉴权先于参数校验 ⇒ 用非法 `--model` 逼"权威合法值"的做法**拿不到**（只会得到
 *     `Authentication required`，实测）；
 *   · 但 `--help` 里 CLI 自己声明了：`--model <model> … Currently supported: (auto, glm-5v-turbo, …)`
 *     ⇒ 这是 **CLI 自身声明**（随版本更新），不是我们写死的枚举。
 * 解析不到 ⇒ 返回 []（调用方**不编造**）。
 */
export function parseHelpModels(helpText) {
  const m = String(helpText ?? '').match(/Currently supported:\s*\(([^)]+)\)/i);
  if (!m) return [];
  return [...new Set(m[1].split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9][A-Za-z0-9._:\-]*$/.test(s)))];
}

/**
 * 从 CLI 自己的 `--help` 文本里解析**思考档位**（`--effort` 的合法值）。
 * 原文：`--effort <level>  Reasoning effort level (minimal, low, medium, high, xhigh, max)`
 */
export function parseHelpEfforts(helpText) {
  const m = String(helpText ?? '').match(/Reasoning effort level\s*\(([^)]+)\)/i);
  if (!m) return [];
  return [...new Set(m[1].split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(s)))];
}

/** 取一次 help 文本（带缓存：探测与 --list-models 共用，避免重复 spawn）。 */
let HELP_CACHE = null;
function helpText(cli) {
  if (HELP_CACHE != null) return HELP_CACHE;
  const r = probe(cli, ['--help'], 30000);
  HELP_CACHE = `${r.stdout}\n${r.stderr}`;
  return HELP_CACHE;
}

/** `--list-models`：只吐**裸模型名**（core 会加 `codebuddy/` 前缀）。不写死枚举。 */
export function listModels(cli, opt = {}) {
  const text = helpText(cli);
  const models = parseHelpModels(text);
  if (models.length === 0) {
    note(`--help 里没有 \`Currently supported:\` 声明，拿不到模型清单（不编造）。help 前 200 字：${text.trim().slice(0, 200)}`);
    return 1;
  }
  for (const m of models) out(m); // 裸模型名（每行一个），与另两个执行器的 --list-models 同契约
  /* 如实标注：这份清单是 **CLI 静态声明**，登录后账号实际可用的模型可能不同（额度/套餐相关）。
   * 不把"声明可用"谎报成"账号可用" —— 面板上会显示 note。 */
  note(`模型清单来自 CLI 自身 --help 的静态声明（共 ${models.length} 个）；登录后账号实际可用集合可能不同`);

  if (opt.withEfforts) {
    const efforts = parseHelpEfforts(text);
    if (efforts.length) {
      /* 格式与 qoder-run 的 `reasoning-efforts` 同族，core 的 levels 正则可直接解析；
       * 给的是**引擎级**合法集合（逐模型子集 CLI 未声明，不编造）。
       * ⚠️ 真机确认过：`--effort` 与 `--model` 的校验都在鉴权之后，故无法逐模型实测。 */
      for (const m of models) out(`${PREFIX} reasoning-efforts ${m}=${efforts.join(',')}`);
    } else {
      note('档位探测失败（--help 里没有 `Reasoning effort level (...)` 声明）：不输出 reasoning-efforts 行（不编造档位）');
    }
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 * 主执行
 * ------------------------------------------------------------------ */

export function taskBody(opt) {
  if (opt.kind === 'task') {
    const p = resolve(String(opt.task));
    if (!existsSync(p)) throw new CliError(`任务包不存在: ${p}`);
    let text = readFileSync(p, 'utf8');
    if (opt.memoryBan) text += '\n\n---\n【硬约束】不要写任何 CLI 的记忆库/自动记忆提取；不要修改 ~/.workbuddy 或 ~/.codebuddy* 下的用户数据。\n';
    return text;
  }
  if (opt.kind === 'target') return `目标：${opt.target}\n\n请自主规划并执行，直到达成该目标。`;
  let text = String(opt.prompt ?? '');
  if (opt.memoryBan) text += '\n\n【硬约束】不要写任何 CLI 的记忆库/自动记忆提取；不要修改 ~/.workbuddy 或 ~/.codebuddy* 下的用户数据。\n';
  return text;
}

async function runOnce(opt, cli) {
  const body = taskBody(opt);
  const args = buildCodebuddyArgs({ ...opt, prompt: body, target: body });
  const requestedMode = decidePermissionMode(opt);

  note(`tag=${opt.tag ?? '(none)'} mode=codebuddy cwd=${opt.cwd ?? process.cwd()}`);
  note(`cli=${cli}`);
  if (opt.model) note(`model=${opt.model}`);
  if (opt.effort) note(`effort=${opt.effort}`);
  note(`permission-mode=${requestedMode}${opt.auto ? '（--auto 显式放行）' : '（默认：无头下可改工作目录内文件）'}`);
  if (opt.resume) note(`resume=${opt.resume}`);
  for (const cn of opt.compatNotes) process.stderr.write(`${PREFIX} 说明：${cn}\n`);
  if (opt.auto) note('auto=on（已映射为 --permission-mode bypassPermissions：放行所有未显式拒绝的权限；请确保工作目录可信）');

  const agg = createAggregator();
  const started = Date.now();
  let child;
  try {
    const t = spawnTarget(cli, args);
    child = spawn(t.cmd, t.argv, {
      cwd: opt.cwd ? resolve(opt.cwd) : undefined,
      env: codebuddyEnv(process.env),
      shell: t.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new CliError(`spawn 失败：${e?.message ?? e}`);
  }

  /* 心跳：每 10s 一行 progress（让面板能看到"在做什么 + 多久没动静"）。
   * 绝不因为心跳而额外开子进程 —— 并发 CLI agent 会互相干扰。 */
  let timedOut = false;
  const killTree = (pid) => { try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch { try { process.kill(pid); } catch { /* 尽力 */ } } };
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opt.timeoutMin * 60_000);
  const hb = setInterval(() => {
    const s = agg.summary();
    out(`${PREFIX} progress stage=run elapsed=${Math.round((Date.now() - started) / 1000)}s chars=${s.responseChars} tools=${s.toolCalls.length} stageAgo=0s${s.sessionId ? ` session=${s.sessionId}` : ''}`);
  }, 10_000);
  hb.unref?.();

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      process.stdout.write(`${line}\n`);   // 原样转发（core/out.log 保留原始事件）
      agg.handleLine(line);
    }
  });
  let errBuf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errBuf += chunk; process.stderr.write(chunk); });

  const { code } = await new Promise((done) => {
    child.on('error', () => done({ code: null }));
    child.on('close', (c) => done({ code: c }));
  });
  clearTimeout(timer);
  clearInterval(hb);
  if (buf.trim()) { process.stdout.write(`${buf}\n`); agg.handleLine(buf); }

  const s = agg.summary();

  /* ---- 权限回落检测 ---- */
  const fb = detectPermissionFallback(requestedMode, s.permissionMode);
  if (fb.warning) process.stderr.write(`${fb.warning}\n`);
  note(`permission-mode-requested=${requestedMode} reported=${s.permissionMode ?? '(unknown)'}${fb.fellBack ? ' FELLBACK' : ''}`);

  /* ---- ZB-84：**CLI 未登录**（真机实测：CLI 登录态与桌面应用独立）----
   *
   * 现场原文（result.errors）：
   *   `Authentication required. Please use /login command to sign in to your account`
   * 为什么必须显式打出来：core 的 classifyPause 只看 stdout/stderr（不看 result.json），
   * 而这一行在 stdout 里是 **JSON 的 errors 字段**，不解析就读不到 ⇒ 会退化成 failed/unknown，
   * 用户完全不知道"只是没登录"。这里直接把原因 + 可执行的登录步骤写进 stderr。
   * ⚠️ 只在**确实命中**时打（无命中不产生噪音）。 */
  const AUTH_RE = /Authentication required|Please use \/login|not logged in|未登录|请先登录/i;
  const authHit = AUTH_RE.test(`${s.errors.join(' ')} ${s.response}`);
  if (authHit) {
    process.stderr.write(`${PREFIX} CLI 未登录（**不是**任务失败、也不是权限/沙箱问题）：WorkBuddy CLI 的登录态与`
      + '桌面应用**互相独立**，CLI 必须单独登录一次。\n'
      + '处理（一次性；两种方式任选，都不需要手改任何文件）：\n'
      + `  ① 最稳（不依赖 TUI）：node "${cli}" --serve\n`
      + '     它会打印形如 `http://127.0.0.1:<port>/?password=…` 的 Web UI 链接，浏览器打开并在其中登录，\n'
      + '     完成后 Ctrl+C 停掉服务即可（实测可起，2026-10-21）。\n'
      + `  ② 真终端里交互启动：node "${cli}"，进入界面后输入斜杠命令 /login。\n`
      + '     ⚠️ /login 是 **CLI 界面里的斜杠命令**，不是 PowerShell/cmd 命令 ——\n'
      + '        在 shell 里直接敲 /login 会报「无法将 /login 项识别为 cmdlet…」（真机踩过）。\n'
      + '  登录成功后无头派发即自动可用；凭据由 CLI 自己保存在 ~/.codebuddy/ 下（派发台不读不写）。\n');
  }

  /* ---- 静默假成功检测（与 qoder-run 同一套经验）---- */
  const SILENT_FAIL_RE = /denied|permission|allow it|blocked|approval|requires confirmation|outside the workspace|not allowed/i;
  if (!s.isError && code === 0 && (s.permissionDenials ?? []).length === 0 && SILENT_FAIL_RE.test(s.response)) {
    process.stderr.write(`${PREFIX} 警告：任务报成功，但回答里出现"被拒绝/被拦"字样且 permission_denials 为空 —— 这是**静默假成功**的典型特征（文件很可能没改）。排查：① 权限（改用 auto:true）；② 路径语法（cwd 是否含 Windows 8.3 短名如 ADMINI~1 ⇒ 请用长路径）。\n`);
  }
  /* 反向信号：**零工具调用**。声明要写文件的任务却一个工具都没调 ⇒ 几乎必然是静默失败。 */
  if (!s.isError && code === 0 && (s.toolCalls ?? []).length === 0 && /create|write|edit|file|文件|创建|写入|修改/i.test(String(opt.prompt ?? opt.target ?? ''))) {
    process.stderr.write(`${PREFIX} 警告：任务报成功，但本次**一次工具都没调用**（toolCalls=0），而提示词里要求创建/修改文件 —— 高度可疑。\n`);
  }

  const elapsed = (Date.now() - started) / 1000;
  /* ⚠️ 真机踩到（本引擎特有）：**CLI 的进程退出码恒为 0**，即使 `result.is_error === true`
   * （未登录、模型报错等）。若照抄 qoder-run 的 `exit = code ?? 1`，core 会把"任务失败"当成功收尾
   * —— 用户看到"完成"，实际什么都没做。故这里把 `is_error` 并入退出码。 */
  const exit = timedOut ? 124 : (code === 0 && s.isError ? 1 : (code ?? 1));

  /* 档位回显（core 的 applied 行）。⚠️ 与 Qoder 同样的诚实原则：这一行是**请求值**，
   * 不是实际生效值 —— CLI 不回报生效档位。真实信号见下面的 thinking-observed。 */
  if (opt.effort) out(`${PREFIX} effort=${opt.effort} model=${opt.model ?? s.model ?? '(default)'}`);
  /* **观测到的思考状态**：本次是否真的产生了 thinking 内容块。
   * `observed=thinking` = 有；`observed=silent` = 一块都没有 ⇒ core 据此判定"请求要思考、实际没思考"。
   * 绝不把请求值谎报成实际值（否则核对退化成"永远通过"）。 */
  out(`${PREFIX} thinking-observed=${(s.thinkingBlocks ?? 0) > 0 ? 'thinking' : 'silent'} blocks=${s.thinkingBlocks ?? 0} chars=${s.thinkingChars ?? 0} requested=${opt.effort ?? '-'}`);
  if (s.toolNames.length) out(`${PREFIX} tools count=${new Set(s.toolNames).size}`);

  const pct = (s.contextUsed != null && s.contextWindow) ? ((s.contextUsed / s.contextWindow) * 100).toFixed(1) : '-';
  out(`${PREFIX} usage requests=${s.numTurns ?? '-'} in=${s.tokens.in ?? '-'} out=${s.tokens.out ?? '-'} cacheRead=${s.tokens.cacheRead ?? '-'}`);
  out(`${PREFIX} context used=${s.contextUsed ?? '-'} (${pct}% of ${s.contextWindow ?? '?'}) turnCount=${s.numTurns ?? '-'}`);
  /* 费用：CodeBuddy 的商品计量是"积分"，但 result 给的是 total_cost_usd；如实打出来（不换算、不猜）。 */
  out(`${PREFIX} cost usd=${s.totalCostUsd ?? '-'} durationMs=${s.durationMs ?? '-'} turns=${s.numTurns ?? '-'}`);
  out(`${PREFIX} done exit=${exit}${timedOut ? ' (超时)' : ''} elapsed=${elapsed.toFixed(1)}s`
    + `${s.sessionId ? ` session=${s.sessionId}` : ''}${s.model ? ` model=${s.model}` : ''} responseChars=${s.responseChars}`);

  /* 结果落一份 JSON 文件（与另三个执行器同形，便于长文交付）。 */
  const logsDir = join(opt.cwd ? resolve(opt.cwd) : process.cwd(), 'collab', 'logs');
  try {
    mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rf = join(logsDir, `codebuddy-run-${opt.tag ?? 'untagged'}-${stamp}.result.json`);
    writeFileSync(rf, `${JSON.stringify({
      tag: opt.tag ?? null, kind: opt.kind, model: opt.model ?? s.model, exit,
      elapsedSec: Number(elapsed.toFixed(1)), sessionId: s.sessionId,
      response: s.response, responseChars: s.responseChars,
      usage: {
        tokens: s.tokens, contextUsed: s.contextUsed, contextWindow: s.contextWindow,
        maxOutputTokens: s.maxOutputTokens, totalCostUsd: s.totalCostUsd,
        durationMs: s.durationMs, numTurns: s.numTurns,
      },
      apiKeySource: s.apiKeySource,
      permissionMode: { requested: requestedMode, reported: s.permissionMode, fellBack: fb.fellBack },
      effort: { requested: opt.effort ?? null, observedThinkingBlocks: s.thinkingBlocks ?? 0 },
      authRequired: authHit,
      errors: s.errors,
      toolCount: new Set(s.toolNames).size,
      toolCalls: [...new Set(s.toolCalls ?? [])], toolCallCount: (s.toolCalls ?? []).length,
      eventCounts: s.eventCounts,
      unknownEventCount: s.unknownEventCount, parseErrorCount: s.parseErrorCount, warnings: s.warnings,
    }, null, 2)}\n`, 'utf8');
    note(`result=${rf}`);
  } catch (e) {
    process.stderr.write(`${PREFIX} 结果文件写入失败（不影响本次执行）：${e?.message ?? e}\n`);
  }

  if (s.unknownEventCount > 0) process.stderr.write(`${PREFIX} ${s.unknownEventCount} 个未登记事件类型（已降级忽略）：${s.unknownEvents.slice(0, 3).join(' | ')}\n`);
  if (timedOut) process.stderr.write(`${PREFIX} 超时：${opt.timeoutMin} 分钟未结束，已终止进程树。\n`);
  if (errBuf.trim()) process.stderr.write(`${PREFIX} stderr 非空（前 300 字）：${errBuf.trim().slice(0, 300)}\n`);
  return exit;
}

const HELP = `${PREFIX} WorkBuddy / CodeBuddy 执行器（第四个引擎）

用法：
  codebuddy-run --prompt <文本> [--model M] [--effort E] [--cwd D] [--timeout-min N] [--tag T] [--auto]
  codebuddy-run --task <任务包绝对路径> [同上]
  codebuddy-run --target <目标描述> [同上]
  codebuddy-run --list-models              # 只读：列出可用模型（裸名，每行一个）
  codebuddy-run --list-models --with-efforts   # 只读：追加「reasoning-efforts 模型=档位,档位」行
  codebuddy-run --version                  # 只读：打印 CLI 版本

启动（必读）：
  本执行器自动注入 CODEBUDDY_FORCE_LITE_WB_BUNDLE=1。
  原因：WorkBuddy 的 asar 解包里**只有 lite 包** dist/codebuddy-lite-wb.mjs，而 bin/codebuddy 默认
  require ../dist/codebuddy ⇒ 不设该变量会 MODULE_NOT_FOUND。

思考强度（--effort / 兼容别名 --reasoning-effort）：
  合法值由 CLI 自己在 --help 里声明（真机实测：minimal, low, medium, high, xhigh, max），
  本执行器**解析 help 文本、不写死**；逐模型子集 CLI 未声明 ⇒ --with-efforts 给的是**引擎级**集合。

登录（一次性，必读）：
  WorkBuddy CLI 的登录态与**桌面应用互相独立**。未登录时无头执行会报
  "Authentication required. Please use /login command to sign in"。
  ① 最稳（不依赖 TUI）：node "<上面的 CLI 路径>" --serve
     它会打印带 password 的 Web UI 链接，浏览器打开并在其中登录，完成后 Ctrl+C。
  ② 真终端里交互启动 CLI，进入界面后输入斜杠命令 /login
     （⚠️ /login 不是 shell 命令，在 PowerShell/cmd 里敲会被当成命令而报错）。
  凭据由 CLI 自己保存在 ~/.codebuddy/ 下；本执行器**不读不写**任何凭据。

权限（默认已是最优，无需关心）：
  默认 --permission-mode acceptEdits：无头下可修改工作目录内文件。
  --auto ⇒ bypassPermissions（**全放行**，仅调用方显式要求时）。

环境变量：
  CODEBUDDY_CLI   显式指定 CodeBuddy CLI 路径（最高优先，便于测试/多版本共存）
`;

async function main(argv) {
  let opt;
  try {
    opt = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
  if (opt.help) { process.stdout.write(HELP); return 0; }

  let disc;
  try {
    disc = await discoverCodebuddy();
  } catch (e) {
    process.stderr.write(`${PREFIX} ${e.message}\n`);
    process.stderr.write(`${PREFIX} 修复方式：① 安装 WorkBuddy（自带 CodeBuddy CLI）；`
      + '② 或设 CODEBUDDY_CLI 指向 <WorkBuddy 安装根>\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy。\n');
    return 1;
  }

  if (opt.version) {
    const r = probe(disc.cli, ['--version']);
    const v = `${r.stdout}\n${r.stderr}`.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
    process.stdout.write(`${v ? v[1] : (disc.version ?? '(unknown)')}\n`);
    return 0;
  }
  if (opt.listModels) return listModels(disc.cli, opt);

  if (!opt.kind) {
    process.stderr.write(`${PREFIX} 必须给出 --task / --prompt / --target 之一\n`);
    return 1;
  }
  try {
    return await runOnce(opt, disc.cli);
  } catch (e) {
    process.stderr.write(`${PREFIX} ${e.message}\n`);
    /* ⚠️ 必须把非 0 退出码传出去 —— 否则"执行器报错但进程 exit 0"，core 会当成功收尾。 */
    return 1;
  }
}

/* 仅在被当作可执行入口时跑（测试 import 本模块时不得触发）。
 * ⚠️ 不能用 `setTimeout(...).unref()` —— unref 定时器不保持事件循环，进程会先自然退出，
 * 于是 process.exit(code) 永不执行，报错路径的**非 0 退出码被丢掉**（见 qoder-run 的同一教训）。 */
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; process.exit(code); })
    .catch((e) => { process.stderr.write(`${PREFIX} 未捕获异常：${e?.stack ?? e}\n`); process.exit(1); });
}

export { main, PREFIX, helpText, isNodeShebang };
