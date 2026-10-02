import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeSettings, loadSettings, saveSettings, characterRecord, normalizeBgImage, BG_MAX_LENGTH, SABLE_VISUAL_KEYS } from '../src/settings.js';
import { emptyRecord, ban } from '../src/bans.js';
const makeRecord = text => ban(emptyRecord(), { text }, { newId: () => 'b_00000001', now: 0 });

test('default settings exactly match normalization and do not share mutable objects', () => {
    assert.equal(DEFAULTS.visual.fontSize, 13);
    assert.equal(normalizeSettings({ visual: { fontSize: null } }).visual.fontSize, 13);
    assert.deepEqual(normalizeSettings({}), DEFAULTS);
    const first = normalizeSettings(null), second = normalizeSettings(null);
    first.jev.thresholds.repeats[0] = 99;
    first.jev.sensors.repeats = false;
    assert.deepEqual(second, DEFAULTS);
});
test('normalizeSettings clamps, falls back, drops unknown keys and is idempotent for messy input', () => {
    const input = { enabled: 'yes', language: 'xx', unknown: true, miner: { replies: -5, minChars: '350.4', minDf: Infinity, top: 999 },
        jev: { host: 'bad', endpoint: ' /decisions ', model: 5, apiKey: ' secret ', sensors: { repeats: false, speaks: 7, bad: true },
            thresholds: { repeats: [3, 1], speaks: [null, 9], change: ['0.5', '1.5'] } },
        inject: { enabled: false, depth: -8, language: 'invalid' }, prompts: { block: 5 }, altProfileId: false, regexDefault: 'bad',
        characters: { 'a.png': { bans: [null], intentional: ['word', null] } },
        visual: { opacity: 99, blur: -2, fontSize: '18', widthVw: NaN, accent: '<script>', base: '#abc', text: null, radius: Infinity,
            motion: 'false', spacing: 'bad', chipSize: 'large', unknown: 5 } };
    const result = normalizeSettings(input);
    assert.deepEqual(normalizeSettings(result), result);
    assert.deepEqual(result.miner, { replies: 1, minChars: 350, minDf: 3, top: 100 });
    assert.equal(result.language, 'ru');
    assert.equal(result.jev.apiKey, 'secret');
    assert.equal(result.jev.sensors.repeats, false);
    assert.equal(result.jev.sensors.speaks, true);
    assert.deepEqual(result.jev.thresholds.repeats, [1, 3]);
    assert.equal(result.visual.opacity, 1);
    assert.equal(result.visual.accent, '#f5f4ee');
    assert.equal(result.visual.base, '#abc');
    assert.equal(result.visual.chipSize, 44, 'the v0.1 name migrates to pixels');
    assert.equal(result.regexScope, 'character');
    assert.equal(result.candidates, 'chips');
    assert.equal(result.visual.spacing, 'cozy');
    assert.equal(result.inject.depth, 0);
    assert.equal(result.prompts.block, null);
    assert.ok(!Object.hasOwn(result, 'unknown'));
    assert.ok(!Object.hasOwn(result.visual, 'unknown'));
    assert.deepEqual(result.characters['a.png'], { bans: [], intentional: ['word'], hidden: [] });
});
test('round 2 settings: numeric chip size with migration, regex scope and candidates mode', () => {
    assert.equal(DEFAULTS.visual.chipSize, 36);
    assert.equal(DEFAULTS.regexScope, 'character');
    assert.equal(DEFAULTS.candidates, 'chips');
    const chip = value => normalizeSettings({ visual: { chipSize: value } }).visual.chipSize;
    assert.deepEqual(['compact', 'normal', 'large'].map(chip), [28, 36, 44]);
    assert.deepEqual([28, 40.4, '42', 10, 90, null, 'huge', 'toString', true].map(chip), [28, 40, 42, 28, 48, 36, 36, 36, 36]);
    for (const value of ['compact', 'normal', 'large', 33, 'junk']) {
        const once = normalizeSettings({ visual: { chipSize: value } });
        assert.deepEqual(normalizeSettings(once), once, `idempotent for ${value}`);
    }
    const chosen = normalizeSettings({ regexScope: 'global', candidates: 'collapsed' });
    assert.deepEqual([chosen.regexScope, chosen.candidates], ['global', 'collapsed']);
    const bad = normalizeSettings({ regexScope: 'card', candidates: true });
    assert.deepEqual([bad.regexScope, bad.candidates], ['character', 'chips']);
});
test('loadSettings migrates a stored v0.1 chip size once and saves it', () => {
    let saves = 0;
    const ctx = { extensionSettings: { sableEcho: { visual: { chipSize: 'compact' } } }, saveSettingsDebounced: () => saves++ };
    assert.equal(loadSettings(ctx).visual.chipSize, 28);
    assert.equal(ctx.extensionSettings.sableEcho.visual.chipSize, 28);
    loadSettings(ctx);
    assert.equal(saves, 1);
});
test('loadSettings persists only changed normalization and preserves other extension settings', () => {
    let saves = 0;
    const ctx = { extensionSettings: { other: { keep: true } }, saveSettingsDebounced: () => saves++ };
    assert.deepEqual(loadSettings(ctx), DEFAULTS);
    assert.equal(saves, 1);
    loadSettings(ctx);
    assert.equal(saves, 1);
    ctx.extensionSettings.sableEcho.extra = 'drop';
    loadSettings(ctx);
    assert.equal(saves, 2);
    assert.deepEqual(ctx.extensionSettings.other, { keep: true });
});
test('partial saveSettings deep merges settings but replaces one complete character record', () => {
    let saves = 0;
    const ctx = { extensionSettings: { sableEcho: normalizeSettings({ jev: { host: 'custom', endpoint: '/decisions', model: 'local-model', sensors: { speaks: false } },
        characters: { 'a.png': makeRecord('old phrase'), 'b.png': makeRecord('other phrase') } }), other: 7 }, saveSettingsDebounced: () => saves++ };
    const prior = structuredClone(ctx.extensionSettings.sableEcho);
    const patch = { jev: { apiKey: 'new-key' } };
    const next = saveSettings(ctx, patch);
    assert.deepEqual(next.jev, { ...prior.jev, apiKey: 'new-key' });
    assert.deepEqual(patch, { jev: { apiKey: 'new-key' } });
    saveSettings(ctx, { jev: { sensors: { repeats: false } }, characters: { 'a.png': emptyRecord() } });
    assert.deepEqual(ctx.extensionSettings.sableEcho.characters['a.png'], emptyRecord());
    assert.deepEqual(ctx.extensionSettings.sableEcho.characters['b.png'], prior.characters['b.png']);
    assert.equal(ctx.extensionSettings.sableEcho.jev.sensors.speaks, false);
    assert.equal(ctx.extensionSettings.sableEcho.jev.sensors.repeats, false);
    assert.equal(saves, 2);
    assert.equal(ctx.extensionSettings.other, 7);
    assert.equal(prior.jev.apiKey, '');
});
test('characterRecord returns normalized fresh records and handles prototype-like keys safely', () => {
    const settings = normalizeSettings({ characters: { 'a.png': makeRecord('lamp guttered') } });
    const record = characterRecord(settings, 'a.png');
    record.bans.length = 0;
    assert.equal(settings.characters['a.png'].bans.length, 1);
    assert.deepEqual(characterRecord(settings, 'missing'), emptyRecord());
    assert.deepEqual(characterRecord(settings, 'toString'), emptyRecord());
    const dangerous = JSON.parse('{"characters":{"__proto__":{"intentional":["safe"]}}}');
    assert.deepEqual(characterRecord(normalizeSettings(dangerous), '__proto__').intentional, ['safe']);
    assert.equal({}.intentional, undefined);
});
test('round 3: background picture keys validate the URL, clamp the dim and keep the fit choice', () => {
    assert.deepEqual([DEFAULTS.visual.bgImage, DEFAULTS.visual.bgDim, DEFAULTS.visual.bgFit], [null, 0.45, 'cover']);
    assert.equal(BG_MAX_LENGTH, 800000);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const image = value => normalizeSettings({ visual: { bgImage: value } }).visual.bgImage;
    assert.equal(image(png), png);
    assert.equal(image(`  ${png}  `), png);
    assert.equal(image('data:image/jpeg;base64,/9j/4AAQ'), 'data:image/jpeg;base64,/9j/4AAQ');
    assert.equal(image('data:image/webp;base64,UklGRg=='), 'data:image/webp;base64,UklGRg==');
    assert.equal(image('https://example.org/paper.jpg?size=2'), 'https://example.org/paper.jpg?size=2');
    assert.equal(image('HTTP://example.org/a.png'), 'HTTP://example.org/a.png');
    for (const bad of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png,raw', 'data:text/html;base64,PGI+', 'javascript:alert(1)',
        'ftp://example.org/a.png', 'https://example.org/a b.png', 'https://example.org/a".png', "https://example.org/a'.png",
        'https://example.org/a).png', 'https://example.org/a\\b.png', 'https://example.org/<b>.png', '', 42, {}, null]) {
        assert.equal(image(bad), null, String(bad));
    }
    const limit = 'data:image/jpeg;base64,'.length;
    assert.equal(image(`data:image/jpeg;base64,${'A'.repeat(BG_MAX_LENGTH - limit)}`)?.length, BG_MAX_LENGTH);
    assert.equal(image(`data:image/jpeg;base64,${'A'.repeat(BG_MAX_LENGTH - limit + 1)}`), null, 'over 800 000 characters');
    assert.equal(normalizeBgImage(png), png);
    const dim = value => normalizeSettings({ visual: { bgDim: value } }).visual.bgDim;
    assert.deepEqual([0, 0.3, '0.5', 1, -1, null, 'x', true].map(dim), [0, 0.3, 0.5, 0.9, 0, 0.45, 0.45, 0.45]);
    const fit = value => normalizeSettings({ visual: { bgFit: value } }).visual.bgFit;
    assert.deepEqual(['cover', 'contain', 'tile', 'stretch', null].map(fit), ['cover', 'contain', 'tile', 'cover', 'cover']);
    const once = normalizeSettings({ visual: { bgImage: ` ${png}`, bgDim: '0.7', bgFit: 'tile' } });
    assert.deepEqual(normalizeSettings(once), once);
    assert.deepEqual(SABLE_VISUAL_KEYS, ['opacity', 'blur', 'fontSize', 'widthVw', 'accent', 'base', 'text', 'radius', 'motion', 'spacing', 'bgImage', 'bgDim', 'bgFit']);
    for (const key of SABLE_VISUAL_KEYS) assert.ok(Object.hasOwn(DEFAULTS.visual, key), key);
});
test('round 5: visual.phoneFull is a boolean, false by default, saved through saveSettings', () => {
    assert.equal(DEFAULTS.visual.phoneFull, false);
    const full = value => normalizeSettings({ visual: { phoneFull: value } }).visual.phoneFull;
    assert.equal(full(true), true);
    assert.equal(full(false), false);
    for (const value of ['true', 1, null, undefined, 'yes', {}]) assert.equal(full(value), false, String(value));
    assert.ok(!SABLE_VISUAL_KEYS.includes('phoneFull'), 'Sable Trackers has no such key to copy');
    const ctx = { extensionSettings: { sableEcho: {} }, saveSettingsDebounced() {} };
    assert.equal(saveSettings(ctx, { visual: { phoneFull: true } }).visual.phoneFull, true);
    assert.equal(ctx.extensionSettings.sableEcho.visual.phoneFull, true);
    assert.equal(saveSettings(ctx, { visual: { blur: 3 } }).visual.phoneFull, true, 'a patch of another key keeps it');
});
test('round 6: pinned is a boolean, false by default, normalized once', () => {
    assert.equal(DEFAULTS.pinned, false);
    const pinned = value => normalizeSettings({ pinned: value }).pinned;
    assert.equal(pinned(true), true);
    assert.equal(pinned(false), false);
    for (const value of ['yes', 'true', 1, null, undefined, {}]) assert.equal(pinned(value), false, String(value));
    const once = normalizeSettings({ pinned: true });
    assert.deepEqual(normalizeSettings(once), once);
    const ctx = { extensionSettings: { sableEcho: {} }, saveSettingsDebounced() {} };
    assert.equal(saveSettings(ctx, { pinned: true }).pinned, true);
    assert.equal(saveSettings(ctx, { hints: false }).pinned, true, 'a patch of another key keeps it');
});
