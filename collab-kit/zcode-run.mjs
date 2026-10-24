/**
 * ZCode 无头派发器（DSH → ZCode 子代理通道；协议见 collab/PROTOCOL.md §5 通道 T7）。
 *
 * 用途：把一条自足任务包交给 ZCode Agent CLI 无头执行，产物与证据落盘，退出码透传，
 *      供 DSH（或任何调度方）在后台作业里等待并在完成后独立验收。
 *
 * 默认走 **ZCode 套餐额度**（provider=plan，取账号里已启用的 Coding Plan 端点+密钥），
 * 而不是个人自建 API Key；需要个人 Key 时显式 `--provider personal`。
 *
 * 用法：
 *   node "<dispatch>/collab-kit/zcode-run.mjs" --project <项目根> --task collab/tasks/R35-01-task.md --tag R35-01 --mode yolo
 *   node "<dispatch>/collab-kit/zcode-run.mjs" --project <项目根> --prompt "只回答 OK" --tag smoke
 *   node "<dispatch>/collab-kit/zcode-run.mjs" --project <项目根> --target "<可校验目标>" --tag R35-02 --mode edit
 *   node "<dispatch>/collab-kit/zcode-run.mjs" --project <项目根> --resume sess_xxx --prompt "继续下一批" --tag R35-03
 *   node "<dispatch>/collab-kit/zcode-run.mjs" --project <项目根> --list-providers                      # 看套餐/供应商可用性
 *   node "<dispatch>/collab-kit/zcode-run.mjs" --project <项目根> --prompt ... --model GLM-5.3-Flash    # 套餐内指定模型
 *   node "<dispatch>/collab-kit/zcode-run.mjs" --project <项目根> --prompt ... --provider personal --model deepseek-v4-pro
 *   node "<dispatch>/collab-kit/zcode-run.mjs" --project <项目根> --prompt "只回复 OK" --provider start-plan   # 免费额度（Start Plan）
 *
 * 参数：
 *   --task <file>        任务包文件（内容内联进 prompt，避免 CLI 找不到路径）
 *   --prompt <text>      直接给指令（与 --task 二选一；同时给出时 --task 优先）
 *   --target <text>      目标模式（ZCode 自续跑直到目标达成；与 --prompt/--task 互斥，CLI 限制）
 *   --resume <sess_id>   续接既有会话（保留上下文）
 *   --mode <mode>        build | edit | plan | yolo（默认 edit；无人值守建议显式指定）
 *   --cwd <path>         工作目录（默认项目根）
 *   --project <dir>      项目根（含 collab/ 的目录；默认 env ZCODE_PROJECT_DIR，再默认 cwd）
 *   --provider <p>       plan（默认，走**付费**套餐额度）| personal（个人 API Key）|
 *                        start-plan / gift（**免费额度 Start Plan**，托管官方 agent 走 app-server）|
 *                        <v2/config.json 里的 provider 键>
 *   --transport <t>      执行后端：auto（默认）| print | appserver。
 *                        auto 判据：--provider start-plan|gift → appserver，其余 → print。
 *                        appserver 见 collab-kit/appserver-gift.mjs（账户注入 + 鉴权递送 + 回合驱动）。
 *   --model <id>         指定模型（套餐默认 GLM-5.3；personal 模式默认个人配置里的模型；
 *                        start-plan 默认 GLM-5.3-Flash）
 *   --personal-config <path>  指定个人 provider 配置（仅 --provider personal 时生效）
 *   --list-providers     列出账号内 provider/套餐可用性与模型，然后退出
 *   --attach <file>      附加文件（可重复）
 *   --tag <name>         日志/结果文件标签（默认时间戳）
 *   --timeout-min <n>    超时分钟（默认 45）
 *   --reasoning-level <v>  思考强度（ZCode Thought Level；写入临时 provider 配置的
 *                        defaultModelSelection.options.reasoningLevel，仅对**新建会话**生效，
 *                        --resume 沿用原会话档位。合法取值随模型声明不同：GLM-5 系为
 *                        disabled|enabled，deepseek-flash 为 disabled|low|high|max；
 *                        `--list-providers` 会输出每个模型 reasoningLevels=。非法档位由
 *                        ZCode 会话创建 fail-fast（不静默降级）。
 *   --no-ledger          不写 <project>/collab/logs/dispatch-runs.jsonl 用量台账
 *   --memory-bench       配合 --prompt：开启自动 Memory 提取并等待完成后再退出（需 Memory 已开启）
 *   --memory-ban         在组装出的 prompt 末尾追加「不写 ZCode 记忆库」禁令（ZB-28，派发台默认带）：
 *                        对 --task/--prompt 生效；--target 不经 prompt（CLI 直接吃目标文本），
 *                        目标模式的禁令由派发台拼在目标文本内
 *   --no-cred-fallback   关闭凭据回退（默认开启：config.json 的 Key 验活失败时回退加密凭据库）
 *
 * 产物：
 *   <project>/collab/logs/zcode-run-{tag}-{ts}.out.log      stdout（含 CLI 的 JSON 结果）
 *   <project>/collab/logs/zcode-run-{tag}-{ts}.err.log      stderr（诊断）
 *   <project>/collab/logs/zcode-run-{tag}-{ts}.result.json  解析后的 JSON 结果（sessionId/response/usage/projection）
 *   <project>/collab/logs/dispatch-runs.jsonl                  每次 run 一行台账（套餐/模型/用量/上下文/耗时/退出码）
 *
 * 退出码：CLI 退出码；超时 124；参数/环境错误 1。
 * 凭证：套餐与个人 Key 都只从 ~/.zcode 读取 → 写入系统临时配置副本 → 跑完即删；
 *      脚本不打印密钥、不进日志、不入库（仓库内无任何密钥副本）。
 *
 * 凭据双保险（2026-10-01 真机事故修复，与 dsh-connect-zcode 同源）：
 *   ZCode 在 OAuth 重新登录后，把新 Key **只写进加密凭据库** `~/.zcode/v2/credentials.json`，
 *   **不回写 config.json** ⇒ config.json 里留着失效旧 Key ⇒ 派发必 401（连 CLI 自己也挂）。
 *   故：先用 config.json 的 Key **验活**；失败则从凭据库解出候选**逐把验活**，取第一把通过的。
 *   ⚠️ 验活必须校验**响应体**：网关对失效 Key 也返回 HTTP 200（body `{"code":1000,...}`）。
 *   ⚠️ 实现用 `node:https` 而非 `fetch`：实测本 runner 场景下 `fetch`（undici）后
 *      `process.exit()` 会在 Windows 触发 libuv 断言崩溃（退出码 -1073740791）。
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir, platform, userInfo } from 'node:os';
import { createDecipheriv, createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

/**
 * 项目根（`<root>/collab/` 所在的目录）——本工具**不再假定自己是某个项目的子目录**。
 *
 * 解析顺序（前四项与 inject-inbox.js 的既有约定一致）：
 *   1. `--project <dir>`（显式，最高优先）
 *   2. env `ZCODE_PROJECT_DIR`
 *   3. **从绝对路径的 `--task` 反推**：向上找最近的含 `collab/` 的祖先目录
 *      —— 这条是为「派发台」准备的：它按契约传**绝对** `--task` 但**不传** `--project`，
 *      且其子进程 cwd 未必是宿主项目（见 dispatch/dispatch dispatch-core.mjs）。
 *   4. 当前工作目录（通用工具的合理默认：你在哪个项目里跑，就用哪个项目）
 *
 * 为什么不再是 `<脚本>/../..`：本脚本已迁至 `dispatch/collab-kit/`（DSH 工具仓库），
 * 与宿主项目（如 keysion dac vue）不再有目录关系；写死推导会指向错误位置。
 */
function inferProjectFromTask(taskArg) {
  if (typeof taskArg !== 'string' || taskArg.trim() === '') return undefined;
  const abs = isAbsolute(taskArg) ? resolve(taskArg) : resolve(process.cwd(), taskArg);
  let dir = dirname(abs);
  // 向上最多 8 层找含 collab/ 的目录（正常 <root>/collab/tasks/x.md 只需 1~2 层）
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'collab'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function resolveProjectRoot(cliValue) {
  if (typeof cliValue === 'string' && cliValue.trim() !== '') return resolve(cliValue.trim());
  const fromEnv = process.env.ZCODE_PROJECT_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim());
  const fromTask = inferProjectFromTask(readArgValue('--task'));
  if (fromTask !== undefined) return fromTask;
  return resolve(process.cwd());
}
const PROJECT = resolveProjectRoot(readProjectArg());
const LOGS = process.env.ZCODE_LOG_DIR ? resolve(process.env.ZCODE_LOG_DIR) : join(PROJECT, 'collab', 'logs');
const HOME_ZCODE = join(homedir(), '.zcode');
const APP_CONFIG = join(HOME_ZCODE, 'v2', 'config.json');
const CRED_STORE = join(HOME_ZCODE, 'v2', 'credentials.json');

/** 先扫一遍 argv 取某个 `--flag <value>`（早于正式参数解析，因为路径常量要先算出来）。 */
function readArgValue(flag) {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] ? a[i + 1] : undefined;
}
function readProjectArg() {
  return readArgValue('--project');
}

/* 【ZB-33 位置调整】原先它在临时配置生成之后（≈795 行），意味着"总开关关闭"时仍会去
 * 读 config.json/凭据库做 provider 解析；现在提到最前，作为**第一道闸**（语义不变，更早、更省）。
 * 【ZB-42 二次调整（用户现场报告）】闸门**下移到 `--list-providers` 分支之后**（见下方 GATE）。
 * 原因：ZB-33 提到最前时，把**只读**探测也一并挡住了 —— 总开关一关，面板连通道列表都显示不出来，
 * 还报「通道清单加载失败」，用户以为插件坏了（实测复现）。闸门仍早于**凭据读取与进程启动**，
 * 故 ZB-33 的收益（冻结时不碰凭据/不起进程）完整保留。 */
const SWITCH_FILE =
  process.env.ZCODE_SWITCH_FILE && process.env.ZCODE_SWITCH_FILE.trim() !== ''
    ? resolve(process.env.ZCODE_SWITCH_FILE.trim())
    : join(PROJECT, 'collab', 'dispatch.switch.json');
function readDispatchSwitch() {
  try {
    if (!existsSync(SWITCH_FILE)) return { enabled: true, source: 'default(无文件=开启)' };
    /* 【ZB-42】剥掉 UTF-8 BOM 再解析：PowerShell 5 的 `Set-Content -Encoding UTF8`、Windows 记事本
     * 另存为 UTF-8 都会写入 BOM（EF BB BF），而 `JSON.parse` 遇 BOM **必抛** ⇒ 命中下面的 catch
     * ⇒ **fail-open（开关静默失效）**。对「冻结闸门」这种安全开关，静默失效比报错更危险
     * （实测复现：带 BOM 的 enabled:false 仍被放行）。BOM 与"文件损坏"无关，剥掉即可。 */
    const text = readFileSync(SWITCH_FILE, 'utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text);
    return { enabled: raw.enabled !== false, updatedAt: raw.updatedAt, updatedBy: raw.updatedBy, note: raw.note };
  } catch (e) {
    return { enabled: true, source: `default(读取失败: ${e.message})` };
  }
}
/* 闸门**不在**这里 —— 已下移到 `--list-providers` 分支之后（ZB-42，见文件中部 GATE 注释）。
 * 只读探测必须能过闸，否则冻结期间面板看不到任何通道。 */

/* ---------- CLI 与环境（本机实测：两个 provider 配置必须同时给出） ----------
 * 【ZB-51 修复：去掉硬编码安装路径】
 * 原先这里是 `'F:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs'` —— 那是**开发机的盘符**，
 * 别人装在 C: 盘、或装了别的版本，就会直接找不到 CLI（"插件装了但用不了"的典型成因）。
 * 现在改为**按安装根发现**：CLI 与 builtin provider 配置是同一个安装根下的兄弟节点
 * （`<root>/resources/glm/zcode.cjs` 与 `<root>/resources/config/provider/zcode-builtin.json`），
 * 所以只要找到安装根，两个都能推出来。
 *
 * 发现顺序（与 ZB-51 的五级一致，但**本文件自带**一份极简实现：
 * 执行器是"每次 spawn 的独立叶子进程"，不 import core/wire 的任何模块，避免耦合）：
 *   ① env ZCODE_CLI（显式覆盖，最高优先）
 *   ② PATH 里的 zcode / zcode.cmd / zcode.ps1（官方 CLI 形态）
 *   ③ 各盘符 + 各常见安装根下的 ZCode 安装目录
 * 全部失败 ⇒ 不伪造路径，把"怎么修"写进错误里（见下方 problems）。 */
const ZCODE_SUBPATH_CLI = join('resources', 'glm', 'zcode.cjs');
const ZCODE_SUBPATH_BUILTIN = join('resources', 'config', 'provider', 'zcode-builtin.json');

/** 该文件/目录是否存在（不抛）。 */
function exists(p) {
  try { return !!p && existsSync(p); } catch { return false; }
}

/** 枚举本机盘符（Windows）；非 Windows 返回空数组。 */
function windowsDriveRoots() {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (let c = 65; c <= 90; c += 1) { // A..Z
    const root = `${String.fromCharCode(c)}:\\`;
    if (exists(root)) out.push(root);
  }
  return out;
}

/** 生成候选 ZCode **安装根**（按"最可能命中"排序，去重）。 */
function zcodeInstallRootCandidates() {
  const roots = [];
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p); };
  const env = process.env;
  // ① ZCODE_CLI 若是目录（安装根）⇒ 加入候选表，交给下方统一扫描；
  //    若是**已存在的文件** ⇒ 由 resolveZcodePaths() 直接采用（不走候选表）。
  const cliOverride = env.ZCODE_CLI;
  if (cliOverride && !exists(cliOverride)) {
    // 不存在：既可能是"写错的安装根"，也可能是"写错的 CLI 路径" —— 都当安装根试一次（失败即回退自动发现）
    push(cliOverride);
  } else if (cliOverride && exists(cliOverride)) {
    push(cliOverride.toLowerCase().endsWith('zcode.cjs')
      ? join(cliOverride, '..', '..', '..')            // <root>/resources/glm/zcode.cjs → <root>
      : cliOverride);
  }
  if (env.ZCODE_HOME) push(env.ZCODE_HOME);
  if (env.ZCODE_INSTALL_DIR) push(env.ZCODE_INSTALL_DIR);
  // ② 常见"Programs/Program Files"位置（含 LocalAppData 的用户级安装）
  const bases = [
    env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'),
    env.LOCALAPPDATA, env.ProgramData,
  ].filter(Boolean);
  for (const b of bases) push(join(b, 'ZCode'));
  // ③ 跨盘符（原硬编码在 F: 盘 —— 这正是它挂掉的原因）
  for (const d of windowsDriveRoots()) {
    for (const sub of ['Program Files', 'Program Files (x86)', 'Programs']) push(join(d, sub, 'ZCode'));
  }
  return roots;
}

/**
 * 解析 ZCode 的 CLI 与 builtin provider 配置。
 * @returns {{cli:string|null, builtin:string, personal:string, tried:string[], reason:string}}
 */
function resolveZcodePaths() {
  const tried = [];
  const env = process.env;
  /* ⓪ 最高优先：ZCODE_CLI **指向一个真实存在的文件** ⇒ 直接采用（不做任何推导）。
   * 这条是向后兼容的关键：测试与 CI 常用 ZCODE_CLI 指向一个假的 CLI 脚本来干跑。 */
  const cliOverride = env.ZCODE_CLI;
  if (cliOverride && exists(cliOverride)) {
    const maybeRoot = cliOverride.toLowerCase().endsWith('zcode.cjs')
      ? join(cliOverride, '..', '..', '..')
      : null;
    return {
      cli: cliOverride,
      builtin: env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
        || (maybeRoot ? join(maybeRoot, ZCODE_SUBPATH_BUILTIN) : findBuiltinFromRoots(tried)),
      personal: env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || join(HOME_ZCODE, 'v2', 'provider_config.json'),
      tried,
      reason: 'ZCODE_CLI 显式指定（文件存在，直接采用）',
    };
  }
  // ① env 直接给 CLI（ZCode 官方 CLI 形态：PATH 里的 zcode / zcode.cmd / zcode.ps1）
  const exts = process.platform === 'win32' ? ['.cmd', '.ps1', '.exe', ''] : [''];
  const pathDirs = String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of ['zcode', 'zcode-cli']) {
      for (const ext of exts) {
        const cand = join(dir, name + ext);
        tried.push(cand);
        if (exists(cand)) {
          // 官方 CLI 形态：CLI 就是它自己；builtin 配置仍从安装根推（找不到就只给 personal）
          return {
            cli: cand,
            builtin: findBuiltinFromRoots(tried),
            personal: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || join(HOME_ZCODE, 'v2', 'provider_config.json'),
            tried,
            reason: 'PATH 命中官方 zcode CLI',
          };
        }
      }
    }
  }
  // ② 安装根扫描（客户端自带 CLI 形态）
  for (const root of zcodeInstallRootCandidates()) {
    const cli = join(root, ZCODE_SUBPATH_CLI);
    tried.push(cli);
    if (exists(cli)) {
      return {
        cli,
        builtin: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || join(root, ZCODE_SUBPATH_BUILTIN),
        personal: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || join(HOME_ZCODE, 'v2', 'provider_config.json'),
        tried,
        reason: `安装根扫描命中：${root}`,
      };
    }
  }
  // ③ 全失败：**不伪造路径**，如实返回 null 并保留"查过哪里"供报错
  return {
    cli: null,
    builtin: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || '',
    personal: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || join(HOME_ZCODE, 'v2', 'provider_config.json'),
    tried,
    reason: '未找到 ZCode CLI（已查 PATH 与各盘符常见安装位置）',
  };
}

/** 只从安装根候选里找 builtin provider 配置（PATH 形态 CLI 时用）。 */
function findBuiltinFromRoots(tried) {
  if (process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) return process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  for (const root of zcodeInstallRootCandidates()) {
    const p = join(root, ZCODE_SUBPATH_BUILTIN);
    tried.push(p);
    if (exists(p)) return p;
  }
  return '';
}

const ZCODE_RESOLVED = resolveZcodePaths();
const CLI = ZCODE_RESOLVED.cli;
const BUILTIN = ZCODE_RESOLVED.builtin;
const PERSONAL_DEFAULT = ZCODE_RESOLVED.personal;

/* ---------- 参数解析 ---------- */
const argv = process.argv.slice(2);
const opt = { attach: [], mode: 'edit', timeoutMin: 45, ledger: true, provider: 'plan' };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--task') opt.task = next();
  else if (a === '--prompt' || a === '-p') opt.prompt = next();
  else if (a === '--target') opt.target = next();
  else if (a === '--resume') opt.resume = next();
  else if (a === '--mode') opt.mode = next();
  else if (a === '--project') opt.project = next(); // 项目根（已在顶部预扫描用于路径常量，这里仅为吞掉参数）
  else if (a === '--cwd') opt.cwd = next();
  else if (a === '--tag') opt.tag = next();
  else if (a === '--model') opt.model = next();
  else if (a === '--provider') opt.provider = next();
  else if (a === '--transport') opt.transport = next();
  else if (a === '--personal-config') opt.personalConfig = next();
  else if (a === '--timeout-min') opt.timeoutMin = Number(next());
  else if (a === '--reasoning-level') opt.reasoningLevel = next();
  else if (a === '--attach') opt.attach.push(next());
  else if (a === '--no-ledger') opt.ledger = false;
  else if (a === '--memory-bench') opt.memoryBench = true;
  else if (a === '--memory-ban') opt.memoryBan = true;
  else if (a === '--no-cred-fallback') opt.credFallback = false;
  else if (a === '--list-providers') opt.listProviders = true;
  else if (a === '--help' || a === '-h') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    process.exit(0);
  } else {
    console.error(`[zcode-run] 未知参数: ${a}`);
    process.exit(1);
  }
}

/* ---------- 读取桌面端账号配置里的 provider（套餐密钥/端点/模型元数据都在这里） ---------- */
const readAppConfig = () => {
  if (!existsSync(APP_CONFIG)) return null;
  try {
    return JSON.parse(readFileSync(APP_CONFIG, 'utf8'));
  } catch {
    return null;
  }
};

const appCfg = readAppConfig();
const appProviders = appCfg?.provider ?? {};

const isPlanKey = (k) => /coding-plan|start-plan/.test(k);
const planCandidates = () => Object.entries(appProviders).filter(([k]) => isPlanKey(k));

/* ---------- 思考强度（ZB-29：ZCode Thought Level / reasoningLevel） ----------
 * 取值**随模型声明不同**（内置配置 modelRules 按序 overlay，后者覆盖前者）。
 * 注入点 = 临时 provider 配置顶层的 defaultModelSelection（headless 启动读取它作为会话
 * 初始模型选择；--resume 由 ZCode 明确跳过 —— 沿用原会话档位）。
 * 在此只做**探测**（供 --list-providers 与校验提示），不写死枚举。
 *
 * ⚠️ ZB-31（用户报「GLM-5.3 系 / deepseek-flash 没有低/高/最高选项」）—— 探测**漏了两处**，
 * 都不是「CLI 不支持」，而是本探测器的匹配式与枚举面与 ZCode 不一致：
 *
 *  ① **匹配式**：ZCode 用 `vWt(modelMatch, modelId, true)` = `new RegExp('^(?:'+match+')$','i')`
 *     —— **锚定 + 忽略大小写**（zcode.cjs:1064 附近的 `function vWt(e,t,n=!1){return new RegExp(...)}`）。
 *     本文件原先用 `new RegExp(r.modelMatch).test(id)`：**无锚点、无 i**。
 *     后果（实测）：内置 modelRules 里 `.*glm-5(?:…)?` → `disabled,enabled` 排在
 *     `.*glm-5\.3(?:-flash)?(?:…)?` → `low,high,max` **之前**；ZCode 忽略大小写 ⇒ 两条都命中，
 *     后者（.3）覆盖前者 ⇒ 真值 low,high,max。本文件大小写敏感 ⇒ `glm-5.3` 那条**永不命中**
 *     （模型 id 是 `GLM-5.3`），只剩 `.*glm-5(?:…)?` 的 disabled,enabled ⇒ 面板只有两档。
 *  ② **枚举面**：`--list-providers` 只遍历桌面端 `config.json` 的 `provider[*].models` 并集，
 *     而 `deepseek-flash` 只出现在**个人通道**（`provider_config.json` 的 `personalModelIds`）
 *     里 ⇒ 它一条 `reasoning-levels` 行都没有 ⇒ core 的 `levelsOf` 返回 null ⇒ 面板退回通用提示。
 *
 * 修法：① 匹配式与 ZCode **逐字同式**（锚定 + i）；② 枚举面补上个人通道模型。
 * 两处都只影响**探测/校验**；实际注入始终由 ZCode 自己按同一套声明解释。 */
function builtinModelRules() {
  try {
    const j = JSON.parse(readFileSync(BUILTIN, 'utf8'));
    return Array.isArray(j?.config?.modelConfigRules?.modelRules) ? j.config.modelConfigRules.modelRules : [];
  } catch {
    return [];
  }
}
const MODEL_RULES = builtinModelRules();

/** 与 ZCode 自身的 modelMatch 匹配**逐字同式**：`new RegExp('^(?:'+match+')$','i')`。
 *  证据：zcode.cjs 的 `function vWt(e,t,n=!1){return new RegExp(`^(?:${e})$`, n?"i":void 0).test(t)}`，
 *  调用点 `vWt(s.modelMatch, t.modelId, !0)`（ModelConfigRules.resolve 的 overlay 主循环）。 */
function zcodeModelMatch(matchRe, modelId) {
  try {
    return new RegExp(`^(?:${matchRe})$`, 'i').test(modelId);
  } catch {
    return false; // 坏正则：跳过（与 ZCode 的 refine 拒绝无效正则同向）
  }
}

/** 某模型 id 的合法思考强度取值（按序 overlay，后者覆盖前者；读不到返回 null = 不校验，交给 ZCode fail-fast）。 */
function reasoningLevelsFor(modelId) {
  if (!modelId || MODEL_RULES.length === 0) return null;
  let levels = null;
  for (const r of MODEL_RULES) {
    const re = r?.modelMatch;
    if (typeof re !== 'string') continue;
    if (zcodeModelMatch(re, modelId)) {
      const lv = r?.config?.optionSpecs?.reasoningLevel?.values;
      if (Array.isArray(lv) && lv.length) levels = lv.map(String); // 后者覆盖前者（与 ZCode overlay 同序）
    }
  }
  return levels;
}

/** 个人通道配置的实际路径（`--personal-config` 覆盖，否则默认）。**在 listProviders 之前声明**：
 *  `--list-providers` 会经 personalModelIds() 读它（声明在下方会造成 TDZ）。 */
const personalPath = opt.personalConfig ? resolve(opt.personalConfig) : PERSONAL_DEFAULT;

/** 个人通道的模型 id（ZB-31：`deepseek-flash` 这类模型只在这里出现，不在 config.json 里）。
 *  尊重 `--personal-config` 覆盖（与派发路径同一个文件）；读不到 ⇒ 空数组（不猜）。 */
function personalModelIds() {
  try {
    const j = JSON.parse(readFileSync(personalPath, 'utf8'));
    const rules = j?.config?.providerConfigRules?.providerRules ?? [];
    const out = new Set();
    for (const r of rules) {
      for (const m of r?.config?.personalModelIds ?? []) if (m) out.add(String(m));
      for (const m of r?.config?.modelOrder ?? []) if (m) out.add(String(m));
    }
    return [...out];
  } catch {
    return [];
  }
}

const listProviders = async () => {
  if (!appCfg) {
    console.error(`[zcode-run] 读不到 ${APP_CONFIG}`);
    process.exit(1);
  }
  console.log('id'.padEnd(34) + 'enabled  端点/模型');
  for (const [id, p] of Object.entries(appProviders)) {
    const models = p?.models ? Object.keys(p.models).join(', ') : '-';
    const reason = p?.systemDisabledReason ? ` (${p.systemDisabledReason})` : '';
    console.log(
      `${id.padEnd(34)}${String(!!p?.enabled).padEnd(10)}${p?.options?.baseURL ?? '-'} | ${models}${reason}`,
    );
  }
  /* ZB-29：每个模型的思考强度合法取值（面板下拉的数据源；随模型声明不同）。
   * ZB-31：枚举面 = 桌面端 config.json 的 models 并集 **∪ 个人通道的 personalModelIds/modelOrder**
   * —— 后者是 `deepseek-flash` 这类模型的唯一出处（原先漏了 ⇒ 个人通道面板没有档位选项）。 */
  const allModels = new Set();
  for (const p of Object.values(appProviders)) {
    for (const m of Object.keys(p?.models ?? {})) allModels.add(m);
  }
  for (const m of personalModelIds()) allModels.add(m);
  for (const m of [...allModels].sort()) {
    const lv = reasoningLevelsFor(m);
    if (lv) console.log(`[zcode-run] reasoning-levels ${m}=${lv.join(',')}`);
  }
  /* ZB-33：免费额度（Start Plan）通道 —— **不是** config.json 里的现成 provider，
   * 而是运行时注入的 `account:<family>-start-plan`（见 collab-kit/appserver-gift.mjs）。
   * 这里补一行，好让派发台的 `action=channels` / 面板能选到它（id 可直接当 --provider 用）。
   * enabled 判据 = 本机凭据库有可解密的 zcodejwttoken（**只表示"已登录、可尝试"**：
   * 额度窗口与权益由服务端判定，真正的失败会在派发时以暂停签名报出来）。 */
  const startPlanEntry = appProviders['builtin:bigmodel-start-plan'] ?? appProviders['builtin:zai-start-plan'];
  const startPlanModels = startPlanEntry?.models ? Object.keys(startPlanEntry.models).join(', ') : 'GLM-5.3-Flash';
  const startPlanEndpoint = startPlanEntry?.options?.baseURL ?? 'https://zcode.z.ai/api/v1/zcode-plan/anthropic';
  const { readGiftAuth, startPlanProviderId } = await import('./appserver-gift.mjs'); // 动态导入：新模块的问题不该拖垮既有路径
  let giftRow;
  try {
    const auth = readGiftAuth(CRED_STORE);
    giftRow = `${startPlanProviderId(auth.activeProvider).padEnd(34)}${'true'.padEnd(10)}${startPlanEndpoint} | ${startPlanModels} (免费额度 Start Plan；--provider start-plan)`;
  } catch (error) {
    giftRow = `${startPlanProviderId(undefined).padEnd(34)}${'false'.padEnd(10)}${startPlanEndpoint} | ${startPlanModels} (免费额度：凭据不可用 —— ${String(error?.message ?? error).slice(0, 60)})`;
  }
  console.log(giftRow);
  console.log('\n提示：默认 --provider plan 会选第一个启用的 *coding-plan，其次 *start-plan。');
};

if (opt.listProviders) {
  await listProviders();
  process.exit(0);
}

/* ---------- GATE：派发总开关（跨会话真值来源；契约见 collab/PROTOCOL.md） ----------
 * 任何会话（DSH / ZCode / 桥）**派发前**都必须过这一关：文件里 enabled:false 即拒绝。
 * 真值来源是磁盘文件而非内存开关 —— 跨进程只能靠文件。
 * 【位置】紧跟在 `--list-providers` 分支之后、**凭据读取与子进程启动之前**：
 *   · 只读探测（上面已 return）**不过闸** —— 不派发、不起进程、不耗额度，冻结期间面板仍能列通道；
 *   · 一切真实派发**必过闸**；且此时尚未读凭据库、尚未 spawn ⇒ ZB-33 的收益完整保留。
 * 退出码 3 = 因总开关关闭而拒绝（与参数错误 1、超时 124 区分）。 */
{
  const sw = readDispatchSwitch();
  if (!sw.enabled) {
    console.error('[zcode-run] ⛔ 派发总开关为「关闭」，拒绝派发（未启动任何进程、未消耗任何额度）。');
    console.error(`[zcode-run] 开关文件: ${SWITCH_FILE}`);
    if (sw.updatedBy || sw.updatedAt) console.error(`[zcode-run] 最后修改: ${sw.updatedBy ?? '?'} @ ${sw.updatedAt ?? '?'}`);
    if (sw.note) console.error(`[zcode-run] 备注: ${sw.note}`);
    console.error('[zcode-run] 需要恢复派发时: node <本仓库>/collab-kit/dispatch-switch.mjs --project <宿主项目> on');
    console.error('[zcode-run] 提示：只读探测（--list-providers）不受总开关影响，可随时查看通道。');
    process.exit(3);
  }
}

const problems = [];
/* ZB-51：发现失败时给出**可操作的**说明（列出查过哪些位置），不要只说 "null"。
 * 目标读者是"刚装上插件的人"：他需要知道下一步干什么，而不是看到一条内部错误。 */
if (!CLI || !existsSync(CLI)) {
  problems.push(
    CLI
      ? `找不到 ZCode CLI: ${CLI}（可用 ZCODE_CLI 覆盖，或设 ZCODE_HOME 指向安装根）`
      : '未找到 ZCode CLI。已查找：环境变量 ZCODE_CLI/ZCODE_HOME/ZCODE_INSTALL_DIR、PATH 中的 zcode、'
        + '以及各盘符的 "Program Files/ZCode"。修复方式：① 安装 ZCode 桌面版；'
        + '② 或设 ZCODE_CLI 指向 <安装根>\\resources\\glm\\zcode.cjs；'
        + `③ 或设 ZCODE_HOME 指向安装根。已尝试 ${ZCODE_RESOLVED.tried.length} 个候选路径`,
  );
}
if (!BUILTIN || !existsSync(BUILTIN)) {
  problems.push(
    BUILTIN
      ? `找不到内置 provider 配置: ${BUILTIN}`
      : '找不到内置 provider 配置（随 ZCode 安装自带）。若已用 ZCODE_CLI 指定 CLI，'
        + '请再设 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE，或让 ZCODE_HOME 指向安装根以便自动推导',
  );
}
if (opt.provider === 'personal' && !existsSync(personalPath)) {
  problems.push(`找不到个人 provider 配置: ${personalPath}`);
}
if (opt.target && (opt.prompt || opt.task)) {
  problems.push('--target 与 --prompt/--task 互斥（CLI 限制），请二选一');
}
if (!opt.target && !opt.prompt && !opt.task) problems.push('必须给出 --task / --prompt / --target 之一');
if (problems.length) {
  for (const p of problems) console.error(`[zcode-run] ${p}`);
  process.exit(1);
}

/* ---------- 凭据双保险：config.json 验活失败 → 回退加密凭据库 ----------
 * 与 dsh-connect-zcode 的 credential-store.js / credential.js 同源逻辑（本项目内联实现，
 * 避免跨仓库依赖）。设计约束与参考实现一致：
 *   · **必须验活才切换**（不验活就切可能选到同样失效的 key，比不切更糟）
 *   · **零明文日志**（只打指纹 head=xxxxxxxx*** tail=***xxxx）
 *   · **零落盘**（明文只在内存；本文件已有的临时 provider 副本机制不变）
 *   · **绝不抛**（解密失败/文件缺失/网络异常一律降级，保持既有行为）
 *   · 用 `node:https` 而非 fetch —— 实测 fetch 后 process.exit 在 Windows 会崩（见文件头注释）
 */

/** 加密值前缀与算法常量（与 zcode.cjs 一致，从 dsh-connect-zcode 移植）。 */
const ENC_PREFIX = 'enc:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;
const SECRET_ENV = 'ZCODE_CREDENTIAL_SECRET';
/** zhipu 平台 API Key 形态（32 hex id + "." + 16 secret；实测长度恒为 49）。 */
const API_KEY_RE = /^[0-9a-f]{32}\.[A-Za-z0-9]{16}$/;

/** 解出解密 secret（env 优先，否则 ZCode 的 fallback 串——与 zcode.cjs 同式）。 */
function resolveCredSecret() {
  const fromEnv = process.env[SECRET_ENV]?.trim();
  if (fromEnv) return fromEnv;
  let user = 'unknown';
  try {
    user = userInfo().username;
  } catch {
    /* 取不到用户名就用 unknown（与 zcode.cjs 同式） */
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${user}`;
}

/** 解密单个 enc:v1 值。失败返回 null（绝不抛、绝不打印值）。 */
function decryptCredentialValue(value) {
  try {
    if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return null;
    const parts = value.slice(ENC_PREFIX.length).split('.');
    if (parts.length !== 3) return null;
    const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64url'));
    if (iv.length !== IV_LEN || tag.length !== TAG_LEN || data.length === 0) return null;
    const key = createHash('sha256').update(resolveCredSecret()).digest();
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** 脱敏指纹（仅供日志/诊断，绝不还原 key）。 */
function keyFingerprint(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length < 12) return '(invalid)';
  return `head=${apiKey.slice(0, 8)}*** tail=***${apiKey.slice(-4)}`;
}

/**
 * 从加密凭据库读出全部 coding-plan api-key 候选。
 * 键形如 `account-provider:coding-plan:account:<planId>:account:<accountId>:api-key`（7 段、两个 account:）。
 * 解密后须匹配 API Key 形态；返回按 id 字典序（稳定顺序，便于逐把验活）。
 * @param {(msg: string) => void} [diag]
 * @returns {Array<{ id: string, apiKey: string }>} 失败 = 空数组
 */
function readStoredApiKeys(diag = () => {}) {
  try {
    if (!existsSync(CRED_STORE)) {
      diag(`凭据库不存在：${CRED_STORE}`);
      return [];
    }
    const raw = JSON.parse(readFileSync(CRED_STORE, 'utf8'));
    if (raw === null || typeof raw !== 'object') return [];
    const out = [];
    let matched = 0;
    let decrypted = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith('account-provider:coding-plan:') || !k.endsWith(':api-key')) continue;
      matched += 1;
      const plain = decryptCredentialValue(v);
      if (typeof plain !== 'string' || !API_KEY_RE.test(plain)) continue;
      decrypted += 1;
      const segs = k.split(':');
      const planId = segs.length >= 4 && segs[2] === 'account' ? segs[3] : 'unknown';
      out.push({ id: planId, apiKey: plain });
    }
    /* 计数诊断（参考实现踩过的坑）：区分"库里没 key"与"形态变了被滤光"，
     * 否则回退失败时毫无线索。 */
    diag(`凭据库条目 ${Object.keys(raw).length} 条，其中 coding-plan api-key ${matched} 条，形态校验通过 ${decrypted} 条`);
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } catch (e) {
    diag(`凭据库读取失败：${e?.message ?? e}`);
    return [];
  }
}

/** 用 node:https 发 GET 并解析 JSON（不用 fetch：见文件头 libuv 崩溃说明）。 */
function httpsGetJson(urlStr, headers, timeoutMs = 8000) {
  return new Promise((resolvePromise) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolvePromise(v);
      }
    };
    try {
      const u = new URL(urlStr);
      const req = httpsRequest(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || 443,
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          headers,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => finish({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', () => finish(null));
        },
      );
      req.setTimeout(timeoutMs, () => {
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        finish(null);
      });
      req.on('error', () => finish(null));
      req.end();
    } catch {
      finish(null);
    }
  });
}

/**
 * 验活一把 Key。**必须校验响应体**：bigmodel 网关对失效 Key 的 `GET /v1/models`
 * 也返回 HTTP 200，body 却是 `{"code":1000,"msg":"身份验证失败。","success":false}`。
 * 三者同时满足才算通过：ok → success!==false → code===200 → data 非空。
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function validateApiKey(apiKey, baseURL, timeoutMs = 8000) {
  if (typeof apiKey !== 'string' || !apiKey) return { ok: false, reason: 'key 为空' };
  const base = String(baseURL ?? '').replace(/\/+$/, '');
  if (!base) return { ok: false, reason: 'baseURL 为空' };
  const res = await httpsGetJson(`${base}/v1/models`, {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }, timeoutMs);
  if (!res) return { ok: false, reason: '网络异常/超时' };
  if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
  let body;
  try {
    body = JSON.parse(res.text);
  } catch {
    return { ok: false, reason: '响应非 JSON' };
  }
  if (body === null || typeof body !== 'object') return { ok: false, reason: '响应非对象' };
  if (body.success === false) return { ok: false, reason: `body: code=${body.code ?? '?'} ${body.msg ?? '认证失败'}` };
  if (body.code !== undefined && body.code !== 200) return { ok: false, reason: `body: code=${body.code}` };
  if (!Array.isArray(body.data) || body.data.length === 0) return { ok: false, reason: 'data 为空' };
  return { ok: true, reason: `${body.data.length} 个模型` };
}

/**
 * 解析可用凭据：config.json 的 Key 优先；**验活失败**才回退到加密凭据库
 * （逐把验活，取第一把通过的）。任何失败都保持 config.json 原值（不引入新失败面）。
 * @param {string} configKey  config.json 里的 apiKey
 * @param {string} baseURL
 * @param {{ enabled?: boolean, onDiagnostic?: (m: string) => void }} [io]
 * @returns {Promise<{ apiKey: string, source: 'config'|'store', fingerprint: string }>}
 */
async function resolvePlanApiKey(configKey, baseURL, io = {}) {
  const diag = typeof io.onDiagnostic === 'function' ? io.onDiagnostic : () => {};
  const fallback = { apiKey: configKey, source: 'config', fingerprint: keyFingerprint(configKey) };
  if (io.enabled === false) return fallback; // --no-cred-fallback

  const base = await validateApiKey(configKey, baseURL);
  if (base.ok) return fallback; // config.json 有效 ⇒ 不动（绝大多数情况）

  diag(`config.json 的 Key 验活失败（${base.reason}）⇒ 尝试回退到加密凭据库`);
  const candidates = readStoredApiKeys(diag);
  if (candidates.length === 0) {
    diag('凭据库无可用候选 ⇒ 沿用 config.json 原值（派发仍会 401，请跑 sync-key-to-config.mjs）');
    return fallback;
  }
  for (const cand of candidates) {
    const r = await validateApiKey(cand.apiKey, baseURL);
    if (r.ok) {
      diag(`✅ 回退成功：account=${cand.id} ${keyFingerprint(cand.apiKey)}（${r.reason}）`);
      return { apiKey: cand.apiKey, source: 'store', fingerprint: keyFingerprint(cand.apiKey) };
    }
    diag(`   候选 ${cand.id} ${keyFingerprint(cand.apiKey)} → ❌ ${r.reason}`);
  }
  diag(`凭据库 ${candidates.length} 个候选均验活失败 ⇒ 沿用 config.json 原值`);
  return fallback;
}

/* ---------- 解析本次使用的 provider 与模型 ---------- */
let providerId = null; // 用于展示；null 表示直接用个人配置
let providerRule = null; // 若需注入套餐 provider，这里是 providerRules 条目
let providerModels = []; // [{ id, contextWindow, maxOutput }]
let providerLabel = 'personal';

/* ZB-33：免费额度（Start Plan）走 app-server 托管，**不经过**这套"读 config.json 里的
 * builtin provider + 验活 apiKey + 造临时 provider 配置"的流程（那条路的端点是认证型，
 * 直连必被拦）。它的分支在下方产物路径算好之后。
 * 接受三种写法：`--provider start-plan` / `--provider gift` / `--provider account:<family>-start-plan`
 * （最后一种就是 `--list-providers` 里那一行的 id，派发台 `action=channel` 设默认通道时用它）。 */
const GIFT_PROVIDER_RE = /^account:[a-z]+-start-plan$/;
const GIFT_MODE = opt.provider === 'gift' || opt.provider === 'start-plan' || GIFT_PROVIDER_RE.test(opt.provider ?? '') || opt.transport === 'appserver';

if (!GIFT_MODE && opt.provider !== 'personal') {
  if (!appCfg) {
    console.error(`[zcode-run] --provider ${opt.provider} 需要读取 ${APP_CONFIG}（桌面端账号配置）`);
    process.exit(1);
  }
  let key = opt.provider;
  if (key === 'plan') {
    const ranked = planCandidates().sort(([a, pa], [b, pb]) => {
      const score = (k, p) => (p?.enabled ? 2 : 0) + (/coding-plan/.test(k) ? 1 : 0);
      return score(b, pb) - score(a, pa);
    });
    const pick = ranked.find(([, p]) => p?.enabled);
    if (!pick) {
      console.error('[zcode-run] 账号内没有已启用的套餐 provider（--list-providers 查看原因）');
      process.exit(1);
    }
    key = pick[0];
  }
  const entry = appProviders[key];
  if (!entry) {
    console.error(`[zcode-run] provider 不存在: ${key}（可用 --list-providers 查看）`);
    process.exit(1);
  }
  if (!entry.enabled) {
    console.error(
      `[zcode-run] provider ${key} 未启用（${entry.systemDisabledReason ?? '未知原因'}），拒绝派发以免静默改用其他通道`,
    );
    process.exit(1);
  }
  if (!entry?.options?.apiKey || !entry?.options?.baseURL) {
    console.error(`[zcode-run] provider ${key} 缺少 apiKey/baseURL`);
    process.exit(1);
  }
  /* 凭据双保险：先验活 config.json 的 Key，失败则回退加密凭据库（逐把验活取第一把通过的）。
   * 诊断只打指纹（head=xxxxxxxx*** tail=***xxxx），绝不打印 Key 原文。 */
  const cred = await resolvePlanApiKey(entry.options.apiKey, entry.options.baseURL, {
    enabled: opt.credFallback !== false,
    onDiagnostic: (m) => console.log(`[zcode-run] [cred] ${m}`),
  });
  if (cred.source === 'store') {
    console.log(`[zcode-run] [cred] 本次使用凭据库中的 Key（${cred.fingerprint}）；config.json 里的旧 Key 已失效`);
  }
  providerId = key;
  providerLabel = entry.name ?? key;
  providerModels = Object.entries(entry.models ?? {}).map(([id, m]) => ({
    id,
    contextWindow: m?.limit?.context,
    maxOutput: m?.limit?.output,
  }));
  if (opt.model && providerModels.length && !providerModels.some((m) => m.id === opt.model)) {
    console.warn(
      `[zcode-run] 警告：${opt.model} 不在 ${key} 的模型表（${providerModels.map((m) => m.id).join(', ')}）中，仍按指定值请求`,
    );
  }
  const modelIds = opt.model ? [opt.model] : providerModels.map((m) => m.id);
  providerRule = {
    providerId: `plan:${key.replace(/^builtin:/, '')}`,
    providerName: `${entry.name ?? key}（ZCode 套餐）`,
    config: {
      group: 'standard-personal',
      access: { type: 'api-key', apiKey: cred.apiKey }, // ★ 用验活后的 Key（可能来自凭据库回退）；只在内存→临时文件，跑完即删
      api: { type: entry.kind === 'anthropic' ? 'anthropic-messages' : 'openai-chat-completions', baseUrl: entry.options.baseURL },
      personalModelIds: modelIds,
      modelOrder: modelIds,
    },
  };
}

/* ---------- 组 prompt ---------- */
let prompt = opt.prompt ?? '';
let taskPath = '';
if (opt.task) {
  taskPath = isAbsolute(opt.task) ? opt.task : resolve(PROJECT, opt.task);
  if (!existsSync(taskPath)) {
    console.error(`[zcode-run] 任务包不存在: ${taskPath}`);
    process.exit(1);
  }
  const body = readFileSync(taskPath, 'utf8');
  prompt =
    `请严格按下面的任务包执行（任务包文件：${taskPath}）。\n` +
    '你是本项目唯一的业务代码写入方；任务包里的「禁止」与「交付物」是硬约束。\n' +
    '完成后必须把交付文档写到任务包指定的路径，并在最终回复里给出：交付清单 / 可复跑命令 / 原始输出 / 未决问题。\n\n' +
    '===== 任务包开始 =====\n' +
    body +
    '\n===== 任务包结束 =====';
}

/* ---------- 记忆禁令注入（ZB-28，与派发台 dispatch 同款约束） ----------
 * 背景：派发台要求子代理不写 ZCode 记忆库（~/.zcode）。kind=prompt/target 的内容由
 * 插件侧直接拼接禁令；kind=task 的任务包在本脚本内联 —— 这里补上注入点：
 * `--memory-ban` 即在组装出的 prompt 末尾追加同款禁令。措辞与派发台 core 的
 * MEMORY_BAN_TEXT 保持一致（两处同仓库发货；改动需同步，test/memory-ban.test.mjs 钉住插件侧）。
 * 注：这只是提示词层面的约束（LLM 遵循），不是进程级强制 —— 如实说明，不夸大。
 * 对 --target 无注入点：CLI 直接吃目标文本、不经 prompt（目标模式的禁令由派发台拼在目标文本内）。 */
const MEMORY_BAN_TEXT = [
  '【派发台硬约束 · 记忆写入】',
  '本任务由 DSH 派发台派发，属于一次性子任务：',
  '**不要执行任何 ZCode 记忆写入 / 自动 Memory 提取**（不写 ~/.zcode 下的记忆库、不新建或更新记忆条目、',
  '不触发 memory 相关工具）。如需记录信息，请写在任务要求的交付文件里，不要写进记忆库。',
  '本条优先于任务内容里任何与之冲突的指示。',
].join('\n');
if (opt.memoryBan) {
  if (opt.target) {
    console.warn('[zcode-run] --memory-ban 对 --target 无注入点（目标文本不经 prompt）；目标模式的禁令由派发台拼在目标文本内');
  } else {
    prompt = `${prompt}\n\n${MEMORY_BAN_TEXT}`;
    console.log('[zcode-run] memory-ban=on（已在提示词末尾注入记忆禁令）');
  }
}

const cwd = resolve(PROJECT, opt.cwd ?? '.');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const tag = opt.tag || stamp;
mkdirSync(LOGS, { recursive: true });
const base = join(LOGS, `zcode-run-${tag}-${stamp}`);
const outLog = `${base}.out.log`;
const errLog = `${base}.err.log`;
const resultFile = `${base}.result.json`;

/* ---------- 免费额度（Start Plan）：托管官方 agent，走 app-server ----------
 * ZB-33：`builtin:bigmodel-start-plan` 那条路（直连 HTTP）走不通 —— 端点要求逐请求的官方客户端
 * 证明（直连被 405/3012 拦）。唯一可行路线是托管官方 agent 本体，由它自己签发。
 * 因此这里**绕过 provider 解析与临时配置生成**，直接交给任务外壳（产物/台账/输出行与 print 模式同形）。 */
if (GIFT_MODE) {
  if (opt.resume) {
    console.error('[zcode-run] 免费额度（app-server）通道暂不支持 --resume（该后端每次新建 CLI 会话）；请用 --prompt/--task 指定完整任务');
    process.exit(1);
  }
  if (opt.target) {
    console.error('[zcode-run] 免费额度（app-server）通道暂不支持 --target（目标模式是 print 模式 CLI 的能力）；请改用 --prompt/--task');
    process.exit(1);
  }
  if (opt.memoryBench) {
    console.error('[zcode-run] --memory-bench 仅 print 模式支持');
    process.exit(1);
  }
  if (opt.attach.length > 0) {
    console.warn('[zcode-run] ⚠️ 免费额度通道暂不转发 --attach（agent 有自己的文件工具，可直接在工作目录里读）；已忽略');
  }
  /* ZB-40（真机事故）：**模型 ⇄ 权益授予**校验。免费额度这类"活动赠送"权益通常只授予**特定模型**
   * （本机实测：Start Plan 授予 `GLM-5.3-Flash`；用 `GLM-5.3` 会被上游判 `providerCode 1005
   * exceed quota limit`，轮次直接失败）。此前不做校验 ⇒ 派发跑 35 分钟、零输出、额度不动，
   * 从外面看像"卡住"。现在：授予模型已知且与 `--model` 不一致时**改用授予模型并大声说明**。 */
  if (opt.model && !opt.dryRun) {
    try {
      const { readGiftQuota } = await import('../dispatch/core/gift-quota.mjs'); // 额度读取在插件核心（只读 ZCode 日志）
      const q = readGiftQuota();
      /* ZB-41（2026-10-24，用户指出「两个模型都有免费额度」）：原实现只按**单一** q.model 判定
       * 「权益只授予这一个模型」，于是 GLM-5.3 被无条件改写成 GLM-5.3-Flash —— 而同一份额度数据里
       * `perModel` 明确显示 GLM-5.3 仍有 196.1M/200M 余额（权益是**逐模型**授予的）。
       * 现改为按**授予集合**判定：models ∪ perModel[].model ∪ model；请求模型在集合内就照用，
       * 只有确实不在集合里才替换（并列出授予清单，便于核对）。 */
      const granted = new Set([
        ...(typeof q?.model === 'string' && q.model ? [q.model] : []),
        ...(Array.isArray(q?.models) ? q.models : []),
        ...(Array.isArray(q?.perModel) ? q.perModel.map((x) => x?.model).filter(Boolean) : []),
      ].filter((x) => typeof x === 'string' && x !== ''));
      if (q?.ok === true && q.state === 'active' && typeof opt.model === 'string'
        && granted.size > 0 && !granted.has(opt.model)) {
        const fallback = typeof q.model === 'string' && q.model ? q.model : [...granted][0];
        console.error(
          `[zcode-run] ⚠️ 模型替换：--model ${opt.model} → ${fallback}` +
            `（免费额度权益「${q.planName ?? q.planId}」授予：${[...granted].join(', ')}；用未授予的模型会被上游判 1005 exceed quota limit）`,
        );
        opt.model = fallback;
      }
    } catch {
      /* 读不到权益就不猜：按用户给的模型继续，真失败会在 result 里带 providerError */
    }
  }
  const { runGiftJob } = await import('./appserver-gift-job.mjs'); // 动态导入：新模块的问题不该拖垮既有 print 路径
  process.exit(
    await runGiftJob({
      cliPath: CLI,
      project: PROJECT,
      prompt,
      cwd,
      tag,
      taskPath,
      opt,
      /* 显式给的是通道 id 时用它（`account:zai-start-plan` 与账号家族不一致也照用 —— 用户点名即照做） */
      accountProviderId: GIFT_PROVIDER_RE.test(opt.provider ?? '') ? opt.provider : undefined,
      outLog,
      errLog,
      resultFile,
      ledgerPath: join(LOGS, 'dispatch-runs.jsonl'),
    }),
  );
}

/* ---------- 生成临时个人 provider 配置（套餐注入 / --model 改写；原配置不动，副本跑完即删） ---------- */
let modelPath = personalPath;
let tempDir = '';
/* ZB-113（审查 HIGH#6）：**清扫上次被强杀残留的临时配置目录**（里面有明文 API Key）。
 * exit/SIGTERM/SIGINT 钩子都捕获不到 SIGKILL（taskkill /F、OOM、崩溃），只能靠下次启动兜底。
 * 只删 10 分钟前的（避免误删同时并发的另一个 runner 实例正在用的目录）。 */
try {
  for (const d of readdirSync(tmpdir())) {
    if (!/^zcode-cfg-\d+-\d+$/.test(d)) continue;
    const p = join(tmpdir(), d);
    try {
      if (Date.now() - statSync(p).mtimeMs > 10 * 60_000) rmSync(p, { recursive: true, force: true });
    } catch { /* 单个目录失败不影响其它 */ }
  }
} catch { /* tmpdir 不可读：跳过清扫 */ }
/* ZB-29：思考强度的落点。defaultModelSelection 需要**真实 providerId**：
 *  · plan 通道 = runner 选中的 builtin key（providerId 变量，如 builtin:bigmodel-coding-plan）；
 *  · personal 通道 = 个人配置里实际 provider 规则的 id（从源配置读，读不到就放弃注入并警告）。
 * modelId = 显式 --model，或通道默认（plan=选中 provider 的第一个模型；personal=源配置缺省选择/第一个）。 */
function resolveReasoningTarget() {
  if (!opt.reasoningLevel) return null;
  let level = String(opt.reasoningLevel).trim();
  if (!level) return null;
  if (opt.resume) {
    console.warn('[zcode-run] --reasoning-level 对 --resume 不生效（ZCode 沿用原会话档位）；已忽略');
    return null;
  }
  let effProviderId = null;
  let modelId = opt.model ?? null;
  if (providerRule) {
    effProviderId = providerId ?? null; // plan 通道：provider 选择段记录的 builtin key
    if (!modelId) modelId = providerModels[0]?.id ?? null;
  } else {
    try {
      const src = JSON.parse(readFileSync(personalPath, 'utf8'));
      const rule = (src?.config?.providerConfigRules?.providerRules ?? []).find((r) => r?.config?.access?.apiKey);
      effProviderId = rule?.providerId ?? null;
      if (!modelId) {
        const pids = rule?.config?.personalModelIds ?? [];
        modelId = pids[0] ?? rule?.config?.modelOrder?.[0] ?? null;
      }
    } catch { /* 读不到就放弃注入 */ }
  }
  if (!effProviderId || !modelId) {
    console.warn('[zcode-run] --reasoning-level 无法确定 provider/model，未注入（走 ZCode 默认档）');
    return null;
  }
  const declared = reasoningLevelsFor(modelId);
  if (level === 'agent') {
    /* 「Agent决定」档（ZB-29 用户要求）：解析成**实际生效的具体档位**并注入 ——
     * 规则与 ZCode 自身的 registry-fallback 完全一致（optionSpecs.reasoningLevel.values 的
     * **最后一个**，见 zcode.cjs QKe/v3i 的 values.at(-1)）；行为与不注入时相同，
     * 但档位显式化、进程上可显示实际值（而非「Agent决定」字样）。
     * 模型未声明档位（declared=null）时无法解析 → 不注入 + 警告（交给 ZCode 默认）。 */
    if (!declared || declared.length === 0) {
      console.warn(`[zcode-run] --reasoning-level agent：模型 ${modelId} 未声明思考强度档位，无法解析，未注入（走 ZCode 默认）`);
      return null;
    }
    level = declared.at(-1);
  } else if (declared && !declared.includes(level)) {
    console.error(`[zcode-run] --reasoning-level ${level} 不在模型 ${modelId} 声明的取值里（${declared.join('|')}），拒绝派发（防静默按默认档跑）`);
    process.exit(1);
  }
  return { providerId: effProviderId, modelId, reasoningLevel: level };
}
const reasoningTarget = resolveReasoningTarget();
const needTempConfig = !!providerRule || !!opt.model || !!reasoningTarget;
if (needTempConfig) {
  try {
    let cfg;
    if (providerRule) {
      cfg = {
        schemaVersion: 1,
        config: {
          providerConfigRules: { providerRules: [providerRule] },
          modelConfigRules: {
            providerModelRules: (opt.model ? [opt.model] : providerModels.map((m) => m.id)).map((id) => {
              const meta = providerModels.find((m) => m.id === id);
              return {
                modelId: id,
                providerId: providerRule.providerId,
                config: {
                  enabled: true,
                  ...(meta?.contextWindow ? { properties: { contextWindow: meta.contextWindow } } : {}),
                  ...(meta?.maxOutput ? { optionSpecs: { maxOutputTokens: { max: meta.maxOutput } } } : {}),
                },
              };
            }),
            manualProviderModelRules: [],
          },
          /* ZB-29：思考强度 —— headless 启动读 defaultModelSelection 作为会话初始模型选择
           * （--resume 由 ZCode 跳过，见 resolveReasoningTarget 的警告）。 */
          ...(reasoningTarget ? { defaultModelSelection: { providerId: reasoningTarget.providerId, modelId: reasoningTarget.modelId, options: { reasoningLevel: reasoningTarget.reasoningLevel } } } : {}),
        },
      };
    } else {
      const src = JSON.parse(readFileSync(personalPath, 'utf8'));
      let hits = 0;
      const rewrite = (o) => {
        if (Array.isArray(o)) return o.map(rewrite);
        if (o && typeof o === 'object') {
          const out = {};
          for (const [k, v] of Object.entries(o)) {
            if (k === 'modelId' && typeof v === 'string') { out[k] = opt.model; hits += 1; }
            else if ((k === 'personalModelIds' || k === 'modelOrder') && Array.isArray(v)) { out[k] = v.map(() => opt.model); hits += 1; }
            else out[k] = rewrite(v);
          }
          return out;
        }
        return o;
      };
      cfg = rewrite(src);
      if (reasoningTarget) {
        /* ZB-29：personal 通道同样注入 defaultModelSelection（schema：Pu 可选字段，strict）。 */
        cfg.config = {
          ...cfg.config,
          defaultModelSelection: {
            providerId: reasoningTarget.providerId,
            modelId: reasoningTarget.modelId,
            options: { reasoningLevel: reasoningTarget.reasoningLevel },
          },
        };
      }
      if (!hits) {
        console.error('[zcode-run] --model 未命中任何 modelId/personalModelIds/modelOrder 字段，拒绝继续（防静默用错模型）');
        process.exit(1);
      }
    }
    if (reasoningTarget) {
      console.log(`[zcode-run] reasoning-level=${reasoningTarget.reasoningLevel} target=${reasoningTarget.providerId}/${reasoningTarget.modelId}`);
    }
    tempDir = join(tmpdir(), `zcode-cfg-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    modelPath = join(tempDir, 'provider_config.json');
    writeFileSync(modelPath, JSON.stringify(cfg, null, 2));
    /* ZB-113：明文 Key 已落盘 ⇒ 立刻装兜底清理（正常路径 1145 行还会再清一次，幂等）。
     * SIGKILL 无法捕获（残余由下次启动的陈旧残留清扫兜底），但 SIGTERM/SIGINT/正常退出都能收干净。 */
    {
      const wipe = () => {
        if (!tempDir) return;
        try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
        tempDir = '';
      };
      process.on('exit', wipe);
      process.on('SIGINT', () => { wipe(); process.exit(130); });
      process.on('SIGTERM', () => { wipe(); process.exit(143); });
    }
  } catch (err) {
    console.error(`[zcode-run] 临时 provider 配置生成失败: ${err.message}`);
    process.exit(1);
  }
}

/* ---------- 套餐额度撞顶识别（T20 实证，2026-10-01） ----------
 * Coding Plan 有 5 小时滚动窗口上限。撞顶时 CLI 以 exit 1 结束，stderr 携带：
 *   statusCode: 429 / 'anthropic-ratelimit-unified-status': 'rejected'
 *   { code: '1308', message: '[1308][已达到 5 小时的使用上限。您的限额将在 <时间> 重置。]' }
 *   retry-after: '<秒>'
 * 识别它是为了把「额度耗尽」与「任务真失败」分开 —— 前者不该重试，也不该怪任务包。 */
function detectRateLimit(text) {
  if (!text) return null;
  const hit =
    /\b429\b/.test(text) ||
    /anthropic-ratelimit-unified-status['"]?\s*:\s*['"]rejected/i.test(text) ||
    /reatt?e?[_-]?limit|rate_limit_error/i.test(text) ||
    /已达到\s*5\s*小时的使用上限/.test(text);
  if (!hit) return null;
  const codeMatch = text.match(/code['"]?\s*:\s*['"]?(\d{4})/);
  const retryMatch = text.match(/retry-after['"]?\s*:\s*['"]?(\d+)/i);
  const resetMatch = text.match(/限额将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})\s*重置/);
  return {
    code: codeMatch ? codeMatch[1] : null,
    retryAfterSec: retryMatch ? Number(retryMatch[1]) : null,
    resetAt: resetMatch ? resetMatch[1] : null,
  };
}

/* ---------- 派发总开关已在文件前部（第一道闸）检查过，这里不再重复 ---------- */

/* ---------- 执行 ---------- */
const args = ['-p', prompt];
if (opt.target) {
  args.length = 0;
  args.push('--target', opt.target);
}
if (opt.resume) args.push('--resume', opt.resume);
if (opt.memoryBench) {
  if (opt.target || !opt.prompt) {
    console.error('[zcode-run] --memory-bench 仅适用于 --prompt（CLI 限制：需配合 --prompt 使用）');
    process.exit(1);
  }
  args.push('--memory-bench');
}
for (const f of opt.attach) args.push('--attach', isAbsolute(f) ? f : resolve(PROJECT, f));
args.push('--cwd', cwd, '--mode', opt.mode, '--json', '--no-color');

const env = {
  ...process.env,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: BUILTIN,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: modelPath,
};

console.log(`[zcode-run] tag=${tag} mode=${opt.mode} cwd=${cwd}`);
console.log(
  `[zcode-run] provider=${providerId ?? 'personal'}${opt.model ? ` model=${opt.model}` : providerModels.length ? ` models=${providerModels.map((m) => m.id).join('/')}` : ''}` +
    `${providerLabel !== 'personal' && providerId ? ` (${providerLabel})` : ''}`,
);
if (taskPath) console.log(`[zcode-run] task=${taskPath}`);
console.log(`[zcode-run] cli=${CLI}`);
if (opt.resume) console.log(`[zcode-run] resume=${opt.resume}`);

const startedAt = new Date();
const started = Date.now();
const r = spawnSync(process.execPath, [CLI, ...args], {
  cwd,
  env,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  timeout: Math.max(1, opt.timeoutMin) * 60 * 1000,
});
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
/* ZB-117（GLM-5.3 审查 LOW，已核实）：`spawnSync` 的 stdout 超过 `maxBuffer`（64MB）时
 * `r.error.code = ENOBUFS`（**不是** ETIMEDOUT），stdout 被截断 ⇒ 下面解析 JSON 必然失败，
 * 但原先没有任何提示，看起来像"CLI 输出格式变了"。显式识别并给出可读原因。 */
const outputOverflow = r.error?.code === 'ENOBUFS';
if (outputOverflow) {
  console.error(`[zcode-run] 输出超过 maxBuffer（64MB）被截断（ENOBUFS）—— 结果解析可能失败；` +
    '这是 CLI 输出异常膨胀（通常是会话里刷了超大文件/日志），不是任务本身失败');
}
const stdout = r.stdout ?? '';
const stderr = r.stderr ?? '';
writeFileSync(outLog, stdout);
writeFileSync(errLog, stderr);
/* ZB-113（审查 HIGH#6，已核实）：临时配置里含**明文 API Key**，而原先只有这一处清理 ——
 * 它在 spawnSync 正常返回之后才执行；runner 被 SIGTERM/taskkill 强杀时进程直接退出，
 * 这行永远跑不到 ⇒ 明文 Key 的 provider_config.json 残留在 %TEMP%。
 * 现在改为：① tempDir 一创建就注册 exit/SIGINT/SIGTERM 兜底（SIGKILL 无法捕获，属残余风险，
 * 由启动时的陈旧残留清扫兜底）；② 这里保留显式清理（正常路径立刻回收）。
 * 纪律边界（已按产品裁决写进 README/pitfalls）：执行器**可以读取**凭据用于启动官方 CLI，
 * 但禁止记录、打印、外传、长期落盘。 */
if (tempDir) {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* 临时配置清理失败不掩盖结果 */ }
}

/* ---------- 解析结果（stdout 里最后一个顶层 JSON 对象） ---------- */
let result = null;
const trimmed = stdout.trim();
if (trimmed) {
  const start = trimmed.lastIndexOf('\n{');
  for (const candidate of [start >= 0 ? trimmed.slice(start + 1) : trimmed, trimmed]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        result = parsed;
        break;
      }
    } catch {
      /* 继续尝试 */
    }
  }
}
if (result) writeFileSync(resultFile, JSON.stringify(result, null, 2));

/* ---------- 从 CLI 日志按 traceId 反查实际 provider/model/端点（结果 JSON 不含这些字段） ---------- */
const actual = (() => {
  const fallback = { provider: providerId ?? 'personal', model: opt.model ?? null, baseURL: null };
  if (!result?.traceId) return fallback;
  const localDay = (d) => {
    const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return x.toISOString().slice(0, 10);
  };
  const days = new Set([localDay(startedAt), localDay(new Date())]);
  for (const day of days) {
    const logFile = join(HOME_ZCODE, 'cli', 'log', `zcode-${day}.jsonl`);
    if (!existsSync(logFile)) continue;
    try {
      const text = readFileSync(logFile, 'utf8');
      const idx = text.indexOf(`"traceId":"${result.traceId}"`);
      if (idx < 0) continue;
      const seg = text.slice(idx, idx + 40000);
      return {
        provider: /"providerId":"([^"]+)"/.exec(seg)?.[1] ?? fallback.provider,
        model: /"modelId":"([^"]+)"/.exec(seg)?.[1] ?? fallback.model,
        baseURL: /"baseURL":"([^"]+)"/.exec(seg)?.[1] ?? null,
      };
    } catch { /* 日志读取失败不影响主流程 */ }
  }
  return fallback;
})();

const code = timedOut ? 124 : (r.status ?? 1);
const usage = result?.usage ?? {};
const projection = result?.projection ?? {};
const ctxPct =
  projection.contextUsed && projection.contextWindow
    ? ` (${((projection.contextUsed / projection.contextWindow) * 100).toFixed(1)}% of ${projection.contextWindow})`
    : '';

console.log(
  `[zcode-run] done exit=${code}${timedOut ? ' (超时)' : ''} elapsed=${elapsed}s` +
    (r.signal ? ` signal=${r.signal}` : '') +
    (result?.sessionId ? ` session=${result.sessionId}` : '') +
    (actual.provider ? ` provider=${actual.provider}` : '') +
    (actual.model ? ` model=${actual.model}` : '') +
    (result?.response ? ` responseChars=${String(result.response).length}` : ''),
);
/* 静默死亡诊断（Z6-01 实证：CLI 无任何输出即 exit 1，事后无法归因）：
   无 stdout/stderr 且非 0 退出 → 明确标注，并给出可查线索（进程信号、CLI 侧日志、内存） */
if (!stdout.trim() && !stderr.trim() && code !== 0) {
  console.error(
    `[zcode-run] 诊断：CLI 静默退出（stdout/stderr 均为空，exit=${code}${r.signal ? `, signal=${r.signal}` : ''}）。` +
      '常见原因：上下文/内存打满、进程被外部终止、启动期崩溃。' +
      '可查：~/.zcode/cli/log/zcode-<date>.jsonl 尾部事件（turn.failed / shutdown.completed）与 Windows 事件日志。',
  );
}
if (actual.baseURL) console.log(`[zcode-run] endpoint=${actual.baseURL}`);
/* 套餐额度撞顶诊断（T20 实证，2026-10-01）：
   Coding Plan 有 5 小时滚动窗口上限，撞顶时 CLI 以 exit 1 结束，stderr 里带
   HTTP 429 + `[1308] 已达到 5 小时的使用上限` + `retry-after: <秒>`。
   若不识别，调用方无法区分「任务真失败」与「额度耗尽」，会误判为代码问题并盲目重试。 */
const rateLimit = detectRateLimit(stderr);
if (rateLimit) {
  const waitHint = rateLimit.retryAfterSec
    ? `约 ${Math.ceil(rateLimit.retryAfterSec / 60)} 分钟后（retry-after=${rateLimit.retryAfterSec}s）`
    : '窗口重置后';
  const resetHint = rateLimit.resetAt ? `（${rateLimit.resetAt} 重置）` : '';
  console.error(
    `[zcode-run] 诊断：套餐额度撞顶（HTTP 429${rateLimit.code ? ` code=${rateLimit.code}` : ''}）——` +
      `Coding Plan 5 小时滚动窗口已满，${waitHint}${resetHint}可重试。` +
      '这**不是**任务包或代码问题；请勿立即重试（会继续消耗并失败）。' +
      `原始信息见 ${errLog}`,
  );
}
if (result?.usage) {
  console.log(
    `[zcode-run] usage requests=${usage.modelRequestCount ?? '-'} in=${usage.inputTokens ?? '-'} out=${usage.outputTokens ?? '-'} cacheRead=${usage.cacheReadTokens ?? '-'}`,
  );
}
if (projection.contextUsed) {
  console.log(`[zcode-run] context used=${projection.contextUsed}${ctxPct} turnCount=${projection.turnCount ?? '-'}`);
}
console.log(`[zcode-run] out=${outLog}`);
console.log(`[zcode-run] err=${errLog}`);
if (result) console.log(`[zcode-run] result=${resultFile}`);
if (timedOut) console.error(`[zcode-run] 超时（${opt.timeoutMin}min）已终止；stderr 尾部见 ${errLog}`);

/* ---------- 用量台账（每次 run 一行，便于统计与排期） ---------- */
if (opt.ledger) {
  try {
    appendFileSync(
      join(LOGS, 'dispatch-runs.jsonl'),
      JSON.stringify({
        at: startedAt.toISOString(),
        tag,
        task: taskPath ? taskPath.replace(`${PROJECT}\\`, '').replace(/\\/g, '/') : null,
        mode: opt.mode,
        kind: opt.target ? 'target' : opt.resume ? 'resume' : 'prompt',
        billing: providerId ? 'zcode-plan' : 'personal-api-key',
        provider: actual.provider,
        endpoint: actual.baseURL,
        model: actual.model,
        sessionId: result?.sessionId ?? null,
        traceId: result?.traceId ?? null,
        exit: code,
        timedOut,
        signal: r.signal ?? null,
        silentExit: !stdout.trim() && !stderr.trim() && code !== 0,
        rateLimited: rateLimit ? true : null,
        retryAfterSec: rateLimit?.retryAfterSec ?? null,
        elapsedSec: Number(elapsed),
        requests: usage.modelRequestCount ?? null,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        cacheReadTokens: usage.cacheReadTokens ?? null,
        contextUsed: projection.contextUsed ?? null,
        contextWindow: projection.contextWindow ?? null,
        responseChars: result?.response ? String(result.response).length : null,
      }) + '\n',
    );
  } catch { /* 台账写入失败不影响主流程 */ }
}

process.exit(code);
