(function () {
  "use strict";

  if (window.__ytTranscriptProLoaded) return;
  window.__ytTranscriptProLoaded = true;

  // ---------------------------------------------------------------------------
  // Constants & defaults
  // ---------------------------------------------------------------------------

  const STORAGE_KEY = "yt-transcript-summary-settings";

  const DEFAULT_SETTINGS = {
    includeTitle: true,
    includeUrl: true,
    includeTimestamps: true,
    useParagraphs: false,
    copyAsMarkdown: false,
    aiProvider: "openai",
    aiApiKey: "",
    aiModel: "",
    summarySystemPrompt: [
      "You are an expert content analyst specializing in video summarization.",
      "Analyze the following YouTube video based on its transcript and description,",
      "then produce a comprehensive summary in Markdown format.",
      "",
      "Your summary should include:",
      "",
      "1. **Overview** \u2013 A 2-3 sentence high-level summary of the video.",
      "2. **Key Points** \u2013 Bulleted list of the most important topics covered.",
      "3. **Notable Details** \u2013 Interesting facts, quotes, statistics, or examples.",
      "4. **Takeaways** \u2013 Actionable insights or conclusions to remember.",
      "",
      "Guidelines:",
      "- Be concise but thorough \u2014 capture the substance without filler.",
      "- Use clear, professional language.",
      "- Preserve technical terms and proper nouns from the original content.",
      "- Structure output for easy scanning with headers and bullet points.",
      "- For tutorials, include key steps. For discussions, present different perspectives.",
      "- Output only the summary \u2014 no preamble or meta-commentary.",
    ].join("\n"),
    summaryOutput: "clipboard",
  };

  const DEFAULT_MODELS = {
    openai: "gpt-4o-mini",
    anthropic: "claude-sonnet-4-6",
    google: "gemini-2.0-flash",
    groq: "llama-3.3-70b-versatile",
    openrouter: "anthropic/claude-sonnet-4-6",
  };

  const modelCache = {};

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let observer = null;
  let protectionObserver = null;
  let retryCount = 0;
  let isInjected = false;
  let lastUrl = location.href;
  let urlChangeTimer = null;

  const MAX_RETRIES = 5;
  const CONTAINER_ID = "yt-transcript-summary-container";

  // ---------------------------------------------------------------------------
  // Settings persistence (chrome.storage.sync → localStorage fallback)
  // ---------------------------------------------------------------------------

  function getSettings() {
    return new Promise((resolve) => {
      if (chrome?.storage?.sync) {
        const timeout = setTimeout(() => resolve({ ...DEFAULT_SETTINGS }), 500);
        try {
          chrome.storage.sync.get(DEFAULT_SETTINGS, (result) => {
            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
              resolve(readLocalSettings());
            } else {
              resolve({ ...DEFAULT_SETTINGS, ...result });
            }
          });
        } catch {
          clearTimeout(timeout);
          resolve(readLocalSettings());
        }
      } else {
        resolve(readLocalSettings());
      }
    });
  }

  function saveSettings(settings) {
    if (chrome?.storage?.sync) {
      try {
        chrome.storage.sync.set(settings, () => {
          if (chrome.runtime.lastError) writeLocalSettings(settings);
        });
        return;
      } catch {
        /* fall through */
      }
    }
    writeLocalSettings(settings);
  }

  function readLocalSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function writeLocalSettings(settings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable – settings won't persist */
    }
  }

  // ---------------------------------------------------------------------------
  // Styles – adapts to YouTube light / dark mode via CSS custom properties
  // ---------------------------------------------------------------------------

  function injectStyles() {
    if (document.getElementById("yt-transcript-summary-styles")) return;

    const style = document.createElement("style");
    style.id = "yt-transcript-summary-styles";
    style.textContent = /* css */ `
      /* ── Container ─────────────────────────────────────────── */
      #${CONTAINER_ID} {
        display: flex;
        align-items: center;
        margin-left: 8px;
        position: relative;
        z-index: 1;
      }

      /* ── Shared button base ────────────────────────────────── */
      .ytp-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 36px;
        padding: 0 16px;
        font-size: 14px;
        font-weight: 500;
        font-family: "Roboto", "Arial", sans-serif;
        border: none;
        cursor: pointer;
        outline: none;
        user-select: none;
        transition: background-color 0.2s, opacity 0.2s;

        /* Fallback for light mode (YouTube sets the variable in both modes) */
        background-color: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, 0.06));
        color: var(--yt-spec-text-primary, #0f0f0f);
      }

      /* Dark mode fallback when YouTube CSS variables are not yet set */
      @media (prefers-color-scheme: dark) {
        .ytp-btn {
          background-color: var(--yt-spec-badge-chip-background, rgba(255, 255, 255, 0.1));
          color: var(--yt-spec-text-primary, #fff);
        }
      }

      .ytp-btn:hover {
        background-color: var(--yt-spec-button-chip-background-hover, rgba(0, 0, 0, 0.12));
      }

      @media (prefers-color-scheme: dark) {
        .ytp-btn:hover {
          background-color: var(--yt-spec-button-chip-background-hover, rgba(255, 255, 255, 0.15));
        }
      }

      .ytp-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }

      /* ── Copy button (left pill) ───────────────────────────── */
      .ytp-btn--copy {
        border-radius: 18px 0 0 18px;
        padding-right: 12px;
      }

      /* ── Settings button (right pill) ──────────────────────── */
      .ytp-btn--settings {
        border-radius: 0 18px 18px 0;
        padding: 0 10px;
        border-left: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.12));
      }

      @media (prefers-color-scheme: dark) {
        .ytp-btn--settings {
          border-left-color: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.15));
        }
      }

      .ytp-btn--settings svg {
        width: 20px;
        height: 20px;
        fill: currentColor;
      }

      /* ── Modal overlay ─────────────────────────────────────── */
      .ytp-modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 10000;
        display: flex;
        justify-content: center;
        align-items: center;
      }

      .ytp-modal {
        background: var(--yt-spec-base-background, #fff);
        color: var(--yt-spec-text-primary, #0f0f0f);
        border-radius: 12px;
        padding: 24px;
        width: 90%;
        max-width: 440px;
        max-height: 80vh;
        overflow-y: auto;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
        font-family: "Roboto", "Arial", sans-serif;
      }

      .ytp-modal h2 {
        margin: 0 0 20px;
        font-size: 18px;
      }

      /* ── Settings rows ─────────────────────────────────────── */
      .ytp-setting {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 0;
      }

      .ytp-setting label {
        font-size: 14px;
        cursor: pointer;
      }

      /* ── Toggle switch ─────────────────────────────────────── */
      .ytp-toggle {
        appearance: none;
        width: 40px;
        height: 20px;
        background: var(--yt-spec-badge-chip-background, #ccc);
        border-radius: 10px;
        position: relative;
        cursor: pointer;
        transition: background-color 0.2s;
        flex-shrink: 0;
      }

      .ytp-toggle::before {
        content: "";
        position: absolute;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #fff;
        top: 2px;
        left: 2px;
        transition: transform 0.2s;
      }

      .ytp-toggle:checked {
        background: #3ea6ff;
      }

      .ytp-toggle:checked::before {
        transform: translateX(20px);
      }

      /* ── Summarize button (middle pill) ──────────────────────── */
      .ytp-btn--summarize {
        border-radius: 0;
        padding: 0 12px;
        border-left: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.12));
      }

      @media (prefers-color-scheme: dark) {
        .ytp-btn--summarize {
          border-left-color: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.15));
        }
      }

      /* ── Settings section heading ────────────────────────────── */
      .ytp-section-heading {
        font-size: 13px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        opacity: 0.6;
        margin: 16px 0 8px;
        padding-top: 12px;
        border-top: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.12));
      }

      /* ── Form controls ───────────────────────────────────────── */
      .ytp-setting select,
      .ytp-setting input[type="text"],
      .ytp-setting input[type="password"] {
        font-size: 13px;
        font-family: "Roboto", "Arial", sans-serif;
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.2));
        background: var(--yt-spec-base-background, #fff);
        color: var(--yt-spec-text-primary, #0f0f0f);
        outline: none;
        min-width: 160px;
      }

      .ytp-setting select:focus,
      .ytp-setting input[type="text"]:focus,
      .ytp-setting input[type="password"]:focus {
        border-color: #3ea6ff;
      }

      .ytp-setting textarea {
        font-size: 13px;
        font-family: "Roboto", "Arial", sans-serif;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.2));
        background: var(--yt-spec-base-background, #fff);
        color: var(--yt-spec-text-primary, #0f0f0f);
        outline: none;
        width: 100%;
        min-height: 80px;
        resize: vertical;
        box-sizing: border-box;
      }

      .ytp-setting textarea:focus {
        border-color: #3ea6ff;
      }

      .ytp-setting--full {
        flex-direction: column;
        align-items: stretch;
        gap: 6px;
      }

      .ytp-model-row {
        display: flex;
        gap: 6px;
        align-items: center;
      }

      .ytp-model-row select {
        flex: 1;
      }

      .ytp-refresh-btn {
        background: none;
        border: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.2));
        border-radius: 8px;
        padding: 5px 8px;
        cursor: pointer;
        color: var(--yt-spec-text-primary, #0f0f0f);
        font-size: 14px;
        line-height: 1;
      }

      .ytp-refresh-btn:hover {
        background: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, 0.06));
      }

      .ytp-refresh-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }

      /* ── Summary display panel ───────────────────────────────── */
      #ytp-summary-panel {
        margin: 12px 0;
        padding: 16px;
        border-radius: 12px;
        background: var(--yt-spec-base-background, #fff);
        color: var(--yt-spec-text-primary, #0f0f0f);
        border: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.12));
        font-family: "Roboto", "Arial", sans-serif;
        font-size: 14px;
        line-height: 1.6;
        position: relative;
      }

      #ytp-summary-panel .ytp-summary-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }

      #ytp-summary-panel .ytp-summary-header h3 {
        margin: 0;
        font-size: 16px;
      }

      #ytp-summary-panel .ytp-summary-close {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 20px;
        color: var(--yt-spec-text-primary, #0f0f0f);
        opacity: 0.7;
        padding: 4px 8px;
      }

      #ytp-summary-panel .ytp-summary-close:hover {
        opacity: 1;
      }

      #ytp-summary-panel .ytp-summary-content {
        overflow-wrap: break-word;
      }

      #ytp-summary-panel .ytp-summary-content h1,
      #ytp-summary-panel .ytp-summary-content h2,
      #ytp-summary-panel .ytp-summary-content h3,
      #ytp-summary-panel .ytp-summary-content h4 {
        margin: 14px 0 6px;
      }

      #ytp-summary-panel .ytp-summary-content h1 { font-size: 18px; }
      #ytp-summary-panel .ytp-summary-content h2 { font-size: 16px; }
      #ytp-summary-panel .ytp-summary-content h3 { font-size: 15px; }
      #ytp-summary-panel .ytp-summary-content h4 { font-size: 14px; font-weight: 600; }

      #ytp-summary-panel .ytp-summary-content ul,
      #ytp-summary-panel .ytp-summary-content ol {
        margin: 8px 0;
        padding-left: 24px;
      }

      #ytp-summary-panel .ytp-summary-content li {
        margin: 3px 0;
      }

      #ytp-summary-panel .ytp-summary-content p {
        margin: 8px 0;
      }

      #ytp-summary-panel .ytp-summary-content a {
        color: #3ea6ff;
        text-decoration: none;
      }

      #ytp-summary-panel .ytp-summary-content a:hover {
        text-decoration: underline;
      }

      #ytp-summary-panel .ytp-summary-content table {
        width: 100%;
        border-collapse: collapse;
        margin: 12px 0;
        font-size: 13px;
      }

      #ytp-summary-panel .ytp-summary-content th,
      #ytp-summary-panel .ytp-summary-content td {
        border: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.15));
        padding: 8px 10px;
        text-align: left;
      }

      #ytp-summary-panel .ytp-summary-content th {
        background: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, 0.06));
        font-weight: 600;
      }

      #ytp-summary-panel .ytp-summary-content blockquote {
        margin: 10px 0;
        padding: 4px 14px;
        border-left: 3px solid #3ea6ff;
        background: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, 0.03));
      }

      #ytp-summary-panel .ytp-summary-content blockquote p {
        margin: 4px 0;
      }

      #ytp-summary-panel .ytp-summary-content hr {
        border: none;
        border-top: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.12));
        margin: 14px 0;
      }

      #ytp-summary-panel .ytp-summary-content pre {
        background: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, 0.06));
        padding: 12px;
        border-radius: 8px;
        overflow-x: auto;
        margin: 10px 0;
      }

      #ytp-summary-panel .ytp-summary-content code {
        font-family: "Consolas", "Monaco", monospace;
        font-size: 12px;
      }

      #ytp-summary-panel .ytp-summary-content p code,
      #ytp-summary-panel .ytp-summary-content li code {
        background: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, 0.06));
        padding: 1px 5px;
        border-radius: 4px;
        font-size: 12px;
      }

      /* ── Collapsible content ─────────────────────────────────── */
      #ytp-summary-panel .ytp-summary-content.ytp-collapsed {
        max-height: 400px;
        overflow: hidden;
        position: relative;
      }

      #ytp-summary-panel .ytp-summary-content.ytp-collapsed::after {
        content: "";
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: 80px;
        background: linear-gradient(transparent, var(--yt-spec-base-background, #fff));
        pointer-events: none;
      }

      #ytp-summary-panel .ytp-expand-btn {
        display: block;
        width: 100%;
        padding: 8px 0;
        margin-top: 4px;
        border: none;
        background: none;
        color: #3ea6ff;
        font-size: 13px;
        font-family: "Roboto", "Arial", sans-serif;
        font-weight: 500;
        cursor: pointer;
        text-align: center;
      }

      #ytp-summary-panel .ytp-expand-btn:hover {
        text-decoration: underline;
      }

      /* ── Icon buttons in header ──────────────────────────────── */
      #ytp-summary-panel .ytp-summary-close svg {
        width: 18px;
        height: 18px;
        fill: currentColor;
        vertical-align: middle;
      }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function safeSetSVG(el, svgString) {
    const doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
    el.replaceChildren(document.adoptNode(doc.documentElement));
  }

  function safeSetHTML(el, htmlString) {
    const doc = new DOMParser().parseFromString(htmlString, "text/html");
    const frag = document.createDocumentFragment();
    while (doc.body.firstChild) frag.appendChild(document.adoptNode(doc.body.firstChild));
    el.replaceChildren(frag);
  }

  function waitForElement(selector, timeout = 6000) {
    return new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);

      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  function findTarget() {
    const selectors = [
      "#owner #subscribe-button",
      "#subscribe-button",
      "ytd-subscribe-button-renderer",
      "#owner .ytd-video-owner-renderer",
      "#owner",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Button injection
  // ---------------------------------------------------------------------------

  async function injectButton() {
    if (document.getElementById(CONTAINER_ID)) {
      isInjected = true;
      return true;
    }

    const target =
      (await waitForElement("#owner #subscribe-button", 8000)) ||
      findTarget();

    if (!target?.parentNode) return false;

    injectStyles();

    const container = document.createElement("div");
    container.id = CONTAINER_ID;
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", "Transcript tools");

    // Copy button
    const copyBtn = document.createElement("button");
    copyBtn.className = "ytp-btn ytp-btn--copy";
    copyBtn.textContent = "Transcript";
    copyBtn.type = "button";
    copyBtn.setAttribute("aria-label", "Copy video transcript");
    copyBtn.addEventListener("click", handleCopy);

    // Settings button
    const settingsBtn = document.createElement("button");
    settingsBtn.className = "ytp-btn ytp-btn--settings";
    settingsBtn.type = "button";
    settingsBtn.title = "Transcript settings";
    settingsBtn.setAttribute("aria-label", "Transcript settings");
    settingsBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.49.49 0 0 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65zM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5z"/></svg>`;
    settingsBtn.addEventListener("click", openSettingsModal);

    // Summarize button
    const summarizeBtn = document.createElement("button");
    summarizeBtn.className = "ytp-btn ytp-btn--summarize";
    summarizeBtn.textContent = "Summarize";
    summarizeBtn.type = "button";
    summarizeBtn.setAttribute("aria-label", "Summarize video with AI");
    summarizeBtn.addEventListener("click", handleSummarize);

    container.append(copyBtn, summarizeBtn, settingsBtn);
    target.parentNode.insertBefore(container, target.nextSibling);

    // Watch for removal so we can re-inject on next check
    if (protectionObserver) protectionObserver.disconnect();
    protectionObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.removedNodes) {
          if (node === container || node.contains?.(container)) {
            isInjected = false;
          }
        }
      }
    });
    protectionObserver.observe(target.parentNode, { childList: true });

    isInjected = true;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Settings modal
  // ---------------------------------------------------------------------------

  function openSettingsModal() {
    if (document.querySelector(".ytp-modal-overlay")) return;

    const overlay = document.createElement("div");
    overlay.className = "ytp-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "ytp-modal";
    modal.innerHTML = `
      <h2>Settings</h2>
      <div class="ytp-section-heading" style="margin-top:0;padding-top:0;border-top:none;">Transcript</div>
      <div class="ytp-setting">
        <label for="ytp-includeTitle">Include video title</label>
        <input type="checkbox" id="ytp-includeTitle" class="ytp-toggle">
      </div>
      <div class="ytp-setting">
        <label for="ytp-includeUrl">Include video URL</label>
        <input type="checkbox" id="ytp-includeUrl" class="ytp-toggle">
      </div>
      <div class="ytp-setting">
        <label for="ytp-includeTimestamps">Include timestamps</label>
        <input type="checkbox" id="ytp-includeTimestamps" class="ytp-toggle">
      </div>
      <div class="ytp-setting">
        <label for="ytp-useParagraphs">Single paragraph (no timestamps)</label>
        <input type="checkbox" id="ytp-useParagraphs" class="ytp-toggle">
      </div>
      <div class="ytp-setting">
        <label for="ytp-copyAsMarkdown">Copy as Markdown</label>
        <input type="checkbox" id="ytp-copyAsMarkdown" class="ytp-toggle">
      </div>
      <div class="ytp-section-heading">AI Summary</div>
      <div class="ytp-setting">
        <label for="ytp-aiProvider">Provider</label>
        <select id="ytp-aiProvider">
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="google">Google Gemini</option>
          <option value="groq">Groq</option>
          <option value="openrouter">OpenRouter</option>
        </select>
      </div>
      <div class="ytp-setting">
        <label for="ytp-aiApiKey">API Key</label>
        <input type="password" id="ytp-aiApiKey" placeholder="Enter API key" autocomplete="off">
      </div>
      <div class="ytp-setting">
        <label for="ytp-aiModel">Model</label>
        <div class="ytp-model-row">
          <select id="ytp-aiModel">
            <option value="">Default</option>
          </select>
          <button type="button" class="ytp-refresh-btn" id="ytp-refreshModels" title="Refresh models">\u21BB</button>
        </div>
      </div>
      <div class="ytp-setting">
        <label for="ytp-summaryOutput">Summary output</label>
        <select id="ytp-summaryOutput">
          <option value="clipboard">Copy to clipboard</option>
          <option value="display">Display on page</option>
        </select>
      </div>
      <div class="ytp-setting ytp-setting--full">
        <label for="ytp-summarySystemPrompt">System prompt</label>
        <textarea id="ytp-summarySystemPrompt" rows="4"></textarea>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Close on backdrop click
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // Close on Escape
    function onKey(e) {
      if (e.key === "Escape") {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
      }
    }
    document.addEventListener("keydown", onKey);

    // Load current values
    getSettings().then((s) => {
      document.getElementById("ytp-includeTitle").checked = s.includeTitle;
      document.getElementById("ytp-includeUrl").checked = s.includeUrl;
      document.getElementById("ytp-includeTimestamps").checked = s.includeTimestamps;
      document.getElementById("ytp-useParagraphs").checked = s.useParagraphs;
      document.getElementById("ytp-copyAsMarkdown").checked = s.copyAsMarkdown;
      document.getElementById("ytp-aiProvider").value = s.aiProvider;
      document.getElementById("ytp-aiApiKey").value = s.aiApiKey;
      document.getElementById("ytp-summaryOutput").value = s.summaryOutput;
      document.getElementById("ytp-summarySystemPrompt").value =
        s.summarySystemPrompt;
      populateModelDropdown(s.aiProvider, s.aiApiKey, s.aiModel);
    });

    // Populate model dropdown from provider API
    async function populateModelDropdown(provider, apiKey, currentModel) {
      const select = document.getElementById("ytp-aiModel");
      const refreshBtn = document.getElementById("ytp-refreshModels");
      if (!select) return;

      select.textContent = "";
      const defaultOpt = document.createElement("option");
      defaultOpt.value = "";
      defaultOpt.textContent = `Default (${DEFAULT_MODELS[provider] || ""})`;
      select.appendChild(defaultOpt);

      if (!apiKey) return;

      if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = "\u2026";
      }

      try {
        const models = await fetchAvailableModels(provider, apiKey);
        for (const m of models) {
          const opt = document.createElement("option");
          opt.value = m;
          opt.textContent = m;
          if (m === currentModel) opt.selected = true;
          select.appendChild(opt);
        }
        if (currentModel && !models.includes(currentModel)) {
          const opt = document.createElement("option");
          opt.value = currentModel;
          opt.textContent = currentModel;
          opt.selected = true;
          select.appendChild(opt);
        }
      } catch { /* silently fail */ }

      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "\u21BB";
      }
    }

    // Refresh button
    document.getElementById("ytp-refreshModels")?.addEventListener("click", () => {
      const provider = document.getElementById("ytp-aiProvider").value;
      const apiKey = document.getElementById("ytp-aiApiKey").value;
      const current = document.getElementById("ytp-aiModel").value;
      delete modelCache[`${provider}:${apiKey.slice(0, 8)}`];
      populateModelDropdown(provider, apiKey, current);
    });

    // Collect all settings from the modal and persist
    function collectAndSave() {
      saveSettings({
        includeTitle: document.getElementById("ytp-includeTitle").checked,
        includeUrl: document.getElementById("ytp-includeUrl").checked,
        includeTimestamps: document.getElementById("ytp-includeTimestamps").checked,
        useParagraphs: document.getElementById("ytp-useParagraphs").checked,
        copyAsMarkdown: document.getElementById("ytp-copyAsMarkdown").checked,
        aiProvider: document.getElementById("ytp-aiProvider").value,
        aiApiKey: document.getElementById("ytp-aiApiKey").value,
        aiModel: document.getElementById("ytp-aiModel").value,
        summaryOutput: document.getElementById("ytp-summaryOutput").value,
        summarySystemPrompt: document.getElementById("ytp-summarySystemPrompt").value,
      });
    }

    // Persist on change
    modal.addEventListener("change", (e) => {
      // Timestamps and paragraph are mutually exclusive
      if (e.target.id === "ytp-useParagraphs" && e.target.checked) {
        document.getElementById("ytp-includeTimestamps").checked = false;
      } else if (e.target.id === "ytp-includeTimestamps" && e.target.checked) {
        document.getElementById("ytp-useParagraphs").checked = false;
      }

      // Re-populate model dropdown when provider or API key changes
      if (e.target.id === "ytp-aiProvider") {
        const provider = e.target.value;
        const apiKey = document.getElementById("ytp-aiApiKey").value;
        populateModelDropdown(provider, apiKey, "");
      }

      collectAndSave();
    });

    // Also persist text/password inputs on typing
    let apiKeyDebounce = null;
    modal.addEventListener("input", (e) => {
      if (e.target.matches("input[type=password], textarea")) {
        collectAndSave();
      }

      // Re-fetch models when API key changes (debounced)
      if (e.target.id === "ytp-aiApiKey") {
        clearTimeout(apiKeyDebounce);
        apiKeyDebounce = setTimeout(() => {
          const provider = document.getElementById("ytp-aiProvider").value;
          populateModelDropdown(provider, e.target.value, "");
        }, 800);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Copy handler
  // ---------------------------------------------------------------------------

  async function handleCopy() {
    const btn = document.querySelector(`#${CONTAINER_ID} .ytp-btn--copy`);
    btn.textContent = "Fetching…";
    btn.disabled = true;

    try {
      const data = await fetchTranscript(location.href);
      if (!data?.transcript?.length) throw new Error("Transcript unavailable.");

      const settings = await getSettings();
      const text = settings.copyAsMarkdown
        ? formatMarkdown(data, settings)
        : formatPlainText(data, settings);

      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied!";
    } catch (err) {
      btn.textContent = "Error";
      console.error("[YT Transcript & Summary]", err);
      alert(`Could not copy transcript: ${err.message}`);
    } finally {
      setTimeout(() => {
        btn.textContent = "Transcript";
        btn.disabled = false;
      }, 2000);
    }
  }

  // ---------------------------------------------------------------------------
  // Formatters
  // ---------------------------------------------------------------------------

  function cleanUrl() {
    return location.href.split("&t=")[0];
  }

  function formatPlainText({ title, transcript }, settings) {
    const lines = [];
    if (settings.includeTitle) lines.push(`Title: ${title}`);
    if (settings.includeUrl) lines.push(`URL: ${cleanUrl()}`);
    if (lines.length) lines.push("");

    if (settings.useParagraphs) {
      lines.push(transcript.map(([, text]) => text).join(" "));
    } else {
      for (const [ts, text] of transcript) {
        lines.push(settings.includeTimestamps ? `(${ts}) ${text}` : text);
      }
    }
    return lines.join("\n").trim();
  }

  function formatMarkdown({ title, transcript }, settings) {
    const lines = [];
    if (settings.includeTitle) lines.push(`# ${title}`);
    if (settings.includeUrl) lines.push(`[Watch on YouTube](${cleanUrl()})`);
    if (lines.length) lines.push("");

    if (settings.useParagraphs) {
      lines.push(transcript.map(([, text]) => text).join(" "));
    } else if (settings.includeTimestamps) {
      // Table format for timestamped markdown
      lines.push("| Time | Text |");
      lines.push("| --- | --- |");
      for (const [ts, text] of transcript) {
        // Escape pipe chars inside text
        lines.push(`| ${ts} | ${text.replace(/\|/g, "\\|")} |`);
      }
    } else {
      // One line per segment, separated by double newlines for readability
      lines.push(transcript.map(([, text]) => text).join("\n\n"));
    }
    return lines.join("\n").trim();
  }

  // ---------------------------------------------------------------------------
  // AI summary
  // ---------------------------------------------------------------------------

  async function handleSummarize() {
    const btn = document.querySelector(`#${CONTAINER_ID} .ytp-btn--summarize`);
    btn.textContent = "Summarizing\u2026";
    btn.disabled = true;

    try {
      const settings = await getSettings();

      if (!settings.aiApiKey) {
        throw new Error(
          "Please configure your API key in settings before summarizing."
        );
      }

      const data = await fetchTranscript(location.href);
      if (!data?.transcript?.length) throw new Error("Transcript unavailable.");

      const description = getVideoDescription();
      const transcriptText = data.transcript
        .map(([, text]) => text)
        .join(" ");

      const userPrompt = [
        `Video Title: ${data.title}`,
        "",
        "Video Description:",
        description || "(No description available)",
        "",
        "Transcript:",
        transcriptText,
      ].join("\n");

      const summary = await callAiProvider(
        settings.aiProvider,
        settings.aiApiKey,
        settings.aiModel,
        settings.summarySystemPrompt,
        userPrompt
      );

      if (settings.summaryOutput === "display") {
        displaySummaryPanel(summary);
        btn.textContent = "Summarize";
        btn.disabled = false;
      } else {
        await navigator.clipboard.writeText(summary);
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = "Summarize";
          btn.disabled = false;
        }, 2000);
      }
    } catch (err) {
      console.error("[YT Transcript & Summary]", err);
      alert(`Could not summarize: ${err.message}`);
      btn.textContent = "Summarize";
      btn.disabled = false;
    }
  }

  function getVideoDescription() {
    const selectors = [
      "#description-inline-expander yt-attributed-string",
      "#description-inline-expander .yt-core-attributed-string",
      "#description .yt-core-attributed-string",
      "ytd-text-inline-expander .yt-core-attributed-string",
      "#description yt-formatted-string",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) return el.textContent.trim();
    }
    return "";
  }

  async function callAiProvider(provider, apiKey, model, systemPrompt, userPrompt) {
    const resolvedModel = model || DEFAULT_MODELS[provider] || "";

    switch (provider) {
      case "openai":
        return callOpenAI(apiKey, resolvedModel, systemPrompt, userPrompt);
      case "anthropic":
        return callAnthropic(apiKey, resolvedModel, systemPrompt, userPrompt);
      case "google":
        return callGoogle(apiKey, resolvedModel, systemPrompt, userPrompt);
      case "groq":
        return callOpenAICompat(
          "https://api.groq.com/openai/v1/chat/completions",
          apiKey, resolvedModel, systemPrompt, userPrompt, "Groq"
        );
      case "openrouter":
        return callOpenAICompat(
          "https://openrouter.ai/api/v1/chat/completions",
          apiKey, resolvedModel, systemPrompt, userPrompt, "OpenRouter"
        );
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  async function callOpenAI(apiKey, model, systemPrompt, userPrompt) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `OpenAI API error: ${res.status}`);
    }
    const json = await res.json();
    return json.choices?.[0]?.message?.content || "";
  }

  async function callAnthropic(apiKey, model, systemPrompt, userPrompt) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        err.error?.message || `Anthropic API error: ${res.status}`
      );
    }
    const json = await res.json();
    return json.content?.[0]?.text || "";
  }

  async function callGoogle(apiKey, model, systemPrompt, userPrompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        err.error?.message || `Google API error: ${res.status}`
      );
    }
    const json = await res.json();
    return json.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  async function callOpenAICompat(endpoint, apiKey, model, systemPrompt, userPrompt, label) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `${label} API error: ${res.status}`);
    }
    const json = await res.json();
    return json.choices?.[0]?.message?.content || "";
  }

  // ---------------------------------------------------------------------------
  // Model fetching
  // ---------------------------------------------------------------------------

  async function fetchAvailableModels(provider, apiKey, forceRefresh = false) {
    if (!apiKey) return [];
    const cacheKey = `${provider}:${apiKey.slice(0, 8)}`;
    if (!forceRefresh && modelCache[cacheKey]) return modelCache[cacheKey];

    let models = [];
    try {
      switch (provider) {
        case "openai":
          models = await fetchOpenAIModels(apiKey);
          break;
        case "anthropic":
          models = await fetchAnthropicModels(apiKey);
          break;
        case "google":
          models = await fetchGoogleModels(apiKey);
          break;
        case "groq":
          models = await fetchOpenAICompatModels(
            "https://api.groq.com/openai/v1/models", apiKey,
            (m) => m.active !== false && (m.context_window || 0) > 1000
          );
          break;
        case "openrouter":
          models = await fetchOpenAICompatModels(
            "https://openrouter.ai/api/v1/models", apiKey
          );
          break;
      }
    } catch { /* return empty */ }

    if (models.length) modelCache[cacheKey] = models;
    return models;
  }

  async function fetchOpenAIModels(apiKey) {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data || [])
      .map((m) => m.id)
      .filter((id) => /^(gpt-|o[1-9]|chatgpt-)/.test(id))
      .sort();
  }

  async function fetchAnthropicModels(apiKey) {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data || [])
      .map((m) => m.id)
      .filter((id) => /^claude-/.test(id))
      .sort((a, b) => b.localeCompare(a)); // newest first
  }

  async function fetchGoogleModels(apiKey) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );
    if (!res.ok) return [];
    const json = await res.json();
    return (json.models || [])
      .filter((m) =>
        m.supportedGenerationMethods?.includes("generateContent")
      )
      .map((m) => m.name.replace("models/", ""))
      .sort();
  }

  async function fetchOpenAICompatModels(endpoint, apiKey, filterFn) {
    const res = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const json = await res.json();
    let models = json.data || [];
    if (filterFn) models = models.filter(filterFn);
    return models.map((m) => m.id).sort();
  }

  // ---------------------------------------------------------------------------
  // Summary display panel
  // ---------------------------------------------------------------------------

  function displaySummaryPanel(markdown) {
    document.getElementById("ytp-summary-panel")?.remove();

    const panel = document.createElement("div");
    panel.id = "ytp-summary-panel";

    const header = document.createElement("div");
    header.className = "ytp-summary-header";
    header.innerHTML = "<h3>AI Summary</h3>";

    const headerActions = document.createElement("div");
    headerActions.style.cssText = "display:flex;gap:4px;align-items:center;";

    const copySvg = '<svg viewBox="0 0 24 24"><path d="M16 1H4C2.9 1 2 1.9 2 3v14h2V3h12V1zm3 4H8C6.9 5 6 5.9 6 7v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
    const checkSvg = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>';

    const copyIconBtn = document.createElement("button");
    copyIconBtn.className = "ytp-summary-close";
    safeSetSVG(copyIconBtn, copySvg);
    copyIconBtn.title = "Copy summary as Markdown";
    copyIconBtn.setAttribute("aria-label", "Copy summary as Markdown");
    copyIconBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(markdown);
      safeSetSVG(copyIconBtn, checkSvg);
      setTimeout(() => { safeSetSVG(copyIconBtn, copySvg); }, 1500);
    });

    const closeBtn = document.createElement("button");
    closeBtn.className = "ytp-summary-close";
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>';
    closeBtn.setAttribute("aria-label", "Close summary");
    closeBtn.addEventListener("click", () => panel.remove());

    headerActions.append(copyIconBtn, closeBtn);
    header.appendChild(headerActions);

    const content = document.createElement("div");
    content.className = "ytp-summary-content";
    safeSetHTML(content, renderMarkdownToHtml(markdown));

    panel.append(header, content);

    // Insert into #primary so it spans full width above recommendations
    const primary = document.querySelector("#primary, #primary-inner");
    const below = document.querySelector("#below");
    if (primary && below && below.parentNode === primary) {
      primary.insertBefore(panel, below);
    } else if (below) {
      below.insertBefore(panel, below.firstChild);
    } else if (primary) {
      primary.appendChild(panel);
    }

    // Collapse if content is tall
    requestAnimationFrame(() => {
      if (content.scrollHeight > 500) {
        content.classList.add("ytp-collapsed");

        const expandBtn = document.createElement("button");
        expandBtn.className = "ytp-expand-btn";
        expandBtn.textContent = "Show full summary";
        expandBtn.addEventListener("click", () => {
          const isCollapsed = content.classList.toggle("ytp-collapsed");
          expandBtn.textContent = isCollapsed
            ? "Show full summary"
            : "Show less";
        });
        content.insertAdjacentElement("afterend", expandBtn);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Full-featured Markdown → HTML renderer
  // ---------------------------------------------------------------------------

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function inlineFormat(text) {
    return text
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%">')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/___(.+?)___/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__(.+?)__/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/_([^_]+)_/g, "<em>$1</em>")
      .replace(/~~(.+?)~~/g, "<del>$1</del>");
  }

  function parseTableRow(line) {
    return line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  }

  function isTableSeparator(line) {
    return /^\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?$/.test(line);
  }

  function renderMarkdownToHtml(md) {
    const lines = md.split("\n");
    const result = [];
    let i = 0;

    function closeList() {
      if (listStack.length) {
        while (listStack.length) result.push(`</${listStack.pop()}>`);
      }
    }

    const listStack = [];
    let inCodeBlock = false;
    let codeLang = "";
    const codeLines = [];
    let inBlockquote = false;
    const bqLines = [];

    while (i < lines.length) {
      const line = lines[i];

      // ── Code blocks ──
      if (line.startsWith("```")) {
        if (inCodeBlock) {
          result.push(
            `<pre><code${codeLang ? ` class="language-${codeLang}"` : ""}>${codeLines.splice(0).join("\n")}</code></pre>`
          );
          inCodeBlock = false;
          codeLang = "";
        } else {
          closeList();
          if (inBlockquote) {
            result.push(renderMarkdownToHtml(bqLines.splice(0).join("\n")));
            result.push("</blockquote>");
            inBlockquote = false;
          }
          inCodeBlock = true;
          codeLang = line.slice(3).trim();
        }
        i++;
        continue;
      }
      if (inCodeBlock) {
        codeLines.push(escapeHtml(line));
        i++;
        continue;
      }

      // ── Blockquotes ──
      if (/^>\s?/.test(line)) {
        closeList();
        if (!inBlockquote) {
          result.push("<blockquote>");
          inBlockquote = true;
        }
        bqLines.push(line.replace(/^>\s?/, ""));
        i++;
        continue;
      } else if (inBlockquote) {
        result.push(renderMarkdownToHtml(bqLines.splice(0).join("\n")));
        result.push("</blockquote>");
        inBlockquote = false;
      }

      // ── Horizontal rules ──
      if (/^([-*_]){3,}\s*$/.test(line.trim())) {
        closeList();
        result.push("<hr>");
        i++;
        continue;
      }

      // ── Tables ──
      if (
        line.includes("|") &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1])
      ) {
        closeList();
        const headers = parseTableRow(line);
        const sepCells = parseTableRow(lines[i + 1]);
        const aligns = sepCells.map((c) => {
          if (c.startsWith(":") && c.endsWith(":")) return "center";
          if (c.endsWith(":")) return "right";
          return "left";
        });
        i += 2;

        let table = "<table><thead><tr>";
        for (let h = 0; h < headers.length; h++) {
          const a = aligns[h] || "left";
          table += `<th style="text-align:${a}">${inlineFormat(escapeHtml(headers[h]))}</th>`;
        }
        table += "</tr></thead><tbody>";

        while (i < lines.length && lines[i].includes("|")) {
          const cells = parseTableRow(lines[i]);
          table += "<tr>";
          for (let c = 0; c < headers.length; c++) {
            const a = aligns[c] || "left";
            const val = cells[c] != null ? cells[c] : "";
            table += `<td style="text-align:${a}">${inlineFormat(escapeHtml(val))}</td>`;
          }
          table += "</tr>";
          i++;
        }
        table += "</tbody></table>";
        result.push(table);
        continue;
      }

      const escaped = escapeHtml(line);

      // ── Headers ──
      const headerMatch = escaped.match(/^(#{1,6})\s+(.+)$/);
      if (headerMatch) {
        closeList();
        const lvl = headerMatch[1].length;
        result.push(`<h${lvl}>${inlineFormat(headerMatch[2])}</h${lvl}>`);
        i++;
        continue;
      }

      // ── Task list items ──
      const taskMatch = escaped.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.+)$/);
      if (taskMatch) {
        if (!listStack.length || listStack[listStack.length - 1] !== "ul") {
          if (listStack.length) result.push(`</${listStack.pop()}>`);
          result.push("<ul>");
          listStack.push("ul");
        }
        const checked = taskMatch[2] !== " " ? " checked disabled" : " disabled";
        result.push(
          `<li><input type="checkbox"${checked}> ${inlineFormat(taskMatch[3])}</li>`
        );
        i++;
        continue;
      }

      // ── Unordered list ──
      if (/^\s*[-*+]\s+/.test(escaped)) {
        if (!listStack.length || listStack[listStack.length - 1] !== "ul") {
          if (listStack.length) result.push(`</${listStack.pop()}>`);
          result.push("<ul>");
          listStack.push("ul");
        }
        result.push(
          `<li>${inlineFormat(escaped.replace(/^\s*[-*+]\s+/, ""))}</li>`
        );
        i++;
        continue;
      }

      // ── Ordered list ──
      const olMatch = escaped.match(/^\s*\d+[.)]\s+(.+)$/);
      if (olMatch) {
        if (!listStack.length || listStack[listStack.length - 1] !== "ol") {
          if (listStack.length) result.push(`</${listStack.pop()}>`);
          result.push("<ol>");
          listStack.push("ol");
        }
        result.push(`<li>${inlineFormat(olMatch[1])}</li>`);
        i++;
        continue;
      }

      // Close any open list before non-list content
      closeList();

      // ── Blank lines ──
      if (!escaped.trim()) {
        i++;
        continue;
      }

      // ── Paragraph ──
      result.push(`<p>${inlineFormat(escaped)}</p>`);
      i++;
    }

    // Cleanup
    closeList();
    if (inBlockquote) {
      result.push(renderMarkdownToHtml(bqLines.splice(0).join("\n")));
      result.push("</blockquote>");
    }
    if (inCodeBlock) {
      result.push(
        `<pre><code>${codeLines.splice(0).join("\n")}</code></pre>`
      );
    }

    return result.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Transcript fetching (API first → DOM scrape fallback)
  // ---------------------------------------------------------------------------

  async function fetchTranscript(videoUrl) {
    const { title, ytData } = resolvePageData(videoUrl);
    const segments = await getSegments(ytData);
    if (!segments?.length) throw new Error("No transcript segments found.");

    const transcript = segments.map(parseSegment);
    return { title, transcript };
  }

  function resolvePageData(videoUrl) {
    let ytData = window.ytInitialData;

    if (!ytData) {
      for (const script of document.getElementsByTagName("script")) {
        if (script.textContent.includes("var ytInitialData =")) {
          ytData = extractJsonVar(script.textContent, "ytInitialData");
          if (ytData) break;
        }
      }
    }

    const title =
      document.querySelector("#title h1")?.textContent?.trim() ||
      document.querySelector("h1.ytd-watch-metadata")?.textContent?.trim() ||
      ytData?.videoDetails?.title ||
      document.querySelector('meta[name="title"]')?.content ||
      document.title.replace(" - YouTube", "") ||
      "Unknown Title";

    return { title, ytData };
  }

  function parseSegment(item) {
    const seg = item?.transcriptSegmentRenderer;
    if (!seg) return ["", ""];
    const ts = seg.startTimeText?.simpleText || "";
    const text = seg.snippet?.runs?.map((r) => r.text).join("") || "";
    return [ts, text];
  }

  // ---------------------------------------------------------------------------
  // Strategy 1 – YouTube internal API
  // ---------------------------------------------------------------------------

  async function getSegments(ytData) {
    const items = await fetchFromApi(ytData);
    if (items?.length) return items;
    return scrapeTranscriptDOM();
  }

  async function fetchFromApi(ytData) {
    try {
      const stringified = JSON.stringify(ytData);
      const paramMatch = stringified.match(
        /"getTranscriptEndpoint":\s*{\s*"params":\s*"([^"]+)"/
      );
      if (!paramMatch) return null;

      const apiKey = document.documentElement.innerHTML.match(
        /"INNERTUBE_API_KEY":"([^"]+)"/
      )?.[1];
      const clientVersion =
        document.documentElement.innerHTML.match(
          /"clientVersion":"([^"]+)"/
        )?.[1] || "2.20260306.01.00";

      if (!apiKey) return null;

      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            context: {
              client: {
                clientName: "WEB",
                clientVersion,
                hl: "en",
                gl: "US",
                userAgent: navigator.userAgent,
              },
            },
            params: paramMatch[1],
          }),
        }
      );

      if (!res.ok) return null;

      const json = await res.json();
      const items =
        json.actions?.[0]?.updateEngagementPanelAction?.content
          ?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body
          ?.transcriptSegmentListRenderer?.initialSegments;

      return items?.length ? items : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Strategy 2 – DOM scraping
  // ---------------------------------------------------------------------------

  async function scrapeTranscriptDOM() {
    // Expand description if needed
    const expander = document.querySelector(
      "tp-yt-paper-button#expand, #expand-theme, #description-inline-expander"
    );
    if (expander?.offsetParent) {
      expander.click();
      await delay(400);
    }

    // Click "Show transcript"
    const btnSelectors = [
      'button[aria-label*="show transcript" i]',
      "ytd-video-description-transcript-section-renderer button",
      "#primary-button button",
    ];
    let showBtn = null;
    for (const sel of btnSelectors) {
      showBtn = document.querySelector(sel);
      if (showBtn?.offsetParent) break;
    }
    if (!showBtn) return null;
    showBtn.click();

    const segmentSel =
      "ytd-transcript-segment-renderer, transcript-segment-view-model";
    if (!(await waitForElement(segmentSel, 10000))) return null;

    const segmentsMap = new Map();
    const scrollContainer =
      document.querySelector(
        'ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"] #content'
      ) ||
      document.querySelector(
        'ytd-engagement-panel-section-list-renderer[target-id*="transcript" i] #content'
      ) ||
      document.querySelector(segmentSel)?.closest("#content, #contents");

    let unchangedRuns = 0;
    let lastSize = 0;

    for (let i = 0; i < 150; i++) {
      for (const seg of document.querySelectorAll(segmentSel)) {
        const timestamp =
          seg.querySelector('.segment-timestamp, [class*="Timestamp"]')
            ?.textContent?.trim() || "";

        let text = "";
        const textEl = seg.querySelector(
          ".yt-core-attributed-string, .segment-text, yt-formatted-string"
        );
        if (textEl) {
          text = textEl.textContent.trim();
        } else {
          text = Array.from(seg.querySelectorAll("span"))
            .filter(
              (s) =>
                !s.className.includes("Timestamp") &&
                !s.className.includes("A11yLabel")
            )
            .map((s) => s.textContent)
            .join(" ")
            .trim();
        }

        if (text) segmentsMap.set(timestamp + text, { timestamp, text });
      }

      if (scrollContainer) {
        scrollContainer.scrollBy(0, 800);
      } else {
        const all = document.querySelectorAll(segmentSel);
        all[all.length - 1]?.scrollIntoView({ block: "end" });
      }

      await delay(250);

      if (segmentsMap.size === lastSize) {
        if (++unchangedRuns >= 4) break;
      } else {
        unchangedRuns = 0;
      }
      lastSize = segmentsMap.size;
    }

    // Close the transcript panel we opened
    closeTranscriptPanel();

    return Array.from(segmentsMap.values()).map((d) => ({
      transcriptSegmentRenderer: {
        startTimeText: { simpleText: d.timestamp },
        snippet: { runs: [{ text: d.text }] },
      },
    }));
  }

  function closeTranscriptPanel() {
    // Try clicking the close button on the transcript engagement panel
    const closeSelectors = [
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript" i] #visibility-button button',
      'ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"] #visibility-button button',
      'ytd-engagement-panel-title-header-renderer button[aria-label*="Close" i]',
      'ytd-engagement-panel-title-header-renderer button[aria-label*="close" i]',
    ];
    for (const sel of closeSelectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // JSON extraction helpers
  // ---------------------------------------------------------------------------

  function extractJsonVar(content, varName) {
    const prefix = `var ${varName} =`;
    const start = content.indexOf(prefix);
    if (start === -1) return null;

    const braceStart = content.indexOf("{", start);
    if (braceStart === -1) return null;

    let depth = 0;
    let inStr = false;
    let esc = false;

    for (let i = braceStart; i < content.length; i++) {
      const ch = content[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (!inStr) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(content.substring(braceStart, i + 1));
            } catch {
              return null;
            }
          }
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // URL change detection & lifecycle
  // ---------------------------------------------------------------------------

  function checkUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;

    document.getElementById(CONTAINER_ID)?.remove();
    document.getElementById("ytp-summary-panel")?.remove();
    if (protectionObserver) {
      protectionObserver.disconnect();
      protectionObserver = null;
    }

    isInjected = false;
    retryCount = 0;

    clearTimeout(urlChangeTimer);
    urlChangeTimer = setTimeout(init, 1000);
  }

  function setupObserver() {
    if (observer) observer.disconnect();

    let lastCheck = 0;

    observer = new MutationObserver(() => {
      checkUrlChange();

      const now = Date.now();
      if (now - lastCheck < 1000) return;
      lastCheck = now;

      if (!isInjected && findTarget()) {
        injectButton();
      }

      if (isInjected && !document.getElementById(CONTAINER_ID)) {
        isInjected = false;
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------------
  // Initialization with progressive retries
  // ---------------------------------------------------------------------------

  async function init() {
    if (await injectButton()) {
      retryCount = 0;
    }
    setupObserver();

    const timer = setInterval(async () => {
      if (isInjected || retryCount >= MAX_RETRIES) {
        clearInterval(timer);
        return;
      }
      retryCount++;
      if (await injectButton()) {
        clearInterval(timer);
        retryCount = 0;
      }
    }, 2000);
  }

  // Re-check when tab becomes visible
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !isInjected) setTimeout(init, 500);
  });

  // Periodic health check (every 30 s)
  setInterval(() => {
    if (isInjected && !document.getElementById(CONTAINER_ID)) {
      isInjected = false;
      init();
    }
  }, 30000);

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(init, 1200));
  } else {
    setTimeout(init, 1200);
  }
})();
