import type { OoxmlElement, OoxmlNode } from "@docx-editor.dev/core/store";
import policy from "../../services/research-workbench/src/research_file_workbench/docx/markup-compatibility.json";

const supported = new Set<string>(policy.supported_requires_uris);
export const missingAlternateContentBranch = policy.missing_branch;
export const isDocxAlternateContent = (node: OoxmlElement): node is Extract<OoxmlElement, { kind: "generic" }> & { localName: "AlternateContent" } =>
  node.kind === "generic" && node.namespaceUri === policy.namespace_uri && node.localName === "AlternateContent";

/** Project the selected content for format computation, keeping original node identities. */
export function projectDocxMarkupCompatibility(
  root: OoxmlElement,
  onMissing?: (node: OoxmlElement) => void,
  branchDependentParagraphs?: WeakSet<OoxmlElement>,
  keepAlternateWrappers = false,
): OoxmlElement {
  const scope = (node: OoxmlElement, inherited: ReadonlyMap<string, string>) =>
    node.namespaceBindings.length
      ? new Map([...inherited, ...node.namespaceBindings.map(({ prefix, namespaceUri }) => [prefix, namespaceUri] as const)])
      : inherited;
  const project = (node: OoxmlElement, namespaces: ReadonlyMap<string, string>, inBranch: boolean): OoxmlElement => {
    const children = projectChildren(node, scope(node, namespaces), inBranch);
    if (node.kind === "paragraph" && (inBranch || children !== node.children)) branchDependentParagraphs?.add(node);
    return children === node.children ? node : { ...node, children } as OoxmlElement;
  };
  function projectChildren(node: OoxmlElement, namespaces: ReadonlyMap<string, string>, inBranch: boolean): readonly OoxmlNode[] {
    let children: OoxmlNode[] | undefined;
    for (const [index, child] of node.children.entries()) {
      if (child.kind !== "textValue" && isDocxAlternateContent(child)) {
        const alternateScope = scope(child, namespaces);
        const selected = selectBranch(child, alternateScope);
        children ??= node.children.slice(0, index);
        if (selected) {
          const entries = projectChildren(selected, scope(selected, alternateScope), true);
          if (keepAlternateWrappers) {
            children.push({ ...child, children: [{ ...selected, localName: "Fallback", children: entries }] });
          } else {
            for (const entry of entries) if (entry.kind !== "textValue") children.push(entry);
          }
        } else onMissing?.(child);
      } else {
        const projected = child.kind === "textValue" ? child : project(child, namespaces, inBranch);
        if (projected !== child) children ??= node.children.slice(0, index);
        children?.push(projected);
      }
    }
    return children ?? node.children;
  }
  function selectBranch(node: OoxmlElement, namespaces: ReadonlyMap<string, string>): Extract<OoxmlElement, { kind: "generic" }> | undefined {
    let fallback: Extract<OoxmlElement, { kind: "generic" }> | undefined;
    for (const branch of node.children) {
      if (branch.kind !== "generic" || branch.namespaceUri !== policy.namespace_uri) continue;
      if (branch.localName === "Fallback") fallback ??= branch;
      if (branch.localName !== "Choice") continue;
      const required = branch.attributes.find(({ namespaceUri, localName }) => !namespaceUri && localName === "Requires")
        ?.value.match(/[^ \t\r\n]+/g);
      const choiceScope = scope(branch, namespaces);
      if (required?.every((prefix) => supported.has(choiceScope.get(prefix) ?? ""))) return branch;
    }
    return fallback;
  }
  return project(root, new Map(), false);
}

export function projectDocxLiveBranches(root: OoxmlElement): OoxmlElement {
  return projectDocxMarkupCompatibility(root, undefined, undefined, true);
}
