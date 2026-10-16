/**
 * ZB-22 集成测试：`apply()` 的**全链路接线**（不只是通知器单测）。
 *
 * 覆盖真实接线里最容易错的三处：
 *   1. `ctx.get('agents')` 的解析路径（唤醒器建立 + 投递时真能拿到会话）；
 *   2. `ctx.inject(['systemPrompt'])` 注入的段落名/顺序/正文是否正确（新会话可见）；
 *   3. 走 `handleAction('dispatch')` + `noteOwnerAction`（工具层译码）之后，job 落地
 *      是否真的唤醒发起会话。
 *
 * 纯 node 里 `defineTool` 解析不到（宿主 dsh-tools 在 app.asar 内，Electron 才有 fs 补丁），
 * 所以工具注册本身在这里是 no-op —— 工具层那一格由 test/notify.test.mjs 的 noteOwnerAction
 * 单测覆盖，两者合起来等于「工具 execute → 会话被叫醒」的完整证据链。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs');
process.env.DSP_FAKE_RUNNER = FAKE_RUNNER;

const tempDirs = [];
const newWorkRoot = () => {
  const d = mkdtempSync(join(tmpdir(), 'dsp-wake-int-'));
  tempDirs.push(d);
  return d;
};
test.after(() => {
  delete process.env.DSP_FAKE_RUNNER;
  delete process.env.FAKE_SLEEP_MS;
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows 句柄抖动：留待进程退出 */ }
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['done', 'failed', 'killed', 'interrupted', 'paused']);

/** 假宿主 ctx：`get('agents')` 同步可见（真实 cordis 里未注册服务返回 undefined 而不抛），inject 同步回调。 */
function fakeCtx({ agentsVisible = true } = {}) {
  const owners = new Map();
  const injected = [];
  const sections = [];
  const effects = [];
  const logs = [];
  const onHandlers = [];
  const ctx = {
    effects,
    injected,
    sections,
    logs,
    onHandlers,
    effect(fn) { effects.push(fn); },
    logger: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
      error: (...a) => logs.push(['error', ...a]),
    },
    get(name) {
      if (name === 'agents') return agentsVisible ? { get: (id) => owners.get(id) } : undefined;
      return undefined;
    },
    on(ev, fn) { onHandlers.push([ev, fn]); return () => { /* 退订 */ }; },
    inject(deps, cb) {
      injected.push(deps);
      if (deps.includes('systemPrompt')) {
        cb({
          systemPrompt: {
            getSectionOrder: (name) => (name === 'TOOL_JOBS' ? 1600 : undefined),
            section: (s) => { sections.push(s); return () => { /* 注销 */ }; },
          },
        });
      } else {
        cb({});
      }
    },
  };
  return { ctx, owners, injected, sections, logs, onHandlers, effects };
}

function fakeAgent(id) {
  const calls = [];
  return {
    id,
    status: 'idle',
    calls,
    followup(m) { calls.push(['followup', m]); },
    inject(m) { calls.push(['inject', m]); },
  };
}

test('apply 全链路：派发 → 落地 → 唤醒发起会话；systemPrompt 段落也注入', async () => {
  const { apply, noteOwnerAction } = await import('../index.js');
  const { ctx, owners, injected, sections, logs, onHandlers, spCtxEffects } = fakeCtx();
  const owner = fakeAgent('sess-int');
  owners.set('sess-int', owner);
  process.env.FAKE_SLEEP_MS = '150'; // 假 runner 快进快出，测试别等太久
  const workRoot = newWorkRoot();
  const api = apply(ctx, {
    demo: false,
    maxConcurrent: 2,
    runnerPath: '(由 DSP_FAKE_RUNNER 注入)',
    ledgerPath: join(workRoot, 'ledger.jsonl'),
    workRoot,
    switchPath: join(workRoot, 'switch.json'),
  });

  // ① 接线：唤醒器建立（agents 走 ctx.get 懒解析）、systemPrompt 段落注入
  assert.ok(api.notifier?.current, '唤醒器已建立（api.notifier.current 非空）');
  assert.ok(!injected.some((d) => d.includes('agents')), 'agents 不该走 ctx.inject 等就绪（投递时懒解析）');
  assert.ok(injected.some((d) => d.includes('systemPrompt')), 'systemPrompt 被 inject');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'tool:dispatch');
  assert.equal(sections[0].order, 1605, '紧随 TOOL_JOBS(1600)，排在 TOOL_SUBAGENT 之前');
  assert.match(sections[0].text, /dispatch/);
  assert.match(sections[0].text, /不要.*轮询|不要\*\*轮询/);
  assert.ok(onHandlers.some(([ev]) => ev === 'agent/inbox/claimed'), '订阅了用户消息事件（唤醒预算复位）');
  assert.equal(ctx.effects.length, 1, '插件卸载清理仍只注册一处（唤醒器复用 disposeAll）');

  // ② 动作层派发 + 工具层译码（noteOwnerAction 就是工具 execute 里那一行）
  const r = await api.handleAction('dispatch', { kind: 'prompt', prompt: '只回答 OK（wake-int）', timeoutMin: 1, tag: 'WAKE-INT' });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  const jobId = r.job.id;
  noteOwnerAction({ notifier: api.notifier, log: () => {} }, { action: 'dispatch' }, r, { agent: { id: 'sess-int' } });

  // ③ 等 job 落地：唤醒应当在落地那一刻发生（而不是要人来催）
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const j = api.dispatcher.get(jobId);
    if (j && TERMINAL.has(j.state)) break;
    await sleep(50);
  }
  const settled = api.dispatcher.get(jobId);
  assert.ok(settled && TERMINAL.has(settled.state), `job 应落地，实际=${settled?.state}`);

  // 唤醒是事件驱动同步投递的，给一拍让回调跑完
  for (let i = 0; i < 20 && owner.calls.length === 0; i += 1) await sleep(25);
  assert.equal(owner.calls.length, 1, `落地后应恰好唤醒一次（实际 ${JSON.stringify(owner.calls.map((c) => c[0]))}）`);
  assert.equal(owner.calls[0][0], 'followup', '空闲会话用 followup 才会开新一轮');
  const msg = owner.calls[0][1];
  assert.equal(msg.source.kind, 'dispatch');
  assert.match(msg.content[0].text, new RegExp(jobId));

  // ④ 信标：wakeActive / systemPromptHintActive 都是 true（重启后排障一眼可见）
  const beaconPath = join(workRoot, 'state', 'activation.json');
  assert.ok(existsSync(beaconPath), '激活信标已写');
  const beacon = JSON.parse(readFileSync(beaconPath, 'utf8'));
  assert.equal(beacon.wakeActive, true);
  assert.equal(beacon.wakeNote, null);
  assert.equal(beacon.agentsVisible, true);
  assert.equal(beacon.systemPromptHintActive, true);
  assert.equal(beacon.notifyOnSettle, true);
});

test('notifyOnSettle=false：不建唤醒器、不注入（派发照旧可用）', async () => {
  const { apply } = await import('../index.js');
  const { ctx, injected, sections } = fakeCtx();
  const workRoot = newWorkRoot();
  const api = apply(ctx, {
    demo: false,
    maxConcurrent: 1,
    runnerPath: '(由 DSP_FAKE_RUNNER 注入)',
    workRoot,
    switchPath: join(workRoot, 'switch.json'),
    notifyOnSettle: false,
    systemPromptHint: false,
  });
  assert.equal(api.notifier.current, null);
  assert.ok(!injected.some((d) => d.includes('agents')), '关掉唤醒就不该订阅 agents');
  assert.equal(sections.length, 0);
  assert.ok(api.dispatcher, '关闭唤醒不影响派发核心');
});

test('agents 服务缺席：唤醒器照建（懒解析）、派发不受影响、落地不抛（激活安全）', async () => {
  const { apply } = await import('../index.js');
  const effects = [];
  const logs = [];
  const ctx = {
    effect(fn) { effects.push(fn); },
    logger: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]) },
    // 没有 get('agents')：等价于宿主未提供 agents 服务
    inject() { /* systemPrompt 也未就绪：回调不执行（cordis 语义） */ },
  };
  const workRoot = newWorkRoot();
  const api = apply(ctx, {
    demo: false,
    maxConcurrent: 1,
    runnerPath: '(由 DSP_FAKE_RUNNER 注入)',
    workRoot,
    switchPath: join(workRoot, 'switch.json'),
  });
  assert.ok(api.dispatcher, 'dispatcher 仍建立');
  assert.ok(api.notifier?.current, '唤醒器照建（投递时再解析 agents）');
  const beacon = JSON.parse(readFileSync(join(workRoot, 'state', 'activation.json'), 'utf8'));
  assert.equal(beacon.agentsVisible, false, '信标如实记下「当前看不到 agents」');

  const r = await api.handleAction('dispatch', { kind: 'prompt', prompt: 'x', timeoutMin: 1 });
  assert.equal(r.ok, true, '无 agents 服务时派发不受影响');
  await api.handleAction('kill', { id: r.job.id });
  // 等它落终态再卸载：否则 dispatcher 的异步 persist 会与临时目录清理赛跑（ENOENT 噪音）
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !TERMINAL.has(api.dispatcher.get(r.job.id)?.state)) await sleep(50);
  for (const fn of effects) fn(); // 卸载：唤醒器随之释放，不抛
  await sleep(200);
});
