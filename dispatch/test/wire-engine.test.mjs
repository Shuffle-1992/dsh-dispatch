// 双引擎（OpenCode 接入）：**wire 层透传** + **核心引擎路由**的功能断言。
//
// 起因（本轮交付时发现的真实缺口）：`index.js` 的工具 schema 加了 `engine` 参数、core 也支持
// `spec.engine`，但 `wire.host.mjs` 的 dispatch 分支有一份 **spec 字段白名单**
// （原为 `['model','provider','mode','tag','cwd','resume']`）——白名单外的参数被**静默丢掉**。
// 主路径不依赖它（`provider: "opencode/<model>"` 由 core 自动识别引擎），但"工具文档承诺过
// 的入参在 wire 层消失"属于静默失真，故这里把两层都钉住：
//   ① 源码锁：`engine` 在白名单里（防再次被删）
//   ② 功能断言：走真实 `createActionHandler` ⇒ 工具入参 ⇒ spec ⇒ job，`engine` 必须落到 job.spec
//   ③ 引擎路由：`provider: 'opencode/<model>'` ⇒ spec 规整为 {engine:opencode, provider:opencode,
//      model:'opencode/<model>'}，且**真的会去 spawn OpenCode 执行器**（用临时假执行器验证，
//      不触网、不消耗额度）
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../core/dispatch-core.mjs';
import { createActionHandler } from '../wire.host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const FAKE_ZCODE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs'); // 引擎=zcode 时用（既有假执行器）

const tempDirs = [];
const newDir = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tempDirs.push(d);
  return d;
};
const dispatchers = []; // 供 test.after 优雅收尾（见下方注释：不 kill 会漏异步写盘 ⇒ exit 1）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'failed', 'killed', 'interrupted'];
test.after(async () => {
  /* ⚠️ 不能直接删临时目录：dispatcher 的 persist() 是**异步/后台**写盘
   * （`state/jobs.json.<pid>.<ts>.tmp` 临时文件 + rename），若在写入途中把 workRoot 删掉，
   * 会抛 ENOENT 并变成 **uncaughtException** ⇒ node:test 判「测试结束后仍有异步活动」⇒ exit 1
   * （即使 pass 6 / fail 0，进程退出码仍是 1 —— 既有 run-tests 脚本按退出码判定，会误报失败）。
   * 正确做法：先 kill 所有未落地 job，等它们真正落地（persist 完成），再删目录。 */
  for (const { d } of dispatchers) {
    for (const j of d.list() ?? []) {
      if (!TERMINAL.includes(j.state) && j.state !== 'paused') {
        try { d.kill(j.id, 'test-teardown'); } catch { /* 已结束 */ }
      }
    }
  }
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const busy = dispatchers.some(({ d }) => (d.list() ?? []).some((j) => !TERMINAL.includes(j.state) && j.state !== 'paused'));
    if (!busy) break;
    await sleep(50);
  }
  await sleep(150); // 让最后一次 persist（tmp→rename）落地
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/* 假 OpenCode 执行器：打 `[opencode-run]` 前缀的行（协议见 collab-kit/run-line-protocol.mjs）。
 * 由测试**用 node 写盘**（不用 pwsh/Set-Content —— 见 pitfalls #3：BOM 会让解析静默失效）。
 * 除了行协议，还把**自己收到的 argv** 落到 marker 文件里 —— 这是"core 确实按 OpenCode 的参数
 * 形态 spawn 了 OpenCode 执行器"的最硬证据（argv 形态是两引擎最实在的差别）。
 * 也支持 `--list-models` / `--version`（core 的探测与执行共用同一路径）。 */
function writeFakeOpenCodeRunner(dir, markerPath) {
  const p = join(dir, 'fake-opencode-runner.mjs');
  writeFileSync(p, [
    "import { writeFileSync } from 'node:fs';",
    "const argv = process.argv.slice(2);",
    `if (argv.includes('--version')) { console.log('9.9.9-fake'); process.exit(0); }`,
    `if (argv.includes('--list-models') || argv.includes('--list-providers')) { console.log('opencode/fake-model-free'); process.exit(0); }`,
    `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(argv));`,
    "console.log('[opencode-run] tag=wire-engine mode=opencode cwd=' + process.cwd());",
    "console.log('[opencode-run] cli=fake-opencode');",
    "console.log('[opencode-run] provider=opencode model=opencode/deepseek-v4.1-flash-free');",
    "console.log('[opencode-run] usage requests=1 in=10 out=2 cacheRead=0');",
    "console.log('[opencode-run] done exit=0 elapsed=0.2s session=ses_fake model=opencode/deepseek-v4.1-flash-free responseChars=4');",
    '',
  ].join('\n'));
  return p;
}

async function waitTerminal(d, id, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const j = d.get(id);
    if (j && (TERMINAL.includes(j.state) || j.state === 'paused')) return j;
    await sleep(20);
  }
  throw new Error(`waitTerminal(${id}) 超时（最后状态：${d.get(id)?.state}）`);
}

function mkApi(opts = {}) {
  const work = newDir('dsp-oc-wire-');
  const d = createDispatcher({ runnerPath: FAKE_ZCODE_RUNNER, workRoot: work, maxConcurrent: 4, ...opts });
  dispatchers.push({ d });
  return { d, api: createActionHandler(d, { switchPath: join(newDir('dsp-oc-sw-'), 'sw.json') }) };
}

/* ---------- ① 源码锁：engine 在 wire 的 spec 白名单里 ---------- */
test('wire.host 的 dispatch spec 白名单包含 engine（防静默丢参）', () => {
  const src = readFileSync(join(PKG, 'wire.host.mjs'), 'utf8');
  const m = src.match(/for \(const k of \[([^\]]*)\]\) \{/);
  assert.ok(m, '能找到 dispatch 分支的 spec 白名单');
  const keys = m[1].match(/'([a-zA-Z]+)'/g).map((x) => x.replace(/'/g, ''));
  assert.ok(keys.includes('engine'), `白名单含 engine（实际：${keys.join(',')}）`);
  // 既有键一个都不能少（防顺手删掉）
  for (const k of ['model', 'provider', 'mode', 'tag', 'cwd', 'resume']) {
    assert.ok(keys.includes(k), `既有键 ${k} 仍在白名单里`);
  }
});

/* ---------- ② 功能：engine 经 wire ⇒ spec ⇒ job ---------- */
test('★ engine 经 createActionHandler 透传进 job.spec（工具入参不再被静默丢弃）', async () => {
  const { d, api } = mkApi();
  const dis = await api('dispatch', { kind: 'prompt', prompt: 'x', tag: 'E1', engine: 'opencode', timeoutMin: 1 });
  assert.equal(dis.ok, true, `dispatch 应成功（error=${dis.error}）`);
  const job = d.get(dis.job.id);
  assert.equal(job.spec.engine, 'opencode', 'job.spec.engine 必须来自工具入参（wire 白名单透传）');
});

test('★ provider="opencode/<model>" 自动识别引擎并规整 spec（无需显式 engine）', async () => {
  const { d, api } = mkApi();
  const dis = await api('dispatch', {
    kind: 'prompt', prompt: 'x', tag: 'E2', timeoutMin: 1,
    provider: 'opencode/deepseek-v4.1-flash-free',
  });
  assert.equal(dis.ok, true, `dispatch 应成功（error=${dis.error}）`);
  const spec = d.get(dis.job.id).spec;
  assert.equal(spec.engine, 'opencode', 'provider 形态即判据 ⇒ engine=opencode');
  assert.equal(spec.provider, 'opencode', 'provider 规整为引擎名（不再带 /model）');
  assert.equal(spec.model, 'opencode/deepseek-v4.1-flash-free', '模型取自通道 id');
});

test('★ provider="opencode/<model>" 真的走 OpenCode 执行器（spawn 到 opencodeRunnerPath，参数形态为 OpenCode 专用）', async () => {
  const dir = newDir('dsp-oc-exec-');
  const marker = join(dir, 'argv.json');
  const ocRunner = writeFakeOpenCodeRunner(dir, marker);
  const { d, api } = mkApi({ opencodeRunnerPath: ocRunner });
  const dis = await api('dispatch', {
    kind: 'prompt', prompt: 'x', tag: 'E3', timeoutMin: 1,
    provider: 'opencode/deepseek-v4.1-flash-free',
  });
  assert.equal(dis.ok, true, `dispatch 应成功（error=${dis.error}）`);
  const job = await waitTerminal(d, dis.job.id);
  assert.equal(job.state, 'done', `假 OpenCode 执行器应让它 done（实际 ${job.state}；warnings=${JSON.stringify(job.parseWarnings)}）`);
  /* 证据 1：`[opencode-run]` 前缀的行**被解析**（done 行带来 sessionId / usage），
   * 且没有被当成"未解析的 zcode 行"记告警。 */
  assert.equal(job.sessionId, 'ses_fake', 'done 行的 session 被解析 ⇒ [opencode-run] 前缀确实生效');
  assert.equal(job.usage.inputTokens, 10, 'usage 行被解析 ⇒ 用量聚合走通');
  assert.equal(job.engine, 'opencode', 'job 上带引擎字段');
  assert.ok(!job.parseWarnings.some((w) => /unparsed \[zcode-run\]|unparsed \[opencode-run\]/.test(w)),
    'OpenCode 的行不该被判为未解析');
  /* 证据 2：执行器收到的 argv 是 **OpenCode 形态**（有 --model / --prompt；
   * 且**没有** ZCode 专属的 --provider / --mode）—— 这是"路由到 OpenCode 执行器"最硬的证据。 */
  const argv = JSON.parse(readFileSync(marker, 'utf8'));
  assert.ok(argv.includes('--prompt'), `argv 含 --prompt（实际 ${JSON.stringify(argv)}）`);
  assert.ok(argv.includes('--model') && argv.includes('opencode/deepseek-v4.1-flash-free'),
    'argv 含 OpenCode 模型 id');
  assert.ok(!argv.includes('--provider'), 'OpenCode 执行器不接收 ZCode 的 --provider');
  assert.ok(!argv.includes('--mode'), 'OpenCode 执行器不接收 ZCode 的 --mode');
  assert.ok(!argv.includes('--auto'), '★ 默认绝不开 --auto（硬约束：不放行所有未显式拒绝的权限）');
});

/* ---------- ③ zcode 路径零回归：不传 engine / 传 plan ⇒ 仍走 zcode 假执行器 ---------- */
test('不传 engine / provider=plan ⇒ 引擎仍是 zcode（既有行为零改动）', async () => {
  const { d, api } = mkApi();
  const a = await api('dispatch', { kind: 'prompt', prompt: 'x', tag: 'Z1', timeoutMin: 1 });
  assert.equal(a.ok, true);
  assert.equal(d.get(a.job.id).spec.engine, 'zcode', '默认引擎 = zcode');
  const b = await api('dispatch', { kind: 'prompt', prompt: 'x', tag: 'Z2', timeoutMin: 1, provider: 'plan' });
  assert.equal(b.ok, true);
  assert.equal(d.get(b.job.id).spec.engine, 'zcode', 'provider=plan ⇒ zcode');
  const jb = await waitTerminal(d, b.job.id);
  assert.ok(TERMINAL.includes(jb.state), `zcode 假执行器照常跑到终态（实际 ${jb.state}）`);
});

/* ---------- ④ 引擎非法值/不支持组合：可读报错、不崩 ---------- */
test('validateSpec：opencode 引擎 + mode ⇒ 可读 TypeError（不是静默忽略）', async () => {
  const { api } = mkApi();
  const r = await api('dispatch', {
    kind: 'prompt', prompt: 'x', tag: 'E4', timeoutMin: 1,
    provider: 'opencode/deepseek-v4.1-flash-free', mode: 'edit',
  });
  assert.equal(r.ok, false, '应被拒绝');
  assert.match(String(r.error), /mode|opencode/i, `报错要可读（实际：${r.error}）`);
});
