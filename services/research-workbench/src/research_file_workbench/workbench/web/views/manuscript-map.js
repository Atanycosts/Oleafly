import { element, formatValue } from "../ui/dom.js";
import { propertyLabels } from "../transport/contracts.js";
import { bubbleNode, svgLine, RULE_POSITIONS } from "./rule-map.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const HUB_POSITION = [50, 50];

/** Observed manuscript values for one property, from the check's per-section findings. */
function observedValue(result) {
  if (!result) return null;
  const observed = result.findings.map((finding) => finding.observed).filter((value) => value !== null);
  if (!observed.length) return null;
  return new Set(observed).size === 1 ? observed[0] : "mixed";
}

/** Render the manuscript's declared geometry as a bubble field around the manuscript. */
export function renderManuscriptMap({ root, breadcrumb, project, data, check, busy, filter, search, getAppearance, selectProperty, openManuscript, openImport }) {
  root.replaceChildren(); breadcrumb.replaceChildren();
  breadcrumb.append(element("strong", "crumb-current", project ? project.name : "论文实况"));
  if (project) breadcrumb.append(element("span", "", "/"), element("span", "", "实况对照"));
  if (!project) {
    const empty = element("div", "empty-state");
    empty.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;";
    empty.append(element("h2", "", "还没有论文"), element("p", "", "导入一篇论文，这里会摆出它的实况地图。"));
    const cta = element("button", "button button-primary", "导入论文"); cta.type = "button";
    cta.addEventListener("click", openImport);
    empty.append(cta);
    root.append(empty);
    return {};
  }
  const sectionCount = (data?.catalog.items ?? []).filter((item) => item.object_type === "section").length;
  const edges = document.createElementNS(SVG_NS, "svg");
  edges.setAttribute("viewBox", "0 0 100 100"); edges.setAttribute("preserveAspectRatio", "none"); edges.setAttribute("aria-hidden", "true"); edges.classList.add("map-edges");
  root.append(edges);
  root.append(bubbleNode({ label: project.name, count: `${sectionCount} 个分节`, kind: "world-bubble hub", x: HUB_POSITION[0], y: HUB_POSITION[1], select: openManuscript, disabled: busy, tooltip: "打开稿件阅读" }));
  const query = String(search || "").trim().toLocaleLowerCase();
  let visible = 0;
  for (const property of Object.keys(propertyLabels)) {
    const label = propertyLabels[property];
    if (query && !label.toLocaleLowerCase().includes(query)) continue;
    const result = check?.rule_results.find((item) => item.property === property) ?? null;
    const verdict = result?.verdict ?? "not_checked";
    if (filter === "issues" && check && result && !["violation", "observed_difference", "cannot_determine", "not_checked"].includes(verdict)) continue;
    const observed = observedValue(result);
    const position = RULE_POSITIONS[property];
    const line = svgLine(HUB_POSITION, position);
    line.dataset.ruleId = result?.rule_id ?? property;
    edges.append(line);
    const unit = property === "columns" ? "count" : property === "body_font_size_halfpoints" ? "half_points" : property === "body_line_spacing_twips" ? "spacing_twips" : "twips";
    const value = !check ? "待读取" : property === "body_font_family" ? "未检查" : observed === null ? "未声明" : observed === "mixed" ? "分节不一致" : formatValue(observed, unit);
    const appearance = check ? getAppearance(verdict, check) : null;
    const tone = appearance ? appearance.tone : "tone-undeclared";
    const blink = appearance?.blink ?? "";
    visible += 1;
    root.append(bubbleNode({ label, value, kind: `rule-bubble ${tone}${blink ? ` ${blink}` : ""}`, x: position[0], y: position[1], select: () => selectProperty(property), disabled: busy, tooltip: !check ? "检查后会显示论文的声明值" : `${appearance.label}${observed && observed !== "mixed" ? ` · 论文声明 ${value}` : ""}`, id: result?.rule_id ?? property }));
  }
  return { visible };
}
