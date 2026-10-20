/**
 * ZB-31 回归测试：思考强度探测**漏档**（用户报「GLM-5.3 系 / deepseek-flash 没有低/高/最高选项」）。
 *
 * 结论：**不是 CLI 不支持**，而是本探测器的两处与 ZCode 不一致（都是探测器缺陷，非能力缺失）：
 *
 *  ① **匹配式**：ZCode 用 `vWt(modelMatch, modelId, true)` = `new RegExp('^(?:'+match+')$','i')`
 *     —— **锚定 + 忽略大小写**。本文件原先 `new RegExp(r.modelMatch).test(id)`（无锚点、无 i）。
 *     内置 modelRules 里 `.*glm-5(?:…)?` → `disabled,enabled` 排在
 *     `.*glm-5\.3(?:-flash)?(?:…)?` → `low,high,max` **之前**；ZCode 忽略大小写 ⇒ 两条都命中，
 *     后者覆盖 ⇒ 真值 `low,high,max`。大小写敏感 ⇒ 小写那条**永不命中** `GLM-5.3`
 *     ⇒ 只剩 `.*glm-5` 的 `disabled,enabled` ⇒ 面板只有两档（用户看到的现场）。
 *  ② **枚举面**：`--list-providers` 只遍历桌面端 `config.json` 的 `provider[*].models`，
 *     而 `deepseek-flash` 只出现在**个人通道**（`provider_config.json` 的 `personalModelIds`）
 *     ⇒ 没有 `reasoning-levels` 行 ⇒ core 的 `levelsOf` 返回 null ⇒ 面板退回通用提示。
 *
 * 覆盖：
 *  A. runner 探测（真实内置配置 + 假 personal 配置的 hermetic 干跑）——两条根因各一组断言
 *  B. 匹配式与 ZCode 逐字同式（锚定 + i）；坏正则不抛
 *  C. core：plan 别名与 personal 通道都带上 thinkingLevels（同一份探测表）
 *  D. 真实内置配置的**现场值**断言（GLM-5.3/Flash = low,high,max；deepseek-flash = 四档）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDispatcher, parseProviderTable } from '../core/dispatch-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, '..', '..', 'collab-kit', 'zcode-run.mjs');
const BUILTIN = 'F:\\Program Files\\ZCode\\resources\\config\\provider\\zcode-builtin.json';
const APP_CONFIG = join(homedir(), '.zcode', 'v2', 'config.json');

/* ---------- A. runner 探测：枚举面补齐个人通道模型（根因 ②） ---------- */
test('A. ★ --list-providers 覆盖个人通道模型（deepseek-flash 原先一条档位行都没有）', () => {
  if (!existsSync(RUNNER) || !existsSync(APP_CONFIG)) return; // 环境缺文件 ⇒ 跳过（不假绿）
  const proj = mkdtempSync(join(tmpdir(), 'dsp-zb31-'));
  /* 假个人配置：模型名取一个**只在这里出现**的 id（复刻 deepseek-flash 的处境）。 */
  const personal = join(proj, 'personal.json');
  writeFileSync(personal, JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [{
          providerId: 'prov-zb31',
          providerName: 'ZB31',
          config: {
            group: 'standard-personal',
            access: { type: 'api-key', apiKey: 'k' },
            api: { type: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:9' },
            personalModelIds: ['deepseek-flash'],
            modelOrder: ['deepseek-flash'],
          },
        }],
      },
    },
  }));
  const r = spawnSync(process.execPath, [RUNNER, '--list-providers', '--personal-config', personal], {
    cwd: proj, env: { ...process.env }, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(r.status, 0, `--list-providers 应成功（stderr: ${r.stderr}）`);
  const lines = r.stdout.split('\n').filter((l) => l.includes('reasoning-levels'));
  const map = {};
  for (const l of lines) {
    const m = /reasoning-levels (\S+?)=(\S+)\s*$/.exec(l);
    if (m) map[m[1]] = m[2].split(',');
  }
  assert.ok(map['deepseek-flash'], '★ 个人通道的模型必须出现在探测输出里（根因 ② 已修）');
  assert.deepEqual(map['deepseek-flash'], ['disabled', 'low', 'high', 'max'],
    'deepseek-flash = 关闭/低/高/最高（与用户所述 ZCode 内一致）');
});

/* ---------- B. 匹配式：锚定 + i（根因 ①） ---------- */
test('B. ★ 匹配式与 ZCode 逐字同式（^(?:match)$ + i）；大小写不同也命中', () => {
  const src = readFileSync(RUNNER, 'utf8');
  assert.ok(/new RegExp\(`\^\(\?:\$\{matchRe\}\)\$`, 'i'\)/.test(src),
    '★ 探测匹配式 = `^(?:${match})$` + i（与 zcode.cjs 的 vWt(...,!0) 同式）');
  assert.ok(/function zcodeModelMatch/.test(src), '有独立命名的匹配函数（便于断言与复用）');
  assert.ok(!/new RegExp\(r\.modelMatch\)\.test\(modelId\)/.test(src),
    '★ 旧的「无锚点、无 i」匹配式已彻底移除（防复发）');
  /* 现场最小复现：小写规则必须能命中大写模型 id（这正是 GLM-5.3 丢档的原因） */
  const rules = [
    { modelMatch: '.*glm-5(?:[.\\-:/\\[].*)?', values: ['disabled', 'enabled'] },
    { modelMatch: '.*glm-5\\.3(?:-flash)?(?:[.\\-:/\\[].*)?', values: ['low', 'high', 'max'] },
  ];
  const pick = (modelId) => {
    let lv = null;
    for (const r of rules) if (new RegExp(`^(?:${r.modelMatch})$`, 'i').test(modelId)) lv = r.values;
    return lv;
  };
  assert.deepEqual(pick('GLM-5.3'), ['low', 'high', 'max'], '★ GLM-5.3 命中 .3 规则（后者覆盖前者）');
  assert.deepEqual(pick('GLM-5.3-Flash'), ['low', 'high', 'max'], '★ GLM-5.3-Flash 同');
  assert.deepEqual(pick('glm-5.3'), ['low', 'high', 'max'], '小写同样命中（i 生效）');
});

/* ---------- C. core：plan 别名与 personal 通道都带 thinkingLevels ---------- */
test('C. ★ core listChannels：plan 别名与 personal 通道都带上同一份探测表的 thinkingLevels', async () => {
  const d = createDispatcher({
    runnerPath: RUNNER,
    workRoot: mkdtempSync(join(tmpdir(), 'dsp-zb31-core-')),
    channelsProbeImpl: async () => [
      'id'.padEnd(34) + 'enabled   端点/模型',
      'builtin:bigmodel-coding-plan'.padEnd(34) + 'true      https://x | GLM-5.3, GLM-5.3-Flash',
      '[zcode-run] reasoning-levels GLM-5.3=low,high,max',
      '[zcode-run] reasoning-levels GLM-5.3-Flash=low,high,max',
      '[zcode-run] reasoning-levels deepseek-flash=disabled,low,high,max',
    ].join('\n'),
    /* 个人通道读到的模型表：deepseek-flash（与探测行同名 ⇒ 必须接上） */
    personalProviderPath: (() => {
      const p = join(mkdtempSync(join(tmpdir(), 'dsp-zb31-p-')), 'personal.json');
      writeFileSync(p, JSON.stringify({
        config: {
          providerConfigRules: {
            providerRules: [{
              providerId: 'prov-x', providerName: 'X',
              config: { access: { apiKey: 'k' }, api: { baseUrl: 'http://x' }, personalModelIds: ['deepseek-flash'] },
            }],
          },
        },
      }));
      return p;
    })(),
    zcodeConfigPath: join(mkdtempSync(join(tmpdir(), 'dsp-zb31-c-')), 'none.json'),
    planCachePath: join(mkdtempSync(join(tmpdir(), 'dsp-zb31-pc-')), 'none.json'),
  });
  const r = await d.listChannels();
  const plan = r.channels.find((c) => c.id === 'plan');
  /* ZB-51：`personal` 已被 ZCode 白名单剔除（用户决定：只留 plan 与免费额度）⇒ 不再出现在清单里。
   * ⚠️ 本 fixture 没有免费额度行，故白名单后只剩 plan —— 不再断言"另一条 ZCode 通道"存在，
   * 改为断言**不变式**：清单里的 zcode 通道恒在白名单内。personalProviderPath 仍照传，
   * 用来验证"即使配置齐全，白名单也把它挡住"。 */
  assert.deepEqual(plan.thinkingLevels, ['low', 'high', 'max'], '★ plan 别名 = GLM-5.3 系三档');
  const zcIds = r.channels.filter((c) => c.engine === 'zcode').map((c) => c.id);
  assert.ok(zcIds.every((id) => ['plan', 'account:bigmodel-start-plan'].includes(id)),
    `★ ZCode 通道恒在白名单内（实际 ${JSON.stringify(zcIds)}）`);
  assert.equal(r.channels.find((c) => c.id === 'personal'), undefined,
    '★ 白名单外的 personal 即使配置齐全也被剔除（白名单优先于配置）');
  /* 探测行缺失时仍不猜（回归：不得凭空造档位） */
  const d2 = createDispatcher({
    runnerPath: RUNNER,
    workRoot: mkdtempSync(join(tmpdir(), 'dsp-zb31-none-')),
    channelsProbeImpl: async () => [
      'id'.padEnd(34) + 'enabled   端点/模型',
      'builtin:bigmodel-coding-plan'.padEnd(34) + 'true      https://x | GLM-5.3',
    ].join('\n'),
    personalProviderPath: join(mkdtempSync(join(tmpdir(), 'dsp-zb31-p2-')), 'none.json'),
    zcodeConfigPath: join(mkdtempSync(join(tmpdir(), 'dsp-zb31-c2-')), 'none.json'),
    planCachePath: join(mkdtempSync(join(tmpdir(), 'dsp-zb31-pc2-')), 'none.json'),
  });
  const r2 = await d2.listChannels();
  assert.equal(r2.channels.find((c) => c.id === 'plan').thinkingLevels, undefined,
    '无探测行 ⇒ 不写 thinkingLevels（不猜，UI 退回通用提示）');
});

/* ---------- D. 真实内置配置的现场值（用户可见的最终事实） ---------- */
test('D. ★ 真实内置配置：GLM-5.3/Flash = low,high,max；deepseek-flash = disabled,low,high,max', () => {
  if (!existsSync(BUILTIN)) return; // 环境缺文件 ⇒ 跳过（不假绿）
  const rules = JSON.parse(readFileSync(BUILTIN, 'utf8'))?.config?.modelConfigRules?.modelRules ?? [];
  assert.ok(rules.length > 0, '内置 modelRules 可读');
  const levelsFor = (modelId) => {
    let lv = null;
    for (const r of rules) {
      if (typeof r?.modelMatch !== 'string') continue;
      if (new RegExp(`^(?:${r.modelMatch})$`, 'i').test(modelId)) {
        const v = r?.config?.optionSpecs?.reasoningLevel?.values;
        if (Array.isArray(v) && v.length) lv = v.map(String);
      }
    }
    return lv;
  };
  assert.deepEqual(levelsFor('GLM-5.3'), ['low', 'high', 'max'], '★ GLM-5.3 = 低/高/最高（用户所述 ZCode 内一致）');
  assert.deepEqual(levelsFor('GLM-5.3-Flash'), ['low', 'high', 'max'], '★ GLM-5.3-Flash 同');
  assert.deepEqual(levelsFor('deepseek-flash'), ['disabled', 'low', 'high', 'max'], '★ deepseek-flash = 关闭/低/高/最高');
  /* 对照：旧的错误匹配式（无 i）在这些模型上给出错误答案 —— 证明这不是"多此一举" */
  const buggy = (modelId) => {
    let lv = null;
    for (const r of rules) {
      if (typeof r?.modelMatch !== 'string') continue;
      if (new RegExp(r.modelMatch).test(modelId)) {
        const v = r?.config?.optionSpecs?.reasoningLevel?.values;
        if (Array.isArray(v) && v.length) lv = v.map(String);
      }
    }
    return lv;
  };
  assert.deepEqual(buggy('GLM-5.3'), ['disabled', 'enabled'], '旧匹配式的错误答案（现场 bug 的最小复现）');
  assert.notDeepEqual(buggy('GLM-5.3'), levelsFor('GLM-5.3'), '★ 新旧匹配式结论确实不同 ⇒ 该修不是形式主义');
});

/* ---------- F. 失效档位必须在面板显式列出（ZB-31 修探测后的连带防护） ---------- */
test('F. ★ 面板：失效档位显式列为 option（否则 <select> 会静默显示「Agent决定」）', () => {
  const src = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
  /* 通道分区 */
  assert.ok(/const stale = cur !== 'agent' && !levels\.includes\(cur\);/.test(src),
    '★ 通道分区计算 stale（存值不在当前 levels 里）');
  assert.ok(/stale \? h\('option', \{ value: cur \}, `\$\{thinkingLabel\(cur\)\}（\$\{t\('thinkingStale'\)\}）`\) : null/.test(src),
    '★ 通道分区把失效档位显式列出并标注「已失效」');
  /* 降级目标分区（同一条纪律） */
  assert.ok(/fbThinking !== 'agent' && !fbLevels\.includes\(fbThinking\)/.test(src),
    '★ 降级目标分区同样计算失效档位');
  assert.ok(/title: stale \? t\('thinkingStaleHint'\) : t\('chanThinkingHint'\)/.test(src),
    '★ 失效时 tooltip 说明原因（派发会被 runner 拒绝）');
  const zh = JSON.parse(readFileSync(join(HERE, '..', 'locale', 'zh.json'), 'utf8')).ui;
  const en = JSON.parse(readFileSync(join(HERE, '..', 'locale', 'en.json'), 'utf8')).ui;
  for (const k of ['thinkingStale', 'thinkingStaleHint']) {
    assert.ok(zh[k] && en[k], `locale 中英都有 ${k}`);
    assert.ok(new RegExp(`${k}:`).test(src), `client STRINGS 含 ${k}`);
  }
  /* 为什么需要：<select> 的 value 找不到匹配 option 时，浏览器显示首项（Agent决定）
   * 而真实存值是失效档位 —— 显示与事实不符。这条断言锁住"必须显式列出"。
   * ZB-74：首项文案改为双语 `tBi('thinkingAgent')`（断言语义不变，只更新锚点）。 */
  assert.ok(/h\('option', \{ value: 'agent' \}, tBi\('thinkingAgent'\)\),/.test(src),
    '首项仍是 Agent决定（双语；失效项必须排在它之后，否则默认选中会错位）');
});
/* ---------- E. runner 拒绝非法档位时列出的是**修正后**的取值 ---------- */
test('E. 非法档位 fail-fast 报错列出修正后的可用档位（low|high|max）', () => {
  if (!existsSync(RUNNER) || !existsSync(APP_CONFIG)) return;
  const proj = mkdtempSync(join(tmpdir(), 'dsp-zb31-neg-'));
  const r = spawnSync(process.execPath, [
    RUNNER, '--project', proj, '--prompt', 'x', '--provider', 'plan',
    '--model', 'GLM-5.3', '--reasoning-level', 'medium', '--no-ledger',
  ], { cwd: proj, env: { ...process.env }, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1, 'medium 不在 GLM-5.3 声明里 ⇒ fail-fast');
  assert.match(r.stderr, /low\|high\|max/, '★ 报错列出 low|high|max（旧实现会列 disabled|enabled）');
  assert.doesNotMatch(r.stderr, /disabled\|enabled/, '不再是旧的错误取值集');
});