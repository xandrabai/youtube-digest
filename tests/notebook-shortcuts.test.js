const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * Loads sidepanel.js in a sandboxed VM (same minimal approach as
 * tests/notebook.test.js's loadSidepanelNotebookHelpers) and returns its
 * __YTD_NOTEBOOK_TESTING__ hook, which exposes the pure string logic behind
 * the notebook's Markdown formatting shortcuts.
 */
function loadShortcutHelpers() {
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
      // Matches the real div.textContent = x; div.innerHTML round-trip that
      // escapeHtml() performs, and the mock already used for this in
      // tests/translation.test.js's loadSidepanelHelpers.
      createElement: () => {
        let value = "";
        return {
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage: () => Promise.resolve({}) },
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
  return sandbox.__YTD_NOTEBOOK_TESTING__;
}

const {
  toggleInlineMarker,
  toggleBulletPrefix,
  buildQuoteInsertion,
  findActiveSegmentIndex,
  formatTimestampLabel,
  findQuoteLineAtPosition,
  extractAllQuotes,
  buildHighlightedHtml,
} = loadShortcutHelpers();

test("toggleInlineMarker wraps a selection and offsets the selection past the marker", () => {
  const result = toggleInlineMarker("hello world", 6, 11, "**");
  assert.equal(result.text, "hello **world**");
  assert.equal(result.selectionStart, 8);
  assert.equal(result.selectionEnd, 13);
  assert.equal(result.text.slice(result.selectionStart, result.selectionEnd), "world");
});

test("toggleInlineMarker with no selection inserts an empty pair with the cursor between", () => {
  const result = toggleInlineMarker("hello ", 6, 6, "**");
  assert.equal(result.text, "hello ****");
  assert.equal(result.selectionStart, 8);
  assert.equal(result.selectionEnd, 8);
  assert.equal(result.selectionStart, result.selectionEnd, "cursor is collapsed, not a selection");
});

test("toggleInlineMarker removes the markers when the selection is exactly bounded (toggle off)", () => {
  const wrapped = toggleInlineMarker("hello world", 6, 11, "**");
  assert.equal(wrapped.text, "hello **world**");

  // Select just the inner text again (not the markers themselves), per the
  // task's clarified manual-test scenario, and press the shortcut again.
  const unwrapped = toggleInlineMarker(
    wrapped.text,
    wrapped.selectionStart,
    wrapped.selectionEnd,
    "**",
  );
  assert.equal(unwrapped.text, "hello world");
  assert.equal(unwrapped.selectionStart, 6);
  assert.equal(unwrapped.selectionEnd, 11);
  assert.equal(unwrapped.text.slice(unwrapped.selectionStart, unwrapped.selectionEnd), "world");
});

test("toggleInlineMarker italic wraps and unwraps the same way as bold", () => {
  const wrapped = toggleInlineMarker("hi there", 3, 8, "*");
  assert.equal(wrapped.text, "hi *there*");

  const unwrapped = toggleInlineMarker(
    wrapped.text,
    wrapped.selectionStart,
    wrapped.selectionEnd,
    "*",
  );
  assert.equal(unwrapped.text, "hi there");
  assert.equal(unwrapped.selectionStart, 3);
  assert.equal(unwrapped.selectionEnd, 8);
});

test("toggleInlineMarker at the very start of the text does not false-positive on an empty prefix", () => {
  const result = toggleInlineMarker("abc", 0, 3, "**");
  assert.equal(result.text, "**abc**");
  assert.equal(result.selectionStart, 2);
  assert.equal(result.selectionEnd, 5);
});

test("toggleBulletPrefix adds a bullet to a single line with the cursor placed anywhere in it", () => {
  const result = toggleBulletPrefix("hello", 2, 2);
  assert.equal(result.text, "- hello");
  // The cursor was between "he" and "llo"; after inserting "- " at the line
  // start, it should still sit between the same two original characters.
  assert.equal(result.selectionStart, 4);
  assert.equal(result.selectionEnd, 4);
  assert.equal(result.text.slice(0, result.selectionStart), "- he");
});

test("toggleBulletPrefix removes the bullet on a second press over the same line", () => {
  const added = toggleBulletPrefix("hello", 2, 2);
  assert.equal(added.text, "- hello");

  const removed = toggleBulletPrefix(added.text, added.selectionStart, added.selectionEnd);
  assert.equal(removed.text, "hello");
  assert.equal(removed.selectionStart, 2);
  assert.equal(removed.selectionEnd, 2);
});

test("toggleBulletPrefix on a multi-line selection where no line is bulleted adds to every line", () => {
  const text = "one\ntwo\nthree";
  const result = toggleBulletPrefix(text, 0, text.length);
  assert.equal(result.text, "- one\n- two\n- three");
  // Position 0 was immediately before the "o" of "one" — that character is
  // now 2 slots further in, so the remapped selection follows it there.
  assert.equal(result.selectionStart, 2);
  assert.equal(result.selectionEnd, result.text.length);
});

test("toggleBulletPrefix removes from every line when all touched lines are already bulleted", () => {
  const text = "- one\n- two\n- three";
  const result = toggleBulletPrefix(text, 0, text.length);
  assert.equal(result.text, "one\ntwo\nthree");
  assert.equal(result.selectionStart, 0);
  assert.equal(result.selectionEnd, result.text.length);
});

test("toggleBulletPrefix with a mixed selection (only some lines bulleted) adds only to the lines missing it", () => {
  const text = "- one\ntwo\nthree";
  const result = toggleBulletPrefix(text, 0, text.length);
  // Not every touched line is bulleted, so the rule is "add to each line
  // that doesn't already have it" — the already-bulleted line is untouched
  // rather than gaining a second prefix.
  assert.equal(result.text, "- one\n- two\n- three");
});

test("toggleBulletPrefix extends a partial-line selection to whole lines and skips blank lines", () => {
  const text = "first line\nsecond line\n\nfourth line";
  // Selection only covers part of "first line" through part of "fourth
  // line", touching a blank line along the way.
  const start = text.indexOf("first line") + 2;
  const end = text.indexOf("fourth line") + 3;
  const result = toggleBulletPrefix(text, start, end);
  assert.equal(result.text, "- first line\n- second line\n\n- fourth line");

  // Pressing again over the same (now-shifted) selection should remove it.
  const removed = toggleBulletPrefix(result.text, result.selectionStart, result.selectionEnd);
  assert.equal(removed.text, text);
});

test("toggleBulletPrefix twice on the same three-line selection round-trips to the original text", () => {
  const text = "alpha\nbeta\ngamma";
  const added = toggleBulletPrefix(text, 0, text.length);
  assert.equal(added.text, "- alpha\n- beta\n- gamma");

  const removed = toggleBulletPrefix(added.text, added.selectionStart, added.selectionEnd);
  assert.equal(removed.text, text);
  assert.equal(removed.selectionStart, 0);
  assert.equal(removed.selectionEnd, text.length);
});

test("formatTimestampLabel matches the MM:SS format used elsewhere", () => {
  assert.equal(formatTimestampLabel(0), "0:00");
  assert.equal(formatTimestampLabel(65), "1:05");
  assert.equal(formatTimestampLabel(125.9), "2:05");
});

test("findActiveSegmentIndex picks the segment whose range contains the time, defaulting to -1", () => {
  const segments = [{ start: 0 }, { start: 10 }, { start: 25 }];
  assert.equal(findActiveSegmentIndex(segments, 0), 0);
  assert.equal(findActiveSegmentIndex(segments, 9.9), 0);
  assert.equal(findActiveSegmentIndex(segments, 10), 1);
  assert.equal(findActiveSegmentIndex(segments, 100), 2);
  assert.equal(findActiveSegmentIndex([], 5), -1);
});

test("buildQuoteInsertion adds a leading newline when the cursor is mid-document", () => {
  const text = "Earlier thought here.";
  const cursorPos = text.length; // end of the (single) line, not line-start
  const result = buildQuoteInsertion(text, cursorPos, "Segment text.", "1:05", "segment-3-65000");

  assert.equal(
    result.text,
    "Earlier thought here.\n> [1:05] Segment text.\n<!-- segment-3-65000 -->\n\n",
  );
});

test("buildQuoteInsertion does not add an extra newline when the cursor is already at line start", () => {
  const text = "Earlier thought here.\n";
  const cursorPos = text.length; // right after the newline: start of a new, empty line
  const result = buildQuoteInsertion(text, cursorPos, "Segment text.", "1:05", "segment-3-65000");

  assert.equal(
    result.text,
    "Earlier thought here.\n> [1:05] Segment text.\n<!-- segment-3-65000 -->\n\n",
  );
});

test("buildQuoteInsertion inserts at the cursor, not always at the end of the document", () => {
  const text = "before\nafter";
  const cursorPos = text.indexOf("\n") + 1; // start of the "after" line
  const result = buildQuoteInsertion(text, cursorPos, "Segment text.", "0:30", "segment-1-30000");

  assert.equal(
    result.text,
    "before\n> [0:30] Segment text.\n<!-- segment-1-30000 -->\n\nafter",
  );
});

test("buildQuoteInsertion's returned cursor lands on the blank reaction line, not after it", () => {
  const text = "before\nafter";
  const cursorPos = text.indexOf("\n") + 1;
  const result = buildQuoteInsertion(text, cursorPos, "Segment text.", "0:30", "segment-1-30000");

  // The blank reaction line sits right before "after" — the cursor should be
  // exactly there: nothing selected, and what follows is still "after".
  assert.equal(result.selectionStart, result.selectionEnd);
  assert.equal(result.text.slice(result.selectionStart), "after");
  assert.equal(result.text[result.selectionStart - 1], "\n");
});

test("buildQuoteInsertion inserting two quotes back to back does not run them together", () => {
  let text = "";
  const first = buildQuoteInsertion(text, 0, "First segment.", "0:00", "segment-0-0");
  text = first.text;

  const second = buildQuoteInsertion(
    text,
    first.selectionStart,
    "Second segment.",
    "0:10",
    "segment-1-10000",
  );

  assert.equal(
    second.text,
    "> [0:00] First segment.\n<!-- segment-0-0 -->\n\n" +
      "> [0:10] Second segment.\n<!-- segment-1-10000 -->\n\n",
  );
});

test("findQuoteLineAtPosition matches a click inside the quote text and reads startMs from the comment", () => {
  const { text } = buildQuoteInsertion("", 0, "First quoted text.", "0:05", "segment-0-5000");
  const clickPos = text.indexOf("quoted"); // inside the quote line, not at either edge

  const match = findQuoteLineAtPosition(text, clickPos);
  assert.deepEqual(JSON.parse(JSON.stringify(match)), { startMs: 5000 });
});

test("findQuoteLineAtPosition returns null for the blank reaction line below a quote", () => {
  const { text, selectionStart } = buildQuoteInsertion(
    "",
    0,
    "First quoted text.",
    "0:05",
    "segment-0-5000",
  );
  // selectionStart lands exactly on the blank reaction line per Step 3.
  assert.equal(findQuoteLineAtPosition(text, selectionStart), null);
});

test("findQuoteLineAtPosition returns null for ordinary prose", () => {
  const { text: afterQuote } = buildQuoteInsertion(
    "",
    0,
    "First quoted text.",
    "0:05",
    "segment-0-5000",
  );
  const text = afterQuote + "Just my own thought here, not a quote.";
  const clickPos = text.indexOf("own thought");

  assert.equal(findQuoteLineAtPosition(text, clickPos), null);
});

test("findQuoteLineAtPosition resolves the correct quote when the document has multiple", () => {
  const first = buildQuoteInsertion("", 0, "First quoted text.", "0:05", "segment-0-5000");
  const withReaction = first.text + "My reaction to the first quote.\n";
  const second = buildQuoteInsertion(
    withReaction,
    withReaction.length,
    "Second quoted text.",
    "1:30",
    "segment-1-90000",
  );

  const firstClickPos = second.text.indexOf("First quoted");
  const secondClickPos = second.text.indexOf("Second quoted");

  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(findQuoteLineAtPosition(second.text, firstClickPos)), { startMs: 5000 });
  assert.deepEqual(plain(findQuoteLineAtPosition(second.text, secondClickPos)), { startMs: 90000 });
});

test("findQuoteLineAtPosition returns null when the comment line was hand-edited or deleted", () => {
  const { text } = buildQuoteInsertion("", 0, "First quoted text.", "0:05", "segment-0-5000");
  const clickPos = text.indexOf("quoted");

  const commentDeleted = text.replace("<!-- segment-0-5000 -->\n", "");
  assert.equal(findQuoteLineAtPosition(commentDeleted, clickPos), null);

  const commentEdited = text.replace(
    "<!-- segment-0-5000 -->",
    "<!-- something the user typed -->",
  );
  assert.equal(findQuoteLineAtPosition(commentEdited, clickPos), null);
});

test("findQuoteLineAtPosition returns null for a quote line with no following line at all", () => {
  // The document ends right after the quote line, with no comment line and
  // no trailing newline — an edge case that must not throw.
  const text = "> [0:05] First quoted text.";
  assert.equal(findQuoteLineAtPosition(text, text.indexOf("quoted")), null);
});

test("buildHighlightedHtml passes plain text through escaped and unwrapped when there are no quotes", () => {
  const html = buildHighlightedHtml("Just my own thoughts here.");
  assert.equal(html, "Just my own thoughts here.");
  assert.doesNotMatch(html, /<span/);
});

test("buildHighlightedHtml wraps a single quote line in .quote-line and its comment in .quote-meta", () => {
  const { text } = buildQuoteInsertion("", 0, "Quoted text.", "0:05", "segment-0-5000");
  const html = buildHighlightedHtml(text);

  assert.equal(
    html,
    '<span class="quote-line">&gt; [0:05] Quoted text.</span>\n' +
      '<span class="quote-meta">&lt;!-- segment-0-5000 --&gt;</span>\n\n',
  );
});

test("buildHighlightedHtml wraps every quote in a multi-quote document, leaving prose between them plain", () => {
  const first = buildQuoteInsertion("", 0, "First quote.", "0:05", "segment-0-5000");
  const withReaction = first.text + "My reaction.\n";
  const second = buildQuoteInsertion(
    withReaction,
    withReaction.length,
    "Second quote.",
    "1:30",
    "segment-1-90000",
  );

  const html = buildHighlightedHtml(second.text);
  const quoteLineMatches = html.match(/<span class="quote-line">/g) || [];
  const quoteMetaMatches = html.match(/<span class="quote-meta">/g) || [];

  assert.equal(quoteLineMatches.length, 2);
  assert.equal(quoteMetaMatches.length, 2);
  assert.match(html, /<span class="quote-line">&gt; \[0:05\] First quote\.<\/span>/);
  assert.match(html, /<span class="quote-line">&gt; \[1:30\] Second quote\.<\/span>/);
  // Prose between the quotes stays unwrapped, not inside any span.
  assert.match(html, /\n\nMy reaction\.\n<span class="quote-line">/);
});

test("buildHighlightedHtml renders a quote with a missing or malformed comment as plain escaped text, not wrapped", () => {
  const { text } = buildQuoteInsertion("", 0, "Quoted text.", "0:05", "segment-0-5000");
  const brokenComment = text.replace(
    "<!-- segment-0-5000 -->",
    "<!-- not a real comment -->",
  );

  const html = buildHighlightedHtml(brokenComment);

  assert.doesNotMatch(html, /<span/);
  assert.equal(
    html,
    escapeHtmlForTest("> [0:05] Quoted text.") +
      "\n" +
      escapeHtmlForTest("<!-- not a real comment -->") +
      "\n\n",
  );
});

test("buildHighlightedHtml escapes <, >, and & both inside and outside quote lines", () => {
  const { text } = buildQuoteInsertion(
    "Prose with <script> & \"quotes\" outside a quote.\n",
    "Prose with <script> & \"quotes\" outside a quote.\n".length,
    "Quoted <b>markup</b> & \"text\".",
    "0:05",
    "segment-0-5000",
  );

  const html = buildHighlightedHtml(text);

  assert.doesNotMatch(html, /<script>|<b>markup<\/b>/);
  assert.match(html, /Prose with &lt;script&gt; &amp; &quot;quotes&quot; outside a quote\./);
  assert.match(
    html,
    /<span class="quote-line">&gt; \[0:05\] Quoted &lt;b&gt;markup&lt;\/b&gt; &amp; &quot;text&quot;\.<\/span>/,
  );
});

// Mirrors escapeHtml()'s real (mocked) escaping so expectations above don't
// have to hand-write &amp;/&lt;/&gt;/&quot; substitutions.
function escapeHtmlForTest(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
