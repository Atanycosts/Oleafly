use std::collections::BTreeSet;
use std::sync::{Arc, Barrier};

use tempfile::TempDir;

use super::*;
use crate::model::{ResearchTaskDraft, RetryMode};

struct Fixture {
    _directory: TempDir,
    store: TaskStore,
    task: ResearchTask,
    group: GroupSnapshot,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let store = TaskStore::new(directory.path().join("tasks")).unwrap();
        let task = store
            .create(ResearchTaskDraft {
                project_id: "paper".into(),
                title: "Check methods and results".into(),
                prompt: "Compare the manuscript with the recorded evidence".into(),
                runtime_id: "fixture".into(),
                agent_id: "fixture-agent".into(),
                model_id: "fixture-model".into(),
                ..Default::default()
            })
            .unwrap();
        store.request_start(&task.id).unwrap();
        let task = store.claim_next().unwrap().unwrap();
        let members = [
            member(
                "Coordinator",
                "Advance the goal and integrate results",
                true,
            ),
            member("Methods", "Check methods against evidence", false),
            member("Explorer", "Investigate alternative approaches", false),
        ];
        let group = store
            .create_task_group("paper", Some(&task.id), &members)
            .unwrap();
        Self {
            _directory: directory,
            store,
            task,
            group,
        }
    }

    fn id(&self) -> &str {
        &self.group.group.id
    }

    fn member(&self, name: &str) -> &str {
        &self
            .group
            .members
            .iter()
            .find(|member| member.config.name == name)
            .unwrap()
            .id
    }

    fn snapshot(&self) -> GroupSnapshot {
        self.store.group_snapshot("paper", self.id(), 0).unwrap()
    }

    fn message(&self, author: &GroupActor, draft: MessageDraft) -> GroupMessage {
        self.store
            .group_message("paper", self.id(), author, &draft)
            .unwrap()
    }

    fn interest(&self, member: &str, kind: InterestKind, value: &str) {
        self.store
            .set_member_interest(
                "paper",
                self.id(),
                &MemberInterest {
                    member_id: member.into(),
                    kind,
                    value: value.into(),
                },
                true,
            )
            .unwrap();
    }

    fn event(&self, key: &str, kind: &str, object: &GroupObject) -> Vec<String> {
        self.store
            .record_group_event(
                "paper",
                self.id(),
                key,
                kind,
                object,
                &GroupActor {
                    kind: ActorKind::System,
                    id: "project-events".into(),
                    execution_id: None,
                },
                "The recorded object changed",
            )
            .unwrap()
    }
}

fn member(name: &str, responsibility: &str, coordinator: bool) -> MemberDraft {
    MemberDraft {
        name: name.into(),
        responsibility: responsibility.into(),
        runtime_id: "fixture".into(),
        agent_id: "fixture-agent".into(),
        model_id: format!("{}-model", name.to_lowercase()),
        skill_ids: vec!["evidence-check".into()],
        coordinator,
    }
}

#[test]
fn file_observation_repeated_scans_dedupe_but_content_rollbacks_are_new_work() {
    let fixture = Fixture::new();
    let methods = fixture.member("Methods");
    fixture.interest(methods, InterestKind::Path, "main.tex");
    for revision in ["H2", "H3", "H2", "H3"] {
        let object = GroupObject {
            kind: "file".into(),
            id: "main.tex".into(),
            revision: Some(revision.into()),
            path: Some("main.tex".into()),
        };
        assert_eq!(
            fixture
                .store
                .record_group_file_change("paper", fixture.id(), &object)
                .unwrap(),
            vec![methods.to_owned()]
        );
        assert!(fixture
            .store
            .record_group_file_change("paper", fixture.id(), &object)
            .unwrap()
            .is_empty());
        let turn = fixture
            .store
            .claim_member_turn(&fixture.task)
            .unwrap()
            .unwrap();
        assert_eq!(turn.events.len(), 1);
        assert_eq!(turn.events[0].object.revision.as_deref(), Some(revision));
        finish(&fixture.store, &turn);
    }
    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let snapshot = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    assert_eq!(snapshot.events.len(), 4);
    assert_eq!(snapshot.work.len(), 4);
    assert_eq!(
        snapshot
            .events
            .iter()
            .map(|event| event.object.revision.as_deref().unwrap())
            .collect::<Vec<_>>(),
        vec!["H2", "H3", "H2", "H3"]
    );
    assert!(snapshot
        .events
        .iter()
        .all(|event| event.author.kind == ActorKind::System));
}

fn actor(member: &str) -> GroupActor {
    GroupActor {
        kind: ActorKind::Member,
        id: member.into(),
        execution_id: None,
    }
}

fn request(body: &str, recipients: &[&str]) -> MessageDraft {
    MessageDraft {
        body: body.into(),
        recipients: recipients.iter().map(|id| (*id).into()).collect(),
        request_work: true,
        ..Default::default()
    }
}

fn outcome(summary: &str) -> TaskRuntimeOutcome {
    TaskRuntimeOutcome {
        summary: summary.into(),
        checkpoint: None,
        artifacts: Vec::new(),
        native_session_id: None,
        input_tokens: None,
        output_tokens: None,
        waiting_for_reply: false,
    }
}

fn waiting_outcome(summary: &str) -> TaskRuntimeOutcome {
    TaskRuntimeOutcome {
        waiting_for_reply: true,
        checkpoint: None,
        ..outcome(summary)
    }
}

fn finish(store: &TaskStore, turn: &MemberTurn) -> GroupMessage {
    store
        .finish_member_turn(
            turn,
            &outcome("Checked the evidence and saved the result"),
            None,
        )
        .unwrap()
}

#[test]
fn group_ui_history_is_bounded_but_exact_records_survive_reopening() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator").to_owned();

    let mut oldest_event = None;
    for index in 0..205 {
        let object = GroupObject {
            kind: "file".into(),
            id: format!("notes-{index}.md"),
            revision: Some(index.to_string()),
            path: Some(format!("notes-{index}.md")),
        };
        fixture.event(&format!("history-{index}"), "file_changed", &object);
        if index == 0 {
            oldest_event = fixture
                .snapshot()
                .events
                .into_iter()
                .find(|event| event.object.id == object.id);
        }
    }

    let mut oldest_execution = None;
    for index in 0..105 {
        fixture.message(
            &GroupActor::user(),
            request(&format!("Execution {index}"), &[&coordinator]),
        );
        let turn = fixture
            .store
            .claim_member_turn(&fixture.task)
            .unwrap()
            .unwrap();
        if index == 0 {
            oldest_execution = Some(turn.execution.clone());
        }
        finish(&fixture.store, &turn);
    }

    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let runtime = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    assert_eq!(runtime.executions.len(), 105);
    assert!(!runtime.executions_has_more);
    assert_eq!(runtime.events.len(), 205);
    assert!(!runtime.events_has_more);

    let ui = reopened
        .group_ui_snapshot("paper", &fixture.task.id, fixture.id(), 0)
        .unwrap();
    assert_eq!(ui.executions.len(), 100);
    assert!(ui.executions_has_more);
    assert_eq!(ui.events.len(), 100);
    assert!(ui.events_has_more);

    let oldest_execution = oldest_execution
        .map(|execution| {
            reopened
                .group_execution("paper", &fixture.task.id, fixture.id(), &execution.id)
                .unwrap()
                .unwrap()
        })
        .unwrap();
    let oldest_event = oldest_event.unwrap();
    assert_eq!(
        reopened
            .group_execution(
                "paper",
                &fixture.task.id,
                fixture.id(),
                &oldest_execution.id,
            )
            .unwrap(),
        Some(oldest_execution.clone())
    );
    assert_eq!(
        reopened
            .group_event("paper", &fixture.task.id, fixture.id(), &oldest_event.id)
            .unwrap(),
        Some(oldest_event.clone())
    );

    let event_page = reopened
        .group_events_page(
            "paper",
            &fixture.task.id,
            fixture.id(),
            ui.events.first().map(|event| event.sequence),
            100,
        )
        .unwrap();
    assert_eq!(event_page.events.len(), 100);
    assert!(event_page.has_more);
    let last_event_page = reopened
        .group_events_page(
            "paper",
            &fixture.task.id,
            fixture.id(),
            event_page.events.first().map(|event| event.sequence),
            100,
        )
        .unwrap();
    assert!(last_event_page
        .events
        .iter()
        .any(|event| event.id == oldest_event.id));

    let execution_page = reopened
        .group_executions_page(
            "paper",
            &fixture.task.id,
            fixture.id(),
            ui.executions.last().map(|execution| execution.started_at),
            ui.executions.last().map(|execution| execution.id.as_str()),
            100,
        )
        .unwrap();
    assert_eq!(execution_page.executions.len(), 5);
    assert!(!execution_page.has_more);
    assert!(execution_page
        .executions
        .iter()
        .any(|execution| execution.id == oldest_execution.id));

    let mut event_cursor = ui.events.last().unwrap().sequence - 125;
    let mut events_after = Vec::new();
    loop {
        let page = reopened
            .group_events_after_page("paper", &fixture.task.id, fixture.id(), event_cursor, 100)
            .unwrap();
        assert!(page
            .events
            .iter()
            .all(|event| event.sequence > event_cursor));
        event_cursor = page
            .events
            .last()
            .map_or(event_cursor, |event| event.sequence);
        events_after.extend(page.events);
        if !page.has_more {
            break;
        }
    }
    assert_eq!(events_after.len(), 125);
    assert_eq!(
        events_after.first().unwrap().sequence,
        ui.events.last().unwrap().sequence - 124
    );
    assert_eq!(
        events_after.last().unwrap().sequence,
        ui.events.last().unwrap().sequence
    );

    let execution_cursor = ui.executions[50].clone();
    let expected_last_execution = ui.executions.first().unwrap().id.clone();
    let mut execution_cursor = (execution_cursor.started_at, execution_cursor.id);
    let mut executions_after = Vec::new();
    loop {
        let page = reopened
            .group_executions_after_page(
                "paper",
                &fixture.task.id,
                fixture.id(),
                execution_cursor.0,
                &execution_cursor.1,
                100,
            )
            .unwrap();
        assert!(page.executions.iter().all(|execution| {
            execution.started_at > execution_cursor.0
                || (execution.started_at == execution_cursor.0 && execution.id > execution_cursor.1)
        }));
        execution_cursor = page
            .executions
            .last()
            .map_or(execution_cursor, |execution| {
                (execution.started_at, execution.id.clone())
            });
        executions_after.extend(page.executions);
        if !page.has_more {
            break;
        }
    }
    assert_eq!(executions_after.len(), ui.executions.len() - 50);
    assert_eq!(executions_after.last().unwrap().id, expected_last_execution);
}

#[test]
fn exact_group_history_queries_reject_another_project_or_task() {
    let fixture = Fixture::new();
    fixture.event(
        "scoped-event",
        "file_changed",
        &GroupObject {
            kind: "file".into(),
            id: "main.tex".into(),
            revision: Some("1".into()),
            path: Some("main.tex".into()),
        },
    );
    let event = fixture.snapshot().events[0].clone();
    let other_task = fixture
        .store
        .create(ResearchTaskDraft {
            project_id: "paper".into(),
            title: "Unrelated task".into(),
            prompt: "Do not expose another task's group history".into(),
            runtime_id: "fixture".into(),
            agent_id: "fixture-agent".into(),
            model_id: "fixture-model".into(),
            ..Default::default()
        })
        .unwrap();

    assert!(fixture
        .store
        .group_event("paper", &other_task.id, fixture.id(), &event.id)
        .is_err());
    assert!(fixture
        .store
        .group_events_page("paper", &other_task.id, fixture.id(), None, 10)
        .is_err());
    assert!(fixture
        .store
        .group_execution("other-project", &fixture.task.id, fixture.id(), "missing")
        .is_err());
    assert!(fixture
        .store
        .group_ui_snapshot("paper", &other_task.id, fixture.id(), 0)
        .is_err());
}

#[test]
fn stable_group_and_recipient_work_survive_reopening_without_a_notification() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator");
    let methods = fixture.member("Methods");
    let message = fixture.message(
        &GroupActor::user(),
        request(
            "Independently check the evidence",
            &[coordinator, methods, methods],
        ),
    );
    assert_eq!(message.content.recipients.len(), 2);

    // No scheduler or notification is involved: the persisted work is sufficient
    // for another store instance to find both intended recipients.
    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let persisted = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    assert_eq!(persisted.group.id, fixture.group.group.id);
    assert_eq!(persisted.group.task_id, Some(fixture.task.id.clone()));
    assert_eq!(persisted.group.project_id, "paper");
    assert_eq!(persisted.group.status, GroupStatus::Open);
    assert_eq!(persisted.members, fixture.group.members);
    assert_eq!(persisted.messages, vec![message.clone()]);
    assert_eq!(persisted.work.len(), 2);
    assert!(persisted
        .work
        .iter()
        .all(|work| work.status == WorkStatus::Pending));
    assert_eq!(
        reopened.task_group("paper", &fixture.task.id).unwrap(),
        Some(persisted.group.clone())
    );

    let first = reopened.claim_member_turn(&fixture.task).unwrap().unwrap();
    assert_eq!(first.messages, vec![message.clone()]);
    assert_eq!(first.work.len(), 1);
    let first_result = finish(&reopened, &first);
    let second = reopened.claim_member_turn(&fixture.task).unwrap().unwrap();
    assert_ne!(first.member.id, second.member.id);
    assert_eq!(second.messages, vec![message]);
    let second_result = finish(&reopened, &second);

    let persisted = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    assert_eq!(persisted.executions.len(), 2);
    assert_ne!(first.execution.id, second.execution.id);
    assert!(persisted
        .work
        .iter()
        .all(|work| work.status == WorkStatus::Completed));
    let results = persisted
        .work
        .iter()
        .map(|work| work.result_message_id.clone().unwrap())
        .collect::<BTreeSet<_>>();
    assert_eq!(results, BTreeSet::from([first_result.id, second_result.id]));
    assert!(!reopened.group_has_pending(fixture.id()).unwrap());
    assert!(reopened.claim_member_turn(&fixture.task).unwrap().is_none());
}

#[test]
fn member_can_address_another_member_and_reply_directly_to_the_original_author() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator");
    let methods = fixture.member("Methods");
    let question = fixture.message(
        &actor(coordinator),
        MessageDraft {
            body: "Does run r002 use the test split?".into(),
            recipients: vec![methods.into()],
            request_work: true,
            ..Default::default()
        },
    );
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(turn.member.id, methods);
    assert_eq!(turn.messages, vec![question.clone()]);

    let reply = fixture.message(
        &GroupActor {
            execution_id: Some(turn.execution.id.clone()),
            ..actor(methods)
        },
        MessageDraft {
            body: "It is a validation result; the manuscript needs a correction.".into(),
            reply_to: Some(question.id.clone()),
            ..Default::default()
        },
    );
    assert_eq!(reply.content.recipients, vec![coordinator.to_string()]);
    assert_eq!(
        reply.content.reply_to.as_deref(),
        Some(question.id.as_str())
    );
    let completion = fixture
        .store
        .finish_member_turn(
            &turn,
            &outcome("It is a validation result; the manuscript needs a correction."),
            None,
        )
        .unwrap();
    assert!(completion.content.recipients.is_empty());
    assert!(completion.content.reply_to.is_none());

    let follow_up = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(follow_up.member.id, coordinator);
    assert_eq!(follow_up.messages, vec![reply]);
    finish(&fixture.store, &follow_up);
    assert!(!fixture.store.group_has_pending(fixture.id()).unwrap());
}

#[test]
fn progress_reply_does_not_suppress_the_distinct_final_result() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator");
    let methods = fixture.member("Methods");
    let question = fixture.message(
        &actor(coordinator),
        request("Does run r002 use the test split?", &[methods]),
    );
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(turn.member.id, methods);

    let progress = fixture.message(
        &GroupActor {
            execution_id: Some(turn.execution.id.clone()),
            ..actor(methods)
        },
        MessageDraft {
            body: "I found the run record and am checking the split configuration.".into(),
            reply_to: Some(question.id.clone()),
            ..Default::default()
        },
    );
    assert_eq!(progress.content.recipients, vec![coordinator.to_string()]);
    let completion = fixture
        .store
        .finish_member_turn(
            &turn,
            &outcome("Run r002 uses the test split; the manuscript needs a correction."),
            None,
        )
        .unwrap();
    assert_eq!(completion.author.id, methods);
    assert_eq!(completion.content.recipients, vec![coordinator.to_string()]);
    assert_eq!(
        completion.content.reply_to.as_deref(),
        Some(question.id.as_str())
    );
    assert_ne!(completion.id, progress.id);

    let follow_up = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(follow_up.member.id, coordinator);
    assert_eq!(
        follow_up
            .messages
            .iter()
            .map(|message| &message.id)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([&progress.id, &completion.id])
    );
    finish(&fixture.store, &follow_up);
    assert!(!fixture.store.group_has_pending(fixture.id()).unwrap());
}

#[test]
fn nested_delegation_keeps_the_original_requester_waiting_until_the_final_reply() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    let explorer = fixture.member("Explorer").to_owned();
    let original = fixture.message(
        &GroupActor::user(),
        request("Resolve the evidence question", &[&coordinator]),
    );

    let coordinator_wait = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(coordinator_wait.member.id, coordinator);
    assert_eq!(coordinator_wait.messages, vec![original.clone()]);
    let coordinator_actor = GroupActor {
        execution_id: Some(coordinator_wait.execution.id.clone()),
        ..actor(&coordinator)
    };
    let to_methods = fixture.message(
        &coordinator_actor,
        request("Check the underlying evidence", &[&methods]),
    );
    fixture
        .store
        .finish_member_turn(
            &coordinator_wait,
            &waiting_outcome("Waiting for Methods"),
            None,
        )
        .unwrap();

    let waiting = fixture.snapshot();
    assert_eq!(
        waiting
            .executions
            .iter()
            .find(|execution| execution.id == coordinator_wait.execution.id)
            .unwrap()
            .status,
        "waiting"
    );
    assert_eq!(
        waiting
            .work
            .iter()
            .find(|work| work.cause_id == original.id)
            .unwrap()
            .status,
        WorkStatus::Waiting
    );
    assert_eq!(
        waiting
            .work
            .iter()
            .find(|work| work.cause_id == to_methods.id)
            .unwrap()
            .status,
        WorkStatus::Pending
    );
    let coordinator_waiting_message = waiting
        .messages
        .iter()
        .find(|message| {
            message.author.execution_id == Some(coordinator_wait.execution.id.clone())
                && message.content.recipients.is_empty()
        })
        .expect("the waiting execution should retain a non-delivered status record");
    assert!(!coordinator_waiting_message.content.request_work);
    assert!(!coordinator_waiting_message
        .content
        .recipients
        .contains(&coordinator));

    let methods_wait = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(methods_wait.member.id, methods);
    assert_eq!(methods_wait.messages, vec![to_methods.clone()]);
    let methods_actor = GroupActor {
        execution_id: Some(methods_wait.execution.id.clone()),
        ..actor(&methods)
    };
    let to_explorer = fixture.message(
        &methods_actor,
        request("Resolve the independent evidence question", &[&explorer]),
    );
    fixture
        .store
        .finish_member_turn(
            &methods_wait,
            &waiting_outcome("Waiting for Explorer"),
            None,
        )
        .unwrap();

    let nested = fixture.snapshot();
    assert_eq!(
        nested
            .executions
            .iter()
            .find(|execution| execution.id == methods_wait.execution.id)
            .unwrap()
            .status,
        "waiting"
    );
    assert_eq!(
        nested
            .work
            .iter()
            .find(|work| work.cause_id == to_methods.id)
            .unwrap()
            .status,
        WorkStatus::Waiting
    );
    assert_eq!(
        nested
            .work
            .iter()
            .find(|work| work.cause_id == to_explorer.id)
            .unwrap()
            .status,
        WorkStatus::Pending
    );
    assert!(nested
        .messages
        .iter()
        .any(|message| message.id == original.id));
    assert!(nested
        .messages
        .iter()
        .any(|message| message.id == to_methods.id));
    assert!(nested
        .messages
        .iter()
        .any(|message| message.id == to_explorer.id));
    let methods_waiting_message = nested
        .messages
        .iter()
        .find(|message| {
            message.author.execution_id == Some(methods_wait.execution.id.clone())
                && message.content.recipients.is_empty()
        })
        .expect("the nested waiting execution should retain a non-delivered status record");
    assert!(!methods_waiting_message.content.request_work);
    assert!(!methods_waiting_message
        .content
        .recipients
        .contains(&coordinator));
    assert!(
        !nested
            .messages
            .iter()
            .any(|message| message.author.id == methods
                && message.content.recipients.contains(&coordinator)),
        "a local yield must not reply before the delegated work finishes"
    );

    let explorer_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(explorer_turn.member.id, explorer);
    assert_eq!(explorer_turn.messages, vec![to_explorer.clone()]);
    let explorer_reply = fixture
        .store
        .finish_member_turn(
            &explorer_turn,
            &outcome("Explorer found the decisive evidence"),
            None,
        )
        .unwrap();
    assert_eq!(explorer_reply.author.id, explorer);
    assert_eq!(explorer_reply.content.recipients, vec![methods.clone()]);
    assert_eq!(
        explorer_reply.content.reply_to.as_deref(),
        Some(to_explorer.id.as_str())
    );

    let methods_finish = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(methods_finish.member.id, methods);
    assert_eq!(methods_finish.work.len(), 2);
    assert!(methods_finish
        .work
        .iter()
        .all(|work| work.status == WorkStatus::Running));
    assert_eq!(
        methods_finish
            .messages
            .iter()
            .map(|message| &message.id)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([&to_methods.id, &explorer_reply.id])
    );
    let final_reply = fixture
        .store
        .finish_member_turn(
            &methods_finish,
            &outcome("Methods integrated the final evidence"),
            None,
        )
        .unwrap();
    assert_eq!(final_reply.author.id, methods);
    assert_eq!(final_reply.content.recipients, vec![coordinator.clone()]);
    assert_eq!(
        final_reply.content.reply_to.as_deref(),
        Some(to_methods.id.as_str())
    );

    let coordinator_finish = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(coordinator_finish.member.id, coordinator);
    assert_eq!(coordinator_finish.work.len(), 2);
    assert!(coordinator_finish
        .work
        .iter()
        .all(|work| work.status == WorkStatus::Running));
    assert_eq!(
        coordinator_finish
            .messages
            .iter()
            .map(|message| &message.id)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([&original.id, &final_reply.id])
    );
    fixture
        .store
        .finish_member_turn(
            &coordinator_finish,
            &outcome("Coordinator integrated the final evidence"),
            None,
        )
        .unwrap();

    let finished = fixture.snapshot();
    assert_eq!(finished.executions.len(), 5);
    assert_eq!(
        finished
            .executions
            .iter()
            .filter(|execution| execution.status == "waiting")
            .count(),
        2
    );
    assert_eq!(
        finished
            .executions
            .iter()
            .filter(|execution| execution.status == "completed")
            .count(),
        3
    );
    assert!(finished
        .work
        .iter()
        .all(|work| work.status == WorkStatus::Completed));
    assert!(!fixture.store.group_has_pending(fixture.id()).unwrap());
}

#[test]
fn a_busy_member_keeps_distinct_new_messages_and_events_for_the_next_turn() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator");
    fixture.interest(coordinator, InterestKind::Path, "sections/results");
    let original = fixture.message(
        &GroupActor::user(),
        request("Check the recorded results", &[coordinator]),
    );
    let running = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(running.messages, vec![original]);
    let first = fixture.message(
        &GroupActor::user(),
        request("Also retain the negative result", &[coordinator]),
    );
    let second = fixture.message(
        &actor(fixture.member("Methods")),
        request("Explain the dataset split independently", &[coordinator]),
    );
    fixture.event(
        "results-v2",
        "file.changed",
        &GroupObject {
            kind: "file".into(),
            id: "sections/results/main.tex".into(),
            path: Some("sections/results/main.tex".into()),
            revision: Some("sha256-v2".into()),
        },
    );
    assert!(fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .is_none());
    let during = fixture.snapshot();
    assert_eq!(
        during
            .work
            .iter()
            .filter(|work| work.status == WorkStatus::Running)
            .count(),
        1
    );
    assert_eq!(
        during
            .work
            .iter()
            .filter(|work| work.status == WorkStatus::Pending)
            .count(),
        3
    );

    finish(&fixture.store, &running);
    let next = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(next.member.id, coordinator);
    assert_eq!(next.work.len(), 3);
    assert_eq!(
        next.messages
            .iter()
            .map(|message| &message.id)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([&first.id, &second.id])
    );
    assert_eq!(next.events.len(), 1);
    assert_eq!(next.events[0].object.revision.as_deref(), Some("sha256-v2"));
    finish(&fixture.store, &next);
    assert_eq!(fixture.snapshot().work.len(), 5);
    let response = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(response.member.id, fixture.member("Methods"));
    assert_eq!(response.messages.len(), 1);
    assert_eq!(
        response.messages[0].content.reply_to.as_deref(),
        Some(second.id.as_str())
    );
    finish(&fixture.store, &response);
    assert!(!fixture.store.group_has_pending(fixture.id()).unwrap());
}

#[test]
fn member_and_group_pause_keep_input_without_admitting_a_turn() {
    let fixture = Fixture::new();
    let methods = fixture.member("Methods");
    fixture
        .store
        .set_member_paused("paper", fixture.id(), methods, true)
        .unwrap();
    fixture.message(
        &GroupActor::user(),
        request("Check this while the member is paused", &[methods]),
    );
    assert!(!fixture.store.group_has_pending(fixture.id()).unwrap());
    assert!(fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .is_none());
    assert_eq!(fixture.snapshot().work[0].status, WorkStatus::Pending);

    fixture
        .store
        .set_group_status("paper", fixture.id(), GroupStatus::Paused)
        .unwrap();
    fixture
        .store
        .set_member_paused("paper", fixture.id(), methods, false)
        .unwrap();
    fixture.message(
        &GroupActor::user(),
        request("Keep this second question for resumption", &[methods]),
    );
    assert_eq!(fixture.snapshot().group.status, GroupStatus::Paused);
    assert!(fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .is_none());

    fixture
        .store
        .set_group_status("paper", fixture.id(), GroupStatus::Open)
        .unwrap();
    let resumed = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(resumed.messages.len(), 2);
    assert_eq!(resumed.work.len(), 2);
    finish(&fixture.store, &resumed);
}

#[test]
fn only_an_explicit_user_request_reopens_a_closed_group() {
    let fixture = Fixture::new();
    let methods = fixture.member("Methods");
    fixture.interest(methods, InterestKind::Event, "run.completed");
    fixture
        .store
        .set_group_status("paper", fixture.id(), GroupStatus::Closed)
        .unwrap();
    let object = GroupObject {
        kind: "run".into(),
        id: "r002".into(),
        revision: Some("original-result".into()),
        path: None,
    };
    assert!(fixture
        .event("run-r002", "run.completed", &object)
        .is_empty());
    let feedback = fixture.message(
        &GroupActor::user(),
        MessageDraft {
            body: "The explanation here was useful.".into(),
            recipients: vec![methods.into()],
            object: Some(object.clone()),
            ..Default::default()
        },
    );
    let undelivered = fixture.message(
        &actor(fixture.member("Explorer")),
        request("I suggest another check", &[methods]),
    );
    assert!(!fixture
        .store
        .message_has_work(fixture.id(), &undelivered.id)
        .unwrap());
    assert_eq!(fixture.snapshot().group.status, GroupStatus::Closed);
    assert!(fixture.snapshot().work.is_empty());
    assert!(!fixture.store.group_has_pending(fixture.id()).unwrap());

    let request = fixture.message(
        &GroupActor::user(),
        MessageDraft {
            body: "Recheck this old result against the current manuscript.".into(),
            recipients: vec![methods.into()],
            reply_to: Some(feedback.id),
            object: Some(object),
            request_work: true,
        },
    );
    assert_eq!(fixture.snapshot().group.status, GroupStatus::Open);
    assert!(fixture
        .store
        .message_has_work(fixture.id(), &request.id)
        .unwrap());
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(turn.member.id, methods);
    assert_eq!(turn.messages, vec![request]);
    finish(&fixture.store, &turn);
}

#[test]
fn a_user_request_on_an_old_revision_keeps_priority_over_later_member_work() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator");
    let methods = fixture.member("Methods");
    let user = fixture.message(
        &GroupActor::user(),
        MessageDraft {
            object: Some(GroupObject {
                kind: "decision".into(),
                id: "report-negative-results".into(),
                revision: Some("several-weeks-old".into()),
                path: Some("sections/results.tex".into()),
            }),
            ..request(
                "Revisit this decision and keep the counterexample",
                &[coordinator],
            )
        },
    );
    fixture.message(
        &actor(fixture.member("Explorer")),
        request("Try another comparison when available", &[methods]),
    );

    let first = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(first.member.id, coordinator);
    assert_eq!(first.messages, vec![user]);
    assert_eq!(first.work[0].priority, 100);
    finish(&fixture.store, &first);
    let second = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(second.member.id, methods);
    assert_eq!(second.work[0].priority, 50);
    finish(&fixture.store, &second);
}

#[test]
fn object_path_and_event_interests_route_changes_and_dedupe_only_the_same_event() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator");
    let methods = fixture.member("Methods");
    let explorer = fixture.member("Explorer");
    fixture.interest(coordinator, InterestKind::Path, "sections/methods");
    fixture.interest(methods, InterestKind::Object, "run:r002");
    fixture.interest(explorer, InterestKind::Event, "run.completed");

    let file = GroupObject {
        kind: "file".into(),
        id: "sections/methods/main.tex".into(),
        path: Some("sections/methods/main.tex".into()),
        revision: Some("methods-v2".into()),
    };
    assert_eq!(
        fixture.event("methods-v2", "file.changed", &file),
        vec![coordinator.to_string()]
    );
    assert!(fixture
        .event(
            "methods-other",
            "file.changed",
            &GroupObject {
                path: Some("sections/methods-other/main.tex".into()),
                ..file.clone()
            },
        )
        .is_empty());
    let run = GroupObject {
        kind: "run".into(),
        id: "r002".into(),
        revision: Some("result-v1".into()),
        path: None,
    };
    let routed = fixture.event("run-r002-result-v1", "run.completed", &run);
    assert_eq!(
        routed.into_iter().collect::<BTreeSet<_>>(),
        BTreeSet::from([methods.to_string(), explorer.to_string()])
    );
    assert!(fixture
        .event("run-r002-result-v1", "run.completed", &run)
        .is_empty());
    assert_eq!(fixture.snapshot().work.len(), 3);

    let mut seen = BTreeSet::new();
    while let Some(turn) = fixture.store.claim_member_turn(&fixture.task).unwrap() {
        assert!(seen.insert(turn.member.id.clone()));
        assert_eq!(turn.events.len(), 1);
        if turn.member.id == coordinator {
            assert_eq!(turn.events[0].object, file);
        } else {
            assert_eq!(turn.events[0].object, run);
        }
        finish(&fixture.store, &turn);
    }
    assert_eq!(
        seen,
        BTreeSet::from([
            coordinator.to_string(),
            methods.to_string(),
            explorer.to_string()
        ])
    );
}

#[test]
fn two_store_instances_cannot_claim_two_members_at_once() {
    let fixture = Fixture::new();
    let recipients = [
        fixture.member("Coordinator"),
        fixture.member("Methods"),
        fixture.member("Explorer"),
    ];
    fixture.message(
        &GroupActor::user(),
        request("Inspect this shared task", &recipients),
    );
    let barrier = Arc::new(Barrier::new(2));
    let handles = (0..2)
        .map(|_| {
            let store = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
            let task = fixture.task.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.claim_member_turn(&task).unwrap()
            })
        })
        .collect::<Vec<_>>();
    let mut winners = handles
        .into_iter()
        .filter_map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(winners.len(), 1);
    assert_eq!(fixture.snapshot().executions.len(), 1);
    let first = winners.pop().unwrap();
    let mut seen = BTreeSet::from([first.member.id.clone()]);
    finish(&fixture.store, &first);
    while let Some(turn) = fixture.store.claim_member_turn(&fixture.task).unwrap() {
        assert!(seen.insert(turn.member.id.clone()));
        finish(&fixture.store, &turn);
    }
    assert_eq!(seen, recipients.iter().map(|id| id.to_string()).collect());
    assert_eq!(fixture.snapshot().executions.len(), 3);
}

#[test]
fn recovery_preserves_causes_and_interrupted_execution_before_a_new_turn() {
    use oleafly_sandbox::process::identity::{ProcessIdentity, ProcessProbe};

    let fixture = Fixture::new();
    let methods = fixture.member("Methods");
    let original = fixture.message(
        &GroupActor::user(),
        request("Check the evidence", &[methods]),
    );
    let interrupted = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let later = fixture.message(
        &GroupActor::user(),
        request("Also check the negative result", &[methods]),
    );
    fixture
        .store
        .set_owner(
            &fixture.task.id,
            Some(ProcessIdentity {
                pid: u32::MAX - 1,
                started: Some(11),
            }),
        )
        .unwrap();
    let reopened = TaskStore {
        probe: |_| ProcessProbe::Gone,
        ..TaskStore::new(fixture.store.root().to_path_buf()).unwrap()
    };
    assert_eq!(reopened.recover_member_turns().unwrap(), 1);
    assert_eq!(reopened.recover_member_turns().unwrap(), 0);
    let recovered = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    assert_eq!(recovered.executions[0].status, "interrupted");
    assert!(recovered.executions[0].finished_at.is_some());
    assert!(recovered
        .work
        .iter()
        .all(|work| work.status == WorkStatus::Pending));
    assert!(reopened
        .finish_member_turn(&interrupted, &outcome("late result"), None)
        .is_err());

    let resumed = reopened.claim_member_turn(&fixture.task).unwrap().unwrap();
    assert_ne!(resumed.execution.id, interrupted.execution.id);
    assert_ne!(
        resumed.execution.session_id,
        interrupted.execution.session_id
    );
    assert_eq!(
        resumed
            .messages
            .iter()
            .map(|message| &message.id)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([&original.id, &later.id])
    );
    assert!(resumed
        .work
        .iter()
        .any(|work| work.id == interrupted.work[0].id));
    finish(&reopened, &resumed);
    assert!(!reopened.group_has_pending(fixture.id()).unwrap());
}

#[test]
fn execution_keeps_actual_model_and_distinguishes_unknown_usage_from_zero() {
    let fixture = Fixture::new();
    let methods = fixture.member("Methods");
    fixture.message(
        &GroupActor::user(),
        request("Check this result", &[methods]),
    );
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    fixture
        .store
        .bind_member_provider(&turn.execution.id, "actual-provider", "resolved-model")
        .unwrap();
    let mut result = outcome("The reported count was verified");
    result.input_tokens = Some(0);
    fixture
        .store
        .finish_member_turn(&turn, &result, None)
        .unwrap();
    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let snapshot = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    let execution = &snapshot.executions[0];
    assert_eq!(execution.provider_id.as_deref(), Some("actual-provider"));
    assert_eq!(execution.model_id, "resolved-model");
    assert_eq!(execution.input_tokens, Some(0));
    assert_eq!(execution.output_tokens, None);
    assert_eq!(execution.status, "completed");
    assert_eq!(
        snapshot
            .members
            .iter()
            .find(|member| member.id == methods)
            .unwrap()
            .config
            .model_id,
        "methods-model"
    );
}

#[test]
fn a_stale_task_snapshot_cannot_start_work_after_stop_or_in_a_later_generation() {
    let fixture = Fixture::new();
    fixture.message(
        &GroupActor::user(),
        request("Check this pending issue", &[fixture.member("Methods")]),
    );
    fixture
        .store
        .finish_failure(
            &fixture.task.id,
            fixture.task.execution_generation,
            "stopped",
        )
        .unwrap();
    assert!(fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .is_none());

    fixture
        .store
        .retry_with(&fixture.task.id, RetryMode::Fresh)
        .unwrap();
    fixture.store.request_start(&fixture.task.id).unwrap();
    let current = fixture.store.claim_next().unwrap().unwrap();
    assert!(current.execution_generation > fixture.task.execution_generation);
    assert!(fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .is_none());
    let turn = fixture.store.claim_member_turn(&current).unwrap().unwrap();
    assert_eq!(turn.execution.task_generation, current.execution_generation);
    finish(&fixture.store, &turn);
}

#[test]
fn local_group_does_not_need_a_task_but_cannot_cross_project_boundaries() {
    let fixture = Fixture::new();
    let local = fixture
        .store
        .create_task_group(
            "paper",
            None,
            &[member("Solo", "Operate the current project", true)],
        )
        .unwrap();
    assert_eq!(local.group.task_id, None);
    assert_eq!(local.members.len(), 1);
    let message = fixture
        .store
        .group_message(
            "paper",
            &local.group.id,
            &GroupActor::user(),
            &request("Inspect the current selection", &[]),
        )
        .unwrap();
    assert_eq!(
        message.content.recipients,
        vec![local.members[0].id.clone()]
    );
    assert!(fixture.store.group_has_pending(&local.group.id).unwrap());
    assert!(fixture
        .store
        .group_snapshot("other-project", &local.group.id, 0)
        .is_err());
    assert!(fixture
        .store
        .create_task_group(
            "other-project",
            Some(&fixture.task.id),
            &[member("Other", "Check another project", true)]
        )
        .is_err());
    let before = fixture.snapshot();
    assert!(fixture
        .store
        .group_message(
            "paper",
            fixture.id(),
            &GroupActor::user(),
            &request(
                "Wrong group recipient must not partially save",
                &[fixture.member("Methods"), &local.members[0].id]
            )
        )
        .is_err());
    assert!(fixture
        .store
        .group_message(
            "paper",
            fixture.id(),
            &actor(&local.members[0].id),
            &request("Wrong group author", &[fixture.member("Methods")])
        )
        .is_err());
    let after = fixture.snapshot();
    assert_eq!(after.messages, before.messages);
    assert_eq!(after.work, before.work);
}

#[test]
fn historical_annotation_is_retained_once_and_claimed_as_original_high_priority_work() {
    use crate::annotations::{
        AnnotationAuthor, AnnotationDraft, AnnotationHandlingDraft, AnnotationQuery,
        AnnotationStatus, AnnotationTarget,
    };

    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator");
    let methods = fixture.member("Methods");
    let explorer = fixture.member("Explorer");
    fixture.interest(explorer, InterestKind::Path, "sections/results");
    let target = AnnotationTarget::new("paper", "decision", "negative-results")
        .task(&fixture.task.id)
        .revision("historical-v1")
        .at_path("sections/results/main.tex");
    let body = "You already missed this counterexample. Recheck the old decision and retain negative results.";
    let annotation = fixture
        .store
        .group_annotation(
            fixture.id(),
            &AnnotationDraft::new(target.clone(), AnnotationAuthor::user("human"), body)
                .mention(methods)
                .request(),
        )
        .unwrap();
    // An ordinary member request cannot replace the user's priority or source
    // identity, even though it is submitted after the old-object annotation.
    fixture.message(
        &actor(explorer),
        request("Check a separate comparison", &[coordinator]),
    );

    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let retained = reopened
        .list_annotations(&AnnotationQuery::project("paper"))
        .unwrap();
    assert_eq!(retained, vec![annotation.clone()]);
    assert_eq!(retained[0].body, body);
    assert_eq!(retained[0].target, target);
    let snapshot = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    let routed = snapshot
        .work
        .iter()
        .filter(|work| work.cause_kind == "annotation")
        .collect::<Vec<_>>();
    assert_eq!(routed.len(), 2);
    assert_eq!(
        routed
            .iter()
            .map(|work| work.member_id.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([methods, explorer])
    );
    assert!(routed
        .iter()
        .all(|work| work.cause_id == annotation.id && work.priority == 100));
    assert!(!snapshot
        .messages
        .iter()
        .any(|message| message.content.body == body));

    let mut recipients = BTreeSet::new();
    for _ in 0..2 {
        let turn = reopened.claim_member_turn(&fixture.task).unwrap().unwrap();
        assert!(recipients.insert(turn.member.id.clone()));
        assert_eq!(turn.annotations, vec![annotation.clone()]);
        assert!(turn.messages.is_empty());
        let result = finish(&reopened, &turn);
        assert_eq!(
            reopened.annotation("paper", &annotation.id).unwrap().status,
            AnnotationStatus::Open,
            "completing a member turn is not a retained handling result"
        );
        if recipients.len() == 2 {
            reopened
                .record_annotation_handling(
                    "paper",
                    &AnnotationHandlingDraft {
                        annotation_id: annotation.id.clone(),
                        author: AnnotationAuthor::member(turn.member.id),
                        summary: "Checked the original decision and retained the counterexample"
                            .into(),
                        result_refs: vec![AnnotationTarget::new("paper", "message", result.id)
                            .task(&fixture.task.id)],
                    },
                )
                .unwrap();
        }
    }
    assert_eq!(
        recipients,
        BTreeSet::from([methods.to_string(), explorer.to_string()])
    );
    assert_eq!(
        reopened.annotation("paper", &annotation.id).unwrap().status,
        AnnotationStatus::Handled
    );
    let lower_priority = reopened.claim_member_turn(&fixture.task).unwrap().unwrap();
    assert_eq!(lower_priority.member.id, coordinator);
    assert!(lower_priority.annotations.is_empty());
    assert!(lower_priority.work.iter().all(|work| work.priority == 50));
    finish(&reopened, &lower_priority);
    let response = reopened.claim_member_turn(&fixture.task).unwrap().unwrap();
    assert_eq!(response.member.id, explorer);
    assert!(response
        .messages
        .iter()
        .all(|message| !message.content.request_work));
    finish(&reopened, &response);
    assert!(!reopened.group_has_pending(fixture.id()).unwrap());
}

#[test]
fn invalid_annotation_author_or_recipient_rolls_back_original_link_and_derived_work() {
    use crate::annotations::{
        AnnotationAuthor, AnnotationDraft, AnnotationQuery, AnnotationTarget,
    };

    let fixture = Fixture::new();
    let other = fixture
        .store
        .create_task_group(
            "paper",
            None,
            &[member("Other", "Check another conversation", true)],
        )
        .unwrap();
    let target = AnnotationTarget::new("paper", "decision", "retain-evidence")
        .task(&fixture.task.id)
        .revision("old-v1");
    let before = fixture.snapshot();
    let originals = fixture
        .store
        .list_annotations(&AnnotationQuery::project("paper"))
        .unwrap();
    let invalid_recipient = AnnotationDraft::new(
        target.clone(),
        AnnotationAuthor::user("human"),
        "This raw text must not persist after routing fails",
    )
    .mention(fixture.member("Methods"))
    .mention(&other.members[0].id)
    .request();
    assert!(fixture
        .store
        .group_annotation(fixture.id(), &invalid_recipient)
        .is_err());

    let invalid_author = AnnotationDraft::new(
        target,
        AnnotationAuthor::member(&other.members[0].id),
        "A member of another group cannot author this annotation",
    )
    .mention(fixture.member("Methods"))
    .request();
    assert!(fixture
        .store
        .group_annotation(fixture.id(), &invalid_author)
        .is_err());
    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let after = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    assert_eq!(after.messages, before.messages);
    assert_eq!(after.work, before.work);
    assert_eq!(after.executions, before.executions);
    assert_eq!(
        reopened
            .list_annotations(&AnnotationQuery::project("paper"))
            .unwrap(),
        originals
    );
}

#[test]
fn interrupting_a_turn_preserves_usage_and_requeues_the_same_causes_without_a_result() {
    let fixture = Fixture::new();
    let message = fixture.message(
        &GroupActor::user(),
        request(
            "Keep this check pending until it actually completes",
            &[fixture.member("Methods")],
        ),
    );
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let mut partial = outcome("Partial work is saved, but this check is not complete");
    partial.input_tokens = Some(0);
    partial.output_tokens = Some(7);
    fixture
        .store
        .interrupt_member_turn(&turn, Some(&partial))
        .unwrap();
    assert!(fixture.store.interrupt_member_turn(&turn, None).is_err());
    assert!(fixture
        .store
        .finish_member_turn(&turn, &partial, None)
        .is_err());
    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let snapshot = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    assert_eq!(snapshot.messages, vec![message.clone()]);
    assert_eq!(snapshot.executions[0].status, "interrupted");
    assert_eq!(snapshot.executions[0].input_tokens, Some(0));
    assert_eq!(snapshot.executions[0].output_tokens, Some(7));
    assert!(snapshot.executions[0].finished_at.is_some());
    assert_eq!(snapshot.work[0].id, turn.work[0].id);
    assert_eq!(snapshot.work[0].status, WorkStatus::Pending);
    assert!(snapshot.work[0].execution_id.is_none());
    assert!(snapshot.work[0].result_message_id.is_none());
    let resumed = reopened.claim_member_turn(&fixture.task).unwrap().unwrap();
    assert_ne!(resumed.execution.id, turn.execution.id);
    assert_eq!(resumed.work[0].id, turn.work[0].id);
    assert_eq!(resumed.messages, vec![message]);
    finish(&reopened, &resumed);
    assert!(!reopened.group_has_pending(fixture.id()).unwrap());
}

#[test]
fn pending_group_work_does_not_autoqueue_a_budget_stopped_task() {
    use crate::model::{StopReason, TaskIsolation, TaskIsolationKind, TaskResultMetadata};

    for reason in [
        None,
        Some(StopReason::BudgetTime),
        Some(StopReason::BudgetCost),
        Some(StopReason::BudgetRuns),
    ] {
        let fixture = Fixture::new();
        let workspace = fixture.store.root().join("saved-workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("main.tex"), "saved result").unwrap();
        let isolation = TaskIsolation {
            kind: TaskIsolationKind::StagedProject,
            execution_root: workspace.to_string_lossy().into_owned(),
            baseline_root: fixture
                .store
                .root()
                .join("baseline")
                .to_string_lossy()
                .into_owned(),
            source_revision: "snapshot:baseline".into(),
            baseline_hash: "baseline".into(),
            baseline: Vec::new(),
            allowed_paths: vec!["main.tex".into()],
            created_at: now_ms(),
            skipped: Vec::new(),
            initial_git_status: None,
            initial_git_status_complete: None,
        };
        assert!(fixture
            .store
            .set_isolation(
                &fixture.task.id,
                fixture.task.execution_generation,
                &isolation
            )
            .unwrap());
        if let Some(reason) = reason {
            assert!(fixture
                .store
                .set_stop_reason(&fixture.task.id, fixture.task.execution_generation, reason)
                .unwrap());
        }
        assert!(fixture
            .store
            .finish_success(
                &fixture.task.id,
                fixture.task.execution_generation,
                &TaskResultMetadata {
                    summary: "Saved before ending this generation".into(),
                    changed_files: Vec::new(),
                    artifacts: Vec::new(),
                    native_session_id: None,
                    input_tokens: None,
                    output_tokens: None,
                }
            )
            .unwrap());
        fixture.message(
            &GroupActor::user(),
            request("Recheck this retained result", &[fixture.member("Methods")]),
        );
        let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
        let queued = reopened.queue_group_followups().unwrap();
        let current = reopened.require(&fixture.task.id).unwrap();
        if let Some(reason) = reason {
            assert!(queued.is_empty());
            assert!(reopened.queue_group_followups().unwrap().is_empty());
            assert_eq!(current.status, ResearchTaskStatus::AwaitingReview);
            assert_eq!(current.stop_reason, Some(reason));
            assert!(!current.start_requested);
            assert!(current.pending_start.is_none());
        } else {
            assert_eq!(
                queued.len(),
                1,
                "ordinary pending work should still reconcile"
            );
            assert_eq!(queued[0].id, fixture.task.id);
            assert_eq!(current.status, ResearchTaskStatus::Queued);
            assert!(current.start_requested);
            assert!(current.pending_start.is_some());
        }
        assert_eq!(
            current.execution_generation,
            fixture.task.execution_generation
        );
        let snapshot = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
        assert_eq!(snapshot.work.len(), 1);
        assert_eq!(snapshot.work[0].status, WorkStatus::Pending);
        assert!(snapshot.executions.is_empty());
    }
}

#[test]
fn inbox_refresh_claims_late_sources_for_only_the_running_member() {
    use crate::annotations::{AnnotationAuthor, AnnotationDraft, AnnotationTarget};
    let fixture = Fixture::new();
    let methods = fixture.member("Methods");
    let explorer = fixture.member("Explorer");
    fixture.message(&GroupActor::user(), request("Initial check", &[methods]));
    let initial = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    fixture.interest(methods, InterestKind::Event, "run.completed");
    let direct = fixture.message(&GroupActor::user(), request("Also check this", &[methods]));
    let annotation = fixture
        .store
        .group_annotation(
            fixture.id(),
            &AnnotationDraft::new(
                AnnotationTarget::new("paper", "decision", "earlier").task(&fixture.task.id),
                AnnotationAuthor::user("human"),
                "Recheck the earlier decision",
            )
            .mention(methods)
            .request(),
        )
        .unwrap();
    fixture.event(
        "late-run",
        "run.completed",
        &GroupObject {
            kind: "run".into(),
            id: "r-late".into(),
            ..Default::default()
        },
    );
    fixture.message(&GroupActor::user(), request("Separate check", &[explorer]));
    let before = fixture.snapshot();
    let expected: BTreeSet<_> = before
        .work
        .iter()
        .filter(|w| w.member_id == methods)
        .map(|w| (w.id.clone(), w.priority))
        .collect();
    let refreshed = fixture
        .store
        .refresh_member_inbox(&fixture.task.id, fixture.task.execution_generation)
        .unwrap()
        .unwrap();
    assert_eq!(refreshed.execution.id, initial.execution.id);
    assert_eq!(
        refreshed
            .work
            .iter()
            .map(|w| (w.id.clone(), w.priority))
            .collect::<BTreeSet<_>>(),
        expected
    );
    assert!(refreshed
        .work
        .iter()
        .all(|w| w.status == WorkStatus::Running
            && w.execution_id.as_ref() == Some(&initial.execution.id)));
    assert!(refreshed.messages.contains(&direct));
    assert_eq!(refreshed.annotations, vec![annotation]);
    assert_eq!(refreshed.events.len(), 1);
    assert_eq!(
        fixture
            .store
            .refresh_member_inbox(&fixture.task.id, fixture.task.execution_generation)
            .unwrap()
            .unwrap()
            .work,
        refreshed.work
    );
    assert!(fixture
        .snapshot()
        .work
        .iter()
        .filter(|w| w.member_id == explorer)
        .all(|w| w.status == WorkStatus::Pending && w.execution_id.is_none()));
    assert_eq!(fixture.snapshot().executions.len(), 1);
    finish(&fixture.store, &refreshed);
    assert!(fixture
        .store
        .refresh_member_inbox(&fixture.task.id, fixture.task.execution_generation)
        .unwrap()
        .is_none());
    let next = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(next.member.id, explorer);
    assert!(next
        .work
        .iter()
        .all(|w| !expected.iter().any(|(id, _)| id == &w.id)));
    assert!(fixture
        .store
        .refresh_member_inbox("standalone-context", 1)
        .unwrap()
        .is_none());
}

#[test]
fn pending_group_work_admits_an_unstarted_task_once_and_paused_groups_hold() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::new(directory.path().join("tasks")).unwrap();
    let task = store
        .create(ResearchTaskDraft {
            project_id: "paper".into(),
            title: "New group task".into(),
            prompt: "Check the manuscript".into(),
            runtime_id: "fixture".into(),
            agent_id: "fixture-agent".into(),
            model_id: "fixture-model".into(),
            ..Default::default()
        })
        .unwrap();
    let group = store
        .create_task_group(
            "paper",
            Some(&task.id),
            &[member("Coordinator", "Integrate results", true)],
        )
        .unwrap();
    assert!(!task.start_requested);
    store
        .group_message(
            "paper",
            &group.group.id,
            &GroupActor::user(),
            &MessageDraft {
                body: "Background feedback only".into(),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(store.queue_group_followups().unwrap().is_empty());
    assert!(!store.require(&task.id).unwrap().start_requested);
    store
        .set_group_status("paper", &group.group.id, GroupStatus::Paused)
        .unwrap();
    store
        .group_message(
            "paper",
            &group.group.id,
            &GroupActor::user(),
            &request("Start checking", &[&group.members[0].id]),
        )
        .unwrap();
    assert!(store.queue_group_followups().unwrap().is_empty());
    assert!(!store.require(&task.id).unwrap().start_requested);
    store
        .set_group_status("paper", &group.group.id, GroupStatus::Open)
        .unwrap();
    let admitted = store.queue_group_followups().unwrap();
    assert_eq!(admitted.len(), 1);
    assert_eq!(admitted[0].id, task.id);
    assert!(admitted[0].start_requested);
    assert_eq!(admitted[0].status, ResearchTaskStatus::Queued);
    assert_eq!(admitted[0].execution_generation, task.execution_generation);
    assert_eq!(admitted[0].active_ms, task.active_ms);
    assert_eq!(admitted[0].pending_start, task.pending_start);
    assert!(store.queue_group_followups().unwrap().is_empty());
    assert_eq!(store.claim_next().unwrap().unwrap().id, task.id);
}

#[test]
fn per_work_requests_and_settlements_keep_unrelated_work_moving() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    let explorer = fixture.member("Explorer").to_owned();
    let original = fixture.message(
        &GroupActor::user(),
        request("Resolve the evidence question", &[&coordinator]),
    );
    fixture.message(
        &GroupActor::user(),
        request("Retain a separate limitation", &[&coordinator]),
    );
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(turn.member.id, coordinator);
    assert_eq!(turn.work.len(), 2);
    let original_work = turn
        .work
        .iter()
        .find(|work| work.cause_id == original.id)
        .unwrap()
        .clone();
    let other_work = turn
        .work
        .iter()
        .find(|work| work.id != original_work.id)
        .unwrap()
        .clone();
    let request = fixture
        .store
        .request_member_work(
            &turn,
            &request("Ask both colleagues", &[&methods, &explorer]),
            std::slice::from_ref(&original_work.id),
        )
        .unwrap();
    assert_eq!(request.content.recipients.len(), 2);
    assert!(fixture
        .store
        .member_execution_has_settlements(&turn.execution.id)
        .unwrap());
    assert!(!fixture
        .store
        .task_member_turn(&fixture.task.id, fixture.task.execution_generation)
        .unwrap()
        .unwrap()
        .work
        .is_empty());
    let waiting = fixture.snapshot();
    let original = waiting
        .work
        .iter()
        .find(|work| work.id == original_work.id)
        .unwrap();
    assert_eq!(original.status, WorkStatus::Waiting);
    assert_eq!(original.waits.len(), 1);
    assert_eq!(original.waits[0].request_message_id, request.id);
    assert_eq!(original.waits[0].work.len(), 2);
    assert_eq!(
        waiting
            .work
            .iter()
            .find(|work| work.id == other_work.id)
            .unwrap()
            .status,
        WorkStatus::Running
    );

    fixture
        .store
        .settle_member_work(
            &turn,
            &WorkSettlementDraft {
                work_ids: vec![other_work.id.clone()],
                status: WorkStatus::Completed,
                summary: "Retained the separate limitation.".into(),
                wait_for: Vec::new(),
                result_refs: Vec::new(),
            },
        )
        .unwrap();
    let partial = fixture.snapshot();
    assert_eq!(
        partial
            .work
            .iter()
            .find(|work| work.id == other_work.id)
            .unwrap()
            .status,
        WorkStatus::Completed
    );
    assert_eq!(
        partial
            .work
            .iter()
            .find(|work| work.id == original_work.id)
            .unwrap()
            .status,
        WorkStatus::Waiting
    );

    fixture
        .store
        .finish_member_turn(&turn, &outcome("Finished the explicit portion"), None)
        .unwrap();
    let finished = fixture.snapshot();
    assert_eq!(
        finished
            .executions
            .iter()
            .find(|execution| execution.id == turn.execution.id)
            .unwrap()
            .status,
        "waiting"
    );
    assert_eq!(
        finished
            .work
            .iter()
            .find(|work| work.id == original_work.id)
            .unwrap()
            .status,
        WorkStatus::Waiting
    );
    assert!(!finished.messages.iter().any(|message| {
        message.content.request_work
            && message.author.id == coordinator
            && message
                .content
                .body
                .contains("Finished the explicit portion")
    }));

    let methods_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_ne!(methods_turn.member.id, coordinator);
    let first_colleague = methods_turn.member.id.clone();
    fixture
        .store
        .finish_member_turn(&methods_turn, &outcome("Methods result"), None)
        .unwrap();
    assert_eq!(
        fixture
            .snapshot()
            .work
            .iter()
            .find(|work| work.id == original_work.id)
            .unwrap()
            .status,
        WorkStatus::Waiting,
        "one recipient finishing must not release the waiting work"
    );
    let explorer_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_ne!(explorer_turn.member.id, coordinator);
    assert_ne!(explorer_turn.member.id, first_colleague);
    fixture
        .store
        .finish_member_turn(&explorer_turn, &outcome("Explorer result"), None)
        .unwrap();
    let released = fixture
        .snapshot()
        .work
        .into_iter()
        .find(|work| work.id == original_work.id)
        .unwrap();
    assert_eq!(released.status, WorkStatus::Pending);
    assert_eq!(
        released
            .waits
            .iter()
            .flat_map(|wait| &wait.work)
            .map(|work| work.status)
            .collect::<Vec<_>>(),
        vec![WorkStatus::Completed, WorkStatus::Completed]
    );
}

#[test]
fn one_work_can_accumulate_two_requests_from_the_same_execution() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    let explorer = fixture.member("Explorer").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Resolve the evidence question", &[&coordinator]),
    );
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let work = turn.work[0].id.clone();
    let first = fixture
        .store
        .request_member_work(
            &turn,
            &request("Ask methods", &[&methods]),
            std::slice::from_ref(&work),
        )
        .unwrap();
    let second = fixture
        .store
        .request_member_work(
            &turn,
            &request("Ask explorer", &[&explorer]),
            std::slice::from_ref(&work),
        )
        .unwrap();
    let waiting = fixture
        .snapshot()
        .work
        .into_iter()
        .find(|item| item.id == work)
        .unwrap();
    assert_eq!(waiting.status, WorkStatus::Waiting);
    assert_eq!(
        waiting
            .waits
            .iter()
            .map(|wait| wait.request_message_id.as_str())
            .collect::<Vec<_>>(),
        vec![first.id.as_str(), second.id.as_str()]
    );
    assert_eq!(
        waiting
            .waits
            .iter()
            .flat_map(|wait| &wait.work)
            .map(|item| item.member_id.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([methods.as_str(), explorer.as_str()])
    );
}

#[test]
fn explicit_start_requeues_empty_waiting_work_for_the_same_task_group() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Settle one of these checks", &[&coordinator]),
    );
    fixture.message(
        &GroupActor::user(),
        request("Keep this check for the next run", &[&coordinator]),
    );
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let settled = turn.work[0].id.clone();
    let unreported = turn.work[1].id.clone();
    fixture
        .store
        .settle_member_work(
            &turn,
            &WorkSettlementDraft {
                work_ids: vec![settled.clone()],
                status: WorkStatus::Completed,
                summary: "Completed one check.".into(),
                wait_for: Vec::new(),
                result_refs: Vec::new(),
            },
        )
        .unwrap();
    fixture
        .store
        .finish_member_turn(&turn, &outcome("Finished the reported work"), None)
        .unwrap();
    let parked = fixture
        .snapshot()
        .work
        .into_iter()
        .find(|work| work.id == unreported)
        .unwrap();
    assert_eq!(parked.status, WorkStatus::Waiting);
    assert!(parked.waits.is_empty());
    fixture
        .store
        .open()
        .unwrap()
        .execute(
            "UPDATE research_tasks SET status = 'queued' WHERE id = ?1",
            [&fixture.task.id],
        )
        .unwrap();
    fixture.store.request_start(&fixture.task.id).unwrap();
    assert_eq!(
        fixture
            .snapshot()
            .work
            .into_iter()
            .find(|work| work.id == unreported)
            .unwrap()
            .status,
        WorkStatus::Pending
    );
    let running = fixture.store.claim_next().unwrap().unwrap();
    let resumed = fixture.store.claim_member_turn(&running).unwrap().unwrap();
    assert!(resumed.work.iter().any(|work| work.id == unreported));
}

#[test]
fn explicit_start_keeps_empty_waiting_work_when_a_stop_reason_remains() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator").to_owned();
    fixture.message(
        &GroupActor::user(),
        request(
            "Leave this check waiting after a budget stop",
            &[&coordinator],
        ),
    );
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let work = turn.work[0].id.clone();
    fixture
        .store
        .finish_member_turn(
            &turn,
            &waiting_outcome("Waiting for a later decision"),
            None,
        )
        .unwrap();
    fixture
        .store
        .open()
        .unwrap()
        .execute(
            "UPDATE research_tasks
             SET status = 'queued', stop_reason = 'budget_cost'
             WHERE id = ?1",
            [&fixture.task.id],
        )
        .unwrap();
    fixture.store.request_start(&fixture.task.id).unwrap();
    assert_eq!(
        fixture
            .snapshot()
            .work
            .into_iter()
            .find(|item| item.id == work)
            .unwrap()
            .status,
        WorkStatus::Waiting
    );
}

#[test]
fn resume_requeues_empty_waiting_work_but_preserves_dependency_waits() {
    use crate::model::{TaskIsolation, TaskIsolationKind};

    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Settle one of these resumed checks", &[&coordinator]),
    );
    fixture.message(
        &GroupActor::user(),
        request("Keep this resumed check for later", &[&coordinator]),
    );
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let settled = turn.work[0].id.clone();
    let unreported = turn.work[1].id.clone();
    fixture
        .store
        .settle_member_work(
            &turn,
            &WorkSettlementDraft {
                work_ids: vec![settled],
                status: WorkStatus::Completed,
                summary: "Completed one check.".into(),
                wait_for: Vec::new(),
                result_refs: Vec::new(),
            },
        )
        .unwrap();
    fixture
        .store
        .finish_member_turn(&turn, &outcome("Finished the reported work"), None)
        .unwrap();
    fixture.message(
        &GroupActor::user(),
        request("A dependency must remain waiting", &[&coordinator]),
    );
    let dependency = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let dependency_work = dependency.work[0].id.clone();
    let dependency_request = fixture
        .store
        .request_member_work(
            &dependency,
            &request(
                "Ask methods before the dependency can finish",
                &[fixture.member("Methods")],
            ),
            std::slice::from_ref(&dependency_work),
        )
        .unwrap();
    fixture
        .store
        .finish_member_turn(&dependency, &outcome("Delegated the dependency"), None)
        .unwrap();
    let workspace = fixture.store.root().join("resume-workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    assert!(fixture
        .store
        .set_isolation(
            &fixture.task.id,
            fixture.task.execution_generation,
            &TaskIsolation {
                kind: TaskIsolationKind::StagedProject,
                execution_root: workspace.to_string_lossy().into_owned(),
                baseline_root: fixture
                    .store
                    .root()
                    .join("resume-baseline")
                    .to_string_lossy()
                    .into_owned(),
                source_revision: "snapshot:resume".into(),
                baseline_hash: "resume".into(),
                baseline: Vec::new(),
                allowed_paths: Vec::new(),
                created_at: now_ms(),
                skipped: Vec::new(),
                initial_git_status: None,
                initial_git_status_complete: None,
            },
        )
        .unwrap());
    fixture
        .store
        .finish_failure(
            &fixture.task.id,
            fixture.task.execution_generation,
            "stopped",
        )
        .unwrap();
    fixture
        .store
        .retry_with(&fixture.task.id, RetryMode::Resume)
        .unwrap();
    let resumed = fixture.snapshot().work;
    assert_eq!(
        resumed
            .iter()
            .find(|work| work.id == unreported)
            .unwrap()
            .status,
        WorkStatus::Pending
    );
    let dependency = resumed
        .iter()
        .find(|work| work.id == dependency_work)
        .unwrap();
    assert_eq!(dependency.status, WorkStatus::Waiting);
    assert!(!dependency.waits.is_empty());
    assert!(dependency
        .waits
        .iter()
        .any(|wait| wait.request_message_id == dependency_request.id));
}

#[test]
fn mixed_targeted_and_legacy_waiting_binds_remaining_running_work() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Resolve the targeted question", &[&coordinator]),
    );
    fixture.message(
        &GroupActor::user(),
        request("Resolve the legacy question", &[&coordinator]),
    );
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let targeted = turn.work[0].id.clone();
    let legacy = turn.work[1].id.clone();
    let targeted_request = fixture
        .store
        .request_member_work(
            &turn,
            &request("Ask methods about the targeted question", &[&methods]),
            std::slice::from_ref(&targeted),
        )
        .unwrap();
    let legacy_request = fixture
        .store
        .group_message(
            "paper",
            fixture.id(),
            &GroupActor {
                kind: ActorKind::Member,
                id: coordinator.clone(),
                execution_id: Some(turn.execution.id.clone()),
            },
            &request("Also ask methods in the legacy way", &[&methods]),
        )
        .unwrap();
    fixture
        .store
        .finish_member_turn(
            &turn,
            &waiting_outcome("Waiting for both methods answers"),
            None,
        )
        .unwrap();
    let work = fixture.snapshot().work;
    let targeted = work.iter().find(|work| work.id == targeted).unwrap();
    let legacy = work.iter().find(|work| work.id == legacy).unwrap();
    assert_eq!(targeted.status, WorkStatus::Waiting);
    assert!(targeted
        .waits
        .iter()
        .any(|wait| wait.request_message_id == targeted_request.id));
    assert_eq!(legacy.status, WorkStatus::Waiting);
    assert!(legacy
        .waits
        .iter()
        .any(|wait| wait.request_message_id == legacy_request.id));
}

#[test]
fn plain_member_reply_does_not_create_an_acknowledgement_loop() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    let cause = fixture.message(
        &actor(&methods),
        MessageDraft {
            body: "Please inspect this without requesting another reply".into(),
            recipients: vec![coordinator],
            request_work: false,
            ..Default::default()
        },
    );
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    fixture
        .store
        .settle_member_work(
            &turn,
            &WorkSettlementDraft {
                work_ids: vec![turn.work[0].id.clone()],
                status: WorkStatus::Completed,
                summary: "Handled the plain member message.".into(),
                wait_for: Vec::new(),
                result_refs: Vec::new(),
            },
        )
        .unwrap();
    fixture
        .store
        .finish_member_turn(&turn, &outcome("Handled the plain member message"), None)
        .unwrap();
    let snapshot = fixture.snapshot();
    assert!(snapshot
        .work
        .iter()
        .find(|work| work.id == turn.work[0].id)
        .unwrap()
        .result_message_id
        .is_none());
    assert!(!snapshot
        .messages
        .iter()
        .any(|message| message.content.reply_to.as_deref() == Some(&cause.id)));
}

#[test]
fn failed_plain_member_reply_does_not_create_an_acknowledgement_loop() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    let cause = fixture.message(
        &actor(&methods),
        MessageDraft {
            body: "Please inspect this without requesting another reply".into(),
            recipients: vec![coordinator],
            request_work: false,
            ..Default::default()
        },
    );
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    fixture
        .store
        .finish_member_turn(
            &turn,
            &outcome("The plain member message could not be handled"),
            Some("provider failed"),
        )
        .unwrap();
    let snapshot = fixture.snapshot();
    assert!(snapshot
        .work
        .iter()
        .find(|work| work.id == turn.work[0].id)
        .unwrap()
        .result_message_id
        .is_none());
    assert!(!snapshot
        .messages
        .iter()
        .any(|message| message.content.reply_to.as_deref() == Some(&cause.id)));
}

#[test]
fn waiting_without_dependencies_is_private_fallback_and_can_be_rebound() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Resolve the first question", &[&coordinator]),
    );
    let first = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let work = first.work[0].clone();
    fixture
        .store
        .finish_member_turn(
            &first,
            &waiting_outcome("Paused for a later decision"),
            None,
        )
        .unwrap();
    let private = fixture
        .snapshot()
        .work
        .into_iter()
        .find(|item| item.id == work.id)
        .unwrap();
    assert_eq!(private.status, WorkStatus::Waiting);
    assert!(private.waits.is_empty());
    assert!(!fixture
        .store
        .member_execution_has_settlements(&first.execution.id)
        .unwrap());
    assert!(fixture
        .store
        .request_member_work(
            &first,
            &request("A finished turn cannot issue another request", &[&methods]),
            std::slice::from_ref(&work.id),
        )
        .is_err());
    let unrelated = fixture.message(
        &GroupActor::user(),
        request("Handle an unrelated second question", &[&coordinator]),
    );
    let second = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(second.member.id, coordinator);
    assert_eq!(second.work.len(), 1);
    assert_eq!(second.work[0].cause_id, unrelated.id);
    assert!(second.work.iter().all(|item| item.id != work.id));
    let request = fixture
        .store
        .request_member_work(
            &second,
            &request("Ask methods for the later decision", &[&methods]),
            &[second.work[0].id.clone()],
        )
        .unwrap();
    let second_waiting = second.work[0].id.clone();
    let colleague = fixture
        .store
        .group_snapshot("paper", fixture.id(), 0)
        .unwrap()
        .work
        .into_iter()
        .find(|item| item.id == second_waiting)
        .unwrap();
    assert_eq!(colleague.status, WorkStatus::Waiting);
    fixture
        .store
        .finish_member_turn(&second, &outcome("Delegated the second question"), None)
        .unwrap();
    let methods_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(methods_turn.member.id, methods);
    fixture
        .store
        .finish_member_turn(
            &methods_turn,
            &outcome("Methods supplied the decision"),
            None,
        )
        .unwrap();
    let third = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(third.member.id, coordinator);
    assert!(third.work.iter().all(|item| item.id != work.id));
    assert!(third.work.iter().any(|item| item.id == second_waiting));
    fixture
        .store
        .settle_member_work(
            &third,
            &WorkSettlementDraft {
                work_ids: vec![work.id.clone()],
                status: WorkStatus::Waiting,
                summary: "Still waiting on the explicit methods request.".into(),
                wait_for: vec![request.id.clone()],
                result_refs: Vec::new(),
            },
        )
        .unwrap_err();
    fixture
        .store
        .settle_member_work(
            &third,
            &WorkSettlementDraft {
                work_ids: vec![work.id.clone()],
                status: WorkStatus::Completed,
                summary: "Integrated the explicit methods decision.".into(),
                wait_for: Vec::new(),
                result_refs: Vec::new(),
            },
        )
        .unwrap();
    let rebound = fixture
        .snapshot()
        .work
        .into_iter()
        .find(|item| item.id == work.id)
        .unwrap();
    assert_eq!(rebound.status, WorkStatus::Completed);
    assert!(rebound
        .resolution
        .as_ref()
        .unwrap()
        .summary
        .contains("Integrated"));
}

#[test]
fn exact_group_message_record_is_scoped_to_project_task_and_group() {
    let fixture = Fixture::new();
    let message = fixture.message(
        &GroupActor::user(),
        request("Read this exact request", &[fixture.member("Coordinator")]),
    );
    assert_eq!(
        fixture
            .store
            .group_message_record("paper", &fixture.task.id, fixture.id(), &message.id)
            .unwrap(),
        Some(message.clone())
    );
    assert_eq!(
        fixture
            .store
            .group_message_record("paper", &fixture.task.id, fixture.id(), "message-missing")
            .unwrap(),
        None
    );
    assert!(fixture
        .store
        .group_message_record("paper", "other-task", fixture.id(), &message.id)
        .is_err());
}

#[test]
fn settlement_stamp_is_scoped_to_the_execution_that_used_it() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Resolve this request", &[&coordinator]),
    );
    let first = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let work = first.work[0].id.clone();
    fixture
        .store
        .settle_member_work(
            &first,
            &WorkSettlementDraft {
                work_ids: vec![work.clone()],
                status: WorkStatus::Waiting,
                summary: "Waiting for the delegated request.".into(),
                wait_for: vec![
                    fixture
                        .message(
                            &actor(&coordinator),
                            request("Delegate to methods", &[fixture.member("Methods")]),
                        )
                        .id,
                ],
                result_refs: Vec::new(),
            },
        )
        .unwrap_err();
    fixture
        .store
        .finish_member_turn(&first, &waiting_outcome("Waiting privately"), None)
        .unwrap();
    fixture
        .store
        .group_message(
            "paper",
            fixture.id(),
            &GroupActor::user(),
            &request("Unrelated work", &[&coordinator]),
        )
        .unwrap();
    let second = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(second.member.id, coordinator);
    assert!(second.work.iter().all(|item| item.id != work));
    assert!(!fixture
        .store
        .member_execution_has_settlements(&second.execution.id)
        .unwrap());
}

#[test]
fn failed_execution_fails_running_work_and_notifies_each_waiting_requester() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    let first = fixture.message(
        &actor(&coordinator),
        request("First evidence request", &[&methods]),
    );
    let second = fixture.message(
        &actor(&coordinator),
        request("Second evidence request", &[&methods]),
    );
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(turn.member.id, methods);
    assert_eq!(turn.work.len(), 2);
    let completed = turn.work[0].id.clone();
    fixture
        .store
        .settle_member_work(
            &turn,
            &WorkSettlementDraft {
                work_ids: vec![completed.clone()],
                status: WorkStatus::Completed,
                summary: "The first request completed before the failure.".into(),
                wait_for: Vec::new(),
                result_refs: Vec::new(),
            },
        )
        .unwrap();
    let failure = fixture
        .store
        .finish_member_turn(
            &turn,
            &outcome("The execution failed"),
            Some("provider failed"),
        )
        .unwrap();
    let snapshot = fixture.snapshot();
    assert_eq!(
        snapshot
            .executions
            .iter()
            .find(|execution| execution.id == turn.execution.id)
            .unwrap()
            .status,
        "failed"
    );
    let completed = snapshot
        .work
        .iter()
        .find(|work| work.id == completed)
        .unwrap();
    assert_eq!(completed.status, WorkStatus::Completed);
    let failed = snapshot
        .work
        .iter()
        .find(|work| work.id != completed.id)
        .unwrap();
    assert_eq!(failed.status, WorkStatus::Failed);
    assert_eq!(
        failed.resolution.as_ref().unwrap().summary,
        "provider failed"
    );
    assert_eq!(
        snapshot
            .messages
            .iter()
            .filter(|message| {
                message.content.body == "provider failed"
                    && message.content.reply_to.as_deref() == Some(&failed.cause_id)
                    && message.content.recipients == vec![coordinator.clone()]
            })
            .count(),
        1
    );
    assert_eq!(failure.content.reply_to.as_deref(), None);
    assert!(first.id == failed.cause_id || second.id == failed.cause_id);
}

#[test]
fn failed_user_request_persists_reply_without_a_member_recipient() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator").to_owned();
    let user_request = fixture.message(
        &GroupActor::user(),
        request("Resolve this user request", &[&coordinator]),
    );
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(turn.member.id, coordinator);

    fixture
        .store
        .finish_member_turn(
            &turn,
            &outcome("The execution failed"),
            Some("provider failed"),
        )
        .unwrap();

    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let snapshot = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    let failed = snapshot
        .work
        .iter()
        .find(|work| work.cause_id == user_request.id)
        .unwrap();
    assert_eq!(failed.status, WorkStatus::Failed);
    let reply_id = failed.result_message_id.as_ref().unwrap();
    let reply = snapshot
        .messages
        .iter()
        .find(|message| &message.id == reply_id)
        .unwrap();
    assert_eq!(reply.content.body, "provider failed");
    assert_eq!(
        reply.content.reply_to.as_deref(),
        Some(user_request.id.as_str())
    );
    assert!(reply.content.recipients.is_empty());
}

#[test]
fn version_fourteen_migration_adds_empty_settlement_fields_to_existing_work() {
    let fixture = Fixture::new();
    let methods = fixture.member("Methods").to_owned();
    let message = fixture.message(
        &GroupActor::user(),
        request("Preserve this legacy work", &[&methods]),
    );
    let before = fixture
        .snapshot()
        .work
        .into_iter()
        .find(|work| work.cause_id == message.id)
        .unwrap();
    let database = fixture.store.open().unwrap();
    database
        .execute_batch(
            "ALTER TABLE collaboration_work DROP COLUMN resolution_json;
             ALTER TABLE collaboration_work DROP COLUMN waits_json;
             ALTER TABLE collaboration_work DROP COLUMN settled_execution_id;
             PRAGMA user_version = 14;",
        )
        .unwrap();
    drop(database);

    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let database = reopened.open().unwrap();
    let version: i64 = database
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, crate::store::SCHEMA_VERSION);
    let columns = database
        .prepare("PRAGMA table_info(collaboration_work)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<BTreeSet<_>, _>>()
        .unwrap();
    assert!(columns.contains("resolution_json"));
    assert!(columns.contains("waits_json"));
    assert!(columns.contains("settled_execution_id"));
    drop(database);

    let after = reopened
        .group_snapshot("paper", fixture.id(), 0)
        .unwrap()
        .work
        .into_iter()
        .find(|work| work.id == before.id)
        .unwrap();
    assert_eq!(after.status, before.status);
    assert_eq!(after.cause_kind, before.cause_kind);
    assert_eq!(after.cause_id, before.cause_id);
    assert_eq!(after.reasons, before.reasons);
    assert!(after.resolution.is_none());
    assert!(after.waits.is_empty());
}
