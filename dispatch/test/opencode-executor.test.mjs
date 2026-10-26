/**
 * OpenCode 执行器（`collab-kit/opencode-run.mjs`）**离线**回归测试。
 *
 * 纪律：
 *   · **不连网、不跑真实 opencode**（本机真跑一次要消耗免费额度）—— 端到端用**运行时生成的假 CLI**；
 *   · fixture 是 **2026-10-16 本机实测抓到的真实 `--format json` NDJSON 行**（逐字硬编码，见下），
 *     不是手编的理想数据：这样"上游加字段/换形状"能第一时间被发现；
 *   · 行格式断言用**协议正则的逐字副本**（`collab-kit/run-line-protocol.mjs` 的行语法），
 *     不 import core 的解析器 —— 本文件必须能单跑（`node dispatch/test/opencode-executor.test.mjs`），
 *     不依赖 core 侧的进度（core 的 `RES` 镜像与本文件的正则互为独立契约检查）。
 *
 * 覆盖：真实 NDJSON 聚合（文本/用量/工具/sessionID/上下文）· 未知事件与坏行不崩 · 心跳与各行格式 ·
 *       参数面（未知参数 fail-fast、--resume 忽略 -m、--auto 默认关）· task 内联与 memory-ban ·
 *       只读探测解析（models / models --verbose）· 端到端（成功 / 超时 124 / 上游失败原样透传）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as oc from '../../collab-kit/opencode-run.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RUNNER = join(HERE, '..', '..', 'collab-kit', 'opencode-run.mjs');
const PREFIX = '[opencode-run]';

/* ---------------- 真实抓取 fixture（2026-10-16，本机 OpenCode 1.19.2，deepseek-v4.1-flash-free） ---------------- */

/** 第一次实跑（写文件任务）的**完整 6 事件流**（原文，未改一个字符）。 */
const WRITE_RUN_NDJSON = String.raw`{"type":"step_start","timestamp":1792157400926,"sessionID":"ses_ebb184f00ffeLoStDXLH041a4e","part":{"id":"prt_144e7bf59001HwPuZ5ago4hGYM","messageID":"msg_144e7b43e001IzO88WlfrOGrh5","sessionID":"ses_ebb184f00ffeLoStDXLH041a4e","type":"step-start"}}
{"type":"tool_use","timestamp":1792157401318,"sessionID":"ses_ebb184f00ffeLoStDXLH041a4e","part":{"type":"tool","tool":"write","callID":"call_00_pkt44hktyiws43saa86sil3s","state":{"status":"completed","input":{"filePath":"C:\\Users\\Administrator\\AppData\\Local\\Temp\\oc-write2\\hello.txt","content":"hi from opencode"},"output":"Wrote file successfully.","metadata":{"diagnostics":{},"filepath":"C:\\Users\\Administrator\\AppData\\Local\\Temp\\oc-write2\\hello.txt","exists":false,"truncated":false},"title":"Users\\Administrator\\AppData\\Local\\Temp\\oc-write2\\hello.txt","time":{"start":1792157401263,"end":1792157401287}},"id":"prt_144e7c036001fCdVJBrKFfMMSc","sessionID":"ses_ebb184f00ffeLoStDXLH041a4e","messageID":"msg_144e7b43e001IzO88WlfrOGrh5"}}
{"type":"step_finish","timestamp":1792157401318,"sessionID":"ses_ebb184f00ffeLoStDXLH041a4e","part":{"id":"prt_144e7c0ce001nfmkfhA3GjIQNX","reason":"tool-calls","messageID":"msg_144e7b43e001IzO88WlfrOGrh5","sessionID":"ses_ebb184f00ffeLoStDXLH041a4e","type":"step-finish","tokens":{"total":8064,"input":6195,"output":77,"reasoning":0,"cache":{"write":0,"read":1792}},"cost":0}}
{"type":"step_start","timestamp":1792157402948,"sessionID":"ses_ebb184f00ffeLoStDXLH041a4e","part":{"id":"prt_144e7c72a001Y3mMfd0bYtzaWX","messageID":"msg_144e7c0dc0010npHzOVDCnc5Ol","sessionID":"ses_ebb184f00ffeLoStDXLH041a4e","type":"step-start"}}
{"type":"text","timestamp":1792157402948,"sessionID":"ses_ebb184f00ffeLoStDXLH041a4e","part":{"id":"prt_144e7c731001HXAVm12LZ6zllx","messageID":"msg_144e7c0dc0010npHzOVDCnc5Ol","sessionID":"ses_ebb184f00ffeLoStDXLH041a4e","type":"text","text":"Done.","time":{"start":1792157402929,"end":1792157402934}}}
{"type":"step_finish","timestamp":1792157402948,"sessionID":"ses_ebb184f00ffeLoStDXLH041a4e","part":{"id":"prt_144e7c738001Isq0e9SozOrl2l","reason":"stop","messageID":"msg_144e7c0dc0010npHzOVDCnc5Ol","sessionID":"ses_ebb184f00ffeLoStDXLH041a4e","type":"step-finish","tokens":{"total":8083,"input":144,"output":3,"reasoning":0,"cache":{"write":0,"read":7936}},"cost":0}}`;

/** 冒烟任务（PONG）的完整 3 事件流（真实抓取）。 */
const PONG_RUN_NDJSON = String.raw`{"type":"step_start","timestamp":1792157443021,"sessionID":"ses_ebb17ae4effeP8qbtk4lzuLsZ8","part":{"id":"prt_144e86384001CZ7V85y79XZ9QT","messageID":"msg_144e85457001jHhg2PxWKU0to5","sessionID":"ses_ebb17ae4effeP8qbtk4lzuLsZ8","type":"step-start"}}
{"type":"text","timestamp":1792157443022,"sessionID":"ses_ebb17ae4effeP8qbtk4lzuLsZ8","part":{"id":"prt_144e86389001bJ8jVXkvclnZij","messageID":"msg_144e85457001jHhg2PxWKU0to5","sessionID":"ses_ebb17ae4effeP8qbtk4lzuLsZ8","type":"text","text":"PONG","time":{"start":1792157442953,"end":1792157442963}}}
{"type":"step_finish","timestamp":1792157443022,"sessionID":"ses_ebb17ae4effeP8qbtk4lzuLsZ8","part":{"id":"prt_144e863a1001yjI5jWnNMfla2Q","reason":"stop","messageID":"msg_144e85457001jHhg2PxWKU0to5","sessionID":"ses_ebb17ae4effeP8qbtk4lzuLsZ8","type":"step-finish","tokens":{"total":7978,"input":39,"output":3,"reasoning":0,"cache":{"write":0,"read":7936}},"cost":0}}`;

/** 不存在模型时上游回的真实错误事件（`type:"error"`，**未观测过的类型** ⇒ 必须降级透传不崩）。 */
const ERROR_EVENT_LINE = '{"type":"error","timestamp":1792156982094,"sessionID":"ses_ebb1ea89affe4kM903iMb6QqWu","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_9a4fea0f"}}}';

/** `opencode models` 的真实 12 行输出（0 凭据，全部免费）。 */
const MODELS_PLAIN = [
  'opencode/big-pickle', 'opencode/cat-jam-free', 'opencode/deepseek-v4.1-flash-free',
  'opencode/glm-5.3-flash-free', 'opencode/ll-alpha-free', 'opencode/longcat-2.5-preview-free',
  'opencode/mimo-v2.6-flash-free', 'opencode/muse-spark-1.3-contributor-free',
  'opencode/nemotron-3-ultra-free', 'opencode/nemotron-3.5-lightning-free',
  'opencode/nemotron-3.5-super-vl-free', 'opencode/space-bunny-free',
];

/* ---------------- 行协议正则（run-line-protocol.mjs 行语法的逐字副本；core 的 RES 是独立镜像） ---------------- */
const RE = {
  start: /^\[opencode-run\] tag=(\S+) mode=(\S+) cwd=(.+)$/,
  provider: /^\[opencode-run\] provider=(\S+)(?: model=(\S+)| models=(\S+))?(?: \((.+)\))?$/,
  variant: /^\[opencode-run\] variant=(\S+) model=(\S+)$/,
  usage: /^\[opencode-run\] usage requests=(\d+|-) in=(\d+|-) out=(\d+|-) cacheRead=(\d+|-)\s*$/,
  context: /^\[opencode-run\] context used=(\d+) \((?:[\d.]+)% of (\d+)\) turnCount=(\d+|-)\s*$/,
  progress: /^\[opencode-run\] progress stage=(\S+) elapsed=(\d+)s chars=(\d+) tools=(\d+)(?: lastTool=(\S+))? stageAgo=(\d+)s(?: session=(\S+))?\s*$/,
  done: /^\[opencode-run\] done exit=(\d+)(?: \(超时\))? elapsed=([\d.]+)s(?: session=(\S+))?(?: provider=(\S+))?(?: model=(\S+))?(?: responseChars=(\d+))?\s*$/,
  out: /^\[opencode-run\] out=(.+)$/,
  err: /^\[opencode-run\] err=(.+)$/,
  result: /^\[opencode-run\] result=(.+)$/,
  cli: /^\[opencode-run\] cli=(.+)$/,
  task: /^\[opencode-run\] task=(.+)$/,
  memoryBan: /^\[opencode-run\] memory-ban=on\b/,
  resume: /^\[opencode-run\] resume=(\S+)$/,
  variants: /^\[opencode-run\] variants (\S+?)=(\S+)\s*$/,
};

/** 生成一个隔离的临时工作目录（测试自清理）。 */
function makeTempDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), `oc-test-${tag}-`));
  return dir;
}

/* ============================ ① 真实 NDJSON 聚合 ============================ */

test('① 真实 6 事件流聚合：文本/工具/用量/sessionID/上下文/turnCount', () => {
  const agg = oc.aggregateNdjson(WRITE_RUN_NDJSON);
  assert.equal(agg.sessionId, 'ses_ebb184f00ffeLoStDXLH041a4e');
  assert.equal(agg.response, 'Done.', 'text 事件按序拼接');
  assert.equal(agg.responseChars, 5);

  assert.equal(agg.tools.length, 1);
  assert.deepEqual(
    { tool: agg.tools[0].tool, callID: agg.tools[0].callID, status: agg.tools[0].status },
    { tool: 'write', callID: 'call_00_pkt44hktyiws43saa86sil3s', status: 'completed' },
  );
  assert.equal(agg.tools[0].input.content, 'hi from opencode', 'tool_use.state.input 原样带出');
  assert.equal(agg.tools[0].output, 'Wrote file successfully.');

  assert.deepEqual(agg.usage, {
    requests: 2,
    inputTokens: 6339, // 6195 + 144
    outputTokens: 80, // 77 + 3
    cacheReadTokens: 9728, // 1792 + 7936
    reasoningTokens: 0,
    totalTokens: 16147, // 8064 + 8083（Σ 各 step 的 total）
  });
  assert.deepEqual(agg.usageSeen, { input: true, output: true, cacheRead: true, reasoning: true, total: true });
  assert.equal(agg.cost, 0, '免费模型 cost = 0（求和后仍是 0，不是 null）');
  assert.equal(agg.contextUsed, 8083, 'contextUsed = 最后一个 step_finish 的 input+output+reasoning+cache.read');
  assert.equal(agg.turnCount, 2);
  assert.deepEqual(agg.eventCounts, { step_start: 2, tool_use: 1, step_finish: 2, text: 1 });
  assert.deepEqual(agg.unknownEvents, []);
  assert.deepEqual(agg.warnings, []);
});

test('①b tokens 缺字段不许抛；无 step_finish 时 requests/用量为 0 且不崩', () => {
  const noTokens = `${PONG_RUN_NDJSON}\n${'{"type":"step_finish","sessionID":"ses_x","part":{"type":"step-finish","reason":"stop"}}'}`;
  const a = oc.aggregateNdjson(noTokens);
  assert.equal(a.usage.requests, 2);
  assert.equal(a.usage.inputTokens, 39, '缺 tokens 的 step 不污染求和');
  assert.equal(a.response, 'PONG');

  const empty = oc.aggregateNdjson('');
  assert.equal(empty.sessionId, null);
  assert.equal(empty.usage.requests, 0);
  assert.equal(empty.contextUsed, null);
  assert.equal(empty.turnCount, null, '没有 step_finish ⇒ turnCount 为 null（不是 0）');
});

test('①c part.tokens 只给部分字段时，缺失字段不被当成 0 混入', () => {
  const partial = '{"type":"step_finish","sessionID":"ses_p","part":{"type":"step-finish","tokens":{"output":7,"cache":{"read":100}}}}';
  const a = oc.aggregateNdjson(partial);
  assert.equal(a.usage.outputTokens, 7);
  assert.equal(a.usage.cacheReadTokens, 100);
  assert.equal(a.usage.inputTokens, 0);
  assert.deepEqual(a.usageSeen, { input: false, output: true, cacheRead: true, reasoning: false, total: false });
  assert.equal(a.contextUsed, 107, '缺项按 0 参与 contextUsed');
  assert.equal(oc.formatUsageLine(a.usage, a.usageSeen), `${PREFIX} usage requests=1 in=- out=7 cacheRead=100`);
});

/* ============================ ② 未知事件 / 坏行：绝不崩 ============================ */

test('② 未知 type + JSON 坏行 + 非对象行：继续本轮，记 unknownEvents/warnings', () => {
  const mixed = [
    PONG_RUN_NDJSON.split('\n')[0], // step_start
    ERROR_EVENT_LINE, // 未观测过的 type=error
    '{"type":"step_retry","sessionID":"ses_z","part":{"attempt":2}}', // 假想的未来事件
    '{"type":"text","sessionID":"ses_ebb17ae4effeP8qbtk4lzuLsZ8","part":{"text":"PONG"}}',
    '这不是 JSON 的一行', // 解析失败
    '"just a string"', // 合法 JSON 但不是对象
    PONG_RUN_NDJSON.split('\n')[2], // step_finish
  ].join('\n');
  const a = oc.aggregateNdjson(mixed);
  assert.equal(a.response, 'PONG', '坏行之后仍能继续聚合');
  assert.equal(a.sessionId, 'ses_ebb17ae4effeP8qbtk4lzuLsZ8');
  assert.equal(a.unknownEventCount, 4, 'error + step_retry + 两个坏行');
  assert.equal(a.unknownEvents.length, 4);
  assert.ok(a.unknownEvents.includes(ERROR_EVENT_LINE), '未知事件**原样**保留（供落盘/排障）');
  assert.ok(a.warnings.some((w) => w.includes('未知事件类型 error')));
  assert.equal(a.parseErrorCount, 2);
  assert.equal(a.usage.requests, 1, '未知事件不算 step_finish');
});

test('②b 未知事件原文数组有上限（防上游狂刷把 result.json 撑爆）', () => {
  const many = Array.from({ length: 80 }, (_, i) => `{"type":"mystery_${i}"}`).join('\n');
  const a = oc.aggregateNdjson(many);
  assert.equal(a.unknownEventCount, 80);
  assert.equal(a.unknownEvents.length, 50, '原文最多存 50 条，计数不丢');
});

/* ============================ ③ 心跳/汇总行格式（对齐协议） ============================ */

test('③ 心跳行：完整形态可解析（stage/elapsed/chars/tools/lastTool/stageAgo/session），无 session 时省略', () => {
  const full = oc.formatProgressLine(
    { stage: 'tool-call', at: 1_000, chars: 1024, tools: 3, lastTool: 'write', sessionId: 'ses_abc12345' },
    0,
    21_000,
  );
  const m = RE.progress.exec(full);
  assert.ok(m, `心跳行必须匹配协议正则: ${full}`);
  assert.deepEqual(m.slice(1, 8), ['tool-call', '21', '1024', '3', 'write', '20', 'ses_abc12345']);

  const min = oc.formatProgressLine({ stage: 'spawn', at: 5_000, chars: 0, tools: 0 }, 5_000, 5_000);
  assert.match(min, RE.progress);
  assert.equal(min, `${PREFIX} progress stage=spawn elapsed=0s chars=0 tools=0 stageAgo=0s`);
});

test('③b usage/context/done 行格式；窗口未知时 context 行返回 null（不编造）', () => {
  assert.equal(
    oc.formatUsageLine({ requests: 1, inputTokens: 39, outputTokens: 3, cacheReadTokens: 7936 }, { input: true, output: true, cacheRead: true }),
    `${PREFIX} usage requests=1 in=39 out=3 cacheRead=7936`,
  );
  assert.equal(
    oc.formatUsageLine({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, {}),
    `${PREFIX} usage requests=- in=- out=- cacheRead=-`,
  );
  const ctx = oc.formatContextLine(7978, 200000, 1);
  assert.match(ctx, RE.context);
  assert.equal(ctx, `${PREFIX} context used=7978 (4.0% of 200000) turnCount=1`);
  assert.equal(oc.formatContextLine(7978, null, 1), null, '窗口探测不到 ⇒ 整行不打');
  assert.equal(oc.formatContextLine(7978, 0, 1), null);
  assert.equal(oc.formatContextLine(null, 200000, null), null, '没有 step_finish ⇒ 不打');

  const done = oc.formatDoneLine({ exit: 0, timedOut: false, elapsedSec: 6.63, sessionId: 'ses_ebb17ae4effeP8qbtk4lzuLsZ8', model: 'opencode/deepseek-v4.1-flash-free', responseChars: 4 });
  const dm = RE.done.exec(done);
  assert.ok(dm, done);
  assert.deepEqual(dm.slice(1, 7), ['0', '6.6', 'ses_ebb17ae4effeP8qbtk4lzuLsZ8', undefined, 'opencode/deepseek-v4.1-flash-free', '4']);
  const to = oc.formatDoneLine({ exit: 124, timedOut: true, elapsedSec: 12, sessionId: null, model: 'm', responseChars: 0 });
  assert.ok(to.includes('exit=124 (超时)'));
  assert.match(to, RE.done);
});

/* ============================ ④ 参数面 ============================ */

test('④ 未知参数 / 不支持参数 / 互斥与非法值：一律 fail-fast', () => {
  assert.throws(() => oc.parseArgs(['--prompt', 'x', '--nonsense-flag']), (e) => e instanceof oc.CliError && e.message.includes('--nonsense-flag'));
  assert.throws(() => oc.parseArgs(['--prompt', 'x', '--memory-bench']), /不支持 --memory-bench/);
  assert.throws(() => oc.parseArgs(['--prompt', 'x', '--mode', 'yolo']), /不支持 --mode/);
  assert.throws(() => oc.parseArgs(['--prompt', 'x', '--target', 'y']), /互斥/);
  assert.throws(() => oc.parseArgs(['--task', 'a', '--target', 'y']), /互斥/);
  assert.throws(() => oc.parseArgs([]), /必须给出 --task \/ --prompt \/ --target/);
  assert.throws(() => oc.parseArgs(['--prompt', 'x', '--timeout-min', '0']), /--timeout-min/);
  assert.throws(() => oc.parseArgs(['--prompt', 'x', '--timeout-min', 'abc']), /--timeout-min/);
  assert.throws(() => oc.parseArgs(['--prompt']), /缺少取值/);
  assert.throws(() => oc.parseArgs(['--with-variants']), /--with-variants 仅在/);
  assert.throws(() => oc.parseArgs(['--prompt', 'x', '--provider', 'zcode']), /只接受 opencode/);
});

test('④b --task 优先于 --prompt；--provider opencode/--no-ledger/--reasoning-level 为兼容令牌（大声记说明）', () => {
  const a = oc.parseArgs(['--task', 't.md', '--prompt', 'p', '--tag', 'T']);
  assert.equal(a.kind, 'task');
  assert.equal(a.tag, 'T');
  const b = oc.parseArgs(['--prompt', 'p', '--provider', 'opencode', '--no-ledger']);
  assert.equal(b.kind, 'prompt');
  assert.equal(b.compatNotes.length, 2, '兼容令牌必须在 stderr 有说明');
  assert.equal(oc.parseArgs(['--prompt', 'p', '--reasoning-level', 'high']).variant, 'high');
  assert.equal(oc.parseArgs(['--prompt', 'p', '--reasoning-level', 'agent']).variant, undefined, 'agent ⇒ 不传 --variant');
  assert.equal(oc.parseArgs(['--prompt', 'p', '--auto']).auto, true);
  assert.equal(oc.parseArgs(['--prompt', 'p']).auto, false, '**默认关**：不传 --auto 就是 false');
});

test('④c 模型 id 规范化 + argv 构造（含 --resume 绝不传 -m）', () => {
  assert.equal(oc.normalizeModelId('glm-5.3-flash-free'), 'opencode/glm-5.3-flash-free');
  assert.equal(oc.normalizeModelId('opencode/glm-5.3-flash-free'), 'opencode/glm-5.3-flash-free');
  assert.equal(oc.normalizeModelId(''), oc.DEFAULT_MODEL);
  assert.equal(oc.DEFAULT_MODEL, 'opencode/deepseek-v4.1-flash-free');

  const base = oc.parseArgs(['--prompt', 'x']);
  assert.deepEqual(oc.buildRunArgs({ ...base, prompt: 'x', cwd: 'C:\\w' }),
    ['run', 'x', '-m', 'opencode/deepseek-v4.1-flash-free', '--dir', 'C:\\w', '--format', 'json']);

  const withVariant = oc.parseArgs(['--prompt', 'x', '--variant', 'high', '--model', 'opencode/glm-5.3-flash-free']);
  const argv = oc.buildRunArgs({ ...withVariant, prompt: 'x' });
  assert.deepEqual(argv, ['run', 'x', '-m', 'opencode/glm-5.3-flash-free', '--variant', 'high', '--format', 'json']);
  assert.ok(!argv.includes('--auto'), '未显式传 --auto ⇒ argv 里绝不能出现 --auto');
  assert.ok(oc.buildRunArgs({ ...oc.parseArgs(['--prompt', 'x', '--auto']), prompt: 'x' }).includes('--auto'));

  /* ★ --resume：只给 -s，**绝不**给 -m/--model（契约安全默认；实测 -s+-m 同给虽不报错仍取安全默认）。 */
  const res = oc.parseArgs(['--resume', 'ses_ebb17ae4effeP8qbtk4lzuLsZ8', '--prompt', '继续', '--model', 'opencode/glm-5.3-flash-free']);
  const rArgv = oc.buildRunArgs({ ...res, prompt: '继续' });
  assert.deepEqual(rArgv, ['run', '继续', '-s', 'ses_ebb17ae4effeP8qbtk4lzuLsZ8', '--format', 'json']);
  assert.ok(!rArgv.includes('-m') && !rArgv.includes('--model'), '续跑绝不传 -m/--model');
});

test('④d buildPrompt：--task 内联任务包、--target 按 prompt、--memory-ban 追加禁令', () => {
  const dir = makeTempDir('prompt');
  try {
    const taskFile = join(dir, 'T1.md');
    writeFileSync(taskFile, '# 任务\n只回复 OK\n');
    const opt = oc.parseArgs(['--task', taskFile]);
    const { prompt, taskPath, kind } = oc.buildPrompt(opt, dir);
    assert.equal(kind, 'task');
    assert.equal(taskPath, taskFile);
    assert.ok(prompt.includes('任务包开始') && prompt.includes('只回复 OK'), '任务包内容内联进 prompt');
    assert.ok(prompt.includes(taskFile), '任务包绝对路径写进 prompt');

    const t = oc.buildPrompt(oc.parseArgs(['--target', '做到 X']), dir);
    assert.equal(t.kind, 'target');
    assert.equal(t.prompt, '做到 X');

    const banned = oc.buildPrompt(oc.parseArgs(['--prompt', 'p', '--memory-ban']), dir);
    assert.ok(banned.prompt.endsWith(oc.MEMORY_BAN_TEXT), '禁令追加在末尾');
    assert.ok(oc.MEMORY_BAN_TEXT.includes('不要执行任何 ZCode 记忆写入'));

    assert.throws(() => oc.buildPrompt(oc.parseArgs(['--task', join(dir, 'nope.md')]), dir), /任务包不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('④e 可执行文件解析与 spawn 形态（零依赖、不执行任何 opencode 命令）', () => {
  const dir = makeTempDir('cli');
  try {
    const npmDir = join(dir, 'npm');
    const exe = join(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    mkdirSync(join(npmDir, 'node_modules', 'opencode-ai', 'bin'), { recursive: true });
    writeFileSync(exe, 'not a real exe');
    const found = oc.findOpencodeCli({ APPDATA: dir, OPENCODE_CLI: undefined }, { existsSync, whereSync: () => '' });
    assert.equal(found.toLowerCase(), exe.toLowerCase());

    assert.equal(oc.findOpencodeCli({ APPDATA: dir, OPENCODE_CLI: undefined }, { existsSync: () => false, whereSync: () => '' }), null);
    assert.equal(oc.findOpencodeCli({ OPENCODE_CLI: 'opencode' }, { existsSync: () => false, whereSync: () => '' }), 'opencode', '裸命令名原样返回（交给 PATH）');
    assert.equal(oc.findOpencodeCli({ OPENCODE_CLI: exe }, { existsSync: () => true, whereSync: () => '' }).toLowerCase(), exe.toLowerCase());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.deepEqual(oc.spawnSpec('C:\\x\\opencode.exe', ['run', 'a']), { cmd: 'C:\\x\\opencode.exe', argv: ['run', 'a'], shell: false });
  /* ZB-123：spawnSpec 现在统一返回 spawn-target.mjs 的形状（多一个 shell 字段，供 spawnOptions 使用）。 */
  assert.deepEqual(oc.spawnSpec('C:\\x\\fake.mjs', ['run']), { cmd: process.execPath, argv: ['C:\\x\\fake.mjs', 'run'], shell: false });
  const cmdSpec = oc.spawnSpec('C:\\x\\opencode.cmd', ['run', 'a']);
  assert.ok(/cmd/i.test(cmdSpec.cmd) && cmdSpec.argv.includes('/c'), '.cmd 经 cmd.exe 转调（Node ≥18.20 不能直接 spawn 批处理）');
});

/* ============================ ⑤ 只读探测解析 ============================ */

test('⑤ models 解析：真实 12 行 → 12 个 id；非 opencode/* 被过滤且不猜', () => {
  const text = `${MODELS_PLAIN.join('\n')}\nopencode/some-model\nanthropic/claude-x\ngarbage line\n`;
  const all = oc.parseModelsPlain(text);
  assert.equal(all.length, 14, 'garbage line 被丢，合法 id 全部保留');
  const kept = oc.filterOpenCodeIds(all);
  assert.equal(kept.length, 13, '只认 opencode/*（协议 OPENCODE_ID_RE 的引擎判据）');
  assert.ok(!kept.includes('anthropic/claude-x'));
  assert.deepEqual(oc.filterOpenCodeIds(MODELS_PLAIN), MODELS_PLAIN);
});

test('⑤b models --verbose 解析：limit.context / variants 键（真实形状：id 行 + pretty JSON 块）', () => {
  const verbose = [
    MODELS_PLAIN[0],
    JSON.stringify({ id: 'big-pickle', providerID: 'opencode', limit: { context: 200000, output: 32000 }, variants: {}, cost: { input: 0 } }, null, 2),
    MODELS_PLAIN[2],
    JSON.stringify({ id: 'deepseek-v4.1-flash-free', limit: { context: 200000, output: 32000 }, variants: { low: { reasoningEffort: 'low' }, high: {}, max: {} } }, null, 2),
    '{"broken json"', // 未闭合的块：跳过，不影响其它模型
  ].join('\n');
  const meta = oc.parseModelsVerbose(verbose);
  assert.equal(meta.size, 2);
  assert.equal(meta.get(MODELS_PLAIN[0]).contextWindow, 200000);
  assert.deepEqual(meta.get(MODELS_PLAIN[0]).variants, [], 'variants 空对象 ⇒ 空数组（如实不打）');
  assert.deepEqual(meta.get(MODELS_PLAIN[2]).variants, ['low', 'high', 'max']);
  assert.equal(oc.parseModelsVerbose('').size, 0);
  assert.equal(oc.parseModelsVerbose('not json at all').size, 0);
});

/* ============================ ⑥ 端到端（假 CLI，全程离线） ============================ */

/**
 * 造一个假 opencode CLI（写入临时目录，**不入仓库**）：
 *   --version                 → 一行版本号
 *   models [--verbose]        → 12 个真实 id；--verbose 时每行 id 后跟一个真实形状的 JSON 块
 *   run ...                   → 输出注入的 NDJSON fixture（由 FAKE_NDJSON_FILE 指定）
 * env：FAKE_ARGV_FILE 落盘 argv（断言 argv 构造）、FAKE_NDJSON_FILE、FAKE_RUN_MODE=hang|error
 */
function writeFakeCli(dir) {
  const cliPath = join(dir, 'fake-opencode.mjs');
  const idsPath = join(dir, 'ids.json');
  writeFileSync(idsPath, JSON.stringify(MODELS_PLAIN));
  writeFileSync(cliPath, String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_ARGV_FILE) { try { writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(args)); } catch {} }
const ids = JSON.parse(readFileSync(process.env.FAKE_IDS_FILE, 'utf8'));
if (args[0] === '--version') { console.log('9.9.9-fake'); process.exit(0); }
if (args[0] === 'models') {
  for (const id of ids) {
    if (args.includes('--verbose')) {
      console.log(id);
      console.log(JSON.stringify({ id: id.split('/')[1], limit: { context: id.endsWith('deepseek-v4.1-flash-free') ? 200000 : 128000 }, variants: id.endsWith('deepseek-v4.1-flash-free') ? { low: {}, high: {}, max: {} } : {} }, null, 2));
    } else {
      console.log(id);
    }
  }
  process.exit(0);
}
const mode = process.env.FAKE_RUN_MODE || 'ok';
const sleepMs = Number(process.env.FAKE_SLEEP_MS || 0);
if (mode === 'hang') { setInterval(() => {}, 1000); }
else if (mode === 'error') { process.stderr.write("FreeTierError: OpenCode's free tier can only be used from within OpenCode.\n"); process.exit(3); }
else {
  /* 「慢但正常」模拟（回归用）：GLM-5.3-Flash 真机首响 ~14.2s */
  if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
  const text = readFileSync(process.env.FAKE_NDJSON_FILE, 'utf8');
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  process.exit(0);
}
`);
  return { cliPath, idsPath };
}

/** 跑一次真实 runner 子进程（假 CLI；env 隔离，绝不碰真实 opencode/用户目录）。 */
function runExecutor(dir, cliPath, idsPath, runnerArgs, extraEnv = {}) {
  const argvFile = join(dir, `argv-${Math.random().toString(36).slice(2, 8)}.json`);
  const cacheFile = join(dir, 'meta-cache.json');
  const r = spawnSync(process.execPath, [RUNNER, ...runnerArgs], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      OPENCODE_CLI: cliPath,
      OPENCODE_META_CACHE_FILE: cacheFile,
      OPENCODE_CONTEXT_WINDOW: '', // 空 ⇒ 走缓存/探测
      FAKE_ARGV_FILE: argvFile,
      FAKE_IDS_FILE: idsPath,
      ...extraEnv,
    },
  });
  return { r, argvFile, cacheFile, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

test('⑥ 端到端成功：汇总行齐全、result.json 正确、out.log 是原始 NDJSON', (t) => {
  const dir = makeTempDir('e2e-ok');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { cliPath, idsPath } = writeFakeCli(dir);
  const ndjson = join(dir, 'fixture.ndjson');
  writeFileSync(ndjson, PONG_RUN_NDJSON);
  const { r, argvFile, stdout, stderr } = runExecutor(dir, cliPath, idsPath, ['--prompt', 'Reply with exactly: PONG', '--tag', 'T1'], { FAKE_NDJSON_FILE: ndjson });

  assert.equal(r.status, 0, `exit 0；stderr=${stderr}`);
  const lines = stdout.split('\n').filter(Boolean);
  assert.ok(lines.some((l) => RE.start.test(l) && l.includes('mode=opencode') && l.includes('tag=T1')), 'start 行');
  assert.ok(lines.some((l) => RE.cli.test(l)));
  assert.ok(lines.some((l) => RE.provider.test(l) && l.includes('provider=opencode model=opencode/deepseek-v4.1-flash-free')), 'provider 行');
  assert.ok(lines.some((l) => RE.memoryBan.test(l)) === false, '未传 --memory-ban ⇒ 不打该行');
  assert.ok(lines.some((l) => RE.progress.test(l)), '至少一行心跳（短任务也要有）');
  assert.ok(lines.some((l) => l === `${PREFIX} usage requests=1 in=39 out=3 cacheRead=7936`), 'usage 行');
  assert.ok(lines.some((l) => RE.context.test(l) && l.includes('(4.0% of 200000)')), 'context 行（假 CLI 的 verbose 给了 200000）');
  assert.ok(lines.some((l) => RE.out.test(l)) && lines.some((l) => RE.err.test(l)) && lines.some((l) => RE.result.test(l)));
  const done = lines.find((l) => RE.done.test(l));
  assert.ok(done && done.includes('exit=0') && done.includes('session=ses_ebb17ae4effeP8qbtk4lzuLsZ8') && done.includes('responseChars=4'), `done 行: ${done}`);
  assert.ok(!lines.some((l) => l.includes('auto=on')), '未传 --auto ⇒ 不打 auto=on');

  /* argv 构造（对真实 CLI 的透传面） */
  const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
  assert.deepEqual(argv, ['run', 'Reply with exactly: PONG', '-m', 'opencode/deepseek-v4.1-flash-free', '--dir', dir, '--format', 'json']);
  assert.ok(!argv.includes('--auto'), '默认绝不放行权限');

  /* result.json */
  const resultLine = lines.find((l) => RE.result.test(l));
  const resultPath = RE.result.exec(resultLine)[1];
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(result.engine, 'opencode');
  assert.equal(result.response, 'PONG');
  assert.equal(result.sessionId, 'ses_ebb17ae4effeP8qbtk4lzuLsZ8');
  assert.deepEqual(result.usage, { requests: 1, inputTokens: 39, outputTokens: 3, cacheReadTokens: 7936, reasoningTokens: 0, totalTokens: 7978 });
  assert.equal(result.exit, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.contextWindow, 200000);
  assert.deepEqual(result.unknownEvents, []);

  /* out.log 必须是**原始 NDJSON 逐行**（未知事件降级透传的落盘凭据） */
  const outLine = lines.find((l) => RE.out.test(l));
  assert.equal(readFileSync(RE.out.exec(outLine)[1], 'utf8'), `${PONG_RUN_NDJSON}\n`);
});

test('⑥b 端到端 --resume：只带 -s（无 -m），且 result.modelApplied=false', (t) => {
  const dir = makeTempDir('e2e-resume');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { cliPath, idsPath } = writeFakeCli(dir);
  const ndjson = join(dir, 'fixture.ndjson');
  writeFileSync(ndjson, PONG_RUN_NDJSON);
  const sid = 'ses_ebb17ae4effeP8qbtk4lzuLsZ8';
  const { r, argvFile, stdout } = runExecutor(dir, cliPath, idsPath, ['--resume', sid, '--prompt', '继续', '--tag', 'T2'], { FAKE_NDJSON_FILE: ndjson });
  assert.equal(r.status, 0);
  const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
  assert.deepEqual(argv, ['run', '继续', '-s', sid, '--dir', dir, '--format', 'json']);
  assert.ok(!argv.includes('-m') && !argv.includes('--model'));
  assert.ok(stdout.split('\n').some((l) => RE.resume.test(l) && l.includes(sid)), 'resume 行回显');

  const resultPath = RE.result.exec(stdout.split('\n').find((l) => RE.result.test(l)))[1];
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(result.modelApplied, false);
  assert.equal(result.resume, sid);
});

test('⑥c 端到端 --auto：显式传入才透传，并打可审计告知行', (t) => {
  const dir = makeTempDir('e2e-auto');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { cliPath, idsPath } = writeFakeCli(dir);
  const ndjson = join(dir, 'fixture.ndjson');
  writeFileSync(ndjson, PONG_RUN_NDJSON);
  const { r, argvFile, stdout } = runExecutor(dir, cliPath, idsPath, ['--prompt', 'x', '--tag', 'T3', '--auto'], { FAKE_NDJSON_FILE: ndjson });
  assert.equal(r.status, 0);
  assert.ok(JSON.parse(readFileSync(argvFile, 'utf8')).includes('--auto'), '透传给 opencode run');
  assert.ok(stdout.includes(`${PREFIX} auto=on（已放行所有未显式拒绝的权限；请确保工作目录可信）`), '必须有可审计告知行');
});

test('⑥d 端到端 --memory-ban / --variant：行与注入都对得上', (t) => {
  const dir = makeTempDir('e2e-flags');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { cliPath, idsPath } = writeFakeCli(dir);
  const ndjson = join(dir, 'fixture.ndjson');
  writeFileSync(ndjson, PONG_RUN_NDJSON);
  const { r, argvFile, stdout } = runExecutor(
    dir, cliPath, idsPath,
    ['--prompt', 'x', '--tag', 'T4', '--variant', 'high', '--memory-ban'],
    { FAKE_NDJSON_FILE: ndjson },
  );
  assert.equal(r.status, 0);
  const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
  assert.ok(argv.includes('--variant') && argv[argv.indexOf('--variant') + 1] === 'high');
  assert.ok(stdout.split('\n').some((l) => RE.variant.test(l)), '思考强度生效确认行');
  assert.ok(stdout.split('\n').some((l) => RE.memoryBan.test(l)), 'memory-ban=on 确认行');
});

test('⑥e 端到端 task：任务包内联 + task 行 + argv 收到内联后的 prompt', (t) => {
  const dir = makeTempDir('e2e-task');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { cliPath, idsPath } = writeFakeCli(dir);
  const ndjson = join(dir, 'fixture.ndjson');
  writeFileSync(ndjson, PONG_RUN_NDJSON);
  const taskFile = join(dir, 'T-oc.md');
  writeFileSync(taskFile, '# 任务包\n内容内联标记 OC-TASK-INLINE\n');
  const { r, argvFile, stdout } = runExecutor(dir, cliPath, idsPath, ['--task', taskFile, '--tag', 'T5', '--memory-ban'], { FAKE_NDJSON_FILE: ndjson });
  assert.equal(r.status, 0);
  const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
  assert.equal(argv[0], 'run');
  assert.ok(argv[1].includes('OC-TASK-INLINE') && argv[1].includes(taskFile), '任务包内容 + 绝对路径都内联进 prompt');
  assert.ok(argv[1].includes('不要执行任何 ZCode 记忆写入'), 'memory-ban 追加在内联 prompt 末尾');
  assert.ok(stdout.split('\n').some((l) => RE.task.test(l) && l.includes(taskFile)), 'task 行');
});

test('⑥f 端到端 --list-models：stdout 只有裸 id（方案 A）；--with-variants 才追加 variants 行', (t) => {
  const dir = makeTempDir('e2e-list');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { cliPath, idsPath } = writeFakeCli(dir);

  const plain = runExecutor(dir, cliPath, idsPath, ['--list-models']);
  assert.equal(plain.r.status, 0);
  const plainLines = plain.stdout.split('\n').filter(Boolean);
  assert.deepEqual(plainLines, MODELS_PLAIN, '**逐字**等于 12 行裸 id（core 逐行当模型 id 解析）');
  assert.ok(!plainLines.some((l) => l.startsWith(PREFIX)), '默认不得混入任何 [opencode-run] 行');

  const withVariants = runExecutor(dir, cliPath, idsPath, ['--list-models', '--with-variants']);
  assert.equal(withVariants.r.status, 0);
  const wl = withVariants.stdout.split('\n').filter(Boolean);
  assert.deepEqual(wl.slice(0, 12), MODELS_PLAIN, 'id 仍在前 12 行');
  const variantLines = wl.slice(12);
  assert.equal(variantLines.length, 1, '只有 deepseek-v4.1-flash-free 有 variants（其余为空对象 ⇒ 如实不打）');
  assert.match(variantLines[0], RE.variants);
  assert.equal(variantLines[0], `${PREFIX} variants opencode/deepseek-v4.1-flash-free=low,high,max`);

  assert.equal(runExecutor(dir, cliPath, idsPath, ['--list-providers']).r.status, 0, '--list-providers 是同义别名');
});

test('⑥g 端到端 --version：只打一行版本号', (t) => {
  const dir = makeTempDir('e2e-ver');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { cliPath, idsPath } = writeFakeCli(dir);
  const { r, stdout } = runExecutor(dir, cliPath, idsPath, ['--version']);
  assert.equal(r.status, 0);
  assert.deepEqual(stdout.split('\n').filter(Boolean), ['9.9.9-fake']);
});

test('⑥h 端到端上游失败：退出码透传 + 原始错误**逐字**到 stderr；result.json 记 exit', (t) => {
  const dir = makeTempDir('e2e-fail');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { cliPath, idsPath } = writeFakeCli(dir);
  const rawErr = "FreeTierError: OpenCode's free tier can only be used from within OpenCode.";
  const { r, stdout, stderr } = runExecutor(dir, cliPath, idsPath, ['--prompt', 'x', '--tag', 'T6'], { FAKE_RUN_MODE: 'error' });
  assert.equal(r.status, 3, '上游退出码原样透传（不改写成 1）');
  assert.ok(stderr.includes(rawErr), '原始错误必须**逐字**出现在 stderr（不改写/不美化）');
  const resultPath = RE.result.exec(stdout.split('\n').find((l) => RE.result.test(l)))[1];
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(result.exit, 3);
  assert.equal(result.response, '', '失败轮没有文本');
});

test('⑥i 端到端超时：杀进程树、exit 124、done 行带 (超时)、result.timedOut=true', (t) => {
  const dir = makeTempDir('e2e-timeout');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { cliPath, idsPath } = writeFakeCli(dir);
  const started = Date.now();
  const { r, stdout } = runExecutor(dir, cliPath, idsPath, ['--prompt', 'x', '--tag', 'T7', '--timeout-min', '0.05'], { FAKE_RUN_MODE: 'hang' });
  const elapsedSec = (Date.now() - started) / 1000;
  assert.equal(r.status, 124, '超时退出码必须是 124');
  assert.ok(elapsedSec < 30, `应在秒级被终止（实测 ${elapsedSec.toFixed(1)}s）`);
  const done = stdout.split('\n').find((l) => RE.done.test(l));
  assert.ok(done && done.includes('exit=124 (超时)'), `done 行: ${done}`);
  const resultPath = RE.result.exec(stdout.split('\n').find((l) => RE.result.test(l)))[1];
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(result.timedOut, true);
  assert.equal(result.exit, 124);
});

test('⑥j 端到端：找不到 opencode ⇒ exit 1 + 可读错误（不崩）', (t) => {
  const dir = makeTempDir('e2e-nocli');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [RUNNER, '--prompt', 'x'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    // OPENCODE_CLI 指向不存在的文件；APPDATA 指向空目录；PATH 清掉以免 where 找到真身
    env: { ...process.env, OPENCODE_CLI: join(dir, 'nope.exe'), APPDATA: dir, PATH: '', SystemRoot: process.env.SystemRoot },
  });
  assert.equal(r.status, 1);
  assert.match(String(r.stderr), /找不到 opencode 可执行文件/);
  assert.ok(!String(r.stdout).includes('done exit='), '没有派发就不该打 done 行');
});

/* ============================ ⑦ 结算语义（固定 15s 兜底误杀 BUG 的回归） ============================ */

test('⑦a resolveExitCode：超时 124 最高优先；否则透传真实码；拿不到才 1', () => {
  assert.equal(oc.resolveExitCode({ timedOut: true, spawnError: false, settledCode: 0, childExitCode: 0 }), 124, '超时永远是 124');
  assert.equal(oc.resolveExitCode({ timedOut: false, spawnError: true, settledCode: null, childExitCode: null }), 1);
  assert.equal(oc.resolveExitCode({ timedOut: false, spawnError: false, settledCode: 3, childExitCode: 3 }), 3, '上游码原样透传');
  assert.equal(oc.resolveExitCode({ timedOut: false, spawnError: false, settledCode: null, childExitCode: 7 }), 7, '兜底收尾用子进程真实码');
  assert.equal(oc.resolveExitCode({ timedOut: false, spawnError: false, settledCode: null, childExitCode: null }), 1, '拿不到码才 1（不谎报 0）');
  assert.equal(oc.SETTLE_GRACE_MS, 120_000);
});

test('⑦b 端到端回归：慢但正常的调用**不得被固定 15s 兜底误杀**（GLM 首响 ~14.2s 的同类场景）', (t) => {
  const dir = makeTempDir('e2e-slow');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { cliPath, idsPath } = writeFakeCli(dir);
  const ndjson = join(dir, 'fixture.ndjson');
  writeFileSync(ndjson, PONG_RUN_NDJSON);
  const started = Date.now();
  /* 假 CLI 睡 16.5s（**故意超过旧版 15s 固定兜底**），--timeout-min 0.5（=30s）显然没到 ⇒ 必须正常收尾 */
  const { r, stdout } = runExecutor(
    dir, cliPath, idsPath,
    ['--prompt', 'x', '--tag', 'T8', '--timeout-min', '0.5'],
    { FAKE_NDJSON_FILE: ndjson, FAKE_SLEEP_MS: '16500' },
  );
  const sec = (Date.now() - started) / 1000;
  assert.equal(r.status, 0, `慢但正常必须 exit 0（实测 ${sec.toFixed(1)}s）`);
  assert.ok(sec > 15, `必须真的跑过旧版的 15s 兜底线，否则测不到回归（实测 ${sec.toFixed(1)}s）`);
  const done = stdout.split('\n').find((l) => RE.done.test(l));
  assert.ok(done.includes('exit=0') && !done.includes('(超时)'), `done 行: ${done}`);
  const result = JSON.parse(readFileSync(RE.result.exec(stdout.split('\n').find((l) => RE.result.test(l)))[1], 'utf8'));
  assert.equal(result.response, 'PONG');
  assert.equal(result.settleForced, false, '正常收尾不得标成兜底');
  assert.equal(result.timedOut, false);
});

test('⑦ 源锁：不伪装身份 / 不碰用户 OpenCode 数据目录 / 探测不与 run 并发 / 兜底不脱离 --timeout-min / --auto 默认关', () => {
  const src = readFileSync(RUNNER, 'utf8');
  /* 「不许出现」的断言必须**先剥注释**：文件头注释里正是写着「不伪造 User-Agent」「不碰 opencode.db」，
   * 直接 grep 全文会把这些自我约束说明当成违规。 */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/user-agent['"]?\s*:/i.test(code), '不许伪造 User-Agent');
  assert.ok(!/homedir\s*\(/.test(code), '不许读 HOME（用户 OpenCode 配置/数据目录在 ~ 下）');
  assert.ok(!/opencode\.db/.test(code), '不碰 opencode.db');
  assert.ok(!/runCliAsync\s*\(/.test(code), '已删除并发探测入口（真机事故：并发第二个 opencode 进程会让 run 零输出退出）');
  assert.ok(/META_CACHE_TTL_MS/.test(code) && /'models', '--verbose'/.test(code), '探测改为顺序 + 缓存');
  assert.ok(!/case '--auto':\s*\n\s*throw/.test(code), '--auto 不再 fail-fast（Lead 裁决方案 B）');
  assert.ok(/if \(opt\.auto\) args\.push\('--auto'\)/.test(code), '--auto 只在显式传入时透传');
  assert.ok(oc.parseArgs(['--prompt', 'x']).auto === false, '默认关');
  /* 事故注释必须在源码里留档（后来人不会再犯），且**不得过度推广**：
   * Lead 对照实验 2/2 证明「同机并发的两个独立 opencode run 可行」，危险源只是「同链 run 期间又起一个」。 */
  assert.ok(/真机事故/.test(src) && /顺序执行/.test(src), '并发探测事故注释留档（且已改为顺序执行）');
  assert.ok(/勿过度推广/.test(src) && /两个独立/.test(src), '不得把事故说成「并发 OpenCode 都危险」（2/2 对照实验反证）');
  /* 固定 15s 兜底误杀 BUG（Lead e2e 抓到）的源锁：兜底必须挂在 --timeout-min 之后，且定时器要清 */
  assert.ok(!/forced: true \}\), 15_000\)/.test(code), '不得再有独立于 --timeout-min 的固定短兜底');
  assert.ok(/settleDeadlineMs = opt\.timeoutMin \* 60_000 \+ SETTLE_GRACE_MS/.test(code), '兜底 = timeoutMin*60s + 宽限');
  assert.ok(/clearTimeout\(settleTimer\)/.test(code), '兜底定时器必须清理（否则 race 败者让进程多挂 sett-time）');
  assert.ok(/settleForced: forcedSettle/.test(code) && /settleForcedAfterSec/.test(code), 'result.json 必须区分「兜底收尾」与「超时」');
  assert.ok(!/Object\.keys\(summary\.eventCounts\)\.length === 0\) \{\s*process\.stderr\.write\(\s*`\$\{PREFIX\} 诊断：opencode 静默退出/.test(code), '旧「静默退出」诊断写法已替换');
  /* 诊断纪律：先报客观事实，再列**可能**原因（不断言单一原因） */
  assert.ok(/stdout=\$\{outBytes\}B stderr=\$\{errBytes\}B/.test(code), '诊断必须报客观事实（字节数等）');
  assert.ok(/兜底收尾=\$\{forcedSettle/.test(code) && /超时=\$\{timedOut/.test(code), '诊断必须报超时/兜底判定');
  assert.ok(/\*\*可能\*\*原因/.test(code), '诊断只列可能原因，不断言');
  /* 前缀唯一来源：不得硬编码前缀 */
  assert.ok(src.includes("prefixFor('opencode')"), '前缀取自 run-line-protocol.mjs');
  assert.ok(!code.includes("'[opencode-run]"), '代码里不写死前缀字面量');
});
