import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, Menu, screen, session, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import { findLaunchLink, launchTarget, parseLaunchLink, PROTOCOL } from './launch';
import { ExamMode } from './lockdown';
import { isAllowedNavigation, isAllowedPermission } from './navigation';
import { blockedShortcut } from './shortcuts';
import { collectSystemReport, type SystemEnv } from './system';

// Where the exam screens are served from. Production builds will set this to
// the organisation's ExamGuard address.
const APP_URL = process.env.EXAMGUARD_URL ?? 'http://localhost:5173';
const APP_ORIGIN = new URL(APP_URL).origin;
// Developer tools are for development only, never in an exam build.
const DEV = !app.isPackaged && process.env.EXAMGUARD_DEV === '1';

if (!app.isPackaged && process.env.EXAMGUARD_FAKE_MEDIA === '1') {
  // For testing on a computer with no camera or microphone.
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
}

let win: BrowserWindow | null = null;
let exam: ExamMode | null = null;
// A link that started the application (Windows and Linux pass it on the command line).
let pendingLink: string | null = findLaunchLink(process.argv);

function startUrl(): string {
  return launchTarget(APP_URL, pendingLink ? parseLaunchLink(pendingLink) : null);
}

/** Opens the exam a link named. A running exam is never interrupted. */
function openLaunchLink(raw: string): void {
  const link = parseLaunchLink(raw);
  if (!link) return;
  if (!win) {
    pendingLink = raw;
    return;
  }
  if (exam?.isActive()) return;
  void win.loadURL(launchTarget(APP_URL, link)).catch(() => undefined);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// macOS delivers links here, possibly before the application is ready.
app.on('open-url', (event, url) => {
  event.preventDefault();
  openLaunchLink(url);
});

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function normalMenu(): Menu | null {
  // macOS needs an application and edit menu for copy and paste to work outside the exam.
  return process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null;
}

const realEnv: SystemEnv = {
  platform: process.platform,
  osRelease: process.getSystemVersion(),
  appVersion: app.getVersion(),
  run: (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
    }),
  readText: (file) => readFile(file, 'utf8').catch(() => ''),
  freeDiskMb: async () => {
    const stats = await statfs(app.getPath('userData'));
    return Math.floor((stats.bavail * stats.bsize) / 1024 / 1024);
  },
  displayCount: () => screen.getAllDisplays().length,
  screenCaptureReady: () => process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted',
};

/** Only the ExamGuard page in our own window may control the desktop application. */
function trusted(event: IpcMainInvokeEvent): boolean {
  return Boolean(win) && event.sender === win!.webContents && isAllowedNavigation(event.senderFrame?.url ?? '', APP_ORIGIN);
}

function offlinePage(message: string): string {
  const html = `<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f5f6f8;color:#1b1f24"><div><h1>ExamGuard</h1><p>${message}</p></div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function loadApp(): Promise<void> {
  if (!win || win.isDestroyed()) return;
  try {
    await win.loadURL(startUrl());
    pendingLink = null;
  } catch {
    // Cannot reach the server yet: say so and keep trying.
    await win.loadURL(offlinePage(`Cannot reach ExamGuard at ${APP_URL}. Trying again…`)).catch(() => undefined);
    setTimeout(() => void loadApp(), 3000);
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'ExamGuard',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: DEV,
    },
  });
  const window = win;
  exam = new ExamMode(window, {
    setMenu: (examMode) => Menu.setApplicationMenu(examMode ? null : normalMenu()),
    clearClipboard: () => clipboard.clear(),
    every: (fn, ms) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.on('render-process-gone', () => void loadApp());

  // Closing the window during the exam is an attempt to leave. The window
  // stays, and the exam screens are told so the attempt is recorded and the
  // exam's policy is applied.
  window.on('close', (event) => {
    if (exam?.isActive()) {
      event.preventDefault();
      send('desktop:close-requested');
    }
  });
  app.on('before-quit', (event) => {
    if (exam?.isActive()) {
      event.preventDefault();
      send('desktop:close-requested');
    }
  });
  window.on('closed', () => {
    win = null;
    exam = null;
  });

  // If the window is knocked out of full screen, say so and put it back.
  window.on('leave-full-screen', () => {
    if (!exam?.isActive()) return;
    send('desktop:fullscreen', false);
    setTimeout(() => {
      if (!exam?.isActive()) return;
      exam.enter();
      send('desktop:fullscreen', true);
    }, 150);
  });
  window.on('minimize', () => {
    if (exam?.isActive()) window.restore();
  });

  window.webContents.on('before-input-event', (event, input) => {
    if (!exam?.isActive()) return;
    const combo = blockedShortcut(input);
    if (combo) {
      event.preventDefault();
      send('desktop:shortcut-blocked', combo);
    }
  });
  if (!DEV) window.webContents.on('devtools-opened', () => window.webContents.closeDevTools());

  screen.on('display-added', () => {
    if (exam?.isActive()) send('desktop:display-added', screen.getAllDisplays().length);
  });

  void loadApp();
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (!isAllowedNavigation(url, APP_ORIGIN)) event.preventDefault();
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = findLaunchLink(argv);
    if (link) openLaunchLink(link);
    else if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(normalMenu());

    // Let links in the browser open this application. Only installed builds
    // claim the link type, so running from source does not change the computer's settings.
    if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
    else if (process.env.EXAMGUARD_REGISTER_PROTOCOL === '1' && process.argv[1]) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (!isAllowedPermission(permission, details.requestingUrl || webContents.getURL(), APP_ORIGIN)) return callback(false);
      if (permission !== 'media' || process.platform !== 'darwin') return callback(true);
      // macOS asks the person, once, before letting the app use the camera or microphone.
      const types = ((details as { mediaTypes?: string[] }).mediaTypes ?? []) as string[];
      void (async () => {
        let granted = true;
        if (types.includes('video')) granted = (await systemPreferences.askForMediaAccess('camera')) && granted;
        if (types.includes('audio')) granted = (await systemPreferences.askForMediaAccess('microphone')) && granted;
        callback(granted);
      })();
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
      isAllowedPermission(permission, requestingOrigin, APP_ORIGIN),
    );

    ipcMain.handle('desktop:info', (event) => (trusted(event) ? { version: app.getVersion(), platform: process.platform } : null));
    ipcMain.handle('desktop:system-report', (event) => (trusted(event) ? collectSystemReport(realEnv) : null));
    ipcMain.handle('desktop:enter-exam-mode', (event) => {
      if (trusted(event)) exam?.enter();
    });
    ipcMain.handle('desktop:exit-exam-mode', (event) => {
      if (trusted(event)) exam?.exit();
    });
    // A picture of the locked exam window for the screen recording. In exam
    // mode the window covers the whole screen, so this is what the screen
    // shows. It is taken from inside the application, so the protection
    // against outside screen capture does not blank it.
    ipcMain.handle('desktop:capture-screen', async (event) => {
      if (!trusted(event) || !win || !exam?.isActive()) return null;
      const image = await win.webContents.capturePage();
      const { width } = image.getSize();
      return (width > 1280 ? image.resize({ width: 1280 }) : image).toJPEG(60);
    });

    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
