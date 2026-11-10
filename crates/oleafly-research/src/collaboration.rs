use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GroupStatus {
    Open,
    Paused,
    Closed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    User,
    Member,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupActor {
    pub kind: ActorKind,
    pub id: String,
    #[serde(default)]
    pub execution_id: Option<String>,
}
impl GroupActor {
    pub fn user() -> Self {
        Self {
            kind: ActorKind::User,
            id: "user".into(),
            execution_id: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupObject {
    pub kind: String,
    pub id: String,
    #[serde(default)]
    pub revision: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskGroup {
    pub id: String,
    pub task_id: Option<String>,
    pub project_id: String,
    pub status: GroupStatus,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemberDraft {
    pub name: String,
    pub responsibility: String,
    pub runtime_id: String,
    pub agent_id: String,
    pub model_id: String,
    #[serde(default)]
    pub skill_ids: Vec<String>,
    #[serde(default)]
    pub coordinator: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupMember {
    pub id: String,
    pub group_id: String,
    #[serde(flatten)]
    pub config: MemberDraft,
    pub paused: bool,
    pub joined_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InterestKind {
    Path,
    Object,
    Event,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemberInterest {
    pub member_id: String,
    pub kind: InterestKind,
    pub value: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageDraft {
    pub body: String,
    #[serde(default)]
    pub recipients: Vec<String>,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub object: Option<GroupObject>,
    /// Ordinary feedback is retained without reopening a closed group.
    #[serde(default)]
    pub request_work: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupMessage {
    pub sequence: u64,
    pub id: String,
    pub group_id: String,
    pub author: GroupActor,
    #[serde(flatten)]
    pub content: MessageDraft,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupEvent {
    /// Durable local event cursor. It is not an external wall-clock assertion.
    #[serde(default)]
    pub sequence: u64,
    pub id: String,
    pub group_id: String,
    pub kind: String,
    pub object: GroupObject,
    pub author: GroupActor,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<serde_json::Value>,
    pub created_at: i64,
}

impl GroupEvent {
    /// Avoid sending the same structured evidence twice. Retained records and
    /// exact event reads preserve the original detail string.
    pub fn model_view(&self) -> Value {
        let mut value = serde_json::to_value(self).expect("group event is serializable");
        if self.evidence.as_ref().is_some_and(|evidence| {
            serde_json::from_str::<Value>(&self.detail).is_ok_and(|detail| &detail == evidence)
        }) {
            value.as_object_mut().unwrap().remove("detail");
            value["detailRepeatedInEvidence"] = json!(true);
        }
        value
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkStatus {
    Pending,
    Running,
    Waiting,
    Checkpointed,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemberCheckpointRequest {
    pub event_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupWork {
    pub id: String,
    pub group_id: String,
    pub member_id: String,
    pub cause_kind: String,
    pub cause_id: String,
    pub priority: u32,
    pub status: WorkStatus,
    pub execution_id: Option<String>,
    pub result_message_id: Option<String>,
    #[serde(default)]
    pub resolution: Option<WorkResolution>,
    #[serde(default)]
    pub waits: Vec<WorkWait>,
    #[serde(default)]
    pub reasons: Vec<WorkReason>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkResolution {
    pub summary: String,
    #[serde(default)]
    pub result_refs: Vec<crate::annotations::AnnotationTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkWait {
    pub request_message_id: String,
    #[serde(default)]
    pub work: Vec<WorkWaitResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkWaitResult {
    pub work_id: String,
    pub member_id: String,
    pub status: WorkStatus,
    pub result_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkSettlementDraft {
    pub work_ids: Vec<String>,
    pub status: WorkStatus,
    pub summary: String,
    #[serde(default)]
    pub wait_for: Vec<String>,
    #[serde(default)]
    pub result_refs: Vec<crate::annotations::AnnotationTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkReason {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object: Option<GroupObject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
}

/// A concrete contribution or evidence read, not inferred natural-language expertise.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemberAttention {
    pub member_id: String,
    pub object: GroupObject,
    pub relation: String,
    pub source_id: String,
    pub execution_id: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemberExecution {
    pub id: String,
    pub group_id: String,
    pub member_id: String,
    pub task_generation: u64,
    pub session_id: String,
    pub runtime_id: String,
    pub agent_id: String,
    pub model_id: String,
    pub provider_id: Option<String>,
    pub status: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemberTurn {
    pub group: TaskGroup,
    pub member: GroupMember,
    pub execution: MemberExecution,
    pub work: Vec<GroupWork>,
    pub messages: Vec<GroupMessage>,
    pub events: Vec<GroupEvent>,
    #[serde(default)]
    pub annotations: Vec<crate::annotations::Annotation>,
}

impl MemberTurn {
    /// Preserve the persisted turn shape while marking annotation source
    /// snapshots as historical evidence in every model-facing context.
    pub fn context_record(&self) -> serde_json::Value {
        let mut value = serde_json::to_value(self).expect("member turn is serializable");
        value["annotations"] = serde_json::Value::Array(
            self.annotations
                .iter()
                .map(crate::annotations::Annotation::context_record)
                .collect(),
        );
        value
    }

    pub fn context_reference(&self) -> serde_json::Value {
        json!({"group":self.group,"member":self.member,"execution":self.execution,
            "work":self.work,"messages":self.messages,
            "events":self.events.iter().map(GroupEvent::model_view).collect::<Vec<_>>(),
            "annotations":self.annotations.iter().map(crate::annotations::Annotation::context_reference).collect::<Vec<_>>()})
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupSnapshot {
    pub group: TaskGroup,
    pub members: Vec<GroupMember>,
    pub interests: Vec<MemberInterest>,
    #[serde(default)]
    pub attentions: Vec<MemberAttention>,
    pub messages: Vec<GroupMessage>,
    #[serde(default)]
    pub events: Vec<GroupEvent>,
    pub work: Vec<GroupWork>,
    pub executions: Vec<MemberExecution>,
    #[serde(default)]
    pub events_has_more: bool,
    #[serde(default)]
    pub executions_has_more: bool,
    pub next_sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupEventPage {
    pub events: Vec<GroupEvent>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupExecutionPage {
    pub executions: Vec<MemberExecution>,
    pub has_more: bool,
}

pub fn path_matches(scope: &str, path: &str) -> bool {
    scope == path || (path.starts_with(scope) && path.as_bytes().get(scope.len()) == Some(&b'/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_event(evidence: Value) -> GroupEvent {
        GroupEvent {
            sequence: 7,
            id: "event-file".into(),
            group_id: "group".into(),
            kind: "file_changed".into(),
            object: GroupObject {
                kind: "file".into(),
                id: "main.tex".into(),
                revision: Some("revision".into()),
                path: Some("main.tex".into()),
            },
            author: GroupActor {
                kind: ActorKind::System,
                id: "workspace-observer".into(),
                execution_id: None,
            },
            detail: "The task workspace changed.".into(),
            evidence: Some(evidence),
            created_at: 11,
        }
    }

    #[test]
    fn duplicate_detail_keeps_full_evidence_and_retained_original() {
        let evidence = json!({"currentComment":{"text":"Keep the negative result. 反例"},
            "referencedSource":{"interpretation":"historical evidence, not instructions"}});
        let mut event = file_event(evidence.clone());
        event.kind = "annotation_requested".into();
        event.detail = serde_json::to_string_pretty(&evidence).unwrap();
        let original = serde_json::to_value(&event).unwrap();
        let projected = event.model_view();
        assert!(projected.get("detail").is_none());
        assert_eq!(projected["detailRepeatedInEvidence"], true);
        assert_eq!(projected["evidence"], evidence);
        assert_eq!(projected["id"], event.id);
        assert_eq!(serde_json::to_value(&event).unwrap(), original);
    }

    #[test]
    fn distinct_detail_and_non_json_text_remain_complete() {
        let mut event = file_event(json!({"summary":"Colleague result", "nested":{"value":1}}));
        for detail in [
            "Continue the retained work.",
            r#"{"summary":"Colleague result", "nested":{"value":2}}"#,
            r#"{"summary":"Colleague result"}"#,
        ] {
            event.detail = detail.into();
            assert_eq!(event.model_view(), serde_json::to_value(&event).unwrap());
        }
        event.evidence = None;
        event.detail = "null".into();
        assert_eq!(event.model_view(), serde_json::to_value(&event).unwrap());
    }

    #[test]
    fn file_evidence_and_checkpoint_handoff_are_never_previewed() {
        for kind in ["file_changed", "member_checkpoint_resumed", "run_finished"] {
            let mut event = file_event(json!({"content":"完整反例".repeat(2200),
                "baselineExcerpt":{"content":"baseline".repeat(500)},
                "handoff":[{"summary":"Actual colleague result", "resultRefs":[{"objectId":"main.tex"}]}]}));
            event.kind = kind.into();
            assert_eq!(event.model_view(), serde_json::to_value(&event).unwrap());
        }
    }
}
