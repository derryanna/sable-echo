import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRuntime } from '../src/run.js';
import { createFakeST, deferred } from './fakes/st.mjs';
import { buildBlock } from '../src/block.js';
import { buildState, questionsFor } from '../src/sensors.js';
import { normalizeSettings } from '../src/settings.js';
const chat = JSON.parse(readFileSync(new URL('../fixtures/chat-repeats.json', import.meta.url)));
const answers = JSON.parse(readFileSync(new URL('../fixtures/jev-answers.json', import.meta.url)));
const response = () => ({ ok: true, json: async () => answers });
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(t, patch = {}, fetch = async () => response()) {
    const fake = createFakeST();
    fake.ctx.chat = structuredClone(chat);
    fake.ctx.extensionSettings.sableEcho = normalizeSettings(patch);
    let id = 0;
    const runtime = createRuntime(fake.getContext, { fetch, newId: () => 'b_' + (++id).toString(16).padStart(8, '0') });
    t.after(() => runtime.dispose());
    return { ...fake, runtime };
}
const jev = { jev: { enabled: true, apiKey: 'test-key' } };

for (const variant of ['short', 'ooc', 'disabled', 'failed', 'pending']) test(`swipe drops outgoing scores immediately: ${variant}`, async t => {
    let fail = false, requests = 0;
    const { runtime: r, ctx, emit, add } = setup(t, jev, async () => {
        requests++;
        if (fail) throw new Error('Synthetic failure');
        return response();
    });
    const id = add('Synthetic narration. '.repeat(20));
    await emit('CHARACTER_MESSAGE_RENDERED', id); await settle();
    assert.equal(ctx.chatMetadata.sableEcho.scores.length, 1);
    const m = ctx.chat[id]; m.swipes = [m.mes]; m.swipe_id = 1;
    if (variant !== 'pending') m.swipes.push(m.mes);
    if (variant === 'short') m.mes = 'Short.';
    if (variant === 'ooc') m.mes = 'OOC: ' + m.mes;
    if (variant === 'disabled') r.updateSettings({ jev: { enabled: false } });
    fail = variant === 'failed';
    await emit('MESSAGE_SWIPED', id);
    assert.equal(ctx.chatMetadata.sableEcho.scores.length, 0);
    await settle();
    assert.equal(r.snapshot().sensors, null);
    assert.notEqual(r.snapshot().patterns.find(p => p.id === 'aphorism').source, 'jev');
    assert.equal(requests, variant === 'failed' ? 2 : 1);
    if (variant === 'pending') {
        m.mes = 'New synthetic variant. '.repeat(20); m.swipes.push(m.mes);
        await emit('CHARACTER_MESSAGE_RENDERED', id); await settle();
        assert.equal(requests, 2);
        assert.equal(ctx.chatMetadata.sableEcho.scores[0].swipeId, 1);
    }
});

test('historical swipe scores its own identity, and later edits reject pending answers', async t => {
    const pending = [];
    const { runtime: r, ctx, emit, add } = setup(t, jev, () => { const d = deferred(); pending.push(d); return d.promise; });
    const id = add('Historical synthetic reply. '.repeat(20));
    add('Latest synthetic reply. '.repeat(20));
    ctx.chat[id].swipe_id = 1; ctx.chat[id].swipes = ['old', ctx.chat[id].mes];
    await emit('MESSAGE_SWIPED', id);
    pending[0].resolve(response()); await settle();
    assert.equal(ctx.chatMetadata.sableEcho.scores[0]?.mesId, id);
    ctx.chat[id].swipe_id = 0;
    await emit('MESSAGE_SWIPED', id);
    ctx.chat[id].mes += ' Edited.';
    await emit('MESSAGE_EDITED', id);
    pending[1].resolve(response()); await settle();
    assert.equal(ctx.chatMetadata.sableEcho.scores.length, 0);
    assert.equal(r.snapshot().log[0].status, 'dropped');
});

for (const trigger of ['MESSAGE_DELETED', 'MESSAGE_EDITED', 'CHAT_CHANGED', 'snapshot']) test(`reconcile rejects shifted and stale scores on ${trigger}`, async t => {
    const { runtime: r, ctx, emit, add } = setup(t, jev);
    const a = add('First synthetic reply. '.repeat(20));
    await emit('CHARACTER_MESSAGE_RENDERED', a); await settle();
    const b = add('Second synthetic reply. '.repeat(20));
    await emit('CHARACTER_MESSAGE_RENDERED', b); await settle();
    assert.equal(ctx.chatMetadata.sableEcho.scores.length, 2);
    if (trigger === 'MESSAGE_DELETED') ctx.chat.splice(a, 1);
    else { ctx.chat[a].mes += ' Changed.'; ctx.chat[b].swipe_id = 1; }
    if (trigger !== 'snapshot') await emit(trigger, a);
    assert.equal(r.snapshot().sensors, null);
    assert.equal(ctx.chatMetadata.sableEcho.scores.length, 0);
});

test('hidden expiry uses uncapped replies, stays chat scoped, and explicit rescan clears all', async t => {
    const { runtime: r, ctx, emit, add, calls } = setup(t, { miner: { minChars: 0 } });
    ctx.chat = Array.from({ length: 65 }, () => ({ mes: 'Synthetic repeated phrase.', is_user: false }));
    await emit('CHAT_CHANGED'); r.hide('Synthetic repeated phrase');
    assert.deepEqual(ctx.extensionSettings.sableEcho.characters['keeper.png'].hidden, [{ text: 'Synthetic repeated phrase', until: 75, chat: 'chat-a' }]);
    for (let i = 0; i < 9; i++) await emit('CHARACTER_MESSAGE_RENDERED', add('Another synthetic reply.'));
    assert.equal(r.snapshot().hidden.length, 1);
    await emit('CHARACTER_MESSAGE_RENDERED', add('Another synthetic reply.'));
    assert.equal(r.snapshot().hidden.length, 0);
    r.hide('phrase');
    ctx.chatId = 'chat-b'; ctx.chat = Array.from({ length: 100 }, () => ({ mes: 'Other reply.' })); ctx.chatMetadata = {};
    await emit('CHAT_CHANGED');
    assert.deepEqual(r.snapshot().hidden, ['phrase']);
    await emit('MESSAGE_EDITED', 0);
    assert.deepEqual(r.snapshot().hidden, ['phrase']);
    const saves = calls.settings; r.rescan();
    assert.deepEqual(r.snapshot().hidden, []);
    assert.equal(calls.settings, saves + 1);
});

test('seen again uses exact kept runs and the same mined population across chats', async t => {
    const { runtime: r, ctx, emit, add } = setup(t, { miner: { replies: 10, minChars: 20 } });
    r.banText('brass wheel turned'); r.banPattern('simile');
    assert.equal(r.snapshot().bans[0].sinceChat, 'chat-a');
    add('brass wheel stopped beside the dome.');
    add('brass wheel turned beside the dome.');
    add('short'); add('OOC: brass wheel turned beside the dome.');
    await emit('CHARACTER_MESSAGE_RENDERED', ctx.chat.length - 1);
    assert.deepEqual(r.snapshot().bans.map(b => [b.sinceReplies, b.seenAfter]), [[2, 1], [2, 0]]);
    for (let i = 0; i < 12; i++) add('brass wheel turned beside the dome.');
    r.rescan();
    assert.deepEqual([r.snapshot().bans[0].sinceReplies, r.snapshot().bans[0].seenAfter], [10, 10]);
    ctx.chatId = 'chat-b'; ctx.chatMetadata = {}; ctx.chat = [{ mes: 'brass wheel turned beside the dome.' }];
    await emit('CHAT_CHANGED');
    assert.deepEqual([r.snapshot().bans[0].sinceReplies, r.snapshot().bans[0].seenAfter], [1, 1]);
});

for (const action of ['switch', 'dispose']) test(`runtime cancels pending metadata saves on ${action}`, async t => {
    const { runtime: r, emit, add, calls } = setup(t, jev);
    await emit('CHARACTER_MESSAGE_RENDERED', add('Synthetic narration. '.repeat(20))); await settle();
    if (action === 'dispose') r.dispose();
    else await emit('CHAT_CHANGED');
    await new Promise(resolve => setTimeout(resolve, 340));
    assert.equal(calls.metadata.length, 0);
});

test('render mines candidates; ban saves exact injection, counts new matches and returns fresh snapshots', async t => {
    const { runtime: r, ctx, emit, calls, add } = setup(t);
    await emit('CHARACTER_MESSAGE_RENDERED', ctx.chat.length - 1);
    const snap = r.snapshot(), candidate = snap.candidates.find(c => c.words.join(' ') === 'the lamp guttered');
    assert.ok(candidate);
    let notified = 0; const unsub = r.subscribe(() => notified++);
    const before = calls.settings;
    r.ban(candidate.key);
    assert.equal(calls.settings, before + 1);
    assert.deepEqual(calls.prompts.at(-1), ['sable_echo', buildBlock({ bans: r.snapshot().bans }), 1, 1, false, 0]);
    assert.equal(r.snapshot().bans[0].matches, 4);
    const mesId = add('The lamp guttered. ' + 'The room remained quiet. '.repeat(12));
    await emit('CHARACTER_MESSAGE_RENDERED', mesId);
    assert.equal(r.snapshot().bans[0].seenAfter, 1);
    assert.equal(r.snapshot().bans[0].sinceReplies, 1);
    assert.equal(r.snapshot().bans[0].matches, 5);
    r.snapshot().bans[0].words.length = 0;
    assert.equal(r.snapshot().bans[0].words.length, 3);
    r.setInject(false); assert.equal(calls.prompts.at(-1)[1], '');
    assert.ok(notified > 1); unsub();
    assert.deepEqual(ctx.chat.slice(0, chat.length), chat);
});

test('Jev batches wire questions and exposes sensors and patterns; swipe, edit, delete maintain scores', async t => {
    const requests = [];
    const { runtime: r, ctx, emit, add } = setup(t, jev, async (url, options) => { requests.push(JSON.parse(options.body)); return response(); });
    const mesId = add('The lamp guttered. ' + 'The room remained quiet. '.repeat(12));
    await emit('CHARACTER_MESSAGE_RENDERED', mesId); await settle();
    assert.deepEqual(requests[0].state, buildState(ctx.chat, mesId));
    assert.deepEqual(requests[0].questions, questionsFor());
    assert.deepEqual(Object.keys(requests[0]), ['model', 'state', 'questions']);
    assert.equal(r.snapshot().sensors.repeats.value, 2.5);
    assert.equal(r.snapshot().sensors.repeats.colour, 'amber');
    assert.equal(r.snapshot().patterns.find(p => p.id === 'aphorism').count, 1);
    assert.ok(r.snapshot().patterns.find(p => p.id === 'aphorism').example);
    assert.equal(r.snapshot().patterns.find(p => p.id === 'aphorism').source, 'jev');
    assert.equal(r.snapshot().patterns.find(p => p.id === 'simile').source, 'miner', 'Jev never scores the local-only patterns');
    ctx.chat[mesId].swipe_id = 1; ctx.chat[mesId].swipes = [ctx.chat[mesId].mes, ctx.chat[mesId].mes];
    await emit('MESSAGE_SWIPED', mesId); await settle();
    assert.equal(ctx.chatMetadata.sableEcho.scores.length, 1);
    assert.equal(ctx.chatMetadata.sableEcho.scores[0].swipeId, 1);
    ctx.chat[mesId].mes += ' Edited.'; await emit('MESSAGE_EDITED', mesId);
    assert.equal(ctx.chatMetadata.sableEcho.scores.length, 0);
    await emit('CHARACTER_MESSAGE_RENDERED', mesId); await settle();
    ctx.chat.pop(); await emit('MESSAGE_DELETED');
    assert.equal(ctx.chatMetadata.sableEcho.scores.length, 0);
});

test('event handlers return before Jev finishes and unchanged historical replies keep answers', async t => {
    const pending = [];
    const { runtime: r, ctx, emit, add } = setup(t, jev, () => { const d = deferred(); pending.push(d); return d.promise; });
    const first = add('A synthetic long response. '.repeat(15));
    await emit('CHARACTER_MESSAGE_RENDERED', first);
    await emit('CHARACTER_MESSAGE_RENDERED', first);
    assert.equal(pending.length, 1);
    const second = add('Another synthetic long response. '.repeat(15));
    await emit('CHARACTER_MESSAGE_RENDERED', second);
    pending[0].resolve(response()); await settle();
    assert.equal(r.snapshot().log[0].status, 'ok');
    assert.equal(r.snapshot().jev.busy, true);
    assert.equal(ctx.chatMetadata.sableEcho.scores[0].mesId, first);
    pending[1].resolve(response()); await settle();
    assert.equal(ctx.chatMetadata.sableEcho.scores.at(-1).mesId, second);
    assert.equal(r.snapshot().jev.busy, false);
});

test('regex writes are scoped, preserve other scripts, opt in avatar, update alternatives and remove on unban', async t => {
    const { runtime: r, ctx, calls } = setup(t);
    ctx.characters[0].data.extensions.regex_scripts = [{ id: 'other', findRegex: '/keep/' }];
    r.banText('the lamp guttered'); const id = r.snapshot().bans[0].id;
    await r.setRegex(id, true, 'prompt');
    assert.deepEqual(ctx.extensionSettings.character_allowed_regex, ['keeper.png']);
    assert.equal(calls.fields.at(-1)[0], 0);
    assert.equal(calls.fields.at(-1)[1], 'regex_scripts');
    assert.equal(calls.fields.at(-1)[2][1].promptOnly, true);
    await r.setAlt(id, 'a candle flickered');
    assert.equal(calls.fields.at(-1)[2][1].replaceString, 'a candle flickered');
    await r.unban(id);
    assert.deepEqual(calls.fields.at(-1)[2], [{ id: 'other', findRegex: '/keep/' }]);
});

test('alternatives require a cc profile, parse three lines, and record errors', async t => {
    const { runtime: r, calls, respond } = setup(t);
    r.banText('the lamp guttered'); const id = r.snapshot().bans[0].id;
    assert.deepEqual(await r.suggestAlt(id), []); assert.equal(calls.requests.length, 0);
    r.updateSettings({ altProfileId: 'side' });
    respond({ content: '1. "A candle flickered"\n2) «A shadow moved»\n\n3. A door creaked\n4. Ignored' });
    assert.deepEqual(await r.suggestAlt(id), ['A candle flickered', 'A shadow moved', 'A door creaked']);
    assert.equal(calls.requests[0][2], 120);
    assert.equal(calls.requests[0][3].includePreset, false);
    assert.equal(calls.requests[0][3].includeInstruct, false);
    assert.ok(calls.requests[0][3].signal instanceof AbortSignal);
    respond(() => { throw new Error('Synthetic failure'); });
    assert.deepEqual(await r.suggestAlt(id), []);
    assert.equal(r.snapshot().log[0].kind, 'alt');
    assert.equal(r.snapshot().busy.alternatives, null);
});

test('handoff clears own prompt; groups skip bans and regex; dispose removes listeners', async t => {
    const external = [], previous = globalThis.sableTrackers;
    globalThis.sableTrackers = { setExternalSection: (...args) => external.push(args) };
    t.after(() => { if (previous) globalThis.sableTrackers = previous; else delete globalThis.sableTrackers; });
    const { runtime: r, ctx, calls, handlers } = setup(t, { handoff: 'sable' });
    r.banText('the lamp guttered');
    assert.deepEqual(external.at(-1), ['banlist', r.getBanlist(), { source: 'echo' }]);
    assert.equal(calls.prompts.at(-1)[1], '');
    ctx.groupId = 'group';
    const before = calls.settings;
    r.banText('another phrase'); await r.setRegex(r.snapshot().bans[0].id, true);
    assert.equal(calls.settings, before); assert.equal(calls.fields.length, 0);
    assert.equal(r.snapshot().log[0].status, 'skipped');
    r.dispose(); assert.ok([...handlers.values()].every(s => s.size === 0));
    assert.equal(calls.prompts.at(-1)[1], '');
});

test('chat changes reload the character and store; testJev never writes scores', async t => {
    const requests = [];
    const { runtime: r, ctx, emit, calls } = setup(t, jev, async (_url, options) => { requests.push(JSON.parse(options.body)); return response(); });
    r.banText('the lamp guttered');
    ctx.characters.push({ name: 'Second', avatar: 'second.png', data: { extensions: {} } });
    ctx.characterId = 1; ctx.chatId = 'chat-b'; ctx.chatMetadata = {}; ctx.chat = [];
    await emit('CHAT_CHANGED');
    assert.equal(r.snapshot().avatar, 'second.png'); assert.deepEqual(r.snapshot().bans, []);
    assert.equal(calls.prompts.at(-1)[1], '');
    assert.equal((await r.testJev()).ok, true);
    assert.deepEqual(Object.keys(requests[0].questions), ['repeats']);
    assert.deepEqual(ctx.chatMetadata.sableEcho.scores, []);
    assert.equal(r.snapshot().visual.fontSize, 13);
});

test('ban before the first reply counts that reply, and middle edits refresh cached mining', async t => {
    const { runtime: r, ctx, emit, add } = setup(t, { miner: { minChars: 0, minDf: 2 } });
    ctx.chat = []; await emit('CHAT_CHANGED');
    r.banText('the lamp guttered');
    assert.equal(r.snapshot().bans[0].sinceIndex, -1);
    await emit('CHARACTER_MESSAGE_RENDERED', add('The lamp guttered.'));
    assert.equal(r.snapshot().bans[0].sinceReplies, 1);
    assert.equal(r.snapshot().bans[0].seenAfter, 1);
    await r.unban(r.snapshot().bans[0].id);
    add('The lamp guttered.'); add('The lamp guttered.'); r.rescan();
    assert.equal(r.snapshot().candidates[0].df, 3);
    ctx.chat[1].mes = 'A different scene.'; await emit('MESSAGE_EDITED', 1);
    assert.equal(r.snapshot().candidates[0].df, 2);
    await emit('CHARACTER_MESSAGE_RENDERED', 2);
    assert.equal(r.snapshot().candidates[0].df, 2);
});

test('regex writes serialize rapid enable and unban actions', async t => {
    const { runtime: r, ctx } = setup(t);
    const gate = deferred(), writes = [];
    ctx.writeExtensionField = async (_id, _key, scripts) => {
        writes.push(scripts);
        if (writes.length === 1) await gate.promise;
        ctx.characters[0].data.extensions.regex_scripts = scripts;
    };
    r.banText('the lamp guttered'); const id = r.snapshot().bans[0].id;
    const enable = r.setRegex(id, true); await settle();
    const remove = r.unban(id); await settle();
    assert.equal(writes.length, 1);
    gate.resolve(); await Promise.all([enable, remove]);
    assert.deepEqual(ctx.characters[0].data.extensions.regex_scripts, []);
});

test('Jev filters short, OOC, user and system turns, logs failures and caps its memory log', async t => {
    let requests = 0;
    const { runtime: r, ctx, emit, add } = setup(t, jev, async () => { requests++; throw new TypeError('Synthetic offline'); });
    for (const [text, extra] of [['short', {}], ['OOC: ' + 'outside '.repeat(40), {}], ['user '.repeat(60), { is_user: true }], ['system '.repeat(60), { is_system: true }]]) {
        await emit('CHARACTER_MESSAGE_RENDERED', add(text, extra));
    }
    assert.equal(requests, 0);
    for (let i = 0; i < 6; i++) { await emit('CHARACTER_MESSAGE_RENDERED', add('Synthetic narration. '.repeat(20))); await settle(); }
    assert.equal(r.snapshot().log.length, 5);
    assert.equal(r.snapshot().log[0].status, 'failed');
    assert.equal(r.snapshot().jev.error.kind, 'network');
    assert.deepEqual(ctx.chatMetadata.sableEcho.scores, []);
    r.clearLog(); assert.deepEqual(r.snapshot().log, []);
});

test('a pending response cannot cross chats, even when chat id is later reused', async t => {
    const gate = deferred();
    const { runtime: r, ctx, emit, add } = setup(t, jev, () => gate.promise);
    await emit('CHARACTER_MESSAGE_RENDERED', add('Synthetic narration. '.repeat(20)));
    const oldMetadata = ctx.chatMetadata;
    ctx.chatMetadata = {}; await emit('CHAT_CHANGED');
    gate.resolve(response()); await settle();
    assert.equal(r.snapshot().log[0].status, 'dropped');
    assert.deepEqual(oldMetadata.sableEcho.scores, []);
    assert.deepEqual(ctx.chatMetadata.sableEcho.scores, []);
});

test('decisions, registry ordering, reset and handoff transitions use the same record', async t => {
    const external = [], prior = globalThis.sableTrackers;
    globalThis.sableTrackers = { setExternalSection: (...args) => external.push(args) };
    t.after(() => { if (prior) globalThis.sableTrackers = prior; else delete globalThis.sableTrackers; });
    const { runtime: r, calls } = setup(t);
    const c = r.snapshot().candidates[0];
    r.markIntentional(c.text); assert.ok(!r.snapshot().candidates.some(p => p.key === c.key));
    r.unmarkIntentional(c.text); r.hide(c.text); assert.ok(r.snapshot().hidden.includes(c.text));
    r.unhide(c.text); assert.ok(r.snapshot().candidates.some(p => p.key === c.key));
    r.banOpener(r.snapshot().openers[0].key);
    for (let i = 0; i < 9; i++) r.banText(`synthetic phrase ${i}`);
    r.banPattern('aphorism');
    assert.equal(r.getBanlist().length, 8);
    assert.equal(r.getBanlist()[0].pattern, 'закрывающий афоризм в конце ответа');
    r.setBlockLanguage('ru'); assert.match(r.preview().text, /Избегай/);
    r.updateSettings({ handoff: 'sable' }); assert.equal(calls.prompts.at(-1)[1], '');
    r.updateSettings({ handoff: 'self' }); assert.deepEqual(external.at(-1)[1], []);
    assert.equal(calls.prompts.at(-1)[1], r.preview().text);
    await r.resetCharacter(); assert.deepEqual(r.snapshot().bans, []);
    assert.equal(calls.prompts.at(-1)[1], '');
});

test('patterns are always an array: local counts without Jev; banned and hidden ids leave the list', t => {
    const { runtime: r } = setup(t);
    const patterns = r.snapshot().patterns;
    assert.deepEqual(patterns.map(p => p.id), ['antithesis', 'filter', 'negation', 'aphorism', 'simile', 'indefinite', 'moment']);
    assert.deepEqual(patterns.find(p => p.id === 'aphorism'), { id: 'aphorism', source: null, count: null, window: 0, rate: null, example: '' });
    assert.deepEqual(patterns.find(p => p.id === 'antithesis'), { id: 'antithesis', source: 'miner', count: 1, window: 10, rate: 0.1,
        example: 'Это был не сигнал, а отражение света.' });
    r.banPattern('simile'); r.hide('moment');
    assert.deepEqual(r.snapshot().patterns.map(p => p.id), ['antithesis', 'filter', 'negation', 'aphorism', 'indefinite']);
    assert.match(r.preview().text, /«as if \/ like» similes as ornament/);
});

test('global regex scope uses SillyTavern\'s list without a card write; a scope change moves the script; unban cleans both', async t => {
    const { runtime: r, ctx, calls } = setup(t, { regexScope: 'global' });
    assert.equal(Object.hasOwn(ctx.extensionSettings, 'regex'), false);
    r.banText('the lamp guttered'); const id = r.snapshot().bans[0].id;
    assert.equal(r.snapshot().bans[0].regexScope, 'global', 'taken from settings.regexScope at ban time');
    assert.equal(r.snapshot().settings.regexScope, 'global');
    const saves = calls.settings;
    await r.setRegex(id, true, 'display');
    assert.deepEqual(ctx.extensionSettings.regex.map(s => s.id), [`sable-echo:${id}`], 'the global list is created');
    assert.equal(ctx.extensionSettings.regex[0].markdownOnly, true);
    assert.equal(calls.fields.length, 0, 'no card write');
    assert.equal(ctx.extensionSettings.character_allowed_regex, undefined, 'no opt-in needed');
    assert.ok(calls.settings > saves + 1, 'record save and global list save');
    const list = ctx.extensionSettings.regex; list.unshift({ id: 'user-script' });
    await r.setRegex(id, true, 'display', 'character');
    assert.equal(ctx.extensionSettings.regex, list, 'the same array, changed in place');
    assert.deepEqual(list, [{ id: 'user-script' }]);
    assert.deepEqual(ctx.characters[0].data.extensions.regex_scripts.map(s => s.id), [`sable-echo:${id}`]);
    assert.deepEqual(ctx.extensionSettings.character_allowed_regex, ['keeper.png']);
    assert.equal(r.snapshot().bans[0].regexScope, 'character');
    await r.setRegex(id, true, 'display', 'global');
    assert.deepEqual(ctx.characters[0].data.extensions.regex_scripts, []);
    assert.deepEqual(list.map(s => s.id), ['user-script', `sable-echo:${id}`]);
    await r.setRegex(id, true, 'both');
    assert.equal(r.snapshot().bans[0].regexScope, 'global', 'an omitted scope keeps the ban\'s scope');
    const writes = calls.fields.length;
    await r.setAlt(id, 'a candle flickered');
    assert.equal(list[1].replaceString, 'a candle flickered');
    await r.unban(id);
    assert.deepEqual(list, [{ id: 'user-script' }]);
    assert.equal(calls.fields.length, writes, 'the card held none of ours, so it was never rewritten');
});

test('reset cleans both stores and keeps the global scripts of other characters', async t => {
    const { runtime: r, ctx, emit } = setup(t);
    r.banText('the lamp guttered'); r.banText('the brass wheel turned');
    const [local, global] = r.snapshot().bans.map(b => b.id);
    await r.setRegex(local, true, 'prompt');
    await r.setRegex(global, true, 'prompt', 'global');
    assert.deepEqual(ctx.characters[0].data.extensions.regex_scripts.map(s => s.id), [`sable-echo:${local}`]);
    assert.deepEqual(ctx.extensionSettings.regex.map(s => s.id), [`sable-echo:${global}`]);
    ctx.characters.push({ name: 'Second', avatar: 'second.png', data: { extensions: {} } });
    ctx.characterId = 1; await emit('CHAT_CHANGED');
    r.banText('another phrase'); const other = r.snapshot().bans[0].id;
    await r.setRegex(other, true, 'both', 'global');
    assert.deepEqual(ctx.extensionSettings.regex.map(s => s.id), [`sable-echo:${global}`, `sable-echo:${other}`]);
    ctx.characterId = 0; await emit('CHAT_CHANGED');
    await r.resetCharacter();
    assert.deepEqual(r.snapshot().bans, []);
    assert.deepEqual(ctx.characters[0].data.extensions.regex_scripts, []);
    assert.deepEqual(ctx.extensionSettings.regex.map(s => s.id), [`sable-echo:${other}`], 'the second character keeps its global ban');
    assert.equal(ctx.characters[1].data.extensions.regex_scripts, undefined);
});

test('importSableVisual copies the Sable Trackers look read-only, known keys only', t => {
    const missing = createFakeST(), r0 = createRuntime(missing.getContext);
    t.after(() => r0.dispose());
    assert.equal(r0.importSableVisual(), false, 'Sable Trackers has no visual settings');
    assert.deepEqual(missing.ctx.extensionSettings.sableTrackers, { profileId: 'side' }, 'nothing is written to Sable Trackers');
    const none = createFakeST();
    delete none.ctx.extensionSettings.sableTrackers;
    const r1 = createRuntime(none.getContext);
    t.after(() => r1.dispose());
    assert.equal(r1.importSableVisual(), false, 'not installed');
    assert.equal('sableTrackers' in none.ctx.extensionSettings, false);
    const empty = createFakeST({ sableVisual: { cardFill: 0.2, icons: 'emoji' } }), r2 = createRuntime(empty.getContext);
    t.after(() => r2.dispose());
    assert.equal(r2.importSableVisual(), false, 'no key Echo knows');
    const picture = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    const sable = { opacity: 0.8, blur: 6, fontSize: 13, widthVw: 70, accent: '#b388ff', base: '#0b0b14', text: null, radius: 12,
        motion: false, spacing: 'compact', bgImage: picture, bgDim: 0.3, bgFit: 'contain', icons: 'emoji', cardFill: 0.2,
        titleFont: 'serif', cardColors: { world: '#ff0000' } };
    const fake = createFakeST({ sableVisual: structuredClone(sable) }), r = createRuntime(fake.getContext);
    t.after(() => r.dispose());
    const before = structuredClone(fake.ctx.extensionSettings.sableTrackers), saves = fake.calls.settings;
    let notified = 0; r.subscribe(() => notified++);
    assert.equal(r.importSableVisual(), true);
    const visual = fake.ctx.extensionSettings.sableEcho.visual;
    assert.deepEqual(visual, { scale: 1, opacity: 0.8, blur: 6, fontSize: 13, widthVw: 70, accent: '#b388ff', base: '#0b0b14', text: null, radius: 12,
        motion: false, spacing: 'compact', chipSize: 36, bgImage: picture, bgDim: 0.3, bgFit: 'contain', phoneFull: false });
    assert.deepEqual(r.snapshot().visual, visual);
    assert.deepEqual(fake.ctx.extensionSettings.sableTrackers, before, 'Sable Trackers settings stay untouched');
    assert.ok(fake.calls.settings > saves, 'saved like any settings change');
    assert.ok(notified >= 2, 'subscribers see the new look');
    // Bad values from Sable fall back through normalizeSettings instead of reaching the drawer.
    fake.ctx.extensionSettings.sableTrackers.visual = { accent: 'red', bgImage: 'javascript:alert(1)', bgFit: 'stretch', opacity: 7 };
    assert.equal(r.importSableVisual(), true);
    assert.deepEqual([r.snapshot().visual.accent, r.snapshot().visual.bgImage, r.snapshot().visual.bgFit, r.snapshot().visual.opacity], ['#f5f4ee', null, 'cover', 1]);
});

test('a global regex write emits SETTINGS_UPDATED when the host has that event type, and nothing otherwise (SPEC §19.4)', async t => {
    const { runtime: r, ctx, calls } = setup(t);
    r.updateSettings({ regexScope: 'global' });
    r.banText('the lamp guttered'); const id = r.snapshot().bans[0].id;
    await r.setRegex(id, true, 'prompt');
    assert.equal(ctx.extensionSettings.regex.length, 1, 'the global list was written');
    assert.deepEqual(calls.emits, [], 'the fake host has no SETTINGS_UPDATED: nothing is emitted');
    ctx.eventTypes.SETTINGS_UPDATED = 'settings_updated';
    await r.setRegex(id, true, 'display');
    assert.deepEqual(calls.emits, [['settings_updated']], 'emitted once after the global write');
    await r.setAlt(id, 'a candle flickered');
    assert.equal(calls.emits.length, 2, 'every change of the global list announces itself');
    // Character-scope scripts go to the card, not to the global list: no emit.
    r.banText('the door creaked'); const local = r.snapshot().bans[1].id;
    await r.setRegex(local, true, 'prompt', 'character');
    assert.equal(calls.emits.length, 2);
    // A throwing listener does not fail the write; the record keeps its regex.
    ctx.eventSource.emit = () => { throw new Error('synthetic listener failure'); };
    await r.setRegex(id, false);
    assert.equal(ctx.extensionSettings.regex.length, 0);
    assert.equal(r.snapshot().bans[0].regex, false);
    assert.equal(r.snapshot().busy.regex, null);
});
