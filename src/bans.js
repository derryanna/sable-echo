import { stem, trimPhrase } from './miner.js';
import { PATTERN_IDS } from './sensors.js';

const list = value => Array.isArray(value) ? value : [];
const textOf = value => typeof value === 'string' ? value.trim() : '';
const modes = ['prompt', 'display', 'both'];
const scopes = ['character', 'global'];
export const emptyRecord = () => ({ bans: [], intentional: [], hidden: [] });
export const newId = (random = Math.random) => 'b_' + Math.floor(random() * 0x100000000).toString(16).padStart(8, '0');

export function normalizeRecord(value) {
    const seen = new Set();
    const bans = list(value?.bans).flatMap(b => {
        if (!b || !/^b_[\da-f]{8}$/.test(b.id) || seen.has(b.id) || !['phrase', 'opener', 'pattern'].includes(b.kind)) return [];
        const words = list(b.words).filter(w => typeof w === 'string' && w.trim()).map(w => w.trim());
        const cuts = [...new Set(list(b.cuts).filter(i => Number.isInteger(i) && i >= 0 && i < words.length))].sort((a, b) => a - b);
        const text = b.kind === 'pattern' ? textOf(b.text) : trimPhrase(words, cuts).text;
        if (!text || (b.kind === 'pattern' && !PATTERN_IDS.includes(text))) return [];
        seen.add(b.id);
        return [{ id: b.id, kind: b.kind, text, ...(b.kind === 'pattern' ? {} : { words, cuts }),
            alt: textOf(b.alt), regex: b.kind !== 'pattern' && b.regex === true,
            regexMode: modes.includes(b.regexMode) ? b.regexMode : 'prompt',
            regexScope: scopes.includes(b.regexScope) ? b.regexScope : 'character',
            added: Number.isFinite(b.added) && b.added >= 0 ? b.added : 0,
            sinceIndex: Number.isInteger(b.sinceIndex) && b.sinceIndex >= -1 ? b.sinceIndex : 0,
            sinceChat: typeof b.sinceChat === 'string' ? b.sinceChat : null }];
    }).slice(0, 40);
    const intentional = [...new Set(list(value?.intentional).map(textOf).filter(Boolean))].slice(0, 100);
    const hidden = [...new Map(list(value?.hidden).filter(h => h && textOf(h.text) && Number.isFinite(h.until) && h.until >= 0)
        .map(h => [textOf(h.text), { text: textOf(h.text), until: Math.floor(h.until), chat: typeof h.chat === 'string' ? h.chat : null }])).values()].slice(0, 100);
    return { bans, intentional, hidden };
}

export function ban(record, candidate, { cuts = [], newId: makeId = newId, now = Date.now, sinceIndex = 0, sinceChat = null, regexScope = 'character' } = {}) {
    const next = normalizeRecord(record);
    const kind = candidate.kind ?? 'phrase';
    const words = candidate.words ?? textOf(candidate.text).split(/\s+/);
    const text = kind === 'pattern' ? candidate.text : trimPhrase(words, cuts).text;
    if (!text || next.bans.some(b => b.kind === kind && b.text === text)) return next;
    next.bans.push({ id: makeId(), kind, text, words: [...words], cuts: [...cuts], alt: '', regex: false,
        regexMode: 'prompt', regexScope, added: typeof now === 'function' ? now() : now, sinceIndex, sinceChat });
    return normalizeRecord(next);
}
const updateBan = (record, id, patch) => {
    const next = normalizeRecord(record);
    next.bans = next.bans.map(b => b.id === id ? { ...b, ...patch } : b);
    return normalizeRecord(next);
};
export function unban(record, id) {
    const next = normalizeRecord(record);
    return { ...next, bans: next.bans.filter(b => b.id !== id) };
}
export const setAlt = (record, id, alt) => updateBan(record, id, { alt });
/** `scope` ('character' | 'global') moves the script; omitted, the ban keeps its scope (SPEC §16.2). */
export const setRegex = (record, id, enabled, mode = 'prompt', scope) =>
    updateBan(record, id, { regex: enabled, regexMode: mode, ...(scope === undefined ? {} : { regexScope: scope }) });
export function markIntentional(record, text) {
    const next = normalizeRecord(record);
    return normalizeRecord({ ...next, intentional: [...next.intentional, text] });
}
export function unmarkIntentional(record, text) {
    const next = normalizeRecord(record);
    return { ...next, intentional: next.intentional.filter(t => t !== text) };
}
export function hide(record, text, until, chat = null) {
    const next = normalizeRecord(record);
    return normalizeRecord({ ...next, hidden: [...next.hidden.filter(h => h.text !== text), { text, until, chat }] });
}
export function unhide(record, text) {
    const next = normalizeRecord(record);
    return { ...next, hidden: next.hidden.filter(h => h.text !== text) };
}
export function pruneHidden(record, { chatId, replies } = {}) {
    const next = normalizeRecord(record);
    return { ...next, hidden: next.hidden.filter(h => h.chat !== chatId || h.until > replies) };
}
const tokens = text => (String(text).match(/[а-яёa-z]+(?:-[а-яёa-z]+)?/gi) ?? []).map(stem);
function containsRuns(haystack, runs) {
    if (!runs.length || runs.some(run => !run.length)) return false;
    let cursor = 0;
    for (const run of runs) {
        let found = false;
        for (let i = cursor; i <= haystack.length - run.length; i++) {
            if (run.every((s, j) => haystack[i + j] === s)) { cursor = i + run.length; found = true; break; }
        }
        if (!found) return false;
    }
    return true;
}
export function banMatches(stems, ban) {
    return ban.kind !== 'pattern' && containsRuns(stems, trimPhrase(ban.words, ban.cuts).parts.map(run => tokens(run.join(' '))));
}
// A candidate that shares two consecutive content stems (3+ chars each) with a ban is a fragment of the same tic.
function overlaps(stems, banStems) {
    for (let i = 0; i + 1 < stems.length; i++) {
        if (stems[i].length < 3 || stems[i + 1].length < 3) continue;
        for (let j = 0; j + 1 < banStems.length; j++) if (stems[i] === banStems[j] && stems[i + 1] === banStems[j + 1]) return true;
    }
    return false;
}
export function mergeCandidates(report, record, progress) {
    const view = pruneHidden(record, progress);
    const excluded = [...view.intentional, ...view.hidden.map(h => h.text)]
        .map(text => text.split('…').map(tokens));
    const visible = (candidate, kind) => {
        const stems = candidate.stems ?? tokens(candidate.text);
        const bans = view.bans.filter(b => b.kind === kind)
            .map(b => trimPhrase(b.words, b.cuts).parts.map(run => tokens(run.join(' '))));
        const banStems = view.bans.filter(b => b.kind === kind && b.kind !== 'pattern').map(b => tokens(trimPhrase(b.words, b.cuts).parts.map(run => run.join(' ')).join(' ')));
        return ![...excluded, ...bans].some(runs => containsRuns(stems, runs)) && !banStems.some(ban => overlaps(stems, ban));
    };
    return { candidates: report.phrases.filter(c => visible(c, 'phrase')),
        openers: report.openers.filter(c => visible(c, 'opener')), intentional: view.intentional, hidden: view.hidden };
}
