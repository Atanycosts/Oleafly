# Oleafly、Super-agent 与科研工作台：深度摸排（2026-11-02 frozen）

> 文档状态：冻结的历史调研与设计输入；不构成当前架构入口、融合版发布或验收声明。
> 调研日期：2026-11-02（Asia/Shanghai）。
> 使用范围：个人本地科研工作台；本轮交付为 Markdown 研究文档，不实施产品融合。
> 后续入口：当前跨系统信息见 [Oleafly integration](../../../docs/research-workbench-integration.md)、
> [Agent status](../../../docs/agent/status.md) 和
> [Agent architecture](../../../docs/agent/architecture.md)。本文与
> [2026-11-05 融合设计](fused-research-agent-architecture.md)均冻结为历史输入。
> 2026-11-04 勘误：修正 Phase 0 源路径报错的归因；后续真实任务和 MCP 0.4.0 历史证据保留在本地历史
> 报告中，当前 Agent 与 MCP 状态以 `docs/agent/status.md` 和现行合同为准。

## 1. 要回答的问题

这份文档不是把三个项目的 README 拼接起来，而是回答：Oleafly 已经解决了什么；DeepSeek Super-agent 新增了哪些真正有价值的机制；我们原项目哪些能力值得保留、哪些尚未成立；三者如何形成一个可用且可维护的科研产品。

产品方向是以 Oleafly 为唯一主应用，复用其编辑、编译、项目及 Agent 基础设施，把我们的差异化集中在科研文件可靠读取、来源与版本、检查适用性和可追溯接力。是否引入 Super-agent 的代码或领域机制，必须由具体工作流缺口决定，不能以“多一个总控层”作为前提。

本轮不修改作者原稿，不安装或启动无人值守 Agent，不调用付费模型，不推送仓库；既有开发改动和历史证据保持原样。

## 2. 证据等级与基线

| 标记 | 含义 | 不代表什么 |
| --- | --- | --- |
| SRC | 已在固定版本源码/合同中核实 | 不等于该宿主上的端到端运行通过 |
| RUN | 本轮实际运行并保留输出 | 结论只覆盖注明的路径、输入和环境 |
| HIST | 既有报告中的历史执行记录 | 不冒充本轮重跑，也不覆盖新版与新宿主 |
| PLAN | 产品需求或本报告的设计建议 | 不列为已经实现的能力 |
| OPEN | 缺少证据、尚需决策或验证 | 不用默认值、模型推断或测试数量补齐 |

| 对象 | 固定版本 | 本轮确认 |
| --- | --- | --- |
| Oleafly 本地与上游 main | `1b6521943ea567a4e5df02c99a588b4e49737623` | 2026-11-02 GitHub API 与本地 Git 一致 |
| Oleafly 官方发布预览 | `v0.4.9`，发布于 2026-11-01 17:00:25 UTC | 是官方应用，不是本地源码构建或融合版 |
| DeepSeek Super-agent prototype | `6337fc823ce20251c8de8085948165c81aaa701e` | 2026-11-02 GitHub API 与调研克隆一致 |
| research-file-workbench | `8b229c9ae59a76035b90a8b0221ec535abb9842d` + 已有文档改动 | 冻结需求 v1.3 与当前实现分别读取 |

历史本地路径：调研时 Oleafly 位于原 checkout 的 `../Oleafly`；Super-agent 调研副本位于
`var/integration-research/dsh-superagent-prototype`；本报告当时位于原研究核心仓库的 `docs/`。
独立审查与本轮运行证据现保留为本地历史材料，位于
`.private/workspace-consolidation-20261109/workbench-original-source/reports/integration-investigation/`，
不属于公开 clean checkout。

### 2.1 调研方法与复核范围

三名子 Agent 分别形成 Oleafly、Super-agent、研究核心专项报告；主审复核关键调用链、当前合同、版本、历史实物和本轮测试输出，再作产品取舍。子 Agent 的一致意见不是独立正确性的证明；可核查源码、实际记录和反证实验才是决策依据。

- Oleafly 源码与架构报告（本地历史证据）：调度、runtime、隔离、恢复、apply、工具与证据诊断。
- Super-agent 源码报告（本地历史证据）：领域模型、授权、执行、副作用、恢复与采用路线。
- 研究核心源码与证据报告（本地历史证据）：需求/实现区分、MCP、版本与当时证据纠偏。
- 固定版本与文件哈希、本轮验证清单（本地历史证据）：可复查基线与实际命令。

以上文件均在上文所述
`.private/workspace-consolidation-20261109/workbench-original-source/reports/integration-investigation/`
历史目录中；本报告冻结时不改写其内容，也不把它们当作当前实现或 clean checkout 文件。

上游 main 与发布版本通过 GitHub API 核验；核心结论固定到提交，而不是持续漂移的 main。随后一次重复查询 Super-agent 的网络请求超时，没有据此推定新版本或覆盖此前成功核验结果。Oleafly 与 Super-agent 未安装项目依赖、未构建、未执行上游测试；本轮运行证据集中于现有研究核心。

交付前已同步修订[当前状态说明](s1-progress.md)，纠正空标注及 Mac 渲染链的旧描述，并写入本轮验证范围；既有历史报告、原始标注和冻结证据未改。架构与证据子审对主文终审均未发现阻断性问题；这项文档复核不是产品端到端验收。

### 2.2 阅读导航

产品决策先读第 3、7、8、12 节；研发接入读第 9—11、13—15 节；核对事实读第 4—6、16、18 节及三份专项报告。本报告中的“建议”“拟议”“阶段”均是 PLAN，不混入 SRC/RUN。

## 3. 执行结论

**推荐形态：Oleafly 做唯一主应用和执行底座；保留我们的科研文件与证据核心；先借鉴 Super-agent 的持续委托机制，再按实测缺口决定是否移植代码。**

这不是三个产品并排摆放，也不是以 Super-agent 替换所有现有任务逻辑。真正的差异化是：不同执行器都能拿到正确版本的科研材料，知道自己读到了哪里、结论基于什么、什么时候失效，且不会把任务结束当作科研验收。

### 3.1 保留、修正与撤回

| 判断 | 当前结论 | 原因 |
| --- | --- | --- |
| Oleafly 作为主应用 | 保留 | 编辑、编译、项目、供应商、ACP、任务和审阅应用均已有实现，不值得另造 |
| 直接工作/助手协作/任务委托 | 保留为用户交互入口 | 第三种入口并非融合新增，Oleafly 已有对话创建研究任务 |
| 再加一层 Super-agent 总控 | 撤回为既定架构 | 双方都拥有启动、并发、取消、恢复和工作状态，直接叠加造成双主 |
| 一个任务状态是全部权威 | 修正 | 每种事实唯一权威，不是全部事实只有一个状态字段 |
| 任意 API/CLI 无缝接力 | 撤回为能力承诺 | 恢复、工具、费用、审批、取消和子任务能力依运行端而异 |
| 当前标注仍为空、Mac 页级链尚无结果 | 纠正 | 已有 80/80 Agent 标注、Mac 渲染和保留页级读取；独立人工验收仍是另一问题 |
| 原 MCP 仅能只读 | 纠正 | 18 工具已覆盖导入、修订、绑定、检查和处置；25 项真实 stdio 测试通过 |
| 新产品可以整体摆脱旧合同 | 撤回 | 外部编排与旧核心边界可以并存，原稿保护与冻结证据不能顺带取消 |

### 3.2 第一优先级不是更聪明的总控

首要工作有三件：可复现 Oleafly 开发运行；把工作台能力以受限、实际可用的工具交给一个执行器；把结果作为版本绑定证据而不是聊天摘要展示。当前最具体的接入阻断是 **MCP 工具/项目范围与人工确认归因**，而不是缺少一个会派工的 Agent。

## 4. Oleafly：可复用底座与实际边界

### 4.1 它已经提供什么

Oleafly 是文档工程与 Agent 工作台，不只是文本编辑壳。其 Rust crates 负责项目、编译、Agent、ACP、research、sandbox、history 等；React/TypeScript 层提供编辑、预览、状态和贡献入口。领域包通过 typed ports 连接宿主，内部 registry 接纳 tabs、commands、toolsets 和 context providers，但不是可随意动态安装的第三方插件 SDK。[O1][O2]

| 能力层 | 当前实现 | 对我们有什么用 | 必须保留的边界 |
| --- | --- | --- | --- |
| 文档工程 | Tectonic/Latexmk、Typst、Markdown、Quarto、Calepin 等引擎与编译/预览链 | 原生文本源项目直接复用 | DOCX 转换路线不等于原生 DOCX 编辑器 |
| Provider | API agent loop 与四类 wire：Responses、Chat、Anthropic、Google | 不再自建供应商、密钥、流式工具管线 | 模型目录存在不等于当前账号/工具能力测试通过 |
| ACP | 协议能力协商、外部 CLI 会话、恢复和工具注入 | 利用已有 CLI/订阅执行端 | 各 agent、版本、模式不保证能力相同 |
| Research Tasks | brief、权限、预算、计划审阅、调度、等待/唤醒、运行记录 | 复用后台任务骨架 | 实验性、默认关闭；仍需在本机验证 |
| 审阅应用 | 隔离副本、差异、generation、hash、apply journal、恢复 | 保留受控应用逻辑 | 不可用裸文件复制替代已打开项目的变更协调 |
| MCP | 外部 server、任务 scoped bridge、外部服务 client | 三条连接方向覆盖不同场景 | 全局聊天配置不等于任务配置 |
| CLI/Daemon | 独立命令入口、无窗口运行与 App/Daemon 接管 | 后续延续任务 | 独立 CLI run 不自动等价于 ResearchTask |

这些是源码确认的资产；本轮没有重新运行 Oleafly 的模型、编译器或任务。官方 0.4.9 欢迎页启动属于既有预览证据，不证明本地 branch 或融合版可运行。

### 4.2 现有任务生命周期

```text
用户对话或 Research 面板
  -> 创建 brief / queued
  -> runtime 与项目信任检查
  -> scheduler 原子领取 + 并发许可 + execution_generation
  -> 隔离副本与源版本
  -> 可选 planning -> plan_ready -> 人工批准
  -> working / 工具、运行、审批、预算
  -> awaiting_review
  -> 异步自动诊断
  -> 审阅并 apply / dismiss / accept result
  -> completed
```

`TaskStore` 拥有任务记录；scheduler 拥有执行领取与取消；UI 投影状态，不能自己写出第二份权威。修改任务配置要求 queued，retry 对 failed/cancelled 开放，不应直接把 Completed 翻回 Running 模仿长期 Ticket。[O3][O4]

对话中已有 `research_task_create/status`。内建 helper 也已存在：同 provider/model、最多 3 并发、40 steps、1—20 分钟，只读项目和文献、只写 research record，不运行命令或实验。ACP 任务工具明确不暴露 `spawn_agent`。所以“多 Agent”不是空白，但它也不是通用跨执行器团队编排。[O5]

### 4.3 需要实测的边界

- **恢复：** ACP 恢复受 task/agent/project/workspace 和能力协商约束；恢复失败会提示后开新会话。必须把“原会话恢复”和“携资料新建”分开记录。[O6]
- **费用：** USD 预算依赖可观察 cost；unknown cost 不触发美元上限。时间/并发约束不能改名为计费封顶。[O7]
- **工具：** 任务使用独立 `research_task_mcp_servers`；内建路径有工具加载错误转空集合的分支，必要工具必须在启动前实际探测，不能仅看设置已保存。[O8]
- **隔离：** worktree/snapshot 保护编辑副本，OS sandbox 约束命令；两者不是一回事。独立 CLI 的 `--unsandboxed-commands` 与桌面任务的权限不能混称。[O9]
- **产物：** awaiting_review 早于异步 evidence 完成；accept result 不要求全部诊断通过。completed 是执行/审阅状态，不是科学结论。[O4][O10]

### 4.4 自动诊断不能直接升级为正式科研证据

当前 `EvidenceReport` 主要保存检查时间和检查数组，刷新会更新当前任务 evidence。它不具有我们的 baseline/world/method/read-receipt 依赖语义。文献检查聚焦新增 key，数字检查聚焦带运行标记的部分数字，不能据此声称全文数值或引文支持关系已核验。[O10]

静态审查还找到窄而明确的错误路径：bibliography 解析/读取失败可能变空集合，worker join failure 也可 `unwrap_or_default`，空问题随后可能表现为 Pass；另一路 numbers/figures worker 失败会丢检查项。本轮未作故障注入，故列为 **SRC 风险而不是已复现运行缺陷**。普通文献网络错误可呈 Warn，不能写成“所有失败都会绿色通过”。

产品建议：保留它们为“自动诊断”，另外展示工作台的正式检查引用、覆盖缺口和当前适用性。只修复首条业务链实际依赖的假成功路径，不把全面整顿上游作为融合前置。

## 5. DeepSeek Super-agent：值得借鉴的不是另一批聊天窗口

### 5.1 公开原型的实际定位

公开仓库自称研究原型、非官方产品、非生产就绪，并明确文章、内部实现和公开代码存在差异。当前 bundle 面向一个 GitHub 仓库，可选飞书，依赖 DeepSeek Harness 主会话和 worker，而不是通用 ACP 编排库。[S1]

```text
Source -> Trigger -> Thread
                  -> 既有 Subscription 投递上下文
                  -> Policy gate + Eval
                  -> Decision + Mandate + Ticket
                  -> Assignment -> DSH worker
                  -> Report / Attention / Outbox
                  -> 原讨论渠道中的结果或待人工事项
```

### 5.2 核心概念及其价值

| 概念 | 真正解决的问题 | 我们可借鉴什么 | 不能替代什么 |
| --- | --- | --- | --- |
| Trigger / Thread | 事件身份、归属与重复接收 | 同一更新不要反复开工；后续反馈回到原工作 | 文稿内容不是可信任务指令 |
| Policy / Eval | 确定性准入与语义接单分层 | 未授权观察先记录，不自动行动 | 模型研判不证明学术事实或授权事实正确 |
| Mandate | 固定接单原因、范围、策略版本与强度 | 解释为什么能做、边界在哪里 | 不等于具体改稿产物批准或 OS 沙箱 |
| Ticket / Assignment | 长期工作与某次执行分离 | 换执行器、恢复时不丢业务身份 | 不等于现有 ResearchTask 一键换名 |
| Subscription / Input | 跟进归属；投递与进入模型步骤分开 | 减少重复解释，知道哪些输入需重送 | readAt 不证明理解；订阅不扩大权限 |
| Effects / Outbox | 状态提交与待执行副作用持久化 | 重启后恢复工作、按 ID 去重 | 不宣称真实外部系统 exactly-once |
| Attention | 结构化“需要人做什么” | 少打扰，问题集中，结果有用时再通知 | 不能从模糊自然语言猜用户批准 |

核心端口确有可替换性，但 Runtime 直接装配 Sessions、DshExecutor、MasterAssessor；整包引入要承担 DSH 宿主、设置、数据和升级，不是 Oleafly 多装一个插件。[S2][S3]

### 5.3 不能原样搬进科研合同的语义

1. **执行权限宽。** 受管会话被设为 `danger-full-access`，账户 wrapper 选择凭据而非隔离 OS；不能以 Mandate 代替原稿保护。[S4]
2. **策略变化不立即撤销运行中的 Mandate。** 变更以输入通知当前执行；若我们的版本或批准改变后必须拒绝下一次写入，应在提交边界实现，而非等待模型理解通知。[S5]
3. **ready 可完成工作。** 无外部 follows 的 Ticket 可以由 worker ready 结束为 completed，没有独立科研验证器。[S6]
4. **运营记录可迁移。** SQLite 事务、WAL、savepoint 与 effect 有真实实现，但历史 JSON 的原地迁移不等于保留冻结证据原始字节。[S7]
5. **准备目录重试需复现。** prepare 失败留下非空目录后，人工 retry 的目录存在分支可能跳过 prepare/verify。这是待复现实验，不作为当前已发生数据损坏的结论。[S8]

### 5.4 应肯定的工程能力

它有真实的并发槽、持久化副作用、重启恢复、已投递未读取输入重排、状态目录锁和错误可见性。Outbox 也不是简单反复发送：GitHub 用隐藏 message ID 查找已有回复，飞书传幂等键。外部发送与本地记账之间仍有崩溃窗口，因此只能称去重与恢复设计，不能宣称已证明全链路 exactly-once。[S7][S9]

现有测试中，core/policy 是状态机单元，store/effects/migration 使用真实临时 SQLite，runtime 很多部分使用 fake DSH/model/network；不能把这些测试叫真实模型与 GitHub/飞书 E2E。本轮未执行 `pnpm check`，也未启动 Harness。

## 6. 我们的研究核心：已有资产、实际结果和缺口

### 6.1 值得保留的核心

| 模块 | 已有资产（SRC） | 产品价值 | 仍缺什么 |
| --- | --- | --- | --- |
| `docx/` | 包/关系/区域/对象读取、限制、源定位、按需查询与回执 | 模型拿到有范围的材料，不拿纯文本冒充全文 | 完整样式级联、复杂嵌入语义、完整页映射 |
| `projects/` | 源字节、基线、CAS、请求幂等、精确响应与历史恢复 | 版本可定位，重复请求不凭感觉处理 | 多独立源项目、完整任务资料包/书签 |
| `journals/` | 来源、world、候选/确认/冲突、显式绑定、检查、处置 | 规则有出处，结论与适用性分离 | 通用期刊理解、完整规则作用域与所有格式检查 |
| `workbench/` | 同一 Service 的 HTTP/CLI/MCP | 复用业务，不造三份逻辑 | 自主 Agent 的工具/项目级授权和真实身份归因 |
| 既有只读渲染链 | Mac WPS 历史导出、页面、bundle、保留页查询 | 支持有条件的页级证据阅读 | 独立人工 S1 验收、跨渲染环境完整兼容 |

当前 journal checker 覆盖九类属性：页宽、高、四边距、栏数、正文字号、正文行距；这是声明属性的有限检查，不是全期刊合规。正文字号/行距使用受限段落观察，不能当作 Word/WPS 完整布局结果。[W1][W2]

### 6.2 方法与记录不能被摘要替代

| 合同/方法 | 当前标识 |
| --- | --- |
| MCP | `workbench-mcp-0.3.0` |
| Reader | `s1-readonly-reader-1.4.0` |
| Query / Receipt | `s1-read-query-1.6.0` / `s1-read-receipt-1.1.0` |
| Page mapping / Render bundle | `s1-page-mapping-1.1.0` / `s1-render-bundle-1.1.0` |
| World / Analyzer | `journal-world-1.1.0` / `journal-world-analyzer-1.4.0` |
| Checker / HTTP | `journal-geometry-checker-1.1.0` / `journal-http-1.3.0` |

历史响应恢复返回原结果，不能调用旧引擎重新计算后伪装原记录；方法变化要产生新记录。发现目录不算内容阅读，`has_more=false` 只说明该选择没有下一页，不说明全文完整或模型已经理解。[W1][W3]

### 6.3 本轮纠正的当前证据事实

此前“标注仍为空”的说法不准确。当前 Git 中 `document-annotation.json` 与 `page-evidence.json` 各有 **80 条**，标注者是 `agent-review-cli-20261031`。说明文档明确这是 Agent 辅助审查，不是 S1 所需独立人工验收。标记 reviewed 不足以消除这一证据等级差异。[W4]

macOS 也已不是“只能等旧 Windows 环境恢复”：既有记录包含 WPS for Mac 7.2.1 (8947) 的 process-verified 导出。本轮只读核验 Mac PDF SHA-256 `8d658153a03df5f8d215154fc2bcdd6f1d9062b8ef085b095a39c09fa4b71448`，以及 10/10 PNG 哈希；没有重新启动 WPS。[W5]

当前保留库实例进一步提供 HIST：

- page 6 的 query 1.6.0 保存响应包含 4 项：`drawing[8]`、`drawing[9]`、`omml[9]`、`omml[10]`，仍为 `partial`。
- TDSC 指定范围检查保存为 **4 violation / 1 cannot_determine**，analyzer 1.4.0、checker 1.1.0，不是 IJAM 全规范或科研论证验收。
- 该库实例约为 2026-11-02 02:14（Asia/Shanghai）；此前 notes 中的 11 月 1 日实例及 bundle ID 不与它混用。

完整 ID、哈希、读取方式和证据限制见专项报告第 6 节。旧 Windows 绑定与新 Mac 绑定分别保留，不能改旧 PDF 身份来消除失败。

### 6.4 尚未交付的差异化

完整任务资料包、接力书签、作者决定进入基线 digest、S2B 修改预检、具体计划批准、受控文字补丁、改后取证和条件式发布仍有缺口。不能因为 Oleafly 已有 apply，就宣布 DOCX 科研安全写回已完成。当前最值得投入的是把已有记录组织成可靠工作流，而不是先扩展知识图谱或推倒 Python 重写 Rust。

## 7. 三方能力对照与采用决策

| 用户需要 | Oleafly | Super-agent | 研究核心 | 采用判断 |
| --- | --- | --- | --- | --- |
| 编辑/编译/预览 | 已有主链 | 非目标 | 原生编辑未实现 | 复用 Oleafly |
| Provider/CLI 接入 | API、ACP、CLI | DSH 宿主 | 非目标 | 复用 Oleafly，不另造路由 |
| 一次任务委托 | ResearchTask 已有 | Ticket/Assignment 已有 | 记录非调度 | 首先沿用 Oleafly |
| 跨天跟进归属 | 部分恢复、等待能力 | Thread/Subscription/Mandate | 资料包规划 | 用真实场景判断缺口 |
| 并发/取消/恢复 | 已有调度与 owner | 已有 Engine/Executor | 不调度 | 只保留一个执行所有者 |
| 原稿版本/读取回执 | 文件/编译历史 | 运营记录 | 专用不可变记录 | 保留研究核心 |
| 期刊依据与规则版本 | 通用 preflight/工具 | 非目标 | 有限 world/check | 保留研究核心 |
| 证据过期 | 运行源版本、轻量诊断 | 策略与工作状态 | 版本依赖派生 | 不做状态互相覆盖 |
| 实际页面证据 | 原生工程 PDF 预览 | 非目标 | 已有受限 DOCX bundle | 分清源引擎与派生证据 |
| 人工注意事项 | 审批与任务 UI | Attention/安静回报 | 处置/确认 | 统一入口，保留不同事实 |
| 自主规则修订 | 可调用外部工具 | 可自动工作 | 受信人工归因 | 先封住归因与授权缺口 |
| 自动 DOCX 改稿 | 非原生保真能力 | worker 可执行但无领域验证 | S2B 尚未交付 | 不列首版 |
| 跨执行器证据接力 | 摘要/记录目录/宿主接管 | Assignment/输入恢复 | 基础记录有，资料包缺 | 先两关联任务显式接力 |
| 外部 GitHub/飞书主动来件 | 不是本轮首场景 | 原型强项 | 非目标 | 后置，出现真实需求再引入 |

判断依据见第 4—6 节，不按功能数量或仓库热度评分。三个系统的名字相近不代表对象可一一映射。

## 8. 我们要做的产品形态

### 8.1 产品定位（PLAN）

**面向个人科研工作的、以项目与材料为中心的 Agent 工作台。**用户可以自己编辑、与助手协作，或委托一项有边界的工作；不同模式共享同一项目和证据，不共享一个不可验证的“总记忆”。

它不是“自动写完并投稿的科研团队”，也不退化为只看报告的只读工具。近期先让读取、检查、解释和接力可靠；受控改稿按专用合同逐项开放。

### 8.2 信息架构

在现有 Oleafly 工作区中增加少量领域视图，不新增第二个桌面壳：

| 视图 | 首阶段应呈现 | 不应制造的假象 |
| --- | --- | --- |
| 项目材料 | 原生工程文件、受保护 DOCX、当前基线、规则绑定 | 所有附件都可在文本编辑器中无损编辑 |
| 任务 | 目标、执行器、范围、实际工具、运行状态、需人处理 | completed 等于通过；未知费用等于零 |
| 检查结果 | 依据、裁决、适用性、当前有效性、处置、覆盖缺口 | 一个总绿灯替代多种事实 |
| 来源/页面 | 保存的对象、原来源、明确 bundle 的物理页 | 无依据跳到猜测页；摘要代替原文 |
| 历史与接力 | 版本、已交付范围、未解决项、恢复方式 | 换 Agent 自动继承“已读”、认可和权限 |

这些是视图职责，不要求首版新建五个独立模块。先在现有任务详情和一个证据入口完成最小闭环；按实际交互需求再拆分。

### 8.3 典型用户路径

1. 用户选择项目中的受保护稿件，确认当前 B1 与规则 W1；不让 Agent 猜“最新稿”。
2. 委托“检查已支持的期刊版式要求，给出处和无法判断项”；选定一个执行器。
3. 系统显示允许的操作：读取与生成检查记录；不修订规则、不重绑、不改原稿。
4. 执行器按需阅读并提交检查；界面展示具体结果和 coverage，不仅是一段总结。
5. 若需要人工决定，集中给出事实、选项和影响；普通进度安静记录。
6. 用户导入 B2 后，旧记录仍可看，但不能被当成 B2 的当前通过依据。
7. 用户继续任务或换执行器时，恢复依据与未读范围；无法原会话恢复时明确新会话。

B1/W1/B2 是设计示意，不是本轮新导入的稿件或规则。

## 9. 目标架构、数据权威与集成接点

### 9.1 逻辑结构（PLAN）

```text
Oleafly 主应用
  ├─ 项目 / 编辑 / 编译 / 预览 / 现有审阅应用
  ├─ 现有 ResearchTask 与调度器（唯一执行控制）
  │   └─ 一次明确选择的 API 或 ACP 执行器
  └─ 证据与期刊视图 / 受限领域工具调用
          │ 真实工具准入、字段与所属关系校验
          ▼
      WorkbenchService（先复用现有 Python 服务）
          ├─ DOCX 查询、回执、保留页面证据
          ├─ 项目基线与历史
          └─ world / binding / check / disposition

Super-agent：先作为机制与验证案例来源
  └─ 只有已证实的长期委托缺口才引入相应语义
```

图中的“受限工具调用”是必须实现/验证的边界，不是现有 MCP 已具备的能力。逻辑边界也不意味着立即新增独立服务、数据库、消息总线或通用基类。

### 9.2 每种事实的唯一权威

| 事实 | 唯一责任层 | 其他层只保留什么 |
| --- | --- | --- |
| Oleafly 项目与当前编辑状态 | Oleafly 项目/共享文档变更链 | 项目 ID 与 generation |
| task 启动、取消、恢复、owner | Oleafly TaskStore + scheduler | task ID、执行代次、只读状态 |
| 原稿字节、基线与读取响应 | 工作台 projects/docx | 精确 ID、摘要和跳转引用 |
| world、规则依据、绑定、裁决 | 工作台 journals | 引用；不复制可写规则或 verdict |
| 当前有效性 | 工作台按依赖派生 | 展示值可缓存但不得变真源 |
| 工具执行权限 | 实际执行/业务边界 | 授权引用与范围，不信任 prompt 自述 |
| 作者对具体修改的批准 | 后续受控操作合同，当前未完整交付 | 明确批准引用；不能从 ready 推断 |

项目关联最初只需明确 Oleafly project 与工作台 project/baseline 的关系，不必合并两个 SQLite schema。避免让任务库复制一整份 world 或让前端重算 validity。

### 9.3 具体代码接点

- Oleafly 前端入口：`src/contributions/tabs.tsx`、`commands.tsx`，遵守内部 registry 和 host ports；不让可复用包 import Tauri 或 Zustand stores。
- 任务调用：`src-tauri/src/agent/task_runtime.rs` 的 task MCP tools/specs；在既有路径补必要工具探测、限制和明确错误，不另建调度队列。
- 业务承载：`workbench/service.py` 与 `mcp_tools.py`；格式、版本、检查仍在原 owner；任何权限参数变更须同步 MCP 合同和测试。
- 数据展示：以精确 `project_id / baseline_id / world_version_id / check_id / read_record_id` 关联，实际字段以服务响应为准。
- 应用变更：原生文本工程仍走 Oleafly mutation/review/apply；DOCX 写回不复用裸文件替换冒充 S2B。

### 9.4 进程与交付选择

近期保持两个代码仓库：Oleafly fork 与研究核心，便于分别升级和验证。产品体验只要求一个主应用，后台领域进程可以由主应用管理；**一体体验不等于把 Python 全翻成 Rust**。

先用现有 stdio MCP 验证 agent 工具路径。原生结果面板后续需要稳定查询端口：可复用已验证的协议客户端或明确的宿主适配，不直接读取领域 SQLite、不无声明挂接现有浏览器服务。生命周期应限制为选定库、明确启动与退出，不自动连到用户已有库或迁移现有数据。进程打包、健康与版本协商属于后续实施，不在本轮完成声明内。

## 10. 接入前必须解决的权限与工具问题

### 10.1 当前 MCP 不是“自动只读通道”

`build_server` 无条件注册 18 个工具；命令参数只有 `--library-root` 等现有启动配置，没有工具 allowlist 或 project ACL。read-only annotations 是提示，不是权限。`project_root` 的路径检查保护库边界，不证明当前任务获准访问其中每个项目。[W1][W6]

更具体的是：`revise_rule -> WorkbenchService.revise -> local-operator -> human_decision`。现有受信单操作者合同允许这种调用，但自主 Agent 直接取得它，会把模型发起的规则修订记录成人工确认。**必须在自主执行前限制该工具，或实施明确、版本化的确认归因合同。**仅禁止 author-decision 工具不够。[W7]

### 10.2 首个任务的最小权限集（PLAN）

| 类别 | 首阶段策略 |
| --- | --- |
| `method_versions` | 允许，启动时核对合同和方法 |
| 目标项目 detail/workspace/history | 只对明确选择的项目 |
| `read_objects` / `saved_read` | 允许；严格字段与项目/bundle 归属检查 |
| `check_record` / world/source 读取 | 只允许本任务关联的检查、world 和来源 |
| `run_check` | 允许保存检查记录；声明这是写内部记录，不改原稿 |
| `library_state` | 单项目隔离库可用；共享库需真实过滤 |
| `import_*` / `update_manuscript` / `bind_project` | 人工预置或逐次明确授权 |
| `revise_rule` | 不给自主 Agent；人工确认不可由模型代签 |
| `record_disposition` | 初期交给用户，不让模型把问题自动 defer |

执行器有任意 shell 写权限时，仅在工具菜单隐藏功能不是不可绕过的保护。首轮可使用不含其他稿件的隔离库验证；面向日常真稿使用前，还要验证执行器无法直接改作者目录或领域库。做不到时应明确为协作约定，而非宣传强隔离。

### 10.3 Schema、版本与竞争

当前 SDK 忽略未知参数，拼错 optional selector 可能扩大选择范围；合同已如实声明并有测试。受限入口应根据 schema 拒绝未知键，而不是静默删掉后继续。[W1]

`run_check(project_id)` 使用当前绑定，接口未接受 expected baseline/world。任务启动时记住 B1/W1，不能自动保证稍后仍按 B1/W1 执行。首阶段至少核对真实返回的依赖，出现变化不把结果归给原任务范围；若产品要求“必须只检查启动时那一版”，需在业务入口设计原子 expected-dependency 检查并版本化合同。一次调用前后读状态不等于原子保证。

取消也有同样边界：已提交检查不能因任务取消而被删除；结果可标记为该执行的历史产物，但取消后不得继续提交新的受控操作。未来写回必须在提交点检查执行代次和批准，不能只靠 UI 按钮已变灰。

### 10.4 数据外发

本地 MCP 不代表模型推理在本地：返回的稿件片段可能进入所选供应商或 CLI 的模型请求。任务应显示具体执行器、允许材料与网络/外发边界；换执行器不是默认同意换供应商发送全文。本轮没有发送稿件到新供应商，也没有运行付费模型。

## 11. 状态、失效、恢复与接力

### 11.1 至少区分这些事实

执行状态、工具/副作用状态、规则依据、检查裁决、范围适用性、证据当前性、作者处置/批准分别回答不同问题。用一个“完成”图标压缩它们，会使最关键的科研边界消失。

示例 UI 可显示：“任务已结束；检查已保存；2 项无法判断；依据仍当前；尚未人工审阅”。这是设计示意，不是本轮产生的实际检查结果。

### 11.2 版本变化矩阵

| 事件 | 应有行为 | 不允许的行为 |
| --- | --- | --- |
| 新规则 W2 导入，仍绑定 W1 | 提示 update_available | 自动重绑或把 W1 检查全部判 stale |
| 用户显式绑定 W2 | 旧检查按 binding 变化失效，原 verdict 保留 | 把旧检查改写为按 W2 运行 |
| 新稿 B2 成为基线 | 旧检查保留；未显式重绑时新检查拒绝 | 继续借 B1 的当前性声称 B2 通过 |
| reader/analyzer/checker 更新 | 派生相关方法变化；新执行用当前方法 | 为兼容恢复调用废弃引擎写新记录 |
| 同字节但新 baseline | 按对象依赖区别处理；render bundle 绑定需谨慎 | 只因 hash 相同就全量继承页面证据 |
| 旧 `saved_read` 被读取 | 返回精确旧响应，另解释当前适用性 | 无声重算或把旧回执签成新版本 |
| 用户 note/defer | 记录处置，不改 verdict/basis | 用“已处理”遮掉真实违反或无法判断 |

依据为现有版本合同，不是本报告新发明的状态机。[W2][W3]

### 11.3 三种“继续”必须命名清楚

1. **同执行器原会话恢复：** runtime 证实可以恢复，仍需验证材料与授权依赖。
2. **新会话携资料继续：** 原会话不可恢复，保留任务关联但明确重建上下文。
3. **换执行器接力：** 新的执行关联和权限检查；不迁移隐藏推理、不假定继承对方已读。

App/Daemon ownership handoff 是宿主接管，不是第四种跨模型心智迁移。

### 11.4 最小接力记录（概念草案，不是已发布 schema）

仅引用：任务目标与未完成项、选定稿件/规则/方法版本、精确读取响应与检查 ID、覆盖和争议、已发生副作用、当前允许行为、执行器及恢复方式。摘要是导航，不是真源；不要复制整份 world，不要加入全量聊天记录或密钥。

读回执目前以 `workbench-mcp` 识别服务入口，不认证具体模型。若产品要回答“哪个执行实例读了什么”，需增加可验证关联，不能把这一字段直接当 Agent 身份。真正需要一项长期委托跨多个执行时，再考虑 Ticket/Assignment 型业务记录；首条闭环一对一即可。

## 12. 三种采用路线及反证条件

| 路线 | 收益 | 代价与风险 | 何时采用 |
| --- | --- | --- | --- |
| A：Oleafly + 研究核心，Super-agent 只作机制参考 | 最少运行面，先证明产品价值 | 长期事件工作需逐项补 | 当前推荐起点 |
| B：在 Oleafly 既有路径局部吸收机制 | 持续委托、输入去重、注意事项更完整 | 模型/存储/迁移需要验证，不能重复已有实现 | A 的实测确有重复解释、恢复丢输入等缺口 |
| C：完整 DSH bundle，Oleafly 做入口或投影 | 直接得到 GitHub/飞书 intake 和长期工作体系 | 新宿主、依赖、管理面、两侧状态映射与权限工作 | 外部持续来件成为首要需求，且唯一调度权已证明 |

A→B 不是必经路线；如果 Oleafly 已满足需求，应停在 A。若 DSH 实验证明用更少维护即可满足持续任务且不削弱证据边界，应允许转 C，不因本报告推荐而坚持重写。

停止条件也应明确：两个调度器同时 retry/cancel；为迁移而重写历史 evidence；靠自动放宽权限让 demo 跑通；同一任务范围需要用户反复重述却只增加更多 Agent。这些都说明路线尚未成立。

## 13. 分阶段实施路线与完成线

以下是建议工序，不是本轮已执行任务，也不承诺未经估算的工期。每阶段有独立可展示成果，避免做完大框架才第一次接触稿件。

### P0：固定事实与本机开发基线

- 保留三方固定版本和原有变更；确认后续源码构建使用隔离 Oleafly 数据目录。
- 完成 `pnpm install`、对应前端/Rust 构建与最小开发启动，再核对运行版本；本轮未执行这些安装。
- 当前磁盘仅约 12 GiB 可用；先检查构建资源需求，不承诺完整 Rust 构建能在现有空间内完成。
- **完成线：** 可从固定 revision 重现开发启动，退出不影响用户原库。官方 release 欢迎页不能替代。

### P1：安全的协议和工具接入

- 现有工作台 MCP 先在隔离库经 Oleafly client 真实握手、列工具、读方法。
- 建立并验证最小工具与 ID 范围限制，拒绝未知参数；封住人工确认归因路径。
- 必要工具不可用时阻止该类任务或明确 unavailable，不带空工具集继续伪完成。
- **完成线：** 一个明确执行器真的取得声明工具，越界调用可观察地拒绝；尚不宣称真稿业务通过。

### P2：一份稿件、一版规则、一份可追溯结果

- 先合成样本，后经用户选定的真稿副本；人工预置和绑定。
- 任务只读原稿、写内部检查记录，返回版本/来源/覆盖；结果在 Oleafly 内可回源。
- **完成线：** 用户无需开第二套桌面应用即可完成查看与复核；结果依赖由领域服务给出，未知项不被藏掉。

### P3：中断、版本变化与错误语义

- 测取消、重启、断开 MCP、缺工具、坏返回、规则新增不重绑、新稿不重绑、旧响应恢复。
- 明确原会话恢复与新会话继续；旧结果和副作用不因失败被删除或重复伪造。
- **完成线：** 每种失败都有状态、恢复方式和保留证据；不以重跑到绿替代定位。

### P4：第二执行器与最小接力

- 同一业务目标分别经一个 API runtime 和一个 ACP runtime；能力不足的项显式声明。
- 接力者读取实际源记录而非仅上一模型摘要；执行器更换不扩大外发或写入权限。
- **完成线：** 相比普通助手，重复解释与人工搬运减少，且没有增加无用确认；数据来自实测而非预设百分比。

### P5：确有需求才做持续委托与受控改稿

- 持续委托以实际痛点决定是否增加 Mandate/Ticket/Assignment 对应机制，继续只保留一个执行所有者。
- DOCX 改稿按 S2B 专用合同推进：具体计划、批准、补丁、保护对象、改后验证和条件发布；不是开启 shell 写权限。
- GitHub/飞书来件、自动唤醒、跨项目事件、无人值守守护进程单独确认范围，不因本次调研自动启用。

## 14. 验证矩阵与证据等级

| 场景 | 应见结果 | 层次 | 当前状态 |
| --- | --- | --- | --- |
| 工作台 MCP 工具发现及读写流程 | 18 工具、类型、拒绝、CAS 等符合合同 | 协议/组件，真实子进程 | RUN：25 tests passed |
| 工作台全套回归 | 已支持逻辑不回归，跳过有原因 | 多层本地自动化 | RUN：1030 passed / 33 skipped |
| Oleafly -> 工作台握手 | 实际任务工具集中可调用 | 跨应用 system | 未执行 |
| 工具未加载 | 需要它的任务不伪成功 | contract + system | 当前空集合路径需处理 |
| 未授权修订规则 | 不产生伪人工确认 | contract + system | 现有入口无相应限制 |
| 跨项目/check/world ID | 拒绝未授权记录 | contract + system | 需实施真实归属检查 |
| 未知 optional selector | 拒绝，不扩大范围 | contract | 现有 SDK 行为已声明；受限入口待做 |
| task 启动后 baseline 改变 | 返回依赖不冒充原请求范围 | component + system | 组合路径待测 |
| W2 未重绑 | 只 update_available | component + E2E | 核心语义存在，融合 UI 待测 |
| B2 导入但未重绑 | 新检查拒绝，旧记录保留 | component + E2E | 核心有拒绝，融合路径待测 |
| 历史响应恢复 | 原始 bytes/方法不变 | component + E2E | 核心有记录，接力待测 |
| 没有页面证据或映射歧义 | partial/拒绝，不猜页码 | component + E2E | 核心有边界，UI待测 |
| worker ready 但检查缺失 | 执行结束，不显示核验通过 | system + E2E | 融合待实现 |
| ACP 恢复失败 | 明确新会话，不假称原样恢复 | 真实 runtime system | 未执行 |
| 取消后迟到结果 | 旧代次不得提交新受控操作 | 故障注入 system | 集成待测 |
| 重复事件/副作用记账前崩溃 | 去重或明确未知，不能盲目重发 | 故障注入 system | 持续任务阶段再做 |
| 原稿保护与工具绕过 | 无未授权写入、无作者目录产物 | 实际执行端 system | 未执行跨端测试 |
| 未知费用 | 可见 unknown，不显示硬上限生效 | contract + 真实runtime | 源码边界已确认，融合待测 |
| bibliography 解析/worker 失败 | 不把未检查标 Pass | 故障注入 component/UI | 静态风险，未复现 |
| Super-agent prepare 非空失败再 retry | 重新验证或明确人工修复责任 | 故障注入 runtime | 仅待验证边界 |

测试名称中的 live、integration、end-to-end 不决定证据等级；是否用了真实宿主、模型、网络、文件和审批路径才决定。独立人工验收也不能由更多 mock 测试替代。

## 15. 风险登记与最小处理

| 优先级 | 风险 | 最小处理 | 不做什么 |
| --- | --- | --- | --- |
| P1 | 双调度/双恢复 | Oleafly 唯一执行所有者，其他机制提交请求 | 不并行启动第二套 worker pool |
| P1 | 规则修订伪人工归因 | 禁止自主 revise；需要时版本化确认合同 | 不靠 prompt 提醒“别乱用” |
| P1 | 工具/库范围过宽 | 实际 allowlist、ID归属、执行边界 | 不把 hints 当权限 |
| P1 | 状态结束冒充核验 | 多轴结果与必需检查完整性 | 不让绿色 task status 盖过 coverage |
| P1 | 输入竞争与旧依据应用 | 原子提交边界/返回依赖验证 | 不靠启动时截图证明始终有效 |
| P1 | DOCX 转换误作原稿 | 原件与派生件明确区分 | 不在首版承诺任意保真编辑 |
| P2 | 工具错误静默为空 | required-tool admission、明确失败 | 不补空报告/零结果 |
| P2 | executor 切换扩大外发或权限 | 每端能力与授权重新检查 | 不自动换供应商救场 |
| P2 | 旧 docs 覆盖新事实 | 修订当前状态，保留旧证据 | 不重写历史测试来变绿 |
| P2 | 上游升级破坏内部扩展 | 固定版本、薄补丁、契约回归 | 不将内部 registry 当稳定外部 SDK |
| P2 | 原型迁移改变冻结证据 | 运营状态与证据 bytes 分层 | 不把 evidence 塞进可改写 task JSON |

P1/P2 是本融合范围的优先级，不等于对上游安全漏洞的评级。自用降低部署复杂度，但不消除数据误改、错误归因和模型外发风险。

## 16. 本轮实际验证结果

所有命令使用原 checkout 的 `.venv`，临时测试目录位于当时的 `var/investigation-tests-*`，
新日志位于当时的 `reports/integration-investigation/`；未写作者目录。下列路径与结果描述该次
调研，不代表当前 checkout 仍可原位打开这些日志。

| 验证 | 实际结果 | 解释 |
| --- | --- | --- |
| `pytest tests/workbench/test_mcp.py` | 25 passed，5 warnings；测试内部计时 140.04 s | 真实 stdio 子进程，合成受控数据；不是 Oleafly E2E |
| `ruff format --check --no-cache .` | 223 files already formatted | 未自动改格式 |
| `ruff check --no-cache .` | All checks passed | 静态 lint |
| `mypy`（隔离 cache） | 118 source files 无问题 | 类型检查，不是运行保证 |
| 全套 `pytest -ra` | 1030 passed，33 skipped，5 warnings；269.09 s | skips 逐项留在日志，不计为通过 |
| `python -m research_file_workbench.phase0 validate` | exit 1；CONTRACT_INVALID / PHASE0_INCOMPLETE | 当前固定合同/宿主证据未满足，不得汇总为全门禁通过 |

33 skips 包括 Windows 文件属性、路径/PowerShell/导出边界、冻结 Windows 源目录、固定 Poppler 包和 macOS 备用 loopback 地址等。5 warnings 是 PyMuPDF/SWIG 的弃用提示；本轮没有忽略或改写它们。外层进程耗时与 pytest 内部计时不同，`verification.json` 两者来源明确，不当作性能基准。

Phase 0 失败包括：登记源身份所指材料不齐、旧 `wps-writer-12.1.0.28505` 不可用、Windows
绝对路径的 PDF/page 证据缺失。原日志的 `Render record points to another source` 来自校验器
直接比较旧 Windows 绝对路径与 Mac 路径；2026-11-04 核对 8 个 fixture 的源路径后缀、
登记/实际源哈希及保留源件均匹配。此前据此认定平台无关串源缺陷的判断撤回；诊断记录保留为
本地历史证据，位于
`.private/workspace-consolidation-20261109/workbench-original-source/reports/integration-investigation/mcp-read-only-boundary.md`。
这不建立渲染验证或门禁通过；新 Mac bundle 的存在也不否定旧基线失败，不应为修旧 gate
篡改历史。

本轮没有：Oleafly 源码构建、Oleafly 与工作台握手、上游两项目测试、真实模型任务、跨 agent 接力、自动改稿、重新 WPS 渲染或独立人工 S1 验收。**完成的是摸排、文档与注明范围的本地验证，不是融合产品。**

## 17. 维护策略与待决事项

### 17.1 维护策略

- 私用范围已确认，保留 Oleafly AGPL 与 Super-agent MIT 声明，不以假设的商业发行否决技术选择；日后发行/托管另议，本报告不作法律结论。
- Oleafly fork 维持小而可定位的补丁：领域面板、工具边界、版本引用；通用修复独立成补丁，避免把上游 bug 与业务模型捆绑。
- 不复制供应商/ACP/编译/daemon；不把研究核心整体改写或合并数据库作为首要工作。
- 每次上游升级记录 revision，复核 TaskStore、runtime、MCP、apply、daemon 接口并运行边界测试。
- 原稿、标注、历史报告和冻结响应不为新 UI 重写；调研副本在 `var/` 可重建，唯一证据不能只依赖临时目录。

### 17.2 实施前需要用户选择的少量事项

不是现在追问一长串设置；只在相应阶段选择：首个真实执行器及允许发送的材料；首份真稿副本与规则版本；是否允许后台持续运行；后续是否需要跨执行器或 GitHub/飞书来件。其余按最小、可逆、保留证据的默认值推进。

### 17.3 最终决策

先把 **Oleafly + 受限研究工具 + 可追溯结果** 做成一个真实产品切片。它成立后，Super-agent 的价值才有可测量的参照：是否减少重复交代、丢输入、恢复失败与无效打扰。如果没有这些缺口，就不引入它的运行系统；如果出现，就吸收缺口对应的机制，而不是因为“Super”而再造总控。

## 18. 来源索引与复查方式

Oleafly 与 Super-agent 的固定提交已列于第 2 节；各专项报告提供更细符号与行号。工作台本地源码引用以当前 HEAD 和现有文档差异为基线；后续升级不得用新行号冒充本轮版本。

| 来源编号 | 固定源码/本地合同 | 支撑内容 |
| --- | --- | --- |
| O1 | Oleafly `docs/architecture.md`；`packages/registry/src/index.ts:16` | 分层、内部扩展模型 |
| O2 | `crates/oleafly-core/src/manifest.rs:8`；`docs/conversion-matrix.md:215` | 引擎与 DOCX 转换边界 |
| O3 | `crates/oleafly-research/src/model.rs:133`；`scheduler.rs:784` | brief、运行适配、调度权 |
| O4 | `crates/oleafly-research/src/store/mod.rs:239`、`:695`、`:853`、`:1541` | 编辑/重试、待审与完成 |
| O5 | `packages/ai-tools/src/research-tools.ts:280`；`builtin.rs:329`；`mcp/tools.rs:67` | 已有委派与受限 helper |
| O6 | `src-tauri/src/acp/runtime.rs:1045`；`agent/task_runtime.rs:685` | 恢复能力与新会话分支 |
| O7 | `crates/oleafly-research/src/budget.rs:118`、`:223` | unknown cost 语义 |
| O8 | `src-tauri/src/agent/task_runtime.rs:242`、`:365`；`builtin.rs:662` | 任务 MCP 与空集合路径 |
| O9 | `crates/oleafly-research/src/isolation.rs:57`；`src-tauri/src/research_tasks/apply.rs:53`；`crates/oleafly-cli/src/agent/tools/command.rs:57` | 隔离、应用与 CLI 权限 |
| O10 | `crates/oleafly-research/src/evidence/mod.rs:64`；`evidence/bib.rs:52`；`model.rs:338` | 诊断范围与错误路径 |
| S1 | Super-agent `README.md:3`；`package.json` | 研究原型与依赖 |
| S2 | `docs/001-domain.md:34`；`src/core/model.ts`；`src/core/ports.ts:55` | 领域模型与端口 |
| S3 | `src/app/runtime.ts:121`；`src/index.ts:8` | DSH 装配 |
| S4 | `src/app/sessions.ts:152`；`docs/006-deployment.md:19` | 执行权限与 wrapper 边界 |
| S5 | `docs/002-authorization.md:117`；`src/core/tickets.ts:200` | 策略变化与持续授权 |
| S6 | `src/core/assignments.ts:129` | ready 完成语义 |
| S7 | `src/app/store.ts:58`；`effects.ts:130`；`migration.ts:35` | 事务、副作用、迁移 |
| S8 | `src/executor/dsh.ts:255`、`:434` | prepare 失败目录重试 |
| S9 | `src/app/outbox.ts:27`；`src/sources/github-channel.ts:34`；`feishu-channel.ts:23` | 外部回复去重 |
| W1 | [MCP 合同](../contracts/s1/mcp-surface.json)；`workbench/mcp.py:127`；`mcp_tools.py:221` | 当前工具与版本、读取 |
| W2 | [World 合同](../contracts/journals/world-contract.json)；`journals/checker.py:32` | 属性、依据、裁决与失效 |
| W3 | `projects/read_records.py:109`；`render_service.py:185`；`journals/store_checks.py:50` | 历史与依赖 |
| W4 | [标注复核记录](../annotations/s1/ijam-english-working/review-notes.md) | Agent 标注与 Mac 历史链 |
| W5 | 研究核心报告第 6 节（本地历史证据） | 实物哈希和调研时的库实例 |
| W6 | `workbench/mcp.py:135`、`:146`、`:167`；`service.py:422` | 工具注册与边界 |
| W7 | `workbench/mcp_tools.py:403`；`service.py:82`；`journals/revisions.py:52` | 规则确认归因 |

W 类未写完整的模块路径均相对 `src/research_file_workbench/`；O 类缩写 `builtin.rs`、`mcp/tools.rs` 属于 `crates/oleafly-research/src/`。来源编号与本节表格配对，不代表另一个运行时合同。

固定上游入口：[Oleafly 调研提交](https://github.com/Oleafly/Oleafly/tree/1b6521943ea567a4e5df02c99a588b4e49737623)、[官方 0.4.9 发布](https://github.com/Oleafly/Oleafly/releases/tag/v0.4.9)、[Super-agent 调研提交](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/6337fc823ce20251c8de8085948165c81aaa701e)。
