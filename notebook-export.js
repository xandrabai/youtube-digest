/**
 * Pure notebook-export helpers shared by the side panel's Download button
 * and the background service worker's Save-to-Drive flow. No DOM or
 * chrome.* calls here so both contexts — and node --test — can load this
 * file unchanged (loaded via a <script> tag in sidepanel.html and via
 * importScripts() in background.js, the same pattern as settings.js).
 */
var YTD_NOTEBOOK_EXPORT = (() => {
  // Characters invalid in filenames across Windows/macOS/Linux.
  const INVALID_FILENAME_CHARS = /[/\\:*?"<>|]/g;

  function sanitizeFilename(name) {
    return String(name ?? "").replace(INVALID_FILENAME_CHARS, "-");
  }

  // YAML double-quoted scalars only need internal double-quotes escaped;
  // video titles routinely contain colons, which is exactly what would
  // otherwise break an unquoted "video: <title>" line.
  function escapeFrontmatterValue(value) {
    return String(value ?? "").replace(/"/g, '\\"');
  }

  /**
   * Prepends a YAML frontmatter block to a notebook's content. The
   * frontmatter is assembled here, at export time, only — it must never be
   * stored in the notebook's `content` field or shown in the editable
   * textarea.
   */
  function buildNotebookExportMarkdown(notebook) {
    const videoTitle = escapeFrontmatterValue(notebook?.videoTitle);
    const channelName = escapeFrontmatterValue(notebook?.channelName);
    const videoId = notebook?.videoId ?? "";
    const content = notebook?.content ?? "";

    const frontmatter = [
      "---",
      `video: "${videoTitle}"`,
      `url: https://www.youtube.com/watch?v=${videoId}`,
      `channel: "${channelName}"`,
      `exported: ${new Date().toISOString()}`,
      "---",
      "",
    ].join("\n");

    return `${frontmatter}\n${content}`;
  }

  function buildExportFilename(notebook) {
    const videoId = notebook?.videoId ?? "";
    const videoTitle = notebook?.videoTitle ?? "";
    return `${sanitizeFilename(`[${videoId}] ${videoTitle}`)}.md`;
  }

  /**
   * Drive files.create request metadata for a first-time export. `parents`
   * is included only when a default folder is set — omitted entirely (not
   * null/[]) otherwise, so Drive falls back to My Drive's root on its own.
   */
  function buildDriveCreateMetadata({ filename, mimeType, folderId }) {
    const metadata = { name: filename, mimeType };
    if (folderId) metadata.parents = [folderId];
    return metadata;
  }

  /**
   * Decides whether an already-exported file needs to move on this export,
   * by comparing its ACTUAL current parents (from a fresh files.get — the
   * user may have reorganized the file by hand in Drive itself, so this
   * trusts Drive's own answer over whatever was last stored) against the
   * currently selected default folder.
   *
   * Returns null when no move is needed (no default folder set, or the
   * file already lives there among its current parents) — callers should
   * do a plain content-only update in that case. Otherwise returns
   * { addParents, removeParents } ready to pass as files.update query
   * params in the same request that pushes the new content.
   */
  function buildDriveMoveParams(currentParents, targetFolderId) {
    if (!targetFolderId) return null;
    const parents = (Array.isArray(currentParents) ? currentParents : []).filter(Boolean);
    if (parents.includes(targetFolderId)) return null;

    const params = { addParents: targetFolderId };
    if (parents.length > 0) params.removeParents = parents.join(",");
    return params;
  }

  const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

  /**
   * Drive files.create request body for a new folder this extension owns
   * (not a browse of the user's pre-existing Drive structure — drive.file
   * can't do that; see createDriveFolder in background.js).
   */
  function buildDriveFolderCreateMetadata(name) {
    return { name: String(name ?? ""), mimeType: DRIVE_FOLDER_MIME_TYPE };
  }

  /**
   * Appends a newly created folder to the stored folder list without
   * duplicating an entry for the same id. Pure so it can be unit tested
   * without touching chrome.storage.
   */
  function appendDriveFolderEntry(list, entry) {
    const existing = Array.isArray(list) ? list : [];
    if (existing.some((item) => item?.id === entry.id)) return existing;
    return [...existing, entry];
  }

  return {
    sanitizeFilename,
    buildNotebookExportMarkdown,
    buildExportFilename,
    buildDriveCreateMetadata,
    buildDriveMoveParams,
    buildDriveFolderCreateMetadata,
    appendDriveFolderEntry,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_NOTEBOOK_EXPORT;
}
