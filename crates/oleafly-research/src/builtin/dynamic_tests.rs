use super::*;
use crate::annotations::{AnnotationAuthor, RequirementDraft, RequirementScope};

fn request_context(request: &Value) -> String {
    request["messages"].to_string()
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
