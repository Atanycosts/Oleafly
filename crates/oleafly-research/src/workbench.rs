//! Task-local receipts for records committed by the external Workbench.
//!
//! Workbench remains authoritative for bindings, checks and their applicability.
//! These snapshots record what this task observed; they are not a second domain
//! store or a claim that every external record has been enumerated.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::collaboration::GroupObject;
use crate::observations::content_hash;

pub const CURRENT_SCHEMA_VERSION: &str = "oleafly-workbench-observation-1";

/// Identify checks when the native projection changed solely by their addition
/// or latest-check pointer. Other domain changes keep the system author so an
/// originating member can still receive external work.
pub(crate) fn check_only_current_change(previous: &Value, current: &Value) -> Option<Vec<String>> {
    if previous["schemaVersion"] != CURRENT_SCHEMA_VERSION
        || current["schemaVersion"] != CURRENT_SCHEMA_VERSION
    {
        return None;
    }
    let before = previous["checks"].as_object()?;
    let after = current["checks"].as_object()?;
    if before
        .iter()
        .any(|(id, value)| after.get(id) != Some(value))
    {
        return None;
    }
    let mut added = after
        .iter()
        .filter(|(id, _)| !before.contains_key(*id))
        .map(|(id, check)| {
            (check["checkId"].as_str() == Some(id.as_str())
                && check["dispositionIds"].as_array()?.is_empty())
            .then(|| id.clone())
        })
        .collect::<Option<Vec<_>>>()?;
    let latest_before = previous["project"].get("latestCheck")?;
    let latest_after = current["project"].get("latestCheck")?;
    if latest_before != latest_after {
        let id = latest_after["checkId"].as_str()?;
        if after.get(id) != Some(latest_after) {
            return None;
        }
        // /state and /history are separate reads. A check can already be in
        // the retained checks map before the latest-check pointer catches up.
        if !added.iter().any(|added| added == id) {
            added.push(id.into());
        }
    }
    if added.is_empty() {
        return None;
    }
    let mut previous = previous.clone();
    let mut current = current.clone();
    previous.as_object_mut()?.remove("checks");
    current.as_object_mut()?.remove("checks");
    previous["project"].as_object_mut()?.remove("latestCheck");
    current["project"].as_object_mut()?.remove("latestCheck");
    (previous == current).then_some(added)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchScope {
    /// The canonical library root retained by the task's application input.
    pub library_root: String,
    /// The retained Workbench manuscript identity, not the Oleafly project ID.
    pub project_id: String,
}

impl WorkbenchScope {
    /// Stable object identity shared by the application and event subscribers.
    pub fn object_id(&self) -> String {
        content_hash(format!("{}\0{}", self.library_root, self.project_id).as_bytes())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum WorkbenchRecordEvent {
    #[serde(rename = "workbench_record_committed")]
    RecordCommitted,
    #[serde(rename = "workbench_update_available")]
    UpdateAvailable,
}

impl WorkbenchRecordEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RecordCommitted => "workbench_record_committed",
            Self::UpdateAvailable => "workbench_update_available",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommittedWorkbenchRecord {
    pub kind: String,
    pub record_id: String,
    /// An immutable record revision or payload hash supplied by Workbench.
    pub revision: String,
    pub object: GroupObject,
    pub event_kind: WorkbenchRecordEvent,
    /// A bounded immutable payload projection. Derived current validity belongs
    /// in the separate current snapshot, not under this immutable identity.
    pub snapshot: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchRecordReceipt {
    /// Local durable query cursor; never an external commit-order assertion.
    pub sequence: u64,
    #[serde(flatten)]
    pub record: CommittedWorkbenchRecord,
    pub snapshot_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchCurrent {
    /// Local successful snapshot changes, independent of external revisions.
    pub observation_sequence: u64,
    pub snapshot: Value,
    pub snapshot_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkbenchContext {
    pub task_id: String,
    pub scope: Option<WorkbenchScope>,
    pub records: Vec<WorkbenchRecordReceipt>,
    /// Last successful Workbench projection. Oleafly does not infer validity or
    /// LaTeX applicability from a DOCX check or from a newly available world.
    pub current: Option<WorkbenchCurrent>,
    pub next_sequence: u64,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchReconcileSummary {
    pub recorded: usize,
    pub duplicates: usize,
    pub current_changed: bool,
    pub routed_members: Vec<String>,
    pub next_sequence: u64,
}
