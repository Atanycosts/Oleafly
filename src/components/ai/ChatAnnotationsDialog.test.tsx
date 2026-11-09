// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import common from "@/i18n/locales/en/common.json" with { type: "json" };
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import type { AnnotationContext, AnnotationTarget, TaskAnnotation, TaskAnnotationDraft } from "@/lib/task-collaboration";
import { ChatAnnotationsDialog } from "./ChatAnnotationsDialog";

const api = vi.hoisted(() => ({ loadTask: vi.fn(), loadObject: vi.fn(), submit: vi.fn() }));
vi.mock("@/lib/task-collaboration", () => ({
  loadTaskAnnotations: api.loadTask,
  loadObjectAnnotations: api.loadObject,
  submitTaskAnnotation: api.submit,
}));

const text = en.tasks.annotations;
const originalTarget: AnnotationTarget = {
  projectId: "paper", taskId: null, objectKind: "thread", objectId: "thread-real",
  objectRevision: "message:message-old", path: null,
};
function annotation(patch: Partial<TaskAnnotation> = {}): TaskAnnotation {
  return {
    id: "annotation-old", target: originalTarget, author: { kind: "user", id: "user" }, body: "Revisit this earlier decision.",
    parentId: null, mentions: [], explicitRequest: false, status: "open", createdAt: 1, updatedAt: 1,
    handledAt: null, handledBy: null, ...patch,
  };
}
function context(annotations: TaskAnnotation[] = []): AnnotationContext {
  return { annotations, deliveries: [], requirements: [], handlings: [], distillations: [] };
}

beforeEach(() => {
  api.loadTask.mockReset();
  api.loadObject.mockReset().mockResolvedValue(context());
    api.submit.mockReset().mockImplementation(async (draft: TaskAnnotationDraft) => annotation({
      ...draft,
      source: draft.source ? { ...draft.source, sha256: "source-hash" } : null,
      id: "annotation-saved",
    }));
});

describe("ChatAnnotationsDialog", () => {
  it("shows the selected historical source verbatim and saves feedback against its real message target", async () => {
    const source = "  An earlier decision.\nKeep this original wording.  ";
    const onSaved = vi.fn();
    render(<ChatAnnotationsDialog open onOpenChange={vi.fn()} target={originalTarget} source={{ role: "assistant", content: source }} onSaved={onSaved} />);

    const dialog = screen.getByRole("dialog", { name: text.chatTitle });
    expect(within(dialog).getByText((_, node) => node?.tagName === "BLOCKQUOTE" && node.textContent === source)).toBeInTheDocument();
    await within(dialog).findByText(text.empty);
    expect(api.loadObject).toHaveBeenCalledWith(originalTarget);
    expect(api.loadTask).not.toHaveBeenCalled();
    expect(within(dialog).getByText(text.chatRequestHint)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: text.explicitRequest })).not.toBeChecked();

    const body = "  Review this old message again.\nRetain its evidence.  ";
    fireEvent.change(within(dialog).getByRole("textbox", { name: text.body }), { target: { value: body } });
    fireEvent.click(within(dialog).getByRole("button", { name: text.save }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledWith({
      target: originalTarget, body, source: { kind: "chat_message:assistant", content: source }, parentId: null, mentions: [], explicitRequest: false,
    }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: "annotation-saved", target: originalTarget, body, explicitRequest: false,
    })));
    expect(api.submit.mock.calls[0][0].target.taskId).toBeNull();
    expect(api.loadTask).not.toHaveBeenCalled();
  });

  it("opens retained review evidence through the supplied action and only displays an actual handling", async () => {
    const loaded = context([
      annotation({ id: "status-only", status: "handled", body: "An unsupported completion label." }),
      annotation({ status: "handled" }),
    ]);
    const evidence: AnnotationTarget = {
      projectId: "paper", taskId: "task-real", objectKind: "run", objectId: "run-old", objectRevision: "sha-old", path: "runs/run-old.json",
    };
    loaded.handlings = [{
      id: "handling-real", annotationId: "annotation-old", author: { kind: "member", id: "reviewer-real" },
      summary: "Compared the original decision with the retained run.", resultRefs: [evidence], createdAt: 2,
    }];
    api.loadObject.mockResolvedValue(loaded);
    const onOpenTarget = vi.fn();
    render(<ChatAnnotationsDialog open onOpenChange={vi.fn()} target={originalTarget} onOpenTarget={onOpenTarget} />);

    const cards = await screen.findAllByTestId("task-annotation");
    expect(within(cards[0]).queryByText(text.handled)).toBeNull();
    expect(within(cards[1]).getByText(text.handled)).toBeInTheDocument();
    expect(within(cards[1]).getByText("Compared the original decision with the retained run.")).toBeInTheDocument();
    expect(within(cards[1]).queryByText(text.queued)).toBeNull();
    fireEvent.click(within(cards[1]).getByRole("button", { name: "run:run-old · sha-old · runs/run-old.json" }));
    expect(onOpenTarget).toHaveBeenCalledExactlyOnceWith(evidence);
    expect(api.loadTask).not.toHaveBeenCalled();
  });

  it("reads nothing while closed and closes from the dialog controls after opening the thread scope", async () => {
    const target = { ...originalTarget, objectRevision: null };
    const onOpenChange = vi.fn();
    const view = render(<ChatAnnotationsDialog open={false} onOpenChange={onOpenChange} target={target} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.loadObject).not.toHaveBeenCalled();

    view.rerender(<ChatAnnotationsDialog open onOpenChange={onOpenChange} target={target} />);
    await screen.findByText(text.empty);
    expect(api.loadObject).toHaveBeenCalledWith(target);
    fireEvent.click(screen.getByRole("button", { name: common.actions.close }));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(api.submit).not.toHaveBeenCalled();
  });
});
