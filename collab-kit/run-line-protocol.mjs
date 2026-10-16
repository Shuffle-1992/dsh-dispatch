/**
 * 派发执行器 **输出行协议**（引擎无关；DSH 派发台 core 与各执行器共用的唯一权威定义）。
 *
 * 背景：派发台 core（`dispatch/core/dispatch-core.mjs`）原本把执行器的汇总行格式写死成
 * `[zcode-run] …`。接入第二个执行器（OpenCode）时，如果让 OpenCode 执行器也打印
 * `[zcode-run]` 字样，日志与面板会把两个引擎混为一谈 —— 所以这里把「行前缀」参数化：
 *
 *   引擎 zcode     → 前缀 `[zcode-run]`（ZCode 器 `collab-kit/zcode-run.mjs` 的本名，不变）
 *   引擎 opencode  → 前缀 `[opencode-run]`（`collab-kit/opencode-run.mjs`）
 *
 * 除前缀与下面标注的**引擎差异字段**外，两种引擎的行语法**逐字相同** ——
 * core 的解析、暂停分类、进度心跳、思考强度回显因此对两个引擎同时生效，不需要分叉实现。
 *
 * ⚠️ 兼容纪律：新增/改动行格式必须**同时**改这里与消费方（core 的 `RES` 镜像）；
 * 本文件是零依赖叶子模块（core 与本执行器都 import 它），避免两边各抄一份而漂移。
 */

/** 支持的执行引擎。顺序即优先级：未识别的一律按 'zcode'（默认引擎）处理，保证既有行为不变。
 *  ZB-51：加入 `qoder`（第三个引擎）—— 通道/模型 id 形态为 `qoder/<model>`。
 *  ⚠️ 注意：加进这个清单意味着 `engine:'qoder'` 会被**如实采纳**，而不再静默回落成 zcode。
 *  执行器尚未落地时，core 的引擎路由会给出**可读的"执行器未配置"失败**（见 startJob 的 engineRunner 判定），
 *  而不是"派给 Qoder 却实际跑了 ZCode"这种无声错误。 */
export const ENGINES = Object.freeze(['zcode', 'opencode', 'qoder']);

/** 默认引擎 —— 未显式指定、也推断不出时用它（＝接入 OpenCode 前的既有语义）。 */
export const DEFAULT_ENGINE = 'zcode';

/** 引擎 → 输出行前缀（marker）。 */
export const RUN_PREFIX = Object.freeze({
  zcode: '[zcode-run]',
  opencode: '[opencode-run]',
  qoder: '[qoder-run]',
});

/** 引擎 → runner 脚本的**候选文件名**（core 只作日志/自检提示用，不参与解析）。 */
export const RUNNER_BASENAME = Object.freeze({
  zcode: 'zcode-run.mjs',
  opencode: 'opencode-run.mjs',
  qoder: 'qoder-run.mjs',
});

/** 规范化引擎名：非字符串/未知值 → 默认引擎（永不抛）。 */
export function normalizeEngine(engine) {
  const s = typeof engine === 'string' ? engine.trim().toLowerCase() : '';
  return ENGINES.includes(s) ? s : DEFAULT_ENGINE;
}

/** 引擎对应的行前缀；未知引擎 → 默认引擎前缀。 */
export function prefixFor(engine) {
  return RUN_PREFIX[normalizeEngine(engine)];
}

/**
 * OpenCode 的**通道 id / 模型 id** 形状：`opencode/<model>`。
 * 这是**唯一**的引擎判据（不做猜测）：命中即为 OpenCode 通道。
 */
export const OPENCODE_ID_RE = /^opencode\/[A-Za-z0-9._:-]+$/;

/** 给定 provider/model id 是否是 OpenCode 通道形态。 */
export function isOpenCodeId(id) {
  return typeof id === 'string' && OPENCODE_ID_RE.test(id.trim());
}

/**
 * Qoder 的**通道 id / 模型 id** 形状：`qoder/<model>`。
 *
 * 与 OpenCode 不同，Qoder 的模型名**含空格与点**（真机 `--list-models` 实测返回
 * `Qwen3.8-Max` / `GLM-5.3` / `DeepSeek-V4-Pro` / `Kimi-K2.8-Preview` …），
 * 故字符集必须放行空格与点 —— 否则真机模型名会被判成"非法通道"而消失。
 */
export const QODER_ID_RE = /^qoder\/[A-Za-z0-9._:\- ]+$/;

/** 给定 provider/model id 是否是 Qoder 通道形态。 */
export function isQoderId(id) {
  return typeof id === 'string' && QODER_ID_RE.test(id.trim());
}

/**
 * 给定一个**裸模型名**是否是合法的 Qoder 模型名（用于把 `--list-models` 的输出过滤成模型清单）。
 * 真机实测的模型名形如：`Auto` / `Fast` / `Qwen3.8-Max` / `DeepSeek-V4-Pro` / `GLM-5.3` /
 * `Kimi-K2.8-Preview` / `MiniMax-M2.7` —— **含空格与点**，故不能照抄 OpenCode 的字符集。
 * 这里只做最小校验：非空、无控制字符、长度合理、不含路径分隔符（防把日志行当模型名）。
 */
export function isQoderModelName(name) {
  if (typeof name !== 'string') return false;
  const s = name.trim();
  if (!s || s.length > 64) return false;
  if (/[\\/\u0000-\u001f]/.test(s)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._+\- ]*$/.test(s);
}

/**
 * 由 spec 推断引擎（纯函数、无副作用；core 与 CLI 共用，避免两处判据不一致）。
 *
 * 判据顺序（先显式后推断，绝不猜）：
 *   ① spec.engine 显式给出（合法值）⇒ 用它；
 *   ② spec.provider 形如 `opencode/<model>` ⇒ opencode（这是「通道即执行目标」的落点）；
 *   ③ 都不满足 ⇒ 默认引擎 zcode（既有调用方零改动）。
 *
 * ⚠️ 显式 `spec.engine` 与 ② 冲突时以 ① 为准，但调用方应尽量避免这种矛盾：
 * core 的 `normalizeEngineSpec()` 会把 `opencode/<model>` 通道规整成
 * `{engine:'opencode', provider:'opencode', model:'<model>'}`，冲突就此消失。
 */
export function inferEngine(spec) {
  const explicit = typeof spec?.engine === 'string' ? spec.engine.trim().toLowerCase() : '';
  if (ENGINES.includes(explicit)) return explicit;
  if (isOpenCodeId(spec?.provider)) return 'opencode';
  if (isQoderId(spec?.provider)) return 'qoder';
  /* ⚠️ 真机踩到的坑（ZB-51）：**裸引擎名**也是有效判据 —— 规整后的 spec 里
   * provider 就是裸 `'opencode'` / `'qoder'`（不再带 `/model`）。若不认它们，
   * 一个**已经规整过**的 spec 再进来（`normalizeEngineSpec` 幂等性、或调用方直接构造）
   * 会被翻回默认引擎 zcode —— 于是 job.engine 变 zcode、面板徽标显示 ZCode，
   * 而执行器路由读的是 spec.engine（仍是 qoder）⇒ 表现成"面板说 ZCode 却真跑了 Qoder"。
   * 真机现场：`dispatch({provider:'qoder/Qwen3.8-Flash'})` 的 job 徽标显示 ZCode。 */
  const bare = typeof spec?.provider === 'string' ? spec.provider.trim().toLowerCase() : '';
  if (bare === 'opencode') return 'opencode';
  if (bare === 'qoder' || bare === 'qoder-cn' || bare === 'qoder-global') return 'qoder';
  return DEFAULT_ENGINE;
}

/**
 * 把「OpenCode 通道 id」规整成显式的 engine/provider/model 三元组。
 *   provider=`opencode/glm-5.3-flash-free`, model=null
 *     ⇒ {engine:'opencode', provider:'opencode', model:'opencode/glm-5.3-flash-free'}
 *
 * 幂等：已经是三元组形状时原样返回。其它通道原样返回（只补 engine 字段，不改 provider/model）。
 * 返回值是**新对象**（不修改入参）。
 */
export function normalizeEngineSpec(spec) {
  const out = { ...(spec ?? {}) };
  const engine = inferEngine(out);
  out.engine = engine;
  if (engine === 'opencode') {
    if (isOpenCodeId(out.provider)) {
      const id = String(out.provider).trim();
      /* 显式 model 优先（面板可「通道=opencode/xxx、模型=另一个」时以显式为准）。 */
      if (!out.model) out.model = id;
      out.provider = 'opencode';
    }
    if (out.provider == null) out.provider = 'opencode';
  } else if (engine === 'qoder') {
    /* 与 OpenCode 同形：`qoder/<model>` ⇒ provider='qoder'，model 取**模型名**。
     * ⚠️ 与 OpenCode 的**关键差别**（真机验收抓到的静默 bug）：
     *   · OpenCode 的 `--model` 要**完整通道 id**（`opencode/<model>`）；
     *   · Qoder 的 `--model` 要**裸模型名**（`Qwen3.8-Flash`）。
     * 之前只有"provider 是 `qoder/<model>` 形态"这一个分支会剥前缀；调用方直接传
     * `model:'qoder/Qwen3.8-Flash'`（完整通道 id —— 面板/工具的常见传法）时不会剥
     * ⇒ CLI 收到带前缀的名字 ⇒ Qoder 报
     * `Model "qoder/…" is not available right now; using "auto" instead` ⇒ **静默退回 Auto**。
     * 故这里**无条件**剥掉 `qoder/` 前缀（两种传法都覆盖）。 */
    if (isQoderId(out.provider)) {
      const id = String(out.provider).trim();
      if (!out.model) out.model = id.slice('qoder/'.length);
      out.provider = 'qoder';
    }
    if (out.provider == null) out.provider = 'qoder';
    if (typeof out.model === 'string' && /^qoder\//i.test(out.model.trim())) {
      out.model = out.model.trim().slice('qoder/'.length);
    }
  }
  return out;
}

/* ---------------- 行语法（与 dispatch-core.mjs 的 RES 镜像；改一处必须改另一处） ----------------
 *
 * 与引擎无关的公共行（两种前缀都识别，语法逐字相同）：
 *   tag=<t> mode=<m> cwd=<path>
 *   provider=<p> model=<m> | provider=<p> models=<m1/m2> | provider=<p> (显示名)
 *   endpoint=<url>
 *   usage requests=<n|-> in=<n|-> out=<n|-> cacheRead=<n|->
 *   context used=<n> (<pct>% of <win>) turnCount=<n|->
 *   out=<path> / err=<path> / result=<path> / out=<o> err=<e> result=<r>
 *   memory-ban=on[（任意后缀）]
 *   progress stage=<s> elapsed=<n>s chars=<n> tools=<n>[ lastTool=<t>] stageAgo=<n>s[ session=<id>]
 *   done exit=<n>[ (超时)] elapsed=<n.n>s[ session=<id>][ provider=<p>][ model=<m>][ responseChars=<n>]
 *   resume=<sessId>
 *   cli=<path> / task=<path>        （已知信息行：识别但**不入库**）
 *
 * **引擎差异字段**（仅这两条不同，其余完全一致）：
 *   zcode    前缀 `[zcode-run]`
 *     reasoning-levels <model>=<a,b,c>      思考强度档位表（--list-providers 探测输出）
 *     reasoning-level=<lv> target=<providerId>/<modelId>   实际注入确认
 *   opencode 前缀 `[opencode-run]`
 *     variants <model>=<a,b>                模型变体（OpenCode 的 --variant）表
 *     variant=<v> model=<modelId>           实际生效确认（OpenCode 无需 provider 注入，
 *                                           故不带 target=，以 model= 代替）
 *
 * 新增引擎时的义务：① 在 RUN_PREFIX 加前缀 ② 若思考强度命名不同，在上面加一条差异行
 * ③ 在 core 的 RES 里加镜像正则 ④ 在 core 测试里加该前缀的解析断言。
 */
export const LINE_GRAMMAR_NOTE = '见 run-line-protocol.mjs 顶部“行语法”注释块';

export default {
  ENGINES,
  DEFAULT_ENGINE,
  RUN_PREFIX,
  RUNNER_BASENAME,
  OPENCODE_ID_RE,
  QODER_ID_RE,
  LINE_GRAMMAR_NOTE,
  normalizeEngine,
  prefixFor,
  isOpenCodeId,
  isQoderId,
  isQoderModelName,
  inferEngine,
  normalizeEngineSpec,
};
