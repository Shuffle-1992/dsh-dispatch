# ZB-28b 交付：修「派发台开始工作时不显示状态灯，切换会话后才显示」

> 用户报告（2026-10-07，附截图）：入口的任务状态灯（ZB-27w 的 activity dot）在派发台开始工作后
> 不出现；切换一次会话后才显示。要求先查问题；派发台当时正在跑任务，不影响就直接修。
> 结论：**缺陷只在 client.js（浏览器半边）**，宿主/派发核心/正在运行的 job 完全不受影响 ——
> 已直接修复，刷新页面即生效。本轮编号 ZB-28b（接 ZB-28）。

---

## 一、根因（两处叠加的引用计数缺陷，均在 `client.js` 共享 wire 层）

背景：入口与面板共用**一条模块级共享 wire**（ZB-27w 单例 + 引用计数），1s 轮询快照；
入口的活动图标读 `snapshot.counts`。逐帧推演（旧代码）：

1. **入口挂载**：acquire W0（此帧 remote 未就绪 ⇒ 降级 wire），refs=1。
2. **remote 就绪** → `invalidateSharedWire()`（dispose W0、置空）+ epoch bump → 重建。
   旧代码在 **render 期 `releaseSharedWire()`（无参）一次**，**effect 清理又 release 一次**
   —— 同一次消费被放两遍，refs 从 1 漏到 0；而第二次 release 落地时 `SHARED_WIRE` 已经是
   **新 wire W1**，无参 release 的处决判据只看计数（`refs===0 && SHARED_WIRE`）不看归属 ⇒
   **W1 当场被 dispose**（subs.clear + 停轮询）。入口靠 subscribe 的即时 tick「复活」了 W1
   （重新订阅 + 重启定时器），于是此刻一切正常 —— 但 **refs 永久停在 0**。
3. **用户开/关一次面板**（任何 acquire+release 对）：面板 release 时 refs 1→0 ⇒
   命中 `refs===0 && SHARED_WIRE===W1` ⇒ **把入口还订阅着的 live wire 处决掉**。
   入口的回调在 `subs.clear()` 里被抹掉、定时器被停 ⇒ 入口从此收不到任何快照，
   **状态灯冻结**。（面板自己不受影响：下次挂载 acquire 时 `SHARED_WIRE` 已是 null，
   会建一条新 wire —— 所以「面板好用、入口冻结」。）
4. **切换会话** → 入口重挂载 → acquire 时 current 为 null → 建全新 wire → **灯立刻出现**。
   与截图症状逐点吻合。

缺陷 ②（同族竞态，一并修）：`onRemoteReady` 的 waiter 若**注册晚于** `markRemoteReady`
触发（就绪恰好落在「render 建线」与「effect 注册」之间的瞬间），该消费者的 epoch 永远
不 bump —— 手里永远停在降级 wire。

## 二、修法（`zcode-dispatch/client.js`）

| 改动 | 位置 | 内容 |
|---|---|---|
| **配对释放** | `createSharedWireRegistry()`（:1544 起，新工厂） | `release(wire)` 必须**指名**自己 acquire 到的那条；处决守卫 = `refs===0 && current===wire` —— 已退役的旧引用与别人的 wire 一律不动；另暴露 `peek()` 供回调守卫 |
| **一次消费一放** | `useWire()` | render 期**只 acquire**（`ref.current = { wire, epoch }`）；旧 wire 由订阅 effect 的清理**单点释放**（`releaseSharedWire(wire)`，闭包持有自己那条）。无参 `releaseSharedWire()` 全包绝迹 |
| **REMOTE_READY 补投** | `markRemoteReady` / `onRemoteReady` | 旗标已立时，晚注册的 waiter **立即触发一次** —— 不再有「永远停在降级 wire」的消费者 |
| **peek 守卫** | useWire 的就绪回调 | 当前 wire 已是 `remote` 时**不**作废（否则后挂载消费者的补投会把别人手上的 live wire 处决掉——那正是本轮事故形态）；只有还是降级 wire 才 invalidate 重建 |
| **kind 标签** | 五种 wire | `remote/ext/offline/demo/dead`（peek 守卫的判据） |
| 同步测试基线 | `test/header-entry.test.mjs` D6-D9 | 原断言钉的是**旧实现形状**（无参 release / SHARED_WIRE 字面量），改钉新契约（工厂 + 配对 + 指名释放） |

## 三、测试与验收

- **新增 `test/shared-wire-liveness.test.mjs`（18 项）**：
  - A 组**功能重放**：用花括号配平扫描取出 client.js 里 `createSharedWireRegistry` 的真实源码，
    `new Function` 实例化后逐帧重放事故序列 —— 核心断言：
    「重建期的旧 wire 释放**不得处决新 wire**」「**面板开→关不得处决入口正持有的 wire**」「最后一个持有者释放才 dispose（恰好一次）」「放回已退役引用不得连带处决当前 wire」。
    （注：第一版修复曾被本测试的红灯抓出「render 期 release + cleanup 再 release」仍是双放 ——
    计数漏洞由断言逼出后改为『render 只 acquire、清理单点释放』的最终形态。）
  - B 组源码不变量：配对守卫、无参调用绝迹、render 只 acquire、REMOTE_READY 补投、peek 守卫、kind 标签。
- `test/header-entry.test.mjs` 98→**102** 项（D6-D9 改钉新契约 + D8b 指名释放）。
- **全量门禁**：23 个测试文件 **137 PASS / 0 FAIL**；`node --check client.js` 通过。

## 四、复现命令

```powershell
cd "F:\My Code\dsh-dispatch\zcode-dispatch"
node test/shared-wire-liveness.test.mjs        # 18 PASS / 0 FAIL
node test/header-entry.test.mjs                # 102 PASS / 0 FAIL
node --check client.js
# 全量：23 个测试文件，137 PASS / 0 FAIL
```

真机验收（用户操作）：刷新页面 → 打开一次派发台面板再关掉 → 派发一个任务 →
**不切换会话**，入口应在 1~2 秒内出现状态灯（queued 黄 / running 脉动）。

## 五、影响面与未确定项（宁缺毋编）

1. **影响面**：仅 `client.js`（浏览器半边）。宿主半边（index.js / wire.host.mjs / core / runner）
   本轮**零改动** —— 派发台当时正在跑的任务不受任何影响；**刷新页面即生效**（profile 装配是
   指向本仓库的 Junction，无需重启 DSH）。
2. **已知取舍（如实登记）**：remote 命名空间「退役后以新实例重挂」的极端场景（≈宿主半边
   热重载且页面不刷新）下，peek 守卫会跳过作废、沿用旧 wire —— 调用会失败并显示错误态，
   刷新页面即恢复。旧代码在此场景会重建新 wire，但代价正是本轮修的事故形态；二者取其轻。
3. **未确定项**：用户现场触发路径是推演 + 测试重放证实的（面板开→关是常见操作，与本轮
   「 sometime 不显示」的偶发性吻合）；未在真机抓到旧代码的实时现场（缺陷已在源码层面消除，
   无法再复现旧路径）。若刷新后仍偶发，下一个观察点是浏览器 console 的
   `[zcode-dispatch] 远端面未就绪 → 降级 wire。诊断=` 一行（ZB-01 内置诊断）。
