use super::*;
use crate::collaboration::{GroupActor, MemberDraft, MessageDraft, WorkStatus};

#[tokio::test]
async fn a_targeted_request_waits_only_its_work_and_other_items_finish_before_yielding() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("main.tex"), "Retain the negative result.").unwrap();
    let tasks = root.path().join("tasks");
    let task = running_task(&tasks, "local");
    let store = TaskStore::new(tasks.clone()).unwrap();
    let group = store
        .create_task_group(
            "project",
            Some(&task.id),
            &[true, false].map(|coordinator| MemberDraft {
                name: if coordinator {
                    "Coordinator"
                } else {
                    "Evidence"
                }
                .into(),
                responsibility: "Check the actual research result".into(),
                runtime_id: "builtin".into(),
                agent_id: "openai".into(),
                model_id: "test".into(),
                coordinator,
                ..Default::default()
            }),
        )
        .unwrap();
    let coordinator = group.members.iter().find(|m| m.config.coordinator).unwrap();
    let evidence = group
        .members
        .iter()
        .find(|m| !m.config.coordinator)
        .unwrap();
    for body in ["Check the reported split", "Retain the negative result"] {
        store
            .group_message(
                "project",
                &group.group.id,
                &GroupActor::user(),
                &MessageDraft {
                    body: body.into(),
                    recipients: vec![coordinator.id.clone()],
                    request_work: true,
                    ..Default::default()
                },
            )
            .unwrap();
    }
    let first = store.claim_member_turn(&task).unwrap().unwrap();
    let split_work = first
        .work
        .iter()
        .find(|work| {
            first.messages.iter().any(|message| {
                message.id == work.cause_id && message.content.body == "Check the reported split"
            })
        })
        .unwrap()
        .id
        .clone();
    let negative_work = first
        .work
        .iter()
        .find(|work| work.id != split_work)
        .unwrap()
        .id
        .clone();
    let reviewer_id = evidence.id.clone();
    let split_id = split_work.clone();
    let negative_id = negative_work.clone();
    let provider = Scripted::start(script(move |request, index| match index {
        0 => tool_delta(vec![(
            "group_message",
            json!({
                "body":"Please verify the split against the source record",
                "recipients":[reviewer_id],"requestWork":true,"workIds":[split_id]
            }),
        )]),
        1 => {
            assert!(tool_outputs(request)
                .iter()
                .any(|output| output.contains("waitingWorkIds")));
            tool_delta(vec![("read_file", json!({"path":"main.tex"}))])
        }
        2 => {
            assert!(tool_outputs(request)
                .iter()
                .any(|output| output.contains("Retain the negative result.")));
            tool_delta(vec![(
                "group_work_settle",
                json!({
                    "workIds":[negative_id],"status":"completed",
                    "summary":"Read the current manuscript; the negative result remains.",
                    "resultRefs":[{"objectKind":"file","objectId":"main.tex","path":"main.tex"}]
                }),
            )])
        }
        _ => panic!("No provider request is needed after all claimed work was settled"),
    }))
    .await;
    let host = fixture_host(root.path(), provider.url.clone()).await;
    let adapter = BuiltinTaskAdapter::new(host, services(&tasks));
    let mut context = task_context(&task, &workspace);
    context.allowed_paths = vec!["main.tex".into()];
    context.session_id = first.execution.session_id.clone();
    context.collaboration = Some(first.clone());
    let outcome = within(adapter.run(context, CancellationToken::new(), event_log().1))
        .await
        .unwrap();
    assert_eq!(provider.requests().len(), 3);
    assert!(!outcome.waiting_for_reply);
    assert!(outcome.checkpoint.is_none());
    assert!(outcome.summary.contains("negative result remains"));
    store.finish_member_turn(&first, &outcome, None).unwrap();
    let snapshot = store.group_snapshot("project", &group.group.id, 0).unwrap();
    assert_eq!(
        snapshot
            .work
            .iter()
            .find(|w| w.id == split_work)
            .unwrap()
            .status,
        WorkStatus::Waiting
    );
    let done = snapshot
        .work
        .iter()
        .find(|w| w.id == negative_work)
        .unwrap();
    assert_eq!(done.status, WorkStatus::Completed);
    assert_eq!(
        done.resolution.as_ref().unwrap().result_refs[0].project_id,
        "project"
    );
    assert_eq!(snapshot.executions[0].status, "waiting");
    assert_eq!(
        store.claim_member_turn(&task).unwrap().unwrap().member.id,
        evidence.id
    );
}

#[tokio::test]
async fn an_invalid_targeted_request_does_not_publish_a_message_or_wait() {
    let root = tempfile::tempdir().unwrap();
    let tasks = root.path().join("tasks");
    let task = running_task(&tasks, "local");
    let store = TaskStore::new(tasks.clone()).unwrap();
    let group = store
        .create_task_group(
            "project",
            Some(&task.id),
            &[MemberDraft {
                name: "Coordinator".into(),
                responsibility: "Complete the check".into(),
                runtime_id: "builtin".into(),
                agent_id: "openai".into(),
                model_id: "test".into(),
                coordinator: true,
                ..Default::default()
            }],
        )
        .unwrap();
    store.seed_group_work(&task).unwrap();
    let turn = store.claim_member_turn(&task).unwrap().unwrap();
    let binding = TaskBinding {
        task_id: task.id.clone(),
        project_id: "project".into(),
        task_title: task.title.clone(),
        generation: task.execution_generation,
        brief: task.brief.clone(),
        record_dir: task.record_dir(),
        execution_root: root.path().to_owned(),
        allowed_paths: vec![],
        read_paths: vec![],
        linked_roots: vec![],
        search_dirs: vec![],
        project_root: None,
        services: services(&tasks),
        host: fixture_host(root.path(), "http://127.0.0.1:1/v1".into()).await,
        events: None,
        cancel: CancellationToken::new(),
    };
    let before = store.group_snapshot("project", &group.group.id, 0).unwrap();
    let result = crate::task_tools::collaboration::call(
        "group_message",
        json!({
            "body":"No colleague exists","requestWork":true,"workIds":[turn.work[0].id]
        }),
        &binding,
    )
    .unwrap();
    assert!(result.is_err());
    let after = store.group_snapshot("project", &group.group.id, 0).unwrap();
    assert_eq!(after.messages, before.messages);
    assert_eq!(after.work, before.work);
}

#[tokio::test]
async fn new_related_user_work_is_visible_after_a_partial_settlement() {
    use crate::annotations::{AnnotationAuthor, AnnotationDraft, AnnotationTarget};
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let tasks = root.path().join("tasks");
    let task = running_task(&tasks, "local");
    let store = TaskStore::new(tasks.clone()).unwrap();
    let group = store
        .create_task_group(
            "project",
            Some(&task.id),
            &[MemberDraft {
                name: "Coordinator".into(),
                responsibility: "Check actual evidence".into(),
                runtime_id: "builtin".into(),
                agent_id: "openai".into(),
                model_id: "test".into(),
                coordinator: true,
                ..Default::default()
            }],
        )
        .unwrap();
    for body in ["First question", "Second question"] {
        store
            .group_message(
                "project",
                &group.group.id,
                &GroupActor::user(),
                &MessageDraft {
                    body: body.into(),
                    recipients: vec![group.members[0].id.clone()],
                    request_work: true,
                    ..Default::default()
                },
            )
            .unwrap();
    }
    let turn = store.claim_member_turn(&task).unwrap().unwrap();
    let first_id = turn.work[0].id.clone();
    let task_id = task.id.clone();
    let group_id = group.group.id.clone();
    let tasks_path = tasks.clone();
    let provider = Scripted::start(script(move |request, index| match index {
        0 => tool_delta(vec![(
            "group_work_settle",
            json!({"workIds":[first_id],"status":"completed","summary":"First question checked"}),
        )]),
        1 => {
            let store = TaskStore::new(tasks_path.clone()).unwrap();
            let annotation = AnnotationDraft::new(
                AnnotationTarget::new("project", "decision", "early-result").task(&task_id),
                AnnotationAuthor::user("user"),
                "Revisit the early result and keep the negative counterexample",
            )
            .request();
            store.group_annotation(&group_id, &annotation).unwrap();
            tool_delta(vec![("group_context", json!({}))])
        }
        2 => {
            let wire = request.to_string();
            assert!(wire.contains("Revisit the early result and keep the negative counterexample"));
            assert!(wire.contains("\"priority\":100") || wire.contains("\\\"priority\\\":100"));
            text_reply(
                "The historical user request is now relevant; remaining checks are unresolved.",
            )
        }
        _ => panic!("unexpected request"),
    }))
    .await;
    let host = fixture_host(root.path(), provider.url.clone()).await;
    let adapter = BuiltinTaskAdapter::new(host, services(&tasks));
    let mut context = task_context(&task, &workspace);
    context.session_id = turn.execution.session_id.clone();
    context.collaboration = Some(turn.clone());
    let outcome = within(adapter.run(context, CancellationToken::new(), event_log().1))
        .await
        .unwrap();
    store.finish_member_turn(&turn, &outcome, None).unwrap();
    let snapshot = store.group_snapshot("project", &group.group.id, 0).unwrap();
    assert_eq!(
        snapshot
            .work
            .iter()
            .filter(|w| w.status == WorkStatus::Waiting)
            .count(),
        2
    );
    assert!(snapshot
        .work
        .iter()
        .any(|w| w.cause_kind == "annotation" && w.priority == 100));
    assert_eq!(provider.requests().len(), 3);
}
