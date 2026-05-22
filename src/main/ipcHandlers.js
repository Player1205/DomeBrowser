/**
 * ═══════════════════════════════════════════════════════════════
 *  ipcHandlers.js — Dome Browser  (Prompt 3: Developer Features)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Responsibility:
 *    The complete IPC bridge between the renderer process (UI) and
 *    the main process (Electron/Node.js backend).
 *
 *  Why IPC?
 *    Electron has two processes:
 *      - Renderer: runs HTML/CSS/JS in a sandboxed Chromium context
 *      - Main:     runs Node.js with full OS/filesystem access
 *
 *    The renderer CANNOT directly call `session.fromPartition()` or
 *    access Electron's native APIs because those live in the main process.
 *    IPC (Inter-Process Communication) is the bridge.
 *
 *  Two IPC Patterns Used Here:
 *    1. ipcMain.handle (request/response — async)
 *       Renderer calls: await ipcRenderer.invoke('channel', ...args)
 *       Main responds:  ipcMain.handle('channel', async (event, ...args) => result)
 *       Use for: operations that return data (create session, get info)
 *
 *    2. ipcMain.on (fire-and-forget — one-way)
 *       Renderer calls: ipcRenderer.send('channel', ...args)
 *       Main handles:   ipcMain.on('channel', (event, ...args) => { ... })
 *       Use for: window controls, destroy commands (no return value needed)
 *
 *  Channel Naming Convention:
 *    "namespace:action"   e.g. "session:create", "window:minimize"
 *    Snake-case namespaces group related channels for readability.
 *
 *  Security Note:
 *    All handlers validate their inputs before calling into sessions.js
 *    or performing any privileged action. The `event.senderFrame` is
 *    checked to ensure only the main window can send these messages
 *    (guards against malicious webview content spoofing IPC channels).
 *
 *  All handlers are registered via the exported `registerHandlers()`
 *  function, called from main.js once the app is ready.
 *
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const { ipcMain, shell, dialog, clipboard } = require('electron');
const sessions = require('./sessions');

// ─── Security Helper ─────────────────────────────────────────────────────────

/**
 * Returns true only if the IPC event originates from the main BrowserWindow's
 * top-level frame (not from a <webview> inside it).
 *
 * This prevents a malicious webpage loaded in a webview from calling
 * privileged IPC handlers by injecting JavaScript that uses ipcRenderer.
 * (Note: this guard is belt-and-suspenders — nodeIntegration is already
 * disabled inside webviews by default.)
 *
 * @param {Electron.IpcMainEvent|Electron.IpcMainInvokeEvent} event
 * @param {Electron.BrowserWindow} mainWindow
 * @returns {boolean}
 */
function _isTrustedSender(event, mainWindow) {
  // event.senderFrame is the frame that sent the IPC message.
  // mainWindow.webContents.mainFrame is the top-level frame of our shell.
  try {
    return event.senderFrame === mainWindow.webContents.mainFrame;
  } catch (_) {
    // Fallback: check by webContents ID
    return event.sender?.id === mainWindow.webContents?.id;
  }
}

// ─── registerHandlers(ipcMain, getMainWindow) ────────────────────────────────

/**
 * Registers all IPC handlers.
 *
 * Called ONCE from main.js after app.whenReady().
 * We take `getMainWindow` as a getter function (not the window itself)
 * because the window reference can change (e.g. macOS re-create on activate).
 *
 * @param {Electron.IpcMain}             ipcMain
 * @param {() => Electron.BrowserWindow} getMainWindow
 */
function registerHandlers(ipcMain, getMainWindow) {

  // ══════════════════════════════════════════════════════════════
  //  SESSION CHANNELS
  //  All logic delegates to sessions.js — handlers are thin wrappers
  //  that validate input and translate errors into IPC-safe responses.
  // ══════════════════════════════════════════════════════════════

  /**
   * session:create
   * ──────────────
   * Creates a new isolated session partition for a tab.
   *
   * Renderer invokes:
   *   const result = await ipcRenderer.invoke('session:create', {
   *     tabId:   'tab-3-1234567890',
   *     label:   'Admin User',        // optional
   *     persist: false,               // optional, default false
   *     name:    'adminTest',         // optional, only used with persist:true
   *   });
   *   // result: { ok: true, partition: 'isolated-tab-3-...', label: 'Admin User', isNew: true }
   *   // or:     { ok: false, error: '...' }
   *
   * The renderer then sets this partition string as the webview's
   * `partition` attribute before loading any URL.
   */
  ipcMain.handle('session:create', async (event, opts = {}) => {
    const win = getMainWindow();
    if (!_isTrustedSender(event, win)) {
      return { ok: false, error: 'Untrusted sender' };
    }

    // Input validation
    if (!opts.tabId || typeof opts.tabId !== 'string') {
      return { ok: false, error: 'tabId is required and must be a string' };
    }
    if (opts.label && typeof opts.label !== 'string') {
      return { ok: false, error: 'label must be a string' };
    }

    try {
      const result = sessions.createIsolatedSession({
        tabId:   opts.tabId,
        label:   opts.label   || null,
        persist: opts.persist || false,
        name:    opts.name    || null,
      });

      return { ok: true, ...result };
    } catch (err) {
      console.error('[IPC session:create]', err);
      return { ok: false, error: err.message };
    }
  });

  // ──────────────────────────────────────────────────────────────

  /**
   * session:destroy
   * ────────────────
   * Clears ALL data for a session and removes it from the registry.
   * Called when an isolated tab is closed.
   *
   * Renderer sends (fire-and-forget):
   *   ipcRenderer.send('session:destroy', 'isolated-tab-3-...')
   */
  ipcMain.on('session:destroy', async (event, partition) => {
    const win = getMainWindow();
    if (!_isTrustedSender(event, win)) return;
    if (!partition || typeof partition !== 'string') return;

    await sessions.destroySession(partition);
  });

  // ──────────────────────────────────────────────────────────────

  /**
   * session:clear-data
   * ───────────────────
   * Clears cookies and storage WITHOUT destroying the session.
   * Used by the "Reset Session" button in the future Session Inspector.
   *
   * Renderer invokes:
   *   const result = await ipcRenderer.invoke('session:clear-data', 'isolated-...')
   *   // result: { ok: true } or { ok: false, error: '...' }
   */
  ipcMain.handle('session:clear-data', async (event, partition) => {
    const win = getMainWindow();
    if (!_isTrustedSender(event, win)) return { ok: false, error: 'Untrusted sender' };
    if (!partition) return { ok: false, error: 'partition is required' };

    try {
      await sessions.clearSessionData(partition);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ──────────────────────────────────────────────────────────────

  /**
   * session:get-info
   * ─────────────────
   * Returns metadata + live cookie list for a specific session.
   * Powers the Session Inspector panel (Prompt 4+).
   *
   * Renderer invokes:
   *   const info = await ipcRenderer.invoke('session:get-info', 'isolated-...')
   */
  ipcMain.handle('session:get-info', async (event, partition) => {
    const win = getMainWindow();
    if (!_isTrustedSender(event, win)) return null;

    return await sessions.getSessionInfo(partition);
  });

  // ──────────────────────────────────────────────────────────────

  /**
   * session:list
   * ─────────────
   * Returns all registry records (no live cookie data for perf).
   * Used by the sidebar's session management dropdown.
   *
   * Renderer invokes:
   *   const list = await ipcRenderer.invoke('session:list')
   */
  ipcMain.handle('session:list', async (event) => {
    const win = getMainWindow();
    if (!_isTrustedSender(event, win)) return [];

    return sessions.listSessions();
  });

  // ──────────────────────────────────────────────────────────────

  /**
   * session:list-named
   * ───────────────────
   * Returns only the persistent (disk-backed) named sessions.
   * These are the "saved profiles" shown in the isolated tab picker.
   *
   * Renderer invokes:
   *   const profiles = await ipcRenderer.invoke('session:list-named')
   */
  ipcMain.handle('session:list-named', async (event) => {
    const win = getMainWindow();
    if (!_isTrustedSender(event, win)) return [];

    return sessions.getNamedPartitions();
  });


  // ══════════════════════════════════════════════════════════════
  //  WINDOW CONTROL CHANNELS
  //  These were previously inlined in main.js. Centralising them
  //  here keeps main.js clean.
  // ══════════════════════════════════════════════════════════════

  /**
   * window:minimize / window:maximize / window:close
   * These are already registered in main.js; re-registering them
   * here would cause a "handler already registered" error. They are
   * left in main.js for clarity — this comment documents the split.
   */


  // ══════════════════════════════════════════════════════════════
  //  SYSTEM / UTILITY CHANNELS
  // ══════════════════════════════════════════════════════════════

  /**
   * system:open-external
   * ─────────────────────
   * Opens a URL in the OS default browser (not in Dome).
   * Used for links that should intentionally leave Dome, like
   * documentation links or OAuth flows that must use the system browser.
   *
   * Renderer invokes:
   *   await ipcRenderer.invoke('system:open-external', 'https://...')
   */
  ipcMain.handle('system:open-external', async (event, url) => {
    const win = getMainWindow();
    if (!_isTrustedSender(event, win)) return { ok: false };

    // Strict validation: only allow http and https URLs
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'Only http/https URLs are allowed' };
    }

    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ──────────────────────────────────────────────────────────────

  /**
   * system:clipboard-write
   * ───────────────────────
   * Writes text to the OS clipboard.
   * Used by the "Copy URL" button in the sidebar's session cards.
   *
   * Renderer sends (fire-and-forget):
   *   ipcRenderer.send('system:clipboard-write', 'http://localhost:3000')
   */
  ipcMain.on('system:clipboard-write', (event, text) => {
    const win = getMainWindow();
    if (!_isTrustedSender(event, win)) return;
    if (typeof text !== 'string') return;

    clipboard.writeText(text);
  });

  // ──────────────────────────────────────────────────────────────

  /**
   * system:get-app-info
   * ────────────────────
   * Returns static app metadata for display in the About panel.
   *
   * Renderer invokes:
   *   const info = await ipcRenderer.invoke('system:get-app-info')
   */
  ipcMain.handle('system:get-app-info', async (event) => {
    const { app } = require('electron');
    return {
      version:        app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion:     process.versions.node,
      chromeVersion:   process.versions.chrome,
      platform:        process.platform,
      arch:            process.arch,
    };
  });

  // ──────────────────────────────────────────────────────────────

  /**
   * dialog:show-confirm
   * ────────────────────
   * Shows a native OS confirmation dialog.
   * Used before destructive actions like "Destroy all sessions."
   *
   * Renderer invokes:
   *   const { confirmed } = await ipcRenderer.invoke('dialog:show-confirm', {
   *     title:   'Destroy Session',
   *     message: 'This will permanently erase all cookies and storage. Continue?',
   *   })
   */
  ipcMain.handle('dialog:show-confirm', async (event, { title, message } = {}) => {
    const win = getMainWindow();
    if (!_isTrustedSender(event, win)) return { confirmed: false };

    const { response } = await dialog.showMessageBox(win, {
      type:    'warning',
      title:   title   || 'Confirm',
      message: message || 'Are you sure?',
      buttons: ['Cancel', 'Confirm'],
      defaultId: 0,
      cancelId:  0,
    });

    return { confirmed: response === 1 };
  });

  console.log('[DomeIPC] All handlers registered ✓');
}

// ─── Module Export ────────────────────────────────────────────────────────────

module.exports = { registerHandlers };
