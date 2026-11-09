//! Journal object feedback and explicit continuation share the existing annotation store.
use std::path::Path;

use oleafly_research::{
    annotations::{
        Annotation, AnnotationAuthor, AnnotationDraft, AnnotationSourceDraft, AnnotationTarget,
    },
    model::{ResearchTaskDraft, ResearchTaskStatus, ResearchTaskView},
    observations::content_hash,
    scheduler::ResearchTaskState,
    store::TaskStore,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use super::{request, JournalWorkbenchState, Session};

const SOURCE_KIND: &str = "journal_object";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JournalObjectReference {
    pub library_root: String,
    pub workbench_project_id: String,
    pub kind: JournalObjectKind,
    pub object_id: String,
    pub world_version_id: String,
    pub check_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum JournalObjectKind {
    Rule,
    Source,
    Check,
    World,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObjectIdentity<'a> {
    library_root: &'a str,
    manuscript_id: &'a str,
    id: &'a str,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetainedObject {
    pub reference: JournalObjectReference,
    pub object: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JournalAnnotationObject {
    reference: JournalObjectReference,
    target: AnnotationTarget,
    source: AnnotationSourceDraft,
    related_tasks: Vec<ResearchTaskView>,
    continuation_task_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JournalAnnotationRequest {
    annotation: Annotation,
    task: ResearchTaskView,
    created: bool,
    needs_start: bool,
}

pub(crate) fn object_target(
    project_id: &str,
    reference: &JournalObjectReference,
) -> Result<AnnotationTarget, String> {
    if reference.library_root.is_empty()
        || reference.workbench_project_id.is_empty()
        || reference.object_id.is_empty()
        || reference.world_version_id.is_empty()
    {
        return Err("Select a retained journal object and its manuscript.".into());
    }
    let (kind, revision) = match reference.kind {
        JournalObjectKind::Rule => ("journal_rule", reference.world_version_id.clone()),
        JournalObjectKind::Source => ("journal_source", reference.world_version_id.clone()),
        JournalObjectKind::World => ("journal_world", reference.world_version_id.clone()),
        JournalObjectKind::Check => {
            if reference.check_id.as_deref() != Some(reference.object_id.as_str()) {
                return Err("Select the check's exact retained identity.".into());
            }
            ("journal_check", reference.object_id.clone())
        }
    };
    let id = serde_json::to_string(&ObjectIdentity {
        library_root: &reference.library_root,
        manuscript_id: &reference.workbench_project_id,
        id: &reference.object_id,
    })
    .map_err(|error| error.to_string())?;
    Ok(AnnotationTarget::new(project_id, kind, id).revision(revision))
}

fn canonical_root(root: &str) -> Result<String, String> {
    Path::new(root)
        .canonicalize()
        .map_err(|error| format!("The Workbench library is unavailable: {error}"))?
        .into_os_string()
        .into_string()
        .map_err(|_| "The Workbench library path is not Unicode.".into())
}

fn query(path: &str, fields: &[(&str, &str)]) -> Result<String, String> {
    let url = reqwest::Url::parse_with_params("http://127.0.0.1/", fields)
        .map_err(|error| error.to_string())?;
    Ok(format!("{path}?{}", url.query().unwrap_or_default()))
}

async fn validate_reference(
    session: &Session,
    mut reference: JournalObjectReference,
) -> Result<JournalObjectReference, String> {
    let connected = canonical_root(&session.library_root.to_string_lossy())?;
    if canonical_root(&reference.library_root)? != connected {
        return Err("This object belongs to another Workbench library.".into());
    }
    reference.library_root = connected;
    let state = request(session, "/api/state", None).await?;
    if !state["projects"].as_array().is_some_and(|rows| {
        rows.iter()
            .any(|row| row["project_id"] == reference.workbench_project_id)
    }) {
        return Err("This manuscript is not in the connected Workbench library.".into());
    }
    Ok(reference)
}

async fn read_object(
    session: &Session,
    reference: &JournalObjectReference,
) -> Result<Value, String> {
    match reference.kind {
        JournalObjectKind::Check => {
            let mut check = request(
                session,
                &query("/api/check", &[("check_id", &reference.object_id)])?,
                None,
            )
            .await?;
            if check["project_id"] != reference.workbench_project_id
                || check["world_version_id"] != reference.world_version_id
                || reference.check_id.as_deref() != Some(reference.object_id.as_str())
            {
                return Err(
                    "The selected check does not belong to this manuscript and world version."
                        .into(),
                );
            }
            // These fields are current projections, not bytes of the immutable check.
            for field in [
                "world",
                "validity",
                "stale_reasons",
                "update_available",
                "dispositions",
            ] {
                check
                    .as_object_mut()
                    .ok_or("Invalid Workbench check.")?
                    .remove(field);
            }
            Ok(check)
        }
        JournalObjectKind::Source => {
            let review = request(
                session,
                &query(
                    "/api/review",
                    &[("version_id", &reference.world_version_id)],
                )?,
                None,
            )
            .await?;
            review["fragments"]
                .as_array()
                .and_then(|rows| {
                    rows.iter()
                        .find(|row| row["fragment_id"] == reference.object_id)
                })
                .cloned()
                .ok_or("This source fragment is not in the retained world version.".into())
        }
        JournalObjectKind::Rule | JournalObjectKind::World => {
            let world = request(
                session,
                &query("/api/world", &[("version_id", &reference.world_version_id)])?,
                None,
            )
            .await?;
            if reference.kind == JournalObjectKind::World {
                if world["journal_id"] != reference.object_id {
                    return Err("This journal identity does not match the retained world.".into());
                }
                return Ok(world);
            }
            world["rules"]
                .as_array()
                .and_then(|rows| {
                    rows.iter()
                        .find(|row| row["rule_id"] == reference.object_id)
                })
                .cloned()
                .ok_or("This rule is not in the retained world version.".into())
        }
    }
}

pub(crate) async fn capture_object(
    session: &Session,
    reference: JournalObjectReference,
) -> Result<RetainedObject, String> {
    let reference = validate_reference(session, reference).await?;
    let object = read_object(session, &reference).await?;
    Ok(RetainedObject { reference, object })
}

fn source_for(retained: &RetainedObject) -> Result<AnnotationSourceDraft, String> {
    let content = serde_json::to_string(retained).map_err(|error| error.to_string())?;
    if content.len() > 256 * 1024 {
        return Err("This journal object exceeds the 256 KiB annotation source limit.".into());
    }
    Ok(AnnotationSourceDraft {
        kind: SOURCE_KIND.into(),
        content,
    })
}

fn retained_parent(
    store: &TaskStore,
    project_id: &str,
    reference: &JournalObjectReference,
    parent_id: &str,
) -> Result<(Annotation, RetainedObject), String> {
    let parent = store.annotation(project_id, parent_id)?;
    let mut source_annotation = parent.clone();
    while source_annotation.source.is_none() {
        let ancestor = source_annotation
            .parent_id
            .as_deref()
            .ok_or("The historical journal annotation has no retained object source.")?;
        source_annotation = store.annotation(project_id, ancestor)?;
    }
    let source = source_annotation
        .source
        .as_ref()
        .filter(|source| source.kind == SOURCE_KIND)
        .ok_or("The historical journal annotation has no retained object source.")?;
    if content_hash(source.content.as_bytes()) != source.sha256 {
        return Err("The historical journal source no longer matches its SHA-256.".into());
    }
    let retained: RetainedObject =
        serde_json::from_str(&source.content).map_err(|error| error.to_string())?;
    let target = object_target(project_id, &retained.reference)?;
    let requested = object_target(project_id, reference)?;
    if parent.target.object_kind != target.object_kind
        || parent.target.object_id != target.object_id
        || parent.target.object_revision != target.object_revision
        || target.object_kind != requested.object_kind
        || target.object_id != requested.object_id
    {
        return Err(
            "The reply must retain the original journal object's identity and version.".into(),
        );
    }
    Ok((parent, retained))
}

fn discussion_task(
    store: &TaskStore,
    project_id: &str,
    parent: &Annotation,
) -> Result<Option<String>, String> {
    let mut annotation = parent.clone();
    loop {
        if annotation.target.task_id.is_some() {
            return Ok(annotation.target.task_id);
        }
        let Some(parent_id) = annotation.parent_id else {
            return Ok(None);
        };
        annotation = store.annotation(project_id, &parent_id)?;
    }
}

pub(crate) fn related_tasks(
    store: &TaskStore,
    project_id: &str,
    reference: &JournalObjectReference,
) -> Result<Vec<ResearchTaskView>, String> {
    let mut related = Vec::new();
    for task in store
        .all_tasks()?
        .into_iter()
        .filter(|task| task.project_id == project_id)
    {
        let Some(input) = crate::task_inputs::journal_input(store.root(), &task.id)? else {
            continue;
        };
        let manuscript = input
            .manuscript_id
            .as_deref()
            .or_else(|| input.snapshot["baseline"]["project"]["project_id"].as_str());
        if manuscript == Some(reference.workbench_project_id.as_str())
            && input.world_version_id == reference.world_version_id
            && (reference.kind != JournalObjectKind::Check || input.check_id == reference.check_id)
            && (input.library_root == reference.library_root
                || canonical_root(&input.library_root)? == reference.library_root)
        {
            related.push((&task).into());
        }
    }
    Ok(related)
}

async fn capture(
    state: &JournalWorkbenchState,
    store: &TaskStore,
    project_id: &str,
    reference: JournalObjectReference,
    parent_id: Option<&str>,
) -> Result<RetainedObject, String> {
    crate::paths::validate_project_id(project_id)?;
    if let Some(parent_id) = parent_id {
        // Retained discussion sources remain readable without a live service.
        return retained_parent(store, project_id, &reference, parent_id)
            .map(|(_, retained)| retained);
    }
    let current = state.0.lock().await;
    let session = current.as_ref().ok_or("Connect Workbench first.")?;
    capture_object(session, reference).await
}

#[tauri::command]
pub(crate) async fn journal_annotation_object(
    state: State<'_, JournalWorkbenchState>,
    tasks: State<'_, ResearchTaskState>,
    project_id: String,
    reference: JournalObjectReference,
    annotation_id: Option<String>,
) -> Result<JournalAnnotationObject, String> {
    let store = tasks.store()?;
    let retained = capture(
        &state,
        &store,
        &project_id,
        reference,
        annotation_id.as_deref(),
    )
    .await?;
    let target = object_target(&project_id, &retained.reference)?;
    let source = source_for(&retained)?;
    let related_tasks = related_tasks(&store, &project_id, &retained.reference)?;
    let continuation_task_id = annotation_id
        .as_deref()
        .map(|id| discussion_task(&store, &project_id, &store.annotation(&project_id, id)?))
        .transpose()?
        .flatten();
    Ok(JournalAnnotationObject {
        reference: retained.reference,
        target,
        source,
        related_tasks,
        continuation_task_id,
    })
}

#[tauri::command]
pub(crate) async fn journal_annotation_save(
    state: State<'_, JournalWorkbenchState>,
    tasks: State<'_, ResearchTaskState>,
    project_id: String,
    reference: JournalObjectReference,
    body: String,
    parent_id: Option<String>,
    mentions: Option<Vec<String>>,
) -> Result<Annotation, String> {
    let store = tasks.store()?;
    let retained = capture(&state, &store, &project_id, reference, parent_id.as_deref()).await?;
    let mut annotation = AnnotationDraft::new(
        object_target(&project_id, &retained.reference)?,
        AnnotationAuthor::user("user"),
        body,
    );
    annotation.parent_id = parent_id;
    annotation.mentions = mentions.unwrap_or_default();
    annotation.source = Some(source_for(&retained)?);
    // Feedback has no task identity or work request, even when tasks are enabled.
    store.add_annotation(&annotation)
}

async fn journal_input(
    state: &JournalWorkbenchState,
    reference: &JournalObjectReference,
) -> Result<crate::task_inputs::JournalInput, String> {
    let current = state.0.lock().await;
    let session = current.as_ref().ok_or("Connect Workbench first.")?;
    let reference = validate_reference(session, reference.clone()).await?;
    let world = request(
        session,
        &query("/api/world", &[("version_id", &reference.world_version_id)])?,
        None,
    )
    .await?;
    let review = request(
        session,
        &query(
            "/api/review",
            &[("version_id", &reference.world_version_id)],
        )?,
        None,
    )
    .await?;
    let check = if let Some(check_id) = &reference.check_id {
        let check = request(
            session,
            &query("/api/check", &[("check_id", check_id)])?,
            None,
        )
        .await?;
        if check["project_id"] != reference.workbench_project_id
            || check["world_version_id"] != reference.world_version_id
        {
            return Err("The check does not belong to this historical journal context.".into());
        }
        Some(check)
    } else {
        None
    };
    let state = request(session, "/api/state", None).await?;
    let project = state["projects"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["project_id"] == reference.workbench_project_id)
        })
        .ok_or("The manuscript is unavailable.")?;
    let baseline_id = check
        .as_ref()
        .and_then(|record| record["baseline_id"].as_str())
        .or_else(|| project["baseline_id"].as_str())
        .ok_or("The manuscript baseline is unavailable.")?
        .to_string();
    let baseline = request(
        session,
        &query(
            "/api/manuscript",
            &[
                ("project_id", &reference.workbench_project_id),
                ("baseline_id", &baseline_id),
            ],
        )?,
        None,
    )
    .await?;
    let snapshot = json!({"world": world, "review": review, "check": check, "baseline": baseline});
    Ok(crate::task_inputs::JournalInput {
        library_root: reference.library_root,
        manuscript_id: Some(reference.workbench_project_id),
        world_version_id: reference.world_version_id,
        check_id: reference.check_id,
        baseline_id,
        snapshot_sha256: content_hash(
            &serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?,
        ),
        snapshot,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn journal_annotation_request(
    state: State<'_, JournalWorkbenchState>,
    tasks: State<'_, ResearchTaskState>,
    project_id: String,
    reference: JournalObjectReference,
    body: String,
    parent_id: String,
    mentions: Vec<String>,
    task_id: Option<String>,
    draft: Option<ResearchTaskDraft>,
) -> Result<JournalAnnotationRequest, String> {
    if !tasks.enabled() {
        return Err(crate::research_tasks::TASKS_OFF.into());
    }
    let store = tasks.store()?;
    let retained = capture(&state, &store, &project_id, reference, Some(&parent_id)).await?;
    let (parent, _) = retained_parent(&store, &project_id, &retained.reference, &parent_id)?;
    let related = related_tasks(&store, &project_id, &retained.reference)?;
    let selected_id = discussion_task(&store, &project_id, &parent)?.or(task_id);
    let mut annotation = AnnotationDraft::new(
        object_target(&project_id, &retained.reference)?,
        AnnotationAuthor::user("user"),
        body,
    )
    .reply_to(parent_id)
    .request();
    annotation.source = Some(source_for(&retained)?);
    annotation.mentions = mentions;
    if let Some(task_id) = selected_id {
        let task = related
            .into_iter()
            .find(|task| task.id == task_id)
            .ok_or("Choose a task associated with this exact historical journal object.")?;
        annotation.target.task_id = Some(task.id.clone());
        let annotation = tasks.submit_annotation(annotation)?;
        let current_task = store.require(&task.id)?;
        let needs_start = current_task.status == ResearchTaskStatus::Queued
            && !current_task.start_requested
            && current_task.isolation.is_none();
        return Ok(JournalAnnotationRequest {
            annotation,
            task: (&current_task).into(),
            created: false,
            needs_start,
        });
    }
    if !related.is_empty() {
        return Err("Select the related task or group to continue this discussion.".into());
    }
    if !annotation.mentions.is_empty() {
        return Err("Member mentions require an associated task group.".into());
    }
    let draft = draft.ok_or("Choose an agent for the new journal request.")?;
    if draft.project_id != project_id {
        return Err("The new journal task must belong to this project.".into());
    }
    let input = journal_input(&state, &retained.reference).await?;
    let (annotation, task) =
        crate::task_inputs::create_journal_task(&tasks, draft, input, annotation).await?;
    Ok(JournalAnnotationRequest {
        annotation,
        task,
        created: true,
        needs_start: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(library: &str) -> JournalObjectReference {
        JournalObjectReference {
            library_root: library.into(),
            workbench_project_id: "manuscript-a".into(),
            kind: JournalObjectKind::Rule,
            object_id: "rule-columns".into(),
            world_version_id: "world-old".into(),
            check_id: None,
        }
    }

    fn original(store: &TaskStore, reference: &JournalObjectReference) -> Annotation {
        let mut draft = AnnotationDraft::new(
            object_target("paper", reference).unwrap(),
            AnnotationAuthor::user("user"),
            "  Original feedback.\nKeep this quote.  ",
        );
        draft.source = Some(
            source_for(&RetainedObject {
                reference: reference.clone(),
                object: json!({"quote":"Two columns are required."}),
            })
            .unwrap(),
        );
        store.add_annotation(&draft).unwrap()
    }

    #[test]
    fn object_identity_keeps_library_manuscript_and_exact_revision() {
        let reference = reference("/retained/library");
        let target = object_target("paper", &reference).unwrap();
        assert_eq!(
            target.object_id,
            r#"{"libraryRoot":"/retained/library","manuscriptId":"manuscript-a","id":"rule-columns"}"#
        );
        assert_eq!(target.object_revision.as_deref(), Some("world-old"));
        assert_eq!(target.task_id, None);
        let other = JournalObjectReference {
            workbench_project_id: "manuscript-b".into(),
            ..reference.clone()
        };
        assert_ne!(
            target.object_id,
            object_target("paper", &other).unwrap().object_id
        );
        let mut check = JournalObjectReference {
            kind: JournalObjectKind::Check,
            object_id: "check-1".into(),
            check_id: Some("check-2".into()),
            ..reference
        };
        assert!(object_target("paper", &check).is_err());
        check.check_id = Some("check-1".into());
        assert_eq!(
            object_target("paper", &check)
                .unwrap()
                .object_revision
                .as_deref(),
            Some("check-1")
        );
    }

    #[tokio::test]
    async fn retained_feedback_and_replies_keep_old_source_without_a_running_workbench() {
        let directory = tempfile::tempdir().unwrap();
        let store = TaskStore::new(directory.path().join("tasks")).unwrap();
        let reference = reference("/retained/library");
        let original = original(&store, &reference);
        assert!(store.list("paper").unwrap().is_empty());
        let mut newer = reference.clone();
        newer.world_version_id = "world-new".into();
        let retained = capture(
            &JournalWorkbenchState::default(),
            &store,
            "paper",
            newer,
            Some(&original.id),
        )
        .await
        .unwrap();
        assert_eq!(retained.reference.world_version_id, "world-old");
        assert_eq!(retained.object["quote"], "Two columns are required.");
        assert_eq!(original.body, "  Original feedback.\nKeep this quote.  ");
        assert!(!original.explicit_request);
        let reply = store
            .add_annotation(
                &AnnotationDraft::new(
                    original.target.clone(),
                    AnnotationAuthor::member("reviewer"),
                    "I will verify the quote.",
                )
                .reply_to(&original.id),
            )
            .unwrap();
        assert_eq!(
            retained_parent(&store, "paper", &reference, &reply.id)
                .unwrap()
                .1
                .object,
            retained.object
        );
        let other = JournalObjectReference {
            library_root: "/another/library".into(),
            ..reference
        };
        assert!(retained_parent(&store, "paper", &other, &reply.id).is_err());
    }

    #[test]
    fn association_reads_each_task_input_and_never_a_latest_task_pointer() {
        let directory = tempfile::tempdir().unwrap();
        let library = directory.path().join("library");
        std::fs::create_dir(&library).unwrap();
        let root = canonical_root(library.to_str().unwrap()).unwrap();
        let store = TaskStore::new(directory.path().join("tasks")).unwrap();
        let reference = reference(&root);
        let mut ids = Vec::new();
        for (world, manuscript, check) in [
            ("world-old", "manuscript-a", Some("check-1")),
            ("world-new", "manuscript-a", Some("check-2")),
            ("world-old", "manuscript-b", None),
        ] {
            let task = store
                .create(ResearchTaskDraft {
                    project_id: "paper".into(),
                    title: world.into(),
                    prompt: "Check source".into(),
                    runtime_id: "builtin".into(),
                    agent_id: "fixture".into(),
                    model_id: "fixture".into(),
                    ..Default::default()
                })
                .unwrap();
            let snapshot = json!({"baseline":{"project":{"project_id": manuscript}}});
            let path = store
                .root()
                .join("task-inputs")
                .join(format!("{}.json", task.id));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, serde_json::to_vec(&json!({"journalInput": {
                "libraryRoot": root, "worldVersionId": world, "checkId": check, "baselineId": "b1",
                "snapshotSha256": content_hash(&serde_json::to_vec(&snapshot).unwrap()), "snapshot": snapshot
            }})).unwrap()).unwrap();
            ids.push(task.id);
        }
        let matches = related_tasks(&store, "paper", &reference).unwrap();
        assert_eq!(
            matches.iter().map(|task| &task.id).collect::<Vec<_>>(),
            vec![&ids[0]]
        );
        let check_ref = JournalObjectReference {
            kind: JournalObjectKind::Check,
            object_id: "check-2".into(),
            check_id: Some("check-2".into()),
            ..reference
        };
        assert!(related_tasks(&store, "paper", &check_ref)
            .unwrap()
            .is_empty());
    }
}
