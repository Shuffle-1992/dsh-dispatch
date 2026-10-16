// ZB-51 契约锁：`client.js` 的 **TDZ（声明前使用）** 检查。
//
// 为什么需要它（血泪教训，一个晚上踩了两次）：
//   `client.js` 是**普通脚本**（无模块系统、不能拆文件），大量逻辑写在组件函数体内。
//   在那里用 `const` 定义 helper、却在**定义之前**调用它 ⇒ `ReferenceError: Cannot access
//   'X' before initialization` —— **面板直接白屏**。而 `node --check` 只查语法，**查不出来**。
//   本会话两次实例：
//     ① `sel`（第 2039 行）用了第 2168 行才定义的 `foldChannels`；
//     ② `foldChannels` 内部用了组件内后置的 `engineOf`（真 DOM 渲染才暴露）。
//   故这里做**静态"定义行 > 使用行"检查**，把这类错误挡在提交前。
//
// 覆盖范围：只查"在 **模块级** 定义的 const 箭头函数/常量"是否被更早使用。
// 组件内的同类问题由 `fallback-ui.test.mjs` 的**真 DOM 渲染**兜住（它会真的执行面板）。
//
// 跑法：node dispatch/test/client-tdz.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const src = readFileSync(join(PKG, 'client.js'), 'utf8');
const lines = src.split('\n');

let pass = 0; const fail = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };

/** 收集"模块级（**恰好** 4 空格缩进）的 const 定义"：name → 行号（1-based）。
 *  ⚠️ 必须锚定"恰好 4 空格"：`^ {4}` 会同时匹配 6/8 空格的深层缩进（前缀匹配）——
 *  第一版就因此把组件内的 const 误当模块级，报出一堆假违规（自我误报）。 */
function collectTopLevelConsts() {
  const map = new Map();
  lines.forEach((l, i) => {
    const m = l.match(/^ {4}(?! )const\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m && !map.has(m[1])) map.set(m[1], i + 1);
  });
  return map;
}

/** 该行是否**真的在代码里**提到 name（排除：定义行、纯注释行、字符串字面量、行尾注释）。 */
function bodyMentions(name, rawLine) {
  const t = rawLine.trimStart();
  /* 纯注释行：`* …`（JSDoc 正文）/ `//…` / `/*…` ⇒ 不算代码使用。
   * ⚠️ 第一版没排除这一条，把文档注释里提到的 `loadJson/saveJson` 当成了使用。 */
  if (/^(\*|\/\/|\/\*)/.test(t)) return false;
  const stripped = rawLine
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/\/\/.*$/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(stripped);
}

/** 找某标识符的**首个真实使用**行（1-based）；找不到返回 -1。 */
function firstUseLine(name, defLine) {
  for (let i = 0; i < lines.length; i += 1) {
    const n = i + 1;
    if (n === defLine) continue;
    if (bodyMentions(name, lines[i])) return n;
  }
  return -1;
}

console.log('=== client.js 模块级 const 的"声明前使用"检查（TDZ）');
{
  const consts = collectTopLevelConsts();
  ok(consts.size > 20, `收集到 ${consts.size} 个模块级 const（检查确实在跑，不是空转）`);

  /* 只关注"会被组件提前使用"的 helper 家族：以函数/箭头形态定义的。 */
  const offenders = [];
  for (const [name, defLine] of consts) {
    const defText = lines[defLine - 1];
    const isFn = /=>\s*\{?\s*$/.test(defText) || /=>/.test(defText) || /=\s*(?:async\s*)?\(/.test(defText);
    if (!isFn) continue;
    const use = firstUseLine(name, defLine);
    if (use > 0 && use < defLine) offenders.push({ name, defLine, use });
  }
  for (const o of offenders) console.log(`      ${o.name}: 用于第 ${o.use} 行，定义在第 ${o.defLine} 行`);
  ok(offenders.length === 0, `★ 没有"模块级 helper 在定义前被使用"（违规 ${offenders.length} 处）`);
}

console.log('\n=== 引擎归一 helper 必须处于**模块级**（组件内会 TDZ）');
{
  /* 这四个是 ZB-51 新增、被多个组件消费的 helper。它们必须在模块级（缩进 4）声明：
   * 组件内声明时，另一个组件（ChannelSection 的 foldChannels）用它们就会 TDZ。 */
  for (const name of ['KNOWN_ENGINES', 'engineOf', 'engLabel', 'jobEngineOf']) {
    const at = lines.findIndex((l) => new RegExp(`^ {4}const\\s+${name}\\s*=`).test(l));
    ok(at >= 0, `★ ${name} 在模块级声明（第 ${at + 1} 行）`);
  }
  /* 反例保护：它们**不得**在组件函数内重复声明（重复会把模块级那个遮蔽掉，行为不可预期）。 */
  const dup = lines.filter((l) => /^ {6,}const\s+(engineOf|engLabel|jobEngineOf|KNOWN_ENGINES)\s*=/.test(l));
  ok(dup.length === 0, `★ 组件内没有重复声明（违规 ${dup.length} 处）`);
}

console.log('\n=== 交叉验证：真 DOM 渲染测试存在（覆盖组件内 TDZ）');
{
  /* 组件内的 TDZ 静态查不全 ⇒ 必须有一个"真渲染"的测试兜底。
   * 事实上正是它抓到了 `engineOf` 那次 TDZ。 */
  const fb = readFileSync(join(PKG, 'test', 'fallback-ui.test.mjs'), 'utf8');
  ok(/expand\(|ChannelSection|render/i.test(fb), '★ fallback-ui.test.mjs 会真的渲染 ChannelSection（组件内 TDZ 的兜底）');
}

console.log(`\n===== client TDZ 契约：${pass} PASS / ${fail.length} FAIL =====`);
for (const m of fail) console.log(`  ✗ ${m}`);
process.exit(fail.length ? 1 : 0);
