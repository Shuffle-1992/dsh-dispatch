/**
 * Trae Stop 钩子：本轮结束前检查 collab/inbox-trae 是否有未处理交付。
 *   有 → stdout {"decision":"block","reason":...} 阻断停止，reason 作为新请求让智能体**自动续跑**复审；
 *   无 → 静默 exit 0，允许停止。
 * 配置：<工作区>/.trae/hooks.json → hooks.Stop（loop_limit=3 防死循环）。
 * 安全：任何异常一律 exit 0（允许停止），不阻塞用户；事件写入 collab/logs/hook-events.log。
 */
import { readdirSync, readFileSync, existsSync, statSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* collab/ 目录：--project > env ZCODE_PROJECT_DIR > cwd（本工具已迁至 dispatch/collab-kit）。 */
function resolveCollabDir() {
  const i = process.argv.indexOf('--project');
  const base = i >= 0 && process.argv[i + 1]
    ? resolve(process.argv[i + 1])
    : (process.env.ZCODE_PROJECT_DIR && process.env.ZCODE_PROJECT_DIR.trim() !== ''
        ? resolve(process.env.ZCODE_PROJECT_DIR.trim())
        : resolve(process.cwd()));
  return join(base, 'collab');
}
const COLLAB = resolveCollabDir();
const LOG = join(COLLAB, 'logs', 'hook-events.log');
const log = (line) => {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] stop-check ${line}\n`);
  } catch {
    /* 日志失败不阻塞 */
  }
};

let hookInput = {};
try {
  hookInput = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  /* 无 stdin 或非 JSON：按空处理 */
}
const loopCount = Number(hookInput.loop_count ?? 0);

const isMsg = (f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('README');
const newestMtime = (dir) => {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .filter(isMsg)
    .reduce((max, f) => Math.max(max, statSync(join(dir, f)).mtimeMs), 0);
};

try {
  if (!existsSync(COLLAB)) process.exit(0);
  /* 无头复审进行中（T5 通道）：跳过自动续跑，避免与 traecli 双重复审 */
  const lock = join(COLLAB, 'logs', '.headless-lock');
  if (existsSync(lock)) {
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age < 45 * 60 * 1000) {
      log(`headless-lock active(${Math.round(age / 1000)}s)，跳过`);
      process.exit(0);
    }
  }
  const inbox = join(COLLAB, 'inbox-trae');
  const msgs = existsSync(inbox) ? readdirSync(inbox).filter(isMsg) : [];
  const pending =
    msgs.length > 0 && newestMtime(inbox) > Math.max(newestMtime(join(COLLAB, 'inbox-zcode')), newestMtime(join(COLLAB, 'outbox')));
  log(`pending=${pending} msgs=${msgs.length} loop_count=${loopCount}`);
  if (!pending || loopCount >= 2) process.exit(0);

  const reason =
    `【协作待办·自动续跑】collab/inbox-trae 有待审交付：${msgs.join('、')}。` +
    '请按 collab/PROTOCOL.md 执行复审：① 若无证据包先跑 node <本仓库>/collab-kit/relay-once.mjs；' +
    '② 独立复跑门禁抽检并留存原始输出；' +
    '③ 结论写入 collab/inbox-zcode/<轮次>-<序号>-review.md 并同步 collab/state.json；' +
    '④ 闭环后把消息归档到 collab/outbox/。';
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
} catch (err) {
  log(`error ${err?.message ?? err}`);
}
process.exit(0);