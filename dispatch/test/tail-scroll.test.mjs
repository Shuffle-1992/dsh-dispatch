// ZB-05 回归测试：tail 输出框的滚动决策（纯函数，不依赖 React / DOM）。
// 覆盖用户报告的两个现象：
//   ① 文本闪烁      → 由"轮询不再 setTail(null)"解决，另由 probe 断言（见下 §静态断言）
//   ② 滚到底弹回顶  → 由 nextTailScroll 解决，本文件逐场景断言
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

/* 从 client.js 里取出 nextTailScroll 的源码并在沙箱里求值。
 * client.js 是 cordis 客户端插件（依赖 React / 槽位），无法直接 import；
 * 但该函数是纯函数，抽源码求值是可靠且不侵入的做法。 */
const SRC = 'F:\\My Code\\zcode-dispatch\\dispatch\\client.js';
const src = readFileSync(SRC, 'utf8');
const m = /function nextTailScroll\(s\) \{([\s\S]*?)\n    \}/.exec(src);
assert.ok(m, '未能在 client.js 里定位 nextTailScroll —— 函数被改名或删除？');
const nextTailScroll = new Function('s', m[1]);

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass += 1; console.log(`  ✓ ${msg}`); };

console.log('nextTailScroll 滚动决策');
const H = 140; // 容器可视高度

/* ── 场景 A：用户滚在中间，内容长度不变 → 精确还原 ── */
{
  const s = { intent: { top: 500, atBottom: false }, scrollTop: 0, scrollHeight: 2000, clientHeight: H };
  ok(nextTailScroll(s) === 500, 'A1 滚在中间(500)：还原到 500（不被弹回顶部）');
}
/* ── 场景 A2：用户滚在中间，内容变长 → 仍还原到原位置 ── */
{
  const s = { intent: { top: 500, atBottom: false }, scrollTop: 0, scrollHeight: 5000, clientHeight: H };
  ok(nextTailScroll(s) === 500, 'A2 内容变长后：仍停在 500（不被新内容顶走）');
}
/* ── 场景 A3：用户滚在中间，内容变短到装得下 → 收敛到上限（不能越界） ── */
{
  const s = { intent: { top: 500, atBottom: false }, scrollTop: 0, scrollHeight: 200, clientHeight: H };
  ok(nextTailScroll(s) === 60, 'A3 内容变短(200/140)：收敛到上限 60（不产生非法 scrollTop）');
}
/* ── 场景 B：用户停在底部，内容增长 → 贴底跟随（关键：多轮都要跟随） ── */
{
  for (const [len, max] of [[440, 300], [560, 420], [700, 560]]) {
    const s = { intent: { top: 300, atBottom: true }, scrollTop: 0, scrollHeight: len, clientHeight: H };
    ok(nextTailScroll(s) === max, `B 停在底部、内容长到 ${len}：贴底到 ${max}（跟随新输出）`);
  }
}
/* ── 场景 C：尚无用户意图（首次渲染）→ 不干预 ── */
{
  const s = { intent: null, scrollTop: 0, scrollHeight: 900, clientHeight: H };
  ok(nextTailScroll(s) === null, 'C 首次渲染：返回 null（不干预浏览器默认）');
}
/* ── 场景 D：内容不足一屏 + 停在底部 → scrollTop 0（贴底 = 顶） ── */
{
  const s = { intent: { top: 0, atBottom: true }, scrollTop: 0, scrollHeight: 100, clientHeight: H };
  ok(nextTailScroll(s) === 0, 'D 内容不足一屏且停在底部：scrollTop=0（不产生负值）');
}

/* ── 静态断言：修「闪烁」的那处守卫必须在（轮询不得清空已显示内容） ── */
console.log('\n静态断言（闪烁根因）');
ok(/if \(!tailLoadedRef\.current\) setTail\(null\);/.test(src),
  'S1 仅首次取数才显示「读取中…」（轮询不再 setTail(null) ⇒ 不闪烁）');
ok(/tailLoadedRef\.current = false;/.test(src),
  'S2 收起时重置 tailLoadedRef（下次展开重新走首次加载）');
ok(!/^\s*setTail\(null\);\s*$/m.test(src),
  'S3 不存在无条件的 setTail(null)（旧的闪烁写法已清除）');
ok(/onScroll:/.test(src) && /atBottom:/.test(src),
  'S4 滚动容器挂了 onScroll 且记录 atBottom 意图');
ok(/useLayoutEffect/.test(src) && /nextTailScroll\(/.test(src),
  'S5 useLayoutEffect 调用 nextTailScroll 校正滚动位置');

console.log(`\n===== ZB-05：${pass} PASS / 0 FAIL =====`);