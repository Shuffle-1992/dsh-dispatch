/**
 * ZB-62 回归测试：唤醒投递的**可观测性**（用 DSH 0.2.1 新增的 agent/inbox 事件对账）。
 *
 * 现场问题（旧代码的盲区）：`delivered++` 只证明「followup/inject 没抛错」，**不能证明消息真的
 * 进了会话 Inbox** —— 会话已关闭/被清空时，落地通知会被宿主静默丢弃，而插件完全看不见，
 * 用户只能感知为"任务跑完了没人叫醒我"。
 *
 * 0.2.1 的事件目录提供了 `agent/inbox/inserted`（消息进入 live inbox）与
 * `agent/inbox/discarded`（被丢弃）。本测试钉住：① 按**我们自己的消息 id** 对账；
 * ② 外来消息一律不计数；③ 丢弃必须留下可读 warn；④ 诊断落盘 `wake-stats.json`；
 * ⑤ 既有 `claimed` 只按 source.kind==='user' 复位预算的语义**不被改动**；
 * ⑥ dispose 退订全部三个事件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettleNotifier } from '../notify.mjs';

function harness({ config = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsp-wake-observe-'));
  const subs = new Set();
  const jobs = new Map();
  const dispatcher = {
    jobsFile: join(dir, 'jobs.json'),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    get(id) { return jobs.get(id) ?? null; },
    settle(job) {
      jobs.set(job.id, job);
      for (const fn of [...subs]) fn({ type: 'job-updated', job });
    },
  };
  const agent = {
    id: 'sess-1',
    status: 'idle',
    calls: [],
    followup(m) { this.calls.push(['followup', m]); },
    inject(m) { this.calls.push(['inject', m]); },
  };
  const handlers = new Map();
  const ctx = {
    on(ev, fn) {
      const list = handlers.get(ev) ?? [];
      list.push(fn);
      handlers.set(ev, list);
      return () => {
        const l = handlers.get(ev) ?? [];
        const i = l.indexOf(fn);
        if (i >= 0) l.splice(i, 1);
      };
    },
  };
  const logs = [];
  const notifier = createSettleNotifier({
    dispatcher,
    agents: { get: (id) => (id === 'sess-1' ? agent : undefined) },
    log: (level, msg) => logs.push([level, msg]),
    config,
    ctx,
  });
  const fire = (ev, payload) => { for (const fn of [...(handlers.get(ev) ?? [])]) fn(payload); };
  const statsFile = () => join(dir, 'wake-stats.json');
  const readStats = () => JSON.parse(readFileSync(statsFile(), 'utf8'));
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄抖动 */ } };
  return { dir, dispatcher, agent, notifier, logs, fire, handlers, statsFile, readStats, cleanup };
}

const job = (id) => ({ id, state: 'done', exitCode: 0, spec: { kind: 'prompt', tag: `T-${id}` } });

test('① 订阅了三个 inbox 事件（inserted / discarded / claimed）', () => {
  const h = harness();
  try {
    assert.deepEqual([...h.handlers.keys()].sort(), ['agent/inbox/claimed', 'agent/inbox/discarded', 'agent/inbox/inserted']);
  } finally { h.cleanup(); }
});

test('② 投递后用 inserted 对账：unconfirmed 归零、insertAcked 计数；外来消息不计数', () => {
  const h = harness();
  try {
    h.notifier.track('j-1', 'sess-1');
    h.dispatcher.settle(job('j-1'));
    assert.equal(h.agent.calls.length, 1, '空闲会话走 followup');
    const [kind, message] = h.agent.calls[0];
    assert.equal(kind, 'followup');
    assert.equal(typeof message.id, 'string', '通知消息带我们生成的 id');

    let s = h.notifier.stats();
    assert.equal(s.delivered, 1);
    assert.equal(s.insertAcked, 0);
    assert.equal(s.unconfirmed, 1, '未收到 inserted 前算未确认');

    h.fire('agent/inbox/inserted', { agent: h.agent, message: { id: '别人的消息' } });
    s = h.notifier.stats();
    assert.equal(s.insertAcked, 0, '外来消息 id 不计数');
    assert.equal(s.unconfirmed, 1);

    h.fire('agent/inbox/inserted', { agent: h.agent, message: { id: message.id } });
    s = h.notifier.stats();
    assert.equal(s.insertAcked, 1, '自己的消息被确认入队');
    assert.equal(s.unconfirmed, 0);
  } finally { h.cleanup(); }
});

test('③ 被宿主丢弃 ⇒ lostWakes + 一条可读 warn（旧代码完全看不见）', () => {
  const h = harness();
  try {
    h.notifier.track('j-2', 'sess-1');
    h.dispatcher.settle(job('j-2'));
    const message = h.agent.calls[0][1];
    h.fire('agent/inbox/discarded', { agent: h.agent, message: { id: message.id } });
    const s = h.notifier.stats();
    assert.equal(s.lostWakes, 1);
    assert.equal(s.unconfirmed, 0);
    assert.equal(s.insertAcked, 0);
    const warn = h.logs.find(([lv, msg]) => lv === 'warn' && /被宿主丢弃/.test(msg));
    assert.ok(warn, '丢弃必须留下 warn（含"请用 action=list / action=tail 主动查看"的指引）');
    assert.match(warn[1], /action=list|action=tail/);
  } finally { h.cleanup(); }
});

test('④ 诊断落盘 wake-stats.json（原子替换、与 stats() 同源）', () => {
  const h = harness();
  try {
    h.notifier.track('j-3', 'sess-1');
    h.dispatcher.settle(job('j-3'));
    assert.ok(existsSync(h.statsFile()), '投递后应落盘 wake-stats.json');
    let disk = h.readStats();
    let mem = h.notifier.stats();
    assert.equal(disk.delivered, mem.delivered);
    assert.equal(disk.unconfirmed, mem.unconfirmed);
    assert.equal(typeof disk.at, 'string', '带时间戳');
    const message = h.agent.calls[0][1];
    h.fire('agent/inbox/inserted', { agent: h.agent, message: { id: message.id } });
    disk = h.readStats();
    assert.equal(disk.insertAcked, 1, '事件后同步刷新落盘');
    assert.equal(disk.unconfirmed, 0);
  } finally { h.cleanup(); }
});

test('⑤ 既有语义不回退：claimed 只按 source.kind==="user" 复位连续唤醒预算', () => {
  const h = harness({ config: { maxConsecutiveWakes: 1 } });
  try {
    h.notifier.track('j-4a', 'sess-1');
    h.dispatcher.settle(job('j-4a'));
    h.notifier.track('j-4b', 'sess-1');
    h.dispatcher.settle(job('j-4b'));
    assert.deepEqual(h.agent.calls.map((c) => c[0]), ['followup', 'inject'], '第二次触顶后改为注入');
    assert.equal(h.notifier.stats().capped, 1, '第二次被记账为 capped（不是丢弃）');

    h.fire('agent/inbox/claimed', { agent: h.agent, message: { source: { kind: 'model' } } });
    h.notifier.track('j-4c', 'sess-1');
    h.dispatcher.settle(job('j-4c'));
    assert.deepEqual(h.agent.calls.map((c) => c[0]), ['followup', 'inject', 'inject'], '非用户消息不复位预算');

    h.fire('agent/inbox/claimed', { agent: h.agent, message: { source: { kind: 'user' } } });
    h.notifier.track('j-4d', 'sess-1');
    h.dispatcher.settle(job('j-4d'));
    assert.deepEqual(h.agent.calls.map((c) => c[0]), ['followup', 'inject', 'inject', 'followup'], '用户说话后恢复自动唤醒');
  } finally { h.cleanup(); }
});

test('⑥ dispose 退订 inserted/discarded（不留悬挂监听）', () => {
  const h = harness();
  try {
    h.notifier.dispose();
    assert.equal((h.handlers.get('agent/inbox/inserted') ?? []).length, 0);
    assert.equal((h.handlers.get('agent/inbox/discarded') ?? []).length, 0);
    assert.equal((h.handlers.get('agent/inbox/claimed') ?? []).length, 0);
    /* dispose 后事件再进来也不能改动计数（订阅已摘除 ⇒ fire 是空转）。 */
    h.fire('agent/inbox/inserted', { agent: h.agent, message: { id: 'x' } });
    assert.equal(h.notifier.stats().insertAcked, 0);
  } finally { h.cleanup(); }
});

test('⑦ 没有 jobsFile / 没有 ctx.on 时也不抛（纯降级）', () => {
  const subs = new Set();
  const notifier = createSettleNotifier({
    dispatcher: { subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }, get: () => null },
    agents: { get: () => undefined },
    log: () => {},
    config: {},
  });
  assert.doesNotThrow(() => notifier.persistStats(), '无 jobsFile ⇒ 落盘静默跳过');
  assert.equal(notifier.stats().unconfirmed, 0);
  notifier.dispose();
});
