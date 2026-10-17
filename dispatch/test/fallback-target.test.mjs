/**
 * ZB-30 回归测试：自动降级 = **开关 + 单目标（通道/模型/思考强度）**。
 *
 * 用户要求（原文）：
 *   「自动降级修改下，开关参考派发的开关，点击打开或关闭，带指示灯。打开后下面可以选择通道、模型、
 *     思考强度，跟上面一致的，关闭不显示。」
 *
 * 覆盖：
 *   A. core：setFallbackTarget 单目标（通道+模型+思考强度）/ null 关闭 / 持久化与迁移（version 1 → 2）
 *   B. core：降级跳转时**带上目标的 model 与思考强度**（交接 spec 里能读到）
 *   C. wire：fallback 动作接受对象/数组/null；setFallbackChain 对象走单目标
 *   D. client.js：开关带指示灯（.dsp-dot + aria-pressed）、关闭时不渲染目标三下拉、目标下拉与
 *      「通道」分区同形（provider/model/thinking 三个 .dsp-field）、档位仍走中文标签
 *   E. 文案：内嵌 STRINGS ↔ locale 双向（由 single-source 哨兵兜底，此处钉关键键存在）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDispatcher } from '../core/dispatch-core.mjs';
import { createActionHandler, createRemoteFace } from '../wire.host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs');
process.env.DSP_FAKE_RUNNER = FAKE_RUNNER;
process.env.FAKE_SLEEP_MS = '40';

const tempDirs = [];
const newDir = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tempDirs.push(d);
  return d;
};
test.after(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waitFor(${what}) 超时`);
    await sleep(20);
  }
}
async function waitState(d, id, states, what) {
  await waitFor(() => {
    const j = d.get(id);
    return j && states.includes(j.state) ? j : null;
  }, what);
  return d.get(id);
}
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* ---------- A. core：单目标设置 / 关闭 / 持久化 / 迁移 ---------- */
test('A. core：setFallbackTarget 单目标（通道+模型+思考强度）；null=关闭；落盘 version 2 且旧 version 1 可迁移', async () => {
  const workRoot = newDir('dsp-fb-');
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot });

  assert.deepEqual(d.getFallbackChain(), { enabled: false, chain: [], targets: [], target: null }, '默认关（形状齐全）');

  const r = d.setFallbackTarget({ provider: 'personal', model: 'deepseek-flash', reasoningLevel: 'high' });
  assert.equal(r.enabled, true);
  assert.deepEqual(r.target, { provider: 'personal', model: 'deepseek-flash', reasoningLevel: 'high' });
  assert.deepEqual(r.chain, ['personal'], '旧形状 chain 只取 provider');
  assert.deepEqual(r.targets, [{ provider: 'personal', model: 'deepseek-flash', reasoningLevel: 'high' }]);

  const onDisk = JSON.parse(readFileSync(join(workRoot, 'state', 'fallback.json'), 'utf8'));
  assert.equal(onDisk.version, 2, '落盘 version 2');
  assert.deepEqual(onDisk.chain, ['personal'], '落盘同时带旧形状 chain（CLI/旧读者可读）');
  assert.deepEqual(onDisk.targets, [{ provider: 'personal', model: 'deepseek-flash', reasoningLevel: 'high' }]);

  /* 缺省维度 = null = 沿用原任务（不是空串、不是 'agent'） */
  const r2 = d.setFallbackTarget({ provider: 'plan' });
  assert.deepEqual(r2.target, { provider: 'plan', model: null, reasoningLevel: null }, '缺省 model/档位 = null（沿用原任务）');
  /* thinking 二名亦可 */
  const r3 = d.setFallbackTarget({ provider: 'plan', thinking: 'disabled' });
  assert.equal(r3.target.reasoningLevel, 'disabled', 'thinking 是 reasoningLevel 的二名');
  /* 无 provider 拒绝（不猜） */
  assert.throws(() => d.setFallbackTarget({ model: 'x' }), /provider/, '无 provider 必须报错，不猜');

  /* 关闭：null / 空数组 / setFallbackChain([]) 三条路等价 */
  assert.equal(d.setFallbackTarget(null).enabled, false);
  assert.equal(d.setFallbackTarget({ provider: 'plan' }).enabled, true);
  assert.equal(d.setFallbackChain([]).enabled, false);
  assert.equal(d.setFallbackTarget('plan').enabled, true, '字符串也接受（等价单目标）');

  /* 旧 version 1 文件（只有 chain）→ 自动迁移成 targets */
  const workRoot2 = newDir('dsp-fb-mig-');
  const d2 = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: workRoot2 });
  d2.setFallbackChain(['a', 'b']);
  const f = join(workRoot2, 'state', 'fallback.json');
  const legacy = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, `${JSON.stringify({ version: 1, chain: legacy.chain }, null, 2)}\n`); // 手写回旧形状
  const d3 = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: workRoot2 });
  const migrated = d3.getFallbackChain();
  assert.deepEqual(migrated.chain, ['a', 'b'], '旧文件 chain 读回');
  assert.deepEqual(migrated.targets, [
    { provider: 'a', model: null, reasoningLevel: null },
    { provider: 'b', model: null, reasoningLevel: null },
  ], '★ 旧 version 1 自动迁移成新形状（不丢配置）');
});

/* ---------- B. core：降级跳转带上目标的 model / 思考强度 ---------- */
test('★ B. 自动降级：跳到目标时带上目标通道的 model 与思考强度（交接 spec 可核对）', async () => {
  const d = createDispatcher({
    runnerPath: FAKE_RUNNER,
    workRoot: newDir('dsp-fb-jump-'),
    channelsImpl: async () => ({
      channels: [{ id: 'plan', enabled: true }, { id: 'personal', enabled: true }],
      warnings: [],
    }),
  });
  d.setFallbackTarget({ provider: 'personal', model: 'deepseek-flash', reasoningLevel: 'max' });

  await withEnv({ FAKE_EXIT_CODE: '1', FAKE_PAUSE_TEXT: 'quota_exceeded', FAKE_DONE_BEFORE_PAUSE: null, FAKE_SESSION: null }, async () => {
    const a = d.dispatch({ kind: 'prompt', prompt: '降级源头', provider: 'plan' });
    await waitState(d, a.id, ['paused'], 'A paused');
    const child = await waitFor(() => d.list().find((x) => x.parentJobId === a.id) ?? null, '自动跳产出 child');
    assert.equal(child.spec.provider, 'personal', '跳到目标的通道');
    assert.equal(child.spec.model, 'deepseek-flash', '★ 目标的 model 生效');
    assert.equal(child.spec.reasoningLevel, 'max', '★ 目标的思考强度生效');
    await waitState(d, child.id, ['paused', 'failed', 'done'], 'child 落地');
  });
});

test('B2. core/CLI 路径：目标未指定 model/档位（null）⇒ 沿用原任务（面板不再产生 null，见 D 段）', async () => {
  const d = createDispatcher({
    runnerPath: FAKE_RUNNER,
    workRoot: newDir('dsp-fb-keep-'),
    channelsImpl: async () => ({ channels: [{ id: 'plan', enabled: true }, { id: 'personal', enabled: true }], warnings: [] }),
  });
  d.setFallbackTarget({ provider: 'personal' });
  await withEnv({ FAKE_EXIT_CODE: '1', FAKE_PAUSE_TEXT: 'quota_exceeded', FAKE_DONE_BEFORE_PAUSE: null, FAKE_SESSION: null }, async () => {
    const a = d.dispatch({ kind: 'prompt', prompt: 'x', provider: 'plan', model: 'GLM-5.3-Flash', reasoningLevel: 'enabled' });
    await waitState(d, a.id, ['paused'], 'A paused');
    const child = await waitFor(() => d.list().find((x) => x.parentJobId === a.id) ?? null, 'child');
    assert.equal(child.spec.model, undefined, '目标未指定 model ⇒ 沿用原任务（不注入）');
    assert.equal(child.spec.reasoningLevel, 'enabled', '目标未指定档位 ⇒ 沿用原任务档位');
    await waitState(d, child.id, ['paused', 'failed', 'done'], 'child 落地');
  });
});

/* ---------- C. wire：动作与 face 形状 ---------- */
test('C. wire：fallback 动作接受 对象/数组/null；face.setFallbackChain 对象走单目标', async () => {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot: newDir('dsp-fb-wire-') });
  const handle = createActionHandler(d, {});

  const r1 = await handle('fallback', { chain: { provider: 'personal', model: 'deepseek-flash', thinking: 'high' } });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.target, { provider: 'personal', model: 'deepseek-flash', reasoningLevel: 'high' },
    '对象 chain ⇒ 单目标（面板开关路径）');

  const r2 = await handle('fallback', { chain: ['plan', 'personal'] });
  assert.deepEqual(r2.chain, ['plan', 'personal'], '数组 ⇒ 多目标（旧路径）');
  assert.deepEqual(r2.targets.map((t) => t.provider), ['plan', 'personal']);

  const r3 = await handle('fallback', { chain: null });
  assert.equal(r3.enabled, false, 'null ⇒ 关闭');

  const r4 = await handle('fallback', {});
  assert.equal(r4.ok, true, '无参 = 读当前设置');

  const face = createRemoteFace(d, {});
  const f1 = await face.setFallbackChain({ provider: 'plan', model: 'GLM-5.3', reasoningLevel: 'enabled' });
  assert.equal(f1.ok, true);
  assert.deepEqual(f1.target, { provider: 'plan', model: 'GLM-5.3', reasoningLevel: 'enabled' },
    '★ face.setFallbackChain 传对象 ⇒ 单目标（面板实际调用路径）');
  const f2 = await face.fallbackChain();
  assert.deepEqual(f2.targets, [{ provider: 'plan', model: 'GLM-5.3', reasoningLevel: 'enabled' }], 'face 读回新形状');
  const f3 = await face.setFallbackChain(null);
  assert.equal(f3.enabled, false, 'null 仍可关闭（旧缺陷：会被拆成 ["null"]）');
});

/* ---------- D. client.js：开关形态 + 关闭不显示 + 与「通道」分区同形 ---------- */
test('D. ★ client.js：降级开关带指示灯（.dsp-dot）、aria-pressed；关闭时不渲染目标三下拉；档位走中文标签', () => {
  const src = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
  /* 反断言（"旧形态/旧文案键已彻底移除"）必须在**剥注释后**的源码上做：
   * 否则源码里一句提到旧键名的解释性注释就会假红（本文件曾被这种注释坑过）。
   * 实现与 panel-style / toolview-card / shared-wire-liveness 逐字一致。 */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const code = stripComments(src);
  /* 开关：按钮 + 指示灯 + aria-pressed（与标题栏派发开关同一套视觉语言） */
  assert.ok(/className: 'dsp-switch dsp-toggle'/.test(src), '★ 降级开关是 dsp-switch 按钮（与派发开关同类）');
  assert.ok(/h\('span', \{ className: 'dsp-dot', style: \{ background: fbEnabled \? T\.stDone : T\.danger \} \}\)/.test(src),
    '★ 开关带指示灯（开=stDone / 关=danger，不写字面色值）');
  assert.ok(/'aria-pressed': fbEnabled/.test(src), '开关带 aria-pressed（无障碍状态）');
  assert.ok(/\.dsp-toggle\{/.test(src) && /button\.dsp-toggle:hover:not\(:disabled\)/.test(src),
    '开关有自己的样式与 hover 反馈（不再复用一次性内联样式）');
  /* 关闭不显示：目标三下拉整体在 fbEnabled 条件下 */
  assert.ok(/fbEnabled \? h\('div', \{ className: 'dsp-stack' \},/.test(src),
    '★ 目标选择项整体受 fbEnabled 控制（关闭时不显示）');
  /* 与上面「通道」分区同形：三行 .dsp-field（通道/模型/思考强度） */
  assert.ok(/aria-label': `\$\{t\('fallbackTitle'\)\}-\$\{t\('provider'\)\}`/.test(src)
    && /aria-label': `\$\{t\('fallbackTitle'\)\}-\$\{t\('model'\)\}`/.test(src)
    && /aria-label': `\$\{t\('fallbackTitle'\)\}-\$\{t\('thinking'\)\}`/.test(src),
    '目标三下拉各带「降级-通道/模型/思考强度」aria-label（与「通道」分区区分，避免重复标签）');
  /* ZB-30b（用户要求「不要沿用原任务，就跟上面完全一致的选项逻辑」）：
   * 模型首项 = 与上面同一个 key（chanDefaultModel）；档位首项 = 与上面同一个 key（thinkingAgent）。 */
  assert.ok(/h\('option', \{ value: '' \}, t\('chanDefaultModel'\)\)/.test(src),
    '★ 降级模型首项 = （通道默认模型），与上面「通道」分区同一个文案键');
  assert.ok(/h\('option', \{ value: 'agent' \}, t\('thinkingAgent'\)\)/.test(src),
    '★ 降级档位首项 = Agent决定（按任务判断），与上面「通道」分区同一个文案键');
  assert.ok(!/fallbackKeepModel|fallbackKeepThinking/.test(code),
    '★ 「沿用原任务…」文案键已彻底移除（用户明确要求；剥注释后判定）');
  assert.ok(/disabled: busy \|\| !fbSel \|\| !fbSel\.enabled/.test(src),
    '★ 降级模型下拉的禁用判据与上面一致（跟随所选通道是否可用）');
  assert.ok(!/fallbackPh|fallbackSave|fallbackOffBtn|fallbackConfirm2/.test(code),
    '★ 旧的「逗号输入 + 二次确认按钮」形态已彻底移除（不留死代码；剥注释后判定）');
  assert.ok(!/fallbackEmptyErr/.test(code) && !/fallbackSaved/.test(code), '旧文案键不再被引用（剥注释后判定）');
  /* 档位中文标签仍走 thinkingLabel（ZB-29e 不回退） */
  assert.ok(/fbLevels\.map\(\(lv\) => h\('option', \{ key: lv, value: lv \}, thinkingLabel\(lv\)\)\)/.test(src),
    '★ 降级档位下拉：value 仍原始字符串，label 中文');
});

/* ---------- E. 文案三处同源（关键键存在） ---------- */
test('E. 文案：新增键在 client STRINGS 与 locale 中英四处齐备', () => {
  const src = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
  const zh = JSON.parse(readFileSync(join(HERE, '..', 'locale', 'zh.json'), 'utf8')).ui;
  const en = JSON.parse(readFileSync(join(HERE, '..', 'locale', 'en.json'), 'utf8')).ui;
  for (const k of ['fallbackTitle', 'fallbackStateOff', 'fallbackStateOn', 'fallbackEnableTitle', 'fallbackHint', 'fallbackOfflineHint']) {
    assert.ok(new RegExp(`${k}:`).test(src), `client.js STRINGS 含 ${k}`);
    assert.ok(zh[k], `locale/zh.json 含 ${k}`);
    assert.ok(en[k], `locale/en.json 含 ${k}`);
  }
  for (const k of ['fallbackKeepModel', 'fallbackKeepThinking']) {
    assert.ok(!zh[k] && !en[k], `locale 已删除 ${k}（沿用原任务文案不再存在）`);
  }
  assert.equal(zh.fallbackTitle, '自动降级', '标题去掉「链」字（现在是开关 + 单目标）');
});