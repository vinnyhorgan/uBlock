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

// krimium (github.com/vinnyhorgan/krimium) has no extension system: it loads
// uBO's background page in a hidden web view of its own, and this file
// stands in for the part of the `chrome` extension API uBO uses there.
//
// krimium calls in through `self.krimium`:
//   - request(): every network request of every page, before it leaves,
//     answered at once: '' (let it go), 'c' (cancel) or 'r URL' (redirect);
//   - tab*(), navigating(), committed(), loaded(): what its tabs do.
// This page calls out to krimium with `native()`, a message that krimium
// answers.
//
// Once krimium has said which tabs exist, js/start.js is loaded: uBO itself.

'use strict';

(( ) => {

/******************************************************************************/

const root = `${self.location.origin}/`;

// WebKit has no idle callbacks; uBO only uses them to put work off a little.
if ( self.requestIdleCallback === undefined ) {
    self.requestIdleCallback = (fn, options) => self.setTimeout(( ) => {
        fn({ didTimeout: true, timeRemaining: ( ) => 0 });
    }, Math.min(options?.timeout ?? 1, 1));
    self.cancelIdleCallback = id => { self.clearTimeout(id); };
}

const native = msg => {
    return self.webkit.messageHandlers.krimium.postMessage(msg).catch(reason => {
        console.error(`krimium: ${msg.type}: ${reason}`);
    });
};

let lastError;

// A function of the API: answers through a promise, and through a callback
// when given one, the way chrome.* does.
const api = fn => function(...args) {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined;
    const promise = Promise.resolve().then(( ) => fn(...args));
    if ( callback === undefined ) { return promise; }
    promise.then(result => {
        callback(result);
    }, reason => {
        lastError = { message: String(reason) };
        try { callback(); } finally { lastError = undefined; }
    });
};

class Event {
    constructor() {
        this.listeners = [];
    }
    addListener(fn, filter, options) {
        if ( this.hasListener(fn) ) { return; }
        this.listeners.push({ fn, filter, options });
    }
    removeListener(fn) {
        this.listeners = this.listeners.filter(a => a.fn !== fn);
    }
    hasListener(fn) {
        return this.listeners.some(a => a.fn === fn);
    }
    hasListeners() {
        return this.listeners.length !== 0;
    }
    emit(...args) {
        for ( const { fn } of this.listeners.slice() ) {
            try { fn(...args); } catch (ex) { console.error(ex); }
        }
    }
}

// https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
const reFromMatchPattern = pattern => {
    if ( pattern === '<all_urls>' ) {
        return /^(?:https?|wss?|ftp|file):/;
    }
    const match = /^([^:]+):\/\/([^/]*)(\/.*)$/.exec(pattern);
    if ( match === null ) { return /^$/; }
    const esc = s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const [ , scheme, host, path ] = match;
    let reHost;
    if ( host === '*' ) {
        reHost = '[^/]*';
    } else if ( host.startsWith('*.') ) {
        reHost = `(?:[^/]*\\.)?${esc(host.slice(2))}(?::\\d+)?`;
    } else {
        reHost = `${esc(host)}(?::\\d+)?`;
    }
    const reScheme = scheme === '*' ? '(?:https?|wss?)' : esc(scheme);
    return new RegExp(`^${reScheme}://${reHost}${esc(path)}$`);
};

const urlMatches = (url, patterns) => {
    if ( patterns === undefined ) { return true; }
    if ( Array.isArray(patterns) === false ) { patterns = [ patterns ]; }
    return patterns.some(p => reFromMatchPattern(p).test(url));
};

const originOf = url => {
    try { return new URL(url).origin; } catch { return ''; }
};

/******************************************************************************/

// Storage, in IndexedDB: what chrome.storage.local keeps on disk, this page
// keeps in its own database, which krimium's data directory holds.

const idbStorage = name => {
    let dbPromise;
    const db = ( ) => {
        if ( dbPromise !== undefined ) { return dbPromise; }
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(`krimium-${name}`, 1);
            req.onupgradeneeded = ( ) => { req.result.createObjectStore('kv'); };
            req.onsuccess = ( ) => { resolve(req.result); };
            req.onerror = ( ) => { reject(req.error); };
        });
        return dbPromise;
    };
    const transaction = async (mode, fn) => {
        const t = (await db()).transaction('kv', mode);
        const out = fn(t.objectStore('kv'));
        return new Promise((resolve, reject) => {
            t.oncomplete = ( ) => { resolve(out instanceof Function ? out() : out); };
            t.onerror = ( ) => { reject(t.error); };
            t.onabort = ( ) => { reject(t.error); };
        });
    };
    return {
        QUOTA_BYTES: Number.MAX_SAFE_INTEGER,
        get: api(keys => transaction('readonly', store => {
            const out = {};
            if ( keys === null || keys === undefined ) {
                const k = store.getAllKeys();
                const v = store.getAll();
                return ( ) => {
                    k.result.forEach((key, i) => { out[key] = v.result[i]; });
                    return out;
                };
            }
            let defaults = {};
            if ( typeof keys === 'string' ) {
                keys = [ keys ];
            } else if ( Array.isArray(keys) === false ) {
                defaults = keys;
                keys = Object.keys(keys);
            }
            for ( const key of keys ) {
                const req = store.get(key);
                req.onsuccess = ( ) => {
                    if ( req.result !== undefined ) {
                        out[key] = req.result;
                    } else if ( Object.hasOwn(defaults, key) ) {
                        out[key] = defaults[key];
                    }
                };
            }
            return out;
        })),
        set: api(items => transaction('readwrite', store => {
            for ( const [ key, value ] of Object.entries(items) ) {
                store.put(value, key);
            }
        })),
        remove: api(keys => transaction('readwrite', store => {
            for ( const key of [ keys ].flat() ) {
                store.delete(key);
            }
        })),
        clear: api(( ) => transaction('readwrite', store => {
            store.clear();
        })),
        getBytesInUse: api(( ) => 0),
        onChanged: new Event(),
    };
};

const memoryStorage = ( ) => {
    const map = new Map();
    return {
        get: api(keys => {
            const out = {};
            if ( keys === null || keys === undefined ) {
                for ( const [ key, value ] of map ) { out[key] = value; }
                return out;
            }
            let defaults = {};
            if ( typeof keys === 'string' ) {
                keys = [ keys ];
            } else if ( Array.isArray(keys) === false ) {
                defaults = keys;
                keys = Object.keys(keys);
            }
            for ( const key of keys ) {
                if ( map.has(key) ) {
                    out[key] = structuredClone(map.get(key));
                } else if ( Object.hasOwn(defaults, key) ) {
                    out[key] = defaults[key];
                }
            }
            return out;
        }),
        set: api(items => {
            for ( const [ key, value ] of Object.entries(items) ) {
                map.set(key, structuredClone(value));
            }
        }),
        remove: api(keys => {
            for ( const key of [ keys ].flat() ) { map.delete(key); }
        }),
        clear: api(( ) => { map.clear(); }),
    };
};

/******************************************************************************/

// Alarms: timers, for as long as krimium runs, which is as long as this
// page lives.

const alarms = new Map();
const onAlarm = new Event();

const alarmCreate = (name, info) => {
    if ( typeof name !== 'string' ) { info = name; name = ''; }
    alarmClear(name);
    const now = Date.now();
    const when = info.when !== undefined
        ? info.when
        : now + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60000;
    const alarm = { name, scheduledTime: when };
    if ( info.periodInMinutes !== undefined ) {
        alarm.periodInMinutes = info.periodInMinutes;
    }
    const fire = ( ) => {
        if ( alarm.periodInMinutes !== undefined ) {
            alarm.scheduledTime = Date.now() + alarm.periodInMinutes * 60000;
            alarm.timer = setTimeout(fire, alarm.periodInMinutes * 60000);
        } else {
            alarms.delete(name);
        }
        onAlarm.emit({ name, scheduledTime: alarm.scheduledTime });
    };
    alarm.timer = setTimeout(fire, Math.max(when - now, 0));
    alarms.set(name, alarm);
};

const alarmClear = name => {
    const alarm = alarms.get(name);
    if ( alarm === undefined ) { return false; }
    clearTimeout(alarm.timer);
    alarms.delete(name);
    return true;
};

const alarmInfo = alarm => {
    const { name, scheduledTime, periodInMinutes } = alarm;
    return { name, scheduledTime, periodInMinutes };
};

/******************************************************************************/

// Tabs, as krimium tells them. Frames are not told: a request carries its
// page, its kind and its referrer, and frames are known from the requests
// that load them.

const tabs = new Map();
let activeTabId = -1;
let nextFrameId = 1;

const tabInfo = tab => ({
    id: tab.id,
    index: tab.index,
    windowId: 1,
    openerTabId: tab.openerTabId,
    active: tab.id === activeTabId,
    highlighted: tab.id === activeTabId,
    url: tab.url,
    title: tab.title,
    status: tab.status,
    incognito: false,
    discarded: false,
    pinned: false,
    audible: false,
});

const addTab = details => {
    const tab = {
        id: details.id,
        index: tabs.size,
        openerTabId: details.openerTabId || undefined,
        url: details.url || '',
        title: details.title || '',
        status: 'loading',
        frames: new Map(),
    };
    tabs.set(tab.id, tab);
    if ( details.active ) { activeTabId = tab.id; }
    return tab;
};

// The frame a document belongs to: 0 for the tab's own, the id of a frame
// when the referrer is one, or its origin is one's only.
const frameOf = (tab, referrer) => {
    if ( tab === undefined || !referrer || referrer === tab.url ) { return 0; }
    for ( const [ id, frame ] of tab.frames ) {
        if ( frame.url === referrer ) { return id; }
    }
    const origin = originOf(referrer);
    if ( origin === originOf(tab.url) ) { return 0; }
    for ( const [ id, frame ] of tab.frames ) {
        if ( originOf(frame.url) === origin ) { return id; }
    }
    return 0;
};

const frameInfo = (tab, frameId) => {
    if ( frameId === 0 ) {
        return { frameId: 0, parentFrameId: -1, url: tab.url, errorOccurred: false };
    }
    const frame = tab.frames.get(frameId);
    if ( frame === undefined ) { return null; }
    return { frameId, parentFrameId: frame.parentFrameId, url: frame.url, errorOccurred: false };
};

/******************************************************************************/

// Network requests. Fetch metadata names what a request is for: it becomes
// the resource type uBO knows.

const resourceTypes = {
    MAIN_FRAME: 'main_frame',
    SUB_FRAME: 'sub_frame',
    STYLESHEET: 'stylesheet',
    SCRIPT: 'script',
    IMAGE: 'image',
    FONT: 'font',
    OBJECT: 'object',
    XMLHTTPREQUEST: 'xmlhttprequest',
    PING: 'ping',
    CSP_REPORT: 'csp_report',
    MEDIA: 'media',
    OTHER: 'other',
};

const typeFromDest = new Map([
    [ 'document', 'main_frame' ],
    [ 'iframe', 'sub_frame' ], [ 'frame', 'sub_frame' ], [ 'fencedframe', 'sub_frame' ],
    [ 'style', 'stylesheet' ],
    [ 'script', 'script' ], [ 'worker', 'script' ], [ 'sharedworker', 'script' ],
    [ 'serviceworker', 'script' ], [ 'audioworklet', 'script' ], [ 'paintworklet', 'script' ],
    [ 'image', 'image' ],
    [ 'font', 'font' ],
    [ 'audio', 'media' ], [ 'video', 'media' ], [ 'track', 'media' ],
    [ 'object', 'object' ], [ 'embed', 'object' ],
    [ 'empty', 'xmlhttprequest' ],
    [ 'report', 'csp_report' ],
]);

const webRequestEvents = {
    onBeforeRequest: new Event(),
    onBeforeSendHeaders: new Event(),
    onSendHeaders: new Event(),
    onHeadersReceived: new Event(),
    onResponseStarted: new Event(),
    onBeforeRedirect: new Event(),
    onCompleted: new Event(),
    onErrorOccurred: new Event(),
};

let nextRequestId = 1;

const request = (tabId, dest, method, url, referrer) => {
    const tab = tabs.get(tabId);
    const type = typeFromDest.get(dest) || 'other';
    const details = {
        requestId: String(nextRequestId++),
        url,
        method: method || 'GET',
        type,
        tabId: tab !== undefined ? tabId : -1,
        frameId: 0,
        parentFrameId: -1,
        timeStamp: Date.now(),
    };
    if ( tab !== undefined ) {
        if ( type === 'main_frame' ) {
            details.frameId = 0;
        } else if ( type === 'sub_frame' ) {
            const parentFrameId = frameOf(tab, referrer);
            const frameId = nextFrameId++;
            tab.frames.set(frameId, { url, parentFrameId });
            details.frameId = frameId;
            details.parentFrameId = parentFrameId;
            if ( parentFrameId !== 0 ) {
                details.documentUrl = tab.frames.get(parentFrameId).url;
            }
        } else {
            const frameId = frameOf(tab, referrer);
            details.frameId = frameId;
            details.parentFrameId = frameId === 0 ? -1 : tab.frames.get(frameId).parentFrameId;
            if ( frameId !== 0 ) {
                details.documentUrl = tab.frames.get(frameId).url;
            }
        }
    } else if ( referrer ) {
        details.documentUrl = referrer;
    }
    let redirectUrl;
    for ( const { fn, filter } of webRequestEvents.onBeforeRequest.listeners.slice() ) {
        if ( filter !== undefined ) {
            if ( Array.isArray(filter.types) && filter.types.includes(type) === false ) { continue; }
            if ( urlMatches(url, filter.urls) === false ) { continue; }
        }
        let result;
        try { result = fn(Object.assign({}, details)); } catch (ex) { console.error(ex); }
        if ( result instanceof Object === false ) { continue; }
        if ( result.cancel === true ) { return 'c'; }
        if ( typeof result.redirectUrl === 'string' && redirectUrl === undefined ) {
            redirectUrl = result.redirectUrl;
        }
    }
    return redirectUrl !== undefined ? `r ${redirectUrl}` : '';
};

/******************************************************************************/

const tabsEvents = {
    onCreated: new Event(),
    onUpdated: new Event(),
    onActivated: new Event(),
    onRemoved: new Event(),
    onReplaced: new Event(),
};

const navigationEvents = {
    onBeforeNavigate: new Event(),
    onCommitted: new Event(),
    onDOMContentLoaded: new Event(),
    onCompleted: new Event(),
    onErrorOccurred: new Event(),
    onCreatedNavigationTarget: new Event(),
    onReferenceFragmentUpdated: new Event(),
    onHistoryStateUpdated: new Event(),
    onTabReplaced: new Event(),
};

// What krimium calls

self.krimium = {
    request,

    tabCreated(details) {
        const tab = addTab(details);
        tabsEvents.onCreated.emit(tabInfo(tab));
        if ( tab.openerTabId !== undefined ) {
            navigationEvents.onCreatedNavigationTarget.emit({
                sourceTabId: tab.openerTabId,
                sourceFrameId: 0,
                tabId: tab.id,
                url: tab.url,
                timeStamp: Date.now(),
            });
        }
    },
    tabUpdated(tabId, changes) {
        const tab = tabs.get(tabId);
        if ( tab === undefined ) { return; }
        Object.assign(tab, changes);
        tabsEvents.onUpdated.emit(tabId, changes, tabInfo(tab));
    },
    tabActivated(tabId) {
        if ( tabs.has(tabId) === false || tabId === activeTabId ) { return; }
        activeTabId = tabId;
        tabsEvents.onActivated.emit({ tabId, windowId: 1 });
    },
    tabRemoved(tabId) {
        if ( tabs.delete(tabId) === false ) { return; }
        if ( activeTabId === tabId ) { activeTabId = -1; }
        tabsEvents.onRemoved.emit(tabId, { windowId: 1, isWindowClosing: false });
    },
    navigating(tabId, url) {
        if ( tabs.has(tabId) === false ) { return; }
        navigationEvents.onBeforeNavigate.emit({
            tabId, frameId: 0, parentFrameId: -1, url, timeStamp: Date.now(),
        });
    },
    committed(tabId, url) {
        const tab = tabs.get(tabId);
        if ( tab === undefined ) { return; }
        tab.url = url;
        tab.status = 'loading';
        tab.frames.clear();
        navigationEvents.onCommitted.emit({
            tabId, frameId: 0, parentFrameId: -1, url,
            transitionType: 'link', transitionQualifiers: [],
            timeStamp: Date.now(),
        });
        tabsEvents.onUpdated.emit(tabId, { status: 'loading', url }, tabInfo(tab));
    },
    loaded(tabId) {
        const tab = tabs.get(tabId);
        if ( tab === undefined ) { return; }
        tab.status = 'complete';
        const details = { tabId, frameId: 0, parentFrameId: -1, url: tab.url, timeStamp: Date.now() };
        navigationEvents.onDOMContentLoaded.emit(details);
        navigationEvents.onCompleted.emit(details);
        tabsEvents.onUpdated.emit(tabId, { status: 'complete' }, tabInfo(tab));
    },
};

/******************************************************************************/

let manifest = {};
let messages = {};

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

const privacySetting = value => ({
    get: api(( ) => ({ value, levelOfControl: 'controllable_by_this_extension' })),
    set: api(( ) => {}),
    clear: api(( ) => {}),
});

self.chrome = {
    alarms: {
        create: api(alarmCreate),
        get: api(name => {
            const alarm = alarms.get(name ?? '');
            return alarm !== undefined ? alarmInfo(alarm) : undefined;
        }),
        getAll: api(( ) => Array.from(alarms.values()).map(alarmInfo)),
        clear: api(name => alarmClear(name ?? '')),
        clearAll: api(( ) => {
            for ( const name of Array.from(alarms.keys()) ) { alarmClear(name); }
            return true;
        }),
        onAlarm,
    },
    browserAction: {
        setBadgeText: api(details => {
            if ( typeof details.tabId !== 'number' ) { return; }
            native({ type: 'badge', tabId: details.tabId, text: details.text || '' });
        }),
        setBadgeBackgroundColor: api(( ) => {}),
        setBadgeTextColor: api(( ) => {}),
        setIcon: api(( ) => {}),
        setTitle: api(( ) => {}),
        onClicked: new Event(),
    },
    commands: {
        getAll: api(( ) => []),
        onCommand: new Event(),
    },
    contextMenus: {
        create: ( ) => {},
        remove: api(( ) => {}),
        removeAll: api(( ) => {}),
        onClicked: new Event(),
    },
    i18n: {
        getMessage,
        getUILanguage: ( ) => navigator.language,
        detectLanguage: api(( ) => ({ isReliable: false, languages: [] })),
    },
    privacy: {
        network: {
            networkPredictionEnabled: privacySetting(false),
            webRTCIPHandlingPolicy: privacySetting('default'),
        },
        websites: {
            hyperlinkAuditingEnabled: privacySetting(false),
        },
    },
    runtime: {
        id: 'krimium-ubo',
        get lastError() { return lastError; },
        getManifest: ( ) => manifest,
        getURL: path => root + String(path).replace(/^\//, ''),
        getPlatformInfo: api(( ) => ({ os: 'linux', arch: 'x86-64' })),
        reload: ( ) => { self.location.reload(); },
        sendMessage: api(( ) => {}),
        openOptionsPage: api(( ) => {}),
        onConnect: new Event(),
        onMessage: new Event(),
        onInstalled: new Event(),
        onStartup: new Event(),
        onUpdateAvailable: new Event(),
    },
    storage: {
        local: idbStorage('local'),
        session: memoryStorage(),
        onChanged: new Event(),
    },
    tabs: {
        TAB_ID_NONE: -1,
        get: api(tabId => {
            const tab = tabs.get(tabId);
            if ( tab === undefined ) { throw `No tab with id: ${tabId}`; }
            return tabInfo(tab);
        }),
        query: api((query = {}) => {
            const out = [];
            for ( const tab of tabs.values() ) {
                const info = tabInfo(tab);
                if ( typeof query.active === 'boolean' && info.active !== query.active ) { continue; }
                if ( typeof query.status === 'string' && info.status !== query.status ) { continue; }
                if ( query.url !== undefined && urlMatches(info.url, query.url) === false ) { continue; }
                out.push(info);
            }
            return out;
        }),
        create: api(async details => {
            const tabId = await native({ type: 'tabs.create', url: details.url || '', active: details.active !== false });
            const tab = tabs.get(tabId);
            return tab !== undefined ? tabInfo(tab) : undefined;
        }),
        update: api(async (tabId, details) => {
            if ( details === undefined ) { details = tabId; tabId = activeTabId; }
            await native({ type: 'tabs.update', tabId, url: details.url || '', active: details.active === true });
            const tab = tabs.get(tabId);
            return tab !== undefined ? tabInfo(tab) : undefined;
        }),
        reload: api((tabId, details) => {
            if ( typeof tabId !== 'number' ) { details = tabId; tabId = activeTabId; }
            return native({ type: 'tabs.reload', tabId, bypassCache: details?.bypassCache === true });
        }),
        remove: api(tabIds => native({ type: 'tabs.remove', tabIds: [ tabIds ].flat() })),
        move: api(( ) => {}),
        // Scripts and styles in pages: not yet (stage 2).
        executeScript: api(( ) => []),
        insertCSS: api(( ) => {}),
        removeCSS: api(( ) => {}),
        sendMessage: api(( ) => {}),
        ...tabsEvents,
    },
    webNavigation: {
        getFrame: api(({ tabId, frameId }) => {
            const tab = tabs.get(tabId);
            return tab !== undefined ? frameInfo(tab, frameId) : null;
        }),
        getAllFrames: api(({ tabId }) => {
            const tab = tabs.get(tabId);
            if ( tab === undefined ) { return null; }
            return [ 0, ...tab.frames.keys() ].map(id => frameInfo(tab, id));
        }),
        ...navigationEvents,
    },
    webRequest: {
        ResourceType: resourceTypes,
        MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
        handlerBehaviorChanged: api(( ) => {}),
        ...webRequestEvents,
    },
    windows: {
        WINDOW_ID_NONE: -1,
        WINDOW_ID_CURRENT: -2,
        get: api(( ) => ({ id: 1, focused: true, type: 'normal', state: 'normal' })),
        create: api(( ) => ({ id: 1, focused: true, type: 'normal', state: 'normal' })),
        update: api(( ) => ({ id: 1, focused: true, type: 'normal', state: 'normal' })),
        onFocusChanged: new Event(),
        onRemoved: new Event(),
    },
};

/******************************************************************************/

// What uBO needs before it starts: its manifest, its messages and the tabs.

const fetchJSON = path => fetch(root + path).then(r => r.json());

const start = async ( ) => {
    manifest = await fetchJSON('manifest.json');
    const languages = [ navigator.language.replace('-', '_'), navigator.language.split('-')[0] ];
    for ( const lang of [ ...languages, manifest.default_locale || 'en' ] ) {
        try {
            messages = await fetchJSON(`_locales/${lang}/messages.json`);
            break;
        } catch {
        }
    }
    const told = await native({ type: 'hello' });
    for ( const details of told || [] ) {
        addTab(details);
    }
    const script = document.createElement('script');
    script.type = 'module';
    script.src = 'js/start.js';
    document.body.append(script);
};

start();

/******************************************************************************/

})();
