/**
 * ZCode SessionStart 钩子（协议通道 T2）：把协作待办注入 ZCode 会话上下文。
 * 输出协议与 ZCode 现有 inject-agents-md.js 一致：stdout 返回 {"additionalContext": "..."}。
 * 配置示例（~/.zcode/cli/config.json，需用户同意后添加，本仓库不擅自改用户级配置）：
 *   "SessionStart": [{ "hooks": [{ "type": "process", "command": "node",
 *     "args": ["F:/My Code/dsh-dispatch/collab-kit/inject-inbox.js"], "timeoutMs": 5000 }] }]
 * 行为：无 inbox-zcode 目录或无待办且无 state 时静默退出；有待办时注入消息预览 + state.json。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 定位 collab/：依次尝试「环境变量 → 当前工作目录 → 脚本所在仓库根」，任一命中即用（cwd 无关，防钩子工作目录漂移时静默失效）
const candidates = [
  process.env.ZCODE_PROJECT_DIR,
  process.cwd(),
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
].filter(Boolean);
const inboxDir = candidates.map((p) => join(p, 'collab', 'inbox-zcode')).find((d) => existsSync(d));
if (!inboxDir) process.exit(0);
const collabDir = dirname(inboxDir);

const messages = readdirSync(inboxDir).filter((f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('README'));
let state = '';
try {
  state = readFileSync(join(collabDir, 'state.json'), 'utf8').trim();
} catch {
  /* state 可选 */
}

if (!messages.length) {
  if (!state) process.exit(0);
  process.stdout.write(JSON.stringify({ additionalContext: `【协作状态】${state}` }));
  process.exit(0);
}

const previews = messages
  .slice(0, 10)
  .map((f) => {
    let text = '';
    try {
      text = readFileSync(join(inboxDir, f), 'utf8');
    } catch {
      text = '(读取失败)';
    }
    return `### ${f}\n${text.slice(0, 1500)}`;
  })
  .join('\n\n');

process.stdout.write(
  JSON.stringify({
    additionalContext:
      `【协作待办】collab/inbox-zcode 有 ${messages.length} 条未处理消息，先按 collab/PROTOCOL.md 处理（处理完移入 outbox/ 并同步 state.json）：\n\n` +
      `${previews}\n\n【当前协作状态】${state}`,
  }),
);
process.exit(0);