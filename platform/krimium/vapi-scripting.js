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

// krimium: scriptlets, the way Firefox gets them in before a page's own
// scripts. When a frame's window is made, before any script of the page
// runs, krimium's module in that web process asks for the frame's
// scriptlets and waits for them (krimium.scriptlets below), then runs them:
// the main world's in the page's world, the isolated world's in the world
// uBO's content scripts live in. Nothing can run first.

import { hostnameFromURI } from './uri-utils.js';

/******************************************************************************/

const CACHE_MAX = 128;
const reIsHTTP = /^https?:\/\//;
const cache = new Map();
let getContentScripts;

// As Firefox's uBO_assembleCode: the early bailout code returns early for
// trusted sites.
const assemble = (world, code, details) => {
    if ( Boolean(code) === false ) { return; }
    return [
        `// ${details.hostname}`,
        `(function uBO_${world}WorldWrapper() {`,
        details.earlyBailoutCode ?? '',
        code,
        '})();',
    ].join('\n');
};

const originOf = url => {
    try { return new URL(url).origin; } catch { }
};

// A frame at url, in a page at top: what to run, as krimium reads it.
const scriptlets = (url, top) => {
    if ( getContentScripts === undefined ) { return ''; }
    if ( reIsHTTP.test(url) === false ) { return ''; }
    const hostname = hostnameFromURI(url);
    if ( hostname === '' ) { return ''; }
    const topOrigin = url !== top && reIsHTTP.test(top) ? originOf(top) : undefined;
    const key = topOrigin ? `${hostname} ${topOrigin}` : hostname;
    let answer = cache.get(key);
    if ( answer === undefined ) {
        const result = getContentScripts(url, topOrigin ? { topOrigin } : undefined);
        const main = assemble('main', result.mainCode, result);
        const isolated = assemble('isolated', result.isolatedCode, result);
        answer = main || isolated ? `s ${JSON.stringify({ main, isolated })}` : '';
        if ( cache.size >= CACHE_MAX ) {
            cache.delete(cache.keys().next().value);
        }
    } else {
        cache.delete(key);
    }
    cache.set(key, answer);
    return answer;
};

/******************************************************************************/

export async function start(fn) {
    getContentScripts = fn;
    self.krimium.scriptlets = scriptlets;
}

export function reset() {
    cache.clear();
}
