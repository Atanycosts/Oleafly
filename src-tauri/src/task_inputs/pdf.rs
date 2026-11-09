//! Captured PDF selections share the annotation store and immutable task PDFs.
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};
use oleafly_research::{
    annotations::{
        Annotation, AnnotationAuthor, AnnotationDraft, AnnotationQuery, AnnotationSourceDraft,
        AnnotationTarget,
    },
    compiled_artifacts::{self, TaskCompiledArtifact},
    model::{ResearchTaskDraft, ResearchTaskEdit, ResearchTaskView},
    observations::content_hash,
    scheduler::ResearchTaskState,
    store::TaskStore,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

const MAX_PDF_BYTES: usize = 100 * 1024 * 1024;
const SOURCE_KIND: &str = "pdf_selection";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfSelectionRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfSelectionPage {
    pub page: u32,
    pub rects: Vec<PdfSelectionRect>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfSelection {
    pub document_identity: String,
    pub text: String,
    pub pages: Vec<PdfSelectionPage>,
    pub rotation: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfSelectionInput {
    pub project_id: String,
    pub main_document: String,
    pub checkpoint: Option<Value>,
    pub selection: PdfSelection,
    pub pdf_sha256: String,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetainedPdfSelection {
    pub annotation_id: String,
    pub original_annotation_id: String,
    pub input: PdfSelectionInput,
    pub reference: TaskCompiledArtifact,
}

fn validate_input(input: &PdfSelectionInput) -> Result<(), String> {
    crate::paths::validate_project_id(&input.project_id)?;
    super::relative(&input.main_document)?;
    if let Some(checkpoint) = &input.checkpoint {
        if checkpoint["projectId"].as_str() != Some(input.project_id.as_str())
            || checkpoint["mainDocument"].as_str() != Some(input.main_document.as_str())
        {
            return Err("The PDF checkpoint belongs to another project or main document.".into());
        }
    }
    if input.size == 0 || input.size > MAX_PDF_BYTES as u64 {
        return Err("Capture a PDF no larger than 100 MiB.".into());
    }
    if input.pdf_sha256.len() != 64
        || !input
            .pdf_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("The captured PDF SHA-256 is invalid.".into());
    }
    let selection = &input.selection;
    if selection.document_identity.trim().is_empty()
        || selection.text.trim().is_empty()
        || selection.pages.is_empty()
        || !matches!(selection.rotation, 0 | 90 | 180 | 270)
    {
        return Err("Select PDF text with its document identity, pages and rotation.".into());
    }
    for page in &selection.pages {
        if !(1..=2000).contains(&page.page) || page.rects.is_empty() {
            return Err("PDF selections require page numbers 1–2000 and page rectangles.".into());
        }
        for rect in &page.rects {
            if ![rect.x, rect.y, rect.width, rect.height]
                .iter()
                .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
                || rect.width == 0.0
                || rect.height == 0.0
                || rect.x + rect.width > 1.0 + 4.0 * f64::EPSILON
                || rect.y + rect.height > 1.0 + 4.0 * f64::EPSILON
            {
                return Err(
                    "PDF rectangles must be finite coordinates within the displayed page (0–1)."
                        .into(),
                );
            }
        }
    }
    Ok(())
}

fn pdf_path(root: &Path, sha256: &str) -> PathBuf {
    root.join("pdf-inputs").join(format!("{sha256}.pdf"))
}

fn validate_bytes(input: &PdfSelectionInput, bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The captured bytes are not a PDF.".into());
    }
    if bytes.len() as u64 != input.size || content_hash(bytes) != input.pdf_sha256 {
        return Err("The retained PDF does not match its recorded size and SHA-256.".into());
    }
    Ok(())
}

fn object_id(input: &PdfSelectionInput) -> Result<String, String> {
    Ok(format!(
        "{}:{}",
        input.pdf_sha256,
        content_hash(&serde_json::to_vec(&input.selection).map_err(|e| e.to_string())?)
    ))
}

fn selection_draft(input: &PdfSelectionInput, body: String) -> Result<AnnotationDraft, String> {
    validate_input(input)?;
    let content = serde_json::to_string(input).map_err(|e| e.to_string())?;
    if content.len() > 256 * 1024 {
        return Err("The PDF selection metadata exceeds 256 KiB.".into());
    }
    let mut draft = AnnotationDraft::new(
        AnnotationTarget::new(&input.project_id, SOURCE_KIND, object_id(input)?)
            .revision(format!("sha256:{}", input.pdf_sha256))
            .at_path(&input.main_document),
        AnnotationAuthor::user("user"),
        body,
    );
    draft.source = Some(AnnotationSourceDraft {
        kind: SOURCE_KIND.into(),
        content,
    });
    Ok(draft)
}

fn read_annotation(
    store: &TaskStore,
    project: &str,
    id: &str,
) -> Result<(Annotation, PdfSelectionInput, Vec<u8>), String> {
    let annotation = store.annotation(project, id)?;
    let input = annotation_input(&annotation, project)?;
    let bytes = std::fs::read(pdf_path(store.root(), &input.pdf_sha256))
        .map_err(|e| format!("The original PDF is unavailable: {e}"))?;
    validate_bytes(&input, &bytes)?;
    Ok((annotation, input, bytes))
}

fn annotation_input(annotation: &Annotation, project: &str) -> Result<PdfSelectionInput, String> {
    let source = annotation
        .source
        .as_ref()
        .filter(|source| source.kind == SOURCE_KIND)
        .ok_or("This annotation does not retain a PDF selection.")?;
    if content_hash(source.content.as_bytes()) != source.sha256 {
        return Err("The retained PDF selection source changed.".into());
    }
    let input: PdfSelectionInput =
        serde_json::from_str(&source.content).map_err(|e| e.to_string())?;
    validate_input(&input)?;
    if input.project_id != project
        || annotation.target.object_kind != SOURCE_KIND
        || annotation.target.object_id != object_id(&input)?
        || annotation.target.object_revision.as_deref()
            != Some(format!("sha256:{}", input.pdf_sha256).as_str())
        || annotation.target.path.as_deref() != Some(input.main_document.as_str())
    {
        return Err("The PDF annotation target does not match its retained input.".into());
    }
    Ok(input)
}

fn list_selections(store: &TaskStore, project: &str) -> Result<Vec<Annotation>, String> {
    crate::paths::validate_project_id(project)?;
    store
        .list_annotations(&AnnotationQuery {
            object_kind: Some(SOURCE_KIND.into()),
            ..AnnotationQuery::project(project)
        })?
        .into_iter()
        .filter(|annotation| {
            annotation.target.task_id.is_none()
                && annotation
                    .source
                    .as_ref()
                    .is_some_and(|source| source.kind == SOURCE_KIND)
        })
        .map(|annotation| {
            annotation_input(&annotation, project).map_err(|error| {
                format!("Invalid retained PDF selection {}: {error}", annotation.id)
            })?;
            Ok(annotation)
        })
        .collect()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn research_pdf_selection_save(
    state: State<'_, ResearchTaskState>,
    project_id: String,
    main_document: String,
    checkpoint: Option<Value>,
    selection: PdfSelection,
    pdf_base64: String,
    pdf_sha256: String,
    body: String,
) -> Result<Annotation, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if pdf_base64.len() > MAX_PDF_BYTES.div_ceil(3) * 4 {
            return Err("Capture a PDF no larger than 100 MiB.".into());
        }
        let bytes = STANDARD.decode(pdf_base64).map_err(|e| e.to_string())?;
        let input = PdfSelectionInput {
            project_id,
            main_document,
            checkpoint,
            selection,
            pdf_sha256,
            size: bytes.len() as u64,
        };
        let draft = selection_draft(&input, body)?;
        validate_bytes(&input, &bytes)?;
        let store = state.store()?;
        let path = pdf_path(store.root(), &input.pdf_sha256);
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        crate::sandbox::atomic_write(&path, &bytes)?;
        // A root annotation has no task or delegated work. Saving feedback
        // therefore never starts a model, including when tasks are disabled.
        state.submit_annotation(draft)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn research_pdf_selection_read(
    state: State<'_, ResearchTaskState>,
    project_id: String,
    annotation_id: String,
) -> Result<tauri::ipc::Response, String> {
    let store = state.store()?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        read_annotation(&store, &project_id, &annotation_id).map(|(_, _, bytes)| bytes)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn research_pdf_selections(
    state: State<'_, ResearchTaskState>,
    project_id: String,
) -> Result<Vec<Annotation>, String> {
    let store = state.store()?;
    tauri::async_runtime::spawn_blocking(move || list_selections(&store, &project_id))
        .await
        .map_err(|e| e.to_string())?
}

fn retain_for_task(
    store: &TaskStore,
    task: &str,
    annotation: &Annotation,
    input: PdfSelectionInput,
    bytes: &[u8],
    request: String,
) -> Result<RetainedPdfSelection, String> {
    let reference = compiled_artifacts::retain_input(
        store.root(),
        task,
        &input.main_document,
        content_hash(&serde_json::to_vec(&input).map_err(|e| e.to_string())?),
        bytes,
    )?;
    let mut child = AnnotationDraft::new(
        AnnotationTarget {
            task_id: Some(task.into()),
            ..annotation.target.clone()
        },
        AnnotationAuthor::user("user"),
        request,
    )
    .reply_to(&annotation.id)
    .request();
    child.source = annotation
        .source
        .as_ref()
        .map(|source| AnnotationSourceDraft {
            kind: source.kind.clone(),
            content: source.content.clone(),
        });
    let child = store.submit_task_annotation(&child)?;
    Ok(RetainedPdfSelection {
        annotation_id: child.id,
        original_annotation_id: annotation.id.clone(),
        input,
        reference,
    })
}

fn task_prompt(
    request: &str,
    retained: &RetainedPdfSelection,
    record_dir: &str,
) -> Result<String, String> {
    let reference = serde_json::to_string(&retained.reference).map_err(|e| e.to_string())?;
    Ok(format!(
        "{request}\n\nCaptured PDF input:\n- Read {record_dir}/pdf-selection.json for the exact selection, page rectangles and compile checkpoint.\n- Original annotation: {}; this task's current request: {}.\n- Inspect the retained PDF with task_pdf_text and task_pdf_pages using this complete reference: {reference}\n- Generation 0 is a captured input, not a successful compile for the task. The PDF may predate the current source. Read current source and relevant evidence before editing; do not assume correspondence.\n- After changes, compile the task workspace and inspect the actual newly compiled output before handing results back.",
        retained.original_annotation_id, retained.annotation_id
    ))
}

use super::rollback_input;

#[tauri::command]
pub async fn research_task_create_from_pdf_selection(
    state: State<'_, ResearchTaskState>,
    mut draft: ResearchTaskDraft,
    annotation_id: String,
) -> Result<ResearchTaskView, String> {
    let store = state.store()?;
    let project = draft.project_id.clone();
    let (annotation, input, bytes) =
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let retained = read_annotation(&store, &project, &annotation_id)?;
            if retained.0.target.task_id.is_some() {
                return Err("Start a PDF task from the original project annotation.".into());
            }
            Ok(retained)
        })
        .await
        .map_err(|e| e.to_string())??;
    let request = draft.prompt.clone();
    let run_after = draft.run_after.take();
    let compile_manifest = super::project_manifest(&draft.project_id, Some(&input.main_document))?;
    let store = state.store()?;
    let task = crate::research_tasks::create_task_pending_inputs(state, draft).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let task_id = task.id.clone();
        let initialized: Result<ResearchTaskView, String> = (|| {
            let retained = retain_for_task(
                &store,
                &task.id,
                &annotation,
                input,
                &bytes,
                request.clone(),
            )?;
            let path = super::input_path(store.root(), &task.id);
            let prompt = task_prompt(&request, &retained, &task.record_dir)?;
            let inputs = super::Inputs {
                compile_manifest: Some(compile_manifest),
                pdf_selection: Some(retained),
                ..Default::default()
            };
            super::save(&path, &inputs)?;
            // Only the frontend explicitly starts this task after all inputs exist.
            store
                .complete_input_initialization(
                    &task.id,
                    ResearchTaskEdit {
                        title: task.title,
                        prompt,
                        runtime_id: task.runtime_id,
                        agent_id: task.agent_id,
                        model_id: task.model_id,
                        skill_ids: task.skill_ids,
                        dependency_ids: task.dependency_ids,
                        brief: Some(task.brief),
                        run_after,
                        keep_running_after_quit: task.keep_running_after_quit,
                    },
                )
                .map(|task| (&task).into())
        })();
        match initialized {
            Ok(task) => Ok(task),
            Err(error) => match rollback_input(&store, &task_id) {
                Ok(()) => Err(error),
                Err(cleanup) => Err(format!(
                    "{error}\nCould not finish initialization rollback: {cleanup}"
                )),
            },
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn task_selection(
    store: &TaskStore,
    task_id: &str,
) -> Result<Option<RetainedPdfSelection>, String> {
    let task = store.require(task_id)?;
    let bytes = match std::fs::read(super::input_path(store.root(), task_id)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let inputs: super::Inputs = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let Some(retained) = inputs.pdf_selection else {
        return Ok(None);
    };
    let annotation = store.annotation(&task.project_id, &retained.annotation_id)?;
    let input = annotation_input(&annotation, &task.project_id)?;
    if retained.input != input
        || annotation.target.task_id.as_deref() != Some(task_id)
        || annotation.parent_id.as_deref() != Some(retained.original_annotation_id.as_str())
        || retained.reference.generation != 0
        || retained.reference.pdf_sha256 != input.pdf_sha256
        || retained.reference.size != input.size
        || retained.reference.main_document != input.main_document
    {
        return Err("The retained PDF selection does not match this task's original input.".into());
    }
    compiled_artifacts::read_for_task(
        store.root(),
        task_id,
        task.execution_generation,
        &retained.reference,
    )?;
    Ok(Some(retained))
}

#[tauri::command]
pub async fn research_task_pdf_selection(
    state: State<'_, ResearchTaskState>,
    task_id: String,
) -> Result<Option<RetainedPdfSelection>, String> {
    let store = state.store()?;
    tauri::async_runtime::spawn_blocking(move || task_selection(&store, &task_id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsString, sync::Arc};

    use oleafly_research::{
        annotations::AnnotationHandlingDraft,
        model::{ResearchTaskStatus, TaskRunContext},
    };
    use serde_json::json;
    use tauri::Manager;

    use super::*;

    fn selection() -> PdfSelection {
        PdfSelection {
            document_identity: "displayed-compile-7".into(),
            text: "Original finding in the PDF".into(),
            pages: vec![PdfSelectionPage {
                page: 2,
                rects: vec![PdfSelectionRect {
                    x: 0.2,
                    y: 0.3,
                    width: 0.5,
                    height: 0.1,
                }],
            }],
            rotation: 90,
        }
    }

    fn input(bytes: &[u8]) -> PdfSelectionInput {
        PdfSelectionInput {
            project_id: "paper".into(),
            main_document: "main.tex".into(),
            checkpoint: Some(json!({
                "projectId": "paper", "mainDocument": "main.tex", "outputId": "old-output"
            })),
            selection: selection(),
            pdf_sha256: content_hash(bytes),
            size: bytes.len() as u64,
        }
    }

    fn root_annotation(store: &TaskStore, bytes: &[u8]) -> Annotation {
        let input = input(bytes);
        std::fs::create_dir_all(store.root().join("pdf-inputs")).unwrap();
        std::fs::write(pdf_path(store.root(), &input.pdf_sha256), bytes).unwrap();
        store
            .submit_task_annotation(&selection_draft(&input, "Original feedback".into()).unwrap())
            .unwrap()
    }

    #[test]
    fn selection_boundaries_validate_captured_coordinates_and_identity() {
        let input = input(b"%PDF-original");
        validate_input(&input).unwrap();
        let mut bad = input.clone();
        bad.main_document = "../main.tex".into();
        assert!(validate_input(&bad).is_err());
        let mut bad = input.clone();
        bad.checkpoint.as_mut().unwrap()["projectId"] = json!("other");
        assert!(validate_input(&bad).is_err());
        for page in [0, 2001] {
            let mut bad = input.clone();
            bad.selection.pages[0].page = page;
            assert!(validate_input(&bad).is_err());
        }
        for (x, width) in [(f64::NAN, 0.1), (-0.1, 0.1), (0.9, 0.2), (0.1, 0.0)] {
            let mut bad = input.clone();
            bad.selection.pages[0].rects[0].x = x;
            bad.selection.pages[0].rects[0].width = width;
            assert!(validate_input(&bad).is_err());
        }
        let mut bad = input.clone();
        bad.selection.rotation = 45;
        assert!(validate_input(&bad).is_err());
        let mut bad = input.clone();
        bad.selection.text = " ".into();
        assert!(validate_input(&bad).is_err());
        let mut bad = input.clone();
        bad.size = MAX_PDF_BYTES as u64 + 1;
        assert!(validate_input(&bad).is_err());
        let mut bad = input;
        bad.selection.text = "x".repeat(256 * 1024);
        assert!(selection_draft(&bad, "feedback".into())
            .unwrap_err()
            .contains("256 KiB"));
    }

    #[test]
    fn feedback_reopens_exact_original_bytes_and_rejects_changed_or_missing_evidence() {
        let root = tempfile::tempdir().unwrap();
        let store = TaskStore::new(root.path().into()).unwrap();
        let original = b"%PDF-original-visible-document";
        let annotation = root_annotation(&store, original);
        let (_, captured, bytes) = read_annotation(&store, "paper", &annotation.id).unwrap();
        assert_eq!(bytes, original);
        assert_eq!(captured.selection.rotation, 90);
        assert_eq!(captured.selection.pages[0].page, 2);
        assert!(annotation.target.task_id.is_none());
        assert!(!annotation.explicit_request);
        assert!(store.list("paper").unwrap().is_empty());
        assert!(store.queue_annotation_followups().unwrap().is_empty());
        assert!(store.claim_next().unwrap().is_none());
        assert_eq!(
            list_selections(&store, "paper").unwrap(),
            vec![annotation.clone()]
        );
        assert!(read_annotation(&store, "other", &annotation.id).is_err());

        let mut forged = annotation.clone();
        forged.source.as_mut().unwrap().content.push(' ');
        assert!(annotation_input(&forged, "paper")
            .unwrap_err()
            .contains("changed"));
        let mut forged = annotation.clone();
        forged.target.path = Some("other.tex".into());
        assert!(annotation_input(&forged, "paper").is_err());
        let mut forged = annotation.clone();
        forged.target.object_id = "another-object".into();
        assert!(annotation_input(&forged, "paper").is_err());

        // A mutable build output changing cannot replace the content-addressed source.
        std::fs::write(root.path().join("latest.pdf"), b"%PDF-new-compile").unwrap();
        assert_eq!(
            read_annotation(&store, "paper", &annotation.id).unwrap().2,
            original
        );
        std::fs::write(
            pdf_path(root.path(), &captured.pdf_sha256),
            b"%PDF-tampered",
        )
        .unwrap();
        assert!(read_annotation(&store, "paper", &annotation.id)
            .unwrap_err()
            .contains("SHA-256"));
        std::fs::remove_file(pdf_path(root.path(), &captured.pdf_sha256)).unwrap();
        assert!(read_annotation(&store, "paper", &annotation.id)
            .unwrap_err()
            .contains("unavailable"));
        assert_eq!(list_selections(&store, "paper").unwrap().len(), 1);

        let forged = store
            .add_annotation(&AnnotationDraft {
                source: Some(AnnotationSourceDraft {
                    kind: SOURCE_KIND.into(),
                    content: "{not valid JSON".into(),
                }),
                ..AnnotationDraft::new(
                    annotation.target,
                    AnnotationAuthor::model("test-model"),
                    "Claimed PDF selection",
                )
            })
            .unwrap();
        let error = list_selections(&store, "paper").unwrap_err();
        assert!(error.starts_with("Invalid retained PDF selection "));
        assert!(error.contains(&forged.id));
    }

    #[test]
    fn task_input_links_new_request_and_survives_original_and_workspace_changes() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let store = TaskStore::new(root.path().into()).unwrap();
        let original = b"%PDF-old-selected-document";
        let annotation = root_annotation(&store, original);
        let (_, input, bytes) = read_annotation(&store, "paper", &annotation.id).unwrap();
        let task = store
            .create(ResearchTaskDraft {
                project_id: "paper".into(),
                title: "Review old PDF".into(),
                prompt: "Check this again with the newer evidence".into(),
                runtime_id: "builtin".into(),
                agent_id: "test".into(),
                ..Default::default()
            })
            .unwrap();
        let retained = retain_for_task(
            &store,
            &task.id,
            &annotation,
            input,
            &bytes,
            task.prompt.clone(),
        )
        .unwrap();
        let child = store.annotation("paper", &retained.annotation_id).unwrap();
        assert_eq!(child.parent_id.as_deref(), Some(annotation.id.as_str()));
        assert_eq!(child.source, annotation.source);
        assert_eq!(child.body, task.prompt);
        assert!(child.explicit_request);
        assert_eq!(
            store.annotation("paper", &annotation.id).unwrap().body,
            "Original feedback"
        );
        assert_eq!(list_selections(&store, "paper").unwrap().len(), 1);
        assert!(store.queue_annotation_followups().unwrap().is_empty());
        assert!(store.claim_next().unwrap().is_none());
        let pending = store.annotation_deliveries("paper", &task.id).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].prepared_generation, None);

        super::super::save(
            &super::super::input_path(root.path(), &task.id),
            &super::super::Inputs {
                pdf_selection: Some(retained.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            task_selection(&store, &task.id).unwrap(),
            Some(retained.clone())
        );
        assert_eq!(
            super::super::main_document(root.path(), &task.id)
                .unwrap()
                .as_deref(),
            Some("main.tex")
        );
        std::fs::remove_file(pdf_path(root.path(), &retained.input.pdf_sha256)).unwrap();
        assert!(read_annotation(&store, "paper", &annotation.id).is_err());
        assert_eq!(
            task_selection(&store, &task.id).unwrap(),
            Some(retained.clone())
        );

        std::fs::write(workspace.path().join("main.tex"), "current source").unwrap();
        let context = TaskRunContext {
            task_id: task.id.clone(),
            execution_generation: 3,
            execution_root: workspace.path().to_string_lossy().into_owned(),
            record_dir: task.record_dir(),
            allowed_paths: vec!["main.tex".into(), "research".into()],
            ..Default::default()
        };
        super::super::prepare_in(root.path(), &context).unwrap();
        let metadata = workspace
            .path()
            .join(task.record_dir())
            .join("pdf-selection.json");
        let saved: RetainedPdfSelection =
            serde_json::from_slice(&std::fs::read(&metadata).unwrap()).unwrap();
        assert_eq!(saved, retained);
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("main.tex")).unwrap(),
            "current source"
        );
        std::fs::write(&metadata, "agent notes").unwrap();
        super::super::prepare_in(root.path(), &context).unwrap();
        assert_eq!(std::fs::read_to_string(&metadata).unwrap(), "agent notes");

        let prompt = task_prompt(&task.prompt, &retained, &task.record_dir()).unwrap();
        assert!(prompt.contains(&retained.annotation_id));
        assert!(prompt.contains("pdf-selection.json"));
        assert!(prompt.contains("\"generation\":0"));
        assert!(!prompt.contains(&retained.input.selection.text));
        std::fs::write(root.path().join(&retained.reference.path), b"%PDF-tampered").unwrap();
        assert!(task_selection(&store, &task.id)
            .unwrap_err()
            .contains("changed"));
    }

    struct RestoreDataDir(Option<OsString>);
    impl Drop for RestoreDataDir {
        fn drop(&mut self) {
            match &self.0 {
                Some(previous) => std::env::set_var("OLEAFLY_DATA_DIR", previous),
                None => std::env::remove_var("OLEAFLY_DATA_DIR"),
            }
        }
    }

    #[test]
    fn native_pdf_initialization_cleans_cancelled_or_deleted_tasks_before_and_after_retention() {
        let _guard = crate::paths::data_dir_env_lock();
        let temp = tempfile::tempdir().unwrap();
        let _restore = RestoreDataDir(std::env::var_os("OLEAFLY_DATA_DIR"));
        std::env::set_var("OLEAFLY_DATA_DIR", temp.path());
        let project = crate::paths::create_project_dir("paper").unwrap();
        std::fs::write(project.join("main.tex"), "current source").unwrap();
        let app = tauri::test::mock_builder()
            .manage(ResearchTaskState::for_test(temp.path().join("tasks"), 1))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.state::<ResearchTaskState>().attach(
            Arc::new(crate::research_tasks::host::AppResearchHost::detached()),
            tauri::async_runtime::handle().inner().clone(),
        );
        let store = app.state::<ResearchTaskState>().store().unwrap();
        let original = b"%PDF-retained-before-task";
        let annotation = root_annotation(&store, original);
        let (_, input, bytes) = read_annotation(&store, "paper", &annotation.id).unwrap();
        let draft = ResearchTaskDraft {
            project_id: "paper".into(),
            title: "Interrupted PDF review".into(),
            prompt: "Review this older selection".into(),
            runtime_id: "builtin".into(),
            agent_id: "fixture".into(),
            ..Default::default()
        };
        tauri::async_runtime::block_on(async {
            let state = || app.state::<ResearchTaskState>();
            for after_retention in [false, true] {
                for delete in [false, true] {
                    let task =
                        crate::research_tasks::create_task_pending_inputs(state(), draft.clone())
                            .await
                            .unwrap();
                    let mut retained = None;
                    if after_retention {
                        let saved = retain_for_task(
                            &store,
                            &task.id,
                            &annotation,
                            input.clone(),
                            &bytes,
                            draft.prompt.clone(),
                        )
                        .unwrap();
                        retained = Some(saved);
                    }
                    if delete {
                        crate::research_tasks::research_task_delete(state(), task.id.clone())
                            .await
                            .unwrap();
                        assert!(store.require(&task.id).is_err());
                    } else {
                        let cancelled =
                            crate::research_tasks::research_task_cancel(state(), task.id.clone())
                                .await
                                .unwrap();
                        assert_eq!(cancelled.status, ResearchTaskStatus::Cancelled);
                    }
                    if let Some(saved) = &retained {
                        // Initialization may continue writing Inputs after
                        // the task was cancelled or deleted.
                        super::super::save(
                            &super::super::input_path(store.root(), &task.id),
                            &super::super::Inputs {
                                pdf_selection: Some(saved.clone()),
                                ..Default::default()
                            },
                        )
                        .unwrap();
                    }
                    if !after_retention {
                        let result = retain_for_task(
                            &store,
                            &task.id,
                            &annotation,
                            input.clone(),
                            &bytes,
                            draft.prompt.clone(),
                        );
                        if delete {
                            // The immutable PDF is written before the child
                            // checks task existence; cleanup must still run.
                            assert!(result.is_err());
                            assert_eq!(
                                compiled_artifacts::list(store.root(), &task.id, 0)
                                    .unwrap()
                                    .len(),
                                1
                            );
                        } else {
                            let saved = result.unwrap();
                            super::super::save(
                                &super::super::input_path(store.root(), &task.id),
                                &super::super::Inputs {
                                    pdf_selection: Some(saved.clone()),
                                    ..Default::default()
                                },
                            )
                            .unwrap();
                            retained = Some(saved);
                        }
                    }
                    assert!(store
                        .complete_input_initialization(
                            &task.id,
                            ResearchTaskEdit {
                                title: task.title.clone(),
                                prompt: task.prompt.clone(),
                                runtime_id: task.runtime_id.clone(),
                                agent_id: task.agent_id.clone(),
                                model_id: task.model_id.clone(),
                                ..Default::default()
                            }
                        )
                        .is_err());
                    rollback_input(&store, &task.id).unwrap();
                    rollback_input(&store, &task.id).unwrap();
                    assert!(store.require(&task.id).is_err());
                    assert!(!super::super::input_path(store.root(), &task.id).exists());
                    assert!(!store
                        .root()
                        .join("compiled-artifacts")
                        .join(&task.id)
                        .exists());
                    if let Some(retained) = retained {
                        assert!(store.annotation("paper", &retained.annotation_id).is_err());
                    }
                    let connection =
                        rusqlite::Connection::open(store.root().join("tasks.sqlite3")).unwrap();
                    let work: u64 = connection
                        .query_row(
                            "SELECT COUNT(*) FROM research_task_annotation_work WHERE task_id = ?1",
                            [&task.id],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert_eq!(work, 0);
                    assert_eq!(
                        store.annotation("paper", &annotation.id).unwrap(),
                        annotation
                    );
                    assert_eq!(
                        read_annotation(&store, "paper", &annotation.id).unwrap().2,
                        original
                    );
                    assert_eq!(state().active_count(), 0);
                }
            }
        });
    }

    #[test]
    fn pdf_initialization_rollback_preserves_executed_and_retained_history() {
        let root = tempfile::tempdir().unwrap();
        let store = TaskStore::new(root.path().into()).unwrap();
        let original = b"%PDF-executed-task-input";
        let annotation = root_annotation(&store, original);
        let (_, input, bytes) = read_annotation(&store, "paper", &annotation.id).unwrap();
        let task = store
            .create_pending_inputs(ResearchTaskDraft {
                project_id: "paper".into(),
                title: "Executed PDF task".into(),
                prompt: "Inspect PDF".into(),
                runtime_id: "builtin".into(),
                agent_id: "fixture".into(),
                ..Default::default()
            })
            .unwrap();
        let retained = retain_for_task(
            &store,
            &task.id,
            &annotation,
            input,
            &bytes,
            task.prompt.clone(),
        )
        .unwrap();
        let path = super::super::input_path(store.root(), &task.id);
        super::super::save(
            &path,
            &super::super::Inputs {
                pdf_selection: Some(retained.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        store
            .complete_input_initialization(
                &task.id,
                ResearchTaskEdit {
                    title: task.title.clone(),
                    prompt: task.prompt.clone(),
                    runtime_id: task.runtime_id.clone(),
                    agent_id: task.agent_id.clone(),
                    model_id: task.model_id.clone(),
                    ..Default::default()
                },
            )
            .unwrap();
        store.request_start(&task.id).unwrap();
        let running = store.claim_next().unwrap().unwrap();
        store
            .pending_task_annotations(&task.id, running.execution_generation, true)
            .unwrap();
        let later = store
            .root()
            .join("compiled-artifacts")
            .join(&task.id)
            .join("1");
        std::fs::create_dir(&later).unwrap();
        std::fs::write(later.join("retained-output.pdf"), b"%PDF-real-run-output").unwrap();
        assert!(rollback_input(&store, &task.id).is_err());
        assert!(path.exists());
        assert!(root.path().join(&retained.reference.path).exists());
        assert!(later.join("retained-output.pdf").exists());
        store
            .record_annotation_handling(
                "paper",
                &AnnotationHandlingDraft {
                    annotation_id: retained.annotation_id.clone(),
                    author: AnnotationAuthor::user("user"),
                    summary: "Verified result".into(),
                    result_refs: vec![],
                },
            )
            .unwrap();
        store
            .finish_failure(&task.id, running.execution_generation, "Stopped")
            .unwrap();
        store.delete(&task.id).unwrap();
        assert!(rollback_input(&store, &task.id)
            .unwrap_err()
            .contains("history"));
        assert!(path.exists());
        assert!(root.path().join(&retained.reference.path).exists());
        assert!(later.join("retained-output.pdf").exists());
        assert!(store.annotation("paper", &retained.annotation_id).is_ok());
        assert_eq!(
            read_annotation(&store, "paper", &annotation.id).unwrap().2,
            original
        );
    }

    #[test]
    fn native_commands_save_without_launch_and_create_only_on_explicit_review() {
        let _guard = crate::paths::data_dir_env_lock();
        let temp = tempfile::tempdir().unwrap();
        let _restore = RestoreDataDir(std::env::var_os("OLEAFLY_DATA_DIR"));
        std::env::set_var("OLEAFLY_DATA_DIR", temp.path());
        let project = crate::paths::create_project_dir("paper").unwrap();
        std::fs::write(project.join("main.tex"), "current source").unwrap();
        let app = tauri::test::mock_builder()
            .manage(ResearchTaskState::for_test(temp.path().join("tasks"), 1))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.state::<ResearchTaskState>().attach(
            Arc::new(crate::research_tasks::host::AppResearchHost::detached()),
            tauri::async_runtime::handle().inner().clone(),
        );
        let pdf = b"%PDF-original-input";
        tauri::async_runtime::block_on(async {
            let state = || app.state::<ResearchTaskState>();
            state().set_enabled(false);
            let annotation = research_pdf_selection_save(
                state(),
                "paper".into(),
                "main.tex".into(),
                None,
                selection(),
                STANDARD.encode(pdf),
                content_hash(pdf),
                "Original comment".into(),
            )
            .await
            .unwrap();
            assert_eq!(state().active_count(), 0);
            assert!(state().store().unwrap().list("paper").unwrap().is_empty());
            assert_eq!(
                research_pdf_selections(state(), "paper".into())
                    .await
                    .unwrap()
                    .len(),
                1
            );
            research_pdf_selection_read(state(), "paper".into(), annotation.id.clone())
                .await
                .unwrap();
            let draft = ResearchTaskDraft {
                project_id: "paper".into(),
                title: "Review captured PDF".into(),
                prompt: "New request against the older PDF".into(),
                runtime_id: "builtin".into(),
                agent_id: "fixture".into(),
                ..Default::default()
            };
            assert!(research_task_create_from_pdf_selection(
                state(),
                draft.clone(),
                annotation.id.clone()
            )
            .await
            .unwrap_err()
            .contains("turned off"));
            state().set_enabled(true);
            // A process exit before any PDF metadata was saved leaves a
            // durable queued record that cannot become a source-less task.
            let incomplete =
                crate::research_tasks::create_task_pending_inputs(state(), draft.clone())
                    .await
                    .unwrap();
            assert!(incomplete
                .error
                .as_deref()
                .unwrap()
                .contains("original application selection"));
            let store = state().store().unwrap();
            assert!(!super::super::input_path(store.root(), &incomplete.id).exists());
            assert!(store
                .request_start(&incomplete.id)
                .unwrap_err()
                .contains("not fully prepared"));
            rollback_input(&store, &incomplete.id).unwrap();
            let mut failing = draft.clone();
            // Valid at create, then the retained-input instructions make the
            // final edit exceed the task prompt contract after child/save.
            failing.prompt = "x".repeat(32_000);
            let error =
                research_task_create_from_pdf_selection(state(), failing, annotation.id.clone())
                    .await
                    .unwrap_err();
            assert_eq!(error, "Task prompt is too long.");
            let store = state().store().unwrap();
            assert!(store.list("paper").unwrap().is_empty());
            assert_eq!(
                store
                    .list_annotations(&AnnotationQuery::project("paper"))
                    .unwrap()
                    .len(),
                1
            );
            assert!(std::fs::read_dir(store.root().join("compiled-artifacts"))
                .unwrap()
                .next()
                .is_none());
            assert!(std::fs::read_dir(store.root().join("task-inputs"))
                .unwrap()
                .next()
                .is_none());
            assert_eq!(
                read_annotation(&store, "paper", &annotation.id).unwrap().2,
                pdf
            );

            let task =
                research_task_create_from_pdf_selection(state(), draft, annotation.id.clone())
                    .await
                    .unwrap();
            assert!(!task.start_requested);
            assert_eq!(task.execution_generation, 0);
            assert_eq!(task.error, None);
            let store = state().store().unwrap();
            assert!(store.queue_annotation_followups().unwrap().is_empty());
            assert!(store.claim_next().unwrap().is_none());
            let retained = research_task_pdf_selection(state(), task.id.clone())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(retained.original_annotation_id, annotation.id);
            assert_eq!(retained.reference.generation, 0);
            assert_eq!(
                store
                    .annotation("paper", &retained.annotation_id)
                    .unwrap()
                    .body,
                "New request against the older PDF"
            );
            assert_eq!(
                super::super::compile_manifest(store.root(), &task.id)
                    .unwrap()
                    .unwrap()
                    .main_doc,
                "main.tex"
            );
            assert_eq!(
                std::fs::read_to_string(project.join("main.tex")).unwrap(),
                "current source"
            );
            assert_eq!(state().active_count(), 0);
            // Successful initialization released the marker, while model
            // execution still requires the separate start command.
            store.request_start(&task.id).unwrap();
        });
    }
}
