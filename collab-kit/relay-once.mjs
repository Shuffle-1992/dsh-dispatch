/**
 * 单轮中继（无人值守的"机械复审准备"；协议见 collab/PROTOCOL.md §5.2）。
 *
 * 作用：ZCode 交付落 inbox-trae 后（无论人工/计划任务/watcher 触发），本脚本：
 *   1) 找 inbox-trae 中最新的、尚无证据包的交付消息；
 *   2) 跑 collab-kit/run-gates.mjs 全套门禁复跑并留原始日志；
 *   3) 产出证据包 collab/logs/{消息名}-evidence.md（供 Trae 终审直接消费，省去人工搬运）。
 * 用法：node <本仓库>/collab-kit/relay-once.mjs [--suite server,etl] [--no-gates]
 * 说明：本脚本**不调用外部 AI**；如需 AI 初判（claude/codex），见 PROTOCOL §5.2 的显式启用方式（需使用者同意）。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, relative, dirname } from 'node:path';
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
const INBOX = join(PROJECT, 'collab', 'inbox-trae');
const LOGS = join(PROJECT, 'collab', 'logs');
mkdirSync(LOGS, { recursive: true });

const argv = process.argv.slice(2);
const idxSuite = argv.indexOf('--suite');
const suiteArg = idxSuite >= 0 && argv[idxSuite + 1] ? ['--suite', argv[idxSuite + 1]] : [];
const skipGates = argv.includes('--no-gates');

const messages = readdirSync(INBOX)
  .filter((f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('README'))
  .map((f) => ({ name: f, mtime: statSync(join(INBOX, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (!messages.length) {
  console.log('[relay-once] inbox-trae 无待处理交付，退出');
  process.exit(0);
}

const msg = messages[0];
const evidenceFile = join(LOGS, `${msg.name.replace(/\.md$/, '')}-evidence.md`);
if (existsSync(evidenceFile)) {
  console.log(`[relay-once] 最新交付 ${msg.name} 已有证据包（${relative(PROJECT, evidenceFile)}），跳过`);
  process.exit(0);
}

let gatesOut = '(已跳过门禁复跑，--no-gates)';
let gatesCode = 0;
if (!skipGates) {
  try {
    gatesOut = execSync(`node ${JSON.stringify(join(PROJECT, 'scripts', 'collab', 'run-gates.mjs'))} --tag ${msg.name.replace(/\.md$/, '')} ${suiteArg.join(' ')}`, {
      cwd: PROJECT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (err) {
    gatesCode = typeof err.status === 'number' ? err.status : 1;
    gatesOut = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

const now = new Date().toISOString();
writeFileSync(
  evidenceFile,
  `# 中继证据包：${msg.name}

- 交付消息：collab/inbox-trae/${msg.name}
- 生成时间：${now}
- 门禁复跑：exit=${gatesCode}（原始日志见 collab/logs/${msg.name.replace(/\.md$/, '')}-*.log）
- 说明：本证据包由 relay-once.mjs 生成，仅完成机械复跑；**放行结论须由 Trae 复审后写入 collab/inbox-zcode/**。

## 门禁输出

\`\`\`
${gatesOut.trim()}
\`\`\`
`,
);
console.log(`[relay-once] 已生成证据包：${relative(PROJECT, evidenceFile)}（门禁 exit=${gatesCode}）`);
console.log(`[relay-once] 下一步：Trae 复审 → 出 collab/inbox-zcode/${msg.name.replace('delivery', 'review')}`);
process.exitCode = gatesCode ? 1 : 0;