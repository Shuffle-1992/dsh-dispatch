#!/usr/bin/env node
/**
 * `tools/accept-021.mjs` — DSH 0.2.1 期改动的**一键验收**（离线部分）。
 *
 * 为什么要有它：本轮三项优化（ZB-61/62/63）里有两项是**宿主半边**改动，只有 DSH 重启（或
 * 一次重组合）后才会真正跑新代码；而"到底装进去没有"以前只能靠肉眼看信标/逐条敲命令。
 * 这个脚本把**能离线判定的**全部自动化，并把**只能活体验证的**列成清单，让一次重启的验收成本降到一条命令。
 *
 * 用法：
 *   node tools/accept-021.mjs            # 静态接线 + 信标新鲜度 + 状态文件
 *   node tools/accept-021.mjs --suite    # 额外跑全量回归（51 个进程，约 1-2 分钟）
 *
 * 退出码：0 = 全部通过（活体清单除外）；1 = 有 FAIL。
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const D = join(ROOT, 'dispatch');
const STATE = join(D, '.data', 'state');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; failures.push(name); console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function read(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
function section(t) { console.log(`\n${t}`); }

/* ── 1. 静态接线：三项优化是否都还在源码里 ─────────────────────────────── */
section('[1] 静态接线（源码断言，防"改了又丢"）');
const indexSrc = read(join(D, 'index.js')) ?? '';
const wireSrc = read(join(D, 'wire.host.mjs')) ?? '';
const notifySrc = read(join(D, 'notify.mjs')) ?? '';
const clientSrc = read(join(D, 'client.js')) ?? '';

ok('ZB-61 index.js 工具 schema 有 limit/full', /limit:\s*\{/.test(indexSrc) && /full:\s*\{/.test(indexSrc));
ok('ZB-61 wire.host.mjs 有 briefJob + 50/200 上限',
  /function briefJob\s*\(/.test(wireSrc) && /LIST_LIMIT_DEFAULT\s*=\s*50/.test(wireSrc) && /LIST_LIMIT_MAX\s*=\s*200/.test(wireSrc));
ok('ZB-61 工具描述写明"紧凑默认"', indexSrc.includes('紧凑'));

ok('ZB-62 订阅三个 inbox 事件',
  notifySrc.includes("'agent/inbox/inserted'") && notifySrc.includes("'agent/inbox/discarded'") && notifySrc.includes("'agent/inbox/claimed'"));
ok('ZB-62 落盘 wake-stats.json', notifySrc.includes('wake-stats.json'));
/* 顺序守卫：deliver() 里必须先 remember(deliveredIds...) 再 followup/inject（真机同步 emit 事故的修复）。 */
const deliverStart = notifySrc.indexOf('function deliver(');
const deliverBody = deliverStart >= 0 ? notifySrc.slice(deliverStart, deliverStart + 2600) : '';
const iRemember = deliverBody.indexOf('remember(deliveredIds');
const iInject = deliverBody.indexOf('agent.inject(message)');
ok('ZB-62 先登记消息 id、再投递（顺序守卫）', iRemember >= 0 && iInject > iRemember,
  iRemember < 0 ? '没找到 remember(deliveredIds' : `remember@+${iRemember} < inject@+${iInject}`);

ok('ZB-63 客户端注册 toolview 槽位', clientSrc.includes("'tool.call.toolview'") && /TOOLVIEW_KEY\s*=\s*'dispatch'/.test(clientSrc));
ok('ZB-63 apply() 内有该注册', /ctx\.slots\.inject\(TOOLVIEW_SLOT/.test(clientSrc));

/* 两份 package.json 的 dsh.client.inject 必须一致（否则从 npm 安装时会与开发环境行为分叉）。 */
const rootPkg = JSON.parse(read(join(ROOT, 'package.json')) ?? '{}');
const dispPkg = JSON.parse(read(join(D, 'package.json')) ?? '{}');
const injA = JSON.stringify(rootPkg?.dsh?.client?.inject ?? null);
const injB = JSON.stringify(dispPkg?.dsh?.client?.inject ?? null);
ok('两份 package.json 的 client.inject 一致', injA === injB, injA === injB ? injA : `root=${injA} dispatch=${injB}`);

/* 文案三方同步的轻量版（完整断言在 single-source.test.mjs 里）。
   注意：locale 文件是**嵌套**结构 —— `{ meta: {...}, ui: { <239 个键> } }`，
   所以要比的是**扁平化后的点路径集合**，不能只比顶层键（早期这里只比顶层，得出"2 键"的假阳性）。 */
function flattenKeys(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flattenKeys(v, p));
    else out.push(p);
  }
  return out.sort();
}
const zh = JSON.parse(read(join(D, 'locale', 'zh.json')) ?? '{}');
const en = JSON.parse(read(join(D, 'locale', 'en.json')) ?? '{}');
const zhKeys = flattenKeys(zh);
const enKeys = flattenKeys(en);
const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
ok('locale zh/en 键集一致', missingInEn.length === 0 && missingInZh.length === 0,
  missingInEn.length || missingInZh.length
    ? `zh 独有 ${missingInEn.length}（${missingInEn.slice(0, 3).join(',')}），en 独有 ${missingInZh.length}（${missingInZh.slice(0, 3).join(',')}）`
    : `${zhKeys.length} 键`);

/* ── 2. 信标新鲜度：跑的是不是最新代码 ─────────────────────────────────── */
section('[2] 信标（插件是否已重跑过 = 跑的是不是磁盘上的最新代码）');
const beaconPath = join(STATE, 'activation.json');
const beaconRaw = read(beaconPath);
let beacon = null;
try { beacon = beaconRaw ? JSON.parse(beaconRaw) : null; } catch { beacon = null; }
if (!beacon) {
  ok('activation.json 可读', false, '插件可能从未激活（或路径不对）');
} else {
  ok('dispatcherReady / toolRegistered', beacon.dispatcherReady === true && beacon.toolRegistered === true);
  ok('wakeActive / agentsVisible', beacon.wakeActive === true && beacon.agentsVisible === true);
  const issues = Array.isArray(beacon.configIssues) ? beacon.configIssues : [];
  ok('configIssues 为空（配置兜底没被触发）', issues.length === 0, issues.length ? JSON.stringify(issues.slice(0, 3)) : '');
  const beaconAt = Date.parse(beacon.at ?? '');
  const hostFiles = [
    join(D, 'index.js'), join(D, 'wire.host.mjs'), join(D, 'notify.mjs'),
    ...readdirSync(join(D, 'core')).filter((f) => f.endsWith('.mjs')).map((f) => join(D, 'core', f)),
  ];
  const newest = Math.max(...hostFiles.map((f) => { try { return statSync(f).mtimeMs; } catch { return 0; } }));
  const newer = hostFiles.filter((f) => { try { return statSync(f).mtimeMs > beaconAt; } catch { return false; } });
  ok('当前运行的代码不旧于磁盘（否则需要重启一次）', newer.length === 0,
    newer.length
      ? `有 ${newer.length} 个宿主文件比信标新：${newer.map((f) => f.split(/[\\/]/).pop()).join(', ')} ⇒ 请重启 DSH`
      : `信标 ${beacon.at}，比最新宿主文件还新 ${Math.round((beaconAt - newest) / 1000)}s`);
}

/* ── 3. 状态文件：唤醒对账链路有没有真的跑过 ───────────────────────────── */
section('[3] 唤醒对账（ZB-62 的状态文件）');
const wsPath = join(STATE, 'wake-stats.json');
const wsRaw = read(wsPath);
if (!wsRaw) {
  console.log('  · wake-stats.json 还不存在 —— 说明新一轮代码生效后**还没有**任何 job 落地（不是错误）。');
  console.log('    重启后随便派一个小任务落地，再跑本脚本即可看到对账结果。');
} else {
  let ws = null;
  try { ws = JSON.parse(wsRaw); } catch { ws = null; }
  ok('wake-stats.json 可解析', !!ws);
  if (ws) {
    console.log(`    ${JSON.stringify({ delivered: ws.delivered, followup: ws.followup, inject: ws.inject, insertAcked: ws.insertAcked, lostWakes: ws.lostWakes, unconfirmed: ws.unconfirmed })}`);
    ok('至少投递过一次', (ws.delivered ?? 0) > 0, `delivered=${ws.delivered ?? 0}`);
    ok('inserted 对账已生效（insertAcked > 0）', (ws.insertAcked ?? 0) > 0,
      (ws.insertAcked ?? 0) > 0 ? '' : '若 delivered>0 而 insertAcked=0 ⇒ 运行的还是 ZB-62 修复前的旧代码，需重启');
  }
}

/* ── 4. 可选：全量回归 ─────────────────────────────────────────────────── */
if (process.argv.includes('--suite')) {
  section('[4] 全量回归（51 个进程）');
  const r = spawnSync(process.execPath, [join(process.env.TEMP ?? '/tmp', 'dispatch-suite.mjs')], { cwd: ROOT, encoding: 'utf8' });
  const tail = (r.stdout ?? '').trim().split(/\r?\n/).slice(-3).join(' | ');
  ok('dispatch-suite 全绿', r.status === 0, tail || `exit=${r.status}`);
}

/* ── 5. 只能活体验证的清单 ─────────────────────────────────────────────── */
section('[5] 只剩这些必须"活体"验证（重启后由 AI 会话执行，或你在 GUI 里看一眼）');
console.log('  · dispatch action=list      → 返回应含 shape:"brief" / total / counts / note（ZB-61 已生效）');
console.log('  · cordis_inspect_query host/Tool/listTools → dispatch 参数里有 limit / full');
console.log('  · cordis_inspect_query client/Slots/listSubTree {root:"tool.call.toolview"}');
console.log('    → occupants 里出现 key:"dispatch", active:true（ZB-63）');
console.log('  · 派一个 5 分钟以内的小任务并等它落地 → 会话收到唤醒 + wake-stats.json 里 insertAcked 递增（ZB-62）');
console.log('  · GUI 目视会话内 dispatch 调用卡片（折叠行 + 展开详情 + 明暗主题）');

console.log(`\n摘要：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('失败项：'); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail ? 1 : 0);
