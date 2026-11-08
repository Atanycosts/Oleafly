//! Immutable compiled PDFs, separate from task result/application authority.
use std::path::{Path, PathBuf};

use oleafly_agent::CancellationToken;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::host::{CompileOutput, CompileSummary};

#[derive(Debug, Clone)]
pub struct TaskCompileRequest {
    pub task_id: String,
    pub generation: u64,
    pub tasks_root: PathBuf,
    pub execution_root: PathBuf,
    pub source: Option<PathBuf>,
    pub source_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompiledArtifact {
    pub task_id: String,
    pub generation: u64,
    pub input_fingerprint: String,
    pub source_revision: String,
    pub output_id: Option<String>,
    pub pdf_sha256: String,
    pub size: u64,
    pub main_document: String,
    /// Relative to the task library, never a mutable compiler output path.
    pub path: String,
}

pub fn reference_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "description": "The complete artifact object returned by compile. Copy the values without constructing a filesystem path.",
        "properties": {
            "taskId": {"type":"string"}, "generation": {"type":"integer"},
            "inputFingerprint": {"type":"string"}, "sourceRevision": {"type":"string"},
            "outputId": {"type":["string","null"]}, "pdfSha256": {"type":"string"},
            "size": {"type":"integer"}, "mainDocument": {"type":"string"}, "path": {"type":"string"}
        },
        "required": ["taskId", "generation", "inputFingerprint", "sourceRevision", "pdfSha256", "size", "mainDocument", "path"],
        "additionalProperties": false
    })
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn directory(root: &Path, task: &str, generation: u64) -> Result<PathBuf, String> {
    if task.is_empty()
        || !task
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid task artifact identity.".into());
    }
    Ok(root
        .join("compiled-artifacts")
        .join(task)
        .join(generation.to_string()))
}

pub fn input_fingerprint(request: &TaskCompileRequest) -> Result<String, String> {
    input_fingerprint_with_config(request, &serde_json::Value::Null)
}

/// Broad workspace identity, including retained effective compiler settings.
/// Task records are included because research folders can also hold real inputs.
pub fn input_fingerprint_with_config(
    request: &TaskCompileRequest,
    effective_config: &serde_json::Value,
) -> Result<String, String> {
    let (manifest, skipped) = crate::isolation::collect_manifest_limited(
        &request.execution_root,
        &CancellationToken::new(),
        crate::isolation::CopyLimits::default(),
    )?;
    let mut effective_config = effective_config.clone();
    effective_config.sort_all_objects();
    let bytes =
        serde_json::to_vec(&(manifest, skipped, effective_config)).map_err(|e| e.to_string())?;
    Ok(digest(&bytes))
}

pub fn retain(
    request: &TaskCompileRequest,
    fingerprint: String,
    summary: &CompileSummary,
) -> Result<Option<TaskCompiledArtifact>, String> {
    let Some(CompileOutput {
        output: Some(output),
        fresh: true,
        ..
    }) = &summary.build
    else {
        return Ok(None);
    };
    if !summary.ok {
        return Ok(None);
    }
    let build = summary.build.as_ref().unwrap();
    let bytes = std::fs::read(output).map_err(|e| format!("Could not read compiled PDF: {e}"))?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("The compiled output is not a PDF.".into());
    }
    let hash = digest(&bytes);
    let dir = directory(&request.tasks_root, &request.task_id, request.generation)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let identity = digest(
        &serde_json::to_vec(&(&request.source_revision, &build.output_id))
            .map_err(|e| e.to_string())?,
    );
    let name = format!("{fingerprint}-{hash}-{identity}");
    let path = dir.join(format!("{name}.pdf"));
    let artifact = TaskCompiledArtifact {
        task_id: request.task_id.clone(),
        generation: request.generation,
        input_fingerprint: fingerprint,
        source_revision: request.source_revision.clone(),
        output_id: build.output_id.clone(),
        pdf_sha256: hash,
        size: bytes.len() as u64,
        main_document: build.main_document.clone(),
        path: path
            .strip_prefix(&request.tasks_root)
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    };
    oleafly_core::atomic::write_atomic(&path, &bytes).map_err(|e| e.to_string())?;
    oleafly_core::atomic::write_atomic(
        &dir.join(format!("{name}.json")),
        &serde_json::to_vec(&artifact).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(artifact))
}

pub fn list(root: &Path, task: &str, generation: u64) -> Result<Vec<TaskCompiledArtifact>, String> {
    let dir = directory(root, task, generation)?;
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut artifacts = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().is_some_and(|ext| ext == "json") {
            let artifact: TaskCompiledArtifact =
                serde_json::from_slice(&std::fs::read(entry.path()).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if artifact.task_id != task || artifact.generation != generation {
                return Err("Compiled artifact identity mismatch.".into());
            }
            artifacts.push(artifact);
        }
    }
    artifacts.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(artifacts)
}

pub fn read(
    root: &Path,
    task: &str,
    generation: u64,
    reference: &TaskCompiledArtifact,
) -> Result<Vec<u8>, String> {
    if !list(root, task, generation)?.contains(reference) {
        return Err("Unknown compiled artifact reference.".into());
    }
    let dir = directory(root, task, generation)?;
    let identity = digest(
        &serde_json::to_vec(&(&reference.source_revision, &reference.output_id))
            .map_err(|e| e.to_string())?,
    );
    let name = format!(
        "{}-{}-{identity}.pdf",
        reference.input_fingerprint, reference.pdf_sha256
    );
    if ![&reference.input_fingerprint, &reference.pdf_sha256]
        .iter()
        .all(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("Invalid compiled artifact hash.".into());
    }
    let path = dir.join(name);
    if path
        .strip_prefix(root)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        != reference.path
    {
        return Err("Compiled artifact path mismatch.".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() as u64 != reference.size || digest(&bytes) != reference.pdf_sha256 {
        return Err("The retained compiled PDF changed.".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_pdf_survives_later_compiles_and_requires_its_exact_identity() {
        let root = tempfile::tempdir().unwrap();
        let execution = tempfile::tempdir().unwrap();
        let output = execution.path().join("output.pdf");
        std::fs::write(&output, b"%PDF-first").unwrap();
        let request = TaskCompileRequest {
            task_id: "task-a".into(),
            generation: 2,
            tasks_root: root.path().into(),
            execution_root: execution.path().into(),
            source: None,
            source_revision: "snapshot:a".into(),
        };
        let summary = CompileSummary {
            ok: true,
            build: Some(CompileOutput {
                main_document: "main.tex".into(),
                build_directory: execution.path().into(),
                output: Some(output.clone()),
                output_id: Some("output-a".into()),
                fresh: true,
            }),
            ..Default::default()
        };
        let artifact = retain(&request, "a".repeat(64), &summary).unwrap().unwrap();
        std::fs::write(&output, b"%PDF-next").unwrap();
        assert_eq!(
            read(root.path(), "task-a", 2, &artifact).unwrap(),
            b"%PDF-first"
        );
        assert!(read(root.path(), "task-a", 3, &artifact).is_err());
        assert!(read(root.path(), "task-b", 2, &artifact).is_err());
        let mut forged = artifact.clone();
        forged.input_fingerprint = "b".repeat(64);
        assert!(read(root.path(), "task-a", 2, &forged).is_err());
        std::fs::write(root.path().join(&artifact.path), b"%PDF-tampered").unwrap();
        assert!(read(root.path(), "task-a", 2, &artifact)
            .unwrap_err()
            .contains("changed"));
        let failed = CompileSummary {
            ok: false,
            ..summary.clone()
        };
        assert_eq!(retain(&request, "a".repeat(64), &failed).unwrap(), None);
        let mut stale = summary;
        stale.build.as_mut().unwrap().fresh = false;
        assert_eq!(retain(&request, "a".repeat(64), &stale).unwrap(), None);
    }

    #[test]
    fn compile_fingerprint_tracks_task_inputs_and_excludes_build_cache() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("main.tex"), "before").unwrap();
        let request = TaskCompileRequest {
            task_id: "task-a".into(),
            generation: 1,
            tasks_root: root.path().into(),
            execution_root: root.path().into(),
            source: None,
            source_revision: "base".into(),
        };
        let before = input_fingerprint(&request).unwrap();
        std::fs::create_dir(root.path().join(".oleafly")).unwrap();
        std::fs::write(root.path().join(".oleafly/output.pdf"), "%PDF-cache").unwrap();
        assert_eq!(before, input_fingerprint(&request).unwrap());
        std::fs::write(root.path().join("main.tex"), "after").unwrap();
        assert_ne!(before, input_fingerprint(&request).unwrap());
    }
    #[test]
    fn effective_compile_settings_change_identity_with_the_same_workspace() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("main.tex"), "source").unwrap();
        let request = TaskCompileRequest {
            task_id: "task-a".into(),
            generation: 1,
            tasks_root: root.path().into(),
            execution_root: root.path().into(),
            source: None,
            source_revision: "base".into(),
        };
        let config = serde_json::json!({"manifest":{"main_doc":"main.tex","engine":"latexmk","tex_flavor":"xelatex"},"mainDocument":null});
        let baseline = input_fingerprint_with_config(&request, &config).unwrap();
        for (field, value) in [
            ("main_doc", "other.tex"),
            ("engine", "tectonic"),
            ("tex_flavor", "pdflatex"),
        ] {
            let mut changed = config.clone();
            changed["manifest"][field] = serde_json::json!(value);
            assert_ne!(
                baseline,
                input_fingerprint_with_config(&request, &changed).unwrap(),
                "{field}"
            );
        }
        assert_eq!(
            baseline,
            input_fingerprint_with_config(&request, &config).unwrap()
        );
    }
}
