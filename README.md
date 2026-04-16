# YT Transcript & Summary

A Firefox extension that adds a **Copy Transcript** button and an **AI Summarize** button to YouTube video pages. Supports **light and dark mode**, plain text, and **Markdown** output.

Built on top of [YouTube Transcript Copier](https://addons.mozilla.org/en-US/firefox/addon/youtube-transcript-copier/) by **dislikelever**, released under the MIT License.

## Features

- One-click transcript copy to clipboard
- **AI-powered video summarization** with configurable providers (OpenAI, Anthropic, Google Gemini, Groq, OpenRouter)
- **Light & dark mode** – adapts to your YouTube theme automatically
- **Copy as Markdown** – headings, links, and timestamp tables
- Plain text with or without timestamps
- Paragraph mode for continuous reading
- Optional video title and URL in output
- Summary displayed inline on YouTube or copied to clipboard
- Configurable system prompt and model selection
- Settings persist via `chrome.storage.sync` (falls back to `localStorage`)
- Resilient to YouTube's SPA navigation

## Settings

| Option | Default | Description |
|---|---|---|
| Include video title | ✅ | Prepends the video title |
| Include video URL | ✅ | Adds a link to the video |
| Include timestamps | ✅ | Shows `(0:00)` before each line |
| Single paragraph | ❌ | Joins all text into one block |
| Copy as Markdown | ❌ | Formats output as Markdown |

## Installation (development)

1. Open `about:debugging#/runtime/this-firefox` in Firefox
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` from this folder

## Build & Publish

See the [Firefox Extension Workshop](https://extensionworkshop.com/documentation/publish/) for full instructions on publishing to AMO.

## Credits

- Original extension: **YouTube Transcript Copier** by [dislikelever](https://addons.mozilla.org/en-US/firefox/addon/youtube-transcript-copier/)
- This derivative: **YT Transcript & Summary** by felixleopold

## License

[MIT](LICENSE)
