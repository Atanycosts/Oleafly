use crate::proc::NoConsole;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct JournalWorkbenchState(Mutex<Option<Session>>);

struct Session {
    child: Child,
    address: String,
    token: String,
    client: reqwest::Client,
    library_root: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    python: String,
    library_root: String,
}

fn runtime_path() -> Result<PathBuf, String> {
    Ok(crate::paths::oleafly_root()?.join("workbench-python.json"))
}

fn configured_python() -> Result<String, String> {
    if let Ok(python) = std::env::var("OLEAFLY_WORKBENCH_PYTHON") {
        return Ok(python);
    }
    let path = runtime_path()?;
    if !path.exists() {
        return Err(
            "Choose the Python executable from the Workbench environment to connect.".into(),
        );
    }
    serde_json::from_slice(
        &std::fs::read(path)
            .map_err(|error| format!("could not read Workbench runtime: {error}"))?,
    )
    .map_err(|error| format!("invalid Workbench runtime setting: {error}"))
}

async fn start(python: &str, library_root: &std::path::Path) -> Result<Session, String> {
    let mut command = Command::new(python);
    command
        .args(["-u", "-m", "research_file_workbench.workbench.launcher"])
        .arg("--library-root")
        .arg(library_root)
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONHOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    command.no_console();
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start Workbench with {python}: {error}"))?;
    let mut address = String::new();
    let output = child.stdout.take().expect("piped stdout");
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        BufReader::new(output).read_line(&mut address),
    )
    .await
    .map_err(|_| "Workbench startup timed out".to_string())?
    .map_err(|error| format!("could not read Workbench startup: {error}"))?;
    let url = reqwest::Url::parse(address.trim())
        .map_err(|_| "Workbench did not return its local service address".to_string())?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
        return Err("Workbench did not return a bound loopback address".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let session: Value = client
        .get(url.join("api/session").map_err(|error| error.to_string())?)
        .send()
        .await
        .map_err(|error| format!("could not connect to Workbench: {error}"))?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;
    if session["contract_version"] != "journal-http-1.5.0" {
        return Err("This Workbench HTTP version is not supported.".into());
    }
    let token = session["token"]
        .as_str()
        .ok_or("Workbench did not return a session token")?
        .to_string();
    Ok(Session {
        child,
        address: url.to_string(),
        token,
        client,
        library_root: library_root.to_path_buf(),
    })
}

async fn request(session: &Session, path: &str, payload: Option<Value>) -> Result<Value, String> {
    if !path.starts_with("/api/") {
        return Err("Choose a Workbench API operation.".into());
    }
    let url = format!("{}{path}", session.address.trim_end_matches('/'));
    let request = match payload {
        Some(payload) => session
            .client
            .post(url)
            .header("X-RFW-Token", &session.token)
            .json(&payload),
        None => session.client.get(url),
    };
    let response = request
        .send()
        .await
        .map_err(|error| format!("Workbench request failed: {error}"))?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(body["error"]
            .as_str()
            .unwrap_or(status.as_str())
            .to_string());
    }
    Ok(body)
}

#[tauri::command]
pub async fn journal_workbench_connect(
    state: State<'_, JournalWorkbenchState>,
    python: Option<String>,
) -> Result<Connection, String> {
    let python = python.map_or_else(configured_python, Ok)?;
    let library_root = crate::paths::oleafly_root()?.join("journal-library");
    let mut current = state.0.lock().await;
    if current.is_none() {
        let session = start(&python, &library_root).await?;
        let bytes = serde_json::to_vec(&python).map_err(|error| error.to_string())?;
        crate::sandbox::atomic_write(&runtime_path()?, &bytes)?;
        *current = Some(session);
    }
    Ok(Connection {
        python,
        library_root: library_root.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn journal_workbench_request(
    state: State<'_, JournalWorkbenchState>,
    path: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    let mut current = state.0.lock().await;
    let session = current.as_mut().ok_or("Connect Workbench first.")?;
    if let Some(status) = session
        .child
        .try_wait()
        .map_err(|error| error.to_string())?
    {
        *current = None;
        return Err(format!(
            "Workbench exited ({status}). Reconnect to continue."
        ));
    }
    request(session, &path, payload).await
}

#[tauri::command]
pub async fn journal_workbench_link(
    state: State<'_, JournalWorkbenchState>,
    project_id: String,
    workbench_project_id: String,
) -> Result<crate::research_workspace::ResearchWorkspace, String> {
    let current = state.0.lock().await;
    let session = current.as_ref().ok_or("Connect Workbench first.")?;
    // Resolve the association against the selected library before retaining it in Oleafly.
    let discovery = request(session, "/api/state", None).await?;
    let projects = discovery["projects"]
        .as_array()
        .ok_or("Invalid Workbench project list")?;
    if !projects
        .iter()
        .any(|project| project["project_id"] == workbench_project_id)
    {
        return Err("This manuscript is not in the connected Workbench library.".into());
    }
    crate::research_workspace::roots::set_journal_project(&project_id, workbench_project_id)
}

#[tauri::command]
pub async fn journal_research_create(
    state: State<'_, JournalWorkbenchState>,
    tasks: State<'_, crate::research_tasks::ResearchTaskState>,
    draft: oleafly_research::model::ResearchTaskDraft,
    world_version_id: String,
    check_id: Option<String>,
) -> Result<crate::research_tasks::ResearchTaskView, String> {
    let current = state.0.lock().await;
    let session = current.as_ref().ok_or("Connect Workbench first.")?;
    let query =
        reqwest::Url::parse_with_params("http://127.0.0.1/", &[("version_id", &world_version_id)])
            .map_err(|error| error.to_string())?;
    let query = query.query().expect("version query");
    let world = request(session, &format!("/api/world?{query}"), None).await?;
    let review = request(session, &format!("/api/review?{query}"), None).await?;
    let check = match check_id.clone() {
        Some(id) => {
            let query = reqwest::Url::parse_with_params("http://127.0.0.1/", &[("check_id", id)])
                .map_err(|error| error.to_string())?;
            let query = query.query().expect("check query");
            Some(request(session, &format!("/api/check?{query}"), None).await?)
        }
        None => None,
    };
    let workspace = crate::research_workspace::roots::get_workspace(&draft.project_id)?;
    let linked = workspace
        .journal_project_id
        .ok_or("Link a Workbench manuscript first.")?;
    let discovery = request(session, "/api/state", None).await?;
    let project = discovery["projects"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["project_id"] == linked))
        .ok_or("Linked manuscript missing from this library.")?;
    if let Some(check) = &check {
        if check["project_id"] != linked || check["world_version_id"] != world_version_id {
            return Err(
                "The selected check does not belong to this manuscript and world version.".into(),
            );
        }
    }
    let baseline_id = check
        .as_ref()
        .and_then(|c| c["baseline_id"].as_str())
        .or_else(|| project["baseline_id"].as_str())
        .ok_or("Missing manuscript baseline.")?
        .to_string();
    let baseline_url = reqwest::Url::parse_with_params(
        "http://127.0.0.1/",
        &[("project_id", &linked), ("baseline_id", &baseline_id)],
    )
    .map_err(|error| error.to_string())?;
    let baseline = request(
        session,
        &format!(
            "/api/manuscript?{}",
            baseline_url.query().expect("baseline query")
        ),
        None,
    )
    .await?;
    let snapshot =
        serde_json::json!({"world": world, "review": review, "check": check, "baseline": baseline});
    let input = crate::task_inputs::JournalInput {
        library_root: session.library_root.to_string_lossy().into_owned(),
        world_version_id: world_version_id.clone(),
        check_id: check_id.clone(),
        baseline_id,
        snapshot_sha256: oleafly_research::observations::content_hash(
            &serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?,
        ),
        snapshot,
    };
    drop(current);
    let task =
        crate::task_inputs::research_task_create_with_inputs(tasks, draft, None, Some(input))
            .await?;

    crate::research_workspace::roots::set_journal_research_task(
        &task.project_id,
        task.id.clone(),
        world_version_id,
        check_id,
    )?;
    Ok(task)
}

pub(crate) async fn prepare_research_context(
    app: &tauri::AppHandle,
    context: &oleafly_research::model::TaskRunContext,
) -> Result<(), String> {
    crate::task_inputs::prepare(app, context)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JournalResearchOutput {
    schema_version: String,
    pub summary: String,
    pub component: Option<Value>,
    source_paths: Vec<String>,
    pub questions: Vec<String>,
    pub actions: Vec<String>,
}

#[derive(Serialize)]
pub struct CapturedSource {
    name: String,
    kind: &'static str,
    content_base64: String,
}

#[derive(Serialize)]
pub struct JournalResearchResult {
    #[serde(flatten)]
    output: JournalResearchOutput,
    sources: Vec<CapturedSource>,
}

#[tauri::command]
pub async fn journal_research_result(
    tasks: State<'_, crate::research_tasks::ResearchTaskState>,
    task_id: String,
) -> Result<JournalResearchResult, String> {
    let store = tasks.store()?;
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let task = store.require(&task_id)?;
        let path = format!("{}/journal-review.json", task.record_dir());
        let preview = crate::research_tasks::preview::file_preview(&store, &task_id, &path)?;
        let text = preview
            .after
            .text
            .ok_or("The journal result must be a complete UTF-8 JSON file.")?;
        let output: JournalResearchOutput = serde_json::from_str(&text)
            .map_err(|error| format!("Invalid journal research result: {error}"))?;
        if output.schema_version != "journal-research-result-1.0.0" {
            return Err("Unsupported journal research result version.".into());
        }
        let mut sources = Vec::new();
        for path in &output.source_paths {
            let page = crate::research_tasks::preview::file_preview(&store, &task_id, path)?;
            let content = page
                .after
                .text
                .ok_or("A captured web source must be complete UTF-8 text.")?;
            sources.push(CapturedSource {
                name: path.clone(),
                kind: "guide_text",
                content_base64: base64::engine::general_purpose::STANDARD.encode(content),
            });
        }
        Ok(JournalResearchResult { output, sources })
    })
    .await
    .map_err(|error| format!("could not read journal research output: {error}"))?
}

pub fn shutdown(app: &tauri::AppHandle) {
    if let Ok(mut current) = app.state::<JournalWorkbenchState>().0.try_lock() {
        *current = None;
    }
}
