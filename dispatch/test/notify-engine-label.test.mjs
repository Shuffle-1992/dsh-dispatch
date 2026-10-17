#!/usr/bin/env node
/**
 * notify-engine-label.test.mjs —— 落地通知的**引擎标签**回归测试（审计 P0-2，用户可见 bug）
 *
 * 事故：摘要行原先对所有 job 硬写 `zcode job …`，于是 **OpenCode / Qoder** 的任务落地后，
 * 通知卡片上写着「zcode job」—— 用户会以为派的是 ZCode。这是"信息说反了"，比不显示更糟。
 *
 * 判据来源必须是 job 自己的引擎：`job.engine`（core 落库）→ `spec.engine`（旧快照兜底）→ 认不出就中性。
 * 本文件同时守 `engineLabelOf` 与 `buildSettleNotice`（正文 + 折叠摘要两处都别写错）。
 */
import { engineLabelOf, buildSettleNotice } from '../notify.mjs';

let pass = 0;
const fails = [];
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); }
  else { fails.push(msg); console.log(`  ✗ ${msg}`); }
};
const eq = (a, b, msg) => ok(a === b, `${msg}${a === b ? '' : `（实际 ${JSON.stringify(a)} / 期望 ${JSON.stringify(b)}）`}`);

/** 造一个最小 job（只带通知用到的字段）。 */
const job = (over = {}) => ({
  id: 'j-test-1', state: 'done', kind: 'prompt', tag: 'zb-x', exitCode: 0,
  engine: 'zcode', spec: {}, ...over,
});

console.log('A. engineLabelOf：两个来源 + 诚实兜底');
{
  eq(engineLabelOf(job({ engine: 'zcode' })), 'zcode', 'A1 job.engine=zcode ⇒ zcode');
  eq(engineLabelOf(job({ engine: 'opencode', spec: { engine: 'opencode' } })), 'opencode', 'A2 job.engine=opencode ⇒ opencode');
  eq(engineLabelOf(job({ engine: 'qoder' })), 'qoder', 'A3 job.engine=qoder ⇒ qoder');
  /* 旧快照：升级前落盘的 job 没有 job.engine，但 spec 里可能有。 */
  eq(engineLabelOf(job({ engine: null, spec: { engine: 'opencode' } })), 'opencode', 'A4 无 job.engine 时回落到 spec.engine');
  eq(engineLabelOf(job({ engine: undefined, spec: { engine: 'qoder' } })), 'qoder', 'A5 spec.engine 同样认 qoder');
  /* 认不出 ⇒ 中性（null），**绝不猜**：猜错比不显示更糟。 */
  /* 认不出 ⇒ **空值**（中性），绝不猜：猜错比不显示更糟。空串是实现的"无标签"表示，
   * 这里只断言"假值"，不钉 null/''（那是内部表示，改名/改类型不该让本测试红）。 */
  ok(!engineLabelOf(job({ engine: null, spec: {} })), 'A6 两个来源都没有 ⇒ 空值（中性，不猜）');
  ok(!engineLabelOf(job({ engine: 'weird-engine-xyz' })), 'A7 未知引擎值 ⇒ 空值（不把内部值直接展示）');
  ok(!engineLabelOf(null), 'A8 传 null 也不抛（通知器在落地竞态里可能拿到空 job）');
}

console.log('\nB. buildSettleNotice：正文与折叠摘要都不得写错引擎');
{
  for (const engine of ['zcode', 'opencode', 'qoder']) {
    const n = buildSettleNotice(job({ engine }));
    ok(String(n.text).includes(`engine=${engine}`), `B1[${engine}] 正文带 engine=${engine}（实际含：${String(n.text).includes(`engine=${engine}`)}）`);
    ok(String(n.summary).startsWith(`${engine} job `), `B2[${engine}] 折叠摘要以「${engine} job」开头（实际：${n.summary}）`);
    ok(!String(n.summary).includes('zcode') || engine === 'zcode',
      `B3[${engine}] 摘要里**不出现**错误的 zcode 标签（实际：${n.summary}）`);
  }
  /* 摘要必须仍然是「引擎 + job + id + 状态」的可扫读形状（面板/通知列表都靠它）。 */
  const s = buildSettleNotice(job({ engine: 'opencode', state: 'paused' }));
  ok(/^opencode job j-test-1 /.test(s.summary), `B4 摘要形状稳定（实际：${s.summary}）`);
  ok(String(s.text).includes('[status: paused]'), 'B5 正文仍带 status（paused 也算落地）');

  /* 认不出引擎时：**不写标签**（中性），而不是写 zcode。 */
  const unknown = buildSettleNotice(job({ engine: null, spec: {} }));
  ok(!/engine=/.test(unknown.text), `B6 引擎未知时正文不编造 engine=（实际：${unknown.text}）`);
  ok(!/^zcode|wird/.test(unknown.summary) && !unknown.summary.includes('zcode'), `B7 引擎未知时摘要不写 zcode（实际：${unknown.summary}）`);
}

console.log(`\n===== 落地通知引擎标签：${pass} PASS / ${fails.length} FAIL =====`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
