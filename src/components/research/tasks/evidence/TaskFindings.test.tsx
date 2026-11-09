// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FindingPage, FindingView } from "@/lib/research-tasks";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import { TaskFindings } from "./TaskFindings";

const mocks = vi.hoisted(() => ({ load: vi.fn(), decide: vi.fn(), source: vi.fn() }));
vi.mock("@/lib/research-tasks", () => ({
  loadResearchTaskFindings: mocks.load, decideResearchTaskFinding: mocks.decide,
  previewResearchTaskFindingSource: mocks.source,
}));

function row(id = "finding-1"): FindingView {
  return {
    sequence: 1, finding: { id,taskId: "task-1",executionGeneration: 1,origin: "deterministic",verdict: "warning",severity: "warning",createdAt: 1,
      item: { code: "numbers.mismatch", file: "main.md", line: 3, params: {value:"0.70",run:"r001",recorded:"loss=0.5"},
        provenance: { ruleVersion: "numbers-1",runId:"r001",runSha256:"run-hash",ledgerContainsRun:true,
          source: {path:"main.md",fileSha256:"file-hash",lineStart:3,lineEnd:3,quote:"Loss 0.70 <!-- run: r001 -->",quoteSha256:"quote-hash"} },
      },
    }, validity: "current",changedDependencies:[],unavailable:[],disposition:"open",history:[],historyCount:0,
  };
}
function page(rows = [row()], more = false): FindingPage {
  return {taskId:"task-1",executionGeneration:1,findings:rows,nextSequence:rows.at(-1)?.sequence ?? 0,hasMore:more,coverageGaps:[]};
}

beforeEach(() => {
  mocks.load.mockReset().mockResolvedValue(page());
  mocks.decide.mockReset().mockResolvedValue(undefined);
  mocks.source.mockReset().mockResolvedValue(row().finding.item.provenance?.source);
});

describe("TaskFindings", () => {
  it("requires a reason and preserves warning and stale validity after an accepted decision", async () => {
    render(<TaskFindings taskId="task-1" generation={1} revision={1} />);
    const card = await screen.findByTestId("task-finding");
    expect(card).toHaveTextContent("0.70 doesn't match run r001");
    expect(card).toHaveTextContent(en.findings.recordedWarning);
    expect(screen.getByRole("button", { name: en.findings.accept })).toBeDisabled();
    const accepted = row();
    accepted.validity="stale"; accepted.disposition="accepted";
    accepted.changedDependencies=[{dependency:"main.md",expected:"file-hash",actual:"new-hash"}];
    accepted.history=[{sequence:9,disposition:"accepted",rationale:"Please correct this number",actor:"operator",source:"task_detail",createdAt:2}];
    accepted.historyCount=1;
    mocks.load.mockResolvedValueOnce(page([accepted]));
    fireEvent.change(screen.getByRole("textbox", { name: en.findings.reason }), {target:{value:" Please correct this number "}});
    fireEvent.click(screen.getByRole("button", { name: en.findings.accept }));
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith("task-1",1,"finding-1","accepted","Please correct this number"));
    const next = await screen.findByTestId("task-finding");
    await waitFor(() => expect(next).toHaveTextContent(en.findings.stale));
    expect(next).toHaveTextContent(en.findings.accepted);
    expect(next).toHaveTextContent(en.findings.recordedWarning);
    expect(next).toHaveTextContent("Please correct this number");
    expect(next).toHaveTextContent("file-hash → new-hash");
  });

  it("retrieves the retained quote using only its finding identity", async () => {
    render(<TaskFindings taskId="task-1" generation={1} revision={1} />);
    fireEvent.click(await screen.findByRole("button", {name:en.findings.source}));
    const source = await screen.findByTestId("finding-source");
    expect(mocks.source).toHaveBeenCalledWith("task-1",1,"finding-1");
    expect(source).toHaveTextContent("Loss 0.70");
    expect(source).toHaveTextContent("file-hash");
    expect(source).toHaveTextContent("quote-hash");
    expect(source).toHaveTextContent(en.findings.retainedQuote);
  });

  it("retains a failed decision's reason so the operator can retry", async () => {
    mocks.decide.mockRejectedValueOnce(new Error("Disk write failed"));
    render(<TaskFindings taskId="task-1" generation={1} revision={1} />);
    await screen.findByTestId("task-finding");
    const reason = screen.getByRole("textbox", {name:en.findings.reason});
    fireEvent.change(reason,{target:{value:"Ask the author"}});
    fireEvent.click(screen.getByRole("button", {name:en.findings.defer}));
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk write failed");
    expect(reason).toHaveValue("Ask the author");
    fireEvent.click(screen.getByRole("button", {name:en.findings.defer}));
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledTimes(2));
  });

  it("appends bounded pages and replaces their validity on refresh", async () => {
    const second = row("finding-2"); second.sequence=2;
    mocks.load.mockResolvedValueOnce(page([row()],true)).mockResolvedValueOnce(page([second]));
    render(<TaskFindings taskId="task-1" generation={1} revision={1} />);
    fireEvent.click(await screen.findByRole("button", {name:en.findings.more}));
    await waitFor(() => expect(screen.getAllByTestId("task-finding")).toHaveLength(2));
    expect(mocks.load).toHaveBeenNthCalledWith(2,"task-1",1,1);
    mocks.load.mockResolvedValueOnce(page([{...row(),validity:"unknown",unavailable:["The workspace is unavailable"]}]));
    fireEvent.click(screen.getByRole("button", {name:en.findings.refresh}));
    await waitFor(() => expect(screen.getAllByTestId("task-finding")).toHaveLength(1));
    expect(screen.getByTestId("task-finding")).toHaveTextContent(en.findings.unknown);
    expect(screen.getByTestId("task-findings")).toHaveTextContent(en.findings.scope);
  });

  it("ignores a superseded response from a different task generation", async () => {
    let finish!: (value:FindingPage) => void;
    mocks.load.mockReturnValueOnce(new Promise<FindingPage>((resolve) => {finish=resolve;}));
    const view = render(<TaskFindings taskId="task-1" generation={1} revision={1} />);
    mocks.load.mockResolvedValueOnce(page([]));
    view.rerender(<TaskFindings taskId="task-1" generation={2} revision={2} />);
    await screen.findByText(en.findings.empty);
    await act(async () => { finish(page()); });
    expect(screen.queryByTestId("task-finding")).toBeNull();
  });

  it("shows omitted source items and shortened history explicitly", async () => {
    const retained = row(); retained.historyCount=23;
    retained.history=[{sequence:23,disposition:"deferred",rationale:"Later",actor:"operator",source:"task_detail",createdAt:2}];
    mocks.load.mockResolvedValueOnce({...page([retained]),coverageGaps:["findings.numeric_items_without_source","findings.history_shortened"]});
    render(<TaskFindings taskId="task-1" generation={1} revision={1} />);
    const card = await screen.findByTestId("task-finding");
    expect(screen.getByTestId("task-findings")).toHaveTextContent(en.findings.unretained);
    expect(within(card).getByText(en.findings.historyShortened.replace("{{count}}", "1"))).toBeInTheDocument();
  });
});
