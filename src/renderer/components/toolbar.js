/**
 * ═══════════════════════════════════════════════════════════════
 *  toolbar.js — Dome Browser  (Prompt 2: Core Navigation & Tab Logic)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Responsibility:
 *    All logic for the browser toolbar:
 *    - URL input bar: formatting, navigation, keyboard shortcuts
 *    - Back / Forward / Reload (Stop) buttons
 *    - URL scheme badge ("https" | "http" | "localhost" | etc.)
 *    - Visual loading state for the toolbar loader bar
 *
 *  Data flow:
 *    User types URL → formatUrl() → DomeTabs.navigateActiveTab()
 *    Webview navigates → DomeTabs fires event → setUrl() updates bar
 *
 *  URL Formatting Logic:
 *    Raw input is classified and transformed into a fully valid URL:
 *
 *      localhost:3000     → http://localhost:3000
 *      192.168.1.1        → http://192.168.1.1
 *      github.com/user    → https://github.com/user
 *      https://...        → (unchanged, already valid)
 *      "my search query"  → https://duckduckgo.com/?q=my+search+query
 *
 *  Exposed globally as: window.DomeToolbar
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

window.DomeToolbar = (() => {

  // ─── DOM References ─────────────────────────────────────────────────────────

  let _urlBar       = null;   // #url-bar         — the text input
  let _urlBarWrap   = null;   // .url-bar-wrap     — the bar's container (for focus ring)
  let _urlLoader    = null;   // .url-bar-loader   — the animated load progress line
  let _schemeEl     = null;   // .url-scheme       — the "https" prefix badge
  let _btnBack      = null;   // #btn-back
  let _btnForward   = null;   // #btn-forward
  let _btnReload    = null;   // #btn-reload

  /**
   * Tracks whether we're in a "loading" state so the Reload
   * button knows whether to reload or stop the current load.
   */
  let _isLoading = false;

  /**
   * Stores the last committed URL so Escape can revert the input.
   */
  let _committedUrl = '';

  // ─── SVG Icons for the Reload/Stop Toggle ────────────────────────────────────

  const SVG_RELOAD = `
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M13 3.5A7 7 0 1 0 14 8"/>
      <polyline points="10,1 14,3.5 11,7"/>
    </svg>`;

  const SVG_STOP = `
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round">
      <rect x="4" y="4" width="8" height="8" rx="1.5"/>
    </svg>`;

  // ─── URL Formatter ───────────────────────────────────────────────────────────

  /**
   * formatUrl(raw)
   * ──────────────
   * Transforms raw user input into a navigable URL.
   *
   * Classification order (first match wins):
   *   1. Already has a scheme (any://...)    → return as-is
   *   2. localhost with optional port/path   → prepend http://
   *   3. Private IP address                  → prepend http://
   *   4. Looks like a hostname (has a dot,
   *      no spaces)                          → prepend https://
   *   5. Anything else                       → DuckDuckGo search
   *
   * @param {string} raw — Raw text from the URL bar
   * @returns {string} Fully-formed URL
   */
  function formatUrl(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return null;

    // ── Rule 1: Already has a protocol scheme ──────────────────────────────
    // Matches: https://..., http://..., ftp://..., file://..., etc.
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) {
      return trimmed;
    }

    // ── Rule 2: localhost (with or without port and/or path) ───────────────
    // Matches: localhost, localhost:3000, localhost:5173/api/users
    if (/^localhost(:\d{1,5})?(\/.*)?$/.test(trimmed)) {
      return `http://${trimmed}`;
    }

    // ── Rule 3: IPv4 address ───────────────────────────────────────────────
    // Matches: 192.168.1.1, 10.0.0.1:8080
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(trimmed)) {
      return `http://${trimmed}`;
    }

    // ── Rule 4: Looks like a domain name ──────────────────────────────────
    // Must contain a dot, no spaces, TLD ≥ 2 chars.
    // Matches: github.com, example.co.uk, sub.domain.io/path
    if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(trimmed) && !trimmed.includes(' ')) {
      return `https://${trimmed}`;
    }

    // ── Rule 5: Search query ───────────────────────────────────────────────
    return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
  }

  // ─── Scheme Badge ────────────────────────────────────────────────────────────

  /**
   * Updates the scheme prefix badge to the left of the URL input.
   * The badge changes color based on the protocol (handled via CSS classes).
   *
   * @param {string} url — The current full URL
   */
  function _updateSchemeBadge(url) {
    if (!_schemeEl || !url) return;

    let scheme = 'https';
    try {
      scheme = new URL(url).protocol.replace(':', '');
    } catch (_) {
      // Malformed URL — show generic scheme
    }

    _schemeEl.textContent = scheme;

    // Toggle CSS classes for protocol-specific coloring
    _schemeEl.className = 'url-scheme'; // reset
    if (scheme === 'http')      _schemeEl.classList.add('scheme-http');
    if (scheme === 'localhost')  _schemeEl.classList.add('scheme-local');
    if (scheme === 'file')       _schemeEl.classList.add('scheme-file');
  }

  // ─── URL Bar Event Handlers ──────────────────────────────────────────────────

  /**
   * Called when the user presses Enter in the URL bar.
   * Formats the raw input and navigates the active tab.
   */
  function _onUrlSubmit() {
    const raw = _urlBar.value.trim();
    const url = formatUrl(raw);
    if (!url) return;

    _urlBar.blur();
    DomeTabs.navigateActiveTab(url);
  }

  /** Called when the URL bar gains focus — select all text for easy replace */
  function _onUrlFocus() {
    _urlBarWrap?.classList.add('focused');
    // Defer select-all slightly so it works in all browsers
    requestAnimationFrame(() => _urlBar.select());
  }

  /** Called when the URL bar loses focus — revert to committed URL if empty */
  function _onUrlBlur() {
    _urlBarWrap?.classList.remove('focused');
    // If the user blurred without navigating, restore the last real URL
    if (!_urlBar.value.trim() && _committedUrl) {
      _urlBar.value = _committedUrl;
    }
  }

  // ─── Navigation Button Handlers ─────────────────────────────────────────────

  function _onBack() {
    const wv = DomeTabs.getActiveWebview();
    if (wv?.canGoBack()) wv.goBack();
  }

  function _onForward() {
    const wv = DomeTabs.getActiveWebview();
    if (wv?.canGoForward()) wv.goForward();
  }

  /**
   * The Reload button doubles as a Stop button while a page is loading.
   * This matches standard browser UX (Chrome, Firefox, Arc).
   */
  function _onReloadOrStop() {
    const wv = DomeTabs.getActiveWebview();
    if (!wv) return;

    if (_isLoading) {
      // Page is mid-load — stop it
      wv.stop();
    } else {
      // Page is idle — hard reload (bypass cache: Ctrl/Cmd+Shift+R equivalent)
      wv.reload();
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * init()
   * ──────
   * Called once by renderer.js. Caches DOM references and attaches
   * all event listeners to toolbar elements.
   */
  function init() {
    _urlBar     = document.getElementById('url-bar');
    _urlBarWrap = document.getElementById('url-bar-wrap');
    _urlLoader  = document.getElementById('url-loader');
    _schemeEl   = document.getElementById('url-scheme');
    _btnBack    = document.getElementById('btn-back');
    _btnForward = document.getElementById('btn-forward');
    _btnReload  = document.getElementById('btn-reload');

    // ── URL Bar keyboard events ──────────────────────────────────────────
    _urlBar?.addEventListener('keydown', e => {
      switch (e.key) {
        case 'Enter':
          e.preventDefault();
          _onUrlSubmit();
          break;

        case 'Escape':
          // Revert to the current page URL and unfocus
          _urlBar.value = _committedUrl;
          _urlBar.blur();
          break;

        case 'l':
          // Ctrl+L / Cmd+L: focus the URL bar (like all real browsers)
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            _urlBar.select();
          }
          break;
      }
    });

    _urlBar?.addEventListener('focus', _onUrlFocus);
    _urlBar?.addEventListener('blur',  _onUrlBlur);

    // ── Navigation buttons ───────────────────────────────────────────────
    _btnBack?.addEventListener('click', _onBack);
    _btnForward?.addEventListener('click', _onForward);
    _btnReload?.addEventListener('click', _onReloadOrStop);

    // ── Keyboard shortcut: Alt+Left / Alt+Right for back/forward ─────────
    document.addEventListener('keydown', e => {
      if (document.activeElement === _urlBar) return; // URL bar takes priority
      if (e.altKey && e.key === 'ArrowLeft')  _onBack();
      if (e.altKey && e.key === 'ArrowRight') _onForward();
      // F5 or Ctrl+R: reload
      if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) {
        e.preventDefault();
        _onReloadOrStop();
      }
    });
  }

  /**
   * setUrl(url)
   * ────────────
   * Called by DomeTabs whenever the active webview navigates.
   * Updates the URL bar input value and scheme badge.
   *
   * @param {string} url — The URL the active tab is at
   */
  function setUrl(url) {
    if (!_urlBar) return;
    const display = (url === 'about:blank' || !url) ? '' : url;
    _urlBar.value = display;
    _committedUrl = display;
    _updateSchemeBadge(url);
  }

  /**
   * setLoading(isLoading)
   * ──────────────────────
   * Toggles the loading state:
   *   - Animates the loader bar beneath the URL input
   *   - Swaps the Reload button's icon to a Stop square
   *
   * @param {boolean} isLoading
   */
  function setLoading(isLoading) {
    _isLoading = isLoading;

    if (_urlLoader) {
      if (isLoading) {
        _urlLoader.classList.add('loading');
      } else {
        _urlLoader.classList.remove('loading');
      }
    }

    // Swap reload ↔ stop icon
    if (_btnReload) {
      _btnReload.innerHTML = isLoading ? SVG_STOP : SVG_RELOAD;
      _btnReload.title     = isLoading ? 'Stop loading' : 'Reload page';
      _btnReload.classList.toggle('is-loading', isLoading);
    }
  }

  /**
   * setNavState(canBack, canForward)
   * ─────────────────────────────────
   * Enables or disables the Back and Forward buttons.
   * Called by DomeTabs after every navigation event.
   *
   * @param {boolean} canBack    — Whether the active webview has history to go back
   * @param {boolean} canForward — Whether the active webview has forward history
   */
  function setNavState(canBack, canForward) {
    if (_btnBack)    _btnBack.disabled    = !canBack;
    if (_btnForward) _btnForward.disabled = !canForward;
  }

  /**
   * focusUrlBar()
   * ─────────────
   * Programmatically focus the URL bar (e.g. on new-tab creation).
   * Exposed so renderer.js can call it after opening a blank tab.
   */
  function focusUrlBar() {
    _urlBar?.focus();
    requestAnimationFrame(() => _urlBar?.select());
  }

  // ─── Exposed public methods ──────────────────────────────────────────────────

  return {
    init,
    setUrl,
    setLoading,
    setNavState,
    focusUrlBar,
    formatUrl,       // Exported so renderer.js and NTP can reuse it
  };

})();
