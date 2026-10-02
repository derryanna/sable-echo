# Instructions for coding agents

Read `SPEC.md` first, then open `docs/mockup.html` (the clickable design the
user approved; `docs/mockup-*.png` are screenshots of it). Work on **one task
from `TASKS.md` per branch/PR** — the task named in your prompt, nothing else.
Small focused diffs; no drive-by refactors.

## Project facts

- SillyTavern **1.18+** third-party UI extension. Plain browser ES modules,
  **no build step, no bundler, no runtime dependencies**. Entry: `index.js`
  (declared in `manifest.json`), styles in `style.css`.
- Installed at `data/<user>/extensions/sable-echo/`, served as
  `/scripts/extensions/third-party/sable-echo/`. Use the global
  `SillyTavern.getContext()`; never import SillyTavern modules by path.
  Available on it (verified on 1.18): `chat`, `chatMetadata`, `characters`,
  `characterId`, `groupId`, `name1`, `name2`, `eventSource`, `eventTypes`,
  `saveMetadata`, `saveSettingsDebounced`, `extensionSettings`,
  `setExtensionPrompt`, `substituteParams`, `getCurrentChatId`,
  `writeExtensionField`, `ConnectionManagerRequestService`, `t`.
  `setExtensionPrompt(key, value, position, depth, scan, role)`: position `1`
  = in-chat at depth, role `0` = system.
  `writeExtensionField(characterId, key, value)` writes
  `characters[characterId].data.extensions[key]` and saves the card.
  Connection profiles: `extensionSettings.connectionManager.profiles`
  (`{id, name, mode: 'cc', api, model, …}`);
  `ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, custom)`
  with `custom = { stream: false, signal, extractData: true, includePreset: false, includeInstruct: false }`.
  Events used: `CHARACTER_MESSAGE_RENDERED`, `MESSAGE_SWIPED`, `MESSAGE_DELETED`,
  `MESSAGE_EDITED`, `CHAT_CHANGED`.
- The `SillyTavern` global, jQuery (`$`) and `toastr` exist at runtime in the
  browser only. **Pure modules must not touch them** so they can be tested in Node.
- `vendor/jeved/` holds the MIT-licensed originals ported into `src/` (keep
  `vendor/jeved/LICENSE`; do not import from `vendor/` at runtime).

## Layout

```
manifest.json  index.js  style.css
src/
  miner.js     clean + mine + trim + regexFor (pure)
  jev.js       Jev client, hosts, errors (pure, fetch injectable)
  sensors.js   question set, windows, thresholds (pure)
  bans.js      per-character decisions, candidate merge (pure)
  block.js     injection text + token estimate (pure)
  regex.js     SillyTavern regex script objects (pure)
  settings.js  defaults + normalize + load/save
  store.js     chat_metadata scores ring
  run.js       runtime: events, mining, Jev, publish, regex install, alternatives, registry
  i18n.js      ru (default) + en
  ui/drawer.js ui/settings.js
vendor/jeved/  originals (reference only) + LICENSE
test/          node:test files, *.test.mjs; test/fakes/st.mjs fakes getContext()
fixtures/      synthetic chats and reports — NO real roleplay text
docs/          mockup.html + screenshots (reference)
dev/           preview pages for screenshots (optional)
```

## Rules

- Tests: `npm test` (= `node --test "test/**/*.test.mjs"`). Node 20+, no network.
  Every pure module gets tests; glue and UI get tests with light fakes. If you
  need a DOM, `jsdom` is the only allowed devDependency.
- All chat and model text is untrusted: `textContent` or an escape helper
  before it reaches the DOM. No `eval`, no `innerHTML` with raw values.
- Never modify `message.mes` or `message.extra`; never touch other extensions'
  settings (SillyTavern's own `character_allowed_regex` is the one allowed
  write, see SPEC §8).
- Mobile first: Android Chrome, 412 px wide. Tap targets ≥ 36 px, word chips
  ≥ 32 px, no horizontal scroll, drawer full width under 700 px.
- User-facing strings go through `src/i18n.js` (Russian default, English).
  Code, comments and commit messages in English. No personal names, hosts or
  local paths anywhere in the repository.
- Fixtures are synthetic. Do not paste text from any real chat.
- Keep the compact code style of Sable Trackers (small pure functions, named
  exports, no classes unless a runtime needs one).
