/**
 * ZCode Agent CLI app-server 的 stdio RPC 客户端（零 npm 依赖，ESM）。
 *
 * 协议（Z3 实测，2026-09-30，见 tasks/Z3-delivery.md 原始报文）：
 *   - 启动：`node <zcode.cjs> app-server --stdio --surface terminal`，需要两个环境变量
 *     （ZCODE_BUILTIN_PROVIDER_CONFIG_FILE / ZCODE_PERSONAL_PROVIDER_CONFIG_FILE），否则起不来。
 *   - 帧 = 逐行 NDJSON。C→S 请求是裸 `{id, method, params}`（**没有** JSON-RPC 的 jsonrpc 包装，
 *     带 jsonrpc 会被 -32600 拒绝）；S→C 通知是 `{method, params}`，响应是 `{id, result}` 或 `{id, error}`。
 *   - 无握手：stdio 模式不需要 hello/clientHello（那是桌面 WebSocket 面的），启动后会先收到
 *     数条 `startup/storageState` 通知，直接发业务请求即可。
 *   - id 原样回显（int 或 string 均可），按 id 匹配；协议级错误如 `{"code":-32601,"message":"Method not found: x"}`。
 *
 * 生命周期：close() 在 Windows 下先 `taskkill /PID <pid> /T /F`（树杀，兜底孙进程）再 child.kill()；
 * taskkill 找不到进程（已退出）返回非 0 属正常。任何失败都让挂起请求以 Error 收尾，绝不悬挂。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_CLI_PATH = 'F:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs';
const LINE_BUFFER_CAP = 4 * 1024 * 1024; // 无换行的坏流缓冲上限，防 OOM
const STDERR_TAIL_LINES = 16;

/** 默认环境变量：builtin 配置从 cliPath 推导（…/resources/glm → …/resources/config/provider），personal 用 ~/.zcode/v2。 */
function defaultEnv(cliPath) {
  return {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(cliPath, '..', '..', 'config', 'provider', 'zcode-builtin.json'),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(homedir(), '.zcode', 'v2', 'provider_config.json'),
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.cliPath] zcode.cjs 路径（默认本机安装路径，可被 env DSP_APPSERVER_CLI 覆盖）
 * @param {object} [opts.env] 追加/覆盖子进程环境变量（不会打印；缺省补齐两个 ZCODE_* 必需项）
 * @param {number} [opts.timeoutMs=20000] 单次 call 的默认超时
 * @param {Function} [opts.spawnImpl] 测试注入，签名同 node:child_process 的 spawn
 * @param {(msg:object)=>void} [opts.onNotification] 收到 S→C 通知（{method,params}）时的回调
 * @returns {Promise<{call, close, stderrTail, stats, pid}>}
 */
export async function createAppServerClient(opts = {}) {
  const spawnImpl = opts.spawnImpl || nodeSpawn;
  const callTimeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 20000;
  const cliPath = opts.cliPath || process.env.DSP_APPSERVER_CLI || DEFAULT_CLI_PATH;

  const child = spawnImpl(process.execPath, [cliPath, 'app-server', '--stdio', '--surface', 'terminal'], {
    env: { ...process.env, ...defaultEnv(cliPath), ...(opts.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const pending = new Map(); // id -> { resolve, reject, timer }
  const stats = { sent: 0, received: 0, badLines: 0, notifications: 0, truncatedLines: 0 };
  const stderrLines = [];
  let nextId = 1;
  let closed = false;
  let exited = false;
  let exitInfo = null;
  let spawnError = null;
  let lineBuf = '';

  const failAll = (err) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };

  const handleLine = (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      stats.badLines += 1; // 坏行不致命：计数并忽略
      return;
    }
    if (!msg || typeof msg !== 'object') {
      stats.badLines += 1;
      return;
    }
    if (msg.id !== undefined && msg.id !== null && pending.has(String(msg.id))) {
      const p = pending.get(String(msg.id));
      pending.delete(String(msg.id));
      clearTimeout(p.timer);
      stats.received += 1;
      if (msg.error && typeof msg.error === 'object') {
        const e = new Error(`rpc-error ${msg.error.code ?? ''}: ${msg.error.message ?? 'unknown'}`.trim());
        e.code = msg.error.code;
        e.rpcData = msg.error.data;
        p.reject(e);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      stats.notifications += 1;
      try {
        opts.onNotification?.(msg);
      } catch { /* 回调异常不影响流 */ }
    }
    // 其余（无关 id 的响应等）忽略
  };

  child.stdout?.on('data', (chunk) => {
    lineBuf += chunk.toString();
    let i;
    while ((i = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, i).replace(/\r$/, '');
      lineBuf = lineBuf.slice(i + 1);
      if (line.trim()) handleLine(line);
    }
    if (lineBuf.length > LINE_BUFFER_CAP) {
      // 无换行的坏流：丢弃缓冲防 OOM
      stats.truncatedLines += 1;
      lineBuf = '';
    }
  });
  child.stdout?.on('error', () => { /* stdout 关闭竞态，忽略 */ });

  child.stderr?.on('data', (chunk) => {
    for (const l of chunk.toString().split('\n')) {
      if (!l.trim()) continue;
      stderrLines.push(l.replace(/\r$/, ''));
      if (stderrLines.length > STDERR_TAIL_LINES) stderrLines.shift();
    }
  });
  child.stderr?.on('error', () => { /* 同上 */ });

  child.on('error', (e) => {
    spawnError = e; // ENOENT 等：spawn 本身失败
    failAll(Object.assign(new Error(`spawn-failed: ${e.message}`), { cause: e }));
  });
  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
    failAll(Object.assign(new Error(`app-server-exited: code=${code} signal=${signal}`), { exitInfo }));
  });
  // 防未处理的 stdin EPIPE/EBADF 把进程打崩
  child.stdin?.on('error', () => { /* 写失败由 call() 的 try/catch 反馈 */ });

  const awaitSpawnReady = () => new Promise((resolve, reject) => {
    if (spawnError) return reject(new Error(`spawn-failed: ${spawnError.message}`));
    if (exited) return reject(new Error(`app-server-exited: code=${exitInfo?.code} signal=${exitInfo?.signal}`));
    if (child.pid) return resolve();
    const onErr = (e) => { cleanup(); reject(new Error(`spawn-failed: ${e.message}`)); };
    const onExit = (code, signal) => { cleanup(); reject(new Error(`app-server-exited: code=${code} signal=${signal}`)); };
    const cleanup = () => {
      child.removeListener('error', onErr);
      child.removeListener('exit', onExit);
    };
    child.once('error', onErr);
    child.once('exit', onExit);
  });
  await awaitSpawnReady();

  function call(method, params, callOpts = {}) {
    const timeoutMs = Number.isFinite(Number(callOpts.timeoutMs)) && Number(callOpts.timeoutMs) > 0
      ? Number(callOpts.timeoutMs) : callTimeoutMs;
    if (closed) return Promise.reject(new Error('client-closed'));
    if (exited) return Promise.reject(new Error(`app-server-exited: code=${exitInfo?.code} signal=${exitInfo?.signal}`));
    if (spawnError) return Promise.reject(new Error(`spawn-failed: ${spawnError.message}`));
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`timeout: ${method} ${timeoutMs}ms 无响应`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(String(id), { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        stats.sent += 1;
      } catch (e) {
        pending.delete(String(id));
        clearTimeout(timer);
        reject(new Error(`stdin-write-failed: ${e.message}`));
      }
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    if (!exited && process.platform === 'win32') {
      // Windows：先树杀（孙进程兜底）。进程已退出时 taskkill 报非 0（找不到 PID），忽略。
      try {
        const tk = spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        tk.on?.('error', () => {});
      } catch { /* 注入实现可能不支持，kill() 兜底 */ }
    }
    try {
      child.kill();
    } catch { /* 已退出 */ }
    failAll(new Error('client-closed'));
  }

  const stderrTail = () => [...stderrLines];
  return { call, close, stderrTail, stats, pid: child.pid };
}
