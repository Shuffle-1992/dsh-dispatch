/**
 * Windows `.cmd` / `.bat` 包装器的安全启动 —— **四个执行器共用一份**（ZB-123）。
 *
 * 背景：`spawn(cmd, argv, {shell:true})` **完全不转义**，提示词里的 `& | < >` 会被当成
 * 命令分隔符执行。ZCode 走 `.mjs`、Qoder 走 `.exe`，但 **opencode / codebuddy 的 CLI 是
 * npm 的 `.cmd` shim** ⇒ 这条路必须安全。
 *
 * 策略（按优先级）：
 *   ① **解析 shim，直连真实 exe/node** —— 提示词完全不经过 shell
 *      （实测 `opencode.cmd` 内是 `"%dp0%\node_modules\opencode-ai\bin\opencode.exe" %*`）。
 *      多行 prompt、`%VAR%`、`&|<>` 全部安全。
 *   ② 解析不了 ⇒ 回落"手动拼命令行 + 引号包裹"；但含 `"` / `%` / `!` 的参数**一律报错**
 *      （fail-closed）—— cmd 命令行对这三类字符**没有可靠的转义手段**：
 *      `\"` 在 cmd 里不作转义（会提前闭合引号 ⇒ 注入），`%%`/`^!` 只在批处理文件里还原
 *      （命令行级会把参数**原地损坏**）。宁可拒绝派发也不能被注入或损坏。
 *
 * 设计约束（取舍说明）：第 ① 步只接受**能确定唯一目标**的 shim 形态；多分支 / 含未加引号
 * 的额外 token / 目标不存在 ⇒ 一律返回 null 走第 ② 步，**绝不猜**（猜错会静默启动错误程序）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, extname, sep } from 'node:path';

/** 参数转义（仅回落路径用）。含 `"` / `%` / `!` ⇒ 抛错（fail-closed）。 */
export function quoteWinArg(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (/["%!]/.test(s)) {
    throw new Error(
      '无法安全地把该参数交给 cmd.exe（含双引号/百分号/感叹号，cmd 命令行无可靠转义）——'
      + '已拒绝派发以避免命令注入或参数损坏。该执行器的 shim 未能解析成真实 exe/node，'
      + '请检查 CLI 安装形态（npm 全局 shim）或改用可执行文件路径',
    );
  }
  if (!/[\s&|<>^()]/.test(s)) return s;
  return `"${s}"`;
}

/** 把 shim 里的 `%~dp0` / `%dp0%` 换成 shim 所在目录。
 *  `%~dp0` **自带末尾反斜杠**（cmd 语义），`%dp0%` 没有 ⇒ 必须分开替换，
 *  否则 `"%~dp0app.js"` 会拼成 `...\dirnameapp.js`（缺分隔符）。 */
function expandDp0(token, dir) {
  return token.replace(/%~dp0/gi, dir + sep).replace(/%dp0%/gi, dir);
}

/**
 * 解析 `.cmd/.bat` shim，找到真实要启动的程序。
 * @returns {{cmd:string, argv:string[], shell:false}|null} null = 无法安全确定目标
 */
export function resolveShimTarget(shimPath) {
  try {
    const dir = dirname(shimPath);
    const lines = readFileSync(shimPath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      /* 含 `%*` 的行才是执行行；排除注释行 —— **`@rem` 是 npm shim 的常见写法**，
       * 只排 `rem`/`::` 会让注释里的 `%*` 被当成执行行。 */
      .filter((l) => l.includes('%*') && !/^@?(rem\b|::)/i.test(l));
    /* 必须**唯一**：多分支 shim（`if ... A %* else ... B %*`）无法判断当前走哪条，
     * 挑最后一条就可能启动错误目标 ⇒ 放弃解析。 */
    if (lines.length !== 1) return null;

    const body = lines[0].replace(/%\*/g, '').trim();
    const tokens = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      if (m[1] != null) tokens.push({ quoted: true, raw: m[1] });
      else tokens.push({ quoted: false, raw: m[2] });
    }
    /* 至少要有 1 个 token（命令头）。**不能要求 2 个**：标准 npm shim 就只启动一个
     * 可执行文件（`"%dp0%\node_modules\…\opencode.exe" %*`），命令后没有脚本参数。 */
    if (tokens.length < 1) return null;
    /* 除命令头（第 0 个）外，其余 token 必须是引号包起来的脚本/参数；
     * 出现未加引号的额外 token（固定旗标、重定向、`call` 等）⇒ 结构不可靠，放弃。 */
    if (tokens.slice(1).some((t) => !t.quoted)) return null;

    const head = expandDp0(tokens[0].raw, dir);
    const rest = tokens.slice(1).map((t) => expandDp0(t.raw, dir));
    /* 裸 `node` / `node.exe` ⇒ 用当前 Node（shim 里常见的写法）。 */
    const cmd = /^node(\.exe)?$/i.test(head) ? process.execPath : head;
    /* 目标必须真实存在 —— 解析出一个不存在的路径会让 spawn 直接失败，
     * 比"走回落路径"更糟（回落至少可能还能启动）。 */
    if (!existsSync(cmd)) return null;
    if (/\.exe$/i.test(cmd) || /(?:^|[\\/])node(\.exe)?$/i.test(cmd)) {
      return { cmd, argv: rest, shell: false };
    }
    return null;
  } catch {
    return null;
  }
}

/** 无扩展名文件 + `#!…node` ⇒ 当 Node 脚本处理（Windows 无法直接 spawn 这种文件）。 */
function looksLikeNodeScript(file) {
  try {
    return /^#!.*\bnode\b/.test(readFileSync(file, 'utf8').slice(0, 200));
  } catch {
    return false;
  }
}

/**
 * 计算"怎么 spawn 这个 CLI"。
 * @param {string} cli  执行器路径（`.mjs` 脚本 / `.exe` / `.cmd` / 无扩展名 node 脚本）
 * @param {string[]} args
 * @returns {{cmd:string, argv:string[], shell:boolean, verbatim?:boolean}}
 */
export function spawnTarget(cli, args) {
  const base = basename(String(cli));
  const ext = extname(base).toLowerCase();
  /* ① JS 脚本 ⇒ 直接 node 跑（不经 shell）。 */
  if (/\.(cjs|mjs|js)$/i.test(base)) {
    return { cmd: process.execPath, argv: [cli, ...args], shell: false };
  }
  /* ② **无扩展名 + node shebang** ⇒ 也按 node 脚本跑。
   *  （原 codebuddy-run 有这条判据，抽共享时差点丢掉 —— 测试当场抓住了。） */
  if (ext === '' && existsSync(cli) && looksLikeNodeScript(cli)) {
    return { cmd: process.execPath, argv: [cli, ...args], shell: false };
  }
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(base)) {
    return { cmd: cli, argv: args, shell: false };
  }
  /* ② Windows 的 `.cmd/.bat`：优先解析 shim 直连真实程序。 */
  const resolved = resolveShimTarget(cli);
  if (resolved) return { ...resolved, argv: [...resolved.argv, ...args] };
  /* ③ 回落：手动拼命令行（参数逐个转义；不安全的字符会在这里抛错）。 */
  const line = `"${cli}" ${args.map(quoteWinArg).join(' ')}`;
  return {
    cmd: process.env.ComSpec || 'cmd.exe',
    argv: ['/d', '/s', '/c', `"${line}"`],
    shell: false,
    verbatim: true,
  };
}

/** 把 `spawnTarget()` 的返回值转成 spawn/spawnSync 的选项片段（统一两处调用方）。 */
export function spawnOptions(t) {
  return {
    shell: t.shell === true,
    windowsVerbatimArguments: t.verbatim === true,
  };
}
