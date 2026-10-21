/**
 * 真机验证（ZB-87 收尾）：**不注入任何探测替身**，看 `listChannels()` 到底有没有
 * 返回 `engineDetail`（客户端登录条的唯一数据源：`engineDetail.codebuddy`）。
 *
 * 为什么要这个脚本：`tools/verify-codebuddy-channels.mjs` 为了不真跑 ZCode 会注入
 * `channelsProbeImpl`，而注入会让 core 的 `discoveryEnabled=false` ⇒ `engineDetail` 为 null
 * ⇒ 那个脚本**测不出**登录条能否渲染。这里用真实 runner 路径跑一次真实探测。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../dispatch/core/dispatch-core.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dsp-engdet-'));
const d = createDispatcher({
  /* 真实 ZCode 执行器（存在即可 ⇒ core 的 discoveryEnabled 保持 true） */
  runnerPath: fileURLToPath(new URL('../collab-kit/zcode-run.mjs', import.meta.url)),
  opencodeRunnerPath: '',
  qoderRunnerPath: '',
  codebuddyRunnerPath: fileURLToPath(new URL('../collab-kit/codebuddy-run.mjs', import.meta.url)),
  workRoot: dir,
});

const t0 = Date.now();
const r = await d.listChannels();
console.log(`listChannels 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('engineDetail 是否存在:', r.engineDetail != null);
if (r.engineDetail) {
  for (const [k, v] of Object.entries(r.engineDetail)) {
    console.log(`  ${k}: found=${v.found} version=${v.version} loggedIn=${v.loggedIn} form=${v.form}`);
  }
  console.log('\n★ 登录条判据 engineDetail.codebuddy 存在:', !!r.engineDetail.codebuddy);
} else {
  console.log('❌ engineDetail 为 null ⇒ 客户端 EngineLoginBar 会 return null（按钮不渲染）');
}
console.log('\nwarnings:');
for (const w of r.warnings ?? []) console.log('  -', String(w).slice(0, 160));

rmSync(dir, { recursive: true, force: true });
