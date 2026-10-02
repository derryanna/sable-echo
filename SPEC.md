# Sable Echo — spec (v1)

A SillyTavern UI extension that shows what the model keeps repeating and lets the
user build a ban list by hand: repeated phrases found by a local miner, rhetorical
patterns and three live sensors scored by a small classifier (Jev), one-tap bans
with word-level trimming, an optional "write this instead" alternative per ban,
a generated SillyTavern regex per ban, and one short instruction block injected
into the prompt. Nothing is banned automatically. It is a sibling of Sable
Trackers (same visual language, same settings conventions) and will later hand
its ban list to Sable Trackers through a small public contract (§12).

Working name: **Sable Echo**. Settings key `sableEcho`, prompt key `sable_echo`,
CSS prefix `st-echo-`, global `globalThis.sableEcho`.

The interaction design is fixed by the clickable mockup in `docs/mockup.html`
(screens `docs/mockup-cut.png`, `docs/mockup-alt.png`). When this spec and the
mockup disagree on layout, the mockup wins; when they disagree on data or
behaviour, this spec wins.

## 1. Goals, in priority order

1. **Hands-on.** The user taps. The extension proposes candidates and shows
   evidence (counts, examples); it never bans, never rewrites a message, never
   rerolls.
2. **Works with nothing.** The miner needs no key and no server plugin. Jev is
   optional and appears only once a host and key are set.
3. **Phone first.** Android Chrome at 412 px wide is the primary device. Tap
   targets ≥ 36 px, word chips ≥ 32 px, no horizontal scroll.
4. **Cheap.** One batched Jev call per new reply (all questions in one request),
   no main-model calls, no side-model calls unless the user asks for alternatives.
5. **Installable from a GitHub URL on hosted SillyTavern.** No `config.yaml`
   changes, no server plugins, no build step, no dependencies.
6. **Family look.** Visual settings use the same keys as Sable Trackers so one
   theme file styles both.

## 2. Pipeline

```
CHARACTER_MESSAGE_RENDERED (narrator reply)
  ├─ miner (browser, free): last N narrator replies → candidates
  │     phrases · openers · stock constructions, with counts and examples
  ├─ Jev (optional, one request): latest reply + short history → answers
  │     sensors: repeats · speaks · change   patterns: aphorism · antithesis · filter · negation
  └─ merge with the character's decisions (banned / intentional / hidden)
        → drawer render → injection block → regex scripts (if enabled per ban)
```

Mining and Jev run fire-and-forget from the event handler (SillyTavern awaits
listeners sequentially; never make other extensions wait). A run that no longer
matches the latest message (new reply, swipe, chat change) is dropped silently.

## 3. Cleaning and mining (`src/miner.js`, pure)

Ported from `vendor/jeved/repeats.js` (MIT, Jeved contributors; keep the notice).
Differences from the original:

- `cleanReply(raw)` additionally strips: `<sable_state>…</sable_state>`,
  `<state>`, `<tracker>`, `<mood>`, `<Blocks>…</Blocks>`, `<World_State>`,
  `<checklist>`, `<info>`, `<details>`, HTML comments, Markdown images, and any
  trailing block that starts with `---` followed by emoji lines (tracker footers).
  Case-insensitive on tag names.
- `narratorTexts(chat, { replies = 60, minChars = 200 })` takes the chat array
  (no SillyTavern globals), keeps non-user, non-system messages whose cleaned
  text is ≥ `minChars` and does not start with `[OOC` / `OOC:` / `(OOC`.
- `mineRepeats(texts, { minDf = 3, top = 12, openersTop = 6 })` returns
  `{ phrases, openers, constructions, mined }` where every phrase is
  `{ text, words: string[], stems: string[], df, docs: number[], examples: string[] }`
  (`examples` = up to 2 sentences from different replies containing the phrase,
  each ≤ 200 chars, phrase occurrence marked with `«»` only in the UI, never in
  the data), openers are `{ text, df, docs }` keyed on the first two stems with a
  six-word sample, constructions are `{ id, label, perReply }` for the six
  stock constructions of the original ("не X, а Y", "словно/будто", "-то",
  "на секунду/мгновение/миг", "not X, but Y", "something/somewhere").
  `mined` = number of replies used.
- The stemmer `stem(word)` is exported (used by `regexFor`).
- Cache by `(count, hash(first), hash(last))` exactly like the original.

## 4. Phrase trimming, wildcards and regex (`src/miner.js`, pure)

A candidate is a list of words. The user cuts words out by tapping chips.

- `trimPhrase(words, cuts)` → `{ text, parts }`: cut words at either end simply
  drop; a cut word in the middle becomes a gap, shown as `…` in `text`
  (`«уголки … дрогнули»`). `parts` is the list of kept runs.
- `regexFor(words, cuts)` → string in SillyTavern's `/pattern/flags` form:
  each kept word becomes `stem(word)` escaped + an inflection tail
  (`[а-яё]*` for Cyrillic words, `[a-z]*` for Latin), words inside a run are
  joined with `\s+`, a gap becomes `[^.!?]{0,40}`, flags `gi`. Example:
  `/(?<![а-яёa-z])сердц[а-яё]*\s+пропуст[а-яё]*\s+удар[а-яё]*/gi`. The leading
  lookbehind is the word boundary: JavaScript `\b` and `\w` are ASCII-only and
  never match Cyrillic; do not use them. `countMatches(regexString, texts)`
  returns how many of the given replies the pattern hits (the editor shows
  «совпадений в последних N: M» as a preview before the user installs anything).
- A free-text edit (✎) replaces `words` with the split of the typed text; cuts
  reset.

## 5. Jev (`src/jev.js`, `src/sensors.js`, pure)

Wire format (TypeSafe "systemone", also served by Rout, OpenRouter and NanoGPT):
`POST {model, state, questions}` → `{answers, usage}`. Ported from
`vendor/jeved/sensor-types.js` (`wire()` builds a question, `read()` parses an
answer for `score` / `choice` / `noul`).

Hosts (`HOSTS` in `src/jev.js`): all are called **directly from the browser**
(CORS verified 1 Oct 2026 for the first three).

| id | endpoint | model | key |
|---|---|---|---|
| `rout` | `https://api.rout.my/v1/systemone` | `typesafe/jev-latest` | Rout key |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` | OpenRouter key |
| `nanogpt` | `https://nano-gpt.com/api/v1/decisions` | `typesafe/jev-1.13` | NanoGPT key |
| `custom` | user URL | user model | user key |

`ask({ endpoint, apiKey, model, state, questions, signal, timeoutMs = 20000, fetch })`
returns `{ answers, usage }` or throws `JevError` with `kind` ∈
`'key' | 'credit' | 'timeout' | 'config' | 'network' | 'other'` and a short
English message (the UI translates by kind). Retries once on 429/529 after 2 s.
`fetch` is injectable for tests. The key goes in `Authorization: Bearer`.

State sent per reply: `{ latest_turn, player_message, history }` where
`latest_turn` = cleaned latest narrator reply (≤ 6000 chars), `player_message`
= the user's last message (≤ 2000), `history` = the five cleaned narrator
replies before it (each ≤ 1500). No card, no lore, no persona.

Questions (`src/sensors.js`; texts in English because Jev is tuned on English
instructions; the level texts are adapted from the Jeved Director preset, MIT):

| id | type | question (summary) | levels / answer |
|---|---|---|---|
| `repeats` | score | reuse of phrases or sentence patterns from `history` in `latest_turn` | 0 nothing … 4 same structure and wording as an earlier reply |
| `speaks` | score | how much `latest_turn` writes what only the player's character does, says or thinks | 0 nothing … 4 decides for the player |
| `change` | score | how much the situation changes in `latest_turn` | 0 nothing … 4 major turning point |
| `aphorism` | noul | the last sentence of `latest_turn` is a general, quotable statement rather than an action, perception or line of dialogue | 0–1 |
| `antithesis` | noul | `latest_turn` uses the "not X, but Y" construction as ornament | 0–1 |
| `filter` | noul | `latest_turn` narrates perception through filter verbs (noticed, felt, realised, saw that) instead of showing the thing | 0–1 |
| `negation` | noul | `latest_turn` narrates things that did not happen (did not move, said nothing, no answer came) as events | 0–1 |

All seven go in one request. A sensor the user switched off is not sent.

Rolling windows and colours (`src/sensors.js`, pure):
- Sensor strip values = mean of the last 8 scored replies. Colours:
  `repeats` green < 2.0, amber < 2.8, red ≥ 2.8; `speaks` green < 2.0, amber
  < 2.85, red ≥ 2.85; `change` red < 1.0, amber < 1.6, green ≥ 1.6. Thresholds
  live in one table and are overridable in settings (`sensors.thresholds`).
- Pattern rows = count of the last 10 scored replies where the noul answer ≥ 0.5,
  shown as "N из 10" with a proportional bar; the row's example is the last
  sentence (aphorism) or the matching sentence found by a simple regex on the
  latest flagged reply (antithesis: `не\s+\S+.*,\s*а\s+`; filter:
  `(заметил|почувствовал|осознал|понял|увидел, что)`; negation:
  `не\s+(пошевелил|ответил|сказал|двинул)`), empty when nothing matches.
- Scores are stored per chat in `chat_metadata.sableEcho.scores`, a ring of the
  last 60 entries `{ mesId, swipeId, sig, at, s: { repeats, speaks, change,
  aphorism, antithesis, filter, negation } }` where `sig` = hash of the cleaned
  reply. Swipes replace, deletes drop the tail, an edit with a different `sig`
  invalidates the entry. **Never written into `message.extra`** (chat bloat).

## 6. Decisions and the ban list (`src/bans.js`, pure)

Per character, in `extension_settings.sableEcho.characters[avatar]`
(`avatar` = the character's avatar file name, the key SillyTavern itself uses
for `character_allowed_regex`). Shared between devices through settings.json,
independent of the chat, so bans follow the card.

```
{ bans: [ { id: 'b_' + 8 hex,
            kind: 'phrase' | 'opener' | 'pattern',
            text: 'уголки губ дрогнули',      // trimmed text; for patterns the pattern id
            words: ['уголки','губ','дрогнули','в','подобии','улыбки'], // phrases/openers only
            cuts: [3,4,5],                   // indexes cut out
            alt: 'дыхание сбилось' | '',     // "instead" text
            regex: false,                    // a scoped regex script is installed for this ban
            regexMode: 'prompt' | 'display' | 'both',
            added: 1696170000000,
            sinceIndex: 212 } ],              // chat index of the latest message when banned; «снова встретилось» counts replies after it
  intentional: [ 'да, милорд' ],            // phrase texts never offered again
  hidden: [ { text, until } ] }             // dismissed until the next rescan (until = mined count at dismissal + 10)
```

`src/bans.js` exports pure operations that return a new character record:
`ban(record, candidate, { cuts })`, `unban(record, id)`, `setAlt(record, id, alt)`,
`markIntentional(record, text)`, `unmarkIntentional`, `hide(record, text, until)`,
`unhide`, `setRegex(record, id, enabled, mode)`; `mergeCandidates(report, record)`
returns the drawer model: candidates minus banned/intentional/hidden texts
(match on the stems, so a trimmed ban hides the longer candidate), plus the
folded counts. A ban made from a trimmed phrase hides every candidate whose
stems contain the ban's kept runs in order.

## 7. Injection block (`src/block.js`, pure)

`buildBlock(record, { language = 'en', template })` returns the text for
`setExtensionPrompt`, empty when there are no bans or injection is off.

English default template (lines without content are omitted):

```
[Avoid] Phrases (verbatim, any inflection): «уголки губ дрогнули», «тишина повисла».
Instead of «сердце пропустило удар»: дыхание сбилось (a direction, vary the wording).
Never open a reply with: «Он медленно поднял взгляд», «Тишина».
Patterns: closing aphorism as the last line; «not X, but Y» antithesis; filter verbs (noticed, felt) instead of direct action; narrating what a character did not do.
```

A ban with an `alt` appears only in its "Instead of" line. A pattern with an
`alt` reads `Instead of <pattern phrase>: <alt>.` The Russian template is the
same shape («[Избегай] Фразы: …», «Вместо «…»: …», «Не начинай ответ с: …»,
«Приёмы: …»). The pattern phrases for both languages live in `src/i18n.js`.
Banned phrases are always verbatim in their own language. The template is
editable in the danger zone (`settings.prompts.block`, placeholders
`{phrases}` `{instead}` `{openers}` `{patterns}`; null = default).

Injection: `ctx.setExtensionPrompt('sable_echo', text, 1, settings.depth, false, 0)`
(in-chat, depth default 1, system role). Published on every ban change, on
`CHAT_CHANGED` (the new character's record) and when the toggle flips; an empty
string clears it. `estimateTokens(text)` = `Math.round(text.length / 3.5 / 10) * 10`.

## 8. Regex scripts (`src/regex.js`, pure + glue in `run.js`)

For a ban with `regex: true`, the extension maintains one **scoped** (per
character) SillyTavern regex script:

```
{ id: 'sable-echo:' + ban.id, scriptName: 'Echo: ' + ban.text,
  findRegex: regexFor(words, cuts), replaceString: ban.alt || '',
  trimStrings: [], placement: [2],            // AI output
  disabled: false, markdownOnly: mode === 'display', promptOnly: mode === 'prompt',
  runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null }
```

Written with `ctx.writeExtensionField(characterId, 'regex_scripts', scripts)`
where `scripts` = the character's existing `data.extensions.regex_scripts`
with our entries (by id prefix) replaced; the character's avatar is added to
`extension_settings.character_allowed_regex` (SillyTavern's own opt-in list)
when the first script is installed. Removing a ban or switching `regex` off
removes the script. Patterns never get a regex. Group chats: regex actions are
disabled with a hint. Default mode `'prompt'` (the model stops seeing its own
tic in the history; the user still sees the original text). A one-line hint in
the editor explains the modes. Nothing else of the character card is touched.

## 9. Alternatives

`alt` is typed by the user. «Предложить» is available only when
`settings.altProfileId` names a chat-completion connection profile (same
mechanism as Sable Trackers: `ConnectionManagerRequestService.sendRequest`).
Prompt: system "You suggest replacements for a repeated phrase in roleplay
prose. Answer with exactly three short alternatives in {language}, one per line,
no numbering, no quotes." + user "Phrase: «…». Context (last reply, trimmed):
…". Max 120 tokens. The three lines become chips; tapping one fills the input.
Off by default; never called without a tap.

## 10. Storage summary

| where | what |
|---|---|
| `extension_settings.sableEcho` | settings (§11), `characters[avatar]` records (§6), `visual` |
| `chat_metadata.sableEcho` | `scores` ring (§5), nothing else |
| character card `data.extensions.regex_scripts` | our scoped regex scripts (§8), by id prefix |
| memory only | last mined report, last 5 Jev requests/responses (danger-zone log) |

Never `message.mes`, never `message.extra`, never other extensions' settings
(except SillyTavern's own `character_allowed_regex`, which is the documented
opt-in for scoped regex).

## 11. Settings (`src/settings.js`)

```
{ enabled: true, language: 'ru' | 'en',
  miner: { replies: 60, minChars: 200, minDf: 3, top: 12 },
  jev: { host: 'rout' | 'openrouter' | 'nanogpt' | 'custom', endpoint: '', model: '', apiKey: '',
         enabled: false, sensors: { repeats: true, speaks: true, change: true,
                                    aphorism: true, antithesis: true, filter: true, negation: true },
         thresholds: {…§5 defaults…} },
  inject: { enabled: true, depth: 1, language: 'en' | 'ru' },
  prompts: { block: null },
  altProfileId: null,
  regexDefault: 'prompt' | 'display' | 'both',
  handoff: 'self' | 'sable',                // §12
  hints: true,                              // one-line helper texts in the drawer
  characters: {},
  visual: { opacity: 0.93, blur: 14, fontSize: 13, widthVw: 80, accent: '#f5f4ee',
            base: null, text: null, radius: 18, motion: true, spacing: 'cozy',
            chipSize: 'normal' | 'compact' | 'large',     // a number of px since §16.3
            bgImage: null, bgDim: 0.45, bgFit: 'cover' } } // §17.2
```

`normalizeSettings` is idempotent, clamps numbers, drops unknown keys, and
keeps `characters` records valid (§6 shapes). `visual` keys are the Sable
Trackers names so `sable-theme.json` files import into both; unknown keys are
ignored, `chipSize` is Echo's own. The API key is stored in extension settings
like every other UI extension that talks to a host; the settings group says so
in one sentence.

Extensions-tab groups, in order: Основное (enabled, language), Jev (host,
endpoint/model for custom, key, «Проверить» test button that sends a tiny state
and shows latency, sensors toggles), Майнер (replies, minChars, minDf),
В промпт (enabled, depth, block language), Альтернативы (profile select),
Регексы (default mode), Внешний вид (sliders as in Sable + chip size + theme
import/export), Опасная зона (block template editor with «По умолчанию», «Показать
блок», Jev request log with copy, «Сбросить решения для этого персонажа»).

## 12. Public contract and the Sable Trackers hand-off

`index.js` exposes `globalThis.sableEcho = { version: 1, getBanlist(),
subscribe(cb) }` where `getBanlist()` returns `[{ pattern, example }]` (max 8:
patterns first with their localized phrase as `pattern` and `alt` as example,
then phrases with `pattern` = the trimmed text and `example` = the first mined
example), and fires `document.dispatchEvent(new CustomEvent('sable-echo:changed'))`
on every ban change. When `settings.handoff === 'sable'` and
`globalThis.sableTrackers?.setExternalSection` exists, the runtime calls
`setExternalSection('banlist', getBanlist(), { source: 'echo' })` after each
change and publishes an **empty** own block. The Sable Trackers side of this
contract is a separate change in that repository; v1 of Echo only has to call
it when present.

## 13. Drawer (`src/ui/drawer.js`, `style.css`)

Layout and interactions exactly as `docs/mockup.html`: header (title, status
line, ⟳ rescan, ⚙ view popover, ✕), sensor strip (visible only when Jev is
enabled and has at least one score in this chat), «Кандидаты» (word chips,
live trimmed result, ×N badge with examples, «В бан / Нарочно / Скрыть», ✎),
«Зачины» inside the candidates card, «Приёмы» (visible only when Jev is
enabled), «Бан-лист» (chips, inline editor with alternative + «Предложить» +
regex line + mode + «в регексы персонажа», «в промпт» toggle, «Показать блок»
with RU/EN, token estimate), footer with the mined count. Opened by an edge
tab / FAB like Sable Trackers; on screens under 700 px it is full width. Every
rendered string from the chat or a model goes through `textContent`.

First run and progressive disclosure (beginner mode without a toggle):
- No Jev key → no sensor strip, no «Приёмы»; instead one dismissible line under
  the header: «Приёмы и датчики появятся, когда добавишь ключ Jev в настройках».
- Fewer than `minDf` long replies → the candidates card shows «Мало длинных
  ответов, нужно хотя бы N» and the panel is otherwise empty.
- Hints (`settings.hints`): «Тап по слову вырезает его из фразы», «Тап по чипу —
  альтернатива и регекс». Each hint has a small ✕ that turns `hints` off.
- The regex and alternative editors are inside the ban chip, never shown until
  the first ban exists.

### 13.1 Changes relative to the mockup (design review, 1 Oct 2026)

These override the mockup where they differ.

1. **Candidates are collapsed.** A row = the phrase as text (bold), a line
   «9 из 60 ответов · примеры» (tap = the two examples), and two buttons:
   «В бан» (primary) and «Оставить ▾» (a small menu: «Это намеренно», «Скрыть
   пока»). A text link «Обрезать» expands the word chips + ✎; the «→ result»
   line appears only once a word is cut. Five rows, then «Ещё N».
2. **Undo toast** after ban / intentional / hide: «Добавлено в бан · Отменить»
   for 4 s (bottom centre, ≥ 36 px tall).
3. **Card headers fold** on tap (in-memory for v1, not persisted).
4. **Patterns are neutral**: no amber dashed chips; a row = name, «7 из 10
   последних» with a neutral bar, the example, button «Избегать приём».
5. **Ban list**: chips while ≤ 5 entries, rows beyond (text · ↷ alt mark ·
   regex mark · «снова: N» when `seenAfter > 0` · ✕). The toggle keeps the
   label «в промпт» and gets the caption «действует на следующие ответы, старые
   не меняются». RU/EN switch and the token estimate live inside the opened
   «Показать блок».
6. **Ban editor** (tap a chip/row): first the alternative («Что писать
   вместо? …» input, «Предложить» only when a profile is set), then a folded
   «Регекс» sub-row: the pattern, «совпадений в последних 60: 9», mode select
   (prompt / display / both), «в регексы персонажа» toggle.
7. **Sensor strip** shows a word next to the number: «Повторы 2.3 · высоко»
   (низко / средне / высоко by colour).
8. **⚙ Вид** on phones is a bottom sheet, in this order: text size as three
   «Аа» samples (fontSize 13 / 14 / 16), chip size as three «например» sample
   chips (28 / 36 / 44 px, chosen one with border + check; chip size also
   scales button heights), «Свернуть все карточки», «Готово» pinned at the
   bottom. Changes apply immediately, swiping the sheet away keeps them, no
   reset. Width appears only on screens ≥ 700 px, where the same controls are a
   popover.
9. **First run**: no Jev → one calm line «Подключить анализ приёмов» that opens
   the settings; no sensor strip, no zeros. No long replies → «Пока нет длинных
   ответов для анализа. Добавьте фразу вручную.» + a text input → `banText`.
   The first ban ends with the undo toast and nothing else (no follow-up
   question); the alternative lives only inside the ban editor.
12. **«Снова встретилось»** on a ban row names its period: «снова: 3 за 12
    ответов» (`seenAfter` and `sinceReplies` from the snapshot). The
    before/after comparison («было 6 из 20, стало 2») is deferred until
    comparable windows are defined.

### 13.2 Microcopy (ru / en)

| where | ru | en |
|---|---|---|
| empty state | Пока нет длинных ответов для анализа. Добавьте фразу вручную. | No long responses to analyze yet. Add a phrase manually. |
| no Jev key | Подключить анализ приёмов | Enable technique analysis |
| undo toast | Добавлено в бан · Отменить | Added to ban list · Undo |
| under «в промпт» | Действует на следующие ответы. Старые не меняются. | Applies to future responses. Past responses stay unchanged. |
| word chips hint | Нажмите на слово, чтобы убрать его из фразы. | Tap a word to remove it from the phrase. |
| «Оставить ▾» items | Это намеренно · Скрыть пока | This is intentional · Hide for now |
| pattern row button | Реже использовать | Use less often |
10. **Accent bar** only on the ban list card and only while «в промпт» is on,
    matching its meaning in Sable Trackers.
11. **Defaults**: `visual.fontSize` 14, `chipSize` `'normal'`.

## 15. Runtime interface (the seam between T2 and T3/T4)

`createRuntime(getContext)` in `src/run.js` returns an object; the UI only ever
talks to it, never to SillyTavern directly.

```
snapshot() → {
  enabled, language: 'ru'|'en', hints: bool,
  chatId, groupChat: bool, avatar: string|null, characterName: string,
  mined: number,                       // replies used by the last report
  replies: number,                     // narrator replies in the chat
  minDf: number,
  candidates: [{ key, words, df, docs, examples }],   // key = stems joined by ' ', stable across rescans
  openers:    [{ key, text, df, docs }],
  intentional: [text], hidden: [text],
  jev: { enabled, configured, busy, error: { kind, message } | null, lastMesId },
  sensors: { repeats: { value, colour, series }, speaks: {…}, change: {…} } | null, // null until a score exists
  patterns:  [{ id, source: 'jev'|'miner'|null, count: number|null, window, rate: number|null, example }], // §16.1: always an array in PATTERN_IDS order; banned and hidden ids left out
  bans: [ …§6 ban records + { regexScope, seenAfter, sinceReplies, matches } ],   // regexScope = 'character'|'global' (§16.2); seenAfter = replies after sinceIndex containing the phrase; sinceReplies = narrator replies after sinceIndex; matches = mined replies the regex hits
  altProfile: bool,                    // a usable alternatives profile is configured
  profiles: [{ id, name }],            // chat-completion connection profiles, for the settings select
  settings: { …§11 settings, characters: undefined }, // editable settings; no character records
                                       // + candidates: 'chips'|'collapsed' (§16.4), regexScope: 'character'|'global' (§16.2)
  visual: { …§11 visual… },            // chipSize is a number of px, 28–48 (§16.3)
  inject: { enabled, depth, language: 'en'|'ru' },
  block: { text, tokens },
  busy: { rescan: bool, alternatives: banId | null, regex: banId | null },
  log: [ { at, kind: 'jev'|'alt', ms, status, request, response, error } ] }   // newest first, max 5, memory only

subscribe(cb) → unsubscribe        // cb(snapshot) after every change, also right after subscribing
rescan()                            // re-mine; hidden entries whose `until` passed come back
ban(candidateKey, cuts = [])        // phrase → ban record; words come from the candidate
banOpener(key)
banPattern(id)
banText(text)                       // free-text edit confirmed (✎): words = text split on spaces, no cuts
unban(banId)                        // the chip's ✕
setAlt(banId, text)
suggestAlt(banId) → Promise<string[]>   // [] when no profile; errors land in log + busy cleared
markIntentional(text) / unmarkIntentional(text)
hide(text) / unhide(text)
setRegex(banId, enabled, mode, scope) // installs/removes/moves the script; scope 'character'|'global', omitted = keep; resolves when saved (§16.2)
setInject(enabled)
setBlockLanguage('en'|'ru')
updateSettings(patch)               // any §11 patch incl. visual; UI uses this for ⚙ and the settings tab
importSableVisual() → bool          // §17.3: copies Sable Trackers' look (read-only); false when it has none
testJev() → Promise<{ ok, ms, error }>
preview() → { text, tokens }        // the exact block, same code path as publish
clearLog()
resetCharacter()                    // drops the character's record after the UI's two-tap confirm
dispose()
```

Cut state (which words are tapped out) and in-progress edits live in the UI,
keyed by candidate `key`; they are not persisted. Every method that changes
the record saves settings and republishes before resolving.

## 14. Non-goals for v1

Reroll, rules engine, auto-ban, rewriting or editing messages, group chats
(panel shows a hint and does nothing), text-completion history formats beyond
what the chat array gives, per-chat ban lists, user-written Jev questions.

## 16. Round 2 (user feedback on v0.1.0, 1 Oct 2026 evening)

These override earlier sections where they differ.

### 16.1 Standard patterns without Jev

The «Приёмы» card is always present. `snapshot.patterns` is always an array
(never `null`) with one entry per standard pattern, in this order:

| id | ru label | counted locally by | Jev |
|---|---|---|---|
| `antithesis` | «не X, а Y» | regex (ru `не … , а …` / en `not … , but …`) | yes |
| `filter` | фильтр-глаголы | regex (заметил/почувствовал/осознал/понял/увидел, что; noticed/felt/realised/saw that) | yes |
| `negation` | отрицательное действие | regex (не пошевелил/ответил/сказал/двинул; did not move/said nothing/no answer came) | yes |
| `aphorism` | закрывающий афоризм | — (judgement only) | yes |
| `simile` | «словно / будто» | regex (словно/будто/точно так же, как; as if/as though/like a) | no |
| `indefinite` | «что-то / где-то» | regex (что-то/где-то/какой-то…; something/somewhere/somehow) | no |
| `moment` | «на мгновение / на миг» | regex (на секунду/мгновение/миг; for a moment/an instant) | no |

Entry shape: `{ id, source: 'jev' | 'miner' | null, count, window, rate, example }`.
`count` = Jev count over the last 10 scored replies when Jev is enabled and has
a score for that pattern (source `'jev'`), otherwise the number of the last 10
mined replies whose cleaned text matches the pattern regex (source `'miner'`),
otherwise `null` with `window 0` (source `null`, shown as «нет данных» for
`aphorism` without Jev). `rate` = `count / window` or `null`. `example` = the
matching sentence of the latest matching reply (`findExample`). Every pattern
is bannable regardless of count («Реже использовать»); banned ones leave the
card. The miner's old `constructions` output is replaced by this table
(`localPatternCounts(texts, window = 10)` in `src/sensors.js`, regexes in one
exported `PATTERN_REGEX` table, ru + en in one regex per id). `PATTERN_TEXT`
(block.js) and the i18n pattern labels gain the three new ids; the English
block text: `simile` → "«as if / like» similes as ornament", `indefinite` →
"vague «something / somewhere» placeholders", `moment` → "«for a moment» beats".

### 16.2 Regex scope: character or global

`settings.regexScope: 'character' | 'global'` (default `'character'`) and per
ban `regexScope` (set from the default at ban time, editable in the ban
editor next to the mode: «Где хранить: у персонажа / глобально»).
- `character` = the scoped script in the card as in §8.
- `global` = the same script object in `extension_settings.regex` (SillyTavern's
  global list): replace entries whose id starts with `sable-echo:`, then
  `saveSettingsDebounced()`. No card write, no `character_allowed_regex` change.
Changing scope moves the script (remove from one store, write to the other).
Removing a ban removes its script from both stores. Global scripts work in
group chats too, but bans stay disabled there in v1 (unchanged).

### 16.3 View sheet with sliders

The ⚙ «Вид» sheet (phone) / popover (desktop) uses sliders, not samples:
text size 12–18, chip size 28–48 px (continuous), opacity 0.5–1, blur 0–30,
radius 8–24, width (desktop only), a motion switch, «Чипы слов сразу» switch
(§16.4), «Свернуть все карточки», «Готово». Every slider writes
`updateSettings({ visual })` live. `visual.chipSize` becomes a number of pixels
(28–48, default 36); `normalizeSettings` migrates the old strings
(`compact` → 28, `normal` → 36, `large` → 44). The settings tab shows the same
slider instead of the select.

### 16.4 Word chips visible by default

`settings.candidates: 'chips' | 'collapsed'` (default `'chips'`). In `chips`
mode a candidate row shows its word chips immediately (the approved mockup
look: tap a word to cut it, the «→ result» line appears once something is
cut), and the «Обрезать» link is not rendered. `collapsed` keeps the §13.1
behaviour. The settings tab («Основное») and the view sheet both expose the
switch.

### 16.5 Snapshot additions

`settings.candidates`, `settings.regexScope`, `bans[].regexScope`,
`patterns` as in §16.1, `visual.chipSize` numeric.

## 17. Round 3 (user feedback on the settings tab, 1 Oct 2026 night)

### 17.1 Settings tab looks like Sable Trackers

On a phone the Echo settings block is several times taller than Sable's:
range inputs render as tall blue bars, checkboxes as huge circles, every
control on its own full-width line. Make `src/ui/settings.js` + the settings
rules in `style.css` match the Sable Trackers settings block in structure and
size (read its `src/ui/settings.js` and the settings rules at the end of its
`style.css`): small upper-case group captions («ПОДКЛЮЧЕНИЕ» style), one row
per control with the label on the left and the control on the right (number
inputs, selects and colour inputs ~45% width on phones, full width only for
textareas and the danger-zone dumps), SillyTavern's own checkbox markup
(`<label class="checkbox_label"><input type="checkbox">…`) so the theme styles
them, range inputs 24 px tall with a 16–18 px thumb and the value on the right
of the label line, 13 px labels, 12 px hints. The two-column desktop layout
and the container query stay. Group order and contents are unchanged.

### 17.2 Background picture (same keys as Sable Trackers)

`visual.bgImage` (`null` | `data:image/(png|jpeg|webp);base64,…` ≤ 800 000 chars
| `http(s)://…`), `visual.bgDim` 0–0.9 (default 0.45, wash of the base colour
over the picture), `visual.bgFit` `'cover' | 'contain' | 'tile'`.
`normalizeSettings` validates them. The drawer paints the picture behind the
panel content (a layer under the cards, `data-st-echo-bg="1"` on the drawer,
`--st-echo-bg-dim`), header and status line get a base-coloured backing so
text stays readable (SillyTavern's «no text shadows» option kills
text-shadow). Settings: «Фон панели» row with a file picker (downscale through
a canvas to ≤ 1280 px on the long side, JPEG quality 0.82, reject when the
result is still over the limit, store as a data URL so phone and PC share it),
a URL input, «Убрать». Theme export/import carry the three keys; importing a
Sable theme file applies them too.

### 17.3 «Как в Sable Trackers»

A button in «Внешний вид»: `runtime.importSableVisual()` reads
`ctx.extensionSettings.sableTrackers?.visual` (read-only, never written) and
applies every key Echo knows (opacity, blur, fontSize, widthVw, accent, base,
text, radius, motion, spacing, bgImage, bgDim, bgFit) through
`updateSettings({ visual })`; returns `true` when something was applied,
`false` when Sable Trackers is not installed or has no visual settings (the
button then shows «Sable Trackers не найден» for a few seconds). Nothing else
of Sable's settings is read.

## 18. Round 4 (user feedback on 0.3.x, 1 Oct 2026 late)

### 18.1 Density and a scale control

On a phone everything is still larger than Sable Trackers: drawer selects
and inputs are ~70 px tall (host `select`/`input` padding and font leak in),
rows are airy, hints are long. Changes:
- `visual.scale` 0.7–1.2 (default 1, step 0.05), shown as «Масштаб» in the ⚙
  sheet (first slider) and in the settings «Внешний вид». Applied with CSS
  `zoom: var(--st-echo-scale)` on the drawer's scrolling content and on the
  sheet body (never on the fixed root, so the panel keeps its viewport size).
- Defaults tightened: base font 13 px (`visual.fontSize` default 13), card
  padding 10 px, row gaps 6 px, hint text 12 px and at most one line each,
  section header 15 px. Every `select`, `input`, `button` inside the drawer gets
  an explicit `height: 36px; padding: 0 10px; font-size: var(--st-echo-fs);
  line-height: 1.2; box-sizing: border-box` (host theme rules must not win);
  word chips keep `visual.chipSize`. The ban editor fits one phone screen with
  the regex fold closed.
- Settings tab: the same explicit 36 px height and 13 px font on selects,
  inputs and buttons; row padding 6 px; sensor hint lines 12 px. Target: the
  Echo block on a 412 px phone is not taller per row than Sable's block.

### 18.2 Word-chip affordance

Not everyone will guess that words are tappable. Each word-chip row starts
with a small ✂ glyph (muted, 20 px, inside a 36 px tap area) whose tap shows
the one-line hint «Нажмите на слово, чтобы убрать его из фразы» under that row
for 4 s; the ✎ (free-text edit) stays at the end of the row. The first-run
hint line stays as it is.

### 18.3 Alternatives request timeout

`suggestAlt` aborts after 30 s (AbortController + timer), logs
`{ kind: 'alt', status: 'failed', error: { kind: 'timeout' } }`, clears
`busy.alternatives`, and the «Предложить» button shows «не ответил» for 3 s
instead of staying on «думаю…».

## 19. Round 5 (user feedback on the morning of 2 Oct 2026)

### 19.1 Sliders that no theme can inflate

On a phone (SillyTavern 1.19 + a custom theme) range inputs in the settings
tab still render as tall native bars despite the compact class. Replace every
slider (settings tab and the ⚙ sheet) with a themed control: a `div` track
(4 px, rounded, filled part in the accent colour via `--st-echo-fill`) and a
knob `div` (18 px), with the real `<input type="range">` stretched over the
track, `opacity: 0`, full width, 28 px tall (keeps keyboard, screen readers and
touch dragging). Row height ≤ 32 px plus the label line. Value text stays at
the right of the label. The input keeps all `data-*` attributes the tests use.

### 19.2 Explain the size controls

In «Внешний вид» and in the ⚙ sheet, one short hint line under each of:
«Масштаб» — «вся панель целиком»; «Размер текста» — «только шрифт»;
«Размер чипов» — «высота слов-чипов и кнопок рядом»; «Отступы» — «воздух между
элементами». English equivalents. Order in the settings group: Масштаб,
Размер текста, Размер чипов, Отступы, then Непрозрачность, Размытие,
Скругление, Ширина панели (desktop only), then colours, background, buttons.

### 19.3 Phone layout like Sable Trackers

New `visual.phoneFull` (default `false`). When `false`, on screens under
700 px the panel behaves like Sable Trackers: width = `max(320px, widthVw)`,
anchored right, the page stays visible behind it, tap outside closes. When
`true`, the current full-width behaviour. Switch «На весь экран на телефоне»
in the ⚙ sheet (after «Чипы слов сразу») and in the settings. Desktop is
unchanged (clamp 420 px … widthVw/2).

### 19.4 Regex list refresh

Scripts written to `extension_settings.regex` or to the card do not appear in
SillyTavern's Regex panel until the page is reloaded (the panel renders its
list on load). After a successful install, the ban editor shows a one-line
note «Появится в списке регексов после перезагрузки страницы» for 6 s; the
README says the same. Additionally emit
`ctx.eventSource.emit(ctx.eventTypes.SETTINGS_UPDATED)` after a global write
when that event type exists (harmless if nothing listens).

### 19.5 Housekeeping

README: the §19.3 switch, the regex-list note, and a sentence that the Jeved
extension is not required by Echo. Bump the version to 0.4.0.

## 20. Round 6 (2 Oct 2026, after v0.4.0)

### 20.1 Pin, as in Sable Trackers

New top-level `settings.pinned` (boolean, default `false`, normalized with
the other booleans, saved with the settings; global, not per character —
exactly like `pinned` in Sable Trackers). The drawer header gets a pin button
between ⟳ and ⚙, so the order is the Sable Trackers order: ⟳ rescan, 📌 pin,
⚙ view, ✕ close. The button: `data-act="pin"`, `aria-pressed` = the setting,
label «Закрепить» / "Pin" as `title` and `aria-label` in both states (the
pressed look carries the state). The glyph is a thumbtack drawn in the
existing 24-grid stroke style of `ICONS` (no emoji, no icon font). A tap calls
`runtime.updateSettings({ pinned: !pinned })`; the pressed state is rendered
from `snap.settings.pinned`, so it survives a page reload.

Behaviour. **Unpinned:** a `pointerdown` outside the panel — not on the edge
tab and not on the wand-menu entry — closes the panel on every screen size, as
in Sable Trackers. This replaces the phone-only rule of §19.3 (desktop used to
stay open). **Pinned:** an outside tap never closes the panel, at any size; the
user can type in the chat while reading the panel. Everything else still
closes it: ✕, the edge tab, Escape (a key press is deliberate), `api.close()`.
The «Оставить ▾» menu and the ⚙ sheet keep closing on an outside tap whether
pinned or not. The full-width phone layout (`visual.phoneFull`) is unaffected
(nothing is outside it). The pin is not repeated in the settings tab or in the
⚙ sheet — the header is its only place, as in Sable Trackers.

Pressed look: `.st-echo-ib[aria-pressed="true"]` uses the same accent fill as
`.st-echo-tog[aria-pressed="true"]` (accent background, accent ink). No
animation.

### 20.2 Housekeeping

README (English part and the Russian summary): one sentence on the pin next to
the phone-layout paragraph, and the tap-outside sentence now reads «on every
screen size unless pinned». `docs/mockup.html` is not updated (this section
overrides it). Re-shoot the screenshots that show the header. Version 0.5.0.
