(function () {
  "use strict";

  if (window.__ytTranscriptProLoaded) return;
  window.__ytTranscriptProLoaded = true;

  // ---------------------------------------------------------------------------
  // Constants & defaults
  // ---------------------------------------------------------------------------

  const STORAGE_KEY = "yt-transcript-pro-settings";

  const DEFAULT_SETTINGS = {
    includeTitle: true,
    includeUrl: true,
    includeTimestamps: true,
    useParagraphs: false,
    copyAsMarkdown: false,
  };

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
  const CONTAINER_ID = "yt-transcript-pro-container";

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
    if (document.getElementById("yt-transcript-pro-styles")) return;

    const style = document.createElement("style");
    style.id = "yt-transcript-pro-styles";
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
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

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

    container.append(copyBtn, settingsBtn);
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
      <h2>Transcript Settings</h2>
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
    });

    // Persist on change
    modal.addEventListener("change", (e) => {
      let includeTimestamps = document.getElementById("ytp-includeTimestamps").checked;
      let useParagraphs = document.getElementById("ytp-useParagraphs").checked;

      // Timestamps and paragraph are mutually exclusive
      if (e.target.id === "ytp-useParagraphs" && useParagraphs) {
        includeTimestamps = false;
        document.getElementById("ytp-includeTimestamps").checked = false;
      } else if (e.target.id === "ytp-includeTimestamps" && includeTimestamps) {
        useParagraphs = false;
        document.getElementById("ytp-useParagraphs").checked = false;
      }

      saveSettings({
        includeTitle: document.getElementById("ytp-includeTitle").checked,
        includeUrl: document.getElementById("ytp-includeUrl").checked,
        includeTimestamps,
        useParagraphs,
        copyAsMarkdown: document.getElementById("ytp-copyAsMarkdown").checked,
      });
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
      console.error("[YT Transcript Pro]", err);
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

    return Array.from(segmentsMap.values()).map((d) => ({
      transcriptSegmentRenderer: {
        startTimeText: { simpleText: d.timestamp },
        snippet: { runs: [{ text: d.text }] },
      },
    }));
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
