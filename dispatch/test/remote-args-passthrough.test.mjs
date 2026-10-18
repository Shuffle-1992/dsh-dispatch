#!/usr/bin/env node
/**
 * remote-args-passthrough.test.mjs —— ZB-73 真机 bug 回归：**remote 转发不许丢参数**
 *
 * 真机现场（2026-10-18 用户截图）：面板把「思考强度」从「Agent决定」改成「高强度」，
 * 界面立刻**跳回「Agent决定」**。写入看似成功（`ok:true`），实际没生效。
 *
 * 根因：同一条 `channel` 动作有**两条入口** ——
 *   · `createActionHandler('channel', …)` 收 `reasoningLevel ?? thinking`（正确）；
 *   · `createRemoteFace().setChannel(next)` 转发时**只传 `{provider, model}`**，把 `reasoningLevel` 丢了。
 * 面板走的是后者 ⇒ core 里存的仍是旧值 ⇒ 下一次 `channel()` 读回又变回 `agent`。
 *
 * 这类"参数在两条入口上一个生效一个不生效"是**静默失真**（说了不做），本文件把它钉死。
 * 通用手法：对 remote 方法做**参数透传核对**（桩 impl 记录收到的参数，与调用方传入的比对）。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatcher } from '../core/dispatch-core.mjs';
import { createRemoteFace } from '../wire.host.mjs';

let pass = 0;
const fails = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fails.push(m); console.log(`  ✗ ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `（实际 ${JSON.stringify(a)} / 期望 ${JSON.stringify(b)}）`}`);

const roots = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'dsp-remote-args-')); roots.push(d); return d; };
const cleanup = () => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } };

console.log('\nA. setChannel 必须把 reasoningLevel 透传到 core（真机 bug 的直接回归）');
{
  const dir = mk();
  const runner = join(dir, 'fake-runner.mjs');
  writeFileSync(runner, 'process.exit(0);\n', 'utf8');
  const d = createDispatcher({ runnerPath: runner, workRoot: join(dir, 'work'), jobsFile: join(dir, 'state', 'jobs.json') });
  try {
    const face = createRemoteFace(d, {});
    /* 面板的真实调用形状：{provider, model, reasoningLevel}。 */
    const r = await face.setChannel({ provider: 'plan', model: 'GLM-5.3', reasoningLevel: 'high' });
    ok(r && r.ok !== false, `A1 setChannel 成功（实际 ${JSON.stringify(r && r.ok)}）`);
    const got = d.getChannel();
    eq(got.reasoningLevel, 'high', 'A2 ★ core 里存下了 high（修复前这里会是 agent —— 面板跳回 Agent决定）');
    eq(got.model, 'GLM-5.3', 'A3 model 也透传了');
    /* 落盘也必须带上（重启后要能读回）。 */
    const f = join(dir, 'work', 'state', 'channel.json');
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      eq(j.reasoningLevel, 'high', 'A4 ★ channel.json 落盘含 reasoningLevel=high（重启后读回不丢）');
    } else {
      ok(false, `A4 channel.json 未生成（期望 ${f}）`);
    }
    /* 读回（面板下一次轮询走的就是它）。 */
    const readBack = await face.channel();
    eq(readBack.reasoningLevel, 'high', 'A5 ★ channel() 读回仍是 high（面板不会再跳回 Agent决定）');
  } finally { d.dispose?.(); }
}

console.log('\nB. 别名与缺省语义不变（不误伤既有行为）');
{
  const dir = mk();
  const runner = join(dir, 'fake-runner.mjs');
  writeFileSync(runner, 'process.exit(0);\n', 'utf8');
  const d = createDispatcher({ runnerPath: runner, workRoot: join(dir, 'work'), jobsFile: join(dir, 'state', 'jobs.json') });
  try {
    const face = createRemoteFace(d, {});
    /* `thinking` 别名（工具侧叫 thinking，面板叫 reasoningLevel）也要透传。 */
    await face.setChannel({ provider: 'plan', thinking: 'low' });
    eq(d.getChannel().reasoningLevel, 'low', 'B1 `thinking` 别名同样透传（工具侧入口）');
    /* 不传档位 ⇒ 沿用原值（不重置）—— 改 provider/model 时不该把档位清成 agent。 */
    await face.setChannel({ provider: 'account:bigmodel-start-plan' });
    eq(d.getChannel().reasoningLevel, 'low', 'B2 ★ 只改通道不传档位 ⇒ 沿用原值（不被重置成 agent）');
    /* 显式 agent 照传。 */
    await face.setChannel({ provider: 'plan', reasoningLevel: 'agent' });
    eq(d.getChannel().reasoningLevel, 'agent', 'B3 显式 agent 照传（Agent决定 也是有效值）');
  } finally { d.dispose?.(); }
}

console.log('\nC. 通用守门：remote 方法**参数透传**核对（防同类坑再犯）');
{
  const dir = mk();
  const runner = join(dir, 'fake-runner.mjs');
  writeFileSync(runner, 'process.exit(0);\n', 'utf8');
  /* 桩 dispatcher：记录每个方法的入参，用于核对"转发有没有丢字段"。 */
  const calls = [];
  const spy = new Proxy({}, {
    get(_t, name) {
      if (name === 'list') return () => [];
      if (name === 'get') return () => null;
      if (name === 'statePath') return (n) => join(dir, 'state', n);
      if (name === 'jobsFile') return join(dir, 'state', 'jobs.json');
      return (...args) => { calls.push([String(name), args]); return name === 'getChannel' ? {} : {}; };
    },
  });
  const face = createRemoteFace(spy, {});
  /* 逐条核对"入参字段是否原样到达 core"——这里只取**有明确多字段语义**的几个。 */
  await face.setChannel({ provider: 'plan', model: 'M', reasoningLevel: 'max' });
  const sc = calls.find((c) => c[0] === 'setChannel');
  ok(!!sc, 'C1 setChannel 到达了 core');
  eq(sc && sc[1] && sc[1][0], { provider: 'plan', model: 'M', reasoningLevel: 'max' },
    'C2 ★ setChannel 的三个字段**原样**到达 core（一个都不能丢）');
  cleanup();
  console.log(`\n===== ZB-73 remote 参数透传：${pass} PASS / ${fails.length} FAIL =====`);
  if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
  process.exit(0);
}
