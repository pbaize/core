import { BrowserWindow, BrowserView, app } from 'electron';
import { OpenFinWindow } from '../../shapes';
const convertToElectron = require('../convert_options').convertToElectron;
import * as coreState from '../core_state';


export function addBrowserViewToWindow(options: any, win: BrowserWindow) {
    const view = new BrowserView(convertToElectron({}, false));
    const ofWin = coreState.getWinObjById(win.id);
    if (!ofWin) {
        return;
    }
    const name = app.generateGUID();
    const uuid = ofWin.uuid;
    ofWin.views.set(name, {info: {name, uuid, parent: {uuid, name: ofWin.name}, entityType: 'view'}, view});
    //@ts-ignore
    view.webContents.registerIframe = win.webContents.registerIframe.bind(view.webContents);
    view.webContents.loadURL(options.url);
    view.setBounds(options.bounds);
    view.setAutoResize(Object.assign({width: true, height: true}, options.autoResize));
    win.setBrowserView(view);
}