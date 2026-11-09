const SVG_NS = "http://www.w3.org/2000/svg";
const byId = (id) => document.getElementById(id);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function icon(name, className = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `icon${className ? ` ${className}` : ""}`);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
function show(id, visible) { byId(id).hidden = !visible; }
function errorAt(id, message) { byId(id).textContent = message || ""; show(id, Boolean(message)); }
function announce(message) { byId("screen-reader-status").textContent = message; }
function formatDate(value) {
  if (!value) return "未记录时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待确认" : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}
function formatValue(value, unit) {
  if (value === null || value === undefined) return "待确认";
  if (typeof value !== "number") return String(value);
  if (unit === "twips") return `${Number((value * 25.4 / 1440).toFixed(2))} mm`;
  if (unit === "half_points") return `${Number((value / 2).toFixed(1))} pt`;
  if (unit === "spacing_twips") return `${Number((value / 20).toFixed(1))} pt`;
  if (unit === "count") return `${value} 栏`;
  return String(value);
}
function versionLabel(world) { return `版本 ${world.version_ordinal ?? "—"}`; }

export { byId, element, icon, show, errorAt, announce, formatDate, formatValue, versionLabel };
