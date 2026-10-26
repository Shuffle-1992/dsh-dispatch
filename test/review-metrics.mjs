import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createDispatcher, __testables } from '../dispatch/core/dispatch-core.mjs';
const root=resolve(import.meta.dirname,'..');
const out=join(root,'test/evidence/review-2026-10-26');
const base=join(root,'test/.review-runtime/metrics');fs.mkdirSync(base,{recursive:true});
const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const tests=files.filter(p=>p.endsWith('.test.mjs'));
const textAssertionFiles=tests.filter(p=>{const s=fs.readFileSync(join(root,p),'utf8');return /readFileSync/.test(s)&&/\.test\(|\.match\(|includes\(/.test(s);});
const absoluteSourceReaders=[];
for(const p of tests) fs.readFileSync(join(root,p),'utf8').split('\n').forEach((l,i)=>{if(!/^\s*(\/\/|\*|\/\*)/.test(l)&&/F:.*(?:dsh-dispatch|dispatch\\|dispatch\/)/.test(l))absoluteSourceReaders.push({path:p,line:i+1,text:l.trim()});});
const inventory={testFiles:tests.length,textAssertionHeuristicFiles:textAssertionFiles,absoluteSourceReaders,hasRootScripts:!!JSON.parse(fs.readFileSync(join(root,'package.json'),'utf8')).scripts,ciFiles:files.filter(p=>p.startsWith('.github/')),productionSources:files.filter(p=>/\.(m?js)$/.test(p)&&!p.startsWith('refs/')&&!p.includes('/test/')&&!p.startsWith('tools/')&&!p.startsWith('tasks/')).map(p=>({path:p,lines:fs.readFileSync(join(root,p),'utf8').split('\n').length}))};
fs.writeFileSync(join(out,'inventory.json'),JSON.stringify(inventory,null,2));
const syntax=[];for(const p of files.filter(p=>/\.(m?js)$/.test(p)&&!p.startsWith('refs/'))){const r=spawnSync(process.execPath,['--check',join(root,p)],{encoding:'utf8',windowsHide:true,timeout:10000});syntax.push({path:p,code:r.status,error:r.stderr});}
fs.writeFileSync(join(out,'syntax.json'),JSON.stringify(syntax,null,2));
const work=join(base,'work'),log=join(work,'logs','large.out.log');fs.mkdirSync(join(work,'logs'),{recursive:true});fs.mkdirSync(join(work,'state'),{recursive:true});
fs.writeFileSync(log,('x'.repeat(1023)+'\n').repeat(32768));
fs.writeFileSync(join(work,'state','jobs.json'),JSON.stringify({jobs:[{id:'large-fixture',state:'done',spec:{kind:'prompt',prompt:'fixture',engine:'zcode'},outLog:log,parseWarnings:[],queuedAt:new Date().toISOString(),finishedAt:new Date().toISOString()}]}));
const d=createDispatcher({runnerPath:join(root,'dispatch/test/fixtures/fake-runner.mjs'),workRoot:work,channelsImpl:async()=>({channels:[]})});
const origRead=fs.readFileSync;let readBytes=0;
fs.readFileSync=function(p,...args){const v=origRead.call(this,p,...args);if(String(p)===log)readBytes+=Buffer.byteLength(v);return v;};syncBuiltinESMExports();
const tail=[];for(let i=0;i<3;i++){readBytes=0;const st=performance.now();const lines=d.tail('large-fixture',30);tail.push({ms:+(performance.now()-st).toFixed(2),readBytes,returnedLines:lines.length,returnedBytes:Buffer.byteLength(lines.join('\n'))});}
fs.readFileSync=origRead;syncBuiltinESMExports();d.dispose();
const lock=join(base,'race.lock');const stale={jobId:'stale-A',pid:2147483647,at:new Date(0).toISOString()};fs.writeFileSync(lock,JSON.stringify(stale));
const originalRename=fs.renameSync;let injected=false;
fs.renameSync=function(a,b){if(String(a)===lock&&!injected){injected=true;fs.unlinkSync(lock);fs.writeFileSync(lock,JSON.stringify({jobId:'live-B',pid:process.pid,at:new Date().toISOString()}));}return originalRename.call(this,a,b);};syncBuiltinESMExports();
const got=__testables.acquireLockFile(lock,{jobId:'candidate-C',pid:process.pid,at:new Date().toISOString()},Date.now());
fs.renameSync=originalRename;syncBuiltinESMExports();
const race={method:'deterministic fs interleaving: another owner replaces stale lock immediately before rename',injected,acquired:got,finalOwner:JSON.parse(fs.readFileSync(lock,'utf8')).jobId};
const redactedSecretScan=[];for(const p of files.filter(p=>p.startsWith('profile-backup/'))){fs.readFileSync(join(root,p),'utf8').split('\n').forEach((l,i)=>{if(/(?:api[_-]?key|password|secret|bearer|access[_-]?token)\s*[":=]/i.test(l))redactedSecretScan.push({path:p,line:i+1,candidate:true});});}
const result={syntax:{checked:syntax.length,failures:syntax.filter(r=>r.code!==0)},tail:{fixtureBytes:fs.statSync(log).size,trials:tail},staleRenameRace:race,profileSecretScan:{candidateCount:redactedSecretScan.length,candidates:redactedSecretScan,note:'Heuristic, not a full secret scanner; values never emitted'},inventory:{textAssertionHeuristicFiles:textAssertionFiles.length,absoluteSourceReaderFiles:new Set(absoluteSourceReaders.map(x=>x.path)).size}};
fs.writeFileSync(join(out,'metrics.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
