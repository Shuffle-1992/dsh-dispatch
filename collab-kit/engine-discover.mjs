// 三引擎自动发现层（ZB-51）：ZCode / OpenCode / Qoder —— **CLI / IDE 自带 / 客户端三种形态都要认**。
//
// 为什么需要它（真机教训）：
//   - ZCode 是 Electron 客户端，CLI 是它自带的 `resources/glm/zcode.cjs`，**不在 PATH**；
//     原先执行器里写死 `F:\Program Files\ZCode\...` —— 别人装在 C: 盘就"插件装了却用不了"。
//   - OpenCode 可能是 npm 全局 CLI，也可能是独立客户端。
//   - Qoder 有**全球版与 CN 版两套名字**（`qoder` / `qoderclicn`，`~/.qoder` / `~/.qoder-cn`），
//     而且 IDE 与 CLI 的登录态**互相独立**（实测：IDE 登录着，CLI 仍报 Not logged in）。
//
// 设计原则（照抄 Qoder 官方 dispatcher `qodercn-dispatcher.ps1` 的优先级，并扩两级）：
//   ① env 覆盖 → ② 插件 config → ③ PATH（PATHEXT 感知，**同名多命中只取第一个**）
//   → ④ 已知安装位置扫描（含跨盘符）→ ⑤ 全失败（返回可解释原因，不抛）
//
// 硬约束：零依赖（只用 node 内置）；**只读**探测（凭据只判存在性，绝不解析内容）；
// 任何失败都不抛到调用方；所有子进程探测都带超时。
import { existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, delimiter, basename, extname, isAbsolute, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';

export const ENGINES = ['zcode', 'opencode', 'qoder', 'codebuddy'];

const IS_WIN = platform() === 'win32';
const HOME = homedir();

/** 便于测试注入默认值：真实的 fs 探测函数。 */
const REAL_FS = { existsSync, statSync, readdirSync };

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const safeExists = (fs, p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };
const safeIsFile = (fs, p) => { try { return !!p && fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } };
const safeIsDir = (fs, p) => { try { return !!p && fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; } };
const safeSize = (fs, p) => { try { return fs.statSync(p).size; } catch { return 0 }; };

/** Windows 盘符根列表（A..Z 中真实存在的）；非 Windows 返回空。 */
function driveRoots(fs) {
  if (!IS_WIN) return [];
  const out = [];
  for (let c = 65; c <= 90; c += 1) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (safeIsDir(fs, root)) out.push(root);
  }
  return out;
}

/** 从 `--version` 之类输出里取出版本号（不伪造：取不到就是 null）。 */
export function parseVersion(text) {
  const m = String(text ?? '').match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return m ? m[1] : null;
}

/** 判断 entry 形态（决定调用方怎么 spawn：.cjs/.js 要前置 node）。 */
export function classifyEntry(entry) {
  if (!entry) return null;
  const ext = extname(entry).toLowerCase();
  if (ext === '.cjs') return 'cjs';
  if (ext === '.js' || ext === '.mjs') return 'js';
  if (ext === '.cmd' || ext === '.bat') return 'cmd';
  if (ext === '.ps1') return 'ps1';
  if (ext === '.exe') return 'exe';
  /* ⚠️ 无扩展名的文件**不一定是原生可执行**：WorkBuddy 自带 CLI 的入口就是
   * `<cli>/bin/codebuddy`（无扩展名，内容 `#!/usr/bin/env node`）——Windows 下直接 spawn
   * 会失败，必须前置 `process.execPath`。用 shebang 判定（只看头 128 字节，读失败当普通可执行）。
   * 只认 `node`：`~/.local/bin/opencode` 这类 POSIX 安装脚本也可能是无扩展名的 shell 脚本，
   * 一律前置 node 会把它们跑坏。 */
  if (ext === '' && hasNodeShebang(entry)) return 'js';
  // 无扩展名的可执行（*nix 安装脚本落点）
  return IS_WIN ? 'exe' : 'exe';
}

/** 该文件是否以 `#!…node` 开头（读失败 ⇒ false，绝不抛）。 */
function hasNodeShebang(p) {
  let fd;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, 128, 0);
    return /^#!.*\bnode\b/.test(buf.slice(0, n).toString('utf8'));
  } catch {
    return false;
  } finally {
    if (fd != null) { try { closeSync(fd); } catch { /* 尽力 */ } }
  }
}

/** 跑一个探测命令（带超时，绝不抛）。返回 {code, stdout, stderr}。
 *
 * ⚠️ Windows 的 `.cmd`/`.bat` **必须经 shell** 才能 spawn（否则 spawnSync 直接返回 `EINVAL`）——
 * 实测：`spawnSync('…\\opencode.cmd', ['--version'])` → status=null/error=EINVAL；
 * 加 `shell:true` → status=0/输出 `1.19.2`。这是"找到了文件却拿不到版本"的根因。 */
function runProbeReal(cmd, args, { cwd, timeoutMs, env } = {}) {
  try {
    const needShell = IS_WIN && /\.(cmd|bat)$/i.test(cmd);
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      cwd: cwd || undefined,
      env: env || process.env,
      windowsHide: true,
      shell: needShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.error?.code === 'ETIMEDOUT' };
  } catch (e) {
    return { code: null, stdout: '', stderr: e?.message ?? String(e), timedOut: false };
  }
}

/* ------------------------------------------------------------------ *
 * 各引擎候选表（`known` 级）
 * ------------------------------------------------------------------ */

/** 生成候选（去重、保序）。每一项 { path, kind } —— kind 用于说明"这属于哪种安装形态"。 */
function candidatesFor(engine, { fs, env, knownRoots = [] }) {
  const out = [];
  const push = (path, kind, level = 'known') => {
    if (!path) return;
    const norm = resolve(path);
    if (!out.some((x) => x.path === norm)) out.push({ path: norm, kind, level });
  };
  const appData = env.APPDATA;
  const localAppData = env.LOCALAPPDATA;
  const programFiles = env.ProgramFiles;
  const programFilesX86 = env['ProgramFiles(x86)'];
  const programData = env.ProgramData;

  if (engine === 'zcode') {
    /* ZCode：客户端自带 CLI。安装根下的相对子路径固定：
     *   <root>/resources/glm/zcode.cjs
     * 先扫已知根，再跨盘符扫（原硬编码在 F: 盘，这条是关键）。 */
    const rel = join('resources', 'glm', 'zcode.cjs');
    /* ⚠️ 每个候选都必须是**字符串**：`x && join(...)` 在 x 为 undefined 时会塞进 undefined，
     * 而 cross-drive 扫描是数组展开（更易混入空值）—— 统一用 filter(Boolean) 清一遍。 */
    const roots = [
      ...knownRoots,
      env.ZCODE_HOME, env.ZCODE_INSTALL_DIR,
      programFiles && join(programFiles, 'ZCode'),
      programFilesX86 && join(programFilesX86, 'ZCode'),
      localAppData && join(localAppData, 'Programs', 'ZCode'),
      localAppData && join(localAppData, 'ZCode'),
      programData && join(programData, 'ZCode'),
      ...driveRoots(fs).map((d) => join(d, 'Program Files', 'ZCode')),
      ...driveRoots(fs).map((d) => join(d, 'Program Files (x86)', 'ZCode')),
    ].filter((x) => typeof x === 'string' && x.length > 0);
    for (const r of roots) push(join(r, rel), 'client-bundled-cli');
    return out;
  }

  if (engine === 'opencode') {
    push(appData && join(appData, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'), 'npm-global-native');
    push(appData && join(appData, 'npm', 'opencode.cmd'), 'npm-shim');
    push(localAppData && join(localAppData, 'Programs', 'opencode', 'opencode.exe'), 'desktop-client');
    push(join(HOME, '.opencode', 'bin', 'opencode'), 'install-script');
    push(join(HOME, '.local', 'bin', 'opencode'), 'install-script');
    for (const r of knownRoots) push(join(r, 'opencode'), 'known-root');
    return out;
  }

  if (engine === 'codebuddy') {
    /* WorkBuddy（腾讯）内置 CodeBuddy CLI：入口在客户端 asar 解包里，无扩展名的 node 脚本：
     *   <安装根>/resources/app.asar.unpacked/cli/bin/codebuddy      ← 官方入口（推荐）
     *   <安装根>/resources/app.asar.unpacked/cli/bin/codebuddy-lowmem  ← 低内存 wrapper
     * 另认 npm 全局安装形态（官方也支持独立分发 CLI）。
     * ⚠️ 目录名大小写两种都真实存在过（`Programs\WorkBuddy` 与 junction 的 `Programs\workbuddy`），都要试。 */
    const relBin = join('resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy');
    const roots = [
      ...knownRoots,
      env.CODEBUDDY_HOME, env.WORKBUDDY_HOME, env.WORKBUDDY_INSTALL_DIR,
      localAppData && join(localAppData, 'Programs', 'WorkBuddy'),
      localAppData && join(localAppData, 'Programs', 'workbuddy'),
      localAppData && join(localAppData, 'WorkBuddy'),
      programFiles && join(programFiles, 'WorkBuddy'),
      programFiles && join(programFiles, 'workbuddy'),
      programFilesX86 && join(programFilesX86, 'WorkBuddy'),
      programFilesX86 && join(programFilesX86, 'workbuddy'),
      programData && join(programData, 'WorkBuddy'),
      ...driveRoots(fs).map((d) => join(d, 'Program Files', 'WorkBuddy')),
      ...driveRoots(fs).map((d) => join(d, 'Program Files', 'workbuddy')),
      ...driveRoots(fs).map((d) => join(d, 'Program Files (x86)', 'WorkBuddy')),
    ].filter((x) => typeof x === 'string' && x.length > 0);
    for (const r of roots) push(join(r, relBin), 'client-bundled-cli');
    /* npm 全局分发形态（Windows shim + 无扩展名 POSIX 入口）。 */
    push(appData && join(appData, 'npm', 'codebuddy.cmd'), 'npm-shim');
    push(appData && join(appData, 'npm', 'cbc.cmd'), 'npm-shim');
    push(join(HOME, '.local', 'bin', 'codebuddy'), 'install-script');
    return out;
  }

  /* Qoder：CN 与全球版两套（可共存，分别上报 variant）。 */
  // CN：用户级 CLI 稳定入口（安装器版本化放置 + 稳定入口 qoderclicn.exe）
  push(join(HOME, '.qoder-cn', 'bin', 'qoderclicn', 'qoderclicn.exe'), 'cn-cli');
  push(join(HOME, '.qoder-cn', 'bin', 'qoderclicn', 'qoderclicn'), 'cn-cli');
  // CN：统一入口（dispatcher 会分派 CLI/IDE；本机实测可用）
  push(join(HOME, '.qoder-cn', 'entry', 'qoder-cn.cmd'), 'cn-entry');
  push(join(HOME, '.qoder-cn', 'entry', 'qodercn.cmd'), 'cn-entry');
  // 全球版
  push(join(HOME, '.qoder', 'bin', 'qoder', 'qoder.exe'), 'global-cli');
  push(join(HOME, '.qoder', 'bin', 'qoder'), 'global-cli');
  push(localAppData && join(localAppData, 'Programs', 'Qoder', 'qoder.exe'), 'global-client');
  for (const r of knownRoots) push(join(r, 'qoder'), 'known-root');
  return out;
}

/** PATH 查找：PATHEXT 感知；同名多命中**只取第一个**（官方 dispatcher 的教训）。
 *
 * ⚠️ 真机踩到的坑：Windows 的 npm 全局目录里同时有 `opencode`（**无扩展名的 shell 脚本**）、
 * `opencode.cmd`、`opencode.ps1`。按字母序/目录序先命中那个**无扩展名**的，Node 无法直接 spawn
 * ⇒ `--version` 取不到。故：**带可执行扩展名的优先**，无扩展名的永远排最后。 */
function findOnPath(names, { fs, env }) {
  const dirs = String(env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = IS_WIN
    ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.PS1').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : [''];
  /* Windows 上按"可直接 spawn 的优先级"排序：.exe 最稳，其次 .cmd/.bat，最后才是无扩展名/.ps1 */
  const priority = ['exe', 'cmd', 'bat', 'com', 'ps1'];
  const extOrder = IS_WIN
    ? [...priority.filter((e) => exts.includes(`.${e}`)).map((e) => `.${e}`), '']
    : [''];
  const tried = [];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of extOrder) {
        const cand = join(dir, name + ext);
        tried.push(cand);
        if (safeIsFile(fs, cand)) return { entry: cand, tried };
      }
    }
  }
  return { entry: null, tried };
}

/* ------------------------------------------------------------------ *
 * 登录态（**只做存在性判断，绝不解析内容**）
 * ------------------------------------------------------------------ */

function loginHint(engine, entry, opts) {
  const { fs, env, runProbe } = opts;
  if (engine === 'zcode') {
    // ZCode：凭据文件存在且非空（只判 size）
    const p = env.ZCODE_CREDENTIALS_FILE || join(HOME, '.zcode', 'v2', 'credentials.json');
    const ok = safeIsFile(fs, p) && safeSize(fs, p) > 0;
    return { loggedIn: ok, evidence: ok ? `凭据文件存在（${p}）` : `未发现凭据文件（${p}）` };
  }
  if (engine === 'opencode') {
    /* ⚠️ 真机实测：`~/.local/share/opencode/` 里只有 `opencode.db`（+ log/repos/snapshot/tool-output），
     * **没有 `auth.json`** —— 而 CLI 用得好好的（免费模型无需凭据，库文件里另有历史）。
     * 故这里**不能**用"auth.json 不存在"断言未登录（那是假信息，会误导用户去白折腾登录）。
     * 有 auth.json 才敢说"已登录"；没有 ⇒ **登录态未知**。 */
    const p = join(HOME, '.local', 'share', 'opencode', 'auth.json');
    if (safeIsFile(fs, p) && safeSize(fs, p) > 0) return { loggedIn: true, evidence: `凭据文件存在（${p}）` };
    const dataDir = join(HOME, '.local', 'share', 'opencode');
    if (safeIsDir(fs, dataDir)) {
      return { loggedIn: null, evidence: `数据目录存在（${dataDir}）但无 auth.json —— 登录态未知（免费模型无需凭据）` };
    }
    return { loggedIn: null, evidence: `未发现数据目录（${dataDir}）` };
  }
  /* CodeBuddy / WorkBuddy：**CLI 登录态与桌面应用互相独立**（真机 2026-10-21 实测）。
   *
   * ⚠️ 2026-10-21 真机纠正（重要）：本分支最初用 `~/.codebuddy-session.json` 作判据 ——
   * 那是**错的**：该路径属于社区反代项目（workbuddy2api），**不是官方 CLI 的**。
   * 官方 CLI 的真机落点是 `~/.codebuddy/`（`--serve` 会直接打印
   * `Config C:\Users\<u>\.codebuddy\settings.json`），里面有 settings / user-state /
   * local_storage / sessions / logs，但**没有任何可明确指认的凭据文件**
   * （local_storage 里只有若干 `.info` 状态桶）。
   *
   * 故这里**不猜**：只认显式覆盖（`CODEBUDDY_SESSION_FILE`），其余一律保守判"未登录"，
   * 并把"怎么登录"直接写进 evidence —— 用户此刻最需要的是这个指引，而不是一个我猜的状态。
   * 判据本身的局限已如实写进 evidence，别把 false 当成"权威结论"。 */
  if (engine === 'codebuddy') {
    const override = String(env.CODEBUDDY_SESSION_FILE ?? '').trim();
    if (override) {
      const p = resolve(override);
      const ok = safeIsFile(fs, p) && safeSize(fs, p) > 0;
      return { loggedIn: ok, evidence: ok ? `CODEBUDDY_SESSION_FILE 存在（${p}）` : `CODEBUDDY_SESSION_FILE 指向的文件不存在或为空（${p}）` };
    }
    const dir = join(HOME, '.codebuddy');
    if (!safeIsDir(fs, dir)) {
      return { loggedIn: false, evidence: `未发现 CLI 目录（${dir}）—— CLI 从未运行过，必然未登录` };
    }
    return {
      loggedIn: false,
      evidence: `CLI 目录存在（${dir}）但**没有可明确判定的凭据文件**（此判据偏保守，以实际派发结果为准；`
        + '未登录时无头执行会报 Authentication required，派发台会归为「CLI 未登录」暂停态）',
    };
  }
  /* Qoder：**不能用 `.auth/` 目录判登录** —— 实测 IDE 登录着、CLI 仍报 Not logged in，
   * 且 `~/.qoder-cn/.auth/` 里只有 machine_id（不是凭据）。
   * 唯一可靠判据：`--list-models` 能否成功（未登录时 exit=1 且 stderr 含 "Not logged in"）。 */
  if (!entry) return { loggedIn: null, evidence: '没有可执行的 CLI，无法判定' };
  const r = runProbe(entry, ['--list-models'], { timeoutMs: opts.timeoutMs });
  const out = `${r.stdout}\n${r.stderr}`;
  if (/not logged in/i.test(out)) return { loggedIn: false, evidence: 'CLI 报 Not logged in（需先登录）' };
  if (r.code === 0) return { loggedIn: true, evidence: '--list-models 成功' };
  return { loggedIn: null, evidence: `--list-models 未成功（exit=${r.code}），无法判定登录态` };
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 发现单个引擎。
 * @param {'zcode'|'opencode'|'qoder'} engine
 * @param {object} [opts]
 * @returns {Promise<object>} DiscoveryResult（形状见 tasks/T1-engine-discover-task.md）
 */
export async function discoverEngine(engine, opts = {}) {
  if (!ENGINES.includes(engine)) throw new TypeError(`discoverEngine: 未知引擎 ${engine}`);
  const fs = opts.fsProbe ?? REAL_FS;
  const env = opts.env ?? process.env;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10000;
  const runProbe = opts.runProbe ?? runProbeReal;
  const knownRoots = opts.knownRoots ?? [];

  const candidatesTried = [];
  const warnings = [];
  const base = {
    engine, found: false, form: null, entry: null, entryKind: null,
    version: null, loggedIn: null, variant: engine === 'qoder' ? null : null,
    candidatesTried, reason: '', warnings,
  };
  const ctx = { fs, env, timeoutMs, runProbe };

  /** 试一个候选路径：存在且是文件 ⇒ 认定命中。 */
  const tryCandidate = (p, level, note) => {
    const ok = safeIsFile(fs, p);
    candidatesTried.push({ level, value: p, ok, ...(note ? { note } : {}) });
    return ok ? p : null;
  };

  /* ── L1：env 覆盖 ── */
  const envNames = engine === 'zcode'
    ? ['ZCODE_CLI']
    : engine === 'opencode'
      ? ['OPENCODE_CLI', 'OPENCODE_BIN']
      : engine === 'codebuddy'
        ? ['CODEBUDDY_CLI', 'CODEBUDDY_CLI_BIN', 'WORKBUDDY_CLI']
        : ['QODERCN_CLI_BIN', 'QODER_CLI_BIN'];
  for (const n of envNames) {
    const v = env[n];
    if (!v) continue;
    const hit = tryCandidate(v, 'env', n);
    if (hit) {
      const kind = classifyEntry(hit);
      const variant = /CN|QODERCN/i.test(n) ? 'cn' : (engine === 'qoder' ? 'global' : null);
      return finalize({ ...base, found: true, form: guessForm(engine, hit), entry: hit, entryKind: kind, variant },
        `${n} 显式指定`, ctx);
    }
  }

  /* ── L2：插件 config 显式路径 ── */
  if (opts.configPath) {
    const hit = tryCandidate(opts.configPath, 'config');
    if (hit) {
      return finalize({ ...base, found: true, form: guessForm(engine, hit), entry: hit, entryKind: classifyEntry(hit) },
        '插件配置指定', ctx);
    }
  }

  /* ── L3：PATH（PATHEXT 感知，多命中取第一个） ── */
  const pathNames = engine === 'zcode'
    ? ['zcode']
    : engine === 'opencode'
      ? ['opencode']
      : engine === 'codebuddy'
        ? ['codebuddy', 'cbc']
        : ['qoderclicn', 'qoder-cn', 'qodercn', 'qoder'];
  const onPath = findOnPath(pathNames, { fs, env });
  /* ⚠️ 不逐条记 PATH 候选：目录数 × 扩展名会产出几百条噪声，反而让"查过哪里"不可读。
   * 只记一条汇总（命中则附带真实路径）。 */
  candidatesTried.push({
    level: 'path',
    value: pathNames.map((n) => `${n}{${IS_WIN ? '.exe/.cmd/.ps1' : ''}}`).join(' | '),
    ok: !!onPath.entry,
    note: onPath.entry ? `命中 ${onPath.entry}` : `未命中（扫了 ${new Set(onPath.tried.map((t) => t.slice(0, t.lastIndexOf('\\')))).size} 个 PATH 目录）`,
  });
  if (onPath.entry) {
    const variant = engine === 'qoder'
      ? (/(qoderclicn|qoder-cn|qodercn)/.test(basename(onPath.entry).toLowerCase()) ? 'cn' : 'global')
      : null;
    return finalize({ ...base, found: true, form: 'cli', entry: onPath.entry, entryKind: classifyEntry(onPath.entry), variant },
      'PATH 命中', ctx);
  }

  /* ── L4：已知安装位置（含客户端自带 CLI、跨盘符） ── */
  for (const c of candidatesFor(engine, { fs, env, knownRoots })) {
    const hit = tryCandidate(c.path, 'known', c.kind);
    if (hit) {
      const variant = engine === 'qoder' ? (/qoder-cn|qoderclicn/.test(hit) ? 'cn' : 'global') : null;
      return finalize({ ...base, found: true, form: guessForm(engine, hit), entry: hit, entryKind: classifyEntry(hit), variant },
        `已知安装位置命中（${c.kind}）`, ctx);
    }
  }

  /* ── L5：全失败 ── */
  const hint = engine === 'zcode'
    ? '可设 ZCODE_HOME 指向 ZCode 安装根，或 ZCODE_CLI 指向 <安装根>\\resources\\glm\\zcode.cjs'
    : engine === 'opencode'
      ? '可设 OPENCODE_CLI 指向 opencode 可执行文件'
      : engine === 'codebuddy'
        ? '可设 CODEBUDDY_HOME 指向 WorkBuddy 安装根，或 CODEBUDDY_CLI 指向 '
          + '<安装根>\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy'
        : '可设 QODERCN_CLI_BIN（CN）指向 qoderclicn.exe';
  return {
    ...base,
    reason: `未找到 ${engine} 的可执行文件（已查 ${candidatesTried.length} 处：env/PATH/已知安装位置）。${hint}`,
    warnings: [`未检测到 ${engine}`],
  };
}

/** 从路径猜形态（用于面板徽标；不确定就 'cli'）。 */
function guessForm(engine, entry) {
  const p = String(entry).toLowerCase();
  if (engine === 'zcode') return /resources[\\/]glm[\\/]/.test(p) ? 'client-bundled-cli' : 'cli';
  if (engine === 'opencode') return /opencode-ai/.test(p) ? 'cli' : 'client';
  if (engine === 'qoder') {
    if (/entry[\\/]/.test(p)) return 'ide-entry';
    if (/qoderclicn/.test(p)) return 'cli';
    return 'ide-bundled';
  }
  if (engine === 'codebuddy') {
    /* 客户端自带 CLI（asar 解包） vs npm 全局 shim vs POSIX 安装脚本。 */
    if (/app\.asar\.unpacked/.test(p)) return 'client-bundled-cli';
    if (/\.cmd$/.test(p)) return 'npm-shim';
    return 'cli';
  }
  return 'cli';
}

/** 补版本与登录态，然后返回（探测失败不影响 found）。 */
async function finalize(res, reason, { fs, env, timeoutMs, runProbe }) {
  res.reason = reason;
  /* ⚠️ CodeBuddy 的探测**必须带启动环境**：入口是无扩展名的 node 脚本，且默认 require 的
   * `dist/codebuddy` 在 WorkBuddy 的解包里不存在 —— 不设 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`
   * 会直接 MODULE_NOT_FOUND（`--version` 也就拿不到）。其它引擎不需要，传 undefined 走默认 env。 */
  const probeEnv = res.engine === 'codebuddy'
    ? { ...env, CODEBUDDY_FORCE_LITE_WB_BUNDLE: env.CODEBUDDY_FORCE_LITE_WB_BUNDLE || '1' }
    : undefined;
  // 版本
  try {
    const isScript = res.entryKind === 'cjs' || res.entryKind === 'js';
    const cmd = isScript ? process.execPath : res.entry;
    const args = isScript ? [res.entry, '--version'] : ['--version'];
    const r = runProbe(cmd, args, { timeoutMs, cwd: undefined, env: probeEnv });
    const v = parseVersion(`${r.stdout}\n${r.stderr}`);
    if (v) res.version = v;
    else res.warnings.push('--version 未返回可识别版本号');
  } catch (e) {
    res.warnings.push(`--version 探测失败：${e?.message ?? e}`);
  }
  // 登录态（只读/只判存在性）
  try {
    const { loggedIn, evidence } = loginHint(res.engine, res.entry, { fs, env, timeoutMs, runProbe });
    res.loggedIn = loggedIn;
    res.loginEvidence = evidence;
    if (loggedIn === false) {
      res.warnings.push(res.engine === 'qoder'
        ? 'Qoder CLI 存在但**未登录**：运行 `qoderclicn login`（浏览器设备码）或设 QODER_PERSONAL_ACCESS_TOKEN'
        : res.engine === 'codebuddy'
          ? 'CodeBuddy CLI 存在但（按保守判据）**未登录** —— CLI 登录态与 WorkBuddy 桌面应用互相独立。'
            + '登录方式（都不需要手改文件；`/login` 是 **CLI 界面里的斜杠命令**，不是 shell 命令）：'
            + `① 最稳（不依赖 TUI）：node "${res.entry}" --serve —— 它会打印带 password 的 Web UI 链接，`
            + '浏览器打开登录，完成后 Ctrl+C 停服务；'
            + '② 真终端里交互启动 CLI（node "<上面的路径>"），进入界面后输入 /login。'
          : `${res.engine} 未登录`);
    }
  } catch (e) {
    res.loggedIn = null;
    res.warnings.push(`登录态探测失败：${e?.message ?? e}`);
  }
  // Qoder CN/全球共存提示
  if (res.engine === 'qoder') {
    const cn = safeIsFile(fs, join(HOME, '.qoder-cn', 'bin', 'qoderclicn', 'qoderclicn.exe'))
      || safeExists(fs, join(HOME, '.qoder-cn', 'entry'));
    const gl = safeExists(fs, join(HOME, '.qoder'));
    if (cn && gl) res.warnings.push('检测到 Qoder CN 与全球版同时存在，已优先采用 CN（两者账号/额度体系不同）');
  }
  return res;
}

/** 一次发现全部引擎（互不影响：一个失败不拖累其它）。 */
export async function discoverAll(opts = {}) {
  const out = {};
  for (const e of ENGINES) {
    try {
      out[e] = await discoverEngine(e, opts);
    } catch (e2) {
      out[e] = {
        engine: e, found: false, form: null, entry: null, entryKind: null,
        version: null, loggedIn: null, variant: null, candidatesTried: [],
        reason: `发现过程异常：${e2?.message ?? e2}`, warnings: [String(e2?.message ?? e2)],
      };
    }
  }
  return out;
}

/** 给面板/日志的一行可读说明。 */
export function describeDiscovery(r) {
  if (!r) return '(无发现结果)';
  if (!r.found) return `${r.engine}: 未找到（${r.reason}）`;
  const bits = [`${r.engine}: ${r.form ?? 'cli'}`];
  if (r.variant) bits.push(r.variant);
  if (r.version) bits.push(`v${r.version}`);
  bits.push(r.loggedIn === true ? '已登录' : r.loggedIn === false ? '未登录' : '登录态未知');
  bits.push(r.entry);
  return bits.join(' · ');
}

export default { ENGINES, discoverEngine, discoverAll, describeDiscovery, parseVersion, classifyEntry };
