let state = null;
let dragPayload = null;
let optionsMenuOpen = false;

const $ = (id) => document.getElementById(id);
const panelDefaults = { left: 280, right: 340 };
const panelLimits = { left: [180, 760], right: [240, 960] };
const optionDefinitions = {
  showFoldersWithoutPreviews: {
    label: "Show folders without previews",
    description: "Include mod folders that do not have image or video previews in the tile browser.",
    defaultValue: true
  }
};

function tauriCore() {
  return window.__TAURI__?.core || null;
}

async function api(path, options = {}) {
  const core = tauriCore();
  if (core) {
    const body = options.body ? JSON.parse(options.body) : {};
    if (path === "/api/state" && (!options.method || options.method === "GET")) return core.invoke("get_state");
    if (path === "/api/state" && options.method === "POST") return core.invoke("save_state", { state: body });
    if (path === "/api/pick-folder") return core.invoke("pick_folder");
    if (path === "/api/scan") return core.invoke("scan");
    if (path === "/api/dry-run") return core.invoke("dry_run");
    if (path === "/api/apply") return core.invoke("apply");
    if (path === "/api/delete-source-preview") return core.invoke("delete_source_preview", { folderId: body.folderId });
    if (path === "/api/delete-source") return core.invoke("delete_source", { folderId: body.folderId });
    if (path === "/api/import-config") return core.invoke("import_config");
    if (path === "/api/export-config") return core.invoke("export_config");
    if (path === "/api/archive-preview") return core.invoke("archive_preview", { archivePath: body.archive, entryPath: body.entry });
  }
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

async function load() {
  state = await api("/api/state");
  ensureUiState();
  render();
}

async function save() {
  ensureUiState();
  state = await api("/api/state", { method: "POST", body: JSON.stringify(state) });
  ensureUiState();
  render();
}

async function pickFolder() {
  const result = await api("/api/pick-folder", { method: "POST" });
  return result.path;
}

function mediaSrc(url) {
  return window.ummMedia.mediaSrc(url, tauriCore());
}

async function resolveMediaSrc(url) {
  const core = tauriCore();
  const archiveFile = window.ummMedia.importedArchiveFile(url);
  if (core && archiveFile) {
    const result = await api("/api/archive-preview", { method: "POST", body: JSON.stringify(archiveFile) });
    return core.convertFileSrc(result.path);
  }
  return mediaSrc(url);
}

function setStatus(text, isError = false) {
  $("statusLine").textContent = text;
  $("statusLine").className = isError ? "error" : "";
}

function ensureUiState() {
  state.ui = state.ui || {};
  state.ui.options = state.ui.options || {};
  state.ui.openModFolderIds = Array.isArray(state.ui.openModFolderIds) ? state.ui.openModFolderIds : [];
  state.ui.modFolderSearch = typeof state.ui.modFolderSearch === "string" ? state.ui.modFolderSearch : "";
  for (const [key, definition] of Object.entries(optionDefinitions)) {
    if (typeof state.ui.options[key] === "undefined") state.ui.options[key] = definition.defaultValue;
  }
}

function getOption(key) {
  ensureUiState();
  return state.ui.options[key];
}

async function setOption(key, value) {
  ensureUiState();
  if (!(key in optionDefinitions)) throw new Error(`Unknown option: ${key}`);
  state.ui.options[key] = value;
  await save();
}

async function toggleOption(key) {
  await setOption(key, !getOption(key));
}

function packMap() {
  return new Map((state.scan?.modPacks || []).map((pack) => [pack.id, pack]));
}

function folderMap() {
  return new Map((state.scan?.modFolders || []).map((folder) => [folder.id, folder]));
}

function listMap() {
  return new Map((state.modLists || []).map((list) => [list.id, list]));
}

function selectedFolder() {
  return (state.scan?.modFolders || []).find((folder) => folder.id === state.selectedModFolderId);
}

function selectedPack() {
  return (state.scan?.modPacks || []).find((pack) => pack.id === state.selectedPackId);
}

function normalizedFolderName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function packMatchesSelectedFolder(pack, folders, folder) {
  if (!pack || !folder) return false;
  if (pack.modFolderId === folder.id) return true;
  const sourceFolder = folders.get(pack.modFolderId);
  const selectedName = normalizedFolderName(folder.name);
  return !!selectedName && normalizedFolderName(sourceFolder?.name) === selectedName;
}

function packInLists(packId) {
  return (state.modLists || []).filter((list) => (list.items || []).some((item) => item.type === "pack" && item.id === packId)).map((list) => list.name);
}

function listedPackIds() {
  const lists = listMap();
  const out = new Set();
  function visitList(listId, seen = new Set()) {
    if (seen.has(listId)) return;
    seen.add(listId);
    const list = lists.get(listId);
    if (!list) return;
    for (const item of list.items || []) {
      if (item.type === "pack") out.add(item.id);
      if (item.type === "list") visitList(item.id, new Set(seen));
    }
  }
  for (const list of state.modLists || []) visitList(list.id);
  return out;
}

function folderHandled(folder, listedIds = listedPackIds()) {
  return (folder.packIds || []).some((packId) => listedIds.has(packId));
}

function displayPackName(pack) {
  const raw = pack?.name || pack?.base || "Missing item";
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+\d{4,}\s+P$/i, "")
    .replace(/\s+\d{4,}$/i, "")
    .replace(/\s+P$/i, "")
    .trim();
}

function wouldCycle(parentId, childId) {
  if (parentId === childId) return true;
  const lists = listMap();
  function contains(listId, target, seen = new Set()) {
    if (listId === target) return true;
    if (seen.has(listId)) return false;
    seen.add(listId);
    const list = lists.get(listId);
    return !!list && (list.items || []).some((item) => item.type === "list" && contains(item.id, target, seen));
  }
  return contains(childId, parentId);
}

function render() {
  ensureUiState();
  $("modFolderSearch").value = state.ui.modFolderSearch || "";
  renderFolders();
  renderModFolders();
  renderLists();
  renderPreview();
  renderOptionsMenu();
}

function renderFolders() {
  $("folderList").innerHTML = "";
  for (const folder of state.libraryFolders || []) {
    const row = document.createElement("div");
    row.className = "treeItem";
    row.innerHTML = `<span>📁</span><span class="itemName" title="${folder}">${folder}</span>`;
    $("folderList").append(row);
  }
}

function renderModFolders() {
  const grid = $("modFolderGrid");
  const detail = $("folderDetailPanel");
  const crumbs = $("workspaceCrumbs");
  const title = $("workspaceTitle");
  const folder = selectedFolder();
  grid.innerHTML = "";
  detail.innerHTML = "";
  if (folder) {
    grid.classList.add("hidden");
    detail.classList.remove("hidden");
    crumbs.innerHTML = `<button id="allFoldersBtn" class="crumbButton">Mod Folders</button><span>/</span><span>${escapeHtml(folder.name)}</span>`;
    title.textContent = folder.name;
    $("allFoldersBtn").onclick = () => {
      state.selectedModFolderId = "";
      state.selectedPackId = "";
      render();
    };
    renderFolderDetail(detail, folder);
    return;
  }

  grid.classList.remove("hidden");
  detail.classList.add("hidden");
  crumbs.innerHTML = "";
  title.textContent = "Mod Folders";
  const handledPackIds = listedPackIds();
  const query = normalizedSearch(state.ui.modFolderSearch);
  const folders = (state.scan?.modFolders || [])
    .filter((item) => getOption("showFoldersWithoutPreviews") || (item.previews || []).length)
    .filter((item) => !query || normalizedSearch(item.name).includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const item of folders) {
    const tile = document.createElement("button");
    const handled = folderHandled(item, handledPackIds);
    tile.className = `modFolderTile ${handled ? "handled" : ""}`;
    const preview = firstPreview(item);
    tile.innerHTML = `
      <span class="tilePreview">${preview ? previewMarkup(preview) : `<span class="tilePlaceholder">${escapeHtml(initials(item.name))}</span>`}</span>
      <span class="tileText">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${item.packIds.length} packs${handled ? " · handled" : ""}</span>
      </span>
    `;
    tile.onclick = () => {
      state.selectedModFolderId = item.id;
      state.selectedPackId = "";
      render();
    };
    grid.append(tile);
  }
  hydratePreviewMedia(grid);
}

function openModFolderForSelection(folderId) {
  ensureUiState();
  if (!folderId) return;
  state.selectedModFolderId = folderId;
}

function renderFolderDetail(container, folder) {
  const packs = (state.scan?.modPacks || []).filter((pack) => pack.modFolderId === folder.id);
  const previews = folder.previews || [];
  const deleteLabel = folder.source === "archive" ? "Delete Archive" : "Delete Folder";
  container.innerHTML = `
    <div class="folderHero">
      <div class="folderHeroMedia">${previews.length ? previews.slice(0, 3).map(previewMarkup).join("") : `<span class="tilePlaceholder">${escapeHtml(initials(folder.name))}</span>`}</div>
      <div class="folderHeroInfo">
        <h2>${escapeHtml(folder.name)}</h2>
        <p>${packs.length} mod packs · ${escapeHtml(folder.source)} source</p>
        <div class="folderActions">
          <button id="deleteModSourceBtn" class="dangerButton">${deleteLabel}</button>
        </div>
      </div>
    </div>
    <div id="folderPackList" class="folderPackList"></div>
  `;
  hydratePreviewMedia(container);
  container.querySelector("#deleteModSourceBtn").onclick = () => confirmAndDeleteModSource(folder.id);
  const list = container.querySelector("#folderPackList");
  for (const pack of packs) {
    const row = document.createElement("div");
    row.className = `folderPackRow ${pack.id === state.selectedPackId ? "active" : ""}`;
    row.draggable = true;
    row.innerHTML = `<span>◇</span><span class="itemName">${escapeHtml(displayPackName(pack))}</span>`;
    row.ondragstart = () => dragPayload = { type: "pack", id: pack.id };
    row.onclick = () => {
      state.selectedPackId = pack.id;
      render();
    };
    list.append(row);
  }
}

async function confirmAndDeleteModSource(folderId) {
  try {
    const preview = await api("/api/delete-source-preview", { method: "POST", body: JSON.stringify({ folderId }) });
    const listed = preview.folders.filter((folder) => folder.listedPacks.length);
    const folderLines = preview.folders.map((folder) => {
      const suffix = folder.listedPacks.length ? ` (${folder.listedPacks.length} listed pack${folder.listedPacks.length === 1 ? "" : "s"})` : "";
      return `- ${folder.name}${suffix}`;
    }).join("\n");
    const warningLines = listed.length
      ? `\n\nWARNING: These deleted folders include mod packs already used in mod lists:\n${listed.map((folder) => `- ${folder.name}: ${folder.listedPacks.map((pack) => pack.lists.join(", ")).join("; ")}`).join("\n")}`
      : "";
    const message = `Delete this ${preview.targetKind}?\n\nTarget:\n${preview.target}\n\nMod folders that will be deleted:\n${folderLines || "- None"}${warningLines}\n\nThis removes files from disk and cannot be undone by the mod manager.`;
    if (!window.confirm(message)) return;
    setStatus(`Deleting ${preview.targetKind}...`);
    const result = await api("/api/delete-source", { method: "POST", body: JSON.stringify({ folderId }) });
    state = result.state;
    ensureUiState();
    render();
    setStatus(`Deleted ${result.preview.folders.length} mod folder${result.preview.folders.length === 1 ? "" : "s"} from ${result.preview.targetKind}.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function firstPreview(folder) {
  return (folder.previews || []).find((preview) => preview.type === "image") || (folder.previews || [])[0];
}

function previewMarkup(preview) {
  const src = mediaSrc(preview.url);
  const srcAttr = src ? ` src="${escapeHtml(src)}"` : "";
  if (preview.type === "video") {
    return `<video${srcAttr} muted data-preview-url="${escapeAttr(preview.url)}" onerror="logPreviewMediaError(this, '${escapeAttr(preview.url)}')"></video>`;
  }
  return `<img${srcAttr} alt="" data-preview-url="${escapeAttr(preview.url)}" onerror="logPreviewMediaError(this, '${escapeAttr(preview.url)}')">`;
}

function attachPreviewMediaErrorLog(node, preview) {
  node.onerror = () => logPreviewMediaError(node, preview.url);
}

function hydratePreviewMedia(root) {
  for (const node of root.querySelectorAll("[data-preview-url]")) {
    const originalUrl = node.dataset.previewUrl;
    if (!originalUrl || node.dataset.previewHydrated === originalUrl) continue;
    node.dataset.previewHydrated = originalUrl;
    resolveMediaSrc(originalUrl)
      .then((src) => {
        if (src && node.dataset.previewUrl === originalUrl) node.src = src;
      })
      .catch((error) => {
        console.warn("Preview media resolution failed", { originalUrl, message: error.message });
      });
  }
}

function logPreviewMediaError(node, originalUrl) {
  console.warn("Preview media failed to load", {
    originalUrl,
    resolvedSrc: node?.currentSrc || node?.src || "",
    title: node?.title || ""
  });
}

function initials(name) {
  return String(name || "Mod").split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

function renderOptionsMenu() {
  const button = $("optionsBtn");
  const menu = $("optionsMenu");
  button.setAttribute("aria-expanded", String(optionsMenuOpen));
  menu.classList.toggle("hidden", !optionsMenuOpen);
  menu.innerHTML = "";
  if (tauriCore()) {
    const importButton = document.createElement("button");
    importButton.className = "optionAction";
    importButton.type = "button";
    importButton.textContent = "Import Config";
    importButton.onclick = importConfig;
    menu.append(importButton);
    const exportButton = document.createElement("button");
    exportButton.className = "optionAction";
    exportButton.type = "button";
    exportButton.textContent = "Export Config";
    exportButton.onclick = exportConfig;
    menu.append(exportButton);
  }
  for (const [key, definition] of Object.entries(optionDefinitions)) {
    const label = document.createElement("label");
    label.className = "optionRow";
    label.setAttribute("role", "menuitemcheckbox");
    label.innerHTML = `
      <input type="checkbox" ${getOption(key) ? "checked" : ""}>
      <span class="optionText">
        <strong>${escapeHtml(definition.label)}</strong>
        <span>${escapeHtml(definition.description)}</span>
      </span>
    `;
    label.querySelector("input").onchange = async (event) => {
      await setOption(key, event.target.checked);
    };
    menu.append(label);
  }
}

async function importConfig() {
  try {
    setStatus("Importing config...");
    state = await api("/api/import-config", { method: "POST" });
    ensureUiState();
    optionsMenuOpen = false;
    render();
    setStatus("Imported config.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function exportConfig() {
  try {
    setStatus("Exporting config...");
    const result = await api("/api/export-config", { method: "POST" });
    optionsMenuOpen = false;
    renderOptionsMenu();
    setStatus(result.path ? `Exported config to ${result.path}` : "Export cancelled.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function applyPanelWidths() {
  for (const side of ["left", "right"]) {
    const saved = Number(localStorage.getItem(`umm.${side}PanelWidth`));
    const fallback = panelDefaults[side];
    const [min, max] = panelLimits[side];
    document.documentElement.style.setProperty(`--${side}-panel`, `${clamp(saved || fallback, min, max)}px`);
  }
}

function initPanelResizers() {
  applyPanelWidths();
  for (const handle of document.querySelectorAll(".resizeHandle")) {
    handle.addEventListener("pointerdown", (event) => {
      const side = handle.dataset.resizer;
      const shell = document.querySelector(".shell");
      const shellRect = shell.getBoundingClientRect();
      const startX = event.clientX;
      const startWidth = Number(localStorage.getItem(`umm.${side}PanelWidth`)) || panelDefaults[side];
      const [min, max] = panelLimits[side];
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("resizing");
      document.body.classList.add("resizingPanels");

      const onMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        const rawWidth = side === "left" ? startWidth + delta : startWidth - delta;
        const workspaceMin = 280;
        const otherSide = side === "left" ? "right" : "left";
        const otherWidth = Number(localStorage.getItem(`umm.${otherSide}PanelWidth`)) || panelDefaults[otherSide];
        const availableMax = Math.max(min, shellRect.width - otherWidth - workspaceMin - 12);
        const nextWidth = clamp(rawWidth, min, Math.min(max, availableMax));
        document.documentElement.style.setProperty(`--${side}-panel`, `${nextWidth}px`);
        localStorage.setItem(`umm.${side}PanelWidth`, String(nextWidth));
      };

      const onUp = () => {
        handle.classList.remove("resizing");
        document.body.classList.remove("resizingPanels");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }
  window.addEventListener("resize", applyPanelWidths);
}

function renderListNav() {
  $("pinnedLists").innerHTML = "";
  $("hiddenLists").innerHTML = "";
  const sorted = [...(state.modLists || [])].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
  for (const list of sorted) {
    const row = document.createElement("div");
    row.className = "treeItem";
    row.draggable = true;
    row.ondragstart = () => dragPayload = { type: "list", id: list.id };
    row.innerHTML = `<span>${list.enabled ? "●" : "○"}</span><span class="itemName">${list.name}</span><span class="itemMeta">${list.items.length}</span>`;
    (list.hidden ? $("hiddenLists") : $("pinnedLists")).append(row);
  }
}

function renderLists() {
  const packs = packMap();
  const folders = folderMap();
  const lists = listMap();
  const folder = selectedFolder();
  const grid = $("listsGrid");
  grid.innerHTML = "";
  for (const list of state.modLists || []) {
    const card = document.createElement("article");
    card.className = "listCard";
    card.innerHTML = `
      <div class="listHeader">
        <input type="text" value="${escapeHtml(list.name)}" title="List name">
        <label title="Enabled"><input type="checkbox" ${list.enabled ? "checked" : ""}> On</label>
        <input class="priorityInput" value="${escapeHtml(list.priority || "")}" placeholder="Priority" title="List priority">
        <div class="controls">
          <button title="Pin or unpin">${list.pinned ? "📌" : "⌖"}</button>
          <button title="Hide or show">${list.hidden ? "👁" : "—"}</button>
        </div>
      </div>
      <div class="listBody"></div>
    `;
    const [nameInput, checkbox, priorityInput] = card.querySelectorAll("input");
    nameInput.onchange = async () => { list.name = nameInput.value.trim() || "Untitled"; await save(); };
    checkbox.onchange = async () => { list.enabled = checkbox.checked; await save(); };
    priorityInput.onchange = async () => { list.priority = priorityInput.value.trim(); await save(); };
    const buttons = card.querySelectorAll("button");
    buttons[0].onclick = async () => { list.pinned = !list.pinned; await save(); };
    buttons[1].onclick = async () => { list.hidden = !list.hidden; await save(); };
    const body = card.querySelector(".listBody");
    body.ondragover = (event) => event.preventDefault();
    body.ondrop = async () => {
      if (!dragPayload) return;
      if (dragPayload.type === "list" && wouldCycle(list.id, dragPayload.id)) {
        setStatus("That nested list would create a cycle.", true);
        return;
      }
      if (!list.items.some((item) => item.type === dragPayload.type && item.id === dragPayload.id)) {
        list.items.push({ ...dragPayload });
        await save();
      }
    };
    if (!list.items.length) {
      body.innerHTML = `<div class="dropHint">Drop mod packs or lists here</div>`;
    } else {
      for (const item of list.items) {
        const node = document.createElement("div");
        const isPack = item.type === "pack";
        const target = isPack ? packs.get(item.id) : lists.get(item.id);
        node.className = isPack ? "packItem" : "listRef";
        if (isPack && packMatchesSelectedFolder(target, folders, folder)) node.classList.add("sourceFolderMatch");
        node.innerHTML = `<span>${isPack ? "◇" : "▣"}</span><span class="itemName">${target ? escapeHtml(isPack ? displayPackName(target) : target.name) : "Missing item"}</span><button title="Remove">×</button>`;
        node.querySelector("button").onclick = async () => {
          list.items = list.items.filter((candidate) => !(candidate.type === item.type && candidate.id === item.id));
          await save();
        };
        if (isPack && target) {
          node.onclick = () => {
            state.selectedPackId = target.id;
            state.selectedModFolderId = target.modFolderId;
            openModFolderForSelection(target.modFolderId);
            render();
          };
        }
        body.append(node);
      }
    }
    grid.append(card);
  }
}

function renderPreview() {
  const folder = selectedFolder();
  const pack = selectedPack();
  const media = $("previewMedia");
  const details = $("detailsPanel");
  const previews = pack?.previews?.length ? pack.previews : folder?.previews || [];
  media.className = previews.length ? "previewMedia" : "previewMedia empty";
  media.innerHTML = previews.length ? "" : "Select a mod folder or pack";
  for (const preview of previews) {
    const node = document.createElement(preview.type === "video" ? "video" : "img");
    const src = mediaSrc(preview.url);
    if (src) node.src = src;
    node.title = preview.name;
    node.dataset.previewUrl = preview.url;
    attachPreviewMediaErrorLog(node, preview);
    if (preview.type === "video") node.controls = true;
    media.append(node);
  }
  hydratePreviewMedia(media);
  if (pack) {
    const lists = packInLists(pack.id);
    details.innerHTML = rows([
      ["Pack", displayPackName(pack)],
      ["Folder", pack.modFolderName],
      ["Priority", pack.priority || "9999999"],
      ["In Lists", lists.length ? lists.join(", ") : "None"],
      ["Source", pack.source],
      ["Origin", pack.origin],
      ["Size", bytes(pack.size)]
    ]);
  } else if (folder) {
    details.innerHTML = rows([
      ["Folder", folder.name],
      ["Packs", String(folder.packIds.length)],
      ["Source", folder.source],
      ["Origin", folder.origin]
    ]);
  } else {
    details.innerHTML = rows([
      ["Library", `${state.libraryFolders?.length || 0} folders`],
      ["Packs", `${state.scan?.modPacks?.length || 0} found`],
      ["Archives", `${state.scan?.archives?.length || 0} indexed`]
    ]);
  }
}

function rows(items) {
  return items.map(([key, value]) => `<div class="detailRow"><span>${escapeHtml(key)}</span><span title="${escapeHtml(value)}">${escapeHtml(value)}</span></div>`).join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function normalizedSearch(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function bytes(value) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size > 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index ? 1 : 0)} ${units[index]}`;
}

async function runPlan(apply = false) {
  try {
    setStatus(apply ? "Applying..." : "Building dry run...");
    const plan = await api(apply ? "/api/apply" : "/api/dry-run", { method: "POST" });
    const panel = $("planPanel");
    panel.className = "planPanel";
    const rows = plan.actions.map((action) => `
        <tr>
          <td><span class="badge ${action.type}">${escapeHtml(action.type)}</span></td>
          <td class="planPath" title="${escapeHtml(action.source || "")}">${escapeHtml(action.source || "")}</td>
          <td class="planPath" title="${escapeHtml(action.target || "")}">${escapeHtml(action.target || "")}</td>
          <td class="planSize">${bytes(action.size || 0)}</td>
        </tr>`).join("");
    panel.innerHTML = `<h2>${apply ? "Applied" : "Dry Run"}</h2>
      <p>${plan.enabledPacks.length} enabled packs, ${plan.actions.length} actions, ${bytes(plan.estimatedCopyBytes)} possible copy fallback.</p>
      <div class="planTableWrap">
        <table class="planTable">
          <thead>
            <tr><th>Action</th><th>Source</th><th>Target</th><th>Size</th></tr>
          </thead>
          <tbody>${rows || `<tr><td colspan="4" class="emptyCell">No changes needed</td></tr>`}</tbody>
        </table>
      </div>`;
    setStatus(apply ? "Apply complete" : "Dry run ready");
  } catch (error) {
    setStatus(error.message, true);
  }
}

$("addFolderBtn").onclick = async () => {
  const folder = await pickFolder();
  if (folder && !state.libraryFolders.includes(folder)) {
    state.libraryFolders.push(folder);
    await save();
    $("scanBtn").click();
  }
};

$("gameFolderBtn").onclick = async () => {
  const folder = await pickFolder();
  if (folder) {
    state.gameFolder = folder;
    await save();
  }
};

$("scanBtn").onclick = async () => {
  try {
    setStatus("Scanning folders and archives...");
    state = await api("/api/scan", { method: "POST" });
    const errors = state.scan.errors?.length ? `, ${state.scan.errors.length} archive/folder errors` : "";
    setStatus(`Found ${state.scan.modPacks.length} packs in ${state.scan.modFolders.length} mod folders${errors}`);
    render();
  } catch (error) {
    setStatus(error.message, true);
  }
};

$("newListBtn").onclick = async () => {
  state.modLists.push({ id: `list-${Date.now()}`, name: "New Mod List", enabled: true, pinned: false, hidden: false, priority: "", items: [] });
  await save();
};

$("optionsBtn").onclick = (event) => {
  event.stopPropagation();
  optionsMenuOpen = !optionsMenuOpen;
  renderOptionsMenu();
};

document.addEventListener("click", (event) => {
  if (!optionsMenuOpen) return;
  if (event.target.closest(".optionsHost")) return;
  optionsMenuOpen = false;
  renderOptionsMenu();
});

$("dryRunBtn").onclick = () => runPlan(false);
$("applyBtn").onclick = () => runPlan(true);
$("modFolderSearch").oninput = (event) => {
  ensureUiState();
  state.ui.modFolderSearch = event.target.value;
  renderModFolders();
};

initPanelResizers();
load().catch((error) => setStatus(error.message, true));
