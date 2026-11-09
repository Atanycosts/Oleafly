use std::fs;
use std::path::Path;

use oleafly_collab_protocol::projects::ProjectRole;

use super::Fixture;
use crate::collab::live::write::rig::LiveRig;
use crate::collab::live::write::SharedDocument;
use crate::research_tasks::model::{ResearchTask, TaskFilePreview};
use crate::research_tasks::preview::task_file_preview;

#[test]
fn source_observations_recover_the_exact_retained_range_after_workspace_changes() {
    use oleafly_research::model::{ResearchTaskDraft, TaskRuntimeEvent};
    use oleafly_research::observations::{content_hash, ReadSource, TaskObservation};
    let fixture = Fixture::new();
    let bytes = "alpha\n证据\nomega\n";
    let saved = fixture.task(
        "source-read",
        &[("main.tex", Some(bytes.as_bytes()), Some(b"changed source"))],
    );
    let task = fixture
        .store
        .create(ResearchTaskDraft {
            project_id: "source-read".into(),
            title: "Read source".into(),
            prompt: "Read".into(),
            runtime_id: "builtin".into(),
            agent_id: "fixture".into(),
            model_id: "fixture".into(),
            ..Default::default()
        })
        .unwrap();
    fixture.store.request_start(&task.id).unwrap();
    let task = fixture.store.claim_next().unwrap().unwrap();
    fixture
        .store
        .set_isolation(
            &task.id,
            task.execution_generation,
            &saved.isolation.unwrap(),
        )
        .unwrap();
    assert!(fixture
        .store
        .retain_file_snapshot(
            &task.id,
            task.execution_generation,
            "main.tex",
            &content_hash(bytes.as_bytes()),
            bytes.as_bytes(),
        )
        .unwrap());
    let row = fixture
        .store
        .append_event(
            &task.id,
            task.execution_generation,
            &TaskRuntimeEvent::Observation {
                observation: TaskObservation::ToolExecution {
                    call_id: "read-call".into(),
                    name: "read_file".into(),
                    status: "done".into(),
                    input_sha256: content_hash(b"input"),
                    output_sha256: content_hash(b"output"),
                    skill_id: None,
                    skill_instructions_sha256: None,
                    source: Some(ReadSource {
                        path: "main.tex".into(),
                        file_sha256: content_hash(bytes.as_bytes()),
                        offset: 6,
                        end_offset: 12,
                        truncated: true,
                        snapshot_retained: Some(true),
                        pdf: None,
                    }),
                    actor: None,
                },
            },
        )
        .unwrap()
        .unwrap();
    let preview = crate::research_tasks::preview::source_preview(
        &fixture.store,
        &task.id,
        task.execution_generation,
        row.sequence,
    )
    .unwrap();
    assert_eq!(preview.text, "证据");
    assert!(crate::research_tasks::preview::source_preview(
        &fixture.store,
        &task.id,
        task.execution_generation + 1,
        row.sequence
    )
    .is_err());
    fs::write(fixture.baseline.join("main.tex"), "overwritten baseline").unwrap();
    fs::write(fixture.execution.join("main.tex"), "also overwritten").unwrap();
    let preview = crate::research_tasks::preview::source_preview(
        &fixture.store,
        &task.id,
        task.execution_generation,
        row.sequence,
    )
    .unwrap();
    assert_eq!(preview.text, "证据");
}

#[test]
fn an_old_generation_never_reads_the_current_workspace_without_a_retained_snapshot() {
    use oleafly_research::model::{ResearchTaskDraft, RetryMode, TaskRuntimeEvent};
    use oleafly_research::observations::{content_hash, ReadSource, TaskObservation};
    let fixture = Fixture::new();
    let source = "same bytes in both generations";
    let saved = fixture.task(
        "old-source-generation",
        &[("main.tex", Some(source.as_bytes()), Some(source.as_bytes()))],
    );
    let draft = ResearchTaskDraft {
        project_id: "old-source-generation".into(),
        title: "Read source across generations".into(),
        prompt: "Read the same version twice".into(),
        runtime_id: "builtin".into(),
        agent_id: "fixture".into(),
        model_id: "fixture".into(),
        ..Default::default()
    };
    let task = fixture.store.create(draft).unwrap();
    fixture.store.request_start(&task.id).unwrap();
    let first = fixture.store.claim_next().unwrap().unwrap();
    let mut first_isolation = saved.isolation.unwrap();
    fixture
        .store
        .set_isolation(&task.id, first.execution_generation, &first_isolation)
        .unwrap();
    let row = fixture
        .store
        .append_event(
            &task.id,
            first.execution_generation,
            &TaskRuntimeEvent::Observation {
                observation: TaskObservation::ToolExecution {
                    call_id: "old-read".into(),
                    name: "read_file".into(),
                    status: "done".into(),
                    input_sha256: content_hash(b"input"),
                    output_sha256: content_hash(source.as_bytes()),
                    skill_id: None,
                    skill_instructions_sha256: None,
                    source: Some(ReadSource {
                        path: "main.tex".into(),
                        file_sha256: content_hash(source.as_bytes()),
                        offset: 0,
                        end_offset: source.len(),
                        truncated: false,
                        snapshot_retained: Some(false),
                        pdf: None,
                    }),
                    actor: None,
                },
            },
        )
        .unwrap()
        .unwrap();
    fixture
        .store
        .finish_failure(&task.id, first.execution_generation, "retry")
        .unwrap();
    fixture
        .store
        .retry_with(&task.id, RetryMode::Fresh)
        .unwrap();
    fixture.store.request_start(&task.id).unwrap();
    let second = fixture.store.claim_next().unwrap().unwrap();
    assert_eq!(second.execution_generation, first.execution_generation + 1);
    first_isolation.execution_root = fixture
        ._temp
        .path()
        .join("next-execution")
        .to_string_lossy()
        .into_owned();
    first_isolation.baseline_root = fixture
        ._temp
        .path()
        .join("next-baseline")
        .to_string_lossy()
        .into_owned();
    fixture
        .store
        .set_isolation(&task.id, second.execution_generation, &first_isolation)
        .unwrap();
    let isolation = &first_isolation;
    fs::create_dir_all(&isolation.execution_root).unwrap();
    fs::create_dir_all(&isolation.baseline_root).unwrap();
    fs::write(
        Path::new(&isolation.execution_root).join("main.tex"),
        source,
    )
    .unwrap();
    fs::write(Path::new(&isolation.baseline_root).join("main.tex"), source).unwrap();

    let error = crate::research_tasks::preview::source_preview(
        &fixture.store,
        &task.id,
        first.execution_generation,
        row.sequence,
    )
    .unwrap_err();
    assert!(
        error.contains("older generation was not retained"),
        "{error}"
    );
}

#[test]
fn a_read_without_a_retained_snapshot_is_reported_as_unavailable() {
    use oleafly_research::model::{ResearchTaskDraft, TaskRuntimeEvent};
    use oleafly_research::observations::{content_hash, ReadSource, TaskObservation};
    let fixture = Fixture::new();
    let source = "a source too large for retention";
    let saved = fixture.task(
        "unretained-source",
        &[("main.tex", Some(source.as_bytes()), Some(source.as_bytes()))],
    );
    let task = fixture
        .store
        .create(ResearchTaskDraft {
            project_id: "unretained-source".into(),
            title: "Read unretained source".into(),
            prompt: "Read".into(),
            runtime_id: "builtin".into(),
            agent_id: "fixture".into(),
            model_id: "fixture".into(),
            ..Default::default()
        })
        .unwrap();
    fixture.store.request_start(&task.id).unwrap();
    let task = fixture.store.claim_next().unwrap().unwrap();
    fixture
        .store
        .set_isolation(
            &task.id,
            task.execution_generation,
            &saved.isolation.unwrap(),
        )
        .unwrap();
    let filler = vec![b'x'; 16 * 1024 * 1024];
    assert!(fixture
        .store
        .retain_file_snapshot(
            &task.id,
            task.execution_generation,
            "filler.bin",
            &content_hash(&filler),
            &filler,
        )
        .unwrap());
    let hash = content_hash(source.as_bytes());
    assert!(!fixture
        .store
        .retain_file_snapshot(
            &task.id,
            task.execution_generation,
            "main.tex",
            &hash,
            source.as_bytes(),
        )
        .unwrap());
    let row = fixture
        .store
        .append_event(
            &task.id,
            task.execution_generation,
            &TaskRuntimeEvent::Observation {
                observation: TaskObservation::ToolExecution {
                    call_id: "unretained-read".into(),
                    name: "read_file".into(),
                    status: "done".into(),
                    input_sha256: content_hash(b"input"),
                    output_sha256: content_hash(b"output"),
                    skill_id: None,
                    skill_instructions_sha256: None,
                    source: Some(ReadSource {
                        path: "main.tex".into(),
                        file_sha256: hash,
                        offset: 0,
                        end_offset: source.len(),
                        truncated: false,
                        snapshot_retained: Some(false),
                        pdf: None,
                    }),
                    actor: None,
                },
            },
        )
        .unwrap()
        .unwrap();
    let preview = crate::research_tasks::preview::source_preview(
        &fixture.store,
        &task.id,
        task.execution_generation,
        row.sequence,
    )
    .unwrap();
    assert_eq!(preview.text, source);
    fs::write(fixture.baseline.join("main.tex"), "changed after read").unwrap();
    fs::write(
        fixture.execution.join("main.tex"),
        "also changed after read",
    )
    .unwrap();
    let error = crate::research_tasks::preview::source_preview(
        &fixture.store,
        &task.id,
        task.execution_generation,
        row.sequence,
    )
    .unwrap_err();
    assert!(error.contains("no longer retained"), "{error}");
    let view = fixture
        .store
        .observations(
            "unretained-source",
            &task.id,
            task.execution_generation,
            0,
            20,
        )
        .unwrap();
    assert!(view
        .summary
        .coverage_gaps
        .contains(&"observations.source_snapshot_not_retained".into()));
}

fn previewed(
    fixture: &Fixture,
    task: &ResearchTask,
    path: &str,
    document: Option<&SharedDocument>,
) -> TaskFilePreview {
    task_file_preview(task.clone(), path, Some(&fixture.project), document).unwrap()
}

#[test]
fn a_shared_text_file_a_collaborator_edited_previews_as_merging_and_applies() {
    let fixture = Fixture::new();
    let rig = LiveRig::start(
        "preview-merge",
        &fixture.project,
        &[("main.tex", "one\ntwo\nthree\n")],
    );
    let task = fixture.task(
        "preview-merge",
        &[(
            "main.tex",
            Some(b"one\ntwo\nthree\n"),
            Some(b"ONE\ntwo\nthree\n"),
        )],
    );
    rig.remote("main.tex", "one\ntwo\nthree\nfour from a collaborator\n");
    rig.settle();

    let preview = previewed(&fixture, &task, "main.tex", Some(&rig.document()));

    assert!(!preview.base_is_current);
    assert!(preview.merges_with_shared);
    assert_eq!(
        fixture.apply(&task, &["main.tex"], Some(&rig.document())),
        Ok(true)
    );
}

#[test]
fn an_unshared_project_never_previews_as_merging() {
    let fixture = Fixture::new();
    let task = fixture.task(
        "preview-unshared",
        &[("main.tex", Some(b"one\n"), Some(b"ONE\n"))],
    );
    fs::write(fixture.project.join("main.tex"), "one\ntwo\n").unwrap();

    let preview = previewed(&fixture, &task, "main.tex", None);

    assert!(!preview.base_is_current);
    assert!(!preview.merges_with_shared);
    assert!(fixture.apply(&task, &["main.tex"], None).is_err());
}

#[test]
fn a_binary_file_in_a_shared_project_does_not_preview_as_merging() {
    let fixture = Fixture::new();
    let rig = LiveRig::start("preview-binary", &fixture.project, &[("main.tex", "abc\n")]);
    let task = fixture.task(
        "preview-binary",
        &[("figure.bin", Some(&[0, 1, 2]), Some(&[0, 9, 9]))],
    );
    fs::write(fixture.project.join("figure.bin"), [5, 5, 5]).unwrap();

    let preview = previewed(&fixture, &task, "figure.bin", Some(&rig.document()));

    assert!(!preview.base_is_current);
    assert!(!preview.merges_with_shared);
    assert!(fixture
        .apply(&task, &["figure.bin"], Some(&rig.document()))
        .is_err());
}

#[test]
fn a_new_file_someone_else_created_first_does_not_preview_as_merging() {
    let fixture = Fixture::new();
    let rig = LiveRig::start("preview-added", &fixture.project, &[("main.tex", "abc\n")]);
    let task = fixture.task(
        "preview-added",
        &[("notes.tex", None, Some(b"Task notes\n"))],
    );
    rig.remote_new("notes.tex", "Collaborator notes\n");
    rig.settle();

    let preview = previewed(&fixture, &task, "notes.tex", Some(&rig.document()));

    assert!(!preview.base_is_current);
    assert!(!preview.merges_with_shared);
    assert!(fixture
        .apply(&task, &["notes.tex"], Some(&rig.document()))
        .is_err());
}

#[test]
fn a_viewer_never_previews_as_merging() {
    let fixture = Fixture::new();
    let rig = LiveRig::start(
        "preview-viewer",
        &fixture.project,
        &[("main.tex", "one\ntwo\nthree\n")],
    );
    let task = fixture.task(
        "preview-viewer",
        &[(
            "main.tex",
            Some(b"one\ntwo\nthree\n"),
            Some(b"ONE\ntwo\nthree\n"),
        )],
    );
    rig.remote("main.tex", "one\ntwo\nthree\nfour from a collaborator\n");
    rig.settle();
    rig.set_role(ProjectRole::Viewer);

    let preview = previewed(&fixture, &task, "main.tex", Some(&rig.document()));

    assert!(!preview.base_is_current);
    assert!(!preview.merges_with_shared);
}
