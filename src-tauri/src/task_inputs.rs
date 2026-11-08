//! Captured application inputs, retained beside the task store rather than in agent workspaces.
use oleafly_research::{
    model::{ResearchTaskDraft, ResearchTaskView, TaskRunContext},
    observations::content_hash,
    task_tools::TaskFiles,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Component, Path};
use tauri::{Manager, State};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub from: usize,
    pub to: usize,
    pub text: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantDelegation {
    pub project_id: String,
    pub main_document: String,
    pub path: String,
    pub selection: Selection,
    pub source_content: String,
    pub source_sha256: String,
    pub disk_sha256: String,
    pub editor_doc_version: u64,
    pub runtime_id: String,
    pub agent_id: String,
    pub model_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalInput {
    pub library_root: String,
    pub world_version_id: String,
    pub check_id: Option<String>,
    pub baseline_id: String,
    pub snapshot: Value,
    pub snapshot_sha256: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inputs {
    delegation: Option<AssistantDelegation>,
    journal_input: Option<JournalInput>,
    #[serde(default)]
    compile_manifest: Option<oleafly_core::ProjectManifest>,
    #[serde(default)]
    prepared_workspaces: Vec<String>,
}
fn relative(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.contains('\\')
        || path.contains(':')
        || path.contains('\0')
        || !Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err("Task input paths must be project-relative files.".into());
    }
    Ok(())
}
fn normalized(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}
fn hash(text: &str) -> String {
    content_hash(normalized(text).as_bytes())
}
fn validate(draft: &ResearchTaskDraft, input: &AssistantDelegation) -> Result<(), String> {
    relative(&input.path)?;
    relative(&input.main_document)?;
    if input.project_id != draft.project_id
        || input.runtime_id != draft.runtime_id
        || input.agent_id != draft.agent_id
        || input.model_id != draft.model_id
        || !matches!(input.runtime_id.as_str(), "builtin" | "acp")
    {
        return Err("Delegation project and agent must match the task.".into());
    }
    if hash(&input.source_content) != input.source_sha256 {
        return Err("Delegation source hash does not match the editor buffer.".into());
    }
    validate_selection(&input.source_content, &input.selection)?;
    let root = crate::paths::project_dir(&draft.project_id)?;
    let files = TaskFiles::open(&root, std::slice::from_ref(&input.path))?;
    let current = hash(&files.read(&input.path)?);
    if current != input.disk_sha256 && current != input.source_sha256 {
        return Err("Delegation disk source changed before task creation.".into());
    }
    Ok(())
}
fn validate_selection(content: &str, selection: &Selection) -> Result<(), String> {
    let utf16: Vec<u16> = content.encode_utf16().collect();
    let selected = utf16
        .get(selection.from..selection.to)
        .and_then(|slice| String::from_utf16(slice).ok());
    if selected.as_deref() != Some(selection.text.as_str()) {
        return Err("Delegation selection does not match its UTF-16 editor range.".into());
    }
    Ok(())
}
fn input_path(root: &Path, id: &str) -> std::path::PathBuf {
    root.join("task-inputs").join(format!("{id}.json"))
}
pub(crate) fn main_document(tasks_root: &Path, task_id: &str) -> Result<Option<String>, String> {
    let bytes = match std::fs::read(input_path(tasks_root, task_id)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let inputs: Inputs = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    Ok(inputs.delegation.map(|delegation| delegation.main_document))
}
pub(crate) fn compile_manifest(
    tasks_root: &Path,
    task_id: &str,
) -> Result<Option<oleafly_core::ProjectManifest>, String> {
    let bytes = match std::fs::read(input_path(tasks_root, task_id)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let inputs: Inputs = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    Ok(inputs.compile_manifest)
}
fn save(path: &Path, inputs: &Inputs) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().expect("task inputs directory"))
        .map_err(|e| e.to_string())?;
    crate::sandbox::atomic_write(
        path,
        &serde_json::to_vec_pretty(inputs).map_err(|e| e.to_string())?,
    )
}
#[tauri::command]
pub async fn research_task_create_with_inputs(
    state: State<'_, crate::research_tasks::ResearchTaskState>,
    draft: ResearchTaskDraft,
    delegation: Option<AssistantDelegation>,
    journal_input: Option<JournalInput>,
) -> Result<ResearchTaskView, String> {
    if let Some(input) = &delegation {
        validate(&draft, input)?;
    }
    if let Some(input) = &journal_input {
        if content_hash(&serde_json::to_vec(&input.snapshot).map_err(|e| e.to_string())?)
            != input.snapshot_sha256
        {
            return Err("Journal snapshot hash mismatch.".into());
        }
    }
    let mut compile_manifest: oleafly_core::ProjectManifest = serde_json::from_value(
        serde_json::to_value(crate::project::read_meta(&draft.project_id)?)
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if let Some(input) = &delegation {
        compile_manifest.main_doc.clone_from(&input.main_document);
    }
    compile_manifest.validate().map_err(|e| e.to_string())?;
    let store = state.store()?;
    let task = crate::research_tasks::research_task_create(state, draft).await?;
    save(
        &input_path(store.root(), &task.id),
        &Inputs {
            delegation,
            journal_input,
            compile_manifest: Some(compile_manifest),
            prepared_workspaces: vec![],
        },
    )?;
    Ok(task)
}

pub(crate) fn prepare(app: &tauri::AppHandle, context: &TaskRunContext) -> Result<(), String> {
    let state = app.state::<crate::research_tasks::ResearchTaskState>();
    let store = state.store()?;
    prepare_in(store.root(), context)
}

fn prepare_in(root: &Path, context: &TaskRunContext) -> Result<(), String> {
    let path = input_path(root, &context.task_id);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    let mut inputs: Inputs = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let files = TaskFiles::open(Path::new(&context.execution_root), &context.allowed_paths)?;
    let workspace = files
        .root
        .to_str()
        .ok_or("The task workspace path is not Unicode.")?
        .to_string();
    if inputs.prepared_workspaces.contains(&workspace) {
        return Ok(());
    }
    if let Some(input) = &inputs.delegation {
        let baseline = hash(&files.read(&input.path)?);
        if baseline != input.disk_sha256 && baseline != input.source_sha256 {
            return Err("Task baseline differs from the captured delegation source.".into());
        }
        files.write(&input.path, &input.source_content)?;
        files.write(
            &format!("{}/delegation.json", context.record_dir),
            &serde_json::to_string_pretty(input).map_err(|e| e.to_string())?,
        )?;
    }
    if let Some(input) = &inputs.journal_input {
        if content_hash(&serde_json::to_vec(&input.snapshot).map_err(|e| e.to_string())?)
            != input.snapshot_sha256
        {
            return Err("Retained journal snapshot hash mismatch.".into());
        }
        files.write(
            &format!("{}/journal-context.json", context.record_dir),
            &serde_json::to_string_pretty(input).map_err(|e| e.to_string())?,
        )?;
    }
    inputs.prepared_workspaces.push(workspace);
    save(&path, &inputs)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disk_hash_normalizes_line_endings() {
        assert_eq!(hash("one\r\ntwo\rthree"), hash("one\ntwo\nthree"));
    }
    #[test]
    fn relative_paths_reject_escapes() {
        for path in [
            "",
            "../paper.tex",
            "/paper.tex",
            "C:/paper.tex",
            "a\\paper.tex",
        ] {
            assert!(relative(path).is_err(), "{path}");
        }
        assert!(relative("sections/methods.tex").is_ok());
    }
    #[test]
    fn captured_selection_uses_utf16_offsets() {
        let selection = Selection {
            from: 1,
            to: 3,
            text: "😀".into(),
        };
        assert!(validate_selection("a😀b", &selection).is_ok());
        assert!(validate_selection(
            "a😀b",
            &Selection {
                to: 2,
                ..selection.clone()
            }
        )
        .is_err());
        assert!(validate_selection(
            "a😀b",
            &Selection {
                text: "b".into(),
                ..selection.clone()
            }
        )
        .is_err());
        assert!(validate_selection(
            "a😀b",
            &Selection {
                from: 3,
                to: 1,
                ..selection
            }
        )
        .is_err());
    }
    #[test]
    fn prepare_retains_buffer_and_does_not_overwrite_agent_edits() {
        let store = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        std::fs::write(work.path().join("paper.tex"), "disk\r\n").unwrap();
        let context = TaskRunContext {
            task_id: "task-one".into(),
            execution_generation: 1,
            execution_root: work.path().to_string_lossy().into_owned(),
            record_dir: "records/task-one".into(),
            allowed_paths: vec!["paper.tex".into(), "records".into()],
            ..Default::default()
        };
        let delegation = AssistantDelegation {
            project_id: "paper".into(),
            main_document: "paper.tex".into(),
            path: "paper.tex".into(),
            selection: Selection {
                from: 0,
                to: 6,
                text: "buffer".into(),
            },
            source_content: "buffer".into(),
            source_sha256: hash("buffer"),
            disk_sha256: hash("disk\n"),
            editor_doc_version: 1,
            runtime_id: "builtin".into(),
            agent_id: "openai".into(),
            model_id: "model".into(),
        };
        save(
            &input_path(store.path(), "task-one"),
            &Inputs {
                delegation: Some(delegation),
                compile_manifest: Some(oleafly_core::ProjectManifest {
                    main_doc: "paper.tex".into(),
                    engine: "latexmk".into(),
                    tex_flavor: Some("xelatex".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .unwrap();
        prepare_in(store.path(), &context).unwrap();
        assert!(!work.path().join("project.json").exists());
        let manifest = compile_manifest(store.path(), "task-one").unwrap().unwrap();
        assert_eq!(manifest.main_doc, "paper.tex");
        assert_eq!(manifest.engine, "latexmk");
        assert_eq!(manifest.tex_flavor.as_deref(), Some("xelatex"));
        let workspace = oleafly_core::Workspace::from_manifest(work.path(), manifest).unwrap();
        assert_eq!(workspace.manifest().main_doc, "paper.tex");
        assert_eq!(workspace.manifest().engine, "latexmk");
        assert!(!work.path().join("project.json").exists());
        assert_eq!(
            std::fs::read_to_string(work.path().join("paper.tex")).unwrap(),
            "buffer"
        );
        assert!(work
            .path()
            .join("records/task-one/delegation.json")
            .is_file());
        std::fs::write(work.path().join("paper.tex"), "agent edit").unwrap();
        prepare_in(store.path(), &context).unwrap();
        assert_eq!(
            std::fs::read_to_string(work.path().join("paper.tex")).unwrap(),
            "agent edit"
        );
        let next = TaskRunContext {
            execution_generation: 2,
            ..context
        };
        prepare_in(store.path(), &next).unwrap();
        assert_eq!(
            std::fs::read_to_string(work.path().join("paper.tex")).unwrap(),
            "agent edit"
        );
        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join("paper.tex"), "unrelated baseline").unwrap();
        let other_context = TaskRunContext {
            execution_root: other.path().to_string_lossy().into_owned(),
            ..next
        };
        assert!(prepare_in(store.path(), &other_context)
            .unwrap_err()
            .contains("baseline"));
    }
    #[test]
    fn journal_inputs_remain_bound_to_each_task() {
        let store = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        for (task, world) in [("t1", "w1"), ("t2", "w2")] {
            let snapshot = serde_json::json!({"world": {"id": world}, "review": {}, "check": null, "baseline": {"id": "baseline"}});
            let input = JournalInput {
                library_root: "/selected/library".into(),
                world_version_id: world.into(),
                check_id: None,
                baseline_id: "baseline".into(),
                snapshot_sha256: content_hash(&serde_json::to_vec(&snapshot).unwrap()),
                snapshot,
            };
            save(
                &input_path(store.path(), task),
                &Inputs {
                    journal_input: Some(input),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let context = TaskRunContext {
            task_id: "t1".into(),
            execution_generation: 3,
            execution_root: work.path().to_string_lossy().into_owned(),
            record_dir: "records/t1".into(),
            allowed_paths: vec!["records".into()],
            ..Default::default()
        };
        prepare_in(store.path(), &context).unwrap();
        let retained: JournalInput = serde_json::from_slice(
            &std::fs::read(work.path().join("records/t1/journal-context.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(retained.world_version_id, "w1");
        assert_eq!(retained.snapshot["world"]["id"], "w1");
        assert_eq!(retained.library_root, "/selected/library");
    }
}
