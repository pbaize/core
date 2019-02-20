import { BrowserWindow, BrowserView } from 'electron';
const convertToElectron = require('../convert_options').convertToElectron;


export function addBrowserViewToWindow(options: any, win: BrowserWindow) {
    const view = new BrowserView(convertToElectron({}, false));
    view.webContents.loadURL(options.url);
    view.setBounds(options.bounds);
    view.setAutoResize(Object.assign({width: true, height: true}, options.autoResize));
    win.setBrowserView(view);
}