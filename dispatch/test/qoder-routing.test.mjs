// ZB-51 T4 补测：**Qoder 通道的引擎路由与执行器调用**（真机验收抓到的 bug 的回归锁）
//
// 背景（别删这段，它解释了为什么必须存在这个文件）：
//   真机验收时 `provider:'qoder/Fast'` 被推断成 **engine=zcode** —— 因为 `resolveEngineOf()`
//   只写了 `isOpenCodeId()` 判据、漏了 qoder，于是 Qoder 通道**静默落到 ZCode 执行器**上，
//   模型还被改写成别的引擎的默认值。这类"静默跑错引擎"比报错危险得多，故用子进程级断言钉死。
//
// 手段：把 **假的 qoder-run.mjs** 装进临时 `collab-kit/`（连同真的协议模块与其余执行器），
// 这样 core 的默认路径推断能命中假执行器，且**不碰真机 Qoder、不耗额度**。
//
// 跑法：node dispatch/test/qoder-routing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../core/dispatch-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..', '..');
const tempDirs = [];
const newDir = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tempDirs.push(d); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 搭一个"假包"：真协议模块 + 真 zcode-run + **假 qoder-run**（core 默认推断恰好命中它）。 */
function fakePkg() {
  const root = newDir('dsp-qroute-');
  const ck = join(root, 'collab-kit');
  const core = join(root, 'dispatch', 'core');
  mkdirSync(ck, { recursive: true });
  mkdirSync(core, { recursive: true });
  copyFileSync(join(PKG, 'collab-kit', 'run-line-protocol.mjs'), join(ck, 'run-line-protocol.mjs'));
  copyFileSync(join(PKG, 'collab-kit', 'engine-discover.mjs'), join(ck, 'engine-discover.mjs'));
  copyFileSync(join(PKG, 'dispatch', 'core', 'dispatch-core.mjs'), join(core, 'dispatch-core.mjs'));
  /* ⚠️ OpenCode 执行器必须是**假的**：测 ⑤ 会走真实通道路径，而 core 一旦探测 OpenCode 就会
   * spawn 这个脚本。若复制**真的** `opencode-run.mjs`，它会去起真的 opencode（临时服务）——
   * 既违反"不碰真 opencode"的纪律，又会**挂死整个测试**（实测：进程卡在 `opencode-run.mjs --`）。
   * 假执行器只回一份固定模型清单，立即退出。 */
  writeFileSync(join(ck, 'opencode-run.mjs'), [
    "const argv = process.argv.slice(2);",
    "if (argv.includes('--version')) { process.stdout.write('0.0.0-fake\\n'); process.exit(0); }",
    "if (argv.includes('--list-models')) { process.stdout.write('opencode/fake-model-free\\n'); process.exit(0); }",
    "process.stdout.write('[opencode-run] done exit=0 elapsed=0.1s session=ses_fake_oc responseChars=2\\n');",
    '',
  ].join('\n'), 'utf8');
  /* 假 qoder-run：把收到的 argv 原样打成一行 `[qoder-run] ARGV <json>`，然后按协议收尾；
   * 支持 `--list-models`（返回 3 个模型名，含带空格的），用于验证 core 的通道探测。 */
  writeFileSync(join(ck, 'qoder-run.mjs'), [
    "const argv = process.argv.slice(2);",
    "if (argv.includes('--version')) { process.stdout.write('1.1.73\\n'); process.exit(0); }",
    "if (argv.includes('--list-models')) {",
    "  process.stdout.write('Auto\\nFast\\nQwen3.8-Max\\n');",
    "  process.exit(0);",
    "}",
    "process.stdout.write('[qoder-run] ARGV ' + JSON.stringify(argv) + '\\n');",
    "process.stdout.write('[qoder-run] tag=' + (argv[argv.indexOf('--tag')+1] ?? '-') + ' mode=qoder\\n');",
    "process.stdout.write('[qoder-run] done exit=0 elapsed=0.1s session=ses_fake_qoder model=Fast responseChars=4\\n');",
    '',
  ].join('\n'), 'utf8');
  return { root, qoderRunner: join(ck, 'qoder-run.mjs') };
}

/** 假 spawnImpl：记录 argv，立刻成功收尾（不真起子进程）。 */
function makeSpawn() {
  const spawned = [];
  const impl = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.kill = () => {};
    const entry = { file: String(file), script: String(args[0]), args: args.slice(1) };
    spawned.push(entry);
    setImmediate(() => {
      child.stdout.push(null); child.stderr.push(null); child.emit('close', 0, null);
    });
    return child;
  };
  return { impl, spawned };
}

async function waitTerminal(d, id, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const j = d.get(id);
    if (j && ['done', 'failed', 'killed', 'interrupted'].includes(j.state)) return j;
    await sleep(10);
  }
  throw new Error(`waitTerminal(${id}) 超时，状态=${d.get(id)?.state}`);
}

const { root, qoderRunner } = fakePkg();
const CORE = join(root, 'dispatch', 'core', 'dispatch-core.mjs');

test('① 通道解析：qoder/<model> ⇒ engine=qoder、provider=qoder、model=<裸模型名>', async () => {
  const { createDispatcher: mk } = await import(`file://${CORE.replace(/\\/g, '/')}`);
  const w = newDir('dsp-qr-1-');
  const d = mk({ runnerPath: join(PKG, 'collab-kit', 'zcode-run.mjs'), workRoot: w, ledgerPath: join(w, 'l.jsonl') });
  /* 快照未落盘时也应命中（形态判据优先于快照） */
  const j = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', tag: 'route', provider: 'qoder/Fast' });
  const s = d.get(j.id).spec;
  assert.equal(s.engine, 'qoder', '★ qoder/ 通道必须判为 qoder 引擎（真机验收抓到的 bug）');
  assert.equal(s.provider, 'qoder', 'provider 规整为引擎名');
  assert.equal(s.model, 'Fast', '★ model = 裸模型名（Qoder 的 --model 取值）');
  assert.equal(d.get(j.id).engine, 'qoder', 'job.engine 落库');
  await waitTerminal(d, j.id);
});

test('② 带空格/点的真机模型名也能正确解析', async () => {
  const { createDispatcher: mk } = await import(`file://${CORE.replace(/\\/g, '/')}`);
  const w = newDir('dsp-qr-2-');
  const d = mk({ runnerPath: join(PKG, 'collab-kit', 'zcode-run.mjs'), workRoot: w, ledgerPath: join(w, 'l.jsonl') });
  for (const m of ['Qwen3.8-Max', 'DeepSeek-V4-Pro', 'Kimi-K2.8-Preview', 'MiniMax-M2.7']) {
    const j = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', provider: `qoder/${m}` });
    assert.equal(d.get(j.id).spec.engine, 'qoder', `qoder/${m} ⇒ engine=qoder`);
    assert.equal(d.get(j.id).spec.model, m, `★ qoder/${m} ⇒ model 逐字保留（空格与点都不能丢）`);
    await waitTerminal(d, j.id);
  }
});

test('③ 执行器调用：qoder job spawn 的是 **qoder-run.mjs**（不是 zcode/opencode 的）', async () => {
  const { createDispatcher: mk } = await import(`file://${CORE.replace(/\\/g, '/')}`);
  const { impl, spawned } = makeSpawn();
  const w = newDir('dsp-qr-3-');
  const d = mk({
    runnerPath: join(PKG, 'collab-kit', 'zcode-run.mjs'),
    workRoot: w, ledgerPath: join(w, 'l.jsonl'),
    spawnImpl: impl,
    zcodeConfigPath: join(w, 'nc.json'), planCachePath: join(w, 'np.json'), personalProviderPath: join(w, 'npp.json'),
  });
  const j = d.dispatch({
    kind: 'prompt', prompt: 'x', lock: 'none', tag: 'q1', provider: 'qoder/GLM-5.3',
    reasoningLevel: 'high', cwd: w,
  });
  await waitTerminal(d, j.id);
  assert.equal(spawned.length, 1, '恰好 spawn 一次');
  const e = spawned[0];
  assert.equal(e.script, qoderRunner, '★ spawn 的是 qoder-run.mjs（引擎路由正确）');
  /* 参数断言：core 只拼 Qoder 认识的东西，且思考强度走 --reasoning-effort */
  assert.ok(e.args.includes('--prompt'), '带 --prompt');
  const mi = e.args.indexOf('--model');
  assert.ok(mi >= 0 && e.args[mi + 1] === 'GLM-5.3', '★ 模型名原样传给执行器');
  const ri = e.args.indexOf('--reasoning-effort');
  assert.ok(ri >= 0 && e.args[ri + 1] === 'high', '★ 思考强度 = --reasoning-effort（不是 --variant/--reasoning-level）');
  assert.ok(!e.args.includes('--variant'), '绝不传 opencode 的 --variant');
  assert.ok(!e.args.includes('--memory-bench'), '绝不传 --memory-bench');
  assert.ok(!e.args.includes('--mode'), '绝不传 --mode');
  assert.ok(!e.args.includes('--auto'), '★ 默认绝不放行（auto 默认关）');
});

test('④ 显式 auto:true ⇒ 传入 --auto（放行可审计）', async () => {
  const { createDispatcher: mk } = await import(`file://${CORE.replace(/\\/g, '/')}`);
  const { impl, spawned } = makeSpawn();
  const w = newDir('dsp-qr-4-');
  const d = mk({
    runnerPath: join(PKG, 'collab-kit', 'zcode-run.mjs'),
    workRoot: w, ledgerPath: join(w, 'l.jsonl'), spawnImpl: impl,
    zcodeConfigPath: join(w, 'nc.json'), planCachePath: join(w, 'np.json'), personalProviderPath: join(w, 'npp.json'),
  });
  const j = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', tag: 'q2', provider: 'qoder/Fast', auto: true });
  await waitTerminal(d, j.id);
  assert.ok(spawned[0].args.includes('--auto'), '★ auto:true ⇒ 执行器收到 --auto');
  assert.equal(d.get(j.id).autoApproved, true, '★ job.autoApproved 可审计');
});

test('⑤ 通道清单里出现 qoder 通道（探测假执行器的 --list-models）', async () => {
  const { createDispatcher: mk } = await import(`file://${CORE.replace(/\\/g, '/')}`);
  const w = newDir('dsp-qr-5-');
  /* ⚠️ 不能传 channelsProbeImpl：那是测试替身，在场时按纪律**不做真探测**（qoder 探测也会被关掉）。
   * 这里让它走真实通道路径 —— 关键是 qoder-run 用的是**假执行器**，不会碰真机 Qoder。 */
  const d = mk({
    runnerPath: join(PKG, 'collab-kit', 'zcode-run.mjs'), workRoot: w, ledgerPath: join(w, 'l.jsonl'),
    opencodeRunnerPath: '',
    zcodeConfigPath: join(w, 'nc.json'), planCachePath: join(w, 'np.json'), personalProviderPath: join(w, 'npp.json'),
  });
  const r = await d.listChannels();
  const qc = r.channels.filter((c) => c.engine === 'qoder');
  assert.ok(qc.length > 0, `★ 通道清单含 qoder 通道（实际 ${qc.length} 个；warnings=${JSON.stringify(r.warnings)}）`);
  assert.deepEqual(qc.map((c) => c.id), ['qoder/Auto', 'qoder/Fast', 'qoder/Qwen3.8-Max'],
    '★ 模型名原样作通道 id（含带点的 Qwen3.8-Max）');
  for (const c of qc) {
    assert.equal(c.enabled, true, 'qoder 通道默认可用');
    assert.deepEqual(c.models, [c.id], 'models = [自身 id]');
  }
  assert.equal(r.engineDetail?.qoder?.found, true, 'engineDetail 里 qoder 找到');
  /* 通道→引擎快照必须把它映射到 qoder（startJob 靠它同步判引擎） */
  const snap = JSON.parse((await import('node:fs')).readFileSync(join(w, 'state', 'channels.json'), 'utf8'));
  assert.equal(snap.engineById['qoder/Fast'], 'qoder', '★ 快照把 qoder 通道映射到 qoder 引擎');
  assert.equal(snap.engineById['qoder/Qwen3.8-Max'], 'qoder', '带点的也映射正确');
});

test('⑤b ★ ZCode 两条路由**实现不同**：派发时 provider 各归各（面板选中后必须照此下发）', async () => {
  const { createDispatcher: mk } = await import(`file://${CORE.replace(/\\/g, '/')}`);
  const { impl, spawned } = makeSpawn();
  const w = newDir('dsp-qr-5b-');
  const d = mk({
    runnerPath: join(PKG, 'collab-kit', 'zcode-run.mjs'), workRoot: w, ledgerPath: join(w, 'l.jsonl'), spawnImpl: impl,
    zcodeConfigPath: join(w, 'nc.json'), planCachePath: join(w, 'np.json'), personalProviderPath: join(w, 'npp.json'),
  });
  /* 面板模型下拉的两种选择（key = `<路由id>::<模型名>`）解出来的 spec： */
  const a = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', tag: 'plan-route', provider: 'plan', model: 'GLM-5.3' });
  const sa = d.get(a.id).spec;
  assert.equal(sa.provider, 'plan', '★ 套餐项 ⇒ provider=plan（别名，runner 解析成用户套餐 provider）');
  assert.equal(sa.model, 'GLM-5.3', '套餐项带具体模型名');
  await waitTerminal(d, a.id);

  const b = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', tag: 'free-route', provider: 'account:bigmodel-start-plan', model: 'GLM-5.3-Flash' });
  const sb = d.get(b.id).spec;
  assert.equal(sb.provider, 'account:bigmodel-start-plan',
    '★ 免费额度项 ⇒ provider=**专用通道 id**（不是 plan！否则"以为用免费、实际扣套餐"）');
  assert.equal(sb.model, 'GLM-5.3-Flash', '免费额度只配 GLM-5.3-Flash');
  assert.notEqual(sb.provider, sa.provider, '★ 两条路由的 provider 必须**不同**（它们是两套实现）');
  await waitTerminal(d, b.id);

  /* 执行器 argv 里也要能看出两条路由（provider=plan vs provider=account:…） */
  const argsOf = (tag) => {
    const hit = spawned.find((e) => {
      const i = e.args.indexOf('--tag');
      return i >= 0 && e.args[i + 1] === tag;
    });
    return hit ? hit.args : [];
  };
  const planArgs = argsOf('plan-route');
  const freeArgs = argsOf('free-route');
  assert.equal(planArgs[planArgs.indexOf('--provider') + 1], 'plan', 'plan 路由的 argv provider=plan');
  assert.equal(freeArgs[freeArgs.indexOf('--provider') + 1], 'account:bigmodel-start-plan',
    '★ 免费路由的 argv provider=account:bigmodel-start-plan（与 plan 分离）');
});

test('⑥ 分类：qoder 通道与 opencode 通道互不误判', async () => {
  const P = await import(`file://${join(root, 'collab-kit', 'run-line-protocol.mjs').replace(/\\/g, '/')}`);
  assert.equal(P.inferEngine({ provider: 'qoder/Fast' }), 'qoder', 'qoder/ ⇒ qoder');
  assert.equal(P.inferEngine({ provider: 'opencode/x' }), 'opencode', 'opencode/ ⇒ opencode');
  assert.equal(P.inferEngine({ provider: 'plan' }), 'zcode', 'plan ⇒ zcode');
  assert.equal(P.isQoderId('opencode/x'), false, '不交叉误判');
  assert.equal(P.isOpenCodeId('qoder/x'), false, '不交叉误判');
  assert.equal(P.normalizeEngine('qoder'), 'qoder', 'normalizeEngine 认 qoder（注意它收的是字符串）');
  assert.equal(P.normalizeEngine('nonsense'), 'zcode', '未知仍回落 zcode');
});

test('⑦ 裸引擎名 provider 也认（qoder / opencode 不带 /model）', async () => {
  const { createDispatcher: mk } = await import(`file://${CORE.replace(/\\/g, '/')}`);
  const w = newDir('dsp-qr-7-');
  const d = mk({ runnerPath: join(PKG, 'collab-kit', 'zcode-run.mjs'), workRoot: w, ledgerPath: join(w, 'l.jsonl') });
  for (const [pv, expect] of [['qoder', 'qoder'], ['qoder-cn', 'qoder'], ['qoder-global', 'qoder'], ['opencode', 'opencode']]) {
    const j = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', provider: pv, model: 'Fast' });
    assert.equal(d.get(j.id).spec.engine, expect, `provider=${pv} ⇒ engine=${expect}`);
    await waitTerminal(d, j.id);
  }
});

test('⑦b ★ 幂等性：**已规整过的 spec 再规整不得翻回 zcode**（真机面板徽标显示 ZCode 的根因）', async () => {
  const P = await import(`file://${join(root, 'collab-kit', 'run-line-protocol.mjs').replace(/\\/g, '/')}`);
  /* 真机因果链（用户截图发现"都变成 ZCode 的了"）：
   *   qoder 通道 ⇒ normalizeEngineSpec 设 model='qoder/<m>'（带前缀，未剥）
   *   → 二次规整时 provider 已是裸 'qoder' ⇒ `isQoderId('qoder')` 为 false ⇒ inferEngine 回落 zcode
   *   → job.engine=zcode ⇒ **面板徽标显示 ZCode**（而执行器路由读 spec.engine，仍是 qoder ⇒ 真跑了 Qoder）
   * 修法：inferEngine 认**裸引擎名**；model 的 `qoder/` 前缀无条件剥掉。 */
  const once = P.normalizeEngineSpec({ provider: 'qoder/Qwen3.8-Flash' });
  const twice = P.normalizeEngineSpec(once);
  assert.equal(once.engine, 'qoder', '一次规整 ⇒ qoder');
  assert.equal(twice.engine, 'qoder', '★ 二次规整仍为 qoder（不翻回 zcode）');
  assert.deepEqual(twice, once, '★ 规整必须**幂等**（逐字段相等）');
  assert.equal(P.inferEngine({ provider: 'qoder' }), 'qoder', '★ 裸 qoder ⇒ qoder');
  assert.equal(P.inferEngine({ provider: 'opencode' }), 'opencode', '★ 裸 opencode ⇒ opencode');
  assert.equal(P.inferEngine({ engine: 'qoder', provider: 'qoder', model: 'X' }), 'qoder', '已规整形态仍认 qoder');
  /* model 前缀必须剥掉（Qoder 的 --model 要裸名） */
  assert.equal(once.model, 'Qwen3.8-Flash', '★ model 剥掉 qoder/ 前缀');
  assert.equal(P.normalizeEngineSpec({ provider: 'qoder', model: 'qoder/GLM-5.3' }).model, 'GLM-5.3',
    '★ 调用方把完整通道 id 当 model 传时也要剥（真机踩到的第二种传法）');
  /* OpenCode 相反：model 要**保留**完整 id（不能一刀切） */
  assert.equal(P.normalizeEngineSpec({ provider: 'opencode/x' }).model, 'opencode/x',
    'OpenCode 的 model 保留完整通道 id（与 Qoder 相反）');
});

test('⑦c ★ 真机验收回归：`qoder/Qwen3.8-Flash` 走完整链路后，执行器收到**裸模型名**', async () => {
  const { createDispatcher: mk } = await import(`file://${CORE.replace(/\\/g, '/')}`);
  const { impl, spawned } = makeSpawn();
  const w = newDir('dsp-qr-7c-');
  const d = mk({
    runnerPath: join(PKG, 'collab-kit', 'zcode-run.mjs'), workRoot: w, ledgerPath: join(w, 'l.jsonl'), spawnImpl: impl,
    zcodeConfigPath: join(w, 'nc.json'), planCachePath: join(w, 'np.json'), personalProviderPath: join(w, 'npp.json'),
  });
  /* 真机现场：默认通道存的是 `qoder` + `qoder/Qwen3.8-Flash`（都带通道前缀），
   * 用户点「用主通道派发」时走的就是这条链路。 */
  d.setChannel({ provider: 'qoder', model: 'qoder/Qwen3.8-Flash' });
  const j = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', tag: 'qwf' });
  const s = d.get(j.id).spec;
  assert.equal(s.engine, 'qoder', '★ engine=qoder（不翻回 zcode ⇒ 面板徽标不会是 ZCode）');
  assert.equal(s.model, 'Qwen3.8-Flash', '★ model 是**裸名**（真机证据：CLI 收到 qoder/… 会报不可用并静默退回 Auto）');
  await waitTerminal(d, j.id);
  const e = spawned[0];
  assert.equal(e.script, qoderRunner, 'spawn 的是 qoder-run');
  const mi = e.args.indexOf('--model');
  assert.equal(e.args[mi + 1], 'Qwen3.8-Flash', '★ 执行器 argv 里的 --model 是裸名');
  assert.ok(!String(e.args[mi + 1]).includes('qoder/'), '★ 绝不把带前缀的通道 id 当模型名传给 CLI');
});

test('⑧ ★ 换通道时**不得注入默认通道的 model**（真机静默 bug 的回归锁）', async () => {
  const { createDispatcher: mk } = await import(`file://${CORE.replace(/\\/g, '/')}`);
  const w = newDir('dsp-qr-8-');
  const d = mk({ runnerPath: join(PKG, 'collab-kit', 'zcode-run.mjs'), workRoot: w, ledgerPath: join(w, 'l.jsonl') });
  /* 复现真机现场：用户默认通道是 opencode（面板里选的），然后派给 qoder 通道。 */
  d.setChannel({ provider: 'opencode/deepseek-v4.1-flash-free', model: 'opencode/deepseek-v4.1-flash-free' });

  const a = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', provider: 'qoder/Fast' });
  const sa = d.get(a.id).spec;
  assert.equal(sa.model, 'Fast',
    '★ 指定了别的通道 ⇒ 绝不注入默认通道的 model（否则 provider/model 错配，'
    + 'Qoder 会报 Model not available 后**静默退回 Auto**，用户以为用的是 Fast）');
  assert.equal(sa.engine, 'qoder');
  await waitTerminal(d, a.id);

  /* 反向：不指定 provider ⇒ 仍沿用默认通道的 provider+model（既有行为逐字不变）。
   * 注意 `setChannel` 会把 `opencode/<model>` **规整成裸 `opencode`**（设计如此），故这里比对规整后的值。 */
  const b = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none' });
  const sb = d.get(b.id).spec;
  assert.equal(sb.provider, 'opencode', '不给 provider ⇒ 沿用默认通道（规整后为裸引擎名）');
  assert.equal(sb.model, 'opencode/deepseek-v4.1-flash-free', '★ 不给 provider ⇒ 仍注入默认通道模型（原行为不变）');
  assert.equal(sb.engine, 'opencode', '沿用默认通道时引擎也一致');
  await waitTerminal(d, b.id);

  /* 边界：显式给了 model 时，默认通道**绝不**覆写它 */
  const c = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', model: 'GLM-5.3' });
  assert.equal(d.get(c.id).spec.model, 'GLM-5.3', '显式 model 优先于通道默认');
  await waitTerminal(d, c.id);
});

test('清理', () => {
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }
  assert.ok(true);
});
