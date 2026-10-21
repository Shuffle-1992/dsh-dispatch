/**
 * 给用户一条**可点的 WorkBuddy 登录链接**（不依赖插件 UI）。
 *
 * 为什么需要它：`/login` 是 CLI 界面里的斜杠命令（shell 里敲会报"无法识别"），
 * 而 CLI 无参数启动在非 TTY 下静默退出。唯一稳的路是官方 `--serve` + REST。
 * 插件详情页的「登录」按钮走的也是这条链路，但**客户端包要在 DSH 启动时加载**，
 * 改了客户端代码必须重启 DSH 才生效 —— 这个脚本让你立刻就能登录。
 *
 * 用法：node tools/codebuddy-login-link.mjs [--port 19123]
 * 行为：后台常驻一个 `codebuddy --serve`（进程脱离本脚本存活），打印登录链接后退出。
 *       登录完成后可运行 `node tools/codebuddy-login-status.mjs --port <同端口>` 查状态。
 */
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 19123;

const runner = fileURLToPath(new URL('../collab-kit/codebuddy-run.mjs', import.meta.url));

/* 1) 以 detached 方式起执行器的 --login-serve（父进程退出后它继续跑）。 */
const child = spawn(process.execPath, [runner, '--login-serve', '--port', String(PORT)], {
  detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env },
});
child.unref();

let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => { buf += c; });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => { buf += c; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let password = null;
for (let i = 0; i < 60 && !password; i += 1) {
  await sleep(500);
  const m = buf.match(/login-serve port=(\d+) password=(\S+)/);
  if (m) password = m[2];
}
if (!password) {
  console.error('登录服务未就绪（30s 内没拿到 password）。输出：\n' + buf.slice(0, 800));
  process.exit(1);
}

/** 极简 HTTP（必须带 X-CodeBuddy-Request: 1，否则 403）。 */
function call(path, { method = 'GET', body, token } = {}) {
  return new Promise((done) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { 'X-CodeBuddy-Request': '1', Accept: 'application/json' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(payload.length); }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = httpRequest({ host: '127.0.0.1', port: PORT, path, method, headers, timeout: 15000 }, (res) => {
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

const a1 = await call('/api/v1/auth/login', { method: 'POST', body: { password } });
const token = a1.json?.token ?? null;
if (!token) { console.error(`本地密码认证失败（${a1.status}）：${String(a1.text).slice(0, 200)}`); process.exit(1); }

const a2 = await call('/api/v1/auth/account/login', { method: 'POST', body: {}, token });
const authUrl = a2.json?.data?.authUrl ?? a2.json?.authUrl ?? null;
const st = await call('/api/v1/auth/account/status', { token });
const sd = st.json?.data ?? st.json ?? {};

console.log('');
console.log('════════════════════════════════════════════════════════════');
console.log(' ① 在浏览器打开这个链接完成 WorkBuddy 登录（一次性）：');
console.log(`    ${authUrl ?? '(未取到 authUrl，请改用下面的 Web UI)'}`);
console.log('');
console.log(' ② 或直接打开带密码的 Web UI（在网页里登录）：');
console.log(`    http://127.0.0.1:${PORT}/?password=${encodeURIComponent(password)}`);
console.log('');
console.log(` 当前账号态：authenticated=${!!sd.authenticated}${sd.account?.userId ? `，userId=${sd.account.userId}` : ''}`);
console.log(` 登录服务端口：${PORT}（已后台常驻；不需要时用工具/脚本 stop，或结束该 node 进程）`);
console.log('════════════════════════════════════════════════════════════');
process.exit(0);
