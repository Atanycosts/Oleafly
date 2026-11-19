const labels = {
  compliant: "符合", violation: "不符合", observed_match: "候选吻合",
  observed_difference: "候选差异", cannot_determine: "无法判断", not_checked: "未检查",
  confirmed: "已确认要求", candidate: "候选要求", conflict: "来源存在冲突",
  CURRENT: "当前有效", STALE: "已过期，需重查",
  research_article: "研究论文", review_article: "综述论文", short_communication: "短篇论文",
  initial_submission: "首次投稿", revision: "修回稿", accepted_manuscript: "录用稿",
  en: "英文", zh: "中文", note: "已备注", defer: "已暂缓",
  APPLICABLE: "适用于当前范围", NOT_APPLICABLE: "不适用于当前范围", UNKNOWN: "适用性待确认",
};
const propertyLabels = {
  page_width_twips: "纸张宽度", page_height_twips: "纸张高度", top_margin_twips: "上边距",
  right_margin_twips: "右边距", bottom_margin_twips: "下边距", left_margin_twips: "左边距",
  columns: "分栏", body_font_size_halfpoints: "正文字号", body_line_spacing_twips: "正文行距", body_font_family: "正文字体", object_format: "模板对象格式",
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim().length > 0;
const isString = (value) => typeof value === "string";
const isInteger = (value) => Number.isSafeInteger(value);
const isCount = (value) => isInteger(value) && value >= 0;
const isPositive = (value) => isInteger(value) && value > 0;
const isHash = (value) => isString(value) && /^[0-9a-f]{64}$/.test(value);
const isBoolean = (value) => typeof value === "boolean";
const oneOf = (...values) => (value) => values.includes(value);
const nullable = (validate) => (value) => value === null || validate(value);
const optional = (validate) => (value) => value === undefined || validate(value);
const listOf = (validate) => (value) => Array.isArray(value) && value.every(validate);
const recordOf = (fields) => (value) => isObject(value) && Object.entries(fields).every(([key, validate]) => validate(value[key]));
const scopeShape = { article_type: isText, stage: isText, language: isText };
const isScope = recordOf(scopeShape);
const isCapabilities = recordOf({ scope: isText, manuscript_editing: isBoolean, guide_pdf_analysis: isBoolean, guide_pdf_fragments: isBoolean, formal_full_journal_acceptance: isBoolean });
const isRuleScope = recordOf({ ...scopeShape, section_scope: isText });
const isBasis = oneOf("confirmed", "candidate", "conflict");
const isValidity = oneOf("CURRENT", "STALE");
const isVerdict = oneOf("compliant", "violation", "observed_match", "observed_difference", "cannot_determine", "not_checked");
const isProperty = (value) => Object.hasOwn(propertyLabels, value);
const propertyUnit = (property) => property === "columns" ? "count" : property === "body_font_family" ? "font_family" : property === "body_font_size_halfpoints" ? "half_points" : property === "body_line_spacing_twips" ? "spacing_twips" : "twips";
const isRuleValue = (property, value) => property === "body_font_family" ? isText(value) : isInteger(value);
const isGap = recordOf({ code: isText, message: isText, source_id: nullable(isText), property: nullable(isText), locator: nullable(isText) });
const isObjectSelector = recordOf({ kind: isText, role: isText });
const isRule = (value) => isObject(value) && (value.property === "object_format" ? recordOf({
  rule_id: isText, property: oneOf("object_format"), expected: isObjectSelector, unit: oneOf("effective_format"),
  basis_status: oneOf("confirmed"), confirmation_method: oneOf("explicit_template_selection"), scope: isObjectSelector,
  template_object_ids: listOf(isText), limitations: listOf(isText),
  evidence: listOf(recordOf({ source_id: isText, locator: isText, quote: isString })),
})(value) : recordOf({
  rule_id: isText, property: isProperty, expected: (item) => item === null || isRuleValue(value.property, item), unit: oneOf("twips", "count", "half_points", "spacing_twips", "font_family"),
  basis_status: isBasis, scope: isRuleScope, limitations: listOf(isText),
  evidence: listOf(recordOf({ source_id: isText, locator: isText, quote: isString })),
  resolution: optional(recordOf({ reason: isText, actor_id: isText, previous_expected: (item) => item === null || isRuleValue(value.property, item), expected: (item) => isRuleValue(value.property, item) })),
})(value) && value.unit === propertyUnit(value.property));
const worldSummaryShape = {
  version_id: isText, journal_id: isText, journal_name: isText,
  version_ordinal: (value) => isInteger(value) && value > 0, created_at: isText, scope: isScope,
};
const isWorldSummary = recordOf(worldSummaryShape);
const isWorld = recordOf({
  ...worldSummaryShape, rules: listOf(isRule), coverage_gaps: listOf(isGap), limitations: listOf(isText),
  sources: listOf(recordOf({ source_id: isText, name: isText, kind: isText })),
});
const isBinding = recordOf({ binding_id: isText, project_id: isText, world_version_id: isText, baseline_id: isText });
const isCheckSummary = recordOf({ check_id: isText, created_at: isText, summary: isObject, validity: isValidity });
const isProject = recordOf({
  project_id: isText, name: isText, baseline_id: isText,
  binding: nullable(isBinding), latest_check: nullable(isCheckSummary),
});
const isDisposition = recordOf({ check_id: isText, rule_id: isText, action: oneOf("note", "defer"), note: isText, created_at: isText });
const isRuleResult = (value) => isObject(value) && (value.property === "object_format" ? recordOf({
  rule_id: isText, property: oneOf("object_format"), basis_status: oneOf("confirmed"), verdict: isVerdict,
  applicability: oneOf("APPLICABLE"), limitations: listOf(isText), findings: listOf(isObject),
  coverage: recordOf({ total_objects: isCount }), finding_selector: isObjectSelector, finding_summary: isObject,
})(value) : recordOf({
  rule_id: isText, property: isProperty, basis_status: isBasis, verdict: isVerdict,
  applicability: oneOf("APPLICABLE", "NOT_APPLICABLE", "UNKNOWN"), limitations: listOf(isText),
  coverage: recordOf({ total_sections: isCount, observed_sections: isCount, missing_sections: isCount }),
  findings: listOf(recordOf({ section_index: (value) => isInteger(value) && value > 0, locator: isText, observed: nullable(isInteger), expected: isInteger, message: isText, verdict: optional(isVerdict) })),
})(value));
const isCheck = recordOf({
  check_id: isText, project_id: isText, world_version_id: isText, world: isWorld,
  created_at: isText, validity: isValidity, update_available: isBoolean, stale_reasons: listOf(isText),
  rule_results: listOf(isRuleResult), dispositions: listOf(isDisposition), coverage_gaps: listOf(isGap),
  limitations: listOf(isText),
});
const isFragment = recordOf({ fragment_id: isText, source_id: isText, kind: oneOf("paragraph", "sentence", "table_cell", "docx_node", "component", "component_rule", "source_quote", "pdf_block", "pdf_heading", "template_object"), locator: isText, parent_fragment_id: nullable(isText), part_path: nullable(isText), text: isString, char_start: nullable(isCount), char_end: nullable(isCount), content: isObject });
const isReview = recordOf({
  world_version_id: isText, method_version: isText, relation_method_version: isText, reader_version: isText, pdf_source_version: isText, offset_unit: oneOf("unicode_code_points"),
  fragments: listOf(isFragment), sources: listOf(recordOf({ source_id: isText, name: isText, kind: isText, fragment_count: isCount, extraction_status: oneOf("extracted_with_gaps", "extracted"), reader_issues: listOf(isText) })), limitations: listOf(isText),
  rule_links: listOf(recordOf({ rule_id: isText, evidence_index: isCount, source_id: isText, locator: isText, quote: isString, fragment_ids: listOf(isText), link_status: oneOf("located", "unavailable") })),
  relations: listOf(recordOf({ kind: oneOf("related_rule", "related_source", "possible_duplicate"), from_id: isText, to_id: isText, score: (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1, score_kind: oneOf("lexical_cosine"), shared_terms: listOf(isText) })),
});
const isCatalogItem = recordOf({ object_id: isText, object_type: isText, region: nullable(isText), part_path: isText, node_locator: isText, range_locator: isText });
const isSource = recordOf({ sha256: isHash, version_id: isText });
const isProjectContext = recordOf({ project_id: isText, baseline_id: isText });
const isBaseline = recordOf({ baseline_id: isText, project_id: isText, source_sha256: isHash, created_at: isText, confirmation_reason: isText });
const isQueryScope = recordOf({ region: nullable(isText), object_type: nullable(isText), object_id: nullable(isText), page_number: nullable(isPositive) });
const isReadSummary = recordOf({ read_record_id: isText, baseline_id: isText, created_at: isText, query_scope: isQueryScope });
const isPagination = recordOf({ page_number: isPositive, page_size: isPositive, has_more: isBoolean, next_cursor: nullable(isText), total_ranges: isCount });
const isReadRange = recordOf({ version_id: isText, locator: isText, range_type: isText, parse_status: oneOf("parsed", "partial", "unsupported", "failed", "unverified"), limitations: listOf(isText) });
const isReceipt = recordOf({ read_record_id: isText, created_at: isText, ranges: listOf(isReadRange), unread_ranges: listOf(isReadRange), returned_versions: listOf(isText), truncation: isBoolean, pagination: isPagination, caller: optional(recordOf({ system: isText, project_id: isText, task_id: isText, generation: isPositive })) });
const isRenderContext = recordOf({ bundle_id: isText, page_count: isPositive, pdf_sha256: isHash, render_profile_id: isText });
const isRenderBundle = recordOf({
  bundle_id: isText, baseline_id: isText, registered_at: isText,
  manifest: recordOf({ baseline_id: isText, source_sha256: isHash, pdf_sha256: isHash, page_count: isPositive, mapping_status: oneOf("reviewed", "partial", "pending_independent_review"), mapping: nullable(isObject) }),
});
const isCatalog = recordOf({ status: oneOf("catalog_only"), source: isSource, project: isProjectContext, items: listOf(isCatalogItem), object_types: listOf(isText), regions: listOf(isText), reader_issues: listOf(isText), unsupported_records: listOf(recordOf({ failure_reason: isText, kind: isText, source_location: isText })) });
const isManuscript = recordOf({ project: isProject, baseline: isBaseline, baselines: listOf(isBaseline), catalog: isCatalog, evidence: listOf(isObject), render_bundles: listOf(isRenderBundle), reads: listOf(isReadSummary) });
const isReadItem = (value) => isCatalogItem(value) && isObject(value.content)
  && (value.object_type !== "table" || listOf(listOf(recordOf({ text: isString, grid_span: isPositive })))(value.content.rows));
// selection_delivery is the continuation axis, never a coverage claim. It is optional because a
// saved response from before this field existed is returned unchanged by GET /api/read; when it is
// present it must agree with pagination.has_more.
const isRead = recordOf({ items: listOf(isReadItem), source: isSource, query_scope: isQueryScope, pagination: isPagination, read_receipt: isReceipt, project: isProjectContext, delivery: recordOf({ read_record_id: isText }), selection_delivery: optional(oneOf("continuation_available", "continuation_exhausted")), render_bundle: optional(isRenderContext), limitations: listOf(isText) });
const isBaselineUpdate = recordOf({ status: oneOf("APPLIED"), result_baseline_id: isText, previous_baseline_id: nullable(isText), request_id: isText, created_at: isText });
const isSourcePage = recordOf({
  page: isCount, page_count: isCount, width_pt: (value) => typeof value === "number" && value > 0, height_pt: (value) => typeof value === "number" && value > 0, dpi: isCount, png_base64: isString,
});
const responseShapes = {
  "/api/session": ["会话", recordOf({ token: isText, contract_version: isText, asset_version: (value) => isString(value) && /^[0-9a-f]{64}$/.test(value) })],
  "/api/state": ["工作区", recordOf({ worlds: listOf(isWorldSummary), projects: listOf(isProject), capabilities: isCapabilities })],
  "/api/world": ["期刊版本", isWorld], "/api/worlds": ["期刊版本", isWorld], "/api/revise": ["期刊版本", isWorld],
  "/api/projects": ["论文", isProject], "/api/bind": ["版本绑定", isBinding],
  "/api/review": ["来源片段", isReview], "/api/source-page": ["PDF 页面预览", isSourcePage], "/api/manuscript": ["稿件资料", isManuscript],
  "/api/history": ["项目记录", recordOf({ project_id: isText, checks: listOf(isCheck), bindings: listOf(isBinding), reads: listOf(isReadSummary) })],
  "/api/read": ["阅读记录", isRead], "/api/baseline": ["论文版本", isBaselineUpdate],
  "/api/render-bundle": ["页面资料", isRenderBundle],
  "/api/check": ["检查记录", isCheck], "/api/disposition": ["处理意见", isDisposition],
  "/api/diff": ["版本比较", recordOf({
    from_version: isText, to_version: isText, scope_changed: isBoolean, journal_changed: isBoolean,
    changes: listOf(recordOf({ property: isProperty, before: nullable(isRule), after: nullable(isRule), status: oneOf("added", "removed", "changed", "unchanged") })),
  })],
};

const hasUnique = (values) => new Set(values).size === values.length;

function checkReferencesAgree(response) {
  const rules = new Map(response.world.rules.map((rule) => [rule.rule_id, rule]));
  return response.world_version_id === response.world.version_id
    && rules.size === response.world.rules.length
    && hasUnique(response.rule_results.map((result) => result.rule_id))
    && response.rule_results.length === rules.size
    && response.rule_results.every((result) => {
      const rule = rules.get(result.rule_id);
      return rule && rule.property === result.property && rule.basis_status === result.basis_status
        && (result.property === "object_format"
          ? result.finding_selector.kind === rule.scope.kind && result.finding_selector.role === rule.scope.role
            && Object.values(result.finding_summary).every(isCount)
            && Object.values(result.finding_summary).reduce((sum, count) => sum + count, 0) === result.coverage.total_objects
          : result.coverage.observed_sections + result.coverage.missing_sections === result.coverage.total_sections);
    }) && response.dispositions.every((item) => item.check_id === response.check_id && rules.has(item.rule_id));
}

function reviewReferencesAgree(response) {
  const fragments = new Map(response.fragments.map((item) => [item.fragment_id, item]));
  const sources = new Set(response.sources.map((item) => item.source_id));
  const references = new Set([...fragments.keys(), ...response.rule_links.map((item) => item.rule_id)]);
  return fragments.size === response.fragments.length
    && response.fragments.every((item) => {
      if (!sources.has(item.source_id)) return false;
      const ancestors = new Set([item.fragment_id]);
      let parentId = item.parent_fragment_id;
      while (parentId !== null) {
        const parent = fragments.get(parentId);
        if (!parent || parent.source_id !== item.source_id || ancestors.has(parentId)) return false;
        ancestors.add(parentId); parentId = parent.parent_fragment_id;
      }
      if (item.char_start === null || item.char_end === null) return item.char_start === item.char_end;
      const parent = fragments.get(item.parent_fragment_id);
      return parent && item.char_end >= item.char_start
        && item.char_end <= Array.from(parent.text).length
        && Array.from(parent.text).slice(item.char_start, item.char_end).join("") === item.text;
    })
    && response.sources.every((source) => source.fragment_count === response.fragments.filter((item) => item.source_id === source.source_id).length)
    && response.rule_links.every((link) => sources.has(link.source_id)
      && (link.link_status === "located") === (link.fragment_ids.length > 0)
      && hasUnique(link.fragment_ids)
      && link.fragment_ids.every((id) => fragments.get(id)?.source_id === link.source_id && fragments.get(id)?.locator === link.locator))
    && response.relations.every((relation) => relation.from_id !== relation.to_id && references.has(relation.from_id) && references.has(relation.to_id));
}

function renderReferencesAgree(bundle) {
  return bundle.baseline_id === bundle.manifest.baseline_id
    && (bundle.manifest.mapping_status === "pending_independent_review") === (bundle.manifest.mapping === null)
    && (bundle.manifest.mapping === null || bundle.manifest.mapping.status === bundle.manifest.mapping_status);
}

function manuscriptReferencesAgree(response) {
  const baselines = new Map(response.baselines.map((item) => [item.baseline_id, item]));
  const selected = baselines.get(response.baseline.baseline_id);
  return baselines.size === response.baselines.length && selected
    && selected.source_sha256 === response.baseline.source_sha256
    && baselines.has(response.project.baseline_id)
    && response.baseline.project_id === response.project.project_id
    && response.baselines.every((item) => item.project_id === response.project.project_id)
    && response.catalog.project.project_id === response.project.project_id
    && response.catalog.project.baseline_id === response.baseline.baseline_id
    && response.catalog.source.sha256 === response.baseline.source_sha256
    && response.catalog.source.version_id === `artifact-version-${response.baseline.source_sha256}`
    && hasUnique(response.catalog.items.map((item) => item.object_id))
    && response.catalog.items.every((item) => response.catalog.object_types.includes(item.object_type) && (item.region === null || response.catalog.regions.includes(item.region)))
    && hasUnique(response.render_bundles.map((item) => item.bundle_id))
    && response.render_bundles.every((item) => renderReferencesAgree(item) && item.baseline_id === response.baseline.baseline_id && item.manifest.source_sha256 === response.baseline.source_sha256)
    && hasUnique(response.reads.map((item) => item.read_record_id))
    && response.reads.every((item) => item.baseline_id === response.baseline.baseline_id);
}

function readReferencesAgree(response) {
  const pagination = response.pagination;
  const receipt = response.read_receipt;
  const offset = (pagination.page_number - 1) * pagination.page_size;
  const scope = response.query_scope;
  const hasPage = scope.page_number !== null;
  return response.source.version_id === `artifact-version-${response.source.sha256}`
    && pagination.has_more === (pagination.next_cursor !== null)
    && (response.selection_delivery === undefined
      || response.selection_delivery === (pagination.has_more ? "continuation_available" : "continuation_exhausted"))
    && offset <= pagination.total_ranges
    && response.items.length === Math.min(pagination.page_size, pagination.total_ranges - offset)
    && pagination.has_more === (offset + response.items.length < pagination.total_ranges)
    && receipt.truncation === (offset > 0 || pagination.has_more)
    && Object.keys(pagination).every((key) => pagination[key] === receipt.pagination[key])
    && receipt.read_record_id === response.delivery.read_record_id
    && receipt.ranges.length === response.items.length
    && hasUnique(response.items.map((item) => item.object_id))
    && response.items.every((item, index) => {
      const range = receipt.ranges[index];
      return range.locator === item.range_locator && range.range_type === item.object_type
        && range.version_id === response.source.version_id
        && (scope.object_id === null || scope.object_id === item.object_id)
        && (scope.object_type === null || scope.object_type === item.object_type)
        && (scope.region === null || scope.region === item.region);
    })
    && receipt.returned_versions.length === (response.items.length ? 1 : 0)
    && (!response.items.length || receipt.returned_versions[0] === response.source.version_id)
    && hasPage === (response.render_bundle !== undefined)
    && (!hasPage || scope.page_number <= response.render_bundle.page_count);
}

/** Validate the fields and references the views consume before presenting a response. */
function validateResponse(path, response) {
  if (!Object.hasOwn(responseShapes, path)) throw new Error("此操作无法识别，请重新加载工作区。");
  const [description, validate] = responseShapes[path];
  if (!validate(response)) throw new Error(`${description}资料不完整，无法显示，请刷新后重试。`);
  if (path === "/api/state") {
    const worlds = new Set(response.worlds.map((world) => world.version_id));
    const projects = new Set(response.projects.map((project) => project.project_id));
    const coherent = worlds.size === response.worlds.length && projects.size === response.projects.length
      && response.projects.every((project) => project.binding === null || (project.binding.project_id === project.project_id && worlds.has(project.binding.world_version_id)));
    if (!coherent) throw new Error("工作区中的论文或期刊版本引用不一致，请刷新后重试。");
  }
  if (path === "/api/check") {
    if (!checkReferencesAgree(response)) throw new Error("检查记录的规则、版本或覆盖范围不一致，请刷新后重新检查。");
  }
  if (path === "/api/history") {
    const coherent = hasUnique(response.checks.map((item) => item.check_id))
      && hasUnique(response.bindings.map((item) => item.binding_id))
      && hasUnique(response.reads.map((item) => item.read_record_id))
      && response.checks.every((item) => item.project_id === response.project_id && checkReferencesAgree(item))
      && response.bindings.every((item) => item.project_id === response.project_id);
    if (!coherent) throw new Error("项目记录与所选论文不一致，请刷新后重试。");
  }
  if (path === "/api/review" && !reviewReferencesAgree(response)) throw new Error("来源片段的引用不一致，请重新读取期刊资料。");
  if (path === "/api/manuscript" && !manuscriptReferencesAgree(response)) throw new Error("稿件目录与版本不一致，请重新读取论文。");
  if (path === "/api/read" && !readReferencesAgree(response)) throw new Error("阅读内容与保存记录不一致，请重新读取。");
  if (path === "/api/render-bundle" && !renderReferencesAgree(response)) throw new Error("页面资料与稿件版本不一致，请重新添加页面资料。");
  return response;
}


export { labels, propertyLabels, validateResponse, isObject, isText, recordOf, listOf, isString, isInteger, isCount, nullable, optional };
