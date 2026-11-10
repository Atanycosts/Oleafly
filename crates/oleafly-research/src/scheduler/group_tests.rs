use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};

use super::*;
use crate::collaboration::{
    ActorKind, GroupActor, GroupObject, GroupSnapshot, GroupStatus, InterestKind, MemberDraft,
    MemberInterest, MessageDraft, WorkStatus,
};
use crate::responsibility::{
    ResponsibilityAssessment, ResponsibilityBatch, ResponsibilityDecision, ResponsibilityResponse,
};
use crate::test_support::{draft, FakeEnv, FakeHost, CHILD_PATIENCE};

const ORIGINAL: &str =
    "\\documentclass{article}\n\\begin{document}\nOriginal result.\n\\end{document}\n";
const REVISED: &str = "\\documentclass{article}\n\\begin{document}\nThe counterexample remains in the result.\n\\end{document}\n";

struct StartedTurn {
    context: TaskRunContext,
    complete: oneshot::Sender<Result<TaskRuntimeOutcome, String>>,
}

struct ControlledGroupRuntime {
    starts: mpsc::UnboundedSender<StartedTurn>,
    cancellations: Arc<Mutex<Vec<String>>>,
}

impl TaskRuntimeAdapter for ControlledGroupRuntime {
    fn supports(&self, agent_id: &str) -> bool {
        agent_id == "fixture-agent"
    }

    fn run(
        &self,
        context: TaskRunContext,
        _cancel: CancellationToken,
        _events: TaskEventSink,
    ) -> TaskRuntimeFuture<TaskRuntimeOutcome> {
        let (complete, result) = oneshot::channel();
        let sent = self
            .starts
            .send(StartedTurn { context, complete })
            .map_err(|_| "the test stopped observing member starts".to_string());
        Box::pin(async move {
            sent?;
            result
                .await
                .map_err(|_| "the test dropped the member result".to_string())?
        })
    }

    fn cancel(&self, session_id: String) -> TaskRuntimeFuture<()> {
        lock(&self.cancellations).push(session_id);
        Box::pin(async { Ok(()) })
    }
}

struct ControlledResponsibilityRuntime {
    starts: mpsc::UnboundedSender<StartedTurn>,
    assessments: mpsc::UnboundedSender<AssessmentRequest>,
    cancellations: Arc<Mutex<Vec<String>>>,
}

struct AssessmentRequest {
    batch: ResponsibilityBatch,
    reply: oneshot::Sender<Result<ResponsibilityAssessment, String>>,
}

impl AssessmentRequest {
    fn answer(self, decisions: Vec<ResponsibilityDecision>) {
        self.reply
            .send(Ok(ResponsibilityAssessment {
                provider_id: Some("fixture".into()),
                model_id: Some("Coordinator-model".into()),
                effort: None,
                response: ResponsibilityResponse { decisions },
                input_tokens: Some(7),
                output_tokens: Some(2),
                error: None,
            }))
            .unwrap();
    }
}

impl TaskRuntimeAdapter for ControlledResponsibilityRuntime {
    fn supports(&self, agent_id: &str) -> bool {
        agent_id == "fixture-agent"
    }

    fn run(
        &self,
        context: TaskRunContext,
        _cancel: CancellationToken,
        _events: TaskEventSink,
    ) -> TaskRuntimeFuture<TaskRuntimeOutcome> {
        let (complete, result) = oneshot::channel();
        let sent = self
            .starts
            .send(StartedTurn { context, complete })
            .map_err(|_| "the test stopped observing member starts".to_string());
        Box::pin(async move {
            sent?;
            result
                .await
                .map_err(|_| "the test dropped the member result".to_string())?
        })
    }

    fn cancel(&self, session_id: String) -> TaskRuntimeFuture<()> {
        lock(&self.cancellations).push(session_id);
        Box::pin(async { Ok(()) })
    }

    fn supports_responsibility_assessment(&self) -> bool {
        true
    }

    fn assess_responsibilities(
        &self,
        _context: TaskRunContext,
        batch: ResponsibilityBatch,
        _cancel: CancellationToken,
        _events: TaskEventSink,
    ) -> TaskRuntimeFuture<ResponsibilityAssessment> {
        let (reply, result) = oneshot::channel();
        let sent = self
            .assessments
            .send(AssessmentRequest { batch, reply })
            .map_err(|_| "the test stopped observing responsibility assessments".to_string());
        Box::pin(async move {
            sent?;
            result
                .await
                .map_err(|_| "the test dropped the responsibility result".to_string())?
        })
    }
}

struct GroupFixture {
    _directory: tempfile::TempDir,
    project: PathBuf,
    state: ResearchTaskState,
    task: ResearchTask,
    group: GroupSnapshot,
    starts: mpsc::UnboundedReceiver<StartedTurn>,
    base_cancellations: Arc<Mutex<Vec<String>>>,
    assessments: Option<mpsc::UnboundedReceiver<AssessmentRequest>>,
}

impl GroupFixture {
    fn new() -> Self {
        Self::with_runtime(false, false)
    }

    fn with_responsibility_assessment() -> Self {
        Self::with_runtime(true, false)
    }

    fn with_builtin_responsibility_assessment() -> Self {
        Self::with_runtime(true, true)
    }

    fn with_runtime(responsibility_assessment: bool, builtin_coordinator: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("paper");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("main.tex"), ORIGINAL).unwrap();
        let host = FakeHost::new(FakeEnv::new().with_project("paper", &project).without_git());
        let state = ResearchTaskState::for_test(directory.path().join("tasks"), 1);
        state.attach(Arc::new(host), tokio::runtime::Handle::current());
        let (starts, receiver) = mpsc::unbounded_channel();
        let base_cancellations = Arc::new(Mutex::new(Vec::new()));
        let assessments = if responsibility_assessment {
            let (assessments, receiver) = mpsc::unbounded_channel();
            let runtime: Arc<dyn TaskRuntimeAdapter> = Arc::new(ControlledResponsibilityRuntime {
                starts,
                assessments,
                cancellations: base_cancellations.clone(),
            });
            state.register_runtime("fixture", runtime.clone()).unwrap();
            if builtin_coordinator {
                state.register_runtime("builtin", runtime).unwrap();
            }
            Some(receiver)
        } else {
            state
                .register_runtime(
                    "fixture",
                    Arc::new(ControlledGroupRuntime {
                        starts,
                        cancellations: base_cancellations.clone(),
                    }),
                )
                .unwrap();
            None
        };
        let task = state
            .store()
            .unwrap()
            .create(draft("paper", "Preserve the evidence"))
            .unwrap();
        let mut coordinator = member("Coordinator", true);
        if builtin_coordinator {
            coordinator.runtime_id = "builtin".into();
        }
        let group = state
            .create_task_group(
                "paper",
                Some(&task.id),
                &[
                    coordinator,
                    member("Methods", false),
                    member("Explorer", false),
                ],
            )
            .unwrap();
        Self {
            _directory: directory,
            project,
            state,
            task,
            group,
            starts: receiver,
            base_cancellations,
            assessments,
        }
    }

    fn member(&self, name: &str) -> String {
        self.group
            .members
            .iter()
            .find(|member| member.config.name == name)
            .unwrap()
            .id
            .clone()
    }

    async fn next(&mut self) -> StartedTurn {
        tokio::time::timeout(CHILD_PATIENCE, self.starts.recv())
            .await
            .expect("the task group did not start the expected member")
            .expect("the member start channel closed")
    }

    async fn assessment(&mut self) -> AssessmentRequest {
        tokio::time::timeout(
            CHILD_PATIENCE,
            self.assessments
                .as_mut()
                .expect("this fixture has no responsibility runtime")
                .recv(),
        )
        .await
        .expect("the scheduler did not assess retained responsibility inputs")
        .expect("the responsibility channel closed")
    }

    async fn start(&self) {
        self.state.request_start(&self.task.id).unwrap();
        self.state.launch_ready().await.unwrap();
    }

    fn store(&self) -> TaskStore {
        self.state.store().unwrap()
    }

    fn snapshot(&self) -> GroupSnapshot {
        self.store()
            .group_snapshot("paper", &self.group.group.id, 0)
            .unwrap()
    }
}

fn member(name: &str, coordinator: bool) -> MemberDraft {
    MemberDraft {
        name: name.into(),
        responsibility: format!("Advance and verify the task as {name}"),
        runtime_id: "fixture".into(),
        agent_id: "fixture-agent".into(),
        model_id: format!("{}-model", name.to_lowercase()),
        coordinator,
        ..Default::default()
    }
}

fn actor(context: &TaskRunContext) -> GroupActor {
    let turn = context
        .collaboration
        .as_ref()
        .expect("member context was not bound");
    GroupActor {
        kind: ActorKind::Member,
        id: turn.member.id.clone(),
        execution_id: Some(turn.execution.id.clone()),
    }
}

fn complete(turn: StartedTurn, summary: &str, input: u64, output: u64) {
    turn.complete
        .send(Ok(TaskRuntimeOutcome {
            summary: summary.into(),
            artifacts: Vec::new(),
            native_session_id: None,
            input_tokens: Some(input),
            output_tokens: Some(output),
            waiting_for_reply: false,
        }))
        .unwrap();
}

async fn settled(state: &ResearchTaskState, task: &str) -> ResearchTask {
    if let Some(waiter) = state.settle_waiter(task) {
        tokio::time::timeout(CHILD_PATIENCE, waiter)
            .await
            .expect("the task group did not settle");
    }
    let result = state.store().unwrap().require(task).unwrap();
    assert_eq!(result.status, ResearchTaskStatus::AwaitingReview);
    result
}

async fn settled_with_status(
    state: &ResearchTaskState,
    task: &str,
    expected: ResearchTaskStatus,
) -> ResearchTask {
    if let Some(waiter) = state.settle_waiter(task) {
        tokio::time::timeout(CHILD_PATIENCE, waiter)
            .await
            .expect("the task group did not settle");
    }
    let result = state.store().unwrap().require(task).unwrap();
    assert_eq!(result.status, expected);
    result
}

async fn stop(state: &ResearchTaskState) {
    tokio::time::timeout(Duration::from_secs(5), state.shutdown())
        .await
        .expect("the group scheduler did not shut down");
}

async fn wait_for(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(CHILD_PATIENCE, async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the controlled lifecycle boundary did not occur");
}

#[tokio::test]
async fn file_routing_retains_rollbacks_and_restoration_of_the_task_baseline() {
    let fixture = GroupFixture::new();
    let store = fixture.store();
    store.request_start(&fixture.task.id).unwrap();
    let task = store.claim_next().unwrap().unwrap();
    store.seed_group_work(&task).unwrap();
    let turn = store.claim_member_turn(&task).unwrap().unwrap();
    let methods = fixture.member("Methods");
    store
        .set_member_interest(
            "paper",
            &fixture.group.group.id,
            &MemberInterest {
                member_id: methods.clone(),
                kind: InterestKind::Path,
                value: "main.tex".into(),
            },
            true,
        )
        .unwrap();
    let change = |revision: &str| TaskFileChange {
        path: "main.tex".into(),
        kind: crate::model::TaskFileChangeKind::Modified,
        before_sha256: Some("BASE".into()),
        after_sha256: Some(revision.into()),
        before_size: Some(4),
        after_size: Some(4),
    };
    let mut previous = Vec::new();
    for revision in [Some("H2"), Some("H3"), Some("H2"), None, Some("H3")] {
        let current = revision
            .map(|revision| vec![change(revision)])
            .unwrap_or_default();
        fixture
            .state
            .route_file_changes(&store, &turn, &current, &previous)
            .unwrap();
        fixture
            .state
            .route_file_changes(&store, &turn, &current, &current)
            .unwrap();
        previous = current;
    }
    let snapshot = fixture.snapshot();
    assert_eq!(
        snapshot
            .events
            .iter()
            .map(|event| event.object.revision.as_deref().unwrap())
            .collect::<Vec<_>>(),
        vec!["H2", "H3", "H2", "BASE", "H3"]
    );
    let routed: Vec<_> = snapshot
        .work
        .iter()
        .filter(|work| work.cause_kind == "event")
        .collect();
    assert_eq!(routed.len(), 5);
    assert!(routed.iter().all(|work| work.member_id == methods));
    store.interrupt_member_turn(&turn, None).unwrap();
    stop(&fixture.state).await;
}

struct ExternalStart {
    context: TaskRunContext,
    token: CancellationToken,
}

/// Cancellation models an external execution whose cleanup only completes
/// while the run future keeps being polled. Dropping that future is insufficient.
struct ExternalRuntime {
    starts: mpsc::UnboundedSender<ExternalStart>,
    cancellations: Arc<Mutex<Vec<String>>>,
    cancel_requested: CancellationToken,
    finished: Arc<AtomicBool>,
}

impl TaskRuntimeAdapter for ExternalRuntime {
    fn supports(&self, agent_id: &str) -> bool {
        agent_id == "fixture-agent"
    }

    fn run(
        &self,
        context: TaskRunContext,
        token: CancellationToken,
        _events: TaskEventSink,
    ) -> TaskRuntimeFuture<TaskRuntimeOutcome> {
        let sent = self
            .starts
            .send(ExternalStart {
                context,
                token: token.clone(),
            })
            .map_err(|_| "the external member was not observed".to_string());
        let requested = self.cancel_requested.clone();
        let finished = self.finished.clone();
        Box::pin(async move {
            sent?;
            requested.cancelled().await;
            tokio::task::yield_now().await;
            finished.store(true, Ordering::Release);
            Err("external member stopped".into())
        })
    }

    fn cancel(&self, session_id: String) -> TaskRuntimeFuture<()> {
        lock(&self.cancellations).push(session_id);
        self.cancel_requested.cancel();
        let finished = self.finished.clone();
        Box::pin(async move {
            wait_for(|| finished.load(Ordering::Acquire)).await;
            Ok(())
        })
    }
}

#[tokio::test]
async fn first_generation_routes_real_file_change_to_an_unmentioned_member_and_back() {
    let mut fixture = GroupFixture::new();
    let coordinator = fixture.member("Coordinator");
    let methods = fixture.member("Methods");
    let explorer = fixture.member("Explorer");
    fixture
        .store()
        .set_member_interest(
            "paper",
            &fixture.group.group.id,
            &MemberInterest {
                member_id: explorer.clone(),
                kind: InterestKind::Path,
                value: "main.tex".into(),
            },
            true,
        )
        .unwrap();
    fixture.start().await;

    let first = fixture.next().await;
    let initial = first.context.collaboration.as_ref().unwrap();
    assert_eq!(initial.member.id, coordinator);
    assert_eq!(first.context.execution_generation, 1);
    let execution_root = first.context.execution_root.clone();
    let task_session = first.context.session_id.clone();
    let shared_clock = fixture
        .state
        .services()
        .unwrap()
        .clocks
        .get(&fixture.task.id)
        .unwrap();
    let delegation = fixture
        .store()
        .group_message(
            "paper",
            &fixture.group.group.id,
            &actor(&first.context),
            &MessageDraft {
                body: "Check the negative result and revise the manuscript if required.".into(),
                recipients: vec![methods.clone()],
                request_work: true,
                ..Default::default()
            },
        )
        .unwrap();
    complete(first, "Asked Methods to check the evidence", 10, 1);

    let second = fixture.next().await;
    let turn = second.context.collaboration.as_ref().unwrap();
    assert_eq!(turn.member.id, methods);
    assert_eq!(turn.messages, vec![delegation.clone()]);
    assert_eq!(second.context.execution_generation, 1);
    assert_eq!(second.context.execution_root, execution_root);
    assert_ne!(second.context.session_id, task_session);
    assert!(Arc::ptr_eq(
        &shared_clock,
        &fixture
            .state
            .services()
            .unwrap()
            .clocks
            .get(&fixture.task.id)
            .unwrap()
    ));
    std::fs::write(
        Path::new(&second.context.execution_root).join("main.tex"),
        REVISED,
    )
    .unwrap();
    complete(
        second,
        "Preserved the negative result in the manuscript",
        20,
        2,
    );

    // Completing Methods returns its result to the coordinator before the
    // lower-priority file-change event wakes Explorer.
    let third = fixture.next().await;
    let turn = third.context.collaboration.as_ref().unwrap();
    assert_eq!(turn.member.id, coordinator);
    assert_eq!(turn.messages.len(), 1);
    assert_eq!(turn.messages[0].author.id, methods);
    assert_eq!(
        turn.messages[0].content.reply_to.as_deref(),
        Some(delegation.id.as_str())
    );
    assert!(!turn.messages[0].content.request_work);
    assert_eq!(third.context.execution_generation, 1);
    assert!(Arc::ptr_eq(
        &shared_clock,
        &fixture
            .state
            .services()
            .unwrap()
            .clocks
            .get(&fixture.task.id)
            .unwrap()
    ));
    complete(third, "Reviewed the checked evidence", 30, 3);

    // Explorer was not named in the delegation. Its path responsibility must be
    // enough for the first generation's actual file revision to wake it.
    let fourth = fixture.next().await;
    let turn = fourth.context.collaboration.as_ref().unwrap();
    assert_eq!(turn.member.id, explorer);
    assert_eq!(fourth.context.execution_generation, 1);
    assert!(turn.messages.is_empty());
    assert_eq!(turn.events.len(), 1);
    assert_eq!(turn.events[0].kind, "file_changed");
    assert_eq!(turn.events[0].object.path.as_deref(), Some("main.tex"));
    assert!(turn.events[0].object.revision.is_some());
    assert_eq!(
        std::fs::read_to_string(Path::new(&fourth.context.execution_root).join("main.tex"))
            .unwrap(),
        REVISED
    );
    assert!(Arc::ptr_eq(
        &shared_clock,
        &fixture
            .state
            .services()
            .unwrap()
            .clocks
            .get(&fixture.task.id)
            .unwrap()
    ));
    let reply = fixture
        .store()
        .group_message(
            "paper",
            &fixture.group.group.id,
            &actor(&fourth.context),
            &MessageDraft {
                body: "The counterexample is retained; compare its scope with the main result."
                    .into(),
                reply_to: Some(delegation.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(reply.content.recipients, vec![coordinator.clone()]);
    complete(
        fourth,
        "Verified the changed manuscript and proposed a comparison",
        40,
        4,
    );

    let fifth = fixture.next().await;
    let turn = fifth.context.collaboration.as_ref().unwrap();
    assert_eq!(turn.member.id, coordinator);
    assert_eq!(turn.messages, vec![reply]);
    assert_eq!(fifth.context.execution_generation, 1);
    assert!(Arc::ptr_eq(
        &shared_clock,
        &fixture
            .state
            .services()
            .unwrap()
            .clocks
            .get(&fixture.task.id)
            .unwrap()
    ));
    complete(
        fifth,
        "Integrated the checked revision and comparison",
        50,
        5,
    );

    let finished = settled(&fixture.state, &fixture.task.id).await;
    assert_eq!(finished.execution_generation, 1);
    let result = finished.result.unwrap();
    assert_eq!(result.input_tokens, Some(150));
    assert_eq!(result.output_tokens, Some(15));
    assert!(result
        .changed_files
        .iter()
        .any(|file| file.path == "main.tex"));
    assert_eq!(
        std::fs::read_to_string(fixture.project.join("main.tex")).unwrap(),
        ORIGINAL
    );
    let snapshot = fixture.snapshot();
    assert_eq!(snapshot.executions.len(), 5);
    assert!(snapshot
        .executions
        .iter()
        .all(|execution| execution.task_generation == 1 && execution.status == "completed"));
    assert!(snapshot
        .work
        .iter()
        .all(|work| work.status == WorkStatus::Completed));
    assert!(!fixture
        .store()
        .group_has_pending(&fixture.group.group.id)
        .unwrap());
    assert!(fixture.starts.try_recv().is_err());
    stop(&fixture.state).await;
}

#[tokio::test]
async fn responsibility_lifecycle_assessment_wakes_unread_methods() {
    let mut fixture = GroupFixture::with_responsibility_assessment();
    fixture.start().await;

    let coordinator = fixture.next().await;
    assert_eq!(
        coordinator
            .context
            .collaboration
            .as_ref()
            .unwrap()
            .member
            .config
            .name,
        "Coordinator"
    );
    std::fs::write(
        Path::new(&coordinator.context.execution_root).join("main.tex"),
        REVISED,
    )
    .unwrap();
    complete(coordinator, "Wrote the manuscript revision", 10, 2);

    let assessment = fixture.assessment().await;
    let methods = fixture.member("Methods");
    assert_eq!(assessment.batch.inputs.len(), 1);
    assert_eq!(
        assessment.batch.inputs[0].event.object.path.as_deref(),
        Some("main.tex")
    );
    assert!(assessment.batch.inputs[0]
        .eligible_member_ids
        .contains(&methods));
    let event_id = assessment.batch.inputs[0].event.id.clone();
    assessment.answer(vec![ResponsibilityDecision {
        event_id,
        member_id: methods.clone(),
        reason: "Methods owns validity checks for the changed result.".into(),
    }]);

    let methods_turn = fixture.next().await;
    let turn = methods_turn.context.collaboration.as_ref().unwrap();
    assert_eq!(turn.member.id, methods);
    assert_eq!(turn.events.len(), 1);
    assert_eq!(turn.events[0].kind, "file_changed");
    assert_eq!(
        turn.events[0].evidence.as_ref().unwrap()["availability"],
        "available"
    );
    assert!(turn.messages.is_empty());
    assert!(turn.work.iter().any(|work| {
        work.reasons
            .iter()
            .any(|reason| reason.kind == "responsibility")
    }));
    complete(
        methods_turn,
        "Checked the changed result against the methods",
        20,
        3,
    );

    let finished = settled(&fixture.state, &fixture.task.id).await;
    assert_eq!(finished.status, ResearchTaskStatus::AwaitingReview);
    assert_eq!(finished.result.unwrap().input_tokens, Some(37));
    let snapshot = fixture.snapshot();
    assert!(snapshot.events.iter().any(|event| {
        event.kind == "responsibility_assessed"
            && event
                .evidence
                .as_ref()
                .is_some_and(|value| value["assessment"]["modelId"] == "Coordinator-model")
    }));
    assert!(!snapshot
        .events
        .iter()
        .any(|event| event.kind == "responsibility_assessment_failed"));
    assert!(!snapshot
        .executions
        .iter()
        .any(|execution| execution.member_id == methods && execution.status == "failed"));
    assert!(fixture.starts.try_recv().is_err());
    stop(&fixture.state).await;
}

#[tokio::test]
async fn responsibility_lifecycle_invalid_assessment_preserves_explicit_work() {
    let mut fixture = GroupFixture::with_responsibility_assessment();
    let methods = fixture.member("Methods");
    fixture.start().await;

    let coordinator = fixture.next().await;
    let delegation = fixture
        .store()
        .group_message(
            "paper",
            &fixture.group.group.id,
            &actor(&coordinator.context),
            &MessageDraft {
                body: "Check the methods while the revision is pending.".into(),
                recipients: vec![methods.clone()],
                request_work: true,
                ..Default::default()
            },
        )
        .unwrap();
    std::fs::write(
        Path::new(&coordinator.context.execution_root).join("main.tex"),
        REVISED,
    )
    .unwrap();
    complete(coordinator, "Delegated the methods check", 10, 2);

    let assessment = fixture.assessment().await;
    assert_eq!(assessment.batch.inputs.len(), 1);
    let event_id = assessment.batch.inputs[0].event.id.clone();
    assessment.answer(vec![ResponsibilityDecision {
        event_id,
        member_id: "foreign-member".into(),
        reason: "This target is not a group member.".into(),
    }]);

    let methods_turn = fixture.next().await;
    let turn = methods_turn.context.collaboration.as_ref().unwrap();
    assert_eq!(turn.member.id, methods);
    assert_eq!(turn.messages, vec![delegation]);
    assert!(turn.events.is_empty());
    complete(methods_turn, "Completed the explicit methods check", 20, 3);

    let coordinator_reply = fixture.next().await;
    let turn = coordinator_reply.context.collaboration.as_ref().unwrap();
    assert_eq!(turn.member.config.name, "Coordinator");
    assert_eq!(turn.messages.len(), 1);
    assert_eq!(
        turn.messages[0].content.body,
        "Completed the explicit methods check"
    );
    complete(coordinator_reply, "Received the methods result", 4, 1);

    let failed =
        settled_with_status(&fixture.state, &fixture.task.id, ResearchTaskStatus::Failed).await;
    assert!(failed
        .error
        .as_deref()
        .is_some_and(|error| error.contains("ineligible member")));
    assert!(failed.result.is_none());

    let store = fixture.store();
    let retained = store.responsibility_batch(&failed).unwrap().unwrap();
    assert_eq!(retained.inputs.len(), 1);
    assert_eq!(
        retained.inputs[0].event.object.path.as_deref(),
        Some("main.tex")
    );
    let snapshot = fixture.snapshot();
    assert!(snapshot.events.iter().any(|event| {
        event.kind == "responsibility_assessment_failed"
            && event.detail.contains("ineligible member")
    }));
    assert!(snapshot
        .executions
        .iter()
        .any(|execution| { execution.member_id == methods && execution.status == "completed" }));
    assert!(snapshot.work.iter().any(|work| {
        work.member_id == methods
            && work.cause_kind == "message"
            && work.status == WorkStatus::Completed
    }));
    assert!(fixture.starts.try_recv().is_err());
    stop(&fixture.state).await;
}

#[tokio::test]
async fn responsibility_lifecycle_pause_during_assessment_retains_source_and_resumes() {
    let mut fixture = GroupFixture::with_builtin_responsibility_assessment();
    let methods = fixture.member("Methods");
    let coordinator = fixture.member("Coordinator");
    fixture.start().await;

    let initial = fixture.next().await;
    std::fs::write(
        Path::new(&initial.context.execution_root).join("main.tex"),
        REVISED,
    )
    .unwrap();
    complete(initial, "Wrote the manuscript revision", 10, 2);

    let assessment = fixture.assessment().await;
    assert_eq!(assessment.batch.inputs.len(), 1);
    let source = assessment.batch.inputs[0].event.id.clone();
    assert_eq!(
        assessment.batch.inputs[0].event.object.path.as_deref(),
        Some("main.tex")
    );
    assert!(assessment.batch.inputs[0]
        .eligible_member_ids
        .contains(&methods));
    let store = fixture.store();
    store
        .set_group_status("paper", &fixture.group.group.id, GroupStatus::Paused)
        .unwrap();
    assessment.answer(vec![ResponsibilityDecision {
        event_id: source.clone(),
        member_id: methods.clone(),
        reason: "Methods should inspect the retained manuscript revision.".into(),
    }]);

    let paused = settled(&fixture.state, &fixture.task.id).await;
    assert_eq!(paused.status, ResearchTaskStatus::AwaitingReview);
    assert_eq!(paused.result.as_ref().unwrap().input_tokens, Some(17));
    let retained = store.responsibility_batch(&paused).unwrap();
    assert!(retained.is_none());
    let snapshot = fixture.snapshot();
    assert!(snapshot.events.iter().any(|event| event.id == source));
    assert!(!snapshot.events.iter().any(|event| {
        event.kind == "responsibility_assessed"
            && event.evidence.as_ref().is_some_and(|value| {
                value["assessment"]["response"]["decisions"]
                    .as_array()
                    .is_some_and(|decisions| !decisions.is_empty())
            })
    }));
    assert!(snapshot.work.iter().all(|work| work.cause_id != source));
    assert!(fixture.starts.try_recv().is_err());

    store
        .set_group_status("paper", &fixture.group.group.id, GroupStatus::Open)
        .unwrap();
    store
        .set_member_paused("paper", &fixture.group.group.id, &coordinator, true)
        .unwrap();
    let still_paused = store.require(&fixture.task.id).unwrap();
    assert!(store.responsibility_batch(&still_paused).unwrap().is_none());
    fixture.state.launch_ready().await.unwrap();
    let queued_while_paused = store.require(&fixture.task.id).unwrap();
    assert_eq!(
        queued_while_paused.status,
        ResearchTaskStatus::AwaitingReview
    );
    assert!(!queued_while_paused.start_requested);
    assert!(fixture.starts.try_recv().is_err());

    store
        .set_member_paused("paper", &fixture.group.group.id, &coordinator, false)
        .unwrap();
    fixture.state.launch_ready().await.unwrap();
    wait_for(|| {
        store.require(&fixture.task.id).unwrap().status != ResearchTaskStatus::AwaitingReview
    })
    .await;
    let resumed_task = store.require(&fixture.task.id).unwrap();
    assert_eq!(
        resumed_task.status,
        ResearchTaskStatus::Running,
        "{:?}",
        resumed_task.error
    );
    let reassessment = fixture.assessment().await;
    assert_eq!(reassessment.batch.inputs.len(), 1);
    assert_eq!(reassessment.batch.inputs[0].event.id, source);
    reassessment.answer(vec![ResponsibilityDecision {
        event_id: source.clone(),
        member_id: methods.clone(),
        reason: "Methods should inspect the retained manuscript revision.".into(),
    }]);
    let resumed = fixture.next().await;
    let turn = resumed.context.collaboration.as_ref().unwrap();
    assert_eq!(turn.member.id, methods);
    assert_eq!(turn.events.len(), 1);
    assert_eq!(turn.events[0].id, source);
    assert!(turn.messages.is_empty());
    assert!(turn.work.iter().any(|work| {
        work.reasons
            .iter()
            .any(|reason| reason.kind == "responsibility")
    }));
    complete(
        resumed,
        "Checked the retained revision after the pause",
        20,
        3,
    );

    let finished = settled(&fixture.state, &fixture.task.id).await;
    let snapshot = fixture.snapshot();
    assert_eq!(snapshot.executions.len(), 2);
    assert!(snapshot
        .executions
        .iter()
        .all(|execution| execution.status == "completed"));
    assert_eq!(
        snapshot
            .work
            .iter()
            .filter(|work| work.cause_id == source)
            .count(),
        1
    );
    assert!(snapshot.work.iter().any(|work| {
        work.cause_id == source && work.member_id == methods && work.status == WorkStatus::Completed
    }));
    assert!(!store.group_has_pending(&fixture.group.group.id).unwrap());
    assert!(fixture.starts.try_recv().is_err());
    assert_eq!(finished.execution_generation, 2);
    stop(&fixture.state).await;
}

#[tokio::test]
async fn responsibility_lifecycle_coordinator_pause_during_assessment_retains_source_and_resumes() {
    let mut fixture = GroupFixture::with_builtin_responsibility_assessment();
    let methods = fixture.member("Methods");
    let coordinator = fixture.member("Coordinator");
    fixture.start().await;

    let initial = fixture.next().await;
    std::fs::write(
        Path::new(&initial.context.execution_root).join("main.tex"),
        REVISED,
    )
    .unwrap();
    complete(initial, "Wrote the manuscript revision", 10, 2);

    let assessment = fixture.assessment().await;
    assert_eq!(assessment.batch.inputs.len(), 1);
    let source = assessment.batch.inputs[0].event.id.clone();
    assert!(assessment.batch.inputs[0]
        .eligible_member_ids
        .contains(&methods));
    let store = fixture.store();
    store
        .set_member_paused("paper", &fixture.group.group.id, &coordinator, true)
        .unwrap();
    assessment.answer(vec![ResponsibilityDecision {
        event_id: source.clone(),
        member_id: methods.clone(),
        reason: "Methods should inspect the retained manuscript revision.".into(),
    }]);

    let paused = settled(&fixture.state, &fixture.task.id).await;
    assert_eq!(paused.status, ResearchTaskStatus::AwaitingReview);
    assert_eq!(paused.result.as_ref().unwrap().input_tokens, Some(17));
    assert!(store.responsibility_batch(&paused).unwrap().is_none());
    let snapshot = fixture.snapshot();
    assert!(snapshot.events.iter().any(|event| event.id == source));
    assert!(!snapshot.events.iter().any(|event| {
        event.kind == "responsibility_assessed"
            && event.evidence.as_ref().is_some_and(|value| {
                value["assessment"]["response"]["decisions"]
                    .as_array()
                    .is_some_and(|decisions| !decisions.is_empty())
            })
    }));
    assert!(snapshot.work.iter().all(|work| work.cause_id != source));
    assert!(fixture.starts.try_recv().is_err());

    store
        .set_member_paused("paper", &fixture.group.group.id, &coordinator, false)
        .unwrap();
    fixture.state.launch_ready().await.unwrap();
    wait_for(|| {
        store.require(&fixture.task.id).unwrap().status != ResearchTaskStatus::AwaitingReview
    })
    .await;
    let resumed_task = store.require(&fixture.task.id).unwrap();
    assert_eq!(
        resumed_task.status,
        ResearchTaskStatus::Running,
        "{:?}",
        resumed_task.error
    );
    let reassessment = fixture.assessment().await;
    assert_eq!(reassessment.batch.inputs.len(), 1);
    assert_eq!(reassessment.batch.inputs[0].event.id, source);
    reassessment.answer(vec![ResponsibilityDecision {
        event_id: source.clone(),
        member_id: methods.clone(),
        reason: "Methods should inspect the retained manuscript revision.".into(),
    }]);
    let resumed = fixture.next().await;
    let turn = resumed.context.collaboration.as_ref().unwrap();
    assert_eq!(turn.member.id, methods);
    assert_eq!(turn.events.len(), 1);
    assert_eq!(turn.events[0].id, source);
    assert!(turn.messages.is_empty());
    assert!(turn.work.iter().any(|work| {
        work.reasons
            .iter()
            .any(|reason| reason.kind == "responsibility")
    }));
    complete(
        resumed,
        "Checked the retained revision after the coordinator resumed",
        20,
        3,
    );

    let finished = settled(&fixture.state, &fixture.task.id).await;
    assert_eq!(finished.result.as_ref().unwrap().input_tokens, Some(27));
    let snapshot = fixture.snapshot();
    assert_eq!(snapshot.executions.len(), 2);
    assert!(snapshot
        .executions
        .iter()
        .all(|execution| execution.status == "completed"));
    assert_eq!(
        snapshot
            .work
            .iter()
            .filter(|work| work.cause_id == source)
            .count(),
        1
    );
    assert!(snapshot.work.iter().any(|work| {
        work.cause_id == source && work.member_id == methods && work.status == WorkStatus::Completed
    }));
    assert!(!store.group_has_pending(&fixture.group.group.id).unwrap());
    assert!(fixture.starts.try_recv().is_err());
    assert_eq!(finished.execution_generation, 2);
    stop(&fixture.state).await;
}

#[tokio::test]
async fn closed_group_keeps_feedback_and_explicit_old_object_request_continues_saved_task() {
    let mut fixture = GroupFixture::new();
    fixture.start().await;
    let first = fixture.next().await;
    let original_context = first.context.clone();
    let original_message = first.context.collaboration.as_ref().unwrap().messages[0].clone();
    fixture
        .store()
        .set_group_status("paper", &fixture.group.group.id, GroupStatus::Closed)
        .unwrap();
    let feedback = fixture
        .state
        .send_group_message(
            "paper",
            &fixture.group.group.id,
            &MessageDraft {
                body: "The earlier explanation is useful.".into(),
                reply_to: Some(original_message.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    complete(first, "Initial work is ready for review", 5, 1);
    let previous = settled(&fixture.state, &fixture.task.id).await;
    assert_eq!(fixture.snapshot().group.status, GroupStatus::Closed);
    assert!(fixture.starts.try_recv().is_err());

    let follow_up = fixture
        .state
        .send_group_message(
            "paper",
            &fixture.group.group.id,
            &MessageDraft {
                body: "Recheck the old decision against the current manuscript.".into(),
                recipients: vec![fixture.member("Methods")],
                reply_to: Some(feedback.id),
                object: Some(GroupObject {
                    kind: "decision".into(),
                    id: "previous-result-scope".into(),
                    revision: Some("historical-v1".into()),
                    path: Some("main.tex".into()),
                }),
                request_work: true,
            },
        )
        .unwrap();
    let second = fixture.next().await;
    let turn = second.context.collaboration.as_ref().unwrap();
    assert_eq!(turn.member.config.name, "Methods");
    assert_eq!(turn.messages, vec![follow_up]);
    assert!(second.context.execution_generation > original_context.execution_generation);
    assert_eq!(
        second.context.execution_root,
        original_context.execution_root
    );
    let resumed_clock = fixture
        .state
        .services()
        .unwrap()
        .clocks
        .get(&fixture.task.id)
        .unwrap();
    assert!(resumed_clock.active_ms() >= previous.active_ms);
    complete(
        second,
        "Rechecked the historical decision against the saved manuscript",
        7,
        2,
    );
    let finished = settled(&fixture.state, &fixture.task.id).await;
    assert_eq!(fixture.snapshot().group.status, GroupStatus::Open);
    assert_eq!(
        finished.execution_generation,
        original_context.execution_generation + 1
    );
    assert_eq!(fixture.snapshot().executions.len(), 2);
    assert!(!fixture
        .store()
        .group_has_pending(&fixture.group.group.id)
        .unwrap());
    assert!(fixture.starts.try_recv().is_err());
    stop(&fixture.state).await;
}

#[tokio::test]
async fn cancellation_targets_the_selected_member_adapter_and_drives_external_cleanup() {
    let mut fixture = GroupFixture::new();
    fixture.start().await;
    let first = fixture.next().await;
    let coordinator_session = first.context.session_id.clone();
    let delegation = fixture
        .store()
        .group_message(
            "paper",
            &fixture.group.group.id,
            &actor(&first.context),
            &MessageDraft {
                body: "Check the evidence in the external member execution.".into(),
                recipients: vec![fixture.member("Methods")],
                request_work: true,
                ..Default::default()
            },
        )
        .unwrap();
    let (starts, mut external_starts) = mpsc::unbounded_channel();
    let cancellations = Arc::new(Mutex::new(Vec::new()));
    let finished = Arc::new(AtomicBool::new(false));
    fixture
        .state
        .register_runtime(
            "fixture",
            Arc::new(ExternalRuntime {
                starts,
                cancellations: cancellations.clone(),
                cancel_requested: CancellationToken::new(),
                finished: finished.clone(),
            }),
        )
        .unwrap();
    complete(first, "Delegated the evidence check", 3, 1);
    let second = tokio::time::timeout(CHILD_PATIENCE, external_starts.recv())
        .await
        .expect("the selected external adapter was not started")
        .unwrap();
    assert_eq!(
        second
            .context
            .collaboration
            .as_ref()
            .unwrap()
            .member
            .config
            .name,
        "Methods"
    );
    assert_ne!(second.context.session_id, coordinator_session);
    let selected_session = second.context.session_id.clone();
    let cancelled = tokio::time::timeout(
        CHILD_PATIENCE,
        fixture.state.cancel(fixture.task.id.clone()),
    )
    .await
    .expect("cancellation failed to drive the external run future")
    .unwrap();
    assert_eq!(cancelled.status, ResearchTaskStatus::Cancelled);
    assert!(second.token.is_cancelled());
    assert!(finished.load(Ordering::Acquire));
    assert!(lock(&fixture.base_cancellations).is_empty());
    let sessions = lock(&cancellations).clone();
    assert!(!sessions.is_empty());
    assert!(sessions.iter().all(|session| session == &selected_session));
    let snapshot = fixture.snapshot();
    let interrupted = snapshot
        .executions
        .iter()
        .find(|execution| execution.session_id == selected_session)
        .unwrap();
    assert_eq!(interrupted.status, "interrupted");
    let pending = snapshot
        .work
        .iter()
        .find(|work| work.cause_id == delegation.id)
        .unwrap();
    assert_eq!(pending.status, WorkStatus::Pending);
    assert!(pending.execution_id.is_none());
    assert!(pending.result_message_id.is_none());
    assert!(external_starts.try_recv().is_err());
    assert!(fixture.starts.try_recv().is_err());
    stop(&fixture.state).await;
}

#[tokio::test]
async fn suspension_requeues_the_current_causes_and_does_not_start_the_next_member() {
    let mut fixture = GroupFixture::new();
    fixture.start().await;
    let first = fixture.next().await;
    let initial = first.context.collaboration.as_ref().unwrap().clone();
    fixture
        .store()
        .group_message(
            "paper",
            &fixture.group.group.id,
            &actor(&first.context),
            &MessageDraft {
                body: "Check this after the current member finishes.".into(),
                recipients: vec![fixture.member("Methods")],
                request_work: true,
                ..Default::default()
            },
        )
        .unwrap();
    let suspending = {
        let state = fixture.state.clone();
        let id = fixture.task.id.clone();
        tokio::spawn(async move {
            state
                .suspend(&[id], SuspendMode::Prompt, Some(CHILD_PATIENCE))
                .await
        })
    };
    let services = fixture.state.services().unwrap();
    wait_for(|| services.suspends.requested(&fixture.task.id)).await;
    services.suspends.record(
        &fixture.task.id,
        SuspendState {
            conversation: Some("member-pause.json".into()),
            turn_interrupted: true,
            acp: None,
        },
    );
    complete(
        first,
        "Saved the current partial check before suspension",
        11,
        2,
    );
    let results = tokio::time::timeout(CHILD_PATIENCE, suspending)
        .await
        .expect("the member did not suspend")
        .unwrap();
    assert!(matches!(
        results[0].1,
        SuspendResult::Suspended { generation: 1, .. }
    ));
    assert_eq!(
        fixture.store().require(&fixture.task.id).unwrap().status,
        ResearchTaskStatus::Running
    );
    let snapshot = fixture.snapshot();
    assert_eq!(snapshot.executions.len(), 1);
    assert_eq!(snapshot.executions[0].status, "interrupted");
    assert_eq!(snapshot.executions[0].input_tokens, Some(11));
    assert_eq!(snapshot.executions[0].output_tokens, Some(2));
    assert!(snapshot
        .work
        .iter()
        .all(|work| work.status == WorkStatus::Pending));
    assert!(snapshot
        .work
        .iter()
        .any(|work| work.id == initial.work[0].id));
    assert!(snapshot
        .work
        .iter()
        .all(|work| work.execution_id.is_none() && work.result_message_id.is_none()));
    assert!(fixture.starts.try_recv().is_err());
    assert!(lock(&fixture.base_cancellations).is_empty());
    stop(&fixture.state).await;
}
