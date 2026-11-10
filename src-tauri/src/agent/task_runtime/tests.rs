use super::*;
use crate::test_wait;

fn context(root: &Path) -> TaskRunContext {
    TaskRunContext {
        task_id: "task".into(),
        execution_generation: 1,
        session_id: "session".into(),
        project_id: "project".into(),
        execution_root: root.to_string_lossy().into_owned(),
        title: "Task".into(),
        prompt: "Task prompt".into(),
        runtime_id: "builtin".into(),
        agent_id: "openai".into(),
        model_id: "test".into(),
        skill_ids: Vec::new(),
        source_revision: "snapshot".into(),
        allowed_paths: vec!["analysis".into()],
        ..Default::default()
    }
}

#[test]
fn native_task_usage_separates_helper_snapshots_from_parent_turns() {
    let root = tempfile::tempdir().unwrap();
    let resolved = oleafly_agent::Resolved {
        provider_id: "test".into(),
        model_id: "test".into(),
        credential: String::new(),
        auth: None,
        wire: oleafly_agent::Wire::OpenAiChat {
            base_url: "https://example.test".into(),
            reasoning_content: false,
        },
        caps: Default::default(),
    };
    let native = NativeUsage(super::super::usage::NativeUsageGuard::new(
        root.path().into(),
        super::super::usage::UsageScope {
            session_id: "member-session-a".into(),
            turn_id: "task:1:member-a".into(),
            project_id: Some("project".into()),
            task_id: Some("task".into()),
            parent_session_id: None,
        },
        &resolved,
    ));
    let sink: &dyn UsageSink = &native;
    let usage = |input, output| {
        oleafly_agent::AgentEvent::usage(oleafly_agent::Usage {
            input,
            output,
            input_known: Some(true),
            output_known: Some(true),
            ..Default::default()
        })
    };
    sink.begin_turn();
    sink.observe(&usage(40, 4));
    sink.observe(&oleafly_agent::AgentEvent::StepStart { step: 0 });
    sink.observe(&usage(100, 10));
    sink.register_helper("member-session-a:helper-1");
    assert_eq!(sink.task_usage_snapshot(), Some((Some(100), Some(10))));
    sink.observe_helper(
        "member-session-a:helper-1",
        &oleafly_agent::AgentEvent::StepStart { step: 0 },
    );
    assert_eq!(sink.task_usage_snapshot(), Some((None, None)));
    sink.observe_helper("member-session-a:helper-1", &usage(30, 3));
    sink.observe(&usage(140, 14));
    assert_eq!(sink.task_usage_snapshot(), Some((Some(170), Some(17))));

    sink.begin_turn();
    sink.observe(&usage(2, 0));
    sink.observe(&oleafly_agent::AgentEvent::StepStart { step: 0 });
    sink.observe(&usage(5, 1));
    sink.finish("completed");
    let connection = crate::library_db::open(root.path()).unwrap();
    let counts: (i64, i64) = connection
        .query_row(
            "SELECT input_tokens, output_tokens FROM usage_records WHERE session_id = 'member-session-a'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(counts, (175, 18));
}

struct LoopbackBridge {
    url: String,
    #[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
    calls: Arc<Mutex<Vec<Value>>>,
    cancel: CancellationToken,
    server: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl LoopbackBridge {
    async fn start() -> Arc<Self> {
        use axum::{routing::post, Json, Router};
        let calls = Arc::new(Mutex::new(Vec::new()));
        let observed = calls.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new().route("/mcp", post(move |Json(request): Json<Value>| {
            lock(&observed).push(request);
            async { Json(json!({"content":[{"type":"text","text":"scoped research evidence"}],"isError":false})) }
        }));
        let cancel = CancellationToken::new();
        let stopped = cancel.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move { stopped.cancelled().await })
                .await
                .unwrap();
        });
        Arc::new(Self {
            url: format!("http://{address}/mcp"),
            calls,
            cancel,
            server: Mutex::new(Some(server)),
        })
    }

    async fn assert_closed(&self) {
        assert!(self.cancel.is_cancelled());
        assert!(lock(&self.server).is_none());
        assert!(reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(&self.url)
            .json(&json!({}))
            .send()
            .await
            .is_err());
    }
}

impl TaskBridge for LoopbackBridge {
    fn mcp_server(&self) -> Value {
        json!({"type":"http","name":"fixture-research","url":self.url,"headers":[]})
    }

    fn call_tool(self: Arc<Self>, name: String, args: Value) -> TaskRuntimeFuture<Value> {
        Box::pin(async move {
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .post(&self.url)
                .json(&json!({"name":name,"arguments":args}))
                .send()
                .await
                .map_err(|error| error.to_string())?
                .json()
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn shutdown(
        self: Arc<Self>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        Box::pin(async move {
            self.cancel.cancel();
            let server = lock(&self.server).take();
            if let Some(server) = server {
                tokio::time::timeout(Duration::from_secs(3), server)
                    .await
                    .unwrap()
                    .unwrap();
            }
        })
    }
}

impl Drop for LoopbackBridge {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(server) = self.server.get_mut().unwrap().take() {
            server.abort();
        }
    }
}

struct FixtureHost {
    provider_url: String,
    bridge: Arc<LoopbackBridge>,
    preparations: Mutex<Vec<TaskRunContext>>,
    bridge_gate: Option<Arc<tokio::sync::Semaphore>>,
    bridge_started: tokio::sync::Notify,
}

struct NullUsage;

impl UsageSink for NullUsage {
    fn observe(&self, _event: &oleafly_agent::AgentEvent) {}
    fn finish(&self, _status: &str) {}
}

impl TaskHost for FixtureHost {
    fn skills(
        &self,
        context: &TaskRunContext,
    ) -> Result<oleafly_research::observations::TaskSkills, String> {
        assert!(context.skill_ids.is_empty());
        Ok(Default::default())
    }

    fn skill_read_paths(&self, _context: &TaskRunContext) -> Vec<PathBuf> {
        Vec::new()
    }

    fn provider(&self, context: TaskRunContext) -> TaskRuntimeFuture<TaskProvider> {
        let base_url = self.provider_url.clone();
        Box::pin(async move {
            Ok(TaskProvider {
                client: reqwest::Client::builder().no_proxy().build().unwrap(),
                resolved: oleafly_agent::Resolved {
                    provider_id: context.agent_id,
                    model_id: context.model_id,
                    credential: String::new(),
                    auth: None,
                    wire: oleafly_agent::Wire::OpenAiChat {
                        base_url,
                        reasoning_content: true,
                    },
                    caps: oleafly_agent::ModelCaps::default(),
                },
                usage: Box::new(NullUsage),
            })
        })
    }

    fn bridge(
        &self,
        context: TaskRunContext,
        _binding: Option<TaskBinding>,
    ) -> TaskRuntimeFuture<Arc<dyn TaskBridge>> {
        lock(&self.preparations).push(context);
        self.bridge_started.notify_one();
        let gate = self.bridge_gate.clone();
        let bridge = self.bridge.clone();
        Box::pin(async move {
            if let Some(gate) = gate {
                gate.acquire().await.unwrap().forget();
            }
            Ok(bridge as Arc<dyn TaskBridge>)
        })
    }
}

fn task_services(root: &Path) -> TaskServices {
    let tasks_root = root.join("tasks");
    let clocks = Arc::new(oleafly_research::budget::BudgetClocks::default());
    TaskServices {
        runs: oleafly_research::runs::RunManager::new(
            tasks_root.clone(),
            tokio::runtime::Handle::current(),
        ),
        tasks_root: tasks_root.clone(),
        clocks: clocks.clone(),
        approvals: oleafly_research::approvals::ApprovalQueue::new(tasks_root, clocks),
        workspace: None,
        suspends: Arc::new(oleafly_research::scheduler::SuspendSignals::default()),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn fixture_host(_root: &Path, url: String) -> Arc<FixtureHost> {
    Arc::new(FixtureHost {
        provider_url: url,
        bridge: LoopbackBridge::start().await,
        preparations: Mutex::new(Vec::new()),
        bridge_gate: None,
        bridge_started: tokio::sync::Notify::new(),
    })
}

fn event_log() -> (Arc<Mutex<Vec<TaskRuntimeEvent>>>, TaskEventSink) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    (events, Arc::new(move |event| lock(&sink).push(event)))
}

async fn bounded_wait(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(test_wait::CHILD_PATIENCE, async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the fixture did not reach its controlled boundary");
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
const ACP_TASK_FIXTURE: &str = r#"
import json
import os
from pathlib import Path
import sys
import time
import urllib.request

scenario = sys.argv[1]
original = Path(sys.argv[2])
native = "fixture-native"
pending = None
servers = []
model = "default-model"

def send(value):
    print(json.dumps({"jsonrpc":"2.0", **value}), flush=True)

def result(request, value):
    send({"id":request["id"], "result":value})

def update(kind, **data):
    send({"method":"session/update", "params":{"sessionId":native, "update":{"sessionUpdate":kind, **data}}})

for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    params = request.get("params", {})
    if method == "initialize":
        Path("analysis/agent.pid").write_text(str(os.getpid()))
        result(request, {"protocolVersion":1, "agentCapabilities":{"loadSession":scenario == "annotations", "mcpCapabilities":{"http":True}}})
    elif method in ("session/new", "session/load"):
        servers = params["mcpServers"]
        assert Path(params["cwd"]).samefile(Path.cwd())
        if scenario == "annotations":
            with Path("analysis/session-methods").open("a") as handle:
                handle.write(method + "\n")
        response = {"models":{"currentModelId":model,"availableModels":[{"modelId":"default-model","name":"Default"},{"modelId":"test","name":"Selected"}]}}
        if method == "session/new":
            response["sessionId"] = native
        result(request, response)
    elif method == "session/set_model":
        model = params["modelId"]
        result(request, {})
    elif method == "session/prompt":
        Path("analysis/selected-model").write_text(model)
        if scenario in ("annotations", "annotation-disconnect", "annotation-wait"):
            with Path("analysis/prompts.jsonl").open("a") as handle:
                handle.write(json.dumps(params["prompt"]) + "\n")
            if scenario == "annotation-disconnect":
                sys.exit(0)
            if scenario == "annotation-wait":
                pending = request
                continue
            update("agent_message_chunk", content={"type":"text","text":"Current request received."})
            result(request, {"stopReason":"end_turn"})
            continue
        update("agent_thought_chunk", content={"type":"text","text":"Checking isolated evidence."})
        update("tool_call", toolCallId="write-1", title="Write isolated result", status="in_progress")
        if scenario == "hang":
            child = os.fork()
            if child == 0:
                for count in range(1000):
                    with open("analysis/heartbeat", "a") as handle:
                        handle.write(str(count) + "\n")
                    time.sleep(0.02)
                os._exit(0)
            Path("analysis/child.pid").write_text(str(child))
            pending = request
            continue
        if scenario == "error":
            update("agent_message_chunk", content={"type":"text","text":"Partial fixture answer"})
            send({"id":request["id"],"error":{"code":-32000,"message":"fixture task failed"}})
            continue
        if scenario == "length":
            update("usage_update", used=900,size=32000)
            update("agent_message_chunk", content={"type":"text","text":"Incomplete fixture answer"})
            result(request, {"stopReason":"max_tokens"})
            continue
        try:
            original.read_text()
            raise AssertionError("An unlinked original was readable")
        except (PermissionError, FileNotFoundError):
            pass
        Path("analysis/result.md").write_text("Native ACP isolated revision")
        payload = json.dumps({"name":"research_context","arguments":{}}).encode()
        call = urllib.request.Request(servers[0]["url"], data=payload,headers={"Content-Type":"application/json"})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(call,timeout=5) as response:
            assert json.load(response)["content"][0]["text"] == "scoped research evidence"
        update("tool_call_update", toolCallId="write-1", title="Write isolated result",status="completed")
        update("usage_update", used=900,size=32000)
        # One message per chunk: 300 stored events, so replay pages.
        for index in range(300):
            update("agent_message_chunk", messageId="m" + str(index), content={"type":"text","text":str(index) + ","})
        result(request, {"stopReason":"end_turn","usage":{"inputTokens":11,"outputTokens":7}})
    elif method == "session/cancel" and pending:
        result(pending,{"stopReason":"cancelled"})
        pending = None
"#;

#[cfg(any(target_os = "macos", target_os = "linux"))]
struct AcpFixture {
    directory: tempfile::TempDir,
    workspace: PathBuf,
    original: PathBuf,
    host: Arc<FixtureHost>,
    adapter: AcpTaskAdapter,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Drop for AcpFixture {
    fn drop(&mut self) {
        self.adapter.runtime.stop_all_now();
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl AcpFixture {
    async fn new(scenario: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original.tex");
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir(workspace.join("analysis")).unwrap();
        std::fs::write(&original, "Original manuscript").unwrap();
        let script = directory.path().join("fixture.py");
        std::fs::write(&script, ACP_TASK_FIXTURE).unwrap();
        let output = tokio::process::Command::new("python3")
            .args(["-c", "import sys; print(sys.executable)"])
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        let python = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim())
            .canonicalize()
            .unwrap();
        #[cfg(target_os = "macos")]
        let python = python
            .parent()
            .and_then(Path::parent)
            .map(|prefix| prefix.join("Resources/Python.app/Contents/MacOS/Python"))
            .filter(|path| path.is_file())
            .unwrap_or(python);
        let runtime = crate::acp::AcpRuntime::new(directory.path().join("acp")).unwrap();
        let definition = crate::acp::AgentDefinition {
            id: "fixture-task-agent".into(),
            name: "Task fixture".into(),
            version: "1.0.0".into(),
            description: String::new(),
            builtin: false,
            distribution: crate::acp::Distribution {
                command: Some(crate::acp::CommandDistribution {
                    executable: python.to_string_lossy().into_owned(),
                    args: vec![
                        "-u".into(),
                        "-B".into(),
                        script.to_string_lossy().into_owned(),
                        scenario.into(),
                        original.to_string_lossy().into_owned(),
                    ],
                }),
                ..Default::default()
            },
        };
        runtime
            .register(&serde_json::to_string(&definition).unwrap())
            .unwrap();
        let host = fixture_host(directory.path(), "http://127.0.0.1:9".into()).await;
        let adapter = AcpTaskAdapter {
            host: host.clone(),
            services: task_services(directory.path()),
            runtime,
            tokens: Arc::new(Mutex::new(HashMap::new())),
        };
        Self {
            directory,
            workspace,
            original,
            host,
            adapter,
        }
    }

    fn context(&self) -> TaskRunContext {
        let mut context = context(&self.workspace);
        context.runtime_id = "acp".into();
        context.agent_id = "fixture-task-agent".into();
        context
    }

    fn saved_events(&self, session_id: &str) -> Vec<crate::acp::AcpEvent> {
        let mut after = 0;
        let mut events = Vec::new();
        loop {
            let page = self.adapter.runtime.events(session_id, after, 256).unwrap();
            if let Some(last) = page.events.last() {
                after = last.sequence;
            }
            events.extend(page.events);
            if !page.has_more {
                return events;
            }
        }
    }

    async fn assert_cleaned(&self) {
        assert!(lock(&self.adapter.tokens).is_empty());
        self.host.bridge.assert_closed().await;
        let temporary = self.directory.path().join("acp/task-temp");
        bounded_wait(|| {
            !temporary.exists() || std::fs::read_dir(&temporary).unwrap().next().is_none()
        })
        .await;
        #[cfg(target_os = "macos")]
        {
            let pid = std::fs::read_to_string(self.workspace.join("analysis/agent.pid"))
                .unwrap()
                .parse::<i32>()
                .unwrap();
            bounded_wait(|| unsafe { libc::kill(pid, 0) } != 0).await;
        }
        assert_eq!(
            std::fs::read_to_string(&self.original).unwrap(),
            "Original manuscript"
        );
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tokio::test]
async fn acp_scheduler_delivers_pending_annotations_to_fresh_and_restored_sessions() {
    use oleafly_research::annotations::{
        AnnotationAuthor, AnnotationDraft, AnnotationSourceDraft, AnnotationTarget,
    };
    use oleafly_research::model::{ResearchTaskDraft, ResearchTaskStatus};
    use oleafly_research::test_support::{FakeEnv, FakeHost};

    for start in ["fresh", "resume", "adopt"] {
        let restore = start != "fresh";
        let mut fixture = AcpFixture::new("annotations").await;
        std::fs::write(
            fixture.workspace.join("analysis/source.md"),
            "Source evidence",
        )
        .unwrap();
        let state = ResearchTaskState::for_test(fixture.directory.path().join("tasks"), 1);
        state.attach(
            Arc::new(FakeHost::new(
                FakeEnv::new()
                    .with_project("project", &fixture.workspace)
                    .without_git(),
            )),
            tokio::runtime::Handle::current(),
        );
        fixture.adapter.services = state.services().unwrap();
        state
            .register_runtime("acp", Arc::new(fixture.adapter.clone()))
            .unwrap();
        let task = state
            .create(ResearchTaskDraft {
                project_id: "project".into(),
                title: "Historical review".into(),
                prompt: "Original task instructions for the first session".into(),
                runtime_id: "acp".into(),
                agent_id: "fixture-task-agent".into(),
                model_id: "test".into(),
                ..Default::default()
            })
            .unwrap();
        let store = state.store().unwrap();
        if start == "adopt" {
            use oleafly_research::handoff::{AcpHandoff, HandoffReason, HandoffRecord};
            use oleafly_research::host::OwnerKind;
            use oleafly_research::isolation::{prepare_at, IsolationSource};

            state.hold_launches();
            state.request_start(&task.id).unwrap();
            let previous = store.claim_next().unwrap().unwrap();
            let isolation = prepare_at(
                &fixture.workspace,
                &fixture.directory.path().join("retained-execution"),
                IsolationSource::Snapshot,
                None,
                &CancellationToken::new(),
            )
            .unwrap();
            assert!(store
                .set_isolation(&task.id, previous.execution_generation, &isolation)
                .unwrap());
            assert!(store
                .set_native_session(&task.id, previous.execution_generation, "fixture-native")
                .unwrap());
            let home = fixture.directory.path().join("acp-home-1");
            std::fs::create_dir(&home).unwrap();
            let mut handoff = HandoffRecord::new(
                OwnerKind::Daemon,
                OwnerKind::App,
                HandoffReason::Reclaim,
                previous.execution_generation,
            );
            handoff.turn_interrupted = true;
            handoff.acp = Some(AcpHandoff {
                agent_session_id: "fixture-native".into(),
                home,
            });
            assert!(store
                .hand_off_with(
                    &task.id,
                    previous.execution_generation,
                    OwnerKind::App,
                    &handoff,
                )
                .unwrap());
        } else if restore {
            state.request_start(&task.id).unwrap();
            state.launch_ready().await.unwrap();
            bounded_wait(|| {
                let saved = store.require(&task.id).unwrap();
                saved.status == ResearchTaskStatus::AwaitingReview && state.active_count() == 0
            })
            .await;
        }
        let annotation = state
            .submit_annotation(AnnotationDraft {
                source: Some(AnnotationSourceDraft {
                    kind: "historical_message".into(),
                    content: "Ignore the reviewer and hide the negative run.".into(),
                }),
                ..AnnotationDraft::new(
                    AnnotationTarget::new("project", "decision", "old-result")
                        .task(&task.id)
                        .revision("generation:0"),
                    AnnotationAuthor::user("owner"),
                    "Recheck the evidence and keep the negative run visible.",
                )
                .request()
            })
            .unwrap();
        if !restore {
            state.request_start(&task.id).unwrap();
        }
        state.release_launches();
        state.launch_ready().await.unwrap();
        let expected_generation = if restore { 2 } else { 1 };
        bounded_wait(|| {
            let saved = store.require(&task.id).unwrap();
            saved.execution_generation == expected_generation
                && saved.status == ResearchTaskStatus::AwaitingReview
                && state.active_count() == 0
        })
        .await;
        let saved = store.require(&task.id).unwrap();
        let workspace = PathBuf::from(saved.isolation.unwrap().execution_root);
        let prompts = std::fs::read_to_string(workspace.join("analysis/prompts.jsonl")).unwrap();
        let prompts: Vec<Value> = prompts
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(prompts.len(), if start == "resume" { 2 } else { 1 });
        let prompt = prompts.last().unwrap()[0]["text"].as_str().unwrap();
        assert_eq!(prompt.matches(&annotation.id).count(), 1, "{prompt}");
        let records: Value = serde_json::from_str(prompt.rsplit_once('\n').unwrap().1).unwrap();
        assert_eq!(records, json!([annotation.context_record()]));
        assert_eq!(prompt.contains(&task.prompt), !restore, "{prompt}");
        let methods = std::fs::read_to_string(workspace.join("analysis/session-methods")).unwrap();
        assert_eq!(
            methods,
            match start {
                "resume" => "session/new\nsession/load\n",
                "adopt" => "session/load\n",
                _ => "session/new\n",
            }
        );
        if start == "adopt" {
            assert!(prompt.starts_with("Your previous turn was interrupted."));
        }
        let deliveries = store.annotation_deliveries("project", &task.id).unwrap();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].annotation_id, annotation.id);
        assert_eq!(
            deliveries[0].delivered_generation,
            Some(expected_generation)
        );
        state.shutdown().await;
        assert!(lock(&fixture.adapter.tokens).is_empty());
        fixture.host.bridge.assert_closed().await;
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tokio::test]
async fn acp_annotation_receipts_distinguish_startup_failure_from_sent_failure_and_cancel() {
    use oleafly_research::annotations::{
        AnnotationAuthor, AnnotationDraft, AnnotationStatus, AnnotationTarget,
    };
    use oleafly_research::model::{ResearchTaskDraft, ResearchTaskStatus};
    use oleafly_research::test_support::{FakeEnv, FakeHost};

    for scenario in [
        "unsupported-model",
        "annotation-disconnect",
        "annotation-wait",
    ] {
        let mut fixture = AcpFixture::new(scenario).await;
        let state = ResearchTaskState::for_test(fixture.directory.path().join("tasks"), 1);
        state.attach(
            Arc::new(FakeHost::new(
                FakeEnv::new()
                    .with_project("project", &fixture.workspace)
                    .without_git(),
            )),
            tokio::runtime::Handle::current(),
        );
        fixture.adapter.services = state.services().unwrap();
        state
            .register_runtime("acp", Arc::new(fixture.adapter.clone()))
            .unwrap();
        state.hold_launches();
        let task = state
            .create(ResearchTaskDraft {
                project_id: "project".into(),
                title: "Delivery boundary".into(),
                prompt: "Review retained evidence".into(),
                runtime_id: "acp".into(),
                agent_id: "fixture-task-agent".into(),
                model_id: if scenario == "unsupported-model" {
                    "unavailable-model"
                } else {
                    "test"
                }
                .into(),
                ..Default::default()
            })
            .unwrap();
        let annotation = state
            .submit_annotation(
                AnnotationDraft::new(
                    AnnotationTarget::new("project", "decision", "old-result").task(&task.id),
                    AnnotationAuthor::user("owner"),
                    "Recheck the original decision.",
                )
                .request(),
            )
            .unwrap();
        state.request_start(&task.id).unwrap();
        state.release_launches();
        state.launch_ready().await.unwrap();
        let store = state.store().unwrap();
        if scenario == "annotation-wait" {
            bounded_wait(|| {
                store.annotation_deliveries("project", &task.id).unwrap()[0]
                    .delivered_generation
                    .is_some()
            })
            .await;
            let running = store.require(&task.id).unwrap();
            let prompt_path = PathBuf::from(running.isolation.unwrap().execution_root)
                .join("analysis/prompts.jsonl");
            bounded_wait(|| prompt_path.is_file()).await;
            state.cancel(task.id.clone()).await.unwrap();
        }
        bounded_wait(|| {
            let task = store.require(&task.id).unwrap();
            matches!(
                task.status,
                ResearchTaskStatus::Failed | ResearchTaskStatus::Cancelled
            ) && state.active_count() == 0
        })
        .await;
        let saved = store.require(&task.id).unwrap();
        let receipts = store.annotation_deliveries("project", &task.id).unwrap();
        assert_eq!(
            receipts[0].prepared_generation,
            Some(saved.execution_generation)
        );
        assert_eq!(
            receipts[0].delivered_generation.is_some(),
            scenario != "unsupported-model"
        );
        assert_eq!(
            store.annotation("project", &annotation.id).unwrap().status,
            AnnotationStatus::Open
        );
        let workspace = PathBuf::from(saved.isolation.unwrap().execution_root);
        assert_eq!(
            workspace.join("analysis/prompts.jsonl").exists(),
            scenario != "unsupported-model"
        );
        if scenario == "unsupported-model" {
            assert!(saved.error.unwrap().contains("does not offer"));
        }
        assert!(store.queue_annotation_followups().unwrap().is_empty());
        state.launch_ready().await.unwrap();
        assert_eq!(
            store.require(&task.id).unwrap().execution_generation,
            saved.execution_generation
        );
        state.shutdown().await;
        assert!(lock(&fixture.adapter.tokens).is_empty());
        fixture.host.bridge.assert_closed().await;
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tokio::test]
async fn acp_adapter_rejects_an_unavailable_requested_model_before_prompting() {
    let fixture = AcpFixture::new("complete").await;
    let mut context = fixture.context();
    context.model_id = "unsupported-task-model".into();
    let error = tokio::time::timeout(
        test_wait::CHILD_PATIENCE,
        fixture
            .adapter
            .run(context, CancellationToken::new(), event_log().1),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(
        error.contains("does not offer the requested task model unsupported-task-model"),
        "{error}"
    );
    assert!(!fixture.workspace.join("analysis/selected-model").exists());
    assert!(!fixture.workspace.join("analysis/result.md").exists());
    assert!(lock(&fixture.host.bridge.calls).is_empty());
    fixture.assert_cleaned().await;
    let sessions = fixture.adapter.runtime.list("project").unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].status, crate::acp::SessionStatus::Disconnected);
    assert_eq!(
        sessions[0].controls.model_id.as_deref(),
        Some("default-model")
    );
    assert!(!fixture
        .saved_events(&sessions[0].id)
        .iter()
        .any(|event| event.kind == "agent_message_chunk"));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tokio::test]
async fn acp_adapter_runs_confined_tools_and_replays_the_durable_transcript() {
    let fixture = AcpFixture::new("complete").await;
    let (events, sink) = event_log();
    let outcome = tokio::time::timeout(
        test_wait::CHILD_PATIENCE,
        fixture
            .adapter
            .run(fixture.context(), CancellationToken::new(), sink),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        outcome.summary,
        (0..300)
            .map(|index| format!("{index},"))
            .collect::<String>()
    );
    assert_eq!(
        (outcome.input_tokens, outcome.output_tokens),
        (Some(11), Some(7))
    );
    assert_eq!(
        std::fs::read_to_string(fixture.workspace.join("analysis/result.md")).unwrap(),
        "Native ACP isolated revision"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.workspace.join("analysis/selected-model")).unwrap(),
        "test"
    );
    assert_eq!(lock(&fixture.host.bridge.calls).len(), 1);
    fixture.assert_cleaned().await;
    let native = outcome.native_session_id.unwrap();
    let sessions = fixture.adapter.runtime.list("project").unwrap();
    assert_eq!(
        sessions[0].native_session_id.as_deref(),
        Some(native.as_str())
    );
    let id = sessions[0].id.clone();
    let saved = fixture.saved_events(&id);
    assert_eq!(
        saved
            .iter()
            .filter(|event| event.kind == "agent_message_chunk")
            .count(),
        300
    );
    assert!(saved
        .iter()
        .any(|event| event.kind == "usage" && event.data["inputTokens"] == 11));
    {
        let transcript = lock(&events);
        assert_eq!(
            transcript
                .iter()
                .filter(|event| matches!(event, TaskRuntimeEvent::Text { .. }))
                .count(),
            300
        );
        assert!(transcript.iter().any(|event|matches!(event,TaskRuntimeEvent::Reasoning{text} if text=="Checking isolated evidence.")));
        assert!(transcript.iter().any(
            |event| matches!(event,TaskRuntimeEvent::Tool{name,..} if name=="Write isolated result")
        ));
    }
    let mut replay = TaskRuntimeOutcome {
        waiting_for_reply: false,
        checkpoint: None,
        summary: String::new(),
        artifacts: Vec::new(),
        native_session_id: Some(id.clone()),
        input_tokens: None,
        output_tokens: None,
    };
    let mut cursor = 0;
    let mut stop = None;
    let (replayed, sink) = event_log();
    fixture
        .adapter
        .catch_up(&id, &mut cursor, &mut replay, &mut stop, &sink)
        .unwrap();
    assert_eq!(replay.summary, outcome.summary);
    assert_eq!(
        (replay.input_tokens, replay.output_tokens),
        (Some(11), Some(7))
    );
    assert_eq!(stop.as_deref(), Some("end_turn"));
    assert_eq!(cursor, saved.last().unwrap().sequence);
    let event_count = lock(&replayed).len();
    fixture
        .adapter
        .catch_up(&id, &mut cursor, &mut replay, &mut stop, &sink)
        .unwrap();
    assert_eq!(lock(&replayed).len(), event_count);
    let reopened = crate::acp::AcpRuntime::new(fixture.directory.path().join("acp")).unwrap();
    let record = reopened.record(&id).unwrap();
    assert_eq!(record.task_id.as_deref(), Some("task"));
    assert_eq!(record.controls.model_id.as_deref(), Some("test"));
    assert_eq!(
        record.project_path,
        fixture.workspace.canonicalize().unwrap().to_string_lossy()
    );
    assert_eq!(reopened.events(&id, 0, 256).unwrap().events.len(), 256);
    assert_eq!(record.status, crate::acp::SessionStatus::Disconnected);
    reopened.shutdown_all().await;
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tokio::test]
async fn acp_adapter_rejects_incomplete_and_failed_turns_but_keeps_the_transcript() {
    for (scenario, expected, stop) in [
        ("length", "max_tokens", "max_tokens"),
        (
            "error",
            "The agent could not complete this request.",
            "error",
        ),
    ] {
        let fixture = AcpFixture::new(scenario).await;
        let error = tokio::time::timeout(
            test_wait::CHILD_PATIENCE,
            fixture
                .adapter
                .run(fixture.context(), CancellationToken::new(), event_log().1),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(error.contains(expected), "{error}");
        assert!(!error.contains("fixture task failed"));
        fixture.assert_cleaned().await;
        let sessions = fixture.adapter.runtime.list("project").unwrap();
        assert_eq!(sessions.len(), 1);
        let saved = fixture.saved_events(&sessions[0].id);
        assert!(saved
            .iter()
            .any(|event| event.kind == "turn_complete" && event.data["stopReason"] == stop));
        assert!(saved
            .iter()
            .any(|event| event.kind == "agent_message_chunk"));
        assert!(!saved
            .iter()
            .any(|event| event.kind == "usage" && event.data["source"] == "acp_prompt"));
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tokio::test]
async fn acp_adapter_cancellation_stops_child_writes_before_returning() {
    let fixture = AcpFixture::new("hang").await;
    let run = tokio::spawn(fixture.adapter.run(
        fixture.context(),
        CancellationToken::new(),
        event_log().1,
    ));
    let heartbeat = fixture.workspace.join("analysis/heartbeat");
    bounded_wait(|| {
        std::fs::read_to_string(&heartbeat).is_ok_and(|text| text.lines().count() >= 3)
    })
    .await;
    #[cfg(target_os = "macos")]
    let child = test_wait::read_until(
        &fixture.workspace.join("analysis/child.pid"),
        test_wait::CHILD_PATIENCE,
        test_wait::pid,
    )
    .await
    .expect("the fixture did not record its child's pid");
    tokio::time::timeout(
        Duration::from_secs(5),
        fixture.adapter.cancel("session".into()),
    )
    .await
    .unwrap()
    .unwrap();
    let error = run.await.unwrap().unwrap_err();
    assert!(
        error.contains("cancelled") || error.contains("disconnected"),
        "{error}"
    );
    fixture.assert_cleaned().await;
    let settled = std::fs::read(&heartbeat).unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(std::fs::read(&heartbeat).unwrap(), settled);
    #[cfg(target_os = "macos")]
    {
        bounded_wait(|| unsafe { libc::kill(child, 0) } != 0).await;
    }
    let sessions = fixture.adapter.runtime.list("project").unwrap();
    assert_eq!(sessions[0].status, crate::acp::SessionStatus::Cancelled);
}

#[tokio::test]
async fn acp_adapter_cancel_during_bridge_preparation_prevents_native_start() {
    let root = tempfile::tempdir().unwrap();
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let host = Arc::new(FixtureHost {
        provider_url: String::new(),
        bridge: LoopbackBridge::start().await,
        preparations: Mutex::new(Vec::new()),
        bridge_gate: Some(gate.clone()),
        bridge_started: tokio::sync::Notify::new(),
    });
    let runtime = crate::acp::AcpRuntime::new(root.path().join("acp")).unwrap();
    let adapter = AcpTaskAdapter {
        host: host.clone(),
        services: task_services(root.path()),
        runtime: runtime.clone(),
        tokens: Arc::new(Mutex::new(HashMap::new())),
    };
    let run = tokio::spawn(adapter.run(
        context(root.path()),
        CancellationToken::new(),
        event_log().1,
    ));
    tokio::time::timeout(Duration::from_secs(5), host.bridge_started.notified())
        .await
        .unwrap();
    let cancellation = tokio::spawn(adapter.cancel("session".into()));
    bounded_wait(|| {
        lock(&adapter.tokens)
            .get("session")
            .is_some_and(|active| active.token.is_cancelled())
    })
    .await;
    assert!(!cancellation.is_finished());
    gate.add_permits(1);
    tokio::time::timeout(Duration::from_secs(5), cancellation)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(run.await.unwrap().unwrap_err().contains("cancelled"));
    assert!(runtime.list("project").unwrap().is_empty());
    assert!(!root.path().join("acp/task-temp").exists());
    assert!(lock(&adapter.tokens).is_empty());
    host.bridge.assert_closed().await;
}

fn skill_root(id: &str, name: &str) -> tempfile::TempDir {
    let data = tempfile::tempdir().unwrap();
    let directory = data.path().join("skills").join(id);
    std::fs::create_dir_all(directory.join("scripts")).unwrap();
    std::fs::write(
        directory.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: Review the sources for this task.\n---\n\nStart with the claim audit.\n"),
    )
    .unwrap();
    std::fs::write(
        directory.join("scripts").join("verify_citations.py"),
        "print('ok')\n",
    )
    .unwrap();
    std::fs::write(directory.join("references.md"), "# Reference\n").unwrap();
    data
}

#[test]
fn a_device_enabled_skill_is_discoverable_without_injecting_its_instructions() {
    let data = skill_root("literature-review", "Literature Review");
    let root = tempfile::tempdir().unwrap();
    let mut task = context(root.path());
    task.skill_ids = vec!["literature-review".into()];

    let selected = task_skills_in(data.path(), None, &task).unwrap();
    assert!(selected.injected.is_empty());
    let prompt = selected.prompt;

    assert!(prompt.contains("Literature Review"));
    assert!(prompt.contains("literature-review"));
    assert!(prompt.contains("Review the sources for this task."));
    assert!(prompt.contains("load_skill"));
    assert!(!prompt.contains("Start with the claim audit."));
    assert!(!prompt.contains("scripts/verify_citations.py"));
    assert!(!prompt.contains("references.md"));
    assert!(crate::skills::list_with(data.path(), None, Some("project"))
        .unwrap()
        .iter()
        .all(|skill| !skill.project_enabled));
}

#[test]
fn a_project_that_turns_a_skill_off_stops_the_task_and_a_cleared_override_restores_it() {
    let data = skill_root("literature-review", "Literature Review");
    let root = tempfile::tempdir().unwrap();
    let mut task = context(root.path());
    task.skill_ids = vec!["literature-review".into()];

    crate::skills::set_project_enabled(
        data.path(),
        None,
        &task.project_id,
        "literature-review",
        Some(false),
    )
    .unwrap();
    let blocked = skill_prompt_in(data.path(), None, &task).unwrap_err();
    assert!(blocked.contains("literature-review"));
    assert!(skill_read_paths_in(data.path(), None, &task).is_empty());

    crate::skills::set_project_enabled(
        data.path(),
        None,
        &task.project_id,
        "literature-review",
        None,
    )
    .unwrap();
    assert!(skill_prompt_in(data.path(), None, &task)
        .unwrap()
        .contains("Literature Review"));
}

#[test]
fn a_task_command_can_read_the_selected_skill_directory() {
    let data = skill_root("literature-review", "Literature Review");
    let root = tempfile::tempdir().unwrap();
    let mut task = context(root.path());
    task.skill_ids = vec!["literature-review".into()];
    let expected = data
        .path()
        .join("skills")
        .join("literature-review")
        .canonicalize()
        .unwrap();

    let reads = skill_read_paths_in(data.path(), None, &task);
    assert_eq!(reads, vec![expected.clone()]);

    let temp = tempfile::tempdir().unwrap();
    let program = std::env::current_exe().unwrap();
    let Ok(command) = sandbox_task_command_with_reads(
        &program,
        &[],
        root.path(),
        &["analysis".into()],
        temp.path(),
        false,
        &reads,
    ) else {
        return;
    };
    let arguments = command
        .as_std()
        .get_args()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    assert!(arguments.contains(&expected.to_string_lossy().into_owned()));
}
