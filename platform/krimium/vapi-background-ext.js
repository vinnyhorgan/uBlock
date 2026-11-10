/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2017-present Raymond Hill

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

import {
    domainFromHostname,
    hostnameFromNetworkURL,
} from './uri-utils.js';

/******************************************************************************/

// krimium: Chromium's network layer, run by WebKit (WebKitGTK). WebKit's
// user agent says Safari, but lists mark as env_safari what Safari's own
// content blocker can do: krimium can do what uBO on Chromium does, so lists
// see env_chromium.

vAPI.webextFlavor.soup.delete('safari');
vAPI.webextFlavor.soup.add('chromium').add('krimium');

/******************************************************************************/

// https://github.com/uBlockOrigin/uBlock-issues/issues/1659
//   Chromium fails to dispatch onCreatedNavigationTarget() events sometimes,
//   so we synthetize these missing events when this happens.
// https://github.com/uBlockOrigin/uAssets/issues/10323
//   Also mind whether the new tab is launched from an external application.
// https://github.com/uBlockOrigin/uBlock-issues/issues/2227
//   Revert commit related to issue above.

vAPI.Tabs = class extends vAPI.Tabs {
    constructor() {
        super();
        this.tabIds = new Set();
        browser.tabs.onCreated.addListener(tab => {
            this.onCreatedHandler(tab);
        });
    }

    onCreatedHandler(tab) {
        if ( typeof tab.openerTabId === 'number' ) { return; }
        if ( tab.index !== 0 ) { return; }
        if ( tab.url !== '' ) { return; }
        this.tabIds.add(tab.id);
    }

    onCreatedNavigationTargetHandler(details) {
        this.tabIds.delete(details.tabId);
        super.onCreatedNavigationTargetHandler(details);
    }

    onCommittedHandler(details) {
        if ( details.frameId === 0 ) {
            this.synthesizeNavigationTargetEvent(details);
        }
        super.onCommittedHandler(details);
    }

    onRemovedHandler(tabId, details) {
        this.tabIds.delete(tabId);
        super.onRemovedHandler(tabId, details);
    }

    synthesizeNavigationTargetEvent(details) {
        if ( this.tabIds.has(details.tabId) === false ) { return; }
        this.tabIds.delete(details.tabId);
        const isClientRedirect =
            Array.isArray(details.transitionQualifiers) &&
            details.transitionQualifiers.includes('client_redirect');
        if ( isClientRedirect === false ) { return; }
        this.onCreatedNavigationTargetHandler({
            tabId: details.tabId,
            sourceTabId: details.tabId,
            sourceFrameId: 0,
            url: details.url,
        });
    }
};

/******************************************************************************/

{
    // krimium: on plain http WebKit does not say what a request is for, and
    // krimium can tell only some kinds (navigations, style sheets, images):
    // the others come as 'other', scripts among them, hence 'js' here.
    const extToTypeMap = new Map([
        ['eot','font'],['otf','font'],['ttf','font'],['woff','font'],['woff2','font'],
        ['mp3','media'],['mp4','media'],['webm','media'],
        ['gif','image'],['ico','image'],['jpeg','image'],['jpg','image'],['png','image'],['svg','image'],['webp','image'],
        ['js','script'],['mjs','script'],
    ]);

    const parsedURL = new URL('https://www.example.org/');

    // Extend base class to normalize as per platform

    // krimium: and, as on Firefox, CNAME uncloaking and the IP address of a
    // request (for `ipaddress=`): krimium resolves a hostname the first time
    // uBO sees it, and the request waits for the answer.
    const isPromise = o => o instanceof Promise;
    const isResolvedObject = o => o instanceof Object &&
        o instanceof Promise === false;
    const reIPv4 = /^\d+\.\d+\.\d+\.\d+$/;

    vAPI.Net = class extends vAPI.Net {
        constructor() {
            super();
            this.dnsList = [];          // ring buffer
            this.dnsWritePtr = 0;       // next write pointer in ring buffer
            this.dnsMaxCount = 512;     // max size of ring buffer
            this.dnsDict = new Map();   // hn to index in ring buffer
            this.dnsCacheTTL = 600;     // TTL in seconds
            this.canUncloakCnames = true;
            this.cnameUncloakEnabled = true;
            this.cnameIgnoreList = null;
            this.cnameIgnore1stParty = true;
            this.cnameIgnoreExceptions = true;
            this.cnameIgnoreRootDocument = true;
            this.cnameReplayFullURL = false;
            this.dnsResolveEnabled = true;
        }

        setOptions(options) {
            super.setOptions(options);
            if ( 'cnameUncloakEnabled' in options ) {
                this.cnameUncloakEnabled =
                    options.cnameUncloakEnabled !== false;
            }
            if ( 'cnameIgnoreList' in options ) {
                this.cnameIgnoreList =
                    this.regexFromStrList(options.cnameIgnoreList);
            }
            if ( 'cnameIgnore1stParty' in options ) {
                this.cnameIgnore1stParty =
                    options.cnameIgnore1stParty !== false;
            }
            if ( 'cnameIgnoreExceptions' in options ) {
                this.cnameIgnoreExceptions =
                    options.cnameIgnoreExceptions !== false;
            }
            if ( 'cnameIgnoreRootDocument' in options ) {
                this.cnameIgnoreRootDocument =
                    options.cnameIgnoreRootDocument !== false;
            }
            if ( 'cnameReplayFullURL' in options ) {
                this.cnameReplayFullURL = options.cnameReplayFullURL === true;
            }
            if ( 'dnsCacheTTL' in options ) {
                this.dnsCacheTTL = options.dnsCacheTTL;
            }
            if ( 'dnsResolveEnabled' in options ) {
                this.dnsResolveEnabled = options.dnsResolveEnabled === true;
            }
            this.dnsList.fill(null);
            this.dnsDict.clear();
        }

        canonicalNameFromHostname(hn) {
            if ( hn === '' ) { return; }
            const dnsEntry = this.dnsFromCache(hn, true);
            if ( isResolvedObject(dnsEntry) === false ) { return; }
            return dnsEntry.cname;
        }

        regexFromStrList(list) {
            if ( typeof list !== 'string' || list.length === 0 || list === 'unset' ) {
                return null;
            }
            if ( list === '*' ) { return /^./; }
            return new RegExp(
                '(?:^|\\.)(?:' +
                list.trim()
                    .split(/\s+/)
                    .map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                    .join('|') +
                ')$'
            );
        }

        onBeforeSuspendableRequest(details) {
            const hn = hostnameFromNetworkURL(details.url);
            const dnsEntry = this.dnsFromCache(hn);
            if ( isResolvedObject(dnsEntry) && dnsEntry.ip ) {
                details.ip = dnsEntry.ip;
            }
            const r = super.onBeforeSuspendableRequest(details);
            if ( r !== undefined ) {
                if (
                    r.cancel === true ||
                    r.redirectUrl !== undefined ||
                    this.cnameIgnoreExceptions
                ) {
                    return r;
                }
            }
            if ( isResolvedObject(dnsEntry) ) {
                return this.onAfterDNSResolution(hn, details, dnsEntry);
            }
            if ( this.dnsShouldResolve(hn) === false ) { return; }
            const promise = dnsEntry || this.dnsResolve(hn, details);
            return promise.then(( ) => this.onAfterDNSResolution(hn, details));
        }

        onAfterDNSResolution(hn, details, dnsEntry) {
            if ( dnsEntry === undefined ) {
                dnsEntry = this.dnsFromCache(hn);
                if ( isResolvedObject(dnsEntry) === false ) { return; }
            }
            let proceed = false;
            if ( dnsEntry.cname && this.cnameUncloakEnabled ) {
                const newURL = this.uncloakURL(hn, dnsEntry, details);
                if ( newURL ) {
                    details.aliasURL = details.url;
                    details.url = newURL;
                    proceed = true;
                }
            }
            if ( dnsEntry.ip && details.ip !== dnsEntry.ip ) {
                details.ip = dnsEntry.ip;
                proceed = true;
            }
            if ( proceed === false ) { return; }
            // Must call method on base class
            return super.onBeforeSuspendableRequest(details);
        }

        dnsToCache(hn, record, details) {
            const dnsEntry = { hn, until: Date.now() + this.dnsCacheTTL * 1000 };
            if ( record ) {
                const cname = this.cnameFromRecord(hn, record, details);
                if ( cname ) { dnsEntry.cname = cname; }
                const ip = this.ipFromRecord(record);
                if ( ip ) { dnsEntry.ip = ip; }
            }
            this.dnsSetCache(-1, hn, dnsEntry);
            return dnsEntry;
        }

        dnsFromCache(hn, passive = false) {
            const i = this.dnsDict.get(hn);
            if ( i === undefined ) { return; }
            if ( isPromise(i) ) { return i; }
            const dnsEntry = this.dnsList[i];
            if ( dnsEntry !== null && dnsEntry.hn === hn ) {
                if ( passive || dnsEntry.until >= Date.now() ) {
                    return dnsEntry;
                }
            }
            this.dnsSetCache(i);
        }

        dnsSetCache(i, hn, after) {
            if ( i < 0 ) {
                const j = this.dnsDict.get(hn);
                if ( typeof j === 'number' ) {
                    this.dnsList[j] = after;
                    return;
                }
                i = this.dnsWritePtr++;
                this.dnsWritePtr %= this.dnsMaxCount;
            }
            const before = this.dnsList[i];
            if ( before ) {
                this.dnsDict.delete(before.hn);
            }
            if ( after ) {
                this.dnsDict.set(hn, i);
                this.dnsList[i] = after;
            } else {
                if ( hn ) { this.dnsDict.delete(hn); }
                this.dnsList[i] = null;
            }
        }

        dnsShouldResolve(hn) {
            if ( this.dnsResolveEnabled === false ) { return false; }
            if ( hn === '' ) { return false; }
            const c0 = hn.charCodeAt(0);
            if ( c0 === 0x5B /* [ */ ) { return false; }
            if ( c0 > 0x39 /* 9 */ ) { return true; }
            return reIPv4.test(hn) === false;
        }

        dnsResolve(hn, details) {
            const promise = browser.dns.resolve(hn, [ 'canonical_name' ]).then(
                rec => this.dnsToCache(hn, rec, details),
                ( ) => this.dnsToCache(hn)
            );
            this.dnsDict.set(hn, promise);
            return promise;
        }

        cnameFromRecord(hn, record, details) {
            const cn = record.canonicalName;
            if ( cn === undefined ) { return; }
            if ( cn === hn ) { return; }
            if ( this.cnameIgnore1stParty ) {
                if ( domainFromHostname(cn) === domainFromHostname(hn) ) { return; }
            }
            if ( this.cnameIgnoreList !== null ) {
                if ( this.cnameIgnoreList.test(cn) ) { return; }
            }
            if ( this.cnameIgnoreRootDocument ) {
                const origin = hostnameFromNetworkURL(details.documentUrl || details.url);
                if ( hn === origin ) { return; }
            }
            return cn;
        }

        uncloakURL(hn, dnsEntry, details) {
            const hnBeg = details.url.indexOf(hn);
            if ( hnBeg === -1 ) { return; }
            const oldURL = details.url;
            const newURL = oldURL.slice(0, hnBeg) + dnsEntry.cname;
            const hnEnd = hnBeg + hn.length;
            if ( this.cnameReplayFullURL ) {
                return newURL + oldURL.slice(hnEnd);
            }
            const pathBeg = oldURL.indexOf('/', hnEnd);
            if ( pathBeg !== -1 ) {
                return newURL + oldURL.slice(hnEnd, pathBeg + 1);
            }
            return newURL;
        }

        ipFromRecord(record) {
            const { addresses } = record;
            if ( Array.isArray(addresses) === false ) { return; }
            if ( addresses.length === 0 ) { return; }
            return addresses.join('\n');
        }

        normalizeDetails(details) {
            // Chromium 63+ supports the `initiator` property, which contains
            // the URL of the origin from which the network request was made
            if ( details.initiator && details.initiator !== 'null' ) {
                details.documentUrl = details.initiator;
            }
            const type = details.type;
            if ( type === 'imageset' ) {
                details.type = 'image';
                return;
            }
            if ( type !== 'other' ) { return; }
            // Try to map known "extension" part of URL to request type
            if ( details.responseHeaders === undefined ) {
                parsedURL.href = details.url;
                const path = parsedURL.pathname;
                const pos = path.indexOf('.', path.length - 6);
                if ( pos !== -1 ) {
                    details.type = extToTypeMap.get(path.slice(pos + 1)) || type;
                }
                return;
            }
            // Try to extract type from response headers
            const ctype = this.headerValue(details.responseHeaders, 'content-type');
            if ( ctype.startsWith('font/') ) {
                details.type = 'font';
            } else if ( ctype.startsWith('image/') ) {
                details.type = 'image';
            } else if ( ctype.startsWith('audio/') || ctype.startsWith('video/') ) {
                details.type = 'media';
            }
        }

        // https://www.reddit.com/r/uBlockOrigin/comments/9vcrk3/
        //   Some types can be mapped from 'other', thus include 'other' if and
        //   only if the caller is interested in at least one of those types
        denormalizeTypes(types) {
            if ( types.length === 0 ) {
                return Array.from(this.validTypes);
            }
            const out = new Set();
            for ( const type of types ) {
                if ( this.validTypes.has(type) ) {
                    out.add(type);
                }
            }
            if ( out.has('other') === false ) {
                for ( const type of extToTypeMap.values() ) {
                    if ( out.has(type) ) {
                        out.add('other');
                        break;
                    }
                }
            }
            return Array.from(out);
        }

        // https://github.com/uBlockOrigin/uBlock-issues/issues/2063
        //   Do not interfere with root document
        suspendOneRequest(details) {
            this.onBeforeSuspendableRequest(details);
            if ( details.type === 'main_frame' ) { return; }
            return { cancel: true };
        }

        // krimium: filtering is live, the moment uBO sets its listener.
        setSuspendableListener(listener) {
            super.setSuspendableListener(listener);
            self.webkit.messageHandlers.krimium.postMessage({ type: 'ready' });
        }

        unsuspendAllRequests(discard = false) {
            if ( discard === true ) { return; }
            const toReload = [];
            for ( const tabId of this.unprocessedTabs.keys() ) {
                toReload.push(tabId);
            }
            this.removeUnprocessedRequest();
            for ( const tabId of toReload ) {
                vAPI.tabs.reload(tabId);
            }
        }
    };
}

/******************************************************************************/

// https://github.com/uBlockOrigin/uBlock-issues/issues/548
//   Use `X-DNS-Prefetch-Control` to workaround Chromium's disregard of the
//   setting "Predict network actions to improve page load performance".

vAPI.prefetching = (( ) => {
    let listening = false;

    const onHeadersReceived = function(details) {
        details.responseHeaders.push({
            name: 'X-DNS-Prefetch-Control',
            value: 'off'
        });
        return { responseHeaders: details.responseHeaders };
    };

    return state => {
        const wr = chrome.webRequest;
        if ( state && listening ) {
            wr.onHeadersReceived.removeListener(onHeadersReceived);
            listening = false;
        } else if ( !state && !listening ) {
            wr.onHeadersReceived.addListener(
                onHeadersReceived,
                {
                    urls: [ 'http://*/*', 'https://*/*' ],
                    types: [ 'main_frame', 'sub_frame' ]
                },
                [ 'blocking', 'responseHeaders' ]
            );
            listening = true;
        }
    };
})();

/******************************************************************************/
