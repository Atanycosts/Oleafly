import { byId, element, show, icon, formatValue } from "../ui/dom.js";
import { propertyLabels } from "../transport/contracts.js";
import { geometryProperties, evidenceQuote } from "../ui/presentation.js";

const fragmentLabels = { paragraph: "段落", sentence: "句子", table_cell: "表格单元", table: "表格", section: "分节", component: "规则组件", component_rule: "组件要求", source_quote: "来源引文", text_block: "段落", pdf_block: "PDF 文本块", pdf_heading: "PDF 标题", image: "图片节点", math: "公式节点", field: "域节点", break: "分页节点", reference: "引用节点", complex_object: "嵌入对象" };

const isPdfFragment = (fragment) => fragment.kind === "pdf_block" || fragment.kind === "pdf_heading";

/** Render the retained PDF page with the selected region highlighted; a derived reading aid. */
function pagePreview(loadPage, review, selected) {
  const first = selected[0];
  const page = first.content.page;
  const box = element("div", "page-preview");
  box.append(element("p", "page-preview-caption", `第 ${page} 页 · 由留存字节按请求渲染，仅辅助定位，不作为证据图`));
  const frame = element("div", "page-preview-frame");
  const img = element("img", "page-preview-image");
  img.alt = `来源第 ${page} 页预览`;
  const query = new URLSearchParams({ version_id: review.world_version_id, source_id: first.source_id, page: String(page) });
  const siblings = review.fragments.filter((item) => isPdfFragment(item) && item.source_id === first.source_id && item.content.page === page);
  loadPage(`/api/source-page?${query}`).then((pageData) => {
    img.src = `data:image/png;base64,${pageData.png_base64}`;
    img.addEventListener("error", () => box.append(element("p", "evidence-unavailable", "页面图像无法解码，请重试或刷新工作区。")));
    const draw = () => {
      const scale = img.clientWidth / pageData.width_pt;
      for (const item of siblings) {
        const chosen = selected.some((entry) => entry.fragment_id === item.fragment_id);
        const [x0, y0, x1, y1] = item.content.bbox;
        const overlay = element("div", `page-preview-highlight${chosen ? " chosen" : ""}`);
        overlay.style.left = `${x0 * scale}px`;
        overlay.style.top = `${y0 * scale}px`;
        overlay.style.width = `${(x1 - x0) * scale}px`;
        overlay.style.height = `${(y1 - y0) * scale}px`;
        frame.append(overlay);
      }
    };
    img.addEventListener("load", draw);
    frame.append(img);
  }).catch((error) => box.append(element("p", "evidence-unavailable", error instanceof Error ? error.message : "页面预览加载失败。")));
  box.append(frame);
  return box;
}

function fragmentCard(fragment, selected, loadPage, review) {
  const card = element("div", `fragment-card${selected ? " selected" : ""}`);
  const meta = element("div", "fragment-meta");
  meta.append(element("span", "", fragmentLabels[fragment.kind] ?? "文档节点"));
  if (fragment.char_start !== null) meta.append(element("span", "", `字符 ${fragment.char_start + 1}–${fragment.char_end}`));
  card.append(meta);
  if (fragment.kind === "docx_node" && fragment.content.object_type === "section") card.append(geometryProperties(fragment.content));
  else if (fragment.kind === "component_rule") card.append(evidenceQuote({quote:fragment.text}));
  else card.append(element("p", "fragment-text", fragment.text || "此节点没有可展示的文字。"));
  const details = element("details", "fragment-location");
  details.append(element("summary", "", "查看文档位置"), element("div", "evidence-locator", fragment.locator));
  if (fragment.part_path) details.append(element("div", "evidence-locator", fragment.part_path));
  card.append(details);
  if (isPdfFragment(fragment) && loadPage && review) card.append(pagePreview(loadPage, review, [fragment]));
  return card;
}

/** Open all retained source units, including material from which no rule was recognized. */
export function openSourceLibrary(review, world, loadPage) {
  const dialog = element("dialog", "dialog source-library");
  dialog.setAttribute("aria-label", "来源资料");
  const heading = element("div", "dialog-heading");
  const close = element("button", "icon-button"); close.type="button"; close.setAttribute("aria-label", "关闭来源资料"); close.append(icon("x")); close.addEventListener("click",()=>dialog.close());
  heading.append(element("h2", "", "来源资料"),close);
  const selector = element("select"); selector.setAttribute("aria-label", "选择来源");
  const names = new Map();
  for(const source of world.sources) names.set(source.source_id,[...(names.get(source.source_id) ?? []),source.name]);
  for(const [id,labels] of names) selector.append(new Option([...new Set(labels)].join(" / "),id));
  const search = element("input"); search.type="search"; search.placeholder="查找原文片段"; search.setAttribute("aria-label","查找原文片段");
  const toolbar=element("div","document-toolbar"); toolbar.append(selector,search);
  const content=element("div","source-library-content");
  const fragments=new Map(review.fragments.map((item)=>[item.fragment_id,item]));
  const openFragment=(fragmentId)=>{
    const fragment=fragments.get(fragmentId); content.replaceChildren();
    const back=element("button","text-button",fragment.parent_fragment_id ? "返回上级片段" : "返回来源列表"); back.type="button";
    back.addEventListener("click",()=>fragment.parent_fragment_id ? openFragment(fragment.parent_fragment_id) : renderList());
    content.append(back,fragmentCard(fragment,true,loadPage,review));
    for(const child of review.fragments.filter((item)=>item.parent_fragment_id===fragmentId)) content.append(fragmentButton(child));
  };
  const fragmentButton=(fragment)=>{
    const button=element("button","related-rule"); button.type="button";
    button.append(element("strong","",fragmentLabels[fragment.kind] ?? "文档节点"),element("p","related-excerpt",fragment.text.slice(0,150) || "查看源节点属性"));
    button.addEventListener("click",()=>openFragment(fragment.fragment_id)); return button;
  };
  const renderList=()=>{
    content.replaceChildren();
    const query=search.value.trim().toLocaleLowerCase();
    const selected=review.fragments.filter((item)=>item.source_id===selector.value && (query ? item.text.toLocaleLowerCase().includes(query) : item.parent_fragment_id===null));
    if(!selected.length) content.append(element("p","evidence-unavailable",query ? "没有匹配的片段。" : "此来源暂无可读取片段，可补充文本或 DOCX 资料。"));
    for(const fragment of selected) content.append(fragmentButton(fragment));
  };
  selector.addEventListener("change",renderList); search.addEventListener("input",renderList);
  dialog.append(heading,toolbar,content); dialog.addEventListener("close",()=>dialog.remove());
  document.body.append(dialog); renderList(); dialog.showModal();
}

/** Show an exact fragment with its parent context and children from the retained source. */
export function showFragments(review, fragmentIds, sourceName, loadPage) {
  const selected = new Set(fragmentIds);
  const fragments = review.fragments.filter((fragment) => selected.has(fragment.fragment_id));
  const container = byId("fragment-items"); container.replaceChildren();
  const context = byId("fragment-context"); context.replaceChildren();
  byId("fragment-heading").textContent = sourceName;
  show("source-fragments", true);
  if (!fragments.length) {
    container.append(element("p", "evidence-unavailable", "这份来源尚无可定位的文本片段。"));
    return;
  }
  const rendered = new Set();
  for (const fragment of fragments) {
    const parent = review.fragments.find((item) => item.fragment_id === fragment.parent_fragment_id);
    if (parent && !rendered.has(parent.fragment_id)) { context.append(fragmentCard(parent, false)); rendered.add(parent.fragment_id); }
    if (!rendered.has(fragment.fragment_id)) { container.append(fragmentCard(fragment, true)); rendered.add(fragment.fragment_id); }
    for (const child of review.fragments.filter((item) => item.parent_fragment_id === fragment.fragment_id)) {
      if (!rendered.has(child.fragment_id)) { container.append(fragmentCard(child, false)); rendered.add(child.fragment_id); }
    }
  }
  const selectedPdf = fragments.filter(isPdfFragment);
  const groups = new Map();
  for (const fragment of selectedPdf) {
    const key = `${fragment.source_id}:${fragment.content.page}`;
    groups.set(key, [...(groups.get(key) ?? []), fragment]);
  }
  for (const group of groups.values()) container.append(pagePreview(loadPage, review, group));
  byId("source-fragments").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** Add exact-source drill-down actions and ranked suggestions without altering rule state. */
export function renderSourceReview({ review, world, rule, evidenceCards, selectRule, loadPage }) {
  show("source-fragments", false);
  byId("evidence-count").textContent = `${rule.evidence.length} 条来源`;
  if (!review) { show("related-section", false); return; }
  for (const [index, card] of evidenceCards.entries()) {
    const link = review.rule_links.find((item) => item.rule_id === rule.rule_id && item.evidence_index === index);
    const located = link?.link_status === "located";
    const action = element("button", "text-button");
    action.type = "button";
    action.append(element("span", "", located ? "展开原文片段" : "查看来源缺口"), icon("arrow"));
    action.addEventListener("click", () => {
      const source = world.sources.find((item) => item.source_id === rule.evidence[index].source_id);
      showFragments(review, link?.fragment_ids ?? [], source?.name ?? "来源片段", loadPage);
    });
    card.append(action);
  }
  const sourceIds = new Set(rule.evidence.map((item) => item.source_id));
  const linkedComponents = new Set(review.fragments.filter((item) => item.kind === "component_rule" && sourceIds.has(item.source_id) && item.content.property === rule.property).map((item) => item.fragment_id));
  const related = review.relations.filter((relation) => relation.from_id === rule.rule_id || relation.to_id === rule.rule_id || (relation.kind === "possible_duplicate" && (linkedComponents.has(relation.from_id) || linkedComponents.has(relation.to_id)))).sort((left, right) => right.score - left.score);
  const container = byId("related-rules"); container.replaceChildren();
  show("related-section", related.length > 0);
  const relatedButton = (relation) => {
    const targetId = relation.from_id === rule.rule_id || linkedComponents.has(relation.from_id) ? relation.to_id : relation.from_id;
    const targetRule = world.rules.find((item) => item.rule_id === targetId);
    const fragment = review.fragments.find((item) => item.fragment_id === targetId);
    if (!targetRule && !fragment) return null;
    const button = element("button", "related-rule"); button.type = "button";
    const label = targetRule ? propertyLabels[targetRule.property] : relation.kind === "possible_duplicate" ? "可能重复的组件" : "相近的来源片段";
    button.append(element("strong", "", label), element("span", "", `${Math.round(relation.score * 100)}% 相近`));
    if (fragment) button.append(element("p", "related-excerpt", fragment.kind === "component_rule" ? `${propertyLabels[fragment.content.property]} · ${formatValue(fragment.content.expected,fragment.content.unit)}` : fragment.text));
    button.addEventListener("click", () => {
      if (targetRule) selectRule(targetRule.rule_id);
      else {
        const source = world.sources.find((item) => item.source_id === fragment.source_id);
        showFragments(review, relation.kind === "possible_duplicate" ? [relation.from_id, relation.to_id] : [fragment.fragment_id], relation.kind === "possible_duplicate" ? "两个独立组件" : source?.name ?? "来源片段", loadPage);
      }
    });
    return button;
  };
  const primary = related.filter((relation) => relation.kind === "possible_duplicate" || relation.score >= 0.5);
  const secondary = related.filter((relation) => relation.kind !== "possible_duplicate" && relation.score < 0.5);
  for (const relation of primary) { const button = relatedButton(relation); if (button) container.append(button); }
  if (secondary.length) {
    const more = element("details", "related-more");
    more.append(element("summary", "", `其他用词相近的来源 · ${secondary.length}`));
    for (const relation of secondary) { const button = relatedButton(relation); if (button) more.append(button); }
    container.append(more);
  }
}
