// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDocxHistory, runDocxHistory } from "./docx-history";

afterEach(() => {
  document.body.replaceChildren();
});

describe("DOCX history routing", () => {
  it("dispatches undo and redo from the working Word surface", () => {
    const root = document.createElement("section");
    root.dataset.docxHistory = "working";
    const target = document.createElement("button");
    root.append(target);
    document.body.append(root);
    const exec = vi.fn();
    const unregister = registerDocxHistory(root, () => ({ exec }));

    expect(runDocxHistory(target, false)).toBe(true);
    expect(runDocxHistory(target, true)).toBe(true);
    expect(exec.mock.calls).toEqual([[{ type: "undo" }], [{ type: "redo" }]]);

    unregister();
  });

  it("consumes history from a nested read-only document without dispatching", () => {
    const root = document.createElement("section");
    root.dataset.docxHistory = "working";
    const original = document.createElement("div");
    original.dataset.docxHistory = "readonly";
    const target = document.createElement("button");
    original.append(target);
    root.append(original);
    document.body.append(root);
    const exec = vi.fn();
    const unregister = registerDocxHistory(root, () => ({ exec }));

    expect(runDocxHistory(target, false)).toBe(true);
    expect(exec).not.toHaveBeenCalled();

    unregister();
  });

  it("leaves tool text fields to their own history", () => {
    const root = document.createElement("section");
    root.dataset.docxHistory = "working";
    const tools = document.createElement("aside");
    tools.dataset.docxHistory = "field";
    const input = document.createElement("textarea");
    tools.append(input);
    root.append(tools);
    document.body.append(root);
    const exec = vi.fn();
    const unregister = registerDocxHistory(root, () => ({ exec }));

    expect(runDocxHistory(input, false)).toBe(false);
    expect(exec).not.toHaveBeenCalled();

    unregister();
  });
});
