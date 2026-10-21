/**
 * 真机验证（ZB-87）：面板「登录 WorkBuddy」按钮背后的整条链路。
 *   dispatcher.startCodebuddyLogin() → 执行器 --login-serve → 官方 codebuddy --serve
 *   → POST /api/v1/auth/login（本地密码认证）→ POST /api/v1/auth/account/login → **authUrl**
 *   → codebuddyLoginStatus() 查账号态 → stopCodebuddyLogin() 收尾（不留孤儿进程）
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../dispatch/core/dispatch-core.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dsp-zb87-'));
const noop = join(dir, 'noop.mjs');
writeFileSync(noop, 'process.exit(0);\n', 'utf8');

const d = createDispatcher({
  runnerPath: noop,
  opencodeRunnerPath: '',
  qoderRunnerPath: '',
  codebuddyRunnerPath: fileURLToPath(new URL('../collab-kit/codebuddy-run.mjs', import.meta.url)),
  workRoot: dir,
  channelsProbeImpl: async () => ['id'.padEnd(34) + 'enabled   端点/模型', 'builtin:bigmodel-coding-plan'.padEnd(34) + 'true      https://x | GLM-5.3'].join('\n'),
  zcodeConfigPath: join(dir, 'no-config.json'),
  planCachePath: join(dir, 'no-cache.json'),
  personalProviderPath: join(dir, 'no-personal.json'),
});

console.log('=== 1) start：起登录服务并取登录链接 ===');
const t0 = Date.now();
const r = await d.startCodebuddyLogin();
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(JSON.stringify({
  ok: r.ok, port: r.port, authenticated: r.authenticated,
  hasAuthUrl: !!r.authUrl, authUrl: r.authUrl,
  webui: r.webui ? r.webui.replace(/password=[^&]+/, 'password=***') : null,
  account: r.account, error: r.error,
}, null, 2));

console.log('\n=== 2) status：查账号登录态 ===');
const st = await d.codebuddyLoginStatus();
console.log(JSON.stringify({
  ok: st.ok, authenticated: st.authenticated, account: st.account, error: st.error,
}, null, 2));

console.log('\n=== 3) stop：关掉服务 ===');
console.log(JSON.stringify(d.stopCodebuddyLogin()));
console.log('幂等再停一次:', JSON.stringify(d.stopCodebuddyLogin()));

rmSync(dir, { recursive: true, force: true });
