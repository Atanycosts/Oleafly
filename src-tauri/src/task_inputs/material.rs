//! Exact material inputs are retained beside existing task inputs, not copied into annotation text.
use crate::material_annotations::{read_bytes, MaterialSnapshot};
use oleafly_research::{model::TaskRunContext, task_tools::TaskFiles};
use std::path::{Path, PathBuf};
fn path(root: &Path, task_id: &str) -> PathBuf {
    root.join("task-inputs")
        .join(format!("material-{task_id}.json"))
}
pub(crate) fn extension(snapshot: &MaterialSnapshot) -> &str {
    if snapshot.media_type == "application/vnd.oleafly.html-bundle+json" {
        return "html-bundle.json";
    }
    let original = snapshot
        .document
        .path
        .as_deref()
        .unwrap_or(&snapshot.document.title);
    let suffix = Path::new(original)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 16
                && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
        });
    match snapshot.document.kind.as_str() {
        "docx" => "docx",
        "pdf" => "pdf",
        "markdown" => "md",
        "html" => "html",
        "diagram" => suffix.unwrap_or("txt"),
        "image" => match snapshot.media_type.as_str() {
            "image/svg+xml" => "svg",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => "png",
        },
        _ => suffix.unwrap_or("txt"),
    }
}
pub(crate) fn source_instructions(snapshot: &MaterialSnapshot) -> &'static str {
    if snapshot.media_type == "application/vnd.oleafly.html-bundle+json" {
        "The source is an Oleafly HTML bundle JSON, not raw HTML. Its entry field names the HTML entry; files maps each retained relative path to base64 bytes. Parse the JSON and base64-decode files[entry] to read the HTML. Preserve all retained files and relative resource paths when deriving a result."
    } else {
        "The source file contains the exact captured material bytes."
    }
}
pub(crate) fn retain(
    root: &Path,
    task_id: &str,
    snapshot: &MaterialSnapshot,
) -> Result<(), String> {
    read_bytes(root, snapshot)?;
    let destination = path(root, task_id);
    std::fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
    crate::sandbox::atomic_write(
        &destination,
        &serde_json::to_vec(snapshot).map_err(|e| e.to_string())?,
    )
}
pub(crate) fn retain_manifest(
    root: &Path,
    task_id: &str,
    manifest: oleafly_core::ProjectManifest,
) -> Result<(), String> {
    super::save(
        &super::input_path(root, task_id),
        &super::Inputs {
            compile_manifest: Some(manifest),
            ..Default::default()
        },
    )
}
pub(crate) fn remove(root: &Path, task_id: &str) -> Result<(), String> {
    match std::fs::remove_file(path(root, task_id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
fn load(root: &Path, task_id: &str) -> Result<Option<MaterialSnapshot>, String> {
    let bytes = match std::fs::read(path(root, task_id)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| e.to_string())
}
pub(crate) fn require_version(
    root: &Path,
    task_id: &str,
    snapshot: &MaterialSnapshot,
) -> Result<(), String> {
    let retained = load(root, task_id)?.ok_or("This task has no retained material input.")?;
    if retained.document.project_id != snapshot.document.project_id
        || retained.document.document_id != snapshot.document.document_id
        || retained.sha256 != snapshot.sha256
    {
        return Err("This task belongs to another material version.".into());
    }
    read_bytes(root, &retained).map(|_| ())
}
pub(crate) fn prepare(root: &Path, context: &TaskRunContext) -> Result<(), String> {
    let Some(snapshot) = load(root, &context.task_id)? else {
        return Ok(());
    };
    if snapshot.document.project_id != context.project_id {
        return Err("The task material belongs to another project.".into());
    }
    let bytes = read_bytes(root, &snapshot)?;
    let files = TaskFiles::open(Path::new(&context.execution_root), &context.allowed_paths)?;
    files.write_bytes(
        &format!(
            "{}/material-source.{}",
            context.record_dir,
            extension(&snapshot)
        ),
        &bytes,
        100 * 1024 * 1024,
    )?;
    files.write(
        &format!("{}/material-context.json", context.record_dir),
        &serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?,
    )?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::material_annotations::MaterialReference;
    use oleafly_research::observations::content_hash;
    #[test]
    fn filenames_distinguish_html_bundles_and_diagram_source_languages() {
        let mut snapshot = MaterialSnapshot {
            document: MaterialReference {
                project_id: "paper".into(),
                document_id: "report".into(),
                path: Some("report.html".into()),
                title: "Report".into(),
                kind: "html".into(),
                revision: content_hash(b"bundle"),
            },
            anchor: serde_json::json!({"kind":"whole"}),
            sha256: content_hash(b"bundle"),
            media_type: "application/vnd.oleafly.html-bundle+json".into(),
            size: 6,
        };
        assert_eq!(extension(&snapshot), "html-bundle.json");
        assert!(source_instructions(&snapshot).contains("not raw HTML"));
        snapshot.document.kind = "diagram".into();
        snapshot.document.path = Some("figures/flow.mmd".into());
        snapshot.media_type = "text/plain".into();
        assert_eq!(extension(&snapshot), "mmd");
        snapshot.document.path = Some("figures/architecture.typ".into());
        assert_eq!(extension(&snapshot), "typ");
    }
    #[test]
    fn preparation_exposes_exact_bytes_in_the_scoped_task_record() {
        let root = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let bytes = b"retained\r\nsource";
        let sha = content_hash(bytes);
        std::fs::create_dir(root.path().join("material-inputs")).unwrap();
        std::fs::write(root.path().join("material-inputs").join(&sha), bytes).unwrap();
        let snapshot = MaterialSnapshot {
            document: MaterialReference {
                project_id: "paper".into(),
                document_id: "source".into(),
                path: None,
                title: "Source".into(),
                kind: "markdown".into(),
                revision: sha.clone(),
            },
            anchor: serde_json::json!({"kind":"whole"}),
            sha256: sha,
            media_type: "text/markdown".into(),
            size: bytes.len(),
        };
        retain(root.path(), "task", &snapshot).unwrap();
        let context = TaskRunContext {
            task_id: "task".into(),
            project_id: "paper".into(),
            execution_root: work.path().to_string_lossy().into(),
            record_dir: "records/task".into(),
            allowed_paths: vec!["records".into()],
            ..Default::default()
        };
        prepare(root.path(), &context).unwrap();
        assert_eq!(
            std::fs::read(work.path().join("records/task/material-source.md")).unwrap(),
            bytes
        );
        let parsed: MaterialSnapshot = serde_json::from_slice(
            &std::fs::read(work.path().join("records/task/material-context.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(parsed, snapshot);
        assert!(prepare(
            root.path(),
            &TaskRunContext {
                project_id: "other".into(),
                ..context
            }
        )
        .is_err());
    }
}
