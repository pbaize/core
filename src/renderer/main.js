'use strict';

let fs = require('fs');
let path = require('path');
const coreState = require('../browser/core_state.js');

function readAdapterFromSearchPaths(searchPaths, packageFile) {
    let adapter = '';
    for (let adapterPath of searchPaths) {
        try {
            adapter = fs.readFileSync(path.join(process.resourcesPath, adapterPath, packageFile), 'utf8');
            break;
        } catch (error) {
            continue;
        }
    }
    return adapter;
}

// check resources/adapter/openfin-desktop.js then
// resources/adapter.asar/openfin-desktop.js
// for ease of developement
const searchPaths = ['adapter', 'adapter.asar'];
const jsAdapter = readAdapterFromSearchPaths(searchPaths, 'openfin-desktop.js');

// This order of lookup paths is taken from runtime/lib/browser/init.js
const searchPathsV2Api = [
    'default_app', 'core', 'app', 'core.asar', 'app.asar', 'default_app.asar'
].map(e => path.join(e, 'js-adapter'));
const jsAdapterV2 = readAdapterFromSearchPaths(searchPathsV2Api, 'js-adapter.js');

// Remove strict (Prevents, as of now, poorly understood memory lifetime scoping issues with remote module)
let me = fs.readFileSync(path.join(__dirname, 'api-decorator.js'), 'utf8');
me = me.slice(13);

const api = (windowId, initialOptions) => {
    const windowOptionSet = initialOptions || coreState.getWindowInitialOptionSet(windowId);
    const mainWindowOptions = windowOptionSet.options || {};
    const enableV2Api = (mainWindowOptions.experimental || {}).v2Api;
    const v2AdapterShim = (!enableV2Api ? '' : jsAdapterV2);
    const { uuid, name } = mainWindowOptions;
    windowOptionSet.runtimeArguments = JSON.stringify(coreState.args);
    windowOptionSet.licenseKey = coreState.getManifest({ uuid, name }).licenseKey;
    windowOptionSet.winId = windowId;

    return [
        `global.__startOptions = ${JSON.stringify(windowOptionSet)}`,
        me,
        jsAdapter,
        v2AdapterShim,
        `fin.__internal_.ipc = null`
    ].join(';');
};

module.exports.api = api;

module.exports.apiWithOptions = (windowId, contentsId) => {
    const initialOptions = coreState.getWindowInitialOptionSet(windowId);
    const entityInfo = coreState.getIdentityByWebcontentsId(windowId, contentsId);
    if (entityInfo) {
        Object.assign(initialOptions.options, entityInfo);
        initialOptions.entityInfo = entityInfo;
    }
    // break the remote link
    return JSON.stringify({
        apiString: api(windowId, initialOptions),
        initialOptions: initialOptions
    });
};
