const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * Loads background.js in a sandboxed VM, same approach as
 * tests/translation.test.js and tests/notebook.test.js, and returns its
 * __YTD_CHAT_TESTING__ hook plus the in-memory chrome.storage.local backing
 * store so tests can seed a cached transcript / notebook directly.
 */
function loadChatHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  },
  fetchImpl = fetch,
  localStorage: seedLocalStorage = {},
} = {}) {
  const listeners = { addListener() {} };
  const localStorage = { ytd_settings: settings, ...seedLocalStorage };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
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
      normalize: (value) => value,
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return { helpers: sandbox.__YTD_CHAT_TESTING__, localStorage };
}

/** Mocks fetch so a chrome-extension:// prompt-file read serves the real
 * prompts/chat.md from disk, and any other request is treated as the
 * DeepSeek completion call, captured into `requests`. */
function chatMdFetch(requests, { replyText = "It's about testing." } = {}) {
  return async (url, options) => {
    if (url.startsWith("chrome-extension://")) {
      return { ok: true, text: async () => read("prompts/chat.md") };
    }
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: replyText } }],
      }),
    };
  };
}

test("buildChatRequest puts the system context first on a first turn with empty history", () => {
  const { helpers } = loadChatHelpers();
  const request = helpers.buildChatRequest("SYSTEM CONTEXT", [
    { role: "user", content: "What is this video about?" },
  ]);

  assert.equal(request.maxTokens, 1024);
  assert.deepEqual(JSON.parse(JSON.stringify(request.messages)), [
    { role: "system", content: "SYSTEM CONTEXT" },
    { role: "user", content: "What is this video about?" },
  ]);
});

test("buildChatRequest preserves a multi-turn conversation in order", () => {
  const { helpers } = loadChatHelpers();
  const history = [
    { role: "user", content: "What is this video about?" },
    { role: "assistant", content: "It's about testing." },
    { role: "user", content: "Can you say more?" },
  ];
  const request = helpers.buildChatRequest("SYSTEM CONTEXT", history);

  assert.deepEqual(JSON.parse(JSON.stringify(request.messages)), [
    { role: "system", content: "SYSTEM CONTEXT" },
    ...history,
  ]);
});

test("buildChatRequest tolerates a non-array messages value instead of throwing", () => {
  const { helpers } = loadChatHelpers();
  const request = helpers.buildChatRequest("SYSTEM CONTEXT", undefined);

  assert.deepEqual(JSON.parse(JSON.stringify(request.messages)), [
    { role: "system", content: "SYSTEM CONTEXT" },
  ]);
});

test("a chat reply is grounded in the cached transcript and the viewer's notebook", async () => {
  const requests = [];
  const { helpers } = loadChatHelpers({
    fetchImpl: chatMdFetch(requests),
    localStorage: {
      "digest_video-a": {
        transcriptTimestamped: "[0:00] Hello world, this is a test video.",
      },
      "ytd_notebook_video-a": { content: "My note: this seems important." },
    },
  });

  const result = await helpers.handleChatWithTranscript("video-a", [
    { role: "user", content: "What did they say?" },
  ]);

  assert.equal(result.success, true);
  assert.equal(result.reply, "It's about testing.");
  assert.equal(requests.length, 1);
  const systemMessage = requests[0].messages[0];
  assert.equal(systemMessage.role, "system");
  assert.match(systemMessage.content, /Hello world, this is a test video\./);
  assert.match(systemMessage.content, /My note: this seems important\./);
  // The conversation's own latest question rides after the system message,
  // unchanged (this is the literal messages array chatWithTranscript received).
  assert.deepEqual(
    JSON.parse(JSON.stringify(requests[0].messages.slice(1))),
    [{ role: "user", content: "What did they say?" }],
  );
});

test("an empty notebook leaves the notes placeholder well-formed, not undefined", async () => {
  const requests = [];
  const { helpers } = loadChatHelpers({
    fetchImpl: chatMdFetch(requests),
    localStorage: {
      "digest_video-b": { transcriptTimestamped: "[0:00] Only a transcript." },
      // No ytd_notebook_video-b entry at all — this video has no notebook yet.
    },
  });

  const result = await helpers.handleChatWithTranscript("video-b", [
    { role: "user", content: "Summarize this." },
  ]);

  assert.equal(result.success, true);
  const systemMessage = requests[0].messages[0].content;
  assert.doesNotMatch(systemMessage, /undefined/);
  assert.match(systemMessage, /Only a transcript\./);
});

test("a multi-turn conversation reaches DeepSeek in order after the system message", async () => {
  const requests = [];
  const { helpers } = loadChatHelpers({
    fetchImpl: chatMdFetch(requests),
    localStorage: {
      "digest_video-a": { transcriptTimestamped: "[0:00] Hello world." },
    },
  });

  const history = [
    { role: "user", content: "What is this video about?" },
    { role: "assistant", content: "It's about testing." },
    { role: "user", content: "Can you say more?" },
  ];
  await helpers.handleChatWithTranscript("video-a", history);

  assert.deepEqual(
    JSON.parse(JSON.stringify(requests[0].messages.slice(1))),
    history,
  );
});

test("chatWithTranscript surfaces a missing AI key distinctly", async () => {
  const { helpers } = loadChatHelpers({
    settings: { provider: "deepseek", aiApiKey: "", aiModel: "deepseek-v4-flash" },
    fetchImpl: async () => {
      throw new Error("Must not call the network without an API key");
    },
  });

  const result = await helpers.handleChatWithTranscript("video-a", [
    { role: "user", content: "Hello?" },
  ]);

  assert.equal(result.success, false);
  assert.equal(result.code, "NO_AI_KEY");
  assert.match(result.error, /API key/i);
});

test("chatWithTranscript resolves the literal loadPromptSection(\"chat.md\", ...) call", async () => {
  // This is the same convention scripts/check-release.sh relies on: it
  // statically greps background.js for `loadPromptSection("chat.md"` calls
  // and requires the referenced file to exist and be allowlisted. Loading
  // the real prompts/chat.md from disk here (via chatMdFetch) proves the
  // literal call in background.js actually resolves against that file.
  const requests = [];
  const { helpers } = loadChatHelpers({
    fetchImpl: chatMdFetch(requests),
    localStorage: {
      "digest_video-a": { transcriptTimestamped: "[0:00] Hello world." },
    },
  });

  const result = await helpers.handleChatWithTranscript("video-a", [
    { role: "user", content: "Hi" },
  ]);

  assert.equal(result.success, true);
  assert.match(requests[0].messages[0].content, /answering questions about a YouTube video/i);
});
