pub(crate) mod annotations;
pub(crate) mod format;
pub(crate) mod normalization;
pub(crate) mod render;
pub(crate) mod sync;
pub(crate) mod tools;
pub(crate) mod word;

use crate::proc::NoConsole;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

const HTTP_CONTRACT_VERSION: &str = "journal-http-1.20.0";
const BUNDLED_ENGINE_DIRECTORY: &str = "resources/research-workbench";
const BUNDLED_ENGINE_NAME: &str = if cfg!(windows) {
    "rfw-workbench.exe"
} else {
    "rfw-workbench"
};

#[derive(Default)]
pub struct JournalWorkbenchState(
    pub(crate) Mutex<Option<Session>>,
    std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
);

pub(crate) struct Session {
    child: Child,
    address: String,
    token: String,
    client: reqwest::Client,
    library_root: PathBuf,
    runtime: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    python: String,
    library_root: String,
}

enum Runtime {
    Bundled(PathBuf),
    DevelopmentPython(PathBuf),
}

#[derive(Clone, Copy)]
enum BundledEngineIssue {
    UnsupportedPlatform,
    OmittedFromPublicRelease,
    Damaged,
}

impl Runtime {
    fn executable(&self) -> &Path {
        match self {
            Self::Bundled(path) | Self::DevelopmentPython(path) => path,
        }
    }

    fn label(&self) -> String {
        self.executable().to_string_lossy().into_owned()
    }
}

fn bundled_engine_error(issue: BundledEngineIssue, library_root: &Path) -> String {
    let library_root = library_root.display();
    match issue {
        BundledEngineIssue::UnsupportedPlatform => format!(
            "Journal checks are unavailable on this platform build. Existing Journal data \
             stays at {library_root}; nothing was started or migrated. Use an Apple Silicon \
             macOS build that includes the Research Workbench engine, such as a local \
             `pnpm workbench:bundle` build, or inspect a copy with a trusted development \
             checkout. This build will not substitute a saved or environment Python."
        ),
        BundledEngineIssue::OmittedFromPublicRelease => format!(
            "This build was produced without the Research Workbench engine; the current public \
             release policy omits it because bundled PyMuPDF/MuPDF redistribution is not approved. \
             Existing Journal data stays at {library_root}; nothing was started or migrated. Use \
             a locally built Apple Silicon release with `pnpm workbench:bundle`, or inspect a copy \
             with a trusted development checkout. This build will not substitute another Python \
             runtime."
        ),
        BundledEngineIssue::Damaged => format!(
            "The Research Workbench engine in this app is damaged or incomplete. Reinstall this \
             Oleafly build; existing Journal data stays at {library_root}. No other Python \
             runtime was started."
        ),
    }
}

fn resolve_bundled_executable(resources: &Path, library_root: &Path) -> Result<PathBuf, String> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Err(bundled_engine_error(
            BundledEngineIssue::UnsupportedPlatform,
            library_root,
        ));
    }
    let resources = resources
        .canonicalize()
        .map_err(|_| bundled_engine_error(BundledEngineIssue::Damaged, library_root))?;
    let engine_root = resources.join(BUNDLED_ENGINE_DIRECTORY);
    match engine_root.symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(bundled_engine_error(
                BundledEngineIssue::OmittedFromPublicRelease,
                library_root,
            ));
        }
        Err(_) => {
            return Err(bundled_engine_error(
                BundledEngineIssue::Damaged,
                library_root,
            ));
        }
        Ok(_) => {}
    }
    let engine_root = engine_root
        .canonicalize()
        .map_err(|_| bundled_engine_error(BundledEngineIssue::Damaged, library_root))?;
    if !engine_root.starts_with(&resources) || !engine_root.is_dir() {
        return Err(bundled_engine_error(
            BundledEngineIssue::Damaged,
            library_root,
        ));
    }
    let has_payload = std::fs::read_dir(&engine_root)
        .map_err(|_| bundled_engine_error(BundledEngineIssue::Damaged, library_root))?
        .any(|entry| {
            entry.is_ok_and(|entry| entry.file_name() != std::ffi::OsStr::new(".gitkeep"))
        });
    if !has_payload {
        return Err(bundled_engine_error(
            BundledEngineIssue::OmittedFromPublicRelease,
            library_root,
        ));
    }
    let executable = engine_root
        .join(BUNDLED_ENGINE_NAME)
        .canonicalize()
        .map_err(|_| bundled_engine_error(BundledEngineIssue::Damaged, library_root))?;
    if !executable.starts_with(&engine_root) || !executable.is_file() {
        return Err(bundled_engine_error(
            BundledEngineIssue::Damaged,
            library_root,
        ));
    }
    Ok(executable)
}

fn bundled_runtime(app: &tauri::AppHandle, library_root: &Path) -> Result<Runtime, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| bundled_engine_error(BundledEngineIssue::Damaged, library_root))?;
    resolve_bundled_executable(&resources, library_root).map(Runtime::Bundled)
}

fn configured_runtime(app: &tauri::AppHandle, library_root: &Path) -> Result<Runtime, String> {
    if cfg!(debug_assertions) {
        let python = std::env::var("OLEAFLY_WORKBENCH_PYTHON").map_err(|_| {
            "Set OLEAFLY_WORKBENCH_PYTHON or start development with `pnpm tauri dev`.".to_string()
        })?;
        Ok(Runtime::DevelopmentPython(PathBuf::from(python)))
    } else {
        bundled_runtime(app, library_root)
    }
}

async fn start(runtime: &Runtime, library_root: &Path) -> Result<Session, String> {
    let mut font_roots = crate::assets::font_cache_roots()?.to_vec();
    font_roots.push(crate::system_fonts::resolved_font_cache()?);
    let mut command = Command::new(runtime.executable());
    if matches!(runtime, Runtime::DevelopmentPython(_)) {
        command.args(["-u", "-m", "research_file_workbench.workbench.launcher"]);
    }
    command
        .arg("--library-root")
        .arg(library_root)
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONHOME")
        .env_remove("OLEAFLY_WORKBENCH_PYTHON")
        .env(
            "OLEAFLY_FONT_DIRS",
            std::env::join_paths(font_roots).map_err(|error| error.to_string())?,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    command.no_console();
    let runtime_label = runtime.label();
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start Workbench with {runtime_label}: {error}"))?;
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
        .timeout(std::time::Duration::from_secs(25))
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
    if session["contract_version"] != HTTP_CONTRACT_VERSION {
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
        runtime: runtime_label,
    })
}

pub(crate) async fn request(
    session: &Session,
    path: &str,
    payload: Option<Value>,
) -> Result<Value, String> {
    let (status, body) = request_response(session, path, payload).await?;
    response_body(status, body)
}

async fn request_response(
    session: &Session,
    path: &str,
    payload: Option<Value>,
) -> Result<(reqwest::StatusCode, Value), String> {
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
        None => session
            .client
            .get(url)
            .header("X-RFW-Token", &session.token),
    };
    let response = request
        .send()
        .await
        .map_err(|error| format!("Workbench request failed: {error}"))?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    Ok((status, body))
}

fn response_body(status: reqwest::StatusCode, body: Value) -> Result<Value, String> {
    if !status.is_success() {
        return Err(body["error"]
            .as_str()
            .unwrap_or(status.as_str())
            .to_string());
    }
    Ok(body)
}

fn ipc_response_body(status: reqwest::StatusCode, body: Value) -> Result<Value, Value> {
    if status.is_client_error() && body["code"].is_string() && body["error"].is_string() {
        return Err(body);
    }
    response_body(status, body).map_err(Value::String)
}

pub(crate) async fn request_docx_baseline(
    session: &Session,
    payload: Value,
) -> Result<Value, String> {
    let request_id = payload["request_id"]
        .as_str()
        .ok_or("The fixed DOCX save needs a request ID.")?
        .to_string();
    let (status, body) = request_response(session, "/api/baseline", Some(payload)).await?;
    docx_baseline_response(status, body, &request_id)
}

fn docx_baseline_response(
    status: reqwest::StatusCode,
    body: Value,
    request_id: &str,
) -> Result<Value, String> {
    if matches!(
        status,
        reqwest::StatusCode::CONFLICT | reqwest::StatusCode::BAD_REQUEST
    ) && body["request_id"] == request_id
        && matches!(
            body["status"].as_str(),
            Some("BASELINE_CONFLICT" | "REJECTED" | "IDEMPOTENCY_CONFLICT")
        )
        && body.get("result_baseline_id") == Some(&Value::Null)
    {
        return Ok(body);
    }
    response_body(status, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_http_contract_matches_workbench_contract() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../services/research-workbench/contracts/journals/world-contract.json"
        ))
        .unwrap();
        assert_eq!(HTTP_CONTRACT_VERSION, contract["method_versions"]["http"]);
    }

    #[test]
    fn known_refusals_preserve_structured_http_error_bodies_only_for_matching_request() {
        for (http, status) in [
            (reqwest::StatusCode::CONFLICT, "BASELINE_CONFLICT"),
            (reqwest::StatusCode::BAD_REQUEST, "REJECTED"),
            (reqwest::StatusCode::BAD_REQUEST, "IDEMPOTENCY_CONFLICT"),
        ] {
            let body = json!({"request_id":"fixed", "status":status,
                "result_baseline_id":null, "error":"retained refusal"});
            assert_eq!(
                docx_baseline_response(http, body.clone(), "fixed").unwrap(),
                body
            );
            assert!(response_body(http, body.clone()).is_err());
            assert!(docx_baseline_response(http, body.clone(), "other").is_err());
            let mut unknown = body.clone();
            unknown["status"] = "UNKNOWN".into();
            assert!(docx_baseline_response(http, unknown, "fixed").is_err());
            let mut applied = body.clone();
            applied["result_baseline_id"] = "baseline".into();
            assert!(docx_baseline_response(http, applied, "fixed").is_err());
            let mut missing = body.clone();
            missing
                .as_object_mut()
                .unwrap()
                .remove("result_baseline_id");
            assert!(docx_baseline_response(http, missing, "fixed").is_err());
            assert!(docx_baseline_response(
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                body,
                "fixed"
            )
            .is_err());
        }
        // Older or unstructured service errors cannot confirm a retained refusal.
        assert!(docx_baseline_response(
            reqwest::StatusCode::CONFLICT,
            json!({"error":"论文版本已变化，请重新读取当前状态。"}),
            "fixed"
        )
        .is_err());
        assert!(docx_baseline_response(
            reqwest::StatusCode::BAD_REQUEST,
            json!({"error":"REJECTED：该文档未能读取，请检查源文件。"}),
            "fixed"
        )
        .is_err());
    }

    #[test]
    fn bundled_engine_errors_are_distinct_and_preserve_the_library() {
        let library = Path::new("/tmp/Oleafly/journal-library");
        let unsupported = bundled_engine_error(BundledEngineIssue::UnsupportedPlatform, library);
        let omitted = bundled_engine_error(BundledEngineIssue::OmittedFromPublicRelease, library);
        let damaged = bundled_engine_error(BundledEngineIssue::Damaged, library);

        assert!(unsupported.contains("unavailable on this platform build"));
        assert!(omitted.contains("produced without the Research Workbench engine"));
        assert!(damaged.contains("damaged or incomplete"));
        for message in [&unsupported, &omitted, &damaged] {
            assert!(message.contains(library.to_string_lossy().as_ref()));
            assert!(message.contains("Journal data"));
        }
        assert!(unsupported.contains("will not substitute a saved or environment Python"));
        assert!(omitted.contains("will not substitute another Python runtime"));
        assert!(damaged.contains("No other Python runtime was started"));
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn bundled_engine_detection_distinguishes_omitted_from_damaged() {
        let temporary = tempfile::tempdir().unwrap();
        let resources = temporary.path().join("Resources");
        let library = temporary.path().join("journal-library");
        std::fs::create_dir_all(&resources).unwrap();

        let omitted = resolve_bundled_executable(&resources, &library).unwrap_err();
        assert!(omitted.contains("produced without the Research Workbench engine"));

        let engine_root = resources.join(BUNDLED_ENGINE_DIRECTORY);
        std::fs::create_dir_all(&engine_root).unwrap();
        std::fs::write(engine_root.join(".gitkeep"), b"").unwrap();
        let unbundled = resolve_bundled_executable(&resources, &library).unwrap_err();
        assert!(unbundled.contains("produced without the Research Workbench engine"));

        std::fs::write(engine_root.join("_internal"), b"incomplete").unwrap();
        let damaged = resolve_bundled_executable(&resources, &library).unwrap_err();
        assert!(damaged.contains("damaged or incomplete"));

        let executable = engine_root.join(BUNDLED_ENGINE_NAME);
        std::fs::write(&executable, b"engine").unwrap();
        assert_eq!(
            resolve_bundled_executable(&resources, &library).unwrap(),
            executable.canonicalize().unwrap(),
        );
    }
}

pub(crate) async fn retained_docx_source_hash(
    state: &JournalWorkbenchState,
    project_id: &str,
    baseline_id: &str,
) -> Result<String, String> {
    let current = state.0.lock().await;
    let session = current
        .as_ref()
        .ok_or("Connect Workbench before linking a saved DOCX version.")?;
    let query = reqwest::Url::parse_with_params(
        "http://127.0.0.1/",
        &[("project_id", project_id), ("baseline_id", baseline_id)],
    )
    .map_err(|error| error.to_string())?;
    let path = format!(
        "/api/manuscript-source?{}",
        query.query().expect("source query")
    );
    request(session, &path, None).await?["source_sha256"]
        .as_str()
        .map(str::to_owned)
        .ok_or("Workbench did not return the retained DOCX source identity.".into())
}

async fn ensure_started(
    app: &tauri::AppHandle,
    state: &JournalWorkbenchState,
) -> Result<(String, PathBuf), String> {
    let library_root = crate::paths::oleafly_root()?.join("journal-library");
    let mut current = state.0.lock().await;
    if let Some(session) = current.as_mut() {
        if session
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            return Ok((session.runtime.clone(), session.library_root.clone()));
        }
        *current = None;
    }
    let runtime = configured_runtime(app, &library_root)?;
    let label = runtime.label();
    std::fs::create_dir_all(&library_root).map_err(|error| error.to_string())?;
    let library_root = library_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let session = start(&runtime, &library_root).await?;
    *current = Some(session);
    Ok((label, library_root))
}

#[tauri::command]
pub async fn journal_workbench_connect(
    app: tauri::AppHandle,
    state: State<'_, JournalWorkbenchState>,
) -> Result<Connection, String> {
    let (python, library_root) = ensure_started(&app, &state).await?;
    start_reconciliation(&app, &state)?;
    Ok(Connection {
        python,
        library_root: library_root.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn journal_workbench_request(
    app: tauri::AppHandle,
    state: State<'_, JournalWorkbenchState>,
    path: String,
    payload: Option<Value>,
) -> Result<Value, Value> {
    let mut current = state.0.lock().await;
    let session = current.as_mut().ok_or("Connect Workbench first.")?;
    if let Some(status) = session
        .child
        .try_wait()
        .map_err(|error| error.to_string())?
    {
        *current = None;
        return Err(format!("Workbench exited ({status}). Reconnect to continue.").into());
    }
    let changed =
        payload.is_some() && !matches!(path.as_str(), "/api/docx-query" | "/api/docx-normalize");
    let (status, body) = request_response(session, &path, payload).await?;
    let result = ipc_response_body(status, body)?;
    drop(current);
    if changed {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = reconcile_and_schedule(&app).await {
                let _ = crate::project::append_app_log(format!(
                    "Workbench committed; task synchronization remains pending: {error}"
                ));
            }
        });
    }
    Ok(result)
}

/// Normalize a user-selected template without opening the author path for writing.
#[tauri::command]
pub async fn journal_template_normalize(
    app: tauri::AppHandle,
    state: State<'_, JournalWorkbenchState>,
    name: String,
    content_base64: String,
    executable: Option<String>,
) -> Result<Value, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content_base64)
        .map_err(|error| format!("Could not read the selected Word template: {error}"))?;
    let renderer = executable.map(PathBuf::from).or_else(render::find_renderer);
    let temporary_root = crate::paths::oleafly_root()?.join("tmp/template-imports");
    ensure_started(&app, &state).await?;
    let current = state.0.lock().await;
    let session = current
        .as_ref()
        .ok_or("Connect Workbench before importing a Word template.")?;
    let normalized = normalization::normalize_template_bytes(
        session,
        &name,
        bytes,
        renderer.as_deref(),
        &temporary_root,
    )
    .await?;
    let provenance = normalized.conversion.as_ref().map(|conversion| {
        serde_json::json!({
            "engine": conversion.engine, "version": conversion.version,
            "method": conversion.method, "converted_sha256": conversion.converted_sha256,
        })
    });
    let filename = if normalized.conversion.is_some() {
        format!(
            "{}.docx",
            std::path::Path::new(&name)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
        )
    } else {
        name.clone()
    };
    Ok(serde_json::json!({
        "original": {"filename": name, "content_base64": base64::engine::general_purpose::STANDARD.encode(normalized.original_bytes)},
        "normalized": {"filename": filename, "content_base64": base64::engine::general_purpose::STANDARD.encode(normalized.docx_bytes), "provenance": provenance},
        "original_sha256": normalized.original_sha256, "source_sha256": normalized.docx_sha256,
    }))
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
        manuscript_id: Some(linked),
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
    crate::task_inputs::prepare(app, context)?;
    let tasks = app.state::<crate::research_tasks::ResearchTaskState>();
    let store = tasks.store()?;
    if crate::task_inputs::journal_input(store.root(), &context.task_id)?.is_some() {
        let workbench = app.state::<JournalWorkbenchState>();
        ensure_started(app, &workbench).await?;
        let current = workbench.0.lock().await;
        sync::reconcile_task(
            current.as_ref().expect("connected Workbench"),
            &store,
            &context.task_id,
        )
        .await?;
        drop(current);
        start_reconciliation(app, &workbench)?;
    }
    Ok(())
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
    if let Ok(mut worker) = app.state::<JournalWorkbenchState>().1.lock() {
        if let Some(worker) = worker.take() {
            worker.abort();
        }
    }
    if let Ok(mut current) = app.state::<JournalWorkbenchState>().0.try_lock() {
        *current = None;
    }
}

/// Reconnect retained task scopes on application restart, even while their
/// members are idle and the Journal panel has not been opened.
pub(crate) async fn resume(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<JournalWorkbenchState>();
    start_reconciliation(app, &state)
}

fn start_reconciliation(
    app: &tauri::AppHandle,
    state: &JournalWorkbenchState,
) -> Result<(), String> {
    let mut worker = state.1.lock().map_err(|error| error.to_string())?;
    if worker.as_ref().is_some_and(|worker| !worker.is_finished()) {
        return Ok(());
    }
    let app = app.clone();
    *worker = Some(tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_error = None;
        loop {
            interval.tick().await;
            let outcome = reconcile_and_schedule(&app).await;
            match outcome {
                Ok(()) => last_error = None,
                Err(error) if last_error.as_ref() != Some(&error) => {
                    let _ = crate::project::append_app_log(format!(
                        "Workbench task reconciliation: {error}"
                    ));
                    last_error = Some(error);
                }
                Err(_) => {}
            }
        }
    }));
    Ok(())
}

async fn reconcile_and_schedule(app: &tauri::AppHandle) -> Result<(), String> {
    let tasks = app.state::<crate::research_tasks::ResearchTaskState>();
    if !tasks.enabled() {
        return Ok(());
    }
    let store = tasks.store()?;
    let mut inputs = Vec::new();
    let mut failures = Vec::new();
    for task in store.all_tasks()? {
        match crate::task_inputs::journal_input(store.root(), &task.id) {
            Ok(Some(_)) => inputs.push(task.id),
            Ok(None) => {}
            Err(error) => failures.push(format!("{}: {error}", task.id)),
        }
    }
    if inputs.is_empty() {
        return if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        };
    }
    let workbench = app.state::<JournalWorkbenchState>();
    ensure_started(app, &workbench).await?;
    let current = workbench.0.lock().await;
    let session = current.as_ref().ok_or("Connect Workbench first.")?;
    for task_id in inputs {
        if let Err(error) = sync::reconcile_task(session, &store, &task_id).await {
            failures.push(format!("{task_id}: {error}"));
        }
    }
    drop(current);
    // Launch outside the Workbench lock: preparing a member bridge reads the
    // same application service. The existing scheduler serializes task writes.
    tasks.launch_ready().await?;
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}
