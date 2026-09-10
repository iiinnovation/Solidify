//! Bounded dependency inspection of the classic Tesseract traineddata format.
//! This checks the container/config, not the validity of the recognition model.
use super::{invalid, SandboxError};
use std::collections::BTreeSet;
use std::io::{Read, Seek, SeekFrom};

pub(super) fn language_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

pub(super) fn dependencies(
    file: &mut (impl Read + Seek),
    bytes: u64,
) -> Result<BTreeSet<String>, SandboxError> {
    let malformed = || invalid("OCR 模型容器或内置配置无效/不受支持");
    file.seek(SeekFrom::Start(0)).map_err(|_| malformed())?;
    let mut count = [0; 4];
    file.read_exact(&mut count).map_err(|_| malformed())?;
    // Restrict the package contract to classic little-endian containers.
    let count = u32::from_le_bytes(count) as usize;
    if !(1..=64).contains(&count) || bytes < 4 + count as u64 * 8 {
        return Err(malformed());
    }
    let mut offsets = Vec::with_capacity(count);
    let mut end = 4 + count as u64 * 8;
    for _ in 0..count {
        let mut value = [0; 8];
        file.read_exact(&mut value).map_err(|_| malformed())?;
        let offset = i64::from_le_bytes(value);
        if offset != -1 {
            if offset < 0 || (offset as u64) < end || offset as u64 > bytes {
                return Err(malformed());
            }
            end = offset as u64;
        }
        offsets.push(offset);
    }
    let first = offsets.iter().copied().find(|offset| *offset != -1);
    if first != Some((4 + count * 8) as i64) {
        return Err(malformed());
    }
    if offsets[0] == -1 {
        return Ok(BTreeSet::new());
    }
    let start = offsets[0] as u64;
    let end = offsets
        .iter()
        .skip(1)
        .find(|offset| **offset != -1)
        .map_or(bytes, |offset| *offset as u64);
    if end - start > 64 * 1024 {
        return Err(malformed());
    }
    file.seek(SeekFrom::Start(start)).map_err(|_| malformed())?;
    let mut config = vec![0; (end - start) as usize];
    file.read_exact(&mut config).map_err(|_| malformed())?;
    let config = std::str::from_utf8(&config).map_err(|_| malformed())?;
    if config
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err(malformed());
    }
    let mut result = BTreeSet::new();
    let mut declared = false;
    for line in config.lines() {
        // ParamUtils uses a fixed MAX_PATH buffer and does not trim string
        // values. Keep lines below every supported platform's buffer size.
        if line.len() > 254 {
            return Err(malformed());
        }
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with(char::is_whitespace) {
            return Err(malformed());
        }
        let mut fields = line.splitn(2, [' ', '\t']);
        if fields.next() != Some("tessedit_load_sublangs") {
            continue;
        }
        if declared {
            return Err(malformed());
        }
        declared = true;
        let value = fields.next().unwrap_or("").trim_start_matches([' ', '\t']);
        if !value.is_empty() {
            for name in value.split('+') {
                // Exclusions, paths and inline comments are outside this contract.
                if !language_name(name) {
                    return Err(malformed());
                }
                result.insert(name.to_string());
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
pub(crate) fn fixture(config: &str) -> Vec<u8> {
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend_from_slice(&20i64.to_le_bytes());
    data.extend_from_slice(&(20 + config.len() as i64).to_le_bytes());
    data.extend_from_slice(config.as_bytes());
    data.push(0); // Non-model payload: never executable OCR evidence.
    data
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "Reads pinned best and Homebrew models to verify the config parser"]
    fn inspect_complete_development_model_dependencies() {
        use std::fs::File;
        use std::path::PathBuf;
        let directory = PathBuf::from(
            std::env::var_os("SOLIDIFY_TEST_BEST_TESSDATA")
                .expect("set pinned best model directory"),
        );
        assert!(directory.is_absolute());
        for (root, languages) in [
            (directory, vec!["chi_sim", "eng", "chi_sim_vert"]),
            (
                PathBuf::from("/usr/local/share/tessdata"),
                vec!["chi_sim", "eng"],
            ),
        ] {
            for language in &languages {
                let mut file = File::open(root.join(format!("{language}.traineddata"))).unwrap();
                let bytes = file.metadata().unwrap().len();
                let actual = dependencies(&mut file, bytes).unwrap();
                let expected = if languages.len() == 3 && *language == "chi_sim" {
                    ["chi_sim_vert".into()].into()
                } else {
                    BTreeSet::new()
                };
                assert_eq!(actual, expected, "{language}");
            }
        }
    }

    #[test]
    fn inspects_config_and_rejects_ambiguous_or_unsafe_dependencies() {
        let read = |data: Vec<u8>| dependencies(&mut Cursor::new(&data), data.len() as u64);
        assert_eq!(
            read(fixture(
                "# config\ntessedit_load_sublangs chi_sim_vert+eng\n"
            ))
            .unwrap(),
            ["chi_sim_vert".into(), "eng".into()].into()
        );
        assert!(read(fixture("preserve_interword_spaces 1\n"))
            .unwrap()
            .is_empty());
        for config in [
            "tessedit_load_sublangs ../eng",
            "tessedit_load_sublangs ^eng",
            "tessedit_load_sublangs ~eng",
            "tessedit_load_sublangs eng ",
            " tessedit_load_sublangs eng",
            "tessedit_load_sublangs eng+",
            "tessedit_load_sublangs eng # comment",
            "tessedit_load_sublangs eng\ntessedit_load_sublangs chi_sim",
            "bad\0config",
        ] {
            assert!(read(fixture(config)).is_err(), "{config:?}");
        }
        assert!(read(fixture(&"x".repeat(65537))).is_err());
        assert!(read(fixture(&format!(
            "#{}tessedit_load_sublangs eng",
            "x".repeat(1023)
        )))
        .is_err());
        let mut no_config = fixture("");
        no_config[4..12].copy_from_slice(&(-1i64).to_le_bytes());
        assert!(read(no_config).unwrap().is_empty());
        for data in [vec![], b"test".to_vec(), vec![255; 32]] {
            assert!(read(data).is_err());
        }
        let valid = fixture("tessedit_load_sublangs eng\n");
        for length in 0..valid.len() - 1 {
            assert!(read(valid[..length].to_vec()).is_err());
        }
        for offset in [-2i64, 0, 19, 10000] {
            let mut data = valid.clone();
            data[4..12].copy_from_slice(&offset.to_le_bytes());
            assert!(read(data).is_err());
        }
    }
}
