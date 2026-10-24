/**
 * ZB-115 回归：审查 MED 三连修
 *
 * 来源：GLM-5.3 审查报告的 MED 项（已核实为真）：
 *   ① `APPLIED_MAPPER[e](m)` 无兜底 —— 两张并行表（APPLIED_RE_OF / APPLIED_MAPPER）只靠约定同步，
 *      漏一张就在**热路径**（每行都过）抛 `is not a function`；
 *   ② `parseWarnings` **无上限** —— tailLines 有 TAIL_CAP=200，它没有，行格式漂移时随 jobs.json 无界膨胀；
 *   ③ `startCodebuddyLogin` 并发调用双 spawn —— 两个调用双双通过开头的 stop（此时仍 null），
 *      各自 spawn，后到者覆盖 cbLoginSession ⇒ 先到者的登录服务进程**泄漏**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = readFileSync(join(HERE, '..', 'core', 'dispatch-core.mjs'), 'utf8');

/* ── ① APPLIED_MAPPER 兜底 ── */
test('ZB-115 ①：APPLIED_MAPPER 取值有兜底（漏表不再热路径抛错）', () => {
  assert.match(CORE, /const APPLIED_MAPPER = \{/, '映射表存在');
  /* 不能是裸调用 APPLIED_MAPPER[e](m) */
  assert.doesNotMatch(CORE, /return APPLIED_MAPPER\[e\]\(m\);/, '★ 不能裸调用（会抛 is not a function）');
  assert.match(CORE, /const mapper = APPLIED_MAPPER\[e\];/, '先取值');
  assert.match(CORE, /return mapper \? mapper\(m\) : \{\};/, '★ 取不到就返回空对象');
});

/* ── ② parseWarnings 上限 ── */
test('ZB-115 ②：parseWarnings 有上限且在唯一出口（persist）截断', () => {
  assert.match(CORE, /const PARSE_WARNINGS_CAP = \d+;/, '★ 有上限常量');
  const cap = Number(CORE.match(/const PARSE_WARNINGS_CAP = (\d+);/)[1]);
  assert.ok(cap > 0 && cap <= 200, `上限值合理（${cap}）`);
  /* 截断必须发生在 persist 里（唯一统一出口），保留最近的 */
  const persistFn = CORE.match(/function persist\(\) \{([\s\S]*?)atomicWrite\(jobsFile/);
  assert.ok(persistFn, '能取出 persist 主体');
  assert.match(persistFn[1], /parseWarnings\.length > PARSE_WARNINGS_CAP/, '★ persist 里判超限');
  assert.match(persistFn[1], /parseWarnings = j\.parseWarnings\.slice\(-PARSE_WARNINGS_CAP\)/, '★ 保留最近的 N 条');
});

/* ── ③ 登录启动并发去重 ── */
test('ZB-115 ③：startCodebuddyLogin 并发去重（复用进行中的 Promise）', () => {
  assert.match(CORE, /let cbLoginInFlight = null;/, '★ 有 in-flight 变量');
  const startFn = CORE.match(/async function startCodebuddyLogin\(\) \{([\s\S]{0,600}?)cbLoginInFlight = \(async \(\) => \{/);
  assert.ok(startFn, '能取出 start 开头');
  assert.match(startFn[1], /if \(cbLoginInFlight\) return cbLoginInFlight;/, '★ 进行中直接复用');
  /* 收尾必须有 try/finally 清空（否则失败后永远复用同一个 rejected Promise） */
  assert.match(CORE, /try \{\s*return await cbLoginInFlight;\s*\} finally \{\s*cbLoginInFlight = null;\s*\}/, '★ finally 清空');
  /* stop 也要清，否则 stop 后的新调用会挂旧 Promise */
  const stopFn = CORE.match(/function stopCodebuddyLogin\(\) \{([\s\S]{0,400}?)if \(!s\) return/);
  assert.ok(stopFn, '能取出 stop 开头');
  assert.match(stopFn[1], /cbLoginInFlight = null;/, '★ stop 清 in-flight');
});

/* ── ④ 四个 buildArgs 共用公共段（消除四份逐字复制） ── */
test('ZB-116 ④：四个执行器的参数构造共用 buildKindArgs / buildTailArgs', () => {
  /* 公共段必须存在且各被四个引擎引用 —— 否则又回到"复制四份必然漂移" */
  assert.match(CORE, /function buildKindArgs\(spec, opts = \{\}\)/, 'kind 公共段存在');
  assert.match(CORE, /function buildTailArgs\(spec\)/, 'tail 公共段存在');
  for (const fn of ['buildRunnerArgs', 'buildOpenCodeArgs', 'buildQoderArgs', 'buildCodebuddyArgs']) {
    const m = CORE.match(new RegExp(`function ${fn}\\(spec, opts = \\{\\}\\) \\{([\\s\\S]*?)\\r?\\n  \\}`));
    assert.ok(m, `能取出 ${fn} 主体`);
    assert.match(m[1], /buildKindArgs\(spec, opts\)/, `★ ${fn} 用 buildKindArgs`);
    assert.match(m[1], /buildTailArgs\(spec\)/, `★ ${fn} 用 buildTailArgs`);
    /* 反向：不能再自己拼 kind 段（--task / --prompt 不该出现在引擎函数里） */
    assert.doesNotMatch(m[1], /args\.push\('--prompt'/, `★ ${fn} 不再自己拼 --prompt`);
    assert.doesNotMatch(m[1], /args\.push\('--task'/, `★ ${fn} 不再自己拼 --task`);
  }
  /* 引擎差异必须**保留**：思考强度参数名各不相同 */
  assert.match(CORE, /'--reasoning-level', spec\.reasoningLevel/, 'ZCode 用 --reasoning-level');
  assert.match(CORE, /'--variant', spec\.reasoningLevel/, 'OpenCode 用 --variant');
  assert.match(CORE, /'--reasoning-effort', spec\.reasoningLevel/, 'Qoder 用 --reasoning-effort');
  assert.match(CORE, /'--effort', spec\.reasoningLevel/, 'CodeBuddy 用 --effort');
});
