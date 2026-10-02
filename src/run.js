import { cleanReply, narratorTexts, mineRepeats, stem, hashText, regexFor, countMatches } from './miner.js';
import { ask, resolveHost } from './jev.js';
import { QUESTIONS, questionsFor, buildState, readAnswers, rollingMeans, patternRows, colourFor } from './sensors.js';
import * as decisions from './bans.js';
import { buildBlock, estimateTokens, PATTERN_TEXT } from './block.js';
import { scriptFor, mergeScripts, ownScripts } from './regex.js';
import { loadSettings, saveSettings, characterRecord, SABLE_VISUAL_KEYS } from './settings.js';
import { loadStore, putScore, dropAfter, entries, saveStore, cancelSaveStore } from './store.js';

const narrator = m => m && !m.is_user && !m.is_system;
const tokens = text => (text.match(/[а-яёa-z]+(?:-[а-яёa-z]+)?/gi) ?? []).map(stem);
const keyFor = c => (c.stems ?? tokens(c.text).slice(0, 2)).join(' ');
const errorData = e => ({ kind: e?.kind ?? 'other', message: e?.message ?? String(e) });

export function createRuntime(getContext, { fetch = globalThis.fetch, now = Date.now, newId, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout } = {}) {
    let ctx = getContext(), settings = loadSettings(ctx), store = loadStore(ctx);
    let mined, texts = [], disposed = false, epoch = 0, jevError = null, activeJev = null;
    let miningKey = '';
    let busy = { rescan: false, alternatives: null, regex: null }, log = [];
    let regexQueue = Promise.resolve(), regexOperation = 0, altOperation = 0, handedTo = null;
    const subscribers = new Set(), controllers = new Set(), requests = new Set(), bindings = [];
    const avatar = () => ctx.characters?.[ctx.characterId]?.avatar ?? null;
    const record = () => characterRecord(settings, avatar());
    const profiles = () => (ctx.extensionSettings.connectionManager?.profiles ?? []).filter(p => p.mode === 'cc');
    const configured = () => Object.values(resolveHost(settings.jev)).every(Boolean);
    const latest = () => ctx.chat.findLastIndex(narrator);
    const enabled = () => settings.enabled && !ctx.groupId;
    const handoff = () => settings.handoff === 'sable' && typeof globalThis.sableTrackers?.setExternalSection === 'function';
    const preview = () => {
        const text = buildBlock(record(), { language: settings.inject.language, template: settings.prompts.block });
        return { text, tokens: estimateTokens(text) };
    };
    function getBanlist() {
        const bans = record().bans;
        return [...bans.filter(b => b.kind === 'pattern'), ...bans.filter(b => b.kind !== 'pattern')].slice(0, 8)
            .map(b => ({ pattern: b.kind === 'pattern' ? PATTERN_TEXT[settings.language][b.text] : b.text,
                example: b.kind === 'pattern' ? b.alt : mined.phrases.find(p => !decisions.mergeCandidates(
                    { phrases: [p], openers: [], mined: mined.mined }, { ...decisions.emptyRecord(), bans: [{ ...b, kind: 'phrase' }] }).candidates.length)?.examples[0] ?? '' }));
    }
    function publish() {
        const on = enabled() && settings.inject.enabled;
        const target = handoff() ? globalThis.sableTrackers : null;
        if (handedTo && handedTo !== target) handedTo.setExternalSection('banlist', [], { source: 'echo' });
        handedTo = target;
        if (target) target.setExternalSection('banlist', on ? getBanlist() : [], { source: 'echo' });
        ctx.setExtensionPrompt('sable_echo', on && !handoff() ? preview().text : '', 1, settings.inject.depth, false, 0);
    }
    function reconcile() {
        const count = store.scores.length;
        dropAfter(store, ctx.chat.length);
        store.scores = store.scores.filter(e => {
            const message = ctx.chat[e.mesId];
            return message && (message.swipe_id ?? 0) === e.swipeId && hashText(cleanReply(message.mes)) === e.sig;
        });
        if (count !== store.scores.length) saveStore(getContext, ctx.getCurrentChatId());
    }
    function snapshot() {
        reconcile();
        const r = record(), merged = decisions.mergeCandidates(mined, r), scores = entries(store);
        const since = ban => texts.filter(t => ctx.getCurrentChatId() !== ban.sinceChat || t.index > ban.sinceIndex);
        const means = rollingMeans(scores);
        // SPEC §16.1: every standard pattern, Jev count when Jev is on and scored it, else the local count.
        const patterns = patternRows({ entries: scores, texts, sensors: settings.jev.enabled && configured() ? settings.jev.sensors : null,
            textAt: mesId => ctx.chat[mesId]?.mes }).filter(p => !r.bans.some(b => b.kind === 'pattern' && b.text === p.id)
            && !merged.hidden.some(h => h.text === p.id));
        return structuredClone({ enabled: settings.enabled, language: settings.language, hints: settings.hints,
            chatId: ctx.getCurrentChatId(), groupChat: !!ctx.groupId, avatar: avatar(),
            characterName: ctx.characters?.[ctx.characterId]?.name ?? ctx.name2 ?? '',
            mined: mined.mined, replies: ctx.chat.filter(narrator).length, minDf: settings.miner.minDf,
            candidates: merged.candidates.map(c => ({ ...c, key: keyFor(c) })),
            openers: merged.openers.map(c => ({ ...c, key: keyFor(c) })), intentional: merged.intentional, hidden: merged.hidden.map(h => h.text),
            jev: { enabled: settings.jev.enabled, configured: configured(), busy: activeJev !== null, error: jevError, lastMesId: scores.at(-1)?.mesId ?? null },
            sensors: settings.jev.enabled && scores.length ? Object.fromEntries(Object.entries(means).map(([id, value]) => [id,
                { value, colour: colourFor(id, value, settings.jev.thresholds), series: scores.map(e => e.s[id]).filter(Number.isFinite).slice(-12) }])) : null,
            patterns,
            bans: r.bans.map(b => ({ ...b, sinceReplies: since(b).length,
                seenAfter: b.kind === 'pattern' ? 0 : since(b).filter(t => decisions.banMatches(tokens(t.text), b)).length,
                findRegex: b.kind === 'pattern' ? '' : regexFor(b.words, b.cuts),
                matches: b.kind === 'pattern' ? 0 : countMatches(regexFor(b.words, b.cuts), texts) })),
            altProfile: profiles().some(p => p.id === settings.altProfileId), profiles: profiles().map(({ id, name }) => ({ id, name })),
            settings: { ...settings, characters: undefined }, visual: settings.visual, inject: settings.inject, block: preview(), busy, log });
    }
    function notify() { if (!disposed) for (const cb of subscribers) cb(snapshot()); }
    function addLog(entry) { log = [{ at: now(), ...entry }, ...log].slice(0, 5); }
    function changed() {
        publish();
        if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('sable-echo:changed'));
        notify();
    }
    function saveRecord(next) {
        settings = saveSettings(ctx, { characters: { [avatar()]: next } });
        changed();
    }
    function skip(kind = 'regex') {
        if (disposed || ctx.groupId || !avatar()) { addLog({ kind, status: 'skipped' }); notify(); return true; }
        return false;
    }
    function rescan(force = false) {
        busy.rescan = true;
        const current = record(), next = decisions.pruneHidden(current, { chatId: ctx.getCurrentChatId(), replies: ctx.chat.filter(narrator).length });
        if (next.hidden.length !== current.hidden.length) settings = saveSettings(ctx, { characters: { [avatar()]: next } });
        texts = narratorTexts(ctx.chat, settings.miner);
        // Include every reply signature so middle edits cannot revive a cached report.
        const key = JSON.stringify([settings.miner, texts.map(t => [t.index, hashText(t.text)])]);
        if (force || key !== miningKey) mined = mineRepeats(texts, settings.miner);
        miningKey = key;
        busy.rescan = false;
        notify();
    }
    function addBan(candidate, cuts = []) {
        if (skip() || !candidate) return null;
        const before = new Set(record().bans.map(b => b.id));
        const next = decisions.ban(record(), candidate, { cuts, newId, now, sinceIndex: ctx.chat.length - 1, sinceChat: ctx.getCurrentChatId(), regexScope: settings.regexScope });
        const added = next.bans.find(b => !before.has(b.id));
        if (added) added.regexMode = settings.regexDefault;
        saveRecord(next);
        return added?.id ?? null;
    }
    function changeRecord(fn, ...args) { if (!skip()) saveRecord(fn(record(), ...args)); }
    const scriptsOf = (bans, scope) => bans.filter(b => b.regex && b.regexScope === scope).map(b => scriptFor(b)).filter(Boolean);
    const same = (existing, scripts) => JSON.stringify(ownScripts(existing)) === JSON.stringify(scripts);
    // SPEC §8 + §16.2: character-scope scripts live in the card, global ones in SillyTavern's own list
    // (extension_settings.regex), which holds the global bans of every character. A store is written only
    // when our entries in it change, so a move writes both and a global-only edit never touches the card.
    async function syncRegex(target, characterId, next, characters) {
        const local = scriptsOf(next.bans, 'character'), character = target.characters[characterId];
        const global = [...new Map(Object.values(characters).flatMap(r => scriptsOf(r.bans, 'global')).map(s => [s.id, s])).values()];
        const list = Array.isArray(target.extensionSettings.regex) ? target.extensionSettings.regex : null;
        if (!same(list, global)) {
            // In place, so code holding SillyTavern's array sees the change.
            if (list) list.splice(0, list.length, ...mergeScripts(list, global)); else target.extensionSettings.regex = global;
            target.saveSettingsDebounced();
            announceSettings(target);
        }
        const existing = character.data?.extensions?.regex_scripts;
        if (!same(existing, local)) await target.writeExtensionField(characterId, 'regex_scripts', mergeScripts(existing, local));
        if (local.length) {
            const allowed = target.extensionSettings.character_allowed_regex ??= [];
            if (!allowed.includes(character.avatar)) { allowed.push(character.avatar); target.saveSettingsDebounced(); }
        }
    }
    // SPEC §19.4: the Regex panel renders its list on load; SETTINGS_UPDATED lets anything listening refresh now.
    // Only when the host has that event type; a listener that throws must not fail the regex write.
    function announceSettings(target) {
        const event = target.eventTypes?.SETTINGS_UPDATED;
        if (!event) return;
        try { Promise.resolve(target.eventSource.emit(event)).catch(() => {}); } catch { /* nothing listens, or emit is missing */ }
    }
    async function regexChange(id, fn) {
        if (skip()) return;
        const target = ctx, characterId = ctx.characterId, next = fn(record());
        const operation = ++regexOperation;
        busy.regex = id;
        saveRecord(next);
        const characters = settings.characters;
        const write = regexQueue.then(() => syncRegex(target, characterId, next, characters));
        regexQueue = write.catch(() => {});
        try { await write; }
        catch (e) { addLog({ kind: 'regex', status: 'failed', error: errorData(e) }); }
        finally { if (operation === regexOperation) busy.regex = null; notify(); }
    }
    function identity(mesId) {
        return { chatId: ctx.getCurrentChatId(), mesId, swipeId: ctx.chat[mesId]?.swipe_id ?? 0, sig: hashText(cleanReply(ctx.chat[mesId]?.mes)), epoch };
    }
    async function score(mesId) {
        if (!enabled() || !settings.jev.enabled || !configured() || !narratorTexts(ctx.chat, settings.miner).some(t => t.index === mesId)) return;
        const id = identity(mesId), key = JSON.stringify(id), questions = questionsFor(settings.jev.sensors);
        if (requests.has(key) || store.scores.some(e => e.mesId === mesId && e.swipeId === id.swipeId && e.sig === id.sig) || !Object.keys(questions).length) return;
        requests.add(key);
        const request = { state: buildState(ctx.chat, mesId), questions }, start = now(), controller = new AbortController();
        controllers.add(controller); activeJev = key; jevError = null; notify();
        let response, error = null;
        try { response = await ask({ ...resolveHost(settings.jev), ...request, fetch, signal: controller.signal }); }
        catch (e) { error = errorData(e); }
        const stale = disposed || !enabled() || !settings.jev.enabled || JSON.stringify(identity(mesId)) !== key;
        if (!stale && !error) {
            // Only the current swipe contributes to rolling windows.
            store.scores = store.scores.filter(e => e.mesId !== mesId);
            putScore(store, { mesId, swipeId: id.swipeId, sig: id.sig, at: now(), s: readAnswers(response.answers) });
            saveStore(getContext, id.chatId);
        }
        if (!stale) jevError = error;
        addLog({ kind: 'jev', ms: now() - start, status: stale ? 'dropped' : error ? 'failed' : 'ok', request, response: response ?? null, error });
        controllers.delete(controller); requests.delete(key);
        if (activeJev === key) activeJev = null;
        notify();
    }
    async function suggestAlt(id) {
        const b = record().bans.find(b => b.id === id), profile = profiles().find(p => p.id === settings.altProfileId);
        if (!b || !profile || !enabled() || disposed) return [];
        const controller = new AbortController(), start = now();
        const operation = ++altOperation, currentEpoch = epoch;
        controllers.add(controller); busy.alternatives = id; notify();
        const timeoutError = Object.assign(new Error('Alternatives request timed out'), { kind: 'timeout' });
        let rejectAbort;
        const aborted = new Promise((resolve, reject) => { rejectAbort = () => reject(controller.signal.reason); });
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        const timer = setTimeout(() => controller.abort(timeoutError), 30000);
        try {
            const messages = [{ role: 'system', content: `You suggest replacements for a repeated phrase in roleplay prose. Answer with exactly three short alternatives in ${settings.language === 'ru' ? 'Russian' : 'English'}, one per line, no numbering, no quotes.` },
                { role: 'user', content: `Phrase: «${b.text}». Context (last reply, trimmed):\n${cleanReply(ctx.chat[latest()]?.mes).slice(0, 6000)}` }];
            const response = await Promise.race([aborted, ctx.ConnectionManagerRequestService.sendRequest(profile.id, messages, 120,
                { stream: false, signal: controller.signal, extractData: true, includePreset: false, includeInstruct: false })]);
            if (disposed || currentEpoch !== epoch || operation !== altOperation) return [];
            return String(typeof response === 'string' ? response : response?.content ?? '').split(/\r?\n/)
                .map(s => s.trim().replace(/^(?:\d+[.)]\s*|[-*]\s*)/, '').replace(/^["'«“]+|["'»”]+$/g, '').trim()).filter(Boolean).slice(0, 3);
        } catch (e) { addLog({ kind: 'alt', ms: now() - start, status: 'failed', error: errorData(e) }); return []; }
        finally { clearTimeout(timer); controller.signal.removeEventListener('abort', rejectAbort); controllers.delete(controller); if (operation === altOperation) busy.alternatives = null; notify(); }
    }
    async function testJev() {
        const start = now(), controller = new AbortController(); controllers.add(controller);
        try {
            await ask({ ...resolveHost(settings.jev), fetch, signal: controller.signal,
                state: { latest_turn: 'A door opened. A lamp lit the empty room.', player_message: '', history: [] }, questions: { repeats: QUESTIONS.repeats } });
            return { ok: true, ms: now() - start, error: null };
        } catch (e) { return { ok: false, ms: now() - start, error: errorData(e) }; }
        finally { controllers.delete(controller); }
    }
    function bind(name, fn) { const event = ctx.eventTypes[name], source = ctx.eventSource; source.on(event, fn); bindings.push([source, event, fn]); }
    const rendered = mesId => { if (narrator(ctx.chat[mesId])) { rescan(); void score(mesId); } };
    bind('CHARACTER_MESSAGE_RENDERED', rendered);
    bind('MESSAGE_SWIPED', mesId => {
        const count = store.scores.length;
        store.scores = store.scores.filter(e => e.mesId !== mesId);
        if (count !== store.scores.length) saveStore(getContext, ctx.getCurrentChatId());
        rescan();
        const message = ctx.chat[mesId];
        if (narrator(message) && (message.swipe_id ?? 0) < (message.swipes?.length ?? 1)) void score(mesId);
    });
    bind('MESSAGE_DELETED', () => { reconcile(); rescan(); });
    bind('MESSAGE_EDITED', () => { reconcile(); rescan(true); });
    bind('CHAT_CHANGED', () => { cancelSaveStore(getContext); epoch++; altOperation++; busy.alternatives = null; ctx = getContext(); settings = loadSettings(ctx); store = loadStore(ctx); activeJev = null; jevError = null; reconcile(); rescan(true); publish(); });
    rescan(); publish();
    const updateSettings = patch => { settings = saveSettings(ctx, patch); rescan(); changed(); };
    // SPEC §17.3: Sable Trackers' look, read-only; only the visual keys Echo knows, normalised on save.
    function importSableVisual() {
        const source = ctx.extensionSettings?.sableTrackers?.visual;
        if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
        const visual = Object.fromEntries(SABLE_VISUAL_KEYS.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
        if (!Object.keys(visual).length) return false;
        updateSettings({ visual });
        return true;
    }
    return { snapshot, preview, publish, getBanlist, rescan: () => {
        if (!skip() && record().hidden.length) saveRecord({ ...record(), hidden: [] });
        rescan(true);
    }, suggestAlt, testJev, updateSettings, importSableVisual,
        subscribe(cb) { subscribers.add(cb); cb(snapshot()); return () => subscribers.delete(cb); },
        ban: (key, cuts = []) => addBan(mined.phrases.find(c => keyFor(c) === key), cuts),
        banOpener: key => { const c = mined.openers.find(c => keyFor(c) === key); return c ? addBan({ ...c, kind: 'opener' }) : null; },
        banPattern: id => addBan({ kind: 'pattern', text: id }), banText: text => addBan({ text }),
        unban: id => record().bans.find(b => b.id === id)?.regex ? regexChange(id, r => decisions.unban(r, id)) : changeRecord(decisions.unban, id),
        setAlt: (id, text) => record().bans.find(b => b.id === id)?.regex ? regexChange(id, r => decisions.setAlt(r, id, text)) : changeRecord(decisions.setAlt, id, text),
        setRegex: (id, value, mode = settings.regexDefault, scope) => regexChange(id, r => decisions.setRegex(r, id, value, mode, scope)),
        markIntentional: text => changeRecord(decisions.markIntentional, text), unmarkIntentional: text => changeRecord(decisions.unmarkIntentional, text),
        hide: text => changeRecord(decisions.hide, text, ctx.chat.filter(narrator).length + 10, ctx.getCurrentChatId()), unhide: text => changeRecord(decisions.unhide, text),
        setInject: enabled => updateSettings({ inject: { enabled } }), setBlockLanguage: language => updateSettings({ inject: { language } }),
        clearLog() { log = []; notify(); }, resetCharacter: () => regexChange(null, decisions.emptyRecord),
        dispose() {
            if (disposed) return;
            disposed = true; epoch++;
            cancelSaveStore(getContext);
            for (const [source, event, fn] of bindings) source.removeListener(event, fn);
            for (const controller of controllers) controller.abort();
            subscribers.clear();
            ctx.setExtensionPrompt('sable_echo', '', 1, settings.inject.depth, false, 0);
            if (handedTo) handedTo.setExternalSection('banlist', [], { source: 'echo' });
        },
    };
}
