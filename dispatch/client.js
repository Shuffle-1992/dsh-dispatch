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
     * shell.overlay 已从客户端 bundle 实证存在（详见 refs/dsh-slots.md）：
     * 声明于 dsh-client-ui-layout 的 root children 表 { kind:'list', scope:'root' }，
     * 由 AppFrame 渲染进专用 overlayLayer 图层；chat / plugin-manager / workspace
     * 三个官方包共 6 处先例都注册在此（list 型 → 注册必须带 id，order 参与排序）。 */
    const SLOT = 'shell.overlay';
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

    /* ZB-27：入口改为「点开即弹窗」后，ZB-24 那份**模块级共享状态 store 已不需要** ——
     * 弹窗内容（PanelBody）自己持 wire 并渲染实时数据，入口只是个开合开关（局部 useState）。
     * 原 store 的用途是"让另一个渲染器零网络成本显示计数徽标"，现在没有第二个渲染器了。 */

    const LS = {
      pos: 'dispatch:panel:pos:v1', // 悬浮位置 {left, top}
      size: 'dispatch:panel:size:v1', // 宽度 {width}
      collapsed: 'dispatch:panel:collapsed:v1', // 折叠态 true/false
      pinned: 'dispatch:panel:pinned:v1', // ZB-08：固定（锁定位置，禁止拖动）true/false
    };
    /* Z11：分区折叠——id 常量集中一处（勿散落魔法字符串），折叠态存
     * localStorage['dispatch:section:<id>']（复用 loadJson/saveJson，自带 try/catch）。 */
    const SEC = { channel: 'channel', dispatch: 'dispatch', jobs: 'jobs', quota: 'quota', locks: 'locks' };
    const secKey = (id) => `dispatch:section:${id}`;
    // 默认展开/收起：通道与派发收起（少滚动）；进程与用量展开（主信息）；单写者收起
    const SEC_DEFAULT_OPEN = { [SEC.channel]: false, [SEC.jobs]: true, [SEC.quota]: true, [SEC.locks]: false }; // ZB-29c：派发分区已移除
    // z-index 仅约束浮层自身的层级（不写全局样式、不碰宿主 DOM），取固定较大值避免被页面浮层盖住
    const Z_INDEX = 2000000000;
    const WIDTH = { min: 320, max: 600, def: 440 };
    /* ZB-06：面板高度可调 + 持久化。未设置时 height=null → CSS 走 auto + max-height:min(72vh,560px)
     * （与旧行为完全一致，不改变老用户的观感）；一旦用户拖过就把高度固定，由 .dsp-body 内部滚动。
     * 上限随视口收敛，避免把面板拖到屏幕外。 */
    const HEIGHT = { min: 160 };
    const maxPanelHeight = () => {
      const vh = (typeof window !== 'undefined' && Number(window.innerHeight)) || 900;
      return Math.max(HEIGHT.min, Math.min(1200, vh - 80));
    };
    const clampHeight = (n) => Math.min(maxPanelHeight(), Math.max(HEIGHT.min, Math.round(Number(n) || HEIGHT.min)));
    /* ZB-07：进程分组内默认只展开最近 N 条 —— 进程累计上限是 1000 条（JOBS_FILE_CAP），
     * 全量渲染会让面板变成一条几百行的长列表。其余折进「还有 N 条更早的」按钮。 */
    const JOB_GROUP_PREVIEW = 5;
    const EDGE = 8; // 拖拽时与视口边缘的最小间距

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
      /* ZB-29b（用户要求）：进程名左对齐（margin-right:auto 把右侧徽标群推到行尾）；下行整体右对齐。 */
      '.dsp-job-line .dsp-job-tag{margin-right:auto;}',
      '.dsp-job-line2{justify-content:flex-end;}',
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
        collapse: '折叠 / 展开', minimize: '最小化为胶囊', restore: '展开派发台', grip: '拖拽调整宽高（自动保存）',
        pillRunning: '运行中', pillQueued: '排队中', pillIdle: '空闲',
        pin: '固定位置（固定后不可拖动）', unpin: '取消固定（恢复可拖动）',
        secDispatch: '派发', secJobs: '进程', secQuota: '用量', secLocks: '仓库文件锁',
        noFileLocks: '（当前没有文件锁：任务未声明 write，走仓库整锁）',
        kind: '类型', kindPrompt: '提示词', kindTask: '任务文件', kindTarget: '目标',
        phPrompt: '输入要发给 ZCode 的提示词…', phTask: '任务文件绝对路径…', phTarget: '要达成的目标…',
        model: '模型', provider: '通道', providerPlan: '套餐', providerPersonal: '个人 Key',
        mode: '模式', timeout: '超时(分)', bench: '--memory-bench',
        thinking: '思考强度', thinkingAgent: 'Agent决定（按任务判断）', thinkingAgentShort: 'Agent决定',
        thinkDisabled: '关闭思考', thinkEnabled: '开启思考', thinkLow: '低强度', thinkHigh: '高强度', thinkMax: '最高强度',
        thinkingFollow: '跟随通道', dispatchThinkingHint: '跟随通道=按通道设置的思考强度派发（在「通道」分区设置）；具体档位=本条派发严格生效（仅新建会话）',
        chanThinkingHint: '通道默认思考强度：Agent决定=由派发方 Agent 按任务自行改传具体档位；具体档位=给派发 Agent 的硬性规定（未显式指定的派发一律按它执行，仅新建会话生效）',
        thinkingHint: 'Agent决定=由派发方按任务判断并改传具体档位；具体档位严格生效（仅新建会话；--resume 沿用原会话档位）',
        thinkingStale: '已失效', thinkingStaleHint: '该档位不在当前模型声明的取值里（可能因模型档位表更新而失效）——派发会被 runner 拒绝，请改选一个有效档位',
        dispatch: '派发', queuedBtn: '排队中…', runningBtn: '执行中…', sending: '提交中…',
        fbQueued: '已排队：', errPrefix: '失败：', errEmpty: '请先填写内容',
        content: '内容', noJobs: '暂无进程记录', exit: '退出', kill: '终止', tail: '输出', tailLoading: '读取中…', tailEmpty: '（无输出）',
        closeJob: '关闭', cwd: '工作目录', createdAt: '创建于', sessionId: '会话',
        grpActive: '进行中', grpPaused: '需处理', grpFailed: '异常', grpDone: '已完成', grpOther: '其他',
        jobMore: '还有', jobMoreN: '条更早的', jobCollapse: '收起',
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
        repoLock: '仓库锁', memoryLock: 'Zcode 记忆锁', queueLen: '队列', idle: '空闲', lockHeld: '持有仓库锁',
        repoLockCb: '仓库文件锁', writePh: '要写的文件（逗号或换行分隔；留空=锁整个仓库）', writeHint: '只锁这些文件 ⇒ 与写其它文件的任务可并发执行',
        writeFiles: '要写入的文件列表', lockNoneHint: '不取锁（确认无竞写关系时才用）',
        lockScopeHint: '只锁上面列出的文件；留空则锁整个仓库（与其它任务互斥）',
        secChannel: '通道', chanNewTask: '新任务将使用：', chanDisabled: '不可用', chanLoadFail: '通道清单加载失败',
        giftQuota: '免费额度剩余', giftQuotaUnavailable: '免费额度余量不可用', chanQuotaExhausted: '5 小时窗口已满',
        jobCurrent: '当前：', jobLastBeat: '最近心跳', jobStalled: '可能卡住',
        jobStalledHint: '超过 150 秒没有收到 runner 的心跳/输出：可能卡在上游请求、MCP 连接或等锁。可用「终止」后重派，或 action=tail 看最后输出。',
        chanOfflineHint: '未连接宿主：通道/模型来自宿主远端面，连接后这两个下拉才可选',
        chanDefaultModel: '（通道默认模型）',
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
        collapse: 'Collapse / Expand', minimize: 'Minimize to pill', restore: 'Restore console', grip: 'Drag to resize (saved automatically)',
        pillRunning: 'running', pillQueued: 'queued', pillIdle: 'idle',
        pin: 'Pin position (no dragging while pinned)', unpin: 'Unpin (allow dragging again)',
        secDispatch: 'Dispatch', secJobs: 'Processes', secQuota: 'Usage', secLocks: 'Repo file locks',
        noFileLocks: '(no file locks: jobs did not declare write, using whole-repo lock)',
        kind: 'Kind', kindPrompt: 'Prompt', kindTask: 'Task file', kindTarget: 'Target',
        phPrompt: 'Prompt to send to ZCode…', phTask: 'Absolute path of task file…', phTarget: 'Goal to achieve…',
        model: 'Model', provider: 'Channel', providerPlan: 'Plan', providerPersonal: 'Personal key',
        mode: 'Mode', timeout: 'Timeout (min)', bench: '--memory-bench',
        thinking: 'Thinking', thinkingAgent: 'Agent decides (per task)', thinkingAgentShort: 'Agent decides',
        thinkDisabled: 'Thinking off', thinkEnabled: 'Thinking on', thinkLow: 'Low effort', thinkHigh: 'High effort', thinkMax: 'Max effort',
        thinkingFollow: 'Follow channel', dispatchThinkingHint: "Follow channel = dispatch with the channel's thinking setting (set in the Channels section); a concrete level is enforced for this dispatch (new sessions only)",
        chanThinkingHint: 'Channel default thinking: Agent decides = the dispatching agent picks a concrete level per task; a concrete level is a hard rule for dispatched agents (dispatches without an explicit level follow it; new sessions only)',
        thinkingHint: 'Agent decides = the dispatching agent picks a concrete level per task; a concrete level is enforced (new sessions only; --resume keeps the session level)',
        thinkingStale: 'stale', thinkingStaleHint: 'This level is not in the current model declaration (the model level table may have changed) — dispatch would be rejected by the runner; pick a valid level',
        dispatch: 'Dispatch', queuedBtn: 'Queued…', runningBtn: 'Running…', sending: 'Sending…',
        fbQueued: 'Queued: ', errPrefix: 'Failed: ', errEmpty: 'Content is required',
        content: 'Content', noJobs: 'No process records yet', exit: 'exit', kill: 'Kill', tail: 'Tail', tailLoading: 'Loading…', tailEmpty: '(no output)',
        closeJob: 'Close', cwd: 'Workdir', createdAt: 'Created', sessionId: 'Session',
        grpActive: 'Running', grpPaused: 'Needs action', grpFailed: 'Failed', grpDone: 'Completed', grpOther: 'Other',
        jobMore: 'Show', jobMoreN: 'older', jobCollapse: 'Collapse',
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
        repoLock: 'Repo lock', memoryLock: 'Zcode memory lock', queueLen: 'queue', idle: 'idle', lockHeld: 'holds the repo lock',
        repoLockCb: 'Repo file lock', writePh: 'files to write (comma/newline separated; empty = whole repo)', writeHint: 'locks only these files, so tasks writing other files can run in parallel',
        writeFiles: 'files to write', lockNoneHint: 'no lock (only when no write conflict is possible)',
        lockScopeHint: 'locks only the files listed above; empty locks the whole repo (exclusive)',
        secChannel: 'Channels', chanNewTask: 'New tasks will use: ', chanDisabled: 'unavailable', chanLoadFail: 'Failed to load channels',
        giftQuota: 'Free quota left', giftQuotaUnavailable: 'Free-quota balance unavailable', chanQuotaExhausted: '5h window full',
        jobCurrent: 'Now: ', jobLastBeat: 'last heartbeat', jobStalled: 'possibly stuck',
        jobStalledHint: 'No runner heartbeat/output for over 150s: it may be stuck on an upstream request, MCP connect or a lock. Kill and re-dispatch, or use action=tail for the last output.',
        chanOfflineHint: 'Host not connected: channel/model come from the host Remote face and unlock once connected',
        chanDefaultModel: '(channel default model)',
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
    const clampWidth = (n) => Math.min(WIDTH.max, Math.max(WIDTH.min, Number(n) || WIDTH.def));
    /* ZB-07：把保存的悬浮位置钳进当前视口（纯函数，便于独立测试）。
     * 为什么需要：localStorage 里的位置可能是脏值 —— 早期版本存的负数/越界值，
     * 或者存完之后用户把窗口缩小了。沿用脏值会让整个面板跑到屏幕外、彻底点不到。
     * 约束：left/top 都至少留 EDGE；上界为「视口 - 面板尺寸 - EDGE」，且不小于 EDGE
     * （面板比视口还大时退化为 EDGE，保证左上角可见而不是负数）。
     * @param {{left:number, top:number}|null} p
     * @param {{vw:number, vh:number, w:number, h:number}} view
     * @returns {{left:number, top:number}|null} null = 没存过位置（调用方走默认右下角）
     */
    /* ZB-11：浮动位置改为**锚定语义**（纯函数，便于独立测试）。
     *
     * 起因（用户报告）：「DSH 全屏时把派发台固定在右上角 → 缩到默认大小 → 派发台被挤到
     * 中间对话上面 → 再全屏，它仍留在中间」。
     *
     * 根因（★ 这正是 ZB-10「钳制」引入的反效果）：位置只存绝对 {left, top}。
     * 窗口缩小时钳制会把坐标**改写**进 pos 并落盘（left 被拉到视口内 ⇒ 落到中间）；
     * 再放大时钳制只保证"不越界"，**不会**把它还原回右上角 ⇒ 用户的意图被永久破坏。
     *
     * 正解：记住面板**贴的是哪条边**与**该方向的边距**，位置由「边距 + 当前视口」推导：
     *   贴右 ⇒ left = vw - w - rx   贴下 ⇒ top = vh - h - by
     *   贴左 ⇒ left = lx            贴上 ⇒ top = ty
     * 于是缩小窗口时它贴着右边一起收（仍在右上角），放大时自然回到右上角。
     * 四条边距在拖拽/固定时一次记录齐全，只有被锚定的那一对参与推导。
     *
     * @param {{left:number, top:number}} rect 面板当前矩形左上角
     * @param {{vw:number, vh:number, w:number, h:number}} view
     * @returns {{ax:'left'|'right', ay:'top'|'bottom', lx:number, ty:number, rx:number, by:number, left:number, top:number}}
     */
    function anchorOf(rect, view) {
      const vw = (view && view.vw) || 0, vh = (view && view.vh) || 0;
      const w = (view && view.w) || 0, h = (view && view.h) || 0;
      const left = Number(rect && rect.left) || 0;
      const top = Number(rect && rect.top) || 0;
      return {
        /* 面板中心落在视口哪一半 ⇒ 贴哪条边。
         * 用"中心过半"而不是"距边多近"：用户把面板放在右上角时中心在上半+右半，判定稳定；
         * 也天然覆盖"面板比视口还大"的退化情形（此时中心仍在某一半）。 */
        ax: left + w / 2 <= vw / 2 ? 'left' : 'right',
        ay: top + h / 2 <= vh / 2 ? 'top' : 'bottom',
        lx: left,
        ty: top,
        rx: Math.max(0, vw - left - w),
        by: Math.max(0, vh - top - h),
        left,
        top,
      };
    }

    /** 由锚定信息 + 当前视口推导实际位置；仍过一遍 clampPos 作安全网（绝不跑到视口外）。
     *  旧格式（只有 {left, top}，无 ax/ay）按"贴左+贴上"处理 —— 与旧行为一致，向后兼容。 */
    function resolvePos(p, view) {
      if (!p || typeof p !== 'object') return null;
      const vw = (view && view.vw) || 0, vh = (view && view.vh) || 0;
      const w = (view && view.w) || 0, h = (view && view.h) || 0;
      if (!vw || !vh) {
        // 拿不到视口尺寸时不猜，用记录里的绝对坐标
        return Number.isFinite(Number(p.left)) && Number.isFinite(Number(p.top))
          ? { left: Number(p.left), top: Number(p.top) }
          : null;
      }
      const left = p.ax === 'right' ? vw - w - (Number(p.rx) || 0) : (Number.isFinite(Number(p.lx)) ? Number(p.lx) : Number(p.left) || 0);
      const top = p.ay === 'bottom' ? vh - h - (Number(p.by) || 0) : (Number.isFinite(Number(p.ty)) ? Number(p.ty) : Number(p.top) || 0);
      return clampPos({ left, top }, view); // 安全网：贴边距若因面板变大而越界，仍钳回视口内
    }

    function clampPos(p, view) {
      if (!p || typeof p !== 'object') return null;
      const left = Number(p.left), top = Number(p.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
      const vw = (view && view.vw) || 0, vh = (view && view.vh) || 0;
      const w = (view && view.w) || 0, h = (view && view.h) || 0;
      if (!vw || !vh) return { left, top }; // 拿不到视口尺寸时不猜，原样返回
      return {
        left: Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - w - EDGE)),
        top: Math.min(Math.max(EDGE, top), Math.max(EDGE, vh - h - EDGE)),
      };
    }
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
      const tick = async () => {
        try {
          const snapshot = await remote.call('snapshot');
          let quota = null;
          try {
            quota = (await remote.call('quota'))?.quota ?? null;
          } catch { /* 用量失败不挡快照 */ }
          emit({ conn: 'live', snapshot, quota, planQuota });
        } catch (e) {
          // 远端抖动：发一包空快照让 UI 渲染空态，绝不抛出、绝不白屏
          emit({ conn: 'live', snapshot: null, quota: null, planQuota, error: e?.message ?? String(e) });
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
            return { ok: true, channels: r?.channels ?? [], warnings: r?.warnings ?? [] };
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
        channels: async () => ({ ok: true, channels: [], warnings: [] }),
        channelGet: denied,
        channelSet: denied,
        fallbackGet: denied,
        fallbackSet: denied,
        // Z12：offline 无真值可读（浏览器也读不到宿主文件），动作拒绝 → UI 只读 + 提示走终端
        switchGet: denied,
        switchSet: denied,
        dispose() {
          subs.clear();
        },
      };
    }

    // 内置演示引擎（conn='demo'，默认关）：3 个进程起步；派发 / kill / dismiss / tail 均可交互（纯前端假数据）
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
      const demoChannels = [
        { id: 'plan', name: '默认套餐（自动选择）', enabled: true, reason: null, endpoint: 'https://open.bigmodel.cn/api/anthropic', models: ['GLM-5.3', 'GLM-5.3-Flash'] },
        { id: 'personal', name: '个人 API（演示）', enabled: true, reason: null, endpoint: 'https://demo.example/v1', models: ['deepseek-flash'] },
        { id: 'builtin:bigmodel-start-plan', name: 'BigModel Start Plan（演示）', enabled: false, reason: 'coding_plan_not_entitled', endpoint: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic', models: ['GLM-5.3', 'GLM-5.3-Flash'] },
        { id: 'builtin:zai-coding-plan', name: 'Z.ai Coding Plan（演示）', enabled: false, reason: 'oauth_provider_inactive', endpoint: 'https://api.z.ai/api/anthropic', models: ['GLM-5.3', 'GLM-5.3-Flash'] },
      ];
      let demoChannel = { provider: 'plan', model: 'GLM-5.3-Flash' };
      let demoTargets = []; // ZB-30：demo 降级目标（[{provider, model, reasoningLevel}]）
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
          return { ok: true, channels: demoChannels.map((c) => ({ ...c, models: [...c.models] })), warnings: [] };
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
        // Z12：demo 不读/写真值文件（假数据不伪装开关状态，更不许写真值）
        async switchGet() {
          return { ok: false, error: '演示模式无真值文件（demo）' };
        },
        async switchSet() {
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
        switchGet: wire.switchGet, switchSet: wire.switchSet,
      };
    }

    const PAUSE_LABEL_KEY = { 'quota-exhausted': 'pQuota', 'plan-not-entitled': 'pEntitled', 'provider-signing': 'pSigning', 'config-error': 'pConfig' };
    const pauseLabel = (r) => t(PAUSE_LABEL_KEY[r] ?? 'pUnknown');
    /* ZB-29e（用户要求）：思考强度档位**中文显示** —— 值与传输一律用原始字符串（disabled/enabled/
     * low/high/max），只在显示层映射中文标签；未知档位（上游新增）原样显示，绝不隐藏、不猜语义。 */
    const THINKING_LABEL_KEY = { disabled: 'thinkDisabled', enabled: 'thinkEnabled', low: 'thinkLow', high: 'thinkHigh', max: 'thinkMax' };
    const thinkingLabel = (lv) => (lv == null || lv === '' ? '' : t(THINKING_LABEL_KEY[lv] ?? '') || lv);
    /* ZB-30：降级**目标**归一（与 core/dispatch-core.mjs 的 normFallbackTargets 同语义）。
     * 接受字符串（旧 chain 项）/ 对象（{provider|id|channel, model?, reasoningLevel?|thinking?}）；
     * 无 provider 的项丢弃（不猜），顺序保留。null 字段 = 沿用原任务该维度。 */
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
    /* ZB-02：「关闭」（= 从列表移除 + 落盘 dismissed.json）允许的状态集合，
     * 与宿主 wire.host.mjs 的 DISMISSABLE 逐一对应（paused / 各终态）。
     * 原先 UI 只在 paused 时渲染关闭按钮 → done/failed/killed/interrupted 的 job
     * 既没有终止按钮（非 active）也没有关闭按钮，列表里清不掉。 */
    const DISMISSABLE_STATES = ['paused', 'done', 'failed', 'killed', 'interrupted'];

    function StatusDot({ state }) {
      const cls = ['queued', 'running', 'done', 'failed', 'killed', 'interrupted', 'paused'].includes(state) ? state : 'idle';
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
    function IconMinus() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true },
        h('path', { d: 'M2.5 6 H9.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }));
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
    /* ZB-11：右下角缩放三角标（贴角实心三角，只用 currentColor + opacity，无字面色值）。 */
    function IconResizeMark() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true },
        h('path', { d: 'M11.5 4.2 L11.5 11.5 L4.2 11.5 Z', fill: 'currentColor', opacity: '0.55' }));
    }
    /* ZB-08：固定/取消固定（图钉）。on=true 用实心填充表示"已钉住"，on=false 空心。
     * 填充值只用 currentColor / none 两个关键字，不引入字面色值。 */
    function IconPin({ on }) {
      return h('svg', { width: 11, height: 11, viewBox: '0 0 12 12', 'aria-hidden': true },
        h('path', {
          d: 'M4.2 1.2 H7.8 L7.1 4 L8.9 5.8 V6.6 H3.1 V5.8 L4.9 4 Z',
          fill: on ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linejoin': 'round',
        }),
        h('path', { d: 'M6 6.6 V10.6', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round' }));
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

    /* 通道分区：切换器（provider+model+思考强度，不可用项置灰带原因）+ 自动降级开关。
     * ZB-30（用户要求）：「自动降级」改成**开关**（参考派发总开关：点击开/关、带指示灯），
     * 打开后下面才显示 通道 / 模型 / 思考强度 三个下拉（与上面「通道」分区同形）；关闭时不显示。
     * 目标为空的两维（模型、思考强度）语义是「沿用原任务」，故首项标签不是「Agent决定」
     * （降级是自动触发的，此刻并没有 Agent 在决定——与 ZB-29c 移除派发栏 Agent决定同一条理由）。 */
    function ChannelSection({ channelsInfo, channel, fallback, onSwitch, onFallbackSet, offline, offlineReason, sw }) {
      const [fbFeedback, setFbFeedback] = useState(null);
      const [busy, setBusy] = useState(false);
      const channels = channelsInfo?.channels ?? [];
      const warnings = channelsInfo?.warnings ?? [];
      const sel = channels.find((c) => c.id === channel.provider) ?? null;
      const models = sel && Array.isArray(sel.models) ? sel.models : [];
      const modelValue = channel.model ?? '';
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
        const c = channels.find((x) => x.id === id);
        if (!c || !c.enabled) return; // 不可用项不允许选中（option 已 disabled）
        onSwitch({ provider: id, model: c.models && c.models.length ? c.models[0] : null });
      };
      const switchModel = (m) => onSwitch({ provider: channel.provider, model: m || null });

      const modelOptions = models.length
        ? models
        : (modelValue ? [modelValue] : []); // 通道没给模型表时至少显示当前值

      /* ── ZB-33b（用户要求）：**通道下拉只列可用通道**（「自动降级」目标下拉同样） ──
       * 例外：**当前选中值**若已掉线（历史存值指向一个不可用通道），仍把它单独列在最前并标注
       * 「不可用：原因」—— 否则 `<select value>` 匹配不到 option，浏览器会显示首项，
       * 与真实存值不符（与 ZB-31 的"失效档位要显式列出"同一个坑）。 */
      const usableChannels = channels.filter((c) => c.enabled);
      const channelOptionsFor = (current) => {
        const list = usableChannels.some((c) => c.id === current)
          ? usableChannels
          : [
            ...(current
              ? [{ id: current, name: current, enabled: false, reason: channels.find((c) => c.id === current)?.reason ?? '-' }]
              : []),
            ...usableChannels,
          ];
        return list.map((c) =>
          h('option', { key: c.id, value: c.id, ...(c.enabled ? {} : { disabled: true }) },
            `${c.name ?? c.id}${c.enabled ? '' : `（${t('chanDisabled')}：${c.reason ?? '-'}）`}` +
              `${c.recentQuotaExhausted ? `（${t('chanQuotaExhausted')}）` : ''}`),
        );
      };

      /* 降级目标（单目标；core 仍支持多目标列表供 CLI 使用）。targets[0] 为准，旧 chain 兜底。 */
      const fbEnabled = !!fallback?.enabled;
      const fbTarget = fallback?.target ?? null;
      const fbProvider = fbTarget?.provider ?? '';
      const fbSel = channels.find((c) => c.id === fbProvider) ?? null;
      const fbModels = fbSel && Array.isArray(fbSel.models) ? fbSel.models : (fbTarget?.model ? [fbTarget.model] : []);
      const fbLevels = Array.isArray(fbSel?.thinkingLevels) ? fbSel.thinkingLevels : [];
      const fbModel = fbTarget?.model ?? '';
      /* ZB-30b（用户要求「不要沿用原任务，就跟上面完全一致的选项逻辑」）：降级目标的模型/思考强度
       * 用与上面「通道」分区**逐字相同**的选项集与默认值 —— 模型首项 `（通道默认模型）`（值 ''）、
       * 思考强度首项 `Agent决定（按任务判断）`（值 'agent'）。语义也随之对齐：
       *   · model='' ⇒ 不传 --model（用该 provider 的默认模型，= 上面的「通道默认模型」）
       *   · reasoningLevel='agent' ⇒ runner 按 ZCode 默认规则解析（模型声明档位的最后一档），
       *     与上面「Agent决定」在未显式指定档位时走的是同一条规则（仅新建会话生效）。
       * 注：core/CLI 侧的 `null` 仍表示"沿用原任务"（旧调用方兼容），面板不再产生 null。 */
      const fbThinking = fbTarget?.reasoningLevel ?? 'agent';

      /** 写降级目标（对象 ⇒ 开启；null ⇒ 关闭）。乐观回显交给 PanelBody 的权威值校正。
       * ⚠️ 面板里**显示什么就写什么**（与上面「通道」分区同一纪律）：
       *   · model: ''（通道默认模型）⇒ 写 `null` ⇒ 交接时不传 `--model`（= 该 provider 默认模型）
       *   · reasoningLevel: 显示值（未设时 `'agent'`）⇒ 原样写。**不保留** CLI/工具设的
       *     `null`（沿用原任务）—— 否则用户只改模型也会把下拉显示的「Agent决定」与实际存值
       *     弄成两回事（显示 Agent决定、实际沿用原任务）。一次面板编辑即归一成面板语义。 */
      const saveTarget = (patch) => {
        const next = {
          provider: fbProvider || channel.provider || 'plan',
          model: fbModel || null,
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
        const c = channels.find((x) => x.id === id);
        if (!c || !c.enabled) return;
        /* 换通道 ⇒ 模型/档位回到「通道默认模型 / Agent决定」（与上面切 provider 的行为同形）。 */
        saveTarget({ provider: id, model: null, reasoningLevel: 'agent' });
      };
      const fbSwitchModel = (m) => saveTarget({ model: m || null });
      const fbSwitchThinking = (lv) => saveTarget({ reasoningLevel: lv || 'agent' });
      const fbUnknown = fbEnabled && fbProvider && !channels.some((c) => c.id === fbProvider);

      return h('div', { className: 'dsp-stack' },
        /* ZB-42（用户现场报告）：总开关关闭时**必须在通道分区里明说**。
         * 此前只有标题栏一个小徽标（「派发：关」），而 ZB-33 把闸门提到 runner 最前时
         * 连只读探测也挡住了 ⇒ 用户看到的是「通道清单加载失败」+ 空列表，**误判成插件坏了**。
         * 现在：runner 放行探测（通道照常列出），这里再点明"冻结≠故障"。
         * 复用既有 locale 键 switchOffBlocked（此前只在工具描述里用过，面板从未渲染）⇒ 不新增文案键。 */
        sw && sw.enabled === false
          ? h('div', { className: 'dsp-note', role: 'status', title: t('switchOffBlocked') }, t('switchOffBlocked'))
          : null,
        warnings.length ? h('div', { className: 'dsp-feedback dsp-err' }, `${t('chanLoadFail')}: ${warnings[0]}`) : null,
        /* ZB-01 ③：离线态的说明统一由面板 body 首行渲染（此处曾重复渲染同一句，已去重）；
         * 两个下拉仍各自带 title，便于悬停即知为什么点不动。
         * ZB-14：改成**固定两行**（每行 = 标签 + 下拉），不再把 4 个元素塞进一个 flex-wrap 行 ——
         * 原先面板一变宽就重排换行、两个下拉宽度还各随内容变（用户报告「随窗口尺寸乱跑」）。
         * 现在：标签 nowrap 定自然宽、下拉 flex:1 等宽撑满 ⇒ 任意面板宽度下版式都一致。 */
        h('div', { className: 'dsp-field' },
          h('span', { className: 'dsp-field-k' }, t('provider')),
          h('select', {
            className: 'dsp-select dsp-field-v', value: channel.provider,
            onChange: (e) => switchProvider(e.target.value), 'aria-label': t('provider'),
            disabled: channels.length === 0,
            title: offline ? (offlineReason || t('chanOfflineHint')) : undefined,
          },
            channelOptionsFor(channel.provider))),
        h('div', { className: 'dsp-field' },
          h('span', { className: 'dsp-field-k' }, t('model')),
          h('select', {
            className: 'dsp-select dsp-field-v', value: modelValue,
            onChange: (e) => switchModel(e.target.value), 'aria-label': t('model'),
            disabled: !sel || !sel.enabled,
            title: offline ? (offlineReason || t('chanOfflineHint')) : undefined,
          },
            h('option', { value: '' }, t('chanDefaultModel')),
            modelOptions.map((m) => h('option', { key: m, value: m }, m)))),
        /* ZB-29d：通道默认思考强度——**这才是给派发 Agent 的规定**：
         * 'Agent决定'=派发方 Agent 按任务自行改传具体档位；具体档位=未显式指定的派发一律按它执行。
         * ⚠️ core 的 `thinkingLevels` 是**数组**（该通道各模型档位集的并集），不是 map ——
         * 曾误当 map 取值（lvMap[model]）导致下拉只剩「Agent决定」（现场 bug，测试已钉住形状契约）。 */
        (() => {
          const levels = Array.isArray(sel?.thinkingLevels) ? sel.thinkingLevels : [];
          const cur = channel.reasoningLevel ?? 'agent';
          /* ZB-31：**失效档位必须显式列出**。修复探测匹配式后，某些"修复前存下的"档位
           * （如 GLM-5.3 的 `disabled`，旧探测误判为合法）已不在当前 levels 里；若不列出，
           * `<select value="disabled">` 找不到匹配 option ⇒ 浏览器显示首项「Agent决定」，
           * 与真实存值不符（且派发会被 runner fail-fast 拒绝）。故显式补一项并标注「已失效」，
           * 让用户看到真相并主动改选。 */
          const stale = cur !== 'agent' && !levels.includes(cur);
          return h('div', { className: 'dsp-field' },
            h('span', { className: 'dsp-field-k' }, t('thinking')),
            h('select', {
              className: 'dsp-select dsp-field-v', value: cur,
              onChange: (e) => onSwitch({ provider: channel.provider, model: channel.model ?? null, reasoningLevel: e.target.value }),
              'aria-label': t('thinking'), title: stale ? t('thinkingStaleHint') : t('chanThinkingHint'),
              disabled: channels.length === 0 || !sel || !sel.enabled,
            },
              h('option', { value: 'agent' }, t('thinkingAgent')),
              stale ? h('option', { value: cur }, `${thinkingLabel(cur)}（${t('thinkingStale')}）`) : null,
              levels.map((lv) => h('option', { key: lv, value: lv }, thinkingLabel(lv)))));
        })(),
        h('div', { className: 'dsp-note', role: 'status' },
          `${t('chanNewTask')}${channel.provider}/${channel.model || t('chanDefaultModel')} · ${t('thinking')}: ${channel.reasoningLevel === 'agent' || !channel.reasoningLevel ? t('thinkingAgentShort') : thinkingLabel(channel.reasoningLevel)}`),
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
              `${fbProvider}${fbModel ? `/${fbModel}` : ''} · ${fbThinking === 'agent' || !fbThinking ? t('thinkingAgentShort') : thinkingLabel(fbThinking)}`)
            : null),
        /* 关闭时不显示下面的选择项（用户要求：关闭不显示）。
         * ZB-30b：三个下拉与上面「通道」分区**完全一致的选项逻辑** —— 同样的首项
         * （`（通道默认模型）` / `Agent决定（按任务判断）`）、同样的档位并集、同样的禁用判据。 */
        fbEnabled ? h('div', { className: 'dsp-stack' },
          h('div', { className: 'dsp-field' },
            h('span', { className: 'dsp-field-k' }, t('provider')),
            h('select', {
              className: 'dsp-select dsp-field-v', value: fbProvider,
              onChange: (e) => fbSwitchProvider(e.target.value), 'aria-label': `${t('fallbackTitle')}-${t('provider')}`,
              disabled: busy || channels.length === 0,
            },
              channelOptionsFor(fbProvider))),
          h('div', { className: 'dsp-field' },
            h('span', { className: 'dsp-field-k' }, t('model')),
            h('select', {
              className: 'dsp-select dsp-field-v', value: fbModel,
              onChange: (e) => fbSwitchModel(e.target.value), 'aria-label': `${t('fallbackTitle')}-${t('model')}`,
              disabled: busy || !fbSel || !fbSel.enabled,
            },
              h('option', { value: '' }, t('chanDefaultModel')),
              fbModels.map((m) => h('option', { key: m, value: m }, m)))),
          h('div', { className: 'dsp-field' },
            h('span', { className: 'dsp-field-k' }, t('thinking')),
            h('select', {
              className: 'dsp-select dsp-field-v', value: fbThinking,
              onChange: (e) => fbSwitchThinking(e.target.value), 'aria-label': `${t('fallbackTitle')}-${t('thinking')}`,
              disabled: busy || channels.length === 0 || !fbSel || !fbSel.enabled,
            },
              h('option', { value: 'agent' }, t('thinkingAgent')),
              /* ZB-31：与「通道」分区同一条纪律 —— 失效档位显式列出（见上面注释）。 */
              fbThinking !== 'agent' && !fbLevels.includes(fbThinking)
                ? h('option', { value: fbThinking }, `${thinkingLabel(fbThinking)}（${t('thinkingStale')}）`)
                : null,
              fbLevels.map((lv) => h('option', { key: lv, value: lv }, thinkingLabel(lv))))),
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
          /* ZB-29b（用户要求）：行头改**两行布局** ——
           * 上行 = 状态灯 + 进程名 + 模型 + 思考强度 + （paused/接续/跳数徽标）+ 文件锁；
           * 下行 = 时间 + 上下文 + 退出。两行各自 flex、可换行，行头整体仍是一键开合（role=button 不变）。 */
          h('div', { className: 'dsp-job-line' },
            h(StatusDot, { state: job.state }),
            h('span', { className: 'dsp-job-tag', title: job.id }, job.tag ?? shortId(job.id)),
            h('span', { className: 'dsp-badge' }, job.model ?? '—'),
            /* ZB-29：思考强度徽标紧跟模型——显示**实际生效档位**（含 Agent决定档的解析结果）；
             * 无法确定（旧 runner / --resume / 模型未声明）时隐藏，不伪造。 */
            (() => {
              const shown = thinkingShown(job);
              return shown ? h('span', {
                className: 'dsp-badge', title: `${t('thinking')}：${thinkingLabel(shown)}（${shown}）`,
              }, thinkingLabel(shown)) : null;
            })(),
            paused ? h('span', { className: 'dsp-badge s-paused', title: job.pauseDetail ?? '' }, `${t('paused')}：${pauseLabel(job.pauseReason)}`) : null,
            job.parentJobId ? h('span', { className: 'dsp-badge', title: job.parentJobId }, `${t('parentFrom')} ${shortId(job.parentJobId)}`) : null,
            (job.hopCount ?? 0) > 0 ? h('span', { className: 'dsp-badge' }, `${job.hopCount} ${t('hop')}`) : null,
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
          ),
          h('div', { className: 'dsp-job-line dsp-job-line2' },
            h('span', { className: 'dsp-dim' }, fmtSec(job.elapsedSec)),
            h('span', { className: 'dsp-dim', title: `${job.contextUsed ?? '—'} / ${job.contextWindow ?? '—'} tokens` }, ctxLabel(job)),
            job.exitCode != null ? h('span', { className: 'dsp-dim' }, `${t('exit')} ${job.exitCode}`) : null,
          ),
          /* ZB-40（用户要求「能看出进程确实在工作还是可能卡住」）：运行中显示**当前阶段/最近工具/心跳**，
           * 超过 150s 无心跳 → 红色「可能卡住」徽标。数据来自 runner 每 10s 的 progress 心跳行。 */
          job.state === 'running' && (job.progress || job.stalled)
            ? h('div', { className: 'dsp-dim', style: { fontSize: '11px', marginTop: '2px' } },
              h('span', { style: job.stalled ? { color: T.danger } : undefined },
                `${t('jobCurrent')}${job.progress
                  ? `${job.progress.stage ?? '?'}` +
                    `${job.progress.lastTool ? ` · ${job.progress.lastTool}` : ''}` +
                    `${Number.isFinite(job.progress.chars) && job.progress.chars > 0 ? ` · ${job.progress.chars} 字` : ''}` +
                    `${Number.isFinite(job.progress.tools) && job.progress.tools > 0 ? ` · 工具 ${job.progress.tools} 次` : ''}`
                  : '—（尚无心跳）'}`),
              job.stalled
                ? h('span', { className: 'dsp-badge', title: t('jobStalledHint'), style: { color: T.danger } }, ` ${t('jobStalled')}`)
                : h('span', null, ` ｜ ${t('jobLastBeat')} ${job.lastProgressAgoSec ?? '?'}s`),
            )
            : null,
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
     * 分组表是**唯一真值**（要调分组只改这张表）。状态名取自 core 的 job.state。
     * 两条纪律：
     *  1) 空分组不渲染 —— 所以分组可以取细，不会占版面；
     *  2) **未归属状态兜底**（grpOther）—— 绝不能因为「新状态没进分组表」就让 job 在列表里凭空消失。 */
    const JOB_GROUPS = [
      { key: 'grpActive', states: ['queued', 'running'] },              // 进行中（含排队）
      { key: 'grpPaused', states: ['paused'] },                        // 需处理：暂停等你决定续跑/交接
      { key: 'grpFailed', states: ['failed', 'interrupted', 'killed'] }, // 异常：非成功终态
      { key: 'grpDone', states: ['done'] },                            // 已完成
    ];

    function JobList({ snapshot, onKill, onDismiss, onTail, onRetry, onContinue, channels, refreshKey, offline }) {
      /* ZB-07：分组内展开状态（按分组 key）。会话内记忆即可 —— 刷新后回到「只看最近 N 条」，
       * 这个默认方向是安全的（永远只会少显示，不会漏掉最新）。 */
      const [expandedGroups, setExpandedGroups] = useState({});
      /* ZB-09：Tab 分页。userTab=null 表示「跟随第一个非空分组」—— 面板刚挂载时快照还没到，
       * 无法在初始化时定 tab，故用 null 表示未选择，每次渲染按当前数据推导；
       * 用户点过某个 tab 后就固定用它（即使那个 tab 为空，也如实显示空态，不偷偷跳走）。 */
      const [userTab, setUserTab] = useState(null);
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
            onClick: () => setUserTab(g.key),
          },
            h('span', null, t(g.key)),
            h('span', { className: 'dsp-tab-n' }, String(g.items.length))))),
        newestFirst.length === 0
          ? h('div', { className: 'dsp-empty' }, offline ? t('emptyOffline') : t('noJobs'))
          : h('div', { className: 'dsp-group-body' },
            shown.map((j) => h(JobRow, { key: j.id, job: j, onKill, onDismiss, onTail, onRetry, onContinue, channels, refreshKey })),
            hidden > 0
              ? h('button', {
                className: 'dsp-btn2', style: { alignSelf: 'flex-start' },
                onClick: () => setExpandedGroups((p) => ({ ...p, [active.key]: true })),
              }, `${t('jobMore')} ${hidden} ${t('jobMoreN')}`)
              : null,
            open && newestFirst.length > JOB_GROUP_PREVIEW
              ? h('button', {
                className: 'dsp-btn2', style: { alignSelf: 'flex-start' },
                onClick: () => setExpandedGroups((p) => ({ ...p, [active.key]: false })),
              }, t('jobCollapse'))
              : null));
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
    function HeaderEntry() {
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
        clearTimers();
        if (open) return;
        openTimer.current = setTimeout(() => { openTimer.current = null; setOpen(true); }, 150);
      };
      const scheduleClose = () => {
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
        try {
          const el = rootRef.current;
          if (!el || typeof el.getBoundingClientRect !== 'function' || typeof window === 'undefined') return;
          const r = el.getBoundingClientRect();
          const over = (r.left + WIDTH.def + 16) - (window.innerWidth || 0);
          setMenuShift(over > 0 ? -Math.ceil(over) : 0);
        } catch { /* 测量失败则不动（CSS 的 max-width 仍会收敛） */ }
      }, [open]);

      /* ZB-27l：**悬浮展开 / 离开即关**的挂点放在外层容器上 ——
       * 弹窗是容器的子节点，所以"从入口移进弹窗"不会触发 mouseleave（指针仍在子树内）；
       * 只有真正离开「入口 + 弹窗」整体才关。焦点同理（onBlur 的 relatedTarget 仍在子树内则忽略）。 */
      return h('div', {
        className: 'dsp-entry',
        ref: rootRef,
        /* ZB-27n：容器**只管开合、不设 hover** —— 面板是容器的子节点，指针从外面移到**面板**上时
         * 容器的 onMouseEnter 同样会触发；若在这里 setHover(true)，指针明明在面板上、入口的字却亮了
         * （用户截图 1 的现象）。hover 只由按钮自身的 enter/leave 驱动，才等价于官方 .trigger:hover。 */
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
      const [channelsInfo, setChannelsInfo] = useState({ channels: [], warnings: [] });
      const [channel, setChannelState] = useState({ provider: 'plan', model: 'GLM-5.3-Flash' });
      const [fallback, setFallbackState] = useState({ enabled: false, chain: [], targets: [], target: null });
      useEffect(() => {
        let alive = true;
        Promise.resolve(channels()).then((r) => {
          if (alive && r && r.ok) setChannelsInfo({ channels: r.channels ?? [], warnings: r.warnings ?? [] });
        });
        Promise.resolve(channelGet()).then((r) => {
          if (alive && r && r.ok && r.channel && r.channel.provider) setChannelState(r.channel);
        });
        Promise.resolve(fallbackGet()).then((r) => {
          if (alive && r && r.ok) setFallbackState({ enabled: !!r.enabled, chain: r.chain ?? [], targets: r.targets ?? [], target: r.target ?? null });
        });
        return () => {
          alive = false;
        };
      }, [channels, channelGet, fallbackGet]);

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

      const cssVars = {
        '--dsp-bg': T.bg, '--dsp-bgBar': T.bgBar, '--dsp-sunken': T.sunken, '--dsp-hover': T.hover,
        '--dsp-accent': T.accent, '--dsp-onAccent': T.onAccent, '--dsp-border': T.border, '--dsp-shadow': T.shadow,
        '--dsp-text': T.text, '--dsp-text2': T.text2, '--dsp-text3': T.text3, '--dsp-danger': T.danger, '--dsp-mono': T.mono,
        '--dsp-st-queued': T.stQueued, '--dsp-st-running': T.stRunning, '--dsp-st-done': T.stDone,
        '--dsp-st-failed': T.stFailed, '--dsp-st-killed': T.stKilled, '--dsp-st-interrupted': T.stInterrupted,
        '--dsp-st-idle': T.stIdle,
      };

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
            h(ChannelSection, { channelsInfo, channel, fallback, onSwitch, onFallbackSet, offline: conn !== 'live', offlineReason, sw: dispatchSwitch })),
          /* ZB-29c（用户要求）：**派发分区已移除**——无需手动派发，有需要让 Agent 通过
           * dispatch 工具代劳。当前顺序：通道 → 用量 → 进程 → 单写者/文件锁。
           * 分区 id 不变 ⇒ 各自展开状态与持久化键不受影响。 */
          h(Section, { id: SEC.quota, title: t('secQuota'), collapsible: true },
            h(QuotaCards, { quota, planQuota })),
          h(Section, { id: SEC.jobs, title: t('secJobs'), collapsible: true },
            h(JobList, { snapshot, onKill, onDismiss, onTail: tail, onRetry, onContinue, channels: channelsInfo.channels, refreshKey: (snapshot && snapshot.generatedAt) || '', offline: conn === 'offline' })),
          /* ZB-09：单写者/文件锁紧跟在进程列表之后（排查并发问题时与进程对照着看更顺）。 */
          h(Section, { id: SEC.locks, title: t('secLocks'), collapsible: true },
            h(LockStatus, { snapshot })),
        ),
      );
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
          ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({ name: HEADER_SLOT, id: 'dispatch', order: -25 },
            () => h(HeaderEntry)));
        } catch (e) {
          try { console.warn('[dispatch] apply 降级（不阻塞启动）:', e && e.message); } catch { /* 连 console 都不可用就彻底静默 */ }
        }
      },
    };
  },
});
