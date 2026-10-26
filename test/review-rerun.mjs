import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const out=join(root,'test/evidence/review-2026-10-26');
const results=[];
for(const file of ['channel-retry.test.mjs','core.test.mjs','engine-discover.test.mjs','opencode-executor.test.mjs']) {
  const start=Date.now();
  const r=spawnSync(process.execPath,[join(root,'dispatch/test',file)],{cwd:root,windowsHide:true,encoding:'utf8',timeout:150000,maxBuffer:16*1024*1024});
  const row={file,code:r.status,error:r.error?.message??null,ms:Date.now()-start};
  results.push(row);writeFileSync(join(out,'rerun-'+file+'.txt'),(r.stdout??'')+'\n--- STDERR ---\n'+(r.stderr??''));
  writeFileSync(join(out,'rerun-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(row));
}
