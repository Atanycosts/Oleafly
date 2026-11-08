use oleafly_agent::ToolSchema;
use serde_json::{json, Value};

use super::extra::TaskBinding;
use super::text_argument;
use crate::annotations::{
    AnnotationAuthor, AnnotationDraft, AnnotationHandlingDraft, AnnotationQuery, AnnotationStatus,
    AnnotationTarget, DistillationDraft,
};
use crate::collaboration::{ActorKind, GroupActor, InterestKind, MemberInterest, MessageDraft};
use crate::store::TaskStore;

pub fn schemas() -> Vec<ToolSchema> {
    let target = json!({"type":"object","properties":{"objectKind":{"type":"string"},"objectId":{"type":"string"},"objectRevision":{"type":"string"},"path":{"type":"string"}},"required":["objectKind","objectId"],"additionalProperties":false});
    let scope = json!({"type":"object","properties":{"taskId":{"type":"string"},"objectKind":{"type":"string"},"objectId":{"type":"string"},"objectRevision":{"type":"string"},"path":{"type":"string"}},"additionalProperties":false});
    let requirement = json!({"type":"object","properties":{"scope":scope,"text":{"type":"string"},"kind":{"type":"string","enum":["enduring","candidate"]}},"required":["scope","text","kind"],"additionalProperties":false});
    [
        ("group_context","Read this task group's members, pending work, replies and recent shared messages. after_sequence reads incremental messages.",json!({"after_sequence":{"type":"integer","minimum":0}}),Vec::<&str>::new()),
        ("group_message","Send a direct message or reply to a persistent member. Omit recipients to address the coordinator when requesting work. Recipients are stable member IDs; a plain progress note does not request work. No other model is called inside this tool.",json!({"body":{"type":"string"},"recipients":{"type":"array","items":{"type":"string"}},"replyTo":{"type":"string"},"requestWork":{"type":"boolean"},"object":{"type":"object","properties":{"kind":{"type":"string"},"id":{"type":"string"},"revision":{"type":"string"},"path":{"type":"string"}},"required":["kind","id"]}}),vec!["body"]),
        ("group_interest","Subscribe your member to a relevant project-relative file/folder, stable object kind:id, or event type (file_changed, member_finished, run_finished). Related future changes wake you without an @mention. active=false ends this interest.",json!({"kind":{"type":"string","enum":["path","object","event"]},"value":{"type":"string"},"active":{"type":"boolean"}}),vec!["kind","value"]),
        ("annotation_context","Read retained annotations and enduring requirements. Default task scope lists this task annotations plus project-level open annotations. project scope lists project annotations; object scope (inferred from path or kind/objectId) reads a stable object across tasks. A path implies file identity. Optional status filters the inbox. An id reads handling and distillation history.",json!({"id":{"type":"string"},"scope":{"type":"string","enum":["task","project","object"]},"status":{"type":"string","enum":["open","handled","dismissed"]},"kind":{"type":"string"},"objectId":{"type":"string"},"objectRevision":{"type":"string"},"path":{"type":"string"}}),vec![]),
        ("annotation_create","Create a retained annotation or reply. Target defaults to this task; a path implies a file. parentId retains the same object identity. mentions are stable member IDs; explicitRequest requests actual work in a group, or records a follow-up for the current ordinary task. Author and project are runtime-bound.",json!({"kind":{"type":"string"},"objectId":{"type":"string"},"objectRevision":{"type":"string"},"path":{"type":"string"},"body":{"type":"string"},"parentId":{"type":"string"},"mentions":{"type":"array","items":{"type":"string"}},"explicitRequest":{"type":"boolean"}}),vec!["body"]),
        ("annotation_handle","Record the actual handling result of an annotation, with result references. This is distinct from delivery acknowledgement. Read the original first; after handling, use annotation_distill for a second pass about enduring value.",json!({"annotationId":{"type":"string"},"summary":{"type":"string"},"resultRefs":{"type":"array","items":target}}),vec!["annotationId","summary"]),
        ("annotation_distill","After reading the source annotation and its real handling result, record whether it yields an enduring requirement, candidate rule, unresolved question, or no enduring requirement. The source, scope, rationale and actual result stay linked. This does not train a model.",json!({"sourceAnnotationId":{"type":"string"},"handlingId":{"type":"string"},"rationale":{"type":"string"},"outcome":{"type":"string","enum":["promoted","candidate","no_enduring_requirement","needs_review"]},"requirement":requirement,"replacedRequirementId":{"type":"string"}}),vec!["sourceAnnotationId","handlingId","rationale","outcome"]),
    ].into_iter().map(|(name,description,properties,required)| ToolSchema{name:name.into(),description:description.into(),input_schema:json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})}).collect()
}

pub fn call(name: &str, args: Value, binding: &TaskBinding) -> Option<Result<Value, String>> {
    if !schemas().iter().any(|schema| schema.name == name) {
        return None;
    }
    Some((|| {
        let store = TaskStore::new(binding.services.tasks_root.clone())?;
        let turn = store.task_member_turn(&binding.task_id, binding.generation)?;
        let author = turn
            .as_ref()
            .map(|turn| AnnotationAuthor::member(&turn.member.id))
            .unwrap_or_else(|| AnnotationAuthor::model(&binding.task_id));
        match name {
            "group_context" => {
                let group = store
                    .task_group(&binding.project_id, &binding.task_id)?
                    .ok_or("This task has no persistent group.")?;
                serde_json::to_value(store.group_snapshot(
                    &binding.project_id,
                    &group.id,
                    args["after_sequence"].as_u64().unwrap_or(0),
                )?)
                .map_err(|e| e.to_string())
            }
            "group_message" => {
                let turn = turn.ok_or("This execution is not a persistent group member.")?;
                let draft: MessageDraft =
                    serde_json::from_value(args).map_err(|e| e.to_string())?;
                serde_json::to_value(store.group_message(
                    &binding.project_id,
                    &turn.group.id,
                    &GroupActor {
                        kind: ActorKind::Member,
                        id: turn.member.id,
                        execution_id: Some(turn.execution.id),
                    },
                    &draft,
                )?)
                .map_err(|e| e.to_string())
            }
            "group_interest" => {
                let turn = turn.ok_or("This execution is not a persistent group member.")?;
                let kind: InterestKind =
                    serde_json::from_value(args["kind"].clone()).map_err(|e| e.to_string())?;
                store.set_member_interest(
                    &binding.project_id,
                    &turn.group.id,
                    &MemberInterest {
                        member_id: turn.member.id,
                        kind,
                        value: text_argument(&args, "value")?.into(),
                    },
                    args["active"].as_bool().unwrap_or(true),
                )?;
                Ok(json!({"saved":true}))
            }
            "annotation_context" => {
                if let Some(id) = args["id"].as_str() {
                    return Ok(
                        json!({"annotation":store.annotation(&binding.project_id,id)?,"handlings":store.annotation_handlings(&binding.project_id,id)?,"distillations":store.annotation_distillations(&binding.project_id,id)?}),
                    );
                }
                let (query, target, include_project_inbox) =
                    context_query(&args, &binding.project_id, &binding.task_id)?;
                let mut annotations = store.list_annotations(&query)?;
                if include_project_inbox {
                    let inbox = store.list_annotations(&AnnotationQuery {
                        status: Some(AnnotationStatus::Open),
                        ..AnnotationQuery::project(&binding.project_id)
                    })?;
                    annotations.extend(
                        inbox
                            .into_iter()
                            .filter(|item| item.target.task_id.is_none()),
                    );
                }
                Ok(
                    json!({"annotations":annotations,"requirements":store.list_active_requirements(&target)?}),
                )
            }
            "annotation_create" => {
                let mut target = target_argument(&args, &binding.project_id, &binding.task_id)?;
                if let Some(parent_id) = args["parentId"].as_str() {
                    let parent = store.annotation(&binding.project_id, parent_id)?;
                    if args.get("kind").is_none()
                        && args.get("objectId").is_none()
                        && args.get("path").is_none()
                    {
                        target = parent.target;
                        target.task_id = Some(binding.task_id.clone());
                    }
                }
                let draft = AnnotationDraft {
                    target,
                    author,
                    body: text_argument(&args, "body")?.into(),
                    parent_id: args["parentId"].as_str().map(str::to_owned),
                    mentions: serde_json::from_value(
                        args.get("mentions").cloned().unwrap_or_else(|| json!([])),
                    )
                    .map_err(|e| e.to_string())?,
                    explicit_request: args["explicitRequest"].as_bool().unwrap_or(false),
                };
                let annotation = match turn {
                    Some(turn) => store.group_annotation(&turn.group.id, &draft)?,
                    None => store.add_annotation(&draft)?,
                };
                serde_json::to_value(annotation).map_err(|e| e.to_string())
            }
            "annotation_handle" => {
                let draft = AnnotationHandlingDraft {
                    annotation_id: text_argument(&args, "annotationId")?.into(),
                    author,
                    summary: text_argument(&args, "summary")?.into(),
                    result_refs: serde_json::from_value(bound_result_refs(
                        &args,
                        &binding.project_id,
                    )?)
                    .map_err(|e| e.to_string())?,
                };
                serde_json::to_value(store.record_annotation_handling(&binding.project_id, &draft)?)
                    .map_err(|e| e.to_string())
            }
            "annotation_distill" => {
                let draft = bound_distillation(args, &binding.project_id, &author)?;
                serde_json::to_value(store.add_distillation(&binding.project_id, &draft)?)
                    .map_err(|e| e.to_string())
            }
            _ => unreachable!(),
        }
    })())
}

fn target_argument(args: &Value, project: &str, task: &str) -> Result<AnnotationTarget, String> {
    let path = args["path"].as_str();
    let kind = args["kind"]
        .as_str()
        .unwrap_or(if path.is_some() { "file" } else { "task" });
    let id = args["objectId"]
        .as_str()
        .or(if kind == "file" { path } else { None });
    let id = match id {
        Some(id) => id,
        None if kind == "task" => task,
        None => return Err("Supply objectId for a stable object, or path for a file.".into()),
    };
    let mut target = AnnotationTarget::new(project, kind, id).task(task);
    target.path = path.map(str::to_owned);
    target.object_revision = args["objectRevision"].as_str().map(str::to_owned);
    Ok(target)
}

fn context_query(
    args: &Value,
    project: &str,
    task: &str,
) -> Result<(AnnotationQuery, AnnotationTarget, bool), String> {
    let target = target_argument(args, project, task)?;
    let object_requested = ["kind", "objectId", "path"]
        .iter()
        .any(|key| args.get(*key).is_some());
    let scope = args["scope"]
        .as_str()
        .unwrap_or(if object_requested { "object" } else { "task" });
    let status = args
        .get("status")
        .map(|value| serde_json::from_value(value.clone()).map_err(|e| e.to_string()))
        .transpose()?;
    let mut query = match scope {
        "task" => AnnotationQuery {
            task_id: Some(task.into()),
            ..AnnotationQuery::project(project)
        },
        "project" => AnnotationQuery::project(project),
        "object" => {
            let mut query = AnnotationQuery::target(&target);
            query.task_id = None;
            query
        }
        _ => return Err("Annotation scope must be task, project, or object.".into()),
    };
    query.status = status;
    let include_project_inbox =
        scope == "task" && (status.is_none() || status == Some(AnnotationStatus::Open));
    Ok((query, target, include_project_inbox))
}

fn bound_result_refs(args: &Value, project: &str) -> Result<Value, String> {
    let mut refs = args.get("resultRefs").cloned().unwrap_or_else(|| json!([]));
    for item in refs.as_array_mut().ok_or("resultRefs must be an array.")? {
        item.as_object_mut()
            .ok_or("Each result reference must be an object.")?
            .insert("projectId".into(), json!(project));
    }
    Ok(refs)
}

fn bound_distillation(
    args: Value,
    project: &str,
    author: &AnnotationAuthor,
) -> Result<DistillationDraft, String> {
    let mut fields = args
        .as_object()
        .cloned()
        .ok_or("Use a distillation object.")?;
    let author = serde_json::to_value(author).map_err(|e| e.to_string())?;
    fields.insert("author".into(), author.clone());
    if let Some(requirement) = fields
        .get_mut("requirement")
        .filter(|value| !value.is_null())
    {
        let requirement = requirement
            .as_object_mut()
            .ok_or("requirement must be an object.")?;
        requirement.insert("author".into(), author);
        requirement
            .get_mut("scope")
            .and_then(Value::as_object_mut)
            .ok_or("A requirement needs a scope object.")?
            .insert("projectId".into(), json!(project));
    }
    serde_json::from_value(Value::Object(fields)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_context_uses_stable_identity_across_tasks() {
        let (query, target, inbox) =
            context_query(&json!({"path":"sections/results.tex"}), "p", "t").unwrap();
        assert_eq!(target.object_kind, "file");
        assert_eq!(target.object_id, "sections/results.tex");
        assert_eq!(query.task_id, None);
        assert!(!inbox);
        let (query, _, inbox) = context_query(&json!({}), "p", "t").unwrap();
        assert_eq!(query.task_id.as_deref(), Some("t"));
        assert_eq!(query.object_id, None);
        assert!(inbox);
        assert!(
            !context_query(&json!({"scope":"task","status":"handled"}), "p", "t")
                .unwrap()
                .2
        );
    }

    #[test]
    fn nested_fields_bind_to_runtime_actor_and_project() {
        let author = AnnotationAuthor::model("t");
        let draft = bound_distillation(json!({"sourceAnnotationId":"a","handlingId":"h","rationale":"Retain this rule","outcome":"promoted","requirement":{"scope":{"projectId":"spoof","path":"sections"},"author":{"kind":"user","id":"spoof"},"text":"Retain negative results","kind":"enduring"}}), "p", &author).unwrap();
        let requirement = draft.requirement.unwrap();
        assert_eq!(requirement.author, author);
        assert_eq!(requirement.scope.project_id, "p");
        let refs: Vec<AnnotationTarget> = serde_json::from_value(bound_result_refs(&json!({"resultRefs":[{"objectKind":"file","objectId":"main.tex","projectId":"spoof"}]}), "p").unwrap()).unwrap();
        assert_eq!(refs[0].project_id, "p");
    }

    #[test]
    fn nested_schemas_expose_required_inputs_without_bound_identity() {
        let schemas = schemas();
        let distill = &schemas
            .iter()
            .find(|s| s.name == "annotation_distill")
            .unwrap()
            .input_schema;
        let requirement = &distill["properties"]["requirement"];
        assert_eq!(requirement["required"], json!(["scope", "text", "kind"]));
        assert!(requirement["properties"].get("author").is_none());
        assert!(requirement["properties"]["scope"]["properties"]
            .get("projectId")
            .is_none());
        let handle = &schemas
            .iter()
            .find(|s| s.name == "annotation_handle")
            .unwrap()
            .input_schema;
        assert_eq!(
            handle["properties"]["resultRefs"]["items"]["required"],
            json!(["objectKind", "objectId"])
        );
        assert!(schemas.iter().any(|s| s.name == "annotation_create"));
    }
}
