// Z4 校验脚本：client.js 引用的主题令牌 vs dsh-client-ui-theme 权威令牌集 的双向差集。
// 证据来源：refs/extracted/dsh-client-ui-theme/lib/client.js（从 app.asar 提取，
// 含 body/body[data-ds-dark-theme] 权威调色板与 :root 字体、gradient-shadow 定义）。
// 用法：node test/z4-token-check.mjs   （在 dispatch 目录下；退出码 0 = 全部存在）
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = readFileSync(join(here, '..', 'client.js'), 'utf8');
const themeSrc = readFileSync(join(here, '..', '..', 'refs', 'extracted', 'dsh-client-ui-theme', 'lib', 'client.js'), 'utf8');

// 主题包：有「定义」（token 后跟冒号）的令牌 + 出现过的全部 alias 令牌（并集 = 存在集）
const defined = new Set([...themeSrc.matchAll(/--ds(?:w)?-[a-z0-9-]+\s*:/g)].map((m) => m[0].replace(/\s*:$/, '')));
const aliasSeen = new Set([...themeSrc.matchAll(/--dsw-alias-[a-z0-9-]+/g)].map((m) => m[0]));
const exists = (t) => defined.has(t) || aliasSeen.has(t);

// 插件 client.js：只统计 var( 里的真实引用（排除注释里的通配写法 --dsw-alias-bg-layer-*）
const refs = [...new Set([...clientSrc.matchAll(/var\((--ds(?:w)?-[a-z0-9-]+)/g)].map((m) => m[1]))];
const missing = refs.filter((t) => !exists(t));

console.log(`client.js var() 引用令牌（去重）: ${refs.length}`);
for (const t of refs) console.log(`  ${exists(t) ? 'OK ' : 'MISS'}  ${t}`);
const aliasRefs = refs.filter((t) => t.startsWith('--dsw-alias-'));
const unusedAlias = [...aliasSeen].filter((t) => !refs.includes(t));
console.log(`\n引用但主题包不存在: ${missing.length} 个${missing.length ? '\n  ' + missing.join('\n  ') : ' ✓'}`);
console.log(`其中 --dsw-alias-* 引用: ${aliasRefs.length} 个；主题包 alias 全集 ${aliasSeen.size} 个，插件未使用 ${unusedAlias.length} 个（存在但没用，可选项）`);
process.exit(missing.length ? 1 : 0);
