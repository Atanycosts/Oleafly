// @vitest-environment jsdom

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface RenderCall {
  pageNumber: number;
  canvas: HTMLCanvasElement;
  detail: boolean;
  cancelled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  cancel: () => void;
}

const harness = vi.hoisted(() => ({
  observerCallbacks: [] as IntersectionObserverCallback[],
  resizeCallbacks: [] as ResizeObserverCallback[],
  renderCalls: [] as RenderCall[],
  pageCleanups: 0,
  deferDetail: false,
  reset() {
    this.observerCallbacks = [];
    this.resizeCallbacks = [];
    this.renderCalls = [];
    this.pageCleanups = 0;
    this.deferDetail = false;
  },
}));

vi.mock("./mainThreadWorker", () => ({ installMainThreadPdfWorker: vi.fn() }));
vi.mock("./pdfController", () => ({
  registerPdfView: vi.fn(),
  clearPdfView: vi.fn(),
  pageClickToBp: vi.fn(() => null),
}));
vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => ({
  EventBus: class {
    dispatch() {}
  },
  LinkTarget: { BLANK: 2 },
  DownloadManager: class {},
  PDFLinkService: class {
    eventBus = { dispatch() {} };
    setDocument() {}
    setViewer() {}
  },
  StructTreeLayerBuilder: class {
    render() {
      return Promise.resolve(null);
    }
    updateTextLayer() {}
    show() {}
    hide() {}
  },
}));
vi.mock("pdfjs-dist", () => {
  class MockViewport {
    readonly width: number;
    readonly height: number;
    readonly rotation = 0;
    readonly userUnit = 1;
    readonly rawDims = {
      pageWidth: 612,
      pageHeight: 792,
      pageX: 0,
      pageY: 0,
    };

    constructor(readonly scale: number) {
      this.width = 612 * scale;
      this.height = 792 * scale;
    }

    clone({ scale = this.scale }: { scale?: number; dontFlip?: boolean } = {}) {
      return new MockViewport(scale);
    }
  }

  const page = {
    rotate: 0,
    getViewport: ({ scale }: { scale: number }) => new MockViewport(scale),
    getTextContent: () =>
      Promise.resolve({
        items: [
          {
            str: "PAGE 1",
            width: 120,
            height: 12,
            fontName: "f",
            transform: [1, 0, 0, 1, 0, 0],
          },
        ],
        styles: { f: { vertical: false } },
      }),
    render: ({
      canvas,
    }: {
      canvas: HTMLCanvasElement;
    }) => {
      let resolvePromise!: () => void;
      let rejectPromise!: (error: Error) => void;
      const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      const call: RenderCall = {
        pageNumber: 1,
        canvas,
        detail: canvas.classList.contains("pdf-canvas-detail"),
        cancelled: false,
        resolve: resolvePromise,
        reject: rejectPromise,
        cancel: () => {
          call.cancelled = true;
        },
      };
      harness.renderCalls.push(call);
      if (!call.detail || !harness.deferDetail) resolvePromise();
      return {
        promise,
        onContinue: null,
        cancel: call.cancel,
      };
    },
    getAnnotations: () => Promise.resolve([]),
    getStructTree: () => Promise.resolve(null),
    cleanup: () => {
      harness.pageCleanups++;
    },
  };

  return {
    GlobalWorkerOptions: { workerSrc: "" },
    PasswordResponses: { INCORRECT_PASSWORD: 2 },
    normalizeUnicode: (value: string) => value,
    PDFWorker: class {
      promise = Promise.resolve();
      destroy() {}
    },
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        annotationStorage: {},
        getOptionalContentConfig: () => Promise.resolve({}),
        getPage: () => Promise.resolve(page),
      }),
      destroy: () => Promise.resolve(),
    }),
    TextLayer: class {
      readonly textDivs: HTMLElement[] = [];
      constructor(private readonly options: { container: HTMLElement }) {}
      async render() {
        const span = document.createElement("span");
        span.textContent = "text";
        this.textDivs.push(span);
        this.options.container.append(span);
      }
      cancel() {}
    },
    AnnotationLayer: class {
      render() {
        return Promise.resolve();
      }
      destroy() {}
    },
  };
});

import { PdfViewer } from "./PdfViewer";

const jsdomBoundingClientRect = Element.prototype.getBoundingClientRect;

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  harness.reset();
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value: 2,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        harness.observerCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        harness.resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Scene {
  view: ReturnType<typeof render>;
  data: Uint8Array;
  wrap: HTMLElement;
  base: () => HTMLCanvasElement | null;
  detail: () => HTMLCanvasElement | null;
  detailCalls: () => RenderCall[];
  resizeViewport: (size: [number, number]) => void;
  zoom: (scale: number) => void;
}

async function openPage(scale = 2.5): Promise<Scene> {
  const data = new Uint8Array([1]);
  const view = render(
    <PdfViewer data={data} scale={scale} expectText={false} />,
  );
  const renderer = view.getByTestId("pdf-renderer");
  const scrollParent = renderer.parentElement as HTMLElement;
  let viewportSize: [number, number] = [800, 600];
  const pagePosition: [number, number] = [0, 0];
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      if (this === scrollParent) {
        return domRect(0, 0, viewportSize[0], viewportSize[1]);
      }
      if (
        this instanceof HTMLElement &&
        this === view.container.querySelector("[data-page='1']")
      ) {
        return domRect(
          pagePosition[0],
          pagePosition[1],
          Number.parseFloat(this.style.width),
          Number.parseFloat(this.style.height),
        );
      }
      return jsdomBoundingClientRect.call(this);
    },
  );

  await waitFor(() => expect(renderer.dataset.pdfState).toBe("ready"));
  const wrap = view.container.querySelector<HTMLElement>("[data-page='1']")!;
  const base = () =>
    wrap.querySelector<HTMLCanvasElement>(":scope > .pdf-canvas");
  const detail = () =>
    wrap.querySelector<HTMLCanvasElement>(":scope > .pdf-canvas-detail");
  await waitFor(() => expect(base()).not.toBeNull());
  expect(wrap.dataset.pdfCanvasScaling).toBe("restricted");

  return {
    view,
    data,
    wrap,
    base,
    detail,
    detailCalls: () => harness.renderCalls.filter((call) => call.detail),
    resizeViewport: (size) => {
      viewportSize = size;
      const callback = harness.resizeCallbacks.at(-1);
      if (!callback) throw new Error("Resize observer is not installed");
      act(() => callback([], {} as ResizeObserver));
    },
    zoom: (nextScale) => {
      view.rerender(
        <PdfViewer data={data} scale={nextScale} expectText={false} />,
      );
    },
  };
}

async function nextAnimationFrame(): Promise<void> {
  await act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

describe("PdfViewer detail raster lifecycle", () => {
  it("cancels a pending detail render on zoom and ignores its late completion", async () => {
    const scene = await openPage();
    await waitFor(() => expect(scene.wrap.dataset.pdfDetail).toBe("ready"));
    const successfulDetail = scene.detail()!;
    const base = scene.base()!;
    const pageWidthBefore = Number.parseFloat(scene.wrap.style.width);
    const initialRenderCount = scene.detailCalls().length;

    harness.deferDetail = true;
    scene.resizeViewport([1_400, 900]);
    await waitFor(() =>
      expect(scene.detailCalls().length).toBe(initialRenderCount + 1),
    );
    await waitFor(() => expect(scene.wrap.dataset.pdfDetail).toBe("rendering"));
    const pending = scene.detailCalls().at(-1)!;
    expect(pending.canvas.isConnected).toBe(false);

    const rasterTimers: Array<() => void> = [];
    const nativeSetTimeout = window.setTimeout.bind(window);
    const timers = vi.spyOn(window, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 120 && typeof handler === "function") {
        rasterTimers.push(handler as () => void);
        return 0;
      }
      return nativeSetTimeout(handler, delay, ...args);
    }) as typeof window.setTimeout);
    try {
      scene.zoom(3);

      await waitFor(() => {
        expect(pending.cancelled).toBe(true);
        expect(Number.parseFloat(scene.wrap.style.width)).toBeGreaterThan(
          pageWidthBefore,
        );
        expect(rasterTimers).toHaveLength(1);
      });
      expect(pending.canvas.width).toBe(0);
      expect(pending.canvas.height).toBe(0);
      expect(successfulDetail.isConnected).toBe(true);
      expect(scene.detail()).toBe(successfulDetail);
      expect(base.isConnected).toBe(true);
      expect(scene.wrap.dataset.pdfDetail).toBe("ready");

      await act(async () => pending.resolve());
      await waitFor(() => expect(scene.wrap.dataset.pdfDetail).toBe("ready"));
      expect(scene.detail()).toBe(successfulDetail);
      expect(successfulDetail.isConnected).toBe(true);
      expect(base.isConnected).toBe(true);
    } finally {
      timers.mockRestore();
    }
  });

  it("re-renders detail only when the resized viewport leaves its covered area", async () => {
    const scene = await openPage();
    await waitFor(() => expect(scene.wrap.dataset.pdfDetail).toBe("ready"));
    const original = scene.detail()!;
    const base = scene.base()!;
    const initialRenderCount = scene.detailCalls().length;

    harness.deferDetail = true;
    scene.resizeViewport([800, 600]);
    await nextAnimationFrame();
    expect(scene.detailCalls()).toHaveLength(initialRenderCount);
    expect(scene.detail()).toBe(original);

    scene.resizeViewport([1_400, 900]);
    await waitFor(() =>
      expect(scene.detailCalls().length).toBe(initialRenderCount + 1),
    );
    const replacementCall = scene.detailCalls().at(-1)!;
    expect(scene.wrap.dataset.pdfDetail).toBe("rendering");
    expect(original.isConnected).toBe(true);
    expect(base.isConnected).toBe(true);

    await act(async () => replacementCall.resolve());
    await waitFor(() => expect(scene.wrap.dataset.pdfDetail).toBe("ready"));
    const replacement = scene.detail()!;
    expect(replacement).toBe(replacementCall.canvas);
    expect(replacement).not.toBe(original);
    expect(original.isConnected).toBe(false);
    expect(original.width).toBe(0);
    expect(base.isConnected).toBe(true);
    expect(scene.base()).toBe(base);
    expect(replacement.width).toBe(
      Number.parseFloat(replacement.style.width) * 2,
    );
  });

  it("keeps the previous successful detail and base when a replacement render fails", async () => {
    const scene = await openPage();
    await waitFor(() => expect(scene.wrap.dataset.pdfDetail).toBe("ready"));
    const successfulDetail = scene.detail()!;
    const base = scene.base()!;
    const initialRenderCount = scene.detailCalls().length;

    harness.deferDetail = true;
    scene.resizeViewport([1_400, 900]);
    await waitFor(() =>
      expect(scene.detailCalls().length).toBe(initialRenderCount + 1),
    );
    const failed = scene.detailCalls().at(-1)!;
    expect(scene.wrap.dataset.pdfDetail).toBe("rendering");

    await act(async () => failed.reject(new Error("detail render failed")));

    await waitFor(() => expect(scene.wrap.dataset.pdfDetail).toBe("ready"));
    expect(failed.canvas.isConnected).toBe(false);
    expect(failed.canvas.width).toBe(0);
    expect(failed.canvas.height).toBe(0);
    expect(scene.detail()).toBe(successfulDetail);
    expect(successfulDetail.isConnected).toBe(true);
    expect(scene.base()).toBe(base);
    expect(base.isConnected).toBe(true);
  });

  it("cancels and releases a pending detail render when the viewer unmounts", async () => {
    harness.deferDetail = true;
    const scene = await openPage();
    await waitFor(() => expect(scene.detailCalls().length).toBeGreaterThan(0));
    const pending = scene.detailCalls().at(-1)!;
    const base = scene.base()!;
    expect(base.isConnected).toBe(true);
    expect(pending.canvas.isConnected).toBe(false);
    expect(scene.wrap.dataset.pdfDetail).toBe("rendering");

    scene.view.unmount();

    expect(pending.cancelled).toBe(true);
    expect(pending.canvas.width).toBe(0);
    expect(pending.canvas.height).toBe(0);
    expect(base.width).toBe(0);
    expect(base.height).toBe(0);
    expect(harness.pageCleanups).toBeGreaterThan(0);
    expect(scene.view.container.querySelector("[data-page='1']")).toBeNull();
  });
});
