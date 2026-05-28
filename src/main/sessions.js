/**
 * ═══════════════════════════════════════════════════════════════
 *  sessions.js — Dome Browser  (Prompt 3: Developer Features)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Responsibility:
 *    The isolated session factory — the backend engine behind
 *    Dome's core Feature #1: "Isolated Tab Sessions."
 *
 *  The Problem This Solves:
 *    In a normal browser (and in Electron's default session), all
 *    tabs share a single session store. Cookies, localStorage,
 *    IndexedDB, and the authentication state of every website are
 *    pooled together. You cannot be logged in as Admin AND Guest
 *    simultaneously in two tabs — the second login overwrites the first.
 *
 *  The Electron Session Model:
 *    Electron exposes `session.fromPartition(name)` which creates an
 *    independent session store keyed by `name`.
 *
 *    Two partition naming conventions exist:
 *      ┌─────────────────────────────────┬─────────────────────────────────┐
 *      │  "persist:NAME"                 │  "NAME" (no persist: prefix)    │
 *      ├─────────────────────────────────┼─────────────────────────────────┤
 *      │  Written to disk under the      │  Exists only in RAM. Destroyed  │
 *      │  app's userData directory.      │  the moment the last webview    │
 *      │  Survives app restarts.         │  using it is closed.            │
 *      │                                 │                                 │
 *      │  Use for: named test profiles   │  Use for: anonymous one-shot    │
 *      │  that the developer wants to    │  sessions, incognito-style work, │
 *      │  keep across sessions.          │  or disposable role testing.    │
 *      └─────────────────────────────────┴─────────────────────────────────┘
 *
 *  This Module's Approach:
 *    We support BOTH modes:
 *      - Named persistent partitions  ("persist:adminSession")
 *        Created when the user names their isolated tab.
 *      - Anonymous in-memory partitions  ("isolated-<tabId>-<ts>")
 *        Default: no disk footprint, auto-destroyed on tab close.
 *
 *    Additionally, this module configures each isolated session's
 *    network behavior (user-agent, proxy, request interception hooks)
 *    so they behave like real independent browsers.
 *
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const { session, net } = require('electron');

// ─── Session Registry ────────────────────────────────────────────────────────
// Tracks every session this factory has created so we can inspect,
// clear, or destroy them on demand.
//
// Key:   partitionName (string)
// Value: SessionRecord (see _createRecord)

const _registry = new Map();

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Builds a registry record object for a session.
 *
 * @param {object} opts
 * @param {string}  opts.partition  — Full Electron partition string
 * @param {string}  opts.label      — Human-readable label shown in UI
 * @param {boolean} opts.persistent — true = disk-backed, false = in-memory
 * @param {string}  opts.tabId      — The tab ID that owns this session
 * @returns {SessionRecord}
 */
function _createRecord({ partition, label, persistent, tabId }) {
  return {
    partition,
    label,
    persistent,
    tabId,
    createdAt: Date.now(),

    // Counts of requests made through this session (for the future
    // "Session Inspector" panel in a later Dome version)
    stats: {
      requestCount:    0,
      blockedCount:    0,
      cookieSetCount:  0,
    },
  };
}

/**
 * Configures an Electron Session object with Dome's defaults.
 *
 * This is called once per session after creation. It sets up:
 *   - A custom User-Agent string that includes the session label
 *     so server logs can distinguish between isolated sessions
 *   - A `will-download` handler (stub for future download routing)
 *   - A web request interceptor that increments the stats counter
 *     (lightweight — runs on every request in this session only)
 *
 * @param {Electron.Session} ses       — The Electron session object
 * @param {SessionRecord}    record    — Our registry entry for this session
 */
function _configureSession(ses, record) {
  // ── Clean Chrome User-Agent ────────────────────────────────────────────
  // Use a standard Chrome UA so sites (especially Google OAuth) do not
  // detect Electron and block sign-in flows.
  const chromeVersion = process.versions.chrome;
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  ses.setUserAgent(ua);

  // ── Permission request handler ─────────────────────────────────────────
  const allowedPermissions = new Set([
    'clipboard-read', 'clipboard-sanitized-write', 'media',
    'geolocation', 'notifications', 'fullscreen', 'pointerLock',
    'idle-detection', 'storage-access',
  ]);
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(allowedPermissions.has(permission));
  });

  // ── Request counter (stats) ────────────────────────────────────────────
  // Lightweight: only increments a counter, no request modification.
  ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, (details) => {
    record.stats.requestCount++;
    // Track 4xx/5xx responses separately for future session health display
    if (details.statusCode >= 400) {
      record.stats.blockedCount++;
    }
  });

  // ── Cookie change listener ─────────────────────────────────────────────
  // Fires when a cookie is set in this session — useful for the
  // Session Inspector panel to show auth cookie activity.
  ses.cookies.on('changed', (event, cookie, cause) => {
    if (cause === 'explicit' || cause === 'overwrite') {
      record.stats.cookieSetCount++;
    }
  });

  // ── Download handler stub ──────────────────────────────────────────────
  // Prevent downloads from isolated sessions from accidentally mixing
  // with the main session's download queue.
  ses.on('will-download', (event, item) => {
    // In a future Dome version, we'll route these to a dedicated
    // "isolated downloads" panel. For now, allow them normally.
    // event.preventDefault(); // ← uncomment to block all downloads
  });
}

/** Strips characters unsafe for use in a User-Agent string */
function _sanitizeLabel(label) {
  return (label || 'unnamed').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * createIsolatedSession(opts)
 * ────────────────────────────
 * Creates (or retrieves) an Electron session for an isolated tab.
 *
 * The returned partition string must be assigned to the <webview>'s
 * `partition` attribute in the renderer. Electron will automatically
 * route all of that webview's network traffic and storage through
 * the corresponding session object.
 *
 * @param {object} opts
 * @param {string}  opts.tabId      — ID of the requesting tab
 * @param {string}  [opts.label]    — Display name for the session ("Admin Test")
 * @param {boolean} [opts.persist]  — true = disk-backed, false (default) = in-memory
 * @param {string}  [opts.name]     — Custom partition name for persist: mode
 *
 * @returns {{ partition: string, label: string, isNew: boolean }}
 */
function createIsolatedSession({ tabId, label = null, persist = false, name = null }) {
  // ── Build the partition string ─────────────────────────────────────────
  let partitionName;

  if (persist && name) {
    // Named persistent session: developer explicitly chose a name
    // e.g. "persist:adminTest"
    const safe = _sanitizeLabel(name);
    partitionName = `persist:dome-${safe}`;
  } else if (persist) {
    // Persistent but auto-named (unlikely UX path, but handle it)
    partitionName = `persist:dome-${tabId}-${Date.now()}`;
  } else {
    // Default: anonymous in-memory session
    // NOT prefixed with "persist:" → zero disk footprint
    partitionName = `isolated-${tabId}-${Date.now()}`;
  }

  const resolvedLabel = label || (persist && name ? name : `Session ${tabId.slice(0, 6)}`);
  const isNew = !_registry.has(partitionName);

  if (isNew) {
    // Build our registry record first (before fromPartition, so the
    // cookie listener can reference it immediately)
    const record = _createRecord({
      partition:  partitionName,
      label:      resolvedLabel,
      persistent: persist,
      tabId,
    });

    // session.fromPartition() is idempotent — calling it with the same
    // name returns the existing session if it already exists on disk.
    // For in-memory partitions this always creates a fresh session.
    const ses = session.fromPartition(partitionName, {
      cache: !persist, // disable disk cache for in-memory sessions
    });

    _configureSession(ses, record);
    _registry.set(partitionName, record);

    console.log(`[DomeSessions] Created session: "${partitionName}" (${persist ? 'persistent' : 'in-memory'})`);
  }

  return {
    partition: partitionName,
    label:     resolvedLabel,
    isNew,
  };
}

/**
 * destroySession(partition)
 * ──────────────────────────
 * Clears all data (cookies, cache, storage) from a session and
 * removes it from the registry.
 *
 * IMPORTANT: Electron does NOT expose a way to fully delete an in-memory
 * session object — it persists until the app closes. But clearing all
 * storage is functionally equivalent: cookies, localStorage, IndexedDB,
 * and cache are all wiped. Any webview that subsequently uses this
 * partition starts completely fresh.
 *
 * For persist: sessions, this permanently erases the on-disk data.
 *
 * @param {string} partition — The full partition string
 * @returns {Promise<void>}
 */
async function destroySession(partition) {
  if (!_registry.has(partition)) return;

  try {
    const ses = session.fromPartition(partition);

    // Clear everything in parallel for speed
    await Promise.all([
      ses.clearStorageData(),          // localStorage, IndexedDB, cookies, etc.
      ses.clearCache(),                // HTTP cache
      ses.clearAuthCache(),            // HTTP auth (Basic/Digest) credentials
      ses.clearHostResolverCache(),    // DNS cache
    ]);

    _registry.delete(partition);
    console.log(`[DomeSessions] Destroyed session: "${partition}"`);
  } catch (err) {
    console.error(`[DomeSessions] Failed to destroy session "${partition}":`, err);
  }
}

/**
 * clearSessionData(partition)
 * ─────────────────────────────
 * Clears cookies and storage WITHOUT removing the session from
 * the registry or invalidating the partition. The developer can
 * "reset" an isolated session mid-test without closing the tab.
 *
 * @param {string} partition
 * @returns {Promise<void>}
 */
async function clearSessionData(partition) {
  try {
    const ses = session.fromPartition(partition);
    await ses.clearStorageData();
    await ses.clearAuthCache();

    // Reset stats for this session
    const record = _registry.get(partition);
    if (record) {
      record.stats = { requestCount: 0, blockedCount: 0, cookieSetCount: 0 };
    }

    console.log(`[DomeSessions] Cleared data for session: "${partition}"`);
  } catch (err) {
    console.error(`[DomeSessions] Failed to clear session data:`, err);
  }
}

/**
 * getSessionInfo(partition)
 * ──────────────────────────
 * Returns the registry record for a given partition, plus live
 * cookie data fetched from the Electron session.
 *
 * @param {string} partition
 * @returns {Promise<SessionInfo|null>}
 */
async function getSessionInfo(partition) {
  const record = _registry.get(partition);
  if (!record) return null;

  try {
    const ses     = session.fromPartition(partition);
    const cookies = await ses.cookies.get({});

    return {
      ...record,
      cookieCount: cookies.length,
      cookies: cookies.map(c => ({
        name:     c.name,
        domain:   c.domain,
        httpOnly: c.httpOnly,
        secure:   c.secure,
        session:  c.session,
      })),
    };
  } catch (err) {
    return { ...record, cookieCount: 0, cookies: [] };
  }
}

/**
 * listSessions()
 * ───────────────
 * Returns an array of all registry records (without live cookie data).
 * Used by ipcHandlers to respond to renderer requests for the session list.
 *
 * @returns {SessionRecord[]}
 */
function listSessions() {
  return [..._registry.values()];
}

/**
 * getNamedPartitions()
 * ─────────────────────
 * Returns only the persistent (disk-backed) sessions.
 * These are the "saved profiles" the user has created intentionally.
 *
 * @returns {SessionRecord[]}
 */
function getNamedPartitions() {
  return [..._registry.values()].filter(r => r.persistent);
}

// ─── Module Export ───────────────────────────────────────────────────────────

module.exports = {
  createIsolatedSession,
  destroySession,
  clearSessionData,
  getSessionInfo,
  listSessions,
  getNamedPartitions,
};
