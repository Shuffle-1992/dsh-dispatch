/**
 * ZB-28b 回归测试：共享 wire 引用计数（用户报「派发台开始工作时不显示状态灯，切换会话后才显示」）。
 *
 * 根因（详见 client.js createSharedWireRegistry 上方注释）：
 *   ① 旧 `releaseSharedWire()` 无参 —— 谁把计数减到 0 就 dispose **当前** SHARED_WIRE；
 *      且 epoch 重建路径里同一消费被放两次（render 换 wire + effect 清理）⇒ refs 提前漏到 0，
 *      此后任何一次「面板开→关」的 release 都会把**入口还订阅着的 live wire** dispose
 *      （subs.clear + 停轮询）⇒ 状态灯冻结，切换会话重挂载才恢复。
 *   ② waiter 注册晚于就绪 ⇒ epoch 永不 bump ⇒ 永远停在降级 wire。
 *
 * 修法：一次消费一放（render 只 acquire，旧 wire 由 effect 清理单点配对释放）+
 * release 指名 wire（current===wire 守卫）+ REMOTE_READY 补投 + peek 守卫。
 *
 * 本文件两层钉住：
 *   A. **功能回放**：把 client.js 里的 `createSharedWireRegistry` 源码原样取出（花括号配平扫描），
 *      new Function 实例化后重放事故序列与修复后的生命周期。
 *   B. **源码不变量**：配对释放、无参调用绝迹、kind 标签、补投与 peek 守卫。
 */
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const SRC = 'F:\\My Code\\zcode-dispatch\\dispatch\\client.js';
const raw = readFileSync(SRC, 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const code = stripComments(raw);

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log(`  ✓ ${m}`); };

/* ─────────────── A. 功能回放（真实源码实例化） ─────────────── */
console.log('A. createSharedWireRegistry 功能回放');
{
  const anchor = 'function createSharedWireRegistry(createWireImpl)';
  const start = code.indexOf(anchor);
  ok(start >= 0, 'A0 client.js 内找到 createSharedWireRegistry');
  /* 花括号配平扫描取函数全源（不依赖脆弱的行号/结尾正则） */
  let i = code.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  ok(end > start, 'A0b 工厂函数源码边界扫描成功（花括号配平）');
  const factorySrc = code.slice(start, end + 1);
  const makeRegistry = new Function('createWireImpl', `${factorySrc}\nreturn createSharedWireRegistry(createWireImpl);`);

  let next = 0;
  const reg = makeRegistry(() => {
    const w = { name: `W${next += 1}`, disposed: 0, dispose() { this.disposed += 1; } };
    return w;
  });

  // —— 修复后的生命周期逐帧重放（每帧对应 useWire 的一次真实 acquire/release）——
  const a = reg.acquire();            // 入口挂载（remote 未就绪 ⇒ 降级 wire），refs=1
  assert.equal(a.name, 'W1');
  reg.invalidate();                   // remote 就绪：作废降级 wire（dispose + detach）
  assert.equal(a.disposed, 1, 'invalidate 应 dispose 旧 wire 恰好一次');
  assert.equal(reg.peek(), null, 'invalidate 后 peek 为空');

  const b = reg.acquire();            // 入口 render 重建（render 只 acquire），refs=2
  assert.equal(reg.peek(), b);
  reg.release(a);                     // effect 清理：旧 wire 的**唯一**一次释放，refs=1
  assert.equal(b.disposed, 0, '重建后入口持有新 wire，refs 平衡（=1）');
  assert.equal(reg.peek(), b);

  reg.acquire();                      // 面板打开：refs=2
  reg.release(b);                     // 面板关闭：refs=1 —— 入口还持着 ⇒ 不得 dispose
  assert.equal(b.disposed, 0, '★ 面板关闭不得处决入口正持有的共享 wire（正是现场症状的触发帧）');

  reg.release(b);                     // 入口卸载：refs=0 且 current===b ⇒ 此时才 dispose
  assert.equal(b.disposed, 1, '★ 最后一个持有者释放时才真正 dispose（恰好一次）');
  assert.equal(reg.peek(), null);

  // —— 守卫：已退役的旧引用再被放回，不得连带处决当前 wire ——
  const c = reg.acquire();
  reg.invalidate();
  const d = reg.acquire();
  reg.release(c);                     // 放回已退役的 c：refs 归 0 但 current===d ⇒ 不动 d
  assert.equal(d.disposed, 0, 'current===wire 守卫：释放退役引用不得处决当前 wire');
  reg.release(d);
  assert.equal(d.disposed, 1, '恢复正常收尾');
}

/* ─────────────── B. 源码不变量 ─────────────── */
console.log('\nB. 源码不变量（一次消费一放 / 配对释放 / 补投 / kind 标签）');
{
  ok(/function createSharedWireRegistry\(createWireImpl\)/.test(code), 'B1 共享 wire 走 createSharedWireRegistry 工厂');
  ok(/refs === 0 && current && current === wire/.test(code), '★ B2 处决守卫：refs===0 且 current===wire（只动自己那条）');
  ok(/peek\(\) \{ return current; \}/.test(code), 'B3 registry 暴露 peek（回调守卫用）');
  ok(!/releaseSharedWire\(\)/.test(code), '★ B4 无参 releaseSharedWire() 调用绝迹（旧无参形态正是事故源）');
  ok(/ref\.current = \{ wire: acquireSharedWire\(\), epoch: remoteEpoch \};/.test(code),
    '★ B5 useWire render 期**只 acquire**（一次消费一放；旧 render 期 release 正是计数泄漏点）');
  ok(!/releaseSharedWire\(prev/.test(code), '★ B5b render 期**不再 release**（旧 wire 由 effect 清理单点释放）');
  ok(/return \(\) => \{\s*un\(\);\s*releaseSharedWire\(wire\);/.test(code),
    '★ B6 useWire effect 清理：release **自己这条 wire**（唯一释放点，配对）');
  ok(/if \(sharedWires\.peek\(\)\?\.kind !== 'remote'\) invalidateSharedWire\(\);/.test(code),
    '★ B7 回调守卫：当前已是 remote wire 时**不**作废（补投不得处决别人的 live wire）');
  ok(/let REMOTE_READY = false;/.test(code), 'B8 REMOTE_READY 旗标声明');
  ok(/remoteWaiters\.add\(fn\);[\s\S]{0,200}if \(REMOTE_READY\) \{\s*try \{ fn\(\); \} catch/.test(code),
    '★ B9 onRemoteReady **补投**：旗标已立时立即触发（兜 waiter 注册晚于就绪的竞态）');
  ok(/REMOTE_READY = true;/.test(code) && /markRemoteReady\(svc\) \{[\s\S]{0,120}REMOTE_READY = true;/.test(code),
    'B10 markRemoteReady 置位旗标');

  for (const k of ['remote', 'ext', 'offline', 'demo', 'dead']) {
    ok(new RegExp(`kind: '${k}',`).test(code), `B11 wire 带 kind 标签：'${k}'`);
  }
}

console.log(`\n===== ZB-28b 共享 wire 存活哨兵：${pass} PASS / 0 FAIL =====`);
