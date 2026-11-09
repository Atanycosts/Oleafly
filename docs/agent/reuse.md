# Agent 组件复用依据

范围：截至 2026-11-09 已完成的固定源码调查及隔离探针。以下版本是研究输入，
不代表今天的上游最新状态。当前产品能力见[状态页](status.md)，工作合同见[架构](architecture.md)。

## 已采用的底座

产品继续使用 Oleafly 自己的 ResearchTask、SQLite/TaskStore、Rust ACP client、
文件隔离、SharedDocument、应用服务和既有工具 host。Workbench 继续拥有领域数据。
没有引入 Orca、T3、Flock 或 Lody 的运行时、数据库或产品依赖。

引用旧回答与当前评论分离、精确历史文件字节回读等合同受到上游研究启发，
实现落在已有 Rust 服务和存储中。机制借鉴、隔离探针和直接产品代码复用应分别描述。

## 固定版本与取舍

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

## 证据范围

隔离探针验证了部分源码函数、协议和失败语义，使用合成输入；它们不能代替产品集成、
真实模型推理或等预算收益比较。产品运行、失败和修复范围由[状态页](status.md#已交付与验收范围)维护。

本机保留的 `.private/upstream-reuse/` 包含固定源码和探针结果；
`.private/agent-documentation-history/agent-evidence-and-reuse-20261109.md`
保留更完整的调查、其他框架对照及原始证据定位。这些本地材料不随干净 checkout 提供。
后续研究在对应选择发生变化时更新本页，不为每轮调查新增综合报告。
