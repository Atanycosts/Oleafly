import { element, formatValue } from "./dom.js";
import { propertyLabels } from "../transport/contracts.js";

const messages = new Map([
  ["Confirmed means an explicit requirement recognized in an operator-supplied guide for the declared context; publisher identity, completeness and currency are not authenticated.", "要求来自当前资料；来源完整性与时效仍需核实。"],
  ["Component provenance and applicability are supplied declarations, not authenticated journal requirements.", "组件声明的来源与适用范围仍需核实。"],
  ["Operator confirmation selects this expectation; original source conflicts and provenance remain recorded, and the decision does not authenticate an official journal requirement.", "本次人工确认保留原始依据与分歧，仍需核对期刊正式要求。"],
  ["Template geometry is an observation, not a normative journal requirement.", "模板提供页面观察值，仍需确认期刊是否将其作为要求。"],
  ["Declared source value matches the expectation.", "稿件声明值与要求一致。"],
  ["Declared source value differs from the expectation.", "稿件声明值与要求不同。"],
  ["No supported source value; computed layout is unavailable.", "稿件未声明可读取的值，无法判断。"],
  ["At least one section value is absent; no computed default is inferred.", "部分分节缺少声明值，需要核对页面。"],
  ["Rule scope is outside this checker's selected manuscript context.", "这条要求不适用于当前论文范围。"],
  ["Conflicting supplied expectations require a separate evidence decision.", "来源要求存在冲突，请先核对并确认采用值。"],
  ["Supplied source expectations disagree; no value is selected as authoritative.", "不同来源的要求不一致，尚未确定采用值。"],
  ["Only declared section properties are read; computed layout is unavailable.", "已读取文档声明的页面设置，实际排版需结合页面核对。"],
  ["User selected this DOCX for read-only journal checking.", "首次导入"],
  ["This line is outside the supported explicit requirement grammar.", "这段文字尚未提取为可检查要求。"],
  ["Unparsed, conditional or negative source context prevents confirmation.", "来源包含未解析内容或条件限制，需要人工确认。"],
  ["No applicable expectation was established for this geometry property.", "来源中尚未找到这项页面要求。"],
  ["No applicable expectation was established for this property.", "来源中尚未找到这项要求。"],
  ["The manuscript has no declared section geometry.", "稿件中未找到页面设置声明。"],
  ["Template has no declared section geometry.", "模板中未找到页面设置声明。"],
  ["Hidden, revised, field or math text is not confirmed as guidance.", "此段含隐藏文字、修订、域或公式，需核对原文。"],
  ["No nonblank guideline text was supplied.", "指南没有可读取的文字。"],
  ["PDF guide extraction is unavailable in pure analysis; provide captured UTF-8 text or DOCX guidance.", "PDF 文字尚无法提取，可补充文本或 DOCX 指南。"],
  ["At least one template section has no explicit value; inherited layout is not inferred.", "模板部分分节未声明此属性，需要核对页面。"],
  ["Template sections disagree; source section numbers do not establish manuscript section correspondence.", "模板分节的设置不同，需要确认各项要求适用的位置。"],
  ["The declared template value is outside the supported geometry rule domain.", "模板声明值超出当前可检查范围。"],
  ["no-supported-paragraph-text", "此段落没有可读取的文字。"],
]);

/** Translate fixed product messages while preserving unrecognized source text. */
export function userMessage(message) {
  if(message.startsWith("Applicability basis: ")) return `适用依据：${message.slice("Applicability basis: ".length)}`;
  return messages.get(message) ?? message;
}

/** Display readable section values from the reader's declared-values object. */
export function geometryProperties(content) {
  const properties=element("dl","object-properties");
  const declared=content.declared_values ?? content;
  for(const [property,label] of Object.entries(propertyLabels)) {
    if (!Object.hasOwn(declared,property)) continue;
    properties.append(element("dt","",label),element("dd","",formatValue(declared[property],property==="columns" ? "count" : "twips")));
  }
  return properties;
}

/** Keep the source's exact excerpt accessible when a template quote is a structured value. */
export function evidenceQuote(evidence) {
  const match=/^([a-z_]+)\s*=\s*([0-9]+)(?: \(declared OOXML\)| (?:count|twips))$/.exec(evidence.quote);
  if (match && Object.hasOwn(propertyLabels,match[1])) {
    const fragment=element("div");
    fragment.append(element("p","source-observation",`${propertyLabels[match[1]]} · ${formatValue(Number(match[2]),match[1]==="columns" ? "count" : "twips")}`));
    const details=element("details","evidence-locator"); details.append(element("summary","","查看原始记录"),element("blockquote","",evidence.quote)); fragment.append(details); return fragment;
  }
  return element("blockquote","",evidence.quote || "来源没有可展示的摘录。");
}
