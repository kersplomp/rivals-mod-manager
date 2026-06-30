(function (global) {
  function importedFilePath(url) {
    if (!url) return "";
    const parsed = new URL(url, "http://local");
    if (parsed.pathname !== "/api/file") return "";
    return parsed.searchParams.get("path") || "";
  }

  function importedArchiveFile(url) {
    if (!url) return null;
    const parsed = new URL(url, "http://local");
    if (parsed.pathname !== "/api/archive-file") return null;
    const archive = parsed.searchParams.get("archive") || "";
    const entry = parsed.searchParams.get("entry") || "";
    return archive && entry ? { archive, entry } : null;
  }

  function mediaSrc(url, core) {
    if (!url) return "";
    if (core) {
      const importedPath = importedFilePath(url);
      if (importedPath) return core.convertFileSrc(importedPath);
      if (importedArchiveFile(url)) return "";
      if (!url.startsWith("/api/") && !/^https?:/i.test(url) && !/^asset:/i.test(url)) {
        return core.convertFileSrc(url);
      }
    }
    return url;
  }

  const api = { importedArchiveFile, importedFilePath, mediaSrc };
  global.ummMedia = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
