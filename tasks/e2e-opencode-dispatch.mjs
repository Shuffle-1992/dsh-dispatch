// Lead 端到端验证（**真实 OpenCode**，免费模型）：wire ⇒ core ⇒ 真实执行器 ⇒ 事件行 ⇒ job 聚合。
// 不是单元测试（会真的调用免费模型），故单独放 tasks/ 下，作为本轮"跨引擎派发"的实弹证据。
//
// 用法：node tasks/e2e-opencode-dispatch.mjs
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatcher } from '../dispatch/core/dispatch-core.mjs';
import { createActionHandler } from '../dispatch/wire.host.mjs';

const ROOT = 'F:/My Code/dsh-dispatch';
const work = mkdtempSync(join(tmpdir(), 'dsp-e2e-'));
const sandbox = mkdtempSync(join(tmpdir(), 'dsp-e2e-cwd-'));
const d = createDispatcher({
  runnerPath: join(ROOT, 'collab-kit', 'zcode-run.mjs'), // zcode 执行器（本用例不用它）
  opencodeRunnerPath: join(ROOT, 'collab-kit', 'opencode-run.mjs'),
  workRoot: work,
  runnerCwd: sandbox,
  maxConcurrent: 3,
  maxConcurrentOpenCode: 2,
});
const api = createActionHandler(d, { switchPath: join(work, 'sw.json') });

const line = (k, v) => console.log(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitTerminal(id, timeoutMs = 180000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const j = d.get(id);
    if (j && ['done', 'failed', 'killed', 'interrupted', 'paused'].includes(j.state)) return j;
    await sleep(500);
  }
  return d.get(id);
}

console.log('=== 1) 通道清单（真实探测） ===');
const chans = await d.listChannels();
const oc = chans.channels.filter((c) => c.engine === 'opencode');
console.log(`  engines=${JSON.stringify(chans.engines)} zcode=${chans.channels.length - oc.length} opencode=${oc.length} opencodeVersion=${chans.opencodeVersion}`);
console.log(`  目标通道: ${oc[2]?.id}`);

console.log('\n=== 2) 派发：prompt（免费模型，真实调用） ===');
const t0 = Date.now();
const dis = await api('dispatch', {
  kind: 'prompt',
  prompt: 'Reply with exactly: PONG',
  provider: 'opencode/deepseek-v4.1-flash-free',
  tag: 'E2E-PROMPT',
  timeoutMin: 3,
  lock: 'none',
  cwd: sandbox,
});
line('ok', dis.ok);
line('error', dis.error ?? null);
if (!dis.ok) { console.log(dis); process.exit(1); }
line('spec', d.get(dis.job.id).spec);
const job = await waitTerminal(dis.job.id);
console.log(`  wall=${((Date.now() - t0) / 1000).toFixed(1)}s`);
line('state', job.state);
line('engine', job.engine);
line('sessionId', job.sessionId);
line('usage', job.usage);
line('responseChars', job.responseChars);
line('contextUsed/Window', `${job.contextUsed}/${job.contextWindow}`);
line('autoApproved', job.autoApproved ?? null);
console.log('  tail:');
for (const l of (job.tailLines ?? []).slice(-8)) console.log(`    ${l}`);
const resultFile = (job.tailLines ?? [])
  .map((l) => /\[opencode-run\] result=(.+)$/.exec(l))
  .find(Boolean)?.[1];
if (resultFile) {
  const rj = JSON.parse(readFileSync(resultFile, 'utf8'));
  line('result.response', rj.response);
  line('result.cost', rj.cost);
  line('result.eventCounts', rj.eventCounts);
  line('result.unknownEvents', rj.unknownEvents);
}

console.log('\n=== 3) 派发：写文件（Agent 真干活，免费模型） ===');
const dis2 = await api('dispatch', {
  kind: 'prompt',
  prompt: 'Create a file named e2e.txt containing exactly: hi from opencode',
  provider: 'opencode/glm-5.3-flash-free',
  tag: 'E2E-WRITE',
  timeoutMin: 4,
  lock: 'none',
  cwd: sandbox,
});
line('ok', dis2.ok);
if (dis2.ok) {
  const j2 = await waitTerminal(dis2.job.id);
  line('state', j2.state);
  line('engine', j2.engine);
  let content = null;
  try { content = readFileSync(join(sandbox, 'e2e.txt'), 'utf8').trim(); } catch { content = '(文件不存在)'; }
  line('e2e.txt', content);
  console.log('  tail:');
  for (const l of (j2.tailLines ?? []).slice(-6)) console.log(`    ${l}`);
}

console.log('\n=== 4) 失败路径：不存在的模型（原始错误透传，不崩） ===');
const dis3 = await api('dispatch', {
  kind: 'prompt', prompt: 'PONG', provider: 'opencode/definitely-not-a-model',
  tag: 'E2E-BAD', timeoutMin: 2, lock: 'none', cwd: sandbox,
});
line('ok', dis3.ok);
if (dis3.ok) {
  const j3 = await waitTerminal(dis3.job.id, 120000);
  line('state', j3.state);
  line('exitCode', j3.exitCode);
  line('pauseReason', j3.pauseReason ?? null);
  console.log('  tail:');
  for (const l of (j3.tailLines ?? []).slice(-5)) console.log(`    ${l}`);
}

console.log('\n=== 5) 跨引擎降级链：zcode 通道满/暂停时可跳到 OpenCode 通道（可用性来自同一份清单） ===');
const d2 = createDispatcher({
  runnerPath: join(ROOT, 'collab-kit', 'zcode-run.mjs'),
  opencodeRunnerPath: join(ROOT, 'collab-kit', 'opencode-run.mjs'),
  workRoot: work, runnerCwd: sandbox,
});
d2.setFallbackTarget({ provider: 'opencode/deepseek-v4.1-flash-free', model: null, reasoningLevel: 'agent' });
line('fallback', d2.getFallbackChain());

rmSync(work, { recursive: true, force: true });
rmSync(sandbox, { recursive: true, force: true });
console.log('\nE2E 完成');
process.exit(0);
