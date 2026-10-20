/**
 * ZCode 派发核心（standalone Node，零 npm 依赖，ESM）。
 *
 * 职责：进程调度 / 单写者互斥（文件锁 + 进程内 FIFO 队列）/ 状态与用量采集 / 状态持久化。
 * 与 DSH 完全解耦：既可被 DSH Host 半边 `apply(ctx, config)` import，也可被 bin/dispatch.mjs 独立驱动。
 *
 * 驱动的 runner 是只读依赖：`<通用工具仓库>/collab-kit/zcode-run.mjs`，其控制台汇总行
 * 形如 `[zcode-run] done exit=0 elapsed=9.7s session=sess_x provider=plan:x model=M responseChars=N`，
 * 结束后按 tag 回读台账 `dispatch-runs.jsonl` 补全字段（stdout 解析与台账取并集，解析失败不崩）。
 *
 * 互斥语义（ZB-16：**删除 memory 锁**，按用户要求）：
 *   spec.lock = 'repo' | 'none'（默认 repo）
 *   · repo ⇒ 仓库写锁。**锁什么由 spec.write 决定**：声明了文件集 ⇒ 只锁那些文件（不同文件可并发）；
 *            未声明 ⇒ 锁整个仓库（粗粒度，单写者纪律本义）
 *   · none ⇒ 不取锁（调用方明确知道无竞写关系时用）
 *   同一时刻：不同文件集的任务可并发；文件集有交集（或任一为"整仓库"）则串行。
 *
 * 为什么删除 memory 锁：它保护的是 ZCode 自己的记忆库（~/.zcode），与仓库写入互不相干；
 * 而 ZCode 记忆写入本身改用**默认注入的提示词禁令**约束（见 buildSpecPrompt），
 * 不再需要一把进程间互斥锁（用户决定：派发任务默认要求子代理不写 ZCode 记忆）。
 *   同一时刻至多一个 run 持有整仓库锁（repo.lock）；文件锁按文件集判定，不同文件集可并发；
 *   请求拿不到锁时进队列等待，**文件锁任务优先放行**（ZB-17），同类内保持 FIFO，不报错。
 *   锁 = 文件锁（跨进程互斥，内容含 jobId/pid/at；过期 >2h 或 pid 已死即清理）
 *      + 进程内队列（同进程公平排队）双保险。
 *
 * 暂停与通道（Z6）：runner 非 0 退出时按输出签名识别暂停原因（quota-exhausted /
 *   plan-not-entitled / provider-signing / config-error），命中即落 `paused` 态——
 *   paused 不占锁、不占并发、不自动重试；未命中签名保持 `failed`（Z1 语义不变），
 *   仅记 pauseReason:'unknown' 作信息字段。
 * 排队可观测（ZB-28）：queued job 在 list/get/snapshot 里带 lockWait —— 被谁挡住
 *   （blockers：锁名/持有者/已运行秒/剩余上界）、前方同类几个（ahead/position）、
 *   预计等待上界（estWaitSec，仅当阻塞者都声明 timeoutMin 时可估，否则 null 不猜）。
 * 超时与禁令字段（ZB-28）：timedOutBy='runner'（--timeout-min 到点 exit 124 → failed）
 *   | 'watchdog'（看门狗 kill → killed）；pausedAt=进入 paused 的时刻；
 *   watchdogSec=看门狗开火秒数；memoryBanRunner=runner 确认已注入记忆禁令
 *   （task 经 runner --memory-ban 旗标，prompt/target 由插件直接拼进内容）。
 * 续跑语义（机制事实 F1/F2：--resume 可不带 --model；--resume+--model 必失败）：
 *   retry(jobId)：同通道且有 sessionId → --resume 续跑，绝不传 --model；
 *   换通道（或无 sessionId）→ 交接重跑：新会话 + buildHandoffPrompt 五要素提示词，
 *   新 job 记 parentJobId/attempts/hopCount，旧 job 标 handedOffTo（同通道续跑标 resumedBy）。
 * 通道：getChannel/setChannel 持久化于 <workRoot>/state/channel.json，dispatch 未显式
 *   指定 provider/model 时采用默认通道；listChannels 解析 runner `--list-providers`
 *   真实输出 + coding-plan-cache.json + 个人 provider 配置，解析不出就返回空数组 +
 *   warnings，绝不猜测通道可用性。
 * 自动降级链（默认关）：setFallbackChain([...]) 后，paused 且原因属
 *   {quota-exhausted, plan-not-entitled, provider-signing} 时自动按 retry 交接语义
 *   跳到链上下一个可用通道，最多 chain.length 跳；链耗尽/一跳失败即停在 paused。
 * 自动降级目标（ZB-30，面板入口）：状态是**有序目标列表** [{provider, model, reasoningLevel}]——
 *   setFallbackTarget({provider, model, reasoningLevel}) 设单个（面板：通道+模型+思考强度，
 *   开启时下面三个下拉与「通道」分区同形），setFallbackTarget(null) = 关闭；
 *   旧入口 setFallbackChain([ids]) 归一成同形列表（model/reasoningLevel=null ⇒ 沿用原任务）。
 *   两者写**同一份状态**（<workRoot>/state/fallback.json，version 2；旧 version 1 的 chain 自动迁移）。
 *   getFallbackChain() 返回 {enabled, chain(旧形状 id 列表), targets, target(首项)}。
 *
 * ── 双引擎（ZB-44）─────────────────────────────────────────────────────────────
 * 本核心只负责**调度**，执行**引擎**可替换。「通道」（channel）这一既有抽象现在携带 engine：
 *   · zcode    → 执行器 `collab-kit/zcode-run.mjs`，行前缀 `[zcode-run]`（既有语义，逐字不变）
 *   · opencode → 执行器 `collab-kit/opencode-run.mjs`，行前缀 `[opencode-run]`（探测与执行同用一个脚本）
 * 行协议（前缀 / 行语法 / 引擎差异字段）的**唯一权威**是 `collab-kit/run-line-protocol.mjs`：
 * core 与各执行器都 import 它，绝不各抄一份 —— 否则会重演 ZB-31「档位表变了但代码写死」的坑。
 * 引擎判据（先显式后推断，绝不猜）：
 *   ① 显式 spec.engine（合法值）② provider 形如 `opencode/<model>` ③ 通道→引擎**快照**
 *   （listChannels 成功时落盘 <workRoot>/state/channels.json —— dispatch/startJob 是**同步**函数，
 *   需要在不能 await 的情况下识别引擎；读不到一律 fail-open 按默认引擎 zcode）
 *   ④ 都不满足 ⇒ 默认引擎 zcode（既有调用方零改动）。
 * 并发：全局 maxConcurrent + **每引擎**上限（opencode 默认 2）。为什么 OpenCode 要单独限低：
 *   本机实测（OpenCode 1.19.2）**同一时刻并发的 opencode 进程会导致 `opencode run` 静默失败**
 *   （零输出 exit 1，stdout/stderr 各 0 字节；串行正常）—— 免费层另有按 IP 限流，但**不是唯一理由**。
 *   引擎名额满只跳过该任务，**不阻塞**其它引擎可运行的任务（队头阻塞见 pump 注释）。
 * OpenCode 是**增量能力**：执行器缺失 / 探测失败 / 超时，都只让它自己的通道为空 + 一条可读 warning，
 *   绝不影响 ZCode 通道与 ZCode 派发；OpenCode **没有** ZCode 侧台账（dispatch-runs.jsonl），
 *   故对它不做台账回读、不产生「台账未命中」类噪音。
 * 权限放行（ZB-45）：`spec.auto`（默认 false）= **显式**放行 OpenCode 未显式拒绝的权限（执行器 `--auto`）。
 *   OpenCode 的工具调用可能需要审批，默认不放行是安全默认；需要时显式开启，并**跨 retry 沿用**同一放行级别。
 *
 * 测试注入：env `DSP_FAKE_RUNNER` 覆盖 runner 路径；`options.spawnImpl` 替换 spawn；
 *   `options.now` 注入时钟（返回 ms 数值或 Date 的函数）；
 *   `options.channelsProbeImpl` 替换 `--list-providers` 探测（返回 stdout 文本）；
 *   `options.channelsImpl` 整体替换 listChannels（降级链测试注入通道可用性）；
 *   `options.zcodeConfigPath / planCachePath / personalProviderPath` 覆盖通道相关文件路径；
 *   `options.opencodeRunnerPath`（或 env `DSP_OPENCODE_RUNNER`）覆盖 OpenCode 执行器路径，
 *   `options.maxConcurrentOpenCode` 设 OpenCode 独立并发上限，`options.opencodeMaxModels` 限制探测出的模型数。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url'; // ZB-44：默认推断 OpenCode 执行器路径（<core 目录>/../../collab-kit/）
import { createHash, randomBytes } from 'node:crypto'; // ZB-08：createHash 供文件锁路径哈希用
/* ZB-44（双引擎）：行协议与引擎判据的**唯一权威**（core 与各执行器共用，见该文件顶部注释）。
 * 原先写死的 `[zcode-run]` 正则、引擎名归一、`opencode/<model>` 通道形态判定，全部改从这里取。 */
import {
  DEFAULT_ENGINE, ENGINES, RUN_PREFIX, prefixFor, normalizeEngine,
  normalizeEngineSpec, inferEngine, isOpenCodeId, isQoderId, isQoderModelName,
} from '../../collab-kit/run-line-protocol.mjs';
/* ZB-51（T2）：三引擎**自动发现** —— 让"别人装上插件就能用"成立。
 * 发现层负责回答"这台机器上 ZCode / OpenCode / Qoder 各自有没有 CLI、在哪、什么版本、是否已登录、什么形态"，
 * core 只消费它的结论（探测细节与候选表都在那个叶子模块里，见其顶部注释）。 */
import { discoverAll, describeDiscovery } from '../../collab-kit/engine-discover.mjs';

/** 本文件所在目录（**只**用于默认推断 OpenCode 执行器路径，不参与业务路径拼接）。 */
const CORE_DIR = dirname(fileURLToPath(import.meta.url));

const LOCK_STALE_MS = 2 * 60 * 60 * 1000; // 锁过期阈值：2h（任务包规定）
const LOCK_ACQUIRE_RETRIES = 5;
const TAIL_CAP = 200; // 内存 tailLines 上限
const JOBS_FILE_CAP = 1000; // jobs.json 持久化条数上限（防无限增长）
const RENAME_RETRIES = 4;

/* ---------------- 执行器汇总行解析（格式权威 = collab-kit/run-line-protocol.mjs） ----------------
 * ZB-44：前缀不再写死 `[zcode-run]`，而是**按引擎渲染**（zcode `[zcode-run]` / opencode `[opencode-run]`）。
 * 除两条**引擎差异行**（思考强度档位表 / 生效确认行，见下方注释）外，两种前缀的行语法逐字相同，
 * 所以正则模板只写一份、按引擎代入前缀 —— 复制两份必然漂移（ZB-31 的坑）。
 * ⚠️ 改这里的任一条正则，必须同步 collab-kit/run-line-protocol.mjs 顶部「行语法」注释块。 */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 引擎差异行①：思考强度**档位表**的关键字
 *  （zcode=`reasoning-levels`；opencode=`variants`；qoder=`reasoning-efforts`）。 */
const LEVELS_KEYWORD = { zcode: 'reasoning-levels', opencode: 'variants', qoder: 'reasoning-efforts' };
/** 引擎差异行②：注入/生效**确认行**的正则（zcode 带 provider 注入 ⇒ target=provider/model；
 *  opencode / qoder 无 provider 注入 ⇒ 只有 model=）与「落到 job 同一组字段」的映射函数。
 *
 * ⚠️ 教训（ZB-51）：给 ENGINES 加引擎时**必须同时**加这三张表。漏了 `APPLIED_RE_OF` 会让
 * `resFor()` 在 `APPLIED_RE_OF[e](p)` 处抛 `is not a function` —— 而它是**热路径**（每行日志都走），
 * 一崩就是整条通道清单/解析全废。故下面取值时加了兜底：未知引擎退回"永不匹配"的正则，不抛。 */
const APPLIED_RE_OF = {
  zcode: (p) => new RegExp(`^${p} reasoning-level=(\\S+) target=(\\S+)\\/(\\S+)\\s*$`),
  opencode: (p) => new RegExp(`^${p} variant=(\\S+) model=(\\S+)\\s*$`),
  qoder: (p) => new RegExp(`^${p} reasoning-effort=(\\S+) model=(\\S+)\\s*$`),
};
const APPLIED_MAPPER = {
  zcode: (m) => ({ reasoningLevelApplied: m[1], reasoningTarget: `${m[2]}/${m[3]}` }),
  opencode: (m) => ({ reasoningLevelApplied: m[1], reasoningTarget: m[2] }),
  qoder: (m) => ({ reasoningLevelApplied: m[1], reasoningTarget: m[2] }),
};

/** ZB-75：思考档位的**强度序**（弱→强）。用于"向上改档位重试"（用户教学要求）。
 *  ⚠️ 只用于**排序/找相邻**，绝不用于校验合法性（合法集合随模型声明不同，见下）。
 *  `auto`/`agent` 是"交给引擎决定"的**语义档位**，不在强度序里（返回 -1 ⇒ 不参与向上比较）。 */
const LEVEL_STRENGTH = ['none', 'disabled', 'minimal', 'low', 'medium', 'enabled', 'high', 'xhigh', 'max', 'ultracode'];
const strengthOf = (lv) => LEVEL_STRENGTH.indexOf(String(lv ?? ''));

/** ZB-75：Qoder **逐模型**档位声明表（用户 2026-10-20 从 Qoder CN 模型卡片提供）。
 *
 *  为什么必须**声明**而不是探测（三条实测证据，见 pitfalls）：
 *   ① CLI 无只读出口能给逐模型档位：`--list-models` 只吐模型名，`--with-efforts` 是**未知选项**；
 *   ② 哨兵探测只逼出**引擎级**合法集（`auto,none,low,medium,high,xhigh,max,ultracode`）；
 *   ③ `-m <每个模型> --reasoning-effort <每档>` 全矩阵（15 模型 × 8 档 = 120 次）**全部 exit=0**
 *      —— CLI **不按模型校验**档位；逐模型限制只在**真实 API 调用**时由服务端生效；
 *      Qoder 的 `catalog-v7` 元数据是加密的（`UU1D…`，非明文 JSON）。
 *  故权威数据只能来自 **Qoder GUI 的模型卡片**（用户提供）。
 *
 *  键 = 裸模型名（与 `--list-models` 输出逐字一致）；值 = 该模型**实际可选**的档位（弱→强，有序）。
 *  未列出的模型 ⇒ 退回引擎级并集（诚实降级：不谎称逐模型精确，也不假装没有档位维度）。
 *  新增/变更模型时**改这一张表**即可（面板的逐模型下拉会自动跟随）。 */
const QODER_MODEL_LEVELS = {
  'Qwen3.8-Flash': ['low', 'medium', 'xhigh'],
  'DeepSeek-Flash': ['low', 'high', 'max'],
};

/** ZB-75：**思考档位核对**用的"关闭思考"档位集 —— 用户本就要不思考时，静默不算"不符"。 */
const THINK_OFF_LEVELS = new Set(['none', 'disabled']);

/** ZB-75：Qoder **引擎级**档位并集的闭包缓存（`listChannels()` 每次探测后写入）——
 *  供 `suggestStrongerLevel()` 在"该模型没有逐模型声明"时兜底。初值 null = 还没探测过
 *  （此时不猜，直接不给向上建议）。 */
let qoderLevelsCache = null;


/** 引擎 → 该引擎的行正则表（缓存：解析是热路径，不能每行都重建正则）。 */
const RES_CACHE = new Map();
function resFor(engine) {
  const e = normalizeEngine(engine);
  const hit = RES_CACHE.get(e);
  if (hit) return hit;
  const p = escapeRe(RUN_PREFIX[e]);
  const res = {
    start: new RegExp(`^${p} tag=(\\S+) mode=(\\S+) cwd=(.+)$`),
    provider: new RegExp(`^${p} provider=(\\S+)(?: model=(\\S+)| models=(\\S+))?(?: \\((.+)\\))?$`),
    resume: new RegExp(`^${p} resume=(\\S+)$`),
    // done exit=0 (超时)? elapsed=9.7s session=…? provider=…? model=…? responseChars=…?（除 exit/elapsed 外均可选）
    done: new RegExp(`^${p} done exit=(\\d+)(?: \\(超时\\))? elapsed=([\\d.]+)s(?: session=(\\S+))?(?: provider=(\\S+))?(?: model=(\\S+))?(?: responseChars=(\\d+))?\\s*$`),
    endpoint: new RegExp(`^${p} endpoint=(\\S+)$`),
    usage: new RegExp(`^${p} usage requests=(\\d+|-) in=(\\d+|-) out=(\\d+|-) cacheRead=(\\d+|-)\\s*$`),
    /* Qoder 的用量是**credits**，不是 token（真机实测 token 字段恒为 0）——
     * 故它另有一条专用行；token 恒为 0 时 `usage` 行只有请求数有意义。 */
    credits: new RegExp(`^${p} credits total=(\\S+) contextRatio=(\\S+) durationMs=(\\S+) turns=(\\S+)\\s*$`),
    /* Qoder 的 context 行：它的上下文窗口大小不由 CLI 报告（真机未给），故 used 与窗口都是 `-`，
     * 真实信号是**占比**。这里刻意放宽为"可能全是占位符"，避免把它记成无法识别的行。 */
    contextRatioLine: new RegExp(`^${p} context used=(\\S+) \\(([\\d.]+|-)% of (\\S+)\\) turnCount=(\\S+)\\s*$`),
    context: new RegExp(`^${p} context used=(\\d+) \\((?:[\\d.]+)% of (\\d+)\\) turnCount=(\\d+|-)\\s*$`),
    // 任务包示例把 out/err/result 写在一行；真实 runner 是三行分开。两种都兼容。
    outCombined: new RegExp(`^${p} out=(.+?) err=(.+?) result=(.+)$`),
    out: new RegExp(`^${p} out=(.+)$`),
    err: new RegExp(`^${p} err=(.+)$`),
    result: new RegExp(`^${p} result=(.+)$`),
    // ZB-28：runner 打印 `memory-ban=on` = 它接受了 --memory-ban 并已注入禁令（job.memoryBanRunner 确认位）
    memoryBan: new RegExp(`^${p} memory-ban=on\\b`),
    /* ZB-40：**心跳/进度**（免费额度通道每 10s 一行）—— 让面板能显示"当前在做什么 + 多久没动静"，
     * 而不是只有沉默（真机事故：轮次失败后 runner 死等，外部看像"卡住"）。
     * 例：`[zcode-run] progress stage=waiting-turn elapsed=120s chars=1024 tools=3 lastTool=Write stageAgo=8s session=sess_x` */
    progress: new RegExp(`^${p} progress stage=(\\S+) elapsed=(\\d+)s chars=(\\d+) tools=(\\d+)(?: lastTool=(\\S+))? stageAgo=(\\d+)s(?: session=(\\S+))?\\s*$`),
    // 已知信息行（识别但不入库）：cli=<path> / task=<path> / 权限模式回显 / 工具计数 / 引擎侧 stderr
    /* ZB-51：Qoder 执行器的这几条都是**已知信息行**（诊断用，不入库、不落 warning）：
     *   `permission-mode=accept_edits（…）`        ← 开头声明本次用的权限模式
     *   `permission-mode-requested=… reported=…`   ← 权限回落核对结论
     *   `tools count=31`                           ← 工具计数
     *   `stderr 非空（前 300 字）：…`              ← **引擎侧 stderr 摘录**
     * 它们此前落进 `parseWarnings`（"unparsed line"），看起来像解析失败 —— 其实是已知信息。
     *
     * ⚠️ 用**宽松子串**（`\b` 开头 + 不锚定结尾）而不是 `.+$`：那条 stderr 行自身带括号且带截断，
     * 用严格结尾匹配会因"截断文本里含 `)`"而失配（实测踩到）。已知信息行不需要结构化取数，
     * 宽松匹配更能容忍执行器文案变化。 */
    knownInfo: new RegExp(`^${p} (?:cli|task|permission-mode|permission-mode-requested|tools count|model|resume)\\b`
      + `|^${p} stderr 非空`),
    // 引擎差异行①（探测/声明行；parseProviderTable 的 modelLevels 走同一份正则）
    levels: new RegExp(`^${p} ${LEVELS_KEYWORD[e] ?? 'reasoning-levels'} (\\S+?)=(\\S+)\\s*$`),
    // 引擎差异行②（生效确认行）—— 未知引擎退回"永不匹配"，绝不抛（见上面 APPLIED_RE_OF 的教训）
    applied: (APPLIED_RE_OF[e] ?? (() => /(?!)/))(p),
    /* ZB-75：**观测到的思考状态**行（目前只有 Qoder 执行器打）——
     * `[qoder-run] thinking-observed=thinking|silent blocks=N chars=N requested=<档位>`。
     * 为什么需要它：Qoder 引擎**不回报实际生效档位**（init/result 里都没有该字段），
     * 所以 `applied` 行只是回显请求值 ⇒ 档位静默回落检测不出来。这一行是**唯一**可观测信号。 */
    thinkingObserved: new RegExp(`^${p} thinking-observed=(thinking|silent) blocks=(\\d+) chars=(\\d+) requested=(\\S+)\\s*$`),
  };
  RES_CACHE.set(e, res);
  return res;
}

const num = (s) => (s == null || s === '-' ? null : Number(s));

/**
 * 档位表行的**唯一**解析实现（zcode / opencode 共用，避免抄两份漂移）：
 *   zcode    `[zcode-run] reasoning-levels <model>=<a,b,c>`
 *   opencode `[opencode-run] variants <model>=<a,b>`
 * 取值随模型声明不同（GLM-5 系 disabled|enabled；deepseek-v4 系 disabled|low|high|max），不写死枚举。
 * engine 省略/未知 ⇒ 两个已知前缀都试（老 jobs.json 与手工调用仍能解析）；返回 {model, levels} 或 null。
 */
function parseLevelsLine(line, engine) {
  const explicit = typeof engine === 'string' ? engine.trim().toLowerCase() : '';
  const order = ENGINES.includes(explicit) ? [explicit] : ENGINES;
  for (const e of order) {
    const m = resFor(e).levels.exec(line);
    if (m) return { model: m[1], levels: m[2].split(',').map((s) => s.trim()).filter(Boolean) };
  }
  return null;
}

/* ---------------- 暂停原因识别（Z6；签名为 DSH 实测的错误输出关键词） ----------------
 * 顺序即优先级：entitlement / signing / config 属精确原因，先于较宽的 quota 组，
 * 防止 quota 组里的宽词（如 balance / 429）抢先用附带提及的行定性。 */
const PAUSE_SIGNATURES = [
  { reason: 'plan-not-entitled', patterns: [/not_entitled/i, /plan-not-entitled/i] },
  /* ZB-71（2026-10-18 真机实测新增）：OpenCode 免费模型的**网络级封锁**。
   * 现场原文：`HTTP 403 · FreeTierError: OpenCode's free models aren't available from your current
   * network because we've detected abusive traffic from this IP address…`（`isRetryable:false`）。
   * 为什么必须单独成一类：① 旧代码认不出来 ⇒ 停在 `failed/unknown`，**用户看不到任何可读原因**；
   * ② 它是**按 IP 生效**的，同引擎的其它免费模型**必然同样失败** ⇒ 在引擎内换模型是白烧时间，
   * 有意义的是**跨通道**（换到 ZCode/Qoder）。故它进 AUTO_FALLBACK_REASONS，且**不进**顺序派发的延续面。 */
  { reason: 'provider-blocked', patterns: [/FreeTierError/, /abusive traffic/i, /free models aren't available/i] },
  { reason: 'provider-signing', patterns: [/ClientRequestSigningV4Error/] },
  /* ZB-76（2026-10-20 真机实测新增）：**工具权限未放行**（不是沙箱限制，也不是网络故障）。
   *
   * 现场：Qoder 在 `accept_edits` 下，写文件**正常**，但 `WebFetch` / `WebSearch` / 部分 Bash
   * 返回 `Error: Fetch https://…?` / `Error: Allow searching the web?` / `Allow Bash to run…`。
   * 实测对照：同一任务加 `auto:true`（→ `--permission-mode bypass_permissions`）后 **4/4 全成功**
   * （写文件 + Bash + WebFetch + WebSearch）⇒ **不是"只能读写工作区"**，而是**权限待审批**。
   *
   * 为什么要单独成一类：① 旧代码认不出 ⇒ 任务停在 `failed/unknown`，用户/Agent 只能自己猜，
   * 真机就发生过**误诊为"沙箱限制"**（把可修的权限问题当成引擎能力不足，于是放弃派发）；
   * ② 它**可修**（`auto:true` 或信任目录）⇒ 给出可执行指引比"失败"有用得多；
   * ③ **不**进 AUTO_FALLBACK_REASONS：换通道治不了权限（新通道照样要授权）。 */
  { reason: 'permission-blocked', patterns: [/Allow searching the web/i, /Allow Bash to run/i, /Allow WebFetch/i,
    /Error: Fetch https?:\/\//i, /needs? (?:your )?(?:approval|permission)/i, /requires? (?:your )?approval/i,
    /permission prompt/i, /tool (?:use )?was denied/i] },
  { reason: 'config-error', patterns: [/Select a model before continuing/i, /CONFIGURATION_ERROR/] },
  { reason: 'quota-exhausted', patterns: [/quota_exceeded/i, /coding_plan_required/i, /rate_limited/i, /insufficient/i, /\b429\b/, /balance/i] },
];
/** 自动降级链只接这几种「换通道可能有意义」的暂停；config-error 属参数错误，unknown 不自动动。
 *  ZB-71：`provider-blocked`（按 IP 封锁免费模型）必须在这里 —— 换通道是唯一有效的动作。 */
const AUTO_FALLBACK_REASONS = new Set(['quota-exhausted', 'plan-not-entitled', 'provider-signing', 'provider-blocked']);
/** 这些暂停原因**不在同一引擎内延续**（换模型没用，只会白烧额度/时间）：
 *  · config-error：参数/配置错，换任何模型都一样；
 *  · provider-blocked：按 IP 封锁，同引擎的免费模型必然同样失败 ⇒ 直接交回**跨通道**降级链。 */
const NO_SEQUENTIAL_REASONS = new Set(['config-error', 'provider-blocked']);

/**
 * 从 runner 输出行里识别暂停原因。命中签名 → {reason, detail}（detail=命中的原文一行）；
 * 有输出但没命中 → {reason:'unknown', detail=最后一条非空行}（调用方保持 failed）；
 * 完全无输出（如 spawn 失败）→ null。
 */
export function classifyPause(lines) {
  const rows = (lines ?? []).filter((l) => typeof l === 'string' && l.trim());
  for (const line of rows) {
    for (const sig of PAUSE_SIGNATURES) {
      if (sig.patterns.some((re) => re.test(line))) {
        return { reason: sig.reason, detail: line.trim().slice(0, 300) };
      }
    }
  }
  if (rows.length === 0) return null;
  return { reason: 'unknown', detail: rows[rows.length - 1].trim().slice(0, 300) };
}

/* ---------------- `--list-providers` 表格解析（Z6） ----------------
 * runner 的表行：`${id.padEnd(34)}${enabled}` + padEnd(10) + `${baseURL} | ${models}${(reason)?}`。
 * 注意 id 达 34+ 字符（UUID）时两列粘连（如 `…daedafalse`），所以不能用空白切列，
 * 必须用「最短前缀 + true/false + 空白」定位 enabled 列。解析不出任何行 → 空结果 + warnings，
 * 绝不猜测。 */
const LIST_ROW_RE = /^(.+?)(true|false)\s+(\S+)\s+\|\s+(.+)$/;

/** 解析 `--list-providers` 输出 → {rows:[{id,enabled,reason,endpoint,models}], modelLevels:{modelId:[levels]}, warnings}。
 *  engine 省略/未知 ⇒ zcode 与 opencode 两种**档位表行**都识别；传具体引擎 ⇒ 只认该引擎的（不看错别的引擎的行）。
 *  provider 表格行本身与引擎无关（无前缀），故两种引擎共用同一段解析。 */
export function parseProviderTable(text, engine = null) {
  const warnings = [];
  const rows = [];
  const modelLevels = {};
  if (text == null || !String(text).trim()) {
    return { rows, modelLevels, warnings: ['list-providers 输出为空'] };
  }
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    /* ZB-29 / ZB-44：思考强度档位行（runner 探测内置配置 modelRules 得出，随模型声明不同）。
     * zcode 打 `reasoning-levels`、opencode 打 `variants` —— 同一段实现（parseLevelsLine）解析。 */
    const lvl = parseLevelsLine(line, engine);
    if (lvl) {
      modelLevels[lvl.model] = lvl.levels;
      continue;
    }
    const m = LIST_ROW_RE.exec(line);
    if (!m) continue;
    const id = m[1].trim();
    if (!id || /\s/.test(id)) {
      warnings.push(`list-providers 行解析异常（id 列含空白）：${line.slice(0, 80)}`);
      continue;
    }
    const rest = m[4];
    const withReason = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(rest);
    const modelsPart = (withReason ? withReason[1] : rest).trim();
    const models = modelsPart === '-' ? [] : modelsPart.split(',').map((s) => s.trim()).filter(Boolean);
    rows.push({
      id,
      enabled: m[2] === 'true',
      endpoint: m[3] === '-' ? null : m[3],
      models,
      reason: withReason ? withReason[2] : null,
    });
  }
  if (rows.length === 0) warnings.push('list-providers 输出里没有可识别的 provider 行');
  return { rows, modelLevels, warnings };
}

/* 单引擎行解析内核的三态返回值：
 *   对象      = 命中（可能是 {} = 已知信息行，识别但不入库）
 *   null      = **带本引擎前缀但识别失败**（调用方记 parseWarnings）
 *   NOT_MINE  = 这不是本引擎的行（换下一个引擎/按普通输出处理） */
const NOT_MINE = Symbol('not-this-engine');

/** 用**指定引擎**的正则解析一行（检查顺序与既有实现逐字一致，保证 zcode 的解析结果不变）。 */
function parseLineForEngine(text, engine) {
  const e = normalizeEngine(engine);
  const res = resFor(e);
  let m;
  if ((m = res.done.exec(text))) {
    /* ZB-28：`(超时)` 标记（runner --timeout-min 到点，exit=124）此前被非捕获组吞掉 ——
     * 「runner 超时的 failed」与「任务真失败的 failed」在 job 上无法区分。现在带出 timedOut。 */
    return {
      exitCode: Number(m[1]), runnerElapsedSec: Number(m[2]), sessionId: m[3] ?? null,
      provider: m[4] ?? null, model: m[5] ?? null, responseChars: num(m[6]),
      authoritative: true, summarySeen: true,
      ...(text.includes('(超时)') ? { timedOut: true } : {}),
    };
  }
  if ((m = res.usage.exec(text))) {
    return { usage: { requests: num(m[1]), inputTokens: num(m[2]), outputTokens: num(m[3]), cacheReadTokens: num(m[4]) } };
  }
  /* ZB-51：Qoder 的 credits 行 —— 落进 `job.credits`（与 ZCode/OpenCode 的 token 用量并存）。
   * 真机实测该引擎 token 字段恒为 0，credits 才是真计量，故单独留字段，不硬塞进 usage。 */
  if ((m = res.credits.exec(text))) {
    return {
      credits: num(m[1]),
      contextRatio: num(m[2]),
      durationMs: num(m[3]),
      ...(num(m[4]) != null ? { turnCount: num(m[4]) } : {}),
    };
  }
  /* Qoder 的 context 行（used / 窗口可能是 `-`，真实信号是占比）—— 放在严格的 context 之后匹配，
   * 保证既有 zcode/opencode 的严格行行为**逐字不变**。
   * ⚠️ 这里必须与 `context` 行同契约：`-` ⇒ **null**（而不是"字段缺失 = undefined"）。
   * 既有测试按 `turnCount: null` 断言，用 `undefined` 会让"没上报"与"上报为空"再也分不开。 */
  if ((m = res.contextRatioLine.exec(text))) {
    const pct = num(m[2]);
    return {
      contextUsed: num(m[1]),
      contextWindow: num(m[3]),
      ...(pct != null ? { contextRatio: pct / 100 } : {}),
      turnCount: num(m[4]),
    };
  }
  if ((m = res.context.exec(text))) {
    return { contextUsed: Number(m[1]), contextWindow: Number(m[2]), turnCount: num(m[3]) };
  }
  if ((m = res.endpoint.exec(text))) return { endpoint: m[1] };
  if ((m = res.provider.exec(text))) {
    return { provider: m[1], ...(m[2] ? { model: m[2] } : {}), ...(m[3] ? { models: m[3] } : {}), providerLabel: m[4] ?? null };
  }
  if ((m = res.start.exec(text))) return { runnerTag: m[1], runnerMode: m[2], runnerCwd: m[3] };
  if ((m = res.resume.exec(text))) return { resume: m[1] };
  if ((m = res.memoryBan.exec(text))) return { memoryBanSeen: true }; // ZB-28：runner 确认禁令已注入
  if ((m = res.progress.exec(text))) {
    /* ZB-40：心跳 → job.progress（面板/工具据此显示"当前工作内容"与"是否可能卡住"） */
    return {
      progress: {
        stage: m[1],
        elapsedSec: Number(m[2]),
        chars: Number(m[3]),
        tools: Number(m[4]),
        lastTool: m[5] ?? null,
        stageAgoSec: Number(m[6]),
        sessionId: m[7] ?? null,
      },
      lastProgressAt: Date.now(),
    };
  }
  if ((m = res.applied.exec(text))) {
    /* ZB-29 / ZB-44：思考强度生效确认。
     * zcode = 确认已写入临时 provider 配置（reasoning-level=<档> target=<provider>/<model>）；
     * opencode = 确认实际生效的模型变体（variant=<档> model=<modelId>，无 provider 注入）。
     * 两者落到**同一组** job 字段（reasoningLevelApplied / reasoningTarget）。 */
    return APPLIED_MAPPER[e](m);
  }
  /* ZB-75：观测到的思考状态（Qoder 专用）—— 落到 job.thinkingObserved / thinkingBlocks，
   * 供 `finalizeJob` 核对"请求要思考、实际却没思考"（= 档位被静默降级）。 */
  if ((m = res.thinkingObserved.exec(text))) {
    return { thinkingObserved: m[1], thinkingBlocks: Number(m[2]), thinkingChars: Number(m[3]), thinkingRequested: m[4] };
  }
  if (res.knownInfo.test(text)) return {}; // 已知信息行（cli= / task=），无需入库
  /* ZB-44：opencode 的 `variants <model>=<a,b>` 是**探测/声明行**（与 zcode 的 reasoning-levels 同义），
   * 任务流里也可能出现 ⇒ 识别为已知信息行（返回 {}，不落「无人识别的行」warning）。
   * zcode 的 reasoning-levels 只在 --list-providers 输出里出现，故保持既有语义（此处置为未识别）。 */
  if (e === 'opencode' && res.levels.test(text)) return {};
  /* ZB-45：opencode 执行器在**显式放行**时打的 `auto=on（…）` 可审计告知行
   * （见 collab-kit/opencode-run.mjs 的 --auto 实现）。识别为"已知信息行 + autoSeen"：
   * 既不留「无人识别的行」warning，也让 job.autoApproved 有**执行器侧确认**（与下发位交叉核对）。
   * 协议文件（run-line-protocol.mjs）尚未登记该形状 ⇒ 等它补登后本节应改成与 memoryBan 同形的正式条目。 */
  if (e === 'opencode' && /^\[opencode-run\] auto=on\b/.test(text)) return { autoSeen: true };
  if ((m = res.outCombined.exec(text))) return { runnerOut: m[1], runnerErr: m[2], runnerResult: m[3] };
  if ((m = res.out.exec(text))) return { runnerOut: m[1] };
  if ((m = res.err.exec(text))) return { runnerErr: m[1] };
  if ((m = res.result.exec(text))) return { runnerResult: m[1] };
  return text.includes(RUN_PREFIX[e]) ? null : NOT_MINE;
}

/**
 * 解析单行 → 字段更新对象。
 *
 * ZB-44：`engine` 省略/未知时**两个已知前缀都尝试**（zcode 的 `[zcode-run]` 与 opencode 的
 * `[opencode-run]`）—— 老 jobs.json、手工调用、以及「不知道引擎」的调用方因此仍能解析；
 * 传了具体引擎则只用该引擎的正则，**另一个前缀的行按普通输出返回 `{}`（不是 null）**。
 *
 * 语义（与接入 OpenCode 前一致）：**带已知前缀但识别失败 → null**（调用方记 parseWarnings）；
 * **无已知前缀的普通行 → `{}`**。
 */
export function parseRunnerLine(line, engine) {
  const text = typeof line === 'string' ? line : String(line ?? '');
  const explicit = typeof engine === 'string' ? engine.trim().toLowerCase() : '';
  const order = ENGINES.includes(explicit) ? [explicit] : ENGINES;
  for (const e of order) {
    const parsed = parseLineForEngine(text, e);
    if (parsed === null) return null; // 该引擎的前缀 + 识别失败
    if (parsed !== NOT_MINE) return parsed; // 命中（含已知信息行的 {}）
  }
  return {}; // 无任何已知前缀 = 普通输出
}

/* ---------------- 文件锁（跨进程互斥；'wx' 独占创建即原子仲裁） ---------------- */
function readLockFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 存在但无权限 = 活着
  }
}

function isStaleLock(rec, file, nowMs) {
  if (!rec) {
    try {
      return nowMs - statSync(file).mtimeMs > LOCK_STALE_MS; // 内容损坏：按文件年龄兜底
    } catch {
      return true;
    }
  }
  const at = Date.parse(rec.at);
  if (Number.isFinite(at) && nowMs - at > LOCK_STALE_MS) return true;
  return !pidAlive(rec.pid);
}

function acquireLockFile(file, info, nowMs) {
  for (let i = 0; i < LOCK_ACQUIRE_RETRIES; i += 1) {
    try {
      const fd = openSync(file, 'wx'); // 独占创建：并发竞争的唯一仲裁点
      try {
        writeSync(fd, JSON.stringify(info));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      const rec = readLockFile(file);
      if (rec && rec.jobId === info.jobId) return true; // 重入幂等
      if (isStaleLock(rec, file, nowMs)) {
        try {
          unlinkSync(file);
        } catch { /* 被别人抢先清理：下一轮 wx 重试 */ }
        continue;
      }
      return false; // 锁被活着的持有者占用
    }
  }
  return false;
}

function releaseLockFile(file, jobId) {
  const rec = readLockFile(file);
  if (rec && rec.jobId !== jobId) return false; // 别人的锁不动
  try {
    unlinkSync(file);
  } catch { /* 已不存在即已释放 */ }
  return true;
}

function sweepStaleLocks(files, nowMs) {
  for (const f of files) {
    if (!existsSync(f)) continue;
    if (isStaleLock(readLockFile(f), f, nowMs())) {
      try {
        unlinkSync(f);
      } catch { /* 竞争失败无妨 */ }
    }
  }
}

/* ---------------- 原子写（临时文件 + rename；Windows EPERM 短重试） ---------------- */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* 不可用则跳过等待 */ }
}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  for (let i = 0; ; i += 1) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= RENAME_RETRIES || (e.code !== 'EPERM' && e.code !== 'EACCES')) {
        try {
          unlinkSync(tmp);
        } catch { /* 尽力清理 */ }
        throw e;
      }
      sleepSync(20 * (i + 1));
    }
  }
}

/* ---------------- 工具 ---------------- */

/** Windows 8.3 短名检测：`ADMINI~1` 这类"**整段**就是短名"的路径段。
 *  判据刻意收紧（宁可漏展开、不可误改路径）：
 *    · 段必须**以 `~数字` 结尾**（8.3 短名的固定形态）；
 *    · 段名（去掉 `~数字`）只能含 `A-Za-z0-9_`，且长度 1-6（8.3 的前半段限制）。
 *  这样 `dsp-cwd-pure-long-dir`、`my~backup`（不在末尾）、`file~1.txt`（不是整段）都不会命中。 */
const WIN_SHORTNAME_RE = /(^|[\\/])([A-Za-z0-9_]{1,6})~[0-9]+([\\/]|$)/;

/**
 * `cwd` 的**尽力长路径规范化**（ZB-72）。
 *
 * 真机事故：`C:\Users\ADMINI~1\…`（8.3 短名）作 cwd 派 Qoder 写任务 ⇒ Qoder 的安全门
 * 以"可疑 Windows 路径语法，可能绕过安全检查"拒绝写入，而任务**报 done**（静默假成功）。
 *
 * 策略（安全第一，宁可不动也不抛）：
 *   · 非 Windows / 不含 `~数字` 段 ⇒ **原样返回**（绝大多数情况，零开销）；
 *   · 含短名 ⇒ 试 `realpathSync.native`（NTFS 上会把短名解析成长名）；失败就退回 `realpathSync`；
 *   · 两个都失败（路径不存在 / 无权限）⇒ 保持原样，只在 note 里说明"想展开但没成功"；
 *   · 展开结果与原文**只差大小写** ⇒ 视为未变化（Windows 大小写不敏感，不必惊动调用方）。
 *
 * @returns {{path:string, changed:boolean, note:string|null}}
 */
export function normalizeCwdPath(input) {
  const p = String(input ?? '');
  if (process.platform !== 'win32' || !p) return { path: p, changed: false, note: null };
  if (!WIN_SHORTNAME_RE.test(p)) return { path: p, changed: false, note: null };
  let resolved = null;
  try { resolved = realpathSync.native(p); } catch { /* 退回下面的非 native 实现 */ }
  if (!resolved) { try { resolved = realpathSync(p); } catch { resolved = null; } }
  if (!resolved) {
    return {
      path: p,
      changed: false,
      note: `cwd 含 Windows 8.3 短名（${p}）但展开失败（路径不存在或无权限）⇒ 已按原样派发；`
        + '若引擎以"可疑路径语法"拒绝写入，请改用长路径（如 C:\\Users\\<你的用户名>\\…）。',
    };
  }
  /* 大小写差异不算变化（Windows 路径大小写不敏感）。 */
  const same = resolved.toLowerCase() === p.toLowerCase();
  if (same) return { path: resolved, changed: false, note: null };
  return {
    path: resolved,
    changed: true,
    note: `cwd 含 Windows 8.3 短名 ⇒ 已展开为长路径（${p} → ${resolved}）；`
      + '原因：部分引擎（如 Qoder）会把 8.3 短名当成"可疑路径语法"而拒绝写文件（任务会假成功）。',
  };
}

/* ZB-25：状态集合**只在这里定义一份**，并导出给 wire/notify 复用。
 * 此前 wire.host.mjs（DONE/DISMISSABLE）与 notify.mjs（SETTLE_STATES）各自字面量复制，
 * 4 处定义、已实际漂移过（kill(paused)/paused 是否算「落地」各写一遍）。
 * 本次只加 `export` 关键字，值/语义零改动。 */
export const TERMINAL_STATES = new Set(['done', 'failed', 'killed', 'interrupted']);
/** 「落地」判据 = 终态 + paused（paused 同样需要人决定 retry 续跑还是换通道）。 */
export const SETTLED_STATES = new Set([...TERMINAL_STATES, 'paused']);
const KINDS = new Set(['task', 'prompt', 'target']);
const LOCK_MODES = new Set(['repo', 'none']); // ZB-16：删除 memory；none = 明确不取锁

/** ZB-72：`validateSpec()` 与 `dispatchRaw()` 之间传递"cwd 被改写了、为什么"的**一次性信箱**。
 *  为什么用模块级数组而不是给 validateSpec 加返回值：validateSpec 是**纯校验**（无返回、抛错即拒绝），
 *  改签名会牵动所有调用点与既有测试；而这里只是"顺带留痕"，用一次性信箱最小侵入。
 *  ⚠️ 每次 `dispatchRaw` 都会**取空**它（splice），所以不会跨派发串味；validateSpec 抛错时
 *  内容自然作废（那次派发已被拒绝，留痕无意义）。 */
const pendingCwdNotes = [];

/* ==================== ZB-08：细粒度文件锁表 ====================
 *
 * 背景（用户观察 + 实测）：单写者锁把**整个进程**锁住，但一个进程 27 分钟里大部分时间在
 * 思考 / 调 API / 读文件，并非一直在写。粗粒度锁让"锁不冲突"的任务也被迫干等 ——
 * 实测 T18（lock=both，27 分钟）期间，只要 repo 与只要 memory 的两个任务全程排队，
 * 三者的 started/finished 首尾相接、无一毫秒重叠。
 *
 * 改造：派发方可**显式声明写入集** `spec.write: string[]`；core 只为这些路径加锁。
 * 冲突判定落到文件级：A 写 a.ts、B 写 b.md ⇒ 可并行；A 与 B 都写 a.ts ⇒ 后者排队。
 *
 * ⚠️ 安全底线（本设计的第一约束）：**未声明 write 的任务，一律锁整个仓库（repo.lock）**。
 * 细粒度是"声明了才生效的可选优化"，绝不是"默认放宽"——否则不声明的任务会失去互斥保护，
 * 多个 ZCode 进程同时改同一个仓库，那正是单写者语义要防的事故。
 *
 * 锁文件命名：绝对路径无法直接做文件名（含冒号、反斜杠），故用 sha256 前 16 位哈希；
 * 锁体里回存原始 paths，供 UI 展示「哪个文件被谁锁着」。
 */
const FILE_LOCK_DIR = 'files'; // <workRoot>/locks/files/

function hashPath(p) {
  return createHash('sha256').update(normalizeForLock(p)).digest('hex').slice(0, 16);
}

/** 归一化：统一分隔符 + 大小写（Windows 文件系统大小写不敏感）+ 去末尾斜杠 + **realpath**。
 *
 * ⚠️ ZB-08 实测修正：初版**只小写了盘符**，没小写路径其余部分 —— 结果
 * `F:\proj\src\a.ts` / `F:\PROJ\SRC\A.TS` / `F:\Proj\Src\a.Ts` 三种写法产出
 * **3 把不同的锁**，三个任务同时写同一个文件（正是细粒度锁要防的事故，探针实测确认）。
 * Windows 上路径整体大小写不敏感，故按平台决定：Windows 整体小写，POSIX 保持原样。
 *
 * ⚠️ ZB-26（审计 B1）再修一层：大小写/分隔符一致**还不够** —— 8.3 短名（`DISPAT~1.MJS`）、
 * junction / symlink、`\\?\` 前缀指向的是**同一个文件**，却产出不同的哈希 ⇒ 同一个文件两把锁，
 * 单写者语义被绕过（审计实测同一文件 distinct lock keys = 2）。
 * 修法：对**最长已存在祖先**做 `realpathSync.native`（不存在的尾段原样拼回，因为锁必须能表达
 * 「将来才创建的文件」—— `test/file-lock.test.mjs` 用的就是不存在的路径）；解析失败退回 resolve。
 * realpath 只在真实文件系统上生效，故对纯字符串路径零副作用。 */
function realpathBestEffort(absPath) {
  try {
    let head = absPath;
    const tail = [];
    // 逐级向上找到第一个真实存在的祖先（最多回溯 8 级，避免病态路径反复 stat）
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(head)) {
        const real = realpathSync.native(head);
        return tail.length ? join(real, ...tail.reverse()) : real;
      }
      const parent = dirname(head);
      if (parent === head) break;
      tail.push(basename(head));
      head = parent;
    }
  } catch { /* 权限/竞态：退回原路径 */ }
  return absPath;
}

function normalizeForLock(p) {
  let s = resolve(String(p));
  s = realpathBestEffort(s).replace(/\\/g, '/');
  // 去末尾斜杠（目录写法统一）
  s = s.replace(/\/+$/, '');
  if (process.platform === 'win32') {
    // Windows：盘符与路径均不区分大小写 ⇒ 整体小写，保证同一文件只对应一把锁
    s = s.toLowerCase();
  } else if (/^[a-zA-Z]:\//.test(s)) {
    // 非 Windows 上出现盘符写法（如 WSL 路径）时至少统一盘符大小写
    s = `${s[0].toLowerCase()}${s.slice(1)}`;
  }
  return s;
}

function fileLockPath(dirLocks, p) {
  return join(dirLocks, FILE_LOCK_DIR, `${hashPath(p)}.lock`);
}

/**
 * 创建派发器。
 * @param {object} options
 *   runnerPath    runner 脚本绝对路径（env DSP_FAKE_RUNNER 可覆盖，测试注入用）
 *   runnerCwd     子进程工作目录（默认 process.cwd()；spec.cwd 会作为 runner 的 --cwd 传入）
 *   ledgerPath    台账 dispatch-runs.jsonl（缺省则跳过台账回读）
 *   workRoot      工作根目录（locks/state/logs 都在它下面）
 *   maxConcurrent 最大并发（默认 3；**全局**上限，所有引擎合计）
 *   maxConcurrentOpenCode  OpenCode 引擎的独立并发上限（默认 2；与 ZCode 分开计数）——
 *                       实测依据见函数体内注释：并发的 opencode 进程会让 `opencode run` 零输出 exit 1
 *   opencodeRunnerPath  OpenCode 执行器脚本绝对路径（默认 env DSP_OPENCODE_RUNNER，
 *                       再默认 <core 目录>/../../collab-kit/opencode-run.mjs）；探测与派发同用一个脚本。
 *                       显式传 '' = 明确「配了但没有」（OpenCode 通道为空）
 *   opencodeMaxModels  探测出的 OpenCode 模型数上限（默认 0 = 不限）
 *   repoLockPath  整仓库锁文件路径（默认 <workRoot>/locks/repo.lock）；memory 锁已于 ZB-16 删除
 *   timeoutGraceSec  dispatcher 看门狗在 runner 自身超时之后的宽限秒数（默认 120）
 *   spawnImpl / now  测试注入
 */
export function createDispatcher(options = {}) {
  const runnerPath = process.env.DSP_FAKE_RUNNER || options.runnerPath;
  if (!runnerPath) throw new TypeError('createDispatcher: 需要 options.runnerPath（或 env DSP_FAKE_RUNNER）');
  if (!options.workRoot) throw new TypeError('createDispatcher: 需要 options.workRoot');

  const workRoot = resolve(options.workRoot);
  const dirLocks = join(workRoot, 'locks');
  const dirState = join(workRoot, 'state');
  const dirLogs = join(workRoot, 'logs');
  const jobsFile = join(dirState, 'jobs.json');
  /* task-11（M2）：**状态目录的唯一所有者是 core** —— 其它层（wire / notify）要落自己的状态文件
   * （dismissed.json / wake-stats.json）时只准经这里取名，不许自己 `dirname(jobsFile)` 反推。
   * 反推的后果：core 换布局（或路径语义变化）时，消费者会静默写到错位置。 */
  const statePath = (name) => join(dirname(jobsFile), String(name));
  const repoLockPath = options.repoLockPath ? resolve(options.repoLockPath) : join(dirLocks, 'repo.lock');
  /* ZB-16：memory 锁已删除（用户要求）。保留只读的 legacy 路径常量，仅用于启动时清理历史遗留的
   * memory.lock 文件 —— 否则升级后那个文件会永远躺在 locks/ 里、且被旧版快照当成"有人持锁"。 */
  const legacyMemoryLockPath = join(dirLocks, 'memory.lock');
  const ledgerPath = options.ledgerPath ? resolve(options.ledgerPath) : null;
  const maxConcurrent = Math.max(1, Number(options.maxConcurrent) || 3);
  /* ZB-44：OpenCode 引擎的**独立**并发上限。为什么默认低且与 ZCode 分开计数（**准确理由**）：
   * OpenCode 1.19.2 本机实测 —— 同一时刻有**第二个 opencode 进程**在跑时，`opencode run` 会**零输出
   * exit 1**（stdout/stderr 各 0 字节）；串行（探测在 run 之前、不并发）则正常。免费层另有按 IP 限流，
   * 那是第二重理由，**不是**唯一理由；用户仍可自行调高（不拦截，但请知情）。
   * 全局 maxConcurrent 仍是所有引擎合计的上限，故实际并发 = min(全局, 本引擎上限)。 */
  const maxConcurrentOpenCode = Math.max(1, Number(options.maxConcurrentOpenCode ?? 2) || 2);
  /* ZB-79（2026-10-20 实测纠正）：Qoder 独立并发上限，**默认 3**（原先默认 1）。
   *
   * 旧默认 1 的理由是**猜测且从未实测**（"额度有限 / 并发多个 CLI agent 会互相干扰"）。
   * 真机对照实测：同时起 3 个 / 5 个 `qoderclicn` 进程 ⇒ **3/3、5/5 全部 exit=0**、
   * 结果正确（`7!` 都答 5040）、耗时 10–20s 无明显劣化 ⇒ **Qoder 可以并发**。
   *
   * ⚠️ 与 OpenCode 的区别是**有实测支撑的**：OpenCode 1.19.2 并发会让 `opencode run`
   * 零输出 exit 1（那条默认 2 的依据是真的）。Qoder 没有这个现象，故不该照抄 OpenCode 的保守值。
   * 全局 maxConcurrent 仍是所有引擎合计的上限 ⇒ 实际并发 = min(全局, 本引擎上限)。 */
  const maxConcurrentQoder = Math.max(1, Number(options.maxConcurrentQoder ?? 3) || 3);
  const runnerCwd = options.runnerCwd ? resolve(options.runnerCwd) : process.cwd();
  const timeoutGraceMs = Math.max(0, Number(options.timeoutGraceSec ?? 120) * 1000);
  const spawnImpl = options.spawnImpl || nodeSpawn;
  // Z6 通道相关：默认读桌面端 ZCode 配置（只读，绝不写入 $DSH_HOME）；测试可整路径覆盖
  const zcodeConfigPath = options.zcodeConfigPath ? resolve(options.zcodeConfigPath) : join(homedir(), '.zcode', 'v2', 'config.json');
  const planCachePath = options.planCachePath ? resolve(options.planCachePath) : join(homedir(), '.zcode', 'v2', 'coding-plan-cache.json');
  const personalProviderPath = options.personalProviderPath ? resolve(options.personalProviderPath) : join(homedir(), '.zcode', 'v2', 'provider_config.json');
  const channelsProbeImpl = options.channelsProbeImpl ?? null; // async () => '--list-providers' stdout 文本
  const channelsImpl = options.channelsImpl ?? null; // async () => ({channels, warnings})，整体替换
  /* ZB-51（T2）：引擎自动发现的注入点（async () => ({zcode,opencode,qoder})）。
   * 与上面两个钩子同一条纪律：**替身在场时不做真探测** —— 否则既有确定性测试会变慢/变脆，
   * 更可能真去 spawn 用户机器上的 CLI（硬约束：不碰用户自己的 agent 配置与数据）。 */
  const discoverImpl = options.discoverImpl ?? null;
  const discoveryEnabled = !!discoverImpl || (!channelsProbeImpl && !channelsImpl);
  /* ZB-51（T4）：Qoder 执行器路径。默认推断 <CORE_DIR>/../../collab-kit/qoder-run.mjs
   * （与 OpenCode 同构）；显式空串 '' ⇒ 明确"配了但没有"⇒ Qoder 通道为空 + 可读 warning。 */
  const qoderExplicitEmpty = options.qoderRunnerPath === '';
  const qoderRunnerPath = qoderExplicitEmpty
    ? null
    : resolve(String(options.qoderRunnerPath ?? process.env.DSP_QODER_RUNNER ?? join(CORE_DIR, '..', '..', 'collab-kit', 'qoder-run.mjs')));
  /* 与 OpenCode 同一条纪律：显式配置 ⇒ 总是探测；只有默认推断 ⇒ 仅在"真实运行"时探测
   * （替身在场时真 spawn 会让确定性测试变慢/变脆）。 */
  const qoderProbeEnabled = !qoderExplicitEmpty
    && (options.qoderRunnerPath != null || !!process.env.DSP_QODER_RUNNER || (!channelsProbeImpl && !channelsImpl));
  /* ZB-44：OpenCode 执行器路径 —— **探测与派发同用一个 Node 脚本**（`--list-models` / `--version` 只读子命令 + 执行）。
   * 取值优先级（与 index.js 的约定一致）：
   *   显式空串 ''（= 明确「配了但没有」⇒ OpenCode 通道为空） > options.opencodeRunnerPath
   *   > env DSP_OPENCODE_RUNNER > 默认推断 <core 目录>/../../collab-kit/opencode-run.mjs。
   * 不写死模型枚举：模型清单一律来自 `--list-models` 探测（避免重演 ZB-31「档位表变了但代码写死」的坑）。 */
  const opencodeExplicitEmpty = options.opencodeRunnerPath === '';
  const opencodeRunnerPath = opencodeExplicitEmpty
    ? null
    : resolve(String(options.opencodeRunnerPath ?? process.env.DSP_OPENCODE_RUNNER ?? join(CORE_DIR, '..', '..', 'collab-kit', 'opencode-run.mjs')));
  const opencodeMaxModels = Math.max(0, Number(options.opencodeMaxModels) || 0); // 0 = 不限
  /* 是否真去探测 OpenCode（async spawn）。为什么要有这道闸：
   *   ① 显式配置了执行器（option 或 env）⇒ 总是探测（含测试注入场景 —— 那时是调用方自己指定的路径）；
   *   ② 只有**默认推断**出来的路径 ⇒ 仅在「真实运行」时探测：没有注入 channelsProbeImpl / channelsImpl
   *      （那两个是测试与宿主替身钩子）。替身在场时真 spawn 子进程会让既有确定性测试变脆/变慢，
   *      更可能真去启动用户机器上的 OpenCode（违反硬约束「不碰用户自己的 OpenCode 配置与数据」）；
   *   ③ 显式空串 ⇒ 不探测（通道为空 + 一条可读 warning）。 */
  const opencodeProbeEnabled = !opencodeExplicitEmpty
    && (options.opencodeRunnerPath != null || !!process.env.DSP_OPENCODE_RUNNER || (!channelsProbeImpl && !channelsImpl));

  const nowMs = () => {
    const v = options.now ? options.now() : Date.now();
    return v instanceof Date ? v.getTime() : Number(v);
  };

  for (const d of [dirLocks, dirState, dirLogs]) mkdirSync(d, { recursive: true });
  mkdirSync(join(dirLocks, FILE_LOCK_DIR), { recursive: true }); // ZB-08：细粒度文件锁表落点

  /* ---------- 内存态：job 本体保持纯 JSON；child/watchdog 等不可序列化对象放侧表 ---------- */
  const jobs = new Map(); // id -> job（公开字段，纯 JSON）
  const children = new Map(); // id -> ChildProcess
  const watchdogs = new Map(); // id -> Timeout
  const killRequested = new Set();
  const tails = new Map(); // id -> string[]
  const evicted = new Set(); // 已按容量淘汰的 job id（persist 时不再从磁盘采纳）
  const subscribers = new Set();
  let queue = []; // 等待中的 jobId，FIFO
  let seqCounter = 0;
  // Z6：默认通道与自动降级链（持久化于 workRoot/state，绝不写 $DSH_HOME）
  const channelFile = join(dirState, 'channel.json');
  const fallbackFile = join(dirState, 'fallback.json');
  /* ZB-82（用户要求）：**分流模式**（split mode）—— 主通道名额将满时，把新任务
   * 自动派给**降级通道**（它名额独立），从而"用两条通道拿到更大的实际并发"。
   * 持久化在 <workRoot>/state/split.json（与 channel/fallback 同范式：原子写、可读回、面板可设）。 */
  const splitFile = join(dirState, 'split.json');
  /* ZB-44：通道 → 引擎**快照**（listChannels 成功后落盘 <workRoot>/state/channels.json）。
   * 为什么要落盘：`dispatch()` / `startJob()` 是**同步**函数，需要在不能 await listChannels() 的前提下
   * 把「用户选的 provider id」映射到引擎（例如面板上的 opencode 通道 id）。读失败一律 fail-open
   * （engineById={} ⇒ 全部按默认引擎 zcode），绝不因为它抛错。 */
  const channelsFile = join(dirState, 'channels.json');
  let engineById = {};
  let engineMapFingerprint = null;
  let channel = { provider: 'plan', model: null, reasoningLevel: 'agent' }; // ZB-29d：通道默认思考强度（'agent'=Agent决定，给派发 Agent 的规定）
  /* ZB-30：自动降级**目标**（有序）。旧形状只是通道 id 列表，新形状每项还带 model/reasoningLevel
   * （面板开启降级后可选模型与思考强度，与「通道」分区同形）。null 字段 = 沿用原任务该维度。 */
  let fallbackTargets = [];

  /* ── ZB-52：**顺序派发**（用户要求）──
   * 「模型」下拉里的「顺序派发」= 按**面板显示的模型顺序从上自下**依次尝试：
   * 前一个报错就换下一个，直到成功或用完整个列表。**每通道（引擎）各自一份顺序**。
   *
   * 解决的现实问题：免费模型有额度上限 / 用的人太多会临时报错 —— 逐个试过去总能撞上一个可用的。
   *
   * 实现要点（**复用既有交接机制**，不新造调度器）：
   *   失败时（见下方的顺序派发触发点）把该引擎的顺序列表展开成**模型级目标链**，
   *   交给既有的 `retry(provider/model)` 做交接重跑 —— 它有五要素提示词、跳数封顶、attempts 审计。
   *   ⚠️ 换模型 = 换进程（甚至换引擎）⇒ **会话无法继承**，只能是"新会话 + 交接提示词接着做"；
   *   磁盘上已完成的改动仍然留着。 */
  const sequentialFile = join(dirState, 'sequential.json');
  /* ── ZB-58（用户要求，参照模型选择器）：**逐模型开关** ──
   * 关掉的模型 ⇒ 不出现在面板的「模型」选项里，也不参与顺序派发链。
   * 存储：`<workRoot>/state/models.json` = `{version:1, disabled:[<路由id>...], updatedAt}`。
   * **用"禁用清单"而不是"启用清单"**：新探测到的模型默认**可用**（不会被静默藏起来），
   * 用户只需关心自己关掉的那几个 —— 否则上游新增模型会默认不可见，那是更坏的默认。 */
  const modelsFile = join(dirState, 'models.json');
  let disabledModels = new Set();
  /* ZB-57（用户反馈「加载有点久」）：档位探测结果**落盘**。
   * 真机上 Qoder `--with-efforts` 约 2 分钟；原先结论只存在**内存**里 ⇒ **每次重启 DSH 都要重等 2 分钟**。
   * 落盘后：首次探测一次，之后启动即读盘（秒级），并在后台按 TTL 静默刷新。
   * ⚠️ 只是**缓存上次真实探测结果**，不编造；文件损坏/过期 ⇒ 当作没有（fail-open）。 */
  const effortCacheFile = join(dirState, 'effort-cache.json');
  /* 落盘值的"可用"时长：比内存刷新 TTL（30 分钟）长得多 —— 档位随模型目录变化，但变得很慢。
   * 6 小时内的上次结论直接可用；超时才重新探测。 */
  const EFFORT_DISK_TTL_MS = 6 * 60 * 60 * 1000;
  /** order[engine] = 该引擎的有序项（`{route, reasoningLevel}`）；`route` 形如
   *  `<通道id>::<模型名>`（ZCode）或 `<model>`（opencode/qoder）。
   *
   *      关闭 ⇒ 派发不再走顺序链，面板「模型」下拉也不再出现「顺序派发」选项。
   *   ② **激活条件**（精确到通道）：该通道的 `model` 为空 ⇒ 用该引擎的顺序列表。
   *  早先去掉的是"②的独立开关"（那会与模型值自相矛盾）；①是功能级开关，不矛盾 ——
   *  关掉时连选项都不出现，自然不存在"开着却没生效"的中间态。 */
  let seqOrder = {};
  /** 顺序派发在当前任务上的交接状态：jobId → { engine, chain:[{provider,model,reasoningLevel}], idx }。 */
  const seqRuns = new Map();

  const isTerminal = (job) => TERMINAL_STATES.has(job.state);
  const nextId = () => `j-${Date.now().toString(36)}-${(seqCounter++).toString(36)}-${randomBytes(2).toString('hex')}`;

  /** 历史记录/外部写入的 job 可能缺数组字段，统一补齐（jobs.json 手改坏也不崩）。 */
  function normalizeJob(j) {
    if (!j || typeof j !== 'object') return j;
    if (!Array.isArray(j.parseWarnings)) j.parseWarnings = [];
    if (!Array.isArray(j.tailLines)) j.tailLines = [];
    if (!Array.isArray(j.attempts)) j.attempts = []; // Z6 交接链（[{jobId,provider,model,reason,at}]）
    if (!j.usage || typeof j.usage !== 'object') {
      j.usage = { requests: null, inputTokens: null, outputTokens: null, cacheReadTokens: null };
    }
    return j;
  }

  function serialize(job) {
    const out = {
      ...job,
      usage: { ...job.usage },
      spec: { ...job.spec },
      tailLines: [...(tails.get(job.id) ?? job.tailLines ?? [])],
      parseWarnings: [...(job.parseWarnings ?? [])],
    };
    if (out.state === 'running' && out.startedAt != null) {
      out.elapsedSec = Number(((nowMs() - Date.parse(out.startedAt)) / 1000).toFixed(3));
    }
    /* ZB-28：排队可观测 —— queued job 附带 lockWait（被谁挡住/前方几个/预计等待），其余状态恒 null。 */
    out.lockWait = out.state === 'queued' ? lockWaitFor(job) : null;
    return out;
  }

  function emit(type, payload) {
    /* ZB-26（审计 B3）：每次 job 状态广播即视为一次更新 —— 在这里统一盖时间戳，
     * 不必去改十几处 emit 调用点；多进程 persist 按 updatedAt 合并时需要它准确反映"谁更新"。 */
    if (type === 'job-updated' && payload && typeof payload === 'object') payload.updatedAt = nowMs();
    const qs = type === 'queue-changed' ? queueSnapshot() : null;
    for (const fn of subscribers) {
      try {
        fn(type === 'queue-changed' ? { type, snapshot: qs } : { type, job: serialize(payload) });
      } catch { /* 订阅者异常不打断派发器与其他订阅者 */ }
    }
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscribe(fn): fn 必须是函数');
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  function queueSnapshot() {
    return {
      workRoot,
      maxConcurrent,
      /* ZB-44：每引擎并发上限与当前运行数（既有字段全部保留，只**增补**）。 */
      maxConcurrentOpenCode,
      queued: [...queue],
      running: [...jobs.values()].filter((j) => j.state === 'running').map((j) => j.id),
      runningByEngine: { zcode: runningCountByEngine('zcode'), opencode: runningCountByEngine('opencode') },
    };
  }

  /**
   * 原子持久化全部 job。写前采纳磁盘上本进程不认识的记录（缓解多进程共用 workRoot 互相覆盖）；
   * 超容量时淘汰最老的终态 job（内存与文件同步收缩）。
   */
  /**
   * ZB-05：淘汰 job 时删除它**专属**的捕获日志（logs/<id>.{out,err}.log）。
   *
   * 语义自洽（不是新策略）：记录被淘汰后，`tail()` 再也找不到它（上层只会得到"找不到 job"），
   * 这两个文件因此**没有任何读取方** = 纯垃圾。不删则每任务留 2 个文件、永不复用，
   * 是全包唯一无界增长的目录；删除后插件侧日志与 jobs.json 一起被 JOBS_FILE_CAP 封顶。
   * （面板「✕」(dismiss) 只是隐藏、记录仍在，tail 仍可用 ⇒ **不在此删除**。）
   *
   * ⚠️ 安全：`jobs.json` 是**可被手工编辑**的外部输入，`captureOut/captureErr` 属不可信数据，
   * 必须校验目标确实落在 `dirLogs` 内 —— 绝不让淘汰逻辑变成任意路径删除。
   * 任何失败都只是"没删掉"，绝不影响淘汰与写盘本身。
   */
  /**
   * 目标路径是否确实落在 root 目录**内部**（越界 / 目录本身 / 非法输入一律 false）。
   *
   * ZB-26（审计 B4）：抽成公共判定。原先只有**删除**路径做了这道检查，
   * 而 `tail()` 的**读取**路径没有 —— `jobs.json` 是可被手工编辑的外部输入，
   * 把某条 job 的 `captureOut` 指到 `C:\Users\x\.ssh\id_rsa` 就能让面板/agent 工具读到任意文件。
   */
  function isUnder(root, p) {
    if (typeof p !== 'string' || p === '') return false;
    try {
      const rel = relative(root, resolve(p));
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    } catch { return false; }
  }

  /** 允许作为「runner 输出日志」读取的根（全部来自 config，不是 jobs.json 这种不可信输入）。 */
  const allowedLogRoots = (
    Array.isArray(options.allowedLogRoots) && options.allowedLogRoots.length
      ? options.allowedLogRoots
      : [dirLogs, workRoot, runnerCwd]
  ).map((p) => resolve(p));

  function dropCaptureFiles(job) {
    for (const f of [job.captureOut, job.captureErr]) {
      if (typeof f !== 'string' || f === '') continue;
      try {
        if (!isUnder(dirLogs, f)) continue; // 越界或目录本身：拒绝（与 tail 的读取校验同一判定）
        unlinkSync(f);
      } catch { /* 不存在/被占用：忽略 */ }
    }
  }

  function persist() {
    if (existsSync(jobsFile)) {
      try {
        const onDisk = JSON.parse(readFileSync(jobsFile, 'utf8'));
        for (const j of onDisk.jobs ?? []) {
          if (evicted.has(j.id)) continue;
          const mine = jobs.get(j.id);
          if (mine === undefined) { jobs.set(j.id, normalizeJob(j)); continue; }
          /* ZB-26（审计 B3，丢失更新）：原先只采纳「本进程不认识的 id」——
           * 一旦采纳过某条记录，之后盘上更新的版本（别的进程写的终态）就被本进程的旧副本覆盖掉，
           * 即注释自称的"缓解多进程互相覆盖"只覆盖插入、不覆盖更新，缓解不成立。
           * 改为**按 updatedAt 合并**：盘上更新则采纳盘上；两边都没有 updatedAt（旧快照）时保持旧行为（不覆盖）。 */
          const diskAt = Number(j.updatedAt) || 0;
          const mineAt = Number(mine.updatedAt) || 0;
          if (diskAt > mineAt) jobs.set(j.id, normalizeJob(j));
        }
      } catch { /* 损坏的 jobs.json 不阻断本进程写入 */ }
    }
    let all = [...jobs.values()].sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
    if (all.length > JOBS_FILE_CAP) {
      for (const j of all.slice(0, all.length - JOBS_FILE_CAP)) {
        if (!isTerminal(j)) continue; // 只淘汰终态
        /* ZB-26（审计 B3）：只淘汰**本进程拥有**的记录 —— 别进程正在用的记录被本进程删掉，
         * 会连带删掉它的捕获日志（dropCaptureFiles），而对方下一次 persist 又写回来，反复抖动。 */
        if (j.ownerPid != null && j.ownerPid !== process.pid) continue;
        dropCaptureFiles(j); // ZB-05：连它的捕获日志一起回收（否则该目录无界增长）
        jobs.delete(j.id);
        tails.delete(j.id);
        evicted.add(j.id);
      }
      all = [...jobs.values()].sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
    }
    atomicWrite(jobsFile, `${JSON.stringify({ version: 1, savedAt: new Date(nowMs()).toISOString(), jobs: all }, null, 2)}\n`);
  }

  /**
   * 启动恢复：上次残留 running → interrupted（记录原因）；残留 queued 一并终结
   * （重启后原队列上下文已不存在）。
   *
   * ZB-26（审计 B2，真机语义反转）：**不能无条件改写**。`bin/dispatch.mjs` 的每个子命令都会构造
   * dispatcher（因而调用本函数），于是 `zcd kill <运行中的 job>` 会先在**本进程内存里**把
   * 那个活 job 改成 interrupted ⇒ `kill()` 立刻 `isTerminal → return false`（运行中的任务无法终止、
   * 进程泄漏），`zcd retry` 的 running 守卫也被绕过 ⇒ 同一任务被重复派发。
   * 判据：落盘时记 `ownerPid`；只有当 ownerPid 已不存在时才认定是残留。
   * 字段缺失（ZB-26 之前的旧快照）= 旧语义，一律按残留终结（保持既有测试与行为）。
   */
  function restore() {
    if (!existsSync(jobsFile)) return [];
    const changed = [];
    try {
      const data = JSON.parse(readFileSync(jobsFile, 'utf8'));
      for (const j of data.jobs ?? []) {
        if (jobs.has(j.id)) continue;
        normalizeJob(j);
        const legacy = j.ownerPid == null;
        const ownerAlive = !legacy && j.ownerPid === process.pid ? true : !legacy && pidAlive(j.ownerPid);
        const stale = legacy || !ownerAlive;
        if (j.state === 'running' && stale) {
          j.state = 'interrupted';
          j.interruptReason = legacy
            ? 'dispatcher restarted while run was in flight'
            : `dispatcher restarted while the owning process (pid ${j.ownerPid}) is gone`;
          j.finishedAt = new Date(nowMs()).toISOString();
          changed.push(j.id);
        } else if (j.state === 'queued' && stale) {
          j.state = 'interrupted';
          j.interruptReason = 'dispatcher restarted before the queued job started';
          j.finishedAt = new Date(nowMs()).toISOString();
          changed.push(j.id);
        }
        jobs.set(j.id, j);
      }
    } catch (e) {
      console.error(`[dsp-core] jobs.json 读取失败，按空状态启动: ${e.message}`);
    }
    return changed;
  }

  /* ---------- 锁与队列 ---------- */
  /* 锁集合的计算（ZB-16：删除 memory 锁；repo 锁的粒度由 write 决定）。
   *
   * 用户要求（本轮的模型重设计）：
   *   · repo 锁要**明确锁哪些文件**，哪个进程锁哪些文件；
   *   · 不同进程锁不同文件、没有竞写关系的，**允许并发执行**；
   *   · 删除 memory 相关（ZCode 记忆写入改由默认注入的提示词禁令约束）。
   *
   * 三档：
   *   · spec.write 非空            ⇒ **只锁这些文件**（不同文件集可并发 —— 这正是用户要的）
   *   · spec.lock === 'none'       ⇒ 不取锁（调用方明确知道无竞写关系）
   *   · 其它（含缺省 'repo'）      ⇒ 锁**整仓库**（粗粒度；单写者纪律本义）
   */
  function locksFor(spec) {
    const decl = normalizeWriteSet(spec && spec.write);
    if (decl.length > 0) {
      return decl.map((p) => ({ name: 'file', path: fileLockPath(dirLocks, p), file: p }));
    }
    if (spec.lock === 'none') return []; // 明确不取锁
    return [{ name: 'repo', path: repoLockPath }]; // 默认（含 spec.lock === 'repo'）：整仓库
  }

  /** 归一化声明的写入集：去空、去重（归一化后）、排序（保证加锁顺序一致 ⇒ 防死锁）。
   *  返回绝对路径数组；非法输入（非数组/空数组）返回 []，调用方据此回退粗粒度锁。 */
  function normalizeWriteSet(write) {
    if (!Array.isArray(write)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of write) {
      if (typeof raw !== 'string') continue;
      const s = raw.trim();
      if (!s) continue;
      const norm = normalizeForLock(s);
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
    }
    // 排序 ⇒ 所有任务对同一组文件的加锁顺序一致，避免 A 等 B、B 等 A 的循环等待
    out.sort();
    return out;
  }

  /** 当前全部文件锁（供 UI 与诊断）。返回 [{file, jobId, tag, at, pid, heldSec}] */
  function listFileLocks() {
    const dir = join(dirLocks, FILE_LOCK_DIR);
    if (!existsSync(dir)) return [];
    const out = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.lock')) continue;
      const f = join(dir, name);
      const rec = readLockFile(f);
      if (!rec) continue;
      const heldSec = Math.max(0, Math.round((nowMs() - (Date.parse(rec.at) || nowMs())) / 1000));
      const owner = jobs.get(rec.jobId);
      out.push({
        file: Array.isArray(rec.paths) && rec.paths[0] ? rec.paths[0] : '(unknown)',
        paths: Array.isArray(rec.paths) ? rec.paths : [],
        jobId: rec.jobId,
        tag: owner ? owner.tag ?? null : null,
        at: rec.at ?? null,
        pid: rec.pid ?? null,
        heldSec,
      });
    }
    return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }

  /** 清理过期的文件锁（与 repo/memory 锁同一套过期判据：2h 或持有进程已死）。 */
  function sweepFileLocks() {
    const dir = join(dirLocks, FILE_LOCK_DIR);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.lock')) continue;
      const f = join(dir, name);
      const rec = readLockFile(f);
      if (rec && isStaleLock(rec, f, nowMs())) {
        try {
          unlinkSync(f);
        } catch { /* 竞争失败无妨，下一轮再清 */ }
      }
    }
  }

  /** 判断某任务此刻能否拿到锁（只判不锁），用于「为什么在排队」的提示。 */
  function lockBlockersFor(spec) {
    const locks = locksFor(spec);
    const blockers = [];
    for (const l of locks) {
      if (!existsSync(l.path)) continue;
      const rec = readLockFile(l.path);
      if (!rec || rec.jobId === spec.__jobId) continue;
      if (isStaleLock(rec, l.path, nowMs())) continue;
      blockers.push(l.name === 'file' ? `file:${l.file}` : l.name);
    }
    /* ZB-16：把跨层级阻塞也算进去，否则"为什么排队"会漏报（用户看面板时会困惑）。 */
    const cross = crossLevelBlocked({ id: spec.__jobId }, locks);
    if (cross) blockers.push(`cross:${cross}`);
    return blockers;
  }

  /* ─────────────── ZB-28：排队可观测（lockWait） ───────────────
   * 用户要求：被整仓锁挡住时不再盲等 —— list/get 直接给出「前面有谁/几个/预计等待」。
   *
   * queued job 的 lockWait 结构（其余状态恒 null）：
   *   position    全局队列位置（1 起）
   *   queuedTotal 当前队列总长
   *   ahead       与自己**同类**（文件锁任务 / 整仓库锁任务，与 pump 放行优先级一致）
   *               且排在前面的任务数（同类内 FIFO，这就是要等的人数）
   *   aheadIds    上述任务的 id（截前 10 个，防长队列撑爆快照）
   *   blockers[]  此刻挡住本任务的锁与持有者：{ lock, holderJobId, holderTag,
   *               holderState, holderElapsedSec, holderTimeoutMin, holderRemainingSec }
   *   estWaitSec  预计等待秒数（**上界**）：仅当每个阻塞者都声明了 timeoutMin 时可估
   *               = max(timeoutMin*60 + 看门狗宽限 − 已运行秒数)；否则 null（不猜）
   *   estWaitNote 中文说明：估计怎么来的 / 为什么是 null
   *
   * 只读（检查锁文件 + 读内存 job），绝不加锁、绝不清理 —— 观测不能改变调度状态。
   */
  function lockWaitFor(job) {
    if (!job || job.state !== 'queued') return null;
    const graceSec = timeoutGraceMs / 1000;
    const dedupePush = (b) => {
      if (b && !blockers.some((x) => x.holderJobId === b.holderJobId && x.lock === b.lock)) blockers.push(b);
    };
    const holderBlocker = (lockLabel, rec) => {
      if (!rec) return null;
      const holder = jobs.get(rec.jobId) ?? null;
      const elapsedSec = holder && holder.state === 'running' && holder.startedAt
        ? Math.max(0, Math.round((nowMs() - Date.parse(holder.startedAt)) / 1000))
        : (rec.at ? Math.max(0, Math.round((nowMs() - Date.parse(rec.at)) / 1000)) : null);
      const timeoutMin = holder && holder.spec ? holder.spec.timeoutMin ?? null : null;
      const remainingSec = timeoutMin != null && elapsedSec != null
        ? Math.max(0, Math.ceil(timeoutMin * 60 + graceSec - elapsedSec))
        : null;
      return {
        lock: lockLabel,
        holderJobId: rec.jobId ?? null,
        holderTag: holder ? holder.tag ?? null : null,
        holderState: holder ? holder.state ?? null : null,
        holderElapsedSec: elapsedSec,
        holderTimeoutMin: timeoutMin,
        holderRemainingSec: remainingSec,
      };
    };
    const blockers = [];
    const locks = locksFor(job.spec);
    for (const l of locks) {
      if (!existsSync(l.path)) continue;
      const rec = readLockFile(l.path);
      if (!rec || rec.jobId === job.id || isStaleLock(rec, l.path, nowMs())) continue;
      dedupePush(holderBlocker(l.name === 'file' ? `file:${l.file}` : l.name, rec));
    }
    /* 跨层级阻塞（整仓库锁 vs 文件锁，见 crossLevelBlocked）同样计入。 */
    const cross = crossLevelBlocked(job, locks);
    if (cross) {
      if (cross.startsWith('repo:')) {
        if (existsSync(repoLockPath)) {
          const rec = readLockFile(repoLockPath);
          if (rec && `repo:${rec.jobId}` === cross) dedupePush(holderBlocker(`cross:${cross}`, rec));
        }
      } else {
        const wantFile = cross.slice('file:'.length);
        const rec = readLockFile(join(dirLocks, FILE_LOCK_DIR, `${hashPath(wantFile)}.lock`));
        if (rec) dedupePush(holderBlocker(`cross:${cross}`, rec));
      }
    }
    /* 队列位置与同类前方任务（与 pump 的优先级排序同尺：文件锁任务在前，同类内 FIFO）。 */
    const pos = queue.indexOf(job.id);
    const myClassIsFile = isFileLockSpec(job.spec);
    const aheadIds = [];
    for (const id of queue) {
      if (id === job.id) break;
      const q = jobs.get(id);
      if (q && isFileLockSpec(q.spec) === myClassIsFile && aheadIds.length < 10) aheadIds.push(id);
    }
    const ahead = aheadIds.length;
    let estWaitSec = null;
    let estWaitNote;
    if (blockers.length === 0) {
      estWaitNote = ahead > 0
        ? `无锁冲突；等同类前方 ${ahead} 个任务与并发额度（它们的时长未知，不猜测）`
        : '无锁冲突；等并发额度释放（前序任务时长未知，不猜测）';
    } else {
      const withRemain = blockers.filter((b) => b.holderRemainingSec != null);
      if (withRemain.length === blockers.length) {
        estWaitSec = Math.max(...withRemain.map((b) => b.holderRemainingSec));
        estWaitNote = '上界估计：按阻塞者 timeoutMin+看门狗宽限 − 已运行时间（到点看门狗会放行），非精确预测';
      } else {
        estWaitNote = '有阻塞者未声明 timeoutMin（跑多久不可知），不猜测等待时长';
      }
      if (ahead > 0) estWaitNote += `；前方同类还有 ${ahead} 个，实际更久`;
    }
    return {
      position: pos >= 0 ? pos + 1 : null,
      queuedTotal: queue.length,
      ahead,
      aheadIds,
      blockers,
      estWaitSec,
      estWaitNote,
    };
  }

  /* ZB-16：**跨层级冲突检查**（实测抓到的真实安全缺口）。
   *
   * 问题：`repo.lock`（整仓库）与 `files/*.lock`（某几个文件）是两套互不知情的锁文件 ——
   * 一个任务持整仓库锁时，另一个任务锁某文件却**照常 running**（实测 actual='running'）。
   * 但"整仓库写"**涵盖所有文件** ⇒ 二者必然有竞写关系，必须互斥。
   *
   * 判据（保守且正确）：
   *   · 想拿文件锁时：若 repo.lock 被**别人**持有 ⇒ 冲突（整仓库涵盖该文件）
   *   · 想拿整仓库锁时：若 locks/files/ 下**任何**文件锁被**别人**持有 ⇒ 冲突
   *     （我们无法证明那些文件与"整仓库写"无交集 ⇒ 按保守原则视为冲突）
   *
   * 注意：这里只做**检查**，不引入新的锁文件；"谁持有"仍由既有锁体记录，
   * UI 展示逻辑不变（用户要求"显示被锁文件与对应进程"已由 listFileLocks 满足）。
   */
  function crossLevelBlocked(job, locks) {
    /* ⚠️ ZB-80（2026-10-20 真机踩到的静默 bug）：**`locks` 为空 = 明确不取锁，必须直接放行**。
     *
     * 现场：`dispatch({ lock: 'none' })`（= 教学文档承诺的"明确不取锁"）的任务，
     * 仍被**别的会话**持有的文件锁挡住，`lockWait.blockers` 显示
     * `cross:file:…/smoke` —— 排在队列里**等一个它根本不需要的锁**。
     *
     * 根因：本函数原先只看"**想要哪种锁**"（`locks` 里有 file ⇒ 查 repo 锁；否则 ⇒ 查 file 锁），
     * 没有先判"**到底想不想要锁**"。`locksFor(spec)` 对 `lock:'none'` 返回**空数组**，
     * 而空数组落进 `else` 分支 ⇒ 被当成"想拿整仓库锁" ⇒ 去查别人的文件锁 ⇒ 挡住。
     *
     * 修法：空锁集 ⇒ 返回 null（无跨层级冲突）。这与 `locksFor` 的注释
     * （"`lock === 'none'` ⇒ 明确不取锁"）以及教学文档的承诺**一致**。
     * `tryAcquire` 拿到空锁集时也会走同一判据 ⇒ 两个入口行为一致（不再一个放行一个挡住）。 */
    if (!locks || locks.length === 0) return null; // 明确不取锁 ⇒ 无冲突可言
    const isFileLock = locks.some((l) => l.name === 'file');
    if (isFileLock) {
      // 想拿文件锁 ⇒ 看整仓库锁是否被别人持有
      if (existsSync(repoLockPath)) {
        const rec = readLockFile(repoLockPath);
        if (rec && rec.jobId !== job.id && !isStaleLock(rec, repoLockPath, nowMs())) return `repo:${rec.jobId}`;
      }
      return null;
    }
    // 想拿整仓库锁（或 none 以外的粗粒度锁）⇒ 看是否有别人持文件锁
    const dir = join(dirLocks, FILE_LOCK_DIR);
    if (!existsSync(dir)) return null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.lock')) continue;
      const f = join(dir, name);
      const rec = readLockFile(f);
      if (!rec || rec.jobId === job.id) continue;
      if (isStaleLock(rec, f, nowMs())) continue;
      return `file:${(rec.paths && rec.paths[0]) || name}`;
    }
    return null;
  }

  function tryAcquire(job, locks) {
    /* ZB-16：先做跨层级冲突检查 —— 否则"整仓库锁"与"文件锁"会互相无视（实测缺口）。 */
    const cross = crossLevelBlocked(job, locks);
    if (cross) return false;
    const got = [];
    const at = new Date(nowMs()).toISOString();
    for (const l of locks) {
      // ZB-08/16：文件锁的锁体回存 paths，让 UI 能显示「哪个文件被谁锁着」。
      // ⚠️ ZB-16 实测修正：初版把**整组** paths 写进**每一把**文件锁 ⇒
      // listFileLocks 取 rec.paths[0] 时，同一 job 的 N 把锁都显示成第一个文件
      // （实测：锁 {a.ts,b.ts} 的任务在面板上显示 a.ts 两次、b.ts 永不出现）。
      // 每把锁只记录**它自己**那个文件，其余（同一 job 的其它文件）由 job.lockPaths 表达。
      const info = {
        jobId: job.id,
        pid: process.pid,
        at,
        lock: l.name,
        ...(l.name === 'file' ? { paths: [l.file].filter(Boolean) } : {}),
      };
      const ok = acquireLockFile(l.path, info, nowMs());
      if (!ok) {
        for (const g of got.reverse()) releaseLockFile(g.path, job.id); // 拿不全则全放
        return false;
      }
      got.push(l);
    }
    job.lock = locks.map((l) => (l.name === 'file' ? `file:${l.file}` : l.name)).join('+');
    /* ⚠️ ZB-08 实测修正：初版用 `Object.fromEntries(locks.map(l => [l.name, l.path]))`，
     * 而文件锁的 name 都是 'file' ⇒ 多把文件锁**折叠成一个键**，只记住最后一把，
     * releaseLocks 于是漏放其余文件锁 ⇒ 那些文件被**永久锁死**（实测：任务 done 后仍残留
     * 一把锁，后续写同一文件的任务永远排队等待 —— 表现为 20s 超时）。
     * 键必须唯一：文件锁用路径，粗粒度锁用名字。 */
    job.lockPaths = Object.fromEntries(locks.map((l) => [l.name === 'file' ? `file:${l.file}` : l.name, l.path]));
    return true;
  }

  function releaseLocks(job) {
    for (const [, path] of Object.entries(job.lockPaths ?? {})) releaseLockFile(path, job.id);
    delete job.lockPaths;
  }

  /** ZB-17：某 spec 是否是"文件锁任务"（声明了 write ⇒ 文件级锁，可并行）。 */
  function isFileLockSpec(spec) {
    return normalizeWriteSet(spec && spec.write).length > 0;
  }

  function runningCount() {
    let n = 0;
    for (const j of jobs.values()) if (j.state === 'running') n += 1;
    return n;
  }

  /* ZB-44：**每引擎**并发（OpenCode 必须与 ZCode 分开计数 —— 见上面 maxConcurrentOpenCode 的实测理由）。
   *   引擎判据 = job.spec.engine（缺省/未知 ⇒ 默认引擎 zcode，含升级前的老 jobs.json）。
   *   上限 = opencode ⇒ maxConcurrentOpenCode；其余 ⇒ maxConcurrent（全局）。
   *   全局 maxConcurrent 仍然生效（pump 的 while 条件），故实际并发 = min(全局, 本引擎上限)。 */
  const engineOfJob = (job) => normalizeEngine(job?.spec?.engine);
  const engineLimit = (engine) => (normalizeEngine(engine) === 'opencode' ? maxConcurrentOpenCode
    : normalizeEngine(engine) === 'qoder' ? maxConcurrentQoder
      : maxConcurrent);
  function runningCountByEngine(engine) {
    const want = normalizeEngine(engine);
    let n = 0;
    for (const j of jobs.values()) if (j.state === 'running' && engineOfJob(j) === want) n += 1;
    return n;
  }

  /* ZB-17：**文件锁任务优先放行**（用户要求）。
   *
   * 旧实现是严格 FIFO + 队头阻塞：`if (!tryAcquire(head, …)) break;`
   * —— 队头拿不到锁就整个停。后果：一个整仓库锁任务排在前面时，
   * **后面本可并行的文件锁任务全被堵住**（实测过：T18 持整仓库锁 27 分钟，
   * 期间所有文件锁任务干等）。
   *
   * 新实现：按**优先级扫描**队列，取第一个能拿到锁的启动。
   *   · 优先级：文件锁任务（可并行）> 整仓库锁任务
   *   · **同类内保持 FIFO**（按 queue 原始顺序），故同类任务不会互相插队
   *   · 都不行则停（等别人释放）
   *
   * 与"整仓库锁执行时文件锁任务等待"的关系：那是 `crossLevelBlocked` 的职责
   * （整仓库锁涵盖所有文件 ⇒ 与任何文件锁冲突），本函数只决定**放行顺序**。
   *
   * ⚠️ 已知取舍（如实登记）：若文件锁任务持续不断地到来，队里的整仓库锁任务
   * 可能被长期推后（饥饿）。本轮按用户明确要求只做优先级、未加 aging；
   * 若实际出现饥饿，再加"等待超时后提升优先级"即可。
   *
   * ZB-44（**队头阻塞，硬约束**）：每引擎名额（opencode 独立上限）也在这一轮扫描里判定 ——
   * 名额满的任务**跳过**（`continue`）继续找下一个可启动的，**绝不 break**。
   * 否则一个满员的 OpenCode 任务会把队列后面本可运行的 ZCode 任务一起堵死
   * （本轮最关键的新断言，见 test/engine-routing.test.mjs ④）。
   */
  function pump() {
    while (queue.length > 0 && runningCount() < maxConcurrent) {
      const alive = queue.filter((id) => jobs.get(id));
      const dead = queue.filter((id) => !jobs.get(id));
      /* 优先级排序：文件锁任务在前（各自保持原队列序），整仓库锁任务在后，失效 id 最后。 */
      const ordered = [
        ...alive.filter((id) => isFileLockSpec(jobs.get(id).spec)),
        ...alive.filter((id) => !isFileLockSpec(jobs.get(id).spec)),
        ...dead,
      ];
      let picked = null;
      for (const id of ordered) {
        const j = jobs.get(id);
        if (!j) { picked = { id, dead: true }; break; }
        /* ZB-44：本引擎名额已满 ⇒ 跳过它（不 break），继续尝试后面的任务。 */
        const eng = engineOfJob(j);
        if (runningCountByEngine(eng) >= engineLimit(eng)) continue;
        if (tryAcquire(j, locksFor(j.spec))) { picked = { id, job: j }; break; }
      }
      if (!picked) break; // 没有任何任务能拿到锁/拿到名额 ⇒ 等释放
      queue = queue.filter((x) => x !== picked.id);
      if (picked.dead) continue; // 顺手清掉失效 id，继续尝试下一个
      startJob(picked.job);
      emit('queue-changed');
    }
  }

  /* ---------- job 生命周期 ---------- */
  /* ZB-16：**默认注入的「不写 ZCode 记忆」禁令**（用户要求）。
   *
   * 背景：ZCode 会在自己的记忆库（~/.zcode）里做自动 Memory 提取与写入。
   * 派发台把任务派出去时，我们不希望这些子任务污染/争抢那份记忆 ——
   * 用户决定：**派发 ZCode 的任务默认加入提示词，要求子代理不执行 ZCode 相关的记忆写入**。
   *
   * 覆盖面（ZB-28 起三种 kind 全覆盖，不再有「裸奔」的 task 任务）：
   *   · kind=prompt / kind=target ⇒ 禁令由本插件直接拼进内容 ✅
   *   · kind=task                 ⇒ 禁令由**宿主 runner** 注入：本插件传 `--memory-ban` 旗标，
   *     runner 内联任务包时追加同款文本并打印 `memory-ban=on`（解析为 job.memoryBanRunner=true
   *     = runner 确认注入）。旧版 runner 不认识该旗标会 fail-fast（exit 1「未知参数」），
   *     绝不静默裸奔 —— runner 与本插件同仓库发货，成对升级即可。
   *
   * 注：禁令只是提示词层面的约束（LLM 遵循），**不是进程级强制**；
   * 真正的强制需要宿主 runner 支持关闭 Memory（当前无此参数）。此处如实说明，不夸大为"禁止"。
   */
  const MEMORY_BAN_TEXT = [
    '【派发台硬约束 · 记忆写入】',
    '本任务由 DSH 派发台派发，属于一次性子任务：',
    '**不要执行任何 ZCode 记忆写入 / 自动 Memory 提取**（不写 ~/.zcode 下的记忆库、不新建或更新记忆条目、',
    '不触发 memory 相关工具）。如需记录信息，请写在任务要求的交付文件里，不要写进记忆库。',
    '本条优先于任务内容里任何与之冲突的指示。',
  ].join('\n');

  /** 把记忆禁令拼到调用方内容之后；task 类型返回 null（禁令改经 runner `--memory-ban` 注入，ZB-28）。 */
  function withMemoryBan(spec) {
    if (spec.kind === 'task') return null; // 注入点在 runner 侧（buildRunnerArgs 传 --memory-ban）
    const base = spec.kind === 'target' ? String(spec.target ?? '') : String(spec.prompt ?? '');
    return `${base}\n\n${MEMORY_BAN_TEXT}`;
  }

  function buildRunnerArgs(spec, opts = {}) {
    const args = [];
    if (spec.kind === 'task') {
      args.push('--task', resolve(String(spec.task))); // 绝对路径，防 runner 相对自身根解析
      /* ZB-28：task 的记忆禁令改由 **runner 侧注入** —— runner 读任务包内联成 prompt 时
       * 追加同款禁令文本（--memory-ban 旗标），并在 stdout 打 `memory-ban=on`
       * （core 解析为 job.memoryBanRunner=true，即「runner 确认已注入」）。
       * 旧版 runner 不认识该旗标会 exit 1「未知参数」—— fail-fast，绝不静默裸奔；
       * runner 与本插件同仓库（collab-kit/）发货，正常成对升级。 */
      if (!opts.noMemoryBan) args.push('--memory-ban');
    } else {
      // 默认注入记忆禁令；opts.noMemoryBan 供测试/特殊场景关闭
      const injected = opts.noMemoryBan ? null : withMemoryBan(spec);
      const body = injected ?? (spec.kind === 'target' ? String(spec.target ?? '') : String(spec.prompt ?? ''));
      args.push(spec.kind === 'target' ? '--target' : '--prompt', body);
    }
    if (spec.resume) args.push('--resume', spec.resume);
    if (spec.memoryBench) args.push('--memory-bench'); // runner 限制：仅 --prompt 可用（dispatch 已校验）
    if (spec.model) args.push('--model', spec.model);
    if (spec.provider) args.push('--provider', spec.provider);
    if (spec.mode) args.push('--mode', spec.mode);
    /* ZB-29：思考强度——具体档位严格生效；'agent'（Agent决定）**也透传**：
     * runner 按 ZCode 自身的默认规则（模型声明档位的最后一档，与 headless registry-fallback
     * 的 values.at(-1) 同语义）解析成实际档位并注入，回显 reasoning-level=<实际档> ⇒
     * job.reasoningLevelApplied 有值，进程上显示实际档位而非「Agent决定」字样。
     * 仅新建会话生效（resume 由 runner 警告并忽略）。 */
    if (spec.reasoningLevel) args.push('--reasoning-level', spec.reasoningLevel);
    if (spec.tag) args.push('--tag', spec.tag);
    if (spec.timeoutMin != null) args.push('--timeout-min', String(spec.timeoutMin));
    if (spec.cwd) args.push('--cwd', spec.cwd);
    return args;
  }

  /**
   * ZB-44：OpenCode 执行器的参数（与 `buildRunnerArgs` 同形，但**只拼 OpenCode 认识的东西**）。
   *
   * OpenCode **没有** `--mode` / `--provider` / `--memory-bench`（其校验在 validateSpec 就拦掉了，
   * 见「engine=opencode 不支持 mode」与「memoryBench 仅 ZCode」），所以这里绝不拼它们。
   * `--auto`：OpenCode 的工具调用**可能**需要权限审批；默认**不放行**是安全默认（它会放行所有
   * 未显式拒绝的权限）。需要时由调用方用显式的 `auto: true` 开启 —— 只有 true 才加，绝不默认加。
   *
   * kind 处理与 buildRunnerArgs 一致：task ⇒ `--task <abs>` + `--memory-ban`（禁令由执行器注入）；
   * prompt/target ⇒ 插件直接拼禁令进内容（同一个 withMemoryBan：禁令文本里的「不写 ~/.zcode 记忆库」
   * 对 OpenCode 同样成立 —— 派发子任务都不该写主会话/引擎的记忆库）。
   * 思考强度：`--variant <档>` **仅当档位是具体值**；`'agent'`（Agent决定）= 不覆盖，交给执行器按模型默认档。
   */
  function buildOpenCodeArgs(spec, opts = {}) {
    const args = [];
    if (spec.kind === 'task') {
      args.push('--task', resolve(String(spec.task))); // 绝对路径，防执行器相对自身根解析
      if (!opts.noMemoryBan) args.push('--memory-ban');
    } else {
      const injected = opts.noMemoryBan ? null : withMemoryBan(spec);
      const body = injected ?? (spec.kind === 'target' ? String(spec.target ?? '') : String(spec.prompt ?? ''));
      args.push(spec.kind === 'target' ? '--target' : '--prompt', body);
    }
    if (spec.resume) args.push('--resume', spec.resume); // OpenCode 侧 `-s <sessionID>` 的等价长参数
    /* ZB-45：**显式**放行（默认关 —— 硬约束「不默认开 --auto」）。
     * 只有 `spec.auto === true` 才加；其它任何取值（缺省/false/undefined）一律不加。
     * 执行器侧会打 `[opencode-run] auto=on（…）` 告知行，job.autoApproved 亦已落库（可审计）。 */
    if (spec.auto === true) args.push('--auto');
    if (spec.model) args.push('--model', spec.model);
    if (spec.reasoningLevel && spec.reasoningLevel !== 'agent') args.push('--variant', spec.reasoningLevel);
    if (spec.tag) args.push('--tag', spec.tag);
    if (spec.timeoutMin != null) args.push('--timeout-min', String(spec.timeoutMin));
    if (spec.cwd) args.push('--cwd', spec.cwd);
    return args;
  }

  /**
   * ZB-51（T4 前置）：Qoder 执行器的参数（与 `buildOpenCodeArgs` 同形，只拼 Qoder 认识的东西）。
   *
   * 参数依据是**真机抓包**（Qoder CLI CN v1.1.73，见 tasks/ZB-50-qoder-integration-spec.md §8）：
   *   · Qoder **没有** `--mode` / `--provider` / `--memory-bench` / `--variant`（校验在 validateSpec 拦掉）
   *   · 思考强度是 `--reasoning-effort <档>`（OpenCode 叫 `--variant`，ZCode 叫 `--reasoning-level`）
   *   · `auto:true` ⇒ 执行器侧映射为 `--permission-mode bypass_permissions`（**默认不放行**，
   *     由执行器补 `--permission-mode accept_edits` —— 权限模式的默认值与回落报警都在执行器里，
   *     core 只负责把"是否显式放行"这个事实传下去，与 OpenCode 的 `--auto` 同构）。
   * 记忆禁令的处理与另两个引擎一致（task ⇒ 执行器 `--memory-ban`；prompt/target ⇒ 直接拼进内容）。
   */
  function buildQoderArgs(spec, opts = {}) {
    const args = [];
    if (spec.kind === 'task') {
      args.push('--task', resolve(String(spec.task)));
      if (!opts.noMemoryBan) args.push('--memory-ban');
    } else {
      const injected = opts.noMemoryBan ? null : withMemoryBan(spec);
      const body = injected ?? (spec.kind === 'target' ? String(spec.target ?? '') : String(spec.prompt ?? ''));
      args.push(spec.kind === 'target' ? '--target' : '--prompt', body);
    }
    if (spec.resume) args.push('--resume', spec.resume);
    if (spec.auto === true) args.push('--auto');
    if (spec.model) args.push('--model', spec.model);
    if (spec.reasoningLevel && spec.reasoningLevel !== 'agent') args.push('--reasoning-effort', spec.reasoningLevel);
    if (spec.tag) args.push('--tag', spec.tag);
    if (spec.timeoutMin != null) args.push('--timeout-min', String(spec.timeoutMin));
    if (spec.cwd) args.push('--cwd', spec.cwd);
    return args;
  }

  function startJob(job) {
    job.state = 'running';
    job.startedAt = new Date(nowMs()).toISOString();
    /* ZB-44：引擎决定「spawn 哪个脚本 + 拼哪些参数」。缺省/未知（含升级前的老 jobs.json）= zcode。 */
    const engine = normalizeEngine(job.spec?.engine);
    job.engine = engine;
    const captureOut = join(dirLogs, `${job.id}.out.log`);
    const captureErr = join(dirLogs, `${job.id}.err.log`);
    job.captureOut = captureOut;
    job.captureErr = captureErr;
    writeFileSync(captureOut, '');
    writeFileSync(captureErr, '');

    /* 执行器缺失/未配置 ⇒ **可读失败**：不 spawn、不崩（增量引擎的缺失绝不该影响 ZCode 派发与 DSH 本体）。
     * spawn 一个不存在的脚本只会得到一句 "Cannot find module"，对排障毫无帮助，故这里前置判定。
     *
     * ZB-51（T2）：把原来的**二元判断**改成按引擎查表 —— 原先写的是
     *   `engine === 'opencode' ? opencodeRunnerPath : runnerPath`
     * 这是个真陷阱：一旦把第三个引擎（qoder）列进 ENGINES，它会**静默回落到 ZCode 执行器**，
     * 于是"派给 Qoder"实际跑了 ZCode，且没有任何报错。现在每个引擎有自己的执行器与"缺失"文案。 */
    const engineRunner = engine === 'opencode' ? opencodeRunnerPath
      : engine === 'qoder' ? qoderRunnerPath
        : runnerPath;
    if (!(engineRunner && existsSync(engineRunner))) {
      const label = engine === 'opencode' ? 'OpenCode' : engine === 'qoder' ? 'Qoder' : 'ZCode';
      const hint = engine === 'opencode'
        ? '请设置 opencodeRunnerPath 或 env DSP_OPENCODE_RUNNER 后重试'
        : engine === 'qoder'
          ? 'Qoder 执行器尚未接入（见 tasks/ZB-50-qoder-integration-spec.md）；在它落地前请改用 zcode/opencode 引擎'
          : '请设置 runnerPath 或 env DSP_FAKE_RUNNER 后重试';
      job.parseWarnings.push(`${engine}-executor-missing: ${label} 执行器${engineRunner ? `不存在：${engineRunner}` : '未配置'}；${hint}`);
      finalizeJob(job, { state: 'failed', exitCode: null });
      return;
    }

    let child;
    try {
      const enginePath = engineRunner;
      const engineArgs = engine === 'opencode' ? buildOpenCodeArgs(job.spec)
        : engine === 'qoder' ? buildQoderArgs(job.spec)
          : buildRunnerArgs(job.spec);
      child = spawnImpl(process.execPath, [enginePath, ...engineArgs], {
        cwd: runnerCwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      job.parseWarnings.push(`spawn-throw: ${e.message}`);
      finalizeJob(job, { state: 'failed', exitCode: null });
      return;
    }
    children.set(job.id, child);

    // dispatcher 侧看门狗：runner 自身有 --timeout-min（超时 exit 124），这里只兜底防 runner 挂死
    const specTimeoutMs = job.spec.timeoutMin != null ? Number(job.spec.timeoutMin) * 60000 : null;
    if (specTimeoutMs != null && Number.isFinite(specTimeoutMs) && specTimeoutMs > 0) {
      /* ZB-28：看门狗何时开火落到 job 字段（watchdogSec = timeoutMin*60 + 宽限秒），
       * 让 list/面板能回答「这个任务最晚什么时候被强制终止」。 */
      job.watchdogSec = Number(((specTimeoutMs + timeoutGraceMs) / 1000).toFixed(1));
      const t = setTimeout(() => {
        if (isTerminal(job)) return;
        job.timedOut = true;
        job.timedOutBy = 'watchdog'; // ZB-28：与 runner 自身超时（timedOutBy='runner'，exit 124）区分
        job.parseWarnings.push(`dispatcher watchdog fired after ${(specTimeoutMs + timeoutGraceMs) / 1000}s`);
        kill(job.id, 'watchdog-timeout');
      }, specTimeoutMs + timeoutGraceMs);
      watchdogs.set(job.id, t);
    }

    const feed = (stream, file) => {
      let fd;
      try {
        fd = openSync(file, 'a');
      } catch {
        fd = null; // 捕获文件打不开不阻断解析
      }
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        if (fd != null) {
          try {
            writeSync(fd, chunk);
          } catch { /* 捕获写失败不影响解析 */ }
        }
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          handleLine(job, buf.slice(0, idx).replace(/\r$/, ''));
          buf = buf.slice(idx + 1);
        }
      });
      const flush = () => {
        if (buf.trim()) handleLine(job, buf.replace(/\r$/, ''));
        buf = '';
        if (fd != null) {
          try {
            closeSync(fd);
          } catch { /* 已关 */ }
          fd = null;
        }
      };
      stream.on('end', flush);
      stream.on('error', flush);
    };
    feed(child.stdout, captureOut);
    feed(child.stderr, captureErr);

    child.on('error', (e) => {
      if (!isTerminal(job)) {
        job.parseWarnings.push(`spawn-error: ${e.message}`);
        finalizeJob(job, { state: 'failed', exitCode: null });
      }
    });
    child.on('close', (code, signal) => {
      if (!isTerminal(job)) {
        const requested = killRequested.has(job.id);
        let state = requested ? 'killed' : code === 0 ? 'done' : 'failed';
        // Z6：非 0 退出先按输出签名识别暂停；命中已知签名 → paused（不占锁，等用户续跑/交接）；
        // unknown 只记 pauseReason 字段，状态保持 failed（Z1 语义不变）。
        let pause = null;
        if (!requested && code !== 0) pause = classifyPause(tails.get(job.id) ?? []);
        if (pause && pause.reason === 'unknown') {
          job.pauseReason = 'unknown';
          job.pauseDetail = pause.detail;
          pause = null;
        }
        if (pause) state = 'paused';
        finalizeJob(job, { state, exitCode: code, signal: signal ?? null, pause });
      }
      children.delete(job.id);
    });

    persist();
    emit('job-updated', job);
  }

  function handleLine(job, line) {
    if (!line) return;
    /* ZB-44：行解析按**该 job 的引擎**取前缀（缺省/未知 = zcode）。
     * 老 jobs.json 没有 engine 字段 ⇒ 在这里按 spec.engine 补齐并落库（面板可见）。 */
    const engine = normalizeEngine(job.engine ?? job.spec?.engine);
    if (job.engine !== engine) job.engine = engine;
    const tl = tails.get(job.id) ?? [];
    tl.push(line);
    if (tl.length > TAIL_CAP) tl.splice(0, tl.length - TAIL_CAP);
    tails.set(job.id, tl);

    const parsed = parseRunnerLine(line, engine);
    if (parsed === null) {
      job.parseWarnings.push(`unparsed ${prefixFor(engine)} line: ${line.slice(0, 120)}`);
      return;
    }
    if (!parsed || Object.keys(parsed).length === 0) return;

    if (parsed.runnerTag && job.tag == null) job.tag = parsed.runnerTag; // runner 分配的 tag 回填，用于台账匹配
    /* ZB-40：心跳/进度落库（面板显示"当前工作内容 + 是否可能卡住"） */
    if (parsed.progress) job.progress = parsed.progress;
    if (parsed.lastProgressAt) job.lastProgressAt = parsed.lastProgressAt;
    if (parsed.summarySeen) job.summarySeen = true;
    if (parsed.exitCode != null) job.exitCode = parsed.exitCode;
    if (parsed.sessionId) job.sessionId = parsed.sessionId;
    // done 行的 provider/model 来自 CLI 日志 traceId 反查（实际值），优先于启动行的声明值
    if (parsed.provider && (parsed.authoritative || !job.provider)) job.provider = parsed.provider;
    if (parsed.model && (parsed.authoritative || !job.model)) job.model = parsed.model;
    if (parsed.models) job.models = parsed.models;
    /* ZB-28：超时与 runner 侧记忆禁令确认。
     * · timedOut：runner 自身 --timeout-min 到点会在 done 行带 `(超时)` 且 exit=124 ——
     *   此前该标记被丢弃（timedOut 只有 dispatcher 看门狗路径会置位），「runner 超时」与
     *   「任务真失败」在 job 上无法区分。现在如实落到 job.timedOut/timedOutBy='runner'。
     * · memoryBanSeen：runner 打印 `memory-ban=on` = 旗标确实被它接受并注入
     *   （task 类型的禁令在 runner 侧拼装，见 collab-kit/zcode-run.mjs ZB-28 注释）。 */
    if (parsed.timedOut) { job.timedOut = true; if (job.timedOutBy == null) job.timedOutBy = 'runner'; }
    if (parsed.memoryBanSeen) job.memoryBanRunner = true;
    /* ZB-45：执行器确认已放行权限（`auto=on` 告知行）⇒ 置 job.autoApproved（下发时通常已置位）。 */
    if (parsed.autoSeen) job.autoApproved = true;
    /* ZB-29：runner 确认思考强度已注入（defaultModelSelection 写入临时 provider 配置）。 */
    if (parsed.reasoningLevelApplied != null) {
      job.reasoningLevelApplied = parsed.reasoningLevelApplied;
      job.reasoningTarget = parsed.reasoningTarget;
    }
    /* ZB-75：观测到的思考状态（Qoder 专用；zcode/opencode 不上报 ⇒ 字段保持 undefined，不猜）。 */
    if (parsed.thinkingObserved != null) {
      job.thinkingObserved = parsed.thinkingObserved;
      job.thinkingBlocks = parsed.thinkingBlocks;
      job.thinkingChars = parsed.thinkingChars;
      job.thinkingRequested = parsed.thinkingRequested;
    }
    if (parsed.endpoint) job.endpoint = parsed.endpoint;
    if (parsed.usage) {
      job.usage = { ...job.usage, ...Object.fromEntries(Object.entries(parsed.usage).filter(([, v]) => v != null)) };
    }
    if (parsed.contextUsed != null) job.contextUsed = parsed.contextUsed;
    if (parsed.contextWindow != null) job.contextWindow = parsed.contextWindow;
    if (parsed.turnCount != null) job.turnCount = parsed.turnCount;
    /* ZB-51：Qoder 的 credits / 上下文占比 / 引擎侧耗时 —— 落到 job 上（面板与工具可见）。
     * 只在这些行**确实出现**时才写（zcode/opencode 不上报它们，保持字段为 undefined 而不是 0）。 */
    if (parsed.credits != null) job.credits = parsed.credits;
    if (parsed.contextRatio != null) job.contextRatio = parsed.contextRatio;
    if (parsed.durationMs != null) job.durationMs = parsed.durationMs;
    if (parsed.responseChars != null) job.responseChars = parsed.responseChars;
    if (parsed.runnerOut) job.outLog = parsed.runnerOut;
    if (parsed.runnerErr) job.errLog = parsed.runnerErr;
    if (parsed.runnerResult) job.resultFile = parsed.runnerResult;
    if (isTerminal(job)) return; // finalize 之后的迟到行只进 tailLines
    persist();
    emit('job-updated', job);
  }

  /** job 结束：台账回读合并 → 终态字段 → 持久化/广播 → 放锁 → 泵队列。paused 时不占锁、
   *  队列照常继续（paused 不在 running 计数里）；若是可降级原因且链已启用，异步接续下一跳。
   *  ZB-44：**OpenCode 没有台账**（dispatch-runs.jsonl 是 ZCode 侧产物）⇒ 对它跳过台账回读，
   *  不让「台账未命中」类噪音落到它的 parseWarnings 上（它的 `done` 行由执行器保证打印）。 */
  function finalizeJob(job, { state, exitCode = null, signal = null, pause = null }) {
    job.state = state;
    if (exitCode != null) job.exitCode = exitCode;
    job.signal = signal;
    if (pause) {
      job.pauseReason = pause.reason;
      job.pauseDetail = pause.detail;
    }
    job.finishedAt = new Date(nowMs()).toISOString();
    if (state === 'paused') job.pausedAt = job.finishedAt; // ZB-28：进入 paused 的时刻（= finishedAt，显式字段便于检索/展示）
    job.elapsedSec = Number(((Date.parse(job.finishedAt) - Date.parse(job.startedAt ?? job.finishedAt)) / 1000).toFixed(3));
    job.tailLines = tails.get(job.id) ?? [];

    if (normalizeEngine(job.spec?.engine) !== 'opencode') mergeFromLedger(job);
    if (!job.summarySeen && !job.ledgerMatched) {
      job.parseWarnings.push(`no ${prefixFor(job.spec?.engine)} summary parsed and no ledger record matched`);
    }

    clearTimeout(watchdogs.get(job.id));
    watchdogs.delete(job.id);
    killRequested.delete(job.id);
    tails.set(job.id, job.tailLines);

    /* ZB-75（用户教学要求）：**派发后核对思考档位是否符合设置，不符则向上改档位重试**。
     *
     * 背景（真机）：Qoder 引擎**不回报实际生效档位**（init/result 里都没有该字段），
     * 故 `reasoningLevelApplied` 只是请求值回显 ⇒ 设"极高"实际变成"关闭思考"这类**静默降级**
     * 一直发现不了。唯一可观测信号是 assistant 的 `thinking` 内容块（实测矩阵：`none` 恒 0 块，
     * 其余档位恒有块 ⇒ 可靠的二值信号）。
     *
     * 判据：**请求的档位"要思考"（不在 THINK_OFF_LEVELS 里）+ 观测到 silent**
     *      ⇒ 档位不符 ⇒ 记一条 `parseWarnings`（可见）+ 标记待重试。
     * 为什么用 parseWarnings 而不是直接改状态：这是**核对结论**（事实记录），
     * 不是失败判定 —— 任务本身可能成功（只是思考档位没按预期生效），不该因此判它失败。
     * 重试走既有的 retry 通道（保留同会话/换通道语义），只把档位**向上**调一档。 */
    const thinkCheck = checkThinkingApplied(job);
    if (thinkCheck.mismatch) {
      job.parseWarnings.push(thinkCheck.warning);
      job.thinkingMismatch = { requested: job.spec?.reasoningLevel ?? null, observed: job.thinkingObserved ?? null,
        blocks: job.thinkingBlocks ?? null, suggested: thinkCheck.suggested };
    }

    /* ZB-26（审计 B3）：**落盘前**必须先盖版本戳 —— 否则终态记录带着"上一次更新"的旧
     * updatedAt 落盘，别的进程按新旧合并时会认为自己的旧副本更新，把终态覆盖回 running。 */
    job.updatedAt = nowMs();
    persist();
    emit('job-updated', job);
    releaseLocks(job);
    pump();
    /* ── ZB-52：失败后的**顺序派发**（先）与**自动降级链**（后）──
     *
     * 用户选定：顺序派发模式下「任何失败都延续，除参数错误」。
     * 故这里的触发面比降级链宽：
     *   · `failed`（非 0 退出 / 无输出 / spawn 失败）⇒ 延续
     *   · `paused` ⇒ 延续（不管暂停原因属于哪一类：限流、额度、模型不可用都该换下一个）
     *   · 例外 `config-error`：**参数/配置错**，换任何模型都一样 ⇒ 不延续（延续只是白烧额度）。
     *
     * 顺序列表用尽 ⇒ `advanceSequential` 返回 false ⇒ 交回降级链（跨通道续命）。 */
    /* 顺序派发的触发面（用户选定「任何失败都延续，除参数错误」）：
     *   · failed（非 0 退出 / spawn 失败 / 无输出）⇒ 延续
     *   · paused ⇒ 延续，**不限暂停原因**（限流 / 额度 / 模型不可用都该换下一个）
     *   · 例外（ZB-71）：`config-error`（参数错，换谁都一样）与 `provider-blocked`
     *     （按 IP 封锁免费模型，同引擎换模型必然同样失败）⇒ **不在引擎内延续**，
     *     直接交给跨通道降级链（那才是唯一有效的动作）。 */
    const seqReason = state === 'paused' ? (job.pauseReason ?? '暂停') : `退出码 ${job.exitCode ?? '-'}`;
    const seqSkipped = state === 'paused' && NO_SEQUENTIAL_REASONS.has(job.pauseReason);
    const seqHandled = seqSkipped ? false : advanceSequential(job, seqReason);
    if (!seqHandled && state === 'paused' && AUTO_FALLBACK_REASONS.has(job.pauseReason)) maybeAutoFallback(job);
  }

  /* ---------- Z6：通道 / retry / 交接重跑 / 自动降级链 ---------- */

  /**
   * paused 且原因可降级时按**目标列表**自动交接。从当前通道之后找第一个「可用」目标跳过去
   * （可用性来自 listChannels，不猜）；当前通道不在列表上则从头找；跳数以列表长度封顶；
   * 列表耗尽或某一跳执行失败都停在 paused 并留 warning。
   * ZB-30：每个目标可带 model / reasoningLevel（面板设置）——有则覆盖，无则沿用原任务。
   */
  function maybeAutoFallback(job) {
    if (fallbackTargets.length === 0) return;
    /* ⚠️ 封顶必须只数**降级链自己的**跳数（ZB-52 修的真 bug，队友测试报出来的）：
     *
     * 原先用 `job.hopCount`（**所有**交接的总跳数）与 `fallbackTargets.length` 比较 ——
     * 而**顺序派发**的交接也会让 hopCount +1（它复用同一条 retry 通道）⇒ 两者**共用同一份预算**。
     * 后果：只要「降级目标数 ≤ 已发生的顺序跳数」，顺序列表用尽后**降级永远被拦**，
     * 实测最小复现：1 个降级目标 + 2 个顺序模型 ⇒ 第 2 个 job 就 hopCount=1 ≥ 1 ⇒
     * 直接留「已达目标数上限（1 跳）」并停止 —— 与"顺序用尽 ⇒ 交回降级链"的语义不符。
     *
     * 故改为数**降级专属跳数**：从 attempts 里数 `reason === 'auto-fallback'` 的条数
     * （顺序派发用 `handoff-retry`，两者可区分）。旧记录没有该 reason ⇒ 退化为 hopCount（保守）。 */
    const fbHops = countFallbackHops(job);
    if (fbHops >= fallbackTargets.length) {
      job.parseWarnings.push(`fallback-chain: 已达目标数上限（${fallbackTargets.length} 跳），停止自动降级`);
      persist();
      emit('job-updated', job);
      return;
    }
    /* ⚠️ 起点下标（ZB-52 修的第二个真 bug）：
     * `findIndex` 找不到时返回 **-1**，而循环从 `startIdx + 1` 开始 ⇒ 会**从 index 1 起找**，
     * 于是**唯一的那个降级目标被静默跳过**（真机最小复现：降级目标只有 1 个时永远不降级）。
     * 语义应该是：当前通道**在列表里** ⇒ 从它的下一项找；**不在列表里** ⇒ 从**头**找
     * （顺序派发的 job 就属于后者：provider 是 `opencode`，本来就不在降级目标里）。
     * 这也是队友报的"降级被拦"的**真正根因** —— 跳数预算只是掩盖它的一层。 */
    const startIdxRaw = fallbackTargets.findIndex((t) => t.provider === (job.spec.provider ?? 'plan'));
    const searchFrom = startIdxRaw < 0 ? 0 : startIdxRaw + 1;
    void (async () => {
      try {
        const cur = jobs.get(job.id);
        if (!cur || cur.state !== 'paused') return; // 期间被用户续跑/kill：不再自动动
        let channels = [];
        if (channelsImpl) {
          channels = (await channelsImpl()).channels ?? [];
        } else {
          channels = (await listChannels()).channels ?? [];
        }
        const live = jobs.get(job.id);
        if (!live || live.state !== 'paused') return;
        for (let i = searchFrom; i < fallbackTargets.length; i += 1) {
          const target = fallbackTargets[i];
          const ch = channels.find((c) => c.id === target.provider);
          if (ch && ch.enabled) {
            /* ZB-52 第三轮（用户要求）：**降级目标也支持顺序派发**。
             * 目标 model 为空 + 该引擎有顺序列表 ⇒ 降到它时按列表**第一项**起跑，
             * 并播种 seqRuns ⇒ 它失败时继续在列表里往后试；列表用尽才继续**外层**降级链。
             * 这样"主通道 OpenCode 顺序 + 降级 Qoder 顺序"能同时成立（两份列表各自独立）。 */
            const seq = sequentialChainForSpec({ provider: target.provider, model: target.model ?? null });
            const first = seq?.chain?.[0] ?? null;
            const effModel = first ? first.model : target.model;
            const effRl = first?.reasoningLevel ?? target.reasoningLevel;
            live.parseWarnings.push(
              `fallback-chain: 自动跳到 ${target.provider}${effModel ? `/${effModel}` : ''}（交接重跑）`
              + (first ? `；该目标为顺序派发（共 ${seq.chain.length} 个模型）` : ''),
            );
            const nj = retry(live.id, {
              provider: target.provider,
              model: effModel,
              reasoningLevel: effRl,
              autoFallback: true,
              hopReason: 'auto-fallback', // 与顺序派发换模型区分开（各自独立跳数预算）
            });
            if (seq && nj) seedSequentialRun(nj.id, seq);
            return;
          }
        }
        live.parseWarnings.push('fallback-chain: 目标列表里没有下一个可用通道，保持 paused');
        persist();
        emit('job-updated', live);
      } catch (e) {
        const live = jobs.get(job.id);
        if (live && live.state === 'paused') {
          live.parseWarnings.push(`fallback-chain: 自动降级失败（${e?.message ?? e}），保持 paused`);
          persist();
          emit('job-updated', live);
        }
      }
    })();
  }

  /* ---------------- ZB-52：顺序派发的**执行**（展开模型链 + 失败推进） ---------------- */

  /**
   * 把「顺序派发」的配置展开成**模型级目标链**（每项 `{provider, model}`）。
   *
   * @param engine 目标引擎（只取该引擎自己的顺序列表 —— 用户要求「每通道各自一份」）
   * @returns {{provider, model}[]} 空数组 = 该引擎没配顺序（顺序派发对它不生效，不是错误）
   *
   * ⚠️ **必须保持面板显示的顺序**：`seqOrder[engine]` 就是从上到下的次序，
   * 这里不做任何排序/重排（用户拖动的结果就是派发次序）。
   *
   * route id 两种形态（与面板「模型」下拉的模型项 key 对应）：
   *   · `<通道id>::<模型名>` —— ZCode 的路由×模型（如 `plan::GLM-5.3`）；
   *   · `opencode/<model>` / `qoder/<model>` —— 该引擎的一个模型（provider=裸引擎名）。
   */
  function expandSequentialChain(engine) {
    const eng = normalizeEngine(engine);
    const list = seqOrder[eng] ?? [];
    const chain = [];
    for (const entry of list) {
      const route = typeof entry === 'string' ? entry : entry?.route;
      if (typeof route !== 'string' || !route) continue;
      /* ZB-58：**被关掉的模型不参与顺序派发**（逐模型开关）—— 顺序列表本身不动，只是派发时跳过。 */
      if (disabledModels.has(route)) continue;
      /* ZB-52：每项自带档位（用户要求「顺序思考强度档位设置」）；null = 该模型用引擎默认。 */
      const rl = (typeof entry === 'object' && entry ? entry.reasoningLevel : null) ?? null;
      const sep = route.indexOf('::');
      if (sep > 0) {
        /* ZCode 形态：`<provider>::<model>` */
        const provider = route.slice(0, sep);
        const model = route.slice(sep + 2);
        if (provider && model) chain.push({ provider, model, reasoningLevel: rl });
        continue;
      }
      /* 其它引擎：路由 id 就是模型 id，provider 用裸引擎名（core 认）。 */
      chain.push({ provider: eng, model: route, reasoningLevel: rl });
    }
    return chain;
  }

  /** 顺序派发的**接管判据**（ZB-52 第三轮：没有全局开关）：
   *  · 该引擎配了顺序列表（否则不接管）；且
   *  · 任务**没有指定具体模型**（`spec.model` 为空 —— 指定了就按指定的跑，不被列表劫持）。
   *  首次派发由 `dispatch()` 用它决定"用列表第一项"；降级目标由 `maybeAutoFallback` 用它决定
   *  "降到该目标时也按列表试"。 */
  function sequentialChainForSpec(spec) {
    /* ZB-58：**功能总开关关闭 ⇒ 整块功能不生效**（派发不走顺序链；面板也不展示该选项）。
     * 已在进行中的顺序链（`seqRuns` 里登记过的任务）按"登记即继续"处理 ——
     * 关开关不该把正在跑的任务搞成半途而废（见 advanceSequential 只认已登记任务）。 */
    /* ⚠️ ZB-78（2026-10-20 真机踩到的静默 bug）：**"指定了模型"不能只看 `spec.model`**。
     *
     * 现场：`dispatch({ provider: 'qoder/DeepSeek-Flash', thinking: 'max' })` ——
     * 通道 id 里**带着模型名**（这是工具文档推荐的常见传法），此时 `spec.model` 仍是 null，
     * 于是顺序链认为"没指定模型"⇒ 接管 ⇒ 把 model 换成**列表第一项**（Qwen3.8-Flash）、
     * 连 thinking 也一并覆盖成列表第一项配的档位。**用户显式选定的模型与档位被静默改掉。**
     *
     * 为什么之前没暴露：`normalizeEngineSpec`（把 `qoder/<model>` 剥成 `model`）是在**更晚的**
     * `dispatchRaw` 里才跑的；`sequentialChainForSpec` 在这之前就被调用 ⇒ 那一刻 model 还是 null。
     * 传 `model:` 的路径（A/B 两种）因为 model 有值而侥幸正确，只有"模型藏在 provider 里"这条踩中。
     *
     * 修法：把 provider 里内嵌的模型 id 也算作"已指定模型"（与 normalizeEngineSpec 同一判据）。
     * 这样 C 组与 A/B 组行为一致 —— **显式指定 ⇒ 顺序链一律不接管**（教学文档的承诺）。 */
    const embedded = embeddedModelOf(spec);
    if (embedded) return null;                                   // 模型藏在 provider 里 ⇒ 也算指定了模型
    if (spec?.model != null && spec.model !== '') return null; // 指定了模型 ⇒ 不接管
    const eng = normalizeEngine(spec?.engine ?? resolveEngineOf(spec ?? {}));
    const chain = expandSequentialChain(eng);
    return chain.length ? { engine: eng, chain } : null;
  }

  /** ZB-78：从 `provider` 里取出**内嵌的模型 id**（`opencode/<model>` / `qoder/<model>` 形态）。
   *  与 `normalizeEngineSpec` 的剥前缀判据一致（同一形状、同一引擎集），只是**提前**在
   *  `sequentialChainForSpec` 能看到的时刻做判断。返回 null = provider 是裸通道 id（没带模型）。 */
  function embeddedModelOf(spec) {
    const prov = spec?.provider;
    if (typeof prov !== 'string') return null;
    const p = prov.trim();
    if (!p) return null;
    const bare = normalizeEngine(spec?.engine ?? resolveEngineOf(spec ?? {}));
    if (bare === 'qoder' && isQoderId(p)) return p.slice('qoder/'.length);
    if (bare === 'opencode' && isOpenCodeId(p)) return p;
    return null;
  }

  /**
   * 失败后推进到顺序列表的**下一个模型**（用户要求：报错就换下一个，直到跑完整个列表）。
   *
   * 与「自动降级链」的分工（两者可同时存在，先顺序、后降级）：
   *   · 顺序派发：**同一引擎内**换模型（用户为这个引擎排的序）；
   *   · 自动降级：跨通道（面板另配的目标）。
   * 顺序列表跑完 ⇒ 交回降级链处理；都没有 ⇒ 停在失败/paused。
   *
   * ⚠️ 触发面（用户选定「任何失败都延续，除参数错误」）：
   *   `config-error` 不延续 —— 那是**参数/配置错**，换任何模型都一样（延续只是白烧额度）。
   */
  function advanceSequential(job, reason) {
    /* ⚠️ **只认"在派发时被登记过"的任务**（`seqRuns` 由 dispatch / maybeAutoFallback 播种）：
     * 不这样做的话，任何"恰好没指定模型 + 该引擎有顺序列表"的历史任务失败时都会被劫持进顺序链 ——
     * 那是**替用户改了意图**（他没选顺序派发，只是没写模型）。登记过 = 确实按顺序派发起的。 */
    const run = seqRuns.get(job.id);
    if (!run) return false;
    const nextIdx = run.idx + 1;
    if (nextIdx >= run.chain.length) {
      job.parseWarnings.push(`顺序派发: 已试完 ${run.chain.length} 个模型（${reason}），列表用尽`);
      seqRuns.delete(job.id);
      persist();
      emit('job-updated', job);
      return false; // 交回降级链
    }
    const target = run.chain[nextIdx];
    run.idx = nextIdx;
    job.parseWarnings.push(
      `顺序派发: 第 ${run.idx + 1}/${run.chain.length} 个模型 ${target.provider}/${target.model}（上一个失败：${reason}）`,
    );
    /* ⚠️ `retry()` 会创建**新 job**（交接重跑）⇒ 必须把"当前在这一项"**移交给新 job**，
     * 否则新 job 失败时 `seqRuns` 里查不到它 ⇒ 提前交回降级链（真机实测：主通道只试了 2/3 个
     * 就跳去降级目标了）。同一个 run 对象继续用（idx 已推进），条目换到新 job 名下。 */
    const nj = retry(job.id, {
      provider: target.provider,
      model: target.model,
      /* ZB-52：档位取**该模型在顺序列表里自己的设置**（用户要求「顺序思考强度档位设置」）；
       * 没设 ⇒ 沿用原任务的档位（不猜、不覆写）。 */
      reasoningLevel: target.reasoningLevel ?? job.spec?.reasoningLevel ?? null,
      /* ⚠️ `autoFallback` 必须为 **false**：它是给**降级链**用的标记。
       * 顺序派发请求的 provider 常与 job 当前 provider 相同 ⇒ 会走 retry 的 **resume 分支**，
       * 而 resume 分支**不写 hopReason** ⇒ 那两条记录都成了"悬空的源条目"，
       * 被 `countFallbackHops` 误判成降级跳（真机插桩实测：降级 job 自己失败时 fbHops=2 而被误拦）。
       * 这里用自己的 `hopReason:'seq-model'` 标记即可。 */
      autoFallback: false,
      hopReason: 'seq-model',
    });
    seqRuns.delete(job.id);
    if (nj) seqRuns.set(nj.id, run);
    return true;
  }

  /** 顺序派发的**播种**：把"这个任务按顺序链起跑、当前在第 0 项"记进 `seqRuns`。
   *  只在**派发那一刻**播种（dispatch / 降级到某目标时），失败推进才有据可依 ——
   *  见 `advanceSequential` 里"只认登记过的任务"的理由。 */
  function seedSequentialRun(jobId, seq) {
    if (!jobId || !seq) return;
    seqRuns.set(jobId, { engine: seq.engine, chain: seq.chain, idx: 0 });
  }

  /** 数**降级链专属**跳数（ZB-52）：从 attempts 里数 `reason === 'auto-fallback'` 的条数。
   *
   *  为什么必须区分：顺序派发的交接也会让 `hopCount` 加一（它复用同一条 retry 通道）。
   *  若直接拿 `hopCount` 当降级链的预算，两者会**共用一份预算** ⇒
   *  只要「降级目标数 ≤ 顺序跳数」，顺序用尽后降级就被误拦（真 bug，见 maybeAutoFallback 注释）。
   *
   *  旧记录（没有该 reason）⇒ 退化为 `hopCount`（保守：宁可少降一次，也不无限跳）。 */
  function countFallbackHops(job) {
    const attempts = Array.isArray(job?.attempts) ? job.attempts : [];
    /* ⚠️ 判据演进（每一步都是实测逼出来的，别再"简化"回去）：
     *
     * ① 曾用 `reason.startsWith('auto-fallback')` —— **错**：那条"源记录"的 reason 正是
     *    `auto-fallback:<pauseReason>`，而早期顺序派发也传 `autoFallback:true`，两者格式一样。
     * ② 曾改为"两条记录都打 hopReason + pending 配对计数" —— **也错**：两条都带 hopReason 时
     *    配对逻辑失效，一次交接被计成 **2 跳**，降级封顶实际只允许 ceil(L/2) 跳
     *    （队友用最小复现抓到：链 `['plan','ch-b']` 两个目标都可用时只降 1 次就报"已达目标数上限"）。
     * ③ **现在**：`hopReason` **只打在目标记录**上（见 retry 的 attempts 构造）⇒ 一次交接恰好一条。
     *    故这里就是**朴素计数**，不需要任何配对状态。
     *
     * 判据只认 `hopReason === 'auto-fallback'`：顺序派发的目标是 `'seq-model'`，天然不计入。 */
    return attempts.filter((a) => a && a.hopReason === 'auto-fallback').length;
  }

  /** 当前默认通道（dispatch 未显式指定 provider/model 时采用；reasoningLevel=通道默认思考强度）。 */
  function getChannel() {
    return { ...channel };
  }

  /* ZB-29d：思考强度归一（'agent'=Agent决定 或 具体档位；非法/空 → 回退 fallback，不猜）。 */
  const normReasoning = (v, fallback) => {
    if (v == null) return fallback;
    const s = String(v).trim();
    if (!s) return fallback;
    return s === 'agent' || /^[A-Za-z0-9_-]{1,32}$/.test(s) ? s : fallback;
  };

  /** 设默认通道并持久化到 <workRoot>/state/channel.json（不校验可用性——可用性看 listChannels，不猜）。
   *  ZB-29d：reasoningLevel = 通道默认思考强度（'agent'=Agent决定 / 具体档位）；缺省沿用原值。 */
  function setChannel(next = {}) {
    const provider = next.provider == null ? channel.provider : String(next.provider);
    const model = next.model == null || next.model === '' ? null : String(next.model);
    if (!provider) throw new TypeError('setChannel: provider 不能为空');
    channel = {
      provider,
      model,
      reasoningLevel: normReasoning(next.reasoningLevel, channel.reasoningLevel ?? 'agent'),
    };
    atomicWrite(channelFile, `${JSON.stringify({ version: 1, ...channel, updatedAt: new Date(nowMs()).toISOString() }, null, 2)}\n`);
    return getChannel();
  }

  function loadChannelState() {
    try {
      const data = JSON.parse(readFileSync(channelFile, 'utf8'));
      if (data && typeof data.provider === 'string' && data.provider) {
        channel = {
          provider: data.provider,
          model: typeof data.model === 'string' && data.model ? data.model : null,
          reasoningLevel: normReasoning(data.reasoningLevel, 'agent'),
        };
      }
    } catch { /* 无文件/损坏：用默认通道 */ }
  }

  /* ---------- ZB-44：通道 → 引擎快照（同步可读，供 dispatch/startJob 用） ---------- */

  /** 读快照。文件缺失/损坏/字段非法一律 fail-open：engineById={} ⇒ 所有通道按默认引擎 zcode 处理。 */
  function loadEngineMap() {
    try {
      const data = JSON.parse(readFileSync(channelsFile, 'utf8'));
      const raw = data?.engineById;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const map = {};
        for (const [id, e] of Object.entries(raw)) {
          const s = typeof e === 'string' ? e.trim().toLowerCase() : '';
          if (id && ENGINES.includes(s)) map[id] = s; // 非法引擎名直接丢弃（不猜）
        }
        engineById = map;
        engineMapFingerprint = JSON.stringify({ engineById, engines: [...ENGINES] });
        return;
      }
    } catch { /* 见上：fail-open */ }
    engineById = {};
    engineMapFingerprint = null;
  }

  /** 用最新通道清单刷新快照并落盘；**内容无变化则不重写**（listChannels 会被频繁调用）。
   *  engine 缺省按默认引擎（= 与 parser 的缺失语义一致）。写盘异常由调用方兜（不影响清单返回）。 */
  function setEngineMap(channels) {
    const map = {};
    for (const c of channels ?? []) {
      if (!c || typeof c.id !== 'string' || !c.id) continue;
      map[c.id] = normalizeEngine(c.engine);
    }
    engineById = map;
    const fingerprint = JSON.stringify({ engineById, engines: [...ENGINES] });
    if (fingerprint === engineMapFingerprint) return;
    atomicWrite(channelsFile, `${JSON.stringify({ version: 1, engineById, engines: [...ENGINES], updatedAt: nowMs() }, null, 2)}\n`);
    engineMapFingerprint = fingerprint;
  }

  /* ZB-30：降级**目标**归一 —— 每项 {provider, model, reasoningLevel}（model/reasoningLevel 可为 null
   * = 沿用原任务）。接受三种入参：字符串（旧 chain 项）/ {provider|id|channel, model?, reasoningLevel?|thinking?}。
   * 非法项（无 provider）直接丢弃（不猜），并保留顺序。 */
  function normFallbackTargets(list) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw new TypeError('setFallbackTarget/setFallbackChain: 需要数组（空数组/null = 关闭）');
    const out = [];
    for (const item of list) {
      if (typeof item === 'string') {
        const id = item.trim();
        if (id) out.push({ provider: id, model: null, reasoningLevel: null });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const provider = String(item.provider ?? item.id ?? item.channel ?? '').trim();
      if (!provider) continue;
      const model = item.model == null || item.model === '' ? null : String(item.model);
      const rl = normReasoning(item.reasoningLevel ?? item.thinking ?? null, null);
      out.push({ provider, model, reasoningLevel: rl });
    }
    return out;
  }

  function persistFallback() {
    atomicWrite(fallbackFile, `${JSON.stringify({
      version: 2,
      chain: fallbackTargets.map((t) => t.provider), // 旧读者（CLI list / 旧客户端）仍能读
      targets: fallbackTargets,
      updatedAt: new Date(nowMs()).toISOString(),
    }, null, 2)}\n`);
  }

  /** 旧入口：通道 id 数组（等价于只有 provider 的目标列表）。 */
  function setFallbackChain(list) {
    fallbackTargets = normFallbackTargets(list);
    persistFallback();
    return getFallbackChain();
  }

  /** ZB-30（面板入口）：设置**单个**降级目标（通道+模型+思考强度）；null/空 = 关闭降级。 */
  function setFallbackTarget(target) {
    if (target == null || target === '') {
      fallbackTargets = [];
    } else if (typeof target === 'string') {
      fallbackTargets = normFallbackTargets([target]);
    } else {
      fallbackTargets = normFallbackTargets([target]);
      if (fallbackTargets.length === 0) throw new TypeError('setFallbackTarget: 需要 provider（通道 id）');
    }
    persistFallback();
    return getFallbackChain();
  }

  /** {enabled, chain（旧形状：通道 id 列表）, targets（新形状：含 model/思考强度）, target（首项）}。 */
  function getFallbackChain() {
    const targets = fallbackTargets.map((t) => ({ ...t }));
    return {
      enabled: targets.length > 0,
      chain: targets.map((t) => t.provider),
      targets,
      target: targets[0] ?? null,
    };
  }

  function loadFallbackState() {
    try {
      const data = JSON.parse(readFileSync(fallbackFile, 'utf8'));
      if (data && Array.isArray(data.targets)) {
        fallbackTargets = normFallbackTargets(data.targets); // ZB-30 新形状
      } else if (data && Array.isArray(data.chain)) {
        fallbackTargets = normFallbackTargets(data.chain); // 旧 version 1 自动迁移（只带通道 id）
      }
    } catch { /* 无文件/损坏：默认关 */ }
  }

  /* ---------------- ZB-82：分流模式（split mode，用户要求） ---------------- */

  /** 分流模式状态：`{enabled, minFreeSlots}`。
   *  `enabled=false`（默认）⇒ 完全保持既有行为（什么都不分流）。
   *  `minFreeSlots`（默认 1）⇒ 主通道**剩余名额**少于这个数时才分流：
   *    · 1 = 主通道**满员**才分流（最保守，只填满才溢出）；
   *    · 2 = 主通道**还剩 1 个名额**时就开始分流（更早摊开，更均衡）。 */
  let splitMode = { enabled: false, minFreeSlots: 1 };

  function persistSplit() {
    atomicWrite(splitFile, `${JSON.stringify({ version: 1, ...splitMode, updatedAt: new Date(nowMs()).toISOString() }, null, 2)}\n`);
  }

  /** 设/读分流模式。入参 `{enabled?, minFreeSlots?}`；缺省字段沿用原值（不重置）。 */
  function setSplitMode(next = {}) {
    const out = { ...splitMode };
    if (next.enabled != null) {
      if (typeof next.enabled !== 'boolean') throw new TypeError('setSplitMode: enabled 必须是布尔');
      out.enabled = next.enabled;
    }
    if (next.minFreeSlots != null) {
      const n = Number(next.minFreeSlots);
      if (!Number.isInteger(n) || n < 1 || n > 8) throw new TypeError('setSplitMode: minFreeSlots 必须是 1..8 的整数');
      out.minFreeSlots = n;
    }
    splitMode = out;
    persistSplit();
    return getSplitMode();
  }

  /** 分流模式的**可读状态**（含"当前能不能分流"的实时判据，让面板/工具能如实显示）。 */
  function getSplitMode() {
    const targets = fallbackTargets.map((t) => ({ ...t }));
    const main = { ...channel };
    /* 主通道与降级目标**必须不同通道**才有分流价值（同一通道 = 同一份名额，分流是假动作）。 */
    const distinct = targets.filter((t) => String(t.provider ?? '') !== String(main.provider ?? ''));
    const mainEngine = normalizeEngine(resolveEngineOf({ provider: main.provider, model: main.model }));
    const mainLimit = engineLimit(mainEngine);
    const mainRunning = runningCountByEngine(mainEngine);
    const mainFree = Math.max(0, mainLimit - mainRunning);
    return {
      ...splitMode,
      main: { provider: main.provider ?? null, model: main.model ?? null, engine: mainEngine, limit: mainLimit, running: mainRunning, free: mainFree },
      targets,
      /* `active` = 用户开了 + 降级链里有**不同通道** + 那个目标还有名额。三者缺一都不分流。 */
      distinctTargets: distinct,
      active: splitMode.enabled && distinct.length > 0,
      reason: !splitMode.enabled ? 'disabled'
        : distinct.length === 0 ? 'no-distinct-target'
          : null,
    };
  }

  /**
   * ZB-82：**分流决策** —— 决定这次派发该用哪个通道。
   *
   * 触发判据（全满足才分流）：
   *   ① 用户开了分流（`splitMode.enabled`）；
   *   ② 降级链里有**与主通道不同**的目标（同通道 = 同一份名额 ⇒ 分流无意义，必须排除）；
   *   ③ **主通道剩余名额** < `minFreeSlots`（默认 1 ⇒ 满员才分流）；
   *   ④ 目标通道**自己还有名额**（不能把溢出的任务堆到一个也满了的通道）。
   *
   * ⚠️ 用「**在途数**」而不是「运行数」：派发是 fire-and-forget，用户可能**连发多个**
   * 而它们还都在 queued（pump 还没来得及启动）。若只数 running，连发第 2、3 个时
   * running 仍是 0 ⇒ 不会分流，等它们陆续启动才发现满了 —— **分流慢一拍**。
   * 故这里数 `running + queued`（该引擎的在途任务），这才是"我打算占用多少名额"的真实意图。
   *
   * 返回 `{provider, model, reasoningLevel, reason}` 或 null（不分流）。
   * **诚实**：不分流时也给出 reason（面板/工具可见"为什么没分流"）。
   */
  function splitDecisionFor(spec) {
    if (!splitMode.enabled) return null;
    const mainProvider = String(channel.provider ?? '');
    /* 调用方**显式指定了通道** ⇒ 尊重他的选择，绝不偷偷改（这与"显式指定模型不被顺序链劫持"同一纪律）。 */
    const explicit = String(spec?.provider ?? '');
    if (explicit && explicit !== mainProvider) return null;
    const targets = fallbackTargets.filter((t) => String(t.provider ?? '') !== mainProvider);
    if (targets.length === 0) return null;
    const mainEngine = normalizeEngine(resolveEngineOf({ provider: mainProvider, model: channel.model }));
    const inflight = runningCountByEngine(mainEngine) + queuedCountByEngine(mainEngine);
    const free = Math.max(0, engineLimit(mainEngine) - inflight);
    if (free >= splitMode.minFreeSlots) return null; // 主通道还够用 ⇒ 不分流
    /* 选第一个"自己还有名额"的目标（按降级链顺序 ⇒ 与用户的意图顺序一致）。 */
    for (const t of targets) {
      const eng = normalizeEngine(resolveEngineOf({ provider: t.provider, model: t.model }));
      const tInflight = runningCountByEngine(eng) + queuedCountByEngine(eng);
      if (tInflight < engineLimit(eng)) {
        return { provider: t.provider, model: t.model ?? null, reasoningLevel: t.reasoningLevel ?? null, reason: 'main-full' };
      }
    }
    return null; // 目标也满了 ⇒ 老实排队（不硬塞）
  }

  /** 某引擎的**在途**任务数（running + queued）—— 分流判据用（见 splitDecisionFor 的说明）。 */
  function queuedCountByEngine(engine) {
    const want = normalizeEngine(engine);
    let n = 0;
    for (const j of jobs.values()) if (j.state === 'queued' && engineOfJob(j) === want) n += 1;
    return n;
  }

  function loadSplitState() {
    try {
      const data = JSON.parse(readFileSync(splitFile, 'utf8'));
      if (data && typeof data.enabled === 'boolean') {
        splitMode = { enabled: data.enabled, minFreeSlots: Number(data.minFreeSlots) >= 1 ? Number(data.minFreeSlots) : 1 };
      }
    } catch { /* 无文件/损坏：默认关 */ }
  }

  /* ---------------- ZB-52：顺序派发（状态 + 公开 API） ---------------- */

  /** 顺序派发的**归一**：每项 = `{route, reasoningLevel|null}`。
   *
   *  ⚠️ ZB-52 第二轮（用户要求「新增顺序思考强度档位设置」）：顺序项从**纯字符串**升级为
   *  「路由 + 该模型自己的档位」。为什么必须这样：档位是**逐模型**的（实测 OpenCode 6/10 个模型
   *  有档位、且集合各不相同）—— 一个全局档位对"轮换多个模型"根本说不通。
   *
   *  **向后兼容**：旧存值（字符串数组）照常读入，档位为 null = 该模型用引擎默认。
   *  去重按 **route** 去重（同一路由只出现一次；后出现的档位覆盖先出现的）。 */
  function normSeqOrder(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
      const route = typeof item === 'string'
        ? item.trim()
        : String(item?.route ?? item?.id ?? '').trim();
      if (!route) continue;
      const rl = normReasoning(item?.reasoningLevel ?? item?.thinking ?? null, null);
      const prev = out.findIndex((x) => x.route === route);
      const entry = { route, reasoningLevel: rl };
      if (prev >= 0) out[prev] = entry; else out.push(entry);
    }
    return out;
  }

  /** 对外形状：`order[engine]` 保持**字符串数组**（客户端既有渲染契约不变）；档位单独走 `levels`。
   *  这样面板不必改写取值的全部逻辑，也能拿到逐模型档位。 */
  function seqRouteIds(engine) {
    return (seqOrder[engine] ?? []).map((x) => x.route);
  }

  /* ── ZB-58：逐模型开关（状态 + API） ── */

  function persistModelSwitches() {
    atomicWrite(modelsFile, `${JSON.stringify({
      version: 1,
      disabled: [...disabledModels].sort(),
      updatedAt: new Date(nowMs()).toISOString(),
    }, null, 2)}\n`);
  }

  function loadModelSwitches() {
    try {
      const data = JSON.parse(readFileSync(modelsFile, 'utf8'));
      disabledModels = new Set(
        (Array.isArray(data?.disabled) ? data.disabled : []).map((x) => String(x)).filter(Boolean),
      );
    } catch { /* 无文件/损坏：默认一个都不禁用（不猜、不抛） */ }
  }

  /** 面板读：`{disabled: [路由id...], userDisabledCount}`。
   *  ⚠️ 用**禁用清单**：上游新探测到的模型默认可用（不会被静默藏起来）。 */
  function getModelSwitches() {
    return { disabled: [...disabledModels].sort(), userDisabledCount: disabledModels.size };
  }

  /**
   * 面板写：`{route, enabled}`（翻单个）或 `{disabled: [...]}`（整体替换）。
   * 返回写入后的 `getModelSwitches()`。
   * ⚠️ 关掉某模型**不影响**已存顺序列表里的条目（那是"顺序"，不是"可用性"）——
   * 只是派发时跳过它（见 expandSequentialChain）。
   */
  function setModelSwitch(patch) {
    if (patch == null || typeof patch !== 'object') throw new TypeError('setModelSwitch: 需要对象 {route, enabled} 或 {disabled}');
    if (Array.isArray(patch.disabled)) {
      disabledModels = new Set(patch.disabled.map((x) => String(x)).filter(Boolean));
    } else if (typeof patch.route === 'string' && patch.route) {
      if (patch.enabled === false) disabledModels.add(patch.route);
      else disabledModels.delete(patch.route);
    } else {
      throw new TypeError('setModelSwitch: 需要 {route, enabled} 或 {disabled}');
    }
    persistModelSwitches();
    return getModelSwitches();
  }

  function persistSequential() {
    atomicWrite(sequentialFile, `${JSON.stringify({
      version: 2, // v2：无全局开关（"是否顺序派发"由模型是否为空表达）
      order: seqOrder,
      updatedAt: new Date(nowMs()).toISOString(),
    }, null, 2)}\n`);
  }

  function loadSequentialState() {
    try {
      const data = JSON.parse(readFileSync(sequentialFile, 'utf8'));
      if (data && typeof data === 'object') {
        /* `enabled` 缺省 = **开**（旧 v1/v2 文件没有这个字段 ⇒ 保持原有行为，不让用户升级后功能突然消失）。 */
        seqOrder = {};
        if (data.order && typeof data.order === 'object') {
          for (const [eng, list] of Object.entries(data.order)) {
            const arr = normSeqOrder(list);
            if (arr.length) seqOrder[eng] = arr;
          }
        }
      }
    } catch { /* 无文件/损坏：默认开 + 空顺序（不猜） */ }
  }

  /** 面板/工具读：`{enabled, order, levels, sequentialCount}`。
   *  · `order[engine]` = **路由 id 数组**（从上到下 = 尝试次序；客户端既有渲染契约不变）；
   *  · `levels[engine]` = 与 `order[engine]` **同序**的档位数组（null = 该模型用引擎默认）。
   *  永远给出**三个引擎的键**（哪怕为空）—— 客户端据此渲染，不必自己知道有哪些引擎。
   *
   *    ② 激活条件 = **该通道的 model 为空**（精确到通道；由「模型」下拉的选中值表达）。
   *  之前去掉的是"② 的独立开关"（它会和模型值自相矛盾）；①是**功能级**开关，不会矛盾：
   *  关掉 ⇒ 整块功能隐藏（连选项都不出现），产出的状态也就无从矛盾。 */
  function getSequential() {
    const order = {};
    const levels = {};
    for (const eng of ENGINES) {
      const list = seqOrder[eng] ?? [];
      order[eng] = list.map((x) => x.route);
      levels[eng] = list.map((x) => x.reasoningLevel ?? null);
    }
    return {
      order,
      levels,
      sequentialCount: Object.values(order).reduce((n, l) => n + l.length, 0),
    };
  }

  /** 面板写：`{enabled?, order?}`。
   *  · `order` = **按引擎合并**（patch 里出现的引擎覆盖，未出现的保留）。
   *  两者可单传，互不覆盖。 */
  function setSequential(patch) {
    if (patch == null || typeof patch !== 'object') throw new TypeError('setSequential: 需要对象 {order}');
    /* ⚠️ **没有"总开关"**（用户明确澄清：要的是**逐模型开关**，不是整块功能的总开关）。
     * 传 `enabled` ⇒ 明确报错，不静默忽略 —— 静默忽略会让"我关掉了却没生效"变成查不出来的 bug。
     * 正确做法：① 是否用顺序派发 = 把该通道「模型」设成空值；② 哪些模型可用 = `setModelSwitch()`。 */
    if ('enabled' in patch) {
      throw new TypeError('setSequential: `enabled` 已废弃 —— 顺序派发由「模型」值表达（模型为空即启用顺序派发）；'
        + '要控制某个模型是否可用请用 setModelSwitch({route, enabled})');
    }
    if ('order' in patch) {
      /* ⚠️ **按引擎合并**，不是整体替换（队友真渲染探针抓到的真 bug）：
       * 原先 `seqOrder = next` ⇒ 调用方只想改**一个**引擎时（`{order:{opencode:[…]}}`），
       * 别的引擎（如已排好的 zcode）会被**当场静默清空** —— 而面板/CLI 很容易这么传。
       * 现在：patch 里出现的引擎**覆盖**该引擎（传空数组/null = 显式清空它），未出现的**原样保留**。 */
      const src = patch.order ?? {};
      if (src && typeof src === 'object' && !Array.isArray(src)) {
        for (const [eng, list] of Object.entries(src)) {
          /* ⚠️ 必须先判**原样**的引擎名再归一：`normalizeEngine()` 对未知值会**回退成默认引擎**
           * （zcode）—— 若先归一，`bogus:['x']` 会被静默写进 zcode 的顺序里（冒烟测出来的）。
           * 顺序派发的键必须是**已知引擎**，否则丢弃（不猜、不静默改名）。 */
          const key = String(eng).trim().toLowerCase();
          if (!ENGINES.includes(key)) continue;
          if (list == null) { delete seqOrder[key]; continue; } // 显式清空该引擎
          const arr = normSeqOrder(list);
          if (arr.length) seqOrder[key] = arr; else delete seqOrder[key];
        }
      }
    }
    persistSequential();
    return getSequential();
  }

  /**
   * ZB-33：免费额度（Start Plan）通道的展示名。
   *
   * 它是**运行时注入**的 `account:<family>-start-plan`（runner 侧 app-server 托管，
   * 见 collab-kit/appserver-gift.mjs），config.json 里没有它 ⇒ `readConfigNames()` 取不到名字，
   * 面板下拉会显示裸 id。这里按 id 形态给一个中文名（只影响展示，不影响可用性判断）。
   */
  const GIFT_CHANNEL_RE = /^account:[a-z]+-start-plan$/;

  /** 读 config.json 里的 provider 展示名（只读；读不到就用 id，不影响可用性判断）。 */
  function readConfigNames() {
    try {
      const cfg = JSON.parse(readFileSync(zcodeConfigPath, 'utf8'));
      const out = {};
      for (const [id, p] of Object.entries(cfg?.provider ?? {})) {
        if (p && typeof p.name === 'string' && p.name) out[id] = p.name;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** 读权益缓存 coding-plan-cache.json（只读、可选；损坏只记 warning）。 */
  function readPlanCache(warnings) {
    try {
      const cache = JSON.parse(readFileSync(planCachePath, 'utf8'));
      const items = cache?.entryStatus?.items;
      if (items && typeof items === 'object') return items;
      warnings.push('coding-plan-cache.json 缺 entryStatus.items，按无缓存处理');
      return {};
    } catch (e) {
      if (e?.code !== 'ENOENT') warnings.push(`coding-plan-cache.json 读取失败：${e.message}`);
      return {};
    }
  }

  /** 个人 API 通道（--provider personal 的可用性来自 provider_config.json 本体，同 runner 口径）。 */
  function readPersonalChannel(warnings) {
    try {
      const cfg = JSON.parse(readFileSync(personalProviderPath, 'utf8'));
      const rules = cfg?.config?.providerConfigRules?.providerRules ?? [];
      const rule = rules.find((r) => r?.config?.access?.apiKey);
      if (!rule) {
        return { id: 'personal', name: '个人 API', enabled: false, reason: '个人 provider 配置缺 apiKey', endpoint: null, models: [] };
      }
      return {
        id: 'personal',
        name: rule.providerName ?? '个人 API',
        enabled: true,
        reason: null,
        endpoint: rule.config?.api?.baseUrl ?? null,
        models: Array.isArray(rule.config?.personalModelIds) ? rule.config.personalModelIds.filter(Boolean) : [],
      };
    } catch (e) {
      if (e?.code !== 'ENOENT') warnings.push(`个人 provider 配置读取失败：${e.message}`);
      return { id: 'personal', name: '个人 API', enabled: false, reason: '个人 provider 配置不存在', endpoint: null, models: [] };
    }
  }

  /* ---------- ZB-44：OpenCode 只读探测（`--list-models` / `--version`，与派发**同用一个脚本**） ---------- */

  /** 跑一次只读子命令，返回 {ok, stdout, code, error}。**永不抛**（spawn 失败/超时都降级成 error 文案）。 */
  function runOpenCodeProbe(args, timeoutMs = 15000) {
    return new Promise((done) => {
      let child;
      try {
        child = spawnImpl(process.execPath, [opencodeRunnerPath, ...args], { cwd: runnerCwd, env: { ...process.env } });
      } catch (e) {
        done({ ok: false, stdout: '', code: null, error: `spawn 失败：${e.message}` });
        return;
      }
      let out = '';
      let err = '';
      let settled = false;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done(payload);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* 已退出 */ }
        /* ⚠️ 超时可配：默认 15s 够用于 `--list-models` / `--version`，
         * 但 ZB-52 的 `--with-variants`（要跑 `models --verbose`）更慢 ⇒ 会被误杀。 */
        finish({ ok: false, stdout: out, code: null, error: `探测超时（${Math.round(timeoutMs / 1000)}s）` });
      }, timeoutMs);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (d) => { err += d; });
      child.on('error', (e) => finish({ ok: false, stdout: out, code: null, error: e.message }));
      child.on('close', (code) => finish({
        ok: code === 0,
        stdout: out,
        code,
        error: code === 0 ? null : (String(err).trim().split('\n')[0] || `exit ${code}`),
      }));
    });
  }

  /**
   * ZB-51（T2）：三引擎**自动发现**（带缓存 + 后台刷新 + 在途去重）。
   *
   * 为什么要有缓存：发现层的 `--version` / `--list-models` 会 **spawn 子进程**（冷启可能数秒），
   * 而 `listChannels()` 会被面板反复调用。若每次都同步探测，就会重演 ZB-47 那个事故
   * （快照路径等慢探测 ⇒ 面板卡「连接中」）。故：
   *   · 有缓存（含过期缓存）⇒ **立刻返回缓存**，过期时**后台**刷新，绝不阻塞调用方；
   *   · 无缓存 ⇒ 只等这一次（首次调用必须给出结论），并做在途去重（并发调用共用同一次探测）。
   * 发现失败**绝不抛**（返回 {} + warning）—— 第三个引擎不能拖垮整份清单。
   */
  let engineDiscoveryCache = null;      // { at, value }
  let engineDiscoveryInFlight = null;
  const ENGINE_DISCOVERY_TTL_MS = 5 * 60 * 1000;

  function refreshEngineDiscovery() {
    if (engineDiscoveryInFlight) return engineDiscoveryInFlight;
    engineDiscoveryInFlight = (async () => {
      try {
        const r = await (discoverImpl ? discoverImpl() : discoverAll({ timeoutMs: 15000 }));
        engineDiscoveryCache = { at: nowMs(), value: r };
        return r;
      } catch (e) {
        /* 保留旧缓存（有旧值总比没有好），只在下一次刷新再试 */
        return engineDiscoveryCache?.value ?? {};
      } finally {
        engineDiscoveryInFlight = null;
      }
    })();
    return engineDiscoveryInFlight;
  }

  async function engineDiscovery() {
    /* 替身在场（也含被显式关闭的情形）⇒ 不做真探测，返回空结论。
     * 上层把空结论当"未探测"处理（engineDetail 里每个引擎 found:false + reason:'未探测'），不报错。 */
    if (!discoveryEnabled) return engineDiscoveryCache?.value ?? {};
    if (engineDiscoveryCache) {
      if (nowMs() - engineDiscoveryCache.at >= ENGINE_DISCOVERY_TTL_MS) void refreshEngineDiscovery();
      return engineDiscoveryCache.value;
    }
    return refreshEngineDiscovery();
  }

  /**
   * 把发现结果整理成**给面板/工具看的形状**（`engineDetail`）。
   * 每个引擎回答四件事：找到哪个文件 / 版本 / 是否已登录 / 什么形态 —— 便于"为什么这个引擎不见了"自查。
   */
  function summarizeEngineDiscovery(disc) {
    const out = {};
    for (const e of ENGINES) {
      const d = disc?.[e];
      if (!d) { out[e] = { found: false, form: null, entry: null, version: null, loggedIn: null, reason: '未探测', summary: `${e}: 未探测` }; continue; }
      out[e] = {
        found: !!d.found,
        form: d.form ?? null,
        entry: d.entry ?? null,
        entryKind: d.entryKind ?? null,
        version: d.version ?? null,
        loggedIn: d.loggedIn ?? null,
        variant: d.variant ?? null,
        reason: d.reason ?? '',
        loginEvidence: d.loginEvidence ?? null,
        summary: describeDiscovery(d),
      };
    }
    return out;
  }

  /**
   * ZB-51（T4）：探测 **Qoder 通道来源**。与 OpenCode 那条同构、同样**绝不抛**：
   * 探测失败只让 Qoder 通道为空 + 一条可读 warning（ZCode/OpenCode 照常）。
   * 模型清单来自 `qoder-run --list-models` 的真实输出（**不写死枚举**）。返回 {models, version, warning}。
   */
  /* ⚠️ `effortCacheFresh` 必须定义在**任何使用点之前**（本文件是模块顶层作用域，
   * `const` 在声明前使用会抛 TDZ ReferenceError —— 而 `node --check` 查不出来）。
   * 本项目已因此踩过多次（见 pitfalls「声明前使用」），故把它紧贴 `detectQoderChannels` 之前。 */
  const QODER_EFFORT_TTL_MS = 30 * 60 * 1000;
  /* ⚠️ ZB-56（用户真机反馈「思考强度选项有时候会加载不出来」）：**失败必须用短 TTL**。
   * 原实现失败时也写 `{ at: now }`，而 staleness 判断用 30 分钟 ⇒ **一次失败就锁死半小时不再重试**
   * （真机上表现就是"有时候档位一直不出来"，且越急越不出来）。
   * 现在：成功（拿到档位）才用 30 分钟；失败/空结果 ⇒ 1 分钟后自动重试。 */
  const EFFORT_TTL_RETRY_MS = 60 * 1000;
  /** 缓存是否还"新鲜"（不该重探）。**成功与失败用不同 TTL** —— 见上面注释。 */
  const effortCacheFresh = (cache) => {
    if (cache == null) return false;
    return nowMs() - cache.at < (cache.ok ? QODER_EFFORT_TTL_MS : EFFORT_TTL_RETRY_MS);
  };
  /* 缓存本体也在这里声明（不能只靠"async 函数调用得晚"侥幸躲过 TDZ —— 那是 latent 陷阱）。
   * OpenCode 的缓存也**一并提前**声明：下面 `loadEffortDiskCache`/`saveEffortDiskCache` 会引用它。 */
  let qoderEffortCache = null;
  let qoderEffortInFlight = null;
  let opencodeEffortCache = null;
  let opencodeEffortInFlight = null;

  /* ── ZB-57：档位探测结果的**磁盘缓存**（解决"每次重启都要等 2 分钟"）──
   * 形状：`{version:1, opencode:{at,value}, qoder:{at,value}}`（只存**成功**的结果）。
   * 只读/只写 `<workRoot>/state/effort-cache.json`；任何异常都 fail-open（当作没有缓存）。 */
  function loadEffortDiskCache() {
    try {
      const data = JSON.parse(readFileSync(effortCacheFile, 'utf8'));
      const take = (slot) => {
        if (!slot || typeof slot !== 'object' || slot.value == null) return null;
        if (!Number.isFinite(slot.at) || nowMs() - slot.at >= EFFORT_DISK_TTL_MS) return null; // 过期 ⇒ 不要
        return { at: slot.at, value: slot.value, ok: true, fromDisk: true };
      };
      const q = take(data?.qoder);
      const o = take(data?.opencode);
      if (q) qoderEffortCache = q;
      if (o) opencodeEffortCache = o;
    } catch { /* 无文件/损坏：当作没有（不猜、不抛） */ }
  }

  function saveEffortDiskCache() {
    try {
      const slot = (cache) => (cache && cache.value != null ? { at: cache.at, value: cache.value } : null);
      const q = slot(qoderEffortCache);
      const o = slot(opencodeEffortCache);
      if (!q && !o) return; // 一个成功结果都没有 ⇒ 不写空文件
      atomicWrite(effortCacheFile, `${JSON.stringify({ version: 1, qoder: q, opencode: o }, null, 2)}\n`);
    } catch { /* 落盘失败只影响下次启动速度，绝不影响本次功能 */ }
  }

  async function detectQoderChannels() {
    if (!qoderRunnerPath) return { models: [], version: null, warning: null };
    if (!existsSync(qoderRunnerPath)) {
      return { models: [], version: null, warning: `Qoder 执行器不存在：${qoderRunnerPath} —— Qoder 通道为空（不影响其它引擎）` };
    }
    const list = await runQoderProbe(['--list-models']);
    if (!list.ok) {
      const detail = list.error ?? `exit ${list.code}`;
      /* 未登录是最常见原因：把"怎么登"直接写进 warning（教学优先）。 */
      const hint = /not logged in/i.test(String(list.stdout ?? '') + String(list.stderr ?? ''))
        ? '（Qoder CLI 未登录：运行 `qoderclicn login`，或设 QODER_PERSONAL_ACCESS_TOKEN）'
        : '';
      return { models: [], version: null, warning: `Qoder 模型探测失败（${detail}）${hint} —— Qoder 通道为空（不影响其它引擎）` };
    }
    /* 每行一个**裸模型名**（真机可能含空格与点：`Qwen3.8-Max` / `GLM-5.3`）；不合法形态的行忽略（不猜）。 */
    const all = [...new Set(String(list.stdout).split('\n').map((s) => s.trim())
      .filter((s) => isQoderModelName(s)))];
    let version = null;
    const v = await runQoderProbe(['--version']);
    if (v.ok) {
      const m = String(v.stdout).match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
      version = m ? m[1] : (String(v.stdout).trim().split('\n')[0].trim() || null);
    }
    /* ZB-52：档位表（思考强度）。**不阻塞本次清单** —— 真机实测 `--with-efforts` 约 2 分钟
     * （15 模型 × 9 次 CLI 调用），若同步等它，面板每次拉通道都要卡两分钟。
     * 故：本次用缓存值（可能为空），同时**后台预热**下次就有值。 */
    const levels = qoderEffortCache?.value ?? null;
    if (!effortCacheFresh(qoderEffortCache)) {
      void refreshQoderEfforts();
    }
    return {
      models: all,
      version,
      levels,
      warning: all.length === 0 ? 'Qoder 模型探测未返回任何合法模型名 —— Qoder 通道为空（不影响其它引擎）' : null,
    };
  }

  /* ── ZB-52：Qoder **档位表**探测（`--with-efforts`）的缓存 ──
   * 与 `engineDiscovery` 同一套范式（TTL + 后台刷新 + in-flight 去重）：
   * 贵（约 2 分钟）⇒ 绝不能挡在通道清单的同步路径上。
   * ⚠️ TTL 常量、`effortCacheFresh` 与缓存本体都已提到 `detectQoderChannels` **之前**定义
   * （避免 TDZ，因为那个函数会用到它们）—— 这里不要再定义一份。 */

  function refreshQoderEfforts() {
    if (qoderEffortInFlight) return qoderEffortInFlight;
    qoderEffortInFlight = (async () => {
      try {
        const r = await runQoderProbe(['--list-models', '--with-efforts'], 240000);
        let value = null;
        if (r.ok) {
          /* 解析 `[qoder-run] reasoning-efforts <模型>=<a,b,c>` →
           * levels=各模型档位集的**并集**（引擎级；逐模型子集 CLI 拿不到，见执行器注释）。 */
          const set = new Set();
          for (const line of String(r.stdout ?? '').split('\n')) {
            const m = line.match(/reasoning-efforts\s+(.+?)=([^\s]+)\s*$/);
            if (!m) continue;
            for (const lv of m[2].split(',').map((s) => s.trim()).filter(Boolean)) set.add(lv);
          }
          if (set.size) value = [...set];
        }
        if (value) {
          qoderEffortCache = { at: nowMs(), value, ok: true };
          saveEffortDiskCache(); // ZB-57：落盘 ⇒ 下次重启 DSH 秒级可用（不用再等 2 分钟）
        } else {
          /* 失败 / 解析不出任何档位 ⇒ 保留旧值（若有），时间戳只用来决定"多久后再试"。
           * ⚠️ 不能编造档位；也**不能**因为失败就把重试推迟到 30 分钟后。 */
          qoderEffortCache = { at: nowMs(), value: qoderEffortCache?.value ?? null, ok: false };
        }
        return qoderEffortCache.value;
      } catch {
        qoderEffortCache = { at: nowMs(), value: qoderEffortCache?.value ?? null, ok: false };
        return qoderEffortCache.value;
      } finally {
        qoderEffortInFlight = null;
      }
    })();
    return qoderEffortInFlight;
  }

  /** Qoder 只读探测（spawn 一次，带超时；永不抛）。 */
  async function runQoderProbe(args, timeoutMs = 30000) {
    return new Promise((done) => {
      let child;
      try {
        child = spawnImpl(process.execPath, [qoderRunnerPath, ...args], { cwd: runnerCwd, env: { ...process.env } });
      } catch (e) {
        done({ ok: false, error: e?.message ?? String(e) });
        return;
      }
      let stdout = ''; let stderr = '';
      /* ⚠️ 超时**必须可配**：默认 30s 够用于 `--list-models` / `--version`，
       * 但 ZB-52 的 `--with-efforts` 真机约 2 分钟（15 模型 × 9 次 CLI 调用）⇒ 会被误杀。
       * 调用方按需传（见 refreshQoderEfforts）。 */
      const timer = setTimeout(() => { try { child.kill(); } catch { /* 尽力 */ } done({ ok: false, error: 'timeout' }); }, timeoutMs);
      child.stdout?.setEncoding?.('utf8');
      child.stderr?.setEncoding?.('utf8');
      child.stdout?.on('data', (c) => { stdout += c; });
      child.stderr?.on('data', (c) => { stderr += c; });
      child.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: e?.message ?? String(e) }); });
      child.on('close', (code) => { clearTimeout(timer); done({ ok: code === 0, code, stdout, stderr }); });
    });
  }

  /**
   * 探测 OpenCode 通道来源。**绝不抛**，且**探测失败只让自己为空 + 一条可读 warning** ——
   * 绝不能因为 OpenCode 不可用就让整份通道清单失败（OpenCode 是增量能力）。
   * 模型清单来自 `--list-models` 的真实输出，**不写死枚举**（避免重演 ZB-31「表变了但代码写死」）。
   * 返回 {models, version, warning}。
   */
  async function detectOpenCodeChannels() {
    if (!opencodeProbeEnabled) return { models: [], version: null, warning: null };
    if (!opencodeRunnerPath) {
      return { models: [], version: null, warning: 'OpenCode 执行器未配置（opencodeRunnerPath 为空）—— OpenCode 通道为空（ZCode 通道不受影响）' };
    }
    if (!existsSync(opencodeRunnerPath)) {
      return { models: [], version: null, warning: `OpenCode 执行器不存在：${opencodeRunnerPath} —— OpenCode 通道为空（ZCode 通道不受影响）` };
    }
    const list = await runOpenCodeProbe(['--list-models']);
    if (!list.ok) {
      return { models: [], version: null, warning: `OpenCode 模型探测失败（${list.error ?? `exit ${list.code}`}）—— OpenCode 通道为空（ZCode 通道不受影响）` };
    }
    /* 每行一个模型 id（形如 `opencode/deepseek-v4.1-flash-free`）；不合形态的行忽略（不猜）。 */
    const all = [...new Set(String(list.stdout).split('\n').map((s) => s.trim()).filter((s) => isOpenCodeId(s)))];
    const models = opencodeMaxModels > 0 ? all.slice(0, opencodeMaxModels) : all;
    let version = null;
    const v = await runOpenCodeProbe(['--version']);
    if (v.ok) version = String(v.stdout).trim().split('\n')[0].trim() || null;
    /* ZB-52：思考强度档位（`--variant`）。与 Qoder 同策略：**不阻塞本次清单** —— 用缓存值，
     * 同时后台预热。OpenCode 的档位是**逐模型**的（实测 `big-pickle` 等 4 个模型根本没有
     * variants 键），故这里按 **modelId → levels** 记录，而不是给一个引擎级并集。 */
    const ocLevels = opencodeEffortCache?.value ?? null;
    if (!effortCacheFresh(opencodeEffortCache)) {
      void refreshOpenCodeEfforts();
    }
    return {
      models,
      version,
      perModelLevels: ocLevels, // Map/对象：`opencode/<model>` → [档位]
      warning: all.length === 0
        ? 'OpenCode 模型探测未返回任何合法模型 id（形态 opencode/<model>）—— OpenCode 通道为空（ZCode 通道不受影响）'
        : null,
    };
  }

  /* ── ZB-52：OpenCode **逐模型**档位探测（`--with-variants`）的缓存 ──
   * 与 Qoder 侧同一套范式（TTL + 后台刷新 + in-flight 去重）。`models --verbose` 需要跑 CLI，
   * 故同样不能挡在通道清单的同步路径上。
   * ⚠️ 缓存本体（`opencodeEffortCache`/`opencodeEffortInFlight`）已在上方统一声明（避免 TDZ）。 */

  function refreshOpenCodeEfforts() {
    if (opencodeEffortInFlight) return opencodeEffortInFlight;
    opencodeEffortInFlight = (async () => {
      try {
        const r = await runOpenCodeProbe(['--list-models', '--with-variants'], 180000);
        let value = null;
        if (r.ok) {
          /* 解析 `[opencode-run] variants <modelId>=<a,b,c>` → {modelId: [levels]}。
           * **只为真的报了档位的模型建条目**：没有档位维度的模型（真机 4 个）如实缺席。 */
          const map = Object.create(null);
          for (const line of String(r.stdout ?? '').split('\n')) {
            const m = line.match(/variants\s+(.+?)=([^\s]+)\s*$/);
            if (!m) continue;
            const lv = m[2].split(',').map((s) => s.trim()).filter(Boolean);
            if (lv.length) map[m[1]] = lv;
          }
          if (Object.keys(map).length) value = map;
        }
        /* ZB-56：成功才用长 TTL；失败/空结果用**短 TTL**（见 Qoder 侧的注释）—— */
        if (value) {
          opencodeEffortCache = { at: nowMs(), value, ok: true };
          saveEffortDiskCache(); // ZB-57：落盘 ⇒ 下次重启 DSH 秒级可用
        } else {
          opencodeEffortCache = { at: nowMs(), value: opencodeEffortCache?.value ?? null, ok: false };
        }
        return opencodeEffortCache.value;
      } catch {
        opencodeEffortCache = { at: nowMs(), value: opencodeEffortCache?.value ?? null, ok: false };
        return opencodeEffortCache.value;
      } finally {
        opencodeEffortInFlight = null;
      }
    })();
    return opencodeEffortInFlight;
  }

  /** 通道清单：runner --list-providers 真实输出为骨架，叠加权益缓存/展示名/personal 通道，
   *  再接上**探测式**的 OpenCode 免费模型通道。解析失败 → {channels:[], warnings}，绝不猜测。
   *  首条是 runner 文档化的 plan 别名；数组顺序恒为「先 zcode 全部，再 opencode 全部」。
   *  ZB-44：每个通道都带 `engine`（zcode 显式标出，绝不留 undefined）；顶层带 `engines`（供客户端分组）。 */
  async function listChannels() {
    if (channelsImpl) {
      /* 注入式清单（测试/宿主替身）：原样返回，只补一个 engines（形状契约，不覆盖注入方自己的值）。 */
      const injected = await channelsImpl();
      return injected && typeof injected === 'object' && !Array.isArray(injected)
        ? { engines: [...ENGINES], ...injected }
        : injected;
    }
    const warnings = [];
    let text = null;
    if (channelsProbeImpl) {
      try {
        text = await channelsProbeImpl();
      } catch (e) {
        warnings.push(`通道探测失败：${e?.message ?? e}`);
      }
    } else {
      text = await new Promise((done) => {
        let child;
        try {
          child = spawnImpl(process.execPath, [runnerPath, '--list-providers'], { cwd: runnerCwd, env: { ...process.env } });
        } catch {
          done(null);
          return;
        }
        let out = '';
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* 已退出 */ }
        }, 15000);
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (d) => { out += d; });
        child.on('error', () => {
          clearTimeout(timer);
          done(out || null);
        });
        child.on('close', () => {
          clearTimeout(timer);
          done(out);
        });
      });
    }
    const parsed = parseProviderTable(text);
    warnings.push(...parsed.warnings);
    if (parsed.rows.length === 0) {
      /* 既有语义（有测试锁定）：zcode 骨架解析不出任何 provider 行 ⇒ 空清单 + 可读原因，不猜。
       * 此时**不**再去探测 OpenCode：清单的骨架来自 ZCode runner，骨架都没有就无从谈"当前可用通道"。 */
      return { channels: [], engines: [...ENGINES], opencodeVersion: null, warnings: [...warnings, '无法解析通道清单，不猜测（检查 runner 与 ~/.zcode/v2/config.json）'] };
    }
    const names = readConfigNames();
    const cache = readPlanCache(warnings);
    /* ZB-29：每个模型的思考强度档位（runner 探测输出；无该行 = 旧 runner，字段留空不猜）。 */
    const modelLevels = parsed.modelLevels ?? {};
    const levelsOf = (modelIds) => {
      const set = new Set();
      let seen = false;
      for (const id of modelIds ?? []) {
        const lv = modelLevels[id];
        if (!lv) continue;
        seen = true;
        for (const x of lv) set.add(x);
      }
      return seen ? [...set] : null; // null = 声明缺失（不猜，UI 退回通用提示）
    };
    const channels = parsed.rows.map((r) => ({
      id: r.id,
      name: names[r.id] ?? (GIFT_CHANNEL_RE.test(r.id) ? '免费额度（Start Plan）' : r.id),
      enabled: r.enabled,
      reason: r.reason ?? (cache[r.id]?.status === 'unavailable' ? cache[r.id]?.reason ?? null : null),
      endpoint: r.endpoint,
      models: r.models,
      ...(Object.keys(modelLevels).length ? { thinkingLevels: levelsOf(r.models) } : {}),
      ...(cache[r.id]?.status ? { cacheStatus: cache[r.id].status } : {}),
    }));
    // plan 别名：runner 文档化行为「选第一个启用的 *coding-plan，其次 *start-plan」
    const ranked = channels
      .filter((c) => /coding-plan|start-plan/.test(c.id))
      .sort((a, b) => (Number(b.enabled) - Number(a.enabled)) || (Number(/start-plan/.test(a.id)) - Number(/start-plan/.test(b.id))));
    const pick = ranked.find((c) => c.enabled) ?? null;
    const planAlias = {
      id: 'plan',
      name: '默认套餐（runner 自动选择）',
      enabled: !!pick,
      reason: pick ? null : '没有已启用的套餐 provider',
      endpoint: pick?.endpoint ?? null,
      models: pick ? [...pick.models] : [],
      ...(Object.keys(modelLevels).length ? { thinkingLevels: pick ? levelsOf(pick.models) : null } : {}),
      ...(pick ? { aliasOf: pick.id } : {}),
    };
    /* ZB-31（用户报「deepseek-flash 没有低/高/最高」）：个人通道的档位同样从**同一份探测表**取 ——
     * runner 现已把个人通道模型也纳入 `reasoning-levels` 输出（ZB-31 runner 侧修），
     * 这里只需把它接上（原先 personal 通道根本没有 thinkingLevels 字段 ⇒ 面板退回通用提示）。 */
    const personal = readPersonalChannel(warnings);
    /* ZB-44：zcode 侧通道全部显式标 engine:'zcode'（不再留 undefined，客户端可直接按 engine 分组）。 */
    const zcodeChannels = [
      { engine: 'zcode', ...planAlias },
      {
        engine: 'zcode',
        ...personal,
        ...(Object.keys(modelLevels).length ? { thinkingLevels: levelsOf(personal.models) } : {}),
      },
      ...channels.map((c) => ({ engine: 'zcode', ...c })),
    ];

    /* ── ZB-51：ZCode 通道**白名单**（用户决定，2026-10-17）──
     * 只保留两条：
     *   · `plan`                     默认套餐（runner 自动选择 provider）
     *   · `account:bigmodel-start-plan`  免费额度（Start Plan）
     * 其余全部剔除（`personal` / `builtin:*` / 各 UUID 路由）。
     *
     * 为什么用**白名单**而不是黑名单：ZCode 的通道来自 runner 的 `--list-providers` 解析，
     * 清单随账号/版本变化（本次实测 10 条，含多条 `oauth_provider_inactive` 的死路由）。
     * 白名单能保证"面板上永远只有用户要的那两条"，新出现的路由不会自己冒出来。
     *
     * ⚠️ 只过滤**派发台清单**，绝不改用户 ZCode 自己的配置文件（`~/.zcode/v2/config.json`）——
     * 那是 ZCode 客户端的配置，删了会影响 ZCode 本体。
     * ⚠️ 剔除是**彻底**的：面板、agent 工具 `action=channels`、降级链候选都看不到它们；
     * 若某条仍在别处被显式指定（如历史存值/工具直接传 id），`dispatch()` 仍照常工作 ——
     * 白名单只约束"清单里列什么"，不拦截显式调用（与既有过滤开关同一语义）。 */
    const ZCODE_CHANNEL_ALLOWLIST = ['plan', 'account:bigmodel-start-plan'];
    const zcodeChannelsFiltered = zcodeChannels.filter((c) => ZCODE_CHANNEL_ALLOWLIST.includes(String(c.id)));
    const zcodeDropped = zcodeChannels.filter((c) => !ZCODE_CHANNEL_ALLOWLIST.includes(String(c.id)));
    if (zcodeDropped.length) {
      /* 在 warnings 里留痕（不静默）：让"为什么少了通道"永远可查。
       * ⚠️ 前缀 `[info]` 是**约定**：客户端据此把它渲染成**中性提示**，而不是红色"加载失败"
       * （真机反馈：这条信息被渲染成 `通道清单加载失败: …` ⇒ 用户以为插件坏了）。
       * 凡是"按配置剔除/过滤"这类**预期**留痕，都带这个前缀。 */
      warnings.push(`[info] ZCode 通道按白名单只保留 ${ZCODE_CHANNEL_ALLOWLIST.join(' / ')}；已剔除 ${zcodeDropped.length} 条：${zcodeDropped.map((c) => c.id).join(', ')}`);
    }

    /* ZB-44：OpenCode 通道 = **探测结果**（每次跑 --list-models，不写死枚举）。每个模型一个通道，
     * 通道 id 就用 `opencode/<model>` 原样 —— 面板/工具选它即选中该免费模型（通道即执行目标）。 */
    const oc = await detectOpenCodeChannels();
    if (oc.warning) warnings.push(oc.warning);
    const opencodeChannels = oc.models.map((id) => ({
      id,
      name: id.startsWith('opencode/') ? id.slice('opencode/'.length) : id, // 短名（去掉 provider 前缀）
      engine: 'opencode',
      enabled: true,
      reason: null,
      endpoint: null,
      models: [id],
      /* ZB-52：思考强度档位（`--variant`）—— **逐模型**（实测 `big-pickle` 等 4 个模型没有
       * variants 键）⇒ 没有就不带该字段，**绝不给它造档位**。 */
      ...(oc.perModelLevels && Array.isArray(oc.perModelLevels[id]) && oc.perModelLevels[id].length
        ? { thinkingLevels: [...oc.perModelLevels[id]] }
        : {}),
    }));

    /* ZB-51（T4）：Qoder 通道 = **探测结果**（`qoder-run --list-models`，不写死枚举）。
     * 通道 id 形如 `qoder/<模型名>`（真机模型名含空格与点，如 `qoder/Qwen3.8-Max`）。 */
    const qd = qoderProbeEnabled ? await detectQoderChannels() : { models: [], version: null, warning: null };
    if (qd.warning) warnings.push(qd.warning);
    /* ZB-75：把 Qoder 的**引擎级**档位并集存到闭包缓存，供 `suggestStrongerLevel()`（向上改档位）
     * 在"该模型没有逐模型声明"时兜底取用（那份数据本来就在这里，别处拿不到）。 */
    if (Array.isArray(qd.levels) && qd.levels.length) qoderLevelsCache = [...qd.levels];
    const qoderChannels = qd.models.map((name) => ({
      id: `qoder/${name}`,
      name,
      engine: 'qoder',
      enabled: true,
      reason: null,
      endpoint: null,
      models: [`qoder/${name}`],
      /* ZB-52/ZB-75：思考强度档位（面板「思考强度」下拉据此渲染；没有就不带该字段）。
       * ZB-75：**优先用逐模型声明**（`QODER_MODEL_LEVELS`，来自 Qoder GUI 模型卡片）——
       * 该模型有声明就用它（面板只列真正可选的档位，不再让用户选到会被服务端拒绝的档位）；
       * 没有声明才退回**引擎级**并集（`qd.levels`），并在通道上标注 `thinkingLevelsScope:'engine'`
       * 让面板/工具能如实说明"这是引擎级集合、非逐模型精确"。 */
      ...(QODER_MODEL_LEVELS[name]
        ? { thinkingLevels: [...QODER_MODEL_LEVELS[name]], thinkingLevelsScope: 'model' }
        : (Array.isArray(qd.levels) && qd.levels.length
          ? { thinkingLevels: [...qd.levels], thinkingLevelsScope: 'engine' }
          : {})),
    }));

    /* ZB-51：**免费额度（Start Plan）实际可用的模型**必须在这里收窄 —— 这里是**单一权威**
     * （面板与 agent 工具 `action=channels` 都读这份清单）。
     *
     * 为什么必须在 core 收窄，而不是只做在面板上：否则 `action=channels` 会告诉 agent
     * "免费额度有 GLM-5.3 与 GLM-5.3-Flash"，agent 据此派发就可能选到**该额度并不提供**的模型
     * （`plan` 与免费额度**提供同样的模型名**，但两者是**两套独立实现**：provider 不同、
     * 端点不同、计费不同）。用户实测：Start Plan 只给 `GLM-5.3-Flash`。
     * 权益变化时改这一行（面板侧 `ZC_FREE_MODELS` 是同一份约定的镜像）。 */
    const ZC_FREE_MODELS = ['GLM-5.3-Flash'];
    const zcodeChannelsFinal = zcodeChannelsFiltered.map((c) => {
      if (!/^account:.*start-plan$/.test(String(c.id))) return c;
      const allowed = (Array.isArray(c.models) ? c.models : []).filter((m) => ZC_FREE_MODELS.includes(m));
      return allowed.length ? { ...c, models: allowed } : c; // 白名单写空时 fail-open（不清空）
    });

    const all = [...zcodeChannelsFinal, ...opencodeChannels, ...qoderChannels]
      /* ZB-58（逐模型开关）：给每条通道打上 `userDisabled` 标记 —— **不删除**。
       * 为什么不删除：① 面板要能列出"已关闭"的模型让用户重新打开；② 当前选中的值若恰好被关掉，
       * 下拉仍需能渲染出它（否则 <select> 会掉到首项、显示与真实存值不符）。
       * 面板「模型」选项据此过滤（关掉的不出现），顺序链也在 expandSequentialChain 里跳过。
       *
       * ⚠️ **禁用清单的身份是「模型项 key」**（面板「模型」下拉的 key）：
       *   · opencode/qoder：key = 通道 id（一个通道就是一个模型）⇒ 与 id 相同；
       *   · ZCode：key = `<路由id>::<模型名>`（一条路由可带多个模型）⇒ **必须用复合键**，
       *     否则"关掉 GLM-5.3"会连带关掉同路由的 GLM-5.3-Flash（真机反馈过的粒度问题）。
       * 通道级标记 = 该通道的模型 key **全部**被关掉时才算关（部分关时由面板按 key 精确判断）。 */
      .map((c) => {
        const eng = normalizeEngine(c.engine ?? inferEngine({ provider: c.id }));
        const modelKeys = (Array.isArray(c.models) ? c.models : [])
          .map((m) => (eng === 'zcode' ? `${c.id}::${m}` : String(m)));
        const allModelsOff = modelKeys.length > 0 && modelKeys.every((k) => disabledModels.has(k));
        return {
          ...c,
          userDisabled: disabledModels.has(String(c.id)) || allModelsOff,
        };
      });
    /* ZB-56（用户真机反馈「思考强度选项有时候会加载不出来」）：
     * 把**档位探测的状态**如实告诉面板 —— `pending` = 还没探到（探测在后台跑，Qoder 约 2 分钟），
     * `ready` = 已探到。面板据此显示「档位载入中…」而不是**只列一个「默认」**让人以为这模型没档位。
     * ⚠️ 只报状态，**不编造档位**；`none` 表示该引擎的模型确实都没有档位维度。 */
    const levelsStatusOf = (cache) => {
      if (cache?.ok) return 'ready';
      if (cache?.value) return 'ready'; // 有旧值也算 ready（失败时保留旧值）
      return 'pending';
    };
    const levelsStatus = {
      zcode: zcodeChannelsFinal.some((c) => Array.isArray(c.thinkingLevels) && c.thinkingLevels.length) ? 'ready' : 'none',
      opencode: levelsStatusOf(opencodeEffortCache),
      qoder: levelsStatusOf(qoderEffortCache),
    };
    /* 通道→引擎快照落盘（dispatch/startJob 同步读它把通道 id 映射到引擎）。
     * 写盘失败只记一条 warning，绝不影响本次清单返回；内容无变化时 setEngineMap 内部不重写。 */
    try {
      setEngineMap(all);
    } catch (e) {
      warnings.push(`通道→引擎快照写入失败（不影响本次清单）：${e?.message ?? e}`);
    }
    /* ZB-51（T2）：把**自动发现**的结论一并返回 —— 面板/工具据此显示"引擎形态/版本/登录态"，
     * 并能在某个引擎不可用时给出**可操作**的原因（而不是让用户对着空通道猜）。
     * 替身场景（discoveryEnabled=false）⇒ 保持 `engineDetail: null`，不产出满屏"未探测"的假条目。 */
    let engineDetail = null;
    try {
      if (discoveryEnabled) {
        const disc = await engineDiscovery();
        engineDetail = summarizeEngineDiscovery(disc);
        for (const e of ENGINES) {
          const d = disc?.[e];
          if (!d) continue;
          if (!d.found) {
            /* 找不到引擎 ≠ 插件坏了：把原因与修法一起说出来（reason 里已含查过多少处 + 怎么修） */
            warnings.push(`未检测到 ${e} 引擎：${d.reason}`);
          } else if (d.loggedIn === false) {
            /* 有 CLI 但未登录是**最容易被误判成"执行器坏了"**的状态 —— 显式提示登录方式 */
            warnings.push(`${e} 已找到但未登录（${d.loginEvidence ?? ''}）：${(d.warnings ?? [])[0] ?? '请先登录'}`);
          }
        }
      }
    } catch (e) {
      /* 发现层出问题绝不影响通道清单本身（它只是诊断信息） */
      warnings.push(`引擎自动发现失败（不影响通道清单）：${e?.message ?? e}`);
    }

    return {
      channels: all,
      engines: [...ENGINES],
      engineDetail,
      levelsStatus, // ZB-56：逐引擎档位探测状态（ready | pending | none），面板据此显示「载入中」
      opencodeVersion: oc.version,
      warnings,
    };
  }

  /** ZB-75（用户教学要求）：**核对思考档位是否真的按设置生效**。
   *
   * 判据（只在有观测信号时判定 —— 没有信号就说"无法核对"，绝不猜）：
   *   · 请求档位缺失 / `agent` / 本身就是"不思考"档（none|disabled）⇒ **不算不符**
   *     （用户本就要不思考，silent 是符合预期的）；
   *   · 有 `thinkingObserved` 且为 `silent`，而请求档位要求思考 ⇒ **不符**（静默降级）。
   *
   * 向上改档位建议（`suggested`，用户要求"优先向上改"）：
   *   在当前请求档位之上、**该模型支持的档位**里找第一个更强的；没有更强的就不建议
   *   （如实说"已是最强档"而不是瞎指一个）。
   *
   * @returns {{mismatch:boolean, warning:string|null, suggested:string|null, checkable:boolean}}
   */
  function checkThinkingApplied(job) {
    const requested = job.spec?.reasoningLevel ?? null;
    const observed = job.thinkingObserved ?? null;
    /* 没有观测信号（zcode/opencode 不上报；或旧执行器）⇒ 无法核对。如实说明，绝不假设通过。 */
    if (observed == null) {
      return { mismatch: false, warning: null, suggested: null, checkable: false };
    }
    /* 请求侧"不要求思考"⇒ 与 silent 一致，不是不符。 */
    if (requested == null || requested === '' || requested === 'agent' || THINK_OFF_LEVELS.has(String(requested))) {
      return { mismatch: false, warning: null, suggested: null, checkable: true };
    }
    if (observed !== 'silent') return { mismatch: false, warning: null, suggested: null, checkable: true };
    /* ★ 不符：请求要思考，实际一块 thinking 都没有。 */
    const suggested = suggestStrongerLevel(job, requested);
    const tail = suggested
      ? `建议**向上**改用 \`${suggested}\` 重试（优先向上：${requested} → ${suggested}）。`
      : `该模型已无更强档位可用（当前 \`${requested}\` 之上没有可选档位）—— 请改模型或确认该模型是否支持思考。`;
    return {
      mismatch: true,
      suggested,
      checkable: true,
      warning: `思考档位核对不符：请求 \`${requested}\`（要求思考），但本次**一个 thinking 内容块都没有**`
        + `（observed=silent, blocks=${job.thinkingBlocks ?? 0}）⇒ 档位很可能被引擎/服务端静默降级。${tail}`
        + '（Qoder 引擎不回报实际档位，此判据基于 thinking 内容块的有无，见 ZB-75。）',
    };
  }

  /** ZB-75：在该模型**支持的档位**里，找比 `cur` 更强的最近一档（用户要求"优先向上改"）。
   *  支持集优先取逐模型声明（`QODER_MODEL_LEVELS`），否则取引擎级并集（`channelLevels` 缓存）。
   *  返回 null = 没有更强的（或拿不到支持集 ⇒ 不猜）。 */
  function suggestStrongerLevel(job, cur) {
    const model = String(job.spec?.model ?? '');
    const bare = model.replace(/^qoder\//, '');
    const declared = QODER_MODEL_LEVELS[bare];
    const supported = Array.isArray(declared) && declared.length
      ? declared
      : (Array.isArray(qoderLevelsCache) && qoderLevelsCache.length ? qoderLevelsCache : null);
    if (!supported) return null;                       // 拿不到支持集 ⇒ 不猜（绝不瞎指一个档位）
    const ci = strengthOf(cur);
    if (ci < 0) return null;                           // 语义档位（auto/agent）不参与向上比较
    /* ★ 找**最近的**更强档（而不是最强档）—— "向上改"要**渐进**：一次跳太强会白烧额度，
     * 且用户说的是"优先向上改档位"（先试更强一档），不是"直接拉满"。
     * 实测踩到：原实现每发现更强就更新基准 ⇒ 最终返回**最强**档（low → xhigh），与预期不符。 */
    let best = null;
    let bestS = Infinity;
    for (const lv of supported) {
      const s = strengthOf(lv);
      if (s > ci && s < bestS) { bestS = s; best = lv; }
    }
    return best;
  }

  /** 按 tag 回读台账最后一条匹配记录（已知 sessionId 时优先精确匹配），只补 job 缺失的字段。 */
  function mergeFromLedger(job) {
    if (!ledgerPath || !existsSync(ledgerPath)) return;
    let records;
    try {
      records = readFileSync(ledgerPath, 'utf8').split('\n');
    } catch (e) {
      job.parseWarnings.push(`ledger-read-failed: ${e.message}`);
      return;
    }
    const matches = [];
    let badLines = 0;
    for (const l of records) {
      const t = l.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (rec && typeof rec === 'object' && job.tag != null && rec.tag === job.tag) matches.push(rec);
      } catch {
        badLines += 1;
      }
    }
    if (badLines > 0) job.parseWarnings.push(`ledger had ${badLines} unparsable line(s) while matching`);
    if (matches.length === 0) return;

    const rec = job.sessionId
      ? [...matches].reverse().find((r) => r.sessionId === job.sessionId)
      : matches[matches.length - 1];
    if (!rec) return; // 有同名 tag 记录但 sessionId 都不匹配：宁可不绑，避免串到旧 run
    job.ledgerMatched = true;

    const fill = (k, v) => {
      if (v != null && job[k] == null) job[k] = v;
    };
    fill('sessionId', rec.sessionId);
    fill('provider', rec.provider);
    fill('endpoint', rec.endpoint);
    fill('model', rec.model);
    fill('contextUsed', rec.contextUsed);
    fill('contextWindow', rec.contextWindow);
    fill('responseChars', rec.responseChars);
    fill('billing', rec.billing);
    fill('traceId', rec.traceId);
    if (job.exitCode == null) job.exitCode = rec.exit ?? null;
    fill('elapsedSec', rec.elapsedSec != null ? Number(rec.elapsedSec) : null);
    for (const k of ['requests', 'inputTokens', 'outputTokens', 'cacheReadTokens']) {
      if (job.usage[k] == null && rec[k] != null) job.usage[k] = Number(rec[k]) || 0;
    }
  }

  /* ---------- 公开 API ---------- */

  /**
   * ZB-44：spec 的**有效引擎**（不猜：显式 → `opencode/<model>` 通道形态 → 通道→引擎快照 → 默认引擎）。
   * 快照由 listChannels 落盘（<workRoot>/state/channels.json），故这里是**同步**可判的 ——
   * 这正是 dispatch/startJob 这类同步入口能识别引擎的原因。
   */
  function resolveEngineOf(spec) {
    const explicit = typeof spec?.engine === 'string' ? spec.engine.trim().toLowerCase() : '';
    if (ENGINES.includes(explicit)) return explicit;                    // ① 显式合法值优先
    if (isOpenCodeId(spec?.provider)) return 'opencode';                 // ② opencode/<model> 通道
    /* ZB-51：`qoder/<model>` 通道形态同样是**判据**。漏掉这条会让 Qoder 通道回落成 zcode
     * （真机验收到：`provider:'qoder/Fast'` 被推断为 engine=zcode ⇒ 派给了错的引擎）。 */
    if (isQoderId(spec?.provider)) return 'qoder';
    /* ③ 裸引擎名（规整后的形态）：`provider:'qoder'` / `'opencode'` 也是引擎判据。
     * 这些值**不是**通道 id（真通道是 `qoder/<model>`），但调用方可能已经规整过或直接指定。 */
    const bareProvider = typeof spec?.provider === 'string' ? spec.provider.trim().toLowerCase() : '';
    if (bareProvider === 'opencode') return 'opencode';
    if (bareProvider === 'qoder' || bareProvider === 'qoder-cn' || bareProvider === 'qoder-global') return 'qoder';
    const mapped = engineById[String(spec?.provider ?? '')];             // ④ 通道→引擎快照
    if (ENGINES.includes(mapped)) return mapped;
    return inferEngine(spec);                                            // ⑤ 协议模块的默认判据（= zcode）
  }

  /** 引擎规整（dispatch / dispatchRaw 共用）：解析引擎 → 用协议模块把 `opencode/<model>` 通道
   *  规整成 `{engine:'opencode', provider:'opencode', model:'opencode/<model>'}`（幂等）。 */
  function effEngineSpec(spec) {
    const out = { ...(spec ?? {}) };
    out.engine = resolveEngineOf(out);
    return normalizeEngineSpec(out);
  }

  function validateSpec(spec) {
    if (!spec || !KINDS.has(spec.kind)) throw new TypeError(`dispatch(spec): spec.kind 必须是 ${[...KINDS].join('|')}`);
    /* ZB-44：显式 engine 必须是合法值（列出合法值）—— 拼错的引擎名必须报错，绝不静默回落成 zcode。
     * null/undefined/空串视为「未指定」（面板/工具的可选参数经常传空串）。 */
    const rawEngine = spec.engine == null ? '' : String(spec.engine).trim().toLowerCase();
    if (rawEngine && !ENGINES.includes(rawEngine)) {
      throw new TypeError(`dispatch(spec): spec.engine 必须是 ${ENGINES.join('|')}（收到 ${JSON.stringify(spec.engine)}）`);
    }
    const engine = resolveEngineOf(spec);
    const body = { task: spec.task, prompt: spec.prompt, target: spec.target }[spec.kind];
    if (body == null || body === '') throw new TypeError(`dispatch(spec): kind=${spec.kind} 需要对应的 ${spec.kind} 字段`);
    if (spec.lock != null && !LOCK_MODES.has(spec.lock)) throw new TypeError("dispatch(spec): spec.lock 必须是 repo|none（ZB-16 起 memory/both 已删除；锁哪些文件用 spec.write）");
    /* ZB-08：write 是可选项（声明 ⇒ 细粒度文件锁；不声明 ⇒ 回退粗粒度）。
     * 只校验"是字符串数组"，不强制非空——空数组按未声明处理（回退，安全）。 */
    if (spec.write != null) {
      if (!Array.isArray(spec.write)) throw new TypeError('dispatch(spec): spec.write 必须是文件路径数组');
      for (const p of spec.write) {
        if (typeof p !== 'string' || !p.trim()) throw new TypeError('dispatch(spec): spec.write 里不能有空路径或非字符串');
      }
    }
    /* ZB-44：引擎专属约束。
     *  · OpenCode **没有** --mode（它自己按 agent/权限模型跑）⇒ mode 非空即报错，绝不静默丢弃用户的意图；
     *  · memoryBench 是 ZCode runner 的旗标（且仅 kind=prompt）⇒ OpenCode 一律拒绝。 */
    if (engine === 'opencode' || engine === 'qoder') {
      /* ZB-51：qoder 与 opencode 在这三点上同构（都**没有** mode / memoryBench；
       * 思考强度走各自的旗标，由执行器校验）。故两者共用同一组约束，只是文案按引擎区分。 */
      const label = engine === 'opencode' ? 'OpenCode' : 'Qoder';
      if (spec.mode != null && String(spec.mode).trim() !== '') {
        throw new TypeError(`dispatch(spec): engine=${engine} 不支持 mode（${label} 无 --mode；如需放开权限用 auto，不要用 mode）`);
      }
      if (spec.memoryBench) throw new TypeError(`dispatch(spec): memoryBench 仅支持 ZCode 引擎（${label} 无 --memory-bench）`);
    } else if (spec.memoryBench && spec.kind !== 'prompt') {
      throw new TypeError('dispatch(spec): memoryBench 仅支持 kind=prompt（runner 限制）');
    }
    /* ZB-45 / ZB-51：`auto` = **显式**放行引擎未显式拒绝的权限（默认关，硬约束「不默认开」）。
     *  · 非布尔值一律拒 —— 否则 `auto: "true"` 会被静默当成"不放行"（静默失真，比报错更糟）；
     *  · 只对 opencode / qoder 有意义（两者都有等价的放行旗标：`--auto` / `--permission-mode`）；
     *    zcode 没有等价的放行旗标 ⇒ 传 true 直接可读报错，绝不静默丢参。 */
    if (spec.auto != null && typeof spec.auto !== 'boolean') {
      throw new TypeError('dispatch(spec): spec.auto 必须是布尔（true = 显式放行引擎未显式拒绝的权限；默认 false）');
    }
    if (spec.auto === true && engine !== 'opencode' && engine !== 'qoder') {
      throw new TypeError('dispatch(spec): auto 仅对 engine=opencode / engine=qoder 有意义（它放行引擎未显式拒绝的权限）；zcode 没有等价的放行旗标，请去掉 auto');
    }
    if (spec.timeoutMin != null && !(Number(spec.timeoutMin) > 0)) throw new TypeError('dispatch(spec): timeoutMin 必须为正数');
    /* ZB-72（2026-10-18 真机实测新增）：`cwd` 的 **Windows 8.3 短名展开**。
     *
     * 现场：用 `C:\Users\ADMINI~1\AppData\Local\Temp\…`（`%TEMP%` 的展开值，`ADMINI~1` 是
     * `Administrator` 的 8.3 短名）作 cwd 派 Qoder 写任务 ⇒ Qoder 的路径安全门直接拒绝：
     *   "This path uses suspicious Windows path syntax that could bypass security checks"
     * 而任务**报 exit=0 / done**（模型写了段解释就结束），文件根本没创建 —— **静默假成功**，
     * 用户完全看不出原因。同一任务换成长路径一次通过（实测 12.7s 写成 hello.txt）。
     *
     * 为什么在 core 做而不是执行器：① cwd 是所有引擎共用的入口参数，修一处全受益；
     * ② `--add-dir <cwd>`（Qoder 的受信任目录声明）用的是**同一个** cwd，短名会让它一起失效；
     * ③ 锁路径、面板显示、日志也都要用能用的路径。
     *
     * 只在 Windows 且路径**确实含 8.3 短名**（形如 `NAME~1`）时才动它，并且**失败绝不抛**
     * （展开是"尽力而为"的加固：路径不存在/权限不足时保持原样，绝不因此拒绝一次派发）。 */
    if (spec.cwd != null && String(spec.cwd).trim() !== '') {
      const r = normalizeCwdPath(String(spec.cwd));
      if (r.changed) spec.cwd = r.path; // spec 是调用方对象（dispatchRaw 里已规整过一份），就地改写即可
      if (r.note) pendingCwdNotes.push(r.note);
    }
    /* ZB-29：思考强度。'agent'（Agent决定，默认）在 core 层就不透传（= 不覆盖，引擎按模型默认档）；
     * 具体档位随模型声明不同（GLM-5 系 disabled|enabled、deepseek-v4 系 disabled|low|high|max，
     * OpenCode 侧叫 variant），core 不写死枚举 —— 执行器按模型声明校验，非法档位 fail-fast（不静默降级）。 */
    if (spec.reasoningLevel != null) {
      if (typeof spec.reasoningLevel !== 'string' || !spec.reasoningLevel.trim()) {
        throw new TypeError('dispatch(spec): reasoningLevel 必须是非空字符串（或 "agent" = Agent决定）');
      }
    }
  }

  /** 原始派发：spec 已是完全确定的形式（retry 内部走这里，保证 --resume 时不被注入 --model）。
   *  ZB-44：入口先做**引擎规整**（显式 engine / opencode 通道 / 通道快照 ⇒ engine+provider+model 三元组），
   *  再按规整后的 spec 校验并建 job —— 这样 job.spec.engine 恒为合法值，pump/startJob 不必再猜。
   *  {raw:true} 返回 jobs 里的真实对象——retry 的簿记必须写在存储态上；默认仍返回 get() 克隆，
   *  防外部调用方改坏内部态。 */
  function dispatchRaw(spec, { raw = false } = {}) {
    /* task-11（F8）：**校验必须发生在引擎规整之前** —— `effEngineSpec()` 会把 `spec.engine`
     * 覆写成 `resolveEngineOf()` 的结果（非法值会被兜成默认引擎 zcode），
     * 于是"显式 engine 必须是合法值"这条校验在规整后就永远不可能命中（非法值被静默接受）。
     * 顺序改成 validate → normalize 后，**一次派发只校验一次**（改前 dispatch 里还有一次前置校验，
     * 那是为了看见原始 engine 才加的重复调用）。 */
    validateSpec(spec);
    /* ZB-72：validateSpec 期间收集的 cwd 短名展开说明（就地改写 spec.cwd 后，把"为什么改了"落进 job）。 */
    const cwdNotes = pendingCwdNotes.splice(0, pendingCwdNotes.length);
    const effSpec = effEngineSpec(spec);
    const id = nextId();
    const job = {
      id,
      tag: effSpec.tag ?? null,
      spec: { ...effSpec },
      engine: normalizeEngine(effSpec.engine), // ZB-44：引擎落库（面板可见；老 jobs.json 无该字段 ⇒ handleLine 补齐）
      lock: null,
      state: 'queued',
      queuedAt: new Date(nowMs()).toISOString(),
      startedAt: null,
      finishedAt: null,
      elapsedSec: null,
      exitCode: null,
      signal: null,
      sessionId: null,
      provider: null,
      endpoint: null,
      model: effSpec.model ?? null,
      reasoningLevel: effSpec.reasoningLevel ?? null, // ZB-29：思考强度请求（'agent'=Agent决定：不覆盖，引擎按模型默认档；具体档位见 channels[].thinkingLevels）
      usage: { requests: null, inputTokens: null, outputTokens: null, cacheReadTokens: null },
      contextUsed: null,
      contextWindow: null,
      responseChars: null,
      outLog: null,
      errLog: null,
      resultFile: null,
      captureOut: null,
      captureErr: null,
      tailLines: [],
      parseWarnings: [...cwdNotes], // ZB-72：cwd 短名展开说明（有则落这里，面板/CLI 可见）
      /* ZB-16/ZB-28：记忆禁令是否已安排注入。
       * ZB-28 起三种 kind 全覆盖：prompt/target 由插件直接拼进内容；
       * task 经 runner `--memory-ban` 由宿主注入（runner 是否确认见 memoryBanRunner 字段）。
       * 不再出现「memoryBanApplied=false = 裸奔」的 task 任务。 */
      memoryBanApplied: true,
      memoryBanRunner: null, // ZB-28：runner 打印 memory-ban=on 后置 true（禁令在 runner 侧确认注入）
      /* ZB-45：本次派发是否**显式放行**了 OpenCode 的权限（`spec.auto === true` ⇒ 执行器带 --auto）。
       * 下发即置位（面板/CLI 立刻能看到"这个任务放行了权限"）；执行器打 `auto=on` 行时再确认一次。 */
      autoApproved: effSpec.auto === true,
      timedOut: false,
      timedOutBy: null, // ZB-28：'runner'（--timeout-min 到点，exit 124 → failed）| 'watchdog'（看门狗 kill → killed）
      pausedAt: null, // ZB-28：进入 paused 的时刻（ISO；非 paused 恒 null）
      watchdogSec: null, // ZB-28：看门狗开火秒数（timeoutMin*60+宽限；未设 timeoutMin 恒 null）
      summarySeen: false,
      ledgerMatched: false,
      // Z6：暂停/交接簿记
      pauseReason: null,
      pauseDetail: null,
      parentJobId: null,
      attempts: [],
      hopCount: 0,
      handedOffTo: null,
      resumedBy: null,
      /* ZB-26（审计 B2/B3）：进程归属 + 版本戳。
       * ownerPid 让 restore() 能区分「自己的残留」与「别进程正在跑的 job」（否则 zcd kill/retry
       * 会先把活 job 在本地内存里改成 interrupted）；updatedAt 让多进程 persist 能按新旧合并。 */
      ownerPid: process.pid,
      updatedAt: nowMs(),
    };
    jobs.set(id, job);
    tails.set(id, []);
    queue.push(id);
    persist();
    emit('job-updated', job);
    emit('queue-changed');
    pump();
    return raw ? job : get(id);
  }

  /** 公共派发入口：未显式指定 provider/model 时采用默认通道（getChannel）。
   *  ZB-29d：未显式指定 reasoningLevel 时按**通道默认思考强度**执行——通道设置就是给派发
   *  Agent 的规定（'agent'=Agent决定：执行器按默认规则解析成实际档；具体档位=硬性规定）。
   *  放在 core 层 ⇒ 工具/CLI/面板三条入口统一生效。
   *  ZB-44：**引擎在补完通道默认值之后才判**（默认通道本身可能就是 opencode 通道），
   *  规整与校验统一在 dispatchRaw 里做（同一段逻辑，不复制）。
   *  task-11（F8）：这里**不再**预先 validateSpec —— 校验只在 dispatchRaw 里做一次，且发生在
   *  引擎规整之前（详见 dispatchRaw 内注释）。补默认值只可能让"有效引擎"更明确（如默认通道是
   *  opencode 通道），那种情况仍会被 dispatchRaw 里的同一次校验拦下。 */
  function dispatch(spec) {
    const effSpec = { ...spec };
    if (effSpec.provider == null && channel.provider) effSpec.provider = channel.provider;
    /* ZB-82：**分流模式** —— 主通道名额将满时，把这次任务改派到降级通道（名额独立）。
     * 必须在"补默认 provider"之后、补默认 model 之前判定：
     *   · 之后 ⇒ 才能知道"调用方有没有显式指定通道"（显式指定则不插手，见 splitDecisionFor）；
     *   · 之前 ⇒ 避免把主通道的默认 model 也带过去（分流目标有自己的 model）。
     * 只改 provider/model/档位三项；锁、cwd、timeoutMin 等**原样保留**（那是任务本身的属性）。 */
    const split = splitDecisionFor(effSpec);
    if (split) {
      effSpec.provider = split.provider;
      if (split.model) effSpec.model = split.model;
      if (split.reasoningLevel) effSpec.reasoningLevel = split.reasoningLevel;
      /* 在 job 上留痕（可见性）：面板/CLI 能看出"这条是被分流过来的"，而不是用户自己选的通道。 */
      effSpec.splitFrom = channel.provider ?? null;
      effSpec.splitReason = split.reason;
    }
    if (effSpec.reasoningLevel == null && channel.reasoningLevel) effSpec.reasoningLevel = channel.reasoningLevel;
    /* F2（机制事实，2026-09-30 现场复现）：`--resume` 带 `--model` 必失败
     * （runner 侧报 `Error: Model creation failed`，exit=1，resultFile 不产出）。
     * 故**续接时绝不注入通道默认 model** —— 与 retry 里的 `delete spec.model`（:1101）同一条纪律。
     * 显式传入的 model 不在此拦截（那是调用方的选择，由 runner 的报错兜底）；这里只保证
     * 「没显式传就不注入」。曾经的缺口：dispatch + resume 会注入通道默认 model → 必然失败。
     *
     * ZB-51（真机验收抓到的 bug）：**指定了别的通道时，绝不注入默认通道的 model**。
     * 现场：用户在面板把默认通道设成 `opencode/<model>`，然后派给 `provider:'qoder/Fast'`
     * —— provider 换成了 qoder，却把默认通道的 opencode 模型塞进 spec ⇒ **provider/model 错配**，
     * Qoder 报 `Model "opencode/…" is not available` 后**静默退回 Auto**（任务照样 done，
     * 用户以为用的是 Fast）。模型永远必须与 provider **同属一个通道**。 */
    const providerChanged = effSpec.provider != null && channel.provider != null
      && String(effSpec.provider) !== String(channel.provider);
    if (effSpec.model == null && channel.model && !effSpec.resume && !providerChanged) {
      effSpec.model = channel.model;
    }
    /* ── ZB-52 第三轮：**顺序派发**（用户要求"只要模型选顺序派发就等于开启模式"）──
     * 判据 = 没有具体模型（`model` 为空）+ 目标引擎配了顺序列表（`sequentialChainForSpec`）。
     * 此时把 spec.model 定位到**列表第一项** —— 否则第一跳会跑引擎默认模型，
     * 而用户看到的面板顺序是"第一项就是我想先试的那个"，两者不一致就是骗人。
     * 播种 `seqRuns` 后，失败时 `advanceSequential` 才知道该往下一项推进。 */
    const seq = effSpec.resume ? null : sequentialChainForSpec(effSpec);
    if (seq) {
      const first = seq.chain[0];
      effSpec.model = first.model;
      if (first.reasoningLevel != null) effSpec.reasoningLevel = first.reasoningLevel;
    }
    const job = dispatchRaw(effSpec);
    if (seq && job) seedSequentialRun(job.id, seq);
    return job;
  }

  /**
   * 结构化交接提示词（五要素）：
   * ① 原任务（task 文件内容或 prompt/target 原文）② 上次中断点（pauseReason/pauseDetail + tail 尾部）
   * ③ 新通道说明（交接重跑≠原会话续跑）④ 硬约束（先核对现状/只做剩余/按原要求交付）⑤ 禁止（不回滚/不重复交付）。
   */
  function buildHandoffPrompt(job, target = {}) {
    const spec = job.spec ?? {};
    const provider = target.provider ?? spec.provider ?? 'plan';
    const model = target.model ?? spec.model ?? '(通道默认模型)';
    let taskBlock;
    let taskSource;
    if (spec.kind === 'task' && spec.task) {
      const p = resolve(String(spec.task));
      taskSource = `原任务来源：任务包文件 ${p}`;
      try {
        taskBlock = readFileSync(p, 'utf8');
      } catch (e) {
        taskBlock = `（原任务文件读取失败：${e?.message ?? e}；请向派发方索要原任务包）`;
      }
    } else if (spec.kind === 'target') {
      taskSource = '原任务来源：target 目标';
      taskBlock = String(spec.target ?? '');
    } else {
      taskSource = '原任务来源：原 prompt';
      taskBlock = String(spec.prompt ?? '');
    }
    const tail = (tails.get(job.id) ?? job.tailLines ?? []).slice(-20);
    const tailBlock = tail.length ? tail.map((l) => `  ${l}`).join('\n') : '  （无捕获输出）';
    return [
      '【交接重跑提示词】上一轮任务因故中断，现在换通道继续执行。请严格按以下五部分处理。',
      '',
      '一、原任务',
      taskSource,
      '----- 原任务开始 -----',
      taskBlock,
      '----- 原任务结束 -----',
      '',
      '二、上次中断点',
      `- pauseReason: ${job.pauseReason ?? '(未记录)'}`,
      `- pauseDetail: ${job.pauseDetail ?? '(无)'}`,
      '- 最后输出（tailLines 尾部，最多 20 行）：',
      tailBlock,
      '',
      '三、新通道说明',
      `你现在运行在 ${provider}/${model} 通道上；这是交接重跑，不是原会话续跑（不要尝试 --resume 原会话${job.sessionId ? ` ${job.sessionId}` : ''}，它会留在旧通道上）。`,
      '',
      '四、硬约束（按顺序执行）',
      '1. 先核对仓库/工作区当前状态（git status、已存在的交付物），已完成的部分不要重做。',
      '2. 只做剩余部分。',
      '3. 完成后按原任务包要求交付（交付文档路径与最终回复格式照旧）。',
      '',
      '五、禁止',
      '- 不要回滚已完成改动。',
      '- 不要重复已完成交付。',
    ].join('\n');
  }

  /**
   * 续跑/交接。目标通道 == 原通道且有 sessionId → 同会话续跑（--resume，绝不带 --model，机制事实 F2）；
   * 换通道或无 sessionId → 交接重跑（新会话 + buildHandoffPrompt），新 job 记 parentJobId/attempts/hopCount，
   * 旧 job 标 handedOffTo（同通道续跑标 resumedBy）。
   *
   * ZB-44：目标**引擎**判据 = `opts.engine`（显式，wire/CLI 透传）> 目标 provider 推断（换通道时）
   * > 原 spec.engine（仅同通道时）。**引擎变了绝不 resume**（跨引擎 session 不通用，resume 必错）⇒ 退化成交接重跑。
   * ZB-45：`auto`（显式放行 OpenCode 权限）**跨 retry 沿用**原任务的放行级别，`opts.auto` 可显式覆盖；
   * auto 只对 opencode 有意义，故交接目标不是 opencode 时**不带**（否则 validateSpec 会直接拒掉整个 retry）。
   * @returns 新 job（get() 序列化形状；簿记已写在存储态，d.get()/d.list()/jobs.json 均可读回）
   */
  function retry(jobId, opts = {}) {
    const job = jobs.get(jobId);
    if (!job) throw new Error(`retry: 找不到 job：${jobId}`);
    if (job.state === 'queued' || job.state === 'running') {
      throw new Error(`retry: job ${jobId} 仍在 ${job.state}，等它落到 paused/终态再续`);
    }
    const targetProvider = opts.provider != null && opts.provider !== '' ? String(opts.provider) : null;
    const targetModel = opts.model != null && opts.model !== '' ? String(opts.model) : null;
    /* ZB-30：降级目标可指定思考强度（面板设置）。null/'' = 沿用原任务档位（下面的 spec 展开）。
     * 'agent' 是**显式**值 ⇒ 照传（runner 按 ZCode 默认规则解析成实际档）。 */
    const targetReasoning = opts.reasoningLevel == null || opts.reasoningLevel === ''
      ? null
      : String(opts.reasoningLevel);
    const origProvider = job.spec.provider ?? 'plan'; // runner 缺省即 plan
    const sameChannel = targetProvider == null || targetProvider === origProvider;
    /* ZB-44：目标引擎（见函数头注释的判据顺序）。显式 opts.engine 只认合法值（非法值静默忽略 = 沿用推断，
     * 因为这是"重试目标"而非用户主派发入口，报错会打断降级链；主入口 dispatch 的校验仍是严格报错的）。 */
    const explicitEngine = typeof opts.engine === 'string' && ENGINES.includes(opts.engine.trim().toLowerCase())
      ? opts.engine.trim().toLowerCase()
      : null;
    const origEngine = normalizeEngine(job.spec.engine);
    const targetEngine = explicitEngine
      ?? (sameChannel ? origEngine : resolveEngineOf({ provider: targetProvider, ...(targetModel ? { model: targetModel } : {}) }));
    const engineChanged = targetEngine !== origEngine;
    /* ZB-45：放行级别沿用（opts.auto 显式优先）；只对 opencode 有意义。 */
    const autoRequested = opts.auto != null ? opts.auto === true : job.spec.auto === true;
    const at = new Date(nowMs()).toISOString();
    const prevAttempts = Array.isArray(job.attempts) ? job.attempts : [];
    const reason = opts.autoFallback
      ? `auto-fallback:${job.pauseReason ?? 'paused'}`
      : job.pauseReason && job.pauseReason !== 'unknown'
        ? job.pauseReason
        : `manual-retry:${job.state}`;

    /* 同通道 + 有 sessionId + **引擎没变** ⇒ 同会话续跑（`{...job.spec}` 天然带上 auto）。
     *
     * ⚠️ ZB-71 真机 bug（2026-10-18 实测抓到，症状极隐蔽）：**换模型的意图必须走"交接重跑"**。
     * 原判据只看了"通道相同 + 引擎没变"，于是**顺序派发换模型**（同引擎、同 provider，只换 model）
     * 也落进这个分支 ⇒ 下面 `delete spec.model`（`--resume` 带 `--model` 必失败）把目标模型**丢掉**，
     * 新 job 实际仍在跑**旧模型**。
     * 实测现场：opencode 顺序列表 10 个模型，一个写任务因 403（FreeTierError，不可重试）失败后
     * 连跳 9 次，**10 次尝试的 result.json 里 model 全是 `opencode/deepseek-v4.1-flash-free`**
     * —— 等于把同一个不可重试的错误撞了 10 遍，顺序派发完全失效。
     * 判据修正：`targetModel != null && targetModel !== job.spec.model` ⇒ **不算同会话续跑**。 */
    const modelChanged = targetModel != null && targetModel !== (job.spec.model ?? null);
    if (sameChannel && !engineChanged && !modelChanged && job.sessionId) {
      const spec = { ...job.spec, resume: job.sessionId };
      /* ZB-45：`opts.auto` 显式优先 —— false 表示"这次明确不放行"，true 表示"这次放行"
       * （沿用 job.spec 是缺省行为，只有调用方显式给了 opts.auto 才覆盖）。 */
      if (opts.auto != null) {
        if (opts.auto === true) spec.auto = true;
        else delete spec.auto;
      }
      delete spec.model; // F2：--resume 时传 --model 必失败
      if (job.tag) spec.tag = `${job.tag}-r${prevAttempts.length + 1}`;
      const nj = dispatchRaw(spec, { raw: true }); // 簿记必须写在存储态真实对象上（get() 返回克隆，写它会丢）
      nj.parentJobId = job.id;
      nj.attempts = [
        ...prevAttempts,
        { jobId: job.id, provider: origProvider, model: job.spec.model ?? null, reason, at },
        { jobId: nj.id, provider: origProvider, model: null, reason: 'resume-same-channel', at },
      ];
      job.resumedBy = nj.id;
      persist();
      emit('job-updated', job);
      emit('job-updated', nj);
      return get(nj.id);
    }

    // 交接重跑：换通道、换模型（顺序派发）、或原通道无 sessionId 可续
    const prompt = buildHandoffPrompt(job, { provider: targetProvider ?? origProvider, model: targetModel });
    const spec = {
      kind: 'prompt',
      prompt,
      provider: targetProvider ?? origProvider,
      /* ZB-44：目标**引擎**在这里落定 —— opts.engine > 目标 provider 推断 > 原引擎（仅同通道）。
       * 必须显式写：OpenCode 的 spec.provider 已被规整成裸 'opencode'（不再含 `opencode/<model>`），
       * 单靠 provider 判不出引擎；而"换引擎 ＝ 新会话"正是跨引擎降级的落点。 */
      engine: targetEngine,
      ...(targetModel ? { model: targetModel } : {}),
      /* ZB-45 / ZB-51：`auto`（显式放行权限）**跨 retry 沿用**原任务的放行级别，opts.auto 显式优先；
       * 只对 opencode / qoder 有意义 ⇒ 目标引擎两者都不是时不带（否则 validateSpec 会拒掉整个 retry）。 */
      ...((targetEngine === 'opencode' || targetEngine === 'qoder') && autoRequested ? { auto: true } : {}),
      ...(job.spec.mode ? { mode: job.spec.mode } : {}),
      ...(job.spec.lock ? { lock: job.spec.lock } : {}),
      /* ⚠️ cwd 必须逐字沿用：OpenCode 的 session **按工作目录作用域**（同一 sessionId 换 --dir 续跑必挂，
       * 实测 45s 被强杀）。交接重跑是新会话，但工作目录仍应保持原任务的目标仓库，否则"接着干"会跑到别处。 */
      ...(job.spec.cwd ? { cwd: job.spec.cwd } : {}),
      ...(job.spec.timeoutMin != null ? { timeoutMin: job.spec.timeoutMin } : {}),
      /* ZB-29：交接重跑是新会话，沿用原任务的思考强度档位（'agent' 照传 = 继续不覆盖）。
       * ZB-30：降级目标显式带了档位 ⇒ 用它（面板设置的硬性规定）；未带 ⇒ 沿用原任务。 */
      ...((targetReasoning ?? job.spec.reasoningLevel) ? { reasoningLevel: targetReasoning ?? job.spec.reasoningLevel } : {}),
      ...(job.tag ? { tag: `${job.tag}-h${prevAttempts.length + 1}` } : {}),
    };
    /* 换通道到不支持 mode 的引擎（opencode / qoder）时，原任务带的 mode 必须丢掉（ZCode 支持）。 */
    if (targetEngine === 'opencode' || targetEngine === 'qoder') delete spec.mode;
    const nj = dispatchRaw(spec, { raw: true }); // 簿记必须写在存储态真实对象上（get() 返回克隆，写它会丢）
    nj.parentJobId = job.id;
    nj.hopCount = Number(job.hopCount ?? 0) + 1;
    /* 交接把显式放行降级掉了（原任务是 opencode+auto，目标引擎不是 opencode）⇒ 留痕，别静默。 */
    if (autoRequested && targetEngine !== 'opencode') {
      nj.parseWarnings.push('retry: 原任务为 OpenCode 显式放行（auto=true），但本次交接的目标引擎不是 opencode ⇒ 未放行（auto 只对 opencode 有意义）');
    }
    nj.attempts = [
      ...prevAttempts,
      /* ⚠️ **只有"目标记录"带 `hopReason`**（它描述"要跳到哪"）；源记录只带 `reason`（描述"为什么跳"）。
       * 两条都打 hopReason 会让 `countFallbackHops` 把**一次交接算成两跳** ⇒
       * 降级封顶实际只允许 ceil(L/2) 跳（实测 L=2 时只降 1 次就报"已达目标数上限"，第三个目标永不尝试）
       * —— 这是队友报出来、我读代码确认的真 bug。 */
      { jobId: job.id, provider: origProvider, model: job.spec.model ?? null, reason, at },
      /* `hopReason` 用于**区分交接来源**：`seq-model` = 顺序派发换模型；`auto-fallback` = 跨通道降级链。
       * 两者都走这条 retry 通道，但**各有独立的跳数预算** —— 不区分的话降级链的封顶会被顺序跳数吃掉。 */
      { jobId: nj.id, provider: spec.provider, model: targetModel ?? null, reason: 'handoff-retry', hopReason: opts.hopReason ?? null, at },
    ];
    job.handedOffTo = nj.id;
    persist();
    emit('job-updated', job);
    emit('job-updated', nj);
    return get(nj.id);
  }

  function list() {
    /* 排序契约（tool 描述与 README 都这么写）：**running → queued → paused → 终态**，同秩内按 queuedAt 倒序。
     * ⚠️ 早前是 `order[state] ?? 2` —— 于是 paused 与终态**同秩**，只要存在更新的已完成 job，
     * paused 就会被排到它下面（与注释/文档相反；2026-10-17 审计 P3）。现在终态显式降到 3。 */
    const order = { running: 0, queued: 1, paused: 2 };
    const rank = (state) => order[state] ?? 3;
    return [...jobs.values()]
      .sort((a, b) => rank(a.state) - rank(b.state) || String(b.queuedAt).localeCompare(String(a.queuedAt)))
      .map(serialize);
  }

  function get(id) {
    const job = jobs.get(id);
    return job ? serialize(job) : null;
  }

  /**
   * 优先读 runner 的 outLog，其次本进程捕获文件，最后内存 tailLines。
   *
   * ZB-26（审计 B4，安全）：**读取路径也必须做越界校验**（原先只有删除路径做了）。
   *   · `captureOut` 只允许落在 `dirLogs` —— 它是本进程在 `workRoot/logs` 下建的；
   *   · `outLog` 允许落在 `dirLogs` / `workRoot` / `runnerCwd` —— 真实 runner 把 out 日志写在
   *     项目根下（`<项目>/collab/logs/…`），而 runnerCwd 来自 config（可信），不是 jobs.json。
   * 越界的候选**跳过并留痕**（不静默），最终回落到内存 tailLines —— 与既有降级链一致。
   */
  function tail(id, n = 50) {
    const job = jobs.get(id);
    if (!job) return null;
    const count = Math.max(1, Number(n) || 50);
    const candidates = [
      { f: job.outLog, roots: allowedLogRoots, why: 'outLog' },
      { f: job.captureOut, roots: [dirLogs], why: 'captureOut' },
    ];
    for (const { f, roots, why } of candidates) {
      if (typeof f !== 'string' || f === '') continue;
      if (!roots.some((r) => isUnder(r, f))) {
        const note = `tail: 忽略越界的 ${why} 路径（不在允许的日志根内）：${String(f).slice(0, 160)}`;
        if (!Array.isArray(job.parseWarnings)) job.parseWarnings = [];
        if (!job.parseWarnings.includes(note) && job.parseWarnings.length < 20) job.parseWarnings.push(note);
        continue;
      }
      if (existsSync(f)) {
        try {
          const lines = readFileSync(f, 'utf8').split('\n');
          if (lines.length && lines[lines.length - 1] === '') lines.pop();
          return lines.slice(-count);
        } catch { /* 换下一个来源 */ }
      }
    }
    return (tails.get(id) ?? []).slice(-count);
  }

  function kill(id, reason = 'kill() called') {
    const job = jobs.get(id);
    if (!job || isTerminal(job)) return false;
    if (job.state === 'queued') {
      queue = queue.filter((q) => q !== id);
      job.state = 'killed';
      job.parseWarnings.push(reason);
      job.finishedAt = new Date(nowMs()).toISOString();
      persist();
      emit('job-updated', job);
      emit('queue-changed');
      return true;
    }
    killRequested.add(id);
    job.parseWarnings.push(reason);
    const child = children.get(id);
    if (child) {
      try {
        child.kill();
      } catch (e) {
        job.parseWarnings.push(`kill-failed: ${e.message}`);
        return false;
      }
    }
    emit('job-updated', job);
    return true;
  }

  function snapshot() {
    const counts = {};
    for (const j of jobs.values()) counts[j.state] = (counts[j.state] ?? 0) + 1;
    return {
      generatedAt: new Date(nowMs()).toISOString(),
      workRoot,
      maxConcurrent,
      /* ZB-44：OpenCode 独立并发上限 + 每引擎运行数（既有字段保留，只增补）。 */
      maxConcurrentOpenCode,
      runningByEngine: { zcode: runningCountByEngine('zcode'), opencode: runningCountByEngine('opencode') },
      counts,
      locks: {
        repo: existsSync(repoLockPath) ? readLockFile(repoLockPath) : null,
      },
      /* ZB-16：文件锁列表（UI「文件锁 / 记忆锁」分区展示它：哪个文件被哪个进程锁着）。
       * memory 锁已删除，故 locks 里不再有 memory 字段。 */
      fileLocks: listFileLocks(),
      queue: [...queue],
      jobs: list(),
    };
  }

  // 启动：清过期锁（含文件锁表 + 历史遗留的 memory.lock）→ 恢复状态 → 读通道/引擎快照/降级链
  sweepStaleLocks([repoLockPath, legacyMemoryLockPath], nowMs);
  sweepFileLocks();
  restore();
  loadChannelState();
  loadEngineMap(); // ZB-44：通道→引擎快照（fail-open：读不到 ⇒ 全部按默认引擎 zcode）
  loadFallbackState();
  loadSplitState(); // ZB-82：分流模式（fail-open：读不到 ⇒ 默认关 = 既有行为不变）
  loadSequentialState(); // ZB-52：顺序派发配置（fail-open：读不到 ⇒ 默认关）
  loadModelSwitches(); // ZB-58：逐模型开关（fail-open：读不到 ⇒ 一个都不禁用 = 全部可用）
  loadEffortDiskCache(); // ZB-57：档位探测结果的磁盘缓存（解决"每次重启都要等 2 分钟"；fail-open）

  return {
    workRoot,
    jobsFile,
    statePath, // task-11（M2）：状态目录内文件名的**唯一**取名入口（wire/notify 不许自己 dirname(jobsFile)）
    lockPaths: { repo: repoLockPath }, // ZB-16：memory 已删除
    fileLockDir: join(dirLocks, FILE_LOCK_DIR), // ZB-08
    dispatch,
    list,
    get,
    tail,
    kill,
    snapshot,
    subscribe,
    restore,
    listFileLocks, // ZB-08：文件锁表（UI「单写者」分区改为展示它）
    lockBlockersFor, // ZB-08：某 spec 此刻被什么挡住（「为什么在排队」）
    // Z6：通道 / 续跑 / 降级链
    getChannel,
    setChannel,
    listChannels,
    retry,
    buildHandoffPrompt,
    setFallbackChain,
    setFallbackTarget, // ZB-30：面板入口（单目标：通道+模型+思考强度；null=关闭）
    getFallbackChain,
    /* ZB-82：分流模式（用户要求）—— 主通道名额将满时自动改派到降级通道，用两条通道拿更大并发 */
    getSplitMode,
    setSplitMode,
    /* ZB-52：顺序派发（面板入口 = 开关 + 每引擎一份模型顺序；顺序即派发次序） */
    getSequential,
    setSequential,
    /* ZB-58：**逐模型开关**（用户要求：关掉的模型不出现在面板选项里、也不参与顺序派发） */
    getModelSwitches,
    setModelSwitch,
    /* ZB-44：引擎自检/展示用（只读；不参与调度决策）。面板与 CLI 想知道「OpenCode 执行器配到哪了」
     * 时不必再各自推断路径 —— 与 startJob 实际 spawn 的是**同一个值**。 */
    engines: [...ENGINES],
    engineLimits: { zcode: maxConcurrent, opencode: maxConcurrentOpenCode, qoder: maxConcurrentQoder },
    opencodeRunnerPath,
  };
}

export const __testables = {
  parseRunnerLine,
  isStaleLock,
  acquireLockFile,
  releaseLockFile,
  atomicWrite,
  LOCK_STALE_MS,
  classifyPause,
  parseProviderTable,
  PAUSE_SIGNATURES,
  AUTO_FALLBACK_REASONS,
  NO_SEQUENTIAL_REASONS,
};
