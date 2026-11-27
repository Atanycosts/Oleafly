use super::*;

fn arguments(collection: &str) -> Value {
    json!({
        "operation":"format", "format_operation":"snapshot", "detail":"effective",
        "world_version_id":"template-world", "collection":collection, "offset":0, "limit":50,
    })
}

fn page(collection: &str, items: Value, total: usize) -> Value {
    json!({
        "schema_version":1, "source_sha256":"a".repeat(64),
        "collection":collection, "total":total, "has_more":false, "next_offset":null,
        "snapshot":{
            "schema_version":1, "source_sha256":"a".repeat(64), "method_version":"fixture",
            "engine":{"name":"core","version":"fixture"},
            "parts":[{"part":"/word/document.xml","length":123}],
            "capabilities":{"layout":false},
            "unsupported":[{"code":"structural_only","object_ids":["shape"]}],
            "future_metadata":{"known":null},
            collection:items,
        },
    })
}

fn object(id: &str) -> Value {
    json!({
        "object_id":id, "kind":"paragraph", "part":"/word/document.xml", "path":[0,0,1],
        "text":"全文\t😀\n", "style_id":"Normal", "role":"body",
        "role_basis":[{"source":"context","certainty":"uncertain","value":"mixed"}],
        "region":{"section_object_id":"section-1","role":"mixed","role_basis":[]},
        "evidence":{"paragraph_object_id":"parent", "core_section":{"index":0}},
        "table_context":{"table_object_id":"table-1","row_index":0,"conditions":["firstRow"]},
        "declared":{"pPr":[{"localName":"keepNext"}]},
        "properties":{
            "paragraph":{
                "props":[{"localName":"keepNext"}], "inheritedRunProperties":[{"bold":true}],
                "markRunProperties":[{"fontSize":12}], "tabStopsCacheToken":"cache",
                "keepNext":false, "keepLines":true, "widowControl":null,
                "frame":{"widthPt":42,"heightPt":null}, "tabStops":{"stops":[{"positionPt":24}]},
                "future_property":{"value":false},
            },
            "paragraph_mark":{"bold":false,"fontSizePt":10,"color":null},
            "run":{"fontFamily":"Exact Family","fontSizePt":11,"italic":false},
            "run_properties":[{"localName":"rFonts","attributes":{"ascii":"Exact Family"}}],
            "script_usage":{"latin":true,"east_asian":false,"complex":false,"other":true},
            "table":{"columnWidthsPt":[100,200],"layoutFixed":false},
            "row":{"cantSplit":false,"height":null},
            "cell":{"gridSpan":2,"margins":{"left":0},"vAlign":"center"},
            "table_style":{"paragraphProperties":[],"paragraphPropertyNodes":[],"runProperties":[]},
            "section":{"landscape":false,"margins":{"left":72}},
        },
        "future_object_field":{"value":null},
    })
}

// The decoder checks reference presence and range; absence never becomes a successful empty value.
fn decode(output: &Value) -> Result<Vec<Value>, String> {
    let collection = text(output, "collection")?;
    output["snapshot"][collection]
        .as_array()
        .ok_or("Missing records")?
        .iter()
        .map(|item| {
            let mut item = item.clone();
            for field in ["properties", "region", "evidence", "role_basis"] {
                let reference = format!("{field}_ref");
                let Some(index) = item.get(&reference) else {
                    continue;
                };
                let index = index.as_u64().ok_or("Invalid dictionary reference")? as usize;
                let value = output["snapshot"]["shared"][field]
                    .as_array()
                    .and_then(|values| values.get(index))
                    .ok_or("Missing dictionary value")?
                    .clone();
                item.as_object_mut().unwrap().remove(&reference);
                item[field] = value;
            }
            Ok(item)
        })
        .collect()
}

fn retained_format_output(value: &Value) -> String {
    // Independently follow the actual MCP payload and builtin event path, including text escaping.
    let envelope = serde_json::to_string(&json!({
        "content":[{"type":"text","text":serde_json::to_string(value).unwrap()}],
        "isError":false,
    }))
    .unwrap();
    assert!(envelope.len() <= MAX_OUTPUT_BYTES);
    assert_eq!(format_mcp_output_bytes(value).unwrap(), envelope.len());
    let event = oleafly_research::builtin::builtin_event(oleafly_agent::AgentEvent::ToolOutcome {
        id: "format-read".into(),
        output: envelope.clone(),
    })
    .unwrap();
    let oleafly_research::model::TaskRuntimeEvent::Tool { detail, status, .. } = event else {
        panic!("Expected retained tool result");
    };
    assert_eq!(detail, envelope);
    assert_eq!(status.as_deref(), Some("done"));
    let retained: Value = serde_json::from_str(&detail).unwrap();
    let decoded: Value =
        serde_json::from_str(retained["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(&decoded, value);
    detail
}

#[test]
fn oversized_check_objects_keep_every_fact_through_retained_mcp_continuations() {
    let original = json!({
        "reference":{"kind":"check","objectId":"check-a","worldVersionId":"world-a"},
        "target":{"objectKind":"journal_check","objectRevision":"check-a"},
        "sourceRole":"retained_reference_data",
        "object":context::check_object(json!({
            "check_id":"check-a", "baseline_id":"baseline-a", "world_version_id":"world-a",
            "summary":{"cannot_determine":3},
            "rule_results":[{"verdict":"cannot_determine","explanation":"中文\"\\\n😀".repeat(8_000)}],
            "coverage_gaps":[{"code":"unresolved","locator":"/word/document.xml#0"}],
            "limitations":["Requires review"], "future_field":{"value":false},
            "template_comparison":{
                "total":12_345,"findings":[{"text":"Retained elsewhere"}],
                "unsupported":[{"object_ids":vec!["/word/document.xml#0"; 2_000]}],
                "finding_summary":{"cannot_determine":12_345}
            }
        }))
    });
    assert!(format_mcp_output_bytes(&original).unwrap() > MAX_OUTPUT_BYTES);
    let mut arguments = json!({
        "operation":"object","kind":"check","object_id":"check-a","world_version_id":"world-a"
    });
    let mut assembled = String::new();
    let mut previous_offset = 0;
    loop {
        let ReadQuery::Object {
            json_offset,
            json_limit,
            expected_json_sha256,
            ..
        } = serde_json::from_value(arguments.clone()).unwrap()
        else {
            panic!("Expected exact object continuation");
        };
        let output = bounded_read_json(
            original.clone(),
            arguments.clone(),
            json_offset,
            json_limit,
            None,
            expected_json_sha256.as_deref(),
        )
        .unwrap();
        retained_format_output(&output);
        assert_eq!(output["operation"], "object");
        assert_eq!(output["projection"], "json_fragment");
        assert_eq!(output["json_offset"], previous_offset);
        assert!(output.get("source_sha256").is_none());
        assembled.push_str(output["json"].as_str().unwrap());
        if output["continuation"].is_null() {
            break;
        }
        arguments = output["continuation"]["arguments"].clone();
        assert_eq!(arguments["object_id"], "check-a");
        assert_eq!(arguments["world_version_id"], "world-a");
        assert!(arguments.get("expected_source_sha256").is_none());
        let offset = arguments["json_offset"].as_u64().unwrap() as usize;
        assert!(offset > previous_offset);
        assert_eq!(offset, assembled.chars().count());
        previous_offset = offset;
    }
    assert_eq!(serde_json::from_str::<Value>(&assembled).unwrap(), original);
    let mut changed = original.clone();
    changed["object"]["summary"]["cannot_determine"] = json!(4);
    assert!(bounded_read_json(
        changed,
        arguments.clone(),
        Some(1),
        None,
        None,
        arguments["expected_json_sha256"].as_str(),
    )
    .unwrap_err()
    .contains("response changed"));
    assert!(bounded_read_json(original, arguments, Some(1), None, None, None).is_err());
}

#[test]
fn small_object_reads_preserve_the_existing_response_and_typed_boundary() {
    let object = json!({"object":{"check_id":"check-a","summary":{"cannot_determine":1}}});
    let args = json!({"operation":"object","kind":"check","object_id":"check-a"});
    let output = bounded_read_json(object.clone(), args.clone(), None, None, None, None).unwrap();
    assert_eq!(output, object);
    retained_format_output(&output);
    let mut continuation = args;
    continuation["json_offset"] = json!(3);
    continuation["json_limit"] = json!(12_000);
    continuation["expected_json_sha256"] = json!("a".repeat(64));
    assert!(serde_json::from_value::<ReadQuery>(continuation.clone()).is_ok());
    continuation["baseline_id"] = json!("forged");
    assert!(serde_json::from_value::<ReadQuery>(continuation).is_err());
}

#[test]
#[ignore = "Set OLEAFLY_OBJECT_READ_FIXTURE and OLEAFLY_OBJECT_READ_OUTPUT for a local check probe"]
fn object_read_real_fixture_probe() {
    let fixture = std::env::var_os("OLEAFLY_OBJECT_READ_FIXTURE").expect("Object response fixture");
    let output = std::path::PathBuf::from(
        std::env::var_os("OLEAFLY_OBJECT_READ_OUTPUT").expect("Probe output directory"),
    );
    let original: Value = serde_json::from_slice(&std::fs::read(fixture).unwrap()).unwrap();
    let mut response = original.clone();
    response["object"] = context::check_object(response["object"].take());
    std::fs::create_dir_all(&output).unwrap();
    std::fs::write(
        output.join("expected.json"),
        serde_json::to_vec(&response).unwrap(),
    )
    .unwrap();
    let mut arguments = json!({
        "operation":"object","kind":response["reference"]["kind"],
        "object_id":response["reference"]["objectId"],
        "world_version_id":response["reference"]["worldVersionId"],
    });
    for index in 0.. {
        let ReadQuery::Object {
            json_offset,
            json_limit,
            expected_json_sha256,
            ..
        } = serde_json::from_value(arguments.clone()).unwrap()
        else {
            panic!("Expected object read")
        };
        let fragment = bounded_read_json(
            response.clone(),
            arguments.clone(),
            json_offset,
            json_limit,
            None,
            expected_json_sha256.as_deref(),
        )
        .unwrap();
        let envelope = retained_format_output(&fragment);
        std::fs::write(output.join(format!("mcp-{index:03}.json")), envelope).unwrap();
        if fragment["continuation"].is_null() {
            break;
        }
        arguments = fragment["continuation"]["arguments"].clone();
    }
}

#[test]
fn format_mcp_pages_budget_escaped_envelopes_for_full_and_effective() {
    let records: Vec<Value> = (0..4)
        .map(|index| {
            json!({
                "object_id":format!("record-{index}"), "kind":"paragraph", "role":"body",
                "part":"/word/document.xml", "path":[0,0,index],
                "text":"\"\\\n😀中文".repeat(600),
                "properties":{"run":{"bold":false,"fontFamily":"Exact \"Quoted\" Family"}},
                "region":{"role":"mixed"}, "role_basis":[], "evidence":{"parent":"paragraph"},
                "declared":{"local_name":"p"},
            })
        })
        .collect();
    let source = page("objects", json!(records), 4);
    for detail in [FormatDetail::Full, FormatDetail::Effective] {
        let args = arguments("objects");
        let unbounded = if detail == FormatDetail::Full {
            source.clone()
        } else {
            project_effective_snapshot_page(source.clone(), 0, &args).unwrap()
        };
        assert!(serde_json::to_vec(&unbounded).unwrap().len() <= MAX_OUTPUT_BYTES);
        assert!(format_mcp_output_bytes(&unbounded).unwrap() > MAX_OUTPUT_BYTES);
        let output = format_snapshot_page(source.clone(), 0, detail, &args).unwrap();
        let count = output["snapshot"]["objects"].as_array().unwrap().len();
        assert!((1..4).contains(&count));
        assert_eq!(output["has_more"], true);
        assert_eq!(output["next_offset"], count);
        retained_format_output(&output);
        let delivered = if detail == FormatDetail::Full {
            output["snapshot"]["objects"].as_array().unwrap().clone()
        } else {
            assert_eq!(output["delivered"], count);
            assert_eq!(output["full_read"]["end_offset"], count);
            decode(&output).unwrap()
        };
        for (index, record) in delivered.iter().enumerate() {
            assert_eq!(
                record["object_id"],
                source["snapshot"]["objects"][index]["object_id"]
            );
            assert_eq!(record["text"], source["snapshot"]["objects"][index]["text"]);
        }
    }
}

#[test]
fn format_mcp_direct_result_respects_exact_envelope_limit() {
    let mut source = json!({"source_sha256":"a".repeat(64),"relationships":[{"target":""}]});
    let padding = MAX_OUTPUT_BYTES - format_mcp_output_bytes(&source).unwrap();
    source["relationships"][0]["target"] = json!("a".repeat(padding));
    assert_eq!(format_mcp_output_bytes(&source).unwrap(), MAX_OUTPUT_BYTES);
    let args =
        json!({"operation":"format","format_operation":"relationships","offset":0,"limit":1});
    let output = bounded_read_json(source.clone(), args.clone(), None, None, None, None).unwrap();
    assert_eq!(output, source);
    assert_eq!(retained_format_output(&output).len(), MAX_OUTPUT_BYTES);
    source["relationships"][0]["target"] = json!("a".repeat(padding + 1));
    assert_eq!(
        format_mcp_output_bytes(&source).unwrap(),
        MAX_OUTPUT_BYTES + 1
    );
    let output = bounded_read_json(source, args, None, None, None, None).unwrap();
    assert_eq!(output["projection"], "json_fragment");
    retained_format_output(&output);
}

#[test]
fn format_mcp_quote_heavy_fragments_reassemble_from_builtin_receipts() {
    let text = format!("{}\n😀中文", "\"\\".repeat(10_000));
    for (operation, mut source) in [
        (
            "snapshot",
            json!({"collection":"objects","snapshot":{"objects":[{"object_id":"large","text":text}]},"total":1,"has_more":false,"next_offset":null}),
        ),
        ("nodes", json!({"nodes":[{"text":text}]})),
        ("relationships", json!({"relationships":[{"target":text}]})),
        (
            "part",
            json!({"part":"/word/document.xml","content_base64":text}),
        ),
    ] {
        source["source_sha256"] = json!("a".repeat(64));
        assert!(serde_json::to_vec(&source).unwrap().len() <= MAX_OUTPUT_BYTES);
        assert!(format_mcp_output_bytes(&source).unwrap() > MAX_OUTPUT_BYTES);
        let args = json!({
            "operation":"format","format_operation":operation,"offset":0,"limit":1,
            "world_version_id":"template-identity-".repeat(64),
        });
        let mut offset = None;
        let mut source_hash = None;
        let mut json_hash = None;
        let mut assembled = String::new();
        loop {
            let output = bounded_read_json(
                source.clone(),
                args.clone(),
                offset,
                None,
                source_hash.as_deref(),
                json_hash.as_deref(),
            )
            .unwrap();
            assert_eq!(output["projection"], "json_fragment");
            if offset.is_none() {
                // This selector makes a 12,000-character fragment exceed the MCP envelope cap.
                assert!(output["json"].as_str().unwrap().chars().count() < 12_000);
            }
            retained_format_output(&output);
            assembled.push_str(output["json"].as_str().unwrap());
            let Some(continuation) = output["continuation"].as_object() else {
                break;
            };
            let next = &continuation["arguments"];
            let next_offset = next["json_offset"].as_u64().unwrap() as usize;
            assert!(next_offset > offset.unwrap_or(0));
            offset = Some(next_offset);
            source_hash = Some(next["expected_source_sha256"].as_str().unwrap().to_owned());
            json_hash = Some(next["expected_json_sha256"].as_str().unwrap().to_owned());
        }
        assert_eq!(serde_json::from_str::<Value>(&assembled).unwrap(), source);
    }
}

#[test]
fn effective_snapshot_preserves_every_retained_value_except_the_six_declared_paths() {
    let original = object("one");
    let mut second = original.clone();
    second["object_id"] = json!("two");
    second["text"] = json!("另一段完整文字");
    let source = page("objects", json!([original, second]), 2);
    let output = format_snapshot_page(
        source.clone(),
        0,
        FormatDetail::Effective,
        &arguments("objects"),
    )
    .unwrap();
    assert_eq!(output["projection"], "effective");
    assert_eq!(output["projection_version"], 1);
    assert_eq!(
        output["omitted_fields"],
        json!([
            "/declared",
            "/properties/paragraph/props",
            "/properties/paragraph/inheritedRunProperties",
            "/properties/paragraph/markRunProperties",
            "/properties/paragraph/tabStopsCacheToken",
            "/properties/run_properties",
        ])
    );
    // An independent expected object lists the entire remaining value tree, including future fields.
    let mut expected = source["snapshot"]["objects"].as_array().unwrap().clone();
    for record in &mut expected {
        record.as_object_mut().unwrap().remove("declared");
        let paragraph = record["properties"]["paragraph"].as_object_mut().unwrap();
        paragraph.remove("props");
        paragraph.remove("inheritedRunProperties");
        paragraph.remove("markRunProperties");
        paragraph.remove("tabStopsCacheToken");
        record["properties"]
            .as_object_mut()
            .unwrap()
            .remove("run_properties");
    }
    assert_eq!(decode(&output).unwrap(), expected);
    for field in ["properties", "region", "evidence", "role_basis"] {
        assert_eq!(
            output["snapshot"]["shared"][field]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(output["snapshot"]["objects"][0][format!("{field}_ref")], 0);
        assert_eq!(output["snapshot"]["objects"][1][format!("{field}_ref")], 0);
    }
    let mut broken = output.clone();
    broken["snapshot"]["shared"]["properties"] = json!([]);
    assert!(decode(&broken).is_err());
    broken = output.clone();
    broken["snapshot"]["objects"][0]["properties_ref"] = json!(null);
    assert!(decode(&broken).is_err());
    assert_eq!(
        source["snapshot"]["objects"][0]["properties"]["paragraph"]["keepNext"],
        false
    );
    assert!(source["snapshot"]["objects"][0].get("declared").is_some());
}

#[test]
fn effective_snapshot_metadata_refs_bind_complete_metadata_and_exact_full_reads() {
    let source = page("objects", json!([object("one")]), 2);
    let first = project_effective_snapshot_page(source.clone(), 0, &arguments("objects")).unwrap();
    let mut args = arguments("objects");
    args["offset"] = json!(1);
    args["json_offset"] = json!(12_000);
    args["json_limit"] = json!(12_000);
    args["expected_json_sha256"] = json!("old-effective-digest");
    let later = project_effective_snapshot_page(source.clone(), 1, &args).unwrap();
    let empty_styles = project_effective_snapshot_page(
        page("style_definitions", json!([]), 0),
        0,
        &arguments("style_definitions"),
    )
    .unwrap();
    let mut metadata = source["snapshot"].clone();
    metadata.as_object_mut().unwrap().remove("objects");
    metadata.sort_all_objects();
    let hash = content_hash(&serde_json::to_vec(&metadata).unwrap());
    assert_eq!(first["metadata_sha256"], hash);
    assert_eq!(later["metadata_sha256"], hash);
    assert_eq!(empty_styles["metadata_sha256"], hash);
    let mut reordered = source.clone();
    let metadata_fields = reordered["snapshot"].as_object_mut().unwrap();
    let engine = metadata_fields.remove("engine").unwrap();
    metadata_fields.insert("engine".into(), engine);
    assert_eq!(
        project_effective_snapshot_page(reordered, 0, &arguments("objects")).unwrap()
            ["metadata_sha256"],
        hash,
    );
    assert!(first.get("metadata_ref").is_none());
    for (key, value) in metadata.as_object().unwrap() {
        assert_eq!(&first["snapshot"][key], value);
        assert!(later["snapshot"].get(key).is_none());
        assert_eq!(&empty_styles["snapshot"][key], value);
    }
    assert_eq!(later["metadata_ref"]["source_sha256"], "a".repeat(64));
    assert_eq!(later["metadata_ref"]["projection"], "effective");
    assert_eq!(later["metadata_ref"]["projection_version"], 1);
    assert_eq!(later["metadata_ref"]["metadata_sha256"], hash);
    let read = &later["metadata_ref"]["read"]["arguments"];
    assert_eq!(read["offset"], 0);
    assert_eq!(read["limit"], 50);
    assert_eq!(read["collection"], "objects");
    assert_eq!(read["detail"], "effective");
    assert!(read.get("expected_json_sha256").is_none());
    let full = &later["full_read"]["arguments"];
    assert_eq!(full["detail"], "full");
    assert_eq!(full["offset"], 1);
    assert_eq!(full["limit"], 1);
    assert_eq!(full["world_version_id"], "template-world");
    assert_eq!(full["expected_source_sha256"], "a".repeat(64));
    assert_eq!(later["full_read"]["end_offset"], 2);
    assert!(full.get("expected_json_sha256").is_none());
    assert!(serde_json::from_value::<ReadQuery>(full.clone()).is_ok());
    assert!(serde_json::from_value::<ReadQuery>(read.clone()).is_ok());
    assert_eq!(empty_styles["delivered"], 0);
    assert_eq!(empty_styles["has_more"], false);
    let mut changed = source;
    changed["snapshot"]["unsupported"][0]["code"] = json!("table_band_size_unsupported");
    assert_ne!(
        project_effective_snapshot_page(changed, 1, &args).unwrap()["metadata_sha256"],
        hash,
    );
}

#[test]
fn effective_snapshot_keeps_declaration_only_styles_explicit_and_full_compatible() {
    let style = json!({
        "object_id":"/word/styles.xml#0.2", "part":"/word/styles.xml", "path":[0,2],
        "style_id":"Numbering", "type":"numbering", "name":"Numbering", "based_on":null,
        "effective_status":"declaration_only", "properties":{"paragraph":{},"run":{}},
        "role":"unknown", "role_basis":[], "declared":{"local_name":"style"},
    });
    let source = page("style_definitions", json!([style.clone()]), 1);
    let output = format_snapshot_page(
        source.clone(),
        0,
        FormatDetail::Effective,
        &arguments("style_definitions"),
    )
    .unwrap();
    let mut expected = style;
    expected.as_object_mut().unwrap().remove("declared");
    assert_eq!(decode(&output).unwrap(), vec![expected]);
    for detail in [None, Some("full")] {
        let mut args = arguments("style_definitions");
        args.as_object_mut().unwrap().remove("detail");
        if let Some(detail) = detail {
            args["detail"] = json!(detail);
        }
        let ReadQuery::Format(query) = serde_json::from_value::<ReadQuery>(args).unwrap() else {
            panic!("Expected format read");
        };
        assert_eq!(query.detail, FormatDetail::Full);
        assert_eq!(
            format_snapshot_page(
                source.clone(),
                0,
                query.detail,
                &arguments("style_definitions")
            )
            .unwrap(),
            bounded_snapshot_page(source.clone(), 0).unwrap()
        );
    }
    let full_hash = content_hash(&serde_json::to_vec(&source).unwrap());
    let effective_hash = content_hash(&serde_json::to_vec(&output).unwrap());
    assert_ne!(full_hash, effective_hash);
    let mut baseline_args = arguments("style_definitions");
    baseline_args
        .as_object_mut()
        .unwrap()
        .remove("world_version_id");
    baseline_args["baseline_id"] = json!("exact-historical-baseline");
    let baseline = project_effective_snapshot_page(source, 1, &baseline_args).unwrap();
    assert_eq!(
        baseline["full_read"]["arguments"]["baseline_id"],
        "exact-historical-baseline"
    );
    assert!(
        serde_json::from_value::<ReadQuery>(baseline["full_read"]["arguments"].clone()).is_ok()
    );
}

#[test]
fn effective_snapshot_trims_actual_records_and_rebuilds_page_local_dictionaries() {
    let records: Vec<Value> = (0..50)
        .map(|index| {
            let mut record = object(&format!("object-{index}"));
            record["text"] = json!("字".repeat(1_000));
            record["properties"]["paragraph"]["future_property"] = json!(index);
            record
        })
        .collect();
    let source = page("objects", json!(records), 50);
    let output = format_snapshot_page(
        source.clone(),
        0,
        FormatDetail::Effective,
        &arguments("objects"),
    )
    .unwrap();
    let count = output["delivered"].as_u64().unwrap() as usize;
    assert!((1..50).contains(&count));
    retained_format_output(&output);
    assert_eq!(output["next_offset"], count);
    assert_eq!(output["full_read"]["end_offset"], count);
    assert_eq!(output["has_more"], true);
    assert_eq!(
        output["snapshot"]["shared"]["properties"]
            .as_array()
            .unwrap()
            .len(),
        count
    );
    for (index, record) in decode(&output).unwrap().iter().enumerate() {
        assert_eq!(record["object_id"], format!("object-{index}"));
        assert_eq!(record["text"], "字".repeat(1_000));
        assert_eq!(record["properties"]["paragraph"]["future_property"], index);
    }
    assert_eq!(source["snapshot"]["objects"].as_array().unwrap().len(), 50);
}

#[test]
fn effective_snapshot_oversized_tables_and_styles_keep_exact_json_continuations() {
    for collection in ["objects", "style_definitions"] {
        let mut record = object("large");
        record["properties"]["table"] = json!({"exact_values":"中文\"\\\n😀".repeat(15_000)});
        if collection == "style_definitions" {
            record["effective_status"] = json!("paragraph_and_run");
        }
        let args = arguments(collection);
        let projected = format_snapshot_page(
            page(collection, json!([record]), 1),
            0,
            FormatDetail::Effective,
            &args,
        )
        .unwrap();
        assert_eq!(projected["delivered"], 1);
        let mut json_offset = None;
        let mut expected_source = None;
        let mut expected_json = None;
        let mut assembled = String::new();
        loop {
            let output = bounded_read_json(
                projected.clone(),
                args.clone(),
                json_offset,
                None,
                expected_source.as_deref(),
                expected_json.as_deref(),
            )
            .unwrap();
            assert_eq!(output["projection"], "json_fragment");
            retained_format_output(&output);
            assembled.push_str(output["json"].as_str().unwrap());
            if output["continuation"].is_null() {
                break;
            }
            let next = &output["continuation"]["arguments"];
            assert_eq!(next["detail"], "effective");
            assert_eq!(next["collection"], collection);
            assert_eq!(next["world_version_id"], "template-world");
            assert!(serde_json::from_value::<ReadQuery>(next.clone()).is_ok());
            json_offset = Some(next["json_offset"].as_u64().unwrap() as usize);
            expected_source = Some(next["expected_source_sha256"].as_str().unwrap().to_owned());
            expected_json = Some(next["expected_json_sha256"].as_str().unwrap().to_owned());
        }
        assert_eq!(
            serde_json::from_str::<Value>(&assembled).unwrap(),
            projected
        );
        assert!(bounded_read_json(
            projected.clone(),
            args.clone(),
            Some(1),
            None,
            Some(&"b".repeat(64)),
            Some(&"b".repeat(64))
        )
        .unwrap_err()
        .contains("source changed"));
        assert!(bounded_read_json(
            projected,
            args,
            Some(1),
            None,
            Some(&"a".repeat(64)),
            Some(&"b".repeat(64))
        )
        .unwrap_err()
        .contains("response changed"));
    }
}

#[test]
#[ignore = "Set OLEAFLY_FORMAT_SNAPSHOT_FIXTURE and OLEAFLY_FORMAT_PROJECTION_OUTPUT for a local JSON probe"]
fn effective_snapshot_real_fixture_probe() {
    let fixture =
        std::env::var_os("OLEAFLY_FORMAT_SNAPSHOT_FIXTURE").expect("Snapshot JSON fixture");
    let output =
        std::env::var_os("OLEAFLY_FORMAT_PROJECTION_OUTPUT").expect("Probe output directory");
    let output = std::path::PathBuf::from(output);
    let snapshot: Value = serde_json::from_slice(&std::fs::read(fixture).unwrap()).unwrap();
    std::fs::create_dir_all(&output).unwrap();
    std::fs::create_dir_all(output.join("mcp")).unwrap();
    for collection in ["objects", "style_definitions"] {
        let records = snapshot[collection].as_array().unwrap();
        let mut offset = 0;
        let mut count = 0;
        let mut bytes = 0;
        let mut mcp_count = 0;
        let mut mcp_bytes = 0;
        let mut mcp_max = 0;
        loop {
            let mut metadata = snapshot.clone();
            metadata.as_object_mut().unwrap().remove("objects");
            metadata
                .as_object_mut()
                .unwrap()
                .remove("style_definitions");
            let end = (offset + 50).min(records.len());
            metadata[collection] = json!(records[offset..end]);
            let response = json!({
                "schema_version":1,"source_sha256":snapshot["source_sha256"],
                "collection":collection,"total":records.len(),"snapshot":metadata,
            });
            let mut args = arguments(collection);
            args["offset"] = json!(offset);
            let projected =
                format_snapshot_page(response, offset, FormatDetail::Effective, &args).unwrap();
            let encoded = serde_json::to_vec(&projected).unwrap();
            std::fs::write(output.join(format!("{collection}-{offset}.json")), &encoded).unwrap();
            bytes += encoded.len();
            count += 1;
            let mut json_offset = None;
            let mut expected_source = None;
            let mut expected_json = None;
            loop {
                let chunk = bounded_read_json(
                    projected.clone(),
                    args.clone(),
                    json_offset,
                    None,
                    expected_source.as_deref(),
                    expected_json.as_deref(),
                )
                .unwrap();
                let retained = retained_format_output(&chunk);
                mcp_count += 1;
                mcp_bytes += retained.len();
                mcp_max = mcp_max.max(retained.len());
                std::fs::write(
                    output.join("mcp").join(format!(
                        "{collection}-{offset}-{}.json",
                        json_offset.unwrap_or(0)
                    )),
                    &retained,
                )
                .unwrap();
                if chunk["projection"] != "json_fragment" || chunk["continuation"].is_null() {
                    break;
                }
                let next = &chunk["continuation"]["arguments"];
                json_offset = Some(next["json_offset"].as_u64().unwrap() as usize);
                expected_source = Some(next["expected_source_sha256"].as_str().unwrap().to_owned());
                expected_json = Some(next["expected_json_sha256"].as_str().unwrap().to_owned());
            }
            if offset == 0 {
                println!(
                    "{collection} metadata_sha256={}",
                    projected["metadata_sha256"]
                );
            }
            let Some(next_offset) = projected["next_offset"].as_u64() else {
                break;
            };
            assert!(next_offset as usize > offset);
            offset = next_offset as usize;
        }
        println!(
            "{collection} records={} pages={count} bytes={bytes} mcp_calls={mcp_count} mcp_bytes={mcp_bytes} mcp_max={mcp_max}",
            records.len()
        );
    }
}
