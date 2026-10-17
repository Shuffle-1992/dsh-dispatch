/**
 * ZB-29 回归测试：思考强度（thinking / reasoningLevel，ZCode Thought Level）。
 *
 * 语义（用户要求的「Agent决定」档）：
 *   · `thinking='agent'`（默认）= **Agent决定**：由派发方 Agent 按任务自行判断并**改传具体档位**；
 *     core 层对 'agent' **不透传** runner 参数 = 不覆盖（ZCode 按模型默认档）。
 *   · 具体档位（如 enabled / low / max）= 严格生效：runner 写入临时 provider 配置的
 *     `defaultModelSelection.options.reasoningLevel`，ZCode 会话创建即按此档运行。
 *   · 档位集合**随模型声明不同**（GLM-5 系 disabled|enabled；deepseek-v4 系 disabled|low|high|max），
 *     runner `--list-providers` 输出 `[zcode-run] reasoning-levels <model>=<a,b>`，core 解析为
 *     `channels[].thinkingLevels` 供 UI 下拉；core **不写死枚举**。
 *   · 非法档位 fail-fast（runner 校验 / ZCode 会话创建校验），不静默降级。
 *   · 仅新建会话生效；--resume 沿用原会话档位（core 对 resume 不透传）。
 *
 * 覆盖：parseProviderTable / listChannels（channelsProbeImpl）/ core 透传与字段 /
 *       wire 映射（thinking → spec.reasoningLevel）/ validateSpec / 交接沿用 / runner 注入（hermetic 干跑）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher, parseProviderTable, parseRunnerLine } from '../core/dispatch-core.mjs';
import { createActionHandler } from '../wire.host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs');
const RUNNER = join(HERE, '..', '..', 'collab-kit', 'zcode-run.mjs'); // test → 插件目录 → 仓库根
process.env.DSP_FAKE_RUNNER = FAKE_RUNNER;
process.env.FAKE_SLEEP_MS = '60';

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
const TERMINAL = ['done', 'failed', 'killed', 'interrupted'];
async function waitTerminal(d, id, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const j = d.get(id);
    if (j && (TERMINAL.includes(j.state) || j.state === 'paused')) return j;
    await sleep(20);
  }
  throw new Error(`waitTerminal(${id}) 超时`);
}

/* ---------- A. parseProviderTable：reasoning-levels 行 → modelLevels ---------- */
test('parseProviderTable：reasoning-levels 行解析为 modelLevels（不混入 provider 行）', () => {
  const text = [
    'id                                enabled   端点/模型',
    'builtin:bigmodel-coding-plan      true      https://x | GLM-5.3, GLM-5.3-Flash',
    '[zcode-run] reasoning-levels GLM-5.3=disabled,enabled',
    '[zcode-run] reasoning-levels GLM-5.3-Flash=disabled,enabled',
  ].join('\n');
  const r = parseProviderTable(text);
  assert.equal(r.rows.length, 1, '表格行数不受 thinking 行影响');
  assert.deepEqual(r.modelLevels['GLM-5.3'], ['disabled', 'enabled']);
  assert.deepEqual(r.modelLevels['GLM-5.3-Flash'], ['disabled', 'enabled']);
  assert.equal(r.warnings.length, 0);
  assert.deepEqual(parseProviderTable('纯垃圾文本').modelLevels, {}, '无档位行时 modelLevels 为空（不猜）');
});

test('parseRunnerLine：注入确认行 → {reasoningLevelApplied, reasoningTarget}', () => {
  const p = parseRunnerLine('[zcode-run] reasoning-level=enabled target=plan:bigmodel-coding-plan/GLM-5.3');
  assert.equal(p.reasoningLevelApplied, 'enabled');
  assert.equal(p.reasoningTarget, 'plan:bigmodel-coding-plan/GLM-5.3');
  assert.equal(parseRunnerLine('[zcode-run] 别的行'), null, '未知 [zcode-run] 行仍返回 null（parseWarnings 语义不变）');
});

/* ---------- B. listChannels：channelsProbeImpl → channels[].thinkingLevels ---------- */
test('listChannels：通道带 thinkingLevels（plan 别名继承选中 provider 的档位集）', async () => {
  const d = createDispatcher({
    runnerPath: FAKE_RUNNER,
    workRoot: newDir('dsp-think-'),
    channelsProbeImpl: async () => [
      'id'.padEnd(34) + 'enabled   端点/模型',
      'builtin:bigmodel-coding-plan'.padEnd(34) + 'true      https://x | GLM-5.3, GLM-5.3-Flash',
      '[zcode-run] reasoning-levels GLM-5.3=disabled,enabled',
      '[zcode-run] reasoning-levels GLM-5.3-Flash=disabled,enabled',
    ].join('\n'),
  });
  const r = await d.listChannels();
  const plan = r.channels.find((c) => c.id === 'plan');
  /* ZB-51：ZCode 通道白名单**只保留 plan 与 account:bigmodel-start-plan**，
   * 故 `builtin:bigmodel-coding-plan` 不再出现在清单里（这不是回归，是用户决定的彻底剔除）。
   * 档位并集的断言改为落在 `plan` 别名上 —— 它正是"继承选中 provider 档位集"的那条。 */
  assert.ok(plan, 'plan 别名在清单里（白名单内）');
  assert.deepEqual(plan.thinkingLevels, ['disabled', 'enabled'], 'plan 别名继承选中 provider 的档位（并集）');
  /* 白名单外的通道**确实不在清单里**（锁住剔除行为本身，且必须留痕在 warnings） */
  assert.equal(r.channels.find((c) => c.id === 'builtin:bigmodel-coding-plan'), undefined,
    '★ 白名单外的 builtin:* 通道已从清单剔除');
  assert.ok((r.warnings ?? []).some((w) => /白名单/.test(w)),
    `★ 剔除必须在 warnings 里留痕（实际 ${JSON.stringify(r.warnings)}）`);
  /* ★ 形状契约：thinkingLevels 是**数组**（并集），不是 map —— 面板按数组消费。
   * 曾把面板写成 map 取值（lvMap[model]）⇒ 下拉只剩 Agent决定（现场 bug，此处防复发）。 */
  assert.ok(Array.isArray(plan.thinkingLevels), '★ thinkingLevels 是数组（面板据此渲染档位选项）');
  const clientSrc = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
  /* 面板消费契约在**剥注释后**的源码上断言：注释里提到某个标识符不应该算"实现了它"
   * （所以 D 段用 code 而不是 src）。实现与 panel-style / toolview-card 逐字一致。 */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const clientCode = stripComments(clientSrc);
  /* ZB-51：面板改为取**该引擎下所有子通道的并集**（`Array.isArray(sel.thinkingLevels)` 仍是其中一环）。
   * 形状契约不变 —— 消费的是**数组**，不是 map。 */
  assert.ok(/Array\.isArray\(sel\.thinkingLevels\)/.test(clientCode),
    '★ 面板按数组消费 sel.thinkingLevels（不是 map 取值；剥注释后判定）');
  /* ★ ZB-29e：档位**中文显示** —— 值仍传原始字符串（disabled/enabled/…），只在显示层映射标签；
   * 未知档位原样显示（不隐藏、不猜语义）。 */
  assert.ok(/const THINKING_LABEL_KEY = \{ disabled: 'thinkDisabled'/.test(clientCode),
    '★ 档位中文标签映射表存在（disabled/enabled/low/high/max）');
  assert.ok(/const thinkingLabel = \(lv\) => \(lv == null \|\| lv === '' \? '' : t\(THINKING_LABEL_KEY\[lv\] \?\? ''\) \|\| lv\)/.test(clientCode),
    '★ thinkingLabel：命中映射走中文，未知档位原样回退（不隐藏）');
  assert.ok(/h\('option', \{ key: lv, value: lv \}, thinkingLabel\(lv\)\)/.test(clientCode),
    '★ 通道下拉：option value 仍是原始档位字符串，label 用中文');
  const zh = JSON.parse(readFileSync(join(HERE, '..', 'locale', 'zh.json'), 'utf8'));
  const en = JSON.parse(readFileSync(join(HERE, '..', 'locale', 'en.json'), 'utf8'));
  for (const k of ['thinkDisabled', 'thinkEnabled', 'thinkLow', 'thinkHigh', 'thinkMax']) {
    assert.ok(zh.ui[k] && en.ui[k], `locale 中英都有档位标签 ${k}（zh=${zh.ui[k]}）`);
  }
  /* ZB-51：`personal` 已被 ZCode 白名单剔除（用户决定只留 plan 与免费额度），故这里改为
   * 直接验证**档位缺失的语义**：字段缺席 / null ⇒ 面板走"无档位"分支，绝不凭空造档位。
   * （原来的断言挂在 personal 通道上；语义本身不变，只是取样对象随之调整。） */
  const planLevels = r.channels.find((c) => c.id === 'plan').thinkingLevels;
  assert.ok(Array.isArray(planLevels), 'plan 有探测数据 ⇒ 数组');
  const missing = r.channels.find((c) => c.thinkingLevels == null);
  assert.ok(missing == null || missing.thinkingLevels == null,
    '★ 无探测数据的通道 thinkingLevels 为 null/undefined（不猜，面板按数组消费）');
  assert.ok(!Array.isArray(undefined), '★ 无探测数据时绝不是数组（不得凭空造档位）');
});

/* ---------- C/D. core 透传 + 字段 + wire 映射 + validateSpec ---------- */
test('★ core：具体档位 → runner 参数 --reasoning-level；agent/未指定 → 不透传', async () => {
  const workRoot = newDir('dsp-think-');
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot, maxConcurrent: 1 });
  /* 每次派发独立 argv 目录（文件名带 fake runner 子进程 pid，同目录多文件会有字典序歧义）。 */
  const readArgvOf = (argvDir) => {
    const files = readdirSync(argvDir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1, `该目录应恰有一份 argv（实际 ${files.length}）`);
    return JSON.parse(readFileSync(join(argvDir, files[0]), 'utf8'));
  };

  const argvDir1 = newDir('dsp-argv1-');
  process.env.FAKE_ARGV_FILE = join(argvDir1, 'argv');
  const j1 = d.dispatch({ kind: 'prompt', prompt: 'x', tag: 't1', reasoningLevel: 'enabled' });
  const done1 = await waitTerminal(d, j1.id);
  const argv1 = readArgvOf(argvDir1);
  const i1 = argv1.indexOf('--reasoning-level');
  assert.ok(i1 >= 0, '具体档位应透传 --reasoning-level');
  assert.equal(argv1[i1 + 1], 'enabled');
  assert.equal(done1.reasoningLevel, 'enabled', 'job 记录请求档位');
  assert.equal(done1.reasoningLevelApplied, 'enabled', '假 runner 回显 ⇒ Applied 确认位');
  assert.equal(done1.reasoningTarget, 'fake-plan/fake-model');

  const argvDir2 = newDir('dsp-argv2-');
  process.env.FAKE_ARGV_FILE = join(argvDir2, 'argv');
  const j2 = d.dispatch({ kind: 'prompt', prompt: 'y', tag: 't2', reasoningLevel: 'agent' });
  const done2 = await waitTerminal(d, j2.id);
  const argv2 = readArgvOf(argvDir2);
  const i2 = argv2.indexOf('--reasoning-level');
  assert.ok(i2 >= 0, "★ 'agent'（Agent决定）**也透传** —— runner 按 ZCode 默认规则解析成实际档位");
  assert.equal(argv2[i2 + 1], 'agent', 'core 原样传 agent（解析在 runner，读得到模型声明）');
  assert.equal(done2.reasoningLevel, 'agent');
  assert.equal(done2.reasoningLevelApplied, 'agent', '假 runner 原样回显 ⇒ Applied=agent（真实 runner 会解析成声明档位最后一档）');
  delete process.env.FAKE_ARGV_FILE;

  const j3 = d.dispatch({ kind: 'prompt', prompt: 'z', tag: 't3' });
  const done3 = await waitTerminal(d, j3.id);
  assert.equal(done3.reasoningLevel, 'agent', '未指定 ⇒ 通道默认思考强度（新通道未设置即 agent=Agent决定）');
  assert.throws(() => d.dispatch({ kind: 'prompt', prompt: 'x', reasoningLevel: '  ' }), TypeError, '空白档位拒绝');
  assert.throws(() => d.dispatch({ kind: 'prompt', prompt: 'x', reasoningLevel: 3 }), TypeError, '非字符串拒绝');
});

test('wire：dispatch 的 thinking 参数 → spec.reasoningLevel（工具层映射 + 通道默认回退）', async () => {
  const workRoot = newDir('dsp-think-');
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot, maxConcurrent: 1 });
  const handle = createActionHandler(d, {});
  const r = await handle('dispatch', { kind: 'prompt', prompt: 'x', thinking: 'enabled' });
  assert.equal(r.ok, true);
  assert.equal(r.job.spec.reasoningLevel, 'enabled', '工具参数 thinking 落到 spec.reasoningLevel');
  const r2 = await handle('dispatch', { kind: 'prompt', prompt: 'y' });
  assert.equal(r2.job.spec.reasoningLevel, 'agent', '不传 thinking ⇒ 通道默认（新通道未设置即 agent）');
  /* ZB-29d：通道设置即给派发 Agent 的规定——设了具体档位，未显式指定的派发一律按它执行 */
  await handle('channel', { provider: 'plan', reasoningLevel: 'disabled' });
  const r3 = await handle('dispatch', { kind: 'prompt', prompt: 'z' });
  assert.equal(r3.job.spec.reasoningLevel, 'disabled', '★ 通道设置的档位 = 未显式指定派发的硬性规定');
  const r4 = await handle('dispatch', { kind: 'prompt', prompt: 'w', thinking: 'agent' });
  assert.equal(r4.job.spec.reasoningLevel, 'agent', '显式 agent 覆盖通道设置（Agent决定）');
  await Promise.all([r.job.id, r2.job.id, r3.job.id, r4.job.id].map((id) => waitTerminal(d, id)));
});

test('retry 交接重跑：沿用原任务的思考强度档位', async () => {
  const workRoot = newDir('dsp-think-');
  process.env.FAKE_PAUSE_TEXT = 'Error: quota_exceeded for this window';
  process.env.FAKE_EXIT_CODE = '1';
  process.env.FAKE_DONE_BEFORE_PAUSE = '1';
  try {
    const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot, maxConcurrent: 1 });
    const j = d.dispatch({ kind: 'prompt', prompt: 'x', tag: 'think-h', reasoningLevel: 'enabled' });
    const paused = await waitTerminal(d, j.id);
    assert.equal(paused.state, 'paused');
    const nj = d.retry(j.id, { provider: 'personal' }); // 换通道 ⇒ 交接重跑（新会话）
    assert.equal(nj.spec.reasoningLevel, 'enabled', '交接 spec 沿用原档位（新会话 ⇒ 档位生效）');
    await waitTerminal(d, nj.id);
  } finally {
    delete process.env.FAKE_PAUSE_TEXT;
    delete process.env.FAKE_EXIT_CODE;
    delete process.env.FAKE_DONE_BEFORE_PAUSE;
  }
});

/* ---------- E. runner 注入 hermetic 干跑（假 CLI 零网络；断言临时 provider 配置内容） ---------- */
test('★ runner：--reasoning-level 写入临时 provider 配置的 defaultModelSelection（hermetic 干跑）', () => {
  const proj = newDir('dsp-rl-proj-');
  const builtin = join(proj, 'builtin.json');
  const personal = join(proj, 'personal.json');
  const dummy = join(proj, 'dummy-cli.cjs');
  const argvOut = join(proj, 'argv.json');
  mkdirSync(join(proj, 'collab'), { recursive: true });
  /* 内置声明：test-model 支持 disabled|enabled */
  writeFileSync(builtin, JSON.stringify({
    schemaVersion: 1,
    config: { modelConfigRules: { modelRules: [{ modelMatch: '.*test-model.*', config: { optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'], map: '{}' } } } }] } },
  }));
  /* 个人 provider：prov-x / test-model（有声明）与 plain-model（无声明，测 Agent决定无法解析的分支） */
  writeFileSync(personal, JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [{ providerId: 'prov-x', providerName: 'X', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'k' }, api: { type: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:9' }, personalModelIds: ['test-model', 'plain-model'], modelOrder: ['test-model', 'plain-model'] } }] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  }));
  /* 假 CLI：把临时 provider 配置里的 defaultModelSelection 落盘（临时目录随后被 runner 删除，必须趁运行时拷出） */
  writeFileSync(dummy, 'const fs=require("fs");try{const c=JSON.parse(fs.readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,"utf8"));fs.writeFileSync(process.env.ARGV_OUT,JSON.stringify(c.config.defaultModelSelection??null));}catch(e){fs.writeFileSync(process.env.ARGV_OUT,"ERR:"+e.message);}');

  const env = {
    ...process.env,
    ZCODE_CLI: dummy,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
    ARGV_OUT: argvOut,
    FAKE_ARGV_FILE: '', // 与本测试无关
  };
  delete env.FAKE_ARGV_FILE;
  const run = (extra) => spawnSync(process.execPath, [RUNNER, '--project', proj, '--prompt', 'x', '--provider', 'personal', '--personal-config', personal, '--model', 'test-model', '--no-ledger', ...extra], { env, encoding: 'utf8', timeout: 60000 });

  const r1 = run(['--reasoning-level', 'enabled']);
  assert.equal(r1.status, 0, `干跑应成功（stderr: ${r1.stderr}）`);
  const sel = JSON.parse(readFileSync(argvOut, 'utf8'));
  assert.deepEqual(sel, { providerId: 'prov-x', modelId: 'test-model', options: { reasoningLevel: 'enabled' } },
    '★ defaultModelSelection 注入临时 provider 配置（headless 会话初始档位）');

  const r2 = run([]);
  assert.equal(r2.status, 0);
  assert.equal(readFileSync(argvOut, 'utf8'), 'null', '未指定档位 ⇒ 不写 defaultModelSelection（行为不变）');

  const r3 = run(['--reasoning-level', 'high']);
  assert.equal(r3.status, 1, '非法档位 fail-fast');
  assert.match(r3.stderr, /disabled\|enabled/, '报错列出可用档位');

  /* ★「Agent决定」档：runner 按 ZCode 自身默认规则解析（声明档位的**最后一档**，= QKe/v3i 的 values.at(-1)）*/
  const r5 = run(['--reasoning-level', 'agent']);
  assert.equal(r5.status, 0, `agent 档干跑应成功（stderr: ${r5.stderr}）`);
  assert.match(r5.stdout, /reasoning-level=enabled/, '解析成声明档位最后一档（disabled|enabled → enabled）并打印确认行');
  const sel5 = JSON.parse(readFileSync(argvOut, 'utf8'));
  assert.deepEqual(sel5, { providerId: 'prov-x', modelId: 'test-model', options: { reasoningLevel: 'enabled' } },
    '★ agent 档注入的实际档位 = enabled（与 ZCode 未显式选择时的行为一致）');

  /* 模型未声明档位 ⇒ 无法解析 Agent决定 → 不注入 + 警告（交给 ZCode 默认，不猜） */
  const r6 = run(['--model', 'plain-model', '--reasoning-level', 'agent']);
  assert.equal(r6.status, 0, `未声明模型不失败（stderr: ${r6.stderr}）`);
  assert.match(r6.stderr, /未声明思考强度档位/, '警告：无法解析 Agent决定');
  assert.equal(readFileSync(argvOut, 'utf8'), 'null', '未声明 ⇒ 未注入');

  const r4 = run(['--resume', 'sess_x', '--reasoning-level', 'enabled']);
  assert.equal(r4.status, 0, `resume 场景不注入也不报错（stderr: ${r4.stderr}）`);
  assert.match(r4.stderr, /--resume/, '并如实警告沿用原会话档位');
  assert.equal(readFileSync(argvOut, 'utf8'), 'null', 'resume ⇒ 未注入');
});
