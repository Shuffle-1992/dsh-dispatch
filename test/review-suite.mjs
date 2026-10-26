import { spawn } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const out = join(root, 'test/evidence/review-2026-10-26');
mkdirSync(out, { recursive: true });
const files = readdirSync(join(root, 'dispatch/test')).filter(f => f.endsWith('.test.mjs')).sort();
const results = [];
for (const file of files) {
  const started = Date.now();
  let stdout = '', stderr = '', timedOut = false;
  const child = spawn(process.execPath, [join(root, 'dispatch/test', file)], {
    cwd: root, windowsHide: true, stdio: ['ignore','pipe','pipe'],
    env: { ...process.env, Z2_ALLOW_PROFILE_WRITE: '0' },
  });
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 150000);
  const result = await new Promise(resolve => {
    child.on('error', e => resolve({code:null,error:String(e)}));
    child.on('close', (code,signal) => resolve({code,signal}));
  });
  clearTimeout(timeout);
  const row = { file, ...result, timedOut, ms: Date.now()-started,
    tap: Object.fromEntries([...stdout.matchAll(/^# (tests|pass|fail|skipped|cancelled) (\d+)$/gm)].map(m=>[m[1],Number(m[2])])) };
  results.push(row);
  writeFileSync(join(out, file+'.txt'), stdout+'\n--- STDERR ---\n'+stderr);
  writeFileSync(join(out, 'suite-results.json'), JSON.stringify(results,null,2));
  console.log(JSON.stringify(row));
}
console.log(JSON.stringify({total:results.length,passed:results.filter(r=>r.code===0&&!r.timedOut).length,failed:results.filter(r=>r.code!==0||r.timedOut).map(r=>r.file)}));
