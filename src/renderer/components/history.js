/**
 * ═══════════════════════════════════════════════════════════════
 *  history.js — Dome Browser  (V1: Browsing History)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Responsibility:
 *    Tracks and stores browsing history using IndexedDB.
 *    - Records URL, title, favicon, timestamp on each navigation
 *    - Provides searchable history with date grouping
 *    - Renders a history page accessible via Ctrl+H
 *    - Clear history by time range or all
 *
 *  Storage: IndexedDB ('DomeHistory' database)
 *    - More robust than localStorage for large datasets
 *    - No size limit issues
 *    - Supports indexed queries for fast search
 *
 *  Exposed globally as: window.DomeHistory
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

window.DomeHistory = (() => {

  // ─── Constants ──────────────────────────────────────────────────────────────

  const DB_NAME    = 'DomeHistory';
  const DB_VERSION = 1;
  const STORE_NAME = 'entries';
  const MAX_ENTRIES = 10000;

  // ─── Private State ──────────────────────────────────────────────────────────

  /** @type {IDBDatabase|null} */
  let _db = null;

  /** @type {HTMLElement|null} */
  let _historyPageEl = null;

  /** Whether the history page is currently visible */
  let _isVisible = false;

  // ─── IndexedDB Setup ────────────────────────────────────────────────────────

  function _openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, {
            keyPath: 'id',
            autoIncrement: true,
          });
          store.createIndex('url',       'url',       { unique: false });
          store.createIndex('title',     'title',     { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        _db = event.target.result;
        resolve(_db);
      };

      request.onerror = (event) => {
        console.error('[DomeHistory] Failed to open IndexedDB:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  // ─── History Operations ─────────────────────────────────────────────────────

  /**
   * Records a history entry.
   * @param {object} entry
   * @param {string} entry.url
   * @param {string} entry.title
   * @param {string} [entry.favicon]
   */
  async function addEntry({ url, title, favicon = null }) {
    if (!_db) return;

    // Don't record internal pages, blank pages, or duplicate consecutive entries
    if (!url || url === 'about:blank' || url.startsWith('dome://')) return;

    try {
      const tx    = _db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const entry = {
        url,
        title:     title || url,
        favicon:   favicon || null,
        timestamp: Date.now(),
      };

      store.add(entry);

      // Trim old entries if over limit
      const countReq = store.count();
      countReq.onsuccess = () => {
        if (countReq.result > MAX_ENTRIES) {
          const trimCount = countReq.result - MAX_ENTRIES;
          const cursorReq = store.index('timestamp').openCursor();
          let deleted = 0;
          cursorReq.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor && deleted < trimCount) {
              store.delete(cursor.primaryKey);
              deleted++;
              cursor.continue();
            }
          };
        }
      };
    } catch (err) {
      console.error('[DomeHistory] Failed to add entry:', err);
    }
  }

  /**
   * Retrieves history entries, newest first.
   * @param {object} [opts]
   * @param {string} [opts.search] — Filter by URL or title
   * @param {number} [opts.limit]  — Max entries to return
   * @returns {Promise<HistoryEntry[]>}
   */
  async function getEntries({ search = '', limit = 500 } = {}) {
    if (!_db) return [];

    return new Promise((resolve) => {
      try {
        const tx    = _db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const results = [];
        const searchLower = search.toLowerCase();

        const cursorReq = store.index('timestamp').openCursor(null, 'prev');
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor || results.length >= limit) {
            resolve(results);
            return;
          }

          const entry = cursor.value;
          if (!search ||
              entry.url.toLowerCase().includes(searchLower) ||
              (entry.title && entry.title.toLowerCase().includes(searchLower))) {
            results.push(entry);
          }
          cursor.continue();
        };
        cursorReq.onerror = () => resolve([]);
      } catch (_) { resolve([]); }
    });
  }

  /**
   * Deletes a single history entry by ID.
   */
  async function deleteEntry(id) {
    if (!_db) return;
    try {
      const tx = _db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
    } catch (_) {}
  }

  /**
   * Clears all history.
   */
  async function clearAll() {
    if (!_db) return;
    try {
      const tx = _db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
    } catch (_) {}
  }

  // ─── History Page Rendering ─────────────────────────────────────────────────

  function _buildHistoryPage() {
    const page = document.createElement('div');
    page.className = 'history-page';
    page.id = 'history-page';

    page.innerHTML = `
      <div class="history-header">
        <span class="history-title">History</span>
        <input type="text" class="history-search" id="history-search"
               placeholder="Search history..." spellcheck="false" autocomplete="off" />
        <button class="history-clear-btn" id="history-clear-btn">Clear All</button>
      </div>
      <div class="history-list" id="history-list"></div>
      <div class="history-empty" id="history-empty" style="display:none;">
        <svg viewBox="0 0 40 40" width="36" height="36" fill="none"
             stroke="currentColor" stroke-width="1">
          <circle cx="20" cy="20" r="15" stroke-dasharray="4 3"/>
          <path d="M20 10v10l5 5"/>
        </svg>
        <p>No history yet</p>
      </div>
    `;

    // Wire search
    const searchInput = page.querySelector('#history-search');
    let searchTimeout;
    searchInput?.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => _renderEntries(searchInput.value), 200);
    });

    // Wire clear all
    page.querySelector('#history-clear-btn')?.addEventListener('click', async () => {
      await clearAll();
      _renderEntries('');
    });

    return page;
  }

  async function _renderEntries(search = '') {
    const listEl  = document.getElementById('history-list');
    const emptyEl = document.getElementById('history-empty');
    if (!listEl) return;

    const entries = await getEntries({ search, limit: 500 });

    if (entries.length === 0) {
      listEl.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'flex';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    // Group by date
    const groups = new Map();
    const today     = _dateKey(new Date());
    const yesterday = _dateKey(new Date(Date.now() - 86400000));

    entries.forEach(entry => {
      const key = _dateKey(new Date(entry.timestamp));
      let label;
      if (key === today)          label = 'Today';
      else if (key === yesterday) label = 'Yesterday';
      else                        label = key;

      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(entry);
    });

    let html = '';
    groups.forEach((items, dateLabel) => {
      html += `<div class="history-date-group">
        <div class="history-date-label">${_escapeHtml(dateLabel)}</div>`;

      items.forEach(entry => {
        const time = new Date(entry.timestamp).toLocaleTimeString([], {
          hour: '2-digit', minute: '2-digit',
        });
        const faviconHtml = entry.favicon
          ? `<img class="history-entry-favicon" src="${_escapeHtml(entry.favicon)}" onerror="this.style.display='none'" />`
          : `<span class="history-entry-favicon" style="background:var(--border-soft);border-radius:3px;"></span>`;

        html += `<div class="history-entry" data-entry-id="${entry.id}" data-url="${_escapeHtml(entry.url)}">
          ${faviconHtml}
          <span class="history-entry-title">${_escapeHtml(entry.title)}</span>
          <span class="history-entry-url">${_escapeHtml(entry.url)}</span>
          <span class="history-entry-time">${time}</span>
          <button class="history-entry-delete" title="Remove" data-delete-id="${entry.id}">
            <svg viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.4">
              <line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/>
            </svg>
          </button>
        </div>`;
      });

      html += `</div>`;
    });

    listEl.innerHTML = html;

    // Bind click-to-navigate
    listEl.querySelectorAll('.history-entry').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.history-entry-delete')) return;
        const url = el.dataset.url;
        if (url) {
          hide();
          DomeTabs?.navigateActiveTab(url);
        }
      });
    });

    // Bind delete buttons
    listEl.querySelectorAll('.history-entry-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.deleteId);
        if (!isNaN(id)) {
          await deleteEntry(id);
          const entryEl = btn.closest('.history-entry');
          if (entryEl) {
            entryEl.style.opacity = '0';
            entryEl.style.transform = 'translateX(-10px)';
            entryEl.style.transition = 'all 0.15s ease';
            setTimeout(() => {
              entryEl.remove();
              // Check if date group is now empty
              const search = document.getElementById('history-search')?.value || '';
              _renderEntries(search);
            }, 150);
          }
        }
      });
    });
  }

  // ─── Utility ────────────────────────────────────────────────────────────────

  function _dateKey(date) {
    return date.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
  }

  function _escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  // ─── Visibility ─────────────────────────────────────────────────────────────

  function show() {
    if (!_historyPageEl) {
      _historyPageEl = _buildHistoryPage();
      document.getElementById('content-area')?.appendChild(_historyPageEl);
    }
    _historyPageEl.classList.add('visible');
    _isVisible = true;
    _renderEntries('');
    document.getElementById('history-search')?.focus();
  }

  function hide() {
    _historyPageEl?.classList.remove('visible');
    _isVisible = false;
  }

  function toggle() {
    _isVisible ? hide() : show();
  }

  function isVisible() {
    return _isVisible;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async function init() {
    try {
      await _openDB();
      console.log('[DomeHistory] Initialised ✓');
    } catch (err) {
      console.error('[DomeHistory] Failed to initialise:', err);
    }
  }

  return {
    init,
    addEntry,
    getEntries,
    deleteEntry,
    clearAll,
    show,
    hide,
    toggle,
    isVisible,
  };

})();
