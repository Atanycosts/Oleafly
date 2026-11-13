//! Main-renderer bridge for content-bound DOCX format snapshots.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

use super::{request, Session};

struct Pending {
    reply: oneshot::Sender<Result<Value, String>>,
    claimed: bool,
}

fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Pending>> {
    pending()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct Forget(String);

impl Drop for Forget {
    fn drop(&mut self) {
        lock().remove(&self.0);
    }
}

fn token() -> String {
    let mut random = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut random);
    random.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(super) async fn derive_snapshot(
    app: &tauri::AppHandle,
    project_id: &str,
    baseline_id: &str,
    source_sha256: &str,
    source: &[u8],
) -> Result<Value, String> {
    if app.get_webview_window("main").is_none() {
        return Err("The Oleafly main window is unavailable.".into());
    }
    let token = token();
    let (reply, answer) = oneshot::channel();
    lock().insert(
        token.clone(),
        Pending {
            reply,
            claimed: false,
        },
    );
    let _forget = Forget(token.clone());
    app.emit_to(
        "main",
        "journal-format-request",
        json!({
            "token": token,
            "projectId": project_id,
            "baselineId": baseline_id,
            "sourceSha256": source_sha256,
            "contentBase64": base64::engine::general_purpose::STANDARD.encode(source),
        }),
    )
    .map_err(|error| error.to_string())?;
    let snapshot = tokio::time::timeout(Duration::from_secs(45), answer)
        .await
        .map_err(|_| "The DOCX format bridge did not answer in time.".to_string())?
        .map_err(|_| "The DOCX format bridge request ended.".to_string())??;
    snapshot_identity(&snapshot, source_sha256)?;
    Ok(snapshot)
}

fn snapshot_identity(snapshot: &Value, source_sha256: &str) -> Result<(), String> {
    if snapshot["schema_version"] != 1 {
        return Err("The DOCX format bridge returned an unsupported snapshot.".into());
    }
    if snapshot["source_sha256"] != source_sha256 {
        return Err("The DOCX format snapshot does not match the retained source bytes.".into());
    }
    Ok(())
}

fn claim(token: &str) -> Result<(), String> {
    let mut requests = lock();
    let request = requests
        .get_mut(token)
        .ok_or("This DOCX format request ended.")?;
    if request.claimed {
        return Err("This DOCX format request was already received.".into());
    }
    request.claimed = true;
    Ok(())
}

fn finish(token: &str, result: Option<Value>, error: Option<String>) -> Result<(), String> {
    let mut requests = lock();
    let request = requests
        .get(token)
        .ok_or("This DOCX format request ended.")?;
    if !request.claimed {
        return Err("Claim the DOCX format request before answering it.".into());
    }
    let pending = requests
        .remove(token)
        .expect("checked pending format request");
    drop(requests);
    let outcome = match (result, error) {
        (_, Some(error)) => Err(error),
        (Some(result), None) => Ok(result),
        _ => Err("The DOCX format bridge returned no snapshot.".into()),
    };
    let _ = pending.reply.send(outcome);
    Ok(())
}

#[tauri::command]
pub fn journal_format_claim(window: tauri::WebviewWindow, token: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can receive this format request.".into());
    }
    claim(&token)
}

#[tauri::command]
pub fn journal_format_result(
    window: tauri::WebviewWindow,
    token: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can answer this format request.".into());
    }
    finish(&token, result, error)
}

/// Retain content-bound format facts for one exact saved DOCX baseline.
pub(crate) async fn retain_baseline_format(
    app: &tauri::AppHandle,
    session: &Session,
    project_id: &str,
    baseline_id: &str,
) -> Result<Value, String> {
    let query = reqwest::Url::parse_with_params(
        "http://127.0.0.1/",
        &[("project_id", project_id), ("baseline_id", baseline_id)],
    )
    .map_err(|error| error.to_string())?;
    let source = request(
        session,
        &format!(
            "/api/manuscript-source?{}",
            query.query().unwrap_or_default()
        ),
        None,
    )
    .await?;
    if source["project_id"] != project_id || source["baseline_id"] != baseline_id {
        return Err("Workbench returned another manuscript baseline's source.".into());
    }
    let source_sha256 = source["source_sha256"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or("Workbench did not return the retained DOCX source hash.")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(
            source["content_base64"]
                .as_str()
                .ok_or("Workbench did not return the retained DOCX source bytes.")?,
        )
        .map_err(|error| format!("The retained DOCX source is invalid: {error}"))?;
    if oleafly_research::observations::content_hash(&bytes) != source_sha256 {
        return Err("The retained DOCX source hash does not match its recorded identity.".into());
    }
    let snapshot = derive_snapshot(app, project_id, baseline_id, source_sha256, &bytes).await?;
    request(
        session,
        "/api/docx-format",
        Some(json!({
            "project_id": project_id,
            "baseline_id": baseline_id,
            "snapshot": snapshot,
        })),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert(token: &str) -> oneshot::Receiver<Result<Value, String>> {
        let (reply, answer) = oneshot::channel();
        lock().insert(
            token.into(),
            Pending {
                reply,
                claimed: false,
            },
        );
        answer
    }

    #[test]
    fn pending_requests_require_one_successful_claim() {
        let token = "journal-format-claim";
        let _answer = insert(token);
        let forget = Forget(token.into());
        assert!(claim(token).is_ok());
        assert!(claim(token).is_err());
        drop(forget);
        assert!(claim(token).is_err());
    }

    #[test]
    fn an_unclaimed_request_cannot_be_finished_or_removed() {
        let token = "journal-format-unclaimed";
        let _answer = insert(token);
        let forget = Forget(token.into());
        assert!(finish(token, Some(json!({"schema_version":1})), None).is_err());
        assert!(lock().contains_key(token));
        drop(forget);
    }

    #[test]
    fn only_a_claimed_request_with_one_outcome_can_finish() {
        let token = "journal-format-finish";
        let mut answer = insert(token);
        let forget = Forget(token.into());
        assert!(claim(token).is_ok());
        assert!(finish(
            token,
            Some(json!({"schema_version":1})),
            Some("both".into())
        )
        .is_ok());
        assert_eq!(answer.try_recv().unwrap(), Err("both".to_string()));
        assert!(finish(token, None, None).is_err());
        drop(forget);
    }

    #[test]
    fn snapshot_identity_binds_the_exact_source_hash_and_version() {
        let hash = "a".repeat(64);
        let snapshot = json!({"schema_version":1,"source_sha256":hash});
        assert!(snapshot_identity(&snapshot, &hash).is_ok());
        assert!(
            snapshot_identity(&json!({"schema_version":2,"source_sha256":hash}), &hash).is_err()
        );
        assert!(snapshot_identity(&snapshot, &"b".repeat(64)).is_err());
    }
}
