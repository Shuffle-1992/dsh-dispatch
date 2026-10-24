// 双引擎（OpenCode 接入）**客户端契约锁**：通道下拉按引擎分组 + 引擎徽标 + 放行徽标。
//
// 设计决策（用户确认，别再改成双 tab）：引擎是「通道」这一既有抽象的**属性** ——
// 进程列表 / 文件锁 / 队列 / 用量 / 唤醒通知 / 降级链与引擎无关，拆两个 tab 会把
// 「跨引擎降级」这个最大增量割裂。故客户端只做两件事：
//   ① 通道下拉按引擎 optgroup 分组（ZCode 通道 / OpenCode 免费模型）
//   ② 引擎专属信息「按选中通道动态显示」+ 进程行引擎徽标 + 放行徽标
//
// 为什么用**源码锁 + 渲染桩**两种手段（而不是只渲染）：
//   渲染桩要跑完整 client 模块（远端 mount + 异步 channels 回填），在离线测试里
//   时序不稳定（我曾实测：桩注入的 channels 会被 live/desk 数据源覆盖，断言随机化）。
//   故这里把「结构性不变量」用源码锁钉死（不可能静默回归），把**真实渲染**留给
//   浏览器验收（真正刷新页面后目视 + DOM 断言）——两者互补，不重复。
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/* ZB-84：引擎集合的**唯一权威**是协议层的 `ENGINES` —— 这里直接引用它做比对，
 * 不再把三/四个引擎名**写死**在断言里（写死的话，下次加引擎又要手工改测试，
 * 而"忘了改"恰恰是最该被测出来的回归）。 */
import { ENGINES } from '../../collab-kit/run-line-protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const src = readFileSync(join(PKG, 'client.js'), 'utf8');
const zh = JSON.parse(readFileSync(join(PKG, 'locale', 'zh.json'), 'utf8')).ui;
const en = JSON.parse(readFileSync(join(PKG, 'locale', 'en.json'), 'utf8')).ui;

let pass = 0;
const fail = [];
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); } else { fail.push(msg); console.log(`  ✗ ${msg}`); }
};

/* ---------------- ① 双语文案键（中英同步；值不得为空） ---------------- */
console.log('① 双引擎文案键（中英各一份，键-for-键）');
{
  const KEYS = ['engZcode', 'engOpencode', 'engGroupZcode', 'engGroupOpencode', 'engBadge',
    'engLimitedFree', 'engModelOnly', 'chanEngineHintZcode', 'chanEngineHintOpencode',
    'autoApproved', 'autoApprovedHint'];
  for (const k of KEYS) {
    ok(typeof zh[k] === 'string' && zh[k].length > 0, `zh 有 ${k}`);
    ok(typeof en[k] === 'string' && en[k].length > 0, `en 有 ${k}`);
  }
  ok(Object.keys(zh).length === Object.keys(en).length, `中英键数相等（${Object.keys(zh).length}）`);
  /* 引擎名本身不翻译（产品名），但两语言必须一致 */
  ok(zh.engZcode === 'ZCode' && en.engZcode === 'ZCode', 'engZcode 两语言都是 ZCode（产品名不翻译）');
  ok(zh.engOpencode === 'OpenCode' && en.engOpencode === 'OpenCode', 'engOpencode 两语言都是 OpenCode');
  ok(/--variant/.test(zh.chanEngineHintOpencode) && /--variant/.test(en.chanEngineHintOpencode),
    'OpenCode 引擎提示提到 --variant（思考强度映射）');
  ok(/auto/.test(zh.chanEngineHintOpencode) && /auto/.test(en.chanEngineHintOpencode),
    'OpenCode 引擎提示提到 auto（默认不放行）');
}

/* ---------------- ② 分组实现（结构性不变量） ---------------- */
console.log('\n② 通道下拉按引擎分组（单一源 + optgroup）');
{
  ok(/const groupedChannelOptions = \(current\)/.test(src), '存在单一源 groupedChannelOptions');
  const calls = (src.match(/groupedChannelOptions\(/g) ?? []).length;
  ok(calls >= 2, `主通道与降级目标共用它（调用面 ${calls}）`);
  ok(/h\('optgroup', \{ key: g\.key, label: g\.label \}, items\.map\(channelOptionNode\)\)/.test(src),
    '每个引擎组渲染为 optgroup（label 取自 locale）');
  ok(/const ENGINE_GROUPS = \[[\s\S]{0,320}ENG_GROUP_KEY\.zcode[\s\S]{0,200}ENG_GROUP_KEY\.opencode[\s\S]{0,200}ENG_GROUP_KEY\.qoder/.test(src),
    '分组表按 zcode → opencode → qoder 顺序声明（与 core 的 listChannels 顺序一致）');
  /* ZB-51：归属判据从"二元（非 opencode 即 zcode）"升级为**单一权威归一函数**。
   * 理由是那个二元写法会让第三个引擎（qoder）被静默归进 ZCode 组 —— 分组/徽标/提示全错且不报错。 */
  /* ZB-84：与协议层 `ENGINES` **逐元素**比对（不再写死字面量）。 */
  const knownEnginesSrc = src.match(/const KNOWN_ENGINES = \[([^\]]*)\]/);
  const knownEngines = knownEnginesSrc
    ? knownEnginesSrc[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    : null;
  ok(knownEngines != null && JSON.stringify(knownEngines) === JSON.stringify([...ENGINES]),
    `★ 客户端有引擎白名单 KNOWN_ENGINES（与协议层 ENGINES 同集合；实际 ${JSON.stringify(knownEngines)} / 期望 ${JSON.stringify([...ENGINES])}）`);
  ok(/const engineOf = \(v\) => \{[\s\S]{0,200}\}/.test(src), '★ 有归一函数 engineOf（唯一权威，不再各处二元判断）');
  ok(/const items = list\.filter\(\(c\) => engineOf\(c\.engine\) === g\.key\)/.test(src),
    '★ 组内归属判据走 engineOf（未知值归 zcode，向后兼容既有行为）');
  ok(/const others = list\.filter\(\(c\) => !KNOWN_ENGINES\.includes\(engineOf\(c\.engine\)\)\)/.test(src),
    '「其它」组判据同样走归一（结构上不再可能出现"落不进任何组"的通道）');
  /* ZB-33b 语义在"仅看可用=开（默认）"下不变：不可用通道不列出、
   * 当前掉线值单独列出并标注原因。用户新增的开关只是让这条**可关闭**。
   * ZB-51：过滤现在作用在**折叠后**的清单上（`foldChannels(channels)` 的结果），
   * 故断言随之升级为"先折叠再过滤" —— 语义不变，取样对象变了。 */
  ok(/const folded = foldChannels\(channels\);/.test(src) && /const kept = applyChanFilters\(folded\);/.test(src),
    '★ 先折叠再过滤（折叠后的引擎条目才是用户能选的东西；ZB-33b 语义不回归）');
  ok(/const curPinned = !!cur && !kept\.some\(\(c\) => c\.id === cur\.id\)/.test(src),
    '当前值掉线时仍单独补一条（ZB-33b 语义不回归）');
  const pinnedAt = src.indexOf('const pinnedReasonText = (c) =>');
  const pinnedBody = pinnedAt >= 0 ? src.slice(pinnedAt, pinnedAt + 300) : '';
  ok(pinnedAt >= 0 && pinnedBody.includes("c.enabled ? t('filtCurrent')") && pinnedBody.includes('chanDisabled'),
    '★ 掉线标「不可用：原因」、仅被过滤标「当前选择」—— 两种情形分开表达，不谎报');
  /* 单一源：`cur` 必须先经折叠清单解析（旧存值 `opencode/xyz` 才能定位到折叠条目），
   * 再落到同一标注函数。 */
  ok(/const cur = resolveFoldedChannel\(folded, current\) \?\? channels\.find/.test(src)
    && /_reasons: \[pinnedReasonText\(cur\)\]/.test(src),
    '被过滤掉的当前值走同一标注函数（单一源），且先经折叠清单解析旧存值');
}

/* ---------------- ③ 引擎专属动态显示 + 徽标 ---------------- */
console.log('\n③ 引擎专属信息与徽标');
{
  ok(/const chanEngine = sel \? engineOf\(sel\.engine\) : null/.test(src),
    '选中通道的引擎判据走 engineOf（与 core/协议同一判据）');
  ok(/chanEngineNote/.test(src) && /chanEngineHintOpencode/.test(src),
    '引擎专属提示按选中通道动态渲染（不做双 tab 的落点）');
  ok(/\{chanEngineNote\}|\n\s*chanEngineNote,/.test(src), 'chanEngineNote 已挂进通道分区渲染');
  /* 进程行：引擎徽标（一眼看出这个进程是哪个引擎跑的）
   * ⚠️ ZB-51 真机 bug（用户截图发现）：原先这里断言的是**二元**判据
   * `job.engine === 'opencode' || spec.engine === 'opencode'` ⇒ Qoder job 被标成 **ZCode**。
   * 断言随之升级为"走统一归一函数 `jobEngineOf()`"。 */
  ok(/const jobEngineOf = \(job\) => \{/.test(src), '★ 有 job 引擎归一的唯一权威 jobEngineOf()');
  ok(/const e = jobEngineOf\(job\);/.test(src), '引擎徽标走 jobEngineOf（不再二元判断）');
  ok(/KNOWN_ENGINES\.includes\(s\)\) return s;/.test(src), 'jobEngineOf 认 job.engine / spec.engine');
  ok(/p\.startsWith\('opencode\/'\) \|\| p === 'opencode'/.test(src), '退化判据认 opencode 形态与裸名');
  ok(/p\.startsWith\('qoder\/'\) \|\| p === 'qoder'/.test(src), '★ 退化判据也认 qoder 形态与裸名（第三个引擎不能漏）');
  ok(/engLabel\(e\)/.test(src), '徽标文案走 engLabel（中英一致）');
  /* 放行必须可见（可审计） */
  ok(/\(job\.autoApproved \|\| \(job\.spec && job\.spec\.auto\)\)/.test(src),
    '★ autoApproved（或 spec.auto）的 job 显示「已放行权限」徽标 —— 放行不可静默');
  ok(/title: t\('autoApprovedHint'\)/.test(src), '放行徽标带解释性 title');
}

/* ---------------- ④ demo 数据面与 core 形状同形 ---------------- */
console.log('\n④ demo 通道面（离线可视化路径）与 core 同形');
{
  ok(/engine: 'zcode'/.test(src) && /engine: 'opencode'/.test(src),
    'demoChannels 每条都带 engine（与 core listChannels 同形）');
  ok(/id: 'opencode\/deepseek-v4\.1-flash-free'/.test(src), 'demo 里有 opencode/* 通道示例');
  const ocCount = (src.match(/engine: 'opencode'/g) ?? []).length;
  ok(ocCount >= 1 && ocCount <= 6, `demo 里 OpenCode 示例是少数（${ocCount} 条）—— 免费模型清单以探测为准，不写死 12 个`);
  ok(/run-line-protocol/.test(readFileSync(join(PKG, '..', 'collab-kit', 'run-line-protocol.mjs'), 'utf8')),
    '协议文件在位（引擎前缀的单一权威：客户端不重复定义前缀）');
}

/* ---------------- ⑤ 通道过滤开关（仅看可用 / 仅看免费） ---------------- */
console.log('\n⑤ 通道过滤开关（用户要求：面板新增 2 个开关用于过滤）');
{
  const KEYS = ['filter', 'filtAvailable', 'filtAvailableHint', 'filtFree', 'filtFreeHint',
    'filtHint', 'filtCurrent', 'filtHiddenA', 'filtHiddenB', 'filtHiddenC'];
  for (const k of KEYS) {
    ok(typeof zh[k] === 'string' && zh[k].length > 0, `zh 有 ${k}`);
    ok(typeof en[k] === 'string' && en[k].length > 0, `en 有 ${k}`);
  }
  ok(/仅看可用/.test(zh.filtAvailable) && /仅看免费/.test(zh.filtFree), '中文标签就是「仅看可用 / 仅看免费」');
  ok(/Available only/.test(en.filtAvailable) && /Free only/.test(en.filtFree), '英文对应 Available only / Free only');
  /* 单一源 helper：两个下拉共用（与 groupedChannelOptions 同一条纪律） */
  ok(/const applyChanFilters = \(list\) => list\.filter\(/.test(src), '存在单一源 applyChanFilters');
  ok(/if \(filtAvailable && !c\.enabled\) return false;/.test(src), '「仅看可用」判据 = enabled');
  ok(/if \(filtFree && !isFreeChannel\(c\)\) return false;/.test(src), '「仅看免费」判据 = isFreeChannel');
  /* ⚠️ 中间可能夹注释块 ⇒ 用 `[\s\S]*?` 限定在同一函数体内，不要写"紧跟左花括号"。 */
  ok(/const groupedChannelOptions = \(current\) => \{[\s\S]{0,400}?const folded = foldChannels\(channels\);/.test(src)
    && /const kept = applyChanFilters\(folded\);/.test(src),
    '★ 通道下拉走 applyChanFilters（过滤真的接进渲染路径，不是死代码）');
  /* 默认值：可用=开（与改造前行为一致）、免费=关 */
  ok(/localStorage\.getItem\(filtStorageKey\.available\) !== '0'/.test(src), '「仅看可用」默认开（localStorage 缺省=true）');
  ok(/localStorage\.getItem\(filtStorageKey\.free\) === '1'/.test(src), '「仅看免费」默认关（localStorage 缺省=false）');
  /* "免费"的判据必须可核对：OpenCode 引擎 + Start Plan 账户通道 */
  ok(/c\.engine === 'opencode' \|\| FREE_CHANNEL_RE\.test\(id\)/.test(src), '"免费"判据 = opencode 引擎 或 account:*-start-plan');
  ok(/const FREE_CHANNEL_RE = \/\^account:\[a-z\]\+-start-plan\$\/;/.test(src), 'Start Plan 免费额度通道的正则（与 giftSel 同一形态）');
  /* 当前选中值必须始终可渲染（否则 <select value> 显示错值 —— ZB-31/ZB-33b 同类坑） */
  ok(/const curPinned = !!cur && !kept\.some\(\(c\) => c\.id === cur\.id\);/.test(src),
    '★ 被过滤掉的当前值仍会补进下拉（标注「当前选择」），不谎报成不可用');
  ok(/const list = kept\.some\(\(c\) => c\.id === current\) \|\| !current/.test(src),
    '当前值在保留集里时不重复补条目');
  /* 两个开关都挂在「通道」分区，且带 aria-pressed / title（可访问性 + 说明） */
  ok(/onClick: \(\) => toggleFilt\('available'\), 'aria-pressed': filtAvailable/.test(src), '「仅看可用」开关接线（aria-pressed）');
  ok(/onClick: \(\) => toggleFilt\('free'\), 'aria-pressed': filtFree/.test(src), '「仅看免费」开关接线（aria-pressed）');
  ok(/const filtStorageKey = \{ available: 'dispatch:filter:available', free: 'dispatch:filter:free' \};/.test(src)
    && /localStorage\.setItem\(filtStorageKey\[which\]/.test(src),
    '开关状态持久化到 localStorage（重开面板保留选择；键名集中在 filtStorageKey 单源）');
  ok(/filtHiddenA/.test(src) && /过滤已隐藏 /.test(zh.filtHiddenA), '过滤生效时明说隐藏了几个（不让用户误以为清单坏了）');
  /* 过滤是**纯展示层**：不得出现在 core/wire 调用里（不写状态、不影响调度） */
  const filtBlock = src.slice(src.indexOf('const applyChanFilters'), src.indexOf('const groupedChannelOptions'));
  ok(!/remote\.call|channelSet|fallbackSet/.test(filtBlock), '★ 过滤纯展示层：不发任何 remote 调用（离线可用、不改调度）');
}

/* ---------------- ⑥ 通道清单加载失败不再静默（真机事故修复） ---------------- */
console.log('\n⑥ 通道清单加载失败：失败可见 + 自动自愈（真机事故）');
{
  /* 事故现场（用户报告）：重启 DSH 后面板**三个下拉全显示「不可用：-」**。
   * 根因两条，缺一处症状都不成立：
   *   ① `channels()` 只在**挂载时拉一次**；`wire.client` 把失败包成 `{ok:false}`（不抛），
   *      而客户端的 `.then` 只处理 `ok` ⇒ **失败被静默丢弃、清单永远为空**；
   *   ② 没有任何重试 ⇒ 一次失败就"永久残废"，用户只能自己刷新。 */
  for (const k of ['chanLoading', 'chanLoadRetry']) {
    ok(typeof zh[k] === 'string' && zh[k].length > 0, `zh 有 ${k}`);
    ok(typeof en[k] === 'string' && en[k].length > 0, `en 有 ${k}`);
  }
  const loadBlock = src.slice(src.indexOf('const [chanError, setChanError]'), src.indexOf('const onSwitch = useCallback'));
  ok(/setChanError\(String\(\(r && r\.error\)/.test(loadBlock), '① ok:false 时记下 wire 的 error（不再静默）');
  ok(/\.catch\(\(e\) => \{ if \(alive\) setChanError/.test(loadBlock), '① 抛异常时也记下（两道都盖住）');
  ok(/!warnings\.length && chanError/.test(src) && /t\('chanLoadRetry'\)/.test(src),
    '① 面板渲染该 error 并说明"会自动重试"');
  ok(/const snapChans = Array\.isArray\(snapshot\?\.channels\) \? snapshot\.channels : null;/.test(src),
    '② 兜底读 snapshot.channels（快照载荷里本来就有通道清单）');
  ok(/prev\.channels\.length === 0 \? \{ channels: snapChans/.test(src),
    '★ ② 仅在"清单为空"时采纳（不用旧快照覆盖用户刚切后的权威值）');
  ok(/\}, \[snapshot\]\);/.test(src), '★ ② 依赖 snapshot ⇒ 每秒轮询带来新快照即可自愈');
  ok(/!warnings\.length && !chanError && channels\.length === 0/.test(src) && /t\('chanLoading'\)/.test(src),
    '③ 空清单且无错误 ⇒ 显示"加载中"（不误导成"没有可用通道"）');
}

/* ---------------- ⑦ 宿主侧：失败结果只用短 TTL（配合客户端自愈） ---------------- */
console.log('\n⑦ 宿主侧：通道清单失败结果短 TTL 缓存');
{
  const wireSrc = readFileSync(join(PKG, 'wire.host.mjs'), 'utf8');
  ok(/const CHANNELS_ERROR_TTL_MS = 1000;/.test(wireSrc), '失败结果短 TTL 常量存在（1s）');
  /* ZB-118：判据已抽成共享辅助函数（原先在 cachedChannels / channelsCached 各写一份三元表达式）。
   * 断言语义不变 —— 照样钉"空清单或有 warnings = 失败"与"失败 1s / 成功 5s"。 */
  ok(/const channelsCacheIsFailed = \(value\) =>[\s\S]{0,120}?\.length === 0 \|\| \(value\?\.warnings \?\? \[\]\)\.length > 0;/.test(wireSrc),
    '失败判据 = 空清单 或有 warnings');
  ok(/const channelsCacheTtl = \(value\) => \(channelsCacheIsFailed\(value\) \? CHANNELS_ERROR_TTL_MS : CHANNELS_TTL_MS\);/.test(wireSrc),
    '★ 失败走 1s、成功走 5s（失败不会被缓存满 5s）');
  /* 两条缓存路径都必须用同一判据（防一边改另一边没改） */
  ok((wireSrc.match(/channelsCacheTtl\(channelsCache\.value\)/g) ?? []).length >= 2,
    '★ cachedChannels 与 channelsCached 共用同一判据');
  ok(/engine: spec\?\.engine \?\? null/.test(wireSrc) && /auto: Boolean\(spec\?\.auto\)/.test(wireSrc),
    'slimJob 的 spec 也带 engine/auto（面板与工具读到同一份事实）');
}

/* ---------------- ⑧ 面板「有时没有进程」竞态修复（真机事故） ---------------- */
console.log('\n⑧ 进程列表/连接状态不再被慢探测拖死（真机事故）');
{
  /* 事故现场：面板「进程」有时显示"暂无进程记录"、标题栏卡在「连接中」。
   * 根因：面板 remote wire 是 `await remote.call('snapshot')` 之后才 emit 的，而宿主
   * `snapshot()` 内联 await 了**通道探测**（spawn 子进程，冷启 ~3s，缓存仅 5s）
   * ⇒ 那一刻探测一慢，整包快照就发不出去 ⇒ 进程/用量/开关全空白。 */
  const wireSrc = readFileSync(join(PKG, 'wire.host.mjs'), 'utf8');
  ok(/function cachedChannels\(\)/.test(wireSrc), '宿主有**只读缓存**的 cachedChannels()');
  ok(/if \(stale && channelsProbeInFlight == null\)/.test(wireSrc), '过期时**后台**刷新（不阻塞调用方）');
  ok(/channelsProbeInFlight = \(async \(\) => \{/.test(wireSrc), '探测去重（同一时刻只跑一次，不并发 spawn）');
  const snapFn = wireSrc.slice(wireSrc.indexOf('async snapshot() {'), wireSrc.indexOf('async quota()'));
  ok(snapFn.length > 0, '能定位 snapshot() 实现');
  /* ZB-51：快照现在把整个 `cachedChannels()` 结果取一次（`const cached = cachedChannels()`），
   * 因为除了 channels 还要带上 engineDetail。断言随之放宽为"同步取缓存、绝不 await 探测"。 */
  ok(/cachedChannels\(\)/.test(snapFn) && /cached\.channels/.test(snapFn), '★ 快照路径只读缓存（同步）');
  ok(!/await channelsCached\(\)/.test(snapFn), '★ 快照路径**绝不** await 通道探测（这正是卡死的成因）');
  ok(/cached\.engineDetail/.test(snapFn), '★ 引擎明细也随快照下发（面板状态条每轮都能刷新）');
  /* ZB-51 补：**两条取数路径都要带 engineDetail**，否则 Agent 用工具查通道时看不到引擎诊断。
   * （面板路径曾透传、工具路径漏了 —— 只有"重启后真的调用一次工具"才暴露。） */
  const actionCh = wireSrc.slice(wireSrc.indexOf("case 'channels':"), wireSrc.indexOf("case 'channel':"));
  ok(actionCh.length > 0, '能定位 action=channels 分支');
  ok(/engineDetail/.test(actionCh), '★ 工具路径 action=channels 也透传 engineDetail');

  /* ⚠️ 契约锁：`createActionHandler` 与 `createRemoteFace` 是**两个独立作用域**。
   * 曾在此犯过：在 action 处理器里写 `channelsCache = …`（那是另一个函数里的局部变量）
   * —— 运行时 ReferenceError，而 `node --check` **查不出来**（闭包内引用，语法合法）。
   * 这里用"花括号配平取函数体"把它钉死（不硬编码行号）。 */
  {
    const fnStart = wireSrc.indexOf('export function createActionHandler(');
    ok(fnStart >= 0, '能定位 createActionHandler');
    let depth = 0; let fnEnd = -1; let seen = false;
    for (let i = fnStart; i < wireSrc.length; i += 1) {
      const ch = wireSrc[i];
      if (ch === '{') { depth += 1; seen = true; } else if (ch === '}') { depth -= 1; if (seen && depth === 0) { fnEnd = i; break; } }
    }
    const body = fnEnd > fnStart ? wireSrc.slice(fnStart, fnEnd) : '';
    ok(body.length > 0, '能定位 createActionHandler 函数体');
    ok(!/channelsCache/.test(body), '★ action 处理器内不得引用 channelsCache（那是另一个函数的局部变量）');
    ok(/let channelsCache = null/.test(wireSrc), 'channelsCache 仍声明在 createRemoteFace 一侧');
  }
  ok(/async function channelsCached\(\)/.test(wireSrc), '通道下拉的权威取数仍在 channelsCached()（会 await，合理）');
  ok(/if \(channelsProbeInFlight\) \{\s*await channelsProbeInFlight;/.test(wireSrc), '并发调用复用同一次在途探测');
  /* 客户端三条防线 */
  ok(/const RPC_TICK_TIMEOUT_MS = 8000;/.test(src), '客户端单次 RPC 有兜底超时（8s）');
  ok(/const withTimeout = \(p, ms\) => new Promise/.test(src) && /remote\.call\('snapshot'\), RPC_TICK_TIMEOUT_MS/.test(src),
    '★ tick 的 snapshot 调用带超时（最坏发一包快照，轮询继续）');
  ok(/let lastGoodSnapshot = null;/.test(src) && /snapshot: lastGoodSnapshot, quota: null/.test(src),
    '★ 远端抖动时沿用**上一包好快照**（进程列表不会被清空成"暂无进程记录"）');
}

console.log(`\n===== 双引擎 UI 契约：${pass} PASS / ${fail.length} FAIL =====`);
if (fail.length) for (const m of fail) console.log(`  ✗ ${m}`);
process.exit(fail.length ? 1 : 0);
