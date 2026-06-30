use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::Duration,
};

const MANAGED_MARKER: &str = ".unreal-mod-manager-owned.json";
const PACK_EXTS: [&str; 3] = [".pak", ".ucas", ".utoc"];
const ARCHIVE_EXTS: [&str; 3] = [".zip", ".7z", ".rar"];
const PREVIEW_EXTS: [&str; 10] = [
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".mp4", ".webm", ".mov", ".mkv",
];
const GENERIC_CONTAINER_NAMES: [&str; 7] =
    ["archive", "archives", "unzipped", "unzip", "extracted", "mods", "mod"];

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    #[serde(default)]
    library_folders: Vec<String>,
    #[serde(default)]
    game_folder: String,
    #[serde(default = "default_lists")]
    mod_lists: Vec<ModList>,
    #[serde(default)]
    scan: Scan,
    #[serde(default)]
    selected_mod_folder_id: String,
    #[serde(default)]
    selected_pack_id: String,
    #[serde(default)]
    ui: Value,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModList {
    id: String,
    name: String,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    priority: String,
    #[serde(default)]
    items: Vec<ListItem>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct ListItem {
    #[serde(rename = "type")]
    item_type: String,
    id: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scan {
    #[serde(default)]
    mod_folders: Vec<ModFolder>,
    #[serde(default)]
    mod_packs: Vec<ModPack>,
    #[serde(default)]
    archives: Vec<ArchiveInfo>,
    #[serde(default)]
    errors: Vec<ScanError>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModFolder {
    id: String,
    name: String,
    raw_name: String,
    source: String,
    origin: String,
    #[serde(default)]
    delete_target: Option<String>,
    #[serde(default)]
    previews: Vec<Preview>,
    #[serde(default)]
    pack_ids: Vec<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModPack {
    id: String,
    name: String,
    base: String,
    mod_folder_id: String,
    mod_folder_name: String,
    source: String,
    origin: String,
    directory: String,
    #[serde(default)]
    priority: Option<String>,
    #[serde(default)]
    resolved_priority: Option<String>,
    #[serde(default)]
    files: HashMap<String, FileRef>,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    previews: Vec<Preview>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileRef {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    archive_path: Option<String>,
    #[serde(default)]
    entry_path: Option<String>,
    #[serde(default)]
    size: u64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preview {
    id: String,
    name: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    entry_path: String,
    #[serde(default)]
    archive_path: String,
    url: String,
    #[serde(rename = "type")]
    preview_type: String,
    mod_name: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct ArchiveInfo {
    id: String,
    path: String,
    name: String,
    #[serde(default)]
    size: u64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct ScanError {
    path: String,
    message: String,
}

#[derive(Clone)]
struct Group {
    root: Option<String>,
    archive_path: Option<String>,
    mod_name: String,
    mod_path: Option<String>,
    base: String,
    source: String,
    directory: String,
    size: u64,
    files: HashMap<String, FileRef>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    enabled_packs: Vec<ModPack>,
    actions: Vec<PlanAction>,
    estimated_copy_bytes: u64,
    game_folder: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct PlanAction {
    #[serde(rename = "type")]
    action_type: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    pack_id: String,
    #[serde(default)]
    ext: String,
    #[serde(default)]
    method: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Managed {
    #[serde(default)]
    files: Vec<ManagedFile>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct ManagedFile {
    target: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeletePreview {
    source: String,
    target: String,
    target_kind: String,
    folders: Vec<DeleteFolder>,
    has_listed_packs: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteFolder {
    id: String,
    name: String,
    source: String,
    origin: String,
    #[serde(default)]
    delete_target: Option<String>,
    listed_packs: Vec<ListedPack>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct ListedPack {
    id: String,
    name: String,
    lists: Vec<String>,
}

fn default_lists() -> Vec<ModList> {
    vec![ModList {
        id: "favorites".into(),
        name: "Favorites".into(),
        enabled: true,
        pinned: true,
        hidden: false,
        priority: String::new(),
        items: vec![],
    }]
}

fn app_data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("Could not find local app data directory.")?;
    Ok(base.join("Unreal Mod Manager"))
}

fn state_file() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("state.json"))
}

fn cache_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("cache"))
}

fn ensure_dirs() -> Result<(), String> {
    fs::create_dir_all(app_data_dir()?).map_err(|e| e.to_string())?;
    fs::create_dir_all(cache_dir()?).map_err(|e| e.to_string())?;
    Ok(())
}

fn id_for(value: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())[..16].to_string()
}

fn clean_ext(path: &str) -> String {
    let lower = path.to_lowercase();
    let without_disabled = lower.strip_suffix(".disabled").unwrap_or(&lower);
    Path::new(without_disabled)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}

fn pack_base(path: &str) -> String {
    let without_disabled = path.strip_suffix(".disabled").unwrap_or(path);
    Path::new(without_disabled)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn human_name(value: &str) -> String {
    let stem = Path::new(value)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| value.to_string());
    stem.replace(['_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn human_pack_name(value: &str) -> String {
    let re_priority_p = Regex::new(r"(?i)\s+\d{4,}\s+P$").unwrap();
    let re_priority = Regex::new(r"(?i)\s+\d{4,}$").unwrap();
    let re_p = Regex::new(r"(?i)\s+P$").unwrap();
    let name = human_name(value);
    re_p.replace(&re_priority.replace(&re_priority_p.replace(&name, ""), ""), "")
        .trim()
        .to_string()
}

fn parse_priority(value: &str) -> Option<String> {
    let re = Regex::new(r"\d{4,}").unwrap();
    re.find_iter(value)
        .filter_map(|m| m.as_str().parse::<u64>().ok())
        .max()
        .map(|n| n.to_string())
}

fn is_preview_ext(ext: &str) -> bool {
    PREVIEW_EXTS.contains(&ext)
}

fn is_archive_ext(ext: &str) -> bool {
    ARCHIVE_EXTS.contains(&ext)
}

fn is_pack_ext(ext: &str) -> bool {
    PACK_EXTS.contains(&ext)
}

fn top_mod_info(root: &Path, file_path: &Path) -> (String, PathBuf) {
    let rel = file_path.strip_prefix(root).unwrap_or(file_path);
    let original_parts: Vec<_> = rel.components().map(|c| c.as_os_str().to_owned()).collect();
    let mut parts: Vec<String> = original_parts
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    let mut skipped = 0usize;
    while parts.len() > 1 && GENERIC_CONTAINER_NAMES.contains(&parts[0].to_lowercase().as_str()) {
        parts.remove(0);
        skipped += 1;
    }
    if parts.len() > 1 {
        let mut dir = root.to_path_buf();
        for part in original_parts.iter().take(skipped + 1) {
            dir.push(part);
        }
        (parts[0].clone(), dir)
    } else {
        (
            root.file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| root.to_string_lossy().to_string()),
            root.to_path_buf(),
        )
    }
}

fn archive_mod_name(archive_base: &str, entry_path: &str) -> String {
    let mut parts: Vec<String> = entry_path
        .split('/')
        .filter(|p| !p.is_empty())
        .map(|p| p.to_string())
        .collect();
    while parts.len() > 1 && GENERIC_CONTAINER_NAMES.contains(&parts[0].to_lowercase().as_str()) {
        parts.remove(0);
    }
    if parts.len() > 1 {
        parts[0].clone()
    } else {
        archive_base.to_string()
    }
}

fn encode_query_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

fn walk_files(root: &Path, out: &mut Vec<(PathBuf, u64)>) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, out);
        } else if path.is_file() {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push((path, size));
        }
    }
}

fn complete_pack(group: &Group) -> bool {
    ["pak", "ucas", "utoc"]
        .iter()
        .all(|ext| group.files.contains_key(*ext))
}

fn group_folder_preview(previews: &[Preview], mod_name: &str) -> Vec<Preview> {
    let needle = mod_name.to_lowercase();
    let mut items: Vec<_> = previews
        .iter()
        .filter(|p| p.mod_name == mod_name)
        .cloned()
        .collect();
    items.sort_by(|a, b| {
        let an = if a.name.to_lowercase().contains(&needle) { 0 } else { 1 };
        let bn = if b.name.to_lowercase().contains(&needle) { 0 } else { 1 };
        an.cmp(&bn).then_with(|| a.name.cmp(&b.name))
    });
    items.truncate(24);
    items
}

fn scan_directory(root: &Path) -> (Vec<Group>, Vec<Preview>, Vec<ArchiveInfo>) {
    let mut files = vec![];
    walk_files(root, &mut files);
    let mut groups: HashMap<String, Group> = HashMap::new();
    let mut previews = vec![];
    let mut archives = vec![];
    for (file_path, size) in files {
        let path_string = file_path.to_string_lossy().to_string();
        let ext = clean_ext(&path_string);
        if is_preview_ext(&ext) {
            let (mod_name, _) = top_mod_info(root, &file_path);
            let is_video = matches!(ext.as_str(), ".mp4" | ".webm" | ".mov" | ".mkv");
            previews.push(Preview {
                id: id_for(&path_string),
                name: file_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                path: path_string.clone(),
                url: path_string.clone(),
                preview_type: if is_video { "video" } else { "image" }.into(),
                mod_name,
                ..Default::default()
            });
        }
        if is_archive_ext(&ext) {
            archives.push(ArchiveInfo {
                id: id_for(&path_string),
                path: path_string.clone(),
                name: file_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                size,
            });
            continue;
        }
        if !is_pack_ext(&ext) {
            continue;
        }
        let base = pack_base(&path_string);
        let (mod_name, mod_path) = top_mod_info(root, &file_path);
        let dir = file_path.parent().unwrap_or(root).to_string_lossy().to_string();
        let key = format!("{}|{}|{}|{}", root.to_string_lossy(), mod_name, dir, base);
        let group = groups.entry(key).or_insert_with(|| Group {
            root: Some(root.to_string_lossy().to_string()),
            archive_path: None,
            mod_name: mod_name.clone(),
            mod_path: Some(mod_path.to_string_lossy().to_string()),
            base: base.clone(),
            source: "folder".into(),
            directory: dir,
            size: 0,
            files: HashMap::new(),
        });
        group.files.insert(
            ext.trim_start_matches('.').to_string(),
            FileRef {
                path: Some(path_string),
                size,
                ..Default::default()
            },
        );
        group.size += size;
    }
    (groups.into_values().collect(), previews, archives)
}

#[derive(Default)]
struct ArchiveEntry {
    path: String,
    folder: bool,
    size: u64,
}

fn parse_7z_list(output: &str, archive_path: &str) -> Vec<ArchiveEntry> {
    let mut entries = vec![];
    let mut current = ArchiveEntry::default();
    let mut has_current = false;
    for raw in output.lines() {
        let Some((key, value)) = raw.trim_end().split_once(" = ") else {
            continue;
        };
        if key == "Path" {
            if has_current && !current.path.is_empty() && current.path != archive_path {
                entries.push(current);
            }
            current = ArchiveEntry {
                path: value.to_string(),
                ..Default::default()
            };
            has_current = true;
        } else if has_current {
            if key == "Folder" {
                current.folder = value == "+";
            }
            if key == "Size" {
                current.size = value.parse().unwrap_or(0);
            }
        }
    }
    if has_current && !current.path.is_empty() && current.path != archive_path {
        entries.push(current);
    }
    entries.into_iter().filter(|e| !e.folder).collect()
}

fn list_archive(archive_path: &str) -> Result<Vec<ArchiveEntry>, String> {
    let output = Command::new("7z")
        .args(["l", "-slt", archive_path])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        });
    }
    Ok(parse_7z_list(&String::from_utf8_lossy(&output.stdout), archive_path))
}

fn scan_archive(archive_path: &str) -> Result<(Vec<Group>, Vec<Preview>), String> {
    let entries = list_archive(archive_path)?;
    let archive_base = human_name(
        Path::new(archive_path)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .as_ref(),
    );
    let mut groups: HashMap<String, Group> = HashMap::new();
    let mut previews = vec![];
    for entry in entries {
        let normalized = entry.path.replace('\\', "/");
        let ext = clean_ext(&normalized);
        let mod_name = archive_mod_name(&archive_base, &normalized);
        if is_preview_ext(&ext) {
            let is_video = matches!(ext.as_str(), ".mp4" | ".webm" | ".mov" | ".mkv");
            previews.push(Preview {
                id: id_for(&format!("{}|{}", archive_path, entry.path)),
                name: Path::new(&entry.path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                entry_path: entry.path.clone(),
                archive_path: archive_path.to_string(),
                url: format!(
                    "/api/archive-file?archive={}&entry={}",
                    encode_query_component(archive_path),
                    encode_query_component(&entry.path)
                ),
                preview_type: if is_video { "video" } else { "image" }.into(),
                mod_name: mod_name.clone(),
                ..Default::default()
            });
        }
        if !is_pack_ext(&ext) {
            continue;
        }
        let base = pack_base(&normalized);
        let dir = Path::new(&normalized)
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| ".".into());
        let key = format!("{}|{}|{}|{}", archive_path, mod_name, dir, base);
        let group = groups.entry(key).or_insert_with(|| Group {
            root: None,
            archive_path: Some(archive_path.to_string()),
            mod_name: mod_name.clone(),
            mod_path: None,
            base: base.clone(),
            source: "archive".into(),
            directory: dir,
            size: 0,
            files: HashMap::new(),
        });
        group.files.insert(
            ext.trim_start_matches('.').to_string(),
            FileRef {
                archive_path: Some(archive_path.to_string()),
                entry_path: Some(entry.path),
                size: entry.size,
                ..Default::default()
            },
        );
        group.size += entry.size;
    }
    Ok((groups.into_values().collect(), previews))
}

fn scan_libraries(library_folders: &[String]) -> Scan {
    let mut errors = vec![];
    let mut all_groups = vec![];
    let mut all_previews = vec![];
    let mut archives = vec![];
    for root in library_folders {
        let root_path = Path::new(root);
        let (groups, previews, found_archives) = scan_directory(root_path);
        all_groups.extend(groups);
        all_previews.extend(previews);
        archives.extend(found_archives.clone());
        for archive in found_archives {
            match scan_archive(&archive.path) {
                Ok((groups, previews)) => {
                    all_groups.extend(groups);
                    all_previews.extend(previews);
                }
                Err(message) => errors.push(ScanError {
                    path: archive.path,
                    message,
                }),
            }
        }
    }

    let mut folders_by_key: HashMap<String, ModFolder> = HashMap::new();
    let mut packs = vec![];
    for group in all_groups.into_iter().filter(complete_pack) {
        let origin = if group.source == "archive" {
            group.archive_path.clone().unwrap_or_default()
        } else {
            group.root.clone().unwrap_or_default()
        };
        let folder_key = format!("{}|{}", origin, group.mod_name);
        let folder = folders_by_key.entry(folder_key.clone()).or_insert_with(|| ModFolder {
            id: id_for(&folder_key),
            name: human_name(&group.mod_name),
            raw_name: group.mod_name.clone(),
            source: group.source.clone(),
            origin: origin.clone(),
            delete_target: if group.source == "archive" {
                group.archive_path.clone()
            } else {
                group.mod_path.clone()
            },
            previews: vec![],
            pack_ids: vec![],
        });
        let id = id_for(&format!("{}|{}|{}", folder_key, group.directory, group.base));
        let pack = ModPack {
            id: id.clone(),
            name: human_pack_name(&group.base),
            base: group.base.clone(),
            mod_folder_id: folder.id.clone(),
            mod_folder_name: folder.name.clone(),
            source: group.source,
            origin,
            directory: group.directory,
            priority: parse_priority(&group.base),
            files: group.files,
            size: group.size,
            previews: vec![],
            resolved_priority: None,
        };
        folder.pack_ids.push(id);
        packs.push(pack);
    }
    let mut folders: Vec<ModFolder> = folders_by_key.into_values().collect();
    for folder in &mut folders {
        folder.previews = group_folder_preview(&all_previews, &folder.raw_name);
    }
    for pack in &mut packs {
        if let Some(folder) = folders.iter().find(|f| f.id == pack.mod_folder_id) {
            pack.previews = group_folder_preview(&all_previews, &folder.raw_name)
                .into_iter()
                .take(8)
                .collect();
        }
    }
    folders.sort_by(|a, b| a.name.cmp(&b.name));
    packs.sort_by(|a, b| a.name.cmp(&b.name));
    Scan {
        mod_folders: folders,
        mod_packs: packs,
        archives,
        errors,
    }
}

fn validate_lists(lists: &[ModList]) -> Result<(), String> {
    let map: HashMap<_, _> = lists.iter().map(|l| (l.id.as_str(), l)).collect();
    fn contains<'a>(
        map: &HashMap<&'a str, &'a ModList>,
        list_id: &'a str,
        target: &'a str,
        seen: &mut HashSet<&'a str>,
    ) -> bool {
        if list_id == target {
            return true;
        }
        if !seen.insert(list_id) {
            return false;
        }
        map.get(list_id).is_some_and(|list| {
            list.items
                .iter()
                .any(|item| item.item_type == "list" && contains(map, &item.id, target, seen))
        })
    }
    for list in lists {
        for item in &list.items {
            if item.item_type == "list" && contains(&map, &item.id, &list.id, &mut HashSet::new()) {
                return Err(format!("Mod list cycle detected at {}", list.name));
            }
        }
    }
    Ok(())
}

fn resolve_enabled_packs(state: &State) -> Vec<ModPack> {
    let packs: HashMap<_, _> = state.scan.mod_packs.iter().map(|p| (p.id.clone(), p)).collect();
    let lists: HashMap<_, _> = state.mod_lists.iter().map(|l| (l.id.clone(), l)).collect();
    let mut resolved: HashMap<String, ModPack> = HashMap::new();

    fn visit(
        list_id: &str,
        inherited_priority: &str,
        packs: &HashMap<String, &ModPack>,
        lists: &HashMap<String, &ModList>,
        resolved: &mut HashMap<String, ModPack>,
        seen: &mut HashSet<String>,
    ) {
        if !seen.insert(list_id.to_string()) {
            return;
        }
        let Some(list) = lists.get(list_id) else { return };
        let priority = if list.priority.is_empty() {
            inherited_priority
        } else {
            &list.priority
        };
        for item in &list.items {
            if item.item_type == "pack" {
                if let Some(pack) = packs.get(&item.id) {
                    let mut pack = (*pack).clone();
                    pack.resolved_priority = Some(
                        if priority.is_empty() {
                            pack.priority.clone().unwrap_or_else(|| "9999999".into())
                        } else {
                            priority.to_string()
                        },
                    );
                    resolved.entry(pack.id.clone()).or_insert(pack);
                }
            } else if item.item_type == "list" {
                visit(&item.id, priority, packs, lists, resolved, seen);
            }
        }
    }
    for list in state.mod_lists.iter().filter(|l| l.enabled) {
        visit(&list.id, &list.priority, &packs, &lists, &mut resolved, &mut HashSet::new());
    }
    let mut out: Vec<_> = resolved.into_values().collect();
    out.sort_by(|a, b| {
        a.resolved_priority
            .as_deref()
            .unwrap_or("9999999")
            .parse::<u64>()
            .unwrap_or(9999999)
            .cmp(
                &b.resolved_priority
                    .as_deref()
                    .unwrap_or("9999999")
                    .parse::<u64>()
                    .unwrap_or(9999999),
            )
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

fn safe_folder_name(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect::<String>()
        .trim()
        .to_string();
    if sanitized.is_empty() {
        "Mod".into()
    } else {
        sanitized
    }
}

fn staged_name(pack: &ModPack, ext: &str) -> String {
    let safe_base = safe_folder_name(&pack.base);
    let priority = pack
        .resolved_priority
        .clone()
        .or_else(|| pack.priority.clone())
        .unwrap_or_else(|| "9999999".into());
    let re = Regex::new(r"\d{4,}").unwrap();
    format!("{}.{}", re.replace_all(&safe_base, priority), ext)
}

fn read_managed(game_folder: &str) -> Managed {
    let path = Path::new(game_folder).join(MANAGED_MARKER);
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_managed(game_folder: &str, files: &[ManagedFile]) -> Result<(), String> {
    let path = Path::new(game_folder).join(MANAGED_MARKER);
    let value = serde_json::json!({
        "updatedAt": "native",
        "files": files
    });
    fs::write(path, serde_json::to_string_pretty(&value).unwrap()).map_err(|e| e.to_string())
}

fn build_plan_inner(state: &State) -> Result<Plan, String> {
    if state.game_folder.is_empty() {
        return Err("Set a game mods folder before applying.".into());
    }
    let enabled = resolve_enabled_packs(state);
    let managed = read_managed(&state.game_folder);
    let mut wanted = vec![];
    for pack in &enabled {
        let folder = safe_folder_name(&pack.mod_folder_name);
        for ext in ["pak", "ucas", "utoc"] {
            if let Some(file_ref) = pack.files.get(ext) {
                let target = Path::new(&state.game_folder)
                    .join(&folder)
                    .join(staged_name(pack, ext));
                wanted.push((pack.clone(), ext.to_string(), file_ref.clone(), target));
            }
        }
    }
    let wanted_targets: HashSet<String> = wanted
        .iter()
        .map(|(_, _, _, target)| target.to_string_lossy().to_string())
        .collect();
    let mut actions = vec![];
    let mut estimated_copy_bytes = 0u64;
    for (pack, ext, file_ref, target) in &wanted {
        let active = target.to_string_lossy().to_string();
        let disabled = format!("{}.disabled", active);
        if !Path::new(&active).exists() && !Path::new(&disabled).exists() {
            estimated_copy_bytes += file_ref.size;
            actions.push(PlanAction {
                action_type: "stage".into(),
                source: file_ref
                    .path
                    .clone()
                    .unwrap_or_else(|| format!("{}::{}", file_ref.archive_path.clone().unwrap_or_default(), file_ref.entry_path.clone().unwrap_or_default())),
                target: active,
                size: file_ref.size,
                pack_id: pack.id.clone(),
                ext: ext.clone(),
                ..Default::default()
            });
        } else if Path::new(&disabled).exists() {
            actions.push(PlanAction {
                action_type: "enable".into(),
                target: active,
                pack_id: pack.id.clone(),
                ext: ext.clone(),
                ..Default::default()
            });
        }
    }
    for file in managed.files {
        if !wanted_targets.contains(&file.target) && Path::new(&file.target).exists() {
            actions.push(PlanAction {
                action_type: "disable".into(),
                target: file.target,
                ..Default::default()
            });
        }
    }
    Ok(Plan {
        enabled_packs: enabled,
        actions,
        estimated_copy_bytes,
        game_folder: state.game_folder.clone(),
    })
}

fn extract_archive_entry(archive_path: &str, entry_path: &str) -> Result<String, String> {
    let key = id_for(&format!("{}|{}", archive_path, entry_path));
    let dest_dir = cache_dir()?.join("archive").join(key);
    let dest = dest_dir.join(Path::new(entry_path).file_name().unwrap_or_default());
    if dest.exists() {
        return Ok(dest.to_string_lossy().to_string());
    }
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let status = Command::new("7z")
        .arg("e")
        .arg("-y")
        .arg(format!("-o{}", dest_dir.to_string_lossy()))
        .arg(archive_path)
        .arg(entry_path)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("7z exited with {}", status));
    }
    Ok(dest.to_string_lossy().to_string())
}

fn source_path_for(file_ref: &FileRef) -> Result<String, String> {
    if let Some(path) = &file_ref.path {
        Ok(path.clone())
    } else {
        extract_archive_entry(
            file_ref.archive_path.as_deref().unwrap_or_default(),
            file_ref.entry_path.as_deref().unwrap_or_default(),
        )
    }
}

fn stage_file(source: &str, target: &str) -> Result<String, String> {
    if let Some(parent) = Path::new(target).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    match fs::hard_link(source, target) {
        Ok(_) => Ok("hardlink".into()),
        Err(_) => {
            fs::copy(source, target).map_err(|e| e.to_string())?;
            Ok("copy".into())
        }
    }
}

fn apply_plan_inner(state: &State) -> Result<Plan, String> {
    let mut plan = build_plan_inner(state)?;
    for action in &mut plan.actions {
        match action.action_type.as_str() {
            "stage" => {
                let pack = plan
                    .enabled_packs
                    .iter()
                    .find(|pack| pack.id == action.pack_id)
                    .ok_or("Pack missing from plan.")?;
                let file_ref = pack.files.get(&action.ext).ok_or("Pack file missing from plan.")?;
                let source = source_path_for(file_ref)?;
                action.method = stage_file(&source, &action.target)?;
            }
            "enable" => {
                let disabled = format!("{}.disabled", action.target);
                if Path::new(&disabled).exists() {
                    fs::rename(disabled, &action.target).map_err(|e| e.to_string())?;
                }
            }
            "disable" => {
                let disabled = format!("{}.disabled", action.target);
                if Path::new(&action.target).exists() {
                    fs::rename(&action.target, disabled).map_err(|e| e.to_string())?;
                }
            }
            _ => {}
        }
    }
    let mut managed_files = vec![];
    for pack in &plan.enabled_packs {
        for ext in ["pak", "ucas", "utoc"] {
            managed_files.push(ManagedFile {
                target: Path::new(&state.game_folder)
                    .join(safe_folder_name(&pack.mod_folder_name))
                    .join(staged_name(pack, ext))
                    .to_string_lossy()
                    .to_string(),
            });
        }
    }
    let mut seen = HashSet::new();
    managed_files.retain(|file| seen.insert(file.target.clone()));
    write_managed(&state.game_folder, &managed_files)?;
    Ok(plan)
}

fn same_path(a: &str, b: &str) -> bool {
    let ca = fs::canonicalize(a).unwrap_or_else(|_| PathBuf::from(a));
    let cb = fs::canonicalize(b).unwrap_or_else(|_| PathBuf::from(b));
    ca.to_string_lossy().to_lowercase() == cb.to_string_lossy().to_lowercase()
}

fn path_contains(parent: &str, child: &str) -> bool {
    let parent = fs::canonicalize(parent).unwrap_or_else(|_| PathBuf::from(parent));
    let child = fs::canonicalize(child).unwrap_or_else(|_| PathBuf::from(child));
    child.starts_with(parent)
}

fn pack_list_membership(state: &State) -> HashMap<String, Vec<String>> {
    let mut membership: HashMap<String, Vec<String>> = HashMap::new();
    for list in &state.mod_lists {
        for item in &list.items {
            if item.item_type == "pack" {
                membership.entry(item.id.clone()).or_default().push(list.name.clone());
            }
        }
    }
    membership
}

fn delete_source_preview_inner(state: &State, folder_id: &str) -> Result<DeletePreview, String> {
    let selected = state
        .scan
        .mod_folders
        .iter()
        .find(|f| f.id == folder_id)
        .ok_or("Mod folder was not found in the current scan.")?;
    let target = selected
        .delete_target
        .clone()
        .or_else(|| (selected.source == "archive").then(|| selected.origin.clone()))
        .ok_or("This mod folder needs to be scanned again before it can be deleted.")?;
    let affected: Vec<_> = if selected.source == "archive" {
        state
            .scan
            .mod_folders
            .iter()
            .filter(|f| f.source == "archive" && same_path(&f.origin, &selected.origin))
            .collect()
    } else {
        state
            .scan
            .mod_folders
            .iter()
            .filter(|f| f.source == "folder" && f.delete_target.as_ref().is_some_and(|p| path_contains(&target, p)))
            .collect()
    };
    let membership = pack_list_membership(state);
    let mut packs_by_folder: HashMap<String, Vec<&ModPack>> = HashMap::new();
    for pack in &state.scan.mod_packs {
        packs_by_folder.entry(pack.mod_folder_id.clone()).or_default().push(pack);
    }
    let folders: Vec<_> = affected
        .into_iter()
        .map(|folder| {
            let listed_packs = packs_by_folder
                .get(&folder.id)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|pack| {
                    membership.get(&pack.id).map(|lists| ListedPack {
                        id: pack.id.clone(),
                        name: pack.name.clone(),
                        lists: lists.clone(),
                    })
                })
                .collect();
            DeleteFolder {
                id: folder.id.clone(),
                name: folder.name.clone(),
                source: folder.source.clone(),
                origin: folder.origin.clone(),
                delete_target: folder.delete_target.clone(),
                listed_packs,
            }
        })
        .collect();
    Ok(DeletePreview {
        source: selected.source.clone(),
        target,
        target_kind: if selected.source == "archive" { "archive" } else { "folder" }.into(),
        has_listed_packs: folders.iter().any(|f| !f.listed_packs.is_empty()),
        folders,
    })
}

fn assert_delete_target_allowed(state: &State, target: &str) -> Result<(), String> {
    if state.library_folders.iter().any(|root| path_contains(root, target)) {
        Ok(())
    } else {
        Err("Delete target is outside the configured library folders.".into())
    }
}

fn remove_path_for_delete(target: &str, recursive: bool) -> Result<(), String> {
    let mut last_error: Option<io::Error> = None;
    for delay in [0, 150, 500, 1000] {
        if delay > 0 {
            thread::sleep(Duration::from_millis(delay));
        }
        if let Ok(metadata) = fs::metadata(target) {
            let mut permissions = metadata.permissions();
            permissions.set_readonly(false);
            let _ = fs::set_permissions(target, permissions);
        }
        let result = if recursive {
            fs::remove_dir_all(target)
        } else {
            fs::remove_file(target)
        };
        match result {
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => last_error = Some(e),
        }
    }
    Err(format!(
        "Windows would not delete this {}. Close any app that may be using it, then try again. Original error: {}",
        if recursive { "folder" } else { "archive" },
        last_error.map(|e| e.to_string()).unwrap_or_else(|| "unknown".into())
    ))
}

fn delete_mod_source_inner(mut state: State, folder_id: &str) -> Result<serde_json::Value, String> {
    let preview = delete_source_preview_inner(&state, folder_id)?;
    assert_delete_target_allowed(&state, &preview.target)?;
    remove_path_for_delete(&preview.target, preview.source != "archive")?;
    state.scan = scan_libraries(&state.library_folders);
    let folder_ids: HashSet<_> = state.scan.mod_folders.iter().map(|f| f.id.as_str()).collect();
    let pack_ids: HashSet<_> = state.scan.mod_packs.iter().map(|p| p.id.as_str()).collect();
    if !folder_ids.contains(state.selected_mod_folder_id.as_str()) {
        state.selected_mod_folder_id.clear();
    }
    if !pack_ids.contains(state.selected_pack_id.as_str()) {
        state.selected_pack_id.clear();
    }
    save_state_inner(&state)?;
    Ok(serde_json::json!({ "preview": preview, "state": state }))
}

fn load_state_inner() -> Result<State, String> {
    ensure_dirs()?;
    let path = state_file()?;
    match fs::read_to_string(path) {
        Ok(text) => Ok(serde_json::from_str::<State>(&text).unwrap_or_else(|_| State {
            mod_lists: default_lists(),
            ..Default::default()
        })),
        Err(_) => Ok(State {
            mod_lists: default_lists(),
            ..Default::default()
        }),
    }
}

fn save_state_inner(state: &State) -> Result<State, String> {
    ensure_dirs()?;
    validate_lists(&state.mod_lists)?;
    fs::write(state_file()?, serde_json::to_string_pretty(state).unwrap()).map_err(|e| e.to_string())?;
    Ok(state.clone())
}

fn import_config_inner() -> Result<State, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("Unreal Mod Manager state", &["json"])
        .set_title("Import Unreal Mod Manager config")
        .pick_file()
    else {
        return load_state_inner();
    };
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let imported: State = serde_json::from_str(&text).map_err(|e| format!("Could not read config JSON: {e}"))?;
    validate_lists(&imported.mod_lists)?;

    let current = load_state_inner()?;
    let imported_scan_pack_ids: HashSet<_> = imported
        .scan
        .mod_packs
        .iter()
        .map(|pack| pack.id.as_str())
        .collect();
    let current_scan_pack_ids: HashSet<_> = current
        .scan
        .mod_packs
        .iter()
        .map(|pack| pack.id.as_str())
        .collect();
    let use_imported_scan = !imported.scan.mod_packs.is_empty()
        && imported_scan_pack_ids.iter().any(|id| current_scan_pack_ids.contains(id));

    let mut next = current.clone();
    next.library_folders = imported.library_folders;
    next.game_folder = imported.game_folder;
    next.mod_lists = imported.mod_lists;
    next.ui = imported.ui;
    if use_imported_scan || current.scan.mod_packs.is_empty() {
        next.scan = imported.scan;
    }
    next.selected_mod_folder_id.clear();
    next.selected_pack_id.clear();
    save_state_inner(&next)
}

fn export_config_inner() -> Result<serde_json::Value, String> {
    let state = load_state_inner()?;
    let Some(path) = rfd::FileDialog::new()
        .add_filter("Unreal Mod Manager state", &["json"])
        .set_file_name("unreal-mod-manager-state.json")
        .set_title("Export Unreal Mod Manager config")
        .save_file()
    else {
        return Ok(serde_json::json!({ "path": "" }));
    };
    fs::write(&path, serde_json::to_string_pretty(&state).unwrap()).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "path": path.to_string_lossy().to_string() }))
}

#[tauri::command]
fn get_state() -> Result<State, String> {
    load_state_inner()
}

#[tauri::command]
fn save_state(state: State) -> Result<State, String> {
    save_state_inner(&state)
}

#[tauri::command]
fn pick_folder() -> Result<serde_json::Value, String> {
    let path = rfd::FileDialog::new()
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(serde_json::json!({ "path": path }))
}

#[tauri::command]
fn scan() -> Result<State, String> {
    let mut state = load_state_inner()?;
    state.scan = scan_libraries(&state.library_folders);
    save_state_inner(&state)
}

#[tauri::command]
fn dry_run() -> Result<Plan, String> {
    build_plan_inner(&load_state_inner()?)
}

#[tauri::command]
fn apply() -> Result<Plan, String> {
    apply_plan_inner(&load_state_inner()?)
}

#[tauri::command]
fn delete_source_preview(folder_id: String) -> Result<DeletePreview, String> {
    delete_source_preview_inner(&load_state_inner()?, &folder_id)
}

#[tauri::command]
fn delete_source(folder_id: String) -> Result<serde_json::Value, String> {
    delete_mod_source_inner(load_state_inner()?, &folder_id)
}

#[tauri::command]
fn import_config() -> Result<State, String> {
    import_config_inner()
}

#[tauri::command]
fn export_config() -> Result<serde_json::Value, String> {
    export_config_inner()
}

#[tauri::command]
fn archive_preview(archive_path: String, entry_path: String) -> Result<serde_json::Value, String> {
    let path = extract_archive_entry(&archive_path, &entry_path)?;
    Ok(serde_json::json!({ "path": path }))
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_state,
            save_state,
            pick_folder,
            scan,
            dry_run,
            apply,
            delete_source_preview,
            delete_source,
            import_config,
            export_config,
            archive_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
