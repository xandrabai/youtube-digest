# YouTube Digest

[English](README.md) | [简体中文](README.zh-CN.md)

Turn every YouTube video into a resource for deep learning. YouTube Digest brings transcripts, bilingual translation, an AI chat grounded in the video, and a personal notebook into one Chrome side panel, so you can study ideas and language without losing your place.

- Turn captions into a readable, searchable learning resource.
- Learn languages with the original transcript, a Simplified Chinese translation, or an aligned bilingual view.
- Ask an AI chat questions about the video — it answers using the transcript and whatever you've written in your own notes.
- Navigate long videos by clicking timestamps in the transcript, or in a quoted line inside your notes.
- Keep one freeform notebook per video: write in Markdown, use quick formatting shortcuts, and pull in cited quotes from the video with a single keystroke.
- Export your notebook as a Markdown file, or sync it straight to a Google Drive folder you choose.
- Keep control of your data with your own API keys, local Chrome storage, and no analytics or telemetry.

YouTube Digest is a bring-your-own-key project installed locally from GitHub. It is not available through the Chrome Web Store, does not include API credits, and does not run a developer-operated server.

![YouTube Digest demo](YouTube%20Digest%20demo.png)

## New in v2.0.0 (update the `version` field in `manifest.json` to match if you adopt this)

The Notes tab and the Overview tab have both been rebuilt from scratch:

- **Overview is now Chat.** Ask questions about the video in plain language. Answers are grounded in the transcript and, if you've written any, your own notes for that video — not a one-shot chapters-and-key-quotes summary. Chat history resets when you switch videos or close the panel; it isn't saved to disk.
- **Notes is now one freeform notebook per video**, replacing the old list of separately captured quote cards.
  - Markdown formatting shortcuts: **Ctrl+B** (bold), **Ctrl+I** (italic), **Ctrl+Shift+8** (bullet list).
  - Press **Ctrl+Shift+Q** to insert a cited quote — `[MM:SS]` and the transcript line at the current playback position — at your cursor. Works whether the video is playing or paused.
  - Quote lines render in blue. **Ctrl/Cmd+Click** one to jump the video back to that exact moment.
  - Notes autosave as you type, and are flushed immediately when the panel closes.
- **Export your notebook.** Click **Download** for an instant Markdown file, no setup required. Or click **Save to Drive** to sync it to a Google Drive folder you choose — this needs a short one-time setup; see [Set up Google Drive export](#set-up-google-drive-export-optional) below.

Search, the unified Original/中文/双语 setting across Transcript and Notes, and select-and-explain are unchanged from earlier versions.

## Install with your coding agent

You do not need to understand the code or use the command line. Send this message to your coding agent:

> Download or clone this project into a permanent folder I choose, tell me its exact full path, and use that same folder for Chrome's Load unpacked step. If I need a suggestion during this first installation, offer `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows, but do not assume either path. Walk me through installation and setup in simple terms.

Your agent should:

1. Ask where you want to keep the project, download or clone it there, and tell you the exact full path. If you want a suggestion, it can offer `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows.
2. Open the official Supadata and DeepSeek pages below and help you create your own accounts.
3. Walk you through selecting the exact project folder you chose in Chrome with **Load unpacked**.
4. Show you where to enter your API keys in the extension's **Settings** page.
5. Open a YouTube video with captions and confirm the transcript, Chat, and Notes work.

Keep this folder in the same place after installation. If you move or delete it, Chrome's unpacked extension stops working until you load the extension again from its new permanent folder.

Never paste an API key into an AI chat, source file, screenshot, or public message. Enter keys yourself, directly in the YouTube Digest Settings page. Your coding agent can point to the correct field without seeing the key.

## Install manually

If you prefer to do it yourself:

1. Open [github.com/zarazhangrui/youtube-digest](https://github.com/zarazhangrui/youtube-digest).
2. Choose **Code**, then **Download ZIP**.
3. Choose a permanent folder and unzip the project there. Optional suggestions are `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows. You may use a different folder.
4. In Chrome, open `chrome://extensions`.
5. Turn on **Developer mode**.
6. Click **Load unpacked**.
7. Select the exact project folder you chose, which must contain `manifest.json`.
8. Pin YouTube Digest from Chrome's Extensions menu if you want quick access.

Because this is an unpacked extension, it does not update automatically. After downloading an update or changing local files, click **Reload** on the YouTube Digest card at `chrome://extensions`, **then refresh any open YouTube tabs** — reloading the extension does not update scripts already injected into tabs that were open beforehand (see [Troubleshooting](#buttons-stop-working-or-the-console-shows-cannot-read-properties-of-undefined-reading-sendmessage)). Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location.

## Set up your API keys

YouTube Digest needs two keys under your own provider accounts:

1. A **Supadata API key** to retrieve YouTube transcripts.
2. A **DeepSeek API key** for Chat, selected-text explanations, and translation.

### Get a Supadata API key

1. Open the official [Supadata sign-up page](https://dash.supadata.ai/auth/sign-up).
2. Create an account and complete the short onboarding flow.
3. Supadata generates an API key automatically during onboarding.
4. Open the [Supadata dashboard](https://dash.supadata.ai/) whenever you need to find or manage the key.
5. Copy the key and paste it into **Supadata API key** in YouTube Digest Settings.

See the [official Supadata documentation](https://docs.supadata.ai/) if the dashboard flow changes.

### Get a DeepSeek API key

1. Open the official [DeepSeek API Keys page](https://platform.deepseek.com/api_keys).
2. Sign in or create a DeepSeek Platform account when prompted.
3. Choose **Create new API key**, give it a recognizable name such as `YouTube Digest`, and create it.
4. Copy the key immediately. The full key may only be shown once.
5. Paste it into **DeepSeek API key** in YouTube Digest Settings.
6. If DeepSeek reports insufficient balance, add credit in your DeepSeek Platform account and try again.

See the [official DeepSeek API documentation](https://api-docs.deepseek.com/) for current account and API details.

Open **Settings** from the side panel. You can also open the YouTube Digest **Options** page from its card at `chrome://extensions` or by right-clicking its toolbar icon. Paste keys only into these Settings fields. Never paste a key into an AI chat, repository file, screenshot, or public message.

The published version supports DeepSeek V4 Flash as its only AI provider:

```text
Base URL: https://api.deepseek.com
Model: deepseek-v4-flash
```

YouTube Digest sends every DeepSeek request in non-thinking mode for responsive, predictable interactions. The endpoint and model are fixed in Settings, so the only AI credential you enter is your DeepSeek API key. Chat sends the full transcript, your notebook content, and the growing conversation history on every turn, with no summarization or truncation — cost and latency both increase somewhat as a single conversation gets longer. To use another provider or model, copy the safe customization prompt in Settings and give it to a coding agent for your local copy. Never add an API key to that prompt or chat.

Keys and settings are stored in Chrome's local extension storage on your device. Release builds do not include or use `config.js`.

## Set up Google Drive export (optional)

Downloading your notebook as a `.md` file works immediately, with no setup. Syncing to Google Drive is optional and needs a one-time setup in Google Cloud Console, because Chrome requires extensions to register before they're allowed to touch anyone's Drive account.

### 1. Get a stable extension ID

Chrome normally assigns an unpacked extension's ID based on its folder path, so it changes if you ever move or re-clone the folder. Lock it down first:

```bash
openssl genrsa -out key.pem 2048
openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A
```

Add the printed string as a top-level `"key"` field in `manifest.json`:

```json
{
  "key": "<paste the base64 string here>",
  "manifest_version": 3,
  ...
}
```

Two things commonly go wrong here:

- Copying the base64 string by selecting it on screen in a terminal can accidentally capture an invisible line-ending character along with it, which silently corrupts the value and produces a `Value 'key' is missing or invalid` error when loading the extension. Pipe it straight to your clipboard instead — add `| pbcopy` on macOS to the second command above — and paste directly, without viewing it on screen first.
- Keep `key.pem` itself **outside** the extension's project folder. Chrome scans every file inside a loaded unpacked extension and warns if it finds a private key sitting there.

Remove the extension from `chrome://extensions` and **Load unpacked** again (a plain reload doesn't fully re-derive the ID). Confirm the ID shown on its card stays identical across a couple of reloads and a full Chrome restart before moving on.

### 2. Register an OAuth client in Google Cloud Console

1. Create a project at [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate).
2. **APIs & Services → OAuth consent screen → Get started.** App name and your email; User type: **External**. This starts the app in Testing mode, which needs no Google review for personal use.
3. In the **Audience** tab, add your own Google account as a test user. Skipping this produces an access-blocked error the first time you try to export.
4. In the **Data access** tab, add the scope `https://www.googleapis.com/auth/drive.file` — access limited to files and folders this extension creates itself, never your whole Drive.
5. **APIs & Services → Library** → enable the **Google Drive API**.
6. **APIs & Services → Credentials** (labeled **Clients** in some versions of the console) → **Create Client** → Application type: **Chrome Extension** → paste the stable extension ID from step 1.
7. Copy the resulting Client ID into the `oauth2.client_id` field in `manifest.json`, replacing the placeholder.
8. Reload the extension in `chrome://extensions`, then refresh any open YouTube tabs.

Because the app stays unverified — expected and fine for a personal project — Google may occasionally ask you to re-consent even after a successful first authorization, and authorizations expire after 7 days regardless. That's normal, not a bug.

### 3. Choose a destination folder

`drive.file` only ever grants access to files and folders this extension created itself — it cannot browse your existing Drive structure, which is why there's no "pick any folder" browser here. Use **+ New folder** in the Notes tab to create and name a destination from inside the extension; it's remembered and offered again for future exports. A file that's deleted directly in Google Drive (even just moved to the trash) is replaced with a fresh one on the next save, rather than silently patched in place.

## Use YouTube Digest

1. Open a standard YouTube watch page with captions.
2. Click the YouTube Digest extension icon to open the side panel.
3. Read the timestamped transcript, or choose **Original**, **中文**, or **双语**.
4. Open **Chat** to ask questions about the video — answers draw on the transcript and, once you've written any, your own notes.
5. Select transcript text when you want an AI explanation.
6. Open **Notes** to keep a running notebook for the video: type freely, use Ctrl+B / Ctrl+I / Ctrl+Shift+8 to format, and press Ctrl+Shift+Q to drop in a cited quote from wherever the video currently is.
7. Click **Download** to save the notebook as Markdown, or **Save to Drive** to sync it to your chosen Drive folder.

## What works today

- Google Chrome 116 or newer, using the Side Panel API.
- Standard `youtube.com/watch` video pages.
- Native subtitle tracks returned by Supadata. YouTube Digest prefers English when available, but may show another native language.
- Original, Simplified Chinese, and aligned bilingual transcript views.
- An AI chat grounded in the transcript and your notebook, selected-text explanations, and translation.
- A freeform, Markdown notebook per video with formatting shortcuts, cited quotes with click-to-seek, and autosave.
- Downloading your notebook as Markdown at any time, and optionally syncing it to a Google Drive folder of your choosing (`drive.file` scope only — see [Set up Google Drive export](#set-up-google-drive-export-optional)).
- A local cache for recent transcript results.
- DeepSeek V4 Flash for all published AI features. Other providers require a local code adaptation and are not supported by this published version.

Shorts, live streams, private or access-restricted videos, and videos without an available native transcript may not work. Firefox, Safari, mobile browsers, and other Chromium browsers are not currently tested or supported.

YouTube Digest forces Supadata's `mode=native`. It does not request AI-generated transcripts or perform local audio transcription when native captions are unavailable.

## Supadata free tier and request costs

Current as of August 9, 2026, the [Supadata pricing page](https://supadata.ai/pricing) lists a free tier with **100 credits per month**, no credit card required. Unused credits do not roll over. Supadata pricing can change, so check the current page before relying on these numbers.

The [Supadata transcript documentation](https://docs.supadata.ai/get-transcript) describes the transcript request modes and credit behavior:

- A native transcript request uses **1 credit**, regardless of video duration.
- A generated transcript costs **2 credits per video minute**. YouTube Digest does not use this path because it forces `mode=native`.
- An unavailable native lookup returned as HTTP `206` still uses **1 credit**.

With the current native-only behavior, the free tier can cover roughly 100 transcript lookups per month when each request succeeds once. Retries and unavailable-caption lookups also consume credits, so actual successful-video coverage can be lower.

DeepSeek usage is separate from Supadata. YouTube Digest does not collect payments or resell access. Set spending limits and monitor both accounts.

## DeepSeek V4 Flash pricing

As of August 27, 2026, DeepSeek lists these USD prices per 1 million tokens on its official [pricing page](https://api-docs.deepseek.com/quick_start/pricing/):

| Token type | Off-peak | Peak |
| --- | ---: | ---: |
| Cache-hit input | $0.007 | $0.014 |
| Cache-miss input | $0.22 | $0.44 |
| Output | $0.66 | $1.32 |

Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday. All other hours use off-peak rates.

A measured 20-minute English talk used about **32,600 input tokens** and an estimated **3,500 to 4,500 output tokens** across 43 small translation batches. At current prices, translating the full video costs approximately:

- **Off-peak: $0.003 to $0.010 USD**.
- **Peak: $0.005 to $0.020 USD**.

The lower end assumes most repeated input hits DeepSeek's cache. The upper end assumes cache misses. Translation is lazy and cached, so translating only part of a video costs less. Chat costs scale differently — each question resends the full transcript, your notebook, and the conversation so far, so cost per turn grows as a conversation continues, unlike translation's small cached batches. Check the official page before relying on these prices.

## Remix it with your coding agent

This is a personal remix project. Upstream issues and pull requests are not accepted. If something breaks or you want a new feature, download or fork your own copy and ask your coding agent to fix, remix, or personalize it for you.

YouTube Digest uses plain HTML, CSS, and JavaScript with no build step, so it is a friendly starting point for agent-assisted projects. Ideas to try:

- Add more translation languages and let each person choose a learning language.
- Customize Chat's system prompt for different video genres — lectures, interviews, tutorials, reviews, research talks.
- Let Chat also read notebooks from other videos, for cross-video synthesis instead of one video at a time.
- Add a rendered Markdown preview mode for the notebook — today's highlight overlay only recolors cited-quote lines, not full formatting.
- Support the real Google Picker for browsing your existing Drive structure, instead of the current app-managed-folders-only approach. Worth knowing before attempting this: an earlier version of this project tried loading the Picker directly into the side panel and hit a hard wall — Manifest V3 does not permit any remotely-hosted script in an extension page's `script-src` under any configuration, so an embedded Picker cannot work this way. Google's "open in a real tab, handle a redirect back" pattern is the path that would actually work, and needs a differently-configured OAuth client than the one used for the rest of Drive export.
- Export notes to more formats than Markdown — CSV, Anki, or another study tool.
- Add optional local-model support for a different privacy and cost tradeoff.
- Improve accessibility with keyboard navigation, font controls, and higher-contrast themes.

Ask your agent to preserve the bring-your-own-key model, keep secrets out of source files, run the checks below, and test the remix on real videos.

If you want another AI provider or model, first open the exact YouTube Digest project folder that Chrome loaded through **Load unpacked** in your coding agent. Then open YouTube Digest Settings and use **Copy customization prompt**. Replace the `[PROVIDER]` and `[MODEL]` placeholders before sending it. Do not include any API key in the prompt or chat. After the agent updates your local copy, enter the key yourself in the Settings field it identifies.

## Privacy and data flow

YouTube Digest makes provider requests directly from the extension:

1. It sends a canonical YouTube watch URL to Supadata to request the native transcript.
2. It sends the transcript — and your notebook's content, if you've written any — to DeepSeek when you use Chat, Explain, or translation.
3. Focused features send only the content they need, such as selected text with context or small transcript batches for translation.
4. If you set up Google Drive export, it can create and update files inside a Drive folder you designate, using a `drive.file` scope that cannot see or touch any other file in your Drive.
5. It stores keys, settings, notebooks, and recent cache entries locally in Chrome.

There is no YouTube Digest account system, advertising, analytics, or telemetry. Supadata, DeepSeek, and — if you set it up — Google Drive still receive data under their own terms and privacy policies. See [PRIVACY.md](PRIVACY.md) for details.

## Troubleshooting

### The Digest button is missing on a YouTube video

- At `chrome://extensions`, find YouTube Digest and click **Reload**, then refresh the YouTube tab.
- Confirm that you are on a standard `https://www.youtube.com/watch?...` page, not a Short, embed, or live page.
- The current version automatically follows YouTube when its responsive action bar changes. Wait a moment after the page finishes loading.
- If it is still missing, ask your coding agent to inspect the content script on that exact video page.

### The side panel does not open

- Confirm that you are on a standard `https://www.youtube.com/watch?...` page.
- At `chrome://extensions`, confirm YouTube Digest is enabled and click **Reload**.
- Refresh the YouTube tab after reloading the extension.
- Ask your coding agent to inspect the extension if the problem continues.

### Buttons stop working, or the console shows "Cannot read properties of undefined (reading 'sendMessage')"

This means a YouTube tab is running an old, orphaned copy of the content script from before the extension was last reloaded — reloading the extension in `chrome://extensions` does not update scripts already injected into tabs that were open beforehand.

- Reload the extension in `chrome://extensions` first.
- Then fully refresh the YouTube tab — or, more reliably, close it and open a fresh one to the same video.
- Test immediately, without reloading the extension again in between.

### "Value 'key' is missing or invalid" when loading unpacked

The `key` field in `manifest.json` is missing, empty, or corrupted — usually from a base64 string that picked up a stray character during copying. Regenerate it following [Set up Google Drive export](#set-up-google-drive-export-optional) step 1, paste it in without viewing it on screen first, and verify with:

```bash
python3 -c "import json, base64; k = json.load(open('manifest.json'))['key']; base64.b64decode(k, validate=True); print('ok')"
```

### YouTube Digest asks for setup

- Open **Settings** and save both a Supadata key and a DeepSeek key.
- This published version uses the fixed DeepSeek V4 Flash endpoint and model. There are no Base URL or Model fields to configure.
- If Settings says a legacy custom provider was removed, enter a DeepSeek key. The old AI key was cleared so it could not be reused with the wrong service.

### No transcript is found

- Confirm the video is public and has native captions.
- Check your Supadata key, remaining credits, rate limit, and account status.
- Remember that unavailable native lookups and manual retries may still consume credits.

YouTube Digest will not fall back to generated transcription.

### AI requests fail

- A `401` or `403` usually means the DeepSeek key or account access is invalid.
- A `429` usually means a DeepSeek rate or spending limit was reached.
- Confirm the key was created in the DeepSeek Platform account linked above and that the account has available credit.
- If you adapted a local copy for another model, use the Settings customization prompt again and ask your coding agent to inspect that local implementation.

### Drive export doesn't work

- Confirm you replaced the placeholder `client_id` in `manifest.json` with a real one from your own OAuth client, and reloaded the extension afterward.
- Confirm the extension's ID shown at `chrome://extensions` matches the ID registered with the OAuth client — regenerating `key.pem` changes the ID, and the OAuth client needs re-registering against the new one if that happens.
- Confirm your own Google account is listed as a test user on the OAuth consent screen.
- Confirm the `drive.file` scope was actually added in the Data access tab, and that the Drive API is enabled in the Library.

Never share API keys, private transcripts, or personal notes in chats, screenshots, or logs.

## Checks for coding agents

Ask your coding agent to run these commands after changing the project:

```bash
npm test
npm run check
npm run package
```

The agent should also reload the unpacked extension in Chrome — remembering that a YouTube tab open from before the reload needs its own refresh too — and test several real YouTube videos. Automated checks do not prove that live provider requests and YouTube interactions work.

## 
## License

MIT. See [LICENSE](LICENSE).
