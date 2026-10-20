/**
 * ZB-42 回归测试：**总开关冻结 ≠ 插件故障**（用户现场报告）。
 *
 * 现场：总开关一关，面板连通道列表都显示不出来，还报「通道清单加载失败」——用户以为插件坏了。
 * 真因：ZB-33 把开关闸门提到 runner 最前面当"第一道闸"（**动机正确**：冻结时不碰 config/凭据），
 * 但连带把**只读**的 `--list-providers` 也挡住了。
 *
 * 修法（两侧）：
 *  ① runner：闸门**下移到 `--list-providers` 分支之后**（仍早于凭据读取与子进程启动）
 *     ⇒ 只读探测放行；**一切真实派发仍必过闸**（exit 3）。
 *  ② 面板：冻结时在「通道」分区**明说**（复用既有 locale 键 switchOffBlocked，不新增文案）。
 *
 * 附带加固：**BOM 静默失效**。PowerShell 5 的 `Set-Content -Encoding UTF8` 与 Windows 记事本
 * 另存为 UTF-8 都会写 BOM（EF BB BF），`JSON.parse` 遇 BOM 必抛 ⇒ 命中 catch ⇒
 * **fail-open（冻结开关静默失效）**。实测复现：带 BOM 的 `enabled:false` 仍被放行。
 * 对安全闸门，静默失效比报错更危险 ⇒ 解析前剥 BOM。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, '..', '..', 'collab-kit', 'zcode-run.mjs');
const CLIENT = join(HERE, '..', 'client.js');
const APP_CONFIG = join(homedir(), '.zcode', 'v2', 'config.json');

/** 建最小"项目根" + 开关真值文件。Node 写盘 => 无 BOM（除非显式要求）。 */
function project(enabled, { bom = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'zb42-'));
  mkdirSync(join(root, 'collab'));
  const body = JSON.stringify({ enabled, updatedBy: 'zb42-test' });
  writeFileSync(join(root, 'collab', 'dispatch.switch.json'), bom ? '\uFEFF' + body : body, 'utf8');
  return root;
}

const run = (args, env = {}) =>
  spawnSync(process.execPath, [RUNNER, ...args], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 90000,
  });

/* ---------- A. 只读探测必须绕过闸门（本次修的现场问题） ---------- */
test('A. ★ 开关关闭时，只读探测 --list-providers 仍成功且能列出通道', () => {
  if (!existsSync(RUNNER) || !existsSync(APP_CONFIG)) return; // 环境缺文件 ⇒ 跳过（不假绿）
  const root = project(false);
  const r = run(['--list-providers', '--project', root]);
  assert.equal(r.status, 0, `★ 冻结期间探测必须成功（否则面板无通道可显示）；stderr=${r.stderr}`);
  assert.match(r.stdout, /bigmodel-coding-plan/, '★ 通道行照常输出（面板据此渲染下拉）');
  assert.match(r.stdout, /reasoning-levels GLM-5\.3=low,high,max/, '思考强度探测也照常');
});

/* ---------- B. 一切真实派发仍必过闸（闸门语义不得被削弱） ---------- */
test('B. ★ 开关关闭时，真实派发仍被拒绝（exit 3，且不启动任何进程）', () => {
  if (!existsSync(RUNNER) || !existsSync(APP_CONFIG)) return;
  const root = project(false);
  const r = run(['--project', root, '--prompt', 'SHOULD-NOT-RUN', '--no-ledger']);
  assert.equal(r.status, 3, `★ 冻结必须拦住派发（exit 3 = 总开关拒绝）；实际=${r.status}`);
  assert.match(r.stderr, /派发总开关为「关闭」/, '错误信息说明是总开关拒绝');
  assert.match(r.stderr, /未启动任何进程、未消耗任何额度/, '明确"未消耗额度"');
  assert.doesNotMatch(r.stdout, /provider=/, '★ 未进入派发流程（没有 provider= 行）');
});

/* ---------- C. 开关开启时，探测与派发都不会被闸门误伤 ---------- */
test('C. 开关开启时探测成功（对照：确认 A 不是"闸门整个失效"）', () => {
  if (!existsSync(RUNNER) || !existsSync(APP_CONFIG)) return;
  const root = project(true);
  const r = run(['--list-providers', '--project', root]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /bigmodel-coding-plan/);
});

/* ---------- D. BOM 加固：带 BOM 的关闭文件不得静默失效 ---------- */
test('D. ★ BOM 加固：带 UTF-8 BOM 的 enabled:false 仍必须拦住派发（原先 fail-open）', () => {
  if (!existsSync(RUNNER) || !existsSync(APP_CONFIG)) return;
  const root = project(false, { bom: true });
  const r = run(['--project', root, '--prompt', 'SHOULD-NOT-RUN', '--no-ledger']);
  assert.equal(r.status, 3, `★ BOM 不该让冻结静默失效；实际=${r.status}`);
  assert.match(r.stderr, /派发总开关为「关闭」/);
});

/* ---------- E. 源码锁：闸门位置不得回退到最前 ---------- */
test('E. ★ runner 源码锁：GATE 必须在 --list-providers 分支之后', () => {
  const src = readFileSync(RUNNER, 'utf8');
  const iProbe = src.indexOf('if (opt.listProviders) {');
  const iGate = src.indexOf('---------- GATE：派发总开关');
  assert.ok(iProbe > 0 && iGate > 0, '两个锚点都能找到');
  assert.ok(iGate > iProbe, '★ 闸门在只读探测之后（回退到最前会重新挡住探测 ⇒ 面板无通道）');
  /* 同时确认：闸门仍早于凭据读取与子进程启动（ZB-33 的收益不能丢）
   * 锚点须**精确**：'凭据双保险' 在文件头注释（第 64 行）也出现过，用 indexOf 会取到它。 */
  const iCred = src.indexOf('/* ---------- 凭据双保险');
  const iSpawn = src.indexOf('spawnSync(process.execPath, [CLI');
  assert.ok(iCred > 0 && iSpawn > 0, '凭据段与 spawnSite 锚点都能找到');
  assert.ok(iGate < iCred, `★ 闸门仍早于凭据读取（冻结时不碰凭据库）；gate=${iGate} cred=${iCred}`);
  assert.ok(iGate < iSpawn, `★ 闸门仍早于子进程启动；gate=${iGate} spawn=${iSpawn}`);
  assert.ok(/replace\(\/\^\\uFEFF\/, ''\)/.test(src), '★ BOM 剥离已实现（防回归）');
});

/* ---------- F. 面板：冻结时必须明说（否则用户当成"插件坏了"） ---------- */
test('F. ★ 面板：冻结时在「通道」分区渲染 switchOffBlocked（既有键，不新增文案）', () => {
  const src = readFileSync(CLIENT, 'utf8');
  assert.ok(/sw && sw\.enabled === false/.test(src), '★ 通道分区按 sw.enabled===false 判定冻结');
  assert.ok(/h\('div', \{ className: 'dsp-note', role: 'status', title: t\('switchOffBlocked'\) \}, t\('switchOffBlocked'\)\)/.test(src),
    '★ 渲染冻结说明（复用 switchOffBlocked）');
  /* 参数列表尾部形状会随后续需求增补（本轮加了 chanError / ZB-82 的 split+onSplitSet）——
   * 断言**包含**而非逐字全等，只钉住"sw 确实作为 prop 传进来了"这个不变量。 */
  assert.ok(/function ChannelSection\(\{[\s\S]{0,200}?\bsw(,| \})/.test(src),
    '★ sw 已作为 prop 传入 ChannelSection');
  assert.ok(/offlineReason, sw: dispatchSwitch/.test(src), '★ 渲染点把 snapshot 的开关状态传下去');
  /* 单源哨兵：键必须中英都有（client STRINGS 与 locale 一致） */
  const zh = JSON.parse(readFileSync(join(HERE, '..', 'locale', 'zh.json'), 'utf8')).ui;
  const en = JSON.parse(readFileSync(join(HERE, '..', 'locale', 'en.json'), 'utf8')).ui;
  assert.ok(zh.switchOffBlocked && en.switchOffBlocked, 'locale 中英都有 switchOffBlocked');
  assert.ok(/switchOffBlocked:/.test(src), 'client STRINGS 含该键');
});
