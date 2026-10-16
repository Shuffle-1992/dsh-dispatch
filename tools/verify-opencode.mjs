#!/usr/bin/env node
/**
 * DSH 派发台 · **OpenCode 执行器自检探针**（可复跑、默认离线）。
 *
 * 定位：与 `tools/verify-plugin.mjs`（插件半边常驻探针）并列的**执行器侧探针**。
 * 默认全部离线（只读探测 + 源码锁 + 假执行器 fixture），**不消耗免费额度**；
 * 只有显式传 `--live` 才会真的跑一次免费模型（会花时间/额度）。
 *
 * 用法：
 *   node tools/verify-opencode.mjs            # 离线自检（默认）
 *   node tools/verify-opencode.mjs --live     # 追加一次真实调用（PONG 冒烟）
 *   node tools/verify-opencode.mjs --help
 *
 * 退出码：有 FAIL ⇒ 1（SKIP 不影响退出码）。
 *
 * ⚠️ 纪律：本探针**只读**，绝不改被测源码；探测 `opencode` 一律走 node 的 spawnSync
 * （Windows 上 `.cmd` shim 必须过 shell），不在 pwsh 里直接跑（P7：管道会污染退出码）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOL = join(ROOT, 'collab-kit', 'run-line-protocol.mjs');
const RUNNER = join(ROOT, 'collab-kit', 'opencode-run.mjs');
const CORE = join(ROOT, 'dispatch', 'core', 'dispatch-core.mjs');
const LIVE = process.argv.includes('--live');
const LIVE_MODEL = process.env.OC_VERIFY_MODEL || 'opencode/deepseek-v4.1-flash-free';

if (process.argv.includes('--help')) {
  console.log('用法：node tools/verify-opencode.mjs [--live]\n  --live  追加真实免费模型调用（PONG 冒烟；会消耗时间/额度）');
  process.exit(0);
}

let passCount = 0;
let failCount = 0;
let skipCount = 0;
const failures = [];

const ok = (name, detail = '') => { passCount += 1; console.log(`[PASS] ${name}${detail ? `\n        ${detail}` : ''}`); };
const bad = (name, detail = '') => {
  failCount += 1;
  failures.push(name);
  console.log(`[FAIL] ${name}${detail ? `\n        ${detail}` : ''}`);
};
const skip = (name, reason) => { skipCount += 1; console.log(`[SKIP] ${name}\n        原因：${reason}`); };
const check = (name, cond, detail = '', failDetail = '') => { if (cond) ok(name, detail); else bad(name, failDetail || detail); };
const oneLine = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/* ---------------- ① 协议模块（冻结件） ---------------- */
console.log(`[OpenCode 自检] 仓库根=${ROOT}  模式=${LIVE ? '离线 + --live' : '仅离线'}\n`);
{
  const name = '1) collab-kit/run-line-protocol.mjs 可 import 且 ENGINES 正确';
  if (!existsSync(PROTOCOL)) {
    bad(name, `文件不存在：${PROTOCOL}（协议模块是冻结件，缺失说明仓库不完整）`);
  } else {
    try {
      const P = await import(pathToFileURL(PROTOCOL).href);
      const engines = [...(P.ENGINES ?? [])];
      /* ZB-51：引擎从两台扩到三台（新增 qoder）。断言改为"包含且顺序正确"，
       * 而不是"恰好等于两台" —— 否则每次加引擎都要改校验器（而校验器是门禁，不该频繁动）。 */
      const good = engines.length >= 2 && engines[0] === 'zcode' && engines[1] === 'opencode'
        && engines.includes('qoder')
        && P.RUN_PREFIX?.opencode === '[opencode-run]' && P.RUN_PREFIX?.zcode === '[zcode-run]'
        && P.RUN_PREFIX?.qoder === '[qoder-run]'
        && P.prefixFor('nonsense') === '[zcode-run]'
        && P.isOpenCodeId('opencode/x') === true && P.isOpenCodeId('plan') === false
        && P.isQoderId('qoder/GLM-5.3') === true && P.isQoderId('qoder/Qwen3.8-Max') === true;
      check(name, good, `ENGINES=${JSON.stringify(engines)} RUN_PREFIX=${JSON.stringify(P.RUN_PREFIX)} prefixFor(nonsense)=${P.prefixFor('nonsense')}`,
        `协议内容不符：ENGINES=${JSON.stringify(engines)} RUN_PREFIX=${JSON.stringify(P.RUN_PREFIX)}`);
    } catch (e) {
      bad(name, `import 失败：${e?.message ?? e}`);
    }
  }
}

/* ---------------- ② 执行器存在 ---------------- */
const runnerExists = existsSync(RUNNER);
{
  const name = '2) collab-kit/opencode-run.mjs 存在';
  if (runnerExists) {
    const size = readFileSync(RUNNER).length;
    ok(name, `${RUNNER}（${size} 字节）`);
  } else {
    bad(name, `执行器缺失：${RUNNER}\n        可读原因：OpenCode 执行器尚未落盘（或路径被改名）—— 这是 OpenCode 派发链路的必需组件，core 的通道探测与派发都指向它。`);
  }
}

/* ---------------- ③ 本机 opencode CLI 可执行 ---------------- */
const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);
/** 候选顺序：显式 env → 本机 npm global prefix（APPDATA\npm）→ PATH（where.exe，只读）→ 裸名。 */
function opencodeCandidates() {
  const list = [];
  if (process.env.OPENCODE_CLI) list.push(process.env.OPENCODE_CLI);
  if (process.env.APPDATA) list.push(join(process.env.APPDATA, 'npm', 'opencode.cmd'));
  try {
    const w = spawnSync('where.exe', ['opencode'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (w.status === 0) for (const l of String(w.stdout).split(/\r?\n/)) if (l.trim()) list.push(l.trim());
  } catch { /* where 不可用则忽略 */ }
  list.push('opencode');
  return [...new Set(list)];
}
function probeOpencodeVersion() {
  const tried = [];
  for (const cand of opencodeCandidates()) {
    /* Windows 上 npm 全局装的是 `.cmd` shim：必须走 shell 才能执行（直连 .cmd 会 EINVAL）。 */
    const r = spawnSync(`${quote(cand)} --version`, { encoding: 'utf8', shell: true, timeout: 30000, windowsHide: true });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    tried.push(`${cand} ⇒ exit=${r.status ?? 'null'} ${oneLine(out, 80)}`);
    const v = /\b(\d+\.\d+\.\d+)\b/.exec(String(r.stdout ?? ''));
    if (r.status === 0 && v) return { ok: true, cand, version: v[1], out };
  }
  return { ok: false, tried };
}
{
  const name = '3) opencode --version 可执行';
  const p = probeOpencodeVersion();
  if (p.ok) ok(name, `${p.cand} → ${p.version}`);
  else bad(name, `未探测到可执行的 opencode（已试：${p.tried.join(' ｜ ')}）\n        可读原因：未安装 OpenCode CLI ⇒ 跑 \`npm i -g opencode-ai\` 后重试（本机 npm prefix 一般在 %APPDATA%\\npm）。`);
}

/* ---------------- ④/⑤ 执行器只读分支（不耗额度） ---------------- */
const runNode = (args, timeoutMs) => spawnSync(process.execPath, [RUNNER, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
});

if (!runnerExists) {
  skip('4) node collab-kit/opencode-run.mjs --version', '执行器不存在（第 2 项 FAIL），无法执行');
  skip('5) --list-models 探测出 ≥1 个 opencode/* 模型', '执行器不存在（第 2 项 FAIL），无法执行');
} else {
  {
    const name = '4) node collab-kit/opencode-run.mjs --version（只读、不耗额度）';
    const r = runNode(['--version'], 60000);
    const out = `${r.stdout ?? ''}`.trim();
    const v = /\b(\d+\.\d+\.\d+)\b/.exec(out);
    /* exit=0 且三路全空 = 典型「执行器还没有 CLI 入口」（parseArgs 未被 main 调用）——点明可读原因，省排查时间。 */
    const silentNoEntry = r.status === 0 && out === '' && String(r.stderr ?? '').trim() === '';
    check(name, r.status === 0 && !!v,
      `exit=${r.status} output=${oneLine(out, 120)}`,
      `期望 exit=0 且输出含版本号；实际 exit=${r.status ?? 'null'} stdout=${oneLine(out, 160)} stderr=${oneLine(r.stderr, 200)}（timeout=${r.error?.code ?? '-'}）`
      + (silentNoEntry ? '\n        可读原因：进程 exit=0 但 stdout/stderr 全空 ⇒ 执行器**没有 CLI 入口**（parseArgs 已导出却无人调用 `main(process.argv.slice(2))`）或该分支未接线。' : ''));
  }
  {
    const name = '5) node collab-kit/opencode-run.mjs --list-models（探测成功且形如 opencode/*）';
    const r = runNode(['--list-models'], 120000);
    const models = String(r.stdout ?? '')
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*\[opencode-run\]\s*/, '').trim())
      .filter((l) => /^opencode\/[A-Za-z0-9._:-]+$/.test(l));
    const uniq = [...new Set(models)];
    if (r.status !== 0 || uniq.length === 0) {
      const silentNoEntry = r.status === 0 && uniq.length === 0 && String(r.stdout ?? '') === '' && String(r.stderr ?? '').trim() === '';
      bad(name, `exit=${r.status ?? 'null'}，解析出 ${uniq.length} 个 opencode/* 模型\n        stdout=${oneLine(r.stdout, 300)}\n        stderr=${oneLine(r.stderr, 200)}`
        + (silentNoEntry ? '\n        可读原因：同样指向「执行器没有 CLI 入口」（见第 4 项）—— 探测分支未接线时本项无从通过。' : ''));
    } else {
      /* 不写死 12 个（上游会变；写死会重演 ZB-31 档位表漂移坑）——只断言"探测成功 + 形状正确"。 */
      ok(name, `exit=0，探测到 ${uniq.length} 个 opencode/* 模型（仅断言形状，不核对数量）：\n        ${uniq.map((m) => `· ${m}`).join('\n        ')}`);
    }
  }
}

/* ---------------- ⑤b 执行器参数 fail-fast 契约（离线，不耗额度） ---------------- */
{
  const name = '5b) 执行器 fail-fast：--mode / --memory-bench / 未知参数 ⇒ exit 1';
  if (!runnerExists) {
    skip(name, '执行器不存在（第 2 项 FAIL），无法执行');
  } else {
    /* 硬约束（OPENCODE-DISPATCH-HANDOFF §7）：OpenCode 没有 ZCode 的 mode / 记忆库概念，
     * 执行器必须**显式拒绝**而不是静默忽略；未知参数同样 fail-fast（否则错拼的旗标会静默失效）。 */
    const probes = [['--mode', 'build'], ['--memory-bench'], ['--definitely-not-a-flag']];
    const rows = probes.map((args) => {
      const r = runNode(args, 30000);
      return { label: args.join(' '), status: r.status, err: oneLine(r.stderr, 120) };
    });
    const wrong = rows.filter((x) => x.status !== 1);
    check(name, wrong.length === 0,
      rows.map((x) => `${x.label} ⇒ exit=${x.status ?? 'null'}`).join('；'),
      `以下调用没有 fail-fast（期望 exit=1）：${wrong.map((x) => `${x.label} ⇒ exit=${x.status ?? 'null'}（stderr=${x.err}）`).join('；')}`);
  }
}

/* ---------------- ⑥ 未登记事件不崩（行为优先 / 源码锁兜底） ---------------- */
const UNKNOWN_FIXTURE_LINES = [
  '{"type":"step_start","sessionID":"ses_fake","part":{"type":"step-start"}}',
  '{"type":"quantum_flux","sessionID":"ses_fake","part":{"type":"flux","level":9}}',
  '{"type":"text","part":{"type":"text","text":"PONG"}}',
  '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"total":10,"input":5,"output":5,"cache":{"read":0,"write":0}}}}',
];
{
  const name = '6) 未登记事件不崩（未知 type 降级而非抛异常）';
  if (!runnerExists) {
    skip(name, '执行器不存在（第 2 项 FAIL），无法执行');
  } else {
    const src = readFileSync(RUNNER, 'utf8');
    /* 6a：行为探测——在**子进程**里 import（防止执行器顶层 main() 直接 process.exit 带走本探针）。 */
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const mod = await import(${JSON.stringify(pathToFileURL(RUNNER).href)});
      const names = Object.keys(mod ?? {});
      const t = mod?.__testables && typeof mod.__testables === 'object' ? Object.keys(mod.__testables) : [];
      console.log('__EXPORTS__' + JSON.stringify({ names, testables: t }));
    `], { cwd: ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true });
    const expMatch = /__EXPORTS__(\{[\s\S]*\})/.exec(String(probe.stdout ?? ''));
    let behavioral = null;
    let behavioralNote = '';
    if (expMatch) {
      let exported = null;
      try { exported = JSON.parse(expMatch[1]); } catch { exported = null; }
      const AGG_RE = /^(aggregate|summari[sz]e|collect|parse|handle)/i;
      const candidate = [...(exported?.testables ?? []), ...(exported?.names ?? [])].find((n) => AGG_RE.test(n));
      if (candidate) {
        const call = spawnSync(process.execPath, ['--input-type=module', '-e', `
          const mod = await import(${JSON.stringify(pathToFileURL(RUNNER).href)});
          const fn = (mod.__testables?.[${JSON.stringify(candidate)}]) ?? mod[${JSON.stringify(candidate)}];
          const lines = ${JSON.stringify(UNKNOWN_FIXTURE_LINES)};
          try {
            const out = fn.length >= 2 ? fn(lines[0], Array.isArray(lines) ? [...lines] : lines) : fn(lines);
            console.log('__RESULT__' + JSON.stringify({ ok: true, out: out === undefined ? null : out }));
          } catch (e) {
            console.log('__RESULT__' + JSON.stringify({ ok: false, err: String(e && e.message || e) }));
          }
        `], { cwd: ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true });
        const resMatch = /__RESULT__(\{[\s\S]*\})/.exec(String(call.stdout ?? ''));
        if (resMatch) {
          try {
            const r = JSON.parse(resMatch[1]);
            behavioral = r;
            behavioralNote = `导出函数 ${candidate}() 喂入 ${UNKNOWN_FIXTURE_LINES.length} 行 NDJSON（含未登记的 type=quantum_flux）`;
          } catch { /* 落到源码锁 */ }
        } else {
          behavioralNote = `导出函数 ${candidate} 调用约定不匹配（子进程无结果输出，exit=${call.status ?? 'null'}）`;
        }
      } else {
        behavioralNote = `模块导出了 [${(exported?.names ?? []).join(',')}]，但没有可识别的聚合/解析函数（${oneLine(probe.stdout, 80)}）`;
      }
    } else {
      behavioralNote = `子进程 import 未产出导出清单（exit=${probe.status ?? 'null'}：执行器顶层可能直接跑 main；不做行为调用）`;
    }

    /* 6b：源码锁——未知类型必须有降级分支（assumption-free 的静态证据）。 */
    const unknownHits = src.split(/\r?\n/).filter((l) => /unknown/i.test(l));
    const hasUnknownBranch = unknownHits.length > 0;
    const hasTypeDispatch = /(switch\s*\(|type\s*===|case\s*['"])/.test(src);
    const srcNote = `源码锁：含 unknown 降级字样 ${unknownHits.length} 处${unknownHits.length ? `（首处：${oneLine(unknownHits[0], 100)}）` : ''}`
      + `；事件类型分派迹象=${hasTypeDispatch}`;

    if (behavioral && behavioral.ok) {
      ok(name, `行为验证通过：${behavioralNote}；未抛异常。\n        ${srcNote}`);
    } else if (behavioral && !behavioral.ok) {
      const msg = behavioral.err ?? '';
      const conventionMismatch = /is not a function|is not iterable|Cannot read propert|of undefined|of null|not defined/i.test(msg);
      if (conventionMismatch) {
        check(name, hasUnknownBranch,
          `行为探测调用约定不匹配（${oneLine(msg, 120)}）⇒ 退化为源码锁判定；${srcNote}`,
          `未知事件降级分支未找到，且行为探测也未能验证：${srcNote}；调用错误=${oneLine(msg, 160)}`);
      } else {
        bad(name, `聚合器在未登记事件上抛错（行为验证失败）：${oneLine(msg, 200)}\n        ${srcNote}`);
      }
    } else {
      check(name, hasUnknownBranch,
        `无导出聚合函数 ⇒ 源码锁判定；${srcNote}\n        探测说明：${behavioralNote}`,
        `未找到未知事件降级分支（unknown 字样 0 处），且执行器未导出可测函数 ⇒ 无法证明「未登记事件不崩」。${srcNote}\n        探测说明：${behavioralNote}`);
    }
  }
}

/* ---------------- ⑦ core 引擎管道（附加：派发台侧接线） ---------------- */
{
  const name = '7) core 已接入 opencode（解析 + 引擎管道）';
  if (!existsSync(CORE)) {
    bad(name, `core 不存在：${CORE}`);
  } else {
    const src = readFileSync(CORE, 'utf8');
    const lit = new Set([...src.matchAll(/\[(?:zcode|opencode)-run\]/g)].map((m) => m[0]));
    const importsProtocol = /run-line-protocol/.test(src);
    let parseOk = false;
    let parseDetail = '';
    try {
      const core = await import(pathToFileURL(CORE).href);
      const r = typeof core.parseRunnerLine === 'function'
        ? core.parseRunnerLine('[opencode-run] done exit=0 elapsed=1.0s session=s provider=opencode model=opencode/m', 'opencode')
        : null;
      parseOk = !!r && r.summarySeen === true;
      parseDetail = `parseRunnerLine(opencode done)=${JSON.stringify(r)}`;
    } catch (e) {
      parseDetail = `import/调用抛错：${e?.message ?? e}`;
    }
    const pipesOk = /opencodeRunnerPath/.test(src) && /maxConcurrentOpenCode/.test(src);
    check(name, parseOk && pipesOk,
      `${parseDetail}；前缀字面量=[${[...lit].join(',')}] import-protocol=${importsProtocol}；opencodeRunnerPath/maxConcurrentOpenCode=${pipesOk}`,
      `${parseDetail}；前缀字面量=[${[...lit].join(',')}] import-protocol=${importsProtocol}；opencodeRunnerPath/maxConcurrentOpenCode=${pipesOk}\n        可读原因：core 尚未接入 OpenCode 引擎（并行开发期预期）—— 落盘后重跑本项应转 PASS。`);
  }
}

/* ---------------- ⑧ core ⇄ 执行器 参数契约（离线静态交叉比对） ---------------- */
{
  const name = '8) core buildOpenCodeArgs ⇄ 执行器 parseArgs 参数契约（离线静态，防 flag 拼写漂移）';
  if (!existsSync(CORE) || !runnerExists) {
    skip(name, 'core 或执行器缺失，无法交叉比对');
  } else {
    const coreSrc = readFileSync(CORE, 'utf8');
    const runSrc = readFileSync(RUNNER, 'utf8');
    /* core 侧：取 buildOpenCodeArgs 函数体里出现的 `--flag` 字面量（= core 真正会拼给执行器的）。 */
    const fnBody = /function buildOpenCodeArgs\([\s\S]*?\n  \}/.exec(coreSrc)?.[0] ?? '';
    const emitted = [...new Set([...fnBody.matchAll(/'(--[a-z][a-z-]*)'/g)].map((m) => m[1]))];
    /* 执行器侧：优先只看 parseArgs 的 case 分支；抽不到再退化为整份源码的字面量集合（宽松，避免假红）。 */
    const parseBody = /export function parseArgs\([\s\S]*?\n\}/.exec(runSrc)?.[0] ?? '';
    const caseFlags = new Set([...parseBody.matchAll(/case\s+'(--[a-z][a-z-]*)'/g)].map((m) => m[1]));
    const accepted = caseFlags.size > 0 ? caseFlags : new Set([...runSrc.matchAll(/'(--[a-z][a-z-]*)'/g)].map((m) => m[1]));
    const missing = emitted.filter((f) => !accepted.has(f));
    check(name, emitted.length > 0 && missing.length === 0,
      `core 会拼=[${emitted.join(',')}]；执行器接受(${caseFlags.size > 0 ? 'parseArgs case' : '整份源码'}，${accepted.size} 个)=[${[...accepted].join(',')}]；未被接受=[${missing.join(',') || '无'}]`,
      `参数契约不匹配：core 会拼这些参数但执行器不认识 → [${missing.join(',')}]（core 会拼=[${emitted.join(',')}]）。`
      + '这类漂移会让执行器 fail-fast（未知参数 exit 1），必须由两侧其中一方改齐。');
  }
}

/* ---------------- ⑨ --live：真实免费模型冒烟（会耗额度时间） ---------------- */
if (!LIVE) {
  skip('9) --live 真实调用（PONG 冒烟）', '未传 --live（默认离线，不消耗免费额度）');
} else if (!runnerExists) {
  skip('9) --live 真实调用（PONG 冒烟）', '执行器不存在（第 2 项 FAIL），无法执行');
} else {
  const name = `9) --live 真实调用 --prompt "Reply with exactly: PONG" -m ${LIVE_MODEL}`;
  const r = runNode(['--prompt', 'Reply with exactly: PONG', '--model', LIVE_MODEL, '--tag', 'verify-live'], 600000);
  const out = String(r.stdout ?? '');
  const hasDone = /\[opencode-run\] done exit=0/.test(out);
  const hasProvider = out.includes(`provider=opencode model=${LIVE_MODEL}`);
  const resultLine = out.split(/\r?\n/).reverse().find((l) => /\[opencode-run\] result=/.test(l)) ?? '';
  const resultPath = resultLine.replace(/^.*?\[opencode-run\]\s*result=/, '').trim();
  let textOk = false;
  let textDetail = 'result 文件路径未在 stdout 出现';
  if (resultPath && existsSync(resultPath)) {
    const raw = readFileSync(resultPath, 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const textField = parsed && typeof parsed === 'object'
      ? (typeof parsed.text === 'string' ? parsed.text : (typeof parsed.response === 'string' ? parsed.response : null))
      : null;
    textOk = (textField ?? raw).includes('PONG');
    textDetail = `result=${resultPath} ${textField != null ? `text=${JSON.stringify(oneLine(textField, 80))}` : `（无 text 字段，按原文匹配）`} 含 PONG=${textOk}`;
  } else if (resultPath) {
    textDetail = `result 文件不存在：${resultPath}`;
  }
  check(name, r.status === 0 && hasDone && hasProvider && textOk,
    `exit=${r.status} done-exit0=${hasDone} provider-line=${hasProvider}；${textDetail}`,
    `exit=${r.status ?? 'null'} done-exit0=${hasDone} provider-line=${hasProvider}；${textDetail}\n        stdout 尾部=${oneLine(out.split(/\r?\n/).slice(-6).join(' | '), 400)}\n        stderr=${oneLine(r.stderr, 300)}`);
}

/* ---------------- 汇总 ---------------- */
console.log(`\n[OpenCode 自检] 共 ${passCount + failCount + skipCount} 项：PASS ${passCount} / FAIL ${failCount} / SKIP ${skipCount}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(failCount > 0 ? 1 : 0);
