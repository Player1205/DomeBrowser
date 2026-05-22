/**
 * ═══════════════════════════════════════════════════════════════
 *  main.js — Dome Browser  (updated Prompt 3)
 * ═══════════════════════════════════════════════════════════════
 *  Electron main process entry point.
 *  - Creates the BrowserWindow
 *  - Delegates ALL IPC handling to ipcHandlers.js
 *  - Window-control IPC stays here (minimize / maximize / close)
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// ─── Import our modules ───────────────────────────────────────────────────────
const { registerHandlers } = require('./ipcHandlers');
// sessions.js is used by ipcHandlers; it does not need to be imported here.

let mainWindow = null;

// Getter passed to ipcHandlers so it always has the current window reference
const getMainWindow = () => mainWindow;

// ─── Window Factory ───────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width:     1280,
    height:    800,
    minWidth:  960,
    minHeight: 600,
    frame:          false,
    titleBarStyle:  'hidden',
    backgroundColor: '#0E0E11',
    show: false,

    webPreferences: {
      webviewTag:       true,     // Required: allows <webview> tags
      nodeIntegration:  true,     // Required: ipcRenderer, require() in renderer
      contextIsolation: false,    // Must be false with nodeIntegration: true
      webSecurity:      process.env.NODE_ENV !== 'development',
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();

  // Register all developer-feature IPC handlers (sessions, system, dialogs)
  registerHandlers(ipcMain, getMainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── Window Control IPC (kept here — these need direct window access) ─────────

ipcMain.on('window:minimize', () => mainWindow?.minimize());

ipcMain.on('window:maximize', () => {
  mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize();
});

ipcMain.on('window:close', () => mainWindow?.close());
