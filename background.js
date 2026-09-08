/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching YouTube transcripts via Supadata API
 * 3. Calling DeepSeek to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts("settings.js", "notebook-export.js");

const DEBUG = false;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Prevent the YouTube content script from reading API keys or cached data.
// Side panel, options, and service-worker contexts remain trusted.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[YouTube Digest] Could not restrict storage access:", error),
  );

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
}) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    const error = new Error(
      "DeepSeek API key not configured. Open YouTube Digest Settings.",
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  const body = {
    model: settings.aiModel,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  // Product features need bounded, predictable latency rather than reasoning traces.
  body.thinking = { type: "disabled" };

  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      AI_PROVIDER_IDLE_TIMEOUT_MS,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    AI_PROVIDER_HARD_TIMEOUT_MS,
  );
  resetIdleTimeout();
  try {
    const response = await fetch(
      YTD_SETTINGS.chatCompletionsUrl(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    // Receiving headers proves DeepSeek is still making progress. DeepSeek
    // may then send blank-line body chunks while a non-streaming request queues.
    resetIdleTimeout();

    const data = await readBoundedAiResponse(response, resetIdleTimeout);
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `DeepSeek error: ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("DeepSeek returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        "DeepSeek request was inactive for 50 seconds. Please Retry.",
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        "DeepSeek request exceeded the 120-second limit. Please Retry.",
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including DeepSeek's blank lines.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  if (!(tab.url || "").startsWith("https://www.youtube.com")) {
    void updatePanelForTab(tab.id, tab.url, tab.windowId);
    return;
  }

  // Re-enable + open without awaiting — preserves user gesture context
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

/**
 * Allow the side panel to open on any page, but it's designed for YouTube.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to YouTube tabs only.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make YouTube Digest behave like a YouTube-only tool, we
 * enable the panel on YouTube tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded non-YouTube tab.
 */
async function closePanelForTab(tabId, windowId) {
  // Chrome 141 added an explicit close API. On older supported versions,
  // disabling the tab-specific panel below remains the compatibility path.
  if (typeof chrome.sidePanel.close !== "function") return;

  try {
    // This closes the tab-specific panel used by YouTube Digest.
    await chrome.sidePanel.close({ tabId });
    return;
  } catch (error) {
    // Chrome 145+ rejects tabId when the visible instance is global. Close
    // that instance by window instead.
  }

  if (Number.isInteger(windowId)) {
    await chrome.sidePanel.close({ windowId }).catch(() => {});
  }
}

async function updatePanelForTab(tabId, url, windowId) {
  const isYouTube = (url || "").startsWith("https://www.youtube.com");
  if (!isYouTube) {
    // Close the visible instance first. Then disable this tab so Chrome cannot
    // reopen the global default panel as navigation settles.
    await closePanelForTab(tabId, windowId);
    await chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
    return;
  }

  // setOptions can reject if the tab just closed. Ignore that harmlessly.
  await chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: true })
    .catch(() => {});
}

/**
 * Gets the best URL from a tab update that can change panel availability.
 * Chrome can apply tab-specific side-panel state before a navigation commits,
 * then reset it during the commit. Handling loading and complete gives the
 * first non-YouTube navigation a reliable second reconciliation.
 */
function getNavigationUrl(changeInfo, tab) {
  if (changeInfo.url) return changeInfo.url;
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete") {
    return "";
  }
  return tab.pendingUrl || tab.url || "";
}

// A tab started or completed navigation. Reconcile at both stages because
// Chrome can replace per-tab side-panel options while the page commits.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = getNavigationUrl(changeInfo, tab);
  if (!url) return; // Ignore title and favicon-only updates.
  void updatePanelForTab(tabId, url, tab.windowId);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    void updatePanelForTab(tabId, tab.url || tab.pendingUrl, windowId);
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "fetchTranscript") {
    handleFetchTranscript(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep the message channel open for async response
  }

  if (message.action === "chatWithTranscript") {
    handleChatWithTranscript(message.videoId, message.messages)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, error: err.message, code: err.code }),
      );
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using DeepSeek.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // The old per-quote note-card system (saveNote/getNotes/deleteNote/
  // updateNote against ytd_notes) is gone in favor of one freeform notebook
  // document per video. Quote-capture mechanism returns in a later step.
  if (message.action === "getNotebook") {
    handleGetNotebook(message.videoId)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, error: err.message, code: err.code }),
      );
    return true;
  }

  if (message.action === "saveNotebook") {
    handleSaveNotebook(
      message.videoId,
      message.content,
      message.videoTitle,
      message.channelName,
    )
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, error: err.message, code: err.code }),
      );
    return true;
  }

  if (message.action === "exportNotebookToDrive") {
    handleExportNotebookToDrive(message.videoId)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, error: err.message, code: err.code }),
      );
    return true;
  }

  if (message.action === "getDriveFolder") {
    handleGetDriveFolder()
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, error: err.message, code: err.code }),
      );
    return true;
  }

  if (message.action === "setDriveFolder") {
    handleSetDriveFolder(message.folder)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, error: err.message, code: err.code }),
      );
    return true;
  }

  if (message.action === "createDriveFolder") {
    handleCreateDriveFolder(message.name)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, error: err.message, code: err.code }),
      );
    return true;
  }

  if (message.action === "listDriveFolders") {
    handleListDriveFolders()
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, error: err.message, code: err.code }),
      );
    return true;
  }

  if (message.action === "getVideoInfo") {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to DeepSeek.
  if (message.action === "translateContent") {
    handleTranslateContent(
      message.content,
      message.contentType,
      message.targetLanguage,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasSupadataKey: !!settings.supadataApiKey,
          hasAiKey: !!settings.aiApiKey,
        }),
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[YouTube Digest BG] openSidePanel requested from tab:", tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    if (tabId) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      });
      chrome.sidePanel
        .open({ tabId })
        .then(() => {
          // Broadcast to side panel to start digest (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startDigestFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[YouTube Digest BG] openSidePanel error:", err);
        });
    } else {
      // Fallback: find the active tab
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then((tabs) => {
          if (tabs[0]) {
            chrome.sidePanel.setOptions({
              tabId: tabs[0].id,
              path: "sidepanel.html",
              enabled: true,
            });
            chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
              console.error(
                "[YouTube Digest BG] openSidePanel fallback error:",
                err,
              );
            });
          }
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[YouTube Digest BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        // Query specifically for YouTube tabs to avoid side panel context issues
        // Try multiple query strategies to find the right tab
        let tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        debugLog(
          "[YouTube Digest BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        // If no YouTube tab found, try broader query
        if (!tabs[0] || !tabs[0].url?.includes("youtube.com")) {
          tabs = await chrome.tabs.query({
            url: "https://www.youtube.com/*",
            active: true,
          });
          debugLog("[YouTube Digest BG] Active YouTube tabs:", tabs.length);
        }

        // Still nothing? Try any YouTube tab
        if (!tabs[0]) {
          tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
          debugLog("[YouTube Digest BG] Any YouTube tabs:", tabs.length);
        }

        if (tabs[0]) {
          debugLog(
            "[YouTube Digest BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await chrome.tabs.sendMessage(
            tabs[0].id,
            message.payload,
          );

          // For getVideoInfo, PREFER YouTube's own player data over the
          // DOM scrape. The player's videoDetails is canonical: its `author`
          // is always THIS video's channel and its `shortDescription` is the
          // full text. The DOM scrape is unreliable — e.g. on a playlist page
          // it grabbed the playlist owner's name ("Zara Zhang") instead of the
          // real channel ("Replit and Stripe"), and its description is
          // truncated while the box is collapsed. We fall back to the DOM
          // only for fields the player didn't provide.
          if (message.payload?.action === "getVideoInfo") {
            const playerInfo = await getPlayerVideoDetails(tabs[0].id);
            if (playerInfo) {
              response = {
                title: playerInfo.title || response?.title || "",
                channelName:
                  playerInfo.channelName || response?.channelName || "",
                duration: playerInfo.duration || response?.duration || 0,
                description:
                  playerInfo.description || response?.description || "",
              };
            }
          }

          debugLog("[YouTube Digest BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[YouTube Digest BG] No YouTube tab found");
          sendResponse({ success: false, error: "No YouTube tab found" });
        }
      } catch (err) {
        console.error("[YouTube Digest BG] Relay error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});

/**
 * Reads the current video's full details straight from YouTube's player.
 *
 * Content scripts live in an isolated world and can't touch the page's own
 * JavaScript. But with the "scripting" permission we can run a tiny function
 * in the page's MAIN world, where YouTube's player object lives. Its
 * getPlayerResponse() carries videoDetails with the FULL description —
 * unlike the DOM, which truncates it until the user clicks "...more".
 *
 * Returns null on any failure so callers can fall back to DOM scraping.
 */
async function getPlayerVideoDetails(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const player = document.getElementById("movie_player");
          const details = player?.getPlayerResponse?.()?.videoDetails;
          if (!details) return null;
          return {
            title: details.title || "",
            channelName: details.author || "",
            description: details.shortDescription || "",
            duration: Number(details.lengthSeconds) || 0,
          };
        } catch (e) {
          return null;
        }
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn("[YouTube Digest BG] Player details unavailable:", e.message);
    return null;
  }
}

// ============================================================
// TRANSCRIPT FETCHING VIA SUPADATA API
// ============================================================

/**
 * Fetches the transcript for a YouTube video using Supadata API.
 *
 * Supadata is a specialized service that reliably extracts transcripts
 * from YouTube videos. It handles all the complexity of parsing YouTube's
 * internal data structures, dealing with different caption formats, etc.
 *
 * API Docs: https://docs.supadata.ai
 *
 * @param {string} videoId - The YouTube video ID (e.g., "dQw4w9WgXcQ")
 * @returns {Object} - { success, transcript, transcriptText, language } or { success: false, error }
 */
async function handleFetchTranscript(videoId) {
  try {
    const settings = await getSettings();
    if (!settings.supadataApiKey) {
      return {
        success: false,
        error: "NO_SUPADATA_KEY",
        message: "Supadata API key not configured. Open YouTube Digest Settings.",
      };
    }

    // Share only the canonical watch URL. This strips playlist, referral,
    // timestamp, and other browsing parameters from the active tab URL.
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    // Using the universal transcript endpoint with text=false to get timestamped chunks
    const apiUrl = new URL("https://api.supadata.ai/v1/transcript");
    apiUrl.searchParams.set("url", canonicalVideoUrl);
    apiUrl.searchParams.set("text", "false"); // Get timestamped chunks, not plain text
    apiUrl.searchParams.set("lang", "en"); // Prefer English
    // Caption-only product scope: never fall back to paid AI transcription.
    apiUrl.searchParams.set("mode", "native");

    // Make the API request
    const response = await fetch(apiUrl.toString(), {
      method: "GET",
      headers: {
        "x-api-key": settings.supadataApiKey,
      },
    });

    // Handle async jobs (for videos > 20 minutes, Supadata returns a job ID)
    if (response.status === 202) {
      const jobData = await response.json();
      // Poll for the result
      return await pollTranscriptJob(jobData.jobId, settings.supadataApiKey);
    }

    if (response.status === 206) {
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "No native subtitle track is available for this video.",
      };
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 401) {
        return {
          success: false,
          error: "INVALID_SUPADATA_KEY",
          message: "Your Supadata API key is invalid. Open YouTube Digest Settings.",
        };
      }
      if (response.status === 404) {
        return {
          success: false,
          error: "NO_TRANSCRIPT",
          message: "No subtitles found for this video.",
        };
      }
      if (response.status === 429) {
        return {
          success: false,
          error: "RATE_LIMITED",
          message:
            "Supadata rate limit reached. Please wait a minute and try again.",
        };
      }
      throw new Error(
        errorData.message || `Supadata API error: ${response.status}`,
      );
    }

    const data = await response.json();

    // Parse the response into our internal format
    // Supadata returns: { content: [{ text, offset, duration, lang }], lang, availableLangs }
    const transcript = [];
    let transcriptTextPlain = ""; // Plain text for display/export
    let transcriptTextTimestamped = ""; // Timestamped text for AI analysis

    if (data.content && Array.isArray(data.content)) {
      for (const chunk of data.content) {
        if (chunk.text) {
          // Clean up caption artifacts:
          // ">>" = speaker change marker from YouTube auto-captions
          const cleanText = chunk.text.replace(/>> ?/g, "").trim();
          if (!cleanText) continue; // Skip if nothing left after cleanup

          // offset is in milliseconds, convert to seconds
          const startSeconds = Math.floor((chunk.offset || 0) / 1000);
          const minutes = Math.floor(startSeconds / 60);
          const seconds = startSeconds % 60;
          const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

          transcript.push({
            text: cleanText,
            start: startSeconds,
            duration: Math.floor((chunk.duration || 0) / 1000),
            language: chunk.lang || data.lang || null,
          });

          // Plain text without timestamps (for display/export)
          transcriptTextPlain += cleanText + " ";

          // Timestamped text for DeepSeek (format: [MM:SS] text)
          // This allows the model to reference actual transcript positions.
          transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
        }
      }
    }

    if (transcript.length === 0) {
      return {
        success: false,
        error: "EMPTY_TRANSCRIPT",
        message: "Supadata returned an empty transcript for this video.",
      };
    }

    return {
      success: true,
      transcript: transcript,
      transcriptText: transcriptTextPlain.trim(), // For display
      transcriptTextTimestamped: transcriptTextTimestamped.trim(), // For AI
      language: typeof data.lang === "string" ? data.lang : null,
    };
  } catch (error) {
    console.error("Transcript fetch error:", error);
    return {
      success: false,
      error: error.message || "Failed to fetch transcript",
    };
  }
}

/**
 * Polls for transcript job completion (for long videos).
 * Supadata processes videos > 20 minutes asynchronously.
 *
 * @param {string} jobId - The job ID returned by the initial request
 * @returns {Object} - Same format as handleFetchTranscript
 */
async function pollTranscriptJob(jobId, supadataApiKey) {
  const maxAttempts = 60; // Max 60 seconds of polling
  const pollInterval = 1000; // Poll every 1 second

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Wait before polling
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const response = await fetch(
      `https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`,
      {
        headers: { "x-api-key": supadataApiKey },
      },
    );

    if (!response.ok) {
      throw new Error(`Job polling failed: ${response.status}`);
    }

    const data = await response.json();

    if (data.status === "completed") {
      // Parse the completed transcript
      const transcript = [];
      let transcriptTextPlain = "";
      let transcriptTextTimestamped = "";

      if (data.content && Array.isArray(data.content)) {
        for (const chunk of data.content) {
          if (chunk.text) {
            // Clean up caption artifacts (">>" = speaker change marker)
            const cleanText = chunk.text.replace(/>> ?/g, "").trim();
            if (!cleanText) continue;

            const startSeconds = Math.floor((chunk.offset || 0) / 1000);
            const minutes = Math.floor(startSeconds / 60);
            const seconds = startSeconds % 60;
            const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

            transcript.push({
              text: cleanText,
              start: startSeconds,
              duration: Math.floor((chunk.duration || 0) / 1000),
              language: chunk.lang || data.lang || null,
            });
            transcriptTextPlain += cleanText + " ";
            transcriptTextTimestamped += `[${timestamp}] ${chunk.text}\n`;
          }
        }
      }

      return {
        success: true,
        transcript: transcript,
        transcriptText: transcriptTextPlain.trim(),
        transcriptTextTimestamped: transcriptTextTimestamped.trim(),
        language: typeof data.lang === "string" ? data.lang : null,
      };
    }

    if (data.status === "failed") {
      throw new Error("Transcript processing failed");
    }

    // Status is 'queued' or 'active' — keep polling
  }

  throw new Error("Transcript processing timed out");
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Gets video info (title, channel, description) from the active YouTube tab.
 * We do this by asking the content script to read the page.
 */
async function handleGetVideoInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getVideoInfo",
    });
    return response;
  } catch (error) {
    return { title: "", channelName: "", description: "" };
  }
}

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using DeepSeek.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Video title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
// ============================================================
// NOTEBOOK MANAGEMENT
// ============================================================
// The old per-quote note-card system (handleSaveNote/handleGetNotes/
// handleDeleteNote/handleUpdateNote against the ytd_notes key) is gone.
// Quote-capture mechanism returns in a later step; for now each video has a
// single freeform notebook document instead.

const NOTEBOOK_INDEX_KEY = "ytd_notebook_index";

function notebookStorageKey(videoId) {
  return `ytd_notebook_${videoId}`;
}

/**
 * Reads a video's freeform notebook document.
 * @returns {Object} - { success, notebook } where notebook is null if the
 * user has never saved anything for this video, or { success: false, error }
 */
async function handleGetNotebook(videoId) {
  try {
    const key = notebookStorageKey(videoId);
    const result = await chrome.storage.local.get(key);
    return { success: true, notebook: result[key] || null };
  } catch (error) {
    return { success: false, error: error.message, code: error.code };
  }
}

/**
 * Saves a video's freeform notebook document. Spreads the previous record
 * first and overrides only the fields autosave actually changes, so any
 * other field on the record (Drive sync state, or anything added later)
 * survives automatically — this used to name each survivor explicitly
 * (driveFileId, driveFileUrl, lastSyncedAt), which meant every new optional
 * field had to be added to that list by hand or it silently got dropped on
 * the next keystroke. That bug shape came up twice; spreading instead of
 * naming closes it off for good.
 */
async function handleSaveNotebook(videoId, content, videoTitle, channelName) {
  try {
    const key = notebookStorageKey(videoId);
    const existing = await chrome.storage.local.get(key);
    const previous = existing[key] || null;
    const now = Date.now();

    const notebook = {
      ...previous,
      videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : previous?.videoTitle || "",
      channelName:
        typeof channelName === "string"
          ? channelName.slice(0, 300)
          : previous?.channelName || "",
      content: typeof content === "string" ? content : "",
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };

    await chrome.storage.local.set({ [key]: notebook });
    await updateNotebookIndex(notebook);

    return { success: true, notebook };
  } catch (error) {
    return { success: false, error: error.message, code: error.code };
  }
}

/**
 * Replaces this video's entry in the notebook index (adding it if new).
 * Pure so it can be unit tested without touching chrome.storage.
 */
function upsertNotebookIndexEntry(index, entry) {
  const withoutExisting = (Array.isArray(index) ? index : []).filter(
    (item) => item?.videoId !== entry.videoId,
  );
  withoutExisting.push(entry);
  return withoutExisting;
}

/**
 * Keeps ytd_notebook_index in sync so the side panel can list which videos
 * have a notebook without loading every one of them.
 */
async function updateNotebookIndex(notebook) {
  const result = await chrome.storage.local.get(NOTEBOOK_INDEX_KEY);
  const updated = upsertNotebookIndexEntry(result[NOTEBOOK_INDEX_KEY], {
    videoId: notebook.videoId,
    title: notebook.videoTitle || "",
    updatedAt: notebook.updatedAt,
  });
  await chrome.storage.local.set({ [NOTEBOOK_INDEX_KEY]: updated });
}

// ------------------------------------------------------------
// Google Drive export ("Save to Drive")
// ------------------------------------------------------------
// Exports the same markdown the Download button produces, but to a Drive
// file the extension owns (drive.file scope: only files this extension
// creates, never broader Drive access). Uploaded as plain text/markdown —
// never converted into a native Google Doc — so a later files.get?alt=media
// reads back byte-identical content.

const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
// A single global default (not per-video). Applied to a first-time create
// AND moves an already-exported file that's drifted from it — see
// handleExportNotebookToDrive, buildDriveCreateMetadata, and
// buildDriveMoveParams.
const DRIVE_FOLDER_KEY = "ytd_drive_folder";
// Every folder this extension has created via createDriveFolder, offered
// again in the side panel's folder dropdown instead of re-creating one.
const DRIVE_FOLDERS_KEY = "ytd_drive_folders";

/**
 * Maps a failed Drive API response to this codebase's .code convention.
 * Shared by driveUploadFile and handleCreateDriveFolder so the two Drive
 * write paths classify errors identically.
 */
function driveErrorCodeFor(status, reason) {
  if (status === 401) return "DRIVE_AUTH_FAILED";
  if (status === 403 && /rateLimitExceeded|quotaExceeded|storageQuotaExceeded/.test(reason)) {
    return "DRIVE_QUOTA_EXCEEDED";
  }
  return "DRIVE_API_ERROR";
}

/**
 * Wraps chrome.identity.getAuthToken's callback API in a Promise. Rejects
 * (rather than resolving with no token) so callers can branch on failure.
 */
function getDriveAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const lastError = chrome.runtime.lastError;
      if (lastError || !token) {
        reject(new Error(lastError?.message || "No Google Drive auth token"));
        return;
      }
      resolve(token);
    });
  });
}

/**
 * Gets a Drive auth token without prompting the user first — most exports
 * happen with an already-granted, cached token. Only falls back to an
 * interactive consent prompt if that fails, so we don't re-prompt on every
 * export.
 */
async function getDriveAuthTokenPreferringCached() {
  try {
    return await getDriveAuthToken(false);
  } catch (_error) {
    return await getDriveAuthToken(true);
  }
}

/**
 * Fetches a file's current trashed state and parents directly from Drive —
 * the source of truth, since the user may have trashed, deleted, or moved
 * the file by hand outside this extension since the last export. Returns
 * null for a 404 (file gone), the caller treats that the same as a file
 * that's merely trashed: as if there were no existing file at all.
 */
async function driveGetFile(token, fileId) {
  const response = await fetch(
    `${DRIVE_FILES_URL}/${fileId}?fields=id,trashed,parents`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (response.status === 404) return null;

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const reason = data.error?.errors?.[0]?.reason || "";
    const error = new Error(
      data.error?.message || `Google Drive error: ${response.status}`,
    );
    error.code = driveErrorCodeFor(response.status, reason);
    throw error;
  }

  return response.json();
}

/**
 * Creates (fileId omitted) or overwrites (fileId given) a Drive file via
 * multipart upload, so repeated exports update the same file instead of
 * creating duplicates. Requests back only the fields the caller needs.
 * `folderId` only applies to the create path (see buildDriveCreateMetadata).
 * `moveParams` (addParents/removeParents from buildDriveMoveParams) only
 * applies to the update path, moving the file in the same request that
 * pushes the new content.
 */
async function driveUploadFile(token, { fileId, filename, mimeType, content, folderId, moveParams }) {
  const boundary = `ytd_export_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const metadataObj = fileId
    ? { name: filename, mimeType }
    : YTD_NOTEBOOK_EXPORT.buildDriveCreateMetadata({ filename, mimeType, folderId });
  const metadata = JSON.stringify(metadataObj);
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const url = new URL(fileId ? `${DRIVE_UPLOAD_URL}/${fileId}` : DRIVE_UPLOAD_URL);
  url.searchParams.set("uploadType", "multipart");
  url.searchParams.set("fields", "id,webViewLink");
  if (fileId && moveParams) {
    url.searchParams.set("addParents", moveParams.addParents);
    if (moveParams.removeParents) url.searchParams.set("removeParents", moveParams.removeParents);
  }

  const response = await fetch(url.toString(), {
    method: fileId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const reason = data.error?.errors?.[0]?.reason || "";
    const error = new Error(
      data.error?.message || `Google Drive error: ${response.status}`,
    );
    error.code = driveErrorCodeFor(response.status, reason);
    throw error;
  }

  return response.json();
}

/**
 * Exports a video's notebook to Google Drive as a plain-text .md file. This
 * is a separate, user-initiated action from the typing-triggered autosave
 * in handleSaveNotebook — it only ever touches driveFileId/driveFileUrl/
 * driveFolderId/lastSyncedAt, never the notebook's content.
 *
 * Reversal from the original design: changing the default folder now DOES
 * move an already-exported file on its next export, rather than leaving it
 * in place. Real use showed "never move" was the wrong default — a
 * re-export that silently kept writing into the old folder (or a trashed
 * file) read as broken, not as a deliberate choice. This also trusts
 * Drive's actual current parents (fetched fresh below) over whatever was
 * last stored, since the user may have reorganized the file by hand.
 */
async function handleExportNotebookToDrive(videoId) {
  try {
    const key = notebookStorageKey(videoId);
    const existing = await chrome.storage.local.get([key, DRIVE_FOLDER_KEY]);
    const notebook = existing[key];
    if (!notebook) {
      const error = new Error("Write something in the notebook before saving to Drive.");
      error.code = "NOTEBOOK_NOT_FOUND";
      throw error;
    }
    const targetFolderId = existing[DRIVE_FOLDER_KEY]?.id || null;

    const markdown = YTD_NOTEBOOK_EXPORT.buildNotebookExportMarkdown(notebook);
    const filename = YTD_NOTEBOOK_EXPORT.buildExportFilename(notebook);

    let token;
    try {
      token = await getDriveAuthTokenPreferringCached();
    } catch (_authError) {
      const error = new Error(
        "Google Drive authorization failed. Please try again and approve access.",
      );
      error.code = "DRIVE_AUTH_FAILED";
      throw error;
    }

    // Before trusting a stored driveFileId, confirm the file still exists
    // and isn't trashed. A stale/deleted id is treated as if there were no
    // existing file at all, falling through to a fresh create below.
    let existingFile = null;
    if (notebook.driveFileId) {
      try {
        existingFile = await driveGetFile(token, notebook.driveFileId);
      } catch (getError) {
        if (getError.code === "DRIVE_AUTH_FAILED") {
          await new Promise((resolve) =>
            chrome.identity.removeCachedAuthToken({ token }, resolve),
          );
        }
        throw getError;
      }
      if (existingFile?.trashed) existingFile = null;
    }

    const fileId = existingFile ? notebook.driveFileId : null;
    const moveParams = existingFile
      ? YTD_NOTEBOOK_EXPORT.buildDriveMoveParams(existingFile.parents, targetFolderId)
      : null;

    let result;
    try {
      result = await driveUploadFile(token, {
        fileId,
        filename,
        mimeType: "text/markdown",
        content: markdown,
        folderId: fileId ? undefined : targetFolderId,
        moveParams,
      });
    } catch (uploadError) {
      if (uploadError.code === "DRIVE_AUTH_FAILED") {
        // A revoked/stale token surfaces here as a 401 rather than from
        // getAuthToken itself. Drop it so the next export is forced to
        // re-authenticate instead of failing silently forever.
        await new Promise((resolve) =>
          chrome.identity.removeCachedAuthToken({ token }, resolve),
        );
      }
      throw uploadError;
    }

    // The folder this file now lives in: the target folder if this was a
    // create or a move, otherwise whatever it already was (falling back to
    // Drive's actual current parent for a notebook exported before
    // driveFolderId existed).
    let driveFolderId;
    if (!existingFile || moveParams) {
      driveFolderId = targetFolderId;
    } else {
      driveFolderId = notebook.driveFolderId ?? existingFile.parents?.[0] ?? null;
    }

    const lastSyncedAt = Date.now();
    const updatedNotebook = {
      ...notebook,
      driveFileId: result.id,
      driveFileUrl: result.webViewLink || null,
      driveFolderId,
      lastSyncedAt,
    };
    await chrome.storage.local.set({ [key]: updatedNotebook });

    return {
      success: true,
      driveFileId: updatedNotebook.driveFileId,
      driveFileUrl: updatedNotebook.driveFileUrl,
      lastSyncedAt,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      code: error.code || "DRIVE_API_ERROR",
    };
  }
}

/**
 * Reads the global default Drive export folder (not per-video), set via
 * the side panel's folder dropdown.
 */
async function handleGetDriveFolder() {
  try {
    const result = await chrome.storage.local.get(DRIVE_FOLDER_KEY);
    return { success: true, folder: result[DRIVE_FOLDER_KEY] || null };
  } catch (error) {
    return { success: false, error: error.message, code: error.code };
  }
}

/**
 * Persists the given folder as the new global default, or clears it back
 * to "My Drive (root)" when passed a falsy folder. Takes effect on the next
 * export of any notebook — a new file is created there, and an
 * already-exported file gets moved there — see handleExportNotebookToDrive.
 */
async function handleSetDriveFolder(folder) {
  try {
    if (!folder) {
      await chrome.storage.local.remove(DRIVE_FOLDER_KEY);
      return { success: true, folder: null };
    }
    if (typeof folder.id !== "string" || !folder.id) {
      const error = new Error("A Drive folder id is required.");
      error.code = "DRIVE_FOLDER_INVALID";
      throw error;
    }
    const stored = {
      id: folder.id,
      name: typeof folder.name === "string" ? folder.name : "",
    };
    await chrome.storage.local.set({ [DRIVE_FOLDER_KEY]: stored });
    return { success: true, folder: stored };
  } catch (error) {
    return { success: false, error: error.message, code: error.code };
  }
}

/**
 * Creates a new folder in the user's Drive using the same authenticated
 * access already used for file export — no Picker, no extra scope, just
 * files.create with a folder mimeType. Records it in ytd_drive_folders so
 * the side panel can offer it again without re-creating it.
 */
async function handleCreateDriveFolder(name) {
  try {
    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (!trimmedName) {
      const error = new Error("A folder name is required.");
      error.code = "DRIVE_FOLDER_INVALID";
      throw error;
    }

    let token;
    try {
      token = await getDriveAuthTokenPreferringCached();
    } catch (_authError) {
      const error = new Error(
        "Google Drive authorization failed. Please try again and approve access.",
      );
      error.code = "DRIVE_AUTH_FAILED";
      throw error;
    }

    const metadata = YTD_NOTEBOOK_EXPORT.buildDriveFolderCreateMetadata(trimmedName);
    const response = await fetch(`${DRIVE_FILES_URL}?fields=id,name`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metadata),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const reason = data.error?.errors?.[0]?.reason || "";
      const error = new Error(
        data.error?.message || `Google Drive error: ${response.status}`,
      );
      error.code = driveErrorCodeFor(response.status, reason);
      if (error.code === "DRIVE_AUTH_FAILED") {
        await new Promise((resolve) =>
          chrome.identity.removeCachedAuthToken({ token }, resolve),
        );
      }
      throw error;
    }

    const created = await response.json();
    const folder = { id: created.id, name: created.name || trimmedName, createdAt: Date.now() };

    const stored = await chrome.storage.local.get(DRIVE_FOLDERS_KEY);
    const updatedList = YTD_NOTEBOOK_EXPORT.appendDriveFolderEntry(
      stored[DRIVE_FOLDERS_KEY],
      folder,
    );
    await chrome.storage.local.set({ [DRIVE_FOLDERS_KEY]: updatedList });

    return { success: true, folder };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      code: error.code || "DRIVE_API_ERROR",
    };
  }
}

/**
 * Lists every folder this extension has created, for the side panel's
 * folder dropdown.
 */
async function handleListDriveFolders() {
  try {
    const result = await chrome.storage.local.get(DRIVE_FOLDERS_KEY);
    return { success: true, folders: result[DRIVE_FOLDERS_KEY] || [] };
  } catch (error) {
    return { success: false, error: error.message, code: error.code };
  }
}

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "DeepSeek API key not configured.",
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[YouTube Digest] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
    };
  }
}

// ============================================================
// CHAT — answers grounded in this video's transcript and notebook
// ============================================================
// Replaces the old analyzeTranscript chapters/key-quotes feature. Instead of
// one-shot structured extraction, the user has an open-ended conversation;
// there's no schema to validate or rebuild here, just a plain-text reply.

function digestStorageKey(videoId) {
  return `digest_${videoId}`;
}

/**
 * Assembles the exact messages payload sent to requestAiCompletion for one
 * chat turn. Pure — no DOM, no chrome.* calls — so it's testable with plain
 * strings/arrays. Mirrors handleExplainSelection's system-role-plus-content
 * shape: the transcript/notes context rides in a single system message,
 * followed by the full conversation so far (already ending in the user's
 * latest question).
 *
 * @param {string} systemContent - The resolved chat.md "System Context"
 *   section, with {transcript}/{notes} already substituted.
 * @param {Array<{role: string, content: string}>} messages - The full
 *   conversation so far, including the user's latest question.
 */
function buildChatRequest(systemContent, messages) {
  return {
    maxTokens: 1024,
    messages: [
      { role: "system", content: systemContent },
      ...(Array.isArray(messages) ? messages : []),
    ],
  };
}

/**
 * Answers a chat question about a video using its cached transcript and the
 * viewer's own notebook as grounding context.
 *
 * @param {string} videoId - The YouTube video ID.
 * @param {Array<{role: string, content: string}>} messages - The full
 *   conversation so far, including the user's latest question.
 * @returns {Object} - { success, reply } or { success: false, error, code }
 */
async function handleChatWithTranscript(videoId, messages) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      const error = new Error(
        "DeepSeek API key not configured. Open YouTube Digest Settings.",
      );
      error.code = "NO_AI_KEY";
      throw error;
    }

    const digestKey = digestStorageKey(videoId);
    const notebookKey = notebookStorageKey(videoId);
    const stored = await chrome.storage.local.get([digestKey, notebookKey]);
    const transcript = stored[digestKey]?.transcriptTimestamped || "";
    const notes = stored[notebookKey]?.content || "";

    const systemContent = await loadPromptSection("chat.md", "System Context", {
      transcript,
      notes,
    });

    debugLog("[YouTube Digest] Requesting chat reply", settings.aiModel);
    const { text } = await requestAiCompletion(
      buildChatRequest(systemContent, messages),
    );

    return { success: true, reply: text.trim() };
  } catch (error) {
    console.error("Chat error:", error);
    return { success: false, error: error.message, code: error.code };
  }
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) {
    throw new Error("Transcript translation requires 1 to 4 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

/**
 * Translates content using DeepSeek.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - 'transcriptBatch' or 'interfaceBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (!["transcriptBatch", "interfaceBatch"].includes(contentType)) {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "DeepSeek API key not configured" };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const promptSection =
      contentType === "transcriptBatch"
        ? "Transcript batch translation"
        : "Interface content translation";
    const systemPrompt = await loadPromptSection(
      "translation.md",
      promptSection,
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: 1536,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      translationOptions,
    );

    // DeepSeek JSON mode can rarely return an empty content string. The prompt
    // already requires JSON, so retry once without response_format.
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Translation returned no valid Chinese segments",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    console.error("[YouTube Digest] Translation error:", error);
    return { success: false, error: error.message || "Translation failed" };
  }
}

/**
 * Makes a single DeepSeek call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  { temperature = 0.3, maxTokens = 8192, responseFormat } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  callAiTranslation,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleTranslateContent,
  closePanelForTab,
  updatePanelForTab,
};

globalThis.__YTD_NOTEBOOK_TESTING__ = {
  handleGetNotebook,
  handleSaveNotebook,
  upsertNotebookIndexEntry,
  handleExportNotebookToDrive,
  driveUploadFile,
  driveGetFile,
  handleGetDriveFolder,
  handleSetDriveFolder,
  handleCreateDriveFolder,
  handleListDriveFolders,
};

globalThis.__YTD_CHAT_TESTING__ = {
  buildChatRequest,
  handleChatWithTranscript,
};
