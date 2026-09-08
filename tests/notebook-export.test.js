const test = require("node:test");
const assert = require("node:assert/strict");

const notebookExport = require("../notebook-export.js");
const {
  sanitizeFilename,
  buildNotebookExportMarkdown,
  buildExportFilename,
  buildDriveCreateMetadata,
  buildDriveMoveParams,
  buildDriveFolderCreateMetadata,
  appendDriveFolderEntry,
} = notebookExport;

test("sanitizeFilename replaces characters invalid in filenames", () => {
  assert.equal(
    sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'),
    "a-b-c-d-e-f-g-h-i-j",
  );
});

test("sanitizeFilename leaves an already-clean name untouched", () => {
  assert.equal(sanitizeFilename("Already Clean Name"), "Already Clean Name");
});

test("buildNotebookExportMarkdown escapes quotes and keeps colons valid in a YAML string", () => {
  const notebook = {
    videoId: "abc123",
    videoTitle: 'The "Best" Video: A Story',
    channelName: 'Some "Channel"',
    content: "my notes",
  };

  const markdown = buildNotebookExportMarkdown(notebook);
  const lines = markdown.split("\n");

  assert.equal(lines[0], "---");
  assert.equal(lines[1], 'video: "The \\"Best\\" Video: A Story"');
  assert.equal(lines[2], "url: https://www.youtube.com/watch?v=abc123");
  assert.equal(lines[3], 'channel: "Some \\"Channel\\""');
  assert.match(lines[4], /^exported: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(lines[5], "---");
  assert.equal(lines[6], "");
  assert.equal(lines.slice(7).join("\n"), "my notes");

  // The frontmatter must never leak back into the raw content.
  assert.doesNotMatch(notebook.content, /^---/);
});

test("buildNotebookExportMarkdown handles an empty notebook", () => {
  const markdown = buildNotebookExportMarkdown({
    videoId: "",
    videoTitle: "",
    channelName: "",
    content: "",
  });

  assert.match(markdown, /^---\nvideo: ""\nurl: https:\/\/www\.youtube\.com\/watch\?v=\nchannel: ""\nexported: .+\n---\n\n$/);
});

test("buildNotebookExportMarkdown tolerates a bare notebook object", () => {
  const markdown = buildNotebookExportMarkdown({});
  assert.match(markdown, /^---\n/);
  assert.match(markdown, /\n---\n\n$/);
});

test("buildExportFilename combines the video ID and title, sanitized, with a .md extension", () => {
  const filename = buildExportFilename({
    videoId: "abc123",
    videoTitle: 'Weird: Title / With "Quotes"',
  });

  assert.equal(filename, "[abc123] Weird- Title - With -Quotes-.md");
});

test("buildExportFilename handles an empty notebook", () => {
  assert.equal(buildExportFilename({}), "[] .md");
});

test("buildDriveCreateMetadata includes parents when a default folder is set", () => {
  const metadata = buildDriveCreateMetadata({
    filename: "[abc] Title.md",
    mimeType: "text/markdown",
    folderId: "folder-123",
  });

  assert.deepEqual(metadata, {
    name: "[abc] Title.md",
    mimeType: "text/markdown",
    parents: ["folder-123"],
  });
});

test("buildDriveCreateMetadata omits parents entirely (not null/empty) when no folder is set", () => {
  const metadata = buildDriveCreateMetadata({
    filename: "[abc] Title.md",
    mimeType: "text/markdown",
    folderId: undefined,
  });

  assert.deepEqual(metadata, {
    name: "[abc] Title.md",
    mimeType: "text/markdown",
  });
  assert.equal(Object.hasOwn(metadata, "parents"), false);
});

test("buildDriveFolderCreateMetadata uses the folder mimeType and given name", () => {
  assert.deepEqual(buildDriveFolderCreateMetadata("Study Notes"), {
    name: "Study Notes",
    mimeType: "application/vnd.google-apps.folder",
  });
});

test("buildDriveFolderCreateMetadata tolerates a missing name", () => {
  assert.deepEqual(buildDriveFolderCreateMetadata(undefined), {
    name: "",
    mimeType: "application/vnd.google-apps.folder",
  });
});

test("appendDriveFolderEntry adds a new folder to an empty or missing list", () => {
  const entry = { id: "f1", name: "Study Notes", createdAt: 1 };
  assert.deepEqual(appendDriveFolderEntry(undefined, entry), [entry]);
  assert.deepEqual(appendDriveFolderEntry(null, entry), [entry]);
  assert.deepEqual(appendDriveFolderEntry([], entry), [entry]);
});

test("appendDriveFolderEntry does not duplicate an entry for the same id", () => {
  const existing = [{ id: "f1", name: "Study Notes", createdAt: 1 }];
  const result = appendDriveFolderEntry(existing, {
    id: "f1",
    name: "Study Notes (renamed elsewhere)",
    createdAt: 2,
  });

  assert.equal(result.length, 1);
  assert.deepEqual(result, existing);
});

test("appendDriveFolderEntry keeps existing folders and appends a genuinely new one", () => {
  const existing = [{ id: "f1", name: "Study Notes", createdAt: 1 }];
  const result = appendDriveFolderEntry(existing, { id: "f2", name: "Recipes", createdAt: 2 });

  assert.deepEqual(result, [
    { id: "f1", name: "Study Notes", createdAt: 1 },
    { id: "f2", name: "Recipes", createdAt: 2 },
  ]);
});

test("buildDriveMoveParams returns null when no default folder is set", () => {
  assert.equal(buildDriveMoveParams(["old-folder"], null), null);
  assert.equal(buildDriveMoveParams(["old-folder"], undefined), null);
});

test("buildDriveMoveParams returns null when the file already lives in the target folder", () => {
  assert.equal(buildDriveMoveParams(["folder-1"], "folder-1"), null);
});

test("buildDriveMoveParams returns null when the target is among several current parents", () => {
  assert.equal(buildDriveMoveParams(["folder-1", "folder-2"], "folder-2"), null);
});

test("buildDriveMoveParams builds addParents/removeParents when the file needs to move", () => {
  const params = buildDriveMoveParams(["old-folder"], "new-folder");
  assert.deepEqual(params, { addParents: "new-folder", removeParents: "old-folder" });
});

test("buildDriveMoveParams joins multiple current parents with a comma for removeParents", () => {
  const params = buildDriveMoveParams(["folder-a", "folder-b"], "new-folder");
  assert.deepEqual(params, { addParents: "new-folder", removeParents: "folder-a,folder-b" });
});

test("buildDriveMoveParams omits removeParents entirely when the file currently has no parents", () => {
  const params = buildDriveMoveParams([], "new-folder");
  assert.deepEqual(params, { addParents: "new-folder" });
  assert.equal(Object.hasOwn(params, "removeParents"), false);

  const paramsFromMissing = buildDriveMoveParams(undefined, "new-folder");
  assert.deepEqual(paramsFromMissing, { addParents: "new-folder" });
});
