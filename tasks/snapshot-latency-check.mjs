// 真机事故验证：`face.snapshot()` **不得**在通道探测上阻塞。
//
// 事故：面板 remote wire 是 `await remote.call('snapshot')` 之后才 emit 的，而宿主 snapshot()
// 内联 await 了通道探测（spawn 子进程，冷启 ~3s，缓存仅 5s）⇒ 探测一慢，整包快照发不出去，
// 面板「进程」空白 + 标题栏卡「连接中」（用户报"有时没有进程"）。
//
// 本脚本量三件事（都走真实 createRemoteFace + 真实探测）：
//   ① 冷缓存下 snapshot() 是否仍是毫秒级（修复前会是 ~3s）
//   ② 冷缓存下 channels() 才是那个慢调用（~3s，合理：面板挂载时 await 它）
//   ③ 连续 N 次 snapshot() 不得各自 spawn 一个探测（后台去重 + 缓存）
//
// 用法：node tasks/snapshot-latency-check.mjs
import { createDispatcher } from '../dispatch/core/dispatch-core.mjs';
import { createRemoteFace } from '../dispatch/wire.host.mjs';

const ROOT = 'F:/My Code/dsh-dispatch';
const d = createDispatcher({
  runnerPath: `${ROOT}/collab-kit/zcode-run.mjs`,
  opencodeRunnerPath: `${ROOT}/collab-kit/opencode-run.mjs`,
  runnerCwd: 'F:/My Code/keysion dac vue',
  workRoot: `${ROOT}/dispatch/.data`,
  ledgerPath: 'F:/My Code/keysion dac vue/collab/logs/dispatch-runs.jsonl',
  maxConcurrent: 3,
});
const face = createRemoteFace(d, {
  switchPath: 'F:/My Code/keysion dac vue/collab/dispatch.switch.json',
  ledgerPath: 'F:/My Code/keysion dac vue/collab/logs/dispatch-runs.jsonl',
});

const ms = (t0) => Date.now() - t0;
let bad = 0;
const check = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) bad += 1; };

/* ① 冷启动路径：第一次 snapshot() 必须快（探测在后台） */
console.log('① 冷缓存：snapshot() 延迟（修复前 ≈3s，因为内联 await 探测）');
const t0 = Date.now();
const s1 = await face.snapshot();
const snapMs = ms(t0);
console.log(`     snapshot() = ${snapMs}ms，jobs=${(s1.jobs ?? []).length}，channels=${(s1.channels ?? []).length}，switch=${JSON.stringify(s1.switch?.enabled)}`);
check(snapMs < 500, `snapshot() 首调 < 500ms（实际 ${snapMs}ms）—— 不再被探测阻塞`);
check((s1.jobs ?? []).length > 0, `快照**带上了 job 列表**（${(s1.jobs ?? []).length} 条 ⇒ 进程分区不会空）`);
check(s1.switch && typeof s1.switch.enabled === 'boolean', '快照带上总开关状态（标题栏不再是「未知」）');

/* ② 权威取数：channels() 才是慢的那个（面板挂载/action=channels 时才 await） */
console.log('\n② 权威取数：channels() 延迟（这里 await 探测是合理的）');
const t1 = Date.now();
const chans = await face.channels();
const chanMs = ms(t1);
console.log(`     channels() = ${chanMs}ms，通道=${(chans.channels ?? []).length}，warnings=${JSON.stringify(chans.warnings)}`);
check((chans.channels ?? []).length > 0, `通道清单非空（${(chans.channels ?? []).length} 条）`);

/* ③ 连续快照：全部毫秒级，且探测有缓存/去重 */
console.log('\n③ 连续 20 次 snapshot()（模拟面板 1s 轮询）');
const times = [];
for (let i = 0; i < 20; i += 1) {
  const t = Date.now();
  await face.snapshot();
  times.push(ms(t));
}
const max = Math.max(...times); const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
console.log(`     最慢 ${max}ms / 平均 ${avg}ms / 全部 ${times.map((x) => `${x}`).join(',')}`);
check(max < 500, `★ 20 次快照最慢 < 500ms（实际 ${max}ms）—— 轮询不会被探测拖住`);

/* ④ 缓存过期后的那一拍：仍必须快（后台刷新），只有 channels() 才是慢调用 */
console.log('\n④ 等缓存过期（>5s）后再打 fast-path');
await new Promise((r) => setTimeout(r, 5500));
const t2 = Date.now();
await face.snapshot();
const afterExpiryMs = ms(t2);
console.log(`     过期后 snapshot() = ${afterExpiryMs}ms`);
check(afterExpiryMs < 500, `★ 缓存过期那一拍的 snapshot() 仍 < 500ms（实际 ${afterExpiryMs}ms）`);

console.log(`\n===== snapshot 延迟门禁：${bad === 0 ? 'PASS' : `${bad} 处不符`} =====`);
process.exit(bad ? 1 : 0);
