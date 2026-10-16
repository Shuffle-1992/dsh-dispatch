/**
 * Z3 套餐额度 RPC 自测（零依赖，node --test 语义）。
 * 运行：node test/quota-rpc.test.mjs
 *
 * 全部用 spawnImpl 注入假 app-server 进程（不真起 CLI）；
 * 真实 CLI 的打通证据见 tasks/Z3-delivery.md（bin/dispatch.mjs plan-quota 实跑）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createAppServerClient } from '../core/appserver-rpc.mjs';
import { fetchPlanQuota } from '../core/quota.mjs';

/** 假 spawn：`node zcode.cjs …` 返回可编程假进程；taskkill 调用被记录。script 按 method 配响应。 */
function makeFakeSpawn({ script = [], exitAfterMs = null, spawnError = null } = {}) {
  const rec = { calls: [], writes: [], kills: 0, taskkill: null, children: [] };
  const spawnImpl = (file, args, options) => {
    rec.calls.push({ file, args, options });
    if (file === 'taskkill') {
      rec.taskkill = { pid: args[1], tree: args.includes('/T'), force: args.includes('/F') };
      return { on() {}, kill() {} };
    }
    const child = new EventEmitter();
    child.pid = spawnError ? undefined : 4200 + rec.children.length + 1; // spawn 失败时真实 Node 不给 pid
    child.exited = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write: (s) => {
        rec.writes.push(s);
        respond(s);
        return true;
      },
      on() {},
    };
    const emitLine = (obj) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`));
    const emitRaw = (s) => child.stdout.emit('data', Buffer.from(s));
    const doExit = (code, signal) => {
      if (child.exited) return;
      child.exited = true;
      queueMicrotask(() => child.emit('exit', code, signal));
    };
    child.kill = () => {
      rec.kills += 1;
      doExit(0, null);
      return true;
    };
    const respond = (s) => {
      if (child.exited) return;
      for (const line of s.split('\n')) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        const h = script.find((x) => x.method === req.method);
        if (!h) continue; // 无配置 → 不回（走超时路径）
        const reply = typeof h.reply === 'function' ? h.reply(req) : { id: req.id, ...h.reply };
        if (h.noiseBefore) emitRaw('THIS IS NOT JSON LINE\n');
        if (h.delayMs) setTimeout(() => !child.exited && emitLine(reply), h.delayMs).unref?.();
        else emitLine(reply);
      }
    };
    if (spawnError) queueMicrotask(() => child.emit('error', spawnError));
    else if (exitAfterMs != null) setTimeout(() => doExit(1, null), exitAfterMs).unref?.();
    child._test = { emitLine, emitRaw, doExit };
    rec.children.push(child);
    return child;
  };
  return { spawnImpl, rec };
}

/* ---------- 固定响应 ----------
 * generatedAt = 2026-09-30T04:00:00Z（Asia/Shanghai 周三 12:00）→ 本周一是 2026-09-28。
 */
const GEN_MS = Date.UTC(2026, 8, 30, 4, 0, 0);
const USAGE_STATS_FIXTURE = {
  range: 'all',
  generatedAt: GEN_MS,
  timeZone: 'Asia/Shanghai',
  source: 'agent-db',
  summary: { totalTokens: 999, totalSessions: 3 },
  dailyModelUsage: [
    { date: '2026-09-27', models: [{ modelId: 'A', totalTokens: 100 }] }, // 上周日 → 不入本周
    { date: '2026-09-28', models: [{ modelId: 'A', totalTokens: 10 }, { modelId: 'B', totalTokens: 20 }] },
    { date: '2026-09-29', models: [{ modelId: 'A', totalTokens: 5 }] },
    { date: '2026-09-30', models: [{ modelId: 'A', totalTokens: 7 }] },
  ],
  models: [{ modelId: 'A', totalTokens: 122 }],
  tools: [{ toolName: 'Bash', callCount: 1 }],
  heatmap: { startDate: '2026-09-01', endDate: '2026-09-30' },
};
const usageScript = [
  { method: 'usage/stats', reply: (req) => ({ id: req.id, result: USAGE_STATS_FIXTURE }) },
];

/* ---------- createAppServerClient ---------- */

test('RPC 基本收发：裸 {id,method,params} 帧、id 自增、响应按 id 匹配', async () => {
  const { spawnImpl, rec } = makeFakeSpawn({
    script: [{ method: 'runtime/capabilities', reply: (req) => ({ id: req.id, result: { independentPlanState: true } }) }],
  });
  const cli = await createAppServerClient({ spawnImpl });
  try {
    // 启动参数与环境变量装配
    assert.equal(rec.calls[0].args[1], 'app-server');
    assert.deepEqual(rec.calls[0].args.slice(2), ['--stdio', '--surface', 'terminal']);
    assert.match(rec.calls[0].options.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, /zcode-builtin\.json$/);
    assert.match(rec.calls[0].options.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, /provider_config\.json$/);

    const result = await cli.call('runtime/capabilities', {});
    assert.deepEqual(result, { independentPlanState: true });
    // 请求帧必须是裸三键（无 jsonrpc 包装），id 自增
    assert.equal(rec.writes[0], '{"id":1,"method":"runtime/capabilities","params":{}}\n');
    assert.deepEqual(cli.stats, { sent: 1, received: 1, badLines: 0, notifications: 0, truncatedLines: 0 });
  } finally {
    cli.close();
  }
});

test('S→C 通知（无 id）与 JSON 坏行不致命：分别计数，不影响后续响应', async () => {
  const { spawnImpl, rec } = makeFakeSpawn({
    script: [{ method: 'm/ok', reply: (req) => ({ id: req.id, result: 1 }) }],
  });
  const cli = await createAppServerClient({ spawnImpl });
  try {
    // 模拟引擎启动通知与坏行（真实引擎会先推 startup/storageState）
    rec.children[0]._test.emitLine({ method: 'startup/storageState', params: { phase: 'ready' } });
    rec.children[0]._test.emitRaw('THIS IS NOT JSON LINE\n');
    const r = await cli.call('m/ok', {});
    assert.equal(r, 1);
    assert.equal(cli.stats.notifications, 1);
    assert.ok(cli.stats.badLines >= 1);
  } finally {
    cli.close();
  }
});

test('并发 call：响应按 id 各回各家，不被串扰', async () => {
  const { spawnImpl } = makeFakeSpawn({
    script: [
      { method: 'm/slow', delayMs: 150, reply: (req) => ({ id: req.id, result: 'slow' }) },
      { method: 'm/fast', reply: (req) => ({ id: req.id, result: 'fast' }) },
    ],
  });
  const cli = await createAppServerClient({ spawnImpl });
  try {
    const [a, b] = await Promise.all([cli.call('m/slow', {}), cli.call('m/fast', {})]);
    assert.equal(a, 'slow');
    assert.equal(b, 'fast');
  } finally {
    cli.close();
  }
});

test('call 超时：明确报错且清理挂起表，后续可继续', async () => {
  const { spawnImpl } = makeFakeSpawn({
    script: [{ method: 'm/ok', reply: (req) => ({ id: req.id, result: 1 }) }],
  });
  const cli = await createAppServerClient({ spawnImpl });
  try {
    await assert.rejects(() => cli.call('m/never', {}, { timeoutMs: 120 }), /timeout: m\/never/);
    assert.equal(await cli.call('m/ok', {}), 1, '超时不影响后续请求');
  } finally {
    cli.close();
  }
});

test('close()：taskkill /T /F + kill 均触发；挂起请求以 client-closed 收尾；close 后 call 拒绝且幂等', async () => {
  const { spawnImpl, rec } = makeFakeSpawn({ script: [] });
  const cli = await createAppServerClient({ spawnImpl });
  const pendingMsg = cli.call('m/never', {}).then(
    () => {
      throw new Error('不应 resolve');
    },
    (e) => e.message,
  );
  cli.close();
  assert.equal(rec.taskkill.tree, true, '必须 /T 树杀');
  assert.equal(rec.taskkill.force, true, '必须 /F');
  assert.equal(rec.taskkill.pid, String(cli.pid));
  assert.ok(rec.kills >= 1, 'child.kill 必须被调用');
  assert.match(await pendingMsg, /client-closed/);
  await assert.rejects(() => cli.call('m/any', {}), /client-closed/);
  assert.deepEqual(cli.stderrTail(), [], '无 stderr 时 tail 为空数组');
  cli.close(); // 幂等
});

test('RPC 错误响应（如 -32601）：call 以 rpc-error 拒绝且带 code', async () => {
  const { spawnImpl } = makeFakeSpawn({
    script: [{ method: 'm/nope', reply: (req) => ({ id: req.id, error: { code: -32601, message: 'Method not found: m/nope' } }) }],
  });
  const cli = await createAppServerClient({ spawnImpl });
  try {
    await assert.rejects(
      () => cli.call('m/nope', {}),
      (e) => e.code === -32601 && /Method not found/.test(e.message),
    );
  } finally {
    cli.close();
  }
});

test('进程异常退出：挂起请求以 app-server-exited 收尾，不悬挂', async () => {
  const { spawnImpl } = makeFakeSpawn({ exitAfterMs: 60 });
  const cli = await createAppServerClient({ spawnImpl });
  await assert.rejects(() => cli.call('m/x', {}, { timeoutMs: 3000 }), /app-server-exited/);
  await assert.rejects(() => cli.call('m/y', {}), /app-server-exited/);
});

test('spawn 失败（ENOENT 模拟）：createAppServerClient 直接拒绝', async () => {
  const { spawnImpl } = makeFakeSpawn({ spawnError: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });
  await assert.rejects(() => createAppServerClient({ spawnImpl }), /spawn-failed/);
});

/* ---------- fetchPlanQuota ---------- */

test('fetchPlanQuota 映射：week.used=本周日桶合计、5h 不可导出、raw 裁剪、source/plan 正确', async () => {
  const { spawnImpl } = makeFakeSpawn({ script: usageScript });
  const pq = await fetchPlanQuota({ planKey: 'bigmodel-coding-plan', timeoutMs: 3000, spawnImpl, timeZone: 'Asia/Shanghai' });
  assert.equal(pq.available, true);
  assert.equal(pq.plan, 'bigmodel-coding-plan');
  assert.equal(pq.source, 'app-server:usage/stats');
  assert.equal(pq.generatedAt, new Date(GEN_MS).toISOString());

  const [five, week] = pq.windows;
  assert.equal(five.id, '5h');
  assert.equal(five.used, null);
  assert.equal(five.mapped, false);
  for (const k of ['limit', 'remaining', 'percentUsed', 'resetAt']) assert.equal(five[k], null);
  assert.ok(typeof five.note === 'string' && five.note.length > 10);

  assert.equal(week.id, 'week');
  assert.equal(week.used, 42, '10+20+5+7；上周日的 100 不入本周');
  assert.equal(week.usedSince, '2026-09-28', 'Asia/Shanghai 的本周一');
  assert.equal(week.usedDays, 3);
  assert.equal(week.mapped, false, 'limit/remaining 缺 → 窗口整体标记未完全映射');
  for (const k of ['limit', 'remaining', 'percentUsed', 'resetAt']) assert.equal(week[k], null);

  assert.equal(pq.raw.dailyModelUsage.length, 4);
  assert.equal(pq.raw.summary.totalTokens, 999);
  assert.equal(pq.raw.heatmap, undefined, 'heatmap 应剔除防膨胀');
  assert.equal(pq.raw.tools, undefined, 'tools 应剔除防膨胀');
});

test('fetchPlanQuota：方法不存在（-32601）→ available:false + 短因，不抛', async () => {
  const { spawnImpl } = makeFakeSpawn({
    script: [{ method: 'usage/stats', reply: (req) => ({ id: req.id, error: { code: -32601, message: 'Method not found: usage/stats' } }) }],
  });
  const pq = await fetchPlanQuota({ timeoutMs: 3000, spawnImpl });
  assert.deepEqual(pq, { available: false, reason: 'rpc-error:-32601' });
});

test('fetchPlanQuota：超时 → available:false，不抛，按 timeoutMs 收敛', async () => {
  const { spawnImpl } = makeFakeSpawn({ script: [] }); // 无任何响应
  const t0 = Date.now();
  const pq = await fetchPlanQuota({ timeoutMs: 250, spawnImpl });
  assert.deepEqual(pq, { available: false, reason: 'timeout' });
  assert.ok(Date.now() - t0 < 5000);
});

test('fetchPlanQuota：进程异常退出 / spawn 失败 → available:false，不抛', async () => {
  const exited = makeFakeSpawn({ exitAfterMs: 40 });
  assert.deepEqual(
    await fetchPlanQuota({ timeoutMs: 3000, spawnImpl: exited.spawnImpl }),
    { available: false, reason: 'app-server-exited' },
  );
  const failed = makeFakeSpawn({ spawnError: new Error('spawn ENOENT') });
  assert.deepEqual(
    await fetchPlanQuota({ timeoutMs: 3000, spawnImpl: failed.spawnImpl }),
    { available: false, reason: 'spawn-failed' },
  );
});

test('fetchPlanQuota：JSON 坏行——只有坏行走超时；坏行+有效响应则照常可用', async () => {
  const onlyNoise = makeFakeSpawn({ script: [] });
  const cli1 = await createAppServerClient({ spawnImpl: onlyNoise.spawnImpl });
  const pending = assert.rejects(cli1.call('usage/stats', {}, { timeoutMs: 150 }), /timeout/);
  onlyNoise.rec.children[0]._test.emitRaw('GARBAGE WITHOUT JSON\n');
  await pending;
  assert.ok(cli1.stats.badLines >= 1);
  cli1.close();

  const { spawnImpl } = makeFakeSpawn({
    script: [{ method: 'usage/stats', noiseBefore: true, reply: (req) => ({ id: req.id, result: USAGE_STATS_FIXTURE }) }],
  });
  const pq = await fetchPlanQuota({ timeoutMs: 3000, spawnImpl, timeZone: 'UTC' });
  assert.equal(pq.available, true, '噪声行不应打断有效响应');
});

test('fetchPlanQuota：意外响应形状 → unexpected-usage-stats-shape', async () => {
  const { spawnImpl } = makeFakeSpawn({
    script: [{ method: 'usage/stats', reply: (req) => ({ id: req.id, result: { foo: 1 } }) }],
  });
  const pq = await fetchPlanQuota({ timeoutMs: 3000, spawnImpl });
  assert.deepEqual(pq, { available: false, reason: 'unexpected-usage-stats-shape' });
});

test('fetchPlanQuota：注入 client 时不负责 close（生命周期归注入方）', async () => {
  let closeCalls = 0;
  const client = {
    call: async () => USAGE_STATS_FIXTURE,
    close: () => {
      closeCalls += 1;
    },
    stats: {},
  };
  const pq = await fetchPlanQuota({ client, timeZone: 'Asia/Shanghai' });
  assert.equal(pq.available, true);
  assert.equal(closeCalls, 0, '注入的 client 不应被 close');
});

test('fetchPlanQuota：timeoutMs 非正数 → TypeError（沿用原契约）', async () => {
  await assert.rejects(() => fetchPlanQuota({ timeoutMs: 0 }), TypeError);
  await assert.rejects(() => fetchPlanQuota({ timeoutMs: -1 }), TypeError);
});
