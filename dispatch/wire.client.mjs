/**
 * dispatch —— Client 半边接线适配器（Z7 接线版）。
 *
 * 稳定接口：createClientWire(ctx, config) → 数据源三选一，接口名一致：
 *   - subscribe(cb)         cb 收到 { conn, snapshot, quota, planQuota? }；返回退订函数
 *   - dispatch(spec)        Promise<{ok, job?|error}>，spec 形如 { kind, prompt|task|target, model, provider, mode, timeoutMin, memoryBench, tag, lock }
 *   - kill(id) / retry(id, opts?) / tail(id, n?) / channels() / channelGet() / channelSet(c)
 *   - fallbackGet() / fallbackSet(list)
 *   - setChannel(next) / setFallbackChain(list|null)   ← Z7 与宿主 face 同名对齐（语义同 channelSet/fallbackSet）
 *   - dispose()             停掉轮询/引擎定时器（组件卸载时调用）
 *
 * 数据源优先级（Z8）：
 *   1. config.demo === true → 强制内置 demo（「UI 演示模式」配置语义，最高优先）
 *   2. ctx.remote 的远端面（服务名 dispatch，官方调用形状 ctx.remote.<服务名>.<方法>()；
 *      返回值兼容官方 { ok, value } / { ok:false, error:{message} } 信封与本进程域形状两种）
 *      → conn='live'（真数据判据徽标「已连接」；旧写法 conn='remote' 无任何消费者，
 *      Z8-02 修正为与 UI connLabel 映射一致的 'live'）。subscribe 用 1s 轮询 snapshot()
 *      （任务包「简单优先」）；若
 *      ctx.remote.$on 可用（官方推送证据：lib/client.js:3688 的事件订阅形状）则同时
 *      订阅 'dispatch/changed' 事件抢答刷新，退订/卸载一并清理
 *   3. window.__dispatchDemo 外部数据源（宿主/creator 注入）→ conn='ext'
 *   4. 内置 demo 引擎 → conn='demo'。UI 永远可渲染，绝不白屏、不向组件外抛错
 *
 * ⚠ 本文件仍不能被 client.js 直接 import（浏览器模块表只有 react 与 dsh.client.inject
 *   声明的包，本包无构建步骤）；client.js 内嵌了同源传输层 + ctx.remote.$mount 自挂。
 *   官方包的客户端描述符由 dsh 在构建期内联进 dsh-api-remotes 聚合产物，第三方包的
 *   exports["./remote"] 无运行时消费方（Z8 实证，见 tasks/Z8-delivery.md）——本导出
 *   是声明性产物 + 客户端内联副本的规范源。
 */

/** 远端面轮询间隔：任务包规定 1s（「简单优先」）。 */
const REMOTE_POLL_MS = 1000;
/** 外部数据源（window 注入对象）的轮询间隔（ms），Z2 起沿用。 */
const POLL_MS = 2000;
/** 内置 demo 引擎的推进间隔（ms）：running job 的 elapsedSec 每 tick +1。 */
const DEMO_TICK_MS = 1000;
/** 内置 demo 引擎的派发编排：queued→running、running→done 的延迟（ms）。 */
const DEMO_START_MS = 1200;
const DEMO_RUN_MS = 5000;

/* ZB-30：降级**目标**归一（与 core/dispatch-core.mjs 的 normFallbackTargets、client.js 内联副本同语义）。
 * 接受字符串（旧 chain 项）/ 对象（{provider|id|channel, model?, reasoningLevel?|thinking?}）；
 * 无 provider 的项丢弃（不猜），顺序保留；null 字段 = 沿用原任务该维度。 */
function normTargets(list) {
  if (list == null) return [];
  const arr = Array.isArray(list) ? list : [list];
  const out = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      const id = item.trim();
      if (id) out.push({ provider: id, model: null, reasoningLevel: null });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const provider = String(item.provider ?? item.id ?? item.channel ?? '').trim();
    if (!provider) continue;
    const model = item.model == null || item.model === '' ? null : String(item.model);
    const rl = item.reasoningLevel ?? item.thinking ?? null;
    out.push({ provider, model, reasoningLevel: rl == null || rl === '' ? null : String(rl) });
  }
  return out;
}
function fallbackShape(targets) {
  return {
    enabled: targets.length > 0,
    chain: targets.map((x) => x.provider),
    targets,
    target: targets[0] ?? null,
  };
}

/* 与 wire.host.mjs 导出的 FACE_NAME / EVENT_NAME 保持一致（此处不复用 import：
 * 本文件未来可能在浏览器加载，不能牵出宿主半边及其 core 依赖）。 */
const FACE_NAME = 'dispatch';
const EVENT_NAME = 'dispatch/changed';

/** 透传校验器（与 wire.host.mjs 的 JSON_ANY 同一契约，见上注）。 */
const JSON_ANY = Object.freeze({ parse: (value) => value });

/** 客户端远端描述符（与 wire.host.mjs 的 TYPERT.invocations 一一对应）。
 *
 * Z8 形态：可直接交给 ctx.remote.$mount({package, descriptors}) 挂载的贡献项
 * （官方聚合产物同形：refs/extracted/dsh-api-remotes/lib/client.js:4530 起，
 * {package, descriptors}，无 face 字段）。挂载校验要求（extracted/dsh-api-gateway
 * /lib/client.js:2072-2076 requireStrictInputs + typert 客户端注册表 validateCodec）：
 *   - 参数/result codec 必须 {mode:'strict', typeSymbol, create}（create 仅登记期
 *     检查存在性；调用路径不执行客户端编解码——参数原样进 wire，结果无 decode 即透传）；
 *   - JSON 可选参数用 acceptsUndefined:true（网关按它允许缺参）。
 * 与宿主 TYPERT 的 codec 同为透传校验器：本包无 zod/schemastery，边界契约就是
 * 「JSON 可序列化」（宿主网关 parse 后仍做 JSON 安全断言）。
 */
export const TYPERT_REMOTE = {
  package: 'dsh-dispatch',
  service: FACE_NAME,
  generator: 'hand-written (Z8)：无 typert 生成器与 zod 依赖；strict codec 用透传校验器，字段形态对齐官方产物',
  descriptors: [
    ['snapshot', [], 'snapshot(): Promise<snapshot>', [], '快照数据对象 {generatedAt, counts, locks, queue, jobs[], channels[], workRoot, maxConcurrent}'],
    ['dispatch', ['spec'], 'dispatch(spec): Promise<{ok, job}|{ok:false, error}>', [], '{ok:true, job}|{ok:false, error}'],
    ['kill', ['id'], 'kill(id): Promise<{ok, job}|{ok:false, error}>', [], '{ok:true, job}|{ok:false, error}'],
    /* ZB-25（审计 C P1-2 / D #8 / E #7 三路同报）：此行原先漏了。本表头注释自称"与
     * wire.host.mjs 的 TYPERT.invocations 一一对应"，而 host 面（REMOTE_METHODS/FACE_METHOD_TABLE）
     * 与 client.js 内联表都是 15 个方法，只有这里 14 个 —— 三份表且无任何校验，已实际漂移。
     * 补齐的同时，test/single-source.test.mjs 断言三表方法集合相等（防再漂）。 */
    ['dismiss', ['id'], 'dismiss(id): Promise<{ok, id, state}|{ok:false, error}>', [], '{ok:true, id, state}|{ok:false, error}（paused/终态 job 从列表移除并落盘 dismissed.json）'],
    ['retry', ['id', 'opts'], 'retry(id, opts?): Promise<{ok, job}|{ok:false, error}>', ['opts'], '{ok:true, job}|{ok:false, error}'],
    ['tail', ['id', 'n'], 'tail(id, n?): Promise<string[]>', ['n'], 'string[]（{ok:false, error} 表示 job 不存在）'],
    ['setChannel', ['next'], 'setChannel(next): Promise<{ok, channel}|{ok:false, error}>', ['next'], '{ok:true, channel}|{ok:false, error}'],
    ['setFallbackChain', ['list'], 'setFallbackChain(list?): Promise<{ok, enabled, chain}|{ok:false, error}>', ['list'], '{ok:true, enabled, chain}|{ok:false, error}（null=清空）'],
    ['switchGet', [], 'switchGet(): Promise<switch>', [], '派发总开关状态 {enabled, updatedAt, updatedBy, note, source}（读文件，永不抛）'],
    ['switchSet', ['next'], 'switchSet(next): Promise<{ok, switch}|{ok:false, error}>', ['next'], '{ok:true, switch}|{ok:false, error}（next={enabled:boolean, by?, note?}）'],
    ['quota', [], 'quota(): Promise<{quota}>', [], '{quota} 本地台账三窗口'],
    ['quotaPlan', [], 'quotaPlan(): Promise<{planQuota}>', [], '{planQuota} 套餐剩余适配器（慢，客户端低频取）'],
    ['channels', [], 'channels(): Promise<{channels, warnings}>', [], '{channels, warnings}（5s 缓存）'],
    ['channel', [], 'channel(): Promise<channel>', [], '当前通道数据对象'],
    ['fallbackChain', [], 'fallbackChain(): Promise<{enabled, chain}>', [], '{enabled, chain}'],
    /* ZB-52：顺序派发（面板入口）。读回 {enabled, order:{zcode,opencode,qoder}, sequentialCount}；
     * 写接受 `{enabled?}` 或 `{order?}`（**互不覆盖** —— 面板开关与排序列表各自保存）。 */
    ['sequentialGet', [], 'sequentialGet(): Promise<{enabled, order, sequentialCount}>', [], '{enabled, order:{zcode:[],opencode:[],qoder:[]}, sequentialCount}'],
    ['sequentialSet', ['patch'], 'sequentialSet(patch): Promise<{enabled, order, sequentialCount}|{ok:false, error}>', ['patch'], '{enabled, order, sequentialCount}（patch={enabled?}|{order?}）'],
  ].map(([method, parameters, , optionals]) => ({
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
      codec: {
        mode: 'strict',
        typeSymbol: `dsh-dispatch#${FACE_NAME}/${method}:${name}`,
        create: () => JSON_ANY,
      },
    })),
    result: {
      mode: 'strict',
      typeSymbol: `dsh-dispatch#${FACE_NAME}/${method}:result`,
      create: () => JSON_ANY,
    },
  })),
};

export default TYPERT_REMOTE;

/* ---------------- 内置 demo 数据（3 个进程 + 用量窗口） ---------------- */

const nowIso = () => new Date().toISOString();

function demoSnapshot() {
  return {
    generatedAt: nowIso(),
    workRoot: '(demo)',
    maxConcurrent: 3,
    counts: { running: 1, queued: 1, done: 1 },
    locks: {
      repo: { jobId: 'j-demo-run', pid: 4242, at: nowIso(), lock: 'repo' },
      /* ZB-18：演示快照不再含 memory 锁（已于 ZB-16 删除），避免演示模式显示不存在的锁。 */
    },
    queue: ['j-demo-wait'],
    jobs: [
      {
        id: 'j-demo-run', tag: 'demo-running', state: 'running', lock: 'repo+memory',
        spec: { kind: 'prompt', body: '（演示）正在整理 collab 目录的周报…', model: 'GLM-5.3', provider: 'plan', mode: 'edit', lock: 'repo', timeoutMin: 15, memoryBench: false, tag: 'demo-running' },
        queuedAt: nowIso(), startedAt: nowIso(), finishedAt: null,
        elapsedSec: 42, exitCode: null, signal: null, sessionId: null,
        provider: 'plan:bigmodel-coding-plan', model: 'GLM-5.3',
        usage: { requests: 3, inputTokens: 120340, outputTokens: 1502, cacheReadTokens: 40960 },
        contextUsed: 41300, contextWindow: 200000, turnCount: 3, timedOut: false,
        tailCount: 37, parseWarnings: [],
      },
      {
        id: 'j-demo-done', tag: 'demo-done', state: 'done', lock: null,
        spec: { kind: 'prompt', body: '只回答 OK', model: 'GLM-5.3-Flash', provider: 'plan', mode: 'edit', lock: 'repo', timeoutMin: 5, memoryBench: false, tag: 'demo-done' },
        queuedAt: nowIso(), startedAt: nowIso(), finishedAt: nowIso(),
        elapsedSec: 7.7, exitCode: 0, signal: null, sessionId: 'sess_demo-0000',
        provider: 'plan:bigmodel-coding-plan', model: 'GLM-5.3-Flash',
        usage: { requests: 1, inputTokens: 27724, outputTokens: 16, cacheReadTokens: 1536 },
        contextUsed: 27740, contextWindow: 200000, turnCount: 1, timedOut: false,
        tailCount: 9, parseWarnings: [],
      },
      {
        id: 'j-demo-wait', tag: 'demo-queued', state: 'queued', lock: null,
        spec: { kind: 'prompt', body: '（演示）排队中的代码评审任务', model: 'GLM-5.3', provider: 'plan', mode: 'edit', lock: 'repo', timeoutMin: 15, memoryBench: false, tag: 'demo-queued' },
        queuedAt: nowIso(), startedAt: null, finishedAt: null,
        elapsedSec: null, exitCode: null, signal: null, sessionId: null,
        provider: null, model: 'GLM-5.3',
        usage: { requests: null, inputTokens: null, outputTokens: null, cacheReadTokens: null },
        contextUsed: null, contextWindow: null, turnCount: null, timedOut: false,
        tailCount: 0, parseWarnings: [],
      },
    ],
  };
}

function demoQuota() {
  const win = (runs, requests, inTok, outTok, cacheTok) => ({
    runs, requests, inputTokens: inTok, outputTokens: outTok, cacheReadTokens: cacheTok,
    totalTokens: inTok + outTok + cacheTok,
  });
  return {
    available: true,
    generatedAt: nowIso(),
    ledgerPath: '(demo)',
    skippedLines: 0,
    windows: {
      last5h: win(3, 5, 148064, 1518, 42496),
      week: win(7, 12, 341416, 3411, 219200),
      today: win(2, 3, 61420, 640, 18432),
    },
  };
}

/* ---------------- 远端面传输层（ctx.remote 探测 + 信封归一化） ---------------- */

/**
 * 探测 ctx 上的远端面。官方客户端调用形状（refs/dsh-plugin-manager/lib/client.js）：
 *   inject 声明 "remote" 与 "remote.<服务名>"（client.js:3661-3664）后
 *   await ctx.remote.<服务名>.<方法>()（client.js:1130）。
 * 服务名取官方小驼峰惯例（pluginRegistryProbe 等），候选 dispatch / dispatch。
 * 探测标准：对象存在且 snapshot 是函数（face 的最小可用集）。
 */
function resolveRemote(ctx) {
  const svc = ctx?.remote?.[FACE_NAME] ?? ctx?.remote?.['dispatch'];
  if (!svc || typeof svc.snapshot !== 'function') return null;
  const call = async (method, ...args) => {
    if (typeof svc[method] !== 'function') throw new Error(`远端面缺少方法 ${method}()`);
    const raw = await svc[method](...args);
    // 官方代理把返回值包成 { ok, value } / { ok:false, error:{message} }（client.js:1051,1403-1407）；
    // 本进程直连的 face 返回域形状。有 value 键才按信封拆包，其余原样透传。
    if (raw && typeof raw === 'object' && typeof raw.ok === 'boolean' && 'value' in raw) {
      return raw.ok ? raw.value : { ok: false, error: raw.error?.message ?? String(raw.error ?? 'remote error') };
    }
    return raw;
  };
  return { call };
}

/* ---------------- 工厂：数据源三选一 ---------------- */

/**
 * @param {object} [ctx] 客户端 ctx（remote 传输层使用 ctx.remote；demo/ext 路径不依赖）
 * @param {object} [config] { demo?: boolean } —— demo:true 强制内置 demo 引擎
 */
export function createClientWire(ctx, config = {}) {
  const subs = new Set();
  const emit = (bundle) => {
    for (const fn of subs) {
      try {
        fn(bundle);
      } catch { /* 订阅者异常不影响其他 */ }
    }
  };

  /* ---- 数据源 A：ctx.remote 远端面（conn='live'，真数据；Z7 新增） ---- */
  const remote = config.demo === true ? null : resolveRemote(ctx);

  if (remote) {
    const errOf = (e) => ({ ok: false, error: e?.message ?? String(e) });
    let pollTimer = null;
    let pushOff = null;
    let planQuota = null;
    let planTried = false;

    // 套餐剩余适配器慢（≈2s 起子进程）：每次 wire 生命周期只取一次，随下一个 tick 进包
    const refreshPlan = async () => {
      planTried = true;
      try {
        const r = await remote.call('quotaPlan');
        planQuota = r?.planQuota ?? null;
      } catch {
        planQuota = { available: false, reason: 'quotaPlan 调用失败' };
      }
    };

    const tick = async () => {
      try {
        const snapshot = await remote.call('snapshot');
        let quota = null;
        try {
          quota = (await remote.call('quota'))?.quota ?? null;
        } catch { /* 用量失败不挡快照 */ }
        emit({ conn: 'live', snapshot, quota, planQuota });
      } catch (e) {
        // 远端抖动：发一包空快照让 UI 渲染空态，绝不抛出、绝不白屏
        emit({ conn: 'live', snapshot: null, quota: null, planQuota, error: e?.message ?? String(e) });
      }
    };

    /* 与宿主 face 同形的调用（一一对应；错误照 face 契约 reject） */
    const face = {
      snapshot: () => remote.call('snapshot'),
      quota: () => remote.call('quota'),
      quotaPlan: () => remote.call('quotaPlan'),
      channels: () => remote.call('channels'),
      channel: () => remote.call('channel'),
      fallbackChain: () => remote.call('fallbackChain'),
      dispatch: (spec) => remote.call('dispatch', spec && typeof spec === 'object' ? spec : {}),
      kill: (id) => remote.call('kill', id),
      retry: (id, opts) => remote.call('retry', id, opts && typeof opts === 'object' ? opts : {}),
      tail: (id, n) => remote.call('tail', id, n),
      setChannel: (next) => remote.call('setChannel', next && typeof next === 'object' ? next : {}),
      setFallbackChain: (list) => remote.call('setFallbackChain', list == null ? null : list),
      // Z12：派发总开关（switchGet 读状态；switchSet 走宿主唯一写入口）
      switchGet: () => remote.call('switchGet'),
      switchSet: (next) => remote.call('switchSet', next && typeof next === 'object' ? next : {}),
    };
    /* 旧名实现（setChannel/setFallbackChain 别名与 channelSet/fallbackSet 共用）：
     * 不能在对象字面量里互相引用方法名（属性不是作用域绑定），先落成局部函数。 */
    const channelSetImpl = async (c = {}) => {
      try {
        return await face.setChannel(c);
      } catch (e) {
        return errOf(e);
      }
    };
    const fallbackSetImpl = async (target) => {
      try {
        /* ZB-30：对象 = 单目标（面板开关 + 通道/模型/思考强度）；null = 关闭；数组 = 旧形状。 */
        return await face.setFallbackChain(target ?? null);
      } catch (e) {
        return errOf(e);
      }
    };

    return {
      subscribe(cb) {
        if (typeof cb !== 'function') throw new TypeError('subscribe(cb): cb 必须是函数');
        subs.add(cb);
        if (!planTried) refreshPlan();
        tick();
        if (pollTimer == null) pollTimer = setInterval(tick, REMOTE_POLL_MS);
        // 推送通道：$on 可用就挂上（官方事件订阅形状），到包即刷；轮询仍是正确性兜底
        if (pushOff == null && typeof ctx?.remote?.$on === 'function') {
          try {
            pushOff = ctx.remote.$on(EVENT_NAME, () => {
              try {
                tick();
              } catch { /* 抢答失败由轮询兜底 */ }
            });
          } catch {
            pushOff = null;
          }
        }
        return () => {
          subs.delete(cb);
          if (subs.size === 0) {
            if (pollTimer != null) {
              clearInterval(pollTimer);
              pollTimer = null;
            }
            if (pushOff != null) {
              try {
                pushOff();
              } catch { /* 已失效 */ }
              pushOff = null;
            }
          }
        };
      },
      /* ---- 旧接口（UI 信封：永不 reject，供内嵌镜像与既有调用方使用） ---- */
      async dispatch(spec = {}) {
        try {
          return await face.dispatch(spec);
        } catch (e) {
          return errOf(e);
        }
      },
      async kill(id) {
        try {
          return await face.kill(id);
        } catch (e) {
          return errOf(e);
        }
      },
      async retry(id, opts = {}) {
        try {
          return await face.retry(id, opts);
        } catch (e) {
          return errOf(e);
        }
      },
      async tail(id, n) {
        try {
          const lines = await face.tail(id, n);
          return { ok: true, id, lines };
        } catch (e) {
          return errOf(e);
        }
      },
      async channels() {
        try {
          const r = await face.channels();
          return { ok: true, channels: r?.channels ?? [], warnings: r?.warnings ?? [] };
        } catch (e) {
          return errOf(e);
        }
      },
      async channelGet() {
        try {
          return { ok: true, channel: await face.channel() };
        } catch (e) {
          return errOf(e);
        }
      },
      async channelSet(c = {}) {
        return channelSetImpl(c);
      },
      async fallbackGet() {
        try {
          const r = await face.fallbackChain();
          return {
            ok: true,
            enabled: Boolean(r?.enabled),
            chain: Array.isArray(r?.chain) ? r.chain : [],
            targets: Array.isArray(r?.targets) ? r.targets : [], // ZB-30
            target: r?.target ?? null,
          };
        } catch (e) {
          return errOf(e);
        }
      },
      async fallbackSet(target) {
        return fallbackSetImpl(target);
      },
      /* ---- Z7 与宿主 face 同名对齐（转发旧实现，语义一致） ---- */
      setChannel: (c) => channelSetImpl(c),
      setFallbackChain: (l) => fallbackSetImpl(l),
      /* ---- Z12：派发总开关（信封归一化：face 数据对象折成 {ok:true, switch}） ---- */
      async switchGet() {
        try {
          return { ok: true, switch: await face.switchGet() };
        } catch (e) {
          return errOf(e);
        }
      },
      async switchSet(next = {}) {
        try {
          return await face.switchSet(next);
        } catch (e) {
          return errOf(e);
        }
      },
      dispose() {
        subs.clear();
        if (pollTimer != null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        if (pushOff != null) {
          try {
            pushOff();
          } catch { /* 已失效 */ }
          pushOff = null;
        }
      },
    };
  }

  /* ---- 数据源 B：宿主注入的外部 demo 对象（window.__dispatchDemo）---- */
  const ext = typeof window !== 'undefined' ? window.__dispatchDemo : null;
  const extUsable = config.demo !== true && ext != null && typeof ext.getSnapshot === 'function';

  if (extUsable) {
    let pollTimer = null;
    const call = async (name, ...args) => {
      if (typeof ext[name] !== 'function') return { ok: false, error: `外部数据源未提供 ${name}()` };
      try {
        return await ext[name](...args);
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    };
    return {
      subscribe(cb) {
        if (typeof cb !== 'function') throw new TypeError('subscribe(cb): cb 必须是函数');
        subs.add(cb);
        const poll = () => {
          try {
            const bundle = { conn: 'ext', snapshot: ext.getSnapshot(), quota: typeof ext.getQuota === 'function' ? ext.getQuota() : null };
            emit(bundle);
          } catch { /* 外部源抖动一拍不致命 */ }
        };
        poll();
        if (pollTimer == null) pollTimer = setInterval(poll, POLL_MS);
        return () => {
          subs.delete(cb);
          if (subs.size === 0 && pollTimer != null) { // 零订阅自动停表
            clearInterval(pollTimer);
            pollTimer = null;
          }
        };
      },
      dispatch: (spec) => call('dispatch', spec),
      kill: (id) => call('kill', id),
      tail: (id, n) => call('tail', id, n),
      // Z6 增量：通道 / 续跑 / 降级链（外部源未提供时 call() 返回 {ok:false,error}，UI 自行降级）
      channels: () => call('channels'),
      channelGet: () => call('channel', {}),
      channelSet: (c) => call('channel', c ?? {}),
      retry: (id, opts) => call('retry', { id, ...(opts ?? {}) }),
      fallbackGet: () => call('fallback', {}),
      fallbackSet: (target) => call('fallback', { chain: target ?? null }),
      // Z7 与宿主 face 同名对齐（转发旧实现，语义一致）
      setChannel: (c) => call('channel', c ?? {}),
      setFallbackChain: (target) => call('fallback', { chain: target ?? null }),
      // Z12：派发总开关（外部源未提供时 call() 返回 {ok:false,error}，UI 自行降级为只读）
      switchGet: () => call('switchGet', {}),
      switchSet: (next) => call('switchSet', next ?? {}),
      dispose() {
        subs.clear();
        if (pollTimer != null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      },
    };
  }

  /* ---- 数据源 C：内置 demo 引擎（3 个进程起步；派发/kill/tail 均可交互）---- */
  const jobs = new Map();
  for (const j of demoSnapshot().jobs) jobs.set(j.id, { ...j });
  let queue = ['j-demo-wait'];
  let seq = 0;
  let tickTimer = null;
  const quota = demoQuota();
  // Z6 demo 通道面（与真实 listChannels 同形：id/name/enabled/reason/endpoint/models）
  const demoChannels = [
    { id: 'plan', name: '默认套餐（自动选择）', enabled: true, reason: null, endpoint: 'https://open.bigmodel.cn/api/anthropic', models: ['GLM-5.3', 'GLM-5.3-Flash'] },
    { id: 'personal', name: '个人 API（演示）', enabled: true, reason: null, endpoint: 'https://demo.example/v1', models: ['deepseek-flash'] },
    { id: 'builtin:bigmodel-start-plan', name: 'BigModel Start Plan（演示）', enabled: false, reason: 'coding_plan_not_entitled', endpoint: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic', models: ['GLM-5.3', 'GLM-5.3-Flash'] },
    { id: 'builtin:zai-coding-plan', name: 'Z.ai Coding Plan（演示）', enabled: false, reason: 'oauth_provider_inactive', endpoint: 'https://api.z.ai/api/anthropic', models: ['GLM-5.3', 'GLM-5.3-Flash'] },
  ];
  let channel = { provider: 'plan', model: 'GLM-5.3-Flash' };
  let chain = []; // ZB-30：降级目标列表 [{provider, model, reasoningLevel}]

  const lockHolder = () => [...jobs.values()].find((j) => j.state === 'running') ?? null;
  const snapshot = () => {
    const list = [...jobs.values()].sort((a, b) => {
      const rank = { running: 0, queued: 1 };
      return (rank[a.state] ?? 2) - (rank[b.state] ?? 2) || String(b.queuedAt).localeCompare(String(a.queuedAt));
    });
    const counts = {};
    for (const j of list) counts[j.state] = (counts[j.state] ?? 0) + 1;
    const holder = lockHolder();
    const lockRec = holder ? { jobId: holder.id, pid: 4242, at: holder.startedAt, lock: 'demo' } : null;
    return {
      generatedAt: nowIso(),
      workRoot: '(demo)',
      maxConcurrent: 3,
      counts,
      locks: { repo: holder ? lockRec : null, memory: holder ? lockRec : null },
      queue: [...queue],
      jobs: list.map((j) => ({ ...j, spec: { ...j.spec }, usage: { ...j.usage } })),
    };
  };
  const addUsage = (u) => {
    for (const w of [quota.windows.last5h, quota.windows.week, quota.windows.today]) {
      w.runs += 1;
      w.requests += u.requests;
      w.inputTokens += u.inputTokens;
      w.outputTokens += u.outputTokens;
      w.cacheReadTokens += u.cacheReadTokens;
      w.totalTokens = w.inputTokens + w.outputTokens + w.cacheReadTokens;
    }
  };
  const pendingTransitions = new Set(); // dispose 时连同派发编排的挂起定时器一起清
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      pendingTransitions.delete(t);
      fn();
    }, ms);
    pendingTransitions.add(t);
    return t;
  };
  // demo 派发编排（dispatch 与 retry 共用）：queued→running（+1.2s，前面还有 running 则顺延）→ done（再 +5s）
  const scheduleRun = (id) => {
    later(() => {
      const running = jobs.get(id);
      if (!running || running.state !== 'queued') return;
      queue = queue.filter((q) => q !== id);
      running.state = 'running';
      running.startedAt = nowIso();
      running.elapsedSec = 0;
      running.lock = 'repo+memory';
      emit({ conn: 'demo', snapshot: snapshot(), quota: { ...quota, generatedAt: nowIso() } });
    }, DEMO_START_MS + Math.max(0, [...jobs.values()].filter((j) => j.state === 'running').length - 1) * DEMO_RUN_MS);
    later(() => {
      const doneJob = jobs.get(id);
      if (!doneJob || doneJob.state !== 'running') return;
      doneJob.state = 'done';
      doneJob.exitCode = 0;
      doneJob.finishedAt = nowIso();
      doneJob.elapsedSec = Number(((Date.parse(doneJob.finishedAt) - Date.parse(doneJob.startedAt)) / 1000).toFixed(1));
      doneJob.lock = null;
      doneJob.usage = { requests: 1, inputTokens: 27724, outputTokens: 16, cacheReadTokens: 1536 };
      doneJob.contextUsed = 27740;
      doneJob.contextWindow = 200000;
      doneJob.tailCount = 5;
      addUsage(doneJob.usage);
      emit({ conn: 'demo', snapshot: snapshot(), quota: { ...quota, generatedAt: nowIso() } });
    }, DEMO_START_MS + DEMO_RUN_MS);
  };
  const demoTail = (job, n) => {
    const base = [
      `[zcode-run] tag=${job.spec.tag ?? 'demo'} mode=${job.spec.mode ?? 'edit'} cwd=(demo)`,
      '[zcode-run] provider=plan:bigmodel-coding-plan (Fake Provider（ZCode 套餐）)',
      `[zcode-run] usage requests=1 in=100 out=50 cacheRead=10`,
      `[zcode-run] context used=1234 (0.6% of 200000) turnCount=1`,
    ];
    if (job.state === 'done') base.push(`[zcode-run] done exit=0 elapsed=7.7s session=sess_demo-0000 provider=plan:bigmodel-coding-plan model=${job.model}`);
    if (job.state === 'killed') base.push('[zcode-run] killed by user (demo)');
    if (job.state === 'running') base.push(`[zcode-run] running… elapsed=${Math.round(job.elapsedSec ?? 0)}s（demo 流式输出）`);
    if (job.state === 'queued') base.push('(queued: 等待单写者锁，demo)');
    return base.slice(-n);
  };

  const legacyChannelSet = async (c = {}) => {
    channel = {
      provider: String(c.provider ?? channel.provider),
      model: c.model == null || c.model === '' ? null : String(c.model),
    };
    return { ok: true, channel: { ...channel } };
  };
  const legacyFallbackSet = async (target) => {
    chain = normTargets(target); // ZB-30：对象 = 单目标；null = 关闭；数组/字符串 = 旧形状
    return { ok: true, ...fallbackShape(chain) };
  };

  return {
    subscribe(cb) {
      if (typeof cb !== 'function') throw new TypeError('subscribe(cb): cb 必须是函数');
      subs.add(cb);
      emit({ conn: 'demo', snapshot: snapshot(), quota: { ...quota, generatedAt: nowIso() } });
      if (tickTimer == null) {
        tickTimer = setInterval(() => {
          let changed = false;
          const running = [...jobs.values()].filter((j) => j.state === 'running');
          if (running.length > 0) {
            for (const j of running) {
              j.elapsedSec = Number((((j.elapsedSec ?? 0)) + 1).toFixed(1));
            }
            changed = true;
          }
          if (changed) emit({ conn: 'demo', snapshot: snapshot(), quota: { ...quota, generatedAt: nowIso() } });
        }, DEMO_TICK_MS);
      }
      return () => {
        subs.delete(cb);
        if (subs.size === 0 && tickTimer != null) { // 零订阅自动停表
          clearInterval(tickTimer);
          tickTimer = null;
        }
      };
    },
    async dispatch(spec = {}) {
      const kind = spec.kind ?? 'prompt';
      const body = spec[kind];
      if (!body) return { ok: false, error: `kind=${kind} 需要对应的 ${kind} 字段（demo）` };
      const id = `j-demo-new-${++seq}`;
      const job = {
        id,
        tag: spec.tag ?? `demo-new-${seq}`,
        state: 'queued',
        lock: null,
        spec: { kind, body: String(body).slice(0, 80), model: spec.model ?? null, provider: spec.provider ?? null, mode: spec.mode ?? 'edit', lock: spec.lock ?? 'repo', timeoutMin: spec.timeoutMin ?? null, memoryBench: Boolean(spec.memoryBench), tag: spec.tag ?? `demo-new-${seq}` },
        queuedAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        elapsedSec: null,
        exitCode: null,
        signal: null,
        sessionId: null,
        provider: null,
        model: spec.model ?? null,
        usage: { requests: null, inputTokens: null, outputTokens: null, cacheReadTokens: null },
        contextUsed: null,
        contextWindow: null,
        turnCount: null,
        timedOut: false,
        tailCount: 0,
        parseWarnings: [],
        pauseReason: null,
        pauseDetail: null,
        parentJobId: null,
        attempts: [],
        hopCount: 0,
        handedOffTo: null,
        resumedBy: null,
      };
      jobs.set(id, job);
      queue.push(id);
      scheduleRun(id);
      return { ok: true, job: { ...job } };
    },
    async kill(id) {
      const job = jobs.get(id);
      if (!job || ['done', 'failed', 'killed', 'interrupted'].includes(job.state)) {
        return { ok: false, error: `kill 失败：job 不存在或已是终态（id=${id}）（demo）` };
      }
      queue = queue.filter((q) => q !== id);
      job.state = 'killed';
      job.lock = null;
      job.finishedAt = nowIso();
      if (job.startedAt) job.elapsedSec = Number(((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000).toFixed(1));
      emit({ conn: 'demo', snapshot: snapshot(), quota: { ...quota, generatedAt: nowIso() } });
      return { ok: true, job: { ...job } };
    },
    async tail(id, n = 30) {
      const job = jobs.get(id);
      if (!job) return { ok: false, error: `找不到 job：${id}（demo）` };
      return { ok: true, id, lines: demoTail(job, Math.max(1, Number(n) || 30)) };
    },
    /* ---- Z6 demo 增量：通道 / 续跑 / 降级链（与真实 dispatcher 语义同形） ---- */
    async channels() {
      return { ok: true, channels: demoChannels.map((c) => ({ ...c, models: [...c.models] })), warnings: [] };
    },
    async channelGet() {
      return { ok: true, channel: { ...channel } };
    },
    channelSet: (c) => legacyChannelSet(c),
    async retry(id, opts = {}) {
      const job = jobs.get(id);
      if (!job) return { ok: false, error: `找不到 job：${id}（demo）` };
      if (job.state === 'queued' || job.state === 'running') return { ok: false, error: `job 仍在 ${job.state}，不能 retry（demo）` };
      const origProvider = job.spec.provider ?? 'plan';
      const targetProvider = opts.provider != null && opts.provider !== '' ? String(opts.provider) : null;
      const targetModel = opts.model != null && opts.model !== '' ? String(opts.model) : null;
      const sameChannel = targetProvider == null || targetProvider === origProvider;
      const prevAttempts = Array.isArray(job.attempts) ? job.attempts : [];
      const reason = job.pauseReason && job.pauseReason !== 'unknown' ? job.pauseReason : `manual-retry:${job.state}`;
      const nid = `j-demo-retry-${++seq}`;
      const suffix = sameChannel ? `r${prevAttempts.length + 1}` : `h${prevAttempts.length + 1}`;
      const spec = sameChannel && job.sessionId
        ? { ...job.spec, tag: `${job.tag}-${suffix}` }
        : {
            kind: 'prompt',
            body: `（演示）交接重跑：${job.spec.body ?? job.tag}`,
            model: targetModel,
            provider: targetProvider ?? origProvider,
            mode: job.spec.mode ?? 'edit',
            lock: job.spec.lock ?? 'repo', // ZB-18 补漏：默认由 'both' 改为 'repo'（memory 已于 ZB-16 删除）
            timeoutMin: job.spec.timeoutMin ?? null,
            memoryBench: false,
            tag: `${job.tag}-${suffix}`,
          };
      const nj = {
        id: nid,
        tag: `${job.tag}-${suffix}`,
        state: 'queued',
        lock: null,
        spec,
        queuedAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        elapsedSec: null,
        exitCode: null,
        signal: null,
        sessionId: sameChannel && job.sessionId ? job.sessionId : `sess_demo-handoff-${seq}`,
        provider: null,
        model: spec.model ?? null,
        usage: { requests: null, inputTokens: null, outputTokens: null, cacheReadTokens: null },
        contextUsed: null,
        contextWindow: null,
        turnCount: null,
        timedOut: false,
        tailCount: 0,
        parseWarnings: [],
        pauseReason: null,
        pauseDetail: null,
        parentJobId: job.id,
        attempts: [
          ...prevAttempts,
          { jobId: job.id, provider: origProvider, model: job.spec.model ?? null, reason, at: nowIso() },
          { jobId: nid, provider: spec.provider ?? origProvider, model: spec.model ?? null, reason: sameChannel ? 'resume-same-channel' : 'handoff-retry', at: nowIso() },
        ],
        hopCount: sameChannel ? job.hopCount ?? 0 : (job.hopCount ?? 0) + 1,
        handedOffTo: null,
        resumedBy: null,
      };
      jobs.set(nid, nj);
      queue.push(nid);
      if (sameChannel && job.sessionId) job.resumedBy = nid;
      else job.handedOffTo = nid;
      emit({ conn: 'demo', snapshot: snapshot(), quota: { ...quota, generatedAt: nowIso() } });
      scheduleRun(nid);
      return { ok: true, job: { ...nj } };
    },
    async fallbackGet() {
      return { ok: true, ...fallbackShape(chain) };
    },
    fallbackSet: (target) => legacyFallbackSet(target),
    /* ---- Z7 与宿主 face 同名对齐（转发旧实现，语义一致） ---- */
    setChannel: (c) => legacyChannelSet(c),
    setFallbackChain: (l) => legacyFallbackSet(l),
    /* ---- Z12：demo 不读/写真值文件（假数据不该伪装开关状态，也不许写真值） ---- */
    async switchGet() {
      return { ok: false, error: '演示模式无真值文件（demo）' };
    },
    async switchSet() {
      return { ok: false, error: '演示模式不写总开关（demo）' };
    },
    dispose() {
      subs.clear();
      if (tickTimer != null) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      for (const t of pendingTransitions) clearTimeout(t);
      pendingTransitions.clear();
    },
  };
}

/* ── Z8 接线完成后的剩余边界（均已实证，见 tasks/Z8-delivery.md）──
 * 1. 宿主：face 注册为 cordis 服务 + exports["./typert"] 由 dsh-typert-loader 自动
 *    ctx.typert.register（wire.host.mjs）；推送事件（dispatch/changed）的宿主
 *    emit 依赖装配级事件源（registerRemoteEvents），未接——客户端以 1s 轮询兜底。
 * 2. 客户端：client.js 内嵌同源传输层 + apply 里 ctx.remote.$mount 自挂
 *    remote.dispatch（官方公开 API；第三方包不在 api-remotes 构建期聚合里）。
 *    若 $mount 失败或远端面缺席，逐级回退 ext/demo，绝不白屏。
 * 3. exports["./remote"]：无运行时消费方（官方聚合在 dsh 构建期内联官方包的
 *    remote-client 产物），保留为声明性产物与本文件规范源。
 */
