# Oleafly 与 Research Workbench 集成

核对日期：2026-11-09。本文是集成导航与所有权概览；各模块维护自己的现行状态。
过去逐轮追加的运行记录已冻结在本地忽略目录，避免与今天的指引混读。

| 要了解的内容 | 现行入口 |
| --- | --- |
| Agent 能力、演进、交付与剩余工作 | [Agent 状态与计划](agent/status.md) |
| 应用能力、任务群、标注和恢复的工作合同 | [Agent 架构](agent/architecture.md) |
| 上游机制与实际复用范围 | [复用依据](agent/reuse.md) |
| Workbench 领域实现与验收 | [S1 状态](../services/research-workbench/docs/s1-progress.md) |
| 服务安装与开发 | [模块 README](../services/research-workbench/README.md)、[开发入口](development.md#journal-workbench-service) |
| 领域字段与版本语义 | [期刊合同](../services/research-workbench/contracts/journals/world-contract.json)、[其他合同](../services/research-workbench/contracts/) |

## 一套应用，明确所有者

Oleafly 保留编辑器、LaTeX/Typst/Markdown 编译、PDF、文献引用、项目、人工操作及单 Agent。
任务群扩展它的工作组织方式；单 Agent 和任务群都通过既有业务服务实际操作软件，
把结果交回对应界面。它们不只是读取源码的外部聊天窗口。

Oleafly 的 Agent runtime/TaskStore 负责任务、成员、过程、标注和执行。
`services/research-workbench/` 的 Python 服务负责保留文档字节、基线、期刊规则、
显式绑定、检查和领域有效性。两边关联已有记录，不复制领域数据库或另建调度平台。

同仓不表示合库或把 Python 改写成 Rust。独立 Workbench 的活动源码已归入本仓库，
旧独立桌面 shell 已退役；已有用户库和稿件数据没有因源码合并而搬迁。
源码合并、安装版更新、Windows 部署和模型收益分别验证，不互相推导。

## 接续与文档维护

从上述入口按问题读取。当前状态原位更新，目标设计与历史运行分开；
字段和方法版本查机器合同及实现。日常变更不用再向本页追加一轮报告。

详细历史保留于本地 `.private/agent-documentation-history/`：
`integration-checkpoints-20261109.md` 为本页整理前的完整字节，
`agent-status-20261109.md`、`agent-architecture-20261109.md` 与
`agent-evidence-and-reuse-20261109.md` 为原外部设计、状态和证据记录。
原始验收和上游调查目录仍保留。它们是固定日期的本地证据，干净 checkout 不含这些文件；
不把本机绝对路径作为公开文档的必要依赖。

Workbench 的[融合设计](../services/research-workbench/docs/fused-research-agent-architecture.md)
是早期历史输入，不能代替现行 Agent 架构或领域合同。
