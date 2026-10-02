const pending = new WeakMap();

export function loadStore(ctx) {
    ctx.chatMetadata ??= {};
    ctx.chatMetadata.sableEcho ??= { scores: [] };
    if (!Array.isArray(ctx.chatMetadata.sableEcho.scores)) ctx.chatMetadata.sableEcho.scores = [];
    return ctx.chatMetadata.sableEcho;
}
export function putScore(store, entry) {
    store.scores = store.scores.filter(e => e.mesId !== entry.mesId || e.swipeId !== entry.swipeId);
    store.scores.push(structuredClone(entry));
    store.scores = store.scores.slice(-60);
}
export function dropAfter(store, chatLength) {
    store.scores = store.scores.filter(e => e.mesId < chatLength);
}
export function invalidate(store, mesId, sig) {
    store.scores = store.scores.filter(e => e.mesId !== mesId || e.sig === sig);
}
export const entries = store => structuredClone(store.scores);
export function cancelSaveStore(getContext) {
    clearTimeout(pending.get(getContext));
    pending.delete(getContext);
}
export function saveStore(getContext, chatId) {
    cancelSaveStore(getContext);
    pending.set(getContext, setTimeout(() => {
        pending.delete(getContext);
        const ctx = getContext();
        if (ctx.getCurrentChatId() === chatId) void ctx.saveMetadata();
    }, 300));
}
