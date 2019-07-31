import { Menu, Rectangle } from 'electron';
import { getPendingAuthRequest, deletePendingAuthRequest } from '../authentication_delegate';
import { getElectronBrowserWindow } from '../api_protocol/api_handlers/webcontents';
import { handleForceActions,
    areNewBoundsWithinConstraints,
    genWindowKey,
    disabledFrameRef,
    getOptFromBrowserWin,
    subscriptionManager,
    isWin32,
    getBoundsCacheSafeFileName,
    disabledFrameUnsubDecorator } from './window';
import { toSafeInt } from '../../common/safe_int';
import WindowGroups from '../window_groups';
import * as NativeWindow from './native_window';
import * as WebContents from './webcontents';
import {Acker, Nacker, Identity, SavedDiskBounds} from '../../shapes';
import animations from '../animations';
import { WINDOWS_MESSAGE_MAP } from '../../common/windows_messages';
import route from '../../common/route';
import * as coreState from '../core_state';
import * as log from '../log';
import ofEvents from '../of_events';
import { FrameInfo } from './frame';
import fs = require('../../renderer/extended/fs');

/**
 * Sets/updates window's preload script state and emits relevant events
 */
export function setWindowPreloadState(identity: Identity, payload: {
    url: string;
    state: 'load-started' | 'load-failed' | 'load-succeeded' | 'succeeded' | 'failed' | undefined;
    allDone?: boolean;
}) {
    const { uuid, name } = identity;
    const { url, state, allDone } = payload;
    const updateTopic = allDone ? 'preload-scripts-state-changed' : 'preload-scripts-state-changing';
    const frameInfo = coreState.getInfoByUuidFrame(identity);
    let openfinWindow;
    if (frameInfo.entityType === 'iframe') {
        openfinWindow = wrap(frameInfo.parent.uuid, frameInfo.parent.name);
    } else {
        openfinWindow = wrap(uuid, name);
    }

    if (!openfinWindow) {
        return log.writeToLog('info', `setWindowPreloadState missing openfinWindow ${uuid} ${name}`);
    }
    let { preloadScripts } = openfinWindow;

    // Single preload script state change
    if (!allDone) {
        if (frameInfo.entityType === 'iframe') {
            let frameState = openfinWindow.framePreloadScripts[name];
            if (!frameState) {
                frameState = openfinWindow.framePreloadScripts[name] = [];
            }
            let framePreloadScripts = frameState.find((e: { url: any; }) => e.url === url);
            if (!preloadScripts) {
                frameState.push(framePreloadScripts = { url });
            }
            preloadScripts = [framePreloadScripts];
        } else {
            preloadScripts = openfinWindow.preloadScripts.filter((e: { url: any; }) => e.url === url);
        }
        if (preloadScripts) {
            preloadScripts[0].state = state;
        } else {
            log.writeToLog('info', `setWindowPreloadState missing preloadState ${uuid} ${name} ${url} `);
        }
    }

    if (frameInfo.entityType === 'window') {
        ofEvents.emit(route.window(updateTopic, uuid, name), {
            name,
            uuid,
            preloadScripts
        });
    } // @TODO ofEvents.emit(route.frame for iframes
}
export function resizeBy(identity: Identity, deltaWidth: number, deltaHeight: number, anchor: any, callback: Acker, errorCallback: Nacker) {
    const browserWindow = getElectronBrowserWindow(identity);
    const opts = { anchor, deltaHeight, deltaWidth };
    if (!browserWindow) {
        return;
    }

    if (!('_options' in browserWindow)) {
        errorCallback(new Error(`No window options present for uuid: ${identity.uuid} name: ${identity.name}`));
        return;
    }

    const newWidth = browserWindow._options.width + deltaWidth;
    const newHeight = browserWindow._options.height + deltaHeight;

    const newBoundsWithinConstraints = areNewBoundsWithinConstraints(browserWindow._options, newWidth, newHeight);

    if (newBoundsWithinConstraints) {
        NativeWindow.resizeBy(browserWindow, opts);
        callback(undefined);
    } else {
        errorCallback(new Error(`Proposed window bounds violate size constraints for uuid: ${identity.uuid} name: ${identity.name}`));
    }
}

export function getState(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);
    if (!browserWindow) {
        return 'normal';
    }
    return NativeWindow.getState(browserWindow);
}

export function flash(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);
    if (!browserWindow) {
        return;
    }
    NativeWindow.flash(browserWindow);
}

export function stopFlashing(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);
    if (!browserWindow) {
        return;
    }
    NativeWindow.stopFlashing(browserWindow);
}

export function focus(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);
    if (!browserWindow) {
        return;
    }
    NativeWindow.focus(browserWindow);
}
export function getBounds(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);

    if (!browserWindow) {
        return {
            height: 0,
            left: -1,
            top: -1,
            width: 0,
            right: -1,
            bottom: -1
        };
    }

    return NativeWindow.getBounds(browserWindow);
}


export function getGroup(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);

    if (!browserWindow) {
        return [];
    }

    const openfinWindow = wrap(identity.uuid, identity.name);
    return WindowGroups.getGroup(openfinWindow.groupUuid);
}


export function getWindowInfo(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity, 'get info for');
    const { preloadScripts } = wrap(identity.uuid, identity.name);
    return Object.assign({
        preloadScripts
    }, WebContents.getInfo(browserWindow.webContents));
}
export function getAllFrames(identity: Identity) {
    const openfinWindow = coreState.getWindowByUuidName(identity.uuid, identity.name);

    if (!openfinWindow) {
        return [];
    }

    const framesArr = [coreState.getInfoByUuidFrame(identity)];
    const subFrames = [];

    for (const [, info] of openfinWindow.frames) {
        subFrames.push(new FrameInfo(info));
    }

    return framesArr.concat(subFrames);
}
export function getNativeId(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity, 'get ID for');

    return browserWindow.nativeId;
}
// TODO investigate the close sequence, there appears to be a case were you;
// try to wrap and close an already closed window
export function close(identity: Identity, force: boolean = false, callback: Acker = () => undefined) {
    const browserWindow = getElectronBrowserWindow(identity);

    if (!browserWindow) {
        callback(undefined);
        return;
    }

    const payload = {
        force
    };

    const defaultAction = () => {
        if (!browserWindow.isDestroyed()) {
            const openfinWindow = wrap(identity.uuid, identity.name);
            openfinWindow.forceClose = true;
            browserWindow.close();
        }
    };

    ofEvents.once(route.window('closed', identity.uuid, identity.name), () => {
        callback(undefined);
    });

    handleForceActions(identity, force, 'close-requested', payload, defaultAction);
}
export function getBoundsFromDisk(identity: Identity, callback: Acker, errorCallback: Nacker) {
    getBoundsCacheSafeFileName(identity, (cacheFile: any) => {
        try {
            fs.readFile(cacheFile, 'utf8', (err: any, data: string) => {
                if (err) {
                    errorCallback(err);
                } else {
                    try {
                        callback(JSON.parse(data));
                    } catch (parseErr) {
                        errorCallback(new Error(`Error parsing saved bounds data ${parseErr.message}`));
                    }
                }
            });
        } catch (err) {
            errorCallback(err);
        }
    }, errorCallback);
}
export const getSnapshot = async  (opts: { identity: any; payload: any; }) => {
        const { identity, payload: { area } } = opts;
        const browserWindow = getElectronBrowserWindow(identity);

        if (!browserWindow) {
            const error = new Error(`Unknown window named '${identity.name}'`);
            throw error;
        }

        if (area === undefined) {
            // Snapshot of a full window
            const img = await browserWindow.capturePage();
            return img.toPNG().toString('base64');
        }

        if (!area ||
            typeof area !== 'object' ||
            typeof area.x !== 'number' ||
            typeof area.y !== 'number' ||
            typeof area.width !== 'number' ||
            typeof area.height !== 'number'
        ) {
            const error = new Error('Invalid shape of the snapshot\'s area.');
            throw error;
        }

        // Snapshot of a specified area of the window
        const img = await browserWindow.capturePage(<Rectangle>area);
        return img.toPNG().toString('base64');
};
export const registerWindowName = (identity: Identity) => {
    coreState.registerPendingWindowName(identity.uuid, identity.name);
};
export function authenticate(identity: Identity, username: string, password: string, callback: (e?: Error) => void) {
    const {
        authCallback
    } = getPendingAuthRequest(identity);

    if (authCallback && typeof (authCallback) === 'function') {
        authCallback(username, password);
        deletePendingAuthRequest(identity);
        callback(undefined);
    } else {
        callback(new Error('No authentication request pending for window'));
    }
}
export function navigate(identity: Identity, url: any) {
    const browserWindow = getElectronBrowserWindow(identity, 'navigate');
    return WebContents.navigate(browserWindow.webContents, url);
}

export function setBounds(identity: Identity,
    left: number,
    top: number,
    width: number,
    height: number,
    callback: Acker,
    errorCallback: Nacker) {
    const browserWindow = getElectronBrowserWindow(identity, 'set window bounds for');
    const opts = { height, left, top, width };
    if (!browserWindow) {
        return;
    }

    if (!('_options' in browserWindow)) {
        errorCallback(new Error(`No window options present for uuid: ${identity.uuid} name: ${identity.name}`));
        return;
    }

    const newBoundsWithinConstraints = areNewBoundsWithinConstraints(browserWindow._options, width, height);

    if (newBoundsWithinConstraints) {
        NativeWindow.setBounds(browserWindow, opts);
        callback(undefined);
    } else {
        errorCallback(new Error(`Proposed window bounds violate size constraints for uuid: ${identity.uuid} name: ${identity.name}`));
    }
}
export function resizeTo(identity: Identity, width: number, height: number, anchor: any, callback: Acker, errorCallback: Nacker) {
    const browserWindow = getElectronBrowserWindow(identity);
    const opts = { anchor, height, width };
    if (!browserWindow) {
        return;
    }

    if (!('_options' in browserWindow)) {
        errorCallback(new Error(`No window options present for uuid: ${identity.uuid} name: ${identity.name}`));
        return;
    }

    const newBoundsWithinConstraints = areNewBoundsWithinConstraints(browserWindow._options, width, height);

    if (newBoundsWithinConstraints) {
        NativeWindow.resizeTo(browserWindow, opts);
        callback(undefined);
    } else {
        errorCallback(new Error(`Proposed window bounds violate size constraints for uuid: ${identity.uuid} name: ${identity.name}`));
    }
}


export function restore(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity, 'restore');
    NativeWindow.restore(browserWindow);
}


export function setAsForeground(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);
    if (!browserWindow) {
        return;
    }
    NativeWindow.setAsForeground(browserWindow);
}

export function show(identity: Identity, force: boolean = false) {
    const browserWindow = getElectronBrowserWindow(identity);

    if (!browserWindow) {
        return;
    }

    const payload = {};
    const defaultAction = () => NativeWindow.show(browserWindow);

    handleForceActions(identity, force, 'show-requested', payload, defaultAction);
}


export function showAt(identity: Identity, left: number, top: number, force: boolean = false) {
    const browserWindow = getElectronBrowserWindow(identity);

    if (!browserWindow) {
        return;
    }

    const safeLeft = toSafeInt(left);
    const safeTop = toSafeInt(top);
    const payload = { top: safeTop, left: safeLeft };
    const defaultAction = () => NativeWindow.showAt(browserWindow, { left, top });

    handleForceActions(identity, force, 'show-requested', payload, defaultAction);
}
export function exists(identity: Identity) {
    return coreState.windowExists(identity.uuid, identity.name);
}
export function isShowing(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);
    if (!browserWindow) {
        return false;
    }
    return NativeWindow.isVisible(browserWindow);
}


export function joinGroup(identity: Identity, grouping: Identity) {
    return WindowGroups.joinGroup({ uuid: identity.uuid, name: identity.name }, { uuid: grouping.uuid, name: grouping.name });
}


export function leaveGroup(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);

    if (!browserWindow) {
        return;
    }

    const openfinWindow = wrap(identity.uuid, identity.name);
    return WindowGroups.leaveGroup(openfinWindow);
}


export function maximize(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity, 'maximize');
    const maximizable = getOptFromBrowserWin('maximizable', browserWindow, true);
    if (maximizable) {
        NativeWindow.maximize(browserWindow);
    }
}
export function blur(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);

    if (!browserWindow) {
        return;
    }

    browserWindow.blur();
}
export function animate(
    identity: Identity,
    transitions: any, options: any = {},
    callback: Acker = () => undefined,
    errorCallback: Nacker = () => undefined
    ) {
    const browserWindow = getElectronBrowserWindow(identity);

    if (!browserWindow) {
        callback(undefined);
        return;
    }

    const animationMeta = transitions || {};
    const animationTween = (options && options.tween) || 'ease-in-out';
    animationMeta.interrupt = (options || {}).interrupt;
    if (typeof animationMeta.interrupt !== 'boolean') {
        animationMeta.interrupt = true;
    }

    const { size } = transitions;

    if (!size) {
        animations.getAnimationHandler().add(browserWindow, animationMeta, animationTween, callback, errorCallback);
        return;
    }

    if (!('_options' in browserWindow)) {
        errorCallback(new Error(`No window options present for uuid: ${identity.uuid} name: ${identity.name}`));
        return;
    }

    let finalWidth = browserWindow._options.width;
    if (size.width) {
        finalWidth = size.relative ? finalWidth + size.width : size.width;
    }

    let finalHeight = browserWindow._options.height;
    if (size.height) {
        finalHeight = size.relative ? finalHeight + size.height : size.height;
    }

    const newBoundsWithinConstraints = areNewBoundsWithinConstraints(browserWindow._options, finalWidth, finalHeight);

    if (newBoundsWithinConstraints) {
        animations.getAnimationHandler().add(browserWindow, animationMeta, animationTween, callback, errorCallback);
    } else {
        errorCallback(new Error(`Proposed window bounds violate size constraints for uuid: ${identity.uuid} name: ${identity.name}`));
    }
}


export function bringToFront(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);
    if (!browserWindow) {
        return;
    }
    NativeWindow.bringToFront(browserWindow);
}

export function disableUserMovement(requestorIdentity: Identity, windowIdentity: Identity) {
    const browserWindow = getElectronBrowserWindow(windowIdentity);
    const windowKey = genWindowKey(windowIdentity);

    if (!browserWindow) {
        return;
    }

    let dframeRefCount = disabledFrameRef.get(windowKey) || 0;
    disabledFrameRef.set(windowKey, ++dframeRefCount);
    subscriptionManager.registerSubscription(disabledFrameUnsubDecorator(windowIdentity), requestorIdentity, `disable-frame-${windowKey}`);
    browserWindow.setUserMovementEnabled(false);
}

export function embed(identity: Identity, parentHwnd: string) {
    const browserWindow = getElectronBrowserWindow(identity);

    if (!browserWindow) {
        return;
    }

    if (isWin32) {
        browserWindow.setMessageObserver(WINDOWS_MESSAGE_MAP.WM_KEYDOWN, parentHwnd);
        browserWindow.setMessageObserver(WINDOWS_MESSAGE_MAP.WM_KEYUP, parentHwnd);
        browserWindow.setMessageObserver(WINDOWS_MESSAGE_MAP.WM_SYSKEYDOWN, parentHwnd);
        browserWindow.setMessageObserver(WINDOWS_MESSAGE_MAP.WM_SYSKEYUP, parentHwnd);
    }

    ofEvents.emit(route.window('embedded', identity.uuid, identity.name), {
        topic: 'window',
        type: 'window-embedded',
        name: identity.name,
        uuid: identity.uuid
    });
}

export function enableUserMovement(identity: Identity) {
    const windowKey = genWindowKey(identity);
    const browserWindow = getElectronBrowserWindow(identity);

    if (!browserWindow) {
        return;
    }

    if (disabledFrameRef.has(windowKey)) {
        let dframeRefCount = disabledFrameRef.get(windowKey) || 0;
        disabledFrameRef.set(windowKey, --dframeRefCount);
    }

    browserWindow.setUserMovementEnabled(true);
}

export function hide(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);
    if (!browserWindow) {
        return;
    }
    NativeWindow.hide(browserWindow);
}


export function mergeGroups(identity: Identity, grouping: Identity) {
    return WindowGroups.mergeGroups({ uuid: identity.uuid, name: identity.name }, { uuid: grouping.uuid, name: grouping.name });
}


export function minimize(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity, 'minimize');
    const minimizable = getOptFromBrowserWin('minimizable', browserWindow, true);
    if (minimizable) {
        NativeWindow.minimize(browserWindow);
    }
}


export function moveBy(identity: Identity, deltaLeft: number, deltaTop: number) {
    const browserWindow = getElectronBrowserWindow(identity);
    if (!browserWindow) {
        return;
    }
    NativeWindow.moveBy(browserWindow, { deltaLeft, deltaTop });
}


export function moveTo(identity: Identity, left: number, top: number) {
    const browserWindow = getElectronBrowserWindow(identity);
    if (!browserWindow) {
        return;
    }
    NativeWindow.moveTo(browserWindow, { left, top });
}
function wrap(uuid: string, name: string) {
    const win = coreState.getWindowByUuidName(uuid, name);
    if (!win) {
        throw new Error('Could Not Locate Window');
    }
    return win;
}
export function isNotification(name: string) {
    const noteGuidRegex = /^A21B62E0-16B1-4B10-8BE3-BBB6B489D862/;
    return noteGuidRegex.test(name);
}