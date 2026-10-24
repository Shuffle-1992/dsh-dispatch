import { spawn } from 'node:child_process';
const RUNNER = 'F:/My Code/dsh-dispatch/collab-kit/zcode-run.mjs';
const PROJ = 'F:\\My Code\\keysion dac vue';
const MODELS = ['GLM-5.3-Flash', 'GLM-5.3'];
const PROVIDER = process.env.PROV || 'start-plan';
const BATCHES = process.argv.slice(2).map(Number).filter((n) => n > 0);
function one(i) {
  return new Promise((done) => {
    const t0 = Date.now();
    const model = MODELS[i % 2];
    const child = spawn(process.execPath, [RUNNER, '--project', PROJ, '--prompt', '只回复这两个字：OK', '--provider', PROVIDER, '--model', model, '--mode', 'edit'], { windowsHide: true, env: { ...process.env } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 300000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      const ok = /done exit=0/.test(out);
      const hit = `${err}\n${out}`.split('\n').filter((l) => /concurrency|429|rate.?limit|失败|error/i.test(l)).slice(0, 1).map((l) => l.trim().slice(0, 100)).join('');
      done({ i, model, code, sec, ok, hit });
    });
  });
}
async function batch(n) {
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: n }, (_, i) => one(i)));
  const spent = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[${PROVIDER}] 并发 ${n}：成功 ${rs.filter((r) => r.ok).length}/${n}，耗时 ${spent}s`);
  for (const r of rs) console.log(`  #${r.i} ${r.model.padEnd(14)} exit=${String(r.code).padStart(3)} ${String(r.sec).padStart(6)}s ${r.ok ? '✓' : '✗'}${r.hit ? ` | ${r.hit}` : ''}`);
}
for (const n of (BATCHES.length ? BATCHES : [2])) { await batch(n); await new Promise((r) => setTimeout(r, 3000)); }
