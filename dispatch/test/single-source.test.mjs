// ZB-25 单源哨兵：把「同一事实被写在多处」的几组**锁死成可自动验收**的不变量。
//
// 起因（2026-10-05 五路审计的共同结论）：派发台有 15 组「同事实多处定义」，其中 7 组**已经漂移**。
// 光把当前值改一致没用 —— 下次加动作/加方法/改常量还会漂。所以本文件只做一件事：
// 断言这些事实**只有一个源**（能取引用就断引用同一性，跨 runtime 不能 import 的就断逐字相等）。
//
// 覆盖四组（都有实际漂移史）：
//   ① 动作清单：wire.host.ACTIONS ← index.js 工具 schema / 报错串（曾漏 wait）
//   ② 落地/终态集合：core.TERMINAL_STATES/SETTLED_STATES ← wire.DISMISSABLE / notify.SETTLE_STATES
//   ③ remote 方法表：host 15 / client.js 15 / wire.client.mjs（曾缺 dismiss 只有 14）
//   ④ host↔client 协议常量：FACE_NAME / EVENT_NAME / JSON_ANY / REMOTE_POLL_MS（跨 runtime，只能逐字比）
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(PKG, f), 'utf8');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log(`  ✓ ${m}`); };

/* ---------------- ① 动作清单单源 ---------------- */
console.log('① 动作清单（单一源：wire.host.mjs 的 ACTIONS）');
{
  const host = await import(new URL('../wire.host.mjs', import.meta.url).href);
  const idx = read('index.js');
  const wireSrc = read('wire.host.mjs');
  const actions = host.ACTIONS;

  ok(Array.isArray(actions) && actions.length >= 13, `ACTIONS 已导出（${actions.length} 个）`);
  ok(/const ACTIONS = HOST_ACTIONS;/.test(idx), 'index.js 的动作清单取自 wire.host（不再本地字面量复制）');
  ok(!/const ACTIONS = \[/.test(idx), 'index.js 里已无第二份动作字面量数组');

  // switch 的实际分支集 == ACTIONS（用源码解析：每个 case 'x': 都必须是动作，且每个动作都有 case）
  const cases = [...wireSrc.matchAll(/^\s{8}case '([a-z]+)':/gm)].map((m) => m[1]);
  const uniq = [...new Set(cases)];
  const missingCase = actions.filter((a) => !uniq.includes(a));
  const extraCase = uniq.filter((a) => !actions.includes(a));
  ok(missingCase.length === 0, `ACTIONS 里每个动作都有 switch 分支（缺：${missingCase.join(',') || '无'}）`);
  ok(extraCase.length === 0, `switch 里没有 ACTIONS 之外的分支（多：${extraCase.join(',') || '无'}）`);

  // 报错串必须由 ACTIONS 派生（曾手抄一份、漏 wait ⇒ 模型看不到「派发后等结果」这条正路）
  ok(/未知 action：\$\{action\}（可用 \$\{ACTIONS\.join\('\|'\)\}）/.test(wireSrc),
    '「未知 action」报错串由 ACTIONS.join 生成（不再手抄）');
  ok(actions.includes('wait'), "wait 在动作清单里（ZB-08 加它时的漂移点）");
  // 工具 schema 的 enum 必须与 ACTIONS 同源
  ok(/action: \{ type: 'string', required: true, enum: ACTIONS/.test(idx), '工具 schema 的 action.enum === ACTIONS');
}

/* ---------------- ② 落地/终态集合单源 ---------------- */
console.log('\n② 落地/终态集合（单一源：core/dispatch-core.mjs）');
{
  const core = await import(new URL('../core/dispatch-core.mjs', import.meta.url).href);
  const wire = await import(new URL('../wire.host.mjs', import.meta.url).href);
  const notify = await import(new URL('../notify.mjs', import.meta.url).href);

  ok(core.TERMINAL_STATES instanceof Set && core.TERMINAL_STATES.size === 4, 'core 导出 TERMINAL_STATES（4 个终态）');
  ok(core.SETTLED_STATES instanceof Set && core.SETTLED_STATES.size === 5, 'core 导出 SETTLED_STATES（终态 + paused）');
  ok(core.SETTLED_STATES.has('paused') && !core.TERMINAL_STATES.has('paused'), 'paused 只在 SETTLED_STATES（语义：paused 算落地、不算终态）');
  for (const s of core.TERMINAL_STATES) ok(core.SETTLED_STATES.has(s), `SETTLED 含终态 ${s}`);
  // ★ 引用同一性（不是值相等）：任何人重新内联一份字面量集合，这里立刻红
  ok(wire.DISMISSABLE === core.SETTLED_STATES, '★ wire.DISMISSABLE 与 core.SETTLED_STATES 是**同一个对象**（引用级）');
  ok(notify.SETTLE_STATES === core.SETTLED_STATES, '★ notify.SETTLE_STATES 与 core.SETTLED_STATES 是**同一个对象**（引用级）');
  const wireSrc = read('wire.host.mjs');
  ok(!/new Set\(\['paused'/.test(wireSrc), 'wire.host.mjs 里不再有就地新建的落地集合字面量');
  ok(!/new Set\(\['done', 'failed'/.test(read('notify.mjs')), 'notify.mjs 里不再有就地新建的终态集合字面量');
}

/* ---------------- ③ remote 方法表三份一致 ---------------- */
console.log('\n③ remote 方法表（host 面 / client.js 内联表 / wire.client.mjs 描述符表）');
{
  const wireSrc = read('wire.host.mjs');
  const clientSrc = read('client.js');
  const wcSrc = read('wire.client.mjs');
  const hostMethods = JSON.parse(read('wire.host.mjs').match(/const REMOTE_METHODS = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
  /* 两张表的**字面量块**各自精确捕获后再逐行取方法名（别用整文件松正则 —— 会把别的表也扫进来；
   * 也要注意 wire.client.mjs 的表是对象里的 `descriptors: [...]`，不是顶层数组）。 */
  const namesIn = (src, re) => {
    const m = src.match(re);
    if (!m) return [];
    return [...m[1].matchAll(/^\s*\['([a-zA-Z]+)',/gm)].map((x) => x[1]);
  };
  const clientMethods = namesIn(clientSrc, /const REMOTE_METHOD_TABLE = \[([\s\S]*?)\n\s*\];/);
  const descMethods = namesIn(wcSrc, /descriptors: \[([\s\S]*?)\n\s*\]\.map\(/);
  const sorted = (a) => [...new Set(a)].sort().join(',');
  ok(hostMethods.length === 15, `host REMOTE_METHODS 15 个（实际 ${hostMethods.length}）`);
  ok(sorted(descMethods) === sorted(hostMethods), `wire.client.mjs 描述符表与 host 方法集相等（${descMethods.length} vs ${hostMethods.length}）`);
  ok(clientMethods.length > 0 && sorted(clientMethods) === sorted(hostMethods),
    `client.js 内联方法表与 host 方法集相等（${clientMethods.length} vs ${hostMethods.length}）`);
  ok(descMethods.includes('dismiss') && hostMethods.includes('dismiss') && clientMethods.includes('dismiss'),
    "三份表都含 dismiss（审计三路同报的漂移点已修）");
  // 调用面：client.js 的 remote.call('x', …) 只能出现在已知方法里
  const called = [...clientSrc.matchAll(/remote\.call\('([a-zA-Z]+)'/g)].map((m) => m[1]);
  const unknownCall = [...new Set(called)].filter((m) => !hostMethods.includes(m));
  ok(unknownCall.length === 0, `client.js 调用的 remote 方法都在 host 面内（越界：${unknownCall.join(',') || '无'}）`);
}

/* ---------------- ④ host↔client 协议常量逐字相等 ---------------- */
console.log('\n④ host↔client 协议常量（两个 runtime 不能互相 import ⇒ 只能逐字比）');
{
  const grab = (src, name) => {
    const m = src.match(new RegExp(`(?:export )?const ${name}\\s*=\\s*([^;]+);`));
    return m ? m[1].trim() : null;
  };
  const host = read('wire.host.mjs');
  const wc = read('wire.client.mjs');
  const cl = read('client.js');
  for (const name of ['FACE_NAME', 'EVENT_NAME', 'JSON_ANY']) {
    const a = grab(host, name), b = grab(wc, name);
    ok(a != null && b != null && a === b, `${name} 在 wire.host 与 wire.client 逐字相等（${a}）`);
  }
  const a = grab(wc, 'REMOTE_POLL_MS'), b = grab(cl, 'REMOTE_POLL_MS');
  ok(a != null && b != null && a === b, `REMOTE_POLL_MS 在内联 wire 与 wire.client 逐字相等（${a}）`);
  /* 这些常量漂移的后果是**静默降级**（推送收不到就退回轮询、face 找不到就退回演示数据），
   * 不报错 —— 所以必须有本哨兵；上面每一条都是"改一处忘另一处"的现场防复发。 */
}

/* ---------------- ⑤ 文案双份同源：内嵌 STRINGS ↔ locale/*.json 逐键逐值 ---------------- */
console.log('\n⑤ 界面文案（client.js 内嵌 STRINGS ↔ locale/*.json）');
{
  /* 「双份同源」是既定设计（浏览器模块表取不到本包 locale 文件），但**只有 key 数相等**被守过：
   * 审计 E 发现 `grip` 的**值**已经漂移（client「拖拽调整宽高（自动保存）」 vs locale「拖拽调整宽度」），
   * 而键数相等完全测不出来。这里把值也锁上。 */
  const src = read('client.js');
  const m = src.match(/\n\s{4}const STRINGS = \{([\s\S]*?)\n\s{4}\};/);
  ok(!!m, '能从 client.js 里取出 STRINGS 字面量');
  const strings = new Function(`return {${m[1]}};`)();
  const zhLocale = JSON.parse(read('locale/zh.json')).ui;
  const enLocale = JSON.parse(read('locale/en.json')).ui;
  ok(Object.keys(strings.zh).length === Object.keys(zhLocale).length,
    `zh 键数一致（STRINGS ${Object.keys(strings.zh).length} / locale ${Object.keys(zhLocale).length}）`);
  const diffs = [];
  for (const lang of ['zh', 'en']) {
    const loc = lang === 'zh' ? zhLocale : enLocale;
    const emb = strings[lang];
    for (const k of new Set([...Object.keys(emb), ...Object.keys(loc)])) {
      if (emb[k] !== loc[k]) diffs.push(`${lang}.${k}: STRINGS=${JSON.stringify(emb[k])} locale=${JSON.stringify(loc[k])}`);
    }
  }
  ok(diffs.length === 0, `两语言逐键逐值一致（差异 ${diffs.length} 处）${diffs.length ? '：' + diffs.slice(0, 3).join(' | ') : ''}`);
}

console.log(`\n===== ZB-25 单源哨兵：${pass} PASS / 0 FAIL =====`);
