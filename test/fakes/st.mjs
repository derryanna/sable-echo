export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** `sableVisual`: an optional extension_settings.sableTrackers.visual (Sable Trackers' look, SPEC §17.3). */
export function createFakeST({ snapshots = false, sableVisual } = {}) {
  const handlers = new Map();
  const calls = { requests: [], prompts: [], metadata: [], settings: 0, substitutions: [], fields: [], emits: [] };
  let response = '<sable_state>{"world":{"location":"Observatory"}}</sable_state>';
  const ctx = {
    chat: [], chatMetadata: {}, chatId: 'chat-a', groupId: null,
    characters: [{ name: 'Keeper', avatar: 'keeper.png', data: { extensions: {} } }], characterId: 0,
    async writeExtensionField(id, key, value) { calls.fields.push([id, key, value]); ctx.characters[id].data.extensions[key] = value; },
    name1: 'Player', name2: 'Guide',
    // No `regex` key on purpose: SillyTavern's global regex list may be missing, the first global script creates it.
    extensionSettings: { sableTrackers: { profileId: 'side', ...(sableVisual === undefined ? {} : { visual: sableVisual }) },
      connectionManager: { profiles: [{ id: 'side', name: 'Side model', mode: 'cc', api: 'openai' }] },
      otherExtension: { untouched: true } },
    eventTypes: Object.fromEntries(['MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED',
      'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'CHAT_CHANGED', 'WORLD_INFO_ACTIVATED'].map(key => [key, key])),
    eventSource: {
      on(event, handler) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(handler); },
      removeListener(event, handler) { handlers.get(event)?.delete(handler); },
      // What the runtime emits itself (SPEC §19.4); test code fires events through the top-level emit() below.
      async emit(event, ...args) { calls.emits.push([event, ...args]); for (const handler of handlers.get(event) ?? []) await handler(...args); },
    },
    getCurrentChatId: () => ctx.chatId,
    saveMetadata: async () => { calls.metadata.push(ctx.chatMetadata); },
    saveSettingsDebounced: () => { calls.settings++; },
    setExtensionPrompt: (...args) => { calls.prompts.push(args); },
    substituteParams: text => {
      calls.substitutions.push(text);
      return text === '{{persona}}' ? 'A curious visitor.' : 'An observatory guide.\nPatient.\nAt dusk.';
    },
    ConnectionManagerRequestService: {
      async sendRequest(...args) { calls.requests.push(args); return typeof response === 'function' ? response(...args) : response; },
    },
  };
  return { ctx, calls, handlers, getContext: () => snapshots ? { ...ctx } : ctx,
    respond(value) { response = value; },
    async emit(event, ...args) { for (const handler of handlers.get(event) ?? []) await handler(...args); },
    add(mes = 'The guide opens the dome.', extra = {}) { ctx.chat.push({ mes, is_user: false, ...extra }); return ctx.chat.length - 1; },
    install() { const previous = globalThis.SillyTavern; globalThis.SillyTavern = { getContext: () => ctx }; return () => { if (previous) globalThis.SillyTavern = previous; else delete globalThis.SillyTavern; }; },
  };
}
