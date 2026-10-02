// Every id of PATTERN_IDS (src/sensors.js, SPEC §16.1) in both block languages.
export const PATTERN_TEXT = {
    en: { aphorism: 'closing aphorism as the last line', antithesis: '«not X, but Y» antithesis',
        filter: 'filter verbs (noticed, felt) instead of direct action', negation: 'narrating what a character did not do',
        simile: '«as if / like» similes as ornament', indefinite: 'vague «something / somewhere» placeholders',
        moment: '«for a moment» beats' },
    ru: { aphorism: 'закрывающий афоризм в конце ответа', antithesis: 'конструкция «не X, а Y»',
        filter: 'фильтр-глаголы (заметила, почувствовал) вместо прямого действия', negation: 'описание того, чего персонаж не сделал',
        simile: 'сравнения «словно / будто» для украшения', indefinite: 'размытые «что-то / где-то» вместо конкретики',
        moment: 'паузы «на мгновение / на миг»' },
};
export const DEFAULT_TEMPLATES = {
    en: '[Avoid] Phrases (verbatim, any inflection): {phrases}.\n{instead}\nNever open a reply with: {openers}.\nPatterns: {patterns}.',
    ru: '[Избегай] Фразы: {phrases}.\n{instead}\nНе начинай ответ с: {openers}.\nПриёмы: {patterns}.',
};
const quote = text => `«${text}»`;
const bare = text => text.replace(/[….]+\s*$/, '').trim();
const DIRECTION = { en: '(a direction, vary the wording)', ru: '(как направление, формулируй по-разному)' };
const direction = (text, lang) => `${text.replace(/[.!?…]+$/, '').trim()} ${DIRECTION[lang]}.`;
export function buildBlock(record, { language = 'en', template = null, patternText = PATTERN_TEXT, enabled = true } = {}) {
    if (!enabled || !record?.bans?.length) return '';
    const lang = language === 'ru' ? 'ru' : 'en';
    const label = b => b.kind === 'pattern' ? patternText[lang]?.[b.text] ?? b.text : quote(b.kind === 'opener' ? bare(b.text) : b.text);
    const values = Object.fromEntries([['phrases', 'phrase'], ['openers', 'opener'], ['patterns', 'pattern']]
        .map(([key, kind]) => [key, record.bans.filter(b => b.kind === kind && !b.alt).map(label).join(kind === 'pattern' ? '; ' : ', ')]));
    values.instead = record.bans.filter(b => b.alt).map(b => `${lang === 'ru' ? 'Вместо' : 'Instead of'} ${label(b)}: ${direction(b.alt.trim(), lang)}`).join('\n');
    return (template ?? DEFAULT_TEMPLATES[lang]).split('\n').filter(line => {
        const keys = [...line.matchAll(/\{(phrases|instead|openers|patterns)\}/g)].map(m => m[1]);
        return !keys.some(key => !values[key]);
    }).map(line => line.replace(/\{(phrases|instead|openers|patterns)\}/g, (_, key) => values[key])).join('\n').trim();
}
export const estimateTokens = text => Math.round(String(text ?? '').length / 3.5 / 10) * 10;
