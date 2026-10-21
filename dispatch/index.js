/**
 * dsh-dispatch —— Host 半边（cordis bundle 的 Host 入口）。
 *
 * 职责：按 config 创建 Z1 派发核心单例（core/dispatch-core.mjs，勿改），注册卸载清理
 * （杀子进程 + 落状态 + 释放 wire），并把「派发台操作」以 agent 工具 `dispatch`
 * 暴露给 agent —— 工具与 UI 悬浮窗共用 wire.host.mjs 的 createActionHandler 单实现
 * （references/user-actions.md「一个操作两个调用方」）。
 *
 * 说明两点（creator 会话如遇激活/注册问题按此排查）：
 * 1. Config 是 Standard Schema v1——cordis 的 resolveConfig 只认 Config['~standard'].validate，
 *    裸 JSON Schema 会在激活时抛「Cannot read properties of undefined (reading 'validate')」。
 *    首选宿主随包出货的 schemastery（官方插件同款）；解析不到时降级为 fallbackConfig() 的
 *    手写 Standard Schema，激活永不因 schema 崩。字段与默认值不变。
 * 2. agent 工具走官方契约注册：ctx.tools.register(defineTool({...}))（证据：refs/dsh-tools/
 *    tool-fs-example/index.js:261 注册调用、:1176 inject=['tools','fs','systemPrompt']、
 *    :1212 export；defineTool 契约：refs/dsh-tools/lib/index.js:838）。defineTool 经动态
 *    import 解析（与 loadConfig 同款降级），宿主缺包或 ctx.tools 不可用时只 warn 不抛——
 *    激活安全第一，UI 与派发核心不受影响。
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDispatcher } from './core/dispatch-core.mjs';
import { applyOwnerAction, createSettleNotifier, decodeOwnerAction } from './notify.mjs';
import { ACTIONS as HOST_ACTIONS, DEFAULT_SWITCH_PATH, attachHostWire, createActionHandler, readSwitch, switchFileOf } from './wire.host.mjs';

/** 本文件所在目录（激活信标的兜底落点；config.workRoot 缺席时用）。 */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 配置字段的**唯一事实源**（ZB-26，审计 A2）：默认值 / 归一则 / 描述都在这里一处声明，
 * `DEFAULTS`、降级 Standard Schema、schemastery schema 三处全部由它派生。
 * 原先三套各写一遍（默认值散落三处、归一则只存在于降级路径），已经漂移过。
 */
const FIELDS = [
  { name: 'demo', type: 'boolean', def: false, desc: 'UI 演示模式：客户端用内置假数据渲染悬浮窗，不触达 dispatcher' },
  { name: 'maxConcurrent', type: 'number', def: 3, min: 1, max: 8, desc: '同时运行的 run 上限（单写者互斥语义下的并发度）' },
  { name: 'maxConcurrentOpenCode', type: 'number', def: 2, min: 1, max: 8, desc: 'OpenCode 引擎的**独立**并发上限（与 ZCode 分开计数；**实测依据**：同一时刻并发的 opencode 进程会让 `opencode run` 零输出 exit 1（观测于 1.19.2），故默认 2、不建议调高；免费层另有按 IP 限流）；maxConcurrent 仍是全局上限（实际并发 = min(两者)）' },
  /* ZB-79（2026-10-20 实测纠正）：原先 `maxConcurrentQoder` 在 core 里**硬编码默认 1**，
   * 且**没有**这个配置字段 ⇒ 用户**无法调高**，Qoder 通道永远单进程。
   * 旧注释给的理由（"额度有限 / 并发 CLI 会互相干扰"）是**猜测，没实测过**。
   * 真机对照实测（2026-10-20）：同时起 3 个 / 5 个 `qoderclicn` 进程，**3/3、5/5 全部 exit=0**
   * 且结果正确（耗时 10–20s，无明显劣化）⇒ **Qoder 可以并发**。
   * 故默认提到 3（与全局默认一致），并**补上配置字段**让用户可自行调整。 */
  { name: 'maxConcurrentQoder', type: 'number', def: 3, min: 1, max: 8, desc: 'Qoder 引擎的**独立**并发上限（与其它引擎分开计数）；**实测依据**：同时起 3/5 个 qoderclicn 进程全部 exit=0 且结果正确（2026-10-20 实测，旧默认 1 的依据是猜测且从未实测）⇒ 默认 3；maxConcurrent 仍是全局上限（实际并发 = min(两者)）' },
  /* ZB-84（2026-10-21）：WorkBuddy / CodeBuddy 引擎接入。
   * ⚠️ 并发默认 2 是**保守默认**、**不是实测结论**（接入时 CLI 未登录，无法跑并发对照）；
   * 依据是它比纯 CLI 重（Electron 客户端内置 bundle + daemon-supervisor + Sandbox）。
   * 用户实测后可自行调高 —— teaching 里已如实标注依据强弱。 */
  { name: 'maxConcurrentCodebuddy', type: 'number', def: 2, min: 1, max: 8, desc: 'WorkBuddy/CodeBuddy 引擎的**独立**并发上限（与其它引擎分开计数）；默认 2 是**保守默认**（未做并发实测：该 CLI 是 Electron 客户端内置 bundle，比纯 CLI 重）；用户可自行调高；maxConcurrent 仍是全局上限（实际并发 = min(两者)）' },
  { name: 'runnerPath', type: 'string', def: '', desc: 'runner 脚本绝对路径（通用工具仓库 dispatch/collab-kit/zcode-run.mjs，只读使用）；留空则不创建 dispatcher' },
  { name: 'opencodeRunnerPath', type: 'string', def: '', desc: 'OpenCode 执行器脚本绝对路径（<本仓库>/collab-kit/opencode-run.mjs，只读使用，兼作 --list-models / --version 只读探测）；留空则用默认推断（env DSP_OPENCODE_RUNNER → 仓库内 collab-kit/opencode-run.mjs）' },
  { name: 'codebuddyRunnerPath', type: 'string', def: '', desc: 'WorkBuddy/CodeBuddy 执行器脚本绝对路径（<本仓库>/collab-kit/codebuddy-run.mjs，只读使用，兼作 --list-models / --version 只读探测）；留空则用默认推断（env DSP_CODEBUDDY_RUNNER → 仓库内 collab-kit/codebuddy-run.mjs）' },
  { name: 'ledgerPath', type: 'string', def: '', desc: '台账 dispatch-runs.jsonl 绝对路径；留空则跳过台账回读与用量聚合' },
  { name: 'workRoot', type: 'string', def: '', desc: '派发器工作根目录（locks/、state/jobs.json、logs/ 落在这里）；留空则不创建 dispatcher' },
  { name: 'runnerCwd', type: 'string', def: '', desc: 'runner 子进程工作目录（通常设为宿主项目根，如 F:\\My Code\\keysion dac vue）；留空 = 用 DSH 进程 cwd' },
  { name: 'switchPath', type: 'string', def: DEFAULT_SWITCH_PATH, desc: '派发总开关真值文件绝对路径（宿主仓库 collab/dispatch.switch.json，契约见其 PROTOCOL.md §7）；文件缺失/损坏视为开启；留空则开关不可写' },
  { name: 'notifyOnSettle', type: 'boolean', def: true, desc: 'ZB-22：任务落地（done/failed/killed/interrupted/paused）时自动唤醒发起会话（空闲=开新一轮，忙碌=注入下一步），与 DSH 后台任务同款；false=只派发不唤醒' },
  { name: 'maxConsecutiveWakes', type: 'number', def: 0, min: 0, desc: 'ZB-22：用户没说话期间允许的连续唤醒次数上限；0=不限；超出后改为注入（等用户说话后预算清零）' },
  { name: 'systemPromptHint', type: 'boolean', def: true, desc: 'ZB-22：向 system prompt 注入「派发台优先于 DSH 自带 subagent」提示段；false=不注入' },
];

/** 插件 config 默认值（从 FIELDS 派生，勿单独维护）。 */
const DEFAULTS = Object.fromEntries(FIELDS.map((f) => [f.name, f.def]));

/** 归一化过程中收集到的问题（供日志与激活信标；ZB-26 起不再让插件因此不激活）。
 *  ⚠️ ZB-63（F7）：这是**模块级**数组，而插件可能被 apply 多次（热重载 / 宿主重挂）——
 *  每次 validate 开头复位（`resetConfigIssues`）、每次 apply 取走并清空（见 apply 里的说明），
 *  否则上一轮的配置问题会被记进本次激活信标，误导"当前配置有问题"。 */
const CONFIG_ISSUES = [];
/** 复位配置问题账本（每次 validate 的开始调用：一次校验的问题只属于这一次校验）。 */
function resetConfigIssues() {
  CONFIG_ISSUES.length = 0;
}

/**
 * 唯一归一则（ZB-26，审计 A2）：**任何非法值都取安全默认 + 记录问题**，绝不抛、绝不返回 issues。
 *
 * 为什么要改：原先主路走 cordis 的严格校验 —— `validate` 一旦有 issues，cordis `resolveConfig`
 * 直接 `throw ValidationError`（cordis/lib/index.js:958-960），fiber 变 INACTIVE ⇒ **整个插件不激活**
 * （面板、工具、dispatcher 全没了，只留日志里一行 error）。实测 `maxConcurrent: 0` 就能触发；
 * 而 `maxConsecutiveWakes: 2.5` 反而被静默当成"不限"（真机上上游对非整数上限是显式抛错的）。
 * 现在两条路径共用这里 ⇒ 语义一致，且失效可观测（warn + 激活信标 configIssues）。
 */
function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    CONFIG_ISSUES.push(`config 不是对象（${typeof raw}）：已按默认值处理`);
  }
  const out = {};
  for (const f of FIELDS) {
    const v = src[f.name];
    if (v === undefined) { out[f.name] = f.def; continue; }
    if (f.type === 'boolean') {
      if (typeof v === 'boolean') out[f.name] = v;
      else { out[f.name] = f.def; CONFIG_ISSUES.push(`${f.name} 期望布尔，收到 ${JSON.stringify(v)} → 用默认 ${f.def}`); }
      continue;
    }
    if (f.type === 'number') {
      const n = typeof v === 'number' ? v : Number(v);
      if (typeof v !== 'number' || !Number.isFinite(n)) {
        out[f.name] = f.def;
        CONFIG_ISSUES.push(`${f.name} 期望数字，收到 ${JSON.stringify(v)} → 用默认 ${f.def}`);
        continue;
      }
      let x = n;
      if (f.min != null && x < f.min) { x = f.min; CONFIG_ISSUES.push(`${f.name}=${n} 小于下限 ${f.min} → 取 ${f.min}`); }
      if (f.max != null && x > f.max) { x = f.max; CONFIG_ISSUES.push(`${f.name}=${n} 超过上限 ${f.max} → 取 ${f.max}`); }
      if (f.name === 'maxConsecutiveWakes' && !Number.isInteger(x)) {
        x = Math.floor(x);
        CONFIG_ISSUES.push(`${f.name}=${n} 非整数 → 取 ${x}`);
      }
      out[f.name] = x;
      continue;
    }
    if (typeof v === 'string') out[f.name] = v;
    else { out[f.name] = f.def; CONFIG_ISSUES.push(`${f.name} 期望字符串，收到 ${JSON.stringify(v)} → 用默认 ''`); }
  }
  const unknown = Object.keys(src).filter((k) => !FIELDS.some((f) => f.name === k));
  if (unknown.length) CONFIG_ISSUES.push(`忽略未知字段：${unknown.join(', ')}`);
  return out;
}

/**
 * 无依赖降级：手写 Standard Schema v1（cordis 只认 Config['~standard'].validate）。
 * 与主路**共用** normalizeConfig ⇒ 两条路径语义一致（这正是 A2 的修法核心）。
 * ⚠️ DSH 判「原生 schema」是结构判定（`isNativeConfigSchema`：schemastery 品牌 + type + meta），
 * 本降级形态在 DSH 里会被判 `unsupported`，故它只是**非 DSH 宿主**的兜底，不是等价替代。
 */
function fallbackConfig() {
  return {
    '~standard': {
      version: 1,
      vendor: 'dispatch',
      validate(raw) { resetConfigIssues(); return { value: normalizeConfig(raw) }; },
    },
  };
}

/** 首选官方形态（schemastery 即 Standard Schema v1，官方插件同款）；解析不到时降级。 */
async function loadConfig() {
  try {
    const { default: z } = await import('@deepseek-ai/schemastery');
    const build = {
      boolean: (f) => z.boolean().default(f.def),
      number: (f) => {
        let s = z.number();
        if (f.min != null) s = s.min(f.min);
        if (f.max != null) s = s.max(f.max);
        return s.default(f.def);
      },
      string: (f) => z.string().default(f.def),
    };
    const shape = {};
    for (const f of FIELDS) shape[f.name] = build[f.type](f).description(f.desc);
    const schema = z.object(shape);
    /* ZB-26：**保留 schemastery 实例本身**（品牌/type/meta/图/设置页投影全不受影响），
     * 只把 `~standard` 影子成「永不返回 issues」的版本 —— 校验失败改为 warn + 安全默认，插件照常激活。
     * 注意不要新建包装对象：`isNativeConfigSchema` 是结构判定，换对象有被判 unsupported 的风险。 */
    const original = schema['~standard'];
    Object.defineProperty(schema, '~standard', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: {
        version: 1,
        vendor: 'schemastery+lenient',
        validate(raw) {
          /* ZB-63（F7）：本次校验的问题只属于本次校验 —— 先复位，避免上一轮（或上一次 apply）
           * 的残留混进本次的议题清单。 */
          resetConfigIssues();
          try {
            const r = original && typeof original.validate === 'function' ? original.validate(raw) : null;
            if (r && !r.issues) return r;
            for (const issue of (r && r.issues) || []) CONFIG_ISSUES.push(String(issue && issue.message ? issue.message : issue));
          } catch (e) {
            CONFIG_ISSUES.push(`schema 校验抛错：${e && e.message ? e.message : e}`);
          }
          return { value: normalizeConfig(raw) };
        },
      },
    });
    return schema;
  } catch {
    return fallbackConfig();
  }
}

/** 插件 config schema（Standard Schema v1；cordis resolveConfig 经 Config['~standard'].validate 取值）。
 * ZB-26：主路是 schemastery 实例（保留品牌/type/meta，DSH 判原生），但其 `~standard` 已被影子成
 * 「非法值不返回 issues、改 warn + 安全默认」的版本 —— 见上方 loadConfig 里的说明。 */
export const Config = await loadConfig();

/* ─────────────── 官方 defineTool 的解析（ZB-01：裸 import 在本包必然失败）───────────────
 * 事实（2026-09-30 实测 + asar 头解析，见 tasks/ZB-01-delivery.md）：
 *   - 本包位于 F:\My Code\dsh-dispatch，**不在 DSH 安装目录内**；profile 的 node_modules 只有
 *     @local / dsh-plugin-whale-pet，**没有 @deepseek-ai 作用域**；
 *   - 故裸 import('@deepseek-ai/dsh-tools') 从本文件向上逐级找 node_modules 必然
 *     ERR_MODULE_NOT_FOUND → loadDefineTool() 返回 null → 工具静默不注册（Z13 现场症状）；
 *   - 反例（真实可用的第三方插件）：refs/plugin-whale-pet/lib_index.js 的宿主半边
 *     **完全不 import 任何 @deepseek-ai/***（只用注入的 agents 服务）——第三方目录下裸 import 无先例。
 * 修法：裸 import 之后追加「绝对路径回退」（env 覆盖 → process.resourcesPath 推导 → 硬编码安装路径），
 * 每个候选先试 ESM import()、再试 CJS require()（Node 24 支持 require(esm)；asar 的 fs 补丁对两者
 * 都生效，双策略让「asar 内 ESM 装载」这一不确定性有兜底）。全失败再降级 null——激活安全第一。
 * 路径证据：asar 头 JSON 解析确认 dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js 存在
 * （157954 字节，与 refs/dsh-tools/lib/index.js 同尺寸）。 */
const DSH_TOOLS_REL = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'];

/** 绝对路径候选表（顺序即优先级；source 仅用于信标/日志，不参与逻辑）。 */
function dshToolsCandidates() {
  const out = [];
  const env = process.env.DSP_DSH_TOOLS;
  if (typeof env === 'string' && env) out.push({ source: 'env:DSP_DSH_TOOLS', path: env });
  const res = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (res) {
    out.push({ source: 'resourcesPath/app.asar', path: join(res, 'app.asar', ...DSH_TOOLS_REL) });
    out.push({ source: 'resourcesPath/app.asar.unpacked', path: join(res, 'app.asar.unpacked', ...DSH_TOOLS_REL) });
  }
  out.push({ source: 'abs:D:/DeepSeek/resources/app.asar', path: join('D:/DeepSeek/resources/app.asar', ...DSH_TOOLS_REL) });
  out.push({ source: 'abs:D:/DeepSeek/resources/app.asar.unpacked', path: join('D:/DeepSeek/resources/app.asar.unpacked', ...DSH_TOOLS_REL) });
  /* ZB-60（兼容性加固，DSH 0.2.1 更新前）：上面所有候选都假设 asar 内多一层 `dsh/` 目录
   * （实测 `app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`）。
   * 若新版把 asar 结构重排（去掉或多一层），这条链会**全部落空** ⇒ agent 的 `dispatch` 工具不注册。
   * 故补两个**不带 `dsh/` 前缀**的同构候选 —— 排在已有候选**之后**，
   * 正常情况行为完全不变（前面已命中），只在结构变化时提供一条生路。 */
  const res2 = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (res2) {
    const rel2 = DSH_TOOLS_REL.slice(1); // 去掉首段 'dsh'
    out.push({ source: 'resourcesPath/app.asar(无 dsh 层)', path: join(res2, 'app.asar', ...rel2) });
    out.push({ source: 'resourcesPath/app.asar.unpacked(无 dsh 层)', path: join(res2, 'app.asar.unpacked', ...rel2) });
  }
  return out;
}

/** 解析尝试记录（写进激活信标；任何时刻只追加，绝不抛）。 */
const DEFINE_TOOL_PROBE = [];
const probeErr = (e) => (e && e.code ? `${e.code}: ${e.message}` : String((e && e.message) || e));
const accept = (mod) => (mod && typeof mod.defineTool === 'function' ? mod.defineTool : null);

/**
 * 官方工具定义器：随 dsh 出货的 @deepseek-ai/dsh-tools（包导出面见 refs/dsh-tools/lib/index.js:3714，
 * defineTool 实现同文件 :838）。解析不到时降级 null——模块照常加载、激活不受影响。
 * @returns {Promise<{defineTool: Function|null, source: string|null}>}
 */
async function loadDefineTool() {
  try {
    const fn = accept(await import('@deepseek-ai/dsh-tools'));
    if (fn) {
      DEFINE_TOOL_PROBE.push({ source: 'bare', strategy: 'import', ok: true });
      return { defineTool: fn, source: 'bare|import' };
    }
    DEFINE_TOOL_PROBE.push({ source: 'bare', strategy: 'import', ok: false, error: '导入成功但无 defineTool 导出' });
  } catch (e) {
    DEFINE_TOOL_PROBE.push({ source: 'bare', strategy: 'import', ok: false, error: probeErr(e) });
  }
  const require = createRequire(import.meta.url);
  for (const cand of dshToolsCandidates()) {
    try {
      const fn = accept(await import(pathToFileURL(cand.path).href));
      if (fn) {
        DEFINE_TOOL_PROBE.push({ source: cand.source, strategy: 'import', ok: true, path: cand.path });
        return { defineTool: fn, source: `${cand.source}|import` };
      }
      DEFINE_TOOL_PROBE.push({ source: cand.source, strategy: 'import', ok: false, path: cand.path, error: '导入成功但无 defineTool 导出' });
    } catch (e) {
      DEFINE_TOOL_PROBE.push({ source: cand.source, strategy: 'import', ok: false, path: cand.path, error: probeErr(e) });
    }
    try {
      const fn = accept(require(cand.path));
      if (fn) {
        DEFINE_TOOL_PROBE.push({ source: cand.source, strategy: 'require', ok: true, path: cand.path });
        return { defineTool: fn, source: `${cand.source}|require` };
      }
      DEFINE_TOOL_PROBE.push({ source: cand.source, strategy: 'require', ok: false, path: cand.path, error: '加载成功但无 defineTool 导出' });
    } catch (e) {
      DEFINE_TOOL_PROBE.push({ source: cand.source, strategy: 'require', ok: false, path: cand.path, error: probeErr(e) });
    }
  }
  return { defineTool: null, source: null };
}
const DEFINE_TOOL_RESOLVED = await loadDefineTool();
const defineTool = DEFINE_TOOL_RESOLVED.defineTool;
const DEFINE_TOOL_SOURCE = DEFINE_TOOL_RESOLVED.source;

/**
 * 激活信标：把「defineTool 是否解析到 / 工具是否注册 / 远端面是否注册」落成一个 JSON 文件，
 * 供重启后一眼定位（ZB-01 §2.1）。路径 = config.workRoot/state/activation.json
 * （默认即 dispatch/.data/state/activation.json）；写失败**绝不抛**。
 *
 * ZB-22：改为**与已有内容合并**（原来整文件覆盖）。原因：唤醒能力要靠 ctx.inject 异步
 * 拿到 agents 服务后才成立，那一刻已是 apply 之后——只覆盖就写不进「唤醒是否真的启用」，
 * 而这条恰恰是排障时最需要一眼看到的。`at` 记录最后一次写入时间。
 */
function beaconFile(config) {
  const root = config && typeof config.workRoot === 'string' && config.workRoot ? config.workRoot : join(PLUGIN_DIR, '.data');
  return join(root, 'state', 'activation.json');
}
function writeActivationBeacon(config, patch) {
  try {
    const file = beaconFile(config);
    mkdirSync(dirname(file), { recursive: true });
    let prev = {};
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') prev = parsed;
    } catch { /* 首次写入 / 文件损坏：从空对象起步 */ }
    writeFileSync(file, `${JSON.stringify({ ...prev, at: new Date().toISOString(), name: 'dispatch', ...patch }, null, 2)}\n`, 'utf8');
  } catch { /* 信标只是诊断，写不了不影响激活 */ }
}
/** 工具注册失败原因（供信标；不改变 registerDispatchTool 的返回值语义）。 */
let TOOL_REGISTER_ERROR = null;

/** cordis 插件名（loader 诊断用；官方插件同款导出，refs/dsh-tools/tool-fs-example/index.js:1174）。 */
export const name = 'dispatch';

/** 依赖的宿主服务：tools 由 dsh 基础 bundle 提供（同款：tool-fs-example/index.js:1176 inject 含 'tools'）。 */
export const inject = ['tools'];

/* ZB-25：动作清单**从 wire.host.mjs 取唯一源**（动作实现在那里，清单不该有第二个副本）。
 * 原先是本地字面量复制，与 switch 分支、报错串三处手抄 —— ZB-08 加 wait 时已漂移过一次。 */
const ACTIONS = HOST_ACTIONS;

/**
 * 工具参数 spec（@deepseek-ai/dsh-tools 官方 DSL，非 JSON Schema）：逐字段 {type, required?, description?}，
 * 由 parameterSchemaSpecToJsonSchema 编译（refs/dsh-tools/lib/index.js:802）。DSL 词汇=注解+
 * required:true+type 专属键（enum/const/items/properties/additionalProperties）——数字范围类
 * 约束（timeoutMin>0、n≥1）无对应键，写进 description 由 execute 侧语义兜底。
 * 字段与 createActionHandler 实际入参一一对应（实现与 schema 不漂移；action 必填，其余可选）。
 */
const TOOL_PARAMETERS = {
  action: { type: 'string', required: true, enum: ACTIONS, description: '操作类型' },
  enabled: { type: 'boolean', description: 'switch：目标状态（true=开启派发 / false=关闭派发，写入真值文件）' },
  by: { type: 'string', description: 'switch：操作者标识（写入 updatedAt/updatedBy，缺省 ui/tool）' },
  note: { type: 'string', description: 'switch：切换原因备注（写入 note）' },
  kind: { type: 'string', enum: ['prompt', 'task', 'target'], description: 'dispatch：派发类型（prompt=完整指令 / target=目标描述，ZCode 自续跑直到达成 / task=任务包文件绝对路径）' },
  prompt: { type: 'string', description: 'dispatch(kind=prompt)：发给 ZCode 的提示词' },
  task: { type: 'string', description: 'dispatch(kind=task)：任务文件绝对路径' },
  target: { type: 'string', description: 'dispatch(kind=target)：目标描述' },
  /* ZB-37（真机事故修复）：`model` / `provider` **不能用 enum** —— 与上面 thinking 同一条纪律：
   * 合法取值随账号/清单变（模型：GLM-5.3 系 / deepseek-flash / …；通道：plan / personal /
   * `builtin:*` / **`account:<family>-start-plan`（免费额度）**），权威来源是 `action=channels`。
   * 事故现场（2026-10-11，keysion 会话）：agent 按教学读 channels 后想设免费额度通道为默认，
   * 却撞上 `invalid arguments: "provider" must be one of ["plan","personal"]` ⇒ 被迫用 `plan`
   * （付费套餐，5h 窗口已满）⇒ 三个作业全部 429 ⇒ 它转而用后台 pwsh 直跑 runner 绕过派发台。 */
  model: { type: 'string', description: 'dispatch：模型（如 GLM-5.3 / GLM-5.3-Flash / deepseek-flash；实际可用值以 action=channels 清单为准，其它模型经 action=channel 设默认后使用）' },
  provider: { type: 'string', description: 'dispatch：通道 id。**通常不要传** —— 不传 = 用用户在面板 / `action=channel` 选定的默认通道（推荐做法）；只有确实要临时换通道时才传。可用值：`plan` 套餐 / `personal` 个人 Key / `account:<family>-start-plan` 免费额度 / **OpenCode 免费模型通道 id 形如 `opencode/deepseek-v4.1-flash-free`、Qoder 通道形如 `qoder/Qwen3.8-Max`、WorkBuddy 通道形如 `codebuddy/glm-5.1`（清单以 `action=channels` 为准）** / 清单里任意真实 id。传入的通道若"最近撞过额度"，派发会**自动改派**到你选定的可用通道并在返回里说明（`redirectedFrom`）' },
  /* 引擎（ZCode / OpenCode / Qoder / WorkBuddy）：`engine` 同样**不用 enum** —— 与 model/provider 同一条纪律
   * （ZB-37 真机事故：enum 会挡住清单里枚举外的真实取值），权威来源是 action=channels 的
   * channels[].engine。通常也不必传：provider 传 `opencode/<model>` / `qoder/<model>` /
   * `codebuddy/<model>` 会被 core 自动识别
   * （ZB-63 修：原 desc 只写两引擎，Qoder 通道会让 agent 以为没有这个引擎；
   *  ZB-84 同理补 WorkBuddy —— 描述里漏掉某个引擎，会让 agent 以为它不存在，从而弃用）。 */
  engine: { type: 'string', description: 'dispatch：执行引擎（`zcode` | `opencode` | `qoder` | `codebuddy`）。**通常不用传** —— 传 `provider: "opencode/<model>"` / `qoder/<model>` / `codebuddy/<model>` 即自动识别为对应引擎；权威来源是 action=channels 返回的 `channels[].engine`（不用 enum 限制：合法值随清单/版本变，加入新引擎不必改 schema）。注意 `codebuddy` 走 WorkBuddy 官方 CLI，**需要 CLI 单独登录一次**（与桌面应用登录态独立），未登录会停在 `not-logged-in` 暂停态' },
  /* ZB-45 / ZB-63：`auto` = **显式**放行引擎未显式拒绝的权限（默认关，安全默认）。
   * ⚠️ ZB-63 修：core 的 validateSpec 已放宽到 opencode **与 qoder**（两者都有等价旗标：
   * `--auto` / `--permission-mode bypass_permissions`），原 desc 只写 opencode 是事实错误。
   * 不是 enum/字符串：布尔字段，避免"看起来开了其实没开"的静默失真。 */
  auto: { type: 'boolean', description: 'dispatch：**显式**放行引擎未显式拒绝的权限（OpenCode ⇒ `--auto`；Qoder ⇒ `--permission-mode bypass_permissions`）。默认 `false` = 不放行（安全默认）；**仅对 `engine=opencode` / `engine=qoder` 有意义**（对 zcode 传 true 会被可读报错拒绝）。开启后 job 上可审计（`autoApproved`），且**跨 retry 沿用**同一放行级别（可传 `auto:false` 显式关掉）' },
  mode: { type: 'string', enum: ['build', 'edit', 'plan', 'yolo'], description: 'dispatch：ZCode 运行模式，默认 edit' },
  /* ZB-29：思考强度。不用 enum —— 合法档位随模型声明不同（ZB-31 实测：GLM-5.3 系 low|high|max，
   * deepseek 系 disabled|low|high|max），以 channels[].thinkingLevels 为准；语义详述在描述正文。
   * ZB-29d：不传 thinking = 按通道默认思考强度（channel.reasoningLevel，action=channel 可设，未设置=agent）。 */
  thinking: { type: 'string', description: 'dispatch：思考强度（Thought Level）。`agent`=Agent决定（默认）：由你根据任务改传具体档位；**不传 = 按通道默认思考强度执行**（action=channel 可设，未设置即 agent）。档位集合见 action=channels 返回的 thinkingLevels。仅对新建会话生效' },
  timeoutMin: { type: 'number', description: 'dispatch：超时分钟（必须 > 0，无上限；runner 生效下限 1 分钟）' },
  memoryBench: { type: 'boolean', description: 'dispatch：附加 --memory-bench（仅 kind=prompt 支持）' },
  tag: { type: 'string', description: 'dispatch：台账 tag（缺省由 runner 生成）' },
  lock: { type: 'string', enum: ['repo', 'none'], description: 'dispatch：仓库写锁。repo（默认）= 锁仓库；none = 明确不取锁。**锁哪些文件用 write 指定**（memory/both 已于 ZB-16 删除）' },
  cwd: { type: 'string', description: 'dispatch：runner 工作目录' },
  resume: { type: 'string', description: 'dispatch：要续跑的 sessionId' },
  /* ZB-08/16：**仓库锁的粒度**。声明 ⇒ 只锁这些文件（不同文件集可并发 —— 这正是用户要的）；
   * 不声明 ⇒ 锁整个仓库（粗粒度；单写者纪律本义）。 */
  write: {
    type: 'array',
    items: { type: 'string' },
    description: 'dispatch：该任务预计会写入的文件绝对路径列表（声明后按文件级加锁，不冲突即可并发；不声明则锁整个仓库）',
  },
  id: { type: 'string', description: 'kill/tail/retry：job id（形如 j-xxxx）' },
  n: { type: 'integer', description: 'tail：行数（≥ 1，默认 30，上限 200）' },
  /* ZB-61：list 的**有界 + 紧凑**开关（默认紧凑、默认 50 条）。
   * 背景：宿主会把超预算的工具结果从中间截断（spill），旧形状 96 条 job = 212 KB ⇒
   * 模型只看到首尾两段，中间的 job 直接读不到。紧凑形状保留 id/state/model/tag/lockWait 等
   * 「挑下一个动作」必需字段，实测同数据 25.5 KB。 */
  limit: { type: 'integer', description: 'list：最多回多少条 job（默认 50，上限 200；按 running→queued→paused→终态、同状态内新→旧排序）。省略的条数会写在返回的 note 里' },
  full: { type: 'boolean', description: 'list：true = 旧完整形状（含每条 job 的派发原文 spec.body、progress、usage、lockPaths）。默认 false = 紧凑形状（更省上下文，且不会被宿主截断）；两种形状都受 limit 约束' },
  retryModel: { type: 'string', description: 'retry：目标模型（同通道续跑时不允许传——--resume 带 --model 必失败）' },
  /* ZB-30：降级目标 = 有序数组；元素为通道 id 字符串（工具 schema 只允许字符串数组——
   * 对象形状留给面板/CLI 经 face.setFallbackChain 直传）。单目标 = provider + model + thinking。 */
  chain: { type: 'array', items: { type: 'string' }, description: 'fallback：降级目标通道 id 数组（有序，空数组/null=关闭）。单目标也可直接传 provider（+model/thinking）' },
  /* ZB-82：分流模式（用户要求）。与 fallback 的区别：fallback 是"主通道**失败**才换"，
   * split 是"主通道**名额将满**就把新任务摊到降级通道"—— 目的不同（一个是容错，一个是提并发）。 */
  minFreeSlots: { type: 'number', description: 'split：主通道剩余名额低于这个数就分流（1..8，默认 1=满员才分流；2=还剩 1 个名额就开始摊开）' },
};

const TOOL_DESCRIPTION_BODY = [
  '- action=dispatch：派发一个 run。**立即返回**，不等任务跑完（返回时 state 通常是 queued）。拿结果有两条路：等**落地自动唤醒**（见下条，推荐），或主动 action=wait / action=tail。kind 判据：**prompt=完整指令**（一次性问答/明确步骤）；**target=目标描述**（只说"要达成什么"，ZCode 自主规划并自续跑直到达成，适合无人值守委托；与 prompt/task 互斥是 CLI 限制）；**task=任务包文件绝对路径**（含交付物/验收标准的正式任务，由 runner 读文件内联）。必须带对应内容字段 prompt|task|target。可选：model（GLM-5.3 / GLM-5.3-Flash）、provider（plan=套餐通道 / personal=个人 Key）、mode（build|edit|plan|yolo，默认 edit）、**thinking（思考强度，见下方专条）**、timeoutMin（正数分钟，无上限；runner 生效下限 1 分钟）、memoryBench（true 附加 --memory-bench，仅 kind=prompt）、**auto（true = 显式放行引擎未显式拒绝的权限；默认 false，仅 engine=opencode/qoder）**、tag、lock（repo|none，默认 repo）、**write（本任务要写的文件列表 —— 锁的粒度就是它）**、cwd、resume。**三引擎（ZCode + OpenCode + Qoder）**：`provider: "opencode/<model>"`（如 `opencode/deepseek-v4.1-flash-free`）或 `qoder/<model>`（如 `qoder/Qwen3.8-Max`）即派给**本地真实**对应引擎进程（各自免费/自带额度模型，不伪装身份、**不读写用户自己的引擎配置与数据**）；也可显式传 `engine`，但通常不必——core 按 `opencode/<model>` / `qoder/<model>` 通道 id 自动识别。OpenCode / Qoder **不支持** `mode` / `memoryBench`（传了会被拒，返回可读报错）。**权限放行**：OpenCode / Qoder 的工具调用可能需要审批 —— 派发台默认**不**放行（安全默认，绝不自作主张开 `--auto` / `bypass_permissions`）；确需放行时用显式 **`auto: true`**（仅对 engine=opencode/qoder 有意义，开启后 job.autoApproved 可审计、且跨 retry 沿用）。总开关关闭时被拒绝（返回 ok:false + switch 状态），不创建 job。',
  /* ZB-22：落地自动唤醒 —— 这是「派发台能不能像 DSH 后台任务一样用」的关键。
   * 现场症状：派发后会话不等待、直接往下走/结束，任务跑完没人叫醒它，用户得自己再发一句。 */
  '- **落地自动唤醒（默认开）**：dispatch/retry 建出的 job 一旦落地（done / failed / killed / interrupted / **paused**），**发起它的会话会被自动唤醒**并收到一条通知——会话空闲就开新一轮，会话正忙就插进下一步（与 DSH 后台任务同款）。因此派发之后**不要轮询、不要 sleep**：继续做别的独立步骤，或直接结束本轮即可；收到「dispatch」通知后再用 action=tail / action=list 读结果。你自己 action=kill 掉的、或自己 action=wait 已经读到的 job 不会再发通知（避免自己叫醒自己）。配置 notifyOnSettle=false 可关掉唤醒。',
  /* ZB-16：锁模型（本轮重设计）。
   * 仓库锁的**粒度由 write 决定**：声明 write ⇒ 只锁那些文件（不同文件集可并发）；
   * 不声明 ⇒ 锁整个仓库（粗粒度）。memory 锁已删除。 */
  '- **锁与并发**：并发数 = min(配置 maxConcurrent, 锁闸)。锁闸按**文件集**判定：**声明 write 的任务只锁它要写的文件** —— 不同文件集可并发，写同一文件（或与"整仓库锁"重叠）才排队。**不声明 write ⇒ 锁整个仓库**，与其它任务互斥。想让多个任务真正并发，就为每个任务声明它要写的文件。lock=none 表示明确不取锁（确认无竞写关系时用）。',
  '- **记忆写入（默认约束）**：派发时**默认注入提示词**，要求子代理不执行 ZCode 记忆写入/自动 Memory 提取（不写 ~/.zcode）。三种 kind 全覆盖：prompt/target 直接拼进内容（job.memoryBanApplied=true）；task 由宿主 runner 经 `--memory-ban` 旗标注入（runner 打印 memory-ban=on 后 job.memoryBanRunner=true = 确认注入；旧版 runner 不认识该旗标会 fail-fast 报"未知参数"，请成对升级 runner）。',
  /* ZB-28：paused 与超时语义（全部触发条件 + 超时终态 + 字段名）。 */
  /* ZB-29：思考强度（Thinking Level / reasoningLevel）。核心是「Agent决定」契约：
   * agent 档 = 调用方 Agent 自己判断任务并改传具体档位；未改传时按 ZCode 默认规则解析成实际档位并显式注入。
   * ⚠️ ZB-75：job 上可核对 `reasoningLevel`（请求档）与 `reasoningLevelApplied`（实际生效档），
   * 但 **Qoder 的 `reasoningLevelApplied` 只是请求值回显**（引擎不回报实际档位）⇒
   * 必须看 `thinkingObserved` / `thinkingMismatch`（ZB-75 派发后核对，见下条）。 */
  '- **思考强度（thinking，默认 agent=「Agent决定」）**：传 `agent` 时，**由你（调用方）根据本任务自行判断并改传具体档位**——判断准则：探索/查询/机械修改/短问答 ⇒ 低档（GLM-5.3 系用 `low`，deepseek 系可用 `disabled`）；多步实现、架构改动、疑难排查、长链规划 ⇒ 高档（`high`/`max`）。判断完成后**传具体档位，不要传 agent**；保持 agent 时按 **ZCode 默认规则**执行（= 该模型档位集的最后一档：GLM-5.3 系 ⇒ `max`、deepseek 系 ⇒ `max`），runner 会解析并**显式注入**——进程上显示的就是实际生效档位，而不是「Agent决定」字样。规则：① 合法档位**随模型声明不同**（ZB-31 实测：GLM-5.3/Flash：`low|high|max`；deepseek 系：`disabled|low|high|max`），以 action=channels 返回的 `channels[].thinkingLevels` 为准（`thinkingLevelsScope` = `model`（逐模型精确）/ `engine`（引擎级并集，非逐模型精确））；② 非法档位会被 runner 按 builtin 声明 fail-fast 拒绝（报错列出可用值），不会静默降级；③ 档位仅对**新建会话**生效，`--resume` 续跑沿用原会话档位（runner 警告并忽略）；④ **不传 thinking ⇒ 按通道默认思考强度执行**（`action=channel` 可设通道默认：`agent`=Agent决定 或具体档位——**这就是给派发 Agent 的规定**；未设置即 agent）。**OpenCode 通道**：同一套 `thinking` 参数映射为 OpenCode 的 **`--variant`**（OpenCode 把思考档位叫 variant，模型相关，如 `high`/`max`/`minimal`）；档位同样以 `channels[].thinkingLevels` 为准（缺失 = 未探测到，传 `agent` 即可，不要猜枚举）。**Qoder 通道**：同一套 `thinking` 参数映射为 Qoder 的 **`--reasoning-effort`**；Qoder 的档位是**逐模型声明**（`Qwen3.8-Flash`=low|medium|xhigh，`DeepSeek-Flash`=low|high|max；未声明的模型退回引擎级并集 `auto|none|low|medium|high|xhigh|max|ultracode`）。',
  /* ZB-75（用户教学要求）：**派发后核对档位 + 不符则向上改档重试**。 */
  '- **★ 派发后核对思考档位（Qoder 必做；用户明确要求）**：Qoder 引擎**不回报实际生效档位**（`reasoningLevelApplied` 只是请求值回显），故"设了极高、实际却变成关闭思考"这类**静默降级**只能靠观测。判据（唯一信号 = assistant 的 `thinking` 内容块有无，真机实测：`none` 恒 0 块、其余档位恒有块）：job 上的 **`thinkingObserved`**（`thinking` / `silent`）与 **`thinkingMismatch`**（不符时非 null，含 `{requested, observed, blocks, suggested}`）。**你要做的**：任务落地后若 `thinkingMismatch` 非 null（= 请求要思考、实际 `silent`），**优先向上改档位重试** —— 取 `thinkingMismatch.suggested`（该模型支持的、比当前**更强的最近一档**；`null` = 已是最强档或拿不到支持集，此时别瞎试），用 `action=retry { id, reasoningLevel:<suggested> }` 重发。**注意**：① 档位不符**不代表任务失败**（任务可能已成功，只是档位没生效），是否重试由你按任务重要性决定；② 请求本就是 `none`/`disabled`（不思考）或 `agent` 时**不算不符**（不会报）；③ 非 Qoder 引擎无此观测字段 ⇒ 无法核对（≠ 通过）。',
  '- **多任务并发：用降级通道分流（用户明确要求）**：每条通道**各自计并发名额**（Qoder 默认 3、OpenCode 默认 2、全局默认 3），超出的任务会**排队等名额**。**两种用法**：① **手动分流** —— 把多出来的任务**直接派给降级通道那条**（显式传 `provider`）；② **自动分流（分流模式，推荐）** —— `action=split { enabled:true, minFreeSlots? }`：主通道**剩余名额**低于 `minFreeSlots`（默认 1 = 满员）时，**新任务自动改派到降级通道**（须与主通道**不同**才有意义），于是两条通道的名额**叠加**（例：主 Qoder 3 + 降级 OpenCode 2 ⇒ 实际并发 5）。要点：**分流只在调用方未显式指定通道时生效**（显式指定 ⇒ 尊重你的选择，绝不偷改）；被分流的 job 带 `splitFrom` / `splitReason` 可核对；**目标也满 ⇒ 老实排队**（不硬塞）；`action=split`（无参）读状态，返回 `active`/`reason`/`main.free` 等实时判据。⚠️ 降级链**不会**因"主通道满"自动分流 —— 那是**分流模式**的职责（两者是不同机制：降级=容错，分流=提并发）。并发上限见 `action=channels` 的 `engineDetail` / snapshot 的 `engineLimits`。',

  '- **paused 与超时**：run 非 0 退出（非 kill）且输出命中暂停签名 → paused（签名按优先级：plan-not-entitled → provider-signing → config-error → quota-exhausted；字段 pauseReason/pauseDetail/pausedAt）；未命中保持 failed（pauseReason=unknown 仅作信息）；paused 不占锁不占并发，需人决定 retry 续跑或换通道。timeoutMin 无上限（>0）：**runner 自身超时 → failed**（exit 124，timedOut=true、timedOutBy=runner）；**dispatcher 看门狗在 timeoutMin+120s 宽限后仍未退出 → killed**（timedOutBy=watchdog，watchdogSec=开火秒数）；interrupted 与超时无关（仅 dispatcher 重启时的残留清理）。',
  '- action=wait：等待 job 落到终态或 paused（id 必填，timeoutSec 可选，缺省取该任务 timeoutMin 的秒数）。paused 也返回（不干等，让调用方决定 retry 续跑还是换通道交接）；超时返回 timedOut:true 与当前状态，不谎报完成。**已经 wait 到落地的 job 不再发落地通知**（结果你已拿到）。',
  '- action=list：列出 run（running→queued→paused→终态，同状态内新→旧）。**默认紧凑形状 + 默认最多 50 条**（`limit` 可调到 200）：每条只给 id/state/tag/kind/engine/model/provider/时间/elapsedSec/exitCode/responseChars/contextRatio/turnCount/tailCount/stage/lastTool，外加 `total` 与 `counts`（按状态计数）；**省略的条数写在 `note` 里**（不静默截断）。要用旧完整形状（含每条 job 的派发原文 `spec.body`、progress、usage、lockPaths）加 `full=true`。**紧凑是刻意的**：完整形状在多历史 job 时会达到数百 KB，宿主 spill 策略会从**中间**截断它 —— 那时你反而读不到中间的 job。**queued 行带 lockWait（ZB-28 排队可观测）**：position=队列位次、ahead/aheadIds=前方同类任务、blockers=被谁挡住（锁名+持有者+已运行秒+剩余上界）、estWaitSec=预计等待上界（仅当阻塞者都声明 timeoutMin 时可估，否则 null 不猜）——被整仓锁挡住时不再盲等。单条输出永远用 action=tail。',
  '- action=kill：按 id 终止。queued 直接移除；running 发终止信号后落 killed。**自己 kill 的 job 不发落地通知**。',
  '- action=dismiss：把 paused/终态 job 从列表移除（queued/running 必须先 kill）。',
  '- action=tail：按 id 取最近输出，参数 n 默认 30（上限 200）。',
  '- action=quota：台账用量聚合（5 小时滚动 / 本周 / 今日）+ 引擎本周已用（app-server usage/stats；limit/remaining/resetAt 不在该 RPC 面）；另附 `giftQuota` = **免费额度（Start Plan）剩余量**（只读 ZCode 客户端日志，零新请求；状态含 state/totalUnits/remainingUnits/startsAt/endsAt/observedAt）。',
  '- action=status：读 派发总开关状态（返回 switch={enabled, updatedAt, updatedBy, note, source}；文件缺失/损坏=开启）。',
  '- action=switch：切换派发总开关（enabled 必填布尔；by=操作者、note=原因可选）。原子写真值文件（与 CLI dispatch-switch.mjs 同一格式）；关闭后所有派发入口（zcode-run.mjs / 本工具 dispatch|retry / 面板 / bridge.mjs）一律拒绝。任何会话都可通过 status 查到最新状态。',
  '- action=channels：通道清单（含 enabled/原因/端点/模型；解析失败返回空数组+warnings，不猜）。**这份实时清单是通道可用性与真实 id 的唯一权威**；每个通道附 `thinkingLevels`（该通道各模型的思考强度合法档位，随模型声明不同；缺失 = 旧 runner 未探测，档位传 agent 即可）。**免费额度通道（id 形如 `account:<family>-start-plan`）另带 `quota` + `quotaText`（例：「剩余 231.4M / 300M（77%）· 窗口 10-10 23:00 → 10-12 09:00 · 剩 32.0 小时」）；顶层还有 `giftQuotaText`。** **每个通道带 `engine`（`zcode` / `opencode` / `qoder`）**，顶层 `engines` 字段列出当前可用引擎。**OpenCode / Qoder 的模型清单是「探测式」的**（每次跑对应执行器的 `--list-models` 真实结果），**不要写死枚举**（否则重演 ZB-31「档位表变了但代码写死」的坑）；某个引擎探测失败时**只有它自己**的通道为空（如 OpenCode 通道为空、ZCode/Qoder 通道照常），如实返回 warnings 不猜。',
  '- **派发前的额度决策（重要）**：把任务派给免费额度通道前，先 `action=channels`（或 `action=quota`）看 `quotaText` / `giftQuota`：① state=active 且剩余充足 ⇒ 正常派发；② 剩余很少、或「剩 X 小时」已接近窗口结束 ⇒ **拆小任务 / 先讲清优先级**，避免跑到一半窗口关闭（那会以 `paused / quota-exhausted` 停下，需 `retry` 续跑）；③ state=pending/expired 或 ok:false ⇒ 该通道当下不可用，改用付费套餐或 `personal` 通道。**派发后也可用 `action=quota` 复核剩余量**，据此决定是否再派下一单。',
  '- action=channel：读默认通道（无参）或设置（provider 必带，**接受 channels 清单里的任意 id**，model 可选，**thinking 可设通道默认思考强度：`agent`=Agent决定 或具体档位——未显式传 thinking 的派发一律按它执行，这就是给派发 Agent 的规定**）——之后未显式指定通道/思考强度的 dispatch 都用它。要派发到清单里**枚举之外**的通道（如 `builtin:…` 真实 id），走这里设默认通道，再不带 provider/model 派发即可。',
  '- action=retry：续跑/交接已落地的 job（**选择判据：job 还在派发台里 → 用 retry；手里只有裸 sessionId（job 已不在或来自派发台之外）→ 用 dispatch + resume**）。retry 内部自动判定：同通道且有 sessionId → --resume 续跑（不要传 retryModel：--resume 带 --model 必失败）；换通道（或无 sessionId）→ 交接重跑（新会话+交接提示词），新 job 带 parentJobId/attempts/hopCount。可用 provider / retryModel（或 model）。总开关关闭时同样被拒绝。',
  '- action=fallback：读降级设置（无参）或设置目标。**目标 = 有序数组**：`chain` 传通道 id 数组（每个目标可另用 `provider` + `model` + `thinking` 设**单目标**，与面板开关同形；`chain: []` 或 `chain: null` = 关闭）。开启后额度耗尽/未开通/需签名会自动交接重跑到下一个可用目标（会消耗下游通道额度）。目标的 model/thinking 与面板一致：留空/`""` ⇒ 该 provider 默认模型；`agent` ⇒ runner 按 ZCode 默认规则解析；**`null`（工具/CLI 侧）⇒ 沿用原任务**（thinking 具体档位对该次交接硬性生效，仅新建会话）。**ZCode / OpenCode / Qoder 通道可在同一条降级链里混排（跨引擎降级）；换引擎＝新会话，不会尝试 resume 原引擎的 session。**',
  '限制：仓库写锁互斥（同锁排队、不报错；**文件锁任务优先放行**，同类内保持 FIFO）；memoryBench 仅 kind=prompt；timeoutMin 必须 >0（无上限）；model/provider 的 schema 枚举只是常用别名（可能被宿主强制）——**通道取值以 action=channels 实时清单为准**，枚举外通道经 action=channel 设默认后使用；本工具不授予或确认任何权限。',
].join('\n');

/**
 * 工具描述：首段说清**什么时候必须用本工具**（模型选工具的唯一依据就是这段文字）+
 * 显式排除 DSH 自带 subagent/jobs；末段动态携带开关当前状态（注册时按 readSwitch() 生成一次；
 * 运行中状态以 action=status 的实时返回为准）。
 *
 * ZB-02（用户现场报告「新会话里让它派发 zcode，走的还是 DSH 后台，不在派发台里」）：
 * 旧首行是「操作「DSH 派发台」：把任务派发给 ZCode 子代理（当前：已开启）。action=status 查开关状态；…」，
 * 有两处硬伤：① 首行把动作重心放在 status/switch 上，读起来像状态管理工具而非派发入口；
 * ② 用了「子代理」一词，与 DSH 自带 `subagent`（Delegate a self-contained task to a subagent）
 * 概念直接撞车——模型看到「派发/子代理」就顺手调了 subagent，任务于是跑在 DSH 后台、不产生派发台 job。
 * 现改为：触发条件先讲、「ZCode 无头进程」替代「子代理」、并点名禁止替代品。
 */
function buildToolDescription(switchFile) {
  const sw = readSwitch(switchFile);
  const state = sw.enabled ? '已开启' : '已关闭';
  return [
    '【派发优先级：能用派发台就优先用派发台】**凡是"要另一个 agent 去做"的活，默认走本工具** —— 不必等用户说出"派发"二字。触发词（用户说「派发给 ZCode / 让 ZCode 做 / 用 ZCode 跑 / zcode 派发 / 在派发台派一个」，或笼统说「派发这个任务」）只是**最明显的一类**；同样该主动用的是这几条**判据**：① 任务**自包含**且能**独立完成**（调研、写一个小项目、跑一段验证、多步骤实现）；② 会**跑很久**（几十秒以上）或**要反复试错**；③ 想**并行**推进多件互不相干的活；④ 用户提到**别的引擎/模型**（ZCode / OpenCode / Qoder / 某个具体模型）或问"能不能派给别人做"。**命中任一条 ⇒ 直接用**（并一句话说明你派了什么）。只有本工具才会在「DSH 派发台」面板里生成一个可监视的 job（独立进程、独立额度与会话，可查输出/终止/续跑/换通道）。',
    '⚠️ **要调 `subagent` 之前先停一下**：如果你正打算用 DSH 自带的 subagent / spawn_teammate / subagent_fork / 后台 jobs，先问一句"这算不算上面四条判据" —— 算，就改用派发台（自带手段在面板里**看不见**，额度也不分账）。✅ **仅当派发台不可用时**才退回自带手段：即 action=status 显示开关已关闭、dispatch 返回 ok:false（未配置 runner/workRoot、锁冲突等），或用户明确要求「你自己（DSH）去做」。此时要**说明为什么没用派发台**，不要静默切换。',
    /* ZB-37：真机事故（2026-10-11）逼出来的两条硬规则 —— 写进工具描述，让下一次不再走歪。 */
    '🚫 **不要用 `pwsh` / `Bash` 直接跑 `collab-kit/zcode-run.mjs`（或用 `run_in_background` 承载它）**：那会**绕过派发台**——丢 单写者文件锁、用量台账/额度分账、面板可见性、暂停分类与降级链。派发台的 job **落地时同样会自动唤醒**发起会话（与 DSH 后台任务同款），所以「想被唤醒」不是绕过的理由。',
    '🔁 **额度撞顶（dispatch 后 job 变 `paused / quota-exhausted`，如 Coding Plan 的 5 小时窗口满）时怎么办**：(1) 先 `action=channels` 看清单——**免费额度通道**（`account:<family>-start-plan`）常常仍可用，并带 `quotaText`（剩余/窗口剩余时间）；(2) **换通道派发**：`action=dispatch` 直接传 `provider: "<通道 id>"`（接受清单里任意 id，不再受枚举限制），或 `action=channel {provider}` 设默认通道再派；(3) 或 `action=fallback {chain:["<备用通道 id>"]}` 开降级链后 `action=retry {id}` 自动交接；(4) **不要**因为付费通道撞限额就改用后台 jobs 直跑 runner。',
    '🎯 **`provider` 默认不要传**：不传 = 用**用户在面板 / `action=channel` 选定的默认通道**（这是推荐做法，也是用户的意图）。只有**确实要临时换通道**时才传。若要传，先 `action=channels` 看该通道是否带 `recentQuotaExhausted`；即使你传了"已撞顶"的通道，派发也会**自动改派**到用户选定的可用通道（返回里带 `redirectedFrom` + `warning`），所以不用自己先试探再回退。',
    '💰 **派发前先看额度**：`action=channels` 的 `channels[].quotaText` / 顶层 `giftQuotaText` 给出免费额度剩余与窗口剩余时间；`action=quota` 另给 `giftQuota` 结构化字段。剩余很少或窗口将尽时**拆小任务**，别让长任务跑到窗口关闭（那会 `paused / quota-exhausted`）。',
    `当前派发总开关：${state}（实时状态用 action=status）。action=switch 切换开关；action=list/tail 监视；与页面右下角悬浮窗是同一套操作（一操作两调用方）。`,
  ].join('\n') + `\n${TOOL_DESCRIPTION_BODY}`;
}

/**
 * 注册 agent 工具（官方契约：refs/dsh-tools/tool-fs-example/index.js:261
 * ctx.tools.register(defineTool({ name, description, parameters, output, execute }))；
 * ctx.tools 由 inject=['tools'] 从宿主取得）。
 * 激活安全：ctx.tools 不可用、defineTool 未解析（宿主缺包）、注册抛错——一律
 * log warn + 返回 null，UI 与派发核心不受影响。
 * @param {object} ctx cordis Context
 * @param {(level: string, msg: string) => void} log
 * @param {(action: string, params: object) => Promise<object>} handleAction
 * @param {string} switchFile 开关真值文件（工具描述首行的注册时快照用）
 * @param {object} [hooks] ZB-22 落地唤醒钩子：{ notifier: {current}, log }
 * @returns {(() => void)|null} 注销函数（若注册成功），否则 null
 */
function registerDispatchTool(ctx, log, handleAction, switchFile, hooks = {}) {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    TOOL_REGISTER_ERROR = 'ctx.tools.register 不可用（inject=[\'tools\'] 未满足？）';
    log('warn', 'ctx.tools.register 不可用：agent 工具 dispatch 未注册（非致命，UI 与派发核心不受影响）');
    return null;
  }
  if (typeof defineTool !== 'function') {
    TOOL_REGISTER_ERROR = '@deepseek-ai/dsh-tools 未解析（defineTool 为 null；候选见激活信标 defineToolAttempts）';
    log('warn', '@deepseek-ai/dsh-tools 不可用（defineTool 未解析）：agent 工具 dispatch 未注册（非致命，UI 与派发核心不受影响）');
    return null;
  }
  TOOL_REGISTER_ERROR = null;
  try {
    const registered = ctx.tools.register(defineTool({
      name: 'dispatch',
      description: buildToolDescription(switchFile),
      parameters: TOOL_PARAMETERS,
      // output 不可省略：defineTool 无条件读 options.output.render/.schema（refs/dsh-tools/lib/index.js:842/:849）。
      // schema 用 DSL 最小合法形态 {type:'json'}（:688 注解即无约束 JSON，execute 的任意 JSON 返回值都合法）。
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const params = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        /* ZB-25（审计 A#1，实测复现）+ ZB-63（M6）：kill 的抑制必须**先登记、后调用** ——
         * core 的 kill() 对 queued job 会就地置 killed 并**同步** emit 'job-updated'，订阅者在
         * 那一刻就投递通知；等 handleAction 返回再登记已经晚了（排队中的 job 仍会被"自己叫醒
         * 自己"一次，且失败无声）。顺序知识现在归**账本所有者**（notify.mjs 的 beforeAction），
         * 这里只留两次转发；kill 失败的回滚也由 notifier 在 noteAction 里自己做。 */
        try { hooks?.notifier?.current?.beforeAction?.(params); } catch { /* 簿记失败不影响工具 */ }
        const result = await handleAction(params.action, params);
        /* ZB-22：把这次动作翻译成唤醒簿记。execute 的第二个参数 exec 带发起会话
         * （exec.agent.id）——这是「谁派发的、落地后叫醒谁」的唯一来源。簿记失败绝不影响工具结果。 */
        noteOwnerAction(hooks, params, result, exec);
        return JSON.stringify(result); // 工具结果统一回 JSON 字符串，调用方自行解析
      },
    }));
    log('info', 'agent 工具 dispatch 已注册（官方 ctx.tools.register + defineTool）');
    return () => {
      try {
        if (typeof registered === 'function') {
          registered();
          return;
        }
      } catch { /* 已注销 */ }
      for (const m of ['remove', 'unregister', 'undefine', 'dispose']) {
        try {
          if (typeof ctx.tools?.[m] === 'function') {
            ctx.tools[m]('dispatch');
            return;
          }
        } catch { /* 尝试下一个 */ }
      }
    };
  } catch (e) {
    TOOL_REGISTER_ERROR = `defineTool/register 抛错：${e?.message ?? e}`;
    log('warn', `agent 工具 dispatch 注册失败：${e?.message ?? e}（非致命，UI 与派发核心不受影响）`);
    return null;
  }
}

/**
 * ZB-22：把一次工具动作翻译成唤醒簿记。
 *
 * ZB-63（M6）：**决策表已收进 notify.mjs**（`decodeOwnerAction` / `applyOwnerAction`，
 * 账本唯一所有者），这里只是**薄转发** —— 导出名与签名保持不变（notify.test.mjs / 
 * wake-integration.test.mjs 钉住），所以它可以被当作旧接口继续用。
 * 兼容面：接收方只暴露 `track` / `markKilled` / `markAwaited` 的桩同样工作
 * （`unmarkSuppressed` 缺失时回滚跳过，不抛）。
 *
 * 只有**真正的派发**（dispatch / retry 成功）才登记 job→会话 的归属；其余动作只做抑制：
 *   · kill 成功   ⇒ 模型自己终止的 job 不必再叫醒它（等价 dsh-tool-jobs 的 killedByModel）；
 *   · wait 到落地 ⇒ 结果已由本次工具调用返回，不必再发通知（等价其 event.awaited）；
 *   · wait 超时   ⇒ **不**抑制（job 仍在跑，落地时应当唤醒）。
 * 所有异常一律吞掉：簿记是增强，绝不能影响工具返回。
 *
 * @param {object} hooks { notifier: {current}, log }
 * @param {object} params 工具入参（含 action / id）
 * @param {object} result handleAction 的返回信封
 * @param {object} exec 官方工具执行上下文（exec.agent.id = 发起会话）
 */
export function noteOwnerAction(hooks, params, result, exec) {
  try {
    const notifier = hooks?.notifier?.current;
    if (!notifier) return;
    applyOwnerAction(notifier, decodeOwnerAction(params, result, exec));
  } catch (e) {
    try { hooks?.log?.('warn', `落地唤醒簿记失败（action=${params?.action}）：${e?.message ?? e}`); } catch { /* 日志失败也不影响 */ }
  }
}

function makeLogger(ctx) {
  return (level, msg) => {
    try {
      const logger = ctx?.logger;
      if (logger && typeof logger[level] === 'function') logger[level](`[dispatch] ${msg}`);
      else console[level === 'info' ? 'log' : level === 'warn' ? 'warn' : 'error'](`[dispatch] ${msg}`);
    } catch { /* 日志失败不影响主流程 */ }
  };
}

/**
 * ZB-22 / ZB-77：注入 system prompt 的「派发台」提示段。
 *
 * 现场症状「派发台开着，但 agent 很少主动用」的根因：旧文案只在用户说出**魔法词**
 * （"派发 / 交给 ZCode / 让 ZCode 做"）时才触发 —— 而真实竞争是**模型的默认习惯**：
 * 它一遇到"独立子任务"就顺手用 DSH 自带的 `subagent`（系统提示里已有的熟路），
 * 于是派发台**再开着也不会被想起来**。
 *
 * ZB-77 强化（用户要求「派发台开着时，很好有主动使用的」）：
 *  ① **从"被叫才用"改成"该用就用"**：给出**判据**（什么情况属于该派发），而不是只列触发词；
 *  ② **正面点出竞争对象**：明确"要用 subagent 时，先问一句该不该走派发台"；
 *  ③ **把理由说清**（面板可监视 / 独立进程与额度 / 落地自动唤醒），让"主动用"有依据；
 *  ④ **保留唯一的硬例外**（用户点名要你自己做 / 开关关闭），否则会变成"无条件优先"而误伤。
 *
 * 位置：与 dsh-tool-jobs 的 `tool:jobs` 段同级，紧跟 TOOL_JOBS（1600+5），排在 TOOL_SUBAGENT 之前 ——
 * 排在竞争对象**之前**，模型读到"独立任务"时会先看到本段。
 * 比工具 description 短：系统提示每轮都占 token，工具清单只在模型看工具时占。
 */
const SYSTEM_PROMPT_SECTION = [
  '【DSH 派发台 · 优先使用】本会话**装着派发台插件**（面板「DSH 派发台」）。**凡是"要另一个 agent 去做"的活，默认走它** —— 不要顺手用 DSH 自带的 subagent / spawn_teammate / subagent_fork / 后台 jobs：那些在面板里**看不见**，而派发台会生成**可监视的 job**（独立进程、独立额度与会话、落地自动唤醒本会话）。',
  '**什么时候该主动用（判据，不必等用户说"派发"）**：① 任务**自包含**且能**独立完成**（调研、写一个小项目、跑一段验证、多步骤实现）；② 会**跑很久**（几十秒以上）或**要反复试错**；③ 想**并行**推进多件互不相干的活；④ 用户提到**别的引擎/模型**（ZCode / OpenCode / Qoder / 某个具体模型），或问"能不能派给别人做"。**命中任一条 ⇒ 直接用**，并**一句话说明**你派了什么（用户可随时叫停）。',
  '**要派发时的第一反应**：如果你正打算调 `subagent`，**先停一下**问自己"这算不算上面那四条" —— 算，就改用派发台；不算（极短、需要你亲自边做边判断、或结果你要立刻接着用于本会话推理），才用自带手段。',
  '派发是 fire-and-forget：**不要**轮询、不要 sleep。job 落地（done / failed / killed / interrupted / paused）时本会话会被**自动唤醒**并收到一条 dispatch 通知，届时用 action=tail / action=list 读结果。多个独立任务可**一起派**（各自 provider 不冲突时并行）。',
  '派发参数 thinking（思考强度）默认 agent=由你按任务判断：简单查询/机械修改传 disabled，复杂推理/架构任务传 enabled（档位集合见 action=channels 的 thinkingLevels）——判断后传具体档位；不传 thinking 则按通道默认思考强度执行（action=channel 可设；通道设 Agent决定=由你按任务自行决定）。',
  'OpenCode 通道（本地真实 OpenCode 进程 + 免费模型）同样走派发台：`provider: "opencode/<model>"`（清单见 action=channels 的 `channels[].engine`）；额度撞顶时换通道/开降级链，**不要**绕过派发台直接跑 CLI。Qoder 通道（本地真实 Qoder CLI）同形：`provider: "qoder/<model>"`（如 `qoder/Qwen3.8-Max`，清单同样以 action=channels 为准）。**Qoder 需要联网/跑任意命令的任务要传 `auto: true`**（默认模式只保证工作区内写文件；不传 auto 时网络会被权限拦下）。',
  '例外：用户明确要你自己做，或 action=status 显示开关已关闭 / dispatch 返回 ok:false —— 这时按工具说明退回 DSH 自带手段，并说明原因。**除这两种情况外，默认优先派发台。**',
].join('\n');

/**
 * Host 入口。返回 { dispatcher, wire, handleAction, notifier } 便于测试与 creator 调试
 * （notifier 是 ZB-22 落地唤醒器的持有者，供集成测试与排障读取；插件外无需依赖它）。
 * @param {object} ctx cordis Context
 * @param {object} config 已校验的插件 config（见 Config）
 */
export function apply(ctx, config = {}) {
  const log = makeLogger(ctx);

  /* ZB-63（F7）：**取走并清空**配置问题账本 —— 本次 apply 只认本次配置的问题（账本由
   * `Config['~standard'].validate` 在 apply 之前填好；apply 之后不再有新的写入方）。
   * 为什么必须取走：`CONFIG_ISSUES` 是模块级数组，插件热重载/二次 apply 时不清空的话，
   * 上一轮的"非法值已取安全默认"会被记进本次激活信标 —— 用户看到的是**已不存在的配置问题**。 */
  const configIssues = CONFIG_ISSUES.splice(0, CONFIG_ISSUES.length);

  /* ZB-26（审计 A2）：配置兜底不再静默 —— 每一条「非法值已取安全默认」都打 warn，
   * 并整批写进激活信标（configIssues），排障时一眼看到"你写的配置没生效、为什么"。 */
  if (configIssues.length) {
    for (const m of configIssues.slice(0, 10)) log('warn', `config 兜底（已取安全默认）：${m}`);
    if (configIssues.length > 10) log('warn', `config 兜底共 ${configIssues.length} 条，其余见激活信标 configIssues`);
  }

  let dispatcher = null;
  if (config.runnerPath && config.workRoot) {
    /* OpenCode 是**增量能力**：执行器缺失/路径写错都**不**影响 dispatcher 创建与 ZCode 派发
     * （core 的 OpenCode 通道为空、派发 opencode 任务返回可读错误即可）——故这里只 warn 不留痕阻断。 */
    if (config.opencodeRunnerPath && !existsSync(config.opencodeRunnerPath)) {
      log('warn', `opencodeRunnerPath 指向的文件不存在：${config.opencodeRunnerPath}（OpenCode 通道将为空，ZCode 通道不受影响；留空本配置可改用默认推断）`);
    }
    if (config.codebuddyRunnerPath && !existsSync(config.codebuddyRunnerPath)) {
      log('warn', `codebuddyRunnerPath 指向的文件不存在：${config.codebuddyRunnerPath}（CodeBuddy 通道将为空，其它引擎不受影响；留空本配置可改用默认推断）`);
    }
    dispatcher = createDispatcher({
      runnerPath: config.runnerPath,
      ledgerPath: config.ledgerPath || undefined,
      workRoot: config.workRoot,
      maxConcurrent: config.maxConcurrent,
      maxConcurrentOpenCode: config.maxConcurrentOpenCode,
      /* ZB-79：Qoder 独立并发上限**必须在这里透传** —— 否则新加的配置字段是**摆设**
       * （core 会用自己的默认值，用户改配置根本不生效）。 */
      maxConcurrentQoder: config.maxConcurrentQoder,
      /* ZB-84：CodeBuddy 独立并发上限同样**必须透传**（否则新配置字段是摆设，同 ZB-79 的教训）。 */
      maxConcurrentCodebuddy: config.maxConcurrentCodebuddy,
      ...(config.runnerCwd ? { runnerCwd: config.runnerCwd } : {}),
      /* 空串**不传**（而不是传 ''）：core 对「未配置」与「配了但为空」的处理不同 ——
       * 不传 ⇒ core 自行推断（env DSP_OPENCODE_RUNNER → 仓库内 collab-kit/opencode-run.mjs）；
       * 传空串 ⇒ core 认为"配了但没有"，通道为空。 */
      ...(config.opencodeRunnerPath ? { opencodeRunnerPath: config.opencodeRunnerPath } : {}),
      ...(config.codebuddyRunnerPath ? { codebuddyRunnerPath: config.codebuddyRunnerPath } : {}),
    });
    log('info', `dispatcher 就绪：work=${dispatcher.workRoot} maxConcurrent=${config.maxConcurrent ?? 3} maxConcurrentOpenCode=${config.maxConcurrentOpenCode ?? 2} maxConcurrentQoder=${config.maxConcurrentQoder ?? 3} maxConcurrentCodebuddy=${config.maxConcurrentCodebuddy ?? 2}`);
  } else {
    log('warn', '缺少 runnerPath / workRoot 配置，dispatcher 未创建（UI 将进入 demo 降级；工具动作返回可读错误）');
  }

  const handleAction = createActionHandler(dispatcher, config);
  const wire = attachHostWire(ctx, dispatcher, config);

  /* ───────── ZB-22：任务落地自动唤醒（会话不必自己回来轮询）─────────
   * agents 服务**既不写进静态 inject，也不用 ctx.inject 等它就绪**：投递那一刻才解析
   * （`ctx.get('agents')`，cordis 对未注册/未激活的服务返回 undefined 而不抛）。
   * 理由：唤醒是「有就更好」的增强——绝不能让它成不成立取决于服务解析时机是否恰好赶上
   * apply；真机排障只看信标 `wakeActive` / `agentsVisible` 两个字段。
   * 释放复用下方唯一那处 `ctx.effect(disposeAll)`（不再单独注册 effect）。 */
  const notifierHolder = { current: null };
  let wakeNote = null;
  let agentsVisible = null;
  if (dispatcher && config.notifyOnSettle !== false) {
    try {
      agentsVisible = !!ctx?.get?.('agents');
    } catch { agentsVisible = false; } // 解析抛错也只是「现在看不到」，投递时再试
    try {
      const agentsFacade = {
        get: (id) => {
          try { return ctx?.get?.('agents')?.get?.(id); } catch { return undefined; }
        },
      };
      notifierHolder.current = createSettleNotifier({ dispatcher, agents: agentsFacade, ctx, log, config });
      const cap = Number(config.maxConsecutiveWakes) > 0 ? `连续 ${config.maxConsecutiveWakes} 次` : '不限';
      log('info', `任务落地自动唤醒已启用：会话空闲时 followup 唤醒、忙碌时注入下一步（连续唤醒上限：${cap}；agents 服务当前${agentsVisible ? '可见' : '未解析到 —— 投递时再试'}）`);
    } catch (e) {
      wakeNote = `init-failed: ${e?.message ?? e}`;
      log('warn', `任务落地自动唤醒初始化失败：${e?.message ?? e}（派发与 UI 不受影响）`);
    }
  } else if (dispatcher) {
    wakeNote = 'disabled-by-config';
    log('info', '任务落地自动唤醒已关闭（config.notifyOnSettle=false）');
  }

  /* ───────── ZB-22：system prompt 提示段 ─────────
   * 现场症状「新会话的 agent 不太用派发台」的根因是**它压根没被告知**：工具的
   * description 只在模型主动看工具列表时起作用，而 DSH 自带 subagent 是系统提示里
   * 点名推荐过的熟路。这里补一段与 dsh-tool-jobs 的 tool:jobs 段同级的提示，
   * 位置紧跟 TOOL_JOBS 之后（1600+5），排在 TOOL_SUBAGENT 之前。 */
  if (config.systemPromptHint !== false && typeof ctx?.inject === 'function') {
    ctx.inject(['systemPrompt'], (spCtx) => {
      try {
        const base = spCtx.systemPrompt.getSectionOrder?.('TOOL_JOBS');
        spCtx.systemPrompt.section({
          name: 'tool:dispatch',
          order: Number.isFinite(base) ? base + 5 : 1605,
          text: SYSTEM_PROMPT_SECTION,
        });
        log('info', 'system prompt 已注入「DSH 派发台」提示段');
        writeActivationBeacon(config, { systemPromptHintActive: true, systemPromptHintError: null });
      } catch (e) {
        log('warn', `system prompt 注入失败：${e?.message ?? e}（派发与 UI 不受影响）`);
        writeActivationBeacon(config, { systemPromptHintActive: false, systemPromptHintError: e?.message ?? String(e) });
      }
    });
  } else if (config.systemPromptHint === false) {
    writeActivationBeacon(config, { systemPromptHintActive: false, systemPromptHintError: 'disabled-by-config' });
  }

  const disposeTool = registerDispatchTool(ctx, log, handleAction, switchFileOf(config), { notifier: notifierHolder, log });

  /* ZB-01 激活信标（§2.1）：重启后读 .data/state/activation.json 一眼定位
   * 「包没解析到」还是「register 没成功」还是「远端面没注册」。 */
  if (typeof defineTool === 'function') log('info', `defineTool 已解析（来源 ${DEFINE_TOOL_SOURCE}）`);
  else log('warn', `defineTool 未解析；失败候选=${DEFINE_TOOL_PROBE.filter((p) => !p.ok).map((p) => `${p.source}/${p.strategy}`).join(', ')}`);
  writeActivationBeacon(config, {
    dispatcherReady: !!dispatcher,
    workRoot: dispatcher ? dispatcher.workRoot : null,
    switchPath: switchFileOf(config),
    ctxToolsRegisterAvailable: !!(ctx?.tools && typeof ctx.tools.register === 'function'),
    defineToolResolved: typeof defineTool === 'function',
    defineToolSource: DEFINE_TOOL_SOURCE,
    defineToolAttempts: DEFINE_TOOL_PROBE,
    toolRegistered: typeof disposeTool === 'function',
    toolRegisterError: TOOL_REGISTER_ERROR,
    remote: (wire && wire.diagnostics) || null,
    switchEnabled: readSwitch(switchFileOf(config)).enabled,
    // ZB-22：唤醒与提示段的配置快照 + 动态结果
    notifyOnSettle: config.notifyOnSettle !== false,
    maxConsecutiveWakes: Number(config.maxConsecutiveWakes) || 0,
    systemPromptHint: config.systemPromptHint !== false,
    wakeActive: !!notifierHolder.current,
    wakeNote,
    agentsVisible,
    // ZB-26：配置兜底留痕（非法值取了什么安全默认，一目了然）；ZB-63：只反映**本次** apply 的配置
    configIssues: configIssues.slice(0, 20),
    configIssueCount: configIssues.length,
  });

  const disposeAll = () => {
    try {
      disposeTool?.();
    } catch { /* 已注销 */ }
    try {
      notifierHolder.current?.dispose?.();
      notifierHolder.current = null;
    } catch { /* 已释放 */ }
    try {
      wire.dispose?.();
    } catch { /* 已释放 */ }
    if (dispatcher) {
      for (const j of dispatcher.list()) {
        if (j.state === 'running' || j.state === 'queued') {
          try {
            dispatcher.kill(j.id, 'plugin unloading: dispatcher disposed');
          } catch (e) {
            log('warn', `卸载时 kill ${j.id} 失败：${e?.message ?? e}`);
          }
        }
      }
      /* ZB-63（F6）：原先这里还有一行 `dispatcher.dispose?.()` —— core 的 createDispatcher
       * **从来没有** dispose（全仓 grep 无消费者，`?.()` 永远不执行），是纯噪声：
       * 读代码的人会以为卸载时还有一份释放逻辑在跑。真需要的释放（kill 在跑的 job）就在上面。 */
    }
  };
  if (typeof ctx?.effect === 'function') ctx.effect(() => disposeAll);
  else log('warn', 'ctx.effect 不可用：卸载清理未注册（无法在插件卸载时杀子进程/落状态）');
  // 注：卸载时 running job 依赖 child 'close' 事件落终态并持久化；若整个进程直接退出，
  // 下次启动由 dispatcher.restore() 把残留 running/queued 兜底标为 interrupted，状态不悬空。

  return { dispatcher, wire, handleAction, notifier: notifierHolder };
}
