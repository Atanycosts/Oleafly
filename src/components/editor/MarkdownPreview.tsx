import { cloneElement, isValidElement, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { markdownComponents } from "@/components/ui/markdown-renderer";
import { useActiveContent, useFilesStore } from "@/store/files";
import { loadAssetThumbnail } from "./cm/hover-asset";
import { appUrlProjectPath, projectFileForHref } from "@/lib/file-links";
import { Button } from "@/components/ui/button";
import { createMaterialDocument, type MaterialAnchor, type MaterialDocument } from "@/lib/material-surface";
import { useMaterialViewSelection } from "@/components/materials/MaterialViewContext";
import { openMaterialAnnotations } from "@/store/material-annotations";
import { openLinkedProjectFile } from "@/features/file-links";

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

// react-markdown blanks URLs with schemes it does not know, which hid links
// saved with the app's own `tauri://localhost` address before PreviewLink
// could map them to their file.
function urlTransform(url: string): string {
  return appUrlProjectPath(url) ? url : defaultUrlTransform(url);
}

function PreviewImage({ projectId, path, src, alt, title, retained }: Readonly<{
  projectId: string | null;
  path: string;
  src?: string;
  alt?: string;
  title?: string;
  retained?: boolean;
}>) {
  const { t } = useTranslation("editor");
  const key = `${projectId}\0${path}\0${src}`;
  const target = projectFileForHref(path, src)?.path ?? null;
  const external = !target && src && /^https?:\/\//iu.test(src) ? src : null;
  const [loaded, setLoaded] = useState<{ key: string; url: string | null } | null>(null);
  useEffect(() => {
    if (retained || !projectId || !target) return;
    let cancelled = false;
    void loadAssetThumbnail(projectId, target).then((url) => {
      if (!cancelled) setLoaded({ key, url });
    });
    return () => { cancelled = true; };
  }, [projectId, target, key, retained]);
  if (retained) return <span data-testid="retained-image-placeholder" className="text-muted-foreground">{alt ? `${alt} · ` : ""}{t(($) => $.editor.materials.retainedImageUnavailable)}</span>;
  const url = external ?? (loaded?.key === key ? loaded.url : null);
  return url ? <img src={url} alt={alt ?? ""} title={title} className="max-w-full" />
    : <span className="text-muted-foreground">{alt}</span>;
}

function PreviewLink({ path, href, children }: Readonly<{ path: string; href?: string; children?: ReactNode }>) {
  const target = projectFileForHref(path, href);
  const Anchor = markdownComponents.a as (props: { href?: string; children?: ReactNode }) => ReactNode;
  if (!target) return <Anchor href={href}>{children}</Anchor>;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    openLinkedProjectFile(target.path);
  };
  return <a href={`/${target.path.split("/").map(encodeURIComponent).join("/")}${target.fragment}`} onClick={open}
    className="text-primary underline underline-offset-2 dark:text-primary">{children}</a>;
}

function previewComponents(projectId: string | null, path: string, retained: boolean): Components {
  const positioned: Record<string, (props: { node?: { position?: { start: { offset?: number }; end: { offset?: number } } }; children?: ReactNode }) => ReactNode> = {};
  for (const tag of ["p", "h1", "h2", "h3", "li", "blockquote", "pre", "table"] as const) {
    const Component = markdownComponents[tag] as (props: { children?: ReactNode }) => ReactNode;
    positioned[tag] = ((props: { node?: { position?: { start: { offset?: number }; end: { offset?: number } } }; children?: ReactNode }) => {
      const position = props.node?.position;
      const rendered = <Component>{props.children}</Component>;
      const output = Component({ children: props.children });
      return isValidElement(output) ? cloneElement(output as ReactElement<Record<string, unknown>>, { "data-source-from": position?.start.offset, "data-source-to": position?.end.offset }) : rendered;
    });
  }
  return {
    ...markdownComponents,
    ...positioned,
    img: ({ src, alt, title }) => <PreviewImage projectId={projectId} path={path} retained={retained}
      src={typeof src === "string" ? src : undefined} alt={alt} title={title} />,
    a: ({ href, children }) => <PreviewLink path={path} href={href}>{children}</PreviewLink>,
  };
}

export function MarkdownPreview(props: { content?: string; projectId?: string | null; path?: string; document?: MaterialDocument; anchor?: MaterialAnchor } = {}) {
  const { t } = useTranslation(["editor"]);
  const activeContent = useActiveContent();
  const activeProject = useFilesStore((state) => state.projectId);
  const activePath = useFilesStore((state) => state.activePath);
  const content = useDeferredValue(props.content ?? (props.document && typeof props.document.source !== "function" && "text" in props.document.source ? props.document.source.text : activeContent));
  const projectId = props.document?.projectId ?? (props.projectId === undefined ? activeProject : props.projectId);
  const path = props.document?.path ?? props.path ?? activePath ?? "";
  const root = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState<{ from: number; to: number; quote: string } | null>(null);
  useMaterialViewSelection(useMemo(() => selected ? { kind: "text", ...selected } : props.anchor ?? null, [selected, props.anchor]));
  useEffect(() => setSelected(null), [content, projectId, path]);
  const retained = props.document !== undefined;
  const components = useMemo(() => previewComponents(projectId, path, retained), [projectId, path, retained]);
  useEffect(() => {
    const anchor = props.anchor;
    if (anchor?.kind !== "text") return;
    const block = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-source-from][data-source-to]") ?? [])
      .find((element) => Number(element.dataset.sourceFrom) <= anchor.from && Number(element.dataset.sourceTo) >= anchor.to);
    if (block) {
      block.setAttribute("data-material-anchor", "true");
      block.style.outline = "2px solid var(--color-primary)";
      block.scrollIntoView?.({ block: "center" });
      return () => { block.removeAttribute("data-material-anchor"); block.style.outline = ""; };
    }
  }, [props.anchor, content]);
  const annotate = (selection = false) => {
    if (!projectId) return;
    const anchor = selection && selected ? { kind: "text" as const, ...selected } : undefined;
    if (props.document) { openMaterialAnnotations(props.document, anchor); return; }
    void createMaterialDocument({ projectId, documentId: `file:${path}`, path, title: path.split("/").pop() ?? path, kind: "markdown" }, { text: content, mediaType: "text/markdown" }).then((document) => openMaterialAnnotations(document, anchor));
  };
  const captureSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !root.current || !selection.rangeCount) { setSelected(null); return; }
    const range = selection.getRangeAt(0);
    const elementFor = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest<HTMLElement>("[data-source-from][data-source-to]");
    const start = elementFor(range.startContainer), end = elementFor(range.endContainer);
    if (!start || !end || !root.current.contains(start) || !root.current.contains(end)) { setSelected(null); return; }
    const from = Number(start.dataset.sourceFrom), to = Number(end.dataset.sourceTo);
    setSelected({ from, to, quote: content.slice(from, to) });
  };
  return <div className="flex h-full min-h-0 flex-col">
    {projectId && <div className="flex shrink-0 flex-wrap gap-2 border-b px-3 py-2">
      <Button size="xs" variant="outline" onClick={() => annotate()}>{t(($) => $.editor.materials.annotateWhole)}</Button>
      <Button size="xs" variant="outline" disabled={!selected} onMouseDown={(event) => event.preventDefault()} onClick={() => annotate(true)}>{t(($) => $.editor.materials.annotateSelection)}</Button>
      {selected && <span className="text-xs text-muted-foreground">{t(($) => $.editor.materials.markdownBlockSelection)}</span>}
    </div>}
    <section ref={root} onMouseUp={captureSelection} onKeyUp={captureSelection} data-testid="markdown-preview" aria-label={t(($) => $.editor.preview.markdown)}
      className="min-h-0 min-w-0 flex-1 overflow-auto px-6 py-5 text-sm text-foreground [overflow-wrap:anywhere] [scrollbar-width:thin] [&_h1]:mb-3 [&_h1]:text-2xl [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-xl [&_h3]:mt-4 [&_h3]:text-lg [&_.katex-display]:overflow-x-auto">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} urlTransform={urlTransform}>{content}</ReactMarkdown>
    </section>
  </div>;
}
