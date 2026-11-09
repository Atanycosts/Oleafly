//! Version-bound findings from the existing evidence checkers. Disposition is
//! independent of both the recorded verdict and current dependency validity.
use serde::{Deserialize, Serialize};

use crate::model::{EvidenceItem, RunRecord};
use crate::observations::content_hash;

pub const NUMBER_RULE_VERSION: &str = "numbers-1";

pub fn run_basis_hash(run: Option<&RunRecord>) -> String {
    content_hash(
        &serde_json::to_vec(&run.map(|run| (&run.command, &run.metrics, run.state, run.exit_code)))
            .expect("run evidence is serializable"),
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckProvenance {
    pub rule_version: String,
    pub source: FindingSource,
    pub run_id: String,
    pub run_sha256: String,
    pub ledger_contains_run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindingSource {
    pub path: String,
    pub file_sha256: String,
    pub line_start: u32,
    pub line_end: u32,
    pub quote: String,
    pub quote_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFinding {
    pub id: String,
    pub task_id: String,
    pub execution_generation: u64,
    pub origin: String,
    pub verdict: String,
    pub severity: String,
    pub item: EvidenceItem,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FindingDisposition {
    #[default]
    Open,
    Accepted,
    Rejected,
    Deferred,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FindingDecision {
    pub disposition: FindingDisposition,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindingDispositionRecord {
    pub sequence: u64,
    pub disposition: FindingDisposition,
    pub rationale: String,
    pub actor: String,
    pub source: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FindingValidity {
    Current,
    Stale,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DependencyChange {
    pub dependency: String,
    pub expected: String,
    pub actual: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindingView {
    pub sequence: u64,
    pub finding: ReviewFinding,
    pub validity: FindingValidity,
    pub changed_dependencies: Vec<DependencyChange>,
    pub unavailable: Vec<String>,
    pub disposition: FindingDisposition,
    pub history: Vec<FindingDispositionRecord>,
    pub history_count: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct FindingQuery {
    #[serde(default)]
    pub after_sequence: u64,
    pub limit: Option<usize>,
    pub file: Option<String>,
    pub rule: Option<String>,
    pub disposition: Option<FindingDisposition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindingPage {
    pub task_id: String,
    pub execution_generation: u64,
    pub findings: Vec<FindingView>,
    pub next_sequence: u64,
    pub has_more: bool,
    pub coverage_gaps: Vec<String>,
}
