// ZB-16 回归测试（UI 层）：中文锁名 + 分区改名 + memory 锁删除。
//
// 用户要求：
//   ① repo/memory 改中文名显示，memory 改为「Zcode 记忆锁」；
//   ③ 删除 memory 相关；
//   ⑤ 分区名改为「仓库文件锁」。
//
// ZB-29c（用户要求）：**面板派发表单已整体移除**（无需手动派发，派发一律由 Agent 经
// dispatch 工具完成）——原「派发区锁控件」（C 组）与 parseFiles 单测（D 组）随之删除；
// 锁的意图改由派发方在工具调用里声明（spec.lock / spec.write），core 的校验语义不变。
//
// client.js 无法直接 import（依赖 React / 槽位），故对源码做断言。
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const SRC = 'F:\\My Code\\dsh-dispatch\\dispatch\\client.js';
const src = readFileSync(SRC, 'utf8');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log(`  ✓ ${m}`); };

console.log('① 分区名与中文锁名');
ok(/secLocks: '仓库文件锁'/.test(src), "A1 分区名 = 「仓库文件锁」（ZB-17 用户要求；原为「文件锁 / 记忆锁」）");
ok(/repoLock: '仓库锁'/.test(src), "A2 repo 锁显示为「仓库锁」");
ok(/lockHeld: '持有仓库锁'/.test(src), 'A3 lockHeld 文案同步中文化');
ok(!/memoryLock: 'memory 锁'/.test(src), 'A4 旧的「memory 锁」英文名已移除');
ok(/noFileLocks: '（当前没有文件锁：任务未声明 write，走仓库整锁）'/.test(src),
  'A5 空态文案改为「仓库整锁」（不再提 repo/memory 粗粒度锁）');

console.log('\n③ memory 锁已删除（用户要求 ③）');
{
  // 面板不再渲染 memory 那一格
  const iLock = src.indexOf('function LockStatus');
  const seg = src.slice(iLock, src.indexOf('\n    }', iLock));
  ok(!/memoryLock/.test(seg), 'B1 LockStatus 不再渲染 memory 锁那一格');
  ok(/t\('repoLock'\)/.test(seg) && /t\('queueLen'\)/.test(seg), 'B2 仍显示仓库锁与队列长度');
}
ok(!/lock: 'both'/.test(src), "B3 派发侧不再产生 lock:'both'");
ok(!/lock: 'memory'/.test(src), "B4 派发侧不再产生 lock:'memory'");

console.log('\n② 派发表单已移除（ZB-29c：派发一律由 Agent 经工具完成）');
ok(!/repoLock, setRepoLock/.test(src), '★ C1 派发表单锁控件（仓库文件锁勾选）已随表单移除（文案键保留无渲染）');
ok(!/parseFiles/.test(src), '★ C2 parseFiles 仅服务于派发表单，随之移除');
/* 锁意图契约在 core（工具调用方经 spec.lock / spec.write 声明，core 校验与加锁语义不变）。 */
{
  const coreSrc = readFileSync('F:\\My Code\\dsh-dispatch\\dispatch\\core\\dispatch-core.mjs', 'utf8');
  ok(/spec\.lock 必须是 repo\|none/.test(coreSrc) && /spec\.write/.test(coreSrc),
    'C3 锁意图契约仍在 core：spec.lock / spec.write 校验与加锁（工具调用方声明）');
}

console.log('\nlocale 中英对称');
{
  const zh = JSON.parse(readFileSync('F:\\My Code\\dsh-dispatch\\dispatch\\locale\\zh.json', 'utf8'));
  const en = JSON.parse(readFileSync('F:\\My Code\\dsh-dispatch\\dispatch\\locale\\en.json', 'utf8'));
  const zu = zh.ui ?? zh, eu = en.ui ?? en;
  ok(Object.keys(zu).length === Object.keys(eu).length, `E1 中英 key 数一致（${Object.keys(zu).length}）`);
  for (const k of ['secLocks', 'noFileLocks', 'lockHeld']) {
    ok(zu[k] !== undefined && eu[k] !== undefined, `E2 locale 含 ${k}`);
  }
  ok(zu.secLocks === '仓库文件锁', 'E3 locale 的分区名同步为「仓库文件锁」');
}

console.log(`\n===== ZB-16(UI)：${pass} PASS / 0 FAIL =====`);