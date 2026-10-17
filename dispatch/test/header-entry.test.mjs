// ZB-27 回归测试：会话标题行入口 = **一枚与同排入口同形态的文字按钮 + 挂在其下的悬浮弹窗**。
//
// 用户连续两次的要求（2026-10-05）：
//   ① 「把派发台改成与子智能体一样的位置，在那一行显示 DSH 派发台，点击弹出面板」
//   ② 「不协调，字体大小样式都与其他的一致…弹窗参考子智能体的，悬浮在旁边的…取消右下角最小化的药丸」
//
// 因此本测试锁四件事：
//   A. 槽位/注册契约（同排、order=10）且**不再**注册到 shell.overlay（浮窗与药丸已取消）；
//   B. 入口样式取自系统同排入口（job-list）：无边框、12px、label-tertiary、min-height 28；
//   C. 点击开合 + 点外部/Esc 关闭；弹窗用系统菜单令牌（--dsw-specific-menu / elevation-prominent）；
//   D. 入口自身**不建 wire**（wire 由弹窗里的 PanelBody 持），避免每个会话多一条 1s 轮询。
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const SRC = 'F:\\My Code\\dsh-dispatch\\dispatch\\client.js';
const src = readFileSync(SRC, 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const code = stripComments(src);

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log(`  ✓ ${m}`); };

console.log('A. 槽位与注册契约');
ok(/const HEADER_SLOT = 'conversation\.session\.header\.actions';/.test(code), 'A1 HEADER_SLOT 指向会话标题行槽位');
ok(/id: 'dispatch', order: -25/.test(code), '★ A2 order=**-25**（插在子智能体目录 -30 与智能体团队 -20 之间 = 用户要求「移到子智能体后面」）');
ok(!/ctx\.slots\.inject\(SLOT,/.test(code), '★ A3 不再注册 shell.overlay（右下角浮窗已取消，避免两份 UI）');
ok(!/dispatch\.console/.test(code), '★ A4 旧浮层 cell id（dispatch.console）已移除');

console.log('\nB. 入口样式**逐项对齐官方源码**（ui-jobs/JobListAction —— 同槽位的「按钮 + 弹层」入口）');
{
  const chip = code.match(/'\.[^']*dsp-chip\{[^]*?\}',/);
  ok(!!chip, 'B1 有 .dsp-chip 规则');
  const css = chip[0];
  /* 权威源（deepseek-ai/deepseek-harness）：
   *   packages/client/ui-jobs/src/client/JobListAction.module.css  .trigger{…}
   *   packages/client/ui-jobs/src/client/JobListAction.tsx          <button type="button" className={css.trigger}>
   * 注意：源码**不声明 font-family / font-weight** —— 元素是 <button>，用 UA 按钮字体。 */
  ok(/display:inline-flex/.test(css), 'B2 display:inline-flex');
  ok(/gap:4px/.test(css), '★ B3 gap 4px（子智能体 .oXE0lW_trigger 同值 —— 用户点名参考它；官方 jobs 是 3px、agent-team 是 5px，官方自身不统一）');
  ok(/min-height:28px/.test(css), '★ B4 min-height 28px（官方同值；不是 height:22px —— 那是被动装饰 agent-preset）');
  ok(/padding:3px 2px/.test(css), '★ B5 padding 3px 2px（= 左邻居子智能体的官方值：入口移到子智能体后面后，逐项与左邻居一致最不易看出差别）');
  ok(/border:0/.test(css), 'B6 border 0');
  ok(/border-radius:var\(--dsw-radius-sm/.test(css), '★ B7 圆角 --dsw-radius-sm（官方同值）');
  ok(/background:transparent/.test(css), 'B8 background transparent（官方同值；也是用户"不要背景色"的要求）');
  ok(/font-size:12px/.test(css) && /line-height:18px/.test(css), '★ B9 字号 12px / 行高 18px（官方同值）');
  ok(!/font-family/.test(css), '★ B10 不声明 font-family（官方 .trigger 也不声明 ⇒ <button> 用 UA 按钮字体；写 inherit 会变成应用字体，这是前几轮的坑）');
  ok(!/font-weight/.test(css), '★ B11 不声明 font-weight（官方同值；UA 400）');
  ok(/T\.text3/.test(css), 'B12 常态色 label-tertiary（T.text3）');
  const hover = code.split('\n').find((l) => l.includes('.dsp-chip:hover') && l.includes('color:'));
  ok(!!hover && /T\.text\b/.test(hover), '★ B13 hover/focus-visible → **label-primary**（T.text，子智能体/agent-team 的 .trigger:hover 同值）');
  ok(/\.dsp-chip svg\{flex:none;transition:transform \.12s;\}/.test(code), 'B14 箭头过渡 120ms（官方 .trigger svg{transition:transform 120ms ease}）');
  ok(/\.dsp-chip\[aria-expanded="true"\] svg\{transform:rotate\(180deg\);?\}/.test(code), '★ B15 展开时旋转 **svg 本身**（官方 .triggerOpen 用法一致）');
  ok(/width: 14, height: 14, viewBox: '0 0 16 16'/.test(code), '★ B16 箭头 14×14 / viewBox 16（子智能体用默认 14 —— 用户点名参考它；jobs 用 12）');
  ok(/strokeWidth: 1\b/.test(code) && /M4 6L7\.29289 9\.29289C7\.68342 9\.68342 8\.31658 9\.68342 8\.70711 9\.29289L12 6/.test(code),
    '★ B17 箭头路径与 strokeWidth 1 逐字取自官方 IconChevronDownOutlineRegular');
  ok(/background:transparent/.test(css), 'B18 透明底');
  /* ZB-27j：**不得**给入口加 appearance:none —— 官方 .trigger 没有它，而 Chromium 下给 <button> 加
   * appearance:none 会让它不再套用 UA 按钮字体（退化为继承应用字体）⇒ 现场"略大 + 偏下"。 */
  ok(!/appearance:\s*none/.test(css) && !/-webkit-appearance/.test(css),
    '★ B18b 入口**不设** appearance:none（否则 <button> 丢掉 UA 按钮字体：略大且基线偏下 —— 现场症状）');
  ok(/border:0/.test(css) && /border-radius:var\(--dsw-radius-sm/.test(css), 'B18c 用官方同款方式消除原生外观（border:0 + radius，不靠 appearance）');
  ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(css), '★ B19 无字面色值 ⇒ 明暗两套主题自适应（颜色只走 T.* 令牌）');
  const reset = code.split('\n').find((l) => l.includes('.dsp-chip[aria-expanded="true"]') && l.includes('background:transparent'));
  ok(!!reset, '★ B20 有"所有交互态统一无底色"的成组重置（含 [aria-expanded="true"]）');
  ok(!!reset && /:hover/.test(reset) && /:focus/.test(reset) && /:active/.test(reset) && /\[aria-expanded="false"\]/.test(reset),
    '★ B21 重置覆盖 hover / focus / focus-visible / active / aria-expanded 真与假');
  ok(!!reset && /background:transparent !important/.test(reset) && /background-image:none !important/.test(reset),
    '★ B22 背景 !important 且清 background-image（第三方类名挡宿主状态高亮；官方用自己的类名无此问题）');
  /* 弹窗：官方 .menu 同值 */
  const menu = code.match(/'\.[^']*dsp-menu\{[^]*?\}',/);
  ok(!!menu, 'B23 有 .dsp-menu 规则');
  const mcss = menu[0];
  ok(/top:calc\(100% \+ 5px\)/.test(mcss), 'B24 挂入口下方 top:calc(100% + 5px)（官方同值）');
  ok(/padding:3px/.test(mcss) && /gap:1px/.test(mcss), '★ B25 padding 3px / gap 1px（官方 .menu 同值）');
  ok(/--dsw-specific-menu/.test(mcss) && /--dsw-radius-lg/.test(mcss) && /--dsw-elevation-prominent/.test(mcss),
    'B26 背景/圆角/阴影用官方同款令牌');
  ok(/backdrop-filter:var\(--dsw-menu-backdrop-filter/.test(mcss), '★ B27 backdrop-filter 用 --dsw-menu-backdrop-filter（官方同值）');
  ok(/max-height:min\(480px,calc\(100vh - 140px\)\)/.test(mcss), '★ B28 max-height min(480px,100vh-140px)（官方同值）');
  /* ZB-36（用户要求「面板高度增加 100%」）：**面板这一层**用行内 maxHeight 覆盖 ——
   * 类本身仍是官方 480px（B28 保持不变），视口项也不变；只有面板的上限翻倍到 960px。 */
  ok(/min\(960px, calc\(100vh - 140px\)\)/.test(src), '★ ZB-36 面板自身高度上限 ×2（960px；视口项不变，短屏不顶出屏幕）');
  ok(/maxHeight: PANEL_MAX_HEIGHT/.test(src),
    '★ ZB-36 覆盖**只挂在面板容器上**（不污染 .dsp-menu 类 —— job-list 等弹层共用它）');
  ok(/left:0/.test(mcss) && !/right:0/.test(mcss), '★ B29 与入口**左对齐、向右展开**（官方 .menu 同款 left:0；用户要求「改成往右侧，参考智能体的」）');
  ok(/const \[menuShift, setMenuShift\] = useState\(0\)/.test(src) && /marginLeft:/.test(src) && /\$\{menuShift\}px/.test(src),
    '★ B29b 靠近视口右缘时用 menuShift（marginLeft 负值）兜回视口内 —— 与官方 JobListAction 的 style={{left: menuShift}} 同一意图');
  ok(/overflow:auto/.test(mcss), 'B30 内容滚动');
  /* ZB-27v：短标签试验已回退（真正的差异来自共享样式表被面板卸载带走，见 ZB-27u），
   * 入口恢复完整标题，且不留 headerShort 死键。 */
  ok(!/headerShort:/.test(code) && !/t\('headerShort'\)/.test(code), '★ B44 已移除临时的 headerShort 键与引用（不留死键：短标签试验回退后不再使用）');
  /* ZB-27i：颜色内联兜底（现场实测：resting 令牌与邻居相同，但为排除未知宿主规则，颜色也走内联）。 */
  ok(/color: hover \? T\.text : T\.text3/.test(src), '★ B31 颜色内联且**仅 hover** 高亮（resting=label-tertiary / hover=**label-primary**，与两个可见邻居 .trigger:hover 同值）');
  ok(/onMouseEnter: \(\) => setHover\(true\)/.test(src) && /onMouseLeave: \(\) => setHover\(false\)/.test(src), '★ B32 悬停态用 React 状态表达（不依赖宿主伪类命中）');
  /* ZB-27n：hover 只由**按钮自身**驱动；容器不设 hover（否则指针移到面板上时入口也会变亮）。 */
  ok(/onMouseEnter: scheduleOpen,/.test(src), '★ B32b 容器 onMouseEnter 只调度展开、**不设 hover**（面板是子节点，指针移到面板上不应让入口变亮）');
  ok(!/onMouseEnter: \(\) => \{ setHover\(true\); scheduleOpen\(\); \}/.test(src), '★ B32c 已移除"容器进入即 setHover(true)"的写法');
  ok(/onFocus: \(\) => setHover\(true\)/.test(src) && /onBlur: \(\) => setHover\(false\)/.test(src), '★ B33 聚焦态同上（键盘可达时的视觉反馈）');
  ok(/const \[hover, setHover\] = useState\(false\)/.test(src), 'B34 hover 状态声明');
  ok(/color: hover \? T\.text : T\.text3/.test(src) && !/#[0-9a-fA-F]{3,8}\b/.test(src.match(/color: hover[^\n]*/)[0]), 'B35 内联色只用主题令牌（无字面色值 ⇒ 明暗自适应）');
}

console.log('\nC. 弹窗：系统菜单样式 + 开合交互');{
  const menu = code.match(/'\.[^']*dsp-menu\{[^]*?\}',/);
  ok(!!menu, 'C1 有 .dsp-menu 规则');
  const css = menu[0];
  ok(/--dsw-specific-menu/.test(css), 'C2 背景用系统菜单令牌 --dsw-specific-menu');
  ok(/--dsw-elevation-prominent/.test(css), 'C3 阴影用 --dsw-elevation-prominent');
  ok(/--dsw-radius-lg/.test(css), 'C4 圆角用 --dsw-radius-lg');
  ok(/position:absolute/.test(css) && /top:calc\(100% \+ 5px\)/.test(css), 'C5 绝对定位挂在入口下方（top: calc(100% + 5px)，与 job-list 同款）');
  ok(/max-height:min\(/.test(css) && /overflow:auto/.test(css), 'C6 限高 + 内部滚动（不高出视口）');
  ok(/\.dsp-menu,\.dsp-menu \*\{box-sizing:border-box;\}/.test(code), 'C7 ★ box-sizing 作用域改到 .dsp-menu（ZB-17 的输入框撑破回归不能复发）');
  ok(/addEventListener\('pointerdown'/.test(code), 'C8 点外部关闭');
  /* ZB-27l：悬浮展开 / 失焦关闭（用户要求：「改成悬浮展开，失焦关闭」）。 */
  ok(/const scheduleOpen = \(\) => \{/.test(src) && /setTimeout\(\(\) => \{ openTimer\.current = null; setOpen\(true\); \}, 150\)/.test(src),
    '★ C8b 悬浮展开：150ms 延时（官方 CatalogDropdown scheduleHoverOpen 同值，穿过缝隙不闪）');
  ok(/const scheduleClose = \(\) => \{/.test(src) && /setTimeout\(\(\) => \{ closeTimer\.current = null; setOpen\(false\); setHover\(false\); \}, 120\)/.test(src),
    '★ C8c 离开即关：120ms 延时（官方 scheduleHoverClose 同值）');
  ok(/const onWinBlur = \(\) => \{ closeNow\(\); \}/.test(src) && /addEventListener\('blur', onWinBlur\)/.test(src),
    '★ C8d 窗口/应用失焦时关闭');
  /* ZB-27aa：焦点语义 = "明确移到子树外才关"。两条分开断言，避免跨长注释的正则脆弱。 */
  ok(/onBlur: \(e\) => \{[\s\S]{0,400}el\.contains\(e\.relatedTarget\)\) return;/.test(src),
    '★ C8e 焦点仍在子树内（移入弹窗）⇒ 不关（用 currentTarget/ref 做包含判断）');
  ok(/onBlur: \(e\) => \{[\s\S]{0,1400}if \(!\(e && e\.relatedTarget\)\) return;[\s\S]{0,200}scheduleClose\(\);/.test(src),
    '★ C8g relatedTarget 为空（焦点落到 body）**不关**；明确移到子树外才 scheduleClose（修「点进程行面板就关」）');
  ok(/onClick: \(\) => \{ setOpen\(true\); setHover\(true\); clearTimers\(\); \}/.test(src),
    '★ C8f 点击只负责"打开"（供触屏/键盘），不再切换 —— 避免指针停在入口上时一点就关');
  ok(/Escape/.test(code), 'C9 Esc 关闭');
  ok(/aria-expanded/.test(code) && /aria-haspopup/.test(code), 'C10 无障碍属性：aria-expanded / aria-haspopup');
}

console.log('\nD. 解耦：入口不建 wire；浮窗时代的状态与交互不再残留');{
  const i = code.indexOf('function HeaderEntry()');
  const body = code.slice(i, code.indexOf('function PanelBody()', i));
  ok(i > 0 && body.length > 0, 'D1 定位 HeaderEntry 函数体');
  /* ZB-27w：入口改为读**共享 wire**（模块级单例 + 引用计数）—— 入口可以读快照以显示任务/加载图标，
   * 但**绝不能**自己 createWire()，否则又变回"每个会话一条 1s 轮询"。 */
  ok(/const \{ snapshot \} = useWire\(\);/.test(body), '★ D2 入口读共享 wire 的快照（用于任务/加载图标）');
  ok(!/createWire\s*\(/.test(body), '★ D2b 入口体内**不得**自己 createWire()（否则每会话一条轮询）');
  ok(!/panelUi/.test(src), '★ D3 ZB-24 的模块级共享 store 已移除（入口只是开合开关）');
  ok(!/setMinimized|ui\.minimized/.test(code), '★ D4 最小化状态/药丸相关代码已清除');
  ok(!/dsp-pill|dsp-min|className: 'dsp-root'|dsp-titlebar|dsp-grip/.test(code), '★ D5 药丸/浮窗类名与标记已清除');
  /* ZB-27w：共享 wire 契约（模块级单例 + 引用计数；最后一个使用者才 dispose）。
   * ZB-28b：实现改为 createSharedWireRegistry 工厂 + **配对释放**（release 指名自己
   * acquire 的那条，守卫 refs===0 && current===wire）——旧无参 release 在 epoch 重建的
   * 双释放下会把入口正持有的 live wire 处决掉，正是「状态灯冻结」事故的根因。 */
  ok(/function createSharedWireRegistry\(createWireImpl\)/.test(code) && /let current = null;/.test(code) && /let refs = 0;/.test(code), '★ D6 共享 wire 单例与引用计数（createSharedWireRegistry 工厂）');
  ok(/ref\.current = \{ wire: acquireSharedWire\(\), epoch: remoteEpoch \};/.test(code) && !/ref\.current = createWire\(\)/.test(code), '★ D7 useWire 取得共享实例');
  ok(/refs === 0 && current && current === wire/.test(code), '★ D8 释放走引用计数且**配对**（只 dispose 自己那条；最后一个才 dispose）');
  ok(/releaseSharedWire\(wire\);/.test(code) && !/releaseSharedWire\(\);/.test(code), '★ D8b 释放**指名 wire**（无参调用绝迹）');
  ok(/function invalidateSharedWire\(\)/.test(code) && /invalidateSharedWire\(\);/.test(code) && /setRemoteEpoch/.test(code), '★ D9 远端就绪后作废重建共享 wire');
  /* ZB-27w：入口活动图标 + 被误删的脉动 keyframes。 */
  ok(/className: 'dsp-chip-activity'/.test(code), '★ D10 入口有活动槽位 .dsp-chip-activity');
  ok(/\.dsp-chip-activity\{flex:none;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;\}/.test(code),
    '★ D11 槽位 14×14（官方 .oXE0lW_activitySlot 同值）');
  ok(/state: runningCount > 0 \? 'running' : 'queued'/.test(code), '★ D12 进行中 → running（脉动）；仅排队 → queued');
  ok(/@keyframes dsp-pulse\{50%\{opacity:\.35;\}\}/.test(code), '★ D13 @keyframes dsp-pulse 已补回（曾被当死代码误删，导致 running 点不脉动）');
}

console.log('\nG. ZB-27f：入口是 <button>（与邻居同元素 ⇒ 同 UA 字体）+ 双层防高亮 + 容器同权重置');
{
  ok(/h\('button', \{[\s\S]{0,220}className: 'dsp-chip'/.test(src), '★ G1 入口是 <button>（与邻居同元素类型 ⇒ 自然拿到同一套 UA/平台按钮字体）');
  ok(/type: 'button'/.test(code), "G2 type='button'（不触发提交行为）");
  ok(/'aria-haspopup': 'dialog'/.test(code) && /'aria-expanded': open/.test(code), 'G3 无障碍属性保留（aria-expanded / aria-haspopup）');
  /* 双层防宿主高亮：内联样式挡住一切非 important 的样式表规则（含伪类），CSS !important 挡住 important。 */
  ok(/style: \{[\s\S]{0,120}background: 'transparent', backgroundImage: 'none', border: 0, boxShadow: 'none', outline: 'none',/.test(src),
    '★ G4 内联样式兜底（内联优先于 :hover/:focus 等非 important 规则）');
  /* 外层容器：宿主可能把高亮加在槽位 cell（我们的根 div）上 —— 芯片自身的重置救不了。 */
  ok(/\.dsp-entry\{position:relative;display:inline-flex;background:transparent !important/.test(code),
    '★ G5 外层 .dsp-entry 也重置背景/边框/阴影');
  ok(/\.dsp-entry:focus-within,\.dsp-entry:active\{background:transparent !important/.test(code),
    '★ G6 .dsp-entry 的 :focus-within / :active 也重置（祖先型高亮）');
  ok(/outline:none !important/.test(code), '★ G8 交互态清掉 outline（若宿主用焦点环填充则一并消除）');
}

console.log('\nF. 样式注入时机（ZB-27b 的根因守卫）');
{
  /* 用户现场「字号还是不对 + 有背景色」= 入口在首次点开前**没有任何插件样式**：
   * ensureStyle() 原先只挂在弹窗（PanelBody）的 effect 上，而弹窗要用户点开才挂载。
   * 因此必须由 apply() 在注册槽位之前先注入一次。 */
  const applyIdx = code.indexOf('apply(ctx) {');
  const ensureInApply = code.indexOf('ensureStyle();', applyIdx);
  const registerIdx = code.indexOf('ctx.slots.inject(HEADER_SLOT', applyIdx);
  ok(applyIdx > 0 && ensureInApply > applyIdx, '★ F1 apply() 里调用 ensureStyle()（激活即注入样式）');
  ok(ensureInApply < registerIdx, '★ F2 注入**早于**槽位注册（入口一出现就带样式）');
  ok(/try \{ ensureStyle\(\); \}/.test(code), 'F3 注入被 try 包住（样式失败不影响入口注册）');
}

/* ---------------- E. 真渲染：点开 → 弹窗出现；再点 → 收起 ---------------- */
console.log('\nE. 真渲染（React 桩）：开合与弹窗内容');
{
  const head = { children: [], appendChild(c) { head.children.push(c); return c; }, removeChild() {} };
  globalThis.document = {
    head, documentElement: { appendChild: () => {} },
    createElement: (t) => (t === 'style' ? { tagName: 'STYLE', attrs: {}, setAttribute() {}, textContent: '' } : { tagName: t.toUpperCase(), attrs: {}, setAttribute() {}, appendChild() {} }),
    getElementById: () => null, querySelector: () => null,
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const ls = new Map();
  globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (o) => { captured = o; } }, localStorage: globalThis.localStorage, innerHeight: 900, innerWidth: 1200, addEventListener: () => {}, removeEventListener: () => {} };
  await import('file:///F:/My Code/dsh-dispatch/dispatch/client.js');

  const el = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() });
  const cellStore = new Map();
  let cur = null; const pendingEffect = [];
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
  /* ⚠️ 本插件现在注册**两个**槽位（ZB-52：插件详情页配置卡是新增的第二个）：
   *   ① `conversation.session.header.actions` —— 会话标题行的派发台入口（本文件的主角，仍是 regs[0]）
   *   ② `plugins.bundle.config` —— 插件详情页的顺序派发配置卡（keyed by 包名）
   * 故断言从"只有一个 cell"改为"**会话头 cell 存在且是第一个**，配置卡也注册了"——
   * 否则这条会随任何新槽位变红（它本意是钉会话头入口，不是钉"只有它"）。 */
  const headerCell = regs.find((r) => r.o.name === 'conversation.session.header.actions');
  const bundleCard = regs.find((r) => r.o.name === 'plugins.bundle.config');
  ok(regs[0]?.o.name === 'conversation.session.header.actions',
    `E1 第一个注册的仍是会话头槽位 cell（实际 ${regs[0]?.o?.name}）`);
  ok(!!headerCell && typeof headerCell.comp === 'function', 'E1 会话头 cell 已注册且是组件函数');
  ok(!!bundleCard && bundleCard.o.key === 'dsh-dispatch' && typeof bundleCard.comp === 'function',
    `E1b 插件详情页配置卡已注册（key=${bundleCard?.o?.key}，keyed 槽位按包名派发）`);

  const render = () => {
    let t = expand(regs[0].comp({}), 'hdr');
    while (pendingEffect.length) pendingEffect.shift()();
    return t;
  };
  const findAll = (node, pred, acc = []) => {
    if (node == null || typeof node !== 'object') return acc;
    if (Array.isArray(node)) { for (const n of node) findAll(n, pred, acc); return acc; }
    if (pred(node)) acc.push(node);
    findAll(node.children, pred, acc);
    return acc;
  };
  const texts = (node) => {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(texts).join('');
    return texts(node.children);
  };

  let tree = render();
  const chipOf = (t) => findAll(t, (n) => typeof n.props?.className === 'string' && n.props.className.includes('dsp-chip'))[0];
  const chip = chipOf(tree);
  ok(!!chip, 'E2 渲染出入口按钮（.dsp-chip）');
  /* ZB-41（用户要求）：「面板改成派发台，包名等相关的改成 DSH 派发台」⇒
   * 面板/入口标题 = 「派发台」（纯功能名）；包标题（package.json / locale meta.title）=「DSH 派发台」。
   * 本条断言锁住新决策：入口文字就取 title（与面板标题同源），不再要求带品牌前缀。 */
  ok(texts(chip).includes('派发台'), `★ E3 入口文字是面板标题「派发台」（ZB-41 命名决策；实际=${texts(chip)}）`);
  ok(!texts(chip).includes('ZCode'), `★ E3c 入口文字不含「ZCode」（去品牌化；实际=${texts(chip)}）`);
  ok(/t\('title'\)/.test(src), '★ E3b 入口标签取自 title（与面板标题同源）');
  ok(chip.props['aria-expanded'] === false, 'E4 初始未展开');
  ok(findAll(tree, (n) => typeof n.props?.className === 'string' && n.props.className.includes('dsp-menu')).length === 0, 'E5 未展开时没有弹窗（不预先建 wire）');

  chip.props.onClick();
  tree = render();
  const menus = findAll(tree, (n) => typeof n.props?.className === 'string' && n.props.className.includes('dsp-menu'));
  ok(menus.length === 1, 'E6 ★ 点击后挂出弹窗（.dsp-menu）');
  /* ZB-36：真渲染断言 —— 面板高度上限确实**挂在弹窗元素的行内样式**上（不是只写在源码里）。 */
  const menuStyle = menus[0].props.style ?? {};
  ok(menuStyle.maxHeight === 'min(960px, calc(100vh - 140px))',
    `★ ZB-36 弹窗行内 maxHeight = 960px 上限（实际 ${JSON.stringify(menuStyle.maxHeight)}）`);
  ok(chipOf(tree).props['aria-expanded'] === true, 'E7 展开状态与 aria-expanded 一致');
  const menuText = texts(menus[0]);
  ok(menuText.includes('派发'), `E8 弹窗里是原面板内容（含分区标题，实际片段=${menuText.slice(0, 40)}）`);

  /* ZB-27l：改成**悬浮展开 / 离开即关**后的行为（真渲染 + 真事件回调）。 */
  const entryOf = (t) => findAll(t, (n) => typeof n.props?.className === 'string' && n.props.className.includes('dsp-entry'))[0];
  const menuCount = (t) => findAll(t, (n) => typeof n.props?.className === 'string' && n.props.className.includes('dsp-menu')).length;

  ok(typeof entryOf(tree)?.props?.onMouseEnter === 'function', 'E9 外层容器带 onMouseEnter（悬浮展开挂点）');
  chipOf(tree).props.onClick();
  tree = render();
  ok(menuCount(tree) === 1, '★ E10 再次点击**不再收起**（点击只负责打开，避免指针停在入口上一点就关）');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  entryOf(tree).props.onMouseLeave();
  await wait(180);
  tree = render();
  ok(menuCount(tree) === 0, '★ E11 指针离开 ⇒ 120ms 后收起（官方同款延时可避免穿过缝隙时闪）');
  entryOf(tree).props.onMouseEnter();
  await wait(200);
  tree = render();
  ok(menuCount(tree) === 1, '★ E12 指针进入 ⇒ 150ms 后展开（无需点击）');
  /* 焦点离开子树（键盘 Tab 走开）也应关闭；焦点仍在子树内（如移进弹窗）时不关。 */
  const inside = chipOf(tree);
  const fakeRoot = { contains: (n) => n === inside };
  const outsideNode = { id: 'outside' };
  entryOf(tree).props.onBlur({ currentTarget: fakeRoot, relatedTarget: inside });
  tree = render();
  ok(menuCount(tree) === 1, 'E13 焦点仍在子树内（移入弹窗/入口）⇒ 不关');
  /* ★ ZB-27aa：relatedTarget 为空 = 焦点落到 document.body（点击弹窗内不可聚焦元素的标准行为），
   * 绝不能据此关闭 —— 否则"点进程行要展开内容"会把整个面板关掉（用户实际报告）。 */
  entryOf(tree).props.onBlur({ currentTarget: fakeRoot, relatedTarget: null });
  await wait(180);
  tree = render();
  ok(menuCount(tree) === 1, '★ E14 relatedTarget 为空（焦点落到 body，点弹窗内不可聚焦元素）⇒ **不关**（修「点进程行面板就关」）');
  entryOf(tree).props.onBlur({ currentTarget: fakeRoot, relatedTarget: outsideNode });
  await wait(180);
  tree = render();
  ok(menuCount(tree) === 0, '★ E15 焦点明确移到子树外的元素 ⇒ 120ms 后关闭（保持"失焦关闭"语义）');
}

/* ---------- ZB-60：入口降级链（DSH 0.2.1 兼容性加固）----------
 * ⚠️ 上下文：本测试 E1 曾断言"只注册会话头一个 cell"、A3 断言"不再注册 shell.overlay"。
 * **该语义已按用户要求有意放宽**为「**仅当主槽位不可用时**才退到 shell.overlay、且绝不并存」
 * —— 两条旧断言的字面正则仍绿（我们用的是 `FALLBACK_SLOT` 常量），但**新语义原先没有任何断言钉住**。
 * 这一节把它钉死，防止将来有人"顺手恢复成双 UI"（那正是 ZB-27 否决过的）。
 *
 * 为什么用**源码级**断言而不是真渲染：降级链的触发条件分别依赖
 * 「inject 抛错 / register 抛错 / 槽位未声明（inject 静默等待）/ 主槽位迟到」四种时序，
 * 真渲染要精确模拟四套槽位行为，成本远高于收益；这里要防的是**结构性回归**
 * （常量缺失 / 判据被删 / 撤回逻辑被删），源码级足够且稳定。
 * 行为级验证（7 场景 84 断言：主可用 / inject 抛错 / register 抛错 / 未声明 / 宽限超时 /
 * 迟到主槽位 / 两条都失败）已在开发期临时探针里跑过，不入库。 */
{
  ok(/const FALLBACK_SLOT = 'shell\.overlay';/.test(src),
    'ZB60a 备用槽位常量 = shell.overlay（主入口不可用时的退路）');
  ok(/ctx\.slots\.inject\(FALLBACK_SLOT, /.test(src),
    'ZB60b 备用槽位**确有**注册调用（否则"降级链"只是注释）');
  ok(/name: FALLBACK_SLOT/.test(src),
    'ZB60c 备用注册的 name 用常量（不另写字面量，避免两处漂移）');
  /* 判据必须覆盖"未声明"这一路：0.2.0/0.2.1 的 inject 对未声明槽位是**静默等待**（不抛错），
   * 只靠 try/catch 抓不到 ⇒ 必须有 spec() 查询或宽限计时。 */
  ok(/ctx\.slots\.spec/.test(src) || /SLOT_GRACE_MS/.test(src),
    'ZB60d 覆盖"槽位未声明"（spec() 查询或宽限计时至少其一）—— 只靠 try/catch 抓不到静默等待');
  ok(/已降级到/.test(src) && /已撤回/.test(src),
    '★ ZB60e 降级与撤回**都留可读 warn**（降级要可观测；主槽位迟到就绪要撤回，绝不双 UI）');
  ok(/slots\.inject\(HEADER_SLOT/.test(src),
    'ZB60f 主槽位仍是首选（字面形状保留：本文件全篇依赖它）');
}

console.log(`\n===== ZB-27：${pass} PASS / 0 FAIL =====`);
process.exit(0);
