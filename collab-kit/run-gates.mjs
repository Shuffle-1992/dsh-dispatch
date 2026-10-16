/**
 * 门禁批量复跑器（协议见 collab/PROTOCOL.md；实现方自查与复审方复跑共用）。
 *
 * 用法：node <本仓库>/collab-kit/run-gates.mjs [--suite server,web] [--tag R03-01]
 * 行为：读取 collab/gates.json，逐套件逐命令执行；原始输出落 collab/logs/{tag}-{suite}-{n}-{cmd}.log；
 *      stdout 输出 PASS/FAIL 汇总；全绿 exit 0，任一条失败 exit 1。
 * 纪律：运行期间不要并跑 scripts/verify/mutation-check.mjs（会互相干扰导致误红）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
const LOGS = join(PROJECT, 'collab', 'logs');
const gatesFile = join(PROJECT, 'collab', 'gates.json');
if (!existsSync(gatesFile)) {
  console.error(`[run-gates] 缺少 ${gatesFile}`);
  process.exit(1);
}
const gates = JSON.parse(readFileSync(gatesFile, 'utf8'));
const argv = process.argv.slice(2);
const idxSuite = argv.indexOf('--suite');
const suiteFilter = idxSuite >= 0 ? new Set(String(argv[idxSuite + 1] ?? '').split(',').filter(Boolean)) : null;
const idxTag = argv.indexOf('--tag');
const tag = idxTag >= 0 ? String(argv[idxTag + 1]) : new Date().toISOString().replace(/[:.]/g, '-');

mkdirSync(LOGS, { recursive: true });

/* 并发互斥锁（R06-01 P3-5）：防止双方并跑门禁互污（mutation 并跑禁令的技术强制） */
const LOCK = join(LOGS, '.gates.lock');
if (existsSync(LOCK)) {
  try {
    const info = JSON.parse(readFileSync(LOCK, 'utf8'));
    const age = Date.now() - (info.startedAt || 0);
    let pidAlive = false;
    if (info.pid) {
      try { process.kill(info.pid, 0); pidAlive = true; } catch { pidAlive = false; }
    }
    if (age < 15 * 60 * 1000 && pidAlive) {
      console.error(`[run-gates] 检测到其他门禁运行中（PID ${info.pid}，tag=${info.tag}，已运行 ${Math.round(age / 1000)}s）——拒绝并跑。如确认无运行，请删除 ${LOCK}`);
      process.exit(1);
    }
    console.warn('[run-gates] 发现过期锁（>15min），覆盖继续');
  } catch {
    console.error('[run-gates] 锁文件损坏，拒绝并跑；请手动删除 ' + LOCK);
    process.exit(1);
  }
}
writeFileSync(LOCK, JSON.stringify({ pid: process.pid, tag, startedAt: Date.now() }));
let failed = 0;
let total = 0;
for (const suite of gates.suites) {
  if (suiteFilter && !suiteFilter.has(suite.name)) continue;
  for (const [i, cmd] of suite.commands.entries()) {
    const cwd = resolve(PROJECT, suite.cwd);
    const slug = cmd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || `cmd${i + 1}`;
    const logFile = join(LOGS, `${tag}-${suite.name}-${i + 1}-${slug}.log`);
    let code = 0;
    let out = '';
    /* spawnSync（R03-01 P3-2）：execSync 成功时只回 stdout，而 jest 汇总行走 stderr → 成功日志缺 Tests: 行 */
    const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8' });
    code = r.status ?? 1;
    out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    writeFileSync(logFile, `# suite=${suite.name} | cmd=${cmd} | cwd=${suite.cwd} | exit=${code}\n\n${out}`);
    total += 1;
    if (code !== 0) failed += 1;
    console.log(`${code === 0 ? 'PASS' : 'FAIL'}  [${suite.name}] ${cmd}  -> ${relative(PROJECT, logFile)}`);
  }
}
console.log(`\n[run-gates] 共 ${total} 条命令，失败 ${failed} 条（tag=${tag}）`);
try { if (existsSync(LOCK)) unlinkSync(LOCK); } catch { /* 清锁失败不掩盖门禁结果 */ }
/* P3-b 修复（R06-03 遗留）：锁自检与门禁结果合并判定——原 L73 先置 1、L74 无条件覆盖，自检形同虚设 */
const lockLeft = existsSync(LOCK);
if (lockLeft) console.error('[run-gates] 自检失败：锁未释放');
process.exitCode = failed || lockLeft ? 1 : 0;