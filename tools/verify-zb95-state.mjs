/** ZB-95 真机验证：listChannels 的 engineDetail 是否带上只读登录产物诊断（codebuddyAuth）。 */
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatcher } from '../dispatch/core/dispatch-core.mjs';

const d = createDispatcher({
  runnerPath: fileURLToPath(new URL('../collab-kit/zcode-run.mjs', import.meta.url)),
  opencodeRunnerPath: '',
  qoderRunnerPath: '',
  codebuddyRunnerPath: fileURLToPath(new URL('../collab-kit/codebuddy-run.mjs', import.meta.url)),
  workRoot: mkdtempSync(join(tmpdir(), 'dsp-zb95-')),
});

const t0 = Date.now();
const ch = await d.listChannels();
const ed = ch.engineDetail ?? {};
console.log(`listChannels ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('engineDetail keys:', Object.keys(ed).join(', '));
const auth = ed.codebuddyAuth;
console.log('codebuddyAuth =', JSON.stringify(auth, null, 2));
console.log('codebuddy.loggedIn =', ed.codebuddy ? ed.codebuddy.loggedIn : '(无)');

/* 判据：三态能否算出来（客户端就是按这个优先级显示：残留 > 已登录 > 未登录 > 未知） */
const residue = !!(auth && auth.hasResidue);
const engineState = ed.codebuddy && ed.codebuddy.loggedIn;
const kind = residue ? 'residue' : engineState === true ? 'authed' : engineState === false ? 'notAuthed' : 'unknown';
console.log(`\n★ 面板将显示：${kind}`);

const okAll = !!auth && Array.isArray(auth.markers) && Array.isArray(auth.liveCredentials) && typeof auth.hasResidue === 'boolean';
console.log(okAll ? '✓ codebuddyAuth 形状正确（markers/liveCredentials/hasResidue 齐）' : '✗ codebuddyAuth 缺失或形状不对');
process.exitCode = okAll ? 0 : 1;
