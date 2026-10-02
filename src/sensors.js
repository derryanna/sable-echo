import { cleanReply, sentences } from './miner.js';
import { wire, read } from './jev.js';

// Score wording adapted from the Jeved Director scale (MIT; vendor/jeved/LICENSE).
const SPECS = {
    repeats: { type: 'score', question: 'How much does latest_turn reuse phrases, gestures, images or sentence patterns from history? Compare wording and structure, not necessary names or continuing scene facts. Judge only the latest narrator reply.', levels: [
        'No noticeable reuse of phrasing or sentence patterns from earlier replies.',
        'A small echo of an earlier phrase, but the reply is otherwise fresh.',
        'Several familiar phrases or a recurring sentence pattern are noticeable.',
        'Repeated wording and structures dominate much of the reply.',
        'The reply uses essentially the same structure and wording as an earlier reply.',
    ] },
    speaks: { type: 'score', question: 'How much does latest_turn write actions, speech, thoughts, feelings or decisions that belong only to the player character? Use player_message to distinguish what the player already supplied from new choices made for them. Do not penalize external events or actions by other characters.', levels: [
        'Nothing is decided, said, thought or done for the player character.',
        'A minor involuntary reaction is attributed to the player, without choosing their response.',
        'Some new actions or feelings are supplied for the player character.',
        'Substantial speech, actions or thoughts are written on behalf of the player.',
        'The narrator decides the player character\'s response or important choices for them.',
    ] },
    change: { type: 'score', question: 'How much does the situation change in latest_turn? Compare with history and player_message. Count concrete actions, discoveries, consequences and new opportunities; do not count more description of an unchanged moment as progress.', levels: [
        'Nothing changes; the reply restates or describes the same situation.',
        'A small reaction or detail appears, with little effect on the situation.',
        'A concrete action or new piece of information moves the scene forward.',
        'A significant development changes the options, stakes or relationships.',
        'A major turning point transforms the situation and its direction.',
    ] },
    aphorism: { type: 'noul', question: 'The last sentence of latest_turn is a general, quotable statement about life or experience, rather than a concrete action, perception or line of dialogue.', levels: ['The ending stays within the concrete scene.', 'The ending is a general aphorism.'] },
    antithesis: { type: 'noul', question: 'latest_turn uses a not X, but Y construction (including Russian не X, а Y) as rhetorical ornament, rather than a necessary factual correction.', levels: ['No ornamental antithesis.', 'An ornamental not X, but Y contrast occurs.'] },
    filter: { type: 'noul', question: 'latest_turn presents perception through filter verbs such as noticed, felt, realised or saw that, instead of directly showing the perceived thing. Exclude literal physical touch and quoted dialogue.', levels: ['Perceptions are shown directly.', 'Perception is narrated through filter verbs.'] },
    negation: { type: 'noul', question: 'latest_turn presents an absent action as an event: a character did not move, said nothing, or no answer came. Exclude ordinary negative facts unrelated to an expected action.', levels: ['No absent action is narrated as an event.', 'An action that did not happen is narrated as an event.'] },
};
export const QUESTIONS = Object.fromEntries(Object.entries(SPECS).map(([id, spec]) => [id, wire(spec)]));
export const questionsFor = (sensors = {}) => Object.fromEntries(Object.entries(QUESTIONS).filter(([id]) => sensors[id] !== false));
export const readAnswers = answers => Object.fromEntries(Object.entries(SPECS).map(([id, spec]) => [id, read(answers?.[id], spec)?.value ?? null]));

export function buildState(chat, mesId, { latestChars = 6000, playerChars = 2000, historyCount = 5, historyChars = 1500 } = {}) {
    const prior = chat.slice(0, mesId);
    return { latest_turn: cleanReply(chat[mesId]?.mes).slice(0, latestChars),
        player_message: cleanReply(prior.findLast(m => m?.is_user && !m.is_system)?.mes).slice(0, playerChars),
        history: prior.filter(m => m && !m.is_user && !m.is_system).map(m => cleanReply(m.mes))
            .filter(t => t && !/^(?:\[|\()?\s*OOC\b/i.test(t)).slice(-historyCount || Infinity).map(t => t.slice(0, historyChars)) };
}
export const DEFAULT_THRESHOLDS = { repeats: [2, 2.8], speaks: [2, 2.85], change: [1, 1.6] };
const SCORE_IDS = ['repeats', 'speaks', 'change'];
/** The standard patterns of SPEC §16.1 in card order; the first four are also Jev questions. */
export const PATTERN_IDS = Object.freeze(['antithesis', 'filter', 'negation', 'aphorism', 'simile', 'indefinite', 'moment']);
export const JEV_PATTERN_IDS = Object.freeze(['antithesis', 'filter', 'negation', 'aphorism']);
// Local counters, Russian and English in one expression per pattern. JavaScript \b is ASCII-only, so the word
// edges are explicit lookarounds over Cyrillic and Latin letters. `aphorism` is a judgement: no local regex.
export const PATTERN_REGEX = Object.freeze({
    antithesis: /(?<![а-яёa-z])(?:не\s+[^.,!?\n—]{1,40}(?:,|\s—)\s*а|not\s+[^.,!?\n]{1,40},\s*but)(?![а-яёa-z])/i,
    filter: /(?<![а-яёa-z])(?:(?:заметил|почувствовал|осознал|понял)[аио]?|увидел[аи]?,?\s+что|noticed|felt|reali[sz]ed|saw\s+that)(?![а-яёa-z])/i,
    negation: /(?<![а-яёa-z])(?:не\s+(?:пошевелил|ответил|сказал|двинул)[а-яё]*|did(?:\s+not|n['’]t)\s+move|said\s+nothing|no\s+answer\s+came)(?![а-яёa-z])/i,
    aphorism: null,
    simile: /(?<![а-яёa-z])(?:словно|будто|точно\s+так\s+же,?\s+как|as\s+if|as\s+though|like\s+an?)(?![а-яёa-z])/i,
    indefinite: /(?<![а-яёa-z])(?:(?:что|чего|чему|чем|кто|кого|кому|кем|где|куда|откуда|когда|почему|зачем|как[а-яё]{0,3}|ч[её]й|чь[а-яё]{1,3})-то|some(?:thing|where|how))(?![а-яёa-z])/i,
    moment: /(?<![а-яёa-z])(?:на\s+(?:долю\s+)?(?:секунд[уы]|мгновени[ея]|миг)|for\s+(?:a|one)\s+(?:brief\s+)?(?:moment|second)|for\s+an\s+instant)(?![а-яёa-z])/i,
});
const valid = (v, max) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
const textOf = entry => typeof entry === 'string' ? entry : String(entry?.text ?? '');
export function rollingMeans(entries, window = 8) {
    return Object.fromEntries(SCORE_IDS.map(id => {
        const values = entries.slice(-window || Infinity).map(e => e.s?.[id]).filter(v => valid(v, 4));
        return [id, values.length ? values.reduce((a, b) => a + b, 0) / values.length : null];
    }));
}
export function patternCounts(entries, window = 10, threshold = 0.5) {
    return Object.fromEntries(JEV_PATTERN_IDS.map(id => [id, entries.slice(-window || Infinity)
        .filter(e => valid(e.s?.[id], 1) && e.s[id] >= threshold).length]));
}
/** Miner counts of SPEC §16.1: how many of the last `window` cleaned replies (strings or { text }) match each
 *  pattern regex, with the example from the latest match. null for `aphorism` and when there are no replies. */
export function localPatternCounts(texts, window = 10) {
    const recent = (Array.isArray(texts) ? texts : []).slice(-window || Infinity).map(textOf);
    return Object.fromEntries(PATTERN_IDS.map(id => {
        const regex = PATTERN_REGEX[id];
        if (!regex || !recent.length) return [id, null];
        const hits = recent.filter(text => regex.test(text));
        return [id, { count: hits.length, window: recent.length, example: hits.length ? findExample(id, hits.at(-1)) : '' }];
    }));
}
const row = (id, source, count, window, example) => ({ id, source, count, window,
    rate: count === null || !window ? null : count / window, example });
/** The §16.1 card rows in PATTERN_IDS order: Jev counts where Jev is on (`sensors` given) and scored the pattern
 *  in the last `window` entries, otherwise the local regex count, otherwise no data. `textAt(mesId)` returns
 *  the raw message of a scored entry, for the Jev example. */
export function patternRows({ entries = [], texts = [], sensors = null, textAt = () => '', window = 10, threshold = 0.5 } = {}) {
    const recent = entries.slice(-window || Infinity), local = localPatternCounts(texts, window);
    return PATTERN_IDS.map(id => {
        const scored = sensors && sensors[id] !== false && JEV_PATTERN_IDS.includes(id) ? recent.filter(e => valid(e.s?.[id], 1)) : [];
        if (scored.length) {
            const flagged = scored.filter(e => e.s[id] >= threshold), last = flagged.at(-1);
            return row(id, 'jev', flagged.length, scored.length, last ? findExample(id, textAt(last.mesId)) : '');
        }
        return local[id] ? row(id, 'miner', local[id].count, local[id].window, local[id].example) : row(id, null, null, 0, '');
    });
}
export function colourFor(sensor, value, thresholds = DEFAULT_THRESHOLDS) {
    if (!valid(value, 4) || !Object.hasOwn(DEFAULT_THRESHOLDS, sensor)) return null;
    const [low, high] = thresholds[sensor] ?? DEFAULT_THRESHOLDS[sensor];
    const bands = sensor === 'change' ? ['red', 'amber', 'green'] : ['green', 'amber', 'red'];
    return bands[value < low ? 0 : value < high ? 1 : 2];
}
/** The sentence that shows a pattern: the last sentence for `aphorism`, else the first one its regex matches. */
export function findExample(kind, text) {
    const list = sentences(cleanReply(text));
    if (kind === 'aphorism') return list.at(-1) ?? '';
    return list.find(sentence => PATTERN_REGEX[kind]?.test(sentence)) ?? '';
}
