// DSH 独立验收探针（Z2）：静态纪律 + 客户端模块加载 + 槽位注册（不复用实现方脚本）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const PKG = 'F:\\My Code\\dsh-dispatch\\dispatch';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };

/* ZB-25（审计 D#1）：越界检查改为**本探针运行前后的 $DSH_HOME 快照对比**。
 * 原实现是「profile 目录近 1h 无 mtime 变更」——那是**环境依赖判定**：用户装过一次插件就恒红，
 * 而加 Z2_ALLOW_PROFILE_WRITE=1 又恒绿（唯一的越界不变量形同虚设）。现在只在"探针自己跑的
 * 过程中把 $DSH_HOME 写了"才红 —— 与本机历史状态无关，才是本包真正要守的东西。 */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'desktop');
const snapshotProfile = () => {
  try {
    return new Map(readdirSync(PROFILE_DIR, { withFileTypes: true }).map((d) => [d.name, statSync(join(PROFILE_DIR, d.name)).mtimeMs]));
  } catch { return null; } // 目录不存在 = SKIP（不计 PASS，也不假红）
};
const PROFILE_BEFORE = snapshotProfile();

/* ---------- ① manifest / patch ---------- */
const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
check('manifest: name/exports/dsh.bundle.patch', pkg.name === 'dsh-dispatch' && pkg.exports?.['.'] === './index.js' && pkg.exports?.['./client'] === './client.js' && pkg.dsh?.bundle?.patch === './cordis.patch.yml', `${pkg.name}`);
/* ZB-32 市场合规：可发布身份 + 元数据。`private:true` 会挡掉 npm 发布；
 * typert-loader 硬校验 TYPERT.package === 包名（refs/dsh-typert/loader/lib/index.js:80），
 * 故 name 与 TYPERT.package 必须**逐字一致**，这里一并钉住。 */
check('manifest: 可发布身份（name/version/license/repository/keywords/engines/manifestVersion）',
  !pkg.private && /^[a-z0-9][a-z0-9._~-]*$/.test(pkg.name) && /^\d+\.\d+\.\d+/.test(pkg.version)
  && !!pkg.license && !!pkg.repository?.url && Array.isArray(pkg.keywords) && pkg.keywords.includes('dsh-plugin')
  && !!pkg.engines?.node && pkg.dsh?.manifestVersion === 1,
  `private=${pkg.private} license=${pkg.license} keywords=${pkg.keywords?.length ?? 0} engines=${pkg.engines?.node ?? '-'} manifestVersion=${pkg.dsh?.manifestVersion ?? '-'}`);
{
  const typPkg = /package:\s*'([^']+)'/.exec(readFileSync(join(PKG, 'wire.host.mjs'), 'utf8'))?.[1];
  check('manifest: TYPERT.package ≡ package.json name（loader 硬校验）', typPkg === pkg.name, `TYPERT.package=${typPkg} name=${pkg.name}`);
}
check('manifest: dsh.client 平台/立即加载', pkg.dsh?.client?.platform === 'web' && pkg.dsh?.client?.immediately === true, JSON.stringify(pkg.dsh?.client ?? {}));
check('manifest: meta 标题/描述/图标', !!pkg.meta?.title && !!pkg.meta?.description && pkg.icon === './icon.svg', `${pkg.meta?.title}`);
/* ZB-22 补：`files` 必须覆盖 host 半边的**相对 import**。install_bundle 按 files 打包，
 * 漏一个文件 = 装出来的插件缺模块直接加载失败（ZB-22 新增 notify.mjs 时差点踩）。
 * 判据：index.js 里所有 ./xxx 说明符，要么直接列在 files，要么落在某个列出的目录项下。 */
{
  const listed = new Set(pkg.files ?? []);
  const rel = [...readFileSync(join(PKG, 'index.js'), 'utf8').matchAll(/from\s+'(\.\/[^']+)'/g)].map((m) => m[1].replace(/^\.\//, ''));
  const covered = (f) => listed.has(f) || [...listed].some((d) => !d.includes('.') && f.startsWith(`${d}/`));
  const missing = rel.filter((f) => !covered(f));
  check('manifest: files 覆盖 index.js 的相对 import', missing.length === 0, missing.length ? `缺: ${missing.join(',')}` : `${rel.length} 个相对 import 全覆盖`);
}

/* R01（2026-10-26 审查 P1）：**跨目录 import 也要核对** —— 且必须按**根包**清单核。
 *  `dispatch/core/*.mjs` 与 `wire.host.mjs` 里有 `../../collab-kit/xxx.mjs` 这类
 *  **包边界外**的静态导入；而 DSH 安装的是**根包**（含 `dispatch/` + `collab-kit/`），
 *  上面那项只检查了 index.js 的 `./` 导入、且用的是 dispatch 子包清单 ⇒ 打包缺 collab-kit
 *  也照样通过（报告里实测：按 pack 清单重建隔离目录后 import 直接 ERR_MODULE_NOT_FOUND）。 */
{
  const ROOT = resolve(PKG, '..');
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const listed = new Set(rootPkg.files ?? []);
  const covered = (f) => listed.has(f) || [...listed].some((d) => !d.includes('.') && f.startsWith(`${d}/`));
  const cross = new Set();
  const coreFiles = readdirSync(join(PKG, 'core')).filter((f) => f.endsWith('.mjs')).map((f) => join('core', f));
  for (const rel of ['index.js', 'wire.host.mjs', ...coreFiles]) {
    const src = readFileSync(join(PKG, rel), 'utf8');
    for (const m of src.matchAll(/from\s+'(\.\.[^']+)'/g)) {
      cross.add(relative(ROOT, resolve(dirname(join(PKG, rel)), m[1])).replace(/\\/g, '/'));
    }
  }
  const miss = [...cross].filter((f) => !covered(f));
  check('manifest: 根包 files 覆盖跨目录 import（../../collab-kit 等）', miss.length === 0,
    miss.length ? `缺: ${miss.join(', ')}` : `${cross.size} 个跨目录 import 全覆盖`);
}
const patch = readFileSync(join(PKG, 'cordis.patch.yml'), 'utf8');
check('patch: 插入行 id/name/config', /id:\s*dispatch/.test(patch) && /name:\s*'dsh-dispatch'/.test(patch) && /runnerPath:/.test(patch) && /ledgerPath:/.test(patch), patch.split('\n').filter((l) => /runnerPath|ledgerPath|demo|maxConcurrent/.test(l)).join(' | ').slice(0, 140));

/* ---------- ② 静态纪律 ---------- */
const jsFiles = readdirSync(PKG, { recursive: true }).filter((f) => /\.(js|mjs)$/.test(f) && !f.includes('work') && !f.includes('test'));
const readAll = (f) => readFileSync(join(PKG, f), 'utf8');
const client = readAll('client.js');
const index = readAll('index.js');
check('纪律: 不 import DSH 客户端包', !/@deepseek-ai\/dsh-client/.test(jsFiles.map(readAll).join('\n')), 'no @deepseek-ai/dsh-client');
check('纪律: 不操作 document.body', !/document\.body/.test(jsFiles.map(readAll).join('\n')), 'no document.body');
const literalColors = [...client.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
check('纪律: client.js 无字面色值（仅主题令牌）', literalColors.length === 0, literalColors.slice(0, 5).join(',') || 'none');
check('纪律: client.js 不用 JSX/模块 import', !/^\s*import\s/m.test(client) && !/=>\s*</.test(client), `createElement 次数=${(client.match(/createElement/g) ?? []).length}`);
const tokens = [...client.matchAll(/--dsw-alias-[a-z0-9-]+/g)].map((m) => m[0]);
check('纪律: 使用 --dsw-alias-* 主题令牌', tokens.length >= 5, `令牌引用 ${tokens.length} 处，去重 ${new Set(tokens).size} 个`);

/* ---------- ③ Host 半边导出 ---------- */
check('index.js 导出 apply', /export\s+function\s+apply\s*\(/.test(index), 'apply found');
check('index.js 声明 Config（可配置）', /export\s+const\s+Config\s*=/.test(index), 'Config found');
/* cordis resolveConfig 只认 Config['~standard'].validate（裸 JSON Schema 会导致激活失败，见 Z10） */
{
  let std = { ok: false, detail: 'import 失败' };
  try {
    const mod = await import('file:///F:/My Code/dsh-dispatch/dispatch/index.js');
    const C = mod.Config;
    const fn = C && C['~standard'] && C['~standard'].validate;
    const res = typeof fn === 'function' ? fn({}) : null;
    const v = res && res.value;
    std = {
      ok: typeof fn === 'function' && !!v && v.demo === false && v.maxConcurrent === 3 && typeof v.workRoot === 'string',
      detail: typeof fn === 'function' ? JSON.stringify(v) : '无 ~standard.validate',
    };
  } catch (e) {
    std = { ok: false, detail: e.message.split('\n')[0] };
  }
  check('Config 是 Standard Schema（cordis 激活判据）', std.ok, std.detail);
}
check('index.js 引用 core dispatcher', /dispatch-core\.mjs/.test(index) && /createDispatcher/.test(index), 'imports core');

/* ---------- ④ 客户端模块加载（stub ModuleLoader + require） ---------- */
let captured = null;
globalThis.window = { __ModuleLoader__: { load: (o) => { captured = o; } } };
await import(pathToFileURL(join(PKG, 'client.js')).href);
check('client.js 通过 __ModuleLoader__.load 注册', !!captured && captured.id === 'dsh-dispatch' && typeof captured.factory === 'function', `id=${captured?.id}`);

const el = (type, props, ...children) => ({ type, props, children });
class StubComponent {
  constructor(props) { this.props = props ?? {}; this.state = {}; }
  setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }; }
}
const React = {
  createElement: el, Fragment: 'Fragment', Component: StubComponent,
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => (typeof f === 'function' ? f() : f),
  useSyncExternalStore: () => undefined,
};
const unexpected = [];
const mod = captured.factory((name) => {
  if (name === 'react') return React;
  unexpected.push(name);
  return {};
});
check('factory 只 require react', unexpected.length === 0, unexpected.join(',') || 'react only');
check('factory 返回 {inject, apply}', Array.isArray(mod?.inject) && typeof mod?.apply === 'function', `inject=${JSON.stringify(mod?.inject)}`);
/* boot 安全：inject 里绝不能出现自家 remote 命名空间（等自己 → pending → web boot 失败；2026-09-30 实际崩溃） */
{
  const bad = (mod?.inject ?? []).filter((n) => typeof n === 'string' && n.startsWith('remote.'));
  check('boot 安全: inject 不自声明 remote 命名空间', bad.length === 0, bad.length ? `❌ ${bad.join(',')}` : `inject=${JSON.stringify(mod?.inject)}`);
}

let slots = [];
let registrations = [];
const ctx = {
  slots: {
    inject: (key, cb) => { slots.push(key); cb(); return () => {}; },
    register: (opts, comp) => { registrations.push({ opts, comp }); return () => {}; },
  },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  on: () => () => {},
  locale: { formatMessage: (m, v) => `${m.id ?? m}${v ? JSON.stringify(v) : ''}` },
};
try {
  mod.apply(ctx);
  check('apply 注入槽位并注册组件', slots.length > 0 && registrations.length > 0, `slot=${slots[0]} 注册数=${registrations.length}`);
} catch (err) {
  check('apply 注入槽位并注册组件', false, `抛错: ${err.message}`);
}

/* ---------- ⑤ 组件可执行（浅渲染一次，验证不白屏） ---------- */
if (registrations.length) {
  try {
    const tree = registrations[0].comp({});
    check('组件函数可执行（浅渲染不抛错）', !!tree, `根节点 type=${tree?.type}`);
  } catch (err) {
    check('组件函数可执行（浅渲染不抛错）', false, `抛错: ${err.message}`);
  }
}

/* ---------- ⑥ 越界：本探针运行期间 $DSH_HOME 未被写入 ---------- */
{
  const after = snapshotProfile();
  const before = PROFILE_BEFORE;
  if (before === null || after === null) {
    console.log('SKIP  越界: $DSH_HOME profile 存在性检查（未找到 ' + PROFILE_DIR + '，跳过而非假绿）');
  } else {
    const touched = [];
    for (const [name, mtime] of after) {
      if (!before.has(name)) touched.push(`${name}(新增)`);
      else if (before.get(name) !== mtime) touched.push(`${name}(修改)`);
    }
    for (const name of before.keys()) if (!after.has(name)) touched.push(`${name}(删除)`);
    check(
      '越界: 探针运行期间 $DSH_HOME 无写入',
      touched.length === 0,
      touched.join(',') || 'clean',
    );
    /* 该判定与本机历史无关（不再依赖"近 1h"），因此 Z2_ALLOW_PROFILE_WRITE=1 已无必要；
     * 保留兼容：显式设了仍放行，但打印提醒。 */
    if (touched.length && process.env.Z2_ALLOW_PROFILE_WRITE === '1') {
      console.log('   （已按 Z2_ALLOW_PROFILE_WRITE=1 放行 —— 该开关已非必需：新判定只看探针自身运行窗口）');
      results[results.length - 1].ok = true;
    }
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n[DSH Z2 探针] ${results.length} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
