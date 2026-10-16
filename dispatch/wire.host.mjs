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
import { aggregate, fetchPlanQuota } from './core/quota.mjs';
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
const dismissedFileOf = (dispatcher) => join(dirname(dispatcher.jobsFile), 'dismissed.json');
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
 * 数据来源 = 台账（runner 识别到 429/限额时写 `rateLimited:true`），取最近 5 小时（与 Coding Plan
 * 滚动窗口同尺度）。只做**提示**、不擅自改可用性（enabled 仍以 runner 清单为准）。
 * provider 归一：台账里可能是 `plan:bigmodel-coding-plan` / `builtin:bigmodel-coding-plan`，
 * 通道 id 可能是 `plan`（别名）/`builtin:bigmodel-coding-plan`。 */
export function recentQuotaExhausted(ledgerPath, nowMs = Date.now(), windowMs = 5 * 3600 * 1000) {
  if (!ledgerPath || !existsSync(ledgerPath)) return {};
  const out = {};
  let lines;
  try {
    lines = readFileSync(ledgerPath, 'utf8').split('\n');
  } catch {
    return {};
  }
  for (const line of lines.slice(-500)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row.at ?? '');
    if (!Number.isFinite(at) || nowMs - at > windowMs) continue;
    if (row.rateLimited !== true && row.rateLimited !== 1) continue;
    const p = typeof row.provider === 'string' && row.provider !== '' ? row.provider : '(unknown)';
    out[p.replace(/^plan:/, '')] = { at: row.at, retryAfterSec: row.retryAfterSec ?? null };
  }
  return out;
}

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
 * ZB-39（用户报告：「通道我设置的是免费额度，派发却先走付费 5 小时窗口、撞顶后才回退」）：
 * 调用方**显式指定**的通道「最近撞过额度」（一启动必然 429）时，**改派到用户选定的可用通道** ——
 * 候选顺序 = 默认通道（面板 / `action=channel` 选定）→ 降级链首个可用目标 → 可用的免费额度通道。
 * 只处理"注定失败"这一种情况：候选顺序 = 默认通道 → 降级链首个可用目标 → 可用的免费额度通道；
 * 若这些候选都不可用（或就是被指定的那条），则**不改派**（仅由 dispatchQuotaHint 给提示）。
 * @returns {null | {from: string, to: string, name: string}}
 */
export async function applyExhaustedChannelGuard(dispatcher, spec, config = {}) {
  const exhausted = recentQuotaExhausted(config.ledgerPath);
  if (Object.keys(exhausted).length === 0) return null;
  let channels;
  try {
    channels = (await dispatcher.listChannels())?.channels ?? [];
  } catch {
    return null;
  }
  const chOf = (id) => channels.find((c) => c.id === id || c.aliasOf === id) ?? { id, name: id, enabled: false };
  const usable = (id) => {
    const c = chOf(id);
    return c.enabled === true && !matchQuotaExhausted(c, exhausted);
  };
  let defaultProvider = '';
  try {
    defaultProvider = (await dispatcher.getChannel())?.provider ?? '';
  } catch {
    defaultProvider = '';
  }
  const requested = typeof spec?.provider === 'string' && spec.provider !== '' ? spec.provider : defaultProvider;
  if (!requested) return null;
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

export async function dispatchQuotaHint(dispatcher, spec, config = {}) {
  const exhausted = recentQuotaExhausted(config.ledgerPath);
  if (Object.keys(exhausted).length === 0) return null;
  let channels;
  try {
    channels = (await dispatcher.listChannels())?.channels ?? [];
  } catch {
    return null;
  }
  let target = typeof spec?.provider === 'string' && spec.provider !== '' ? spec.provider : '';
  if (target === '') {
    try {
      target = (await dispatcher.getChannel())?.provider ?? '';
    } catch {
      target = '';
    }
  }
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
          for (const k of ['model', 'provider', 'mode', 'tag', 'cwd', 'resume']) {
            if (p[k] != null && p[k] !== '') spec[k] = p[k];
          }
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
          /* ZB-39：显式指定的通道"注定失败"（最近撞过额度）⇒ **改派到用户选定的可用通道**
           * （默认通道 → 降级链 → 免费额度通道），并在返回里说明改派事实。 */
          const guard = await applyExhaustedChannelGuard(dispatcher, spec, config);
          if (guard) spec.provider = guard.to;
          let defaultProvider = '';
          try { defaultProvider = (await dispatcher.getChannel())?.provider ?? ''; } catch { defaultProvider = ''; }
          const job = dispatcher.dispatch(spec); // 参数不合法时 core 抛 TypeError，走 catch 返回 error
          /* ZB-38（真机事故：agent 派到付费通道 → 一启动就 429 暂停，只能靠撞了才知道）：
           * 目标通道「最近撞过额度」时**在派发结果里立刻提示**，并给出建议通道 —— 让调用方
           * 有机会马上重派到可用通道，而不是等 paused。提示不阻塞派发（job 照常建）。 */
          const hint = await dispatchQuotaHint(dispatcher, spec, config);
          return {
            ok: true,
            job: slimJob(job),
            ...(guard
              ? {
                redirectedFrom: guard.from,
                warning: `显式指定的通道「${guard.from}」最近撞过额度（一启动必然 429）：已改派到${guard.to === defaultProvider ? `你选定的默认通道「${guard.to}」` : `可用的替代通道「${guard.to}」`}（${guard.name}）。若确认原通道窗口已重置，可 action=channels 复核后再指定。`,
              }
              : {}),
            ...(hint ?? {}),
          };
        }
        case 'list':
          return { ok: true, jobs: dispatcher.list().map(slimJob).filter(withoutDismissed(dispatcher)) };
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
          const n = Math.min(200, Math.max(1, Number(p.n) || TAIL_DEFAULT_LINES));
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
          const r = await dispatcher.listChannels();
          return { ok: true, ...attachGiftQuota(r.channels ?? [], config.ledgerPath), warnings: r.warnings ?? [] };
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
          const job = dispatcher.retry(id, { provider: p.provider, model: p.model ?? p.retryModel });
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

  async function channelsCached() {
    if (channelsCache && Date.now() - channelsCache.at < CHANNELS_TTL_MS) return channelsCache.value;
    const r = await dispatcher.listChannels();
    const value = { channels: r?.channels ?? [], warnings: r?.warnings ?? [] };
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
      const { channels } = await channelsCached();
      // Z12：快照带开关状态（UI 徽标与禁用判据的直接来源；mtime 缓存，轮询无读盘压力）
      return { ...snap, jobs: snap.jobs.map(slimJob).filter(withoutDismissed(dispatcher)), channels, switch: readSwitch(switchFileOf(config)) };
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
       * 面板据此画额度条；agent 工具 `action=channels` 也返回同一份（同一函数）。 */
      return { ...attachGiftQuota(c.channels, config.ledgerPath), warnings: c.warnings };
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
const REMOTE_METHODS = ['snapshot', 'dispatch', 'kill', 'dismiss', 'retry', 'tail', 'setChannel', 'setFallbackChain', 'switchGet', 'switchSet', 'quota', 'quotaPlan', 'channels', 'channel', 'fallbackChain'];

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
];

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
  invocations: FACE_METHOD_TABLE.map(([method, parameters, , resultNote, optionals]) => ({
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
  })),
  model: {
    services: [
      {
        description: 'DSH 派发台远端面：派发/监视 ZCode 无头进程，通道/降级链/用量查询（与 agent 工具 dispatch 同一动作实现）。',
        summary: 'DSH 派发台远端面（与 agent 工具同一动作实现）。',
        tags: [],
        key: FACE_NAME,
        exportName: 'createRemoteFace',
        members: FACE_METHOD_TABLE.map(([method, parameters, signature]) => ({
          kind: 'method',
          name: method,
          signature,
        })),
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
