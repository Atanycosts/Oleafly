use std::collections::BTreeMap;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use skrifa::raw::TableProvider;
use skrifa::{FontRef, MetadataProvider};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontFamily {
    pub name: String,
    pub monospace: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FaceTraits {
    monospace: bool,
    symbol_only: bool,
}

const PICTURE_FAMILIES: &[&str] = &[
    "Bodoni Ornaments",
    "Material Icons",
    "Material Symbols",
    "Symbol",
    "Webdings",
    "Wingdings",
];

const MONOSPACE_PROBE: [char; 7] = ['i', 'l', 'm', 'M', 'W', '0', ' '];

const MONOSPACE_MIN_GLYPHS: usize = 4;

fn listable(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && !name.chars().any(char::is_control)
}

fn draws_pictures(name: &str) -> bool {
    PICTURE_FAMILIES.iter().any(|family| {
        name.get(..family.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(family))
            && name
                .get(family.len()..)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with(' '))
    })
}

fn symbol_only_cmap(subtables: impl IntoIterator<Item = (u16, u16)>) -> bool {
    let mut symbol = false;
    for subtable in subtables {
        match subtable {
            (0, _) | (3, 1) | (3, 10) => return false,
            (3, 0) => symbol = true,
            _ => {}
        }
    }
    symbol
}

fn uniform_advances(advances: impl IntoIterator<Item = Option<u16>>) -> bool {
    let mut present = advances.into_iter().flatten();
    let Some(first) = present.next() else {
        return false;
    };
    let mut count = 1;
    for advance in present {
        if advance != first {
            return false;
        }
        count += 1;
    }
    first > 0 && count >= MONOSPACE_MIN_GLYPHS
}

fn monospace(flagged: bool, advances: impl IntoIterator<Item = Option<u16>>) -> bool {
    flagged || uniform_advances(advances)
}

fn face_traits(face: &FontRef<'_>, flagged_monospace: bool) -> FaceTraits {
    let subtables = face.cmap().into_iter().flat_map(|cmap| {
        cmap.encoding_records()
            .iter()
            .map(|record| (record.platform_id() as u16, record.encoding_id()))
    });
    let charmap = face.charmap();
    let metrics = face.hmtx().ok();
    let advances = MONOSPACE_PROBE.iter().map(|&character| {
        charmap
            .map(character)
            .filter(|glyph| glyph.to_u32() != 0)
            .and_then(|glyph| metrics.as_ref()?.advance(glyph))
    });
    FaceTraits {
        monospace: monospace(flagged_monospace, advances),
        symbol_only: symbol_only_cmap(subtables),
    }
}

fn font_families<'a>(
    faces: impl IntoIterator<Item = (&'a str, FaceTraits)>,
) -> Vec<SystemFontFamily> {
    let mut families: BTreeMap<String, SystemFontFamily> = BTreeMap::new();
    for (name, traits) in faces {
        let name = name.trim();
        if !listable(name) || draws_pictures(name) || traits.symbol_only {
            continue;
        }
        families
            .entry(name.to_lowercase())
            .and_modify(|family| family.monospace &= traits.monospace)
            .or_insert_with(|| SystemFontFamily {
                name: name.to_owned(),
                monospace: traits.monospace,
            });
    }
    families.into_values().collect()
}

fn database_families(database: &fontdb::Database) -> Vec<SystemFontFamily> {
    font_families(database.faces().filter_map(|face| {
        let (name, _) = face.families.first()?;
        let traits = database
            .with_face_data(face.id, |data, index| {
                FontRef::from_index(data, index)
                    .ok()
                    .map(|parsed| face_traits(&parsed, face.monospaced))
            })
            .flatten()
            .unwrap_or(FaceTraits {
                monospace: face.monospaced,
                symbol_only: false,
            });
        Some((name.as_str(), traits))
    }))
}

fn system_database() -> fontdb::Database {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();
    database
}

fn load_app_font_caches(database: &mut fontdb::Database, roots: &[std::path::PathBuf]) {
    for root in roots {
        database.load_fonts_dir(root);
    }
}

fn installed_font_families() -> Vec<SystemFontFamily> {
    database_families(&system_database())
}

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<SystemFontFamily>, String> {
    tauri::async_runtime::spawn_blocking(installed_font_families)
        .await
        .map_err(|error| error.to_string())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemFontStyle {
    Normal,
    Italic,
    Oblique,
}

impl From<fontdb::Style> for SystemFontStyle {
    fn from(style: fontdb::Style) -> Self {
        match style {
            fontdb::Style::Normal => Self::Normal,
            fontdb::Style::Italic => Self::Italic,
            fontdb::Style::Oblique => Self::Oblique,
        }
    }
}

impl From<SystemFontStyle> for fontdb::Style {
    fn from(style: SystemFontStyle) -> Self {
        match style {
            SystemFontStyle::Normal => Self::Normal,
            SystemFontStyle::Italic => Self::Italic,
            SystemFontStyle::Oblique => Self::Oblique,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemFontRequest {
    family: String,
    weight: u16,
    style: SystemFontStyle,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontFace {
    requested: SystemFontRequest,
    family: String,
    postscript_name: String,
    weight: u16,
    style: SystemFontStyle,
    face_index: u32,
    sha256: String,
    content_base64: String,
    version: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontResolution {
    faces: Vec<SystemFontFace>,
    missing: Vec<SystemFontRequest>,
}

const MAX_FONT_REQUESTS: usize = 256;
const MAX_FONT_FACE_BYTES: usize = 64 * 1024 * 1024;
const MAX_FONT_BATCH_BYTES: usize = 256 * 1024 * 1024;

fn validate_font_requests(requests: &[SystemFontRequest]) -> Result<(), String> {
    if requests.len() > MAX_FONT_REQUESTS {
        return Err("Request at most 256 system font faces per batch.".into());
    }
    for request in requests {
        if request.family.trim().is_empty()
            || request.family.len() > 512
            || request.family.chars().any(char::is_control)
            || !(1..=1000).contains(&request.weight)
        {
            return Err("Use a font family name and a weight between 1 and 1000.".into());
        }
    }
    Ok(())
}

pub(crate) fn standalone_static_font(data: &[u8], index: u32) -> bool {
    if index != 0
        || !matches!(data.get(..4), Some(b"\0\x01\0\0" | b"OTTO" | b"true"))
        || data.len() > MAX_FONT_FACE_BYTES
    {
        return false;
    }
    FontRef::from_index(data, index).is_ok_and(|font| {
        font.data_for_tag(skrifa::raw::types::Tag::new(b"fvar"))
            .is_none()
    })
}

pub(crate) fn font_version(data: &[u8], index: u32) -> Option<String> {
    let font = FontRef::from_index(data, index).ok()?;
    font.localized_strings(skrifa::string::StringId::VERSION_STRING)
        .english_or_first()
        .map(|name| name.to_string())
}

fn resolve_font_faces(
    database: &fontdb::Database,
    requests: Vec<SystemFontRequest>,
) -> Result<SystemFontResolution, String> {
    let mut result = SystemFontResolution::default();
    let mut total_bytes = 0;
    for requested in requests {
        // Every candidate must be the requested family, weight and slant. A
        // localized family name on this same face is an identity, not a substitute.
        let wanted_family = requested.family.trim().to_lowercase();
        let mut resolved = None;
        for face in database.faces().filter(|face| {
            face.weight.0 == requested.weight && face.style == requested.style.into()
        }) {
            let Some((family, _)) = face
                .families
                .iter()
                .find(|(name, _)| name.to_lowercase() == wanted_family)
            else {
                continue;
            };
            let encoded = database
                .with_face_data(face.id, |data, index| -> Result<_, String> {
                    if !standalone_static_font(data, index) {
                        return Ok(None);
                    }
                    if total_bytes + data.len() > MAX_FONT_BATCH_BYTES {
                        return Err(
                            "System font batch exceeds 256 MiB; request fewer faces.".into()
                        );
                    }
                    total_bytes += data.len();
                    Ok(Some((
                        index,
                        format!("{:x}", Sha256::digest(data)),
                        STANDARD.encode(data),
                        font_version(data, index),
                    )))
                })
                .transpose()? // A missing/unreadable source is reported with other missing faces.
                .flatten();
            if let Some((face_index, sha256, content_base64, version)) = encoded {
                resolved = Some(SystemFontFace {
                    requested: requested.clone(),
                    family: family.clone(),
                    postscript_name: face.post_script_name.clone(),
                    weight: face.weight.0,
                    style: face.style.into(),
                    face_index,
                    sha256,
                    content_base64,
                    version,
                });
                break;
            }
        }
        match resolved {
            Some(face) => result.faces.push(face),
            None => result.missing.push(requested),
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn resolve_system_font_faces(
    requests: Vec<SystemFontRequest>,
) -> Result<SystemFontResolution, String> {
    validate_font_requests(&requests)?;
    if requests.is_empty() {
        return Ok(SystemFontResolution::default());
    }
    let cache_roots = crate::assets::font_cache_roots()?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut database = system_database();
        load_app_font_caches(&mut database, &cache_roots);
        resolve_font_faces(&database, requests)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(family: &str, weight: u16, style: SystemFontStyle) -> SystemFontRequest {
        SystemFontRequest {
            family: family.into(),
            weight,
            style,
        }
    }

    // Minimal SFNT name/OS2 tables exercise fontdb's real family/style parser.
    // Geometry and glyph rendering belong to the editor's font validator.
    fn font_bytes(
        family: &str,
        postscript: &str,
        weight: u16,
        italic: bool,
        variable: bool,
    ) -> Vec<u8> {
        font_bytes_with_alias(family, postscript, weight, italic, variable, None)
    }

    fn font_bytes_with_alias(
        family: &str,
        postscript: &str,
        weight: u16,
        italic: bool,
        variable: bool,
        alias: Option<&str>,
    ) -> Vec<u8> {
        let mut names = vec![(1u16, 0x409, family), (6u16, 0x409, postscript)];
        if let Some(alias) = alias {
            names.push((1, 0x804, alias));
        }
        let mut name = vec![0, 0];
        name.extend((names.len() as u16).to_be_bytes());
        name.extend((6 + names.len() as u16 * 12).to_be_bytes());
        let mut strings = Vec::new();
        for (id, language, value) in names {
            let encoded: Vec<_> = value.encode_utf16().flat_map(u16::to_be_bytes).collect();
            for number in [
                3,
                1,
                language,
                id,
                encoded.len() as u16,
                strings.len() as u16,
            ] {
                name.extend(number.to_be_bytes());
            }
            strings.extend(encoded);
        }
        name.extend(strings);
        let mut os2 = vec![0; 78];
        os2[4..6].copy_from_slice(&weight.to_be_bytes());
        os2[6..8].copy_from_slice(&5u16.to_be_bytes());
        os2[62..64].copy_from_slice(&u16::from(italic).to_be_bytes());
        let mut tables = vec![(*b"OS/2", os2), (*b"name", name)];
        if variable {
            tables.push((*b"fvar", vec![0; 16]));
        }
        tables.sort_by_key(|(tag, _)| *tag);
        let mut bytes = vec![0; 12 + tables.len() * 16];
        bytes[..4].copy_from_slice(b"\0\x01\0\0");
        bytes[4..6].copy_from_slice(&(tables.len() as u16).to_be_bytes());
        for (i, (tag, data)) in tables.into_iter().enumerate() {
            let start = 12 + i * 16;
            let offset = bytes.len() as u32;
            bytes[start..start + 4].copy_from_slice(&tag);
            bytes[start + 8..start + 12].copy_from_slice(&offset.to_be_bytes());
            bytes[start + 12..start + 16].copy_from_slice(&(data.len() as u32).to_be_bytes());
            bytes.extend(data);
        }
        bytes
    }

    #[test]
    fn face_resolution_matches_family_case_and_returns_selected_bytes_and_metadata() {
        let regular = font_bytes("Oleafly Test", "OleaflyTest-Regular", 400, false, false);
        let italic = font_bytes("Oleafly Test", "OleaflyTest-BoldItalic", 700, true, false);
        let mut database = fontdb::Database::new();
        database.load_font_data(regular.clone());
        database.load_font_data(italic.clone());
        let requests = vec![
            request(" oleafly TEST ", 400, SystemFontStyle::Normal),
            request("Oleafly Test", 700, SystemFontStyle::Italic),
        ];
        let result = resolve_font_faces(&database, requests.clone()).unwrap();
        assert!(result.missing.is_empty());
        assert_eq!(result.faces.len(), 2);
        for ((face, requested), expected) in
            result.faces.iter().zip(requests).zip([regular, italic])
        {
            assert_eq!(face.requested, requested);
            assert_eq!(face.family, "Oleafly Test");
            assert_eq!(face.face_index, 0);
            let bytes = STANDARD.decode(&face.content_base64).unwrap();
            assert_eq!(bytes, expected);
            assert_eq!(face.sha256, format!("{:x}", Sha256::digest(&bytes)));
            let mut parsed = fontdb::Database::new();
            parsed.load_font_data(bytes);
            let actual = parsed.faces().next().unwrap();
            assert_eq!(face.postscript_name, actual.post_script_name);
            assert_eq!(face.weight, actual.weight.0);
            assert_eq!(face.style, actual.style.into());
        }
        assert_eq!(result.faces[1].weight, 700);
        assert_eq!(result.faces[1].style, SystemFontStyle::Italic);
    }

    #[test]
    fn exact_faces_reject_nearest_weight_slant_and_other_family() {
        let mut database = fontdb::Database::new();
        database.load_font_data(font_bytes("Exact", "Exact-Regular", 400, false, false));
        let requests = vec![
            request("Exact", 700, SystemFontStyle::Normal),
            request("Exact", 400, SystemFontStyle::Italic),
            request("Exact", 400, SystemFontStyle::Oblique),
            request("Exact", 450, SystemFontStyle::Normal),
            request("Other", 400, SystemFontStyle::Normal),
        ];
        let result = resolve_font_faces(&database, requests.clone()).unwrap();
        assert!(result.faces.is_empty());
        assert_eq!(result.missing, requests);
    }

    #[test]
    fn localized_names_keep_the_same_face_identity_without_canonical_substitution() {
        let bytes = font_bytes_with_alias(
            "Exact Serif",
            "ExactSerif-Regular",
            400,
            false,
            false,
            Some("确切衬线"),
        );
        let mut database = fontdb::Database::new();
        database.load_font_data(bytes);
        let result = resolve_font_faces(
            &database,
            vec![
                request("确切衬线", 400, SystemFontStyle::Normal),
                request("exact serif", 400, SystemFontStyle::Normal),
            ],
        )
        .unwrap();
        assert!(result.missing.is_empty());
        assert_eq!(result.faces.len(), 2);
        assert_eq!(result.faces[0].family, "确切衬线");
        assert_eq!(result.faces[1].family, "Exact Serif");
        assert_eq!(
            result.faces[0].postscript_name,
            result.faces[1].postscript_name
        );
        assert_eq!(result.faces[0].sha256, result.faces[1].sha256);
        assert_eq!(
            result.faces[0].content_base64,
            result.faces[1].content_base64
        );
    }

    #[test]
    fn both_app_font_caches_supply_exact_faces_without_system_installation() {
        let root = tempfile::tempdir().unwrap();
        let roots = [root.path().join("fonts"), root.path().join("typst-fonts")];
        for (cache, family) in roots.iter().zip(["Cache Text", "Cache Typst"]) {
            let pack = cache.join("pack");
            std::fs::create_dir_all(&pack).unwrap();
            std::fs::write(
                pack.join("regular.ttf"),
                font_bytes(family, "Cached-Regular", 400, false, false),
            )
            .unwrap();
        }
        let mut database = fontdb::Database::new();
        load_app_font_caches(&mut database, &roots);
        let result = resolve_font_faces(
            &database,
            vec![
                request("Cache Text", 400, SystemFontStyle::Normal),
                request("Cache Typst", 400, SystemFontStyle::Normal),
            ],
        )
        .unwrap();
        assert!(result.missing.is_empty());
        assert_eq!(result.faces.len(), 2);
        assert_eq!(result.faces[0].family, "Cache Text");
        assert_eq!(result.faces[1].family, "Cache Typst");
    }

    #[test]
    fn unavailable_families_do_not_resolve_to_a_generic_or_other_installed_family() {
        let mut database = fontdb::Database::new();
        database.load_font_data(font_bytes(
            "Available",
            "Available-Regular",
            400,
            false,
            false,
        ));
        database.set_serif_family("Available");
        let requests = vec![
            request("Missing", 400, SystemFontStyle::Normal),
            request("serif", 400, SystemFontStyle::Normal),
        ];
        let result = resolve_font_faces(&database, requests.clone()).unwrap();
        assert!(result.faces.is_empty());
        assert_eq!(result.missing, requests);
    }

    #[test]
    fn variable_and_collection_sources_are_missing_instead_of_mislabeled_as_standalone() {
        let variable = font_bytes("Variable", "Variable-Regular", 400, false, true);
        let standalone = font_bytes("Collection", "Collection-Regular", 400, false, false);
        let mut collection = vec![0; 16];
        collection[..4].copy_from_slice(b"ttcf");
        collection[4..8].copy_from_slice(&0x10000u32.to_be_bytes());
        collection[8..12].copy_from_slice(&1u32.to_be_bytes());
        collection[12..16].copy_from_slice(&16u32.to_be_bytes());
        let mut adjusted = standalone.clone();
        for i in 0..2 {
            let start = 12 + i * 16 + 8;
            let offset = u32::from_be_bytes(adjusted[start..start + 4].try_into().unwrap());
            adjusted[start..start + 4].copy_from_slice(&(offset + 16).to_be_bytes());
        }
        collection.extend(adjusted);
        let mut database = fontdb::Database::new();
        database.load_font_data(variable);
        database.load_font_data(collection);
        assert_eq!(database.faces().count(), 2);
        let requests = vec![
            request("Variable", 400, SystemFontStyle::Normal),
            request("Collection", 400, SystemFontStyle::Normal),
        ];
        let result = resolve_font_faces(&database, requests.clone()).unwrap();
        assert!(result.faces.is_empty());
        assert_eq!(result.missing, requests);
        assert!(!standalone_static_font(&standalone, 1));
    }

    #[test]
    fn request_limits_are_checked_at_the_command_boundary() {
        assert!(validate_font_requests(&[request("Font", 400, SystemFontStyle::Normal)]).is_ok());
        for invalid in [
            request(" ", 400, SystemFontStyle::Normal),
            request("Font\0", 400, SystemFontStyle::Normal),
            request("Font", 0, SystemFontStyle::Normal),
        ] {
            assert!(validate_font_requests(&[invalid]).is_err());
        }
        assert!(validate_font_requests(&vec![
            request("Font", 400, SystemFontStyle::Normal);
            MAX_FONT_REQUESTS + 1
        ])
        .is_err());
    }

    #[test]
    #[ignore = "requires this Mac's installed Times New Roman and Noto CJK fonts"]
    fn local_installed_font_bytes_match_the_selected_fontdb_face() {
        let database = system_database();
        let requests = vec![
            request("Times New Roman", 400, SystemFontStyle::Normal),
            request("Noto Sans CJK SC", 700, SystemFontStyle::Normal),
        ];
        let result = resolve_font_faces(&database, requests).unwrap();
        assert!(result.missing.is_empty(), "{:?}", result.missing);
        for face in result.faces {
            let bytes = STANDARD.decode(&face.content_base64).unwrap();
            assert!(standalone_static_font(&bytes, face.face_index));
            assert_eq!(face.sha256, format!("{:x}", Sha256::digest(&bytes)));
            let mut parsed = fontdb::Database::new();
            parsed.load_font_data(bytes);
            let actual = parsed.faces().next().unwrap();
            assert_eq!(face.family, actual.families[0].0);
            assert_eq!(face.postscript_name, actual.post_script_name);
            assert_eq!(face.weight, actual.weight.0);
            assert_eq!(face.style, actual.style.into());
        }
    }

    fn family(name: &str, monospace: bool) -> SystemFontFamily {
        SystemFontFamily {
            name: name.to_owned(),
            monospace,
        }
    }

    fn text(monospace: bool) -> FaceTraits {
        FaceTraits {
            monospace,
            symbol_only: false,
        }
    }

    const SYMBOL: FaceTraits = FaceTraits {
        monospace: false,
        symbol_only: true,
    };

    #[test]
    fn each_family_is_listed_once_in_name_order() {
        let families = font_families([
            ("iA Writer Quattro S", text(false)),
            ("Fira Code", text(true)),
            ("iA Writer Quattro S", text(false)),
            ("Arial", text(false)),
        ]);
        assert_eq!(
            families,
            [
                family("Arial", false),
                family("Fira Code", true),
                family("iA Writer Quattro S", false),
            ]
        );
    }

    #[test]
    fn a_family_is_monospaced_only_when_every_face_is() {
        let families = font_families([
            ("JetBrains Mono", text(true)),
            ("JetBrains Mono", text(true)),
            ("Mixed", text(true)),
            ("Mixed", text(false)),
        ]);
        assert_eq!(
            families,
            [family("JetBrains Mono", true), family("Mixed", false)]
        );
    }

    #[test]
    fn names_differing_only_in_case_share_one_entry() {
        let families =
            font_families([("IBM Plex Mono", text(true)), ("ibm plex mono", text(true))]);
        assert_eq!(families, [family("IBM Plex Mono", true)]);
    }

    #[test]
    fn hidden_blank_and_control_character_names_are_left_out() {
        let families = font_families([
            (".SF NS", text(false)),
            ("   ", text(false)),
            ("", text(true)),
            ("Bad\u{0}Name", text(false)),
            ("  Menlo  ", text(true)),
        ]);
        assert_eq!(families, [family("Menlo", true)]);
    }

    #[test]
    fn a_family_whose_only_face_is_symbol_encoded_is_left_out() {
        let families = font_families([
            ("Marlett", SYMBOL),
            ("Ornamented", SYMBOL),
            ("Ornamented", text(false)),
            ("Arial", text(false)),
        ]);
        assert_eq!(
            families,
            [family("Arial", false), family("Ornamented", false)]
        );
    }

    #[test]
    fn picture_families_are_left_out_whatever_their_case() {
        let families = font_families([
            ("Bodoni Ornaments", text(false)),
            ("WINGDINGS 2", text(false)),
            ("wingdings", text(false)),
            ("symbol", text(false)),
            ("Material Icons Outlined", text(false)),
            ("Symbola", text(false)),
            ("Bodoni 72", text(false)),
        ]);
        assert_eq!(
            families,
            [family("Bodoni 72", false), family("Symbola", false)]
        );
    }

    #[test]
    fn only_symbol_encoded_cmaps_without_unicode_subtables_count_as_symbol_only() {
        assert!(symbol_only_cmap([(1, 0), (3, 0)]));
        assert!(symbol_only_cmap([(3, 0)]));
        assert!(!symbol_only_cmap([(0, 3), (1, 0), (3, 0)]));
        assert!(!symbol_only_cmap([(3, 0), (3, 1)]));
        assert!(!symbol_only_cmap([(3, 0), (3, 10)]));
        assert!(!symbol_only_cmap([(1, 0)]));
        assert!(!symbol_only_cmap([]));
    }

    #[test]
    fn equal_advances_on_enough_probe_glyphs_count_as_monospace() {
        assert!(uniform_advances([
            Some(1229),
            Some(1229),
            Some(1229),
            Some(1229),
            Some(1229),
            Some(1229),
            Some(1229),
        ]));
        assert!(uniform_advances([
            Some(600),
            None,
            Some(600),
            None,
            Some(600),
            Some(600),
            None,
        ]));
        assert!(!uniform_advances([
            Some(560),
            Some(518),
            Some(1654),
            Some(1944),
            Some(2248),
            Some(1192),
            Some(500),
        ]));
        assert!(!uniform_advances([
            Some(600),
            Some(600),
            Some(600),
            None,
            None,
            None,
            None,
        ]));
        assert!(!uniform_advances([Some(0); 7]));
        assert!(!uniform_advances([None; 7]));
    }

    #[test]
    fn a_face_flagged_proportional_with_equal_advances_lists_as_monospace() {
        let hoefler = [560, 518, 1654, 1944, 2248, 1192, 500].map(Some);
        let families = font_families([
            ("Monaco", text(monospace(false, [Some(1229); 7]))),
            ("Hoefler Text", text(monospace(false, hoefler))),
            ("Menlo", text(monospace(true, hoefler))),
        ]);
        assert_eq!(
            families,
            [
                family("Hoefler Text", false),
                family("Menlo", true),
                family("Monaco", true),
            ]
        );
    }

    fn raw_family_names(database: &fontdb::Database) -> Vec<String> {
        database
            .faces()
            .filter_map(|face| face.families.first())
            .map(|(name, _)| name.trim().to_owned())
            .collect()
    }

    #[test]
    fn the_installed_list_is_sorted_and_free_of_hidden_families() {
        let families = installed_font_families();
        assert!(families.iter().all(|family| listable(&family.name)));
        assert!(families
            .windows(2)
            .all(|pair| pair[0].name.to_lowercase() < pair[1].name.to_lowercase()));
    }

    #[test]
    fn the_installed_list_drops_picture_fonts_and_finds_coding_fonts() {
        let database = system_database();
        let raw = raw_family_names(&database);
        let families = database_families(&database);
        let listed = |name: &str| {
            families
                .iter()
                .find(|family| family.name.eq_ignore_ascii_case(name))
        };
        assert!(families.iter().all(|family| !draws_pictures(&family.name)));
        for name in ["Webdings", "Wingdings"] {
            if raw
                .iter()
                .any(|raw_name| raw_name.eq_ignore_ascii_case(name))
            {
                assert!(listed(name).is_none(), "{name} should be left out");
            }
        }
        for name in ["Monaco", "Courier"] {
            if let Some(family) = listed(name) {
                assert!(family.monospace, "{name} should be monospace");
            }
        }
    }
}
