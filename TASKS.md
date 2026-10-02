# Tasks

One task per branch. Mark a task `partial` here if you stop before it is done,
with one line on what is missing.

## T1 — pure core

`src/miner.js` (port of `vendor/jeved/repeats.js` with the SPEC §3–§4 changes:
chat-array input, extended cleaner, examples, `trimPhrase`, `regexFor`, exported
`stem`), `src/jev.js` (hosts, `ask` with injectable fetch, `JevError` kinds,
one retry), `src/sensors.js` (the seven questions in wire form, `read` of
answers, rolling means, pattern counts, colour thresholds), `src/bans.js`
(record shape, the pure operations, `mergeCandidates`), `src/block.js`
(`buildBlock` EN/RU with template placeholders, `estimateTokens`),
`src/regex.js` (`scriptFor(ban)`, `mergeScripts(existing, ours)`),
`src/settings.js` (DEFAULTS, `normalizeSettings` idempotent, `loadSettings`,
`saveSettings` with partial patches, `characterRecord(settings, avatar)`).
Fixtures: `fixtures/chat-repeats.json` (synthetic chat, ~30 narrator replies
with planted repeats in Russian and two in English, a few short replies, one
OOC, tracker footers and `<sable_state>` blocks to clean) and
`fixtures/jev-answers.json`. Tests for everything. `package.json`,
`manifest.json`, `index.js` stub that only logs.

## T2 — glue

`src/store.js` (scores ring in `chat_metadata.sableEcho`), `src/run.js`
(`createRuntime(getContext)`: event bindings, mining on render / swipe / delete /
edit / chat change, one batched Jev request per new reply with drop-if-stale,
`snapshot()`, `subscribe()`, `publish()` → `setExtensionPrompt`, ban operations
that save settings and republish, regex install/remove through
`writeExtensionField` + `character_allowed_regex`, alternatives through a
connection profile, `test()` for the Jev settings button, in-memory Jev log of
5, `globalThis.sableEcho` registry + `sable-echo:changed` event + the Sable
hand-off when present), `index.js` bootstrap. Glue tests with
`test/fakes/st.mjs` (extend the fake with `characters`, `characterId`,
`writeExtensionField`).

## T3 — drawer

`src/ui/drawer.js` + `style.css` + `src/i18n.js` strings: the panel of
`docs/mockup.html` on top of `runtime.snapshot()` / `subscribe()`, edge tab +
FAB like Sable Trackers, visual CSS variables (`--st-echo-*`) read from
`settings.visual`, the ⚙ view popover (text size, chip size, width), first-run
states and hints (SPEC §13), `jsdom` tests for the interactions the mockup
tests cover (cut, wildcard, ban/unban, intentional, hidden, edit, examples,
alternative editor, regex line, block RU/EN, view popover).

## T4 — settings

`src/ui/settings.js`: the Extensions-tab groups of SPEC §11 including the Jev
«Проверить» button, theme import/export compatible with Sable Trackers, danger
zone (block template editor, «Показать блок», Jev request log, reset character
decisions). Container-query layout for the narrow desktop column (see Sable
Trackers' `.st-sable-settings` approach). Tests.

## T5 — docs and polish

`README.md` (English with a short Russian section: install from URL, Jev hosts
and keys, what is stored where, privacy of the key, regex modes, hand-off to
Sable Trackers, credits to Jeved/MIT), `dev/preview.html` with a fixture
snapshot for screenshots, manifest `homePage`/version, a last pass on hints and
empty states.

## R2 core — done

SPEC §16.1–§16.5, pure core and glue: `PATTERN_IDS`, `PATTERN_REGEX`,
`localPatternCounts` and `patternRows` in `src/sensors.js` (the miner's
`constructions` output is gone), seven pattern ids in `bans.js`/`block.js`/i18n,
snapshot `patterns` always an array; `settings.regexScope` + per-ban
`regexScope`, global scripts in `extension_settings.regex` (moves, unban and
reset clean both stores); numeric `visual.chipSize` with migration;
`settings.candidates`; settings tab: «Слова-чипы сразу», default scope with
hints, chip size slider. Tests for all of it.

## R2 drawer — done

SPEC §16 in the drawer: the ⚙ view sheet/popover has labelled sliders (text,
chips, opacity, blur, radius, width on desktop; debounced while dragging,
written on release), switches for motion and «Чипы слов сразу»; word chips
by default with `collapsed` keeping §13.1; the patterns card always renders
every standard pattern («нет данных · нужен Jev» for aphorism without Jev);
«Где хранить» select + hint in the regex editor and a «глоб.» mark. A
character or chat switch closes the undo toast and drops drafts; undo is
guarded by the character and chat it was made for. Tests and shots
(`dev/shots/01–08`, `10–11`).

## R3 — done

SPEC §17: the settings block follows the Sable Trackers block (upper-case
captions, label-left rows, SillyTavern's `checkbox_label` / `text_pole` /
`menu_button` markup, 24 px compact sliders, 13 px labels and 12 px hints, two
cells per line in a wide column); `visual.bgImage` / `bgDim` / `bgFit` with
the drawer background layer, a file picker that shrinks pictures to 1280 px
JPEG data URLs, a link field and «Убрать»; theme files carry the picture;
`runtime.importSableVisual()` and «Как в Sable Trackers». Tests and shots
(`dev/shots/10–12`; `dev/st-theme.css` stands in for the SillyTavern theme).
