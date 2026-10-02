// Ported from Jeved. Copyright (c) 2026 Jeved contributors. MIT; see vendor/jeved/LICENSE.
const RU_STOP = ('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему ' +
    'теперь когда даже ну ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ей может они тут где есть надо ней для мы тебя их ' +
    'чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой ним здесь этом один почти мой тем чтобы нее были куда ' +
    'зачем всех можно при об хоть над больше тот через эти нас про всего них какая много разве эту моя свою этой перед лучше чуть том такой им более всю между ' +
    'это эта свой своей своих свои её').split(' ');
const EN_STOP = ('the a an and or but of to in on at by for with from as is are was were be been being it its this that these those he she they them his her ' +
    'their him you your i me my we our us not no so if then than too very just into onto over under out up down off about after before again through ' +
    'there here where when while who whom which what why how all any both each few more most other some such only own same can will would could should ' +
    'do does did done have has had having s t').split(' ');
const STOP = new Set([...RU_STOP, ...EN_STOP]);

const RU_END = /(ами|ями|ого|его|ому|ему|ыми|ими|ешь|ишь|ете|ите|ала|яла|или|ыли|ило|ыло|ало|ела|ели|ело|ула|ули|уло|ая|яя|ое|ее|ые|ие|ый|ий|ой|ым|им|ом|ем|ах|ях|ов|ев|ей|ам|ям|ую|юю|ть|ла|ло|ли|ил|ыл|ал|ел|ул|ся|сь|а|я|о|е|ы|и|у|ю|ь|й)$/;
const EN_END = /(ing|edly|ed|es|s|ly)$/;

export function stem(word) {
    word = String(word ?? '').toLowerCase().replace(/ё/g, 'е');
    const end = /[а-я]/.test(word) ? RU_END : EN_END;
    for (let i = 0; i < 2; i++) {
        const short = word.replace(end, '');
        if (short.length < 3 || short === word) {
            break;
        }
        word = short;
    }
    return word;
}

export const sentences = text => (text.match(/[^.!?…\n]+(?:[.!?…]+["»”)]*)?/g) ?? []).map(s => s.trim()).filter(Boolean);
const words = sentence => (sentence.toLowerCase().replace(/ё/g, 'е').match(/[а-яa-z]+(?:-[а-яa-z]+)?/g) || []);

export function cleanReply(raw) {
    let text = String(raw ?? '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(style|script|details|plan|info|think|thinking|sable_state|state|tracker|mood|blocks|world_state|checklist)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/!\[[^\]]*\](?:\((?:[^()\n]|\([^()\n]*\))*\)|\[[^\]]*\])/g, '')
        .replace(/<[^>]+>/g, '').trim();
    const nl = text.indexOf('\n');
    const segments = text.slice(0, nl).split('|').map(s => s.trim());
    const second = text.slice(nl + 1).split('\n')[0].trim();
    const table = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(second);
    if (nl > 0 && segments.length >= 2 && segments.length <= 3 && segments.every(s => s.length && s.length <= 40) && !table) text = text.slice(nl + 1);
    text = text.replace(/\n-{3,}[ \t]*\r?\n([\s\S]*)$/, (match, footer) => {
        const lines = footer.split('\n').filter(line => line.trim());
        return lines.length && lines.every(line => /^\s*\p{Extended_Pictographic}/u.test(line)) ? '' : match;
    });
    return text.split('\n').filter(line => !/^\s*\p{Extended_Pictographic}/u.test(line))
        .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function narratorTexts(chat, { replies = 60, minChars = 200 } = {}) {
    return (Array.isArray(chat) ? chat : []).flatMap((message, index) => {
        if (!message || message.is_user || message.is_system) return [];
        const text = cleanReply(message.mes);
        return text.length >= minChars && !/^(?:\[|\()?\s*OOC\b/i.test(text) ? [{ index, text }] : [];
    }).slice(-Math.max(0, replies) || Infinity);
}

export function mineRepeats(texts, { minDf = 3, top = 12, openersTop = 6 } = {}) {
    const grams = new Map(), openers = new Map();
    texts.forEach((entry, position) => {
        const text = typeof entry === 'string' ? entry : entry.text;
        const doc = typeof entry === 'string' ? position : entry.index;
        sentences(text).forEach((sentence, si) => {
            const w = words(sentence), st = w.map(stem);
            if (si === 0 && w.length >= 2) {
                const key = st.slice(0, 2).join(' ');
                const opener = openers.get(key) || { docs: new Set() };
                opener.docs.add(doc);
                opener.text = sentence.split(/\s+/).slice(0, 6).join(' ');
                openers.set(key, opener);
            }
            // Six words includes the full stock phrase used by the drawer.
            for (let n = 2; n <= 6; n++) for (let i = 0; i + n <= w.length; i++) {
                const run = w.slice(i, i + n);
                const content = run.filter(x => !STOP.has(x) && x.length > 2).length;
                if (content < 2 || (STOP.has(w[i]) && n === 2) || STOP.has(w[i + n - 1])) continue;
                const key = st.slice(i, i + n).join(' ');
                const gram = grams.get(key) || { n, content, docs: new Set(), forms: new Map(), examples: new Map() };
                gram.docs.add(doc);
                const surface = run.join(' ');
                gram.forms.set(surface, (gram.forms.get(surface) || 0) + 1);
                if (!gram.examples.has(doc)) {
                    const tokens = [...sentence.matchAll(/[а-яёa-z]+(?:-[а-яёa-z]+)?/gi)];
                    const start = Math.max(0, (tokens[i]?.index ?? 0) - 50);
                    gram.examples.set(doc, sentence.length <= 200 ? sentence : sentence.slice(start, start + 200));
                }
                grams.set(key, gram);
            }
        });
    });
    const list = [...grams.entries()].filter(([, g]) => g.docs.size >= minDf)
        .map(([key, g]) => ({ ...g, key, df: g.docs.size }))
        .sort((a, b) => b.n - a.n || b.df - a.df);
    const kept = [];
    for (const g of list) {
        if (!kept.some(k => k.n > g.n && (` ${k.key} `).includes(` ${g.key} `) && k.df >= g.df * 0.7)) kept.push(g);
    }
    const phrases = kept.sort((a, b) => b.df * b.content - a.df * a.content).slice(0, top).map(g => {
        const text = [...g.forms].sort((a, b) => b[1] - a[1])[0][0];
        return { text, words: text.split(' '), stems: g.key.split(' '), df: g.df,
            docs: [...g.docs], examples: [...g.examples.values()].slice(0, 2) };
    });
    // Stock constructions are counted per reply by localPatternCounts (src/sensors.js, SPEC §16.1).
    return { phrases, openers: [...openers.values()].filter(o => o.docs.size >= minDf)
        .sort((a, b) => b.docs.size - a.docs.size).slice(0, openersTop)
        .map(o => ({ text: o.text, df: o.docs.size, docs: [...o.docs] })), mined: texts.length };
}

export function trimPhrase(words, cuts = []) {
    const removed = new Set(cuts), parts = [];
    let run = [];
    words.forEach((word, i) => {
        if (removed.has(i)) { if (run.length) parts.push(run); run = []; }
        else run.push(word);
    });
    if (run.length) parts.push(run);
    return { text: parts.map(p => p.join(' ')).join(' … '), parts };
}

export function regexFor(words, cuts = []) {
    const { parts } = trimPhrase(words, cuts);
    const pattern = parts.map(run => run.map(word => {
        const ru = /[а-яё]/i.test(word), en = /[a-z]/i.test(word);
        const tail = ru && !en ? '[а-яё]*' : en && !ru ? '[a-z]*' : '\\S*';
        return stem(word).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/е/g, '[её]') + tail;
    }).join('\\s+')).join('[^.!?]{0,40}');
    return `/${pattern ? '(?<![а-яёa-z])' + pattern : '(?!)'}/gi`;
}

/** How many of the given replies (strings or { text }) the /pattern/flags string matches. */
export function countMatches(regexString, texts) {
    const m = /^\/([\s\S]+)\/([a-z]*)$/.exec(String(regexString ?? ''));
    let re;
    try { re = m ? new RegExp(m[1], m[2].replace(/g/g, '')) : new RegExp(String(regexString ?? ''), 'i'); } catch { return 0; }
    return (Array.isArray(texts) ? texts : []).reduce((n, t) => n + (re.test(typeof t === 'string' ? t : String(t?.text ?? '')) ? 1 : 0), 0);
}

export function hashText(text) {
    let hash = 0x811c9dc5;
    for (const char of String(text ?? '').split('')) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

let cache = { key: '', options: '', value: null };
export function report(chat, settings = {}) {
    const texts = narratorTexts(chat, settings);
    const key = `${texts.length}:${hashText(texts.at(-1)?.text ?? '')}:${hashText(texts[0]?.text ?? '')}`;
    // Mining options and source indexes must not reuse an incompatible report.
    const options = JSON.stringify([settings.minDf ?? 3, settings.top ?? 12, settings.openersTop ?? 6, texts.map(t => t.index)]);
    if (cache.key !== key || cache.options !== options) cache = { key, options, value: mineRepeats(texts, settings) };
    return cache.value;
}

