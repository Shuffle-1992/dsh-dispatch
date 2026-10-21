// ZB-51 T1 测试：三引擎自动发现层 `collab-kit/engine-discover.mjs`
//
// 两层验证：
//   ① **离线**（主体）：注入假 fs / 假 probe，覆盖五级优先级、PATHEXT、.cjs 形态、
//      "找到但未登录"、全失败的可解释原因、超时不抛……**不依赖本机装了什么**。
//   ② **真机冒烟**（末尾）：对真实环境跑一次 discoverAll，断言"发现的形态/版本自洽"
//      （本机没装的引擎只断言"不抛 + 有可读 reason"，不强行要求 found）。
//
// 跑法：node dispatch/test/engine-discover.test.mjs
import { strict as assert } from 'node:assert';
import { statSync as realFs_statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { ENGINES, discoverEngine, discoverAll, describeDiscovery, parseVersion, classifyEntry } from '../../collab-kit/engine-discover.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
void HERE;
const realFs = { statSync: realFs_statSync };
/* ⚠️ 发现层用**真实 homedir()** 拼用户级路径（这是它的职责），所以测试造"存在的文件"时
 * 必须用同一个 HOME 去拼 —— 否则写死 `c:\u\...` 会永远对不上（本测试第一版就踩了这个坑）。 */
const HOME = homedir();

let pass = 0; const fail = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };

/** 造一个假 fs：把"存在的文件/目录"列表变成 existsSync/statSync/readdirSync。
 *
 * 默认 **withDrives:false** —— 不认盘符根，从而**不触发跨盘符扫描**，避免假 fs 意外命中
 * 本机真实安装（本机恰好装了 ZCode；若不隔离，断言会变成"测真机"而非测逻辑）。
 * 需要测跨盘符时显式 `{ withDrives: true }`。 */
function fakeFs(files = [], dirs = [], { withDrives = false } = {}) {
  const F = new Set(files.map((p) => p.toLowerCase()));
  const D = new Set(dirs.map((p) => p.toLowerCase()));
  if (withDrives) for (const d of realDriveRoots()) D.add(d.toLowerCase());
  return {
    existsSync: (p) => F.has(String(p).toLowerCase()) || D.has(String(p).toLowerCase()),
    statSync: (p) => {
      const s = String(p).toLowerCase();
      if (D.has(s)) return { isFile: () => false, isDirectory: () => true, size: 0 };
      if (F.has(s)) return { isFile: () => true, isDirectory: () => false, size: 1024 };
      throw new Error('ENOENT');
    },
    readdirSync: () => [],
  };
}

/** 本机真实存在的盘符根（与发现层的枚举方式一致）。 */
function realDriveRoots() {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (let c = 65; c <= 90; c += 1) {
    const root = `${String.fromCharCode(c)}:\\`;
    try { if (realFs.statSync(root).isDirectory()) out.push(root); } catch { /* 不存在 */ }
  }
  return out;
}
const fakeRun = (map) => (cmd, args) => {
  const key = `${cmd} ${(args ?? []).join(' ')}`;
  for (const [k, v] of Object.entries(map)) if (key.includes(k)) return v;
  return { code: 1, stdout: '', stderr: '' };
};

console.log('① 纯函数：版本解析与形态判定');
{
  ok(parseVersion('1.19.2') === '1.19.2', 'parseVersion 解析裸版本号');
  ok(parseVersion('qoderclicn 1.1.73\n') === '1.1.73', 'parseVersion 从多行输出里取版本');
  ok(parseVersion('no version here') === null, '★ 取不到就返回 null（不伪造）');
  ok(classifyEntry('F:\\a\\zcode.cjs') === 'cjs', '.cjs 形态 → cjs（调用方需前置 node）');
  ok(classifyEntry('C:\\npm\\opencode.cmd') === 'cmd', '.cmd → cmd');
  ok(classifyEntry('C:\\x\\qoderclicn.exe') === 'exe', '.exe → exe');
  ok(classifyEntry(null) === null, 'null → null');
}

console.log('\n② 五级优先级：env 命中即返回，不继续往下找');
{
  const fs = fakeFs(['c:\\env\\my-zcode.cjs', 'c:\\path\\zcode.cmd']);
  const r = await discoverEngine('zcode', {
    fsProbe: fs,
    env: { ZCODE_CLI: 'c:\\env\\my-zcode.cjs', PATH: 'c:\\path' },
    runProbe: fakeRun({ '--version': { code: 0, stdout: '0.16.9', stderr: '' } }),
  });
  ok(r.found === true, 'env 覆盖命中 ⇒ found');
  ok(r.entry.toLowerCase() === 'c:\\env\\my-zcode.cjs', `★ 用的是 env 指定的那个（实际 ${r.entry}）`);
  ok(r.entryKind === 'cjs', 'entryKind 如实报 cjs');
  ok(r.candidatesTried.some((c) => c.level === 'env' && c.ok), 'candidatesTried 记录了 env 级命中');
  ok(r.candidatesTried.every((c) => c.level === 'env'), '★ env 命中后**不再**尝试其它级别');
}

console.log('\n③ 客户端自带 CLI：跨盘符扫描（原硬编码在 F: 盘，这是关键修复）');
{
  /* 跨盘符的本质 = "装在任意盘都能找到"。用一个**本机真实存在**的盘符来验（不能写死 E:，
   * 本机未必有该盘 —— 那样会变成在测"E 盘存不存在"）。 */
  const drives = realDriveRoots();
  const drive = drives.find((d) => !d.toLowerCase().startsWith('c:')) ?? drives[0];
  if (!drive) {
    console.log('  （非 Windows 或枚举不到盘符，跳过跨盘符用例）');
  } else {
    const cli = join(drive, 'Program Files', 'ZCode', 'resources', 'glm', 'zcode.cjs');
    const fs = fakeFs([cli], [], { withDrives: true });
    const r = await discoverEngine('zcode', {
      fsProbe: fs,
      env: { PATH: '', ProgramFiles: 'c:\\nonexistent-programs' },
      runProbe: fakeRun({ '--version': { code: 0, stdout: '0.16.9', stderr: '' } }),
    });
    ok(r.found === true, `★ 装在 ${drive}（非默认位置）也能找到 —— 不再依赖硬编码盘符`);
    ok(r.entry && r.entry.toLowerCase() === cli.toLowerCase(), `命中 ${drive} 的自带 CLI（实际 ${r.entry}）`);
    ok(r.form === 'client-bundled-cli', '形态标为 client-bundled-cli');
  }
}

console.log('\n④ PATH 多命中：只取**第一个可执行**的（官方 dispatcher 的教训 + 真机 EINVAL 坑）');
{
  /* 真机场景：npm 目录里同时有 opencode（无扩展 shell 脚本）、opencode.cmd、opencode.ps1。
   * 若先命中无扩展名那个，Windows 下 spawnSync 会 EINVAL ⇒ 拿不到版本。 */
  const fs = fakeFs([
    'c:\\npm\\opencode',
    'c:\\npm\\opencode.ps1',
    'c:\\npm\\opencode.cmd',
  ]);
  const r = await discoverEngine('opencode', {
    fsProbe: fs,
    env: { PATH: 'c:\\npm' },
    runProbe: fakeRun({ '--version': { code: 0, stdout: '1.19.2', stderr: '' } }),
  });
  ok(r.found === true, 'PATH 命中 ⇒ found');
  ok(/\.cmd$/i.test(r.entry), `★ 取 .cmd 而不是无扩展名的 shell 脚本（实际 ${r.entry}）`);
  ok(r.entryKind === 'cmd', 'entryKind 如实报 cmd');
  /* 汇总式记录：PATH 级只记一条，不逐目录刷屏 */
  const pathRows = r.candidatesTried.filter((c) => c.level === 'path');
  ok(pathRows.length === 1, `★ PATH 级只记 1 条汇总记录（实际 ${pathRows.length}）`);
}

console.log('\n⑤ Qoder：CN 版优先 + **用 --list-models 判登录态**（不能用 .auth 目录）');
{
  const exe = join(HOME, '.qoder-cn', 'bin', 'qoderclicn', 'qoderclicn.exe');
  const fs = fakeFs([exe]);
  const r = await discoverEngine('qoder', {
    fsProbe: fs,
    env: { PATH: '' },
    runProbe: fakeRun({
      '--version': { code: 0, stdout: '1.1.73', stderr: '' },
      '--list-models': { code: 0, stdout: 'MODEL\nAuto\nGLM-5.3\n', stderr: '' },
    }),
  });
  ok(r.found === true, 'Qoder CN CLI 命中');
  ok(r.variant === 'cn', 'variant 标为 cn');
  ok(r.version === '1.1.73', `版本解析正确（${r.version}）`);
  ok(r.loggedIn === true, '★ --list-models 成功 ⇒ 已登录');
  ok(/list-models/.test(r.loginEvidence), `登录依据写明是 --list-models（${r.loginEvidence}）`);
}

console.log('\n⑥ Qoder 已装但**未登录**：必须给出可操作提示（真机实测：IDE 登录 ≠ CLI 登录）');
{
  const exe = join(HOME, '.qoder-cn', 'bin', 'qoderclicn', 'qoderclicn.exe');
  const fs = fakeFs([exe]);
  const r = await discoverEngine('qoder', {
    fsProbe: fs,
    env: { PATH: '' },
    runProbe: fakeRun({
      '--version': { code: 0, stdout: '1.1.73', stderr: '' },
      '--list-models': { code: 1, stdout: '', stderr: 'Not logged in. Run `qoderclicn login` to authenticate.' },
    }),
  });
  ok(r.found === true, 'CLI 存在 ⇒ found 仍为 true（不能因为未登录就当作没找到）');
  ok(r.loggedIn === false, '★ loggedIn=false');
  ok(r.warnings.some((w) => /login/i.test(w)), `★ warning 给出登录方式（${r.warnings.join(' / ')}）`);
  /* 反例保护：即使 `.auth/` 目录存在，也不能据此判"已登录"（真机：里面只有 machine_id） */
  const fs2 = fakeFs([exe], [join(HOME, '.qoder-cn', '.auth')]);
  const r2 = await discoverEngine('qoder', {
    fsProbe: fs2, env: { PATH: '' },
    runProbe: fakeRun({ '--version': { code: 0, stdout: '1.1.73', stderr: '' }, '--list-models': { code: 1, stdout: '', stderr: 'Not logged in.' } }),
  });
  ok(r2.loggedIn === false, '★ 有 .auth/ 目录但 CLI 报未登录 ⇒ 仍判未登录（不误报已登录）');
}

console.log('\n⑦ 凭据只判"存在性/大小"，**绝不解析内容**');
{
  /* 关键：必须给一个**可发现的 CLI**（用 ZCODE_HOME 指向安装根），否则流程走不到登录态那步。
   * 凭据路径由模块用真实 homedir 拼，故这里也用同一个 HOME。 */
  const root = join(HOME, 'fake-zcode-root');
  const cli = join(root, 'resources', 'glm', 'zcode.cjs');
  const cred = join(HOME, '.zcode', 'v2', 'credentials.json');
  const r = await discoverEngine('zcode', {
    fsProbe: fakeFs([cli, cred]),
    env: { PATH: '', ZCODE_HOME: root },
    runProbe: fakeRun({ '--version': { code: 0, stdout: '0.16.9', stderr: '' } }),
  });
  ok(r.found === true, 'CLI 可发现（ZCODE_HOME 指向安装根）');
  /* 登录依据只应提到"存在"，不应包含任何 JSON 字段名（说明没读内容） */
  ok(r.loggedIn === true, 'ZCode 凭据存在 ⇒ 已登录');
  ok(typeof r.loginEvidence === 'string' && r.loginEvidence.length > 0, '有登录依据说明');
  ok(!/(apiKey|accessToken|refreshToken|"key")/i.test(r.loginEvidence), '★ 依据里没有任何凭据字段名 ⇒ 没解析内容');
  ok(/存在/.test(r.loginEvidence), `依据只说"存在"（${r.loginEvidence}）`);
  /* 反例：凭据文件不存在 ⇒ 未登录（且依据说明里点出找的是哪个路径） */
  const r2 = await discoverEngine('zcode', {
    fsProbe: fakeFs([cli]),
    env: { PATH: '', ZCODE_HOME: root },
    runProbe: fakeRun({ '--version': { code: 0, stdout: '0.16.9', stderr: '' } }),
  });
  ok(r2.loggedIn === false, '凭据不存在 ⇒ loggedIn=false');
  ok(/credentials\.json/.test(r2.loginEvidence), `依据里给出查过的凭据路径（${r2.loginEvidence}）`);
}

console.log('\n⑧ 全失败：返回可解释原因（列出查过多少处 + 怎么修），且**不抛**');
{
  const fs = fakeFs([], ['c:\\']);
  const r = await discoverEngine('zcode', { fsProbe: fs, env: { PATH: '', ProgramFiles: 'c:\\Program Files' }, runProbe: fakeRun({}) });
  ok(r.found === false, 'found=false');
  ok(r.entry === null && r.form === null, 'entry/form 为 null');
  ok(/未找到/.test(r.reason), 'reason 说明未找到');
  ok(/已查 \d+ 处/.test(r.reason), `★ reason 报出查过的处数（便于自查）`);
  ok(/ZCODE_HOME|ZCODE_CLI/.test(r.reason), '★ reason 给出修复方式');
  ok(Array.isArray(r.candidatesTried) && r.candidatesTried.length > 0, 'candidatesTried 记录了尝试位置');
  ok(r.candidatesTried.every((c) => typeof c.level === 'string' && typeof c.value === 'string'),
    '每条候选都有 level/value（结构稳定）');
}

console.log('\n⑨ 探测超时/异常：不得抛到调用方');
{
  const exe = join(HOME, '.qoder-cn', 'bin', 'qoderclicn', 'qoderclicn.exe');
  const fs = fakeFs([exe]);
  const throwing = () => { throw new Error('probe exploded'); };
  const r = await discoverEngine('qoder', { fsProbe: fs, env: { PATH: '' }, runProbe: throwing });
  ok(r.found === true, '★ 探测抛异常不影响 found（文件确实在）');
  ok(r.version === null || typeof r.version === 'string', 'version 为 null 或字符串（不崩）');
  ok(r.warnings.some((w) => /探测失败|exploded/.test(w)), '把探测异常写进 warnings 而不是抛出去');
}

console.log('\n⑩ 未知引擎名 ⇒ TypeError（明确的编程错误，不静默）');
{
  let err = null;
  try { await discoverEngine('nope', { fsProbe: fakeFs([]), env: {}, runProbe: fakeRun({}) }); } catch (e) { err = e; }
  ok(err instanceof TypeError, '抛 TypeError');
}

console.log('\n⑪ 真机冒烟：discoverAll 对三个引擎都返回结构完整的结论');
{
  const r = await discoverAll({ timeoutMs: 25000 });
  ok(ENGINES.every((e) => r[e] && r[e].engine === e), '三个引擎都有结果对象');
  ok(ENGINES.every((e) => typeof r[e].reason === 'string' && r[e].reason.length > 0), '每个都有非空 reason');
  ok(ENGINES.every((e) => Array.isArray(r[e].warnings)), '每个都有 warnings 数组');
  for (const e of ENGINES) console.log(`       ${describeDiscovery(r[e])}`);
  /* 本机确定装了 ZCode 与 OpenCode：断言"若 found 则 version 非空"（发现质量），
   * 不硬性要求 found（别人的机器可能没装 —— 测试要能跨机运行）。 */
  for (const e of ENGINES) {
    if (r[e].found) ok(typeof r[e].version === 'string' && r[e].version.length > 0, `${e}：found ⇒ version 非空（${r[e].version}）`);
    else console.log(`       （${e} 本机未发现，跳过 version 断言）`);
  }
  ok(r.zcode.found || r.zcode.reason.includes('未找到'), 'zcode 结论自洽');
}

console.log('\n⑫ core 集成（T2）：listChannels() 带上 engineDetail 与可读 warning');
{
  const os = await import('node:os');
  const fsMod = await import('node:fs');
  const { createDispatcher } = await import('../core/dispatch-core.mjs');
  const work = fsMod.mkdtempSync(join(os.tmpdir(), 'dsp-engdet-'));
  const fakeDisc = async () => ({
    zcode: {
      engine: 'zcode', found: true, form: 'client-bundled-cli', entry: 'F:\\z\\zcode.cjs', entryKind: 'cjs',
      version: '0.16.9', loggedIn: true, variant: null, loginEvidence: '凭据文件存在', reason: '已知安装位置命中', warnings: [],
    },
    opencode: {
      engine: 'opencode', found: true, form: 'cli', entry: 'C:\\npm\\opencode.cmd', entryKind: 'cmd',
      version: '1.19.2', loggedIn: null, variant: null, loginEvidence: '登录态未知', reason: 'PATH 命中', warnings: [],
    },
    /* qoder：找到 CLI 但**未登录** —— 这是最容易被误判成"执行器坏了"的状态，必须给可操作 warning */
    qoder: {
      engine: 'qoder', found: true, form: 'cli', entry: 'C:\\q\\qoderclicn.exe', entryKind: 'exe',
      version: '1.1.73', loggedIn: false, variant: 'cn', loginEvidence: 'CLI 报 Not logged in（需先登录）',
      reason: '已知安装位置命中', warnings: ['Qoder CLI 存在但**未登录**：运行 `qoderclicn login`（浏览器设备码）'],
    },
  });
  try {
    const d = createDispatcher({
      runnerPath: 'C:\\x\\zcode-run.mjs',
      workRoot: work,
      ledgerPath: join(work, 'ledger.jsonl'),
      discoverImpl: fakeDisc,
      channelsProbeImpl: async () => 'id'.padEnd(34) + 'enabled   端点/模型\n' + 'builtin:bigmodel-coding-plan'.padEnd(34) + 'true      https://x | GLM-5.3',
    });
    const r = await d.listChannels();
    ok(!!r.engineDetail, '★ listChannels() 返回 engineDetail（T2 的核心交付）');
    ok(r.engineDetail.zcode.found === true && r.engineDetail.zcode.version === '0.16.9', 'zcode 明细：找到 + 版本');
    ok(r.engineDetail.zcode.form === 'client-bundled-cli', '★ 上报**形态**（面板据此显示 IDE/CLI 徽标）');
    ok(r.engineDetail.qoder.loggedIn === false, 'qoder 明细：找到但未登录');
    ok(r.engineDetail.qoder.variant === 'cn', 'qoder 明细：variant=cn（CN 版）');
    ok(r.engineDetail.zcode.summary.includes('zcode:'), '每个引擎都有可读 summary（一行说明）');
    /* 未登录必须变成**可操作** warning（否则用户只会看到"通道不见了"） */
    ok(r.warnings.some((w) => /qoder/.test(w) && /未登录/.test(w)), `★ 未登录 ⇒ 可读 warning（实际 ${JSON.stringify(r.warnings)}）`);
    /* 引擎清单仍与协议层一致（三条） */
    ok(Array.isArray(r.engines) && r.engines.join(',') === ENGINES.join(','), 'engines 与协议层 ENGINES 一致');
    /* 不found 时给"查过哪里"的原因。
     * ⚠️ 不能同时传 `channelsImpl`：那是测试替身，一旦在场 `discoveryEnabled` 就为 false
     * （既有纪律：替身在场不做真探测），发现逻辑根本不跑 —— 测试就测了个寂寞。 */
    const d2 = createDispatcher({
      runnerPath: 'C:\\x\\zcode-run.mjs', workRoot: work, ledgerPath: join(work, 'l2.jsonl'),
      discoverImpl: async () => ({ opencode: { engine: 'opencode', found: false, reason: '未找到（已查 12 处）', warnings: [] } }),
      channelsProbeImpl: async () => 'id'.padEnd(34) + 'enabled   端点/模型\n' + 'builtin:bigmodel-coding-plan'.padEnd(34) + 'true      https://x | GLM-5.3',
      zcodeConfigPath: join(work, 'no-config.json'),
      planCachePath: join(work, 'no-cache.json'),
      personalProviderPath: join(work, 'no-personal.json'),
      opencodeRunnerPath: '',
    });
    const r2 = await d2.listChannels();
    ok(r2.warnings.some((w) => /未检测到 opencode 引擎/.test(w) && /已查/.test(w)),
      `★ 没找到引擎 ⇒ warning 含原因与查过的处数（实际 ${JSON.stringify(r2.warnings)}）`);
  } finally {
    try { fsMod.rmSync(work, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
}

/* ZB-99b：WorkBuddy 登录态——探测缓存不可用时用**凭据文件 mtime** 兜底
 * 用户真机反馈「WorkBuddy 登录态时长好像就 10 分钟」，其实是旧缓存 TTL 让面板显示"未知"，
 * 登录本身一直在续期（真机：登录 21:03，凭据 02:14 仍在刷新，存活 5 小时+）。 */
{
  const fsm = await import('node:fs');
  const src = fsm.readFileSync(new URL('../../collab-kit/engine-discover.mjs', import.meta.url), 'utf8');
  ok(/凭据文件 \$\{ageMin\} 分钟前刷新过/.test(src),
    '★ 有"凭据 mtime 兜底"分支（缓存不可用时仍能判已登录）');
  ok(/const la = env && env\.LOCALAPPDATA/.test(src),
    '★ 兜底用 env.LOCALAPPDATA —— 写成 localAppData 会 ReferenceError 被吞掉（本文件已踩一次）');
  ok(/CodeBuddyExtension.*Data.*Public.*auth/.test(src), '兜底读的是真实凭据目录');
  ok(/if \(ageMin <= 24 \* 60\)/.test(src), '凭据新鲜度上限 24 小时（太旧不猜）');
}

console.log(`\n===== 引擎自动发现：${pass} PASS / ${fail.length} FAIL =====`);
for (const m of fail) console.log(`  ✗ ${m}`);
process.exit(fail.length ? 1 : 0);
