use std::io::{Cursor, Read};
use std::path::Path;
use std::process::{Command, Output};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

const CFB_SIGNATURE: &[u8] = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1";
const CONVERSION_TIMEOUT: Duration = Duration::from_secs(120);
const DOCX_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const STRICT_DOCX_CONTENT_TYPE: &str = "application/vnd.ms-word.document.main+xml";
const WORD_NAMESPACE: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const CONVERSION_METHOD: &str = "libreoffice --headless --convert-to docx:Office Open XML Text";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateConversion {
    pub engine: String,
    pub version: String,
    pub method: String,
    pub converted_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedTemplate {
    pub original_path: Option<String>,
    pub original_name: String,
    pub original_sha256: String,
    pub original_bytes: Vec<u8>,
    pub docx_bytes: Vec<u8>,
    pub docx_sha256: String,
    pub conversion: Option<TemplateConversion>,
}

#[cfg(test)]
pub async fn normalize_template(
    source_path: &Path,
    libreoffice_executable: Option<&Path>,
    temporary_root: &Path,
) -> Result<NormalizedTemplate, String> {
    let source_path = source_path.to_path_buf();
    let executable = libreoffice_executable.map(Path::to_path_buf);
    let temporary_root = temporary_root.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let name = source_path
            .file_name()
            .ok_or("Choose a Word template file.")?
            .to_string_lossy()
            .into_owned();
        let bytes = std::fs::read(&source_path)
            .map_err(|error| format!("Could not read the Word template: {error}"))?;
        normalize(
            name,
            Some(source_path.to_string_lossy().into_owned()),
            bytes,
            executable.as_deref(),
            &temporary_root,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

pub async fn normalize_template_bytes(
    original_name: &str,
    original_bytes: Vec<u8>,
    libreoffice_executable: Option<&Path>,
    temporary_root: &Path,
) -> Result<NormalizedTemplate, String> {
    let name = original_name.to_owned();
    let executable = libreoffice_executable.map(Path::to_path_buf);
    let temporary_root = temporary_root.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        normalize(
            name,
            None,
            original_bytes,
            executable.as_deref(),
            &temporary_root,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn normalize(
    original_name: String,
    original_path: Option<String>,
    original_bytes: Vec<u8>,
    executable: Option<&Path>,
    temporary_root: &Path,
) -> Result<NormalizedTemplate, String> {
    let original_sha256 = sha256(&original_bytes);
    let (docx_bytes, conversion) = if original_bytes.starts_with(CFB_SIGNATURE) {
        let executable = executable
            .ok_or("Choose a LibreOffice executable to import this legacy Word (.doc) template.")?;
        let (bytes, version) = convert_legacy(&original_bytes, executable, temporary_root)?;
        let conversion = TemplateConversion {
            engine: "LibreOffice".into(),
            version,
            method: CONVERSION_METHOD.into(),
            converted_sha256: sha256(&bytes),
        };
        (bytes, Some(conversion))
    } else if original_bytes.starts_with(b"PK\x03\x04") {
        validate_docx(&original_bytes)?;
        (original_bytes.clone(), None)
    } else {
        return Err("This template is not a legacy Word (.doc) or Word DOCX file.".into());
    };
    Ok(NormalizedTemplate {
        original_path,
        original_name,
        original_sha256,
        original_bytes,
        docx_sha256: sha256(&docx_bytes),
        docx_bytes,
        conversion,
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
    validate_docx(&docx_bytes)
        .map_err(|error| format!("LibreOffice produced an unreadable DOCX template: {error}"))?;
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

fn validate_docx(bytes: &[u8]) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "The Word template is not a readable DOCX package.")?;
    let content_types = read_part(&mut archive, "[Content_Types].xml")?;
    let types = roxmltree::Document::parse(&content_types)
        .map_err(|_| "The DOCX template has unreadable content types.")?;
    let content_type = types.descendants().find_map(|node| {
        (node.tag_name().name() == "Override"
            && node.attribute("PartName") == Some("/word/document.xml"))
        .then(|| node.attribute("ContentType"))
        .flatten()
    });
    if content_type == Some(STRICT_DOCX_CONTENT_TYPE) {
        return Err(
            "Strict OOXML Word documents are not supported. Resave the template as a transitional DOCX file before importing it."
                .into(),
        );
    }
    if content_type != Some(DOCX_CONTENT_TYPE) {
        return Err("The template package does not contain a Word DOCX document.".into());
    }
    let main = read_part(&mut archive, "word/document.xml")?;
    let document = roxmltree::Document::parse(&main)
        .map_err(|_| "The DOCX template has unreadable document XML.")?;
    let root = document.root_element();
    if root.tag_name().name() != "document" || root.tag_name().namespace() != Some(WORD_NAMESPACE) {
        return Err("The template package does not contain a Word DOCX document.".into());
    }
    Ok(())
}

fn read_part(archive: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<String, String> {
    let mut part = archive
        .by_name(name)
        .map_err(|_| format!("The DOCX template is missing {name}."))?;
    let mut xml = String::new();
    part.read_to_string(&mut xml)
        .map_err(|_| format!("Could not read {name} in the DOCX template."))?;
    Ok(xml)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    fn docx_with(content_type: &str, word_namespace: &str) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in [
            (
                "[Content_Types].xml",
                format!(
                    "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/word/document.xml\" ContentType=\"{content_type}\"/></Types>"
                ),
            ),
            (
                "word/document.xml",
                format!("<w:document xmlns:w=\"{word_namespace}\"><w:body/></w:document>"),
            ),
        ] {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn docx() -> Vec<u8> {
        docx_with(DOCX_CONTENT_TYPE, WORD_NAMESPACE)
    }

    #[tokio::test]
    async fn docx_bytes_pass_through_even_when_named_doc_without_a_renderer() {
        let directory = tempfile::tempdir().unwrap();
        let bytes = docx();
        let result =
            normalize_template_bytes("template.doc", bytes.clone(), None, directory.path())
                .await
                .unwrap();
        assert_eq!(result.docx_bytes, bytes);
        assert_eq!(result.original_bytes, bytes);
        assert_eq!(result.original_sha256, result.docx_sha256);
        assert_eq!(result.original_name, "template.doc");
        assert!(result.original_path.is_none());
        assert!(result.conversion.is_none());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn path_source_identity_is_preserved_without_writing_beside_it() {
        let source = tempfile::tempdir().unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let path = source.path().join("author.docx");
        let bytes = docx();
        std::fs::write(&path, &bytes).unwrap();
        let result = normalize_template(&path, None, scratch.path())
            .await
            .unwrap();
        assert_eq!(result.original_path.as_deref(), path.to_str());
        assert_eq!(result.original_bytes, bytes);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(std::fs::read_dir(source.path()).unwrap().count(), 1);
    }

    #[test]
    fn malformed_zip_and_non_word_inputs_do_not_pass_as_docx() {
        assert!(validate_docx(b"PK\x03\x04broken").is_err());
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("unrelated.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"not a Word document").unwrap();
        assert!(validate_docx(&writer.finish().unwrap().into_inner()).is_err());
        let root = tempfile::tempdir().unwrap();
        assert!(normalize(
            "x.doc".into(),
            None,
            b"{\\rtf1}".to_vec(),
            None,
            root.path()
        )
        .unwrap_err()
        .contains("not a legacy Word"));
        assert!(normalize(
            "x.docx".into(),
            None,
            CFB_SIGNATURE.to_vec(),
            None,
            root.path()
        )
        .unwrap_err()
        .contains("Choose a LibreOffice executable"));
        assert!(normalize(
            "x.doc".into(),
            None,
            CFB_SIGNATURE.to_vec(),
            Some(&root.path().join("missing")),
            root.path()
        )
        .unwrap_err()
        .contains("LibreOffice is unavailable"));
    }

    #[test]
    fn strict_ooxml_is_rejected_because_the_core_does_not_model_it() {
        let strict_namespace = "http://purl.oclc.org/ooxml/wordprocessingml/main";
        let strict = docx_with(STRICT_DOCX_CONTENT_TYPE, strict_namespace);
        assert!(validate_docx(&strict)
            .unwrap_err()
            .contains("Strict OOXML Word documents are not supported"));

        let mismatched = docx_with(DOCX_CONTENT_TYPE, strict_namespace);
        assert!(validate_docx(&mismatched).is_err());
    }

    #[cfg(unix)]
    fn fake_libreoffice(directory: &Path, behavior: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let executable = directory.join("selected soffice");
        let script = format!(
            "#!/bin/sh\ncase \"$1\" in -env:UserInstallation=file:*) ;; *) exit 21;; esac\nprofile=\"$1\"\nshift\nif [ \"$1\" = --version ]; then echo 'LibreOffice 26.2 test'; exit 0; fi\n[ \"$1\" = --headless ] || exit 22\n[ \"$6\" = 'docx:Office Open XML Text' ] || exit 23\n[ \"$7\" = --outdir ] || exit 24\n[ \"$9\" = \"$PWD/template.doc\" ] || exit 25\n[ -f \"$9\" ] || exit 26\n{behavior}\n"
        );
        std::fs::write(&executable, script).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        executable
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn legacy_conversion_stages_private_copy_and_retains_both_identities() {
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
        let result = normalize_template_bytes(
            "original.doc",
            original.clone(),
            Some(&executable),
            &scratch,
        )
        .await
        .unwrap();
        assert_eq!(result.original_bytes, original);
        assert_eq!(result.docx_bytes, converted);
        assert_ne!(result.original_sha256, result.docx_sha256);
        let provenance = result.conversion.unwrap();
        assert_eq!(provenance.engine, "LibreOffice");
        assert_eq!(provenance.version, "LibreOffice 26.2 test");
        assert_eq!(provenance.converted_sha256, result.docx_sha256);
        assert_eq!(provenance.method, CONVERSION_METHOD);
        assert_eq!(std::fs::read_dir(&scratch).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn failed_or_unreadable_conversion_is_an_error_and_removes_scratch() {
        let directory = tempfile::tempdir().unwrap();
        let scratch = directory.path().join("scratch");
        std::fs::create_dir(&scratch).unwrap();
        for (behavior, expected) in [
            ("exit 7", "could not convert"),
            ("exit 0", "did not produce"),
            ("echo invalid > \"$8/template.docx\"", "unreadable DOCX"),
        ] {
            let executable = fake_libreoffice(directory.path(), behavior);
            let error = convert_legacy(CFB_SIGNATURE, &executable, &scratch).unwrap_err();
            assert!(error.contains(expected), "{error}");
            assert_eq!(std::fs::read_dir(&scratch).unwrap().count(), 0);
        }
        let executable = fake_libreoffice(directory.path(), "exit 0");
        std::fs::write(&executable, "#!/bin/sh\necho 'Some other converter'\n").unwrap();
        assert!(convert_legacy(CFB_SIGNATURE, &executable, &scratch)
            .unwrap_err()
            .contains("did not identify itself as LibreOffice"));
        assert_eq!(std::fs::read_dir(&scratch).unwrap().count(), 0);
    }

    #[tokio::test]
    #[ignore = "requires explicitly selected local legacy Word input and LibreOffice"]
    async fn real_legacy_template_conversion_keeps_author_source_unchanged() {
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
        let result = normalize_template(&source, Some(&executable), scratch.path())
            .await
            .unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), before);
        assert_eq!(result.original_bytes, before);
        assert_eq!(result.original_sha256, sha256(&before));
        validate_docx(&result.docx_bytes).unwrap();
        let conversion = result.conversion.as_ref().unwrap();
        assert_eq!(conversion.converted_sha256, result.docx_sha256);
        assert_eq!(std::fs::read_dir(scratch.path()).unwrap().count(), 0);
        if let Some(output) = std::env::var_os("OLEAFLY_LEGACY_TEMPLATE_TEST_OUTPUT") {
            std::fs::write(PathBuf::from(output), &result.docx_bytes).unwrap();
        }
        println!(
            "original_sha256={} docx_sha256={} docx_bytes={} conversion={}",
            result.original_sha256,
            result.docx_sha256,
            result.docx_bytes.len(),
            serde_json::to_string(conversion).unwrap()
        );
    }
}
