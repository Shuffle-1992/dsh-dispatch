#!/usr/bin/env node
/**
 * cross-check.test.mjs —— **客户端 ↔ 宿主契约的交叉核对**（执行 3 / 审计 A-R3 + F1）
 *
 * 为什么单独一个文件：这些是**跨半边的数据一致性**，不属于任何单侧的"源码形状测试"。
 * 客户端半边是纯脚本（无模块系统、不能 import 宿主代码），所以两侧的常量**只能各写一份**；
 * 一旦宿主侧改了、客户端没跟，就会出现"面板显示的值与宿主行为不一致"这类**静默错误**
 * （历史上真实发生过：可关闭状态集 / 引擎集 / 暂停原因都各漂过）。
 *
 * 本文件只做**数据断言**（取两侧真实值比对），不钉源码字面形状 —— 因此不会阻碍重构。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINES } from '../../collab-kit/run-line-protocol.mjs';
import { SETTLED_STATES, __testables } from '../core/dispatch-core.mjs';
import { createRemoteFace } from '../wire.host.mjs';

/* `AUTO_FALLBACK_REASONS` 不是公开导出（它是内部判据），走 core 的 `__testables` 取真身。 */
const AUTO_FALLBACK_REASONS = __testables.AUTO_FALLBACK_REASONS;
/* ZB-76：F4 的**权威原因集**必须取自 `PAUSE_SIGNATURES`（宿主**真正会产生**的全部暂停原因），
 * 而不是只看"会自动降级的那些" —— 后者会漏掉 `permission-blocked`（它**故意不进**降级链：
 * 换通道治不了权限），于是"客户端多了一个标签"这条守门会**误报**。
 * 教训：守门的基准必须来自"宿主会产生什么"，而不是"宿主会对什么自动动作"。 */
const PAUSE_SIGNATURES = __testables.PAUSE_SIGNATURES;

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'client.js');
const src = readFileSync(CLIENT, 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const code = stripComments(src);

let pass = 0;
const fails = [];
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); }
  else { fails.push(msg); console.log(`  ✗ ${msg}`); }
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : `（实际 ${JSON.stringify(a)} / 期望 ${JSON.stringify(b)}）`}`);

/* ── 取客户端真实值（从源码里切出定义、在沙箱里求值 —— 不写测试专用仿制品） ─────────── */
const KNOWN_ENGINES_SRC = code.match(/const KNOWN_ENGINES = \[[^\]]*\];/)?.[0];
ok(!!KNOWN_ENGINES_SRC, 'C0 能从 client.js 取到 KNOWN_ENGINES 定义（若改名请同步本测试的锚点）');

/* 客户端 job 状态表是"单一源"（执行 3 / 审计 R1）：JOB_STATE_META → DISMISSABLE_STATES。
 * 从源码切出这一段原样求值，得到的才是**客户端真正在用的**集合。 */
const STATE_META_SRC = code.match(/const JOB_STATE_META = \{[\s\S]*?\r?\n {4}const TV_PILL = \[[^\n]*\n/)?.[0];
ok(!!STATE_META_SRC, 'C1 能从 client.js 取到状态表（JOB_STATE_META → TV_PILL 段）');

const PAUSE_KEY_SRC = code.match(/const PAUSE_LABEL_KEY = \{[^\n]*\n/)?.[0] ?? code.match(/const PAUSE_LABEL_KEY = \{[^\n]*\};/)?.[0];
ok(!!PAUSE_KEY_SRC, 'C2 能从 client.js 取到 PAUSE_LABEL_KEY 定义');

let client = {};
try {
  const sandbox = new Function(`${KNOWN_ENGINES_SRC}
${STATE_META_SRC}
${PAUSE_KEY_SRC}
    return { KNOWN_ENGINES, JOB_STATES, DISMISSABLE_STATES, PAUSE_LABEL_KEY };`);
  client = sandbox();
} catch (e) {
  ok(false, `C3 客户端常量求值失败：${e?.message ?? e}`);
}
if (client.KNOWN_ENGINES) {
  /* ── F2：引擎集 ─────────────────────────────────────────────────────── */
  eq(client.KNOWN_ENGINES, [...ENGINES],
    'F2 客户端 KNOWN_ENGINES 与宿主权威 ENGINES（collab-kit/run-line-protocol.mjs）逐字一致');

  /* ── F3：可关闭状态集 ───────────────────────────────────────────────── */
  const clientSettled = [...(client.DISMISSABLE_STATES ?? [])].sort();
  const hostSettled = [...SETTLED_STATES].sort();
  eq(clientSettled, hostSettled,
    'F3 客户端「可关闭」状态集 === 宿主 core.SETTLED_STATES（面板显示"能关"而宿主拒绝，就是这条漂了）');

  /* ── F4：暂停原因 ───────────────────────────────────────────────────── */
  /* 权威集 = 宿主 `PAUSE_SIGNATURES` 里**全部**原因（它才是"宿主会产生什么"）。
   * 保留 AUTO_FALLBACK_REASONS ∪ {config-error} 的并集，避免旧版 core 无 PAUSE_SIGNATURES 时退化。 */
  const sigReasons = Array.isArray(PAUSE_SIGNATURES) ? PAUSE_SIGNATURES.map((s) => s.reason) : [];
  const reasons = [...new Set([...AUTO_FALLBACK_REASONS, 'config-error', ...sigReasons])].sort();
  const missing = reasons.filter((r) => !(r in (client.PAUSE_LABEL_KEY ?? {})));
  ok(missing.length === 0,
    `F4 宿主的暂停原因在客户端都有中文标签（缺：${missing.join(',') || '无'}）`);
  const extra = Object.keys(client.PAUSE_LABEL_KEY ?? {}).filter((k) => !reasons.includes(k));
  ok(extra.length === 0, `F4b 客户端没有多出宿主不产生的暂停原因（多：${extra.join(',') || '无'}）`);
}

/* ── F1：remote 方法面「表里有、实现无」守门（审计 A，最高性价比） ─────────────────
 * 历史事故（ZB-52）：方法名加进了方法表，但 `createRemoteFace` 实例上没有对应方法 ⇒
 * 面板 `remote.call('x')` 抛错被 catch 成默认值 ⇒ 用户看到"开关永远是关的"，且**没有任何报错**。
 * 这里直接对**真实例**做反射：描述符里声明的方法，必须都在实例上是 function。 */
{
  let face = null;
  try {
    face = createRemoteFace({ list: () => [], get: () => null }, {});
  } catch (e) {
    ok(false, `F1a createRemoteFace 构造失败（桩依赖就够了，不该依赖真 dispatcher）：${e?.message ?? e}`);
  }
  if (face) {
    /* 描述符挂在原型上（typert 的 mark() 落盘形状）：按"值像 { version, methods: [...] }"找，
     * 不依赖它的键名（键名是实现细节，改名不该让本测试红）。 */
    const proto = Object.getPrototypeOf(face);
    const candidates = [...Object.getOwnPropertyNames(proto), ...Object.getOwnPropertySymbols(proto)]
      .map((k) => { try { return proto[k]; } catch { return null; } })
      .filter((v) => v && typeof v === 'object' && typeof v.version === 'number' && Array.isArray(v.methods));
    ok(candidates.length === 1, `F1b 找到唯一的 remote 方法描述符（找到 ${candidates.length} 个）`);
    const methods = candidates[0]?.methods?.map((m) => m.method) ?? [];
    ok(methods.length >= 15, `F1c 描述符声明了 ${methods.length} 个方法`);
    const notFn = methods.filter((m) => typeof face[m] !== 'function');
    ok(notFn.length === 0, `F1 每个声明的方法在真实例上都是 function（缺：${notFn.join(',') || '无'}）`);
    /* 反向：实例上的公开方法也该都在描述符里（否则 typert/客户端发现不到它）。 */
    const own = Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor' && typeof face[k] === 'function');
    const undeclared = own.filter((k) => !methods.includes(k));
    ok(undeclared.length === 0, `F1d 实例上没有"未声明"的公开方法（多：${undeclared.join(',') || '无'}）`);
  }
}

console.log(`\n===== 客户端↔宿主 cross-check：${pass} PASS / ${fails.length} FAIL =====`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
