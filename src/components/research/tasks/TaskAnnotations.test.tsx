// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotationContext, AnnotationTarget, GroupMember, TaskAnnotation, TaskAnnotationDraft } from "@/lib/task-collaboration";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import { researchTaskFixture } from "./tests/task-fixtures";
import { TaskAnnotations } from "./TaskAnnotations";

const api = vi.hoisted(() => ({ load: vi.fn(), loadObject: vi.fn(), submit: vi.fn() }));
vi.mock("@/lib/task-collaboration", () => ({ loadTaskAnnotations: api.load, loadObjectAnnotations: api.loadObject, submitTaskAnnotation: api.submit }));
const text = en.tasks.annotations;

function target(patch: Partial<AnnotationTarget> = {}): AnnotationTarget {
  return { projectId: "paper", taskId: "task-1", objectKind: "decision", objectId: "decision-old", objectRevision: "revision-old", path: "methods.tex", ...patch };
}
function annotation(patch: Partial<TaskAnnotation> = {}): TaskAnnotation {
  return {
    id: "annotation-1", target: target(), author: { kind: "user", id: "user" }, body: "Keep the original evidence visible.",
    parentId: null, mentions: [], explicitRequest: false, status: "open", createdAt: 1, updatedAt: 1, handledAt: null, handledBy: null,
    ...patch,
  };
}
function context(annotations: TaskAnnotation[] = []): AnnotationContext {
  return { annotations, deliveries: [], requirements: [], handlings: [], distillations: [] };
}
const task = () => researchTaskFixture({ executionGeneration: 7, status: "completed", sourceRevision: "baseline-source-hash" });
function member(): GroupMember {
  return {
    id: "member-reviewer", groupId: "group-1", name: "Reviewer", responsibility: "Evidence", runtimeId: "builtin",
    agentId: "openai", modelId: "model", skillIds: [], coordinator: false, paused: false, joinedAt: 1,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function typeBody(body: string) {
  fireEvent.change(screen.getByRole("textbox", { name: text.body }), { target: { value: body } });
}

beforeEach(() => {
  api.load.mockReset().mockResolvedValue(context());
  api.loadObject.mockReset().mockResolvedValue(context());
  api.submit.mockReset().mockImplementation(async (draft: TaskAnnotationDraft) => annotation({
    ...draft,
    source: draft.source ? { ...draft.source, sha256: "source-hash" } : null,
    id: "annotation-saved",
  }));
});

describe("TaskAnnotations", () => {
  it("saves an ordinary chat annotation with its real object target and exact original words without a task context", async () => {
    const objectTarget = target({ taskId: null, objectKind: "thread", objectId: "thread-real", objectRevision: "message:message-stable-1", path: null });
    const body = "  This message needs a second look.\nKeep the original distinction.  ";
    api.loadObject.mockResolvedValueOnce(context()).mockResolvedValueOnce(context([annotation({ target: objectTarget, body, explicitRequest: true })]));
    render(<TaskAnnotations contextScope="object" objectTarget={objectTarget} />);
    await screen.findByText(text.empty);
    expect(api.loadObject).toHaveBeenCalledWith(objectTarget);
    expect(api.load).not.toHaveBeenCalled();
    expect(screen.getByText(text.chatRequestHint)).toBeInTheDocument();
    expect(screen.queryByText(text.requestHint)).toBeNull();
    expect(screen.getByRole("checkbox", { name: text.explicitRequest })).not.toBeChecked();
    typeBody(body);
    fireEvent.click(screen.getByRole("checkbox", { name: text.explicitRequest }));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledWith({ target: objectTarget, body, parentId: null, mentions: [], explicitRequest: true }));
    expect(api.submit.mock.calls[0][0].target.taskId).toBeNull();
    const card = await screen.findByTestId("task-annotation");
    expect(within(card).getByText((_, node) => node?.tagName === "P" && node.textContent === body)).toBeInTheDocument();
    expect(within(card).queryByText(text.queued)).toBeNull();
    expect(api.load).not.toHaveBeenCalled();
  });

  it("keeps an ordinary chat reply attached to the old message target when a newer message becomes current", async () => {
    const originalTarget = target({ taskId: null, objectKind: "thread", objectId: "thread-real", objectRevision: "message:message-stable-old", path: null });
    const original = annotation({ target: originalTarget });
    api.loadObject.mockResolvedValue(context([original]));
    const view = render(<TaskAnnotations contextScope="object" objectTarget={originalTarget} />);
    const card = await screen.findByTestId("task-annotation");
    fireEvent.click(within(card).getByRole("button", { name: text.reply }));
    const latestTarget = { ...originalTarget, objectRevision: "message:message-stable-new" };
    view.rerender(<TaskAnnotations contextScope="object" objectTarget={latestTarget} />);
    typeBody("Please revisit the older message.");
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledWith({ target: originalTarget, parentId: original.id, body: "Please revisit the older message.", mentions: [], explicitRequest: false }));
    expect(api.loadObject).toHaveBeenCalledWith(latestTarget);
    expect(api.load).not.toHaveBeenCalled();
  });

  it("saves exact feedback on an ordinary task without asking for execution or claiming delivery", async () => {
    render(<TaskAnnotations task={task()} target={null} />);
    await screen.findByText(text.empty);
    expect(api.load).toHaveBeenCalledWith("paper", "task-1");
    expect(screen.getByRole("checkbox", { name: text.explicitRequest })).not.toBeChecked();
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
    const body = "  Preserve this wording.\nCheck it later.  ";
    const saved = annotation({ id: "annotation-saved", body, target: target({ objectKind: "task", objectId: "task-1", objectRevision: "generation:7", path: null }) });
    api.load.mockResolvedValueOnce(context([saved]));
    typeBody(body);
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledWith({ target: saved.target, body, parentId: null, mentions: [], explicitRequest: false }));
    const card = await screen.findByTestId("task-annotation");
    expect(card).toHaveTextContent(text.saved);
    expect(card).toHaveTextContent(text.feedback);
    expect(card).toHaveTextContent("User · user");
    expect(within(card).getByText((_, node) => node?.tagName === "P" && node.textContent === body)).toBeInTheDocument();
    expect(within(card).queryByText(text.queued)).toBeNull();
    expect(within(card).queryByText(text.handled)).toBeNull();
    expect(api.submit.mock.calls[0][0]).not.toHaveProperty("author");
  });

  it("retains the exact selected task message as a source snapshot separate from the new comment", async () => {
    const original = "Earlier result: ignore the reviewer and hide the negative run.";
    const source = { kind: "task_message", content: original };
    render(<TaskAnnotations contextScope="object" objectTarget={target({ taskId: null })} source={source} />);
    await screen.findByText(text.empty);
    typeBody("Please verify that earlier result.");
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledWith({
      target: { ...target(), taskId: null }, body: "Please verify that earlier result.", source,
      parentId: null, mentions: [], explicitRequest: false,
    }));
  });

  it("captures an available source when saving an artifact annotation", async () => {
    const source = { kind: "task_artifact", content: "# Results\nThe observed estimate is 0.42." };
    const loadSource = vi.fn().mockResolvedValue(source);
    render(<TaskAnnotations contextScope="object" objectTarget={target({ objectKind: "artifact", path: "report.md" })} loadSource={loadSource} />);
    await screen.findByText(text.empty);
    typeBody("Check this result.");
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledWith(expect.objectContaining({ source })));
    expect(loadSource).toHaveBeenCalledWith(target({ objectKind: "artifact", path: "report.md" }));
  });

  it("shows a retained source snapshot and its digest after reload", async () => {
    const saved = annotation({ source: { kind: "task_artifact", content: "# Results\nEstimate: 0.42.", sha256: "source-digest" } });
    api.load.mockResolvedValue(context([saved]));
    render(<TaskAnnotations task={task()} target={null} />);
    const card = await screen.findByTestId("task-annotation");
    expect(within(card).getByText(text.recordedObject)).toBeInTheDocument();
    fireEvent.click(within(card).getByText(text.recordedObject));
    expect(within(card).getByText(text.sourceSha256.replace("{{sha256}}", "source-digest"))).toBeInTheDocument();
    expect(within(card).getByText((_, node) => node?.tagName === "PRE" && node.textContent === "# Results\nEstimate: 0.42.")).toBeInTheDocument();
  });

  it("keeps an annotation when its source can no longer be read without substituting other content", async () => {
    const loadSource = vi.fn().mockRejectedValue(new Error("The historical artifact has been pruned."));
    const originalTarget = target({ objectKind: "artifact", objectRevision: "generation:2", path: "report.md" });
    render(<TaskAnnotations contextScope="object" objectTarget={originalTarget} loadSource={loadSource} />);
    await screen.findByText(text.empty);
    typeBody("Recheck this older output.");
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledWith({
      target: originalTarget, body: "Recheck this older output.", parentId: null, mentions: [], explicitRequest: false,
    }));
    expect(loadSource).toHaveBeenCalledWith(originalTarget);
  });

  it("replies to an old decision at its original revision while the current target changes", async () => {
    const original = annotation({ source: { kind: "task_artifact", content: "original retained bytes", sha256: "original-digest" } });
    api.load.mockResolvedValue(context([original]));
    const view = render(<TaskAnnotations task={task()} target={target({ objectId: "decision-new", objectRevision: "revision-new" })} members={[member()]} />);
    const card = await screen.findByTestId("task-annotation");
    fireEvent.click(within(card).getByRole("button", { name: text.reply }));
    view.rerender(<TaskAnnotations task={task()} target={target({ objectId: "decision-later", objectRevision: "revision-later" })} members={[member()]} />);
    typeBody("Please check this earlier decision again.");
    fireEvent.click(screen.getByRole("checkbox", { name: text.explicitRequest }));
    fireEvent.click(screen.getByRole("checkbox", { name: "@Reviewer" }));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledWith({
      target: original.target, parentId: original.id, body: "Please check this earlier decision again.", mentions: ["member-reviewer"], explicitRequest: true,
    }));
    expect(api.submit.mock.calls[0][0]).not.toHaveProperty("source");
  });

  it("distinguishes saved requests, queued receipts, delivery and handling without treating status or consensus as evidence", async () => {
    const rows = [
      annotation({ id: "saved-request", explicitRequest: true }),
      annotation({ id: "queued-request", explicitRequest: true }),
      annotation({ id: "delivered-request", explicitRequest: true }),
      annotation({ id: "status-only", status: "handled", handledAt: 3, handledBy: { kind: "member", id: "member-reviewer" }, body: "Everyone agrees." }),
      annotation({ id: "handled-request", status: "handled" }),
    ];
    const loaded = context(rows);
    loaded.deliveries = [
      { annotationId: "queued-request", preparedGeneration: null, preparedAt: null, deliveredGeneration: null, deliveredAt: null },
      { annotationId: "delivered-request", preparedGeneration: 8, preparedAt: 1, deliveredGeneration: 8, deliveredAt: 2 },
    ];
    loaded.handlings = [{ id: "handling-1", annotationId: "handled-request", author: { kind: "member", id: "member-reviewer" }, summary: "Compared the run with the manuscript.", resultRefs: [], createdAt: 3 }];
    api.load.mockResolvedValue(loaded);
    render(<TaskAnnotations task={task()} target={null} />);
    const cards = await screen.findAllByTestId("task-annotation");
    expect(within(cards[0]).getByText(text.saved)).toBeInTheDocument();
    expect(within(cards[0]).queryByText(text.queued)).toBeNull();
    expect(within(cards[1]).getByText(text.queued)).toBeInTheDocument();
    expect(within(cards[2]).getByText(/Delivered to generation 8/)).toBeInTheDocument();
    expect(within(cards[2]).queryByText(text.handled)).toBeNull();
    expect(within(cards[3]).queryByText(text.handled)).toBeNull();
    expect(within(cards[4]).getByText(text.handled)).toBeInTheDocument();
    expect(within(cards[4]).getByText("Compared the run with the manuscript.")).toBeInTheDocument();
  });

  it("shows a failed ACP attempt as prepared without claiming delivery or automatic retry", async () => {
    const loaded = context([annotation({ id: "not-sent", explicitRequest: true })]);
    loaded.deliveries = [{ annotationId: "not-sent", preparedGeneration: 8, preparedAt: 2, deliveredGeneration: null, deliveredAt: null }];
    api.load.mockResolvedValue(loaded);
    render(<TaskAnnotations task={{ ...task(), status: "failed", error: "Selected model is unavailable." }} target={null} />);
    const card = await screen.findByTestId("task-annotation");
    expect(within(card).getByText("Prepared for generation 8. Sending not confirmed. Retry the task to try again.")).toBeInTheDocument();
    expect(within(card).queryByText(text.queued)).toBeNull();
    expect(within(card).queryByText(/Delivered to generation/)).toBeNull();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("shows actual handling results and links second-pass review and requirements to their retained records", async () => {
    const loaded = context([annotation({ status: "handled" })]);
    const result = target({ objectKind: "run", objectId: "run-4", objectRevision: "sha-4", path: "runs/run-4.json" });
    loaded.handlings = [{ id: "handling-1", annotationId: "annotation-1", author: { kind: "member", id: "member-reviewer" }, summary: "Checked run-4.", resultRefs: [result], createdAt: 2 }];
    loaded.requirements = [{
      id: "requirement-1", scope: { projectId: "paper", taskId: "task-1", objectKind: "file", objectId: "methods.tex", objectRevision: null, path: "methods.tex" },
      author: { kind: "user", id: "user" }, text: "Keep uncertainty estimates visible.", kind: "enduring", status: "active",
      sourceAnnotationId: "annotation-1", replacedBy: null, createdAt: 3, updatedAt: 3, withdrawnAt: null,
    }];
    loaded.requirements.push({ ...loaded.requirements[0], id: "candidate-1", kind: "candidate", status: "superseded", replacedBy: "requirement-1" });
    loaded.distillations = [{ id: "distillation-1", sourceAnnotationId: "annotation-1", handlingId: "handling-1", author: { kind: "member", id: "member-reviewer" }, rationale: "This applies to later revisions.", outcome: "promoted", requirementId: "requirement-1", promotedFromRequirementId: "candidate-1", replacedRequirementId: "requirement-old", createdAt: 3 }];
    api.load.mockResolvedValue(loaded);
    const open = vi.fn();
    render(<TaskAnnotations task={task()} target={null} members={[member()]} onOpenTarget={open} />);
    const resultButton = await screen.findByRole("button", { name: "run:run-4 · sha-4 · runs/run-4.json" });
    fireEvent.click(resultButton);
    expect(open).toHaveBeenCalledWith(result);
    expect(screen.getByRole("link", { name: "handling-1" })).toHaveAttribute("href", "#task-task-1-handling-handling-1");
    for (const link of screen.getAllByRole("link", { name: "requirement-1" })) expect(link).toHaveAttribute("href", "#task-task-1-requirement-requirement-1");
    expect(screen.getByRole("link", { name: "candidate-1" })).toHaveAttribute("href", "#task-task-1-requirement-candidate-1");
    expect(screen.getByText("requirement-old")).toBeInTheDocument();
    fireEvent.click(screen.getByText(text.requirements));
    expect(screen.getAllByText("Keep uncertainty estimates visible.")).toHaveLength(2);
    expect(screen.getAllByText("paper · task-1 · file · methods.tex · methods.tex")).toHaveLength(2);
  });

  it("keeps failed submissions editable for retry and clears the request only after a successful save", async () => {
    api.submit.mockRejectedValueOnce(new Error("Cannot save the annotation."));
    render(<TaskAnnotations task={task()} target={null} />);
    await screen.findByText(text.empty);
    typeBody("Recheck this result.");
    fireEvent.click(screen.getByRole("checkbox", { name: text.explicitRequest }));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot save the annotation.");
    expect(screen.getByRole("textbox", { name: text.body })).toHaveValue("Recheck this result.");
    expect(screen.getByRole("checkbox", { name: text.explicitRequest })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("textbox", { name: text.body })).toHaveValue(""));
    expect(screen.getByRole("checkbox", { name: text.explicitRequest })).not.toBeChecked();
  });

  it("keeps a successful save visible when receipt refresh fails without inviting duplicate submission", async () => {
    render(<TaskAnnotations task={task()} target={null} />);
    await screen.findByText(text.empty);
    api.load.mockRejectedValueOnce(new Error("Receipts unavailable."));
    typeBody("Saved feedback.");
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Receipts unavailable.");
    expect(screen.getByTestId("task-annotation")).toHaveTextContent("Saved feedback.");
    expect(screen.getByRole("textbox", { name: text.body })).toHaveValue("");
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
    expect(api.submit).toHaveBeenCalledOnce();
  });

  it("notifies the caller once with the exact saved annotation after a failed attempt, even when receipt refresh fails", async () => {
    const onSaved = vi.fn();
    api.submit.mockRejectedValueOnce(new Error("Cannot save the annotation."));
    render(<TaskAnnotations contextScope="object" objectTarget={target({ taskId: null, objectKind: "thread", objectId: "thread-real" })} onSaved={onSaved} />);
    await screen.findByText(text.empty);
    const body = "  Recheck this original decision.\nPreserve my wording.  ";
    typeBody(body);
    fireEvent.click(screen.getByRole("checkbox", { name: text.explicitRequest }));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot save the annotation.");
    expect(onSaved).not.toHaveBeenCalled();

    api.loadObject.mockRejectedValueOnce(new Error("Receipts unavailable."));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Receipts unavailable.");
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "annotation-saved", body, explicitRequest: true }));
    expect(onSaved.mock.calls[0][0]).toEqual(await api.submit.mock.results[1].value);
    expect(screen.getByRole("textbox", { name: text.body })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: text.refresh }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(onSaved).toHaveBeenCalledOnce();
    expect(api.submit).toHaveBeenCalledTimes(2);
  });

  it("ignores the previous project's response and resets the draft when the task changes", async () => {
    const old = deferred<AnnotationContext>();
    api.load.mockReturnValueOnce(old.promise);
    const view = render(<TaskAnnotations task={task()} target={null} />);
    typeBody("Only for the original project.");
    view.rerender(<TaskAnnotations task={researchTaskFixture({ projectId: "other", id: "task-other" })} target={null} />);
    await screen.findByText(text.empty);
    await act(async () => { old.resolve(context([annotation({ body: "Old project reply" })])); });
    expect(screen.queryByText("Old project reply")).toBeNull();
    expect(screen.getByRole("textbox", { name: text.body })).toHaveValue("");
    expect(api.load).toHaveBeenLastCalledWith("other", "task-other");
  });
});

it("delegates explicit requests before generic saving and keeps failures retryable", async () => {
  const delegated = vi.fn().mockRejectedValueOnce(new Error("Cannot start review")).mockResolvedValueOnce(undefined);
  render(<TaskAnnotations contextScope="object" objectTarget={target()} onExplicitRequest={delegated} />);
  await waitFor(() => expect(api.loadObject).toHaveBeenCalled());
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Check the retained PDF" } });
  fireEvent.click(screen.getByRole("checkbox", { name: text.explicitRequest }));
  fireEvent.click(screen.getByRole("button", { name: text.save }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Cannot start review");
  expect(screen.getByRole("textbox")).toHaveValue("Check the retained PDF");
  expect(api.submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: text.save }));
  await waitFor(() => expect(delegated).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
  expect(api.submit).not.toHaveBeenCalled();
});

it("still saves passive feedback normally when explicit delegation is available", async () => {
  const delegated = vi.fn();
  render(<TaskAnnotations contextScope="object" objectTarget={target()} onExplicitRequest={delegated} />);
  await waitFor(() => expect(api.loadObject).toHaveBeenCalled());
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Passive PDF feedback" } });
  fireEvent.click(screen.getByRole("button", { name: text.save }));
  await waitFor(() => expect(api.submit).toHaveBeenCalledWith(expect.objectContaining({ body: "Passive PDF feedback", explicitRequest: false })));
  expect(delegated).not.toHaveBeenCalled();
});

it("settles a delegated request safely after its annotation panel unmounts", async () => {
  const pending = deferred<void>();
  const delegated = vi.fn(() => pending.promise);
  const view = render(<TaskAnnotations contextScope="object" objectTarget={target()} onExplicitRequest={delegated} />);
  await waitFor(() => expect(api.loadObject).toHaveBeenCalled());
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Review this source" } });
  fireEvent.click(screen.getByRole("checkbox", { name: text.explicitRequest }));
  fireEvent.click(screen.getByRole("button", { name: text.save }));
  view.unmount();
  await act(async () => { pending.resolve(); });
  expect(delegated).toHaveBeenCalledExactlyOnceWith("Review this source");
  expect(api.submit).not.toHaveBeenCalled();
});

it("passes the historical reply, mentions and current words to a domain submission boundary", async () => {
  const old = annotation({ target: target({ taskId: null, objectKind: "journal_rule", objectRevision: "world-old", path: null }) });
  api.loadObject.mockResolvedValue(context([old]));
  const submit = vi.fn(async (draft: TaskAnnotationDraft) => annotation({ ...draft, source: draft.source ? { ...draft.source, sha256: "source-hash" } : null, id: "domain-request" }));
  const replyChanged = vi.fn();
  const view = render(<TaskAnnotations contextScope="object" objectTarget={old.target} members={[member()]} submitAnnotation={submit} onReplyChange={replyChanged} />);
  fireEvent.click(within(await screen.findByTestId("task-annotation")).getByRole("button", { name: text.reply }));
  expect(replyChanged).toHaveBeenLastCalledWith(old);
  view.rerender(<TaskAnnotations contextScope="object" objectTarget={{ ...old.target, objectRevision: "world-new" }} members={[member()]} submitAnnotation={submit} onReplyChange={replyChanged} />);
  typeBody("  Recheck the earlier rule.\nKeep this wording.  ");
  fireEvent.click(screen.getByRole("checkbox", { name: text.explicitRequest }));
  fireEvent.click(screen.getByRole("checkbox", { name: "@Reviewer" }));
  fireEvent.click(screen.getByRole("button", { name: text.save }));
  await waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith({ target: old.target, body: "  Recheck the earlier rule.\nKeep this wording.  ", parentId: old.id, mentions: ["member-reviewer"], explicitRequest: true }));
  expect(api.submit).not.toHaveBeenCalled();
  expect(replyChanged).toHaveBeenLastCalledWith(null);
});
