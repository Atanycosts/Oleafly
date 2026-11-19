use std::path::{Path, PathBuf};

use oleafly_research::literature::paper::{
    read_paper, retained_paper_window, PaperRequest, PaperText, PdfTextExtractor,
    DEFAULT_WINDOW_CHARS,
};
use oleafly_research::observations::content_hash;
use oleafly_research::task_tools::TaskFiles;
use serde::{Deserialize, Serialize};

const RECORD_DIR: &str = "sources";
const MAX_PDF_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaperPdfReference {
    pub project_id: String,
    pub path: String,
    pub pdf_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPaperText {
    #[serde(flatten)]
    pub paper: PaperText,
    pub pdf_reference: PaperPdfReference,
}

fn cache_root(data_root: &Path, project_id: &str) -> Result<PathBuf, String> {
    crate::paths::validate_project_id(project_id)?;
    Ok(data_root.join("paper-readings").join(project_id))
}

#[allow(clippy::too_many_arguments)]
async fn read_project_paper_in(
    data_root: &Path,
    project_id: &str,
    project_root: &Path,
    request: PaperRequest,
    linked_base: Option<PathBuf>,
    extractor: Option<&dyn PdfTextExtractor>,
    offset: usize,
    max_chars: usize,
    reference: Option<&PaperPdfReference>,
) -> Result<ProjectPaperText, String> {
    let root = cache_root(data_root, project_id)?;
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let retained = TaskFiles::open(&root, &[RECORD_DIR.into()])?;
    if let Some(reference) = reference {
        if reference.project_id != project_id {
            return Err("The retained paper belongs to another project.".into());
        }
        let paper = retained_paper_window(
            &retained,
            &reference.path,
            &reference.pdf_sha256,
            offset,
            max_chars,
        )?;
        return Ok(ProjectPaperText {
            paper,
            pdf_reference: reference.clone(),
        });
    }
    if offset > 0 {
        return Err("Continue with the pdfReference returned by the first read, or read again from offset 0.".into());
    }
    let input = match &request {
        PaperRequest::Path {
            path,
            root_id: None,
        } => Some(TaskFiles::open(project_root, std::slice::from_ref(path))?),
        _ => None,
    };
    let local_bytes = match &request {
        PaperRequest::Path { path, root_id } => {
            let bytes = match root_id {
                Some(_) => {
                    let base = linked_base
                        .as_ref()
                        .ok_or("That data folder isn't linked to this project.")?;
                    TaskFiles::open(base, std::slice::from_ref(path))?
                        .read_bytes(path, MAX_PDF_BYTES)?
                }
                None => input.as_ref().unwrap().read_bytes(path, MAX_PDF_BYTES)?,
            };
            Some(bytes)
        }
        _ => None,
    };
    let local_hash = local_bytes.as_ref().map(|bytes| content_hash(bytes));
    let record_dir = local_hash
        .as_ref()
        .map_or_else(|| RECORD_DIR.into(), |hash| format!("{RECORD_DIR}/{hash}"));
    let captured = local_bytes
        .map(|bytes| {
            let folder = tempfile::tempdir_in(&root).map_err(|error| error.to_string())?;
            std::fs::write(folder.path().join("input.pdf"), bytes)
                .map_err(|error| error.to_string())?;
            let files = TaskFiles::open(folder.path(), &["input.pdf".into()])?;
            Ok::<_, String>((folder, files))
        })
        .transpose()?;
    let request = if captured.is_some() {
        PaperRequest::Path {
            path: "input.pdf".into(),
            root_id: None,
        }
    } else {
        request
    };
    let paper = read_paper(
        &crate::literature::app_literature(),
        request,
        captured.as_ref().map_or(&retained, |(_, files)| files),
        &retained,
        &record_dir,
        linked_base,
        extractor,
        offset,
        max_chars,
    )
    .await?;
    let pdf = paper
        .source
        .pdf
        .as_ref()
        .ok_or("The paper has no retained PDF.")?;
    let pdf_reference = PaperPdfReference {
        project_id: project_id.into(),
        path: pdf.path.clone(),
        pdf_sha256: pdf.sha256.clone(),
    };
    Ok(ProjectPaperText {
        paper,
        pdf_reference,
    })
}

#[tauri::command]
pub async fn read_project_paper(
    app: tauri::AppHandle,
    project_id: String,
    request: PaperRequest,
    offset: Option<usize>,
    max_chars: Option<usize>,
    reference: Option<PaperPdfReference>,
) -> Result<ProjectPaperText, String> {
    // A retained reference is self-contained. Do not require the author
    // project to still be present when continuing a cached read.
    let project_root = if reference.is_some() {
        PathBuf::new()
    } else {
        crate::paths::project_dir(&project_id)?
    };
    let linked_base = match (&request, &reference) {
        (
            PaperRequest::Path {
                root_id: Some(root_id),
                ..
            },
            None,
        ) => Some(crate::research_mcp::linked_root(&project_id, root_id)?),
        _ => None,
    };
    let extractor = crate::research_tasks::pdf_text::AppPdfText { app };
    read_project_paper_in(
        &crate::paths::oleafly_root()?,
        &project_id,
        &project_root,
        request,
        linked_base,
        Some(&extractor),
        offset.unwrap_or(0),
        max_chars.unwrap_or(DEFAULT_WINDOW_CHARS),
        reference.as_ref(),
    )
    .await
}

fn retained_pdf_in(data_root: &Path, reference: &PaperPdfReference) -> Result<Vec<u8>, String> {
    let root = cache_root(data_root, &reference.project_id)?;
    let files = TaskFiles::open(&root, &[RECORD_DIR.into()])?;
    let bytes = files.read_bytes(&reference.path, MAX_PDF_BYTES)?;
    if content_hash(&bytes) != reference.pdf_sha256 {
        return Err("The retained paper PDF no longer matches its reference.".into());
    }
    if !bytes.starts_with(b"%PDF") {
        return Err("The retained paper is not a PDF.".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn read_retained_paper_pdf(
    reference: PaperPdfReference,
) -> Result<tauri::ipc::Response, String> {
    let data_root = crate::paths::oleafly_root()?;
    tauri::async_runtime::spawn_blocking(move || retained_pdf_in(&data_root, &reference))
        .await
        .map_err(|error| error.to_string())?
        .map(tauri::ipc::Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Pages;

    #[async_trait::async_trait]
    impl PdfTextExtractor for Pages {
        async fn pages(&self, _pdf: PathBuf) -> Result<Vec<String>, String> {
            Ok(vec![
                "中文\"\\🍃\n".repeat(6_000),
                "Final source page".into(),
            ])
        }
    }

    #[tokio::test]
    async fn project_paper_windows_and_preview_use_only_retained_application_bytes() {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let original = b"%PDF-input";
        std::fs::write(project.path().join("paper.pdf"), original).unwrap();
        let request = PaperRequest::Path {
            path: "paper.pdf".into(),
            root_id: None,
        };
        let mut offset = 0;
        let mut text = String::new();
        let mut reference = None;
        loop {
            let result = read_project_paper_in(
                data.path(),
                "paper",
                project.path(),
                request.clone(),
                None,
                Some(&Pages),
                offset,
                48_000,
                reference.as_ref(),
            )
            .await
            .unwrap();
            let wire = serde_json::to_value(&result).unwrap();
            assert_eq!(wire["pdfReference"]["projectId"], "paper");
            assert_eq!(wire["pdfReference"]["path"], wire["source"]["pdf"]["path"]);
            assert_eq!(
                wire["pdfReference"]["pdfSha256"],
                wire["source"]["pdf"]["sha256"]
            );
            assert!(wire.get("paper").is_none());
            let paper = result.paper;
            assert_eq!(paper.source.offset, offset);
            assert_eq!(paper.source.end_offset, offset + paper.text.len());
            assert_eq!(paper.source.snapshot_retained, None);
            assert_eq!(result.pdf_reference.pdf_sha256, content_hash(original));
            assert_eq!(
                retained_pdf_in(data.path(), &result.pdf_reference).unwrap(),
                original
            );
            let files = TaskFiles::open(
                &cache_root(data.path(), "paper").unwrap(),
                &[RECORD_DIR.into()],
            )
            .unwrap();
            let retained_text = files.read(&paper.source.path).unwrap();
            assert_eq!(
                content_hash(retained_text.as_bytes()),
                paper.source.file_sha256
            );
            assert_eq!(
                &retained_text[paper.source.offset..paper.source.end_offset],
                paper.text
            );
            assert!(paper.source.pdf.as_ref().unwrap().page_start.is_some());
            text.push_str(&paper.text);
            reference = reference.or(Some(result.pdf_reference));
            match paper.next_offset {
                Some(next) => offset = next,
                None => break,
            }
        }
        assert!(text.ends_with("[p. 2]\nFinal source page\n\n"));
        assert_eq!(
            std::fs::read(project.path().join("paper.pdf")).unwrap(),
            original
        );
        assert_eq!(std::fs::read_dir(project.path()).unwrap().count(), 1);
        std::fs::remove_file(project.path().join("paper.pdf")).unwrap();
        assert_eq!(
            retained_pdf_in(data.path(), &reference.unwrap()).unwrap(),
            original
        );
    }

    #[tokio::test]
    async fn linked_pdf_is_read_without_writing_to_the_linked_folder_or_project() {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let linked = tempfile::tempdir().unwrap();
        std::fs::write(linked.path().join("source.pdf"), b"%PDF-linked").unwrap();
        let result = read_project_paper_in(
            data.path(),
            "paper",
            project.path(),
            PaperRequest::Path {
                path: "source.pdf".into(),
                root_id: Some("data".into()),
            },
            Some(linked.path().into()),
            Some(&Pages),
            0,
            1_000,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            retained_pdf_in(data.path(), &result.pdf_reference).unwrap(),
            b"%PDF-linked"
        );
        assert_eq!(std::fs::read_dir(project.path()).unwrap().count(), 0);
        assert_eq!(std::fs::read_dir(linked.path()).unwrap().count(), 1);
        assert_eq!(
            std::fs::read(linked.path().join("source.pdf")).unwrap(),
            b"%PDF-linked"
        );
    }

    #[tokio::test]
    async fn local_input_cannot_escape_the_author_project() {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        for path in ["../paper.pdf", "/paper.pdf", "sources/../paper.pdf"] {
            let result = read_project_paper_in(
                data.path(),
                "paper",
                project.path(),
                PaperRequest::Path {
                    path: path.into(),
                    root_id: None,
                },
                None,
                Some(&Pages),
                0,
                1_000,
                None,
            )
            .await;
            assert!(result.is_err(), "{path}");
        }
        assert_eq!(std::fs::read_dir(project.path()).unwrap().count(), 0);
    }

    struct InputPages;

    #[async_trait::async_trait]
    impl PdfTextExtractor for InputPages {
        async fn pages(&self, pdf: PathBuf) -> Result<Vec<String>, String> {
            Ok(vec![std::fs::read_to_string(pdf).unwrap()])
        }
    }

    #[tokio::test]
    async fn replacing_local_or_linked_source_creates_a_new_version_and_old_reads_continue() {
        for linked in [false, true] {
            let data = tempfile::tempdir().unwrap();
            let project = tempfile::tempdir().unwrap();
            let source = tempfile::tempdir().unwrap();
            let source_root = if linked {
                source.path()
            } else {
                project.path()
            };
            let request = PaperRequest::Path {
                path: "paper.pdf".into(),
                root_id: linked.then(|| "linked".into()),
            };
            let base = linked.then(|| source.path().to_path_buf());
            std::fs::write(source_root.join("paper.pdf"), b"%PDF-original version").unwrap();
            let first = read_project_paper_in(
                data.path(),
                "paper",
                project.path(),
                request.clone(),
                base.clone(),
                Some(&InputPages),
                0,
                10,
                None,
            )
            .await
            .unwrap();
            std::fs::write(source_root.join("paper.pdf"), b"%PDF-replacement version").unwrap();
            let second = read_project_paper_in(
                data.path(),
                "paper",
                project.path(),
                request.clone(),
                base.clone(),
                Some(&InputPages),
                0,
                100,
                None,
            )
            .await
            .unwrap();
            assert_ne!(first.pdf_reference.path, second.pdf_reference.path);
            assert_ne!(
                first.pdf_reference.pdf_sha256,
                second.pdf_reference.pdf_sha256
            );
            assert!(second.paper.text.contains("replacement version"));
            assert!(read_project_paper_in(
                data.path(),
                "paper",
                project.path(),
                request.clone(),
                base.clone(),
                Some(&InputPages),
                first.paper.next_offset.unwrap(),
                100,
                None
            )
            .await
            .is_err());
            std::fs::remove_file(source_root.join("paper.pdf")).unwrap();
            let rest = read_project_paper_in(
                data.path(),
                "paper",
                project.path(),
                request.clone(),
                None,
                Some(&InputPages),
                first.paper.next_offset.unwrap(),
                100,
                Some(&first.pdf_reference),
            )
            .await
            .unwrap();
            assert_eq!(
                format!("{}{}", first.paper.text, rest.paper.text),
                "[p. 1]\n%PDF-original version\n\n"
            );
            assert_eq!(
                retained_pdf_in(data.path(), &first.pdf_reference).unwrap(),
                b"%PDF-original version"
            );
            assert_eq!(
                retained_pdf_in(data.path(), &second.pdf_reference).unwrap(),
                b"%PDF-replacement version"
            );
            let mut wrong = first.pdf_reference.clone();
            wrong.project_id = "other".into();
            assert!(read_project_paper_in(
                data.path(),
                "paper",
                project.path(),
                request.clone(),
                None,
                Some(&InputPages),
                0,
                100,
                Some(&wrong)
            )
            .await
            .is_err());
            let files = TaskFiles::open(
                &cache_root(data.path(), "paper").unwrap(),
                &[RECORD_DIR.into()],
            )
            .unwrap();
            files
                .write(&first.paper.source.path, "altered text")
                .unwrap();
            assert!(read_project_paper_in(
                data.path(),
                "paper",
                project.path(),
                request,
                None,
                Some(&InputPages),
                0,
                100,
                Some(&first.pdf_reference)
            )
            .await
            .is_err());
        }
    }

    #[tokio::test]
    async fn retained_reference_continues_without_an_existing_project_root() {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("paper.pdf"), b"%PDF-retained input").unwrap();
        let request = PaperRequest::Path {
            path: "paper.pdf".into(),
            root_id: None,
        };
        let first = read_project_paper_in(
            data.path(),
            "paper",
            project.path(),
            request.clone(),
            None,
            Some(&InputPages),
            0,
            10,
            None,
        )
        .await
        .unwrap();
        let missing_root = project.path().join("removed-project");
        assert!(!missing_root.exists());

        let continued = read_project_paper_in(
            data.path(),
            "paper",
            &missing_root,
            request.clone(),
            None,
            Some(&InputPages),
            first.paper.next_offset.unwrap(),
            100,
            Some(&first.pdf_reference),
        )
        .await
        .unwrap();
        assert_eq!(
            continued.pdf_reference.project_id,
            first.pdf_reference.project_id
        );
        assert_eq!(continued.pdf_reference.path, first.pdf_reference.path);
        assert_eq!(
            continued.pdf_reference.pdf_sha256,
            first.pdf_reference.pdf_sha256
        );
        assert_eq!(
            format!("{}{}", first.paper.text, continued.paper.text),
            "[p. 1]\n%PDF-retained input\n\n"
        );

        let first_without_project = read_project_paper_in(
            data.path(),
            "paper",
            &missing_root,
            request,
            None,
            Some(&InputPages),
            0,
            100,
            None,
        )
        .await;
        assert!(first_without_project.is_err());
    }

    #[test]
    fn preview_rejects_wrong_identity_and_paths_outside_sources() {
        let data = tempfile::tempdir().unwrap();
        let root = cache_root(data.path(), "paper").unwrap();
        std::fs::create_dir_all(root.join("sources")).unwrap();
        std::fs::write(root.join("sources/paper.pdf"), b"%PDF-retained").unwrap();
        std::fs::write(root.join("other.pdf"), b"%PDF-retained").unwrap();
        let mut reference = PaperPdfReference {
            project_id: "paper".into(),
            path: "sources/paper.pdf".into(),
            pdf_sha256: content_hash(b"%PDF-retained"),
        };
        assert!(retained_pdf_in(data.path(), &reference).is_ok());
        reference.pdf_sha256 = "wrong".into();
        assert!(retained_pdf_in(data.path(), &reference)
            .unwrap_err()
            .contains("no longer matches"));
        reference.pdf_sha256 = content_hash(b"%PDF-retained");
        for path in [
            "other.pdf",
            "../paper/sources/paper.pdf",
            "/sources/paper.pdf",
            "sources/../other.pdf",
        ] {
            reference.path = path.into();
            assert!(retained_pdf_in(data.path(), &reference).is_err(), "{path}");
        }
        reference.project_id = "../paper".into();
        assert!(retained_pdf_in(data.path(), &reference).is_err());
    }
}
