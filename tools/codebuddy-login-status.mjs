/**
 * 查询 WorkBuddy **账号登录态**（配合 codebuddy-login-link.mjs 常驻的 `--serve` 服务）。
 *
 * 用法：node tools/codebuddy-login-status.mjs [--port 19123]
 *
 * ⚠️ 两个 authenticated 不是一回事（真机实测，别混）：
 *   · GET /api/v1/auth/status           → **本地 Web UI 密码认证**（豁免路径）
 *   · GET /api/v1/auth/account/status   → **WorkBuddy 账号登录态**（本脚本查的是这个）
 * 且实测：账号态 authenticated=true 时，无头 `-p` **仍可能**报未登录 ⇒ 以真实执行为准。
 */
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 19123;

/** 从 `--serve` 启动日志里找 password？本脚本不启动服务，只连既有服务。
 *  ⇒ 密码从环境变量传（DSP_WB_PASSWORD），或用 `--password`。 */
const passArg = argv.indexOf('--password');
const PASSWORD = passArg >= 0 ? String(argv[passArg + 1]) : String(process.env.DSP_WB_PASSWORD ?? '');

function call(path, { method = 'GET', body, token } = {}) {
  return new Promise((done) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { 'X-CodeBuddy-Request': '1', Accept: 'application/json' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(payload.length); }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = httpRequest({ host: '127.0.0.1', port: PORT, path, method, headers, timeout: 10000 }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { t += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* 非 JSON */ } done({ status: res.statusCode, json: j, text: t }); });
    });
    req.on('error', (e) => done({ status: null, json: null, text: String(e?.message ?? e) }));
    req.on('timeout', () => { try { req.destroy(); } catch { /* 尽力 */ } done({ status: null, json: null, text: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/* 已登录过的服务通常可直接凭 password 换 token；没给 password 就只报告"连不上/需要密码"。 */
let token = null;
if (PASSWORD) {
  const a1 = await call('/api/v1/auth/login', { method: 'POST', body: { password: PASSWORD } });
  token = a1.json?.token ?? null;
  if (!token) console.log(`本地密码认证失败（${a1.status}）：${String(a1.text).slice(0, 160)}`);
}

const url = token ? '/api/v1/auth/account/status' : '/api/v1/auth/status';
const r = await call(url, { token });
const data = r.json?.data ?? r.json ?? null;
console.log(`GET ${url} → ${r.status}`);
console.log(JSON.stringify(data, null, 2));

/* 顺带看一眼 CLI 层是否真的能用了（**以真实执行路径为准**，这是唯一可信的判据）。 */
const probe = spawnSync(process.execPath, [
  new URL('../collab-kit/codebuddy-run.mjs', import.meta.url).pathname.replace(/^\//, '').replace(/%20/g, ' '),
  '--prompt', '只回复 OK', '--timeout-min', '1',
], { encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env } });
const out = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
const authFail = /Authentication required|Please use \/login/i.test(out);
console.log('');
console.log(`CLI 真实执行探测：exit=${probe.status} ${authFail ? '❌ 仍报未登录（账号态 ≠ CLI 可用）' : '✅ 未报未登录'}`);
if (authFail) console.log('  ⇒ 请确认浏览器里的登录确实完成（那个 authUrl 是一次性的，过期需重新生成）');
