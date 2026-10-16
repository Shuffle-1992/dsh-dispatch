// 并发实验（Lead 真机）：同一时刻两个 opencode 进程是否会互相破坏？
// 直接回答「OpenCode 引擎并发上限该设几」这个调度参数问题。
// 用法：node tools/oc-concurrency-probe.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNNER = 'F:/My Code/dsh-dispatch/collab-kit/opencode-run.mjs';
const root = mkdtempSync(join(tmpdir(), 'oc-conc-'));
const N = Number(process.argv[2] ?? 2);

const runOne = (i) => new Promise((resolve) => {
  const cwd = join(root, `w${i}`);
  mkdirSync(cwd, { recursive: true });
  const t0 = Date.now();
  const child = spawn(process.execPath, [
    RUNNER,
    '--prompt', `Reply with exactly: PONG-${i}`,
    '--model', 'opencode/deepseek-v4.1-flash-free',
    '--tag', `conc-${i}`,
    '--timeout-min', '3',
    '--cwd', cwd,
  ], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => {
    const done = /\[opencode-run\] done (.+)$/m.exec(out)?.[1] ?? '(无 done 行)';
    resolve({ i, code, ms: Date.now() - t0, done, outBytes: out.length, errBytes: err.length, errHead: err.split('\n').slice(0, 2).join(' | ') });
  });
});

console.log(`并发 ${N} 个 opencode run（同模型、各自独立工作目录）...`);
const rs = await Promise.all(Array.from({ length: N }, (_, i) => runOne(i + 1)));
for (const r of rs) {
  console.log(`  [${r.i}] exit=${r.code} ${(r.ms / 1000).toFixed(1)}s out=${r.outBytes}B err=${r.errBytes}B`);
  console.log(`      done: ${r.done}`);
  if (r.code !== 0) console.log(`      stderr: ${r.errHead}`);
}
const okCount = rs.filter((r) => r.code === 0).length;
console.log(`\n结论：${okCount}/${N} 成功`);
console.log(okCount === N
  ? '⇒ 并发 OpenCode 进程【未】互相破坏（本机本次实测）'
  : '⇒ 并发 OpenCode 进程【存在】互相破坏（本机本次实测）—— 并发上限应设为 1');
rmSync(root, { recursive: true, force: true });
process.exit(0);
