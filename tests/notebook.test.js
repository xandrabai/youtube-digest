const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * Loads background.js in a sandboxed VM, same approach as
 * tests/translation.test.js, and returns its __YTD_NOTEBOOK_TESTING__ hook
 * plus the in-memory chrome.storage.local backing store so tests can assert
 * on raw persisted state.
 */
function loadNotebookHelpers() {
  const listeners = { addListener() {} };
  const localStorage = { ytd_settings: {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: async () => {
      throw new Error("Notebook storage must not call a network provider");
    },
    AbortController,
    setTimeout,
    clearTimeout,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) => {
            if (key === null || key === undefined) return { ...localStorage };
            if (Array.isArray(key)) {
              return Object.fromEntries(
                key.map((item) => [item, localStorage[item]]),
              );
            }
            return { [key]: localStorage[key] };
          },
          set: async (values) => Object.assign(localStorage, values),
          remove: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete localStorage[key];
            }
          },
        },
      },
      action: { onClicked: listeners },
      sidePanel: { setPanelBehavior() {}, setOptions: () => Promise.resolve() },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value || {},
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return { helpers: sandbox.__YTD_NOTEBOOK_TESTING__, localStorage };
}

const notebookExport = require("../notebook-export.js");

/**
 * Same sandbox as loadNotebookHelpers, but wired for the Drive export path:
 * a real YTD_NOTEBOOK_EXPORT (importScripts is mocked out, so background.js
 * never actually loads notebook-export.js itself), a controllable fetch for
 * the Drive API calls, and a chrome.identity mock.
 */
function loadNotebookHelpersWithDrive({ fetchImpl, getAuthToken, removeCachedAuthToken } = {}) {
  const listeners = { addListener() {} };
  const localStorage = { ytd_settings: {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl || (async () => {
      throw new Error("This test must provide a fetchImpl");
    }),
    AbortController,
    setTimeout,
    clearTimeout,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) => {
            if (key === null || key === undefined) return { ...localStorage };
            if (Array.isArray(key)) {
              return Object.fromEntries(
                key.map((item) => [item, localStorage[item]]),
              );
            }
            return { [key]: localStorage[key] };
          },
          set: async (values) => Object.assign(localStorage, values),
          remove: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete localStorage[key];
            }
          },
        },
      },
      identity: {
        getAuthToken:
          getAuthToken ||
          ((_details, callback) => callback("test-token")),
        removeCachedAuthToken: removeCachedAuthToken || ((_details, callback) => callback()),
      },
      action: { onClicked: listeners },
      sidePanel: { setPanelBehavior() {}, setOptions: () => Promise.resolve() },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
        lastError: undefined,
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value || {},
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
    },
    YTD_NOTEBOOK_EXPORT: notebookExport,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return { helpers: sandbox.__YTD_NOTEBOOK_TESTING__, localStorage };
}

/**
 * Loads sidepanel.js in a sandboxed VM, same minimal approach as
 * tests/translation.test.js's loadSidepanelHelpers, and returns its
 * __YTD_TRANSCRIPT_TESTING__ hook (which also carries saveNotebook).
 */
function loadSidepanelNotebookHelpers({ sendMessage } = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({ set textContent(_t) {}, get innerHTML() { return ""; } }),
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage },
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        session: { get: async () => ({}), set: async () => {} },
      },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

test("the side panel's saveNotebook sends videoId, content, title, and channel", async () => {
  const calls = [];
  const { saveNotebook } = loadSidepanelNotebookHelpers({
    sendMessage: (message) => {
      calls.push(message);
      return Promise.resolve({ success: true });
    },
  });

  await saveNotebook("video-a", "some notes\n\n- a bullet");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "saveNotebook");
  assert.equal(calls[0].videoId, "video-a");
  assert.equal(calls[0].content, "some notes\n\n- a bullet");
});

test("a video with no saved notebook returns null, not an error", async () => {
  const { helpers } = loadNotebookHelpers();

  const result = await helpers.handleGetNotebook("video-a");

  assert.equal(result.success, true);
  assert.equal(result.notebook, null);
});

test("saving a notebook persists content and keeps it independent per video", async () => {
  const { helpers, localStorage } = loadNotebookHelpers();

  const saved = await helpers.handleSaveNotebook(
    "video-a",
    "line one\n\n- a bullet",
    "Video A",
    "Channel A",
  );
  assert.equal(saved.success, true);
  assert.equal(saved.notebook.content, "line one\n\n- a bullet");
  assert.equal(saved.notebook.videoTitle, "Video A");
  assert.equal(saved.notebook.channelName, "Channel A");
  assert.equal(localStorage.ytd_notebook_video_a, undefined);
  assert.ok(localStorage["ytd_notebook_video-a"]);

  const loadedA = await helpers.handleGetNotebook("video-a");
  assert.equal(loadedA.notebook.content, "line one\n\n- a bullet");

  const loadedB = await helpers.handleGetNotebook("video-b");
  assert.equal(loadedB.notebook, null, "a different video's notebook is unaffected");
});

test("re-saving a notebook preserves its original createdAt and bumps updatedAt", async () => {
  const { helpers } = loadNotebookHelpers();

  const first = await helpers.handleSaveNotebook("video-a", "draft", "Video A", "Channel A");
  const second = await helpers.handleSaveNotebook(
    "video-a",
    "draft, revised",
    "Video A",
    "Channel A",
  );

  assert.equal(second.notebook.createdAt, first.notebook.createdAt);
  assert.equal(second.notebook.content, "draft, revised");
  assert.ok(second.notebook.updatedAt >= first.notebook.updatedAt);
});

test("handleSaveNotebook preserves an arbitrary unrelated field across a content-only autosave, unnamed anywhere in the save logic", async () => {
  const { helpers, localStorage } = loadNotebookHelpers();

  await helpers.handleSaveNotebook("video-a", "draft", "Video A", "Channel A");
  // Simulate some future feature stamping an optional field onto the
  // record, the same way driveFolderId/driveFileId/lastSyncedAt do today —
  // handleSaveNotebook must never need to know this field's name to keep it.
  localStorage["ytd_notebook_video-a"].someFutureField = { nested: "value" };

  const result = await helpers.handleSaveNotebook(
    "video-a",
    "draft, edited",
    "Video A",
    "Channel A",
  );

  assert.equal(result.success, true);
  assert.equal(result.notebook.content, "draft, edited");
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.notebook.someFutureField)),
    { nested: "value" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(localStorage["ytd_notebook_video-a"].someFutureField)),
    { nested: "value" },
  );
});

test("saving a notebook keeps ytd_notebook_index in sync", async () => {
  const { helpers, localStorage } = loadNotebookHelpers();

  await helpers.handleSaveNotebook("video-a", "first", "Video A", "Channel A");
  await helpers.handleSaveNotebook("video-b", "second", "Video B", "Channel B");
  await helpers.handleSaveNotebook("video-a", "first, edited", "Video A Renamed", "Channel A");

  const index = localStorage.ytd_notebook_index;
  assert.equal(index.length, 2, "editing an existing video must not duplicate its index entry");

  const entryA = index.find((item) => item.videoId === "video-a");
  const entryB = index.find((item) => item.videoId === "video-b");
  assert.equal(entryA.title, "Video A Renamed");
  assert.equal(entryB.title, "Video B");
});

test("upsertNotebookIndexEntry replaces an existing entry and tolerates bad input", () => {
  const { helpers } = loadNotebookHelpers();
  const { upsertNotebookIndexEntry } = helpers;
  // Results cross the vm sandbox boundary — normalize through JSON so
  // deepEqual compares plain structure rather than realm-specific prototypes.
  const plain = (value) => JSON.parse(JSON.stringify(value));

  const withNewEntry = upsertNotebookIndexEntry(
    [{ videoId: "a", title: "A", updatedAt: 1 }],
    { videoId: "b", title: "B", updatedAt: 2 },
  );
  assert.deepEqual(plain(withNewEntry), [
    { videoId: "a", title: "A", updatedAt: 1 },
    { videoId: "b", title: "B", updatedAt: 2 },
  ]);

  const withReplacedEntry = upsertNotebookIndexEntry(withNewEntry, {
    videoId: "a",
    title: "A updated",
    updatedAt: 3,
  });
  assert.deepEqual(plain(withReplacedEntry), [
    { videoId: "b", title: "B", updatedAt: 2 },
    { videoId: "a", title: "A updated", updatedAt: 3 },
  ]);

  assert.deepEqual(
    plain(upsertNotebookIndexEntry(undefined, { videoId: "a", title: "A", updatedAt: 1 })),
    [{ videoId: "a", title: "A", updatedAt: 1 }],
  );
  assert.deepEqual(
    plain(upsertNotebookIndexEntry(null, { videoId: "a", title: "A", updatedAt: 1 })),
    [{ videoId: "a", title: "A", updatedAt: 1 }],
  );
});

test("exporting a notebook with no driveFileId yet creates a new Drive file", async () => {
  const { helpers, localStorage } = loadNotebookHelpersWithDrive({
    fetchImpl: async (url, init) => {
      assert.equal(init.method, "POST");
      assert.match(url, /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/);
      assert.match(init.headers.Authorization, /^Bearer test-token$/);
      return {
        ok: true,
        json: async () => ({ id: "drive-file-1", webViewLink: "https://drive.example/1" }),
      };
    },
  });

  await helpers.handleSaveNotebook("video-a", "my notes", "Title", "Channel");
  const result = await helpers.handleExportNotebookToDrive("video-a");

  assert.equal(result.success, true);
  assert.equal(result.driveFileId, "drive-file-1");
  assert.equal(result.driveFileUrl, "https://drive.example/1");
  assert.ok(result.lastSyncedAt);
  assert.equal(localStorage["ytd_notebook_video-a"].driveFileId, "drive-file-1");
});

test("exporting a notebook that already has a driveFileId overwrites the same file (PATCH), not a new one", async () => {
  const requestedUrls = [];
  const { helpers, localStorage } = loadNotebookHelpersWithDrive({
    fetchImpl: async (url, init) => {
      requestedUrls.push({ url, method: init.method });
      if (!init.method) {
        // driveGetFile's existence/trashed check ahead of the update.
        return { ok: true, json: async () => ({ id: "existing-file", trashed: false, parents: [] }) };
      }
      return {
        ok: true,
        json: async () => ({ id: "existing-file", webViewLink: "https://drive.example/existing" }),
      };
    },
  });

  await helpers.handleSaveNotebook("video-a", "first draft", "Title", "Channel");
  await helpers.handleExportNotebookToDrive("video-a");
  await helpers.handleSaveNotebook("video-a", "revised draft", "Title", "Channel");
  const second = await helpers.handleExportNotebookToDrive("video-a");

  assert.equal(second.success, true);
  assert.equal(second.driveFileId, "existing-file");
  assert.equal(requestedUrls.length, 3);
  assert.equal(requestedUrls[0].method, "POST"); // first export: create
  assert.equal(requestedUrls[1].url.includes("/upload/"), false); // second export: files.get check
  assert.equal(requestedUrls[1].method, undefined);
  assert.equal(requestedUrls[2].url.includes("/upload/"), true); // second export: PATCH update
  assert.equal(requestedUrls[2].method, "PATCH");
  assert.equal(localStorage["ytd_notebook_video-a"].driveFileId, "existing-file");
});

test("a stale driveFileId that 404s on files.get is treated as gone: a brand-new file is created instead", async () => {
  const requestedUrls = [];
  const { helpers, localStorage } = loadNotebookHelpersWithDrive({
    fetchImpl: async (url, init) => {
      requestedUrls.push({ url, method: init.method });
      if (!init.method) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ id: "new-file", webViewLink: "https://drive.example/new" }) };
    },
  });

  await helpers.handleSaveNotebook("video-a", "draft", "Title", "Channel");
  localStorage["ytd_notebook_video-a"].driveFileId = "deleted-file";
  localStorage["ytd_notebook_video-a"].driveFileUrl = "https://drive.example/deleted";

  const result = await helpers.handleExportNotebookToDrive("video-a");

  assert.equal(result.success, true);
  assert.equal(result.driveFileId, "new-file");
  assert.equal(localStorage["ytd_notebook_video-a"].driveFileId, "new-file");
  // The fallback create request must be a POST (no fileId), not a PATCH
  // onto the deleted id.
  const createCall = requestedUrls.find((call) => call.method === "POST");
  assert.ok(createCall);
});

test("a trashed driveFileId is treated the same as a missing file: a brand-new file is created", async () => {
  const requestedUrls = [];
  const { helpers, localStorage } = loadNotebookHelpersWithDrive({
    fetchImpl: async (url, init) => {
      requestedUrls.push({ url, method: init.method });
      if (!init.method) {
        return { ok: true, json: async () => ({ id: "trashed-file", trashed: true, parents: ["old-folder"] }) };
      }
      return { ok: true, json: async () => ({ id: "new-file", webViewLink: "https://drive.example/new" }) };
    },
  });

  await helpers.handleSaveNotebook("video-a", "draft", "Title", "Channel");
  localStorage["ytd_notebook_video-a"].driveFileId = "trashed-file";
  localStorage["ytd_notebook_video-a"].driveFileUrl = "https://drive.example/trashed";
  localStorage["ytd_notebook_video-a"].driveFolderId = "old-folder";

  const result = await helpers.handleExportNotebookToDrive("video-a");

  assert.equal(result.success, true);
  assert.equal(result.driveFileId, "new-file");
  assert.equal(localStorage["ytd_notebook_video-a"].driveFileId, "new-file");
  const createCall = requestedUrls.find((call) => call.method === "POST");
  assert.ok(createCall, "the fallback must POST a fresh create, not PATCH the trashed id");
});

test("changing the default folder moves an already-exported file via addParents/removeParents in the same update call", async () => {
  let updateUrl = null;
  const { helpers, localStorage } = loadNotebookHelpersWithDrive({
    fetchImpl: async (url, init) => {
      if (!init.method) {
        // The file's ACTUAL current parent, per Drive itself.
        return { ok: true, json: async () => ({ id: "existing-file", trashed: false, parents: ["old-folder"] }) };
      }
      updateUrl = url;
      return { ok: true, json: async () => ({ id: "existing-file", webViewLink: "https://drive.example/existing" }) };
    },
  });

  await helpers.handleSaveNotebook("video-a", "draft", "Title", "Channel");
  localStorage["ytd_notebook_video-a"].driveFileId = "existing-file";
  localStorage["ytd_notebook_video-a"].driveFolderId = "old-folder";
  localStorage.ytd_drive_folder = { id: "new-folder", name: "New Folder" };

  const result = await helpers.handleExportNotebookToDrive("video-a");

  assert.equal(result.success, true);
  assert.match(updateUrl, /[?&]addParents=new-folder(&|$)/);
  assert.match(updateUrl, /[?&]removeParents=old-folder(&|$)/);
  assert.equal(localStorage["ytd_notebook_video-a"].driveFolderId, "new-folder");
});

test("re-exporting to the same default folder is a content-only update with no parent changes", async () => {
  let updateUrl = null;
  const { helpers, localStorage } = loadNotebookHelpersWithDrive({
    fetchImpl: async (url, init) => {
      if (!init.method) {
        return { ok: true, json: async () => ({ id: "existing-file", trashed: false, parents: ["same-folder"] }) };
      }
      updateUrl = url;
      return { ok: true, json: async () => ({ id: "existing-file", webViewLink: "https://drive.example/existing" }) };
    },
  });

  await helpers.handleSaveNotebook("video-a", "draft", "Title", "Channel");
  localStorage["ytd_notebook_video-a"].driveFileId = "existing-file";
  localStorage["ytd_notebook_video-a"].driveFolderId = "same-folder";
  localStorage.ytd_drive_folder = { id: "same-folder", name: "Same Folder" };

  const result = await helpers.handleExportNotebookToDrive("video-a");

  assert.equal(result.success, true);
  assert.equal(updateUrl.includes("addParents"), false);
  assert.equal(updateUrl.includes("removeParents"), false);
});

test("export trusts Drive's actual current parents over the last stored driveFolderId when deciding whether to move", async () => {
  // The user manually moved the file in Drive itself to "user-moved-folder",
  // but our own stored driveFolderId still says "old-folder" — and the
  // default export folder was never changed. Drive's own answer wins: no
  // move happens, since the file already sits in a folder that happens to
  // equal the (unchanged) default... swap this around: default IS
  // "target-folder", stored driveFolderId incorrectly still says
  // "target-folder" too, but Drive's real parent is something else — the
  // move must still happen because it trusts the live files.get answer.
  let updateUrl = null;
  const { helpers, localStorage } = loadNotebookHelpersWithDrive({
    fetchImpl: async (url, init) => {
      if (!init.method) {
        return { ok: true, json: async () => ({ id: "existing-file", trashed: false, parents: ["user-moved-folder"] }) };
      }
      updateUrl = url;
      return { ok: true, json: async () => ({ id: "existing-file", webViewLink: "https://drive.example/existing" }) };
    },
  });

  await helpers.handleSaveNotebook("video-a", "draft", "Title", "Channel");
  localStorage["ytd_notebook_video-a"].driveFileId = "existing-file";
  localStorage["ytd_notebook_video-a"].driveFolderId = "target-folder"; // stale/incorrect local belief
  localStorage.ytd_drive_folder = { id: "target-folder", name: "Target Folder" };

  const result = await helpers.handleExportNotebookToDrive("video-a");

  assert.equal(result.success, true);
  assert.match(updateUrl, /[?&]addParents=target-folder(&|$)/);
  assert.match(updateUrl, /[?&]removeParents=user-moved-folder(&|$)/);
});

test("a later autosave does not wipe out Drive sync fields set by a previous export", async () => {
  const { helpers, localStorage } = loadNotebookHelpersWithDrive({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ id: "drive-file-9", webViewLink: "https://drive.example/9" }),
    }),
  });

  await helpers.handleSaveNotebook("video-a", "draft", "Title", "Channel");
  await helpers.handleExportNotebookToDrive("video-a");
  await helpers.handleSaveNotebook("video-a", "draft, edited after syncing", "Title", "Channel");

  const stored = localStorage["ytd_notebook_video-a"];
  assert.equal(stored.content, "draft, edited after syncing");
  assert.equal(stored.driveFileId, "drive-file-9");
  assert.equal(stored.driveFileUrl, "https://drive.example/9");
  assert.ok(stored.lastSyncedAt);
});

test("exporting with no saved notebook returns NOTEBOOK_NOT_FOUND", async () => {
  const { helpers } = loadNotebookHelpersWithDrive({});

  const result = await helpers.handleExportNotebookToDrive("never-saved");

  assert.equal(result.success, false);
  assert.equal(result.code, "NOTEBOOK_NOT_FOUND");
});

test("export falls back to an interactive auth prompt only after the silent attempt fails", async () => {
  const calls = [];
  const { helpers } = loadNotebookHelpersWithDrive({
    getAuthToken: (details, callback) => {
      calls.push(details.interactive);
      if (!details.interactive) {
        callback(undefined); // simulates no cached token
        return;
      }
      callback("interactive-token");
    },
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Authorization, "Bearer interactive-token");
      return { ok: true, json: async () => ({ id: "f1", webViewLink: "https://drive.example/f1" }) };
    },
  });

  await helpers.handleSaveNotebook("video-a", "draft", "Title", "Channel");
  const result = await helpers.handleExportNotebookToDrive("video-a");

  assert.equal(result.success, true);
  assert.deepEqual(calls, [false, true]);
});

test("export never prompts interactively when a cached token already works", async () => {
  const calls = [];
  const { helpers } = loadNotebookHelpersWithDrive({
    getAuthToken: (details, callback) => {
      calls.push(details.interactive);
      callback("cached-token");
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ id: "f1", webViewLink: "https://drive.example/f1" }),
    }),
  });

  await helpers.handleSaveNotebook("video-a", "draft", "Title", "Channel");
  await helpers.handleExportNotebookToDrive("video-a");

  assert.deepEqual(calls, [false]);
});

test("export reports DRIVE_AUTH_FAILED when both the silent and interactive auth attempts fail", async () => {
  const { helpers } = loadNotebookHelpersWithDrive({
    getAuthToken: (_details, callback) => callback(undefined),
  });

  await helpers.handleSaveNotebook("video-a", "draft", "Title", "Channel");
  const result = await helpers.handleExportNotebookToDrive("video-a");

  assert.equal(result.success, false);
  assert.equal(result.code, "DRIVE_AUTH_FAILED");
});

test("export reports DRIVE_QUOTA_EXCEEDED when Drive's API returns a quota error", async () => {
  const { helpers } = loadNotebookHelpersWithDrive({
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        error: { message: "quota exceeded", errors: [{ reason: "storageQuotaExceeded" }] },
      }),
    }),
  });

  await helpers.handleSaveNotebook("video-a", "draft", "Title", "Channel");
  const result = await helpers.handleExportNotebookToDrive("video-a");

  assert.equal(result.success, false);
  assert.equal(result.code, "DRIVE_QUOTA_EXCEEDED");
});

function metadataFromMultipartBody(body) {
  const match = body.match(
    /Content-Type: application\/json[^\r\n]*\r\n\r\n(\{[\s\S]*?\})\r\n--/,
  );
  return JSON.parse(match[1]);
}

test("first-time export includes parents when a default Drive folder is set", async () => {
  const { helpers, localStorage } = loadNotebookHelpersWithDrive({
    fetchImpl: async (_url, init) => {
      const metadata = metadataFromMultipartBody(init.body);
      assert.deepEqual(metadata.parents, ["folder-123"]);
      return { ok: true, json: async () => ({ id: "f1", webViewLink: "https://drive.example/f1" }) };
    },
  });
  localStorage.ytd_drive_folder = { id: "folder-123", name: "My Folder" };

  await helpers.handleSaveNotebook("video-a", "draft", "Title", "Channel");
  const result = await helpers.handleExportNotebookToDrive("video-a");

  assert.equal(result.success, true);
});

test("first-time export omits parents entirely when no default folder is set", async () => {
  const { helpers } = loadNotebookHelpersWithDrive({
    fetchImpl: async (_url, init) => {
      const metadata = metadataFromMultipartBody(init.body);
      assert.equal(Object.hasOwn(metadata, "parents"), false);
      return { ok: true, json: async () => ({ id: "f1", webViewLink: "https://drive.example/f1" }) };
    },
  });

  await helpers.handleSaveNotebook("video-a", "draft", "Title", "Channel");
  const result = await helpers.handleExportNotebookToDrive("video-a");

  assert.equal(result.success, true);
});

test("handleGetDriveFolder returns null when no default folder has been chosen", async () => {
  const { helpers } = loadNotebookHelpersWithDrive({});
  const result = await helpers.handleGetDriveFolder();
  assert.equal(result.success, true);
  assert.equal(result.folder, null);
});

test("handleSetDriveFolder persists the folder and handleGetDriveFolder reads it back", async () => {
  const { helpers } = loadNotebookHelpersWithDrive({});

  const setResult = await helpers.handleSetDriveFolder({ id: "folder-1", name: "Study Notes" });
  assert.equal(setResult.success, true);

  const getResult = await helpers.handleGetDriveFolder();
  // Crosses the vm sandbox boundary, so compare plain structure rather than
  // realm-specific prototypes (same reason other tests in this file do).
  assert.deepEqual(
    JSON.parse(JSON.stringify(getResult.folder)),
    { id: "folder-1", name: "Study Notes" },
  );
});

test("handleSetDriveFolder rejects a folder with no id", async () => {
  const { helpers } = loadNotebookHelpersWithDrive({});
  const result = await helpers.handleSetDriveFolder({ name: "No ID" });
  assert.equal(result.success, false);
  assert.equal(result.code, "DRIVE_FOLDER_INVALID");
});

test("handleSetDriveFolder clears the default back to My Drive root when passed null", async () => {
  const { helpers, localStorage } = loadNotebookHelpersWithDrive({});

  await helpers.handleSetDriveFolder({ id: "folder-1", name: "Study Notes" });
  const cleared = await helpers.handleSetDriveFolder(null);

  assert.equal(cleared.success, true);
  assert.equal(cleared.folder, null);
  assert.equal(localStorage.ytd_drive_folder, undefined);
});

test("handleCreateDriveFolder creates a folder via files.create and records it in the folder list", async () => {
  const { helpers, localStorage } = loadNotebookHelpersWithDrive({
    fetchImpl: async (url, init) => {
      assert.match(url, /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\?/);
      assert.equal(init.method, "POST");
      const body = JSON.parse(init.body);
      assert.deepEqual(body, { name: "Study Notes", mimeType: "application/vnd.google-apps.folder" });
      return { ok: true, json: async () => ({ id: "folder-1", name: "Study Notes" }) };
    },
  });

  const result = await helpers.handleCreateDriveFolder("Study Notes");

  assert.equal(result.success, true);
  assert.equal(result.folder.id, "folder-1");
  assert.equal(result.folder.name, "Study Notes");
  assert.ok(result.folder.createdAt);
  assert.equal(localStorage.ytd_drive_folders.length, 1);
  assert.equal(localStorage.ytd_drive_folders[0].id, "folder-1");
});

test("handleCreateDriveFolder rejects a blank name without calling Drive", async () => {
  const { helpers } = loadNotebookHelpersWithDrive({
    fetchImpl: async () => {
      throw new Error("must not call Drive for a blank name");
    },
  });

  const result = await helpers.handleCreateDriveFolder("   ");

  assert.equal(result.success, false);
  assert.equal(result.code, "DRIVE_FOLDER_INVALID");
});

test("handleCreateDriveFolder reports DRIVE_AUTH_FAILED and clears the token on a 401", async () => {
  const removedTokens = [];
  const { helpers } = loadNotebookHelpersWithDrive({
    removeCachedAuthToken: (details, callback) => {
      removedTokens.push(details.token);
      callback();
    },
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "invalid credentials" } }),
    }),
  });

  const result = await helpers.handleCreateDriveFolder("Study Notes");

  assert.equal(result.success, false);
  assert.equal(result.code, "DRIVE_AUTH_FAILED");
  assert.deepEqual(removedTokens, ["test-token"]);
});

test("handleListDriveFolders returns an empty list when none have been created", async () => {
  const { helpers } = loadNotebookHelpersWithDrive({});
  const result = await helpers.handleListDriveFolders();
  assert.equal(result.success, true);
  assert.equal(result.folders.length, 0);
});

test("handleListDriveFolders returns folders created via handleCreateDriveFolder", async () => {
  const { helpers } = loadNotebookHelpersWithDrive({
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: "folder-1", name: "Study Notes" }) }),
  });

  await helpers.handleCreateDriveFolder("Study Notes");
  const result = await helpers.handleListDriveFolders();

  assert.equal(result.success, true);
  assert.equal(result.folders.length, 1);
  assert.equal(result.folders[0].id, "folder-1");
});

test("export reports DRIVE_API_ERROR for other Drive failures and clears the token on a 401", async () => {
  const removedTokens = [];
  const { helpers } = loadNotebookHelpersWithDrive({
    removeCachedAuthToken: (details, callback) => {
      removedTokens.push(details.token);
      callback();
    },
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "invalid credentials" } }),
    }),
  });

  await helpers.handleSaveNotebook("video-a", "draft", "Title", "Channel");
  const result = await helpers.handleExportNotebookToDrive("video-a");

  assert.equal(result.success, false);
  assert.equal(result.code, "DRIVE_AUTH_FAILED");
  assert.deepEqual(removedTokens, ["test-token"]);
});
