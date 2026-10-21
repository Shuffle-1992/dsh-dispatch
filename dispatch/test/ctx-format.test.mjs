// ZB-14 回归测试：上下文占用由「90%」改为绝对值「180.9k / 200k」。
//
// 用户要求：「直接显示 180.9k / 200k」（原本显示百分比 90%）。
// 关键精度点：180973 必须显示 **180.9k**（截断），而不是四舍五入的 181.0k。
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const SRC = 'F:\\My Code\\dsh-dispatch\\dispatch\\client.js';
const src = readFileSync(SRC, 'utf8');
/* 反断言（"旧东西不存在"）必须在**剥注释后**的源码上做：
 * 否则有人在源码里写一句解释性注释提到旧标识符（如 "旧的 ctxPct 已删除"）就会假红。
 * 与 panel-style / toolview-card / shared-wire-liveness 用同一个实现（`[^:]` 守卫保住 `https://`）。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const code = stripComments(src);

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log(`  ✓ ${m}`); };

const mFmt = /const fmtCtx = \(n\) => \{([\s\S]*?)\n    \};/.exec(src);
const mLabel = /const ctxLabel = \(j\) => \{([\s\S]*?)\n    \};/.exec(src);
assert.ok(mFmt, '未能在 client.js 里定位 fmtCtx');
assert.ok(mLabel, '未能在 client.js 里定位 ctxLabel');
const fmtCtx = new Function('n', mFmt[1]);
const ctxLabel = new Function('j', 'fmtCtx', mLabel[1]);

console.log('k 档：一位小数且**截断**（不四舍五入）');
{
  const cases = [
    [180973, '180.9k'],   // ★ 用户举例：toFixed(1) 会错成 181.0k
    [183994, '183.9k'],   // T21 实际值
    [199999, '199.9k'],   // 贴近上限：截断保证不虚报成 200.0k
    [100000, '100.0k'],
    [1000, '1.0k'],
    [1234, '1.2k'],
    [28983, '28.9k'],
    [999, '999'],         // <1000 走整数档
  ];
  let bad = 0;
  for (const [inp, want] of cases) {
    const got = fmtCtx(inp);
    if (got !== want) { bad += 1; console.log(`    ✗ fmtCtx(${inp}) = "${got}"，期望 "${want}"`); }
  }
  ok(bad === 0, `A1 ${cases.length} 个值全部正确（含用户举例 180973 → 180.9k）`);
  ok(fmtCtx(180973) !== '181.0k', 'A2 **不是**四舍五入的 181.0k（截断语义）');
  ok(fmtCtx(199999) !== '200.0k', 'A3 199999 不虚报成 200.0k（截断不会超过真实值）');
}

console.log('\nM 档与边界');
ok(fmtCtx(1500000) === '1.50M', 'B1 百万档两位小数（1.50M）');
ok(fmtCtx(2000000) === '2.00M', 'B2 2.00M');
ok(fmtCtx(0) === '0', 'B3 0 → "0"');
ok(fmtCtx(-5) === '0', 'B4 负数兜底为 0');
ok(fmtCtx(null) === '—', 'B5 null → —');
ok(fmtCtx(undefined) === '—', 'B6 undefined → —');
ok(fmtCtx('abc') === '—', 'B7 非数字 → —');
ok(fmtCtx('180973') === '180.9k', 'B8 数字字符串可被接受');

console.log('\nctxLabel：已用 / 上限');
ok(ctxLabel({ contextUsed: 180973, contextWindow: 200000 }, fmtCtx) === '180.9k / 200.0k',
  'C1 用户举例形态 = 180.9k / 200.0k');
ok(ctxLabel({ contextUsed: 28983, contextWindow: 200000 }, fmtCtx) === '28.9k / 200.0k', 'C2 小值也带 k 后缀');
ok(ctxLabel({ contextUsed: null, contextWindow: 200000 }, fmtCtx) === null,
  'C3 已用缺失 → null（ZB-102b：调用方不渲染，避免 `—` 占位与看不懂的百分比）');
ok(ctxLabel({ contextUsed: 180973, contextWindow: null }, fmtCtx) === null, 'C4 上限缺失 → null');
ok(ctxLabel({}, fmtCtx) === null, 'C5 两者都缺 → null');
ok(ctxLabel(null, fmtCtx) === null, 'C6 job 为 null → null');
/* ZB-102b：**不得**退回 contextRatio 百分比（用户明确说看不懂「14.3% ctx」） */
ok(ctxLabel({ contextRatio: 0.143 }, fmtCtx) === null, 'C7 只有 contextRatio ⇒ null（不显示百分比）');

console.log('\n接线（源码断言）');
ok(!/ctxPct/.test(code), 'D1 旧函数 ctxPct 已完全移除（无死代码；剥注释后判定，注释里提及不算）');
ok(/const ctxLabel = \(j\) =>/.test(src), 'D2 新增 ctxLabel');
/* 不用 `[^)]*` 这类脆弱写法：该行含模板串与 `??`，会让正则提前截断（本文件已踩一次）。
 * 改为分两段独立断言：① 进程行调用 ctxLabel；② title 里带 tokens 单位。 */
/* ZB-102b：改为**条件渲染**（拿不到绝对值就整格不渲染）—— 断言结构变了，语义仍锁住。 */
ok(/const cl = ctxLabel\(job\);/.test(src) && /return cl[\s\S]{0,200}: null;/.test(src),
  'D3 进程行改用 ctxLabel，且 null 时不渲染整格');
ok(/title: `\$\{job\.contextUsed\} \/ \$\{job\.contextWindow\} tokens`/.test(src),
  'D4 title 补上 tokens 单位（悬停可看精确值）');
ok(/const fmtCtx = \(n\) =>/.test(src), 'D5 新增 fmtCtx');
ok(/Math\.floor\(v \/ 100\) \/ 10/.test(src), 'D6 k 档用 Math.floor 截断（而非 toFixed 四舍五入）');

console.log(`\n===== ZB-14：${pass} PASS / 0 FAIL =====`);