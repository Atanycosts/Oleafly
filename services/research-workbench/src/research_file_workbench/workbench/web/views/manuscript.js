import { byId, element, icon, formatDate, formatValue } from "../ui/dom.js";
import { propertyLabels } from "../transport/contracts.js";
import { userMessage, geometryProperties } from "../ui/presentation.js";

const PAGE_SIZE = 30;
const objectLabels = { text_block: "段落", table: "表格", image: "图片", math: "公式", field: "域", section: "分节", break: "分页与换行", complex_object: "嵌入对象", reference: "引用" };
const regionLabels = { body: "正文", header: "页眉", footer: "页脚", footnote: "脚注", endnote: "尾注", textbox: "文本框" };
const fieldLabels = {
  body_font_size_halfpoints: "正文字号（半点）", body_line_spacing_twips: "正文行距（缇）",
  ...propertyLabels, header_margin_twips: "页眉距离", footer_margin_twips: "页脚距离", gutter_twips: "装订线", column_space_twips: "栏间距",
  section_index: "分节", orientation: "纸张方向", section_type: "分节类型", attached_to: "关联位置", text: "文字", paragraph_style_id: "段落样式", hidden: "隐藏文字", caption: "题注",
  revision_state: "修订状态", numbering_id: "编号", numbering_level: "编号级别", contains_field_code: "包含域代码", contains_omml: "包含公式", parse_status: "读取情况", name: "名称", container: "排版方式", width_emu: "宽度", height_emu: "高度", wrap_type: "环绕方式",
  kind: "类型", instruction: "域指令", result_text: "显示结果", field_kind: "域类型", nested_level: "嵌套层级", occurrence_index: "出现次序", protected_reason: "保留原因", reference_name: "引用名称", reference_id: "引用编号", break_type: "换行类型",
  resource_part: "图像资源", target_part: "目标部件", grid_widths_twips: "网格宽度", repeat_header_rows: "重复表头", relationship_id: "文档关系", docpr_id: "图形编号", unconfirmed_fields: "待确认属性", limitations: "读取限制",
};
const valueLabels = { none: "无", inserted: "插入", deleted: "删除", mixed: "混合", parsed: "已读取", partial: "部分读取", unverified: "未核对", unsupported: "无法读取", registered: "已登记", inline: "嵌入行内", anchored: "浮动", unknown: "未确定", landscape: "横向", portrait: "纵向", paragraph: "段落", body: "正文", display: "独立公式", page: "分页", column: "分栏", textWrapping: "换行", nextPage: "下一页", continuous: "连续", oddPage: "奇数页", evenPage: "偶数页" };

function button(label, className, action) {
  const node = element("button", className, label); node.type = "button"; node.addEventListener("click", action); return node;
}
function selectField(label, choices, value, change) {
  const wrapper = element("label", "", label); const select = element("select");
  select.append(...choices.map(([id, title]) => new Option(title,id))); select.value = value;
  select.addEventListener("change", () => change(select.value)); wrapper.append(select); return wrapper;
}
function displayValue(key, value) {
  if (value === null || value === undefined) return "未声明";
  if (typeof value === "boolean") return value ? "有" : "无";
  if (Array.isArray(value)) return value.length ? value.map((item) => key === "unconfirmed_fields" ? fieldLabels[item] ?? item : displayValue(key,item)).join("、") : "无";
  if (key.endsWith("_twips") && typeof value === "number") return formatValue(value,"twips");
  if (key.endsWith("_emu") && typeof value === "number") return `${Number((value / 36000).toFixed(2))} mm`;
  return valueLabels[value] ?? userMessage(String(value));
}
function documentObject(item) {
  const article = element("article", "document-object");
  const content = item.content;
  article.append(element("h2", "", objectLabels[item.object_type] ?? "文档对象"));
  if (item.object_type === "table") {
    const table = element("table", "object-table");
    for (const row of content.rows) {
      const tr = element("tr");
      for (const cell of row) { const td = element("td", "", cell.text); td.colSpan = cell.grid_span; tr.append(td); }
      table.append(tr);
    }
    article.append(table);
  } else if (typeof content.text === "string") article.append(element("p", "object-text", content.text || "此对象没有文字。"));
  else if (typeof content.result_text === "string") article.append(element("p", "object-text", content.result_text || "此域没有显示结果。"));
  if (item.object_type === "section") article.append(geometryProperties(content));
  const properties = element("dl", "object-properties");
  for (const [key,value] of Object.entries(content)) {
    if (!Object.hasOwn(fieldLabels,key) || ["text","result_text"].includes(key)) continue;
    properties.append(element("dt", "", fieldLabels[key]), element("dd", "", displayValue(key,value)));
  }
  if (properties.childElementCount) article.append(properties);
  const location = element("details", "object-location"); location.append(element("summary", "", "查看文档位置"), element("p", "", item.range_locator), element("p", "", item.part_path)); article.append(location);
  if (content.omml_source) { const formula = element("details", "object-location"); formula.append(element("summary", "", "查看公式源内容"), element("pre", "", content.omml_source)); article.append(formula); }
  return article;
}

/** Connect saved project capabilities to the manuscript and history workspaces. */
export function createManuscriptWorkspace({ api, perform, selectedProject, fileBase64, refreshAfterWrite, success, openImport, openCheck, openReader }) {
  const state = { workspace: null, response: null, selectedObjectId: null, type: "", region: "", baselineId: "current", bundleId: "", pageNumber: null, history: null };
  const container = () => byId("manuscript-content");
  const empty = (target) => {
    const panel = element("div", "document-empty"); panel.append(element("h2", "", "导入一份论文"), element("p", "", "浏览段落、表格、公式与其他文档对象。"), button("导入论文", "button button-primary", openImport)); target.replaceChildren(panel);
  };
  async function fetchWorkspace(baselineId = "current") {
    const project = selectedProject();
    const workspace = await api(`/api/manuscript?project_id=${encodeURIComponent(project.project_id)}&baseline_id=${encodeURIComponent(baselineId)}`);
    if (workspace.project.project_id !== project.project_id || (baselineId !== "current" && workspace.baseline.baseline_id !== baselineId)) throw new Error("返回的稿件版本与所选论文不同，请刷新工作区。");
    state.workspace = workspace; state.baselineId = baselineId; state.response = null; state.selectedObjectId = null; state.bundleId = ""; state.pageNumber = null;
    byId("manuscript-title").textContent = project.name;
    render();
  }
  async function open() {
    if (!selectedProject()) { empty(container()); return; }
    await perform("正在读取稿件目录…", () => fetchWorkspace());
  }
  async function readObject(objectId, cursor = null) {
    await perform("正在读取所选稿件内容…", async () => {
      const projectId = state.workspace.project.project_id;
      const response = await api("/api/read", { project_id: projectId, baseline_id: state.workspace.baseline.baseline_id, render_bundle_id: state.pageNumber ? state.bundleId : null,
        query: { region: state.region || null, object_type: state.type || null, object_id: objectId, page_number: state.pageNumber, page_size: PAGE_SIZE, cursor } });
      if (response.project.project_id !== projectId || response.project.baseline_id !== state.workspace.baseline.baseline_id || (objectId && !response.items.every((item) => item.object_id === objectId))) throw new Error("稿件读取结果与所选对象不一致，请重新读取。");
      state.response = response; state.selectedObjectId = objectId ?? response.items[0]?.object_id ?? null; render();
    });
  }
  function render() {
    const workspace = state.workspace;
    const target = container(); target.replaceChildren();
    const toolbar = element("div", "document-toolbar");
    const baselines = workspace.baselines.map((baseline,index) => [baseline.baseline_id, `稿件 ${index+1} · ${formatDate(baseline.created_at)}${baseline.baseline_id === workspace.project.baseline_id ? " · 当前" : ""}`]);
    toolbar.append(selectField("稿件版本", baselines, workspace.baseline.baseline_id, (id) => perform("正在读取稿件版本…", () => fetchWorkspace(id))));
    toolbar.append(selectField("对象类型", [["","全部对象"], ...workspace.catalog.object_types.map((type) => [type,objectLabels[type] ?? type])], state.type, (value) => { state.type=value; state.response=null; state.selectedObjectId=null; render(); }));
    toolbar.append(selectField("区域", [["","全部区域"], ...workspace.catalog.regions.map((region) => [region,regionLabels[region] ?? region])], state.region, (value) => { state.region=value; state.response=null; state.selectedObjectId=null; render(); }));
    toolbar.append(button("更新稿件", "text-button push", openBaselineDialog), button("添加页面资料", "text-button", openRenderDialog));
    toolbar.append(button("读取此范围", "button button-outline", () => readObject(null)));
    target.append(toolbar);
    if (workspace.render_bundles.length) {
      const pages = element("div", "document-toolbar page-toolbar");
      pages.append(selectField("页面资料", [["","按对象阅读"], ...workspace.render_bundles.map((bundle,index) => [bundle.bundle_id,`资料 ${index+1} · ${bundle.manifest.page_count} 页`])], state.bundleId, (value) => { state.bundleId=value; state.pageNumber=value ? 1 : null; state.response=null; render(); }));
      const bundle=workspace.render_bundles.find((item) => item.bundle_id===state.bundleId);
      if (bundle) {
        pages.append(selectField("页码", Array.from({length:bundle.manifest.page_count},(_,index) => [String(index+1),`第 ${index+1} 页`]), String(state.pageNumber), (value) => { state.pageNumber=Number(value); state.response=null; render(); }));
        const reviewedRead = button("读取已核对对象", "button button-outline", () => readObject(null));
        reviewedRead.disabled = bundle.manifest.mapping_status !== "reviewed";
        reviewedRead.dataset.unavailable = String(reviewedRead.disabled);
        pages.append(reviewedRead);
        if (reviewedRead.disabled) pages.append(element("span","muted","页面映射尚未独立核对"));
        const pdf = element("a","text-button","打开 PDF ↗"); pdf.href=renderUrl("pdf",null); pdf.target="_blank"; pdf.rel="noopener"; pages.append(pdf);
      }
      target.append(pages);
    }
    const grid = element("div", "document-grid");
    const tree = element("aside","document-tree"); tree.setAttribute("aria-label","稿件对象目录");
    const objects = workspace.catalog.items.filter((item) => (!state.type || item.object_type===state.type) && (!state.region || item.region===state.region));
    tree.append(element("h3","",`对象目录 · ${objects.length}`));
    for (const [index,item] of objects.entries()) {
      const node = button(`${objectLabels[item.object_type] ?? "对象"} ${index+1}`,"object-item", () => { state.pageNumber=null; state.bundleId=""; readObject(item.object_id); });
      node.setAttribute("aria-current",String(state.selectedObjectId===item.object_id)); node.append(element("small","",regionLabels[item.region] ?? "文档部件")); tree.append(node);
    }
    if (!objects.length) tree.append(element("p","evidence-unavailable","此范围没有已登记对象。"));
    const content = element("div","document-content");
    if (state.response) {
      for (const item of state.response.items) content.append(documentObject(item));
      if (!state.response.items.length) content.append(element("p","evidence-unavailable","此页尚无已核对的对象映射。"));
      if (state.response.pagination.has_more) content.append(button("继续读取","button button-outline load-more",() => readObject(null,state.response.pagination.next_cursor)));
    } else { const prompt=element("div","document-empty"); prompt.append(element("h2","",state.pageNumber ? `第 ${state.pageNumber} 页` : "选择一个对象"),element("p","",state.pageNumber ? "可查看页面，并读取已核对位置的对象。" : "在左侧选择段落、表格或其他内容。")); content.append(prompt); }
    if (state.bundleId && state.pageNumber) { const image=element("img","document-page"); image.src=renderUrl("page_image",state.pageNumber); image.alt=`稿件第 ${state.pageNumber} 页`; content.append(image); }
    const evidence = element("aside","document-evidence"); evidence.append(element("h3","","读取记录"));
    if (state.response) {
      evidence.append(element("span","status-badge tone-neutral","已读取 · 尚未人工核对"),element("p","",`${state.response.items.length} 个对象 · ${formatDate(state.response.read_receipt.created_at)}`));
      evidence.append(button("导出本次阅读记录","text-button",() => download(state.response,"稿件阅读记录.json")));
    } else evidence.append(element("p","","目录用于定位内容，选择对象后生成阅读记录。"));
    evidence.append(element("h3","","已保存证据"),element("p","",`${workspace.evidence.length} 项来源观察 · ${workspace.render_bundles.length} 组页面资料`));
    const gaps=element("details"); gaps.append(element("summary","",`读取限制 · ${workspace.catalog.reader_issues.length + workspace.catalog.unsupported_records.length}`));
    const list=element("ul");
    for (const issue of workspace.catalog.reader_issues) list.append(element("li","",issue));
    for (const item of workspace.catalog.unsupported_records) list.append(element("li","",userMessage(item.failure_reason)));
    gaps.append(list); evidence.append(gaps);
    grid.append(tree,content,evidence); target.append(grid);
  }
  function renderUrl(role,page) {
    return `/api/render?${new URLSearchParams({ project_id:state.workspace.project.project_id, baseline_id:state.workspace.baseline.baseline_id, bundle_id:state.bundleId, role, page_number:page===null ? "none" : String(page) })}`;
  }
  async function history() {
    const target=byId("history-content");
    if (!selectedProject()) { empty(target); return; }
    await perform("正在读取项目记录…", async () => {
      const project=selectedProject();
      const [workspace,records]=await Promise.all([api(`/api/manuscript?project_id=${encodeURIComponent(project.project_id)}&baseline_id=current`),api(`/api/history?project_id=${encodeURIComponent(project.project_id)}`)]);
      if (workspace.project.project_id!==project.project_id || records.project_id!==project.project_id) throw new Error("项目记录与所选论文不一致，请刷新工作区。");
      state.workspace=workspace; state.history=records; target.replaceChildren();
      const section=(title) => { const node=element("section","history-section"); node.append(element("h2","",title)); target.append(node); return node; };
      const versions=section("稿件版本");
      for (const [index,baseline] of workspace.baselines.entries()) {
        const row=element("div","history-entry"), copy=element("div"); copy.append(element("h3","",`稿件 ${index+1}${baseline.baseline_id===project.baseline_id ? " · 当前" : ""}`),element("p","",`${formatDate(baseline.created_at)} · ${userMessage(baseline.confirmation_reason)}`)); row.append(copy); versions.append(row);
      }
      const checks=section("检查记录");
      if (!records.checks.length) checks.append(element("p","history-empty","尚未运行期刊检查。"));
      for (const check of [...records.checks].reverse()) {
        const row=element("div","history-entry"), copy=element("div"); copy.append(element("h3","",check.world.journal_name),element("p","",`${formatDate(check.created_at)} · ${check.validity==="CURRENT" ? "当前有效" : "已过期"} · ${check.rule_results.length} 条规则`)); row.append(copy,button("查看检查","text-button",() => perform("正在打开检查记录…",() => openCheck(check)))); checks.append(row);
      }
      const reads=section("阅读记录");
      if (!records.reads.length) reads.append(element("p","history-empty","选择稿件对象后，阅读记录会保存在这里。"));
      for (const read of [...records.reads].reverse()) {
        const row=element("div","history-entry"), copy=element("div"); const scope=read.query_scope;
        copy.append(element("h3","",scope.page_number ? `第 ${scope.page_number} 页的对象` : objectLabels[scope.object_type] ?? "稿件对象"),element("p","",`稿件 ${workspace.baselines.findIndex((item)=>item.baseline_id===read.baseline_id)+1} · ${formatDate(read.created_at)}`));
        row.append(copy,button("查看阅读","text-button",() => perform("正在打开保存的阅读记录…",async()=> {
          const response=await api(`/api/read?project_id=${encodeURIComponent(project.project_id)}&read_record_id=${encodeURIComponent(read.read_record_id)}`);
          if(response.project.project_id!==project.project_id || response.project.baseline_id!==read.baseline_id) throw new Error("阅读记录不属于所选稿件版本。");
          await fetchWorkspace(read.baseline_id);
          state.response=response; state.type=response.query_scope.object_type ?? ""; state.region=response.query_scope.region ?? "";
          state.pageNumber=response.query_scope.page_number; state.bundleId=response.render_bundle?.bundle_id ?? "";
          render(); openReader();
        })),button("导出原始记录","text-button",() => perform("正在读取保存的原始记录…",async()=> { const response=await api(`/api/read?project_id=${encodeURIComponent(project.project_id)}&read_record_id=${encodeURIComponent(read.read_record_id)}`); download(response,"稿件阅读记录.json"); }))); reads.append(row);
      }
      const bindings=section("期刊使用记录");
      if (!records.bindings.length) bindings.append(element("p","history-empty","尚未选择检查期刊。"));
      for (const [index,binding] of records.bindings.entries()) { const row=element("div","history-entry"); row.append(element("h3","",`第 ${index+1} 次对照期刊`),element("p","",formatDate(binding.created_at))); bindings.append(row); }
    });
  }
  function download(value,name) { const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"})); const link=element("a"); link.href=url; link.download=name; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }
  function dialog(title,description) {
    const node=element("dialog","dialog compact-dialog"); const form=element("form"); const head=element("div","dialog-heading"); const close=element("button","icon-button"); close.type="button"; close.append(icon("x")); close.addEventListener("click",()=> { if(node.dataset.dirty!=="true" || window.confirm("放弃尚未保存的内容？")) node.close(); }); close.setAttribute("aria-label","关闭窗口"); head.append(element("h2","",title),close); form.append(head,element("p","dialog-intro",description)); node.append(form); node.addEventListener("input",()=>node.dataset.dirty="true"); node.addEventListener("change",()=>node.dataset.dirty="true"); node.addEventListener("cancel",(event)=>{if(node.dataset.dirty==="true" && !window.confirm("放弃尚未保存的内容？"))event.preventDefault();}); node.addEventListener("close",()=>node.remove()); document.body.append(node); return {node,form};
  }
  function field(form,label,type,required=true) {
    const wrapper=element("label","form-label",label); const input=element(type==="textarea" ? "textarea" : "input");
    if (type!=="textarea") input.type=type; input.required=required; wrapper.append(input); form.append(wrapper); return input;
  }
  function openBaselineDialog() {
    const requestId = `source-update-${crypto.randomUUID()}`;
    const submissionProject = state.workspace.project;
    const {node,form}=dialog("更新稿件","导入修订后的 DOCX，原版本与已有记录会保留。更换稿件后需要重新选择期刊依据。");
    const file=field(form,"修订稿 *","file"); file.accept=".docx"; const reason=field(form,"更新说明 *","textarea");
    const error=element("p","inline-error"); error.id=`form-error-${crypto.randomUUID()}`; error.setAttribute("role","alert"); const submit=element("button","button button-primary","保存稿件版本"); submit.type="submit"; form.append(error,submit);
    form.addEventListener("submit",async(event)=> { event.preventDefault(); const selected=file.files[0]; if (!selected?.name.toLowerCase().endsWith(".docx")) { error.textContent="请选择 DOCX 文件。"; return; } if(!reason.value.trim()) {error.textContent="请填写更新说明。"; reason.focus(); return;}
      await perform("正在保存稿件版本…",async()=> { submit.disabled=true; try { await api("/api/baseline",{project_id:submissionProject.project_id,expected_baseline_id:submissionProject.baseline_id,filename:selected.name,content_base64:await fileBase64(selected),reason:reason.value.trim(),request_id:requestId}); node.dataset.dirty="false"; node.close(); await refreshAfterWrite("稿件版本已保存",undefined,submissionProject.project_id,()=>fetchWorkspace()); success("稿件版本已保存。"); } finally { submit.disabled=false; } },error.id);
    }); node.showModal();
  }
  function openRenderDialog() {
    const {node,form}=dialog("添加页面资料","选择同一次导出生成的 PDF、页面图片和核对资料。"); node.classList.remove("compact-dialog");
    const files={};
    for (const [key,label,accept,required] of [["render_record","导出记录 *",".json",true],["page_index","页面索引 *",".json",true],["pdf","PDF *",".pdf",true],["pages","页面图片 *",".png",true],["document_annotation","独立文档标注",".json",false],["page_evidence","独立页面证据",".json",false]]) { const input=field(form,label,"file",required); input.accept=accept; if(key==="pages")input.multiple=true; files[key]=input; }
    const reason=field(form,"资料说明 *","textarea");
    const error=element("p","inline-error"); error.id=`form-error-${crypto.randomUUID()}`; error.setAttribute("role","alert"); const submit=element("button","button button-primary","保存页面资料"); submit.type="submit"; form.append(error,submit);
    form.addEventListener("submit",async(event)=> { event.preventDefault(); error.textContent="";
      if(Boolean(files.document_annotation.files[0])!==Boolean(files.page_evidence.files[0])) {error.textContent="独立文档标注与页面证据需要一起提供。";return;}
      await perform("正在核对并保存页面资料…",async()=> { submit.disabled=true; try {
        const index=JSON.parse(await files.page_index.files[0].text());
        if (!Array.isArray(index.pages)) throw new Error("页面索引缺少页码，请选择完整的导出资料。");
        const images=Array.from(files.pages.files); const pages=[];
        for(const page of index.pages) {
          const digest=page.sha256; let matched=null;
          for(const file of images) { const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer()))).map((value)=>value.toString(16).padStart(2,"0")).join(""); if(hash===digest){matched=file;break;} }
          if(!matched)throw new Error(`找不到与索引一致的第 ${page.page_number} 页图片。`);
          pages.push({page_number:page.page_number,content_base64:await fileBase64(matched)});
        }
        const upload=async(key)=> files[key].files[0] ? {content_base64:await fileBase64(files[key].files[0])} : null;
        await api("/api/render-bundle",{project_id:state.workspace.project.project_id,baseline_id:state.workspace.baseline.baseline_id,reason:reason.value.trim(),render_record:await upload("render_record"),page_index:await upload("page_index"),pdf:await upload("pdf"),pages,document_annotation:await upload("document_annotation"),page_evidence:await upload("page_evidence")}); node.dataset.dirty="false"; node.close(); await refreshAfterWrite("页面资料已保存",undefined,state.workspace.project.project_id,()=>fetchWorkspace(state.baselineId)); success("页面资料已保存。");
      } finally {submit.disabled=false;} },error.id);
    }); node.showModal();
  }
  return {open,history};
}
