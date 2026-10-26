import * as fs from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createDispatcher, __testables } from '../dispatch/core/dispatch-core.mjs';
import { spawnTarget as qTarget, buildQoderArgs } from '../collab-kit/qoder-run.mjs';
import { spawnTarget as cbTarget, buildCodebuddyArgs } from '../collab-kit/codebuddy-run.mjs';
const root = resolve(import.meta.dirname, '..');
const base = join(root, 'test/.review-runtime');
const evidence = join(root, 'test/evidence/review-2026-10-26');
fs.mkdirSync(base,{recursive:true});
const result = {};
for (const kind of ['root','dispatch']) {
  const pack = JSON.parse(fs.readFileSync(join(evidence,`pack-${kind}.json`),'utf8').replace(/^\uFEFF/,''))[0];
  const pkg = join(base,'package-'+kind,'package');
  for(const entry of pack.files) {
    const src=join(root,kind==='root'?'':'dispatch',entry.path), dst=join(pkg,entry.path);
    fs.mkdirSync(dirname(dst),{recursive:true});fs.copyFileSync(src,dst);
  }
  const entry=join(pkg,kind==='root'?'dispatch/index.js':'index.js');
  const run=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(entry).href)})`],{cwd:pkg,encoding:'utf8',windowsHide:true,timeout:15000});
  result['package_'+kind]={files:pack.files.length,collabKitFiles:pack.files.filter(f=>f.path.startsWith('collab-kit/')).length,code:run.status,stderr:run.stderr};
}
const cmd=join(base,'fake-cli.cmd');fs.writeFileSync(cmd,'@echo OFF\r\necho AUDIT_FAKE_CLI\r\n');
for(const [engine,target,args] of [['qoder',qTarget,buildQoderArgs],['codebuddy',cbTarget,buildCodebuddyArgs]]) {
  const prompt='hello & echo AUDIT_SHELL_EXECUTED & rem';
  const t=target(cmd,args({prompt}));
  const run=spawnSync(t.cmd,t.argv,{shell:t.shell,encoding:'utf8',cwd:base,windowsHide:true,timeout:10000});
  result['shell_'+engine]={shell:t.shell,argv:t.argv,code:run.status,stdout:run.stdout,stderr:run.stderr,injected:run.stdout.includes('AUDIT_SHELL_EXECUTED')};
}
const lock=join(base,'live-owner.lock');
const old={jobId:'old-live-owner',pid:process.pid,at:new Date(Date.now()-__testables.LOCK_STALE_MS-1000).toISOString()};
fs.writeFileSync(lock,JSON.stringify(old));
const stale=__testables.isStaleLock(old,lock,Date.now());
const acquired=__testables.acquireLockFile(lock,{jobId:'second-owner',pid:process.pid,at:new Date().toISOString()},Date.now());
result.liveLockExpiry={ownerPid:process.pid,ownerIsCurrentLiveProcess:true,stale,acquired,after:JSON.parse(fs.readFileSync(lock,'utf8'))};
const runner=join(base,'wait-runner.mjs');
fs.writeFileSync(runner,"console.log('[zcode-run] progress stage=running');setTimeout(()=>process.exit(0),20000);\n");
const work=join(base,'kill-shared');
const d=createDispatcher({runnerPath:runner,workRoot:work,maxConcurrent:4,channelsImpl:async()=>({channels:[]})});
const job=d.dispatch({kind:'prompt',prompt:'local fixture',lock:'repo',timeoutMin:1});
await new Promise(r=>setTimeout(r,150));
const helper=`import { createDispatcher } from ${JSON.stringify(pathToFileURL(join(root,'dispatch/core/dispatch-core.mjs')).href)}; const d=createDispatcher({runnerPath:${JSON.stringify(runner)},workRoot:${JSON.stringify(work)},channelsImpl:async()=>({channels:[]})}); const before=d.get(${JSON.stringify(job.id)});const ok=d.kill(${JSON.stringify(job.id)});console.log(JSON.stringify({before:before.state,ok,after:d.get(${JSON.stringify(job.id)}).state})); d.dispose();`;
const external=spawnSync(process.execPath,['--input-type=module','-e',helper],{encoding:'utf8',windowsHide:true,timeout:10000});
result.crossProcessKill={code:external.status,stdout:external.stdout,stderr:external.stderr,ownerAfter:d.get(job.id).state};
d.kill(job.id,'review fixture cleanup');
for(let i=0;i<80&&d.get(job.id).state==='running';i++)await new Promise(r=>setTimeout(r,50));
d.dispose();
const relativeWork=join(base,'relative-lock'); const target=join(base,'target-project');fs.mkdirSync(target,{recursive:true});
const d2=createDispatcher({runnerPath:runner,workRoot:relativeWork,maxConcurrent:4,channelsImpl:async()=>({channels:[]})});
const ja=d2.dispatch({kind:'prompt',prompt:'fixture A',cwd:target,write:['same.txt'],timeoutMin:1});
const jb=d2.dispatch({kind:'prompt',prompt:'fixture B',cwd:target,write:[join(target,'same.txt')],timeoutMin:1});
result.relativeWriteLock={a:{state:ja.state,lockPaths:ja.lockPaths},b:{state:jb.state,lockPaths:jb.lockPaths},expectedFile:join(target,'same.txt'),fileLocks:d2.listFileLocks()};
for(const j of [ja,jb]) d2.kill(j.id,'review fixture cleanup');
for(let i=0;i<80&&d2.list().some(j=>j.state==='running');i++)await new Promise(r=>setTimeout(r,50));
d2.dispose();
fs.writeFileSync(join(evidence,'targeted-repro.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
