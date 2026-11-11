//! Render a retained DOCX baseline and present its exact derived PDF.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::State;

use super::JournalWorkbenchState;

fn find_renderer() -> Option<PathBuf> {
    if let Some(selected) = std::env::var_os("OLEAFLY_LIBREOFFICE") {
        return Some(PathBuf::from(selected));
    }
    if let Some(located) = crate::program_locator::locate_native("soffice") {
        return Some(located.path);
    }
    #[cfg(target_os = "macos")]
    {
        let installed = PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice");
        if installed.is_file() {
            return Some(installed);
        }
    }
    #[cfg(windows)]
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(variable) {
            let installed = PathBuf::from(root).join("LibreOffice/program/soffice.exe");
            if installed.is_file() {
                return Some(installed);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn journal_docx_renderer() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        find_renderer().map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn journal_docx_render(
    state: State<'_, JournalWorkbenchState>,
    project_id: String,
    baseline_id: String,
    executable: String,
) -> Result<Value, String> {
    let current = state.0.lock().await;
    let session = current.as_ref().ok_or("Connect Workbench first.")?;
    // Rendering has its own deadline; ordinary Workbench requests retain the short timeout.
    let url = format!("{}api/render-baseline", session.address);
    let client = session.client.clone();
    let token = session.token.clone();
    drop(current);
    let response = client
        .post(url)
        .timeout(Duration::from_secs(150))
        .header("X-RFW-Token", token)
        .json(&json!({
            "project_id": project_id,
            "baseline_id": baseline_id,
            "libreoffice_executable": executable,
            "reason": "Refresh the PDF preview of this saved DOCX working-copy version."
        }))
        .send()
        .await
        .map_err(|error| format!("DOCX rendering request failed: {error}"))?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(body["error"].as_str().unwrap_or(status.as_str()).to_owned());
    }
    Ok(body)
}

#[tauri::command]
pub async fn journal_docx_pdf(
    state: State<'_, JournalWorkbenchState>,
    project_id: String,
    baseline_id: String,
    bundle_id: String,
) -> Result<tauri::ipc::Response, String> {
    let current = state.0.lock().await;
    let session = current.as_ref().ok_or("Connect Workbench first.")?;
    let mut url = reqwest::Url::parse(&session.address).map_err(|error| error.to_string())?;
    url.set_path("/api/render");
    url.query_pairs_mut()
        .append_pair("project_id", &project_id)
        .append_pair("baseline_id", &baseline_id)
        .append_pair("bundle_id", &bundle_id)
        .append_pair("role", "pdf")
        .append_pair("page_number", "none");
    let response = session
        .client
        .get(url)
        .header("X-RFW-Token", &session.token)
        .send()
        .await
        .map_err(|error| format!("Could not read the retained DOCX PDF: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body: Value = response.json().await.map_err(|error| error.to_string())?;
        return Err(body["error"].as_str().unwrap_or(status.as_str()).to_owned());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}
