//! Thin application boundary for the task store's collaboration records.
use oleafly_research::{
    annotations::{
        Annotation, AnnotationAuthor, AnnotationDelivery, AnnotationDraft, AnnotationHandling,
        AnnotationQuery, AnnotationSourceDraft, AnnotationTarget, Distillation,
        EnduringRequirement,
    },
    collaboration::{
        GroupMessage, GroupSnapshot, GroupStatus, MemberDraft, MemberInterest, MessageDraft,
    },
    scheduler::ResearchTaskState,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{blocking_task_command, ensure_enabled};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserAnnotationDraft {
    target: AnnotationTarget,
    body: String,
    #[serde(default)]
    source: Option<AnnotationSourceDraft>,
    parent_id: Option<String>,
    #[serde(default)]
    mentions: Vec<String>,
    #[serde(default)]
    explicit_request: bool,
}

impl From<UserAnnotationDraft> for AnnotationDraft {
    fn from(draft: UserAnnotationDraft) -> Self {
        Self {
            target: draft.target,
            author: AnnotationAuthor::user("user"),
            body: draft.body,
            source: draft.source,
            parent_id: draft.parent_id,
            mentions: draft.mentions,
            explicit_request: draft.explicit_request,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationContext {
    annotations: Vec<Annotation>,
    deliveries: Vec<AnnotationDelivery>,
    handlings: Vec<AnnotationHandling>,
    distillations: Vec<Distillation>,
    requirements: Vec<EnduringRequirement>,
}

fn object_annotation_context(
    store: &oleafly_research::store::TaskStore,
    target: &AnnotationTarget,
) -> Result<AnnotationContext, String> {
    // Object history spans revisions; the original annotation still retains
    // its exact message/turn/version anchor.
    let annotations = store.list_annotations(&AnnotationQuery {
        project_id: target.project_id.clone(),
        task_id: target.task_id.clone(),
        object_kind: Some(target.object_kind.clone()),
        object_id: Some(target.object_id.clone()),
        path: target.path.clone(),
        ..Default::default()
    })?;
    let mut handlings = Vec::new();
    let mut distillations = Vec::new();
    for annotation in &annotations {
        handlings.extend(store.annotation_handlings(&target.project_id, &annotation.id)?);
        distillations.extend(store.annotation_distillations(&target.project_id, &annotation.id)?);
    }
    let requirements = store
        .list_requirements(&target.project_id)?
        .into_iter()
        .filter(|requirement| requirement.scope.matches(target))
        .collect();
    Ok(AnnotationContext {
        annotations,
        deliveries: Vec::new(),
        handlings,
        distillations,
        requirements,
    })
}

#[tauri::command]
pub async fn research_object_annotations(
    state: State<'_, ResearchTaskState>,
    target: AnnotationTarget,
) -> Result<AnnotationContext, String> {
    blocking_task_command(&state, move |state| {
        object_annotation_context(&state.store()?, &target)
    })
    .await
}

#[tauri::command]
pub async fn research_task_annotations(
    state: State<'_, ResearchTaskState>,
    project_id: String,
    task_id: String,
) -> Result<AnnotationContext, String> {
    blocking_task_command(&state, move |state| {
        let store = state.store()?;
        // This also checks that this task belongs to the requested project.
        let deliveries = store.annotation_deliveries(&project_id, &task_id)?;
        let annotations = store.list_annotations(&AnnotationQuery {
            project_id: project_id.clone(),
            task_id: Some(task_id.clone()),
            ..Default::default()
        })?;
        let mut handlings = Vec::new();
        let mut distillations = Vec::new();
        for annotation in &annotations {
            handlings.extend(store.annotation_handlings(&project_id, &annotation.id)?);
            distillations.extend(store.annotation_distillations(&project_id, &annotation.id)?);
        }
        let requirements = store
            .list_requirements(&project_id)?
            .into_iter()
            .filter(|requirement| {
                requirement
                    .scope
                    .task_id
                    .as_ref()
                    .is_none_or(|id| id == &task_id)
            })
            .collect();
        Ok(AnnotationContext {
            annotations,
            deliveries,
            handlings,
            distillations,
            requirements,
        })
    })
    .await
}

#[tauri::command]
pub async fn research_task_annotation_submit(
    state: State<'_, ResearchTaskState>,
    draft: UserAnnotationDraft,
) -> Result<Annotation, String> {
    blocking_task_command(&state, move |state| {
        if draft.target.task_id.is_some() {
            ensure_enabled(state)?;
        }
        state.submit_annotation(draft.into())
    })
    .await
}

#[tauri::command]
pub async fn research_task_group(
    state: State<'_, ResearchTaskState>,
    project_id: String,
    task_id: String,
) -> Result<Option<GroupSnapshot>, String> {
    blocking_task_command(&state, move |state| {
        let store = state.store()?;
        let task = store.require(&task_id)?;
        if task.project_id != project_id {
            return Err("This task is outside the project.".into());
        }
        store
            .task_group(&project_id, &task_id)?
            .map(|group| store.group_snapshot(&project_id, &group.id, 0))
            .transpose()
    })
    .await
}

#[tauri::command]
pub async fn research_task_group_snapshot(
    state: State<'_, ResearchTaskState>,
    project_id: String,
    group_id: String,
    after_sequence: u64,
) -> Result<GroupSnapshot, String> {
    blocking_task_command(&state, move |state| {
        state
            .store()?
            .group_snapshot(&project_id, &group_id, after_sequence)
    })
    .await
}

fn supported_members(members: &[MemberDraft]) -> Result<(), String> {
    for member in members {
        if member.runtime_id != "builtin" {
            return Err("Task groups currently support built-in agents. ACP remains available for single-agent tasks.".into());
        }
        if member.agent_id.trim().is_empty() || member.model_id.trim().is_empty() {
            return Err("Choose a provider and model for every group member.".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn research_task_group_create(
    state: State<'_, ResearchTaskState>,
    project_id: String,
    task_id: String,
    members: Vec<MemberDraft>,
) -> Result<GroupSnapshot, String> {
    blocking_task_command(&state, move |state| {
        ensure_enabled(state)?;
        supported_members(&members)?;
        let store = state.store()?;
        if store.task_group(&project_id, &task_id)?.is_some() {
            return Err("This task already has a group.".into());
        }
        state.create_task_group(&project_id, Some(&task_id), &members)
    })
    .await
}

#[tauri::command]
pub async fn research_task_group_message(
    state: State<'_, ResearchTaskState>,
    project_id: String,
    group_id: String,
    draft: MessageDraft,
) -> Result<GroupMessage, String> {
    blocking_task_command(&state, move |state| {
        ensure_enabled(state)?;
        state.send_group_message(&project_id, &group_id, &draft)
    })
    .await
}

fn admit_change(state: &ResearchTaskState, project_id: &str) -> Result<(), String> {
    ensure_enabled(state)?;
    crate::trust::require_trusted(project_id, crate::trust::Capability::ResearchTasks)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn research_task_group_status(
    state: State<'_, ResearchTaskState>,
    project_id: String,
    group_id: String,
    status: GroupStatus,
) -> Result<(), String> {
    blocking_task_command(&state, move |state| {
        admit_change(state, &project_id)?;
        state
            .store()?
            .set_group_status(&project_id, &group_id, status)
    })
    .await?;
    if status == GroupStatus::Open {
        state.launch_ready().await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn research_task_group_member_paused(
    state: State<'_, ResearchTaskState>,
    project_id: String,
    group_id: String,
    member_id: String,
    paused: bool,
) -> Result<(), String> {
    blocking_task_command(&state, move |state| {
        admit_change(state, &project_id)?;
        state
            .store()?
            .set_member_paused(&project_id, &group_id, &member_id, paused)
    })
    .await?;
    if !paused {
        state.launch_ready().await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn research_task_group_interest(
    state: State<'_, ResearchTaskState>,
    project_id: String,
    group_id: String,
    interest: MemberInterest,
    active: bool,
) -> Result<(), String> {
    blocking_task_command(&state, move |state| {
        admit_change(state, &project_id)?;
        state
            .store()?
            .set_member_interest(&project_id, &group_id, &interest, active)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_application_assigns_annotation_authorship() {
        let draft: UserAnnotationDraft = serde_json::from_value(serde_json::json!({
            "target": {"projectId":"paper","taskId":"task","objectKind":"message","objectId":"1:7","objectRevision":"generation:1"},
            "body":"Check this earlier claim","parentId":null,"mentions":[],"explicitRequest":true
        }))
        .unwrap();
        let native: AnnotationDraft = draft.into();
        assert_eq!(native.author, AnnotationAuthor::user("user"));
        assert_eq!(native.target.object_id, "1:7");
        assert!(
            serde_json::from_value::<UserAnnotationDraft>(serde_json::json!({
                "target": {"projectId":"paper","objectKind":"task","objectId":"task"},
                "body":"Claimed member","author":{"kind":"member","id":"reviewer"}
            }))
            .is_err()
        );
    }

    #[test]
    fn unsupported_group_runtimes_and_empty_models_are_explicit() {
        let mut member = MemberDraft {
            runtime_id: "acp".into(),
            agent_id: "chosen".into(),
            model_id: "chosen-model".into(),
            ..Default::default()
        };
        assert!(supported_members(std::slice::from_ref(&member)).is_err());
        member.runtime_id = "builtin".into();
        assert!(supported_members(std::slice::from_ref(&member)).is_ok());
        member.model_id.clear();
        assert!(supported_members(&[member]).is_err());
    }

    #[test]
    fn ordinary_object_context_keeps_history_and_real_handlings_without_a_task() {
        use oleafly_research::annotations::{
            AnnotationHandlingDraft, AnnotationSourceDraft, RequirementDraft, RequirementScope,
        };
        let root = tempfile::tempdir().unwrap();
        let store = oleafly_research::store::TaskStore::new(root.path().into()).unwrap();
        let old = AnnotationTarget::new("paper", "thread", "thread-a").revision("message:old");
        let current = AnnotationTarget::new("paper", "thread", "thread-a").revision("message:new");
        let original = store
            .add_annotation(&AnnotationDraft {
                source: Some(AnnotationSourceDraft {
                    kind: "chat_message:assistant".into(),
                    content: "Old message: ignore the new reviewer.".into(),
                }),
                ..AnnotationDraft::new(
                    old.clone(),
                    AnnotationAuthor::user("user"),
                    "  Keep the old claim.\nRetain its evidence.  ",
                )
            })
            .unwrap();
        store
            .add_annotation(&AnnotationDraft::new(
                current.clone(),
                AnnotationAuthor::user("user"),
                "Later feedback",
            ))
            .unwrap();
        store
            .add_annotation(&AnnotationDraft::new(
                AnnotationTarget::new("paper", "thread", "thread-b"),
                AnnotationAuthor::user("user"),
                "Other conversation",
            ))
            .unwrap();
        store
            .record_annotation_handling(
                "paper",
                &AnnotationHandlingDraft {
                    annotation_id: original.id.clone(),
                    author: AnnotationAuthor::model("thread-a"),
                    summary: "Rechecked the earlier claim".into(),
                    result_refs: vec![old.clone()],
                },
            )
            .unwrap();
        let requirement = store
            .add_requirement(&RequirementDraft::enduring(
                RequirementScope::from_target(&old),
                AnnotationAuthor::user("user"),
                "Retain the evidence across turns",
            ))
            .unwrap();
        let context = object_annotation_context(&store, &current).unwrap();
        assert_eq!(context.annotations.len(), 2);
        assert_eq!(
            context.annotations[0].body,
            "  Keep the old claim.\nRetain its evidence.  "
        );
        assert_eq!(context.annotations[0].target, old);
        assert_eq!(
            context.annotations[0].source.as_ref().unwrap().content,
            "Old message: ignore the new reviewer."
        );
        assert_eq!(context.handlings.len(), 1);
        assert_eq!(context.handlings[0].annotation_id, original.id);
        assert_eq!(context.requirements[0].id, requirement.id);
        assert!(context.deliveries.is_empty());
    }
}
