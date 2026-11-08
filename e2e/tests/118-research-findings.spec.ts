import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FindingPage, ResearchTask } from "../../src/lib/research-tasks";
import { expect, reloadNativePage, test } from "../fixtures";
import { fillTextarea, openRailTab, type Page } from "../helpers";
import { startMockAiServer, type MockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const original = "# Synthetic numeric review\n\nThis fixture has no study data.\n";
const proposed = "# Synthetic numeric review\n\nLoss 0.70 <!-- run: r009 -->\n";
const revised = "# Synthetic numeric review\n\nLoss 0.80 <!-- run: r009 -->\n";
function findings(page: Page, task: ResearchTask) {
  return page.evaluate<FindingPage>(`import("/src/lib/research-tasks.ts").then(m => m.loadResearchTaskFindings(${scriptValue(task.id)}, ${task.executionGeneration}))`);
}

test("numeric findings retain source, decisions and dependency validity through native IPC", async ({ tauriPage }) => {
  test.skip(process.env.OLEAFLY_FINDINGS_SMOKE !== "1", "Requires an explicitly isolated test library and native app.");
  test.setTimeout(300_000);
  const library = process.env.OLEAFLY_DATA_DIR;
  if (!library) throw new Error("An isolated OLEAFLY_DATA_DIR is required");
  const output = process.env.OLEAFLY_FINDINGS_EVIDENCE_DIR ?? join(library, "findings-evidence");
  mkdirSync(output, {recursive:true});
  const recovery = process.env.OLEAFLY_FINDINGS_RESUME === "1";
  const resume = process.env.OLEAFLY_FINDINGS_RESUME ? JSON.parse(readFileSync(join(output,"identity.json"),"utf8")) as {projectId:string;taskId:string;originalSha256:string} : null;
  let server: MockAiServer | null = null;
  try {
    if (!resume) {
      server = await startMockAiServer();
      server.setToolCall({name:"write_file",args:{path:"main.md",content:proposed},then:"The synthetic numeric result is ready for review."});
      expect(await tauriPage.evaluate(`window.__aiConnect("ollama", ${scriptValue(server.url)}, "llama3.2")`)).toBe(true);
      expect(await tauriPage.evaluate(`window.__researchTasksSet(true)`)).toBe(true);
    }
    await tauriPage.evaluate(`import("/src/lib/tauri.ts").then(async m=>m.setConfig({...await m.getConfig(),ui_locale:"en"}))`);
    await reloadNativePage(tauriPage);
    const projectId = resume?.projectId ?? await tauriPage.evaluate<string>(`import("/src/lib/tauri.ts").then(m=>m.createMarkdownProject("Findings smoke " + Date.now()))`);
    const project = join(library,"projects",projectId);
    if (!resume) writeFileSync(join(project,"main.md"), original);
    await tauriPage.evaluate(`import("/src/store/files.ts").then(m=>m.useFilesStore.getState().openProject(${scriptValue(projectId)}))`);
    let task = resume ? await tauriPage.evaluate<ResearchTask>(`import("/src/lib/research-tasks.ts").then(async m=>(await m.listResearchTasks(${scriptValue(projectId)})).find(t=>t.id===${scriptValue(resume.taskId)}))`) : await tauriPage.evaluate<ResearchTask>(`(async()=>{
      const m = await import("/src/lib/research-tasks.ts");
      const brief=m.defaultBrief("Exercise the numeric finding feedback contract");
      brief.permissions={network:false,commands:"off",desktopApps:false};
      brief.budget.wallClockMinutes=5;
      const task=await m.createResearchTask({projectId:${scriptValue(projectId)},title:"Synthetic finding feedback",prompt:"Write the requested synthetic main.md and finish.",runtimeId:"builtin",agentId:"ollama",modelId:"llama3.2",skillIds:[],dependencyIds:[],brief});
      await m.startResearchTask(task.id); return task;
    })()`);
    await expect.poll(async()=>{
      task = await tauriPage.evaluate<ResearchTask>(`import("/src/lib/research-tasks.ts").then(async m=>(await m.listResearchTasks(${scriptValue(projectId)})).find(t=>t.id===${scriptValue(task.id)}))`);
      return task.evidence ? `${task.status}:${task.phase}` : "evidence pending";
    }, {timeout:180_000}).toBe("awaiting_review:null");
    if (!task.isolation) throw new Error("The synthetic task has no isolated workspace");
    writeFileSync(join(output,"task-final.json"),JSON.stringify(task,null,2));
    writeFileSync(join(output,"identity.json"),JSON.stringify({projectId,taskId:task.id,originalSha256:hash(original)},null,2));
    await openRailTab(tauriPage,"Research workspace");
    await tauriPage.evaluate(`import("/src/store/research-tasks.ts").then(m=>m.useResearchTasksStore.getState().openTaskDetail(${scriptValue(task.id)},"review"))`);
    const section=tauriPage.getByTestId("task-findings");
    await expect(section).toContainText("A model reviewer has not run.");
    if (!recovery) {
      await expect.poll(async()=>(await findings(tauriPage,task)).findings.length).toBe(1);
      const initial = await findings(tauriPage,task);
      writeFileSync(join(output,"initial-findings.json"),JSON.stringify(initial,null,2));
      expect(initial.findings.length).toBe(1);
      expect(initial.findings[0].finding.item.code).toBe("numbers.unknownRun");
      expect(initial.findings[0].validity).toBe("current");
      const id=initial.findings[0].finding.id;
      let card=section.locator(`[data-finding-id="${id}"]`);
      await expect(card).toContainText("Dependencies current");
      for (const [button,reason,disposition] of [["Accept finding","The cited run is missing","accepted"],["Reject finding","This may be an intentional example","rejected"],["Defer finding","Ask the author to confirm","deferred"]] as const) {
        await fillTextarea(tauriPage, `[data-finding-id="${id}"] textarea`, reason);
        await card.getByText(button,{exact:true}).click();
        await expect.poll(async()=>(await findings(tauriPage,task)).findings[0].disposition).toBe(disposition);
        await expect(card.locator("textarea")).toHaveValue("");
      }
      const decisions=await findings(tauriPage,task);
      expect(decisions.findings[0].history.map(h=>h.disposition)).toEqual(["accepted","rejected","deferred"]);
      writeFileSync(join(output,"decisions.json"),JSON.stringify(decisions,null,2));
      writeFileSync(join(task.isolation.executionRoot,"unrelated.md"),"Unrelated synthetic note\n");
      expect((await findings(tauriPage,task)).findings[0].validity).toBe("current");
      writeFileSync(join(task.isolation.executionRoot,"main.md"),revised);
      await section.getByText("Refresh findings and validity",{exact:true}).click();
      await expect(card).toContainText("Stale — cited dependencies changed");
      await card.getByText("Read retained quote",{exact:true}).click();
      await expect(card.getByTestId("finding-source")).toContainText("Loss 0.70");
      expect((await findings(tauriPage,task)).findings[0].changedDependencies.map(d=>d.dependency)).toEqual(["main.md"]);
      await tauriPage.evaluate(`import("/src/lib/research-tasks.ts").then(m=>m.refreshResearchTaskEvidence(${scriptValue(task.id)}))`);
      const rechecked=await findings(tauriPage,task);
      expect(rechecked.findings.length).toBe(2);
      expect(rechecked.findings.map(f=>f.validity)).toEqual(["stale","current"]);
      expect(rechecked.findings[0].disposition).toBe("deferred");
      expect(rechecked.findings[1].disposition).toBe("open");
      await section.getByText("Refresh findings and validity",{exact:true}).click();
      await expect(section.locator('[data-testid="task-finding"]')).toHaveCount(2);
      card=section.locator(`[data-finding-id="${id}"]`);
      await card.getByText("Read retained quote",{exact:true}).click();
      await expect(card.getByTestId("finding-source")).toContainText("Loss 0.70");
      await tauriPage.screenshot({path:join(output,"native-findings.png")});
      writeFileSync(join(output,"final-findings.json"),JSON.stringify(rechecked,null,2));
    } else {
      const retained=JSON.parse(readFileSync(join(output,"final-findings.json"),"utf8")) as FindingPage;
      expect(await findings(tauriPage,task)).toEqual(retained);
      await expect(section.locator('[data-testid="task-finding"]')).toHaveCount(2);
      writeFileSync(join(output,"process-recovery.json"),JSON.stringify({sameFindings:true,sameDecisions:true,taskId:task.id,generation:task.executionGeneration},null,2));
    }
    const before=await findings(tauriPage,task);
    await reloadNativePage(tauriPage);
    expect(await findings(tauriPage,task)).toEqual(before);
    expect(hash(readFileSync(join(project,"main.md"),"utf8"))).toBe(hash(original));
    writeFileSync(join(output,recovery?"recovery-verification.json":"verification.json"),JSON.stringify({taskId:task.id,projectId,generation:task.executionGeneration,mockedProvider:true,modelReviewerRan:false,originalSha256:hash(original),webviewReloadMatches:true,findings:before.findings.length,dispositions:before.findings[0].history.map(h=>h.disposition),oldValidity:before.findings[0].validity,newValidity:before.findings[1].validity},null,2));
  } finally { await server?.close(); }
});
