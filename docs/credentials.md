# 凭据与报 401 怎么办

> 本文是 [README](../README.md) 中「⚠️ 报『身份验证失败 / 401』」一节的展开。

## 插件自己不存凭据

插件**不自己存凭据**，而是读 ZCode 自己的 `~/.zcode/v2/config.json`
（`provider["builtin:bigmodel-coding-plan"].options.apiKey`）—— 与 ZCode CLI 同源。

## 已知上游缺陷

**ZCode 在 OAuth 重新登录后，把新 Key 只写进加密凭据库 `credentials.json`、
不回写 `config.json`**，导致 `config.json` 里留着**失效的旧 Key**
⇒ 一切读它的程序集体 **401**（**连 `zcode.cjs -p …` 也一样**）。

## 处理办法：把有效 Key 保存（写回）到 `config.json`

一次修好所有工具：

1. 从 `credentials.json` 解出有效 Key（`enc:v1` = AES-256-GCM，密钥 `sha256(secret)`）；
2. **先验活** —— ⚠️ 网关对**失效 Key 也返回 HTTP 200**，body 却是
   `{"code":1000,"msg":"身份验证失败。","success":false}` ⇒ **不能只看状态码**；
3. **备份** `config.json`，把有效 Key 填回 `options.apiKey`；回读校验。

## 现成工具

详细步骤、解密参考实现、验活判定代码与完整踩坑记录见
[`dispatch/README.md` 的「凭据从哪来 + 报 401 怎么办」一节](../dispatch/README.md#️-凭据从哪来--报身份验证失败--401-怎么办)。

现成恢复工具见姊妹项目 [`dsh-connect-zcode`](https://github.com/Shuffle-1992/dsh-connect-zcode)
的 `scripts/sync-key-to-config.mjs`（自动备份 + 验活 + 原子替换 + 回读校验）。
