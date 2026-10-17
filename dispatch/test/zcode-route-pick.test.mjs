// ZB-51 契约锁：ZCode 的**两条路由实现不同**，模型下拉选中后必须分别映射到各自的 provider。
//
// 背景（用户提醒，必须钉死）：`plan`（套餐）与 `account:bigmodel-start-plan`（免费额度）
// **不是同一个通道换标签**，而是两套独立实现：
//   · Plan：`provider='plan'`（别名，runner 解析成用户选中的套餐 provider，如 bigmodel-coding-plan）
//   · 免费：`provider='account:bigmodel-start-plan'`（runner 用它自带的 `start-plan` provider，
//           独立额度窗口、不同端点 zcode.z.ai）
// 若把两者混成一个 provider（或选了免费却发 plan），用户会**以为在用免费额度，实际扣套餐**。
//
// 跑法：node dispatch/test/zcode-route-pick.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const src = readFileSync(join(PKG, 'client.js'), 'utf8');

let pass = 0; const fail = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };

console.log('① 模型项 key 必须**同时**编码路由与模型（ZCode 专属）');
{
  ok(/const key = useRouteKeys \? `\$\{routeId\}::\$\{m\}` : m;/.test(src),
    '★ ZCode 的模型项 key = `<路由id>::<模型名>`（路由与模型都不可丢）');
  ok(/const useRouteKeys = \(eng === 'zcode'\);/.test(src),
    '仅 ZCode 需要 key 编码路由（OpenCode/Qoder 一个模型一条通道，无路由维度）');
}

console.log('\n② 选中后必须回写**该路由自己的 provider**（不能统一发 plan）');
{
  /* routeForPick 的实现：ZCode 分支返回 { provider: 该路由 id, model: 真实模型名 } */
  const fnAt = src.indexOf('const routeForPick = (agg, model) =>');
  const fnBody = fnAt >= 0 ? src.slice(fnAt, fnAt + 900) : '';
  ok(fnAt >= 0 && fnBody.length > 0, '能定位 routeForPick');
  ok(/return \{ provider: real \?\? 'plan', model: realModel \};/.test(fnBody),
    '★ ZCode 分支：provider = 该模型项所属的**真实路由 id**（`real`），不是写死 plan');
  ok(/const real = agg\._routeOf\?\.\[model\] \?\? null;/.test(fnBody), '取了路由表');
  ok(/const realModel = agg\._modelOf\?\.\[model\] \?\? null;/.test(fnBody), '取了真实模型名');
  /* 反面：绝不能出现"统一发 plan"的写法 */
  ok(!/return \{ provider: 'plan', model: realModel \};/.test(fnBody),
    '★ 反面保护：绝不把所有 ZCode 模型项都发成 plan（那会让"选免费额度却扣套餐"）');
}

console.log('\n③ 两个上拉（主通道 + 降级目标）都必须走同一条映射');
{
  const switchAt = src.indexOf('const switchModel = (m) => {');
  /* ⚠️ 窗口要够大：`switchModel` 开头现在还有「选中顺序派发 ⇒ 自动开开关」的联动
   * （注释 + 代码约 300 字符）。固定 400 会把 ZCode 分支挤出窗口 —— 这条曾假红过一次。 */
  const switchBody = switchAt >= 0 ? src.slice(switchAt, switchAt + 900) : '';
  ok(/if \(sel && sel\.engine === 'zcode'\) \{ const p = routeForPick\(sel, m\); onSwitch\(\{ provider: p\.provider, model: p\.model \}\); return; \}/.test(switchBody),
    '★ 主「模型」下拉：ZCode ⇒ provider+model 一起写回');
  const fbAt = src.indexOf('const fbSwitchModel = (m) => {');
  const fbBody = fbAt >= 0 ? src.slice(fbAt, fbAt + 400) : '';
  ok(/if \(fbSel && fbSel\.engine === 'zcode'\) \{ const p = routeForPick\(fbSel, m\); saveTarget\(\{ provider: p\.provider, model: p\.model \}\); return; \}/.test(fbBody),
    '★ 降级「模型」下拉：同一套映射（两处不得各写一份）');
}

console.log('\n④ 免费额度**只列它真正提供的模型**（可配置常量，不写死在逻辑里）');
{
  ok(/const ZC_FREE_MODELS = \['GLM-5\.3-Flash'\];/.test(src),
    '★ 免费额度模型白名单是**具名常量**（权益变化改一行，不散落在逻辑里）');
  ok(/const isFreeRoute = \/\^account:\.\*start-plan\$\/\.test\(routeId\);/.test(src),
    '免费路由判据 = `account:*start-plan`');
  ok(/const allowed = isFreeRoute \? rawModels\.filter\(\(m\) => ZC_FREE_MODELS\.includes\(m\)\) : rawModels;/.test(src),
    '★ 只有免费路由收窄模型集；套餐路由保留全部（套餐确实提供 GLM-5.3 与 GLM-5.3-Flash）');
  ok(/const models = allowed\.length \? allowed : rawModels;/.test(src),
    '★ 兜底：白名单写空时不至于把免费路由的模型全清掉（fail-open 到原始列表）');
}

console.log('\n⑤ 标签必须能区分"同名的套餐项"与"免费项"');
{
  ok(/const ROUTE_LABEL_KEY = \{ plan: 'zcRoutePlan', 'account:bigmodel-start-plan': 'zcRouteFree' \};/.test(src),
    '两条路由各有文案键（BigModel(Plan) / Start Plan(免费)）');
  ok(/routeId === 'account:bigmodel-start-plan' \? `\$\{model\}「\$\{t\('zcFreeSuffix'\)\}」` : model;/.test(src),
    '★ 免费项的显示 = `<模型名>「免费」` ⇒ 与套餐的 `GLM-5.3-Flash` **不混淆**');
}

console.log(`\n===== ZCode 路由选择契约：${pass} PASS / ${fail.length} FAIL =====`);
for (const m of fail) console.log(`  ✗ ${m}`);
process.exit(fail.length ? 1 : 0);
