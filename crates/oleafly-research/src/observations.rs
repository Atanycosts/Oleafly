//! Compact, retained facts in the existing task event stream. Unlike transcript
//! text these rows are immutable and are never shortened by transcript retention.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::model::{
    EvidenceReport, ResearchTaskStatus, TaskFileChange, TaskIsolationSummary, TaskTranscriptEvent,
};

pub fn content_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Clone, Default)]
pub struct TaskSkills {
    pub prompt: String,
    pub injected: Vec<InjectedSkill>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InjectedSkill {
    pub id: String,
    /// Hash of the exact section inserted into this task's prompt.
    pub section_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProvidedTool {
    pub name: String,
    pub source: String,
    pub schema_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TaskObservation {
    Member {
        member_id: String,
        execution_id: String,
        trigger_ids: Vec<String>,
        status: String,
    },
    RequestContext {
        session_id: String,
        tools: Vec<ProvidedTool>,
        schema_bytes: u64,
        catalog_bytes: u64,
        skill_bytes: u64,
        requirement_ids: Vec<String>,
    },
    ToolRequested {
        call_id: String,
        name: String,
        input_sha256: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        actor: Option<String>,
    },
    Runtime {
        runtime_id: String,
        provider_id: String,
        model_id: String,
        session_id: String,
        tools: Vec<ProvidedTool>,
        declared_skills: Vec<String>,
        injected_skills: Vec<InjectedSkill>,
        unavailable: Vec<String>,
    },
    ToolExecution {
        call_id: String,
        name: String,
        status: String,
        input_sha256: String,
        output_sha256: String,
        skill_id: Option<String>,
        skill_instructions_sha256: Option<String>,
        source: Option<ReadSource>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        actor: Option<String>,
    },
    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadSource {
    pub path: String,
    pub file_sha256: String,
    pub offset: usize,
    pub end_offset: usize,
    pub truncated: bool,
    /// Whether exact file bytes were retained in TaskStore when this read completed.
    #[serde(default)]
    pub snapshot_retained: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf: Option<Box<PdfReadSource>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PdfReadSource {
    pub path: String,
    pub sha256: String,
    pub page_count: usize,
    pub page_start: Option<usize>,
    pub page_end: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskObservationSummary {
    pub task_id: String,
    pub project_id: String,
    pub execution_generation: u64,
    pub status: ResearchTaskStatus,
    pub goal: String,
    pub success_criteria: Vec<String>,
    pub runtime: Option<TaskTranscriptEvent>,
    pub usage: Option<TaskTranscriptEvent>,
    pub baseline: Option<TaskIsolationSummary>,
    pub changed_files: Vec<TaskFileChange>,
    pub changed_file_count: usize,
    pub evidence: Option<EvidenceReport>,
    pub coverage_gaps: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskObservationPage {
    pub events: Vec<TaskTranscriptEvent>,
    /// Cursor for the next query, including when this committed page is empty.
    pub next_sequence: u64,
    pub through_sequence: u64,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskObservationView {
    pub summary: TaskObservationSummary,
    pub page: TaskObservationPage,
}
