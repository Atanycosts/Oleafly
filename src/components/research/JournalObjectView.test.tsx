// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { JournalAnnotationObject } from "@/lib/journal-workbench";
import { JournalObjectView } from "./JournalObjectView";

it("shows a retained template requirement as readable formatting and source text", () => {
  const object: JournalAnnotationObject = {
    reference: { libraryRoot: "/private/library", workbenchProjectId: "manuscript-secret", kind: "rule", objectId: "rule-secret", worldVersionId: "world-secret", checkId: null },
    target: { projectId: "app", taskId: null, objectKind: "journal_rule", objectId: "rule-secret", objectRevision: "world-secret", path: null },
    source: { kind: "journal_object", content: JSON.stringify({ object: { property: "object_format", expected: { role: "document_title", kind: "paragraph" }, unit: "effective_format", evidence: [{ source_id: "source-secret", locator: "word/document.xml#0.1", quote: "The title uses the template style." }] } }) },
    relatedTasks: [], continuationTaskId: null,
  };
  const view = render(<JournalObjectView object={object} />);
  expect(screen.getByRole("heading", { name: "Document title" })).toBeInTheDocument();
  expect(screen.getByText("Effective formatting")).toBeInTheDocument();
  expect(screen.getByText("The title uses the template style.")).toBeInTheDocument();
  expect(view.container.textContent).not.toMatch(/document_title|paragraph|word\/document.xml|secret|libraryRoot/);
});

it("reads an immutable check without the current world projection", () => {
  const object: JournalAnnotationObject = {
    reference: { libraryRoot: "/private/library", workbenchProjectId: "manuscript-secret", kind: "check", objectId: "check-secret", worldVersionId: "world-secret", checkId: "check-secret" },
    target: { projectId: "app", taskId: null, objectKind: "journal_check", objectId: "check-secret", objectRevision: "check-secret", path: null },
    source: { kind: "journal_object", content: JSON.stringify({ object: { created_at: "2026-11-15T01:00:00Z", summary: { observed_difference: 20, cannot_determine: 14 } } }) },
    relatedTasks: [], continuationTaskId: null,
  };
  const view = render(<JournalObjectView object={object} />);
  expect(screen.getByRole("heading", { name: "Check results" })).toBeInTheDocument();
  expect(screen.getByText("Candidate difference")).toBeInTheDocument();
  expect(screen.getByText("20")).toBeInTheDocument();
  expect(screen.getByText("Cannot determine")).toBeInTheDocument();
  expect(view.container.textContent).not.toContain("secret");
});
