// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enCore from "@/i18n/locales/en/core.json" with { type: "json" };
import { applyTheme } from "@/lib/theme";
import { cachedDiagram, clearDiagramCache, MermaidDiagram, renderDiagram } from "./mermaid-diagram";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaid }));

const SOURCE = "flowchart TD\n  A --> B";

function themedSvg() {
  const theme = mermaid.initialize.mock.calls.at(-1)?.[0].theme;
  return diagramSvg(theme);
}

function diagramSvg(text: string) {
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${text}</text></svg>` };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const diagram = () => screen.findByRole("img", { name: enCore.mermaid.diagram });

beforeEach(() => {
  clearDiagramCache();
  mermaid.initialize.mockReset();
  mermaid.render.mockReset();
  mermaid.render.mockImplementation(async () => themedSvg());
  applyTheme("dark");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rendering diagrams", () => {
  it("shares one render between callers and reuses the finished drawing", async () => {
    const first = renderDiagram(SOURCE, "dark");

    expect(renderDiagram(SOURCE, "dark")).toBe(first);
    const svg = await first;
    await expect(renderDiagram(SOURCE, "dark")).resolves.toBe(svg);
    expect(cachedDiagram(SOURCE, "dark")).toBe(svg);
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", theme: "dark" }));
  });

  it("refuses output that is not a single SVG", async () => {
    mermaid.render.mockResolvedValue({ svg: "<div>not a drawing</div>" });

    await expect(renderDiagram(SOURCE, "light")).rejects.toThrow("Invalid Mermaid SVG");
    expect(cachedDiagram(SOURCE, "light")).toBeUndefined();
  });
});

describe("MermaidDiagram", () => {
  it("shows the source with an error when the drawing fails, and does not try again", async () => {
    mermaid.render.mockRejectedValue(new Error("parse error"));
    const { container, unmount } = render(<MermaidDiagram source={SOURCE} />);

    expect(await screen.findByRole("status", { name: enCore.mermaid.renderFailed })).toBeTruthy();
    expect(container.querySelector("code")?.textContent).toBe(SOURCE);
    unmount();

    render(<MermaidDiagram source={SOURCE} />);

    expect(await screen.findByRole("status", { name: enCore.mermaid.renderFailed })).toBeTruthy();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it("redraws for a new theme when the browser is idle and reuses earlier drawings", async () => {
    const idle: Array<() => void> = [];
    vi.stubGlobal("requestIdleCallback", (callback: () => void) => idle.push(callback));
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    render(<MermaidDiagram source={SOURCE} />);
    expect((await diagram()).textContent).toBe("dark");

    act(() => applyTheme("light"));
    expect((await diagram()).textContent).toBe("dark");
    expect(idle).toHaveLength(1);

    act(() => idle[0]());
    await vi.waitFor(async () => expect((await diagram()).textContent).toBe("default"));

    act(() => applyTheme("dark"));

    expect((await diagram()).textContent).toBe("dark");
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });

  it("draws the current theme when the theme changes during a render", async () => {
    const idle: Array<() => void> = [];
    const cancelIdle = vi.fn();
    vi.stubGlobal("requestIdleCallback", (callback: () => void) => idle.push(callback));
    vi.stubGlobal("cancelIdleCallback", cancelIdle);
    const dark = deferred<{ svg: string }>();
    mermaid.render.mockImplementationOnce(() => dark.promise);
    render(<MermaidDiagram source={SOURCE} />);
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));

    act(() => applyTheme("light"));
    await act(async () => {
      dark.resolve(themedSvg());
      await dark.promise;
    });

    expect(screen.queryByRole("img", { name: enCore.mermaid.diagram })).toBeNull();
    expect(cancelIdle).toHaveBeenCalledWith(1);
    act(() => idle.at(-1)?.());

    expect((await diagram()).textContent).toBe("default");
  });

  it("does not surface a failure from a theme superseded during rendering", async () => {
    const idle: Array<() => void> = [];
    vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
      idle.push(callback);
      return idle.length;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const dark = deferred<{ svg: string }>();
    const light = deferred<{ svg: string }>();
    mermaid.render
      .mockImplementationOnce(() => dark.promise)
      .mockImplementationOnce(() => light.promise);
    render(<MermaidDiagram source={SOURCE} />);
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));

    act(() => applyTheme("light"));
    await act(async () => {
      dark.reject(new Error("dark render failed"));
      await dark.promise.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByRole("status", { name: enCore.mermaid.renderFailed })).toBeNull();
    expect(screen.getByRole("status", { name: enCore.mermaid.rendering })).toBeTruthy();

    act(() => idle.at(-1)?.());
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    await act(async () => {
      light.resolve(themedSvg());
      await light.promise;
    });

    expect((await diagram()).textContent).toBe("default");
  });

  it("keeps the last good drawing when a theme redraw fails", async () => {
    const idle: Array<() => void> = [];
    vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
      idle.push(callback);
      return idle.length;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const light = deferred<{ svg: string }>();
    mermaid.render
      .mockImplementationOnce(async () => diagramSvg("dark drawing"))
      .mockImplementationOnce(() => light.promise);
    render(<MermaidDiagram source={SOURCE} />);
    expect((await diagram()).textContent).toBe("dark drawing");

    act(() => applyTheme("light"));
    act(() => idle[0]());
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    await act(async () => {
      light.reject(new Error("light render failed"));
      await light.promise.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      screen.getByRole("img", { name: enCore.mermaid.diagram }).textContent,
    ).toBe("dark drawing");
    expect(screen.queryByRole("status", { name: enCore.mermaid.renderFailed })).toBeNull();
  });

  it("cancels an idle theme redraw when the diagram unmounts", async () => {
    const idle: Array<() => void> = [];
    const cancelIdle = vi.fn();
    vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
      idle.push(callback);
      return idle.length;
    });
    vi.stubGlobal("cancelIdleCallback", cancelIdle);
    const view = render(<MermaidDiagram source={SOURCE} />);
    await diagram();

    act(() => applyTheme("light"));
    expect(idle).toHaveLength(1);
    view.unmount();

    expect(cancelIdle).toHaveBeenCalledWith(1);
    act(() => idle[0]());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it("ignores a late drawing after the source is replaced", async () => {
    const stale = deferred<{ svg: string }>();
    mermaid.render
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(diagramSvg("current source"));
    const view = render(
      <MermaidDiagram key="stale-source" source="flowchart TD\n  Old --> Drawing" />,
    );
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));

    view.rerender(
      <MermaidDiagram key="current-source" source="flowchart TD\n  Current --> Drawing" />,
    );
    expect(screen.getByRole("status", { name: enCore.mermaid.rendering })).toBeTruthy();

    await act(async () => {
      stale.resolve(diagramSvg("stale drawing"));
      await stale.promise;
    });

    expect((await diagram()).textContent).toBe("current source");
    expect(screen.queryByText("stale drawing")).toBeNull();
  });

  it("ignores a late failure after the source is replaced", async () => {
    const stale = deferred<{ svg: string }>();
    mermaid.render
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(diagramSvg("current source"));
    const view = render(
      <MermaidDiagram key="stale-source" source="flowchart TD\n  Old --> Drawing" />,
    );
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));

    view.rerender(
      <MermaidDiagram key="current-source" source="flowchart TD\n  Current --> Drawing" />,
    );
    await act(async () => {
      stale.reject(new Error("stale render failed"));
      await stale.promise.catch(() => undefined);
    });

    expect((await diagram()).textContent).toBe("current source");
    expect(screen.queryByRole("status", { name: enCore.mermaid.renderFailed })).toBeNull();
  });

  it("grows smoothly from the placeholder to the drawing's height", async () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 112 } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(300);
    const { container } = render(<MermaidDiagram source={SOURCE} />);
    await diagram();
    const shell = container.querySelector<HTMLElement>("[data-mermaid-diagram]");

    expect(shell?.style.height).toBe("112px");
    act(() => frames[0]());
    expect(shell?.style.height).toBe("300px");

    const other = new Event("transitionend", { bubbles: true });
    Object.defineProperty(other, "propertyName", { value: "opacity" });
    act(() => {
      shell?.dispatchEvent(other);
    });
    expect(shell?.style.height).toBe("300px");

    const finished = new Event("transitionend", { bubbles: true });
    Object.defineProperty(finished, "propertyName", { value: "height" });
    act(() => {
      shell?.dispatchEvent(finished);
    });
    expect(shell?.style.height).toBe("");
  });

  it("drops a pending height change when it unmounts", async () => {
    const cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", () => 7);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 112 } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(300);
    const { unmount } = render(<MermaidDiagram source={SOURCE} />);
    await diagram();

    unmount();

    expect(cancelFrame).toHaveBeenCalledWith(7);
  });
});
