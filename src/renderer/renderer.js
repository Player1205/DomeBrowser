/**
 * renderer.js — Dome Browser  (Warm Redesign + Background Image Feature)
 * Central hub: initialises all modules and wires all global interactions.
 */

'use strict';

const { ipcRenderer } = require('electron');
const path = require('path');
const fs   = require('fs');

// ─── Initialisation ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  DomeToolbar.init();
  DomeWorkspace.init();
  DomeTabGroups.init();
  DomeHistory.init();
  DomeTabs.init();

  _bindWindowControls();
  _bindGlobalShortcuts();
  _bindNewTabButton();
  _bindIsolatedTabButton();
  _bindNtpInteractions();
  _bindDevToolsButton();
  _bindBackgroundImageFeature();
  _populateVersionBadges();
  _bindNewWindowFromWebview();

  // Restore saved background image from localStorage on startup
  _restoreBackground();

  console.log('[Dome] Renderer initialised ✓');
});

// ─── Window Controls ─────────────────────────────────────────────────────────

function _bindWindowControls() {
  document.getElementById('btn-minimize')
    ?.addEventListener('click', () => ipcRenderer.send('window:minimize'));
  document.getElementById('btn-maximize')
    ?.addEventListener('click', () => ipcRenderer.send('window:maximize'));
  document.getElementById('btn-close')
    ?.addEventListener('click', () => ipcRenderer.send('window:close'));
}

// ─── Global Keyboard Shortcuts ────────────────────────────────────────────────

function _bindGlobalShortcuts() {
  document.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key === 't' && !e.shiftKey) {
      e.preventDefault();
      DomeTabs.createTab({ url: null });
      DomeToolbar.focusUrlBar();
    }
    if (ctrl && e.shiftKey && e.key === 'T') {
      e.preventDefault();
      DomeTabs.createTab({ url: null, isolated: true });
      DomeToolbar.focusUrlBar();
    }
    if (ctrl && e.key === 'w') {
      e.preventDefault();
      const active = DomeTabs.getActiveTab();
      if (active) DomeTabs.closeTab(active.id);
    }
    if (ctrl && e.key === 'l') {
      e.preventDefault();
      DomeToolbar.focusUrlBar();
    }
    if (ctrl && e.key === 'h' && !e.shiftKey) {
      e.preventDefault();
      DomeHistory.toggle();
    }
    // Fix: check Shift first to avoid Ctrl+Shift+Tab triggering Ctrl+Tab
    if (ctrl && e.shiftKey && e.key === 'Tab') {
      e.preventDefault(); _cycleTab(-1);
    } else if (ctrl && e.key === 'Tab') {
      e.preventDefault(); _cycleTab(1);
    }
    if (ctrl && e.shiftKey && e.key === 'R') {
      e.preventDefault();
      DomeTabs.getActiveWebview()?.reloadIgnoringCache();
    }
  });
}

function _cycleTab(direction) {
  const ids = [...DomeTabs.getAllTabs().keys()];
  if (ids.length < 2) return;
  const active = DomeTabs.getActiveTab();
  if (!active) return;
  const idx  = ids.indexOf(active.id);
  const next = (idx + direction + ids.length) % ids.length;
  DomeTabs.activateTab(ids[next]);
}

// ─── New Tab Button ───────────────────────────────────────────────────────────

function _bindNewTabButton() {
  document.getElementById('btn-new-tab')?.addEventListener('click', () => {
    DomeTabs.createTab({ url: null });
    DomeToolbar.focusUrlBar();
  });
}

// ─── Isolated Tab Button ──────────────────────────────────────────────────────

function _bindIsolatedTabButton() {
  document.getElementById('btn-new-isolated')?.addEventListener('click', () => {
    DomeTabs.createTab({ url: null, isolated: true });
    DomeToolbar.focusUrlBar();
    const btn = document.getElementById('btn-new-isolated');
    btn?.classList.add('btn-pulse');
    setTimeout(() => btn?.classList.remove('btn-pulse'), 500);
  });
}

// ─── DevTools Button ─────────────────────────────────────────────────────────

function _bindDevToolsButton() {
  document.getElementById('btn-devtools')?.addEventListener('click', () => {
    const wv = DomeTabs.getActiveWebview();
    if (!wv) return;
    wv.isDevToolsOpened() ? wv.closeDevTools() : wv.openDevTools();
  });
}

// ─── NTP Interactions ────────────────────────────────────────────────────────

function _bindNtpInteractions() {
  // Main NTP URL input
  const ntpInput = document.getElementById('ntp-url-input');
  ntpInput?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const url = DomeToolbar.formatUrl(ntpInput.value.trim());
    if (!url) return;
    ntpInput.value = '';
    DomeTabs.navigateActiveTab(url);
  });

  // Auto-focus NTP input when NTP becomes visible
  const ntpEl = document.getElementById('new-tab-page');
  if (ntpEl && ntpInput) {
    const obs = new MutationObserver(() => {
      if (ntpEl.style.display !== 'none') {
        setTimeout(() => ntpInput.focus(), 80);
      }
    });
    obs.observe(ntpEl, { attributes: true, attributeFilter: ['style'] });
  }

  // Quick-launch shortcut tiles
  document.querySelectorAll('.ntp-shortcut[data-url]').forEach(tile => {
    tile.addEventListener('click', () => {
      DomeTabs.navigateActiveTab(tile.dataset.url);
    });
  });

  // Port badges in sidebar footer
  document.querySelectorAll('.port-badge[data-port]').forEach(badge => {
    badge.addEventListener('click', () => {
      DomeTabs.navigateActiveTab(`http://localhost:${badge.dataset.port}`);
    });
  });
}

// ─── Background Image Feature ─────────────────────────────────────────────────
//
// Architecture:
//   - User clicks "Choose image" → native file picker opens (hidden <input type=file>)
//   - Selected file is read as a data URL (base64) using FileReader
//   - The data URL is stored in localStorage under key "dome-bg-image"
//     AND in the NTP element's background-image CSS
//   - A "has-bg" class on .ntp triggers the frosted-glass overlay on .ntp-inner
//   - "Remove" button clears localStorage and resets the background
//   - On startup, _restoreBackground() reads localStorage and re-applies it
//
// Why data URL and not a file path?
//   Electron's renderer context can read local files directly with FileReader,
//   so a data URL is the simplest approach that works cross-platform without
//   needing extra IPC or the fs module for image rendering.

function _bindBackgroundImageFeature() {
  const fileInput    = document.getElementById('bg-file-input');
  const btnSetBg     = document.getElementById('btn-set-bg');
  const btnRemoveBg  = document.getElementById('btn-remove-bg');
  const bgHint       = document.getElementById('bg-hint');

  if (!fileInput || !btnSetBg) return;

  // "Choose image" button triggers the hidden file input
  btnSetBg.addEventListener('click', () => fileInput.click());

  // File selected
  fileInput.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate it's actually an image
    if (!file.type.startsWith('image/')) {
      _showBgFeedback('Please choose an image file', 'error');
      return;
    }

    // Max 20 MB — larger images can cause localStorage quota errors
    const MAX_MB = 20;
    if (file.size > MAX_MB * 1024 * 1024) {
      _showBgFeedback(`Image must be under ${MAX_MB}MB`, 'error');
      return;
    }

    _showBgFeedback('Loading...', 'loading');

    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target.result;
      _applyBackground(dataUrl);

      // Persist to localStorage so it survives app restarts
      try {
        localStorage.setItem('dome-bg-image', dataUrl);
        localStorage.setItem('dome-bg-name',  file.name);
      } catch (storageErr) {
        // localStorage quota exceeded (image too large even after check)
        console.warn('[Dome] Could not persist background:', storageErr);
        _showBgFeedback('Image applied but could not be saved (too large)', 'warning');
        return;
      }

      const name = file.name.length > 28
        ? file.name.slice(0, 25) + '...'
        : file.name;
      _showBgFeedback(name, 'success');
    };

    reader.onerror = () => _showBgFeedback('Could not read file', 'error');
    reader.readAsDataURL(file);

    // Reset the input so the same file can be re-selected
    fileInput.value = '';
  });

  // "Remove" button
  btnRemoveBg?.addEventListener('click', () => {
    _clearBackground();
    localStorage.removeItem('dome-bg-image');
    localStorage.removeItem('dome-bg-name');
    _showBgFeedback('No background set', 'idle');
  });
}

/**
 * Applies a background image data URL to the NTP.
 * @param {string} dataUrl
 */
function _applyBackground(dataUrl) {
  const ntp       = document.getElementById('new-tab-page');
  const btnRemove = document.getElementById('btn-remove-bg');

  if (!ntp) return;

  ntp.style.backgroundImage = `url(${dataUrl})`;
  ntp.classList.add('has-bg');
  btnRemove?.classList.remove('hidden');
}

/**
 * Removes the background image from the NTP.
 */
function _clearBackground() {
  const ntp       = document.getElementById('new-tab-page');
  const btnRemove = document.getElementById('btn-remove-bg');

  if (!ntp) return;

  ntp.style.backgroundImage = '';
  ntp.classList.remove('has-bg');
  btnRemove?.classList.add('hidden');
}

/**
 * Restores a saved background from localStorage on app startup.
 */
function _restoreBackground() {
  const saved     = localStorage.getItem('dome-bg-image');
  const savedName = localStorage.getItem('dome-bg-name');

  if (!saved) return;

  _applyBackground(saved);

  if (savedName) {
    const name = savedName.length > 28 ? savedName.slice(0, 25) + '...' : savedName;
    _showBgFeedback(name, 'success');
  }
}

/**
 * Updates the background hint text and styling.
 * @param {string} text
 * @param {'idle'|'loading'|'success'|'error'|'warning'} state
 */
function _showBgFeedback(text, state) {
  const hint = document.getElementById('bg-hint');
  if (!hint) return;
  hint.textContent = text;
  hint.className = 'ntp-bg-hint ntp-bg-hint--' + state;
}

// ─── New Window From Webview (Google OAuth, target="_blank") ─────────────

function _bindNewWindowFromWebview() {
  ipcRenderer.on('new-window-from-webview', (event, url) => {
    if (url && typeof url === 'string') {
      // Open popup URLs as new Dome tabs
      const activeTab = DomeTabs.getActiveTab();
      DomeTabs.createTab({
        url,
        isolated: activeTab?.isIsolated || false,
      });
    }
  });
}

// ─── Version Badges ───────────────────────────────────────────────────────────

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
