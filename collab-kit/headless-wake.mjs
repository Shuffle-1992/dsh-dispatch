/**
 * 无头拉起（T6 通道）：供 Windows 计划任务周期调用；也可手动执行。
 *
 * 流程：inbox-trae 有待办 → 抢锁（collab/logs/.headless-lock）→ relay-once 备机械证据 →
 *      traecli -p 执行无头复审（写 review/passed + 同步 state.json + 归档 outbox）→ 清锁。
 *
 * 协调：锁存在且未过期时，Trae IDE 侧 Stop 钩子（trae-stop-check.mjs）会跳过自动续跑，避免双重复审。
 * 安全：任何异常一律 exit 0（不阻塞）；traecli 未登录/不可用时记日志、保持待办原样（人工/Ding 侧仍可拉起）。
 * 用法：node "<dispatch>/collab-kit/headless-wake.mjs" --project <项目根> [--skip-relay] [--force]
 *   --skip-relay  跳过机械证据复跑（测试用）
 *   --force       忽略“无待办”判定强制跑一轮（测试用）
 * 详见 collab/headless-cli-setup.md。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 项目根（含 collab/ 的目录）：--project > env ZCODE_PROJECT_DIR > cwd。
 * 本工具已迁至 dispatch/collab-kit，不再与宿主项目有目录关系。 */
function resolveProjectRoot() {
  const i = process.argv.indexOf('--project');
  if (i >= 0 && process.argv[i + 1]) return resolve(process.argv[i + 1]);
  const env = process.env.ZCODE_PROJECT_DIR;
  if (typeof env === 'string' && env.trim() !== '') return resolve(env.trim());
  return resolve(process.cwd());
}
const PROJECT = resolveProjectRoot();
/** 本工具集所在目录（用于拼同目录工具的绝对路径；工具已迁出宿主项目，不能再写相对路径）。 */
const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const COLLAB = join(PROJECT, 'collab');
const LOGS = join(COLLAB, 'logs');
const LOCK = join(LOGS, '.headless-lock');
const WAKE_LOG = join(LOGS, 'headless-wake.log');
const LOCK_STALE_MS = 45 * 60 * 1000;
const TRAECLI = process.env.TRAECLI_BIN || join(process.env.LOCALAPPDATA ?? 'C:/Users/Administrator/AppData/Local', 'trae-cli', 'bin', 'traecli.exe');
const skipRelay = process.argv.includes('--skip-relay');
const force = process.argv.includes('--force');

const log = (s) => {
  const line = `[${new Date().toISOString()}] ${s}`;
  console.log(line);
  try {
    appendFileSync(WAKE_LOG, line + '\n');
  } catch {
    /* 日志失败不阻塞 */
  }
};
const isMsg = (f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('README');
const newestMtime = (dir) => {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .filter(isMsg)
    .reduce((max, f) => Math.max(max, statSync(join(dir, f)).mtimeMs), 0);
};

try {
  const inbox = join(COLLAB, 'inbox-trae');
  const msgs = existsSync(inbox) ? readdirSync(inbox).filter(isMsg) : [];
  const pending = msgs.length > 0 && newestMtime(inbox) > Math.max(newestMtime(join(COLLAB, 'inbox-zcode')), newestMtime(join(COLLAB, 'outbox')));
  if (!force && !pending) {
    log('idle：inbox-trae 无待办');
    process.exit(0);
  }
  log(`待办：${msgs.join('、') || '(force)'}`);

  if (existsSync(LOCK)) {
    const age = Date.now() - statSync(LOCK).mtimeMs;
    if (age < LOCK_STALE_MS) {
      log(`已加锁（${Math.round(age / 1000)}s），跳过`);
      process.exit(0);
    }
    log('陈旧锁（>45min），覆盖');
  }
  writeFileSync(LOCK, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid }));

  try {
    if (!skipRelay) {
      try {
        const out = execFileSync(process.execPath, [join(PROJECT, 'scripts', 'collab', 'relay-once.mjs')], { cwd: PROJECT, encoding: 'utf8', timeout: 20 * 60 * 1000 });
        log(`relay：${out.trim().split('\n').pop()}`);
      } catch (e) {
        log(`relay 失败（继续尝试 AI 复审）：${String(e.message).slice(0, 200)}`);
      }
    } else {
      log('--skip-relay：跳过机械证据复跑');
    }

    if (!existsSync(TRAECLI)) {
      log(`traecli 不存在（${TRAECLI}），保持待办原样，退出`);
      process.exit(0);
    }
    const prompt =
      `【协作待办·无头复审】你是 Trae（复审方），工作区 ${PROJECT}。collab/inbox-trae 有待审交付。按 collab/PROTOCOL.md 执行完整复审：` +
      `① 先读 collab/PROTOCOL.md、inbox-trae 最新交付消息与 collab/logs 中对应证据包（若无先跑 node "${KIT_DIR}/relay-once.mjs" --project "${PROJECT}"）；` +
      '② 逐条核验：交付声明 vs 代码 diff vs 旧栈契约（参照坐标见 Agents.md 第七节），除机械证据外独立抽检复跑门禁并留存原始输出到 collab/logs/；' +
      '③ 结论写入 collab/inbox-zcode/<轮次>-<序号>-review.md（不通过，含逐条意见）或 <轮次>-<序号>-passed.md（通过；passed 仅 Trae 可写）；' +
      '④ 同步 collab/state.json（owner/status/history），把已闭环交付消息移入 collab/outbox/；' +
      '⑤ 纪律：只读业务代码，只写 collab/ 与 docs/ 复审文档与放行标记，不执行任何 git 提交。完成后用一段话总结结论与关键证据路径。';
    log('traecli 启动（--query-timeout 30m，进程超时 35m）…');
    try {
      const out = execFileSync(TRAECLI, ['-p', prompt, '-y', '--query-timeout', '30m', '--mcp-init-wait-seconds', '5', '--add-dir', PROJECT], { cwd: PROJECT, encoding: 'utf8', timeout: 35 * 60 * 1000, stdio: 'pipe' });
      log(`traecli 完成：${String(out).trim().slice(0, 600) || '(无输出)'}`);
    } catch (e) {
      log(`traecli 失败（exit=${e.status ?? '?'}）：${String(e.stderr || e.message).slice(0, 400)}`);
    }
  } finally {
    try {
      rmSync(LOCK, { force: true });
    } catch {
      /* 忽略 */
    }
  }
  log('=== 结束 ===');
} catch (err) {
  log(`error ${err?.message ?? err}`);
}
process.exit(0);