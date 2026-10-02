import { normalizeRecord, emptyRecord } from './bans.js';
import { DEFAULT_THRESHOLDS, QUESTIONS } from './sensors.js';

export const DEFAULTS = {
    enabled: true, language: 'ru', miner: { replies: 60, minChars: 200, minDf: 3, top: 12 },
    jev: { host: 'rout', endpoint: '', model: '', apiKey: '', enabled: false,
        sensors: Object.fromEntries(Object.keys(QUESTIONS).map(id => [id, true])), thresholds: structuredClone(DEFAULT_THRESHOLDS) },
    inject: { enabled: true, depth: 1, language: 'en' }, prompts: { block: null }, altProfileId: null,
    regexDefault: 'prompt', regexScope: 'character', candidates: 'chips', handoff: 'self', hints: true, pinned: false, characters: {},
    visual: { scale: 1, opacity: 0.93, blur: 14, fontSize: 13, widthVw: 80, accent: '#f5f4ee', base: null,
        text: null, radius: 18, motion: true, spacing: 'cozy', chipSize: 36, bgImage: null, bgDim: 0.45, bgFit: 'cover',
        phoneFull: false },   // SPEC §19.3: true = full width under 700 px; false = a side panel like Sable Trackers
};
// The visual keys «Как в Sable Trackers» copies from extension_settings.sableTrackers.visual (SPEC §17.3).
export const SABLE_VISUAL_KEYS = Object.freeze(['opacity', 'blur', 'fontSize', 'widthVw', 'accent', 'base', 'text', 'radius',
    'motion', 'spacing', 'bgImage', 'bgDim', 'bgFit']);
// Background picture (SPEC §17.2): a base64 png/jpeg/webp data URL or an http(s) URL, at most BG_MAX_LENGTH characters.
export const BG_MAX_LENGTH = 800000;
export const BG_FITS = Object.freeze(['cover', 'contain', 'tile']);
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
// No quotes, parentheses, backslashes, angle brackets or whitespace: the URL goes into CSS url("…").
const HTTP_IMAGE = /^https?:\/\/[^\s"'()\\<>]+$/i;
let lastImage;
/** The picture URL when it is safe inside CSS url("…") and within the limit, else null. */
export function normalizeBgImage(value) {
    if (typeof value !== 'string') return null;
    // One-entry memo: every render and snapshot re-normalises the same (possibly ~800 KB) data URL.
    if (value === lastImage) return value;
    const url = value.trim();
    if (!url || url.length > BG_MAX_LENGTH || !(DATA_IMAGE.test(url) || HTTP_IMAGE.test(url))) return null;
    if (url === value) lastImage = value;
    return url;
}
// Chip height in px (SPEC §16.3); the v0.1 names migrate to their sizes.
const CHIP_NAMES = { compact: 28, normal: 36, large: 44 };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const choice = (value, options, fallback) => options.includes(value) ? value : fallback;
const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback;
const string = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const number = (value, min, max, fallback, integer = true) => {
    if (value === null || value === '' || typeof value === 'boolean' || !['number', 'string'].includes(typeof value)) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, integer ? Math.round(n) : n)) : fallback;
};
const color = (value, fallback) => typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) ? value : fallback;
export function normalizeSettings(value) {
    const v = object(value), d = DEFAULTS;
    const miner = object(v.miner), jev = object(v.jev), inject = object(v.inject), visual = object(v.visual);
    const thresholds = Object.fromEntries(Object.entries(DEFAULT_THRESHOLDS).map(([id, defaults]) => {
        const pair = object(jev.thresholds)[id];
        const low = number(pair?.[0], 0, 4, defaults[0], false);
        const high = number(pair?.[1], 0, 4, defaults[1], false);
        return [id, [Math.min(low, high), Math.max(low, high)]];
    }));
    return {
        enabled: bool(v.enabled, d.enabled), language: choice(v.language, ['ru', 'en'], d.language),
        miner: { replies: number(miner.replies, 1, 500, 60), minChars: number(miner.minChars, 0, 10000, 200),
            minDf: number(miner.minDf, 1, 500, 3), top: number(miner.top, 1, 100, 12) },
        jev: { host: choice(jev.host, ['rout', 'openrouter', 'nanogpt', 'custom'], 'rout'), endpoint: string(jev.endpoint).trim(),
            model: string(jev.model).trim(), apiKey: string(jev.apiKey).trim(), enabled: bool(jev.enabled, false),
            sensors: Object.fromEntries(Object.keys(QUESTIONS).map(id => [id, bool(object(jev.sensors)[id], true)])), thresholds },
        inject: { enabled: bool(inject.enabled, true), depth: number(inject.depth, 0, 100, 1), language: choice(inject.language, ['en', 'ru'], 'en') },
        prompts: { block: string(object(v.prompts).block, null) }, altProfileId: string(v.altProfileId, null),
        regexDefault: choice(v.regexDefault, ['prompt', 'display', 'both'], 'prompt'), regexScope: choice(v.regexScope, ['character', 'global'], 'character'),
        candidates: choice(v.candidates, ['chips', 'collapsed'], 'chips'), handoff: choice(v.handoff, ['self', 'sable'], 'self'),
        hints: bool(v.hints, true), pinned: bool(v.pinned, false),   // SPEC §20.1: the panel ignores taps outside
        characters: Object.fromEntries(Object.entries(object(v.characters)).map(([avatar, record]) => [avatar, normalizeRecord(record)])),
        visual: { scale: Math.round(number(visual.scale, 0.7, 1.2, 1, false) * 20) / 20, opacity: number(visual.opacity, 0, 1, 0.93, false), blur: number(visual.blur, 0, 40, 14),
            fontSize: number(visual.fontSize, 12, 24, 13), widthVw: number(visual.widthVw, 20, 100, 80),
            accent: color(visual.accent, d.visual.accent), base: color(visual.base, null), text: color(visual.text, null),
            radius: number(visual.radius, 0, 40, 18), motion: bool(visual.motion, true),
            spacing: choice(visual.spacing, ['compact', 'cozy', 'roomy'], 'cozy'), chipSize: number(Object.hasOwn(CHIP_NAMES, visual.chipSize) ? CHIP_NAMES[visual.chipSize] : visual.chipSize, 28, 48, 36),
            bgImage: normalizeBgImage(visual.bgImage), bgDim: number(visual.bgDim, 0, 0.9, 0.45, false), bgFit: choice(visual.bgFit, BG_FITS, 'cover'),
            phoneFull: bool(visual.phoneFull, false) },
    };
}
export function loadSettings(ctx) {
    const raw = ctx.extensionSettings.sableEcho;
    const normalized = normalizeSettings(raw);
    if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
        ctx.extensionSettings.sableEcho = normalized;
        ctx.saveSettingsDebounced();
    }
    return normalized;
}
function merge(base, patch) {
    return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(object(patch))])].map(key => {
        if (!Object.hasOwn(object(patch), key)) return [key, base[key]];
        const value = patch[key];
        if (key === 'characters') return [key, { ...object(base[key]), ...object(value) }];
        return [key, value && typeof value === 'object' && !Array.isArray(value) ? merge(object(base[key]), value) : value];
    }));
}
export function saveSettings(ctx, patch) {
    const next = normalizeSettings(merge(normalizeSettings(ctx.extensionSettings.sableEcho), patch));
    ctx.extensionSettings.sableEcho = next;
    ctx.saveSettingsDebounced();
    return next;
}
export const characterRecord = (settings, avatar) => Object.hasOwn(settings?.characters ?? {}, avatar)
    ? normalizeRecord(settings.characters[avatar]) : emptyRecord();
