use std::path::Path;
use std::process::{Command, Output};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{request, Session};

const CFB_SIGNATURE: &[u8] = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1";
const CONVERSION_TIMEOUT: Duration = Duration::from_secs(120);
const CONVERSION_METHOD: &str = "libreoffice --headless --convert-to docx:Office Open XML Text";
const DOCX_NORMALIZE_ENDPOINT: &str = "/api/docx-normalize";

#[derive(Debug, Deserialize, Serialize)]
pub struct TemplateConversion {
    pub engine: String,
    pub version: String,
    pub method: String,
    pub converted_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedTemplate {
    pub original_name: String,
    pub original_sha256: String,
    pub original_bytes: Vec<u8>,
    pub docx_bytes: Vec<u8>,
    pub docx_sha256: String,
    pub conversion: Option<TemplateConversion>,
    pub converted_from_legacy: bool,
}

impl NormalizedTemplate {
    /// Managed projects receive strict source bytes and normalize them themselves.
    /// Legacy `.doc` files are the exception: LibreOffice converts them first.
    pub fn project_upload_bytes(&self) -> &[u8] {
        if self.converted_from_legacy {
            &self.docx_bytes
        } else {
            &self.original_bytes
        }
    }
}

pub async fn normalize_template_bytes(
    session: &Session,
    original_name: &str,
    original_bytes: Vec<u8>,
    libreoffice_executable: Option<&Path>,
    temporary_root: &Path,
) -> Result<NormalizedTemplate, String> {
    let original_sha256 = sha256(&original_bytes);
    let converted_from_legacy = original_bytes.starts_with(CFB_SIGNATURE);
    let (normalizer_input, legacy_version) = if converted_from_legacy {
        let executable = libreoffice_executable
            .ok_or("Choose a LibreOffice executable to import this legacy Word (.doc) template.")?;
        let bytes = original_bytes.clone();
        let executable = executable.to_path_buf();
        let temporary_root = temporary_root.to_path_buf();
        let (converted, version) = tauri::async_runtime::spawn_blocking(move || {
            convert_legacy(&bytes, &executable, &temporary_root)
        })
        .await
        .map_err(|error| error.to_string())??;
        (converted, Some(version))
    } else {
        (original_bytes.clone(), None)
    };
    let normalized = normalize_docx(session, &normalizer_input).await?;
    let conversion = normalized.provenance.or_else(|| {
        legacy_version.map(|version| TemplateConversion {
            engine: "LibreOffice".into(),
            version,
            method: CONVERSION_METHOD.into(),
            converted_sha256: normalized.source_sha256.clone(),
        })
    });
    Ok(NormalizedTemplate {
        original_name: original_name.to_owned(),
        original_sha256,
        original_bytes,
        docx_sha256: normalized.source_sha256,
        docx_bytes: normalized.bytes,
        conversion,
        converted_from_legacy,
    })
}

#[derive(Deserialize)]
struct NormalizerResponse {
    original_sha256: String,
    source_sha256: String,
    provenance: Option<TemplateConversion>,
}

#[derive(Debug)]
struct NormalizedDocx {
    bytes: Vec<u8>,
    source_sha256: String,
    provenance: Option<TemplateConversion>,
}

async fn normalize_docx(session: &Session, bytes: &[u8]) -> Result<NormalizedDocx, String> {
    let response = request(
        session,
        DOCX_NORMALIZE_ENDPOINT,
        Some(json!({"content_base64": STANDARD.encode(bytes)})),
    )
    .await?;
    validate_normalizer_response(bytes, response)
}

fn validate_normalizer_response(
    input_bytes: &[u8],
    response: Value,
) -> Result<NormalizedDocx, String> {
    let fields = response
        .as_object()
        .ok_or("Workbench returned an invalid DOCX normalization response.")?;
    let content = fields
        .get("content_base64")
        .cloned()
        .ok_or("Workbench did not return the normalized DOCX content.")?;
    if !fields.contains_key("provenance") {
        return Err("Workbench did not return DOCX normalization provenance.".into());
    }
    let response: NormalizerResponse = serde_json::from_value(response)
        .map_err(|_| "Workbench returned an invalid DOCX normalization response.".to_string())?;
    let input_sha256 = sha256(input_bytes);
    if response.original_sha256 != input_sha256 {
        return Err("Workbench normalized different bytes than the selected Word file.".into());
    }
    let content_is_null = content.is_null();
    let bytes = match content {
        Value::Null => input_bytes.to_vec(),
        Value::String(encoded) => STANDARD
            .decode(&encoded)
            .map_err(|_| "Workbench returned invalid normalized DOCX bytes.".to_string())?,
        _ => return Err("Workbench returned invalid normalized DOCX content.".into()),
    };
    let source_sha256 = sha256(&bytes);
    if response.source_sha256 != source_sha256 {
        return Err("Workbench normalized DOCX identity does not match its bytes.".into());
    }
    let changed = source_sha256 != input_sha256;
    if changed == content_is_null {
        return Err("Workbench returned inconsistent normalized DOCX content.".into());
    }
    if let Some(provenance) = &response.provenance {
        if provenance.engine.trim().is_empty()
            || provenance.version.trim().is_empty()
            || provenance.method.trim().is_empty()
            || provenance.converted_sha256 != source_sha256
        {
            return Err("Workbench returned invalid DOCX normalization provenance.".into());
        }
    } else if changed {
        return Err("Workbench changed the DOCX without conversion provenance.".into());
    }
    Ok(NormalizedDocx {
        bytes,
        source_sha256,
        provenance: response.provenance,
    })
}

fn convert_legacy(
    bytes: &[u8],
    executable: &Path,
    temporary_root: &Path,
) -> Result<(Vec<u8>, String), String> {
    if !executable.is_absolute() || !executable.is_file() {
        return Err("LibreOffice is unavailable at the selected executable.".into());
    }
    if !temporary_root.is_absolute() {
        return Err(
            "Word template conversion needs an absolute application temporary directory.".into(),
        );
    }
    std::fs::create_dir_all(temporary_root).map_err(|error| {
        format!("Could not prepare the Word template conversion directory: {error}")
    })?;
    let work = tempfile::Builder::new()
        .prefix("word-template-")
        .tempdir_in(temporary_root)
        .map_err(|error| format!("Could not isolate the Word template conversion: {error}"))?;
    let work_path = work
        .path()
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let profile = work_path.join("profile");
    let output = work_path.join("output");
    std::fs::create_dir(&profile).map_err(|error| error.to_string())?;
    std::fs::create_dir(&output).map_err(|error| error.to_string())?;
    let profile_uri = reqwest::Url::from_directory_path(&profile)
        .map_err(|_| "Could not create the private LibreOffice profile address.")?;
    let profile_argument = format!("-env:UserInstallation={profile_uri}");
    let mut version_command = isolated_command(executable, &profile_argument, &work_path);
    version_command.arg("--version");
    let version_output = invoke(version_command, "version check")?;
    let version = String::from_utf8_lossy(&version_output.stdout)
        .lines()
        .chain(String::from_utf8_lossy(&version_output.stderr).lines())
        .map(str::trim)
        .find(|line| line.to_lowercase().contains("libreoffice"))
        .map(str::to_owned)
        .filter(|_| version_output.status.success())
        .ok_or("The selected executable did not identify itself as LibreOffice.")?;

    let source = work_path.join("template.doc");
    std::fs::write(&source, bytes)
        .map_err(|error| format!("Could not stage the legacy Word template: {error}"))?;
    let mut command = isolated_command(executable, &profile_argument, &work_path);
    command
        .args([
            "--headless",
            "--nologo",
            "--nodefault",
            "--nofirststartwizard",
            "--convert-to",
            "docx:Office Open XML Text",
            "--outdir",
        ])
        .arg(&output)
        .arg(&source);
    let converted = invoke(command, "legacy Word conversion")?;
    if !converted.status.success() {
        return Err(format!(
            "LibreOffice could not convert the legacy Word template ({}).",
            converted.status
        ));
    }
    let docx_bytes = std::fs::read(output.join("template.docx"))
        .map_err(|_| "LibreOffice did not produce the expected DOCX template.")?;
    Ok((docx_bytes, version))
}

fn isolated_command(executable: &Path, profile: &str, work: &Path) -> Command {
    let mut command = Command::new(executable);
    command.arg(profile).current_dir(work);
    command
}

fn invoke(command: Command, operation: &str) -> Result<Output, String> {
    crate::proc::output_contained_with_timeout(command, CONVERSION_TIMEOUT).map_err(|error| {
        if error.kind() == std::io::ErrorKind::TimedOut {
            format!("LibreOffice {operation} timed out after 120 seconds and was stopped.")
        } else {
            format!("Could not run the selected LibreOffice executable for {operation}: {error}")
        }
    })
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Cursor, Write};
    use std::path::PathBuf;

    fn docx() -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in [
            (
                "[Content_Types].xml",
                "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>",
            ),
            (
                "word/document.xml",
                "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body/></w:document>",
            ),
        ] {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn assert_docx_container(bytes: &[u8]) {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        for name in ["[Content_Types].xml", "word/document.xml"] {
            archive.by_name(name).unwrap();
        }
    }

    fn conversion(output: &[u8]) -> TemplateConversion {
        TemplateConversion {
            engine: "test normalizer".into(),
            version: "1".into(),
            method: "strict-to-transitional".into(),
            converted_sha256: sha256(output),
        }
    }

    fn normalization_response(
        input: &[u8],
        content: Option<&[u8]>,
        provenance: Option<&TemplateConversion>,
    ) -> Value {
        json!({
            "content_base64": content.map(|bytes| STANDARD.encode(bytes)),
            "original_sha256": sha256(input),
            "source_sha256": sha256(content.unwrap_or(input)),
            "provenance": provenance,
        })
    }

    #[test]
    fn unchanged_docx_uses_the_request_bytes_and_still_checks_both_digests() {
        let input = docx();
        let normalized =
            validate_normalizer_response(&input, normalization_response(&input, None, None))
                .unwrap();
        assert_eq!(normalized.bytes, input);
        assert_eq!(normalized.source_sha256, sha256(&input));
        assert!(normalized.provenance.is_none());
    }

    #[test]
    fn changed_docx_returns_worker_bytes_and_matching_provenance() {
        let input = b"strict input";
        let output = docx();
        let provenance = conversion(&output);
        let normalized = validate_normalizer_response(
            input,
            normalization_response(input, Some(&output), Some(&provenance)),
        )
        .unwrap();
        assert_eq!(normalized.bytes, output);
        assert_eq!(normalized.source_sha256, sha256(&output));
        assert_eq!(
            normalized.provenance.unwrap().converted_sha256,
            sha256(&output)
        );
        assert_docx_container(&normalized.bytes);
    }

    #[test]
    fn inconsistent_worker_identities_and_content_are_refused() {
        let input = b"original";
        let output = b"normalized";
        let provenance = conversion(output);

        let mut response = normalization_response(input, Some(output), Some(&provenance));
        response["original_sha256"] = json!("0".repeat(64));
        assert!(validate_normalizer_response(input, response)
            .unwrap_err()
            .contains("different bytes"));

        let mut response = normalization_response(input, Some(output), Some(&provenance));
        response["source_sha256"] = json!("0".repeat(64));
        assert!(validate_normalizer_response(input, response)
            .unwrap_err()
            .contains("does not match its bytes"));

        let unchanged_with_content = normalization_response(input, Some(input), None);
        assert!(validate_normalizer_response(input, unchanged_with_content)
            .unwrap_err()
            .contains("inconsistent"));

        let mut missing_content = normalization_response(input, None, None);
        missing_content
            .as_object_mut()
            .unwrap()
            .remove("content_base64");
        assert!(validate_normalizer_response(input, missing_content)
            .unwrap_err()
            .contains("normalized DOCX content"));
    }

    #[test]
    fn changed_docx_requires_complete_matching_provenance() {
        let input = b"original";
        let output = b"normalized";
        assert!(validate_normalizer_response(
            input,
            normalization_response(input, Some(output), None)
        )
        .unwrap_err()
        .contains("without conversion provenance"));

        let mut wrong_digest = conversion(output);
        wrong_digest.converted_sha256 = sha256(input);
        assert!(validate_normalizer_response(
            input,
            normalization_response(input, Some(output), Some(&wrong_digest))
        )
        .unwrap_err()
        .contains("invalid DOCX normalization provenance"));

        let mut missing_method = conversion(output);
        missing_method.method.clear();
        assert!(validate_normalizer_response(
            input,
            normalization_response(input, Some(output), Some(&missing_method))
        )
        .unwrap_err()
        .contains("invalid DOCX normalization provenance"));
    }

    #[test]
    fn projects_receive_original_docx_but_the_converted_legacy_upload() {
        let template = |original: &[u8], docx: &[u8], converted_from_legacy| NormalizedTemplate {
            original_name: "template.docx".into(),
            original_sha256: sha256(original),
            original_bytes: original.to_vec(),
            docx_bytes: docx.to_vec(),
            docx_sha256: sha256(docx),
            conversion: None,
            converted_from_legacy,
        };
        let strict = template(b"strict source", b"normalized source", false);
        assert_eq!(strict.project_upload_bytes(), b"strict source");
        let legacy = template(CFB_SIGNATURE, b"converted DOCX", true);
        assert_eq!(legacy.project_upload_bytes(), b"converted DOCX");
    }

    #[cfg(unix)]
    fn fake_libreoffice(directory: &Path, behavior: &str) -> PathBuf {
        let executable = directory.join("selected soffice");
        let script = format!(
            "#!/bin/sh\ncase \"$1\" in -env:UserInstallation=file:*) ;; *) exit 21;; esac\nprofile=\"$1\"\nshift\nif [ \"$1\" = --version ]; then echo 'LibreOffice 26.2 test'; exit 0; fi\n[ \"$1\" = --headless ] || exit 22\n[ \"$6\" = 'docx:Office Open XML Text' ] || exit 23\n[ \"$7\" = --outdir ] || exit 24\n[ \"$9\" = \"$PWD/template.doc\" ] || exit 25\n[ -f \"$9\" ] || exit 26\n{behavior}\n"
        );
        crate::test_wait::write_executable(&executable, &script);
        executable
    }

    #[cfg(unix)]
    #[test]
    fn legacy_conversion_stages_a_private_copy_and_returns_the_converted_docx() {
        let directory = tempfile::tempdir().unwrap();
        let scratch = directory.path().join("scratch with spaces # 字");
        std::fs::create_dir(&scratch).unwrap();
        let converted = docx();
        let fixture = directory.path().join("converted.docx");
        std::fs::write(&fixture, &converted).unwrap();
        let executable = fake_libreoffice(
            directory.path(),
            &format!("cp '{}' \"$8/template.docx\"", fixture.display()),
        );
        let original = [CFB_SIGNATURE, b"legacy test bytes"].concat();
        let (docx, version) = convert_legacy(&original, &executable, &scratch).unwrap();
        assert_eq!(docx, converted);
        assert_eq!(version, "LibreOffice 26.2 test");
        assert_docx_container(&docx);
        assert_eq!(std::fs::read_dir(&scratch).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn failed_conversion_is_an_error_and_removes_scratch() {
        let directory = tempfile::tempdir().unwrap();
        let scratch = directory.path().join("scratch");
        std::fs::create_dir(&scratch).unwrap();
        for (behavior, expected) in [
            ("exit 7", "could not convert"),
            ("exit 0", "did not produce"),
        ] {
            let executable = fake_libreoffice(directory.path(), behavior);
            let error = convert_legacy(CFB_SIGNATURE, &executable, &scratch).unwrap_err();
            assert!(error.contains(expected), "{error}");
            assert_eq!(std::fs::read_dir(&scratch).unwrap().count(), 0);
        }
        let executable = directory.path().join("other converter");
        crate::test_wait::write_executable(&executable, "#!/bin/sh\necho 'Some other converter'\n");
        assert!(convert_legacy(CFB_SIGNATURE, &executable, &scratch)
            .unwrap_err()
            .contains("did not identify itself as LibreOffice"));
        assert_eq!(std::fs::read_dir(&scratch).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn legacy_output_validation_belongs_to_the_shared_worker() {
        let directory = tempfile::tempdir().unwrap();
        let scratch = directory.path().join("scratch");
        std::fs::create_dir(&scratch).unwrap();
        let executable = fake_libreoffice(
            directory.path(),
            "printf 'not a DOCX' > \"$8/template.docx\"",
        );
        let (docx, _) = convert_legacy(CFB_SIGNATURE, &executable, &scratch).unwrap();
        assert_eq!(docx, b"not a DOCX");
        assert!(zip::ZipArchive::new(Cursor::new(&docx)).is_err());
    }

    #[test]
    #[ignore = "requires explicitly selected local legacy Word input and LibreOffice"]
    fn real_legacy_template_conversion_keeps_author_source_unchanged() {
        let source = PathBuf::from(
            std::env::var_os("OLEAFLY_LEGACY_TEMPLATE_TEST_SOURCE")
                .expect("set OLEAFLY_LEGACY_TEMPLATE_TEST_SOURCE"),
        );
        let executable = PathBuf::from(
            std::env::var_os("OLEAFLY_LIBREOFFICE_TEST").expect("set OLEAFLY_LIBREOFFICE_TEST"),
        );
        let before = std::fs::read(&source).unwrap();
        assert!(before.starts_with(CFB_SIGNATURE));
        let scratch = tempfile::tempdir().unwrap();
        let (docx_bytes, version) = convert_legacy(&before, &executable, scratch.path()).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), before);
        assert_docx_container(&docx_bytes);
        let conversion = TemplateConversion {
            engine: "LibreOffice".into(),
            version,
            method: CONVERSION_METHOD.into(),
            converted_sha256: sha256(&docx_bytes),
        };
        assert_eq!(std::fs::read_dir(scratch.path()).unwrap().count(), 0);
        if let Some(output) = std::env::var_os("OLEAFLY_LEGACY_TEMPLATE_TEST_OUTPUT") {
            std::fs::write(PathBuf::from(output), &docx_bytes).unwrap();
        }
        println!(
            "original_sha256={} docx_sha256={} docx_bytes={} conversion={}",
            sha256(&before),
            sha256(&docx_bytes),
            docx_bytes.len(),
            serde_json::to_string(&conversion).unwrap()
        );
    }
}
