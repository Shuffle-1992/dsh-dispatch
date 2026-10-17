/**
 * ZB-30 UI 渲染回归：自动降级开关 + 开启后的目标三下拉（**真渲染**，非源码正则）。
 *
 * 为什么需要它：`client.js` 是 cordis 客户端插件（依赖 React / 槽位），无法直接 import。
 * 源码正则（fallback-target.test.mjs 的 D 段）能钉住"写了什么"，但**测不出运行时是否抛错、
 * 关闭时是否真的不渲染**。这里用与 test/panel-style.test.mjs 同一套 DOM + React 桩真渲染一次，
 * 数据源走 ext wire（window.__dispatchDemo 对象），从而让 fallback 处于"已开启"态。
 *
 * 断言：
 *   ① 关闭态：只有开关按钮，**没有**目标三下拉
 *   ② 开启态：开关 aria-pressed=true + 指示灯用状态色；出现 3 个 select（通道/模型/思考强度）
 *   ③ 档位下拉的 option label 是中文（值仍是原始字符串）
 *   ④ 点开关 → 调用 fallbackSet(null) 关闭（wire 收到 null 而不是 ["null"]）
 */
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const SRC = 'F:\\My Code\\dsh-dispatch\\dispatch\\client.js';
const src = readFileSync(SRC, 'utf8');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log(`  ✓ ${m}`); };

/* ---------- DOM / React 桩（与 panel-style.test.mjs 同源，按需精简） ---------- */
const head = {
  children: [],
  appendChild(c) { c.parentNode = head; head.children.push(c); return c; },
  removeChild(c) { head.children = head.children.filter((x) => x !== c); c.parentNode = null; c.isConnected = false; return c; },
};
globalThis.document = {
  head, documentElement: { appendChild: () => {} },
  createElement: (t) => (t === 'style'
    ? { tagName: 'STYLE', attrs: {}, isConnected: true, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, textContent: '' }
    : { tagName: t.toUpperCase(), attrs: {}, setAttribute() {}, appendChild() {} }),
  getElementById: (id) => head.children.find((c) => c.attrs && c.attrs.id === id) ?? null,
  querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {},
};
const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };

/* ext wire：window.__dispatchDemo 是**对象**（有 getSnapshot）⇒ extWire（conn='ext'）。
 * 它把方法名透传到 ext[name] —— 故这里直接给 channels/channel/fallback 三个方法。 */
const fallbackCalls = [];
const CHANNELS = [
  /* ⚠️ ZB-52：面板现在**按选中模型过滤档位**（用户要求「思考强度没有按模型过滤好」）——
   * 当前选中项是 `plan::GLM-5.3` ⇒ 上方「思考强度」取的是**该通道**的档位集，不再是引擎并集。
   * 故这里给 `plan` 四档，让"档位中文标签"与"降级区两侧一致"两条断言有可验内容。 */
  { id: 'plan', name: '默认套餐', enabled: true, reason: null, models: ['GLM-5.3', 'GLM-5.3-Flash'], thinkingLevels: ['disabled', 'low', 'high', 'max'] },
  /* ZB-51：ZCode 白名单**只留 plan 与免费额度**，故 fixture 必须用这两条的真实形状
   * （原先用的 `personal`/`builtin:*` 已被白名单剔除 ⇒ 折叠后两侧选项集不一致，测试失去意义）。 */
  { id: 'account:bigmodel-start-plan', name: '免费额度（Start Plan）', enabled: true, reason: null, models: ['GLM-5.3', 'GLM-5.3-Flash'], thinkingLevels: ['disabled', 'low', 'high', 'max'] },
  /* ZB-33b：**不可用通道**（真实形状：runner 会给出 enabled=false + reason）——
   * 用于断言"下拉里不再列出不可用项"。它现在**不在白名单内**（core 会剔除），
   * 但本测试直接喂给面板（不过 core），故仍能验证"面板不列不可用项"。 */
  { id: 'builtin:zai-coding-plan', name: 'Z.ai - Coding Plan', enabled: false, reason: 'oauth_provider_inactive', models: ['GLM-5.3'], thinkingLevels: ['low', 'high', 'max'] },
];
const EXT = {
  getSnapshot: () => ({ generatedAt: 'x', counts: { running: 0, queued: 0 }, jobs: [], locks: {}, queue: [] }),
  getQuota: () => null,
  channels: async () => ({ ok: true, channels: CHANNELS, warnings: [] }),
  channel: async () => ({ ok: true, channel: { provider: 'plan', model: 'GLM-5.3', reasoningLevel: 'agent' } }),
  fallback: async (arg) => {
    fallbackCalls.push(arg);
    if (arg && arg.chain === null) return { ok: true, enabled: false, chain: [], targets: [], target: null };
    return {
      ok: true, enabled: true, chain: ['plan'],
      targets: [{ provider: 'plan', model: 'GLM-5.3', reasoningLevel: 'high' }],
      target: { provider: 'plan', model: 'GLM-5.3', reasoningLevel: 'high' },
    };
  },
};
let captured = null;
globalThis.window = {
  __ModuleLoader__: { load: (o) => { captured = o; } },
  __dispatchDemo: EXT,
  localStorage: globalThis.localStorage, innerHeight: 900, innerWidth: 1200,
  addEventListener: () => {}, removeEventListener: () => {},
};
await import('file:///F:/My Code/dsh-dispatch/dispatch/client.js');

const el = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() });
const cellStore = new Map();
let cur = null;
const pendingEffect = [];
const React = {
  createElement: el, Fragment: 'Fragment',
  Component: class { constructor(p) { this.props = p ?? {}; this.state = {}; } setState(n) { this.state = { ...this.state, ...(typeof n === 'function' ? n(this.state) : n) }; } },
  useState: (v) => { const c = cur.cells; const i = cur.idx++; if (c[i] === undefined) c[i] = typeof v === 'function' ? v() : v; return [c[i], (nv) => { c[i] = typeof nv === 'function' ? nv(c[i]) : nv; }]; },
  useEffect: (fn) => { const i = cur.idx++; if (!cur.effects.has(i)) { cur.effects.set(i, true); pendingEffect.push(fn); } },
  useLayoutEffect: (fn) => { const i = cur.idx++; if (!cur.effects.has(i)) { cur.effects.set(i, true); pendingEffect.push(fn); } },
  useRef: (v) => { const i = cur.idx++; if (!(i in cur.cells)) cur.cells[i] = { current: v }; return cur.cells[i]; },
  useCallback: (f) => f, useMemo: (f) => (typeof f === 'function' ? f() : f), useSyncExternalStore: () => undefined,
};
const expand = (node, path) => {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n, i) => expand(n, `${path}.${i}`));
  const kids = (node.children ?? []).map((c, i) => expand(c, `${path}.${i}`));
  const type = node.type;
  const props = { ...node.props, children: kids.length <= 1 ? kids[0] : kids };
  if (typeof type === 'function' && type.prototype && typeof type.prototype.render === 'function') {
    const inst = new type(props); inst.props = props; return expand(inst.render(), `${path}~${type.name}`);
  }
  if (typeof type === 'function') {
    const key = `${path}~${type.name || 'anon'}`;
    if (!cellStore.has(key)) cellStore.set(key, { cells: [], deps: new Map(), effects: new Map() });
    const prev = cur; cur = cellStore.get(key); cur.idx = 0;
    let out; try { out = type(props); } finally { cur = prev; }
    return expand(out, key);
  }
  return { ...node, children: kids };
};
const regs = [];
const mod = captured.factory((n) => (n === 'react' ? React : {}));
mod.apply({
  slots: { inject: (k, cb) => { cb(); return () => {}; }, register: (o, comp) => { regs.push({ o, comp }); return () => {}; } },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  on: () => () => {}, locale: { formatMessage: (m) => String(m?.id ?? m) },
  remote: { $mount: () => Promise.resolve() },
});

/* 渲染入口：open=true 时点一次让它展开；随后把挂起的 effect 全部跑掉（wire 订阅 → ext 同步发一包）。 */
const render = (open) => {
  let t = expand(regs[0].comp({}), 'hdr');
  if (open) {
    let chip = null;
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.type === 'button' && typeof n.props?.className === 'string' && n.props.className.includes('dsp-chip')) chip = n;
      walk(n.children);
    };
    walk(t);
    if (chip) chip.props.onClick();
  }
  t = expand(regs[0].comp({}), 'hdr');
  while (pendingEffect.length) pendingEffect.shift()();
  return t;
};
/* 找出分区里的所有 select / 开关按钮 */
const collect = (tree) => {
  const selects = []; const buttons = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === 'select') selects.push(n);
    if (n.type === 'button') buttons.push(n);
    walk(n.children);
  };
  walk(tree);
  return { selects, buttons };
};
/* option 的 children 在桩里是数组（el 把 children 展平后仍包一层）——统一折成字符串标签。
 * 双引擎（OpenCode 接入）：通道下拉现在按引擎包了一层 `optgroup`，故这里**展开 optgroup**
 * 再取 option —— 否则断言会以为下拉是空的（本文件曾经现场踩过这个坑，故抽成单一 helper）。 */
const flattenOptions = (sel) => (sel.children ?? []).flatMap((c) => {
  if (!c || typeof c !== 'object') return [];
  if (c.type === 'optgroup') return (c.children ?? []).filter((x) => x && x.type === 'option');
  return c.type === 'option' ? [c] : [];
});
const optLabels = (sel) => flattenOptions(sel)
  .map((c) => (Array.isArray(c.children) ? c.children.join('') : String(c.children ?? '')));

/* 分区默认「通道」是收起的（SEC_DEFAULT_OPEN.channel=false）——本测试要渲染通道分区，
 * 故先把它置为展开（Section 的初值读 localStorage['dispatch:section:channel']）。 */
ls.set('dispatch:section:channel', 'true');

/* ---------- ① 首帧（ext 的 fallback 返回 enabled=true，但 effect 跑完才进 state） ---------- */
let tree = render(true);
let { selects, buttons } = collect(tree);
/* 找「自动降级」那个开关：面板里现在有**多个** .dsp-toggle（用户新增的通道过滤开关也是这个类），
 * 故按**标签文本**取（降级开关的文案以 fallbackTitle 开头），不靠"第一个"这种脆弱判据。 */
const toggleOf = (b) => b.find((x) => typeof x.props?.className === 'string' && x.props.className.includes('dsp-toggle')
  && String((x.children ?? []).join('')).includes('自动降级'));

/* 首帧 effect 尚未跑 → fallback 初值 {enabled:false} ⇒ 只有开关、没有目标下拉。
 * （这一步同时证明"关闭时不显示"。） */
ok(selects.length === 3, `关闭态只有「通道」分区的 3 个下拉（实际 ${selects.length}）`);
ok(!!toggleOf(buttons), '① 关闭态已渲染降级开关按钮');
ok(toggleOf(buttons).props['aria-pressed'] === false, '① 关闭态 aria-pressed=false');
const dotOf = (btn) => (btn.children ?? []).find((c) => c && typeof c.props?.className === 'string' && c.props.className.includes('dsp-dot'));
ok(!!dotOf(toggleOf(buttons)), '① 开关带指示灯（.dsp-dot）');
ok(String(dotOf(toggleOf(buttons)).props.style.background).includes('state-error'), '① 关闭态指示灯用错误/危险状态色令牌（非字面色值）');

/* ---------- ② effect 跑完（fallbackGet 返回 enabled=true）→ 重渲染 ---------- */
await new Promise((r) => setTimeout(r, 30));
tree = render(false);
({ selects, buttons } = collect(tree));
const toggle = toggleOf(buttons);
ok(!!toggle && toggle.props['aria-pressed'] === true, '② 开启态 aria-pressed=true');
ok(String(dotOf(toggle).props.style.background).includes('state-success'), '② 开启态指示灯用成功状态色令牌');
ok(selects.length === 6, `② 开启后出现目标三下拉（通道/模型/思考强度 ⇒ 共 6 个，实际 ${selects.length}）`);
/* 本测试让**上面「通道」与下面降级目标选中同一个通道**（personal/deepseek-flash）——
 * 这样"选项逻辑完全一致"可以用「两侧 option 列表逐字相等」直接证明。 */
const labels = selects.flatMap(optLabels);
/* ⚠️ 档位选项跟随**当前选中路由**：本 fixture 的两条 ZCode 路由都是 GLM-5.3 系（low/high/max 三档），
 * 故断言"档位渲染成中文、且至少出现低/高强度"。四档（关闭/开启思考）语义由
 * `thinking-level.test.mjs` 覆盖（原先这里依赖 personal/deepseek 通道，而它已被白名单剔除）。 */
ok(labels.includes('低强度') && labels.includes('高强度'),
  `③ 档位 option 中文标签（实际标签：${JSON.stringify(labels)}）`);
ok(!labels.some((l) => ['disabled', 'enabled', 'low', 'high', 'max'].includes(l)),
  '★ 档位在 UI 上**只出现中文**（原始字符串仅作为 option value 传输）');
/* ★ ZB-51（用户要求）：ZCode 的模型下拉必须列出**具体模型**
 * （"原本是有 GLM5.3 和 GLM5.3 Flash 的"），且免费额度只列它真正提供的模型
 * （用户实测：Start Plan 只给 GLM-5.3-Flash）。 */
ok(labels.includes('GLM-5.3'), '★ ZCode 模型下拉含 GLM-5.3（套餐）');
ok(labels.includes('GLM-5.3-Flash'), '★ ZCode 模型下拉含 GLM-5.3-Flash（套餐）');
ok(labels.includes('GLM-5.3-Flash「免费」'), '★ 免费额度列 GLM-5.3-Flash 并标「免费」（与套餐项不混淆）');
ok(!labels.includes('GLM-5.3「免费」'), '★ 免费额度**不该**出现 GLM-5.3（Start Plan 只给 Flash）');
ok(selects.some((s) => flattenOptions(s).some((c) => c.props.value === 'high')),
  '③ option value 仍是原始档位字符串（high）—— 中文只在 label');
ok(labels.includes('（通道默认模型）') && labels.includes('Agent决定（按任务判断）'),
  '★ 模型/档位首项与上面「通道」分区**逐字一致**（通道默认模型 / Agent决定）');
/* ZB-30b（用户要求「不要沿用原任务，就跟上面完全一致的选项逻辑」）：作用域取后 3 个下拉。 */
const fbSelects = selects.slice(3);
const fbLabels = fbSelects.flatMap(optLabels);
ok(fbLabels.includes('Agent决定（按任务判断）'),
  '★ 降级档位下拉首项 = Agent决定（与上面「通道」分区同一套选项逻辑）');
ok(!fbLabels.some((l) => l.includes('沿用原任务')),
  '★ 降级目标下拉里不再出现「沿用原任务…」（用户明确要求去掉）');
/* 两个分区的选项集**逐项相等**：这是"完全一致"的硬证据。
 * ⚠️ ZB-51 收窄：**通道 + 模型两个下拉必须逐字相同**；
 * 档位下拉允许一处**合法差异** —— 降级区会为"存值里的失效档位"额外列一项（`XX（已失效）`），
 * 那是 ZB-31 的既定行为（显式列出真相，避免 select 掉到首项显示成 Agent决定）。
 * 故档位改为断言"两侧都包含对方的基础档位"，而不是要求逐字相等。 */
const chanLabels = selects.slice(0, 3).flatMap(optLabels);
/* ZB-51：**通道下拉必须逐字相同**；模型下拉允许**一处刻意差异**（用户要求）：
 *   上面「模型」首项 = `Agent决定`（值 ''，不绑定模型、派发 Agent 可自选并随时更换）；
 *   降级区「模型」首项 = `（通道默认模型）`（值 ''）—— 降级是自动触发的，那一刻没有 Agent 在决定。
 * 除此之外模型项必须一致。 */
const chanSel = selects.slice(0, 1).flatMap(optLabels);
const fbChanSel = selects.slice(3, 4).flatMap(optLabels);
ok(JSON.stringify(fbChanSel) === JSON.stringify(chanSel),
  `★ 降级「通道」下拉与上方逐字相同（实际 ${JSON.stringify(fbChanSel)}）`);
const chanModel = selects.slice(1, 2).flatMap(optLabels);
const fbModel = selects.slice(4, 5).flatMap(optLabels);
/* ZB-52（用户要求）：首项由「Agent决定」**改名**为「顺序派发」——
 * 语义：不绑定模型（值 ''）⇒ 按顺序列表从上到下尝试，报错换下一个。
 * ⚠️ 开关未开时该选项**置灰**并追加「（需先开启）」（如实告知怎么生效，不静默误导）。 */
ok(/^顺序派发/.test(chanModel[0] ?? ''),
  `★ 上面「模型」首项 = 顺序派发（实际 ${JSON.stringify(chanModel[0])}）`);
ok(fbModel[0] === '（通道默认模型）', `★ 降级「模型」首项 = 通道默认模型（实际 ${JSON.stringify(fbModel[0])}）`);
ok(JSON.stringify(chanModel.slice(1)) === JSON.stringify(fbModel.slice(1)),
  `★ 除首项外，模型项两侧一致（上 ${JSON.stringify(chanModel.slice(1))} / 降 ${JSON.stringify(fbModel.slice(1))}）`);
const thinkingOf = (list) => list.filter((l) => l.startsWith('关闭思考') || l.startsWith('开启思考') || l.startsWith('低强度') || l.startsWith('高强度') || l.startsWith('最高强度'));
const chanTh = thinkingOf(chanLabels);
const fbTh = thinkingOf(fbLabels);
ok(chanTh.every((l) => fbTh.includes(l)) && fbTh.every((l) => chanTh.includes(l) || l.includes('已失效')),
  `★ 档位选项两侧一致（上方 ${JSON.stringify(chanTh)} / 降级 ${JSON.stringify(fbTh)}；降级允许多一项"已失效"）`);

/* ---------- ④ 点开关 → 关闭（wire 收到 null） ---------- */
const before = fallbackCalls.length;
toggle.props.onClick();
await new Promise((r) => setTimeout(r, 20));
ok(fallbackCalls.length === before + 1, '④ 点击开关触发一次 fallback 写入');
ok(fallbackCalls[fallbackCalls.length - 1].chain === null, '★ 关闭时 wire 收到 chain:null（不是 ["null"] 的旧缺陷）');
tree = render(false);
({ selects } = collect(tree));
ok(selects.length === 3, `④ 关闭后目标下拉消失（回到 3 个，实际 ${selects.length}）`);

/* ---------- ⑤ demo 数据源同样走新形状（它是 `window.__dispatchDemo='builtin'` 时的路径） ----------
 * 单独跑一遍：把 flag 换成 'builtin' 会走 demoWire，其 fallbackGet/Set 用的是内联 normTargets/fallbackShape。
 * 这里直接对源码做形态断言即可（真渲染两条路径已在 ①–④ 覆盖 ext；demo 的语义由 core 测试 A/C 覆盖）。 */
ok(/async fallbackGet\(\) \{\s*return \{ ok: true, \.\.\.fallbackShape\(demoTargets\) \};\s*\}/.test(src),
  '⑤ demo 数据源的 fallbackGet 用同一 fallbackShape（新形状）');
ok(/async fallbackSet\(target\) \{\s*demoTargets = normTargets\(target\);/.test(src),
  '⑤ demo 数据源的 fallbackSet 用同一 normTargets（对象/数组/null 三形状一致）');
ok(/let demoTargets = \[\];/.test(src) && !/let demoChain/.test(src), '⑤ 旧的 demoChain 已彻底替换（不留死变量）');

/* ---------- ⑥ 面板写值 = 下拉显示值（不落 CLI 侧的 null「沿用原任务」） ---------- */
{
  const modelSel = fbSelects[1];
  const n0 = fallbackCalls.length;
  modelSel.props.onChange({ target: { value: '' } }); // 选「（通道默认模型）」
  await new Promise((r) => setTimeout(r, 20));
  ok(fallbackCalls.length === n0 + 1, '⑥ 改模型触发一次写入');
  const wrote = fallbackCalls[fallbackCalls.length - 1].chain;
  ok(wrote.model === null, '⑥ 模型选「（通道默认模型）」⇒ 写 null（交接时不传 --model）');
  /* ★ 核心不变量：**写什么 = 下拉显示什么**。stub 存的是 reasoningLevel:'high'（下拉显示「高强度」），
   * 故只改模型也必须把 'high' 一起写回 —— 不能被 null/空值悄悄改写。 */
  ok(wrote.reasoningLevel === 'high',
    `★ 只改模型时档位按**下拉显示值**写回（实际 ${JSON.stringify(wrote.reasoningLevel)}）`);
  /* 旧存值 reasoningLevel=null（CLI 侧的「沿用原任务」）在面板里显示为「Agent决定」；
   * 面板一编辑即按显示值归一成 'agent' —— 由源码不变量保证（base 不读 fbTarget.reasoningLevel）。 */
  ok(!/reasoningLevel: fbTarget\?\.reasoningLevel \?\? null/.test(src),
    '★ saveTarget 的 base 不读存值（否则「显示 Agent决定、实存 null」两回事）');
  ok(/reasoningLevel: fbThinking \|\| 'agent'/.test(src),
    '★ saveTarget 的 base 用下拉显示值，未设时落 agent');
}

/* ---------- ⑦ ZB-33b（用户要求）：「不可用通道不再显示」 ----------
 * 场景：CHANNELS 里有一条 enabled=false 的真实形状通道（Z.ai - Coding Plan / oauth_provider_inactive）。
 * 断言：通道下拉与降级目标下拉**都不列出它**（既不在 label，也不在 value）；可用项仍在。
 * 例外（源码形态）：当前选中值若掉线，仍需单独补一条并标注「不可用：原因」，
 * 否则 <select value> 匹配不到 option 会显示首项（与真实存值不符，ZB-31 同类坑）。 */
{
  const allProvLabels = selects.flatMap(optLabels);
  ok(!allProvLabels.some((l) => l.includes('Z.ai - Coding Plan')),
    '⑦ 不可用通道不出现在任何下拉的 label 里');
  /* 主通道下拉（当前渲染）与降级目标下拉（③ 段捕获的快照，那时降级是开启态）——
   * 本段跑到这里时降级已被 ④ 关掉，故降级侧用快照。 */
  const providerSels = [selects[0], fbSelects[0]].filter(Boolean);
  ok(providerSels.length === 2, `⑦ 主通道 + 降级目标两个 provider 下拉都被检查（实际 ${providerSels.length}）`);
  for (const s of providerSels) {
    const vals = flattenOptions(s).map((c) => c.props.value);
    ok(!vals.includes('builtin:zai-coding-plan'), '⑦ 不可用通道不在 option value 里');
      /* ZB-51：折叠后通道下拉的 option value 是**引擎名**（`zcode`），不再是原始路由 id。
     * 原始路由 id 改在「模型」下拉里出现（`plan` / `account:bigmodel-start-plan`）。 */
    ok(vals.includes('zcode'), `⑦ 可用通道仍在（折叠后为 zcode；实际 ${JSON.stringify(vals)}）`);
    ok(!vals.includes('personal'), '★ 白名单外的 personal 不在清单里（core 已剔除）');
  }
  /* 通道过滤（用户新增）把"当前值掉线补一条"抽成了 pinnedReasonText + _reasons，
   * 语义不变（掉线仍标注不可用原因、且不静默显示首项）⇒ 断言跟着形态改名。 */
  ok(/const pinnedReasonText = \(c\) =>/.test(src) && /_reasons: \[pinnedReasonText\(cur\)\]/.test(src),
    '⑦ 源码形态：当前值掉线时会单独补一条（标注不可用），不静默显示首项');
  /* 双引擎（OpenCode 接入）：原先的单一源 `channelOptionsFor` / `usableChannels` 改名为
   * `groupedChannelOptions`（按引擎 optgroup 分组）；用户新增的两个过滤开关又把它内部
   * 统一到 `applyChanFilters`。**"两个下拉共用同一份过滤"这一不变量必须保留** ——
   * 故断言跟着改名，语义不变（谁再各写一份过滤立刻红）。 */
  ok(/const applyChanFilters = \(list\) => list\.filter\(/.test(src) && /const groupedChannelOptions = \(current\)/.test(src),
    '⑦ 源码形态：两个下拉共用同一份过滤（单一源 applyChanFilters + groupedChannelOptions）');
  ok((src.match(/groupedChannelOptions\(/g) ?? []).length >= 2,
    '⑦ 源码形态：定义 1 处 + 主通道与降级目标共用同一函数（实际调用面 ≥2）');
}

console.log(`\n===== ZB-30 UI 渲染：${pass} PASS / 0 FAIL =====`);
process.exit(0);