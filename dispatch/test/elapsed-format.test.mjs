// ZB-13 回归测试：耗时展示为「XX时XX分XX秒」。
//
// 用户要求：「进程中显示的时间改成 XX时XX分XX秒」。
// 只改**展示层**：数据层的 elapsedSec / heldSec 仍是秒数（number）——
// 那是契约字段（core / wire / CLI 都按秒读写），不能在渲染里改语义。
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const SRC = 'F:\\My Code\\dsh-dispatch\\dispatch\\client.js';
const src = readFileSync(SRC, 'utf8');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log(`  ✓ ${m}`); };

const m = /const fmtSec = \(s\) => \{([\s\S]*?)\n    \};/.exec(src);
assert.ok(m, '未能在 client.js 里定位 fmtSec');
const fmtSec = new Function('s', m[1]);

console.log('格式：恒定三段 XX时XX分XX秒');
{
  const cases = [
    [0, '0时00分00秒'], [1, '0时00分01秒'], [9, '0时00分09秒'], [59, '0时00分59秒'],
    [60, '0时01分00秒'], [61, '0时01分01秒'], [599, '0时09分59秒'], [3599, '0时59分59秒'],
    [3600, '1时00分00秒'], [3661, '1时01分01秒'], [7325, '2时02分05秒'],
    [86399, '23时59分59秒'], [90061, '25时01分01秒'],
  ];
  let bad = 0;
  for (const [inp, want] of cases) {
    const got = fmtSec(inp);
    if (got !== want) { bad += 1; console.log(`    ✗ fmtSec(${inp}) = "${got}"，期望 "${want}"`); }
  }
  ok(bad === 0, `A1 ${cases.length} 个边界值全部输出「XX时XX分XX秒」（分/秒补零到 2 位）`);
}
ok(/^\d+时\d{2}分\d{2}秒$/.test(fmtSec(0)), 'A2 零值也输出三段（0时00分00秒），不省略零位');
ok(/^\d+时\d{2}分\d{2}秒$/.test(fmtSec(3599)), 'A3 不足 1 小时仍显示小时段（0时59分59秒）');

console.log('\n边界与兜底');
ok(fmtSec(null) === '—', 'B1 null → —（未开始/无数据的既有语义不变）');
ok(fmtSec(undefined) === '—', 'B2 undefined → —');
ok(fmtSec(1641.781) === '0时27分21秒', 'B3 小数秒向下取整（1641.781 → 0时27分21秒）');
ok(fmtSec(-5) === '0时00分00秒', 'B4 负数兜底为 0（不出现 -1时… 这种非法显示）');
ok(fmtSec('abc') === '0时00分00秒', 'B5 非数字兜底为 0（不出现 NaN 字样）');
ok(fmtSec('123') === '0时02分03秒', 'B6 数字字符串可被接受');

console.log('\n只改展示层（数据契约不动）');
ok(!/elapsedSec\s*=\s*fmtSec/.test(src), 'C1 不把格式化结果写回 elapsedSec（数据层仍是秒数）');
ok(/h\('span', \{ className: 'dsp-dim' \}, fmtSec\(job\.elapsedSec\)\)/.test(src), 'C2 进程行耗时走 fmtSec（展示层）');
ok(/fmtSec\(lk\.heldSec\)/.test(src), 'C3 文件锁持有时长同格式（同一函数，不产生两套风格）');
{
  // 数据层仍以秒为单位的旁证：core 里按秒计算并保留小数
  const core = readFileSync('F:\\My Code\\dsh-dispatch\\dispatch\\core\\dispatch-core.mjs', 'utf8');
  ok(/out\.elapsedSec = Number\(\(\(nowMs\(\) - Date\.parse\(out\.startedAt\)\) \/ 1000\)\.toFixed\(3\)\)/.test(core),
    'C4 core 仍按秒存 elapsedSec（契约未变，CLI/台账不受影响）');
}

console.log('\n旧格式已清除');
ok(!/toFixed\(1\)\}s`/.test(src), 'D1 渲染层不再有 `${Number(s).toFixed(1)}s` 旧格式');
ok(!/`\$\{Number\(s\)\.toFixed\(1\)\}s`/.test(src), 'D2 确认旧 fmtSec 实现已移除');

console.log(`\n===== ZB-13：${pass} PASS / 0 FAIL =====`);