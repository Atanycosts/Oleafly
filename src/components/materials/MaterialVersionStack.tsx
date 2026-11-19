import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type MaterialVersionSide = "previous" | "current";
export type MaterialVersionStackMode = MaterialVersionSide | "stack";

export interface MaterialVersionStackProps {
  mode: MaterialVersionStackMode;
  previous: ReactNode;
  current: ReactNode;
  previousLabel: string;
  currentLabel: string;
  foreground?: MaterialVersionSide;
  onForegroundChange?: (version: MaterialVersionSide) => void;
  className?: string;
}

export function MaterialVersionStack({ mode, previous, current, previousLabel, currentLabel, foreground, onForegroundChange, className }: MaterialVersionStackProps) {
  const [localForeground, setLocalForeground] = useState<MaterialVersionSide>("current");
  const front = mode === "stack" ? foreground ?? localForeground : mode;
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const active = root.current?.ownerDocument.activeElement;
    if (active instanceof HTMLElement && root.current?.querySelector(`[data-version="${front === "current" ? "previous" : "current"}"]`)?.contains(active)) active.blur();
  }, [front]);
  const bringForward = (version: MaterialVersionSide) => {
    setLocalForeground(version);
    onForegroundChange?.(version);
  };
  const layer = (version: MaterialVersionSide, label: string, children: ReactNode) => {
    const isFront = front === version;
    const stacked = mode === "stack";
    return <section id={`${id}-${version}`} aria-label={label} data-version={version} data-foreground={isFront}
      hidden={!stacked && !isFront} inert={!isFront ? true : undefined} aria-hidden={!isFront ? true : undefined}
      className={cn("absolute min-h-0 min-w-0 overflow-hidden bg-background", stacked ? "rounded-lg border border-border duration-200 ease-out motion-safe:transition-[transform,box-shadow] motion-reduce:transition-none" : "inset-0", !isFront && "pointer-events-none select-none")}
      style={stacked ? {
        zIndex: isFront ? 2 : 1,
        top: 0,
        left: 0,
        right: "var(--stack-offset)",
        bottom: "var(--stack-offset)",
        transform: isFront ? "translate3d(var(--stack-offset), var(--stack-offset), 0)" : "translate3d(0, 0, 0)",
        boxShadow: isFront ? "0 8px 24px rgb(0 0 0 / 0.16), 0 1px 4px rgb(0 0 0 / 0.12)" : "0 2px 8px rgb(0 0 0 / 0.08)",
      } : undefined}>
      <div data-testid="material-version-back-label" hidden={!stacked || isFront} aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-[60] flex h-[var(--stack-offset)] items-center border-b border-border bg-background px-3 text-xs font-medium text-muted-foreground">
        <span className="truncate">{label}</span>
      </div>
      {children}
    </section>;
  };
  return <div ref={root} className={cn("flex h-full min-h-0 min-w-0 flex-col", className)} data-testid="material-version-stack" data-mode={mode}>
    <div hidden={mode !== "stack"} className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
      <Button size="xs" variant={front === "previous" ? "secondary" : "outline"} aria-pressed={front === "previous"} aria-controls={`${id}-previous`} onClick={() => bringForward("previous")}>{previousLabel}</Button>
      <Button size="xs" variant={front === "current" ? "secondary" : "outline"} aria-pressed={front === "current"} aria-controls={`${id}-current`} onClick={() => bringForward("current")}>{currentLabel}</Button>
    </div>
    <div className="relative isolate min-h-0 min-w-0 flex-1 [--stack-offset:28px]" data-testid="material-version-canvas">
      {layer("previous", previousLabel, previous)}
      {layer("current", currentLabel, current)}
    </div>
  </div>;
}
