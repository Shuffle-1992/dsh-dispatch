/**
 * Trae SessionStart 钩子：注入跨 Agent 协作待办摘要（纯文本 stdout = 附加上下文，规范见 docs.trae.cn Hook 配置详解）。
 * 配置位置：<工作区>/.trae/hooks.json → hooks.SessionStart（本仓库工作区为 f:/My Code）。
 * 行为：仅当 collab/inbox-trae 存在"未处理交付"时才输出；否则静默（不污染上下文）。
 * 判据：inbox-trae 最新消息 mtime > max(inbox-zcode, outbox) 最新 mtime。
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
    appendFileSync(LOG, `[${new Date().toISOString()}] session-inject ${line}\n`);
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
  if (!existsSync(COLLAB)) process.exit(0);
  const inbox = join(COLLAB, 'inbox-trae');
  const msgs = existsSync(inbox) ? readdirSync(inbox).filter(isMsg) : [];
  const pending =
    msgs.length > 0 && newestMtime(inbox) > Math.max(newestMtime(join(COLLAB, 'inbox-zcode')), newestMtime(join(COLLAB, 'outbox')));
  log(`msgs=${msgs.length} pending=${pending}`);
  if (!pending) process.exit(0);

  let state = '';
  try {
    state = readFileSync(join(COLLAB, 'state.json'), 'utf8');
  } catch {
    /* state 可选 */
  }
  const preview = msgs
    .slice(0, 5)
    .map((f) => {
      let head = '';
      try {
        head = readFileSync(join(inbox, f), 'utf8').slice(0, 500);
      } catch {
        head = '(读取失败)';
      }
      return `- ${f}\n${head}`;
    })
    .join('\n\n');

  process.stdout.write(
    `【跨 Agent 协作待办】collab/inbox-trae 存在待审交付，请优先按 collab/PROTOCOL.md 复审（独立复跑门禁；结论写入 collab/inbox-zcode/ 并同步 state.json）。\n\n${preview}\n\n【当前状态】${state}\n`,
  );
} catch (err) {
  log(`error ${err?.message ?? err}`);
}
process.exit(0);