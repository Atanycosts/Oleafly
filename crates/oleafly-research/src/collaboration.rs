use serde::{Deserialize, Serialize};

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
    pub id: String,
    pub group_id: String,
    pub kind: String,
    pub object: GroupObject,
    pub author: GroupActor,
    pub detail: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkStatus {
    Pending,
    Running,
    Waiting,
    Completed,
    Failed,
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
    pub created_at: i64,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupSnapshot {
    pub group: TaskGroup,
    pub members: Vec<GroupMember>,
    pub interests: Vec<MemberInterest>,
    pub messages: Vec<GroupMessage>,
    pub work: Vec<GroupWork>,
    pub executions: Vec<MemberExecution>,
    pub next_sequence: u64,
}

pub fn path_matches(scope: &str, path: &str) -> bool {
    scope == path || (path.starts_with(scope) && path.as_bytes().get(scope.len()) == Some(&b'/'))
}
