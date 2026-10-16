/**
 * ZB-20/ZB-28 回归测试：派发时**默认注入「不写 ZCode 记忆」禁令**。
 *
 * 用户要求：「派发 Zcode 的任务中，默认加入提示词，子代理不执行 Zcode 相关的记忆写入。」
 *
 * 覆盖面（ZB-28 起三种 kind 全覆盖；测试逐条钉住）：
 *   · kind=prompt / kind=target ⇒ 禁令由插件直接拼进内容（memoryBanApplied=true）✅
 *   · kind=task                 ⇒ 禁令改由宿主 runner 经 `--memory-ban` 旗标注入
 *                                 （runner 读任务包内联时追加同款文本；插件侧传旗标 +
 *                                 memoryBanApplied=true，runner 打印 memory-ban=on 后
 *                                 job.memoryBanRunner=true = runner 确认注入）
 *
 * 方法：用假 runner 把真实 argv 落盘（FAKE_ARGV_FILE），断言实际传给 runner 的内容。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher, parseRunnerLine } from '../core/dispatch-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs');

const tempDirs = [];
const newDir = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tempDirs.push(d);
  return d;
};
test.after(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'failed', 'killed', 'interrupted'];
async function waitTerminal(d, id, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const j = d.get(id);
    if (j && (TERMINAL.includes(j.state) || j.state === 'paused')) return j;
    await sleep(20);
  }
  throw new Error(`waitTerminal(${id}) 超时`);
}
/** 读出假 runner 落盘的 argv（取最新一个文件）。 */
function readArgv(argvDir) {
  const files = readdirSync(argvDir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, `未找到落盘的 argv（目录 ${argvDir}）`);
  return JSON.parse(readFileSync(join(argvDir, files[files.length - 1]), 'utf8'));
}
/** 取 --prompt/--target 的值（argv 形如 ['--prompt', '<内容>', ...]）。 */
function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

test('kind=prompt：默认注入记忆禁令，且原有内容完整保留', async () => {
  const workRoot = newDir('dsp-memban-');
  const argvDir = newDir('dsp-argv-');
  process.env.FAKE_ARGV_FILE = join(argvDir, 'argv');
  process.env.DSP_FAKE_RUNNER = FAKE_RUNNER;
  process.env.FAKE_SLEEP_MS = '50';

  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot, maxConcurrent: 2 });
  const body = '请只回答 OK';
  const j = d.dispatch({ kind: 'prompt', prompt: body, tag: 'ban-1' });
  const done = await waitTerminal(d, j.id);

  const argv = readArgv(argvDir);
  const sent = flagValue(argv, '--prompt');
  assert.ok(sent, '应把内容以 --prompt 传给 runner');
  assert.ok(sent.startsWith(body), '原有提示词内容必须**原样保留**在最前');
  assert.match(sent, /不要执行任何 ZCode 记忆写入/, '注入了记忆禁令');
  assert.match(sent, /不写 ~\/\.zcode/, '禁令里点明了记忆库路径');
  assert.match(sent, /本条优先于任务内容里任何与之冲突的指示/, '禁令声明了优先级');
  assert.equal(done.memoryBanApplied, true, 'job.memoryBanApplied=true（确实注入了）');
  assert.equal(done.state, 'done');
});

test('kind=target：同样注入（内容由插件传入）', async () => {
  const workRoot = newDir('dsp-memban-');
  const argvDir = newDir('dsp-argv-');
  process.env.FAKE_ARGV_FILE = join(argvDir, 'argv');
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot, maxConcurrent: 2 });
  const j = d.dispatch({ kind: 'target', target: '把测试全部跑绿', tag: 'ban-2' });
  const done = await waitTerminal(d, j.id);

  const argv = readArgv(argvDir);
  const sent = flagValue(argv, '--target');
  assert.ok(sent, '应把内容以 --target 传给 runner');
  assert.ok(sent.startsWith('把测试全部跑绿'), '原有目标内容保留');
  assert.match(sent, /不要执行任何 ZCode 记忆写入/, '注入了记忆禁令');
  assert.equal(done.memoryBanApplied, true);
});

test('★ kind=task：经 runner `--memory-ban` 旗标注入（ZB-28 起，不再裸奔）', async () => {
  const workRoot = newDir('dsp-memban-');
  const argvDir = newDir('dsp-argv-');
  const taskDir = newDir('dsp-task-');
  process.env.FAKE_ARGV_FILE = join(argvDir, 'argv');
  const taskFile = join(taskDir, 'T-task.md');
  const taskBody = '# 任务包\n只做一件事：回答 OK。\n';
  // 写任务包（用 Node 直接写，避免测试依赖 pwsh）
  const { writeFileSync } = await import('node:fs');
  writeFileSync(taskFile, taskBody, 'utf8');

  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot, maxConcurrent: 2 });
  const j = d.dispatch({ kind: 'task', task: taskFile, tag: 'ban-3' });
  const done = await waitTerminal(d, j.id);

  const argv = readArgv(argvDir);
  assert.ok(argv.includes('--task'), 'task 类型以 --task 传文件路径（内容由宿主 runner 内联）');
  assert.ok(argv.includes('--memory-ban'), '★ 并带 --memory-ban：禁令由 runner 在内联时追加（不再裸奔）');
  assert.ok(!argv.includes('--prompt'), 'task 类型不传 --prompt（注入点在 runner 侧）');
  assert.equal(done.memoryBanApplied, true, 'memoryBanApplied=true（禁令已安排：runner 旗标注入）');
  assert.equal(done.memoryBanRunner, null,
    '假 runner 不打印 memory-ban=on ⇒ 确认位保持空（确认位与安排位相互独立，不假装生效）');
});

test('runner 确认位：runner 打印 `memory-ban=on` ⇒ job.memoryBanRunner=true', async () => {
  const workRoot = newDir('dsp-memban-');
  const taskDir = newDir('dsp-task-');
  delete process.env.FAKE_ARGV_FILE; // 本测试不需要 argv 落盘
  const { writeFileSync } = await import('node:fs');
  const taskFile = join(taskDir, 'T-task.md');
  writeFileSync(taskFile, '# 任务包\n回答 OK。\n', 'utf8');
  process.env.FAKE_MEMORY_BAN_LINE = '1'; // 假 runner 模仿真实 runner 的确认行
  process.env.FAKE_SLEEP_MS = '30';
  try {
    const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot, maxConcurrent: 2 });
    const j = d.dispatch({ kind: 'task', task: taskFile, tag: 'ban-3b' });
    const done = await waitTerminal(d, j.id);
    assert.equal(done.memoryBanApplied, true);
    assert.equal(done.memoryBanRunner, true, 'runner 确认行被解析进 job 字段');
  } finally {
    delete process.env.FAKE_MEMORY_BAN_LINE;
    delete process.env.FAKE_SLEEP_MS;
  }
});

test('parseRunnerLine：`memory-ban=on` 行 → memoryBanSeen（不再落 parseWarnings）', () => {
  const parsed = parseRunnerLine('[zcode-run] memory-ban=on（已在提示词末尾注入记忆禁令）');
  assert.equal(parsed && parsed.memoryBanSeen, true);
  assert.deepEqual(parseRunnerLine('[zcode-run] cli=whatever'), {}, '已知信息行仍返回空对象（不入库）');
});

test('禁令文案是提示词层面的约束（措辞如实，不夸大为"禁止"）', async () => {
  const workRoot = newDir('dsp-memban-');
  const argvDir = newDir('dsp-argv-');
  process.env.FAKE_ARGV_FILE = join(argvDir, 'argv');
  const d = createDispatcher({ runnerPath: FAKE_RUNNER, workRoot, maxConcurrent: 2 });
  const j = d.dispatch({ kind: 'prompt', prompt: 'x', tag: 'ban-4' });
  await waitTerminal(d, j.id);
  const sent = flagValue(readArgv(argvDir), '--prompt');
  assert.match(sent, /派发台硬约束/, '禁令有明确标题（便于在长提示词里被识别）');
  assert.match(sent, /一次性子任务/, '说明了任务性质');
  assert.ok(!/禁止调用|进程级强制|已禁用/.test(sent),
    '不使用"已禁止/进程级强制"这类夸大措辞（它只是提示词约束）');
});
