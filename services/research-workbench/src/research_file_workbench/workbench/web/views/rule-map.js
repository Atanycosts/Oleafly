import { element, formatValue } from "../ui/dom.js";
import { propertyLabels } from "../transport/contracts.js";

const COMPONENTS = [
  { id: "paper", label: "纸张", description: "页面尺寸", properties: ["page_width_twips", "page_height_twips"], x: 27, y: 45 },
  { id: "margins", label: "页边距", description: "四侧留白", properties: ["top_margin_twips", "right_margin_twips", "bottom_margin_twips", "left_margin_twips"], x: 73, y: 50 },
  { id: "columns", label: "分栏", description: "正文栏数", properties: ["columns"], x: 26, y: 75 },
];
const RULE_POSITIONS = {
  page_width_twips: [13, 27], page_height_twips: [13, 63],
  top_margin_twips: [72, 24], right_margin_twips: [89, 37],
  bottom_margin_twips: [72, 76], left_margin_twips: [89, 63], columns: [45, 84],
};
const DETAIL_POSITIONS = [[27, 26], [73, 26], [27, 74], [73, 74]];
const WORLD_POSITION = [50, 50];
const SVG_NS = "http://www.w3.org/2000/svg";

/** Return the presentation group for an implemented page-geometry property. */
export function componentFor(rule) {
  return COMPONENTS.find((component) => component.properties.includes(rule.property));
}

function svgLine(from, to, related = false) {
  const line = document.createElementNS(SVG_NS, "line");
  for (const [key, value] of Object.entries({ x1: from[0], y1: from[1], x2: to[0], y2: to[1] })) line.setAttribute(key, String(value));
  if (related) line.classList.add("related");
  return line;
}

function bubble({ label, value, count, state, kind, x, y, select, selected, disabled, tooltip, id }) {
  const button = element("button", `bubble-node ${kind}`);
  button.type = "button";
  button.disabled = disabled;
  button.style.setProperty("--x", String(x));
  button.style.setProperty("--y", String(y));
  if (id) button.dataset.bubbleId = id;
  button.setAttribute("aria-pressed", String(Boolean(selected)));
  button.setAttribute("aria-label", [label, value ?? count, state].filter(Boolean).join("，"));
  if (tooltip) button.title = tooltip;
  const shadow = element("span", "bubble-shadow");
  shadow.setAttribute("aria-hidden", "true");
  const body = element("span", "bubble-body");
  body.append(element("span", "bubble-name", label));
  if (value) body.append(element("span", "bubble-value", value));
  if (count) body.append(element("span", "bubble-count", count));
  if (state) body.append(element("span", "bubble-state", state));
  button.append(shadow, body);
  button.addEventListener("click", select);
  return button;
}

/** Render the world/component/rule map; colors only represent supplied check states. */
export function renderRuleMap({ world, review, selectedComponent, search, rules, ruleId, busy, getState, selectRule, selectComponent, selectSources, root, components, breadcrumb, zoom, pan = [0, 0] }) {
  root.replaceChildren(); components.replaceChildren(); breadcrumb.replaceChildren();
  root.style.transform = `translate(${pan[0]}px, ${pan[1]}px) scale(${zoom})`;
  if (!world) return;
  const home = element("button", "text-button", world.journal_name);
  home.type = "button"; home.addEventListener("click", () => selectComponent(null));
  breadcrumb.append(home, element("span", "", "/"), element("span", "", "要求类别"));
  const selected = COMPONENTS.find((component) => component.id === selectedComponent);
  if (selected) breadcrumb.append(element("span", "", "/"), element("strong", "crumb-current", selected.label));
  const edges = document.createElementNS(SVG_NS, "svg");
  edges.setAttribute("viewBox", "0 0 100 100"); edges.setAttribute("preserveAspectRatio", "none"); edges.setAttribute("aria-hidden", "true"); edges.classList.add("map-edges");
  root.append(edges);
  const positions = new Map();
  const searching = Boolean(search);
  const visibleRules = selected ? rules.filter((rule) => selected.properties.includes(rule.property)) : rules;
  if (selected || searching) {
    root.append(bubble({ label: selected?.label ?? "搜索结果", count: `${visibleRules.length} 条`, state: "返回总览", kind: "component-bubble", x: 50, y: 50, select: () => selectComponent(null), disabled: busy }));
    visibleRules.forEach((rule, index) => {
      const position = selected ? DETAIL_POSITIONS[index] : RULE_POSITIONS[rule.property];
      positions.set(rule.rule_id, position);
      edges.append(svgLine([50, 50], position));
    });
  } else {
    root.append(bubble({ label: world.journal_name, count: `${world.rules.length} 条要求`, kind: "world-bubble hub", x: WORLD_POSITION[0], y: WORLD_POSITION[1], select: selectSources, disabled: busy, tooltip: "打开全部来源资料" }));
    for (const component of COMPONENTS) {
      const members = visibleRules.filter((rule) => component.properties.includes(rule.property));
      if (!members.length) continue;
      const position = [component.x, component.y];
      edges.append(svgLine(WORLD_POSITION, position));
      root.append(bubble({ label: component.label, count: `${members.length} 条`, kind: "component-bubble", x: component.x, y: component.y, select: () => selectComponent(component.id), disabled: busy }));
      for (const rule of members) {
        positions.set(rule.rule_id, RULE_POSITIONS[rule.property]);
        const line = svgLine(position, RULE_POSITIONS[rule.property]);
        line.dataset.ruleId = rule.rule_id;
        edges.append(line);
      }
    }
  }
  for (const relation of review?.relations ?? []) {
    if (relation.kind !== "related_rule" || !positions.has(relation.from_id) || !positions.has(relation.to_id)) continue;
    if (relation.from_id === ruleId || relation.to_id === ruleId) edges.append(svgLine(positions.get(relation.from_id), positions.get(relation.to_id), true));
  }
  for (const rule of visibleRules) {
    const position = positions.get(rule.rule_id);
    if (!position) continue;
    const appearance = getState(rule);
    const quote = rule.evidence.find((item) => item.quote)?.quote;
    const excerpt = quote ? (quote.length > 80 ? `${quote.slice(0, 80)}…` : quote) : "";
    root.append(bubble({ label: propertyLabels[rule.property], value: formatValue(rule.expected, rule.unit), kind: `rule-bubble ${appearance.tone}${appearance.blink ? ` ${appearance.blink}` : ""}`, x: position[0], y: position[1], select: () => selectRule(rule.rule_id), selected: ruleId === rule.rule_id, disabled: busy, tooltip: excerpt ? `${appearance.label} · ${excerpt}` : appearance.label, id: rule.rule_id }));
  }
  for (const [index, component] of COMPONENTS.entries()) {
    const members = world.rules.filter((rule) => component.properties.includes(rule.property));
    if (!members.length) continue;
    const button = element("button", "component-card");
    button.type = "button"; button.disabled = busy; button.setAttribute("aria-pressed", String(selectedComponent === component.id));
    const copy = element("span", "component-copy");
    copy.append(element("strong", "", component.label), element("span", "", `${component.description} · ${members.length} 条要求`));
    button.append(element("span", "component-number", String(index + 1).padStart(2, "0")), copy, element("span", "component-arrow", "→"));
    button.addEventListener("click", () => selectComponent(component.id)); components.append(button);
  }
}

export { bubble as bubbleNode, svgLine, RULE_POSITIONS };
