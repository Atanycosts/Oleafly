export {
  createOleaflyTools,
  createFigureTools,
  createDocxTools,
  type AiToolsHost,
  type DocxActivityDocument,
  type DocxAgentAttribution,
  type DocxDocumentRead,
  type DocxDocumentState,
  type DocxFormatReadQuery,
  type DocxFormatReadResult,
  type DocxFormatMutation,
  type DocxSaveResult,
  type DocxTemplateCheckResult,
  type DocxOperationContext,
  type DocxParagraphView,
  type DocxSuggestion,
  type DocxSuggestionApplyResult,
  type DocxSuggestionApplyRequest,
  type DocxSuggestionRequest,
  type DocxSuggestionResult,
  type DocxTargetView,
  type DocxToolsOptions,
  type DocxToolsHost,
  type ProjectIndexView,
  type IndexDefView,
  type IndexUseView,
  type ToolApprovalRequest,
  type ConfirmFn,
  type ExecAuthorization,
  type FigureEngine,
  type FigurePreview,
} from "./tools";
export type { TypstFigureDiagnostic, TypstFigureRender } from "./typst-figure";
export { projectMapFromIndex, type ProjectMap } from "./project-map";
export { pickPagesToVerify } from "./pick-pages";
export {
  registerConnector,
  listConnectors,
  getConnector,
  type ConnectorManifest,
  type ConnectorCapability,
  type ConnectorAuthMode,
} from "./connectors";
export {
  createResearchTaskTools,
  createResearchTools,
  LITERATURE_SOURCES,
  type ResearchTaskRequest,
  type ResearchTaskToolsHost,
  type ResearchToolsHost,
} from "./research-tools";
export type { ResearchTaskApprovalDetails } from "./research-tools";
export {
  createOverleafTools,
  type OverleafToolOutcome,
  type OverleafToolProject,
  type OverleafToolsHost,
} from "./overleaf-tools";
export {
  DEFAULT_APPROVAL_MODE,
  PLAN_MODE_TOOL_ERROR,
  decideToolApproval,
  isReadOnlyTool,
  planModeTools,
  riskRequiresConfirm,
  toolRisk,
  type ApprovalGateDecision,
  type ApprovalMode,
  type ApprovalRuleDecision,
  type ToolRisk,
} from "./approval-risk";
