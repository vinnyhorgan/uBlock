/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2014-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

// krimium: what uBO's content scripts use of the extension API, in the
// world krimium gives them in every frame, "ubo", which the page's own
// scripts cannot reach. krimium's module in the web process puts
// `krimiumBridge` there before any of them runs: post() carries a string to
// uBO's background page, and krimium calls receive() with what comes back.
// A port is runtime.connect()'s, as Chromium has it.
//
// uBO's own pages (its popup, dashboard, logger, picker) get this too, in
// their own world, with what else they use: the manifest and the messages,
// which krimium hands over as `krimiumBridge.page`.

'use strict';

(( ) => {

const bridge = self.krimiumBridge;
if ( bridge instanceof Object === false ) { return; }
if ( self.chrome instanceof Object && self.chrome.runtime instanceof Object ) { return; }

// WebKit has no idle callbacks; uBO only uses them to put work off a little.
if ( self.requestIdleCallback === undefined ) {
    self.requestIdleCallback = (fn, options) => self.setTimeout(( ) => {
        fn({ didTimeout: true, timeRemaining: ( ) => 0 });
    }, Math.min(options?.timeout ?? 1, 1));
    self.cancelIdleCallback = id => { self.clearTimeout(id); };
}

class Event {
    constructor() {
        this.listeners = [];
    }
    addListener(fn) {
        if ( this.listeners.includes(fn) ) { return; }
        this.listeners.push(fn);
    }
    removeListener(fn) {
        this.listeners = this.listeners.filter(a => a !== fn);
    }
    hasListener(fn) {
        return this.listeners.includes(fn);
    }
    emit(...args) {
        for ( const fn of this.listeners.slice() ) {
            try { fn(...args); } catch (ex) { console.error(ex); }
        }
    }
}

const ports = new Map();

const post = data => {
    bridge.post(JSON.stringify(data));
};

bridge.receive = data => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    const port = ports.get(m.name);
    if ( port === undefined ) { return; }
    if ( m.t === 'msg' ) {
        port.onMessage.emit(m.msg, port);
    } else if ( m.t === 'disconnect' ) {
        ports.delete(m.name);
        port.onDisconnect.emit(port);
    }
};

const connect = (details = {}) => {
    const name = details.name || '';
    const port = {
        name,
        onMessage: new Event(),
        onDisconnect: new Event(),
        postMessage(msg) {
            if ( ports.get(name) !== port ) {
                throw new Error('Attempting to use a disconnected port object');
            }
            post({ t: 'msg', name, msg });
        },
        disconnect() {
            if ( ports.get(name) !== port ) { return; }
            ports.delete(name);
            post({ t: 'disconnect', name });
        },
    };
    ports.set(name, port);
    post({ t: 'connect', name });
    return port;
};

// Back from the back-forward cache: uBO let go of this document's ports
// when the next one came, so they are gone here too, and its styles come
// back.
self.addEventListener('pageshow', ev => {
    if ( ev.persisted !== true ) { return; }
    for ( const port of Array.from(ports.values()) ) {
        ports.delete(port.name);
        port.onDisconnect.emit(port);
    }
    if ( self === self.top ) { bridge.restored(); }
});

const { manifest = {}, messages = {} } = bridge.page ?? {};

const getMessage = (name, substitutions) => {
    const entry = messages[name];
    if ( entry === undefined ) { return ''; }
    const subs = substitutions === undefined ? [] : [ substitutions ].flat().map(String);
    const placeholders = entry.placeholders || {};
    return entry.message
        .replace(/\$([A-Za-z0-9_@]+)\$/g, (all, key) => {
            const placeholder = placeholders[key.toLowerCase()];
            return placeholder !== undefined ? placeholder.content : all;
        })
        .replace(/\$(\d)/g, (all, n) => subs[n - 1] ?? '')
        .replace(/\$\$/g, '$');
};

const chrome = self.chrome = self.browser = {
    runtime: {
        id: 'krimium-ubo',
        lastError: undefined,
        connect,
        getManifest: ( ) => manifest,
        getURL: path => `krimium-ubo://ubo/${String(path).replace(/^\//, '')}`,
    },
    i18n: {
        getMessage,
        getUILanguage: ( ) => navigator.language,
    },
};

// uBO's pages import webext.js with what they use (broadcast.js), and it
// wraps these when it loads: there, nothing calls them.
if ( bridge.page ) {
    for ( const name of [ 'alarms', 'browserAction', 'contextMenus', 'tabs', 'webNavigation', 'windows' ] ) {
        chrome[name] = {};
    }
    chrome.storage = { local: {} };
    chrome.privacy = {
        network: { networkPredictionEnabled: {}, webRTCIPHandlingPolicy: {} },
        websites: { hyperlinkAuditingEnabled: {} },
    };
    chrome.webRequest = { MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20 };
}

})();
