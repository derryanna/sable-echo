import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, putScore, dropAfter, invalidate, entries, saveStore } from '../src/store.js';
import { createFakeST } from './fakes/st.mjs';

test('store creates a ring, replaces identities, caps at 60 and returns detached entries', () => {
    const { ctx } = createFakeST(), store = loadStore(ctx);
    assert.equal(store, ctx.chatMetadata.sableEcho);
    for (let mesId = 0; mesId < 62; mesId++) putScore(store, { mesId, swipeId: 0, sig: 'old' });
    assert.equal(entries(store).length, 60);
    assert.equal(entries(store)[0].mesId, 2);
    putScore(store, { mesId: 61, swipeId: 0, sig: 'new' });
    assert.equal(entries(store).length, 60);
    entries(store)[0].sig = 'mutated';
    assert.equal(store.scores[0].sig, 'old');
    invalidate(store, 61, 'new');
    assert.equal(store.scores.length, 60);
    invalidate(store, 61, 'edited');
    dropAfter(store, 10);
    assert.deepEqual(store.scores.map(e => e.mesId), [2, 3, 4, 5, 6, 7, 8, 9]);
});

test('metadata saves are debounced and never save a replacement chat', async () => {
    const { ctx, calls, getContext } = createFakeST({ snapshots: true }); loadStore(ctx);
    saveStore(getContext, ctx.chatId); saveStore(getContext, ctx.chatId); saveStore(getContext, ctx.chatId);
    assert.equal(calls.metadata.length, 0);
    await new Promise(resolve => setTimeout(resolve, 340));
    assert.equal(calls.metadata.length, 1);
    saveStore(getContext, ctx.chatId); ctx.chatId = 'chat-b'; ctx.chatMetadata = {};
    await new Promise(resolve => setTimeout(resolve, 340));
    assert.equal(calls.metadata.length, 1);
});
