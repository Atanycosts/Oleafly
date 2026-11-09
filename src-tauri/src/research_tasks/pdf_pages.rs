//! Page capture from immutable task artifacts through the existing pdf.js window.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use oleafly_research::compiled_artifacts::TaskCompiledArtifact;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

struct Pending {
    bytes: Vec<u8>,
    count: usize,
    reply: oneshot::Sender<Result<Vec<String>, String>>,
}
fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static REQUESTS: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    REQUESTS.get_or_init(Default::default)
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    reference: TaskCompiledArtifact,
    #[serde(default = "default_pages")]
    pages: Vec<u32>,
    #[serde(default = "default_scale")]
    scale: f64,
}
fn default_pages() -> Vec<u32> {
    vec![1]
}
fn default_scale() -> f64 {
    1.5
}
fn request(arguments: Value) -> Result<Request, String> {
    let request: Request = serde_json::from_value(arguments).map_err(|e| e.to_string())?;
    if request.pages.is_empty()
        || request.pages.len() > 4
        || request.pages.iter().any(|p| *p == 0 || *p > 2000)
        || !(0.5..=2.0).contains(&request.scale)
    {
        return Err("Capture one to four PDF pages (1–2000) at scale 0.5–2.".into());
    }
    Ok(request)
}

pub(crate) fn tool(
    app: tauri::AppHandle,
    root: Result<std::path::PathBuf, String>,
    task: String,
    generation: u64,
) -> oleafly_research::builtin::TaskMcpTool {
    let reference = json!({"type":"object","additionalProperties":false,"properties":{
        "taskId":{"type":"string"},"generation":{"type":"integer","minimum":0},
        "inputFingerprint":{"type":"string"},"sourceRevision":{"type":"string"},"outputId":{"type":["string","null"]},
        "pdfSha256":{"type":"string"},"size":{"type":"integer","minimum":0},"mainDocument":{"type":"string"},"path":{"type":"string"}
    },"required":["taskId","generation","inputFingerprint","sourceRevision","outputId","pdfSha256","size","mainDocument","path"]});
    oleafly_research::builtin::TaskMcpTool {
        schema: oleafly_agent::ToolSchema { name:"task_pdf_pages".into(), description:"Capture page images from a retained task PDF: captured generation 0 input or this execution's compiled output. Images are evidence for your inspection; capture alone does not establish visual quality.".into(), input_schema:json!({"type":"object","additionalProperties":false,"properties":{"reference":reference,"pages":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"integer","minimum":1,"maximum":2000}},"scale":{"type":"number","minimum":0.5,"maximum":2}},"required":["reference"]}) },
        read_only_hint:true,
        call:std::sync::Arc::new(move |arguments| {
            let (app, root, task) = (app.clone(), root.clone(), task.clone());
            Box::pin(async move {
                let request = request(arguments)?;
                let reference = request.reference.clone();
                let root = root?;
                let bytes = tokio::task::spawn_blocking(move || oleafly_research::compiled_artifacts::read_for_task(&root, &task, generation, &reference)).await.map_err(|e|e.to_string())??;
                let images = capture(app, bytes, &request.pages, request.scale).await?;
                let mut content = vec![json!({"type":"text","text":json!({"artifact":request.reference,"pages":request.pages}).to_string()})];
                content.extend(images.into_iter().map(|image| json!({"type":"image","mimeType":"image/png","data":image})));
                Ok(json!({"content":content,"isError":false}))
            })
        }),
    }
}
async fn capture(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    pages: &[u32],
    scale: f64,
) -> Result<Vec<String>, String> {
    if app.get_webview_window("main").is_none() {
        return Err("Open an Oleafly window to capture task PDF pages.".into());
    }
    let mut token_bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut token_bytes);
    let token: String = token_bytes.iter().map(|b| format!("{b:02x}")).collect();
    let (reply, answer) = oneshot::channel();
    lock().insert(
        token.clone(),
        Pending {
            bytes,
            count: pages.len(),
            reply,
        },
    );
    let _forget = Forget(token.clone());
    app.emit_to(
        "main",
        "research-pdf-pages-request",
        json!({"token":token,"pages":pages,"scale":scale}),
    )
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(120), answer)
        .await
        .map_err(|_| "Task PDF capture timed out.".to_string())?
        .map_err(|_| "Task PDF capture ended.".to_string())?
}
#[tauri::command]
pub fn research_pdf_pages_fetch(token: String) -> Result<tauri::ipc::Response, String> {
    let bytes = lock()
        .get(&token)
        .ok_or("This PDF capture ended.")?
        .bytes
        .clone();
    Ok(tauri::ipc::Response::new(bytes))
}
#[tauri::command]
pub fn research_pdf_pages_result(
    token: String,
    images: Option<Vec<String>>,
    error: Option<String>,
) -> Result<(), String> {
    let pending = lock().remove(&token).ok_or("This PDF capture ended.")?;
    let result = match (images, error) {
        (_, Some(error)) => Err(error.chars().take(500).collect()),
        (Some(images), None)
            if images.len() == pending.count
                && images.iter().map(String::len).sum::<usize>() <= 16 * 1024 * 1024
                && images.iter().all(|image| {
                    image.starts_with("iVBORw0KGgo")
                        && image
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
                }) =>
        {
            Ok(images)
        }
        _ => Err("The window returned invalid or oversized PDF page images.".into()),
    };
    let _ = pending.reply.send(result);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_bounds_reject_invalid_page_sets_and_scale() {
        let reference = json!({"taskId":"task-a","generation":1,"inputFingerprint":"a","sourceRevision":"base","outputId":null,"pdfSha256":"b","size":1,"mainDocument":"main.tex","path":"a.pdf"});
        for (pages, scale) in [
            (vec![], 1.0),
            (vec![0], 1.0),
            (vec![1; 5], 1.0),
            (vec![1], 3.0),
        ] {
            assert!(request(json!({"reference":reference,"pages":pages,"scale":scale})).is_err());
        }
        assert!(request(json!({"reference":reference})).is_ok());
    }
    #[test]
    fn current_execution_rejects_an_older_generation_reference() {
        use oleafly_research::{
            compiled_artifacts::{retain, TaskCompileRequest},
            host::{CompileOutput, CompileSummary},
        };
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let output = workspace.path().join("output.pdf");
        std::fs::write(&output, b"%PDF-old").unwrap();
        let request = TaskCompileRequest {
            task_id: "task-a".into(),
            generation: 1,
            tasks_root: root.path().into(),
            execution_root: workspace.path().into(),
            source: None,
            source_revision: "base".into(),
        };
        let summary = CompileSummary {
            ok: true,
            build: Some(CompileOutput {
                main_document: "main.tex".into(),
                build_directory: workspace.path().into(),
                output: Some(output),
                output_id: None,
                fresh: true,
            }),
            ..Default::default()
        };
        let reference = retain(&request, "a".repeat(64), &summary).unwrap().unwrap();
        assert!(oleafly_research::compiled_artifacts::read_for_task(
            root.path(),
            "task-a",
            1,
            &reference
        )
        .is_ok());
        let captured_generation = 2;
        assert!(oleafly_research::compiled_artifacts::read_for_task(
            root.path(),
            "task-a",
            captured_generation,
            &reference
        )
        .unwrap_err()
        .contains("Unknown compiled artifact reference"));
        let input = oleafly_research::compiled_artifacts::retain_input(
            root.path(),
            "task-a",
            "main.tex",
            "b".repeat(64),
            b"%PDF-user-input",
        )
        .unwrap();
        assert_eq!(
            oleafly_research::compiled_artifacts::read_for_task(
                root.path(),
                "task-a",
                captured_generation,
                &input
            )
            .unwrap(),
            b"%PDF-user-input"
        );
    }
    #[tokio::test]
    async fn capture_delivers_page_images_once_and_drop_clears_pending_bytes() {
        let (reply, answer) = oneshot::channel();
        lock().insert(
            "test-valid".into(),
            Pending {
                bytes: b"%PDF".to_vec(),
                count: 1,
                reply,
            },
        );
        research_pdf_pages_result("test-valid".into(), Some(vec!["iVBORw0KGgo=".into()]), None)
            .unwrap();
        assert_eq!(answer.await.unwrap().unwrap(), vec!["iVBORw0KGgo="]);
        assert!(research_pdf_pages_result("test-valid".into(), Some(vec![]), None).is_err());
        let (reply, _answer) = oneshot::channel();
        lock().insert(
            "test-dropped".into(),
            Pending {
                bytes: vec![1],
                count: 1,
                reply,
            },
        );
        drop(Forget("test-dropped".into()));
        assert!(research_pdf_pages_fetch("test-dropped".into()).is_err());
    }

    #[tokio::test]
    async fn captures_answer_once_and_reject_invalid_image_payloads() {
        let (reply, answer) = oneshot::channel();
        lock().insert(
            "test-invalid".into(),
            Pending {
                bytes: vec![],
                count: 1,
                reply,
            },
        );
        research_pdf_pages_result("test-invalid".into(), Some(vec!["not-png".into()]), None)
            .unwrap();
        assert!(answer.await.unwrap().is_err());
        assert!(research_pdf_pages_fetch("test-invalid".into()).is_err());
    }
}
