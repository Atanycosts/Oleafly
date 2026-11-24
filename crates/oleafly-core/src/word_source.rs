use std::path::Path;

pub const WRITE_REFUSED: &str =
    "Open the Word working copy to edit a DOCX. To add a Word file to the project, import it or export it to a new filename instead of writing it through a generic file tool.";

fn is_docx(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(std::ffi::OsStr::to_str) else {
        return false;
    };
    #[cfg(windows)]
    let name = name
        .split(':')
        .next()
        .unwrap_or(name)
        .trim_end_matches(['.', ' ']);
    name.rsplit_once('.')
        .is_some_and(|(_, suffix)| suffix.eq_ignore_ascii_case("docx"))
}

pub fn is_docx_target(path: &Path) -> bool {
    if is_docx(path) {
        return true;
    }
    #[cfg(windows)]
    return crate::long_path_name(path).is_some_and(|path| is_docx(&path));
    #[cfg(not(windows))]
    false
}

/// Whether a move would turn a structured file into a DOCX or hide a DOCX
/// behind another extension. Shell commands and external editors are outside
/// this predicate; their boundary is the execution sandbox.
pub fn move_crosses_docx_boundary(from: &Path, to: &Path) -> bool {
    is_docx_target(from) != is_docx_target(to)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_word_scope_is_docx_only() {
        for path in ["paper.docx", "paper.DOCX", "archive/report.DoCx"] {
            assert!(is_docx_target(Path::new(path)), "{path}");
        }
        for path in ["paper.doc", "paper.docm", "paper.docx.bak", "paper", "docx"] {
            assert!(!is_docx_target(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn relabeling_across_the_docx_boundary_is_detected() {
        assert!(move_crosses_docx_boundary(
            Path::new("paper.docx"),
            Path::new("paper.tex"),
        ));
        assert!(move_crosses_docx_boundary(
            Path::new("paper.tex"),
            Path::new("paper.docx"),
        ));
        assert!(!move_crosses_docx_boundary(
            Path::new("paper.docx"),
            Path::new("archive/final.DOCX"),
        ));
        assert!(!move_crosses_docx_boundary(
            Path::new("legacy.doc"),
            Path::new("archive/legacy.doc"),
        ));
        assert!(!move_crosses_docx_boundary(
            Path::new("paper.tex"),
            Path::new("archive/paper.tex"),
        ));
    }
}
