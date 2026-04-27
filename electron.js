const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let serverProcess;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 1000,
        minHeight: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'assets', 'icon.ico'),
        show: false,
        titleBarStyle: 'default',
        frame: true
    });

    // Sunucuyu başlat
    startServer();

    // Sunucu hazır olana kadar bekle
    setTimeout(() => {
        mainWindow.loadURL('http://localhost:3000');
        mainWindow.show();
    }, 2000);

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (serverProcess) {
            serverProcess.kill();
        }
    });

    // Dış linkleri varsayılan tarayıcıda aç
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

function startServer() {
    serverProcess = spawn('node', ['server.js'], {
        cwd: __dirname,
        stdio: 'inherit'
    });

    serverProcess.on('error', (err) => {
        console.error('Sunucu başlatma hatası:', err);
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        if (serverProcess) {
            serverProcess.kill();
        }
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// IPC handlers
ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

ipcMain.handle('show-message-box', async (event, options) => {
    const result = await dialog.showMessageBox(mainWindow, options);
    return result;
});

ipcMain.handle('open-external', async (event, url) => {
    await shell.openExternal(url);
});