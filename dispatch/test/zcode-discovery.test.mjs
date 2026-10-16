// ZB-51 T3 回归测试：ZCode 执行器的**安装路径自动发现**（不再硬编码开发机盘符）。
//
// 为什么必须有这个测试：
//   原实现是 `const CLI = process.env.ZCODE_CLI || 'F:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs'`
//   —— 那是开发机的盘符。别人装在 C: 盘（或别的版本）时，"插件装了却用不了"。
//   本测试用**受控 env** 覆盖三种机器状态，并用真实子进程观察执行器的行为，
//   不依赖"本机恰好装在哪"。断言方式：看**报错/探测输出**，而不是读源码字符串。
//
// 跑法：node dispatch/test/zcode-discovery.test.mjs
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, '..', '..', 'collab-kit', 'zcode-run.mjs');
const THIS_MACHINE_CLI = 'F:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs';

let pass = 0; const fail = [];
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };

/** 跑一次执行器的只读探测（--list-providers：0 额度、不派任务）。 */
function runProbe(env) {
  const r = spawnSync(process.execPath, [RUNNER, '--list-providers'], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

console.log('① 环境变量指向坏路径 ⇒ **不能因此整体失败**（继续自动发现，本机仍可用）');
{
  const r = runProbe({ ZCODE_CLI: 'C:\\definitely\\not\\here\\zcode.cjs', ZCODE_HOME: '', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '' });
  if (existsSync(THIS_MACHINE_CLI)) {
    /* 设计取舍（明确记录）：显式 env 写错时**回退到自动发现**，而不是让整台机器不可用 ——
     * "开箱即用"优先：一个过期的环境变量不该把插件搞死。 */
    ok(r.code === 0, `★ 坏 env 不致命，仍回退发现成功（exit=${r.code}）`);
    ok(/builtin:|account:/.test(r.out), '仍能列出 provider');
    ok(!/null/.test(r.err), 'stderr 不出现 null（对用户可读）');
  } else {
    ok(r.code !== 0, `失败退出（实际 ${r.code}）`);
    ok(/未找到 ZCode CLI/.test(r.err) || /找不到 ZCode CLI/.test(r.err), '错误里说明找不到 CLI');
    ok(/ZCODE_CLI|ZCODE_HOME/.test(r.err), '★ 错误里给出修复方式');
    ok(!/null/.test(r.err), '错误里不出现 null');
  }
}

console.log('\n② 显式 ZCODE_HOME 指向安装根 ⇒ 自动推出 CLI 与 builtin 配置');
{
  const root = 'F:\\Program Files\\ZCode';
  if (!existsSync(root)) {
    console.log('  ⚠ 本机没有该安装根，跳过（用 ZCODE_CLI 覆盖路径做等价验证）');
    const r = runProbe({ ZCODE_CLI: THIS_MACHINE_CLI, ZCODE_HOME: '' });
    ok(r.code === 0 && /builtin:bigmodel/.test(r.out), 'ZCODE_CLI 覆盖时仍能列出 provider（说明 builtin 也被推导出来）');
  } else {
    const r = runProbe({ ZCODE_HOME: root, ZCODE_CLI: '', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '' });
    ok(r.code === 0, `用 ZCODE_HOME 推导成功（exit=${r.code}）`);
    ok(/builtin:bigmodel/.test(r.out) || /account:/.test(r.out), '★ 列出了 provider（CLI + builtin 都找到了）');
  }
}

console.log('\n③ 无任何覆盖 ⇒ 本机自动发现（**证明不靠硬编码也能跑通**）');
{
  const bare = { ...process.env };
  delete bare.ZCODE_CLI; delete bare.ZCODE_HOME; delete bare.ZCODE_INSTALL_DIR; delete bare.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  const r = spawnSync(process.execPath, [RUNNER, '--list-providers'], {
    encoding: 'utf8', timeout: 120000, env: bare, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const code = r.status; const out = r.stdout ?? ''; const err = r.stderr ?? '';
  if (existsSync(THIS_MACHINE_CLI)) {
    ok(code === 0, `★ 本机（ZCode 在 F: 盘）无 env 覆盖也能发现（exit=${code}）`);
    ok(/builtin:|account:/.test(out), '★ 列出了 provider ⇒ 「换盘符也能找到」这一目标达成');
  } else {
    ok(code !== 0 && /未找到 ZCode CLI/.test(err), '本机未装 ZCode 时给出可读未找到说明');
    ok(/已尝试 \d+ 个候选路径/.test(err), '★ 错误里报出尝试过的候选数量（便于自查）');
  }
}

console.log('\n④ 源码里不得再出现**开发机的字面安装路径**（只能出现在注释里说明历史）');
{
  const src = (await import('node:fs')).readFileSync(RUNNER, 'utf8');
  const lines = src.split('\n');
  const offenders = [];
  lines.forEach((l, i) => {
    const isComment = /^\s*(\*|\/\/|\/\*)/.test(l);
    if (isComment) return;
    /* 只揪"带盘符的绝对安装路径"（如 F:\Program Files\ZCode\...）。
     * 候选表里的 `'Program Files'` 这类**通用目录名枚举**是发现逻辑本身，不算硬编码。 */
    if (/[A-Za-z]:\\\\?Program Files/i.test(l) || /Program Files\\\\ZCode/i.test(l)) {
      offenders.push(`${i + 1}: ${l.trim().slice(0, 100)}`);
    }
  });
  ok(offenders.length === 0, `★ 可执行代码里没有字面安装路径（违规 ${offenders.length} 处）`);
  for (const o of offenders) console.log(`      ${o}`);
  /* 正例：发现逻辑必须存在，且支持三种覆盖方式 */
  ok(/function resolveZcodePaths\(\)/.test(src), '存在 resolveZcodePaths() 发现函数');
  ok(/ZCODE_HOME/.test(src) && /ZCODE_INSTALL_DIR/.test(src), '支持 ZCODE_HOME / ZCODE_INSTALL_DIR 覆盖');
  ok(/windowsDriveRoots|fromCharCode/.test(src), '★ 跨盘符枚举（原硬编码在 F: 盘，这是关键修复）');
  ok(/ZCODE_SUBPATH_CLI/.test(src) && /ZCODE_SUBPATH_BUILTIN/.test(src),
    'CLI 与 builtin 配置都由"安装根 + 相对子路径"推导（不再是两处独立硬编码）');
}

console.log(`\n===== ZCode 安装发现：${pass} PASS / ${fail.length} FAIL =====`);
for (const m of fail) console.log(`  ✗ ${m}`);
process.exit(fail.length ? 1 : 0);
