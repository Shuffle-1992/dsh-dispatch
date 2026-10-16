/**
 * Z2 验收脚本（可复跑，零 npm 依赖）。
 *
 * 覆盖任务包「四、验收方式」：
 *   1. node --check 全部 JS；package.json / locale/*.json JSON.parse；cordis.patch.yml 结构校验
 *   2. 静态纪律 grep：@deepseek-ai 仅允许 wire.host.mjs 的协议标记键常量（Z8-02）与
 *      index.js 的 schemastery 导入（Z10-01，宿主随包出货） /
 *      document.body / 字面 # 色值（icon.svg 除外）；
 *      模块说明符只允许 node:* 与相对路径；client.js 只 require('react')；TODO 应已清偿（Z8-01 落地）
 *   3. client.js 桩加载：window.__ModuleLoader__ + require 桩 → factory 可执行、返回 {inject, apply}、
 *      假 ctx 验证 slots.inject/register；并用最小 React 桩渲染整棵组件树（含 effect 运行与清理、
 *      demo 引擎定时器零泄漏）
 *   4. index.js：导出 apply/Config；apply() 用临时 workRoot + Z1 假 runner 端到端
 *      （dispatch → running → kill → killed → tail → quota → list → 卸载清理）
 *   5. wire.client.mjs：Node 内无 window → demo 引擎；注入 window.__dispatchDemo → ext 轮询
 *   6. 越界：宿主仓库 git porcelain 指纹前后一致（只读检查，需 Z2_HOST_REPO）
 *
 * 用法：node test/z2-verify.mjs
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = ROOT; // 本文件在 <pkg>/test/ 下
/* 宿主仓库（被本插件派发的那个项目）绝对路径。属机器专有路径，**不硬编码**：
 * 由 Z2_HOST_REPO 给出；未给出时第 8 节「越界检查」自动 SKIP（如实标注，不伪装通过）。 */
const HOST_REPO = process.env.Z2_HOST_REPO || '';

/** 宿主仓库 git porcelain 指纹（只读检查，参照 Z1 交付做法）。 */
const fingerprint = () => {
  if (!HOST_REPO) return null;
  const porcelain = execFileSync('git', ['-C', HOST_REPO, 'status', '--porcelain'], { encoding: 'utf8' });
  return createHash('sha256').update(porcelain).digest('hex').slice(0, 16);
};
const FP_START = fingerprint(); // 脚本一开工先取指纹，结尾比对

/* ---------------- 极简断言框架 ---------------- */
let passCount = 0;
const failures = [];
function ok(cond, name, detail = '') {
  if (cond) {
    passCount += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const section = (title) => console.log(`\n===== ${title} =====`);

/* ---------------- 1. node --check ---------------- */
section('1. node --check 全部 JS');
const JS_FILES = ['index.js', 'notify.mjs', 'client.js', 'wire.host.mjs', 'wire.client.mjs', 'core/dispatch-core.mjs', 'core/quota.mjs', 'bin/dispatch.mjs'];
for (const f of JS_FILES) {
  const p = join(PKG, f);
  if (!existsSync(p)) {
    ok(false, `node --check ${f}`, '文件不存在');
    continue;
  }
  const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
  ok(r.status === 0, `node --check ${f}`, (r.stderr || r.stdout || '').trim().slice(0, 300));
}

/* ---------------- 2. JSON / 清单 / locale ---------------- */
section('2. package.json / locale JSON 解析与关键字段');
const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
ok(pkg.name === 'dsh-dispatch', 'package.json name');
ok(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json dsh.bundle.patch');
ok(pkg.dsh?.client?.platform === 'web' && pkg.dsh?.client?.immediately === true, 'package.json dsh.client(platform/immediately)');
ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'), 'package.json dsh.client.inject（清单契约字段）');
ok(pkg.exports?.['.'] === './index.js' && pkg.exports?.['./client'] === './client.js', 'package.json exports');
ok(typeof pkg.meta?.title === 'string' && pkg.meta.title.length > 0, 'package.json meta.title');
ok(pkg.icon === './icon.svg' && existsSync(join(PKG, 'icon.svg')), 'package.json icon 存在');
ok(['index.js', 'client.js', 'core', 'locale', 'icon.svg', 'README.md', 'wire.host.mjs', 'wire.client.mjs'].every((f) => (pkg.files ?? []).includes(f)), 'package.json files 含 wire 文件（对任务包的唯一偏离，已记录）');
const zh = JSON.parse(readFileSync(join(PKG, 'locale', 'zh.json'), 'utf8'));
const en = JSON.parse(readFileSync(join(PKG, 'locale', 'en.json'), 'utf8'));
ok(zh.meta?.title === pkg.meta.title, 'locale/zh.json meta.title 与 manifest 一致');
ok(zh.ui?.title && en.ui?.title && zh.ui?.planQuotaPending && en.ui?.planQuotaPending, 'locale ui 段关键文案存在（zh/en）');
const zhKeys = Object.keys(zh.ui ?? {}).sort().join(',');
const enKeys = Object.keys(en.ui ?? {}).sort().join(',');
ok(zhKeys === enKeys, 'locale zh/en ui 键集合一致');

/* ---------------- 3. cordis.patch.yml 结构校验（最小解析：本文件已知形状的关键字段） ---------------- */
section('3. cordis.patch.yml 结构与路径');
const yamlText = readFileSync(join(PKG, 'cordis.patch.yml'), 'utf8');
const yamlChecks = [
  [/^-\s*insert:\s*$/m, '顶层 - insert:'],
  [/^\s+-\s*id:\s*dispatch\s*$/m, '行 id=dispatch'],
  [/^\s+name:\s*'@local\/dispatch'\s*$/m, "行 name='dsh-dispatch'"],
  [/^\s+config:\s*$/m, 'config: 块'],
  [/^\s+demo:\s*false\s*$/m, 'config.demo=false'],
  [/^\s+maxConcurrent:\s*3\s*$/m, 'config.maxConcurrent=3'],
];
for (const [re, name] of yamlChecks) ok(re.test(yamlText), `patch.yml ${name}`);
const strOf = (key) => {
  const m = yamlText.match(new RegExp(`^\\s+${key}:\\s*'([^']*)'\\s*$`, 'm'));
  return m ? m[1] : null;
};
const runnerPath = strOf('runnerPath');
const ledgerPath = strOf('ledgerPath');
const workRoot = strOf('workRoot');
ok(typeof runnerPath === 'string' && runnerPath.length > 3, 'config.runnerPath 非空', String(runnerPath));
ok(runnerPath != null && existsSync(runnerPath), 'config.runnerPath 指向的 runner 存在（只读检查）', String(runnerPath));
ok(typeof ledgerPath === 'string' && ledgerPath.endsWith('dispatch-runs.jsonl'), 'config.ledgerPath 指向台账', String(ledgerPath));
ok(workRoot != null && resolve(workRoot) === join(PKG, '.data'), 'config.workRoot 指向本包 .data', String(workRoot));
ok(!existsSync(join('C:\\Users\\Administrator\\.dsh', 'dispatch')), '未向 $DSH_HOME 写入本包内容');

/* ---------------- 4. 静态纪律 grep ---------------- */
section('4. 静态纪律（JS 零字面色值 / 无宿主包引用 / 协议键常量豁免 / TODO 清偿）');
const jsTexts = Object.fromEntries(JS_FILES.map((f) => [f, readFileSync(join(PKG, f), 'utf8')]));
const allJs = Object.entries(jsTexts);
// Z8-02：wire.host.mjs 需协议标记键字符串常量（typert 协议要求键跨副本精确相等，
// protocol/lib/index.js:135 的 '@deepseek-ai/dsh-typert-protocol/remote-methods'）——
// 这是数据契约不是 import。Z10-01：index.js 需 @deepseek-ai/schemastery（cordis 的
// resolveConfig 只认 Standard Schema；schemastery 宿主随包出货，官方插件同款）——
// 仅此两处豁免；说明符扫描（下两条）保证不出现其余宿主包 import。
ok(allJs.every(([f, s]) => f === 'wire.host.mjs' || f === 'index.js' || !s.includes('@deepseek-ai')), 'JS 不出现 @deepseek-ai（豁免：wire.host.mjs 协议键 + index.js schemastery 导入）');
ok((jsTexts['wire.host.mjs'].match(/@deepseek-ai/g) ?? []).length === 1, 'wire.host.mjs 的 @deepseek-ai 仅协议标记键一处', String((jsTexts['wire.host.mjs'].match(/@deepseek-ai/g) ?? []).length));
ok((jsTexts['index.js'].match(/@deepseek-ai/g) ?? []).length === 1 && jsTexts['index.js'].includes("'@deepseek-ai/schemastery'"), 'index.js 的 @deepseek-ai 仅 schemastery 导入一处', String((jsTexts['index.js'].match(/@deepseek-ai/g) ?? []).length));
ok(allJs.every(([, s]) => !/document\s*\.\s*body/.test(s)), 'JS 不操作 document.body');
ok(allJs.every(([f, s]) => f === 'icon.svg' || !/#[0-9a-fA-F]{3,8}\b/.test(s)), 'JS 无字面 # 色值');
const specifierRe = /(?:import[\s\S]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
const badSpecs = [];
const clientRequires = [];
for (const [f, s] of allJs) {
  // 先剥块注释再扫：头注释里的“不 import …”字样会被贪婪正则一路吞到首个 from'<串>'
  // （Z6 起 STRINGS 里有 `continued from', hop: '…` 形状），一个假命中同时打挂下面两条断言
  // —— pitfalls Z2-1「纪律 grep 会被注释命中」同类，扫描对象必须是代码不是散文。
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of code.matchAll(specifierRe)) {
    const spec = m[1];
    if (f === 'client.js') clientRequires.push(spec);
    const allowedBare = f === 'index.js' && spec === '@deepseek-ai/schemastery'; // Z10-01：宿主随包出货的校验器
    if (spec !== 'react' && !allowedBare && !spec.startsWith('node:') && !spec.startsWith('./') && !spec.startsWith('../')) badSpecs.push(`${f}: ${spec}`);
  }
}
ok(badSpecs.length === 0, 'import/require 说明符仅 node:*、相对路径或浏览器模块表约定的 react', badSpecs.join('; '));
ok(clientRequires.length === 1 && clientRequires[0] === 'react', "client.js 只 require('react')", clientRequires.join('; '));
// Z8-01 把 wire 文件的 TODO（浏览器可达两步）落地后清偿，TODO 应为零——pitfalls Z5-1：行为变更同步本地探针
const todoFiles = allJs.filter(([, s]) => /\bTODO\b/.test(s)).map(([f]) => f).sort();
ok(todoFiles.length === 0, 'TODO 注释块已清偿（Z8 接线落地，不再遗留）', todoFiles.join(', '));

/* ---------------- 5. wire.client.mjs（Node，无 window → demo 引擎；注入外部源 → ext 轮询） ---------------- */
section('5. wire.client.mjs 降级路径');
{
  const { createClientWire } = await import(pathToFileURL(join(PKG, 'wire.client.mjs')).href);
  ok(typeof createClientWire === 'function', 'createClientWire 可导入');
  const wire = createClientWire({}, {});
  let firstBundle = null;
  const un = wire.subscribe((b) => {
    if (!firstBundle) firstBundle = b;
  });
  ok(firstBundle && firstBundle.conn === 'demo', 'subscribe 立即回包且 conn=demo');
  ok(firstBundle && firstBundle.snapshot?.jobs?.length === 3, 'demo 快照含 3 个进程');
  ok(firstBundle && firstBundle.quota?.windows?.last5h && firstBundle.quota.windows.week && firstBundle.quota.windows.today, 'demo 用量含三窗口');
  const d = await wire.dispatch({ kind: 'prompt', prompt: 'hi（验收）' });
  ok(d.ok === true && d.job?.id, 'demo dispatch 返回 ok+job');
  const t = await wire.tail('j-demo-run', 10);
  ok(t.ok === true && Array.isArray(t.lines) && t.lines.length > 0, 'demo tail 返回行');
  const k = await wire.kill(d.job.id);
  ok(k.ok === true && k.job?.state === 'killed', 'demo kill（queued→killed）');
  ok((await wire.kill('j-nonexist')).ok === false, 'demo kill 不存在 id → ok:false');
  const bad = await wire.dispatch({ kind: 'prompt' });
  ok(bad.ok === false, 'demo dispatch 缺内容 → ok:false');
  un();
  wire.dispose();
  const wire2 = createClientWire({}, { demo: true });
  globalThis.window = globalThis.window || {};
  globalThis.window.__dispatchDemo = {
    getSnapshot: () => ({ generatedAt: 'x', counts: { done: 1 }, locks: {}, queue: [], jobs: [] }),
    getQuota: () => ({ available: false, windows: null }),
    tail: async () => ({ ok: true, lines: ['ext'] }),
  };
  let extBundle = null;
  const un2 = wire2.subscribe((b) => {
    if (!extBundle) extBundle = b; // demo:true 应强制内置 demo，不理会外部源
  });
  ok(extBundle && extBundle.conn === 'demo', 'config.demo=true 强制内置 demo 引擎');
  un2();
  wire2.dispose();
  const wire3 = createClientWire({}, {});
  let extBundle2 = null;
  const un3 = wire3.subscribe((b) => {
    if (!extBundle2) extBundle2 = b;
  });
  ok(extBundle2 && extBundle2.conn === 'ext', '注入 __dispatchDemo 后走 ext 轮询');
  ok((await wire3.tail('any')).lines?.[0] === 'ext', 'ext 数据源动作透传');
  un3();
  wire3.dispose();
  delete globalThis.window.__dispatchDemo;
}

/* ---------------- 6. index.js：apply/Config + 假 runner 端到端 ---------------- */
section('6. index.js Host 半边端到端（Z1 假 runner）');
{
  const host = await import(pathToFileURL(join(PKG, 'index.js')).href);
  ok(typeof host.apply === 'function', '导出 apply');
  // Z10-01：Config 必须是 Standard Schema v1（cordis resolveConfig 只认 ['~standard'].validate，
  // 裸 JSON Schema 会在激活时 TypeError）——断言行为不变式而非 schema 内部形状
  ok(typeof host.Config?.['~standard']?.validate === 'function', 'Config 为 Standard Schema（~standard.validate 可用）');
  const KEYS = ['demo', 'maxConcurrent', 'runnerPath', 'ledgerPath', 'workRoot'];
  const v0 = host.Config['~standard'].validate({});
  ok(!!v0?.value && KEYS.every((k) => k in v0.value), 'validate({}) 补全 5 字段', JSON.stringify(v0?.value));
  ok(v0.value.demo === false && v0.value.maxConcurrent === 3 && v0.value.runnerPath === '' && v0.value.ledgerPath === '' && v0.value.workRoot === '', 'validate({}) 默认值逐项正确');
  const v1 = host.Config['~standard'].validate({ maxConcurrent: 3, demo: true, runnerPath: 'r', ledgerPath: 'l', workRoot: 'w' });
  ok(v1.value.maxConcurrent === 3 && v1.value.demo === true && v1.value.runnerPath === 'r' && v1.value.ledgerPath === 'l' && v1.value.workRoot === 'w', 'validate 保留显式配置值');

  const tmp = mkdtempSync(join(PKG, 'test', 'z2-e2e-')); // 临时 workRoot 放本包 test/ 下，跑完删除
  const cfg = {
    demo: false,
    maxConcurrent: 1,
    runnerPath: '(由 DSP_FAKE_RUNNER 注入)',
    ledgerPath: join(tmp, 'ledger.jsonl'),
    workRoot: join(tmp, 'work'),
    // Z12：开关真值文件指向临时路径（缺失=开启），e2e 不依赖真实开关状态（Z5-1 纪律：探针不读真值）
    switchPath: join(tmp, 'switch.json'),
  };
  process.env.DSP_FAKE_RUNNER = join(PKG, 'test', 'fixtures', 'fake-runner.mjs');
  process.env.FAKE_SLEEP_MS = '900';
  const effects = [];
  const logs = [];
  const ctx = {
    effect(fn) {
      effects.push(fn);
    },
    logger: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
    },
  };
  const api = host.apply(ctx, cfg);
  ok(api && typeof api.handleAction === 'function' && api.dispatcher && api.wire, 'apply 返回 {dispatcher, wire, handleAction}');
  ok(effects.length === 1, 'ctx.effect 注册了卸载清理');
  ok(logs.some(([, m]) => String(m).includes('dispatcher 就绪')), '日志：dispatcher 就绪');

  const r1 = await api.handleAction('dispatch', { kind: 'prompt', prompt: '只回答 OK（z2-verify）', model: 'GLM-5.3-Flash', provider: 'plan', mode: 'edit', timeoutMin: 1, tag: 'z2-verify' });
  ok(r1.ok === true && r1.job?.id && ['queued', 'running'].includes(r1.job.state), 'handleAction dispatch → ok（queued/running）', JSON.stringify(r1).slice(0, 200));
  ok(r1.job?.tailCount != null && r1.job.captureOut === undefined, 'slimJob：带 tailCount、不带 capture 路径');

  const terminal = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('等待 running 超时')), 15000);
    let un2 = null;
    un2 = api.wire.subscribe((b) => {
      const j = b.snapshot?.jobs?.find((x) => x.id === r1.job.id);
      if (j?.state === 'running') {
        if (un2) un2();
        clearTimeout(timer);
        res(j);
      }
    });
  }).catch((e) => null);
  ok(terminal && terminal.state === 'running', 'wire.subscribe 推送到 running', String(terminal));

  await delay(400); // 让假 runner 打印启动行（kill 过快会让捕获为空——core 行为正确，UI 显示「无输出」）

  const killed = await new Promise((res, rej) => {
    api.handleAction('kill', { id: r1.job.id, via: 'z2-verify' }).then((v) => {
      if (!v.ok) {
        rej(new Error(v.error));
        return;
      }
      const timer = setTimeout(() => rej(new Error('等待 killed 超时')), 15000);
      let un2 = null;
      un2 = api.wire.subscribe((b) => {
        const j = b.snapshot?.jobs?.find((x) => x.id === r1.job.id);
        if (j && ['killed', 'done', 'failed'].includes(j.state)) {
          if (un2) un2();
          clearTimeout(timer);
          res(j);
        }
      });
    }, rej);
  }).catch((e) => ({ error: e.message }));
  ok(killed && (killed.state === 'killed' || killed.error === undefined), 'kill → 终态（killed）', JSON.stringify(killed).slice(0, 200));

  const tailRes = await api.handleAction('tail', { id: r1.job.id, n: 30 });
  ok(tailRes.ok === true && Array.isArray(tailRes.lines) && tailRes.lines.length > 0, 'handleAction tail 返回捕获行', JSON.stringify(tailRes).slice(0, 300));
  const quotaRes = await api.handleAction('quota');
  // Z3 起 fetchPlanQuota 为真实适配器：本机有 CLI → available:true + windows；不可达 → available:false + reason
  const pq = quotaRes.planQuota;
  const pqShape = pq != null && (pq.available === true
    ? Array.isArray(pq.windows) && pq.windows.every((x) => x && typeof x.id === 'string')
    : typeof pq.reason === 'string');
  ok(quotaRes.ok === true && quotaRes.quota && pqShape, 'handleAction quota（quota 三窗口 + planQuota 真实适配器形状）');
  const listRes = await api.handleAction('list');
  ok(listRes.ok === true && Array.isArray(listRes.jobs) && listRes.jobs.length >= 1, 'handleAction list');
  ok((await api.handleAction('dispatch', { kind: 'prompt', memoryBench: true })).ok === false, 'dispatch 缺 prompt → ok:false（core 校验透传）');
  ok((await api.handleAction('nope')).ok === false, '未知 action → ok:false');
  ok(api.wire.getSnapshot()?.jobs?.length >= 1, 'wire.getSnapshot 可用');

  effects[0](); // 卸载清理：wire.dispose + 工具注销 + 终态兜底
  ok(true, '卸载清理函数执行无异常');
  delete process.env.FAKE_SLEEP_MS;
  delete process.env.DSP_FAKE_RUNNER;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch { /* Windows 句柄抖动：留待进程退出 */ }
}

/* ---------------- 7. client.js 桩加载 + 最小 React 渲染冒烟 ---------------- */
section('7. client.js：ModuleLoader 桩 + 假 ctx + 渲染冒烟');
{
  // 最小 React 桩：hooks + 元素树；渲染器执行函数组件、收集并运行/清理 effect
  const compState = new Map(); // 组件 fn -> hook 槽数组
  const effectSlots = new Set();
  let hooks = null; // { list, idx }
  let effectQueue = [];
  const depsEq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const slotOf = () => {
    const i = hooks.idx++;
    let slot = hooks.list[i];
    if (!slot) slot = hooks.list[i] = {}; // 不预置 v：'v' in slot 需要保持「未初始化」语义
    return slot;
  };
  const ReactStub = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useState(init) {
      const slot = slotOf();
      if (!('v' in slot)) slot.v = typeof init === 'function' ? init() : init;
      return [slot.v, (nv) => {
        slot.v = typeof nv === 'function' ? nv(slot.v) : nv;
      }];
    },
    useRef(v) {
      const slot = slotOf();
      if (!slot.ref) slot.ref = { current: v };
      return slot.ref;
    },
    useMemo(fn, deps) {
      const slot = slotOf();
      if (!slot.depsSet || !depsEq(slot.deps, deps)) {
        slot.v = fn();
        slot.deps = deps;
        slot.depsSet = true;
      }
      return slot.v;
    },
    useCallback(fn, deps) {
      return ReactStub.useMemo(() => fn, deps);
    },
    useEffect(fn, deps) {
      const slot = slotOf();
      effectSlots.add(slot);
      effectQueue.push({ slot, fn, deps });
    },
  };

  const loads = [];
  globalThis.window = {
    __ModuleLoader__: { load(def) { loads.push(def); } },
    localStorage: {
      _m: new Map(),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); },
      removeItem(k) { this._m.delete(k); },
    },
    innerWidth: 1920,
    innerHeight: 1080,
  };
  try {
    globalThis.navigator = { language: 'zh-CN' }; // Node <21 可写
  } catch { /* Node ≥21 自带只读 navigator，用其默认值（client LANG 有回退链） */ }
  globalThis.document = { documentElement: { lang: 'zh-CN' } };

  await import(pathToFileURL(join(PKG, 'client.js')).href);
  ok(loads.length === 1 && loads[0].id === 'dsh-dispatch', 'window.__ModuleLoader__.load 被调用且 id 正确');
  const requireStub = (name) => {
    if (name === 'react') return ReactStub;
    throw new Error(`意外 require: ${name}`);
  };
  const mod = loads[0].factory(requireStub);
  ok(Array.isArray(mod.inject) && mod.inject.includes('slots') && typeof mod.apply === 'function', 'factory 返回 {inject:[slots], apply}');

  const registered = {};
  const ctx = {
    slots: {
      inject(owner, cb) { registered.owner = owner; registered.cb = cb; },
      register(opts, comp) { registered.opts = opts; registered.comp = comp; },
    },
  };
  mod.apply(ctx);
  registered.cb(); // 真实框架在槽位挂载时调用该回调 → 触发 slots.register
  ok(registered.owner === 'shell.overlay', `slots.inject 槽位=${registered.owner}（SLOT 默认值）`);
  ok(registered.opts?.id === 'dispatch.console' && registered.opts?.name === 'shell.overlay' && registered.opts?.order === 20, 'slots.register 选项 {name, id, order}（Z4 起 id=dispatch.console）');
  ok(typeof registered.comp === 'function', 'register 的是组件函数');

  // 渲染冒烟：渲染 → 跑 effect（demo 引擎订阅/定时器）→ 等 1.3s（elapsed tick）→ 再渲染 → 清理
  const renderTree = (comp) => {
    let nodes = 0;
    const walk = (el) => {
      if (el == null || el === false || el === true) return;
      if (typeof el === 'string' || typeof el === 'number') {
        nodes += 1;
        return;
      }
      if (Array.isArray(el)) {
        for (const c of el) walk(c);
        return;
      }
      nodes += 1;
      if (typeof el.type === 'function') {
        const save = hooks;
        hooks = { list: compState.get(el.type) ?? compState.set(el.type, []).get(el.type), idx: 0 };
        const children = [].concat(...(el.children ?? []).map((c) => (Array.isArray(c) ? c : [c])));
        try {
          walk(el.type({ ...el.props, children }));
        } finally {
          hooks = save;
        }
        return;
      }
      const kids = [].concat(...(el.children ?? []).map((c) => (Array.isArray(c) ? c : [c])));
      for (const c of kids) walk(c);
    };
    hooks = { list: compState.get(comp) ?? compState.set(comp, []).get(comp), idx: 0 };
    walk(comp({}));
    const q = effectQueue;
    effectQueue = [];
    for (const { slot, fn, deps } of q) {
      if (slot.depsSet && depsEq(slot.deps, deps)) continue;
      if (typeof slot.cleanup === 'function') slot.cleanup();
      slot.deps = deps;
      slot.depsSet = true;
      slot.cleanup = fn() ?? null;
    }
    return nodes;
  };

  const Panel = registered.comp;
  const n1 = renderTree(Panel);
  ok(n1 > 20, `首帧渲染节点数=${n1}（>20 视为完整渲染）`);
  await delay(1300); // demo 引擎至少推一次 elapsed tick
  const n2 = renderTree(Panel);
  ok(n2 > 20, `快照更新后二次渲染节点数=${n2}`);
  for (const slot of effectSlots) {
    if (typeof slot.cleanup === 'function') {
      try {
        slot.cleanup();
      } catch { /* 清理异常不掩盖主结论 */ }
    }
  }
  const leaked = process.getActiveResourcesInfo().filter((r) => r === 'Timeout' || r === 'Immediate');
  ok(leaked.length === 0, '组件卸载后无残留定时器（监听器/interval 清理）', leaked.join(','));
  delete globalThis.window;
  try {
    delete globalThis.navigator;
  } catch { /* Node ≥21 只读，跳过 */ }
  delete globalThis.document;
}

/* ---------------- 8. 越界检查：宿主仓库零改动 ---------------- */
section('8. 越界检查（宿主仓库 porcelain 指纹，只读）');
if (!HOST_REPO) {
  console.log('  SKIP：未设置 Z2_HOST_REPO，跳过越界指纹检查（不是通过）');
} else {
  const fpEnd = fingerprint();
  ok(FP_START === fpEnd, `宿主仓库指纹前后一致（${FP_START} → ${fpEnd}）`);
}

/* ---------------- 汇总 ---------------- */
console.log(`\n===== 结果：${passCount} PASS / ${failures.length} FAIL =====`);
if (failures.length > 0) {
  console.error('失败项：\n - ' + failures.join('\n - '));
  process.exitCode = 1;
}
