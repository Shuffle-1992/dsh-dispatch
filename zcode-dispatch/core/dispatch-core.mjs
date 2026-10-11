/**
 * ZCode 派发核心（standalone Node，零 npm 依赖，ESM）。
 *
 * 职责：进程调度 / 单写者互斥（文件锁 + 进程内 FIFO 队列）/ 状态与用量采集 / 状态持久化。
 * 与 DSH 完全解耦：既可被 DSH Host 半边 `apply(ctx, config)` import，也可被 bin/zcd.mjs 独立驱动。
 *
 * 驱动的 runner 是只读依赖：`<通用工具仓库>/collab-kit/zcode-run.mjs`，其控制台汇总行
 * 形如 `[zcode-run] done exit=0 elapsed=9.7s session=sess_x provider=plan:x model=M responseChars=N`，
 * 结束后按 tag 回读台账 `zcode-runs.jsonl` 补全字段（stdout 解析与台账取并集，解析失败不崩）。
 *
 * 互斥语义（ZB-16：**删除 memory 锁**，按用户要求）：
 *   spec.lock = 'repo' | 'none'（默认 repo）
 *   · repo ⇒ 仓库写锁。**锁什么由 spec.write 决定**：声明了文件集 ⇒ 只锁那些文件（不同文件可并发）；
 *            未声明 ⇒ 锁整个仓库（粗粒度，单写者纪律本义）
 *   · none ⇒ 不取锁（调用方明确知道无竞写关系时用）
 *   同一时刻：不同文件集的任务可并发；文件集有交集（或任一为"整仓库"）则串行。
 *
 * 为什么删除 memory 锁：它保护的是 ZCode 自己的记忆库（~/.zcode），与仓库写入互不相干；
 * 而 ZCode 记忆写入本身改用**默认注入的提示词禁令**约束（见 buildSpecPrompt），
 * 不再需要一把进程间互斥锁（用户决定：派发任务默认要求子代理不写 ZCode 记忆）。
 *   同一时刻至多一个 run 持有整仓库锁（repo.lock）；文件锁按文件集判定，不同文件集可并发；
 *   请求拿不到锁时进队列等待，**文件锁任务优先放行**（ZB-17），同类内保持 FIFO，不报错。
 *   锁 = 文件锁（跨进程互斥，内容含 jobId/pid/at；过期 >2h 或 pid 已死即清理）
 *      + 进程内队列（同进程公平排队）双保险。
 *
 * 暂停与通道（Z6）：runner 非 0 退出时按输出签名识别暂停原因（quota-exhausted /
 *   plan-not-entitled / provider-signing / config-error），命中即落 `paused` 态——
 *   paused 不占锁、不占并发、不自动重试；未命中签名保持 `failed`（Z1 语义不变），
 *   仅记 pauseReason:'unknown' 作信息字段。
 * 排队可观测（ZB-28）：queued job 在 list/get/snapshot 里带 lockWait —— 被谁挡住
 *   （blockers：锁名/持有者/已运行秒/剩余上界）、前方同类几个（ahead/position）、
 *   预计等待上界（estWaitSec，仅当阻塞者都声明 timeoutMin 时可估，否则 null 不猜）。
 * 超时与禁令字段（ZB-28）：timedOutBy='runner'（--timeout-min 到点 exit 124 → failed）
 *   | 'watchdog'（看门狗 kill → killed）；pausedAt=进入 paused 的时刻；
 *   watchdogSec=看门狗开火秒数；memoryBanRunner=runner 确认已注入记忆禁令
 *   （task 经 runner --memory-ban 旗标，prompt/target 由插件直接拼进内容）。
 * 续跑语义（机制事实 F1/F2：--resume 可不带 --model；--resume+--model 必失败）：
 *   retry(jobId)：同通道且有 sessionId → --resume 续跑，绝不传 --model；
 *   换通道（或无 sessionId）→ 交接重跑：新会话 + buildHandoffPrompt 五要素提示词，
 *   新 job 记 parentJobId/attempts/hopCount，旧 job 标 handedOffTo（同通道续跑标 resumedBy）。
 * 通道：getChannel/setChannel 持久化于 <workRoot>/state/channel.json，dispatch 未显式
 *   指定 provider/model 时采用默认通道；listChannels 解析 runner `--list-providers`
 *   真实输出 + coding-plan-cache.json + 个人 provider 配置，解析不出就返回空数组 +
 *   warnings，绝不猜测通道可用性。
 * 自动降级链（默认关）：setFallbackChain([...]) 后，paused 且原因属
 *   {quota-exhausted, plan-not-entitled, provider-signing} 时自动按 retry 交接语义
 *   跳到链上下一个可用通道，最多 chain.length 跳；链耗尽/一跳失败即停在 paused。
 * 自动降级目标（ZB-30，面板入口）：状态是**有序目标列表** [{provider, model, reasoningLevel}]——
 *   setFallbackTarget({provider, model, reasoningLevel}) 设单个（面板：通道+模型+思考强度，
 *   开启时下面三个下拉与「通道」分区同形），setFallbackTarget(null) = 关闭；
 *   旧入口 setFallbackChain([ids]) 归一成同形列表（model/reasoningLevel=null ⇒ 沿用原任务）。
 *   两者写**同一份状态**（<workRoot>/state/fallback.json，version 2；旧 version 1 的 chain 自动迁移）。
 *   getFallbackChain() 返回 {enabled, chain(旧形状 id 列表), targets, target(首项)}。
 *
 * 测试注入：env `ZCD_FAKE_RUNNER` 覆盖 runner 路径；`options.spawnImpl` 替换 spawn；
 *   `options.now` 注入时钟（返回 ms 数值或 Date 的函数）；
 *   `options.channelsProbeImpl` 替换 `--list-providers` 探测（返回 stdout 文本）；
 *   `options.channelsImpl` 整体替换 listChannels（降级链测试注入通道可用性）；
 *   `options.zcodeConfigPath / planCachePath / personalProviderPath` 覆盖通道相关文件路径。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto'; // ZB-08：createHash 供文件锁路径哈希用

const LOCK_STALE_MS = 2 * 60 * 60 * 1000; // 锁过期阈值：2h（任务包规定）
const LOCK_ACQUIRE_RETRIES = 5;
const TAIL_CAP = 200; // 内存 tailLines 上限
const JOBS_FILE_CAP = 1000; // jobs.json 持久化条数上限（防无限增长）
const RENAME_RETRIES = 4;

/* ---------------- [zcode-run] 汇总行解析（格式以 runner 源码为准） ---------------- */
const RES = {
  start: /^\[zcode-run\] tag=(\S+) mode=(\S+) cwd=(.+)$/,
  provider: /^\[zcode-run\] provider=(\S+)(?: model=(\S+)| models=(\S+))?(?: \((.+)\))?$/,
  resume: /^\[zcode-run\] resume=(\S+)$/,
  // done exit=0 (超时)? elapsed=9.7s session=…? provider=…? model=…? responseChars=…?（除 exit/elapsed 外均可选）
  done: /^\[zcode-run\] done exit=(\d+)(?: \(超时\))? elapsed=([\d.]+)s(?: session=(\S+))?(?: provider=(\S+))?(?: model=(\S+))?(?: responseChars=(\d+))?\s*$/,
  endpoint: /^\[zcode-run\] endpoint=(\S+)$/,
  usage: /^\[zcode-run\] usage requests=(\d+|-) in=(\d+|-) out=(\d+|-) cacheRead=(\d+|-)\s*$/,
  context: /^\[zcode-run\] context used=(\d+) \((?:[\d.]+)% of (\d+)\) turnCount=(\d+|-)\s*$/,
  // 任务包示例把 out/err/result 写在一行；真实 runner 是三行分开。两种都兼容。
  outCombined: /^\[zcode-run\] out=(.+?) err=(.+?) result=(.+)$/,
  out: /^\[zcode-run\] out=(.+)$/,
  err: /^\[zcode-run\] err=(.+)$/,
  result: /^\[zcode-run\] result=(.+)$/,
  // ZB-28：runner 打印 `memory-ban=on` = 它接受了 --memory-ban 并已注入禁令（job.memoryBanRunner 确认位）
  memoryBan: /^\[zcode-run\] memory-ban=on\b/,
  /* ZB-40：**心跳/进度**（免费额度通道每 10s 一行）—— 让面板能显示"当前在做什么 + 多久没动静"，
   * 而不是只有沉默（真机事故：轮次失败后 runner 死等，外部看像"卡住"）。
   * 例：`[zcode-run] progress stage=waiting-turn elapsed=120s chars=1024 tools=3 lastTool=Write stageAgo=8s session=sess_x` */
  progress: /^\[zcode-run\] progress stage=(\S+) elapsed=(\d+)s chars=(\d+) tools=(\d+)(?: lastTool=(\S+))? stageAgo=(\d+)s(?: session=(\S+))?\s*$/,
};

const num = (s) => (s == null || s === '-' ? null : Number(s));

/* ZB-29：思考强度 —— runner `--list-providers` 的 `[zcode-run] reasoning-levels <model>=<a,b,c>` 行。
 * 取值随模型声明不同（GLM-5 系 disabled|enabled；deepseek-v4 系 disabled|low|high|max），不写死枚举。 */
const REASONING_LEVELS_RE = /^\[zcode-run\] reasoning-levels (\S+?)=(\S+)\s*$/;
/* ZB-29：运行注入确认行（`reasoning-level=<档位> target=<providerId>/<modelId>`，派发时打印一次）。 */
const REASONING_APPLIED_RE = /^\[zcode-run\] reasoning-level=(\S+) target=(\S+)\/(\S+)\s*$/;

/* ---------------- 暂停原因识别（Z6；签名为 DSH 实测的错误输出关键词） ----------------
 * 顺序即优先级：entitlement / signing / config 属精确原因，先于较宽的 quota 组，
 * 防止 quota 组里的宽词（如 balance / 429）抢先用附带提及的行定性。 */
const PAUSE_SIGNATURES = [
  { reason: 'plan-not-entitled', patterns: [/not_entitled/i, /plan-not-entitled/i] },
  { reason: 'provider-signing', patterns: [/ClientRequestSigningV4Error/] },
  { reason: 'config-error', patterns: [/Select a model before continuing/i, /CONFIGURATION_ERROR/] },
  { reason: 'quota-exhausted', patterns: [/quota_exceeded/i, /coding_plan_required/i, /rate_limited/i, /insufficient/i, /\b429\b/, /balance/i] },
];
/** 自动降级链只接这三种「换通道可能有意义」的暂停；config-error 属参数错误，unknown 不自动动。 */
const AUTO_FALLBACK_REASONS = new Set(['quota-exhausted', 'plan-not-entitled', 'provider-signing']);

/**
 * 从 runner 输出行里识别暂停原因。命中签名 → {reason, detail}（detail=命中的原文一行）；
 * 有输出但没命中 → {reason:'unknown', detail=最后一条非空行}（调用方保持 failed）；
 * 完全无输出（如 spawn 失败）→ null。
 */
export function classifyPause(lines) {
  const rows = (lines ?? []).filter((l) => typeof l === 'string' && l.trim());
  for (const line of rows) {
    for (const sig of PAUSE_SIGNATURES) {
      if (sig.patterns.some((re) => re.test(line))) {
        return { reason: sig.reason, detail: line.trim().slice(0, 300) };
      }
    }
  }
  if (rows.length === 0) return null;
  return { reason: 'unknown', detail: rows[rows.length - 1].trim().slice(0, 300) };
}

/* ---------------- `--list-providers` 表格解析（Z6） ----------------
 * runner 的表行：`${id.padEnd(34)}${enabled}` + padEnd(10) + `${baseURL} | ${models}${(reason)?}`。
 * 注意 id 达 34+ 字符（UUID）时两列粘连（如 `…daedafalse`），所以不能用空白切列，
 * 必须用「最短前缀 + true/false + 空白」定位 enabled 列。解析不出任何行 → 空结果 + warnings，
 * 绝不猜测。 */
const LIST_ROW_RE = /^(.+?)(true|false)\s+(\S+)\s+\|\s+(.+)$/;

/** 解析 `--list-providers` 输出 → {rows:[{id,enabled,reason,endpoint,models}], modelLevels:{modelId:[levels]}, warnings}。 */
export function parseProviderTable(text) {
  const warnings = [];
  const rows = [];
  const modelLevels = {};
  if (text == null || !String(text).trim()) {
    return { rows, modelLevels, warnings: ['list-providers 输出为空'] };
  }
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    /* ZB-29：思考强度档位行（runner 探测内置配置 modelRules 得出，随模型声明不同）。 */
    const lvl = REASONING_LEVELS_RE.exec(line);
    if (lvl) {
      modelLevels[lvl[1]] = lvl[2].split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }
    const m = LIST_ROW_RE.exec(line);
    if (!m) continue;
    const id = m[1].trim();
    if (!id || /\s/.test(id)) {
      warnings.push(`list-providers 行解析异常（id 列含空白）：${line.slice(0, 80)}`);
      continue;
    }
    const rest = m[4];
    const withReason = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(rest);
    const modelsPart = (withReason ? withReason[1] : rest).trim();
    const models = modelsPart === '-' ? [] : modelsPart.split(',').map((s) => s.trim()).filter(Boolean);
    rows.push({
      id,
      enabled: m[2] === 'true',
      endpoint: m[3] === '-' ? null : m[3],
      models,
      reason: withReason ? withReason[2] : null,
    });
  }
  if (rows.length === 0) warnings.push('list-providers 输出里没有可识别的 provider 行');
  return { rows, modelLevels, warnings };
}

/** 解析单行，返回字段更新对象；带 [zcode-run] 前缀但识别失败返回 null（调用方记 warning），普通行返回 {}。 */
export function parseRunnerLine(line) {
  let m;
  if ((m = RES.done.exec(line))) {
    /* ZB-28：`(超时)` 标记（runner --timeout-min 到点，exit=124）此前被非捕获组吞掉 ——
     * 「runner 超时的 failed」与「任务真失败的 failed」在 job 上无法区分。现在带出 timedOut。 */
    return {
      exitCode: Number(m[1]), runnerElapsedSec: Number(m[2]), sessionId: m[3] ?? null,
      provider: m[4] ?? null, model: m[5] ?? null, responseChars: num(m[6]),
      authoritative: true, summarySeen: true,
      ...(line.includes('(超时)') ? { timedOut: true } : {}),
    };
  }
  if ((m = RES.usage.exec(line))) {
    return { usage: { requests: num(m[1]), inputTokens: num(m[2]), outputTokens: num(m[3]), cacheReadTokens: num(m[4]) } };
  }
  if ((m = RES.context.exec(line))) {
    return { contextUsed: Number(m[1]), contextWindow: Number(m[2]), turnCount: num(m[3]) };
  }
  if ((m = RES.endpoint.exec(line))) return { endpoint: m[1] };
  if ((m = RES.provider.exec(line))) {
    return { provider: m[1], ...(m[2] ? { model: m[2] } : {}), ...(m[3] ? { models: m[3] } : {}), providerLabel: m[4] ?? null };
  }
  if ((m = RES.start.exec(line))) return { runnerTag: m[1], runnerMode: m[2], runnerCwd: m[3] };
  if ((m = RES.resume.exec(line))) return { resume: m[1] };
  if ((m = RES.memoryBan.exec(line))) return { memoryBanSeen: true }; // ZB-28：runner 确认禁令已注入
  if ((m = RES.progress.exec(line))) {
    /* ZB-40：心跳 → job.progress（面板/工具据此显示"当前工作内容"与"是否可能卡住"） */
    return {
      progress: {
        stage: m[1],
        elapsedSec: Number(m[2]),
        chars: Number(m[3]),
        tools: Number(m[4]),
        lastTool: m[5] ?? null,
        stageAgoSec: Number(m[6]),
        sessionId: m[7] ?? null,
      },
      lastProgressAt: Date.now(),
    };
  }
  if ((m = REASONING_APPLIED_RE.exec(line))) {
    // ZB-29：确认思考强度已写入临时 provider 配置（job 上可观测Applied 值与目标）
    return { reasoningLevelApplied: m[1], reasoningTarget: `${m[2]}/${m[3]}` };
  }
  if (/^\[zcode-run\] cli=(?:.+)$/.test(line) || /^\[zcode-run\] task=(?:.+)$/.test(line)) return {}; // 已知信息行，无需入库
  if ((m = RES.outCombined.exec(line))) return { runnerOut: m[1], runnerErr: m[2], runnerResult: m[3] };
  if ((m = RES.out.exec(line))) return { runnerOut: m[1] };
  if ((m = RES.err.exec(line))) return { runnerErr: m[1] };
  if ((m = RES.result.exec(line))) return { runnerResult: m[1] };
  return line.includes('[zcode-run]') ? null : {};
}

/* ---------------- 文件锁（跨进程互斥；'wx' 独占创建即原子仲裁） ---------------- */
function readLockFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 存在但无权限 = 活着
  }
}

function isStaleLock(rec, file, nowMs) {
  if (!rec) {
    try {
      return nowMs - statSync(file).mtimeMs > LOCK_STALE_MS; // 内容损坏：按文件年龄兜底
    } catch {
      return true;
    }
  }
  const at = Date.parse(rec.at);
  if (Number.isFinite(at) && nowMs - at > LOCK_STALE_MS) return true;
  return !pidAlive(rec.pid);
}

function acquireLockFile(file, info, nowMs) {
  for (let i = 0; i < LOCK_ACQUIRE_RETRIES; i += 1) {
    try {
      const fd = openSync(file, 'wx'); // 独占创建：并发竞争的唯一仲裁点
      try {
        writeSync(fd, JSON.stringify(info));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      const rec = readLockFile(file);
      if (rec && rec.jobId === info.jobId) return true; // 重入幂等
      if (isStaleLock(rec, file, nowMs)) {
        try {
          unlinkSync(file);
        } catch { /* 被别人抢先清理：下一轮 wx 重试 */ }
        continue;
      }
      return false; // 锁被活着的持有者占用
    }
  }
  return false;
}

function releaseLockFile(file, jobId) {
  const rec = readLockFile(file);
  if (rec && rec.jobId !== jobId) return false; // 别人的锁不动
  try {
    unlinkSync(file);
  } catch { /* 已不存在即已释放 */ }
  return true;
}

function sweepStaleLocks(files, nowMs) {
  for (const f of files) {
    if (!existsSync(f)) continue;
    if (isStaleLock(readLockFile(f), f, nowMs())) {
      try {
        unlinkSync(f);
      } catch { /* 竞争失败无妨 */ }
    }
  }
}

/* ---------------- 原子写（临时文件 + rename；Windows EPERM 短重试） ---------------- */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* 不可用则跳过等待 */ }
}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  for (let i = 0; ; i += 1) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= RENAME_RETRIES || (e.code !== 'EPERM' && e.code !== 'EACCES')) {
        try {
          unlinkSync(tmp);
        } catch { /* 尽力清理 */ }
        throw e;
      }
      sleepSync(20 * (i + 1));
    }
  }
}

/* ---------------- 工具 ---------------- */
/* ZB-25：状态集合**只在这里定义一份**，并导出给 wire/notify 复用。
 * 此前 wire.host.mjs（DONE/DISMISSABLE）与 notify.mjs（SETTLE_STATES）各自字面量复制，
 * 4 处定义、已实际漂移过（kill(paused)/paused 是否算「落地」各写一遍）。
 * 本次只加 `export` 关键字，值/语义零改动。 */
export const TERMINAL_STATES = new Set(['done', 'failed', 'killed', 'interrupted']);
/** 「落地」判据 = 终态 + paused（paused 同样需要人决定 retry 续跑还是换通道）。 */
export const SETTLED_STATES = new Set([...TERMINAL_STATES, 'paused']);
const KINDS = new Set(['task', 'prompt', 'target']);
const LOCK_MODES = new Set(['repo', 'none']); // ZB-16：删除 memory；none = 明确不取锁

/* ==================== ZB-08：细粒度文件锁表 ====================
 *
 * 背景（用户观察 + 实测）：单写者锁把**整个进程**锁住，但一个进程 27 分钟里大部分时间在
 * 思考 / 调 API / 读文件，并非一直在写。粗粒度锁让"锁不冲突"的任务也被迫干等 ——
 * 实测 T18（lock=both，27 分钟）期间，只要 repo 与只要 memory 的两个任务全程排队，
 * 三者的 started/finished 首尾相接、无一毫秒重叠。
 *
 * 改造：派发方可**显式声明写入集** `spec.write: string[]`；core 只为这些路径加锁。
 * 冲突判定落到文件级：A 写 a.ts、B 写 b.md ⇒ 可并行；A 与 B 都写 a.ts ⇒ 后者排队。
 *
 * ⚠️ 安全底线（本设计的第一约束）：**未声明 write 的任务，一律锁整个仓库（repo.lock）**。
 * 细粒度是"声明了才生效的可选优化"，绝不是"默认放宽"——否则不声明的任务会失去互斥保护，
 * 多个 ZCode 进程同时改同一个仓库，那正是单写者语义要防的事故。
 *
 * 锁文件命名：绝对路径无法直接做文件名（含冒号、反斜杠），故用 sha256 前 16 位哈希；
 * 锁体里回存原始 paths，供 UI 展示「哪个文件被谁锁着」。
 */
const FILE_LOCK_DIR = 'files'; // <workRoot>/locks/files/

function hashPath(p) {
  return createHash('sha256').update(normalizeForLock(p)).digest('hex').slice(0, 16);
}

/** 归一化：统一分隔符 + 大小写（Windows 文件系统大小写不敏感）+ 去末尾斜杠 + **realpath**。
 *
 * ⚠️ ZB-08 实测修正：初版**只小写了盘符**，没小写路径其余部分 —— 结果
 * `F:\proj\src\a.ts` / `F:\PROJ\SRC\A.TS` / `F:\Proj\Src\a.Ts` 三种写法产出
 * **3 把不同的锁**，三个任务同时写同一个文件（正是细粒度锁要防的事故，探针实测确认）。
 * Windows 上路径整体大小写不敏感，故按平台决定：Windows 整体小写，POSIX 保持原样。
 *
 * ⚠️ ZB-26（审计 B1）再修一层：大小写/分隔符一致**还不够** —— 8.3 短名（`DISPAT~1.MJS`）、
 * junction / symlink、`\\?\` 前缀指向的是**同一个文件**，却产出不同的哈希 ⇒ 同一个文件两把锁，
 * 单写者语义被绕过（审计实测同一文件 distinct lock keys = 2）。
 * 修法：对**最长已存在祖先**做 `realpathSync.native`（不存在的尾段原样拼回，因为锁必须能表达
 * 「将来才创建的文件」—— `test/file-lock.test.mjs` 用的就是不存在的路径）；解析失败退回 resolve。
 * realpath 只在真实文件系统上生效，故对纯字符串路径零副作用。 */
function realpathBestEffort(absPath) {
  try {
    let head = absPath;
    const tail = [];
    // 逐级向上找到第一个真实存在的祖先（最多回溯 8 级，避免病态路径反复 stat）
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(head)) {
        const real = realpathSync.native(head);
        return tail.length ? join(real, ...tail.reverse()) : real;
      }
      const parent = dirname(head);
      if (parent === head) break;
      tail.push(basename(head));
      head = parent;
    }
  } catch { /* 权限/竞态：退回原路径 */ }
  return absPath;
}

function normalizeForLock(p) {
  let s = resolve(String(p));
  s = realpathBestEffort(s).replace(/\\/g, '/');
  // 去末尾斜杠（目录写法统一）
  s = s.replace(/\/+$/, '');
  if (process.platform === 'win32') {
    // Windows：盘符与路径均不区分大小写 ⇒ 整体小写，保证同一文件只对应一把锁
    s = s.toLowerCase();
  } else if (/^[a-zA-Z]:\//.test(s)) {
    // 非 Windows 上出现盘符写法（如 WSL 路径）时至少统一盘符大小写
    s = `${s[0].toLowerCase()}${s.slice(1)}`;
  }
  return s;
}

function fileLockPath(dirLocks, p) {
  return join(dirLocks, FILE_LOCK_DIR, `${hashPath(p)}.lock`);
}

/**
 * 创建派发器。
 * @param {object} options
 *   runnerPath    runner 脚本绝对路径（env ZCD_FAKE_RUNNER 可覆盖，测试注入用）
 *   runnerCwd     子进程工作目录（默认 process.cwd()；spec.cwd 会作为 runner 的 --cwd 传入）
 *   ledgerPath    台账 zcode-runs.jsonl（缺省则跳过台账回读）
 *   workRoot      工作根目录（locks/state/logs 都在它下面）
 *   maxConcurrent 最大并发（默认 3）
 *   repoLockPath  整仓库锁文件路径（默认 <workRoot>/locks/repo.lock）；memory 锁已于 ZB-16 删除
 *   timeoutGraceSec  dispatcher 看门狗在 runner 自身超时之后的宽限秒数（默认 120）
 *   spawnImpl / now  测试注入
 */
export function createDispatcher(options = {}) {
  const runnerPath = process.env.ZCD_FAKE_RUNNER || options.runnerPath;
  if (!runnerPath) throw new TypeError('createDispatcher: 需要 options.runnerPath（或 env ZCD_FAKE_RUNNER）');
  if (!options.workRoot) throw new TypeError('createDispatcher: 需要 options.workRoot');

  const workRoot = resolve(options.workRoot);
  const dirLocks = join(workRoot, 'locks');
  const dirState = join(workRoot, 'state');
  const dirLogs = join(workRoot, 'logs');
  const jobsFile = join(dirState, 'jobs.json');
  const repoLockPath = options.repoLockPath ? resolve(options.repoLockPath) : join(dirLocks, 'repo.lock');
  /* ZB-16：memory 锁已删除（用户要求）。保留只读的 legacy 路径常量，仅用于启动时清理历史遗留的
   * memory.lock 文件 —— 否则升级后那个文件会永远躺在 locks/ 里、且被旧版快照当成"有人持锁"。 */
  const legacyMemoryLockPath = join(dirLocks, 'memory.lock');
  const ledgerPath = options.ledgerPath ? resolve(options.ledgerPath) : null;
  const maxConcurrent = Math.max(1, Number(options.maxConcurrent) || 3);
  const runnerCwd = options.runnerCwd ? resolve(options.runnerCwd) : process.cwd();
  const timeoutGraceMs = Math.max(0, Number(options.timeoutGraceSec ?? 120) * 1000);
  const spawnImpl = options.spawnImpl || nodeSpawn;
  // Z6 通道相关：默认读桌面端 ZCode 配置（只读，绝不写入 $DSH_HOME）；测试可整路径覆盖
  const zcodeConfigPath = options.zcodeConfigPath ? resolve(options.zcodeConfigPath) : join(homedir(), '.zcode', 'v2', 'config.json');
  const planCachePath = options.planCachePath ? resolve(options.planCachePath) : join(homedir(), '.zcode', 'v2', 'coding-plan-cache.json');
  const personalProviderPath = options.personalProviderPath ? resolve(options.personalProviderPath) : join(homedir(), '.zcode', 'v2', 'provider_config.json');
  const channelsProbeImpl = options.channelsProbeImpl ?? null; // async () => '--list-providers' stdout 文本
  const channelsImpl = options.channelsImpl ?? null; // async () => ({channels, warnings})，整体替换
  const nowMs = () => {
    const v = options.now ? options.now() : Date.now();
    return v instanceof Date ? v.getTime() : Number(v);
  };

  for (const d of [dirLocks, dirState, dirLogs]) mkdirSync(d, { recursive: true });
  mkdirSync(join(dirLocks, FILE_LOCK_DIR), { recursive: true }); // ZB-08：细粒度文件锁表落点

  /* ---------- 内存态：job 本体保持纯 JSON；child/watchdog 等不可序列化对象放侧表 ---------- */
  const jobs = new Map(); // id -> job（公开字段，纯 JSON）
  const children = new Map(); // id -> ChildProcess
  const watchdogs = new Map(); // id -> Timeout
  const killRequested = new Set();
  const tails = new Map(); // id -> string[]
  const evicted = new Set(); // 已按容量淘汰的 job id（persist 时不再从磁盘采纳）
  const subscribers = new Set();
  let queue = []; // 等待中的 jobId，FIFO
  let seqCounter = 0;
  // Z6：默认通道与自动降级链（持久化于 workRoot/state，绝不写 $DSH_HOME）
  const channelFile = join(dirState, 'channel.json');
  const fallbackFile = join(dirState, 'fallback.json');
  let channel = { provider: 'plan', model: null, reasoningLevel: 'agent' }; // ZB-29d：通道默认思考强度（'agent'=Agent决定，给派发 Agent 的规定）
  /* ZB-30：自动降级**目标**（有序）。旧形状只是通道 id 列表，新形状每项还带 model/reasoningLevel
   * （面板开启降级后可选模型与思考强度，与「通道」分区同形）。null 字段 = 沿用原任务该维度。 */
  let fallbackTargets = [];

  const isTerminal = (job) => TERMINAL_STATES.has(job.state);
  const nextId = () => `j-${Date.now().toString(36)}-${(seqCounter++).toString(36)}-${randomBytes(2).toString('hex')}`;

  /** 历史记录/外部写入的 job 可能缺数组字段，统一补齐（jobs.json 手改坏也不崩）。 */
  function normalizeJob(j) {
    if (!j || typeof j !== 'object') return j;
    if (!Array.isArray(j.parseWarnings)) j.parseWarnings = [];
    if (!Array.isArray(j.tailLines)) j.tailLines = [];
    if (!Array.isArray(j.attempts)) j.attempts = []; // Z6 交接链（[{jobId,provider,model,reason,at}]）
    if (!j.usage || typeof j.usage !== 'object') {
      j.usage = { requests: null, inputTokens: null, outputTokens: null, cacheReadTokens: null };
    }
    return j;
  }

  function serialize(job) {
    const out = {
      ...job,
      usage: { ...job.usage },
      spec: { ...job.spec },
      tailLines: [...(tails.get(job.id) ?? job.tailLines ?? [])],
      parseWarnings: [...(job.parseWarnings ?? [])],
    };
    if (out.state === 'running' && out.startedAt != null) {
      out.elapsedSec = Number(((nowMs() - Date.parse(out.startedAt)) / 1000).toFixed(3));
    }
    /* ZB-28：排队可观测 —— queued job 附带 lockWait（被谁挡住/前方几个/预计等待），其余状态恒 null。 */
    out.lockWait = out.state === 'queued' ? lockWaitFor(job) : null;
    return out;
  }

  function emit(type, payload) {
    /* ZB-26（审计 B3）：每次 job 状态广播即视为一次更新 —— 在这里统一盖时间戳，
     * 不必去改十几处 emit 调用点；多进程 persist 按 updatedAt 合并时需要它准确反映"谁更新"。 */
    if (type === 'job-updated' && payload && typeof payload === 'object') payload.updatedAt = nowMs();
    const qs = type === 'queue-changed' ? queueSnapshot() : null;
    for (const fn of subscribers) {
      try {
        fn(type === 'queue-changed' ? { type, snapshot: qs } : { type, job: serialize(payload) });
      } catch { /* 订阅者异常不打断派发器与其他订阅者 */ }
    }
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscribe(fn): fn 必须是函数');
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  function queueSnapshot() {
    return {
      workRoot,
      maxConcurrent,
      queued: [...queue],
      running: [...jobs.values()].filter((j) => j.state === 'running').map((j) => j.id),
    };
  }

  /**
   * 原子持久化全部 job。写前采纳磁盘上本进程不认识的记录（缓解多进程共用 workRoot 互相覆盖）；
   * 超容量时淘汰最老的终态 job（内存与文件同步收缩）。
   */
  /**
   * ZB-05：淘汰 job 时删除它**专属**的捕获日志（logs/<id>.{out,err}.log）。
   *
   * 语义自洽（不是新策略）：记录被淘汰后，`tail()` 再也找不到它（上层只会得到"找不到 job"），
   * 这两个文件因此**没有任何读取方** = 纯垃圾。不删则每任务留 2 个文件、永不复用，
   * 是全包唯一无界增长的目录；删除后插件侧日志与 jobs.json 一起被 JOBS_FILE_CAP 封顶。
   * （面板「✕」(dismiss) 只是隐藏、记录仍在，tail 仍可用 ⇒ **不在此删除**。）
   *
   * ⚠️ 安全：`jobs.json` 是**可被手工编辑**的外部输入，`captureOut/captureErr` 属不可信数据，
   * 必须校验目标确实落在 `dirLogs` 内 —— 绝不让淘汰逻辑变成任意路径删除。
   * 任何失败都只是"没删掉"，绝不影响淘汰与写盘本身。
   */
  /**
   * 目标路径是否确实落在 root 目录**内部**（越界 / 目录本身 / 非法输入一律 false）。
   *
   * ZB-26（审计 B4）：抽成公共判定。原先只有**删除**路径做了这道检查，
   * 而 `tail()` 的**读取**路径没有 —— `jobs.json` 是可被手工编辑的外部输入，
   * 把某条 job 的 `captureOut` 指到 `C:\Users\x\.ssh\id_rsa` 就能让面板/agent 工具读到任意文件。
   */
  function isUnder(root, p) {
    if (typeof p !== 'string' || p === '') return false;
    try {
      const rel = relative(root, resolve(p));
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    } catch { return false; }
  }

  /** 允许作为「runner 输出日志」读取的根（全部来自 config，不是 jobs.json 这种不可信输入）。 */
  const allowedLogRoots = (
    Array.isArray(options.allowedLogRoots) && options.allowedLogRoots.length
      ? options.allowedLogRoots
      : [dirLogs, workRoot, runnerCwd]
  ).map((p) => resolve(p));

  function dropCaptureFiles(job) {
    for (const f of [job.captureOut, job.captureErr]) {
      if (typeof f !== 'string' || f === '') continue;
      try {
        if (!isUnder(dirLogs, f)) continue; // 越界或目录本身：拒绝（与 tail 的读取校验同一判定）
        unlinkSync(f);
      } catch { /* 不存在/被占用：忽略 */ }
    }
  }

  function persist() {
    if (existsSync(jobsFile)) {
      try {
        const onDisk = JSON.parse(readFileSync(jobsFile, 'utf8'));
        for (const j of onDisk.jobs ?? []) {
          if (evicted.has(j.id)) continue;
          const mine = jobs.get(j.id);
          if (mine === undefined) { jobs.set(j.id, normalizeJob(j)); continue; }
          /* ZB-26（审计 B3，丢失更新）：原先只采纳「本进程不认识的 id」——
           * 一旦采纳过某条记录，之后盘上更新的版本（别的进程写的终态）就被本进程的旧副本覆盖掉，
           * 即注释自称的"缓解多进程互相覆盖"只覆盖插入、不覆盖更新，缓解不成立。
           * 改为**按 updatedAt 合并**：盘上更新则采纳盘上；两边都没有 updatedAt（旧快照）时保持旧行为（不覆盖）。 */
          const diskAt = Number(j.updatedAt) || 0;
          const mineAt = Number(mine.updatedAt) || 0;
          if (diskAt > mineAt) jobs.set(j.id, normalizeJob(j));
        }
      } catch { /* 损坏的 jobs.json 不阻断本进程写入 */ }
    }
    let all = [...jobs.values()].sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
    if (all.length > JOBS_FILE_CAP) {
      for (const j of all.slice(0, all.length - JOBS_FILE_CAP)) {
        if (!isTerminal(j)) continue; // 只淘汰终态
        /* ZB-26（审计 B3）：只淘汰**本进程拥有**的记录 —— 别进程正在用的记录被本进程删掉，
         * 会连带删掉它的捕获日志（dropCaptureFiles），而对方下一次 persist 又写回来，反复抖动。 */
        if (j.ownerPid != null && j.ownerPid !== process.pid) continue;
        dropCaptureFiles(j); // ZB-05：连它的捕获日志一起回收（否则该目录无界增长）
        jobs.delete(j.id);
        tails.delete(j.id);
        evicted.add(j.id);
      }
      all = [...jobs.values()].sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
    }
    atomicWrite(jobsFile, `${JSON.stringify({ version: 1, savedAt: new Date(nowMs()).toISOString(), jobs: all }, null, 2)}\n`);
  }

  /**
   * 启动恢复：上次残留 running → interrupted（记录原因）；残留 queued 一并终结
   * （重启后原队列上下文已不存在）。
   *
   * ZB-26（审计 B2，真机语义反转）：**不能无条件改写**。`bin/zcd.mjs` 的每个子命令都会构造
   * dispatcher（因而调用本函数），于是 `zcd kill <运行中的 job>` 会先在**本进程内存里**把
   * 那个活 job 改成 interrupted ⇒ `kill()` 立刻 `isTerminal → return false`（运行中的任务无法终止、
   * 进程泄漏），`zcd retry` 的 running 守卫也被绕过 ⇒ 同一任务被重复派发。
   * 判据：落盘时记 `ownerPid`；只有当 ownerPid 已不存在时才认定是残留。
   * 字段缺失（ZB-26 之前的旧快照）= 旧语义，一律按残留终结（保持既有测试与行为）。
   */
  function restore() {
    if (!existsSync(jobsFile)) return [];
    const changed = [];
    try {
      const data = JSON.parse(readFileSync(jobsFile, 'utf8'));
      for (const j of data.jobs ?? []) {
        if (jobs.has(j.id)) continue;
        normalizeJob(j);
        const legacy = j.ownerPid == null;
        const ownerAlive = !legacy && j.ownerPid === process.pid ? true : !legacy && pidAlive(j.ownerPid);
        const stale = legacy || !ownerAlive;
        if (j.state === 'running' && stale) {
          j.state = 'interrupted';
          j.interruptReason = legacy
            ? 'dispatcher restarted while run was in flight'
            : `dispatcher restarted while the owning process (pid ${j.ownerPid}) is gone`;
          j.finishedAt = new Date(nowMs()).toISOString();
          changed.push(j.id);
        } else if (j.state === 'queued' && stale) {
          j.state = 'interrupted';
          j.interruptReason = 'dispatcher restarted before the queued job started';
          j.finishedAt = new Date(nowMs()).toISOString();
          changed.push(j.id);
        }
        jobs.set(j.id, j);
      }
    } catch (e) {
      console.error(`[zcd-core] jobs.json 读取失败，按空状态启动: ${e.message}`);
    }
    return changed;
  }

  /* ---------- 锁与队列 ---------- */
  /* 锁集合的计算（ZB-16：删除 memory 锁；repo 锁的粒度由 write 决定）。
   *
   * 用户要求（本轮的模型重设计）：
   *   · repo 锁要**明确锁哪些文件**，哪个进程锁哪些文件；
   *   · 不同进程锁不同文件、没有竞写关系的，**允许并发执行**；
   *   · 删除 memory 相关（ZCode 记忆写入改由默认注入的提示词禁令约束）。
   *
   * 三档：
   *   · spec.write 非空            ⇒ **只锁这些文件**（不同文件集可并发 —— 这正是用户要的）
   *   · spec.lock === 'none'       ⇒ 不取锁（调用方明确知道无竞写关系）
   *   · 其它（含缺省 'repo'）      ⇒ 锁**整仓库**（粗粒度；单写者纪律本义）
   */
  function locksFor(spec) {
    const decl = normalizeWriteSet(spec && spec.write);
    if (decl.length > 0) {
      return decl.map((p) => ({ name: 'file', path: fileLockPath(dirLocks, p), file: p }));
    }
    if (spec.lock === 'none') return []; // 明确不取锁
    return [{ name: 'repo', path: repoLockPath }]; // 默认（含 spec.lock === 'repo'）：整仓库
  }

  /** 归一化声明的写入集：去空、去重（归一化后）、排序（保证加锁顺序一致 ⇒ 防死锁）。
   *  返回绝对路径数组；非法输入（非数组/空数组）返回 []，调用方据此回退粗粒度锁。 */
  function normalizeWriteSet(write) {
    if (!Array.isArray(write)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of write) {
      if (typeof raw !== 'string') continue;
      const s = raw.trim();
      if (!s) continue;
      const norm = normalizeForLock(s);
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
    }
    // 排序 ⇒ 所有任务对同一组文件的加锁顺序一致，避免 A 等 B、B 等 A 的循环等待
    out.sort();
    return out;
  }

  /** 当前全部文件锁（供 UI 与诊断）。返回 [{file, jobId, tag, at, pid, heldSec}] */
  function listFileLocks() {
    const dir = join(dirLocks, FILE_LOCK_DIR);
    if (!existsSync(dir)) return [];
    const out = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.lock')) continue;
      const f = join(dir, name);
      const rec = readLockFile(f);
      if (!rec) continue;
      const heldSec = Math.max(0, Math.round((nowMs() - (Date.parse(rec.at) || nowMs())) / 1000));
      const owner = jobs.get(rec.jobId);
      out.push({
        file: Array.isArray(rec.paths) && rec.paths[0] ? rec.paths[0] : '(unknown)',
        paths: Array.isArray(rec.paths) ? rec.paths : [],
        jobId: rec.jobId,
        tag: owner ? owner.tag ?? null : null,
        at: rec.at ?? null,
        pid: rec.pid ?? null,
        heldSec,
      });
    }
    return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }

  /** 清理过期的文件锁（与 repo/memory 锁同一套过期判据：2h 或持有进程已死）。 */
  function sweepFileLocks() {
    const dir = join(dirLocks, FILE_LOCK_DIR);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.lock')) continue;
      const f = join(dir, name);
      const rec = readLockFile(f);
      if (rec && isStaleLock(rec, f, nowMs())) {
        try {
          unlinkSync(f);
        } catch { /* 竞争失败无妨，下一轮再清 */ }
      }
    }
  }

  /** 判断某任务此刻能否拿到锁（只判不锁），用于「为什么在排队」的提示。 */
  function lockBlockersFor(spec) {
    const locks = locksFor(spec);
    const blockers = [];
    for (const l of locks) {
      if (!existsSync(l.path)) continue;
      const rec = readLockFile(l.path);
      if (!rec || rec.jobId === spec.__jobId) continue;
      if (isStaleLock(rec, l.path, nowMs())) continue;
      blockers.push(l.name === 'file' ? `file:${l.file}` : l.name);
    }
    /* ZB-16：把跨层级阻塞也算进去，否则"为什么排队"会漏报（用户看面板时会困惑）。 */
    const cross = crossLevelBlocked({ id: spec.__jobId }, locks);
    if (cross) blockers.push(`cross:${cross}`);
    return blockers;
  }

  /* ─────────────── ZB-28：排队可观测（lockWait） ───────────────
   * 用户要求：被整仓锁挡住时不再盲等 —— list/get 直接给出「前面有谁/几个/预计等待」。
   *
   * queued job 的 lockWait 结构（其余状态恒 null）：
   *   position    全局队列位置（1 起）
   *   queuedTotal 当前队列总长
   *   ahead       与自己**同类**（文件锁任务 / 整仓库锁任务，与 pump 放行优先级一致）
   *               且排在前面的任务数（同类内 FIFO，这就是要等的人数）
   *   aheadIds    上述任务的 id（截前 10 个，防长队列撑爆快照）
   *   blockers[]  此刻挡住本任务的锁与持有者：{ lock, holderJobId, holderTag,
   *               holderState, holderElapsedSec, holderTimeoutMin, holderRemainingSec }
   *   estWaitSec  预计等待秒数（**上界**）：仅当每个阻塞者都声明了 timeoutMin 时可估
   *               = max(timeoutMin*60 + 看门狗宽限 − 已运行秒数)；否则 null（不猜）
   *   estWaitNote 中文说明：估计怎么来的 / 为什么是 null
   *
   * 只读（检查锁文件 + 读内存 job），绝不加锁、绝不清理 —— 观测不能改变调度状态。
   */
  function lockWaitFor(job) {
    if (!job || job.state !== 'queued') return null;
    const graceSec = timeoutGraceMs / 1000;
    const dedupePush = (b) => {
      if (b && !blockers.some((x) => x.holderJobId === b.holderJobId && x.lock === b.lock)) blockers.push(b);
    };
    const holderBlocker = (lockLabel, rec) => {
      if (!rec) return null;
      const holder = jobs.get(rec.jobId) ?? null;
      const elapsedSec = holder && holder.state === 'running' && holder.startedAt
        ? Math.max(0, Math.round((nowMs() - Date.parse(holder.startedAt)) / 1000))
        : (rec.at ? Math.max(0, Math.round((nowMs() - Date.parse(rec.at)) / 1000)) : null);
      const timeoutMin = holder && holder.spec ? holder.spec.timeoutMin ?? null : null;
      const remainingSec = timeoutMin != null && elapsedSec != null
        ? Math.max(0, Math.ceil(timeoutMin * 60 + graceSec - elapsedSec))
        : null;
      return {
        lock: lockLabel,
        holderJobId: rec.jobId ?? null,
        holderTag: holder ? holder.tag ?? null : null,
        holderState: holder ? holder.state ?? null : null,
        holderElapsedSec: elapsedSec,
        holderTimeoutMin: timeoutMin,
        holderRemainingSec: remainingSec,
      };
    };
    const blockers = [];
    const locks = locksFor(job.spec);
    for (const l of locks) {
      if (!existsSync(l.path)) continue;
      const rec = readLockFile(l.path);
      if (!rec || rec.jobId === job.id || isStaleLock(rec, l.path, nowMs())) continue;
      dedupePush(holderBlocker(l.name === 'file' ? `file:${l.file}` : l.name, rec));
    }
    /* 跨层级阻塞（整仓库锁 vs 文件锁，见 crossLevelBlocked）同样计入。 */
    const cross = crossLevelBlocked(job, locks);
    if (cross) {
      if (cross.startsWith('repo:')) {
        if (existsSync(repoLockPath)) {
          const rec = readLockFile(repoLockPath);
          if (rec && `repo:${rec.jobId}` === cross) dedupePush(holderBlocker(`cross:${cross}`, rec));
        }
      } else {
        const wantFile = cross.slice('file:'.length);
        const rec = readLockFile(join(dirLocks, FILE_LOCK_DIR, `${hashPath(wantFile)}.lock`));
        if (rec) dedupePush(holderBlocker(`cross:${cross}`, rec));
      }
    }
    /* 队列位置与同类前方任务（与 pump 的优先级排序同尺：文件锁任务在前，同类内 FIFO）。 */
    const pos = queue.indexOf(job.id);
    const myClassIsFile = isFileLockSpec(job.spec);
    const aheadIds = [];
    for (const id of queue) {
      if (id === job.id) break;
      const q = jobs.get(id);
      if (q && isFileLockSpec(q.spec) === myClassIsFile && aheadIds.length < 10) aheadIds.push(id);
    }
    const ahead = aheadIds.length;
    let estWaitSec = null;
    let estWaitNote;
    if (blockers.length === 0) {
      estWaitNote = ahead > 0
        ? `无锁冲突；等同类前方 ${ahead} 个任务与并发额度（它们的时长未知，不猜测）`
        : '无锁冲突；等并发额度释放（前序任务时长未知，不猜测）';
    } else {
      const withRemain = blockers.filter((b) => b.holderRemainingSec != null);
      if (withRemain.length === blockers.length) {
        estWaitSec = Math.max(...withRemain.map((b) => b.holderRemainingSec));
        estWaitNote = '上界估计：按阻塞者 timeoutMin+看门狗宽限 − 已运行时间（到点看门狗会放行），非精确预测';
      } else {
        estWaitNote = '有阻塞者未声明 timeoutMin（跑多久不可知），不猜测等待时长';
      }
      if (ahead > 0) estWaitNote += `；前方同类还有 ${ahead} 个，实际更久`;
    }
    return {
      position: pos >= 0 ? pos + 1 : null,
      queuedTotal: queue.length,
      ahead,
      aheadIds,
      blockers,
      estWaitSec,
      estWaitNote,
    };
  }

  /* ZB-16：**跨层级冲突检查**（实测抓到的真实安全缺口）。
   *
   * 问题：`repo.lock`（整仓库）与 `files/*.lock`（某几个文件）是两套互不知情的锁文件 ——
   * 一个任务持整仓库锁时，另一个任务锁某文件却**照常 running**（实测 actual='running'）。
   * 但"整仓库写"**涵盖所有文件** ⇒ 二者必然有竞写关系，必须互斥。
   *
   * 判据（保守且正确）：
   *   · 想拿文件锁时：若 repo.lock 被**别人**持有 ⇒ 冲突（整仓库涵盖该文件）
   *   · 想拿整仓库锁时：若 locks/files/ 下**任何**文件锁被**别人**持有 ⇒ 冲突
   *     （我们无法证明那些文件与"整仓库写"无交集 ⇒ 按保守原则视为冲突）
   *
   * 注意：这里只做**检查**，不引入新的锁文件；"谁持有"仍由既有锁体记录，
   * UI 展示逻辑不变（用户要求"显示被锁文件与对应进程"已由 listFileLocks 满足）。
   */
  function crossLevelBlocked(job, locks) {
    const isFileLock = locks.some((l) => l.name === 'file');
    if (isFileLock) {
      // 想拿文件锁 ⇒ 看整仓库锁是否被别人持有
      if (existsSync(repoLockPath)) {
        const rec = readLockFile(repoLockPath);
        if (rec && rec.jobId !== job.id && !isStaleLock(rec, repoLockPath, nowMs())) return `repo:${rec.jobId}`;
      }
      return null;
    }
    // 想拿整仓库锁（或 none 以外的粗粒度锁）⇒ 看是否有别人持文件锁
    const dir = join(dirLocks, FILE_LOCK_DIR);
    if (!existsSync(dir)) return null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.lock')) continue;
      const f = join(dir, name);
      const rec = readLockFile(f);
      if (!rec || rec.jobId === job.id) continue;
      if (isStaleLock(rec, f, nowMs())) continue;
      return `file:${(rec.paths && rec.paths[0]) || name}`;
    }
    return null;
  }

  function tryAcquire(job, locks) {
    /* ZB-16：先做跨层级冲突检查 —— 否则"整仓库锁"与"文件锁"会互相无视（实测缺口）。 */
    const cross = crossLevelBlocked(job, locks);
    if (cross) return false;
    const got = [];
    const at = new Date(nowMs()).toISOString();
    for (const l of locks) {
      // ZB-08/16：文件锁的锁体回存 paths，让 UI 能显示「哪个文件被谁锁着」。
      // ⚠️ ZB-16 实测修正：初版把**整组** paths 写进**每一把**文件锁 ⇒
      // listFileLocks 取 rec.paths[0] 时，同一 job 的 N 把锁都显示成第一个文件
      // （实测：锁 {a.ts,b.ts} 的任务在面板上显示 a.ts 两次、b.ts 永不出现）。
      // 每把锁只记录**它自己**那个文件，其余（同一 job 的其它文件）由 job.lockPaths 表达。
      const info = {
        jobId: job.id,
        pid: process.pid,
        at,
        lock: l.name,
        ...(l.name === 'file' ? { paths: [l.file].filter(Boolean) } : {}),
      };
      const ok = acquireLockFile(l.path, info, nowMs());
      if (!ok) {
        for (const g of got.reverse()) releaseLockFile(g.path, job.id); // 拿不全则全放
        return false;
      }
      got.push(l);
    }
    job.lock = locks.map((l) => (l.name === 'file' ? `file:${l.file}` : l.name)).join('+');
    /* ⚠️ ZB-08 实测修正：初版用 `Object.fromEntries(locks.map(l => [l.name, l.path]))`，
     * 而文件锁的 name 都是 'file' ⇒ 多把文件锁**折叠成一个键**，只记住最后一把，
     * releaseLocks 于是漏放其余文件锁 ⇒ 那些文件被**永久锁死**（实测：任务 done 后仍残留
     * 一把锁，后续写同一文件的任务永远排队等待 —— 表现为 20s 超时）。
     * 键必须唯一：文件锁用路径，粗粒度锁用名字。 */
    job.lockPaths = Object.fromEntries(locks.map((l) => [l.name === 'file' ? `file:${l.file}` : l.name, l.path]));
    return true;
  }

  function releaseLocks(job) {
    for (const [, path] of Object.entries(job.lockPaths ?? {})) releaseLockFile(path, job.id);
    delete job.lockPaths;
  }

  /** ZB-17：某 spec 是否是"文件锁任务"（声明了 write ⇒ 文件级锁，可并行）。 */
  function isFileLockSpec(spec) {
    return normalizeWriteSet(spec && spec.write).length > 0;
  }

  function runningCount() {
    let n = 0;
    for (const j of jobs.values()) if (j.state === 'running') n += 1;
    return n;
  }

  /* ZB-17：**文件锁任务优先放行**（用户要求）。
   *
   * 旧实现是严格 FIFO + 队头阻塞：`if (!tryAcquire(head, …)) break;`
   * —— 队头拿不到锁就整个停。后果：一个整仓库锁任务排在前面时，
   * **后面本可并行的文件锁任务全被堵住**（实测过：T18 持整仓库锁 27 分钟，
   * 期间所有文件锁任务干等）。
   *
   * 新实现：按**优先级扫描**队列，取第一个能拿到锁的启动。
   *   · 优先级：文件锁任务（可并行）> 整仓库锁任务
   *   · **同类内保持 FIFO**（按 queue 原始顺序），故同类任务不会互相插队
   *   · 都不行则停（等别人释放）
   *
   * 与"整仓库锁执行时文件锁任务等待"的关系：那是 `crossLevelBlocked` 的职责
   * （整仓库锁涵盖所有文件 ⇒ 与任何文件锁冲突），本函数只决定**放行顺序**。
   *
   * ⚠️ 已知取舍（如实登记）：若文件锁任务持续不断地到来，队里的整仓库锁任务
   * 可能被长期推后（饥饿）。本轮按用户明确要求只做优先级、未加 aging；
   * 若实际出现饥饿，再加"等待超时后提升优先级"即可。
   */
  function pump() {
    while (queue.length > 0 && runningCount() < maxConcurrent) {
      const alive = queue.filter((id) => jobs.get(id));
      const dead = queue.filter((id) => !jobs.get(id));
      /* 优先级排序：文件锁任务在前（各自保持原队列序），整仓库锁任务在后，失效 id 最后。 */
      const ordered = [
        ...alive.filter((id) => isFileLockSpec(jobs.get(id).spec)),
        ...alive.filter((id) => !isFileLockSpec(jobs.get(id).spec)),
        ...dead,
      ];
      let picked = null;
      for (const id of ordered) {
        const j = jobs.get(id);
        if (!j) { picked = { id, dead: true }; break; }
        if (tryAcquire(j, locksFor(j.spec))) { picked = { id, job: j }; break; }
      }
      if (!picked) break; // 没有任何任务能拿到锁 ⇒ 等释放
      queue = queue.filter((x) => x !== picked.id);
      if (picked.dead) continue; // 顺手清掉失效 id，继续尝试下一个
      startJob(picked.job);
      emit('queue-changed');
    }
  }

  /* ---------- job 生命周期 ---------- */
  /* ZB-16：**默认注入的「不写 ZCode 记忆」禁令**（用户要求）。
   *
   * 背景：ZCode 会在自己的记忆库（~/.zcode）里做自动 Memory 提取与写入。
   * 派发台把任务派出去时，我们不希望这些子任务污染/争抢那份记忆 ——
   * 用户决定：**派发 ZCode 的任务默认加入提示词，要求子代理不执行 ZCode 相关的记忆写入**。
   *
   * 覆盖面（ZB-28 起三种 kind 全覆盖，不再有「裸奔」的 task 任务）：
   *   · kind=prompt / kind=target ⇒ 禁令由本插件直接拼进内容 ✅
   *   · kind=task                 ⇒ 禁令由**宿主 runner** 注入：本插件传 `--memory-ban` 旗标，
   *     runner 内联任务包时追加同款文本并打印 `memory-ban=on`（解析为 job.memoryBanRunner=true
   *     = runner 确认注入）。旧版 runner 不认识该旗标会 fail-fast（exit 1「未知参数」），
   *     绝不静默裸奔 —— runner 与本插件同仓库发货，成对升级即可。
   *
   * 注：禁令只是提示词层面的约束（LLM 遵循），**不是进程级强制**；
   * 真正的强制需要宿主 runner 支持关闭 Memory（当前无此参数）。此处如实说明，不夸大为"禁止"。
   */
  const MEMORY_BAN_TEXT = [
    '【派发台硬约束 · 记忆写入】',
    '本任务由 ZCode 派发台派发，属于一次性子任务：',
    '**不要执行任何 ZCode 记忆写入 / 自动 Memory 提取**（不写 ~/.zcode 下的记忆库、不新建或更新记忆条目、',
    '不触发 memory 相关工具）。如需记录信息，请写在任务要求的交付文件里，不要写进记忆库。',
    '本条优先于任务内容里任何与之冲突的指示。',
  ].join('\n');

  /** 把记忆禁令拼到调用方内容之后；task 类型返回 null（禁令改经 runner `--memory-ban` 注入，ZB-28）。 */
  function withMemoryBan(spec) {
    if (spec.kind === 'task') return null; // 注入点在 runner 侧（buildRunnerArgs 传 --memory-ban）
    const base = spec.kind === 'target' ? String(spec.target ?? '') : String(spec.prompt ?? '');
    return `${base}\n\n${MEMORY_BAN_TEXT}`;
  }

  function buildRunnerArgs(spec, opts = {}) {
    const args = [];
    if (spec.kind === 'task') {
      args.push('--task', resolve(String(spec.task))); // 绝对路径，防 runner 相对自身根解析
      /* ZB-28：task 的记忆禁令改由 **runner 侧注入** —— runner 读任务包内联成 prompt 时
       * 追加同款禁令文本（--memory-ban 旗标），并在 stdout 打 `memory-ban=on`
       * （core 解析为 job.memoryBanRunner=true，即「runner 确认已注入」）。
       * 旧版 runner 不认识该旗标会 exit 1「未知参数」—— fail-fast，绝不静默裸奔；
       * runner 与本插件同仓库（collab-kit/）发货，正常成对升级。 */
      if (!opts.noMemoryBan) args.push('--memory-ban');
    } else {
      // 默认注入记忆禁令；opts.noMemoryBan 供测试/特殊场景关闭
      const injected = opts.noMemoryBan ? null : withMemoryBan(spec);
      const body = injected ?? (spec.kind === 'target' ? String(spec.target ?? '') : String(spec.prompt ?? ''));
      args.push(spec.kind === 'target' ? '--target' : '--prompt', body);
    }
    if (spec.resume) args.push('--resume', spec.resume);
    if (spec.memoryBench) args.push('--memory-bench'); // runner 限制：仅 --prompt 可用（dispatch 已校验）
    if (spec.model) args.push('--model', spec.model);
    if (spec.provider) args.push('--provider', spec.provider);
    if (spec.mode) args.push('--mode', spec.mode);
    /* ZB-29：思考强度——具体档位严格生效；'agent'（Agent决定）**也透传**：
     * runner 按 ZCode 自身的默认规则（模型声明档位的最后一档，与 headless registry-fallback
     * 的 values.at(-1) 同语义）解析成实际档位并注入，回显 reasoning-level=<实际档> ⇒
     * job.reasoningLevelApplied 有值，进程上显示实际档位而非「Agent决定」字样。
     * 仅新建会话生效（resume 由 runner 警告并忽略）。 */
    if (spec.reasoningLevel) args.push('--reasoning-level', spec.reasoningLevel);
    if (spec.tag) args.push('--tag', spec.tag);
    if (spec.timeoutMin != null) args.push('--timeout-min', String(spec.timeoutMin));
    if (spec.cwd) args.push('--cwd', spec.cwd);
    return args;
  }

  function startJob(job) {
    job.state = 'running';
    job.startedAt = new Date(nowMs()).toISOString();
    const captureOut = join(dirLogs, `${job.id}.out.log`);
    const captureErr = join(dirLogs, `${job.id}.err.log`);
    job.captureOut = captureOut;
    job.captureErr = captureErr;
    writeFileSync(captureOut, '');
    writeFileSync(captureErr, '');

    let child;
    try {
      child = spawnImpl(process.execPath, [runnerPath, ...buildRunnerArgs(job.spec)], {
        cwd: runnerCwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      job.parseWarnings.push(`spawn-throw: ${e.message}`);
      finalizeJob(job, { state: 'failed', exitCode: null });
      return;
    }
    children.set(job.id, child);

    // dispatcher 侧看门狗：runner 自身有 --timeout-min（超时 exit 124），这里只兜底防 runner 挂死
    const specTimeoutMs = job.spec.timeoutMin != null ? Number(job.spec.timeoutMin) * 60000 : null;
    if (specTimeoutMs != null && Number.isFinite(specTimeoutMs) && specTimeoutMs > 0) {
      /* ZB-28：看门狗何时开火落到 job 字段（watchdogSec = timeoutMin*60 + 宽限秒），
       * 让 list/面板能回答「这个任务最晚什么时候被强制终止」。 */
      job.watchdogSec = Number(((specTimeoutMs + timeoutGraceMs) / 1000).toFixed(1));
      const t = setTimeout(() => {
        if (isTerminal(job)) return;
        job.timedOut = true;
        job.timedOutBy = 'watchdog'; // ZB-28：与 runner 自身超时（timedOutBy='runner'，exit 124）区分
        job.parseWarnings.push(`dispatcher watchdog fired after ${(specTimeoutMs + timeoutGraceMs) / 1000}s`);
        kill(job.id, 'watchdog-timeout');
      }, specTimeoutMs + timeoutGraceMs);
      watchdogs.set(job.id, t);
    }

    const feed = (stream, file) => {
      let fd;
      try {
        fd = openSync(file, 'a');
      } catch {
        fd = null; // 捕获文件打不开不阻断解析
      }
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        if (fd != null) {
          try {
            writeSync(fd, chunk);
          } catch { /* 捕获写失败不影响解析 */ }
        }
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          handleLine(job, buf.slice(0, idx).replace(/\r$/, ''));
          buf = buf.slice(idx + 1);
        }
      });
      const flush = () => {
        if (buf.trim()) handleLine(job, buf.replace(/\r$/, ''));
        buf = '';
        if (fd != null) {
          try {
            closeSync(fd);
          } catch { /* 已关 */ }
          fd = null;
        }
      };
      stream.on('end', flush);
      stream.on('error', flush);
    };
    feed(child.stdout, captureOut);
    feed(child.stderr, captureErr);

    child.on('error', (e) => {
      if (!isTerminal(job)) {
        job.parseWarnings.push(`spawn-error: ${e.message}`);
        finalizeJob(job, { state: 'failed', exitCode: null });
      }
    });
    child.on('close', (code, signal) => {
      if (!isTerminal(job)) {
        const requested = killRequested.has(job.id);
        let state = requested ? 'killed' : code === 0 ? 'done' : 'failed';
        // Z6：非 0 退出先按输出签名识别暂停；命中已知签名 → paused（不占锁，等用户续跑/交接）；
        // unknown 只记 pauseReason 字段，状态保持 failed（Z1 语义不变）。
        let pause = null;
        if (!requested && code !== 0) pause = classifyPause(tails.get(job.id) ?? []);
        if (pause && pause.reason === 'unknown') {
          job.pauseReason = 'unknown';
          job.pauseDetail = pause.detail;
          pause = null;
        }
        if (pause) state = 'paused';
        finalizeJob(job, { state, exitCode: code, signal: signal ?? null, pause });
      }
      children.delete(job.id);
    });

    persist();
    emit('job-updated', job);
  }

  function handleLine(job, line) {
    if (!line) return;
    const tl = tails.get(job.id) ?? [];
    tl.push(line);
    if (tl.length > TAIL_CAP) tl.splice(0, tl.length - TAIL_CAP);
    tails.set(job.id, tl);

    const parsed = parseRunnerLine(line);
    if (parsed === null) {
      job.parseWarnings.push(`unparsed [zcode-run] line: ${line.slice(0, 120)}`);
      return;
    }
    if (!parsed || Object.keys(parsed).length === 0) return;

    if (parsed.runnerTag && job.tag == null) job.tag = parsed.runnerTag; // runner 分配的 tag 回填，用于台账匹配
    /* ZB-40：心跳/进度落库（面板显示"当前工作内容 + 是否可能卡住"） */
    if (parsed.progress) job.progress = parsed.progress;
    if (parsed.lastProgressAt) job.lastProgressAt = parsed.lastProgressAt;
    if (parsed.summarySeen) job.summarySeen = true;
    if (parsed.exitCode != null) job.exitCode = parsed.exitCode;
    if (parsed.sessionId) job.sessionId = parsed.sessionId;
    // done 行的 provider/model 来自 CLI 日志 traceId 反查（实际值），优先于启动行的声明值
    if (parsed.provider && (parsed.authoritative || !job.provider)) job.provider = parsed.provider;
    if (parsed.model && (parsed.authoritative || !job.model)) job.model = parsed.model;
    if (parsed.models) job.models = parsed.models;
    /* ZB-28：超时与 runner 侧记忆禁令确认。
     * · timedOut：runner 自身 --timeout-min 到点会在 done 行带 `(超时)` 且 exit=124 ——
     *   此前该标记被丢弃（timedOut 只有 dispatcher 看门狗路径会置位），「runner 超时」与
     *   「任务真失败」在 job 上无法区分。现在如实落到 job.timedOut/timedOutBy='runner'。
     * · memoryBanSeen：runner 打印 `memory-ban=on` = 旗标确实被它接受并注入
     *   （task 类型的禁令在 runner 侧拼装，见 collab-kit/zcode-run.mjs ZB-28 注释）。 */
    if (parsed.timedOut) { job.timedOut = true; if (job.timedOutBy == null) job.timedOutBy = 'runner'; }
    if (parsed.memoryBanSeen) job.memoryBanRunner = true;
    /* ZB-29：runner 确认思考强度已注入（defaultModelSelection 写入临时 provider 配置）。 */
    if (parsed.reasoningLevelApplied != null) {
      job.reasoningLevelApplied = parsed.reasoningLevelApplied;
      job.reasoningTarget = parsed.reasoningTarget;
    }
    if (parsed.endpoint) job.endpoint = parsed.endpoint;
    if (parsed.usage) {
      job.usage = { ...job.usage, ...Object.fromEntries(Object.entries(parsed.usage).filter(([, v]) => v != null)) };
    }
    if (parsed.contextUsed != null) job.contextUsed = parsed.contextUsed;
    if (parsed.contextWindow != null) job.contextWindow = parsed.contextWindow;
    if (parsed.turnCount != null) job.turnCount = parsed.turnCount;
    if (parsed.responseChars != null) job.responseChars = parsed.responseChars;
    if (parsed.runnerOut) job.outLog = parsed.runnerOut;
    if (parsed.runnerErr) job.errLog = parsed.runnerErr;
    if (parsed.runnerResult) job.resultFile = parsed.runnerResult;
    if (isTerminal(job)) return; // finalize 之后的迟到行只进 tailLines
    persist();
    emit('job-updated', job);
  }

  /** job 结束：台账回读合并 → 终态字段 → 持久化/广播 → 放锁 → 泵队列。paused 时不占锁、
   *  队列照常继续（paused 不在 running 计数里）；若是可降级原因且链已启用，异步接续下一跳。 */
  function finalizeJob(job, { state, exitCode = null, signal = null, pause = null }) {
    job.state = state;
    if (exitCode != null) job.exitCode = exitCode;
    job.signal = signal;
    if (pause) {
      job.pauseReason = pause.reason;
      job.pauseDetail = pause.detail;
    }
    job.finishedAt = new Date(nowMs()).toISOString();
    if (state === 'paused') job.pausedAt = job.finishedAt; // ZB-28：进入 paused 的时刻（= finishedAt，显式字段便于检索/展示）
    job.elapsedSec = Number(((Date.parse(job.finishedAt) - Date.parse(job.startedAt ?? job.finishedAt)) / 1000).toFixed(3));
    job.tailLines = tails.get(job.id) ?? [];

    mergeFromLedger(job);
    if (!job.summarySeen && !job.ledgerMatched) {
      job.parseWarnings.push('no [zcode-run] summary parsed and no ledger record matched');
    }

    clearTimeout(watchdogs.get(job.id));
    watchdogs.delete(job.id);
    killRequested.delete(job.id);
    tails.set(job.id, job.tailLines);

    /* ZB-26（审计 B3）：**落盘前**必须先盖版本戳 —— 否则终态记录带着"上一次更新"的旧
     * updatedAt 落盘，别的进程按新旧合并时会认为自己的旧副本更新，把终态覆盖回 running。 */
    job.updatedAt = nowMs();
    persist();
    emit('job-updated', job);
    releaseLocks(job);
    pump();
    if (state === 'paused' && AUTO_FALLBACK_REASONS.has(job.pauseReason)) maybeAutoFallback(job);
  }

  /* ---------- Z6：通道 / retry / 交接重跑 / 自动降级链 ---------- */

  /**
   * paused 且原因可降级时按**目标列表**自动交接。从当前通道之后找第一个「可用」目标跳过去
   * （可用性来自 listChannels，不猜）；当前通道不在列表上则从头找；跳数以列表长度封顶；
   * 列表耗尽或某一跳执行失败都停在 paused 并留 warning。
   * ZB-30：每个目标可带 model / reasoningLevel（面板设置）——有则覆盖，无则沿用原任务。
   */
  function maybeAutoFallback(job) {
    if (fallbackTargets.length === 0) return;
    if (Number(job.hopCount ?? 0) >= fallbackTargets.length) {
      job.parseWarnings.push(`fallback-chain: 已达目标数上限（${fallbackTargets.length} 跳），停止自动降级`);
      persist();
      emit('job-updated', job);
      return;
    }
    const startIdx = fallbackTargets.findIndex((t) => t.provider === (job.spec.provider ?? 'plan'));
    void (async () => {
      try {
        const cur = jobs.get(job.id);
        if (!cur || cur.state !== 'paused') return; // 期间被用户续跑/kill：不再自动动
        let channels = [];
        if (channelsImpl) {
          channels = (await channelsImpl()).channels ?? [];
        } else {
          channels = (await listChannels()).channels ?? [];
        }
        const live = jobs.get(job.id);
        if (!live || live.state !== 'paused') return;
        for (let i = startIdx + 1; i < fallbackTargets.length; i += 1) {
          const target = fallbackTargets[i];
          const ch = channels.find((c) => c.id === target.provider);
          if (ch && ch.enabled) {
            live.parseWarnings.push(`fallback-chain: 自动跳到 ${target.provider}${target.model ? `/${target.model}` : ''}（交接重跑）`);
            retry(live.id, {
              provider: target.provider,
              model: target.model,
              reasoningLevel: target.reasoningLevel,
              autoFallback: true,
            });
            return;
          }
        }
        live.parseWarnings.push('fallback-chain: 目标列表里没有下一个可用通道，保持 paused');
        persist();
        emit('job-updated', live);
      } catch (e) {
        const live = jobs.get(job.id);
        if (live && live.state === 'paused') {
          live.parseWarnings.push(`fallback-chain: 自动降级失败（${e?.message ?? e}），保持 paused`);
          persist();
          emit('job-updated', live);
        }
      }
    })();
  }

  /** 当前默认通道（dispatch 未显式指定 provider/model 时采用；reasoningLevel=通道默认思考强度）。 */
  function getChannel() {
    return { ...channel };
  }

  /* ZB-29d：思考强度归一（'agent'=Agent决定 或 具体档位；非法/空 → 回退 fallback，不猜）。 */
  const normReasoning = (v, fallback) => {
    if (v == null) return fallback;
    const s = String(v).trim();
    if (!s) return fallback;
    return s === 'agent' || /^[A-Za-z0-9_-]{1,32}$/.test(s) ? s : fallback;
  };

  /** 设默认通道并持久化到 <workRoot>/state/channel.json（不校验可用性——可用性看 listChannels，不猜）。
   *  ZB-29d：reasoningLevel = 通道默认思考强度（'agent'=Agent决定 / 具体档位）；缺省沿用原值。 */
  function setChannel(next = {}) {
    const provider = next.provider == null ? channel.provider : String(next.provider);
    const model = next.model == null || next.model === '' ? null : String(next.model);
    if (!provider) throw new TypeError('setChannel: provider 不能为空');
    channel = {
      provider,
      model,
      reasoningLevel: normReasoning(next.reasoningLevel, channel.reasoningLevel ?? 'agent'),
    };
    atomicWrite(channelFile, `${JSON.stringify({ version: 1, ...channel, updatedAt: new Date(nowMs()).toISOString() }, null, 2)}\n`);
    return getChannel();
  }

  function loadChannelState() {
    try {
      const data = JSON.parse(readFileSync(channelFile, 'utf8'));
      if (data && typeof data.provider === 'string' && data.provider) {
        channel = {
          provider: data.provider,
          model: typeof data.model === 'string' && data.model ? data.model : null,
          reasoningLevel: normReasoning(data.reasoningLevel, 'agent'),
        };
      }
    } catch { /* 无文件/损坏：用默认通道 */ }
  }

  /* ZB-30：降级**目标**归一 —— 每项 {provider, model, reasoningLevel}（model/reasoningLevel 可为 null
   * = 沿用原任务）。接受三种入参：字符串（旧 chain 项）/ {provider|id|channel, model?, reasoningLevel?|thinking?}。
   * 非法项（无 provider）直接丢弃（不猜），并保留顺序。 */
  function normFallbackTargets(list) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw new TypeError('setFallbackTarget/setFallbackChain: 需要数组（空数组/null = 关闭）');
    const out = [];
    for (const item of list) {
      if (typeof item === 'string') {
        const id = item.trim();
        if (id) out.push({ provider: id, model: null, reasoningLevel: null });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const provider = String(item.provider ?? item.id ?? item.channel ?? '').trim();
      if (!provider) continue;
      const model = item.model == null || item.model === '' ? null : String(item.model);
      const rl = normReasoning(item.reasoningLevel ?? item.thinking ?? null, null);
      out.push({ provider, model, reasoningLevel: rl });
    }
    return out;
  }

  function persistFallback() {
    atomicWrite(fallbackFile, `${JSON.stringify({
      version: 2,
      chain: fallbackTargets.map((t) => t.provider), // 旧读者（CLI list / 旧客户端）仍能读
      targets: fallbackTargets,
      updatedAt: new Date(nowMs()).toISOString(),
    }, null, 2)}\n`);
  }

  /** 旧入口：通道 id 数组（等价于只有 provider 的目标列表）。 */
  function setFallbackChain(list) {
    fallbackTargets = normFallbackTargets(list);
    persistFallback();
    return getFallbackChain();
  }

  /** ZB-30（面板入口）：设置**单个**降级目标（通道+模型+思考强度）；null/空 = 关闭降级。 */
  function setFallbackTarget(target) {
    if (target == null || target === '') {
      fallbackTargets = [];
    } else if (typeof target === 'string') {
      fallbackTargets = normFallbackTargets([target]);
    } else {
      fallbackTargets = normFallbackTargets([target]);
      if (fallbackTargets.length === 0) throw new TypeError('setFallbackTarget: 需要 provider（通道 id）');
    }
    persistFallback();
    return getFallbackChain();
  }

  /** {enabled, chain（旧形状：通道 id 列表）, targets（新形状：含 model/思考强度）, target（首项）}。 */
  function getFallbackChain() {
    const targets = fallbackTargets.map((t) => ({ ...t }));
    return {
      enabled: targets.length > 0,
      chain: targets.map((t) => t.provider),
      targets,
      target: targets[0] ?? null,
    };
  }

  function loadFallbackState() {
    try {
      const data = JSON.parse(readFileSync(fallbackFile, 'utf8'));
      if (data && Array.isArray(data.targets)) {
        fallbackTargets = normFallbackTargets(data.targets); // ZB-30 新形状
      } else if (data && Array.isArray(data.chain)) {
        fallbackTargets = normFallbackTargets(data.chain); // 旧 version 1 自动迁移（只带通道 id）
      }
    } catch { /* 无文件/损坏：默认关 */ }
  }

  /**
   * ZB-33：免费额度（Start Plan）通道的展示名。
   *
   * 它是**运行时注入**的 `account:<family>-start-plan`（runner 侧 app-server 托管，
   * 见 collab-kit/appserver-gift.mjs），config.json 里没有它 ⇒ `readConfigNames()` 取不到名字，
   * 面板下拉会显示裸 id。这里按 id 形态给一个中文名（只影响展示，不影响可用性判断）。
   */
  const GIFT_CHANNEL_RE = /^account:[a-z]+-start-plan$/;

  /** 读 config.json 里的 provider 展示名（只读；读不到就用 id，不影响可用性判断）。 */
  function readConfigNames() {
    try {
      const cfg = JSON.parse(readFileSync(zcodeConfigPath, 'utf8'));
      const out = {};
      for (const [id, p] of Object.entries(cfg?.provider ?? {})) {
        if (p && typeof p.name === 'string' && p.name) out[id] = p.name;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** 读权益缓存 coding-plan-cache.json（只读、可选；损坏只记 warning）。 */
  function readPlanCache(warnings) {
    try {
      const cache = JSON.parse(readFileSync(planCachePath, 'utf8'));
      const items = cache?.entryStatus?.items;
      if (items && typeof items === 'object') return items;
      warnings.push('coding-plan-cache.json 缺 entryStatus.items，按无缓存处理');
      return {};
    } catch (e) {
      if (e?.code !== 'ENOENT') warnings.push(`coding-plan-cache.json 读取失败：${e.message}`);
      return {};
    }
  }

  /** 个人 API 通道（--provider personal 的可用性来自 provider_config.json 本体，同 runner 口径）。 */
  function readPersonalChannel(warnings) {
    try {
      const cfg = JSON.parse(readFileSync(personalProviderPath, 'utf8'));
      const rules = cfg?.config?.providerConfigRules?.providerRules ?? [];
      const rule = rules.find((r) => r?.config?.access?.apiKey);
      if (!rule) {
        return { id: 'personal', name: '个人 API', enabled: false, reason: '个人 provider 配置缺 apiKey', endpoint: null, models: [] };
      }
      return {
        id: 'personal',
        name: rule.providerName ?? '个人 API',
        enabled: true,
        reason: null,
        endpoint: rule.config?.api?.baseUrl ?? null,
        models: Array.isArray(rule.config?.personalModelIds) ? rule.config.personalModelIds.filter(Boolean) : [],
      };
    } catch (e) {
      if (e?.code !== 'ENOENT') warnings.push(`个人 provider 配置读取失败：${e.message}`);
      return { id: 'personal', name: '个人 API', enabled: false, reason: '个人 provider 配置不存在', endpoint: null, models: [] };
    }
  }

  /** 通道清单：runner --list-providers 真实输出为骨架，叠加权益缓存/展示名/personal 通道。
   *  解析失败 → {channels:[], warnings}，绝不猜测。首条是 runner 文档化的 plan 别名。 */
  async function listChannels() {
    if (channelsImpl) return channelsImpl();
    const warnings = [];
    let text = null;
    if (channelsProbeImpl) {
      try {
        text = await channelsProbeImpl();
      } catch (e) {
        warnings.push(`通道探测失败：${e?.message ?? e}`);
      }
    } else {
      text = await new Promise((done) => {
        let child;
        try {
          child = spawnImpl(process.execPath, [runnerPath, '--list-providers'], { cwd: runnerCwd, env: { ...process.env } });
        } catch {
          done(null);
          return;
        }
        let out = '';
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* 已退出 */ }
        }, 15000);
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (d) => { out += d; });
        child.on('error', () => {
          clearTimeout(timer);
          done(out || null);
        });
        child.on('close', () => {
          clearTimeout(timer);
          done(out);
        });
      });
    }
    const parsed = parseProviderTable(text);
    warnings.push(...parsed.warnings);
    if (parsed.rows.length === 0) {
      return { channels: [], warnings: [...warnings, '无法解析通道清单，不猜测（检查 runner 与 ~/.zcode/v2/config.json）'] };
    }
    const names = readConfigNames();
    const cache = readPlanCache(warnings);
    /* ZB-29：每个模型的思考强度档位（runner 探测输出；无该行 = 旧 runner，字段留空不猜）。 */
    const modelLevels = parsed.modelLevels ?? {};
    const levelsOf = (modelIds) => {
      const set = new Set();
      let seen = false;
      for (const id of modelIds ?? []) {
        const lv = modelLevels[id];
        if (!lv) continue;
        seen = true;
        for (const x of lv) set.add(x);
      }
      return seen ? [...set] : null; // null = 声明缺失（不猜，UI 退回通用提示）
    };
    const channels = parsed.rows.map((r) => ({
      id: r.id,
      name: names[r.id] ?? (GIFT_CHANNEL_RE.test(r.id) ? '免费额度（Start Plan）' : r.id),
      enabled: r.enabled,
      reason: r.reason ?? (cache[r.id]?.status === 'unavailable' ? cache[r.id]?.reason ?? null : null),
      endpoint: r.endpoint,
      models: r.models,
      ...(Object.keys(modelLevels).length ? { thinkingLevels: levelsOf(r.models) } : {}),
      ...(cache[r.id]?.status ? { cacheStatus: cache[r.id].status } : {}),
    }));
    // plan 别名：runner 文档化行为「选第一个启用的 *coding-plan，其次 *start-plan」
    const ranked = channels
      .filter((c) => /coding-plan|start-plan/.test(c.id))
      .sort((a, b) => (Number(b.enabled) - Number(a.enabled)) || (Number(/start-plan/.test(a.id)) - Number(/start-plan/.test(b.id))));
    const pick = ranked.find((c) => c.enabled) ?? null;
    const planAlias = {
      id: 'plan',
      name: '默认套餐（runner 自动选择）',
      enabled: !!pick,
      reason: pick ? null : '没有已启用的套餐 provider',
      endpoint: pick?.endpoint ?? null,
      models: pick ? [...pick.models] : [],
      ...(Object.keys(modelLevels).length ? { thinkingLevels: pick ? levelsOf(pick.models) : null } : {}),
      ...(pick ? { aliasOf: pick.id } : {}),
    };
    /* ZB-31（用户报「deepseek-flash 没有低/高/最高」）：个人通道的档位同样从**同一份探测表**取 ——
     * runner 现已把个人通道模型也纳入 `reasoning-levels` 输出（ZB-31 runner 侧修），
     * 这里只需把它接上（原先 personal 通道根本没有 thinkingLevels 字段 ⇒ 面板退回通用提示）。 */
    const personal = readPersonalChannel(warnings);
    return {
      channels: [
        planAlias,
        {
          ...personal,
          ...(Object.keys(modelLevels).length ? { thinkingLevels: levelsOf(personal.models) } : {}),
        },
        ...channels,
      ],
      warnings,
    };
  }

  /** 按 tag 回读台账最后一条匹配记录（已知 sessionId 时优先精确匹配），只补 job 缺失的字段。 */
  function mergeFromLedger(job) {
    if (!ledgerPath || !existsSync(ledgerPath)) return;
    let records;
    try {
      records = readFileSync(ledgerPath, 'utf8').split('\n');
    } catch (e) {
      job.parseWarnings.push(`ledger-read-failed: ${e.message}`);
      return;
    }
    const matches = [];
    let badLines = 0;
    for (const l of records) {
      const t = l.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (rec && typeof rec === 'object' && job.tag != null && rec.tag === job.tag) matches.push(rec);
      } catch {
        badLines += 1;
      }
    }
    if (badLines > 0) job.parseWarnings.push(`ledger had ${badLines} unparsable line(s) while matching`);
    if (matches.length === 0) return;

    const rec = job.sessionId
      ? [...matches].reverse().find((r) => r.sessionId === job.sessionId)
      : matches[matches.length - 1];
    if (!rec) return; // 有同名 tag 记录但 sessionId 都不匹配：宁可不绑，避免串到旧 run
    job.ledgerMatched = true;

    const fill = (k, v) => {
      if (v != null && job[k] == null) job[k] = v;
    };
    fill('sessionId', rec.sessionId);
    fill('provider', rec.provider);
    fill('endpoint', rec.endpoint);
    fill('model', rec.model);
    fill('contextUsed', rec.contextUsed);
    fill('contextWindow', rec.contextWindow);
    fill('responseChars', rec.responseChars);
    fill('billing', rec.billing);
    fill('traceId', rec.traceId);
    if (job.exitCode == null) job.exitCode = rec.exit ?? null;
    fill('elapsedSec', rec.elapsedSec != null ? Number(rec.elapsedSec) : null);
    for (const k of ['requests', 'inputTokens', 'outputTokens', 'cacheReadTokens']) {
      if (job.usage[k] == null && rec[k] != null) job.usage[k] = Number(rec[k]) || 0;
    }
  }

  /* ---------- 公开 API ---------- */
  function validateSpec(spec) {
    if (!spec || !KINDS.has(spec.kind)) throw new TypeError(`dispatch(spec): spec.kind 必须是 ${[...KINDS].join('|')}`);
    const body = { task: spec.task, prompt: spec.prompt, target: spec.target }[spec.kind];
    if (body == null || body === '') throw new TypeError(`dispatch(spec): kind=${spec.kind} 需要对应的 ${spec.kind} 字段`);
    if (spec.lock != null && !LOCK_MODES.has(spec.lock)) throw new TypeError("dispatch(spec): spec.lock 必须是 repo|none（ZB-16 起 memory/both 已删除；锁哪些文件用 spec.write）");
    /* ZB-08：write 是可选项（声明 ⇒ 细粒度文件锁；不声明 ⇒ 回退粗粒度）。
     * 只校验"是字符串数组"，不强制非空——空数组按未声明处理（回退，安全）。 */
    if (spec.write != null) {
      if (!Array.isArray(spec.write)) throw new TypeError('dispatch(spec): spec.write 必须是文件路径数组');
      for (const p of spec.write) {
        if (typeof p !== 'string' || !p.trim()) throw new TypeError('dispatch(spec): spec.write 里不能有空路径或非字符串');
      }
    }
    if (spec.memoryBench && spec.kind !== 'prompt') throw new TypeError('dispatch(spec): memoryBench 仅支持 kind=prompt（runner 限制）');
    if (spec.timeoutMin != null && !(Number(spec.timeoutMin) > 0)) throw new TypeError('dispatch(spec): timeoutMin 必须为正数');
    /* ZB-29：思考强度。'agent'（Agent决定，默认）在 core 层就不透传（= 不覆盖，ZCode 按模型默认档）；
     * 具体档位随模型声明不同（GLM-5 系 disabled|enabled、deepseek-v4 系 disabled|low|high|max），
     * core 不写死枚举 —— runner 按 builtin 声明校验，非法档位 fail-fast（不静默降级）。 */
    if (spec.reasoningLevel != null) {
      if (typeof spec.reasoningLevel !== 'string' || !spec.reasoningLevel.trim()) {
        throw new TypeError('dispatch(spec): reasoningLevel 必须是非空字符串（或 "agent" = Agent决定）');
      }
    }
  }

  /** 原始派发：spec 已是完全确定的形式（retry 内部走这里，保证 --resume 时不被注入 --model）。
   *  {raw:true} 返回 jobs 里的真实对象——retry 的簿记必须写在存储态上；默认仍返回 get() 克隆，
   *  防外部调用方改坏内部态。 */
  function dispatchRaw(spec, { raw = false } = {}) {
    validateSpec(spec);
    const id = nextId();
    const job = {
      id,
      tag: spec.tag ?? null,
      spec: { ...spec },
      lock: null,
      state: 'queued',
      queuedAt: new Date(nowMs()).toISOString(),
      startedAt: null,
      finishedAt: null,
      elapsedSec: null,
      exitCode: null,
      signal: null,
      sessionId: null,
      provider: null,
      endpoint: null,
      model: spec.model ?? null,
      reasoningLevel: spec.reasoningLevel ?? null, // ZB-29：思考强度请求（'agent'=Agent决定：不覆盖，ZCode 按模型默认档；具体档位见 channels[].thinkingLevels）
      usage: { requests: null, inputTokens: null, outputTokens: null, cacheReadTokens: null },
      contextUsed: null,
      contextWindow: null,
      responseChars: null,
      outLog: null,
      errLog: null,
      resultFile: null,
      captureOut: null,
      captureErr: null,
      tailLines: [],
      parseWarnings: [],
      /* ZB-16/ZB-28：记忆禁令是否已安排注入。
       * ZB-28 起三种 kind 全覆盖：prompt/target 由插件直接拼进内容；
       * task 经 runner `--memory-ban` 由宿主注入（runner 是否确认见 memoryBanRunner 字段）。
       * 不再出现「memoryBanApplied=false = 裸奔」的 task 任务。 */
      memoryBanApplied: true,
      memoryBanRunner: null, // ZB-28：runner 打印 memory-ban=on 后置 true（禁令在 runner 侧确认注入）
      timedOut: false,
      timedOutBy: null, // ZB-28：'runner'（--timeout-min 到点，exit 124 → failed）| 'watchdog'（看门狗 kill → killed）
      pausedAt: null, // ZB-28：进入 paused 的时刻（ISO；非 paused 恒 null）
      watchdogSec: null, // ZB-28：看门狗开火秒数（timeoutMin*60+宽限；未设 timeoutMin 恒 null）
      summarySeen: false,
      ledgerMatched: false,
      // Z6：暂停/交接簿记
      pauseReason: null,
      pauseDetail: null,
      parentJobId: null,
      attempts: [],
      hopCount: 0,
      handedOffTo: null,
      resumedBy: null,
      /* ZB-26（审计 B2/B3）：进程归属 + 版本戳。
       * ownerPid 让 restore() 能区分「自己的残留」与「别进程正在跑的 job」（否则 zcd kill/retry
       * 会先把活 job 在本地内存里改成 interrupted）；updatedAt 让多进程 persist 能按新旧合并。 */
      ownerPid: process.pid,
      updatedAt: nowMs(),
    };
    jobs.set(id, job);
    tails.set(id, []);
    queue.push(id);
    persist();
    emit('job-updated', job);
    emit('queue-changed');
    pump();
    return raw ? job : get(id);
  }

  /** 公共派发入口：未显式指定 provider/model 时采用默认通道（getChannel）。
   *  ZB-29d：未显式指定 reasoningLevel 时按**通道默认思考强度**执行——通道设置就是给派发
   *  Agent 的规定（'agent'=Agent决定：runner 按 ZCode 默认规则 values.at(-1) 解析成实际档；
   *  具体档位=硬性规定）。放在 core 层 ⇒ 工具/CLI/面板三条入口统一生效。 */
  function dispatch(spec) {
    validateSpec(spec);
    const effSpec = { ...spec };
    if (effSpec.provider == null && channel.provider) effSpec.provider = channel.provider;
    if (effSpec.reasoningLevel == null && channel.reasoningLevel) effSpec.reasoningLevel = channel.reasoningLevel;
    /* F2（机制事实，2026-09-30 现场复现）：`--resume` 带 `--model` 必失败
     * （runner 侧报 `Error: Model creation failed`，exit=1，resultFile 不产出）。
     * 故**续接时绝不注入通道默认 model** —— 与 retry 里的 `delete spec.model`（:1101）同一条纪律。
     * 显式传入的 model 不在此拦截（那是调用方的选择，由 runner 的报错兜底）；这里只保证
     * 「没显式传就不注入」。曾经的缺口：dispatch + resume 会注入通道默认 model → 必然失败。 */
    if (effSpec.model == null && channel.model && !effSpec.resume) effSpec.model = channel.model;
    return dispatchRaw(effSpec);
  }

  /**
   * 结构化交接提示词（五要素）：
   * ① 原任务（task 文件内容或 prompt/target 原文）② 上次中断点（pauseReason/pauseDetail + tail 尾部）
   * ③ 新通道说明（交接重跑≠原会话续跑）④ 硬约束（先核对现状/只做剩余/按原要求交付）⑤ 禁止（不回滚/不重复交付）。
   */
  function buildHandoffPrompt(job, target = {}) {
    const spec = job.spec ?? {};
    const provider = target.provider ?? spec.provider ?? 'plan';
    const model = target.model ?? spec.model ?? '(通道默认模型)';
    let taskBlock;
    let taskSource;
    if (spec.kind === 'task' && spec.task) {
      const p = resolve(String(spec.task));
      taskSource = `原任务来源：任务包文件 ${p}`;
      try {
        taskBlock = readFileSync(p, 'utf8');
      } catch (e) {
        taskBlock = `（原任务文件读取失败：${e?.message ?? e}；请向派发方索要原任务包）`;
      }
    } else if (spec.kind === 'target') {
      taskSource = '原任务来源：target 目标';
      taskBlock = String(spec.target ?? '');
    } else {
      taskSource = '原任务来源：原 prompt';
      taskBlock = String(spec.prompt ?? '');
    }
    const tail = (tails.get(job.id) ?? job.tailLines ?? []).slice(-20);
    const tailBlock = tail.length ? tail.map((l) => `  ${l}`).join('\n') : '  （无捕获输出）';
    return [
      '【交接重跑提示词】上一轮任务因故中断，现在换通道继续执行。请严格按以下五部分处理。',
      '',
      '一、原任务',
      taskSource,
      '----- 原任务开始 -----',
      taskBlock,
      '----- 原任务结束 -----',
      '',
      '二、上次中断点',
      `- pauseReason: ${job.pauseReason ?? '(未记录)'}`,
      `- pauseDetail: ${job.pauseDetail ?? '(无)'}`,
      '- 最后输出（tailLines 尾部，最多 20 行）：',
      tailBlock,
      '',
      '三、新通道说明',
      `你现在运行在 ${provider}/${model} 通道上；这是交接重跑，不是原会话续跑（不要尝试 --resume 原会话${job.sessionId ? ` ${job.sessionId}` : ''}，它会留在旧通道上）。`,
      '',
      '四、硬约束（按顺序执行）',
      '1. 先核对仓库/工作区当前状态（git status、已存在的交付物），已完成的部分不要重做。',
      '2. 只做剩余部分。',
      '3. 完成后按原任务包要求交付（交付文档路径与最终回复格式照旧）。',
      '',
      '五、禁止',
      '- 不要回滚已完成改动。',
      '- 不要重复已完成交付。',
    ].join('\n');
  }

  /**
   * 续跑/交接。目标通道 == 原通道且有 sessionId → 同会话续跑（--resume，绝不带 --model，机制事实 F2）；
   * 换通道或无 sessionId → 交接重跑（新会话 + buildHandoffPrompt），新 job 记 parentJobId/attempts/hopCount，
   * 旧 job 标 handedOffTo（同通道续跑标 resumedBy）。
   * @returns 新 job（get() 序列化形状；簿记已写在存储态，d.get()/d.list()/jobs.json 均可读回）
   */
  function retry(jobId, opts = {}) {
    const job = jobs.get(jobId);
    if (!job) throw new Error(`retry: 找不到 job：${jobId}`);
    if (job.state === 'queued' || job.state === 'running') {
      throw new Error(`retry: job ${jobId} 仍在 ${job.state}，等它落到 paused/终态再续`);
    }
    const targetProvider = opts.provider != null && opts.provider !== '' ? String(opts.provider) : null;
    const targetModel = opts.model != null && opts.model !== '' ? String(opts.model) : null;
    /* ZB-30：降级目标可指定思考强度（面板设置）。null/'' = 沿用原任务档位（下面的 spec 展开）。
     * 'agent' 是**显式**值 ⇒ 照传（runner 按 ZCode 默认规则解析成实际档）。 */
    const targetReasoning = opts.reasoningLevel == null || opts.reasoningLevel === ''
      ? null
      : String(opts.reasoningLevel);
    const origProvider = job.spec.provider ?? 'plan'; // runner 缺省即 plan
    const sameChannel = targetProvider == null || targetProvider === origProvider;
    const at = new Date(nowMs()).toISOString();
    const prevAttempts = Array.isArray(job.attempts) ? job.attempts : [];
    const reason = opts.autoFallback
      ? `auto-fallback:${job.pauseReason ?? 'paused'}`
      : job.pauseReason && job.pauseReason !== 'unknown'
        ? job.pauseReason
        : `manual-retry:${job.state}`;

    if (sameChannel && job.sessionId) {
      const spec = { ...job.spec, resume: job.sessionId };
      delete spec.model; // F2：--resume 时传 --model 必失败
      if (job.tag) spec.tag = `${job.tag}-r${prevAttempts.length + 1}`;
      const nj = dispatchRaw(spec, { raw: true }); // 簿记必须写在存储态真实对象上（get() 返回克隆，写它会丢）
      nj.parentJobId = job.id;
      nj.attempts = [
        ...prevAttempts,
        { jobId: job.id, provider: origProvider, model: job.spec.model ?? null, reason, at },
        { jobId: nj.id, provider: origProvider, model: null, reason: 'resume-same-channel', at },
      ];
      job.resumedBy = nj.id;
      persist();
      emit('job-updated', job);
      emit('job-updated', nj);
      return get(nj.id);
    }

    // 交接重跑：换通道（或原通道无 sessionId 可续）
    const prompt = buildHandoffPrompt(job, { provider: targetProvider ?? origProvider, model: targetModel });
    const spec = {
      kind: 'prompt',
      prompt,
      provider: targetProvider ?? origProvider,
      ...(targetModel ? { model: targetModel } : {}),
      ...(job.spec.mode ? { mode: job.spec.mode } : {}),
      ...(job.spec.lock ? { lock: job.spec.lock } : {}),
      ...(job.spec.cwd ? { cwd: job.spec.cwd } : {}),
      ...(job.spec.timeoutMin != null ? { timeoutMin: job.spec.timeoutMin } : {}),
      /* ZB-29：交接重跑是新会话，沿用原任务的思考强度档位（'agent' 照传 = 继续不覆盖）。
       * ZB-30：降级目标显式带了档位 ⇒ 用它（面板设置的硬性规定）；未带 ⇒ 沿用原任务。 */
      ...((targetReasoning ?? job.spec.reasoningLevel) ? { reasoningLevel: targetReasoning ?? job.spec.reasoningLevel } : {}),
      ...(job.tag ? { tag: `${job.tag}-h${prevAttempts.length + 1}` } : {}),
    };
    const nj = dispatchRaw(spec, { raw: true }); // 簿记必须写在存储态真实对象上（get() 返回克隆，写它会丢）
    nj.parentJobId = job.id;
    nj.hopCount = Number(job.hopCount ?? 0) + 1;
    nj.attempts = [
      ...prevAttempts,
      { jobId: job.id, provider: origProvider, model: job.spec.model ?? null, reason, at },
      { jobId: nj.id, provider: spec.provider, model: targetModel ?? null, reason: 'handoff-retry', at },
    ];
    job.handedOffTo = nj.id;
    persist();
    emit('job-updated', job);
    emit('job-updated', nj);
    return get(nj.id);
  }

  function list() {
    const order = { running: 0, queued: 1, paused: 2 }; // paused 紧随活动项，提醒用户接续
    return [...jobs.values()]
      .sort((a, b) => (order[a.state] ?? 2) - (order[b.state] ?? 2) || String(b.queuedAt).localeCompare(String(a.queuedAt)))
      .map(serialize);
  }

  function get(id) {
    const job = jobs.get(id);
    return job ? serialize(job) : null;
  }

  /**
   * 优先读 runner 的 outLog，其次本进程捕获文件，最后内存 tailLines。
   *
   * ZB-26（审计 B4，安全）：**读取路径也必须做越界校验**（原先只有删除路径做了）。
   *   · `captureOut` 只允许落在 `dirLogs` —— 它是本进程在 `workRoot/logs` 下建的；
   *   · `outLog` 允许落在 `dirLogs` / `workRoot` / `runnerCwd` —— 真实 runner 把 out 日志写在
   *     项目根下（`<项目>/collab/logs/…`），而 runnerCwd 来自 config（可信），不是 jobs.json。
   * 越界的候选**跳过并留痕**（不静默），最终回落到内存 tailLines —— 与既有降级链一致。
   */
  function tail(id, n = 50) {
    const job = jobs.get(id);
    if (!job) return null;
    const count = Math.max(1, Number(n) || 50);
    const candidates = [
      { f: job.outLog, roots: allowedLogRoots, why: 'outLog' },
      { f: job.captureOut, roots: [dirLogs], why: 'captureOut' },
    ];
    for (const { f, roots, why } of candidates) {
      if (typeof f !== 'string' || f === '') continue;
      if (!roots.some((r) => isUnder(r, f))) {
        const note = `tail: 忽略越界的 ${why} 路径（不在允许的日志根内）：${String(f).slice(0, 160)}`;
        if (!Array.isArray(job.parseWarnings)) job.parseWarnings = [];
        if (!job.parseWarnings.includes(note) && job.parseWarnings.length < 20) job.parseWarnings.push(note);
        continue;
      }
      if (existsSync(f)) {
        try {
          const lines = readFileSync(f, 'utf8').split('\n');
          if (lines.length && lines[lines.length - 1] === '') lines.pop();
          return lines.slice(-count);
        } catch { /* 换下一个来源 */ }
      }
    }
    return (tails.get(id) ?? []).slice(-count);
  }

  function kill(id, reason = 'kill() called') {
    const job = jobs.get(id);
    if (!job || isTerminal(job)) return false;
    if (job.state === 'queued') {
      queue = queue.filter((q) => q !== id);
      job.state = 'killed';
      job.parseWarnings.push(reason);
      job.finishedAt = new Date(nowMs()).toISOString();
      persist();
      emit('job-updated', job);
      emit('queue-changed');
      return true;
    }
    killRequested.add(id);
    job.parseWarnings.push(reason);
    const child = children.get(id);
    if (child) {
      try {
        child.kill();
      } catch (e) {
        job.parseWarnings.push(`kill-failed: ${e.message}`);
        return false;
      }
    }
    emit('job-updated', job);
    return true;
  }

  function snapshot() {
    const counts = {};
    for (const j of jobs.values()) counts[j.state] = (counts[j.state] ?? 0) + 1;
    return {
      generatedAt: new Date(nowMs()).toISOString(),
      workRoot,
      maxConcurrent,
      counts,
      locks: {
        repo: existsSync(repoLockPath) ? readLockFile(repoLockPath) : null,
      },
      /* ZB-16：文件锁列表（UI「文件锁 / 记忆锁」分区展示它：哪个文件被哪个进程锁着）。
       * memory 锁已删除，故 locks 里不再有 memory 字段。 */
      fileLocks: listFileLocks(),
      queue: [...queue],
      jobs: list(),
    };
  }

  // 启动：清过期锁（含文件锁表 + 历史遗留的 memory.lock）→ 恢复状态 → 读通道/降级链
  sweepStaleLocks([repoLockPath, legacyMemoryLockPath], nowMs);
  sweepFileLocks();
  restore();
  loadChannelState();
  loadFallbackState();

  return {
    workRoot,
    jobsFile,
    lockPaths: { repo: repoLockPath }, // ZB-16：memory 已删除
    fileLockDir: join(dirLocks, FILE_LOCK_DIR), // ZB-08
    dispatch,
    list,
    get,
    tail,
    kill,
    snapshot,
    subscribe,
    restore,
    listFileLocks, // ZB-08：文件锁表（UI「单写者」分区改为展示它）
    lockBlockersFor, // ZB-08：某 spec 此刻被什么挡住（「为什么在排队」）
    // Z6：通道 / 续跑 / 降级链
    getChannel,
    setChannel,
    listChannels,
    retry,
    buildHandoffPrompt,
    setFallbackChain,
    setFallbackTarget, // ZB-30：面板入口（单目标：通道+模型+思考强度；null=关闭）
    getFallbackChain,
  };
}

export const __testables = {
  parseRunnerLine,
  isStaleLock,
  acquireLockFile,
  releaseLockFile,
  atomicWrite,
  LOCK_STALE_MS,
  classifyPause,
  parseProviderTable,
  PAUSE_SIGNATURES,
  AUTO_FALLBACK_REASONS,
};
