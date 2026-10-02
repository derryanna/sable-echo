# Sable Echo public contract (v1)

After initialization, `index.js` exposes this optional browser global:

```js
globalThis.sableEcho = {
    version: 1,
    getBanlist(),  // → Array<{ pattern: string, example: string }>
    subscribe(cb), // → unsubscribe function
};
```

`version` is the contract version, independent of the extension release.
`getBanlist()` returns up to eight items for the current character: rhetorical
patterns first, then phrases/openers. For patterns, `pattern` is the localized
description and `example` is the user-supplied alternative. For phrases/openers,
`pattern` is the trimmed text and `example` is the first available mined example.
An unavailable example is `''`. Treat both fields as untrusted plain text.

`subscribe(cb)` calls `cb(snapshot)` immediately and on runtime updates, including
chat changes. Read `getBanlist()` inside the callback; its argument is a runtime
snapshot, not the public ban list. Call the returned function to unsubscribe.
Echo also dispatches `new CustomEvent('sable-echo:changed')` on `document` after
every ban change. The event has no ban-list payload; re-read the global and list.
Notifications may occur for other settings changes too.

Guard for absence, initialization order, and an unsupported contract version:

```js
function readEcho() {
    const echo = globalThis.sableEcho;
    return echo?.version === 1 && typeof echo.getBanlist === 'function'
        ? echo.getBanlist() : [];
}
// Use readEcho() at consumer startup and whenever refreshing its section.
document.addEventListener('sable-echo:changed', readEcho);
// Remove the listener when the consumer is disposed.
```

For subscriptions, also check `typeof echo.subscribe === 'function'` before
calling it. If Echo initializes later, retry attaching on a consumer refresh;
there is no ready event. Do not require Echo to be installed or read its storage.

With `handoff === 'sable'` and a callable
`globalThis.sableTrackers?.setExternalSection`, Echo calls
`setExternalSection('banlist', getBanlist(), { source: 'echo' })` after changes
and clears its own prompt block. Disabled injection sends `[]`; without that
API, Echo uses its own block. The receiving Sable Trackers implementation is a
separate integration.
