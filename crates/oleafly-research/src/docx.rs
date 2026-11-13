//! Retained activity for explicitly bound DOCX working copies. These records
//! describe application operations; they do not authorize editing or saving.
use serde::{Deserialize, Serialize};

pub const MAX_DOCX_READ_PARAGRAPHS: usize = 50;
pub const MAX_DOCX_TEXT_BYTES: usize = 32 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxDocumentIdentity {
    pub session_id: String,
    pub app_project_id: String,
    pub workbench_project_id: String,
    pub baseline_id: String,
    pub source_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub session_revision: u64,
    /// Recovery sessions use -1 until their first successful baseline save.
    pub saved_revision: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxParagraph {
    pub paragraph_ref: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub para_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxTarget {
    pub target_id: String,
    pub paragraph_ref: String,
    pub revision: u64,
    pub original: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub para_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structure: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DocxRuntimeEvent {
    /// Created only by bind_docx_task before the task's first execution.
    Bound,
    Read {
        offset: usize,
        paragraphs: Vec<DocxParagraph>,
    },
    Captured {
        target: DocxTarget,
    },
    Proposed {
        target: DocxTarget,
        proposed: String,
    },
}

/// Only known application results belong here. Errors and unknown outcomes
/// must not be converted into one of these successful business receipts.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DocxProposalOutcome {
    Applied,
    Rejected,
    Withdrawn,
    Recovered {
        recovery_key: String,
        content_sha256: String,
        from_document: Box<DocxDocumentIdentity>,
    },
    Saved {
        request_id: String,
        content_sha256: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocxActivityOrigin {
    pub task_id: String,
    pub generation: u64,
    pub group_id: Option<String>,
    pub member_id: Option<String>,
    pub execution_id: Option<String>,
    /// Running work claimed by this execution at the time of the operation.
    /// This is context, not a claim that every item caused the operation.
    pub work_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DocxActivityEvent {
    Runtime { event: DocxRuntimeEvent },
    Outcome { outcome: DocxProposalOutcome },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocxActivity {
    /// Backend-owned identity; a Proposed activity's ID is its proposal ID.
    pub id: String,
    pub origin: DocxActivityOrigin,
    pub document: DocxDocumentIdentity,
    pub proposal_id: Option<String>,
    pub event: DocxActivityEvent,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocxActivityEntry {
    pub cursor: u64,
    pub activity: DocxActivity,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocxActivityPage {
    pub activities: Vec<DocxActivityEntry>,
    pub next_cursor: u64,
    pub has_more: bool,
}
