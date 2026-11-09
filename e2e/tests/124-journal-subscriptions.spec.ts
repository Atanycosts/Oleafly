import { strToU8, zipSync } from "fflate";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import type { GroupSnapshot } from "../../src/lib/task-collaboration";
import type { JournalAnnotationRequest, JournalObjectReference } from "../../src/lib/journal-workbench";
import { test, expect } from "../fixtures";
import { createBlankProject } from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";

function decodeToolResult(content: string) {
  const result = JSON.parse(content);
  if (Array.isArray(result.content) && typeof result.isError === "boolean") {
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    return JSON.parse(result.content[0].text);
  }
  return result;
}

// Scripted provider; real Workbench, member scheduler, subscriptions and 15s poll.
// Independent fixture: never consumes another spec's artifacts or task IDs.
test("external journal revision wakes only the subscribed idle member and deduplicates polling", async ({ tauriPage: page }, testInfo) => {
  test.skip(!process.env.OLEAFLY_WORKBENCH_PYTHON, "Requires an installed Workbench Python environment.");
  test.setTimeout(240_000);
  const server = await startMockAiServer();
  try {
    if (await page.evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`)) await page.press("body", "Escape");
    if (await page.evaluate<boolean>(`!!document.querySelector('[title="Back to library"]')`)) await page.click('[title="Back to library"]');
    await createBlankProject(page, `Journal subscriptions ${Date.now()}`);
    expect(await page.evaluate(`window.__aiConnect?.("ollama", ${scriptValue(server.url)}, "llama3.2") ?? false`)).toBe(true);
    await page.evaluate(`window.__researchTasksSet?.(true)`);
    const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`);
    const docx = Buffer.from(zipSync({
      "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      "_rels/.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>REAL-DOCX-JOURNAL-CONTENT</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/><w:cols w:num="1"/></w:sectPr></w:body></w:document>'),
    }));
    const fixture = await page.evaluate<{ reference: JournalObjectReference; requested: JournalAnnotationRequest }>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(async j=>{
      const connection=await j.connectJournalWorkbench();
      const manuscript=await j.journalRequest('/api/projects',{name:'Subscription manuscript',filename:'manuscript.docx',content_base64:${scriptValue(docx.toString("base64"))}});
      const world=await j.journalRequest('/api/worlds',{journal_id:${scriptValue(`poll-${projectId}`)},journal_name:'Subscription journal',article_type:'research_article',stage:'initial_submission',language:'en',sources:[{name:'guide.txt',kind:'guide_text',content_base64:${scriptValue(Buffer.from("All manuscript pages must use A4 paper.").toString("base64"))}}]});
      await j.linkJournalProject(${scriptValue(projectId)},manuscript.project_id);
      await j.journalRequest('/api/bind',{project_id:manuscript.project_id,world_version_id:world.version_id,expected_binding_id:null});
      const check=await j.journalRequest('/api/check',{project_id:manuscript.project_id});
      const reference={libraryRoot:connection.libraryRoot,workbenchProjectId:manuscript.project_id,kind:'rule',objectId:world.rules.find(r=>r.property==='page_width_twips').rule_id,worldVersionId:world.version_id,checkId:check.check_id};
      const root=await j.saveJournalAnnotation(${scriptValue(projectId)},reference,'Monitor this retained rule.',null);
      const selected=await window.__oleaflyE2EImport('/src/lib/assistant-delegation-capture.ts').then(m=>m.captureAssistantTarget(${scriptValue(projectId)}));
      const requested=await j.requestJournalAnnotation({projectId:${scriptValue(projectId)},reference,body:'Coordinate bounded journal monitoring.',parentId:root.id,mentions:[],taskId:null,draft:{projectId:${scriptValue(projectId)},title:'Journal poll subscription',prompt:'Coordinate bounded journal monitoring.',...selected,skillIds:[],dependencyIds:[]}});
      return {reference,requested};
    })`);
    expect(fixture.requested.task.startRequested).toBe(false);
    const taskId = fixture.requested.task.id;
    const members = [
      { name: "Coordinator", responsibility: "Delegate once to Reviewer", coordinator: true },
      { name: "Reviewer", responsibility: "Read retained journal rule and await updates", coordinator: false },
      { name: "Explorer", responsibility: "Unrelated work; do not subscribe to journals", coordinator: false },
    ].map(member=>({ ...member, runtimeId: "builtin", agentId: "ollama", modelId: "llama3.2", skillIds: [] }));
    const group = await page.evaluate<GroupSnapshot>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m=>m.createTaskGroup(${scriptValue(projectId)},${scriptValue(taskId)},${scriptValue(members)}))`);
    const reviewer = group.members.find(m=>m.name==="Reviewer")!;
    const coordinator = group.members.find(m=>m.coordinator)!;
    const explorer = group.members.find(m=>m.name==="Explorer")!;
    const faultPrefix = process.env.OLEAFLY_E2E_WORKBENCH_SYNC_FAULT;
    let externallyRevised = false;
    let memberCheckResult: ReturnType<typeof decodeToolResult> | undefined;
    const observedTurns: { phase: string; member: string; prompt: string }[] = [];
    server.setResponder(body=>{
      const messages = body.messages as { role: string; content: unknown }[];
      const lastUser=messages.reduce((last,m,index)=>m.role==="user"?index:last,-1);
      const prompt = String(messages[lastUser]?.content ?? "");
      const results = messages.slice(lastUser+1).filter(m=>m.role==="tool" && typeof m.content==="string").map(m=>decodeToolResult(m.content as string));
      const member = prompt.includes("You are Reviewer. Responsibility:") ? "Reviewer" : prompt.includes("You are Coordinator. Responsibility:") ? "Coordinator" : "Explorer";
      if (!results.length) observedTurns.push({phase:externallyRevised?"external":"initial",member,prompt});
      if (member === "Coordinator") {
        if (results.length===0) return {name:"discover_tools",args:{query:"group_message"}};
        if (results.length===1) return {name:"group_message",args:{body:"Read journal_context and the historical rule, run journal_check once, then wait for external changes.",recipients:[reviewer.id],requestWork:true}};
        return "Delegated the bounded journal read. No journal subscription requested.";
      }
      if (member === "Reviewer") {
        if (results.length===0) return {name:"discover_tools",args:{query:"journal_"}};
        if (results.length===1) return {name:"journal_context",args:{}};
        if (!externallyRevised && results.length===2) return {name:"journal_read",args:{operation:"object",kind:"rule",object_id:fixture.reference.objectId,world_version_id:fixture.reference.worldVersionId}};
        if (!externallyRevised && results.length===3) {
          if (faultPrefix) writeFileSync(faultPrefix+".arm", "armed");
          return {name:"journal_check",args:{}};
        }
        if (!externallyRevised && results.length===4) memberCheckResult=results[3];
        return externallyRevised ? "Observed the external revision; old binding remains. No check or message emitted." : "Read journal context and retained rule, committed one real check; waiting for relevant updates.";
      }
      return "Unrelated member finished without journal subscriptions.";
    });
    const snapshot = () => page.evaluate<GroupSnapshot>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m=>m.loadTaskGroup(${scriptValue(projectId)},${scriptValue(taskId)}))`);
    // Request coordinator work, rather than starting an unrelated task generation.
    await page.evaluate(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m=>m.sendGroupMessage(${scriptValue(projectId)},${scriptValue(group.group.id)},{body:'Delegate the journal read to Reviewer once.',recipients:[${scriptValue(coordinator.id)}],replyTo:null,object:null,requestWork:true}))`);
    let idle = group;
    await expect.poll(async()=>{
      idle=await snapshot();
      return idle.work.some(w=>w.memberId===reviewer.id && w.status==="completed") && idle.work.every(w=>w.status==="completed");
    },{timeout:90_000,intervals:[500]}).toBe(true);
    expect(idle.interests.filter(i=>i.memberId===reviewer.id).map(i=>i.value)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^journal_project:/), expect.stringContaining("journal_rule:"),
    ]));
    expect(idle.interests.filter(i=>i.memberId!==reviewer.id && i.value.startsWith("journal_"))).toHaveLength(0);
    expect(memberCheckResult?.check.check_id).toBeTruthy();
    expect(memberCheckResult?.check.check_id).not.toBe(fixture.reference.checkId);
    expect(memberCheckResult?.check.world_version_id).toBe(fixture.reference.worldVersionId);
    expect(memberCheckResult?.synchronization.status).toBe(faultPrefix ? "pending" : "synchronized");
    if (faultPrefix) expect(memberCheckResult?.synchronization.error).toContain("Injected journal sync failure");
    expect(idle.executions.filter(e=>e.memberId===reviewer.id)).toHaveLength(1);
    const beforeExternalWorkIds=idle.work.map(w=>w.id).sort();
    // Two poll periods exercise the plain rescan after the member's successful check.
    // Optional isolated Python wrapper injects one history failure after the real POST.
    const originDeadline=Date.now()+32_000;
    while(Date.now()<originDeadline) {
      await new Promise(resolve=>setTimeout(resolve,1000));
      const polled=await snapshot();
      expect(polled.work.map(w=>w.id).sort()).toEqual(beforeExternalWorkIds);
      expect(polled.executions.filter(e=>e.memberId===reviewer.id)).toHaveLength(1);
    }
    idle=await snapshot();
    const initialExecutions=idle.executions.map(e=>e.id);
    externallyRevised=true;
    // Direct service mutation bypasses Oleafly's command-triggered reconcile/kick.
    const revised=JSON.parse(execFileSync(process.env.OLEAFLY_WORKBENCH_PYTHON!, ["-c", [
      "import json,sys", "from pathlib import Path",
      "from research_file_workbench.workbench.service import WorkbenchService",
      "s=WorkbenchService(Path(sys.argv[1]))",
      "print(json.dumps(s.revise(sys.argv[2],sys.argv[3],12240,'External subscription poll acceptance')))" ,
    ].join("\n"), fixture.reference.libraryRoot, fixture.reference.worldVersionId, fixture.reference.objectId],{encoding:"utf8",timeout:30_000}));
    expect(revised.version_id).not.toBe(fixture.reference.worldVersionId);
    // Snapshot reads do not call journal_context or kick/reconcile Workbench.
    let delivered=idle;
    await expect.poll(async()=>{
      delivered=await snapshot();
      return delivered.work.some(w=>w.memberId===reviewer.id && w.causeKind==="event" && w.status==="completed") && delivered.work.every(w=>w.status==="completed");
    },{timeout:60_000,intervals:[1000]}).toBe(true);
    const newExecutions=delivered.executions.filter(e=>!initialExecutions.includes(e.id));
    expect(newExecutions.length).toBeGreaterThan(0);
    expect(newExecutions.every(e=>e.memberId===reviewer.id)).toBe(true);
    expect(delivered.executions.filter(e=>e.memberId===coordinator.id).map(e=>e.id)).toEqual(idle.executions.filter(e=>e.memberId===coordinator.id).map(e=>e.id));
    expect(delivered.executions.filter(e=>e.memberId===explorer.id)).toHaveLength(0);
    const eventPrompts=observedTurns.filter(t=>t.phase==="external");
    expect(eventPrompts.every(t=>t.member==="Reviewer")).toBe(true);
    expect(eventPrompts.some(t=>t.prompt.includes("workbench_update_available") && t.prompt.includes("journal_rule"))).toBe(true);
    const workIds=delivered.work.map(w=>w.id).sort();
    // Allow two complete poll periods, asserting stable work identities throughout.
    const dedupDeadline=Date.now()+32_000;
    while(Date.now()<dedupDeadline) {
      await new Promise(resolve=>setTimeout(resolve,1000));
      expect((await snapshot()).work.map(w=>w.id).sort()).toEqual(workIds);
    }
    const final=await snapshot();
    const business=await page.evaluate<{binding:{world_version_id:string};check:{validity:string;update_available:boolean};history:{checks:{check_id:string}[]}}>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(async j=>{
      const state=await j.journalRequest('/api/state');const p=state.projects.find(p=>p.project_id===${scriptValue(fixture.reference.workbenchProjectId)});
      return {binding:p.binding,check:await j.journalRequest('/api/check?check_id='+p.latest_check.check_id),history:await j.journalRequest('/api/history?project_id='+p.project_id)};
    })`);
    expect(business.binding.world_version_id).toBe(fixture.reference.worldVersionId);
    expect(business.check.validity).toBe("CURRENT");
    expect(business.check.update_available).toBe(true);
    expect(business.history.checks).toHaveLength(2);
    expect(business.history.checks.map((check: { check_id: string })=>check.check_id).sort()).toEqual([fixture.reference.checkId,memberCheckResult.check.check_id].sort());
    const faultMarker = faultPrefix ? JSON.parse(readFileSync(faultPrefix+".fired.json", "utf8")) : null;
    if (faultMarker) expect(faultMarker.checkId).toBe(memberCheckResult.check.check_id);
    writeFileSync(testInfo.outputPath("checks.json"),JSON.stringify({mode:"scripted-provider-native-workbench-poll",realModelReasoning:false,projectId,taskId,reference:fixture.reference,revisedWorldVersionId:revised.version_id,initial:idle,memberCheckId:memberCheckResult.check.check_id,memberCheckResult,initialReviewerExecutionCount:1,originPollObservationMs:32_000,syncFailureInjected:Boolean(faultPrefix),faultMarker,delivered,final,observedTurns,business,dedupObservationMs:32_000,externalMutation:"WorkbenchService.revise via Python; no Oleafly IPC kick"},null,2));
  } finally { await server.close(); }
});
