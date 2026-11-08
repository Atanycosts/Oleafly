use super::*;
use crate::model::{
    EvidenceCheck, EvidenceItem, EvidenceStatus, ResearchTaskDraft, RunRecord, RunState,
    TaskFileChange, TaskFileChangeKind, TaskIsolation, TaskIsolationKind,
};
use std::collections::BTreeMap;
use std::path::PathBuf;

struct Fixture {
    _temp: tempfile::TempDir,
    store: TaskStore,
    task: ResearchTask,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let store = TaskStore::new(temp.path().join("tasks")).unwrap();
        let task = store
            .create(ResearchTaskDraft {
                project_id: "paper".into(),
                title: "Numeric review".into(),
                prompt: "Review".into(),
                runtime_id: "builtin".into(),
                agent_id: "fixture".into(),
                model_id: "fixture".into(),
                ..Default::default()
            })
            .unwrap();
        store.request_start(&task.id).unwrap();
        let task = store.claim_next().unwrap().unwrap();
        let root = temp.path().join("work");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("main.md"),
            "# Results\n\nLoss 0.70 <!-- run: r001 -->\n",
        )
        .unwrap();
        std::fs::write(root.join("unrelated.md"), "unrelated").unwrap();
        let isolation = TaskIsolation {
            kind: TaskIsolationKind::StagedProject,
            execution_root: root.to_string_lossy().into(),
            baseline_root: temp.path().join("base").to_string_lossy().into(),
            source_revision: "snapshot:fixture".into(),
            baseline_hash: "fixture".into(),
            baseline: vec![],
            allowed_paths: vec!["main.md".into(), "unrelated.md".into(), task.record_dir()],
            created_at: 0,
            skipped: vec![],
            initial_git_status: None,
            initial_git_status_complete: None,
        };
        store
            .set_isolation(&task.id, task.execution_generation, &isolation)
            .unwrap();
        let task = store.require(&task.id).unwrap();
        Self {
            _temp: temp,
            store,
            task,
            root,
        }
    }

    async fn check(&self) -> EvidenceReport {
        let changes = [TaskFileChange {
            path: "main.md".into(),
            kind: TaskFileChangeKind::Added,
            before_sha256: None,
            after_sha256: Some(content_hash(
                &std::fs::read(self.root.join("main.md")).unwrap(),
            )),
            before_size: None,
            after_size: None,
        }];
        let report = crate::evidence::check_evidence(
            crate::evidence::EvidenceInputs {
                isolation: self.task.isolation.as_ref().unwrap(),
                changes: &changes,
                runs: self.store.runs(&self.task.id),
                ledger: crate::record::read_ledger(&self.root, &self.task.record_slug),
                workspace: None,
                project_root: None,
            },
            &oleafly_agent::CancellationToken::new(),
        )
        .await;
        self.store
            .set_evidence(&self.task.id, self.task.execution_generation, &report)
            .unwrap();
        report
    }

    fn page(&self, query: FindingQuery) -> FindingPage {
        self.store
            .findings(
                "paper",
                &self.task.id,
                self.task.execution_generation,
                &query,
            )
            .unwrap()
    }

    fn decide(&self, id: &str, disposition: FindingDisposition, rationale: &str) {
        self.store
            .decide_finding(
                "paper",
                &self.task.id,
                self.task.execution_generation,
                id,
                &FindingDecision {
                    disposition,
                    rationale: rationale.into(),
                },
            )
            .unwrap();
    }

    fn add_run(&self, id: &str, loss: f64) {
        self.store
            .insert_run(&RunRecord {
                task_id: self.task.id.clone(),
                run_id: id.into(),
                execution_generation: self.task.execution_generation,
                name: id.into(),
                executor: "local".into(),
                command: "printf loss=0.5".into(),
                cwd_rel: String::new(),
                state: RunState::Running,
                exit_code: None,
                started_at: 0,
                finished_at: None,
                run_dir: String::new(),
                metrics: BTreeMap::new(),
                reported: false,
            })
            .unwrap();
        self.store
            .finish_run(
                &self.task.id,
                id,
                RunState::Succeeded,
                Some(0),
                1,
                &BTreeMap::from([("loss".into(), loss)]),
            )
            .unwrap();
    }
}

#[tokio::test]
async fn retained_quote_and_operator_history_survive_recheck_and_reopen() {
    let fixture = Fixture::new();
    fixture.check().await;
    let first = fixture.page(FindingQuery::default());
    assert_eq!(first.findings.len(), 1);
    let row = &first.findings[0];
    assert_eq!(row.finding.item.code, "numbers.unknownRun");
    assert_eq!(row.validity, FindingValidity::Current);
    let id = &row.finding.id;
    let quote = fixture
        .store
        .finding_source(
            "paper",
            &fixture.task.id,
            fixture.task.execution_generation,
            id,
        )
        .unwrap();
    assert_eq!(quote.quote, "Loss 0.70 <!-- run: r001 -->");
    assert_eq!(quote.line_start, 3);
    assert_eq!(
        quote.file_sha256,
        content_hash(&std::fs::read(fixture.root.join("main.md")).unwrap())
    );
    for (disposition, reason) in [
        (FindingDisposition::Accepted, "Need the run result"),
        (FindingDisposition::Rejected, "Intentional example"),
        (FindingDisposition::Deferred, "Ask the author"),
    ] {
        fixture.decide(id, disposition, reason);
    }
    fixture.check().await;
    let reopened = TaskStore::new(fixture.store.root().to_owned()).unwrap();
    let page = reopened
        .findings(
            "paper",
            &fixture.task.id,
            fixture.task.execution_generation,
            &FindingQuery::default(),
        )
        .unwrap();
    assert_eq!(page.findings.len(), 1);
    assert_eq!(page.findings[0].finding, row.finding);
    assert_eq!(page.findings[0].disposition, FindingDisposition::Deferred);
    assert_eq!(page.findings[0].history_count, 3);
    assert_eq!(page.findings[0].history[0].rationale, "Need the run result");
    assert!(page.findings[0]
        .history
        .windows(2)
        .all(|w| w[0].sequence < w[1].sequence));
    assert_eq!(page.findings[0].finding.verdict, "warning");
}

#[tokio::test]
async fn validity_tracks_only_cited_file_run_and_ledger_membership() {
    let fixture = Fixture::new();
    fixture.add_run("r001", 0.5);
    fixture.check().await;
    assert_eq!(fixture.page(FindingQuery::default()).findings.len(), 2);
    std::fs::write(fixture.root.join("unrelated.md"), "an unrelated change").unwrap();
    fixture.add_run("r002", 0.7);
    assert!(fixture
        .page(FindingQuery::default())
        .findings
        .iter()
        .all(|r| r.validity == FindingValidity::Current));
    let ledger = fixture
        .root
        .join(fixture.task.record_dir())
        .join("ledger.tsv");
    std::fs::create_dir_all(ledger.parent().unwrap()).unwrap();
    std::fs::write(&ledger, "id\tmetrics\nr002\tloss=0.7\n").unwrap();
    assert!(fixture
        .page(FindingQuery::default())
        .findings
        .iter()
        .all(|r| r.validity == FindingValidity::Current));
    std::fs::write(&ledger, "id\tmetrics\nr001\tloss=0.5\n").unwrap();
    let stale = fixture.page(FindingQuery::default());
    assert!(stale
        .findings
        .iter()
        .all(|r| r.validity == FindingValidity::Stale));
    assert_eq!(
        stale.findings[0].changed_dependencies[0].dependency,
        "ledger:r001"
    );
    fixture
        .store
        .open()
        .unwrap()
        .execute(
            "UPDATE research_task_runs SET metrics_json=?1 WHERE task_id=?2 AND run_id='r001'",
            params!["{\"loss\":0.7}", fixture.task.id],
        )
        .unwrap();
    assert!(fixture.page(FindingQuery::default()).findings[0]
        .changed_dependencies
        .iter()
        .any(|d| d.dependency == "run:r001"));
    std::fs::write(
        fixture.root.join("main.md"),
        "# revised results\nLoss 0.50 <!-- run: r001 -->\n",
    )
    .unwrap();
    let stale = fixture.page(FindingQuery::default());
    assert!(stale.findings[0]
        .changed_dependencies
        .iter()
        .any(|d| d.dependency == "main.md"));
    fixture.check().await;
    assert_eq!(fixture.page(FindingQuery::default()).findings.len(), 3); // two historical, one new mismatch
}

#[tokio::test]
async fn missing_source_is_stale_unreadable_source_is_unknown_and_original_quote_remains() {
    let fixture = Fixture::new();
    fixture.check().await;
    let original = fixture.page(FindingQuery::default()).findings.remove(0);
    std::fs::remove_file(fixture.root.join("main.md")).unwrap();
    let missing = fixture.page(FindingQuery::default()).findings.remove(0);
    assert_eq!(missing.validity, FindingValidity::Stale);
    assert_eq!(missing.changed_dependencies[0].actual, None);
    std::fs::create_dir(fixture.root.join("main.md")).unwrap();
    assert_eq!(
        fixture.page(FindingQuery::default()).findings[0].validity,
        FindingValidity::Unknown
    );
    assert_eq!(
        fixture
            .store
            .finding_source(
                "paper",
                &fixture.task.id,
                fixture.task.execution_generation,
                &original.finding.id
            )
            .unwrap()
            .quote,
        "Loss 0.70 <!-- run: r001 -->"
    );
}

#[tokio::test]
async fn historical_rule_version_is_stale_without_running_an_obsolete_checker() {
    let fixture = Fixture::new();
    fixture.check().await;
    let mut original = fixture
        .page(FindingQuery::default())
        .findings
        .remove(0)
        .finding;
    original.item.provenance.as_mut().unwrap().rule_version = "numbers-0".into();
    // Construct an old stored record as a migration fixture, never invoke old code.
    fixture
        .store
        .open()
        .unwrap()
        .execute(
            "UPDATE research_task_findings SET finding_json=?1 WHERE id=?2",
            params![encode_json(&original).unwrap(), original.id],
        )
        .unwrap();
    let page = fixture.page(FindingQuery::default());
    assert_eq!(page.findings[0].validity, FindingValidity::Stale);
    assert_eq!(page.findings[0].changed_dependencies[0].dependency, "rule");
}

#[tokio::test]
async fn findings_are_scoped_filtered_bounded_and_deleted_with_the_task() {
    let fixture = Fixture::new();
    fixture.add_run("r001", 0.5);
    fixture.check().await;
    let first = fixture.page(FindingQuery {
        limit: Some(1),
        ..Default::default()
    });
    assert!(first.has_more);
    let id = &first.findings[0].finding.id;
    for index in 0..21 {
        fixture.decide(id, FindingDisposition::Rejected, &format!("Reason {index}"));
    }
    let page = fixture.page(FindingQuery {
        disposition: Some(FindingDisposition::Rejected),
        ..Default::default()
    });
    assert_eq!(page.findings.len(), 1);
    assert_eq!(page.findings[0].history.len(), 20);
    assert_eq!(page.findings[0].history_count, 21);
    assert!(page
        .coverage_gaps
        .contains(&"findings.history_shortened".into()));
    let second = fixture.page(FindingQuery {
        after_sequence: first.next_sequence,
        limit: Some(1),
        ..Default::default()
    });
    assert_eq!(second.findings.len(), 1);
    assert!(!second.has_more);
    assert!(fixture
        .page(FindingQuery {
            file: Some("other.md".into()),
            ..Default::default()
        })
        .findings
        .is_empty());
    assert_eq!(
        fixture
            .page(FindingQuery {
                rule: Some("numbers.mismatch".into()),
                ..Default::default()
            })
            .findings
            .len(),
        1
    );
    for (project, task, generation) in [
        (
            "other",
            fixture.task.id.as_str(),
            fixture.task.execution_generation,
        ),
        ("paper", "missing", 1),
        (
            "paper",
            fixture.task.id.as_str(),
            fixture.task.execution_generation + 1,
        ),
    ] {
        assert!(fixture
            .store
            .findings(project, task, generation, &FindingQuery::default())
            .is_err());
        assert!(fixture
            .store
            .finding_source(project, task, generation, id)
            .is_err());
        assert!(fixture
            .store
            .decide_finding(
                project,
                task,
                generation,
                id,
                &FindingDecision {
                    disposition: FindingDisposition::Accepted,
                    rationale: "Valid reason".into()
                }
            )
            .is_err());
    }
    for limit in [0, 51] {
        assert!(fixture
            .store
            .findings(
                "paper",
                &fixture.task.id,
                fixture.task.execution_generation,
                &FindingQuery {
                    limit: Some(limit),
                    ..Default::default()
                }
            )
            .is_err());
    }
    assert!(fixture
        .store
        .decide_finding(
            "paper",
            &fixture.task.id,
            fixture.task.execution_generation,
            id,
            &FindingDecision {
                disposition: FindingDisposition::Accepted,
                rationale: " ".into()
            }
        )
        .is_err());
    fixture
        .store
        .finish_failure(
            &fixture.task.id,
            fixture.task.execution_generation,
            "Fixture complete",
        )
        .unwrap();
    fixture.store.delete(&fixture.task.id).unwrap();
    let connection = fixture.store.open().unwrap();
    for table in [
        "research_task_findings",
        "research_task_finding_dispositions",
    ] {
        assert_eq!(
            connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[tokio::test]
async fn plain_and_oversized_check_items_do_not_claim_verified_findings() {
    let fixture = Fixture::new();
    std::fs::write(
        fixture.root.join("main.md"),
        format!("{} 0.70 <!-- run: r001 -->\n", "x".repeat(8192)),
    )
    .unwrap();
    let report = fixture.check().await;
    let page = fixture.page(FindingQuery::default());
    assert!(page.findings.is_empty());
    assert!(page
        .coverage_gaps
        .contains(&"findings.numeric_items_without_source".into()));
    assert!(report
        .checks
        .iter()
        .any(|check| check.id == EvidenceCheckId::Numbers && !check.items.is_empty()));
    let ordinary = EvidenceReport {
        checked_at: 1,
        checks: vec![EvidenceCheck {
            id: EvidenceCheckId::Numbers,
            status: EvidenceStatus::Warn,
            items: vec![EvidenceItem {
                code: "numbers.unknownRun".into(),
                file: Some("main.md".into()),
                line: Some(1),
                params: Default::default(),
                provenance: None,
            }],
        }],
    };
    fixture
        .store
        .set_evidence(
            &fixture.task.id,
            fixture.task.execution_generation,
            &ordinary,
        )
        .unwrap();
    assert!(fixture.page(FindingQuery::default()).findings.is_empty());
}

#[test]
fn version_five_migration_keeps_tasks_and_adds_finding_tables() {
    let fixture = Fixture::new();
    fixture.store.open().unwrap().execute_batch("DROP TABLE research_task_finding_dispositions; DROP TABLE research_task_findings; PRAGMA user_version=5;").unwrap();
    let reopened = TaskStore::new(fixture.store.root().to_owned()).unwrap();
    assert_eq!(
        reopened.require(&fixture.task.id).unwrap().title,
        fixture.task.title
    );
    assert!(reopened
        .findings(
            "paper",
            &fixture.task.id,
            fixture.task.execution_generation,
            &FindingQuery::default()
        )
        .unwrap()
        .findings
        .is_empty());
}

#[tokio::test]
async fn unreadable_ledger_does_not_create_an_absence_finding() {
    let fixture = Fixture::new();
    fixture.add_run("r001", 0.5);
    let ledger = fixture
        .root
        .join(fixture.task.record_dir())
        .join("ledger.tsv");
    std::fs::create_dir_all(&ledger).unwrap();
    let report = fixture.check().await;
    let numeric = report
        .checks
        .iter()
        .find(|check| check.id == EvidenceCheckId::Numbers)
        .unwrap();
    assert_eq!(numeric.status, EvidenceStatus::Skipped);
    assert_eq!(numeric.items[0].code, "numbers.notChecked");
    assert!(fixture.page(FindingQuery::default()).findings.is_empty());
}

#[tokio::test]
async fn inconsistent_provenance_rejects_the_entire_report_and_retained_quote_corruption_fails() {
    let fixture = Fixture::new();
    let original = fixture.check().await;
    let first = fixture
        .page(FindingQuery::default())
        .findings
        .remove(0)
        .finding;
    let mut invalid = original.clone();
    invalid.checked_at += 100;
    invalid
        .checks
        .iter_mut()
        .find(|check| check.id == EvidenceCheckId::Numbers)
        .unwrap()
        .items[0]
        .provenance
        .as_mut()
        .unwrap()
        .source
        .quote = "different bytes".into();
    assert!(fixture
        .store
        .set_evidence(
            &fixture.task.id,
            fixture.task.execution_generation,
            &invalid
        )
        .is_err());
    assert_eq!(
        fixture
            .store
            .require(&fixture.task.id)
            .unwrap()
            .evidence
            .unwrap(),
        original
    );
    assert_eq!(fixture.page(FindingQuery::default()).findings.len(), 1);
    let mut damaged = first.clone();
    damaged.item.provenance.as_mut().unwrap().source.quote = "damaged quote".into();
    fixture
        .store
        .open()
        .unwrap()
        .execute(
            "UPDATE research_task_findings SET finding_json=?1 WHERE id=?2",
            params![encode_json(&damaged).unwrap(), first.id],
        )
        .unwrap();
    assert!(fixture
        .store
        .finding_source(
            "paper",
            &fixture.task.id,
            fixture.task.execution_generation,
            &first.id
        )
        .unwrap_err()
        .contains("integrity"));
}
