/**
 * ZB-37 回归测试：真机事故（2026-10-11 keysion 会话）的两个根因不得复发。
 *
 * 事故经过：agent 按教学读 channels → 想设免费额度通道为默认 →
 * `invalid arguments: "provider" must be one of ["plan","personal"]` ⇒ 只能选付费 `plan`
 * ⇒ 三个作业全 429（Coding Plan 5h 窗口满）⇒ 它改用后台 pwsh 直跑 runner 绕过派发台。
 *
 * 断言：
 *   ① 工具 schema 里 `provider` / `model` **不得再有 enum**（合法取值随账号/清单变，权威是 channels）；
 *   ② 工具描述必须写明「撞额度后换通道/开降级链」「不要用 pwsh 直跑 runner」；
 *   ③ `recentQuotaExhausted` 能从台账里认出刚撞 429 的通道，并按 provider 归一命中通道 id/别名；
 *   ④ `attachGiftQuota(channels, ledgerPath)` 把标记挂到对应通道上（面板与工具同源）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachGiftQuota, dispatchQuotaHint, matchQuotaExhausted, recentQuotaExhausted } from '../wire.host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(join(HERE, '..', 'index.js'), 'utf8');

test('ZB-37 ①：provider/model 不得用 enum 限制（否则免费额度通道没法作为派发目标）', () => {
  const providerLine = /provider: \{ type: 'string'[^}]*\}/.exec(INDEX_SRC)?.[0] ?? '';
  const modelLine = /model: \{ type: 'string'[^}]*\}/.exec(INDEX_SRC)?.[0] ?? '';
  assert.ok(providerLine.includes('type'), ' 能取到 provider 字段定义');
  assert.ok(!/enum:/.test(providerLine), `provider 不应有 enum（实际：${providerLine.slice(0, 120)}）`);
  assert.ok(!/enum:/.test(modelLine), `model 不应有 enum（实际：${modelLine.slice(0, 120)}）`);
  /* 事故原文里的那句报错值不得再出现在 schema 里 */
  assert.ok(!/must be one of/.test(INDEX_SRC) || !/provider.*enum: \['plan', 'personal'\]/.test(INDEX_SRC));
});

test('ZB-37 ②：工具描述必须写明「撞额度怎么办」与「不要直跑 runner」', () => {
  assert.ok(/不要用 `pwsh` \/ `Bash` 直接跑/.test(INDEX_SRC), '描述含「不要 pwsh 直跑 runner」');
  assert.ok(/额度撞顶/.test(INDEX_SRC) && /action=fallback/.test(INDEX_SRC) && /action=retry/.test(INDEX_SRC),
    '描述含撞额度后的处置（换通道 / 降级链 + retry）');
  assert.ok(/action=channels[^]{0,120}quotaText/.test(INDEX_SRC), '描述指向 channels 的额度信息');
});

test('ZB-37 ③：recentQuotaExhausted 从台账认出 429 通道，并按 provider 归一匹配', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zb37-'));
  const ledger = join(dir, 'zcode-runs.jsonl');
  const now = Date.now();
  const row = (o) => JSON.stringify(o);
  writeFileSync(ledger, [
    row({ at: new Date(now - 3600e3).toISOString(), provider: 'plan:bigmodel-coding-plan', rateLimited: true, retryAfterSec: 900 }),
    row({ at: new Date(now - 60e3).toISOString(), provider: 'account:bigmodel-start-plan', rateLimited: null }),
    /* 超窗（6 小时前）→ 不算 */
    row({ at: new Date(now - 6 * 3600e3).toISOString(), provider: 'builtin:zai-coding-plan', rateLimited: true }),
  ].join('\n'));
  const ex = recentQuotaExhausted(ledger, now);
  assert.deepEqual(Object.keys(ex), ['bigmodel-coding-plan'], `只应留下未超窗的那条（实际 ${JSON.stringify(Object.keys(ex))}）`);
  assert.equal(ex['bigmodel-coding-plan'].retryAfterSec, 900);

  /* 通道 id/别名归一：`plan`（别名）/`builtin:bigmodel-coding-plan` 都应命中 */
  assert.ok(matchQuotaExhausted({ id: 'plan', aliasOf: 'builtin:bigmodel-coding-plan' }, ex), 'plan 别名命中');
  assert.ok(matchQuotaExhausted({ id: 'builtin:bigmodel-coding-plan' }, ex), '真实 id 命中');
  assert.equal(matchQuotaExhausted({ id: 'account:bigmodel-start-plan' }, ex), null, '免费额度通道不该被误标');
  assert.deepEqual(recentQuotaExhausted(join(dir, 'nope.jsonl'), now), {}, '台账不存在 → 空对象（不抛）');
  rmSync(dir, { recursive: true, force: true });
});

test('ZB-38 ⑤：派发到"刚撞过额度"的通道时给出 warning + suggestedProvider（不阻塞派发）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zb38-'));
  const ledger = join(dir, 'zcode-runs.jsonl');
  writeFileSync(ledger, JSON.stringify({ at: new Date().toISOString(), provider: 'plan:bigmodel-coding-plan', rateLimited: true }) + '\n');
  const CH = [
    { id: 'plan', name: '默认套餐', enabled: true, aliasOf: 'builtin:bigmodel-coding-plan' },
    { id: 'account:bigmodel-start-plan', name: '免费额度（Start Plan）', enabled: true },
  ];
  const dispatcher = { listChannels: async () => ({ channels: CH }), getChannel: async () => ({ provider: 'plan' }) };

  /* 显式派到撞顶通道 → 有提示，且建议通道 = 免费额度 */
  const hit = await dispatchQuotaHint(dispatcher, { kind: 'prompt', provider: 'plan' }, { ledgerPath: ledger });
  assert.match(hit.warning, /最近撞过额度/);
  assert.match(hit.warning, /quota-exhausted/);
  assert.equal(hit.suggestedProvider, 'account:bigmodel-start-plan');

  /* 不传 provider → 用默认通道（同样命中） */
  const byDefault = await dispatchQuotaHint(dispatcher, { kind: 'prompt' }, { ledgerPath: ledger });
  assert.equal(byDefault?.suggestedProvider, 'account:bigmodel-start-plan', '默认通道为撞顶通道时也要提示');

  /* 派到免费额度通道 → 无提示；台账不存在 → 无提示 */
  assert.equal(await dispatchQuotaHint(dispatcher, { kind: 'prompt', provider: 'account:bigmodel-start-plan' }, { ledgerPath: ledger }), null);
  assert.equal(await dispatchQuotaHint(dispatcher, { kind: 'prompt', provider: 'plan' }, { ledgerPath: join(dir, 'nope.jsonl') }), null);
  rmSync(dir, { recursive: true, force: true });
});

test('ZB-37 ④：attachGiftQuota(…, ledgerPath) 把额度提示挂到通道上（面板与工具同源）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zb37b-'));
  const ledger = join(dir, 'zcode-runs.jsonl');
  writeFileSync(ledger, JSON.stringify({ at: new Date().toISOString(), provider: 'plan:bigmodel-coding-plan', rateLimited: true }) + '\n');
  const channels = [
    { id: 'plan', name: '默认套餐', enabled: true, aliasOf: 'builtin:bigmodel-coding-plan' },
    { id: 'account:bigmodel-start-plan', name: '免费额度（Start Plan）', enabled: true },
  ];
  const out = attachGiftQuota(channels, ledger);
  const plan = out.channels.find((c) => c.id === 'plan');
  const gift = out.channels.find((c) => c.id === 'account:bigmodel-start-plan');
  assert.ok(plan.recentQuotaExhausted, 'plan 通道被标「最近撞过额度」');
  assert.match(plan.quotaNote, /改用其它通道/);
  assert.equal(gift.recentQuotaExhausted, undefined, '免费额度通道不被误标');
  assert.ok(out.recentQuotaExhausted && Object.keys(out.recentQuotaExhausted).length === 1, '顶层也给出标记表');
  rmSync(dir, { recursive: true, force: true });
});
