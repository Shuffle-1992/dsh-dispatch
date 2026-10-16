/**
 * 测试用假 runner（零依赖）。由 core.test.mjs 通过 env DSP_FAKE_RUNNER 注入，
 * 打印与真实 zcode-run.mjs 相同格式的 [zcode-run] 汇总行。
 *
 * 环境变量开关：
 *   FAKE_SLEEP_MS   模拟执行耗时（默认 300）
 *   FAKE_EXIT_CODE  进程退出码（默认 0）
 *   FAKE_PAUSE_TEXT 非零退出前向 stderr 打印的一行原文（Z6：造暂停签名用，配合 FAKE_EXIT_CODE=1）
 *   FAKE_SKIP       逗号分隔，跳过某些汇总行：done,usage,context,out,err,result,endpoint
 *   FAKE_TAG        启动行的 tag（默认 fake）
 *   FAKE_MODEL      done 行的 model（默认 GLM-5.3-Flash）
 *   FAKE_SESSION    done 行的 session（默认随机；台账匹配测试需要固定值）
 *   FAKE_ARGV_FILE  把本次 argv 以 JSON 落盘到该路径（ZB-20：验证提示词注入，默认不落盘）
 *   FAKE_TIMEOUT_DONE  置 1 = done 行带 `(超时)` 标记且 exit=124（ZB-28：runner 自身超时形态）
 *   FAKE_MEMORY_BAN_LINE 置 1 = 打印 `memory-ban=on`（ZB-28：runner 确认记忆禁令注入）
 * out/err/result 路径故意带空格，用于验证含空格路径的解析。
 */
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const env = process.env;
/* ZB-20：把真实收到的 argv 落盘，供测试断言「提示词注入」是否生效。
 * 默认不落盘（不影响既有测试）；文件名带 pid 以防并发覆盖。 */
if (env.FAKE_ARGV_FILE) {
  try {
    writeFileSync(`${env.FAKE_ARGV_FILE}.${process.pid}.json`, JSON.stringify(process.argv.slice(2)));
  } catch { /* 落盘失败不影响被测行为 */ }
}
const sleepMs = Number(env.FAKE_SLEEP_MS ?? 300);
const exitCode = Number(env.FAKE_EXIT_CODE ?? 0);
const skip = new Set((env.FAKE_SKIP ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const sess = env.FAKE_SESSION ?? `sess_fake-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

console.log(`[zcode-run] tag=${env.FAKE_TAG ?? 'fake'} mode=edit cwd=${process.cwd()}`);
console.log('[zcode-run] provider=plan:bigmodel-coding-plan model=GLM-5.3-Flash (Fake Provider（ZCode 套餐）)');

if (sleepMs > 0) await delay(sleepMs);

if (env.FAKE_PAUSE_TEXT) {
  if (env.FAKE_DONE_BEFORE_PAUSE) {
    // Z6：先打印带 session 的汇总行再失败（同通道 --resume 续跑测试必需，否则 job 无 sessionId）
    console.log(
      `[zcode-run] done exit=${exitCode} elapsed=${(sleepMs / 1000).toFixed(1)}s session=${sess}` +
        ' provider=plan:bigmodel-coding-plan model=GLM-5.3-Flash responseChars=2',
    );
  }
  console.error(String(env.FAKE_PAUSE_TEXT)); // Z6：暂停签名走 stderr（与真实 CLI 错误一致）
  process.exit(Number(env.FAKE_EXIT_CODE ?? 1));
}

if (env.FAKE_MEMORY_BAN_LINE) console.log('[zcode-run] memory-ban=on（已在提示词末尾注入记忆禁令）');
/* ZB-29：回显收到的 --reasoning-level（模拟真实 runner 的注入确认行，供 core 解析成 job.reasoningLevelApplied）。 */
const rlIdx = process.argv.indexOf('--reasoning-level');
if (rlIdx >= 0 && process.argv[rlIdx + 1]) {
  console.log(`[zcode-run] reasoning-level=${process.argv[rlIdx + 1]} target=fake-plan/fake-model`);
}

if (!skip.has('done')) {
  /* ZB-28：FAKE_TIMEOUT_DONE=1 时模仿真实 runner 的自身超时形态（exit=124 + `(超时)` 标记）。 */
  const doneExit = env.FAKE_TIMEOUT_DONE ? 124 : exitCode;
  const doneMark = env.FAKE_TIMEOUT_DONE ? ' (超时)' : '';
  console.log(
    `[zcode-run] done exit=${doneExit}${doneMark} elapsed=${(sleepMs / 1000).toFixed(1)}s session=${sess}` +
      ' provider=plan:bigmodel-coding-plan model=GLM-5.3-Flash responseChars=2',
  );
}
if (!skip.has('endpoint')) console.log('[zcode-run] endpoint=https://fake.example/api');
if (!skip.has('usage')) console.log('[zcode-run] usage requests=1 in=100 out=50 cacheRead=10');
if (!skip.has('context')) console.log('[zcode-run] context used=1234 (0.6% of 200000) turnCount=2');
if (!skip.has('out')) console.log('[zcode-run] out=C:\\fake dir with space\\run.out.log');
if (!skip.has('err')) console.log('[zcode-run] err=C:\\fake dir with space\\run.err.log');
if (!skip.has('result')) console.log('[zcode-run] result=C:\\fake dir with space\\run.result.json');
process.exit(env.FAKE_TIMEOUT_DONE ? 124 : exitCode);
