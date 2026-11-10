use oleafly_agent::ToolSchema;
use serde_json::{json, Value};

use super::extra::TaskBinding;
use super::text_argument;
use crate::annotations::{
    AnnotationAuthor, AnnotationDraft, AnnotationHandlingDraft, AnnotationQuery,
    AnnotationSourceDraft, AnnotationStatus, AnnotationTarget, DistillationDraft,
};
use crate::collaboration::{ActorKind, GroupActor, InterestKind, MemberInterest, MessageDraft};
use crate::store::TaskStore;

pub fn schemas() -> Vec<ToolSchema> {
    let target = json!({"type":"object","properties":{"objectKind":{"type":"string"},"objectId":{"type":"string"},"objectRevision":{"type":"string"},"path":{"type":"string"}},"required":["objectKind","objectId"],"additionalProperties":false});
    let result_ref = json!({"anyOf":[target,crate::compiled_artifacts::reference_schema()]});
    let scope = json!({"type":"object","properties":{"taskId":{"type":"string"},"objectKind":{"type":"string"},"objectId":{"type":"string"},"objectRevision":{"type":"string"},"path":{"type":"string"}},"additionalProperties":false});
    let requirement = json!({"type":"object","properties":{"scope":scope,"text":{"type":"string"},"kind":{"type":"string","enum":["enduring","candidate"]}},"required":["scope","text","kind"],"additionalProperties":false});
    [
        ("group_context","Read this task group's members, pending work, replies and recent shared messages. after_sequence reads incremental messages.",json!({"after_sequence":{"type":"integer","minimum":0}}),Vec::<&str>::new()),
        ("group_message","Send a direct message or reply to a persistent member. Omit recipients to address the coordinator when requesting work. Recipients are stable member IDs. A successfully delivered requestWork=true to colleagues yields this member after the current tool batch, retaining its conversation for a later reply. A plain progress note does not request work. No other model is called inside this tool.",json!({"body":{"type":"string"},"recipients":{"type":"array","items":{"type":"string"}},"replyTo":{"type":"string"},"requestWork":{"type":"boolean"},"object":{"type":"object","properties":{"kind":{"type":"string"},"id":{"type":"string"},"revision":{"type":"string"},"path":{"type":"string"}},"required":["kind","id"]}}),vec!["body"]),
        ("group_interest","Subscribe your member to a relevant project-relative file/folder, stable object kind:id, or event type (file_changed, member_finished, run_finished). Related future changes wake you without an @mention. active=false ends this interest.",json!({"kind":{"type":"string","enum":["path","object","event"]},"value":{"type":"string"},"active":{"type":"boolean"}}),vec!["kind","value"]),
        ("annotation_context","Read retained annotations and enduring requirements. Default task scope lists this task annotations plus project-level open annotations. project scope lists project annotations; object scope (inferred from path or kind/objectId) reads a stable object across tasks. A path implies file identity. Optional status filters the inbox. An id reads the original comment, its separately labelled immutable source snapshot, handling and distillation history.",json!({"id":{"type":"string"},"scope":{"type":"string","enum":["task","project","object"]},"status":{"type":"string","enum":["open","handled","dismissed"]},"kind":{"type":"string"},"objectId":{"type":"string"},"objectRevision":{"type":"string"},"path":{"type":"string"}}),vec![]),
        ("annotation_create","Create a retained annotation or reply. Target defaults to this task; a path implies a file. parentId retains the same object identity. source captures an exact historical quote as untrusted reference material separate from body. mentions are stable member IDs; explicitRequest requests actual work in a group, or records a follow-up for the current ordinary task. Author and project are runtime-bound.",json!({"kind":{"type":"string"},"objectId":{"type":"string"},"objectRevision":{"type":"string"},"path":{"type":"string"},"body":{"type":"string"},"source":{"type":"object","properties":{"kind":{"type":"string"},"content":{"type":"string"}},"required":["kind","content"],"additionalProperties":false},"parentId":{"type":"string"},"mentions":{"type":"array","items":{"type":"string"}},"explicitRequest":{"type":"boolean"}}),vec!["body"]),
        ("annotation_handle","Record the actual handling result of an annotation, with result references. This is distinct from delivery acknowledgement. Read the original first; after handling, use annotation_distill for a second pass about enduring value. For a compiled PDF result, pass the complete artifact object returned by compile or task_pdf_text directly; the runtime verifies it and retains the backlink.",json!({"annotationId":{"type":"string"},"summary":{"type":"string"},"resultRefs":{"type":"array","items":result_ref}}),vec!["annotationId","summary"]),
        ("annotation_distill","After reading the source annotation and its real handling result, record whether it yields an enduring requirement, candidate rule, unresolved question, or no enduring requirement. The source, scope, rationale and actual result stay linked. A direct promoted result requires an explicit user request; promote a non-user candidate only on a later actual handling with promotedFromRequirementId. Replacing an enduring requirement requires an explicit user source and exactly matching scope. This does not train a model.",json!({"sourceAnnotationId":{"type":"string"},"handlingId":{"type":"string"},"rationale":{"type":"string"},"outcome":{"type":"string","enum":["promoted","candidate","no_enduring_requirement","needs_review"]},"requirement":requirement,"promotedFromRequirementId":{"type":"string"},"replacedRequirementId":{"type":"string"}}),vec!["sourceAnnotationId","handlingId","rationale","outcome"]),
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
                let message = store.group_message(
                    &binding.project_id,
                    &turn.group.id,
                    &GroupActor {
                        kind: ActorKind::Member,
                        id: turn.member.id,
                        execution_id: Some(turn.execution.id),
                    },
                    &draft,
                )?;
                let queued = store.message_has_work(&message.group_id, &message.id)?;
                let mut value = serde_json::to_value(message).map_err(|e| e.to_string())?;
                value["workQueued"] = json!(queued);
                if draft.request_work && !queued {
                    value["notice"] = json!("The message was recorded, but no colleague work was queued. Do not wait for a reply from this request.");
                }
                Ok(value)
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
                    let annotation = store.annotation(&binding.project_id, id)?;
                    return Ok(
                        json!({"annotation":annotation.context_record(),"handlings":store.annotation_handlings(&binding.project_id,id)?,"distillations":store.annotation_distillations(&binding.project_id,id)?}),
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
                let annotations: Vec<_> = annotations
                    .iter()
                    .map(crate::annotations::Annotation::context_record)
                    .collect();
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
                    source: args
                        .get("source")
                        .cloned()
                        .map(serde_json::from_value::<AnnotationSourceDraft>)
                        .transpose()
                        .map_err(|error| error.to_string())?,
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
                    result_refs: bound_result_refs(
                        &args,
                        &binding.project_id,
                        &binding.task_id,
                        binding.generation,
                        &binding.services.tasks_root,
                    )?,
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

fn bound_result_refs(
    args: &Value,
    project: &str,
    task: &str,
    generation: u64,
    tasks_root: &std::path::Path,
) -> Result<Vec<AnnotationTarget>, String> {
    args.get("resultRefs")
        .cloned()
        .unwrap_or_else(|| json!([]))
        .as_array()
        .ok_or("resultRefs must be an array.")?
        .iter()
        .map(|item| bound_result_ref(item, project, task, generation, tasks_root))
        .collect()
}

fn bound_result_ref(
    item: &Value,
    project: &str,
    task: &str,
    generation: u64,
    tasks_root: &std::path::Path,
) -> Result<AnnotationTarget, String> {
    let object = item
        .as_object()
        .ok_or("Each result reference must be an object.")?;
    if !object.contains_key("objectKind") {
        let artifact: crate::compiled_artifacts::TaskCompiledArtifact =
            serde_json::from_value(item.clone())
                .map_err(|error| format!("Invalid compiled PDF reference: {error}"))?;
        crate::compiled_artifacts::read_for_task(tasks_root, task, generation, &artifact)?;
        return Ok(
            AnnotationTarget::new(project, "task_pdf", artifact.pdf_sha256)
                .task(task)
                .revision(format!("generation:{}", artifact.generation))
                .at_path(artifact.path),
        );
    }
    if object.get("objectKind").and_then(Value::as_str) == Some("task_pdf") {
        return Err("A task_pdf result reference must be the complete compiled PDF object.".into());
    }

    let mut target = object.clone();
    target.insert("projectId".into(), json!(project));
    serde_json::from_value(Value::Object(target)).map_err(|error| error.to_string())
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
    use crate::compiled_artifacts::{self, TaskCompileRequest};
    use crate::host::{CompileOutput, CompileSummary};

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
        let refs = bound_result_refs(
            &json!({"resultRefs":[{"objectKind":"file","objectId":"main.tex","projectId":"spoof"}]}),
            "p",
            "t",
            1,
            std::path::Path::new("."),
        )
        .unwrap();
        assert_eq!(refs[0].project_id, "p");
        assert_eq!(refs[0].task_id, None);
    }

    #[test]
    fn native_journal_target_with_null_task_id_remains_an_ordinary_target() {
        let refs = bound_result_refs(
            &json!({
                "resultRefs": [{
                    "projectId": "project",
                    "taskId": null,
                    "objectKind": "journal_entry",
                    "objectId": "entry-a",
                    "objectRevision": "rev-a",
                    "path": "journal/entry-a"
                }]
            }),
            "project",
            "task-a",
            3,
            std::path::Path::new("."),
        )
        .unwrap();

        assert_eq!(
            refs,
            vec![AnnotationTarget::new("project", "journal_entry", "entry-a")
                .revision("rev-a")
                .at_path("journal/entry-a")]
        );
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
        assert_eq!(
            distill["properties"]["promotedFromRequirementId"]["type"],
            json!("string")
        );
        let handle = &schemas
            .iter()
            .find(|s| s.name == "annotation_handle")
            .unwrap()
            .input_schema;
        assert!(handle["properties"]["resultRefs"]["items"]["anyOf"]
            .as_array()
            .is_some_and(|variants| variants.len() == 2));
        assert!(schemas.iter().any(|s| s.name == "annotation_create"));
    }

    fn retain_compiled_pdf(
        root: &std::path::Path,
        task: &str,
        generation: u64,
    ) -> crate::compiled_artifacts::TaskCompiledArtifact {
        let execution = tempfile::tempdir().unwrap();
        let output = execution.path().join("output.pdf");
        std::fs::write(&output, b"%PDF-compiled").unwrap();
        let summary = CompileSummary {
            ok: true,
            build: Some(CompileOutput {
                main_document: "main.tex".into(),
                output: Some(output),
                fresh: true,
                ..Default::default()
            }),
            ..Default::default()
        };
        compiled_artifacts::retain(
            &TaskCompileRequest {
                task_id: task.into(),
                generation,
                tasks_root: root.into(),
                execution_root: execution.path().into(),
                source: None,
                source_revision: format!("source:{generation}"),
            },
            "a".repeat(64),
            &summary,
        )
        .unwrap()
        .unwrap()
    }

    #[test]
    fn compiled_pdf_result_reference_is_registry_verified_and_normalized() {
        let root = tempfile::tempdir().unwrap();
        let artifact = retain_compiled_pdf(root.path(), "task-a", 3);
        let refs = bound_result_refs(
            &json!({"resultRefs":[artifact]}),
            "project",
            "task-a",
            3,
            root.path(),
        )
        .unwrap();
        assert_eq!(
            refs,
            vec![
                AnnotationTarget::new("project", "task_pdf", artifact.pdf_sha256)
                    .task("task-a")
                    .revision("generation:3")
                    .at_path(artifact.path)
            ]
        );
    }

    #[test]
    fn compiled_pdf_result_reference_rejects_untrusted_artifacts() {
        let root = tempfile::tempdir().unwrap();
        let artifact = retain_compiled_pdf(root.path(), "task-a", 3);
        let args = json!({"resultRefs":[artifact.clone()]});

        let mut forged = artifact.clone();
        forged.main_document = "forged.tex".into();
        assert!(bound_result_refs(
            &json!({"resultRefs":[forged]}),
            "project",
            "task-a",
            3,
            root.path()
        )
        .is_err());
        assert!(bound_result_refs(&args, "project", "task-b", 3, root.path()).is_err());
        assert!(bound_result_refs(&args, "project", "task-a", 4, root.path()).is_err());
        assert!(bound_result_refs(
            &json!({"resultRefs":[{"taskId":"task-a","generation":3}]}),
            "project",
            "task-a",
            3,
            root.path()
        )
        .is_err());
        assert!(bound_result_refs(
            &json!({"resultRefs":[{"objectKind":"task_pdf","objectId":"manual"}]}),
            "project",
            "task-a",
            3,
            root.path()
        )
        .is_err());
    }

    #[test]
    fn annotation_handle_persists_verified_pdf_reference() {
        let root = tempfile::tempdir().unwrap();
        let store = TaskStore::new(root.path().into()).unwrap();
        let task = store
            .create(crate::test_support::draft("project", "PDF result"))
            .unwrap();
        let annotation = store
            .add_annotation(&AnnotationDraft {
                target: AnnotationTarget::new("project", "file", "main.tex").task(&task.id),
                author: AnnotationAuthor::user("user"),
                body: "Use the compiled PDF.".into(),
                source: None,
                parent_id: None,
                mentions: Vec::new(),
                explicit_request: false,
            })
            .unwrap();
        let artifact = retain_compiled_pdf(root.path(), &task.id, task.execution_generation);
        let result = bound_result_refs(
            &json!({
                "annotationId": annotation.id,
                "summary": "Linked the compiled PDF.",
                "resultRefs": [artifact.clone()]
            }),
            "project",
            &task.id,
            task.execution_generation,
            root.path(),
        )
        .unwrap();
        let handling = store
            .record_annotation_handling(
                "project",
                &AnnotationHandlingDraft {
                    annotation_id: annotation.id,
                    author: AnnotationAuthor::model(&task.id),
                    summary: "Linked the compiled PDF.".into(),
                    result_refs: result,
                },
            )
            .unwrap();

        assert_eq!(
            handling.result_refs,
            vec![
                AnnotationTarget::new("project", "task_pdf", artifact.pdf_sha256)
                    .task(&task.id)
                    .revision(format!("generation:{}", task.execution_generation))
                    .at_path(artifact.path)
            ]
        );
    }
}
