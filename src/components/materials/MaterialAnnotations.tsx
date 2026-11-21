import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PanelRightClose } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TaskAnnotations } from "@/components/research/tasks/TaskAnnotations";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/app-error";
import { captureAssistantTarget } from "@/lib/assistant-delegation-capture";
import { materialAnnotationSnapshot, readMaterialAnnotation, requestMaterialAnnotation, saveMaterialAnnotation, type RetainedMaterial } from "@/lib/material-annotations";
import { materialTarget, type MaterialAnchor, type MaterialDocument } from "@/lib/material-surface";
import { defaultBrief, listResearchTasks, type ResearchTask } from "@/lib/research-tasks";
import { loadObjectAnnotations, loadTaskGroup, type AnnotationTarget, type GroupMember, type TaskAnnotation, type TaskAnnotationDraft } from "@/lib/task-collaboration";
import type { MaterialAnnotationOptions } from "@/store/material-annotations";
import { useMaterialViewerStore } from "@/store/material-viewer";
import { useResearchTasksStore } from "@/store/research-tasks";
import { researchTasksEnabled, setResearchTasksEnabled } from "@/store/research-tasks-flag";
import { useSettingsStore } from "@/store/settings";

export interface MaterialAnnotationsProps {
  onOpenSnapshot?: (retained: RetainedMaterial) => void;
  onOpenTarget?: (target: AnnotationTarget) => void;
  onMinimize?: () => void;
  onClose: () => void;
  current: boolean;
  active?: boolean;
  wordRevision?: number;
  document: MaterialDocument;
  anchor: MaterialAnchor;
  options: MaterialAnnotationOptions;
}

export function MaterialAnnotations({ document, anchor, options, onOpenSnapshot, onOpenTarget, onMinimize, onClose, current, active, wordRevision }: Readonly<MaterialAnnotationsProps>) {
  const { t } = useTranslation("researchTools");
  const { t: tEditor } = useTranslation("editor");
  const text = t(($) => $.researchTools.materialAnnotations, { returnObjects: true });
  const [pendingStart, setPendingStart] = useState<ResearchTask | null>(null);
  const [activeTask, setActiveTask] = useState<ResearchTask | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const wordSelection = document.kind === "docx" && anchor.kind === "object";
  useLayoutEffect(() => {
    const element = composer.current;
    if (active && wordSelection && element?.ownerDocument.activeElement?.closest("[data-testid='workspace-word-surface'] .docx-pages")) {
      element.focus({ preventScroll: true });
    }
  }, [active, wordSelection]);
  const retainedRoot = useRef<{ key: string; annotation: TaskAnnotation } | null>(null);
  const taskBindings = useRef(new Map<string, { revision: string; bind: NonNullable<MaterialAnnotationOptions["beforeStartTask"]> }>());
  const target = materialTarget(document);
  const { projectId, documentId } = document;
  useEffect(() => {
    let current = true;
    void loadObjectAnnotations({ projectId, taskId: null, objectKind: "material", objectId: documentId, objectRevision: null, path: null }).then(async (context) => {
      const taskIds = new Set(context.annotations.flatMap((item) => item.target.taskId ? [item.target.taskId] : []));
      if (!taskIds.size) return;
      const tasks = await listResearchTasks(projectId);
      const latest = tasks.filter((task) => taskIds.has(task.id)).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!current || !latest) return;
      const selected = context.annotations.find((item) => item.target.taskId === latest.id);
      if (options.beforeStartTask && selected?.target.objectRevision === document.revision) taskBindings.current.set(latest.id, { revision: document.revision, bind: options.beforeStartTask });
      setActiveTask(latest);
      if (latest.status === "queued") setPendingStart(latest);
    }).catch((cause) => { if (current) setError(describeError(cause)); });
    return () => { current = false; };
  }, [projectId, documentId, document.revision, options.beforeStartTask]);
  const activeTaskId = activeTask?.id;
  useEffect(() => {
    let current = true;
    setMembers([]);
    if (activeTaskId) void loadTaskGroup(projectId, activeTaskId).then((group) => { if (current) setMembers(group?.members ?? []); })
      .catch((cause) => { if (current) setError(describeError(cause)); });
    return () => { current = false; };
  }, [projectId, activeTaskId]);
  const describeTarget = (reference: AnnotationTarget) => {
    if (reference.objectKind !== "material") return reference.path ?? text.result;
    const earlierWorkingDraft = wordRevision !== undefined && options.wordSessionRevision !== wordRevision;
    const sameVersion = !earlierWorkingDraft && reference.objectRevision?.replace(/^sha256:/u, "") === document.revision.replace(/^sha256:/u, "");
    return `${document.title} · ${sameVersion ? text.currentVersion : text.oldVersion}`;
  };

  async function start(task: ResearchTask) {
    setStarting(true); setError(null);
    try {
      const binding = taskBindings.current.get(task.id);
      if (options.beforeStartTask && binding?.revision !== document.revision) throw new Error(tEditor(($) => $.editor.materials.captureChanged));
      if (options.beforeStartTask) await binding?.bind(task.id);
      const started = await useResearchTasksStore.getState().startTask(task.id);
      setActiveTask(started); setPendingStart(null);
    } catch (cause) { setError(describeError(cause)); }
    finally { setStarting(false); }
  }

  async function submit(draft: TaskAnnotationDraft): Promise<TaskAnnotation> {
    setError(null);
    if (!draft.explicitRequest) return saveMaterialAnnotation(document, anchor, draft);
    if (pendingStart) throw new Error(text.requestPending);
    const key = JSON.stringify([draft.target, draft.parentId, draft.body, anchor]);
    if (retainedRoot.current?.key !== key) {
      retainedRoot.current = { key, annotation: await saveMaterialAnnotation(document, anchor, { ...draft, explicitRequest: false }) };
    }
    // Checking this box is the user's explicit instruction to execute the request.
    if (!researchTasksEnabled()) await setResearchTasksEnabled(true);
    const provider = await captureAssistantTarget(document.projectId);
    const brief = defaultBrief(draft.body.slice(0, 2000));
    const result = await requestMaterialAnnotation(document.projectId, retainedRoot.current.annotation.id, {
      projectId: document.projectId, ...provider, title: `${text.taskTitle} · ${document.title}`,
      prompt: draft.body, brief, skillIds: [], dependencyIds: [],
    });
    useResearchTasksStore.getState().receiveTask(result.task);
    setActiveTask(result.task);
    if (result.needsStart) {
      if (options.beforeStartTask && result.annotation.target.objectRevision === document.revision) taskBindings.current.set(result.task.id, { revision: document.revision, bind: options.beforeStartTask });
      setPendingStart(result.task);
      await start(result.task);
    }
    retainedRoot.current = null;
    return result.annotation;
  }

  async function openSource(annotation: TaskAnnotation) {
    try {
      const retained = await readMaterialAnnotation(annotation.target.projectId, annotation.id);
      setError(null);
      if (onOpenSnapshot) onOpenSnapshot(retained);
      else useMaterialViewerStore.getState().open({ ...retained.snapshot.document,
        role: annotation.explicitRequest ? "task_input" : "evidence",
        load: async () => new Uint8Array(retained.bytes), anchor: retained.snapshot.anchor, mediaType: retained.snapshot.mediaType });
    } catch (cause) { setError(describeError(cause)); }
  }

  async function openTarget(reference: AnnotationTarget) {
    if (reference.objectKind !== "material") {
      if (onOpenTarget) onOpenTarget(reference);
      else if (reference.taskId) {
        await openHandlingTask(reference.taskId, "output");
      }
      return;
    }
    try {
      const context = await loadObjectAnnotations(reference);
      const original = context.annotations.find((item) => item.target.objectRevision === reference.objectRevision && materialAnnotationSnapshot(item));
      if (original) await openSource(original);
    } catch (cause) { setError(describeError(cause)); }
  }

  async function openHandlingTask(taskId: string, tab: "annotations" | "output") {
    try {
      const store = useResearchTasksStore.getState();
      if (store.projectId !== projectId) await store.bindProject(projectId);
      else if (!store.tasks.some((task) => task.id === taskId)) await store.refresh();
      useResearchTasksStore.getState().openTaskDetail(taskId, tab);
      const settings = useSettingsStore.getState();
      settings.setShowTree(true);
      settings.setRailTab("research");
    } catch (cause) { setError(describeError(cause)); }
  }

  return <aside data-testid={current ? "material-annotations" : undefined} className="min-w-0 space-y-3 border-l bg-background p-3" aria-label={text.title}>
    <div className="flex items-center justify-between gap-2">
      <h3 className="min-w-0 truncate text-sm font-medium">{document.title}</h3>
      {onMinimize && <Button type="button" size="icon" variant="ghost" className="ml-auto size-7 shrink-0" aria-label={text.minimize} onClick={onMinimize}><PanelRightClose className="size-4" /></Button>}
      <Button type="button" size="xs" variant="ghost" onClick={onClose}>{text.close}</Button>
    </div>
    <p className="text-xs text-muted-foreground">{text[anchor.kind]}</p>
    {document.kind === "docx" && anchor.kind === "object" && anchor.label && <blockquote className="max-h-24 overflow-auto whitespace-pre-wrap border-l-2 pl-2 text-xs">{anchor.label}</blockquote>}
    {anchor.kind === "text" || anchor.kind === "html" || anchor.kind === "page" || anchor.kind === "pdf" ? anchor.quote && <p className="max-h-24 overflow-auto whitespace-pre-wrap text-xs">{anchor.quote}</p> : null}
    {pendingStart && <div className="space-y-2 rounded-md border p-2 text-xs"><p>{text.requestPending}</p><Button type="button" size="sm" disabled={starting} onClick={() => void start(pendingStart)}>{text.retryStart}</Button></div>}
    {activeTask && <Button type="button" variant="link" size="sm" className="h-auto whitespace-normal px-0 text-left" onClick={() => { void openHandlingTask(activeTask.id, "annotations"); }}>{text.openTask} · {activeTask.title}</Button>}
    {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
    <TaskAnnotations contextScope="object" objectTarget={target} submitAnnotation={submit} members={members}
      composerRef={composer} staticDraftTarget={document.kind === "docx"}
      onOpenTarget={(reference) => { void openTarget(reference); }} onOpenAnnotationSource={(annotation) => { void openSource(annotation); }}
      describeTarget={describeTarget} describeAnnotation={(annotation) => {
        const snapshot = materialAnnotationSnapshot(annotation);
        return snapshot ? `${describeTarget(annotation.target)} · ${text[snapshot.anchor.kind]}` : describeTarget(annotation.target);
      }} requestHint={text.feedbackHelp} />
  </aside>;
}
