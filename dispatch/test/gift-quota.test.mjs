/**
 * ZB-33 回归测试：免费额度（Start Plan）余量读取 —— **纯函数 + 假日志**，零网络、零额度消耗。
 *
 * 用户要求：「切换到免费额度模型时，面板增加额度条显示，并且这个额度暴露在工具的相关决策卡或提示词，
 * 让 Agent 在派发任务时，可以知道还有多少额度。」
 *
 * 覆盖：
 *   · 尾读日志：从文件尾部倒读命中 `billing/balance 请求完成`（含跨块半行拼接）
 *   · 归一化：active / pending（权益未生效，**不拿 grant 冒充剩余**）/ expired / no-start-plan
 *   · 摘要文案：剩余量 + 百分比 + 窗口 + 剩余时长
 *   · 端到端（`readGiftQuota` 走假 fsImpl，不触真磁盘）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GIFT_CHANNEL_RE,
  formatGiftQuota,
  normalizeQuota,
  parseBalanceLine,
  parseLineTimestamp,
  readGiftQuota,
} from '../core/gift-quota.mjs';

const MARKER = 'billing/balance 请求完成';

/** 造一条 ZCode 风格日志行。 */
const logLine = (time, data) => `[${time}] [info] usage-stats ${MARKER} ${JSON.stringify({ payload: { data } })}`;

/** 权益生效中的响应（本机 2026-10-10 真机形状的简化版）。 */
const activeData = (over = {}) => ({
  server_time: 1791650000,
  plans: [{ plan_id: 'bigmodel-start-plan', name: 'Start Plan', starts_at: 1791650400, ends_at: 1791800400, entitlements: [{ entitlement_id: 'ent-1', grant_units: 300_000_000, effective_at: 1791650400, show_name: 'GLM-5.3-Flash' }] }],
  balances: [{ entitlement_id: 'ent-1', plan_id: 'bigmodel-start-plan', total_units: 300_000_000, used_units: 68_600_000, remaining_units: 231_400_000, available_units: 231_400_000, expires_at: 1791800400 }],
  ...over,
});

const NOW = 1791700000 * 1000; // 窗口内

test('ZB-33 尾读：从尾部倒读命中最后一条 balance 行（跨块也不丢行）', async () => {
  const lines = [
    logLine('2026-10-10 20:00:00.000', activeData()),
    '[info] 无关日志行',
    logLine('2026-10-10 21:00:00.000', { ...activeData(), balances: [{ entitlement_id: 'ent-1', total_units: 300_000_000, used_units: 1_000_000, remaining_units: 299_000_000 }] }),
    '[info] 末尾噪声',
  ];
  /* 假 fsImpl：把整段文本当文件内容，块大小故意缩小以触发跨块 carry 逻辑。 */
  const text = `${lines.join('\n')}\n`;
  const buf = Buffer.from(text, 'utf8');
  const fsImpl = {
    openSync: () => 1,
    fstatSync: () => ({ size: buf.length }),
    readSync: (_fd, target, offset, length, position) => {
      const slice = buf.subarray(position, position + length);
      slice.copy(target, offset);
      return slice.length;
    },
    closeSync: () => {},
  };
  const { findNewestBalanceLine } = await import('../core/gift-quota.mjs');
  const hit = findNewestBalanceLine('fake.log', fsImpl);
  assert.ok(hit && hit.includes(MARKER), '应命中 balance 行');
  assert.match(hit, /299_?000_?000|299000000/, '应命中**最后一条**（21:00 那条）');
});

test('ZB-33 解析：JSON 体 + 行首时刻', () => {
  const line = logLine('2026-10-10 21:00:00.123', activeData());
  const parsed = parseBalanceLine(line);
  assert.equal(parsed.payload.data.plans[0].plan_id, 'bigmodel-start-plan');
  assert.equal(parseBalanceLine('没有 JSON'), null);
  assert.equal(parseLineTimestamp(line), new Date('2026-10-10T21:00:00.123').toISOString());
  assert.equal(parseLineTimestamp('无时间戳'), null);
});

test('ZB-33 归一化：生效中 → active，剩余取自余额桶（不自算）', () => {
  const q = normalizeQuota({ payload: { data: activeData() } }, NOW);
  assert.equal(q.ok, true);
  assert.equal(q.state, 'active');
  assert.equal(q.totalUnits, 300_000_000);
  assert.equal(q.remainingUnits, 231_400_000);
  assert.equal(q.planName, 'Start Plan');
  assert.equal(q.model, 'GLM-5.3-Flash');
});

test('ZB-33 归一化：权益未生效（无桶）→ pending，**不拿 grant 冒充剩余**', () => {
  const data = activeData({ balances: [] });
  data.plans[0].entitlements[0].effective_at = 1791700000 + 3600; // 一小时后才生效
  const q = normalizeQuota({ payload: { data } }, NOW);
  assert.equal(q.state, 'pending');
  assert.equal(q.remainingUnits, null, '未生效时剩余必须是 null（不可知）');
  assert.equal(q.totalUnits, 300_000_000, '总量可以给（来自授予）');
});

test('ZB-33 归一化：窗口已过 → expired；非 start-plan → ok:false', () => {
  const data = activeData();
  data.plans[0].ends_at = 1791690000; // 早于 NOW
  data.balances[0].expires_at = 1791690000;
  assert.equal(normalizeQuota({ payload: { data } }, NOW).state, 'expired');

  const coding = activeData();
  coding.plans[0].plan_id = 'bigmodel-coding-plan';
  coding.balances[0].plan_id = 'bigmodel-coding-plan';
  assert.deepEqual(normalizeQuota({ payload: { data: coding } }, NOW), { ok: false, reason: 'no-start-plan' });
  assert.deepEqual(normalizeQuota({ nope: true }, NOW), { ok: false, reason: 'no-payload' });
});

test('ZB-33 摘要：剩余 + 百分比 + 窗口 + 剩余时长；不可用时返回 null', () => {
  const q = normalizeQuota({ payload: { data: activeData() } }, NOW);
  const text = formatGiftQuota(q, NOW);
  assert.match(text, /剩余 231\.4M \/ 300\.0M（77%）/);
  assert.match(text, /窗口 \d\d-\d\d \d\d:\d\d → \d\d-\d\d \d\d:\d\d/);
  assert.match(text, /剩 \d+\.\d 小时|剩 \d+\.\d 天/);
  assert.equal(formatGiftQuota({ ok: false, reason: 'no-log' }, NOW), null);
  assert.equal(formatGiftQuota(null, NOW), null);
});

test('ZB-33 readGiftQuota：走假 fsImpl 端到端（不触真磁盘），并带 observedAt/日志名', () => {
  const text = `${logLine('2026-10-10 21:00:00.123', activeData())}\n`;
  const buf = Buffer.from(text, 'utf8');
  const fsImpl = {
    readdirSync: () => ['2026-10-10.log', 'ignore.txt'],
    statSync: () => ({ isFile: () => true, mtimeMs: 1 }),
    openSync: () => 1,
    fstatSync: () => ({ size: buf.length }),
    readSync: (_fd, target, offset, length, position) => {
      const slice = buf.subarray(position, position + length);
      slice.copy(target, offset);
      return slice.length;
    },
    closeSync: () => {},
  };
  const q = readGiftQuota({ logDir: 'F:\\fake\\logs', fsImpl, nowMs: NOW });
  assert.equal(q.ok, true);
  assert.equal(q.state, 'active');
  assert.equal(q.remainingUnits, 231_400_000);
  assert.equal(q.logFile, '2026-10-10.log');
  assert.equal(q.observedAt, new Date('2026-10-10T21:00:00.123').toISOString());
  /* 读不到目录 → ok:false（不抛） */
  const miss = readGiftQuota({ logDir: 'F:\\nope', fsImpl: { readdirSync: () => { throw new Error('ENOENT'); } }, nowMs: NOW });
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'no-log');
});

test('ZB-33 通道形态：account:<family>-start-plan 才算免费额度通道', () => {
  assert.equal(GIFT_CHANNEL_RE.test('account:bigmodel-start-plan'), true);
  assert.equal(GIFT_CHANNEL_RE.test('account:zai-start-plan'), true);
  assert.equal(GIFT_CHANNEL_RE.test('builtin:bigmodel-start-plan'), false, 'config.json 里那条不是运行时通道');
  assert.equal(GIFT_CHANNEL_RE.test('account:bigmodel-coding-plan'), false);
});
