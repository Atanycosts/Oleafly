use std::collections::BTreeSet;

use tempfile::TempDir;

use super::*;
use crate::annotations::AnnotationTarget;
use crate::collaboration::{
    ActorKind, GroupActor, GroupEvent, GroupObject, GroupStatus, MemberCheckpointRequest,
    MemberDraft, MemberTurn, MessageDraft, WorkStatus,
};
use crate::model::{ResearchTaskDraft, TaskRuntimeOutcome};
use crate::responsibility::{
    ResponsibilityAssessment, ResponsibilityBatch, ResponsibilityDecision, ResponsibilityResponse,
};

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
                title: "Check a long-running member handoff".into(),
                prompt: "Complete the requested evidence check".into(),
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
                    member("Coordinator", "Own the task and integrate findings", true),
                    member("Methods", "Check methods against evidence", false),
                    member("Explorer", "Inspect independent evidence", false),
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

    fn message(&self, author: &GroupActor, draft: MessageDraft) -> GroupMessage {
        self.store
            .group_message("paper", self.id(), author, &draft)
            .unwrap()
    }

    fn file_event(&self, path: &str, revision: &str) -> GroupEvent {
        let object = GroupObject {
            kind: "file".into(),
            id: path.into(),
            revision: Some(revision.into()),
            path: Some(path.into()),
        };
        self.store
            .record_group_file_change("paper", self.id(), &object)
            .unwrap();
        self.snapshot()
            .events
            .into_iter()
            .find(|event| event.kind == "file_changed" && event.object == object)
            .unwrap()
    }
}

fn member(name: &str, responsibility: &str, coordinator: bool) -> MemberDraft {
    MemberDraft {
        name: name.into(),
        responsibility: responsibility.into(),
        runtime_id: "builtin".into(),
        agent_id: "fixture-agent".into(),
        model_id: format!("{}-model", name.to_lowercase()),
        skill_ids: Vec::new(),
        coordinator,
    }
}

fn execution_actor(turn: &MemberTurn) -> GroupActor {
    GroupActor {
        kind: ActorKind::Member,
        id: turn.member.id.clone(),
        execution_id: Some(turn.execution.id.clone()),
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
        waiting_for_reply: false,
        checkpoint: None,
        artifacts: Vec::new(),
        native_session_id: None,
        input_tokens: None,
        output_tokens: None,
    }
}

fn waiting_outcome(summary: &str) -> TaskRuntimeOutcome {
    TaskRuntimeOutcome {
        waiting_for_reply: true,
        ..outcome(summary)
    }
}

fn checkpoint_outcome(summary: &str, request: MemberCheckpointRequest) -> TaskRuntimeOutcome {
    TaskRuntimeOutcome {
        checkpoint: Some(request),
        ..outcome(summary)
    }
}

fn assessment(batch: &ResponsibilityBatch, member: &str) -> ResponsibilityAssessment {
    ResponsibilityAssessment {
        provider_id: Some("fixture".into()),
        model_id: Some("fixture-model".into()),
        effort: None,
        response: ResponsibilityResponse {
            decisions: vec![ResponsibilityDecision {
                event_id: batch.inputs[0].event.id.clone(),
                member_id: member.into(),
                reason: "The changed evidence requires an independent methods check.".into(),
            }],
        },
        input_tokens: Some(20),
        output_tokens: Some(5),
        error: None,
    }
}

fn empty_assessment() -> ResponsibilityAssessment {
    ResponsibilityAssessment {
        provider_id: Some("fixture".into()),
        model_id: Some("fixture-model".into()),
        effort: None,
        response: ResponsibilityResponse {
            decisions: Vec::new(),
        },
        input_tokens: Some(20),
        output_tokens: Some(2),
        error: None,
    }
}

fn work<'a>(snapshot: &'a GroupSnapshot, id: &str) -> &'a GroupWork {
    snapshot.work.iter().find(|work| work.id == id).unwrap()
}

fn event<'a>(turn: &'a MemberTurn, kind: &str) -> &'a GroupEvent {
    turn.events.iter().find(|event| event.kind == kind).unwrap()
}

fn evidence_contains(event: &GroupEvent, value: &str) -> bool {
    event
        .evidence
        .as_ref()
        .is_some_and(|evidence| evidence.to_string().contains(value))
        || event.detail.contains(value)
}

fn checkpoint_evidence(snapshot: &GroupSnapshot) -> Checkpoint {
    let event = snapshot
        .events
        .iter()
        .find(|event| event.kind == "member_checkpointed")
        .unwrap();
    serde_json::from_value(event.evidence.clone().unwrap()).unwrap()
}

#[test]
fn unmatched_checkpoint_releases_the_same_work_and_preserves_member_history() {
    let fixture = Fixture::new();
    let owner = fixture.member("Coordinator").to_owned();
    let original = fixture.message(
        &GroupActor::user(),
        request("Resolve the original evidence question", &[&owner]),
    );
    let owner_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(owner_turn.member.id, owner);
    let original_work = owner_turn.work[0].clone();
    let history = vec![
        oleafly_agent::Message::user("Retained owner context"),
        oleafly_agent::Message::user("Continue from the current evidence"),
    ];
    fixture
        .store
        .save_member_conversation(&owner_turn.execution.id, &history)
        .unwrap();

    let first = fixture.file_event("notes/first.md", "h1");
    let checkpoint = fixture
        .store
        .member_checkpoint_request(&owner_turn)
        .unwrap()
        .unwrap();
    assert_eq!(checkpoint.event_ids, vec![first.id.clone()]);
    fixture
        .store
        .checkpoint_member_turn(
            &owner_turn,
            &checkpoint_outcome("Checkpoint before matching", checkpoint),
        )
        .unwrap();

    // A later receipt is outside the immutable checkpoint input. It must not
    // prevent the owner from resuming after the frozen receipt is assessed.
    let later = fixture.file_event("notes/later.md", "h1");
    let batch = fixture
        .store
        .responsibility_batch(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(
        batch
            .inputs
            .iter()
            .map(|input| input.event.id.as_str())
            .collect::<Vec<_>>(),
        vec![first.id.as_str()]
    );
    fixture
        .store
        .commit_responsibility_assessment(&fixture.task, &batch, &empty_assessment())
        .unwrap();

    let checkpointed = fixture.snapshot();
    let retained_original = checkpointed
        .work
        .iter()
        .find(|work| work.id == original_work.id)
        .expect("the original work identity must survive the checkpoint");
    assert_eq!(retained_original.cause_id, original.id);
    assert_eq!(retained_original.cause_kind, "message");
    assert_eq!(retained_original.priority, 100);
    assert_eq!(retained_original.status, WorkStatus::Checkpointed);
    assert_eq!(
        checkpointed
            .executions
            .iter()
            .find(|execution| execution.id == owner_turn.execution.id)
            .unwrap()
            .status,
        "checkpointed"
    );

    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let resumed = reopened.claim_member_turn(&fixture.task).unwrap().unwrap();
    assert_eq!(resumed.member.id, owner);
    let resumed_original = resumed
        .work
        .iter()
        .find(|work| work.id == original_work.id)
        .expect("the resumed turn must include the original work");
    assert_eq!(resumed_original.cause_id, original.id);
    assert_eq!(resumed_original.status, WorkStatus::Running);
    let resumed_event = event(&resumed, "member_checkpoint_resumed");
    assert!(evidence_contains(resumed_event, &first.id));

    assert_eq!(
        reopened
            .member_conversation(
                &owner,
                &owner_turn.execution.runtime_id,
                &owner_turn.execution.model_id,
            )
            .unwrap()
            .unwrap(),
        history
    );
    let remaining = reopened
        .responsibility_batch(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(
        remaining
            .inputs
            .iter()
            .map(|input| input.event.id.as_str())
            .collect::<Vec<_>>(),
        vec![later.id.as_str()]
    );
}

#[test]
fn matched_colleague_runs_first_and_owner_resumes_with_result_references() {
    let fixture = Fixture::new();
    let owner = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    let original = fixture.message(
        &GroupActor::user(),
        request("Complete the owner task", &[&owner]),
    );
    let owner_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let original_work = owner_turn.work[0].clone();
    assert_eq!(original_work.cause_id, original.id);
    let changed = fixture.file_event("main.tex", "h1");
    let checkpoint = fixture
        .store
        .member_checkpoint_request(&owner_turn)
        .unwrap()
        .unwrap();
    fixture
        .store
        .checkpoint_member_turn(
            &owner_turn,
            &checkpoint_outcome("Checkpoint for methods review", checkpoint),
        )
        .unwrap();

    let batch = fixture
        .store
        .responsibility_batch(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(batch.inputs[0].event.id, changed.id);
    assert!(!batch.inputs[0].eligible_member_ids.contains(&owner));
    assert!(batch.inputs[0].eligible_member_ids.contains(&methods));
    fixture
        .store
        .commit_responsibility_assessment(&fixture.task, &batch, &assessment(&batch, &methods))
        .unwrap();

    let methods_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(methods_turn.member.id, methods);
    assert!(methods_turn
        .events
        .iter()
        .any(|event| event.id == changed.id));
    let before_colleague_finishes = fixture.snapshot();
    assert_eq!(
        work(&before_colleague_finishes, &original_work.id).status,
        WorkStatus::Checkpointed
    );
    assert!(before_colleague_finishes
        .work
        .iter()
        .find(|work| work.id == original_work.id)
        .unwrap()
        .result_message_id
        .is_none());

    let summary = "Methods confirmed the changed comparison and retained the counterexample.";
    let methods_result = fixture
        .store
        .finish_member_turn(&methods_turn, &outcome(summary), None)
        .unwrap();
    let after_colleague = fixture.snapshot();
    let methods_work = after_colleague
        .work
        .iter()
        .find(|work| work.member_id == methods && work.cause_id == changed.id)
        .unwrap();
    assert_eq!(methods_work.status, WorkStatus::Completed);
    assert_eq!(
        methods_work.result_message_id.as_deref(),
        Some(methods_result.id.as_str())
    );
    assert_eq!(
        work(&after_colleague, &original_work.id).status,
        WorkStatus::Checkpointed
    );

    let owner_resumed = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(owner_resumed.member.id, owner);
    assert!(owner_resumed
        .work
        .iter()
        .any(|work| work.id == original_work.id));
    assert_eq!(
        owner_resumed
            .work
            .iter()
            .find(|work| work.id == original_work.id)
            .unwrap()
            .status,
        WorkStatus::Running
    );
    let resumed = event(&owner_resumed, "member_checkpoint_resumed");
    assert!(evidence_contains(resumed, &methods_turn.execution.id));
    assert!(evidence_contains(resumed, &methods_result.id));
    assert!(evidence_contains(resumed, summary));

    fixture
        .store
        .finish_member_turn(
            &owner_resumed,
            &outcome("Integrated the methods result into the original task"),
            None,
        )
        .unwrap();
    assert_eq!(
        work(&fixture.snapshot(), &original_work.id).status,
        WorkStatus::Completed
    );
}

#[test]
fn checkpoint_handoff_prefers_resolution_and_preserves_result_refs_without_a_result_message() {
    let fixture = Fixture::new();
    let owner = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Complete the owner task", &[&owner]),
    );
    let owner_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let changed = fixture.file_event("main.tex", "h1");
    let checkpoint = fixture
        .store
        .member_checkpoint_request(&owner_turn)
        .unwrap()
        .unwrap();
    fixture
        .store
        .checkpoint_member_turn(
            &owner_turn,
            &checkpoint_outcome("Checkpoint for methods review", checkpoint),
        )
        .unwrap();

    let batch = fixture
        .store
        .responsibility_batch(&fixture.task)
        .unwrap()
        .unwrap();
    fixture
        .store
        .commit_responsibility_assessment(&fixture.task, &batch, &assessment(&batch, &methods))
        .unwrap();
    let methods_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(methods_turn.member.id, methods);
    let methods_work = methods_turn
        .work
        .iter()
        .find(|work| work.cause_id == changed.id)
        .unwrap()
        .clone();
    let summary = "Methods confirmed the changed comparison.";
    let reference = AnnotationTarget::new("paper", "file", "main.tex")
        .task(&fixture.task.id)
        .revision("h1");
    fixture
        .store
        .settle_member_work(
            &methods_turn,
            &crate::collaboration::WorkSettlementDraft {
                work_ids: vec![methods_work.id.clone()],
                status: WorkStatus::Completed,
                summary: summary.into(),
                wait_for: Vec::new(),
                result_refs: vec![reference.clone()],
            },
        )
        .unwrap();
    fixture
        .store
        .finish_member_turn(
            &methods_turn,
            &outcome("Methods completed the event work"),
            None,
        )
        .unwrap();

    let after_methods = fixture.snapshot();
    let settled = work(&after_methods, &methods_work.id);
    assert_eq!(settled.status, WorkStatus::Completed);
    assert!(settled.result_message_id.is_none());
    assert_eq!(settled.resolution.as_ref().unwrap().summary, summary);
    assert_eq!(
        settled.resolution.as_ref().unwrap().result_refs,
        vec![reference.clone()]
    );

    let owner_resumed = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(owner_resumed.member.id, owner);
    let resumed = event(&owner_resumed, "member_checkpoint_resumed");
    let handoff = &resumed.evidence.as_ref().unwrap()["handoff"][0];
    assert_eq!(handoff["summary"], summary);
    assert_eq!(
        handoff["resultRefs"][0],
        serde_json::to_value(reference).unwrap()
    );
}

#[test]
fn waiting_colleague_can_request_owner_without_releasing_the_original_checkpoint() {
    let fixture = Fixture::new();
    let owner = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Complete the owner task", &[&owner]),
    );
    let owner_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let original_work = owner_turn.work[0].clone();
    // A non-responsibility pending cause makes a checkpoint eligible without
    // fabricating a responsibility receipt. The owner still keeps its original
    // work out of every colleague turn.
    let methods_request = fixture.message(
        &GroupActor::user(),
        request(
            "Check the methods evidence before the owner continues",
            &[&methods],
        ),
    );
    let checkpoint = fixture
        .store
        .member_checkpoint_request(&owner_turn)
        .unwrap()
        .unwrap();
    assert!(checkpoint.event_ids.is_empty());
    fixture
        .store
        .checkpoint_member_turn(
            &owner_turn,
            &checkpoint_outcome("Checkpoint for explicit methods work", checkpoint),
        )
        .unwrap();

    let methods_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(methods_turn.member.id, methods);
    assert!(methods_turn
        .work
        .iter()
        .any(|work| work.cause_id == methods_request.id));
    let question = fixture.message(
        &execution_actor(&methods_turn),
        request("Please provide the original evidence decision", &[&owner]),
    );
    fixture
        .store
        .finish_member_turn(
            &methods_turn,
            &waiting_outcome("Waiting for the owner's direct evidence decision"),
            None,
        )
        .unwrap();

    let owner_direct = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(owner_direct.member.id, owner);
    assert_eq!(owner_direct.work.len(), 1);
    assert_eq!(owner_direct.work[0].cause_id, question.id);
    assert!(owner_direct
        .work
        .iter()
        .all(|work| work.id != original_work.id));
    assert_eq!(
        work(&fixture.snapshot(), &original_work.id).status,
        WorkStatus::Checkpointed
    );
    let reply = fixture
        .store
        .finish_member_turn(
            &owner_direct,
            &outcome("The owner supplied the requested evidence decision"),
            None,
        )
        .unwrap();
    assert_eq!(reply.content.recipients, vec![methods.clone()]);
    assert_eq!(
        reply.content.reply_to.as_deref(),
        Some(question.id.as_str())
    );

    let methods_finish = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(methods_finish.member.id, methods);
    assert!(methods_finish
        .messages
        .iter()
        .any(|message| message.id == reply.id));
    fixture
        .store
        .finish_member_turn(
            &methods_finish,
            &outcome("Methods completed the explicit evidence check"),
            None,
        )
        .unwrap();

    let owner_resumed = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(owner_resumed.member.id, owner);
    assert!(owner_resumed
        .work
        .iter()
        .all(|work| work.cause_id != methods_request.id));
    assert!(owner_resumed
        .work
        .iter()
        .any(|work| work.id == original_work.id));
    assert!(owner_resumed
        .events
        .iter()
        .any(|event| event.kind == "member_checkpoint_resumed"));
}

#[test]
fn read_receipt_does_not_freeze_the_owner_waiting_on_it() {
    let fixture = Fixture::new();
    let owner = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Resolve the original question", &[&owner]),
    );
    let owner_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let owner_work = owner_turn.work[0].id.clone();
    fixture
        .store
        .request_member_work(
            &owner_turn,
            &request("Check the methods evidence", &[&methods]),
            std::slice::from_ref(&owner_work),
        )
        .unwrap();
    fixture
        .store
        .finish_member_turn(
            &owner_turn,
            &waiting_outcome("Waiting for the methods evidence"),
            None,
        )
        .unwrap();

    let methods_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(methods_turn.member.id, methods);
    let methods_work = methods_turn.work[0].id.clone();
    fixture.file_event("main.tex", "h1");
    let checkpoint = fixture
        .store
        .member_checkpoint_request(&methods_turn)
        .unwrap()
        .unwrap();
    assert!(!checkpoint.event_ids.is_empty());
    fixture
        .store
        .checkpoint_member_turn(
            &methods_turn,
            &checkpoint_outcome("Reading the evidence", checkpoint),
        )
        .unwrap();

    let checkpointed = fixture.snapshot();
    assert_eq!(work(&checkpointed, &owner_work).status, WorkStatus::Waiting);
    assert!(checkpoint_evidence(&checkpointed)
        .colleague_work_ids
        .is_empty());
    let batch = fixture
        .store
        .responsibility_batch(&fixture.task)
        .unwrap()
        .unwrap();
    fixture
        .store
        .commit_responsibility_assessment(&fixture.task, &batch, &empty_assessment())
        .unwrap();

    let methods_resumed = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(methods_resumed.member.id, methods);
    assert!(methods_resumed
        .work
        .iter()
        .any(|work| work.id == methods_work));
    fixture
        .store
        .finish_member_turn(
            &methods_resumed,
            &outcome("Methods supplied the evidence"),
            None,
        )
        .unwrap();
    let owner_resumed = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(owner_resumed.member.id, owner);
    assert!(owner_resumed.work.iter().any(|work| work.id == owner_work));
}

#[test]
fn nested_waiters_do_not_freeze_onto_a_deeper_read_receipt() {
    let fixture = Fixture::new();
    let owner = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    let explorer = fixture.member("Explorer").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Resolve the original question", &[&owner]),
    );
    let owner_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let owner_work = owner_turn.work[0].id.clone();
    fixture
        .store
        .request_member_work(
            &owner_turn,
            &request("Ask methods", &[&methods]),
            std::slice::from_ref(&owner_work),
        )
        .unwrap();
    fixture
        .store
        .finish_member_turn(&owner_turn, &waiting_outcome("Waiting for methods"), None)
        .unwrap();

    let methods_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let methods_work = methods_turn.work[0].id.clone();
    fixture
        .store
        .request_member_work(
            &methods_turn,
            &request("Ask explorer", &[&explorer]),
            std::slice::from_ref(&methods_work),
        )
        .unwrap();
    fixture
        .store
        .finish_member_turn(
            &methods_turn,
            &waiting_outcome("Waiting for explorer"),
            None,
        )
        .unwrap();

    let explorer_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(explorer_turn.member.id, explorer);
    fixture.file_event("main.tex", "h1");
    let checkpoint = fixture
        .store
        .member_checkpoint_request(&explorer_turn)
        .unwrap()
        .unwrap();
    fixture
        .store
        .checkpoint_member_turn(
            &explorer_turn,
            &checkpoint_outcome("Reading the evidence", checkpoint),
        )
        .unwrap();

    let checkpointed = fixture.snapshot();
    assert!(checkpoint_evidence(&checkpointed)
        .colleague_work_ids
        .is_empty());
    assert_eq!(
        work(&checkpointed, &methods_work).status,
        WorkStatus::Waiting
    );
    assert_eq!(work(&checkpointed, &owner_work).status, WorkStatus::Waiting);
    let batch = fixture
        .store
        .responsibility_batch(&fixture.task)
        .unwrap()
        .unwrap();
    fixture
        .store
        .commit_responsibility_assessment(&fixture.task, &batch, &empty_assessment())
        .unwrap();

    let explorer_resumed = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(explorer_resumed.member.id, explorer);
    fixture
        .store
        .finish_member_turn(
            &explorer_resumed,
            &outcome("Explorer supplied the evidence"),
            None,
        )
        .unwrap();
    let methods_resumed = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(methods_resumed.member.id, methods);
    fixture
        .store
        .finish_member_turn(
            &methods_resumed,
            &outcome("Methods supplied the evidence"),
            None,
        )
        .unwrap();
    let owner_resumed = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(owner_resumed.member.id, owner);
    assert!(owner_resumed.work.iter().any(|work| work.id == owner_work));
}

#[test]
fn independent_pending_work_is_frozen_without_pulling_in_waiting_ancestors() {
    let fixture = Fixture::new();
    let owner = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    let explorer = fixture.member("Explorer").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Resolve the original question", &[&owner]),
    );
    let owner_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let owner_work = owner_turn.work[0].id.clone();
    fixture
        .store
        .request_member_work(
            &owner_turn,
            &request("Ask methods", &[&methods]),
            std::slice::from_ref(&owner_work),
        )
        .unwrap();
    fixture
        .store
        .finish_member_turn(&owner_turn, &waiting_outcome("Waiting for methods"), None)
        .unwrap();

    let methods_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let methods_work = methods_turn.work[0].id.clone();
    let independent = fixture.message(
        &GroupActor::user(),
        request("Check an independent result", &[&explorer]),
    );
    let independent_work = fixture
        .snapshot()
        .work
        .into_iter()
        .find(|work| work.cause_id == independent.id)
        .unwrap()
        .id;
    let stale_waits = serde_json::to_string(&vec![crate::collaboration::WorkWait {
        request_message_id: independent.id.clone(),
        work: vec![crate::collaboration::WorkWaitResult {
            work_id: methods_work.clone(),
            member_id: methods.clone(),
            status: WorkStatus::Completed,
            result_message_id: None,
        }],
    }])
    .unwrap();
    fixture
        .store
        .open()
        .unwrap()
        .execute(
            "UPDATE collaboration_work SET waits_json=?2 WHERE id=?1",
            params![independent_work, stale_waits],
        )
        .unwrap();

    fixture.file_event("main.tex", "h1");
    let checkpoint = fixture
        .store
        .member_checkpoint_request(&methods_turn)
        .unwrap()
        .unwrap();
    fixture
        .store
        .checkpoint_member_turn(
            &methods_turn,
            &checkpoint_outcome("Reading the evidence", checkpoint),
        )
        .unwrap();

    let checkpointed = fixture.snapshot();
    assert_eq!(
        checkpoint_evidence(&checkpointed).colleague_work_ids,
        vec![independent_work.clone()]
    );
    assert_eq!(work(&checkpointed, &owner_work).status, WorkStatus::Waiting);
    let batch = fixture
        .store
        .responsibility_batch(&fixture.task)
        .unwrap()
        .unwrap();
    fixture
        .store
        .commit_responsibility_assessment(&fixture.task, &batch, &empty_assessment())
        .unwrap();

    let explorer_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(explorer_turn.member.id, explorer);
    fixture
        .store
        .finish_member_turn(
            &explorer_turn,
            &outcome("Explorer completed the independent result"),
            None,
        )
        .unwrap();
    let methods_resumed = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(methods_resumed.member.id, methods);
    assert!(methods_resumed
        .work
        .iter()
        .any(|work| work.id == methods_work));
    assert_eq!(
        work(&fixture.snapshot(), &owner_work).status,
        WorkStatus::Waiting
    );
}

#[test]
fn preexisting_unreported_work_does_not_block_an_independent_checkpoint() {
    let fixture = Fixture::new();
    let owner = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    let explorer = fixture.member("Explorer").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Check this earlier result", &[&explorer]),
    );
    fixture.message(
        &GroupActor::user(),
        request("Keep this other question unfinished", &[&explorer]),
    );
    let earlier = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let unreported_id = earlier.work[1].id.clone();
    fixture
        .store
        .settle_member_work(
            &earlier,
            &crate::collaboration::WorkSettlementDraft {
                work_ids: vec![earlier.work[0].id.clone()],
                status: WorkStatus::Completed,
                summary: "The first result was checked.".into(),
                wait_for: Vec::new(),
                result_refs: Vec::new(),
            },
        )
        .unwrap();
    fixture
        .store
        .finish_member_turn(
            &earlier,
            &outcome("Only the first result was checked."),
            None,
        )
        .unwrap();
    let before = fixture.snapshot();
    let unreported = work(&before, &unreported_id).clone();
    assert_eq!(unreported.status, WorkStatus::Waiting);
    assert!(unreported.waits.is_empty());
    assert!(unreported.result_message_id.is_none());

    fixture.message(
        &GroupActor::user(),
        request("Complete the independent owner task", &[&owner]),
    );
    let owner_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let original_id = owner_turn.work[0].id.clone();
    let review = fixture.message(
        &GroupActor::user(),
        request("Check the independent methods result", &[&methods]),
    );
    let checkpoint = fixture
        .store
        .member_checkpoint_request(&owner_turn)
        .unwrap()
        .unwrap();
    assert!(checkpoint.event_ids.is_empty());
    fixture
        .store
        .checkpoint_member_turn(
            &owner_turn,
            &checkpoint_outcome("Wait for the independent check", checkpoint),
        )
        .unwrap();
    let methods_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    assert_eq!(methods_turn.member.id, methods);
    assert_eq!(methods_turn.work[0].cause_id, review.id);
    fixture
        .store
        .finish_member_turn(
            &methods_turn,
            &outcome("Methods checked the independent result."),
            None,
        )
        .unwrap();

    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let resumed = reopened
        .claim_member_turn(&fixture.task)
        .unwrap()
        .expect("An unrelated unreported item must not block the checkpoint handoff");
    assert_eq!(resumed.member.id, owner);
    assert!(resumed.work.iter().any(|work| work.id == original_id));
    let handoff = event(&resumed, "member_checkpoint_resumed");
    assert!(evidence_contains(
        handoff,
        "Methods checked the independent result."
    ));
    assert!(!evidence_contains(handoff, &unreported_id));
    let snapshot = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    assert_eq!(work(&snapshot, &unreported_id), &unreported);
    assert_eq!(
        checkpoint_evidence(&snapshot).colleague_work_ids,
        vec![methods_turn.work[0].id.clone()]
    );
    reopened
        .finish_member_turn(&resumed, &outcome("Integrated the methods result."), None)
        .unwrap();
    assert!(reopened.claim_member_turn(&fixture.task).unwrap().is_none());
    let snapshot = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    assert_eq!(work(&snapshot, &original_id).status, WorkStatus::Completed);
    assert_eq!(work(&snapshot, &unreported_id), &unreported);
}

#[test]
fn frozen_work_left_unreported_still_blocks_its_checkpoint() {
    let fixture = Fixture::new();
    let owner = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Complete the owner task", &[&owner]),
    );
    let owner_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let original_id = owner_turn.work[0].id.clone();
    for body in ["Check the methods result", "Check the other methods result"] {
        fixture.message(&GroupActor::user(), request(body, &[&methods]));
    }
    let checkpoint = fixture
        .store
        .member_checkpoint_request(&owner_turn)
        .unwrap()
        .unwrap();
    fixture
        .store
        .checkpoint_member_turn(
            &owner_turn,
            &checkpoint_outcome("Wait for both methods checks", checkpoint),
        )
        .unwrap();
    let methods_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let unreported_id = methods_turn.work[1].id.clone();
    fixture
        .store
        .settle_member_work(
            &methods_turn,
            &crate::collaboration::WorkSettlementDraft {
                work_ids: vec![methods_turn.work[0].id.clone()],
                status: WorkStatus::Completed,
                summary: "Only the first methods result was checked.".into(),
                wait_for: Vec::new(),
                result_refs: Vec::new(),
            },
        )
        .unwrap();
    fixture
        .store
        .finish_member_turn(
            &methods_turn,
            &outcome("The other check remains unfinished."),
            None,
        )
        .unwrap();

    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    assert!(reopened.claim_member_turn(&fixture.task).unwrap().is_none());
    let snapshot = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    assert_eq!(
        work(&snapshot, &original_id).status,
        WorkStatus::Checkpointed
    );
    assert_eq!(work(&snapshot, &unreported_id).status, WorkStatus::Waiting);
    assert!(work(&snapshot, &unreported_id).waits.is_empty());
    assert!(checkpoint_evidence(&snapshot)
        .colleague_work_ids
        .contains(&unreported_id));
    assert!(!snapshot
        .events
        .iter()
        .any(|event| event.kind == "member_checkpoint_resumed"));
}

#[test]
fn reopened_paused_or_closed_checkpoint_does_not_release_original_work() {
    let fixture = Fixture::new();
    let owner = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Complete the owner task", &[&owner]),
    );
    let owner_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let original_work = owner_turn.work[0].clone();
    fixture.file_event("main.tex", "h1");
    let checkpoint = fixture
        .store
        .member_checkpoint_request(&owner_turn)
        .unwrap()
        .unwrap();
    fixture
        .store
        .checkpoint_member_turn(
            &owner_turn,
            &checkpoint_outcome("Checkpoint before a paused review", checkpoint),
        )
        .unwrap();
    let batch = fixture
        .store
        .responsibility_batch(&fixture.task)
        .unwrap()
        .unwrap();
    fixture
        .store
        .commit_responsibility_assessment(&fixture.task, &batch, &assessment(&batch, &methods))
        .unwrap();
    let methods_work = fixture
        .snapshot()
        .work
        .into_iter()
        .find(|work| work.member_id == methods && work.cause_kind == "event")
        .unwrap();

    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    reopened
        .set_member_paused("paper", fixture.id(), &methods, true)
        .unwrap();
    assert!(reopened.claim_member_turn(&fixture.task).unwrap().is_none());
    let paused = reopened.group_snapshot("paper", fixture.id(), 0).unwrap();
    assert_eq!(
        work(&paused, &original_work.id).status,
        WorkStatus::Checkpointed
    );
    assert_eq!(work(&paused, &methods_work.id).status, WorkStatus::Pending);
    assert_eq!(
        paused
            .executions
            .iter()
            .find(|execution| execution.id == owner_turn.execution.id)
            .unwrap()
            .status,
        "checkpointed"
    );
    assert!(!paused
        .events
        .iter()
        .any(|event| event.kind == "member_checkpoint_resumed"));
    assert!(reopened
        .member_checkpoint_request(&owner_turn)
        .unwrap()
        .is_none());

    reopened
        .set_group_status("paper", fixture.id(), GroupStatus::Closed)
        .unwrap();
    // Closed groups must not release or claim work; the durable checkpoint
    // remains available for inspection and recovery.
    let _ = reopened.claim_member_turn(&fixture.task);
    let reopened_again = TaskStore::new(reopened.root().to_path_buf()).unwrap();
    let closed = reopened_again
        .group_snapshot("paper", fixture.id(), 0)
        .unwrap();
    assert_eq!(
        work(&closed, &original_work.id).status,
        WorkStatus::Checkpointed
    );
    assert_eq!(
        closed
            .work
            .iter()
            .filter(|work| work.status == WorkStatus::Checkpointed)
            .map(|work| work.id.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([original_work.id.as_str()])
    );
    assert!(!closed
        .events
        .iter()
        .any(|event| event.kind == "member_checkpoint_resumed"));
}

#[test]
fn stopped_or_applying_checkpoint_is_not_released_by_automatic_followup_reconciliation() {
    let fixture = Fixture::new();
    let owner = fixture.member("Coordinator").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Resolve the original question", &[&owner]),
    );
    let turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    fixture.file_event("notes/source.md", "v2");
    let checkpoint = fixture
        .store
        .member_checkpoint_request(&turn)
        .unwrap()
        .unwrap();
    fixture
        .store
        .checkpoint_member_turn(&turn, &checkpoint_outcome("Yielded", checkpoint))
        .unwrap();
    let batch = fixture
        .store
        .responsibility_batch(&fixture.task)
        .unwrap()
        .unwrap();
    fixture
        .store
        .commit_responsibility_assessment(&fixture.task, &batch, &empty_assessment())
        .unwrap();
    for (status, stop, cancel, apply) in [
        ("failed", None, 0, None),
        ("cancelled", None, 0, None),
        ("queued", Some("budget_cost"), 0, None),
        ("running", None, 1, None),
        ("awaiting_review", None, 0, Some("applying")),
    ] {
        fixture.store.open().unwrap().execute("UPDATE research_tasks SET status=?2,stop_reason=?3,cancel_requested=?4,apply_state=?5 WHERE id=?1",params![fixture.task.id,status,stop,cancel,apply]).unwrap();
        assert!(fixture.store.queue_group_followups().unwrap().is_empty());
        assert_eq!(
            fixture
                .snapshot()
                .work
                .iter()
                .find(|work| work.id == turn.work[0].id)
                .unwrap()
                .status,
            WorkStatus::Checkpointed
        );
        assert!(!fixture
            .snapshot()
            .events
            .iter()
            .any(|event| event.kind == "member_checkpoint_resumed"));
    }
}

#[test]
fn waiting_work_parks_without_freezing_settled_items() {
    use crate::model::{TaskIsolation, TaskIsolationKind};

    let fixture = Fixture::new();
    let owner = fixture.member("Coordinator").to_owned();
    let methods = fixture.member("Methods").to_owned();
    fixture.message(
        &GroupActor::user(),
        request("Complete the owner task", &[&owner]),
    );
    let owner_turn = fixture
        .store
        .claim_member_turn(&fixture.task)
        .unwrap()
        .unwrap();
    let workspace = fixture.store.root().join("waiting-workspace");
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
                    .join("waiting-baseline")
                    .to_string_lossy()
                    .into_owned(),
                source_revision: "snapshot:waiting".into(),
                baseline_hash: "waiting".into(),
                baseline: Vec::new(),
                allowed_paths: Vec::new(),
                created_at: now_ms(),
                skipped: Vec::new(),
                initial_git_status: None,
                initial_git_status_complete: None,
            },
        )
        .unwrap());
    let owner_work = owner_turn.work[0].id.clone();
    let request = fixture
        .store
        .request_member_work(
            &owner_turn,
            &request("Check the methods evidence", &[&methods]),
            std::slice::from_ref(&owner_work),
        )
        .unwrap();
    let mut finish = outcome("Waiting for the methods evidence");
    finish.waiting_for_reply = true;
    fixture
        .store
        .finish_member_turn(&owner_turn, &finish, None)
        .unwrap();
    let parked = fixture.snapshot();
    assert_eq!(work(&parked, &owner_work).status, WorkStatus::Waiting);
    assert_eq!(parked.executions[0].status, "waiting");
    assert!(parked
        .work
        .iter()
        .find(|work| work.cause_id == request.id)
        .is_some());
    assert!(fixture.store.park_member_checkpoint(&fixture.task).unwrap());
    assert_eq!(
        fixture.store.require(&fixture.task.id).unwrap().status,
        ResearchTaskStatus::Queued
    );
    assert!(
        !fixture
            .store
            .require(&fixture.task.id)
            .unwrap()
            .start_requested
    );
    fixture
        .store
        .open()
        .unwrap()
        .execute(
            "UPDATE research_tasks SET start_requested=1 WHERE id=?1",
            [&fixture.task.id],
        )
        .unwrap();
    let resumed_task = fixture.store.claim_next().unwrap().unwrap();
    assert_eq!(resumed_task.id, fixture.task.id);
    let methods_turn = fixture
        .store
        .claim_member_turn(&resumed_task)
        .unwrap()
        .unwrap();
    assert_eq!(methods_turn.member.id, methods);
    fixture
        .store
        .finish_member_turn(&methods_turn, &outcome("Methods completed the check"), None)
        .unwrap();
    let released = fixture
        .store
        .claim_member_turn(&resumed_task)
        .unwrap()
        .unwrap();
    assert_eq!(released.member.id, owner);
    assert!(released.work.iter().any(|work| work.id == owner_work));
}
