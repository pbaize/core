import { WindowEvent, BaseEventMap, ApplicationEvent } from './base';
import { WindowAlertRequestedEvent, WindowAuthRequestedEvent, WindowEndLoadEvent, PropagatedWindowEvents } from './window';
import Bounds from '../window/bounds';

export interface CrashedEvent {
    reason: 'normal-termination' | 'abnormal-termination' | 'killed' | 'crashed' | 'still-running' | 'launch-failed' | 'out-of-memory';
}

export interface RunRequestedEvent<Topic, Type> extends ApplicationEvent<Topic, Type> {
    userAppConfigArgs: any;
}

export interface TrayIconClicked<Topic, Type> extends ApplicationEvent<Topic, Type> {
    button: 0 | 1 | 2;
    bounds: Bounds;
    x: number;
    y: number;
    monitorInfo: any;
}

export interface ApplicationEventMapping<Topic = string, Type = string> extends BaseEventMap {
    'closed': ApplicationEvent<Topic, Type>;
    'connected': ApplicationEvent<Topic, Type>;
    'crashed': CrashedEvent & ApplicationEvent<Topic, Type>;
    'initialized': ApplicationEvent<Topic, Type>;
    'manifest-changed': ApplicationEvent<Topic, Type>;
    'not-responding': ApplicationEvent<Topic, Type>;
    'responding': ApplicationEvent<Topic, Type>;
    'run-requested': RunRequestedEvent<Topic, Type>;
    'started': ApplicationEvent<Topic, Type>;
    'tray-icon-clicked': TrayIconClicked<Topic, Type>;
    'window-alert-requested': WindowAlertRequestedEvent<Topic, Type>;
    'window-auth-requested': WindowAuthRequestedEvent<Topic, Type>;
    'window-created': WindowEvent<Topic, Type>;
    'window-end-load': WindowEndLoadEvent<Topic, Type>;
    'window-not-responding': WindowEvent<Topic, Type>;
    'window-responding': WindowEvent<Topic, Type>;
    'window-show-requested': WindowEvent<Topic, Type>;
    'window-start-load': WindowEvent<Topic, Type>;
}

export interface PropagatedApplicationEventMapping<Topic = string, Type = string> {
    'application-closed': ApplicationEvent<Topic, Type>;
    'application-connected': ApplicationEvent<Topic, Type>;
    'application-crashed': CrashedEvent & ApplicationEvent<Topic, Type>;
    'application-initialized': ApplicationEvent<Topic, Type>;
    'application-manifest-changed': ApplicationEvent<Topic, Type>;
    'application-not-responding': ApplicationEvent<Topic, Type>;
    'application-responding': ApplicationEvent<Topic, Type>;
    'application-started': ApplicationEvent<Topic, Type>;
    'application-tray-icon-clicked': TrayIconClicked<Topic, Type>;
    'window-created': WindowEvent<Topic, Type>;
    'window-end-load': WindowEndLoadEvent<Topic, Type>;
    'window-not-responding': WindowEvent<Topic, Type>;
    'window-responding': WindowEvent<Topic, Type>;
    'window-start-load': WindowEvent<Topic, Type>;
}

export type ApplicationEvents = PropagatedWindowEvents<'application'> & {
    [Type in keyof ApplicationEventMapping]: ApplicationEventMapping<'application', Type>[Type];
};
export type PropagatedApplicationEvents<Topic> = {
    [Type in keyof PropagatedApplicationEventMapping]: PropagatedApplicationEventMapping<Topic, Type>[Type];
};