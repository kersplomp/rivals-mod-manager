const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const CACHE = path.join(ROOT, "cache");
const STATE_FILE = path.join(DATA, "state.json");
const MANAGED_MARKER = ".unreal-mod-manager-owned.json";
const PACK_EXTS = new Set([".pak", ".ucas", ".utoc"]);
const ARCHIVE_EXTS = new Set([".zip", ".7z", ".rar"]);
const PREVIEW_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".mp4", ".webm", ".mov", ".mkv"]);
const GENERIC_CONTAINER_NAMES = new Set(["archive", "archives", "unzipped", "unzip", "extracted", "mods", "mod"]);

function idFor(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function cleanExt(filePath) {
  const disabled = filePath.toLowerCase().endsWith(".disabled");
  const withoutDisabled = disabled ? filePath.slice(0, -".disabled".length) : filePath;
  return path.extname(withoutDisabled).toLowerCase();
}

function packBase(filePath) {
  const disabled = filePath.toLowerCase().endsWith(".disabled");
  const withoutDisabled = disabled ? filePath.slice(0, -".disabled".length) : filePath;
  return path.basename(withoutDisabled, path.extname(withoutDisabled));
}

function humanName(value) {
  return path.basename(value, path.extname(value)).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function humanPackName(value) {
  return humanName(value)
    .replace(/\s+\d{4,}\s+P$/i, "")
    .replace(/\s+\d{4,}$/i, "")
    .replace(/\s+P$/i, "")
    .trim();
}

function parsePriority(value) {
  const nums = String(value).match(/\d{4,}/g);
  if (!nums) return null;
  return Math.max(...nums.map((n) => Number(n))).toString();
}

function toUrlPath(filePath) {
  return `/api/file?path=${encodeURIComponent(filePath)}`;
}

async function ensureDirs() {
  await fsp.mkdir(DATA, { recursive: true });
  await fsp.mkdir(CACHE, { recursive: true });
}

function defaultState() {
  return {
    libraryFolders: [],
    gameFolder: "",
    modLists: [
      {
        id: "favorites",
        name: "Favorites",
        enabled: true,
        pinned: true,
        hidden: false,
        priority: "",
        items: []
      }
    ],
    scan: { modFolders: [], modPacks: [], archives: [], errors: [] },
    selectedModFolderId: "",
    selectedPackId: ""
  };
}

async function loadState() {
  await ensureDirs();
  try {
    return { ...defaultState(), ...JSON.parse(await fsp.readFile(STATE_FILE, "utf8")) };
  } catch {
    return defaultState();
  }
}

async function saveState(state) {
  await ensureDirs();
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

async function walkFiles(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(full);
        out.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  await walk(root);
  return out;
}

function topModName(root, filePath) {
  return topModInfo(root, filePath).name;
}

function topModInfo(root, filePath) {
  const rel = path.relative(root, filePath);
  const originalParts = rel.split(path.sep).filter(Boolean);
  const parts = [...originalParts];
  let skipped = 0;
  while (parts.length > 1 && GENERIC_CONTAINER_NAMES.has(parts[0].toLowerCase())) {
    parts.shift();
    skipped += 1;
  }
  if (parts.length > 1) {
    return {
      name: parts[0],
      directory: path.join(root, ...originalParts.slice(0, skipped + 1))
    };
  }
  return { name: path.basename(root), directory: root };
}

function archiveModName(archiveBase, entryPath) {
  const parts = entryPath.split("/").filter(Boolean);
  while (parts.length > 1 && GENERIC_CONTAINER_NAMES.has(parts[0].toLowerCase())) {
    parts.shift();
  }
  return parts.length > 1 ? parts[0] : archiveBase;
}

function groupFolderPreview(previews, modName) {
  const needle = modName.toLowerCase();
  return previews
    .filter((p) => p.modName === modName)
    .sort((a, b) => {
      const aName = a.path || a.entryPath || a.name;
      const bName = b.path || b.entryPath || b.name;
      const an = path.basename(aName).toLowerCase().includes(needle) ? 0 : 1;
      const bn = path.basename(bName).toLowerCase().includes(needle) ? 0 : 1;
      return an - bn || aName.localeCompare(bName);
    })
    .slice(0, 24);
}

async function scanDirectory(root) {
  const files = await walkFiles(root);
  const groups = new Map();
  const previews = [];
  const archives = [];
  for (const file of files) {
    const ext = cleanExt(file.path);
    if (PREVIEW_EXTS.has(ext)) {
      const modInfo = topModInfo(root, file.path);
      previews.push({
        id: idFor(file.path),
        name: path.basename(file.path),
        path: file.path,
        url: toUrlPath(file.path),
        type: ext.match(/mp4|webm|mov|mkv/) ? "video" : "image",
        modName: modInfo.name
      });
    }
    if (ARCHIVE_EXTS.has(ext)) {
      archives.push({ id: idFor(file.path), path: file.path, name: path.basename(file.path), size: file.size });
      continue;
    }
    if (!PACK_EXTS.has(ext)) continue;
    const base = packBase(file.path);
    const modInfo = topModInfo(root, file.path);
    const modName = modInfo.name;
    const key = `${root}|${modName}|${path.dirname(file.path)}|${base}`;
    if (!groups.has(key)) {
      groups.set(key, { root, modName, modPath: modInfo.directory, base, files: {}, source: "folder", directory: path.dirname(file.path), size: 0 });
    }
    const group = groups.get(key);
    group.files[ext.slice(1)] = { path: file.path, size: file.size };
    group.size += file.size;
  }
  return { groups: Array.from(groups.values()), previews, archives };
}

function parse7zList(output, archivePath) {
  const entries = [];
  let current = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const idx = line.indexOf(" = ");
    if (idx < 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 3);
    if (key === "Path") {
      if (current && current.path) entries.push(current);
      current = { path: value, archivePath };
    } else if (current) {
      if (key === "Folder") current.folder = value === "+";
      if (key === "Size") current.size = Number(value) || 0;
    }
  }
  if (current && current.path && current.path !== archivePath) entries.push(current);
  return entries.filter((e) => !e.folder && e.path !== archivePath);
}

async function listArchive(archivePath) {
  const result = spawnSync("7z", ["l", "-slt", archivePath], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "7z could not read archive").trim());
  }
  return parse7zList(result.stdout, archivePath);
}

async function scanArchive(archivePath) {
  const entries = await listArchive(archivePath);
  const groups = new Map();
  const previews = [];
  const archiveBase = path.basename(archivePath, path.extname(archivePath));
  for (const entry of entries) {
    const normalized = entry.path.replaceAll("\\", "/");
    const ext = cleanExt(normalized);
    const modName = archiveModName(archiveBase, normalized);
    if (PREVIEW_EXTS.has(ext)) {
      previews.push({
        id: idFor(`${archivePath}|${entry.path}`),
        name: path.basename(entry.path),
        archivePath,
        entryPath: entry.path,
        url: `/api/archive-file?archive=${encodeURIComponent(archivePath)}&entry=${encodeURIComponent(entry.path)}`,
        type: ext.match(/mp4|webm|mov|mkv/) ? "video" : "image",
        modName
      });
    }
    if (!PACK_EXTS.has(ext)) continue;
    const base = packBase(normalized);
    const dir = path.posix.dirname(normalized);
    const key = `${archivePath}|${modName}|${dir}|${base}`;
    if (!groups.has(key)) {
      groups.set(key, { archivePath, modName, base, files: {}, source: "archive", directory: dir, size: 0 });
    }
    const group = groups.get(key);
    group.files[ext.slice(1)] = { archivePath, entryPath: entry.path, size: entry.size };
    group.size += entry.size;
  }
  return { groups: Array.from(groups.values()), previews };
}

function completePack(group) {
  return group.files.pak && group.files.ucas && group.files.utoc;
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function pathContains(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertDeleteTargetAllowed(state, target) {
  const roots = state.libraryFolders || [];
  if (!roots.some((root) => pathContains(root, target))) {
    throw new Error("Delete target is outside the configured library folders.");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removePathForDelete(target, options = {}) {
  const attempts = [0, 150, 500, 1000];
  let lastError = null;
  for (const delay of attempts) {
    if (delay) await sleep(delay);
    try {
      await fsp.chmod(target, 0o666);
    } catch {
      // The target may be a directory, missing, or on a filesystem that ignores chmod.
    }
    try {
      await fsp.rm(target, { force: true, maxRetries: 3, retryDelay: 100, ...options });
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code)) throw error;
    }
  }
  const action = options.recursive ? "folder" : "archive";
  throw new Error(`Windows would not delete this ${action}. Close any app that may be using it, then try again. Original error: ${lastError?.code || "unknown"} ${lastError?.message || ""}`.trim());
}

async function scanLibraries(libraryFolders) {
  const errors = [];
  const allGroups = [];
  const allPreviews = [];
  const archives = [];
  for (const root of libraryFolders) {
    try {
      const dirScan = await scanDirectory(root);
      allGroups.push(...dirScan.groups);
      allPreviews.push(...dirScan.previews);
      archives.push(...dirScan.archives);
      for (const archive of dirScan.archives) {
        try {
          const archiveScan = await scanArchive(archive.path);
          allGroups.push(...archiveScan.groups);
          allPreviews.push(...archiveScan.previews);
        } catch (error) {
          errors.push({ path: archive.path, message: error.message });
        }
      }
    } catch (error) {
      errors.push({ path: root, message: error.message });
    }
  }
  const folders = new Map();
  const packs = [];
  for (const group of allGroups) {
    if (!completePack(group)) continue;
    const origin = group.source === "archive" ? group.archivePath : group.root;
    const folderKey = `${origin}|${group.modName}`;
    if (!folders.has(folderKey)) {
      folders.set(folderKey, {
        id: idFor(folderKey),
        name: humanName(group.modName),
        rawName: group.modName,
        source: group.source,
        origin,
        deleteTarget: group.source === "archive" ? group.archivePath : group.modPath,
        previews: [],
        packIds: []
      });
    }
    const folder = folders.get(folderKey);
    const id = idFor(`${folderKey}|${group.directory}|${group.base}`);
    const pack = {
      id,
      name: humanPackName(group.base),
      base: group.base,
      modFolderId: folder.id,
      modFolderName: folder.name,
      source: group.source,
      origin,
      directory: group.directory,
      priority: parsePriority(group.base),
      files: group.files,
      size: group.size,
      previews: []
    };
    packs.push(pack);
    folder.packIds.push(id);
  }
  for (const folder of folders.values()) {
    folder.previews = groupFolderPreview(allPreviews, folder.rawName);
  }
  for (const pack of packs) {
    pack.previews = allPreviews
      .filter((p) => p.modName === folders.get(`${pack.origin}|${foldersById(folders).get(pack.modFolderId).rawName}`)?.rawName)
      .slice(0, 8);
  }
  return { modFolders: Array.from(folders.values()).sort((a, b) => a.name.localeCompare(b.name)), modPacks: packs.sort((a, b) => a.name.localeCompare(b.name)), archives, errors };
}

function packListMembership(state) {
  const membership = new Map();
  for (const list of state.modLists || []) {
    for (const item of list.items || []) {
      if (item.type !== "pack") continue;
      if (!membership.has(item.id)) membership.set(item.id, []);
      membership.get(item.id).push(list.name);
    }
  }
  return membership;
}

function deleteSourcePreview(state, folderId) {
  const scan = state.scan || { modFolders: [], modPacks: [] };
  const selected = (scan.modFolders || []).find((folder) => folder.id === folderId);
  if (!selected) throw new Error("Mod folder was not found in the current scan.");
  const target = selected.deleteTarget || (selected.source === "archive" ? selected.origin : "");
  if (!target) throw new Error("This mod folder needs to be scanned again before it can be deleted.");
  const affectedFolders = selected.source === "archive"
    ? (scan.modFolders || []).filter((folder) => folder.source === "archive" && samePath(folder.origin, selected.origin))
    : (scan.modFolders || []).filter((folder) => folder.source === "folder" && folder.deleteTarget && pathContains(target, folder.deleteTarget));
  const memberships = packListMembership(state);
  const packsByFolder = new Map();
  for (const pack of scan.modPacks || []) {
    if (!packsByFolder.has(pack.modFolderId)) packsByFolder.set(pack.modFolderId, []);
    packsByFolder.get(pack.modFolderId).push(pack);
  }
  const folders = affectedFolders.map((folder) => {
    const listedPacks = (packsByFolder.get(folder.id) || [])
      .filter((pack) => memberships.has(pack.id))
      .map((pack) => ({ id: pack.id, name: pack.name, lists: memberships.get(pack.id) }));
    return {
      id: folder.id,
      name: folder.name,
      source: folder.source,
      origin: folder.origin,
      deleteTarget: folder.deleteTarget,
      listedPacks
    };
  });
  return {
    source: selected.source,
    target,
    targetKind: selected.source === "archive" ? "archive" : "folder",
    folders,
    hasListedPacks: folders.some((folder) => folder.listedPacks.length)
  };
}

async function deleteModSource(state, folderId, persist = true) {
  const preview = deleteSourcePreview(state, folderId);
  assertDeleteTargetAllowed(state, preview.target);
  if (preview.source === "archive") {
    await removePathForDelete(preview.target);
  } else {
    await removePathForDelete(preview.target, { recursive: true });
  }
  state.scan = await scanLibraries(state.libraryFolders || []);
  const remainingFolderIds = new Set((state.scan.modFolders || []).map((folder) => folder.id));
  const remainingPackIds = new Set((state.scan.modPacks || []).map((pack) => pack.id));
  state.selectedModFolderId = remainingFolderIds.has(state.selectedModFolderId) ? state.selectedModFolderId : "";
  state.selectedPackId = remainingPackIds.has(state.selectedPackId) ? state.selectedPackId : "";
  return { preview, state: persist ? await saveState(state) : state };
}

function foldersById(foldersMap) {
  const out = new Map();
  for (const folder of foldersMap.values()) out.set(folder.id, folder);
  return out;
}

function containsList(modLists, listId, targetId, seen = new Set()) {
  if (listId === targetId) return true;
  if (seen.has(listId)) return false;
  seen.add(listId);
  const list = modLists.find((item) => item.id === listId);
  if (!list) return false;
  return list.items.some((item) => item.type === "list" && containsList(modLists, item.id, targetId, seen));
}

function validateLists(modLists) {
  for (const list of modLists) {
    for (const item of list.items || []) {
      if (item.type === "list" && containsList(modLists, item.id, list.id)) {
        throw new Error(`Mod list "${list.name}" would create a cycle.`);
      }
    }
  }
}

function packContainers(modLists, packId) {
  return modLists.filter((list) => (list.items || []).some((item) => item.type === "pack" && item.id === packId)).map((list) => list.name);
}

function resolveEnabledPacks(state) {
  const packMap = new Map((state.scan?.modPacks || []).map((pack) => [pack.id, pack]));
  const listMap = new Map((state.modLists || []).map((list) => [list.id, list]));
  const resolved = new Map();
  function visitList(listId, inheritedPriority, stack = new Set()) {
    if (stack.has(listId)) return;
    const list = listMap.get(listId);
    if (!list || !list.enabled) return;
    const priority = list.priority || inheritedPriority || "";
    stack.add(listId);
    for (const item of list.items || []) {
      if (item.type === "pack") {
        const pack = packMap.get(item.id);
        if (!pack) continue;
        const resolvedPriority = item.priority || priority || pack.priority || "9999999";
        const existing = resolved.get(pack.id);
        if (!existing || Number(resolvedPriority) < Number(existing.resolvedPriority)) {
          resolved.set(pack.id, { ...pack, resolvedPriority, lists: packContainers(state.modLists, pack.id) });
        }
      } else if (item.type === "list") {
        visitList(item.id, priority, new Set(stack));
      }
    }
  }
  for (const list of state.modLists || []) {
    if (list.enabled) visitList(list.id, list.priority || "");
  }
  return Array.from(resolved.values()).sort((a, b) => Number(a.resolvedPriority) - Number(b.resolvedPriority) || a.name.localeCompare(b.name));
}

function stagedName(pack, ext) {
  const safeBase = pack.base.replace(/[<>:"/\\|?*]/g, "_");
  const priority = pack.resolvedPriority || pack.priority || "9999999";
  const withoutPriority = safeBase.replace(/\d{4,}/g, priority);
  return `${withoutPriority}.${ext}`;
}

function safeFolderName(name) {
  return name.replace(/[<>:"/\\|?*]/g, "_").trim() || "Mod";
}

async function extractArchiveEntry(archivePath, entryPath) {
  const key = idFor(`${archivePath}|${entryPath}`);
  const destDir = path.join(CACHE, "archive", key);
  const dest = path.join(destDir, path.basename(entryPath));
  try {
    await fsp.access(dest);
    return dest;
  } catch {}
  await fsp.mkdir(destDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn("7z", ["e", "-y", `-o${destDir}`, archivePath, entryPath], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr || `7z exited with ${code}`))));
  });
  return dest;
}

async function sourcePathFor(fileRef) {
  if (fileRef.path) return fileRef.path;
  return extractArchiveEntry(fileRef.archivePath, fileRef.entryPath);
}

async function readManaged(gameFolder) {
  try {
    return JSON.parse(await fsp.readFile(path.join(gameFolder, MANAGED_MARKER), "utf8"));
  } catch {
    return { files: [] };
  }
}

async function writeManaged(gameFolder, files) {
  await fsp.writeFile(path.join(gameFolder, MANAGED_MARKER), JSON.stringify({ updatedAt: new Date().toISOString(), files }, null, 2));
}

async function buildPlan(state) {
  if (!state.gameFolder) throw new Error("Set a game mods folder before applying.");
  const enabled = resolveEnabledPacks(state);
  const wanted = [];
  for (const pack of enabled) {
    const folder = safeFolderName(pack.modFolderName);
    for (const ext of ["pak", "ucas", "utoc"]) {
      const fileRef = pack.files[ext];
      const target = path.join(state.gameFolder, folder, stagedName(pack, ext));
      wanted.push({ packId: pack.id, source: fileRef.path || `${fileRef.archivePath}::${fileRef.entryPath}`, fileRef, target, disabledTarget: `${target}.disabled`, size: fileRef.size || 0, ext });
    }
  }
  const managed = await readManaged(state.gameFolder);
  const current = new Set((managed.files || []).map((file) => file.target));
  const wantedTargets = new Set(wanted.map((file) => file.target));
  const actions = [];
  let estimatedCopyBytes = 0;
  for (const file of wanted) {
    if (await exists(file.target)) {
      actions.push({ type: "keep", target: file.target, packId: file.packId });
    } else if (await exists(file.disabledTarget)) {
      actions.push({ type: "enable", from: file.disabledTarget, target: file.target, packId: file.packId });
    } else {
      actions.push({ type: "stage", source: file.source, target: file.target, size: file.size, packId: file.packId });
      estimatedCopyBytes += file.size;
    }
  }
  for (const target of current) {
    if (!wantedTargets.has(target) && await exists(target)) {
      actions.push({ type: "disable", from: target, target: `${target}.disabled` });
    }
  }
  return { enabledPacks: enabled, actions, estimatedCopyBytes, gameFolder: state.gameFolder };
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function stageFile(source, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.link(source, target);
    return "hardlink";
  } catch {
    await fsp.copyFile(source, target);
    return "copy";
  }
}

async function applyPlan(state) {
  const plan = await buildPlan(state);
  const managedFiles = [];
  for (const action of plan.actions) {
    if (action.type === "stage") {
      const wanted = plan.enabledPacks.flatMap((pack) => ["pak", "ucas", "utoc"].map((ext) => ({ pack, ext })))
        .find((item) => path.join(state.gameFolder, safeFolderName(item.pack.modFolderName), stagedName(item.pack, item.ext)) === action.target);
      const source = await sourcePathFor(wanted.pack.files[wanted.ext]);
      action.method = await stageFile(source, action.target);
      managedFiles.push({ target: action.target });
    } else if (action.type === "enable") {
      await fsp.mkdir(path.dirname(action.target), { recursive: true });
      await fsp.rename(action.from, action.target);
      managedFiles.push({ target: action.target });
    } else if (action.type === "disable") {
      if (!(await exists(action.target))) await fsp.rename(action.from, action.target);
    } else if (action.type === "keep") {
      managedFiles.push({ target: action.target });
    }
  }
  for (const pack of plan.enabledPacks) {
    for (const ext of ["pak", "ucas", "utoc"]) {
      managedFiles.push({ target: path.join(state.gameFolder, safeFolderName(pack.modFolderName), stagedName(pack, ext)) });
    }
  }
  await writeManaged(state.gameFolder, Array.from(new Map(managedFiles.map((file) => [file.target, file])).values()));
  return plan;
}

async function pickFolder() {
  const script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Choose a folder'; if($d.ShowDialog() -eq 'OK'){[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; Write-Output $d.SelectedPath}";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { encoding: "utf8" });
  return result.stdout.trim();
}

function send(res, status, payload, headers = {}) {
  const body = typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": Buffer.isBuffer(payload) ? "application/octet-stream" : "application/json; charset=utf-8", ...headers });
  res.end(body);
}

async function jsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function handleApi(req, res, url) {
  try {
    if (url.pathname === "/api/state" && req.method === "GET") return send(res, 200, await loadState());
    if (url.pathname === "/api/state" && req.method === "POST") {
      const state = await jsonBody(req);
      validateLists(state.modLists || []);
      return send(res, 200, await saveState(state));
    }
    if (url.pathname === "/api/pick-folder" && req.method === "POST") return send(res, 200, { path: await pickFolder() });
    if (url.pathname === "/api/scan" && req.method === "POST") {
      const state = await loadState();
      state.scan = await scanLibraries(state.libraryFolders || []);
      return send(res, 200, await saveState(state));
    }
    if (url.pathname === "/api/delete-source-preview" && req.method === "POST") {
      const body = await jsonBody(req);
      return send(res, 200, deleteSourcePreview(await loadState(), body.folderId));
    }
    if (url.pathname === "/api/delete-source" && req.method === "POST") {
      const body = await jsonBody(req);
      return send(res, 200, await deleteModSource(await loadState(), body.folderId));
    }
    if (url.pathname === "/api/dry-run" && req.method === "POST") return send(res, 200, await buildPlan(await loadState()));
    if (url.pathname === "/api/apply" && req.method === "POST") return send(res, 200, await applyPlan(await loadState()));
    if (url.pathname === "/api/file" && req.method === "GET") {
      const filePath = url.searchParams.get("path");
      return streamFile(res, filePath);
    }
    if (url.pathname === "/api/archive-file" && req.method === "GET") {
      const filePath = await extractArchiveEntry(url.searchParams.get("archive"), url.searchParams.get("entry"));
      return streamFile(res, filePath);
    }
    send(res, 404, { error: "Not found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm"
  }[ext] || "application/octet-stream";
}

function streamFile(res, filePath) {
  if (!filePath) return send(res, 400, { error: "Missing path" });
  res.writeHead(200, { "Content-Type": contentType(filePath) });
  fs.createReadStream(filePath).on("error", () => send(res, 404, { error: "File not found" })).pipe(res);
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC, requested));
  if (!filePath.startsWith(PUBLIC)) return send(res, 403, "Forbidden", { "Content-Type": "text/plain" });
  try {
    const body = await fsp.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(body);
  } catch {
    send(res, 404, "Not found", { "Content-Type": "text/plain" });
  }
}

async function start(port = process.env.PORT || 3859) {
  await ensureDirs();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) handleApi(req, res, url);
    else serveStatic(req, res, url);
  });
  server.listen(port, () => console.log(`Unreal Mod Manager running at http://localhost:${port}`));
  return server;
}

if (require.main === module) start();

module.exports = {
  scanLibraries,
  resolveEnabledPacks,
  validateLists,
  buildPlan,
  applyPlan,
  deleteSourcePreview,
  deleteModSource,
  pickFolder,
  parsePriority,
  humanPackName,
  parse7zList,
  loadState,
  saveState,
  start,
  CACHE
};
