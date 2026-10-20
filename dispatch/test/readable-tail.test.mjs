#!/usr/bin/env node
/**
 * readable-tail.test.mjs —— ZB-81 用户反馈回归：**进行时输出要能读懂**
 *
 * 现场（用户截图，2026-10-20）：输出区把 runner 心跳行**原样堆**出来：
 * ```
 * [qoder-run] progress stage=run elapsed=1763s chars=1261 tools=135 stageAgo=0s session=a4066594-8a86-4faa-9dec-6849190e54b7
 * [qoder-run] progress stage=run elapsed=1773s chars=1261 tools=135 stageAgo=0s session=a4066594-8a86-4faa-9dec-6849190e54b7
 * ```
 * 相邻两行**只差 elapsed**，其余逐字相同 ⇒ 一屏 30 行全是同一件事。
 * 用户原话：「可阅读性基本为零，改成可以阅读获得一定信息的」。
 *
 * 本文件钉住可读化层的三条规则（缺一条就会退回"堆原始行"）：
 *   A. **折叠同质心跳**：stage/chars/tools/session 都没变 ⇒ 合并成一行并记「×N」+ elapsed 区间；
 *   B. **变化单独成行**：stage 变了 / chars 或 tools 增长 ⇒ 分开显示（那才是"进展"）；
 *   C. **非心跳行原样保留**：done/错误/真实输出**绝不改写、绝不丢**（排障靠它们）。
 *   D. 未知 stage 原样显示（不猜、不隐藏）；空输入返回空串（不炸）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync as rf } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fails.push(m); console.log(`  ✗ ${m}`); } };

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* 把 client.js 里的 readableTail 与它依赖的文案表切出来，在沙箱里求值 —— 不写测试专用仿制品。 */
const fnSrc = /function readableTail\(lines\) \{[\s\S]*?\n    \}/.exec(code);
const stageSrc = /const STAGE_LABEL_KEY = \{[\s\S]*?\};/.exec(code);
const zh = rf(join(HERE, '..', 'locale', 'zh.json'), 'utf8');
const en = rf(join(HERE, '..', 'locale', 'en.json'), 'utf8');
ok(!!fnSrc, 'A0 能从 client.js 取到 readableTail（改名请同步本测试锚点）');
ok(!!stageSrc, 'A0b 能取到 STAGE_LABEL_KEY（stage 人话标签表）');

let readableTail = null;
try {
  /* ⚠️ `tFmt` 必须**从源码里切出来**用真实实现 —— 别在沙箱里手抄一份：
   * 手抄时正则转义极易走样（实测踩到：`{n}` 没被替换，于是"折叠计数"断言假绿/假红）。 */
  const tFmtSrc = /const tFmt = [^;]+;/.exec(code)?.[0];
  ok(!!tFmtSrc, 'A0d 能从 client.js 取到真实 tFmt（占位符替换实现）');
  const sandbox = new Function(`
    const t = (k) => (${JSON.stringify(JSON.parse(zh).ui)}[k] ?? k);
    ${tFmtSrc}
    ${stageSrc[0]}
    ${fnSrc[0]}
    return readableTail;
  `);
  readableTail = sandbox();
} catch (e) { ok(false, `A0c readableTail 求值失败：${e?.message ?? e}`); }

const HB = (elapsed, chars, tools, stage = 'run', lastTool = null, sess = 'a4066594-8a86-4faa-9dec-6849190e54b7') =>
  `[qoder-run] progress stage=${stage} elapsed=${elapsed}s chars=${chars} tools=${tools}${lastTool ? ` lastTool=${lastTool}` : ''} stageAgo=0s session=${sess}`;

if (readableTail) {
  console.log('\nA. 折叠同质心跳（用户截图那一屏 30 行）');
  {
    /* 复刻用户截图：10 行 stage=run / chars=1261 / tools=135，只有 elapsed 递增。 */
    const lines = Array.from({ length: 10 }, (_, i) => HB(1763 + i * 10, 1261, 135));
    const out = readableTail(lines);
    const outLines = out.split('\n').filter(Boolean);
    ok(outLines.length === 1, `A1 ★ 10 行同质心跳折叠成 1 行（实际 ${outLines.length} 行）——用户截图里是一屏 30 行`);
    ok(/运行中/.test(out), `A2 stage=run 显示成人话「运行中」（实际「${out}」）`);
    ok(/1261/.test(out) && /135/.test(out), 'A3 保留 chars/tools 数值（信息不丢）');
    ok(/1763s/.test(out) && /1853s/.test(out), 'A4 ★ elapsed 显示成区间（首→尾），"持续了多久"一眼可见');
    ok(/×10|10 次/.test(out), `A5 ★ 明确标注重复次数（实际「${out}」）—— 一眼看出是重复而非发生了 10 件事`);
    /* 折叠后必须**短得多**（否则等于没折叠）。 */
    ok(out.length < lines.join('\n').length / 3, `A6 ★ 输出体积显著变小（${lines.join('\n').length} → ${out.length} 字符）`);
  }

  console.log('\nB. 变化必须单独成行（那才是"进展"）');
  {
    /* stage 变化 */
    const t1 = readableTail([HB(10, 0, 0, 'spawn'), HB(20, 0, 0, 'waiting-turn')]);
    ok(t1.split('\n').filter(Boolean).length === 2, `B1 stage 变化 ⇒ 分成 2 行（实际 ${t1.split('\n').filter(Boolean).length}）`);
    ok(/启动中/.test(t1) && /等首字/.test(t1), 'B2 两个 stage 各自显示人话');
    /* chars/tools 增长 */
    const t2 = readableTail([HB(10, 100, 1), HB(20, 200, 2), HB(30, 200, 2)]);
    const l2 = t2.split('\n').filter(Boolean);
    ok(l2.length === 2, `B3 chars/tools 增长 ⇒ 新行；之后同值再折叠（实际 ${l2.length} 行）`);
    ok(/100/.test(l2[0]) && /200/.test(l2[1]), 'B4 增长前后的数值都在（进展可见）');
    /* 不同 session 不许混成一行 */
    const t3 = readableTail([HB(10, 1, 1, 'run', null, 'ses_A'), HB(20, 1, 1, 'run', null, 'ses_B')]);
    ok(t3.split('\n').filter(Boolean).length === 2, `B5 ★ 不同 session 不合并（实际 ${t3.split('\n').filter(Boolean).length} 行）`);
  }

  console.log('\nC. 非心跳行原样保留（排障靠它们，绝不改写）');
  {
    const real = [
      '[qoder-run] tag=x mode=prompt cwd=.',
      HB(10, 5, 1),
      '这是模型的真实回答：你好，世界',
      '[qoder-run] done exit=0 elapsed=12.3s session=ses_abc',
      'error: something failed',
    ];
    const out = readableTail(real);
    for (const line of [real[0], real[2], real[3], real[4]]) {
      ok(out.includes(line), `C1 ★ 原样保留：「${line.slice(0, 44)}」`);
    }
    ok(out.split('\n').length === 5, `C2 真实行一行不少（实际 ${out.split('\n').filter(Boolean).length} 行）`);
  }

  console.log('\nD. 边界：未知 stage / 空输入 / 非数组');
  {
    const t = readableTail([HB(10, 1, 1, 'some-new-stage')]);
    ok(/some-new-stage/.test(t), 'D1 未知 stage 原样显示（不猜、不隐藏）');
    ok(readableTail([]) === '', 'D2 空数组 ⇒ 空串');
    ok(readableTail(null) === '', 'D3 null ⇒ 空串（不炸）');
    ok(readableTail(undefined) === '', 'D4 undefined ⇒ 空串');
    /* 心跳行里带 lastTool 时要显示 */
    ok(/最近工具.*Write|Write/.test(readableTail([HB(10, 1, 1, 'run', 'Write')])), 'D5 lastTool 显示出来');
  }

  console.log('\nE. 接线：渲染处必须真的用它（否则函数再好也不生效）');
  {
    ok(/readableTail\(tail\.lines\)/.test(code), 'E1 ★ 渲染处调用 readableTail（不再是 tail.lines.join）');
    ok(!/tail\.lines\.join\('\\\\n'\)/.test(code), 'E2 ★ 旧的原始 join 已移除（防回退）');
    /* 文案三处同步（client zh/en + locale zh/en）。 */
    const z = JSON.parse(zh).ui; const e = JSON.parse(en).ui;
    for (const k of ['hbElapsed', 'hbChars', 'hbTools', 'hbLastTool', 'hbRepeat']) {
      ok(!!z[k] && !!e[k], `E3 locale 中英都有 ${k}`);
    }
    for (const k of ['hbStageSpawn', 'hbStageRun', 'hbStageWaiting', 'hbStageDone']) {
      ok(!!z[k] && !!e[k], `E4 locale 中英都有 ${k}`);
    }
  }
}

console.log(`\n===== ZB-81 进行时输出可读化：${pass} PASS / ${fails.length} FAIL =====`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
process.exit(0);
