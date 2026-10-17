/**
 * D1 契约测试：`dispatch` 工具调用的会话内专属卡片（DSH keyed 槽位 `tool.call.toolview`）。
 *
 * 为什么这样测：`client.js` 是 cordis 客户端插件（`window.__ModuleLoader__.load`，不能 import）。
 * 纯源码正则只能钉"写了什么"，**测不出运行时是否抛错、各阶段是否真能渲染、异常形状是否退化**。
 * 所以这里两手都做：
 *   ① **静态契约**：注册字面量 / key / 三种 phase 分支 / 无字面色值 / locale 三方同步；
 *   ② **执行**：把源码里的解析层（`tv*` 纯函数）与行组件切出来，用 `new Function` 装进沙箱，
 *      真跑一遍 —— 覆盖 preparing/start/result、job/list/其它信封/失败/未知形状/垃圾输入，
 *      并断言"**绝不抛错**"（这是本卡片的第一硬要求）。
 *
 * 跑法：node dispatch/test/toolview-card.test.mjs
 */
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const SRC = 'F:\\My Code\\dsh-dispatch\\dispatch\\client.js';
const src = readFileSync(SRC, 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const code = stripComments(src);

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log(`  ✓ ${m}`); };

/* ═══════════ A. 注册契约（字面形状 / key / 位置） ═══════════ */
console.log('A. 槽位注册（keyed `tool.call.toolview`，key = 工具名 dispatch）');
{
  ok(/const TOOLVIEW_SLOT = 'tool\.call\.toolview';/.test(code), "A1 TOOLVIEW_SLOT = 'tool.call.toolview'（DSH 0.2.1 新增 keyed 槽位）");
  ok(/const TOOLVIEW_KEY = 'dispatch';/.test(code), "A2 TOOLVIEW_KEY = 'dispatch'（= index.js 里 defineTool({name:'dispatch'}) 的工具名）");
  ok(/ctx\.slots\.inject\(TOOLVIEW_SLOT, \(\) => ctx\.slots\.register\(\{\s*name: TOOLVIEW_SLOT, key: TOOLVIEW_KEY,\s*\}, DispatchToolRow\)\)/.test(src),
    'A3 注册字面量 = inject(TOOLVIEW_SLOT) → register({name, key}, DispatchToolRow)');
  ok(/function DispatchToolRow\(props\) \{/.test(code), 'A4 行组件存在：DispatchToolRow(props)');
  /* 位置：必须在 apply() 内、ensureStyle() 之后、配置卡注册之后（header-entry.test 依赖前两者的次序）。 */
  const applyIdx = code.indexOf('apply(ctx) {');
  const ensureIdx = code.indexOf('ensureStyle();', applyIdx);
  const headerIdx = code.indexOf('ctx.slots.inject(HEADER_SLOT', applyIdx);
  const cfgIdx = code.indexOf('ctx.slots.inject(BUNDLE_CONFIG_SLOT', applyIdx);
  const tvIdx = code.indexOf('ctx.slots.inject(TOOLVIEW_SLOT', applyIdx);
  ok(applyIdx > 0 && ensureIdx > applyIdx, 'A5 注册在 apply() 内、ensureStyle() 之后');
  ok(tvIdx > 0 && tvIdx > headerIdx && tvIdx > cfgIdx, 'A6 注册在会话头入口与配置卡**之后**（不动既有注册的字面形状与次序）');
  ok(/try \{\s*ctx\.slots\.inject\(TOOLVIEW_SLOT[\s\S]{0,220}?\} catch \(e\) \{/.test(src),
    'A7 注册被 try/catch 包住（注册失败只留痕，绝不影响插件加载/面板/工具）');
  ok(/TOOLVIEW_KEY/.test(code) && /key: TOOLVIEW_KEY/.test(src), 'A8 key 走常量（不是散落的字面量）');
}

/* ═══════════ B. 三种 phase + 可访问性（静态） ═══════════ */
console.log('\nB. 三阶段分支与 a11y');
{
  ok(/settled \? 'result' : p\.phase === 'start' \? 'start' : 'preparing'/.test(code),
    "B1 阶段判据：`kind` in block ⇒ result；phase='start' ⇒ start；否则 preparing");
  ok(/if \(phase === 'preparing'\) return out;/.test(code), 'B2 preparing 提前返回（占位行，不解析入参）');
  ok(/t\('tvPreparing'\)/.test(code), 'B3 preparing 用 tvPreparing（「正在派发…」占位行）');
  ok(/if \(phase === 'start'\) \{/.test(code) && /tvFirstLine\(args\.prompt \?\? args\.task \?\? args\.target/.test(code),
    'B4 start 从 argsRaw 里取目标（prompt/task/target 首行）');
  ok(/data\.ok === false/.test(code) && /Array\.isArray\(data\.jobs\)/.test(code) && /tvJobFacts\(data\.job\)/.test(code),
    'B5 result 按信封分派：{ok:false} / {ok,jobs} / {ok,job} 三条路都在');
  ok(/role: 'button'/.test(code) && /tabIndex: 0/.test(code) && /'aria-expanded': open/.test(code),
    'B6 折叠行是 role=button + tabIndex=0 + aria-expanded（a11y）');
  ok(/onKeyDown: tvOnKeyDown\(toggle\)/.test(code) && /event\.key !== 'Enter' && event\.key !== ' '/.test(code),
    'B7 键盘 Enter / Space 可展开');
  ok(/'data-state': String\(m\.state\)/.test(code), 'B8 卡片带 data-state（状态既在文本也在属性上，不只靠颜色）');
  ok(/className: `dsp-tv-pill s-\$\{tvPillClass\(m\.state\)\}`/.test(code) && /TV_PILL = \['queued'/.test(code),
    'B9 状态胶囊的类名走白名单（脏状态串不会拼进 class）');
}

/* ═══════════ C. 无误报的"绝不抛错"纪律（静态） ═══════════ */
console.log('\nC. 绝不抛错（静态纪律）');
{
  ok(/function DispatchToolRow\(props\) \{[\s\S]*?catch \(e\) \{[\s\S]{0,160}?return tvFallbackRow\(props\);/.test(code),
    'C1 行组件最外层 try/catch ⇒ 异常退化成一行纯文本');
  ok(/const tvFallbackRow = \(props\) => \{[\s\S]*?catch \{ return null; \}/.test(code), 'C2 兜底渲染自身也不抛（再包一层）');
  ok(!/\bthrow\b/.test(code.slice(code.indexOf('const tvFirstLine = '), code.indexOf('function DispatchToolRow'))),
    'C3 解析层里没有任何 throw（只 try/catch + 返回退化值）');
  ok(!/props\.useDisclosure|useDisclosure\(\)/.test(code),
    'C4 **不调用** 宿主的 useDisclosure（可选 prop ⇒ 条件式调用会打断 hook 顺序；自带 useState 更稳）');
  const hookCalls = (code.match(/React\.useState\(/g) || []).length;
  ok(hookCalls >= 3, `C5 hooks 无条件调用（React.useState 出现 ${hookCalls} 次，位于 try 之前）`);
  const compBody = code.slice(code.indexOf('function DispatchToolRow(props) {'), code.indexOf('function DispatchToolRow(props) {') + 420);
  ok(/useState[\s\S]*useState[\s\S]*useState[\s\S]*?try \{/.test(compBody),
    'C6 三个 useState 都写在 try 之前（hook 顺序稳定，不会被异常打断；CRLF/LF 无关）');
}

/* ═══════════ D. 零字面色值 + 样式自带 box-sizing ═══════════ */
console.log('\nD. 样式纪律');
{
  const bad = [...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  ok(bad.length === 0, `D1 client.js 无字面色值（只走主题令牌；命中：${bad.slice(0, 5).join(',') || 'none'}）`);
  ok(/\.dsp-tv-card\{box-sizing:border-box;/.test(code) && /\.dsp-tv-card \*\{box-sizing:border-box;\}/.test(code),
    'D2 卡片自带 border-box 作用域（它渲染在会话流里，拿不到 .dsp-menu 的那条规则）');
  const tvCss = src.slice(src.indexOf("'.dsp-tv-card{"), src.indexOf("'.dsp-tv-empty{"));
  const tokens = [...tvCss.matchAll(/T\.[a-zA-Z0-9]+/g)].map((m) => m[0]);
  ok(tokens.length >= 10, `D3 卡片样式全部用 T.* 令牌（引用 ${tokens.length} 处）`);
  ok(!/#[0-9a-fA-F]{3,8}\b/.test(tvCss), 'D4 卡片样式里没有任何字面色值');
  ok(/\.dsp-tv-raw\{max-height:220px;overflow:auto;/.test(code), 'D5 原文块限高滚动（大 JSON 不整段铺开）');
  ok(/\.dsp-tv-sum\{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis/.test(code),
    'D6 摘要列省略号截断（长目标/长错误不撑破行）');
}

/* ═══════════ E. locale 三方同步（client STRINGS ↔ locale/zh.json ↔ locale/en.json） ═══════════ */
console.log('\nE. 文案三方同步');
{
  const m = src.match(/\n\s{4}const STRINGS = \{([\s\S]*?)\n\s{4}\};/);
  ok(!!m, 'E1 能从 client.js 取出内嵌 STRINGS');
  const strings = new Function(`return {${m[1]}};`)();
  const zh = JSON.parse(readFileSync('F:\\My Code\\dsh-dispatch\\dispatch\\locale\\zh.json', 'utf8')).ui;
  const en = JSON.parse(readFileSync('F:\\My Code\\dsh-dispatch\\dispatch\\locale\\en.json', 'utf8')).ui;
  const used = [...new Set([...code.matchAll(/t\('(tv[A-Za-z]+)'\)/g)].map((x) => x[1]))].sort();
  ok(used.length >= 15, `E2 卡片用到 ${used.length} 个 tv* 文案键`);
  const missing = used.filter((k) => !(k in strings.zh) || !(k in strings.en));
  ok(missing.length === 0, `E3 用到的键都在 STRINGS 里（缺：${missing.join(',') || '无'}）`);
  const diff = [];
  for (const k of used) {
    if (strings.zh[k] !== zh[k]) diff.push(`zh.${k}`);
    if (strings.en[k] !== en[k]) diff.push(`en.${k}`);
  }
  ok(diff.length === 0, `E4 内嵌 STRINGS 与 locale 两语言**逐键逐值**一致（差异：${diff.join(',') || '无'}）`);
  const tvKeysZh = Object.keys(zh).filter((k) => k.startsWith('tv'));
  ok(tvKeysZh.length === used.length,
    `E5 locale 里的 tv* 键数 == 代码用到的键数（${tvKeysZh.length} vs ${used.length}；防"加了没用/用了没加"）`);
}

/* ═══════════ F. 执行：把解析层与组件切出来真跑（覆盖各形状 + 绝不抛错） ═══════════ */
console.log('\nF. 执行（沙箱里真跑解析层与行组件）');
{
  /* ⚠️ 锚点必须**行尾无关**（本仓库工作副本可能是 CRLF）：用正则整体切，不用 '\n' 字面拼接。 */
  const cut = src.match(/const tvFirstLine = \(text\) => \{[\s\S]*?\r?\n {4}\}\r?\n\r?\n {4}return \{/);
  ok(!!cut, 'F1 能从源码里切出「解析层 + 行组件」这一段（锚点仍在）');
  const block = cut[0].replace(/\r?\n {4}return \{$/, '');

  /* React 桩：只实现 useState（本组件只用它），并按调用次序记账 ⇒ 可模拟"点开 / 再渲染"。 */
  const cells = [];
  let idx = 0;
  const React = {
    useState: (init) => {
      const i = idx;
      idx += 1;
      if (!(i in cells)) cells[i] = typeof init === 'function' ? init() : init;
      return [cells[i], (v) => { cells[i] = typeof v === 'function' ? v(cells[i]) : v; }];
    },
  };
  const el = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() });
  const h = (type, props, ...children) => el(type, props, ...children);
  /* t 用"键名当值"的桩：断言时直接看键是否被用过（真实文案由 E 段的三方同步守门）。 */
  const t = (k) => String(k);
  const sandbox = new Function('t', 'h', 'React', 'TOOLVIEW_KEY', `${block}
    return { tvFirstLine, tvClip, tvJson, tvContentText, tvCountsText, tvElapsed, tvBriefLine, tvJobFacts,
             tvFactsFrom, tvEnvelopeSummary, tvModel, tvOnKeyDown, tvPillClass, tvPillTitle, tvFallbackRow, DispatchToolRow };`);
  const S = sandbox(t, h, React, 'dispatch');
  const renderRow = (props) => { idx = 0; return S.DispatchToolRow(props); };
  /** 清掉展开态（`cells` 是"组件实例"的内存）：每个阶段都从**未展开**开始，断言才确定。 */
  const reset = () => { cells.length = 0; };
  const walk = (node, fn) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, fn)); return; }
    fn(node);
    const kids = node.children == null ? [] : (Array.isArray(node.children) ? node.children : [node.children]);
    kids.forEach((n) => walk(n, fn));
  };
  const findAll = (tree, pred) => { const out = []; walk(tree, (n) => { if (pred(n)) out.push(n); }); return out; };
  const textOf = (n) => {
    let s = '';
    walk(n, (x) => { if (x && x.type == null && typeof x !== 'object') s += String(x); });
    if (typeof n === 'string') s += n;
    return s;
  };
  const flatText = (tree) => {
    let s = '';
    const go = (n) => {
      if (n == null) return;
      if (typeof n === 'string' || typeof n === 'number') { s += String(n); return; }
      if (typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(go); return; }
      const kids = n.children == null ? [] : (Array.isArray(n.children) ? n.children : [n.children]);
      kids.forEach(go);
    };
    go(tree);
    return s;
  };

  /* —— 纯函数：解析各形状 —— */
  ok(S.tvJson('{"a":1}')?.a === 1 && S.tvJson('不是 JSON') === null && S.tvJson('') === null && S.tvJson('null') === null && Array.isArray(S.tvJson('[1,2]')),
    'F2 tvJson：JSON 对象/数组才认（null 字面量/空/坏 JSON 一律 null 且不抛）');
  assert.doesNotThrow(() => S.tvJson(null) && S.tvJson(undefined) && S.tvJson(123) && S.tvJson({}), 'F3 tvJson 垃圾输入不抛');
  const clip = S.tvClip('x'.repeat(100), 10);
  ok(clip.text.length === 10 && clip.truncated === true && clip.total === 100, 'F4 tvClip：截断 + total 记录（原文长度不丢）');
  ok(S.tvFirstLine('a\nb') === 'a' && S.tvFirstLine(null) === '', 'F5 tvFirstLine：单行化且容忍 null');
  ok(S.tvCountsText({ done: 3, running: 1, killed: 0 }) === 'done×3 · running×1', 'F6 tvCountsText：只列 >0 的状态并折叠');
  ok(S.tvElapsed(3.5) === '3.5s' && S.tvElapsed(12.5) === '13s' && S.tvElapsed(62) === '1m02s' && S.tvElapsed(3900) === '1h05m' && S.tvElapsed(null) === '',
    'F7 tvElapsed：紧凑耗时格式（<10s 留一位小数，≥10s 取整；分/时带前导零）');
  ok(S.tvPillClass('paused') === 'paused' && S.tvPillClass('"><script>') === 'queued', 'F8 tvPillClass：白名单外的状态回落到安全类名');

  /* —— 阶段 1：preparing —— */
  reset();
  const prep = S.tvModel({ phase: 'preparing', callId: 'c1', block: { phase: 'preparing', callId: 'c1', name: 'dispatch' } });
  ok(prep.state === 'preparing' && prep.action === null && prep.facts.length === 0, 'F9 preparing：不解析入参，状态=preparing');
  const prepTree = renderRow({ phase: 'preparing', toolName: 'dispatch', callId: 'c1', block: { phase: 'preparing', callId: 'c1', name: 'dispatch' } });
  ok(flatText(prepTree).includes('tvPreparing'), 'F10 preparing 渲染出「正在派发…」占位文案（键 tvPreparing）');
  ok(findAll(prepTree, (n) => n.type === 'span' && n.props.className === 'dsp-tv-pill').length === 0,
    'F11 preparing 不显示状态胶囊（此时还没有状态可言）');

  /* —— 阶段 2：start —— */
  reset();
  const startProps = {
    phase: 'start', toolName: 'dispatch', callId: 'c2',
    block: { phase: 'start', callId: 'c2', name: 'dispatch', argsRaw: JSON.stringify({ action: 'dispatch', tag: 'zb-1', prompt: '第一行目标\n第二行' }) },
  };
  const sm = S.tvModel(startProps);
  ok(sm.phase === 'start' && sm.action === 'dispatch' && sm.tag === 'zb-1' && sm.summary === '第一行目标',
    'F12 start：动作/tag/目标首行都解析出来（多行只取首行）');
  const startTree = renderRow(startProps);
  const startRow = findAll(startTree, (n) => n.props && n.props.role === 'button')[0];
  ok(!!startRow && startRow.props['aria-expanded'] === false, 'F13 start：折叠行 role=button 且 aria-expanded=false');
  const startText = flatText(startTree);
  ok(startText.includes('dispatch') && startText.includes('#zb-1') && startText.includes('第一行目标'),
    'F14 start：折叠行显示 动作 + tag + 摘要');
  ok(findAll(startTree, (n) => n.type === 'span' && String(n.props.className).includes('s-running')).length === 1,
    'F15 start：状态胶囊 = running（调用在飞）');

  /* —— 阶段 3：result / job 信封（dispatch / retry / kill / wait） —— */
  reset();
  const jobProps = {
    phase: 'result', toolName: 'dispatch', callId: 'c3',
    block: {
      kind: 'tool', callId: 'c3', isError: false,
      call: { name: 'dispatch', argsRaw: JSON.stringify({ action: 'dispatch', kind: 'prompt', tag: 'zb-2', provider: 'opencode', write: ['a.ts', 'b.ts'] }) },
      content: [{ type: 'text', text: JSON.stringify({ ok: true, job: { id: 'j-abc123', state: 'paused', tag: 'zb-2', model: 'opencode/x', provider: 'opencode', engine: 'opencode', elapsedSec: 12.5, exitCode: null, pauseReason: 'quota-exhausted', spec: { kind: 'prompt', body: '跑个任务\n第二行', cwd: 'F:\\w', timeoutMin: 15, lock: 'repo', write: ['a.ts'] } } }) }],
    },
  };
  const jm = S.tvModel(jobProps);
  ok(jm.state === 'paused' && jm.elapsed === '13s' && jm.model === 'opencode/x', 'F16 result/job：状态/耗时/模型来自 job');
  ok(jm.summary === '跑个任务', 'F17 result/job：摘要是派发原文首行（不是整段 JSON）');
  const jKeys = jm.facts.map((f) => f.k);
  ok(jKeys.includes('tvJobId') && jKeys.includes('tvEngineCh') && jKeys.includes('cwd') && jKeys.includes('timeout') && jKeys.includes('repoLock'),
    `F18 result/job：展开区字段齐（${jKeys.join(',')}）`);
  ok(jm.tailHint && jm.tailHint.includes('j-abc123'), 'F19 result/job：给出"用 action=tail 读输出"的下一步提示（带 id）');
  ok(jm.note && jm.note.includes('quota-exhausted'), 'F20 result/job：paused 原因带进说明行');

  const jobTree = renderRow(jobProps);
  ok(findAll(jobTree, (n) => n.type === 'span' && String(n.props.className).includes('s-paused')).length === 1,
    'F21 result/job：胶囊用 paused 的状态色类名');
  /* 点击展开 → 出现结构化明细与两个原文开关 */
  const rowBtn = findAll(jobTree, (n) => n.props && n.props.role === 'button')[0];
  rowBtn.props.onClick();
  const openTree = renderRow(jobProps);
  const openRow = findAll(openTree, (n) => n.props && n.props.role === 'button')[0];
  ok(openRow.props['aria-expanded'] === true, 'F22 点击后 aria-expanded=true（展开态）');
  const openText = flatText(openTree);
  ok(openText.includes('j-abc123') && openText.includes('tvJobId') && openText.includes('tvTailHint'),
    'F23 展开区显示 job id、字段名与 tail 提示');
  const rawBtns = findAll(openTree, (n) => n.type === 'button' && String(n.props.className).includes('dsp-tv-rawbtn'));
  ok(rawBtns.length === 2, `F24 展开区有「原始入参 / 原始结果」两个**默认折叠**的原文开关（实际 ${rawBtns.length}）`);
  ok(findAll(openTree, (n) => n.type === 'pre').length === 0, 'F25 原文默认不铺开（展开前 DOM 里没有 <pre>）');
  rawBtns[0].props.onClick();
  const rawTree = renderRow(jobProps);
  const pres = findAll(rawTree, (n) => n.type === 'pre');
  ok(pres.length === 1 && String(pres[0].children).includes('"action"'), 'F26 点开原文后 <pre> 出现且内容是原始入参 JSON');
  /* 键盘 Enter 也能开合 */
  const rowBtn2 = findAll(rawTree, (n) => n.props && n.props.role === 'button')[0];
  let prevented = false;
  rowBtn2.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented = true; } });
  ok(prevented, 'F27 键盘 Enter 触发展开（并 preventDefault）');
  rowBtn2.props.onKeyDown({ key: 'a' });
  rowBtn2.props.onKeyDown(null);
  ok(true, 'F28 非 Enter/Space 与 null 事件不抛错');

  /* —— result / list 信封（**新紧凑形状**：无 spec、有 total/counts/note） —— */
  reset();
  const listPayload = {
    ok: true, total: 56, counts: { done: 55, running: 1 }, shape: 'brief',
    jobs: [
      { id: 'j-1', state: 'done', tag: 'a', model: 'opencode/x', elapsedSec: 3, exitCode: 0 },
      { id: 'j-2', state: 'running', stalled: true, lastTool: 'write' },
    ],
    note: '已省略 6 条更早的 job（共 56 条…）',
  };
  const listProps = {
    phase: 'result', toolName: 'dispatch', callId: 'c4',
    block: { kind: 'tool', callId: 'c4', isError: false, call: { name: 'dispatch', argsRaw: '{"action":"list"}' }, content: [{ type: 'text', text: JSON.stringify(listPayload) }] },
  };
  const lm = S.tvModel(listProps);
  ok(lm.state === 'done' && lm.summary.includes('56') && lm.summary.includes('done×55'),
    `F29 result/list：一行概览 = total + counts（实际 "${lm.summary}"）`);
  ok(lm.note && lm.note.includes('已省略'), 'F30 result/list：note（截断说明）原样带出');
  ok(Array.isArray(lm.jobs) && lm.jobs.length === 2 && lm.facts.every((f) => f.v !== 'undefined'),
    'F31 result/list：jobs 收进模型，且**不假设有 spec**（brief 形状缺 spec 不得产生 undefined 字段）');
  const listTree = renderRow(listProps);
  const listRow = findAll(listTree, (n) => n.props && n.props.role === 'button')[0];
  listRow.props.onClick();
  const listOpen = renderRow(listProps);
  const listText = flatText(listOpen);
  ok(listText.includes('j-1') && listText.includes('exit=0') && listText.includes('stalled'),
    'F32 result/list：展开区逐条一行（id/state/exit/stalled 等 brief 字段）');
  ok(listText.includes('已省略'), 'F33 result/list：展开区显示 note');

  /* —— 其它 ok 信封（status / channel / channels / tail / quota / switch / fallback） —— */
  const cases = [
    [{ action: 'status' }, { ok: true, switch: { enabled: true } }, 'switchOn'],
    [{ action: 'channel' }, { ok: true, channel: { provider: 'plan', model: 'GLM-5.3' } }, 'plan/GLM-5.3'],
    [{ action: 'channels' }, { ok: true, channels: [{ id: 'a' }, { id: 'b' }], warnings: ['w'] }, '2 · provider'],
    [{ action: 'tail' }, { ok: true, id: 'j-9', lines: ['a', 'b', 'c'] }, '3 tvLines'],
    [{ action: 'quota' }, { ok: true, quota: { windows: {} } }, 'secQuota'],
    [{ action: 'fallback' }, { ok: true, enabled: true, chain: ['plan'], targets: [], target: null }, 'fallbackTitle'],
    [{ action: 'dismiss' }, { ok: true, id: 'j-7', state: 'done' }, 'j-7 → done'],
  ];
  for (const [args, payload, expect] of cases) {
    const model = S.tvModel({
      phase: 'result', toolName: 'dispatch', callId: 'cx',
      block: { kind: 'tool', callId: 'cx', isError: false, call: { name: 'dispatch', argsRaw: JSON.stringify(args) }, content: [{ type: 'text', text: JSON.stringify(payload) }] },
    });
    ok(model.state === 'done' && model.summary.includes(expect),
      `F34 其它信封 ${args.action}：一行摘要含「${expect}」（实际 "${model.summary}"）`);
  }

  /* —— 失败信封 —— */
  reset();
  const failProps = {
    phase: 'result', toolName: 'dispatch', callId: 'c5',
    block: { kind: 'tool', callId: 'c5', isError: true, call: { name: 'dispatch', argsRaw: '{"action":"kill","id":"j-x"}' }, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'kill 失败：job 不存在\n（细节）' }) }] },
  };
  const fm = S.tvModel(failProps);
  ok(fm.state === 'failed' && fm.errorText.includes('kill 失败') && fm.summary === 'kill 失败：job 不存在',
    'F35 失败信封：状态 failed、错误全文进展开区、摘要只取首行');
  const failTree = renderRow(failProps);
  const failRow = findAll(failTree, (n) => n.props && n.props.role === 'button')[0];
  failRow.props.onClick();
  const failOpen = renderRow(failProps);
  ok(findAll(failOpen, (n) => String(n.props.className).includes('dsp-tv-err')).length === 1,
    'F36 失败：展开区有错误行（danger 令牌着色）');

  /* —— 未知形状 / 非 JSON / interrupted / isError 无 JSON —— */
  const unknown = S.tvModel({
    phase: 'result', toolName: 'dispatch', callId: 'c6',
    block: { kind: 'tool', callId: 'c6', isError: false, call: { name: 'dispatch', argsRaw: '{}' }, content: [{ type: 'text', text: JSON.stringify({ ok: true, 未来字段: [1, 2, 3] }) }] },
  });
  ok(unknown.state === 'done' && unknown.rawText.includes('未来字段') && unknown.facts.length === 0,
    'F37 未知形状：退化成"已完成 + 原文首行"，原文仍可展开（不丢信息、不猜语义）');
  const plain = S.tvModel({
    phase: 'result', toolName: 'dispatch', callId: 'c7',
    block: { kind: 'tool', callId: 'c7', isError: false, call: { name: 'dispatch', argsRaw: '' }, content: [{ type: 'text', text: '就是一段纯文本\n第二行' }] },
  });
  ok(plain.state === 'done' && plain.summary === '就是一段纯文本' && plain.rawText.includes('第二行'), 'F38 非 JSON 正文：当文本处理');
  const interrupted = S.tvModel({
    phase: 'result', toolName: 'dispatch', callId: 'c8',
    block: { kind: 'tool', callId: 'c8', isError: false, error: { name: 'AbortError', code: 'interrupted' }, call: { name: 'dispatch', argsRaw: '' }, content: [] },
  });
  ok(interrupted.state === 'interrupted', 'F39 interrupted：状态 = interrupted（不是 done/failed）');

  /* —— 绝不抛错：垃圾输入全覆盖 —— */
  reset();
  const junk = [
    undefined, null, 0, '', 'x', [], {}, { phase: 'result' }, { phase: 'start' },
    { phase: 'result', block: 'not-an-object' },
    { phase: 'result', block: { kind: 'tool', content: 'not-an-array' } },
    { phase: 'result', block: { kind: 'tool', content: [{ type: 'text' }], call: null } },
    { phase: 'result', block: { kind: 'tool', content: [null, 42], call: { argsRaw: '{bad json' } } },
    { phase: 'result', block: { kind: 'tool', isError: true, content: [], call: {} } },
    { phase: 'weird', block: { name: 'dispatch' } },
    { phase: 'start', block: { phase: 'start', argsRaw: '{"prompt":{"a":1}}' } },
    { phase: 'result', block: { kind: 'tool', content: [{ type: 'text', text: JSON.stringify({ ok: true, jobs: 'not-array', total: 'x' }) }] } },
    { phase: 'result', block: { kind: 'tool', content: [{ type: 'text', text: JSON.stringify({ ok: true, job: { spec: 'not-object', state: 42 } }) }] } },
  ];
  let threw = null;
  for (const p of junk) {
    try { S.tvModel(p); S.tvFallbackRow(p); renderRow(p); } catch (e) { threw = `${JSON.stringify(p)} → ${e && e.message}`; break; }
  }
  ok(threw === null, `F40 ★ 绝不抛错：${junk.length} 组垃圾输入下 tvModel / tvFallbackRow / 渲染全部不抛${threw ? `（首次失败：${threw}）` : ''}`);
  const junkTree = renderRow(null);
  ok(junkTree && junkTree.type === 'div' && String(junkTree.props.className).includes('dsp-tv-card'),
    'F41 垃圾输入仍渲染出一张卡（不是 null、不是抛错）');
  ok(String(junkTree.props['data-state']) === 'preparing', 'F42 无 block 时退化成 preparing 占位（不谎报已完成）');
  const fb = S.tvFallbackRow({ toolName: 'dispatch', callId: 'c-9' });
  ok(!!fb && flatText(fb).includes('dispatch') && flatText(fb).includes('c-9'), 'F43 兜底行含工具名与 callId');
  ok(S.tvFallbackRow(undefined) !== undefined, 'F44 兜底行容忍 undefined props');
}

/* ═══════════ G. 端到端：真跑 apply()，确认槽位注册真的发生 ═══════════ */
console.log('\nG. 端到端 apply()（真加载 client.js + 桩 ctx）');
{
  const head = { children: [], appendChild(c) { head.children.push(c); return c; }, removeChild() {} };
  globalThis.document = {
    head, documentElement: { appendChild: () => {} },
    createElement: (t) => (t === 'style'
      ? { tagName: 'STYLE', attrs: {}, isConnected: true, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, textContent: '' }
      : { tagName: t.toUpperCase(), attrs: {}, setAttribute() {}, appendChild() {} }),
    getElementById: () => null, querySelector: () => null,
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const ls = new Map();
  globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: { load: (o) => { captured = o; } },
    localStorage: globalThis.localStorage, innerHeight: 900, innerWidth: 1200,
    addEventListener: () => {}, removeEventListener: () => {},
  };
  await import('file:///F:/My Code/dsh-dispatch/dispatch/client.js');
  ok(!!captured && captured.id === 'dsh-dispatch', 'G1 client.js 经 __ModuleLoader__ 注册（id=dsh-dispatch）');

  /* 与其它测试同款的 React 桩（够 apply 注册用；本段只渲染**卡片**这一个组件，故 useState 用平铺记账即可）。 */
  const rtCells = [];
  let rtIdx = 0;
  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    Fragment: 'Fragment',
    Component: class { constructor(p) { this.props = p ?? {}; this.state = {}; } setState() {} },
    useState: (v) => {
      const i = rtIdx; rtIdx += 1;
      if (rtCells[i] === undefined) rtCells[i] = typeof v === 'function' ? v() : v;
      return [rtCells[i], (nv) => { rtCells[i] = typeof nv === 'function' ? nv(rtCells[i]) : nv; }];
    },
    useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
    useCallback: (f) => f, useMemo: (f) => (typeof f === 'function' ? f() : f), useSyncExternalStore: () => undefined,
  };
  const regs = [];
  let applyErr = null;
  try {
    const mod = captured.factory((n) => (n === 'react' ? ReactStub : {}));
    mod.apply({
      slots: { inject: (k, cb) => { cb(); return () => {}; }, register: (o, comp) => { regs.push({ o, comp }); return () => {}; } },
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
      on: () => () => {}, locale: { formatMessage: (m) => String(m?.id ?? m) },
      remote: { $mount: () => Promise.resolve() },
    });
  } catch (e) { applyErr = e; }
  ok(applyErr === null, `G2 apply() 不抛错${applyErr ? `（实际：${applyErr.message}）` : ''}`);
  const tv = regs.find((r) => r.o && r.o.name === 'tool.call.toolview');
  ok(!!tv, 'G3 `tool.call.toolview` 槽位真的被 inject + register（不是只写在注释里）');
  ok(tv && tv.o.key === 'dispatch', `G4 注册 key = dispatch（实际 ${tv?.o?.key}）`);
  ok(tv && typeof tv.comp === 'function', 'G5 注册的是组件函数');
  ok(regs[0] && regs[0].o.name === 'conversation.session.header.actions',
    `G6 首个注册仍是会话头入口（未打乱既有次序；实际 ${regs[0]?.o?.name}）`);
  ok(regs.some((r) => r.o && r.o.name === 'plugins.bundle.config'), 'G7 配置卡注册仍在（未被挤掉）');
  /* 真渲染一次（用真实模块里的组件 + 桩 React）：确认入口不抛、产出卡片根节点。 */
  let tree = null;
  let renderErr = null;
  try {
    tree = tv.comp({
      phase: 'result', toolName: 'dispatch', callId: 'c-rt',
      block: {
        kind: 'tool', callId: 'c-rt', isError: false,
        call: { name: 'dispatch', argsRaw: '{"action":"status"}' },
        content: [{ type: 'text', text: '{"ok":true,"switch":{"enabled":true}}' }],
      },
    });
  } catch (e) { renderErr = e; }
  ok(renderErr === null && !!tree && tree.type === 'div' && tree.props['data-tool'] === 'dispatch',
    `G8 真模块里的组件可渲染出卡片（data-tool=dispatch）${renderErr ? `（抛错：${renderErr.message}）` : ''}`);
}

console.log(`\n===== D1 工具卡片契约：${pass} PASS / 0 FAIL =====`);
process.exit(0);
