/**
 * ═══════════════════════════════════════════════════════════════
 *  workspace.js — Dome Browser  (Prompt 3: Developer Features)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Responsibility:
 *    The complete frontend implementation of Dome's Feature #2:
 *    "Smart Auto Grouping" — the Local Workspace sidebar.
 *
 *  What This Module Does:
 *    1. Listens to EVERY tab's webview `did-finish-load` event
 *       (plus `did-navigate` for instant detection before full load).
 *    2. Classifies the URL: local (localhost / LAN) vs. external.
 *    3. Snaps matching tabs into the sidebar with a CSS slide-in animation.
 *    4. Removes tabs from the sidebar when they navigate away from localhost.
 *    5. Displays per-session metadata (partition label, cookie count) for
 *       isolated sessions that are also localhost tabs — the intersection
 *       of Dome's two core features.
 *    6. Handles the full tab lifecycle: create, update, close.
 *
 *  The "Snap" Animation:
 *    When a tab qualifies as local, it doesn't just appear in the sidebar.
 *    It plays a 3-step animation:
 *      Step 1 (immediate):  A subtle flash on the tab-strip tab signals
 *                           it's been "claimed" by the workspace.
 *      Step 2 (100ms):      The sidebar item slides in from the left.
 *      Step 3 (200ms):      The sidebar's neon-green accent line pulses
 *                           once to draw the developer's eye.
 *    Together, this creates a "magnetic snap" feeling — the tab has moved
 *    from the general tab bar to the command center.
 *
 *  did-finish-load vs. did-navigate:
 *    We listen to BOTH events deliberately:
 *    - `did-navigate` fires as soon as the URL commits (before content loads).
 *      This gives instant sidebar updates for fast redirects and pushState nav.
 *    - `did-finish-load` fires after the DOM is fully parsed.
 *      This is where we read the final <title> and trigger the snap animation,
 *      because the title is not available until the DOM is ready.
 *
 *  Session Integration:
 *    When an isolated tab (with a session partition) navigates to localhost,
 *    its sidebar card shows an extra row:
 *      ⬡ SESSION  adminTest  [2 cookies]  [Clear] [Copy URL]
 *    This makes it immediately obvious WHICH test session is running on
 *    which local port — a key developer workflow improvement.
 *
 *  IPC Integration:
 *    This module calls ipcRenderer for two purposes:
 *    - session:get-info   → fetches live cookie count for isolated sessions
 *    - system:clipboard-write → copies a tab's URL to the clipboard
 *
 *  Exposed globally as: window.DomeWorkspace
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

window.DomeWorkspace = (() => {

  // ─── Electron IPC (available because nodeIntegration: true) ────────────────
  const { ipcRenderer } = require('electron');

  // ─── Private State ──────────────────────────────────────────────────────────

  /**
   * Registry of tabs currently in the Local Workspace.
   * Key:   tabId (string)
   * Value: WorkspaceEntry (see _createEntry)
   */
  const _localTabs = new Map();

  /**
   * Set of tabIds whose webviews have already been wired with
   * did-finish-load listeners. Prevents duplicate event registration
   * when a tab navigates multiple times.
   */
  const _wiredTabs = new Set();

  // ─── DOM References ─────────────────────────────────────────────────────────

  let _tabListEl   = null;   // #ws-tab-list
  let _emptyEl     = null;   // #ws-empty
  let _statusDotEl = null;   // #ws-dot
  let _countEl     = null;   // #ws-count
  let _sidebarEl   = null;   // #local-workspace

  // ─── WorkspaceEntry Factory ──────────────────────────────────────────────────

  /**
   * @typedef {object} WorkspaceEntry
   * @property {string}      tabId
   * @property {string}      url           Current URL
   * @property {string}      title         Page title (from <title> tag)
   * @property {string|null} port          Port number as string, or null
   * @property {boolean}     isIsolated    Whether this tab has a custom session
   * @property {string|null} partition     Session partition string if isolated
   * @property {string|null} sessionLabel  Human label for the session
   * @property {number}      cookieCount   Live cookie count (fetched async)
   * @property {boolean}     isLoading     True during page load
   * @property {number}      addedAt       Timestamp when tab was added
   */

  function _createEntry({ tabId, url, title, isIsolated, partition }) {
    return {
      tabId,
      url,
      title:        title || _shortLabel(url),
      port:         _extractPort(url),
      isIsolated:   isIsolated || false,
      partition:    partition  || null,
      sessionLabel: null,
      cookieCount:  0,
      isLoading:    false,
      addedAt:      Date.now(),
    };
  }

  // ─── URL Utilities ───────────────────────────────────────────────────────────

  /**
   * Returns true if `url` points to a local or LAN development server.
   * Covers all common developer localhost patterns.
   */
  function _isLocalUrl(url) {
    if (!url || url === 'about:blank') return false;
    try {
      const { hostname } = new URL(url);
      return (
        hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '0.0.0.0'
        || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)
        || /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
        || /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)
      );
    } catch (_) { return false; }
  }

  /** Extracts the port string from a URL, or returns null */
  function _extractPort(url) {
    try {
      const { port, protocol } = new URL(url);
      return port || null; // don't show implicit 80/443 — too noisy
    } catch (_) { return null; }
  }

  /** Short display label: "localhost:3000" or "192.168.1.10" */
  function _shortLabel(url) {
    try {
      const u = new URL(url);
      return u.port ? `${u.hostname}:${u.port}` : u.hostname;
    } catch (_) { return url; }
  }

  /** Safely escape HTML for innerHTML insertion */
  function _escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  // ─── Session Info (IPC) ──────────────────────────────────────────────────────

  /**
   * Fetches live session metadata (cookie count, label) from the
   * main process via IPC and updates the entry + re-renders.
   *
   * This is async and non-blocking — the sidebar renders immediately
   * with whatever data is available, then updates when IPC responds.
   *
   * @param {WorkspaceEntry} entry
   */
  async function _fetchSessionInfo(entry) {
    if (!entry.isIsolated || !entry.partition) return;

    try {
      const info = await ipcRenderer.invoke('session:get-info', entry.partition);
      if (!info) return;

      entry.sessionLabel = info.label  || null;
      entry.cookieCount  = info.cookieCount || 0;
      _render(); // Re-render to show updated cookie count
    } catch (_) {
      // IPC failed — non-fatal, just show without cookie count
    }
  }

  // ─── Snap Animation ─────────────────────────────────────────────────────────

  /**
   * Triggers the 3-step "snap" animation sequence when a tab is
   * first added to the workspace.
   *
   * @param {string}      tabId   — The tab being snapped in
   * @param {HTMLElement} itemEl  — The newly created sidebar item
   */
  function _triggerSnapAnimation(tabId, itemEl) {
    // Step 1: Flash the tab-strip element
    const tab = DomeTabs?.getAllTabs()?.get(tabId);
    if (tab?.tabEl) {
      tab.tabEl.classList.add('tab-snap-flash');
      tab.tabEl.addEventListener('animationend', () => {
        tab.tabEl.classList.remove('tab-snap-flash');
      }, { once: true });
    }

    // Step 2: Slide in the sidebar item (done via CSS animation on the element)
    itemEl.classList.add('ws-item-entering');
    itemEl.addEventListener('animationend', () => {
      itemEl.classList.remove('ws-item-entering');
    }, { once: true });

    // Step 3: Pulse the sidebar's green accent line
    if (_sidebarEl) {
      _sidebarEl.classList.add('sidebar-snap-pulse');
      setTimeout(() => _sidebarEl.classList.remove('sidebar-snap-pulse'), 700);
    }
  }

  // ─── Sidebar Renderer ────────────────────────────────────────────────────────

  /**
   * _render()
   * ─────────
   * Full declarative re-render of the sidebar tab list.
   * Called on every state mutation (add, update, remove).
   *
   * Tracks which items already exist in the DOM and only
   * rebuilds items that have changed — prevents animation reset
   * on unrelated updates.
   */
  function _render() {
    if (!_tabListEl) return;

    const count = _localTabs.size;

    // Update count label and status dot
    if (_countEl)     _countEl.textContent = count === 0 ? '0 active' : `${count} active`;
    if (_statusDotEl) _statusDotEl.classList.toggle('active', count > 0);
    if (_emptyEl)     _emptyEl.style.display = count === 0 ? 'flex' : 'none';

    // Get current rendered item IDs
    const renderedIds = new Set(
      [..._tabListEl.querySelectorAll('.ws-tab-item')].map(el => el.dataset.tabId)
    );

    // ── Add or update items ───────────────────────────────────────────────
    _localTabs.forEach((entry, tabId) => {
      const existing = _tabListEl.querySelector(`.ws-tab-item[data-tab-id="${tabId}"]`);
      const isActive = DomeTabs?.getActiveTab()?.id === tabId;

      if (existing) {
        // Update in-place: just refresh the active class and dynamic text
        existing.classList.toggle('ws-tab-active', isActive);
        const titleEl = existing.querySelector('.ws-tab-title');
        if (titleEl) titleEl.textContent = entry.title || _shortLabel(entry.url);
        const cookieEl = existing.querySelector('.ws-cookie-count');
        if (cookieEl) cookieEl.textContent = `${entry.cookieCount} cookies`;
      } else {
        // New item — build and append
        const item = _buildSidebarItem(entry, isActive);
        _tabListEl.appendChild(item);
        _triggerSnapAnimation(tabId, item);
      }
    });

    // ── Remove items whose tabs have left the workspace ───────────────────
    renderedIds.forEach(tabId => {
      if (!_localTabs.has(tabId)) {
        const el = _tabListEl.querySelector(`.ws-tab-item[data-tab-id="${tabId}"]`);
        if (el) {
          el.classList.add('ws-item-leaving');
          el.addEventListener('animationend', () => el.remove(), { once: true });
        }
      }
    });
  }

  /**
   * Builds a complete sidebar card element for a workspace entry.
   *
   * Anatomy of a sidebar card:
   * ┌──────────────────────────────────────┐
   * │ ● [dot]  Page Title        :3000     │  ← main row
   * │ ⬡ SESSION  adminTest  [2 cookies]    │  ← isolated session row (if applicable)
   * │         [Copy URL]                   │  ← action row
   * └──────────────────────────────────────┘
   *
   * @param {WorkspaceEntry} entry
   * @param {boolean}        isActive
   * @returns {HTMLElement}
   */
  function _buildSidebarItem(entry, isActive) {
    const item = document.createElement('div');
    item.className = `ws-tab-item${isActive ? ' ws-tab-active' : ''}`;
    item.dataset.tabId = entry.tabId;
    item.title = entry.url;

    // Port badge
    const portHtml = entry.port
      ? `<span class="ws-port-chip">:${_escapeHtml(entry.port)}</span>`
      : '';

    // Color-coded dot (hashed from port for consistency)
    const hue = _portToHue(entry.port);
    const dotStyle = `background:hsl(${hue},88%,54%); box-shadow:0 0 6px hsl(${hue},88%,44%,0.6)`;

    // Isolated session row — only shown when tab has a session AND is localhost
    const sessionRowHtml = entry.isIsolated
      ? `<div class="ws-session-row">
           <svg class="ws-session-icon" viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.4">
             <circle cx="5" cy="5" r="3.5"/>
             <circle cx="5" cy="5" r="1.5" fill="currentColor" stroke="none"/>
           </svg>
           <span class="ws-session-label">${_escapeHtml(entry.sessionLabel || 'Isolated')}</span>
           <span class="ws-cookie-count">${entry.cookieCount} cookies</span>
         </div>`
      : '';

    // Action row
    const actionRowHtml = `
      <div class="ws-action-row">
        <button class="ws-action-btn ws-copy-btn" data-url="${_escapeHtml(entry.url)}" title="Copy URL">
          <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.4">
            <rect x="3.5" y="3.5" width="7" height="7" rx="1"/>
            <path d="M1.5 8.5V1.5h7"/>
          </svg>
          Copy URL
        </button>
        ${entry.isIsolated
          ? `<button class="ws-action-btn ws-clear-btn" data-partition="${_escapeHtml(entry.partition || '')}" title="Clear session data">
               <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.4">
                 <polyline points="1,3 11,3"/><path d="M5 3V1.5h2V3"/>
                 <path d="M2 3l.8 7.5h6.4L10 3"/>
               </svg>
               Clear
             </button>`
          : ''
        }
      </div>`;

    item.innerHTML = `
      <div class="ws-tab-main-row">
        <span class="ws-tab-dot" style="${dotStyle}"></span>
        <span class="ws-tab-title">${_escapeHtml(entry.title || _shortLabel(entry.url))}</span>
        ${portHtml}
      </div>
      ${sessionRowHtml}
      ${actionRowHtml}
    `;

    // ── Event listeners ───────────────────────────────────────────────────

    // Main row click: activate tab
    item.querySelector('.ws-tab-main-row')?.addEventListener('click', () => {
      DomeTabs?.activateTab(entry.tabId);
      _render(); // refresh active highlights
    });

    // Copy URL button
    item.querySelector('.ws-copy-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      const url = e.currentTarget.dataset.url;
      ipcRenderer.send('system:clipboard-write', url);
      _showCopyFeedback(e.currentTarget);
    });

    // Clear session button (isolated tabs only)
    item.querySelector('.ws-clear-btn')?.addEventListener('click', async e => {
      e.stopPropagation();
      const partition = e.currentTarget.dataset.partition;
      if (!partition) return;

      const btn = e.currentTarget;
      btn.textContent = '...';
      btn.disabled = true;

      try {
        await ipcRenderer.invoke('session:clear-data', partition);
        // Refresh cookie count after clearing
        await _fetchSessionInfo(entry);
        _render();
      } finally {
        btn.disabled = false;
        btn.innerHTML = `<svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.4">
          <polyline points="1,3 11,3"/><path d="M5 3V1.5h2V3"/>
          <path d="M2 3l.8 7.5h6.4L10 3"/>
        </svg> Clear`;
      }
    });

    return item;
  }

  /**
   * Briefly changes a Copy button's text to "✓ Copied" then restores it.
   */
  function _showCopyFeedback(btn) {
    const original = btn.innerHTML;
    btn.textContent = '✓ Copied';
    btn.classList.add('ws-action-btn--success');
    setTimeout(() => {
      btn.innerHTML = original;
      btn.classList.remove('ws-action-btn--success');
    }, 1200);
  }

  /**
   * Maps a port string to a hue (0–360) — same port always = same color.
   * Uses the "golden angle" multiplier (137) for maximal visual spread.
   */
  function _portToHue(port) {
    if (!port) return 160;
    return (parseInt(port, 10) * 137) % 360;
  }

  // ─── Webview Event Wiring ────────────────────────────────────────────────────

  /**
   * wireTab(tabId)
   * ───────────────
   * Attaches did-navigate and did-finish-load listeners to a tab's webview.
   *
   * This is the CORE of the Smart Auto Grouping feature.
   *
   * Called by the public `onTabCreated()` hook, which DomeTabs calls
   * every time a new tab and its webview are created.
   *
   * We listen to both events:
   *   - `did-navigate`:     instant URL detection, before DOM is parsed
   *   - `did-finish-load`:  final title read + snap animation trigger
   *
   * @param {string} tabId — The tab to wire
   */
  function wireTab(tabId) {
    if (_wiredTabs.has(tabId)) return;

    const tab = DomeTabs?.getAllTabs()?.get(tabId);
    if (!tab?.webviewEl) return;

    const wv = tab.webviewEl;
    _wiredTabs.add(tabId);

    // ── did-navigate: instant classification ──────────────────────────────
    wv.addEventListener('did-navigate', (e) => {
      const url = e.url;
      _handleNavigation(tabId, url, null, false);
    });

    // ── did-navigate-in-page: SPA route changes ───────────────────────────
    wv.addEventListener('did-navigate-in-page', (e) => {
      if (!e.isMainFrame) return;
      _handleNavigation(tabId, e.url, null, false);
    });

    // ── did-finish-load: DOM ready — read title, trigger snap ─────────────
    wv.addEventListener('did-finish-load', () => {
      const url   = wv.getURL?.() || '';
      const title = wv.getTitle?.() || '';
      _handleNavigation(tabId, url, title, true /* isFinished */);
    });

    // ── did-start-loading: mark entry as loading ──────────────────────────
    wv.addEventListener('did-start-loading', () => {
      const entry = _localTabs.get(tabId);
      if (entry) {
        entry.isLoading = true;
        _render();
      }
    });

    // ── did-stop-loading: loading done ────────────────────────────────────
    wv.addEventListener('did-stop-loading', () => {
      const entry = _localTabs.get(tabId);
      if (entry) {
        entry.isLoading = false;
        _render();
      }
    });
  }

  /**
   * _handleNavigation(tabId, url, title, isFinished)
   * ──────────────────────────────────────────────────
   * Core classification logic called by both webview event listeners.
   *
   * @param {string}      tabId
   * @param {string}      url
   * @param {string|null} title       — null until did-finish-load
   * @param {boolean}     isFinished  — true only on did-finish-load
   */
  function _handleNavigation(tabId, url, title, isFinished) {
    const isLocal = _isLocalUrl(url);

    if (isLocal) {
      const tab = DomeTabs?.getAllTabs()?.get(tabId);
      const existing = _localTabs.get(tabId);
      const isNew = !existing;

      if (isNew) {
        // First time this tab enters the workspace — create fresh entry
        const entry = _createEntry({
          tabId,
          url,
          title:       title || (existing?.title) || _shortLabel(url),
          isIsolated:  tab?.isIsolated  || false,
          partition:   tab?.partition   || null,
        });
        _localTabs.set(tabId, entry);
        _render();

        // Kick off async IPC call to get session info (cookie count, label)
        if (tab?.isIsolated && tab?.partition) {
          _fetchSessionInfo(entry);
        }
      } else {
        // Already in workspace — update URL and optionally title
        existing.url  = url;
        existing.port = _extractPort(url);
        if (title) existing.title = title;

        if (isFinished && tab?.isIsolated && tab?.partition) {
          // Refresh cookie count on each full page load
          _fetchSessionInfo(existing);
        } else {
          _render();
        }
      }
    } else {
      // Not a local URL — remove from workspace if it was there
      if (_localTabs.has(tabId)) {
        _localTabs.delete(tabId);
        _render();
      }
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * init()
   * ──────
   * Called once by renderer.js. Caches DOM references and renders
   * the initial empty state.
   */
  function init() {
    _tabListEl   = document.getElementById('ws-tab-list');
    _emptyEl     = document.getElementById('ws-empty');
    _statusDotEl = document.getElementById('ws-dot');
    _countEl     = document.getElementById('ws-count');
    _sidebarEl   = document.getElementById('local-workspace');

    _render();
  }

  /**
   * onTabCreated(tabId)
   * ────────────────────
   * Called by DomeTabs immediately after a new tab's webview is
   * injected into the DOM. Wires the did-finish-load listener.
   *
   * @param {string} tabId
   */
  function onTabCreated(tabId) {
    // Wire on next tick so the webview element is fully appended to the DOM
    requestAnimationFrame(() => wireTab(tabId));
  }

  /**
   * onTabNavigate(tabId, url, title)
   * ──────────────────────────────────
   * Called by DomeTabs on did-navigate events.
   * Also called directly by wireTab's listener — both paths converge here.
   */
  function onTabNavigate(tabId, url, title) {
    _handleNavigation(tabId, url, title || null, false);
  }

  /**
   * onTabTitleChange(tabId, title)
   * ──────────────────────────────
   * Called by DomeTabs when a page's <title> updates.
   */
  function onTabTitleChange(tabId, title) {
    const entry = _localTabs.get(tabId);
    if (!entry) return;
    entry.title = title;
    _render();
  }

  /**
   * onTabClose(tabId)
   * ──────────────────
   * Called by DomeTabs just before a tab is destroyed.
   */
  function onTabClose(tabId) {
    _localTabs.delete(tabId);
    _wiredTabs.delete(tabId);
    _render();
  }

  /**
   * refreshActiveHighlight()
   * ─────────────────────────
   * Re-renders the sidebar to update the active-tab highlight.
   * Called by DomeTabs.activateTab() after switching tabs.
   */
  function refreshActiveHighlight() {
    _render();
  }

  // ─── Exposed surface ─────────────────────────────────────────────────────────

  return {
    init,
    onTabCreated,
    onTabNavigate,
    onTabTitleChange,
    onTabClose,
    refreshActiveHighlight,
  };

})();
