// ZB-51 T4 测试：Qoder 执行器 `collab-kit/qoder-run.mjs`
//
// 三个层次：
//   ① **纯函数**（离线、无子进程）：参数拼接、权限模式映射、**回落检测（驼峰陷阱）**、模型名判据
//   ② **聚合器**（离线）：拿**真机抓包结构**喂 `createAggregator()`，覆盖 7 行事件谱 + 未登记类型 + 坏行
//   ③ **端到端**（离线，假 CLI）：把假 CLI 脚本喂给 `QODER_CLI`，跑真实 `runOnce` 流程
//
// 跑法：node dispatch/test/qoder-executor.test.mjs
//
// ⚠️ 本测试**不碰真机 Qoder**（不联网、不消耗额度）：所有子进程都是临时假脚本。
//    真机只读探测（--version / --list-models）由 `engine-discover.test.mjs` 与手工验收覆盖。
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildQoderArgs, decidePermissionMode, detectPermissionFallback, createAggregator,
  parseArgs, PERMISSION_MODE_REPORTED,
} from '../../collab-kit/qoder-run.mjs';
import { isQoderModelName, isQoderId, prefixFor } from '../../collab-kit/run-line-protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, '..', '..', 'collab-kit', 'qoder-run.mjs');
const tempDirs = [];
const newDir = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tempDirs.push(d); return d; };

let pass = 0; const fail = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const eq = (a, b, m) => ok(a === b, `${m}${a === b ? '' : `（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`}`);

console.log('① 协议层：Qoder 的 id 形态与模型名判据（真机模型名含空格与点）');
{
  eq(prefixFor('qoder'), '[qoder-run]', 'qoder 行前缀');
  ok(isQoderId('qoder/GLM-5.3'), 'qoder/GLM-5.3 是合法通道 id');
  ok(isQoderId('qoder/Qwen3.8-Max'), '★ qoder/Qwen3.8-Max（含点与连字符）合法');
  ok(isQoderId('qoder/DeepSeek-V4-Pro'), '★ qoder/DeepSeek-V4-Pro 合法');
  ok(isQoderId('qoder/MiniMax-M2.7'), '★ qoder/MiniMax-M2.7 合法');
  ok(!isQoderId('opencode/x'), 'opencode 通道不误判为 qoder');
  ok(!isQoderId('qoder/'), '空的模型名不合法');
  /* 模型名判据（用于过滤 --list-models 输出） */
  for (const good of ['Auto', 'Fast', 'Qwen3.8-Max', 'DeepSeek-V4-Pro', 'GLM-5.3', 'Kimi-K2.8-Preview', 'MiniMax-M2.7']) {
    ok(isQoderModelName(good), `模型名 ${good} 合法`);
  }
  for (const bad of ['', '   ', 'a/b', 'C:\\x\\y', 'x\ty', 'x'.repeat(80), '  ']) {
    ok(!isQoderModelName(bad), `非法模型名被拒：${JSON.stringify(bad.slice(0, 12))}`);
  }
}

console.log('\n② 参数拼接（纯函数）：只拼 Qoder 认识的东西');
{
  const base = { kind: 'prompt', prompt: 'hi', timeoutMin: 10 };
  const a = buildQoderArgs(base);
  eq(a[0], '-p', '-p = 非交互模式');
  eq(a[1], '-o', '-o = 输出格式');
  eq(a[2], 'stream-json', 'stream-json = NDJSON 事件流');
  ok(a.includes('--permission-mode') && a[a.indexOf('--permission-mode') + 1] === 'accept_edits',
    '★ 默认权限模式 = accept_edits（无头下能让写操作真的生效；default 会静默拒绝）');
  eq(a[a.length - 1], 'hi', '正文是**位置参数**（放最后，与 OpenCode 的 `run <msg>` 不同）');
  ok(!a.includes('--mode'), '绝不拼 --mode（Qoder 无此概念）');
  ok(!a.includes('--memory-bench'), '绝不拼 --memory-bench');
  ok(!a.includes('--provider'), '绝不拼 --provider');

  /* auto ⇒ bypass_permissions（**只有显式要求才全放行**） */
  eq(decidePermissionMode({ auto: true }), 'bypass_permissions', '★ auto:true ⇒ bypass_permissions');
  eq(decidePermissionMode({}), 'accept_edits', '★ 默认 ⇒ accept_edits（开箱即用）');
  eq(decidePermissionMode({ permissionMode: 'plan' }), 'plan', '显式 --permission-mode 优先于默认');

  /* 续跑 + 模型 + 思考强度 + add-dir */
  const r = buildQoderArgs({ kind: 'prompt', prompt: 'x', resume: 'ses_1', model: 'GLM-5.3', reasoningEffort: 'high', addDirs: ['C:\\proj'], maxTurns: 5 });
  ok(r.includes('--session-id') && r[r.indexOf('--session-id') + 1] === 'ses_1', '续跑用 --session-id');
  ok(r.includes('--model') && r[r.indexOf('--model') + 1] === 'GLM-5.3', '模型名原样透传（含点/空格）');
  ok(r.includes('--reasoning-effort') && r[r.indexOf('--reasoning-effort') + 1] === 'high', '★ 思考强度 = --reasoning-effort（不是 --variant）');
  ok(r.includes('--add-dir') && r[r.indexOf('--add-dir') + 1] === 'C:\\proj', 'add-dir 声明受信任目录');
  ok(r.includes('--max-turns') && r[r.indexOf('--max-turns') + 1] === '5', '--max-turns 透传');
}

console.log('\n③ 权限回落检测（**真机驼峰陷阱**：accept_edits 回传的是 acceptEdits）');
{
  eq(PERMISSION_MODE_REPORTED.accept_edits, 'acceptEdits', '★ CLI 值 accept_edits ⇄ 回传 acceptEdits');
  eq(PERMISSION_MODE_REPORTED.bypass_permissions, 'bypassPermissions', 'bypass_permissions ⇄ bypassPermissions');
  eq(PERMISSION_MODE_REPORTED.dont_ask, 'dontAsk', 'dont_ask ⇄ dontAsk');

  const noFallback = detectPermissionFallback('accept_edits', 'acceptEdits');
  ok(noFallback.fellBack === false, '★ 驼峰比对正确 ⇒ **不误报**回落（这正是修复的那个坑）');
  eq(noFallback.warning, null, '正常时不产出 warning');

  const fell = detectPermissionFallback('accept_edits', 'default');
  ok(fell.fellBack === true, '★ 回传 default ⇒ 判定为回落');
  ok(/受信任/.test(fell.warning) && /目录/.test(fell.warning), '回落 warning 说明原因是目录不受信任');
  ok(/静默/.test(fell.warning), '★ 回落 warning 点明"写操作会被静默拒绝"这个真实后果');

  const unknown = detectPermissionFallback('accept_edits', null);
  ok(unknown.fellBack === false, '读不到 permissionMode 时**不判定**回落（不猜）');
  ok(/无法确认/.test(unknown.warning), '但要明确说明"无法确认"（不谎报已生效）');
}

console.log('\n④ 聚合器：真机抓包结构（7 行事件谱）');
{
  /* 真机抓到的实际事件谱（结构照抄自 ZB-50 §8.3，值做了匿名化）。 */
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'hook_started', uuid: 'u1', session_id: 'ses_q1', hook: 'x' }),
    JSON.stringify({
      type: 'system', subtype: 'init', uuid: 'u2', session_id: 'ses_q1',
      qodercli_version: '1.1.73', protocol_version: '1.5.0', cwd: 'C:\\proj', model: 'GLM-5.3',
      permissionMode: 'acceptEdits', // ← 驼峰，真机事实
      tools: ['Read', 'Write', 'Bash'], agents: [], skills: [], capabilities: [],
    }),
    JSON.stringify({ type: 'system', subtype: 'artifacts_update', uuid: 'u3', session_id: 'ses_q1' }),
    JSON.stringify({ type: 'system', subtype: 'hook_response', uuid: 'u4', session_id: 'ses_q1' }),
    JSON.stringify({ type: 'assistant', uuid: 'u5', session_id: 'ses_q1', content: [{ type: 'thinking', thinking: '让我想想' }] }),
    JSON.stringify({ type: 'assistant', uuid: 'u6', session_id: 'ses_q1', content: [{ type: 'text', text: 'PONG' }] }),
    JSON.stringify({
      type: 'result', uuid: 'u7', session_id: 'ses_q1', subtype: 'success', is_error: false,
      result: 'PONG', num_turns: 2, duration_ms: 4321, total_credits: 3,
      usage: { input_tokens: 0, output_tokens: 0, context_usage_ratio: 0.012 },
      permission_denials: [], modelUsage: { 'GLM-5.3': { inputTokens: 0 } },
    }),
  ];
  const agg = createAggregator();
  for (const l of lines) agg.handleLine(l);
  const s = agg.summary();

  eq(s.sessionId, 'ses_q1', '每行都带 session_id ⇒ 能取到');
  eq(s.model, 'GLM-5.3', '模型从 init 取到');
  eq(s.permissionMode, 'acceptEdits', '★ 权限模式取自 init.permissionMode（驼峰原值）');
  eq(s.qoderVersion, '1.1.73', 'CLI 版本从 init 取到');
  eq(s.protocolVersion, '1.5.0', '协议版本从 init 取到');
  eq(s.response, 'PONG', '★ 正文只取 assistant 的 text（thinking 不计入）');
  eq(s.responseChars, 4, 'responseChars 正确');
  eq(s.isError, false, 'is_error=false');
  eq(s.numTurns, 2, 'num_turns 取到');
  eq(s.durationMs, 4321, 'duration_ms 取到');
  eq(s.totalCredits, 3, '★ total_credits 取到（真机 token 字段全 0，这才是真计量）');
  eq(s.contextRatio, 0.012, '★ context_usage_ratio 取到');
  ok(Array.isArray(s.permissionDenials) && s.permissionDenials.length === 0, 'permission_denials 取到（空数组）');
  eq(s.parseErrorCount, 0, '无解析错误');
  /* 未登记类型（hook_* / artifacts_update）必须**降级透明**：不抛、不落 warning */
  eq(s.unknownEventCount, 0, '★ hook_started/artifacts_update/hook_response 是**已知生命周期事件**，不记未知');
  eq(s.warnings.length, 0, '★ 全流程零 warning（真机这些类型都会出现）');
  eq(s.eventCounts['system/hook_started'], 1, '事件计数按 type/subtype 归类');
  eq(s.eventCounts['assistant'], 2, 'assistant 计 2 次');
}

console.log('\n⑤ 聚合器：坏行与真正未知类型**绝不止损**（硬约束）');
{
  const agg = createAggregator();
  agg.handleLine('not json at all');                              // 坏行
  agg.handleLine('{"type":"totally_new_thing","x":1}');           // 真正未知类型
  agg.handleLine('');                                             // 空行
  agg.handleLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }));
  const s = agg.summary();
  eq(s.parseErrorCount, 1, '坏行记 1 次解析错误');
  /* 坏行**同时**算"未登记事件"（它确实是无法识别的内容）⇒ 共 2 次：坏行 + 未知类型。 */
  eq(s.unknownEventCount, 2, '未登记事件计 2 次（坏行 1 + 未知类型 1）');
  ok(s.warnings.some((w) => /JSON 解析失败/.test(w)), '坏行落可读 warning');
  eq(s.response, 'OK', '★ 坏行之后仍能正常收到 result（不中止整轮）');
  ok(s.unknownEvents.length > 0, '未知事件原文留档（供事后分析）');
}

console.log('\n⑤b `user`（工具结果回灌）是**正常生命周期事件**，不算"未登记"');
{
  /* 真机证据（写文件任务 j-mvbfoh3y / 2026-10-17）：日志里出现
   * `1 个未登记事件类型（已降级忽略）：{"type":"user","message":{"role":"user",
   *  "content":[{"type":"tool_result","tool_use_id":…}]}}` —— 那是**工具调用完成后把结果回给模型**，
   * 属正常生命周期，不该报"未登记"（否则每个用工具的任务都带一条噪音 warning）。 */
  const agg = createAggregator();
  agg.handleLine(JSON.stringify({
    type: 'user', session_id: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  }));
  agg.handleLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  const s = agg.summary();
  eq(s.unknownEventCount, 0, '★ user/tool_result 不计入"未登记事件"');
  eq(s.warnings.length, 0, '★ 也不落 warning');
  eq(s.response, 'done', '正常收尾不受影响');
  eq(s.eventCounts.user, 1, '仍按类型计数（便于观测，不丢失信息）');
}

console.log('\n⑥ 参数解析：明确不支持的参数 fail-fast（绝不静默忽略）');
{
  ok(parseArgs(['--prompt', 'x']).kind === 'prompt', '--prompt ⇒ kind=prompt');
  ok(parseArgs(['--task', 'p.md']).kind === 'task', '--task ⇒ kind=task');
  ok(parseArgs(['--target', 'goal']).kind === 'target', '--target ⇒ kind=target');
  let e1 = null; try { parseArgs(['--mode', 'edit']); } catch (e) { e1 = e; }
  ok(e1 && /不支持 --mode/.test(e1.message), '★ --mode ⇒ fail-fast 报错');
  let e2 = null; try { parseArgs(['--memory-bench']); } catch (e) { e2 = e; }
  ok(e2 && /memory-bench/.test(e2.message), '★ --memory-bench ⇒ fail-fast 报错');
  let e3 = null; try { parseArgs(['--bogus']); } catch (e) { e3 = e; }
  ok(e3 && /未知参数/.test(e3.message), '未知参数 ⇒ 报错');
  /* provider 兼容令牌：只接受 qoder 系 */
  ok(parseArgs(['--prompt', 'x', '--provider', 'qoder']).compatNotes.length >= 1, '--provider qoder 记说明后忽略');
  let e4 = null; try { parseArgs(['--prompt', 'x', '--provider', 'plan']); } catch (e) { e4 = e; }
  ok(e4 && /只接受 qoder/.test(e4.message), '★ --provider plan ⇒ 可读报错（不静默丢参）');
}

console.log('\n⑦ 端到端：假 CLI 走完整 runOnce（含权限回落报警与 result 文件）');
{
  const dir = newDir('dsp-qoder-e2e-');
  const fakeCli = join(dir, 'fake-qoder.cjs');
  /* 假 CLI：吐一份**真机同构**的 stream-json 流；模拟"权限被回落"（回传 default）以便验证报警。 */
  writeFileSync(fakeCli, [
    `const args = process.argv.slice(2);`,
    `const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');`,
    `if (args.includes('--version')) { process.stdout.write('1.1.73\\n'); process.exit(0); }`,
    `if (args.includes('--list-models')) { process.stdout.write('GLM-5.3\\nQwen3.8-Max\\nAuto\\n'); process.exit(0); }`,
    `out({ type:'system', subtype:'init', session_id:'ses_fake', qodercli_version:'1.1.73', model:'GLM-5.3', permissionMode:'default', tools:['Read'] });`,
    `out({ type:'assistant', session_id:'ses_fake', content:[{ type:'text', text:'DONE' }] });`,
    `out({ type:'result', session_id:'ses_fake', subtype:'success', is_error:false, result:'DONE', num_turns:1, total_credits:1, usage:{ context_usage_ratio:0.01 }, permission_denials:[] });`,
    `process.exit(0);`,
  ].join('\n'), 'utf8');

  const env = { ...process.env, QODER_CLI: fakeCli };
  const r = spawnSync(process.execPath, [RUNNER, '--prompt', 'x', '--tag', 'e2e', '--cwd', dir, '--timeout-min', '1'],
    { env, encoding: 'utf8', timeout: 60000 });

  eq(r.status, 0, `端到端退出码 0（stderr: ${(r.stderr ?? '').slice(0, 200)}）`);
  const so = r.stdout ?? '';
  ok(so.includes('[qoder-run] done exit=0'), '★ 打了 done 行（core 据此收尾）');
  ok(so.includes('session=ses_fake'), 'done 行带 sessionId');
  ok(so.includes('responseChars=4'), 'done 行带 responseChars');
  ok(so.includes('[qoder-run] permission-mode-requested=accept_edits reported=default FELLBACK'),
    '★ 权限回落被**明确标注**（FELLBACK）—— 这是真机最危险的静默陷阱');
  ok(/权限模式被回落/.test(r.stderr ?? ''), '★ stderr 给出可操作的回落说明');
  ok(/受信任/.test(r.stderr ?? ''), '说明里含"受信任目录"这个修复方向');
  ok(so.includes('[qoder-run] credits total=1'), '★ credits 单独上报（token 字段不可信的替代）');

  /* result.json 必须落盘且结构完整 */
  const logsDir = join(dir, 'collab', 'logs');
  ok(existsSync(logsDir), 'result 目录已创建');
  const names = existsSync(logsDir) ? readdirSync(logsDir) : [];
  if (names.length) {
    const j = JSON.parse(readFileSync(join(logsDir, names[0]), 'utf8'));
    eq(j.response, 'DONE', 'result.json 里的 response');
    eq(j.permissionMode.requested, 'accept_edits', 'result.json 记录请求的权限模式');
    eq(j.permissionMode.reported, 'default', 'result.json 记录实际回传值');
    eq(j.permissionMode.fellBack, true, '★ result.json 记录回落判定（可审计）');
    eq(j.usage.totalCredits, 1, 'result.json 记录 credits');
    eq(j.responseChars, 4, 'result.json 记录 responseChars');
  } else {
    ok(false, 'result.json 未生成');
  }
}

console.log('\n⑧ 端到端：默认权限模式（不回落的正常路径）');
{
  const dir = newDir('dsp-qoder-ok-');
  const fakeCli = join(dir, 'fake-qoder-ok.cjs');
  writeFileSync(fakeCli, [
    `const args = process.argv.slice(2);`,
    `const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');`,
    `if (args.includes('--list-models')) { process.stdout.write('Auto\\n'); process.exit(0); }`,
    `out({ type:'system', subtype:'init', session_id:'s2', model:'Auto', permissionMode:'acceptEdits', tools:[] });`,
    `out({ type:'assistant', session_id:'s2', content:[{ type:'text', text:'hi' }] });`,
    `out({ type:'result', session_id:'s2', is_error:false, result:'hi', num_turns:1 });`,
    `process.exit(0);`,
  ].join('\n'), 'utf8');
  const r = spawnSync(process.execPath, [RUNNER, '--prompt', 'x', '--tag', 'ok', '--cwd', dir, '--timeout-min', '1'],
    { env: { ...process.env, QODER_CLI: fakeCli }, encoding: 'utf8', timeout: 60000 });
  eq(r.status, 0, '正常路径退出码 0');
  ok((r.stdout ?? '').includes('reported=acceptEdits'),
    '★ 回传 acceptEdits ⇒ 正确识别为**未回落**（不再误报）');
  ok(!/FELLBACK/.test(r.stdout ?? ''), '★ 正常路径不打 FELLBACK');
  ok(!/权限模式被回落/.test(r.stderr ?? ''), '正常路径不产回落 warning');
}

console.log('\n⑨ 端到端：--auto 的可审计告知行（core 据此置 autoApproved）');
{
  const dir = newDir('dsp-qoder-auto-');
  const fakeCli = join(dir, 'fake-qoder-auto.cjs');
  writeFileSync(fakeCli, [
    `const args = process.argv.slice(2);`,
    `const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');`,
    `const pm = args.includes('--permission-mode') ? args[args.indexOf('--permission-mode') + 1] : 'default';`,
    `out({ type:'system', subtype:'init', session_id:'s3', permissionMode: pm === 'bypass_permissions' ? 'bypassPermissions' : pm });`,
    `out({ type:'result', session_id:'s3', is_error:false, result:'ok', num_turns:1 });`,
    `process.exit(0);`,
  ].join('\n'), 'utf8');
  const r = spawnSync(process.execPath, [RUNNER, '--prompt', 'x', '--tag', 'a', '--cwd', dir, '--timeout-min', '1', '--auto'],
    { env: { ...process.env, QODER_CLI: fakeCli }, encoding: 'utf8', timeout: 60000 });
  const so = r.stdout ?? '';
  ok(so.includes('auto=on（已映射为 --permission-mode bypass_permissions'),
    '★ 打了 core 认识的 `auto=on` 告知行（可审计）');
  ok(so.includes('permission-mode-requested=bypass_permissions'), '请求的是 bypass_permissions');
  ok(so.includes('reported=bypassPermissions'), '★ 驼峰回传正确匹配 ⇒ 不误报回落');
  ok(!/FELLBACK/.test(so), '★ auto 路径也不误报');
}

console.log('\n⑩ 发现失败：QODER_CLI 指向不存在文件 ⇒ 可读报错 + 给出修复方式');
{
  const r = spawnSync(process.execPath, [RUNNER, '--prompt', 'x', '--timeout-min', '1'],
    { env: { ...process.env, QODER_CLI: join(tmpdir(), 'definitely-not-here-qoder.exe') }, encoding: 'utf8', timeout: 30000 });
  ok(r.status !== 0, `失败退出（实际 ${r.status}）`);
  ok(/指向的文件不存在/.test(r.stderr ?? ''), '报出 QODER_CLI 指向的文件不存在');
  ok(!/null/.test(r.stderr ?? ''), '错误里不出现 null（对用户可读）');
}

for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }

console.log(`\n===== Qoder 执行器：${pass} PASS / ${fail.length} FAIL =====`);
for (const m of fail) console.log(`  ✗ ${m}`);
process.exit(fail.length ? 1 : 0);
