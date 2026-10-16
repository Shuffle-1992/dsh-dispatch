// ZB-09 回归测试：面板分区渲染顺序（用量与单写者已互换位置）。
//
// 用户要求：「将单写者面板和用量面板互换位置」。
// ZB-29c（用户要求）：**派发分区已移除**（无需手动派发，派发一律由 Agent 经工具完成）——
// 当前顺序：通道 → 用量 → 进程 → 单写者/文件锁。
// client.js 是 cordis 客户端插件（依赖 React / 槽位），无法直接 import，
// 故对源码做**顺序断言** —— 足以钉住"谁排在谁前面"，防止后续编辑无意改回。
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const SRC = 'F:\\My Code\\dsh-dispatch\\dispatch\\client.js';
const src = readFileSync(SRC, 'utf8');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log(`  ✓ ${m}`); };

/* 取出面板 body 里各分区渲染语句的出现位置（按文件顺序 = 渲染顺序） */
const order = [];
for (const m of src.matchAll(/h\(Section, \{ id: SEC\.(\w+)/g)) {
  order.push({ key: m[1], at: m.index });
}
const keys = order.map((o) => o.key);

console.log('分区顺序（源码出现顺序 = 渲染顺序）');
console.log(`  实际 = ${keys.join(' → ')}`);

ok(keys.length === 4, `应有 4 个分区，实际 ${keys.length}`);
ok(keys.includes('channel') && keys.includes('jobs'), 'S1 通道/进程分区都在');
ok(keys.includes('locks') && keys.includes('quota'), 'S2 单写者与用量两个分区都在');
ok(!keys.includes('dispatch'), '★ S2b 派发分区已移除（ZB-29c：派发一律由 Agent 经工具完成）');

const iLocks = keys.indexOf('locks');
const iQuota = keys.indexOf('quota');
const iJobs = keys.indexOf('jobs');

ok(keys.join(' → ') === 'channel → quota → jobs → locks',
  `S4 完整顺序 = 通道 → 用量 → 进程 → 单写者（实际 ${keys.join(' → ')}）`);
ok(iLocks === iJobs + 1, 'S5 单写者仍**紧跟**进程列表之后');
ok(iLocks === keys.length - 1, 'S6 单写者仍在最末');

console.log('\n折叠状态按 id 独立（换位不应串状态）');
ok(/SEC_DEFAULT_OPEN/.test(src), 'S7 默认开闭表仍按 id 定义');
ok(/secKey\(id\)/.test(src) || /section:\$\{id\}/.test(src) || /'dispatch:section:/.test(src),
  'S8 折叠状态持久化键仍按分区 id（与渲染顺序无关）');

console.log(`\n===== ZB-09：${pass} PASS / 0 FAIL =====`);