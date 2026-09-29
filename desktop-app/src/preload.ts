import { contextBridge, ipcRenderer } from 'electron';

// The only things the exam screens can ask the desktop application to do.
// Nothing here gives the page access to files, programs or the network.

function subscribe<T extends unknown[]>(channel: string) {
  return (callback: (...args: T) => void): (() => void) => {
    const listener = (_event: unknown, ...args: unknown[]) => callback(...(args as T));
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('examguardDesktop', {
  info: () => ipcRenderer.invoke('desktop:info'),
  systemReport: () => ipcRenderer.invoke('desktop:system-report'),
  enterExamMode: () => ipcRenderer.invoke('desktop:enter-exam-mode'),
  exitExamMode: () => ipcRenderer.invoke('desktop:exit-exam-mode'),
  onCloseRequested: subscribe<[]>('desktop:close-requested'),
  onShortcutBlocked: subscribe<[string]>('desktop:shortcut-blocked'),
  onFullscreenChange: subscribe<[boolean]>('desktop:fullscreen'),
  onDisplayAdded: subscribe<[number]>('desktop:display-added'),
});
