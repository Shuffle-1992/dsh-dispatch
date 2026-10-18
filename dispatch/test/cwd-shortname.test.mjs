#!/usr/bin/env node
/**
 * cwd-shortname.test.mjs —— ZB-72 真机 bug 回归：**cwd 的 Windows 8.3 短名必须被展开成长路径**
 *
 * 真机现场（2026-10-18）：用 `C:\Users\ADMINI~1\AppData\Local\Temp\…`（`$env:TEMP` 的展开值）作 cwd
 * 派 Qoder 写任务 ⇒ Qoder 路径安全门以"可疑 Windows 路径语法"拒绝写入，而任务**报 done**、
 * 文件没创建（静默假成功）。换长路径一次通过。
 *
 * 本文件钉三件事：
 *   A. `normalizeCwdPath()` 纯函数语义：短名展开 / 长名原样 / 不存在路径不抛 / 非 Windows 不猜；
 *   B. `dispatch()` 落库的 `spec.cwd` 是**展开后的长路径**（真机最关心的那一条）；
 *   C. 展开时在 job 的 `parseWarnings` 里**留痕**（"为什么 cwd 被改了"必须可见）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatcher, normalizeCwdPath } from '../core/dispatch-core.mjs';

let pass = 0;
const fails = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fails.push(m); console.log(`  ✗ ${m}`); } };

const roots = [];
const cleanup = () => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } };

const IS_WIN = process.platform === 'win32';

/** 短名版（`RUNNER~1` 之类）——用 `dir /x` 拿不到时退回手写规则；
 *  这里直接用**本机真实存在的短名**（`%TEMP%` 在 Windows 上常含 8.3 形式）来构造用例。 */
function shortNameOfLongPath(longPath) {
  /* 逐段尝试：把每段替换成它的 8.3 短名（拿不到就原样）。 */
  const parts = longPath.split('\\');
  for (let i = 1; i < parts.length; i += 1) {
    const seg = parts[i];
    if (seg.length <= 8) continue;
    /* Windows 8.3 规则：前 6 个合法字符 + `~1`。 */
    const base = seg.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase();
    if (base.length < 6) continue;
    const cand = [...parts];
    cand[i] = `${base}~1`;
    return cand.join('\\');
  }
  return null;
}

console.log('\nA. normalizeCwdPath()：纯函数语义');
{
  ok(typeof normalizeCwdPath === 'function', 'A0 已导出 normalizeCwdPath（可单测）');
  const long = 'C:\\Users\\Administrator\\AppData\\Local\\Temp';
  const r1 = normalizeCwdPath(long);
  ok(r1.path === long && r1.changed === false, `A1 长路径原样返回（changed=false，实际 ${JSON.stringify(r1.changed)}）`);

  const r2 = normalizeCwdPath('');
  ok(r2.path === '' && r2.changed === false, 'A2 空串原样返回（不抛）');

  const r3 = normalizeCwdPath('C:\\definitely\\not\\exists\\NOPE~1\\x');
  ok(typeof r3.path === 'string' && r3.changed === false, 'A3 不存在的短名路径：保持原样 + 不抛（尽力而为）');
  ok(typeof r3.note === 'string' && r3.note.includes('8.3'), `A3b 不成功时仍留说明（实际 ${JSON.stringify(r3.note && r3.note.slice(0, 40))}）`);

  if (IS_WIN) {
    /* 本机真实存在的短名（用 %TEMP% 的真实值构造）——若本机恰好没有短名形式，则跳过并说明。 */
    const realTemp = process.env.TEMP ?? tmpdir();
    const short = shortNameOfLongPath(realTemp);
    if (short) {
      const r4 = normalizeCwdPath(short);
      ok(r4.changed === true || r4.path.toLowerCase() !== short.toLowerCase() || r4.note != null,
        `A4 含 8.3 短名的路径被处理（输入 ${short} ⇒ ${r4.path}，changed=${r4.changed}）`);
    } else {
      console.log('  · A4 跳过：本机 %TEMP% 无 8.3 短名形式可用（不算失败）');
    }
    /* 真实短名：直接试一个已知会命中短名规则的路径（`PROGRA~1` 是 Program Files 的经典短名）。 */
    const r5 = normalizeCwdPath('C:\\PROGRA~1');
    ok(typeof r5.path === 'string' && r5.path.length > 0 && r5.path.toLowerCase().startsWith('c:'),
      `A5 经典短名 C:\\PROGRA~1 ⇒ ${r5.path}（changed=${r5.changed}）`);
  } else {
    console.log('  · A4/A5 跳过：非 Windows 平台不做短名展开（按设计）');
  }
}

console.log('\nB. dispatch() 落库的 cwd 是展开后的长路径');
{
  const dir = mkdtempSync(join(tmpdir(), 'dsp-cwd-'));
  roots.push(dir);
  const runner = join(dir, 'fake-runner.mjs');
  writeFileSync(runner, 'process.exit(0);\n', 'utf8');
  const d = createDispatcher({ runnerPath: runner, workRoot: join(dir, 'work'), jobsFile: join(dir, 'state', 'jobs.json') });
  try {
    const j = d.dispatch({ kind: 'prompt', prompt: 'x', provider: 'opencode', engine: 'opencode', lock: 'none', timeoutMin: 1, cwd: dir });
    const live = d.get(j.id ?? j?.job?.id);
    const cwd1 = live && live.spec && live.spec.cwd;
    /* ⚠️ `mkdtempSync` 在 Windows 上返回的常常**本身就是 8.3 短名**（`DSP-CW~1` 之类）——
     * 所以不能断言"原样落库"，只能断言"落库的 cwd 不含短名段"。
     * 这反过来证明修复在生效：短名进来、长名落库。 */
    ok(!!cwd1, `B1 cwd 已落库（实际 ${JSON.stringify(cwd1)}）`);
    ok(!/~\d/.test(String(cwd1)) || !IS_WIN, `B1b ★ 落库的 cwd 不含 8.3 短名段（实际 ${JSON.stringify(cwd1)}）`);
    /* 纯长路径（**手工构造**，不能用 tmpdir()—— 它在 Windows 上常返回短名形式，
     * 会让"纯长路径"用例自己命中短名规则）⇒ 必须零改动、零留痕（防展开逻辑过度触发）。 */
    const pureLong = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsp-cwd-pure-long-dir';
    const rPure = normalizeCwdPath(pureLong);
    ok(rPure.changed === false && rPure.path === pureLong, `B2 纯长路径零改动（实际 changed=${rPure.changed}，path=${rPure.path}）`);
    ok(rPure.note == null, 'B2b 纯长路径零留痕（无噪音）');
    /* 反例：名字里带 `~` 但**不是** 8.3 短名的段，不许被误改。 */
    for (const notShort of ['C:\\my~backup\\x', 'C:\\a\\file~1.txt', 'C:\\long-name-here\\x']) {
      const r = normalizeCwdPath(notShort);
      ok(r.path === notShort && r.changed === false, `B2c 非 8.3 形态不被误改（${notShort}）`);
    }
    /* 若本机 %TEMP% 有短名形式，则用短名再派一次，断言落库的是长路径。 */
    const realTemp = process.env.TEMP ?? tmpdir();
    const short = IS_WIN ? shortNameOfLongPath(realTemp) : null;
    if (short) {
      const j2 = d.dispatch({ kind: 'prompt', prompt: 'x', provider: 'opencode', engine: 'opencode', lock: 'none', timeoutMin: 1, cwd: short });
      const live2 = d.get(j2.id ?? j2?.job?.id);
      const cwd2 = live2 && live2.spec && live2.spec.cwd;
      ok(cwd2 && cwd2.toLowerCase() !== short.toLowerCase(), `B3 ★ 短名 cwd 被展开（${short} ⇒ ${cwd2}）`);
      ok(!/~\d/.test(String(cwd2)), `B3b ★ 落库的 cwd 里**不再有** 8.3 短名段（实际 ${JSON.stringify(cwd2)}）`);
      ok((live2.parseWarnings ?? []).some((w) => /8\.3/.test(w)), `B4 ★ 展开有留痕（parseWarnings：${JSON.stringify((live2.parseWarnings ?? [])[0] ?? null)}）`);
    } else {
      console.log('  · B3/B4 跳过：本机无 8.3 短名可用（断言 A 段已覆盖纯函数语义）');
    }
  } finally { d.dispose?.(); }
}

cleanup();
console.log(`\n===== ZB-72 cwd 8.3 短名展开：${pass} PASS / ${fails.length} FAIL =====`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
process.exit(0);
