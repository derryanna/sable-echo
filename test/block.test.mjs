import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBlock, estimateTokens, PATTERN_TEXT, DEFAULT_TEMPLATES } from '../src/block.js';
import { PATTERN_IDS } from '../src/sensors.js';
const record = { bans: [
    { kind: 'phrase', text: 'уголки губ дрогнули', alt: '' },
    { kind: 'phrase', text: 'сердце пропустило удар', alt: 'дыхание сбилось' },
    { kind: 'opener', text: 'Он медленно поднял взгляд…', alt: '' },
    { kind: 'pattern', text: 'aphorism', alt: '' },
] };
test('buildBlock produces the exact four-line English and Russian blocks', () => {
    assert.equal(buildBlock(record), '[Avoid] Phrases (verbatim, any inflection): «уголки губ дрогнули».\nInstead of «сердце пропустило удар»: дыхание сбилось (a direction, vary the wording).\nNever open a reply with: «Он медленно поднял взгляд».\nPatterns: closing aphorism as the last line.');
    assert.equal(buildBlock(record, { language: 'ru' }), '[Избегай] Фразы: «уголки губ дрогнули».\nВместо «сердце пропустило удар»: дыхание сбилось (как направление, формулируй по-разному).\nНе начинай ответ с: «Он медленно поднял взгляд».\nПриёмы: закрывающий афоризм в конце ответа.');
});
test('empty lines are omitted and alternatives appear only in Instead lines', () => {
    assert.equal(buildBlock({ bans: [] }), '');
    assert.equal(buildBlock(record, { enabled: false }), '');
    assert.equal(buildBlock({ bans: [record.bans[1]] }), 'Instead of «сердце пропустило удар»: дыхание сбилось (a direction, vary the wording).');
    assert.equal(buildBlock({ bans: [{ kind: 'opener', text: 'Тишина.', alt: 'Начни со звука!' }] }), 'Instead of «Тишина»: Начни со звука (a direction, vary the wording).');
    assert.equal(buildBlock({ bans: [{ kind: 'pattern', text: 'aphorism', alt: 'End with action.' }] }), 'Instead of closing aphorism as the last line: End with action (a direction, vary the wording).');
    assert.equal(buildBlock({ bans: [{ kind: 'phrase', text: 'old', alt: '«New!»' }] }), 'Instead of «old»: «New!» (a direction, vary the wording).');
});
test('templates substitute literally, drop empty placeholders and support custom pattern translations', () => {
    const custom = { bans: [{ kind: 'phrase', text: '$& <tag>', alt: '' }] };
    assert.equal(buildBlock(custom, { template: 'Words: {phrases}\nEmpty: {patterns}\n{instead}\nDone.' }), 'Words: «$& <tag>»\nDone.');
    assert.equal(buildBlock({ bans: [record.bans[3]] }, { patternText: { en: { aphorism: 'custom ending' } } }), 'Patterns: custom ending.');
    assert.ok(DEFAULT_TEMPLATES.en.includes('{openers}'));
});
test('every standard pattern has block wording in both languages', () => {
    for (const lang of ['en', 'ru']) assert.deepEqual(Object.keys(PATTERN_TEXT[lang]).sort(), [...PATTERN_IDS].sort(), lang);
    const bans = ['simile', 'indefinite', 'moment'].map(text => ({ kind: 'pattern', text, alt: '' }));
    assert.equal(buildBlock({ bans }), 'Patterns: «as if / like» similes as ornament; vague «something / somewhere» placeholders; «for a moment» beats.');
    assert.equal(buildBlock({ bans }, { language: 'ru' }), 'Приёмы: сравнения «словно / будто» для украшения; размытые «что-то / где-то» вместо конкретики; паузы «на мгновение / на миг».');
});
test('estimateTokens rounds the character estimate to tens', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('x'.repeat(350)), 100);
    assert.equal(estimateTokens('x'.repeat(18)), 10);
});
