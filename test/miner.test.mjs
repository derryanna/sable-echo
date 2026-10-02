import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanReply, stem, narratorTexts, mineRepeats, trimPhrase, regexFor, countMatches, report, hashText } from '../src/miner.js';
const chat = JSON.parse(readFileSync(new URL('../fixtures/chat-repeats.json', import.meta.url)));

test('regexFor matches raw yo and normalized e in every stem position', () => {
    assert.equal(regexFor(['ёжик']), '/(?<![а-яёa-z])[её]жик[а-яё]*/gi');
    assert.equal(countMatches(regexFor(['ёжик']), ['Ёжик', 'ежики']), 2);
    assert.equal(countMatches(regexFor(['берёза']), ['берёза', 'береза']), 2);
});
test('cleanReply keeps ordinary rule sections and Markdown tables', () => {
    const prose = 'Opening.\n---\nOrdinary scene continues.\nSomeone smiles 🙂.\nClosing.';
    assert.equal(cleanReply(prose), prose);
    assert.equal(cleanReply('Opening.\n---\n🌙 Night\n\n🔭 Dome'), 'Opening.');
    assert.equal(cleanReply('date | place | weather\nOpening.'), 'Opening.');
    for (const table of ['| Item | Value |\n|---|---|\n| Lamp | Lit |', 'Item | Value\n--- | ---\nLamp | Lit']) {
        assert.equal(cleanReply(table), table);
    }
    const long = 'x'.repeat(41) + ' | place | weather\nOpening.';
    assert.equal(cleanReply(long), long);
});

for (const tag of ['style', 'script', 'details', 'plan', 'info', 'think', 'thinking', 'sable_state', 'state', 'tracker', 'mood', 'Blocks', 'World_State', 'checklist']) {
    test(`cleanReply removes the ${tag} block including attributes and mixed case`, () => {
        assert.equal(cleanReply(`Before <${tag.toUpperCase()} class="x">secret\nsecret</${tag}> after.`), 'Before  after.');
    });
}
test('cleanReply removes comments, code fences, images, markup, headers and tracker lines', () => {
    const raw = 'date | place | weather\n<!-- secret -->```hidden\ncode```![alt](image.png)![nested](image(a).png)![ref][image]\n<b>Visible</b>\n🌙 hidden\n\n\nMore.\n---\n🔭 tracker\n🌙 extra hidden';
    assert.equal(cleanReply(raw), 'Visible\n\nMore.');
    assert.equal(cleanReply('Text.\n---\nOrdinary prose.'), 'Text.\n---\nOrdinary prose.');
    assert.equal(cleanReply(null), '');
});
test('narratorTexts retains the greeting and source indexes, filters short, OOC, user and system messages', () => {
    const before = structuredClone(chat);
    const texts = narratorTexts(chat);
    assert.equal(texts.length, 30);
    assert.equal(texts[0].index, 0);
    assert.equal(texts.at(-1).index, 58);
    assert.ok(texts.every(t => t.text.length >= 200));
    assert.ok(texts.every(t => !t.text.includes('tracker only') && !t.text.includes('Купол: открыт')));
    assert.deepEqual(narratorTexts(chat, { replies: 2 }), texts.slice(-2));
    assert.deepEqual(narratorTexts(chat, { replies: 0 }), []);
    for (const prefix of ['[OOC: note]', 'OOC: note', '(OOC note)']) {
        assert.deepEqual(narratorTexts([{ mes: prefix }], { minChars: 0 }), []);
    }
    assert.deepEqual(chat, before);
});
test('mineRepeats finds planted phrases with document frequency and original source indexes', () => {
    const result = mineRepeats(narratorTexts(chat));
    assert.equal(result.mined, 30);
    for (const [text, df] of [['уголки губ дрогнули в подобии улыбки', 9], ['тишина повисла в воздухе', 7], ['the lamp guttered', 4], ['the brass wheel turned', 4]]) {
        const phrase = result.phrases.find(p => p.text === text);
        assert.ok(phrase, text);
        assert.equal(phrase.df, df);
        assert.equal(phrase.docs.length, df);
        assert.equal(new Set(phrase.docs).size, df);
        assert.deepEqual(phrase.words.map(stem), phrase.stems);
        assert.equal(phrase.examples.length, 2);
        assert.ok(phrase.examples.every(e => e.length <= 200 && !e.includes('«')));
        assert.ok(phrase.examples.every((e, i) => chat[phrase.docs[i]].mes.includes(e)));
    }
    assert.equal(result.openers[0].df, 6);
    assert.match(result.openers[0].text, /^Он медленно поднял взгляд/);
    assert.deepEqual(Object.keys(result), ['phrases', 'openers', 'mined'], 'stock constructions moved to localPatternCounts');
});
test('mining counts replies, not occurrences, and samples different replies with original casing', () => {
    const result = mineRepeats(['The lamp guttered. The lamp guttered.', 'THE LAMP guttered.', 'The lamp guttered.']);
    const phrase = result.phrases.find(p => p.text === 'the lamp guttered');
    assert.equal(phrase.df, 3);
    assert.deepEqual(phrase.examples, ['The lamp guttered.', 'THE LAMP guttered.']);
    assert.deepEqual(phrase.docs, [0, 1, 2]);
    assert.equal(mineRepeats(['the lamp guttered']).phrases.length, 0);
    assert.equal(mineRepeats(narratorTexts(chat), { top: 1, openersTop: 0 }).phrases.length, 1);
    assert.deepEqual(mineRepeats([], {}).openers, []);
});
test('long example crops still contain the phrase', () => {
    const text = 'Quiet '.repeat(60) + 'the lamp guttered near the desk.';
    const result = mineRepeats([text, text, text], { top: 100 });
    const phrase = result.phrases.find(p => p.text.includes('lamp guttered'));
    assert.ok(phrase.examples.every(e => e.length <= 200 && e.includes('lamp guttered')));
});
test('stem normalizes case and yo before applying the original two suffix passes', () => {
    assert.equal(stem('ЁЛКАМИ'), stem('елками'));
    assert.equal(stem('дрогнули'), 'дрогн');
    assert.equal(stem('guttered'), 'gutter');
    assert.equal(stem('the'), 'the');
});
test('trimPhrase drops ends and coalesces consecutive middle cuts', () => {
    const words = ['уголки', 'губ', 'дрогнули', 'в', 'подобии', 'улыбки'];
    assert.deepEqual(trimPhrase(words, [3, 4, 5]), { text: 'уголки губ дрогнули', parts: [['уголки', 'губ', 'дрогнули']] });
    assert.deepEqual(trimPhrase(words, [0, 3, 4]), { text: 'губ дрогнули … улыбки', parts: [['губ', 'дрогнули'], ['улыбки']] });
    assert.deepEqual(trimPhrase(words, [0, 1, 2, 3, 4, 5]), { text: '', parts: [] });
    assert.equal(trimPhrase(words, [1, 1, -1, 90]).text, 'уголки … дрогнули в подобии улыбки');
});
test('regexFor emits exact Cyrillic, Latin and gap expressions and escapes metacharacters', () => {
    assert.equal(regexFor(['сердце', 'пропустило', 'удар']), '/(?<![а-яёa-z])с[её]рдц[а-яё]*\\s+пропуст[а-яё]*\\s+удар[а-яё]*/gi');
    assert.equal(regexFor(['the', 'lamp', 'guttered']), '/(?<![а-яёa-z])the[a-z]*\\s+lamp[a-z]*\\s+gutter[a-z]*/gi');
    assert.equal(regexFor(['уголки', 'губ', 'дрогнули'], [1]), '/(?<![а-яёa-z])уголк[а-яё]*[^.!?]{0,40}дрогн[а-яё]*/gi');
    assert.equal(regexFor(['aб', 'a.b']), '/(?<![а-яёa-z])aб\\S*\\s+a\\.b[a-z]*/gi');
    assert.equal(regexFor(['word'], [0]), '/(?!)/gi');
    const value = regexFor(['уголки', 'губ', 'дрогнули'], [1]);
    const re = new RegExp(value.slice(1, -3), 'gi');
    assert.ok(re.test('Уголками рта дрогнули'));
    assert.ok(!re.test('Уголки. Губы дрогнули'));
});
test('report caches count and boundary hashes, invalidates for options and boundary edits', () => {
    const copy = structuredClone(chat);
    const a = report(copy);
    assert.strictEqual(report(copy), a);
    copy[2].mes += ' Middle edit.';
    assert.strictEqual(report(copy), a);
    copy[0].mes += ' Boundary edit.';
    assert.notStrictEqual(report(copy), a);
    assert.equal(report(copy, { top: 1 }).phrases.length, 1);
    assert.equal(hashText('hello'), 'm3bicr');
});

test('countMatches counts replies the pattern string hits and respects the word boundary', () => {
    const re = regexFor(['сердце', 'пропустило', 'удар']);
    assert.equal(countMatches(re, ['Сердце пропустило удар.', 'сердца пропустили удары', { text: 'ничего' }, 'усердце пропустило удар']), 2);
    assert.equal(countMatches('/(/gi', ['x']), 0);
    assert.equal(countMatches(re, []), 0);
});
