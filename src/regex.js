import { regexFor as makeRegex } from './miner.js';

export function scriptFor(ban, { regexFor = makeRegex } = {}) {
    if (ban.kind === 'pattern') return null;
    return { id: 'sable-echo:' + ban.id, scriptName: 'Echo: ' + ban.text,
        findRegex: regexFor(ban.words, ban.cuts), replaceString: ban.alt || '',
        trimStrings: [], placement: [2], disabled: false,
        markdownOnly: ban.regexMode === 'display' || ban.regexMode === 'both', promptOnly: ban.regexMode === 'prompt' || ban.regexMode === 'both',
        runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null };
}
const ours = script => typeof script?.id === 'string' && script.id.startsWith('sable-echo:');
export const mergeScripts = (existing, scripts) => [...(existing ?? []).filter(s => !ours(s)), ...scripts];
export const ourIds = existing => (existing ?? []).filter(ours).map(s => s.id);
/** Our entries of a script list (card or global), in their order. */
export const ownScripts = existing => (Array.isArray(existing) ? existing : []).filter(ours);
