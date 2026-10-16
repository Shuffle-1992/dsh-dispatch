/**
 * Z6 通道/暂停/续跑/降级链 自测（零依赖，node --test 语义，退出码可靠）。
 * 运行：node test/channel-retry.test.mjs
 *
 * 覆盖（Z6-01 §二.4 + Z6-02 §一）：
 *   - 暂停分类：4 类签名 → paused + pauseReason；unknown 保持 failed；完全无输出 classifyPause → null
 *   - paused 不占锁、不堵队列、不自动重试
 *   - retry 同通道带 sessionId → 命令行含 --resume 且不含 --model（F2；假 runner 先打 session 再失败）
 *   - retry 换通道 → 无 --resume，prompt 含交接五要素；簿记必须能从 d.get()/d.list() 读回（P2 回归）
 *   - 降级链：链必须在 pause 之前 set；跳过不可用通道；链耗尽停 paused（不产生下一跳）；attempts 完整
 *   - listChannels 解析：固定样例 → 字段正确（personal 模型取自配置声明，不硬编码）；解析失败 → 空数组 + warning 不抛
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

import { createDispatcher, classifyPause } from '../core/dispatch-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs');
process.env.DSP_FAKE_RUNNER = FAKE_RUNNER;

const tempDirs = [];
function newWorkRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'dsp-chan-test-'));
  tempDirs.push(dir);
  return dir;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, what, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waitFor(${what}) 超时`);
    await sleep(20);
  }
}

async function waitForState(d, id, states, what, timeoutMs = 15000) {
  return waitFor(() => {
    const j = d.get(id);
    return j && states.includes(j.state) ? j : null;
  }, `waitForState(${what})`).then(() => d.get(id));
}

/** 拦截 spawn 记录命令行（断言 --resume/--model 用），透传给真实 spawn。 */
function spawnCapture() {
  const calls = [];
  return {
    calls,
    impl: (cmd, args, opts) => {
      calls.push(args);
      return nodeSpawn(cmd, args, opts);
    },
  };
}

/** 设置/还原本进程 env（假 runner 在 spawn 时快照 process.env，dispatch 同步 spawn，先设后派发即可）。 */
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('暂停分类：4 类签名 → paused + 正确 pauseReason；unknown 保持 failed；无输出 classifyPause=null', async () => {
  const cases = [
    { text: 'Error: quota_exceeded: plan quota used up (429)', reason: 'quota-exhausted' },
    { text: 'coding_plan_not_entitled: 当前账号未开通该套餐', reason: 'plan-not-entitled' },
    { text: 'ClientRequestSigningV4Error: Client signing credential must contain one separator', reason: 'provider-signing' },
    { text: 'Select a model before continuing (CONFIGURATION_ERROR)', reason: 'config-error' },
  ];
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot() });
  for (const c of cases) {
    await withEnv({ FAKE_SLEEP_MS: '20', FAKE_EXIT_CODE: '1', FAKE_PAUSE_TEXT: c.text, FAKE_DONE_BEFORE_PAUSE: null }, async () => {
      const j = d.dispatch({ kind: 'prompt', prompt: `t-${c.reason}`, provider: 'plan' });
      const pj = await waitForState(d, j.id, ['paused'], `paused:${c.reason}`);
      assert.equal(pj.pauseReason, c.reason, `签名应分类为 ${c.reason}`);
      assert.ok(pj.pauseDetail.includes(c.text.split(' ')[0]), 'pauseDetail 应为命中的原文行');
    });
  }
  // unknown：有输出但不匹配签名 → 状态保持 failed，仅记 pauseReason:'unknown'（Z1 语义不变）
  await withEnv({ FAKE_SLEEP_MS: '20', FAKE_EXIT_CODE: '1', FAKE_PAUSE_TEXT: '随便一句不匹配的话', FAKE_DONE_BEFORE_PAUSE: null }, async () => {
    const j = d.dispatch({ kind: 'prompt', prompt: 't-unknown', provider: 'plan' });
    const fj = await waitForState(d, j.id, ['failed'], 'failed:unknown');
    assert.equal(fj.pauseReason, 'unknown');
    assert.equal(fj.state, 'failed', 'unknown 不是 paused（按设计）');
  });
  // 完全无输出 → null（如 spawn 失败）；有输出未命中 → unknown（不是 null）
  assert.equal(classifyPause([]), null);
  assert.deepEqual(classifyPause(['随便一句']), { reason: 'unknown', detail: '随便一句' });
  // 优先级：同一行内精确原因（entitlement）先于宽词组（quota 组含 429/balance）；跨行按先出现的行定性（行优先扫描）
  assert.equal(classifyPause(['quota_exceeded with not_entitled mention']).reason, 'plan-not-entitled', '行内精确原因优先');
  assert.equal(classifyPause(['Error: 429 quota_exceeded', 'plan not_entitled ref']).reason, 'quota-exhausted', '跨行按先出现的行');
});

test('paused 不占锁、不堵队列、不自动重试', async () => {
  const cap = spawnCapture();
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), maxConcurrent: 1, spawnImpl: cap.impl });
  let a;
  await withEnv({ FAKE_SLEEP_MS: '30', FAKE_EXIT_CODE: '1', FAKE_PAUSE_TEXT: 'quota_exceeded', FAKE_DONE_BEFORE_PAUSE: null }, async () => {
    a = d.dispatch({ kind: 'prompt', prompt: 'pause-job', provider: 'plan' });
    await waitForState(d, a.id, ['paused'], 'A paused');
  });
  assert.equal(d.get(a.id).state, 'paused');
  assert.equal(existsSync(d.lockPaths.repo), false, 'paused 后 repo 锁文件必须释放');
  /* ZB-25（审计 D#2）：原断言 `existsSync(d.lockPaths.memory) === false` 是**恒真**的 ——
   * ZB-16 已删除 memory 锁，lockPaths 里根本没有 memory 字段，而 `existsSync(undefined)` 在
   * Node 24 返回 false（只有 DEP0187 弃用告警）⇒ 永远通过、测不出任何东西（假绿）。
   * 改为断言"memory 锁概念确实不存在"：该断言在 ZB-16 之前的老实现上会真的失败。 */
  assert.equal('memory' in d.lockPaths, false, 'ZB-16 起 lockPaths 不再有 memory 字段（该锁已删除）');

  const b = d.dispatch({ kind: 'prompt', prompt: 'after-pause-job', provider: 'plan' }); // 无暂停签名，正常跑完
  await waitForState(d, b.id, ['done'], 'B done（队列未被 paused 堵住）');
  assert.equal(cap.calls.length, 2, '总共只 spawn 两次（A、B），paused 不得自动重试');
  const snap = d.snapshot();
  assert.equal(snap.counts.paused, 1);
  assert.equal(snap.counts.done, 1);
});

test('retry 同通道带 sessionId → 命令行含 --resume 且不含 --model（F2）', async () => {
  const cap = spawnCapture();
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), spawnImpl: cap.impl });
  let a;
  await withEnv(
    { FAKE_SLEEP_MS: '20', FAKE_EXIT_CODE: '1', FAKE_PAUSE_TEXT: 'quota_exceeded', FAKE_DONE_BEFORE_PAUSE: '1', FAKE_SESSION: 'sess_resume_T' },
    async () => {
      a = d.dispatch({ kind: 'prompt', prompt: '续跑源任务', provider: 'plan', model: 'GLM-5.3-Flash' });
      await waitForState(d, a.id, ['paused'], 'A paused');
    },
  );
  assert.equal(d.get(a.id).sessionId, 'sess_resume_T', '先打 session 再失败 → job 应有 sessionId');
  assert.equal(d.get(a.id).pauseReason, 'quota-exhausted');
  assert.ok(cap.calls[0].includes('--model'), '首次派发带 model（对照组：证明续跑时被删）');

  const child = d.retry(a.id); // 同通道（opts 空）→ 恢复 env 后子进程正常跑完
  await waitForState(d, child.id, ['done', 'failed', 'paused'], 'child 终态');
  assert.equal(cap.calls.length, 2, '只应再 spawn 一次（续跑），无自动重试');
  const resumeArgs = cap.calls[1];
  assert.ok(resumeArgs.includes('--resume'), '同通道续跑必须带 --resume');
  assert.ok(resumeArgs.includes('sess_resume_T'), '--resume 值应为原 sessionId');
  assert.equal(resumeArgs.includes('--model'), false, 'F2：--resume 时绝不能带 --model');
  assert.equal(resumeArgs[resumeArgs.indexOf('--provider') + 1], 'plan', '同通道续跑 provider 照原 spec 透传');

  // P2 回归：簿记必须能从存储态（d.get）读回，而不是只看 retry 返回值
  const g = d.get(child.id);
  assert.equal(g.parentJobId, a.id, 'd.get(child).parentJobId 应指向旧 job');
  assert.equal(g.attempts.length, 2, 'd.get(child).attempts 应有两条');
  assert.equal(g.attempts[1].reason, 'resume-same-channel');
  assert.equal(g.spec.resume, 'sess_resume_T');
  assert.equal(g.spec.model, undefined, '续跑 spec 里的 model 必须被删掉');
  assert.equal(d.get(a.id).resumedBy, child.id, 'd.get(parent).resumedBy 应指向续跑 job');
});

test('dispatch 直接带 resume → 命令行含 --resume 且不含 --model（F2 的另一条入口）', async () => {
  /* 背景（2026-09-30 现场复现）：F2 原先只在 retry 路径被守住（retry 里 delete spec.model），
   * 而公共入口 dispatch() 会把**通道默认 model 注入** spec → dispatch + resume 组合必然
   * `Error: Model creation failed`（exit=1，resultFile 不产出）。本用例双向锁定：
   *   ① 普通 dispatch 未指定 model → 仍须注入通道默认 model（否则通道默认值失效）；
   *   ② dispatch + resume → 绝不能注入（F2）。 */
  const cap = spawnCapture();
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), spawnImpl: cap.impl });
  d.setChannel({ provider: 'plan', model: 'GLM-5.3-Flash' });

  const plain = d.dispatch({ kind: 'prompt', prompt: '普通派发（对照组①）' });
  await waitForState(d, plain.id, ['done', 'failed'], 'plain 终态');
  assert.equal(d.get(plain.id).spec.model, 'GLM-5.3-Flash', '① 未指定 model 时仍应注入通道默认 model');
  assert.ok(cap.calls[0].includes('--model'), '① 对照组：普通派发命令行应带 --model');

  const res = d.dispatch({ kind: 'prompt', prompt: '续接新指令', resume: 'sess_direct_R' });
  const args = cap.calls[cap.calls.length - 1];
  assert.ok(args.includes('--resume'), '② dispatch + resume 应带 --resume');
  assert.ok(args.includes('sess_direct_R'), '② --resume 值应为传入的 sessionId');
  assert.equal(args.includes('--model'), false, '② F2：dispatch + resume 时绝不能带 --model');
  assert.equal(d.get(res.id).spec.model, undefined, '② resume 的 spec 里不得有被注入的 model');
  assert.equal(d.get(res.id).spec.resume, 'sess_direct_R', '② resume 必须原样写入 spec');
});

test('retry 换通道 → 无 --resume，prompt 含交接五要素；簿记从 d.get()/d.list() 读回', async () => {
  const cap = spawnCapture();
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot(), spawnImpl: cap.impl });
  let a;
  await withEnv({ FAKE_SLEEP_MS: '20', FAKE_EXIT_CODE: '1', FAKE_PAUSE_TEXT: 'quota_exceeded: balance low', FAKE_DONE_BEFORE_PAUSE: null, FAKE_SESSION: null }, async () => {
    a = d.dispatch({ kind: 'prompt', prompt: 'ORIG-TASK-TEXT-唯一标记', provider: 'plan' });
    await waitForState(d, a.id, ['paused'], 'A paused');
  });
  assert.equal(d.get(a.id).sessionId, null, '失败前无 session → 只能交接重跑');

  const child = d.retry(a.id, { provider: 'personal', model: 'deepseek-flash' });
  await waitForState(d, child.id, ['done', 'failed', 'paused'], 'child 终态');
  assert.equal(cap.calls.length, 2);
  const args = cap.calls[1];
  assert.equal(args.includes('--resume'), false, '换通道必须新会话，不能 --resume');
  assert.equal(args.includes('--model'), true, '显式指定了 model 应传 --model');
  assert.equal(args[args.indexOf('--provider') + 1], 'personal');

  const prompt = args[args.indexOf('--prompt') + 1];
  assert.ok(prompt.includes('ORIG-TASK-TEXT-唯一标记') && prompt.includes('原任务开始'), '① 原任务原文');
  assert.ok(prompt.includes('pauseReason: quota-exhausted') && prompt.includes('quota_exceeded: balance low'), '② 上次中断点（pauseReason+Detail）');
  assert.ok(prompt.includes('personal/deepseek-flash') && prompt.includes('交接重跑') && prompt.includes('不是原会话续跑'), '③ 新通道说明');
  assert.ok(prompt.includes('git status') && prompt.includes('不要重做') && prompt.includes('只做剩余部分'), '④ 硬约束');
  assert.ok(prompt.includes('不要回滚') && prompt.includes('不要重复'), '⑤ 禁止');

  // P2 回归：从 d.get() 与 d.list() 双面读回簿记（修复前这里全是 null/0/[]）
  for (const [name, read] of [['get', (id) => d.get(id)], ['list', (id) => d.list().find((x) => x.id === id)]]) {
    const g = read(child.id);
    assert.equal(g.parentJobId, a.id, `[${name}] parentJobId`);
    assert.equal(g.hopCount, 1, `[${name}] hopCount`);
    assert.equal(g.attempts.length, 2, `[${name}] attempts 两条`);
    assert.equal(g.attempts[0].reason, 'quota-exhausted', `[${name}] 首条 attempt 记原暂停原因`);
    assert.equal(g.attempts[1].reason, 'handoff-retry', `[${name}] 次条 attempt 记交接`);
    assert.equal(read(a.id).handedOffTo, child.id, `[${name}] parent.handedOffTo`);
  }
});

test('自动降级链：链必须在 pause 之前 set；跳过不可用通道；链耗尽停 paused；attempts 完整', async () => {
  const d = createDispatcher({
    runnerPath: FAKE_RUNNER,
    workRoot: newWorkRoot(),
    channelsImpl: async () => ({
      channels: [
        { id: 'plan', enabled: true },
        { id: 'ch-b', enabled: false, reason: 'down' },
        { id: 'ch-c', enabled: true },
      ],
      warnings: [],
    }),
  });
  d.setFallbackChain(['plan', 'ch-b', 'ch-c']); // 必须在 dispatch/pause 之前（finalize 时读）
  /* ZB-30：返回值同时带旧形状（chain=通道 id 列表）与新形状（targets=[{provider,model,reasoningLevel}]）。 */
  const fb0 = d.getFallbackChain();
  assert.equal(fb0.enabled, true);
  assert.deepEqual(fb0.chain, ['plan', 'ch-b', 'ch-c'], '旧形状 chain 仍在（CLI/旧客户端可读）');
  assert.deepEqual(fb0.targets, [
    { provider: 'plan', model: null, reasoningLevel: null },
    { provider: 'ch-b', model: null, reasoningLevel: null },
    { provider: 'ch-c', model: null, reasoningLevel: null },
  ], '新形状 targets：字符串项补全为 {provider,model:null,reasoningLevel:null}');
  assert.deepEqual(fb0.target, fb0.targets[0], 'target = 首项');

  // 全程保持暂停签名：A(plan) 暂停 → 自动跳 ch-c（跳过不可用的 ch-b）→ ch-c 再暂停 → 链耗尽停 paused
  await withEnv({ FAKE_SLEEP_MS: '20', FAKE_EXIT_CODE: '1', FAKE_PAUSE_TEXT: 'quota_exceeded', FAKE_DONE_BEFORE_PAUSE: null, FAKE_SESSION: null }, async () => {
    const a = d.dispatch({ kind: 'prompt', prompt: '链源头', provider: 'plan' });
    await waitForState(d, a.id, ['paused'], 'A paused');

    // 等自动降级：A → child(ch-c)
    const child = await waitFor(() => d.list().find((x) => x.parentJobId === a.id) ?? null, '自动跳产出 child');
    assert.equal(child.spec.provider, 'ch-c', '应跳到 ch-c（ch-b 不可用被跳过）');
    await waitForState(d, child.id, ['paused'], 'child 也暂停');

    // 链耗尽：ch-c 之后没有可用通道 → child 停在 paused，且不得产生下一跳
    await sleep(150);
    assert.equal(d.list().filter((x) => x.parentJobId === child.id).length, 0, '链耗尽不得再跳');
    assert.ok(
      d.get(child.id).parseWarnings.some((w) => w.includes('fallback-chain')),
      '应留链停止的 warning',
    );
    assert.equal(d.get(a.id).handedOffTo, child.id);

    // attempts 完整（从存储态读回：A 暂停原因 + child 交接）
    const g = d.get(child.id);
    assert.deepEqual(
      g.attempts.map((x) => x.reason),
      ['auto-fallback:quota-exhausted', 'handoff-retry'],
    );
    assert.equal(g.hopCount, 1);
  });
});

test('listChannels：样例表格解析字段正确（personal 模型取自配置声明）；解析失败 → 空数组 + warning 不抛', async () => {
  // personal provider 配置 fixture：模型列表来自配置（不硬编码）
  const cfgDir = join(newWorkRoot(), 'cfg');
  mkdirSync(cfgDir, { recursive: true });
  const personalPath = join(cfgDir, 'provider_config.json');
  writeFileSync(
    personalPath,
    JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerName: 'DeepSeek 个人接入',
              config: {
                access: { apiKey: 'sk-test' },
                api: { baseUrl: 'https://api.deepseek.example' },
                personalModelIds: ['deepseek-flash', 'deepseek-chat'],
              },
            },
          ],
        },
      },
    }),
  );
  const sample = [
    'provider                          enabled  endpoint                            | models',
    'builtin:bigmodel-coding-plan      true     https://open.bigmodel.example/api   | glm-4.6, GLM-5.3-Flash',
    'builtin:bigmodel-start-plan       false    -                                   | glm-4.6 (coding_plan_not_entitled)',
  ].join('\n');

  const d = createDispatcher({
    runnerPath: FAKE_RUNNER,
    workRoot: newWorkRoot(),
    channelsProbeImpl: async () => sample,
    zcodeConfigPath: join(cfgDir, 'no-config.json'), // 不存在 → 无展示名，用 id
    planCachePath: join(cfgDir, 'no-cache.json'), // 不存在 → 无权益缓存
    personalProviderPath: personalPath,
  });
  const { channels, warnings } = await d.listChannels();
  /* ZB-51：ZCode 走**白名单**（只留 plan 与 account:bigmodel-start-plan）⇒
   * 样例里的 personal 与 builtin:* 两行都被剔除，只剩 plan 别名 + 免费额度合成通道。
   * 留痕警告是**预期**的（剔除不静默），故此处的 warnings 断言按新语义调整。 */
  assert.ok(warnings.some((w) => /白名单/.test(w)), `白名单剔除必须留痕（实际 ${JSON.stringify(warnings)}）`);
  assert.equal(warnings.filter((w) => !/白名单/.test(w)).length, 0, '除白名单留痕外没有其它 warning');
  assert.equal(channels.length, 1, '★ 白名单后 = plan 别名（本 fixture 里没有免费额度行，故只剩它）');
  const plan = channels.find((c) => c.id === 'plan');
  assert.ok(plan, 'plan 别名在清单里');
  assert.equal(plan.enabled, true);
  assert.equal(plan.aliasOf, 'builtin:bigmodel-coding-plan');
  assert.deepEqual(plan.models, ['glm-4.6', 'GLM-5.3-Flash'], 'plan 别名的模型来自被选中的 provider 行');
  /* 白名单外的三行**确实不在清单里**（锁住剔除行为） */
  for (const id of ['personal', 'builtin:bigmodel-coding-plan', 'builtin:bigmodel-start-plan']) {
    assert.equal(channels.find((c) => c.id === id), undefined, `★ 白名单外的 ${id} 已剔除`);
  }
  /* 兜底不变式：清单里**只可能出现白名单内的 zcode 通道**（比"恰好几条"更稳，不依赖 fixture 是否含免费额度行） */
  assert.ok(channels.every((c) => ['plan', 'account:bigmodel-start-plan'].includes(String(c.id))),
    `★ ZCode 通道恒在白名单内（实际 ${JSON.stringify(channels.map((c) => c.id))}）`);
  assert.ok(channels.every((c) => c.engine === 'zcode'), 'zcode 通道都标了引擎');

  // 解析失败：不抛、空数组、有 warning
  const d2 = createDispatcher({
    runnerPath: FAKE_RUNNER,
    workRoot: newWorkRoot(),
    channelsProbeImpl: async () => '这不是表格，一行都解析不出来',
    zcodeConfigPath: join(cfgDir, 'no-config.json'),
    planCachePath: join(cfgDir, 'no-cache.json'),
    personalProviderPath: join(cfgDir, 'no-personal.json'),
  });
  const bad = await d2.listChannels();
  assert.deepEqual(bad.channels, []);
  assert.ok(bad.warnings.length > 0, '解析失败必须有 warning');
});

test('retry 边界：running 上 retry 抛错；setFallbackChain 非数组抛错', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newWorkRoot() });
  await withEnv({ FAKE_SLEEP_MS: '3000' }, async () => {
    const j = d.dispatch({ kind: 'prompt', prompt: '长任务', provider: 'plan' });
    await waitForState(d, j.id, ['running'], 'running');
    assert.throws(() => d.retry(j.id), /仍在 running/, 'running 上 retry 必须抛');
    d.kill(j.id, 'test-cleanup');
  });
  assert.throws(() => d.setFallbackChain('plan,personal'), /数组/, '链必须是数组');
});

// 收尾：等被 kill 的长任务落定后清理临时目录
test('清理临时目录', async () => {
  await sleep(300);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  assert.ok(true);
});
