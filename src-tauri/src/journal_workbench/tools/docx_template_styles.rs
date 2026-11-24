use oleafly_research::mcp::protocol::{ToolAnnotations, ToolMeta};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::journal_workbench::{request, JournalWorkbenchState};

use super::{bounded_read_json_with_tool, schema};

pub(crate) const TOOL: &str = "read_docx_template_styles";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TemplateStyleQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    heading_level: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    style_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_binding_id: Option<String>,
    #[serde(skip_serializing)]
    json_offset: Option<usize>,
    #[serde(skip_serializing)]
    json_limit: Option<usize>,
    #[serde(skip_serializing)]
    expected_json_sha256: Option<String>,
}

pub(crate) fn task_definition() -> ToolMeta {
    let mut definition = ToolMeta::new(
        TOOL,
        "Read structured style parameters from the actual current journal template binding of this task's bound Word manuscript. Use role (e.g. body, heading, caption), one-based heading_level, or an exact template style_id to narrow the result. Distinguish declared/computed styles from effective sample formatting; competing values are not one rule. These are template facts, not formal journal requirements. Follow nextRead or continuation as returned. No rebinding, editing, style import or check runs.",
        schema(json!({
            "session_id":{"type":"string","minLength":1},
            "role":{"type":"string","minLength":1},
            "heading_level":{"type":"integer","minimum":1,"maximum":9},
            "style_id":{"type":"string","minLength":1},
            "offset":{"type":"integer","minimum":0},
            "limit":{"type":"integer","minimum":1,"maximum":50},
            "expected_binding_id":{"type":"string","minLength":1},
            "json_offset":{"type":"integer","minimum":0},
            "json_limit":{"type":"integer","minimum":1,"maximum":12000},
            "expected_json_sha256":{"type":"string","minLength":64,"maxLength":64}
        }), &[]),
    );
    definition.annotations = Some(ToolAnnotations {
        read_only_hint: Some(true),
        ..Default::default()
    });
    definition
}

#[tauri::command]
pub(crate) async fn journal_docx_template_styles_for_agent(
    state: State<'_, JournalWorkbenchState>,
    project_id: String,
    session_id: String,
    query: TemplateStyleQuery,
) -> Result<Value, String> {
    read(&state, &project_id, &session_id, query).await
}

pub(crate) async fn read(
    state: &JournalWorkbenchState,
    project_id: &str,
    session_id: &str,
    query: TemplateStyleQuery,
) -> Result<Value, String> {
    let mut payload = query_payload(project_id, session_id, &query)?;
    let current = state.0.lock().await;
    let session = current.as_ref().ok_or("Connect Workbench first.")?;
    let result = request(session, "/api/docx-query", Some(payload.clone())).await?;
    let fields = payload
        .as_object_mut()
        .expect("Style query payload is an object");
    fields.remove("target");
    fields.remove("operation");
    payload["session_id"] = json!(session_id);
    finish_page(result, project_id, payload, &query)
}

fn query_payload(
    project_id: &str,
    session_id: &str,
    query: &TemplateStyleQuery,
) -> Result<Value, String> {
    if query
        .session_id
        .as_deref()
        .is_some_and(|id| id != session_id)
    {
        return Err("The style query belongs to another Word session.".into());
    }
    let mut payload = serde_json::to_value(query).map_err(|error| error.to_string())?;
    payload
        .as_object_mut()
        .expect("Style query is an object")
        .remove("session_id");
    payload["target"] = json!({"project_id":project_id});
    payload["operation"] = json!("template_styles");
    Ok(payload)
}

fn finish_page(
    mut result: Value,
    project_id: &str,
    mut arguments: Value,
    query: &TemplateStyleQuery,
) -> Result<Value, String> {
    if result["schema_version"] != 1
        || result["operation"] != "template_styles"
        || result["project_id"] != project_id
    {
        return Err("Workbench returned styles outside the bound manuscript query.".into());
    }
    let binding = result["binding"]["binding_id"].as_str();
    if query
        .expected_binding_id
        .as_deref()
        .is_some_and(|expected| Some(expected) != binding)
    {
        return Err(
            "The project template binding changed. Restart the template style query.".into(),
        );
    }
    if let Some(binding) = binding {
        arguments["expected_binding_id"] = json!(binding);
    }
    result["nextRead"] = result["next_offset"]
        .as_u64()
        .map_or(Value::Null, |offset| {
            let mut next = arguments.clone();
            next["offset"] = json!(offset);
            json!({"tool":TOOL,"arguments":next})
        });
    bounded_read_json_with_tool(
        (TOOL, "template_styles"),
        result,
        arguments,
        query.json_offset,
        query.json_limit,
        None,
        query.expected_json_sha256.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn style_query_uses_only_the_host_manuscript_and_pins_the_returned_binding() {
        let arguments = json!({"session_id":"word-a","role":"heading","heading_level":2,"limit":1});
        let query = serde_json::from_value(arguments.clone()).unwrap();
        assert!(query_payload("paper", "word-b", &query).is_err());
        assert!(serde_json::from_value::<TemplateStyleQuery>(
            json!({"world_version_id":"some-other-world"})
        )
        .is_err());
        assert_eq!(
            query_payload("paper", "word-a", &query).unwrap(),
            json!({
                "target":{"project_id":"paper"}, "operation":"template_styles",
                "role":"heading", "heading_level":2, "limit":1,
            })
        );
        let response = json!({"schema_version":1,"operation":"template_styles","project_id":"paper",
            "status":"available","binding":{"binding_id":"binding-a","world_version_id":"world-a"},
            "styles":[{"style_id":"HeadingTwo"}],"next_offset":1});
        assert!(finish_page(response.clone(), "another-paper", arguments.clone(), &query).is_err());
        let first = finish_page(response.clone(), "paper", arguments, &query).unwrap();
        let next = &first["nextRead"]["arguments"];
        assert_eq!(first["nextRead"]["tool"], TOOL);
        assert_eq!(
            next,
            &json!({"session_id":"word-a","role":"heading","heading_level":2,
            "limit":1,"offset":1,"expected_binding_id":"binding-a"})
        );
        let continued = serde_json::from_value(next.clone()).unwrap();
        let mut rebound = response;
        rebound["binding"]["binding_id"] = json!("binding-b");
        assert!(finish_page(rebound, "paper", next.clone(), &continued).is_err());
        assert_eq!(
            task_definition().annotations.unwrap().read_only_hint,
            Some(true)
        );
    }

    #[test]
    fn serialized_style_fragments_are_also_pinned_to_the_query_and_binding() {
        let first_args = json!({"session_id":"word-a","style_id":"Body","json_limit":200});
        let query: TemplateStyleQuery = serde_json::from_value(first_args).unwrap();
        let arguments = serde_json::to_value(&query).unwrap();
        let response = json!({"schema_version":1,"operation":"template_styles","project_id":"paper",
            "binding":{"binding_id":"binding-a"},"styles":[{"declared":"Style".repeat(300)}],"next_offset":null});
        let first = finish_page(response.clone(), "paper", arguments, &query).unwrap();
        let next: TemplateStyleQuery =
            serde_json::from_value(first["continuation"]["arguments"].clone()).unwrap();
        assert_eq!(next.expected_binding_id.as_deref(), Some("binding-a"));
        assert_eq!(next.json_offset, Some(200));
        let next_args = serde_json::to_value(&next).unwrap();
        let second = finish_page(response, "paper", next_args, &next).unwrap();
        assert_eq!(second["json_sha256"], first["json_sha256"]);
        assert_eq!(second["json_offset"], 200);
    }
}
