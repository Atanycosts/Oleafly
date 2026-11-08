use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use super::{decode_json, encode_json, store_error, TaskStore};
use crate::findings::{
    run_basis_hash, DependencyChange, FindingDecision, FindingDisposition,
    FindingDispositionRecord, FindingPage, FindingQuery, FindingSource, FindingValidity,
    FindingView, ReviewFinding, NUMBER_RULE_VERSION,
};
use crate::model::{now_ms, EvidenceCheckId, EvidenceReport, ResearchTask};
use crate::observations::content_hash;
use crate::task_tools::TaskFiles;

pub(super) fn retain_findings(
    transaction: &Transaction<'_>,
    task_id: &str,
    generation: u64,
    report: &EvidenceReport,
) -> Result<(), String> {
    for check in &report.checks {
        if check.id != EvidenceCheckId::Numbers {
            continue;
        }
        for item in &check.items {
            let Some(basis) = &item.provenance else {
                continue;
            };
            // Only the current numeric checker supplies this contract. A plain
            // historical check item never becomes a source-verified finding.
            if basis.rule_version != NUMBER_RULE_VERSION
                || item.file.as_deref() != Some(basis.source.path.as_str())
                || item.line != Some(basis.source.line_start)
                || basis.source.line_start == 0
                || basis.source.line_end != basis.source.line_start
                || basis.source.quote.len() > 8192
                || content_hash(basis.source.quote.as_bytes()) != basis.source.quote_sha256
            {
                return Err("The numeric finding has inconsistent source evidence.".into());
            }
            let id = format!(
                "finding-{}",
                content_hash(
                    &serde_json::to_vec(&(task_id, generation, item))
                        .map_err(|error| error.to_string())?
                )
            );
            let finding = ReviewFinding {
                id: id.clone(),
                task_id: task_id.into(),
                execution_generation: generation,
                origin: "deterministic".into(),
                verdict: "warning".into(),
                severity: "warning".into(),
                item: item.clone(),
                created_at: report.checked_at,
            };
            transaction.execute(
                "INSERT INTO research_task_findings (id, task_id, execution_generation, finding_json) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO NOTHING",
                params![id, task_id, generation as i64, encode_json(&finding)?],
            ).map_err(store_error)?;
        }
    }
    Ok(())
}

fn bound_task(
    transaction: &Transaction<'_>,
    project: &str,
    task_id: &str,
    generation: u64,
) -> Result<ResearchTask, String> {
    let task = TaskStore::require_on(transaction, task_id)?;
    if task.project_id != project || task.execution_generation != generation {
        return Err("This task or generation is outside the bound research session.".into());
    }
    Ok(task)
}

fn load_finding(
    transaction: &Transaction<'_>,
    task_id: &str,
    generation: u64,
    id: &str,
) -> Result<ReviewFinding, String> {
    let json: String = transaction.query_row(
        "SELECT finding_json FROM research_task_findings WHERE id=?1 AND task_id=?2 AND execution_generation=?3",
        params![id, task_id, generation as i64], |row| row.get(0),
    ).optional().map_err(store_error)?.ok_or("This finding is outside the bound task generation.")?;
    decode_json(&json, "review finding")
}

impl TaskStore {
    pub fn findings(
        &self,
        project: &str,
        task_id: &str,
        generation: u64,
        query: &FindingQuery,
    ) -> Result<FindingPage, String> {
        let limit = query.limit.unwrap_or(20);
        if !(1..=50).contains(&limit) || query.after_sequence > i64::MAX as u64 {
            return Err("Use a nonnegative finding cursor and a limit between 1 and 50.".into());
        }
        let mut connection = self.open()?;
        let transaction = connection.transaction().map_err(store_error)?;
        let task = bound_task(&transaction, project, task_id, generation)?;
        let disposition = query.disposition.map(|value| {
            serde_json::to_value(value)
                .expect("enum is serializable")
                .as_str()
                .expect("string enum")
                .to_owned()
        });
        let rows = transaction.prepare(
            "SELECT f.sequence, f.finding_json FROM research_task_findings f
             WHERE f.task_id=?1 AND f.execution_generation=?2 AND f.sequence>?3
               AND (?4 IS NULL OR json_extract(f.finding_json,'$.item.provenance.source.path')=?4)
               AND (?5 IS NULL OR json_extract(f.finding_json,'$.item.code')=?5)
               AND (?6 IS NULL OR COALESCE((SELECT json_extract(d.decision_json,'$.disposition')
                    FROM research_task_finding_dispositions d WHERE d.finding_id=f.id ORDER BY d.sequence DESC LIMIT 1),'open')=?6)
             ORDER BY f.sequence LIMIT ?7"
        ).and_then(|mut statement| statement.query_map(params![task_id,generation as i64,query.after_sequence as i64,query.file,query.rule,disposition,(limit+1) as i64], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()).map_err(store_error)?;
        let has_more = rows.len() > limit;
        let runs = super::runs::runs_on(&transaction, task_id)?;
        let mut findings = Vec::new();
        for (sequence, json) in rows.into_iter().take(limit) {
            let finding: ReviewFinding = decode_json(&json, "review finding")?;
            let history_count: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM research_task_finding_dispositions WHERE finding_id=?1",
                    [&finding.id],
                    |row| row.get(0),
                )
                .map_err(store_error)?;
            let mut history = transaction.prepare("SELECT sequence, decision_json FROM research_task_finding_dispositions WHERE finding_id=?1 ORDER BY sequence DESC LIMIT 20")
                .and_then(|mut statement| statement.query_map([&finding.id],|row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()).map_err(store_error)?
                .into_iter().map(|(sequence,json)| {
                    let mut record: FindingDispositionRecord=decode_json(&json,"finding disposition")?;
                    record.sequence=sequence as u64;
                    Ok(record)
                }).collect::<Result<Vec<_>,String>>()?;
            history.reverse();
            let (validity, changed_dependencies, unavailable) =
                finding_validity(&task, &finding, &runs);
            findings.push(FindingView {
                sequence: sequence as u64,
                finding,
                validity,
                changed_dependencies,
                unavailable,
                disposition: history
                    .last()
                    .map_or(FindingDisposition::Open, |record| record.disposition),
                history,
                history_count: history_count as u64,
            });
        }
        let mut coverage_gaps = vec![
            "findings.only_numeric_checker".into(),
            "findings.model_reviewer_not_run".into(),
            "findings.current_task_workspace_only".into(),
        ];
        if task.evidence.as_ref().is_some_and(|report| {
            report.checks.iter().any(|check| {
                check.id == EvidenceCheckId::Numbers
                    && check.items.iter().any(|item| item.provenance.is_none())
            })
        }) {
            coverage_gaps.push("findings.numeric_items_without_source".into());
        }
        if findings
            .iter()
            .any(|view| view.history_count > view.history.len() as u64)
        {
            coverage_gaps.push("findings.history_shortened".into());
        }
        Ok(FindingPage {
            task_id: task_id.into(),
            execution_generation: generation,
            next_sequence: findings
                .last()
                .map_or(query.after_sequence, |view| view.sequence),
            findings,
            has_more,
            coverage_gaps,
        })
    }

    pub fn decide_finding(
        &self,
        project: &str,
        task_id: &str,
        generation: u64,
        id: &str,
        decision: &FindingDecision,
    ) -> Result<(), String> {
        let rationale = decision.rationale.trim();
        if rationale.is_empty() || rationale.chars().count() > 2000 {
            return Err("Give a disposition reason of 1–2000 characters.".into());
        }
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        bound_task(&transaction, project, task_id, generation)?;
        load_finding(&transaction, task_id, generation, id)?;
        let record = FindingDispositionRecord {
            sequence: 0,
            disposition: decision.disposition,
            rationale: rationale.into(),
            actor: "operator".into(),
            source: "task_detail".into(),
            created_at: now_ms(),
        };
        transaction.execute("INSERT INTO research_task_finding_dispositions (finding_id,decision_json) VALUES (?1,?2)",params![id,encode_json(&record)?]).map_err(store_error)?;
        transaction
            .execute(
                "UPDATE research_tasks SET updated_at=?2 WHERE id=?1",
                params![task_id, now_ms()],
            )
            .map_err(store_error)?;
        transaction.commit().map_err(store_error)
    }

    pub fn finding_source(
        &self,
        project: &str,
        task_id: &str,
        generation: u64,
        id: &str,
    ) -> Result<FindingSource, String> {
        let mut connection = self.open()?;
        let transaction = connection.transaction().map_err(store_error)?;
        bound_task(&transaction, project, task_id, generation)?;
        let finding = load_finding(&transaction, task_id, generation, id)?;
        let source = finding
            .item
            .provenance
            .ok_or("This finding has no verified source.")?
            .source;
        if content_hash(source.quote.as_bytes()) != source.quote_sha256 {
            return Err("The retained finding quote failed its integrity check.".into());
        }
        Ok(source)
    }
}

fn finding_validity(
    task: &ResearchTask,
    finding: &ReviewFinding,
    runs: &[crate::model::RunRecord],
) -> (FindingValidity, Vec<DependencyChange>, Vec<String>) {
    let basis = finding
        .item
        .provenance
        .as_ref()
        .expect("retained findings have provenance");
    let mut changed = Vec::new();
    let mut unavailable = Vec::new();
    if basis.rule_version != NUMBER_RULE_VERSION {
        changed.push(DependencyChange {
            dependency: "rule".into(),
            expected: basis.rule_version.clone(),
            actual: Some(NUMBER_RULE_VERSION.into()),
        });
    }
    let actual_run = run_basis_hash(runs.iter().find(|run| run.run_id == basis.run_id));
    if actual_run != basis.run_sha256 {
        changed.push(DependencyChange {
            dependency: format!("run:{}", basis.run_id),
            expected: basis.run_sha256.clone(),
            actual: Some(actual_run),
        });
    }
    if let Some(isolation) = &task.isolation {
        let root = std::path::Path::new(&isolation.execution_root);
        match TaskFiles::open(root, &isolation.allowed_paths).and_then(|files| {
            if files.exists(&basis.source.path)? {
                files
                    .read_bytes(&basis.source.path, 2 * 1024 * 1024)
                    .map(Some)
            } else {
                Ok(None)
            }
        }) {
            Ok(bytes) => {
                let actual = bytes.as_deref().map(content_hash);
                if actual.as_deref() != Some(basis.source.file_sha256.as_str()) {
                    changed.push(DependencyChange {
                        dependency: basis.source.path.clone(),
                        expected: basis.source.file_sha256.clone(),
                        actual,
                    });
                }
            }
            Err(error) => unavailable.push(error),
        }
        match crate::record::read_ledger(root, &task.record_slug) {
            Ok(ledger) => {
                let contains = ledger.iter().any(|row| row.id == basis.run_id);
                if contains != basis.ledger_contains_run {
                    changed.push(DependencyChange {
                        dependency: format!("ledger:{}", basis.run_id),
                        expected: basis.ledger_contains_run.to_string(),
                        actual: Some(contains.to_string()),
                    });
                }
            }
            Err(error) => unavailable.push(error),
        }
    } else {
        unavailable.push("The task workspace is unavailable.".into());
    }
    let validity = if !changed.is_empty() {
        FindingValidity::Stale
    } else if !unavailable.is_empty() {
        FindingValidity::Unknown
    } else {
        FindingValidity::Current
    };
    (validity, changed, unavailable)
}

#[cfg(test)]
#[path = "findings_tests.rs"]
mod tests;
