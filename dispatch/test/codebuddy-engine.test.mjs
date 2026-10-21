#!/usr/bin/env node
/**
 * codebuddy-engine.test.mjs —— ZB-84：**WorkBuddy / CodeBuddy 第四引擎**接入回归
 *
 * 为什么走官方 CLI（用户 2026-10-21 决策）：WorkBuddy 已开始限制"把账号登录态反代成
 * OpenAI/Anthropic 兼容接口"这类用法；官方 CLI 是产品自身入口，不受此类限制影响。
 * 本引擎**不读写任何 WorkBuddy 凭据**，只 spawn 官方进程。
 *
 * 本文件钉住的东西（每条都对应真机事实或已踩过的坑）：
 *   A. 协议层：`codebuddy/<model>` ⇒ engine=codebuddy；裸名 `codebuddy`/`workbuddy` 也认；
 *      `normalizeEngineSpec` 无条件剥 `codebuddy/` 前缀（CLI 的 `--model` 要**裸名**）。
 *   B. 执行器纯函数：模型清单/档位**从 CLI 自己的 --help 解析**（不写死枚举）；
 *      argv 形态（`-p --output-format stream-json`）；权限模式默认 acceptEdits、`--auto` ⇒
 *      bypassPermissions；`agent` ⇒ 不传 --effort；权限回落判定；无扩展名 node 脚本要前置 node。
 *   C. stream-json 聚合：init/assistant/result 的字段（含 `errors` 数组 —— 未登录的**唯一出处**）。
 *   D. ★**端到端**：真机实测"CLI 进程退出码恒为 0，即使 result.is_error=true"。
 *      故必须验证：假 CLI 打一条 error_during_execution 然后 **exit 0** ⇒
 *      执行器必须 **exit 1**（否则 core 会把失败当成功收尾），且 stderr 给出可读的 /login 指引。
 *   E. core 集成：路由到 codebuddy、`done` 解析、暂停分类 `not-logged-in`、
 *      validateSpec 拒 mode / 收 auto、独立并发上限默认 2 且可配。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createDispatcher } from '../core/dispatch-core.mjs';
import { ENGINES, inferEngine, normalizeEngineSpec, isCodebuddyId, isCodebuddyModelName, prefixFor } from '../../collab-kit/run-line-protocol.mjs';
import * as R from '../../collab-kit/codebuddy-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, '..', '..', 'collab-kit', 'codebuddy-run.mjs');

let pass = 0;
const fails = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fails.push(m); console.log(`  ✗ ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}（实际 ${JSON.stringify(a)}）`);

const roots = [];
const cleanup = () => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitState = async (d, id, states, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const j = d.get(id);
    if (j && states.includes(j.state)) return j;
    if (Date.now() - t0 > ms) return d.get(id);
    await sleep(25);
  }
};

/* ─────────────────────────── A. 协议层 ─────────────────────────── */
console.log('\nA. 协议层：第四引擎 codebuddy');
{
  ok(ENGINES.includes('codebuddy'), 'ENGINES 含 codebuddy');
  eq(prefixFor('codebuddy'), '[codebuddy-run]', '行前缀 = [codebuddy-run]');
  ok(isCodebuddyId('codebuddy/glm-5.1'), 'codebuddy/glm-5.1 是合法通道 id（模型名含点）');
  ok(isCodebuddyId('codebuddy/deepseek-v3-2-volc'), 'codebuddy/deepseek-v3-2-volc 是合法通道 id');
  ok(!isCodebuddyId('codebuddy/'), '空模型名不是合法通道 id');
  ok(isCodebuddyModelName('auto'), 'auto 是合法裸模型名');
  ok(!isCodebuddyModelName('bad/name'), '含路径分隔符的不是合法模型名（防把日志行当模型）');

  eq(inferEngine({ provider: 'codebuddy/glm-5.1' }), 'codebuddy', 'provider 形态 ⇒ 推断为 codebuddy');
  eq(inferEngine({ provider: 'codebuddy' }), 'codebuddy', '裸 provider=codebuddy（已规整的 spec）⇒ codebuddy');
  eq(inferEngine({ provider: 'workbuddy' }), 'codebuddy', '裸 provider=workbuddy ⇒ codebuddy');

  /* ★ 关键：CLI 的 --model 要**裸模型名**；传完整通道 id 会造成
   * "模型名不认识 ⇒ 静默退回 auto"（Qoder 踩过的同类坑）。故两种传法都必须剥前缀。 */
  eq(normalizeEngineSpec({ provider: 'codebuddy/glm-5.1' }).model, 'glm-5.1', 'provider 形态 ⇒ model 被剥成裸名');
  eq(normalizeEngineSpec({ provider: 'codebuddy', model: 'codebuddy/kimi-k2.5' }).model, 'kimi-k2.5', '★ 显式 model 带前缀同样被剥（否则 CLI 静默退 auto）');
  eq(normalizeEngineSpec({ provider: 'codebuddy/glm-5.1' }).provider, 'codebuddy', 'provider 规整为裸 codebuddy');
}

/* ───────────────────── B. 执行器纯函数（不 spawn） ───────────────────── */
console.log('\nB. 执行器：探测 / argv / 权限模式');
{
  /* 真实 help 片段（2026-10-21 真机抓包，v2.161.0）。**测试不写死模型清单的行为**，
   * 只验证"能从这种格式里解析出来"—— 清单本身由 CLI 声明，随版本变。 */
  const help = [
    '  --model <model>   Model for the current session. Please provide the model ID. Currently supported: (auto, glm-5v-turbo, glm-5.1, glm-5.0-turbo, glm-5.0, glm-4.7, kimi-k2.5, minimax-m2.7, deepseek-v3-2-volc)',
    '  --effort <level>  Reasoning effort level (minimal, low, medium, high, xhigh, max)',
  ].join('\n');
  eq(R.parseHelpModels(help).length, 9, '从 --help 的 `Currently supported:` 解析出 9 个模型');
  eq(R.parseHelpModels(help)[0], 'auto', '模型顺序按 CLI 声明（auto 在首位）');
  eq(R.parseHelpEfforts(help), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], '从 --help 解析出 6 个思考档位');
  eq(R.parseHelpModels('没有该声明的文本'), [], '★ 解析不到 ⇒ 空数组（绝不编造模型清单）');
  eq(R.parseHelpEfforts('没有该声明的文本'), [], '★ 解析不到 ⇒ 空数组（绝不编造档位）');

  /* argv：`-p --output-format stream-json` 是铁打的前两位；正文必须**最后**（可能以 - 开头）。 */
  const a1 = R.buildCodebuddyArgs({ prompt: 'do it', model: 'glm-5.1', effort: 'high', addDirs: ['C:\\x'], resume: 's1' });
  ok(a1[0] === '-p' && a1[1] === '--output-format' && a1[2] === 'stream-json', 'argv 前三位 = -p --output-format stream-json');
  ok(a1.includes('--effort') && a1[a1.indexOf('--effort') + 1] === 'high', '档位映射为 --effort');
  ok(a1.includes('--model') && a1[a1.indexOf('--model') + 1] === 'glm-5.1', '模型透传为 --model');
  ok(a1.includes('--session-id') && a1[a1.indexOf('--session-id') + 1] === 's1', '续跑用 --session-id');
  eq(a1[a1.length - 1], 'do it', '★ 正文在最后（避免被当成选项）');

  eq(R.decidePermissionMode({}), 'acceptEdits', '默认权限模式 = acceptEdits（无头下可改工作目录内文件）');
  eq(R.decidePermissionMode({ auto: true }), 'bypassPermissions', '--auto ⇒ bypassPermissions（仅显式要求）');
  eq(R.decidePermissionMode({ permissionMode: 'accept_edits' }), 'acceptEdits', 'snake_case 输入归一为 CLI 的驼峰值');
  eq(R.decidePermissionMode({ permissionMode: 'dontAsk' }), 'dontAsk', 'CLI 自带档 dontAsk 原样透传');

  const fb0 = R.detectPermissionFallback('acceptEdits', 'acceptEdits');
  ok(!fb0.fellBack, 'acceptEdits 回传 acceptEdits ⇒ 未回落');
  const fb1 = R.detectPermissionFallback('bypassPermissions', 'default');
  ok(fb1.fellBack, '★ 请求 bypassPermissions 实际 default ⇒ 判定回落（写操作可能被静默拒绝）');
  ok(/回落/.test(fb1.warning ?? ''), '回落时给出可读 warning');

  /* 无扩展名的 node 脚本必须前置 node（WorkBuddy 的 bin/codebuddy 就是这种形态）。 */
  const dir = mkdtempSync(join(tmpdir(), 'dsp-cb-'));
  roots.push(dir);
  const nodeScript = join(dir, 'fake-codebuddy');
  writeFileSync(nodeScript, '#!/usr/bin/env node\nprocess.exit(0);\n', 'utf8');
  const t = R.spawnTarget(nodeScript, ['--version']);
  ok(t.cmd === process.execPath && t.argv[0] === nodeScript, '★ 无扩展名 + node shebang ⇒ 前置 node（Windows 不能直接 spawn）');
  const plain = join(dir, 'plain.txt');
  writeFileSync(plain, 'not a script', 'utf8');
  const t2 = R.spawnTarget(plain, []);
  ok(t2.cmd !== process.execPath || t2.argv[0] !== plain, '非 node 脚本不被误当脚本执行');
}

/* ─────────────────── C. stream-json 聚合（含 errors） ─────────────────── */
console.log('\nC. stream-json 聚合器');
{
  const agg = R.createAggregator();
  agg.handleLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'auto', permissionMode: 'acceptEdits', apiKeySource: 'www.workbuddy.cn', tools: ['Bash', 'Read'] }));
  agg.handleLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '想一想' }, { type: 'text', text: '你好' }] } }));
  agg.handleLine(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: '你好', duration_ms: 12, num_turns: 2,
    usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
    modelUsage: { 'glm-5.1': { contextWindow: 168000, maxOutputTokens: 32000 } },
    permission_denials: [], errors: [], total_cost_usd: 0.01, session_id: 's1',
  }));
  const s = agg.summary();
  eq(s.sessionId, 's1', 'session_id 被捕获');
  eq(s.permissionMode, 'acceptEdits', 'init.permissionMode（驼峰）被捕获');
  eq(s.apiKeySource, 'www.workbuddy.cn', 'apiKeySource 被捕获（账号区域线索）');
  eq(s.response, '你好', 'result.result 是权威正文');
  eq(s.thinkingBlocks, 1, 'thinking 内容块被计数（档位是否生效的唯一可观测信号）');
  eq([s.tokens.in, s.tokens.out, s.tokens.cacheRead], [5, 7, 3], '真实 token 被采集');
  eq(s.contextWindow, 168000, 'contextWindow 来自 result.modelUsage');
  eq(s.isError, false, 'is_error=false');

  /* 未登录：**errors 数组**是唯一出处（stdout 里是一行 JSON，不解析就看不到）。 */
  const agg2 = R.createAggregator();
  agg2.handleLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Authentication required. Please use /login command to sign in to your account'], usage: {} }));
  const s2 = agg2.summary();
  eq(s2.isError, true, 'is_error=true 被识别');
  ok(s2.errors.length === 1 && /Authentication required/.test(s2.errors[0]), '★ errors[] 被采集（未登录的可读原因）');

  /* 坏行 / 未知类型绝不止损整轮。 */
  const agg3 = R.createAggregator();
  agg3.handleLine('{ 这不是 JSON');
  agg3.handleLine(JSON.stringify({ type: 'brand_new_event' }));
  const s3 = agg3.summary();
  ok(s3.parseErrorCount === 1, '坏 JSON 行只记 parseError，不抛');
  ok(s3.unknownEventCount >= 1, '未知事件类型被计数（降级透明）');
}

/* ───────── D. ★ 端到端：CLI exit 0 但任务失败 ⇒ 执行器必须 exit 1 ───────── */
console.log('\nD. 端到端：假 CLI（result.is_error=true 且进程 exit 0）');
{
  const dir = mkdtempSync(join(tmpdir(), 'dsp-cbe2e-'));
  roots.push(dir);
  /* 假 CLI：完全模仿真机行为 —— 打一条错误 result，然后**正常退出（code 0）**。 */
  const fakeCli = join(dir, 'fake-wb-cli.mjs');
  writeFileSync(fakeCli, [
    'const lines = [',
    "  { type: 'system', subtype: 'init', session_id: 'sess-x', model: 'auto', permissionMode: 'acceptEdits', tools: ['Bash'] },",
    "  { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Authentication required. Please use /login command to sign in to your account'], usage: {} },",
    '];',
    'for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");',
    'process.exit(0); // ★ 真机实测：即使任务失败，CLI 进程退出码仍是 0',
  ].join('\n'), 'utf8');

  const r = spawnSync(process.execPath, [RUNNER, '--prompt', '只回复 OK', '--timeout-min', '1'], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: { ...process.env, CODEBUDDY_CLI: fakeCli },
  });
  ok(r.status === 1, `★ 任务失败必须让执行器 exit 1（实际 exit=${r.status}）—— 否则 core 会把失败当成功收尾`);
  ok(/未登录/.test(r.stderr ?? ''), 'stderr 给出可读的「未登录」原因（不是 unknown 失败）');
  ok(/\/login/.test(r.stderr ?? ''), 'stderr 含可执行的 /login 指引');
  ok(/\[codebuddy-run\] done exit=1/.test(r.stdout ?? ''), '协议行 done exit=1（core 据此 finalize 为失败/paused）');
  ok(/permission-mode-requested=acceptEdits reported=acceptEdits/.test(r.stdout ?? ''), '权限模式回显且未回落');
}

/* ─────────────────── E. core 集成：路由 / 暂停 / 校验 / 并发 ─────────────────── */
console.log('\nE. core 集成');
/** 建过的 dispatcher 都记下来 —— 收尾前要等它们把在途 job 落完，
 *  否则 rmSync 删掉临时目录后，异步 finalize 的 atomicWrite 会 ENOENT 抛穿（实测踩到）。 */
const dispatchers = [];
{
  const dir = mkdtempSync(join(tmpdir(), 'dsp-cbcore-'));
  roots.push(dir);

  /** 正常结束的假执行器（打 start + done，exit 0）。 */
  const okRunner = join(dir, 'ok-runner.mjs');
  writeFileSync(okRunner, [
    "const a = process.argv.slice(2);",
    "const tag = (a.indexOf('--tag') >= 0) ? a[a.indexOf('--tag') + 1] : '(none)';",
    "console.log(`[codebuddy-run] tag=${tag} mode=codebuddy cwd=${process.cwd()}`);",
    "console.log('[codebuddy-run] effort=high model=glm-5.1');",
    "console.log('[codebuddy-run] done exit=0 elapsed=0.1s session=s9 model=glm-5.1 responseChars=2');",
    'process.exit(0);',
  ].join('\n'), 'utf8');

  /** 未登录的假执行器（打 auth 文案到 stderr + done exit=1）。 */
  const authRunner = join(dir, 'auth-runner.mjs');
  writeFileSync(authRunner, [
    "const a = process.argv.slice(2);",
    "const tag = (a.indexOf('--tag') >= 0) ? a[a.indexOf('--tag') + 1] : '(none)';",
    "console.log(`[codebuddy-run] tag=${tag} mode=codebuddy cwd=${process.cwd()}`);",
    "process.stderr.write('[codebuddy-run] CLI 未登录：Authentication required. Please use /login command to sign in to your account\\n');",
    "console.log('[codebuddy-run] done exit=1 elapsed=0.1s responseChars=0');",
    'process.exit(1);',
  ].join('\n'), 'utf8');

  const mk = (runner, extra = {}) => {
    const d = createDispatcher({
      runnerPath: runner, codebuddyRunnerPath: runner, opencodeRunnerPath: '', qoderRunnerPath: '',
      workRoot: dir,
      channelsImpl: async () => ({ channels: [], warnings: [] }),
      ...extra,
    });
    dispatchers.push(d);
    return d;
  };

  /* E1 路由：provider 形态 ⇒ engine=codebuddy，真的 spawn 的是 codebuddy 执行器。 */
  {
    const d = mk(okRunner);
    const j = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', tag: 'cb1', provider: 'codebuddy/glm-5.1' });
    eq(j.engine, 'codebuddy', 'provider=codebuddy/glm-5.1 ⇒ job.engine=codebuddy');
    eq(j.spec.model, 'glm-5.1', '★ spec.model 是裸名（CLI 的 --model 要裸名）');
    const f = await waitState(d, j.id, ['done', 'failed', 'paused']);
    eq(f.state, 'done', '假执行器 exit 0 ⇒ done');
    eq(f.reasoningLevelApplied, 'high', '★ effort 行解析进 reasoningLevelApplied（面板显示实际档位）');
  }

  /* E2 暂停分类：未登录必须归为 `not-logged-in`（不是 failed/unknown）。 */
  {
    const d = mk(authRunner);
    const j = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', tag: 'cb2', provider: 'codebuddy/glm-5.1' });
    const f = await waitState(d, j.id, ['paused', 'failed', 'done']);
    eq(f.state, 'paused', '未登录 ⇒ paused（可修，不是 failed）');
    eq(f.pauseReason, 'not-logged-in', '★ pauseReason=not-logged-in（可读原因，用户知道只需登录）');
  }

  /* E3 validateSpec：codebuddy 无 mode；auto 允许（映射到 bypassPermissions）。 */
  {
    const d = mk(okRunner);
    let threw = null;
    try { d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', provider: 'codebuddy/glm-5.1', mode: 'edit' }); } catch (e) { threw = e; }
    ok(threw && /不支持 mode/.test(threw.message), '★ codebuddy 传 mode ⇒ 可读报错（不静默丢弃用户意图）');
    let okAuto = null;
    try { okAuto = d.dispatch({ kind: 'prompt', prompt: 'x', lock: 'none', provider: 'codebuddy/glm-5.1', auto: true }); } catch (e) { okAuto = e; }
    ok(okAuto && !(okAuto instanceof Error), 'codebuddy 接受 auto:true（映射 --permission-mode bypassPermissions）');
  }

  /* E4 独立并发上限：默认 2 且可按 option 覆盖（配置字段必须真的生效，不能是摆设）。 */
  {
    const d = mk(okRunner);
    eq(d.engineLimits.codebuddy, 2, '默认 maxConcurrentCodebuddy = 2（保守默认，未做并发实测）');
    const d3 = mk(okRunner, { maxConcurrentCodebuddy: 5 });
    eq(d3.engineLimits.codebuddy, 5, '★ maxConcurrentCodebuddy 配置真的生效（不是摆设）');
    ok(d.engineLimits.zcode !== d.engineLimits.codebuddy || d.engineLimits.zcode === 3, 'codebuddy 与 zcode 分开计数');
  }
}

/* ─────────────────── F. ZB-87：登录助手（协议面 + 可读错误） ─────────────────── */
console.log('\nF. 登录助手（ZB-87）');
{
  /* ① 参数解析：`--login-serve` / `--port`（登录服务的启动契约）。 */
  const o = R.parseArgs(['--login-serve', '--port', '12345']);
  ok(o.loginServe === true && o.port === 12345, 'parseArgs 支持 --login-serve / --port');

  /* ② core 暴露三件套；**未启动时 status 必须给可读错误**（不是抛、不是假装已登录）。 */
  const dir = mkdtempSync(join(tmpdir(), 'dsp-cblogin-'));
  roots.push(dir);
  const noop = join(dir, 'noop.mjs');
  writeFileSync(noop, 'process.exit(0);\n', 'utf8');
  const disc = createDispatcher({
    runnerPath: noop, codebuddyRunnerPath: noop, opencodeRunnerPath: '', qoderRunnerPath: '',
    workRoot: dir,
    channelsImpl: async () => ({ channels: [], warnings: [] }),
  });
  dispatchers.push(disc);
  ok(typeof disc.startCodebuddyLogin === 'function', 'dispatcher 暴露 startCodebuddyLogin');
  ok(typeof disc.codebuddyLoginStatus === 'function', 'dispatcher 暴露 codebuddyLoginStatus');
  ok(typeof disc.stopCodebuddyLogin === 'function', 'dispatcher 暴露 stopCodebuddyLogin');
  const st = await disc.codebuddyLoginStatus();
  ok(st.ok === false && /未启动/.test(String(st.error ?? '')), '★ 未启动时 status 给可读错误（不抛、不假装已登录）');
  eq(disc.stopCodebuddyLogin(), { ok: true, stopped: false }, 'stop 幂等（没会话也不报错）');

  /* ③ 宿主协议面：action 与 face 方法都必须登记（否则面板按钮调不到）。 */
  const wire = await import('../wire.host.mjs');
  ok(wire.ACTIONS.includes('login'), '★ ACTIONS 含 login（否则 wire 直接报"未知 action"）');
  ok(Array.isArray(wire.REMOTE_METHODS) && wire.REMOTE_METHODS.includes('login'), '★ REMOTE_METHODS 含 login（否则客户端 wire 调不到）');
}

/* 收尾：等所有在途 job 落地，再删临时目录（否则异步 finalize 会写到已删目录）。 */
for (const d of dispatchers) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const inflight = d.list().filter((j) => j.state === 'running' || j.state === 'queued');
    if (inflight.length === 0) break;
    await sleep(50);
  }
}
/* ─────────────── G. 插件详情页登录条（源码级回归锁，ZB-87） ─────────────── */
console.log('\nG. 登录条位置与数据源（用户要求：只放插件详情页）');
{
  const clientSrc = readFileSync(join(HERE, '..', 'client.js'), 'utf8');

  ok(/function EngineLoginBar\(\{ engineDetail \}\)/.test(clientSrc), '定义了**自包含**组件 EngineLoginBar（自己用 useWire，不靠 props 层层传）');
  ok(/h\(EngineLoginBar, \{ engineDetail: channelsInfo\?\.engineDetail \}\)/.test(clientSrc),
    '★ 插件详情页（DispatchConfigCard）渲染登录条');

  /* 用户明确要求：**侧栏面板不放按钮**（它的职责是"当下在跑什么"，不是"去设置"）。 */
  const iSec = clientSrc.indexOf('function ChannelSection(');
  const iCard = clientSrc.indexOf('function DispatchConfigCard(');
  ok(iSec > 0 && iCard > iSec, '能定位 ChannelSection 与 DispatchConfigCard 的函数体');
  const chanSecBody = iSec > 0 && iCard > iSec ? clientSrc.slice(iSec, iCard) : '';
  /* 判据只看**渲染点**（`h(EngineLoginBar`）—— 注释里提到组件名不算渲染。 */
  ok(!/h\(EngineLoginBar/.test(chanSecBody), '★ 侧栏面板（ChannelSection）**不**渲染登录条（用户要求）');

  /* ★ 真机"看不到按钮"的根因：`setChannelsInfo` 把 `engineDetail` 丢了 ⇒ 组件静默 return null。
   * 这条锁防止它再次被丢掉（缺失是**静默**的，不报错，只能靠锁）。 */
  const literalCalls = [...clientSrc.matchAll(/setChannelsInfo\(\{[^}]*\}\)/g)].map((m) => m[0]);
  ok(literalCalls.length >= 2, `找到 ${literalCalls.length} 处 setChannelsInfo 对象字面量调用（App + 配置卡）`);
  ok(literalCalls.every((s) => /engineDetail/.test(s)),
    '★ 每处 setChannelsInfo 都保留 engineDetail（漏了它引擎状态条/登录条会静默消失）');
  ok(/engineDetail: prev\.engineDetail \?\? null/.test(clientSrc), '★ snapshot 兜底分支同样保留 engineDetail');
}

cleanup();
console.log(`\n===== ZB-84 WorkBuddy/CodeBuddy 引擎：${pass} PASS / ${fails.length} FAIL =====`);
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log(`  - ${f}`);
  process.exitCode = 1;
}
