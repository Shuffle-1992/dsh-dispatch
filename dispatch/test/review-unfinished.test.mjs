/**
 * ZB-118 回归：审查"未完成项"批量修复（8 项）
 *
 * 来源：GLM-5.3 / GLM-5.3-Flash 两份审查报告里**第一轮没做完**的条目，按风险排序：
 *   ① 总开关门禁只有 zcode-run 有 —— 另外三个执行器**直调即可绕过**派发总开关；
 *   ② `timeoutMin` 只校验下界 —— >2^31-1ms 时 Node 把 delay 钳成 **1ms**，看门狗一启动就误杀；
 *   ③ 插件卸载不清 paused 任务的定时器 —— 卸载后 25 秒仍可能拉起新 job；
 *   ④ `spec.__jobId` 死契约（全仓零处赋值）—— `lockBlockersFor` 恒把自己当别人；
 *   ⑤ `killTree` 三份不一致（qoder/codebuddy **无超时**，taskkill 挂住会卡死 runner）；
 *   ⑥ `zcode-run` 不用 `run-line-protocol.mjs`（唯一权威协议文件，手抄字面量会漂移）；
 *   ⑦ qoder/codebuddy 接受 `--memory-ban` 却不打印 `memory-ban=on`（审计位恒 null）；
 *   ⑧ 一次 apply 创建 3 个 `createActionHandler` 实例（靠模块级变量保持一致）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, '..', '..', 'collab-kit');
const read = (p) => readFileSync(p, 'utf8');
const CORE = read(join(HERE, '..', 'core', 'dispatch-core.mjs'));
const WIRE = read(join(HERE, '..', 'wire.host.mjs'));
const INDEX = read(join(HERE, '..', 'index.js'));
const ZRUN = read(join(KIT, 'zcode-run.mjs'));
const ORUN = read(join(KIT, 'opencode-run.mjs'));
const QRUN = read(join(KIT, 'qoder-run.mjs'));
const CRUN = read(join(KIT, 'codebuddy-run.mjs'));

/* ── ① 三个执行器的总开关门禁 ── */
test('ZB-118 ①：opencode/qoder/codebuddy 都有派发总开关门禁（exit 3）', () => {
  for (const [name, src] of [['opencode-run', ORUN], ['qoder-run', QRUN], ['codebuddy-run', CRUN]]) {
    assert.ok(src.includes("from './dispatch-switch.mjs'"), `★ ${name} import 开关模块`);
    assert.ok(src.includes('readDispatchSwitch()'), `★ ${name} 调 readDispatchSwitch`);
    assert.ok(src.includes('派发总开关为「关闭」，拒绝派发'), `★ ${name} 有拒绝文案`);
    assert.ok(/return 3;/.test(src), `★ ${name} 返回退出码 3`);
  }
  /* zcode-run 原本就有（防止被误删） */
  assert.ok(ZRUN.includes('派发总开关为「关闭」，拒绝派发'), 'zcode-run 门禁仍在');
});

/* ── ② timeoutMin 上限 ── */
test('ZB-118 ②：timeoutMin 有上界（Node 定时器 2^31-1 ms）', () => {
  assert.ok(CORE.includes('2147483647'), '★ 校验 Node 定时器上限');
  assert.ok(CORE.includes('timeoutMin 过大'), '有可读错误文案');
  assert.ok(CORE.includes('看门狗一启动就开火误杀'), '说明了后果');
});

/* ── ③ 卸载清理 ── */
test('ZB-118 ③：core 有 dispose，且插件卸载时调用', () => {
  assert.ok(CORE.includes('function dispose()'), '★ core 有 dispose');
  assert.ok(CORE.includes('concurrencyRetryTimers.clear()'), '★ 清并发重试定时器');
  assert.ok(CORE.includes('watchdogs.clear()'), '★ 清看门狗');
  assert.ok(CORE.includes('stopCodebuddyLogin()'), '★ 停登录服务');
  assert.ok(INDEX.includes('dispatcher.dispose?.()'), '★ 卸载时调用 dispose');
});

/* ── ④ __jobId 死契约 ── */
test('ZB-118 ④：lockBlockersFor 用显式 jobId 参数（不再靠 spec.__jobId）', () => {
  /* 注释里会引用旧代码作说明 ⇒ 剥注释后再判 */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
  const body = stripComments(CORE);
  assert.ok(!body.includes('spec.__jobId'), '★ 代码里不再引用 spec.__jobId（注释除外）');
  assert.ok(body.includes('function lockBlockersFor(spec, jobId = null)'), '★ 显式参数');
  assert.ok(body.includes('if (jobId != null && rec.jobId === jobId) continue;'), '★ 正确排除自己的锁');
});

/* ── ⑤ killTree 统一 ── */
test('ZB-118 ⑤：killTree 抽成共享模块，三个执行器都用它', () => {
  const kt = read(join(KIT, 'kill-tree.mjs'));
  assert.ok(kt.includes('export function killTree'), '★ 共享模块导出 killTree');
  assert.ok(kt.includes('timeout:'), '★ taskkill 带超时（防挂死）');
  for (const [name, src] of [['opencode-run', ORUN], ['qoder-run', QRUN], ['codebuddy-run', CRUN]]) {
    assert.ok(src.includes("from './kill-tree.mjs'"), `★ ${name} 用共享 killTree`);
    assert.ok(!/const killTree = \(pid\) =>/.test(src), `★ ${name} 不再有内联实现`);
  }
});

/* ── ⑥ zcode-run 接入行协议 ── */
test('ZB-118 ⑥：zcode-run 的 done 行前缀来自协议文件（不再手抄）', () => {
  assert.ok(ZRUN.includes("from './run-line-protocol.mjs'"), '★ import 协议文件');
  assert.ok(ZRUN.includes("prefixFor('zcode')"), '★ done 行用 prefixFor');
});

/* ── ⑦ memory-ban 确认行 + target 分支注入 ── */
test('ZB-118 ⑦：qoder/codebuddy 打印 memory-ban=on，且 target 分支也注入禁令', () => {
  for (const [name, src] of [['qoder-run', QRUN], ['codebuddy-run', CRUN]]) {
    assert.ok(src.includes('memory-ban=on'), `★ ${name} 打印确认行`);
    /* target 分支不再是"一行 return"（要注入禁令） */
    assert.ok(!/if \(opt\.kind === 'target'\) return `目标：/.test(src), `★ ${name} 的 target 分支已注入禁令`);
  }
});

/* ── ⑧ createActionHandler 复用 ── */
test('ZB-118 ⑧：createRemoteFace / attachHostWire 支持复用外部 handler', () => {
  assert.ok(WIRE.includes('export function createRemoteFace(dispatcher, config = {}, opts = {})'), '★ face 接受 opts');
  assert.ok(WIRE.includes('export function attachHostWire(ctx, dispatcher, config = {}, opts = {})'), '★ attach 接受 opts');
  assert.ok(WIRE.includes('opts.handleAction ?? createActionHandler('), '★ 可复用外部 handler');
  assert.ok(INDEX.includes('attachHostWire(ctx, dispatcher, config, { handleAction })'), '★ index 传同一个 handler');
});
