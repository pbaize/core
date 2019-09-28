// build-in modules
/* tslint:disable:typedef no-empty */
const fs = require('fs');
const path = require('path');
import {BrowserWindow, app as electronApp, webContents, Menu, nativeImage } from 'electron';
let currentContextMenu = null;

// npm modules
const _ = require('underscore');
const crypto = require('crypto');
import * as Rx from 'rxjs';

// local modules
import animations from '../animations';
import { deletePendingAuthRequest, getPendingAuthRequest } from '../authentication_delegate';
import BoundsChangedStateTracker, { DeferedEvent } from '../bounds_changed_state_tracker';
const convertOptions = require('../convert_options.js');
import * as coreState from '../core_state';
import ExternalWindowEventAdapter from '../external_window_event_adapter';
import { cachedFetch } from '../cached_resource_fetcher';
const log = require('../log');
import ofEvents from '../of_events';
import SubscriptionManager from '../subscription_manager';
import WindowGroups from '../window_groups';
import { validateNavigation, navigationValidator } from '../navigation_validation';
import { toSafeInt } from '../../common/safe_int';
import route from '../../common/route';
import { FrameInfo } from './frame';
import { System } from './system';
import * as WebContents from './webcontents';
import { isFileUrl, isHttpUrl, getIdentityFromObject, isObject, mergeDeep } from '../../common/main';
import {
    DEFAULT_RESIZE_REGION_SIZE,
    DEFAULT_RESIZE_REGION_BOTTOM_RIGHT_CORNER,
    DEFAULT_RESIZE_SIDES,
    OpenFinWindow,
    Window,
    Identity,
    WindowOptions,
    SavedDiskBounds
} from '../../shapes';
import {
    ERROR_TITLE_RENDERER_CRASH,
    ERROR_BOX_TYPES,
    showErrorBox
} from '../../common/errors';
import * as NativeWindow from './native_window';
import { WINDOWS_MESSAGE_MAP } from '../../common/windows_messages';
import { getElectronWebContents } from '../api_protocol/api_handlers/webcontents';
import { Bounds, AnchorType } from '../../../js-adapter/src/shapes';
import { AckPayload, NackFunc } from '../api_protocol/transport_strategy/ack';

const subscriptionManager = new SubscriptionManager();
const isWin32 = process.platform === 'win32';
const windowPosCacheFolder = 'winposCache';
const disabledFrameRef = new Map();

const browserWindowEventMap = {
    'api-injection-disabled': {
        topic: 'api-injection-disabled'
    },
    'api-injection-failed': {
        topic: 'api-injection-failed'
    },
    'blur': {
        topic: 'blurred'
    },
    'synth-bounds-change': {
        topic: 'bounds-changing', // or bounds-changed
        decorator: boundsChangeDecorator
    },
    'close': {
        topic: 'close-requested',
        decorator: closeRequestedDecorator
    },
    'disabled-frame-bounds-changed': {
        topic: 'disabled-frame-bounds-changed',
        decorator: disabledFrameBoundsChangeDecorator
    },
    'disabled-frame-bounds-changing': {
        topic: 'disabled-frame-bounds-changing',
        decorator: disabledFrameBoundsChangeDecorator
    },
    'focus': {
        topic: 'focused'
    },
    'opacity-changed': {
        decorator: opacityChangedDecorator
    },
    'user-movement-disabled': {
        topic: 'frame-disabled'
    },
    'user-movement-enabled': {
        topic: 'frame-enabled'
    },
    'visibility-changed': {
        topic: 'hidden', // or 'shown'
        decorator: visibilityChangedDecorator
    },
    'maximize': {
        topic: 'maximized'
    },
    'minimize': {
        topic: 'minimized'
    },
    'restore': {
        topic: 'restored'
    },
    'resize': {
        topic: 'bounds-changing',
        decorator: boundsChangeDecorator
    },
    'unmaximize': {
        topic: 'restored'
    },
    'will-move': {
        topic: 'will-move',
        decorator: willMoveOrResizeDecorator
    },
    'will-resize': {
        topic: 'will-resize',
        decorator: willMoveOrResizeDecorator
    }
};


function genWindowKey(identity: Identity) {
    return `${identity.uuid}-${identity.name}`;
}

    // For the bounds stuff, looks like 5.0 does not take actions until the
    // window moves or has a resizing event. that is the same here. in the
    // future we can explicitly set them if, say, you are larger than a max
    // that you just set
const optionSetters = {
    contextMenu: (newVal: any, browserWin: BrowserWindow) => {
        // so old API still works
        const contextMenuBool = !!newVal;
        optionSetters.contextMenuSettings({ enable: contextMenuBool }, browserWin);
    },
    contextMenuSettings: (newVal: any, browserWin: BrowserWindow) => {
        if (!newVal ||
            (newVal.enable !== undefined && typeof newVal.enable !== 'boolean') ||
            (newVal.devtools !== undefined && typeof newVal.devtools !== 'boolean') ||
            (newVal.reload !== undefined && typeof newVal.reload !== 'boolean')) {
            return;
        }
        const val = Object.assign({}, getOptFromBrowserWin('contextMenuSettings', browserWin),
            newVal);
        setOptOnBrowserWin('contextMenuSettings', val, browserWin);
        setOptOnBrowserWin('contextMenu', val.enable, browserWin); // support for old api
        browserWin.setMenu(null);
        browserWin.webContents.updateContextMenuSettings(val);
    },
    customData: (newVal: any, browserWin: BrowserWindow) => {
        setOptOnBrowserWin('customData', newVal, browserWin);
    },
    frame: (newVal: any, browserWin: BrowserWindow) => {
        const frameBool = !!newVal;
        const prevBool = getOptFromBrowserWin('frame', browserWin, true);
        setOptOnBrowserWin('frame', frameBool, browserWin);
        browserWin.setHasFrame(frameBool);
        if (frameBool !== prevBool) {
            const maxWidth = getOptFromBrowserWin('maxWidth', browserWin, -1);
            const maxHeight = getOptFromBrowserWin('maxHeight', browserWin, -1);
            if (maxWidth !== -1 || maxHeight !== -1) {
                browserWin.setMaximumSize(maxWidth, maxHeight);
                const { width, height, x, y } = browserWin.getBounds();
                const setMaxWidth = maxWidth === -1 ? Number.MAX_SAFE_INTEGER : maxWidth;
                const setMaxHeight = maxHeight === -1 ? Number.MAX_SAFE_INTEGER : maxHeight;
                browserWin.setBounds({ width: Math.min(width, setMaxWidth), height: Math.min(height, setMaxHeight), x, y });
            }
            const minWidth = getOptFromBrowserWin('minWidth', browserWin, 0);
            const minHeight = getOptFromBrowserWin('minHeight', browserWin, 0);
            if (minWidth !== 0 || minHeight !== 0) {
                browserWin.setMinimumSize(minWidth, minHeight);
                const { width, height, x, y } = browserWin.getBounds();
                browserWin.setBounds({ width: Math.max(width, minWidth), height: Math.max(height, minHeight), x, y });
            }
        }
        if (!frameBool) {
            // reapply corner rounding
            const cornerRounding = getOptFromBrowserWin('cornerRounding', browserWin, {
                width: 0,
                height: 0
            });
            browserWin.setRoundedCorners(cornerRounding.width, cornerRounding.height);

            // reapply resize region
            applyAdditionalOptionsToWindowOnVisible(browserWin, () => {
                if (!browserWin.isDestroyed()) {
                    let resizeRegion = getOptFromBrowserWin('resizeRegion', browserWin, {});
                    resizeRegion = Object.assign({}, {
                        size: DEFAULT_RESIZE_REGION_SIZE,
                        bottomRightCorner: DEFAULT_RESIZE_REGION_BOTTOM_RIGHT_CORNER
                    }, resizeRegion);
                    browserWin.setResizeRegion(resizeRegion.size);
                    browserWin.setResizeRegionBottomRight(resizeRegion.bottomRightCorner);
                }
            });
        } else {
            // reapply top-left icon
            setTaskbar(browserWin, true);
        }
        applyAdditionalOptionsToWindowOnVisible(browserWin, () => {
            if (!browserWin.isDestroyed()) {
                const resizeRegion = getOptFromBrowserWin('resizeRegion', browserWin, {});
                const sides = Object.assign({}, DEFAULT_RESIZE_SIDES, resizeRegion.sides);
                browserWin.setResizeSides(sides.top, sides.right, sides.bottom, sides.left);
            }
        });
    },
    alphaMask: (newVal: any, browserWin: BrowserWindow) => {
        if (!newVal || typeof newVal.red !== 'number' || typeof newVal.green !== 'number' || typeof newVal.blue !== 'number') {
            return;
        }

        applyAdditionalOptionsToWindowOnVisible(browserWin, () => {
            if (!browserWin.isDestroyed()) {
                browserWin.setAlphaMask(newVal.red, newVal.green, newVal.blue);
            }
        });
        setOptOnBrowserWin('alphaMask', newVal, browserWin);
    },
    hideOnClose: (newVal: any, browserWin: BrowserWindow) => {
        const newHideOnCloseBool = !!newVal; // ensure bool
        const oldHideOnCloseBool = getOptFromBrowserWin('hideOnClose', browserWin, false);

        const uuid = browserWin._options.uuid;
        const name = browserWin._options.name;
        const openfinWindow = coreState.getWindowByUuidName(uuid, name) || <OpenFinWindow>{};
        const hideOnCloseListener = openfinWindow.hideOnCloseListener;
        const closeEventString = route.window('close-requested', uuid, name);

        if (newHideOnCloseBool && !oldHideOnCloseBool) {
            ofEvents.on(closeEventString, hideOnCloseListener);
        } else if (!newHideOnCloseBool && oldHideOnCloseBool) {
            ofEvents.removeListener(closeEventString, hideOnCloseListener);
        }

        setOptOnBrowserWin('hideOnClose', newHideOnCloseBool, browserWin);
    },
    alwaysOnTop: (newVal: any, browserWin: BrowserWindow) => {
        const onTopBool = !!newVal; // ensure bool

        browserWin.setAlwaysOnTop(onTopBool);
        setOptOnBrowserWin('alwaysOnTop', onTopBool, browserWin);
    },
    cornerRounding: (newVal: any, browserWin: BrowserWindow) => {
        if (!newVal || typeof newVal.width !== 'number' || typeof newVal.height !== 'number') {
            return;
        }

        const frame = getOptFromBrowserWin('frame', browserWin, true);
        if (!frame) {
            browserWin.setRoundedCorners(newVal.width, newVal.height);
        }
        setOptOnBrowserWin('cornerRounding', newVal, browserWin);
    },
    maxHeight: (newVal: any, browserWin: BrowserWindow) => {
        const maxWidth = getOptFromBrowserWin('maxWidth', browserWin, -1);

        browserWin.setMaximumSize(maxWidth, newVal);
        setOptOnBrowserWin('maxHeight', newVal, browserWin);
    },
    maxWidth: (newVal: any, browserWin: BrowserWindow) => {
        const maxHeight = getOptFromBrowserWin('maxHeight', browserWin, -1);

        browserWin.setMaximumSize(newVal, maxHeight);
        setOptOnBrowserWin('maxWidth', newVal, browserWin);
    },
    maximizable: (newVal: any, browserWin: BrowserWindow) => {
        const maxBool = !!newVal;

        browserWin.setMaximizable(maxBool);
        setOptOnBrowserWin('maximizable', maxBool, browserWin);
    },
    minimizable: (newVal: any, browserWin: BrowserWindow) => {
        const minBool = !!newVal;

        browserWin.setMinimizable(minBool);
        setOptOnBrowserWin('minimizable', minBool, browserWin);
    },
    minHeight: (newVal: any, browserWin: BrowserWindow) => {
        const minWidth = getOptFromBrowserWin('minWidth', browserWin, -1);

        browserWin.setMinimumSize(minWidth, newVal);
        setOptOnBrowserWin('minHeight', newVal, browserWin);
    },
    minWidth: (newVal: any, browserWin: BrowserWindow) => {
        const minHeight = getOptFromBrowserWin('minHeight', browserWin, -1);

        browserWin.setMinimumSize(newVal, minHeight);
        setOptOnBrowserWin('minWidth', newVal, browserWin);
    },
    opacity: (newVal: any, browserWin: BrowserWindow) => {
        if (typeof newVal !== 'number') {
            return;
        }

        const frame = getOptFromBrowserWin('frame', browserWin, true);
        if (frame) {
            // TODO Kick an error or deprecated message to the renderer process
            //      indicating that the opacity should only be set when frameless.
            //      5.0 allows you to do this, but it's not desireable
            //console.log('Opacity only supported on frameless windows');
        }

        let opacity = newVal;
        opacity = opacity < 0 ? 0 : opacity;
        opacity = opacity > 1 ? 1 : opacity;

        applyAdditionalOptionsToWindowOnVisible(browserWin, () => {
            if (!browserWin.isDestroyed()) {
                browserWin.setOpacity(opacity);
            }
        });
        setOptOnBrowserWin('opacity', opacity, browserWin);
    },
    resizable: (newVal: any, browserWin: BrowserWindow) => {
        const resizeBool = !!newVal; // ensure bool val

        browserWin.setResizable(resizeBool);
        setOptOnBrowserWin('resizable', resizeBool, browserWin);
    },
    icon: (newVal: any, browserWin: BrowserWindow) => {
        if (typeof newVal !== 'string') {
            return;
        }
        setOptOnBrowserWin('icon', newVal, browserWin);
        setTaskbarIcon(browserWin, getWinOptsIconUrl(browserWin._options));
    },
    taskbarIcon: (newVal: any, browserWin: BrowserWindow) => {
        if (typeof newVal !== 'string') {
            return;
        }
        setOptOnBrowserWin('taskbarIcon', newVal, browserWin);
        // NOTE: as long as 'icon' is defined, this will never have any effect
        setTaskbarIcon(browserWin, getWinOptsIconUrl(browserWin._options));
    },
    applicationIcon: (newVal: any, browserWin: BrowserWindow) => {
        if (typeof newVal !== 'string') {
            return;
        }
        setOptOnBrowserWin('applicationIcon', newVal, browserWin);
        // NOTE: as long as 'icon' and 'taskbarIcon' are defined, this will never have any effect
        setTaskbarIcon(browserWin, getWinOptsIconUrl(browserWin._options));
    },
    resizeRegion: (newVal: any, browserWin: BrowserWindow) => {
        if (newVal) {
            if (typeof newVal.size === 'number' && typeof newVal.bottomRightCorner === 'number') {


                applyAdditionalOptionsToWindowOnVisible(browserWin, () => {
                    if (!browserWin.isDestroyed()) {
                        const frame = getOptFromBrowserWin('frame', browserWin, true);
                        if (!frame) {
                            browserWin.setResizeRegion(newVal.size);
                            browserWin.setResizeRegionBottomRight(newVal.bottomRightCorner);
                        }
                    }
                });
            }
            if (typeof newVal.sides === 'object') {
                applyAdditionalOptionsToWindowOnVisible(browserWin, () => {
                    if (!browserWin.isDestroyed()) {
                        const sides = Object.assign({}, DEFAULT_RESIZE_SIDES, newVal.sides);
                        browserWin.setResizeSides(sides.top, sides.right,
                            sides.bottom, sides.left);
                    }
                });
            }
            setOptOnBrowserWin('resizeRegion', newVal, browserWin);
        }
    },
    aspectRatio: (newVal: any, browserWin: BrowserWindow) => {
        if (typeof (newVal) !== 'number') {
            return;
        }
        browserWin.setAspectRatio(newVal);
        setOptOnBrowserWin('aspectRatio', newVal, browserWin);
    },
    hasLoaded: (newVal: any, browserWin: BrowserWindow) => {
        if (typeof (newVal) === 'boolean') {
            browserWin._options.hasLoaded = newVal;
        }
    },
    showTaskbarIcon: (newVal: any, browserWin: BrowserWindow) => {
        const showTaskbarIconBool = !!newVal;
        setOptOnBrowserWin('showTaskbarIcon', showTaskbarIconBool, browserWin);
        browserWin.setSkipTaskbar(!showTaskbarIconBool);
    }
};

// tslint:disable-next-line:max-func-body-length
export function create(id: number, opts: WindowOptions) {
    let name = opts.name;
    let uuid = opts.uuid;
    const identity = {
        name,
        uuid
    };
    let baseOpts: WindowOptions;
    let browserWindow: BrowserWindow;
    let winWebContents: Electron.WebContents;
    let _options: WindowOptions;
    let _boundsChangedHandler;
    const groupUuid: string = null; // windows by default don't belong to any groups

    const hideReason = 'hide';
    const hideOnCloseListener = () => {
        const openfinWindow = coreState.getWindowByUuidName(uuid, name);
        if (openfinWindow) {
            openfinWindow.hideReason = 'hide-on-close';
            browserWindow.hide();
        }
    };

    const ofUnloadedHandler = (_eventObj: any, url: string, isReload: boolean) => {

        if (isReload) {
            emitReloadedEvent({
                uuid,
                name
            }, url);
        }

        ofEvents.emit(route.window('unload', uuid, name, false), identity);
        ofEvents.emit(route.window('init-subscription-listeners'), identity);
        ofEvents.emit(route.window('openfin-diagnostic/unload', uuid, name, true), url);
    };

    let _externalWindowEventAdapter: ExternalWindowEventAdapter;

    // we need to be able to handle the wrapped case, ie. don't try to
    // grab the browser window instance because it may not exist, or
    // perhaps just try ...
    if (!opts._noregister) {
        winWebContents = webContents.fromId(id);
        browserWindow = BrowserWindow.fromWebContents(winWebContents);

        //Legacy 5.0 feature, if customWindowAlert flag is found all alerts will be suppresed,
        //instead we will raise application event : 'window-alert-requested'.
        const appObj = coreState.getAppObjByUuid(identity.uuid);
        if (appObj && appObj._options.customWindowAlert) {
            handleCustomAlerts(id, opts);
        }
        // each window now inherits the main window's base options. this can
        // be made to be the parent's options if that makes more sense...
        baseOpts = coreState.getMainWindowOptions(id) || <WindowOptions>{};
        _options = convertOptions.convertToElectron(Object.assign({}, baseOpts, opts));
        if (!_.has(opts, 'permissions')) {
            delete _options.permissions;
        }

        // (taskbar) a child window should be grouped in with the application
        // if a taskbarIconGroup isn't specified
        _options.taskbarIconGroup = _options.taskbarIconGroup || baseOpts.uuid;

        // inherit from mainWindow unless specified
        _options.frameConnect = _options.frameConnect || baseOpts.frameConnect || 'last';

        // pass along if we should show once DOMContentLoaded. this gets used
        // in the api-decorator DOMContentLoaded listener
        _options.toShowOnRun = opts.toShowOnRun;

        // we need to know if this window has been loaded successfully at least once.
        _options.hasLoaded = false;

        uuid = _options.uuid;
        name = _options.name;

        const OF_WINDOW_UNLOADED = 'of-window-navigation';

        browserWindow._options = _options;

        // set taskbar icon
        setTaskbar(browserWindow);

        // apply options to browserWindow
        applyAdditionalOptionsToWindow(browserWindow);

        // Handles state tracking for bounds-chang(ed/ing) event tracking.
        // When a valid change state is detected, the event 'synth-bounds-change'
        // is emitted containing a majority of the 5.0 style payload
        //
        _boundsChangedHandler = new BoundsChangedStateTracker(uuid, name, browserWindow);

        // external window listeners
        if (browserWindow.isExternalWindow()) {
            _externalWindowEventAdapter = new ExternalWindowEventAdapter(browserWindow);
        }

        const windowTeardown = createWindowTearDown(identity, id, browserWindow, _boundsChangedHandler);

        // once the window is closed, be sure to close all the children
        // it may have and remove it from the
        browserWindow.on('close', (event) => {
            const ofWindow = coreState.getWindowByUuidName(uuid, name) || <OpenFinWindow>{};
            const closeEventString = route.window('close-requested', uuid, name);
            const listenerCount = ofEvents.listenerCount(closeEventString);

            // here we can only prevent electron windows, not external windows, from closing when the 'x' button is clicked.
            // external windows will need to be handled on the adapter side
            if (listenerCount && !ofWindow.forceClose && !browserWindow.isExternalWindow()) {
                if (!browserWindow.isDestroyed()) {
                    event.preventDefault();
                    return;
                }
            }

            ofEvents.emit(route.window('synth-close', uuid, name), {
                name,
                uuid,
                topic: 'window',
                type: 'synth-close'
            });

            // can't unhook when the 'closed' event fires; browserWindow is already destroyed then
            browserWindow.webContents.removeAllListeners('page-favicon-updated');

            // make sure that this uuid/name combo does not have any lingering close-requested subscriptions.
            ofEvents.removeAllListeners(closeEventString);
        });

        browserWindow.once('will-close', () => {
            const type = 'closing';
            windowTeardown()
                .then(() => log.writeToLog('info', `Window tear down complete ${uuid} ${name}`))
                .catch(err => {
                    log.writeToLog('info', `Error while tearing down ${uuid} ${name}`);
                    log.writeToLog('info', err);
                });
            ofEvents.emit(route.window(type, uuid, name), { topic: 'window', type: type, uuid, name });
        });

        const isMainWindow = (uuid === name);

        winWebContents.on('crashed', (event, killed, terminationStatus) => {
            // When the renderer crashes, remove blocking event listeners.
            // Removing 'close-requested' listeners will allow the crashed window to be closed manually easily.
            const closeRequested = route.window('close-requested', uuid, name);
            ofEvents.removeAllListeners(closeRequested);

            // Removing 'show-requested' listeners will allow the crashed window to be shown so it can be closed.
            const showRequested = route.window('show-requested', uuid, name);
            ofEvents.removeAllListeners(showRequested);

            if (isMainWindow) {
                coreState.setAppRunningState(uuid, false);

                // Show error box notifying the user of the crash
                const message =
                    'A crash occured in the renderer process of the ' +
                    `application with the UUID "${uuid}"`;
                const title = ERROR_TITLE_RENDERER_CRASH;
                const type = ERROR_BOX_TYPES.RENDERER_CRASH;
                const args = { message, title, type };
                showErrorBox(args);
            }
        });


        const mapEvents = () => {
            // todo this should be on demand, for now just blast them all
            Object.keys(browserWindowEventMap).forEach((evnt: keyof typeof browserWindowEventMap) => {
                const mappedMeta: {topic?: string, decorator?: (...args: any) => any} = browserWindowEventMap[evnt];
                const mappedTopic = mappedMeta.topic || '';

                const electronEventListener = (...args: any[]) => {

                    // if the window has already been removed from core_state,
                    // don't propagate anymore events
                    if (!coreState.getWindowByUuidName(uuid, name)) {
                        return;
                    }

                    // Bare minimum shape of an OpenFin window event payload
                    const payload = {

                        // todo: remove this hard-code
                        //reason: 'self',
                        name,
                        uuid,
                        topic: 'window',
                        type: mappedTopic //May be overridden by decorator
                    };

                    const decoratorFn = mappedMeta.decorator || noOpDecorator;

                    // Payload is modified by the decorator and returns true on success
                    if (decoratorFn(payload, args)) {
                        // Let the decorator apply changes to the type
                        ofEvents.emit(route.window(payload.type, uuid, name), payload);
                        // emit new 'user-movement-disabled' or 'user-movement-enabled' events in v2API
                        if (evnt === 'user-movement-disabled' || evnt === 'user-movement-enabled') {
                            const newPayload = _.clone(payload);
                            newPayload.type = evnt;
                            ofEvents.emit(route.window(newPayload.type, uuid, name), newPayload);
                        }

                        // emit new 'disabled-movement-bounds-changed' or 'disabled-movement-bounds-changing' events in v2API
                        if (evnt === 'disabled-frame-bounds-changed' || evnt === 'disabled-frame-bounds-changing') {
                            const newEventType = evnt === 'disabled-frame-bounds-changed'
                                ? 'disabled-movement-bounds-changed'
                                : 'disabled-movement-bounds-changing';
                            const newPayload = _.clone(payload);
                            newPayload.type = newEventType;
                            ofEvents.emit(route.window(newPayload.type, uuid, name), newPayload);
                        }
                    }
                };

                browserWindow.on(evnt, electronEventListener);
            });
        };

        mapEvents();
        WebContents.hookWebContentsEvents(winWebContents, { uuid, name }, 'window', route.window);
        // hideOnClose is deprecated; treat it as if it's just another
        // listener on the 'close-requested' event
        if (getOptFromBrowserWin('hideOnClose', browserWindow, false)) {
            const closeEventString = route.window('close-requested', uuid, name);
            ofEvents.on(closeEventString, hideOnCloseListener);
        }

        // Event listener for group changed
        const groupChangedEventString = 'group-changed';
        const groupChangedListener = (event: any) => {
            const _win = coreState.getWindowByUuidName(uuid, name) || <OpenFinWindow>{};
            const _groupUuid = _win.groupUuid || null;

            //if the groupUuid's match or the _win object has no uuid (the window has closed)
            if (event.groupUuid === _groupUuid || _win.uuid === void 0) {
                const payload = event.payload;

                payload.name = name;
                payload.uuid = _win.app_uuid || event.uuid;

                if (payload.reason === 'disband') {
                    payload.memberOf = 'nothing';
                } else if (payload.reason === 'leave') {
                    payload.memberOf = payload.sourceWindowName === name ? 'nothing' : 'source';
                } else {
                    const isSource = _.find(payload.sourceGroup, {
                        windowName: name
                    });
                    payload.memberOf = isSource ? 'source' : 'target';
                }

                ofEvents.emit(route.window(payload.type, uuid, name), payload);
            }
        };
        const groupChangedUnsubscribe = () => {
            WindowGroups.removeListener(groupChangedEventString, groupChangedListener);
        };

        WindowGroups.on(groupChangedEventString, groupChangedListener);
        subscriptionManager.registerSubscription(groupChangedUnsubscribe, identity, groupChangedEventString);

        // will-navigate URL for white/black listing
        const navValidator = navigationValidator(uuid, name, id);
        validateNavigation(winWebContents, identity, navValidator);

        const startLoadingSubscribe = (_event: any, url: string) => {
            ofEvents.emit(route.application('window-start-load', uuid), {
                name,
                uuid,
                url
            });
        };
        const startLoadingString = 'did-start-loading';
        winWebContents.on('did-start-loading', startLoadingSubscribe);
        const startLoadingUnsubscribe = () => {
            winWebContents.removeListener(startLoadingString, startLoadingSubscribe);
        };
        subscriptionManager.registerSubscription(startLoadingUnsubscribe, identity, startLoadingString);

        const documentLoadedSubscribe = (_event: any, isMain: boolean, documentName: string) => {
            if (isMain && uuid === name) { // main window
                ofEvents.emit(route.application('ready', uuid), {
                    type: 'ready',
                    uuid
                });
            }
            ofEvents.emit(route.application('window-end-load', uuid), {
                name,
                uuid,
                isMain,
                documentName
            });
        };
        const documentLoadedString = 'document-loaded';
        winWebContents.on(documentLoadedString, documentLoadedSubscribe);
        const documentLoadedUnsubscribe = () => {
            winWebContents.removeListener(documentLoadedString, documentLoadedSubscribe);
        };
        subscriptionManager.registerSubscription(documentLoadedUnsubscribe, identity, documentLoadedString);

        // picked up in src/browser/external_connection/interappbus_external_api.js
        // hooks up (un)subscribe listeners
        ofEvents.emit(route.window('init-subscription-listeners'), {
            name,
            uuid
        });

        const constructorCallbackMessage: AckPayload = {
            success: true
        };

        const emitErrMessage = (errCode: number) => {
            const chromeErrLink = 'https://cs.chromium.org/chromium/src/net/base/net_error_list.h';

            constructorCallbackMessage.success = false;
            constructorCallbackMessage.data = {
                networkErrorCode: errCode,
                message: `error #${errCode}. See ${chromeErrLink} for details`
            };

            ofEvents.emit(route.window('fire-constructor-callback', uuid, name), constructorCallbackMessage);
        };

        let resourceResponseReceivedHandler: (details: any) => void;
        let resourceLoadFailedHandler: (failed: any) => void;

        const resourceResponseReceivedEventString = route.window('resource-response-received', uuid, name);
        const resourceLoadFailedEventString = route.window('resource-load-failed', uuid, name);

        let httpResponseCode: number = null;

        resourceResponseReceivedHandler = (details) => {
            httpResponseCode = details.httpResponseCode;
            ofEvents.removeListener(resourceLoadFailedEventString, resourceLoadFailedHandler);
        };

        resourceLoadFailedHandler = (failed) => {
            if (failed.errorCode === -3) {
                // 304 can trigger net::ERR_ABORTED, ignore it
                electronApp.vlog(1, `ignoring net error -3 for ${failed.validatedURL}`);
            } else {
                emitErrMessage(failed.errorCode);
                ofEvents.removeListener(resourceResponseReceivedEventString, resourceResponseReceivedHandler);
            }
        };

        //Legacy logic where we wait for the API to 'connect' before we invoke the callback method.
        const apiInjectionObserver = Rx.Observable.create((observer: any) => {
            if (opts.url === 'about:blank') {
                winWebContents.once('did-finish-load', () => {
                    winWebContents.on(OF_WINDOW_UNLOADED, ofUnloadedHandler);
                    constructorCallbackMessage.data = {
                        httpResponseCode
                    };
                    observer.next(constructorCallbackMessage);
                });

            } else {
                ofEvents.once(resourceResponseReceivedEventString, resourceResponseReceivedHandler);
                ofEvents.once(resourceLoadFailedEventString, resourceLoadFailedHandler);
                ofEvents.once(route.window('connected', uuid, name), () => {
                    winWebContents.on(OF_WINDOW_UNLOADED, ofUnloadedHandler);
                    constructorCallbackMessage.data = {
                        httpResponseCode,
                        apiInjected: true
                    };
                    observer.next(constructorCallbackMessage);
                });
                ofEvents.once(route.window('api-injection-failed', uuid, name), () => {
                    electronApp.vlog(1, `api-injection-failed ${uuid}-${name}`);
                    // can happen if child window has a different domain.   @TODO allow injection for different domains
                    if (_options.autoShow) {
                        browserWindow.show();
                    }
                    constructorCallbackMessage.data = {
                        httpResponseCode,
                        apiInjected: false
                    };
                    observer.next(constructorCallbackMessage);
                });
                ofEvents.once(route.window('api-injection-disabled', uuid, name), () => {
                    electronApp.vlog(1, `api-injection-disabled ${uuid}-${name}`);
                    // can happen for chrome pages
                    browserWindow.show();
                    constructorCallbackMessage.data = {
                        httpResponseCode,
                        apiInjected: false
                    };
                    observer.next(constructorCallbackMessage);
                });
            }

        });

        //Restoring window positioning from disk cache.
        //We treat this as a check point event, either success or failure will raise the event.
        const windowPositioningObserver = Rx.Observable.create((observer: any) => {
            if (!_options.saveWindowState) {
                observer.next();
                //if saveWindowState:false and autoShow:true and waitForPageLoad:false are present
                //we show as soon as we restore the window position instead of waiting for the connected event
                if (_options.autoShow && (!_options.waitForPageLoad)) {
                    // Need to go through show here so that the show-requested logic comes into play
                    show(identity);
                }
            } else if (_options.waitForPageLoad) {
                browserWindow.once('ready-to-show', () => {
                    restoreWindowPosition(identity, () => observer.next());
                });
            } else {
                restoreWindowPosition(identity, () => {
                    //if autoShow:true and waitForPageLoad:false are present we show as soon as we restore the window position
                    //instead of waiting for the connected event
                    if (_options.autoShow) {
                        // Need to go through show here so that the show-requested logic comes into play
                        show(identity);
                    }
                    observer.next();
                });
            }
        });

        //We want to zip both event sources so that we get a single event only after both windowPositioning and apiInjection occur.
        const subscription = Rx.Observable.zip(apiInjectionObserver, windowPositioningObserver).subscribe((event: any) => {
            const constructorCallbackMessage = event[0];
            if (_options.autoShow || _options.toShowOnRun) {
                if (!browserWindow.isVisible()) {
                    show(identity);
                }
            }

            ofEvents.emit(route.window('fire-constructor-callback', uuid, name), constructorCallbackMessage);
            subscription.unsubscribe();
        });
    } // end noregister

    const winObj = {
        name,
        uuid,
        _options,
        id,
        browserWindow,
        groupUuid,
        hideReason,
        hideOnCloseListener,

        forceClose: false,


        app_uuid: uuid, // this is a 5.0 requirement


        children: <OpenFinWindow[]>[],
        frames: new Map(),
        isExternalWindow: () => false,

        // TODO this should be removed once it's safe in favor of the
        //      more descriptive browserWindow key
        _window: browserWindow,
        preloadScripts: (_options.preloadScripts || []),
        framePreloadScripts: {}// frame ID => [{url, state}]

    };

    if (!coreState.getWinObjById(id)) {
        coreState.deregisterPendingWindowName(uuid, name);
        coreState.setWindowObj(id, winObj);

        ofEvents.emit(route.application('window-created', uuid), {
            topic: 'application',
            type: 'window-created',
            uuid,
            name
        });
    }
    WebContents.setIframeHandlers(browserWindow.webContents, winObj, uuid, name);

    return winObj;
}

export function connected() { }

export function isEmbedded() { }

export function addEventListener(_identity: Identity, targetIdentity: Identity, type: string, listener: (...args: any[]) => void) {
    // TODO this leaves it up the the app to unsubscribe and is a potential
    // leak. perhaps we need a way to unhook when an app disconnects
    // automatically

    //should we check that the type is valid, probably...

    //should we check that the type is valid, probably...
    const eventString = route.window(type, targetIdentity.uuid, targetIdentity.name);
    const errRegex = /^Attempting to call a function in a renderer window that has been closed or released/;

    let unsubscribe;
    let safeListener: (...args: any[]) => void;
    let browserWinIsDead;

    //  for now, make a provision to auto-unhook if it fails to find
    //  the browser window

    //  TODO this needs to be added to the general unhook pipeline post
    //  the identity problem getting solved

    safeListener = (...args) => {

        try {
            listener.call(null, ...args);

        } catch (err) {

            browserWinIsDead = errRegex.test(err.message);

            // if we error the browser window that this used to reference
            // has been destroyed, just remove the listener
            if (browserWinIsDead) {
                ofEvents.removeListener(eventString, safeListener);
            }
        }
    };

    electronApp.vlog(1, `addEventListener ${eventString}`);

    ofEvents.on(eventString, safeListener);

    unsubscribe = () => {
        ofEvents.removeListener(eventString, safeListener);
    };
    return unsubscribe;
}

export function animate(identity: Identity, transitions: any, options: any = {}, callback = () => { }, errorCallback = (_e: any) => { }) {
    const browserWindow = getElectronBrowserWindow(identity);

    if (!browserWindow) {
        callback();
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

export function blur(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);

    if (!browserWindow) {
        return;
    }

    browserWindow.blur();
}

export function bringToFront(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);
    if (!browserWindow) {
        return;
    }
    NativeWindow.bringToFront(browserWindow);
}

export function center(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);
    if (!browserWindow) {
        return;
    }
    NativeWindow.center(browserWindow);
}


// TODO investigate the close sequence, there appears to be a case were you
// try to wrap and close an already closed window
export function close(identity: Identity, force: boolean = false, callback: (...args: any[]) => any = () => { }) {
    const browserWindow = getElectronBrowserWindow(identity);

    if (!browserWindow) {
        callback();
        return;
    }

    const payload = {
        force
    };

    const defaultAction = () => {
        if (!browserWindow.isDestroyed()) {
            const openfinWindow = coreState.getWindowByUuidName(identity.uuid, identity.name)
                || <OpenFinWindow>{};
            openfinWindow.forceClose = true;
            browserWindow.close();
        }
    };

    ofEvents.once(route.window('closed', identity.uuid, identity.name), () => {
        callback();
    });

    handleForceActions(identity, force, 'close-requested', payload, defaultAction);
}

function disabledFrameUnsubDecorator(identity: Identity) {
    const windowKey = genWindowKey(identity);
    return () => {
        let refCount = disabledFrameRef.get(windowKey) || 0;
        if (refCount > 1) {
            disabledFrameRef.set(windowKey, --refCount);
        } else {
            enableUserMovement(identity);
        }
    };
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

export function getBounds(identity: Identity): Bounds {
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

    const openfinWindow = coreState.getWindowByUuidName(identity.uuid, identity.name) || <OpenFinWindow>{};
    return WindowGroups.getGroup(openfinWindow.groupUuid);
}


export function getWindowInfo(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity, 'get info for');
    const { preloadScripts } = coreState.getWindowByUuidName(identity.uuid, identity.name) || <OpenFinWindow>{};
    const windowKey = genWindowKey(identity);
    const isUserMovementEnabled = !disabledFrameRef.has(windowKey) || disabledFrameRef.get(windowKey) === 0;
    return Object.assign({
        preloadScripts,
        isUserMovementEnabled
    }, WebContents.getInfo(browserWindow.webContents));
}


export function getAbsolutePath(identity: Identity, path?: string) {
    const browserWindow = getElectronBrowserWindow(identity, 'get URL for');
    //@ts-ignore
    return (path || path === 0) ? WebContents.getAbsolutePath(browserWindow.webContents, path) : '';
}


export function getNativeId(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity, 'get ID for');

    return browserWindow.nativeId;
}


export function getNativeWindow() { }

export function getOptions(identity: Identity) {
    // In the case that the identity passed does not exist, or is not a window,
    // return the entity info object. The fail case is used for frame identity on spin up.
    try {
        return getElectronBrowserWindow(identity, 'get options for')._options;
    } catch (e) {
        return System.getEntityInfo(identity);
    }
}

export function getParentWindow() { }

export async function getSnapshot(opts: { identity: Identity; payload: {area: Electron.Rectangle}; }) {
        const { identity, payload: { area } } = opts;
        const browserWindow = getElectronBrowserWindow(identity);

        if (!browserWindow) {
            throw new Error(`Unknown window named '${identity.name}'`);
        }

        const callback = (img: Electron.NativeImage) => img.toPNG().toString('base64');

        if (area === undefined) {
            // Snapshot of a full window
            return browserWindow.capturePage().then(callback);
        }

        if (!area ||
            typeof area !== 'object' ||
            typeof area.x !== 'number' ||
            typeof area.y !== 'number' ||
            typeof area.width !== 'number' ||
            typeof area.height !== 'number'
        ) {
            throw new Error('Invalid shape of the snapshot\'s area.');
        }

        // Snapshot of a specified area of the window
        return browserWindow.capturePage(<Electron.Rectangle>area).then(callback);
}


export function getState(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);
    if (!browserWindow) {
        return 'normal';
    }
    return NativeWindow.getState(browserWindow);
}


export function hide(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity);
    if (!browserWindow) {
        return;
    }
    NativeWindow.hide(browserWindow);
}

export function isNotification(name: string) {
    const noteGuidRegex = /^A21B62E0-16B1-4B10-8BE3-BBB6B489D862/;
    return noteGuidRegex.test(name);
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
    const openfinWindow = coreState.getWindowByUuidName(identity.uuid, identity.name);

    if (!browserWindow || !openfinWindow) {
        return;
    }

    return WindowGroups.leaveGroup(openfinWindow);
}


export function maximize(identity: Identity) {
    const browserWindow = getElectronBrowserWindow(identity, 'maximize');
    const maximizable = getOptFromBrowserWin('maximizable', browserWindow, true);
    if (maximizable) {
        NativeWindow.maximize(browserWindow);
    }
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

export function removeEventListener(identity: Identity, type: string, listener: (...args: any[]) => void) {
    const browserWindow = getElectronBrowserWindow(identity, 'remove event listener for');
    ofEvents.removeListener(route.window(type, browserWindow.webContents.id.toString()), listener);
}

function areNewBoundsWithinConstraints(options: WindowOptions, width: number, height: number) {
    const {
        minWidth,
        minHeight,
        maxWidth,
        maxHeight,
        aspectRatio
    } = options;

    if (typeof width !== 'number' && typeof height !== 'number') {
        return true;
    }

    if (typeof height !== 'number') {
        return (width >= minWidth) && (maxWidth === -1 || width <= maxWidth);
    }

    if (typeof width !== 'number') {
        return (height >= minHeight) && (maxHeight === -1 || height <= maxHeight);
    }

    const acceptableWidth = (width >= minWidth) && (maxWidth === -1 || width <= maxWidth);
    const acceptableHeight = (height >= minHeight) && (maxHeight === -1 || height <= maxHeight);

    // Check what the new aspect ratio would be at the proposed width/height. Precise to two decimal places.
    const roundedProposedRatio = Math.round(100 * (width / height)) / 100;
    const roundedAspectRatio = Math.round(100 * aspectRatio) / 100;

    return acceptableWidth && acceptableHeight && (aspectRatio <= 0 || roundedProposedRatio === roundedAspectRatio);
}

export function resizeBy(identity: Identity,
    deltaWidth: number,
    deltaHeight: number,
    anchor: AnchorType,
    callback: Function,
    errorCallback: Function) {
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
        callback();
    } else {
        errorCallback(new Error(`Proposed window bounds violate size constraints for uuid: ${identity.uuid} name: ${identity.name}`));
    }
}


export function resizeTo(identity: Identity,
    width: number,
    height: number,
    anchor: AnchorType,
    callback: Function,
    errorCallback: Function) {
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
        callback();
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


export function setBounds(identity: Identity,
    left: number,
    top: number,
    width: number,
    height: number,
    callback: Function,
    errorCallback: Function) {
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
        callback();
    } else {
        errorCallback(new Error(`Proposed window bounds violate size constraints for uuid: ${identity.uuid} name: ${identity.name}`));
    }
}


export function show(identity: Identity, force = false) {
    const browserWindow = getElectronBrowserWindow(identity);

    if (!browserWindow) {
        return;
    }

    const payload = {};
    const defaultAction = () => NativeWindow.show(browserWindow);

    handleForceActions(identity, force, 'show-requested', payload, defaultAction);
}


export function showAt(identity: Identity, left: number, top: number, force = false) {
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

export function showMenu(identity: Identity, x: number, y: number, editable: boolean, hasSelectedText: boolean) {
    const browserWindow = getElectronBrowserWindow(identity);

    if (!browserWindow) {
        return;
    }

    const menuTemplate = [];

    if (editable) {
        menuTemplate.push({
            label: 'Cut',
            click: () => {
                browserWindow.webContents.cut();
            },
            accelerator: 'CommandOrControl+X',
            enabled: hasSelectedText
        });
        menuTemplate.push({
            label: 'Copy',
            click: () => {
                browserWindow.webContents.copy();
            },
            accelerator: 'CommandOrControl+C',
            enabled: hasSelectedText
        });
        menuTemplate.push({
            label: 'Paste',
            click: () => {
                browserWindow.webContents.paste();
            },
            accelerator: 'CommandOrControl+V'
        });
        menuTemplate.push({
            label: 'Select all',
            click: () => {
                browserWindow.webContents.selectAll();
            },
            accelerator: 'CommandOrControl+A'
        });
        menuTemplate.push({
            type: 'separator'
        });
    }
    menuTemplate.push({
        label: 'Reload',
        click: () => {
            browserWindow.webContents.reloadIgnoringCache();
        }
    }, {
        label: 'Reload app and restart children',
        click: () => {
            try {
                const Application = require('./application.js').Application;
                const app = Application.wrap(identity.uuid);

                Application.getChildWindows(identity).forEach((childWin: Identity) => {
                    close({
                        name: childWin.name,
                        uuid: childWin.uuid
                    }, true);
                });

                app.mainWindow.webContents.reloadIgnoringCache();
            } catch (e) {
                // console.log(e);
            }
        }
    }, {
        type: 'separator'
    }, {
        label: 'Inspect element',
        click: () => {
            browserWindow.webContents.inspectElement(x, y);
        },
        accelerator: 'CommandOrControl+Shift+I'
    });
    //@ts-ignore
    currentContextMenu = Menu.buildFromTemplate(menuTemplate);
    currentContextMenu.popup({
        window: browserWindow,
        //@ts-ignore
        async: true,
        callback: () => {
            currentContextMenu = null;
        }
    });
}

export function defineDraggableArea() { }

type UpdatableOption = keyof typeof optionSetters;
function isOption(opt: string): opt is UpdatableOption {
    return optionSetters.hasOwnProperty(opt);
}
export function updateOptions(identity: Identity, updateObj: Partial<WindowOptions>) {
    const browserWindow = getElectronBrowserWindow(identity, 'update settings for');
    const { uuid, name } = identity;
    const diff: any = {};
    const invalidOptions: string[] = [];
    const clone = <T>(obj: T): T => obj === undefined
        ? obj
        : JSON.parse(JSON.stringify(obj)); // this works here, but has limitations; reuse with caution.

    try {
        Object.keys(updateObj).forEach(opt => {

            if (isOption(opt)) {
                const oldVal = clone(getOptFromBrowserWin(opt, browserWindow));
                optionSetters[opt](updateObj[opt], browserWindow);
                const newVal = clone(getOptFromBrowserWin(opt, browserWindow));


                if (!_.isEqual(oldVal, newVal)) {
                    diff[opt] = { oldVal, newVal };
                }
            } else {
                invalidOptions.push(opt);
            }
        });

        const options = browserWindow && clone(browserWindow._options);
        if (Object.keys(diff).length) {
            ofEvents.emit(route.window('options-changed', uuid, name), { uuid, name, options, diff, invalidOptions });
        }
    } catch (e) {
        // console.log(e.message);
    }
}

export function exists(identity: Identity) {
    return coreState.windowExists(identity.uuid, identity.name);
}

export function getBoundsFromDisk(identity: Identity, callback: (data: SavedDiskBounds) => void, errorCallback: NackFunc) {
    getBoundsCacheSafeFileName(identity, (cacheFile: string) => {
        try {
            fs.readFile(cacheFile, 'utf8', (err: string | Error, data: string) => {
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

export function authenticate(identity: Identity, username: string, password: string, callback: (e?: Error | string) => void) {
    const {
        authCallback
    } = getPendingAuthRequest(identity);

    if (authCallback && typeof (authCallback) === 'function') {
        authCallback(username, password);
        deletePendingAuthRequest(identity);
        callback();
    } else {
        callback(new Error('No authentication request pending for window'));
    }
}

export function registerWindowName(identity: Identity) {
    coreState.registerPendingWindowName(identity.uuid, identity.name);
}

export function getViews({ uuid, name }: Identity) {
    return coreState.getAllViews()
        .filter(v => v.target.uuid === uuid && v.target.name === name)
        .map(({ uuid, name }) => ({ uuid, name }));
}

function emitCloseEvents(identity: Identity) {
    const { uuid, name } = identity;

    ofEvents.emit(route.window('unload', uuid, name, false), identity);
    ofEvents.emit(route.window('openfin-diagnostic/unload', uuid, name, true), identity);

    electronApp.emit('browser-window-closed', null, getElectronBrowserWindow(identity));

    ofEvents.emit(route.window('closed', uuid, name, true), {
        topic: 'window',
        type: 'closed',
        uuid,
        name
    });

    ofEvents.emit(route.window('init-subscription-listeners'), identity);
}

function emitReloadedEvent(identity: Identity, url: string) {
    const {
        uuid,
        name
    } = identity;

    ofEvents.emit(route.window('reloaded', uuid, name), {
        uuid,
        name,
        url
    });
}

function createWindowTearDown(identity: Identity,
    id: number,
    browserWindow: BrowserWindow,
    _boundsChangedHandler: BoundsChangedStateTracker
) {
    const promises: Promise<any>[] = [];

    //we want to treat the close events as a step in the teardown, wrapping it in a promise.
    promises.push(new Promise(resolve => {
        browserWindow.once('closed', resolve);
    }));

    //wrap the operation of closing a child window in a promise.
    function closeChildWin(childId: number) {
        return new Promise((resolve, _reject) => {
            const child = coreState.getWinObjById(childId);

            // TODO right now this is forceable to handle the event that there was a close
            //      requested on a child window and the main window closes. This needs
            //      looking into
            if (child) {
                const childIdentity = {
                    name: child.name,
                    uuid: child.uuid
                };

                close(childIdentity, true, () => {
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    //Even if disk operations fail we need to resolve this promise to avoid zombie processes.
    function handleSaveStateAlwaysResolve() {
        return new Promise((resolve, _reject) => {
            if (browserWindow._options.saveWindowState) {
                const zoomLevel = browserWindow.webContents.getZoomLevel();
                const cachedBounds = _boundsChangedHandler.getCachedBounds();
                saveBoundsToDisk(identity, cachedBounds, zoomLevel, (err: any) => {
                    if (err) {
                        log.writeToLog('info', err);
                    }
                    // These were causing an exception on close if the window was reloaded
                    _boundsChangedHandler.teardown();
                    resolve();
                });
            } else {
                _boundsChangedHandler.teardown();
                resolve();
            }
        });
    }

    //Window tear down will:
    //    Update core state by removing the window.
    //    Save the window state to disk
    //    Close all child windows
    //    Wait for the close event.
    return () => {
        const ofWindow = coreState.getWindowByUuidName(identity.uuid, identity.name);
        if (!ofWindow) {
            return;
        }
        const childWindows = coreState.getChildrenByWinId(id) || [];
        // remove from core state earlier rather than later
        coreState.removeChildById(id);

        // remove window from any groups it belongs to
        promises.push(WindowGroups.leaveGroup(ofWindow));

        promises.push(handleSaveStateAlwaysResolve());

        childWindows.forEach(childId => {
            promises.push(closeChildWin(childId));
        });

        return Promise.all(promises).then(() => {
            emitCloseEvents(identity);
            browserWindow.removeAllListeners();
        });
    };
}

function saveBoundsToDisk(identity: Identity, bounds: any, zoomLevel: number, callback: any) {
    getBoundsCacheSafeFileName(identity, (cacheFile: any) => {
        const data = {
            'active': 'true',
            'height': bounds.height,
            'width': bounds.width,
            'left': bounds.x,
            'top': bounds.y,
            'name': identity.name,
            'windowState': bounds.windowState,
            'zoomLevel': zoomLevel
        };

        try {
            const userCache = electronApp.getPath('userCache');
            fs.mkdir(path.join(userCache, windowPosCacheFolder), () => {
                fs.writeFile(cacheFile, JSON.stringify(data), (writeFileErr: any) => {
                    callback(writeFileErr);
                });
            });
        } catch (err) {
            callback(err);
        }
    }, callback);
}

//make sure the uuid/names with special characters do not break the bounds cache.
function getBoundsCacheSafeFileName(identity: Identity, callback: (fileName: string) => void, errorCallback: (E: Error) => void) {
    const userCache = electronApp.getPath('userCache');

    // new hashed file name
    const hash = crypto.createHash('sha256');
    hash.update(identity.uuid);
    hash.update(identity.name);
    const safeName = hash.digest('hex');
    const newFileName = path.join(userCache, windowPosCacheFolder, `${safeName}.json`);

    try {
        fs.access(newFileName, fs.constants.F_OK, (newFileErr: any) => {
            if (newFileErr) { // new file name doesn't exist
                // current old style file name
                const oldSafeName = new Buffer(identity.uuid + '-' + identity.name).toString('hex');
                const oldFileName = path.join(userCache, windowPosCacheFolder, `${oldSafeName}.json`);

                // check if an old file name exists
                fs.access(oldFileName, fs.constants.F_OK, (oldFileErr: any) => {
                    if (!oldFileErr) { // if it exists, rename it by a new file name.
                        fs.rename(oldFileName, newFileName, () => {
                            callback(newFileName);
                        });
                    } else {
                        callback(newFileName);
                    }
                });
            } else {
                callback(newFileName);
            }
        });
    } catch (err) {
        errorCallback(err);
    }
}

function applyAdditionalOptionsToWindowOnVisible(browserWindow: BrowserWindow, callback: () => void) {
    if (browserWindow.isVisible()) {
        callback();
    } else {
        browserWindow.once('visibility-changed', (_event: any, isVisible: any) => {
            if (isVisible) {
                if (browserWindow.isVisible()) {
                    callback();
                    // Version 8: Will be visible on the next tick
                    // TODO: Refactor to also use 'ready-to-show'
                } else {
                    setTimeout(() => {
                        callback();
                    }, 1);
                }
            }
        });
    }
}


function handleForceActions(identity: Identity, force: boolean, eventType: string, eventPayload: any, defaultAction: () => void) {
    const appEventString = route.application(`window-${eventType}`, identity.uuid);
    const winEventString = route.window(eventType, identity.uuid, identity.name);
    let listenerCount = ofEvents.listenerCount(winEventString);

    if (eventType === 'show-requested') {
        listenerCount += ofEvents.listenerCount(appEventString);
    }

    if (!listenerCount || force) {
        defaultAction();
    } else {
        eventPayload.name = identity.name;
        eventPayload.uuid = identity.uuid;
        eventPayload.type = eventType;
        eventPayload.topic = 'window';

        ofEvents.emit(winEventString, eventPayload);
    }
}


function applyAdditionalOptionsToWindow(browserWindow: BrowserWindow) {
    const options = browserWindow && browserWindow._options;

    if (!options) {
        return;
    }

    browserWindow.setTaskbarGroup(options.taskbarIconGroup);

    // frameless window updates
    if (!options.frame) {
        // rounded corners
        browserWindow.setRoundedCorners(options.cornerRounding.width, options.cornerRounding.height);
    }

    applyAdditionalOptionsToWindowOnVisible(browserWindow, () => {
        if (!browserWindow.isDestroyed()) {
            // set alpha mask if present, otherwise set opacity if present
            if (options.alphaMask.red > -1 && options.alphaMask.green > -1 && options.alphaMask.blue > -1) {
                browserWindow.setAlphaMask(options.alphaMask.red, options.alphaMask.green, options.alphaMask.blue);
            } else if (options.opacity < 1) {
                browserWindow.setOpacity(options.opacity);
            }

            // set aspect ratio if present
            if (options.aspectRatio > 0) {
                browserWindow.setAspectRatio(options.aspectRatio);
            }

            // set minimized or maximized
            if (options.state === 'minimized') {
                browserWindow.minimize();
            } else if (options.state === 'maximized') {
                browserWindow.maximize();
            }

            // frameless window updates
            if (!options.frame) {
                // resize region
                browserWindow.setResizeRegion(options.resizeRegion.size);
                browserWindow.setResizeRegionBottomRight(options.resizeRegion.bottomRightCorner);
            }
            browserWindow.setResizeSides(options.resizeRegion.sides.top, options.resizeRegion.sides.right,
                options.resizeRegion.sides.bottom, options.resizeRegion.sides.left);
        }
    });
}


function getOptFromBrowserWin(opt: keyof WindowOptions, browserWin: BrowserWindow, defaultVal?: any) {
    const opts = browserWin && browserWin._options;
    const optVal = opts && opts[opt];

    if (optVal === undefined) {
        return defaultVal;
    }

    return optVal;
}


function setOptOnBrowserWin<T extends keyof WindowOptions>(opt: T, newValue: WindowOptions[T], browserWin: BrowserWindow) {
    const options = browserWin && browserWin._options;

    if (options) {
        const oldValue = options[opt];

        if (isObject(oldValue) && isObject(newValue)) {
            mergeDeep(oldValue, newValue);
        } else {
            options[opt] = newValue;
        }
    }
}


function closeRequestedDecorator(payload: { force: boolean; }) {
    const propagate = true;

    payload.force = false;

    return propagate;
}

function boundsChangeDecorator(payload: any, args: any[]) {
    const boundsChangePayload = args[0];
    const payloadIsObject = typeof boundsChangePayload === 'object';
    const requiredKeys = ['top', 'left', 'reason', 'width', 'height'];
    const commonKeys = _.intersection(_.keys(boundsChangePayload), requiredKeys);
    const allRequiredKeysPresent = commonKeys.length === requiredKeys.length;
    const shouldExtendPayload = payloadIsObject && allRequiredKeysPresent;

    if (shouldExtendPayload) {
        Object.keys(boundsChangePayload).forEach((key) => {
            payload[key] = boundsChangePayload[key];
        });

        const _win = coreState.getWindowByUuidName(payload.uuid, payload.name);
        const _browserWin = _win && _win.browserWindow;
        setOptOnBrowserWin('x', payload.left, _browserWin);
        setOptOnBrowserWin('y', payload.top, _browserWin);
        setOptOnBrowserWin('width', payload.width, _browserWin);
        setOptOnBrowserWin('height', payload.height, _browserWin);

        return true;
    } else {
        return false;
    }
}


function disabledFrameBoundsChangeDecorator(payload: DeferedEvent, args: any[]) {
    let propogate = false;

    if (args.length >= 3) {
        const bounds = args[1];
        const type = args[2];

        payload.changeType = type;
        payload.left = bounds.x;
        payload.top = bounds.y;
        payload.width = bounds.width;
        payload.height = bounds.height;
        payload.deferred = false;
        propogate = true;
    }

    return propogate;
}

function willMoveOrResizeDecorator(payload: any, args: { x: any; y: any; height: any; width: any; }[]) {
    const { x, y, height, width } = args[1];
    const monitorInfo = System.getMonitorInfo();
    const monitorScaleFactor = monitorInfo.deviceScaleFactor;
    Object.assign(payload, {
        monitorScaleFactor,
        left: x,
        top: y,
        height,
        width
    });
    return true;
}

function opacityChangedDecorator(payload: { uuid: string; name: string; }, args: number[]) {
    const _win = coreState.getWindowByUuidName(payload.uuid, payload.name);
    const _browserWin = _win && _win.browserWindow;
    setOptOnBrowserWin('opacity', args[1], _browserWin);
    return false;
}

function visibilityChangedDecorator(payload: { type: string; uuid: string; name: string; reason: string; }, args: [any, any, any]) {
    let propogate = false;

    if (args.length >= 2) {
        const [, visible, closing] = args;

        if (visible) {
            payload.type = 'shown';
            const uuid = payload.uuid;
            if (uuid && !coreState.sentFirstHideSplashScreen(uuid)) {
                // TODO: Move this require to the top of file during future 'dependency injection refactor'
                // must delay 'application.js'
                // require until ready due to circular dependency between application and window(things will break otherwise)
                const emitHideSplashScreen = require('./application.js').Application.emitHideSplashScreen;
                emitHideSplashScreen({
                    uuid
                });
                coreState.setSentFirstHideSplashScreen(uuid, true);
            }
        } else {
            const openfinWindow = coreState.getWindowByUuidName(payload.uuid, payload.name) || <OpenFinWindow>{};
            const { hideReason } = openfinWindow;
            payload.type = 'hidden';
            payload.reason = hideReason === 'hide' && closing ? 'closing' : hideReason;
            // reset to 'hide' in case visibility changes
            // due to a non-API related reason
            openfinWindow.hideReason = 'hide';
        }

        propogate = true;
    }

    return propogate;
}


function noOpDecorator() {

    return true;
}

function setTaskbar(browserWindow: BrowserWindow, forceFetch = false) {
    const options = browserWindow._options;

    setBlankTaskbarIcon(browserWindow);

    // If the window isn't loaded by a URL, or is "about:blank", then the
    // page-favicon-updated event never fires (explained below). In this case
    // we try the window options and if that fails we get the icon info
    // from the main window.
    if (!isHttpUrl(options.url)) {
        let _url = getWinOptsIconUrl(options);

        // v6 needs to match v5's behavior: if the window url is a file uri,
        // then icon can be either a file path, file uri, or url
        if (!isHttpUrl(_url) && !isFileUrl(_url)) {
            _url = 'file:///' + _url;
        }

        // try the window icon options first
        setTaskbarIcon(browserWindow, _url, () => {
            if (!browserWindow.isDestroyed()) {
                // if not, try using the main window's icon
                setTaskbarIcon(browserWindow, getMainWinIconUrl(browserWindow.webContents.id));
            }
        });

        return;
    }

    // When a page loads, Electron fires the page-favicon-updated event
    // which signals the core to fetch/set the taskbar icon. The core
    // first tries to use the icon info provided by the window options.
    // If that fails, then it tries to use the list of favicons provided by
    // the page-favicon-updated event. Finally, if that fails, it'll grab
    // the icon info from the main window and use that. By default, the
    // taskbar icon is blank.
    browserWindow.webContents.on('page-favicon-updated', (_event: any, urls: any[]) => {
        // try the window icon options first
        setTaskbarIcon(browserWindow, getWinOptsIconUrl(options), () => {
            if (!browserWindow.isDestroyed()) {
                // if not, try any favicons that were found
                const _url = urls && urls[0];
                setTaskbarIcon(browserWindow, _url, () => {
                    if (!browserWindow.isDestroyed()) {
                        // if not, try using the main window's icon
                        setTaskbarIcon(browserWindow, getMainWinIconUrl(browserWindow.webContents.id));
                    }
                });
            }
        });
    });

    if (forceFetch) {
        // try the window icon options first
        setTaskbarIcon(browserWindow, getWinOptsIconUrl(options), () => {
            if (!browserWindow.isDestroyed()) {
                // if not, try using the main window's icon
                setTaskbarIcon(browserWindow, getMainWinIconUrl(browserWindow.webContents.id));
            }
        });
    }
}

function setTaskbarIcon(browserWindow: BrowserWindow, iconUrl: string, errorCallback = () => { }) {
    const identity = getIdentityFromObject(browserWindow._options);

    cachedFetch(identity, iconUrl, (error, iconFilepath) => {
        if (!error) {
            setIcon(browserWindow, iconFilepath, errorCallback);
        } else {
            errorCallback();
        }
    });
}

function setIcon(browserWindow: BrowserWindow, iconFilepath: string, errorCallback = () => { }) {
    if (!browserWindow.isDestroyed()) {
        const icon = nativeImage.createFromPath(iconFilepath);
        if (icon.isEmpty()) {
            errorCallback();
        } else {
            browserWindow.setIcon(icon);
        }
    }
}

function setBlankTaskbarIcon(browserWindow: BrowserWindow) {
    setIcon(browserWindow, path.resolve(`${__dirname}/../../../assets/blank.ico`));
}

function getMainWinIconUrl(id: number) {
    const options = coreState.getMainWindowOptions(id) || {};
    return getWinOptsIconUrl(options);
}

function getWinOptsIconUrl(options: { icon?: any; taskbarIcon?: any; applicationIcon?: any; }) {
    return options.icon || options.taskbarIcon || options.applicationIcon;
}

//This is a legacy 5.0 feature used from embedded.
function handleCustomAlerts(id: number, opts: WindowOptions) {
    const wc = webContents.fromId(id);
    const browserWindow = BrowserWindow.fromWebContents(wc);
    const subTopic = 'alert';
    const type = 'window-alert-requested';
    const topic = 'application';
    //We will need to keep the subscribe/unsubscribe functions avilable to do proper clean up.
    function subscription(e: any, args: any) {
        const message = args[0][0];
        const payload = {
            uuid: opts.uuid,
            name: opts.name,
            message: message,
            url: browserWindow.webContents.getURL(),
            topic: topic,
            type: type
        };
        if (typeof (e.preventDefault) === 'function') {
            e.preventDefault();
        }
        ofEvents.emit(route(topic, type, opts.uuid), payload);
    }

    function unsubscribe() {
        if (browserWindow) {
            browserWindow.removeListener(subTopic, subscription);
        }
    }

    browserWindow.on(subTopic, subscription);
    subscriptionManager.registerSubscription(unsubscribe, {
        uuid: opts.uuid,
        name: opts.name
    }, type, id);
}

//If unknown window AND `errDesc` provided, throw error; otherwise return (possibly undefined) browser window ref.
export function getElectronBrowserWindow(identity: Identity, errDesc?: string) {
    const openfinWindow = coreState.getWindowByUuidName(identity.uuid, identity.name);
    const browserWindow = openfinWindow && openfinWindow.browserWindow;

    if (errDesc && !browserWindow) {
        throw new Error(`Could not ${errDesc} unknown window named '${identity.name}'`);
    }

    return browserWindow;
}

function restoreWindowPosition(identity: Identity, cb: () => void) {
    getBoundsFromDisk(identity, (savedBounds: SavedDiskBounds) => {

        const monitorInfo = System.getMonitorInfo();

        if (!boundsVisible(savedBounds, monitorInfo)) {
            const displayRoot = System.getNearestDisplayRoot({
                x: savedBounds.left,
                y: savedBounds.top
            });

            savedBounds.top = displayRoot.y;
            savedBounds.left = displayRoot.x;
        }

        const browserWindow = getElectronBrowserWindow(identity);
        const { left, top, width, height } = savedBounds;
        NativeWindow.setBounds(browserWindow, { left, top, width, height });

        switch (savedBounds.windowState) {
            case 'maximized':
                maximize(identity);
                break;
            case 'minimized':
                minimize(identity);
                break;
        }

        // set zoom level
        const { zoomLevel } = savedBounds;
        WebContents.setZoomLevel(getElectronWebContents(identity), zoomLevel);
        cb();
    }, (err: any) => {
        //We care about errors but lets keep window creation going.
        log.writeToLog('info', err);
        cb();
    });
}
export function getWindowMeta({ openfinWindow }: Window) {
    const identity = getIdentityFromObject(openfinWindow);
    const bounds: any = getBounds(identity);
    bounds.name = openfinWindow.name;
    bounds.state = getState(identity);
    bounds.isShowing = isShowing(identity);
    return bounds;
}

function intersectsRect(bounds: Bounds, rect: Bounds) {
    return !(bounds.left > rect.right
        || (bounds.left + bounds.width) < rect.left
        || bounds.top > rect.bottom
        || (bounds.top + bounds.height) < rect.top);
}

function boundsVisible(bounds: Bounds, monitorInfo: { primaryMonitor: any; nonPrimaryMonitors: any; }) {
    let visible = false;
    const monitors = [monitorInfo.primaryMonitor].concat(monitorInfo.nonPrimaryMonitors);

    for (let i = 0; i < monitors.length; i++) {
        if (intersectsRect(bounds, monitors[i].monitorRect)) {
            visible = true;
        }
    }
    return visible;
}
