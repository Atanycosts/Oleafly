# Agent 组件复用依据

范围：截至 2026-11-12 已完成的固定源码调查、隔离探针和工作副本/任务接入。以下版本是固定输入，
不代表今天的上游最新状态。当前产品能力见[状态页](status.md)，工作合同见[架构](architecture.md)。

## 已采用的底座

产品继续使用 Oleafly 自己的 ResearchTask、SQLite/TaskStore、Rust ACP client、
文件隔离、SharedDocument、应用服务和既有工具 host。Workbench 继续拥有领域数据。
没有引入 Orca、T3、Flock 或 Lody 的运行时、数据库或产品依赖。

DOCX 任务活动接入继续复用 EigenPal 活动会话、现有 TaskBridge/ApplicationTools、TaskStore 不可变 observation、
真实成员执行和 Workbench captured-bytes 保存。用户接受/保存与模型提出候选分别记录，不复制执行器或领域库，
也不把流式 token 当成已保存编辑。本轮没有新增外部依赖；新增的稀疏自增游标索引只引用现有事件，
解决任务删除后的行号复用，不存另一份正文或执行状态。

引用旧回答与当前评论分离、精确历史文件字节回读等合同受到上游研究启发，
实现落在已有 Rust 服务和存储中。机制借鉴、隔离探针和直接产品代码复用应分别描述。

2026-11-10 的职责匹配与候选规则晋升继续扩展同一 TaskStore、成员工作队列、provider-neutral 调用和
按需上下文准备。语义相关性由一次无工具模型调用提出，投递、来源核验与暂停恢复留在现有事务中。
此轮没有新增框架依赖或移植上游状态机；Flock 等项目仍是设计对照，不能将本轮实现称为直接接入它们。

同日的工具批次交接继续复用 Agent 工具流水线、TaskStore 的成员会话/工作/事件、既有串行调度与隔离副本。
新增的是批次完成回调和保留原工作的接续语义，没有引入新的框架、数据库表、消息中间件或依赖，
也没有在本轮直接移植上述上游代码。

逐项处理进一步在同一成员工作记录上保存摘要、结果引用和请求依赖，并复用现有工具批次边界结束执行段。
工作界面的原问题、历史消息和 PDF 结果使用已有 TaskStore 与应用预览入口。
这仍是 Oleafly 内部的窄扩展，没有增加框架依赖、第二套工作队列或上游状态机。

上下文研究选择的条件去重复用现有 GroupEvent、成员上下文投影和精确事件回读，
没有新增依赖或直接移植外部框架代码。MemGPT 的分层记忆与 Scientific Agent Skills 的按需加载是
相关研究对照，不是本轮实现的效果证据；论文、版本和未完成实验见
[本地研究稿源码](../research/context-intervention/main.tex)。文件证据预览方案未采用。

## 固定版本与取舍

普通聊天的论文全文读取复用现有 `oleafly-research` paper 服务、`PaperCache`、`TaskFiles` 和应用 PDF 文本桥，
解析与回看沿用已经锁定的 [Mozilla pdf.js v6.3.289](https://github.com/mozilla/pdf.js/tree/1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56)。
已回查该版本 [PDF 读取与 getTextContent API](https://github.com/mozilla/pdf.js/blob/1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56/src/display/api.js)，
直接使用现有 `pdfjs-dist` 依赖与 `PdfViewer`，没有引入另一套 PDF 解析器或 Agent 框架。
本地来源捕获和版本引用属于应用适配；pdf.js 的文本提取不证明论文主张或模型结论正确。

| 项目及固定版本 | 核对到的机制与边界 | Oleafly 的选择 |
| --- | --- | --- |
| [Orca](https://github.com/stablyai/orca/tree/fc8dcd65ebe7e8205bb885d733704e3ba7230820) | SQLite mailbox、consumer fencing、结构化操作回执；take/ACK 不等于工作完成。 | 本地消息/work 与中断重领已有实现。外部执行端出现实际缺口时再借对应 receipt/fencing 合同。 |
| [T3 Code](https://github.com/pingdotgg/t3code/tree/8e6a7323050ea8d2891f745f7e624e84f9fd8d9a) | EventSink/outbox、租约及恢复分类、上下文交接、引用材料与当前评论分离。 | 历史引用合同作窄适配；现有 TaskStore 已有本地事务与恢复，不再移植完整 EventSink。 |
| [Flock](https://github.com/whiteducksoftware/flock/tree/63ff5ab64220f63049dcc3c954f312e876d9b915) | 类型/标签订阅、JoinSpec；所查版本的消费去重不自动按对象新 version 重跑，启动不重放已有对象。 | 参考过滤与汇合，将规则表达为现有对象/版本查询，不引入 Python blackboard 或 scheduler。 |
| [Lody](https://github.com/LodyAI/Lody/tree/d1dec680adc1346574a87a1877a412f286b2d9ce) | 操作状态与未知结果处理，精确 old/new 字节、hash、只读回取和 path-head proof。 | 精确读取快照使用 TaskStore 窄实现；不引入 Node worker、第二数据库、完整 diff 链或 path-head proof。 |
| [Herdr](https://github.com/herdrdev/herdr/tree/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde) | 可编程 PTY/session、prompt/wait 和近期内存事件；未证明持久成员投递。 | 有终端托管缺口时再评估 adapter，不先重建 fleet UI。 |

固定源码入口：
[T3 EventSink](https://github.com/pingdotgg/t3code/blob/8e6a7323050ea8d2891f745f7e624e84f9fd8d9a/apps/server/src/orchestration-v2/EventSink.ts)、
[T3 引用](https://github.com/pingdotgg/t3code/blob/8e6a7323050ea8d2891f745f7e624e84f9fd8d9a/packages/shared/src/assistantCitations.ts)、
[Orca 投递](https://github.com/stablyai/orca/blob/fc8dcd65ebe7e8205bb885d733704e3ba7230820/src/main/runtime/orchestration/db/messages/role-mailbox-delivery.ts)、
[Flock JoinSpec](https://github.com/whiteducksoftware/flock/blob/63ff5ab64220f63049dcc3c954f312e876d9b915/src/flock/orchestrator/correlation_engine.py)、
[Lody 字节留存](https://github.com/LodyAI/Lody/tree/d1dec680adc1346574a87a1877a412f286b2d9ce/packages/turn-diff-store)。

所查 Orca 是 stablyai/orca，Flock 是 whiteducksoftware/flock；同名项目不能混用能力或许可结论。
上游来源、固定版本与已有归因继续保留，实际移植前按采用版本复核接口。

## DOCX 编辑与实时工作机制

2026-11-10 的调查分别核对编辑内核、宿主控制、保存及会话位置机制。
2026-11-11 已将 EigenPal 的公开 core/react/fonts 2.36.0 固定安装到应用，接入受管工作副本，
以 ONLYOFFICE、Collabora 作为完整 Office 内核对照。真实浏览器已验证即时页面、键盘输入、
一项流式建议、一次接受/撤销/重做及实际 DOCX 保存；英文和中文真实论文还完成了首屏 session、复杂对象拒绝、
编辑保存与重开往返。字体替代、固定度量和跨引擎分页差异仍使真实论文排版保真未获证明。
2026-11-13 的字体增量继续复用该内核公开 FontResolver、应用已有 fontdb/skrifa 和本机字体，
没有安装第二套编辑服务；Vite 开发预打包的相对字体 URL 已修正。运行与验收范围由当前状态页维护。
接入与扩展合同见[架构](architecture.md#docx-实时工作表面)，
当前运行结果见[状态页](status.md#docx-工作副本首个闭环2026-11-11)。

| 项目及固定输入 | 实际核对到的机制 | 取舍与未证明事项 |
| --- | --- | --- |
| [EigenPal DOCX Editor](https://github.com/eigenpal/docx-editor/tree/6eb82e66205208bd7ff94f27b7de3a5b1e6bc1c6)，`@docx-editor.dev/core@2.36.0` | Apache-2.0 core 的 automation host 提供文档 handle、expectedRevision、批量操作、变更订阅、DOCX 保存和带作者的替换修订。当前应用借用浏览器 host 读取/修改会话，使用 React 内公开实例的 `editor.save()` 导出实际字节。 | 已采用 core/react/fonts 构建首版工作副本。合成流程和英文、中文真实论文流程均覆盖局部人工干预、接受/撤销/重做、基线与检查；真实论文结构往返通过，字体、分页和 Office 往返保真仍未证明。 |
| [ONLYOFFICE sdkjs](https://github.com/ONLYOFFICE/sdkjs/tree/9d2138866d929be32f1d107e8b5bfae36156e097) | AGPLv3 源码中有 Search/Range.Select/InsertContent、ReplaceTextSmart、修订与 assistant 作者 API；官方 Docs API 有保存回调。 | 成熟 Office 内核候选。`createConnector` 官方限定 Developer 版，社区接入需插件或源码适配。选区、版本与任务定位须由集成验证；分组 API 的存在没有证明跨异步流的一次撤销。未启动 Docs Server/桌面版。 |
| [Collabora Online mirror](https://github.com/CollaboraOnline/online.mirror/tree/68215017b21f2579f107470964e3ef4eb6997594) | 宿主 postMessage 的 Send_UNO_Command 可驱动 UNO 操作；Action_Save 有 Notify/ExtendedData，另有 Action_Export 与保存响应路径。 | 另一完整 Office 内核候选，需接 WOPI/本地服务生命周期。命令投递与保存响应不能自行证明锚点有效、编辑版本一致或 Workbench 字节已留存；这些窄语义尚未集成验证。 |
| [SuperDoc](https://github.com/superdoc/docx-editor)，`superdoc@2.29.0` 的发布包 | 公开包元数据依赖 `@superdoc/docx-engine@0.28.0`；外层 AGPL 与该专有内核分开许可。 | 不能按“整套可修改的 AGPL 编辑内核”选型。其许可允许特定集成使用，同时限制内核研究/替代用途；本轮只查公开元数据和许可，未安装或运行内核，暂不作为首选。 |

EigenPal 的固定源码入口是 [protocol.ts](https://github.com/eigenpal/docx-editor/blob/6eb82e66205208bd7ff94f27b7de3a5b1e6bc1c6/packages/core/src/automation/protocol.ts)、
[host.ts](https://github.com/eigenpal/docx-editor/blob/6eb82e66205208bd7ff94f27b7de3a5b1e6bc1c6/packages/core/src/automation/host.ts) 和
[server-host.ts](https://github.com/eigenpal/docx-editor/blob/6eb82e66205208bd7ff94f27b7de3a5b1e6bc1c6/packages/core/src/automation/server-host.ts)。
合同将一个 batch 定义为一次事务、数字 revision 和撤销单位；本轮实测两个替换在一个 batch 中
只推进一个数字 revision 并发一次变更事件；连续三次累计替换各推进一个 revision 并发一次事件，
不能据此声称 token 流天然属于一次撤销。
server host 拥有字节并能 save；当前安装版本的 browser host 也公开保存入口，但应用选择编辑器拥有的异步
`editor.save()`，以纳入待完成输入并取得明确字节。2026-11-10 源码调查中的 browser-save 限制是当时固定输入的结论，
不再代表当前安装 API。
引擎内数字 revision、OOXML 修订标记和 Workbench baseline 是三种身份。
公开 [core 包](https://www.npmjs.com/package/@docx-editor.dev/core/v/2.36.0) 的探针锁文件保留实际依赖与完整 integrity，
应用依赖与完整 integrity 现由根 `pnpm-lock.yaml` 拥有。[Pro 许可](https://github.com/eigenpal/docx-editor/blob/6eb82e66205208bd7ff94f27b7de3a5b1e6bc1c6/packages/pro/LICENSE.md)
与 core 区分，不把未启用的 Pro 模块算作探针成果。

HarfBuzz 初始化的 top-level await 复用 `vite-plugin-top-level-await@1.6.0`，保留原有 WebView 构建目标。
其与 SWC 1.16 AST 的已知兼容问题按[上游 issue #79](https://github.com/Menci/vite-plugin-top-level-await/issues/79)
在该依赖路径锁定 SWC 1.15.47。构建适配保留合法注释并恢复 UTF-8/Terser 压缩，
同时禁用 SWC 自身的压缩打印，以免破坏 JSON 中的 LaTeX 反斜杠转义；独立构建用例实际导入产物并核对文本。
编辑内核按需加载；包体积与启动图检查仍执行。上游 core/react/fonts 的许可和字体归因由
[`scripts/sync-docx-notices.mjs`](../../scripts/sync-docx-notices.mjs)从安装包原文同步至应用资源，
`--check` 核对一致性。

当前 npm `core@2.36.0` 发布元数据的 gitHead 是
[`86869eedede5b793c910be804db6280b036b0b50`](https://github.com/eigenpal/docx-editor/tree/86869eedede5b793c910be804db6280b036b0b50)；
上表 `6eb82e…` 保留最初选型调查输入，不代替这个发布包的源码身份。
字体组合复用公开 `defineFontResolver`／`useFonts`；实际族、字重、style 和 hash 对应本机字节，
显式 CJK 替代不冒充宋体／黑体原字体。接口与限制见[架构](architecture.md#当前接入范围2026-11-11)。
同一发布源码的 [`semantic-layout.ts`](https://github.com/eigenpal/docx-editor/blob/86869eedede5b793c910be804db6280b036b0b50/packages/core/src/layout/semantic-layout.ts#L831)
只在单栏节启用段落 frame；
[`section-preparation.test.ts`](https://github.com/eigenpal/docx-editor/blob/86869eedede5b793c910be804db6280b036b0b50/packages/core/src/layout/__tests__/section-preparation.test.ts#L128)
明确断言双栏 frame 缺失。英文原稿首页在双栏节内用 468 pt 页锚定标题框，
因此当前内核把它按普通栏宽排版。已有排除区域绑定一个 columnIndex，不能只删除单栏条件就声称支持跨栏避让。
这不是 DOCX 导出丢失样式的证据；本轮未修改作者 XML 或维护内核补丁。

ONLYOFFICE 的 [plugin bridge](https://github.com/ONLYOFFICE/sdkjs/blob/9d2138866d929be32f1d107e8b5bfae36156e097/common/plugins/plugin_base_api.js)
注明：online coediting 的 callCommand/Document Builder 限于创建并 InsertContent，桌面本地文件不受同一限制。
[ReplaceTextSmart](https://github.com/ONLYOFFICE/sdkjs/blob/9d2138866d929be32f1d107e8b5bfae36156e097/common/apiBase_plugins.js)
依赖当前选区，[SearchAndReplace](https://github.com/ONLYOFFICE/sdkjs/blob/9d2138866d929be32f1d107e8b5bfae36156e097/word/api_plugins.js)
会替换全部匹配；两者都不能当成已定位并核对版本的段落事务。
[SetAssistantTrackRevisions](https://github.com/ONLYOFFICE/sdkjs/blob/9d2138866d929be32f1d107e8b5bfae36156e097/word/apiBuilder.js)
暂存全局作者状态，不证明长异步生成期间用户输入与多任务归因隔离。
所查 [apiBase.js](https://github.com/ONLYOFFICE/sdkjs/blob/9d2138866d929be32f1d107e8b5bfae36156e097/common/apiBase.js)
的 group-actions 基类只是事件/空实现；尚未找到 Word 覆写足以证明分组撤销，需实际部署验证。

官方 [ONLYOFFICE 保存回调](https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/)
区分 status 2 的待存储文件、编辑中 force-save 的 6 和失败 3/7。集成方仍须下载回调 URL、留存实际字节，
存储成功后才返回成功；onDocumentStateChange 变 false 只说明变更已送到编辑服务。
users 的最后编辑者不是逐事务作者，userdata 关联请求也不替代会话修订校验。
[Connector 的版本限制](https://api.onlyoffice.com/docs/docs-api/usage-api/methods/#createconnector)另有明确说明。
Collabora 的具体控制路径见固定 [Map.WOPI.js](https://github.com/CollaboraOnline/online.mirror/blob/68215017b21f2579f107470964e3ef4eb6997594/browser/src/map/handler/Map.WOPI.js)。
另有 [ChildSession.cpp](https://github.com/CollaboraOnline/online.mirror/blob/68215017b21f2579f107470964e3ef4eb6997594/kit/ChildSession.cpp)
中的结构提取/变换与结果回执，值得作为成熟内核的后续探针；text 提取读取内存，其他过滤器仍可能重读磁盘。
所查 [ClientSession.cpp](https://github.com/CollaboraOnline/online.mirror/blob/68215017b21f2579f107470964e3ef4eb6997594/wsd/ClientSession.cpp)
的结果消费主要服务内部 AI/转换通道，未证明标准 WOPI 宿主可直接调用同一结构事务。
原 `CollaboraOnline/online` 仓已转到 Gerrit/mirror，不能只查部署仓就判定控制源码不存在。
SuperDoc 的 [2.29.0 发布元数据](https://registry.npmjs.org/superdoc/2.29.0)与
[0.28.0 内核许可](https://unpkg.com/@superdoc/docx-engine@0.28.0/DOCX-ENGINE-LICENSE.md)是该取舍的实际依据，
不能把它概括为“所有使用都必须付费”。

会话位置与事务机制另参考三个成熟先例，不因此替换现有 Loro/OT：

- [ProseMirror transform 1.10.5](https://github.com/ProseMirror/prosemirror-transform/blob/1.10.5/src/map.ts)
  用 Mapping/mapResult 表达移动与删除，Step.map 可返回 null。适合参考建议跟随及明确失效，
  不提供独立 DOCX 重导入后的身份对应或 Word 排版。
- [Yjs v13.6.27 RelativePosition](https://github.com/yjs/yjs/blob/v13.6.27/src/utils/RelativePosition.js)
  关联 CRDT item/方向，不能解析时返回 null；[UndoManager](https://github.com/yjs/yjs/blob/v13.6.27/src/utils/UndoManager.js)
  的 trackedOrigins/stopCapturing 给出按来源、按编辑动作撤销的机制对照。需要同一 CRDT 历史，不能靠普通 DOCX 重存恢复。
- [LSP 3.17 TextDocumentEdit](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/types/textDocumentEdit.md)
  把编辑绑定输入版本，[applyEdit](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/workspace/applyEdit.md)
  分开应用与失败回执；applied 不代表磁盘保存，跨文件失败处理也依客户端能力。

完成快照的 PDF 转换已采用 [LibreOffice 无界面/转换参数](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)，并保留
[Gotenberg v8.0.0 的 LibreOffice route](https://github.com/gotenberg/gotenberg/blob/v8.0.0/pkg/modules/libreoffice/routes.go) 作为后续服务化对照。
Oleafly 当前在 Workbench 内按每次转换创建临时 profile，检查输出页数并登记 derived PDF；它属于保存后的渲染链，不能替代交互编辑内核。
WPS 的既有导出可继续作为外部引擎来源，新的转换结果须按实际引擎登记，不能套用历史 WPS 过程证明。

## 证据范围

隔离探针验证了部分源码函数、协议和失败语义，使用合成输入；它们不能代替产品集成、
真实模型推理或等预算收益比较。产品运行、失败和修复范围由[状态页](status.md#已交付与验收范围)维护。

设计材料按问题归入上述三类现行文档：目标合同进[架构](architecture.md)，已实现与验收进
[状态页](status.md)，固定版本的上游选择留在本页。运行日志、探针源码和逐轮调查只作为本地历史证据，
不再各建一份实施入口。

本机保留的 `.private/upstream-reuse/` 包含固定源码和探针结果；
其中 `docx-live-research-20261110/` 保留本轮合成脚本、锁文件、输出及必要源码摘录，
区分无界面引擎实测、源码调查与未运行的交互验收。
`.private/agent-documentation-history/agent-evidence-and-reuse-20261109.md`
保留更完整的调查、其他框架对照及原始证据定位。这些本地材料不随干净 checkout 提供。
后续研究在对应选择发生变化时更新本页，不为每轮调查新增综合报告。
