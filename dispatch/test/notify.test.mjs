/**
 * ZB-22 回归测试：任务落地自动唤醒（settle notice）。
 *
 * 用户问题：「派发台派了任务，会话窗口不等待、继续往下走；任务跑完了没人叫醒它，
 * 得我自己再发一句才继续。DSH 的后台任务完成时会自动把会话拉起来，派发台也应该这样。」
 *
 * 本测试锁死的就是那个缺口：job 落地 → 发起会话收到一条可被客户端渲染的通知，
 * 空闲会话 followup（开新一轮）、忙碌会话 inject（插下一步），且与 dsh-tool-jobs 同语义地
 * 抑制「自己 kill 的 / 自己 wait 到的」job。全部用桩 dispatcher/agents，不跑子进程（确定性）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_SUMMARY_MAX_CHARS,
  SETTLE_STATES,
  SOURCE_FORM,
  SOURCE_KIND,
  boundSummary,
  buildSettleNotice,
  createNoticeMessage,
  createSettleNotifier,
} from '../notify.mjs';

/** 桩调度器：subscribe/get 与 dispatch-core 的事件形状一致（{type:'job-updated', job}）。 */
function stubDispatcher() {
  const subs = new Set();
  const jobs = new Map();
  return {
    jobs,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    get(id) { return jobs.get(id) ?? null; },
    /** 落一个 job 并广播（模拟 core 的 emit('job-updated', job)）。 */
    settle(job) {
      jobs.set(job.id, job);
      for (const fn of [...subs]) fn({ type: 'job-updated', job });
    },
  };
}

/** 桩会话：记录 followup/inject 调用。 */
function stubAgent(id, status = 'idle') {
  const calls = [];
  return {
    id,
    status,
    calls,
    followup(m) { calls.push(['followup', m]); },
    inject(m) { calls.push(['inject', m]); },
  };
}

function harness({ config = {}, agentStatus = 'idle', withCtx = false } = {}) {
  const dispatcher = stubDispatcher();
  const owner = stubAgent('sess-1', agentStatus);
  const others = new Map([['sess-1', owner]]);
  const agents = { get: (id) => others.get(id) };
  const logs = [];
  const handlers = [];
  const ctx = withCtx
    ? { on(ev, fn) { handlers.push([ev, fn]); return () => { handlers.length = 0; }; } }
    : undefined;
  const notifier = createSettleNotifier({
    dispatcher,
    agents,
    log: (level, msg) => logs.push([level, msg]),
    config,
    ctx,
  });
  return { dispatcher, owner, others, notifier, logs, handlers };
}

const job = (id, state, extra = {}) => ({ id, state, spec: { kind: 'edit', tag: 'T' }, ...extra });

test('空闲会话：job 落地 → followup 唤醒，消息形态符合客户端契约', () => {
  const { dispatcher, owner, notifier } = harness();
  notifier.track('j-1', 'sess-1');
  dispatcher.settle(job('j-1', 'done', { exitCode: 0 }));

  assert.equal(owner.calls.length, 1, '应恰好唤醒一次');
  const [kind, msg] = owner.calls[0];
  assert.equal(kind, 'followup', '空闲会话必须用 followup（inject 不带 wakeup，叫不醒）');
  assert.equal(msg.role, 'user');
  assert.equal(msg.source.kind, SOURCE_KIND);
  assert.equal(msg.source.form, SOURCE_FORM, "form 必须是客户端已认识的 'notice'（unknown form 会让客户端抛错）");
  assert.ok(msg.source.summary.length <= CONTEXT_SUMMARY_MAX_CHARS);
  assert.ok(typeof msg.id === 'string' && msg.id.length > 0, '消息必须有稳定 id');
  assert.ok(Object.isFrozen(msg));
  assert.match(msg.content[0].text, /j-1/);
  assert.match(msg.content[0].text, /status: done/);
  assert.match(msg.content[0].text, /action=tail/);
  notifier.dispose();
});

test('忙碌会话：job 落地 → inject（插进下一步，不打断本轮）', () => {
  const { dispatcher, owner, notifier } = harness({ agentStatus: 'running' });
  notifier.track('j-2', 'sess-1');
  dispatcher.settle(job('j-2', 'failed', { exitCode: 1 }));
  assert.equal(owner.calls.length, 1);
  assert.equal(owner.calls[0][0], 'inject');
  notifier.dispose();
});

test('五个落地态都唤醒（paused 也算落地 —— 要人来决定续跑/换通道）', () => {
  for (const state of SETTLE_STATES) {
    const { dispatcher, owner, notifier } = harness();
    notifier.track(`j-${state}`, 'sess-1');
    dispatcher.settle(job(`j-${state}`, state));
    assert.equal(owner.calls.length, 1, `${state} 应唤醒`);
    notifier.dispose();
  }
});

test('未落地的中间态不唤醒；只有落地那一刻唤醒一次（幂等）', () => {
  const { dispatcher, owner, notifier } = harness();
  notifier.track('j-3', 'sess-1');
  dispatcher.settle(job('j-3', 'queued'));
  dispatcher.settle(job('j-3', 'running'));
  assert.equal(owner.calls.length, 0, 'queued/running 不该唤醒');
  dispatcher.settle(job('j-3', 'done'));
  dispatcher.settle(job('j-3', 'done'));
  dispatcher.settle(job('j-3', 'done', { exitCode: 0 }));
  assert.equal(owner.calls.length, 1, '落地只唤醒一次');
  notifier.dispose();
});

test('不是本会话派发的 job 不唤醒（面板/别的会话派的都不叫醒我）', () => {
  const { dispatcher, owner, notifier } = harness();
  dispatcher.settle(job('j-foreign', 'done'));
  assert.equal(owner.calls.length, 0);
  notifier.dispose();
});

test('登记晚于落地：track 时立刻补一次判定（不丢通知）', () => {
  const { dispatcher, owner, notifier } = harness();
  dispatcher.settle(job('j-late', 'killed')); // 先落地（事件已错过）
  notifier.track('j-late', 'sess-1'); // 后登记
  assert.equal(owner.calls.length, 1, 'track 必须自己补判一次');
  notifier.dispose();
});

test('模型自己 kill 的 job 不唤醒（否则等于自己叫醒自己）', () => {
  const { dispatcher, owner, notifier } = harness();
  notifier.track('j-4', 'sess-1');
  notifier.markKilled('j-4');
  dispatcher.settle(job('j-4', 'killed'));
  assert.equal(owner.calls.length, 0);
  notifier.dispose();
});

/* ★ ZB-25（审计 A#1 实测复现）：抑制登记**必须早于** dispatcher.kill()。
 * core 的 kill() 对 queued job 会就地置 killed 并**同步** emit 'job-updated'，
 * 订阅者在那一刻就投递；若像最初那样"等 handleAction 返回再 markKilled"，排队中的 job
 * 仍会被唤醒一次，而且没有任何报错。本组测试把这个顺序差异钉死。 */
test('★ kill 抑制的顺序：先登记后 kill（真实顺序）不唤醒', () => {
  const { dispatcher, owner, notifier } = harness();
  const killSync = (id) => { notifier.track(id, 'sess-1'); }; // 复刻工具层：先 track（dispatch 返回时）
  killSync('j-k1');
  notifier.markKilled('j-k1');           // ← 工具层 pre-hook：在 handleAction('kill') 之前
  dispatcher.settle(job('j-k1', 'killed')); // ← core.kill() 内部的同步 emit
  assert.equal(owner.calls.length, 0, '真实顺序下不该唤醒');
  notifier.dispose();
});

test('★ kill 抑制的顺序：登记晚于落地（错误顺序）会唤醒 —— 这就是 ZB-25 要防的回归', () => {
  const { dispatcher, owner, notifier } = harness();
  notifier.track('j-k2', 'sess-1');
  dispatcher.settle(job('j-k2', 'killed')); // 先落地（等于 core.kill() 同步 emit）
  notifier.markKilled('j-k2');              // 后登记 —— 已经晚了
  assert.equal(owner.calls.length, 1, '顺序错了就会"自己叫醒自己"（本断言记录该缺陷的存在性）');
  notifier.dispose();
});

test('kill 未成功时撤销预登记（unmarkSuppressed），真实落地仍能唤醒', () => {
  const { dispatcher, owner, notifier } = harness();
  notifier.track('j-k3', 'sess-1');
  notifier.markKilled('j-k3');     // pre-hook 先登记
  notifier.unmarkSuppressed('j-k3'); // kill 返回 ok:false ⇒ 回滚
  dispatcher.settle(job('j-k3', 'done'));
  assert.equal(owner.calls.length, 1, '回滚后该唤醒的仍要唤醒');
  notifier.dispose();
});

test('投递后释放归属，集合不随历史 job 无界增长（审计 A#4）', () => {
  const { dispatcher, notifier } = harness();
  notifier.track('j-cap', 'sess-1');
  assert.equal(notifier.stats().tracked, 1);
  dispatcher.settle(job('j-cap', 'done'));
  assert.equal(notifier.stats().tracked, 0, '投递完 owners 应释放该条');
  notifier.dispose();
});

test('模型自己 wait 到落地的 job 不唤醒（结果已由工具调用返回）', () => {
  const { dispatcher, owner, notifier } = harness();
  notifier.track('j-5', 'sess-1');
  notifier.markAwaited('j-5');
  dispatcher.settle(job('j-5', 'done'));
  assert.equal(owner.calls.length, 0);
  notifier.dispose();
});

test('会话已不在：只记一条 warn，不抛、不重复刷日志', () => {
  const { dispatcher, notifier, logs } = harness();
  notifier.track('j-6', 'sess-gone');
  assert.doesNotThrow(() => dispatcher.settle(job('j-6', 'done')));
  assert.equal(logs.filter(([l]) => l === 'warn').length, 1);
  assert.equal(notifier.stats().missingAgent, 1);
  notifier.dispose();
});

test('无会话 id（非 agent 调用）：不登记、不唤醒', () => {
  const { dispatcher, owner, notifier } = harness();
  assert.equal(notifier.track('j-7', ''), false);
  dispatcher.settle(job('j-7', 'done'));
  assert.equal(owner.calls.length, 0);
  notifier.dispose();
});

test('maxConsecutiveWakes：超上限后改为 inject（不再开新一轮）', () => {
  const { dispatcher, owner, notifier } = harness({ config: { maxConsecutiveWakes: 1 }, withCtx: true });
  notifier.track('a', 'sess-1');
  dispatcher.settle(job('a', 'done'));
  notifier.track('b', 'sess-1');
  dispatcher.settle(job('b', 'done'));
  assert.deepEqual(owner.calls.map((c) => c[0]), ['followup', 'inject']);
  assert.equal(notifier.stats().capped, 1);
  notifier.dispose();
});

test('用户说话后连续唤醒预算清零（agent/inbox/claimed 的 user 消息）', () => {
  const { dispatcher, owner, notifier, handlers } = harness({ config: { maxConsecutiveWakes: 1 }, withCtx: true });
  const claimed = handlers.find(([ev]) => ev === 'agent/inbox/claimed');
  assert.ok(claimed, '必须订阅 agent/inbox/claimed 才能复位预算');
  notifier.track('a', 'sess-1');
  dispatcher.settle(job('a', 'done'));
  claimed[1]({ agent: owner, message: { source: { kind: 'user' } } }); // 用户说了话
  notifier.track('b', 'sess-1');
  dispatcher.settle(job('b', 'done'));
  assert.deepEqual(owner.calls.map((c) => c[0]), ['followup', 'followup'], '预算应已复位');
  notifier.dispose();
});

test('dispose 后不再唤醒（插件卸载/热重载不留悬挂订阅）', () => {
  const { dispatcher, owner, notifier } = harness();
  notifier.track('j-8', 'sess-1');
  notifier.dispose();
  dispatcher.settle(job('j-8', 'done'));
  assert.equal(owner.calls.length, 0);
});

test('notice 文本与摘要：只带必要信息，摘要不超客户端上限', () => {
  const n = buildSettleNotice(job('j-9', 'paused', { pauseReason: 'quota-exhausted' }));
  assert.match(n.text, /已暂停/);
  assert.match(n.text, /quota-exhausted/);
  assert.match(n.text, /action=retry/);
  const long = boundSummary('x'.repeat(500));
  assert.equal(long.length, CONTEXT_SUMMARY_MAX_CHARS);
  assert.ok(long.endsWith('…'));
});

test('createNoticeMessage：正文/摘要缺省不炸（旧 job 快照字段不全）', () => {
  const msg = createNoticeMessage({});
  assert.equal(msg.content[0].text, '');
  assert.equal(msg.source.summary, '');
  assert.equal(msg.role, 'user');
});

test('createSettleNotifier 缺 dispatcher 直接抛（配置错误早暴露）', () => {
  assert.throws(() => createSettleNotifier({}), /需要提供 dispatcher/);
});

/* ───────── 工具层接线：handleAction 的返回信封 ⟶ 唤醒簿记（ZB-22 §「谁派发的」） ─────────
 * 这段是「派发台派的任务能不能叫醒派发它的那个会话」的**唯一来源**：工具 execute(args, exec)
 * 里的 exec.agent.id。真机上工具注册要宿主 dsh-tools，无法在纯 node 里端到端跑，
 * 所以这里直接锁 index.js 导出的译码函数（noteOwnerAction）。 */
test('noteOwnerAction：dispatch/retry 登记归属，kill/wait 抑制，其余不动', async () => {
  const { noteOwnerAction } = await import('../index.js');
  const tracked = [];
  const killed = [];
  const awaited = [];
  const hooks = {
    notifier: { current: { track: (id, a) => tracked.push([id, a]), markKilled: (id) => killed.push(id), markAwaited: (id) => awaited.push(id) } },
    log: () => {},
  };
  const exec = { agent: { id: 'sess-9' } };

  noteOwnerAction(hooks, { action: 'dispatch' }, { ok: true, job: { id: 'j-a', state: 'queued' } }, exec);
  assert.deepEqual(tracked, [['j-a', 'sess-9']], 'dispatch 成功必须登记 job→会话');

  noteOwnerAction(hooks, { action: 'retry', id: 'j-old' }, { ok: true, job: { id: 'j-b' } }, exec);
  assert.deepEqual(tracked[1], ['j-b', 'sess-9'], 'retry 建出的新 job 同样登记');

  noteOwnerAction(hooks, { action: 'kill', id: 'j-a' }, { ok: true }, exec);
  assert.deepEqual(killed, ['j-a']);

  noteOwnerAction(hooks, { action: 'wait', id: 'j-b' }, { ok: true, timedOut: false }, exec);
  assert.deepEqual(awaited, ['j-b'], 'wait 到落地 ⇒ 抑制通知');

  noteOwnerAction(hooks, { action: 'wait', id: 'j-c' }, { ok: true, timedOut: true }, exec);
  assert.deepEqual(awaited, ['j-b'], 'wait 超时 ⇒ 不抑制（job 还在跑）');

  noteOwnerAction(hooks, { action: 'dispatch' }, { ok: false, error: '开关关闭' }, exec);
  noteOwnerAction(hooks, { action: 'list' }, { ok: true, jobs: [] }, exec);
  assert.equal(tracked.length, 2, '失败的 dispatch 与只读动作都不登记');

  // 无会话（非 agent 调用）与无钩子：都不抛
  noteOwnerAction(hooks, { action: 'dispatch' }, { ok: true, job: { id: 'j-d' } }, {});
  assert.deepEqual(tracked[2], ['j-d', ''], '无会话时登记空 owner，由 notifier 侧判为「不唤醒」');
  assert.doesNotThrow(() => noteOwnerAction({}, { action: 'dispatch' }, { ok: true, job: { id: 'x' } }, exec));
  assert.doesNotThrow(() => noteOwnerAction({ notifier: { current: { track() { throw new Error('boom'); } } }, log: () => {} }, { action: 'dispatch' }, { ok: true, job: { id: 'y' } }, exec));
});
