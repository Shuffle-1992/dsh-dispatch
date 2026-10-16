/**
 * ZCode 用量聚合（纯函数，零依赖）。
 *
 * aggregate({ ledgerPath, now })：读 runner 台账 dispatch-runs.jsonl（每行一个 JSON），
 * 按滚动 5 小时 / 本自然周（周一 00:00 本地时区起）/ 本地当日 / 全部 四个窗口汇总。
 * 台账文件不存在 → 返回零值 + available:false，不抛错；坏行跳过并计入 skippedLines。
 *
 * fetchPlanQuota({ planKey, timeoutMs, ... })：套餐额度适配器（Z3 真实实现）。
 * 经 ZCode app-server 的 `usage/stats` RPC 取引擎本地 agent-db 聚合（零依赖 node:child_process stdio）。
 * Z3 实测结论（证据见 tasks/Z3-delivery.md）：该 RPC 只有日粒度的本地用量（7d/30d/all），
 * **不含**套餐 limit/remaining/resetAt（方法表全枚举 + coding-plan/status 等候选方法实测 -32601；
 * 桌面端套餐数据走签名 HTTP，裸 Key/OAuth 均 401）。因此本适配器给出真实 used（可映射部分），
 * 映射不了的字段置 null 并标 mapped:false，全部细节放 raw。任何异常 → {available:false, reason:'<短因>'}，绝不抛错。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createAppServerClient } from './appserver-rpc.mjs';

const ZERO_WINDOW = () => ({
  runs: 0,
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0, // 约定 = input + output + cacheRead（计费口径如需 in+out 再调整）
  elapsedSec: 0,
});

/** 本地时区的「本周一 00:00」。 */
export function weekStart(now) {
  const d = new Date(now);
  const offset = (d.getDay() + 6) % 7; // 周一=0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset).getTime();
}

/** 本地时区的「今日 00:00」。 */
export function todayStart(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const n0 = (v) => (v == null ? 0 : Number(v) || 0);

function addTo(win, rec) {
  win.runs += 1;
  win.requests += n0(rec.requests);
  win.inputTokens += n0(rec.inputTokens);
  win.outputTokens += n0(rec.outputTokens);
  win.cacheReadTokens += n0(rec.cacheReadTokens);
  win.elapsedSec += n0(rec.elapsedSec);
}

const finalize = (win, sinceIso, untilIso) => ({
  ...win,
  totalTokens: win.inputTokens + win.outputTokens + win.cacheReadTokens,
  since: sinceIso,
  until: untilIso,
});

/**
 * @param {object} p
 * @param {string} p.ledgerPath 台账 dispatch-runs.jsonl 路径
 * @param {Date|number} [p.now] 注入的当前时间（测试用），默认 new Date()
 * @returns {{ available:boolean, generatedAt:string, ledgerPath:string, windows:{last5h,week,today,total}, byModel:Record<string,object>, byBilling:Record<string,object>, skippedLines:number }}
 */
export function aggregate({ ledgerPath, now = new Date() } = {}) {
  if (!ledgerPath) throw new TypeError('aggregate: 需要 ledgerPath');
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const start5h = nowMs - 5 * 60 * 60 * 1000; // 半开区间 (now-5h, now]
  const weekMs = weekStart(nowMs);
  const todayMs = todayStart(nowMs);

  const last5h = ZERO_WINDOW();
  const week = ZERO_WINDOW();
  const today = ZERO_WINDOW();
  const total = ZERO_WINDOW();
  const byModel = new Map();
  const byBilling = new Map();
  let skippedLines = 0;
  let available = false;

  let text = null;
  try {
    text = readLedger(ledgerPath);
  } catch {
    text = null; // 文件不存在/不可读：零值 + available:false
  }
  if (text != null) {
    available = true;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue; // 空行不算坏行
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        skippedLines += 1;
        continue;
      }
      if (!rec || typeof rec !== 'object') {
        skippedLines += 1;
        continue;
      }
      const ts = Date.parse(rec.at);
      if (!Number.isFinite(ts)) {
        skippedLines += 1;
        continue;
      }

      addTo(total, rec);
      if (ts <= nowMs && ts > start5h) addTo(last5h, rec);
      if (ts >= weekMs && ts <= nowMs) addTo(week, rec);
      if (ts >= todayMs && ts <= nowMs) addTo(today, rec);

      const mk = (map, key) => {
        const k = key || '<unknown>';
        if (!map.has(k)) map.set(k, ZERO_WINDOW());
        addTo(map.get(k), rec);
      };
      mk(byModel, rec.model);
      mk(byBilling, rec.billing);
    }
  }

  return {
    available,
    generatedAt: nowDate.toISOString(),
    ledgerPath,
    windows: {
      last5h: finalize(last5h, new Date(start5h).toISOString(), nowDate.toISOString()),
      week: finalize(week, new Date(weekMs).toISOString(), nowDate.toISOString()),
      today: finalize(today, new Date(todayMs).toISOString(), nowDate.toISOString()),
      total: finalize(total, null, nowDate.toISOString()),
    },
    byModel: Object.fromEntries([...byModel.entries()].sort(([a], [b]) => a.localeCompare(b))),
    byBilling: Object.fromEntries([...byBilling.entries()].sort(([a], [b]) => a.localeCompare(b))),
    skippedLines,
  };
}

// 独立小函数便于 aggregate 保持同步纯函数语义（读文件失败抛给调用方兜底）
function readLedger(p) {
  if (!existsSync(p)) throw new Error('ledger not found');
  return readFileSync(p, 'utf8');
}

/* ---------- fetchPlanQuota：app-server usage/stats 适配（Z3） ---------- */

const PLAN_DEFAULT = 'bigmodel-coding-plan';
const WEEKDAY_SHORT = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 目标时区的 {ymd:'YYYY-MM-DD', weekday:0..6}（Intl en-CA 保证 ymd 序）。 */
function tzParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { ymd: `${get('year')}-${get('month')}-${get('day')}`, weekday: WEEKDAY_SHORT[get('weekday')] ?? 0 };
}

/** 目标时区「本周一」的 ymd。锚点取 UTC 正午再经 Intl 还原，避免负偏移时区把日期推前一天。 */
function mondayYmdInTz(ms, timeZone) {
  const { ymd, weekday } = tzParts(ms, timeZone);
  const [y, m, d] = ymd.split('-').map(Number);
  const back = (weekday + 6) % 7; // 周一=0
  return tzParts(Date.UTC(y, m - 1, d - back, 12), timeZone).ymd;
}

function resolvedTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 把内部错误压成短因（task 契约：reason 为短字符串）。 */
function shortReason(e) {
  const msg = String(e?.message || e);
  if (msg.startsWith('timeout')) return 'timeout';
  if (msg.startsWith('spawn-failed')) return 'spawn-failed';
  if (msg.startsWith('app-server-exited')) return 'app-server-exited';
  if (msg.startsWith('client-closed')) return 'client-closed';
  if (msg.startsWith('stdin-write-failed')) return 'stdin-write-failed';
  const m = /rpc-error (-?\d+)/.exec(msg);
  if (m) return `rpc-error:${m[1]}`;
  return 'error';
}

const PLAN_RPC_NOTE =
  '套餐 limit/remaining/resetAt 不在本引擎 RPC 面（方法表全枚举 + coding-plan/status 等候选实测 -32601，2026-09-30）；桌面端走签名 HTTP，裸 Key/OAuth 均 401';

/**
 * 套餐额度适配器（Z3 真实实现）：经 ZCode app-server `usage/stats` RPC 返回统一形状。
 * available:true 时 windows 为 [{id:'5h',…},{id:'week',…}]：能映射的字段给真实数字，
 * 映射不了的字段为 null 且 mapped:false，原文裁剪后放 raw（heatmap/tools 剔除防膨胀）。
 * 任何异常（spawn/超时/进程退出/坏响应）→ {available:false, reason:'<短因>'}，绝不抛错。
 *
 * @param {object} [opts]
 * @param {string} [opts.planKey] 套餐 provider 键，缺省 'bigmodel-coding-plan'
 * @param {number} [opts.timeoutMs=5000] 单次 RPC 超时毫秒（spawn + 调用共用电此上限）
 * @param {string} [opts.cliPath] zcode.cjs 路径（默认本机安装路径，env DSP_APPSERVER_CLI 可覆盖）
 * @param {object} [opts.env] 追加子进程环境变量
 * @param {Function} [opts.spawnImpl] 测试注入（同 node spawn 签名）
 * @param {object} [opts.client] 测试注入：已建好的 app-server 客户端（注入方负责 close）
 * @param {string} [opts.timeZone] IANA 时区（缺省本机时区；日桶与周界按此时区对齐）
 * @returns {Promise<{available:false, reason:string}
 *   | {available:true, plan:string, source:'app-server:usage/stats', generatedAt:string,
 *      windows:[{id:'5h'|'week', used, limit, remaining, percentUsed, resetAt, mapped:boolean, note?:string}], raw:object}>}
 */
export async function fetchPlanQuota({
  planKey, timeoutMs = 5000, cliPath, env, spawnImpl, client: injectedClient, timeZone,
} = {}) {
  if (timeoutMs != null && !(Number(timeoutMs) > 0)) throw new TypeError('fetchPlanQuota: timeoutMs 必须为正数');
  let client = injectedClient ?? null;
  let owned = false;
  try {
    if (!client) {
      client = await createAppServerClient({ cliPath, env, spawnImpl, timeoutMs });
      owned = true;
    }
    const tz = timeZone || resolvedTimeZone();
    const result = await client.call('usage/stats', { range: 'all', timeZone: tz }, { timeoutMs });
    if (!result || typeof result !== 'object' || !result.summary || !Array.isArray(result.dailyModelUsage)) {
      return { available: false, reason: 'unexpected-usage-stats-shape' };
    }
    const generatedAtMs = Number.isFinite(Number(result.generatedAt)) ? Number(result.generatedAt) : Date.now();
    const todayYmd = tzParts(generatedAtMs, tz).ymd;
    const monday = mondayYmdInTz(generatedAtMs, tz);
    let weekUsed = 0;
    let weekDays = 0;
    for (const day of result.dailyModelUsage) {
      if (!day || typeof day.date !== 'string') continue;
      if (day.date >= monday && day.date <= todayYmd) {
        weekDays += 1;
        for (const m of Array.isArray(day.models) ? day.models : []) weekUsed += Number(m?.totalTokens) || 0;
      }
    }
    return {
      available: true,
      plan: planKey || PLAN_DEFAULT,
      source: 'app-server:usage/stats',
      generatedAt: new Date(generatedAtMs).toISOString(),
      windows: [
        {
          id: '5h', used: null, limit: null, remaining: null, percentUsed: null, resetAt: null, mapped: false,
          note: `usage/stats 仅日粒度聚合（滚动5h不可导出）；${PLAN_RPC_NOTE}`,
        },
        {
          id: 'week', used: weekUsed, usedDays: weekDays, usedSince: monday,
          limit: null, remaining: null, percentUsed: null, resetAt: null, mapped: false,
          note: `used=引擎本地库(${tz})本自然周token合计；${PLAN_RPC_NOTE}`,
        },
      ],
      raw: {
        range: 'all', timeZone: tz, source: result.source, generatedAt: result.generatedAt,
        summary: result.summary, dailyModelUsage: result.dailyModelUsage,
        models: Array.isArray(result.models) ? result.models : [],
      },
    };
  } catch (e) {
    return { available: false, reason: shortReason(e) };
  } finally {
    if (owned) client?.close();
  }
}
