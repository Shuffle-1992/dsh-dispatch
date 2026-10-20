#!/usr/bin/env node
/**
 * proactive-usage.test.mjs —— ZB-77 回归：**派发台开着时要"主动用"，而不只是"被叫才用"**
 *
 * 用户要求（2026-10-20）：「强化下提示词注入，派发台开着时，很好有主动使用的」。
 *
 * 问题诊断：旧文案只在用户说出**魔法词**（"派发 / 交给 ZCode / 让 ZCode 做"）时才触发；
 * 而真实竞争是**模型的默认习惯** —— 一遇到"独立子任务"就顺手用 DSH 自带的 `subagent`
 * （系统提示里已有的熟路）⇒ 派发台**再开着也想不起来**。
 *
 * 本文件钉住"主动用"的四个要件（缺一条就会退回"被叫才用"）：
 *   A. **判据**（什么情况属于该派发）—— 不能只列触发词；
 *   B. **正面点出竞争对象**（要调 subagent 时先停一下问判据）；
 *   C. **给出理由**（面板可见 / 独立额度与会话 / 落地唤醒）—— 让"主动用"有依据；
 *   D. **保留硬例外**（用户点名自己 / 开关关闭）—— 否则变成无条件优先会误伤。
 *   E. 三个注入面（system prompt 段 / 工具描述 / 工具首行）**都要有**，不能只改一处。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
const fails = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fails.push(m); console.log(`  ✗ ${m}`); } };

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, '..', 'index.js'), 'utf8');
/* 剥注释后判定：注释里提到某个说法**不算**实现了它（与既有纪律一致）。 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* 取出两段文本实体（system prompt 段 + 工具描述构造器） */
const spMatch = /const SYSTEM_PROMPT_SECTION = \[([\s\S]*?)\]\.join\('\\n'\);/.exec(code);
const spText = spMatch ? spMatch[1] : '';
const tdMatch = /const TOOL_DESCRIPTION_BODY = \[([\s\S]*?)\];/.exec(code);
const tdHeadMatch = /return \[\s*('[\s\S]*?')\s*,\s*('[\s\S]*?')/.exec(code);
const tdHead = tdHeadMatch ? `${tdHeadMatch[1]}\n${tdHeadMatch[2]}` : '';

console.log('\nA. 「判据」必须存在（不能只列魔法词）');
{
  ok(!!spMatch, 'A0 能取到 SYSTEM_PROMPT_SECTION 文本实体');
  ok(/什么时候该主动用|判据/.test(spText), 'A1 ★ system prompt 段含「判据」/「什么时候该主动用」');
  /* 四条判据必须都在（缺哪条都会漏掉一整类场景）。 */
  ok(/自包含|独立完成/.test(spText), 'A2 判据① 自包含/能独立完成');
  ok(/很久|几十秒/.test(spText), 'A3 判据② 跑很久');
  ok(/并行/.test(spText), 'A4 判据③ 并行推进');
  ok(/别的引擎|别的模型|ZCode \/ OpenCode \/ Qoder/.test(spText), 'A5 判据④ 用户提到别的引擎/模型');
  ok(/命中任一条/.test(spText), 'A6 ★ 明确"命中任一条 ⇒ 直接用"（不必等用户说"派发"）');
  /* 工具描述侧也要有判据（模型看工具时同样要看到）。 */
  ok(/判据/.test(tdHead) && /自包含/.test(tdHead) && /并行/.test(tdHead),
    'A7 ★ 工具描述首段同样含四条判据（两个面都要有）');
}

console.log('\nB. 正面点出竞争对象（真实失败模式：顺手用 subagent）');
{
  ok(/subagent/.test(spText), 'B1 system prompt 段点名 subagent');
  ok(/先停一下|先问一句|第一反应/.test(spText), 'B2 ★ 明确"要调 subagent 之前先停一下问判据"');
  ok(/看不见|面板里\*\*看不见\*\*/.test(spText), 'B3 给出"为什么别用自带手段"的理由（面板看不见）');
  ok(/先停一下|先问一句/.test(tdHead), 'B4 工具描述里同样有"调 subagent 前先停一下"');
}

console.log('\nC. 「主动用」要有依据（说清好处）');
{
  ok(/可监视|面板/.test(spText), 'C1 面板可监视');
  ok(/独立进程|独立额度|独立.*会话/.test(spText), 'C2 独立进程/额度/会话');
  ok(/自动唤醒|落地自动唤醒/.test(spText), 'C3 落地自动唤醒');
}

console.log('\nD. 硬例外必须保留（防"无条件优先"误伤）');
{
  ok(/例外/.test(spText), 'D1 保留「例外」小节');
  ok(/用户明确要你自己做|明确要你自己/.test(spText), 'D2 例外① 用户点名要你自己做');
  ok(/开关已关闭|ok:false/.test(spText), 'D3 例外② 开关关闭 / dispatch 返回 ok:false');
  ok(/除这两种情况外|默认优先派发台/.test(spText), 'D4 ★ 明确"除这两种情况外默认优先"（闭合判据）');
  ok(/说明原因/.test(spText), 'D5 退回自带手段时要说明原因（不静默切换）');
}

console.log('\nE. 三个注入面都强化了（只改一处 = 换个场景就失效）');
{
  ok(spText.length > 800, `E1 system prompt 段已强化（实际 ${spText.length} 字符，旧版约 560）`);
  ok(/判据|自包含/.test(tdHead), 'E2 工具描述首段强化');
  ok(/凡是"要另一个 agent 去做"的活|凡是.*要另一个 agent 去做/.test(tdHead),
    'E3 ★ 工具描述首句改为"默认走本工具"（不再是"用户说…才用"）');
  /* 注入顺序仍须排在 TOOL_SUBAGENT 之前（竞争对象之前先读到本段）。 */
  ok(/TOOL_JOBS/.test(code) && /base \+ 5|1605/.test(code), 'E4 段序仍紧随 TOOL_JOBS（1600+5，排在 TOOL_SUBAGENT 之前）');
  ok(/systemPromptHint !== false/.test(code), 'E5 注入开关语义不变（可用 config 关闭）');
}

console.log(`\n===== ZB-77 主动使用（强化提示词注入）：${pass} PASS / ${fails.length} FAIL =====`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
process.exit(0);
