/**
 * ═══════════════════════════════════════════════════════════════
 *  tabs.js — Dome Browser  (Prompt 2: Core Navigation & Tab Logic)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Responsibility:
 *    Complete lifecycle management for browser tabs.
 *    - Creates, activates, and destroys tab UI elements
 *    - Injects and manages a dedicated <webview> per tab
 *    - Wires all webview events (navigation, title, favicon, loading)
 *    - Enforces isolated Electron session partitions on isolated tabs
 *    - Notifies DomeToolbar and DomeWorkspace of state changes
 *
 *  Key Architecture Decision — One Webview Per Tab:
 *    Chrome keeps every tab's browsing context alive in memory.
 *    We do the same: each <webview> is injected into #content-area
 *    and kept alive but hidden (display:none) when not active.
 *    Only the active tab's webview is visible (display:block).
 *    This preserves page state (scroll position, form data, etc.)
 *    when switching tabs, just like a real browser.
 *
 *  Isolated Session Architecture:
 *    Electron's <webview> accepts a `partition` attribute that maps
 *    to a named session. Partitions NOT prefixed with "persist:" are
 *    fully in-memory and share NOTHING (cookies, localStorage, cache)
 *    with any other partition. This is the core of Dome's feature #1.
 *
 *    Standard tab  →  no partition attr  →  default shared session
 *    Isolated tab  →  partition="isolated-{id}-{ts}"  →  blank memory jar
 *
 *  Exposed globally as: window.DomeTabs
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

window.DomeTabs = (() => {

  // ─── Private State ─────────────────────────────────────────────────────────

  /**
   * Master tab registry.
   * Key: tabId (string), Value: TabObject (see _createTabObject)
   */
  const _tabs = new Map();

  /** ID of the currently visible/active tab */
  let _activeTabId = null;

  /** Incrementing counter for unique IDs — avoids timestamp collisions */
  let _tabCounter = 0;

  // ─── DOM References ─────────────────────────────────────────────────────────

  // Cached once on init — avoids repeated querySelector calls
  let _tabListEl    = null;   // #tab-list       — tab strip container
  let _contentEl    = null;   // #content-area   — webview mount point
  let _ntpEl        = null;   // #new-tab-page   — New Tab Page overlay
  let _newTabBtn    = null;   // #btn-new-tab
  let _urlSchemeEl  = null;   // .url-scheme     — "https" badge in toolbar

  // ─── Icon / Badge Builders ──────────────────────────────────────────────────
  // ROOT CAUSE FIX: Never embed SVG strings with double-quote attributes into
  // innerHTML — the HTML parser treats stroke="currentColor" as attribute
  // boundaries, injecting stray text nodes before sibling elements.
  // Solution: build ALL DOM nodes programmatically with createElement.

  /**
   * Creates a favicon <span> element for a tab.
   * Uses a pure CSS dot — no SVG in innerHTML.
   * @param {boolean} isIsolated
   * @returns {HTMLSpanElement}
   */
  function _makeFaviconEl(isIsolated) {
    const span = document.createElement('span');
    span.className = 'tab-favicon';
    const dot = document.createElement('span');
    dot.className = 'favicon-dot' + (isIsolated ? ' favicon-dot--iso' : '');
    span.appendChild(dot);
    return span;
  }

  /**
   * Creates a close button element using DOM methods (no SVG innerHTML).
   * @returns {HTMLButtonElement}
   */
  function _makeCloseBtn() {
    const btn = document.createElement('button');
    btn.className = 'tab-close-btn';
    btn.title = 'Close tab';
    // Build SVG via createElementNS — safe, no innerHTML
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 10 10');
    svg.setAttribute('width', '8');
    svg.setAttribute('height', '8');
    const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l1.setAttribute('x1', '1.5'); l1.setAttribute('y1', '1.5');
    l1.setAttribute('x2', '8.5'); l1.setAttribute('y2', '8.5');
    l1.setAttribute('stroke', 'currentColor'); l1.setAttribute('stroke-width', '1.6');
    const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l2.setAttribute('x1', '8.5'); l2.setAttribute('y1', '1.5');
    l2.setAttribute('x2', '1.5'); l2.setAttribute('y2', '8.5');
    l2.setAttribute('stroke', 'currentColor'); l2.setAttribute('stroke-width', '1.6');
    svg.appendChild(l1); svg.appendChild(l2);
    btn.appendChild(svg);
    return btn;
  }

  // ─── Tab Object Factory ──────────────────────────────────────────────────────

  /**
   * Creates a plain-object representation of a tab's state.
   * Both the DOM elements and browser state live here.
   *
   * @param {object} opts
   * @param {string}  opts.id        — Unique tab ID
   * @param {string}  [opts.url]     — Initial URL (null = New Tab Page)
   * @param {boolean} [opts.isolated]— Whether this tab has its own session
   * @returns {TabObject}
   */
  function _createTabObject({ id, url = null, isolated = false }) {
    return {
      id,
      title: 'New Tab',
      url,                            // Current URL (null = NTP state)
      favicon: null,                  // Favicon URL (null = use default SVG)
      isIsolated: isolated,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,

      // Electron session partition name.
      // Non-persist: partitions are purely in-memory — nothing shared.
      partition: isolated ? `isolated-${id}-${Date.now()}` : null,

      // DOM references — set after elements are built
      tabEl: null,
      webviewEl: null,
    };
  }

  // ─── DOM Builders ────────────────────────────────────────────────────────────

  /**
   * Builds the tab strip element (<div class="tab ...">)
   * for a given tab object and appends it to #tab-list.
   *
   * Structure mirrors index.html's static examples exactly.
   *
   * @param {TabObject} tab
   * @returns {HTMLElement}
   */
  function _buildTabEl(tab) {
    const el = document.createElement('div');
    el.className = `tab${tab.isIsolated ? ' tab--isolated' : ''}`;
    el.dataset.tabId = tab.id;
    el.title = tab.title;

    // Build children via DOM methods — never inline SVG in innerHTML
    const activeLine = document.createElement('div');
    activeLine.className = 'tab-active-line';
    el.appendChild(activeLine);

    if (tab.isIsolated) {
      const badge = document.createElement('span');
      badge.className = 'tab-iso-badge';
      badge.textContent = 'ISO';
      el.appendChild(badge);
    }

    el.appendChild(_makeFaviconEl(tab.isIsolated));

    const titleSpan = document.createElement('span');
    titleSpan.className = 'tab-title';
    titleSpan.textContent = tab.title;
    el.appendChild(titleSpan);

    const closeBtn = _makeCloseBtn();
    el.appendChild(closeBtn);

    // ── Click: activate tab ────────────────────────────────────────────────
    el.addEventListener('click', e => {
      // Don't activate if the close button was clicked
      if (e.target.closest('.tab-close-btn')) return;
      activateTab(tab.id);
    });

    // ── Middle-click: close tab ────────────────────────────────────────────
    el.addEventListener('mousedown', e => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tab.id);
      }
    });

    // ── Close button ───────────────────────────────────────────────────────
    closeBtn.addEventListener('click', e => {
      e.stopPropagation();
      closeTab(tab.id);
    });

    // Enter with a slide-in animation
    el.style.animation = 'tab-enter 0.15s ease both';

    return el;
  }

  /**
   * Creates the <webview> element for a tab and appends it to #content-area.
   *
   * Electron's webview tag is like an iframe but with a fully isolated
   * rendering process. Key attributes set here:
   *   - src         : initial URL to load
   *   - partition   : session isolation key (empty = shared default session)
   *   - allowpopups : needed for OAuth flows and external links
   *
   * @param {TabObject} tab
   * @returns {HTMLElement} The <webview> element
   */
  function _buildWebviewEl(tab) {
    const wv = document.createElement('webview');

    wv.className = 'main-webview';
    wv.dataset.tabId = tab.id;
    wv.setAttribute('allowpopups', '');

    // Isolated tabs get a unique in-memory session partition.
    // Standard tabs omit the attribute entirely to use Electron's default session.
    if (tab.partition) {
      wv.setAttribute('partition', tab.partition);
    }

    // Set initial URL (blank if opening a New Tab Page)
    wv.src = tab.url || 'about:blank';

    // Hidden by default — activateTab() will make it visible
    wv.style.display = 'none';

    // Mount into the content area (behind the NTP overlay)
    _contentEl.appendChild(wv);

    return wv;
  }

  // ─── Webview Event Wiring ────────────────────────────────────────────────────

  /**
   * Attaches all relevant Electron webview event listeners to a tab's webview.
   *
   * Each listener updates the tab's state object AND, if this tab is currently
   * active, pushes the update to DomeToolbar and DomeWorkspace.
   *
   * @param {TabObject} tab
   */
  function _wireWebviewEvents(tab) {
    const wv = tab.webviewEl;

    // ── Loading started ────────────────────────────────────────────────────
    // Show spinner in the tab favicon and notify toolbar
    wv.addEventListener('did-start-loading', () => {
      tab.isLoading = true;
      _updateTabFaviconEl(tab, 'loading');

      if (_activeTabId === tab.id) {
        DomeToolbar?.setLoading(true);
      }
    });

    // ── Loading finished ───────────────────────────────────────────────────
    // Restore favicon and clear loading state
    wv.addEventListener('did-stop-loading', () => {
      tab.isLoading = false;

      // Restore the real favicon or fall back to the default SVG
      if (tab.favicon) {
        _updateTabFaviconEl(tab, 'img', tab.favicon);
      } else {
        _updateTabFaviconEl(tab, 'svg');
      }

      // Sync back/forward capability after each load completes
      _syncNavState(tab);

      if (_activeTabId === tab.id) {
        DomeToolbar?.setLoading(false);
        DomeToolbar?.setNavState(tab.canGoBack, tab.canGoForward);
      }
    });

    // ── Page navigated (full navigation) ──────────────────────────────────
    wv.addEventListener('did-navigate', e => {
      tab.url = e.url;
      _syncNavState(tab);

      // If this is the active tab, update the toolbar URL bar
      if (_activeTabId === tab.id) {
        DomeToolbar?.setUrl(e.url);
        DomeToolbar?.setNavState(tab.canGoBack, tab.canGoForward);
      }

      // Notify workspace module — it decides if this is a localhost URL
      DomeWorkspace?.onTabNavigate(tab.id, e.url, tab.title);
    });

    // ── In-page navigation (hash changes, pushState) ───────────────────────
    wv.addEventListener('did-navigate-in-page', e => {
      // Only update for the top-level frame (isMainFrame)
      if (!e.isMainFrame) return;
      tab.url = e.url;
      _syncNavState(tab);

      if (_activeTabId === tab.id) {
        DomeToolbar?.setUrl(e.url);
        DomeToolbar?.setNavState(tab.canGoBack, tab.canGoForward);
      }
    });

    // ── Page title updated ─────────────────────────────────────────────────
    wv.addEventListener('page-title-updated', e => {
      const title = e.title || 'Untitled';
      tab.title = title;

      // Update the tab label text
      const titleEl = tab.tabEl?.querySelector('.tab-title');
      if (titleEl) {
        titleEl.textContent = title;
      }
      // Keep tooltip in sync
      if (tab.tabEl) tab.tabEl.title = title;

      // Update the OS window title if this is the active tab
      if (_activeTabId === tab.id) {
        document.title = `${title} — Dome`;
      }

      // Workspace sidebar also shows tab titles
      DomeWorkspace?.onTabTitleChange(tab.id, title);
    });

    // ── Favicon updated ────────────────────────────────────────────────────
    wv.addEventListener('page-favicon-updated', e => {
      const favicons = e.favicons;
      if (!favicons || favicons.length === 0) return;

      // Prefer the last favicon in the array — usually the highest quality
      const url = favicons[favicons.length - 1];
      tab.favicon = url;

      // Only update the favicon element if not currently loading
      if (!tab.isLoading) {
        _updateTabFaviconEl(tab, 'img', url);
      }
    });

    // ── New window requested (target="_blank", window.open, etc.) ──────────
    // Instead of opening in the OS default browser, open a new Dome tab
    wv.addEventListener('new-window', e => {
      e.preventDefault();

      // Inherit isolation from parent tab so auth context is preserved
      createTab({ url: e.url, isolated: tab.isIsolated });
    });

    // ── DOM ready — webview is interactive ─────────────────────────────────
    wv.addEventListener('dom-ready', () => {
      // Initial nav state check once the webview DOM is ready
      _syncNavState(tab);
      if (_activeTabId === tab.id) {
        DomeToolbar?.setNavState(tab.canGoBack, tab.canGoForward);
      }
    });
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Reads canGoBack / canGoForward from the live webview and stores them
   * on the tab object. These are synchronous calls in Electron renderer.
   */
  function _syncNavState(tab) {
    const wv = tab.webviewEl;
    if (!wv) return;
    try {
      tab.canGoBack    = wv.canGoBack();
      tab.canGoForward = wv.canGoForward();
    } catch (_) {
      // webview may not be ready yet
      tab.canGoBack = tab.canGoForward = false;
    }
  }

  /**
   * Updates the favicon <span> inside a tab element.
   *
   * @param {TabObject} tab
   * @param {'loading'|'svg'|'img'} mode
   * @param {string} [imgSrc] — Only used when mode === 'img'
   */
  function _updateTabFaviconEl(tab, mode, imgSrc) {
    const faviconEl = tab.tabEl?.querySelector('.tab-favicon');
    if (!faviconEl) return;

    // Clear all existing children safely
    while (faviconEl.firstChild) faviconEl.removeChild(faviconEl.firstChild);

    switch (mode) {
      case 'loading': {
        // CSS spinner dot — no SVG needed
        const dot = document.createElement('span');
        dot.className = 'favicon-dot favicon-dot--loading';
        faviconEl.appendChild(dot);
        break;
      }
      case 'img': {
        const img = document.createElement('img');
        img.className = 'favicon-img';
        img.width  = 12;
        img.height = 12;
        img.src    = imgSrc;
        img.addEventListener('error', () => {
          // Fall back to CSS dot on image load failure
          while (faviconEl.firstChild) faviconEl.removeChild(faviconEl.firstChild);
          const dot = document.createElement('span');
          dot.className = 'favicon-dot' + (tab.isIsolated ? ' favicon-dot--iso' : '');
          faviconEl.appendChild(dot);
        });
        faviconEl.appendChild(img);
        break;
      }
      case 'svg':
      default: {
        const dot = document.createElement('span');
        dot.className = 'favicon-dot' + (tab.isIsolated ? ' favicon-dot--iso' : '');
        faviconEl.appendChild(dot);
        break;
      }
    }
  }

  /** Safely escape HTML to prevent XSS in tab titles */
  function _escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  /**
   * Determines which tab should become active after a tab is closed.
   * Prefers the tab to the right; falls back to the left; returns null
   * if no tabs remain.
   *
   * @param {string} closedId
   * @returns {string|null} ID of the tab to activate, or null
   */
  function _getNextActiveId(closedId) {
    const ids = [..._tabs.keys()];
    const idx  = ids.indexOf(closedId);
    if (idx === -1) return null;

    // Try right neighbour first, then left
    const rightId = ids[idx + 1];
    const leftId  = ids[idx - 1];
    return rightId ?? leftId ?? null;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * init()
   * ──────
   * Called once by renderer.js after the DOM is ready.
   *
   * 1. Caches DOM references
   * 2. Clears the static placeholder tabs from index.html
   * 3. Removes the static example <webview> if present
   * 4. Creates the first real tab (New Tab Page)
   */
  function init() {
    _tabListEl   = document.getElementById('tab-list');
    _contentEl   = document.getElementById('content-area');
    _ntpEl       = document.getElementById('new-tab-page');
    _newTabBtn   = document.getElementById('btn-new-tab');
    _urlSchemeEl = document.getElementById('url-scheme');

    // Remove any static placeholder tabs baked into index.html
    if (_tabListEl) _tabListEl.innerHTML = '';

    // Remove the static example webview from index.html
    const existingWv = _contentEl?.querySelector('.main-webview[id="main-webview"]');
    if (existingWv) existingWv.remove();

    // Start the session with a single blank "New Tab" tab
    createTab({ url: null });
  }

  /**
   * createTab({ url, isolated })
   * ─────────────────────────────
   * Creates a new tab, injects its webview, and activates it.
   *
   * @param {object} [opts]
   * @param {string}  [opts.url]      — URL to navigate to. null = New Tab Page.
   * @param {boolean} [opts.isolated] — Whether to create an isolated session.
   * @returns {TabObject} The newly created tab
   */
  function createTab({ url = null, isolated = false } = {}) {
    // Generate a stable, unique ID
    _tabCounter++;
    const id = `tab-${_tabCounter}-${Date.now()}`;

    // Build the state object
    const tab = _createTabObject({ id, url, isolated });

    // Build and mount DOM elements
    tab.tabEl     = _buildTabEl(tab);
    tab.webviewEl = _buildWebviewEl(tab);

    // Wire all webview events before anything navigates
    _wireWebviewEvents(tab);

    // Register in the tab registry
    _tabs.set(id, tab);

    // Append the tab strip element
    _tabListEl?.appendChild(tab.tabEl);

    // Notify workspace so it can wire did-finish-load on this webview
    // (Prompt 3: Smart Auto Grouping hook)
    if (typeof DomeWorkspace !== 'undefined') {
      DomeWorkspace.onTabCreated(id);
    }

    // Activate this new tab (shows its webview, hides NTP or others)
    activateTab(id);

    return tab;
  }

  /**
   * activateTab(id)
   * ────────────────
   * Makes a tab the active tab:
   *   1. Removes --active class from all other tab elements
   *   2. Hides all other webviews
   *   3. Shows this tab's webview (or the NTP if URL is null)
   *   4. Updates DomeToolbar with the tab's current URL and nav state
   *
   * @param {string} id — Tab ID to activate
   */
  function activateTab(id) {
    const tab = _tabs.get(id);
    if (!tab) return;

    // ── Deactivate all tabs ──────────────────────────────────────────────
    _tabs.forEach(t => {
      t.tabEl?.classList.remove('tab--active');
      if (t.webviewEl) t.webviewEl.style.display = 'none';
    });

    // ── Activate this tab ────────────────────────────────────────────────
    tab.tabEl?.classList.add('tab--active');

    // Show this tab's webview (or NTP if URL is null / about:blank)
    const isNtp = !tab.url || tab.url === 'about:blank';

    if (tab.webviewEl) {
      tab.webviewEl.style.display = isNtp ? 'none' : 'block';
    }

    if (_ntpEl) {
      _ntpEl.style.display = isNtp ? 'flex' : 'none';
    }

    _activeTabId = id;

    // ── Sync toolbar ─────────────────────────────────────────────────────
    if (typeof DomeToolbar !== 'undefined') {
      DomeToolbar.setUrl(tab.url || '');
      DomeToolbar.setLoading(tab.isLoading);
      DomeToolbar.setNavState(tab.canGoBack, tab.canGoForward);
    }

    // Update document title
    document.title = tab.title !== 'New Tab' ? `${tab.title} — Dome` : 'Dome';

    // Refresh workspace sidebar active highlight
    if (typeof DomeWorkspace !== 'undefined') {
      DomeWorkspace.refreshActiveHighlight?.();
    }
  }

  /**
   * closeTab(id)
   * ─────────────
   * Removes a tab and its webview from the DOM and registry.
   * If this was the active tab, activates the nearest remaining tab.
   * If it was the last tab, opens a fresh New Tab.
   *
   * @param {string} id — Tab ID to close
   */
  function closeTab(id) {
    const tab = _tabs.get(id);
    if (!tab) return;

    const wasActive = _activeTabId === id;

    // Notify workspace before removal
    DomeWorkspace?.onTabClose(id);

    // Remove tab strip element with a slide-out animation
    if (tab.tabEl) {
      tab.tabEl.style.animation = 'tab-exit 0.12s ease both';
      tab.tabEl.addEventListener('animationend', () => tab.tabEl.remove(), { once: true });
    }

    // Destroy the webview — releases all memory and session data
    // (for isolated tabs this means the session jar is gone forever)
    if (tab.webviewEl) {
      tab.webviewEl.remove();
    }

    // Remove from registry
    _tabs.delete(id);

    // ── Rebalance active tab ─────────────────────────────────────────────
    if (wasActive) {
      const nextId = _getNextActiveId(id);

      if (nextId) {
        activateTab(nextId);
      } else {
        // No tabs left — open a clean new tab
        _activeTabId = null;
        createTab({ url: null });
      }
    }
  }

  /**
   * navigateActiveTab(url)
   * ────────────────────────
   * Navigates the currently active tab's webview to a URL.
   * Also hides the NTP and makes the webview visible.
   *
   * @param {string} url — Fully-formed URL (use DomeToolbar.formatUrl first)
   */
  function navigateActiveTab(url) {
    const tab = getActiveTab();
    if (!tab || !tab.webviewEl) return;

    tab.url = url;
    tab.webviewEl.src = url;

    // Always hide NTP and show webview when navigating
    if (_ntpEl)          _ntpEl.style.display = 'none';
    if (tab.webviewEl)   tab.webviewEl.style.display = 'block';
  }

  // ─── Getters ──────────────────────────────────────────────────────────────────

  /** @returns {TabObject|null} The currently active tab object */
  function getActiveTab() {
    return _tabs.get(_activeTabId) ?? null;
  }

  /** @returns {HTMLElement|null} The active tab's <webview> element */
  function getActiveWebview() {
    return getActiveTab()?.webviewEl ?? null;
  }

  /** @returns {Map<string, TabObject>} The full tab registry */
  function getAllTabs() {
    return _tabs;
  }

  // ─── Public surface ──────────────────────────────────────────────────────────

  return {
    init,
    createTab,
    activateTab,
    closeTab,
    navigateActiveTab,
    getActiveTab,
    getActiveWebview,
    getAllTabs,
  };

})();
