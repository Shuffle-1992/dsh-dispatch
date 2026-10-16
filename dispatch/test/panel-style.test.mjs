// 样式回归测试（原 ZB-21「重影 + 透明 + 塌左上角」的根治断言，ZB-27 改到弹窗形态后重写）。
//
// 保留下来的两条根治不变量：
//   ① 样式**只注入一次**到 document.head，脱离 React 重渲染路径（重渲染不得触碰 head）；
//   ② 弹窗子树统一 border-box —— 否则 `.dsp-ta{width:100%}` + padding/border 会撑破右边界（ZB-17 的实事故）。
// ZB-27 起浮窗/胶囊已取消，故不再断言 .dsp-root / .dsp-panel / 入场动画。
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const SRC = 'F:\\My Code\\dsh-dispatch\\dispatch\\client.js';
const src = readFileSync(SRC, 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const code = stripComments(src);

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log(`  ✓ ${m}`); };

console.log('A. 样式已移出组件树（根治前提）');
ok(!/h\('style', null, CSS\)/.test(code), "A1 组件树里不再渲染 h('style', null, CSS)（注释引用不算）");
ok((code.match(/h\('style'/g) || []).length === 0, "A2 生效代码里无 h('style' 出现");
ok(/document\.createElement\('style'\)/.test(code), "A3 改为 document.createElement('style')");
ok(/\(document\.head \|\| document\.documentElement\)\.appendChild\(s\)/.test(code), 'A4 注入到 document.head（脱离 React 协调）');

console.log('\nB. 幂等与生命周期');
ok(/function ensureStyle\(\)/.test(src), 'B1 有 ensureStyle()');
ok(/if \(!\(styleEl && styleEl\.isConnected\)\) \{/.test(src), 'B2 已注入则跳过插入（幂等，不重复插入）');
ok(/const existing = document\.getElementById\(STYLE_ID\)/.test(src), 'B3 先按 id 查找已存在的样式（跨组件实例复用）');
ok(/function detachStyle\(\)/.test(src), 'B4 有 detachStyle()（保持"卸载即清理"语义）');
ok(/const release = ensureStyle\(\);/.test(src) && /return \(\) => \{ try \{ release\(\); \}/.test(src), 'B5 挂载时 ensureStyle() 取得引用、卸载时释放自己那一份');
  /* ★ ZB-27u 回归：样式表是模块级单例（常驻入口 + 按需挂载的面板共用），必须引用计数。
   * 真实 bug：面板关闭 ⇒ PanelBody 卸载 ⇒ 直接 detachStyle() 把整张表删掉 ⇒ 常驻入口瞬间掉样式
   * （实测盒子从 h=28/top=51 变 h=19/top=56.5，即用户说的"悬浮失焦后就不正常了"）。 */
  ok(/let STYLE_REFS = 0;/.test(src), '★ B6 样式表引用计数 STYLE_REFS');
  ok(/STYLE_REFS \+= 1;/.test(src) && /STYLE_REFS = Math\.max\(0, STYLE_REFS - 1\);/.test(src) && /if \(STYLE_REFS === 0\) detachStyle\(\);/.test(src),
    '★ B7 ensureStyle() 计数 +1 并返回释放函数；仅计数归零才 detachStyle()');
  ok(!/return \(\) => detachStyle\(\);/.test(src), '★ B8 **禁止**任何组件卸载时直接 detachStyle()（会让常驻入口掉样式）');

console.log('\nC. 样式作用域与历史缺陷的防复发');
ok(/\.dsp-menu,\.dsp-menu \*\{box-sizing:border-box;\}/.test(code), '★ C1 border-box 作用域 = .dsp-menu 子树（输入框撑破右边界不会复发）');
ok(!/\.dsp-root,\.dsp-root \*\{box-sizing/.test(code), 'C2 旧的 .dsp-root 作用域已不存在');
ok(!/animation:dsp-in/.test(code) && !/@keyframes dsp-in/.test(code), 'C3 入场动画与 keyframes 已随浮窗移除（重影那类问题的载体消失）');
ok(!/\.dsp-pill/.test(code) && !/\.dsp-grip/.test(code), 'C4 药丸 / 缩放手柄样式已清除');
ok(/\.dsp-iconbtn\{/.test(code), 'C5 行内小图标按钮样式**保留**（JobRow 仍在用）');
  /* ZB-27y：派发开关徽标与「已连接」同高（font-size/line-height 对齐 .dsp-conn），横向更紧凑。 */
  ok(/button\.dsp-conn\.dsp-switch\{font-size:10px;line-height:15px;padding:1px 5px;border-radius:8px;\}/.test(code),
    '★ C6 派发开关徽标：字号/行高与 .dsp-conn 一致（同高），横向 1px 5px 更小巧');
  /* ★ ZB-27z：面板**基础字号**（原浮窗时代 .dsp-root{font-size:12px} 在重构中被丢掉 ⇒
   * 未显式设字号的元素继承应用根部 ~14px，进程行等整体偏大）。官方弹层主行 = 12px/17px。 */
  ok(/\.dsp-menu\{position:absolute;top:calc\(100% \+ 5px\);left:0;z-index:100;font-size:12px;line-height:17px;/.test(code),
    '★ C7 面板容器有基础字号 12px/17px（与官方弹层主行同值；否则未显式设字号的元素会继承 ~14px）');
  /* 字号阶梯收敛为官方三档：12/17 主 · 11/16 次 · 10/15 元 —— 不再出现 10.5px 这类中间值。 */
  ok(!/font-size:10\.5px/.test(code), '★ C8 面板内不再出现 10.5px 中间值（统一到官方 12/11/10px 三档）');

console.log('\nD. DOM 桩实测：注入一次且重渲染不再触碰 head');
{
  const head = { children: [], appendChild(c) { c.parentNode = head; head.children.push(c); insertCount += 1; return c; }, removeChild(c) { head.children = head.children.filter((x) => x !== c); c.parentNode = null; c.isConnected = false; removeCount += 1; return c; } };
  let insertCount = 0, removeCount = 0;
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
  /** 渲染入口；open=true 时点一次让它展开（弹窗挂出来才会挂 ensureStyle 的 effect）。 */
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
  let tree = render(true);
  ok(head.children.filter((c) => c.tagName === 'STYLE').length === 1, 'D1 弹窗打开后 head 里恰好 1 个 <style>');
  ok(head.children[0].attrs.id === 'dispatch-style', 'D2 样式带稳定 id（幂等查找依据）');
  const css = String(head.children[0].textContent ?? '');
  ok(css.includes('.dsp-menu{position:absolute'), 'D3 注入的 CSS 含弹窗定位');
  ok(/\.dsp-menu,\.dsp-menu \*\{box-sizing:border-box;\}/.test(css), 'D4 注入的 CSS 含 .dsp-menu 的 border-box 作用域');
  {
    let n = 0;
    const f = (x) => { if (!x || typeof x !== 'object') return; if (x.type === 'style') n += 1; for (const c of x.children ?? []) f(c); };
    f(tree);
    ok(n === 0, 'D5 组件树里没有 <style> 节点');
  }
  const ins0 = insertCount, rem0 = removeCount;
  for (let i = 0; i < 10; i += 1) render(false);
  ok(insertCount === ins0 && removeCount === rem0, `D6 ★ 连续 10 次重渲染后 head 插入/移除次数不变（${ins0}→${insertCount} / ${rem0}→${removeCount}）`);
  ok(head.children.filter((c) => c.tagName === 'STYLE').length === 1, 'D7 重渲染后样式仍在位');
}

console.log(`\n===== 样式回归：${pass} PASS / 0 FAIL =====`);
process.exit(0);
