# Review of v0.1.0 (read-only, 1 Oct 2026)

Findings from an independent code review of the first build; fixes are tracked in TASKS.md.

Found **1 blocker and 9 bugs** despite all **145 tests passing**. Read-only review; no files changed. SPEC §16 excluded.

1. **Severity:** blocker  
   **Where:** `src/regex.js:8`  
   **What:** “Both” sets `markdownOnly` and `promptOnly` to false. SillyTavern interprets this as source replacement, not two non-destructive filters. Its `script.js:6422` applies these scripts before storing generated text; existing history also bypasses the display/prompt-only paths. This contradicts README’s “do not edit stored message text.”  
   **Trigger:** Enable a ban’s regex in “both” mode, then generate a matching reply or edit one.  
   **Fix:** Set **both flags true** for “both”; retain the individual flags for the other modes. Update the test currently asserting the incorrect mapping.

2. **Severity:** bug  
   **Where:** `src/run.js:184`, `src/run.js:145`  
   **What:** Swiping or continuing does not invalidate the previous score immediately. It disappears only after a successful replacement request. Short/OOC swipes, disabled Jev, and request failures leave old scores and pattern counts indefinitely; examples can come from the new text while scores describe the old text.  
   **Trigger:** Score a long reply, then select a short swipe. Reproduced: the original `repeats: 4` remains. Older-message swipes additionally have their replacement answers rejected by `identity(latest())`.  
   **Fix:** Reconcile stored entries against current message eligibility, hash and swipe before rendering/scoring; repeat on chat load. For historical swipes, validate the target identity rather than requiring it to be latest.

3. **Severity:** bug  
   **Where:** `src/run.js:187`  
   **What:** Deletion handling assumes tail truncation. SillyTavern’s `deleteMessage()` also removes individual middle messages using `splice`, then emits the new length. Later indexes shift, but Echo retains their old indexes and drops the former last score.  
   **Trigger:** Delete a message before scored replies. Reproduced: a retained score’s hash no longer matches `chat[mesId]`.  
   **Fix:** Reconcile identities after deletion; minimally discard mismatched entries instead of merely trimming by length.

4. **Severity:** bug  
   **Where:** `src/run.js:186`  
   **What:** Overswiping to generate a new variant sends the previous text to Jev under the new swipe ID. SillyTavern increments `swipe_id`, retains `mes`, and emits `MESSAGE_SWIPED` **before** calling `Generate('swipe')`. Completion then causes another request.  
   **Trigger:** Swipe right beyond the last available variant. Reproduced two requests: original text, then regenerated text.  
   **Fix:** Skip scoring when `swipe_id >= swipes.length`; wait for `CHARACTER_MESSAGE_RENDERED`. Still invalidate the outgoing score immediately.

5. **Severity:** bug  
   **Where:** `src/ui/drawer.js:307`, `src/ui/drawer.js:881`  
   **What:** Undo callbacks survive character switches and operate on whichever character is current. UI state is never reset or scoped on `chatId`/`avatar` changes.  
   **Trigger:** Mark phrase X intentional for A, switch within four seconds to B where X was already intentional, then press Undo. B’s decision is removed.  
   **Fix:** Clear toasts and character-specific drafts on identity changes; guard asynchronous action completions and undo callbacks with their originating avatar/chat.

6. **Severity:** bug  
   **Where:** `src/miner.js:134`  
   **What:** Stemming normalizes `ё` to `е`, but the generated regex matches raw text and cannot reverse that normalization. A regex can fail to match its own source phrase.  
   **Trigger:** Ban `ёжик`. Generated pattern contains `ежик`; reproduced match count against `ёжик`: **0**.  
   **Fix:** Expand normalized stem `е` characters into `[её]` when building the pattern.

7. **Severity:** bug  
   **Where:** `src/miner.js:50`  
   **What:** Cleaning removes legitimate content. The footer rule deletes everything after a horizontal rule if **any** later character is pictographic, rather than requiring tracker-like emoji lines. The first-line rule also deletes ordinary Markdown table headers containing three pipes.  
   **Trigger:** `Opening.\n---\nOrdinary scene continues.\nSomeone smiles 🙂.\nClosing.` becomes only `Opening.`  
   **Fix:** Restrict footer removal to an anchored trailing tracker block; recognize a tracker-header format instead of using pipe count alone.

8. **Severity:** bug  
   **Where:** `src/run.js:201`, `src/bans.js:70`  
   **What:** Temporary dismissals can become permanent. Expiry is `mined.mined + 10`, but `mined.mined` saturates at the configured window, normally 60. Manual rescan does not clear them either, contrary to the toast.  
   **Trigger:** Hide a candidate after 60 eligible replies. Its expiry becomes 70, which subsequent rescans never reach. Reproduced after another 20 replies.  
   **Fix:** Use an uncapped, appropriately chat-scoped progress counter; make explicit rescan expiry agree with the displayed promise.

9. **Severity:** bug  
   **Where:** `src/run.js:66`  
   **What:** “Seen again” mixes incompatible populations: the denominator includes all subsequent narrator messages, while the numerator scans only the current eligible mining window. It also uses candidate-overlap suppression as a match test, so two shared content stems can count as the whole banned phrase. `sinceIndex` persists across chats despite being a chat-local index.  
   **Trigger:** Ban in a long chat, open a shorter chat with the same character; counters stay zero until indexes exceed the old chat’s ban position.  
   **Fix:** Store the originating chat identity, define a per-chat baseline, and count actual pattern matches over the same population used by the denominator.

10. **Severity:** bug  
    **Where:** `src/store.js:21`  
    **What:** The delayed-save guard compares metadata against the captured context object. Real `getContext()` returns a fresh snapshot; its old `chatMetadata` property remains unchanged after switching. Meanwhile, `saveMetadata()` saves the globally current chat. The fake’s mutable context masks this.  
    **Trigger:** Switch chats within 300 ms of a score update. Reproduced with snapshot-style contexts: A’s pending callback saves B.  
    **Fix:** Compare against freshly obtained context and chat identity when the timer fires; cancel obsolete timers on switch/dispose.

Verified as correct:

- Normal render, swipe and UI-edit events carry numeric indexes, not message objects; deletion fires after mutation.
- Greetings, completed continues and group replies emit render events; Echo suppresses group scoring/actions.
- The local host keeps the chat array reference stable using `splice`; metadata and scalar context fields require refreshing, which `CHAT_CHANGED` does.
- Injection is published on initialization and chat change, cleared when disabled, and uses the correct in-chat/system arguments; depth 1 is sensible for chat completion.
- `writeExtensionField` immediately requests card persistence and accepts numeric or string indexes; Echo guards missing characters.
- Scoped-script merging preserves unrelated scripts; avatar opt-in, placement `[2]`, substitution mode, trim array and null depth bounds are correct.
- Prompt-only and display-only flags match host semantics; slash-form patterns and lookbehind are accepted by its regex parser.
- No direct writes to message text/extra or unrelated extension settings; exception: the indirect “both” transformation above.
- Settings sliders and metadata saves are debounced; ordinary renders do not persist settings.
- UI uses text nodes, preserves ordinary editing focus/scroll, and removes listeners/menu entries on unmount; localization checks found no missing used keys.
- CSS provides mobile width/wrapping and enlarged tap areas; Android keyboard behavior was not device-tested.
- Synthetic 500-message benchmark: approximately 13 ms cold and 1 ms cached for `report()`; runtime mining also invalidates middle edits correctly.
