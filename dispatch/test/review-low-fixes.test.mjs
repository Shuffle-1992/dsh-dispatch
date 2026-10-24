/**
 * ZB-117 回归：审查 LOW 项修复
 *
 * 来源：GLM-5.3 / GLM-5.3-Flash 两份审查报告的 LOW 项（已核实为真）。
 *
 * 修掉的：
 *   ① 额度暂停正则含裸 `/\b429\b/` 与 `/balance/i` —— 任务输出里任何 "429"（行号）或
 *      "balance"（变量名）都会被判额度耗尽（与 ZB-112「超时误报额度」同类）；
 *   ② `wire.host` 的 wait 定时器落地后不清（只 unref），每次 wait 遗留最长 timeoutMin 秒的待期定时器；
 *   ③ `feed()` 只监听 end/error 不监听 close —— 流被 destroy 时 flush 不执行 ⇒ 捕获文件 fd 泄漏；
 *   ④ `zcode-run` 的 spawnSync 输出超 maxBuffer（ENOBUFS）时静默走解析失败，无任何提示；
 *   ⑤ `matchQuotaExhausted` 的**任意子串**匹配（`id.includes(key)`）会误标前缀相近的通道；
 *   ⑥ `qoderLevelsCache` 声明在模块级 ⇒ 多 dispatcher 实例（测试）共享、串味。
 *
 * 不改的（记录理由）：
 *   · `Date.now()` 在模块级工具函数里（拿不到 dispatcher 的 `nowMs`）—— 合理用法；
 *   · agent 工具描述里的 emoji —— agent-facing 文案，可读性优先；
 *   · client.js 的 rgba 投影阴影 —— 已声明例外（带主题令牌回退）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = readFileSync(join(HERE, '..', 'core', 'dispatch-core.mjs'), 'utf8');
const WIRE = readFileSync(join(HERE, '..', 'wire.host.mjs'), 'utf8');
const ZRUN = readFileSync(join(HERE, '..', '..', 'collab-kit', 'zcode-run.mjs'), 'utf8');

/* ── ① 额度正则收紧 ── */
test('ZB-117 ①：额度暂停正则不再用裸 429 / balance 宽词', () => {
  /* 注释里会引用"原先的 /\\b429\\b/"作说明，判定前先剥掉注释（块注释 + 行注释）。 */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
  const sig = CORE.match(/reason: 'quota-exhausted', patterns: \[([\s\S]*?)\r?\n  \] \},/);
  assert.ok(sig, '能取出 quota-exhausted 规则');
  const body = stripComments(sig[1]);
  /* 反向：不能有裸的 /\b429\b/ 或 /balance/i */
  assert.ok(!body.includes('/\\b429\\b/'), '★ 不能有裸 /\\b429\\b/');
  assert.ok(!body.includes('/balance/i'), '★ 不能有裸 /balance/i');
  /* 正向：必须保留上下文形式 */
  assert.ok(body.includes('HTTP'), '保留 HTTP 429 形态');
  assert.ok(body.includes('insufficient'), '保留 insufficient balance 形态');
});

/* ── ② wait 定时器落地后清理 ── */
test('ZB-117 ②：wait 落地后清掉等待定时器（不再遗留待期定时器）', () => {
  assert.ok(WIRE.includes('let waitTimer = null;'), '有 waitTimer 句柄');
  const finish = WIRE.match(/const finish = \(j, timedOut\) => \{([\s\S]{0,500}?)\};/);
  assert.ok(finish, '能取出 finish');
  assert.ok(finish[1].includes('clearTimeout(waitTimer)'), '★ finish 里清定时器');
  assert.ok(WIRE.includes('waitTimer = setTimeout('), '定时器句柄被保存');
});

/* ── ③ feed 监听 close ── */
test('ZB-117 ③：feed 同时监听 close（destroy 时也能 flush，防 fd 泄漏）', () => {
  assert.ok(CORE.includes("stream.on('close', flush)"), '★ 监听 close');
  assert.ok(CORE.includes("stream.on('end', flush)"), '仍监听 end');
  assert.ok(CORE.includes("stream.on('error', flush)"), '仍监听 error');
});

/* ── ④ ENOBUFS 识别 ── */
test('ZB-117 ④：spawnSync 输出超 maxBuffer 时显式报错（不是静默解析失败）', () => {
  assert.ok(ZRUN.includes('ENOBUFS'), '★ 识别 ENOBUFS');
  assert.ok(ZRUN.includes('outputOverflow'), '有 overflow 标记');
  assert.ok(ZRUN.includes('超过 maxBuffer'), '有可读提示');
});

/* ── ⑤ matchQuotaExhausted 去掉任意子串 ── */
test('ZB-117 ⑤：matchQuotaExhausted 不再用任意子串匹配（保留 plan 别名与段前缀/后缀语义）', () => {
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
  const fn = WIRE.match(/export function matchQuotaExhausted\(channel, exhausted\) \{([\s\S]*?)\r?\n\}/);
  assert.ok(fn, '能取出 matchQuotaExhausted');
  const body = stripComments(fn[1]);
  assert.ok(!body.includes('id.includes(key)'), '★ 去掉任意子串 id.includes(key)');
  assert.ok(!body.includes('key.includes(bare)'), '★ 去掉任意子串 key.includes(bare)');
  assert.ok(body.includes('id === key || bare === key'), '精确匹配保留');
  assert.ok(body.includes("id === 'plan' && /[-:]plan$/.test(key)"), 'plan 别名语义保留');
  assert.ok(body.includes('id.startsWith(`${key}:`)'), '段前缀保留');
  assert.ok(body.includes('id.endsWith(`:${key}`)'), '段后缀保留（台账 key 是归一短名）');
});

/* ── ⑥ qoderLevelsCache 实例级 ── */
test('ZB-117 ⑥：qoderLevelsCache 在 createDispatcher 闭包内（不在模块级）', () => {
  /* 模块级不能有 `let qoderLevelsCache` 声明（在 createDispatcher 之前的位置） */
  const before = CORE.slice(0, CORE.indexOf('export function createDispatcher'));
  assert.doesNotMatch(before, /^let qoderLevelsCache = null;/m, '★ 模块级不应再声明');
  const inside = CORE.slice(CORE.indexOf('export function createDispatcher'));
  assert.match(inside, /let qoderLevelsCache = null;/, '★ 在闭包内声明（实例级）');
});
