import { labels, propertyLabels, validateResponse, isObject, isText } from "./transport/contracts.js";
import { byId, element, icon, show, errorAt, announce, formatDate, formatValue, versionLabel } from "./ui/dom.js";
import { renderRuleMap, componentFor } from "./views/rule-map.js";
import { renderManuscriptMap } from "./views/manuscript-map.js";
import { renderSourceReview, openSourceLibrary } from "./views/source-review.js";
import { createManuscriptWorkspace } from "./views/manuscript.js";
import { userMessage, evidenceQuote } from "./ui/presentation.js";

const HTTP_CONTRACT_VERSION = "journal-http-1.10.0";
const state = {
  token: null, worlds: [], projects: [], capabilities: {}, world: null,
  projectId: null, check: null, ruleId: null, filter: "all", sources: [], busy: false,
  review: null, workspace: "map", componentId: null, search: "", zoom: 1,
  readRequest: 0, assetVersion: null, synchronized: false, pageReloadRequired: false,
  mapView: "journal", panX: 0, panY: 0, manuscriptData: null,
};
const issueVerdicts = new Set(["violation", "observed_difference", "cannot_determine"]);
const mutationIds = ["new-world", "empty-import-world", "empty-import-project", "import-project", "refresh-state",
  "bind-world", "run-check", "submit-world", "submit-project", "save-note", "defer-rule",
  "submit-revise", "run-diff", "compare-worlds", "view-update", "view-bound-world", "retry-load",
  "map-view-journal", "map-view-manuscript"];

let toastTimer = 0;
function success(message) {
  const toast = byId("success-message");
  toast.replaceChildren(icon("check"), element("span", "", message));
  show("success-message", true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show("success-message", false), 4200);
  announce(message);
}
function globalError(message) {
  byId("global-error-text").textContent = message;
  byId("retry-load").textContent = state.pageReloadRequired ? "重新加载页面" : "重试加载";
  show("global-error", true);
  announce(message);
}
function selectedProject() { return state.projects.find((item) => item.project_id === state.projectId) || null; }
function visibleCheck() {
  return state.check && state.world && state.check.project_id === state.projectId && state.check.world.version_id === state.world.version_id
    ? state.check : null;
}
function resultFor(rule) {
  return visibleCheck()?.rule_results.find((item) => item.rule_id === rule.rule_id) ?? null;
}
function tone(verdict, basis, validity) {
  if (validity === "STALE") return "tone-stale";
  if (verdict === "violation") return "tone-danger";
  if (verdict === "compliant") return "tone-good";
  if (["observed_difference", "cannot_determine", "observed_match"].includes(verdict) || basis === "conflict") return "tone-warning";
  return "tone-neutral";
}
function ruleLabel(rule) { return propertyLabels[rule.property]; }
function scopeLabel(scope) {
  return [scope.article_type, scope.stage, scope.language].map((value) => labels[value] ?? value).join(" · ");
}
function resultLabel(verdict, check) {
  return check?.validity === "STALE" ? `历史：${labels[verdict]} · 待重查` : labels[verdict];
}
function mismatchBlink(verdict, check) {
  if (!check || check.validity !== "CURRENT") return "";
  if (verdict === "violation") return "blink-danger";
  if (verdict === "observed_difference") return "blink-warn";
  return "";
}
function manuscriptBubbleAppearance(verdict, check) {
  return { tone: tone(verdict, "candidate", check.validity), label: resultLabel(verdict, check), blink: mismatchBlink(verdict, check) };
}
const JOURNAL_LEGEND = [["tone-good", "符合"], ["tone-danger", "不符合"], ["tone-warning", "需人工核对"], ["tone-neutral", "未检查"], ["tone-stale", "结果已过期"]];
function renderLegend(items) {
  byId("map-legend").replaceChildren(...items.map(([toneClass, text]) => {
    const item = element("span");
    item.append(element("i", `legend-dot ${toneClass}`), element("span", "", text));
    return item;
  }));
}
function setBusy(busy, message = "") {
  state.busy = busy;
  byId("main").setAttribute("aria-busy", String(busy));
  byId("activity-label").textContent = message;
  show("activity", busy);
  for (const id of mutationIds) byId(id).disabled = busy;
  byId("project-select").disabled = busy;
  byId("journal-select").disabled = busy;
  byId("world-version").disabled = busy;
  for (const button of document.querySelectorAll(".world-nav-item")) button.disabled = busy;
  for (const control of document.querySelectorAll(".bubble-node, .component-card, .workspace-tab, .object-item, .document-toolbar button, .document-toolbar select, .document-evidence button, .history-entry button, .segmented-control button, dialog button, dialog input, dialog select, dialog textarea, #diff-from, #diff-to, #disposition-note, #revise-expected, #revise-reason, #open-manuscript, #reload-manuscript")) control.disabled = busy || control.dataset.unavailable === "true";
  if (!busy) updateControls();
  if (message) announce(message);
}
function updateControls() {
  if (state.busy) return;
  const project = selectedProject();
  const currentBinding = project?.binding?.baseline_id === project?.baseline_id;
  byId("bind-world").disabled = !project || !state.world || (currentBinding && project.binding.world_version_id === state.world.version_id);
  byId("run-check").disabled = !project?.binding || !currentBinding;
  byId("download-check").disabled = !visibleCheck();
  byId("compare-worlds").disabled = state.worlds.length < 2;
  byId("save-note").disabled = !visibleCheck() || !state.ruleId;
  byId("defer-rule").disabled = !visibleCheck() || !state.ruleId;
  byId("submit-revise").disabled = !state.world || !state.ruleId;
  if (!state.token || !state.synchronized) {
    for (const id of ["new-world", "empty-import-world", "import-project", "bind-world", "run-check", "submit-world", "submit-project", "save-note", "defer-rule", "submit-revise"]) byId(id).disabled = true;
  }
}
async function api(path, payload) {
  const options = { credentials: "same-origin", headers: { "Accept": "application/json" } };
  if (payload !== undefined) {
    if (!state.token) throw new Error("会话尚未建立，请刷新工作区后重试。");
    if (!state.synchronized || state.pageReloadRequired) throw new Error("工作区尚未同步，请先刷新工作区。");
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.headers["X-RFW-Token"] = state.token;
    options.body = JSON.stringify(payload);
  }
  let response;
  try { response = await fetch(path, options); }
  catch { throw new Error("无法连接本地服务，请确认服务仍在运行后重试。"); }
  let body;
  try { body = await response.json(); }
  catch { throw new Error("本地服务未返回有效结果，请确认服务仍在运行后重试。"); }
  if (!response.ok || (isObject(body) && Object.hasOwn(body, "error"))) {
    if (response.status === 403) state.token = null;
    throw new Error(isObject(body) && isText(body.error) ? body.error : "本地服务拒绝了请求，请刷新工作区后重试。");
  }
  return validateResponse(new URL(path, window.location.origin).pathname, body);
}
async function perform(message, operation, errorId) {
  if (state.busy) return;
  clearTimeout(toastTimer);
  show("global-error", false);
  show("success-message", false);
  if (errorId) errorAt(errorId, "");
  setBusy(true, message);
  try { await operation(); }
  catch (error) {
    const messageText = error instanceof Error ? error.message : "操作未完成，请重试。";
    const errorTarget = errorId ? byId(errorId) : null;
    if (errorTarget && !errorTarget.closest("dialog:not([open])")) errorAt(errorId, messageText); else globalError(messageText);
  } finally { setBusy(false); }
}
async function refreshAfterWrite(savedMessage, worldId, projectId, refreshView) {
  state.synchronized = false;
  try { await refreshState(worldId, projectId); if (refreshView) await refreshView(); }
  catch (error) {
    state.synchronized = false;
    state.check = null;
    renderAll();
    throw new Error(`${savedMessage}。但工作区未能刷新，请先刷新工作区，不要重复提交。${error instanceof Error ? error.message : ""}`);
  }
}
function hasDraft() {
  const editedValue = byId("revise-expected").dataset.originalValue !== undefined
    && byId("revise-expected").value !== byId("revise-expected").dataset.originalValue;
  return Boolean(byId("disposition-note").value.trim() || byId("revise-reason").value.trim() || editedValue);
}
function mayLeaveRule() {
  return !hasDraft() || window.confirm("当前规则有尚未保存的备注。放弃这些内容并切换？");
}
function clearDraft() {
  byId("disposition-note").value = "";
  byId("revise-reason").value = "";
  byId("revise-expected").value = "";
  delete byId("revise-expected").dataset.originalValue;
  errorAt("disposition-error", "");
  errorAt("revise-error", "");
  byId("revise-details").open = false;
}

async function refreshState(preferredWorldId, preferredProjectId) {
  const request = ++state.readRequest;
  const snapshot = await api("/api/state");
  const projectId = preferredProjectId ?? state.projectId ?? snapshot.projects[0]?.project_id ?? null;
  const project = snapshot.projects.find((item) => item.project_id === projectId) ?? null;
  const worldId = preferredWorldId ?? state.world?.version_id ?? project?.binding?.world_version_id ?? snapshot.worlds[0]?.version_id ?? null;
  if ((projectId && !project) || (worldId && !snapshot.worlds.some((item) => item.version_id === worldId))) {
    throw new Error("所选论文或期刊版本已不在当前工作区中，请重新加载页面。");
  }
  const [world, check, review] = await Promise.all([fetchWorld(worldId), fetchProjectCheck(project), fetchReview(worldId)]);
  if (request !== state.readRequest) return;
  Object.assign(state, { worlds: snapshot.worlds, projects: snapshot.projects, capabilities: snapshot.capabilities, projectId, world, check, review, synchronized: true, manuscriptData: null });
  if (!world?.rules.some((rule) => rule.rule_id === state.ruleId)) state.ruleId = null;
  renderAll();
}
async function fetchWorld(versionId) {
  if (versionId === null) return null;
  const world = await api(`/api/world?version_id=${encodeURIComponent(versionId)}`);
  if (world.version_id !== versionId) throw new Error("服务返回了另一个期刊版本，已停止切换，请刷新工作区。");
  return world;
}
async function fetchProjectCheck(project) {
  if (!project || project.latest_check === null) return null;
  const check = await api(`/api/check?check_id=${encodeURIComponent(project.latest_check.check_id)}`);
  if (check.check_id !== project.latest_check.check_id || check.project_id !== project.project_id) {
    throw new Error("服务返回了不属于此论文的检查记录，已停止切换，请刷新工作区。");
  }
  return check;
}
function renderAll() { renderNavigation(); renderProject(); renderWorld(); renderMap(); renderDetail(); renderWorkspace(); updateControls(); }

function renderNavigation() {
  const grouped = new Map();
  for (const world of state.worlds) {
    if (!grouped.has(world.journal_id)) grouped.set(world.journal_id, []);
    grouped.get(world.journal_id).push(world);
  }
  byId("journal-count").textContent = String(grouped.size);
  const container = byId("world-list");
  container.replaceChildren();
  if (!grouped.size) container.append(element("p", "nav-empty", "导入期刊后，会显示在这里。"));
  const journalSelect = byId("journal-select");
  journalSelect.replaceChildren();
  if (!grouped.size) journalSelect.append(new Option("先导入期刊", ""));
  for (const versions of grouped.values()) {
    versions.sort((left, right) => right.version_ordinal - left.version_ordinal);
    const latest = versions[0];
    const button = element("button", "world-nav-item");
    button.type = "button";
    button.setAttribute("aria-current", String(state.world?.journal_id === latest.journal_id));
    button.title = latest.journal_name;
    button.setAttribute("aria-label", `${latest.journal_name}，${versions.length} 个版本`);
    button.disabled = state.busy;
    button.append(element("span", "journal-initial", latest.journal_name.trim().slice(0, 1).toUpperCase()));
    const text = element("span");
    text.append(element("span", "journal-nav-name", latest.journal_name), element("span", "journal-nav-meta", `${versions.length} 个版本 · ${versionLabel(latest)}`));
    button.append(text);
    button.addEventListener("click", () => selectWorld(latest.version_id));
    container.append(button);
    journalSelect.append(new Option(latest.journal_name, latest.version_id));
  }
  const viewedJournal = state.world ? grouped.get(state.world.journal_id) : null;
  journalSelect.value = viewedJournal ? viewedJournal[0].version_id : "";
}
function renderProject() {
  const select = byId("project-select");
  select.replaceChildren();
  if (!state.projects.length) select.append(new Option("尚未导入论文", ""));
  for (const project of state.projects) select.append(new Option(project.name, project.project_id));
  select.value = state.projectId || "";
  const project = selectedProject();
  const binding = project?.binding;
  const bindingCurrent = binding?.baseline_id === project?.baseline_id;
  const chip = byId("binding-label");
  if (!binding) { chip.textContent = "未对照"; chip.className = "binding-chip"; }
  else if (!bindingCurrent) { chip.textContent = "稿件已更新"; chip.className = "binding-chip is-warn"; }
  else { chip.textContent = "已对照"; chip.className = "binding-chip is-ok"; }
  const usingViewedVersion = Boolean(binding && bindingCurrent && state.world && binding.world_version_id === state.world.version_id);
  byId("bind-world").textContent = usingViewedVersion ? "已使用此期刊" : binding ? "换用此版本" : "使用此期刊";
}
function renderWorld() {
  const world = state.world;
  show("world-empty", !world);
  show("rule-map", Boolean(world));
  show("world-version-controls", Boolean(world));
  show("binding-mismatch", Boolean(world && selectedProject()?.binding && selectedProject().binding.world_version_id !== world.version_id));
  if (!world) {
    byId("world-title").textContent = "从一本期刊开始";
    byId("world-scope").textContent = "导入期刊资料，逐条核对论文的页面要求。";
    show("update-notice", false);
    return;
  }
  byId("world-title").textContent = world.journal_name;
  byId("world-scope").textContent = `${scopeLabel(world.scope)} · ${formatDate(world.created_at)} 导入`;
  const versions = state.worlds.filter((item) => item.journal_id === world.journal_id).sort((left, right) => right.version_ordinal - left.version_ordinal);
  byId("world-version").replaceChildren(...versions.map((item) => new Option(versionLabel(item), item.version_id)));
  byId("world-version").value = world.version_id;
  const latest = versions[0];
  const hasUpdate = Boolean(latest && latest.version_id !== world.version_id && latest.version_ordinal > world.version_ordinal);
  show("update-notice", hasUpdate);
  if (hasUpdate) {
    byId("update-description").textContent = `${versionLabel(latest)} 已可查看。当前查看与论文绑定不会自动切换。`;
    byId("view-update").dataset.versionId = latest.version_id;
  }
  renderCoverageGaps();
}
function renderCoverageGaps() {
  const check = visibleCheck();
  const gaps = check ? check.coverage_gaps : state.world?.coverage_gaps ?? [];
  byId("coverage-gaps").replaceChildren(...gaps.map((gap) => {
    const line = element("li");
    const property = gap.property ? propertyLabels[gap.property] ?? gap.property : null;
    line.append(element("span", "", `${property ? `${property}：` : ""}${userMessage(gap.message)}`));
    if (gap.locator) line.append(element("span", "gap-locator", gap.locator));
    return line;
  }));
  show("coverage-section", gaps.length > 0);
}
function renderSummary() {
  const check = visibleCheck();
  const container = byId("check-summary");
  container.replaceChildren();
  show("check-summary", Boolean(check));
  if (!check) return;
  const results = check.rule_results;
  const categories = [
    ["符合", "compliant", "tone-good", false],
    ["不符合", "violation", "tone-danger", true],
    ["候选吻合", "observed_match", "tone-warning", false],
    ["候选差异", "observed_difference", "tone-warning", false],
    ["无法判断", "cannot_determine", "tone-warning", false],
    ["未检查", "not_checked", "tone-neutral", false],
  ];
  for (const [label, verdict, toneClass, problem] of categories) {
    const count = results.filter((item) => item.verdict === verdict).length;
    const chip = element("span", `summary-chip ${toneClass}${count === 0 && !problem ? " is-zero" : ""}`);
    chip.append(element("strong", "", count), element("span", "", label));
    container.append(chip);
  }
  const missingObservations = results.reduce((total, result) => total + result.findings.filter((finding) => finding.observed === null).length, 0);
  const meta = element("div", "summary-meta", `${formatDate(check.created_at)} 检查`);
  meta.append(element("span", "summary-coverage", `${check.coverage_gaps.length} 项来源缺口 · ${missingObservations} 处未声明`));
  if (check.validity === "STALE") meta.append(element("span", "stale-label", "以上为历史结果，已过期，请重新检查"));
  container.append(meta);
}
function renderMap() {
  renderSummary();
  byId("bubble-popover").hidden = true;
  const check = visibleCheck();
  const search = state.search.trim().toLocaleLowerCase();
  const project = selectedProject();
  const journalVisible = Boolean(state.world);
  const manuscriptVisible = Boolean(project);
  byId("map-view-journal").setAttribute("aria-pressed", String(state.mapView === "journal"));
  byId("map-view-manuscript").setAttribute("aria-pressed", String(state.mapView === "manuscript"));
  byId("filter-all").setAttribute("aria-pressed", String(state.filter === "all"));
  byId("filter-issues").setAttribute("aria-pressed", String(state.filter === "issues"));
  show("world-empty", state.mapView === "journal" && !journalVisible);
  show("manuscript-empty", state.mapView === "manuscript" && !manuscriptVisible);
  const canvasVisible = (state.mapView === "journal" && journalVisible) || (state.mapView === "manuscript" && manuscriptVisible);
  show("rule-map", canvasVisible);
  show("component-list", state.mapView === "journal" && journalVisible);
  show("coverage-section", state.mapView === "journal" && journalVisible && (check ? check.coverage_gaps : state.world?.coverage_gaps ?? []).length > 0);
  show("download-check", state.mapView === "journal");
  if (!canvasVisible) return;
  const issue = (verdict, ruleBasis) => check?.validity === "STALE" || issueVerdicts.has(verdict) || verdict === "not_checked" || ruleBasis !== "confirmed";
  if (state.mapView === "manuscript") {
    renderLegend(JOURNAL_LEGEND);
    const rendered = renderManuscriptMap({ root: byId("page-bubbles"), breadcrumb: byId("map-breadcrumb"), project, data: state.manuscriptData, check, busy: state.busy, filter: state.filter, search, getAppearance: manuscriptBubbleAppearance, selectProperty, openManuscript: () => selectWorkspace("manuscript"), openImport: () => openDialog("project-dialog") });
    byId("page-zone-state").textContent = `${state.manuscriptData?.catalog.items.filter((item) => item.object_type === "section").length ?? 0} 个分节 · 来自当前论文`;
    show("empty-filter", state.filter === "issues" && Boolean(check) && (rendered?.visible ?? 0) === 0);
    byId("empty-filter").textContent = "这轮检查没有待核对的要求。";
    return;
  }
  renderLegend(JOURNAL_LEGEND);
  const rules = (state.world?.rules ?? []).filter((rule) => {
    const result = resultFor(rule);
    const verdict = result?.verdict ?? "not_checked";
    const content = [ruleLabel(rule), ...rule.evidence.map((item) => `${sourceName(item.source_id)} ${item.quote}`)].join(" ").toLocaleLowerCase();
    return (state.filter !== "issues" || issue(verdict, rule.basis_status)) && (!search || content.includes(search));
  });
  renderRuleMap({ world: state.world, review: state.review, selectedComponent: state.componentId, search, rules, ruleId: state.ruleId, busy: state.busy,
    getState: (rule) => { const verdict = resultFor(rule)?.verdict ?? "not_checked"; return { tone: tone(verdict, rule.basis_status, check?.validity), label: resultLabel(verdict, check), blink: mismatchBlink(verdict, check) }; },
    selectRule, selectComponent, selectSources:()=>openSourceLibrary(state.review,state.world,api), root: byId("page-bubbles"), components: byId("component-list"), breadcrumb: byId("map-breadcrumb"), zoom: state.zoom, pan: [state.panX, state.panY] });
  show("empty-filter", journalVisible && rules.length === 0);
  byId("empty-filter").textContent = state.world?.rules.length ? "没有匹配的要求。试试其他关键词或查看全部。" : "尚未提取到页面要求，请补充指南或模板。";
  byId("page-zone-state").textContent = `${rules.length} 条要求 · ${state.world?.sources.length ?? 0} 份资料`;
}
function selectComponent(componentId) {
  if (state.busy || !mayLeaveRule()) return;
  clearDraft(); state.ruleId = null; state.componentId = componentId; state.workspace = "map"; state.zoom = 1;
  renderAll();
}
function selectRule(ruleId) {
  if (state.busy || (state.ruleId !== ruleId && !mayLeaveRule())) return;
  if (state.ruleId !== ruleId) clearDraft();
  state.ruleId = ruleId; state.workspace = "map";
  renderAll();
  byId("inspector").focus({ preventScroll: true });
}
function renderWorkspace() {
  for (const view of ["map", "manuscript", "history"]) byId(`workspace-tab-${view}`).setAttribute("aria-current", state.workspace === view ? "page" : "false");
  show("journal-workspace", state.workspace === "map");
  show("manuscript-workspace", state.workspace === "manuscript");
  show("history-workspace", state.workspace === "history");
  show("inspector", Boolean(state.ruleId) && state.workspace === "map");
}
async function fetchReview(versionId) {
  if (versionId === null) return null;
  const review = await api(`/api/review?version_id=${encodeURIComponent(versionId)}`);
  if (review.world_version_id !== versionId) throw new Error("来源片段与所选期刊版本不一致，请刷新资料。");
  return review;
}
async function fetchManuscriptData() {
  const project = selectedProject();
  if (!project) return null;
  const data = await api(`/api/manuscript?project_id=${encodeURIComponent(project.project_id)}&baseline_id=current`);
  if (data.project.project_id !== project.project_id) throw new Error("论文实况与所选论文不一致，请刷新工作区。");
  return data;
}
function selectProperty(property) {
  const rule = state.world?.rules.find((item) => item.property === property);
  if (rule) selectRule(rule.rule_id);
}
async function switchMapView(view) {
  if (state.busy || state.mapView === view) return;
  state.mapView = view;
  await ensureManuscriptData();
  renderAll();
}
async function ensureManuscriptData() {
  if (state.mapView !== "manuscript" || !selectedProject() || state.manuscriptData) return;
  await perform("正在读取论文实况…", async () => {
    state.manuscriptData = await fetchManuscriptData();
    renderAll();
  });
}
function sourceName(sourceId) {
  return state.world.sources.find((item) => item.source_id === sourceId)?.name ?? "来源引用待核对";
}
function dispositionsFor(ruleId) {
  return (visibleCheck()?.dispositions ?? []).filter((item) => item.rule_id === ruleId);
}
function renderDetail() {
  const rule = state.world?.rules?.find((item) => item.rule_id === state.ruleId);
  show("inspector-empty", !rule);
  show("rule-detail", Boolean(rule));
  if (!rule) return;
  const component = componentFor(rule);
  const breadcrumb = byId("review-breadcrumb"); breadcrumb.replaceChildren();
  for (const [label, action] of [[state.world.journal_name, () => selectComponent(null)], [component.label, () => selectComponent(component.id)]]) {
    const button = element("button", "text-button", label); button.type = "button"; button.addEventListener("click", action);
    breadcrumb.append(button, element("span", "", "/"));
  }
  breadcrumb.append(element("strong", "crumb-current", ruleLabel(rule)));
  const result = resultFor(rule);
  const check = visibleCheck();
  const verdict = result?.verdict ?? "not_checked";
  byId("detail-label").textContent = ruleLabel(rule);
  byId("detail-verdict").textContent = resultLabel(verdict, check);
  byId("detail-verdict").className = `status-badge ${tone(verdict, rule.basis_status, check?.validity)}`;
  byId("detail-basis").textContent = labels[rule.basis_status];
  byId("detail-validity").textContent = versionLabel(state.world);
  byId("detail-expected").textContent = formatValue(rule.expected, rule.unit);
  const disposition = dispositionsFor(rule.rule_id).at(-1);
  const axes = [
    ["依据", labels[rule.basis_status]],
    ["适用", result ? labels[result.applicability] : "尚未检查"],
    ["结论", labels[verdict]],
    ["结果状态", check ? labels[check.validity] : "尚未检查"],
    ["处理", disposition ? labels[disposition.action] : "未记录"],
  ];
  byId("status-axes").replaceChildren(...axes.flatMap(([name, value]) => [element("dt", "", name), element("dd", "", value)]));
  const evidenceContainer = byId("rule-evidence");
  evidenceContainer.replaceChildren();
  if (rule.resolution) {
    const resolution = rule.resolution;
    const decision = element("div", "resolution-card");
    decision.append(element("strong", "", "本次人工确认"), element("div", "resolution-change", `${formatValue(resolution.previous_expected, rule.unit)} → ${formatValue(resolution.expected, rule.unit)}`), element("p", "", resolution.reason), element("div", "evidence-source", `记录人：${resolution.actor_id === "local-operator" ? "本地操作员" : resolution.actor_id}`), element("span", "resolution-provenance", "原始来源摘录保留在下方，本次确认不改写来源。"));
    evidenceContainer.append(decision);
  }
  const evidenceCards = [];
  for (const evidence of rule.evidence) {
    const card = element("div", "evidence-card");
    card.append(element("div", "evidence-source", sourceName(evidence.source_id)), evidenceQuote(evidence));
    evidenceContainer.append(card);
    evidenceCards.push(card);
  }
  renderSourceReview({ review: state.review, world: state.world, rule, evidenceCards, selectRule, loadPage: api });
  if (!evidenceContainer.childElementCount) evidenceContainer.append(element("p", "evidence-unavailable", "尚无可展示的来源证据，请补充资料或确认依据。"));
  const findings = result?.findings ?? [];
  byId("finding-count").textContent = result ? `${result.coverage.observed_sections}/${result.coverage.total_sections} 节有声明值` : "";
  const findingsContainer = byId("rule-findings");
  findingsContainer.replaceChildren();
  for (const finding of findings) {
    const card = element("div", "finding");
    const header = element("div", "finding-header");
    header.append(element("span", "", finding.section_index !== null && finding.section_index !== undefined ? `第 ${finding.section_index} 节` : "稿件对象"), element("strong", "finding-observed", formatValue(finding.observed, rule.unit)));
    card.append(header);
    if (finding.verdict !== undefined) card.append(element("span", `status-badge ${tone(finding.verdict, rule.basis_status, check?.validity)}`, resultLabel(finding.verdict, check)));
    else card.append(element("span", "finding-message", "此历史记录未标注逐节结论。"));
    if (finding.message) card.append(element("p", "finding-message", userMessage(finding.message)));
    if (finding.locator) { const location=element("details","evidence-locator"); location.append(element("summary","","查看文档位置"),element("span","",finding.locator)); card.append(location); }
    findingsContainer.append(card);
  }
  if (!findings.length) findingsContainer.append(element("p", "evidence-unavailable", check ? "这项要求没有可核对的稿件观察，请结合结论与覆盖范围判断。" : "还没有检查记录。对照期刊后点右上角「检查论文」，这里会显示论文的声明值。"));
  const limits = [...rule.limitations, ...(result?.limitations ?? [])];
  if (result && result.coverage.missing_sections > 0) limits.unshift(`${result.coverage.missing_sections} 节缺少声明值，不能据此判定全部符合。`);
  byId("rule-limits").replaceChildren(...limits.map((limit) => element("li", "", userMessage(limit))));
  show("rule-limits-section", limits.length > 0);
  show("disposition-section", Boolean(check));
  byId("revise-value-label").textContent = rule.unit === "font_family" ? "要求字体" : rule.unit === "count" ? "要求栏数" : rule.unit === "twips" ? "要求值（毫米）" : "要求值（点）";
  byId("revise-expected").type = rule.unit === "font_family" ? "text" : "number";
  byId("revise-expected").step = rule.unit === "count" ? "1" : "any";
  byId("revise-expected").min = rule.property.endsWith("margin_twips") ? "0" : rule.unit === "count" ? "1" : String(25.4 / 1440);
  if (byId("revise-expected").dataset.originalValue === undefined) {
    const scale = rule.unit === "twips" ? 1440 / 25.4 : rule.unit === "half_points" ? 2 : rule.unit === "spacing_twips" ? 20 : 1;
    const value = rule.expected === null ? "" : rule.unit === "font_family" ? rule.expected : String(Number((rule.expected / scale).toFixed(4)));
    byId("revise-expected").value = value;
    byId("revise-expected").dataset.originalValue = value;
  }
  renderDispositions(rule.rule_id);
  const neighbors = byId("rule-neighbors"); neighbors.replaceChildren();  for (const neighbor of state.world.rules.filter((item) => component.properties.includes(item.property))) {
    const button = element("button", "rule-neighbor"); button.type = "button";
    button.setAttribute("aria-current", String(neighbor.rule_id === rule.rule_id));
    button.append(element("span", "", ruleLabel(neighbor)), element("span", "muted", formatValue(neighbor.expected, neighbor.unit)));
    button.addEventListener("click", () => selectRule(neighbor.rule_id)); neighbors.append(button);
  }
}
function renderDispositions(ruleId) {
  const container = byId("disposition-history");
  container.replaceChildren();
  for (const item of dispositionsFor(ruleId)) {
    const entry = element("div", "disposition-entry");
    entry.append(element("strong", "", `${labels[item.action]} · ${formatDate(item.created_at)}`), element("p", "", item.note));
    container.append(entry);
  }
}

async function selectWorld(versionId) {
  if (state.busy || !mayLeaveRule()) return;
  await perform("正在读取期刊版本…", async () => {
    const request = ++state.readRequest;
    const [world, review] = await Promise.all([fetchWorld(versionId), fetchReview(versionId)]);
    if (request !== state.readRequest) return;
    clearDraft(); state.world = world; state.review = review; state.workspace = "map"; state.ruleId = null; state.componentId = null;
    if (!world.rules.some((rule) => rule.rule_id === state.ruleId)) state.ruleId = null;
    renderAll();
  });
}
function openDialog(id) {
  if (state.busy) return;
  const dialog = byId(id);
  dialog.showModal();
}
function closeDialog(dialog) {
  if (!state.busy) dialog.close();
}
function sourceKind(source) {
  const extension = source.file.name.split(".").at(-1).toLowerCase();
  if (source.role === "template" && extension === "docx") return "template_docx";
  if (source.role === "component" && extension === "json") return "rule_component_json";
  if (source.role === "guide") {
    if (extension === "docx") return "guide_docx";
    if (extension === "pdf") return "guide_pdf";
    if (["txt", "md"].includes(extension)) return "guide_text";
  }
  return null;
}
function renderSources() {
  const container = byId("source-list");
  container.replaceChildren();
  if (!state.sources.length) container.append(element("p", "source-empty", "添加文件后，为每个文件选择用途。"));
  for (const [index, source] of state.sources.entries()) {
    const row = element("div", "source-row");
    const name = element("div");
    name.append(element("div", "source-name", source.file.name), element("div", "source-size", `${Math.max(1, Math.round(source.file.size / 1024))} KB`));
    name.querySelector(".source-name").prepend(icon("file"));
    const select = element("select");
    select.setAttribute("aria-label", `${source.file.name} 的用途`);
    select.append(new Option("选择文件用途", ""), new Option("期刊模板", "template"), new Option("投稿指南", "guide"), new Option("共享规则组件", "component"));
    select.value = source.role;
    select.addEventListener("change", () => { source.role = select.value; renderSources(); });
    const remove = element("button", "icon-button");
    remove.type = "button";
    remove.setAttribute("aria-label", `移除 ${source.file.name}`);
    remove.append(icon("x"));
    remove.addEventListener("click", () => { state.sources.splice(index, 1); renderSources(); });
    row.append(name, select, remove);
    if (source.role && !sourceKind(source)) row.append(element("p", "inline-error", "此文件格式与所选用途不匹配，请重新选择。"));
    if (sourceKind(source) === "guide_pdf") row.append(element("p", "field-help", "PDF 会保存为来源，文字规则尚无法提取。"));
    container.append(row);
  }
}
function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(new Error(`无法读取“${file.name}”，请重新选择文件。`));
    reader.readAsDataURL(file);
  });
}
async function submitWorld(event) {
  event.preventDefault();
  const journalName = byId("journal-name").value.trim();
  if (!journalName) { errorAt("world-form-error", "请填写期刊名称。"); byId("journal-name").focus(); return; }
  if (!state.sources.length) { errorAt("world-form-error", "请至少添加一个来源文件，并指定用途。"); return; }
  const invalidIndex = state.sources.findIndex((source) => !sourceKind(source));
  if (invalidIndex >= 0) { errorAt("world-form-error", "请为每个文件选择与格式匹配的用途。"); byId("source-list").querySelectorAll("select")[invalidIndex].focus(); return; }
  await perform("正在导入期刊资料并提取页面规则…", async () => {
    const sources = await Promise.all(state.sources.map(async (source) => ({ name: source.file.name, kind: sourceKind(source), content_base64: await fileBase64(source.file) })));
    const existing = state.worlds.find((world) => world.journal_name.normalize("NFKC").toLowerCase() === journalName.normalize("NFKC").toLowerCase());
    const nameHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(journalName.normalize("NFKC").toLowerCase()))), (value) => value.toString(16).padStart(2, "0")).join("");
    const world = await api("/api/worlds", {
      journal_id: byId("journal-code").value.trim() || existing?.journal_id || `journal-${nameHash.slice(0, 24)}`, journal_name: journalName,
      article_type: byId("article-type").value, stage: byId("submission-stage").value,
      language: byId("world-language").value, sources,
    });
    clearDraft();
    byId("world-dialog").close();
    byId("world-form").reset(); state.sources = []; renderSources();
    await refreshAfterWrite("期刊版本已保存", world.version_id);
    success(`${world.journal_name} 已导入。`);
  }, "world-form-error");
}
async function submitProject(event) {
  event.preventDefault();
  const file = byId("project-file").files[0];
  if (!byId("project-name").value.trim()) { errorAt("project-form-error", "请填写论文名称。"); byId("project-name").focus(); return; }
  if (!file || !file.name.toLowerCase().endsWith(".docx")) { errorAt("project-form-error", "请选择 DOCX 格式的论文。"); return; }
  await perform("正在保存论文源版本…", async () => {
    const project = await api("/api/projects", { name: byId("project-name").value.trim(), filename: file.name, content_base64: await fileBase64(file) });
    clearDraft();
    byId("project-dialog").close(); byId("project-form").reset();
    show("project-file-name", false);
    await refreshAfterWrite("论文已保存", undefined, project.project_id);
    if (state.workspace === "manuscript") await manuscriptWorkspace.open();
    await ensureManuscriptData();
    success("论文已导入，可阅读稿件或选择期刊检查。");
  }, "project-form-error");
}
async function bindWorld() {
  const project = selectedProject();
  if (!project || !state.world || !mayLeaveRule()) return;
  await perform("正在绑定选定的期刊版本…", async () => {
    await api("/api/bind", { project_id: project.project_id, world_version_id: state.world.version_id, expected_binding_id: project.binding?.binding_id || null });
    clearDraft(); await refreshAfterWrite("版本绑定已保存");
    success("期刊已绑定，可以检查论文。");
  });
}
async function runCheck() {
  const project = selectedProject();
  if (!project?.binding || !mayLeaveRule()) return;
  await perform("正在逐节对照已绑定的页面规则…", async () => {
    await api("/api/check", { project_id: project.project_id });
    clearDraft();
    await refreshAfterWrite("检查记录已保存", project.binding.world_version_id);
    await ensureManuscriptData();
    success("检查完成。点开任意要求，查看出处与论文情况。");
  });
}
async function saveDisposition(action) {
  const check = visibleCheck();
  const note = byId("disposition-note").value.trim();
  if (!check || !state.ruleId) return;
  if (!note) { errorAt("disposition-error", "请填写备注或暂缓原因。"); byId("disposition-note").focus(); return; }
  const ruleId = state.ruleId;
  await perform("正在保存处理意见…", async () => {
    await api("/api/disposition", { check_id: check.check_id, rule_id: ruleId, action, note });
    byId("disposition-note").value = "";
    try {
      const updated = await api(`/api/check?check_id=${encodeURIComponent(check.check_id)}`);
      if (updated.check_id !== check.check_id || updated.project_id !== check.project_id) throw new Error("返回的检查记录身份不一致。");
      state.check = updated; renderAll();
    } catch (error) {
      state.synchronized = false; state.check = null; renderAll();
      throw new Error(`处理意见已保存，但未能刷新记录，请先刷新工作区，不要重复提交。${error instanceof Error ? error.message : ""}`);
    }
    success("处理意见已保存，原检查结论保留。");
  }, "disposition-error");
}
async function reviseRule(event) {
  event.preventDefault();
  const rule = state.world?.rules?.find((item) => item.rule_id === state.ruleId);
  const input = byId("revise-expected").value.trim();
  const numeric = Number(input);
  const reason = byId("revise-reason").value.trim();
  if (!rule || !input || !reason || (rule.unit !== "font_family" && (!Number.isFinite(numeric) || numeric < 0))) { errorAt("revise-error", "请填写有效的要求值和确认依据。"); return; }
  if (rule.unit === "count" && !Number.isInteger(numeric)) { errorAt("revise-error", "栏数需要填写整数。"); return; }
  const scale = rule.unit === "twips" ? 1440 / 25.4 : rule.unit === "half_points" ? 2 : rule.unit === "spacing_twips" ? 20 : 1;
  const expected = rule.unit === "font_family" ? input : Math.round(numeric * scale);
  if (rule.unit !== "font_family" && (!Number.isSafeInteger(expected) || (expected < 1 && !rule.property.endsWith("margin_twips")))) { errorAt("revise-error", "纸张尺寸和栏数必须大于零，请填写有效数值。"); return; }
  await perform("正在保存已确认规则的新版本…", async () => {
    const world = await api("/api/revise", { version_id: state.world.version_id, rule_id: rule.rule_id, expected, reason });
    clearDraft(); await refreshAfterWrite("规则新版本已保存", world.version_id);
    success(`${versionLabel(world)} 已保存。使用此版本后可重新检查论文。`);
  }, "revise-error");
}
function openDiff() {
  if (!state.world) return;
  const options = [...state.worlds].sort((left, right) => left.journal_name.localeCompare(right.journal_name, "zh-CN") || left.version_ordinal - right.version_ordinal);
  for (const id of ["diff-from", "diff-to"]) byId(id).replaceChildren(...options.map((world) => new Option(`${world.journal_name} · ${versionLabel(world)}`, world.version_id)));
  byId("diff-from").value = state.world.version_id;
  const other = options.find((world) => world.journal_id === state.world.journal_id && world.version_id !== state.world.version_id) || options.find((world) => world.version_id !== state.world.version_id);
  byId("diff-to").value = other?.version_id || state.world.version_id;
  byId("diff-results").replaceChildren(element("p", "diff-empty", "选择两个版本，查看规则差异。"));
  errorAt("diff-error", ""); openDialog("diff-dialog");
}
async function runDiff() {
  const from = byId("diff-from").value, to = byId("diff-to").value;
  if (from === to) { errorAt("diff-error", "请选择两个不同的版本。"); return; }
  await perform("正在比较规则版本…", async () => {
    const diff = await api(`/api/diff?from_version=${encodeURIComponent(from)}&to_version=${encodeURIComponent(to)}`);
    if (diff.from_version !== from || diff.to_version !== to) throw new Error("服务返回的比较版本与所选版本不一致，请重新比较。");
    const container = byId("diff-results"); container.replaceChildren();
    const beforeWorld = state.worlds.find((world) => world.version_id === from);
    const afterWorld = state.worlds.find((world) => world.version_id === to);
    if (diff.journal_changed) container.append(element("div", "notice notice-warning", "正在进行跨刊对照。文章类型、投稿阶段与语言须一并核对，差异不等于可直接替换。"));
    if (diff.scope_changed) {
      const context = element("div", "notice notice-warning diff-context");
      context.append(element("strong", "", "适用范围发生变化"), element("p", "", `原版本：${scopeLabel(beforeWorld.scope)}`), element("p", "", `比较版本：${scopeLabel(afterWorld.scope)}`), element("p", "", "数值相同也不代表两个范围的规则可直接替换。"));
      container.append(context);
    }
    const head = element("div", "diff-row diff-row-head");
    head.append(element("span", "", "规则属性"), element("span", "", "原版本"), element("span", "", "比较版本")); container.append(head);
    for (const change of diff.changes) {
      const row = element("div", `diff-row ${change.status === "unchanged" ? "diff-unchanged" : "diff-change"}`);
      const description = element("div");
      description.append(element("strong", "", propertyLabels[change.property]), element("span", "diff-status", ({ added: "新增规则", removed: "移除规则", changed: "规则或依据变化", unchanged: "已比较内容相同" })[change.status]));
      const value = (rule) => {
        const cell = element("div");
        if (rule === null) { cell.append(element("span", "", "此版本无该规则")); return cell; }
        cell.append(element("strong", "", formatValue(rule.expected, rule.unit)), element("span", "diff-basis", labels[rule.basis_status]), element("span", "diff-scope", `${scopeLabel(rule.scope)} · ${rule.scope.section_scope === "all_sections" ? "全部分节" : rule.scope.section_scope}`));
        if (rule.resolution) cell.append(element("span", "diff-resolution", `修正理由：${rule.resolution.reason}`));
        const evidence = element("details", "diff-evidence");
        evidence.append(element("summary", "", `${rule.evidence.length} 条来源依据`));
        for (const item of rule.evidence) {
          const source = element("div", "evidence-card");
          source.append(element("div", "evidence-locator", item.locator), element("blockquote", "", item.quote));
          evidence.append(source);
        }
        cell.append(evidence);
        return cell;
      };
      row.append(description, value(change.before), value(change.after)); container.append(row);
    }
    if (!diff.changes.length) container.append(element("p", "diff-empty", "两个版本均未提取到可比较的页面规则；这不能证明投稿要求相同。"));
  }, "diff-error");
}
function downloadCheck() {
  const check = visibleCheck();
  if (!check) return;
  const blob = new Blob([JSON.stringify(check, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = element("a"); anchor.href = url; anchor.download = `journal-check-${check.check_id}.json`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function initialize() {
  if (state.pageReloadRequired) {
    globalError("页面与本地服务的界面版本已不同，请重新加载页面后继续操作。");
    return;
  }
  await perform("正在读取本地期刊与论文…", async () => {
    const session = await api("/api/session");
    if (session.contract_version !== HTTP_CONTRACT_VERSION) {
      state.token = null;
      state.pageReloadRequired = true;
      throw new Error("页面与本地服务版本不匹配，请更新并重启本地服务，再重新加载页面。");
    }
    if (state.assetVersion && state.assetVersion !== session.asset_version) {
      state.token = null;
      state.pageReloadRequired = true;
      throw new Error("本地服务已载入另一版界面，请重新加载页面后继续操作。");
    }
    state.token = session.token;
    state.assetVersion = session.asset_version;
    byId("connection-status").classList.add("connected");
    byId("connection-status").lastElementChild.textContent = "本地工作区";
    await refreshState();
  });
}

for (const id of ["new-world", "empty-import-world"]) byId(id).addEventListener("click", () => { errorAt("world-form-error", ""); openDialog("world-dialog"); });
byId("import-project").addEventListener("click", () => { errorAt("project-form-error", ""); openDialog("project-dialog"); });
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.querySelector(".dialog-close").addEventListener("click", () => closeDialog(dialog));
  dialog.addEventListener("cancel", (event) => { if (state.busy) event.preventDefault(); });
  dialog.addEventListener("click", (event) => {
    const rectangle = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rectangle.left || event.clientX > rectangle.right || event.clientY < rectangle.top || event.clientY > rectangle.bottom)) closeDialog(dialog);
  });
}
byId("world-files").addEventListener("change", (event) => {
  for (const file of event.target.files) state.sources.push({ file, role: "" });
  event.target.value = ""; renderSources();
});
byId("project-file").addEventListener("change", (event) => {
  const file = event.target.files[0];
  const chosen = byId("project-file-name");
  if (file) {
    chosen.replaceChildren(icon("doc"), element("span", "", file.name));
    show("project-file-name", true);
  } else show("project-file-name", false);
  if (!byId("project-name").value && file) byId("project-name").value = file.name.replace(/\.docx$/i, "");
});
byId("world-form").addEventListener("submit", submitWorld);
byId("project-form").addEventListener("submit", submitProject);
byId("project-name").addEventListener("input", () => errorAt("project-form-error", ""));
byId("journal-name").addEventListener("input", () => errorAt("world-form-error", ""));
byId("world-files").addEventListener("change", () => errorAt("world-form-error", ""));
byId("revise-form").addEventListener("submit", reviseRule);
byId("world-version").addEventListener("change", async (event) => { const version = event.target.value; event.target.value = state.world?.version_id || ""; await selectWorld(version); });
byId("project-select").addEventListener("change", async (event) => {
  const projectId = event.target.value;
  event.target.value = state.projectId || "";
  if (state.busy || !mayLeaveRule()) return;
  await perform("正在读取论文的绑定与检查记录…", async () => {
    const request = ++state.readRequest;
    const project = state.projects.find((item) => item.project_id === projectId);
    const check = await fetchProjectCheck(project);
    if (request !== state.readRequest) return;
    clearDraft(); state.projectId = projectId; state.check = check; state.workspace = "map"; renderAll();
  });
});
byId("bind-world").addEventListener("click", bindWorld);
byId("run-check").addEventListener("click", runCheck);
byId("journal-select").addEventListener("change", (event) => {
  const versionId = event.target.value;
  event.target.value = byId("journal-select").value = state.world
    ? (state.worlds.filter((item) => item.journal_id === state.world.journal_id).sort((left, right) => right.version_ordinal - left.version_ordinal)[0]?.version_id ?? "")
    : "";
  if (versionId && versionId !== state.world?.version_id) selectWorld(versionId);
});
byId("filter-all").addEventListener("click", () => { state.filter = "all"; renderMap(); });
byId("filter-issues").addEventListener("click", () => { state.filter = "issues"; renderMap(); });
byId("save-note").addEventListener("click", () => saveDisposition("note"));
byId("defer-rule").addEventListener("click", () => saveDisposition("defer"));
byId("view-update").addEventListener("click", () => selectWorld(byId("view-update").dataset.versionId));
byId("view-bound-world").addEventListener("click", () => selectWorld(selectedProject()?.binding?.world_version_id));
byId("compare-worlds").addEventListener("click", openDiff);
byId("run-diff").addEventListener("click", runDiff);
for (const id of ["diff-from", "diff-to"]) byId(id).addEventListener("change", () => {
  errorAt("diff-error", "");
  byId("diff-results").replaceChildren(element("p", "diff-empty", "所选版本已改变，点击“比较”查看这两个版本的差异。"));
});
byId("download-check").addEventListener("click", downloadCheck);
byId("refresh-state").addEventListener("click", () => { if (mayLeaveRule()) { clearDraft(); initialize(); } });
byId("retry-load").addEventListener("click", () => {
  if (!mayLeaveRule()) return;
  clearDraft();
  if (state.pageReloadRequired) window.location.reload();
  else initialize();
});
const manuscriptWorkspace = createManuscriptWorkspace({ api, perform, selectedProject, fileBase64, refreshAfterWrite, success, openImport: () => openDialog("project-dialog"), openReader: () => {state.workspace="manuscript";renderWorkspace();}, openCheck: async (check) => {
  const [world, review] = await Promise.all([fetchWorld(check.world_version_id), fetchReview(check.world_version_id)]);
  state.world = world; state.review = review; state.check = check; state.ruleId = null; state.workspace = "map"; renderAll();
} });
async function selectWorkspace(workspace) {
  if (state.busy || !mayLeaveRule()) return;
  clearDraft(); state.workspace = workspace; renderWorkspace();
  if (workspace === "manuscript") await manuscriptWorkspace.open();
  if (workspace === "history") await manuscriptWorkspace.history();
  if (workspace === "map") await ensureManuscriptData();
}
for (const view of ["map", "manuscript", "history"]) byId(`workspace-tab-${view}`).addEventListener("click", () => selectWorkspace(view));
byId("open-manuscript").addEventListener("click", () => selectWorkspace("manuscript"));
byId("reload-manuscript").addEventListener("click", () => manuscriptWorkspace.open());
byId("close-fragments").addEventListener("click", () => show("source-fragments", false));
let searchTimer = 0;
byId("rule-search").addEventListener("input", (event) => {
  const value = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = value; renderMap(); }, 140);
});
function closeInspector() {
  if (!state.ruleId || state.busy) return;
  if (!mayLeaveRule()) return;
  clearDraft();
  state.ruleId = null;
  renderAll();
}
byId("close-inspector").addEventListener("click", closeInspector);
byId("back-to-map").addEventListener("click", closeInspector);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.ruleId && !document.querySelector("dialog[open]")) closeInspector();
});
const bubbleRoot = byId("page-bubbles");
const bubblePopover = byId("bubble-popover");
function popoverParts(node) {
  const key = node.dataset.bubbleId;
  const rule = state.mapView === "manuscript"
    ? state.world?.rules.find((item) => item.property === key)
    : state.world?.rules.find((item) => item.rule_id === key);
  if (!rule) return null;
  const result = resultFor(rule);
  const observed = result?.findings.map((finding) => finding.observed).filter((value) => value !== null) ?? [];
  const observedText = !observed.length ? null : new Set(observed).size === 1 ? formatValue(observed[0], rule.unit) : "分节不一致";
  const quote = rule.evidence.find((item) => item.quote)?.quote;
  return [ruleLabel(rule),
    `要求 ${formatValue(rule.expected, rule.unit)}${observedText ? ` · 论文 ${observedText}` : ""}`,
    resultLabel(result?.verdict ?? "not_checked", visibleCheck()),
    quote ? (quote.length > 90 ? `${quote.slice(0, 90)}…` : quote) : null].filter(Boolean);
}
function showPopover(node) {
  const parts = popoverParts(node);
  if (!parts) return;
  bubblePopover.replaceChildren(...parts.map((text, index) => element(index === 0 ? "strong" : "span", index === 0 ? "popover-title" : "popover-line", text)));
  const canvasRect = mapCanvas.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  bubblePopover.hidden = false;
  const width = bubblePopover.offsetWidth;
  const height = bubblePopover.offsetHeight;
  let left = rect.left + rect.width / 2 - canvasRect.left;
  left = Math.max(width / 2 + 8, Math.min(canvasRect.width - width / 2 - 8, left));
  let top = rect.top - canvasRect.top - 10;
  if (top - height < 4) top = rect.bottom - canvasRect.top + 10;
  bubblePopover.style.left = `${left}px`;
  bubblePopover.style.top = `${top}px`;
}
bubbleRoot.addEventListener("mouseover", (event) => {
  const node = event.target.closest?.(".bubble-node");
  for (const line of bubbleRoot.querySelectorAll(".map-edges line.hot")) line.classList.remove("hot");
  const id = node?.dataset.bubbleId;
  if (id) for (const line of bubbleRoot.querySelectorAll(`.map-edges line[data-rule-id="${id}"]`)) line.classList.add("hot");
  if (node?.classList.contains("rule-bubble") && !state.busy) showPopover(node);
  else bubblePopover.hidden = true;
});
bubbleRoot.addEventListener("mouseout", (event) => {
  if (!event.target.closest?.(".bubble-node")) return;
  for (const line of bubbleRoot.querySelectorAll(".map-edges line.hot")) line.classList.remove("hot");
  bubblePopover.hidden = true;
});
function applySceneTransform() {
  byId("page-bubbles").style.transform = `translate(${state.panX}px, ${state.panY}px) rotateX(${sceneTilt.y}deg) rotateY(${sceneTilt.x}deg) scale(${state.zoom})`;
}
const sceneTilt = { x: 0, y: 0, targetX: 0, targetY: 0, raf: 0 };
const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
function tiltFrame() {
  sceneTilt.x += (sceneTilt.targetX - sceneTilt.x) * .1;
  sceneTilt.y += (sceneTilt.targetY - sceneTilt.y) * .1;
  applySceneTransform();
  if (Math.abs(sceneTilt.targetX - sceneTilt.x) > .02 || Math.abs(sceneTilt.targetY - sceneTilt.y) > .02) sceneTilt.raf = requestAnimationFrame(tiltFrame);
  else sceneTilt.raf = 0;
}
function tiltTo(targetX, targetY) {
  sceneTilt.targetX = targetX;
  sceneTilt.targetY = targetY;
  if (!sceneTilt.raf) sceneTilt.raf = requestAnimationFrame(tiltFrame);
}
byId("map-zoom-in").addEventListener("click", () => { state.zoom = Math.min(2, state.zoom + .1); applySceneTransform(); });
byId("map-zoom-out").addEventListener("click", () => { state.zoom = Math.max(.8, state.zoom - .1); applySceneTransform(); });
byId("map-reset").addEventListener("click", () => { state.zoom = 1; state.panX = 0; state.panY = 0; applySceneTransform(); renderMap(); });
const mapCanvas = byId("bubble-canvas");
mapCanvas.addEventListener("pointermove", (event) => {
  if (reduceMotionQuery.matches || state.busy) return;
  const rect = mapCanvas.getBoundingClientRect();
  tiltTo(((event.clientX - rect.left) / rect.width - .5) * -4, ((event.clientY - rect.top) / rect.height - .5) * 3);
});
mapCanvas.addEventListener("pointerleave", () => tiltTo(0, 0));
mapCanvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (state.busy) return;
  const next = Math.min(2, Math.max(.8, state.zoom + (event.deltaY < 0 ? .08 : -.08)));
  if (next !== state.zoom) { state.zoom = next; applySceneTransform(); }
}, { passive: false });
let mapPan = null;
mapCanvas.addEventListener("pointerdown", (event) => {
  if (state.ruleId && !event.target.closest(".bubble-node")) closeInspector();
  if (state.busy || event.button !== 0 || event.target.closest(".bubble-node")) return;
  mapPan = { x: event.clientX - state.panX, y: event.clientY - state.panY };
  mapCanvas.setPointerCapture(event.pointerId);
  mapCanvas.classList.add("panning");
});
mapCanvas.addEventListener("pointermove", (event) => {
  if (!mapPan) return;
  state.panX = event.clientX - mapPan.x;
  state.panY = event.clientY - mapPan.y;
  applySceneTransform();
});
for (const type of ["pointerup", "pointercancel"]) mapCanvas.addEventListener(type, () => { mapPan = null; mapCanvas.classList.remove("panning"); });
byId("map-view-journal").addEventListener("click", () => switchMapView("journal"));
byId("map-view-manuscript").addEventListener("click", () => switchMapView("manuscript"));
byId("empty-import-project").addEventListener("click", () => { errorAt("project-form-error", ""); openDialog("project-dialog"); });
window.addEventListener("beforeunload", (event) => {
  if (hasDraft() || document.querySelector('dialog[open][data-dirty="true"]') || (byId("world-dialog").open && state.sources.length)) { event.preventDefault(); event.returnValue = ""; }
});
initialize();
