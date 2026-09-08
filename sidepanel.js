/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for YouTube Digest: video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
let currentVideoUrl = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptLanguage = null;
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let youtubeTabId = null; // Store the YouTube tab ID for reliable messaging
let errorAction = null;

// --- Chat state (Chat tab, grounded in the transcript + notebook) ---
// Session-only by design: resets on video change or "Clear chat", never
// persisted to storage.
let chatMessages = [];
let chatRequestInFlight = false;
// Bumped by resetChat (video change or "Clear chat"), the same invalidation
// pattern as translationGeneration: a reply that lands after either one is
// simply discarded instead of reappearing in a conversation it no longer belongs to.
let chatGeneration = 0;

// --- Translation state ---
// The universal language control supports original content, Chinese, and an
// aligned bilingual view across Transcript, Overview, and Notes.
let currentTranscriptMode = "original";
const DISPLAY_LANGUAGE_MODE_KEY = "ytd_display_language_modes_by_video";
const DISPLAY_LANGUAGE_MODES = new Set(["original", "zh", "bilingual"]);
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let transcriptScrollObserver = null;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
let interfaceTranslationCache = new Map();
let interfaceTranslationInFlight = new Set();
let interfaceTranslationFailures = new Set();
// Autosave debounce for the per-video notebook (see NOTEBOOK section below).
let notebookSaveTimer = null;
const NOTEBOOK_SAVE_DEBOUNCE_MS = 800;
// Drive sync state for the current video's notebook — null until the first
// successful "Save to Drive". Repopulated from storage in loadNotebook.
let currentNotebookSync = null;
let notebookDriveSyncInFlight = false;
// The global (not per-video) default Drive export folder — one of the
// folders this extension itself created (see createDriveFolder in
// background.js). Loaded once at startup, not per-video.
let currentDriveFolder = null;
let driveFolderList = [];
// Keeps "Synced X ago" advancing while the panel stays open — a frozen
// label reads as broken. See tickNotebookSyncStatusLabel.
let notebookSyncStatusTickTimer = null;
const NOTEBOOK_SYNC_STATUS_TICK_MS = 45_000;
const TRANSLATION_MESSAGE_TIMEOUT_MS = 130_000;
const TRANSLATION_BATCH_SIZE = 3;

// --- Transcript search state ---
// Matches point to visible marks in the active transcript language mode.
// Search navigation only scrolls the panel. It does not seek the video.
let transcriptSearchMatches = [];
let transcriptSearchIndex = -1;

/**
 * Prevent a stopped service worker or dead message channel from leaving the
 * transcript queue stuck forever. The underlying Chrome message cannot be
 * cancelled, so settled guards deliberately ignore any late response.
 */
function sendTranslationMessage(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Translation request timed out after 130 seconds. Please Retry.",
        ),
      );
    }, TRANSLATION_MESSAGE_TIMEOUT_MS);

    let messagePromise;
    try {
      messagePromise = chrome.runtime.sendMessage(message);
    } catch (error) {
      finish(reject, error);
      return;
    }

    Promise.resolve(messagePromise).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let autoScrollInterval = null; // setInterval ID for polling video time
let lastAutoScrollTime = 0; // Timestamp of last programmatic scroll (ignores scroll events within 1s)

// --- Transcript reading position state ---
// Session storage survives a side panel close but clears when Chrome closes.
const TRANSCRIPT_VIEW_STATE_KEY = "ytd_transcript_view_state";
let pendingTranscriptViewState = null;
let transcriptViewStateSaveTimer = null;
let isRestoringTranscriptView = false;
let selectionActionsController = null;
let lastTranscriptScrollTop = 0;

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});

function normalizeCaptionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

/**
 * Splits a single oversized thought at the strongest nearby punctuation.
 * Word boundaries are the final safety valve for captions with no punctuation.
 */
function splitOversizedThought(text, maxChars) {
  const parts = [];
  let rest = normalizeCaptionText(text);

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1);
    const lowerBound = Math.floor(maxChars * 0.55);
    let cut = -1;

    for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length;
      }
      if (cut > 0) break;
    }

    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

/**
 * Reconstructs complete sentences across raw caption boundaries. Each segment
 * keeps the timestamp of the first caption that contributed text. Character
 * and time limits prevent a malformed Supadata entry from becoming one giant
 * row while punctuation remains the preferred boundary.
 */
function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const pieces = [];
  entries.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text);
    if (!text) return;
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
    const duration = Math.max(0, Number(entry.duration) || 0);
    const sentenceParts =
      text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
      [text];
    let consumedChars = 0;

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars);
      oversizedParts.forEach((part, partIndex) => {
        const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
        pieces.push({
          text: part,
          start: start + duration * ratio,
          semanticEnd:
            /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
            oversizedParts.length > 1,
          clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          sourceOrder: `${entryIndex}:${partIndex}`,
        });
        consumedChars += part.length + 1;
      });
    });
  });

  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      text,
      texts: [text],
    });
    current = null;
  };

  pieces.forEach((piece) => {
    if (!current) current = { start: piece.start, text: "" };
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    const elapsed = Math.max(0, piece.start - current.start);
    const comfortablySized = current.text.length >= limits.minChars;
    const reachedIdeal = current.text.length >= limits.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd &&
        (reachedIdeal ||
          current.text.length >= limits.maxChars ||
          elapsed >= limits.maxSeconds));
    const reachedGuardrail =
      atNaturalBoundary &&
      (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds);
    const reachedHardGuardrail =
      current.text.length >= Math.round(limits.maxChars * 1.2) ||
      elapsed >= limits.maxSeconds + 5;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  setTranscriptModeButtons("original");
  setupEventListeners();
  await evictOldCacheEntries(20);
  // Global (not per-video) setting — load once at startup, not per-video.
  void loadDriveFolderSetting();
  notebookSyncStatusTickTimer = setInterval(
    tickNotebookSyncStatusLabel,
    NOTEBOOK_SYNC_STATUS_TICK_MS,
  );

  const configStatus = await chrome.runtime.sendMessage({
    action: "checkConfig",
  });

  if (!configStatus.hasSupadataKey || !configStatus.hasAiKey) {
    showConfigError(configStatus);
    return;
  }

  await checkCurrentTab();
});

// Listen for messages from the Digest button on YouTube page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startDigestFromButton") {
    // Load the digest for the current video. Served from cache when we've
    // seen this video before (no API calls); fetched fresh otherwise.
    // (This used to force-clear the cache on every click, which silently
    // burned a transcript credit + analysis tokens per click.)
    checkCurrentTab();
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed
    updateLoading(message.title, message.subtitle);
    sendResponse({ success: true });
  }
  // The old "noteSaved" broadcast patched note-cards across surfaces. That
  // system is gone — quote-capture mechanism returns in a later step.
  return false;
});

// ============================================================
// FOLLOW THE ACTIVE TAB
// ============================================================
// The panel watches which tab is in front of it and reacts:
//   - Front tab is NOT YouTube  -> the panel closes itself (window.close()).
//     We do this OURSELVES rather than relying only on the background
//     script's per-tab enable/disable, because Chrome doesn't reliably
//     apply per-tab panel state to tabs spawned in unusual ways (e.g. a
//     link opened from another app) — which let the panel linger on
//     non-YouTube pages.
//   - Front tab IS YouTube but on a different video -> refresh the digest.
//     YouTube is a single-page app (clicking a video swaps content without
//     a reload), so we track URL changes; startDigest() caches per video,
//     making re-checks instant and free for already-digested videos.
//
// Everything is scoped to the window this panel lives in: tab switches in
// OTHER browser windows must not close this panel or hijack its content.

let navigationRefreshTimer = null;
let panelWindowId = null;
chrome.windows.getCurrent().then((w) => {
  panelWindowId = w.id;
});

function scheduleDigestRefresh() {
  // Small delay lets YouTube finish rendering the new video's title and
  // description before we read them. Also collapses rapid-fire URL events
  // into a single refresh.
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => {
    checkCurrentTab();
  }, 600);
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

/**
 * Reacts to the URL now in front of the panel: close on non-YouTube,
 * refresh the digest when the video changed.
 */
function handleFrontTabUrl(url) {
  if (!(url || "").startsWith("https://www.youtube.com")) {
    // Start the position save, then close in this same event callback. Chrome
    // does not reliably honor window.close() after an asynchronous wait.
    void saveCurrentTranscriptViewState();
    window.close();
    return;
  }

  const newVideoId = extractVideoId(url);
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (newVideoId !== currentVideoId || !panelIsShowingResults()) {
    scheduleDigestRefresh();
  }
}

/**
 * Gets the best URL from a tab update that can change the visible page.
 * The status events repeat the close request after Chrome commits the first
 * non-YouTube navigation, when an early URL event alone can be lost.
 */
function getNavigationUrl(changeInfo, tab) {
  if (changeInfo.url) return changeInfo.url;
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete") {
    return "";
  }
  return tab.pendingUrl || tab.url || "";
}

// Fires when a tab starts or completes navigation, including YouTube's
// no-reload navigation. The completion event is a deliberate second close
// attempt for the first non-YouTube page.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  const url = getNavigationUrl(changeInfo, tab);
  if (!url) return;
  handleFrontTabUrl(url);
});

// Fires when a different tab comes to the front — switching tabs, or a new
// tab being opened (including ones opened by clicking links in other apps).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Brand-new tabs may not have committed their URL yet — fall back to
    // the pending one so we judge where the tab is actually going.
    handleFrontTabUrl(tab.url || tab.pendingUrl || "");
  } catch (e) {
    // Tab closed before we could read it — nothing to do.
  }
});

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) {
      errorAction();
      return;
    }
    if (currentVideoId) {
      startDigest(currentVideoId, currentVideoUrl);
    }
  });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  // Transcript actions
  document
    .getElementById("copyTranscriptBtn")
    ?.addEventListener("click", copyTranscript);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", exportTranscript);
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleDisplayLanguageModeChange(button.dataset.transcriptMode);
    });
  });
  setupTranscriptSearch();

  // pagehide also covers closing the side panel without a tab change.
  window.addEventListener("pagehide", () => {
    void saveCurrentTranscriptViewState();
    void flushNotebookSave();
  });

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => {
      autoScrollEnabled = true;
      document.getElementById("followPlaybackBtn").style.display = "none";
      // Jump straight back to the line currently being spoken. We scroll
      // directly (not via playbackTrackingTick) because the tick skips
      // entries that are already highlighted — and the current line almost
      // always IS highlighted, which made this button appear to do nothing.
      if (!scrollToActiveEntry()) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
    });

  // Notebook export — Download builds a local .md file; Save to Drive
  // uploads/updates a file in the user's Google Drive.
  document
    .getElementById("notebookDownloadBtn")
    ?.addEventListener("click", downloadNotebookExport);
  document
    .getElementById("notebookSaveToDriveBtn")
    ?.addEventListener("click", () => void saveNotebookToDrive());
  document
    .getElementById("notebookDriveFolderSelect")
    ?.addEventListener("change", (event) => void handleDriveFolderSelectChange(event));

  // Notebook autosave — debounced so we don't write on every keystroke.
  const notebookTextarea = document.getElementById("notebookTextarea");
  notebookTextarea?.addEventListener("input", scheduleNotebookSave);
  // Markdown formatting shortcuts, scoped to this textarea only.
  notebookTextarea?.addEventListener("keydown", handleNotebookShortcutKeydown);
  // Ctrl/Cmd+Click a quote's timestamp to seek the video.
  notebookTextarea?.addEventListener("click", handleNotebookQuoteClick);
  // Keep the highlight backdrop's scroll position in lockstep with the
  // (invisible) real text scrolling underneath it.
  notebookTextarea?.addEventListener("scroll", () => {
    const backdrop = document.getElementById("notebookHighlightBackdrop");
    if (!backdrop) return;
    backdrop.scrollTop = notebookTextarea.scrollTop;
    backdrop.scrollLeft = notebookTextarea.scrollLeft;
  });

  // Chat tab — Enter sends, Shift+Enter inserts a newline.
  document
    .getElementById("chatInput")
    ?.addEventListener("keydown", handleChatInputKeydown);
  document
    .getElementById("chatSendBtn")
    ?.addEventListener("click", () => void sendChatMessage());
  document
    .getElementById("chatClearBtn")
    ?.addEventListener("click", () => resetChat());
}

// ============================================================
// VIDEO DETECTION
// ============================================================

async function checkCurrentTab() {
  try {
    // The panel belongs only to the active tab. Looking for another open
    // YouTube tab here can keep an old transcript visible on a non-YouTube
    // page, so never fall back to background tabs.
    const tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    const tab = tabs[0] || null;

    debugLog("[YouTube Digest Panel] Found tab:", tab?.id, tab?.url);

    if (!tab?.url) {
      showState("welcome");
      return;
    }

    if (!tab.url.startsWith("https://www.youtube.com")) {
      handleFrontTabUrl(tab.url);
      return;
    }

    // Store the tab ID for reliable messaging later
    youtubeTabId = tab.id;

    const videoId = extractVideoId(tab.url);

    if (videoId) {
      currentVideoUrl = tab.url;

      try {
        // Route through background script for reliable message passing
        const result = await chrome.runtime.sendMessage({
          action: "relayToContent",
          payload: { action: "getVideoInfo" },
        });
        debugLog("[YouTube Digest Panel] getVideoInfo result:", result);
        if (result.success && result.response) {
          currentVideoTitle = result.response.title || "";
          currentChannelName = result.response.channelName || "";
          currentVideoDescription = result.response.description || "";
          currentVideoDuration = result.response.duration || 0;
        }
      } catch (e) {
        console.error("[YouTube Digest Panel] getVideoInfo error:", e);
        currentVideoTitle = "";
        currentChannelName = "";
        currentVideoDescription = "";
        currentVideoDuration = 0;
      }

      startDigest(videoId, tab.url);
    } else {
      showState("welcome");
    }
  } catch (error) {
    console.error("Tab check error:", error);
    showState("welcome");
  }
}

function extractVideoId(url) {
  try {
    const urlObj = new URL(url);

    if (
      urlObj.hostname.includes("youtube.com") &&
      urlObj.searchParams.has("v")
    ) {
      return urlObj.searchParams.get("v");
    }

    if (urlObj.hostname === "youtu.be") {
      return urlObj.pathname.slice(1);
    }

    if (urlObj.pathname.startsWith("/embed/")) {
      return urlObj.pathname.split("/")[2];
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

async function startDigest(videoId, videoUrl) {
  // Check if we already have this video loaded in memory
  if (videoId === currentVideoId && currentTranscript) {
    showState("results");
    return;
  }

  const videoChanged = videoId !== currentVideoId;

  // Every video change invalidates observer work and in-flight translations.
  if (videoChanged) {
    translationGeneration += 1;
    if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
    transcriptScrollObserver = null;
    resetTranscriptSearch();
    lastTranscriptScrollTop = 0;
    pendingTranscriptViewState = await loadTranscriptViewState(videoId);
    // An unseen video always starts in Original, so opening it never spends
    // translation tokens. A saved choice is restored only for this video.
    currentTranscriptMode = await loadDisplayLanguageMode(videoId);
    document
      .getElementById("contentArea")
      ?.classList.toggle(
        "restoring-transcript-view",
        Boolean(pendingTranscriptViewState),
      );
  }

  // Check cache for this video
  const cached = await loadFromCache(videoId);
  if (cached) {
    debugLog("Loading from cache:", videoId);
    currentVideoId = videoId;
    currentVideoUrl = videoUrl;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptLanguage = cached.transcriptLanguage || null;

    // Restore semantic-segment translations from persistent storage.
    if (cached.paragraphCache) {
      for (const [key, value] of Object.entries(cached.paragraphCache)) {
        transcriptParagraphCache.set(key, value);
      }
    }
    if (cached.interfaceCache) {
      for (const [key, value] of Object.entries(cached.interfaceCache)) {
        interfaceTranslationCache.set(key, value);
      }
    }

    if (currentVideoTitle || currentChannelName) {
      const videoInfo = document.getElementById("videoInfo");
      document.getElementById("videoTitle").textContent = currentVideoTitle;
      document.getElementById("videoChannel").textContent = currentChannelName;
      videoInfo.style.display = "block";
    }

    // Always render transcript first
    renderTranscript();

    showState("results");
    document.getElementById("tabsNav").style.display = "flex";
    restorePendingTranscriptViewState(videoId);

    // Load this video's notebook, and reset the chat to this video's context.
    void loadNotebook(videoId);
    resetChat();

    // Setup explain feature
    setupExplainFeature();
    if (currentTranscriptMode !== "original") translateTranscript();
    return;
  }

  currentVideoId = videoId;
  currentVideoUrl = videoUrl;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;

  if (currentVideoTitle || currentChannelName) {
    const videoInfo = document.getElementById("videoInfo");
    document.getElementById("videoTitle").textContent = currentVideoTitle;
    document.getElementById("videoChannel").textContent = currentChannelName;
    videoInfo.style.display = "block";
  }

  showState("loading");
  updateLoading("Fetching transcript", "");

  const transcriptResult = await chrome.runtime.sendMessage({
    action: "fetchTranscript",
    videoId: videoId,
  });

  if (!transcriptResult.success) {
    if (transcriptResult.error === "NO_SUPADATA_KEY") {
      showError(
        "API key missing",
        "Add your Supadata API key in YouTube Digest Settings.",
      );
      return;
    }
    showError(
      "No transcript found",
      transcriptResult.message || transcriptResult.error,
    );
    return;
  }

  currentTranscript = transcriptResult.transcript;
  currentTranscriptText = transcriptResult.transcriptText;
  currentTranscriptTimestamped = transcriptResult.transcriptTextTimestamped;
  currentTranscriptLanguage = transcriptResult.language || null;

  // Render transcript immediately (no LLM needed)
  renderTranscript();
  showState("results");
  document.getElementById("tabsNav").style.display = "flex";
  restorePendingTranscriptViewState(videoId);

  // Load this video's notebook, and reset the chat to this video's context.
  void loadNotebook(videoId);
  resetChat();

  // Setup explain feature for text selection
  setupExplainFeature();
  if (currentTranscriptMode !== "original") translateTranscript();

  // Save transcript to cache
  await saveToCache(videoId);
}

// ============================================================
// RENDERING
// ============================================================

function interfaceTranslationCacheKey(surface, id, text) {
  return `${currentVideoId || "none"}:zh:${surface}:${id}:${text}`;
}

function getInterfaceTranslation(surface, id, text) {
  return interfaceTranslationCache.get(
    interfaceTranslationCacheKey(surface, id, text),
  );
}

function renderLocalizedContent(text, surface, id) {
  const original = String(text || "");
  if (!original) return "";
  const cacheKey = interfaceTranslationCacheKey(surface, id, original);
  const translated = getInterfaceTranslation(surface, id, original);
  if (currentTranscriptMode === "original") return escapeHtml(original);

  const translation = translated
    ? escapeHtml(translated)
    : interfaceTranslationFailures.has(cacheKey)
      ? '<span class="translation-error">Translation unavailable.</span>'
      : '<span class="translation-pending">Translating...</span>';
  if (currentTranscriptMode === "bilingual") {
    return `<span class="localized-copy"><span class="localized-original">${escapeHtml(original)}</span><span class="localized-translation">${translation}</span></span>`;
  }
  return `<span class="localized-copy"><span class="localized-translation">${translation}</span></span>`;
}

function getLocalizedPlainText(text, surface, id) {
  const original = String(text || "");
  const translated = getInterfaceTranslation(surface, id, original);
  if (currentTranscriptMode === "zh") return translated || original;
  if (currentTranscriptMode === "bilingual" && translated) {
    return `${original}\n\n${translated}`;
  }
  return original;
}

async function translateInterfaceSegments(surface, segments, rerender) {
  if (currentTranscriptMode === "original" || !segments.length) return;
  const generation = translationGeneration;
  const videoId = currentVideoId;
  const missing = segments
    .filter((segment) => segment.text)
    .map((segment) => ({
      ...segment,
      cacheKey: interfaceTranslationCacheKey(
        surface,
        segment.id,
        segment.text,
      ),
    }))
    .filter(
      (segment) =>
        !interfaceTranslationCache.has(segment.cacheKey) &&
        !interfaceTranslationFailures.has(segment.cacheKey) &&
        !interfaceTranslationInFlight.has(segment.cacheKey),
    );
  if (!missing.length) return;

  missing.forEach((segment) => interfaceTranslationInFlight.add(segment.cacheKey));
  setTranslatingSpinner(true);
  try {
    for (
      let start = 0;
      start < missing.length;
      start += TRANSLATION_BATCH_SIZE
    ) {
      const batch = missing.slice(start, start + TRANSLATION_BATCH_SIZE);
      let result;
      try {
        result = await sendTranslationMessage({
          action: "translateContent",
          content: {
            segments: batch.map(({ id, text }) => ({ id, text })),
          },
          contentType: "interfaceBatch",
          targetLanguage: "zh",
          videoTitle: currentVideoTitle,
        });
      } catch (error) {
        console.error("[YouTube Digest] Interface batch error:", error);
        result = { success: false, error: error.message };
      }
      if (
        generation !== translationGeneration ||
        videoId !== currentVideoId ||
        currentTranscriptMode === "original"
      ) {
        return;
      }
      const aligned = alignTranslatedSegmentBatch(
        batch,
        result?.success ? result.translatedContent?.segments : [],
      );
      aligned.forEach((item, index) => {
        if (item.text) {
          interfaceTranslationCache.set(batch[index].cacheKey, item.text);
        } else {
          interfaceTranslationFailures.add(batch[index].cacheKey);
        }
      });
      // Match the Transcript UX: reveal and persist every small batch as soon
      // as it returns instead of waiting for the full Overview or Notes list.
      rerender();
      await updateCache();
    }
  } catch (error) {
    console.error("[YouTube Digest] Interface translation error:", error);
    missing.forEach((segment) =>
      interfaceTranslationFailures.add(segment.cacheKey),
    );
  } finally {
    missing.forEach((segment) => interfaceTranslationInFlight.delete(segment.cacheKey));
    setTranslatingSpinner(false);
  }
}

// ============================================================
// CHAT — a conversation grounded in this video's transcript and notebook
// ============================================================
// Replaces the old chapters/key-quotes analysis. This is plain conversational
// text, not structured extraction: no responseFormat, no timestamp/schema
// validation to rebuild. History is session-only (see chatMessages state) —
// it resets on video change or "Clear chat", and is never persisted.

/**
 * True once there's a transcript to ground answers in and no request is
 * currently in flight. Both the input and Send button follow this.
 */
function chatInputEnabled() {
  return Boolean(currentTranscriptTimestamped) && !chatRequestInFlight;
}

function chatWaitingPlaceholder() {
  return currentTranscriptTimestamped
    ? "Ask about this video..."
    : "Waiting for the transcript to load...";
}

function updateChatInputState() {
  const input = document.getElementById("chatInput");
  const sendBtn = document.getElementById("chatSendBtn");
  const enabled = chatInputEnabled();
  if (input) {
    input.disabled = !enabled;
    input.placeholder = chatWaitingPlaceholder();
  }
  if (sendBtn) sendBtn.disabled = !enabled;
}

/**
 * Builds one chat bubble. The user's own typed text is never rendered as
 * markup (.textContent only). The AI's reply goes through the same
 * escape-then-allowlist convention as transcript/translation text
 * (renderSubtitleInlineMarkup escapes everything, then restores only
 * i/em/b/strong/u/br) rather than raw innerHTML.
 */
function buildChatMessageElement(message) {
  const bubble = document.createElement("div");
  bubble.className = `chat-message chat-message-${message.role}`;
  if (message.role === "user") {
    bubble.textContent = message.content;
  } else if (message.error) {
    bubble.classList.add("explain-error");
    bubble.textContent = message.content;
  } else {
    bubble.innerHTML = renderSubtitleInlineMarkup(message.content).replace(
      /\n/g,
      "<br>",
    );
  }
  return bubble;
}

function renderChatMessages() {
  const container = document.getElementById("chatMessages");
  if (!container) return;
  container.innerHTML = "";

  if (!chatMessages.length && !chatRequestInFlight) {
    const empty = document.createElement("p");
    empty.className = "chat-empty-state";
    empty.textContent = currentTranscriptTimestamped
      ? "Ask a question about this video."
      : "Waiting for the transcript to load...";
    container.appendChild(empty);
    return;
  }

  chatMessages.forEach((message) => {
    container.appendChild(buildChatMessageElement(message));
  });

  if (chatRequestInFlight) {
    const typing = document.createElement("div");
    typing.className = "chat-message chat-message-assistant chat-typing";
    typing.innerHTML = `<div class="loading-bar"></div>`;
    container.appendChild(typing);
  }

  container.scrollTop = container.scrollHeight;
}

/**
 * Resets the conversation to this video's context. Called on video change
 * (an MVP scope choice: chat history is never persisted) and by "Clear chat".
 */
function resetChat() {
  chatGeneration += 1;
  chatMessages = [];
  chatRequestInFlight = false;
  renderChatMessages();
  updateChatInputState();
}

/**
 * Turns a chatWithTranscript failure into the message shown in the chat.
 * Branches on .code the way other error-code responses in this codebase do
 * (e.g. handleFetchTranscript's NO_SUPADATA_KEY) — requestAiCompletion's
 * thrown errors already carry a human-readable .message for every code
 * (NO_AI_KEY, AI_IDLE_TIMEOUT, AI_HARD_TIMEOUT, EMPTY_AI_RESPONSE,
 * AI_RESPONSE_TOO_LARGE), so this mostly just forwards it.
 */
function chatErrorMessage(result) {
  if (result?.code === "NO_AI_KEY") {
    return (
      result.error || "DeepSeek API key not configured. Open YouTube Digest Settings."
    );
  }
  return result?.error || "Something went wrong. Please try again.";
}

async function sendChatMessage() {
  const input = document.getElementById("chatInput");
  if (!input || !chatInputEnabled()) return;

  const question = input.value.trim();
  if (!question) return;

  chatMessages.push({ role: "user", content: question });
  input.value = "";
  chatRequestInFlight = true;
  updateChatInputState();
  renderChatMessages();

  const videoId = currentVideoId;
  const generation = chatGeneration;
  try {
    const result = await chrome.runtime.sendMessage({
      action: "chatWithTranscript",
      videoId,
      messages: chatMessages,
    });

    // The video may have changed, or the user pressed "Clear chat", while
    // this was in flight — either way, this reply no longer belongs here.
    if (generation !== chatGeneration) return;

    if (result?.success) {
      chatMessages.push({ role: "assistant", content: result.reply });
    } else {
      chatMessages.push({
        role: "assistant",
        content: chatErrorMessage(result),
        error: true,
      });
    }
  } catch (error) {
    if (generation === chatGeneration) {
      chatMessages.push({
        role: "assistant",
        content: `Error: ${error.message}`,
        error: true,
      });
    }
  }

  if (generation === chatGeneration) {
    chatRequestInFlight = false;
    updateChatInputState();
    renderChatMessages();
  }
}

function handleChatInputKeydown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendChatMessage();
  }
}

/**
 * Returns true while the user has a range of text selected.
 * Transcript row clicks must not seek in that state: the click emitted after
 * selection mouseup belongs to the selection/explain interaction, not playback.
 */
function hasNonCollapsedTextSelection() {
  const selection = window.getSelection();
  return Boolean(
    selection && selection.rangeCount > 0 && !selection.isCollapsed,
  );
}

/**
 * Preserves normal row-click seeking while keeping text selection inert.
 */
function seekFromTranscriptEntryClick(event, seconds) {
  if (hasNonCollapsedTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  seekTo(seconds);
}

/**
 * Formats a seconds offset as "M:SS". Shared by every transcript-row
 * renderer and the notebook's quote-insert hotkey so there's one MM:SS rule.
 */
function formatTimestampLabel(seconds) {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);

  grouped.forEach((group) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;

    const timestamp = formatTimestampLabel(group.start);

    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      <span class="transcript-text">${renderSubtitleInlineMarkup(group.text)}</span>
    `;

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, group.start),
    );
    transcriptList.appendChild(div);
  });

  // Reapply an active query after a language mode rerenders the transcript.
  refreshTranscriptSearch({ preserveIndex: false, scroll: false });

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

// ============================================================
// TRANSCRIPT SEARCH
// ============================================================

/**
 * Finds separate, case-insensitive literal matches. A literal search is
 * important here because punctuation such as "." must be treated as transcript
 * text, not as a regular expression command.
 */
function findLiteralTranscriptMatches(text, query) {
  const source = String(text || "");
  const needle = String(query || "").trim();
  if (!needle) return [];

  const escapedNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(escapedNeedle, "giu");
  const matches = [];
  for (const match of source.matchAll(matcher)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }

  return matches;
}

/**
 * Removes old marks before a new search. Restoring plain text first prevents
 * nested marks when the user types one more letter into the search field.
 */
function clearTranscriptSearchHighlights() {
  document
    .querySelectorAll("#transcriptList mark.transcript-search-highlight")
    .forEach((mark) => {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
      parent?.normalize();
    });

  document
    .querySelectorAll("#transcriptList .transcript-entry.search-current")
    .forEach((row) => row.classList.remove("search-current"));
}

/**
 * Replaces matching parts of one text node with mark elements. We collect all
 * text nodes before changing the DOM, so each replacement is safe and stable.
 */
function markTranscriptTextNode(textNode, query) {
  const ranges = findLiteralTranscriptMatches(textNode.nodeValue, query);
  if (!ranges.length) return [];

  const fragment = document.createDocumentFragment();
  const marks = [];
  let cursor = 0;

  ranges.forEach(({ start, end }) => {
    if (start > cursor) {
      fragment.appendChild(
        document.createTextNode(textNode.nodeValue.slice(cursor, start)),
      );
    }

    const mark = document.createElement("mark");
    mark.className = "transcript-search-highlight";
    mark.textContent = textNode.nodeValue.slice(start, end);
    fragment.appendChild(mark);
    marks.push(mark);
    cursor = end;
  });

  if (cursor < textNode.nodeValue.length) {
    fragment.appendChild(
      document.createTextNode(textNode.nodeValue.slice(cursor)),
    );
  }

  textNode.parentNode.replaceChild(fragment, textNode);
  return marks;
}

/**
 * Updates the result count and navigation buttons from the current search
 * state. The live output gives the same information to screen reader users.
 */
function updateTranscriptSearchControls(query) {
  const count = document.getElementById("transcriptSearchCount");
  const previous = document.getElementById("transcriptSearchPrevBtn");
  const next = document.getElementById("transcriptSearchNextBtn");
  const hasMatches = transcriptSearchMatches.length > 0;

  if (count) {
    count.textContent = !query
      ? ""
      : hasMatches
        ? `${transcriptSearchIndex + 1} of ${transcriptSearchMatches.length}`
        : "No matches";
  }
  if (previous) previous.disabled = !hasMatches;
  if (next) next.disabled = !hasMatches;
}

/**
 * Shows which match is current. Search navigation pauses automatic transcript
 * following, so playback cannot pull the user away from the result they found.
 */
function revealCurrentTranscriptSearchMatch({ scroll = true } = {}) {
  transcriptSearchMatches.forEach((mark) => mark.classList.remove("current"));
  document
    .querySelectorAll("#transcriptList .transcript-entry.search-current")
    .forEach((row) => row.classList.remove("search-current"));

  const mark = transcriptSearchMatches[transcriptSearchIndex];
  if (!mark) return;

  mark.classList.add("current");
  mark.closest(".transcript-entry")?.classList.add("search-current");

  if (!scroll) return;
  if (autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * Searches the transcript that is visible now. This means Original searches
 * source subtitles, Chinese searches translated text, and Bilingual searches
 * both columns. Translated rows call this again as their text arrives.
 */
function refreshTranscriptSearch({ preserveIndex = false, scroll = true } = {}) {
  const input = document.getElementById("transcriptSearchInput");
  const clearButton = document.getElementById("transcriptSearchClearBtn");
  const query = String(input?.value || "").trim();
  const previousIndex = transcriptSearchIndex;

  clearTranscriptSearchHighlights();
  transcriptSearchMatches = [];
  transcriptSearchIndex = -1;
  if (clearButton) clearButton.hidden = !input?.value;

  if (!query) {
    updateTranscriptSearchControls(query);
    return;
  }

  document
    .querySelectorAll("#transcriptList .transcript-entry")
    .forEach((row) => {
      const content = row.querySelector(".transcript-text, .transcript-copy");
      if (!content) return;

      const textNodes = [];
      const walker = document.createTreeWalker(
        content,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!node.nodeValue || parent?.closest("button")) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        },
      );
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      textNodes.forEach((node) => {
        transcriptSearchMatches.push(...markTranscriptTextNode(node, query));
      });
    });

  if (transcriptSearchMatches.length) {
    transcriptSearchIndex = preserveIndex
      ? Math.min(Math.max(previousIndex, 0), transcriptSearchMatches.length - 1)
      : 0;
    revealCurrentTranscriptSearchMatch({ scroll });
  }
  updateTranscriptSearchControls(query);
}

/**
 * Moves through results in a loop, like the browser's built-in Find control.
 */
function moveTranscriptSearch(direction) {
  if (!transcriptSearchMatches.length) return;
  transcriptSearchIndex =
    (transcriptSearchIndex + direction + transcriptSearchMatches.length) %
    transcriptSearchMatches.length;
  revealCurrentTranscriptSearchMatch();
  updateTranscriptSearchControls(
    document.getElementById("transcriptSearchInput")?.value.trim(),
  );
}

/**
 * Clears search when the user opens a different video. A query for the old
 * video is unlikely to help and can make the next transcript look empty.
 */
function resetTranscriptSearch({ focus = false } = {}) {
  const input = document.getElementById("transcriptSearchInput");
  if (input) input.value = "";
  refreshTranscriptSearch({ scroll: false });
  if (focus) input?.focus();
}

/**
 * Wires mouse and keyboard controls once when the side panel starts.
 */
function setupTranscriptSearch() {
  const input = document.getElementById("transcriptSearchInput");
  const clearButton = document.getElementById("transcriptSearchClearBtn");
  const previous = document.getElementById("transcriptSearchPrevBtn");
  const next = document.getElementById("transcriptSearchNextBtn");
  if (!input) return;

  input.addEventListener("input", () => refreshTranscriptSearch());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      moveTranscriptSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape" && input.value) {
      event.preventDefault();
      resetTranscriptSearch({ focus: true });
    }
  });

  clearButton?.addEventListener("click", () => {
    resetTranscriptSearch({ focus: true });
  });
  previous?.addEventListener("click", () => moveTranscriptSearch(-1));
  next?.addEventListener("click", () => moveTranscriptSearch(1));
}

function getDisplayedTranscriptText() {
  if (currentTranscriptMode === "original") return currentTranscriptText || "";
  return getActiveTranscriptSegments()
    .map((segment) => {
      const translated = transcriptParagraphCache.get(
        transcriptTranslationCacheKey(segment),
      );
      if (currentTranscriptMode === "zh") return translated || segment.text;
      return translated ? `${segment.text}\n${translated}` : segment.text;
    })
    .join("\n\n");
}

function copyTranscript() {
  copyToClipboardWithFeedback(getDisplayedTranscriptText(), "copyTranscriptBtn");
}

function exportTranscript() {
  const transcriptContent = getDisplayedTranscriptText();
  const videoUrl = `https://youtube.com/watch?v=${currentVideoId}`;

  let exportText = "";
  exportText += `TRANSCRIPT\n`;
  exportText += `${"=".repeat(60)}\n\n`;
  exportText += `Title: ${currentVideoTitle || "Unknown"}\n`;
  exportText += `Channel: ${currentChannelName || "Unknown"}\n`;
  exportText += `URL: ${videoUrl}\n`;
  exportText += `\n${"—".repeat(60)}\n\n`;

  if (currentVideoDescription) {
    exportText += `DESCRIPTION:\n${currentVideoDescription}\n`;
    exportText += `\n${"—".repeat(60)}\n\n`;
  }

  exportText += `TRANSCRIPT:\n\n${transcriptContent}\n`;
  exportText += `\n${"—".repeat(60)}\n`;
  exportText += `Exported by YouTube Digest\n`;

  const filename = `${sanitizeFilename(currentVideoTitle)}-transcript.txt`;
  downloadTextFile(exportText, filename);
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  const uploadEl = document.getElementById("uploadState");
  if (uploadEl) uploadEl.style.display = "none"; // Upload state removed — always hidden
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar only belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";
  document.getElementById("transcriptModeControl").style.display =
    state === "results" ? "inline-flex" : "none";

  if (state !== "results") {
    stopPlaybackTracking();
  }
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

function showError(title, message) {
  errorAction = null;
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent = "Try Again";
}

function showConfigError(configStatus) {
  const missingKeys = [];
  if (!configStatus.hasSupadataKey) missingKeys.push("Supadata");
  if (!configStatus.hasAiKey) missingKeys.push("AI provider");

  showState("error");
  document.getElementById("errorTitle").textContent = "API Keys Missing";
  document.getElementById("errorMessage").textContent =
    `Add your ${missingKeys.join(" and ")} API key${missingKeys.length === 1 ? "" : "s"} in YouTube Digest Settings.`;
  document.getElementById("errorBtn").textContent = "Open Settings";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

// ============================================================
// TAB SWITCHING
// ============================================================

function switchTab(tabName) {
  // Capture the transcript position before another tab reuses the same scroll
  // area. Scrolling Overview or Notes must not replace this value.
  if (tabName !== "transcript" && transcriptTabIsActive()) {
    captureCurrentTranscriptScrollTop();
    dismissSelectionActions(true);
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });

  // Start/stop playback tracking based on which tab is active
  if (tabName === "transcript") {
    // Notes always opens at the top, so restore the independent transcript
    // reading position when the user returns here.
    requestAnimationFrame(() => {
      const contentArea = document.getElementById("contentArea");
      if (!contentArea || !transcriptTabIsActive()) return;
      lastAutoScrollTime = Date.now();
      contentArea.scrollTop = lastTranscriptScrollTop;
    });
    startPlaybackTracking();
  } else {
    stopPlaybackTracking();
  }

  // Open Notes scrolled to the top of the panel every time.
  if (tabName === "notes") {
    requestAnimationFrame(() => {
      const contentArea = document.getElementById("contentArea");
      const notesPanelIsActive = document.querySelector(
        '.tab-panel[data-panel="notes"].active',
      );
      if (contentArea && notesPanelIsActive) contentArea.scrollTop = 0;
    });
  }

  // Translate only the visible tab. This prevents hidden surfaces from using
  // tokens or competing with the batch queue the user is waiting for. The
  // Chat tab has no translatable pre-rendered content (it's a live
  // conversation), so it needs no branch here.
  if (
    tabName === "transcript" &&
    currentTranscriptMode !== "original" &&
    !transcriptScrollObserver
  ) {
    void translateTranscript();
  }
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

/**
 * Seeks the YouTube player. Returns true/false so callers that care whether
 * it actually worked (e.g. the notebook's quote click-to-seek) can react;
 * existing fire-and-forget callers just ignore the return value.
 */
async function seekTo(seconds) {
  debugLog("[YouTube Digest Panel] seekTo called with:", seconds);
  if (seconds === undefined || seconds === null) {
    debugLog("[YouTube Digest Panel] seekTo aborted - no seconds value");
    return false;
  }

  const payload = {
    action: "seekTo",
    seconds: Number(seconds),
  };

  try {
    // Try direct messaging to the stored YouTube tab first (fastest/reliable)
    if (youtubeTabId) {
      try {
        await chrome.tabs.sendMessage(youtubeTabId, payload);
        debugLog("[YouTube Digest Panel] seekTo direct success");
        return true;
      } catch (directErr) {
        debugLog(
          "[YouTube Digest Panel] Direct seekTo failed, falling back to relay:",
          directErr.message,
        );
      }
    }

    // Fallback: route through background script
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload,
    });
    debugLog("[YouTube Digest Panel] seekTo relay result:", result);
    return Boolean(result?.success);
  } catch (error) {
    console.error("[YouTube Digest Panel] seekTo error:", error);
    return false;
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  const original = btn.textContent;

  const success = await copyToClipboard(text);
  if (success) {
    btn.textContent = "Copied";
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  }
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(str) {
  return (str || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}

// ============================================================
// TEXT SELECTION ACTIONS
// ============================================================

/**
 * Hides actions that belong only to a live transcript selection. Clearing the
 * browser range also prevents the toolbar from returning on another tab.
 */
function dismissSelectionActions(clearSelection = false) {
  const tooltip = document.getElementById("explainTooltip");
  if (tooltip) tooltip.style.display = "none";
  if (clearSelection) window.getSelection()?.removeAllRanges();
}

/**
 * Sets up text selection handling in the transcript.
 * When the user selects text, shows an Explain action.
 *
 * The selection toolbar used to also offer a "Note" button that saved the
 * exact selected words (see showSelectionNoteInput, removed). Quote-capture
 * mechanism returns in a later step.
 */
function setupExplainFeature() {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  // This setup can run again after a cached transcript render. Abort old
  // document listeners so one selection creates only one action toolbar.
  selectionActionsController?.abort();
  selectionActionsController = new AbortController();
  const selectionSignal = selectionActionsController.signal;

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById("explainTooltip");
  if (existingTooltip) existingTooltip.remove();

  // Create one small toolbar for actions on the selected transcript text.
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.setAttribute("role", "toolbar");
  tooltip.setAttribute("aria-label", "Selected transcript actions");
  tooltip.innerHTML = `
    <button class="explain-btn" type="button">Explain</button>
  `;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let selectedText = "";

  // Interacting with the toolbar must preserve the transcript selection and
  // stay isolated from document and row click behavior.
  tooltip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tooltip.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  tooltip.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // Listen for text selection
  document.addEventListener(
    "mouseup",
    (event) => {
      if (tooltip.contains(event.target)) return;

      const selection = window.getSelection();
      const text = selection?.toString().trim() || "";
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;

      // Both ends must be inside the transcript.
      const isInTranscript = Boolean(
        range &&
          transcriptList.contains(range.startContainer) &&
          transcriptList.contains(range.endContainer),
      );

      // Allow any selection length.
      if (text.length > 0 && isInTranscript) {
        selectedText = text;

        // Set the final coordinates while the toolbar is still hidden. If it
        // becomes visible first, Chrome paints it at its default left edge for
        // one frame before moving it to the selection center.
        const rect = range.getBoundingClientRect();
        tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
        tooltip.style.left = `${rect.left + rect.width / 2}px`;
        tooltip.style.display = "flex";
      } else {
        tooltip.style.display = "none";
      }
    },
    { signal: selectionSignal },
  );

  // Hide tooltip when clicking elsewhere
  document.addEventListener(
    "mousedown",
    (event) => {
      if (!tooltip.contains(event.target)) {
        tooltip.style.display = "none";
      }
    },
    { signal: selectionSignal },
  );

  // Handle explain button click
  tooltip
    .querySelector(".explain-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText) return;

      tooltip.style.display = "none";
      await showExplanation(selectedText);
    });
}

/**
 * Shows the explanation modal and fetches it from the configured AI provider.
 */
async function showExplanation(selectedText) {
  // Create modal
  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal">
      <div class="explain-modal-header">
        <div class="explain-modal-title">Explain</div>
        <button class="explain-modal-close" id="closeExplain">Close</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>Analyzing...</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  document
    .getElementById("closeExplain")
    .addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: currentVideoTitle,
    });

    const contentDiv = document.getElementById("explanationContent");
    if (result.success) {
      contentDiv.innerHTML = `<div class="explain-text">${escapeHtml(result.explanation).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</div>`;
    } else {
      contentDiv.innerHTML = `<div class="explain-error">Failed to get explanation: ${escapeHtml(result.error)}</div>`;
    }
  } catch (error) {
    const contentDiv = document.getElementById("explanationContent");
    contentDiv.innerHTML = `<div class="explain-error">Error: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// CACHING
// ============================================================

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming API tokens or Supadata calls.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
async function saveToCache(videoId) {
  if (!videoId || !currentTranscript) return;

  try {
    // Persist semantic-segment translations for this video.
    const paragraphCacheForVideo = {};
    for (const [key, value] of transcriptParagraphCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        paragraphCacheForVideo[key] = value;
      }
    }
    const interfaceCacheForVideo = {};
    for (const [key, value] of interfaceTranslationCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        interfaceCacheForVideo[key] = value;
      }
    }

    const cacheData = {
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      paragraphCache: paragraphCacheForVideo,
      interfaceCache: interfaceCacheForVideo,
      timestamp: Date.now(),
    };

    // The Chat feature (background.js's handleChatWithTranscript) reads this
    // same digest_<videoId> entry directly from storage for its
    // transcriptTimestamped grounding, so this key must keep being written
    // here even though nothing else in this file reads it back for analysis.
    await chrome.storage.local.set({ [`digest_${videoId}`]: cacheData });
    debugLog("Saved to cache:", videoId);

    // Evict old entries if we have more than 20 videos cached
    await evictOldCacheEntries(20);
  } catch (error) {
    console.error("Cache save error:", error);
  }
}

/**
 * Keeps the cache from growing unbounded.
 * Removes the oldest entries when we exceed maxEntries videos.
 *
 * @param {number} maxEntries - Maximum number of cached videos to keep
 */
async function evictOldCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    let digestKeys = Object.keys(allData).filter((k) =>
      k.startsWith("digest_"),
    );
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = digestKeys.filter((key) => {
      const timestamp = Number(allData[key]?.timestamp) || 0;
      return Date.now() - timestamp > THIRTY_DAYS;
    });
    if (expired.length) {
      await chrome.storage.local.remove(expired);
      const expiredSet = new Set(expired);
      digestKeys = digestKeys.filter((key) => !expiredSet.has(key));
    }

    if (digestKeys.length <= maxEntries) return;

    // Sort by timestamp (oldest first) and remove excess
    const sorted = digestKeys
      .map((k) => ({ key: k, ts: allData[k]?.timestamp || 0 }))
      .sort((a, b) => a.ts - b.ts);

    const toRemove = sorted
      .slice(0, sorted.length - maxEntries)
      .map((e) => e.key);
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
      debugLog(`[YouTube Digest] Evicted ${toRemove.length} old cache entries`);
    }
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId) {
  if (!videoId) return null;

  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    const cached = result[`digest_${videoId}`];

    if (!cached) return null;

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(`digest_${videoId}`);
      return null;
    }

    return cached;
  } catch (error) {
    console.error("Cache load error:", error);
    return null;
  }
}

/**
 * Updates the cache after enhance or translation operations.
 */
async function updateCache() {
  if (currentVideoId) {
    await saveToCache(currentVideoId);
  }
}

// ============================================================
// NOTEBOOK — one freeform document per video
// ============================================================
// Replaces the old per-quote note-card system. A single textarea holds raw
// text (no Markdown rendering yet); edits autosave on a debounce so we don't
// write to storage on every keystroke.

/**
 * Loads the current video's notebook into the textarea. Guards against a
 * stale response landing after the user has already switched videos.
 */
async function loadNotebook(videoId) {
  const textarea = document.getElementById("notebookTextarea");
  if (!textarea) return;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "getNotebook",
      videoId,
    });
    if (videoId !== currentVideoId) return; // user moved on while this was in flight
    textarea.value = result?.notebook?.content || "";
    currentNotebookSync = result?.notebook?.driveFileId
      ? {
          driveFileId: result.notebook.driveFileId,
          driveFileUrl: result.notebook.driveFileUrl || null,
          lastSyncedAt: result.notebook.lastSyncedAt || null,
        }
      : null;
    renderNotebookSyncStatus(NOTEBOOK_SYNC_STATUS_MODE_IDLE);
    renderHighlightOverlay(); // Correct before the user has typed anything.
  } catch (error) {
    console.error("[YouTube Digest Panel] Load notebook error:", error);
  }
}

/**
 * Debounces autosave so we write to storage well after the user pauses
 * typing, not on every keystroke. The video ID and content are captured now
 * (not re-read when the timer fires), so a pending save always lands on the
 * video it was typed against even if the user switches videos in between.
 *
 * The highlight overlay, unlike the save itself, re-renders on every input
 * event with no debounce — it's a cheap string pass over already-in-memory
 * text, not a storage write.
 */
function scheduleNotebookSave() {
  renderHighlightOverlay();

  const textarea = document.getElementById("notebookTextarea");
  if (!textarea || !currentVideoId) return;

  const videoId = currentVideoId;
  const content = textarea.value;
  clearTimeout(notebookSaveTimer);
  notebookSaveTimer = setTimeout(() => {
    notebookSaveTimer = null;
    void saveNotebook(videoId, content);
  }, NOTEBOOK_SAVE_DEBOUNCE_MS);
}

async function saveNotebook(videoId, content) {
  try {
    await chrome.runtime.sendMessage({
      action: "saveNotebook",
      videoId,
      content,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
    });
  } catch (error) {
    console.error("[YouTube Digest Panel] Save notebook error:", error);
  }
}

/**
 * Saves immediately, bypassing the debounce timer — used right before the
 * panel closes so the last few keystrokes aren't lost.
 */
function flushNotebookSave() {
  if (!notebookSaveTimer) return Promise.resolve();
  clearTimeout(notebookSaveTimer);
  notebookSaveTimer = null;
  const textarea = document.getElementById("notebookTextarea");
  if (!textarea || !currentVideoId) return Promise.resolve();
  return saveNotebook(currentVideoId, textarea.value);
}

// ------------------------------------------------------------
// Export — Download (local .md file) and Save to Drive
// ------------------------------------------------------------
// Both outputs share the same content-assembly logic in notebook-export.js
// (YTD_NOTEBOOK_EXPORT): the frontmatter block is built only at export time
// and never touches the textarea or the stored `content` field.

/**
 * Builds a { videoId, videoTitle, channelName, content } notebook object
 * from current in-memory state, for the export helpers below. Uses the live
 * textarea value rather than the last autosaved copy so an export always
 * reflects exactly what's on screen, even mid-debounce.
 */
function currentNotebookForExport() {
  const textarea = document.getElementById("notebookTextarea");
  return {
    videoId: currentVideoId,
    videoTitle: currentVideoTitle,
    channelName: currentChannelName,
    content: textarea?.value || "",
  };
}

/**
 * Downloads the current notebook as a local .md file via chrome.downloads —
 * a fast, one-click export with no OAuth, no network call, and no special
 * permission prompt beyond the "downloads" permission declared in the
 * manifest.
 */
function downloadNotebookExport() {
  if (!currentVideoId) return;

  const notebook = currentNotebookForExport();
  const markdown = YTD_NOTEBOOK_EXPORT.buildNotebookExportMarkdown(notebook);
  const filename = YTD_NOTEBOOK_EXPORT.buildExportFilename(notebook);

  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  let revoked = false;
  const revokeOnce = () => {
    if (revoked) return;
    revoked = true;
    URL.revokeObjectURL(url);
  };

  chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
    if (chrome.runtime.lastError || !downloadId) {
      console.error(
        "[YouTube Digest Panel] Notebook download error:",
        chrome.runtime.lastError,
      );
      revokeOnce();
      showNotebookHotkeyMessage("Couldn't start the download");
      return;
    }
    // Revoke once Chrome reports a terminal state, with a short-timeout
    // fallback in case onChanged never fires for this download.
    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      chrome.downloads.onChanged.removeListener(onChanged);
      revokeOnce();
    };
    chrome.downloads.onChanged.addListener(onChanged);
    setTimeout(revokeOnce, 5000);
  });
}

/**
 * Turns an exportNotebookToDrive failure into the message shown near the
 * buttons. Branches on .code the way chatErrorMessage does for chat errors.
 */
function driveSyncErrorMessage(result) {
  if (result?.code === "NOTEBOOK_NOT_FOUND") {
    return "Write something in the notebook before saving to Drive.";
  }
  if (result?.code === "DRIVE_AUTH_FAILED") {
    return (
      result.error ||
      "Google Drive authorization failed. Please try again and approve access."
    );
  }
  if (result?.code === "DRIVE_QUOTA_EXCEEDED") {
    return result.error || "Google Drive storage quota exceeded.";
  }
  return result?.error || "Couldn't save to Google Drive. Please try again.";
}

function formatRelativeSyncTime(timestamp) {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// The three mutually exclusive states the status line can show. Every
// render explicitly picks one, so a leftover "Synced 2 min ago" from a
// prior success can never still be showing during a new in-progress or
// failed attempt — see saveNotebookToDrive.
const NOTEBOOK_SYNC_STATUS_MODE_IDLE = "idle";
const NOTEBOOK_SYNC_STATUS_MODE_PENDING = "pending";
const NOTEBOOK_SYNC_STATUS_MODE_ERROR = "error";

/**
 * Renders the small persistent status line near the export buttons. Always
 * called with an explicit mode so a stale state from a previous attempt is
 * never left on screen (see saveNotebookToDrive):
 *   - "idle": the durable sync state — hidden if never synced, otherwise
 *     "Synced X ago" with a link, recomputed fresh from currentNotebookSync
 *     each call (not a string frozen at the moment of the last success).
 *   - "pending": a distinct "Saving…" state shown the instant a save starts.
 *   - "error": a distinct error message, visually different from success
 *     (see .notebook-sync-status-error / -pending in sidepanel.css).
 */
function renderNotebookSyncStatus(mode, message) {
  const el = document.getElementById("notebookSyncStatus");
  if (!el) return;

  el.textContent = "";
  el.classList.toggle("notebook-sync-status-error", mode === NOTEBOOK_SYNC_STATUS_MODE_ERROR);
  el.classList.toggle("notebook-sync-status-pending", mode === NOTEBOOK_SYNC_STATUS_MODE_PENDING);

  if (mode === NOTEBOOK_SYNC_STATUS_MODE_PENDING) {
    el.textContent = "Saving…";
    el.hidden = false;
    return;
  }

  if (mode === NOTEBOOK_SYNC_STATUS_MODE_ERROR) {
    el.textContent = message;
    el.hidden = false;
    return;
  }

  if (!currentNotebookSync?.lastSyncedAt) {
    el.hidden = true;
    return;
  }

  el.hidden = false;
  el.append(`Synced ${formatRelativeSyncTime(currentNotebookSync.lastSyncedAt)}`);
  if (currentNotebookSync.driveFileUrl) {
    el.append(" — ");
    const link = document.createElement("a");
    link.href = currentNotebookSync.driveFileUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open in Drive";
    el.append(link);
  }
}

/**
 * Re-renders the "Synced X ago" label on a timer so it keeps advancing
 * while the panel stays open, instead of freezing at whatever it said the
 * moment the save succeeded. Only touches the idle state — never
 * interrupts an in-progress "Saving…" or a currently shown error.
 */
function tickNotebookSyncStatusLabel() {
  const el = document.getElementById("notebookSyncStatus");
  if (!el || el.hidden) return;
  if (el.classList.contains("notebook-sync-status-error")) return;
  if (el.classList.contains("notebook-sync-status-pending")) return;
  renderNotebookSyncStatus(NOTEBOOK_SYNC_STATUS_MODE_IDLE);
}

/**
 * Uploads/updates the current notebook in Google Drive via background.js's
 * exportNotebookToDrive. Flushes any pending autosave first so the export
 * always reflects the latest edits, then guards against the user switching
 * videos while either the flush or the network round-trip is in flight —
 * the same pattern sendChatMessage uses for its own in-flight request.
 */
async function saveNotebookToDrive() {
  if (!currentVideoId || notebookDriveSyncInFlight) return;
  const videoId = currentVideoId;

  // Clear any prior success/error text immediately — before the flush or
  // the network round-trip even starts — so a new attempt never shows
  // stale text from the last one.
  renderNotebookSyncStatus(NOTEBOOK_SYNC_STATUS_MODE_PENDING);

  await flushNotebookSave();
  if (videoId !== currentVideoId) return;

  const button = document.getElementById("notebookSaveToDriveBtn");
  notebookDriveSyncInFlight = true;
  if (button) button.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "exportNotebookToDrive",
      videoId,
    });
    if (videoId !== currentVideoId) return;

    if (result?.success) {
      currentNotebookSync = {
        driveFileId: result.driveFileId,
        driveFileUrl: result.driveFileUrl || null,
        lastSyncedAt: result.lastSyncedAt,
      };
      renderNotebookSyncStatus(NOTEBOOK_SYNC_STATUS_MODE_IDLE);
    } else {
      renderNotebookSyncStatus(NOTEBOOK_SYNC_STATUS_MODE_ERROR, driveSyncErrorMessage(result));
    }
  } catch (error) {
    if (videoId === currentVideoId) {
      renderNotebookSyncStatus(NOTEBOOK_SYNC_STATUS_MODE_ERROR, `Error: ${error.message}`);
    }
  } finally {
    notebookDriveSyncInFlight = false;
    if (button && videoId === currentVideoId) button.disabled = false;
  }
}

// ------------------------------------------------------------
// Drive export folder — a dropdown of folders THIS EXTENSION created
// ------------------------------------------------------------
// drive.file only grants access to files/folders the app itself created, so
// there is no scope-compatible way to browse the user's pre-existing Drive
// folders from here. Instead, this offers a dropdown of folders the
// extension has created (via background.js's createDriveFolder), plus a
// "+ New folder…" entry that creates one on the spot.

const DRIVE_FOLDER_NEW_OPTION = "__new_folder__";
const DRIVE_FOLDER_ROOT_OPTION = "";

/**
 * Rebuilds the <select> options from driveFolderList/currentDriveFolder.
 * Called after every load, create, or selection change so the control
 * always reflects the actual stored state (e.g. reverting the dropdown if
 * "+ New folder…" was cancelled).
 */
function renderDriveFolderOptions() {
  const select = document.getElementById("notebookDriveFolderSelect");
  if (!select) return;

  const options = [
    `<option value="${DRIVE_FOLDER_ROOT_OPTION}">My Drive (root)</option>`,
    ...driveFolderList.map(
      (folder) =>
        `<option value="${escapeHtml(folder.id)}">${escapeHtml(folder.name)}</option>`,
    ),
    `<option value="${DRIVE_FOLDER_NEW_OPTION}">+ New folder…</option>`,
  ];
  select.innerHTML = options.join("");
  select.value = currentDriveFolder?.id || DRIVE_FOLDER_ROOT_OPTION;
}

/**
 * Persists a new default export folder (or null for "My Drive (root)").
 * Takes effect on the next export of any notebook — a new file lands there,
 * and an already-exported file gets moved there — see
 * handleExportNotebookToDrive in background.js.
 */
async function applyDefaultDriveFolder(folder) {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "setDriveFolder",
      folder,
    });
    if (result?.success) {
      currentDriveFolder = result.folder;
    } else {
      renderNotebookSyncStatus(NOTEBOOK_SYNC_STATUS_MODE_ERROR, driveSyncErrorMessage(result));
    }
  } catch (error) {
    console.error("[YouTube Digest Panel] Set Drive folder error:", error);
    renderNotebookSyncStatus(NOTEBOOK_SYNC_STATUS_MODE_ERROR, `Error: ${error.message}`);
  } finally {
    renderDriveFolderOptions();
  }
}

/**
 * Creates a new Drive folder via background.js (same authenticated access
 * already used for exporting — no Picker, no extra scope), adds it to the
 * in-memory folder list, and makes it the new default.
 */
async function createAndSelectDriveFolder(name) {
  const select = document.getElementById("notebookDriveFolderSelect");
  if (select) select.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "createDriveFolder",
      name,
    });
    if (!result?.success) {
      renderNotebookSyncStatus(NOTEBOOK_SYNC_STATUS_MODE_ERROR, driveSyncErrorMessage(result));
      renderDriveFolderOptions();
      return;
    }
    driveFolderList = [...driveFolderList, result.folder];
    await applyDefaultDriveFolder(result.folder);
  } catch (error) {
    console.error("[YouTube Digest Panel] Create Drive folder error:", error);
    renderNotebookSyncStatus(NOTEBOOK_SYNC_STATUS_MODE_ERROR, `Error: ${error.message}`);
    renderDriveFolderOptions();
  } finally {
    if (select) select.disabled = false;
  }
}

/**
 * Handles a change on the folder <select>: "+ New folder…" prompts for a
 * name and creates it; any other option applies that folder (or root, for
 * the empty value) as the new default. Cancelling the prompt reverts the
 * dropdown without changing anything.
 */
async function handleDriveFolderSelectChange(event) {
  const value = event.target.value;

  if (value === DRIVE_FOLDER_NEW_OPTION) {
    const name = window.prompt("Name the new Drive folder:");
    if (!name || !name.trim()) {
      renderDriveFolderOptions(); // revert to the actual current selection
      return;
    }
    await createAndSelectDriveFolder(name.trim());
    return;
  }

  const folder = value ? driveFolderList.find((item) => item.id === value) || null : null;
  await applyDefaultDriveFolder(folder);
}

/**
 * Loads the global default Drive folder and the list of extension-created
 * folders once at panel startup — not per-video, unlike loadNotebook.
 */
async function loadDriveFolderSetting() {
  try {
    const [folderResult, listResult] = await Promise.all([
      chrome.runtime.sendMessage({ action: "getDriveFolder" }),
      chrome.runtime.sendMessage({ action: "listDriveFolders" }),
    ]);
    currentDriveFolder = folderResult?.folder || null;
    driveFolderList = listResult?.folders || [];
  } catch (error) {
    console.error("[YouTube Digest Panel] Load Drive folder settings error:", error);
  }
  renderDriveFolderOptions();
}

// ------------------------------------------------------------
// Markdown formatting shortcuts (Ctrl/Cmd+B, Ctrl/Cmd+I, Ctrl/Cmd+Shift+8)
// ------------------------------------------------------------
// These insert literal Markdown characters into the plain textarea — there
// is no rendered/rich-text view. The string logic below is pure (no DOM) so
// it can be unit tested; the keydown handler just wires it to the textarea.

/**
 * Toggles a symmetric marker (e.g. "**" for bold, "*" for italic) around the
 * current selection. If the selection is exactly bounded by the marker on
 * both sides already, the markers are removed instead of adding another
 * pair. Anything more ambiguous than that exact-bounded case (partial
 * overlap, nested markers) is intentionally not special-cased — it just
 * wraps again, per the no-full-parser scope of this feature.
 * With no selection, an empty marker pair is inserted with the cursor
 * placed between the two markers.
 */
function toggleInlineMarker(text, selectionStart, selectionEnd, marker) {
  const markerLen = marker.length;
  const before = text.slice(0, selectionStart);
  const selected = text.slice(selectionStart, selectionEnd);
  const after = text.slice(selectionEnd);

  const isExactlyBounded =
    before.slice(-markerLen) === marker && after.slice(0, markerLen) === marker;

  if (isExactlyBounded) {
    const newText =
      before.slice(0, before.length - markerLen) + selected + after.slice(markerLen);
    return {
      text: newText,
      selectionStart: selectionStart - markerLen,
      selectionEnd: selectionEnd - markerLen,
    };
  }

  const newText = before + marker + selected + marker + after;
  if (selectionStart === selectionEnd) {
    const cursor = selectionStart + markerLen;
    return { text: newText, selectionStart: cursor, selectionEnd: cursor };
  }
  return {
    text: newText,
    selectionStart: selectionStart + markerLen,
    selectionEnd: selectionEnd + markerLen,
  };
}

/**
 * Toggles a "- " bullet prefix on every line touched by the selection
 * (extended to whole lines first, same as Google Docs/Word). If every
 * non-empty touched line is already bulleted, the prefix is removed from
 * each; otherwise it's added to each line that doesn't already have it.
 * Blank lines are left untouched either way. Selection bounds are remapped
 * to keep tracking the same original text as lines shift.
 */
function toggleBulletPrefix(text, selectionStart, selectionEnd) {
  const BULLET = "- ";

  const rangeStart = text.lastIndexOf("\n", selectionStart - 1) + 1;
  let rangeEnd = text.indexOf("\n", selectionEnd);
  if (rangeEnd === -1) rangeEnd = text.length;

  const before = text.slice(0, rangeStart);
  const after = text.slice(rangeEnd);
  const lines = text.slice(rangeStart, rangeEnd).split("\n");

  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const shouldRemove =
    nonEmptyLines.length > 0 &&
    nonEmptyLines.every((line) => line.startsWith(BULLET));

  let oldAbs = rangeStart;
  let newAbs = rangeStart;
  let newSelectionStart = null;
  let newSelectionEnd = null;
  const newLines = lines.map((line, index) => {
    const isLast = index === lines.length - 1;
    const lineOldStart = oldAbs;
    const lineOldEnd = lineOldStart + line.length;
    const isEmpty = line.trim().length === 0;
    const hasPrefix = line.startsWith(BULLET);

    let newLine = line;
    if (!isEmpty) {
      if (shouldRemove && hasPrefix) newLine = line.slice(BULLET.length);
      else if (!shouldRemove && !hasPrefix) newLine = BULLET + line;
    }

    const mapLocal = (localOffset) => {
      if (isEmpty) return localOffset;
      if (shouldRemove && hasPrefix) {
        return Math.max(0, localOffset - BULLET.length);
      }
      if (!shouldRemove && !hasPrefix) {
        return localOffset + BULLET.length;
      }
      return localOffset;
    };

    if (selectionStart >= lineOldStart && selectionStart <= lineOldEnd) {
      newSelectionStart = newAbs + mapLocal(selectionStart - lineOldStart);
    }
    if (selectionEnd >= lineOldStart && selectionEnd <= lineOldEnd) {
      newSelectionEnd = newAbs + mapLocal(selectionEnd - lineOldStart);
    }

    oldAbs = lineOldEnd + 1; // skip the "\n"
    newAbs += newLine.length + (isLast ? 0 : 1);
    return newLine;
  });

  return {
    text: before + newLines.join("\n") + after,
    selectionStart: newSelectionStart ?? selectionStart,
    selectionEnd: newSelectionEnd ?? selectionEnd,
  };
}

/**
 * Applies a toggle*'s result to the live textarea, then manually dispatches
 * an "input" event — setting .value programmatically does NOT fire one
 * natively, and the autosave listener (see scheduleNotebookSave) only
 * listens for "input". Without this, formatting shortcuts would silently
 * fail to autosave until the next real keystroke.
 */
function applyNotebookShortcutResult(textarea, result) {
  textarea.value = result.text;
  textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Handles the notebook's Markdown formatting shortcuts, plus the
 * Ctrl/Cmd+Shift+Q quote-insert hotkey. Scoped to keydown on the notebook
 * textarea only (attached directly to it, not the document), so these
 * bindings can't fire from anywhere else in the panel. (Ctrl+N is
 * deliberately not used — Chrome reserves it for opening a new window.)
 */
function handleNotebookShortcutKeydown(event) {
  const textarea = event.currentTarget;
  const withModifier = event.ctrlKey || event.metaKey;
  if (!withModifier) return;

  if (event.shiftKey && event.code === "KeyQ") {
    event.preventDefault();
    void insertQuoteAtCursor(textarea);
    return;
  }

  let result = null;
  if (!event.shiftKey && event.code === "KeyB") {
    result = toggleInlineMarker(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd,
      "**",
    );
  } else if (!event.shiftKey && event.code === "KeyI") {
    result = toggleInlineMarker(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd,
      "*",
    );
  } else if (event.shiftKey && event.code === "Digit8") {
    result = toggleBulletPrefix(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd,
    );
  } else {
    return;
  }

  event.preventDefault();
  applyNotebookShortcutResult(textarea, result);
}

const NOTEBOOK_HOTKEY_MESSAGE_MS = 2500;
let notebookHotkeyMessageTimer = null;

/**
 * Shows a brief inline message near the notebook (e.g. when the quote-insert
 * hotkey can't find a matching transcript line), clearing itself after a
 * couple of seconds. Not a browser alert, not the old page-level toast.
 */
function showNotebookHotkeyMessage(message) {
  const el = document.getElementById("notebookHotkeyMessage");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(notebookHotkeyMessageTimer);
  notebookHotkeyMessageTimer = setTimeout(() => {
    el.hidden = true;
  }, NOTEBOOK_HOTKEY_MESSAGE_MS);
}

/**
 * Splices a cited-quote block into `text` at `cursorPos`. Pure — no DOM, no
 * chrome.* calls. If the cursor isn't already at the start of a line, a
 * leading newline is added first so the block doesn't run into existing
 * text. The returned selection lands on the blank reaction line right after
 * the segment-id comment, ready for the user's own thought.
 */
function buildQuoteInsertion(text, cursorPos, segmentText, timestampLabel, segmentId) {
  const atLineStart = cursorPos === 0 || text[cursorPos - 1] === "\n";
  const leadingNewline = atLineStart ? "" : "\n";
  const block = `${leadingNewline}> [${timestampLabel}] ${segmentText}\n<!-- ${segmentId} -->\n\n`;

  const before = text.slice(0, cursorPos);
  const after = text.slice(cursorPos);
  const cursor = before.length + block.length;

  return {
    text: before + block + after,
    selectionStart: cursor,
    selectionEnd: cursor,
  };
}

/**
 * Handles Ctrl/Cmd+Shift+Q: captures the transcript line at the current
 * playback position and inserts it as a cited quote at the cursor, with a
 * blank line left for the user's own reaction.
 *
 * Reuses the exact same current-time path (fetchCurrentPlaybackTime) and
 * segment-matching rule (findActiveSegmentIndex) as playback tracking — no
 * new relay mechanism, no new segment matcher. A paused video's currentTime
 * is just as citable as a playing one's, so `paused` is not treated as a
 * failure here — only a missing transcript, no matching segment, or a
 * timed-out/errored relay surface the "couldn't find" message rather than a
 * silent no-op or a thrown error.
 */
async function insertQuoteAtCursor(textarea) {
  const segments = getActiveTranscriptSegments();
  if (!segments.length) {
    showNotebookHotkeyMessage("Couldn't find the current line");
    return;
  }

  let playback = null;
  try {
    playback = await fetchCurrentPlaybackTime();
  } catch (error) {
    playback = null;
  }

  if (!playback) {
    showNotebookHotkeyMessage("Couldn't find the current line");
    return;
  }

  const activeIndex = findActiveSegmentIndex(segments, playback.currentTime);
  if (activeIndex === -1) {
    showNotebookHotkeyMessage("Couldn't find the current line");
    return;
  }

  const segment = segments[activeIndex];
  const result = buildQuoteInsertion(
    textarea.value,
    textarea.selectionStart,
    segment.text,
    formatTimestampLabel(segment.start),
    segment.id,
  );
  applyNotebookShortcutResult(textarea, result);
}

// A quote's own line always looks like "> [MM:SS] quoted text" (see
// buildQuoteInsertion), and its comment line always looks like
// "<!-- segment-<index>-<startMs> -->". Both must match for a line to count
// as an intact quote. This is the one place in the codebase that knows what
// a quote line looks like — findQuoteLineAtPosition and buildHighlightedHtml
// both build on extractAllQuotes rather than re-matching lines themselves.
const QUOTE_LINE_PATTERN = /^> \[(\d+:\d{2})\] (.+)$/;
const QUOTE_COMMENT_PATTERN = /^<!-- segment-\d+-(\d+) -->$/;

/**
 * Finds every intact quote in `text`, in document order. Pure — no DOM, no
 * chrome.* calls. A quote line whose immediately-following line isn't a
 * valid comment (missing, malformed, or hand-edited by the user) is
 * skipped — not included, not thrown on.
 */
function extractAllQuotes(text) {
  const quotes = [];
  let searchStart = 0;

  while (searchStart <= text.length) {
    let lineEnd = text.indexOf("\n", searchStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(searchStart, lineEnd);
    const quoteMatch = QUOTE_LINE_PATTERN.exec(line);

    if (quoteMatch && lineEnd < text.length) {
      const commentLineStart = lineEnd + 1;
      let commentLineEnd = text.indexOf("\n", commentLineStart);
      if (commentLineEnd === -1) commentLineEnd = text.length;
      const commentLine = text.slice(commentLineStart, commentLineEnd);
      const commentMatch = QUOTE_COMMENT_PATTERN.exec(commentLine);

      if (commentMatch) {
        quotes.push({
          startMs: Number(commentMatch[1]),
          timestampLabel: quoteMatch[1],
          quoteText: quoteMatch[2],
          lineStart: searchStart,
          lineEnd,
          commentLineStart,
          commentLineEnd,
        });
      }
    }

    if (lineEnd >= text.length) break;
    searchStart = lineEnd + 1;
  }

  return quotes;
}

/**
 * Detects whether the line containing `position` is an intact quote
 * inserted by buildQuoteInsertion. Pure — no DOM, no chrome.* calls. Returns
 * the quote's exact startMs (read from its comment line, not the rounded
 * [MM:SS] label) or null for any other line — ordinary prose, the blank
 * reaction line, or a quote whose comment was hand-edited or deleted.
 */
function findQuoteLineAtPosition(text, position) {
  const match = extractAllQuotes(text).find(
    (quote) => position >= quote.lineStart && position <= quote.lineEnd,
  );
  return match ? { startMs: match.startMs } : null;
}

/**
 * Builds the notebook's highlight-overlay HTML from the textarea's current
 * value. Pure with respect to the DOM tree — it never reads or writes the
 * live page beyond escapeHtml's internal detached element. Every quote line
 * found by extractAllQuotes is wrapped in a blue .quote-line span, and its
 * comment line in a muted .quote-meta span; everything else passes through
 * escaped but unwrapped. Content is always escaped first — this is the one
 * consistent security convention the rest of the codebase already follows.
 */
function buildHighlightedHtml(text) {
  const quotes = extractAllQuotes(text);
  if (!quotes.length) return escapeHtml(text);

  let html = "";
  let cursor = 0;

  for (const quote of quotes) {
    html += escapeHtml(text.slice(cursor, quote.lineStart));

    const quoteLine = text.slice(quote.lineStart, quote.lineEnd);
    html += `<span class="quote-line">${escapeHtml(quoteLine)}</span>`;

    // The single newline between the quote line and its comment line.
    html += escapeHtml(text.slice(quote.lineEnd, quote.commentLineStart));

    const commentLine = text.slice(quote.commentLineStart, quote.commentLineEnd);
    html += `<span class="quote-meta">${escapeHtml(commentLine)}</span>`;

    cursor = quote.commentLineEnd;
  }

  html += escapeHtml(text.slice(cursor));
  return html;
}

/**
 * Re-renders the notebook's syntax-highlighting backdrop from the
 * textarea's current value. Purely visual — the backdrop is aria-hidden and
 * pointer-events:none; the real <textarea> stays the only interactive
 * surface. Called on every "input" event and once when a notebook loads.
 */
function renderHighlightOverlay() {
  const backdrop = document.getElementById("notebookHighlightBackdrop");
  const textarea = document.getElementById("notebookTextarea");
  if (!backdrop || !textarea) return;
  backdrop.innerHTML = buildHighlightedHtml(textarea.value);
}

/**
 * Ctrl+Click (Cmd+Click on Mac) a quote's [MM:SS] text jumps the video to
 * that exact moment. Detected purely from the raw text via
 * findQuoteLineAtPosition — the textarea stays a plain <textarea>; nothing
 * is rendered as a link, and a plain click (no modifier) is left alone to
 * do its normal cursor-placement thing.
 */
async function handleNotebookQuoteClick(event) {
  if (!(event.ctrlKey || event.metaKey)) return;

  const textarea = event.currentTarget;
  // The native click has already moved the caret by the time this fires.
  const match = findQuoteLineAtPosition(textarea.value, textarea.selectionStart);
  if (!match) return;

  const success = await seekTo(match.startMs / 1000);
  if (!success) {
    showNotebookHotkeyMessage("Couldn't jump to that moment");
  }
}

// ============================================================
// AUTO-SCROLL — Follow video playback in transcript
// ============================================================
// While a video plays, the transcript automatically scrolls to show which
// 30-second chunk is currently being spoken. If the user manually scrolls
// (e.g., to read ahead), auto-scroll pauses and a "Follow playback" button
// appears so they can resume it. Highlight always stays active regardless.

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  const willRestoreReadingPosition =
    pendingTranscriptViewState?.videoId === currentVideoId;
  autoScrollEnabled = !willRestoreReadingPosition;
  document.getElementById("followPlaybackBtn").style.display =
    willRestoreReadingPosition ? "block" : "none";

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);

  // Listen for manual scrolls on the content area
  const contentArea = document.getElementById("contentArea");
  contentArea.removeEventListener("scroll", onContentAreaScroll);
  contentArea.addEventListener("scroll", onContentAreaScroll);
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  autoScrollEnabled = true; // Reset for next time
  lastAutoScrollTime = 0;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Remove active highlights
  document
    .querySelectorAll(".transcript-entry.active-playback")
    .forEach((el) => {
      el.classList.remove("active-playback");
    });
}

const GET_CURRENT_TIME_TIMEOUT_MS = 4000;

/**
 * Gets the current YouTube playback time and paused state. Tries direct
 * messaging to the stored YouTube tab first (fastest/reliable, same as
 * seekTo), falling back to the relayToContent path through background.js.
 * Wrapped in a timeout + settled guard, same pattern as
 * sendTranslationMessage, so a dead service worker or missing YouTube tab
 * can't hang a caller forever. Resolves null (never throws) for any
 * ordinary failure to respond; rejects only on the timeout.
 */
function fetchCurrentPlaybackTime() {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      finish(reject, new Error("Timed out getting the current playback time."));
    }, GET_CURRENT_TIME_TIMEOUT_MS);

    (async () => {
      if (youtubeTabId) {
        try {
          const response = await chrome.tabs.sendMessage(youtubeTabId, {
            action: "getCurrentTime",
          });
          if (typeof response?.currentTime === "number") {
            finish(resolve, {
              currentTime: response.currentTime,
              paused: Boolean(response.paused),
            });
            return;
          }
        } catch (directErr) {
          // Fall through to the relay path below.
        }
      }

      try {
        const result = await chrome.runtime.sendMessage({
          action: "relayToContent",
          payload: { action: "getCurrentTime" },
        });
        const response = result?.success ? result.response : null;
        if (typeof response?.currentTime === "number") {
          finish(resolve, {
            currentTime: response.currentTime,
            paused: Boolean(response.paused),
          });
        } else {
          finish(resolve, null);
        }
      } catch (relayErr) {
        finish(resolve, null);
      }
    })();
  });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * YouTube tab and highlights + scrolls to the matching transcript entry.
 */
async function playbackTrackingTick() {
  try {
    const playback = await fetchCurrentPlaybackTime();
    if (!playback) return;
    highlightActiveEntry(playback.currentTime);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away, or
    // the request timed out.
  }
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Stamps lastAutoScrollTime BEFORE scrolling so the scroll
 * events from our own smooth animation aren't mistaken for the user
 * scrolling away (which would re-disable auto-scroll immediately).
 */
function scrollToActiveEntry() {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  lastAutoScrollTime = Date.now();
  activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

/**
 * Finds the index of the segment whose time range contains currentSeconds,
 * given an ascending array of objects with a numeric `start` (matches
 * groupTranscriptEntries' output). Shared by the playback highlighter below
 * and the notebook's quote-insert hotkey, so both use one matching rule.
 */
function findActiveSegmentIndex(segments, currentSeconds) {
  let activeIndex = -1;
  for (let i = 0; i < segments.length; i++) {
    const start = segments[i].start;
    const nextStart = i + 1 < segments.length ? segments[i + 1].start : Infinity;
    if (currentSeconds >= start && currentSeconds < nextStart) {
      activeIndex = i;
    }
  }
  return activeIndex;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll(".transcript-entry");
  if (entries.length === 0) return;

  const segments = Array.from(entries, (entry) => ({
    start: parseInt(entry.dataset.seconds),
  }));
  const activeIndex = findActiveSegmentIndex(segments, currentSeconds);
  if (activeIndex === -1) return;
  const activeEntry = entries[activeIndex];

  // Skip if this entry is already highlighted (no DOM thrashing)
  if (activeEntry.classList.contains("active-playback")) return;

  // Remove old highlight, add new one
  entries.forEach((e) => e.classList.remove("active-playback"));
  activeEntry.classList.add("active-playback");

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Scroll event handler for the content area.
 * Detects manual scrolling and disables auto-scroll so the user
 * can read at their own pace without being yanked back.
 */
function onContentAreaScroll() {
  scheduleTranscriptViewStateSave();

  // Ignore scroll events within 1 second of a programmatic scroll
  // (smooth scroll animations can last longer than a simple boolean flag)
  if (Date.now() - lastAutoScrollTime < 1000) return;

  // User scrolled manually — disable auto-scroll and show the button
  if (autoScrollEnabled && autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
}

/**
 * Uses session storage when it is available. Local storage is a safe fallback
 * for older test or browser environments that do not expose session storage.
 */
function getTranscriptViewStateStorage() {
  return chrome.storage.session || chrome.storage.local;
}

/**
 * Reads one video's last visible transcript position.
 */
async function loadTranscriptViewState(videoId) {
  if (!videoId) return null;
  try {
    const result = await getTranscriptViewStateStorage().get(
      TRANSCRIPT_VIEW_STATE_KEY,
    );
    const state = result?.[TRANSCRIPT_VIEW_STATE_KEY]?.[videoId];
    const scrollTop = Number(state?.scrollTop);
    if (!Number.isFinite(scrollTop) || scrollTop < 0) return null;
    return { videoId, scrollTop };
  } catch (error) {
    console.error("[YouTube Digest] Reading position load error:", error);
    return null;
  }
}

/**
 * Stores positions for a small recent set of videos. This prevents one value
 * from growing without a limit during a long Chrome session.
 */
async function saveTranscriptViewState(videoId, scrollTop) {
  if (!videoId || !Number.isFinite(scrollTop) || scrollTop < 0) return;
  try {
    const storage = getTranscriptViewStateStorage();
    const result = await storage.get(TRANSCRIPT_VIEW_STATE_KEY);
    const states = result?.[TRANSCRIPT_VIEW_STATE_KEY] || {};
    states[videoId] = { scrollTop, updatedAt: Date.now() };

    const recentStates = Object.fromEntries(
      Object.entries(states)
        .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 20),
    );
    await storage.set({ [TRANSCRIPT_VIEW_STATE_KEY]: recentStates });
  } catch (error) {
    console.error("[YouTube Digest] Reading position save error:", error);
  }
}

/**
 * Saves the visible position after scrolling stops. Capturing the video ID and
 * position now prevents a later video change from writing the wrong state.
 */
function scheduleTranscriptViewStateSave() {
  if (
    isRestoringTranscriptView ||
    !currentVideoId ||
    !transcriptTabIsActive()
  ) {
    return;
  }
  const contentArea = document.getElementById("contentArea");
  if (!contentArea) return;

  const videoId = currentVideoId;
  const scrollTop = contentArea.scrollTop;
  lastTranscriptScrollTop = scrollTop;
  clearTimeout(transcriptViewStateSaveTimer);
  transcriptViewStateSaveTimer = setTimeout(() => {
    void saveTranscriptViewState(videoId, scrollTop);
  }, 150);
}

/**
 * Saves immediately before the panel closes.
 */
function saveCurrentTranscriptViewState() {
  clearTimeout(transcriptViewStateSaveTimer);
  const contentArea = document.getElementById("contentArea");
  if (!currentVideoId || !contentArea) return Promise.resolve();
  if (transcriptTabIsActive()) captureCurrentTranscriptScrollTop();
  return saveTranscriptViewState(currentVideoId, lastTranscriptScrollTop);
}

/**
 * Returns true only while the Transcript tab is the visible results panel.
 */
function transcriptTabIsActive() {
  return resultTabIsActive("transcript");
}

function resultTabIsActive(tabName) {
  return Boolean(
    document.querySelector(
      `.tab-panel[data-panel="${CSS.escape(tabName)}"].active`,
    ),
  );
}

/**
 * Copies the shared scroll area's current value into transcript-only state.
 */
function captureCurrentTranscriptScrollTop() {
  const contentArea = document.getElementById("contentArea");
  if (contentArea) lastTranscriptScrollTop = contentArea.scrollTop;
}

/**
 * Restores the saved position after the transcript becomes visible. Follow
 * Playback stays paused, so the next timer tick cannot move the panel again.
 */
function restorePendingTranscriptViewState(videoId) {
  const state = pendingTranscriptViewState;
  pendingTranscriptViewState = null;
  const contentArea = document.getElementById("contentArea");
  if (!state || state.videoId !== videoId) {
    contentArea?.classList.remove("restoring-transcript-view");
    return;
  }

  requestAnimationFrame(() => {
    if (currentVideoId !== videoId || !contentArea) {
      contentArea?.classList.remove("restoring-transcript-view");
      return;
    }

    isRestoringTranscriptView = true;
    lastAutoScrollTime = Date.now();
    autoScrollEnabled = false;
    contentArea.scrollTop = state.scrollTop;
    lastTranscriptScrollTop = state.scrollTop;
    document.getElementById("followPlaybackBtn").style.display = "block";
    contentArea.classList.remove("restoring-transcript-view");
    requestAnimationFrame(() => {
      isRestoringTranscriptView = false;
    });
  });
}

// ============================================================
// UNIVERSAL DISPLAY LANGUAGE — Original / Chinese / aligned bilingual
// ============================================================

async function loadDisplayLanguageMode(videoId) {
  if (!videoId) {
    setTranscriptModeButtons("original");
    return "original";
  }
  try {
    const stored = await chrome.storage.local.get(DISPLAY_LANGUAGE_MODE_KEY);
    const mode = stored?.[DISPLAY_LANGUAGE_MODE_KEY]?.[videoId]?.mode;
    currentTranscriptMode = DISPLAY_LANGUAGE_MODES.has(mode)
      ? mode
      : "original";
  } catch (error) {
    currentTranscriptMode = "original";
  }
  setTranscriptModeButtons(currentTranscriptMode);
  return currentTranscriptMode;
}

async function saveDisplayLanguageMode(videoId, mode) {
  if (!videoId || !DISPLAY_LANGUAGE_MODES.has(mode)) return;
  const stored = await chrome.storage.local.get(DISPLAY_LANGUAGE_MODE_KEY);
  const modes = stored?.[DISPLAY_LANGUAGE_MODE_KEY] || {};
  modes[videoId] = { mode, updatedAt: Date.now() };
  const recentModes = Object.fromEntries(
    Object.entries(modes)
      .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 50),
  );
  await chrome.storage.local.set({
    [DISPLAY_LANGUAGE_MODE_KEY]: recentModes,
  });
}

function getActiveTranscriptSegments() {
  return groupTranscriptEntries(currentTranscript || []);
}

function transcriptTranslationCacheKey(segment) {
  return `${currentVideoId}:zh:semantic:${segment.id}`;
}

function setTranscriptModeButtons(mode) {
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    const active = button.dataset.transcriptMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function handleDisplayLanguageModeChange(mode) {
  if (!DISPLAY_LANGUAGE_MODES.has(mode)) return;
  if (mode === currentTranscriptMode) return;

  currentTranscriptMode = mode;
  await saveDisplayLanguageMode(currentVideoId, mode);
  if (mode !== "original") interfaceTranslationFailures.clear();
  translationGeneration += 1;
  translationWorkCount = 0;
  setTranslatingSpinner(false);
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  setTranscriptModeButtons(mode);
  const activeTabName =
    document.querySelector(".tab.active")?.dataset.tab || "transcript";

  if (mode === "original") {
    renderTranscript();
    return;
  }

  if (activeTabName === "transcript") {
    await translateTranscript();
  }
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderSubtitleInlineMarkup(segment.text);
  let translationHtml = "";
  if (translated) {
    translationHtml = renderSubtitleInlineMarkup(translated);
  } else if (error) {
    translationHtml = `${escapeHtml(error)}<button class="translation-retry-btn" type="button">Retry</button>`;
  } else {
    translationHtml = "Waiting for translation…";
  }

  if (mode === "bilingual") {
    return `<span class="transcript-copy"><span class="transcript-original">${original}</span><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
  }

  return `<span class="transcript-copy"><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
}

function renderTranscriptModeRows(segments, mode) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return [];
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const rows = [];
  segments.forEach((segment, index) => {
    const div = document.createElement("div");
    const cached = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(segment),
    );
    div.className = `transcript-entry ${cached ? "translated" : "translating"}`;
    div.dataset.seconds = segment.start;
    div.dataset.segmentId = segment.id;
    div.dataset.segmentIndex = index;

    const timestamp = formatTimestampLabel(segment.start);
    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
    `;
    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, segment.start),
    );
    transcriptList.appendChild(div);
    rows.push(div);
  });

  // Bilingual mode can find source text before each translation arrives.
  refreshTranscriptSearch({ preserveIndex: false, scroll: false });

  startPlaybackTracking();
  return rows;
}

/**
 * Rebuilds a provider response in source order. Unknown IDs are ignored and
 * missing IDs remain explicit errors, never positional guesses.
 */
function alignTranslatedSegmentBatch(sourceSegments, responseSegments) {
  const translatedById = new Map();
  if (Array.isArray(responseSegments)) {
    responseSegments.forEach((item) => {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string")
        return;
      const text = item.text.trim();
      if (text && !translatedById.has(item.id)) {
        translatedById.set(item.id, text);
      }
    });
  }

  return sourceSegments.map((segment) => ({
    id: segment.id,
    text: translatedById.get(segment.id) || "",
    error: translatedById.has(segment.id) ? "" : "Translation unavailable.",
  }));
}

function updateTranslatedRow(segment, index, alignedItem, generation) {
  if (generation !== translationGeneration) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
  );
  if (!row) return;

  if (alignedItem.text) {
    transcriptParagraphCache.set(
      transcriptTranslationCacheKey(segment),
      alignedItem.text,
    );
  }

  const copy = row.querySelector(".transcript-copy");
  if (copy) {
    copy.outerHTML = renderTranscriptSegmentContent(
      segment,
      currentTranscriptMode,
      alignedItem.text,
      alignedItem.error,
    );
  }
  row.classList.toggle("translated", !!alignedItem.text);
  row.classList.toggle("translating", false);
  row.classList.toggle("translation-failed", !alignedItem.text);

  const retry = row.querySelector(".translation-retry-btn");
  if (retry) {
    ["mousedown", "mouseup"].forEach((eventName) => {
      retry.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      retryTranslationSegment(index, generation);
    });
  }
}

let activeTranslationQueue = null;

async function requestTranscriptTranslationBatch(
  indices,
  segments,
  generation,
  videoId,
  mode,
) {
  const sourceBatch = indices.map((index) => segments[index]);
  setTranslatingSpinner(true);
  try {
    const result = await sendTranslationMessage({
      action: "translateContent",
      content: {
        segments: sourceBatch.map(({ id, text }) => ({ id, text })),
      },
      contentType: "transcriptBatch",
      targetLanguage: "zh",
      videoTitle: currentVideoTitle,
    });

    const isStale =
      generation !== translationGeneration ||
      videoId !== currentVideoId ||
      mode !== currentTranscriptMode;
    if (isStale) return;

    const responseSegments = result?.success
      ? result.translatedContent?.segments
      : [];
    const aligned = alignTranslatedSegmentBatch(sourceBatch, responseSegments);
    aligned.forEach((item, batchIndex) => {
      if (!result?.success) {
        item.error = result?.error || "Translation failed.";
      }
      updateTranslatedRow(
        sourceBatch[batchIndex],
        indices[batchIndex],
        item,
        generation,
      );
    });
    refreshTranscriptSearch({ preserveIndex: true, scroll: false });
    await updateCache();
  } catch (error) {
    if (generation !== translationGeneration) return;
    sourceBatch.forEach((segment, batchIndex) => {
      updateTranslatedRow(
        segment,
        indices[batchIndex],
        { id: segment.id, text: "", error: error.message || "Translation failed." },
        generation,
      );
    });
    refreshTranscriptSearch({ preserveIndex: true, scroll: false });
  } finally {
    setTranslatingSpinner(false);
  }
}

function retryTranslationSegment(index, generation) {
  if (generation !== translationGeneration || !activeTranslationQueue) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-index="${index}"]`,
  );
  if (row) {
    row.classList.add("translating");
    row.classList.remove("translation-failed");
    const translation = row.querySelector(".transcript-translation");
    if (translation) {
      translation.className = "transcript-translation translation-pending";
      translation.textContent = "Retrying…";
    }
  }
  activeTranslationQueue.enqueue(index, true);
}

/**
 * Renders immediately, translates the first small batch, then observes the
 * remaining rows. Batches are sequential so the provider is never flooded.
 */
async function translateTranscript() {
  const segments = getActiveTranscriptSegments();
  if (!segments.length || currentTranscriptMode === "original") return;

  const generation = translationGeneration;
  const videoId = currentVideoId;
  const mode = currentTranscriptMode;
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();

  const rows = renderTranscriptModeRows(segments, mode);
  const queue = [];
  const queued = new Set();
  let processing = false;

  const processNext = async () => {
    if (processing || queue.length === 0 || generation !== translationGeneration)
      return;
    processing = true;
    const indices = queue.splice(0, TRANSLATION_BATCH_SIZE);
    indices.forEach((index) => queued.delete(index));
    try {
      await requestTranscriptTranslationBatch(
        indices,
        segments,
        generation,
        videoId,
        mode,
      );
    } finally {
      processing = false;
      if (queue.length && generation === translationGeneration) processNext();
    }
  };

  const enqueue = (index, force = false) => {
    if (!Number.isInteger(index) || !segments[index]) return;
    const cached = transcriptParagraphCache.has(
      transcriptTranslationCacheKey(segments[index]),
    );
    if ((!force && cached) || queued.has(index)) return;
    queue.push(index);
    queued.add(index);
    // Let all entries reported in the same viewport turn collect before the
    // worker starts, producing one small contextual multi-segment request.
    Promise.resolve().then(processNext);
  };
  activeTranslationQueue = { enqueue };

  transcriptScrollObserver = new IntersectionObserver(
    (observerEntries) => {
      observerEntries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (a, b) =>
            Number(a.target.dataset.segmentIndex) -
            Number(b.target.dataset.segmentIndex),
        )
        .forEach((entry) => enqueue(Number(entry.target.dataset.segmentIndex)));
    },
    {
      root: document.getElementById("contentArea"),
      rootMargin: "320px 0px",
      threshold: 0,
    },
  );

  rows.forEach((row, index) => {
    if (!row.classList.contains("translated")) transcriptScrollObserver.observe(row);
    if (index < TRANSLATION_BATCH_SIZE) enqueue(index);
  });
}

function setTranslatingSpinner(show) {
  if (show) translationWorkCount += 1;
  else translationWorkCount = Math.max(0, translationWorkCount - 1);
  const isTranslating = translationWorkCount > 0;
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", isTranslating);
}

// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  sendTranslationMessage,
  groupTranscriptEntries,
  splitOversizedThought,
  alignTranslatedSegmentBatch,
  findLiteralTranscriptMatches,
  loadTranscriptViewState,
  saveTranscriptViewState,
  loadDisplayLanguageMode,
  saveDisplayLanguageMode,
  getNavigationUrl,
  renderSubtitleInlineMarkup,
  renderTranscriptSegmentContent,
  saveNotebook,
};

globalThis.__YTD_NOTEBOOK_TESTING__ = {
  toggleInlineMarker,
  toggleBulletPrefix,
  buildQuoteInsertion,
  findActiveSegmentIndex,
  formatTimestampLabel,
  findQuoteLineAtPosition,
  extractAllQuotes,
  buildHighlightedHtml,
  driveSyncErrorMessage,
  formatRelativeSyncTime,
};
