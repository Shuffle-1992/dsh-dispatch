#!/usr/bin/env node
/**
 * zcd — ZCode 派发核心的独立 CLI（零依赖）。
 *
 * 用法：
 *   node bin/dispatch.mjs --help
 *   node bin/dispatch.mjs list [--json]
 *   node bin/dispatch.mjs dispatch --kind prompt --prompt "只回答 OK" --model GLM-5.3-Flash --tag z1-smoke
 *   node bin/dispatch.mjs dispatch --kind task --task <abs path> --mode yolo --timeout-min 30
 *   node bin/dispatch.mjs watch            # 每 1s 打印 snapshot 摘要，Ctrl+C 退出
 *   node bin/dispatch.mjs quota [--json] [--timeout-ms 15000]
 *   node bin/dispatch.mjs plan-quota [--json] [--timeout-ms 15000] [--tz Asia/Shanghai]
 *   node bin/dispatch.mjs kill <id>
 *   node bin/dispatch.mjs tail <id> [-n 50]
 *   node bin/dispatch.mjs channels [--json]              # 通道清单（含可用性与原因；解析失败给 warnings 不猜）
 *   node bin/dispatch.mjs channel [set <provider> [--model <m>]]   # 查看/设默认通道（持久化到 state/channel.json）
 *   node bin/dispatch.mjs retry <jobId> [--provider <p>] [--model <m>]  # 同通道=--resume 续跑（绝不带 --model）；换通道=交接重跑
 *   node bin/dispatch.mjs fallback [list|set a,b,c|set <id> --model <m> --thinking <lv>|off]   # 自动降级（默认关；set 即开启）
 *
 * dispatch 附加：--kind task|prompt|target --prompt/--task/--target --model --provider
 *   --mode build|edit|plan|yolo --tag --timeout-min --cwd --resume --memory-bench
 *   --lock repo|memory|both --max-concurrent <n> --no-wait
 *
 * 路径默认值（可用环境变量或参数覆盖）：
 *   DSP_RUNNER / --runner        runner 脚本（通用工具仓库 <本仓库>/collab-kit/zcode-run.mjs，只读使用）
 *   DSP_LEDGER / --ledger        台账 dispatch-runs.jsonl
 *   DSP_WORK_ROOT / --work-root  派发器工作根目录（默认 <dispatch>/work）
 *   DSP_RUNNER_CWD / --runner-cwd  子进程工作目录（默认当前目录）
 * 测试注入：DSP_FAKE_RUNNER 覆盖 runner 路径（见 test/core.test.mjs）。
 * 注意：runner / ledger 指向宿主项目，属机器专有路径，**不设硬编码兜底**——必须由
 * --runner/--ledger 或 DSP_RUNNER/DSP_LEDGER 给出，否则报错退出（避免猜一个位置静默跑错）。
 */
import { createDispatcher } from '../core/dispatch-core.mjs';
import { aggregate, fetchPlanQuota } from '../core/quota.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = {
  runner: '',
  ledger: '',
  workRoot: join(MODULE_ROOT, 'work'),
};

/* ---------- 参数解析（--k v / --k=v / 布尔） ---------- */
const argv = process.argv.slice(2);
const opt = {};
const pos = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 0) {
      opt[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const key = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt != null && !nxt.startsWith('--')) {
        opt[key] = nxt;
        i += 1;
      } else {
        opt[key] = true;
      }
    }
  } else if (a === '-n') {
    opt.n = argv[++i];
  } else {
    pos.push(a);
  }
}
const numOf = (v) => (v == null || v === true ? undefined : Number(v));
const boolOf = (v) => v === true || v === 'true';

const cmd = pos[0] ?? 'help';

function usage(exitCode = 0) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(exitCode);
}

function makeDispatcher() {
  return createDispatcher({
    runnerPath: opt.runner ?? process.env.DSP_RUNNER ?? DEFAULTS.runner,
    ledgerPath: opt.ledger ?? process.env.DSP_LEDGER ?? DEFAULTS.ledger,
    workRoot: opt['work-root'] ?? process.env.DSP_WORK_ROOT ?? DEFAULTS.workRoot,
    runnerCwd: opt['runner-cwd'] ?? process.env.DSP_RUNNER_CWD ?? process.cwd(),
    maxConcurrent: numOf(opt['max-concurrent']),
  });
}

const fmtTokens = (n) => (n == null ? '-' : String(n));
const fmtSec = (s) => (s == null ? '-' : `${Number(s).toFixed(1)}s`);

function printJobLine(j) {
  const pad = (s, n) => String(s ?? '-').padEnd(n);
  console.log(
    `${pad(j.id, 16)}${pad(j.state, 12)}${pad(j.tag, 14)}${pad(j.model, 16)}${pad(fmtSec(j.elapsedSec), 9)}` +
      `${pad(j.exitCode, 5)}${pad(j.lock, 10)}${j.sessionId ?? ''}`,
  );
}

function printSummary(j) {
  console.log(
    `[zcd] job=${j.id} state=${j.state} exit=${j.exitCode ?? '-'} elapsed=${fmtSec(j.elapsedSec)}` +
      ` session=${j.sessionId ?? '-'}` +
      `\n[zcd] provider=${j.provider ?? '-'} model=${j.model ?? '-'} billing=${j.billing ?? '-'}` +
      `\n[zcd] usage requests=${fmtTokens(j.usage.requests)} in=${fmtTokens(j.usage.inputTokens)}` +
      ` out=${fmtTokens(j.usage.outputTokens)} cacheRead=${fmtTokens(j.usage.cacheReadTokens)}` +
      ` responseChars=${fmtTokens(j.responseChars)}`,
  );
  if (j.pauseReason) console.log(`[zcd] pauseReason=${j.pauseReason} pauseDetail=${j.pauseDetail ?? '-'}`);
  if (j.parentJobId) console.log(`[zcd] parentJob=${j.parentJobId} hop=${j.hopCount ?? 0} attempts=${(j.attempts ?? []).length}`);
  if (j.resultFile) console.log(`[zcd] result=${j.resultFile}`);
  if (j.outLog) console.log(`[zcd] out=${j.outLog}`);
  if (j.parseWarnings.length) console.log(`[zcd] parseWarnings:\n  ${j.parseWarnings.join('\n  ')}`);
}

/** 订阅等待单个 job 落到 paused/终态（paused 也返回：CLI 提示接续而不是干等）。 */
function awaitJob(d, id) {
  return new Promise((done) => {
    const current = d.get(id);
    if (current && (current.state === 'paused' || ['done', 'failed', 'killed', 'interrupted'].includes(current.state))) {
      done(current);
      return;
    }
    let notedRunning = false;
    const un = d.subscribe((ev) => {
      if (ev.type === 'job-updated' && ev.job.id === id) {
        if (ev.job.state === 'running' && !notedRunning) {
          notedRunning = true;
          console.log(`[zcd] job=${id} running…`);
        }
        if (ev.job.state === 'paused' || ['done', 'failed', 'killed', 'interrupted'].includes(ev.job.state)) {
          un();
          done(ev.job);
        }
      }
    });
  });
}

async function cmdDispatch() {
  const kind = opt.kind ?? 'prompt';
  const spec = { kind, lock: opt.lock ?? 'repo' }; // ZB-18 补漏：默认由 'both' 改为 'repo'（memory 已删除，'both' 会报错）
  if (kind === 'task') spec.task = opt.task;
  else if (kind === 'target') spec.target = opt.target;
  else spec.prompt = opt.prompt;
  if (opt.model) spec.model = opt.model;
  if (opt.provider) spec.provider = opt.provider;
  if (opt.mode) spec.mode = opt.mode;
  if (opt.tag) spec.tag = opt.tag;
  if (opt['timeout-min'] != null) spec.timeoutMin = numOf(opt['timeout-min']);
  if (opt.cwd) spec.cwd = opt.cwd;
  if (opt.resume) spec.resume = opt.resume;
  if (boolOf(opt['memory-bench'])) spec.memoryBench = true;

  const d = makeDispatcher();
  let job;
  try {
    job = d.dispatch(spec);
  } catch (e) {
    console.error(`[zcd] dispatch 参数错误: ${e.message}`);
    process.exit(1);
  }
  console.log(`[zcd] job=${job.id} state=${job.state} queuedAt=${job.queuedAt}`);
  if (boolOf(opt['no-wait'])) process.exit(0);

  const j = await awaitJob(d, job.id);
  printSummary(j);
  if (j.state === 'paused') {
    console.log(`[zcd] 已暂停（${j.pauseReason ?? 'unknown'}）：${j.pauseDetail ?? '-'}`);
    console.log(`[zcd] 同通道续跑: zcd retry ${j.id} ；换通道重跑: zcd retry ${j.id} --provider <p> --model <m>`);
    process.exitCode = 2; // paused 专用退出码（非失败：等待用户决定续跑方式）
  } else {
    process.exitCode = j.state === 'done' ? 0 : j.exitCode ?? 1;
  }
}

function cmdList() {
  const d = makeDispatcher();
  const jobs = d.list();
  if (boolOf(opt.json)) {
    console.log(JSON.stringify(jobs, null, 2));
    return;
  }
  console.log(`id              state       tag           model            elapsed  exit lock      session`);
  for (const j of jobs) printJobLine(j);
  console.log(`共 ${jobs.length} 条；work=${d.workRoot}`);
}

function cmdWatch() {
  const d = makeDispatcher();
  const tick = () => {
    const s = d.snapshot();
    const c = s.counts;
    const cur = s.jobs.find((j) => j.state === 'running');
    console.log(
      `[${new Date().toLocaleTimeString('en-GB')}] running=${c.running ?? 0} queued=${c.queued ?? 0} paused=${c.paused ?? 0}` +
        ` done=${c.done ?? 0} failed=${c.failed ?? 0} killed=${c.killed ?? 0} interrupted=${c.interrupted ?? 0}` +
        ` | ${cur ? `now: ${cur.id} ${cur.tag ?? ''} ${fmtSec(cur.elapsedSec)}` : 'idle'}` +
        ` | locks: repo=${s.locks.repo ? s.locks.repo.jobId : '-'} memory=${s.locks.memory ? s.locks.memory.jobId : '-'}`,
    );
  };
  tick();
  const t = setInterval(tick, 1000);
  process.on('SIGINT', () => {
    clearInterval(t);
    console.log('\n[zcd] watch 退出');
    process.exit(0);
  });
}

async function cmdQuota() {
  const ledger = opt.ledger ?? process.env.DSP_LEDGER ?? DEFAULTS.ledger;
  let agg;
  try {
    agg = aggregate({ ledgerPath: ledger });
  } catch (e) {
    agg = { available: false, error: e?.message ?? String(e) }; // local 失败不拖累 planQuota
  }
  // planQuota 自身绝不抛错（内部全兜底），planQuota 失败也不拖累 local
  const pq = await fetchPlanQuota({ timeoutMs: numOf(opt['timeout-ms']) ?? 15000 });
  if (boolOf(opt.json)) {
    // 既有顶层字段原样保留（改/删不行），新增 local（=aggregate 结果）与 planQuota（=fetchPlanQuota 结果）两段
    console.log(JSON.stringify({ ...agg, local: agg, planQuota: pq }, null, 2));
    return;
  }
  const row = (name, w) =>
    console.log(
      `${name.padEnd(8)} runs=${String(w.runs).padStart(4)} requests=${String(w.requests).padStart(4)}` +
        ` in=${String(w.inputTokens).padStart(9)} out=${String(w.outputTokens).padStart(8)}` +
        ` cacheRead=${String(w.cacheReadTokens).padStart(9)} total=${String(w.totalTokens).padStart(9)}` +
        ` elapsed=${Math.round(w.elapsedSec)}s`,
    );
  if (agg.windows) {
    console.log(`ledger=${agg.ledgerPath} available=${agg.available} skippedLines=${agg.skippedLines}`);
    row('last5h', agg.windows.last5h);
    row('week', agg.windows.week);
    row('today', agg.windows.today);
    row('total', agg.windows.total);
    for (const [m, w] of Object.entries(agg.byModel)) {
      console.log(`  model ${m}: runs=${w.runs} in=${w.inputTokens} out=${w.outputTokens} cacheRead=${w.cacheReadTokens}`);
    }
    for (const [b, w] of Object.entries(agg.byBilling)) {
      console.log(`  billing ${b}: runs=${w.runs} in=${w.inputTokens} out=${w.outputTokens}`);
    }
  } else {
    console.log(`local: 不可用（${agg.error}）`);
  }
  const wk = Array.isArray(pq.windows) ? pq.windows.find((x) => x && x.id === 'week') : null;
  console.log(
    pq.available
      ? `planQuota: available=true plan=${pq.plan} source=${pq.source}` +
          ` week.used=${wk && wk.used != null ? wk.used : '-'}` +
          `（引擎本地库合计，非套餐已用；limit/remaining 不在 CLI RPC 面）`
      : `planQuota: available=false reason=${pq.reason}`,
  );
}

async function cmdPlanQuota() {
  // 真实套餐额度：起 ZCode app-server 查 usage/stats（≤timeout-ms，收尾必杀进程树）。
  const pq = await fetchPlanQuota({
    planKey: opt.plan,
    timeoutMs: numOf(opt['timeout-ms']) ?? 15000,
    timeZone: opt.tz,
  });
  if (boolOf(opt.json)) {
    console.log(JSON.stringify(pq, null, 2));
    return;
  }
  if (!pq.available) {
    console.log(`planQuota: available=false reason=${pq.reason}`);
    return;
  }
  console.log(`plan=${pq.plan} source=${pq.source} generatedAt=${pq.generatedAt}`);
  for (const w of pq.windows) {
    console.log(
      `${w.id.padEnd(5)} used=${w.used ?? '-'} limit=${w.limit ?? '-'} remaining=${w.remaining ?? '-'}` +
        ` percent=${w.percentUsed ?? '-'} resetAt=${w.resetAt ?? '-'} mapped=${w.mapped}` +
        (w.usedSince != null ? ` since=${w.usedSince}` : ''),
    );
    if (w.note) console.log(`      note: ${w.note}`);
  }
}

function cmdKill() {
  const id = pos[1];
  if (!id) {
    console.error('[zcd] 用法: kill <id>');
    process.exit(1);
  }
  const d = makeDispatcher();
  const ok = d.kill(id);
  const j = d.get(id);
  if (!ok) {
    console.error(`[zcd] kill 失败：${j ? `job 已是 ${j.state}` : `找不到 ${id}`}`);
    process.exit(1);
  }
  console.log(`[zcd] kill 已请求：job=${id} state=${j.state}`);
}

function cmdTail() {
  const id = pos[1];
  if (!id) {
    console.error('[zcd] 用法: tail <id> [-n 50]');
    process.exit(1);
  }
  const d = makeDispatcher();
  const lines = d.tail(id, numOf(opt.n) ?? 50);
  if (lines == null) {
    console.error(`[zcd] 找不到 job: ${id}`);
    process.exit(1);
  }
  for (const l of lines) console.log(l);
}

async function cmdChannels() {
  const d = makeDispatcher();
  const { channels, warnings } = await d.listChannels();
  for (const w of warnings) console.error(`[zcd] warning: ${w}`);
  if (boolOf(opt.json)) {
    console.log(JSON.stringify({ channels, warnings }, null, 2));
    return;
  }
  if (channels.length === 0) {
    console.error('[zcd] 通道清单为空（解析失败，不猜测）');
    process.exitCode = 1;
    return;
  }
  console.log('id                             enabled  endpoint                       models / 原因');
  for (const c of channels) {
    const line =
      `${c.id.padEnd(30)} ${String(c.enabled).padEnd(8)} ${String(c.endpoint ?? '-').padEnd(30)} ` +
      `${(c.models ?? []).join(', ') || '-'}${c.reason ? ` (${c.reason})` : ''}`;
    console.log(line + (c.aliasOf ? `  [plan→${c.aliasOf}]` : ''));
  }
  const cur = d.getChannel();
  console.log(`\n默认通道: ${cur.provider}${cur.model ? ` / ${cur.model}` : ''}（channel set 可改）`);
}

async function cmdChannel() {
  const d = makeDispatcher();
  const sub = pos[1];
  if (sub === 'set') {
    const provider = pos[2];
    if (!provider) {
      console.error('[zcd] 用法: channel set <provider> [--model <m>]   （provider 见 channels）');
      process.exit(1);
    }
    const ch = d.setChannel({ provider, model: opt.model ?? null });
    console.log(`[zcd] 默认通道已设为 ${ch.provider}${ch.model ? ` / ${ch.model}` : ' /（通道默认模型）'}`);
    const { channels } = await d.listChannels();
    const known = channels.find((c) => c.id === provider);
    if (!known) {
      console.error(`[zcd] 注意：${provider} 不在通道清单里（清单解析失败或 id 拼写有误），派发时 runner 可能拒绝`);
    } else if (!known.enabled) {
      console.error(`[zcd] 注意：${provider} 当前不可用（${known.reason ?? '未知原因'}），派发会如实失败`);
    }
    return;
  }
  if (sub != null) {
    console.error('[zcd] 用法: channel | channel set <provider> [--model <m>]');
    process.exit(1);
  }
  const cur = d.getChannel();
  console.log(`默认通道: ${cur.provider}${cur.model ? ` / ${cur.model}` : ' /（通道默认模型）'}`);
}

async function cmdRetry() {
  const id = pos[1];
  if (!id) {
    console.error('[zcd] 用法: retry <jobId> [--provider <p>] [--model <m>]');
    process.exit(1);
  }
  const d = makeDispatcher();
  const prev = d.get(id);
  if (!prev) {
    console.error(`[zcd] 找不到 job: ${id}`);
    process.exit(1);
  }
  if (prev.state === 'queued' || prev.state === 'running') {
    console.error(`[zcd] job ${id} 仍在 ${prev.state}，不能 retry`);
    process.exit(1);
  }
  let job;
  try {
    job = d.retry(id, { provider: opt.provider, model: opt.model });
  } catch (e) {
    console.error(`[zcd] retry 失败: ${e.message}`);
    process.exit(1);
  }
  const sameChannel = !opt.provider || opt.provider === (prev.spec.provider ?? 'plan');
  console.log(
    sameChannel && prev.sessionId
      ? `[zcd] 同通道续跑 job=${job.id}（--resume ${prev.sessionId}，不带 --model）`
      : `[zcd] 换通道交接重跑 job=${job.id}（新会话 + 交接提示词；换通道=交接重跑，不是原会话续跑）`,
  );
  const j = await awaitJob(d, job.id);
  printSummary(j);
  if (j.state === 'paused') {
    console.log(`[zcd] 已暂停（${j.pauseReason ?? 'unknown'}）：${j.pauseDetail ?? '-'}`);
    process.exitCode = 2;
  } else {
    process.exitCode = j.state === 'done' ? 0 : j.exitCode ?? 1;
  }
}

async function cmdFallback() {
  const d = makeDispatcher();
  const sub = pos[1];
  if (sub === 'set') {
    const csv = pos[2];
    if (!csv) {
      console.error('[zcd] 用法: fallback set <id1,id2,…>（顺序即优先级；也可 set <id> --model <m> --thinking <lv> 设单目标）');
      process.exit(1);
    }
    /* ZB-30：带 --model/--thinking（或只有一个通道 id）⇒ 单目标（与面板开关同形）；
     * 纯逗号列表 ⇒ 多目标（只带通道 id，模型/档位沿用原任务）。 */
    const ids = csv.split(',').map((s) => s.trim()).filter(Boolean);
    const one = ids.length === 1 && (opt.model != null || opt.thinking != null || opt.reasoningLevel != null);
    const fb = one
      ? d.setFallbackTarget({ provider: ids[0], model: opt.model ?? null, reasoningLevel: opt.thinking ?? opt.reasoningLevel ?? null })
      : d.setFallbackChain(ids);
    console.log(`[zcd] 自动降级已开启: ${fb.targets.map((t) => `${t.provider}${t.model ? `/${t.model}` : ''}${t.reasoningLevel ? `@${t.reasoningLevel}` : ''}`).join(' → ')}`);
    console.log('[zcd] 注意：额度耗尽/未开通/需签名时会自动交接重跑到下一个可用目标，会自动消耗下游通道额度');
    return;
  }
  if (sub === 'off') {
    d.setFallbackChain([]);
    console.log('[zcd] 自动降级已关闭');
    return;
  }
  if (sub != null && sub !== 'list') {
    console.error('[zcd] 用法: fallback [list|set a,b,c|set <id> --model <m> --thinking <lv>|off]');
    process.exit(1);
  }
  const fb = d.getFallbackChain();
  console.log(fb.enabled
    ? `自动降级: ${fb.targets.map((t) => `${t.provider}${t.model ? `/${t.model}` : ''}${t.reasoningLevel ? `@${t.reasoningLevel}` : ''}`).join(' → ')}`
    : '自动降级: 关（fallback set a,b,c 开启）');
}

const commands = { help: usage, list: cmdList, dispatch: cmdDispatch, watch: cmdWatch, quota: cmdQuota, 'plan-quota': cmdPlanQuota, kill: cmdKill, tail: cmdTail, channels: cmdChannels, channel: cmdChannel, retry: cmdRetry, fallback: cmdFallback };
if (opt.help || !commands[cmd]) usage(commands[cmd] ? 0 : 1);
commands[cmd]();
