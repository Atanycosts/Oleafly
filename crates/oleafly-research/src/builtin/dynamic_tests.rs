use super::*;
use crate::annotations::{
    Annotation, AnnotationAuthor, AnnotationDraft, AnnotationHandling, AnnotationStatus,
    AnnotationTarget, Distillation, DistillationOutcome, RequirementDraft, RequirementScope,
};
use crate::collaboration::{GroupActor, MemberDraft, MessageDraft, WorkStatus};

fn request_context(request: &Value) -> String {
    request["messages"].to_string()
}

fn request_system(request: &Value) -> String {
    request["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| matches!(message["role"].as_str(), Some("system" | "developer")))
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
}

fn tool_value<T: serde::de::DeserializeOwned>(request: &Value) -> T {
    tool_outputs(request)
        .iter()
        .rev()
        .find_map(|output| serde_json::from_str(output).ok())
        .expect("the provider did not receive the expected typed tool result")
}

#[tokio::test]
async fn next_provider_request_loads_discovered_tools_and_current_scoped_requirements() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(workspace.join("analysis")).unwrap();
    std::fs::write(workspace.join("analysis/result.md"), "Retained evidence").unwrap();
    let tasks = root.path().join("tasks");
    let task = running_task(&tasks, "local");
    let store = TaskStore::new(tasks.clone()).unwrap();
    let scope = RequirementScope {
        path: Some("analysis/result.md".into()),
        ..RequirementScope::project("project")
    };
    let original = store
        .add_requirement(&RequirementDraft::enduring(
            scope.clone(),
            AnnotationAuthor::user("human"),
            "Preserve the negative result when editing this evidence.",
        ))
        .unwrap();
    let candidate = store
        .add_requirement(
            &RequirementDraft::enduring(
                scope.clone(),
                AnnotationAuthor::member("reviewer"),
                "Unverified candidate must not become an execution constraint.",
            )
            .candidate(),
        )
        .unwrap();
    let unrelated = store
        .add_requirement(&RequirementDraft::enduring(
            RequirementScope {
                path: Some("analysis/other.md".into()),
                ..RequirementScope::project("project")
            },
            AnnotationAuthor::user("human"),
            "Only another document is subject to this requirement.",
        ))
        .unwrap();
    let replacement_id = Arc::new(Mutex::new(None::<String>));
    let inserted = replacement_id.clone();
    let mutate = store.clone();
    let original_id = original.id.clone();
    let provider = Scripted::start(script(move |_, step| match step {
        0 => tool_delta(vec![
            (
                "discover_tools",
                json!({"query":"results_table","load":true}),
            ),
            ("read_file", json!({"path":"analysis/result.md"})),
        ]),
        1 => {
            // This mutation happens after request 1 was received. The next
            // provider request must re-query the store rather than reuse it.
            mutate
                .withdraw_requirement("project", &original_id)
                .unwrap();
            let replacement = mutate
                .add_requirement(&RequirementDraft::enduring(
                    scope.clone(),
                    AnnotationAuthor::user("human"),
                    "Retain the counterexample and its current provenance.",
                ))
                .unwrap();
            *lock(&inserted) = Some(replacement.id);
            tool_delta(vec![(
                "results_table",
                json!({"metrics":["accuracy"],"format":"markdown"}),
            )])
        }
        _ => text_reply("Checked the retained evidence and current requirements."),
    }))
    .await;
    let host = fixture_host(root.path(), provider.url.clone()).await;
    let adapter = BuiltinTaskAdapter::new(host, services(&tasks));
    let (events, sink) = event_log();
    within(adapter.run(
        task_context(&task, &workspace),
        CancellationToken::new(),
        sink,
    ))
    .await
    .unwrap();

    let requests = provider.requests();
    assert_eq!(requests.len(), 3);
    let replacement = lock(&replacement_id).clone().unwrap();
    assert!(!tool_names(&requests[0]).contains(&"results_table".into()));
    assert!(tool_names(&requests[0]).contains(&"discover_tools".into()));
    assert!(!request_context(&requests[0]).contains(&original.id));
    assert!(tool_names(&requests[1]).contains(&"results_table".into()));
    assert!(request_context(&requests[1]).contains(&original.id));
    assert!(!request_context(&requests[1]).contains(&replacement));
    assert!(request_context(&requests[2]).contains(&replacement));
    assert!(!request_context(&requests[2]).contains(&original.id));
    for request in &requests {
        let context = request_context(request);
        assert!(!context.contains(&candidate.id));
        assert!(!context.contains(&unrelated.id));
    }
    assert!(tool_outputs(&requests[1])
        .iter()
        .any(|output| output.contains("Retained evidence")));
    assert!(lock(&events).iter().any(|event| matches!(
        event,
        TaskRuntimeEvent::Tool { name, phase: ToolPhase::Request, .. } if name == "results_table"
    )));
}

#[tokio::test]
async fn late_single_agent_annotation_is_delivered_then_handled_and_distilled_through_tools() {
    const PATH: &str = "analysis/result.md";
    const ORIGINAL: &str = "The result omitted a relevant counterexample.";
    const REVISED: &str = "The result retains the counterexample and its provenance.";
    const USER_TEXT: &str = "You missed this earlier: retain this counterexample and keep its provenance in later edits.";
    const REQUIREMENT: &str = "Retain counterexamples and their provenance in this evidence file.";

    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(workspace.join("analysis")).unwrap();
    std::fs::write(workspace.join(PATH), ORIGINAL).unwrap();
    let tasks = root.path().join("tasks");
    let task = running_task(&tasks, "local");
    let store = TaskStore::new(tasks.clone()).unwrap();
    let annotation = Arc::new(Mutex::new(None::<Annotation>));
    let submitted = annotation.clone();
    let submit = store.clone();
    let task_id = task.id.clone();
    let provider = Scripted::start(script(move |request, step| match step {
        0 => {
            // The first request has already crossed the HTTP boundary. The
            // next request must see this durable input without a new run.
            let retained = submit
                .submit_task_annotation(
                    &AnnotationDraft::new(
                        AnnotationTarget::new("project", "file", PATH)
                            .task(&task_id)
                            .revision("historical-result-v1")
                            .at_path(PATH),
                        AnnotationAuthor::user("human"),
                        USER_TEXT,
                    )
                    .request(),
                )
                .unwrap();
            *lock(&submitted) = Some(retained);
            tool_delta(vec![
                ("discover_tools", json!({"query":"annotation_","load":true})),
                ("read_file", json!({"path":PATH})),
            ])
        }
        1 => tool_delta(vec![("write_file", json!({"path":PATH,"content":REVISED}))]),
        2 => {
            let id = lock(&submitted).as_ref().unwrap().id.clone();
            tool_delta(vec![(
                "annotation_handle",
                json!({
                    "annotationId":id,
                    "summary":"Restored the counterexample and provenance in the task file.",
                    "resultRefs":[{"objectKind":"file","objectId":PATH,"path":PATH}]
                }),
            )])
        }
        3 => {
            let handling: AnnotationHandling = tool_value(request);
            let id = lock(&submitted).as_ref().unwrap().id.clone();
            tool_delta(vec![(
                "annotation_distill",
                json!({
                    "sourceAnnotationId":id,
                    "handlingId":handling.id,
                    "rationale":"The user requested a continuing constraint after the concrete correction.",
                    "outcome":"promoted",
                    "requirement":{
                        "scope":{"path":PATH},
                        "text":REQUIREMENT,
                        "kind":"enduring"
                    }
                }),
            )])
        }
        _ => text_reply("Corrected the evidence and retained the scoped requirement."),
    }))
    .await;
    let host = fixture_host(root.path(), provider.url.clone()).await;
    let adapter = BuiltinTaskAdapter::new(host, services(&tasks));
    within(adapter.run(
        task_context(&task, &workspace),
        CancellationToken::new(),
        event_log().1,
    ))
    .await
    .unwrap();

    let retained = lock(&annotation).clone().unwrap();
    let requests = provider.requests();
    assert_eq!(requests.len(), 5);
    assert!(!request_system(&requests[0]).contains(USER_TEXT));
    assert!(!tool_names(&requests[0]).contains(&"annotation_handle".into()));
    let delivered = request_system(&requests[1]);
    assert!(delivered.contains(USER_TEXT));
    assert!(delivered.contains(&retained.id));
    assert!(delivered.contains(PATH));
    assert!(tool_names(&requests[1]).contains(&"annotation_handle".into()));
    assert!(tool_names(&requests[1]).contains(&"annotation_distill".into()));
    assert!(request_system(&requests[2]).contains(USER_TEXT));
    // The original remains in the durable record and tool history. It no
    // longer occupies the per-request unresolved-user-input suffix.
    assert!(!request_system(&requests[3]).contains(USER_TEXT));
    assert!(!request_system(&requests[4]).contains(USER_TEXT));
    let handling: AnnotationHandling = tool_value(&requests[3]);
    assert_eq!(handling.author, AnnotationAuthor::model(&task.id));
    assert_eq!(handling.result_refs[0].project_id, "project");
    assert_eq!(handling.result_refs[0].path.as_deref(), Some(PATH));
    let distilled: Distillation = tool_value(&requests[4]);
    assert_eq!(distilled.outcome, DistillationOutcome::Promoted);
    assert_eq!(distilled.author, AnnotationAuthor::model(&task.id));
    let requirement = store
        .requirement("project", distilled.requirement_id.as_deref().unwrap())
        .unwrap();
    assert_eq!(requirement.author, AnnotationAuthor::model(&task.id));
    assert_eq!(requirement.scope.project_id, "project");
    assert_eq!(requirement.scope.path.as_deref(), Some(PATH));
    assert_eq!(
        requirement.source_annotation_id.as_deref(),
        Some(retained.id.as_str())
    );
    assert!(request_system(&requests[4]).contains(&requirement.id));
    assert!(request_system(&requests[4]).contains(REQUIREMENT));
    assert_eq!(
        std::fs::read_to_string(workspace.join(PATH)).unwrap(),
        REVISED
    );
    assert_eq!(
        store.annotation("project", &retained.id).unwrap().body,
        USER_TEXT
    );
    assert_eq!(
        store.annotation("project", &retained.id).unwrap().status,
        AnnotationStatus::Handled
    );
    assert!(store
        .pending_task_annotations(&task.id, task.execution_generation, false)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn a_busy_group_member_receives_late_original_annotation_on_the_next_http_request() {
    const PATH: &str = "analysis/result.md";
    const USER_TEXT: &str =
        "Recheck this older result before proceeding; its counterexample is still relevant.";

    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(workspace.join("analysis")).unwrap();
    std::fs::write(workspace.join(PATH), "Current evidence file").unwrap();
    let tasks = root.path().join("tasks");
    let task = running_task(&tasks, "local");
    let store = TaskStore::new(tasks.clone()).unwrap();
    let group = store
        .create_task_group(
            "project",
            Some(&task.id),
            &[MemberDraft {
                name: "Methods".into(),
                responsibility: "Check the recorded evidence against the manuscript".into(),
                runtime_id: "builtin".into(),
                agent_id: "openai".into(),
                model_id: "test".into(),
                coordinator: true,
                ..Default::default()
            }],
        )
        .unwrap();
    store
        .group_message(
            "project",
            &group.group.id,
            &GroupActor::user(),
            &MessageDraft {
                body: "Check the current evidence file.".into(),
                recipients: vec![group.members[0].id.clone()],
                request_work: true,
                ..Default::default()
            },
        )
        .unwrap();
    let turn = store.claim_member_turn(&task).unwrap().unwrap();
    let annotation = Arc::new(Mutex::new(None::<Annotation>));
    let submitted = annotation.clone();
    let mutate = store.clone();
    let group_id = group.group.id.clone();
    let member_id = turn.member.id.clone();
    let task_id = task.id.clone();
    let provider = Scripted::start(script(move |_, step| match step {
        0 => {
            let retained = mutate
                .group_annotation(
                    &group_id,
                    &AnnotationDraft::new(
                        AnnotationTarget::new("project", "file", PATH)
                            .task(&task_id)
                            .revision("historical-v1")
                            .at_path(PATH),
                        AnnotationAuthor::user("human"),
                        USER_TEXT,
                    )
                    .mention(&member_id)
                    .request(),
                )
                .unwrap();
            *lock(&submitted) = Some(retained);
            tool_delta(vec![("read_file", json!({"path":PATH}))])
        }
        _ => text_reply("Checked the current file and the newly received concern."),
    }))
    .await;
    let host = fixture_host(root.path(), provider.url.clone()).await;
    let adapter = BuiltinTaskAdapter::new(host, services(&tasks));
    let mut context = task_context(&task, &workspace);
    context.session_id = turn.execution.session_id.clone();
    context.runtime_id = turn.member.config.runtime_id.clone();
    context.agent_id = turn.member.config.agent_id.clone();
    context.model_id = turn.member.config.model_id.clone();
    context.collaboration = Some(turn.clone());
    let outcome = within(adapter.run(context, CancellationToken::new(), event_log().1))
        .await
        .unwrap();
    let retained = lock(&annotation).clone().unwrap();
    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    assert!(!request_system(&requests[0]).contains(USER_TEXT));
    let next = request_system(&requests[1]);
    assert!(next.contains(USER_TEXT));
    assert!(next.contains(&retained.id));
    assert!(next.contains(PATH));
    assert!(next.contains("annotation"));
    let refreshed = store
        .task_member_turn(&task.id, task.execution_generation)
        .unwrap()
        .unwrap();
    assert_eq!(refreshed.execution.id, turn.execution.id);
    assert_eq!(refreshed.annotations, vec![retained.clone()]);
    assert_eq!(refreshed.work.len(), 2);
    assert!(refreshed
        .work
        .iter()
        .any(|work| work.cause_kind == "annotation"
            && work.cause_id == retained.id
            && work.execution_id.as_deref() == Some(turn.execution.id.as_str())));
    store
        .finish_member_turn(&refreshed, &outcome, None)
        .unwrap();
    let snapshot = store.group_snapshot("project", &group.group.id, 0).unwrap();
    assert!(snapshot
        .work
        .iter()
        .all(|work| work.status == WorkStatus::Completed));
    assert_eq!(snapshot.executions.len(), 1);
    assert!(!store.group_has_pending(&group.group.id).unwrap());
    assert_eq!(
        store.annotation("project", &retained.id).unwrap().status,
        AnnotationStatus::Open
    );
}
