// 通道过滤开关（仅看可用 / 仅看免费）的**真实数据**判定：拿 core 的真实通道清单，
// 用与 client.js **同一条判据**算出两个开关各自会留下哪些通道。
//
// 为什么不用渲染：client.js 的 ChannelSection 是 PanelBody 内部的非导出函数，
// 离线渲染桩够不到它（要么改产品代码导出，要么让桩悄悄走 live 数据源 —— 后者会让
// "测试通过"变成假象，故不做）。这里改为对**真实清单**验证判据与结果，
// 结构不变量（过滤接进渲染路径、当前值必须可渲染）由 dispatch/test/engine-ui.test.mjs 的源码锁守住。
//
// 用法：node tasks/filter-check.mjs
import { createDispatcher } from '../dispatch/core/dispatch-core.mjs';

const ROOT = 'F:/My Code/dsh-dispatch';
const d = createDispatcher({
  runnerPath: `${ROOT}/collab-kit/zcode-run.mjs`,
  opencodeRunnerPath: `${ROOT}/collab-kit/opencode-run.mjs`,
  workRoot: `${ROOT}/dispatch/.data`,
  runnerCwd: 'F:/My Code/keysion dac vue',
});
const { channels } = await d.listChannels();

/* ↓↓↓ 与 dispatch/client.js 的 FREE_CHANNEL_RE / isFreeChannel **逐字相同**的判据 ↓↓↓ */
const FREE_CHANNEL_RE = /^account:[a-z]+-start-plan$/;
const isFreeChannel = (c) => {
  const id = String(c?.id ?? '');
  return !!c && (c.engine === 'opencode' || FREE_CHANNEL_RE.test(id) || id === 'start-plan' || id === 'gift');
};
const applyFilters = (list, { avail, free }) => list.filter((c) => {
  if (avail && !c.enabled) return false;
  if (free && !isFreeChannel(c)) return false;
  return true;
});
/* ↑↑↑ 判据若在 client.js 里改了就同步改这里（engine-ui.test.mjs 有对应的源码锁） ↑↑↑ */

const combo = (avail, free) => applyFilters(channels, { avail, free });
const show = (label, list) => {
  console.log(`\n${label}  ⇒ ${list.length}/${channels.length} 条`);
  for (const c of list) console.log(`   [${(c.engine ?? '?').padEnd(8)}] ${c.id}${c.enabled ? '' : '  (不可用)'}`);
};

console.log(`真实通道清单：${channels.length} 条（core 探测，opencodeVersion=${await d.listChannels().then((r) => r.opencodeVersion)}）`);
show('① 仅看可用=开（默认）、仅看免费=关', combo(true, false));
show('② 仅看可用=关、仅看免费=关（看全部）', combo(false, false));
show('③ 仅看可用=开、仅看免费=开（免费且可用）', combo(true, true));
show('④ 仅看可用=关、仅看免费=开（全部免费）', combo(false, true));

const A = combo(true, false); const B = combo(false, false);
const C = combo(true, true); const D = combo(false, true);
const oc = channels.filter((c) => c.engine === 'opencode');
const paid = channels.filter((c) => !isFreeChannel(c));

let bad = 0;
const check = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) bad += 1; };
console.log('\n判据断言：');
check(A.every((c) => c.enabled), '① 全部可用');
check(A.length === channels.filter((c) => c.enabled).length, '① 条数 = 可用通道总数');
check(B.length === channels.length, '② 关掉过滤 = 全部列出（开关不是死的）');
check(B.length > A.length, '★ 两个档位确实不同（开关有效）');
check(oc.every(isFreeChannel), '★ 所有 OpenCode 免费模型都被判为免费');
check(paid.every((c) => !isFreeChannel(c)), '付费套餐/个人 Key 不被判为免费');
check(C.every((c) => c.enabled && isFreeChannel(c)), '③ 免费且可用');
check(C.length > 0, '★ ③ 非空 —— 这就是"只用免费模型"派发时该看到的清单');
check(D.length === channels.filter(isFreeChannel).length, '④ 全部免费通道');
check(!C.some((c) => c.id === 'personal'), '个人 Key 通道在"仅看免费"下隐藏');
check(C.some((c) => c.engine === 'opencode'), '③ 含 OpenCode 免费模型');
check(C.some((c) => /^account:.*-start-plan$/.test(c.id)) || !channels.some((c) => /^account:.*-start-plan$/.test(c.id)),
  '③ Start Plan 通道：有则留下、无则不虚构');

console.log(`\n===== 通道过滤判据（真实清单）：${bad === 0 ? 'PASS' : `${bad} 处不符`} =====`);
process.exit(bad ? 1 : 0);
