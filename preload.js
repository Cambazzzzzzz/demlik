const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    showMessageBox: (options) => ipcRenderer.invoke('show-message-box', options),
    openExternal: (url) => ipcRenderer.invoke('open-external', url)
});