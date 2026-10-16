#!/usr/bin/env node
/**
 * Qoder 执行器（第三个引擎）：把一条自足任务交给本机真实的 Qoder CLI（`qoderclicn` / `qoder`）执行，
 * 把 `-o stream-json` 的 NDJSON 事件流聚合成 **core 认识的行协议**输出。
 *
 * 事实依据：全部来自 **真机抓包**（Qoder CLI CN v1.1.73，见 `tasks/ZB-50-qoder-integration-spec.md` §8），
 * 不是文档推测。以下每条都有实测支撑：
 *
 *   · 调用形态：`qoderclicn -p -o stream-json [--model M] [--permission-mode X] [--add-dir D] …`
 *   · 事件谱（7 行真实样本）：
 *       system/hook_started → **system/init** → system/artifacts_update → system/hook_response
 *       → assistant(thinking) → assistant(text) → **result**
 *     每行都带 `uuid` + `session_id`；最后一行 `result` 与 `-o json` 的对象**逐字相同**。
 *   · `system/init` 带 `qodercli_version` / `protocol_version:"1.5.0"` / `cwd` / `model` /
 *     **camelCase 的 `permissionMode`** / `tools[]` / `agents[]` / `skills[]` / `capabilities[]`。
 *   · `assistant` 事件的 `content:[{type:"thinking"|"text"}]` —— text 才是回答正文。
 *   · ⚠️ **用量陷阱**：真机上 `input_tokens` / `output_tokens` / `cache_*` / `modelUsage.*Tokens` /
 *     `contextWindow` **全为 0**；真实计量是 `total_credits` 与 `usage.context_usage_ratio`。
 *     故本执行器不把 token 当权威，单独上报 credits 与上下文占比。
 *   · ⚠️ **权限陷阱**：无头模式下"需要确认"的操作会被**直接拒绝**（不挂住、不报错）：
 *     `permission_denials=[]`、`is_error=false`，文件却没写出来 —— 唯一线索是 result 文本里
 *     一句 "It looks like the write was denied…"。故默认带 `--permission-mode accept_edits`
 *     与 `--add-dir <cwd>`，并**比对 init.permissionMode** 判断是否被回落（目录不受信任时会回落）。
 *
 * 硬约束（与其他执行器一致）：
 *   · **不写用户自己的 agent 数据**（不写 `~/.qoder*`），只读探测；
 *   · 未知事件类型 / 坏 JSON 行 **绝不止损整轮**（降级透明，记 warning 继续）；
 *   · 权限放行**默认关**：只有 core 显式传 `--auto` 才映射为 `--permission-mode bypass_permissions`。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prefixFor } from './run-line-protocol.mjs';
import { discoverEngine } from './engine-discover.mjs';

const PREFIX = prefixFor('qoder'); // `[qoder-run]`
const HERE = dirname(fileURLToPath(import.meta.url));

/** 输出协议行（core 按前缀解析；与另两个执行器同形）。 */
const out = (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
/** 人类可读的说明行（core 会把不认识的已知信息行降级处理，不会当错误）。 */
const note = (s) => out(`${PREFIX} ${s}`);

class CliError extends Error {}

/* ------------------------------------------------------------------ *
 * CLI 发现（复用 engine-discover，避免两份候选表漂移）
 * ------------------------------------------------------------------ */

/**
 * 找出可用的 Qoder CLI（只读探测）。返回 { cli, variant, version, reason }。
 * 环境变量覆盖：`QODER_CLI`（本脚本专用，便于测试注入假 CLI）> 发现层自己的候选链。
 */
export function resolveQoderCli(env = process.env) {
  /* ① 本脚本专用覆盖：测试与高级用户指向任意可执行文件（含 .cmd / 假 CLI） */
  const explicit = String(env.QODER_CLI ?? '').trim();
  if (explicit) {
    const p = resolve(explicit);
    if (existsSync(p)) return { cli: p, variant: /qoderclicn|qoder-cn/i.test(p) ? 'cn' : 'global', version: null, reason: 'QODER_CLI 显式指定' };
    throw new CliError(`QODER_CLI 指向的文件不存在：${p}`);
  }
  /* ② 发现层（同步方式调用：这里是 CLI 入口，用 spawnSync 内部驱动 async 不合适 —— 直接同步探测） */
  return null; // 由 main() 里的 async 路径补上
}

/** 异步版发现（main 里用）。 */
export async function discoverQoder(env = process.env) {
  const explicit = String(env.QODER_CLI ?? '').trim();
  if (explicit) {
    const p = resolve(explicit);
    if (!existsSync(p)) throw new CliError(`QODER_CLI 指向的文件不存在：${p}`);
    return { cli: p, variant: /qoderclicn|qoder-cn/i.test(p) ? 'cn' : 'global', version: null, reason: 'QODER_CLI 显式指定', found: true };
  }
  const r = await discoverEngine('qoder', { env, timeoutMs: 15000 });
  if (!r.found) throw new CliError(`未找到 Qoder CLI。${r.reason}`);
  return { cli: r.entry, variant: r.variant, version: r.version, reason: r.reason, found: true };
}

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

export function parseArgs(argv) {
  const opt = {
    kind: null, task: null, prompt: null, target: null,
    model: null, cwd: null, tag: null, timeoutMin: 30,
    resume: null, auto: false, permissionMode: null,
    reasoningEffort: null, addDirs: [], memoryBan: false,
    listModels: false, version: false, help: false,
    noSessionPersistence: false, maxTurns: null,
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
      case '--prompt': case '-p': opt.prompt = next(); opt.kind = opt.kind ?? 'prompt'; break;
      case '--target': opt.target = next(); opt.kind = 'target'; break;
      case '--model': case '-m': opt.model = next(); break;
      case '--cwd': opt.cwd = next(); break;
      case '--add-dir': opt.addDirs.push(next()); break;
      case '--tag': opt.tag = next(); break;
      case '--timeout-min': opt.timeoutMin = Number(next()); break;
      case '--resume': opt.resume = next(); break;
      case '--reasoning-effort': opt.reasoningEffort = next(); break;
      case '--permission-mode': opt.permissionMode = next(); break;
      case '--max-turns': opt.maxTurns = Number(next()); break;
      case '--memory-ban': opt.memoryBan = true; break;
      case '--no-session-persistence': opt.noSessionPersistence = true; break;
      /* --auto：**默认关**，只有 core 显式传才放行（硬约束「不默认开」）。 */
      case '--auto': opt.auto = true; break;
      case '--list-models': case '--list-providers': opt.listModels = true; break;
      case '--version': case '-v': opt.version = true; break;
      case '--help': case '-h': opt.help = true; break;
      /* 明确不支持 ⇒ fail-fast（绝不静默忽略，与 opencode-run 同纪律）。 */
      case '--memory-bench':
        throw new CliError('qoder-run 不支持 --memory-bench（Qoder 无 ZCode 记忆库/自动 Memory 提取概念）');
      case '--mode':
        next();
        throw new CliError('qoder-run 不支持 --mode（Qoder 无 build/edit/plan/yolo 模式概念）');
      /* 兼容令牌（记 stderr 说明后忽略，仍然"大声"）。 */
      case '--provider': {
        const v = String(next()).trim();
        if (v !== 'qoder' && v !== 'qoder-cn' && v !== 'qoder-global') {
          throw new CliError(`--provider 只接受 qoder / qoder-cn / qoder-global（收到: ${v}）—— Qoder 引擎由本脚本自身决定`);
        }
        opt.compatNotes.push(`--provider ${v} 已忽略（本脚本即 Qoder 引擎）`);
        break;
      }
      case '--reasoning-level': {
        /* 与 opencode-run 同构：core 对 qoder 用的是 --reasoning-effort，这里兼容旧参数名。 */
        const level = String(next()).trim();
        if (level === 'agent') {
          opt.compatNotes.push('--reasoning-level agent ⇒ qoder-run 不传 --reasoning-effort（用 Qoder 默认档）');
        } else {
          opt.reasoningEffort = level;
          opt.compatNotes.push(`--reasoning-level ${level} ⇒ 按 Qoder 的 --reasoning-effort ${level} 透传`);
        }
        break;
      }
      case '--no-ledger':
        opt.compatNotes.push('--no-ledger 已忽略（qoder-run 本就不写 dispatch-runs.jsonl 台账）');
        break;
      default:
        unknown.push(a);
    }
  }
  if (unknown.length) throw new CliError(`未知参数: ${unknown.join(', ')}（用法见 ${PREFIX} --help）`);
  return opt;
}

/* ------------------------------------------------------------------ *
 * 权限模式（**真机实测的映射与回落检测**）
 * ------------------------------------------------------------------ */

/** CLI 参数值 → `init.permissionMode` 的回传值（**驼峰**，真机实测）。 */
export const PERMISSION_MODE_REPORTED = {
  default: 'default',
  plan: 'plan',
  auto: 'auto',
  accept_edits: 'acceptEdits',
  bypass_permissions: 'bypassPermissions',
  dont_ask: 'dontAsk',
};

/**
 * 决定本次要用的权限模式（纯函数，便于测试）。
 *   ① `--permission-mode` 显式给了 ⇒ 用它（调用方最清楚）；
 *   ② `--auto` ⇒ `bypass_permissions`（全放行，仅显式要求时）；
 *   ③ 默认 ⇒ **`accept_edits`** —— 这是"开箱即用"的关键：无头模式下 default 会让写操作
 *      **静默失败**（任务报成功但没改文件），实测确认。
 */
export function decidePermissionMode(opt) {
  if (opt.permissionMode) return String(opt.permissionMode).trim();
  if (opt.auto) return 'bypass_permissions';
  return 'accept_edits';
}

/**
 * 判断权限模式是否被**回落**（目录不受信任时 CLI 会回落成 default）。
 * @returns {{fellBack:boolean, expected:string, actual:string|null, warning:string|null}}
 *
 * ⚠️ 关键细节（真机踩过）：`accept_edits` 回传的是 **`acceptEdits`（驼峰）**，
 * 直接拿 CLI 参数值去比对会**永远误报"回落了"**。故必须经 PERMISSION_MODE_REPORTED 转换。
 */
export function detectPermissionFallback(requested, reportedMode) {
  const expected = PERMISSION_MODE_REPORTED[requested] ?? requested;
  const actual = reportedMode ?? null;
  if (!actual) {
    return { fellBack: false, expected, actual: null, warning: `${PREFIX} 未从 init 事件读到 permissionMode，无法确认权限模式是否生效（请求 ${requested}）` };
  }
  if (actual === expected) return { fellBack: false, expected, actual, warning: null };
  return {
    fellBack: true,
    expected,
    actual,
    warning: `${PREFIX} 权限模式被回落：请求 ${requested}（回传应为 ${expected}），实际 init.permissionMode=${actual}`
      + '。**这通常意味着工作目录不在受信任列表里** —— 非默认模式只在受信任目录生效；'
      + '回落成 default 后写操作会被静默拒绝（任务可能报成功但文件没变）。'
      + '处理：在 Qoder 设置里信任该目录，或用 --permission-mode bypass_permissions（= auto:true）明确全放行。',
  };
}

/* ------------------------------------------------------------------ *
 * 参数表构造（纯函数，便于离线测试断言）
 * ------------------------------------------------------------------ */

/**
 * 构造 Qoder CLI 的参数表。
 * 形态：`-p -o stream-json [--model M] [--permission-mode X] [--add-dir D]… [--session-id S] [正文]`
 *
 * 注意：Qoder 的正文是**位置参数**（放在最后），与 OpenCode 的 `run <msg>` 不同。
 * 续跑用 `--session-id <id>`（Qoder 不支持 `--resume` 的裸用法时回退——真机确认 `--session-id` 可用）。
 */
export function buildQoderArgs(opt) {
  const args = ['-p', '-o', 'stream-json'];
  if (opt.resume) args.push('--session-id', String(opt.resume));
  if (opt.model) args.push('--model', String(opt.model));
  args.push('--permission-mode', decidePermissionMode(opt));
  /* 受信任目录声明：真机实测 `--add-dir` + accept_edits 才能真的写文件。 */
  for (const d of opt.addDirs ?? []) args.push('--add-dir', String(d));
  if (opt.reasoningEffort) args.push('--reasoning-effort', String(opt.reasoningEffort));
  if (opt.maxTurns != null) args.push('--max-turns', String(opt.maxTurns));
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
 *   · 已知事件 → 累积（sessionId / 正文 / 工具 / credits / 上下文占比 / 权限模式）；
 *   · 未知 type 或坏 JSON → 记 warning 后继续（真机上确实存在未登记类型：
 *     `system/hook_started`、`system/artifacts_update`、`system/hook_response`）。
 */
export function createAggregator() {
  const warnings = [];
  const unknownEvents = [];
  const eventCounts = Object.create(null);
  const texts = [];
  const toolNames = [];
  let sessionId = null;
  let model = null;
  let permissionMode = null;
  let qoderVersion = null;
  let protocolVersion = null;
  let totalCredits = null;
  let contextRatio = null;
  let durationMs = null;
  let numTurns = null;
  let isError = null;
  let stopReason = null;
  let resultText = null;
  let permissionDenials = [];
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

    /* 每行都带 session_id（真机实测），先尽力取。 */
    if (ev.session_id && !sessionId) { sessionId = String(ev.session_id); counters.sessionId = sessionId; }
    const type = typeof ev.type === 'string' ? ev.type : null;
    const subtype = typeof ev.subtype === 'string' ? ev.subtype : null;
    const key = subtype ? `${type}/${subtype}` : type;
    if (key) eventCounts[key] = (eventCounts[key] ?? 0) + 1;

    /* ---- system/init：引擎元信息 + 权限模式（回落检测的输入） ---- */
    if (type === 'system' && subtype === 'init') {
      if (ev.qodercli_version) qoderVersion = String(ev.qodercli_version);
      if (ev.protocol_version) protocolVersion = String(ev.protocol_version);
      if (ev.model) model = String(ev.model);
      if (ev.permissionMode) permissionMode = String(ev.permissionMode); // 注意：驼峰
      if (Array.isArray(ev.tools)) toolNames.push(...ev.tools.map(String));
      counters.tools = toolNames.length;
      return { type, subtype, known: true, init: true };
    }

    /* ---- assistant：thinking / text 内容块（text 才是回答正文） ---- */
    if (type === 'assistant') {
      const blocks = Array.isArray(ev.content) ? ev.content
        : (ev.message && Array.isArray(ev.message.content) ? ev.message.content : []);
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string') { texts.push(b.text); counters.chars += b.text.length; }
        else if (b.type === 'thinking' && typeof b.thinking === 'string') { counters.chars += 0; } // thinking 不计入正文
        else if (b.type === 'tool_use' && b.name) { toolNames.push(String(b.name)); counters.tools = toolNames.length; }
      }
      return { type, known: true, assistant: true };
    }

    /* ---- result：与 `-o json` 单对象逐字相同（权威收尾） ---- */
    if (type === 'result') {
      if (typeof ev.result === 'string') resultText = ev.result;
      if (typeof ev.is_error === 'boolean') isError = ev.is_error;
      if (typeof ev.subtype === 'string') stopReason = ev.subtype;
      if (ev.stop_reason) stopReason = String(ev.stop_reason);
      if (ev.total_credits != null) totalCredits = num(ev.total_credits);
      if (ev.duration_ms != null) durationMs = num(ev.duration_ms);
      if (ev.num_turns != null) numTurns = num(ev.num_turns);
      if (Array.isArray(ev.permission_denials)) permissionDenials = ev.permission_denials;
      const u = ev.usage ?? {};
      /* ⚠️ 真机坑：token 字段可能全 0 —— 只把**非零**值当有效信号（不谎报 0 消耗）。 */
      const ratio = num(u.context_usage_ratio);
      if (ratio != null) contextRatio = ratio;
      if (ev.modelUsage && typeof ev.modelUsage === 'object' && !model) {
        const first = Object.keys(ev.modelUsage)[0];
        if (first) model = first;
      }
      if (ev.session_id && !sessionId) { sessionId = String(ev.session_id); counters.sessionId = sessionId; }
      return { type, known: true, result: true };
    }

    /* ---- 其它 system 子类型（hook_* / artifacts_update 等）：**真机确实会出现**，
     * 降级透明处理（计数 + 不落 warning —— 它们是正常生命周期事件，不是异常）。 ---- */
    if (type === 'system') return { type, subtype, known: true, system: true };

    /* ---- `user` 事件（工具结果回灌）：真机写文件任务实测出现，形如
     * `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":…}]}}`。
     * 它是**正常生命周期事件**（工具调用完成后把结果回给模型），**不是**未登记异常 ——
     * 降级透明处理（不落 warning），否则每个用工具的任务都会带一条"未登记事件"噪音。 ---- */
    if (type === 'user') return { type, known: true, user: true };

    noteUnknown(line);
    return { type, known: false };
  }

  function summary() {
    const text = resultText != null ? resultText : texts.join('');
    return {
      sessionId, model, permissionMode, qoderVersion, protocolVersion,
      totalCredits, contextRatio, durationMs, numTurns, isError, stopReason,
      response: text, responseChars: text.length,
      toolNames, permissionDenials,
      eventCounts, unknownEvents, unknownEventCount: unknownCount, parseErrorCount: parseErrors,
      warnings,
    };
  }
  return { handleLine, summary, counters };
}

/* ------------------------------------------------------------------ *
 * 只读探测（--list-models / --version）
 * ------------------------------------------------------------------ */

function whichOnPath(name, env = process.env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of String(env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const ext of exts) {
      const p = join(d, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * 构造 spawn 目标（**唯一权威**，探测与执行共用 —— 避免"一处修了另一处没修"）。
 *
 * ⚠️ 真机踩到：`.cjs` / `.js` **不能直接 spawn** —— Windows 下报 `EFTYPE`。
 * 这与发现层处理 ZCode 自带 CLI（`zcode.cjs`）是同一类问题，故统一前置 `node`。
 * `.cmd` / `.bat` 则必须经 shell（否则同样 EFTYPE）。
 */
export function spawnTarget(cli, args) {
  const isScript = /\.(cjs|mjs|js)$/i.test(cli);
  if (isScript) return { cmd: process.execPath, argv: [cli, ...args], shell: false };
  const needShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli);
  return { cmd: needShell ? `"${cli}"` : cli, argv: args, shell: needShell };
}

/** 跑一个只读子命令（带超时，不抛）。 */
function probe(cli, args, timeoutMs = 20000) {
  const t = spawnTarget(cli, args);
  try {
    const r = spawnSync(t.cmd, t.argv, {
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell: t.shell, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (e) {
    return { code: null, stdout: '', stderr: e?.message ?? String(e) };
  }
}

/** `--list-models`：只吐**裸模型名**（core 会加 `qoder/` 前缀）。不写死枚举。 */
function listModels(cli) {
  const r = probe(cli, ['--list-models'], 25000);
  const text = `${r.stdout}\n${r.stderr}`;
  if (/not logged in/i.test(text)) {
    note(`未登录：${text.split('\n').find((l) => /not logged in/i.test(l))?.trim() ?? ''}`);
    note('登录方式：qoderclicn login（浏览器设备码，5 分钟有效期）或设 QODER_PERSONAL_ACCESS_TOKEN');
    return 1;
  }
  if (r.code !== 0) { note(`--list-models 失败（exit=${r.code}）：${text.trim().slice(0, 300)}`); return 1; }
  /* 模型名可能含空格与点（真机：Qwen3.8-Max / GLM-5.3 / DeepSeek-V4-Pro），故按"整行"取。
   * 过滤掉表头/分隔符/空行；不猜格式，只做最小清洗。 */
  const lines = String(r.stdout).split('\n').map((s) => s.trim())
    .filter((s) => s && !/^[-=]+$/.test(s) && !/^(model|models|id|name)\b/i.test(s));
  for (const m of lines) out(m); // 裸模型名（每行一个），与 opencode-run 的 --list-models 同契约
  return 0;
}

/* ------------------------------------------------------------------ *
 * 主执行
 * ------------------------------------------------------------------ */

function taskBody(opt) {
  if (opt.kind === 'task') {
    const p = resolve(String(opt.task));
    if (!existsSync(p)) throw new CliError(`任务包不存在: ${p}`);
    let text = readFileSync(p, 'utf8');
    if (opt.memoryBan) text += `\n\n---\n【硬约束】不要写任何 CLI 的记忆库/自动记忆提取；不要修改 ~/.qoder* 下的用户数据。\n`;
    return text;
  }
  if (opt.kind === 'target') return `目标：${opt.target}\n\n请自主规划并执行，直到达成该目标。`;
  let text = String(opt.prompt ?? '');
  if (opt.memoryBan) text += `\n\n【硬约束】不要写任何 CLI 的记忆库/自动记忆提取；不要修改 ~/.qoder* 下的用户数据。\n`;
  return text;
}

async function runOnce(opt, cli) {
  const body = taskBody(opt);
  const args = buildQoderArgs({ ...opt, prompt: body, target: body });
  const requestedMode = decidePermissionMode(opt);

  note(`tag=${opt.tag ?? '(none)'} mode=qoder cwd=${opt.cwd ?? process.cwd()}`);
  note(`cli=${cli}`);
  if (opt.model) note(`model=${opt.model}`);
  note(`permission-mode=${requestedMode}${opt.auto ? '（--auto 显式放行）' : '（默认：无头下可改工作目录内文件）'}`);
  if (opt.resume) note(`resume=${opt.resume}`);
  for (const cn of opt.compatNotes) process.stderr.write(`${PREFIX} 说明：${cn}\n`);
  /* 权限放行的**可审计告知行**（core 会据此置 autoApproved 并识别为已知信息行）。 */
  if (opt.auto) note(`auto=on（已映射为 --permission-mode bypass_permissions：放行所有未显式拒绝的权限；请确保工作目录可信）`);

  const agg = createAggregator();
  const started = Date.now();
  let child;
  try {
    const t = spawnTarget(cli, args);
    child = spawn(t.cmd, t.argv, {
      cwd: opt.cwd ? resolve(opt.cwd) : undefined,
      env: { ...process.env },
      shell: t.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new CliError(`spawn 失败：${e?.message ?? e}`);
  }

  /* 心跳：每 10s 一行 progress（让面板能看到"在做什么 + 多久没动静"）。
   * 绝不因为心跳而额外开子进程 —— 真机教训：并发 CLI agent 会互相干扰。 */
  let timedOut = false;
  const killTree = (pid) => { try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch { try { process.kill(pid); } catch { /* 尽力 */ } } };
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opt.timeoutMin * 60_000);
  const hb = setInterval(() => {
    const s = agg.summary();
    out(`${PREFIX} progress stage=run elapsed=${Math.round((Date.now() - started) / 1000)}s chars=${s.responseChars} tools=${s.toolNames.length} stageAgo=0s${s.sessionId ? ` session=${s.sessionId}` : ''}`);
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

  const { code, signal } = await new Promise((done) => {
    child.on('error', (e) => done({ code: null, signal: null, err: e }));
    child.on('close', (c, s) => done({ code: c, signal: s }));
  });
  clearTimeout(timer);
  clearInterval(hb);
  if (buf.trim()) { process.stdout.write(`${buf}\n`); agg.handleLine(buf); }

  const s = agg.summary();

  /* ---- 权限回落检测（真机最大的静默陷阱） ---- */
  const fb = detectPermissionFallback(requestedMode, s.permissionMode);
  if (fb.warning) process.stderr.write(`${fb.warning}\n`);
  note(`permission-mode-requested=${requestedMode} reported=${s.permissionMode ?? '(unknown)'}${fb.fellBack ? ' FELLBACK' : ''}`);

  /* ---- 答不成答的静默失败检测：无 denial 记录但正文说被拒 ---- */
  if (!s.isError && (code === 0) && /denied|permission|allow it/i.test(s.response) && (s.permissionDenials ?? []).length === 0) {
    process.stderr.write(`${PREFIX} 警告：任务报成功但回答里出现"被拒绝"字样，且 permission_denials 为空 —— 这是无头权限被静默拒绝的典型特征（文件可能没改）。建议改用 auto:true 或在 Qoder 里信任该目录。\n`);
  }

  const elapsed = (Date.now() - started) / 1000;
  const exit = timedOut ? 124 : (code ?? 1);

  /* 思考强度回显（core 的 applied 行：`reasoning-effort=<v> model=<id>`）。 */
  if (opt.reasoningEffort) out(`${PREFIX} reasoning-effort=${opt.reasoningEffort} model=${opt.model ?? s.model ?? '(default)'}`);
  /* 档位表：Qoder 的档位随模型/账号而变，本执行器**不写死**；探测到才打（当前 CLI 未提供该子命令）。 */
  if (s.toolNames.length) out(`${PREFIX} tools count=${new Set(s.toolNames).size}`);

  out(`${PREFIX} credits total=${s.totalCredits ?? '-'} contextRatio=${s.contextRatio ?? '-'} durationMs=${s.durationMs ?? '-'} turns=${s.numTurns ?? '-'}`);
  out(`${PREFIX} usage requests=${s.numTurns ?? '-'} in=- out=- cacheRead=-`);
  out(`${PREFIX} context used=- (${s.contextRatio != null ? (s.contextRatio * 100).toFixed(1) : '-'}% of ?) turnCount=${s.numTurns ?? '-'}`);
  out(`${PREFIX} done exit=${exit}${timedOut ? ' (超时)' : ''} elapsed=${elapsed.toFixed(1)}s`
    + `${s.sessionId ? ` session=${s.sessionId}` : ''}${s.model ? ` model=${s.model}` : ''} responseChars=${s.responseChars}`);

  /* 结果落一份 JSON 文件（与另两个执行器同形，便于长文交付）。 */
  const logsDir = join(opt.cwd ? resolve(opt.cwd) : process.cwd(), 'collab', 'logs');
  try {
    mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rf = join(logsDir, `qoder-run-${opt.tag ?? 'untagged'}-${stamp}.result.json`);
    writeFileSync(rf, `${JSON.stringify({
      tag: opt.tag ?? null, kind: opt.kind, model: opt.model ?? s.model, exit,
      elapsedSec: Number(elapsed.toFixed(1)), sessionId: s.sessionId,
      response: s.response, responseChars: s.responseChars,
      usage: { totalCredits: s.totalCredits, contextRatio: s.contextRatio, durationMs: s.durationMs, numTurns: s.numTurns },
      permissionMode: { requested: requestedMode, reported: s.permissionMode, fellBack: fb.fellBack },
      toolCount: new Set(s.toolNames).size, eventCounts: s.eventCounts,
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

const HELP = `${PREFIX} Qoder 执行器（第三个引擎）

用法：
  qoder-run --prompt <文本> [--model M] [--reasoning-effort E] [--cwd D] [--timeout-min N] [--tag T] [--auto]
  qoder-run --task <任务包绝对路径> [同上]
  qoder-run --target <目标描述> [同上]
  qoder-run --list-models      # 只读：列出可用模型（裸名，每行一个）
  qoder-run --version          # 只读：打印 CLI 版本

权限（默认已是最优，无需关心）：
  默认 --permission-mode accept_edits + --add-dir <cwd>：无头下可修改工作目录内文件。
  --auto ⇒ bypass_permissions（**全放行**，仅调用方显式要求时）。
  ⚠️ 非默认模式只在「受信任目录」生效；不受信任会回落成 default 并导致写操作**静默失败**，
     本执行器会比对 init.permissionMode 并在回落时明确报警。

环境变量：
  QODER_CLI   显式指定 Qoder CLI 路径（最高优先，便于测试/多版本共存）
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
    disc = await discoverQoder();
  } catch (e) {
    process.stderr.write(`${PREFIX} ${e.message}\n`);
    process.stderr.write(`${PREFIX} 修复方式：① 安装 Qoder（CN: irm https://qoder.com.cn/install.ps1 | iex）`
      + `；② 或设 QODER_CLI 指向 qoderclicn.exe；③ CN 版环境变量为 QODERCN_CLI_BIN。\n`);
    return 1;
  }

  if (opt.version) {
    const r = probe(disc.cli, ['--version']);
    const v = `${r.stdout}\n${r.stderr}`.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
    process.stdout.write(`${v ? v[1] : (disc.version ?? '(unknown)')}\n`);
    return 0;
  }
  if (opt.listModels) return listModels(disc.cli);

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
 *
 * ⚠️ 真机踩到：这里**不能**用 `setTimeout(() => process.exit(code), 300).unref()`。
 * `.unref()` 会让该定时器**不保持事件循环存活** —— 进程在 300ms 之前就自然退出，
 * 于是 `process.exit(code)` **永不执行**，报错路径的**非 0 退出码被丢掉**（表现为"报错了却 exit 0"，
 * core 会当成功收尾）。改为**同步**写退出码；stdout 已由 write() 同步刷入管道。 */
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; process.exit(code); })
    .catch((e) => { process.stderr.write(`${PREFIX} 未捕获异常：${e?.stack ?? e}\n`); process.exit(1); });
}

export { main, PREFIX, taskBody, listModels, probe, whichOnPath };
