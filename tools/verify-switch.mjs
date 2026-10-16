// DSH 独立复现：Z12 的开关门禁（用临时真值文件，绝不碰真实开关文件）
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionHandler, createRemoteFace } from 'file:///F:/My Code/zcode-dispatch/dispatch/wire.host.mjs';

const dir = mkdtempSync(join(tmpdir(), 'z12-verify-'));
const swFile = join(dir, 'switch.json');
let dispatchCalls = 0;

const fakeDispatcher = {
  dispatch(spec) { dispatchCalls += 1; return { id: 'job-1', tag: 'x', state: 'queued', spec }; },
  list: () => [],
  get: () => null,
  snapshot: () => ({ generatedAt: new Date().toISOString(), counts: { running: 0, queued: 0, done: 0, failed: 0 }, jobs: [], locks: {}, queue: 0 }),
  kill: () => ({ id: 'job-1', state: 'killed' }),
  tail: () => [],
  subscribe: () => () => {},
  setChannel: () => ({}),
  getChannel: () => ({}),
  setFallbackChain: () => ({}),
  getFallbackChain: () => ({ enabled: false, chain: [] }),
  listChannels: async () => ({ channels: [{ id: 'plan', enabled: true, models: [] }], warnings: [] }),
};

const handle = createActionHandler(fakeDispatcher, { switchPath: swFile, demo: false });
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

// ① 无文件 → 视为开启（不误锁）
const r0 = await handle('dispatch', { kind: 'prompt', prompt: 'x' });
check('无开关文件 = 开启（不误锁）', r0.ok === true && dispatchCalls === 1, `ok=${r0.ok} calls=${dispatchCalls}`);

// ② 关闭 → 拒绝，且不建 job / 不 spawn
writeFileSync(swFile, JSON.stringify({ enabled: false, updatedBy: 'dsh-probe', note: '独立复现' }), 'utf8');
const before = dispatchCalls;
const r1 = await handle('dispatch', { kind: 'prompt', prompt: 'y' });
check('关闭 → dispatch 被拒', r1.ok === false && /总开关已关闭/.test(String(r1.error)), `error=${r1.error}`);
check('关闭 → 未调用 dispatcher.dispatch（不建 job/不 spawn）', dispatchCalls === before, `calls ${before}→${dispatchCalls}`);

// ③ switch 动作能写文件并回读
const r2 = await handle('switch', { enabled: true, by: 'dsh-probe', note: '复现用' });
check('switch 动作写入并返回状态', r2.ok === true && r2.switch && r2.switch.enabled === true, JSON.stringify(r2.switch));
const onDisk = JSON.parse(readFileSync(swFile, 'utf8'));
check('文件字段与 CLI 契约一致', onDisk.enabled === true && typeof onDisk.updatedAt === 'string' && onDisk.updatedBy === 'dsh-probe' && typeof onDisk.contract === 'string', Object.keys(onDisk).join(','));

// ④ 恢复开启后 dispatch 正常
const r3 = await handle('dispatch', { kind: 'prompt', prompt: 'z' });
check('重新开启 → dispatch 恢复', r3.ok === true && dispatchCalls === before + 1, `ok=${r3.ok} calls=${dispatchCalls}`);

// ⑤ 文件损坏 → 视为开启且不抛
writeFileSync(swFile, '{ this is not json', 'utf8');
const r4 = await handle('dispatch', { kind: 'prompt', prompt: 'w' });
check('文件损坏 → 视为开启且不抛', r4.ok === true, `ok=${r4.ok}`);

// ⑥ snapshot 暴露 switch 状态
writeFileSync(swFile, JSON.stringify({ enabled: false }), 'utf8');
const face = createRemoteFace(fakeDispatcher, { switchPath: swFile, demo: false });
const snap = await face.snapshot();
check('snapshot() 暴露 switch 状态', snap && snap.switch && snap.switch.enabled === false, JSON.stringify(snap.switch));

console.log(`\n[Z12 独立复现] ${pass + fail} 项，失败 ${fail} 项；临时目录 ${dir}`);
process.exit(fail ? 1 : 0);
