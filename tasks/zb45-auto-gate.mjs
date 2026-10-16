// ZB-45 独立门禁（Lead）：`auto` 放行开关的**行为**验证（离线、假执行器抓 argv）。
// 三件事必须同时成立，缺一不可：
//   ① 默认不带 --auto（硬约束「不默认开」）
//   ② 显式 auto:true ⇒ 执行器真的收到 --auto，且 job 有**可审计**痕迹
//   ③ retry/交接重跑**沿用**放行级别（否则同一任务重试后行为悄悄变了）
//   ④ auto:true 配 zcode 引擎 ⇒ 可读报错（不静默失真）
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../dispatch/core/dispatch-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FAKE_ZCODE = join(ROOT, 'dispatch', 'test', 'fixtures', 'fake-runner.mjs');
const dirs = [];
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/* 假 OpenCode 执行器：把自己收到的 argv 落盘（`--auto` 是否出现 = 唯一判据）。 */
function fakeOc(dir, marker) {
  const p = join(dir, 'fake-oc.mjs');
  writeFileSync(p, [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.OC_MARKER, JSON.stringify(process.argv.slice(2)));",
    "console.log('[opencode-run] tag=auto-check mode=opencode cwd=x');",
    "if (process.argv.includes('--auto')) console.log('[opencode-run] auto=on（已放行所有未显式拒绝的权限；请确保工作目录可信）');",
    "console.log('[opencode-run] provider=opencode model=opencode/fake-free');",
    "console.log('[opencode-run] done exit=0 elapsed=0.1s session=ses_x model=opencode/fake-free responseChars=1');",
    '',
  ].join('\n'));
  return { path: p, marker };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'failed', 'killed', 'interrupted'];
async function waitTerminal(d, id, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const j = d.get(id);
    if (j && (TERMINAL.includes(j.state) || j.state === 'paused')) return j;
    await sleep(20);
  }
  throw new Error(`waitTerminal 超时：${d.get(id)?.state}`);
}

let pass = 0; const fail = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };

const setups = [];
function mkApi() {
  const work = mk('auto-work-');
  const marker = join(work, 'argv.json');
  const fo = fakeOc(work, marker);
  process.env.OC_MARKER = marker;
  const d = createDispatcher({
    runnerPath: FAKE_ZCODE, opencodeRunnerPath: fo.path, workRoot: work, maxConcurrent: 4,
  });
  setups.push({ d, work });
  return { d, marker };
}
const argvOf = (marker) => { try { return JSON.parse(readFileSync(marker, 'utf8')); } catch { return null; } };

console.log('① 默认不放行（硬约束「不默认开 --auto」）');
{
  const { d, marker } = mkApi();
  const j = d.dispatch({ kind: 'prompt', prompt: 'x', tag: 'A0', provider: 'opencode/fake-free', lock: 'none' });
  await waitTerminal(d, j.id);
  const argv = argvOf(marker);
  ok(Array.isArray(argv) && !argv.includes('--auto'), `默认 argv 不含 --auto（实际 ${JSON.stringify(argv)}）`);
  ok(d.get(j.id).autoApproved !== true, 'job.autoApproved 不为 true');
}

console.log('\n② 显式 auto:true ⇒ 真的放行 + 可审计');
{
  const { d, marker } = mkApi();
  const j = d.dispatch({ kind: 'prompt', prompt: 'x', tag: 'A1', provider: 'opencode/fake-free', auto: true, lock: 'none' });
  await waitTerminal(d, j.id);
  const argv = argvOf(marker);
  ok(Array.isArray(argv) && argv.includes('--auto'), `argv 含 --auto（实际 ${JSON.stringify(argv)}）`);
  const job = d.get(j.id);
  ok(job.autoApproved === true, '★ job.autoApproved=true（面板/CLI 可审计）');
  ok((job.tailLines ?? []).some((l) => /auto=on/.test(l)), '执行器确认行 auto=on 落在 tailLines（交叉核对）');
}

console.log('\n③ 显式 auto:false 与缺省等价（都是不放行）');
{
  const { d, marker } = mkApi();
  const j = d.dispatch({ kind: 'prompt', prompt: 'x', tag: 'A2', provider: 'opencode/fake-free', auto: false, lock: 'none' });
  await waitTerminal(d, j.id);
  ok(!argvOf(marker).includes('--auto'), 'auto:false ⇒ argv 不含 --auto');
}

console.log('\n④ retry 沿用放行级别（交接重跑不得悄悄变回不放行）');
{
  const { d, marker } = mkApi();
  const j = d.dispatch({ kind: 'prompt', prompt: 'x', tag: 'A3', provider: 'opencode/fake-free', auto: true, lock: 'none' });
  await waitTerminal(d, j.id);
  /* 手工造一个"已暂停/无 session"的场景不可靠 ⇒ 直接测**交接重跑**分支：
   * 原 job 有 auto:true 且无 sessionId 时，retry 走交接重跑，新 job 必须沿用 auto。 */
  const prev = readFileSync(marker, 'utf8');
  const nj = d.retry(j.id, { provider: 'opencode/fake-free' });
  ok(String(prev).length > 0, '原 job 已产出 argv（基线）');
  await waitTerminal(d, nj.id);
  const argv2 = argvOf(marker);
  ok(argv2 && argv2.includes('--auto'), `★ 交接重跑的新 job 仍带 --auto（实际 ${JSON.stringify(argv2)}）`);
  ok(d.get(nj.id).autoApproved === true, '新 job autoApproved=true（跨 retry 沿用）');
}

console.log('\n⑤ auto:true + zcode 引擎 ⇒ 可读报错（不静默）');
{
  const { d } = mkApi();
  let err = null;
  try {
    d.dispatch({ kind: 'prompt', prompt: 'x', provider: 'plan', auto: true, lock: 'none' });
  } catch (e) { err = e; }
  ok(err instanceof TypeError, '抛 TypeError');
  ok(/auto/.test(String(err?.message ?? '')) && /opencode/.test(String(err?.message ?? '')), `报错可读且指向 auto/opencode（实际：${err?.message}）`);
}

console.log(`\n===== ZB-45 auto 门禁：${pass} PASS / ${fail.length} FAIL =====`);
for (const { d } of setups) { for (const j of d.list() ?? []) { if (!TERMINAL.includes(j.state) && j.state !== 'paused') { try { d.kill(j.id, 'teardown'); } catch { /* ignore */ } } } }
await sleep(200);
for (const dir of dirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
process.exit(fail.length ? 1 : 0);
