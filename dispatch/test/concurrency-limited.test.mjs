#!/usr/bin/env node
/**
 * concurrency-limited.test.mjs —— ZB-107 真机回归：**并发已满 ≠ 额度耗尽**
 *
 * 真机现场（2026-10-24，用户纠正）：
 *   「刚才其他 Agent 派发了 4 个，可以走 3 个到上限」+「走免费额度的时候，是没有 5 小时限制的，只有额度」
 *
 * 实测（免费额度 channel，runner 直连，批间隔 ≥20s 排除残留）：
 *   并发 3 ⇒ 3/3 成功；并发 4 ⇒ 3/4（1 个失败）
 *   失败原文：`[gift] 上游业务错误 providerCode=3008 message="user concurrency limit exceeded"`
 *   ⇒ **账号级并发上限 = 3**；超了等前一个结束就能跑，**不是额度没了**。
 *
 * 本文件钉四件事：
 *   A. `classifyPause` 认得并发限制（且**不会**被 quota-exhausted 抢走）；
 *   B. 顺带修掉的漏网：`1005 exceed quota limit` / gift 自打的 `pause-signature quota-exhausted`
 *      以前都归 unknown（真机实测），现在能正确归为额度暂停；
 *   C. gift 层输出独立签名 `concurrency-limited`；
 *   D. 面板文案区分「5 小时窗口已满」（付费套餐）与「免费额度已用尽」（活动额度，**无 5h 窗口**）。
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPause } from '../core/dispatch-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = {
  core: readFileSync(join(HERE, '..', 'core', 'dispatch-core.mjs'), 'utf8'),
  client: readFileSync(join(HERE, '..', 'client.js'), 'utf8'),
  giftJob: readFileSync(join(HERE, '..', '..', 'collab-kit', 'appserver-gift-job.mjs'), 'utf8'),
  zh: readFileSync(join(HERE, '..', 'locale', 'zh.json'), 'utf8'),
  en: readFileSync(join(HERE, '..', 'locale', 'en.json'), 'utf8'),
};

const reason = (text) => classifyPause([text])?.reason ?? null;

/* ── A. 并发限制单独成一类 ── */
assert.equal(reason('[gift] pause-signature concurrency-limited：user concurrency limit exceeded'), 'concurrency-limited',
  '★ 并发限制归 concurrency-limited');
assert.equal(reason('[gift] 上游业务错误 providerCode=3008 message=user concurrency limit exceeded'), 'concurrency-limited',
  '★ 即使不提 pause-signature，光凭上游 message 也能认出');
assert.equal(reason('too many concurrent requests'), 'concurrency-limited', '同义表达也认得');

/* 关键：并发限制**不能**被 quota-exhausted 抢走（两条规则都在，顺序决定结果） */
const sigs = SRC.core.match(/const PAUSE_SIGNATURES = \[([\s\S]*?)\n\];/);
assert.ok(sigs, '能取出 PAUSE_SIGNATURES');
const idxConcurrency = sigs[1].indexOf("reason: 'concurrency-limited'");
const idxQuota = sigs[1].indexOf("reason: 'quota-exhausted'");
assert.ok(idxConcurrency >= 0 && idxQuota > idxConcurrency,
  '★ concurrency-limited 必须排在 quota-exhausted **之前**（先匹配先生效）');

/* ── B. 顺带修掉的漏网模式 ── */
assert.equal(reason('[gift] pause-signature quota-exhausted：1005 exceed quota limit'), 'quota-exhausted',
  '★ `exceed quota limit`（空格式）现在认得（旧模式只有下划线，真机归 unknown）');
assert.equal(reason('HTTP 429 code=1309 Coding Plan 5 小时滚动窗口已满'), 'quota-exhausted', '5h 窗口满仍归额度暂停');
assert.equal(reason('Authentication required. Please use /login'), 'not-logged-in', '未登录分类不受影响');

/* ── C. gift 层输出独立签名 ── */
assert.match(SRC.giftJob, /pause-signature concurrency-limited/, '★ gift 层对并发限制打独立签名');
assert.match(SRC.giftJob, /concurrency limit\|too many concurrent/, '并发判定正则覆盖上游原文');

/* ── D. 文案：免费额度 ≠ 5 小时窗口 ── */
assert.match(SRC.zh, /"pConcurrency": "并发已满"/, '中文暂停标签有「并发已满」');
assert.match(SRC.en, /"pConcurrency": "Concurrency limit reached"/, '英文暂停标签同步');
assert.match(SRC.zh, /"chanFreeQuotaExhausted": "免费额度已用尽"/, '免费额度通道用「已用尽」而不是「5 小时窗口」');
assert.match(SRC.client, /chanFreeQuotaExhausted/, '★ 客户端按通道类型选文案');
assert.match(SRC.client, /\^account:\[a-z\]\+-start-plan\$\/\.test/, '判据 = start-plan 通道形态');

/* ── E. 并发满 ⇒ **自动排队等待**（用户要求：「并发满，应该排队，等待」）── */
assert.match(SRC.core, /CONCURRENCY_RETRY_DELAY_MS = \d[\d_]*/, '★ 有自动重试间隔常量');
assert.match(SRC.core, /CONCURRENCY_MAX_RETRIES = \d+/, '★ 有自动重试次数上限（不能无限重试）');
assert.match(SRC.core, /concurrencyRetryTimers/, '有 timer 表（便于跟踪/清理）');
const fin = SRC.core.match(/function finalizeJob\(job,[\s\S]*?\n  \}/);
assert.ok(fin, '能取出 finalizeJob');
assert.match(fin[0], /pause\.reason === 'concurrency-limited'/, '★ finalizeJob 对并发暂停做特殊处理');
assert.match(fin[0], /已自动排队：第 \$\{tries\}\/\$\{CONCURRENCY_MAX_RETRIES\} 次/, '★ detail 里说明"已自动排队 + 第几次"');
/* timer 回调必须自检状态：被 kill / 手动 retry 后不能再把 job 拉起来 */
assert.match(fin[0], /cur\.state !== 'paused' \|\| cur\.pauseReason !== 'concurrency-limited'\) return/,
  '★ 重试前自检状态（kill/手动 retry 后作废，避免重复拉起）');
assert.match(fin[0], /已自动重试 \$\{CONCURRENCY_MAX_RETRIES\} 次仍无并发槽位/, '★ 超上限才真停下并说明原因');

console.log('===== ZB-107 并发已满 ≠ 额度耗尽：全部通过 =====');
