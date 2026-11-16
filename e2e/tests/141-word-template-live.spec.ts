import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { DocxDocumentRead } from "../../packages/ai-tools/src/tools";
import type { DocxActivityPage } from "../../src/lib/docx-task-activity";
import type { JournalProject, JournalState, JournalWorld, JournalCheck } from "../../src/lib/journal-workbench";
import type { ResearchTask, TaskTranscriptPage, TaskTranscriptEvent } from "../../src/lib/research-tasks";
import { test, expect } from "../fixtures";
import { createBlankProject, openRailTab, waitLong, type Page } from "../helpers";
import { scriptValue } from "../script-value";

const enabled = process.env.OLEAFLY_WORD_TEMPLATE_LIVE === "1";
const relay = process.env.OLEAFLY_DOCX_LIVE_URL;
const run = process.env.OLEAFLY_DOCX_LIVE_RUN ?? process.env.OLEAFLY_DOCX_RECOVERY_RUN;
const PROVIDER = "word-template-live";
const MODEL = "gpt/gpt-6.1-sol";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const live = (page: Page) => page.evaluate<DocxDocumentRead>(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readDocument())`);
const request = <T,>(page: Page, path: string) => page.evaluate<T>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(m => m.journalRequest(${scriptValue(path)}))`);
async function click(page: Page, root: string, label: string) {
  await page.evaluate(`(() => { const button = Array.from(document.querySelector(${scriptValue(root)}).querySelectorAll('button')).find(b => b.textContent.trim() === ${scriptValue(label)} || b.getAttribute('aria-label') === ${scriptValue(label)}); if (!button || button.disabled) throw new Error('Unavailable button '+${scriptValue(label)}); button.click(); })()`);
}

// Independent standard-library XML control: no expected value comes from the app's parser.
const xmlControl = String.raw`
import copy, hashlib, io, json, re, sys, zipfile, xml.etree.ElementTree as ET
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
W14 = '{http://schemas.microsoft.com/office/word/2010/wordml}'
def load(path):
    with zipfile.ZipFile(path) as z: return {n:z.read(n) for n in z.namelist() if not n.endswith('/')}
def title(root):
    return next(p for p in root.find(W+'body').findall(W+'p') if any(c.isalnum() for c in ''.join(t.text or '' for t in p.iter(W+'t'))))
def child(node, name):
    found=node.find(W+name)
    if found is None:
        found=ET.Element(W+name)
        if name=='pPr' or (name=='rPr' and node.tag==W+'r'): node.insert(0,found)
        elif node.tag==W+'pPr' and name!='rPr' and node.find(W+'rPr') is not None: node.insert(list(node).index(node.find(W+'rPr')),found)
        else: node.append(found)
    return found
# Only the damaged size, frame width and first-section column count/gap/separator may change.
def inherited_size(p,parts,name):
    styles=ET.fromstring(parts['word/styles.xml']); sid=p.find(W+'pPr/'+W+'pStyle'); sid=sid.get(W+'val') if sid is not None else None
    seen=set()
    while sid and sid not in seen:
        seen.add(sid); style=next((n for n in styles.findall(W+'style') if n.get(W+'styleId')==sid),None)
        if style is None: break
        sz=style.find(W+'rPr/'+W+name)
        if sz is not None: return sz.get(W+'val')
        base=style.find(W+'basedOn'); sid=base.get(W+'val') if base is not None else None
    sz=styles.find(W+'docDefaults/'+W+'rPrDefault/'+W+'rPr/'+W+name)
    return sz.get(W+'val') if sz is not None else None
def title_sizes(p,parts):
    result={}
    for name in ('sz','szCs'):
        direct=next((r.find(W+'rPr/'+W+name) for r in p.findall(W+'r') if r.find(W+'rPr/'+W+name) is not None),None)
        mark=p.find(W+'pPr/'+W+'rPr/'+W+name)
        result[name]=direct.get(W+'val') if direct is not None else (mark.get(W+'val') if mark is not None else inherited_size(p,parts,name))
    return result
def values(root, parts):
    p=title(root); frame=p.find(W+'pPr/'+W+'framePr')
    sects=list(root.iter(W+'sectPr'))
    return {'titleText': ''.join(t.text or '' for t in p.iter(W+'t')), 'size': title_sizes(p,parts)['sz'], 'sizes':title_sizes(p,parts),
      'frameWidth': frame.get(W+'w') if frame is not None else None,
      'columns': [(s.find(W+'cols').get(W+'num','1') if s.find(W+'cols') is not None else '1') for s in sects],
      'columnSettings': [column_settings(s) for s in sects]}
def column_settings(section):
    cols=section.find(W+'cols')
    return {'num':cols.get(W+'num','1') if cols is not None else '1',
      'space':cols.get(W+'space','720') if cols is not None else '720',
      'sep':'true' if cols is not None and cols.get(W+'sep','false') in ('1','true','on') else 'false'}
def canonical(node):
    attrs=sorted((k,v) for k,v in node.attrib.items() if k not in {W14+'paraId',W14+'textId'} and not k.startswith(W+'rsid'))
    text=node.text or ''; text='' if len(node) and not text.strip() else text
    return [node.tag,attrs,text,[canonical(c) for c in node]]
def protected(root):
    root=copy.deepcopy(root); p=title(root)
    props_list=[r.find(W+'rPr') for r in p.findall(W+'r')]+[p.find(W+'pPr/'+W+'rPr')]
    for props in props_list:
        if props is None: continue
        for size in list(props):
            if size.tag in (W+'sz',W+'szCs'): props.remove(size)
    frame=p.find(W+'pPr/'+W+'framePr')
    if frame is not None: frame.attrib.pop(W+'w',None)
    for sect in list(root.iter(W+'sectPr'))[:1]:
        for cols in sect.findall(W+'cols'):
            for name in ('num','space','sep'): cols.attrib.pop(W+name,None)
    return canonical(root)
mode,source,template,out=sys.argv[1:]
a,b=load(source),load(template)
ar,br=ET.fromstring(a['word/document.xml']),ET.fromstring(b['word/document.xml'])
expected=values(br,b)
assert expected['size'] is not None, 'Template title needs an independently readable inherited run size'
if mode=='damage':
    used={n.get(W14+'paraId').upper() for n in ar.iter() if n.get(W14+'paraId') is not None}
    seen=set(); identity_changes=[]; counter=1
    for index,node in enumerate(ar.iter(W+'p')):
        old=node.get(W14+'paraId')
        if old is None: continue
        valid=bool(re.fullmatch('[0-9A-Fa-f]{8}',old)) and 0<int(old,16)<=0x7fffffff
        reason='duplicate' if old.upper() in seen else ('invalid_long_hex' if not valid else None)
        seen.add(old.upper())
        if reason is None: continue
        while f'{counter:08X}' in used: counter+=1
        replacement=f'{counter:08X}'; used.add(replacement); counter+=1
        identity_changes.append({'paragraphIndex':index,'reason':reason,'originalParaId':old,'originalTextId':node.get(W14+'textId'),'replacementId':replacement})
        node.set(W14+'paraId',replacement); node.set(W14+'textId',replacement)
    p=title(ar)
    for props in [child(r,'rPr') for r in p.findall(W+'r')]+[child(child(p,'pPr'),'rPr')]:
        for name in ('sz','szCs'):
            assert expected['sizes'][name] is not None, 'Template must independently define '+name
            child(props,name).set(W+'val',str(int(expected['sizes'][name])+8))
    if expected['frameWidth'] is not None:
        child(child(p,'pPr'),'framePr').set(W+'w',str(int(expected['frameWidth'])+600))
    sects=list(ar.iter(W+'sectPr'))
    assert sects and expected['columns'], 'Title section must exist'
    settings=expected['columnSettings'][0]; cols=child(sects[0],'cols')
    cols.set(W+'num','1' if settings['num']!='1' else '2')
    cols.set(W+'space',str(int(settings['space'])+200))
    cols.set(W+'sep','false' if settings['sep']=='true' else 'true')
    # Preserve declarations referenced by mc:Ignorable, Requires and other QName values.
    namespaces=dict(item for _,item in ET.iterparse(io.BytesIO(a['word/document.xml']),events=('start-ns',)))
    for prefix,uri in namespaces.items(): ET.register_namespace(prefix,uri)
    xml=ET.tostring(ar,encoding='utf-8',xml_declaration=True)
    marker=xml.index(b'>',xml.index(b'<',xml.index(b'?>')+2))
    missing=b''.join((' xmlns:'+prefix+'="'+uri+'"').encode() for prefix,uri in namespaces.items() if prefix and ('xmlns:'+prefix+'=').encode() not in xml[:marker])
    a['word/document.xml']=xml[:marker]+missing+xml[marker:]
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
        for n,data in a.items(): z.writestr(n,data)
    print(json.dumps({'expected':expected,'damaged':values(ar,a),'managedFixtureIdentityNormalization':identity_changes,'sourceSha256':hashlib.sha256(open(source,'rb').read()).hexdigest()}))
elif mode=='initial':
    saved=load(out)
    assert set(a)==set(saved), 'Initial export changed package parts'
    removed=[]; added_identities=[]
    for part,data in a.items():
        if not part.endswith(('.xml','.rels')): continue
        root=ET.fromstring(data); live_root=ET.fromstring(saved[part])
        original_nodes=list(root.iter()); live_nodes=list(live_root.iter())
        existing_ids={n.get(W14+'paraId').upper() for n in original_nodes if n.get(W14+'paraId') is not None}
        new_ids=set()
        assert len(original_nodes)==len(live_nodes), 'Initial export changed XML structure: '+part
        for index,(original,node) in enumerate(zip(original_nodes,live_nodes)):
            para_key,text_key=W14+'paraId',W14+'textId'
            additions=set(node.attrib)-set(original.attrib)
            if part in ('word/footnotes.xml','word/endnotes.xml') and original.tag==node.tag==W+'p' and additions=={para_key,text_key} and para_key not in original.attrib and text_key not in original.attrib:
                identity=node.get(para_key)
                assert identity==node.get(text_key) and re.fullmatch('[0-9A-Fa-f]{8}',identity) and 0<int(identity,16)<=0x7fffffff, 'Initial export added invalid paragraph identity: '+part
                assert identity.upper() not in existing_ids|new_ids, 'Initial export added duplicate paragraph identity: '+part
                new_ids.add(identity.upper()); added_identities.append({'part':part,'elementIndex':index,'paraId':identity,'textId':identity,'reason':'missing_id'})
                node.attrib.pop(para_key); node.attrib.pop(text_key)
            key='{http://www.w3.org/XML/1998/namespace}space'
            if original.tag==W+'t' and key in original.attrib and key not in node.attrib:
                text=original.text or ''
                assert text==text.strip(), 'Initial export removed xml:space from edge whitespace: '+part
                original.attrib.pop(key); removed.append({'part':part,'elementIndex':index})
        def exact(node):
            return [node.tag,sorted(node.attrib.items()),node.text,node.tail,[exact(c) for c in node]]
        assert exact(root)==exact(live_root), 'Initial live export changed other XML: '+part
    for part,data in a.items():
        if not part.endswith(('.xml','.rels')): assert data==saved[part], 'Initial export changed binary part: '+part
    print(json.dumps({'allowedXmlSpaceRemovals':removed,'allowedNewNoteParagraphIdentities':added_identities,'allOtherXmlAndPackagePartsPreserved':True}))
else:
    saved=load(out); sr=ET.fromstring(saved['word/document.xml']); actual=values(sr,saved)
    p=title(sr)
    for index,props in enumerate([r.find(W+'rPr') for r in p.findall(W+'r')]+[p.find(W+'pPr/'+W+'rPr')]):
        assert props is not None, ('Missing controlled title run/mark properties',index)
        for name in ('sz','szCs'):
            node=props.find(W+name)
            assert node is not None and node.get(W+'val')==expected['sizes'][name], ('title run/mark size mismatch',index,name,actual,expected)
    if expected['frameWidth'] is not None: assert actual['frameWidth']==expected['frameWidth'], ('frame width mismatch',actual,expected)
    assert actual['columnSettings'][0]==expected['columnSettings'][0], ('title section column settings mismatch',actual,expected)
    assert actual['columns'][1:]==values(ar,a)['columns'][1:], 'Unrelated section columns changed'
    assert protected(ar)==protected(sr), 'Non-title formatting, content or structural objects changed outside allowed section columns'
    assert set(a)==set(saved), 'Package parts changed'
    for n,data in a.items():
        if n=='word/document.xml': continue
        if n.endswith(('.xml','.rels')):
            assert canonical(ET.fromstring(data))==canonical(ET.fromstring(saved[n])), 'Other XML/relationships changed: '+n
        else: assert data==saved[n], 'Media/binary part changed: '+n
    print(json.dumps({'expected':expected,'actual':actual,'protectedOutsideTitleAndColumns':True,'partsPreserved':True}))
`;
function control(mode: "damage" | "initial" | "verify", source: string, template: string, output: string): Record<string, unknown> {
  return JSON.parse(execFileSync(process.env.OLEAFLY_WORKBENCH_PYTHON ?? resolve("services/research-workbench/.venv/bin/python"),
    ["-c", xmlControl, mode, source, template, output], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
}
async function transcript(page: Page, task: ResearchTask) {
  const result: TaskTranscriptEvent[] = [];
  let cursor: number | null = null;
  do {
    const batch: TaskTranscriptPage = await page.evaluate<TaskTranscriptPage>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m => m.loadResearchTaskEvents(${scriptValue(task.id)}, ${task.executionGeneration}, ${cursor ?? "undefined"}, 100))`);
    result.push(...batch.events);
    if (batch.nextSequence === null) return result;
    cursor = batch.nextSequence;
  } while (true);
}

function activitiesPage(page: Page, projectId: string, manuscriptId: string, cursor: number) {
  return page.evaluate<DocxActivityPage>(`window.__TAURI_INTERNALS__.invoke('research_docx_activities',{
    projectId:${scriptValue(projectId)},workbenchProjectId:${scriptValue(manuscriptId)},afterCursor:${cursor},limit:50})`);
}

test("real Sol repairs a title and section columns from retained Word template facts", async ({ tauriPage: page }, testInfo) => {
  test.skip(!enabled || !relay || !run, "Enable the isolated native Word template live runner with its relay and output directory.");
  test.setTimeout(900_000);
  const templatePath = process.env.OLEAFLY_NATIVE_TEMPLATE_DOC;
  const authorPath = process.env.OLEAFLY_NATIVE_DOCX_EN;
  expect(templatePath).toBeTruthy(); expect(authorPath).toBeTruthy();
  const templateBytes = await readFile(templatePath!);
  const authorBytes = await readFile(authorPath!);
  const initialHashes = { template: hash(templateBytes), author: hash(authorBytes) };
  const report: Record<string, unknown> = { outcome: "RUNNING", model: MODEL, requestedEffort: "high", initialHashes,
    limits: "One live model run repairs title font size, paragraph frame width when present, and its section column settings on an English managed copy. No style imports, Word/WPS pagination or whole-manuscript quality claim. Relay owns upstream identity evidence." };
  let task: ResearchTask | undefined;
  try {
    if (await page.getByTestId("docx-workspace").count()) { await click(page, '[data-testid="docx-workspace"]', "Close"); await expect(page.getByTestId("docx-workspace")).toHaveCount(0); }
    if (await page.evaluate<boolean>(`!!document.querySelector('[title="Back to library"]')`)) await page.click('[title="Back to library"]');
    await createBlankProject(page, `Word live format ${Date.now()}`);
    const projectId = await page.evaluate<string>(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().projectId)`);
    await page.evaluate(`window.__researchTasksSet?.(true)`);
    await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(async api => { const c=await api.getConfig(); await api.setConfig({...c,
      ai_custom_providers:[...(c.ai_custom_providers??[]).filter(p=>p.id!==${scriptValue(PROVIDER)}),{id:${scriptValue(PROVIDER)},name:'Word live relay',baseURL:${scriptValue(relay)},keyOptional:true}],
      ai_provider_models:{...c.ai_provider_models,[${scriptValue(PROVIDER)}]:[{id:${scriptValue(MODEL)},name:${scriptValue(MODEL)},enabled:true,source:'custom',metadata:{name:${scriptValue(MODEL)},toolCall:true,reasoning:true,reasoningOptions:[{type:'effort',values:['high']}]}}]}}); })`);
    await openRailTab(page, "Journal checks");
    await expect.poll(() => request<JournalState>(page,"/api/state").then(()=>true,()=>false),{timeout:90000}).toBe(true);
    const journalId = `word-live-${randomUUID()}`;
    const world = await page.evaluate<JournalWorld>(`window.__oleaflyE2EImport('/src/lib/docx-template-client.ts').then(m => m.importJournalTemplate(new File([
      Uint8Array.from(atob(${scriptValue(templateBytes.toString("base64"))}),c=>c.charCodeAt(0))],${scriptValue(basename(templatePath!))}),
      {journal_id:${scriptValue(journalId)},journal_name:'Word live template',article_type:'research_article',stage:'initial_submission',language:'en'}))`);
    report.worldVersionId = world.version_id;
    // Copy exact retained normalized bytes through the existing managed template-copy service.
    const copy = await page.evaluate<{ project: JournalProject }>(`window.__oleaflyE2EImport('/src/lib/docx-template-client.ts').then(m => m.startTemplateWorkingCopy(${scriptValue(world.version_id)},'Independent XML template control',${scriptValue(`control-${randomUUID()}`)}))`);
    const retained = await request<{ content_base64: string; source_sha256: string }>(page, `/api/manuscript-source?project_id=${encodeURIComponent(copy.project.project_id)}&baseline_id=${encodeURIComponent(copy.project.baseline_id)}`);
    expect(retained.source_sha256).toBe(world.template?.source_sha256);
    const normalizedPath = resolve(run!, "word-live-template-normalized.docx");
    await writeFile(normalizedPath, Buffer.from(retained.content_base64, "base64"));
    const damagedPath = resolve(run!, "word-live-controlled-manuscript.docx");
    report.independentDamage = control("damage", authorPath!, normalizedPath, damagedPath);
    const damagedBytes = await readFile(damagedPath);
    await openRailTab(page, "Journal checks");
    const panel = page.getByTestId("journal-checks-panel");
    await panel.getByText("Import DOCX", { exact: true }).click();
    await page.fill('[role="dialog"] input:not([type="file"])', `Controlled English ${Date.now()}`);
    await page.setInputFiles('[role="dialog"] input[type="file"]', [{ name: "controlled-english.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: damagedBytes }]);
    await page.click('[role="dialog"] button[type="submit"]'); await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await panel.getByText("Edit DOCX working copy", { exact: true }).click();
    await expect.poll(() => live(page).then(r=>r.document.dirty,()=>null), {timeout:120_000}).toBe(false);
    const before = await live(page);
    report.before = before.document;
    expect(before.document.sourceSha256).toBe(hash(damagedBytes));
    const initialLivePath = resolve(run!, 'word-live-initial-export.docx');
    await page.evaluate(`window.__e2eSetNextSavePath(${scriptValue(initialLivePath)})`);
    await click(page, '[data-testid="docx-workspace"]', 'Download DOCX copy');
    await expect.poll(async () => { try { return (await readFile(initialLivePath)).length; } catch { return 0; } }, { timeout: 60_000 }).toBeGreaterThan(0);
    const initialLiveBytes = await readFile(initialLivePath);
    report.initialLiveExport = { sourceSha256: hash(initialLiveBytes), path: initialLivePath, normalization: control('initial', damagedPath, normalizedPath, initialLivePath) };
    expect((await live(page)).document).toEqual(before.document);
    expect((await activitiesPage(page,projectId,before.document.workbenchProjectId,0)).activities).toEqual([]);
    const prompt = `Work only on the bound live Word working copy. Use selected template world ${world.version_id} as the formatting authority. Repair only the manuscript title text and paragraph mark font size (both normal and complex-script size), its paragraph frame width when the template has a frame, and the column settings of the section containing that title to match the template. Preserve every other formatting field, all manuscript text, citations, inline objects, tables, media, relationships, other paragraphs and other sections. Keep existing style definitions; do not import or change styles. Derive the expected values and target identity yourself from system-parsed live document and retained template facts; do not guess values. Complete these supported formatting changes in one atomic batch, save the resulting revision, and check the saved baseline against this selected template. If a required field is unsupported, report that failure explicitly. Do not use shell, network, desktop apps, edit project files, delegate, or create another task. Finish within seven minutes with the actual read/change/save/check evidence and any gaps.`;
    task = await page.evaluate<ResearchTask>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m => m.createResearchTask({projectId:${scriptValue(projectId)},title:'Word template live title repair',prompt:${scriptValue(prompt)},runtimeId:'builtin',agentId:${scriptValue(PROVIDER)},modelId:${scriptValue(MODEL)},skillIds:[],dependencyIds:[],brief:{...m.defaultBrief(),goal:'Repair one title and its section columns from the selected Word template',reasoningEffort:'high',permissions:{network:false,commands:'off',desktopApps:false},budget:{...m.defaultBrief().budget,wallClockMinutes:7}}}))`);
    await click(page, '[aria-label="Task activity"]', "Refresh activity");
    await waitLong(page, `Array.from(document.querySelectorAll('[aria-label="Task activity"] select option')).some(o=>o.value===${scriptValue(task.id)})`, 15000);
    await page.selectOption('[aria-label="Task activity"] select', task.id);
    await waitLong(page, `Array.from(document.querySelectorAll('[aria-label="Task activity"] button')).some(b=>b.textContent.trim()==='Bind current DOCX'&&!b.disabled)`, 15000);
    await click(page, '[aria-label="Task activity"]', "Bind current DOCX");
    await page.evaluate(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m => m.startResearchTask(${scriptValue(task.id)}))`);
    await expect.poll(async () => { task = await page.evaluate<ResearchTask>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => (await m.listResearchTasks(${scriptValue(projectId)})).find(t=>t.id===${scriptValue(task!.id)}))`); return ["awaiting_review","completed","failed","cancelled"].includes(task.status); }, {timeout:450_000,intervals:[1000,2000]}).toBe(true);
    report.task = task;
    const events = await transcript(page, task!);
    report.events = events;
    report.usage = events.filter(({event})=>event.kind==="usage" || event.kind==="observation"&&event.observation.type==="usage");
    expect(["awaiting_review","completed"], task?.error ?? "Live task failed").toContain(task?.status);
    expect(task?.result?.inputTokens).toBeGreaterThan(0); expect(task?.result?.outputTokens).toBeGreaterThan(0);
    const names = events.flatMap(({event})=>event.kind==="observation"&&event.observation.type==="toolRequested"?[event.observation.name]:[]);
    report.toolTrail = names;
    for (const name of ["read_docx_format","apply_docx_format_batch","save_docx_document","check_docx_template"]) expect(names).toContain(name);
    expect(names.filter(n=>n==="apply_docx_format_batch")).toHaveLength(1);
    const after = await live(page);
    expect(after.document.dirty).toBe(false); expect(after.document.baselineId).not.toBe(before.document.baselineId);
    const activityPages: DocxActivityPage["activities"] = [];
    let activityCursor = 0;
    do {
      const activityPage = await activitiesPage(page,projectId,after.document.workbenchProjectId,activityCursor);
      activityPages.push(...activityPage.activities);
      if (!activityPage.hasMore) break;
      expect(activityPage.nextCursor).toBeGreaterThan(activityCursor);
      activityCursor = activityPage.nextCursor;
    } while (true);
    // The activity store owns complete operation receipts. Streamed tool cards are bounded display text.
    const activities = activityPages.map(({activity})=>activity).filter(activity=>activity.origin.taskId===task!.id && activity.origin.generation===task!.executionGeneration);
    report.activities = activities;
    const batchActivity = activities.find(activity=>
      activity.event.type==="runtime" && activity.event.event.kind==="operation" && activity.event.event.operation==="format_batch");
    expect(batchActivity?.event).toMatchObject({ type:"runtime",event:{kind:"operation",operation:"format_batch",result:{ok:true,result:{ok:true,changed:true}}} });
    if (batchActivity?.event.type!=="runtime" || batchActivity.event.event.kind!=="operation") throw new Error("Missing retained batch operation.");
    const batchOperationId = batchActivity.event.event.operationId;
    const savedBatch = activities.find(activity=>activity.event.type==="operationCheckpoint" &&
      activity.event.operationId===batchOperationId && activity.event.phase==="saved");
    expect(savedBatch).toMatchObject({ origin:batchActivity.origin,document:batchActivity.document,
      event:{type:"operationCheckpoint",phase:"saved",contentSha256:after.document.sourceSha256,fromDocument:batchActivity.document} });
    report.batchSaveCheckpoint = savedBatch;
    const saveActivity = activities.find(activity=>activity.event.type==="runtime" && activity.event.event.kind==="operation" && activity.event.event.operation==="save");
    const checkActivity = activities.find(activity=>activity.event.type==="runtime" && activity.event.event.kind==="operation" && activity.event.event.operation==="check");
    expect(saveActivity).toMatchObject({ origin:batchActivity.origin,event:{type:"runtime",event:{kind:"operation",operation:"save",result:{operation:"save",ok:true,
      document:{baselineId:after.document.baselineId,sourceSha256:after.document.sourceSha256,sessionRevision:after.document.sessionRevision},
      result:{baselineId:after.document.baselineId,sourceSha256:after.document.sourceSha256,revision:after.document.sessionRevision}}}} });
    expect(checkActivity).toMatchObject({ origin:batchActivity.origin,document:saveActivity?.document,event:{type:"runtime",event:{kind:"operation",operation:"check",result:{operation:"check",ok:true,
      result:{template:world.version_id,check:{baseline_id:after.document.baselineId,world_version_id:world.version_id}}}}} });
    if (checkActivity?.event.type!=="runtime" || checkActivity.event.event.kind!=="operation") throw new Error("Missing retained check operation.");
    expect(activities).toEqual(expect.arrayContaining([expect.objectContaining({ origin:checkActivity.origin,document:checkActivity.document,event:expect.objectContaining({
      type:"operationCheckpoint",operationId:checkActivity.event.event.operationId,phase:"recovered",contentSha256:after.document.sourceSha256}) })]));
    const state = await request<JournalState>(page,"/api/state");
    const current = state.projects.find(p=>p.project_id===after.document.workbenchProjectId);
    expect(current?.latest_check).toMatchObject({baseline_id:after.document.baselineId,world_version_id:world.version_id,validity:"CURRENT"} satisfies Partial<JournalCheck>);
    const saved = await request<{content_base64:string;source_sha256:string}>(page,`/api/manuscript-source?project_id=${encodeURIComponent(after.document.workbenchProjectId)}&baseline_id=${encodeURIComponent(after.document.baselineId)}`);
    const savedBytes = Buffer.from(saved.content_base64,"base64"); expect(hash(savedBytes)).toBe(after.document.sourceSha256);
    const savedPath = resolve(run!,"word-live-repaired.docx"); await writeFile(savedPath,savedBytes);
    report.xmlVerification = control("verify",initialLivePath,normalizedPath,savedPath);
    await click(page,'[data-testid="docx-workspace"]',"Close"); await expect(page.getByTestId("docx-workspace")).toHaveCount(0);
    await panel.getByText("Edit DOCX working copy",{exact:true}).click();
    await expect.poll(()=>live(page).then(r=>r.document.sourceSha256,()=>null),{timeout:120_000}).toBe(after.document.sourceSha256);
    expect((await live(page)).document.dirty).toBe(false);
    await page.screenshot({path:resolve(run!,"word-template-live-reopened.png")});
    report.after = after.document; report.outcome = "PASSED";
  } finally {
    if(task) report.task = task;
    if(task) { try { report.finalEvents = await transcript(page,task); } catch(error) { report.finalEventsError=String(error); } }
    if(task?.status==="running") await page.evaluate(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m=>m.cancelResearchTask(${scriptValue(task.id)}))`);
    const finalHashes = { template: hash(await readFile(templatePath!)), author: hash(await readFile(authorPath!)) };
    report.finalHashes = finalHashes;
    if(report.outcome!=="PASSED") report.outcome="FAILED";
    report.finishedAt=new Date().toISOString();
    const reportPath=resolve(run!,"word-template-live-report.json"); await writeFile(reportPath,JSON.stringify(report,null,2));
    await testInfo.attach("word-template-live-report",{path:reportPath,contentType:"application/json"});
    expect(finalHashes).toEqual(initialHashes);
  }
});
