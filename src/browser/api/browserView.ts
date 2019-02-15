import { BrowserWindow, BrowserView } from 'electron';


export function addBrowserViewToWindow(options: any, win: BrowserWindow) {
    const view = new BrowserView({
        webPreferences: {
            nodeIntegration: false
        }
    });
    view.webContents.loadURL(options.url);
    view.setBounds(options.bounds);
    view.setAutoResize(Object.assign({width: true, height: true}, options.autoResize));
    win.setBrowserView(view);
}