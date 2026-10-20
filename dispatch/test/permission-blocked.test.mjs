#!/usr/bin/env node
/**
 * permission-blocked.test.mjs —— ZB-76 真机误诊回归：**"工具权限未放行"不是沙箱限制**
 *
 * 真机现场（2026-10-20）：某会话报告「Qoder CLI 的沙箱只能读写工作区内的文件，网络和编译会被拦，
 * 所以前两个调研任务没有产出实质内容」⇒ **据此放弃派发、改为亲自做**。
 *
 * 实测证伪（同一任务：写文件 + node --version + WebFetch + WebSearch）：
 *   · 默认 `accept_edits`：写文件 ✅、Bash ✅、WebFetch ❌（`Error: Fetch https://…?`）、WebSearch ❌（`Allow searching the web?`）
 *   · `auto:true`（→ `bypass_permissions`）：**4/4 全成功**
 * ⇒ 那是**权限待审批**（可修），不是"沙箱限制"（不可修）。误诊的代价是**白白放弃能力**。
 *
 * 本文件钉三件事：
 *   A. 暂停分类认得"权限未放行"的原文（core 能看到 ⇒ 有可读原因 + 可执行指引）；
 *   B. 执行器把它显式写 stderr（core 的 classifyPause 只看 stdout/stderr，不看 result.json）；
 *   C. 面板有对应的可读文案（三处 locale/STRINGS 同步）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __testables } from '../core/dispatch-core.mjs';

let pass = 0;
const fails = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fails.push(m); console.log(`  ✗ ${m}`); } };

const PAUSE_SIGNATURES = __testables.PAUSE_SIGNATURES;

const HERE = dirname(fileURLToPath(import.meta.url));
const coreSrc = readFileSync(join(HERE, '..', 'core', 'dispatch-core.mjs'), 'utf8');
const qoderSrc = readFileSync(join(HERE, '..', '..', 'collab-kit', 'qoder-run.mjs'), 'utf8');
const clientSrc = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
const zh = JSON.parse(readFileSync(join(HERE, '..', 'locale', 'zh.json'), 'utf8')).ui;
const en = JSON.parse(readFileSync(join(HERE, '..', 'locale', 'en.json'), 'utf8')).ui;

console.log('\nA. 暂停分类：真机原文必须命中 permission-blocked');
{
  const sig = PAUSE_SIGNATURES.find((s) => s.reason === 'permission-blocked');
  ok(!!sig, 'A1 存在 permission-blocked 暂停分类');
  /* 真机实测的四条原文（逐字取自 WebFetch/WebSearch/Bash 的报错） */
  const realTexts = [
    'Error: Fetch https://example.com?',
    'Error: Allow searching the web?',
    'Allow Bash to run `npm --version`?',
    'This action needs your approval',
    'The tool use was denied',
  ];
  for (const tx of realTexts) {
    const hit = (sig?.patterns ?? []).some((re) => re.test(tx));
    ok(hit, `A2 ★ 命中真机原文：「${tx.slice(0, 46)}」`);
  }
  /* 不许误伤：普通内容不该被判成权限问题（否则每个任务都 paused）。 */
  const safeTexts = ['任务完成，已创建 README.md', 'node --version 输出 v24.14.1', 'the web is a nice place'];
  for (const tx of safeTexts) {
    const hit = (sig?.patterns ?? []).some((re) => re.test(tx));
    ok(!hit, `A3 不误报普通内容：「${tx.slice(0, 40)}」`);
  }
  /* 关键判据：它**不进**自动降级链（换通道治不了权限，只会白烧额度）。 */
  const autoFb = /const AUTO_FALLBACK_REASONS = new Set\(\[([^\]]*)\]\)/.exec(coreSrc);
  ok(autoFb && !/permission-blocked/.test(autoFb[1]),
    'A4 ★ permission-blocked **不**进 AUTO_FALLBACK_REASONS（换通道治不了权限）');
}

console.log('\nB. 执行器把"权限未放行"显式写 stderr（core 只读 stdout/stderr）');
{
  ok(/PERM_PROMPT_RE/.test(qoderSrc), 'B1 执行器有权限提示识别正则');
  ok(/工具权限未放行/.test(qoderSrc), 'B2 ★ 执行器写出可读的"工具权限未放行"说明');
  ok(/process\.stderr\.write\(`\$\{PREFIX\} 工具权限未放行/.test(qoderSrc),
    'B3 ★ 走 **stderr**（core 的 classifyPause 只看 stdout/stderr，不看 result.json）');
  /* 指引必须**可执行**：告诉用户怎么修（auto:true），而不是只说"失败了"。 */
  ok(/auto:true/.test(qoderSrc) && /bypass_permissions/.test(qoderSrc),
    'B4 ★ 说明里给出可执行的修法（auto:true → bypass_permissions）');
  /* 必须点明"不是沙箱限制"—— 这正是真机误诊点。 */
  ok(/不是\*\*沙箱限制|不是\*\*沙箱/.test(qoderSrc) || /不是\*\*沙箱限制/.test(qoderSrc),
    'B5 ★ 明确否认"沙箱限制"这一误诊（真机就栽在这句话上）');
}

console.log('\nC. 面板可读文案（三处同步）');
{
  ok(/'permission-blocked': 'pPerm'/.test(clientSrc), 'C1 PAUSE_LABEL_KEY 映射 permission-blocked → pPerm');
  ok(/pPerm: '工具权限未放行'/.test(clientSrc), 'C2 client STRINGS.zh 有文案');
  ok(/pPerm: 'Tool permission not granted'/.test(clientSrc), 'C3 client STRINGS.en 有文案');
  ok(zh.pPerm === '工具权限未放行', `C4 locale/zh.json 同步（实际 ${JSON.stringify(zh.pPerm)}）`);
  ok(en.pPerm === 'Tool permission not granted', `C5 locale/en.json 同步（实际 ${JSON.stringify(en.pPerm)}）`);
}

console.log('\nD. 教学文档写清了能力边界（用户要求"教学不到位"要修）');
{
  const teach = readFileSync(join(HERE, '..', 'teaching.md'), 'utf8');
  ok(/Qoder 的真实能力边界/.test(teach), 'D1 教学有「Qoder 的真实能力边界」一节');
  ok(/写文件.*正常|写文件（工作区内）/.test(teach), 'D2 ★ 明确说"写文件正常"（破除"只能读写工作区"的误解）');
  ok(/auto: true/.test(teach) && /bypass_permissions/.test(teach), 'D3 给出修法 auto:true');
  ok(/不是\*\*引擎能力不足\*\*|不是.*引擎能力不足/.test(teach), 'D4 ★ 明确"不是引擎能力不足"（防再次放弃派发）');
  ok(/误诊/.test(teach), 'D5 记录了这个误诊（可被后来者检索到）');
}

console.log(`\n===== ZB-76 权限未放行 ≠ 沙箱限制：${pass} PASS / ${fails.length} FAIL =====`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
process.exit(0);
