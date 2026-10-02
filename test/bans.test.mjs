import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRecord, normalizeRecord, newId, ban, unban, setAlt, markIntentional, unmarkIntentional, hide, unhide, setRegex, mergeCandidates, pruneHidden } from '../src/bans.js';
import * as decisions from '../src/bans.js';
import { stem } from '../src/miner.js';
const candidate = { kind: 'phrase', text: 'уголки губ дрогнули в подобии улыбки', words: ['уголки', 'губ', 'дрогнули', 'в', 'подобии', 'улыбки'] };
const options = { newId: () => 'b_00000001', now: () => 123, cuts: [3, 4, 5] };
const frozen = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') frozen(child); return Object.freeze(value); };

test('hidden expiry is chat scoped and normalization preserves the chat', () => {
    const record = frozen(hide(emptyRecord(), 'phrase', 70, 'chat-a'));
    assert.equal(normalizeRecord(record).hidden[0].chat, 'chat-a');
    assert.equal(pruneHidden(record, { chatId: 'chat-a', replies: 69 }).hidden.length, 1);
    assert.equal(pruneHidden(record, { chatId: 'chat-a', replies: 70 }).hidden.length, 0);
    assert.equal(pruneHidden(record, { chatId: 'chat-b', replies: 100 }).hidden.length, 1);
});
test('banMatches requires all kept runs in order and excludes patterns', () => {
    const record = ban(emptyRecord(), candidate, { ...options, cuts: [1, 3, 4], sinceChat: 'chat-a' });
    assert.equal(normalizeRecord(record).bans[0].sinceChat, 'chat-a');
    const matches = text => decisions.banMatches(text.split(' ').map(stem), record.bans[0]);
    assert.equal(matches('уголки рта дрогнули от улыбки'), true);
    assert.equal(matches('уголки губ дрогнули'), false);
    assert.equal(matches('улыбки дрогнули уголки'), false);
    assert.equal(decisions.banMatches(['simile'], { kind: 'pattern', text: 'simile' }), false);
});

test('ban creates a trimmed decision with injectable id and time without mutation', () => {
    const record = frozen(emptyRecord());
    const result = ban(record, frozen(candidate), options);
    assert.deepEqual(record, emptyRecord());
    assert.deepEqual(result.bans[0], { id: 'b_00000001', kind: 'phrase', text: 'уголки губ дрогнули', words: candidate.words,
        cuts: [3, 4, 5], alt: '', regex: false, regexMode: 'prompt', regexScope: 'character', added: 123, sinceIndex: 0, sinceChat: null });
    assert.deepEqual(ban(result, candidate, options), result);
    assert.equal(newId(() => 0.5), 'b_80000000');
    assert.match(newId(), /^b_[a-f0-9]{8}$/);
    assert.equal(ban(emptyRecord(), candidate, { ...options, sinceIndex: -1 }).bans[0].sinceIndex, -1);
});
test('unban, alternatives and regex operations return new records and preserve unrelated fields', () => {
    const record = frozen(ban(emptyRecord(), candidate, options));
    const alt = setAlt(record, options.newId(), '  дыхание сбилось  ');
    assert.equal(alt.bans[0].alt, 'дыхание сбилось');
    assert.equal(record.bans[0].alt, '');
    for (const mode of ['prompt', 'display', 'both']) {
        const enabled = setRegex(alt, options.newId(), true, mode);
        assert.equal(enabled.bans[0].regex, true);
        assert.equal(enabled.bans[0].regexMode, mode);
        assert.equal(setRegex(enabled, options.newId(), false).bans[0].regex, false);
    }
    assert.deepEqual(unban(record, options.newId()), emptyRecord());
    assert.deepEqual(setAlt(record, 'missing', 'unused'), record);
});
test('regex scope comes from the ban option, setRegex keeps it unless a scope is given', () => {
    const record = frozen(ban(emptyRecord(), candidate, { ...options, regexScope: 'global' }));
    assert.equal(record.bans[0].regexScope, 'global');
    const id = options.newId();
    assert.equal(setRegex(record, id, true, 'both').bans[0].regexScope, 'global', 'omitted scope is kept');
    const moved = setRegex(record, id, true, 'both', 'character');
    assert.deepEqual([moved.bans[0].regex, moved.bans[0].regexMode, moved.bans[0].regexScope], [true, 'both', 'character']);
    assert.equal(setRegex(moved, id, true, 'both', 'global').bans[0].regexScope, 'global');
    assert.equal(setRegex(moved, id, true, 'both', 'elsewhere').bans[0].regexScope, 'character', 'unknown scopes fall back');
    assert.equal(ban(emptyRecord(), candidate, { ...options, regexScope: 'bogus' }).bans[0].regexScope, 'character');
    assert.equal(record.bans[0].regexScope, 'global', 'no mutation');
});
test('intentional and hidden operations deduplicate and support restoring entries', () => {
    const start = frozen(emptyRecord());
    const intentional = markIntentional(start, 'да, хранитель');
    assert.deepEqual(markIntentional(intentional, 'да, хранитель'), intentional);
    assert.deepEqual(unmarkIntentional(intentional, 'да, хранитель'), start);
    const hidden = hide(start, candidate.text, 40);
    assert.deepEqual(hide(hidden, candidate.text, 50).hidden, [{ text: candidate.text, until: 50, chat: null }]);
    assert.deepEqual(unhide(hidden, candidate.text), start);
    assert.equal(pruneHidden(hidden, { chatId: null, replies: 39 }).hidden.length, 1);
    assert.equal(pruneHidden(hidden, { chatId: null, replies: 40 }).hidden.length, 0);
    assert.equal(hidden.hidden.length, 1);
});
test('patterns never gain regex scripts and empty trimmed phrases are not banned', () => {
    const record = ban(emptyRecord(), { kind: 'pattern', text: 'aphorism' }, options);
    assert.equal(record.bans[0].text, 'aphorism');
    assert.equal(setRegex(record, options.newId(), true, 'both').bans[0].regex, false);
    assert.deepEqual(ban(emptyRecord(), candidate, { ...options, cuts: [0, 1, 2, 3, 4, 5] }), emptyRecord());
    assert.deepEqual(ban(emptyRecord(), { kind: 'pattern', text: 'unknown' }, options), emptyRecord());
    for (const id of ['simile', 'indefinite', 'moment']) assert.equal(ban(emptyRecord(), { kind: 'pattern', text: id }, options).bans[0].text, id);
});
test('normalizeRecord drops garbage, repairs fields and caps each list deterministically', () => {
    const valid = ban(emptyRecord(), candidate, options).bans[0];
    const messy = { bans: [null, {}, { ...valid, id: 'invalid' }, { ...valid, cuts: [5, 3, 3, 4, -1, 99], alt: 8, regexMode: 'bad', regexScope: 7 }, valid],
        intentional: [null, 7, '', 'a', 'a'], hidden: [null, {}, { text: 'x', until: NaN }, { text: 'x', until: 12.7 }] };
    const value = normalizeRecord(messy);
    assert.equal(value.bans.length, 1);
    assert.equal(value.bans[0].regexMode, 'prompt');
    assert.equal(value.bans[0].regexScope, 'character');
    assert.equal(value.bans[0].alt, '');
    assert.deepEqual(value.bans[0].cuts, [3, 4, 5]);
    assert.deepEqual(value.intentional, ['a']);
    assert.deepEqual(value.hidden, [{ text: 'x', until: 12, chat: null }]);
    assert.deepEqual(normalizeRecord(value), value);
    const capped = normalizeRecord({ bans: Array.from({ length: 50 }, (_, i) => ({ ...valid, id: 'b_' + i.toString(16).padStart(8, '0') })),
        intentional: Array.from({ length: 110 }, (_, i) => `phrase ${i}`), hidden: Array.from({ length: 110 }, (_, i) => ({ text: `phrase ${i}`, until: 40 })) });
    assert.equal(capped.bans.length, 40);
    assert.equal(capped.intentional.length, 100);
    assert.equal(capped.hidden.length, 100);
    assert.deepEqual(normalizeRecord(null), emptyRecord());
});
test('mergeCandidates matches trimmed stem runs, keeps evidence and expires hidden with chat progress', () => {
    const phrase = { ...candidate, df: 9, docs: [0, 2], examples: ['Example.'] };
    const report = { phrases: [phrase, { text: 'тихие звезды', words: ['тихие', 'звезды'], df: 3, docs: [4], examples: [] }],
        openers: [{ text: 'Он медленно поднял взгляд.', df: 6, docs: [0] }], mined: 30 };
    let record = ban(emptyRecord(), candidate, options);
    assert.equal(mergeCandidates(report, record).candidates.length, 1);
    record = ban(emptyRecord(), candidate, { ...options, cuts: [1, 3, 4, 5] });
    assert.equal(mergeCandidates(report, record).candidates.length, 1);
    assert.equal(mergeCandidates({ ...report, phrases: [{ text: 'дрогнули уголки губ' }] }, record).candidates.length, 1);
    record = markIntentional(emptyRecord(), 'тихая звезда');
    const result = mergeCandidates(report, record);
    assert.deepEqual(result.candidates, [phrase]);
    assert.deepEqual(result.intentional, ['тихая звезда']);
    record = hide(emptyRecord(), candidate.text, 30);
    assert.equal(mergeCandidates(report, record, { chatId: null, replies: 30 }).candidates.length, 2);
    assert.deepEqual(mergeCandidates(report, record, { chatId: null, replies: 30 }).hidden, []);
    assert.equal(mergeCandidates(report, record).hidden.length, 1, 'the capped mining window cannot expire a dismissal');
    record = hide(record, candidate.text, 40);
    assert.equal(mergeCandidates(report, record, { chatId: null, replies: 30 }).candidates.length, 1);
    record = ban(record, { kind: 'opener', text: report.openers[0].text }, { ...options, cuts: [] });
    assert.deepEqual(mergeCandidates(report, record).openers, []);
});

test('mergeCandidates hides fragments that share two content stems with a ban', () => {
    const phrase = (text, stems) => ({ text, stems, df: 5, docs: [1, 2, 3], examples: [] });
    const report = { mined: 30, openers: [], phrases: [
        phrase('миг уголки губ дрогнули в подобии', ['миг', 'уголк', 'губ', 'дрогн', 'в', 'подоб']),
        phrase('на миг уголки губ дрогнули', ['на', 'миг', 'уголк', 'губ', 'дрогн']),
        phrase('тишина повисла в воздухе', ['тишин', 'повис', 'в', 'воздух']),
        phrase('дрогнули в его руках', ['дрогн', 'в', 'его', 'рук']) ] };
    const record = ban(emptyRecord(), { words: ['уголки', 'губ', 'дрогнули', 'в', 'подобии', 'улыбки'] }, options);
    const visible = mergeCandidates(report, record).candidates.map(c => c.text);
    assert.deepEqual(visible, ['тишина повисла в воздухе', 'дрогнули в его руках']);
});
