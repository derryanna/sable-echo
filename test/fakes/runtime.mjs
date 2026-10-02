// Fake of the SPEC §15 runtime for the drawer tests and dev/preview.html. It holds a synthetic snapshot
// (fixtures/snapshot.json), records every method call as a spy, and re-emits to subscribers after each
// call. Mutations follow the spec loosely so the preview stays clickable; the real mining, regex and block
// logic belong to the pure core and the glue.
//
// Fields the drawer needs beyond SPEC §15 (listed for the glue):
// - snapshot.altProfile: bool — a chat-completion profile for alternatives is set (shows «Предложить»).
// - bans[].findRegex: string — regexFor(words, cuts) in '/…/gi' form, shown in the regex sub-row.
// - bans[].sinceReplies: number — narrator replies after sinceIndex («снова: 3 за 12 ответов»).
// - ban / banOpener / banPattern / banText resolve to the new ban id (the undo toast calls unban(id)).
import { DEFAULTS, SABLE_VISUAL_KEYS, normalizeSettings } from '../../src/settings.js';
import { t } from '../../src/i18n.js';

export const METHODS = Object.freeze(['rescan', 'ban', 'banOpener', 'banPattern', 'banText', 'unban', 'setAlt',
  'suggestAlt', 'markIntentional', 'unmarkIntentional', 'hide', 'unhide', 'setRegex', 'setInject',
  'setBlockLanguage', 'updateSettings', 'importSableVisual', 'testJev', 'preview', 'clearLog', 'resetCharacter', 'dispose']);

export const SUGGESTIONS = Object.freeze(['дыхание сбилось', 'пальцы сжались сами собой', 'он ничего не сказал']);

/** The three first-run states of SPEC §13.1 item 9, derived from the full fixture. */
export function snapshotFor(base, state = 'full') {
  const snap = structuredClone(base);
  if (state === 'nojev' || state === 'empty') {
    snap.jev = { enabled: false, configured: false, busy: false, error: null, lastMesId: null };
    snap.sensors = null;
    // SPEC §16.1 without Jev: local regex counts, and no data for the judgement-only aphorism.
    snap.patterns = snap.patterns.map(item => (item.id === 'aphorism'
      ? { id: item.id, source: null, count: null, window: 0, rate: null, example: '' } : { ...item, source: 'miner' }));
    snap.bans = snap.bans.filter(ban => ban.kind !== 'pattern');
    snap.altProfile = false;
    snap.log = [];
  }
  if (state === 'empty') {
    Object.assign(snap, { mined: 2, replies: 2, candidates: [], openers: [], bans: [], intentional: [], hidden: [] });
  }
  return snap;
}

/** Display trim, same rule as SPEC §4: cut ends drop, a cut run inside becomes «…». */
export function trimText(words, cuts = []) {
  const cut = new Set(cuts), parts = [];
  let run = [];
  words.forEach((word, index) => {
    if (cut.has(index)) { if (run.length) parts.push(run.join(' ')); run = []; return; }
    run.push(word);
  });
  if (run.length) parts.push(run.join(' '));
  return parts.join(' … ');
}

/** Rough stand-in for regexFor (SPEC §4): words lose two letters, gaps become [^.!?]{0,40}. */
export function fakeRegex(words, cuts = []) {
  const cut = new Set(cuts), out = [];
  let gap = false;
  words.forEach((raw, index) => {
    if (cut.has(index)) { if (out.length) gap = true; return; }
    const word = raw.toLowerCase().replace(/[^\p{L}-]/gu, '');
    if (!word) return;
    const stem = word.length > 4 ? word.slice(0, Math.max(4, word.length - 2)) : word;
    const tail = /[а-яё]/.test(word) ? '[а-яё]*' : '[a-z]*';
    out.push((gap ? '[^.!?]{0,40}' : out.length ? '\\s+' : '') + stem.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + tail);
    gap = false;
  });
  return out.length ? `/(?<![а-яёa-z])${out.join('')}/gi` : '';
}

/** Simplified SPEC §7 block: enough for the preview, not the real template. */
export function fakeBlock(state) {
  const en = state.inject?.language !== 'ru', lang = en ? 'en' : 'ru', bans = state.bans ?? [];
  const q = text => `«${text}»`, dot = text => (/[.!?…]$/.test(text) ? text : `${text}.`);
  const pattern = id => t(`pattern.${id}.prompt`, lang);
  const plain = kind => bans.filter(ban => ban.kind === kind && !ban.alt);
  const lines = [];
  if (plain('phrase').length) lines.push(`${en ? 'Phrases (verbatim, any inflection)' : 'Фразы'}: ${plain('phrase').map(ban => q(ban.text)).join(', ')}.`);
  for (const ban of bans.filter(item => item.alt)) {
    const what = ban.kind === 'pattern' ? pattern(ban.text) : q(ban.text);
    lines.push(`${en ? 'Instead of' : 'Вместо'} ${what}: ${dot(ban.alt)}`);
  }
  if (plain('opener').length) lines.push(`${en ? 'Never open a reply with' : 'Не начинай ответ с'}: ${plain('opener').map(ban => q(ban.text)).join(', ')}.`);
  if (plain('pattern').length) lines.push(`${en ? 'Patterns' : 'Приёмы'}: ${plain('pattern').map(ban => pattern(ban.text)).join('; ')}.`);
  const text = lines.length ? `${en ? '[Avoid]' : '[Избегай]'} ${lines.join('\n')}` : '';
  return { text, tokens: Math.round(text.length / 3.5 / 10) * 10 };
}

/** `sableVisual`: what extension_settings.sableTrackers.visual would hold (null = Sable Trackers not installed). */
export function createFakeRuntime(initial, { suggestions = SUGGESTIONS, sableVisual = null } = {}) {
  let state = structuredClone(initial);
  state.settings = normalizeSettings(initial.settings ?? { ...DEFAULTS, ...initial, jev: { ...DEFAULTS.jev, ...initial.jev } });
  const listeners = new Set(), calls = [], removed = new Map();
  let serial = 0;
  const snapshot = () => structuredClone({ ...state, block: fakeBlock(state) });
  const emit = () => { const snap = snapshot(); for (const listener of [...listeners]) listener(snap); };
  const findBan = id => state.bans.find(ban => ban.id === id);
  const textOf = item => item.text ?? item.words.join(' ');
  // Candidates and openers that left the list, by text and by key, so undo and rescan can bring them back.
  function take(predicate) {
    for (const [field, kind] of [['candidates', 'candidate'], ['openers', 'opener']]) {
      const index = state[field].findIndex(predicate);
      if (index < 0) continue;
      const [item] = state[field].splice(index, 1);
      const entry = { field, kind, item, index };
      removed.set(textOf(item), entry);
      removed.set(`key:${item.key}`, entry);
      return entry;
    }
    return null;
  }
  function restore(id) {
    const entry = removed.get(id);
    if (!entry) return;
    removed.delete(`key:${entry.item.key}`);
    removed.delete(textOf(entry.item));
    if (!state[entry.field].some(item => item.key === entry.item.key)) state[entry.field].splice(entry.index, 0, entry.item);
  }
  function addBan(fields) {
    const ban = { id: `b_${(0x10000000 + ++serial).toString(16)}`, kind: 'phrase', text: '', words: [], cuts: [], alt: '',
      regex: false, regexMode: 'prompt', regexScope: state.settings.regexScope, added: Date.now(), sinceIndex: state.replies ?? 0,
      seenAfter: 0, sinceReplies: 0, matches: 0, findRegex: '', ...fields };
    state.bans.push(ban);
    return ban.id;
  }
  const impl = {
    rescan() { for (const text of state.hidden.splice(0)) restore(text); },
    ban(key, cuts = []) {
      const entry = take(item => item.key === key && item.words);
      if (!entry) return null;
      const { words, df } = entry.item;
      return addBan({ text: trimText(words, cuts), words: [...words], cuts: [...cuts], matches: df,
        findRegex: fakeRegex(words, cuts), from: `key:${key}` });
    },
    banOpener(key) {
      const entry = take(item => item.key === key && !item.words);
      if (!entry) return null;
      const text = entry.item.text.replace(/[….]+$/, '');
      return addBan({ kind: 'opener', text, words: text.split(/\s+/), matches: entry.item.df,
        findRegex: fakeRegex(text.split(/\s+/)), from: `key:${key}` });
    },
    banPattern(id) { return addBan({ kind: 'pattern', text: id }); },
    banText(text) {
      const words = String(text).trim().split(/\s+/).filter(Boolean);
      return words.length ? addBan({ text: words.join(' '), words, findRegex: fakeRegex(words) }) : null;
    },
    unban(id) {
      const ban = findBan(id);
      if (!ban) return;
      state.bans = state.bans.filter(item => item !== ban);
      if (ban.from) restore(ban.from);
    },
    setAlt(id, text) { const ban = findBan(id); if (ban) ban.alt = String(text ?? '').trim(); },
    suggestAlt() { return state.altProfile ? [...suggestions] : []; },
    markIntentional(text) { take(item => textOf(item) === text); if (!state.intentional.includes(text)) state.intentional.push(text); },
    unmarkIntentional(text) { state.intentional = state.intentional.filter(item => item !== text); restore(text); },
    hide(text) { take(item => textOf(item) === text); if (!state.hidden.includes(text)) state.hidden.push(text); },
    unhide(text) { state.hidden = state.hidden.filter(item => item !== text); restore(text); },
    setRegex(id, enabled, mode, scope) {
      const ban = findBan(id);
      if (ban && ban.kind !== 'pattern') Object.assign(ban, { regex: !!enabled, regexMode: mode ?? ban.regexMode, regexScope: scope ?? ban.regexScope ?? 'character' });
    },
    setInject(enabled) { state.inject = { ...state.inject, enabled: !!enabled }; },
    setBlockLanguage(language) { state.inject = { ...state.inject, language }; },
    updateSettings(patch = {}) {
      const merge = (base, delta) => Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(delta)])].map(key => [key, delta[key] && typeof delta[key] === "object" && !Array.isArray(delta[key]) ? merge(base[key] ?? {}, delta[key]) : Object.hasOwn(delta, key) ? delta[key] : base[key]]));
      state.settings = normalizeSettings(merge(state.settings, patch));
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'visual') state.visual = structuredClone(state.settings.visual);
        else if (key === 'inject') state[key] = { ...state[key], ...value };
        else if (['language', 'hints', 'enabled'].includes(key)) state[key] = value;
      }
    },
    importSableVisual() {
      if (!sableVisual || typeof sableVisual !== 'object') return false;
      const visual = Object.fromEntries(SABLE_VISUAL_KEYS.filter(key => Object.hasOwn(sableVisual, key)).map(key => [key, sableVisual[key]]));
      if (!Object.keys(visual).length) return false;
      impl.updateSettings({ visual });
      return true;
    },
    testJev() { return { ok: true, ms: 412, error: null }; },
    preview() { return fakeBlock(state); },
    clearLog() { state.log = []; },
    resetCharacter() { state.bans = []; state.intentional = []; state.hidden = []; },
    dispose() { listeners.clear(); },
  };
  const runtime = {
    calls,
    /** Arguments of every recorded call to one method, oldest first. */
    callsOf: name => calls.filter(call => call[0] === name).map(call => call.slice(1)),
    snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    /** Test hook: replace snapshot fields and notify, as the glue would after a new reply. */
    set(patch) { state = { ...state, ...structuredClone(patch) }; emit(); },
    emit,
  };
  for (const name of METHODS) {
    runtime[name] = (...args) => {
      calls.push([name, ...args]);
      const result = impl[name](...args);
      if (name !== 'dispose') emit();
      // preview() is synchronous in SPEC §15; everything else resolves after "save and republish".
      return name === 'preview' ? result : Promise.resolve(result);
    };
  }
  return runtime;
}
