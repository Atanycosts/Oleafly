import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  ChevronUp,
  Italic,
  Layers2,
  Redo2,
  Undo2,
} from "lucide-react";
import { useEditorCommand, useEditorValueCommand, useFontFamily } from "@docx-editor.dev/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type WordSurfaceView = "working" | "original" | "compare";
export type WordSurfaceSide = "current" | "previous";

export interface WordSurfaceProps {
  view: WordSurfaceView;
  onViewChange?: (view: WordSurfaceView) => void;
  foreground?: WordSurfaceSide;
  onForegroundChange?: (side: WordSurfaceSide) => void;
  working: ReactNode;
  original: ReactNode;
  workingLabel: string;
  originalLabel: string;
  className?: string;
}

export function WordSurface({
  view,
  onViewChange,
  foreground,
  onForegroundChange,
  working,
  original,
  workingLabel,
  originalLabel,
  className,
}: WordSurfaceProps) {
  const [localForeground, setLocalForeground] = useState<WordSurfaceSide>("current");
  const [paper, setPaper] = useState<{ left: number; width: number; background: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const front = view === "working" ? "current" : view === "original" ? "previous" : foreground ?? localForeground;
  const back = front === "current" ? "previous" : "current";

  useLayoutEffect(() => {
    const active = root.current?.ownerDocument.activeElement;
    const rear = root.current?.querySelector(`[data-word-surface-layer="${front === "current" ? "previous" : "current"}"]`);
    if (active instanceof HTMLElement && rear?.contains(active)) active.blur();
  }, [front]);

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const measure = () => {
      const page = node.querySelector<HTMLElement>(`[data-word-surface-layer="${front}"] .docx-page`);
      if (!page) return false;
      const box = page.getBoundingClientRect();
      if (!box.width) return false;
      const bounds = node.getBoundingClientRect();
      const next = { left: box.left - bounds.left, width: box.width,
        background: getComputedStyle(page).backgroundColor };
      setPaper((current) => current?.left === next.left && current.width === next.width &&
        current.background === next.background ? current : next);
      return true;
    };
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    resize?.observe(node);
    // Wait only for the first painted page. Editing does not observe or rescan the document DOM.
    const opening = new MutationObserver(() => {
      if (!measure()) return;
      opening.disconnect();
      const page = node.querySelector<HTMLElement>(`[data-word-surface-layer="${front}"] .docx-page`);
      if (page) resize?.observe(page);
    });
    if (!measure()) opening.observe(node, { childList: true, subtree: true });
    else {
      const page = node.querySelector<HTMLElement>(`[data-word-surface-layer="${front}"] .docx-page`);
      if (page) resize?.observe(page);
    }
    return () => { opening.disconnect(); resize?.disconnect(); };
  }, [front]);

  function bringForward(side: WordSurfaceSide) {
    if (view !== "compare") {
      if (front !== side) onViewChange?.(side === "current" ? "working" : "original");
      return;
    }
    setLocalForeground(side);
    onForegroundChange?.(side);
  }

  function layer(side: WordSurfaceSide, label: string, children: ReactNode) {
    const visible = front === side;
    return (
      <section
        id={`${id}-${side}`}
        aria-label={label}
        aria-hidden={visible ? undefined : true}
        data-word-surface-layer={side}
        data-foreground={visible}
        hidden={!visible}
        inert={!visible ? true : undefined}
        className="absolute inset-0 min-h-0 min-w-0 overflow-hidden"
      >
        {children}
      </section>
    );
  }

  return (
    <div
      ref={root}
      className={cn("flex h-full min-h-0 min-w-0 flex-col bg-background", className)}
      data-testid="word-surface"
      data-view={view}
      data-foreground={front}
    >
      <div className="relative isolate flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/20">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-2 top-1 z-20 rounded-t-md border border-border bg-muted shadow-md duration-[180ms] ease-out motion-safe:transition-transform motion-reduce:transition-none"
          style={{ left: paper?.left ?? "max(24px, calc((100% - 794px) / 2))", width: paper?.width ?? "min(794px, calc(100% - 48px))",
            transform: `translateX(${front === "current" ? "-20px" : "20px"})`,
            clipPath: front === "current" ? "polygon(0 0, 100% 0, 100% 32px, 20px 32px, 20px 100%, 0 100%)" : "polygon(0 0, 100% 0, 100% 100%, calc(100% - 20px) 100%, calc(100% - 20px) 32px, 0 32px)" }}
          data-testid="word-surface-paper-edge"
          data-version={back}
        />
        <div className="relative z-30 h-16 shrink-0" data-testid="word-surface-version-spine">
          {(["previous", "current"] as const).map((side) => <button
            key={side}
            type="button"
            className={cn("absolute flex h-8 min-w-0 items-center gap-2 overflow-hidden rounded-t-md border border-b-0 border-border px-3 text-left text-xs duration-[180ms] ease-out motion-safe:transition-transform motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", front === side ? "font-medium shadow-sm" : "bg-muted text-muted-foreground hover:text-foreground")}
            style={{ left: paper?.left ?? "max(24px, calc((100% - 794px) / 2))", width: paper?.width ?? "min(794px, calc(100% - 48px))",
              backgroundColor: front === side ? paper?.background : undefined,
              transform: front === side ? "translate(0, 32px)" : `translate(${front === "current" ? "-20px" : "20px"}, 4px)` }}
            aria-controls={`${id}-${side}`}
            aria-pressed={front === side}
            disabled={view !== "compare" && !onViewChange && front !== side}
            onClick={() => bringForward(side)}
          >
            <Layers2 aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{side === "current" ? workingLabel : originalLabel}</span>
          </button>)}
        </div>
        <div className="relative z-10 min-h-0 min-w-0 flex-1" data-testid="word-surface-paper">
          <div className="absolute inset-x-2 bottom-2 top-0 overflow-hidden" data-testid="word-surface-foreground">
            {layer("previous", originalLabel, original)}
            {layer("current", workingLabel, working)}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface WordFormattingToolbarLabels {
  toolbar: string;
  undo: string;
  redo: string;
  bold: string;
  italic: string;
  fontFamily: string;
  fontSize: string;
  mixed: string;
  alignLeft: string;
  alignCenter: string;
  alignRight: string;
  moreTools: string;
  fewerTools: string;
}

export interface WordFormattingToolbarProps {
  labels: WordFormattingToolbarLabels;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
}

const FONT_SIZES = [18, 20, 21, 22, 24, 28, 32, 36, 48] as const;

function fontSizeLabel(halfPoints: number) {
  return Number.isInteger(halfPoints / 2) ? String(halfPoints / 2) : (halfPoints / 2).toFixed(1);
}

export function WordFormattingToolbar({
  labels,
  disabled = false,
  compact = true,
  className,
}: WordFormattingToolbarProps) {
  const [expanded, setExpanded] = useState(false);
  const undo = useEditorCommand("history.undo");
  const redo = useEditorCommand("history.redo");
  const bold = useEditorCommand("text.bold");
  const italic = useEditorCommand("text.italic");
  const alignLeft = useEditorCommand("alignment.left");
  const alignCenter = useEditorCommand("alignment.center");
  const alignRight = useEditorCommand("alignment.right");
  const fontSize = useEditorValueCommand("font.size");
  const fontFamily = useFontFamily();
  const showFormatting = !compact || expanded;
  const fontSizeOptions = fontSize.value !== null && !FONT_SIZES.includes(fontSize.value as (typeof FONT_SIZES)[number])
    ? [...FONT_SIZES, fontSize.value].sort((left, right) => left - right)
    : FONT_SIZES;

  const button = (
    label: string,
    icon: ReactNode,
    command: typeof bold,
  ) => (
    <Button
      type="button"
      size="icon"
      variant={command.isActive ? "secondary" : "ghost"}
      className="size-7"
      aria-label={label}
      aria-pressed={command.isActive}
      title={command.disabledReason ?? label}
      disabled={disabled || !command.isEnabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => command.execute()}
    >
      {icon}
    </Button>
  );

  return (
    <section
      aria-label={labels.toolbar}
      className={cn(
        "flex shrink-0 flex-none flex-wrap items-center gap-1 border-b bg-background px-2 py-1",
        className,
      )}
      data-testid="word-formatting-toolbar"
    >
      {button(labels.undo, <Undo2 />, undo)}
      {button(labels.redo, <Redo2 />, redo)}
      <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
      {button(labels.bold, <Bold />, bold)}
      {button(labels.italic, <Italic />, italic)}
      {compact && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={expanded ? labels.fewerTools : labels.moreTools}
          aria-expanded={expanded}
          title={expanded ? labels.fewerTools : labels.moreTools}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUp /> : <ChevronDown />}
        </Button>
      )}
      {showFormatting && (
        <>
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
          <select
            aria-label={labels.fontFamily}
            title={labels.fontFamily}
            className="h-7 min-w-28 max-w-40 rounded-md border border-input bg-background px-1.5 text-xs text-foreground disabled:opacity-50"
            value={fontFamily.value ?? ""}
            disabled={disabled || !fontFamily.isEnabled}
            onChange={(event) => fontFamily.setValue(event.target.value)}
          >
            {fontFamily.value === null && <option value="" disabled>{labels.mixed}</option>}
            {fontFamily.options.map((family) => <option key={family} value={family}>{family}</option>)}
          </select>
          <select
            aria-label={labels.fontSize}
            title={labels.fontSize}
            className="h-7 w-16 rounded-md border border-input bg-background px-1.5 text-xs text-foreground disabled:opacity-50"
            value={fontSize.value ?? ""}
            disabled={disabled || !fontSize.isEnabled}
            onChange={(event) => fontSize.execute(Number(event.target.value))}
          >
            {fontSize.value === null && <option value="" disabled>{labels.mixed}</option>}
            {fontSizeOptions.map((value) => <option key={value} value={value}>{fontSizeLabel(value)}</option>)}
          </select>
          {button(labels.alignLeft, <AlignLeft />, alignLeft)}
          {button(labels.alignCenter, <AlignCenter />, alignCenter)}
          {button(labels.alignRight, <AlignRight />, alignRight)}
        </>
      )}
    </section>
  );
}

export interface WordToolbarPortalProps extends WordFormattingToolbarProps {
  target: HTMLElement | null;
}

export function WordToolbarPortal({ target, ...props }: WordToolbarPortalProps) {
  return target ? createPortal(<WordFormattingToolbar {...props} />, target) : null;
}
