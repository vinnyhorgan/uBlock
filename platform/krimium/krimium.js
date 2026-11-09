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
//     answered with '' (let it go), 'c' (cancel) or 'r URL' (redirect), at
//     once or, when uBO must first resolve the hostname, with a promise;
//   - tab*(), navigating(), committed(), loaded(), frame(): what its tabs
//     do;
//   - port(): what uBO's content scripts in a page post to it.
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

// krimium's first lists: uBO's own, and what a careful Firefox user adds to
// them, which is what krimium means by uBO "on the best settings". The
// first time uBO looks for the lists it has selected, there are none, and
// it would pick its own: krimium picks them, as that user would tick them
// in the dashboard, which changes them as anywhere else.
const firstLists = [
    'adguard-spyware-url',      // AdGuard/uBO – URL Tracking Protection
    'curben-phishing',          // Phishing URL Blocklist
    'block-lan',                // Block Outsider Intrusion into LAN
    'fanboy-cookiemonster',     // EasyList – Cookie Notices
    'ublock-cookies-easylist',  // uBlock filters – Cookie Notices
    'ublock-annoyances',        // uBlock filters – Annoyances
    'ITA-0',                    // EasyList Italy
];

const withFirstLists = storage => {
    const get = storage.get;
    storage.get = api(async keys => {
        const out = await get(keys);
        const asked = typeof keys === 'string' ? [ keys ]
            : Array.isArray(keys) ? keys : [];
        if ( asked.includes('selectedFilterLists') === false ) { return out; }
        if ( Array.isArray(out.selectedFilterLists) ) { return out; }
        const assets = await fetch(`${root}assets/assets.json`).then(r => r.json());
        const selected = [ 'user-filters' ];
        for ( const [ key, entry ] of Object.entries(assets) ) {
            if ( entry.content !== 'filters' ) { continue; }
            if ( entry.off === true && firstLists.includes(key) === false ) { continue; }
            selected.push(key);
        }
        await storage.set({ selectedFilterLists: selected });
        out.selectedFilterLists = selected;
        return out;
    });
    return storage;
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

// Tabs, as krimium tells them. A frame is known first from the request that
// loads its document, under an id of this page's own; then krimium tells
// it, once its document is there, with WebKit's id for it, the id the
// frame's content scripts give.

const tabs = new Map();
let activeTabId = -1;
let nextFrameId = 2 ** 48;

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
    BEACON: 'beacon',
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
    [ 'ping', 'ping' ], [ 'beacon', 'beacon' ],
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

// uBO's content scripts, for krimium to run in every frame: its manifest's,
// after krimium's own stand-in for the extension API there.
let contentScripts = '';

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
    if ( dest === 'krimium-scriptlets' ) {
        if ( method === 'top' ) { commit(tabId, url, true); }
        return self.krimium.scriptlets?.(url, referrer) ?? '';
    }
    if ( dest === 'krimium-content' ) {
        return contentScripts;
    }
    if ( dest === 'krimium-page' ) {
        return `s ${JSON.stringify({ manifest, messages })}`;
    }
    if ( dest === 'ping' && hyperlinkAuditing === false ) {
        return 'c';
    }
    if ( tab !== undefined ) {
        if ( type === 'main_frame' ) {
            details.frameId = 0;
        } else if ( type === 'sub_frame' ) {
            const parentFrameId = frameOf(tab, referrer);
            const frameId = nextFrameId++;
            tab.frames.set(frameId, { url, parentFrameId, early: true });
            details.frameId = frameId;
            details.parentFrameId = parentFrameId;
            if ( parentFrameId !== 0 ) {
                details.documentUrl = tab.frames.get(parentFrameId).url;
            }
        } else {
            const frameId = frameOf(tab, referrer);
            details.frameId = frameId;
            details.parentFrameId = frameId === 0 ? -1 : tab.frames.get(frameId).parentFrameId;
            details.documentUrl = frameId !== 0 ? tab.frames.get(frameId).url : tab.url;
        }
    } else if ( referrer ) {
        details.documentUrl = referrer;
    }
    // A listener may answer later, with a promise, as on Firefox: then so
    // does this, and the request waits.
    const results = [];
    for ( const { fn, filter } of webRequestEvents.onBeforeRequest.listeners.slice() ) {
        if ( filter !== undefined ) {
            if ( Array.isArray(filter.types) && filter.types.includes(type) === false ) { continue; }
            if ( urlMatches(url, filter.urls) === false ) { continue; }
        }
        try { results.push(fn(Object.assign({}, details))); } catch (ex) { console.error(ex); }
    }
    if ( results.some(r => r instanceof Promise) ) {
        return Promise.all(results.map(r => Promise.resolve(r).catch(( ) => {}))).then(verdict);
    }
    return verdict(results);
};

const verdict = results => {
    let redirectUrl;
    for ( const result of results ) {
        if ( result instanceof Object === false ) { continue; }
        if ( result.cancel === true ) { return 'c'; }
        if ( typeof result.redirectUrl === 'string' && redirectUrl === undefined ) {
            redirectUrl = result.redirectUrl;
        }
    }
    return redirectUrl !== undefined ? `r ${redirectUrl}` : '';
};

/******************************************************************************/

// The right-click menu: uBO's entries, which krimium adds to the menu a page
// shows when they apply, as Chromium does; what was right-clicked comes back
// with the one chosen.

const menuEntries = new Map();
const onMenuClicked = new Event();
let menusPending = false;

const menusChanged = ( ) => {
    if ( menusPending ) { return; }
    menusPending = true;
    Promise.resolve().then(( ) => {
        menusPending = false;
        native({
            type: 'menus',
            entries: Array.from(menuEntries.values()).map(entry => ({
                id: entry.id,
                title: entry.title,
                contexts: (entry.contexts || [ 'page' ]).join(' '),
                documentUrlPatterns: (entry.documentUrlPatterns || []).join(' '),
                targetUrlPatterns: (entry.targetUrlPatterns || []).join(' '),
            })),
        });
    });
};

const menuClicked = (tabId, menuItemId, details) => {
    const tab = tabs.get(tabId);
    if ( tab === undefined ) { return; }
    let info;
    try { info = JSON.parse(details); } catch { return; }
    onMenuClicked.emit({ ...info, menuItemId, pageUrl: tab.url }, tabInfo(tab));
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

// Ports: uBO's content scripts talk to it through runtime.connect(). In a
// page they live in a world of their own, "ubo", and krimium carries what
// they post: port() here, and a 'port' message back to the frame.

const ports = new Map();
const onConnect = new Event();

const postToFrame = (tabId, frameId, data) => {
    native({ type: 'port', tabId, frameId, data: JSON.stringify(data) });
};

// A port one of uBO's pages opens to a tab's content script, with
// tabs.connect() (the logger's DOM inspector): both ends are in pages, and
// what one end posts goes on to the other.
const relays = new Map();

const relay = (key, m) => {
    const other = relays.get(key);
    if ( other === undefined ) { return; }
    if ( m.t === 'disconnect' ) {
        relays.delete(key);
        relays.delete(other.key);
    }
    postToFrame(other.tabId, other.frameId, { t: m.t, name: other.name, msg: m.msg });
};

const dropPorts = (tabId, frameId) => {
    for ( const [ key, port ] of ports ) {
        if ( port.tabId !== tabId ) { continue; }
        if ( frameId !== undefined && port.frameId !== frameId ) { continue; }
        ports.delete(key);
        port.onDisconnect.emit(port);
    }
    for ( const [ key, end ] of relays ) {
        if ( end.from.tabId !== tabId ) { continue; }
        if ( frameId !== undefined && end.from.frameId !== frameId ) { continue; }
        relay(key, { t: 'disconnect' });
    }
};

const portMessage = (tabId, frameId, url, data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    const key = `${tabId} ${frameId} ${m.name}`;
    if ( m.t === 'connect' && m.tabId !== undefined ) {
        const to = { tabId: m.tabId, frameId: m.frameId ?? 0, name: m.name };
        to.key = `${to.tabId} ${to.frameId} ${to.name}`;
        const from = { tabId, frameId, name: m.name, key };
        relays.set(key, { ...to, from });
        relays.set(to.key, { ...from, from: to });
        postToFrame(to.tabId, to.frameId, { t: 'connect', name: m.name });
        return;
    }
    if ( relays.has(key) ) {
        relay(key, m);
        return;
    }
    if ( m.t === 'connect' ) {
        const tab = tabs.get(tabId);
        const port = {
            name: m.name,
            tabId,
            frameId,
            sender: {
                tab: tab !== undefined ? tabInfo(tab) : undefined,
                frameId,
                url,
                origin: originOf(url) || undefined,
            },
            onMessage: new Event(),
            onDisconnect: new Event(),
            postMessage(msg) {
                if ( ports.get(key) !== port ) { return; }
                postToFrame(tabId, frameId, { t: 'msg', name: m.name, msg });
            },
            disconnect() {
                if ( ports.get(key) !== port ) { return; }
                ports.delete(key);
                postToFrame(tabId, frameId, { t: 'disconnect', name: m.name });
            },
        };
        ports.set(key, port);
        onConnect.emit(port);
        return;
    }
    const port = ports.get(key);
    if ( port === undefined ) { return; }
    if ( m.t === 'msg' ) {
        port.onMessage.emit(m.msg, port);
    } else if ( m.t === 'disconnect' ) {
        ports.delete(key);
        port.onDisconnect.emit(port);
    }
};

let krimiumPort;

// uBO's pages hear of the tabs' navigation here: the logger, to put its
// DOM inspector back in a page that loaded again.
const pages = new BroadcastChannel('krimium');

// The main frame has a new document. krimium's module in the page's process
// says so first, on the way the page's requests come, before any of them:
// the browser's word comes later, and is then only news.
const commit = (tabId, url, early = false) => {
    const tab = tabs.get(tabId);
    if ( tab === undefined ) { return; }
    tab.committed = early ? url : undefined;
    tab.url = url;
    tab.status = 'loading';
    tab.frames.clear();
    navigationEvents.onCommitted.emit({
        tabId, frameId: 0, parentFrameId: -1, url,
        transitionType: 'link', transitionQualifiers: [],
        timeStamp: Date.now(),
    });
    tabsEvents.onUpdated.emit(tabId, { status: 'loading', url }, tabInfo(tab));
};

// A frame has a new document: what lived in the one before is gone.
const frame = (tabId, frameId, parentFrameId, url, blank = false) => {
    const tab = tabs.get(tabId);
    if ( tab === undefined ) { return; }
    if ( frameId === 0 ) {
        dropPorts(tabId);
        return;
    }
    dropPorts(tabId, frameId);
    // A frame without an address of its own (about:blank, about:srcdoc)
    // has its page's, and was asked for by no request.
    for ( const [ id, early ] of tab.frames ) {
        if ( blank ) { break; }
        if ( early.early && early.url === url ) {
            tab.frames.delete(id);
            break;
        }
    }
    tab.frames.set(frameId, { url, parentFrameId, blank });
    navigationEvents.onCommitted.emit({
        tabId, frameId, parentFrameId, url,
        transitionType: 'auto_subframe', transitionQualifiers: [],
        timeStamp: Date.now(),
    });
};

// Styles go in as user style sheets, to a frame, or to the frames of a
// subframe's scheme and host: WebKit gives a sheet to frames by their
// address. A frame without one of its own also gets them as one of the
// frames that have none ("about:"), and keeps them if a document.write()
// gives it its page's.
const styleDetails = (tabId, details) => {
    const tab = tabs.get(tabId);
    const frameId = details.frameId ?? 0;
    const code = details.code || '';
    if ( frameId === 0 ) { return [ { tabId, frameId, pattern: '', code } ]; }
    const frame = tab?.frames.get(frameId);
    let url;
    try { url = new URL(frame.url); } catch { return []; }
    if ( /^https?:$/.test(url.protocol) === false ) { return []; }
    const styles = [ { tabId, frameId, pattern: `${url.protocol}//${url.hostname}/*`, code } ];
    if ( frame.blank ) {
        styles.push({ tabId, frameId, pattern: 'about:', code });
    }
    return styles;
};

const executeScript = async (tabId, details) => {
    if ( typeof tabId !== 'number' ) { details = tabId; tabId = activeTabId; }
    let code = details.code;
    if ( code === undefined && details.file !== undefined ) {
        const r = await fetch(root + details.file.replace(/^\//, ''));
        code = await r.text();
    }
    if ( typeof code !== 'string' ) { return []; }
    const results = await native({
        type: 'tabs.executeScript',
        tabId,
        frameId: details.frameId ?? 0,
        allFrames: details.allFrames === true,
        code,
    });
    try { return JSON.parse(results); } catch { return []; }
};

/******************************************************************************/

// What krimium calls

self.krimium = {
    request,
    menuClicked,
    port: portMessage,
    frame,
    // A page that is no tab (uBO's popup) went away.
    gone(tabId) {
        dropPorts(tabId);
    },
    // krimium's own commands: uBO's picker and zapper in a tab, as its
    // popup launches them.
    tool(tabId, name) {
        if ( krimiumPort === undefined ) {
            krimiumPort = {
                name: 'krimium',
                sender: { frameId: 0, url: root + 'popup-fenix.html', origin: root.slice(0, -1) },
                onMessage: new Event(),
                onDisconnect: new Event(),
                postMessage( ) {},
                disconnect( ) {},
            };
            onConnect.emit(krimiumPort);
        }
        krimiumPort.onMessage.emit({
            channel: 'default',
            msg: { what: 'launchElementPicker', tabId, zap: name === 'zapper' },
        }, krimiumPort);
    },

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
        dropPorts(tabId);
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
        if ( tab.committed === url ) {
            tab.committed = undefined;
            return;
        }
        commit(tabId, url);
    },
    loaded(tabId) {
        const tab = tabs.get(tabId);
        if ( tab === undefined ) { return; }
        tab.status = 'complete';
        const details = { tabId, frameId: 0, parentFrameId: -1, url: tab.url, timeStamp: Date.now() };
        navigationEvents.onDOMContentLoaded.emit(details);
        navigationEvents.onCompleted.emit(details);
        pages.postMessage({ what: 'DOMContentLoaded', details });
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

// What uBO sets of the browser's privacy. Hyperlink auditing is done here:
// when uBO turns it off, an <a ping> is cancelled (request()). krimium has
// no WebRTC. Network prediction is WebKit's: it fetches nothing ahead, but
// opens the connections a page hints at (rel=preconnect), switch or not.
const privacySetting = (value, onChange) => {
    const initial = value;
    return {
        get: api(( ) => ({ value, levelOfControl: 'controllable_by_this_extension' })),
        set: api(details => { value = details.value; onChange?.(value); }),
        clear: api(( ) => { value = initial; onChange?.(value); }),
    };
};

let hyperlinkAuditing = true;

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
        create: entry => {
            menuEntries.set(entry.id, entry);
            menusChanged();
            return entry.id;
        },
        // At once, in the order uBO calls them, as Chromium has them.
        remove: (id, ...rest) => {
            menuEntries.delete(id);
            menusChanged();
            return api(( ) => {})(...rest);
        },
        removeAll: (...rest) => {
            menuEntries.clear();
            menusChanged();
            return api(( ) => {})(...rest);
        },
        onClicked: onMenuClicked,
    },
    // As Firefox has it: krimium resolves the name.
    dns: {
        resolve: api(async (hostname, flags) => {
            const record = await native({ type: 'dns.resolve', hostname });
            if ( record instanceof Object === false ) { throw `${hostname}: not found`; }
            return record;
        }),
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
            hyperlinkAuditingEnabled: privacySetting(true, value => { hyperlinkAuditing = value; }),
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
        onConnect,
        onMessage: new Event(),
        onInstalled: new Event(),
        onStartup: new Event(),
        onUpdateAvailable: new Event(),
    },
    storage: {
        local: withFirstLists(idbStorage('local')),
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
        executeScript: api(executeScript),
        insertCSS: api((tabId, details) => Promise.all(styleDetails(tabId, details).map(
            style => native({ type: 'tabs.insertCSS', ...style })
        ))),
        removeCSS: api((tabId, details) => Promise.all(styleDetails(tabId, details).map(
            style => native({ type: 'tabs.removeCSS', ...style })
        ))),
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
    const files = [ 'js/krimium-content.js', ...manifest.content_scripts[0].js ];
    const scripts = await Promise.all(files.map(async file => {
        const path = file.replace(/^\//, '');
        const r = await fetch(root + path);
        return [ root + path, await r.text() ];
    }));
    contentScripts = `s ${JSON.stringify(scripts)}`;
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
