/**
 * **免费额度（Start Plan）回合驱动** —— 派发台的 app-server 传输实现。
 *
 * 背景（ZB-33 探索，见 tasks/ZB-33-gift-channel-exploration.md）：
 * ZCode 的 Start Plan（活动赠送额度）端点 `https://zcode.z.ai/api/v1/zcode-plan/anthropic`
 * **要求逐请求的官方客户端证明** —— 直连 HTTP（把 Key 塞进 provider 配置那种做法）会被判
 * `405 / code 3012 request has been blocked due to unusual activity`。唯一可行路线是**托管官方
 * agent 本体**（`zcode.cjs app-server`），由它自己签发签名；我们只负责：
 *   ① 注入套餐账户（`provider/updateAccountConfig`）
 *   ② 把 `zcodejwttoken` 递给它（`interaction/requestProviderRuntimeHeaders`，它自己算签名）
 *   ③ 驱动会话（create → setModel → send）并把事件流翻译成结果
 *
 * 与 dsh-connect-zcode 的 `zcode-appserver` 通道**同源同协议**（那边当 DSH 的 LLM provider，
 * 这边当派发台的执行后端）；本模块零依赖、不 import 那两个仓库的任何东西，便于独立演进。
 *
 * 实测踩过的四个"静默失效"点（全部已在本文件里照抄，勿删注释）：
 *   1. env 五件套少一个 ⇒ CLI 落到别的 configSource ⇒ 注入被 registry **静默丢弃**；
 *   2. 服务端→客户端请求不应答 ⇒ `session/requestRuntimePreferences` 20s 超时、整轮卡死；
 *   3. `basedOnZCodeBuiltinRevision` 必须与 spawn 的 builtin 文件**逐字符同源**（差一字即静默丢弃）；
 *   4. 注入是**异步注册**：立刻 `setModel` 会报 `Provider Registry 中不存在 Model`（需等 ~2s）。
 */
import { spawn } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

/* ────────────────────────────── 常量 ────────────────────────────── */

/** 运行时偏好应答（服务端会问；不回 agent 会卡住）。与 GUI/桥接同值。 */
export const RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
};

const ACCOUNT_INJECT_SETTLE_MS = 2000; // 注入是异步注册，见模块头注释第 4 点
const STEP_SETTLE_MS = 1500; // setModel 之后的稳定期（与桥接同值）
const LINE_BUFFER_CAP = 4 * 1024 * 1024;
const STDERR_TAIL_LINES = 16;
const RPC_TIMEOUT_MS = 30000;
const DEFAULT_CREDENTIAL_STORE = () => join(homedir(), '.zcode', 'v2', 'credentials.json');
const ENC_PREFIX = 'enc:v1:';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ────────────────────── 凭据（只解密、不落盘、不打日志） ────────────────────── */

/**
 * 解密 `enc:v1:` 值（与 zcode.cjs 同式：AES-256-GCM，key = sha256(secret)）。
 * 非密文原样返回 null —— 调用方据此判"这条不可用"。
 * @param {unknown} value
 * @returns {string|null}
 */
export function decryptCredentialValue(value) {
  try {
    if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return null;
    const parts = value.slice(ENC_PREFIX.length).split('.');
    if (parts.length !== 3) return null;
    const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64url'));
    if (iv.length !== 12 || tag.length !== 16 || data.length === 0) return null;
    const secret =
      process.env.ZCODE_CREDENTIAL_SECRET?.trim() ||
      `zcode-credential-fallback:${platform()}:${homedir()}:${(() => {
        try {
          return userInfo().username;
        } catch {
          return 'unknown';
        }
      })()}`;
    const key = createHash('sha256').update(secret).digest();
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * 读 Start Plan 鉴权（**只解密、不打印**）。
 * 只有 `zcodejwttoken` 可用；`oauth:*:access_token` 是过期会话 token（回它上游 401）。
 * `oauth:active_provider` 也**必须解密后**读（凭据库里除它以外都是密文；不解密会让家族判定
 * 静默失效 → 注入错家族且**不报错**）。
 * @param {string} [storePath]
 * @returns {{token: string, activeProvider?: string}}
 */
export function readGiftAuth(storePath = DEFAULT_CREDENTIAL_STORE()) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(storePath, 'utf8'));
  } catch (error) {
    throw new Error(`读不到 ZCode 共享凭证库 ${storePath}（${error?.code ?? error?.message}）。请确认 ZCode 客户端已登录。`);
  }
  const token = decryptCredentialValue(raw?.zcodejwttoken);
  if (typeof token !== 'string' || token === '') {
    throw new Error('共享凭证库里没有可用的 zcodejwttoken（Start Plan 鉴权 token）。请确认已登录 Z.ai / 智谱账号并已领取 Start Plan 额度。');
  }
  const activePlain = typeof raw?.['oauth:active_provider'] === 'string' ? decryptCredentialValue(raw['oauth:active_provider']) : null;
  const activeProvider = typeof activePlain === 'string' && activePlain !== '' ? activePlain : undefined;
  return activeProvider === undefined ? { token } : { token, activeProvider };
}

/** 账号家族 → Start Plan 账户 provider id（`bigmodel` → `account:bigmodel-start-plan`）。 */
export function startPlanProviderId(activeProvider) {
  return `account:${activeProvider === 'zai' ? 'zai' : 'bigmodel'}-start-plan`;
}

/**
 * 该模型在本机 `~/.zcode/v2/config.json` 里的**官方默认思考档**（`reasoning.defaultVariant`）。
 *
 * 为什么必须要它：这条通道的 `session/setModel` **强制要求** `options.reasoningLevel`
 * （真机实测报错 `Reasoning level is required for account:…/GLM-5.3-Flash`）——
 * 我们桥接总是传档位，所以这个约束在那边从未暴露。
 * 注意：官方声明在 **config.json 的 provider 条目**里，不是 builtin 运行时文件
 * （builtin 里既没有 `variants` 也没有 `defaultVariant`，实测 0 处）。
 * @param {string} modelId
 * @param {string} [appConfigPath]
 * @returns {string|undefined}
 */
export function defaultReasoningLevelFor(modelId, appConfigPath = join(homedir(), '.zcode', 'v2', 'config.json')) {
  try {
    const cfg = JSON.parse(readFileSync(appConfigPath, 'utf8'));
    for (const entry of Object.values(cfg?.provider ?? {})) {
      const variant = entry?.models?.[modelId]?.reasoning?.defaultVariant;
      if (typeof variant === 'string' && variant !== '') return variant;
    }
  } catch {
    /* 读不到就不猜（调用方有兜底） */
  }
  return undefined;
}

/* ──────────────────── builtin 运行时与注入修订号 ──────────────────── */

/** 平台目录名（与 ZCode GUI 同式：win32 → `windows-x86_64`）。 */
function runtimePlatformDir() {
  const plat = platform();
  const arch = process.arch;
  if (plat === 'win32') return `windows-${arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
  return `${plat}-${arch}`;
}

/**
 * 定位 `zcode-builtin.json`（GUI 同款运行时目录）：
 *   `<home>/.zcode/v2/runtime/provider/<platform>/<version>/<endpoint-*>/zcode-builtin.json`
 * 优先**非 `0.0.0-dev`**（那是 CLI 裸跑的 fallback），其中取最新。
 * **这个文件必须与 spawn 时给 CLI 的 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 是同一个**。
 * @returns {{version: string, file: string}|undefined}
 */
export function resolveGiftRuntime(baseDir = homedir()) {
  const root = join(baseDir, '.zcode', 'v2', 'runtime', 'provider', runtimePlatformDir());
  let best;
  let dev;
  let versions;
  try {
    versions = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const versionDir of versions) {
    if (!versionDir.isDirectory?.()) continue;
    let endpoints;
    try {
      endpoints = readdirSync(join(root, versionDir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const endpointDir of endpoints) {
      if (!endpointDir.isDirectory?.() || !String(endpointDir.name).startsWith('endpoint-')) continue;
      const file = join(root, versionDir.name, endpointDir.name, 'zcode-builtin.json');
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      const candidate = { version: versionDir.name, file, mtimeMs: stat.mtimeMs };
      if (versionDir.name === '0.0.0-dev') dev = candidate;
      else if (best === undefined || stat.mtimeMs > best.mtimeMs) best = candidate;
    }
  }
  return best ?? dev;
}

/** `zcode-builtin:<release.revision>:<sha256(resolve(path))>`（registry 做严格相等比较）。 */
export function computeBuiltinRevision(file, readFileImpl = (f) => readFileSync(f, 'utf8')) {
  const release = JSON.parse(readFileImpl(file));
  const hash = createHash('sha256').update(resolve(file)).digest('hex');
  return `zcode-builtin:${release.revision}:${hash}`;
}

/** spawn 时的 env 五件套（少一个 ⇒ 注入静默失效，见模块头注释第 1 点）。 */
export function buildGiftEnv(runtime, sourceEnv = process.env, baseDir = homedir()) {
  return {
    ...sourceEnv,
    ZCODE_APP_VERSION: runtime.version,
    ZCODE_SERVICE_AUTHORITY_MODE: 'desktop-local',
    ZCODE_BASE_URL: 'https://zcode.z.ai',
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: runtime.file,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(baseDir, '.zcode', 'v2', 'provider_config.json'),
  };
}

/* ────────────────────────── stdio RPC 客户端 ────────────────────────── */

/**
 * app-server 的 stdio RPC 客户端（**与派发台 `core/appserver-rpc.mjs` 同协议**），
 * 但**多了一项必需能力**：应答服务端→客户端的请求（`respond`）。
 * 没有它，`session/requestRuntimePreferences` 会把整轮拖到 20s 超时。
 * @param {{cliPath: string, env: object, timeoutMs?: number, onNotification?: Function,
 *          onServerRequest?: Function, spawnImpl?: Function, logger?: object}} opts
 */
export async function createGiftRpcClient(opts) {
  const spawnImpl = opts.spawnImpl ?? spawn;
  const callTimeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : RPC_TIMEOUT_MS;
  const child = spawnImpl(process.execPath, [opts.cliPath, 'app-server', '--stdio', '--surface', 'terminal'], {
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  const stderrLines = [];
  let lineBuf = '';
  let nextId = 1;
  let closed = false;
  let exited = null;

  const failAll = (error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };
  const write = (obj) => {
    try {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch (error) {
      opts.logger?.warn?.(`[gift] stdin 写入失败：${error?.message ?? error}`);
      return false;
    }
  };
  const handleLine = (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 坏行忽略（与派发台传输层同策略）
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.id !== undefined && msg.id !== null && pending.has(String(msg.id))) {
      const p = pending.get(String(msg.id));
      pending.delete(String(msg.id));
      clearTimeout(p.timer);
      if (msg.error && typeof msg.error === 'object') {
        const e = new Error(`rpc-error ${msg.error.code ?? ''}: ${msg.error.message ?? 'unknown'}`.trim());
        e.code = msg.error.code;
        p.reject(e);
      } else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) {
        /* ★ 服务端请求：必须应答（本模块相对派发台传输层新增的能力）。
         * 交给调用方的回调；回调没处理就回空对象，绝不让它悬着超时。 */
        const handled = opts.onServerRequest?.(msg, write);
        if (handled !== true) write({ id: msg.id, result: {} });
        return;
      }
      opts.onNotification?.(msg);
    }
  };
  child.stdout?.on('data', (chunk) => {
    lineBuf += chunk.toString();
    let at;
    while ((at = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, at).replace(/\r$/, '');
      lineBuf = lineBuf.slice(at + 1);
      if (line.trim()) handleLine(line);
    }
    if (lineBuf.length > LINE_BUFFER_CAP) lineBuf = '';
  });
  child.stdout?.on('error', () => {});
  child.stderr?.on('data', (chunk) => {
    for (const l of chunk.toString().split('\n')) {
      if (!l.trim()) continue;
      stderrLines.push(l.replace(/\r$/, ''));
      if (stderrLines.length > STDERR_TAIL_LINES) stderrLines.shift();
    }
  });
  child.stderr?.on('error', () => {});
  child.on('error', (error) => {
    exited = { code: null, signal: null, spawnError: error.message };
    failAll(Object.assign(new Error(`spawn-failed: ${error.message}`), { cause: error }));
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    failAll(new Error(`app-server-exited: code=${code} signal=${signal}`));
  });
  child.stdin?.on('error', () => {});
  await new Promise((done, fail) => {
    if (child.pid) return done();
    const onErr = (e) => fail(new Error(`spawn-failed: ${e.message}`));
    child.once('error', onErr);
    child.once('exit', (code) => fail(new Error(`app-server-exited: code=${code}`)));
  });

  return {
    pid: child.pid,
    call(method, params, ms) {
      if (closed) return Promise.reject(new Error('client-closed'));
      if (exited !== null) return Promise.reject(new Error(`app-server-exited: code=${exited.code} signal=${exited.signal}`));
      const id = nextId;
      nextId += 1;
      const timeout = Number(ms) > 0 ? Number(ms) : callTimeoutMs;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(String(id));
          rej(new Error(`timeout: ${method} ${timeout}ms 无响应`));
        }, timeout);
        timer.unref?.();
        pending.set(String(id), { resolve: res, reject: rej, timer });
        if (!write({ id, method, params })) {
          pending.delete(String(id));
          clearTimeout(timer);
          rej(new Error(`stdin-write-failed: ${method}`));
        }
      });
    },
    notify(method, params) {
      return write({ method, params });
    },
    stderrTail: () => [...stderrLines],
    exitInfo: () => exited,
    close() {
      if (closed) return;
      closed = true;
      if (exited === null && platform() === 'win32') {
        try {
          const killer = spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killer.on?.('error', () => {});
        } catch {
          /* 树杀失败不致命 */
        }
      }
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      failAll(new Error('client-closed'));
    },
  };
}

/* ───────────────────────────── 回合驱动 ───────────────────────────── */

/**
 * 跑一轮 Start Plan（免费额度）任务，返回与 runner print 模式**同形**的结果对象。
 *
 * @param {object} opts
 * @param {string} opts.cliPath      zcode.cjs 绝对路径
 * @param {string} opts.prompt       任务文本（已组装；agent 在自己的运行时里执行）
 * @param {string} opts.cwd          agent 的工作目录（workspacePath）
 * @param {string} [opts.model]      模型 id（默认 GLM-5.3-Flash）
 * @param {string} [opts.reasoningLevel] 思考档（low|high|max…；不传则不覆盖）
 * @param {string} [opts.mode]       build|edit|plan|yolo（yolo → app-server 的 yolo，其余 → build）
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.credentialStorePath]
 * @param {Function} [opts.onEvent]  (kind, payload) 事件回调（进度打印用）
 * @param {object} [opts.logger]
 * @returns {Promise<object>} {ok, exitCode, sessionId, response, usage, projection, finish, channel, ...}
 */
export async function runGiftTurn(opts) {
  const logger = opts.logger ?? {};
  const startedAt = Date.now();
  const runtime = resolveGiftRuntime();
  if (runtime === undefined) {
    return failed('no-runtime', '定位不到 ZCode builtin 运行时目录（~/.zcode/v2/runtime/provider/<platform>/<ver>/<endpoint>/zcode-builtin.json）');
  }
  let auth;
  try {
    auth = readGiftAuth(opts.credentialStorePath);
  } catch (error) {
    return failed('no-credential', error?.message ?? String(error));
  }
  const accountProviderId = opts.accountProviderId ?? startPlanProviderId(auth.activeProvider);
  const revision = computeBuiltinRevision(runtime.file);
  const modelId = opts.model ?? 'GLM-5.3-Flash';
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 45 * 60 * 1000;
  /* 思考档**必填**（见 defaultReasoningLevelFor 注释：这条通道的 setModel 会硬校验）。
   * 取值链：显式档位 > 本机 config.json 的官方 defaultVariant > 'max'。
   * ⚠️ 派发台的 `--reasoning-level agent` 是**伪值**（"Agent决定/不覆盖"，见其 CLI 文档），
   * 不是合法档位 —— 必须在这里翻译掉，否则真机报
   * `Reasoning effort "agent" is not supported by account:…/GLM-5.3-Flash`（ZB-33 实测）。 */
  const requestedLevel =
    typeof opts.reasoningLevel === 'string' && opts.reasoningLevel !== '' && opts.reasoningLevel !== 'agent'
      ? opts.reasoningLevel
      : undefined;
  const reasoningLevel = requestedLevel ?? defaultReasoningLevelFor(modelId) ?? 'max';

  logger.info?.(
    `[gift] 运行时=${runtime.version} 账户=${accountProviderId} 模型=${modelId} 思考档=${reasoningLevel}` +
      `${opts.reasoningLevel === 'agent' ? '（由 agent 伪值回落官方默认）' : ''}（token ${auth.token.length} 字符，不打印）`,
  );

  let text = '';
  let reasoningChars = 0;
  const toolEvents = [];
  const seenEventTypes = new Set(); // 首次出现的 event 类型打一行诊断（对齐真实事件词汇表）
  const permissionRequests = []; // 每次审批请求（method/mode/decision）—— yolo vs edit 的差异可观测
  /* ZB-40：**阶段/进度共享对象**（job 模块拿着它周期性地打 `[zcode-run] progress …` 心跳，
   * 让派发台面板能显示"当前在做什么"，而不是只有沉默）。 */
  const progress = opts.progress ?? {};
  const mark = (stage) => {
    progress.stage = stage;
    progress.at = Date.now();
  };
  let finished;
  let channel;
  let turnUsage;
  let settled = false;
  let serverRequests = 0;

  const client = await createGiftRpcClient({
    cliPath: opts.cliPath,
    env: buildGiftEnv(runtime),
    logger,
    onServerRequest: (msg, write) => {
      serverRequests += 1;
      if (msg.method === 'session/requestRuntimePreferences') {
        write({ id: msg.id, result: RUNTIME_PREFERENCES });
        return true;
      }
      if (msg.method === 'interaction/requestProviderRuntimeHeaders') {
        // 关键：agent 自己算签名，我们只把 token 递回去（绝不打日志）。
        write({
          id: msg.id,
          result: {
            headersApplied: true,
            requestAuth: {
              apiKey: auth.token,
              headers: {
                'http-referer': 'https://zcode.z.ai',
                'user-agent': `ZCode/${runtime.version}`,
                'x-zcode-app-version': runtime.version,
                'x-title': 'Z Code@cli',
              },
            },
          },
        });
        return true;
      }
      if (/permission|approval/i.test(String(msg.method))) {
        /* 权限：派发是**无人值守**语义 —— 与 print 模式（headless、无人可批）以及姊妹项目
         * dsh-connect-zcode 桥接的 `appServerToolPolicy: allow-all` 保持一致：**默认放行**；
         * 唯一例外是 `plan` 模式（该模式契约就是"只规划不执行"）。
         *
         * ⚠️ 2026-10-11 真机实测（ZB-34）：本行原为「仅 yolo 放行」，导致 `--mode edit`
         * （runner 的默认派发模式）下 agent 的 Write 被拒 —— 它回复「Write 工具调用被拒绝了，
         * 文件未创建」，**与付费套餐 print 模式不等价**。故修正为默认放行。 */
        const allow = opts.mode !== 'plan';
        permissionRequests.push({ method: String(msg.method), mode: opts.mode ?? 'edit', decision: allow ? 'allow' : 'deny' });
        logger.info?.(
          `[gift] 权限请求 ${msg.method} → ${allow ? 'allow' : 'deny'}（mode=${opts.mode ?? 'edit'}）` +
            `${JSON.stringify(msg.params ?? {}).slice(0, 200)}`,
        );
        write({ id: msg.id, result: { decision: allow ? 'allow' : 'deny' } });
        return true;
      }
      return false;
    },
    onNotification: (msg) => {
      if (msg.method !== 'session/event') return;
      const params = msg.params ?? {};
      const payload = params.payload ?? params;
      const type = typeof params.type === 'string' ? params.type : payload?.type;
      switch (type) {
        case 'session.updated':
          if (typeof payload?.baseURL === 'string') {
            channel = { providerId: payload.providerId, modelId: payload.modelId, baseURL: payload.baseURL };
          }
          break;
        case 'model.streaming': {
          const kind = payload?.kind;
          if (kind === 'text_delta' && typeof payload.delta === 'string') text += payload.delta;
          else if (kind === 'reasoning_delta' && typeof payload.delta === 'string') reasoningChars += payload.delta.length;
          progress.textChars = text.length; // ZB-40：心跳用（"正在流式输出 N 字"）
          progress.reasoningChars = reasoningChars;
          opts.onEvent?.('delta', { kind, chars: String(payload?.delta ?? '').length });
          break;
        }
        case 'tool.call':
        case 'tool.started':
        case 'tool.completed': {
          const name = payload?.name ?? payload?.toolName;
          if (name) {
            toolEvents.push({ type, name });
            opts.onEvent?.('tool', { type, name });
          }
          break;
        }
        case 'turn.completed':
          settled = payload?.resultType === 'success';
          turnUsage = payload?.usage;
          finished = {
            response: typeof payload?.response === 'string' ? payload.response : '',
            resultType: payload?.resultType ?? 'unknown',
            error: payload?.error?.message ?? payload?.errorMessage,
          };
          opts.onEvent?.('turn', finished);
          break;
        /* ZB-40（真机事故）：**失败的回合必须立刻收尾**。此前只认 `turn.completed`，
         * 而失败回合只发 `turn.failed` ⇒ 死等直到 timeoutMin，外部表现为"running 但零输出、
         * 额度不动"。这里把上游业务错误（providerCode/providerMessage/modelId）结构化带出。 */
        case 'turn.failed': {
          const err = payload?.error ?? payload?.cause ?? payload;
          const ctx = err?.context ?? err?.cause?.context ?? {};
          const providerError = {
            message: ctx.providerMessage ?? err?.message ?? 'turn failed',
            code: ctx.providerCode ?? err?.code ?? null,
            providerId: ctx.providerId ?? null,
            modelId: ctx.modelId ?? null,
            retryable: ctx.retryable ?? null,
          };
          finished = { response: text, resultType: 'failed', error: providerError.message, providerError };
          opts.onEvent?.('turn', finished);
          break;
        }
        default: {
          /* 诊断 + 工具计数：
           * ① 每个**首次出现**的 event 类型打一行 `[gift] event=<type>`（不带 [zcode-run] 前缀，
           *    不会污染派发台的输出行解析）—— 便于对齐 ZCode 的真实事件词汇表，别再靠猜；
           * ② `tool*` 类型一律计入工具事件（此前只列了三个猜出来的名字，实测 toolEventCount 恒为 0）。 */
          if (typeof type === 'string' && type !== '' && !seenEventTypes.has(type)) {
            seenEventTypes.add(type);
            logger.info?.(`[gift] event=${type}`);
          }
          if (typeof type === 'string' && /^tool[.\-_]/i.test(type)) {
            const name = payload?.name ?? payload?.toolName ?? payload?.tool ?? '(unnamed)';
            toolEvents.push({ type, name });
            progress.tools = toolEvents.length; // ZB-40：心跳用
            progress.lastTool = name;
            opts.onEvent?.('tool', { type, name });
          }
          break;
        }
      }
    },
  });

  let exitCode = 1;
  let timedOut = false;
  let sessionId;
  let projection = {};
  let usage = { inputTokens: null, outputTokens: null };
  let basis = 'none';
  try {
    mark('create-session');
    const created = await client.call('session/create', { workspace: { workspacePath: opts.cwd, workspaceKey: 'dispatch-gift' } });
    sessionId = created?.session?.sessionId ?? created?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('app-server 没有返回 sessionId');
    progress.sessionId = sessionId;
    mark('subscribe');
    await client.call('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true });
    try {
      mark('set-mode');
      await client.call('session/setMode', { sessionId, mode: opts.mode === 'yolo' ? 'yolo' : 'build' });
    } catch (error) {
      logger.warn?.(`[gift] setMode 失败（用会话默认模式继续）：${error?.message ?? error}`);
    }
    /* 账户注入：basedOn 必须与 spawn 的 builtin 文件同源 */
    mark('inject-account');
    const injected = await client.call('provider/updateAccountConfig', {
      revision: `dispatch-gift:${Date.now()}`,
      basedOnZCodeBuiltinRevision: revision,
      providers: { [accountProviderId]: { access: { type: 'zhipu-account', entitled: true }, builtinModelIds: [modelId] } },
      states: { [accountProviderId]: { availability: 'available', entitled: true, current: true } },
    });
    logger.info?.(`[gift] 账户注入 providerCount=${injected?.providerCount ?? '?'} status=${injected?.status ?? '?'}`);
    await sleep(ACCOUNT_INJECT_SETTLE_MS); // 异步注册：不等待会撞 "Provider Registry 中不存在 Model"
    mark('set-model');
    await client.call('session/setModel', {
      sessionId,
      model: { providerId: accountProviderId, modelId, options: { reasoningLevel } }, // 档位必填，见上
    });
    await sleep(STEP_SETTLE_MS);
    mark('send-turn');
    await client.call('session/send', { sessionId, content: opts.prompt });
    mark('waiting-turn');

    /* 等回合结束（或超时 / 进程死亡） */
    const deadline = Date.now() + timeoutMs;
    while (finished === undefined) {
      if (client.exitInfo() !== null) {
        finished = { response: '', resultType: 'failed', error: `app-server 退出：${JSON.stringify(client.exitInfo())}` };
        break;
      }
      if (Date.now() > deadline) {
        timedOut = true;
        try {
          client.notify('session/stop', { sessionId });
        } catch {
          /* 尽力而为 */
        }
        break;
      }
      await sleep(200);
    }

    if (finished !== undefined) exitCode = finished.resultType === 'success' ? 0 : 1;
    else if (timedOut) exitCode = 124;

    /* usage 口径（与 dsh-connect-zcode §2.10 同源）：CLI 的 turn.completed.usage 是**回合聚合**
     * （本回合 N 次模型调用之和），直接记账会虚高 N 倍 ⇒ 单调用原样、多调用改读按次上下文。 */
    const read = sessionId === undefined ? null : await client.call('session/read', { sessionId, messageLimit: 1 }).catch(() => null);
    projection = read?.projection ?? {};
    if (turnUsage !== undefined && turnUsage !== null) {
      const calls = turnUsage.modelRequestCount;
      if (!(typeof calls === 'number' && calls > 1)) {
        usage = turnUsage;
        basis = 'cli-single';
      } else if (Number.isFinite(projection.contextUsed) && projection.contextUsed > 0) {
        /* 多调用回合：**input 用按次上下文口径**（CLI 的聚合是 N 次之和，直接记会虚高 N 倍），
         * **output 仍取回合累计** —— 生成总量本来就是各次之和，取 0 会丢掉真实信息。
         * 两者口径不同，`usageBasis` + `modelRequestCount` 就是给读表人的说明。 */
        usage = { ...turnUsage, inputTokens: projection.contextUsed, outputTokens: turnUsage.outputTokens ?? 0 };
        basis = 'context-used';
      } else {
        usage = {
          ...turnUsage,
          inputTokens: Math.round((turnUsage.inputTokens ?? 0) / calls),
          outputTokens: turnUsage.outputTokens ?? 0, // 同上：总量照记
        };
        basis = 'divided';
      }
    }
  } catch (error) {
    finished = { response: text, resultType: 'failed', error: error?.message ?? String(error) };
    exitCode = 1;
  } finally {
    client.close();
  }

  const response = (finished?.response && finished.response !== '' ? finished.response : text) ?? '';
  return {
    ok: exitCode === 0,
    exitCode,
    timedOut,
    errorKind: finished?.resultType === 'failed' ? finished?.error : undefined,
    sessionId,
    response,
    textChars: response.length,
    reasoningChars,
    toolEvents: toolEvents.length,
    /* 可观测性（ZB-34）：产物里带上**用过的工具名**与**见过的事件类型** ——
     * 否则"这次派发到底用没用工具、用了哪些"只能靠读 agent 的自我报告。 */
    toolNames: [...new Set(toolEvents.map((t) => t.name).filter((n) => n && n !== '(unnamed)'))],
    eventTypes: [...seenEventTypes].sort(),
    /* 审批链路（ZB-35）：yolo 下通常为空；edit/build 下每个需审批的工具调用会有一条。 */
    permissionRequests,
    usage: { ...usage, modelRequestCount: turnUsage?.modelRequestCount ?? null, usageBasis: basis },
    projection: {
      contextUsed: projection.contextUsed ?? null,
      contextWindow: projection.contextWindow ?? null,
      turnCount: projection.turnCount ?? null,
    },
    finish: { kind: finished?.resultType ?? (timedOut ? 'timeout' : 'unknown'), error: finished?.error },
    /* ZB-40：**上游业务错误的结构化留痕**（真机事故：`GLM-5.3` 在免费额度通道被判
     * `providerCode 1005 exceed quota limit` ⇒ 轮次失败；此前 runner 不认 `turn.failed`，
     * 干等 35 分钟、无产物、额度不动，从外面看就像"卡住"）。 */
    providerError: finished?.providerError ?? null,
    channel: channel ?? { providerId: accountProviderId, modelId, baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic' },
    accountProviderId,
    runtimeVersion: runtime.version,
    serverRequests,
    elapsedMs: Date.now() - startedAt,
    stderrTail: client.stderrTail(),
  };

  function failed(kind, message) {
    return {
      ok: false,
      exitCode: 1,
      timedOut: false,
      errorKind: `${kind}: ${message}`,
      sessionId: undefined,
      response: '',
      textChars: 0,
      reasoningChars: 0,
      toolEvents: 0,
      usage: { inputTokens: null, outputTokens: null, modelRequestCount: null, usageBasis: 'none' },
      projection: { contextUsed: null, contextWindow: null, turnCount: null },
      finish: { kind: 'failed', error: `${kind}: ${message}` },
      channel: null,
      serverRequests: 0,
      elapsedMs: Date.now() - startedAt,
      stderrTail: [],
    };
  }
}
