use std::collections::BTreeSet;

use tempfile::TempDir;

use super::*;
use crate::annotations::{
    AnnotationAuthor, AnnotationDraft, AnnotationHandlingDraft, AnnotationTarget,
};
use crate::model::{ResearchTaskDraft, RetryMode, TaskResultMetadata};

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
        let group = store
            .create_task_group(
                "paper",
                Some(&task.id),
                &[
                    member(
                        "Coordinator",
                        "Advance the goal and integrate results",
                        true,
                    ),
                    member("Methods", "Check methods against evidence", false),
                    member("Explorer", "Investigate alternative approaches", false),
                ],
            )
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

    fn begin_turn(&self, task: &ResearchTask, member_id: &str, body: &str) -> MemberTurn {
        self.store
            .group_message(
                "paper",
                self.id(),
                &GroupActor::user(),
                &request(body, &[member_id]),
            )
            .unwrap();
        self.store.claim_member_turn(task).unwrap().unwrap()
    }

    fn finish_turn(&self, turn: &MemberTurn) {
        self.store
            .finish_member_turn(
                turn,
                &TaskRuntimeOutcome {
                    waiting_for_reply: false,
                    summary: "Completed the fixture work".into(),
                    artifacts: Vec::new(),
                    native_session_id: None,
                    input_tokens: None,
                    output_tokens: None,
                },
                None,
            )
            .unwrap();
    }

    fn record_attention(
        &self,
        task: &ResearchTask,
        object: &GroupObject,
        relation: &str,
        source_id: &str,
    ) {
        self.store
            .record_member_attention(
                &task.id,
                task.execution_generation,
                object,
                relation,
                source_id,
            )
            .unwrap();
    }

    fn event(&self, key: &str, object: &GroupObject) -> Vec<String> {
        self.store
            .record_group_event(
                "paper",
                self.id(),
                key,
                "file_changed",
                object,
                &GroupActor {
                    kind: ActorKind::System,
                    id: "workspace-observer".into(),
                    execution_id: None,
                },
                "The managed workspace changed.",
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

fn request(body: &str, recipients: &[&str]) -> MessageDraft {
    MessageDraft {
        body: body.into(),
        recipients: recipients.iter().map(|id| (*id).into()).collect(),
        request_work: true,
        ..Default::default()
    }
}

fn file(revision: &str) -> GroupObject {
    GroupObject {
        kind: "file".into(),
        id: "main.tex".into(),
        revision: Some(revision.into()),
        path: Some("main.tex".into()),
    }
}

fn file_at(path: impl Into<String>, revision: &str) -> GroupObject {
    let path = path.into();
    GroupObject {
        kind: "file".into(),
        id: path.clone(),
        revision: Some(revision.into()),
        path: Some(path),
    }
}

fn record_file(task: &ResearchTask, name: &str, revision: &str) -> GroupObject {
    file_at(format!("{}/{name}", task.record_dir()), revision)
}

fn target() -> AnnotationTarget {
    AnnotationTarget::new("paper", "file", "main.tex")
        .task("task-is-bound-by-the-fixture")
        .revision("H1")
        .at_path("main.tex")
}

fn reason_kinds(work: &GroupWork) -> BTreeSet<&str> {
    work.reasons
        .iter()
        .map(|reason| reason.kind.as_str())
        .collect()
}

fn annotation_work<'a>(snapshot: &'a GroupSnapshot, annotation_id: &str) -> Vec<&'a GroupWork> {
    snapshot
        .work
        .iter()
        .filter(|work| work.cause_kind == "annotation" && work.cause_id == annotation_id)
        .collect()
}

#[test]
fn observer_change_wakes_prior_reader_but_not_the_managed_writer() {
    let fixture = Fixture::new();
    let methods = fixture.member("Methods");
    let explorer = fixture.member("Explorer");

    let read_turn = fixture.begin_turn(&fixture.task, methods, "Read version one");
    fixture.record_attention(&fixture.task, &file("H1"), "read", "read-call-H1");
    fixture.finish_turn(&read_turn);

    let writer_read_turn = fixture.begin_turn(&fixture.task, explorer, "Read version one");
    fixture.record_attention(&fixture.task, &file("H1"), "read", "writer-read-call-H1");
    fixture.finish_turn(&writer_read_turn);

    let write_turn = fixture.begin_turn(&fixture.task, explorer, "Write version two");
    fixture.record_attention(&fixture.task, &file("H2"), "wrote", "write-call-H2");
    fixture.finish_turn(&write_turn);

    assert_eq!(
        fixture.event("main-H2", &file("H2")),
        vec![methods.to_string()]
    );

    let snapshot = fixture.snapshot();
    let event_work = snapshot
        .work
        .iter()
        .filter(|work| work.cause_kind == "event")
        .collect::<Vec<_>>();
    assert_eq!(event_work.len(), 1);
    assert_eq!(event_work[0].member_id, methods);
    assert_eq!(reason_kinds(event_work[0]), BTreeSet::from(["read"]));
    assert_eq!(
        event_work[0].reasons[0].source_id.as_deref(),
        Some("read-call-H1")
    );
    assert!(event_work.iter().all(|work| work.member_id != explorer));
}

#[test]
fn reading_a_newer_revision_makes_an_old_managed_write_changed_again() {
    let fixture = Fixture::new();
    let methods = fixture.member("Methods");

    let read_h1 = fixture.begin_turn(&fixture.task, methods, "Read version one");
    fixture.record_attention(&fixture.task, &file("H1"), "read", "read-call-H1");
    fixture.finish_turn(&read_h1);

    let write_h2 = fixture.begin_turn(&fixture.task, methods, "Write version two");
    fixture.record_attention(&fixture.task, &file("H2"), "wrote", "write-call-H2");
    fixture.finish_turn(&write_h2);

    let read_h3 = fixture.begin_turn(&fixture.task, methods, "Read version three");
    fixture.record_attention(&fixture.task, &file("H3"), "read", "read-call-H3");
    fixture.finish_turn(&read_h3);

    assert_eq!(
        fixture.event("main-H2-after-reading-H3", &file("H2")),
        vec![methods.to_string()]
    );
    let snapshot = fixture.snapshot();
    let work = snapshot
        .work
        .iter()
        .find(|work| work.cause_kind == "event" && work.member_id == methods)
        .unwrap();
    assert_eq!(reason_kinds(work), BTreeSet::from(["read", "wrote"]));
    assert!(work.reasons.iter().any(|reason| {
        reason.kind == "read"
            && reason.source_id.as_deref() == Some("read-call-H3")
            && reason
                .object
                .as_ref()
                .and_then(|object| object.revision.as_deref())
                == Some("H3")
    }));
    assert!(work.reasons.iter().any(|reason| {
        reason.kind == "wrote"
            && reason.source_id.as_deref() == Some("write-call-H2")
            && reason
                .object
                .as_ref()
                .and_then(|object| object.revision.as_deref())
                == Some("H2")
    }));
}

#[test]
fn repeating_the_latest_managed_revision_does_not_wake_its_writer() {
    let fixture = Fixture::new();
    let methods = fixture.member("Methods");

    let read_h1 = fixture.begin_turn(&fixture.task, methods, "Read version one");
    fixture.record_attention(&fixture.task, &file("H1"), "read", "read-call-H1");
    fixture.finish_turn(&read_h1);

    let write_h2 = fixture.begin_turn(&fixture.task, methods, "Write version two");
    fixture.record_attention(&fixture.task, &file("H2"), "wrote", "write-call-H2");
    fixture.finish_turn(&write_h2);

    assert!(fixture.event("main-H2-first", &file("H2")).is_empty());
    assert!(fixture.event("main-H2-repeat", &file("H2")).is_empty());
    assert!(fixture
        .snapshot()
        .work
        .iter()
        .all(|work| work.cause_kind != "event"));
}

#[test]
fn revisions_route_when_the_latest_managed_revision_alternates() {
    let fixture = Fixture::new();
    let methods = fixture.member("Methods");

    let read_h3 = fixture.begin_turn(&fixture.task, methods, "Read version three");
    fixture.record_attention(&fixture.task, &file("H3"), "read", "read-call-H3");
    fixture.finish_turn(&read_h3);
    assert_eq!(
        fixture.event("main-H2", &file("H2")),
        vec![methods.to_string()]
    );

    let read_h2 = fixture.begin_turn(&fixture.task, methods, "Read version two");
    fixture.record_attention(&fixture.task, &file("H2"), "read", "read-call-H2");
    fixture.finish_turn(&read_h2);
    assert_eq!(
        fixture.event("main-H3-again", &file("H3")),
        vec![methods.to_string()]
    );

    let event_work = fixture
        .snapshot()
        .work
        .into_iter()
        .filter(|work| work.cause_kind == "event" && work.member_id == methods)
        .collect::<Vec<_>>();
    assert_eq!(event_work.len(), 2);
    let sources = event_work
        .iter()
        .map(|work| {
            assert_eq!(reason_kinds(work), BTreeSet::from(["read"]));
            work.reasons[0].source_id.as_deref().unwrap()
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(sources, BTreeSet::from(["read-call-H2", "read-call-H3"]));
}

#[test]
fn explicit_interest_and_actual_attention_share_one_work_with_two_reasons() {
    let fixture = Fixture::new();
    let methods = fixture.member("Methods");
    fixture
        .store
        .set_member_interest(
            "paper",
            fixture.id(),
            &MemberInterest {
                member_id: methods.into(),
                kind: InterestKind::Object,
                value: "file:main.tex".into(),
            },
            true,
        )
        .unwrap();

    let read_turn = fixture.begin_turn(&fixture.task, methods, "Read the file");
    fixture.record_attention(&fixture.task, &file("H1"), "read", "read-call-H1");
    fixture.finish_turn(&read_turn);

    assert_eq!(
        fixture.event("main-H2", &file("H2")),
        vec![methods.to_string()]
    );
    let snapshot = fixture.snapshot();
    let event_work = snapshot
        .work
        .iter()
        .filter(|work| work.cause_kind == "event" && work.member_id == methods)
        .collect::<Vec<_>>();
    assert_eq!(event_work.len(), 1);
    assert_eq!(
        reason_kinds(event_work[0]),
        BTreeSet::from(["interest_object", "read"])
    );
}

#[test]
fn plain_annotation_feedback_does_not_route_from_attention_but_mentions_still_do() {
    let fixture = Fixture::new();
    let methods = fixture.member("Methods");

    let read_turn = fixture.begin_turn(&fixture.task, methods, "Read the target");
    fixture.record_attention(&fixture.task, &file("H1"), "read", "read-call-H1");
    fixture.finish_turn(&read_turn);

    let plain = fixture
        .store
        .group_annotation(
            fixture.id(),
            &AnnotationDraft::new(
                target().task(&fixture.task.id),
                AnnotationAuthor::user("human"),
                "This explanation is useful.",
            ),
        )
        .unwrap();
    let snapshot = fixture.snapshot();
    assert!(annotation_work(&snapshot, &plain.id).is_empty());

    let mentioned = fixture
        .store
        .group_annotation(
            fixture.id(),
            &AnnotationDraft::new(
                target().task(&fixture.task.id),
                AnnotationAuthor::user("human"),
                "Please retain this note.",
            )
            .mention(methods),
        )
        .unwrap();
    let snapshot = fixture.snapshot();
    let work = annotation_work(&snapshot, &mentioned.id);
    assert_eq!(work.len(), 1);
    assert_eq!(work[0].member_id, methods);
    assert_eq!(reason_kinds(work[0]), BTreeSet::from(["mention"]));
}

#[test]
fn own_coordination_updates_suppress_only_implicit_attention_routing() {
    let fixture = Fixture::new();
    let methods = fixture.member("Methods");
    let handoff_h1 = record_file(&fixture.task, "handoff.md", "H1");
    let plan_h1 = record_file(&fixture.task, "plan.md", "P1");

    let turn = fixture.begin_turn(&fixture.task, methods, "Update the task record");
    fixture.record_attention(&fixture.task, &handoff_h1, "read", "read-handoff-H1");
    fixture.record_attention(&fixture.task, &plan_h1, "wrote", "write-plan-P1");
    fixture.finish_turn(&turn);
    let before = fixture.snapshot();

    let handoff_h2 = record_file(&fixture.task, "handoff.md", "H2");
    let plan_h2 = record_file(&fixture.task, "plan.md", "P2");
    assert!(fixture.event("handoff-H2", &handoff_h2).is_empty());
    assert!(fixture.event("plan-P2", &plan_h2).is_empty());

    let after = fixture.snapshot();
    assert_eq!(
        after
            .events
            .iter()
            .map(|event| event.object.path.as_deref().unwrap())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            handoff_h2.path.as_deref().unwrap(),
            plan_h2.path.as_deref().unwrap(),
        ])
    );
    assert_eq!(after.attentions, before.attentions);
    assert!(after.work.iter().all(|work| work.cause_kind != "event"));
}

#[test]
fn explicit_interests_and_non_coordination_files_still_route() {
    let fixture = Fixture::new();
    let methods = fixture.member("Methods");
    let handoff_h1 = record_file(&fixture.task, "handoff.md", "H1");
    let plan_h1 = record_file(&fixture.task, "plan.md", "P1");
    fixture
        .store
        .set_member_interest(
            "paper",
            fixture.id(),
            &MemberInterest {
                member_id: methods.into(),
                kind: InterestKind::Path,
                value: handoff_h1.path.clone().unwrap(),
            },
            true,
        )
        .unwrap();
    fixture
        .store
        .set_member_interest(
            "paper",
            fixture.id(),
            &MemberInterest {
                member_id: methods.into(),
                kind: InterestKind::Object,
                value: format!("file:{}", plan_h1.id),
            },
            true,
        )
        .unwrap();
    let event_interest = MemberInterest {
        member_id: methods.into(),
        kind: InterestKind::Event,
        value: "file_changed".into(),
    };
    fixture
        .store
        .set_member_interest("paper", fixture.id(), &event_interest, true)
        .unwrap();

    let handoff_h2 = record_file(&fixture.task, "handoff.md", "H2");
    let plan_h2 = record_file(&fixture.task, "plan.md", "P2");
    assert_eq!(
        fixture.event("handoff-H2", &handoff_h2),
        vec![methods.to_string()]
    );
    assert_eq!(
        fixture.event("plan-P2", &plan_h2),
        vec![methods.to_string()]
    );
    let snapshot = fixture.snapshot();
    let event_work = snapshot
        .work
        .iter()
        .filter(|work| work.cause_kind == "event")
        .collect::<Vec<_>>();
    assert_eq!(event_work.len(), 2);
    assert_eq!(
        reason_kinds(event_work[0]),
        BTreeSet::from(["interest_event", "interest_path"])
    );
    assert_eq!(
        reason_kinds(event_work[1]),
        BTreeSet::from(["interest_event", "interest_object"])
    );

    fixture
        .store
        .set_member_interest("paper", fixture.id(), &event_interest, false)
        .unwrap();
    let ledger_h1 = record_file(&fixture.task, "ledger.tsv", "L1");
    let brief_h1 = record_file(&fixture.task, "brief.md", "B1");
    let notes_h1 = record_file(&fixture.task, "notes.md", "N1");
    let evidence_h1 = record_file(&fixture.task, "evidence.md", "E1");
    let other_handoff_h1 = file_at("research/another-task/handoff.md", "O1");
    let attention_turn = fixture.begin_turn(&fixture.task, methods, "Read task evidence");
    for (object, source) in [
        (&ledger_h1, "read-ledger-L1"),
        (&brief_h1, "read-brief-B1"),
        (&notes_h1, "read-notes-N1"),
        (&evidence_h1, "read-evidence-E1"),
        (&other_handoff_h1, "read-other-handoff-O1"),
    ] {
        fixture.record_attention(&fixture.task, object, "read", source);
    }
    fixture.finish_turn(&attention_turn);

    for (key, object) in [
        ("ledger-L2", file_at(ledger_h1.path.unwrap(), "L2")),
        ("brief-B2", file_at(brief_h1.path.unwrap(), "B2")),
        ("notes-N2", file_at(notes_h1.path.unwrap(), "N2")),
        ("evidence-E2", file_at(evidence_h1.path.unwrap(), "E2")),
        (
            "other-handoff-O2",
            file_at(other_handoff_h1.path.unwrap(), "O2"),
        ),
    ] {
        assert_eq!(fixture.event(key, &object), vec![methods.to_string()]);
        let snapshot = fixture.snapshot();
        let work = snapshot
            .work
            .iter()
            .find(|work| {
                work.cause_kind == "event"
                    && snapshot
                        .events
                        .iter()
                        .any(|event| event.id == work.cause_id && event.object.path == object.path)
            })
            .unwrap();
        assert_eq!(reason_kinds(work), BTreeSet::from(["read"]));
    }
}

#[test]
fn explicit_annotations_on_coordination_files_keep_high_priority_routing() {
    let fixture = Fixture::new();
    let coordinator = fixture.member("Coordinator");
    let handoff = record_file(&fixture.task, "handoff.md", "H1");
    let plan = record_file(&fixture.task, "plan.md", "P1");

    for (object, body) in [
        (&handoff, "Recheck the handoff decision."),
        (&plan, "Reconsider the current plan."),
    ] {
        let annotation = fixture
            .store
            .group_annotation(
                fixture.id(),
                &AnnotationDraft::new(
                    AnnotationTarget::new("paper", "file", &object.id)
                        .task(&fixture.task.id)
                        .revision(object.revision.clone().unwrap())
                        .at_path(object.path.clone().unwrap()),
                    AnnotationAuthor::user("human"),
                    body,
                )
                .request(),
            )
            .unwrap();
        let snapshot = fixture.snapshot();
        let work = annotation_work(&snapshot, &annotation.id);
        assert_eq!(work.len(), 1);
        assert_eq!(work[0].member_id, coordinator);
        assert_eq!(work[0].priority, 100);
        assert_eq!(reason_kinds(work[0]), BTreeSet::from(["coordinator"]));
    }

    let plain = fixture
        .store
        .group_annotation(
            fixture.id(),
            &AnnotationDraft::new(
                AnnotationTarget::new("paper", "file", &plan.id)
                    .task(&fixture.task.id)
                    .revision("P2")
                    .at_path(plan.path.clone().unwrap()),
                AnnotationAuthor::user("human"),
                "This plan is clear.",
            ),
        )
        .unwrap();
    assert!(annotation_work(&fixture.snapshot(), &plain.id).is_empty());
}

#[test]
fn cross_generation_request_uses_old_handling_without_waking_on_handling_itself() {
    let fixture = Fixture::new();
    let methods = fixture.member("Methods");
    let parent = fixture
        .store
        .group_annotation(
            fixture.id(),
            &AnnotationDraft::new(
                target().task(&fixture.task.id),
                AnnotationAuthor::user("human"),
                "Handle the original request.",
            )
            .mention(methods)
            .request(),
        )
        .unwrap();
    let handling_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(handling_turn.member.id, methods);
    let before_handling = fixture.snapshot();
    let handling = fixture
        .store
        .record_annotation_handling(
            "paper",
            &AnnotationHandlingDraft {
                annotation_id: parent.id.clone(),
                author: AnnotationAuthor::member(methods),
                summary: "Handled the original request.".into(),
                result_refs: Vec::new(),
            },
        )
        .unwrap();
    let after_handling = fixture.snapshot();
    assert_eq!(
        after_handling
            .work
            .iter()
            .map(|work| &work.id)
            .collect::<BTreeSet<_>>(),
        before_handling
            .work
            .iter()
            .map(|work| &work.id)
            .collect::<BTreeSet<_>>()
    );
    assert_eq!(after_handling.events.len(), before_handling.events.len());
    fixture.finish_turn(&handling_turn);

    fixture
        .store
        .finish_success(
            &fixture.task.id,
            fixture.task.execution_generation,
            &TaskResultMetadata {
                summary: "First generation complete".into(),
                changed_files: Vec::new(),
                artifacts: Vec::new(),
                native_session_id: None,
                input_tokens: None,
                output_tokens: None,
            },
        )
        .unwrap();
    fixture.store.request_cancel(&fixture.task.id).unwrap();
    fixture
        .store
        .retry_with(&fixture.task.id, RetryMode::Fresh)
        .unwrap();
    fixture.store.request_start(&fixture.task.id).unwrap();
    let next_task = fixture.store.claim_next().unwrap().unwrap();
    assert!(next_task.execution_generation > fixture.task.execution_generation);

    let current_members = fixture.snapshot().members;
    assert_eq!(
        current_members
            .iter()
            .find(|member| member.config.name == "Methods")
            .unwrap()
            .id,
        methods
    );

    let child = fixture
        .store
        .group_annotation(
            fixture.id(),
            &AnnotationDraft::new(
                target().task(&fixture.task.id),
                AnnotationAuthor::user("human"),
                "Recheck the old decision against the current result.",
            )
            .reply_to(&parent.id)
            .request(),
        )
        .unwrap();
    let mut skipped = BTreeSet::new();
    let turn = loop {
        let turn = fixture
            .store
            .claim_member_turn(&next_task)
            .unwrap()
            .expect("the explicit request must admit a member turn");
        if turn.annotations == vec![child.clone()] {
            break turn;
        }
        for work in &turn.work {
            assert!(
                skipped.insert(work.id.clone()),
                "the same pre-existing work was admitted twice"
            );
        }
        fixture.finish_turn(&turn);
    };
    assert_eq!(turn.member.id, methods);
    assert_eq!(
        turn.execution.task_generation,
        next_task.execution_generation
    );
    let child_work = turn
        .work
        .iter()
        .find(|work| work.cause_kind == "annotation" && work.cause_id == child.id)
        .unwrap();
    assert_eq!(
        reason_kinds(child_work),
        BTreeSet::from(["handled", "parent_handling"])
    );
    fixture.store.interrupt_member_turn(&turn, None).unwrap();

    let snapshot = fixture.snapshot();
    let work = annotation_work(&snapshot, &child.id);
    assert_eq!(work.len(), 1);
    assert_eq!(work[0].member_id, methods);
    assert_eq!(
        reason_kinds(work[0]),
        BTreeSet::from(["handled", "parent_handling"])
    );
    let handled_reason = work[0]
        .reasons
        .iter()
        .find(|reason| reason.kind == "handled")
        .unwrap();
    assert_eq!(
        handled_reason.source_id.as_deref(),
        Some(handling.id.as_str())
    );
    assert_eq!(
        handled_reason.execution_id.as_deref(),
        Some(handling_turn.execution.id.as_str())
    );
}

#[test]
fn pause_close_and_interrupt_preserve_event_cause_and_reasons_across_reopen() {
    let fixture = Fixture::new();
    let methods = fixture.member("Methods");
    let read_turn = fixture.begin_turn(&fixture.task, methods, "Read the file");
    fixture.record_attention(&fixture.task, &file("H1"), "read", "read-call-H1");
    fixture.finish_turn(&read_turn);

    fixture
        .store
        .set_member_paused("paper", fixture.id(), methods, true)
        .unwrap();
    assert_eq!(
        fixture.event("main-H2", &file("H2")),
        vec![methods.to_string()]
    );
    let pending = fixture.snapshot();
    let pending_event = pending
        .work
        .iter()
        .find(|work| work.cause_kind == "event")
        .unwrap()
        .clone();
    assert_eq!(pending_event.status, WorkStatus::Pending);
    assert_eq!(reason_kinds(&pending_event), BTreeSet::from(["read"]));
    assert!(fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .is_none());

    fixture
        .store
        .set_group_status("paper", fixture.id(), GroupStatus::Paused)
        .unwrap();
    fixture
        .store
        .set_group_status("paper", fixture.id(), GroupStatus::Closed)
        .unwrap();
    let before_closed_event = fixture.snapshot().work.len();
    assert!(fixture
        .event("main-H3-while-closed", &file("H3"))
        .is_empty());
    assert_eq!(
        fixture
            .snapshot()
            .work
            .iter()
            .filter(|work| work.member_id == methods)
            .count(),
        before_closed_event
    );
    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let closed = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    let closed_event = closed
        .work
        .iter()
        .find(|work| work.id == pending_event.id)
        .unwrap();
    assert_eq!(closed_event.status, WorkStatus::Pending);
    assert_eq!(closed_event.cause_id, pending_event.cause_id);
    assert_eq!(closed_event.reasons, pending_event.reasons);

    reopened
        .set_group_status("paper", fixture.id(), GroupStatus::Open)
        .unwrap();
    reopened
        .set_member_paused("paper", fixture.id(), methods, false)
        .unwrap();
    let turn = reopened.claim_member_turn(&fixture.task).unwrap().unwrap();
    assert_eq!(turn.member.id, methods);
    assert_eq!(turn.work.len(), 1);
    assert_eq!(turn.work[0].id, pending_event.id);
    reopened.interrupt_member_turn(&turn, None).unwrap();

    let after_interrupt = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    let requeued = after_interrupt
        .work
        .iter()
        .find(|work| work.id == pending_event.id)
        .unwrap();
    assert_eq!(requeued.status, WorkStatus::Pending);
    assert!(requeued.execution_id.is_none());
    assert_eq!(requeued.cause_id, pending_event.cause_id);
    assert_eq!(requeued.reasons, pending_event.reasons);

    reopened
        .set_group_status("paper", fixture.id(), GroupStatus::Closed)
        .unwrap();
    let reopened_again = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let persisted = reopened_again
        .group_snapshot("paper", fixture.id(), 0)
        .unwrap()
        .work
        .into_iter()
        .find(|work| work.id == pending_event.id)
        .unwrap();
    assert_eq!(persisted.status, WorkStatus::Pending);
    assert_eq!(persisted.cause_id, pending_event.cause_id);
    assert_eq!(persisted.reasons, pending_event.reasons);
}

#[test]
fn version_twelve_migration_adds_empty_work_reasons_and_attention_storage() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::new(directory.path().join("tasks")).unwrap();
    let task = store
        .create(ResearchTaskDraft {
            project_id: "paper".into(),
            title: "Migration fixture".into(),
            prompt: "Preserve existing group work".into(),
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
    store
        .group_message(
            "paper",
            &group.group.id,
            &GroupActor::user(),
            &request("Preserve this work", &[&group.members[0].id]),
        )
        .unwrap();
    let database = store.open().unwrap();
    database
        .execute_batch(
            "DROP TABLE collaboration_attentions;
             ALTER TABLE collaboration_work DROP COLUMN reasons_json;
             PRAGMA user_version = 12;",
        )
        .unwrap();
    drop(database);
    drop(store);

    let reopened = TaskStore::new(directory.path().join("tasks")).unwrap();
    let snapshot = reopened
        .group_snapshot("paper", &group.group.id, 0)
        .unwrap();
    let work = snapshot
        .work
        .iter()
        .find(|work| work.cause_kind == "message")
        .unwrap();
    assert!(work.reasons.is_empty());
    assert!(snapshot.attentions.is_empty());

    let table_exists: bool = reopened
        .open()
        .unwrap()
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                WHERE type = 'table' AND name = 'collaboration_attentions'
             )",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(table_exists);
}
