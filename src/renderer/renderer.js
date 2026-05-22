/**
 * ═══════════════════════════════════════════════════════════════
 *  renderer.js — Dome Browser  (Prompt 2: Core Navigation & Tab Logic)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Responsibility:
 *    The central hub of Dome's renderer process.
 *    This file owns NOTHING directly — it orchestrates everything:
 *
 *      DomeTabs     (components/tabs.js)     — tab lifecycle
 *      DomeToolbar  (components/toolbar.js)  — URL bar & nav buttons
 *      DomeWorkspace (workspace.js)          — localhost sidebar
 *
 *  Load order in index.html:
 *    1. tabs.js        → window.DomeTabs
 *    2. toolbar.js     → window.DomeToolbar
 *    3. workspace.js   → window.DomeWorkspace
 *    4. renderer.js    ← this file — runs last, everything is ready
 *
 *  Initialization sequence:
 *    DOMContentLoaded
 *      → DomeToolbar.init()      wire URL bar & nav buttons
 *      → DomeWorkspace.init()    wire sidebar
 *      → DomeTabs.init()         clear static HTML, create first tab
 *      → _bindWindowControls()   title-bar minimize/maximize/close
 *      → _bindGlobalShortcuts()  Ctrl+T, Ctrl+W, Ctrl+L, etc.
 *      → _bindNewTabButton()     "+" button in tab strip
 *      → _bindIsolatedButton()   "ISOLATED" button in toolbar
 *      → _bindNtpShortcuts()     New Tab Page quick-launch grid
 *      → _populateVersionBadges()Electron/Node/Chromium versions
 *
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

// ─── Electron APIs ───────────────────────────────────────────────────────────
// renderer.js runs in the renderer process with nodeIntegration: true,
// so require() is available.

const { ipcRenderer } = require('electron');

// ─── Initialization ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Order matters: Toolbar and Workspace must be ready before Tabs,
  // because tab creation immediately calls DomeToolbar.setUrl() and
  // DomeWorkspace.onTabNavigate().
  DomeToolbar.init();
  DomeWorkspace.init();
  DomeTabs.init();

  _bindWindowControls();
  _bindGlobalShortcuts();
  _bindNewTabButton();
  _bindIsolatedTabButton();
  _bindNtpInteractions();
  _bindDevToolsButton();
  _populateVersionBadges();

  console.log('[Dome] Renderer initialized ✓');
});

// ─── Window Controls (Custom Title Bar) ──────────────────────────────────────
// We use a frameless Electron window (frame: false) and draw our own
// title bar in HTML. These buttons communicate with main.js via IPC.

function _bindWindowControls() {
  document.getElementById('btn-minimize')
    ?.addEventListener('click', () => ipcRenderer.send('window:minimize'));

  document.getElementById('btn-maximize')
    ?.addEventListener('click', () => ipcRenderer.send('window:maximize'));

  document.getElementById('btn-close')
    ?.addEventListener('click', () => ipcRenderer.send('window:close'));
}

// ─── Global Keyboard Shortcuts ────────────────────────────────────────────────
// These mirror the keyboard shortcuts developers expect from a real browser.

function _bindGlobalShortcuts() {
  document.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey; // Ctrl on Windows/Linux, Cmd on Mac

    // ── Tab management ───────────────────────────────────────────────────
    if (ctrl && e.key === 't') {
      // Ctrl+T: new standard tab
      e.preventDefault();
      DomeTabs.createTab({ url: null });
      DomeToolbar.focusUrlBar();
    }

    if (ctrl && e.shiftKey && e.key === 'T') {
      // Ctrl+Shift+T: new isolated tab
      e.preventDefault();
      DomeTabs.createTab({ url: null, isolated: true });
      DomeToolbar.focusUrlBar();
    }

    if (ctrl && e.key === 'w') {
      // Ctrl+W: close current tab
      e.preventDefault();
      const active = DomeTabs.getActiveTab();
      if (active) DomeTabs.closeTab(active.id);
    }

    // ── Navigation bar focus ─────────────────────────────────────────────
    if (ctrl && e.key === 'l') {
      // Ctrl+L: focus URL bar and select all
      e.preventDefault();
      DomeToolbar.focusUrlBar();
    }

    // ── Tab cycling ──────────────────────────────────────────────────────
    if (ctrl && e.key === 'Tab') {
      // Ctrl+Tab: cycle to next tab
      e.preventDefault();
      _cycleTab(1);
    }

    if (ctrl && e.shiftKey && e.key === 'Tab') {
      // Ctrl+Shift+Tab: cycle to previous tab
      e.preventDefault();
      _cycleTab(-1);
    }

    // ── Hard reload (Ctrl+Shift+R) ────────────────────────────────────────
    if (ctrl && e.shiftKey && e.key === 'R') {
      e.preventDefault();
      DomeTabs.getActiveWebview()?.reloadIgnoringCache();
    }
  });
}

/**
 * Cycles the active tab forward or backward by `direction` (+1 or -1).
 * Wraps around at both ends.
 *
 * @param {number} direction — +1 for next, -1 for previous
 */
function _cycleTab(direction) {
  const allTabs = [...DomeTabs.getAllTabs().keys()];
  if (allTabs.length < 2) return;

  const active = DomeTabs.getActiveTab();
  if (!active) return;

  const currentIndex = allTabs.indexOf(active.id);
  const nextIndex    = (currentIndex + direction + allTabs.length) % allTabs.length;
  DomeTabs.activateTab(allTabs[nextIndex]);
}

// ─── New Tab Button ───────────────────────────────────────────────────────────

function _bindNewTabButton() {
  document.getElementById('btn-new-tab')
    ?.addEventListener('click', () => {
      DomeTabs.createTab({ url: null });
      // Auto-focus the URL bar so the user can immediately type
      DomeToolbar.focusUrlBar();
    });
}

// ─── Isolated Tab Button ──────────────────────────────────────────────────────
// The "ISOLATED" button in the toolbar opens a new tab with a private
// in-memory session partition — Dome's core feature #1.

function _bindIsolatedTabButton() {
  document.getElementById('btn-new-isolated')
    ?.addEventListener('click', () => {
      DomeTabs.createTab({ url: null, isolated: true });
      DomeToolbar.focusUrlBar();

      // Brief visual pulse on the button to confirm creation
      const btn = document.getElementById('btn-new-isolated');
      btn?.classList.add('btn-pulse');
      setTimeout(() => btn?.classList.remove('btn-pulse'), 500);
    });
}

// ─── DevTools Button ─────────────────────────────────────────────────────────

function _bindDevToolsButton() {
  document.getElementById('btn-devtools')
    ?.addEventListener('click', () => {
      const wv = DomeTabs.getActiveWebview();
      if (!wv) return;
      if (wv.isDevToolsOpened()) {
        wv.closeDevTools();
      } else {
        wv.openDevTools();
      }
    });
}

// ─── New Tab Page (NTP) Interactions ─────────────────────────────────────────
// The NTP has its own URL input and a quick-launch shortcut grid.
// Both navigate the active tab.

function _bindNtpInteractions() {
  // ── NTP URL input ─────────────────────────────────────────────────────
  const ntpInput = document.getElementById('ntp-url-input');

  ntpInput?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();

    const raw = ntpInput.value.trim();
    if (!raw) return;

    const url = DomeToolbar.formatUrl(raw);
    if (!url) return;

    ntpInput.value = '';
    DomeTabs.navigateActiveTab(url);
  });

  // Focus the NTP input automatically when a new (blank) tab is opened.
  // We observe NTP visibility changes to trigger this.
  const ntpEl = document.getElementById('new-tab-page');
  if (ntpEl && ntpInput) {
    const observer = new MutationObserver(() => {
      if (ntpEl.style.display !== 'none') {
        // Small delay so the tab-activation animation completes first
        setTimeout(() => ntpInput.focus(), 80);
      }
    });
    observer.observe(ntpEl, { attributes: true, attributeFilter: ['style'] });
  }

  // ── Quick-launch shortcut tiles ───────────────────────────────────────
  document.querySelectorAll('.ntp-shortcut[data-url]').forEach(tile => {
    tile.addEventListener('click', () => {
      const url = tile.dataset.url;
      if (!url) return;
      DomeTabs.navigateActiveTab(url);
    });
  });

  // ── Port badge quick-launch (sidebar footer) ──────────────────────────
  // Clicking :3000 / :5173 / :8080 badges navigates to that localhost port
  document.querySelectorAll('.port-badge[data-port]').forEach(badge => {
    badge.addEventListener('click', () => {
      const port = badge.dataset.port;
      if (!port) return;
      DomeTabs.navigateActiveTab(`http://localhost:${port}`);
    });
  });
}

// ─── Version Badges (NTP system bar) ─────────────────────────────────────────
// Reads runtime version strings from Electron's process.versions object
// and injects them into the NTP's bottom status bar.

function _populateVersionBadges() {
  const ev = process.versions.electron ?? '?';
  const nv = process.versions.node     ?? '?';
  const cv = process.versions.chrome   ?? '?';

  const el = id => document.getElementById(id);

  const elEl = el('ntp-electron-ver');
  const ndEl = el('ntp-node-ver');
  const chEl = el('ntp-chrome-ver');

  if (elEl) elEl.textContent = `ELECTRON ${ev}`;
  if (ndEl) ndEl.textContent = `NODE ${nv}`;
  if (chEl) chEl.textContent = `CHROMIUM ${cv}`;
}
