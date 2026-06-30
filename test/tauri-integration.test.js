const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("Tauri asset protocol is enabled for local preview files", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const assetProtocol = config.app?.security?.assetProtocol;
  assert.equal(assetProtocol?.enable, true);
  assert(assetProtocol.scope.allow.includes("$HOME/**"));
  assert(assetProtocol.scope.allow.includes("$DOWNLOAD/**"));
});

test("Tauri release builds enable devtools for diagnosis", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const cargo = fs.readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8");
  assert.equal(config.app?.windows?.[0]?.devtools, true);
  assert.match(cargo, /features = \[[^\]]*"devtools"/);
});

test("Tauri frontend converts imported Node preview URLs to asset URLs", () => {
  const { importedArchiveFile, importedFilePath, mediaSrc } = require("../public/media-src");
  const filePath = "C:\\Users\\Example\\Mods\\Preview Mod\\preview.png";
  const importedUrl = `/api/file?path=${encodeURIComponent(filePath)}`;
  const absoluteImportedUrl = `http://tauri.localhost/api/file?path=${encodeURIComponent(filePath)}`;
  const archivePath = "C:\\Users\\Example\\Mods\\Archive Preview Mod.rar";
  const archiveEntry = "Archive Preview Mod\\Preview.png";
  const archiveUrl = `http://tauri.localhost/api/archive-file?archive=${encodeURIComponent(archivePath)}&entry=${encodeURIComponent(archiveEntry)}`;
  const converted = [];
  const core = {
    convertFileSrc(value) {
      converted.push(value);
      return `asset://${value}`;
    }
  };
  assert.equal(importedFilePath(importedUrl), filePath);
  assert.equal(importedFilePath(absoluteImportedUrl), filePath);
  assert.deepEqual(importedArchiveFile(archiveUrl), { archive: archivePath, entry: archiveEntry });
  assert.equal(mediaSrc(importedUrl, core), `asset://${filePath}`);
  assert.equal(mediaSrc(absoluteImportedUrl, core), `asset://${filePath}`);
  assert.equal(mediaSrc(archiveUrl, core), "");
  assert.deepEqual(converted, [filePath, filePath]);
});

test("Tauri backend exposes archive preview extraction", () => {
  const lib = fs.readFileSync(path.join(root, "src-tauri", "src", "lib.rs"), "utf8");
  assert.match(lib, /fn archive_preview\(archive_path: String, entry_path: String\)/);
  assert.match(lib, /archive_preview/);
  assert.match(lib, /\/api\/archive-file\?archive=/);
});
