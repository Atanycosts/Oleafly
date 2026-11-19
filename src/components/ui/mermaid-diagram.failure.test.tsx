// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/lib/theme";
import { Markdown } from "./markdown";
import { clearDiagramCache } from "./mermaid-diagram";
import {
  installIntersectionObserverStub,
  type IntersectionObserverStub,
} from "./test-intersection-observer";

const mermaidRender = vi.hoisted(() => vi.fn());

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: mermaidRender,
  },
}));

describe("Mermaid render failures", () => {
  let intersection: IntersectionObserverStub | null = null;

  beforeAll(async () => {
    await import("./markdown-renderer");
  });

  beforeEach(() => {
    clearDiagramCache();
    mermaidRender.mockReset();
    mermaidRender.mockRejectedValue(new Error("parse error"));
    window.localStorage.setItem("oleafly.theme", "dark");
  });

  afterEach(() => {
    intersection?.restore();
    intersection = null;
  });

  it("does not retry a failed diagram when it scrolls out of view and back", async () => {
    intersection = installIntersectionObserverStub(() => true);
    render(
      <ThemeProvider>
        <Markdown>{"```mermaid\nflowchart TD\n  A --> B\n```"}</Markdown>
      </ThemeProvider>,
    );
    await waitFor(() => expect(mermaidRender).toHaveBeenCalledTimes(1));

    act(() => intersection?.setVisible(() => false));
    act(() => intersection?.setVisible(() => true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(mermaidRender).toHaveBeenCalledTimes(1);
  });

  it("retries when the Mermaid source is corrected", async () => {
    intersection = installIntersectionObserverStub(() => true);
    mermaidRender
      .mockReset()
      .mockRejectedValueOnce(new Error("parse error"))
      .mockResolvedValueOnce({
        svg:
          '<svg xmlns="http://www.w3.org/2000/svg">'
          + "<text>Recovered diagram</text>"
          + "</svg>",
      });
    const invalid = "```mermaid\nnot a valid diagram\n```";
    const corrected = "```mermaid\nflowchart TD\n  A --> B\n```";
    const view = render(
      <ThemeProvider>
        <Markdown>{invalid}</Markdown>
      </ThemeProvider>,
    );

    expect(await screen.findByRole("status", { name: "Unable to render diagram." })).toBeTruthy();
    expect(screen.getByText("not a valid diagram")).toBeTruthy();

    view.rerender(
      <ThemeProvider>
        <Markdown>{corrected}</Markdown>
      </ThemeProvider>,
    );

    expect((await screen.findByRole("img", { name: "Diagram" })).textContent)
      .toBe("Recovered diagram");
    expect(screen.queryByRole("status", { name: "Unable to render diagram." })).toBeNull();
  });
});
