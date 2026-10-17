/**
 * dispatch —— Host 半边接线适配器（Z8 全接线版）。
 *
 * 职责：把 dispatcher 的状态以「Remote 面」暴露给客户端，并保留进程内动作入口。
 * 动作实现全包只有一份（createActionHandler），agent 工具 `dispatch`
 * （index.js）与 Remote 面共用它，对应 references/user-actions.md 的「一个操作两个调用方」。
 *
 * ── Remote 形态（Z8 静态证据驱动，证据见 tasks/Z8-delivery.md）──────────────
 * 宿主侧「最后一跳」按官方 typert 三件套的两条并存路径落地：
 *
 * A) typert-loader 自动发现（strict 注册表路径）：
 *    dsh-base 组合挂载 typert / typert-loader / typert-gateway 三服务
 *    （refs/extracted/dsh-base/cordis.patch.yml:46-53）。loader 对每个 Loader entry
 *    读包的 exports["./typert"]（本包= ./wire.host.mjs，loader/lib/index.js:39-40），
 *    import 后取 TYPERT 校验并 ctx.typert.register(manifest)
 *    （loader/lib/index.js:69-117,315 附近）。因此本文件的 TYPERT 必须全字段过验：
 *    每个 codec 都要 {mode:'strict', typeSymbol, create}（loader/lib/index.js:206-211）。
 *
 * B) typertGateway 的 SRC 接收器路径（manifest 缺席/未注册时的兜底）：
 *    网关遍历 ctx.reflect.props 找「带 typertRemote 绑定 + 原型方法标记」的 cordis
 *    服务来认领并派发 <namespace>/<method> 端点（extracted/dsh-api-gateway/lib/index.js
 *    :702-716 collectSrcClaims、:1008-1075 resolveSrcDescriptor、:1451-1464 绑定校验、
 *    :1465-1495 方法源码参数必须是唯一简单标识符）。协议包明确「已有其他基类时仍可
 *    改用 bindTypertRemote()」（api-gateway README §Host 服务）；本文件按
 *    protocol/lib/index.js 的 bindTypertRemote(:146-157) 与 mark(:248-268) 的落盘形状
 *    手写同一结构，不 import 协议包（绑定={service,serviceKey,namespace} 冻结对象；
 *    标记键为字符串常量 REMOTE_METHOD_DESCRIPTOR，协议 README 声明该键跨副本稳定）。
 *    注册动作 = ctx.provide(FACE_NAME, face)（cordis reflect.provide，登记即被
 *    ctx.effect 所在 fiber 持有，卸载自动撤销；attachHostWire 的 dispose 兜底再调一次）。
 *
 * 派发终点两路一致：网关 ctx.get('dispatch') 取 face 实例 → 调公开方法
 * （gateway lib/index.js:986-988）。客户端半边见 wire.client.mjs 与 client.js（内联
 * 传输层 + ctx.remote.$mount 自挂 remote.dispatch 子服务）。
 * 探测不到远端面时客户端逐级回退：外部数据源 → 诚实空态（offline；内置 demo 引擎仅在
 * window.__dispatchDemo === 'builtin' 时启用），绝不白屏。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/* ZB-25：终态/落地集合**只从 core 取**（core 是状态机的所有者）。原先本文件与 notify.mjs
 * 各自字面量复制一份同样的集合，已构成重复定义。 */
import { SETTLED_STATES, TERMINAL_STATES } from './core/dispatch-core.mjs';
import { aggregate, fetchPlanQuota, recentRateLimited } from './core/quota.mjs';
import { GIFT_CHANNEL_RE, formatGiftQuota, readGiftQuota } from './core/gift-quota.mjs';

/* ─────────────── Z12：派发总开关（跨进程唯一真值，契约：宿主仓库 collab/PROTOCOL.md §7）───────────────
 * 语义：enabled:false = 拒绝对 ZCode 的任何派发；文件缺失/损坏 = 开启（不误锁，与 CLI 同）。
 * 读写全包只允许这一处实现：readSwitch（mtime 缓存，永不抛）/ writeSwitch（tmp+rename 原子写，
 * 键序/缩进/换行与 collab-kit/dispatch-switch.mjs 的 writeDispatchSwitch 逐字段一致——
 * 文件即契约，出现第二个写文件方 = 格式漂移）。UI 与 agent 工具经 createActionHandler 的
 * switch 动作共用它；config.switchPath 指向真值文件，缺省为空 = 本机未接入宿主仓库。 */

/* 真值文件路径**刻意不设硬编码兜底**：这是机器专有路径（指向宿主项目），属于部署配置，
 * 应由 profile patch 的 config.switchPath 提供。为空时 readSwitch 视作「无文件 = 开启」（不误锁），
 * writeSwitch 则明确报错而不是写到一个猜出来的位置。 */
export const DEFAULT_SWITCH_PATH = '';
/** 协议标记行（跨写方逐字节一致；勿改文案——CLI 与本处共用同一字符串才是同一契约）。 */
export const SWITCH_CONTRACT = 'collab/PROTOCOL.md §派发总开关；false = 任何会话都不得把任务派发给 ZCode';
/** dispatch/retry 被拒时的统一错误文案（任务包规定）。 */
export const SWITCH_OFF_ERROR = '派发总开关已关闭（collab/dispatch.switch.json）';

/* ─────────────── 动作清单：单一源（ZB-25）───────────────
 * 动作的**唯一实现**是下面的 createActionHandler switch，所以清单也归本文件维护：
 *   · index.js 的工具 schema `action.enum` 直接 import 它；
 *   · 「未知 action」报错串由它 join 生成（原先手抄一份，ZB-08 加 wait 时漏改 ⇒ 模型
 *     收到的"可用动作"里没有 wait，正好掐掉"派发后等结果"这条正路 —— 已实际漂移过）；
 *   · 新增动作只改这里一处 + 写一个 case。 */
export const ACTIONS = ['dispatch', 'list', 'kill', 'dismiss', 'tail', 'quota', 'status', 'switch', 'channels', 'channel', 'retry', 'fallback', 'wait'];

const switchCache = new Map(); // 真值文件路径 → { mtimeMs, value }（同 mtime 不重复读盘）

/** config.switchPath → 实际真值文件（空/非串回退契约默认值）。 */
export function switchFileOf(config) {
  const p = config && config.switchPath;
  return typeof p === 'string' && p ? p : DEFAULT_SWITCH_PATH;
}

/** 读开关（永不抛）。缺文件 → enabled:true + source:'default(无文件=开启)'；损坏 → source:'default(读取失败)'。 */
export function readSwitch(path = DEFAULT_SWITCH_PATH) {
  try {
    if (!existsSync(path)) return { enabled: true, updatedAt: null, updatedBy: null, note: null, source: 'default(无文件=开启)' };
    const mtimeMs = statSync(path).mtimeMs;
    const hit = switchCache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value;
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const value = {
      enabled: raw.enabled !== false,
      updatedAt: raw.updatedAt ?? null,
      updatedBy: raw.updatedBy ?? null,
      note: raw.note ?? null,
      source: 'file',
    };
    switchCache.set(path, { mtimeMs, value });
    return value;
  } catch {
    return { enabled: true, updatedAt: null, updatedBy: null, note: null, source: 'default(读取失败)' };
  }
}

/** 写开关（唯一写入口；原子替换 tmp+rename，格式与 CLI writeDispatchSwitch 一致）。失败抛错，动作层折成 {ok:false,error}。 */
export function writeSwitch(enabled, { by = 'ui/tool', note = '' } = {}, path = DEFAULT_SWITCH_PATH) {
  if (typeof path !== 'string' || !path) {
    throw new Error('未配置派发总开关真值文件路径（config.switchPath）：无法写入开关。请在 profile patch 里指定宿主仓库的 collab/dispatch.switch.json');
  }
  mkdirSync(dirname(path), { recursive: true });
  const body = {
    enabled: !!enabled,
    updatedAt: new Date().toISOString(),
    updatedBy: by,
    note,
    contract: SWITCH_CONTRACT,
  };
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  switchCache.delete(path); // 本进程写的立即失效缓存（外部写靠 mtime 变化自动失效）
}

/** UI / 工具 tail 的默认行数（任务包规定 30），上限受 dispatcher TAIL_CAP 约束。 */
export const TAIL_DEFAULT_LINES = 30;
/** Host→客户端推送节流：dispatcher 每解析一行都可能 emit，这里限频。 */
const PUSH_THROTTLE_MS = 300;
/** Remote 面服务名（官方惯例为小驼峰，如 pluginRegistryProbe / pluginManager）。 */
export const FACE_NAME = 'dispatch';
/** 宿主→客户端变更事件名（官方命名惯例："<区域>/<事件>"，如 plugin-manager/changed）。 */
export const EVENT_NAME = 'dispatch/changed';
/**
 * 协议包 Remote 方法标记的原型属性键（protocol/lib/index.js:135 的字符串常量，
 * 协议 README 声明其跨安装副本稳定；此处按值手写以免 import 协议包）。
 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';
/** snapshot() 里 channels 的缓存时长（任务包规定 5s）：通道清单靠 runner 子进程探测，昂贵。 */
const CHANNELS_TTL_MS = 5000;
/** **失败结果**的缓存时长（真机事故）：探测失败时若也缓存满 5s，宿主刚启动那几秒里
 * 客户端拿到的就是"空清单"，而面板的通道分区只在挂载时拉一次 ⇒ 一次失败可能永久残废。
 * 失败只缓存 1s ⇒ 下一次快照轮询（1s 一次）就会重试，面板能自愈。 */
const CHANNELS_ERROR_TTL_MS = 1000;

const trunc = (s, n = 200) => {
  const str = s == null ? '' : String(s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
};

/* ─────────────── Z11：dismissed（paused/终态 job 的「关闭」= 从列表移除）───────────────
 * 依据（core 语义不动，只允许 wire 层加动作）：dispatch-core.mjs 的 kill(id) 对 paused
 * 是空操作——子进程退出时 children 表已删、close 处理器已跑完，kill 走到默认分支只会
 * killRequested.add + emit，返回 true 但状态永停 paused（且 killRequested 条目残留）。
 * dispatcher 也没有删除 API，故 dismiss 在 wire 层实现：维护 dismissed 集合并持久化到
 * state 目录（与 jobs.json 同目录的 dismissed.json），snapshot/list 输出时过滤；
 * queued/running 不允许 dismiss（占锁与并发，必须先 kill）。
 * ZB-25：可 dismiss 的集合 === 「落地」判据（终态 + paused），**引用 core 的唯一源**，
 * 不再就地字面量复制（原先 notify.mjs 里那份与它逐元素相同，属重复定义）。 */
export const DISMISSABLE = SETTLED_STATES;
const dismissedByFile = new Map(); // dismissed.json 绝对路径 → Set<jobId>（多个 createActionHandler 实例按路径共享同一集合）
/* task-11（M2）：状态文件路径**问 core 要**（`dispatcher.statePath`），不再自己 `dirname(jobsFile)` 反推。
 * 保留 dirname 兜底只为**测试桩/旧 core**（没有 statePath 的假 dispatcher，如 list-compact 的桩）。 */
const dismissedFileOf = (dispatcher) => (typeof dispatcher.statePath === 'function'
  ? dispatcher.statePath('dismissed.json')
  : join(dirname(dispatcher.jobsFile), 'dismissed.json'));
function dismissedSet(dispatcher) {
  const file = dismissedFileOf(dispatcher);
  let set = dismissedByFile.get(file);
  if (!set) {
    set = new Set();
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) for (const id of raw) if (id != null) set.add(String(id));
    } catch { /* 无文件/损坏：按空集合起步（与 jobs.json 读取失败不阻断同思路） */ }
    dismissedByFile.set(file, set);
  }
  return set;
}
function persistDismissed(dispatcher, set) {
  try {
    const file = dismissedFileOf(dispatcher);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...set], null, 1));
    renameSync(tmp, file); // 原子替换（与 core atomicWrite 同思路）
  } catch { /* 落盘失败不致命：本进程内存态已生效，下次 dismiss 重试 */ }
}
/** 过滤已 dismiss 的 job；任何异常都放行原列表（过滤永远不比展示更优先）。 */
function withoutDismissed(dispatcher) {
  try {
    const set = dismissedSet(dispatcher);
    return (j) => !set.has(j.id);
  } catch {
    return () => true;
  }
}

/**
 * 裁剪 job：UI 与工具结果只带展示字段；tailLines 只回条数（tail 动作按需取），
 * captureOut/captureErr（本进程捕获文件路径）不出网，parseWarnings 只留末 5 条。
 * Z11：spec.body（= prompt/task/target 原文）截断 200→2000（UI 展开区要展示派发内容，
 * UI 侧再截 1200 展示）；spec 补 cwd（详情区展示派发工作目录）。spec 本就不含 capture
 * 路径（captureOut/captureErr 在 job 层已剥离），「capture 不出网」纪律不变。
 */
export function slimJob(job) {
  if (!job) return null;
  const { tailLines, captureOut, captureErr, parseWarnings, spec, usage, ...rest } = job;
  const bodyField = spec?.kind === 'task' ? 'task' : spec?.kind === 'target' ? 'target' : 'prompt';
  return {
    ...rest,
    spec: {
      kind: spec?.kind ?? null,
      body: trunc(spec?.[bodyField], 2000),
      model: spec?.model ?? null,
      provider: spec?.provider ?? null,
      /* 双引擎：`engine`/`auto` 也放进 slim spec —— 面板的引擎徽标与「已放行权限」徽标
       * 直接读 `job.engine`/`job.autoApproved`（走 ...rest 已保留），但工具/CLI 侧读的是 slim spec；
       * 两者都给，避免"同一个事实在两条通道上一条有、一条没有"。 */
      engine: spec?.engine ?? null,
      auto: Boolean(spec?.auto),
      mode: spec?.mode ?? null,
      cwd: spec?.cwd ?? null,
      /* ZB-16 修正（ZB-17 补漏）：默认由 'both' 改为 'repo' —— 上一轮删 memory 时漏改了这里，
       * 导致未显式传 lock 的 job 在快照里仍显示 'both'（与实际生效的 repo 锁不符）。 */
      lock: spec?.lock ?? 'repo',
      timeoutMin: spec?.timeoutMin ?? null,
      /* ZB-29：思考强度（'agent'=Agent决定；null=未指定，等价 agent 语义）。 */
      reasoningLevel: spec?.reasoningLevel ?? null,
      memoryBench: Boolean(spec?.memoryBench),
      tag: spec?.tag ?? null,
      /* ZB-08：声明的写入集（细粒度文件锁）。null/[] = 未声明 ⇒ 锁整个仓库。 */
      write: Array.isArray(spec?.write) ? spec.write.filter((x) => typeof x === 'string' && x.trim()) : [],
    },
    usage: { ...(usage ?? {}) },
    /* ZB-40（用户要求：「能看出派发的进程确实在工作还是可能卡住」）——
     * `progress` 来自 runner 每 10s 的心跳行；`stalledSec` = 距上次心跳的秒数，
     * `stalled` = running 且超过 150s 没有任何心跳/输出（面板据此显示「可能卡住」徽标）。 */
    progress: job.progress ?? null,
    lastProgressAgoSec: Number.isFinite(job.lastProgressAt) ? Math.round((Date.now() - job.lastProgressAt) / 1000) : null,
    stalledSec: job.lastProgressAt ? Math.round((Date.now() - job.lastProgressAt) / 1000) : null,
    stalled: job.state === 'running' && (!job.lastProgressAt || Date.now() - job.lastProgressAt > 150_000),
    tailCount: Array.isArray(tailLines) ? tailLines.length : 0,
    parseWarnings: (parseWarnings ?? []).slice(-5),
  };
}

/* ── ZB-61（上下文成本）：`list` 的**紧凑投影** ──────────────────────────────
 * 真机实测（2026-10-17，本机 96 条历史 job）：`action=list` 走 slimJob 的载荷是
 * **212 KB**，而宿主 `@deepseek-ai/dsh-spill-policy` 会把超预算的工具结果**从中间截断**，
 * 只把首尾两段 + 「Omitted N bytes」提示交给模型（完整文本落到 spill 文件）——
 * 也就是说：列表越长，模型反而**越读不到中间的 job**（越需要列表时越瞎）。
 * 紧凑投影只保留「挑下一个动作」必需的事实：实测同一份数据 **22.0 KB**（含缩进渲染 ≈5.6K token，
 * 宿主预算是 12500），且**永不省略 id/state**，所以模型拿到的一定是可用信息。
 *
 * 取舍（写下来免得后人再猜）：
 *   · 去掉 `spec.body`（派发原文，最长 2000 字/条 —— 列表里没人靠它选动作，要看用 action=tail）；
 *   · 去掉 `lockPaths` / `progress` 全量 / `parseWarnings` / `usage` / 附件类字段；
 *   · **保留 `lockWait`**（ZB-28 排队可观测："为什么在排队"正是列表要回答的问题之一）；
 *   · 保留 id / state / tag / kind / engine / model / provider / 时间 / elapsed / exitCode /
 *     responseChars / contextRatio / turnCount / hopCount / stalled / stage / lastTool / tailCount。
 * 要旧形状（含 spec.body、progress、usage、lockPaths）用 `action=list full=true`。 */
/** 紧凑列表默认条数（够看当前活跃 + 最近历史；`limit` 可调，上限见下）。 */
export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 200;

/**
 * 单条 job 的紧凑投影（`action=list` 默认形状）。
 * @param {object} job core serialize 后的 job（或 slimJob 的输出——两者字段兼容）
 * @returns {object|null} 只含"挑下一个动作"所需字段的纯 JSON 记录
 */
export function briefJob(job) {
  if (!job) return null;
  const spec = job.spec && typeof job.spec === 'object' ? job.spec : {};
  const progress = job.progress && typeof job.progress === 'object' ? job.progress : null;
  const attempts = Array.isArray(job.attempts) ? job.attempts : [];
  const paused = job.state === 'paused';
  const stalled = job.state === 'running' && (!job.lastProgressAt || Date.now() - job.lastProgressAt > 150_000);
  /* 空值不占位：宿主 spill 预算按 **chars/4** 估算（dsh-token-meter CHARS_PER_TOKEN=4），
   * 而键名本身才是大头（一条记录 ~490 B 里约一半是键名）——省略 null 字段既省预算也更少噪音。
   * ⚠️ 只删 null/undefined：`exitCode: 0`、`hopCount: 0` 是有意义的值，不能当空值删掉。 */
  const out = {
    id: job.id ?? null,
    state: job.state ?? null,
    tag: spec.tag ?? null,
    kind: spec.kind ?? null,
    engine: job.engine ?? spec.engine ?? null,
    model: job.model ?? spec.model ?? null,
    provider: job.provider ?? spec.provider ?? null,
    queuedAt: job.queuedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    elapsedSec: job.elapsedSec ?? null,
    exitCode: job.exitCode ?? null,
    responseChars: job.responseChars ?? null,
    turnCount: job.turnCount ?? null,
    contextRatio: job.contextRatio ?? null,
    tailCount: Array.isArray(job.tailLines) ? job.tailLines.length : (job.tailCount ?? 0),
    ...(job.hopCount ? { hopCount: job.hopCount } : {}),
    ...(attempts.length ? { attempts: attempts.length } : {}),
    /* ZB-28：排队可观测 —— 紧凑形状也**必须**带它（"为什么在排队"是列表的核心用途之一）。 */
    ...(job.lockWait ? { lockWait: job.lockWait } : {}),
    ...(stalled ? { stalled: true, lastProgressAgoSec: Math.round((Date.now() - job.lastProgressAt) / 1000) } : {}),
    ...(progress ? { stage: progress.stage ?? null, ...(progress.lastTool ? { lastTool: progress.lastTool } : {}) } : {}),
    ...(paused ? { pauseReason: job.pauseReason ?? null, ...(job.pauseDetail ? { pauseDetail: trunc(job.pauseDetail, 160) } : {}) } : {}),
    ...(job.parentJobId ? { parentJobId: job.parentJobId } : {}),
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

/** 用量聚合裁剪成 UI 需要的三窗口字段；ledger 不可用时返回 available:false，不抛错。 */
export function quotaWindows(ledgerPath) {
  if (!ledgerPath) return { available: false, reason: 'ledgerPath 未配置', windows: null };
  try {
    const agg = aggregate({ ledgerPath });
    const pick = (w) => ({
      runs: w.runs,
      requests: w.requests,
      inputTokens: w.inputTokens,
      outputTokens: w.outputTokens,
      cacheReadTokens: w.cacheReadTokens,
      totalTokens: w.totalTokens,
    });
    return {
      available: agg.available,
      generatedAt: agg.generatedAt,
      ledgerPath: agg.ledgerPath,
      skippedLines: agg.skippedLines,
      windows: {
        last5h: pick(agg.windows.last5h),
        week: pick(agg.windows.week),
        today: pick(agg.windows.today),
      },
    };
  } catch (e) {
    return { available: false, reason: e?.message ?? String(e), windows: null };
  }
}

/**
 * 动作处理器（唯一实现点；agent 工具与 Remote 面共用）。
 * @param {object|null} dispatcher createDispatcher() 实例；null 时所有动作返回可读错误
 * @param {object} config 插件 config（需要 ledgerPath 供 quota 动作使用）
 * @returns {(action: string, params?: object) => Promise<{ok: boolean, error?: string, [k: string]: unknown}>}
 */
/* ── ZB-33：免费额度（Start Plan）余量 —— **面板与 agent 工具共用同一份计算**（单一源） ──
 * 纪律：只读 ZCode 客户端日志（零网络请求、零额度消耗）；只有 start-plan 通道才挂 quota。
 * 工具路径（switch 的 channels/quota 分支）与 RemoteFace 路径（impl.*）都走这两个函数，
 * 避免"面板看得到、工具看不到"这类漂移。 */
export function attachGiftQuota(channels, ledgerPath) {
  const quota = readGiftQuota();
  const text = formatGiftQuota(quota);
  const exhausted = recentQuotaExhausted(ledgerPath); // ZB-37：谁刚撞过额度（提示，不改可用性）
  return {
    channels: (Array.isArray(channels) ? channels : []).map((ch) => {
      const hit = matchQuotaExhausted(ch, exhausted);
      return {
        ...ch,
        ...(GIFT_CHANNEL_RE.test(ch?.id ?? '')
          ? (text ? { quota, quotaText: text } : { giftQuotaUnavailable: quota.reason ?? 'unavailable' })
          : {}),
        ...(hit
          ? {
            recentQuotaExhausted: hit,
            quotaNote: `最近撞过额度（${hit.at}${hit.retryAfterSec ? `，retry-after=${hit.retryAfterSec}s` : ''}）：优先改用其它通道（如 account:<family>-start-plan 免费额度）`,
          }
          : {}),
      };
    }),
    giftQuota: quota,
    ...(text ? { giftQuotaText: text } : {}),
    ...(Object.keys(exhausted).length ? { recentQuotaExhausted: exhausted } : {}),
  };
}

/* ── ZB-37：**哪些通道刚撞过额度**（真机事故：`plan` 显示 enabled=true，实际 Coding Plan 5 小时
 * 窗口已满、一撞就 429；agent 无从判断，只能撞了才知道）。
 * task-11（M3）：解析**已下沉到 core/quota.mjs**（`recentRateLimited` —— 台账的读写归台账模块），
 * 这里只保留**别名导出**（既有调用方与 channel-health 的 import 名不变）。
 * 引用级同一性由 test/host-decouple.test.mjs 钉住 ⇒ 不可能再出现第二份实现。
 * 语义回顾：只做**提示**、不擅自改可用性（enabled 仍以 runner 清单为准）。 */
export const recentQuotaExhausted = recentRateLimited;

/** 通道是否命中「刚撞过额度」（见 recentQuotaExhausted 的归一规则）。 */
export function matchQuotaExhausted(channel, exhausted) {
  const ids = [channel?.id, channel?.aliasOf].filter((x) => typeof x === 'string' && x !== '');
  for (const key of Object.keys(exhausted)) {
    for (const id of ids) {
      const bare = id.replace(/^plan:/, '');
      if (id === key || bare === key || id.includes(key) || key.includes(bare)) return exhausted[key];
    }
  }
  return null;
}

/**
 * ZB-38：派发时若**目标通道最近撞过额度**，返回 `{warning, suggestedProvider}`（**不阻塞派发**）。
 * 真机事故（2026-10-11）：agent 只能靠撞出 429 才发现通道已满；这里有提示就能立刻改派。
 * 建议通道优先给"可用的免费额度通道"（`account:<family>-start-plan`），否则给任一可用且未撞顶的通道。
 */
/** 降级链里的目标 provider（未启用则空）。 */
function fallbackTargetProviders(dispatcher) {
  try {
    const fb = dispatcher.getFallbackChain() ?? {};
    if (fb.enabled === false) return [];
    const list = Array.isArray(fb.targets) ? fb.targets : Array.isArray(fb.chain) ? fb.chain : [];
    return list.map((t) => (typeof t === 'string' ? t : t?.provider)).filter((x) => typeof x === 'string' && x !== '');
  } catch {
    return [];
  }
}

/**
 * task-11（P0-1）：guard 与 hint 的**共享上下文** —— "读台账 → 拉通道清单 → 读默认通道"只做一次。
 *
 * 为什么必须合并（真机代价）：`createActionHandler` 的 dispatch 分支原先把两者各调一次，
 * 而 core 的 `listChannels()` **每次都会 spawn 探测**（zcode `--list-providers` + opencode
 * `--list-models/--version`），且 core 侧没有缓存（缓存只存在于 `createRemoteFace` 的 channelsCache）
 * ⇒ **命中限流时一次工具派发要探测两轮**，调用方被阻塞数十秒。合并后：命中限流 ≤1 次、未命中 0 次（早退）。
 * @returns {null | {exhausted:object, channels:Array, defaultProvider:string, requested:string}}
 */
async function quotaContext(dispatcher, spec, config) {
  const exhausted = recentQuotaExhausted(config.ledgerPath);
  if (Object.keys(exhausted).length === 0) return null; // 无近期限流 ⇒ 一次探测都不做
  let channels;
  try {
    channels = (await dispatcher.listChannels())?.channels ?? [];
  } catch {
    return null;
  }
  let defaultProvider = '';
  try {
    defaultProvider = (await dispatcher.getChannel())?.provider ?? '';
  } catch {
    defaultProvider = '';
  }
  const requested = typeof spec?.provider === 'string' && spec.provider !== '' ? spec.provider : defaultProvider;
  return { exhausted, channels, defaultProvider, requested };
}

/** 通道查找（按 id 或别名）；找不到给"不可用"占位（与改前逐字同义）。 */
const channelOf = (channels, id) => channels.find((c) => c.id === id || c.aliasOf === id) ?? { id, name: id, enabled: false };

/**
 * ZB-39（用户报告：「通道我设置的是免费额度，派发却先走付费 5 小时窗口、撞顶后才回退」）：
 * 调用方**显式指定**的通道「最近撞过额度」（一启动必然 429）时，**改派到用户选定的可用通道** ——
 * 候选顺序 = 默认通道（面板 / `action=channel` 选定）→ 降级链首个可用目标 → 可用的免费额度通道。
 * 只处理"注定失败"这一种情况；候选都不可用（或就是被指定的那条）则**不改派**（仅由 hint 给提示）。
 * 纯计算（不探测）：上下文由 `quotaContext` 提供。
 * @returns {null | {from: string, to: string, name: string}}
 */
function redirectFrom(dispatcher, ctx) {
  const { exhausted, channels, defaultProvider, requested } = ctx;
  if (!requested) return null;
  const chOf = (id) => channelOf(channels, id);
  const usable = (id) => {
    const c = chOf(id);
    return c.enabled === true && !matchQuotaExhausted(c, exhausted);
  };
  if (!matchQuotaExhausted(chOf(requested), exhausted)) return null; // 目标没撞顶 ⇒ 不动
  const candidates = [
    defaultProvider,
    ...fallbackTargetProviders(dispatcher),
    ...channels.filter((c) => GIFT_CHANNEL_RE.test(c.id ?? '')).map((c) => c.id),
  ];
  for (const id of candidates) {
    if (!id || id === requested) continue;
    if (usable(id)) return { from: requested, to: id, name: chOf(id).name ?? id };
  }
  return null;
}

/** ZB-38 提示判定（纯计算，不探测）：目标通道"最近撞过额度"时给 warning + suggestedProvider。 */
function hintFrom(ctx, spec) {
  const { exhausted, channels } = ctx;
  let target = typeof spec?.provider === 'string' && spec.provider !== '' ? spec.provider : '';
  if (target === '') target = ctx.defaultProvider;
  if (target === '') return null;
  const targetCh = channels.find((c) => c.id === target || c.aliasOf === target) ?? { id: target, name: target };
  const hit = matchQuotaExhausted(targetCh, exhausted);
  if (!hit) return null;
  const alt =
    channels.find((c) => c.enabled && GIFT_CHANNEL_RE.test(c.id ?? '')) ??
    channels.find((c) => c.enabled && !matchQuotaExhausted(c, exhausted));
  return {
    warning: `目标通道「${targetCh.name ?? targetCh.id}」最近撞过额度（${hit.at}）：很可能一启动就 paused / quota-exhausted。` +
      (alt ? `建议改用 provider:"${alt.id}"${alt.name ? `（${alt.name}）` : ''}` : '建议 action=channels 另选可用通道') +
      '，或先 action=fallback 开降级链再 retry。',
    ...(alt ? { suggestedProvider: alt.id } : {}),
  };
}

/**
 * ZB-38 + ZB-39 的**单次入口**（task-11 P0-1）：一次 `listChannels()` 同时算出"是否改派"与"是否提示"。
 * 提示在**改派之后的目标**上判定（与改前语义一致：改派成功 ⇒ 提示自然为 null）。
 * @returns {{redirect: object|null, hint: object|null, defaultProvider: string}}
 */
export async function applyQuotaPolicy(dispatcher, spec, config = {}) {
  const ctx = await quotaContext(dispatcher, spec, config);
  if (!ctx) return { redirect: null, hint: null, defaultProvider: '' };
  const redirect = redirectFrom(dispatcher, ctx);
  const hint = hintFrom(ctx, redirect ? { ...spec, provider: redirect.to } : spec);
  return { redirect, hint, defaultProvider: ctx.defaultProvider };
}

/** ZB-39 改派（导出保留：channel-health 直接 import；行为与改前一致）。 */
export async function applyExhaustedChannelGuard(dispatcher, spec, config = {}) {
  const ctx = await quotaContext(dispatcher, spec, config);
  return ctx ? redirectFrom(dispatcher, ctx) : null;
}

/** ZB-38 提示（导出保留：channel-health 直接 import；行为与改前一致）。 */
export async function dispatchQuotaHint(dispatcher, spec, config = {}) {
  const ctx = await quotaContext(dispatcher, spec, config);
  return ctx ? hintFrom(ctx, spec) : null;
}

/** 只取额度字段（`action=quota` 用）。 */
export function giftQuotaFields() {
  const quota = readGiftQuota();
  const text = formatGiftQuota(quota);
  return { giftQuota: quota, ...(text ? { giftQuotaText: text } : {}) };
}

export function createActionHandler(dispatcher, config = {}) {
  return async function handleAction(action, params = {}) {
    try {
      if (!dispatcher) {
        return { ok: false, error: 'dispatcher 未初始化：请在插件 config 配置 runnerPath 与 workRoot 后重载插件' };
      }
      const p = params && typeof params === 'object' ? params : {};
      const switchFile = switchFileOf(config); // Z12：开关真值文件（config 可覆盖，测试密封用）
      switch (action) {
        case 'dispatch': {
          /* Z12 门禁：开关关闭 → 不建 job、不 spawn（runner 侧 zcode-run.mjs 还有第二道）。 */
          const sw = readSwitch(switchFile);
          if (!sw.enabled) return { ok: false, error: SWITCH_OFF_ERROR, switch: sw };
          const spec = { kind: p.kind ?? 'prompt' };
          if (spec.kind === 'task') spec.task = p.task;
          else if (spec.kind === 'target') spec.target = p.target;
          else spec.prompt = p.prompt;
          /* 双引擎（OpenCode 接入）：`engine` / `auto` 也必须在这份白名单里 —— 否则 agent 工具
           * 新加的参数会被**静默丢掉**（工具 schema 有、wire 不透传 ⇒ 调用方以为生效了）。
           * `engine` 主路径其实不依赖它（`provider: "opencode/<model>"` 由 core 自动识别引擎），
           * 但显式 `engine` 是工具文档承诺过的入口；`auto` 是**显式放行 OpenCode 权限**的唯一入口
           * （默认关，不传即不放行），丢了它会让"放行"静默失效 —— 两种都属于"说了不做"，故补上。 */
          for (const k of ['model', 'provider', 'engine', 'mode', 'tag', 'cwd', 'resume']) {
            if (p[k] != null && p[k] !== '') spec[k] = p[k];
          }
          if (p.auto != null) spec.auto = Boolean(p.auto); // 布尔：false 也要落（显式关闭 ≠ 未指定）
          /* ZB-08：细粒度文件锁 —— 调用方声明写入集，只为这些路径加锁。
           * 不声明（null/空数组）⇒ core 回退到 repo/memory 粗粒度锁，安全语义不变。 */
          if (Array.isArray(p.write) && p.write.length > 0) spec.write = p.write.filter((x) => typeof x === 'string' && x.trim());
          if (p.lock != null && p.lock !== '') spec.lock = p.lock;
          /* ZB-29：思考强度（thinking）→ spec.reasoningLevel。'agent'（Agent决定）原样进 spec
           * —— runner 按 ZCode 默认规则（模型声明档位的最后一档）解析成实际档并注入；
           * 具体档位由 runner 按 builtin 声明校验（非法 fail-fast，不静默降级）。
           * ZB-29d：不传 thinking ⇒ 按通道默认思考强度（回退在 core dispatch() 统一实现，
           * 工具/CLI/面板三条入口一致）。 */
          if (p.thinking != null && String(p.thinking).trim() !== '') spec.reasoningLevel = String(p.thinking).trim();
          if (p.timeoutMin != null && p.timeoutMin !== '') spec.timeoutMin = Number(p.timeoutMin);
          if (p.memoryBench != null) spec.memoryBench = Boolean(p.memoryBench);
          /* ZB-39 + ZB-38（task-11 P0-1）：改派与提示**共用一次探测** —— 改前这里先
           * `applyExhaustedChannelGuard` 再 `dispatchQuotaHint`，各自 `listChannels()` 一次
           * （core 每次都会 spawn 探测）⇒ 命中限流时一次工具派发探测两轮。现在合成一次。 */
          const policy = await applyQuotaPolicy(dispatcher, spec, config);
          if (policy.redirect) spec.provider = policy.redirect.to;
          const job = dispatcher.dispatch(spec); // 参数不合法时 core 抛 TypeError，走 catch 返回 error
          return {
            ok: true,
            job: slimJob(job),
            ...(policy.redirect
              ? {
                redirectedFrom: policy.redirect.from,
                warning: `显式指定的通道「${policy.redirect.from}」最近撞过额度（一启动必然 429）：已改派到${policy.redirect.to === policy.defaultProvider ? `你选定的默认通道「${policy.redirect.to}」` : `可用的替代通道「${policy.redirect.to}」`}（${policy.redirect.name}）。若确认原通道窗口已重置，可 action=channels 复核后再指定。`,
              }
              : {}),
            ...(policy.hint ?? {}),
          };
        }
        case 'list': {
          /* ZB-61：默认**紧凑 + 有界**（见 briefJob 的注释：212 KB → 22 KB，不再触发 spill 截断）。
           * `full=true` 回到旧形状（含 spec.body/progress/usage/lockPaths），仍受同一个 limit 约束。 */
          const full = p.full === true || p.full === 'true';
          const rawLimit = Number(p.limit);
          const limit = Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(LIST_LIMIT_MAX, Math.floor(rawLimit))
            : LIST_LIMIT_DEFAULT;
          const all = dispatcher.list().filter(withoutDismissed(dispatcher));
          const page = all.slice(0, limit);
          const counts = {};
          for (const j of all) counts[j.state] = (counts[j.state] ?? 0) + 1;
          const omitted = all.length - page.length;
          return {
            ok: true,
            total: all.length,
            counts,
            shape: full ? 'full' : 'brief',
            jobs: page.map(full ? slimJob : briefJob),
            ...(omitted > 0
              ? {
                /* ⚠️ 别在这里**裸推荐** `full=true`（2026-10-17 审计 P2）：实测 60 条 brief 文本 ≈24.8 KB，
                 * 而 60 条 `full` 文本 ≈135 KB（96 条时 212 KB）—— 模型照"要完整字段就加 full"做，
                 * 会**再次**拿到被宿主 spill 从中间截断的结果，正好抵消 ZB-61 的意义。
                 * 所以必须同时给出**代价**与**安全用法**（full 配小 limit）。 */
                note: `已省略 ${omitted} 条更早的 job（共 ${all.length} 条，本次只回前 ${limit} 条）：取更多用 action=list limit=<n>（上限 ${LIST_LIMIT_MAX}${all.length > LIST_LIMIT_MAX ? `，但总数 ${all.length} 超过上限、无法一次取全，请用 action=tail 逐条看` : ''}）；要完整字段（含派发原文）用 full=true **并配小 limit**（如 full=true limit=10）—— 不配 limit 的全量 full 可能上百 KB，会被宿主**从中间截断**；单条输出用 action=tail id=<jobId>。`,
              }
              : {}),
          };
        }
        case 'kill': {
          const id = p.id ?? p.jobId;
          if (!id) return { ok: false, error: 'kill 需要参数 id' };
          const ok = dispatcher.kill(id, `kill requested via ${p.via ?? 'ui/tool'}`);
          return ok
            ? { ok: true, job: slimJob(dispatcher.get(id)) }
            : { ok: false, error: `kill 失败：job 不存在或已是终态（id=${id}）` };
        }
        /* ZB-08：wait —— 让调用方能「派发 → 等结果 → 接着干」。
         * 注意语义取舍：**paused 也返回**（不干等），因为 paused 需要人/调用方决定
         * 是 retry 续跑还是换通道交接 —— 与 CLI 的 awaitJob（:120）保持同一判据。
         * 超时返回 timedOut:true + 当前状态，**绝不谎报完成**。 */
        case 'wait': {
          const id = p.id ?? p.jobId;
          if (!id) return { ok: false, error: 'wait 需要参数 id' };
          const job = dispatcher.get(id);
          if (!job) return { ok: false, error: `wait 失败：job 不存在（id=${id}）` };
          /* ZB-25：「落地」判据 = SETTLED_STATES（core 的唯一源：终态 + paused）。
           * 原先就地写 DONE 数组 + `state === 'paused' ||` 的写法，是同一事实的第二、三份定义。 */
          const started = Date.now();
          if (SETTLED_STATES.has(job.state)) {
            return { ok: true, job: slimJob(job), waitedSec: 0, timedOut: false };
          }
          // 超时：优先用调用方给的 timeoutSec，否则取该任务 timeoutMin（分钟→秒），都没有则 10 分钟
          const specSec = job.spec?.timeoutMin != null ? Number(job.spec.timeoutMin) * 60 : null;
          const sec = p.timeoutSec != null ? Number(p.timeoutSec) : (specSec ?? 600);
          if (!Number.isFinite(sec) || sec <= 0) return { ok: false, error: 'wait 的 timeoutSec 必须为正数' };
          const settled = await new Promise((done) => {
            const t0 = Date.now();
            const finish = (j, timedOut) => {
              try { un?.(); } catch { /* 已退订 */ }
              done({ j, timedOut, waitedSec: Math.round((Date.now() - t0) / 1000) });
            };
            let un = null;
            const check = (j) => {
              if (j && SETTLED_STATES.has(j.state)) finish(j, false);
            };
            check(dispatcher.get(id)); // 可能已在我订阅前就落地
            un = dispatcher.subscribe((ev) => {
              if (ev.type === 'job-updated' && ev.job?.id === id) check(dispatcher.get(id));
            });
            setTimeout(() => {
              const cur = dispatcher.get(id);
              if (cur && SETTLED_STATES.has(cur.state)) finish(cur, false);
              else finish(cur ?? null, true);
            }, sec * 1000).unref?.();
          });
          return {
            ok: true,
            job: settled.j ? slimJob(settled.j) : null,
            waitedSec: settled.waitedSec,
            timedOut: settled.timedOut,
            ...(settled.timedOut ? { note: `等待超时（${sec}s），job 仍在 ${settled.j?.state ?? 'unknown'}；可继续 wait 或稍后 list 查看` } : {}),
          };
        }
        /* Z11：dismiss = 把 paused/终态 job 从列表移除并落盘（queued/running 必须先 kill）。
         * 返回 {ok:true, id, state}；UI 的「关闭」按钮先 kill、kill 无效（paused）时退回本动作。 */
        case 'dismiss': {
          const id = p.id ?? p.jobId;
          if (!id) return { ok: false, error: 'dismiss 需要参数 id' };
          const job = dispatcher.get(id);
          if (!job) return { ok: false, error: `dismiss 失败：job 不存在（id=${id}）` };
          if (!DISMISSABLE.has(job.state)) {
            return { ok: false, error: `dismiss 只对 paused/终态 job 有效（queued/running 请先 kill）：id=${id} state=${job.state}` };
          }
          dismissedSet(dispatcher).add(String(id));
          persistDismissed(dispatcher, dismissedSet(dispatcher));
          return { ok: true, id, state: job.state };
        }
        case 'tail': {
          const id = p.id ?? p.jobId;
          if (!id) return { ok: false, error: 'tail 需要参数 id' };
          /* n 的规整：**只有正数才算值**（早期 `Math.max(1, Number(n) || 30)` 会让 `n=-5` 变成 1 行 ——
           * 负数在 `||` 下是真值，于是"传了个负数"被当成"只要 1 行"，与直觉相反；审计 P3）。 */
          const rawN = Number(p.n);
          const n = Number.isFinite(rawN) && rawN > 0 ? Math.min(200, Math.floor(rawN)) : TAIL_DEFAULT_LINES;
          const lines = dispatcher.tail(id, n);
          return lines == null ? { ok: false, error: `找不到 job：${id}` } : { ok: true, id, lines };
        }
        case 'quota': {
          const quota = quotaWindows(config.ledgerPath);
          let planQuota;
          try {
            planQuota = await fetchPlanQuota();
          } catch (e) {
            planQuota = { available: false, reason: e?.message ?? String(e) };
          }
          /* ZB-33：附带免费额度（Start Plan）余量 —— 只读 ZCode 客户端日志，零网络请求。 */
          return { ok: true, quota, planQuota, ...giftQuotaFields() };
        }
        /* ---- Z6 增量动作：通道 / 续跑 / 降级链（既有动作语义不变） ---- */
        case 'channels': {
          /* ⚠️ 这里**不能**顺手写 channelsCache —— 那是 `createRemoteFace()` 里的局部变量，
           * 与本函数（`createActionHandler`）是两个独立作用域（实测：两者边界在 689/709 行）。
           * 跨作用域引用它会在运行时抛 ReferenceError，而 `node --check` **查不出来**。 */
          const r = await dispatcher.listChannels();
          /* ZB-51（T5 补）：工具路径（`action=channels`）也必须带上 `engineDetail` ——
           * 与 `impl.channels()`（面板路径）共用同一份诊断信息。**两条路径都要透传**，
           * 否则 Agent 用工具查通道时看不到"引擎形态/版本/登录态"，排障只能靠猜。
           * （面板路径已透传；这里此前漏了 —— 只有"重启后实际调用工具"才暴露出来。） */
          return {
            ok: true,
            ...attachGiftQuota(r.channels ?? [], config.ledgerPath),
            warnings: r.warnings ?? [],
            ...(r.engines ? { engines: r.engines } : {}),
            ...(r.engineDetail ? { engineDetail: r.engineDetail } : {}),
            ...(r.opencodeVersion != null ? { opencodeVersion: r.opencodeVersion } : {}),
          };
        }
        case 'channel': {
          if (p.provider != null && p.provider !== '') {
            /* ZB-29d：通道默认思考强度（reasoningLevel/thinking 二名均可；缺省沿用原值不重置）。 */
            const channel = dispatcher.setChannel({
              provider: p.provider,
              model: p.model ?? null,
              reasoningLevel: p.reasoningLevel ?? p.thinking ?? null,
            });
            return { ok: true, channel };
          }
          return { ok: true, channel: dispatcher.getChannel() };
        }
        /* Z12：status/switch —— 开关的读/写动作（UI 与 agent 工具共用；写文件只经 writeSwitch 一处）。 */
        case 'status':
          return { ok: true, switch: readSwitch(switchFile) };
        case 'switch': {
          if (typeof p.enabled !== 'boolean') {
            return { ok: false, error: 'switch 需要布尔参数 enabled（true=开启派发 / false=关闭派发）', switch: readSwitch(switchFile) };
          }
          try {
            writeSwitch(p.enabled, {
              by: typeof p.by === 'string' && p.by ? p.by : 'ui/tool',
              note: typeof p.note === 'string' ? p.note : '',
            }, switchFile);
          } catch (e) {
            return { ok: false, error: `写开关文件失败：${e?.message ?? e}`, switch: readSwitch(switchFile) };
          }
          return { ok: true, switch: readSwitch(switchFile) };
        }
        case 'retry': {
          /* Z12 门禁：retry 同样会 spawn runner（zcode-run.mjs 对关闭态也会 exit 3），
           * 与其建一个必失败的 job，不如在此拒绝——同属契约「拒绝任何派发」的语义。 */
          const sw = readSwitch(switchFile);
          if (!sw.enabled) return { ok: false, error: SWITCH_OFF_ERROR, switch: sw };
          const id = p.id ?? p.jobId;
          if (!id) return { ok: false, error: 'retry 需要参数 id' };
          const job = dispatcher.retry(id, {
            /* ZB-45（双引擎）：retry 也要能显式指定**引擎/模型**（跨引擎交接重跑＝换会话，
             * 不是 resume），并把 `auto` 带过去 —— 否则"这个任务允许放行权限"会在重试后
             * 静默变回不放行，用户看到的是同一个任务行为前后不一致。 */
            provider: p.provider,
            model: p.model ?? p.retryModel,
            ...(p.engine != null && p.engine !== '' ? { engine: p.engine } : {}),
            ...(p.auto != null ? { auto: Boolean(p.auto) } : {}),
          });
          return { ok: true, job: slimJob(job) };
        }
        case 'fallback': {
          /* ZB-30：chain 既可是通道 id 数组（旧形状），也可是目标对象/对象数组（{provider,model,reasoningLevel}）。
           * null/空数组 = 关闭；单个对象 = 单目标（面板开关 + 三个下拉）。 */
          if (p.chain !== undefined) {
            const raw = p.chain;
            if (raw == null) dispatcher.setFallbackChain([]);
            else if (Array.isArray(raw)) dispatcher.setFallbackChain(raw);
            else if (typeof raw === 'object') dispatcher.setFallbackTarget(raw);
            else dispatcher.setFallbackChain(String(raw).split(','));
          } else if (p.provider !== undefined) {
            dispatcher.setFallbackTarget({ provider: p.provider, model: p.model, reasoningLevel: p.reasoningLevel ?? p.thinking });
          } else if (p.target !== undefined) {
            dispatcher.setFallbackTarget(p.target);
          }
          return { ok: true, ...dispatcher.getFallbackChain() };
        }
        default:
          return { ok: false, error: `未知 action：${action}（可用 ${ACTIONS.join('|')}）` };
      }
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  };
}

/**
 * Remote 面（任务包 Z7 §二.1 规定的方法面；动作实现在 createActionHandler 单点复用）。
 *
 * 返回形状约定：任务包给定了形状的方法严格照做（snapshot() 返回数据对象、
 * tail() 返回 string[]，出错时 reject Error——官方远端方法同样以 reject 表达失败）；
 * 未规定形状的动作方法统一 { ok:true, … } / { ok:false, error }（与 createActionHandler
 * 信封一致，JSON 可序列化）。
 *
 * Z8：face 从对象字面量改为类实例——网关 SRC 路径要求「原型上有方法」（方法标记
 * 挂原型、签名解析读 Function.prototype.toString），对象字面量没有独立原型。
 * 方法签名一律简单标识符参数（不得带默认值/解构/剩余参数，见 gateway
 * methodParameterNames 的 /^[$A-Z_a-z][$\w]*$/u 校验）；缺省语义移到方法体内。
 *
 * @param {object|null} dispatcher createDispatcher() 实例；null 时方法返回可读错误/reject
 * @param {object} config 插件 config（需要 ledgerPath 供 quota/quotaPlan 使用）
 */
export function createRemoteFace(dispatcher, config = {}) {
  const handleAction = createActionHandler(dispatcher, config);
  let channelsCache = null; // { at, value } —— listChannels 每次起 runner 子进程探测，缓存 5s
  const NOT_READY = 'dispatcher 未初始化：请在插件 config 配置 runnerPath 与 workRoot 后重载插件';

  /** 通道清单的**共享缓存 + 去重探测**（两条路径都走这里：面板挂载时的 `channels()` 与快照）。 */
  let channelsProbeInFlight = null;

  /**
   * 取缓存的通道清单；过期则**在后台**刷新（不阻塞调用方）。
   *
   * 【真机事故修复（用户现场：「进程」有时显示"暂无进程记录"、标题栏卡在「连接中」）】
   * 原先 `snapshot()` **内联 await** 了 `channelsCached()`（它会 spawn 一个 runner 子进程做探测，
   * 冷启约 3s，而缓存只有 5s ⇒ 每 5 秒就有一次慢探测）。面板的 remote wire 是
   * `await remote.call('snapshot')` 之后再 emit 的 —— 于是**只要那一次探测慢/卡住，
   * 整包快照就发不出去**：进程列表、用量、总开关状态一起空白，界面停在「连接中」。
   * 这正是"有时正常、有时没有进程"的成因（取决于那一刻探测是命中缓存还是真去 spawn）。
   *
   * 现在：快照路径**只读已缓存的清单**（有就带上，没有就先给空数组），刷新一律后台进行。
   * 通道下拉的权威取数仍在 `channels()`（面板挂载时调用，那里 await 是合理的）。
   */
  function cachedChannels() {
    const now = Date.now();
    const stale = !channelsCache
      || now - channelsCache.at >= ((channelsCache.value.channels ?? []).length === 0 || (channelsCache.value.warnings ?? []).length > 0
        ? CHANNELS_ERROR_TTL_MS
        : CHANNELS_TTL_MS);
    if (stale && channelsProbeInFlight == null) {
      /* 后台刷新：不 await、不 reject 到调用方；失败保留旧值（有旧值总比空好），
       * 下一次快照轮询会按短 TTL 再来一遍（自愈）。 */
      channelsProbeInFlight = (async () => {
        try {
          const r = await dispatcher.listChannels();
          channelsCache = {
            at: Date.now(),
            value: {
              channels: r?.channels ?? [],
              warnings: r?.warnings ?? [],
              ...(r && r.engines ? { engines: r.engines } : {}),
              /* ZB-51（T5）：`engineDetail`（每引擎的形态/版本/登录态）必须一起透传 ——
               * 面板的「引擎状态条」靠它渲染。**漏掉就是静默丢字段**（客户端只会画不出那条 UI）。 */
              ...(r && r.engineDetail ? { engineDetail: r.engineDetail } : {}),
              ...(r && r.opencodeVersion != null ? { opencodeVersion: r.opencodeVersion } : {}),
            },
          };
        } catch { /* 保留旧缓存；下次轮询再试 */ }
        finally { channelsProbeInFlight = null; }
      })();
    }
    return channelsCache ? channelsCache.value : { channels: [], warnings: ['通道清单首次探测中（后台进行，不影响其它分区）'] };
  }

  /** 通道清单（**权威取数**：面板挂载 / `action=channels` 用；会 await 探测）。
   *  双引擎：顶层 `engines` / `opencodeVersion` 一起透传；失败走**短 TTL**（1s）以便轮询自愈。 */
  async function channelsCached() {
    if (channelsCache) {
      const failed = (channelsCache.value.channels ?? []).length === 0 || (channelsCache.value.warnings ?? []).length > 0;
      const ttl = failed ? CHANNELS_ERROR_TTL_MS : CHANNELS_TTL_MS;
      if (Date.now() - channelsCache.at < ttl) return channelsCache.value;
    }
    /* 已有一次探测在飞 ⇒ 复用它（避免并发 spawn 多个 runner —— 那是真机实测过的坑）。 */
    if (channelsProbeInFlight) {
      await channelsProbeInFlight;
      if (channelsCache) return channelsCache.value;
    }
    const r = await dispatcher.listChannels();
    /* 双引擎：**顶层 `engines` / `opencodeVersion` 必须一起透传** —— core 的 listChannels 提供它们
     * （每个通道另有 `c.engine`），若在这里丢掉，客户端/工具就看不到"这台机器上有哪些引擎、
     * OpenCode CLI 是哪个版本"（面板目前靠 `c.engine` 分组，所以丢的是诊断信息，不是功能）。 */
    const value = {
      channels: r?.channels ?? [],
      warnings: r?.warnings ?? [],
      ...(r && r.engines ? { engines: r.engines } : {}),
      // ZB-51（T5）：引擎明细（形态/版本/登录态）—— 面板「引擎状态条」的数据来源
      ...(r && r.engineDetail ? { engineDetail: r.engineDetail } : {}),
      ...(r && r.opencodeVersion != null ? { opencodeVersion: r.opencodeVersion } : {}),
    };
    channelsCache = { at: Date.now(), value };
    return value;
  }
  /** 动作方法：透传 createActionHandler 信封（它已把一切异常折成 {ok:false,error}）。 */
  const viaAction = (action, params) => handleAction(action, params);

  /** 各方法的闭包实现（RemoteFace 类的方法体只做转发，保持签名可被 SRC 解析）。 */
  const impl = {
    async snapshot() {
      if (!dispatcher) throw new Error(NOT_READY);
      const snap = dispatcher.snapshot();
      /* 双引擎（真机事故修复）：这里**只读缓存**的通道清单，绝不 await 探测 ——
       * 探测会 spawn 子进程（冷启 ~3s），一旦它慢，整包快照就发不出去 ⇒ 面板卡在「连接中」、
       * 进程与用量一起空白。刷新交给 cachedChannels() 的后台任务。 */
      const cached = cachedChannels();
      const channels = cached.channels;
      // Z12：快照带开关状态（UI 徽标与禁用判据的直接来源；mtime 缓存，轮询无读盘压力）
      /* ZB-51（T5）：**引擎明细也随快照下发** —— 面板的引擎状态条每轮轮询都能刷新
       * （若只走 `channels()`，那条 UI 就只在挂载/换通道时更新，掉线/登录态变化看不到）。 */
      return {
        ...snap,
        jobs: snap.jobs.map(slimJob).filter(withoutDismissed(dispatcher)),
        channels,
        ...(cached.engineDetail ? { engineDetail: cached.engineDetail } : {}),
        switch: readSwitch(switchFileOf(config)),
      };
    },
    async quota() {
      return { quota: quotaWindows(config.ledgerPath), ...giftQuotaFields() };
    },
    async quotaPlan() {
      try {
        return { planQuota: await fetchPlanQuota(), ...giftQuotaFields() };
      } catch (e) {
        return { planQuota: { available: false, reason: e?.message ?? String(e) }, ...giftQuotaFields() };
      }
    },
    async channels() {
      if (!dispatcher) return { channels: [], warnings: [NOT_READY] };
      const c = await channelsCached();
      /* ZB-33：免费额度通道带**剩余额度**（只读 ZCode 日志，零网络请求）。
       * 面板据此画额度条；agent 工具 `action=channels` 也返回同一份（同一函数）。
       * ZB-51（T5）：`engineDetail` 必须一起透传（面板引擎状态条的数据来源）。 */
      return {
        ...attachGiftQuota(c.channels, config.ledgerPath),
        warnings: c.warnings,
        ...(c.engines ? { engines: c.engines } : {}),
        ...(c.engineDetail ? { engineDetail: c.engineDetail } : {}),
        ...(c.opencodeVersion != null ? { opencodeVersion: c.opencodeVersion } : {}),
      };
    },
    async channel() {
      if (!dispatcher) throw new Error(NOT_READY);
      return dispatcher.getChannel();
    },
    async fallbackChain() {
      if (!dispatcher) throw new Error(NOT_READY);
      return dispatcher.getFallbackChain();
    },
    dispatch: (spec) => viaAction('dispatch', spec && typeof spec === 'object' ? spec : {}),
    kill: (id) => viaAction('kill', { id }),
    dismiss: (id) => viaAction('dismiss', { id }),
    retry: (id, opts) => viaAction('retry', { id, ...(opts && typeof opts === 'object' ? opts : {}) }),
    async tail(id, n) {
      const r = await viaAction('tail', { id, n });
      if (!r.ok) throw new Error(r.error ?? `tail 失败（id=${id ?? ''}）`);
      return r.lines;
    },
    async setChannel(next) {
      if (!next || next.provider == null || next.provider === '') {
        return { ok: false, error: 'setChannel 需要 provider（读当前通道用 channel()）' };
      }
      return viaAction('channel', { provider: next.provider, model: next.model });
    },
    /**
     * setFallbackChain(list|null)：null/undefined = 清空降级（core.setFallbackChain 语义）。
     * ZB-30：list 也接受目标对象数组 [{provider, model, reasoningLevel}]（面板/CLI 新形状）；
     * 单个对象（非数组）走 setFallbackTarget —— 面板开关只设一个目标。
     * 注意 createActionHandler 的 fallback 动作对 null chain 会误拆成 ["null"]（旧缺陷），
     * 这里不走它、直调 core。
     */
    async setFallbackChain(list) {
      if (!dispatcher) return { ok: false, error: NOT_READY };
      try {
        const r = (list != null && !Array.isArray(list) && typeof list === 'object')
          ? dispatcher.setFallbackTarget(list)
          : dispatcher.setFallbackChain(list == null ? [] : list);
        return { ok: true, ...r };
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
    /* Z12：开关读/写（读=readSwitch 数据对象；写=透传 switch 动作信封）。 */
    switchGet: () => readSwitch(switchFileOf(config)),
    switchSet: (next) => viaAction('switch', next && typeof next === 'object' ? next : {}),

    /* ── ZB-52：顺序派发（面板入口）──
     * 读：{order:{zcode:[],opencode:[],qoder:[]}, levels:{…}, sequentialCount}
   * ⚠️ **没有 `enabled`**：顺序派发由「模型」值表达（模型为空 = 顺序派发），不再有独立开关
     * 写：只传 `enabled` 或只传 `order`（**互不覆盖** —— 面板两个控件各自保存）。
     * 与 `setFallbackChain` 同范式：直调 core，不经 action 信封（少一层拆包歧义）。 */
    async sequentialGet() {
      if (!dispatcher) return { ok: false, error: NOT_READY };
      try {
        return { ok: true, ...dispatcher.getSequential() };
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
    async sequentialSet(patch) {
      if (!dispatcher) return { ok: false, error: NOT_READY };
      if (!patch || typeof patch !== 'object') {
        return { ok: false, error: 'sequentialSet 需要对象 {order}' };
      }
      try {
        return { ok: true, ...dispatcher.setSequential(patch) };
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
    /* ── ZB-58：逐模型开关（用户要求：关掉的模型不出现在面板选项里、也不参与顺序派发）──
     * 读：{disabled:[路由id...], userDisabledCount}
     * 写：{route, enabled}（翻单个）或 {disabled:[...]}（整体替换） */
    async modelSwitchesGet() {
      if (!dispatcher) return { ok: false, error: NOT_READY };
      try {
        return { ok: true, ...dispatcher.getModelSwitches() };
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
    async modelSwitchSet(patch) {
      if (!dispatcher) return { ok: false, error: NOT_READY };
      if (!patch || typeof patch !== 'object') {
        return { ok: false, error: 'modelSwitchSet 需要对象 {route, enabled} 或 {disabled}' };
      }
      try {
        return { ok: true, ...dispatcher.setModelSwitch(patch) };
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
  };

  /**
   * face 类：原型供方法标记与签名解析，实例带 typertRemote 绑定
   * （协议 bindTypertRemote 的落盘形状：冻结的 {service, serviceKey, namespace}）。
   */
  class RemoteFace {
    constructor() {
      this.typertRemote = Object.freeze({ service: this, serviceKey: FACE_NAME, namespace: FACE_NAME });
    }
    /** → 快照数据对象（含 channels；jobs 已裁剪并过滤 dismissed，不带本进程文件路径）。 */
    snapshot() { return impl.snapshot(); }
    /** → { quota } 本地台账三窗口（便宜，轮询安全）。 */
    quota() { return impl.quota(); }
    /** → { planQuota } 套餐剩余适配器（慢 ≈2s，客户端只在订阅开始取一次）。 */
    quotaPlan() { return impl.quotaPlan(); }
    /** → { channels, warnings } 通道清单（5s 缓存）。 */
    channels() { return impl.channels(); }
    /** → 当前默认通道数据对象（出错 reject）。 */
    channel() { return impl.channel(); }
    /** → { enabled, chain } 当前降级链（出错 reject）。 */
    fallbackChain() { return impl.fallbackChain(); }
    /** dispatch(spec) → { ok:true, job } | { ok:false, error }。 */
    dispatch(spec) { return impl.dispatch(spec); }
    /** kill(id) → { ok:true, job } | { ok:false, error }。 */
    kill(id) { return impl.kill(id); }
    /** dismiss(id) → { ok:true, id, state } | { ok:false, error }（paused/终态 job 从列表移除并落盘）。 */
    dismiss(id) { return impl.dismiss(id); }
    /** retry(id, opts) → { ok:true, job } | { ok:false, error }。 */
    retry(id, opts) { return impl.retry(id, opts); }
    /** tail(id, n) → string[]（找不到 job 时 reject Error）。 */
    tail(id, n) { return impl.tail(id, n); }
    /** setChannel(next) → { ok:true, channel } | { ok:false, error }。 */
    setChannel(next) { return impl.setChannel(next); }
    /** setFallbackChain(list|null) → { ok:true, enabled, chain } | { ok:false, error }。 */
    setFallbackChain(list) { return impl.setFallbackChain(list); }
    /** → 开关状态 {enabled, updatedAt, updatedBy, note, source}（读文件，mtime 缓存，永不抛）。 */
    switchGet() { return impl.switchGet(); }
    /** switchSet(next) → { ok:true, switch } | { ok:false, error }；next={enabled:boolean, by?, note?}。 */
    switchSet(next) { return impl.switchSet(next); }
    /* ── ZB-52：顺序派发 ──
     * ⚠️ 这两个委托**必须显式写在这里**：光把名字加进 REMOTE_METHODS / FACE_METHOD_TABLE 不够 ——
     * 客户端 `resolveRemote().call('sequentialGet')` 找的是**实例/原型上的方法**，
     * 缺了会抛「远端面缺少方法 sequentialGet()」⇒ 面板静默降级成"关闭"（live 下读写都不生效）。
     * 这一处是队友用运行时反射抓出来的（静态看方法表是齐的，容易漏）。 */
    /** → { order:{zcode,opencode,qoder}, levels:{…}, sequentialCount }（无 enabled）。 */
    sequentialGet() { return impl.sequentialGet(); }
    /** sequentialSet({order}) → 同上 | { ok:false, error }（传 enabled 会抛 TypeError：已废弃）。 */
    sequentialSet(patch) { return impl.sequentialSet(patch); }
    /** → { disabled, userDisabledCount }（逐模型开关：关掉的不出现在面板选项、不参与顺序派发）。 */
    modelSwitchesGet() { return impl.modelSwitchesGet(); }
    /** modelSwitchSet({route, enabled} | {disabled:[...]}) → 同上 | { ok:false, error }。 */
    modelSwitchSet(patch) { return impl.modelSwitchSet(patch); }
  }

  // 方法标记写原型（协议 mark() 的落盘形状：版本化冻结描述符，键跨副本稳定）；
  // typertGateway 的 collectSrcClaims/resolveSrcDescriptor 靠它认领并派发端点。
  Object.defineProperty(RemoteFace.prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(REMOTE_METHODS.map((method) => Object.freeze({
        method,
        invocation: Object.freeze({ kind: 'direct' }),
      }))),
    }),
  });

  return new RemoteFace();
}

/** face 方法面（标记/描述符/文档共用这一份表）：[方法名, 参数名数组, 签名, 结果说明]。 */
const REMOTE_METHODS = ['snapshot', 'dispatch', 'kill', 'dismiss', 'retry', 'tail', 'setChannel', 'setFallbackChain', 'switchGet', 'switchSet', 'quota', 'quotaPlan', 'channels', 'channel', 'fallbackChain', 'sequentialGet', 'sequentialSet', 'modelSwitchesGet', 'modelSwitchSet'];

const FACE_METHOD_TABLE = [
  ['snapshot', [], 'snapshot(): Promise<snapshot>', '快照数据对象 {generatedAt, counts, locks, queue, jobs[], channels[], workRoot, maxConcurrent}', []],
  ['dispatch', ['spec'], 'dispatch(spec): Promise<{ok, job}|{ok:false, error}>', '{ok:true, job}|{ok:false, error}', []],
  ['kill', ['id'], 'kill(id): Promise<{ok, job}|{ok:false, error}>', '{ok:true, job}|{ok:false, error}', []],
  ['dismiss', ['id'], 'dismiss(id): Promise<{ok, id, state}|{ok:false, error}>', '{ok:true, id, state}（paused/终态 job 从列表移除并落盘 dismissed.json；queued/running 需先 kill）|{ok:false, error}', []],
  ['retry', ['id', 'opts'], 'retry(id, opts?): Promise<{ok, job}|{ok:false, error}>', '{ok:true, job}|{ok:false, error}', ['opts']],
  ['tail', ['id', 'n'], 'tail(id, n?): Promise<string[]>', 'string[]（reject Error 表示 job 不存在）', ['n']],
  ['setChannel', ['next'], 'setChannel(next): Promise<{ok, channel}|{ok:false, error}>', '{ok:true, channel}|{ok:false, error}', ['next']],
  ['setFallbackChain', ['list'], 'setFallbackChain(list?): Promise<{ok, enabled, chain}|{ok:false, error}>', '{ok:true, enabled, chain}|{ok:false, error}（null=清空）', ['list']],
  ['switchGet', [], 'switchGet(): Promise<switch>', '派发总开关状态 {enabled, updatedAt, updatedBy, note, source}（读文件，永不抛）', []],
  ['switchSet', ['next'], 'switchSet(next): Promise<{ok, switch}|{ok:false, error}>', '{ok:true, switch}|{ok:false, error}（next={enabled:boolean, by?, note?}；唯一写入口=switch 动作）', ['next']],
  ['quota', [], 'quota(): Promise<{quota}>', '{quota} 本地台账三窗口', []],
  ['quotaPlan', [], 'quotaPlan(): Promise<{planQuota}>', '{planQuota} 套餐剩余适配器（慢，客户端低频取）', []],
  ['channels', [], 'channels(): Promise<{channels, warnings}>', '{channels, warnings}（5s 缓存）', []],
  ['channel', [], 'channel(): Promise<channel>', '当前通道数据对象', []],
  ['fallbackChain', [], 'fallbackChain(): Promise<{enabled, chain}>', '{enabled, chain}', []],
  /* ZB-52：顺序派发（面板入口）。`sequentialSet({order})` 按引擎合并；**没有 enabled**。 */
  ['sequentialGet', [], 'sequentialGet(): Promise<{order, levels, sequentialCount}>', '{order:{zcode:[],opencode:[],qoder:[]}, levels:{…}, sequentialCount}（无 enabled：模型为空即顺序派发）', []],
  ['sequentialSet', ['patch'], 'sequentialSet(patch): Promise<{order, levels, sequentialCount}|{ok:false, error}>', '{order, levels, sequentialCount}（patch={order}；传 enabled 抛 TypeError）', ['patch']],
  /* task-11（P0-3）：这两行的元数据**此前缺失** —— 方法只加进了 REMOTE_METHODS，元数据表漏了，
   * 于是 TYPERT 描述符里没有它们的 codec（registry 路径认不出这两个方法）。
   * 现在两表由 REMOTE_METHODS 单源驱动 + 本表只供元数据，漂移由 test/host-decouple 钉死。 */
  ['modelSwitchesGet', [], 'modelSwitchesGet(): Promise<{disabled, userDisabledCount}>', '{disabled:[路由id…], userDisabledCount}（关掉的模型不出现在面板选项、不参与顺序派发）', []],
  ['modelSwitchSet', ['patch'], 'modelSwitchSet(patch): Promise<{disabled, userDisabledCount}|{ok:false, error}>', '{disabled, userDisabledCount}（patch={route, enabled} 翻单个，或 {disabled:[…]} 整体替换）', ['patch']],
];

/**
 * 方法元数据索引（task-11 P0-3）：`REMOTE_METHODS` 是**唯一源**（成员集与顺序由它决定），
 * `FACE_METHOD_TABLE` 只提供参数/签名/可选参数等元数据。
 * 缺元数据时给最小兜底而**不抛**——本模块在**加载期**执行，抛错会让整个插件不激活；
 * 漂移改由 test/host-decouple.test.mjs 的"两表方法集完全相等"断言在测试期钉死。
 */
const FACE_METHOD_BY_NAME = new Map(FACE_METHOD_TABLE.map((row) => [row[0], row]));
const faceMethodRow = (method) =>
  FACE_METHOD_BY_NAME.get(method)
  ?? [method, [], `${method}(): Promise<unknown>`, '（元数据缺失：见 test/host-decouple.test.mjs）', []];

/**
 * 透传 codec 工厂产物：face 的边界契约就是「JSON 可序列化」——宿主网关 strict 解码
 * 调 create().parse(value) 后仍做 JSON 安全断言（gateway decode→assertJsonValue），
 * 透传 parse + 网关断言合起来即真实契约。无 zod/schemastery 依赖（任务包约束），
 * 不提供 encode/decode（缺省即原样透传，与官方 JSON 结果路径一致）。
 */
const JSON_ANY = Object.freeze({ parse: (value) => value });

/** strict codec（loader/lib/index.js:206-211 与 registry validateCodec 的必需字段）。 */
const strictCodec = (method, field) => ({
  mode: 'strict',
  typeSymbol: `dsh-dispatch#${FACE_NAME}/${method}:${field}`,
  create: () => JSON_ANY,
});

/**
 * 宿主 face 模型描述符（exports["./typert"]；dsh-typert-loader 自动发现并
 * ctx.typert.register —— 见文件头 A 路径）。字段形态对齐官方产物
 * refs/dsh-plugin-manager/lib/typert.host.js，差异仅两处、均为依赖约束所致：
 * ① codec.create 返回透传校验器（无 zod；见 JSON_ANY 注释）；
 * ② 可选参数带 acceptsUndefined:true（网关 assertExactArguments 据此允许缺参，
 *    registry/loader 对 JSON 参数均允许该字段）。
 */
export const TYPERT = {
  package: 'dsh-dispatch',
  face: 'host',
  generator: 'hand-written (Z8)：无 typert 生成器与 zod 依赖；strict codec 用透传校验器，字段形态对齐官方产物',
  service: FACE_NAME,
  schemas: [],
  /* task-11（P0-3）：invocations 由 **REMOTE_METHODS（唯一源）**驱动，元数据按名查表 ——
   * 这样"加了方法忘了加描述符"在结构上不可能（改前是两份手工表，已漂移 17 vs 19）。
   * 原实现解构出的第 4 项 `resultNote` 从未被使用，一并去掉。 */
  invocations: REMOTE_METHODS.map((method) => {
    const [, parameters, , , optionals] = faceMethodRow(method);
    return {
      id: `dsh-dispatch#${FACE_NAME}/${method}`,
      service: FACE_NAME,
      namespace: FACE_NAME,
      method,
      invocation: { kind: 'direct' },
      parameters: parameters.map((name) => ({
        name,
        wire: name,
        source: 'json',
        ...(optionals.includes(name) ? { acceptsUndefined: true } : {}),
        codec: strictCodec(method, name),
      })),
      result: strictCodec(method, 'result'),
    };
  }),
  model: {
    services: [
      {
        description: 'DSH 派发台远端面：派发/监视 ZCode 无头进程，通道/降级链/用量查询（与 agent 工具 dispatch 同一动作实现）。',
        summary: 'DSH 派发台远端面（与 agent 工具同一动作实现）。',
        tags: [],
        key: FACE_NAME,
        exportName: 'createRemoteFace',
        members: REMOTE_METHODS.map((method) => {
          const [, , signature] = faceMethodRow(method);
          return {
            kind: 'method',
            name: method,
            signature,
          };
        }),
        types: [],
      },
    ],
    events: [
      {
        name: EVENT_NAME,
        signature: '() => void',
        description: '快照变更推送（尽力而为）：宿主侧转发事件依赖装配级事件源，未接通时客户端以 1s 轮询兜底。',
        tags: [],
      },
    ],
    objects: [],
  },
};


/**
 * 把推送能力与 Remote 面装到 Host ctx 上，并把 face 注册为 cordis 服务
 * （typertGateway SRC 路径的接收器；文件头 B 路径）。
 * @returns {{ handleAction, subscribe, getSnapshot, dispose, face, registered, diagnostics }}
 *   - face：createRemoteFace() 产物（RemoteFace 实例；registry/SRC 两路派发的同一终点）
 *   - subscribe(fn)：fn 收到 { snapshot, quota }；订阅即回一份当前态，返回退订函数
 *   - registered：face 是否已注册为 cordis 服务（false = ctx 上无 provide，如测试桩）
 *   - diagnostics：ZB-01 注册留痕 { available, strategy, ok, error, visibleAfter, matchedFace, fallbackTried }
 *   - dispose()：插件卸载时由 index.js 的 ctx.effect 调用
 */
export function attachHostWire(ctx, dispatcher, config = {}) {
  const handleAction = createActionHandler(dispatcher, config);
  const face = createRemoteFace(dispatcher, config);

  /* ---- 最后一跳·宿主侧：face 注册为 cordis 服务 `dispatch` ----
   * ctx.provide 即官方注册口（cordis reflect.provide：登记进共享 props 表、
   * 实现由当前 fiber 的 effect 持有，插件卸载自动撤销）。provide 缺席/重名时
   * 降级为仅进程内 face（agent 工具不受影响，远端面不可达 → 客户端走降级链）。
   * ZB-01（阶段 A 侦查 §6 的 E1 实验）：注册过程全程留痕——策略 / 错误 / 注册后
   * 可见性写进激活信标。「服务到底有没有登记进 ctx.reflect.props」在阶段 A 无法
   * 观测（Service 目录是静态声明目录，答不了这个问题），此处把它变成可查事实。 */
  const provideDiag = { available: false, strategy: null, ok: false, error: null, visibleAfter: false, matchedFace: false, fallbackTried: null };
  let disposeProvide = null;
  const tryProvide = (label, fn) => {
    if (typeof fn !== 'function') return false;
    provideDiag.available = true;
    try {
      disposeProvide = fn() ?? null;
      provideDiag.strategy = label;
      provideDiag.ok = true;
      provideDiag.error = null;
      return true;
    } catch (e) {
      provideDiag.strategy = provideDiag.strategy ?? label;
      provideDiag.error = e?.message ?? String(e);
      return false;
    }
  };
  if (!tryProvide('ctx.provide', ctx && typeof ctx.provide === 'function' ? () => ctx.provide(FACE_NAME, face) : null)) {
    /* 退化路径：官方客户端插件同款写法（refs/extracted/dsh-client-ui-layout/lib/client.js:600）。
     * 仅在前一策略真正失败时才调用——同名二次 provide 会抛「already registered」。 */
    if (ctx && ctx.reflect && typeof ctx.reflect.provide === 'function') {
      provideDiag.fallbackTried = 'ctx.reflect.provide';
      tryProvide('ctx.reflect.provide', () => ctx.reflect.provide(FACE_NAME, face));
    }
  }
  /* 注册后可见性自检：ctx.get(FACE_NAME) 能取回即为登记成功（cordis 会包 traced proxy，
   * 故用形状判据；恒等比较另记 matchedFace）。 */
  try {
    const got = ctx && typeof ctx.get === 'function' ? ctx.get(FACE_NAME) : undefined;
    if (got !== undefined && got !== null) {
      provideDiag.visibleAfter = true;
      provideDiag.matchedFace = got === face || got.service === face || typeof got.snapshot === 'function';
    }
  } catch { /* 自检失败不改变注册判定 */ }
  if (disposeProvide == null) {
    try {
      console.warn('[dispatch] 宿主远端面未注册（客户端将走降级链）：', provideDiag.error ?? 'provide 不可用');
    } catch { /* 连 console 都不可用则静默 */ }
  }

  const subscribers = new Set();
  let latestSnapshot = null;
  let latestQuota = null;
  let pending = false;
  let timer = null;

  /* 推送/查询路径的快照同样过滤 dismissed（与 face snapshot 同一集合，按 jobsFile 路径共享）。 */
  const snapFiltered = (snap) => {
    try {
      if (!snap || !Array.isArray(snap.jobs)) return snap;
      const set = dismissedSet(dispatcher);
      return set.size ? { ...snap, jobs: snap.jobs.filter((j) => !set.has(j.id)) } : snap;
    } catch {
      return snap;
    }
  };

  const publish = () => {
    pending = false;
    timer = null;
    if (subscribers.size === 0) return;
    latestQuota = quotaWindows(config.ledgerPath); // 节流点才算一次，避免每行输出都读台账
    const bundle = { snapshot: latestSnapshot, quota: latestQuota };
    for (const fn of subscribers) {
      try {
        fn(bundle);
      } catch { /* 单个订阅者异常不影响其他订阅者 */ }
    }
  };

  const schedulePublish = () => {
    if (pending || subscribers.size === 0) return;
    pending = true;
    timer = setTimeout(publish, PUSH_THROTTLE_MS);
  };

  const unsubscribeDispatcher = dispatcher
    ? dispatcher.subscribe((ev) => {
        if (ev?.type === 'queue-changed') {
          schedulePublish();
          return;
        }
        latestSnapshot = snapFiltered(dispatcher.snapshot());
        schedulePublish();
      })
    : null;

  return {
    handleAction,
    face,
    registered: disposeProvide != null,
    subscribe(fn) {
      if (typeof fn !== 'function') throw new TypeError('subscribe(fn): fn 必须是函数');
      subscribers.add(fn);
      if (latestSnapshot == null && dispatcher) latestSnapshot = snapFiltered(dispatcher.snapshot());
      try {
        fn({ snapshot: latestSnapshot, quota: latestQuota ?? quotaWindows(config.ledgerPath) });
      } catch { /* 与 emit 一致：单个订阅者异常不影响订阅关系与其他订阅者 */ }
      return () => subscribers.delete(fn);
    },
    getSnapshot() {
      if (latestSnapshot == null && dispatcher) latestSnapshot = snapFiltered(dispatcher.snapshot());
      return latestSnapshot;
    },
    /** ZB-01 诊断（写进激活信标）：provide 是否可用/成功、注册后 ctx.get 是否可见。 */
    diagnostics: provideDiag,
    dispose() {
      try {
        disposeProvide?.(); // fiber effect 之外的双保险；幂等
      } catch { /* 已撤销 */ }
      disposeProvide = null;
      unsubscribeDispatcher?.();
      subscribers.clear();
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = false;
    },
  };
}
