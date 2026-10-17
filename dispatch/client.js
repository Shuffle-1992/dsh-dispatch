/**
 * dsh-dispatch —— Client 半边：DSH Web 页面里的「DSH 派发台」悬浮窗。
 * 纯 JS + React.createElement（无构建 / 无 JSX / 无 npm 依赖）；唯一外部模块为 react（经宿主模块表注入）。
 *
 * 行为：右下角贴边悬浮窗，标题栏可拖拽（pointer events），可折叠，可最小化为圆角小胶囊；
 * 位置/尺寸/折叠态存 localStorage（key 带插件前缀）。五个分区均可折叠（通道/派发/单写者
 * 默认收起，进程/用量默认展开，折叠态存 localStorage）：通道（切换器+降级链）/ 派发栏 /
 * 进程列表（行头点击展开派发要素；paused 暂停态带同通道续跑/换通道交接重跑/关闭）/
 * 用量卡片 / 单写者状态。
 * 样式仅走主题令牌（--dsw-alias-* / --dsw-shadow-* / --ds-font-family-code，集中在 TOKENS 常量，
 * 见下），不 import 任何 DSH 宿主客户端包，不碰宿主 body 节点，卸载时清理监听器与定时器。
 *
 * Z6 语义（用户可见口径）：**换通道=交接重跑**——新开会话，把原任务与中断点交接过去；
 * 同通道且有会话才是原会话续跑（--resume，不带 --model）。不可用通道只如实标注，不假装能切。
 *
 * 接线状态（Z8 全接通）：本模块在 apply 里用官方公开 API ctx.remote.$mount() 挂载
 * remote.dispatch 子服务（描述符与 wire.client.mjs 的 TYPERT_REMOTE 同源），
 * 内嵌同源远端传输层调用 ctx.remote.dispatch.<方法>()。宿主侧 face 已注册为
 * cordis 服务（wire.host.mjs，ctx.provide + exports["./typert"] 经 typert-loader 注册）。
 * 远端缺席/挂载失败时逐级回退：window 外部数据源 → 诚实空态（offline），绝不白屏；
 * 内置 demo 引擎默认不启用（Z11：仅当 window.__dispatchDemo === 'builtin' 时使用，便于排查）。
 *
 * 真数据 vs demo 判据（面板标题栏徽标，connLabel）：
 * - 「已连接」（conn='live'）：数据来自 ctx.remote.dispatch 远端面——真 ZCode
 *   子进程与真用量台账（宿主 face 已注册时才有）；
 * - 「外部数据」（conn='ext'）：window.__dispatchDemo 注入的外部数据源；
 * - 「演示数据」（conn='demo'）：内置演示引擎（纯前端假数据，需显式 'builtin' 开启）；
 * - 「未连接」（conn='offline'）：远端与外部源都没有——诚实空态，不渲染任何假行；
 * - 「连接中」：尚未收到任何数据包（连接建立前的一次渲染）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dispatch',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useLayoutEffect } = React;

    /* ─────────────── 槽位 ───────────────
     * `shell.overlay` 已从客户端 bundle 实证存在（详见 refs/dsh-slots.md）：
     * 声明于 dsh-client-ui-layout 的 root children 表 { kind:'list', scope:'root' }，
     * 由 AppFrame 渲染进专用 overlayLayer 图层；chat / plugin-manager / workspace
     * 三个官方包共 6 处先例都注册在此（list 型 → 注册必须带 id，order 参与排序）。
     *
     * ZB-60（兼容性加固）：它现在是**主入口的备用槽位** —— 只有会话标题行槽位（HEADER_SLOT）
     * 在 DSH 升级后改名/删除、注册不上时才启用（右下角浮层入口）。
     * ⚠️ 绝不与主入口**同时**注册（ZB-27 已否决"两份 UI 让人分不清哪个才是派发台"）。 */
    const FALLBACK_SLOT = 'shell.overlay';
    /** 主槽位"始终未声明"的宽限：正常启动是毫秒级同步就绪；只有升级改名才会等到 2s 后降级。 */
    const SLOT_GRACE_MS = 2000;
    /* ─────────────── ZB-24：会话标题行入口 ───────────────
     * 用户要求（2026-10-05）：「把派发台改成与子智能体一样的位置，在那一行显示 DSH 派发台，
     * 点击弹出面板」—— 即**别只靠右下角悬浮窗**，要在会话标题行（「对话|轨迹」那一行的右侧）
     * 有一枚入口胶囊。
     *
     * 槽位由活体 Inspect 实证（`cordis_inspect_query` client/Slots，requestedRoot 查占用者）：
     * `conversation.session.header.actions`（list / session 作用域），现有占用者
     * `subagent-catalog`(-30) / `agent-team`(-20) / `agent-preset`(-10) / `job-list`(20)
     * —— 正是用户截图里的「N 个子智能体 / 智能体团队 / 创造模式 / 后台任务」。
     * 我们取 order 10：排在 agent-preset 之后、DSH 自带「后台任务」之前。 */
    const HEADER_SLOT = 'conversation.session.header.actions';

    /* ZB-53（用户真机反馈「插件详情页没有配置区」）：**bundle 自己的配置槽位**。
     * 契约（DSH 运行时 Slot 树）：`plugins.bundle.config` —— keyed / scope: root，
     * 按 **bundle 的包名**派发，渲染在 bundle 详情页「描述与条目之间」（`view: 'page'`）。
     * 本地参照插件 dsh-connect-zcode 就是这么注册的 ⇒ 我们的 key 必须是包名 `dsh-dispatch`。 */
    const BUNDLE_CONFIG_SLOT = 'plugins.bundle.config';
    const BUNDLE_CONFIG_KEY = 'dsh-dispatch';

    /* ── D1：`dispatch` 工具调用的**会话内专属卡片**（DSH 0.2.1 新增的 keyed 槽位）──
     * 契约（已对 DSH 0.2.1-rc.2 的 ui-tool 源码逐行核实，别凭记忆改）：
     *   ui-tool 的 `ToolCall` 把 owner = `{callId, toolName, phase, block, openFile, cwd, home,
     *   loadImage, useDisclosure, inspect}` 交给
     *   `renderSlot('tool.call.toolview', owner, { entryKey: toolName, fallback: 通用卡片 })`
     *   —— **命中 key ⇒ 替换通用卡片**；键写错就永不命中（回落 fallback 通用卡片，不会白屏）。
     * 本插件在 index.js 里用 `defineTool({ name: 'dispatch' })` 注册工具 ⇒ key 取工具名 `dispatch`。
     * 活体目录原文：「Any name is allowed, including tools registered by your package.
     * Register with key: '<tool name>'; a typo never renders.」 */
    const TOOLVIEW_SLOT = 'tool.call.toolview';
    const TOOLVIEW_KEY = 'dispatch';

    /* ZB-27：入口改为「点开即弹窗」后，ZB-24 那份**模块级共享状态 store 已不需要** ——
     * 弹窗内容（PanelBody）自己持 wire 并渲染实时数据，入口只是个开合开关（局部 useState）。
     * 原 store 的用途是"让另一个渲染器零网络成本显示计数徽标"，现在没有第二个渲染器了。 */

    /* Z11：分区折叠——id 常量集中一处（勿散落魔法字符串），折叠态存
     * localStorage['dispatch:section:<id>']（复用 loadJson/saveJson，自带 try/catch）。 */
    const SEC = { channel: 'channel', dispatch: 'dispatch', jobs: 'jobs', quota: 'quota', locks: 'locks' };
    const secKey = (id) => `dispatch:section:${id}`;
    // 默认展开/收起：通道与派发收起（少滚动）；进程与用量展开（主信息）；单写者收起
    const SEC_DEFAULT_OPEN = { [SEC.channel]: false, [SEC.jobs]: true, [SEC.quota]: true, [SEC.locks]: false }; // ZB-29c：派发分区已移除
    const WIDTH = { min: 320, max: 600, def: 440 };
    /* ZB-07：进程分组内默认只展开最近 N 条 —— 进程累计上限是 1000 条（JOBS_FILE_CAP），
     * 全量渲染会让面板变成一条几百行的长列表。其余折进「还有 N 条更早的」按钮。 */
    const JOB_GROUP_PREVIEW = 5;

    /* ─────────────── TOKENS：主题令牌唯一出口 ───────────────
     * 纪律：JS 内零字面色值（#…），全部走主题令牌；每个值带同族回退链，
     * 最终回退只允许 currentColor / transparent / inherit 等关键字。
     * 全部令牌名已与 dsh-client-ui-theme 的权威调色板逐一核对（差集与映射见
     * refs/dsh-theme-tokens.md）：文本族真名是 --dsw-alias-label-*，边框是
     * -border-l1..l4，状态色是 -state-*-primary，阴影是 --dsw-shadow-lv3，
     * 代码字体是 --ds-font-family-code（--ds- 前缀，非 --dsw-alias-）。 */
    const T = {
      bg: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, inherit))',
      bgBar: 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, inherit))',
      sunken: 'var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1, transparent))',
      hover: 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3, transparent))',
      accent: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, currentColor))',
      onAccent: 'var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-1, inherit))',
      border: 'var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, transparent))',
      shadow: 'var(--dsw-shadow-lv3, 0 10px 28px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.10))',
      text: 'var(--dsw-alias-label-primary, currentColor)',
      text2: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary, currentColor))',
      text3: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor))',
      danger: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary, currentColor))',
      mono: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace)',
      // 六态状态点（回退链保证降级可见；状态色族真名 --dsw-alias-state-*-primary）
      stQueued: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor))',
      stRunning: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary, currentColor))',
      stDone: 'var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary, currentColor))',
      stFailed: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary, currentColor))',
      stKilled: 'var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-primary, currentColor))',
      stInterrupted: 'var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-tertiary, currentColor))',
      stIdle: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor))',
      // Z6：paused 状态点用 warn-secondary（与 killed 的 warn-primary 区分），原因徽章用 warn-label
      stPaused: 'var(--dsw-alias-state-warn-secondary, var(--dsw-alias-state-warn-primary, currentColor))',
      warnLabel: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary, currentColor))',
    };

    /* 样式：作为 React 元素渲染进组件树，组件卸载即随之移除（不碰全局样式表）。 */
    const CSS = [
      /* ZB-27：本插件不再往 shell.overlay 放东西（浮窗与最小化胶囊已取消），
       * 全部样式作用域收敛到悬浮弹窗 `.dsp-menu` 子树内 —— 不碰宿主 shell，也不碰应用其他区域。 */
      /* ZB-17：本面板子树统一 border-box。此前全文件**没有任何 box-sizing 规则**，
       * 而 `.dsp-ta{width:100%}` 同时带 `padding:5px 8px` + `border:1px` ⇒ 默认 content-box 下
       * 实际宽度 = 100% + 18px，输入框必然冲出右边界（用户报告）。
       * 顺带消除同类隐患（所有带 padding 的 select/input/card 都受影响）。 */
      '.dsp-menu,.dsp-menu *{box-sizing:border-box;}',
      '.dsp-conn{flex:none;font-size:10px;line-height:15px;padding:1px 7px;border:1px solid ' + T.border + ';border-radius:8px;color:' + T.text2 + ';}',
      // Z12 派发总开关徽标：非 live=只读 span；live=可点 button（hover 反馈，busy 半透明）
      '.dsp-switch{display:inline-flex;align-items:center;gap:4px;}',
      '.dsp-switch .dsp-dot{width:6px;height:6px;}',
      'button.dsp-switch{background:transparent;font:inherit;cursor:pointer;transition:background-color .15s ease,color .15s ease;}',
      'button.dsp-switch:hover{background:' + T.hover + ';color:' + T.text + ';}',
      'button.dsp-switch:disabled{opacity:.5;cursor:default;}',
      /* ZB-27y（用户要求「派发开关按钮小些，与右侧已连接高度一致」）：
       * `button.dsp-switch{font:inherit}` 会把字号重置为继承值（≈13-14px）并压过 `.dsp-conn` 的
       * 10px ⇒ 开关徽标比「已连接」高。此条特异性更高（0,2,1）且排在后面：字号/行高与 .dsp-conn
       * 完全一致（10px/1.7 ⇒ 同高），横向再收 2px（1px 5px）让它整体更小巧。 */
      'button.dsp-conn.dsp-switch{font-size:10px;line-height:15px;padding:1px 5px;border-radius:8px;}',
      '.dsp-body{display:flex;flex-direction:column;gap:10px;padding:10px;overflow:auto;min-height:0;overscroll-behavior:contain;}',
      /* ZB-16：**分区内部**的纵向节奏容器。此前 ChannelSection / QuotaCards 的根是
       * `h('div', null, …)` —— 没有 class、没有 gap，于是 `.dsp-sec` 的 gap 完全管不到它们内部，
       * 两个下拉、说明文字全贴在一起（用户报告「2 个下拉框挨一起了」）。
       * DispatchBar 的 `.dsp-dispatch` 更彻底：连 CSS 规则都不存在。统一走这个 stack。 */
      '.dsp-stack{display:flex;flex-direction:column;gap:10px;min-width:0;}',
      '.dsp-dispatch{display:flex;flex-direction:column;gap:10px;min-width:0;}',
      '.dsp-sec{display:flex;flex-direction:column;gap:9px;padding:10px;border:1px solid ' + T.border + ';border-radius:8px;min-width:0;}',
      '.dsp-sec-title{font-size:11px;line-height:16px;font-weight:600;letter-spacing:.02em;color:' + T.text2 + ';}',
      // Z11 可折叠分区：整条标题栏可点击切换（含 hover/键盘焦点态与倒三角指示）
      '.dsp-sec-head{display:flex;align-items:center;gap:8px;min-height:22px;cursor:pointer;user-select:none;-webkit-user-select:none;border-radius:4px;transition:background-color .15s ease;}',
      '.dsp-sec-head:hover{background:' + T.hover + ';}',
      '.dsp-sec-head:focus-visible{outline:1px solid ' + T.text3 + ';outline-offset:2px;}',
      '.dsp-sec-caret{flex:none;display:inline-flex;color:' + T.text3 + ';}',
      '.dsp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.dsp-label{color:' + T.text2 + ';white-space:nowrap;}',
      /* ZB-14：通道/模型的固定两行表单（标签 + 下拉）。刻意**不换行**：
       * flex-wrap 会让 4 个元素随面板宽度改行，两个下拉的宽度又各随内容变 —— 版式就"乱跑"了。
       * 标签 nowrap 取自然宽；下拉 flex:1 且 min-width:0（否则 select 不会缩到内容宽以下而撑破行）。 */
      '.dsp-field{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;}',
      '.dsp-field-k{flex:none;white-space:nowrap;color:' + T.text2 + ';}',
      '.dsp-field-v{flex:1 1 auto;min-width:0;}',
      '.dsp-select,.dsp-input,.dsp-ta{background:' + T.sunken + ';color:' + T.text + ';border:1px solid ' + T.border + ';border-radius:6px;padding:5px 8px;font:inherit;outline:none;transition:border-color .15s ease;}',
      '.dsp-select:focus,.dsp-input:focus,.dsp-ta:focus{border-color:' + T.text3 + ';}',
      '.dsp-ta{width:100%;min-height:60px;resize:vertical;}',
      '.dsp-btn{display:inline-flex;align-items:center;padding:6px 16px;border:none;border-radius:6px;background:' + T.accent + ';color:' + T.onAccent + ';font:inherit;font-weight:600;cursor:pointer;transition:filter .15s ease,transform .05s ease;}',
      '.dsp-btn:hover{filter:brightness(1.08);}',
      '.dsp-btn:active{transform:translateY(1px);}',
      '.dsp-btn:disabled{opacity:.5;cursor:default;}',
      '.dsp-feedback{min-height:18px;font-size:11px;line-height:16px;color:' + T.text2 + ';}',
      '.dsp-feedback.dsp-err{color:' + T.danger + ';}',
      '.dsp-jobs{display:flex;flex-direction:column;gap:8px;}',
      /* ZB-03：进程分组（进行中/需处理/异常/已完成）。分层用字号+缩进，不引入字面色值。 */
      '.dsp-group{display:flex;flex-direction:column;gap:8px;}',
      '.dsp-group-head{display:flex;align-items:center;gap:6px;margin-top:4px;font-size:11px;line-height:16px;font-weight:600;color:' + T.text3 + ';}',
      '.dsp-group-body{display:flex;flex-direction:column;gap:8px;padding-left:2px;}',
      /* ZB-09：进程状态分类改为 Tab 分页（不再把所有分组堆在同一页） */
      '.dsp-tabs{display:flex;gap:6px;flex-wrap:wrap;}',
      '.dsp-tab{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border:1px solid var(--dsp-border);border-radius:999px;background:transparent;color:var(--dsp-text3);font:inherit;font-size:11px;line-height:16px;cursor:pointer;transition:background-color .15s ease,color .15s ease,border-color .15s ease;}',
      '.dsp-tab:hover{background:var(--dsp-hover);color:var(--dsp-text);}',
      '.dsp-tab.dsp-tab-on{background:var(--dsp-hover);color:var(--dsp-text);border-color:var(--dsp-text3);}',
      '.dsp-tab-n{font-size:10px;opacity:.75;}',
      '.dsp-empty{color:' + T.text3 + ';}',
      /* ZB-16：行内也走容器 gap（原先靠各块自带 marginTop，头与反馈行之间是贴着的） */
      '.dsp-job{display:flex;flex-direction:column;gap:8px;border:1px solid ' + T.border + ';border-radius:6px;padding:7px 9px;}',
      '.dsp-job-head{display:flex;flex-direction:column;align-items:stretch;gap:2px;min-height:24px;}',
      '.dsp-job-line{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;}',
      /* ZB-70（用户要求）：行头改**三行** ——
       *   行1 = 状态灯 + 进程名（左）… 时间 + 退出（右）：`margin-right:auto` 把右组推到行尾；
       *   行2 = 引擎 + 模型 + 思考 + 权限 + 文件锁（**全部左对齐**，原先这里是 line2 右对齐）；
       *   行3 = 心跳/上下文（左对齐，11px 次要色）。 */
      '.dsp-job-line .dsp-job-tag{margin-right:auto;}',
      '.dsp-job-line2{justify-content:flex-start;}',
      '.dsp-job-line3{justify-content:flex-start;}',
      '.dsp-job-right{display:flex;align-items:center;gap:8px;flex:0 0 auto;}',
      /* 列表页脚：左侧「还有 N 条更早 / 收起」，右侧「清除所有」（仅非「进行中」页签出现）。 */
      '.dsp-jobs-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.dsp-jobs-foot-l{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}',
      '.dsp-clear{margin-left:auto;}',
      '.dsp-jobs-foot .dsp-note{margin:0;}',
      /* ZB-29b（用户要求）：进程名**尽可能显示完整** —— 去掉 110px 截断上限；
       * 空间实在不够（名字超过整行宽）才 ellipsis 兜底（右侧徽标会先折行让位）。 */
      '.dsp-job-tag{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:0;max-width:100%;}',
      '.dsp-dim{color:' + T.text3 + ';white-space:nowrap;font-size:10px;line-height:15px;}',
      '.dsp-spring{flex:1;}',
      '.dsp-badge{flex:none;font-size:10px;line-height:15px;padding:1px 5px;border:1px solid ' + T.border + ';border-radius:4px;color:' + T.text2 + ';white-space:nowrap;}',
      /* ZB-18：锁类型视觉区分（不引入字面色值，复用主题令牌）：
       *   整仓库锁 = 更"重"（实线边框 + 主文本色），文件锁 = 更"轻"（次要色），旧版记录 = 危险色提示。 */
      '.dsp-badge.dsp-lock-repo{color:' + T.text + ';border-color:' + T.text3 + ';}',
      '.dsp-badge.dsp-lock-file{color:' + T.text2 + ';}',
      '.dsp-badge.dsp-lock-legacy{color:' + T.danger + ';border-color:' + T.danger + ';}',
      '.dsp-dot{flex:none;width:8px;height:8px;border-radius:50%;background:' + T.stIdle + ';}',
      '.dsp-dot.s-queued{background:' + T.stQueued + ';}',
      '.dsp-dot.s-running{background:' + T.stRunning + ';animation:dsp-pulse 1.2s ease-in-out infinite;}',
      '.dsp-dot.s-done{background:' + T.stDone + ';}',
      '.dsp-dot.s-failed{background:' + T.stFailed + ';}',
      '.dsp-dot.s-killed{background:' + T.stKilled + ';}',
      '.dsp-dot.s-interrupted{background:' + T.stInterrupted + ';}',
      '.dsp-dot.s-paused{background:' + T.stPaused + ';animation:dsp-pulse 2.4s ease-in-out infinite;}',
      '.dsp-badge.s-paused{color:' + T.warnLabel + ';border-color:' + T.warnLabel + ';}',
      '.dsp-btn2{display:inline-flex;align-items:center;padding:4px 12px;border:1px solid ' + T.border + ';border-radius:6px;background:transparent;color:' + T.text2 + ';font:inherit;cursor:pointer;transition:background-color .15s ease,color .15s ease,border-color .15s ease;}',
      '.dsp-btn2:hover{background:' + T.hover + ';color:' + T.text + ';border-color:' + T.text3 + ';}',
      '.dsp-btn2:disabled{opacity:.45;cursor:default;}',
      '.dsp-btn2:active{transform:translateY(1px);}',
      '.dsp-note{font-size:11px;line-height:16px;color:' + T.text3 + ';white-space:normal;overflow-wrap:anywhere;}',
      '.dsp-chain{display:flex;align-items:center;gap:5px;flex-wrap:wrap;}',
      /* ZB-30：自动降级开关（与标题栏派发开关同一视觉语言：指示灯 + 文案；此处是**分区内的行**，
       * 故给按钮态 + hover/disabled 反馈，并允许它占满左侧（.dsp-spring 把状态徽标推到行尾）。 */
      '.dsp-toggle{flex:none;font-size:12px;line-height:17px;padding:2px 8px;border:1px solid ' + T.border + ';border-radius:8px;color:' + T.text2 + ';}',
      'button.dsp-toggle{background:transparent;font:inherit;cursor:pointer;transition:background-color .15s ease,color .15s ease,border-color .15s ease;}',
      'button.dsp-toggle:hover:not(:disabled){background:' + T.hover + ';color:' + T.text + ';border-color:' + T.text3 + ';}',
      'button.dsp-toggle:disabled{opacity:.5;cursor:default;}',
      '.dsp-tailwrap{margin-top:0;}',
      '.dsp-mono{max-height:160px;overflow:auto;font-size:11px;line-height:16px;padding:6px;background:' + T.sunken + ';border-radius:4px;font-family:' + T.mono + ';white-space:pre-wrap;word-break:break-all;}',
      '.dsp-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px;}',
      '.dsp-card{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding:8px;border:1px solid ' + T.border + ';border-radius:6px;}',
      '.dsp-card-title{font-size:10px;line-height:15px;font-weight:600;color:' + T.text2 + ';}',
      '.dsp-kv{display:flex;justify-content:space-between;gap:8px;font-size:11px;line-height:16px;min-width:0;}',
      '.dsp-kv-k{color:' + T.text3 + ';}',
      // Z11 行展开详情：子块容器 + 值列长值换行 + 行 hover 反馈（行头可点击展开）
      '.dsp-detail{display:flex;flex-direction:column;gap:5px;margin-top:6px;}',
      '.dsp-kv-v{overflow-wrap:anywhere;text-align:right;}',
      '.dsp-job{transition:border-color .15s ease;}',
      '.dsp-job:hover{border-color:' + T.text3 + ';}',
      '.dsp-job-head{cursor:pointer;}',
      '.dsp-planline{margin-top:4px;font-size:11px;line-height:16px;color:' + T.text3 + ';white-space:normal;overflow-wrap:anywhere;}',
      /* ── ZB-58（用户：「右侧的下拉框和排序按钮，还是没有完全对齐。…布局再细调整下」）──
       * 用户上一轮仍看到不齐，真因**不是**列宽，而是**盒子模型不一致**：↑↓ 按钮此前只带
       * `.dsp-btn2` 内联 24×24 —— 按钮默认 `box-sizing:content-box`（除非被 `.dsp-menu *` 命中），
       * 24px 是**内容盒**，加左右各 1px 边框后实际占 26px；下拉是 `border-box` 的 24px。
       * 两者高度差 2px、基线也差 1px，内联样式怎么写都对不齐（DOM 桩不跑真实样式表，所以看不出来）。
       * 本组规则是唯一权威：下拉与按钮 **同 22px 高 / 同 border-box / 同 1px 边框 / 同行高 22px**，
       * 列宽也全在类里（序号 20 / 档位 96→84 可缩 / 排序 56→50 可缩 / 模型 flex），
       * 列头用**同一批列宽类** ⇒ 头与行左边缘严格同线；窄容器只缩列不换行。 */
      '.dsp-seq-row{display:flex;align-items:center;gap:6px;min-height:26px;padding:1px 0;border-bottom:1px solid ' + T.border + ';min-width:0;}',
      '.dsp-seq-row:last-child{border-bottom:0;}',
      '.dsp-seq-row:hover{background:' + T.hover + ';}',
      '.dsp-seq-idx{flex:0 0 20px;text-align:right;font-size:11px;line-height:22px;color:' + T.text3 + ';}',
      /* ⚠️ 模型列必须 `flex:1 1 0`（basis **0**，不是 auto）—— 这是列头/行不漂移的关键：
       * basis:auto 时，列头「模型」二字的基线宽 ≈ 24px，而行里模型 id 有 ~220px，
       * 同一个 `flex-shrink:1` 在两处的**缩放系数 = shrink × base** 完全不同 ⇒ 窄容器下
       * 表头几乎不缩、行里的下拉/按钮缩了 18px，左右边缘就对不上了（ZB-58 真机实测 dx=18px）。
       * basis 0 后两行的四列基准完全相同（20 / 0 / 96 / 56），任何宽度下收缩量必然一致。 */
      '.dsp-seq-name{flex:1 1 0;min-width:0;font-family:' + T.mono + ';font-size:12px;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsp-seq-lv{flex:0 1 96px;min-width:84px;}',
      /* 下拉：与 .dsp-seq-move **同一盒子模型**（22px / border-box / 1px 边框）—— 对齐的硬保证。 */
      '.dsp-seq-row .dsp-select{height:22px;box-sizing:border-box;border-width:1px;padding:0 6px;font-size:11px;line-height:20px;border-radius:4px;}',
      '.dsp-seq-sort{flex:0 1 56px;min-width:50px;display:flex;align-items:center;justify-content:flex-start;gap:4px;}',
      '.dsp-seq-sort-col{flex:0 1 56px;min-width:50px;}',
      '.dsp-seq-move{flex:0 0 22px;width:22px;height:22px;box-sizing:border-box;border:1px solid ' + T.border + ';padding:0;margin:0;display:inline-flex;align-items:center;justify-content:center;background:transparent;color:' + T.text2 + ';font-size:11px;line-height:1;border-radius:4px;cursor:pointer;transition:background-color .15s ease,color .15s ease,border-color .15s ease;}',
      '.dsp-seq-move:hover:not(:disabled){background:' + T.hover + ';color:' + T.text + ';border-color:' + T.text3 + ';}',
      '.dsp-seq-move:disabled{opacity:.45;cursor:default;}',
      /* 列头：列宽类与行**完全共用**（不另写宽度）⇒ 天然同线；文字左对齐（不居中）。
       * ⚠️ 这条 `> *` 必须排在上面列宽类之后（同特异性、后写者胜）：只管排版文字，
       * 不改 flex 宽度，所以列宽仍由 .dsp-seq-idx/.dsp-seq-lv/.dsp-seq-sort-col 决定。 */
      '.dsp-seq-head{display:flex;align-items:center;gap:6px;padding:0 0 3px;border-bottom:1px solid ' + T.border + ';min-width:0;}',
      '.dsp-seq-head > *{font-family:inherit;font-size:11px;line-height:16px;color:' + T.text3 + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      /* ⚠️ ZB-59（真机实测抓到的**亚像素**漂移）：下拉带 `padding:0 6px + border:1px`（共 14px 盒外扩），
       * 而列头的「档位」格子原本是裸 span —— Chromium 算 flex 收缩份额时按**内容盒**基准参与
       * （实测：下拉的缩放基准是 96-14=82，列头是 96）⇒ 窄容器里两侧收缩量不同，列边界差 0.7px。
       * 修法：给**列头那一格**补上与下拉**完全相同**的盒外扩（同样的 padding + 1px 透明边框，border-box），
       * 于是两侧基准一致、收缩量逐像素相同；顺带让「档位」文字与下拉文字**同一条内缩基线**（7px）。
       * ⚠️ 只作用于 `.dsp-seq-head` 内（(0,2,0)）：绝不下沉到行里的下拉，免得把它的边框刷成透明。 */
      '.dsp-seq-head .dsp-seq-lv{padding:0 6px;border:1px solid transparent;box-sizing:border-box;}',
      /* ── ZB-59（用户：「开关不行，参考 DSH 项目下面的开关样式」＝面板底部那个 iOS 风格滑块）──
       * 旧的逐模型开关复用了 `.dsp-switch`/`.dsp-dot`（那是"带指示灯的按钮"语言）⇒ 看着不像开关。
       * 这里按 DSH 的滑块观感实现，**只用主题令牌 ⇒ 明/暗两套自动成立**（宿主对下表令牌按主题给两套值）：
       *   · ON  ：轨道 = label-primary（浅色主题下是深色、深色主题下是浅色）+ 旋钮 = bg-base
       *            （与轨道相反 ⇒ 两套主题下旋钮永远可见，正是"深色主题 ON = 浅轨+深钮 / 浅色主题自动反转"）
       *   · OFF ：轨道 = border-l2（弱）+ 旋钮 = bg-layer-2
       *   · 焦点环 = brand-primary。
       * 每个令牌都带**同族回退链**（宿主缺某个令牌时不会掉成透明/黑块）；
       * `rgba(0,0,0,.25)` 是**唯一**字面值，且只作投影（明暗两套都成立）——
       * verify-plugin 的字面色检查只拦 `#hex`，这是项目既有可接受形式（同 T.shadow 的写法）。 */
      '.dsp-sw-ui{position:relative;display:inline-flex;align-items:center;flex:0 0 auto;width:34px;height:20px;padding:0;border:none;border-radius:999px;box-sizing:border-box;background:' + T.border + ';cursor:pointer;transition:background .16s ease;-webkit-appearance:none;appearance:none;}',
      '.dsp-sw-ui:disabled{opacity:.45;cursor:default;}',
      '.dsp-sw-ui[aria-checked="true"]{background:' + T.text + ';}',
      '.dsp-sw-ui .dsp-sw-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1, inherit));box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .16s ease;pointer-events:none;}',
      '.dsp-sw-ui[aria-checked="true"] .dsp-sw-knob{transform:translateX(14px);}',
      '.dsp-sw-ui:focus-visible{outline:2px solid var(--dsw-alias-brand-primary, var(--dsw-alias-button-primary-fill, currentColor));outline-offset:2px;}',
      /* 列宽类**由列头与行共用**（与其它列同一套口径 ⇒ 严格同线）。
       * ⚠️ 必须排在 `.dsp-sw-ui` **之后**：同特异性、后写者胜 —— 让行内开关也按列宽（34px，可缩到 26px）
       * 而不是 `.dsp-sw-ui` 的 `flex:0 0 auto`，否则窄容器里开关不缩、与列头错位。 */
      '.dsp-seq-sw-col{flex:0 1 34px;min-width:26px;}',
      /* 已关闭行：序号/模型名降不透明度（开关仍可点回 ⇒ 不给整行 disabled）。 */
      '.dsp-seq-row.dsp-seq-row-off .dsp-seq-idx,.dsp-seq-row.dsp-seq-row-off .dsp-seq-name{opacity:.55;}',
      '.dsp-seq-off{color:' + T.text3 + ';font-family:inherit;}',
      /* ── ZB-27：会话标题行入口 + 悬浮弹窗（照抄 DSH 自带入口的 visual language）──
       * 触发样式逐项对齐 **dsh-client-ui-subagent 的 CatalogDropdown 触发按钮**（用户点名参考它），
       * 与 dsh-client-ui-jobs 的 job-list 同值：
       *   border-radius:var(--dsw-radius-sm); min-height:28px; color:label-tertiary;
       *   background:0 0; border:0; padding:3px 2px; font-size:12px; line-height:18px;
       *   display:inline-flex; gap:4px；hover/focus-visible 变 label-primary。
       *
       * ⚠️ ZB-27b（用户现场：「字号还是不对、有背景色」）：真因是**样式注入时机** ——
       * ensureStyle() 原先只挂在弹窗（PanelBody）的 effect 上，而弹窗要等用户点开才挂载，
       * 于是入口在首次点开之前**完全没样式**，用的是宿主对 <button> 的默认样式（底色 + 继承字号）。
       * 现在改成 apply() 时就注入（见文件末尾），入口一出现就是对的。
       *
       * ⚠️ ZB-27c（用户现场：「点击打开面板后，背景色又出现了」）：宿主对**已展开/已聚焦的触发按钮**
       * 有自己的高亮态（形如 `button[aria-expanded="true"]` 或 `:focus` 的填充背景）。故这里不只重置
       * 基础态，而是把 background/border/box-shadow 在**所有交互态**一起重置（背景用 !important，
       * 因为宿主选择器未知）。颜色只走主题令牌（T.* = --dsw-alias-* 带回退）⇒ 明暗两套自适应。 */
      '.dsp-entry{position:relative;display:inline-flex;background:transparent !important;border:0 !important;box-shadow:none !important;}',
      /* 外层容器也要重置：宿主可能把高亮加在**槽位 cell**（我们的根 div）上，例如
       * `:focus-within` / `[aria-expanded]` 的祖先选择器 —— 那种情况芯片自身的重置救不了。 */
      '.dsp-entry:focus-within,.dsp-entry:active{background:transparent !important;box-shadow:none !important;}',
      /* ZB-27h（用户：「不要猜，DSH 在 GitHub 是开源的」）：**改为逐项对齐官方源码**，
       * 不再从 minify 产物或肉眼推测。权威源 = 与本插件用法完全相同的
       *   deepseek-ai/deepseek-harness · packages/client/ui-jobs/src/client/JobListAction.{tsx,module.css}
       * 它是同槽位的「按钮 + 弹层」入口（我们就是这一类），源码如下：
       *   <div className={css.root}>                                  // .root{position:relative}
       *     <button type="button" className={css.trigger} aria-expanded={open}>…
       *       <IconChevronDownOutlineRegular size={12} className={open ? css.triggerOpen : undefined} />
       *     {open ? <ul className={css.menu} style={{left:menuShift}}>…</ul> : null}
       *   .trigger{ display:inline-flex; align-items:center; gap:3px; min-height:28px; padding:3px 2px;
       *             border:0; border-radius:var(--dsw-radius-sm); background:transparent;
       *             color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; cursor:pointer }
       *   .trigger:hover,.trigger:focus-visible{ color:var(--dsw-alias-label-secondary) }
       *   .trigger svg{ transition:transform 120ms ease }   .triggerOpen{ transform:rotate(180deg) }
       * ⚠️ 注意源码**不声明 font-family / font-weight** —— 元素是 <button>，就该用 UA 按钮字体；
       *    ZB-27g 我照「创造模式」写了 inherit，方向错了：官方注释明确它是
       *    "static chrome, never a control"（被动装饰、窄屏优先隐藏），不是交互入口的比对基准。
       * 唯一有意偏离官方的是"清除宿主状态高亮"（官方用自己的类名，不存在此问题；我们用第三方类名，
       * 现场已复现宿主把底/焦点环加到 headerActions 里的 button 上）。 */
      /* ZB-27j（用户：「字体颜色对了，大小好像有点区别、放大了些，并且对不齐、偏下」）：
       * 这两个症状**同时**指向"字体不是邻居那套"，而我一直多写了一条官方没有的声明：
       *   `appearance:none`（含 -webkit- 前缀）。
       * Chromium 下给 <button> 加 appearance:none 会让它不再套用 **UA 按钮字体**（退化为继承应用字体），
       * 应用字体 x-height 更大、基线也更低 ⇒ 视觉上"大一点 + 偏下"，与现场描述完全一致。
       * 官方 .trigger 只用 `border:0; background:transparent` 消除原生外观，**从不用 appearance**。
       * 因此这里改为**一比一照抄官方声明列表**，不再有任何自加项：
       *   display:inline-flex; align-items:center; gap:3px; min-height:28px; padding:3px 2px;
       *   border:0; border-radius:var(--dsw-radius-sm); background:transparent;
       *   color:label-tertiary; font-size:12px; line-height:18px; cursor:pointer
       * （白色/透明底/无焦点环仍由下面的成组 !important 规则与元素内联 style 兜住宿主覆盖。） */
      /* ZB-27k/o：几何取可见邻居的**官方值**（用户点名「参考子智能体的三角形图标」，又说与左侧入口
       * 之间的间距偏紧）：gap:4px（子智能体）；min-height:28px；**padding:3px 7px**（agent-team，
       * 官方各入口本身不统一：jobs 3px 2px / 子智能体 3px 2px / agent-team 3px 7px —— 取横向 7px
       * 是为了让入口两侧的呼吸感与 agent-team 一致）；border-radius:var(--dsw-radius-sm)；
       * font-size:12px; line-height:18px; color:label-tertiary；箭头 14（子智能体默认）。 */
      '.dsp-entry .dsp-chip{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:3px 2px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:' + T.text3 + ';font-size:12px;line-height:18px;cursor:pointer;}',
      /* 所有交互态统一"无底色、无焦点环" —— 基础态那条压不住宿主针对 :hover/:focus/[aria-expanded] 的规则。
       * 焦点可见性改由**颜色**承担（与邻居把 :hover/:focus-visible 变成 label-primary 同思路）。 */
      '.dsp-entry .dsp-chip:hover,.dsp-entry .dsp-chip:focus,.dsp-entry .dsp-chip:focus-visible,.dsp-entry .dsp-chip:active,.dsp-entry .dsp-chip[aria-expanded="true"],.dsp-entry .dsp-chip[aria-expanded="false"]{background:transparent !important;background-image:none !important;border:0 !important;box-shadow:none !important;outline:none !important;}',
      /* ZB-27p：悬浮/聚焦的亮度改为与**可见邻居完全一致** —— 子智能体 `.oXE0lW_trigger:hover`
       * 与 agent-team `.EBLgjq_trigger:hover` 都变到 `label-primary`（T.text）；我此前用 label-secondary，
       * 比它们**暗一档**，于是"我被悬浮时"和"邻居被悬浮时"仍不是同一种观感（用户分别截图对比）。
       * 现在：静止 = label-tertiary（三者相同，已实测 rgb(173,178,184) 一致）；
       *       悬浮/聚焦 = label-primary（与两个可见邻居同值）。 */
      '.dsp-entry .dsp-chip:hover,.dsp-entry .dsp-chip:focus-visible{color:' + T.text + ';}',
      /* 展开指示：与子智能体一致 —— 转的是 **svg 本身**，过渡 .12s。 */
      '.dsp-entry .dsp-chip svg{flex:none;transition:transform .12s;}',
      '.dsp-entry .dsp-chip[aria-expanded="true"] svg{transform:rotate(180deg);}',
      /* 弹窗本体：与官方 ui-jobs 的 .menu 同值（gap:1px / padding:3px /
       * max-height:min(480px,calc(100vh - 140px)) / backdrop-filter:var(--dsw-menu-backdrop-filter)）。
       * ZB-27x（用户要求「派发台现在往左侧展开，改成往右侧，参考智能体的」）：
       * 定位由 `right:0` 改为 **`left:0`** —— 与入口**左对齐、向右展开**（官方 .menu 就是 left:0，
       * 子智能体那份弹窗也是贴着入口左缘向右铺开）。入口已不在标题行最右端（order -25），
       * 因此不会溢出；万一靠近右缘，则由 JS 计算的 menuShift（marginLeft 负值）兜回视口内
       * —— 与官方 `style={{left: menuShift}}` 同一意图。 */
      /* ZB-27z：**基础字号**（原浮窗时代的 .dsp-root{font-size:12px} 在重构中被丢掉，导致进程行等
       * 未显式设字号的元素继承应用根部 ~14px、整体偏大）。取官方弹层主行的 12px/17px 作为基准。 */
      '.dsp-menu{position:absolute;top:calc(100% + 5px);left:0;z-index:100;font-size:12px;line-height:17px;box-sizing:border-box;display:flex;flex-direction:column;gap:1px;width:min(var(--dsp-w,' + WIDTH.def + 'px),calc(100vw - 32px));max-height:min(480px,calc(100vh - 140px));margin:0;padding:3px;overflow:auto;border:0;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,' + T.bg + ');backdrop-filter:var(--dsw-menu-backdrop-filter,none);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,' + T.shadow + ');text-align:left;}',
      /* ── ZB-60：**降级备用入口**（右下角浮层，仅当会话头槽位不可用时才注册）──
       * 它不是"第二份 UI"：主入口注册成功时这条路径永不启用。形态要点：
       *   · 右下角固定定位 + 胶囊外观（主入口是透明文字按钮，浮层若也透明会看不见）；
       *   · 弹窗**向上**展开并右对齐 —— 否则会掉出视口底部（`.dsp-menu` 默认是 top:calc(100%+5px)/left:0）。
       * 全部颜色走主题令牌（明暗两套自适应），与主入口同一纪律。
       * ⚠️ 这三条**必须排在 `.dsp-menu` 规则之后**：header-entry.test 用"第一条含 `dsp-menu{` 的规则"
       *    作为官方同值基准（B24~B30），放在前面会误抢匹配。 */
      '.dsp-entry-float{position:fixed;right:16px;bottom:16px;z-index:1000;padding:2px 6px;border-radius:999px;background:' + T.bg + ' !important;border:1px solid ' + T.border + ' !important;box-shadow:' + T.shadow + ' !important;}',
      '.dsp-entry-float:hover{border-color:' + T.text3 + ' !important;}',
      '.dsp-entry-float .dsp-menu{top:auto;bottom:calc(100% + 6px);left:auto;right:0;}',
      '.dsp-panelHead{display:flex;align-items:center;gap:8px;padding:6px 8px 5px;border-bottom:.5px solid var(--dsw-alias-border-l1,' + T.border + ');}',
      '.dsp-panelTitle{flex:1;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:' + T.text + ';}',
      /* 行内小图标按钮（**仍在使用**：JobRow 的终止 / 重跑 / 续接 / 关闭）。ZB-27 清理浮窗样式时
       * 一度把它当死代码删掉，故在此显式保留并注明用途。 */
      '.dsp-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:5px;background:transparent;color:' + T.text2 + ';cursor:pointer;transition:background-color .15s ease,color .15s ease;}',
      '.dsp-iconbtn:hover{background:' + T.hover + ';color:' + T.text + ';}',
      /* ⚠️ ZB-27w：`@keyframes dsp-pulse` 被我在 ZB-27 的"清理死代码"里**误删**了 ——
       * 而 `.dsp-dot.s-running{animation:dsp-pulse …}` 与 `.dsp-dot.s-paused{…}` 一直在用它，
       * 结果"进行中"的状态点就不再脉动（与 .dsp-iconbtn 同一类误判：带 animation 的 keyframes
       * 不能按"没人引用"处理，必须先反查 `animation:` 引用）。此处补回。 */
      '@keyframes dsp-pulse{50%{opacity:.35;}}',
      /* ZB-27w（用户要求「有任务要有图标提示、进行中要有加载图标，参考子智能体」）：
       * 官方子智能体入口在 runningCount>0 时渲染 <span class=activitySlot><StateDot state="ongoing"/></span>，
       * .oXE0lW_activitySlot{flex:none;justify-content:center;align-items:center;width:14px;height:14px;display:inline-flex}
       * —— 这里照抄该 14×14 槽位（点本身复用面板里的 .dsp-dot，running 态自带脉动）。 */
      '.dsp-chip-activity{flex:none;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;}',
      /* ZB-08：文件锁列表（哪个文件被哪个进程锁着、锁了多久） */
      '.dsp-locks{display:flex;flex-direction:column;gap:6px;}',
      '.dsp-filelocks{display:flex;flex-direction:column;gap:3px;}',
      '.dsp-filelock{display:flex;align-items:center;gap:6px;font-size:11px;line-height:16px;min-width:0;}',
      '.dsp-filelock-f{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + T.text2 + ';}',
      '.dsp-filelock-who{flex:none;font-weight:600;color:' + T.text + ';}',
      /* ── D1：`dispatch` 工具卡片（会话内，`tool.call.toolview`）──
       * ⚠️ 这张卡渲染在**会话流**里，不在 `.dsp-menu` 子树内 ⇒ 拿不到
       * `border-box` 作用域与 12px 基准字号，必须自带：见下面的 `.dsp-tv-card` / `.dsp-tv-card *`。
       * 颜色一律走主题令牌（明暗双主题自适应），零字面色值。 */
      '.dsp-tv-card{box-sizing:border-box;display:flex;flex-direction:column;min-width:0;font-size:13px;line-height:18px;color:' + T.text2 + ';}',
      '.dsp-tv-card *{box-sizing:border-box;}',
      '.dsp-tv-row{display:flex;align-items:center;gap:6px;min-width:0;min-height:22px;padding:0 2px;border-radius:4px;transition:background-color .15s ease;}',
      '.dsp-tv-row[role="button"]{cursor:pointer;}',
      '.dsp-tv-row:hover{background:' + T.hover + ';}',
      '.dsp-tv-row:focus-visible{outline:1px solid ' + T.text3 + ';outline-offset:2px;}',
      '.dsp-tv-caret{flex:none;display:inline-flex;justify-content:center;width:10px;font-size:10px;line-height:18px;color:' + T.text3 + ';}',
      '.dsp-tv-title{flex:none;font-weight:600;color:' + T.text + ';}',
      '.dsp-tv-sep{flex:none;width:2px;height:2px;border-radius:1px;background:' + T.text3 + ';}',
      '.dsp-tv-action{flex:none;color:' + T.text2 + ';}',
      /* 摘要列：flex:1 + min-width:0 + 省略号 —— 长目标/长错误不会把这一行撑破。 */
      '.dsp-tv-sum{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:' + T.text3 + ';}',
      '.dsp-tv-tag{flex:none;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:' + T.text3 + ';}',
      '.dsp-tv-meta{flex:none;font-size:11px;color:' + T.text3 + ';white-space:nowrap;}',
      '.dsp-tv-pill{flex:none;font-size:11px;line-height:16px;padding:0 6px;border:1px solid ' + T.border + ';border-radius:8px;color:' + T.text2 + ';white-space:nowrap;}',
      /* 状态色（按 job 状态族映射到既有令牌；文字本身也是状态文本 ⇒ 不只靠颜色表达）。 */
      '.dsp-tv-pill.s-queued{color:' + T.stQueued + ';}',
      '.dsp-tv-pill.s-running{color:' + T.stRunning + ';}',
      '.dsp-tv-pill.s-done{color:' + T.stDone + ';}',
      '.dsp-tv-pill.s-failed{color:' + T.stFailed + ';}',
      '.dsp-tv-pill.s-killed{color:' + T.stKilled + ';}',
      '.dsp-tv-pill.s-paused{color:' + T.stPaused + ';}',
      '.dsp-tv-pill.s-interrupted{color:' + T.stInterrupted + ';}',
      '.dsp-tv-pill.s-prep{color:' + T.stRunning + ';}',
      '.dsp-tv-body{display:flex;flex-direction:column;gap:4px;min-width:0;margin:2px 0 6px 16px;padding:6px 8px;border-left:2px solid ' + T.border + ';}',
      '.dsp-tv-kv{display:flex;gap:8px;min-width:0;font-size:12px;line-height:17px;}',
      '.dsp-tv-kv-k{flex:none;min-width:56px;color:' + T.text3 + ';}',
      '.dsp-tv-kv-v{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;color:' + T.text2 + ';}',
      '.dsp-tv-err{font-size:12px;line-height:17px;overflow-wrap:anywhere;color:' + T.danger + ';}',
      '.dsp-tv-note{font-size:11px;line-height:16px;overflow-wrap:anywhere;color:' + T.text3 + ';}',
      /* 原文区：默认折叠 + 展开后**限高滚动**（`action=list` 的载荷可达数十 KB，绝不整段铺开）。 */
      '.dsp-tv-rawbtn{display:inline-flex;align-items:center;align-self:flex-start;gap:4px;margin-top:2px;padding:1px 6px;border:1px solid ' + T.border + ';border-radius:6px;background:transparent;font:inherit;font-size:11px;line-height:16px;color:' + T.text3 + ';cursor:pointer;transition:background-color .15s ease,color .15s ease;}',
      '.dsp-tv-rawbtn:hover{background:' + T.hover + ';color:' + T.text + ';}',
      '.dsp-tv-raw{max-height:220px;overflow:auto;margin:2px 0 0;padding:6px;border-radius:4px;background:' + T.sunken + ';font-family:' + T.mono + ';font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all;}',
      '.dsp-tv-empty{font-size:11px;line-height:16px;color:' + T.text3 + ';}',
    ].join('\n');

    /* ZB-21（用户报告「面板发生重影，变成透明在左上角」）：
     * ★ 根因：样式此前是**作为 React 元素**渲染进组件树（`h('style', null, CSS)`）。
     * 面板每秒轮询重渲染，一旦 React 重建该 <style> 节点，浏览器会**先移除再插入**样式表 ——
     * 那一瞬间：
     *   ① `.dsp-root` 失去 position:fixed ⇒ 面板**塌到左上角**（退回静态布局）；
     *   ② `.dsp-panel` 失去 background ⇒ **透明**（看到底下的 DSH 界面）；
     *   ③ 样式重新插入时 `.dsp-panel` 的 `animation:dsp-in` **从头播放**，而
     *      `@keyframes dsp-in{from{opacity:0;...}}` **没有 to** ⇒ 动画反复重启期间面板
     *      长期处于低透明度 ⇒ 用户看到的**重影/半透明**。
     *
     * 修法（两层）：
     *   A. 样式**只注入一次**到 document.head，完全脱离 React 重渲染路径（ensureStyle）；
     *   B. 给 dsp-in 补上显式 `to{opacity:1;transform:none}`，即使动画被重启也终态明确。
     *
     * 为什么注入 head 而不是组件树：head 里的样式表不参与 React 协调，重渲染不会动它；
     * 同时保留"插件卸载即移除"的语义（用 data 属性标记 + 卸载时移除，见 detachStyle）。
     */
    const STYLE_ID = 'dispatch-style';
    let styleEl = null;
    /* ★ ZB-27u（真实 bug，2026-10-05 现场定证）：样式表是**模块级单例**，却被两个组件各自
     * "挂载时注入、卸载时移除"：会话头入口（常驻）+ 面板 PanelBody（**按需挂载**）。
     * 于是面板一关闭，PanelBody 的清理函数就把整张样式表从 <head> 删掉 —— 入口随即失去全部样式，
     * 退回浏览器默认按钮外观（实测：关闭瞬间盒子从 w=58 h=28 top=51 变成 w=66 h=19 top=56.5）。
     * 这正是用户反复描述的「悬浮之前正常，悬浮失焦后就不正常」。
     * 修法：**引用计数**。ensureStyle() 每被持有一份就 +1 并返回释放函数；只有计数归零才真正移除。
     * apply() 也持有一份且永不释放 ⇒ 只要插件激活着，样式就一直在。 */
    let STYLE_REFS = 0;
    /** 把样式注入 document.head（幂等：已存在则复用）；返回释放函数（引用计数归零才移除）。 */
    function ensureStyle() {
      STYLE_REFS += 1;
      try {
        if (typeof document === 'undefined') return () => { STYLE_REFS = Math.max(0, STYLE_REFS - 1); };
        if (!(styleEl && styleEl.isConnected)) {
          const existing = document.getElementById(STYLE_ID);
          if (existing) {
            styleEl = existing;
          } else {
            const s = document.createElement('style');
            s.id = STYLE_ID;
            /* 双保险：同时写 id 属性（真实 DOM 里 `s.id = x` 与 setAttribute 等价，
             * 但某些测试桩/老内核只认其中一种；getElementById 依赖它做幂等查找）。 */
            try { s.setAttribute('id', STYLE_ID); } catch { /* ignore */ }
            s.setAttribute('data-plugin', 'dispatch');
            s.textContent = CSS;
            (document.head || document.documentElement).appendChild(s);
            styleEl = s;
          }
        }
        /* ★ ZB-29c：**内容漂移自愈** —— 样式表元素可能由旧一轮模块求值注入（DSH 对插件更新
         * 走模块重求值/热替换而非整页刷新），旧 CSS 会原样留在 head 里，新 JSX 拿不到新规则
         * （现场：进程行两行布局渲染出来了，.dsp-job-line 的 flex+gap 却没生效 ⇒ 时间/上下文/
         * 退出挤成一团）。幂等复用元素的同时，内容变了就整体替换 textContent——廉价且原子。 */
        try {
          if (styleEl && styleEl.textContent !== CSS) styleEl.textContent = CSS;
        } catch { /* 更新失败等同注入失败，不阻塞渲染 */ }
      } catch { /* 注入失败不阻塞渲染（面板仍可用，只是样式可能不完整） */ }
      return () => {
        STYLE_REFS = Math.max(0, STYLE_REFS - 1);
        if (STYLE_REFS === 0) detachStyle();
      };
    }
    /** 真正移除样式表（只应由引用计数归零时调用）。 */
    function detachStyle() {
      try {
        const s = (styleEl && styleEl.isConnected) ? styleEl : (typeof document !== 'undefined' ? document.getElementById(STYLE_ID) : null);
        if (s && s.parentNode) s.parentNode.removeChild(s);
      } catch { /* ignore */ }
      styleEl = null;
    }

    /* ─────────────── 文案（与 locale/zh.json、locale/en.json 的 ui 段同源；接线后可改走宿主 locale 服务） ─────────────── */
    const STRINGS = {
      zh: {
        title: '派发台',
        /* ZB-41（用户要求）：「面板改成派发台，包名等相关的改成 DSH 派发台」。
         * 故**面板标题 = 「派发台」**（纯功能名，不再带引擎品牌），
         * 而**包标题 = 「DSH 派发台」**（package.json / locale meta.title）。
         * 背景：面板正准备接入第二个执行引擎（OpenCode），标题里带 ZCode 会名不副实。
         * 历史：ZB-27t 曾试过短标签但因样式表被卸载带走（ZB-27u）而回退；本次是**命名决策**，
         * 与那次渲染 bug 无关。 */
        headerTip: '打开 / 收起派发台面板',
        connConnecting: '连接中', connDemo: '演示数据', connExt: '外部数据', connLive: '已连接', connOffline: '未连接',
         secJobs: '进程', secQuota: '用量', secLocks: '仓库文件锁',
        noFileLocks: '（当前没有文件锁：任务未声明 write，走仓库整锁）',
        kind: '类型', kindPrompt: '提示词', kindTask: '任务文件', kindTarget: '目标',
        model: '模型', provider: '通道',  
        mode: '模式', timeout: '超时(分)', 
        thinking: '思考强度', thinkingAgent: 'Agent决定（按任务判断）', thinkingAgentShort: 'Agent决定',
        thinkDisabled: '关闭思考', thinkEnabled: '开启思考', thinkLow: '低强度', thinkHigh: '高强度', thinkMax: '最高强度',
        /* ZB-55：三引擎实测 11 档 —— 下方 6 个补齐（原先掉回英文原文 none/minimal/medium/xhigh …） */
        thinkNone: '无思考', thinkMinimal: '最小强度', thinkMedium: '中等强度', thinkXhigh: '极高强度',
        thinkAuto: '自动', thinkUltracode: '极限强度',
        /* ZB-56：档位探测还没出结果时的占位（只报状态、不编造档位） */
        thinkLoading: '档位载入中…',
        chanThinkingHint: '通道默认思考强度：Agent决定=由派发方 Agent 按任务自行改传具体档位；具体档位=给派发 Agent 的硬性规定（未显式指定的派发一律按它执行，仅新建会话生效）',
        thinkingStale: '已失效', thinkingStaleHint: '该档位不在当前模型声明的取值里（可能因模型档位表更新而失效）——派发会被 runner 拒绝，请改选一个有效档位',
           sending: '提交中…',
        fbQueued: '已排队：', errPrefix: '失败：', 
         noJobs: '暂无进程记录', exit: '退出', kill: '终止', tail: '输出', tailLoading: '读取中…', tailEmpty: '（无输出）',
        closeJob: '关闭', cwd: '工作目录', createdAt: '创建于', sessionId: '会话',
        grpActive: '进行中', grpPaused: '需处理', grpFailed: '异常', grpDone: '已完成', grpOther: '其他',
        jobMore: '还有', jobMoreN: '条更早的', jobCollapse: '收起',
        /* ZB-70：页脚「清除所有」——只清**当前页签**（进行中不可清：宿主拒绝 running/queued）。
         * 文案里刻意写"清除"而不是"删除"：语义是从列表移除（落盘 dismissed.json），不是删记录。 */
        jobClearAll: '清除所有', jobClearHint: '清除本页签内所有进程（从列表移除并落盘 dismissed.json；进行中的不在此列，需先终止）',
        jobClearing: '清除中…', jobCleared: '已清除', jobClearN: '条',
        rerun: '重跑', rerunTitle: '同会话重发原提示词（--resume；无 sessionId 则交接重跑）',
        continueBtn: '续接', continueTitle: '在同一会话里发一条新指令（--resume + 新提示词）',
        continueNoSession: '该任务没有 sessionId，无法续接（可先用「重跑」交接重跑）',
        continuePh: '输入要接续的指令…', continueSend: '发送',
        emptyOffline: '未连接宿主：无进程数据（真数据需完成 Remote 接线）',
        usage5h: '5 小时窗口', usageWeek: '本周', usageToday: '今日',
        runs: 'run 数', requests: '请求', inTok: '输入', outTok: '输出', cacheTok: '缓存读',
        localNote: '本地用量（可核对）：台账聚合的 5 小时 / 本周 / 今日窗口',
        engineWeekUsed: '引擎本周已用（引擎本地库合计，非套餐已用）',
        planQuotaPending: '套餐剩余额度：未接入 —— CLI RPC 面无此方法（app-server usage/stats 语义是「本地已用」）；以 ZCode 客户端为准',
        repoLock: '仓库锁',  queueLen: '队列', idle: '空闲', lockHeld: '持有仓库锁',
        writeFiles: '要写入的文件列表', 
        secChannel: '通道', chanNewTask: '新任务将使用：', chanDisabled: '不可用', chanLoadFail: '通道清单加载失败',
        /* 双引擎（OpenCode 接入）：通道下拉按引擎分组 + 引擎徽标 + 引擎专属提示。
         * 引擎是「通道」这个既有抽象的一个属性（不是新 tab）——进程列表/锁/队列/用量/降级链
         * 全部与引擎无关，跨引擎降级才是本轮的主要增量，故只做"按选中通道动态显示"。 */
        engZcode: 'ZCode', engOpencode: 'OpenCode', engGroupZcode: 'ZCode 通道', engGroupOpencode: 'OpenCode 免费模型',
        /* ZB-51（T5）：第三个引擎（Qoder）+ 引擎状态条文案。
         * ⚠️ 这几把键必须与 locale/zh.json **逐键一致**（single-source.test.mjs 守门）。 */
        engQoder: 'Qoder', engGroupQoder: 'Qoder 通道',
        enginesTitle: '引擎',
        enginesHint: '本机自动探测到的执行引擎（形态 / 版本 / 登录态）。插件按「环境变量 → 配置 → PATH → 已知安装位置（含跨盘符）」五级查找，无需手填路径。',
        engineNotFound: '未找到', engineNotLoggedIn: '未登录', engineLoggedIn: '已登录', engineLoginUnknown: '登录态未知',
        engineFormCli: 'CLI', engineFormClientBundled: '客户端自带', engineFormIde: 'IDE 自带', engineFormIdeEntry: 'IDE 入口',
        chanEngineHintQoder: 'Qoder 引擎：不支持 mode / memoryBench；思考强度映射为 Qoder 的 --reasoning-effort。**无头模式下「需要确认」的操作会被直接拒绝**，所以执行器默认带 --permission-mode accept_edits（能改工作目录内的文件，shell 仍受检）；需要全放行时由派发方**显式**传 auto=true（映射为 bypass_permissions）。⚠️ 非默认权限模式只在「受信任目录」生效，目录不受信任会回落到 default ⇒ 写操作会被拒且**表现很静默**（任务报成功但没改文件），执行器会比对 init.permissionMode 并在回落时明确报警。用量以 total_credits 为准（该引擎的 token 字段可能为 0）。',
        engBadge: '引擎', engLimitedFree: '限时免费 / 限区域', engModelOnly: '该通道的模型由上表探测得出',
        chanEngineHintZcode: 'ZCode 引擎：支持 mode（build/edit/plan/yolo）与 memoryBench；思考强度映射为 ZCode 的 reasoning-level。',
        chanEngineHintOpencode: 'OpenCode 引擎：不支持 mode / memoryBench（派发时不会传）；思考强度映射为 OpenCode 的 --variant；默认不加 --auto（子代理不会自动放行所有权限）——需要放行时由派发方**显式**传 auto=true，且在下方进程行上会显示「已放行权限」徽标；免费层按 IP 限流，且每次调用都要起临时服务（冷启动慢），故其并发上限独立且较低（默认 2）。',
        /* 通道过滤开关（用户要求）：两个独立开关，作用于「通道」与「自动降级目标」两处下拉。 */
        filtAvailable: '仅看可用', filtAvailableHint: '只列出当前可用的通道（关闭 = 连不可用通道也一并列出，并标注原因）',
        filtFree: '仅看免费', filtFreeHint: '只列出不需要付费额度的通道：免费额度（Start Plan）与 OpenCode 免费模型；个人 Key 与付费套餐通道隐藏',
        filtHint: '过滤：仅看可用（默认开，关掉可连不可用通道一起看）｜仅看免费（默认关，开启只留免费额度与 OpenCode 免费模型）。只影响这两处下拉列出什么，不会自动改掉当前选择。',
        filtCurrent: '当前选择',
        filter: '过滤',
        filtHiddenA: '过滤已隐藏 ',
        filtHiddenB: ' 个通道（共 ',
        filtHiddenC: ' 个）',
        chanLoading: '通道清单加载中…（宿主刚启动或首次探测中；失败会自动重试，无需刷新）',
        chanLoadRetry: '会自动重试', chanInfoPrefix: '通道清单说明：',  zcRoutePlan: 'BigModel(Plan)', zcRouteFree: 'Start Plan(免费)', zcFreeSuffix: '免费',
        autoApproved: '已放行权限', autoApprovedHint: '该任务派发时显式开启了 OpenCode 的 --auto：放行了所有未显式拒绝的权限（默认不开启，仅调用方显式指定时生效）',
        giftQuota: '免费额度剩余', giftQuotaUnavailable: '免费额度余量不可用', chanQuotaExhausted: '5 小时窗口已满',
        jobCurrent: '当前：', jobLastBeat: '最近心跳', jobStalled: '可能卡住',
        jobStalledHint: '超过 150 秒没有收到 runner 的心跳/输出：可能卡在上游请求、MCP 连接或等锁。可用「终止」后重派，或 action=tail 看最后输出。',
        chanOfflineHint: '未连接宿主：通道/模型来自宿主远端面，连接后这两个下拉才可选',
        chanDefaultModel: '（通道默认模型）',  
        /* ZB-52：顺序派发（同一引擎内按列表从上到下换模型）。
         * ZB-52c：**没有开关** —— 「模型」选「顺序派发」即开启（主通道与降级目标各自一份列表）。
         * ⚠️ 这几把键必须与 locale/zh.json、locale/en.json **逐键逐值一致**（single-source.test.mjs ⑤ 守门）。 */
        seqTitle: '顺序派发', seqThinkingDefault: '设置默认', 
        seqHint: '「模型」选「顺序派发」即开启本模式（**没有开关**）：派发时按下面列表从上到下尝试，上一个报错就换下一个（额度耗尽 / 限流暂停同样换），全试完仍失败才报错 —— 之后才轮到「自动降级」。主通道与降级目标各自独立：主通道模型为空 ⇒ 用主通道引擎的列表；否则降级目标模型为空 ⇒ 用降级目标引擎的列表（列表按引擎分别保存）。列表只作用于**当前显示的那个引擎**（ZCode / OpenCode / Qoder 各自一份）。每一行右边的「档位」可单独设置该模型的思考强度（「默认」= 用引擎默认档位）—— 顺序派发模式下全局档位不可改：各模型支持的档位不同。注意：换模型 = 新开会话，前面已完成的文件改动会保留、模型会被告知接着做。',
        seqHintShort: '顺序派发：不绑定具体模型 ⇒ 报错时按「顺序派发」列表从上到下换模型（主通道与降级目标各自一份列表）',
        seqOrderLabel: '尝试顺序',
        seqUp: '上移',
        seqDown: '下移',
        seqEmpty: '（该引擎当前没有可选模型；列表为空时顺序派发不生效）',
        seqUnavailable: '（当前不可用）',
        seqOfflineHint: '未连接宿主：顺序设置存在宿主工作目录，连接后才可读写',
        /* D1：`dispatch` 工具调用的会话内专属卡片（tool.call.toolview）。
         * ⚠️ 必须与 locale/zh.json、locale/en.json **逐键逐值一致**（single-source.test.mjs ⑤ 守门）。 */
        tvTitle: '派发',
        tvPreparing: '正在派发…',
        tvDetail: '详情',
        tvAction: '动作',
        tvState: '状态',
        tvJobId: '任务 id',
        tvEngineCh: '引擎/通道',
        tvTailHint: '用 action=tail 读输出',
        tvJobs: '任务数',
        tvLines: '行',
        tvArgs: '原始入参',
        tvResult: '原始结果',
        tvRawOpen: '展开原文',
        tvRawClose: '收起原文',
        tvTruncatedA: '（已截断，原文共 ',
        tvTruncatedB: ' 字符）',
        tvEmpty: '（无）',
        seqLevelLabel: '档位', seqLevelDefault: '默认',
        /* ZB-54（插件详情页配置卡"按引擎编辑"）：一行短说明 + 该引擎是否正在被顺序派发。
         * ⚠️ 与 locale/zh.json、locale/en.json **逐键逐值一致**（single-source ⑤ 守门）。 */
        seqHintCard: '按下面顺序从上到下尝试：上一个报错就换下一个；换模型 = 新开会话',
        seqUseMain: '主通道正在使用此顺序',
        seqUseFallback: '降级目标正在使用此顺序',
        seqUseBoth: '主通道与降级目标都在使用此顺序',
        seqUseNone: '当前未生效：把通道的「模型」选成「顺序派发」后才按此列表尝试',
        /* ZB-55：加载态 / 保存反馈 / 表头列名（卡片与浮窗共用） */
        seqLoading: '正在加载通道与模型…', seqSaving: '保存中…', seqSortCol: '排序',
        /* ZB-58（用户要求「每个模型一个单独开关」）：可用列 + 已关闭标记 + 区块头可用计数。
         * `modelAvailCount` 含 `{n}` / `{total}` 占位符，由 `tFmt()` 填充（t() 本身只做静态查表）。
         * ⚠️ 与 locale/zh.json、locale/en.json **逐键逐值一致**（single-source ⑤ 守门）。 */
        modelSwitchCol: '可用', modelDisabledTag: '已关闭', modelAvailCount: '可用 {n}/{total}',
        paused: '已暂停', pQuota: '额度耗尽', pEntitled: '未开通', pSigning: '需签名', pConfig: '配置错误', pUnknown: '未知原因',
        lockWait: '排队等待', timedOut: '超时终止',
        timedOutRunner: 'runner 超时（exit 124，--timeout-min 到点）', timedOutWatchdog: '看门狗强制终止（timeoutMin+120s 宽限后未退出）',
        resumeSame: '同通道续跑', retryHandoff: '换通道重跑', noSession: '无会话，不能同通道续跑',
        handoffConfirm: '换通道=交接重跑：会新开会话并把未完成部分交接过去', confirmHandoff: '确认交接重跑', cancel: '取消',
        parentFrom: '接续自', hop: '跳',
        fallbackTitle: '自动降级', fallbackStateOff: '关', fallbackStateOn: '开',
        fallbackEnableTitle: '自动降级：点击开启/关闭。开启后额度耗尽 / 未开通 / 需签名时会自动交接重跑到下面选定的目标（会消耗下游通道额度）',
        fallbackHint: '选项逻辑与上面「通道」完全一致：模型留空=该通道默认模型；思考强度「Agent决定」=按 ZCode 默认规则解析。仅新建会话生效。',
        fallbackOfflineHint: '未连接宿主：降级设置存在宿主工作目录，连接后才可读写',
        switchOn: '派发：开', switchOff: '派发：关', switchUnknown: '派发：未知',
        switchTitle: '派发总开关：点击切换（写入 collab/dispatch.switch.json，全部会话生效）',
        switchHintOffline: '未连接宿主：请在终端执行 dispatch-switch.mjs 切换',
        switchOffBlocked: '派发总开关已关闭：所有派发入口都被拒绝；请先用标题栏开关或 dispatch-switch.mjs 恢复',
      },
      en: {
        title: 'Dispatch Console',
        headerTip: 'Open or hide the dispatch panel',
        connConnecting: 'connecting', connDemo: 'demo data', connExt: 'external', connLive: 'live', connOffline: 'offline',
         secJobs: 'Processes', secQuota: 'Usage', secLocks: 'Repo file locks',
        noFileLocks: '(no file locks: jobs did not declare write, using whole-repo lock)',
        kind: 'Kind', kindPrompt: 'Prompt', kindTask: 'Task file', kindTarget: 'Target',
        model: 'Model', provider: 'Channel',  
        mode: 'Mode', timeout: 'Timeout (min)', 
        thinking: 'Thinking', thinkingAgent: 'Agent decides (per task)', thinkingAgentShort: 'Agent decides',
        thinkDisabled: 'Thinking off', thinkEnabled: 'Thinking on', thinkLow: 'Low effort', thinkHigh: 'High effort', thinkMax: 'Max effort',
        /* ZB-55: three engines actually report 11 levels — these 6 used to fall back to the raw id. */
        thinkNone: 'None', thinkMinimal: 'Minimal', thinkMedium: 'Medium', thinkXhigh: 'Extra high',
        thinkAuto: 'Auto', thinkUltracode: 'Ultracode',
        /* ZB-56: placeholder while the effort-level probe is still pending (report state, never invent levels). */
        thinkLoading: 'Loading effort levels…',
        chanThinkingHint: 'Channel default thinking: Agent decides = the dispatching agent picks a concrete level per task; a concrete level is a hard rule for dispatched agents (dispatches without an explicit level follow it; new sessions only)',
        thinkingStale: 'stale', thinkingStaleHint: 'This level is not in the current model declaration (the model level table may have changed) — dispatch would be rejected by the runner; pick a valid level',
           sending: 'Sending…',
        fbQueued: 'Queued: ', errPrefix: 'Failed: ', 
         noJobs: 'No process records yet', exit: 'exit', kill: 'Kill', tail: 'Tail', tailLoading: 'Loading…', tailEmpty: '(no output)',
        closeJob: 'Close', cwd: 'Workdir', createdAt: 'Created', sessionId: 'Session',
        grpActive: 'Running', grpPaused: 'Needs action', grpFailed: 'Failed', grpDone: 'Completed', grpOther: 'Other',
        jobMore: 'Show', jobMoreN: 'older', jobCollapse: 'Collapse',
        /* ZB-70: footer "clear all" — clears only the CURRENT tab (running/queued are rejected host-side). */
        jobClearAll: 'Clear all', jobClearHint: 'Clear every job in this tab (removed from the list and persisted to dismissed.json; running jobs cannot be cleared)',
        jobClearing: 'Clearing…', jobCleared: 'Cleared', jobClearN: 'jobs',
        rerun: 'Rerun', rerunTitle: 'Re-send the original prompt in the same session (--resume; without a sessionId it hands off)',
        continueBtn: 'Continue', continueTitle: 'Send a NEW instruction into the same session (--resume + new prompt)',
        continueNoSession: 'This task has no sessionId, so it cannot be continued (use Rerun to hand off instead)',
        continuePh: 'Instruction to continue with…', continueSend: 'Send',
        emptyOffline: 'Host not connected: no process data (live data needs the Remote wiring)',
        usage5h: '5h window', usageWeek: 'This week', usageToday: 'Today',
        runs: 'runs', requests: 'req', inTok: 'in', outTok: 'out', cacheTok: 'cache',
        localNote: 'Local usage (verifiable): ledger-aggregated 5h / week / today windows',
        engineWeekUsed: 'Engine week used (engine-local DB total, not plan usage)',
        planQuotaPending: 'Plan quota remaining: not wired — no such method on the CLI RPC surface (app-server usage/stats is local-used only); defer to the ZCode client',
        repoLock: 'Repo lock',  queueLen: 'queue', idle: 'idle', lockHeld: 'holds the repo lock',
        writeFiles: 'files to write', 
        secChannel: 'Channels', chanNewTask: 'New tasks will use: ', chanDisabled: 'unavailable', chanLoadFail: 'Failed to load channels',
        engZcode: 'ZCode', engOpencode: 'OpenCode', engGroupZcode: 'ZCode channels', engGroupOpencode: 'OpenCode free models',
        engQoder: 'Qoder', engGroupQoder: 'Qoder channels',
        enginesTitle: 'Engines',
        enginesHint: 'Execution engines auto-detected on this machine (form / version / login). The plugin searches in five levels — env var → config → PATH → known install locations (incl. other drives) — so no path needs to be filled in by hand.',
        engineNotFound: 'not found', engineNotLoggedIn: 'not signed in', engineLoggedIn: 'signed in', engineLoginUnknown: 'login unknown',
        engineFormCli: 'CLI', engineFormClientBundled: 'bundled with client', engineFormIde: 'bundled with IDE', engineFormIdeEntry: 'IDE entry',
        chanEngineHintQoder: 'Qoder engine: no mode / memoryBench; thinking maps to Qoder --reasoning-effort. In headless mode any operation that would ask for confirmation is denied outright, so the executor defaults to --permission-mode accept_edits (it can edit files inside the working directory; shell stays gated). To allow everything the dispatcher must pass auto=true explicitly (mapped to bypass_permissions). Note: non-default permission modes only apply inside trusted directories — an untrusted directory falls back to default and write operations are denied *very quietly* (the task reports success but nothing changed), so the executor compares init.permissionMode and warns loudly on fallback. Usage is reported via total_credits (this engine\'s token fields may be 0).',
        engBadge: 'Engine', engLimitedFree: 'Limited-time free / region-limited', engModelOnly: 'Models are probed from this channel',
        chanEngineHintZcode: 'ZCode engine: supports mode (build/edit/plan/yolo) and memoryBench; thinking maps to ZCode reasoning-level.',
        chanEngineHintOpencode: 'OpenCode engine: no mode / memoryBench (never passed); thinking maps to OpenCode --variant; --auto is never added by default (the sub-agent will not auto-approve permissions) — to allow it, the dispatcher must pass auto=true explicitly, and the job row then shows an "auto-approved" badge; the free tier is IP rate-limited and every call spins up a temporary server (slow cold start), so its concurrency cap is separate and lower (default 2).',
        filtAvailable: 'Available only', filtAvailableHint: 'List only channels that are currently usable (off = also list unusable channels with their reason)',
        filtFree: 'Free only', filtFreeHint: 'List only channels that need no paid quota: the free tier (Start Plan) and OpenCode free models; personal keys and paid plan channels are hidden',
        filtHint: 'Filters: Available only (on by default; turn off to also see unusable channels) | Free only (off by default; turn on to keep only the free tier and OpenCode free models). They only change what these two dropdowns list — they never change the current selection.',
        filtCurrent: 'current selection',
        filter: 'Filter',
        filtHiddenA: 'Filters hidden ',
        filtHiddenB: ' of ',
        filtHiddenC: ' channels',
        chanLoading: 'Loading channel list… (host just started or first probe in flight; failures retry automatically, no refresh needed)',
        chanLoadRetry: 'will retry automatically', chanInfoPrefix: 'Channel notes: ',  zcRoutePlan: 'BigModel (Plan)', zcRouteFree: 'Start Plan (free)', zcFreeSuffix: 'free',
        autoApproved: 'auto-approved', autoApprovedHint: 'This job explicitly enabled OpenCode --auto: all permissions not explicitly denied were allowed (off by default; only takes effect when the caller sets it explicitly)',
        giftQuota: 'Free quota left', giftQuotaUnavailable: 'Free-quota balance unavailable', chanQuotaExhausted: '5h window full',
        jobCurrent: 'Now: ', jobLastBeat: 'last heartbeat', jobStalled: 'possibly stuck',
        jobStalledHint: 'No runner heartbeat/output for over 150s: it may be stuck on an upstream request, MCP connect or a lock. Kill and re-dispatch, or use action=tail for the last output.',
        chanOfflineHint: 'Host not connected: channel/model come from the host Remote face and unlock once connected',
        chanDefaultModel: '(channel default model)',  
        /* ZB-52: sequential dispatch (switch models in list order inside one engine).
         * ZB-52c: there is NO switch — selecting "Sequential dispatch" in "Model" is the switch
         * (main channel and fallback target each keep their own per-engine list).
         * These keys must match locale/en.json and locale/zh.json word for word (single-source.test.mjs ⑤). */
        seqTitle: 'Sequential dispatch', seqThinkingDefault: 'Set default', 
        seqHint: 'Selecting "Sequential dispatch" in "Model" IS the switch (there is no separate toggle): the list below is tried top to bottom, an error moves on to the next entry (quota exhausted / rate-limited pauses count too), and it only reports failure after the whole list is exhausted — auto fallback runs after that. The main channel and the fallback target are independent: an empty model on the main channel uses the main engine\'s list; otherwise an empty model on the fallback target uses the fallback engine\'s list (lists are stored per engine). The list applies to the engine currently shown (ZCode / OpenCode / Qoder each have their own). The "Effort" dropdown on each row sets that model\'s own thinking level ("Default" = the engine default) — the global effort setting is locked in sequential mode because models differ in supported levels. Note: switching models starts a NEW session; file changes already made are kept and the model is told to continue.',
        seqHintShort: 'Sequential dispatch: no model pinned, so an error switches to the next model down the list (main channel and fallback target each keep their own list)',
        seqOrderLabel: 'Try order',
        seqUp: 'Move up',
        seqDown: 'Move down',
        seqEmpty: '(No selectable models for this engine; an empty list means sequential dispatch has no effect)',
        seqUnavailable: ' (currently unavailable)',
        seqOfflineHint: 'Host not connected: the sequential order lives in the host work dir and unlocks once connected',
        /* D1: the dedicated in-conversation card for the `dispatch` tool call (tool.call.toolview).
         * These keys must match locale/en.json and locale/zh.json word for word (single-source.test.mjs ⑤). */
        tvTitle: 'Dispatch',
        tvPreparing: 'Dispatching…',
        tvDetail: 'Details',
        tvAction: 'Action',
        tvState: 'State',
        tvJobId: 'Job id',
        tvEngineCh: 'Engine / channel',
        tvTailHint: 'Use action=tail to read the output',
        tvJobs: 'Jobs',
        tvLines: 'lines',
        tvArgs: 'Raw input',
        tvResult: 'Raw result',
        tvRawOpen: 'Show raw text',
        tvRawClose: 'Hide raw text',
        tvTruncatedA: ' (truncated; full text is ',
        tvTruncatedB: ' characters)',
        tvEmpty: '(none)',
        seqLevelLabel: 'Effort', seqLevelDefault: 'Default',
        /* ZB-54（bundle config card: edit BY ENGINE）：one-line hint + whether this engine is in use.
         * Must match locale/en.json and locale/zh.json word for word (single-source.test.mjs ⑤). */
        seqHintCard: 'Tries the list below top to bottom: an error moves on to the next entry; switching models starts a NEW session',
        seqUseMain: 'The main channel is using this list',
        seqUseFallback: 'The fallback target is using this list',
        seqUseBoth: 'Both the main channel and the fallback target use this list',
        seqUseNone: 'Not active yet: pick "Sequential dispatch" in Model to try this list',
        /* ZB-55: loading state / saving feedback / table column labels (shared by card + panel). */
        seqLoading: 'Loading channels and models…', seqSaving: 'Saving…', seqSortCol: 'Order',
        /* ZB-58: per-model enable switch column + "off" tag + available counter in the block header. */
        modelSwitchCol: 'Available', modelDisabledTag: 'Off', modelAvailCount: '{n}/{total} available',
        paused: 'Paused', pQuota: 'Quota exhausted', pEntitled: 'Not entitled', pSigning: 'Signing required', pConfig: 'Config error', pUnknown: 'Unknown',
        lockWait: 'Queue wait', timedOut: 'Timed out',
        timedOutRunner: 'runner timeout (exit 124, --timeout-min elapsed)', timedOutWatchdog: 'watchdog kill (still running after timeoutMin+120s grace)',
        resumeSame: 'Resume (same channel)', retryHandoff: 'Rerun on new channel', noSession: 'No session to resume',
        handoffConfirm: 'Channel switch = handoff rerun: a new session starts and the unfinished part is handed over', confirmHandoff: 'Confirm handoff', cancel: 'Cancel',
        parentFrom: 'continued from', hop: 'hop',
        fallbackTitle: 'Auto fallback', fallbackStateOff: 'Off', fallbackStateOn: 'On',
        fallbackEnableTitle: 'Auto fallback: click to enable/disable. When enabled, quota-exhausted / not-entitled / signing-required pauses hand off to the target chosen below (downstream quota is consumed)',
        fallbackHint: 'Same option logic as the Channels section above: empty model = that channel\'s default model; "Agent decides" resolves via ZCode\'s default rule. New sessions only.',
        fallbackOfflineHint: 'Host not connected: fallback settings live in the host work dir and unlock once connected',
        switchOn: 'Dispatch: on', switchOff: 'Dispatch: off', switchUnknown: 'Dispatch: ?',
        switchTitle: 'Dispatch master switch: click to toggle (writes collab/dispatch.switch.json, effective for all sessions)',
        switchHintOffline: 'Host not connected: run dispatch-switch.mjs in a terminal to toggle',
        switchOffBlocked: 'Dispatch master switch is off: all dispatch entries are rejected; re-enable via the title-bar switch or dispatch-switch.mjs',
      },
    };
    const LANG = (() => {
      let s = 'zh';
      try {
        s = (typeof navigator !== 'undefined' && navigator.language) || (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || 'zh';
      } catch { /* 保留默认 */ }
      return String(s).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
    })();
    const t = (k) => STRINGS[LANG][k] ?? STRINGS.zh[k] ?? k;
    /** ZB-58：带占位符的文案（`{n}` / `{total}` …）—— `t()` 只做静态查表，这里补一层极简替换。
     *  占位符缺失时保留原文（`{n}` 原样可见 = 可读的失败信号，不静默变成空串）。 */
    const tFmt = (k, vars) => String(t(k)).replace(/\{(\w+)\}/g, (m0, name) => (vars && vars[name] != null ? String(vars[name]) : m0));

    /* ─────────────── 引擎归一（**模块级唯一权威**）───────────────
     * ZB-51：原先到处写 `c.engine === 'opencode' ? 'opencode' : 'zcode'` —— 二元判断，
     * 第三个引擎（qoder）一来就被**错误地归进 ZCode 组**（下拉分组 / 徽标 / 提示全错），且不报错。
     *
     * ⚠️ 这几个必须放在**模块级**（而不是某个组件函数里）：
     *   `foldChannels`（通道折叠）在 `ChannelSection` 里用到它们，而组件内的 `const` 有 TDZ ——
     *   曾把 `engineOf` 留在组件函数里 ⇒ 真渲染时 `ReferenceError: Cannot access 'engineOf'
     *   before initialization`（`node --check` 查不出来，靠 fallback-ui 的真 DOM 渲染才暴露）。 */
    const KNOWN_ENGINES = ['zcode', 'opencode', 'qoder'];
    const engineOf = (v) => {
      const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
      return KNOWN_ENGINES.includes(s) ? s : 'zcode';
    };
    const ENG_LABEL_KEY = { zcode: 'engZcode', opencode: 'engOpencode', qoder: 'engQoder' };
    const engLabel = (e) => t(ENG_LABEL_KEY[engineOf(e)]);
    /* ZB-51：ZCode 的「模型」下拉里其实列的是**路由**（Plan / 免费额度）——
     * 因为它们提供同样的模型名，按模型名去重会互相覆盖（真机反馈"ZCode 怎么剩 1 个？"）。
     * 这里给出路由 → 文案的映射（**单一源**，上方「通道」与下方降级区共用）。 */
    const ROUTE_LABEL_KEY = { plan: 'zcRoutePlan', 'account:bigmodel-start-plan': 'zcRouteFree' };
    /** **免费额度（Start Plan）实际可用的模型**（用户实测：只给 GLM-5.3-Flash）。
     *  ZCode 配置里两条路由声明了同样的模型名，故"哪些真能用"只能在这里收窄 —— 权益变化时改这一行。 */
    const ZC_FREE_MODELS = ['GLM-5.3-Flash'];
    /** 模型项显示文案：
     *  · ZCode：`<模型名>`，若该模型来自免费额度路由则加后缀「免费」（同名模型不会混淆）；
     *  · 其它引擎：模型名本身（它们一个模型一条通道，不存在路由维度）。 */
    const modelLabelFor = (engine, routeOf, modelOf, m) => {
      if (engine === 'zcode') {
        const routeId = (routeOf && routeOf[m]) || '';
        const model = (modelOf && modelOf[m]) || String(m);
        return routeId === 'account:bigmodel-start-plan' ? `${model}「${t('zcFreeSuffix')}」` : model;
      }
      return String(m);
    };
    /* job 的引擎判据（与 core 的 `resolveEngineOf()` **顺序一致**）：
     * ① job.engine（core 落库，最权威）② spec.engine ③ provider 形态（`qoder/<m>` / `opencode/<m>` / 裸名）
     * ④ 兜底 zcode。旧记录没有这些字段 ⇒ 显示 ZCode（与事实相符）。
     *
     * ⚠️ provider 要看**两处**：`spec.provider`（面板快照的 slimJob 形状）与**顶层 `job.provider`**
     * （`action=list` 的 **brief 形状没有 `spec`** —— 宿主 briefJob() 把 provider 放在顶层）。
     * 只读 spec.provider 会让 brief 形状的 job 一律回落成 zcode（审计 R2a：卡片/列表与面板显示不一致）。
     * 顺序仍是"spec 优先、顶层兜底"，故对既有快照路径**零行为变化**。 */
    const jobEngineOf = (job) => {
      const spec = job?.spec ?? {};
      for (const v of [job?.engine, spec.engine]) {
        const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
        if (KNOWN_ENGINES.includes(s)) return s;
      }
      for (const raw of [spec.provider, job?.provider]) {
        const p = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
        if (!p) continue;
        if (p.startsWith('opencode/') || p === 'opencode') return 'opencode';
        if (p.startsWith('qoder/') || p === 'qoder' || p === 'qoder-cn' || p === 'qoder-global') return 'qoder';
      }
      return 'zcode';
    };

    /* ─────────────── 小工具 ─────────────── */
    const loadJson = (key, fallback) => {
      try {
        const v = window.localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch {
        return fallback; // 隐私模式 / 被禁用：用默认值
      }
    };
    const saveJson = (key, value) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch { /* 写不进就算了 */ }
    };
    const fmtTokens = (n) => {
      if (n == null) return '—';
      if (n < 1000) return String(n);
      if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)}k`;
      return `${(n / 1000000).toFixed(2)}M`;
    };
    /* ZB-13（用户要求）：耗时展示改为「XX时XX分XX秒」——**三段恒定输出**，不省略零位。
     * 只改**展示层** —— 数据层的 elapsedSec/heldSec 仍是秒数（number），
     * 那是契约字段（core / wire / CLI 都按秒读写），不能在渲染里改语义。
     * 恒定三段的好处：列表里宽度一致、一眼可比（用户原话即此格式）。 */
    const fmtSec = (s) => {
      if (s == null) return '—';
      const total = Math.max(0, Math.floor(Number(s) || 0));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const sec = total % 60;
      return `${h}时${String(m).padStart(2, '0')}分${String(sec).padStart(2, '0')}秒`;
    };
    const shortId = (id) => (id ? String(id).slice(0, 12) : '—');
    /* ZB-18（用户要求：进程那里应该显示整仓库锁或者文件锁进行区分）：
     * 把 job 的锁归类成可读类型 + 受影响文件列表（纯函数，便于独立测试）。
     *
     * 输入是**已持久化的 job**，可能来自旧版本（如 lock='repo+memory' 的 ZB-15 记录），
     * 故这里按"能识别就识别、识别不出按原始值显示"处理，不假设字段一定存在。
     *
     * @returns {{kind:'repo'|'file'|'none'|'legacy', label:string, files:string[], detail:string}}
     *   kind:  repo=整仓库锁 / file=文件锁 / none=未持锁 / legacy=旧版本记录
     *   label: 徽标上显示的短文本
     *   files: 文件锁覆盖的文件（从 spec.write 或 lock 字符串里的 file: 前缀解析）
     */
    function lockKindOf(job) {
      const lock = job && job.lock != null ? String(job.lock) : '';
      const declared = Array.isArray(job && job.spec && job.spec.write) ? job.spec.write.filter(Boolean) : [];
      if (!lock) return { kind: 'none', label: '', files: [], detail: '' };
      /* 旧版本记录（含 memory）——如实标注为"旧版锁"，不假装是新模型 */
      if (/memory/.test(lock)) {
        return { kind: 'legacy', label: lock, files: declared, detail: `${lock}（旧版本记录：memory 锁已于 ZB-16 删除）` };
      }
      /* 文件锁：lock 形如 `file:<path>` 或多个用 + 连接；文件列表优先取 spec.write（更完整） */
      if (/(^|\+)file:/.test(lock)) {
        const fromLock = lock.split('+').filter((x) => x.startsWith('file:')).map((x) => x.slice(5));
        const files = declared.length ? declared : fromLock;
        return {
          kind: 'file',
          label: files.length > 1 ? `文件锁 ${files.length}` : '文件锁',
          files,
          detail: `文件锁：只锁这些文件 ⇒ 与写其它文件的任务可并发\n${files.join('\n')}`,
        };
      }
      if (lock === 'repo') {
        return { kind: 'repo', label: '整仓库锁', files: [], detail: '整仓库锁：未声明要写的文件 ⇒ 与任何任务互斥（单写者本义）' };
      }
      if (lock === 'none') return { kind: 'none', label: '不取锁', files: [], detail: '明确不取锁（调用方确认无竞写关系）' };
      return { kind: 'legacy', label: lock, files: declared, detail: `未知锁形态：${lock}` };
    }
    /* ZB-14（用户要求）：上下文占用由「90%」改为**绝对值**「180.9k / 200k」——
     * 百分比只说明"快满了"，绝对值才能一眼看出还剩多少 token 可用。
     * 精度取舍：k 档保留 **1 位小数**，且**截断而非四舍五入** ——
     * 用户举例的 180973 应显示 `180.9k`；若用 toFixed(1) 会四舍五入成 `181.0k`（与预期不符）。
     * 截断还有一个好处：显示值**不会超过真实值**，不会出现"显示 200.0k 但实际只用了 199.98k"这种误导。
     * 注意：这里**不复用 fmtTokens** —— 它在 <10000 时给 2 位小数（29.0k/29.1k 抖动），
     * 且同样用四舍五入；上下文用量需要稳定的一位截断精度，故独立实现。 */
    const fmtCtx = (n) => {
      if (n == null || !Number.isFinite(Number(n))) return '—';
      const v = Math.max(0, Number(n));
      if (v < 1000) return String(Math.round(v));
      if (v < 1000000) return `${(Math.floor(v / 100) / 10).toFixed(1)}k`; // 截断到 0.1k
      return `${(Math.floor(v / 10000) / 100).toFixed(2)}M`; // 截断到 0.01M
    };
    /** 上下文占用：`已用 / 上限`（如 `180.9k / 200k`）；任一缺失则显示 —。 */
    const ctxLabel = (j) => {
      if (!j || j.contextUsed == null || !j.contextWindow) return '—';
      return `${fmtCtx(j.contextUsed)} / ${fmtCtx(j.contextWindow)}`;
    };
    // Z11：长文本截断展示（详情区 prompt 最多 1200 字符）；时间本地化
    const clampText = (s, n) => {
      const str = s == null ? '' : String(s);
      return str.length > n ? `${str.slice(0, n)}…` : str;
    };
    const fmtTime = (iso) => {
      if (!iso) return '—';
      try {
        return new Date(iso).toLocaleString();
      } catch {
        return String(iso);
      }
    };
    /* 交互元素判定（模块级：拖拽守卫与 JobRow 行头点击守卫共用同一实现）。
     * Z9 教训：可点击区域内嵌按钮时，事件必须先 closest 守卫，否则子按钮点击被外层吃掉。 */
    const isInteractive = (el) => !!(el && typeof el.closest === 'function' && el.closest('button,input,select,textarea,a,[role="button"]'));

    /* apply(ctx) 捕获的客户端 ctx：createWire 用它探测远端面（模块级唯一；
     * apply 先于组件挂载执行，浅渲染等无 ctx 场景保持 null = 远端缺席 → 降级）。 */
    let MOD_CTX = null;

    /* ─────────────── 远端面就绪信号（ZB-01 ②：修「异步 $mount vs 一次性探测」竞态）───────────────
     * 事实：ctx.remote.$mount() 是**异步**的（gateway client `async $mount` → installNamespace →
     * createNamespace 在其 fiber 的 apply 里才同步装出 remote.<namespace>），而 useWire 的 useRef
     * 只在**首次渲染**建一次 wire。两者竞态 → 首次探测落空 → 面板被永久锁在 offline 降级态。
     * 正解（whale-pet 实证：真实可用的第三方插件 client.js:2217-2241）：**子 fiber**
     * ctx.inject(['remote.dispatch'], …) —— 命名空间出现即回调，既有序又不阻塞启动；
     * 顶层 inject 仍只有基础服务，绝不声明自家 remote.*（否则等于等自己 → pending → web boot 失败）。 */
    let REMOTE_SVC = null;
    const remoteWaiters = new Set();
    /** $mount 结果留痕：离线态提示据此给出可读原因（不猜）。 */
    const MOUNT_DIAG = { attempted: false, ok: null, error: null };
    let REMOTE_READY = false; // ZB-28b：就绪旗标 —— waiter 注册晚于就绪时补投，防消费者永远停在降级 wire
    function markRemoteReady(svc) {
      if (svc) REMOTE_SVC = svc;
      REMOTE_READY = true;
      for (const fn of [...remoteWaiters]) {
        try { fn(); } catch { /* 单个订阅者异常不影响其他 */ }
      }
    }
    function onRemoteReady(fn) {
      remoteWaiters.add(fn);
      /* ZB-28b：**补投** —— 若就绪早于本消费者挂载（旗标已立），立即触发一次。
       * 否则这个消费者的 epoch 永远不 bump：首帧建成降级 wire 时 remote 恰好已就绪的
       * 竞态窗口里，它会一直拿着降级 wire（旧代码此窗口内 markRemoteReady 空放）。 */
      if (REMOTE_READY) {
        try { fn(); } catch { /* ignore */ }
      }
      return () => remoteWaiters.delete(fn);
    }

    /* ─────────────── 远端面传输层（Z8 接线段；同源实现：wire.client.mjs）───────────────
     * 官方调用链（证据见 tasks/Z8-delivery.md）：client 模块 inject 声明 "remote" 后，
     * apply 里 ctx.remote.$mount({package, descriptors}) 挂出 remote.dispatch
     * 子服务（官方包由 dsh 构建期内联进 api-remotes 聚合，第三方本地包须自挂——
     * extracted/dsh-api-remotes/lib/client.js:13513-13538 与 api-gateway client
     * $mount 的公开形态）。调用 ctx.remote.dispatch.<方法>(...) 返回
     * { ok:true, value } / { ok:false, error }（业务/载体失败折进 error 分支，
     * 绝不 reject——extracted/dsh-api-gateway/lib/client.js:1786-1806）。 */
    const REMOTE_POLL_MS = 1000;
    const REMOTE_JSON_ANY = Object.freeze({ parse: (value) => value });
    // 与 wire.host.mjs FACE_METHOD_TABLE 同源：[方法, 参数, 可选参数]
    const REMOTE_METHOD_TABLE = [
      ['snapshot', [], []],
      ['dispatch', ['spec'], []],
      ['kill', ['id'], []],
      ['dismiss', ['id'], []],
      ['retry', ['id', 'opts'], ['opts']],
      ['tail', ['id', 'n'], ['n']],
      ['setChannel', ['next'], ['next']],
      ['setFallbackChain', ['list'], ['list']],
      ['switchGet', [], []],
      ['switchSet', ['next'], ['next']],
      ['quota', [], []],
      ['quotaPlan', [], []],
      ['channels', [], []],
      ['channel', [], []],
      ['fallbackChain', [], []],
      /* ZB-52：顺序派发读/写（面板入口）。⚠️ 本表与 host 面 `REMOTE_METHODS`、
       * `wire.client.mjs` 的 descriptors **方法集必须逐字相等** —— 由
       * `test/single-source.test.mjs` ③ 守门（历史上曾漏 dismiss 造成三表漂移）。 */
      ['sequentialGet', [], []],
      ['sequentialSet', ['patch'], ['patch']],
      /* ZB-58：逐模型开关（关掉的模型不出现在面板选项里、也不参与顺序派发）。
       * host 面 `modelSwitchesGet/modelSwitchSet` 与 `wire.client.mjs` 描述符已由 Lead 落地，
       * 本内联表必须同步（`single-source.test.mjs` ③ 钉死三表相等，缺失即 17 vs 19 报错）。 */
      ['modelSwitchesGet', [], []],
      ['modelSwitchSet', ['patch'], ['patch']],
    ];
    const remoteCodec = (method, field) => ({
      mode: 'strict',
      typeSymbol: `dsh-dispatch#dispatch/${method}:${field}`,
      create: () => REMOTE_JSON_ANY,
    });
    // $mount 贡献项（客户端注册表校验要求 strict codec 字段齐备；acceptsUndefined
    // 允许 JSON 可选参数缺参——网关 assertExactArguments 按它放行）
    const REMOTE_CONTRIBUTION = {
      package: 'dsh-dispatch',
      descriptors: REMOTE_METHOD_TABLE.map(([method, params, optionals]) => ({
        id: `dsh-dispatch#dispatch/${method}`,
        service: 'dispatch',
        namespace: 'dispatch',
        method,
        invocation: { kind: 'direct' },
        parameters: params.map((name) => ({
          name,
          wire: name,
          source: 'json',
          ...(optionals.includes(name) ? { acceptsUndefined: true } : {}),
          codec: remoteCodec(method, name),
        })),
        result: remoteCodec(method, 'result'),
      })),
    };

    /** 探测远端面子服务；有 snapshot() 即视为可用。
     * ZB-01：优先用子 fiber 回调拿到的实例（REMOTE_SVC，命名空间就绪的权威来源），
     * 其次才是 ctx 上的即时探测（兜底：apply 早于/晚于 mount 的两种时序都能命中）。 */
    function resolveRemote(ctx) {
      const svc = REMOTE_SVC ?? ctx?.remote?.dispatch ?? ctx?.remote?.['dispatch'];
      if (!svc || typeof svc.snapshot !== 'function') return null;
      const call = async (method, ...args) => {
        if (typeof svc[method] !== 'function') throw new Error(`远端面缺少方法 ${method}()`);
        const raw = await svc[method](...args);
        // 官方代理把返回值包成 { ok, value } / { ok:false, error }；本进程直连 face
        // 是域形状。有 value 键才按信封拆包（判据：boolean ok + own value 键）。
        if (raw && typeof raw === 'object' && typeof raw.ok === 'boolean' && 'value' in raw) {
          return raw.ok ? raw.value : { ok: false, error: raw.error?.message ?? String(raw.error ?? 'remote error') };
        }
        return raw;
      };
      return { call };
    }

    /* ─────────────── ZB-52：顺序派发的**形状归一**（三引擎键恒在） ───────────────
     * core 的 `getSequential()` 契约：`{order:{zcode:[],opencode:[],qoder:[]}, levels:{…}, sequentialCount}`；
     * 元素形态 = 「模型」下拉的模型项 key：
     *   · ZCode：`<路由id>::<模型名>`（如 `plan::GLM-5.3`）；
     *   · OpenCode / Qoder：`opencode/<model>` / `qoder/<model>`（core 就是这样建的通道 models）。
     * 远端 face / ext / demo 三条路径共用本函数 ⇒ 单一源，不会出现"某条路径少一个引擎键"。
     *
     * ⚠️ ZB-52c（用户要求去掉开关）：**没有 `enabled` 字段** —— "是否顺序派发"由
     * 「模型」下拉的值表达（模型为空即顺序派发），`normSeqShape` 不再产出/保留它，
     * 免得面板里又出现"开关状态"这第二个真相。
     *
     * ZB-52b（用户要求「顺序思考强度档位设置」）：`levels[engine]` 与 `order[engine]` **同序**，
     * 每项 = 该模型自己的思考强度档位（`null` = 用引擎默认档位）。旧数据源没有 levels ⇒ 全 null
     * （照常渲染成「默认」，**绝不猜**档位）。order 项同时接受字符串（旧格式）与对象
     * `{route, reasoningLevel}`（core 的 setSequential 两种都收），对象里的档位优先。
     *
     * ⚠️ 必须是**模块级**且定义在**所有使用点之前**：模块级 `const` 的"声明前使用"会被
     * `test/client-tdz.test.mjs` 判为违规（remoteWire 在下方，必须晚于本行）。 */
    const normSeqShape = (v) => {
      const src = v && typeof v === 'object' ? v : {};
      const raw = src.order && typeof src.order === 'object' ? src.order : {};
      const rawLevels = src.levels && typeof src.levels === 'object' ? src.levels : {};
      const order = {};
      const levels = {};
      for (const eng of KNOWN_ENGINES) {
        const list = Array.isArray(raw[eng]) ? raw[eng] : [];
        const stored = Array.isArray(rawLevels[eng]) ? rawLevels[eng] : [];
        const routes = [];
        const lvs = [];
        list.forEach((x, i) => {
          const route = typeof x === 'string'
            ? x.trim()
            : String(x && typeof x === 'object' ? (x.route ?? x.id ?? '') : '').trim();
          if (!route) return; // 空项丢弃；order/levels 同时跳过 ⇒ 两者保持同序
          const inline = x && typeof x === 'object' && x.reasoningLevel != null ? x.reasoningLevel : null;
          const rawLv = inline != null ? inline : stored[i];
          routes.push(route);
          lvs.push(typeof rawLv === 'string' && rawLv.trim() !== '' ? rawLv.trim() : null);
        });
        order[eng] = routes;
        levels[eng] = lvs;
      }
      return {
        order,
        levels,
        sequentialCount: Object.values(order).reduce((n, l) => n + l.length, 0),
      };
    };

    /* ─────────────── ZB-58：逐模型开关的**形状归一** ───────────────
     * core 的 `getModelSwitches()` / `setModelSwitch(patch)` 契约：
     *   `{ disabled: [路由id...], userDisabledCount }` —— **禁用清单**（不是启用清单，上游新模型默认可用）。
     * 远端 face / ext / demo 三条路径共用本函数，保证面板拿到的形状一致；
     * `disabled` 一律归一成去重、去空、字符串数组（顺序保留，便于稳定渲染与断言）。
     * ⚠️ 与 `normSeqShape` 同理必须是模块级、定义在所有使用点之前（client-tdz 守门）。 */
    const normModelSwitchShape = (v) => {
      const src = v && typeof v === 'object' ? v : {};
      const disabled = [];
      const seen = new Set();
      for (const raw of Array.isArray(src.disabled) ? src.disabled : []) {
        const id = String(raw == null ? '' : raw).trim();
        if (!id || seen.has(id)) continue; // 空项/重复项丢弃（不静默造出假路由）
        seen.add(id);
        disabled.push(id);
      }
      return { disabled, userDisabledCount: disabled.length };
    };

    /** 远端数据源 wire（conn='live'，真数据）：1s 轮询快照 + $on 抢答，动作与 face 同形。 */
    function remoteWire(ctx, remote) {
      const subs = new Set();
      const emit = (bundle) => {
        for (const fn of subs) {
          try {
            fn(bundle);
          } catch { /* 订阅者异常不影响其他 */ }
        }
      };
      let pollTimer = null;
      let pushOff = null;
      let planQuota = null;
      let planTried = false;
      // 套餐剩余适配器慢（≈2s 起子进程）：每次 wire 生命周期只取一次，随下一个 tick 进包
      const refreshPlan = async () => {
        planTried = true;
        try {
          const r = await remote.call('quotaPlan');
          planQuota = r?.planQuota ?? null;
        } catch {
          planQuota = { available: false, reason: 'quotaPlan 调用失败' };
        }
      };
      /* 单次 RPC 的**兜底超时**：真实事故是 `snapshot` 卡住 ⇒ `tick()` 永远停在 await 上、
       * 一包都不发 ⇒ 面板卡在「连接中」、进程/用量全区空白（用户报「有时没有进程」）。
       * 有超时后最坏情况也只是发一包 `snapshot:null`（下面那条 catch 分支），轮询继续、UI 自愈。 */
      const RPC_TICK_TIMEOUT_MS = 8000;
      const withTimeout = (p, ms) => new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`RPC 超时（${ms}ms 无响应）`)), ms);
        Promise.resolve(p).then(
          (v) => { clearTimeout(t); resolve(v); },
          (e) => { clearTimeout(t); reject(e); },
        );
      });
      /* **保留最后一包好快照**：远端抖动时若发 `snapshot:null`，进程列表会当场变成
       * 「暂无进程记录」、再下一拍又恢复 —— 用户看到的就是"进程有时没有"（真机报告）。
       * 故只有"一次都没成功过"时才发 null（此时确实没有数据可显示）。 */
      let lastGoodSnapshot = null;
      const tick = async () => {
        try {
          const snapshot = await withTimeout(remote.call('snapshot'), RPC_TICK_TIMEOUT_MS);
          lastGoodSnapshot = snapshot;
          let quota = null;
          try {
            quota = (await withTimeout(remote.call('quota'), RPC_TICK_TIMEOUT_MS))?.quota ?? null;
          } catch { /* 用量失败不挡快照 */ }
          emit({ conn: 'live', snapshot, quota, planQuota });
        } catch (e) {
          // 远端抖动：**沿用上一包好快照**（有就保留，没有才给 null），绝不抛出、绝不白屏
          emit({ conn: 'live', snapshot: lastGoodSnapshot, quota: null, planQuota, error: e?.message ?? String(e) });
        }
      };
      /* 与宿主 face 同形的调用（一一对应；错误照 face 契约 reject/折信封） */
      const face = {
        snapshot: () => remote.call('snapshot'),
        quota: () => remote.call('quota'),
        quotaPlan: () => remote.call('quotaPlan'),
        channels: () => remote.call('channels'),
        channel: () => remote.call('channel'),
        fallbackChain: () => remote.call('fallbackChain'),
        dispatch: (spec) => remote.call('dispatch', spec && typeof spec === 'object' ? spec : {}),
        kill: (id) => remote.call('kill', id),
        dismiss: (id) => remote.call('dismiss', id),
        retry: (id, opts) => remote.call('retry', id, opts && typeof opts === 'object' ? opts : {}),
        tail: (id, n) => remote.call('tail', id, n),
        setChannel: (next) => remote.call('setChannel', next && typeof next === 'object' ? next : {}),
        setFallbackChain: (list) => remote.call('setFallbackChain', list == null ? null : list),
        /* ZB-52：顺序派发读/写（host 面 `sequentialGet` / `sequentialSet(patch)`）。
         * patch 只带 `{enabled}` 或 `{order}` 之一 —— host 侧按缺键保持另一项不动。 */
        sequentialGet: () => remote.call('sequentialGet'),
        sequentialSet: (patch) => remote.call('sequentialSet', patch == null ? null : patch),
        /* ZB-58：逐模型开关（host 面 `modelSwitchesGet` / `modelSwitchSet(patch)`）。
         * 读 = 禁用清单 `{disabled, userDisabledCount}`；写 patch = `{route, enabled}` 或 `{disabled:[...]}`。 */
        modelSwitchesGet: () => remote.call('modelSwitchesGet'),
        modelSwitchSet: (patch) => remote.call('modelSwitchSet', patch == null ? null : patch),
        // Z12：派发总开关（switchGet 读状态；switchSet 走宿主唯一写入口）
        switchGet: () => remote.call('switchGet'),
        switchSet: (next) => remote.call('switchSet', next && typeof next === 'object' ? next : {}),
      };
      // 旧接口（UI 信封：永不 reject）。别名方法不能在对象字面量里互相引用方法名
      // （属性不是作用域绑定，pitfalls Z7-1），先落局部函数。
      const errOf = (e) => ({ ok: false, error: e?.message ?? String(e) });
      const channelSetImpl = async (c = {}) => {
        try {
          return await face.setChannel(c);
        } catch (e) {
          return errOf(e);
        }
      };
      const fallbackSetImpl = async (target) => {
        try {
          /* ZB-30：对象 = 单目标（面板）；null = 关闭；数组 = 旧形状（多目标，CLI 用）。 */
          return await face.setFallbackChain(target ?? null);
        } catch (e) {
          return errOf(e);
        }
      };
      /* ZB-52：顺序派发写（`{enabled}` 或 `{order}` 单传；另一项由 core 保持不变）。
       * 非对象 patch 归一成 `{}` ⇒ host 侧会把「需要对象」如实报错回来，不静默改配置。 */
      const sequentialSetImpl = async (patch) => {
        try {
          return await face.sequentialSet(patch && typeof patch === 'object' ? patch : {});
        } catch (e) {
          return errOf(e);
        }
      };
      const stopPush = () => {
        if (pushOff != null) {
          try {
            pushOff();
          } catch { /* 已失效 */ }
          pushOff = null;
        }
      };
      return {
        kind: 'remote', // ZB-28b：useWire 自愈判据用（非 remote 且远端可解析 ⇒ 重建）
        subscribe(cb) {
          if (typeof cb !== 'function') throw new TypeError('subscribe(cb): cb 必须是函数');
          subs.add(cb);
          if (!planTried) refreshPlan();
          tick();
          if (pollTimer == null) pollTimer = setInterval(tick, REMOTE_POLL_MS);
          // 推送通道：$on 可用就挂上（官方事件订阅形状），到包即刷；轮询仍是正确性兜底
          if (pushOff == null && typeof ctx?.remote?.$on === 'function') {
            try {
              pushOff = ctx.remote.$on('dispatch/changed', () => {
                try {
                  tick();
                } catch { /* 抢答失败由轮询兜底 */ }
              });
            } catch {
              pushOff = null;
            }
          }
          return () => {
            subs.delete(cb);
            if (subs.size === 0) {
              if (pollTimer != null) {
                clearInterval(pollTimer);
                pollTimer = null;
              }
              stopPush();
            }
          };
        },
        async dispatch(spec = {}) {
          try {
            return await face.dispatch(spec);
          } catch (e) {
            return errOf(e);
          }
        },
        async kill(id) {
          try {
            return await face.kill(id);
          } catch (e) {
            return errOf(e);
          }
        },
        async dismiss(id) {
          try {
            return await face.dismiss(id);
          } catch (e) {
            return errOf(e);
          }
        },
        async retry(id, opts = {}) {
          try {
            return await face.retry(id, opts);
          } catch (e) {
            return errOf(e);
          }
        },
        async tail(id, n) {
          try {
            const lines = await face.tail(id, n);
            return { ok: true, id, lines };
          } catch (e) {
            return errOf(e);
          }
        },
        async channels() {
          try {
            const r = await face.channels();
            /* ZB-56：`levelsStatus`（逐引擎档位探测状态 ready/pending/none）由 core 挂在**顶层** ——
             * 这里必须原样透传，面板/配置卡才能如实显示「档位载入中…」而不是"只有默认"。 */
            return {
              ok: true,
              channels: r?.channels ?? [],
              warnings: r?.warnings ?? [],
              levelsStatus: r?.levelsStatus ?? null,
            };
          } catch (e) {
            return errOf(e);
          }
        },
        async channelGet() {
          try {
            return { ok: true, channel: await face.channel() };
          } catch (e) {
            return errOf(e);
          }
        },
        channelSet: (c) => channelSetImpl(c),
        async fallbackGet() {
          try {
            const r = await face.fallbackChain();
            return {
              ok: true,
              enabled: Boolean(r?.enabled),
              chain: Array.isArray(r?.chain) ? r.chain : [],
              targets: Array.isArray(r?.targets) ? r.targets : [], // ZB-30
              target: r?.target ?? null,
            };
          } catch (e) {
            return errOf(e);
          }
        },
        fallbackSet: (chain) => fallbackSetImpl(chain),
        /* ZB-52：顺序派发读/写。读值经 `normSeqShape` 归一（三引擎键恒在、只留非空字符串）——
         * 与 ext / demo 两条路径**同一形状**，面板不必按数据源分支。 */
        async sequentialGet() {
          try {
            return { ok: true, ...normSeqShape(await face.sequentialGet()) };
          } catch (e) {
            return errOf(e);
          }
        },
        sequentialSet: (patch) => sequentialSetImpl(patch),
        /* ZB-58：逐模型开关读/写（面板「可用」开关 + 「模型」下拉过滤的数据源）。
         * 读/写都归一到 `normModelSwitchShape`（`{disabled,userDisabledCount}`），失败折 `{ok:false,error}`。 */
        async modelSwitchesGet() {
          try {
            return { ok: true, ...normModelSwitchShape(await face.modelSwitchesGet()) };
          } catch (e) {
            return errOf(e);
          }
        },
        async modelSwitchSet(patch) {
          try {
            return { ok: true, ...normModelSwitchShape(await face.modelSwitchSet(patch && typeof patch === 'object' ? patch : {})) };
          } catch (e) {
            return errOf(e);
          }
        },
        // 与宿主 face 同名对齐（转发旧实现，语义一致）
        setChannel: (c) => channelSetImpl(c),
        setFallbackChain: (l) => fallbackSetImpl(l),
        // Z12：派发总开关（switchGet 数据对象折成 {ok:true, switch}；switchSet 透传宿主信封）
        async switchGet() {
          try {
            return { ok: true, switch: await face.switchGet() };
          } catch (e) {
            return errOf(e);
          }
        },
        async switchSet(next = {}) {
          try {
            return await face.switchSet(next);
          } catch (e) {
            return errOf(e);
          }
        },
        dispose() {
          subs.clear();
          if (pollTimer != null) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          stopPush();
        },
      };
    }

    /* ─────────────── 降级 wire（ext/demo/offline；同源实现：wire.client.mjs）───────────────
     * 远端面缺席时的降级顺序（legacyWire 选择器）：
     * 1) window.__dispatchDemo === 'builtin' → 内置演示引擎（conn='demo'，排查用，默认关）；
     * 2) window.__dispatchDemo 为外部数据源对象（含 getSnapshot()）→ extWire（conn='ext'）；
     * 3) 都没有 → offlineWire（conn='offline'，Z11 诚实空态：无假行、无定时器）。 */
    function legacyWire() {
      const flag = typeof window !== 'undefined' ? window.__dispatchDemo : null;
      if (flag === 'builtin') return demoWire();
      if (flag && typeof flag === 'object' && typeof flag.getSnapshot === 'function') return extWire(flag);
      return offlineWire();
    }

    /* 外部数据源 wire（conn='ext'）：轮询注入的 window.__dispatchDemo 对象。 */
    function extWire(ext) {
      if (!ext || typeof ext.getSnapshot !== 'function') return null;
      const subs = new Set();
      let timer = null;
      const call = async (name, ...args) => {
        if (typeof ext[name] !== 'function') return { ok: false, error: `外部数据源未提供 ${name}()` };
        try {
          return await ext[name](...args);
        } catch (e) {
          return { ok: false, error: e?.message ?? String(e) };
        }
      };
      return {
        kind: 'ext', // ZB-28b
        subscribe(cb) {
          subs.add(cb);
          const poll = () => {
            try {
              const bundle = {
                conn: 'ext',
                snapshot: ext.getSnapshot(),
                quota: typeof ext.getQuota === 'function' ? ext.getQuota() : null,
                planQuota: typeof ext.getPlanQuota === 'function' ? ext.getPlanQuota() : null,
              };
              for (const fn of subs) fn(bundle);
            } catch { /* 外部源抖动一拍不致命 */ }
          };
          poll();
          timer = setInterval(poll, 2000);
          return () => {
            subs.delete(cb);
            if (subs.size === 0 && timer != null) {
              clearInterval(timer);
              timer = null;
            }
          };
        },
        dispatch: (spec) => call('dispatch', spec),
        kill: (id) => call('kill', id),
        dismiss: (id) => call('dismiss', id),
        tail: (id, n) => call('tail', id, n),
        // Z6 增量：外部源未提供这些方法时 call() 返回 {ok:false,error}，UI 自行降级
        channels: () => call('channels'),
        channelGet: () => call('channel', {}),
        channelSet: (c) => call('channel', c ?? {}),
        retry: (id, opts) => call('retry', { id, ...(opts ?? {}) }),
        fallbackGet: () => call('fallback', {}),
        fallbackSet: (target) => call('fallback', { chain: target ?? null }),
        /* ZB-52：外部源未提供 `sequential()` 时 call() 返回 {ok:false,error}，UI 自行降级为只读
         * （与 fallback 同范式：读传空对象、写把 patch 原样透传）。 */
        sequentialGet: () => call('sequential', {}),
        sequentialSet: (patch) => call('sequential', patch ?? {}),
        /* ZB-58：逐模型开关（外部源未提供时 call() 返回 {ok:false,error}，UI 降级为只读 + 可读错误）。
         * 与 `sequential` 同范式：读传空对象、写把 patch 原样透传，共用外部源一个方法名。 */
        modelSwitchesGet: () => call('modelSwitches', {}),
        modelSwitchSet: (patch) => call('modelSwitches', patch ?? {}),
        // Z12：外部源未提供时 call() 返回 {ok:false,error}，UI 自行降级为只读
        switchGet: () => call('switchGet', {}),
        switchSet: (next) => call('switchSet', next ?? {}),
        dispose() {
          subs.clear();
          if (timer != null) {
            clearInterval(timer);
            timer = null;
          }
        },
      };
    }

    /* 诚实空态 wire（conn='offline'，Z11）：远端与外部源都没有时不渲染任何假行——
     * 同步发一包空快照（形状与 live 快照一致），无定时器；动作一律返回可读错误。
     * 徽标「未连接」，进程区显示 emptyOffline 文案。 */
    const offlineSnapshot = () => ({
      counts: { running: 0, queued: 0, done: 0, failed: 0 },
      jobs: [],
      locks: {},
      queue: [], // 数组与 live 快照同形（LockStatus 按 .length 取队列长度；任务包示例的 queue:0 会显示 undefined）
    });
    const OFFLINE_ERR = '未连接宿主（offline）：无进程数据，动作不可用';
    function offlineWire() {
      const subs = new Set();
      const emit = () => {
        const bundle = { conn: 'offline', snapshot: offlineSnapshot(), quota: null, planQuota: null };
        for (const fn of subs) {
          try {
            fn(bundle);
          } catch { /* 单个订阅者异常不影响其他 */ }
        }
      };
      const denied = async () => ({ ok: false, error: OFFLINE_ERR });
      return {
        kind: 'offline', // ZB-28b
        subscribe(cb) {
          if (typeof cb !== 'function') throw new TypeError('subscribe(cb): cb 必须是函数');
          subs.add(cb);
          emit(); // 同步一包：UI 首帧即空态，无需等轮询
          return () => subs.delete(cb);
        },
        dispatch: denied,
        kill: denied,
        dismiss: denied,
        retry: denied,
        tail: async (id) => ({ ok: true, id, lines: [] }),
        channels: async () => ({ ok: true, channels: [], warnings: [], levelsStatus: null }),
        channelGet: denied,
        channelSet: denied,
        fallbackGet: denied,
        fallbackSet: denied,
        // ZB-52：离线无真值可读（浏览器读不到宿主文件），顺序派发读写一律拒绝 ⇒ UI 只读 + 提示走终端
        sequentialGet: denied,
        sequentialSet: denied,
        // ZB-58：逐模型开关同上（离线无真值可读，写也不能假装成功）
        modelSwitchesGet: denied,
        modelSwitchSet: denied,
        // Z12：offline 无真值可读（浏览器也读不到宿主文件），动作拒绝 → UI 只读 + 提示走终端
        switchGet: denied,
        switchSet: denied,
        dispose() {
          subs.clear();
        },
      };
    }

    // 内置演示引擎（conn='demo'，默认关）：3 个进程起步；派发 / kill / dismiss / tail 均可交互（纯前端假数据）
    /* ZB-30：降级**目标**归一（与 core/dispatch-core.mjs 的 normFallbackTargets 同语义）。
     * 接受字符串（旧 chain 项）/ 对象（{provider|id|channel, model?, reasoningLevel?|thinking?}）；
     * 无 provider 的项丢弃（不猜），顺序保留。null 字段 = 沿用原任务该维度。
     *
     * ⚠️ ZB-51：必须定义在 `demoWire()` **之前** —— 它的 `fallbackGet` / `fallbackSet` 方法
     * 会引用这两个 helper（方法体在声明前求值也算"使用"）。原先它们在 1800+ 行，
     * 而 demo 的方法在 1597 行 ⇒ **demo 模式一旦调用降级接口就会
     * `ReferenceError: Cannot access 'normTargets' before initialization`**。
     * 属于 latent TDZ（既有代码里就有的），由 `client-tdz.test.mjs` 抓出。 */
    const normTargets = (list) => {
      if (list == null) return [];
      const arr = Array.isArray(list) ? list : [list];
      const out = [];
      for (const item of arr) {
        if (typeof item === 'string') {
          const id = item.trim();
          if (id) out.push({ provider: id, model: null, reasoningLevel: null });
          continue;
        }
        if (!item || typeof item !== 'object') continue;
        const provider = String(item.provider ?? item.id ?? item.channel ?? '').trim();
        if (!provider) continue;
        const model = item.model == null || item.model === '' ? null : String(item.model);
        const rl = item.reasoningLevel ?? item.thinking ?? null;
        out.push({ provider, model, reasoningLevel: rl == null || rl === '' ? null : String(rl) });
      }
      return out;
    };
    const fallbackShape = (targets) => ({
      enabled: targets.length > 0,
      chain: targets.map((x) => x.provider),
      targets,
      target: targets[0] ?? null,
    });

    function demoWire() {
      const seed = () => {
        const s = {
          generatedAt: '', workRoot: '(demo)', maxConcurrent: 1,
          counts: {}, locks: { repo: null, memory: null }, queue: [], jobs: [],
        };
        const mk = (id, tag, state, model, body, extra) => ({
          /* ZB-16：锁名同步新模型 —— memory 已删除，演示数据也不该再出现 'repo+memory'/'both'，
           * 否则演示模式下 UI 会显示已不存在的锁（与真实语义不一致）。 */
          id, tag, state, lock: state === 'running' ? 'repo' : null,
          // Z11：带 kind 同名字段（spec.prompt），与 core/真实 spec 形状一致（UI 详情区读 spec.body ?? spec[kind]）
          spec: { kind: 'prompt', body, prompt: body, model, provider: 'plan', mode: 'edit', lock: 'repo', timeoutMin: 15, memoryBench: false, tag },
          queuedAt: new Date().toISOString(), startedAt: state === 'queued' ? null : new Date().toISOString(),
          finishedAt: state === 'done' ? new Date().toISOString() : null,
          elapsedSec: state === 'running' ? 42 : state === 'done' ? 7.7 : null,
          exitCode: state === 'done' ? 0 : null, signal: null,
          sessionId: state === 'done' ? 'sess_demo-0000' : null,
          provider: state === 'queued' ? null : `plan:bigmodel-coding-plan`, model,
          usage: state === 'running'
            ? { requests: 3, inputTokens: 120340, outputTokens: 1502, cacheReadTokens: 40960 }
            : state === 'done'
              ? { requests: 1, inputTokens: 27724, outputTokens: 16, cacheReadTokens: 1536 }
              : { requests: null, inputTokens: null, outputTokens: null, cacheReadTokens: null },
          contextUsed: state === 'queued' ? null : state === 'running' ? 41300 : 27740,
          contextWindow: state === 'queued' ? null : 200000,
          turnCount: state === 'queued' ? null : 2,
          timedOut: false, tailCount: state === 'queued' ? 0 : 9, parseWarnings: [],
          pauseReason: null, pauseDetail: null, parentJobId: null, attempts: [], hopCount: 0, handedOffTo: null, resumedBy: null,
          ...extra,
        });
        s.jobs = [
          mk('j-demo-run', 'demo-running', 'running', 'GLM-5.3', '（演示）正在整理 collab 目录的周报…'),
          mk('j-demo-done', 'demo-done', 'done', 'GLM-5.3-Flash', '只回答 OK'),
          mk('j-demo-wait', 'demo-queued', 'queued', 'GLM-5.3', '（演示）排队中的代码评审任务'),
          // paused 演示：未占锁、有 sessionId、显示原因徽章与续跑按钮（Z6 语义的可视化）
          mk('j-demo-paused', 'demo-paused', 'paused', 'GLM-5.3-Flash', '（演示）Start Plan 上的整理任务', {
            sessionId: 'sess_demo-paused', provider: 'plan:bigmodel-start-plan', elapsedSec: 3.1, exitCode: 1,
            pauseReason: 'plan-not-entitled', pauseDetail: '[zcode-run] provider builtin:bigmodel-start-plan 未启用（coding_plan_not_entitled）',
            tailCount: 2,
          }),
        ];
        s.counts = { running: 1, queued: 1, done: 1, paused: 1 };
        const holder = s.jobs[0];
        s.locks.repo = { jobId: holder.id, pid: 4242, at: holder.startedAt, lock: 'demo' };
        s.locks.memory = { jobId: holder.id, pid: 4242, at: holder.startedAt, lock: 'demo' };
        s.queue = ['j-demo-wait'];
        return s;
      };
      let snap = seed();
      let seq = 0;
      const quota = {
        available: true, generatedAt: '', ledgerPath: '(demo)', skippedLines: 0,
        windows: {
          last5h: { runs: 3, requests: 5, inputTokens: 148064, outputTokens: 1518, cacheReadTokens: 42496, totalTokens: 192078 },
          week: { runs: 7, requests: 12, inputTokens: 341416, outputTokens: 3411, cacheReadTokens: 219200, totalTokens: 564027 },
          today: { runs: 2, requests: 3, inputTokens: 61420, outputTokens: 640, cacheReadTokens: 18432, totalTokens: 80492 },
        },
      };
      const subs = new Set();
      let timer = null;
      // demo 套餐面（与 core/quota.mjs fetchPlanQuota 同形）：week.used 是引擎本地库合计（演示值），剩余类字段恒 null
      const planQuota = {
        available: true, plan: 'bigmodel-coding-plan', source: 'app-server:usage/stats', generatedAt: '',
        windows: [
          { id: '5h', used: null, limit: null, remaining: null, percentUsed: null, resetAt: null, mapped: false },
          { id: 'week', used: 564027, limit: null, remaining: null, percentUsed: null, resetAt: null, mapped: false },
        ],
      };
      // Z6 demo 通道面（与真实 listChannels 同形；含不可用项——如实标注，不假装能切）
      // 双引擎：每条都带 engine（与 core 的 listChannels 同形）；OpenCode 免费模型是**探测式**的，
      // demo 里只放 3 个示例（真实清单以 action=channels 为准，代码不写死枚举）。
      // ZB-52b：`thinkingLevels` 刻意做成**逐模型不同**、且有一个模型**没有**档位声明 ——
      // 与真实情况一致（OpenCode 实测 6/10 个模型有 variants），这样 demo 里也能看出
      // 「顺序列表逐模型档位」下拉的差异（没有声明的只有「默认」，不瞎列）。
      const demoChannels = [
        { id: 'plan', name: '默认套餐（自动选择）', engine: 'zcode', enabled: true, reason: null, endpoint: 'https://open.bigmodel.cn/api/anthropic', models: ['GLM-5.3', 'GLM-5.3-Flash'], thinkingLevels: ['low', 'high', 'max'] },
        { id: 'personal', name: '个人 API（演示）', engine: 'zcode', enabled: true, reason: null, endpoint: 'https://demo.example/v1', models: ['deepseek-flash'] },
        { id: 'builtin:bigmodel-start-plan', name: 'BigModel Start Plan（演示）', engine: 'zcode', enabled: false, reason: 'coding_plan_not_entitled', endpoint: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic', models: ['GLM-5.3', 'GLM-5.3-Flash'] },
        { id: 'builtin:zai-coding-plan', name: 'Z.ai Coding Plan（演示）', engine: 'zcode', enabled: false, reason: 'oauth_provider_inactive', endpoint: 'https://api.z.ai/api/anthropic', models: ['GLM-5.3', 'GLM-5.3-Flash'] },
        { id: 'opencode/deepseek-v4.1-flash-free', name: 'deepseek-v4.1-flash（OpenCode 免费）', engine: 'opencode', enabled: true, reason: null, endpoint: null, models: ['opencode/deepseek-v4.1-flash-free'], thinkingLevels: ['low', 'high', 'max'] },
        { id: 'opencode/glm-5.3-flash-free', name: 'glm-5.3-flash（OpenCode 免费）', engine: 'opencode', enabled: true, reason: null, endpoint: null, models: ['opencode/glm-5.3-flash-free'], thinkingLevels: ['low', 'max'] },
        { id: 'opencode/cat-jam-free', name: 'cat-jam（OpenCode 免费，限时/限区）', engine: 'opencode', enabled: true, reason: null, endpoint: null, models: ['opencode/cat-jam-free'] },
      ];
      let demoChannel = { provider: 'plan', model: 'GLM-5.3-Flash' };
      let demoTargets = []; // ZB-30：demo 降级目标（[{provider, model, reasoningLevel}]）
      /* ZB-52：demo 顺序派发（纯内存，不写真值文件 —— demo 不该伪装成已落盘）。
       * 形状与 core 的 `getSequential()` 一致（三引擎键恒在，靠 `normSeqShape` 归一）；
       * ZB-52b：`levels` 与 `order` 同序（逐模型档位），demo 也要能演示"设了档位再读回"。
       * ZB-52c：无 `enabled`（与 core 同契约：模型为空即顺序派发，没有全局开关）。 */
      let demoSeq = {
        order: { zcode: [], opencode: [], qoder: [] },
        levels: { zcode: [], opencode: [], qoder: [] },
      };
      /* ZB-58：demo 逐模型开关（纯内存，不写真值文件）——语义与 core 一致：
       * **禁用清单**（关掉谁记谁，上游新模型默认可用）+ 「关掉的模型不出现在「模型」下拉」。 */
      let demoDisabledModels = new Set();
      const pendingTransitions = new Set(); // dispose 时连同派发编排的挂起定时器一起清
      const later = (fn, ms) => {
        const t = setTimeout(() => {
          pendingTransitions.delete(t);
          fn();
        }, ms);
        pendingTransitions.add(t);
        return t;
      };
      // demo 派发编排（dispatch 与 retry 共用）：queued→running（+1.2s）→ done（再 +5s）
      const scheduleRun = (id) => {
        later(() => {
          const running = snap.jobs.find((j) => j.id === id);
          if (!running || running.state !== 'queued') return;
          running.state = 'running';
          running.startedAt = new Date().toISOString();
          running.elapsedSec = 0;
          running.lock = 'repo';
          snap.queue = snap.queue.filter((q) => q !== id);
          snap.counts = { ...snap.counts, queued: Math.max(0, (snap.counts.queued ?? 1) - 1), running: (snap.counts.running ?? 0) + 1 };
          const rec = { jobId: id, pid: 4242, at: running.startedAt, lock: 'demo' };
          snap.locks.repo = rec;
          snap.locks.memory = rec;
          emit();
        }, 1200);
        later(() => {
          const doneJob = snap.jobs.find((j) => j.id === id);
          if (!doneJob || doneJob.state !== 'running') return;
          doneJob.state = 'done';
          doneJob.exitCode = 0;
          doneJob.finishedAt = new Date().toISOString();
          doneJob.elapsedSec = Number(((Date.parse(doneJob.finishedAt) - Date.parse(doneJob.startedAt)) / 1000).toFixed(1));
          doneJob.lock = null;
          doneJob.usage = { requests: 1, inputTokens: 27724, outputTokens: 16, cacheReadTokens: 1536 };
          doneJob.contextUsed = 27740;
          doneJob.contextWindow = 200000;
          doneJob.tailCount = 5;
          snap.counts = { ...snap.counts, running: Math.max(0, (snap.counts.running ?? 1) - 1), done: (snap.counts.done ?? 0) + 1 };
          if (!snap.jobs.some((j) => j.state === 'running')) {
            snap.locks.repo = null;
            snap.locks.memory = null;
          }
          addUsage(doneJob.usage);
          emit();
        }, 6200);
      };
      const snapshot = () => ({
        ...snap,
        generatedAt: new Date().toISOString(),
        jobs: snap.jobs
          .map((j) => ({ ...j, spec: { ...j.spec }, usage: { ...j.usage } }))
          .sort((a, b) => {
            const rank = { running: 0, queued: 1, paused: 2 };
            return (rank[a.state] ?? 3) - (rank[b.state] ?? 3) || String(b.queuedAt).localeCompare(String(a.queuedAt));
          }),
      });
      const quotaNow = () => ({ ...quota, generatedAt: new Date().toISOString() });
      const planQuotaNow = () => ({ ...planQuota, generatedAt: new Date().toISOString() });
      const emit = () => {
        const bundle = { conn: 'demo', snapshot: snapshot(), quota: quotaNow(), planQuota: planQuotaNow() };
        for (const fn of subs) {
          try {
            fn(bundle);
          } catch { /* 单个订阅者异常不影响其他 */ }
        }
      };
      const job = (id) => snap.jobs.find((j) => j.id === id) ?? null;
      const addUsage = (u) => {
        for (const w of [quota.windows.last5h, quota.windows.week, quota.windows.today]) {
          w.runs += 1;
          w.requests += u.requests;
          w.inputTokens += u.inputTokens;
          w.outputTokens += u.outputTokens;
          w.cacheReadTokens += u.cacheReadTokens;
          w.totalTokens = w.inputTokens + w.outputTokens + w.cacheReadTokens;
        }
      };
      return {
        kind: 'demo', // ZB-28b
        subscribe(cb) {
          subs.add(cb);
          emit();
          if (timer == null) {
            timer = setInterval(() => {
              let changed = false;
              for (const j of snap.jobs) {
                if (j.state === 'running') {
                  j.elapsedSec = Number((j.elapsedSec ?? 0) + 1);
                  changed = true;
                }
              }
              if (changed) emit();
            }, 1000);
          }
          return () => {
            subs.delete(cb);
            if (subs.size === 0 && timer != null) {
              clearInterval(timer);
              timer = null;
            }
          };
        },
        async dispatch(spec = {}) {
          const kind = spec.kind ?? 'prompt';
          const body = spec[kind];
          if (!body) return { ok: false, error: `kind=${kind} 需要对应的 ${kind} 字段（demo）` };
          seq += 1;
          const id = `j-demo-new-${seq}`;
          const tag = spec.tag ?? `demo-new-${seq}`;
          const nj = {
            id, tag, state: 'queued', lock: null,
            spec: { kind, body: String(body).slice(0, 80), [kind]: String(body).slice(0, 80), model: spec.model ?? null, provider: spec.provider ?? null, mode: spec.mode ?? 'edit', lock: spec.lock ?? 'repo', timeoutMin: spec.timeoutMin ?? null, memoryBench: Boolean(spec.memoryBench), tag },
            queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
            elapsedSec: null, exitCode: null, signal: null, sessionId: null, provider: null,
            model: spec.model ?? null,
            usage: { requests: null, inputTokens: null, outputTokens: null, cacheReadTokens: null },
            contextUsed: null, contextWindow: null, turnCount: null, timedOut: false, tailCount: 0, parseWarnings: [],
            pauseReason: null, pauseDetail: null, parentJobId: null, attempts: [], hopCount: 0, handedOffTo: null, resumedBy: null,
          };
          snap.jobs.unshift(nj);
          snap.counts = { ...snap.counts, queued: (snap.counts.queued ?? 0) + 1 };
          snap.queue = [...snap.queue, id];
          emit();
          scheduleRun(id);
          return { ok: true, job: { ...nj } };
        },
        async kill(id) {
          const j = job(id);
          if (!j || ['done', 'failed', 'killed', 'interrupted'].includes(j.state)) {
            return { ok: false, error: `kill 失败：job 不存在或已是终态（id=${id}）（demo）` };
          }
          const wasQueued = j.state === 'queued';
          const wasRunning = j.state === 'running';
          const wasPaused = j.state === 'paused';
          j.state = 'killed';
          j.lock = null;
          j.finishedAt = new Date().toISOString();
          if (j.startedAt) j.elapsedSec = Number(((Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000).toFixed(1));
          snap.queue = snap.queue.filter((q) => q !== id);
          snap.counts = {
            ...snap.counts,
            queued: Math.max(0, (snap.counts.queued ?? 0) - (wasQueued ? 1 : 0)),
            running: Math.max(0, (snap.counts.running ?? 0) - (wasRunning ? 1 : 0)),
            paused: Math.max(0, (snap.counts.paused ?? 0) - (wasPaused ? 1 : 0)),
            killed: (snap.counts.killed ?? 0) + 1,
          };
          if (!snap.jobs.some((x) => x.state === 'running')) {
            snap.locks.repo = null;
            snap.locks.memory = null;
          }
          emit();
          return { ok: true, job: { ...j } };
        },
        /* Z11：dismiss = 从列表移除（demo 的 kill 对 paused 有效，这里主要保形状一致） */
        async dismiss(id) {
          const j = job(id);
          if (!j || !['paused', 'done', 'failed', 'killed', 'interrupted'].includes(j.state)) {
            return { ok: false, error: `dismiss 失败：job 不存在或仍在 ${j?.state ?? '?'}（demo）` };
          }
          snap.jobs = snap.jobs.filter((x) => x.id !== id);
          snap.counts = { ...snap.counts, [j.state]: Math.max(0, (snap.counts[j.state] ?? 0) - 1) };
          emit();
          return { ok: true, id };
        },
        async tail(id, n = 30) {
          const j = job(id);
          if (!j) return { ok: false, error: `找不到 job：${id}（demo）` };
          const lines = [
            `[zcode-run] tag=${j.spec.tag ?? 'demo'} mode=${j.spec.mode ?? 'edit'} cwd=(demo)`,
            '[zcode-run] provider=plan:bigmodel-coding-plan (Fake Provider（ZCode 套餐）)',
            '[zcode-run] usage requests=1 in=100 out=50 cacheRead=10',
            '[zcode-run] context used=1234 (0.6% of 200000) turnCount=2',
          ];
          if (j.state === 'done') lines.push(`[zcode-run] done exit=0 elapsed=7.7s session=sess_demo-0000 provider=plan:bigmodel-coding-plan model=${j.model}`);
          if (j.state === 'running') lines.push(`[zcode-run] running… elapsed=${Math.round(j.elapsedSec ?? 0)}s（demo 流式输出）`);
          if (j.state === 'queued') lines.push('(queued: 等待单写者锁，demo)');
          if (j.state === 'killed') lines.push('[zcode-run] killed by user (demo)');
          if (j.state === 'paused') {
            lines.push(`[zcode-run] done exit=1 elapsed=3.1s provider=${j.provider ?? 'plan:bigmodel-start-plan'}`);
            lines.push(`[zcode-run] ${j.pauseDetail ?? 'coding_plan_not_entitled'}`);
          }
          return { ok: true, id, lines: lines.slice(-Math.max(1, Number(n) || 30)) };
        },
        /* ---- Z6 demo 增量：通道 / 续跑 / 降级链（与真实 dispatcher 语义同形） ---- */
        async channels() {
          /* ZB-56：与真实面同形 —— `levelsStatus` 也带上（demo 的档位是静态声明 ⇒ null = 未知，
           * 走"正常列档位"分支；不是 pending，不会显示"载入中"）。 */
          return {
            ok: true,
            channels: demoChannels.map((c) => ({ ...c, models: [...c.models], userDisabled: demoDisabledModels.has(String(c.id)) })),
            warnings: [],
            levelsStatus: null,
          };
        },
        async channelGet() {
          return { ok: true, channel: { ...demoChannel } };
        },
        async channelSet(c = {}) {
          demoChannel = {
            provider: String(c.provider ?? demoChannel.provider),
            model: c.model == null || c.model === '' ? null : String(c.model),
          };
          return { ok: true, channel: { ...demoChannel } };
        },
        async retry(id, opts = {}) {
          const j = job(id);
          if (!j) return { ok: false, error: `找不到 job：${id}（demo）` };
          if (j.state === 'queued' || j.state === 'running') return { ok: false, error: `job 仍在 ${j.state}，不能 retry（demo）` };
          const origProvider = j.spec.provider ?? 'plan';
          const targetProvider = opts.provider != null && opts.provider !== '' ? String(opts.provider) : null;
          const targetModel = opts.model != null && opts.model !== '' ? String(opts.model) : null;
          const sameChannel = targetProvider == null || targetProvider === origProvider;
          const prevAttempts = Array.isArray(j.attempts) ? j.attempts : [];
          const reason = j.pauseReason && j.pauseReason !== 'unknown' ? j.pauseReason : `manual-retry:${j.state}`;
          seq += 1;
          const nid = `j-demo-retry-${seq}`;
          const suffix = sameChannel ? `r${prevAttempts.length + 1}` : `h${prevAttempts.length + 1}`;
          const spec = sameChannel && j.sessionId
            ? { ...j.spec, tag: `${j.tag}-${suffix}` }
            : {
                kind: 'prompt',
                body: `（演示）交接重跑：${j.spec.body ?? j.tag}`,
                model: targetModel,
                provider: targetProvider ?? origProvider,
                mode: j.spec.mode ?? 'edit',
                lock: j.spec.lock ?? 'repo', // ZB-18 补漏：默认由 'both' 改为 'repo'（memory 已删除）
                timeoutMin: j.spec.timeoutMin ?? null,
                memoryBench: false,
                tag: `${j.tag}-${suffix}`,
              };
          const nj = {
            id: nid, tag: `${j.tag}-${suffix}`, state: 'queued', lock: null, spec,
            queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
            elapsedSec: null, exitCode: null, signal: null,
            sessionId: sameChannel && j.sessionId ? j.sessionId : `sess_demo-handoff-${seq}`,
            provider: null, model: spec.model ?? null,
            usage: { requests: null, inputTokens: null, outputTokens: null, cacheReadTokens: null },
            contextUsed: null, contextWindow: null, turnCount: null, timedOut: false, tailCount: 0, parseWarnings: [],
            pauseReason: null, pauseDetail: null, parentJobId: j.id,
            attempts: [
              ...prevAttempts,
              { jobId: j.id, provider: origProvider, model: j.spec.model ?? null, reason, at: new Date().toISOString() },
              { jobId: nid, provider: spec.provider ?? origProvider, model: spec.model ?? null, reason: sameChannel ? 'resume-same-channel' : 'handoff-retry', at: new Date().toISOString() },
            ],
            hopCount: sameChannel ? j.hopCount ?? 0 : (j.hopCount ?? 0) + 1,
            handedOffTo: null, resumedBy: null,
          };
          snap.jobs.unshift(nj);
          snap.counts = { ...snap.counts, queued: (snap.counts.queued ?? 0) + 1 };
          snap.queue = [...snap.queue, nid];
          if (sameChannel && j.sessionId) j.resumedBy = nid;
          else j.handedOffTo = nid;
          emit();
          scheduleRun(nid);
          return { ok: true, job: { ...nj } };
        },
        async fallbackGet() {
          return { ok: true, ...fallbackShape(demoTargets) };
        },
        async fallbackSet(target) {
          demoTargets = normTargets(target);
          return { ok: true, ...fallbackShape(demoTargets) };
        },
        /* ZB-52：顺序派发（demo 语义与 core **逐条一致**：patch **只有 `{order}`**（传 enabled 在 core 会抛
         * TypeError，已废弃）；`order` **按引擎合并**（没传的引擎原样保留），同一引擎内整体替换，未知引擎键丢弃）。
         * ZB-52b：`levels` 与 `order` 同序 —— 该引擎的 order 被替换时 `levels` **一起换**，
         * 否则在 demo 里设的逐模型档位会错位对到别的模型上。 */
        async sequentialGet() {
          return { ok: true, ...normSeqShape(demoSeq) };
        },
        async sequentialSet(patch) {
          const p = patch && typeof patch === 'object' ? patch : {};
          const next = {
            order: { ...demoSeq.order },
            levels: { ...demoSeq.levels },
          };
          if ('order' in p) {
            const src = p.order && typeof p.order === 'object' && !Array.isArray(p.order) ? p.order : {};
            const norm = normSeqShape({ order: src });
            for (const eng of KNOWN_ENGINES) {
              if (!(eng in src)) continue; // 按引擎合并：未传的引擎保留（与 core 同语义）
              next.order[eng] = norm.order[eng];
              next.levels[eng] = norm.levels[eng];
            }
          }
          demoSeq = next;
          return { ok: true, ...normSeqShape(demoSeq) };
        },
        /* ZB-58：demo 逐模型开关（纯内存）。写语义与 core `setModelSwitch` 一致：
         * `{route, enabled}` 翻单个 / `{disabled:[...]}` 整体替换；读回**归一后的禁用清单**。 */
        async modelSwitchesGet() {
          return { ok: true, ...normModelSwitchShape({ disabled: [...demoDisabledModels] }) };
        },
        async modelSwitchSet(patch) {
          const p = patch && typeof patch === 'object' ? patch : {};
          if (Array.isArray(p.disabled)) {
            demoDisabledModels = new Set(p.disabled.map((x) => String(x)).filter(Boolean));
          } else if (typeof p.route === 'string' && p.route) {
            if (p.enabled === false) demoDisabledModels.add(p.route);
            else demoDisabledModels.delete(p.route);
          } else {
            return { ok: false, error: 'modelSwitchSet 需要 {route, enabled} 或 {disabled}' };
          }
          return { ok: true, ...normModelSwitchShape({ disabled: [...demoDisabledModels] }) };
        },
        // Z12：demo 不读/写真值文件（假数据不伪装开关状态，更不许写真值）
        async switchGet() {
          return { ok: false, error: '演示模式无真值文件（demo）' };
        },        async switchSet() {
          return { ok: false, error: '演示模式不写总开关（demo）' };
        },
        dispose() {
          subs.clear();
          if (timer != null) {
            clearInterval(timer);
            timer = null;
          }
          for (const t of pendingTransitions) clearTimeout(t);
          pendingTransitions.clear();
        },
      };
    }

    /* ─────────────── wire 工厂（数据源四选一；同源：wire.client.mjs createClientWire）───────────────
     * 优先级与判据：MOD_CTX 上探测到远端面（resolveRemote 有 snapshot()）→ remoteWire
     * （conn='live'，真数据）；否则 legacyWire 选择器：__dispatchDemo='builtin' → demoWire
     * （conn='demo'，默认关）；外部源对象 → extWire（conn='ext'）；都没有 → offlineWire
     * （conn='offline'，诚实空态）。MOD_CTX 为 null（apply 未跑过，如纯组件桩浅渲染）
     * 等同远端缺席，走降级链，绝不抛错。 */
    function createWire() {
      try {
        const remote = MOD_CTX ? resolveRemote(MOD_CTX) : null;
        if (remote) return remoteWire(MOD_CTX, remote);
      } catch (e) {
        try { console.warn('[dispatch] 远端 wire 初始化失败，降级 ext/offline：', e && e.message); } catch { /* ignore */ }
      }
      try {
        /* ZB-01 诊断：走到这里 = 远端面没解析到。把这行原文（连同面板首行提示）带回即可定位。 */
        try {
          console.warn('[dispatch] 远端面未就绪 → 降级 wire。诊断=', {
            mountDiag: MOUNT_DIAG,
            childFiberService: !!REMOTE_SVC,
            hasModCtx: !!MOD_CTX,
            ctxRemoteDispatch: !!(MOD_CTX && MOD_CTX.remote && MOD_CTX.remote.dispatch),
          });
        } catch { /* ignore */ }
        return legacyWire();
      } catch (e) {
        try { console.warn('[dispatch] 降级 wire 初始化失败：', e && e.message); } catch { /* ignore */ }
        return null; // 交给 DEAD_WIRE：只报错、不白屏
      }
    }

    /* 最后一道兜底 wire：连降级链都起不来时使用，保证组件永远有 wire（失败可见，不静默消失） */
    const DEAD_WIRE = {
      kind: 'dead', // ZB-28b
      conn: 'error',
      subscribe(fn) {
        try { fn({ conn: 'error', snapshot: null, quota: null, planQuota: null }); } catch { /* ignore */ }
        return () => {};
      },
      dispose() {},
      dispatch: async () => ({ ok: false, error: 'wire 不可用' }),
      kill: async () => ({ ok: false, error: 'wire 不可用' }),
      dismiss: async () => ({ ok: false, error: 'wire 不可用' }),
      retry: async () => ({ ok: false, error: 'wire 不可用' }),
      tail: async () => [],
      channels: async () => ({ channels: [] }),
      channelGet: async () => ({}),
      channelSet: async () => ({ ok: false, error: 'wire 不可用' }),
      fallbackGet: async () => ({}),
      fallbackSet: async () => ({ ok: false, error: 'wire 不可用' }),
      // ZB-52：顺序派发（读给出诚实空形状，写报错）。ZB-52c：无 enabled（模型为空即顺序派发）
      sequentialGet: async () => ({
        order: { zcode: [], opencode: [], qoder: [] },
        levels: { zcode: [], opencode: [], qoder: [] },
        sequentialCount: 0,
      }),
      sequentialSet: async () => ({ ok: false, error: 'wire 不可用' }),
      /* ZB-58：逐模型开关（读给诚实空清单 = 一个都不禁用；写报错）。 */
      modelSwitchesGet: async () => ({ ok: true, disabled: [], userDisabledCount: 0 }),
      modelSwitchSet: async () => ({ ok: false, error: 'wire 不可用' }),
      switchGet: async () => ({}),
      switchSet: async () => ({ ok: false, error: 'wire 不可用' }),
    };

    /* ─────────────── 共享 wire（ZB-27w；ZB-28b 修引用计数） ───────────────
     * 背景：会话头入口（每个会话一枚，常驻）需要"有没有进行中的任务"来显示图标，
     * 而面板也需要同一份快照。若各自建 wire，就会变成"每会话一条 1s 轮询"（此前被明确否掉）。
     * 做法：**模块级单例 + 引用计数** —— 谁先需要谁创建，最后一个释放者负责 dispose。
     * 远端命名空间就绪（$mount 成功后）时作废重建一次：首帧探测可能落空、建成降级 wire。
     *
     * ★ ZB-28b（用户报「派发台开始工作时不显示状态灯，切换会话后才显示」）——根因有两个，
     * 都在引用计数上：
     *   ① 旧 `releaseSharedWire()` **无参**：谁把计数减到 0，就 dispose **当前** SHARED_WIRE。
     *      epoch 重建路径里同一次消费会被放两次（render 换 wire 一次 + effect 清理一次），
     *      第二次落地时 SHARED_WIRE 已是新 wire ⇒ 计数提前漏到 0，而新 wire 还活着
     *      （入口靠 subscribe 的即时 tick 复活了它）——refs 从此停在 0。此后任何一次
     *      「面板开→关」的 release 都会命中 `refs===0 && SHARED_WIRE` ⇒ 把**入口还订阅着
     *      的那条 live wire** dispose 掉（subs.clear + 停轮询）⇒ 入口从此收不到任何快照，
     *      状态灯冻结，直到切换会话重挂载才重建 —— 正是现场症状。
     *   ② waiter 注册晚于就绪：`markRemoteReady` 空放一次，该消费者的 epoch 永远不 bump，
     *      手里永远停在降级 wire（修法见 onRemoteReady 的 REMOTE_READY 补投）。
     * 修法：**配对释放**（release 指名自己 acquire 的那条；守卫 `refs===0 && current===wire`）
     * + **一次消费一放**（useWire render 期只 acquire，旧 wire 由 effect 清理单点释放）
     * + **补投**（REMOTE_READY 旗标 + peek 守卫，见 onRemoteReady / useWire 的回调）。 */
    function createSharedWireRegistry(createWireImpl) {
      let current = null;
      let refs = 0;
      return {
        acquire() {
          if (!current) current = createWireImpl();
          refs += 1;
          return current;
        },
        release(wire) {
          refs = Math.max(0, refs - 1);
          if (refs === 0 && current && current === wire) {
            try { current.dispose?.(); } catch { /* ignore */ }
            current = null;
          }
        },
        invalidate() {
          if (!current) return;
          try { current.dispose?.(); } catch { /* ignore */ }
          current = null;
        },
        peek() { return current; }, // ZB-28b：useWire 回调判「当前 wire 是否已 remote」用（不作废别人手上的 live wire）
      };
    }
    const sharedWires = createSharedWireRegistry(() => {
      try { return createWire() ?? DEAD_WIRE; } catch { return DEAD_WIRE; }
    });
    function acquireSharedWire() { return sharedWires.acquire(); }
    /** ZB-28b：**配对释放** —— 必须传自己 acquire 到的那条 wire；不传是编程错误（旧无参形态已删除）。 */
    function releaseSharedWire(wire) { return sharedWires.release(wire); }
    function invalidateSharedWire() { return sharedWires.invalidate(); }

    /* ─────────────── 组件 ─────────────── */
    /* 渲染兜底：任何渲染期异常都转成一张可见的失败卡片，而不是静默消失。
     * （2026-09-30 实测：createWire 若抛错会让整块浮层不见且页面无报错，难以定位。） */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
      }

      static getDerivedStateFromError(err) {
        return { err };
      }

      componentDidCatch(err) {
        try { console.warn('[dispatch] 渲染失败（已降级显示）:', err && err.message); } catch { /* ignore */ }
      }

      render() {
        if (!this.state.err) return this.props.children;
        /* ZB-27：错误兜底卡片改为**就地**渲染（出现在弹窗里），不再固定到右下角 ——
         * 浮窗本体已取消，固定定位只会在屏幕角落单开一块无主 UI。 */
        return h('div', {
          className: 'dsp-menu',
          role: 'alert',
          style: {
            width: '340px', maxWidth: 'calc(100vw - 32px)',
            padding: '10px 12px', fontSize: '12px', lineHeight: 1.5,
            color: T.text, background: T.bg, border: '1px solid ' + T.border,
            borderRadius: 'var(--dsw-radius-lg,12px)', boxShadow: T.shadow,
          },
        },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, 'DSH 派发台渲染失败'),
        h('div', { style: { color: T.text2, wordBreak: 'break-all' } }, String((this.state.err && this.state.err.message) || this.state.err)),
        h('button', {
          className: 'dsp-btn2', style: { marginTop: '6px' },
          onClick: () => this.setState({ err: null }),
        }, '重试'));
      }
    }

    function useWire() {
      /* ZB-01：远端命名空间就绪后必须重建一次 wire——否则首次渲染建成的降级 wire
       * 会被 useRef 永久沿用（$mount 异步，首帧探测必然可能落空）。
       * ZB-27w：wire 改为**模块级共享单例**（引用计数），入口与面板共用同一条轮询 ——
       * 于是"每个会话头入口都建一条 wire"的问题不复存在。
       *
       * ★ ZB-28b（用户报「派发台开始工作时不显示状态灯，切换会话后才显示」）：
       * 计数必须**一次消费一放** —— render 期**只 acquire**（换 epoch / 换 wire 也一样），
       * 旧 wire 由订阅 effect 的清理**单点配对释放**。旧代码在 render 重建里先无参 release
       * 一次、effect 清理又 release 一次 ⇒ 同一消费被放两遍、refs 提前漏到 0；而无参
       * release 的处决守卫只看计数不看归属，于是任何后续一次 release（典型：面板开→关）
       * 都会把**入口还订阅着的 live wire** dispose 掉（subs.clear + 停轮询）⇒ 入口从此
       * 收不到快照、状态灯冻结，直到切换会话重挂载才重建 —— 正是现场症状。
       * 配套：release 一律**指名**自己 acquire 到的那条 wire（createSharedWireRegistry 的
       * current===wire 守卫）；onRemoteReady 补投防 waiter 注册晚于就绪（见上）。 */
      const [remoteEpoch, setRemoteEpoch] = useState(0);
      useEffect(() => onRemoteReady(() => {
        /* 当前 wire 已是 remote 时**不**作废（否则后挂载消费者的补投会把别人手上
         * 的 live wire 处决掉——那正是本轮修的事故形态）；只在还是降级 wire 时作废重建。 */
        if (sharedWires.peek()?.kind !== 'remote') invalidateSharedWire();
        setRemoteEpoch((n) => n + 1);
      }), []);
      const ref = useRef(null); // { wire, epoch }
      if (ref.current == null || ref.current.epoch !== remoteEpoch) {
        ref.current = { wire: acquireSharedWire(), epoch: remoteEpoch };
      }
      const wire = ref.current.wire;
      const [state, setState] = useState({ conn: 'connecting', snapshot: null, quota: null, planQuota: null });
      useEffect(() => {
        const un = wire.subscribe((b) => setState(b));
        return () => {
          un();
          releaseSharedWire(wire); // ZB-28b：放**自己这条**（配对；旧 wire 的唯一释放点就在这里）
        };
      }, [wire]);
      return {
        conn: state.conn, snapshot: state.snapshot, quota: state.quota, planQuota: state.planQuota,
        dispatch: wire.dispatch, kill: wire.kill, dismiss: wire.dismiss, tail: wire.tail,
        channels: wire.channels, channelGet: wire.channelGet, channelSet: wire.channelSet,
        retry: wire.retry, fallbackGet: wire.fallbackGet, fallbackSet: wire.fallbackSet,
        sequentialGet: wire.sequentialGet, sequentialSet: wire.sequentialSet,
        /* ZB-58：逐模型开关（面板「可用」开关 + 「模型」下拉过滤）。 */
        modelSwitchesGet: wire.modelSwitchesGet, modelSwitchSet: wire.modelSwitchSet,
        switchGet: wire.switchGet, switchSet: wire.switchSet,
      };
    }

    /* ─────────────── 单一源：job 状态词汇表（执行 3 / 审计 R1）───────────────
     * 背景：同一份「有哪些 job 状态」此前散在 **4 处**（`DISMISSABLE_STATES` / `StatusDot` 白名单 /
     * `JOB_GROUPS` / D1 卡片的 `TV_PILL`）——加一个新状态时必漏改其中一处。ZB-03 的分组表就踩过
     * （那段注释至今写着"绝不能因为新状态没进分组表就让 job 在列表里凭空消失"）。
     * 现在只维护**这一张表**，其余全部派生。
     *
     * 字段：
     *   group       —— 进程列表分组（grpActive / grpPaused / grpFailed / grpDone）
     *   dismissable —— 「关闭」（从列表移除 + 落盘 dismissed.json）是否允许；
     *                  **必须与宿主 `wire.host.mjs` 的 `DISMISSABLE`（= core `SETTLED_STATES`）一致**，
     *                  由 `test/cross-check.test.mjs` 守门
     *   dot / pill  —— 状态点 / 卡片胶囊是否使用同名类（未知值一律回落安全类名）
     *
     * ⚠️ **表内顺序即渲染次序**（分组内 job 的归类与胶囊集合都按它走），别随手重排。 */
    const JOB_STATE_META = {
      queued: { group: 'grpActive', dismissable: false, dot: true, pill: true },
      running: { group: 'grpActive', dismissable: false, dot: true, pill: true },
      paused: { group: 'grpPaused', dismissable: true, dot: true, pill: true },
      failed: { group: 'grpFailed', dismissable: true, dot: true, pill: true },
      interrupted: { group: 'grpFailed', dismissable: true, dot: true, pill: true },
      killed: { group: 'grpFailed', dismissable: true, dot: true, pill: true },
      done: { group: 'grpDone', dismissable: true, dot: true, pill: true },
    };
    /** 全部 job 状态（顺序 = 上表字面顺序）。 */
    const JOB_STATES = Object.keys(JOB_STATE_META);
    /** 「关闭」允许的状态（= 宿主 DISMISSABLE / core SETTLED_STATES；cross-check 测试钉住）。 */
    const DISMISSABLE_STATES = JOB_STATES.filter((s) => JOB_STATE_META[s].dismissable);
    /** 进程列表分组表（**顺序即 tab 顺序**；states 由状态表派生，新增状态自动归位）。 */
    const JOB_GROUPS = [
      { key: 'grpActive', states: JOB_STATES.filter((s) => JOB_STATE_META[s].group === 'grpActive') },
      { key: 'grpPaused', states: JOB_STATES.filter((s) => JOB_STATE_META[s].group === 'grpPaused') },
      { key: 'grpFailed', states: JOB_STATES.filter((s) => JOB_STATE_META[s].group === 'grpFailed') },
      { key: 'grpDone', states: JOB_STATES.filter((s) => JOB_STATE_META[s].group === 'grpDone') },
    ];
    /** 状态点类名（未知状态回落 `s-idle`，不拼脏类名）。 */
    const stateDotClass = (state) => (JOB_STATE_META[state]?.dot ? state : 'idle');
    /** D1 卡片胶囊的类名白名单：job 状态 + 「派发中」这个**伪状态**（不是 job 状态，故不入表）。 */
    const PREPARING_STATE = 'preparing';
    const TV_PILL = [...JOB_STATES.filter((s) => JOB_STATE_META[s].pill), PREPARING_STATE];

    /* 暂停**原因** → 文案键（另一根轴：它不是 job 状态，而是 paused 的成因）。
     * 与 core `AUTO_FALLBACK_REASONS`（quota-exhausted / plan-not-entitled / provider-signing）对齐，
     * 另含 config-error（不降级、但同样要显示）；cross-check.test.mjs 守门。 */
    const PAUSE_LABEL_KEY = { 'quota-exhausted': 'pQuota', 'plan-not-entitled': 'pEntitled', 'provider-signing': 'pSigning', 'config-error': 'pConfig' };
    const pauseLabel = (r) => t(PAUSE_LABEL_KEY[r] ?? 'pUnknown');
    /* ZB-29e（用户要求）：思考强度档位**中文显示** —— 值与传输一律用原始字符串（disabled/enabled/
     * low/high/max），只在显示层映射中文标签；未知档位（上游新增）原样显示，绝不隐藏、不猜语义。 */
    const THINKING_LABEL_KEY = { disabled: 'thinkDisabled', enabled: 'thinkEnabled', low: 'thinkLow', high: 'thinkHigh', max: 'thinkMax',
      /* ZB-55：三引擎实测 11 档 —— 上面 5 个之外再补 6 个（未映射的会掉回英文原文 none/minimal/medium/xhigh）。
       * ⚠️ 第一行必须保持 `{ disabled: 'thinkDisabled'` 这个**字面形状**（thinking-level.test.mjs 钉住）；
       * 仍然保留"未映射就显示原值"的兜底（`|| lv`，诚实降级，上游新增档位不会空白）。 */
      none: 'thinkNone', minimal: 'thinkMinimal', medium: 'thinkMedium', xhigh: 'thinkXhigh',
      auto: 'thinkAuto', ultracode: 'thinkUltracode',
    };
    const thinkingLabel = (lv) => (lv == null || lv === '' ? '' : t(THINKING_LABEL_KEY[lv] ?? '') || lv);
    /* ZB-30：降级目标归一 / 形状 helper 已**上移**到 `demoWire()` 之前
     * （见那里的注释：demo 的 fallbackGet/fallbackSet 会引用它们，留在原处是 latent TDZ）。 */
    /* ZB-28：排队可观测 —— 把 core 的 lockWait 结构转成一行人话：
     * 「第 2/3 位 · 前方 1 个（j-xxxxxxxx） · 被 tag-x 挡住 · 预计 ≤ 0时03分20秒」。
     * estWaitSec=null（有阻塞者未声明 timeoutMin）时如实显示「预计等待未知」，不猜。 */
    const lockWaitText = (lw) => {
      if (!lw) return '';
      const parts = [];
      if (lw.position != null) parts.push(`第 ${lw.position}/${lw.queuedTotal ?? '?'} 位`);
      if (lw.ahead > 0) {
        const ids = Array.isArray(lw.aheadIds) && lw.aheadIds.length ? `（${lw.aheadIds.map(shortId).join('、')}）` : '';
        parts.push(`前方 ${lw.ahead} 个${ids}`);
      }
      if (Array.isArray(lw.blockers) && lw.blockers.length) {
        parts.push(`被 ${lw.blockers.map((b) => b.holderTag || shortId(b.holderJobId) || b.lock).join('、')} 挡住`);
      }
      parts.push(lw.estWaitSec != null ? `预计 ≤ ${fmtSec(lw.estWaitSec)}` : '预计等待未知');
      return parts.join(' · ');
    };
    /* ZB-29：思考强度的**显示值** —— 实际生效档优先（runner 确认注入；「Agent决定」档经
     * runner 按模型声明最后一档解析，因此有具体值）；其次请求的具体档位；
     * 'agent' 且无注入确认（旧 runner / --resume / 模型未声明）⇒ null = 不显示，不伪造。 */
    const thinkingShown = (job) => {
      if (job.reasoningLevelApplied) return job.reasoningLevelApplied;
      const rl = job.spec ? job.spec.reasoningLevel : null;
      return rl && rl !== 'agent' ? rl : null;
    };
    /* ZB-02：「关闭」（= 从列表移除 + 落盘 dismissed.json）允许的状态集合。
     * ⚠️ 已收敛进上面的 `JOB_STATE_META`（`dismissable` 列）—— 这里不再有第二份字面量。
     * 原先 UI 只在 paused 时渲染关闭按钮 → done/failed/killed/interrupted 的 job
     * 既没有终止按钮（非 active）也没有关闭按钮，列表里清不掉。 */

    function StatusDot({ state }) {
      const cls = stateDotClass(state); // 单一源：JOB_STATE_META.dot（未知状态回落 idle）
      return h('span', { className: `dsp-dot s-${cls}`, title: state, 'aria-label': state });
    }

    function IconChevron({ up }) {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true },
        h('path', { d: up ? 'M2 8 L6 4 L10 8' : 'M2 4 L6 8 L10 4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    /**
     * 会话头入口的展开指示三角 —— **逐字复刻官方图标** `IconChevronDownOutlineRegular`
     * （`deepseek-ai/deepseek-harness` → `packages/client/ui-primitives` 的导出）。
     *
     * 几何/描边**逐字取自官方源码**（不是自绘）：
     *   viewBox "0 0 16 16" · fill:none · stroke:currentColor · strokeWidth 1 ·
     *   path "M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6"
     * 尺寸取 **12** —— 与我们的用法孪生的官方入口一致：
     *   ui-jobs/src/client/JobListAction.tsx: `<IconChevronDownOutlineRegular size={12} … />`
     *   （子智能体那份用的是默认 14，两者在官方代码里本就不同；我们按 jobs 对齐。）
     *
     * 为什么单独做一个：本文件既有的 IconChevron 是自绘的 12×12/viewBox 12/stroke-width 1.5，
     * 字形更宽、描边更粗，与系统图标不是同一条路径。
     */
    function IconChevronDownSystem({ className }) {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', className, fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true, strokeWidth: 1,
      },
        h('path', {
          d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6',
          stroke: 'currentColor',
        }));
    }
    function IconKill() {
      return h('svg', { width: 11, height: 11, viewBox: '0 0 12 12', 'aria-hidden': true },
        h('path', { d: 'M3 3 L9 9 M9 3 L3 9', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }));
    }
    /* ZB-04：重跑（↻）。圆弧 + 箭头，几何刻意保守（半径 4、弦长 5.66 < 2r，arc 合法）。
     * 语义永远由 title/aria-label 兜底，不依赖图形被认出来。 */
    function IconRerun() {
      return h('svg', { width: 11, height: 11, viewBox: '0 0 12 12', 'aria-hidden': true },
        h('path', { d: 'M10 6 A4 4 0 1 1 6 2', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }),
        h('path', { d: 'M4.4 0.6 L6.4 2 L4.4 3.4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    /* ZB-04：续接（对话框 + 加号缺口），同样是保守几何（矩形 + 折线尾巴）。 */
    function IconContinue() {
      return h('svg', { width: 11, height: 11, viewBox: '0 0 12 12', 'aria-hidden': true },
        h('rect', { x: 1.5, y: 1.5, width: 9, height: 7, rx: 1.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }),
        h('path', { d: 'M4 8.5 L4 11 L6.8 8.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    }
    /* Z12：派发总开关徽标（标题栏）。sw 来自快照 snapshot.switch（host 读真值文件）；
     * live=可点按钮（点击 switchSet 翻转，成功后 1s 轮询带回新快照）；
     * 非 live=只读（浏览器读不到宿主文件，诚实提示走终端 CLI），状态未知时如实显示「未知」。 */
    function SwitchBadge({ sw, live, onToggle }) {
      const [busy, setBusy] = useState(false);
      const enabled = sw ? sw.enabled !== false : null; // null=状态未知（无快照/数据源不带 switch）
      const label = enabled === null ? t('switchUnknown') : enabled ? t('switchOn') : t('switchOff');
      const dotStyle = enabled === null ? undefined : { background: enabled ? T.stDone : T.danger };
      if (!live) {
        return h('span', { className: 'dsp-conn dsp-switch', title: t('switchHintOffline') },
          h('span', { className: 'dsp-dot', style: dotStyle }), label);
      }
      const flip = () => {
        if (busy || enabled === null) return; // 状态未知时不猜方向，等下一拍快照
        setBusy(true);
        Promise.resolve(onToggle({ enabled: !enabled })).finally(() => setBusy(false));
      };
      return h('button', {
        className: 'dsp-conn dsp-switch', title: t('switchTitle'), disabled: busy,
        onPointerDown: (e) => e.stopPropagation(), onClick: flip,
      }, h('span', { className: 'dsp-dot', style: dotStyle }), label);
    }

    /* 分区（Z11 可折叠）：collapsible 时整条标题栏可点击切换（倒三角指示），折叠态存
     * localStorage['dispatch:section:<id>']。默认开闭表见 SEC_DEFAULT_OPEN。
     * Z9 教训回扣：本标题栏不挂拖拽手势、head 内也不放 button——若将来加手势/按钮，
     * 必须先 isInteractive()（closest）守卫并在按钮 onPointerDown 停冒泡，否则点击会被吃掉。 */
    function Section({ id, title, collapsible, defaultOpen, children }) {
      if (!collapsible) {
        return h('div', { className: 'dsp-sec' }, h('div', { className: 'dsp-sec-title' }, title), children);
      }
      const [open, setOpen] = useState(() => {
        const saved = loadJson(secKey(id), undefined);
        return typeof saved === 'boolean' ? saved : (defaultOpen ?? SEC_DEFAULT_OPEN[id] ?? true);
      });
      const toggle = () => setOpen((prev) => {
        const nv = !prev;
        saveJson(secKey(id), nv);
        return nv;
      });
      return h('div', { className: 'dsp-sec' },
        h('div', {
          className: 'dsp-sec-head', role: 'button', tabIndex: 0, 'aria-expanded': open,
          title, onClick: toggle,
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggle();
            }
          },
        },
          h('span', { className: 'dsp-sec-title' }, title),
          h('span', { className: 'dsp-spring' }),
          h('span', { className: 'dsp-sec-caret', 'aria-hidden': true }, h(IconChevron, { up: open })),
        ),
        open ? children : null,
      );
    }

    /* ZB-51（T5）：**引擎状态条** —— 把「本机自动探测到的三个引擎」显示出来。
     *
     * 为什么需要它（用户要求「避免各种撞墙」）：以前某个引擎不可用时，用户只看到"通道变少了"，
     * 无从知道是**没装**、**没登录**、还是**插件坏了** —— 三种情况的最优动作完全不同。
     * 这里把发现层的结论直接摊开：形态（CLI / 客户端自带 / IDE 自带）、版本、登录态，
     * 异常一律带 `reason`（含"查过多少处"与怎么修）作为悬停提示。
     *
     * 数据来源：core `listChannels()` 的 `engineDetail`（T2 交付）。缺失时**整条不渲染**
     * （向后兼容旧宿主：没有这个字段就当没有这条 UI，绝不显示空壳）。 */
    function EngineStatus({ engineDetail }) {
      if (!engineDetail || typeof engineDetail !== 'object') return null;
      const rows = ['zcode', 'opencode', 'qoder'].map((e) => engineDetail[e]).filter(Boolean);
      if (!rows.length) return null;
      const FORM_KEY = {
        cli: 'engineFormCli',
        'client-bundled-cli': 'engineFormClientBundled',
        'ide-bundled': 'engineFormIde',
        'ide-entry': 'engineFormIdeEntry',
      };
      /* ⚠️ 纪律：client.js **不得写字面色值**（必须走主题令牌，verify-plugin.mjs 会拦）。
       * 故这里不用彩色圆点，改用**形状 + 状态文字**区分（信息量不减少，且自动适配明暗主题）：
       *   可用/已登录 = ● ；找到但未登录 = ○（空心）；未找到 = × */
      const mark = (d) => {
        if (!d.found) return '×';
        if (d.loggedIn === false) return '○';
        return '●';
      };
      const stateText = (d) => {
        if (!d.found) return t('engineNotFound');
        if (d.loggedIn === true) return t('engineLoggedIn');
        if (d.loggedIn === false) return t('engineNotLoggedIn');
        return t('engineLoginUnknown');
      };
      return h('div', { className: 'dsp-dim', style: { fontSize: '11px', marginTop: '2px' } },
        h('div', { style: { marginBottom: '3px' } },
          h('span', { style: { opacity: 0.75 }, title: t('enginesHint') }, `${t('enginesTitle')}：`),
          rows.map((d) => h('span', {
            key: d.engine,
            className: 'dsp-badge',
            style: { marginRight: '4px' },
            title: `${d.summary ?? ''}${d.reason ? `\n${d.reason}` : ''}${d.loginEvidence ? `\n${d.loginEvidence}` : ''}`,
          },
            h('span', { style: { marginRight: '3px' } }, mark(d)),
            d.engine === 'zcode' ? t('engZcode') : d.engine === 'opencode' ? t('engOpencode') : t('engQoder'),
            d.form ? ` · ${t(FORM_KEY[d.form] ?? 'engineFormCli')}` : '',
            d.version ? ` · v${d.version}` : '',
            ` · ${stateText(d)}`))),
      );
    }

    /* ─────── ZB-53：**顺序派发 / 通道折叠的共用件**（浮窗「通道」分区 + 插件详情页配置卡） ───────
     * 背景（用户真机反馈）：「dsh-dispatch」的**插件详情页**光秃秃没有配置区 —— 槽位
     * `plugins.bundle.config`（keyed，按**包名**派发）从没注册过任何东西。卡片要展示的正是
     * "顺序派发"设置 ⇒ 把原先写在 `ChannelSection` 组件内的折叠 / 列表块逻辑**上提到本层**，
     * 浮窗与配置卡共用同一套实现（单一源，不会漂移；卡片不必重写一份）。
     * ⚠️ 本块刻意放在这里（而不是文件更前面）：它用到上面刚定义的 `thinkingLabel`，
     * 提前会踩 TDZ（`client-tdz.test.mjs` 会红，真渲染直接白屏）。 */

    /** 面板 / 配置卡共用的主题令牌变量（`--dsp-*`）；缺了它们 `var(--dsp-*)` 不解析 ⇒ 样式会掉。 */
    const DSP_CSS_VARS = {
      '--dsp-bg': T.bg, '--dsp-bgBar': T.bgBar, '--dsp-sunken': T.sunken, '--dsp-hover': T.hover,
      '--dsp-accent': T.accent, '--dsp-onAccent': T.onAccent, '--dsp-border': T.border, '--dsp-shadow': T.shadow,
      '--dsp-text': T.text, '--dsp-text2': T.text2, '--dsp-text3': T.text3, '--dsp-danger': T.danger, '--dsp-mono': T.mono,
      '--dsp-st-queued': T.stQueued, '--dsp-st-running': T.stRunning, '--dsp-st-done': T.stDone,
      '--dsp-st-failed': T.stFailed, '--dsp-st-killed': T.stKilled, '--dsp-st-interrupted': T.stInterrupted,
      '--dsp-st-idle': T.stIdle,
    };

    const FOLD_ENGINES = KNOWN_ENGINES; // 三引擎**全部**折叠（用户要求：通道只列引擎）
    const foldChannels = (list) => {
      const out = [];
      for (const c of list) {
        const eng = engineOf(c.engine);
        if (!FOLD_ENGINES.includes(eng)) { out.push(c); continue; }
        /* 同一引擎的所有通道合并（首个出现的位置即聚合条目的位置）；id 用裸引擎名。 */
        let agg = out.find((x) => x && x._foldEngine === eng);
        if (!agg) {
          agg = {
            id: eng,
            name: engLabel(eng),
            engine: eng,
            /* 可用性由子通道决定（见下）：**至少一个**可用即可用 ⇒ 初值 false，遇到可用的翻 true。 */
            enabled: false,
            reason: null,
            endpoint: null,
            models: [],
            _foldEngine: eng,
            _routeOf: Object.create(null),   // 模型项 key → 实际通道 id（回写时用）
            _modelOf: Object.create(null),   // 模型项 key → 真实模型名（ZCode 才有 key）
            _modelsByRoute: Object.create(null), // 路由 id → 该路由可用的模型名（档位/回显用）
            /* ZB-58：模型项 key → 是否被用户关闭（core 给**每条通道**打的 `userDisabled`）。
             * 折叠条目本身可能混合状态（ZCode 一条路由 = 多个模型项）⇒ 必须逐项记。 */
            _userDisabled: Object.create(null),
          };
          out.push(agg);
        }
        /* 模型项：**ZCode 用"路由 id"、其它引擎用"模型名"**（用户要求：ZCode 要能看到
         * Plan 与免费额度**两条**）。
         *
         * ⚠️ 为什么 ZCode 不能用模型名（真机反馈"ZCode 怎么剩 1 个？"）：
         * `plan` 与 `account:bigmodel-start-plan` **提供同样的模型**（GLM-5.3 / GLM-5.3-Flash）
         * ⇒ 按模型名去重时后者的路由会**覆盖**前者的 ⇒ 只剩"免费额度"一条，Plan 消失。
         * 用**路由 id** 作选项值就不会撞车（每条路由天然唯一）。
         *
         * OpenCode/Qoder 没有这个问题（模型名本身唯一，且就是它们的执行目标），
         * 故保持"模型名"作值 —— 也让「模型」下拉显示的是真正的模型名而不是内部路由 id。 */
        /* ── 模型项 = **真实模型 × 路由**（用户要求：ZCode 要能选到具体模型）──
         *
         * 真机反馈演进（两次修正，别再倒退）：
         *   ① 最初按"模型名"去重 ⇒ `plan` 与免费额度**提供同样的模型名**，后者覆盖前者 ⇒ ZCode 只剩 1 条；
         *   ② 改成"用路由 id 当选项"能显示两条，但**看不到具体模型**（用户反馈"没有具体的模型可以选"）。
         * 现在：**（模型, 路由）配对**作选项 —— 既能看到具体模型，又不会互相覆盖。
         *   例：`GLM-5.3`（套餐） / `GLM-5.3-Flash`（套餐） / `GLM-5.3-Flash「免费」`（免费额度）。
         *
         * ⚠️ 只在**可用**通道上收集（真机被 fallback-ui 抓到）：不可用通道
         * （如 `builtin:zai-coding-plan` / `oauth_provider_inactive`）不该出现在「模型」下拉里 ——
         * 否则用户能选到一个**必然失败**的项。 */
        const useRouteKeys = (eng === 'zcode');
        if (c.enabled) {
          const routeId = String(c.id);
          const rawModels = Array.isArray(c.models) ? c.models : [c.id];
          /* 免费额度路由**只列真正可用的模型**（用户实测：Start Plan 只给 GLM-5.3-Flash）。
           * 数据源（ZCode 配置）里两条路由都声明了同名模型，故"哪些能用"只能由这里收窄 ——
           * 见 `ZC_FREE_MODELS`（可配置常量）。 */
          const isFreeRoute = /^account:.*start-plan$/.test(routeId);
          const allowed = isFreeRoute ? rawModels.filter((m) => ZC_FREE_MODELS.includes(m)) : rawModels;
          const models = allowed.length ? allowed : rawModels;
          agg._modelsByRoute[routeId] = models;
          for (const m of models) {
            const key = useRouteKeys ? `${routeId}::${m}` : m;
            if (!agg.models.includes(key)) agg.models.push(key);
            agg._routeOf[key] = routeId;
            agg._modelOf[key] = m;
            /* ZB-58：core 已在**每条通道**上打 `userDisabled`（禁用清单命中即为 true）。
             * ⚠️ 只在**可用通道**上收集模型项，故这里只影响"模型是否被用户关掉"，不影响通道可用性。 */
            agg._userDisabled[key] = c.userDisabled === true;
          }
        } else {
          /* 不可用通道仍**登记路由**（旧存值可能指向它 ⇒ 要能被解析成"该引擎条目"，而不是多固定一条），
           * 但不进模型下拉。 */
          agg._routeOf[String(c.id)] = c.id;
        }
        /* ⚠️ 思考强度档位要**取并集**带到折叠条目上：折叠后「通道」下拉只有一条，
         * 而档位下拉（上面与降级区）都从**选中条目**读 `thinkingLevels` ——
         * 不带上就会出现"档位下拉空掉"（真机被 fallback-ui 的真 DOM 渲染抓到）。 */
        if (Array.isArray(c.thinkingLevels) && c.thinkingLevels.length) {
          agg.thinkingLevels = [...new Set([...(agg.thinkingLevels ?? []), ...c.thinkingLevels])];
        }
        /* 额度条数据也要带到折叠条目上（ZCode 免费额度选中时用于显示剩余量）。 */
        if (c.quota && (eng === 'zcode')) { agg.quota = c.quota; agg.quotaText = c.quotaText ?? null; }
        /* ⚠️ 可用性判据（真机反馈修正）：**至少一个**子通道可用 ⇒ 折叠条目可用。
         * 原先写的是"任一子通道不可用 ⇒ 整条不可用" ⇒ 实测发现 ZCode 里有一条禁用的
         * `id:uuid` 路由，于是整条 `ZCode` 被置灰显示成「（不可用：-）」，
         * 用户根本选不了（而后端 plan 完全可用）。语义上也错：
         * 折叠条目的可用性 = "这组里还有能用的东西"。 */
        if (c.enabled) agg.enabled = true;
        if (c.recentQuotaExhausted) agg.recentQuotaExhausted = true;
      }
      return out;
    };
    /** 把任意通道 id（含折叠前的旧存值 `opencode/xyz` / `plan` / `account:bigmodel-start-plan`）
     *  解析成"折叠后清单里"的那条。
     *
     *  ⚠️ 顺序很重要（真机/测试都踩过）：**先看"哪个折叠条目的路由表包含它"，再看同名直配**。
     *  否则 `provider='plan'` 会命中原始 `plan` 条目而不是折叠的 `ZCode`，
     *  导致"上方下拉有 ZCode、下方降级下拉只有 默认套餐"这种**两侧不一致**。 */
    const resolveFoldedChannel = (list, id) => {
      if (!id) return null;
      const byRoute = list.find((c) => c._routeOf && Object.values(c._routeOf).includes(id));
      if (byRoute) return byRoute;
      return list.find((c) => c.id === id)
        ?? list.find((c) => Array.isArray(c.models) && c.models.includes(id)) ?? null;
    };
    /** 当前选中的**模型项** key：选项 key 形态随引擎不同 ——
     *  · ZCode：`<路由id>::<模型名>`（存值里是 provider=路由、model=模型名）⇒ 反查 key；
     *  · OpenCode/Qoder：key 就是模型名。
     *  反查不到就不给值（select 会落到首项「顺序派发」——因为确实没绑定具体模型）。 */
    const modelValueOf = (agg, provider, model) => {
      if (!agg) return '';
      if (agg.engine === 'zcode') {
        if (!model) return '';
        const key = `${provider}::${model}`;
        return agg.models.includes(key) ? key : '';
      }
      return model ?? '';
    };
    /** 降级目标的模型项 key（与主通道**同一套规则**；`fbSel` 解析不到 ⇒ 退回存值，不猜）。 */
    const fbModelValue = (fbSel, fbProvider, fbTarget) => (fbSel
      ? modelValueOf(fbSel, fbProvider, fbTarget?.model)
      : (fbTarget?.model ?? ''));
    /* ───────────── ZB-58：逐模型开关（「可用」开关）的**共用判据** ─────────────
     * core 契约：`modelSwitchesGet()` → `{disabled:[模型项 key...]}`，且**每条通道**带 `userDisabled` 标记。
     * 两处口径统一到这里，避免"下拉过滤"和"列表开关"各算一套而互相矛盾。 */
    /** 禁用清单 / `modelSwitchSet({route})` 的**身份 = 模型项 key**（=「模型」下拉的 option key）。
     *  ⚠️ ZB-58 修正（Lead 真机定证）：**不要**再经 `_routeOf` 映射成路由 id ——
     *  ZCode 的模型项 key 是复合键 `<路由id>::<模型名>`，而 core 的顺序链
     *  （`expandSequentialChain`）正是按**复合键**判 `disabledModels`；映射成 `plan` 会造成：
     *   ① 同一路由下的多个模型被一起关掉；
     *   ② core 顺序链查不到 `plan`（它查 `plan::GLM-5.3`）⇒ **"UI 关了但实际没关"**。
     *  opencode/qoder 的模型项 key 本来就等于通道 id ⇒ 行为不变。 */
    const routeIdOfModelKey = (_agg, key) => String(key ?? '');
    /** 禁用清单（数组）→ Set；null = 该数据源没给清单 ⇒ 退回通道上的 `userDisabled` 标记。 */
    const disabledSetOf = (modelSw) => (modelSw && Array.isArray(modelSw.disabled)
      ? new Set(modelSw.disabled.map((x) => String(x)))
      : null);
    /** 该模型项是否被用户关闭。优先用权威禁用清单，缺失时退回通道标记（同源数据，不会互相矛盾）。 */
    const isModelKeyDisabled = (agg, disabledSet, key) => {
      if (key == null || key === '') return false;
      if (disabledSet) return disabledSet.has(routeIdOfModelKey(agg, key));
      return agg?._userDisabled?.[key] === true;
    };
    /** 某折叠条目的候选模型集（与对应「模型」下拉**同一套 key**）：模型表为空时退回当前值。 */
    const seqCandidatesOf = (agg, provider, model) => {
      const models = agg && Array.isArray(agg.models) ? agg.models : [];
      if (models.length) return models;
      const mv = modelValueOf(agg, provider, model);
      return mv ? [mv] : [];
    };
    /** 构造"一块顺序列表"（主通道 / 降级目标 / 配置卡按引擎）所需的全部派生量 + 动作。
     *  浮窗与配置卡共用；写入时**只发本块引擎**那一份 order（core 按引擎合并 ⇒ 互不干扰）。
     *  `engineName`：调用方**已经知道引擎**时直接给（配置卡按引擎编辑，agg 可能为空）；
     *  不给则从折叠条目推断（浮窗两块：主通道 / 降级目标）。 */
    const makeSeqBlock = ({ owner, agg, candidates, channels, sequential, onSet, engineName, levelsStatus, disabledSet, onToggleModel }) => {
      const engine = engineName ? engineOf(engineName) : (agg ? engineOf(agg.engine) : null);
      const stored = engine && Array.isArray(sequential?.order?.[engine]) ? sequential.order[engine] : [];
      /* 显示顺序 = 三段拼接（**从上到下 = 尝试次序**）：
       *   ① 存了顺序、且当前仍可选的 —— 保持存下来的次序；
       *   ② 当前可选、但不在 order 里的（**新增模型**）—— 追加在后面（绝不消失，用户要求）；
       *   ③ order 里有、但当前候选集没有的（模型临时下线/探测没回来）—— 附在最后并标注
       *      「当前不可用」，**保留用户的排序成果**（直接丢弃等于静默改配置）。 */
      const inOrder = stored.filter((m) => candidates.includes(m));
      const fresh = candidates.filter((m) => !stored.includes(m));
      const stale = stored.filter((m) => !candidates.includes(m));
      const list = [...inOrder, ...fresh, ...stale];
      /** 列表项显示文案：与对应「模型」下拉**同一套**标签（免费额度带「免费」等）。 */
      const labelOf = (m) => (candidates.includes(m)
        ? modelLabelFor(agg?.engine, agg?._routeOf, agg?._modelOf, m)
        : m);
      /** 逐模型档位：`_routeOf` 把「模型项 key」映射回**具体通道 id**，取它自己的 `thinkingLevels`
       *  （ZCode 是「路由×模型」，OpenCode/Qoder 是「模型」）；取不到 ⇒ 只给「默认」，不瞎列。 */
      const levelsOf = (m) => {
        const routeId = agg?._routeOf?.[m] ?? m;
        const ch = routeId ? channels.find((c) => String(c.id) === String(routeId)) : null;
        return Array.isArray(ch?.thinkingLevels) ? ch.thinkingLevels : [];
      };
      /** 某一项**已存**的档位（`levels` 与 `order` 同序；越界/缺失 = null = 引擎默认）。 */
      const levelOf = (m) => {
        const idx = stored.indexOf(m);
        const lvs = engine && Array.isArray(sequential?.levels?.[engine]) ? sequential.levels[engine] : [];
        const lv = idx >= 0 ? lvs[idx] : null;
        return typeof lv === 'string' && lv !== '' ? lv : null;
      };
      /** 写该块的**引擎完整数组**（每项 `{route, reasoningLevel}`）。 */
      const write = (routes, override) => {
        if (!engine || typeof onSet !== 'function') return;
        onSet({
          order: {
            [engine]: routes.map((r) => ({
              route: r,
              reasoningLevel: override && override.route === r ? (override.level || null) : levelOf(r),
            })),
          },
        });
      };
      /** 上移 / 下移一格（相邻交换）—— 不用拖拽库（用户要求 ↑↓ 即可）。
       *  ⚠️ 重排时**档位必须跟着项走**（`write` 负责）：只发 route 字符串会清掉档位。 */
      const move = (idx, delta) => {
        const to = idx + delta;
        if (!engine || to < 0 || to >= list.length) return;
        const next = list.slice();
        const [moved] = next.splice(idx, 1);
        next.splice(to, 0, moved);
        write(next);
      };
      return {
        owner, engine, list, stale, labelOf, levelsOf, levelOf, move,
        /* ZB-56：该引擎的档位探测状态（ready/pending/none/null=未知）—— 行渲染据此显示「档位载入中…」 */
        levelsStatus: levelsStatus ?? null,
        setLevel: (m, lv) => write(list, { route: m, level: lv }),
        /* ── ZB-58：逐模型开关（列表**仍显示已关闭的模型**，否则用户没法重新打开）──
         * `isOff` 判据与「模型」下拉过滤共用（见 `isModelKeyDisabled`），显示与选项不会打架。 */
        isOff: (m) => isModelKeyDisabled(agg, disabledSet, m),
        routeOf: (m) => routeIdOfModelKey(agg, m),
        setEnabled: (m, enabled) => {
          if (typeof onToggleModel !== 'function') return;
          onToggleModel(routeIdOfModelKey(agg, m), enabled !== false);
        },
      };
    };
    /** 折叠清单里 provider 对应的条目（主通道 / 降级目标共用；provider 为空 ⇒ null）。
     *  折叠定义已上提到本层（见 `foldChannels`），这里是"取某 provider 的折叠条目"的单一入口。 */
    const foldedEntryFor = (channels, provider) => (provider
      ? resolveFoldedChannel(foldChannels(Array.isArray(channels) ? channels : []), provider) ?? null
      : null);
    /** 顺序派发的"两块列表"（**浮窗**用）：
     *  · 主通道模型为空 ⇒ 主块；
     *  · 降级目标模型为空 ⇒ 降级块（与主块**同一引擎**时去重 —— 列表按引擎存，重复显示会误导成两份）。 */
    const buildSeqBlocks = ({ channels, channel, fallback, sequential, onSet, levelsStatusByEngine, disabledSet, onToggleModel }) => {
      const list = Array.isArray(channels) ? channels : [];
      const provider = channel?.provider;
      const sel = foldedEntryFor(list, provider) ?? list.find((c) => c.id === provider) ?? null;
      const fbTarget = fallback?.target ?? null;
      const fbProvider = fbTarget?.provider ?? '';
      const fbSel = foldedEntryFor(list, fbProvider);
      const fbModel = fbModelValue(fbSel, fbProvider, fbTarget);
      const seqEnabled = channel?.model == null || channel?.model === '';
      const seqFbOn = !!fallback?.enabled && fbTarget != null && fbSel != null && fbModel === '';
      /* ZB-56：逐引擎档位探测状态（core 的 `channels().levelsStatus`）—— 缺省 null = 未知（正常列档位） */
      const lvStatusOf = (agg) => (agg ? (levelsStatusByEngine?.[engineOf(agg.engine)] ?? null) : null);
      const blocks = [];
      if (seqEnabled) {
        blocks.push(makeSeqBlock({
          owner: 'main', agg: sel, candidates: seqCandidatesOf(sel, provider, channel?.model),
          channels: list, sequential, onSet, levelsStatus: lvStatusOf(sel),
          disabledSet, onToggleModel, // ZB-58：逐模型开关（列表显示禁用态、可原地重开）
        }));
      }
      if (seqFbOn && (!seqEnabled || !sel || engineOf(fbSel.engine) !== engineOf(sel.engine))) {
        blocks.push(makeSeqBlock({
          owner: 'fallback', agg: fbSel, candidates: seqCandidatesOf(fbSel, fbProvider, fbTarget?.model),
          channels: list, sequential, onSet, levelsStatus: lvStatusOf(fbSel),
          disabledSet, onToggleModel,
        }));
      }
      return blocks;
    };
    /** 某引擎的折叠条目（候选模型 + 路由表）；该引擎没有任何通道 ⇒ null。 */
    const foldEngineAgg = (channels, engine) => foldChannels(Array.isArray(channels) ? channels : [])
      .find((c) => engineOf(c.engine) === engineOf(engine)) ?? null;
    /** **按引擎**构造顺序块（插件详情页配置卡用）——与"主通道/降级是否顺序派发"**解耦**：
     *  只要选中该引擎就渲染它的列表。用户打开插件配置就是**去设置**，不能要求"先开了才有东西配"（鸡生蛋）。 */
    const makeEngineSeqBlock = ({ channels, engine, sequential, onSet, levelsStatus, disabledSet, onToggleModel }) => {
      const list = Array.isArray(channels) ? channels : [];
      const agg = foldEngineAgg(list, engine);
      return makeSeqBlock({
        owner: engineOf(engine), engineName: engine, agg,
        candidates: agg && Array.isArray(agg.models) ? agg.models : [],
        channels: list, sequential, onSet, levelsStatus,
        disabledSet, onToggleModel, // ZB-58：逐模型开关（配置卡每行一个「可用」开关）
      });
    };
    /** 主通道当前引擎（按折叠条目解析 provider；解析不到 ⇒ null）。 */
    const mainChannelEngine = (channels, channel) => {
      const list = Array.isArray(channels) ? channels : [];
      const sel = foldedEntryFor(list, channel?.provider) ?? list.find((c) => c.id === channel?.provider) ?? null;
      return sel ? engineOf(sel.engine) : null;
    };
    /** 降级目标当前引擎 + 它是否处于顺序派发（`target.model` 为空）。 */
    const fallbackEngineInfo = (channels, fallback) => {
      const list = Array.isArray(channels) ? channels : [];
      const target = fallback?.target ?? null;
      const sel = target ? foldedEntryFor(list, target.provider) : null;
      const model = target?.model;
      return {
        engine: sel ? engineOf(sel.engine) : null,
        seq: !!fallback?.enabled && target != null && sel != null && (model == null || model === ''),
      };
    };
    /** 卡片默认编辑的引擎（用户要求）：**主通道当前引擎** → 已有顺序的引擎 → ZCode。 */
    const defaultSeqEngine = (channels, channel, sequential) => {
      const main = mainChannelEngine(channels, channel);
      if (main) return main;
      const withOrder = KNOWN_ENGINES.find((e) => Array.isArray(sequential?.order?.[e]) && sequential.order[e].length);
      return withOrder ?? 'zcode';
    };
    /** 某引擎**当前是否正在被顺序派发**（主通道用它 / 降级目标用它）—— 卡片的状态行据此渲染。 */
    const seqEngineUsage = (channels, channel, fallback, engine) => {
      const eng = engineOf(engine);
      const main = mainChannelEngine(channels, channel) === eng && (channel?.model == null || channel?.model === '');
      const fb = fallbackEngineInfo(channels, fallback);
      return { main, fallback: fb.seq && fb.engine === eng };
    };
    /** 渲染顺序列表块（无块时返回 null ⇒ 调用方那一行什么都不渲染）。
     *  · 默认（浮窗）：提示行用**完整** `seqHint`（浮窗空间足够，也把"主/降级两链"讲清）；
     *  · 配置卡：传 `hint`（一行短句）+ `hintTitle`（完整说明进 tooltip）—— 见 DispatchConfigCard。
     *  · `busy`：有写在途 ⇒ **禁掉该块全部交互**（下拉 + ↑↓），防连点；
     *    `saving`：显示「保存中…」指示（只有配置卡传 —— 浮窗的 busy 是降级开关在用，不该显示"保存中"）。
     *  · ZB-55 布局：**表格式**（区块头 + 列头 `#/模型/档位/排序` + 定宽列 + 细分隔线）——
     *    原先「尝试顺序」浮在列表左侧中间、序号/模型间距过大、右侧控件挤在一起且行高不齐。
     *    窄容器（440px）靠"序号 22px + 档位 104px + 排序 56px 定宽、模型列 flex 自适应 + 省略号"不换行错乱。 */
    function SeqBlocksView({ blocks, offline, busy, saving, hint, hintTitle }) {
      if (!blocks || !blocks.length) return null;
      /* ZB-58（用户：「右侧的下拉框和排序按钮，**还是没有完全对齐**。…布局再细调整下」）：
       * **行内不再写任何盒模型样式**。上一轮（ZB-57）内联定死 24px 仍不齐，真因是盒子模型：
       * ↑↓ 按钮默认 content-box（24 + 2×1px 边框 = 实际 26px），下拉是 border-box 的 24px ⇒
       * 差 2px，内联怎么写都对不上（DOM 桩不跑真实样式表，看不出这个冲突）。
       * 现在对齐由 `ensureStyle()` 里的 `.dsp-seq-*` 组保证（下拉与按钮同 22px / border-box /
       * 1px 边框 / 同行高；行与列头**共用同一批列宽类** ⇒ 左边缘严格同线；窄容器只缩列不换行）。
       * 本组件只剩**数据驱动**属性（data-*、title、value、disabled 等），无盒模型内联样式。 */
      /** ZB-58：该块某模型是否被用户关闭（块可能由旧调用方构造 ⇒ 缺 `isOff` 时按"可用"处理，不炸）。 */
      const isOffOf = (blk, m) => (blk && typeof blk.isOff === 'function' ? blk.isOff(m) : false);
      return h('div', { className: 'dsp-stack', 'data-dsp-sequential': 'list' },
        h('div', { className: 'dsp-note', role: 'status', title: hintTitle ?? (offline ? t('seqOfflineHint') : undefined) },
          hint ?? t('seqHint')),
        blocks.map((b) => h('div', {
          className: 'dsp-stack', key: b.owner, 'data-dsp-seq-block': b.owner,
        },
          /* 区块头：标题在**列表上方** + 右对齐徽标（引擎 · 可用 n/m）+ 保存中指示 */
          h('div', { className: 'dsp-field', title: t('seqOrderLabel') },
            h('span', { className: 'dsp-field-k' }, t('seqOrderLabel')),
            h('span', { className: 'dsp-spring' }),
            saving ? h('span', { className: 'dsp-dim', role: 'status', 'data-dsp-seq-saving': '1' }, t('seqSaving')) : null,
            /* ZB-58：徽标带上**可用计数**（用户要求「可用 8/10」）—— 关掉的仍留在列表里可重开。 */
            h('span', { className: 'dsp-badge', 'data-dsp-seq-avail': `${b.list.length - b.list.filter((m) => isOffOf(b, m)).length}/${b.list.length}` },
              `${b.owner === 'fallback' ? `${t('fallbackTitle')} → ` : ''}${b.engine ? engLabel(b.engine) : '-'} · ${tFmt('modelAvailCount', { n: b.list.length - b.list.filter((m) => isOffOf(b, m)).length, total: b.list.length })}`)),
          !b.engine || !b.list.length
            ? h('div', { className: 'dsp-note', role: 'status' }, t('seqEmpty'))
            : h('div', { className: 'dsp-stack' },
              /* 列头：与行**共用同一批列宽类**（dsp-seq-idx / -name / -lv / -sort-col / -sw-col）⇒ 不另写宽度就不会错位；
               * 文字样式由 `.dsp-seq-head > *` 统一（11px/16px/次级色、左对齐），不居中。 */
              h('div', { className: 'dsp-seq-head', 'data-dsp-seq-head': b.owner },
                h('span', { className: 'dsp-seq-idx' }, '#'),
                h('span', { className: 'dsp-seq-name' }, t('model')),
                h('span', { className: 'dsp-seq-lv' }, t('seqLevelLabel')),
                h('span', { className: 'dsp-seq-sort-col' }, t('seqSortCol')),
                h('span', { className: 'dsp-seq-sw-col' }, t('modelSwitchCol'))),
              b.list.map((m, i) => {
                /* ZB-52b：该行模型的档位下拉选项（取不到档位声明 ⇒ 只有「默认」，不瞎列）。 */
                const lvList = b.levelsOf(m);
                const curLv = b.levelOf(m);
                /* ZB-56：该引擎档位探测**还没出结果**且这行还没探到档位 ⇒ 显示「档位载入中…」
                 * （disabled、值保持默认），而不是只给一个「默认」让人误以为该模型没有档位维度。
                 * 已探到的档位（缓存旧值）照常列 —— 那是真数据，不藏。 */
                const lvPending = b.levelsStatus === 'pending' && lvList.length === 0;
                /* 存值不在当前档位集里（探测表变化 / 该模型档位暂时没探测到）⇒ 显式列出并标注，
                 * 否则 <select value> 命不中 option 会显示首项「默认」，与真实存值不符（ZB-31 同类坑）。 */
                const lvStale = curLv != null && !lvList.includes(curLv);
                const lvAria = `${t('seqLevelLabel')}：${b.labelOf(m)}`;
                /* ZB-58：该模型是否被用户关闭（关闭 ⇒ 仍显示在列表里可重开；行降不透明度 + 开关呈关）。 */
                const off = isOffOf(b, m);
                return h('div', {
                  key: m, 'data-dsp-seq-item': m, 'data-dsp-seq-owner': b.owner,
                  'data-dsp-model-disabled': off ? '1' : '0',
                  className: `dsp-seq-row${off ? ' dsp-seq-row-off' : ''}`,
                },
                  h('span', { className: 'dsp-seq-idx' }, `${i + 1}`),
                  h('span', {
                    className: 'dsp-seq-name',
                    title: `${b.labelOf(m)}${off ? `（${t('modelDisabledTag')}）` : ''}${b.stale.includes(m) ? t('seqUnavailable') : ''}`,
                  },
                    b.stale.includes(m) ? `${b.labelOf(m)}${t('seqUnavailable')}` : b.labelOf(m),
                    off ? h('span', { className: 'dsp-seq-off' }, ` · ${t('modelDisabledTag')}`) : null),
                  /* 逐模型档位下拉：value = 原始档位字符串（'' = 引擎默认）；label = 中文标签。
                   * ZB-56：该引擎 `levelsStatus === 'pending'` 且**还没探到**任何档位 ⇒ 首项显示
                   * 「档位载入中…」（disabled，值仍为空=保持默认），而不是只列一个「默认」让人
                   * 以为这模型没档位；探测完成后数据自然重渲、自动恢复可选项（不轮询）。 */
                  h('select', {
                    className: 'dsp-select dsp-seq-lv', 'data-dsp-seq-level': m,
                    ...(lvPending ? { 'data-dsp-seq-level-pending': '1' } : {}),
                    value: curLv ?? '',
                    disabled: busy || lvPending,
                    title: lvPending ? t('thinkLoading') : lvAria, 'aria-label': lvPending ? t('thinkLoading') : lvAria,
                    onChange: (e) => b.setLevel(m, e.target.value),
                  },
                    lvPending
                      ? h('option', { key: '__default', value: '', disabled: true }, t('thinkLoading'))
                      : h('option', { key: '__default', value: '' }, t('seqLevelDefault')),
                    lvPending ? null : (lvStale ? h('option', { key: '__stale', value: curLv }, `${thinkingLabel(curLv)}（${t('thinkingStale')}）`) : null),
                    lvPending ? null : lvList.map((lv) => h('option', { key: lv, value: lv }, thinkingLabel(lv)))),
                  /* ↑↓ 两个方形小按钮（不用拖拽库）。首/末项各自禁用对应方向；保存中整块禁用。
                   * 尺寸/边框/盒子模型全在 `.dsp-seq-move` 类里（与左侧下拉同 22px ⇒ 水平一条线）。 */
                  h('span', { className: 'dsp-seq-sort' },
                    h('button', {
                      className: 'dsp-seq-move', type: 'button',
                      disabled: busy || i === 0, title: t('seqUp'),
                      'aria-label': `${t('seqUp')}：${b.labelOf(m)}`,
                      onClick: () => b.move(i, -1),
                    }, '↑'),
                    h('button', {
                      className: 'dsp-seq-move', type: 'button',
                      disabled: busy || i === b.list.length - 1, title: t('seqDown'),
                      'aria-label': `${t('seqDown')}：${b.labelOf(m)}`,
                      onClick: () => b.move(i, 1),
                    }, '↓')),
                  /* ZB-59：逐模型「可用」= **DSH 风格滑块开关**（`role="switch"` + `aria-checked` + 旋钮 span）。
                   * 关掉 ⇒ 不出现在「模型」下拉、不参与顺序派发链；顺序列表本身不动，仍显示在此以便随时重开。
                   * 视觉：轨道/旋钮全部走主题令牌（明暗两套自动反转），不再用 `.dsp-dot`（那是"指示灯按钮"语言）。 */
                  h('button', {
                    className: 'dsp-sw-ui dsp-seq-sw-col', type: 'button', role: 'switch',
                    'data-dsp-model-toggle': b.routeOf(m),
                    'data-dsp-model-enabled': off ? '0' : '1',
                    'aria-checked': !off,
                    disabled: busy || offline,
                    title: `${b.labelOf(m)}：${off ? t('modelDisabledTag') : t('modelSwitchCol')}`,
                    'aria-label': `${b.labelOf(m)}：${off ? t('modelDisabledTag') : t('modelSwitchCol')}`,
                    onClick: () => b.setEnabled(m, off),
                  },
                    h('span', { className: 'dsp-sw-knob' })));
              })))));
    }

    /* 通道分区：切换器（provider+model+思考强度，不可用项置灰带原因）+ 自动降级开关。
     * ZB-30（用户要求）：「自动降级」改成**开关**（参考派发总开关：点击开/关、带指示灯），
     * 打开后下面才显示 通道 / 模型 / 思考强度 三个下拉（与上面「通道」分区同形）；关闭时不显示。
     * 目标为空的两维（模型、思考强度）语义是「沿用原任务」，故首项标签不是「Agent决定」
     * （降级是自动触发的，此刻并没有 Agent 在决定——与 ZB-29c 移除派发栏 Agent决定同一条理由）。 */
    /* ⚠️ ZB-52：新增的 `sequential` / `onSequentialSet` **追加在 `sw` 之后** ——
     * `frozen-probe.test.mjs` F 段钉住了 `… offline, offlineReason, sw` 这段**参数顺序**
     * （它用"包含"而非全等来防漏传，故插入到中间会误报）。 */
    function ChannelSection({ channelsInfo, channel, fallback, onSwitch, onFallbackSet, offline, offlineReason, sw, chanError, sequential, onSequentialSet, disabledModels, onToggleModel }) {
      const [fbFeedback, setFbFeedback] = useState(null);
      const [busy, setBusy] = useState(false);
      /* ZB-58：逐模型开关的禁用清单（null = 父层还没读到 ⇒ 退回通道上的 `userDisabled` 标记）。
       * 判据统一走模块级 `isModelKeyDisabled` —— 与配置卡列表开关**同一口径**，不会互相矛盾。 */
      const disabledSet = disabledSetOf(Array.isArray(disabledModels) ? { disabled: disabledModels } : null);

      /* ── ZB-51：**通道折叠**（用户要求：「通道」选引擎，「模型」里选模型）──
       *
       * ⚠️ 必须定义在**本函数最前面**：下面的 `sel` / `groupedChannelOptions` 都要用它。
       * 曾把它们放在使用点之后（`const` 声明前使用 ⇒ TDZ）⇒ 面板**直接白屏**。
       * 这类错误 `node --check` 查不出来（语法合法），只有真渲染才炸 —— 见 tasks/_tdz-check.mjs。
       *
       * 问题：OpenCode 探测出 12 个免费模型、Qoder 探测出 15 个模型，core 给**每个模型一条通道**
       * （"通道即执行目标"是 core 的模型），结果 15 个模型全堆在「通道」下拉里，
       * 而「模型」下拉反而只有一个选项 —— 层级用反了。
       *
       * 做法（**只在展示层折叠，不动 core 语义**）：
       *   · `opencode` / `qoder`：把同引擎的所有模型通道**聚合**成一条"引擎通道"
       *     （id 用裸引擎名，模型并集进 `models`）⇒「通道」里只有一条，模型在「模型」下拉里选；
       *   · `zcode`：把该引擎的**所有路由**也聚合成一条 `zcode` —— 用户最终要的是
       *     「通道 = ZCode / OpenCode / Qoder 三条」，ZCode 的"套餐 / 免费额度"作为
       *     **模型下拉里的一项**（用户明确要求：「Zcode 只保留 Plan 和免费额度」两条路由）。
       *
       * ⚠️ 回写规则（**必须与实际路由一致**，否则会静默跑错通道）：
       *   · 选 ZCode 的「免费额度」项 ⇒ `provider = account:bigmodel-start-plan`（**专用通道 id**）；
       *   · 选 ZCode 的普通模型（如 GLM-5.3）⇒ `provider = plan`（默认套餐，由 runner 选 provider）；
       *   · 选 OpenCode / Qoder 的模型 ⇒ `provider = opencode | qoder`（裸引擎名）+ 具体模型。
       *   见下方 `onPickProvider` / `onPickModel` 的映射实现。
       *
       * ⚠️ 兼容：core 里"每模型一条通道"的数据仍在（工具 / 降级链 / 快照都不受影响）；
       * 旧存值若指向具体通道 id（`opencode/xyz` / `account:bigmodel-start-plan`），
       * `resolveFoldedChannel` 会把它映射回折叠条目并**还原出正确的模型选项**。 */
      /** 把"折叠条目 + 模型项"映射回**真实的 provider/model**（回写核心，必须准确）。 */
      const routeForPick = (agg, model) => {
        if (!agg) return null;
        const real = agg._routeOf?.[model] ?? null;
        const realModel = agg._modelOf?.[model] ?? null;
        if (agg.engine === 'zcode') {
          /* ZCode：模型项 key 是 `<路由id>::<模型名>` ⇒ provider=那条路由、model=真实模型名。
           * 这样"免费额度 + GLM-5.3-Flash"能精确落到 `account:bigmodel-start-plan` + `GLM-5.3-Flash`。 */
          return { provider: real ?? 'plan', model: realModel };
        }
        /* OpenCode / Qoder：provider=裸引擎名，model=具体模型（core 已认裸引擎名）。 */
        return { provider: agg.id, model: model || null };
      };
      /** 把任意通道 id（含折叠前的旧存值 `opencode/xyz` / `plan` / `account:bigmodel-start-plan`）
       *  解析成"折叠后清单里"的那条。
       *
       *  ⚠️ 顺序很重要（真机/测试都踩过）：**先看"哪个折叠条目的路由表包含它"，再看同名直配**。
       *  否则 `provider='plan'` 会命中原始 `plan` 条目而不是折叠的 `ZCode`，
       *  导致"上方下拉有 ZCode、下方降级下拉只有 默认套餐"这种**两侧不一致**。 */

      const channels = channelsInfo?.channels ?? [];
      const warnings = channelsInfo?.warnings ?? [];
      /* ⚠️ `sel` 与 `models` 都基于**折叠后**的清单 —— 见下方 foldChannels 的说明。
       * 这样"选中折叠条目 ⇒ 模型下拉拿到整个模型的并集"；旧存值（`opencode/xyz`）也能被
       * resolveFoldedChannel 映射回折叠条目，不至于显示成"不可用：-"。
       * 注意：折叠定义在下面（函数提升不可用于 const）—— 故这里先取原始，再用下面重算的变量。 */
      const sel = resolveFoldedChannel(foldChannels(channels), channel.provider)
        ?? channels.find((c) => c.id === channel.provider) ?? null;
      const models = sel && Array.isArray(sel.models) ? sel.models : [];
      /* ZB-51：若当前 provider 就是 ZCode 的**免费额度通道**，模型下拉要**回显「免费额度」**
       * 那个伪项 —— 否则 select 匹配不到 option 会掉到首项「通道默认模型」，
       * 用户以为自己在用套餐模型（静默错配）。 */
      /* 当前选中的**模型项**：选项 key 形态随引擎不同 ——
       * · ZCode：`<路由id>::<模型名>`（存值里是 provider=路由、model=模型名）⇒ 反查 key；
       * · OpenCode/Qoder：key 就是模型名。
       * 反查不到就不给值（select 会落到首项「通道默认模型」——因为确实没选具体模型）。 */
      const modelValue = modelValueOf(sel, channel.provider, channel.model);
      /* ZB-58：该模型项是否被用户关闭（关闭 ⇒ 不出现在「模型」下拉；**当前值例外**，见 modelOptions）。 */
      const modelOff = (agg, m) => isModelKeyDisabled(agg, disabledSet, m);
      /* ── ZB-33：免费额度（Start Plan）通道的**额度条** ──
       * 数据来自宿主 `action=channels` 的 `channels[].quota`（只读 ZCode 客户端日志，
       * 零网络请求；同一份数据也暴露给 agent 工具，见 index.js 的工具描述）。
       * 只在**选中该通道**时出现（用户要求：切到免费额度模型才显示）。 */
      const giftSel = sel && /^account:[a-z]+-start-plan$/.test(sel.id ?? '') ? sel : null;
      const giftQuota = giftSel?.quota ?? null;
      const giftRemain = giftQuota ? (Number.isFinite(giftQuota.remainingUnits) ? giftQuota.remainingUnits : giftQuota.availableUnits) : null;
      const giftPct = giftQuota && Number.isFinite(giftRemain) && Number.isFinite(giftQuota.totalUnits) && giftQuota.totalUnits > 0
        ? Math.max(0, Math.min(100, Math.round((giftRemain / giftQuota.totalUnits) * 100)))
        : null;
      const giftText = giftSel ? (giftSel.quotaText ?? (giftSel.giftQuotaUnavailable ? `${t('giftQuotaUnavailable')}（${giftSel.giftQuotaUnavailable}）` : null)) : null;

      const switchProvider = (id) => {
        /* ⚠️ ZB-51：必须在**折叠后**的清单里找 —— 折叠条目的 id 是裸引擎名（`opencode` / `qoder`），
         * 原始清单里只有 `opencode/<model>` 形态，直接用 `channels.find` 会找不到 ⇒ **选不中**。
         * 找不到折叠条目时再回退原始清单（未知通道）。 */
        const folded = foldChannels(channels);
        const c = resolveFoldedChannel(folded, id) ?? channels.find((x) => x.id === id);
        if (!c || !c.enabled) return; // 不可用项不允许选中（option 已 disabled）
        /* 选中引擎条目 ⇒ 模型默认取该引擎的**第一个可用模型**（ZB-58：跳过用户已关闭的模型，
         * 免得一切引擎就落到一个"不会出现在下拉里"的死值上），并经 routeForPick 映射回真实路由。 */
        const first = (c.models ?? []).find((m) => !modelOff(c, m)) ?? (c.models && c.models.length ? c.models[0] : null);
        const pick = routeForPick(c, first) ?? { provider: c.id, model: first };
        onSwitch(pick);
      };
      const switchModel = (m) => {
        /* ⚠️ ZB-52c（用户要求去掉开关）：「模型」下拉选「顺序派发」（值 `''`）**本身就是开启** ——
         * 写回 `model = null` 即可；这里**不再**调用 setSequential（core 已删除 `enabled`，传它会抛
         * TypeError）。唯一的真相 = 该通道 model 是否为空，面板里不再有第二个"开关状态"。 */
        /* ZCode 的模型项 key 是 `<路由id>::<模型名>` ⇒ provider 与 model **必须一起写**
         * （否则会出现"provider=plan 但用户以为在用免费额度"的静默错配）。 */
        if (sel && sel.engine === 'zcode') { const p = routeForPick(sel, m); onSwitch({ provider: p.provider, model: p.model }); return; }
        onSwitch({ provider: channel.provider, model: m || null });
      };
      /** 模型下拉里某一项的**显示文案**（上面「通道」分区用）。
       *  ZB-58：当前值若恰好被用户关闭，仍要能渲染出来并标注「已关闭」（见 modelOptions 的例外）。 */
      const modelOptionLabel = (m) => {
        const base = modelLabelFor(sel?.engine, sel?._routeOf, sel?._modelOf, m);
        return modelOff(sel, m) ? `${base}（${t('modelDisabledTag')}）` : base;
      };

      /* 模型下拉的选项：折叠条目的模型并集；ZCode 的「免费额度」也在其中（伪项）。
       * 当前值必须**始终可渲染**（否则 select 会掉到首项显示成「通道默认模型」）。 */
      const modelOptionsAll = models.length
        ? models
        : (modelValue ? [modelValue] : []); // 通道没给模型表时至少显示当前值
      /* ── ZB-58（用户要求「关闭的话，则不再在派发台面板的选项中展示」）──
       * 被关掉的模型**不出现在「模型」下拉里**；**唯一例外 = 当前存值** ——
       * 否则 `<select value>` 匹配不到 option 会掉到首项、显示与真实存值不符（ZB-31 同类坑），
       * 所以当前值仍然渲染，并在 label 上标注「已关闭」。 */
      const modelOptions = modelOptionsAll.filter((m) => m === modelValue || !modelOff(sel, m));

      /* ── 双引擎（OpenCode 接入）：通道下拉按**引擎分组**（optgroup）──
       * 设计决策（与用户确认，别再改成双 tab）：引擎是「通道」的**属性**，不是第二个维度 ——
       * 进程列表 / 文件锁 / 队列 / 用量 / 唤醒通知 / 降级链全部与引擎无关，
       * 拆 tab 会把进程列表与降级链割裂，丢掉「跨引擎降级」这个最大增量。
       * 故这里只做**下拉分组 + 徽标**，引擎专属设置靠「按选中通道动态显示」（见下面的提示行）。
       * ZB-51：分组之上再做**折叠**（同引擎的多条通道合成一条）—— 见 `foldChannels`。
       * 分组顺序与 core 的 `listChannels()` 一致：先 ZCode，再 OpenCode，再 Qoder。
       * 旧的 core（通道无 `engine` 字段）⇒ 全部落进 ZCode 组（向后兼容）。
       * 当前值若已掉线（历史存值指向不可用通道）仍单独列出并标注「不可用：原因」（ZB-33b 语义不变）。 */
      /* ZB-51：**引擎归一化的唯一权威**（客户端侧）。
       * 原先到处写 `c.engine === 'opencode' ? 'opencode' : 'zcode'` —— 二元判断，第三个引擎
       * （qoder）一来就会被**错误地归进 ZCode 组**（下拉分组、徽标、提示全错），且不会报错。
       * 这里统一成一个函数，所有需要"引擎名"的地方都走它。 */
      const ENG_GROUP_KEY = { zcode: 'engGroupZcode', opencode: 'engGroupOpencode', qoder: 'engGroupQoder' };

      const ENGINE_GROUPS = [
        { key: 'zcode', label: t(ENG_GROUP_KEY.zcode) },
        { key: 'opencode', label: t(ENG_GROUP_KEY.opencode) },
        { key: 'qoder', label: t(ENG_GROUP_KEY.qoder) },
      ];
      /* ── 通道过滤开关（用户要求）：两个独立开关，作用于「通道」与「自动降级目标」两处下拉 ──
       * 「仅看可用」默认**开**：与改造前的既有行为一致（下拉只列可用通道，ZB-33b）。
       *   ⚠️ 与 ZB-33b 的唯一差别：关掉它时**不可用通道也会列出来**（置灰 + 标注原因）——
       *   这正是这个开关存在的意义（否则它与"永远开"没有区别，等于死开关）。
       * 「仅看免费」默认**关**：开启后只列**不需要付费额度**的通道。
       *   "免费"的判据（写死在这里，且**只影响展示，不影响调度**）：
       *     ① `engine === 'opencode'` ⇒ 免费。依据：core 的清单来自 `opencode models`，
       *        而 `OPENCODE-DISPATCH-HANDOFF.md` §2 实测该命令在本机 0 凭据下**只返回免费模型**；
       *        将来 OpenCode 若在目录里混入付费模型，这条判据要跟着改（届时用 id 里的 `-free` 兜一层）。
       *     ② ZCode 侧的免费额度通道：`account:<family>-start-plan`（ZB-33 的 Start Plan）与
       *        `provider === 'start-plan'/'gift'`。
       *   **刻意不把** `personal`（个人 Key）算作免费 —— 那走用户自己的付费额度。
       *   状态存 localStorage（与分区展开态同款范式）：面板重开/刷新后保留用户选择。 */
      const FREE_CHANNEL_RE = /^account:[a-z]+-start-plan$/;
      const isFreeChannel = (c) => {
        const id = String(c?.id ?? '');
        return !!c && (c.engine === 'opencode' || FREE_CHANNEL_RE.test(id) || id === 'start-plan' || id === 'gift');
      };
      /* 两个开关的持久化键（**单一源**：读取默认值、写回、测试断言都用这里，避免三处各写一遍字符串）。 */
      const filtStorageKey = { available: 'dispatch:filter:available', free: 'dispatch:filter:free' };
      const filtAvailInit = (() => { try { return localStorage.getItem(filtStorageKey.available) !== '0'; } catch { return true; } })();
      const filtFreeInit = (() => { try { return localStorage.getItem(filtStorageKey.free) === '1'; } catch { return false; } })();
      const [filtAvailable, setFiltAvailable] = useState(filtAvailInit);
      const [filtFree, setFiltFree] = useState(filtFreeInit);
      const toggleFilt = (which) => {
        const next = which === 'free' ? !filtFree : !filtAvailable;
        if (which === 'free') setFiltFree(next); else setFiltAvailable(next);
        try { localStorage.setItem(filtStorageKey[which], next ? '1' : '0'); } catch { /* 存储不可用不影响本次会话 */ }
      };
      /* 应用过滤：先判可用（可选）、再判免费（可选）。
       * 返回值统一成 `{...channel, _reasons: [...]}`，让 option 渲染唯一化（见 channelOptionNode）。 */
      const applyChanFilters = (list) => list.filter((c) => {
        if (filtAvailable && !c.enabled) return false;
        if (filtFree && !isFreeChannel(c)) return false;
        return true;
      });
      const freeCount = channels.filter(isFreeChannel).length;

      const channelOptionNode = (c) => {
        const reasons = (c._reasons ?? []).slice();
        if (!c.enabled) reasons.push(`${t('chanDisabled')}：${c.reason ?? '-'}`);
        if (c.recentQuotaExhausted) reasons.push(t('chanQuotaExhausted'));
        return h('option', { key: c.id, value: c.id, ...(c.enabled ? {} : { disabled: true }) },
          `${c.name ?? c.id}${reasons.length ? `（${reasons.join('；')}）` : ''}`);
      };

      /* ── ZB-51：**通道折叠**（用户要求：「通道」选引擎，「模型」里选模型）──
       *
       * 问题：OpenCode 探测出 12 个免费模型、Qoder 探测出 15 个模型，core 给每个模型一条通道
       * （因为"通道即执行目标"是 core 的模型），结果**15 个模型全堆在「通道」下拉里**，
       * 而「模型」下拉反而只有一个选项 —— 层级用反了。
       *
       * 做法（**只在展示层折叠，不动 core 语义**）：
       *   · `opencode` / `qoder`：把同引擎的所有模型通道**聚合**成一条"引擎通道"
       *     （id 用裸引擎名，模型并集进 `models`）⇒ 「通道」里只有一条，模型在「模型」下拉里选；
       *   · `zcode`：**不折叠** —— 它的几条是**不同计费路由**（套餐/免费额度），必须各自可选。
       *
       * ⚠️ 兼容：core 里"每个模型一条通道"的数据仍在（工具/降级链/快照都不受影响）；
       * 面板选中折叠后的引擎通道时，回写的是 `{provider:'opencode', model:'<具体模型>'}`，
       * core 的 `resolveEngineOf` 已认裸引擎名 ⇒ 引擎路由不受影响（详见 qoder-routing 测试）。
       * 旧存值若指向具体模型通道（`opencode/xyz`），下方 `sel` 的兜底会把它映射回引擎通道。 */
      /* 被过滤掉的**当前值**：为什么还留在下拉里？两种情形分开标注（不谎报）。
       *   · 本身不可用（掉线）⇒ 「不可用：原因」（ZB-33b 原语义）
       *   · 本身可用、只是被「仅看免费」挡下 ⇒ 「当前选择」 */
      const pinnedReasonText = (c) => {
        if (!c) return `${t('chanDisabled')}：-`;
        return c.enabled ? t('filtCurrent') : `${t('chanDisabled')}：${c.reason ?? '-'}`;
      };
      const groupedChannelOptions = (current) => {
        /* ⚠️ 先折叠再过滤：折叠后的引擎条目才是"用户能选的东西"，
         * 过滤开关（仅看可用 / 仅看免费）也应作用在折叠后的条目上
         * （整条引擎条目只有在**所有**子模型都不可用时才不可用 —— foldChannels 已处理）。 */
        const folded = foldChannels(channels);
        const kept = applyChanFilters(folded);
        const cur = resolveFoldedChannel(folded, current) ?? channels.find((c) => c.id === current) ?? null;
        /* 当前选中值必须**始终可渲染**，否则 `<select value>` 匹配不到 option，
         * 浏览器会显示首项 —— 与真实存值不符（ZB-31/ZB-33b 同类坑）。
         * ZB-51：`cur` 已在折叠清单里找过 + 原清单兜底，故旧存值 `opencode/xyz` 也能正确定位。 */
        const list = kept.some((c) => c.id === current) || !current
          ? kept
          : [
            cur
              ? { ...cur, _reasons: [pinnedReasonText(cur)] }
              : { id: current, name: current, enabled: false, _reasons: [pinnedReasonText(null)] },
            ...kept,
          ];
        const out = [];
        for (const g of ENGINE_GROUPS) {
          const items = list.filter((c) => engineOf(c.engine) === g.key);
          if (items.length) out.push(h('optgroup', { key: g.key, label: g.label }, items.map(channelOptionNode)));
        }
        const others = list.filter((c) => !KNOWN_ENGINES.includes(engineOf(c.engine)));
        if (others.length) out.push(h('optgroup', { key: 'other', label: t('provider') }, others.map(channelOptionNode)));
        return out;
      };
      /* 引擎专属提示：跟随**选中通道**动态显示（用户要求：不做双 tab，靠动态区块解决）。
       * 文案里的能力边界是硬事实（core 的 validateSpec 会拒 opencode+mode），不是软提示。 */
      const chanEngine = sel ? engineOf(sel.engine) : null;
      const chanEngineNote = chanEngine
        ? h('div', { className: 'dsp-dim', style: { fontSize: '11px' } },
          h('span', { className: 'dsp-badge' }, `${t('engBadge')}：${engLabel(chanEngine)}`),
          h('span', { style: { marginLeft: '6px' } }, t(chanEngine === 'opencode' ? 'chanEngineHintOpencode' : chanEngine === 'qoder' ? 'chanEngineHintQoder' : 'chanEngineHintZcode')))
        : null;

      /* 降级目标（单目标；core 仍支持多目标列表供 CLI 使用）。targets[0] 为准，旧 chain 兜底。 */
      const fbEnabled = !!fallback?.enabled;
      const fbTarget = fallback?.target ?? null;
      const fbProvider = fbTarget?.provider ?? '';
      /* ⚠️ ZB-51：降级区与上面「通道」分区**共用折叠清单** ——
       * 折叠后 provider 是裸引擎名（`opencode`/`qoder`），在**原始** channels 里找不到，
       * 故一律经 `resolveFoldedChannel` 解析。真机反馈：降级区里 OpenCode/Qoder **选不中**
       * （`fbSwitchProvider` 用原始清单 find ⇒ 找不到 ⇒ 直接 return，静默失效）。 */
      const fbFolded = foldChannels(channels);
      const fbSel = resolveFoldedChannel(fbFolded, fbProvider) ?? null;
      /* ⚠️ ZB-51：档位集必须取**该引擎下所有子通道的并集**（与上方「通道」分区**同一来源**）。
       * 原先取"第一个带 thinkingLevels 的子通道" ⇒ 降级区只剩 3 档、上方有 5 档，
       * 两侧选项集不一致（被 fallback-ui 断言抓到）。 */
      const fbEng = fbSel ? engineOf(fbSel.engine) : null;
      const fbThinkingUnion = fbSel
        ? [...new Set([
          ...(Array.isArray(fbSel.thinkingLevels) ? fbSel.thinkingLevels : []),
          ...channels.filter((c) => engineOf(c.engine) === fbEng).flatMap((c) => (Array.isArray(c.thinkingLevels) ? c.thinkingLevels : [])),
        ])]
        : [];
      const fbModels = fbSel && Array.isArray(fbSel.models) ? fbSel.models : (fbTarget?.model ? [fbTarget.model] : []);
      /* ⚠️ ZB-52（与上方「通道」分区**同一纪律**）：档位集**优先按降级目标选中的模型**取。
       * 上方改成"按模型过滤"后，若这里仍用引擎并集，两侧就会出现
       * 「上方 2 档 / 降级 5 档」的不一致（fallback-ui 断言抓到）。
       * 定位不到具体通道（ZCode 路由形态 / 探测未预热）⇒ 退化为引擎并集。 */
      /* ⚠️ 与上方**同一套 key 形态**：ZCode 是 `<路由id>::<模型名>`，其余引擎就是模型名本身。
       * （写成裸模型名会查不到 ZCode 的具体通道 ⇒ 白白退回并集，两侧又不一致。） */
      const fbRouteKey = fbTarget?.model
        ? (fbSel && fbSel.engine === 'zcode' ? `${fbProvider}::${fbTarget.model}` : fbTarget.model)
        : null;
      const fbModelCh = fbRouteKey
        ? channels.find((c) => c.id === (fbSel?._routeOf?.[fbRouteKey] ?? fbRouteKey))
        : null;
      const fbPerModel = Array.isArray(fbModelCh?.thinkingLevels) && fbModelCh.thinkingLevels.length
        ? [...fbModelCh.thinkingLevels]
        : null;
      const fbLevels = fbPerModel ?? fbThinkingUnion;
      /* ZB-51：与上面「通道」分区同一条转换 —— ZCode 的模型项是**路由 id**（存在 provider 里），
       * 其它引擎存的是 model。这样「通道」下拉的当前值才能命中折叠条目（不会多固定一条）。 */
      const fbValue = fbSel?.id ?? fbProvider;
      /* 与上方同一套"模型项 key"解析（ZCode 是 `<路由id>::<模型名>`；其它引擎是模型名）。
       * ZB-53：规则已上提到共用件 `fbModelValue()`（浮窗与插件详情页配置卡同一套，不重复实现）。 */
      const fbModel = fbModelValue(fbSel, fbProvider, fbTarget);
      /* ZB-58：降级目标的模型下拉同样**过滤已关闭项**（当前值例外 —— 保证 <select value> 能命中）。 */
      const fbModelsShown = fbModels.filter((m) => m === fbModel || !modelOff(fbSel, m));
      /* ZB-30b（用户要求「不要沿用原任务，就跟上面完全一致的选项逻辑」）：降级目标的模型/思考强度
       * 用与上面「通道」分区**逐字相同**的选项集与默认值 —— 模型首项 `（通道默认模型）`（值 ''）、
       * 思考强度首项 `Agent决定（按任务判断）`（值 'agent'）。语义也随之对齐：
       *   · model='' ⇒ 不传 --model（用该 provider 的默认模型，= 上面的「通道默认模型」）
       *   · reasoningLevel='agent' ⇒ runner 按 ZCode 默认规则解析（模型声明档位的最后一档），
       *     与上面「Agent决定」在未显式指定档位时走的是同一条规则（仅新建会话生效）。
       * 注：core/CLI 侧的 `null` 仍表示"沿用原任务"（旧调用方兼容），面板不再产生 null。 */
      const fbThinking = fbTarget?.reasoningLevel ?? 'agent';
      /** ZB-52c：降级目标是否顺序派发 = 目标模型为空（与主通道同一判据）。
       * 此时全局档位不可改 —— 与主通道一致：档位由顺序列表里**逐模型**设置。 */
      const fbSeqMode = fbModel === '';

      /** 降级区模型下拉的**显示文案**（与上面「通道」分区同一纪律；已关闭的当前值标注「已关闭」）。 */
      const fbModelLabel = (m) => {
        const base = modelLabelFor(fbSel?.engine, fbSel?._routeOf, fbSel?._modelOf, m);
        return modelOff(fbSel, m) ? `${base}（${t('modelDisabledTag')}）` : base;
      };

      /** 写降级目标（对象 ⇒ 开启；null ⇒ 关闭）。乐观回显交给 PanelBody 的权威值校正。
       * ⚠️ 面板里**显示什么就写什么**（与上面「通道」分区同一纪律）：
       *   · model: ''（顺序派发）⇒ 写 `null` ⇒ core 按该目标引擎的顺序列表试（无列表则用 provider 默认模型）
       *   · reasoningLevel: 显示值（未设时 `'agent'`）⇒ 原样写。**不保留** CLI/工具设的
       *     `null`（沿用原任务）—— 否则用户只改模型也会把下拉显示的「Agent决定」与实际存值
       *     弄成两回事（显示 Agent决定、实际沿用原任务）。一次面板编辑即归一成面板语义。
       * ZB-52c：base 的 `model` 取**存值里的真实模型名**（`fbTarget.model`），不是下拉的模型项 key
       * （ZCode 的 key 形如 `<路由id>::<模型名>`，把它当模型名写回会毁掉该目标 —— 只改档位时就会踩到；
       * 模型为空 = 顺序派发，所以这里也绝不能凭空写入 key 字符串）。 */
      const saveTarget = (patch) => {
        const next = {
          provider: fbProvider || channel.provider || 'plan',
          model: fbTarget?.model ?? null,
          reasoningLevel: fbThinking || 'agent',
          ...patch,
        };
        setBusy(true);
        Promise.resolve(onFallbackSet(next)).finally(() => setBusy(false));
      };
      const toggleFallback = () => {
        /* 判据与「通道」分区的两个下拉一致：只看 busy 与「有没有通道清单」。
         * 刻意**不**因 offline（conn!=='live'）禁用 —— ext/demo 数据源同样提供 fallback 方法，
         * 真正无源时 channels 为空，这里自然禁用。 */
        if (busy || channels.length === 0) return;
        if (fbEnabled) {
          setBusy(true);
          Promise.resolve(onFallbackSet(null)).finally(() => setBusy(false));
          return;
        }
        /* 开启：默认目标 = 当前默认通道 + 当前通道的模型/档位（与「通道」分区逐字一致：
         * 未选模型 ⇒ ''（通道默认模型）；档位未设 ⇒ 'agent'（Agent决定））。
         * 当前通道不可用时退到第一个可用通道（否则降级一开就是死路）。 */
        const firstEnabled = channels.find((c) => c.enabled);
        const provider = (sel && sel.enabled ? channel.provider : null) ?? firstEnabled?.id ?? channel.provider ?? 'plan';
        saveTarget({
          provider,
          model: provider === channel.provider ? (channel.model ?? null) : null,
          /* 与「通道」分区同一条默认值：未设档位 ⇒ 'agent'（Agent决定），不落 null
           * （null 是 CLI 侧的"沿用原任务"，面板不再产生）。 */
          reasoningLevel: provider === channel.provider ? (channel.reasoningLevel ?? 'agent') : 'agent',
        });
        setFbFeedback(null);
      };
      const fbSwitchProvider = (id) => {
        /* ZB-51：与上面 `switchProvider` **同一套判据** —— 必须经折叠清单解析，
         * 否则折叠条目 id（`opencode`/`qoder`）在原始 channels 里找不到 ⇒ **静默选不中**。 */
        const c = resolveFoldedChannel(fbFolded, id) ?? channels.find((x) => x.id === id);
        if (!c || !c.enabled) return;
        /* 换通道 ⇒ 模型/档位回到「通道默认模型 / Agent决定」（与上面切 provider 的行为同形）。
         * provider 写**折叠条目的 id**（裸引擎名，core 认）；ZCode 的"免费额度"由模型项带回路由。 */
        saveTarget({ provider: c.id, model: null, reasoningLevel: 'agent' });
      };
      const fbSwitchModel = (m) => {
        /* ZCode 的模型项 key 是 `<路由id>::<模型名>` ⇒ provider 与 model 必须一起写。 */
        if (fbSel && fbSel.engine === 'zcode') { const p = routeForPick(fbSel, m); saveTarget({ provider: p.provider, model: p.model }); return; }
        saveTarget({ model: m || null });
      };
      const fbSwitchThinking = (lv) => saveTarget({ reasoningLevel: lv || 'agent' });
      const fbUnknown = fbEnabled && fbProvider && !resolveFoldedChannel(fbFolded, fbProvider);

      /* ── ZB-52d：顺序派发（**没有开关**；主通道与降级目标**各自一块列表、同屏显示**）──
       * 唯一真相 = 该通道的 model 是否为空：主通道模型为空 ⇒ 主块；降级目标模型为空 ⇒ 降级块。
       * ⚠️ 块的构造已**上提为共用件** `buildSeqBlocks()`（ZB-53：浮窗「通道」分区与插件详情页配置卡
       * 共用同一套实现，见上面的注释）。这里只保留"主通道是否顺序派发"这一个派生量 ——
       * 主「思考强度」下拉要用它来决定"禁用 + 显示设置默认"。 */
      const seqEnabled = channel.model == null || channel.model === '';
      const seqBlocks = buildSeqBlocks({
        channels, channel, fallback, sequential, onSet: onSequentialSet,
        /* ZB-56：逐引擎档位探测状态（`channelsInfo.levelsStatus`）⇒ 浮窗的档位下拉同样能显示「载入中」 */
        levelsStatusByEngine: channelsInfo?.levelsStatus ?? null,
        /* ZB-58：逐模型开关 —— 浮窗列表里显示已关闭态并可原地重开；与配置卡同一口径 */
        disabledSet, onToggleModel,
      });

      return h('div', { className: 'dsp-stack' },
        /* ZB-42（用户现场报告）：总开关关闭时**必须在通道分区里明说**。
         * 此前只有标题栏一个小徽标（「派发：关」），而 ZB-33 把闸门提到 runner 最前时
         * 连只读探测也挡住了 ⇒ 用户看到的是「通道清单加载失败」+ 空列表，**误判成插件坏了**。
         * 现在：runner 放行探测（通道照常列出），这里再点明"冻结≠故障"。
         * 复用既有 locale 键 switchOffBlocked（此前只在工具描述里用过，面板从未渲染）⇒ 不新增文案键。 */
        sw && sw.enabled === false
          ? h('div', { className: 'dsp-note', role: 'status', title: t('switchOffBlocked') }, t('switchOffBlocked'))
          : null,
        /* ZB-51：通道清单的 warning **分两类渲染**（真机反馈：把"按白名单剔除 8 条"这种**预期信息**
         * 渲染成红色 `通道清单加载失败: …` ⇒ 用户以为插件坏了）：
         *   · `[info]` 前缀 ⇒ **中性提示**（dsp-note），说明"这是配置决定的，不是故障"；
         *   · 其余 ⇒ 红色（真失败：探测不到、执行器缺失等）。
         * 两类都要显示 —— 只是不能把信息渲染成故障。 */
        (() => {
          if (!warnings.length) return null;
          const info = warnings.filter((w) => String(w).startsWith('[info]'));
          const errs = warnings.filter((w) => !String(w).startsWith('[info]'));
          if (!errs.length) {
            return h('div', { className: 'dsp-note', role: 'status', title: info.join('\n') },
              `${t('chanInfoPrefix')}${info.map((w) => String(w).replace(/^\[info\]\s*/, '')).join('；')}`);
          }
          return h('div', { className: 'dsp-feedback dsp-err' },
            `${t('chanLoadFail')}: ${errs[0]}${errs.length > 1 ? `（+${errs.length - 1}）` : ''}`);
        })(),
        /* 通道清单拉取失败必须**可见**（真机事故：失败被静默丢弃 ⇒ 三个下拉全显示「不可用：-」，
         * 用户以为插件坏了）。这里把 wire 的原始错误显示出来，并说明"会自动重试"。 */
        !warnings.length && chanError
          ? h('div', { className: 'dsp-feedback dsp-err', role: 'status' },
            `${t('chanLoadFail')}: ${chanError}（${t('chanLoadRetry')}）`)
          : null,
        /* 清单为空且没有已知错误：多半是宿主刚启动、首次探测还没回来（或 OpenCode/ZCode 探测都失败）。
         * 明说一句"正在加载"，避免用户把"空"误读成"没有可用通道"。 */
        !warnings.length && !chanError && channels.length === 0
          ? h('div', { className: 'dsp-note', role: 'status' }, t('chanLoading'))
          : null,
        /* ZB-01 ③：离线态的说明统一由面板 body 首行渲染（此处曾重复渲染同一句，已去重）；
         * 两个下拉仍各自带 title，便于悬停即知为什么点不动。
         * ZB-14：改成**固定两行**（每行 = 标签 + 下拉），不再把 4 个元素塞进一个 flex-wrap 行 ——
         * 原先面板一变宽就重排换行、两个下拉宽度还各随内容变（用户报告「随窗口尺寸乱跑」）。
         * 现在：标签 nowrap 定自然宽、下拉 flex:1 等宽撑满 ⇒ 任意面板宽度下版式都一致。 */
        /* ZB-51（T5）：引擎状态条 —— 放在开关/告警之后、两个下拉之前：
         * 用户先看"这台机器上有什么引擎、能不能用"，再看"当前选哪个通道"。 */
        h(EngineStatus, { engineDetail: channelsInfo?.engineDetail }),
        h('div', { className: 'dsp-field' },
          h('span', { className: 'dsp-field-k' }, t('provider')),
          h('select', {
            /* ⚠️ ZB-51：与降级区**同一纪律** —— 下拉 value 用**折叠条目的 id**（`zcode`/`opencode`/`qoder`）。
             * 用原始 `channel.provider`（如 `plan`）会匹配不到 option（选项值已是折叠 id）⇒
             * 浏览器显示首项、当前选择消失（真机/测试都踩到）。 */
            className: 'dsp-select dsp-field-v', value: sel?.id ?? channel.provider,
            onChange: (e) => switchProvider(e.target.value), 'aria-label': t('provider'),
            disabled: channels.length === 0,
            title: offline ? (offlineReason || t('chanOfflineHint')) : undefined,
          },
            groupedChannelOptions(sel?.id ?? channel.provider))),
        h('div', { className: 'dsp-field' },
          h('span', { className: 'dsp-field-k' }, t('model')),
          h('select', {
            className: 'dsp-select dsp-field-v', value: modelValue,
            onChange: (e) => switchModel(e.target.value), 'aria-label': t('model'),
            disabled: !sel || !sel.enabled,
            title: offline ? (offlineReason || t('chanOfflineHint')) : undefined,
          },
            /* ZB-52：首项**无条件**显示「顺序派发」（用户要求：把「Agent决定」改名成「顺序派发」）。
             * 语义：不绑定具体模型（值 `''`）⇒ 派发时按**顺序列表从上到下**尝试，报错换下一个。
             *
             * ⚠️ 开关**关闭时置灰**并说明原因：此时"顺序派发"不会生效（没有列表可跑），
             * 若照常可选会让用户以为开了顺序派发却什么都没发生 —— 那才是静默误导。
             * 置灰 + `（需先开启）` 是**如实告知**怎么让它生效（同 channelOptionNode 的既有范式）。 */
            h('option', { value: '', title: t('seqHintShort') }, t('seqTitle')),
            /* ZB-51：ZCode 的模型项是 `<路由>::<模型名>`（显示成具体模型名，免费额度带「免费」）。 */
            modelOptions.map((m) => h('option', { key: m, value: m }, modelOptionLabel(m))))),
        /* ZB-29d：通道默认思考强度——**这才是给派发 Agent 的规定**：
         * 'Agent决定'=派发方 Agent 按任务自行改传具体档位；具体档位=未显式指定的派发一律按它执行。
         * ⚠️ core 的 `thinkingLevels` 是**数组**（该通道各模型档位集的并集），不是 map ——
         * 曾误当 map 取值（lvMap[model]）导致下拉只剩「Agent决定」（现场 bug，测试已钉住形状契约）。 */
        (() => {
          /* ⚠️ ZB-52（用户要求「思考强度没有按模型过滤好」）：档位集**优先按当前选中的模型**取。
           *
           * 原实现取**该引擎下所有子通道的并集** ⇒ 选了 `deepseek-v4.1-flash-free`（只有 low/high/max）
           * 却把整个引擎的 `medium/xhigh/none/minimal` 全列出来（真机截图：选项里混着别的模型的档位）。
           *
           * 现在：模型项 key → 定位到那条**具体通道** → 用**它自己的** `thinkingLevels`；
           * 定位不到（ZCode 的路由×模型形态、或 core 没探测出逐模型档位）⇒ 退化为引擎并集。
           * ⚠️ 并集是**必需的回退**：ZCode 的两个路由提供相同的模型名、但档位按路由聚合；
           *    以及"探测尚未预热完（首次为空）"的情形 —— 那时宁可多列也不能空着。 */
          const engOfSel = sel ? engineOf(sel.engine) : null;
          const engineUnion = sel
            ? [...new Set([
              ...(Array.isArray(sel.thinkingLevels) ? sel.thinkingLevels : []),
              ...channels.filter((c) => engineOf(c.engine) === engOfSel).flatMap((c) => (Array.isArray(c.thinkingLevels) ? c.thinkingLevels : [])),
            ])]
            : [];
          /* 当前模型项 → 具体通道 id（ZCode 是 `<路由>::<模型>`，其余引擎 key 就是通道 id）。 */
          const routeIdOfModel = modelValue ? (sel?._routeOf?.[modelValue] ?? modelValue) : null;
          const modelCh = routeIdOfModel ? channels.find((c) => c.id === routeIdOfModel) : null;
          const perModel = Array.isArray(modelCh?.thinkingLevels) && modelCh.thinkingLevels.length
            ? [...modelCh.thinkingLevels]
            : null;
          const levels = perModel ?? engineUnion;
          const cur = channel.reasoningLevel ?? 'agent';
          /* ZB-31：**失效档位必须显式列出**。修复探测匹配式后，某些"修复前存下的"档位
           * （如 GLM-5.3 的 `disabled`，旧探测误判为合法）已不在当前 levels 里；若不列出，
           * `<select value="disabled">` 找不到匹配 option ⇒ 浏览器显示首项「Agent决定」，
           * 与真实存值不符（且派发会被 runner fail-fast 拒绝）。故显式补一项并标注「已失效」，
           * 让用户看到真相并主动改选。 */
          const stale = cur !== 'agent' && !levels.includes(cur);
          /* ⚠️ ZB-52（用户要求）：**选中「顺序派发」时档位下拉不可选，显示「设置默认」**。
           * 理由：顺序派发会在**多个模型**间轮换，而档位是**逐模型**的（实测 OpenCode 6/10 个模型
           * 有档位、且集合各不相同）—— 一个全局档位对轮换列表根本说不通。
           * 故顺序派发模式的档位由**顺序面板里逐模型设置**（另一个入口），这里只如实告知"去那里设"。
           * 注意：**不是**禁用整个分区，只是这一项不可改；切回具体模型立即恢复可选。
           * ZB-52c：判据直接用派生量 `seqEnabled`（= 该通道 model 为空 ⇒ 模型下拉选的是「顺序派发」），
           * 不再依赖被删掉的开关变量。 */
          const seqMode = seqEnabled;
          /* ⚠️ `title` 必须**内联**这个三元（既有契约的字面形状，测试钉住）：
           * 失效档位要说明原因（派发会被 runner 拒绝）。
           * 顺序派发模式下的额外说明走 `seqThinkingDefault` 的 option 文案 + hint 行，不挤进这里。 */
          return h('div', { className: 'dsp-field' },
            h('span', { className: 'dsp-field-k' }, t('thinking')),
            h('select', {
              className: 'dsp-select dsp-field-v', value: seqMode ? 'agent' : cur,
              onChange: (e) => onSwitch({ provider: channel.provider, model: channel.model ?? null, reasoningLevel: e.target.value }),
              'aria-label': t('thinking'),
              title: stale ? t('thinkingStaleHint') : t('chanThinkingHint'),
              disabled: seqMode || channels.length === 0 || !sel || !sel.enabled,
            },
              seqMode
                ? h('option', { value: 'agent' }, t('seqThinkingDefault'))
                : h('option', { value: 'agent' }, t('thinkingAgent')),
              seqMode ? null : (stale ? h('option', { value: cur }, `${thinkingLabel(cur)}（${t('thinkingStale')}）`) : null),
              seqMode ? null : levels.map((lv) => h('option', { key: lv, value: lv }, thinkingLabel(lv)))));
        })(),
        /* ── 通道过滤开关（用户要求「面板新增 2 个开关：仅看可用 / 仅看免费」，用于过滤） ──
         * 位置放在三个下拉**之后**：它们只影响上面两个下拉列出什么，不改变当前选择。
         * 两个开关都只做**展示层过滤**（不写 core 状态、不影响调度），所以离线也能用。 */
        h('div', { className: 'dsp-field', 'data-dsp-filter': 'channel' },
          h('span', { className: 'dsp-field-k' }, t('filter')),
          h('span', { className: 'dsp-field-v', style: { display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' } },
            h('button', {
              className: 'dsp-switch dsp-toggle', type: 'button',
              onClick: () => toggleFilt('available'), 'aria-pressed': filtAvailable,
              title: t('filtAvailableHint'),
            },
              h('span', { className: 'dsp-dot', style: { background: filtAvailable ? T.stDone : T.danger } }),
              t('filtAvailable')),
            h('button', {
              className: 'dsp-switch dsp-toggle', type: 'button',
              onClick: () => toggleFilt('free'), 'aria-pressed': filtFree,
              title: t('filtFreeHint'),
            },
              h('span', { className: 'dsp-dot', style: { background: filtFree ? T.stDone : T.danger } }),
              `${t('filtFree')}${freeCount ? `（${freeCount}）` : ''}`))),
        /* 过滤生效时明说「滤掉了几个」—— 否则用户会以为通道清单变少了/坏了。
         * 注意：被"仅看免费"挡下的**当前选择值**仍会补进下拉（否则 select 显示错值），
         * 故这里的计数是"该补的那条恰好被挡下"时才 +1 —— 不虚构、与下拉实际条目一致。 */
        (() => {
          if (!filtAvailable && !filtFree) return null; // 两个都关 = 不过滤，不用提示
          /* ZB-51：计数也要按**折叠后**的清单算（否则会报"隐藏了 25 条"而用户只看到几条）。 */
          const folded = foldChannels(channels);
          const kept = applyChanFilters(folded);
          const cur = resolveFoldedChannel(folded, channel.provider) ?? null;
          const curPinned = !!cur && !kept.some((c) => c.id === cur.id);
          const shown = kept.length + (curPinned ? 1 : 0);
          const hidden = folded.length - shown;
          if (hidden <= 0) return null;
          return h('div', { className: 'dsp-note', role: 'status', title: t('filtHint') },
            `${t('filtHiddenA')}${hidden}${t('filtHiddenB')}${folded.length}${t('filtHiddenC')}`);
        })(),
        h('div', { className: 'dsp-note', role: 'status' },
          /* ZB-51：未指定模型时显示「Agent决定」（与模型下拉首项同一文案）。
           * ZB-52c：模型为空 = 顺序派发（**唯一真相**）⇒ 该位置固定显示「顺序派发」，不再有第三种状态
           * （开关已删除："模型值"与"开关"不会再互相矛盾）。 */
          `${t('chanNewTask')}${channel.provider}/${channel.model || t('seqTitle')} · ${t('thinking')}: ${channel.reasoningLevel === 'agent' || !channel.reasoningLevel ? t('thinkingAgentShort') : thinkingLabel(channel.reasoningLevel)}`),
        /* 引擎专属提示（跟随选中通道动态显示）——OpenCode 通道不支持 mode/memoryBench 等硬边界。 */
        chanEngineNote,
        /* ── ZB-33：免费额度通道的额度条（仅选中该通道时显示） ── */
        giftSel && giftText
          ? h('div', { className: 'dsp-field' },
            h('span', { className: 'dsp-field-k' }, t('giftQuota')),
            h('span', { className: 'dsp-field-v', style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: '0' } },
              giftPct === null
                ? null
                : h('span', {
                  style: { flex: '0 0 64px', height: '6px', borderRadius: '3px', background: T.bgBar, overflow: 'hidden' },
                  role: 'img', 'aria-label': `${t('giftQuota')} ${giftPct}%`,
                },
                  h('span', {
                    style: {
                      display: 'block', height: '100%', width: `${giftPct}%`,
                      background: giftPct <= 15 ? T.danger : T.accent,
                    },
                  })),
              h('span', { className: 'dsp-note', style: { minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis' } }, giftText)))
          : null,
        /* ── ZB-52d/ZB-53：顺序派发列表（**没有开关**；主通道与降级目标**各自一块、同屏显示**） ──
         * 位置刻意放在「自动降级」之前：顺序派发是**同一引擎内**换模型，自动降级是**跨通道**续命，
         * core 的执行次序也是"先顺序、后降级"（顺序列表用尽 ⇒ 交回降级链）。
         * 渲染已抽成**共用件** `SeqBlocksView`（浮窗与插件详情页配置卡同一套 UI，见上面的注释）；
         * 无块时它返回 null ⇒ 这里什么也不渲染（与"关闭不显示"同一纪律）。 */
        h(SeqBlocksView, { blocks: seqBlocks, offline, busy }),
        /* ── ZB-30：自动降级（开关 + 开启后的目标三下拉） ── */
        h('div', { className: 'dsp-field' },
          h('button', {
            className: 'dsp-switch dsp-toggle', type: 'button',
            title: offline ? t('fallbackOfflineHint') : t('fallbackEnableTitle'),
            disabled: busy || channels.length === 0,
            onClick: toggleFallback, 'aria-pressed': fbEnabled,
          },
            h('span', { className: 'dsp-dot', style: { background: fbEnabled ? T.stDone : T.danger } }),
            `${t('fallbackTitle')}：${fbEnabled ? t('fallbackStateOn') : t('fallbackStateOff')}`),
          h('span', { className: 'dsp-spring' }),
          fbEnabled && fbTarget
            ? h('span', { className: 'dsp-badge', title: `${fbProvider}${fbModel ? `/${fbModel}` : ''}` },
              fbModel
                ? `${fbProvider}/${fbModel} · ${fbThinking === 'agent' || !fbThinking ? t('thinkingAgentShort') : thinkingLabel(fbThinking)}`
                : `${fbProvider} · ${t('seqTitle')}`)
            : null),
        /* 关闭时不显示下面的选择项（用户要求：关闭不显示）。
         * ZB-30b：三个下拉与上面「通道」分区**完全一致的选项逻辑** —— 同样的首项
         * （`顺序派发` / `Agent决定（按任务判断）`）、同样的档位并集、同样的禁用判据。
         * ZB-52c：降级目标的「模型」首项也改成「顺序派发」（值 `''`）—— 与主通道**同一个语义**：
         * 模型为空 ⇒ 降到该目标时按**该目标引擎**的顺序列表从上到下试（用户要求"降级也能顺序"）。 */
        fbEnabled ? h('div', { className: 'dsp-stack' },
          h('div', { className: 'dsp-field' },
            h('span', { className: 'dsp-field-k' }, t('provider')),
            h('select', {
              /* ⚠️ ZB-51：下拉 value 用**折叠条目的 id**（`zcode`/`opencode`/`qoder`），
               * 而不是存值里的原始通道 id（`plan`/`opencode/xyz`）——
               * 否则「当前值」在折叠清单里命不中，会被额外固定一条 ⇒ 与上方「通道」分区选项集不一致
               * （真机/测试都踩到：上方有 ZCode、下方却只有 默认套餐）。 */
              className: 'dsp-select dsp-field-v', value: fbValue,
              onChange: (e) => fbSwitchProvider(e.target.value), 'aria-label': `${t('fallbackTitle')}-${t('provider')}`,
              disabled: busy || channels.length === 0,
            },
              groupedChannelOptions(fbValue))),
          h('div', { className: 'dsp-field' },
            h('span', { className: 'dsp-field-k' }, t('model')),
            h('select', {
              className: 'dsp-select dsp-field-v', value: fbModel,
              onChange: (e) => fbSwitchModel(e.target.value), 'aria-label': `${t('fallbackTitle')}-${t('model')}`,
              disabled: busy || !fbSel || !fbSel.enabled,
            },
              h('option', { value: '', title: t('seqHintShort') }, t('seqTitle')),
              fbModelsShown.map((m) => h('option', { key: m, value: m }, fbModelLabel(m))))),
          h('div', { className: 'dsp-field' },
            h('span', { className: 'dsp-field-k' }, t('thinking')),
            h('select', {
              className: 'dsp-select dsp-field-v', value: fbSeqMode ? 'agent' : fbThinking,
              onChange: (e) => fbSwitchThinking(e.target.value), 'aria-label': `${t('fallbackTitle')}-${t('thinking')}`,
              disabled: fbSeqMode || busy || channels.length === 0 || !fbSel || !fbSel.enabled,
            },
              fbSeqMode
                ? h('option', { value: 'agent' }, t('seqThinkingDefault'))
                : h('option', { value: 'agent' }, t('thinkingAgent')),
              /* ZB-31：与「通道」分区同一条纪律 —— 失效档位显式列出（见上面注释）。
               * ZB-52c：降级目标为顺序派发时与主通道一致（显示「设置默认」、不可改）。 */
              fbSeqMode ? null : (fbThinking !== 'agent' && !fbLevels.includes(fbThinking)
                ? h('option', { value: fbThinking }, `${thinkingLabel(fbThinking)}（${t('thinkingStale')}）`)
                : null),
              fbSeqMode ? null : fbLevels.map((lv) => h('option', { key: lv, value: lv }, thinkingLabel(lv))))),
          h('div', { className: 'dsp-note', role: 'status' }, t('fallbackHint')),
        ) : null,
        fbFeedback ? h('div', { className: `dsp-feedback${fbFeedback.kind === 'err' ? ' dsp-err' : ''}`, role: 'status' }, fbFeedback.text) : null,
      );
    }

    /* ZB-29c（用户要求）：**面板手动派发已移除** —— 无需手动派发，有需要让 Agent 通过
     * dispatch 工具代劳（模型/通道/思考强度由 Agent 按工具说明与通道设置决定）。
     * 「通道」分区仍可设置默认思考强度（这就是给派发 Agent 的规定）；进程/用量/单写者分区照旧。 */

    /* ZB-05：tail 输出框的滚动决策（**纯函数**，便于脱离 React 独立测试）。
     *
     * 背景（用户报告）：「输出框里的文本一直闪烁，滚到最下面会自动弹回最上面内容」。
     * 两个成因：
     *   ① 轮询（refreshKey 每秒变）每次都 setTail(null) ⇒ 内容被换成「读取中…」再换回来 = 闪烁；
     *   ② 内容被替换的那一帧，浏览器把 scrollTop 归零 ⇒ 看起来"弹回最上面"。
     *
     * 本函数负责 ②：根据**用户意图**（onScroll 记下的快照）决定内容更新后 scrollTop 该是多少。
     * 关键：意图必须在**内容更新之前**记录 —— 内容一变长，gap 就变大，
     * 事后量 gap 已无法区分"用户本就在底部"与"用户停在中间"。
     *
     * @param {{intent: {top:number, atBottom:boolean}|null, scrollTop:number, scrollHeight:number, clientHeight:number}} s
     * @returns {number|null} 期望的 scrollTop；null = 不干预（保持浏览器默认）
     */
    function nextTailScroll(s) {
      const { intent, scrollHeight, clientHeight } = s;
      if (!intent) return null; // 尚无用户意图（首次渲染）⇒ 不动
      const max = Math.max(0, scrollHeight - clientHeight);
      if (intent.atBottom) return max; // 用户停在底部 ⇒ 贴底跟随新输出
      return Math.min(intent.top, max); // 否则还原到用户自己的位置（内容变短时按上限收敛）
    }

    function JobRow({ job, onKill, onDismiss, onTail, onRetry, onContinue, channels, refreshKey }) {
      const [open, setOpen] = useState(false);
      /* ZB-05：tail 取数。原实现每次轮询（refreshKey 变）都 `setTail(null)`，
       * 于是面板每秒经历「内容 → 读取中… → 内容」的闪烁；且内容被替换的那一帧，
       * 浏览器会把滚动容器 scrollTop 归零 ⇒ 用户看到「滚到底自动弹回最上面」。
       * 现改为：只在**首次取数**时显示「读取中…」，后续刷新静默替换（保内容、保滚动位）。 */
      const tailBoxRef = useRef(null); // 滚动容器（.dsp-mono）
      /* {top, atBottom}：onScroll 时记下的**用户意图**。
       * atBottom 必须在"内容更新之前"判定并留存 —— 内容一变长，gap 就变大，
       * 事后量已经无法区分"用户本就在底部"与"用户停在中间"。 */
      const tailScrollRef = useRef(null);
      const tailLoadedRef = useRef(false); // 是否已成功取过一次（决定要不要显示"读取中"）
      const [tail, setTail] = useState(undefined); // undefined=未取 null=读取中 {...}=结果
      useEffect(() => {
        if (!open) {
          tailLoadedRef.current = false;
          tailScrollRef.current = null;
          setTail(undefined);
          return undefined;
        }
        let alive = true;
        if (!tailLoadedRef.current) setTail(null); // 仅首次显示「读取中…」（轮询不清空 ⇒ 不闪烁）
        Promise.resolve(onTail(job.id, 30)).then((r) => {
          if (!alive) return;
          tailLoadedRef.current = true;
          setTail(r);
        });
        return () => {
          alive = false;
        };
      }, [open, refreshKey]); // 展开/收起与快照刷新时重取（运行中可见进度）
      /* 内容更新后校正滚动位置（标准日志查看器语义）：
       *   · 用户停在底部 → 跟随新输出继续贴底（运行中的 tail 才像"实时日志"）
       *   · 用户滚在中间/顶部 → 精确还原到原位置（不被新内容顶走）
       *   · 尚无用户意图（首次渲染）→ 不动，保持浏览器默认
       * 关键：用 onScroll 记下的 atBottom **意图**判断，而不是当场量 gap ——
       * 内容变长后 gap 必然变大，当场量会把"本在底部"误判成"用户滚在中间"。
       * 放在 useLayoutEffect：commit 后、paint 前执行，用户看不到跳动。 */
      useLayoutEffect(() => {
        const el = tailBoxRef.current;
        if (!el) return;
        const want = nextTailScroll({
          intent: tailScrollRef.current,
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        });
        if (want != null && want !== el.scrollTop) el.scrollTop = want;
      }, [tail]);
      const [handoffOpen, setHandoffOpen] = useState(false); // 换通道交接重跑的选择器
      const [hoProvider, setHoProvider] = useState('');
      const [hoModel, setHoModel] = useState('');
      const [retryFb, setRetryFb] = useState(null);
      /* ZB-04：终态行的「续接」——在同一会话里发一条 NEW 指令（dispatch + resume），
       * 与「重跑」语义不同（后者重发原提示词），故分成两个入口、两个文案。 */
      const [continueOpen, setContinueOpen] = useState(false);
      const [contText, setContText] = useState('');
      const [contFb, setContFb] = useState(null);
      const active = job.state === 'queued' || job.state === 'running';
      const paused = job.state === 'paused';
      const canDismiss = DISMISSABLE_STATES.includes(job.state);
      /* ZB-04：只有**非 paused** 的可关闭状态才给「重跑 / 续接」——paused 行已有
       * 「继续 / 换通道」（继续 == 同会话 --resume，与重跑同义），再放就是重复入口。 */
      const terminal = canDismiss && !paused;
      /* 重跑：同通道 + 有 sessionId → --resume 原提示词；无 sessionId 或无通道 → 交接重跑。
       * 与 paused 行的「继续」同义，故仅在 terminal 行提供。 */
      const doRerun = () => {
        setRetryFb(t('sending'));
        Promise.resolve(onRetry(job.id, {})).then((r) => {
          setRetryFb(r && r.ok ? `${t('fbQueued')}${r.job?.id ?? ''}` : `${t('errPrefix')}${(r && r.error) || 'unknown'}`);
        });
      };
      /* 续接：同会话 + 用户新输入的指令（dispatch + resume）。必须有 sessionId 才有意义。 */
      const doContinue = () => {
        const text = contText.trim();
        if (!text || !job.sessionId) return;
        setContFb(t('sending'));
        Promise.resolve(onContinue(job, text)).then((r) => {
          setContFb(r && r.ok ? `${t('fbQueued')}${r.job?.id ?? ''}` : `${t('errPrefix')}${(r && r.error) || 'unknown'}`);
        });
        setContText('');
      };
      const origProvider = (job.spec && job.spec.provider) || 'plan';
      const enabledChannels = (channels ?? []).filter((c) => c.enabled && c.id !== origProvider);
      const defaultHo = enabledChannels[0]?.id ?? '';
      const effHoProvider = hoProvider || defaultHo;
      const hoSel = (channels ?? []).find((c) => c.id === effHoProvider) ?? null;
      const doResume = () => {
        setRetryFb(t('sending'));
        Promise.resolve(onRetry(job.id, {})).then((r) => {
          setRetryFb(r && r.ok ? `${t('fbQueued')}${r.job?.id ?? ''}` : `${t('errPrefix')}${(r && r.error) || 'unknown'}`);
        });
      };
      const doHandoff = () => {
        setRetryFb(t('sending'));
        Promise.resolve(onRetry(job.id, { provider: effHoProvider, model: hoModel || null })).then((r) => {
          setRetryFb(r && r.ok ? `${t('fbQueued')}${r.job?.id ?? ''}` : `${t('errPrefix')}${(r && r.error) || 'unknown'}`);
        });
        setHandoffOpen(false);
      };
      /* Z11「关闭」：优先 kill；core 的 kill 对 paused 是空操作（子进程已退出、返回 ok 但状态
       * 停在 paused，且返回值里带最新 job），故 ok 但 job.state 仍 paused、或直接失败时，
       * 退回 dismiss（wire 层动作：把 job 从列表移除并落盘，不改 core 语义）。 */
      const doClose = async () => {
        setRetryFb(t('sending'));
        let r = null;
        try {
          r = await Promise.resolve(onKill(job.id));
        } catch { /* wire 已兜底信封，这里只防裸 reject */ }
        if (r && r.ok && (!r.job || r.job.state !== 'paused')) {
          setRetryFb(null); // kill 生效（live→killing/killed、demo→killed），快照随后刷新
          return;
        }
        try {
          const d = await Promise.resolve(onDismiss(job.id));
          setRetryFb(d && d.ok ? null : `${t('errPrefix')}${(d && d.error) || 'unknown'}`);
        } catch (e) {
          setRetryFb(`${t('errPrefix')}${(e && e.message) ?? e}`);
        }
      };
      const spec = job.spec ?? {};
      const kindField = spec.kind === 'task' ? 'task' : spec.kind === 'target' ? 'target' : 'prompt';
      const KIND_KEY = { prompt: 'kindPrompt', task: 'kindTask', target: 'kindTarget' };
      const detailBody = spec.body ?? spec[kindField]; // live=slimJob 的 body；demo=body+kind 同名字段
      const kvRow = (k, v) => (v == null || v === '' ? null : h('div', { className: 'dsp-kv' },
        h('span', { className: 'dsp-kv-k' }, k), h('span', { className: 'dsp-kv-v' }, String(v))));
      return h('div', { className: 'dsp-job' },
        /* ZB-12：行头只做「摘要」，不放任何按钮、也没有倒三角 ——
         * 整行点击即展开/收起详情（用户要求）。因为行头现在是唯一的开关，补 role/aria-expanded。 */
        h('div', {
          className: 'dsp-job-head', role: 'button', 'aria-expanded': open,
          onClick: (e) => {
            /* Z9 守卫的修正（2026-09-30 现场报告「点击没展开」）：
             * 行头自身带 role="button"（可访问性需要），若沿用原来的
             * `isInteractive(e.target)`，点行头内任意位置都会 closest 命中「行头自己」
             * ⇒ 永远被当成交互元素、永远 return、永远不切换。
             * 正确语义：命中的是**行头之外的控件**才跳过；命中行头自身（含其非交互子元素）则切换。 */
            const hit = e.target && typeof e.target.closest === 'function'
              ? e.target.closest('button,input,select,textarea,a,[role="button"]')
              : null;
            if (hit && hit !== e.currentTarget) return;
            setOpen(!open);
          },
        },
          /* ZB-70（用户要求）：行头改**三行布局** ——
           *   行1 = 状态灯 + 进程名（左）…… 时间 + 退出（**右对齐**，由 .dsp-job-right 承载）；
           *   行2 = 引擎 + 模型 + 思考强度 + 权限 + 文件锁（**全部左对齐**；paused/血缘徽标随后）；
           *   行3 = 心跳（运行中）/ 上下文（其它）—— 左对齐。
           * 为什么这样分：扫第一行回答"谁、跑了多久、成没成"，扫第二行回答"哪个引擎/模型、受什么限制"，
           * 只有第三行才是逐秒变化的心跳 —— 心跳单独成行后不再把静态徽标挤到右侧。 */
          h('div', { className: 'dsp-job-line' },
            h(StatusDot, { state: job.state }),
            h('span', { className: 'dsp-job-tag', title: job.id }, job.tag ?? shortId(job.id)),
            h('span', { className: 'dsp-job-right' },
              h('span', { className: 'dsp-dim' }, fmtSec(job.elapsedSec)),
              job.exitCode != null ? h('span', { className: 'dsp-dim' }, `${t('exit')} ${job.exitCode}`) : null,
            ),
          ),
          h('div', { className: 'dsp-job-line dsp-job-line2' },
            /* 引擎徽标（一眼看出这个进程是哪个引擎跑的）。
             * 判据顺序与 core 一致：job.engine（core 落库）→ spec.engine → provider 形态 → 默认 zcode。
             * 旧记录（改造前落盘的 job 没有这些字段）显示为 ZCode —— 与事实相符，不伪造成新形态。
             *
             * ⚠️ ZB-51 真机 bug（用户截图发现）：这里原来是**二元**判断
             * `job.engine === 'opencode' || …` ⇒ **Qoder job 被显示成 ZCode 徽标**
             * （第三引擎一来就归错组 —— 与通道分组那次是同一类错误）。改用统一归一函数。 */
            (() => {
              const e = jobEngineOf(job);
              return h('span', { className: 'dsp-badge', title: `${t('engBadge')}：${engLabel(e)}` }, engLabel(e));
            })(),
            h('span', { className: 'dsp-badge' }, job.model ?? '—'),
            /* ZB-29：思考强度徽标紧跟模型——显示**实际生效档位**（含 Agent决定档的解析结果）；
             * 无法确定（旧 runner / --resume / 模型未声明）时隐藏，不伪造。 */
            (() => {
              const shown = thinkingShown(job);
              return shown ? h('span', {
                className: 'dsp-badge', title: `${t('thinking')}：${thinkingLabel(shown)}（${shown}）`,
              }, thinkingLabel(shown)) : null;
            })(),
            /* 权限放行必须**可见**（可审计）：auto 默认关，只有显式指定才有；有就必须在进程行上看得到。 */
            (job.autoApproved || (job.spec && job.spec.auto)) ? h('span', { className: 'dsp-badge', title: t('autoApprovedHint') }, t('autoApproved')) : null,
            /* ZB-18：锁徽标区分「整仓库锁」/「文件锁 N」/「不取锁」；tooltip 给出细节与文件列表。
             * 旧版本记录（含 memory）如实显示为旧形态，不伪装成新模型。 */
            (() => {
              const lk = lockKindOf(job);
              if (lk.kind === 'none') return null;
              return h('span', {
                className: `dsp-badge dsp-lock-${lk.kind}`,
                title: lk.detail || t('lockHeld'),
              }, lk.label);
            })(),
            /* 以下三个是「状态/血缘」补充徽标（用户指定的五项之后）—— 仍然左对齐、同一行。
             * paused 不放进第一行右侧：右侧固定给「时间 + 退出」（ZB-70 的布局约定）。 */
            paused ? h('span', { className: 'dsp-badge s-paused', title: job.pauseDetail ?? '' }, `${t('paused')}：${pauseLabel(job.pauseReason)}`) : null,
            job.parentJobId ? h('span', { className: 'dsp-badge', title: job.parentJobId }, `${t('parentFrom')} ${shortId(job.parentJobId)}`) : null,
            (job.hopCount ?? 0) > 0 ? h('span', { className: 'dsp-badge' }, `${job.hopCount} ${t('hop')}`) : null,
          ),
          h('div', { className: 'dsp-job-line dsp-job-line3' },
            h('span', { className: 'dsp-dim', title: `${job.contextUsed ?? '—'} / ${job.contextWindow ?? '—'} tokens` }, ctxLabel(job)),
            /* ZB-40（用户要求「能看出进程确实在工作还是可能卡住」）：运行中显示**当前阶段/最近工具/心跳**，
             * 超过 150s 无心跳 → 红色「可能卡住」徽标。数据来自 runner 每 10s 的 progress 心跳行。
             * ZB-70：整块从"行头第三行（独立 div）"改挂到 `.dsp-job-line3` 里（左对齐、与上下文同一行）。 */
            job.state === 'running' && (job.progress || job.stalled)
              ? h('span', { className: 'dsp-dim', style: job.stalled ? { color: T.danger } : undefined },
                `${t('jobCurrent')}${job.progress
                  ? `${job.progress.stage ?? '?'}` +
                    `${job.progress.lastTool ? ` · ${job.progress.lastTool}` : ''}` +
                    `${Number.isFinite(job.progress.chars) && job.progress.chars > 0 ? ` · ${job.progress.chars} 字` : ''}` +
                    `${Number.isFinite(job.progress.tools) && job.progress.tools > 0 ? ` · 工具 ${job.progress.tools} 次` : ''}`
                  : '—（尚无心跳）'}`)
              : null,
            job.state === 'running' && job.stalled
              ? h('span', { className: 'dsp-badge', title: t('jobStalledHint'), style: { color: T.danger } }, t('jobStalled'))
              : null,
            job.state === 'running' && (job.progress || job.stalled) && !job.stalled
              ? h('span', { className: 'dsp-dim' }, `｜ ${t('jobLastBeat')} ${job.lastProgressAgoSec ?? '?'}s`)
              : null,
          ),
        ),
        /* 反馈行移到动作区之外：关闭按钮现在在行头，终态行没有动作区，失败反馈仍需可见。 */
        retryFb ? h('div', { className: 'dsp-note', role: 'status' }, retryFb) : null,
        /* ZB-12：全部行动作都收进这里，且**只在展开时可见** —— 行头保持纯摘要、整行点击即开关。
         * 终止(✕) 与 关闭(✕) 共用同一字形，但 active（queued/running）与 canDismiss（paused/终态）
         * 状态互斥，永不同时出现；语义由各自的 title/aria-label 区分。 */
        open && (active || terminal || canDismiss) ? h('div', { className: 'dsp-row' },
          active ? h('button', { className: 'dsp-iconbtn', title: t('kill'), 'aria-label': `${t('kill')} ${job.id}`, onClick: () => onKill(job.id) }, h(IconKill)) : null,
          /* 重跑（↻）：同会话重发原提示词。仅非 paused 的终态行（paused 行有同义的「继续」）。 */
          terminal ? h('button', { className: 'dsp-iconbtn', title: t('rerunTitle'), 'aria-label': `${t('rerun')} ${job.id}`, onClick: doRerun }, h(IconRerun)) : null,
          /* 续接：同会话发新指令。无 sessionId 时禁用（并说明原因，不静默消失）。 */
          terminal ? h('button', {
            className: 'dsp-iconbtn', title: job.sessionId ? t('continueTitle') : t('continueNoSession'),
            'aria-label': `${t('continueBtn')} ${job.id}`, disabled: !job.sessionId,
            onClick: () => setContinueOpen(!continueOpen), 'aria-expanded': continueOpen,
          }, h(IconContinue)) : null,
          /* 关闭：从列表移除（paused 也走这里；paused 的「继续/换通道」见下一行） */
          canDismiss ? h('button', { className: 'dsp-iconbtn', title: t('closeJob'), 'aria-label': `${t('closeJob')} ${job.id}`, onClick: doClose }, h(IconKill)) : null,
        ) : null,
        /* 续接输入行（点上面「续接」图标展开）——在同一会话里发一条新指令。 */
        open && terminal && continueOpen ? h('div', { className: 'dsp-row' },
          h('input', {
            className: 'dsp-input', type: 'text', value: contText, placeholder: t('continuePh'),
            style: { flex: 1, minWidth: 120 }, 'aria-label': t('continueBtn'),
            onChange: (e) => setContText(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') doContinue(); },
          }),
          h('button', { className: 'dsp-btn2', onClick: doContinue, disabled: !contText.trim() }, t('continueSend')),
          contFb ? h('span', { className: 'dsp-note', role: 'status' }, contFb) : null,
        ) : null,
        /* ZB-12：paused 专属动作（继续/换通道）同样只在展开时可见，与上面的动作区同处一块。 */
        open && paused ? h('div', { className: 'dsp-row' },
          h('button', {
            className: 'dsp-btn2', onClick: doResume,
            disabled: !job.sessionId,
            title: job.sessionId ? `${t('resumeSame')}（--resume）` : t('noSession'),
          }, t('resumeSame')),
          h('button', { className: 'dsp-btn2', onClick: () => setHandoffOpen(!handoffOpen), 'aria-expanded': handoffOpen }, t('retryHandoff')),
        ) : null,
        open && paused && handoffOpen ? h('div', { className: 'dsp-row' },
          h('select', {
            className: 'dsp-select', value: effHoProvider,
            onChange: (e) => { setHoProvider(e.target.value); setHoModel(''); }, 'aria-label': t('provider'),
          },
            (channels ?? []).filter((c) => c.enabled && c.id !== origProvider).map((c) => h('option', { key: c.id, value: c.id }, `${c.name ?? c.id}`))),
          h('select', {
            className: 'dsp-select', value: hoModel, onChange: (e) => setHoModel(e.target.value), 'aria-label': t('model'),
          },
            h('option', { value: '' }, t('chanDefaultModel')),
            (hoSel?.models ?? []).map((m) => h('option', { key: m, value: m }, m))),
          h('button', { className: 'dsp-btn', onClick: doHandoff, disabled: !effHoProvider }, t('confirmHandoff')),
          h('button', { className: 'dsp-btn2', onClick: () => setHandoffOpen(false) }, t('cancel')),
          h('span', { className: 'dsp-note', role: 'note' }, t('handoffConfirm')),
        ) : null,
        open ? h('div', { className: 'dsp-tailwrap' },
          // Z11：派发要素详情——点行可区分「这个进程派发了什么」
          h('div', { className: 'dsp-detail' },
            kvRow(t('kind'), t(KIND_KEY[spec.kind] ?? 'kind')),
            detailBody != null && detailBody !== '' ? h('div', { className: 'dsp-mono' }, clampText(detailBody, 1200)) : null,
            kvRow(t('provider'), spec.provider ?? job.provider),
            kvRow(t('model'), spec.model ?? job.model),
            /* ZB-29：思考强度紧跟「模型」——显示**实际生效档位**（确定不了时隐藏；档位走中文标签）。 */
            thinkingShown(job) ? kvRow(t('thinking'), `${thinkingLabel(thinkingShown(job))}（${thinkingShown(job)}）`) : null,
            kvRow(t('mode'), spec.mode),
            kvRow(t('cwd'), spec.cwd),
            spec.timeoutMin != null ? kvRow(t('timeout'), String(spec.timeoutMin)) : null,
            kvRow(t('createdAt'), job.queuedAt ? fmtTime(job.queuedAt) : null),
            kvRow(t('sessionId'), job.sessionId),
            /* ZB-28：排队可观测 —— queued 行展开即见「被谁挡住/前方几个/预计等待」。 */
            job.state === 'queued' && job.lockWait ? kvRow(t('lockWait'), lockWaitText(job.lockWait)) : null,
            /* ZB-28：超时终态可见 —— runner 自身超时（failed, exit 124）与看门狗强杀（killed）分得清。 */
            job.timedOut ? kvRow(t('timedOut'), job.timedOutBy === 'watchdog' ? t('timedOutWatchdog') : t('timedOutRunner')) : null,
            job.pauseReason ? kvRow(t('paused'), pauseLabel(job.pauseReason)) : null,
          ),
          h('div', { className: 'dsp-note', style: { marginTop: 6 } }, t('tail')),
          h('div', {
            className: 'dsp-mono',
            ref: tailBoxRef, // ZB-05：内容轮询刷新后据此校正滚动位置
            onScroll: (e) => {
              const el = e.currentTarget;
              tailScrollRef.current = {
                top: el.scrollTop,
                // 意图判定必须在内容更新前完成（内容一变长 gap 就失真）
                atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 4,
              };
            },
          },
            tail === null ? t('tailLoading')
              : tail === undefined ? t('tailEmpty')
                : tail && tail.ok ? (tail.lines && tail.lines.length ? tail.lines.join('\n') : t('tailEmpty'))
                  : `${t('errPrefix')}${tail && tail.error ? tail.error : 'unknown'}`)) : null,
      );
    }

    /* ─────────────── ZB-03：进程分组（用户要求「进行中 / 已完成 / 异常」分类显示）───────────────
     * ⚠️ 分组表**已上移**到 `JOB_STATE_META` 旁边（单一源，由 `group` 列派生）——这里不再有第二份字面量。
     * 两条纪律（保持）：
     *  1) 空分组不渲染 —— 所以分组可以取细，不会占版面；
     *  2) **未归属状态兜底**（grpOther）—— 绝不能因为「新状态没进分组表」就让 job 在列表里凭空消失。 */

    function JobList({ snapshot, onKill, onDismiss, onTail, onRetry, onContinue, channels, refreshKey, offline }) {
      /* ZB-07：分组内展开状态（按分组 key）。会话内记忆即可 —— 刷新后回到「只看最近 N 条」，
       * 这个默认方向是安全的（永远只会少显示，不会漏掉最新）。 */
      const [expandedGroups, setExpandedGroups] = useState({});
      /* ZB-09：Tab 分页。userTab=null 表示「跟随第一个非空分组」—— 面板刚挂载时快照还没到，
       * 无法在初始化时定 tab，故用 null 表示未选择，每次渲染按当前数据推导；
       * 用户点过某个 tab 后就固定用它（即使那个 tab 为空，也如实显示空态，不偷偷跳走）。 */
      const [userTab, setUserTab] = useState(null);
      /* ZB-70（用户要求）：页脚「清除所有」的进行态与结果（null | {busy:true,n} | {busy:false,ok:n,err}）。 */
      const [clearFb, setClearFb] = useState(null);
      const jobs = snapshot?.jobs ?? [];
      if (jobs.length === 0) return h('div', { className: 'dsp-empty' }, offline ? t('emptyOffline') : t('noJobs'));
      const claimed = new Set();
      for (const g of JOB_GROUPS) for (const s of g.states) claimed.add(s);
      /* 分类 tab 固定 4 个（计数可为 0）—— tab 集合稳定，不会随状态变化忽隐忽现；
       * 兜底分组 grpOther 只在真的有未归属状态时才作为第 5 个 tab 出现。 */
      const tabs = JOB_GROUPS.map((g) => ({ key: g.key, items: jobs.filter((j) => g.states.includes(j.state)) }));
      const rest = jobs.filter((j) => !claimed.has(j.state));
      if (rest.length) tabs.push({ key: 'grpOther', items: rest }); // 兜底：绝不吞掉未知状态的行
      const firstNonEmpty = (tabs.find((g) => g.items.length > 0) ?? tabs[0]).key;
      const activeKey = userTab ?? firstNonEmpty;
      const active = tabs.find((g) => g.key === activeKey) ?? tabs[0];

      /* ZB-70：本页签里**可清除**的进程。
       * 宿主只允许 paused/终态被 dismiss（queued/running 会被可读拒绝），所以这里先用单一源
       * `DISMISSABLE_STATES` 过滤 —— 与「关闭」按钮用的是同一份状态表，不另写一份。 */
      const clearable = active.items.filter((j) => DISMISSABLE_STATES.includes(j.state));
      /** 清除本页签：**顺序**逐个 dismiss（宿主每清一条就重写 dismissed.json，并发写会互相覆盖）。 */
      const clearAll = async () => {
        if (clearFb && clearFb.busy) return;
        if (clearable.length === 0) return;
        setClearFb({ busy: true, n: clearable.length });
        let okN = 0;
        let err = null;
        for (const j of clearable) {
          try {
            const r = await Promise.resolve(onDismiss(j.id));
            if (r && r.ok) okN += 1;
            else if (r && r.error) err = r.error;
          } catch (e) { err = (e && e.message) ?? e; }
        }
        setClearFb({ busy: false, ok: okN, err });
      };

      /* 组内**最新在上**：进程上限 1000 条，若不截断面板会变成几百行长列表。
       * 截断只隐藏「更早的」，最新的永远可见；展开按钮写明还有多少条，不静默吞行。 */
      const newestFirst = [...active.items].sort((a, b) => String(b.queuedAt ?? '').localeCompare(String(a.queuedAt ?? '')));
      const open = !!expandedGroups[active.key];
      const shown = open ? newestFirst : newestFirst.slice(0, JOB_GROUP_PREVIEW);
      const hidden = newestFirst.length - shown.length;

      return h('div', { className: 'dsp-jobs' },
        h('div', { className: 'dsp-tabs', role: 'tablist' },
          tabs.map((g) => h('button', {
            key: g.key, role: 'tab', 'aria-selected': g.key === activeKey,
            className: 'dsp-tab' + (g.key === activeKey ? ' dsp-tab-on' : ''),
            onClick: () => { setUserTab(g.key); setClearFb(null); },
          },
            h('span', null, t(g.key)),
            h('span', { className: 'dsp-tab-n' }, String(g.items.length))))),
        newestFirst.length === 0
          ? h('div', { className: 'dsp-empty' }, offline ? t('emptyOffline') : t('noJobs'))
          : h('div', { className: 'dsp-group-body' },
            shown.map((j) => h(JobRow, { key: j.id, job: j, onKill, onDismiss, onTail, onRetry, onContinue, channels, refreshKey })),
            /* ZB-70（用户要求）：页脚 —— 左「还有 N 条更早 / 收起」，右「清除所有」。
             * 只有**非「进行中」**页签才出现（进行中的 job 宿主一律拒绝清除，给按钮等于骗人）。
             * 清除后不必手动刷新：面板 1s 轮询，snapshot 已按 dismissed 过滤（wire.host.mjs 的快照路径）。 */
            h('div', { className: 'dsp-jobs-foot' },
              h('div', { className: 'dsp-jobs-foot-l' },
                hidden > 0
                  ? h('button', {
                    className: 'dsp-btn2',
                    onClick: () => setExpandedGroups((p) => ({ ...p, [active.key]: true })),
                  }, `${t('jobMore')} ${hidden} ${t('jobMoreN')}`)
                  : null,
                open && newestFirst.length > JOB_GROUP_PREVIEW
                  ? h('button', {
                    className: 'dsp-btn2',
                    onClick: () => setExpandedGroups((p) => ({ ...p, [active.key]: false })),
                  }, t('jobCollapse'))
                  : null,
                clearFb && !clearFb.busy
                  ? h('span', { className: 'dsp-note', role: 'status' },
                    clearFb.err
                      ? `${t('errPrefix')}${clearFb.err}`
                      : `${t('jobCleared')} ${clearFb.ok} ${t('jobClearN')}`)
                  : null),
              activeKey !== 'grpActive' && clearable.length > 0
                ? h('button', {
                  className: 'dsp-btn2 dsp-clear',
                  title: t('jobClearHint'),
                  'aria-label': `${t('jobClearAll')} ${clearable.length}`,
                  disabled: !!(clearFb && clearFb.busy),
                  onClick: clearAll,
                }, clearFb && clearFb.busy ? `${t('jobClearing')} ${clearable.length}` : t('jobClearAll'))
                : null)));
    }

    function QuotaCards({ quota, planQuota }) {
      const w = quota && quota.windows ? quota.windows : null;
      const kv = (k, v) => h('div', { className: 'dsp-kv' }, h('span', { className: 'dsp-kv-k' }, k), h('span', null, v));
      const card = (title, x) => h('div', { className: 'dsp-card' },
        h('div', { className: 'dsp-card-title' }, title),
        kv(t('runs'), x ? String(x.runs) : '—'),
        kv(t('requests'), x ? String(x.requests) : '—'),
        kv(t('inTok'), x ? fmtTokens(x.inputTokens) : '—'),
        kv(t('outTok'), x ? fmtTokens(x.outputTokens) : '—'),
        kv(t('cacheTok'), x ? fmtTokens(x.cacheReadTokens) : '—'));
      // 引擎本周已用（plan-quota 数据接线）：仅在数据源给出可用 week.used 时显示
      const wk = planQuota && planQuota.available && Array.isArray(planQuota.windows)
        ? planQuota.windows.find((x) => x && x.id === 'week')
        : null;
      return h('div', { className: 'dsp-stack' },
        h('div', { className: 'dsp-planline' }, t('localNote')),
        h('div', { className: 'dsp-cards' },
          card(t('usage5h'), w && w.last5h),
          card(t('usageWeek'), w && w.week),
          card(t('usageToday'), w && w.today)),
        wk && wk.used != null ? h('div', { className: 'dsp-planline' }, `${t('engineWeekUsed')}：${fmtTokens(wk.used)} tok`) : null,
        h('div', { className: 'dsp-planline' }, t('planQuotaPending')));
    }

    function LockStatus({ snapshot }) {
      const holderOf = (rec) => {
        if (!rec) return t('idle');
        const j = (snapshot?.jobs ?? []).find((x) => x.id === rec.jobId);
        return (j && j.tag) ?? shortId(rec.jobId);
      };
      /* ZB-08：用户要求「显示被单写锁的文件和对应的进程」——
       * 文件锁表来自 core 的 listFileLocks()（细粒度）；粗粒度 repo/memory 与队列长度仍保留，
       * 因为大量任务没声明 write，走的正是粗粒度锁，不能从面板上消失。 */
      const fileLocks = (snapshot && Array.isArray(snapshot.fileLocks)) ? snapshot.fileLocks : [];
      return h('div', { className: 'dsp-locks' },
        h('div', { className: 'dsp-row' },
          /* ZB-16：repo 锁显示为「仓库锁」；memory 锁已按用户要求删除，故不再有那一格。
           * 用户要求"显示被锁的文件和对应的进程"由下面的 fileLocks 列表承担。 */
          h('span', { className: 'dsp-label' }, t('repoLock')),
          h('span', { className: 'dsp-badge' }, holderOf(snapshot && snapshot.locks && snapshot.locks.repo)),
          h('span', { className: 'dsp-label' }, t('queueLen')),
          h('span', { className: 'dsp-badge' }, String((snapshot && snapshot.queue ? snapshot.queue.length : 0))),
        ),
        fileLocks.length === 0
          ? h('div', { className: 'dsp-note' }, t('noFileLocks'))
          : h('div', { className: 'dsp-filelocks' },
            fileLocks.map((lk) => h('div', { key: `${lk.jobId}:${lk.file}`, className: 'dsp-filelock' },
              h('span', { className: 'dsp-filelock-f', title: lk.file }, clampText(lk.file.replace(/^.*[\\/]/, ''), 40)),
              h('span', { className: 'dsp-filelock-who' }, lk.tag ?? shortId(lk.jobId)),
              h('span', { className: 'dsp-dim' }, fmtSec(lk.heldSec))))),
      );
    }

    /* ─────────────── ZB-27：会话标题行入口（点开即弹窗）───────────────
     * 与 DSH 自带的「N 个子智能体 / 智能体团队 / 创造模式 / 后台任务」同槽位、同形态：
     * 一枚**无边框文字按钮**（12px / label-tertiary / min-height 28px / gap 3px，取自
     * dsh-client-ui-jobs 的 job-list 触发样式）+ 一个挂在它下方的**悬浮弹窗**。
     *
     * 三条约束（都是有意的）：
     *   ① 入口自身**不建 wire**（不为一个入口多一条 1s 轮询）：弹窗打开时里面的 PanelBody
     *      才建 wire 并显示实时数据；
     *   ② 关闭方式与系统一致：点外部 / Esc / 再点入口；弹窗贴右对齐（本入口在标题行右端）；
     *   ③ 主题令牌只用 T.*（带 --dsw-alias-* 回退）—— 这枚入口不在 .dsp-menu 子树内，
     *      拿不到 --dsp-* 自定义属性。 */
    /** 主入口（会话标题行）：语义/行为完全不变，仅把实现体抽到共享的 `EntryImpl`（同一套开合与样式逻辑）。
     *  ⚠️ 保持 `function HeaderEntry()` 这个**字面形状** —— header-entry.test D1 用 `indexOf` 定位入口实现体。 */
    function HeaderEntry() { return h(EntryImpl, { variant: 'header' }); }
    /** ZB-60 备用入口（右下角浮层）：**仅当**会话头槽位不可用时才注册（降级链见 apply）。
     *  与主入口**互斥**（同一时刻只会注册一个），绝不是"两份 UI"。 */
    function HeaderOverlayEntry() { return h(EntryImpl, { variant: 'overlay' }); }
    /** 入口实现体：`variant` 决定是会话头入口还是右下角浮层入口（样式与悬浮语义按 variant 分支）。 */
    function EntryImpl({ variant = 'header' }) {
      /* ZB-60：`variant` 只有两种取值，**不是两个入口实例**：
       *   · 'header'  —— 主路径：会话标题行入口（默认，行为与既有完全一致）；
       *   · 'overlay' —— 仅当主槽位不可用时的**降级备份**：右下角浮层入口（CSS `.dsp-entry-float`）。
       * 两者**互斥**（同一时刻只会注册一个），绝不会同时出现两份 UI。 */
      const isFloat = variant === 'overlay';
      const [open, setOpen] = useState(false);
      /* ZB-27i：悬停/聚焦态用 React 状态表达（颜色改走内联兜底，见下面的 style）。 */
      const [hover, setHover] = useState(false);
      const rootRef = useRef(null);
      /* ZB-27m（用户现场：红箭头指着"智能体团队"——被悬浮的入口字变亮且弹窗展开）：
       * 官方入口语义是「**悬浮**即高亮 + **悬浮**即展开」，而我上一版把「弹窗开着」也算成高亮条件
       * （`open || hover`）—— 指针一移进面板，我的字还亮着，而旁边没有这个状态（用户：失焦后就变了）。
       * 现按 **ui-subagent/CatalogDropdown 源码**逐字对齐时序：
       *   scheduleHoverOpen()  ：取消两个定时器 → 150ms 后展开
       *   scheduleHoverClose() ：取消两个定时器 → 120ms 后收起
       * 两个延时是为了"从入口移进弹窗"途中穿过那 5px 缝隙时**不闪**（官方源码即如此）。
       * 高亮条件同时收窄为**仅 hover**（官方 .trigger:hover/:focus-visible 才变色）。 */
      const openTimer = useRef(null);
      const closeTimer = useRef(null);
      const clearTimers = () => {
        if (openTimer.current != null) { clearTimeout(openTimer.current); openTimer.current = null; }
        if (closeTimer.current != null) { clearTimeout(closeTimer.current); closeTimer.current = null; }
      };
      const scheduleOpen = () => {
        /* ZB-60：浮层入口（variant='overlay'）**不做悬浮展开** —— 鼠标路过右下角就弹面板很扰民；
         * 它只响应点击（打开）/ 点外部 / Esc / 窗口失焦（关闭）。主路径行为完全不变。 */
        if (isFloat) return;
        clearTimers();
        if (open) return;
        openTimer.current = setTimeout(() => { openTimer.current = null; setOpen(true); }, 150);
      };
      const scheduleClose = () => {
        if (isFloat) return; // 浮层入口没有"悬浮展开"，也就没有"离开即关"（关闭走点击外部/Esc/失焦）
        clearTimers();
        closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false); setHover(false); }, 120);
      };
      const closeNow = () => { clearTimers(); setOpen(false); setHover(false); };
      /* ZB-27u：常驻入口自己也持有一份样式引用 —— 只要入口还在，样式表就不会被任何
       * 按需挂载组件的卸载清理带走（这是"面板关闭后入口掉样式"那个 bug 的根治点）。 */
      useEffect(() => {
        const release = ensureStyle();
        return () => { try { release(); } catch { /* ignore */ } };
      }, []);

      /* 卸载时清掉挂起的定时器（否则会话切走后回调仍会 setState）。 */
      useEffect(() => clearTimers, []);
      useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
          const el = rootRef.current;
          if (el && e && e.target && el.contains(e.target)) return;
          closeNow();
        };
        const onKey = (e) => { if (e && (e.key === 'Escape' || e.key === 'Esc')) closeNow(); };
        /* 失焦关闭（③）：整个窗口失焦时收起，避免"以为关了其实还挂着"。 */
        const onWinBlur = () => { closeNow(); };
        try { document.addEventListener('pointerdown', onDown, true); } catch { /* 无 document（测试桩） */ }
        try { document.addEventListener('keydown', onKey, true); } catch { /* 同上 */ }
        try { window.addEventListener('blur', onWinBlur); } catch { /* 同上 */ }
        return () => {
          try { document.removeEventListener('pointerdown', onDown, true); } catch { /* 同上 */ }
          try { document.removeEventListener('keydown', onKey, true); } catch { /* 同上 */ }
          try { window.removeEventListener('blur', onWinBlur); } catch { /* 同上 */ }
        };
      }, [open]);

      /* ZB-27w（用户要求）：入口要显示"有没有任务/有没有进行中的任务"。
       * 数据来自**共享 wire**（模块级单例 + 引用计数）⇒ 不会因入口而多出轮询：
       * 入口与面板共用同一条；最后一个使用者卸载时才 dispose。 */
      const { snapshot } = useWire();
      const counts = (snapshot && snapshot.counts) || {};
      const runningCount = Number(counts.running) || 0;
      const queuedCount = Number(counts.queued) || 0;
      /* ZB-27x：弹窗左对齐后若靠近视口右缘，用 menuShift（marginLeft 负值）把它拉回视口内 ——
       * 与官方 JobListAction 的 `style={{ left: menuShift }}` 同一意图（也照抄其"打开时测一次"的做法）。 */
      const [menuShift, setMenuShift] = useState(0);
      useEffect(() => {
        if (!open) return;
        /* 浮层入口的弹窗由 CSS **右对齐、向上展开**（`.dsp-entry-float .dsp-menu`），
         * 不做标题行那种"靠近右缘就往左挪"的测量（否则 marginLeft 在 right:0 下会反着推）。 */
        if (isFloat) return;
        try {
          const el = rootRef.current;
          if (!el || typeof el.getBoundingClientRect !== 'function' || typeof window === 'undefined') return;
          const r = el.getBoundingClientRect();
          const over = (r.left + WIDTH.def + 16) - (window.innerWidth || 0);
          setMenuShift(over > 0 ? -Math.ceil(over) : 0);
        } catch { /* 测量失败则不动（CSS 的 max-width 仍会收敛） */ }
      }, [open, isFloat]);

      /* ZB-27l：**悬浮展开 / 离开即关**的挂点放在外层容器上 ——
       * 弹窗是容器的子节点，所以"从入口移进弹窗"不会触发 mouseleave（指针仍在子树内）；
       * 只有真正离开「入口 + 弹窗」整体才关。焦点同理（onBlur 的 relatedTarget 仍在子树内则忽略）。 */
      return h('div', {
        className: 'dsp-entry' + (isFloat ? ' dsp-entry-float' : ''),
        'data-dsp-entry': variant,
        ref: rootRef,
        /* ZB-27n：容器**只管开合、不设 hover** —— 面板是容器的子节点，指针从外面移到**面板**上时
         * 容器的 onMouseEnter 同样会触发；若在这里 setHover(true)，指针明明在面板上、入口的字却亮了
         * （用户截图 1 的现象）。hover 只由按钮自身的 enter/leave 驱动，才等价于官方 .trigger:hover。
         * ZB-60：浮层入口的"不悬浮展开"由 scheduleOpen/scheduleClose 内部的 isFloat 守卫实现
         * （保持这段字面形状不变：header-entry.test 的 B32b/C8b 钉住它）。 */
        onMouseEnter: scheduleOpen,
        onMouseLeave: () => { setHover(false); scheduleClose(); },
        onFocus: scheduleOpen,
        onBlur: (e) => {
          /* 优先用事件的 currentTarget（真实 DOM 里就是外层容器），没有则退回 ref ——
           * 两种来源都能做"焦点是否仍在子树内"的包含判断，键盘 Tab / 移入弹窗都能正确区分。 */
          const el = (e && e.currentTarget && typeof e.currentTarget.contains === 'function')
            ? e.currentTarget
            : rootRef.current;
          if (el && e && e.relatedTarget && el.contains(e.relatedTarget)) return;
          /* ★ ZB-27aa（用户报「悬浮展开后点进程要展开内容，面板却被关闭」）：
           * relatedTarget 为 **null** 表示焦点落到了页面根（点击**不可聚焦**元素时的标准行为，
           * 例如点进程行头这种 div[role=button]、或弹窗内的空白处）—— 这不是"用户离开了入口"，
           * 若在这里关闭，弹窗内**任何点击**都会把面板关掉。
           * 因此：只有焦点**明确移到子树外的某个元素**（relatedTarget 非空且不在子树内）才关闭；
           * 真正的"离开"由鼠标移出（onMouseLeave）、点组件外部、窗口失焦三条路径负责。 */
          if (!(e && e.relatedTarget)) return;
          setHover(false);
          scheduleClose();
        },
      },
        /* ZB-27f：**必须是 <button>** —— 邻居都是 button，元素相同才能拿到同一套 UA/平台按钮字体
         * （这是"字体大小不一致"的唯一根因；span 会继承应用字体，怎么调都和邻居不是一个字面）。
         * 宿主针对 button 的状态高亮由**两层**挡住：① 下面这组内联样式（内联优先于任何非 important
         * 的样式表规则，包括 :hover/:focus/伪类）；② CSS 里那组成组重置（带 !important，挡住 important）。 */
        h('button', {
          type: 'button',
          className: 'dsp-chip',
          style: {
            background: 'transparent', backgroundImage: 'none', border: 0, boxShadow: 'none', outline: 'none',
            /* ZB-27p：悬浮/聚焦 = label-primary（与两个可见邻居的 :hover 同值）；
             * 静止 = label-tertiary（已实测与邻居 rgb 完全一致）。 */
            color: hover ? T.text : T.text3,
          },
          title: t('headerTip'),
          'aria-label': t('headerTip'),
          'aria-expanded': open,
          'aria-haspopup': 'dialog',
          /* 悬浮展开语义下点击**不再切换**（否则指针停在入口上时一点就关）；
           * 点击只负责"立刻打开"，供触屏与键盘（Enter/Space 触发 click）使用；关闭走离开/失焦/Esc。 */
          onClick: () => { setOpen(true); setHover(true); clearTimers(); },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onFocus: () => setHover(true),
          onBlur: () => setHover(false),
        },
          /* ZB-27w：**有任务就显示图标**（照抄官方子智能体/后台任务的入口做法）：
           *   有进行中 → StatusDot(state='running')（自带脉动，= "加载图标"）
           *   仅排队中 → StatusDot(state='queued')
           * 槽位固定 14×14（官方 .oXE0lW_activitySlot 同值），所以有/无图标都不会让入口左右跳动。 */
          (runningCount > 0 || queuedCount > 0)
            ? h('span', { className: 'dsp-chip-activity' }, h(StatusDot, { state: runningCount > 0 ? 'running' : 'queued' }))
            : null,
          /* ZB-27v：恢复完整标题「DSH 派发台」（短标签试验已回退 —— 真实差异由 ZB-27u
           * 的样式引用计数修复解决，而非文字）。 */
          h('span', { className: 'dsp-chip-label' }, t('title')),
          /* 展开指示用**系统同款图标与几何**（size 14 / viewBox 16 / strokeWidth 1），
           * 旋转交给 CSS（`.dsp-chip[aria-expanded="true"] svg`）——与子智能体一致。 */
          h(IconChevronDownSystem, { className: 'dsp-chip-chevron' })),
        open ? h(PanelBoundary, null, h(PanelBody, { menuShift })) : null);
    }


    /** 面板主体（ZB-27）：由「右下角浮窗」改为**挂在会话标题行入口下的悬浮弹窗**。
     * 形态与样式对齐 DSH 自带的 job-list / 子智能体目录（menu 令牌 + 由 .dsp-menu 那条 CSS 负责定位）。
     * ZB-06/07/10/11 的拖拽、缩放、固定位置、位置持久化与最小化胶囊随浮窗一并去掉。 */
    function PanelBody({ menuShift }) {
      /* ZB-29c：面板手动派发已移除（派发一律由 Agent 经 dispatch 工具完成）——
       * lastJobId/busy/onSubmit 等派发表单接线随之删除；feedback 保留（总开关切换错误仍经它显示）。 */
      const [feedback, setFeedback] = useState(null);
      const {
        conn, snapshot, quota, planQuota, dispatch, kill, dismiss, tail,
        channels, channelGet, channelSet, retry, fallbackGet, fallbackSet,
        sequentialGet, sequentialSet,
        modelSwitchesGet, modelSwitchSet,
        switchSet,
      } = useWire();
      /* ZB-21 / ZB-27u：样式只注入一次到 document.head（脱离 React 重渲染路径）。
       * ★ 必须用 **ensureStyle() 返回的释放函数**（引用计数），**绝不能**在卸载时直接 detachStyle() ——
       *   面板关闭时若把整张样式表删掉，常驻的会话头入口会立刻失去全部样式（真实 bug，实测
       *   关闭瞬间盒子从 h=28/top=51 变成 h=19/top=56.5，即用户说的"失焦后就不正常了"）。
       *   面板只释放自己那一份；apply() 那份永不释放 ⇒ 插件活着，样式就在。 */
      useEffect(() => {
        const release = ensureStyle();
        return () => { try { release(); } catch { /* ignore */ } };
      }, []);
      // Z6：通道清单 / 默认通道 / 降级链（挂载时拉一次；切换即时回显，wire 返回后用权威值校正）
      /* ZB-56：`levelsStatus`（逐引擎档位探测状态）**跟着通道清单一起来**（core 挂在顶层）——
       * 面板与详情页配置卡据此显示「档位载入中…」而不是"只有默认"。 */
      const [channelsInfo, setChannelsInfo] = useState({ channels: [], warnings: [], levelsStatus: null });
      const [channel, setChannelState] = useState({ provider: 'plan', model: 'GLM-5.3-Flash' });
      const [fallback, setFallbackState] = useState({ enabled: false, chain: [], targets: [], target: null });
      /* ZB-52：顺序派发（每引擎一份模型顺序）。初值 = 三引擎空表 ——
       * 与 core 的 `getSequential()` 同形，wire 返回权威值后覆盖。
       * ZB-52c：**没有开关** —— "是否顺序派发"由「模型」值表达（模型为空即顺序派发），
       * 故这里不再有 `enabled`；面板里也不存第二个真相。
       * ZB-52b：`levels` 与 `order` **同序**（每项 = 该模型自己的思考强度档位；null = 引擎默认）。 */
      const [sequential, setSequentialState] = useState({
        order: { zcode: [], opencode: [], qoder: [] },
        levels: { zcode: [], opencode: [], qoder: [] },
        sequentialCount: 0,
      });
      /* ZB-58：逐模型开关（禁用清单）。null = 还没读到/数据源无此能力 ⇒ 退回通道上的 `userDisabled` 标记。 */
      const [modelSw, setModelSw] = useState(null);
      /* 【真机事故修复（本轮用户现场）】面板三个下拉全部显示「不可用：-」、通道分区空、没有过滤提示。       * 根因：① `channels()` 只在**挂载时拉一次**；② `wire.client` 把失败包成 `{ok:false, error}`
       * （不抛），而下面那个 `.then` 只处理 `ok` ⇒ **失败被静默丢弃、清单永远是空数组**；
       * ③ 客户端也没有任何重试 —— 一次失败（例如冷探测较慢/宿主刚重启时首次调用）就永久残废。
       * 现在三件事一起做：
       *   · **失败可见**：把 wire 给的 error 显示在通道分区（不再"看起来像插件坏了"）；
       *   · **自动自愈**：`snapshot()` 本来就带 `channels[]` 且每秒轮询 ⇒ 用快照兜底回填，
       *     即便挂载时那次 `channels()` 失败，只要之后有任意一次快照成功，下拉就会恢复；
       *   · 轮询回填只在"手上还是空清单"时覆盖，避免把用户刚切换后的权威值覆盖成旧快照。 */
      const [chanError, setChanError] = useState(null);
      useEffect(() => {
        let alive = true;
        Promise.resolve(channels()).then((r) => {
          if (!alive) return;
          if (r && r.ok) {
            setChannelsInfo({ channels: r.channels ?? [], warnings: r.warnings ?? [], levelsStatus: r.levelsStatus ?? null });
            setChanError(null);
          } else setChanError(String((r && r.error) || 'channels() 未返回 ok'));
        }).catch((e) => { if (alive) setChanError(String(e?.message ?? e)); });
        Promise.resolve(channelGet()).then((r) => {
          if (alive && r && r.ok && r.channel && r.channel.provider) setChannelState(r.channel);
        }).catch(() => { /* 兜底：下面快照/后续轮询会校正 */ });
        Promise.resolve(fallbackGet()).then((r) => {
          if (alive && r && r.ok) setFallbackState({ enabled: !!r.enabled, chain: r.chain ?? [], targets: r.targets ?? [], target: r.target ?? null });
        }).catch(() => { /* 同上 */ });
        /* ZB-52：顺序派发（与 fallback 同一纪律：**失败保持初值**，不猜测、不假装已读到）
         * ZB-52b：统一走 `normSeqShape` —— 三引擎键/逐模型档位一次归一，
         * ext / demo / live 三条数据源形状一致（旧源没有 levels ⇒ 全 null = 引擎默认）。 */
        Promise.resolve(sequentialGet()).then((r) => {
          if (alive && r && r.ok) setSequentialState(normSeqShape(r));
        }).catch(() => { /* 同上 */ });
        /* ZB-58：逐模型开关（禁用清单）—— 读失败**不阻塞面板**（通道上的 `userDisabled` 是同源兜底）。 */
        Promise.resolve(modelSwitchesGet()).then((r) => {
          if (alive && r && r.ok) setModelSw(normModelSwitchShape(r));
        }).catch(() => { /* 同上 */ });
        return () => {
          alive = false;
        };
      }, [channels, channelGet, fallbackGet, sequentialGet, modelSwitchesGet]);

      /* 快照兜底回填通道清单（自愈路径）：`snapshot()` 的载荷里本来就有 `channels[]`。
       * 只在"当前清单为空"时采纳 —— 否则会用旧快照覆盖用户刚切通道后的权威值。
       * 依赖里放 `snapshot`：每秒轮询会带来新的快照对象 ⇒ 失败后能自动恢复。 */
      useEffect(() => {
        const snapChans = Array.isArray(snapshot?.channels) ? snapshot.channels : null;
        if (!snapChans || snapChans.length === 0) return;
        /* ⚠️ `prev.channels.length === 0 ? { channels: snapChans` 这段**字面形状**被 engine-ui.test.mjs 钉住
         * （ZB-56 曾把它折行 ⇒ 测试红）；新增的 `levelsStatus` 只能加在同一行里。 */
        setChannelsInfo((prev) => (prev.channels.length === 0 ? { channels: snapChans, warnings: prev.warnings ?? [], levelsStatus: snapshot?.levelsStatus ?? prev.levelsStatus ?? null } : prev));
        setChanError(null);
      }, [snapshot]);

      const onSwitch = useCallback((c) => {
        setChannelState((prev) => ({ ...prev, ...c }));
        Promise.resolve(channelSet(c)).then((r) => {
          if (r && r.ok && r.channel) setChannelState(r.channel);
        });
      }, [channelSet]);
      const onRetry = useCallback((id, opts) => retry(id, opts), [retry]);
      /* ZB-04：续接 = 同会话 + 新指令。继承原 job 的通道/模式/锁/cwd/超时，
       * 但**提示词换成用户新输入的**（这正是与 retry 的区别：retry 重发原提示词）。
       * resume 走 dispatch 的 resume 参数 → runner 传 --resume（wire.host.mjs 的拷贝表含 'resume'）。 */
      const onContinue = useCallback((job, text) => {
        const s = job.spec ?? {};
        const spec = { kind: 'prompt', prompt: text, resume: job.sessionId };
        for (const k of ['provider', 'mode', 'lock', 'cwd']) if (s[k] != null && s[k] !== '') spec[k] = s[k];
        if (s.timeoutMin != null) spec.timeoutMin = s.timeoutMin;
        if (job.tag) spec.tag = `${job.tag}-c`;
        return dispatch(spec);
      }, [dispatch]);
      /* ZB-30：自动降级目标写入（对象 = 单目标开启；null = 关闭）。wire 返回权威值后校正回显。 */
      const onFallbackSet = useCallback((target) => {
        Promise.resolve(fallbackSet(target)).then((r) => {
          if (r && r.ok) setFallbackState({ enabled: !!r.enabled, chain: r.chain ?? [], targets: r.targets ?? [], target: r.target ?? null });
        });
      }, [fallbackSet]);
      /* ZB-52：顺序派发写入（**只发 `{order}`** —— core 已废弃 `enabled`，传它会**抛 TypeError**；
       * 顺序派发由「模型」值表达，不再有开关）。
       * 乐观回显：面板先按用户操作渲染，wire 返回权威值后校正（与 fallback 同款）。
       * ZB-52b：回显同样按 `normSeqShape` 归一 —— 逐模型档位必须跟着权威值一起回来，
       * 否则「刚设的档位」会在写入成功后从下拉里消失。 */
      const onSequentialSet = useCallback((patch) => {
        Promise.resolve(sequentialSet(patch)).then((r) => {
          if (r && r.ok) setSequentialState(normSeqShape(r));
        });
      }, [sequentialSet]);
      /** ZB-58：逐模型「可用」开关（浮窗的顺序列表里也能就地开关，与配置卡**同一写入口径**）。
       *  乐观翻转 + 权威回读校正；失败进面板 feedback 行（可读错误）。 */
      const onModelToggle = useCallback((route, enabled) => {
        setModelSw((prev) => {
          const cur = new Set(prev && Array.isArray(prev.disabled) ? prev.disabled.map(String) : []);
          if (enabled) cur.delete(String(route));
          else cur.add(String(route));
          return { disabled: [...cur].sort(), userDisabledCount: cur.size };
        });
        Promise.resolve(modelSwitchSet({ route, enabled })).then((r) => {
          if (r && r.ok) setModelSw(normModelSwitchShape(r));
          else {
            setFeedback({ kind: 'err', text: `${t('errPrefix')}${(r && r.error) || 'unknown'}` });
            /* 写失败 ⇒ 回读权威清单，回滚乐观翻转（不留下"改了但没落盘"的假状态）。 */
            Promise.resolve(modelSwitchesGet()).then((rr) => { if (rr && rr.ok) setModelSw(normModelSwitchShape(rr)); }).catch(() => { /* 错误已可见 */ });
          }
        }).catch((e) => setFeedback({ kind: 'err', text: `${t('errPrefix')}${e?.message ?? e}` }));
      }, [modelSwitchSet, modelSwitchesGet]);
      // Z12：派发总开关切换（成功 → 1s 轮询带回新快照、徽标自动翻转；失败 → 错误进面板反馈行）
      const onSwitchToggle = useCallback((next) => Promise.resolve(switchSet(next)).then((r) => {
        if (!r || !r.ok) setFeedback({ kind: 'err', text: `${t('errPrefix')}${(r && r.error) || 'unknown'}` });
      }), [switchSet]);

      const onKill = useCallback((id) => {
        Promise.resolve(kill(id)).catch(() => { /* wire 已兜底返回 {ok:false}，这里只防未捕获 rejection */ });
      }, [kill]);
      const onDismiss = useCallback((id) => Promise.resolve(dismiss(id)), [dismiss]);

      // 交互元素上按下不启动拖动（否则标题栏的 setPointerCapture 会吃掉子按钮的 click）
      // （isInteractive 已上移模块级：与 JobRow 行头点击守卫共用）
      /* ZB-27：只保留**主题令牌**注入 —— 浮窗时代的 --dsp-w / --dsp-h（用户拖拽出来的宽高）
       * 随拖拽功能一起去掉：弹窗宽高由 .dsp-menu 的 CSS 决定（width: min(440px, 100vw-32px)）。 */
      /* ZB-36（用户要求「调整派发台面板的高度，增加 100%」）：弹窗高度上限 **480px → 960px**。
       * ⚠️ 刻意**不改 `.dsp-menu` 类本身**：那条 `max-height:min(480px,calc(100vh - 140px))` 是
       * **照抄 DSH 官方菜单**的值（`header-entry.test.mjs` B28 钉住；job-list 等弹层共用该类）。
       * 所以只在**面板这一层**用行内 maxHeight 覆盖 —— 视口项 `calc(100vh - 140px)` 保持不变，
       * 短屏仍不会顶出屏幕（只影响"能显示多高"，不影响其它弹层）。 */
      const PANEL_MAX_HEIGHT = 'min(960px, calc(100vh - 140px))';

      const cssVars = DSP_CSS_VARS; // ZB-53：共用件（插件详情页配置卡也挂同一组 --dsp-* 令牌）

      const runningNow = ((snapshot && snapshot.counts && snapshot.counts.running) || 0) > 0;
      const connLabel = conn === 'demo' ? t('connDemo') : conn === 'ext' ? t('connExt') : conn === 'live' ? t('connLive') : conn === 'offline' ? t('connOffline') : t('connConnecting');
      /* ZB-01 ③：离线/降级态的可读原因——取自 $mount 与子 fiber 的真实留痕，不猜、不谎报。
       * 这段文字是「面板为什么未连接」的唯一权威说明：$mount 失败会带上真实错误消息。 */
      const offlineReason = (() => {
        if (conn === 'live') return '';
        if (!MOUNT_DIAG.attempted) return `${t('chanOfflineHint')}（ctx.remote.$mount 不可用）`;
        if (MOUNT_DIAG.ok === false) return `${t('chanOfflineHint')}（$mount 失败：${MOUNT_DIAG.error}）`;
        return `${t('chanOfflineHint')}（描述符已挂载，等宿主命名空间 remote.dispatch 就绪）`;
      })();
      const showOfflineNote = conn === 'offline';
      // Z12：开关状态只认 live 快照携带的 snapshot.switch（宿主读真值文件）；其他数据源如实显示「未知/只读」
      const dispatchSwitch = snapshot && snapshot.switch ? snapshot.switch : null;

      /* ZB-27：容器改用系统菜单样式（.dsp-menu，见 CSS —— 令牌与 job-list 的弹层同一套）。
       * --dsp-* 自定义属性挂在**这一层**，下面的各分区样式照旧解析。 */
      /* ZB-27x：menuShift 由入口按视口余量算出（左对齐后防右溢出），合并进容器样式。
       * ZB-36：再加一层面板专属 maxHeight（见 PANEL_MAX_HEIGHT 说明）。 */
      return h('div', {
        className: 'dsp-menu',
        style: { ...cssVars, maxHeight: PANEL_MAX_HEIGHT, ...(menuShift ? { marginLeft: `${menuShift}px` } : {}) },
        role: 'dialog',
        'aria-label': t('title'),
      },
        h('div', { className: 'dsp-panelHead' },
          h(StatusDot, { state: runningNow ? 'running' : 'idle' }),
          h('span', { className: 'dsp-panelTitle' }, t('title')),
          h(SwitchBadge, { sw: dispatchSwitch, live: conn === 'live', onToggle: onSwitchToggle }),
          h('span', { className: 'dsp-conn', title: offlineReason || connLabel, 'aria-label': connLabel }, connLabel),
        ),
        /* ZB-01 ③：离线原因放在 body 首行（始终在默认折叠的各分区之外）——
         * 免得排查时还要先展开「通道」分区才看得到。 */
        showOfflineNote ? h('div', { className: 'dsp-note', role: 'status', title: offlineReason }, offlineReason) : null,
        /* ZB-29c：派发表单移除后，feedback 仍承载总开关切换失败的错误显示（挂在 body 首行）。 */
        feedback ? h('div', { className: `dsp-feedback${feedback.kind === 'err' ? ' dsp-err' : ''}`, role: 'status' }, feedback.text) : null,
        h('div', { className: 'dsp-body' },
          h(Section, { id: SEC.channel, title: t('secChannel'), collapsible: true },
            /* 离线说明只在 body 首行渲染一处（去重）：这里不再重复同一句话。 */
            h(ChannelSection, { channelsInfo, channel, fallback, onSwitch, onFallbackSet, sequential, onSequentialSet, offline: conn !== 'live', offlineReason, sw: dispatchSwitch, chanError,
              /* ZB-58：逐模型开关 —— 「模型」下拉据此过滤已关闭项；顺序列表里可原地重开。 */
              disabledModels: modelSw && Array.isArray(modelSw.disabled) ? modelSw.disabled : null,
              onToggleModel: onModelToggle })),
          /* ZB-29c（用户要求）：**派发分区已移除**——无需手动派发，有需要让 Agent 通过
           * dispatch 工具代劳。
           * 【用户要求（本轮）：**用量移到最下面**】顺序 = 通道 → 进程 → 单写者/文件锁 → 用量。
           * 理由：用量是"回头看"的统计，而通道/进程/锁是"当下要看"的操作面；
           * 放在最后不会把它挤到需要滚动才能看到的地方，也不会挡住进程列表。
           * 分区 id 不变 ⇒ 各自展开状态与持久化键（localStorage['dispatch:section:<id>']）不受影响。 */
          h(Section, { id: SEC.jobs, title: t('secJobs'), collapsible: true },
            h(JobList, { snapshot, onKill, onDismiss, onTail: tail, onRetry, onContinue, channels: channelsInfo.channels, refreshKey: (snapshot && snapshot.generatedAt) || '', offline: conn === 'offline' })),
          /* ZB-09：单写者/文件锁紧跟在进程列表之后（排查并发问题时与进程对照着看更顺）。 */
          h(Section, { id: SEC.locks, title: t('secLocks'), collapsible: true },
            h(LockStatus, { snapshot })),
          h(Section, { id: SEC.quota, title: t('secQuota'), collapsible: true },
            h(QuotaCards, { quota, planQuota })),
        ),
      );
    }

    /* ─────────── ZB-53：插件详情页**配置卡**（槽位 `plugins.bundle.config`，按包名派发） ───────────
     * 用户真机反馈：详情页只有名字/描述、光秃秃没有配置区 —— 因为本插件从没往这个槽位注册过任何东西。
     * 卡片内容 = **顺序派发设置**（用户本来就想放这儿的东西）：每引擎一块列表 + ↑↓ + 逐模型档位；
     * 与浮窗「通道」分区**复用同一套** `buildSeqBlocks()` / `SeqBlocksView`（不重写、不会漂移）。
     *
     * ⚠️ 优雅降级（详情页可能在 host 未就绪时被渲染）：数据源一律走 `useWire()` 的降级链
     * （远端面 → ext → demo → offline）；offline 下读写返回可读错误、`channels()` 给空表，
     * 卡片据此渲染"未连接宿主 / 通道清单加载中"提示，**绝不白屏、绝不抛错**（组件内不直接碰 ctx/remote）。
     * 样式沿用既有 `dsp-*` 类名 + 主题令牌（`DSP_CSS_VARS` 挂在卡片根上，否则 `var(--dsp-*)` 不解析）。 */
    function DispatchConfigCard() {
      const { conn, channels, channelGet, fallbackGet, sequentialGet, sequentialSet, modelSwitchesGet, modelSwitchSet } = useWire();
      const [channelsInfo, setChannelsInfo] = useState({ channels: [], warnings: [], levelsStatus: null });
      /* ZB-55：**区分"还在加载"与"真的没有模型"** —— 首帧通道清单还没到时，
       * 旧实现会显示「该引擎当前没有可选模型」= **谎报**。现在用三态：
       *   'loading'（还没拿到）→ 卡片显示加载指示、不渲染引擎按钮/列表；
       *   'ready'（拿到了，可能确实是空表）→ 才渲染；'error'（拉取失败）→ 只显示可读错误。
       * ⚠️ 不伪造延迟：数据一到就渲染（切引擎是本地 state ⇒ 瞬时）。 */
      const [chansState, setChansState] = useState('loading');
      const [channel, setChannelState] = useState({ provider: 'plan', model: 'GLM-5.3-Flash' });
      const [fallback, setFallbackState] = useState({ enabled: false, chain: [], targets: [], target: null });
      const [sequential, setSequentialState] = useState({
        order: { zcode: [], opencode: [], qoder: [] },
        levels: { zcode: [], opencode: [], qoder: [] },
        sequentialCount: 0,
      });
      const [saving, setSaving] = useState(false);
      /* 防连点：在途时**同步**拦截（React state 更新是异步的，光靠 `saving` 拦不住双击）。 */
      const savingRef = useRef(false);
      const [err, setErr] = useState(null);
      /* ZB-58：逐模型开关（禁用清单）。null = 还没读到 / 数据源没这个能力
       * ⇒ 退回通道上的 `userDisabled` 标记（同源真相，不会与权威清单互相矛盾）。 */
      const [modelSw, setModelSw] = useState(null);
      useEffect(() => {
        let alive = true;
        Promise.resolve(channels()).then((r) => {
          if (!alive) return;
          if (r && r.ok) {
            /* ZB-56：`levelsStatus` 也收下（core 挂在 channels() 顶层）—— 逐引擎 pending 时
             * 该引擎的档位下拉显示「档位载入中…」，而不是让人以为这模型没档位。 */
            setChannelsInfo({ channels: r.channels ?? [], warnings: r.warnings ?? [], levelsStatus: r.levelsStatus ?? null });
            setChansState('ready');
          } else { setErr(String((r && r.error) || 'channels() 未返回 ok')); setChansState('error'); }
        }).catch((e) => { if (alive) { setErr(String(e?.message ?? e)); setChansState('error'); } });
        Promise.resolve(channelGet()).then((r) => {
          if (alive && r && r.ok && r.channel && r.channel.provider) setChannelState(r.channel);
        }).catch(() => { /* 保持初值（离线下由上面的提示说明原因） */ });
        Promise.resolve(fallbackGet()).then((r) => {
          if (alive && r && r.ok) {
            setFallbackState({ enabled: !!r.enabled, chain: r.chain ?? [], targets: r.targets ?? [], target: r.target ?? null });
          }
        }).catch(() => { /* 同上 */ });
        Promise.resolve(sequentialGet()).then((r) => {
          if (alive && r && r.ok) setSequentialState(normSeqShape(r));
        }).catch(() => { /* 同上 */ });
        /* ZB-58：逐模型开关（禁用清单）—— 读失败**不阻塞卡片**：通道清单里的 `userDisabled`
         * 标记是同源真相，可照常渲染开关初值；只有**写失败**才必须可见（见 onToggleModel）。 */
        Promise.resolve(modelSwitchesGet()).then((r) => {
          if (alive && r && r.ok) setModelSw(normModelSwitchShape(r));
        }).catch(() => { /* 同上：退回通道标记 */ });
        return () => { alive = false; };
      }, [channels, channelGet, fallbackGet, sequentialGet, modelSwitchesGet]);
      /** 写入顺序列表：与浮窗同一套 patch（`{order}` 单引擎）；失败只显示可读错误，不抛。
       *  ⚠️ 防连点：`savingRef` 同步拦截在途期间的重复写入（双击/连点不会发第二次）。
       *  保存期间 `saving=true` ⇒ 该块下拉与 ↑↓ 全部禁用 + 区块头显示「保存中…」（不整卡闪）。 */
      const onSet = useCallback((patch) => {
        if (savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        setErr(null);
        Promise.resolve(sequentialSet(patch)).then((r) => {
          if (r && r.ok) setSequentialState(normSeqShape(r));
          else setErr(String((r && r.error) || '顺序设置写入失败'));
        }).catch((e) => setErr(String(e?.message ?? e))).finally(() => {
          savingRef.current = false;
          setSaving(false);
        });
      }, [sequentialSet]);
      /** ZB-58：逐模型「可用」开关写入（`modelSwitchSet({route, enabled})`）。
       *  **乐观翻转**（列表/下拉立即响应）→ 再用权威禁用清单校正；失败进 `err` 行（用户要求"失败要可读"）。
       *  与顺序写入共用 `savingRef` 同步拦截 ⇒ 连点/双写不会把两次 toggle 交错落盘。 */
      const onToggleModel = useCallback((route, enabled) => {
        if (savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        setErr(null);
        setModelSw((prev) => {
          const cur = new Set(prev && Array.isArray(prev.disabled) ? prev.disabled.map(String) : []);
          if (enabled) cur.delete(String(route));
          else cur.add(String(route));
          return { disabled: [...cur].sort(), userDisabledCount: cur.size };
        });
        Promise.resolve(modelSwitchSet({ route, enabled })).then((r) => {
          if (r && r.ok) setModelSw(normModelSwitchShape(r));
          else {
            setErr(String((r && r.error) || '模型开关写入失败'));
            /* 写失败 ⇒ 乐观翻转**必须回滚**：回读权威禁用清单，别让界面停在"改了但没落盘"的假状态。 */
            Promise.resolve(modelSwitchesGet()).then((rr) => { if (rr && rr.ok) setModelSw(normModelSwitchShape(rr)); }).catch(() => { /* 保持现状，错误已可见 */ });
          }
        }).catch((e) => setErr(String(e?.message ?? e))).finally(() => {
          savingRef.current = false;
          setSaving(false);
        });
      }, [modelSwitchSet, modelSwitchesGet]);
      /** 用户手动选中的编辑引擎（null = 还没选 ⇒ 用默认推导）。 */
      const [pickedEng, setPickedEng] = useState(null);
      const chans = channelsInfo.channels;
      /* ZB-54（用户真机反馈「卡片只有说明、没有列表」）：**按引擎编辑**，与"主通道/降级是否顺序派发"解耦。
       * 默认引擎 = 主通道当前引擎 → 已有顺序的引擎 → ZCode（用户要求）。 */
      const activeEng = pickedEng ?? defaultSeqEngine(chans, channel, sequential);
      const usage = seqEngineUsage(chans, channel, fallback, activeEng);
      /* 选中的引擎**始终**渲染它的顺序列表（哪怕当前没被任何链使用 —— 否则就是"先开了才有东西配"的鸡生蛋）。 */
      const disabledSet = disabledSetOf(modelSw);
      const block = makeEngineSeqBlock({
        channels: chans, engine: activeEng, sequential, onSet,
        levelsStatus: channelsInfo.levelsStatus?.[activeEng] ?? null,  // ZB-56：pending ⇒ 行内显示「档位载入中…」
        disabledSet, onToggleModel, // ZB-58：逐模型「可用」开关（列表仍显示已关闭项，便于重开）
      });
      const offline = conn === 'offline';
      /* 该引擎"没有模型"的**诚实原因**（探针未返回 / 执行器未配置等，来自 core 的 warnings）——
       * 有原因就显示原因，而不是干巴巴一句"没有可选模型"（也不能谎称"还在加载"）。 */
      const engineWarn = (channelsInfo.warnings ?? [])
        .find((w) => String(w).toLowerCase().includes(String(activeEng).toLowerCase())) ?? null;
      const cardStyle = { ...DSP_CSS_VARS, padding: '10px 12px', border: `1px solid ${T.border}`, borderRadius: '8px' };
      /* ③ 数据未就绪（wire 还在 connecting / channels 还没回来）⇒ **加载中**，不渲染引擎按钮与列表。
       * 用户原话「完全加载完成才显示」；也绝不把"还没到"显示成"没有模型"（那是谎报）。 */
      if (chansState === 'loading' || conn === 'connecting') {
        return h('div', {
          className: 'dsp-stack', style: cardStyle,
          'data-dsp-bundle-config': BUNDLE_CONFIG_KEY, 'data-dsp-seq-state': 'loading',
        },
          h('div', { className: 'dsp-field' },
            h(StatusDot, { state: 'running' }),
            h('span', { className: 'dsp-note', style: { marginLeft: '6px' } }, t('seqLoading'))));
      }
      /* 拉取失败 ⇒ 只显示可读错误（不猜引擎、不显示空列表） */
      if (chansState === 'error') {
        return h('div', {
          className: 'dsp-stack', style: cardStyle,
          'data-dsp-bundle-config': BUNDLE_CONFIG_KEY, 'data-dsp-seq-state': 'error',
        },
          h('div', { className: 'dsp-feedback dsp-err', role: 'status' }, `${t('chanLoadFail')}: ${err ?? '-'}`));
      }
      /* 状态行：这个顺序**现在生效吗**（主通道用它 / 降级目标用它 / 都没用）—— 一行，用户要求。 */
      const usageKey = usage.main && usage.fallback ? 'seqUseBoth'
        : usage.main ? 'seqUseMain'
          : usage.fallback ? 'seqUseFallback' : 'seqUseNone';
      const usageState = usage.main && usage.fallback ? 'both' : usage.main ? 'main' : usage.fallback ? 'fallback' : 'none';
      return h('div', {
        className: 'dsp-stack',
        style: cardStyle,
        'data-dsp-bundle-config': BUNDLE_CONFIG_KEY, 'data-dsp-seq-state': 'ready',
      },
        /* ① 引擎选择：ZCode / OpenCode / Qoder（小切换控件，沿用 dsp-btn2 + 主题令牌高亮） */
        h('div', { className: 'dsp-field' },
          h('span', { className: 'dsp-field-k' }, t('enginesTitle')),
          h('span', { className: 'dsp-field-v', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            KNOWN_ENGINES.map((eng) => h('button', {
              key: eng, type: 'button', className: 'dsp-btn2',
              'data-dsp-seq-eng': eng,
              'aria-pressed': activeEng === eng,
              style: {
                padding: '2px 8px',
                ...(activeEng === eng ? { borderColor: T.accent, color: T.text } : { color: T.text2 }),
              },
              onClick: () => setPickedEng(eng),
            }, engLabel(eng))))),
        /* ② 状态行：该引擎当前是否正在被顺序派发（主 / 降级 / 都没用） */
        h('div', { className: 'dsp-note', role: 'status', 'data-dsp-seq-usage': usageState }, t(usageKey)),
        /* ③ 一行关键信息（完整说明进 tooltip `seqHint`；卡片不再被 ~300 字占满） + 该引擎的顺序列表
         * `saving` ⇒ 区块头显示「保存中…」且整块交互禁用（不整卡闪）。 */
        h(SeqBlocksView, {
          blocks: [block], offline, busy: saving, saving,
          hint: t('seqHintCard'), hintTitle: t('seqHint'),
        }),
        /* 该引擎确实没有模型时，**带上 core 给的原因**（探测未返回 / 执行器未配置…），比一句空态诚实 */
        (!block.list.length && engineWarn)
          ? h('div', { className: 'dsp-note', role: 'status' }, String(engineWarn).replace(/^\[info\]\s*/, ''))
          : null,
        /* 未就绪 / 空清单：说清原因（而不是让用户对着空卡片猜）—— 复用既有文案键 */
        offline
          ? h('div', { className: 'dsp-note', role: 'status' }, t('chanOfflineHint'))
          : null,
        err
          ? h('div', { className: 'dsp-feedback dsp-err', role: 'status' }, `${t('chanLoadFail')}: ${err}`)
          : null);
    }

    /* ─────────────── D1：`dispatch` 工具的会话内卡片（`tool.call.toolview`）───────────────
     * 目的：`dispatch` 现在走通用卡片 —— 结果是大段 JSON（`action=list` 历史上可达 70KB+），
     * 又长又难定位。这里注册一张**紧凑可展开**的状态卡：
     *   · 折叠行：动作 / tag / 状态胶囊 / 模型 / 耗时 / exit（一行看清"这次调用干了什么、成没成"）；
     *   · 展开区：结构化字段（job id / 状态 / 引擎通道 / 模型 / cwd / 超时 / 锁 / 错误 / 后续动作提示）
     *     + **按需展开**的原始入参与原始结果（限高滚动 + 截断提示，绝不把大 JSON 整段铺开）。
     *
     * 硬纪律（与面板同一套）：
     *   · **绝不抛错**：下面所有解析都是纯函数 + 全 try/catch；`DispatchToolRow` 最外层再兜一层，
     *     异常时退化成一行纯文本（工具名 + id）—— 会话其它部分不受影响。
     *   · 除 `react` 外零 require（宿主私有包第三方拿不到）；**不用**宿主的 `args` 懒读器，
     *     一律用 `argsRaw` 字符串自己 `JSON.parse`（契约只保证 argsRaw）。
     *   · 颜色只走主题令牌 `T.*`（明暗双主题自适应），零字面色值。
     *   · 文案走 `t('键')`，与 `locale/zh.json`、`locale/en.json` 三方同步（single-source 测试守门）。
     *
     * 阶段模型（对 ui-tool 的 `toolCallPhase()` 逐字核实）：
     *   · `preparing` → `{phase:'preparing', callId, name}`：还没有入参 ⇒ 占位行「正在派发…」；
     *   · `start`     → `{phase:'start', callId, name, argsRaw}`：解析入参，显示动作/目标；
     *   · `result`    → `{kind, callId, call:{name, argsRaw}, content:[{type:'text',text}], error?, isError}`：
     *     结果正文是**工具返回值的 JSON 字符串**（index.js `execute` 末行 `JSON.stringify(result)`），
     *     故这里 `JSON.parse` 后按信封分派 → `{ok,job}` / `{ok,jobs}` / `{ok,…}` / `{ok:false,error}`。 */

    /** 单行化：折叠行摘要只留第一行（长文本不许撑破行）。纯函数，永不抛。 */
    const tvFirstLine = (text) => {
      const s = typeof text === 'string' ? text : (text == null ? '' : String(text));
      const i = s.indexOf('\n');
      return i === -1 ? s : s.slice(0, i);
    };
    /** 截断（长原文不铺开）：返回 `{text, truncated, total}`。纯函数，永不抛。 */
    const tvClip = (text, max) => {
      const s = typeof text === 'string' ? text : (text == null ? '' : String(text));
      const cap = Number.isFinite(max) && max > 0 ? max : 6000;
      return s.length <= cap
        ? { text: s, truncated: false, total: s.length }
        : { text: s.slice(0, cap), truncated: true, total: s.length };
    };
    /** 宽松 JSON 解析：拿不到 **JSON 对象/数组**就返回 null（`null` 字面量、标量、坏 JSON、空串一律 null；
     *  不抛、不猜）。数组也算"拿到了" —— 上层按字段访问，缺字段自然退化，不会抛。 */
    const tvJson = (raw) => {
      try {
        if (typeof raw !== 'string' || raw === '') return null;
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : null;
      } catch { return null; }
    };
    /** result 阶段的内容块 → 文本（对齐宿主的 `resultText` 契约：text 块取 text，其它块字符串化）。 */
    const tvContentText = (block) => {
      try {
        const parts = [];
        const content = Array.isArray(block && block.content) ? block.content : [];
        for (const item of content) {
          if (item && item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
          else if (item != null) parts.push(JSON.stringify(item, null, 2));
        }
        if (parts.length === 0 && block && block.error) {
          parts.push(`${block.error.name ?? 'error'}${block.error.code ? `: ${block.error.code}` : ''}`);
        }
        const text = parts.join('\n');
        return text === '' ? null : text;
      } catch { return null; }
    };
    /** 计数字典 → `running×1 · done×3`（最多 6 项，多出的折成 `+N`）。纯函数，永不抛。 */
    const tvCountsText = (counts) => {
      try {
        if (!counts || typeof counts !== 'object') return '';
        const pairs = Object.keys(counts)
          .map((k) => [k, Number(counts[k])])
          .filter(([, n]) => Number.isFinite(n) && n > 0);
        if (pairs.length === 0) return '';
        const head = pairs.slice(0, 6).map(([k, n]) => `${k}×${n}`).join(' · ');
        return pairs.length > 6 ? `${head} +${pairs.length - 6}` : head;
      } catch { return ''; }
    };
    /** 耗时的**紧凑**写法（面板的 `fmtSec` 是「0时00分42秒」，卡片里太长）：`12.3s` / `1m02s` / `1h05m`。 */
    const tvElapsed = (sec) => {
      try {
        if (!Number.isFinite(sec)) return '';
        const total = Math.max(0, Number(sec));
        if (total < 60) return `${total < 10 ? total.toFixed(1) : Math.round(total)}s`;
        const m = Math.floor(total / 60);
        if (m < 60) return `${m}m${String(Math.floor(total % 60)).padStart(2, '0')}s`;
        return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
      } catch { return ''; }
    };
    /** `action=list` 的单条 job → 一行紧凑文本（**brief 与 full 两种形状都吃**：
     *  brief 没有 `spec`，full 才有 —— 所以 `spec.*` 一律当可选，缺失就跳过，不假设存在）。
     *  纯函数，永不抛。 */
    const tvBriefLine = (job) => {
      try {
        if (!job || typeof job !== 'object') return '?';
        const spec = job.spec && typeof job.spec === 'object' ? job.spec : {};
        const bits = [String(job.id ?? '?')];
        if (job.state) bits.push(String(job.state));
        const tag = job.tag ?? spec.tag;
        if (tag) bits.push(`#${tag}`);
        const model = job.model ?? spec.model;
        if (model) bits.push(String(model));
        if (Number.isFinite(job.elapsedSec)) bits.push(tvElapsed(job.elapsedSec));
        if (Number.isFinite(job.exitCode)) bits.push(`exit=${job.exitCode}`);
        if (job.stalled === true) bits.push('stalled');
        if (job.pauseReason) bits.push(String(job.pauseReason));
        return bits.filter((x) => x !== '' && x != null).join(' ');
      } catch { return '?'; }
    };
    /** 单个 job → 卡片要用的字段（**只用已核实的字段名**；缺失留 null，不猜、不编）。 */
    const tvJobFacts = (job) => {
      try {
        if (!job || typeof job !== 'object') return null;
        const spec = job.spec && typeof job.spec === 'object' ? job.spec : {};
        return {
          id: job.id ?? null,
          state: typeof job.state === 'string' && job.state ? job.state : null,
          tag: job.tag ?? spec.tag ?? null,
          kind: spec.kind ?? null,
          /* ⚠️ 引擎判据必须走**面板同一份** `jobEngineOf`（870-880）：`action=list` 的 **brief 形状
           * 没有 `spec`**（宿主 briefJob() 已剔除），只读 `job.engine ?? spec.engine` 会在
           * engine 字段缺失的旧记录上什么都显示不出来，而面板能由 provider 形态推断 ⇒
           * 同一个 job 在卡片与面板里显示不一致（审计 R2a / P0）。 */
          engine: jobEngineOf(job),
          provider: job.provider ?? spec.provider ?? null,
          model: job.model ?? spec.model ?? null,
          cwd: spec.cwd ?? null,
          timeoutMin: spec.timeoutMin ?? null,
          lock: spec.lock ?? null,
          write: Array.isArray(spec.write) ? spec.write.filter((x) => typeof x === 'string' && x.trim()) : [],
          writeCount: Array.isArray(spec.write) ? spec.write.length : 0,
          body: tvFirstLine(spec.body ?? ''),
          elapsedSec: Number.isFinite(job.elapsedSec) ? job.elapsedSec : null,
          exitCode: Number.isFinite(job.exitCode) ? job.exitCode : null,
          pauseReason: job.pauseReason ?? null,
        };
      } catch { return null; }
    };
    /** 展开区的结构化字段（顺序即阅读顺序；空值**不产生行** ⇒ 不显示无意义的空行）。 */
    const tvFactsFrom = (args, job) => {
      try {
        const a = args && typeof args === 'object' ? args : {};
        const rows = [];
        const id = (job && job.id) ?? a.id ?? a.jobId ?? null;
        if (id != null) rows.push({ k: t('tvJobId'), v: String(id) });
        if (job && job.state) rows.push({ k: t('tvState'), v: String(job.state) });
        const act = typeof a.action === 'string' && a.action ? a.action : (typeof a.kind === 'string' ? a.kind : '');
        if (act) rows.push({ k: t('tvAction'), v: String(act) });
        if (job) {
          /* 引擎 / 通道 / 模型**去重后**拼一行：OpenCode、Qoder 的 provider 就是 `opencode/<model>`
           * 形态（与模型同名），不去重会显示成「opencode · opencode/x · opencode/x」。 */
          const parts = [...new Set([job.engine, job.provider, job.model].filter(Boolean).map(String))];
          if (parts.length) rows.push({ k: t('tvEngineCh'), v: parts.join(' · ') });
          if (job.cwd) rows.push({ k: t('cwd'), v: String(job.cwd) });
          if (job.timeoutMin != null) rows.push({ k: t('timeout'), v: String(job.timeoutMin) });
          if (job.lock) rows.push({ k: t('repoLock'), v: String(job.lock) });
        } else {
          if (a.provider != null && a.provider !== '') rows.push({ k: t('provider'), v: String(a.provider) });
          if (a.model != null && a.model !== '') rows.push({ k: t('model'), v: String(a.model) });
          if (a.cwd) rows.push({ k: t('cwd'), v: String(a.cwd) });
          if (a.timeoutMin != null) rows.push({ k: t('timeout'), v: String(a.timeoutMin) });
          if (a.lock) rows.push({ k: t('repoLock'), v: String(a.lock) });
        }
        /* 声明写入集：**优先 job.spec.write**（落库的权威值），没有才退回入参里的 write。 */
        const wSrc = job && Array.isArray(job.write) && job.write.length ? job.write : a.write;
        const w = Array.isArray(wSrc) ? wSrc.filter((x) => typeof x === 'string' && x.trim()) : [];
        if (w.length) rows.push({ k: t('writeFiles'), v: w.slice(0, 8).join(' · ') + (w.length > 8 ? ` +${w.length - 8}` : '') });
        return rows;
      } catch { return []; }
    };
    /** 非 job 信封（status / channel / channels / tail / quota / switch / dismiss / fallback…）→ 一行摘要。 */
    const tvEnvelopeSummary = (data) => {
      try {
        if (!data || typeof data !== 'object') return '';
        if (data.switch && typeof data.switch === 'object') {
          return data.switch.enabled === true ? t('switchOn') : data.switch.enabled === false ? t('switchOff') : t('switchUnknown');
        }
        if (data.channel && typeof data.channel === 'object') {
          return `${data.channel.provider ?? '?'}${data.channel.model ? `/${data.channel.model}` : ''}`;
        }
        if (Array.isArray(data.channels)) {
          const warn = Array.isArray(data.warnings) ? data.warnings.length : 0;
          return `${data.channels.length} · ${t('provider')}${warn ? ` · ${warn} !` : ''}`;
        }
        if (Array.isArray(data.lines)) return `${data.lines.length} ${t('tvLines')}`;
        if (data.id != null && data.state != null) return `${data.id} → ${data.state}`;
        if (data.quota || data.planQuota) return t('secQuota');
        if (data.enabled !== undefined && Array.isArray(data.chain)) {
          return `${t('fallbackTitle')}：${data.enabled ? t('fallbackStateOn') : t('fallbackStateOff')}`;
        }
        return '';
      } catch { return ''; }
    };
    /** 三阶段 block → **渲染模型**（纯函数 + 全 try/catch ⇒ 永不抛；未知形状一律退化，不猜语义）。 */
    const tvModel = (props) => {
      const p = props && typeof props === 'object' ? props : {};
      const block = p.block && typeof p.block === 'object' ? p.block : null;
      const settled = !!(block && 'kind' in block);
      const phase = settled ? 'result' : p.phase === 'start' ? 'start' : 'preparing';
      const argsRaw = String((settled ? (block.call && block.call.argsRaw) : (block && block.argsRaw)) ?? '');
      const args = tvJson(argsRaw) ?? {};
      const out = {
        phase,
        state: phase === 'preparing' ? 'preparing' : 'running',
        action: typeof args.action === 'string' && args.action
          ? args.action
          : (typeof args.kind === 'string' && args.kind ? args.kind : null),
        tag: typeof args.tag === 'string' && args.tag ? args.tag : null,
        model: typeof args.model === 'string' && args.model ? args.model : null,
        elapsed: '',
        exit: null,
        summary: '',
        jobs: null,
        note: null,
        errorText: null,
        tailHint: null,
        facts: [],
        argsRaw,
        rawText: null,
      };
      if (phase === 'preparing') return out; // 占位行：只显示「正在派发…」（此时还没有入参）
      if (phase === 'start') {
        const target = tvFirstLine(args.prompt ?? args.task ?? args.target ?? '');
        out.summary = target ? tvClip(target, 160).text : '';
        out.facts = tvFactsFrom(args, null);
        return out;
      }
      /* ── result ── */
      const text = tvContentText(block);
      out.rawText = text;
      const data = tvJson(text);
      const isError = !!block.isError;
      const errHead = block.error
        ? `${block.error.name ?? 'error'}${block.error.code ? `（${block.error.code}）` : ''}`
        : '';
      if (!data) {
        /* 非 JSON 正文（或被 interrupted 截断）：如实按文本显示，不假装解析成功。 */
        out.state = block.error && block.error.code === 'interrupted' ? 'interrupted' : isError ? 'failed' : 'done';
        out.summary = tvClip(tvFirstLine(text ?? errHead), 160).text;
        out.errorText = isError ? (text ?? errHead) : null;
        out.facts = tvFactsFrom(args, null);
        return out;
      }
      if (data.ok === false) {
        const msg = typeof data.error === 'string' && data.error
          ? data.error
          : (typeof data.message === 'string' && data.message ? data.message : (text ?? errHead));
        out.state = 'failed';
        out.errorText = msg;
        out.summary = tvClip(tvFirstLine(msg), 160).text;
        out.note = typeof data.note === 'string' && data.note ? data.note : null;
        out.facts = tvFactsFrom(args, null);
        return out;
      }
      const f = tvJobFacts(data.job);
      if (f) {
        out.state = f.state ?? 'done';
        out.tag = out.tag ?? (f.tag == null ? null : String(f.tag));
        out.model = out.model ?? (f.model == null ? null : String(f.model));
        out.elapsed = tvElapsed(f.elapsedSec);
        out.exit = f.exitCode;
        out.summary = tvClip(f.body, 160).text;
        out.facts = tvFactsFrom(args, f);
        out.tailHint = f.id ? `${t('tvTailHint')} · id=${f.id}` : null;
        out.note = typeof data.warning === 'string' && data.warning
          ? data.warning
          : typeof data.note === 'string' && data.note
            ? data.note
            : f.pauseReason ? `${t('paused')}：${f.pauseReason}` : null;
        return out;
      }
      if (Array.isArray(data.jobs)) {
        const total = Number.isFinite(data.total) ? data.total : data.jobs.length;
        const counts = tvCountsText(data.counts);
        out.state = 'done';
        out.jobs = data.jobs;
        out.summary = `${total} ${t('tvJobs')}${counts ? ` · ${counts}` : ''}`;
        out.note = typeof data.note === 'string' && data.note ? data.note : null;
        out.facts = tvFactsFrom(args, null);
        return out;
      }
      /* 其它 ok 信封：摘要退化成一行，明细与原文仍可展开（不丢信息）。 */
      out.state = 'done';
      out.summary = tvEnvelopeSummary(data) || tvClip(tvFirstLine(text ?? ''), 160).text;
      out.note = typeof data.note === 'string' && data.note ? data.note : null;
      out.facts = tvFactsFrom(args, null);
      if (data.id != null && Array.isArray(data.lines)) out.tailHint = `${t('tvTailHint')} · id=${data.id}`;
      return out;
    };
    /** 键盘展开（Enter / Space）—— a11y：`role="button"` 的行必须能纯键盘操作。 */
    const tvOnKeyDown = (toggle) => (event) => {
      try {
        if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        toggle();
      } catch { /* 键盘交互异常不影响渲染 */ }
    };
    /** 状态胶囊的**类名白名单**（未知状态不拼进 class，避免脏类名/样式注入）。
     *  ⚠️ `TV_PILL` 已由上面的 `JOB_STATE_META` 派生（单一源）——这里不再有第二份字面量。 */
    const tvPillClass = (s) => (TV_PILL.includes(String(s)) ? String(s) : 'queued');
    /** 胶囊的悬停说明：有本地化词条的（paused）给中文，其余用协议里的原始状态词。 */
    const tvPillTitle = (s) => (String(s) === 'paused' ? t('paused') : String(s));
    /** 兜底渲染：一行纯文本（工具名 + 能拿到的 id）。**自身也不许抛**，故再包一层 try。 */
    const tvFallbackRow = (props) => {
      try {
        const p = props && typeof props === 'object' ? props : {};
        const name = typeof p.toolName === 'string' && p.toolName ? p.toolName : TOOLVIEW_KEY;
        const id = p.callId == null ? '' : String(p.callId);
        return h('div', { className: 'dsp-tv-card', 'data-tool': TOOLVIEW_KEY, 'data-state': 'fallback' },
          h('div', { className: 'dsp-tv-row' },
            h('span', { className: 'dsp-tv-title' }, t('tvTitle')),
            h('span', { className: 'dsp-tv-sep', 'aria-hidden': 'true' }),
            h('span', { className: 'dsp-tv-sum' }, id ? `${name} ${id}` : name)));
      } catch { return null; }
    };

    /**
     * `dispatch` 工具调用的行组件（注册进 `tool.call.toolview` + key=`dispatch`）。
     *
     * ⚠️ hooks **无条件**调用（顺序必须稳定）：展开态用组件自己的 `useState` ——
     * 宿主确实会传 `useDisclosure`，但它在第三方行组件契约里是**可选**的；
     * 「有就用、没有就退回 useState」会在它某次缺席时打断 hook 顺序 ⇒ React 自己抛错，
     * 与"绝不抛错"直接冲突。DSH 自带样例（ui-skill 的 SkillRow）用的也是自己的 useState。
     */
    function DispatchToolRow(props) {
      const [open, setOpen] = React.useState(false);
      const [argsOpen, setArgsOpen] = React.useState(false);
      const [outOpen, setOutOpen] = React.useState(false);
      const toggle = () => { setOpen((v) => !v); };
      try {
        const m = tvModel(props);
        /** 原文块：默认折叠；展开后限高滚动 + 截断提示（大 JSON 绝不整段铺开）。 */
        const rawBlock = (label, text, isOpen, setIt) => {
          if (!text) return null;
          const clip = tvClip(text, 6000);
          return h('div', null,
            h('button', {
              className: 'dsp-tv-rawbtn', type: 'button', 'aria-expanded': isOpen,
              onClick: () => setIt((v) => !v),
            }, `${isOpen ? t('tvRawClose') : t('tvRawOpen')} · ${label}`),
            isOpen
              ? h('pre', { className: 'dsp-tv-raw' },
                clip.text + (clip.truncated ? `\n${t('tvTruncatedA')}${clip.total}${t('tvTruncatedB')}` : ''))
              : null);
        };
        const rowKids = [
          h('span', { className: 'dsp-tv-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
          h('span', { className: 'dsp-tv-title' }, t('tvTitle')),
        ];
        if (m.phase === 'preparing') {
          rowKids.push(h('span', { className: 'dsp-tv-sum' }, t('tvPreparing')));
        } else {
          if (m.action) rowKids.push(h('span', { className: 'dsp-tv-sep', 'aria-hidden': 'true' }));
          if (m.action) rowKids.push(h('span', { className: 'dsp-tv-action' }, String(m.action)));
          if (m.tag) rowKids.push(h('span', { className: 'dsp-tv-tag', title: String(m.tag) }, `#${String(m.tag)}`));
          rowKids.push(h('span', { className: 'dsp-tv-sum', title: m.summary || undefined }, m.summary || ''));
          if (m.model) rowKids.push(h('span', { className: 'dsp-tv-meta', title: String(m.model) }, String(m.model)));
          if (m.elapsed) rowKids.push(h('span', { className: 'dsp-tv-meta' }, String(m.elapsed)));
          if (m.exit != null) rowKids.push(h('span', { className: 'dsp-tv-meta' }, `exit=${m.exit}`));
          rowKids.push(h('span', {
            className: `dsp-tv-pill s-${tvPillClass(m.state)}`,
            title: tvPillTitle(m.state),
          }, String(m.state)));
        }
        const jobs = Array.isArray(m.jobs) ? m.jobs : [];
        /* 展开区**只在真有内容时才渲染**（preparing 阶段没有可展开的东西 ⇒ 点了也不出一个空框）。 */
        const hasBody = !!(m.facts.length || jobs.length || m.errorText || m.note || m.tailHint || m.argsRaw || m.rawText);
        const body = open && hasBody
          ? h('div', { className: 'dsp-tv-body' },
            m.facts.map((f, i) => h('div', { className: 'dsp-tv-kv', key: `${f.k}-${i}` },
              h('span', { className: 'dsp-tv-kv-k' }, f.k),
              h('span', { className: 'dsp-tv-kv-v', title: f.v }, f.v))),
            jobs.length
              ? h('div', { className: 'dsp-tv-kv' },
                h('span', { className: 'dsp-tv-kv-k' }, t('secJobs')),
                h('span', { className: 'dsp-tv-kv-v' },
                  jobs.slice(0, 8).map((j) => tvBriefLine(j)).join(' · ')
                  + (jobs.length > 8 ? ` +${jobs.length - 8}` : '')))
              : null,
            m.errorText ? h('div', { className: 'dsp-tv-err' }, String(m.errorText)) : null,
            m.note ? h('div', { className: 'dsp-tv-note' }, String(m.note)) : null,
            m.tailHint ? h('div', { className: 'dsp-tv-note' }, String(m.tailHint)) : null,
            rawBlock(t('tvArgs'), m.argsRaw, argsOpen, setArgsOpen),
            rawBlock(t('tvResult'), m.rawText, outOpen, setOutOpen),
            !m.argsRaw && !m.rawText ? h('div', { className: 'dsp-tv-empty' }, t('tvEmpty')) : null)
          : null;
        return h('div', {
          className: 'dsp-tv-card', 'data-tool': TOOLVIEW_KEY, 'data-state': String(m.state),
        },
          h('div', {
            className: 'dsp-tv-row',
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open,
            'aria-label': `${t('tvTitle')}${m.action ? ` ${m.action}` : ''} ${m.state} · ${t('tvDetail')}`,
            onClick: toggle,
            onKeyDown: tvOnKeyDown(toggle),
          }, ...rowKids),
          body);
      } catch (e) {
        /* 任何解析/渲染异常都不许影响会话 ⇒ 退化成一行纯文本。 */
        return tvFallbackRow(props);
      }
    }

    return {
      // 只依赖宿主必定提供的**基础**服务。
      // ⚠️ 绝不能把自家的 `remote.dispatch` 写进 inject：该命名空间正是 apply() 里
      // $mount 才挂上的——声明它等于"等自己"，条目会永远 pending，导致 web boot 直接失败：
      //   web boot: 1 entry did not activate
      //   dsh-dispatch: pending (waiting for service: remote.dispatch)
      // 命名空间是否就绪改用子 fiber（ctx.inject）在 $mount 之后订阅。
      //
      // ⚠️ `typert` 是**必须**的（2026-09-30 现场定证，错误消息：
      //   `$mount 失败：cannot get property "typert" without inject`）：
      //   gateway 的 `$mount` 用 `const callerCtx = this.ctx` 取**调用方**的 ctx
      //   —— cordis `Service` 构造时注册 `tracker = { associate: name, property: 'ctx' }`，
      //   而 traceable 代理对 `prop === tracker.property` 直接返回调用方 ctx
      //   （refs/extracted/cordis/src/service.ts:42-58、utils.ts:165-176：
      //    `if (prop === tracker.property) return ctx`）。
      //   随后 `mountContribution(callerCtx, …)` 执行
      //   `callerCtx.typert.remotes.register(contribution)`
      //   （refs/extracted/dsh-api-gateway/lib/client.js:1662-1664）→ 缺 `typert` 即抛错。
      //   `typert` 由 @deepseek-ai/dsh-typert-registry 客户端半边提供（其自身 inject=[]，
      //   必定先于本条目就绪；gateway 自己也 inject ["typert","connection"]），故不阻塞启动。
      inject: ['slots', 'remote', 'typert'],
      apply(ctx) {
        // 整个 apply 兜底：任何异常都不许冒泡（冒泡 = 条目激活失败 = web boot 失败）。
        // 2026-09-30 曾因 inject 自声明 remote 命名空间导致启动死锁，此后按"启动绝不因插件失败"设防。
        try {
          MOD_CTX = ctx; // createWire 据此探测远端面；apply 未跑或无 remote 时走 ext/demo 降级
          // 第三方本地包不被构建期内联进 api-remotes 聚合，须在 apply 自挂 remote.dispatch
          // 子服务（同形调用见 extracted/dsh-api-remotes/lib/client.js:13505-13540）。$mount
          // 返回「命名空间就绪后可用的 disposer」，随客户端 ctx 生命周期存续；这里不持有它
          // （客户端模块表未给 apply 提供卸载通道），拒绝路径只留痕不白屏。
          try {
            const fn = ctx?.remote && ctx.remote.$mount;
            if (typeof fn === 'function') {
              MOUNT_DIAG.attempted = true;
              const mounted = fn.call(ctx.remote, REMOTE_CONTRIBUTION);
              if (mounted && typeof mounted.then === 'function') {
                mounted.then(
                  () => {
                    MOUNT_DIAG.ok = true; MOUNT_DIAG.error = null;
                    try { console.info('[dispatch] $mount 成功：remote.dispatch 已本地挂载'); } catch { /* ignore */ }
                  },
                  (e) => {
                    MOUNT_DIAG.ok = false; MOUNT_DIAG.error = (e && e.message) || String(e);
                    try { console.warn('[dispatch] $mount 失败：', MOUNT_DIAG.error); } catch { /* ignore */ }
                  },
                );
              }
            }
          } catch (e) {
            MOUNT_DIAG.attempted = true;
            MOUNT_DIAG.ok = false;
            MOUNT_DIAG.error = (e && e.message) || String(e);
          }
          // 配方步骤③：子 fiber 等 remote.dispatch 就绪（有序、且不阻塞条目激活）。
          // 命名空间缺席时该 fiber 只是 pending，不会让本条目失败——这是与顶层 inject 的关键区别。
          try {
            if (typeof ctx?.inject === 'function') {
              ctx.inject(['remote.dispatch'], (scope) => {
                try {
                  const svc = scope?.remote?.dispatch;
                  if (svc && typeof svc.snapshot === 'function') {
                    markRemoteReady(svc);
                    try { console.info('[dispatch] 子 fiber：remote.dispatch 就绪'); } catch { /* ignore */ }
                    // 依赖撤销时（命名空间退役）清掉缓存，避免拿着退役实例继续轮询。
                    if (scope && typeof scope.effect === 'function') {
                      scope.effect(() => () => { if (REMOTE_SVC === svc) REMOTE_SVC = null; }, 'dispatch.namespace');
                    }
                  }
                } catch { /* 就绪回调异常不影响条目 */ }
              });
            }
          } catch { /* 子 fiber 建立失败：仍可用 createWire 的即时探测兜底 */ }
          /* ZB-27b（用户现场：入口「字号不对 + 有背景色」）：样式必须在**入口出现之前**就注入。
           * 原先 ensureStyle() 只挂在弹窗的 effect 上 —— 弹窗要等用户点开才挂载，于是入口在首次
           * 点开前完全没有样式，用的是宿主 <button> 默认样式。
           * ZB-27u：这里注入的那一份**永不释放**（引用计数常驻 1）⇒ 只要插件激活，样式就不会被
           * 任何组件卸载带走（面板关闭时只释放它自己那份）。 */
          try { ensureStyle(); } catch { /* 样式注入失败不影响注册（PanelBody 里还会再试） */ }
          /* ZB-27（用户要求）：**只在会话标题行注册一个入口**，弹窗挂在它下面。
           * 原先那条注册到 shell.overlay 的右下角浮窗（id `dispatch.console`，order 20）
           * 与它的最小化胶囊一并取消 —— 两份 UI 会让"哪个才是派发台"变得含糊。
           * ZB-27o（用户要求「把派发台移到子智能体后面」）：order 10 → **-25**，插到
           * 子智能体目录(-30) 与智能体团队(-20) 之间 ⇒ 排布变为
           *   5 个子智能体 | DSH 派发台 | 智能体团队 | 创造模式 |（自带）后台任务(20) */
          /* ── ZB-60：入口注册的「主 → 备」**降级链**（兼容性加固，不是双 UI）──
           * 背景：`conversation.session.header.actions` 是派发台**唯一入口**，原先没有降级路径 ——
           * DSH 升级若把槽位改名/删除，注册会被静默挂起（`inject` 对未声明槽位是"等待"而非报错），
           * 整个面板就**彻底不可达**（比配置卡消失严重得多）。
           * 判定与顺序（严格"主优先、备兜底、不并存"）：
           *   ① 先按原样注册主槽位（行为完全不变，优先用它）；
           *   ② 主槽位 `inject` / `register` **抛错** ⇒ 立即退到 `shell.overlay`；
           *   ③ 主槽位**始终未声明**（inject 回调一直不跑 = 槽位不存在/改名）⇒ 宽限 SLOT_GRACE_MS
           *      后仍无回调就退到 `shell.overlay`；正常启动是毫秒级就绪，不会走到这里；
           *   ④ 两条都失败 ⇒ 只 `console.warn`（与配置卡同一纪律：UI 挂不上**绝不影响插件加载**）；
           *   ⑤ 若备用已启用、主槽位**事后**就绪 ⇒ 撤回备用，只保留主入口（绝不双份 UI）。
           * ⚠️ 降级**必须可观测**：warn 写明实际生效的槽位 —— 否则升级后我们会以为"入口还在"，
           *    其实它已经跑到右下角去了。`entryMode` 记录实际生效值（诊断/探针用）。
           * ⚠️ header-entry.test 的 F2 依赖下面这行**字面** `ctx.slots.inject(HEADER_SLOT` 且位于
           *    ensureStyle() 之后 —— 保持这一形状，别抽成模块级 helper。 */
          let entryMode = 'none';      // 'header' | 'overlay' | 'none'（实际生效的入口槽位）
          let graceTimer = null;
          let fallbackDispose = null;  // 备用注册的撤销函数（主槽位"迟到"时用来撤回，避免双 UI）
          const slotWarn = (msg, detail) => { try { console.warn(`[dispatch] ${msg}`, detail ?? ''); } catch { /* ignore */ } };
          const clearGrace = () => {
            if (graceTimer != null) { try { clearTimeout(graceTimer); } catch { /* ignore */ } graceTimer = null; }
          };
          /** 注册**备用浮层入口**（幂等：主入口已生效或备用已启用时不动）。 */
          const registerFallbackEntry = (reason) => {
            if (entryMode !== 'none') return false;
            try {
              ctx.slots.inject(FALLBACK_SLOT, () => {
                /* 主入口若已在此期间就绪 ⇒ 不再注册备用（防双 UI）。 */
                if (entryMode === 'header') return undefined;
                const dispose = ctx.slots.register({ name: FALLBACK_SLOT, id: 'dispatch', order: 20 },
                  () => h(HeaderOverlayEntry));
                fallbackDispose = typeof dispose === 'function' ? dispose : null;
                return dispose;
              });
              entryMode = 'overlay';
              slotWarn(`会话头槽位 ${HEADER_SLOT} 不可用（${reason}）⇒ 已降级到 ${FALLBACK_SLOT} 浮层入口（右下角；面板仍可用）。请检查 DSH 升级后该槽位是否改名/删除`);
              return true;
            } catch (e) {
              entryMode = 'none';
              slotWarn(`会话头槽位不可用且备用槽位 ${FALLBACK_SLOT} 也不可用 —— 派发台入口无法注册（插件仍加载；可用 Agent 工具 / CLI 派发入口）`, (e && e.message) || e);
              return false;
            }
          };
          /* ① + ②：主槽位（注册失败立刻降级；callback 内自己兜住，避免延迟注册时异常逃逸成未捕获错误） */
          try {
            ctx.slots.inject(HEADER_SLOT, () => {
              try {
                const dispose = ctx.slots.register({ name: HEADER_SLOT, id: 'dispatch', order: -25 },
                  () => h(HeaderEntry));
                entryMode = 'header';
                clearGrace();
                /* ⑤ 主槽位"迟到"：备用已启用 ⇒ 撤回备用（只保留会话头入口）。 */
                if (fallbackDispose) {
                  try { fallbackDispose(); } catch { /* ignore */ }
                  fallbackDispose = null;
                  slotWarn(`主槽位 ${HEADER_SLOT} 事后就绪 ⇒ 已撤回 ${FALLBACK_SLOT} 浮层入口（避免两份 UI）`);
                }
                return typeof dispose === 'function' ? dispose : undefined;
              } catch (e) {
                slotWarn(`会话头槽位 ${HEADER_SLOT} 注册抛错`, (e && e.message) || e);
                registerFallbackEntry('register 抛错');
                return undefined;
              }
            });
          } catch (e) {
            slotWarn(`会话头槽位 ${HEADER_SLOT} inject 抛错`, (e && e.message) || e);
            registerFallbackEntry('inject 抛错');
          }
          /* ③ 主槽位"未声明"兜底：`inject` 对未声明槽位是**静默等待**（不抛错）——
           * 用 `spec(key)`（槽位声明表的只读查询，renderer 的公共 API）能看出"现在还没声明"，
           * 但**不能**据此立刻降级：本插件的 apply 可能早于 conversation 包提交声明，
           * 立刻降级会在**正常启动**时误报"已降级"（随后又被迟到的主槽位撤回）—— 噪音且吓人。
           * 故统一走**宽限**：正常启动毫秒级就绪、定时器随即被清掉；只有升级改名才会走到超时降级。
           * 超时后再查一次声明表，把"为什么判定不可用"写进 warn（可观测）。 */
          if (entryMode === 'none') {
            let specQuery = null;
            try { specQuery = typeof ctx.slots.spec === 'function' ? (k) => ctx.slots.spec(k) : null; } catch { specQuery = null; }
            const safeSpec = (k) => { try { return specQuery ? specQuery(k) : undefined; } catch { return undefined; } };
            const mainSpec = specQuery ? safeSpec(HEADER_SLOT) : undefined;
            if (mainSpec !== undefined) {
              /* 声明表里已有主槽位 ⇒ inject 回调必然已跑/即将跑，不降级。 */
            } else {
              try {
                graceTimer = setTimeout(() => {
                  graceTimer = null;
                  if (entryMode !== 'none') return;
                  const stillMissing = safeSpec(HEADER_SLOT) === undefined;
                  const fbDeclared = safeSpec(FALLBACK_SLOT) !== undefined;
                  registerFallbackEntry(stillMissing && fbDeclared
                    ? `等待 ${SLOT_GRACE_MS}ms 仍未声明（声明表里没有该槽位，疑似升级后改名/删除）`
                    : `等待 ${SLOT_GRACE_MS}ms 仍未声明（槽位不存在或改名）`);
                }, SLOT_GRACE_MS);
                /* 插件卸载时清掉宽限定时器（注册失败/未就绪只留痕，不阻塞加载）。 */
                try {
                  if (typeof ctx.effect === 'function') ctx.effect(() => () => clearGrace(), 'dispatch.slot-grace');
                } catch { /* effect 不可用 ⇒ 定时器最多空跑一次 */ }
              } catch { /* 无 setTimeout（极简桩）：没有宽限能力，主槽位 inject 仍会补注册 */ }
            }
          }
          /* ZB-53（用户真机反馈「插件详情页没有配置区」）：在 **bundle 自己的配置槽位**注册一张配置卡。
           * 槽位契约：`plugins.bundle.config`（keyed / scope: root），按**包名**派发
           * ⇒ key 必须是 `dsh-dispatch`；priority 与本地参照插件（dsh-connect-zcode）一致取 30。
           * 详情页可能在任何时刻被渲染（host 未必就绪）⇒ 卡片内部一律走 `useWire()` 的降级链，
           * 这里的注册失败**只留痕**、绝不影响插件加载（与 apply 顶层"启动绝不因插件失败"同一纪律）。 */
          try {
            ctx.slots.inject(BUNDLE_CONFIG_SLOT, () => ctx.slots.register({
              name: BUNDLE_CONFIG_SLOT, key: BUNDLE_CONFIG_KEY, priority: 30,
            }, DispatchConfigCard));
          } catch (e) {
            try { console.warn('[dispatch] 插件详情页配置卡注册失败（仅影响详情页，不影响派发台）：', e && e.message); } catch { /* ignore */ }
          }
          /* ── D1：`dispatch` 工具调用的**会话内专属卡片**（DSH 0.2.1 的 keyed 槽位 `tool.call.toolview`）──
           * 为什么：通用卡片把工具结果 JSON 原样铺开（`action=list` 历史上 70KB+），读起来又长又难定位；
           * 命中 key=`dispatch` ⇒ **整条替换**通用卡片（未命中回落 fallback，故键写错只是"没生效"，不会白屏）。
           * ⚠️ 注册失败**只留痕**：卡片是体验增量，绝不能让插件加载/面板/工具受影响（与配置卡同一纪律）。
           * ⚠️ 位置固定：放在配置卡注册**之后**、`apply` 的 try 之内 —— header-entry.test 依赖会话头
           *    注册那段的字面形状与先后次序，别把这行挪到它前面。 */
          try {
            ctx.slots.inject(TOOLVIEW_SLOT, () => ctx.slots.register({
              name: TOOLVIEW_SLOT, key: TOOLVIEW_KEY,
            }, DispatchToolRow));
          } catch (e) {
            try { console.warn('[dispatch] 工具卡片注册失败（仅影响会话内卡片，不影响派发台与工具）：', e && e.message); } catch { /* ignore */ }
          }
        } catch (e) {
          try { console.warn('[dispatch] apply 降级（不阻塞启动）:', e && e.message); } catch { /* 连 console 都不可用就彻底静默 */ }
        }
      },
    };
  },
});
