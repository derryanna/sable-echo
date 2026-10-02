import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QUESTIONS, questionsFor, buildState, readAnswers, rollingMeans, patternCounts, colourFor, findExample, DEFAULT_THRESHOLDS,
    PATTERN_IDS, JEV_PATTERN_IDS, PATTERN_REGEX, localPatternCounts, patternRows } from '../src/sensors.js';
const payload = JSON.parse(readFileSync(new URL('../fixtures/jev-answers.json', import.meta.url)));

test('seven complete wire questions can be individually disabled', () => {
    assert.equal(Object.keys(QUESTIONS).length, 7);
    for (const q of Object.values(QUESTIONS)) {
        assert.deepEqual(Object.keys(q), ['type', 'instructions', 'criteria']);
        assert.ok(q.instructions.length > 50);
        if (q.type === 'score') assert.equal(q.criteria.length, 5);
        else assert.deepEqual(Object.keys(q.criteria), ['false', 'true']);
    }
    assert.equal(Object.keys(questionsFor({ repeats: false, negation: false })).length, 5);
    assert.deepEqual(questionsFor(Object.fromEntries(Object.keys(QUESTIONS).map(k => [k, false]))), {});
});
test('readAnswers reads the fixture and rejects missing or invalid values', () => {
    assert.deepEqual(readAnswers(payload.answers), { repeats: 2.5, speaks: 0.5, change: 2, aphorism: 0.8, antithesis: 0.7, filter: 0.2, negation: 0.6 });
    assert.ok(Object.values(readAnswers({ repeats: { score: '3' }, speaks: { score: NaN }, change: { score: 5 }, aphorism: { noul: -1 } })).every(v => v === null));
});
test('buildState cleans and caps only the target turn, previous user message and prior narrator history', () => {
    const chat = Array.from({ length: 8 }, (_, i) => ({ mes: `Narrator ${i}. More text.`, is_user: false }));
    chat.splice(7, 0, { mes: 'Player text. <state>hidden</state>', is_user: true });
    chat.splice(7, 0, { mes: 'System text.', is_system: true });
    chat.push({ mes: 'Latest <sable_state>secret</sable_state> reply.' });
    chat.push({ mes: 'Future player text.', is_user: true });
    const before = structuredClone(chat);
    const state = buildState(chat, 10);
    assert.equal(state.latest_turn, 'Latest  reply.');
    assert.equal(state.player_message, 'Player text.');
    assert.deepEqual(state.history, ['Narrator 3. More text.', 'Narrator 4. More text.', 'Narrator 5. More text.', 'Narrator 6. More text.', 'Narrator 7. More text.']);
    assert.deepEqual(buildState(chat, 10, { latestChars: 6, playerChars: 6, historyCount: 1, historyChars: 8 }), { latest_turn: 'Latest', player_message: 'Player', history: ['Narrator'] });
    assert.deepEqual(buildState(chat, 0).history, []);
    assert.equal(buildState(chat, 0).player_message, '');
    assert.deepEqual(buildState(chat, 10, { historyCount: 0 }).history, []);
    assert.deepEqual(chat, before);
});
test('rolling means and pattern counts use bounded windows and ignore invalid measurements', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ s: { repeats: i < 4 ? 4 : 2, speaks: i === 11 ? null : 1,
        change: 0, aphorism: i % 2 ? 0.5 : 0.49, antithesis: 1, filter: null, negation: '1' } }));
    assert.deepEqual(rollingMeans(entries), { repeats: 2, speaks: 1, change: 0 });
    assert.deepEqual(rollingMeans([]), { repeats: null, speaks: null, change: null });
    assert.deepEqual(patternCounts(entries), { aphorism: 5, antithesis: 10, filter: 0, negation: 0 });
    assert.equal(patternCounts(entries, 2, 0.6).aphorism, 0);
    assert.deepEqual(rollingMeans(entries, 0), rollingMeans([]));
});
test('colour thresholds handle exact boundaries, inverted change scale and overrides', () => {
    for (const [id, [low, high]] of Object.entries(DEFAULT_THRESHOLDS)) {
        assert.equal(colourFor(id, low - 0.01), id === 'change' ? 'red' : 'green');
        assert.equal(colourFor(id, low), 'amber');
        assert.equal(colourFor(id, high), id === 'change' ? 'green' : 'red');
    }
    assert.equal(colourFor('repeats', 1.6, { repeats: [1, 1.5] }), 'red');
    assert.equal(colourFor('missing', 2), null);
    for (const value of [null, undefined, NaN, '2', -1, 5]) assert.equal(colourFor('repeats', value), null);
});
test('findExample returns full matching sentences without tracker content', () => {
    assert.equal(findExample('aphorism', 'Он закрыл дверь. Всё проходит. <state>Hidden.</state>'), 'Всё проходит.');
    assert.equal(findExample('antithesis', 'Скрипнула дверь. Это не ветер, а шаги. Он замер.'), 'Это не ветер, а шаги.');
    assert.equal(findExample('filter', 'Он заметил свет. Лампа погасла.'), 'Он заметил свет.');
    assert.equal(findExample('negation', 'Лист упал. Он не пошевелился.'), 'Он не пошевелился.');
    assert.equal(findExample('filter', 'Стекло блестело.'), '');
    assert.equal(findExample('unknown', 'Something.'), '');
    assert.equal(findExample('aphorism', ''), '');
    assert.equal(findExample('simile', 'Дверь открылась. Тень легла, словно плащ.'), 'Тень легла, словно плащ.');
    assert.equal(findExample('indefinite', 'He waited. Something moved.'), 'Something moved.');
    assert.equal(findExample('moment', 'Он на мгновение замер. Потом ушёл.'), 'Он на мгновение замер.');
    assert.equal(findExample('negation', 'The bell rang. He did not move.'), 'He did not move.');
});
test('standard patterns keep the SPEC §16.1 order; Jev still gets only four patterns and three sensors', () => {
    assert.deepEqual(PATTERN_IDS, ['antithesis', 'filter', 'negation', 'aphorism', 'simile', 'indefinite', 'moment']);
    assert.deepEqual(Object.keys(PATTERN_REGEX), PATTERN_IDS);
    assert.equal(PATTERN_REGEX.aphorism, null, 'aphorism is judgement only');
    assert.deepEqual(Object.keys(questionsFor()).sort(), [...JEV_PATTERN_IDS, 'repeats', 'speaks', 'change'].sort());
    assert.ok(JEV_PATTERN_IDS.every(id => PATTERN_IDS.includes(id)));
});
test('PATTERN_REGEX matches Russian and English forms with Cyrillic-safe word edges', () => {
    const hits = {
        antithesis: ['Это не ветер, а шаги.', 'Не страх — а что-то древнее.', 'Not rain, but snow.', 'It was not fear, but awe.'],
        filter: ['Он заметил свет.', 'Она почувствовала холод.', 'Он увидел, что дверь открыта.', 'She noticed the lamp.', 'He realized it.', 'He saw that it was late.'],
        negation: ['Он не пошевелился.', 'Она не ответила.', 'He did not move.', 'He didn’t move.', 'She said nothing.', 'No answer came.'],
        simile: ['Словно облако.', 'Будто во сне.', 'Точно так же, как вчера.', 'As if asleep.', 'As though lost.', 'It moved like a ghost.'],
        indefinite: ['Что-то мелькнуло.', 'Где-то вдали.', 'какого-то шума', 'Кто-то пришёл.', 'Something moved.', 'somewhere far', 'Somehow.'],
        moment: ['На секунду замер.', 'на мгновение', 'на миг', 'на долю секунды', 'For a moment.', 'for an instant', 'for a second'],
    };
    const misses = {
        antithesis: ['Он не знал.', 'Нет, а потом.', 'Nothing, but rain.'],
        filter: ['Стекло блестело.', 'Понятно.', 'felting'],
        negation: ['Он не знал.', 'Она сказала.', 'He did not know.'],
        simile: ['Он ждал.', 'unlike any', 'alike'],
        indefinite: ['что видно', 'a thing', 'handsome'],
        moment: ['на секундомере', 'momentary', 'in a moment'],
    };
    for (const [id, list] of Object.entries(hits)) for (const text of list) assert.ok(PATTERN_REGEX[id].test(text), `${id}: ${text}`);
    for (const [id, list] of Object.entries(misses)) for (const text of list) assert.ok(!PATTERN_REGEX[id].test(text), `${id} must not match: ${text}`);
});
test('localPatternCounts counts matching replies in the last window, with the latest example', () => {
    const texts = ['Это не свет, а тень. Словно облако, что-то плыло на секунду ближе.', { text: 'Not rain, but snow. Something moved somewhere.' }, 'Тишина. Он заметил свет.'];
    const counts = localPatternCounts(texts);
    assert.deepEqual(Object.keys(counts), PATTERN_IDS);
    assert.deepEqual(counts.antithesis, { count: 2, window: 3, example: 'Not rain, but snow.' });
    assert.deepEqual(counts.indefinite, { count: 2, window: 3, example: 'Something moved somewhere.' }, 'replies, not occurrences');
    assert.deepEqual(counts.filter, { count: 1, window: 3, example: 'Он заметил свет.' });
    assert.deepEqual(counts.negation, { count: 0, window: 3, example: '' });
    assert.equal(counts.aphorism, null);
    assert.deepEqual(localPatternCounts(texts, 1).antithesis, { count: 0, window: 1, example: '' });
    const many = Array.from({ length: 12 }, (_, i) => (i < 2 ? 'Он на миг замер.' : 'Лампа горела.'));
    assert.deepEqual(localPatternCounts(many).moment, { count: 0, window: 10, example: '' }, 'default window is the last 10');
    assert.ok(Object.values(localPatternCounts([])).every(value => value === null));
    assert.ok(Object.values(localPatternCounts(null)).every(value => value === null));
});
test('patternRows uses Jev where it scored, the miner otherwise and no data for aphorism without Jev', () => {
    const texts = Array.from({ length: 12 }, (_, i) => (i % 3 ? 'Он не пошевелился. Тишина.' : 'Это не ветер, а шаги.'));
    const chat = { 5: 'Он вошёл. Всё проходит.', 7: 'Это не дождь, а снег. Он ждал.' };
    const entries = [{ mesId: 5, s: { aphorism: 0.8, antithesis: 0.1, filter: null, negation: 0.6 } },
        { mesId: 7, s: { aphorism: 0.2, antithesis: 0.9, filter: null, negation: null } }];
    const rows = patternRows({ entries, texts, sensors: { negation: false }, textAt: id => chat[id] });
    assert.deepEqual(rows.map(row => row.id), PATTERN_IDS);
    const byId = Object.fromEntries(rows.map(row => [row.id, row]));
    assert.deepEqual(byId.antithesis, { id: 'antithesis', source: 'jev', count: 1, window: 2, rate: 0.5, example: 'Это не дождь, а снег.' });
    assert.deepEqual(byId.aphorism, { id: 'aphorism', source: 'jev', count: 1, window: 2, rate: 0.5, example: 'Всё проходит.' });
    assert.deepEqual(byId.filter, { id: 'filter', source: 'miner', count: 0, window: 10, rate: 0, example: '' }, 'Jev on but never scored it');
    assert.deepEqual(byId.negation, { id: 'negation', source: 'miner', count: 7, window: 10, rate: 0.7, example: 'Он не пошевелился.' }, 'sensor switched off');
    assert.equal(byId.simile.source, 'miner');
    const local = Object.fromEntries(patternRows({ entries, texts }).map(row => [row.id, row]));
    assert.deepEqual(local.aphorism, { id: 'aphorism', source: null, count: null, window: 0, rate: null, example: '' });
    assert.deepEqual(local.antithesis, { id: 'antithesis', source: 'miner', count: 3, window: 10, rate: 0.3, example: 'Это не ветер, а шаги.' });
    assert.ok(patternRows().every(row => row.source === null && row.count === null && row.window === 0));
    const quiet = patternRows({ entries: [{ mesId: 1, s: { aphorism: 0.1 } }], sensors: {}, textAt: () => 'x' });
    assert.deepEqual(quiet.find(row => row.id === 'aphorism'), { id: 'aphorism', source: 'jev', count: 0, window: 1, rate: 0, example: '' });
});
