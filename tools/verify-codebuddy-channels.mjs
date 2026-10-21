/**
 * 真机验证（一次性脚本）：让 core 的 `listChannels()` **真的**经 codebuddy-run 探测出通道。
 *
 * 手法：zcode 骨架用 channelsProbeImpl 注入（避免真跑 ZCode runner），
 *      但 `codebuddyRunnerPath` **显式给真路径** ⇒ codebuddyProbeEnabled=true ⇒ 真探测。
 * 期望：出现 9 条 `codebuddy/<model>` 通道，每条带 thinkingLevels（6 档）+ version 2.161.0。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../dispatch/core/dispatch-core.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dsp-zb84-verify-'));
const FAKE_RUNNER = join(dir, 'noop.mjs');
const { writeFileSync } = await import('node:fs');
writeFileSync(FAKE_RUNNER, 'process.exit(0);\n', 'utf8');

const d = createDispatcher({
  runnerPath: FAKE_RUNNER,
  opencodeRunnerPath: '',
  qoderRunnerPath: '',
  /* ⚠️ 必须用 fileURLToPath：`new URL(...).pathname` 会给出 URL 编码路径（`My%20Code`），
   * 文件存在性判断直接失败（本轮踩到）。 */
  codebuddyRunnerPath: fileURLToPath(new URL('../collab-kit/codebuddy-run.mjs', import.meta.url)),
  workRoot: dir,
  /* ZCode 骨架：一行合法的 provider 表（core 靠它决定"清单非空"）。格式取自 engine-routing 的 fixture。 */
  channelsProbeImpl: async () => [
    'id'.padEnd(34) + 'enabled   端点/模型',
    'builtin:bigmodel-coding-plan'.padEnd(34) + 'true      https://x | GLM-5.3',
  ].join('\n'),
  /* 把 ZCode 的 config/cache/personal 指向不存在的文件，让 warnings 只剩被测项。 */
  zcodeConfigPath: join(dir, 'no-config.json'),
  planCachePath: join(dir, 'no-cache.json'),
  personalProviderPath: join(dir, 'no-personal.json'),
});

const r = await d.listChannels();
const cb = r.channels.filter((c) => c.engine === 'codebuddy');
console.log('engines =', JSON.stringify(r.engines));
console.log('codebuddyVersion =', r.codebuddyVersion);
console.log('levelsStatus.codebuddy =', r.levelsStatus?.codebuddy);
console.log('codebuddy 通道数 =', cb.length);
for (const c of cb) {
  console.log(`  ${c.id}  name=${c.name}  levels=${(c.thinkingLevels ?? []).join('|')}  scope=${c.thinkingLevelsScope ?? '-'}  enabled=${c.enabled}`);
}
console.log('\n引擎发现详情：');
for (const [k, v] of Object.entries(r.engineDetail ?? {})) {
  console.log(`  ${k}: found=${v.found} version=${v.version} loggedIn=${v.loggedIn}`);
}
console.log('\nwarnings:');
for (const w of r.warnings ?? []) console.log('  -', w);

rmSync(dir, { recursive: true, force: true });
