import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptFor, mergeScripts, ourIds, ownScripts } from '../src/regex.js';
const ban = { id: 'b_00000001', kind: 'phrase', text: 'the lamp', words: ['the', 'lamp'], cuts: [], alt: 'a candle', regex: true };
for (const mode of ['prompt', 'display', 'both']) test(`scriptFor produces a scoped AI output script in ${mode} mode`, () => {
    assert.deepEqual(scriptFor({ ...ban, regexMode: mode }, { regexFor: (words, cuts) => {
        assert.deepEqual(words, ban.words); assert.deepEqual(cuts, []); return '/test/gi';
    } }), { id: 'sable-echo:b_00000001', scriptName: 'Echo: the lamp', findRegex: '/test/gi', replaceString: 'a candle',
        trimStrings: [], placement: [2], disabled: false, markdownOnly: mode !== 'prompt', promptOnly: mode !== 'display',
        runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null });
});
test('scriptFor uses the real miner and excludes patterns', () => {
    assert.equal(scriptFor({ ...ban, regexMode: 'prompt', alt: '' }).findRegex, '/(?<![а-яёa-z])the[a-z]*\\s+lamp[a-z]*/gi');
    assert.equal(scriptFor({ ...ban, kind: 'pattern' }), null);
});
test('mergeScripts replaces only owned scripts, preserves ordering and never mutates existing scripts', () => {
    const existing = [{ id: 'external' }, { id: 'sable-echo:old' }, { id: 'other' }, { id: 'sable-echoish' }, {}];
    const copy = structuredClone(existing), ours = [{ id: 'sable-echo:new' }];
    assert.deepEqual(mergeScripts(existing, ours), [existing[0], existing[2], existing[3], existing[4], ...ours]);
    assert.deepEqual(ourIds(existing), ['sable-echo:old']);
    assert.deepEqual(ownScripts(existing), [existing[1]]);
    assert.deepEqual(ownScripts(undefined), []);
    assert.deepEqual(ownScripts({ id: 'sable-echo:x' }), [], 'only arrays are script lists');
    assert.deepEqual(existing, copy);
    assert.deepEqual(mergeScripts(undefined, []), []);
});
