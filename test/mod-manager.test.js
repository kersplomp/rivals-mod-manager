const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  scanLibraries,
  resolveEnabledPacks,
  validateLists,
  buildPlan,
  applyPlan,
  deleteSourcePreview,
  deleteModSource,
  defaultState,
  parsePriority,
  humanPackName
} = require("../server");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "umm-"));
  const mod = path.join(root, "Rogue Starlit Rebel", "Variants");
  const missing = path.join(root, "Broken");
  await fs.mkdir(mod, { recursive: true });
  await fs.mkdir(missing, { recursive: true });
  await fs.writeFile(path.join(root, "Rogue Starlit Rebel", "preview.png"), "image");
  for (const ext of ["pak", "ucas", "utoc"]) {
    await fs.writeFile(path.join(mod, `Rogue_Starlit_Rebel_9999999_P.${ext}`), `${ext}`);
  }
  await fs.writeFile(path.join(missing, "NoTriplet_9999999_P.pak"), "pak");
  return root;
}

test("parsePriority finds large priority-like filename numbers", () => {
  assert.equal(parsePriority("Example_Mod_Alt_9999999_P"), "9999999");
  assert.equal(parsePriority("mod-123-4567-9999"), "9999");
  assert.equal(parsePriority("plain"), null);
});

test("humanPackName removes trailing priority and P suffix", () => {
  assert.equal(humanPackName("Example_Visual_Alt_9999999_P"), "Example Visual Alt");
  assert.equal(humanPackName("Rogue_Starlit_Rebel_9999999"), "Rogue Starlit Rebel");
  assert.equal(humanPackName("Plain_Mod_Name"), "Plain Mod Name");
});

test("scanLibraries flattens nested mod folders and ignores incomplete triplets", async () => {
  const root = await fixture();
  const scan = await scanLibraries([root]);
  assert.equal(scan.modFolders.length, 1);
  assert.equal(scan.modFolders[0].name, "Rogue Starlit Rebel");
  assert.equal(scan.modFolders[0].deleteTarget, path.join(root, "Rogue Starlit Rebel"));
  assert.equal(scan.modPacks.length, 1);
  assert.equal(scan.modPacks[0].priority, "9999999");
  assert.equal(scan.modPacks[0].name, "Rogue Starlit Rebel");
  assert.equal(scan.modFolders[0].previews.length, 1);
});

test("validateLists rejects recursive list cycles", () => {
  const lists = [
    { id: "a", name: "A", items: [{ type: "list", id: "b" }] },
    { id: "b", name: "B", items: [{ type: "list", id: "a" }] }
  ];
  assert.throws(() => validateLists(lists), /cycle/i);
});

test("resolveEnabledPacks inherits list priority and dedupes packs", async () => {
  const root = await fixture();
  const scan = await scanLibraries([root]);
  const pack = scan.modPacks[0];
  const state = {
    scan,
    modLists: [
      { id: "a", name: "A", enabled: true, priority: "8000", items: [{ type: "pack", id: pack.id }] },
      { id: "b", name: "B", enabled: true, priority: "", items: [{ type: "pack", id: pack.id }] }
    ]
  };
  const resolved = resolveEnabledPacks(state);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].resolvedPriority, "8000");
});

test("buildPlan and applyPlan stage packs and disable removed managed files", async () => {
  const root = await fixture();
  const gameFolder = await fs.mkdtemp(path.join(os.tmpdir(), "umm-game-"));
  const scan = await scanLibraries([root]);
  const pack = scan.modPacks[0];
  const state = {
    gameFolder,
    scan,
    modLists: [{ id: "a", name: "A", enabled: true, priority: "7777777", items: [{ type: "pack", id: pack.id }] }]
  };
  const plan = await buildPlan(state);
  assert.equal(plan.actions.filter((action) => action.type === "stage").length, 3);
  await applyPlan(state);
  const staged = await fs.readdir(path.join(gameFolder, "Rogue Starlit Rebel"));
  assert.equal(staged.filter((name) => name.endsWith(".pak")).length, 1);
  state.modLists[0].items = [];
  const disablePlan = await applyPlan(state);
  assert.equal(disablePlan.actions.filter((action) => action.type === "disable").length, 3);
  const disabled = await fs.readdir(path.join(gameFolder, "Rogue Starlit Rebel"));
  assert.equal(disabled.filter((name) => name.endsWith(".disabled")).length, 3);
});

test("deleteSourcePreview lists affected folders and warns about listed packs", async () => {
  const root = await fixture();
  const scan = await scanLibraries([root]);
  const folder = scan.modFolders[0];
  const pack = scan.modPacks[0];
  const state = {
    libraryFolders: [root],
    scan,
    modLists: [{ id: "a", name: "A", enabled: true, items: [{ type: "pack", id: pack.id }] }]
  };
  const preview = deleteSourcePreview(state, folder.id);
  assert.equal(preview.targetKind, "folder");
  assert.equal(preview.folders.length, 1);
  assert.equal(preview.hasListedPacks, true);
  assert.deepEqual(preview.folders[0].listedPacks[0].lists, ["A"]);
});

test("deleteSourcePreview for archives includes every folder in that archive", () => {
  const archive = path.join(os.tmpdir(), "mods.7z");
  const state = {
    scan: {
      modFolders: [
        { id: "one", name: "One", source: "archive", origin: archive, deleteTarget: archive, packIds: ["p1"] },
        { id: "two", name: "Two", source: "archive", origin: archive, deleteTarget: archive, packIds: ["p2"] },
        { id: "three", name: "Three", source: "folder", origin: os.tmpdir(), deleteTarget: path.join(os.tmpdir(), "Three"), packIds: ["p3"] }
      ],
      modPacks: [
        { id: "p1", modFolderId: "one" },
        { id: "p2", modFolderId: "two" },
        { id: "p3", modFolderId: "three" }
      ]
    },
    modLists: [{ id: "a", name: "A", items: [{ type: "pack", id: "p2" }] }]
  };
  const preview = deleteSourcePreview(state, "one");
  assert.equal(preview.targetKind, "archive");
  assert.deepEqual(preview.folders.map((folder) => folder.name), ["One", "Two"]);
  assert.equal(preview.hasListedPacks, true);
});

test("deleteSourcePreview allows stale archive scans but rejects stale folder scans", () => {
  const root = os.tmpdir();
  const archive = path.join(root, "Example Archive Mod.rar");
  const archiveState = {
    scan: {
      modFolders: [{ id: "archive", name: "Example Archive Mod", source: "archive", origin: archive, deleteTarget: null, packIds: [] }],
      modPacks: []
    },
    modLists: []
  };
  assert.equal(deleteSourcePreview(archiveState, "archive").target, archive);

  const folderState = {
    scan: {
      modFolders: [{ id: "folder", name: "Example Archive Mod", source: "folder", origin: root, deleteTarget: null, packIds: [] }],
      modPacks: []
    },
    modLists: []
  };
  assert.throws(() => deleteSourcePreview(folderState, "folder"), /scanned again/i);
});

test("deleteModSource removes a rar archive without deleting same-named folder", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "umm-archive-delete-"));
  const archive = path.join(root, "Example Archive Mod.rar");
  const sameNamedFolder = path.join(root, "Example Archive Mod");
  await fs.writeFile(archive, "archive");
  await fs.mkdir(sameNamedFolder);
  await fs.writeFile(path.join(sameNamedFolder, "keep.txt"), "keep");
  const state = {
    libraryFolders: [root],
    selectedModFolderId: "archive-mod",
    selectedPackId: "archive-pack",
    scan: {
      modFolders: [
        {
          id: "archive-mod",
          name: "Example Archive Mod",
          source: "archive",
          origin: archive,
          deleteTarget: archive,
          packIds: ["archive-pack"]
        }
      ],
      modPacks: [{ id: "archive-pack", modFolderId: "archive-mod" }]
    },
    modLists: [{ id: "a", name: "A", items: [{ type: "pack", id: "archive-pack" }] }]
  };
  const result = await deleteModSource(state, "archive-mod", false);
  assert.equal(result.preview.targetKind, "archive");
  assert.equal(result.preview.target, archive);
  await assert.rejects(fs.stat(archive));
  assert.equal((await fs.readFile(path.join(sameNamedFolder, "keep.txt"), "utf8")), "keep");
  assert.equal(result.state.selectedModFolderId, "");
  assert.equal(result.state.selectedPackId, "");
});

test("deleteModSource clears read-only permissions before removing an archive", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "umm-readonly-archive-delete-"));
  const archive = path.join(root, "Example Archive Mod.rar");
  await fs.writeFile(archive, "archive");
  await fs.chmod(archive, 0o444);
  const state = {
    libraryFolders: [root],
    scan: {
      modFolders: [
        {
          id: "archive-mod",
          name: "Example Archive Mod",
          source: "archive",
          origin: archive,
          deleteTarget: archive,
          packIds: ["archive-pack"]
        }
      ],
      modPacks: [{ id: "archive-pack", modFolderId: "archive-mod" }]
    },
    modLists: []
  };
  await deleteModSource(state, "archive-mod", false);
  await assert.rejects(fs.stat(archive));
});

test("deleteModSource removes a folder-backed mod folder and refreshes scan", async () => {
  const root = await fixture();
  const scan = await scanLibraries([root]);
  const folder = scan.modFolders[0];
  const state = {
    libraryFolders: [root],
    selectedModFolderId: folder.id,
    selectedPackId: scan.modPacks[0].id,
    scan,
    modLists: []
  };
  const result = await deleteModSource(state, folder.id, false);
  assert.equal(result.preview.target, path.join(root, "Rogue Starlit Rebel"));
  assert.equal(result.state.scan.modFolders.length, 0);
  await assert.rejects(fs.stat(path.join(root, "Rogue Starlit Rebel")));
});

test("defaultState starts from an empty demo-ready config", () => {
  const reset = defaultState();
  assert.equal(reset.libraryFolders.length, 0);
  assert.equal(reset.gameFolder, "");
  assert.equal(reset.scan.modFolders.length, 0);
  assert.equal(reset.modLists.length, 1);
  assert.equal(reset.modLists[0].id, "favorites");
});
