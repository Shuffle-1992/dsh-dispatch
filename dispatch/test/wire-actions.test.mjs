/**
 * 审计 C 补强 · A：**wire action 层的行为测试**（P0 盲区）。
 *
 * 背景（审计 C 结论）：`createActionHandler` 是 agent 工具与 Remote 面板/CLI 的**唯一实现点**
 * （wire.host.mjs:502），但既有测试只真调用过 `dispatch/list/fallback/channel/wait/kill`；
 * `tail/status/channels/quota/switch/dismiss/retry` **只有源码文本断言或干脆没有** ——
 * 分支写错（tail 截断、dismiss 写盘、switch 门禁）测不出来。本文件把它们补成行为断言。
 *
 * 纪律：
 *   · 只断言**行为与返回字段**，不做任何源码文本匹配；
 *   · 每例一个临时 workRoot / switchPath / ledgerPath（`mkdtempSync`），绝不碰仓库 `.data/`；
 *   · 真 job 一律等落地再离场（core 的 persist 是异步写盘，未落地就删目录会抛 ENOENT
 *     → uncaughtException → 进程退出码 1，见 wire-engine.test.mjs:36 的事故注释）；
 *   · 只有一个测试需要真 job：tail/dismiss/门禁（用 `fixtures/fake-runner.mjs`，零网络零额度）。
 *
 * 跑法：node dispatch/test/wire-actions.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../core/dispatch-core.mjs';
import {
  createActionHandler, quotaWindows, LIST_LIMIT_DEFAULT, SWITCH_OFF_ERROR, TAIL_DEFAULT_LINES,
} from '../wire.host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs');

let pass = 0;
const fail = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const eq = (a, b, m) => ok(Object.is(a, b), `${m}（实际 ${JSON.stringify(a)}）`);
const deq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}（实际 ${JSON.stringify(a)}）`);
const has = (s, sub, m) => ok(typeof s === 'string' && s.includes(sub), `${m}（实际 ${JSON.stringify(s)}）`);
/** 深查 undefined 字段：undefined 在 JSON 传输里会**静默消失**，必须显式发现。 */
const firstUndef = (v, p = '$') => {
  if (v === undefined) return p;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i += 1) { const x = firstUndef(v[i], `${p}[${i}]`); if (x) return x; } return null; }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) { const x = firstUndef(v[k], `${p}.${k}`); if (x) return x; } return null; }
  return null;
};

const tempDirs = [];
const live = []; // 需要收尾的 dispatcher
const newDir = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tempDirs.push(d); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'failed', 'killed', 'interrupted'];
const SETTLED = new Set([...TERMINAL, 'paused']);

function mkApi({ workRoot = newDir('dsp-wa-'), switchPath, ledgerPath, config = {} } = {}) {
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot, maxConcurrent: 2 });
  const cfg = { switchPath: switchPath ?? join(workRoot, 'sw.json'), ...(ledgerPath ? { ledgerPath } : {}), ...config };
  live.push({ d });
  return { d, api: createActionHandler(d, cfg), root: workRoot, switchPath: cfg.switchPath };
}
/** 未配置 switchPath 的 handler（复现"profile 没配真值文件路径"）。 */
function mkApiNoSwitch() {
  const workRoot = newDir('dsp-wa-nosw-');
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot, maxConcurrent: 2 });
  live.push({ d });
  return { d, api: createActionHandler(d, {}), root: workRoot };
}
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(20); }
  throw new Error(`waitFor 超时：${what}`);
}
const settle = (d, id, ms = 20000) => waitFor(() => { const j = d.get(id); return j && SETTLED.has(j.state) ? j : null; }, ms, `job ${id} 落地`);
async function dispatchSettled(api, d, params) {
  const r = await api('dispatch', params);
  if (!r.ok) throw new Error(`dispatch 失败：${r.error}`);
  return { r, job: await settle(d, r.job.id) };
}
/** 临时改 env（FAKE_* / DSP_APPSERVER_CLI），跑完原样恢复。 */
async function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) prev[k] = process.env[k];
  const restore = () => { for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } };
  Object.assign(process.env, env);
  try { return await fn(); } finally { restore(); }
}

try {
  /* ═════ ① status：缺失 / 损坏 / 正常 三态（fail-open：读不到就是"开启"） ═════ */
  console.log('① status：真值文件三态（fail-open 语义）');
  {
    const miss = mkApi({ switchPath: join(newDir('dsp-wa-sw1-'), 'sw.json') });
    let r = await miss.api('status', {});
    eq(r.ok, true, 'status 缺文件仍 ok:true');
    eq(r.switch.enabled, true, '缺文件 ⇒ enabled=true（不误锁）');
    has(r.switch.source, 'default', '缺文件 ⇒ source 标明默认值（可核查，不是静默）');

    const brokenPath = join(newDir('dsp-wa-sw2-'), 'broken.json');
    writeFileSync(brokenPath, '{ 这不是 JSON', 'utf8');
    const broken = mkApi({ switchPath: brokenPath });
    r = await broken.api('status', {});
    eq(r.ok, true, '损坏文件仍 ok:true（readSwitch 永不抛）');
    eq(r.switch.enabled, true, '损坏 ⇒ enabled=true（与 CLI 同：不误锁）');
    has(r.switch.source, 'default', '损坏 ⇒ source 也标明默认（与"文件值"可区分）');

    const normalPath = join(newDir('dsp-wa-sw3-'), 'sw.json');
    writeFileSync(normalPath, JSON.stringify({ enabled: false, updatedAt: '2026-10-17T00:00:00.000Z', updatedBy: 'hand', note: 'n1' }), 'utf8');
    const normal = mkApi({ switchPath: normalPath });
    r = await normal.api('status', {});
    eq(r.ok, true, 'status 正常文件 ok:true');
    eq(r.switch.enabled, false, '正常文件 ⇒ 读出 enabled=false');
    eq(r.switch.source, 'file', 'source=file（区别于默认值）');
    eq(r.switch.updatedBy, 'hand', 'updatedBy 透传');
    eq(r.switch.note, 'n1', 'note 透传');
  }

  /* ═════ ② switch：写→读回一致 + 落盘 + 非法参数不改状态 + 未配置路径拒绝 ═════ */
  console.log('\n② switch：写入 / 读回 / 落盘 / 非法参数 / 未配置路径');
  {
    const { api, switchPath, root } = mkApi();
    let r = await api('switch', { enabled: false, by: 'audit', note: 'task-14' });
    eq(r.ok, true, 'switch 写入 ok:true');
    eq(r.switch.enabled, false, '返回值即写入后的真值');
    eq(r.switch.updatedBy, 'audit', 'updatedBy 落盘');
    eq(r.switch.note, 'task-14', 'note 落盘');
    ok(typeof r.switch.updatedAt === 'string' && !Number.isNaN(Date.parse(r.switch.updatedAt)), 'updatedAt 是合法 ISO 时间');
    ok(existsSync(switchPath), '真值文件确实写到 config.switchPath');
    const onDisk = JSON.parse(readFileSync(switchPath, 'utf8'));
    eq(onDisk.enabled, false, '磁盘内容与返回值一致（跨进程契约）');
    ok(typeof onDisk.contract === 'string' && onDisk.contract.length > 0, '文件带契约标记行（与 CLI 共用同一份）');
    eq((await api('status', {})).switch.enabled, false, '写后读回一致（mtime 缓存已正确失效）');
    r = await api('switch', {});
    eq(r.ok, false, '缺 enabled 布尔 ⇒ ok:false');
    has(r.error, '布尔', '报错可读（说明需要什么）');
    eq((await api('status', {})).switch.enabled, false, '非法写不改变既有状态');
    r = await api('switch', { enabled: 'yes' });
    eq(r.ok, false, 'enabled 传字符串 ⇒ 拒绝（不做真假值猜测）');

    const noSw = mkApiNoSwitch();
    r = await noSw.api('switch', { enabled: true });
    eq(r.ok, false, '未配置 switchPath ⇒ 拒绝写入（不写到猜出来的位置）');
    has(r.error, '未配置', '报错可读（指出缺 config.switchPath）');
    eq(r.switch.enabled, true, '拒绝写入后开关仍是"开启"（未配置 ≠ 关闭）');
    /* 被拒时**不许在任何猜测位置**留下开关文件（真值文件路径只有 config 一处来源）。 */
    let stray = [];
    try { stray = readdirSync(noSw.root, { recursive: true }).filter((f) => /switch.*\.json$/i.test(String(f))); } catch { /* 读不到即无 */ }
    deq(stray, [], '被拒时不产生任何开关文件');
  }

  /* ═════ ③ 关闭态门禁：dispatch / retry 被拒且不建 job ═════ */
  console.log('\n③ 关闭态门禁：dispatch / retry 被拒，且不建 job');
  {
    const { api, d } = mkApi();
    await api('switch', { enabled: false, by: 'audit' });
    const before = d.list().length;
    let r = await api('dispatch', { kind: 'prompt', prompt: 'x', tag: 'OFF', timeoutMin: 1 });
    eq(r.ok, false, '关闭态 dispatch 被拒');
    eq(r.error, SWITCH_OFF_ERROR, '用统一错误文案（与 CLI 同源常量）');
    eq(d.list().length, before, '被拒时不建 job（不是"建了再失败"）');
    r = await api('retry', { id: 'j-nope' });
    eq(r.ok, false, '关闭态 retry 也被拒（避免建一个必失败的 job）');
    eq(r.error, SWITCH_OFF_ERROR, 'retry 用同一文案');
    r = await api('switch', { enabled: true, by: 'audit' });
    eq(r.ok, true, '重新开启 ok:true');
    const dis = await api('dispatch', { kind: 'prompt', prompt: 'x', tag: 'ON', timeoutMin: 1 });
    eq(dis.ok, true, '开启后 dispatch 恢复');
    await settle(d, dis.job.id);
  }

  /* ═════ ④ tail：默认行数 / 上限 / 真截断 / 可读报错 ═════ */
  console.log('\n④ tail：默认 30 / 上限 200 / 真截断 / 可读报错');
  {
    const { api, d } = mkApi();
    const { r } = await dispatchSettled(api, d, { kind: 'prompt', prompt: 'tail 输出测试', tag: 'TAIL', timeoutMin: 1 });
    const id = r.job.id;
    const full = await api('tail', { id });
    eq(full.ok, true, 'tail ok:true');
    eq(full.id, id, '原样回 id');
    ok(Array.isArray(full.lines) && full.lines.length > 0, `lines 是非空数组（${full.lines?.length} 行）`);
    ok(full.lines.length <= TAIL_DEFAULT_LINES, `默认不超过 ${TAIL_DEFAULT_LINES} 行`);
    ok(full.lines.some((l) => String(l).includes('[zcode-run]')), '拿到的是 runner 的真实输出行');
    const two = await api('tail', { id, n: 2 });
    eq(two.lines.length, 2, 'n=2 真的只回 2 行（真截断）');
    deq(two.lines, full.lines.slice(-2), '回的是**最后** n 行（不是最前 n 行）');

    /* n 的规整：真 job 造不出 >200 行，故用桩记录 wire 实际下传给 dispatcher 的行数。 */
    const seen = [];
    const spy = createActionHandler({ tail: (jid, n) => { seen.push([jid, n]); return ['L1']; } }, {});
    await spy('tail', { id: 'j1' }); eq(seen.at(-1)[1], TAIL_DEFAULT_LINES, '不传 n ⇒ 下传默认 30');
    await spy('tail', { id: 'j1', n: 99999 }); eq(seen.at(-1)[1], 200, 'n 超上限 ⇒ 夹到 200');
    await spy('tail', { id: 'j1', n: '3' }); eq(seen.at(-1)[1], 3, '数字字符串 n 可用（工具入参常是字符串）');
    await spy('tail', { id: 'j1', n: 0 }); eq(seen.at(-1)[1], TAIL_DEFAULT_LINES, 'n=0 视为未给（不当成"0 行"）');

    let bad = await api('tail', {});
    eq(bad.ok, false, '缺 id ⇒ ok:false');
    has(bad.error, 'id', '报错可读');
    bad = await api('tail', { id: 'j-does-not-exist' });
    eq(bad.ok, false, '不存在的 job ⇒ ok:false（而不是空数组，避免"没输出"与"没这个 job"混淆）');
    has(bad.error, '找不到', '报错可读（含 id 线索）');
  }

  /* ═════ ⑤ dismiss：白名单 + 落盘 + list 过滤 + 跨实例生效 ═════ */
  console.log('\n⑤ dismiss：只对落地 job / 落盘 / list 过滤 / 跨实例');
  {
    const { api, d, root } = mkApi();
    const a = await dispatchSettled(api, d, { kind: 'prompt', prompt: 'a', tag: 'DIS-A', timeoutMin: 1 });
    const b = await dispatchSettled(api, d, { kind: 'prompt', prompt: 'b', tag: 'DIS-B', timeoutMin: 1 });
    const l0 = await api('list', {});
    ok(l0.jobs.some((j) => j.id === a.r.job.id), 'dismiss 前该 job 在列表里');
    let r = await api('dismiss', { id: a.r.job.id });
    eq(r.ok, true, 'dismiss 终态 job ok:true');
    eq(r.id, a.r.job.id, '回 id');
    ok(TERMINAL.includes(r.state), `回 job 状态（${r.state}）`);
    /* 位置由实现规则给出：与 jobs.json **同目录**（真 dispatcher 的 jobsFile 在 <workRoot>/state/ 下）。 */
    const disFile = join(dirname(d.jobsFile), 'dismissed.json');
    ok(existsSync(disFile), `dismissed.json 落盘到 jobs.json 同目录（${dirname(d.jobsFile)}）`);
    const ids = JSON.parse(readFileSync(disFile, 'utf8'));
    ok(Array.isArray(ids) && ids.includes(a.r.job.id), '落盘内容含被 dismiss 的 id');
    const l1 = await api('list', {});
    eq(l1.total, l0.total - 1, 'list 的 total 随之减少');
    ok(!l1.jobs.some((j) => j.id === a.r.job.id), '被 dismiss 的 job 不再出现');
    ok(l1.jobs.some((j) => j.id === b.r.job.id), '其它 job 不受影响（不是清空列表）');
    const api2 = createActionHandler(d, { switchPath: join(root, 'sw.json') });
    const l2 = await api2('list', {});
    ok(!l2.jobs.some((j) => j.id === a.r.job.id), '另一个 handler 实例照样看不到（持久化/共享生效）');

    let runId = null;
    await withEnv({ FAKE_SLEEP_MS: '4000' }, async () => {
      const rr = await api('dispatch', { kind: 'prompt', prompt: 'long', tag: 'DIS-RUN', timeoutMin: 1 });
      eq(rr.ok, true, '长任务已派发（验证白名单用）');
      runId = rr.job.id;
      await waitFor(() => d.get(runId)?.state === 'running', 5000, '长任务进入 running');
      ok(true, '它确实在 running');
      const bad = await api('dismiss', { id: runId });
      eq(bad.ok, false, 'running 的 job 不允许 dismiss（占锁与并发）');
      has(bad.error, 'kill', '报错指向正确做法：先 kill');
      eq(d.get(runId).state, 'running', '被拒后它仍在跑（没有副作用）');
    });
    if (runId) { d.kill(runId, 'test-cleanup'); await settle(d, runId); }

    let bad = await api('dismiss', {});
    eq(bad.ok, false, '缺 id ⇒ ok:false');
    bad = await api('dismiss', { id: 'j-nope' });
    eq(bad.ok, false, '不存在的 job ⇒ ok:false');
    has(bad.error, '不存在', '报错可读');
  }

  /* ═════ ⑥ channels：形状透传 + 缺省数组 + 失败可读（stub dispatcher，零 spawn） ═════ */
  console.log('\n⑥ channels：形状 / warnings 恒为数组 / 撞额度提示 / 失败可读');
  {
    const ledgerPath = join(newDir('dsp-wa-led-'), 'ledger.jsonl');
    writeFileSync(ledgerPath, [
      JSON.stringify({ at: new Date().toISOString(), provider: 'plan:test-plan', rateLimited: true, retryAfterSec: 60 }),
      JSON.stringify({ at: new Date(Date.now() - 6 * 3600 * 1000).toISOString(), provider: 'plan:old-plan', rateLimited: true }),
    ].join('\n') + '\n', 'utf8');
    const fixtures = {
      channels: [
        { id: 'plan', name: 'Plan', enabled: true, engine: 'zcode' },
        { id: 'account:bigmodel-start-plan', name: 'Start Plan', enabled: true, engine: 'zcode' },
        { id: 'opencode/deepseek-v4.1-flash-free', name: 'OC', enabled: true, engine: 'opencode' },
      ],
      warnings: ['probe-warn'],
      engines: { zcode: { ok: true }, opencode: { ok: true } },
      engineDetail: [{ engine: 'zcode', form: 'client-bundled-cli', version: '1.2.3' }],
      opencodeVersion: '9.9.9',
    };
    const api = createActionHandler({ listChannels: async () => fixtures }, { ledgerPath });
    let r = await api('channels', {});
    eq(r.ok, true, 'channels ok:true');
    eq(r.channels.length, 3, 'channels 全量透传');
    eq(r.channels[0].id, 'plan', '顺序稳定（第一条仍是 plan）');
    eq(r.channels[0].enabled, true, '撞过额度的通道 enabled **不被改写**（只做提示，不擅自改可用性）');
    ok(r.channels[0].recentQuotaExhausted && typeof r.channels[0].recentQuotaExhausted.at === 'string', '近期 429 的通道带 recentQuotaExhausted（ZB-37）');
    has(r.channels[0].quotaNote, '优先改用其它通道', '并给出可读建议（含 retry-after）');
    ok(!r.channels[1].recentQuotaExhausted, '未命中的通道不打标');
    deq(r.warnings, ['probe-warn'], 'warnings 透传');
    eq(r.engines.zcode.ok, true, 'engines 透传');
    eq(r.engineDetail[0].form, 'client-bundled-cli', '★ engineDetail 透传（ZB-51 曾只在面板路径透传，工具路径漏了）');
    eq(r.opencodeVersion, '9.9.9', 'opencodeVersion 透传');
    deq(Object.keys(r.recentQuotaExhausted ?? {}), ['test-plan'], '近 5h 窗口过滤生效（6h 前那条不计入）');
    ok(r.giftQuota && typeof r.giftQuota === 'object', 'giftQuota 恒在（读不到也是对象/原因）');
    const gift = r.channels.find((c) => String(c.id).startsWith('account:'));
    ok(('quota' in gift && 'quotaText' in gift) || 'giftQuotaUnavailable' in gift,
      'start-plan 通道要么带 quota/quotaText，要么如实标注不可用（fail-open，不编数字）');

    const apiMin = createActionHandler({ listChannels: async () => ({}) }, {});
    r = await apiMin('channels', {});
    eq(r.ok, true, '最小形状（{}）不抛');
    deq(r.channels, [], 'channels 缺省为 []（不是 undefined）');
    deq(r.warnings, [], 'warnings 缺省为 []（调用方可无条件遍历）');

    const apiErr = createActionHandler({ listChannels: async () => { throw new Error('探测失败：找不到 CLI'); } }, {});
    r = await apiErr('channels', {});
    eq(r.ok, false, 'listChannels 抛错 ⇒ ok:false（不把异常漏给调用方）');
    has(r.error, '探测失败', '报错保留原始原因');
  }

  /* ═════ ⑦ quota：台账字段稳定 + 计划额度失败可读（密封：DSP_APPSERVER_CLI 指向不存在路径） ═════ */
  console.log('\n⑦ quota：台账字段稳定 + 计划额度探测失败可读');
  {
    const q1 = quotaWindows(undefined);
    eq(q1.available, false, '无 ledgerPath ⇒ available:false（不抛）');
    has(String(q1.reason), '未配置', '给出原因');
    eq(q1.windows, null, 'windows 为 null（调用方需先判 available）');

    const emptyPath = join(newDir('dsp-wa-q1-'), 'empty.jsonl');
    writeFileSync(emptyPath, '', 'utf8');
    const q2 = quotaWindows(emptyPath);
    ok(typeof q2.available === 'boolean', '空台账仍返回结构（available 布尔，不抛）');
    if (q2.available) {
      for (const k of ['last5h', 'week', 'today']) ok(q2.windows && typeof q2.windows[k] === 'object', `windows.${k} 恒在`);
      const fields = ['runs', 'requests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'totalTokens'];
      ok(fields.every((k) => k in q2.windows.today), '窗口字段集稳定（六个数字字段）');
    } else {
      ok(true, '空台账 ⇒ available:false（跳过窗口字段断言）');
      ok(true, '（同上）');
    }

    const ledger = join(newDir('dsp-wa-q2-'), 'l.jsonl');
    writeFileSync(ledger, `${JSON.stringify({ at: new Date().toISOString(), provider: 'plan:x', requests: 1, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, rateLimited: false })}\n`, 'utf8');
    const q3 = quotaWindows(ledger);
    eq(q3.available, true, '有台账 ⇒ available:true');
    eq(q3.windows.today.requests, 1, '台账数字进窗口（requests）');

    await withEnv({ DSP_APPSERVER_CLI: join(newDir('dsp-wa-bogus-'), 'no-such-zcode.cjs') }, async () => {
      const api = createActionHandler({}, { ledgerPath: ledger });
      const r = await api('quota', {});
      eq(r.ok, true, 'quota 动作 ok:true（计划额度探测失败不影响动作成功）');
      eq(r.quota.windows.today.requests, 1, '动作内台账字段与直接调用一致（单一源）');
      eq(r.planQuota.available, false, 'CLI 不存在 ⇒ planQuota.available:false（不抛）');
      ok(typeof r.planQuota.reason === 'string' && r.planQuota.reason.length > 0, '失败带可读 reason');
      ok(r.giftQuota && typeof r.giftQuota === 'object', 'giftQuota 恒在（免费额度独立于计划额度）');
      const u = firstUndef(r);
      eq(u, null, `结果里没有 undefined 字段（undefined 会经 JSON 传输静默消失）${u ? `：${u}` : ''}`);
    });
  }
} finally {
  /* 收尾：先让所有 job 真正落地（core 异步 persist 与 rmSync 赛跑会抛 ENOENT） */
  for (const { d } of live) {
    for (const j of d.list() ?? []) {
      if (!SETTLED.has(j.state)) { try { d.kill(j.id, 'test-teardown'); } catch { /* 已结束 */ } }
    }
  }
  const end = Date.now() + 10000;
  while (Date.now() < end && live.some(({ d }) => (d.list() ?? []).some((j) => !SETTLED.has(j.state)))) await sleep(50);
  await sleep(150);
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄抖动 */ }
  }
}

console.log(`\n===== wire actions（行为）：${pass} PASS / ${fail.length} FAIL =====`);
if (fail.length) { for (const m of fail) console.log(`  ✗ ${m}`); process.exit(1); }
