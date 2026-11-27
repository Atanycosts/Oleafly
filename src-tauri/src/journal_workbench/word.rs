use super::{normalization, render, request, JournalWorkbenchState, Session};
use crate::research_workspace::{ResearchWorkspace, WordDocumentLink};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Component, Path};
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedWordDocument {
    project: Option<Value>,
    world: Option<Value>,
    source_changed: bool,
    choices: Vec<Value>,
}

#[derive(Debug, Default)]
struct WordOpenChoice {
    workbench_project_id: Option<String>,
    new_copy: bool,
}

struct SourceMatch {
    project: Value,
}

enum UnmappedResolution {
    ImportNow,
    Choose(Vec<Value>),
}

fn document_path(path: &str) -> Result<String, String> {
    let portable = path.replace('\\', "/");
    let mut segments = Vec::new();
    for component in Path::new(&portable).components() {
        match component {
            Component::Normal(name) => segments.push(name.to_string_lossy().into_owned()),
            Component::CurDir => {}
            _ => return Err("Choose a Word document inside the open project.".into()),
        }
    }
    let path = segments.join("/");
    if !Path::new(&path).extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("doc") || extension.eq_ignore_ascii_case("docx")
    }) {
        return Err("Choose a Word DOCX or DOC document.".into());
    }
    Ok(path)
}

fn source_filename(path: &str) -> Result<String, String> {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| "Choose a Word document inside the open project.".into())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

async fn source_bytes(project_id: &str, path: &str) -> Result<Vec<u8>, String> {
    let content =
        crate::project::read_file_base64(project_id.to_string(), path.to_string()).await?;
    STANDARD.decode(content).map_err(|error| error.to_string())
}

async fn source_original_sha256(project_id: &str, path: &str) -> Result<String, String> {
    Ok(sha256(&source_bytes(project_id, path).await?))
}

async fn normalized_source(
    session: &Session,
    project_id: &str,
    path: &str,
) -> Result<normalization::NormalizedTemplate, String> {
    let filename = source_filename(path)?;
    let bytes = source_bytes(project_id, path).await?;
    let renderer = render::find_renderer();
    let temporary_root = crate::paths::oleafly_root()?.join("tmp/word-imports");
    normalization::normalize_template_bytes(
        session,
        &filename,
        bytes,
        renderer.as_deref(),
        &temporary_root,
    )
    .await
}

async fn opened(session: &Session, project: Value) -> Result<(Value, Option<Value>), String> {
    let world = match project["binding"]["world_version_id"].as_str() {
        Some(id) => {
            let query = reqwest::Url::parse_with_params("http://127.0.0.1/", &[("version_id", id)])
                .map_err(|error| error.to_string())?;
            Some(
                request(
                    session,
                    &format!("/api/world?{}", query.query().unwrap()),
                    None,
                )
                .await?,
            )
        }
        None => None,
    };
    Ok((project, world))
}

async fn opened_response(
    session: &Session,
    project: Value,
    source_changed: bool,
    choices: Vec<Value>,
) -> Result<OpenedWordDocument, String> {
    let (project, world) = opened(session, project).await?;
    Ok(OpenedWordDocument {
        project: Some(project),
        world,
        source_changed,
        choices,
    })
}

fn waiting_response(choices: Vec<Value>) -> OpenedWordDocument {
    OpenedWordDocument {
        project: None,
        world: None,
        source_changed: false,
        choices,
    }
}

async fn discovered_projects(session: &Session) -> Result<Vec<Value>, String> {
    let discovery = request(session, "/api/state", None).await?;
    discovery["projects"]
        .as_array()
        .cloned()
        .ok_or_else(|| "Workbench returned invalid manuscript discovery data.".to_string())
}

fn discovered_project(projects: &[Value], project_id: &str) -> Option<Value> {
    projects
        .iter()
        .find(|project| project["project_id"] == project_id)
        .cloned()
}

async fn current_manuscript(session: &Session, project_id: &str) -> Result<Value, String> {
    let query = reqwest::Url::parse_with_params(
        "http://127.0.0.1/",
        &[("project_id", project_id), ("baseline_id", "current")],
    )
    .map_err(|error| error.to_string())?;
    request(
        session,
        &format!("/api/manuscript?{}", query.query().unwrap()),
        None,
    )
    .await
}

fn retained_project(projects: &[Value], project_id: &str) -> Result<Value, String> {
    // Discovery already verifies the current retained baseline. Opening its
    // metadata does not need a content catalog or every historical baseline.
    discovered_project(projects, project_id)
        .ok_or_else(|| "The saved Word working copy is unavailable in this library. Restore it before reopening this file.".to_string())
}

fn scoped_workbench_project_ids(workspace: &ResearchWorkspace) -> Vec<String> {
    let mut seen = HashSet::new();
    workspace
        .journal_project_id
        .iter()
        .chain(
            workspace
                .word_documents
                .iter()
                .map(|document| &document.workbench_project_id),
        )
        .filter(|project_id| seen.insert((*project_id).clone()))
        .cloned()
        .collect()
}

fn matching_baseline_ids(manuscript: &Value, source_sha256: &str) -> Vec<String> {
    manuscript["baselines"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|baseline| baseline["source_sha256"] == source_sha256)
        .filter_map(|baseline| baseline["baseline_id"].as_str())
        .map(str::to_owned)
        .collect()
}

async fn exact_source_matches(
    session: &Session,
    workspace: &ResearchWorkspace,
    projects: &[Value],
    normalized_sha256: &str,
) -> Result<Vec<SourceMatch>, String> {
    let mut matches = Vec::new();
    for project_id in scoped_workbench_project_ids(workspace) {
        if discovered_project(projects, &project_id).is_none() {
            continue;
        }
        let manuscript = current_manuscript(session, &project_id).await?;
        if matching_baseline_ids(&manuscript, normalized_sha256).is_empty() {
            continue;
        }
        let project = manuscript
            .get("project")
            .filter(|project| project.is_object())
            .cloned()
            .or_else(|| discovered_project(projects, &project_id))
            .ok_or_else(|| "Workbench did not return a matching Word working copy.".to_string())?;
        matches.push(SourceMatch { project });
    }
    Ok(matches)
}

fn public_choices(matches: &[SourceMatch]) -> Vec<Value> {
    matches
        .iter()
        .map(|matched| matched.project.clone())
        .collect()
}

fn changed_source_selection(
    retained: Option<Value>,
    exact_matches: Vec<SourceMatch>,
) -> (Option<Value>, Vec<Value>) {
    let mut choices = public_choices(&exact_matches);
    if let Some(project) = retained.as_ref() {
        choices.push(project.clone());
    }
    (retained, choices)
}

fn unmapped_resolution(matches: Vec<SourceMatch>) -> UnmappedResolution {
    if matches.is_empty() {
        UnmappedResolution::ImportNow
    } else {
        UnmappedResolution::Choose(public_choices(&matches))
    }
}

async fn select_exact_match(
    session: &Session,
    workspace: &ResearchWorkspace,
    projects: &[Value],
    path: &str,
    normalized: &normalization::NormalizedTemplate,
    selected_id: &str,
) -> Result<Value, String> {
    let matches =
        exact_source_matches(session, workspace, projects, &normalized.docx_sha256).await?;
    let selected = matches
        .into_iter()
        .find(|matched| matched.project["project_id"] == selected_id)
        .ok_or("That Word working copy is not an exact source match for this file.")?;
    crate::research_workspace::roots::set_word_document(
        &workspace.primary_project_id,
        path.to_string(),
        selected_id.to_string(),
        normalized.original_sha256.clone(),
        normalized.docx_sha256.clone(),
    )?;
    Ok(selected.project)
}

async fn import_source(
    session: &Session,
    workspace: &ResearchWorkspace,
    path: &str,
    normalized: normalization::NormalizedTemplate,
) -> Result<Value, String> {
    let name = Path::new(&normalized.original_name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let docx_name = format!("{name}.docx");
    let project = request(
        session,
        "/api/projects",
        Some(json!({
            "name": name,
            "filename": docx_name,
            "content_base64": STANDARD.encode(normalized.project_upload_bytes()),
        })),
    )
    .await?;
    let receipt = validate_import_receipt(&project, &normalized)?;
    let (original_sha256, normalized_sha256) = word_link_hashes(&normalized, &receipt);
    crate::research_workspace::roots::set_word_document(
        &workspace.primary_project_id,
        path.to_string(),
        receipt.workbench_project_id,
        original_sha256,
        normalized_sha256,
    )?;
    Ok(project)
}

#[derive(Debug, Eq, PartialEq)]
struct ImportReceipt {
    workbench_project_id: String,
    original_sha256: String,
    source_sha256: String,
}

fn validate_import_receipt(
    project: &Value,
    normalized: &normalization::NormalizedTemplate,
) -> Result<ImportReceipt, String> {
    let digest = |field: &str| {
        project[field]
            .as_str()
            .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| {
                format!(
                    "Workbench did not return the committed {field} for the new Word working copy."
                )
            })
    };
    let workbench_project_id = project["project_id"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or("Workbench did not return the committed Word project identity.")?
        .to_owned();
    let committed_original = digest("original_sha256")?.to_owned();
    let committed_source = digest("source_sha256")?.to_owned();
    let expected_original = if normalized.converted_from_legacy {
        normalized.docx_sha256.as_str()
    } else {
        normalized.original_sha256.as_str()
    };
    if committed_original != expected_original {
        return Err(
            "Workbench committed a different original DOCX than the selected source; the file tree link was not created."
                .into(),
        );
    }
    if committed_source != normalized.docx_sha256 {
        return Err(
            "Workbench committed a different normalized DOCX than the selected source; the file tree link was not created."
                .into(),
        );
    }
    Ok(ImportReceipt {
        workbench_project_id,
        original_sha256: committed_original,
        source_sha256: committed_source,
    })
}

fn word_link_hashes(
    normalized: &normalization::NormalizedTemplate,
    receipt: &ImportReceipt,
) -> (String, String) {
    let original = if normalized.converted_from_legacy {
        normalized.original_sha256.clone()
    } else {
        receipt.original_sha256.clone()
    };
    (original, receipt.source_sha256.clone())
}

async fn open_mapped(
    session: &Session,
    workspace: ResearchWorkspace,
    projects: &[Value],
    link: WordDocumentLink,
    path: String,
    choice: WordOpenChoice,
) -> Result<OpenedWordDocument, String> {
    if choice.new_copy {
        let normalized = normalized_source(session, &workspace.primary_project_id, &path).await?;
        let project = import_source(session, &workspace, &path, normalized).await?;
        return opened_response(session, project, false, Vec::new()).await;
    }

    let current_sha256 = source_original_sha256(&workspace.primary_project_id, &path).await;
    if choice.workbench_project_id.as_deref() == Some(link.workbench_project_id.as_str()) {
        let project = retained_project(projects, &link.workbench_project_id)?;
        crate::research_workspace::roots::set_journal_project(
            &workspace.primary_project_id,
            link.workbench_project_id,
        )?;
        return opened_response(session, project, false, Vec::new()).await;
    }

    if let Some(selected_id) = choice.workbench_project_id {
        let normalized = normalized_source(session, &workspace.primary_project_id, &path).await?;
        let project = select_exact_match(
            session,
            &workspace,
            projects,
            &path,
            &normalized,
            &selected_id,
        )
        .await?;
        return opened_response(session, project, false, Vec::new()).await;
    }

    let retained = discovered_project(projects, &link.workbench_project_id);
    if current_sha256
        .as_ref()
        .is_ok_and(|current| link.original_sha256.as_deref() == Some(current.as_str()))
    {
        if let Some(project) = retained.as_ref() {
            crate::research_workspace::roots::set_journal_project(
                &workspace.primary_project_id,
                link.workbench_project_id,
            )?;
            return opened_response(session, project.clone(), false, Vec::new()).await;
        }
    }

    let mut exact_matches = Vec::new();
    if current_sha256.is_ok() {
        if let Ok(normalized) =
            normalized_source(session, &workspace.primary_project_id, &path).await
        {
            exact_matches =
                exact_source_matches(session, &workspace, projects, &normalized.docx_sha256)
                    .await?;
            if link.original_sha256.is_none() {
                if let Some(selected) = exact_matches
                    .iter()
                    .find(|matched| matched.project["project_id"] == link.workbench_project_id)
                {
                    crate::research_workspace::roots::set_word_document(
                        &workspace.primary_project_id,
                        path,
                        link.workbench_project_id.clone(),
                        normalized.original_sha256,
                        normalized.docx_sha256,
                    )?;
                    return opened_response(session, selected.project.clone(), false, Vec::new())
                        .await;
                }
            }
        }
    }

    let (project, choices) = changed_source_selection(retained, exact_matches);
    if let Some(project) = project {
        return opened_response(session, project, true, choices).await;
    }
    Ok(OpenedWordDocument {
        project: None,
        world: None,
        source_changed: true,
        choices,
    })
}

async fn open_unmapped(
    session: &Session,
    workspace: ResearchWorkspace,
    projects: &[Value],
    path: String,
    choice: WordOpenChoice,
) -> Result<OpenedWordDocument, String> {
    let normalized = normalized_source(session, &workspace.primary_project_id, &path).await?;
    if let Some(selected_id) = choice.workbench_project_id {
        let project = select_exact_match(
            session,
            &workspace,
            projects,
            &path,
            &normalized,
            &selected_id,
        )
        .await?;
        return opened_response(session, project, false, Vec::new()).await;
    }
    if choice.new_copy {
        let project = import_source(session, &workspace, &path, normalized).await?;
        return opened_response(session, project, false, Vec::new()).await;
    }

    let matches =
        exact_source_matches(session, &workspace, projects, &normalized.docx_sha256).await?;
    match unmapped_resolution(matches) {
        UnmappedResolution::ImportNow => {
            let project = import_source(session, &workspace, &path, normalized).await?;
            opened_response(session, project, false, Vec::new()).await
        }
        UnmappedResolution::Choose(choices) => Ok(waiting_response(choices)),
    }
}

/// Resolve a project Word file to its working copy. Changed sources and exact
/// historical matches require a choice; a new unmatched source imports directly.
#[tauri::command]
pub async fn journal_word_open(
    state: State<'_, JournalWorkbenchState>,
    project_id: String,
    path: String,
    workbench_project_id: Option<String>,
    new_copy: Option<bool>,
) -> Result<OpenedWordDocument, String> {
    let path = document_path(&path)?;
    let choice = WordOpenChoice {
        workbench_project_id,
        new_copy: new_copy.unwrap_or(false),
    };
    if choice.new_copy && choice.workbench_project_id.is_some() {
        return Err("Choose either a retained Word working copy or a new copy.".into());
    }

    // The Workbench session lock serializes source resolution and the native link write.
    let current = state.0.lock().await;
    let session = current.as_ref().ok_or("Connect Workbench first.")?;
    let workspace = crate::research_workspace::roots::get_workspace(&project_id)?;
    let projects = discovered_projects(session).await?;
    if let Some(link) = workspace
        .word_documents
        .iter()
        .find(|item| item.path == path)
        .cloned()
    {
        return open_mapped(session, workspace, &projects, link, path, choice).await;
    }
    open_unmapped(session, workspace, &projects, path, choice).await
}

#[tauri::command]
pub async fn journal_word_original_sha256(
    project_id: String,
    workbench_project_id: String,
    source_path: Option<String>,
) -> Result<Option<String>, String> {
    let source_path = source_path.as_deref().map(document_path).transpose()?;
    let workspace = crate::research_workspace::roots::get_workspace(&project_id)?;
    let link = workspace.word_documents.iter().find(|link| {
        link.workbench_project_id == workbench_project_id
            && source_path.as_ref().is_none_or(|path| *path == link.path)
    });
    match link {
        Some(link) => source_original_sha256(&project_id, &link.path)
            .await
            .map(Some),
        None if source_path.is_none() => Ok(None),
        None => Err("The Word source is no longer linked to this working copy.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> ResearchWorkspace {
        ResearchWorkspace {
            version: 1,
            primary_project_id: "paper".into(),
            roots: Vec::new(),
            journal_project_id: Some("selected".into()),
            word_documents: vec![
                WordDocumentLink {
                    path: "en/paper.docx".into(),
                    workbench_project_id: "en-retained".into(),
                    original_sha256: Some("a".repeat(64)),
                    normalized_sha256: Some("a".repeat(64)),
                },
                WordDocumentLink {
                    path: "zh/paper.docx".into(),
                    workbench_project_id: "zh-retained".into(),
                    original_sha256: Some("b".repeat(64)),
                    normalized_sha256: Some("b".repeat(64)),
                },
            ],
            journal_research: None,
            updated_at_ms: 1,
        }
    }

    #[test]
    fn word_paths_share_a_portable_key_and_stay_inside_the_project() {
        assert_eq!(
            document_path("./中文稿/批注.DOCX").unwrap(),
            "中文稿/批注.DOCX"
        );
        assert_eq!(
            document_path("英文稿\\draft.doc").unwrap(),
            "英文稿/draft.doc"
        );
        for path in [
            "../draft.docx",
            "/tmp/draft.docx",
            "notes.txt",
            "draft.docx/../other.docx",
        ] {
            assert!(document_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn only_current_workspace_projects_are_source_candidates() {
        assert_eq!(
            scoped_workbench_project_ids(&workspace()),
            vec![
                "selected".to_string(),
                "en-retained".to_string(),
                "zh-retained".to_string()
            ]
        );
    }

    #[test]
    fn exact_history_hash_and_explicit_selection_are_required() {
        let source = "c".repeat(64);
        let manuscript = json!({
            "project": {"project_id": "selected", "name": "Selected", "baseline_id": "baseline-current"},
            "baselines": [
                {"baseline_id": "baseline-old", "source_sha256": source},
                {"baseline_id": "baseline-other", "source_sha256": "d".repeat(64)}
            ]
        });
        let matched = matching_baseline_ids(&manuscript, &source);
        assert_eq!(matched, vec!["baseline-old".to_string()]);
        let matches = [SourceMatch {
            project: manuscript["project"].clone(),
        }];

        assert_eq!(
            public_choices(&matches),
            vec![manuscript["project"].clone()]
        );
    }

    #[test]
    fn unmapped_source_imports_directly_only_without_exact_matches() {
        assert!(matches!(
            unmapped_resolution(Vec::new()),
            UnmappedResolution::ImportNow
        ));

        let project = json!({"project_id": "matched", "name": "Matched"});
        match unmapped_resolution(vec![SourceMatch {
            project: project.clone(),
        }]) {
            UnmappedResolution::Choose(choices) => assert_eq!(choices, vec![project]),
            UnmappedResolution::ImportNow => panic!("exact matches must be offered as choices"),
        }
    }

    #[test]
    fn changed_source_forwards_both_the_retained_copy_and_exact_matches() {
        let retained = json!({"project_id": "retained", "name": "Retained"});
        let matched = json!({"project_id": "matched", "name": "Matched"});
        let (project, choices) = changed_source_selection(
            Some(retained.clone()),
            vec![SourceMatch {
                project: matched.clone(),
            }],
        );

        assert_eq!(project, Some(retained.clone()));
        assert_eq!(choices, vec![matched, retained]);
    }

    #[test]
    fn missing_retained_copy_still_returns_exact_match_choices() {
        let matched = json!({"project_id": "matched", "name": "Matched"});
        let (project, choices) = changed_source_selection(
            None,
            vec![SourceMatch {
                project: matched.clone(),
            }],
        );

        assert_eq!(project, None);
        assert_eq!(choices, vec![matched]);
    }

    #[test]
    fn waiting_response_serializes_the_frontend_contract() {
        let project = json!({
            "project_id": "retained",
            "name": "Retained",
            "baseline_id": "baseline"
        });
        let response = waiting_response(vec![project.clone()]);
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "project": null,
                "world": null,
                "sourceChanged": false,
                "choices": [project]
            })
        );
    }

    fn template_fixture(
        original: &str,
        docx: &str,
        converted_from_legacy: bool,
    ) -> normalization::NormalizedTemplate {
        normalization::NormalizedTemplate {
            original_name: "paper.docx".into(),
            original_sha256: original.into(),
            original_bytes: Vec::new(),
            docx_bytes: Vec::new(),
            docx_sha256: docx.into(),
            conversion: None,
            converted_from_legacy,
        }
    }

    #[test]
    fn import_receipt_must_match_the_uploaded_and_normalized_hashes() {
        let original = "a".repeat(64);
        let source = "b".repeat(64);
        let normalized = template_fixture(&original, &source, false);
        let receipt = validate_import_receipt(
            &json!({
                "project_id": "project-strict",
                "original_sha256": original,
                "source_sha256": source,
            }),
            &normalized,
        )
        .unwrap();
        assert_eq!(receipt.workbench_project_id, "project-strict");
        assert_eq!(
            word_link_hashes(&normalized, &receipt),
            (original.clone(), source.clone())
        );
        assert!(validate_import_receipt(
            &json!({
                "project_id": "project-strict",
                "original_sha256": source,
                "source_sha256": source,
            }),
            &normalized,
        )
        .unwrap_err()
        .contains("different original DOCX"));
        assert!(validate_import_receipt(
            &json!({
                "project_id": "project-strict",
                "original_sha256": original,
                "source_sha256": original,
            }),
            &normalized,
        )
        .unwrap_err()
        .contains("different normalized DOCX"));
        assert!(validate_import_receipt(
            &json!({
                "project_id": "project-strict",
                "original_sha256": original,
            }),
            &normalized,
        )
        .unwrap_err()
        .contains("committed source_sha256"));
        assert!(validate_import_receipt(
            &json!({
                "project_id": " ",
                "original_sha256": original,
                "source_sha256": source,
            }),
            &normalized,
        )
        .unwrap_err()
        .contains("committed Word project identity"));
    }

    #[test]
    fn legacy_receipt_identifies_the_converted_upload_for_both_hashes() {
        let original = "a".repeat(64);
        let converted = "b".repeat(64);
        let normalized = template_fixture(&original, &converted, true);
        let receipt = validate_import_receipt(
            &json!({
                "project_id": "project-legacy",
                "original_sha256": converted,
                "source_sha256": converted,
            }),
            &normalized,
        )
        .unwrap();
        assert_eq!(
            word_link_hashes(&normalized, &receipt),
            (original.clone(), converted.clone())
        );
        assert!(validate_import_receipt(
            &json!({
                "project_id": "project-legacy",
                "original_sha256": original,
                "source_sha256": converted,
            }),
            &normalized,
        )
        .unwrap_err()
        .contains("different original DOCX"));
    }
}
