/**
 * 任务落地自动唤醒（settle notice）—— ZB-22。
 *
 * 现场问题（用户报告）：「会话里派发一个 ZCode 任务后，会话不等待、直接继续/结束；
 * 任务跑完了没有任何东西叫醒它，得我自己再发一句话才继续。」DSH 原生后台任务不是这样
 * ——`dsh-tool-jobs` 在 job 落地时把通知投进**发起它的那个会话**（空闲则开新一轮、
 * 忙碌则插进下一步），会话因此被自动拉起。
 *
 * 本模块用**同一套宿主契约**补上这个缺口（证据与实现对照见 README「任务落地自动唤醒」）：
 *   · 归属：工具的 `execute(args, exec)` 拿得到 `exec.agent.id`（即发起会话 id）。
 *     dispatch/retry 返回后把 jobId → 会话 id 登记进来。
 *   · 触发：`dispatcher.subscribe` 的 `job-updated` 事件里判断 job 是否落到了
 *     done/failed/killed/interrupted/paused —— 判据与 `wire.host.mjs` 的 `action=wait`
 *     完全同源（**paused 也算落地**：它需要人/调用方决定续跑还是换通道，不能干等）。
 *   · 投递：`ctx.agents.get(sessionId)` → `status === 'idle' ? followup(msg) : inject(msg)`。
 *     消息形态与 `dsh-tool-jobs` 一致：`role:'user'` + `source:{kind, form:'notice', summary}`，
 *     客户端据此渲染成一张「本轮由通知触发」的可展开卡片（不是在聊天里冒充用户发言）。
 *
 * 抑制（与 `dsh-tool-jobs` 的 `killedByModel` / `awaited` 同语义）：模型**自己** kill 掉的、
 * 或**自己**用 action=wait 已经读到结果的 job，不再补发通知 —— 避免「自己做的事又叫醒自己」。
 *
 * 依赖纪律：本文件**不 import 任何 @deepseek-ai/**（第三方插件目录下裸 import 必失败，
 * test/z2-verify.mjs §4 静态纪律也禁止）。`createUserMessage` 是纯数据构造函数
 * （`{...input, role:'user'}` + randomUUID + deepFreeze，见 dsh-llm/lib/types/message.js），
 * 这里按同一形状本地实现，值语义完全一致；`agents` 服务由 index.js 经 `ctx.inject` 注入。
 *
 * 激活安全：任何一步失败都只 warn，绝不抛——唤醒是增强，不能影响派发本身。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/* ZB-25：落地判据取自 core（状态机所有者），不在本文件重新写一份集合。 */
import { SETTLED_STATES } from './core/dispatch-core.mjs';

/** 通知消息的 producer 标识。会话格式 v4 只要求「非空字符串且不等于 'plugin'」，未知 kind 是合法且被保留的归属（dsh-session-format-v3-to-v4/lib/index.js:124-137）。 */
export const SOURCE_KIND = 'dispatch';
/** 客户端已认识的上下文形态之一。**不要**换成别的字符串：unknown form 会让客户端 contextBody 抛 `unreachable context form`（dsh-client-ui-chat）。 */
export const SOURCE_FORM = 'notice';
/**
 * 落地判据。**引用 core 的唯一源**（ZB-25）—— 原先这里与 wire.host.mjs 的 `DISMISSABLE`
 * 各自写一份**逐元素相同**的集合，是同一事实的第 3、4 份定义。
 * 保留本名导出以免破坏既有 import；引用级同一性由 test/single-source.test.mjs 守着。
 */
export const SETTLE_STATES = SETTLED_STATES;
/** 客户端折叠行摘要的字数上限（dsh-llm 的 CONTEXT_SUMMARY_MAX_CHARS=120 同值）。 */
export const CONTEXT_SUMMARY_MAX_CHARS = 120;

/** 把一行摘要夹到客户端上限内（超出用省略号，不截半个字）。 */
export function boundSummary(summary) {
  const s = typeof summary === 'string' ? summary : String(summary ?? '');
  return s.length <= CONTEXT_SUMMARY_MAX_CHARS ? s : `${s.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`;
}

/** 与 dsh-llm 的 deepFreeze(structuredClone(message)) 同效：发布前冻结一份脱离调用方的快照。 */
function freezeClone(value) {
  const copy = structuredClone(value);
  const walk = (v) => {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (const child of Object.values(v)) walk(child);
    }
    return v;
  };
  return walk(copy);
}

/**
 * 构造一条「用户角色 + notice 归属」的唤醒消息（形状 = dsh-llm 的 createUserMessage）。
 * @param {{text: string, summary: string}} notice 模型可见正文 + 客户端折叠行摘要
 * @returns {object} 冻结的消息值
 */
export function createNoticeMessage(notice) {
  return freezeClone({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(notice?.text ?? '') }],
    source: { kind: SOURCE_KIND, form: SOURCE_FORM, summary: boundSummary(notice?.summary ?? '') },
  });
}

/** job 的 spec 字段（core 保证是对象；旧快照/手改文件可能缺失，一律降级）。 */
function specOf(job) {
  return job?.spec && typeof job.spec === 'object' ? job.spec : {};
}

/**
 * 生成模型可见的落地通知正文与折叠摘要。
 * 正文要求：一眼看出「哪个 job、什么结局、下一步用什么动作拿结果」。
 * @param {object} job dispatcher 的 job（serialize 后的纯 JSON）
 * @returns {{text: string, summary: string}}
 */
export function buildSettleNotice(job) {
  const id = String(job?.id ?? 'unknown');
  const spec = specOf(job);
  const kind = typeof spec.kind === 'string' && spec.kind ? spec.kind : 'prompt';
  const tag = typeof spec.tag === 'string' && spec.tag ? `, tag=${spec.tag}` : '';
  const exit = job?.exitCode == null ? '' : `, exit=${job.exitCode}`;
  const paused = job?.state === 'paused';
  const pause = paused && job?.pauseReason ? `, 暂停原因=${job.pauseReason}` : '';
  const status = String(job?.state ?? 'unknown');
  const head = paused
    ? `派发任务 ${id} 已暂停 —— 需要你决定：action=retry 续跑，或换通道交接。`
    : `派发任务 ${id} 已落地。`;
  const text = [
    `[dispatch] ${head}`,
    `（kind=${kind}${tag}${exit}${pause}）[status: ${status}]`,
    `用 dispatch action=tail（id=${id}, n=30）读最近输出，或 action=list 看全部 job。`,
  ].join('\n');
  return { text, summary: `zcode job ${id} ${status}${tag}` };
}

/**
 * 落地通知器。
 *
 * @param {object} options
 * @param {object} options.dispatcher createDispatcher() 实例（提供 subscribe / get）
 * @param {object} options.agents 宿主 agents 服务（ctx.agents；提供 get(id) → Agent）
 * @param {(level: string, msg: string) => void} [options.log]
 * @param {object} [options.config] 插件 config（读 maxConsecutiveWakes）
 * @param {object} [options.ctx] 插件上下文（仅用于订阅 agent/inbox/claimed 复位唤醒预算）
 * @returns {{track: Function, markKilled: Function, markAwaited: Function, stats: Function, dispose: Function}}
 */
export function createSettleNotifier({ dispatcher, agents, log, config = {}, ctx } = {}) {
  if (!dispatcher || typeof dispatcher.subscribe !== 'function') {
    throw new TypeError('createSettleNotifier: 需要提供 dispatcher（含 subscribe/get）');
  }
  const warn = (msg) => { try { log?.('warn', msg); } catch { /* 日志失败不影响唤醒 */ } };
  const info = (msg) => { try { log?.('info', msg); } catch { /* 同上 */ } };

  /** jobId → 发起会话 id。 */
  const owners = new Map();
  /** 已投递过通知的 jobId（防重复）。 */
  const notified = new Set();
  /** 被抑制的 jobId（模型自己 kill / 自己 wait 到落地）。 */
  const suppressed = new Set();
  /** 会话 id → 连续唤醒次数（仅在配置了上限时计数）。 */
  const spentWakes = new Map();
  const counter = { registered: 0, notified: 0, delivered: 0, followup: 0, inject: 0, suppressed: 0, missingAgent: 0, capped: 0, insertAcked: 0, lostWakes: 0 };
  /* ZB-62（DSH 0.2.1 新事件）：**唤醒投递第一次变得可观测**。
   * 背景：`delivered++` 只说明"调用 followup/inject 没抛错"，**不能证明消息真的进了会话 Inbox**
   * —— 会话已关闭/被清空时，通知会被宿主静默丢弃（旧代码完全看不见）。
   * 0.2.1 的事件目录给了两个 emit 事件：`agent/inbox/inserted`（消息进入 live inbox）与
   * `agent/inbox/discarded`（被丢弃）。这里只做**纯观测**：拿我们自己生成的消息 id 对账。
   * ⚠️ 刻意**不**用 `claimed` 反推"唤醒是否真的开了 turn"——官方语义里 claimed 之后 turn
   * 仍可能因 proposed step 被拒而无 step 关闭（既不算 discarded、也不会重发），据此退连续唤醒
   * 预算会引入错账（既有 `claimed` 订阅只按 `source.kind==='user'` 复位，语义正确，保持不动）。 */
  const deliveredIds = new Set();     // 我们投递过的通知消息 id（限量，沿用 TRACK_CAP 淘汰）
  const pendingInsert = new Map();    // 已投递但**尚未**看到 inserted 的消息 id → 投递时刻
  const wakeBudget = Number.isSafeInteger(config.maxConsecutiveWakes) && config.maxConsecutiveWakes > 0 ? config.maxConsecutiveWakes : 0;
  let disposed = false;
  /* ZB-25（审计 A#4）：集合原先只增不减 ⇒ 长跑进程（几天不重启）无界增长。
   * 上限 + 按插入序淘汰最旧一条：唤醒是"最近落地"语义，旧记录没有价值。 */
  const TRACK_CAP = 1000;
  function remember(set, id) {
    set.add(id);
    while (set.size > TRACK_CAP) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  }

  /* ───────── 订阅调度器事件：唯一触发点 ───────── */
  const unsubscribe = dispatcher.subscribe((ev) => {
    if (disposed || ev?.type !== 'job-updated') return;
    const id = ev.job?.id;
    if (typeof id === 'string' && id) check(id);
  });

  /* 用户真说了话 ⇒ 连续唤醒预算清零（与 dsh-tool-jobs 的 maxConsecutiveWakes 同语义）。 */
  const offInbox = typeof ctx?.on === 'function'
    ? ctx.on('agent/inbox/claimed', ({ agent, message } = {}) => {
      if (message?.source?.kind === 'user') spentWakes.delete(agent?.id);
    })
    : null;

  /* ZB-62：投递健康度快照（stats() 与落盘共用同一份，避免"两处各数一遍"）。 */
  function snapshotStats() {
    return {
      ...counter,
      tracked: owners.size,
      wakeBudget,
      unconfirmed: pendingInsert.size,
      owners: [...owners.entries()].map(([id, agentId]) => ({ id, agentId })),
    };
  }

  /** ZB-62：把投递健康度落盘（`<jobsFile 同目录>/wake-stats.json`，诊断用）。
   *  为什么值得写文件：宿主**没有**可供插件读取的通用日志；唤醒是"有就更好"的增强，
   *  没有落盘就只能靠"我发现没被唤醒"这种事后感知。写失败只 warn，绝不影响投递。 */
  function persistStats() {
    try {
      const jobsFile = dispatcher?.jobsFile;
      if (typeof jobsFile !== 'string' || !jobsFile) return;
      const file = join(dirname(jobsFile), 'wake-stats.json');
      const tmp = `${file}.tmp`;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), ...snapshotStats() }, null, 2));
      renameSync(tmp, file); // 原子替换（与 core 落盘同思路）
    } catch { /* 诊断落盘失败不影响唤醒 */ }
  }

  /* ZB-62：按消息 id 对账 —— inserted = 真的进了 Inbox；discarded = 被宿主丢弃（旧代码看不见）。 */
  const offInserted = typeof ctx?.on === 'function'
    ? ctx.on('agent/inbox/inserted', ({ message } = {}) => {
      const id = message?.id;
      if (typeof id !== 'string' || !deliveredIds.has(id)) return;
      pendingInsert.delete(id);
      counter.insertAcked += 1;
      persistStats();
    })
    : null;
  const offDiscarded = typeof ctx?.on === 'function'
    ? ctx.on('agent/inbox/discarded', ({ agent, message } = {}) => {
      const id = message?.id;
      if (typeof id !== 'string' || !deliveredIds.has(id)) return;
      pendingInsert.delete(id);
      counter.lostWakes += 1;
      persistStats();
      warn(`落地通知被宿主丢弃（会话 ${agent?.id ?? '?'}）：唤醒未送达 —— 请用 action=list / action=tail 主动查看结果`);
    })
    : null;

  /** 投递一条落地通知：空闲会话开新一轮（followup），忙碌会话插进下一步（inject）。 */
  function deliver(job, agentId) {
    const agent = agents?.get?.(agentId);
    if (!agent) {
      counter.missingAgent += 1;
      warn(`落地通知跳过：会话 ${agentId} 已不在（job ${job.id}）`);
      return;
    }
    const message = createNoticeMessage(buildSettleNotice(job));
    const idle = agent.status === 'idle';
    if (idle && wakeBudget > 0) {
      const used = spentWakes.get(agentId) ?? 0;
      if (used >= wakeBudget) {
        counter.capped += 1;
        info(`连续唤醒已达上限 ${wakeBudget}（会话 ${agentId}）：job ${job.id} 的通知改为注入，等用户说话后恢复自动唤醒`);
        agent.inject(message);
        counter.inject += 1;
        counter.delivered += 1;
        remember(deliveredIds, message.id);
        pendingInsert.set(message.id, Date.now());
        persistStats();
        return;
      }
      spentWakes.set(agentId, used + 1);
    }
    if (idle) agent.followup(message);
    else agent.inject(message);
    counter[idle ? 'followup' : 'inject'] += 1;
    counter.delivered += 1;
    /* ZB-62：登记消息 id 等 inserted 对账；未确认的留在 pendingInsert（= 诊断"悄悄没入队"）。 */
    remember(deliveredIds, message.id);
    pendingInsert.set(message.id, Date.now());
    while (pendingInsert.size > TRACK_CAP) {
      const oldest = pendingInsert.keys().next().value;
      if (oldest === undefined) break;
      pendingInsert.delete(oldest);
    }
    persistStats();
  }

  /** 判定并投递一个 job（幂等：每个 job 最多一次）。 */
  function check(jobId) {
    if (disposed) return false;
    const agentId = owners.get(jobId);
    if (typeof agentId !== 'string' || !agentId) return false;
    if (notified.has(jobId) || suppressed.has(jobId)) return false;
    let job = null;
    try {
      job = dispatcher.get(jobId);
    } catch { return false; }
    if (!job || !SETTLE_STATES.has(job.state)) return false;
    remember(notified, jobId);
    counter.notified += 1;
    try {
      deliver(job, agentId);
    } catch (e) {
      warn(`落地通知投递失败（job ${jobId}，会话 ${agentId}）：${e?.message ?? e}`);
    }
    /* 投递完即释放归属（notified 仍留着做幂等）——owners 不随历史 job 无界增长。 */
    owners.delete(jobId);
    return true;
  }

  return {
    /**
     * 登记 job 的发起会话。
     * 登记后**立刻**做一次落地判定：dispatch 返回通常还是 queued，但 job 可能在
     * 「返回」与「登记」之间就已落地（排队被 kill / 直接 paused），事件已错过。
     * @returns {boolean} 是否登记成功（无会话 id 时返回 false，不唤醒）
     */
    track(jobId, agentId) {
      if (disposed) return false;
      if (typeof jobId !== 'string' || !jobId) return false;
      if (typeof agentId !== 'string' || !agentId) return false;
      owners.set(jobId, agentId);
      counter.registered += 1;
      check(jobId);
      return true;
    },
    /**
     * 模型自己 kill 的 job：不发通知（否则等于自己叫醒自己）。
     *
     * ⚠️ **必须在调用 dispatcher.kill 之前登记**（ZB-25，审计 A#1 实测）：
     * core 的 `kill()` 对 queued job 会**就地置 killed 并同步 emit** 'job-updated'，
     * 订阅者在那一刻就投递通知 —— 若等工具拿到返回值再登记，排队中的 job 会先被唤醒一次。
     * 顺序错了不会有任何报错，只会多一条"自己叫醒自己"的通知，所以工具层用 pre-hook 保证。
     */
    markKilled(jobId) {
      if (disposed || typeof jobId !== 'string' || !jobId) return;
      remember(suppressed, jobId);
      counter.suppressed += 1;
    },
    /** 模型自己 wait 到落地的 job：结果已拿到，不发通知。 */
    markAwaited(jobId) {
      if (disposed || typeof jobId !== 'string' || !jobId) return;
      remember(suppressed, jobId);
      counter.suppressed += 1;
    },
    /** kill 未成功（如 job 不存在）时撤销预登记，避免误抑制真正该唤醒的 job。 */
    unmarkSuppressed(jobId) {
      if (typeof jobId !== 'string' || !jobId) return;
      suppressed.delete(jobId);
    },
    /** 诊断快照（测试、落盘、激活信标共用同一份）。 */
    stats() {
      return snapshotStats();
    },
    /** ZB-62：诊断落盘的显式入口（测试用；正常运行由投递/事件自动触发）。 */
    persistStats,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { unsubscribe?.(); } catch { /* 已退订 */ }
      try { offInbox?.(); } catch { /* 已退订 */ }
      try { offInserted?.(); } catch { /* 已退订 */ }
      try { offDiscarded?.(); } catch { /* 已退订 */ }
      owners.clear();
      pendingInsert.clear();
    },
  };
}
