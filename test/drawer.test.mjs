import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountDrawer, trimWords, visualVars, levelOf, inkFor, panelWidth, CHIP_SIZES, chipPx } from '../src/ui/drawer.js';
import { t as translate, STRINGS } from '../src/i18n.js';
import { createFakeRuntime, snapshotFor, fakeBlock, METHODS } from './fakes/runtime.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/snapshot.json', import.meta.url), 'utf8'));
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const FIRST = fixture.candidates[0].key;            // «уголки губ дрогнули в подобии улыбки»
const SECOND = fixture.candidates[1];               // «тишина повисла в воздухе»
const ALT_BAN = fixture.bans[0];                    // phrase with an alternative and a regex
const XSS = '<img src=x onerror="globalThis.pwned=1">';

function setup(t, { state = 'full', patch = {}, options = {}, open = true, runtime: wrap } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="extensionsMenu"></div></body>', { pretendToBeVisual: true });
  const { document } = dom.window;
  const runtime = createFakeRuntime({ ...snapshotFor(fixture, state), ...structuredClone(patch) });
  wrap?.(runtime);
  const timers = [];
  if (options.manualTimers) {
    // The toast timer runs on the drawer's window; a manual queue makes the 4 s observable.
    dom.window.setTimeout = (fn, ms) => timers.push({ fn, ms });
    dom.window.clearTimeout = () => {};
  }
  const ui = mountDrawer(runtime, { document, ...options });
  if (open) ui.open();
  t.after(() => { ui.unmount(); dom.window.close(); });
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const act = (name, index = 0, root = document) => {
    const element = root.querySelectorAll(`[data-act="${name}"]`)[index];
    assert.ok(element, `no [data-act="${name}"] #${index}`);
    element.click();
    return element;
  };
  const row = key => $$('.st-echo-cand').find(element => element.dataset.key === `c:${key}`);
  const chips = key => [...row(key).querySelectorAll('.st-echo-w')];
  const type = (field, value) => { field.value = value; field.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const press = (field, key) => field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const change = (field, value) => { field.value = value; field.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  const text = selector => $(selector)?.textContent ?? '';
  return { dom, document, runtime, ui, timers, $, $$, act, row, chips, type, press, change, text };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('fake runtime spies every method and re-emits after each call', async () => {
  const runtime = createFakeRuntime(fixture);
  const seen = [];
  const stop = runtime.subscribe(snap => seen.push(snap.bans.length));
  assert.deepEqual(seen, [3]);
  for (const name of METHODS) assert.equal(typeof runtime[name], 'function', name);
  const id = await runtime.ban(FIRST, [5]);
  assert.match(id, /^b_[0-9a-f]{8}$/);
  assert.deepEqual(runtime.callsOf('ban'), [[FIRST, [5]]]);
  assert.deepEqual(seen, [3, 4]);
  assert.equal(runtime.snapshot().bans.at(-1).text, 'уголки губ дрогнули в подобии');
  await runtime.unban(id);
  assert.ok(runtime.snapshot().candidates.some(item => item.key === FIRST), 'unban brings the candidate back');
  stop();
  assert.deepEqual(seen, [3, 4, 3]);
  await runtime.rescan();
  assert.equal(seen.length, 3, 'no emits after unsubscribe');
  assert.equal(runtime.preview().text, fakeBlock(runtime.snapshot()).text);
});

test('the edge tab, the menu entry and ✕ open and close the panel', t => {
  const { ui, $, act, document, dom } = setup(t, { open: false });
  const tab = $('.st-echo-tab');
  assert.equal(ui.element.hidden, true);
  assert.equal(tab.getAttribute('aria-expanded'), 'false');
  assert.equal(tab.getAttribute('aria-label'), 'Открыть Эхо');
  tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }));  // a tap, not Enter
  assert.equal(ui.element.hidden, false);
  assert.equal(tab.getAttribute('aria-expanded'), 'true');
  assert.notEqual(document.activeElement, $('[data-act="close"]'), 'pointer opens do not move focus');
  act('close');
  assert.equal(ui.element.hidden, true);
  const entry = $('#extensionsMenu .st-echo-menu-entry');
  assert.equal(entry.textContent, 'Эхо');
  entry.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(ui.element.hidden, false);
  assert.equal(document.activeElement, $('[data-act="close"]'), 'keyboard opens focus the panel');
});

test('word chips by default: chips, «→ result» after a cut, count line, «В бан» + «Оставить ▾», no «Обрезать»', t => {
  const { $, $$, row, chips, act, text } = setup(t);
  const first = row(FIRST);
  assert.deepEqual(chips(FIRST).map(chip => chip.textContent), ['уголки', 'губ', 'дрогнули', 'в', 'подобии', 'улыбки']);
  assert.equal(first.querySelector('.st-echo-cand-text'), null, 'the chips are the phrase');
  assert.equal(first.querySelector('[data-act="trim"]'), null, 'no «Обрезать» link');
  assert.ok(first.querySelector('[data-act="edit"]'), '✎ stays next to the chips');
  assert.equal(first.querySelector('.st-echo-meta').textContent, '9 из 60 ответов·примеры');
  assert.equal(first.querySelector('[data-act="ban"]').textContent, 'В бан');
  assert.match(first.querySelector('[data-act="keep"]').textContent, /Оставить/);
  assert.ok(first.querySelector('.st-echo-acts').classList.contains('st-echo-two'));
  assert.equal(first.querySelector('.st-echo-result'), null, 'no result line before a cut');
  assert.equal($$('[data-card="cands"] .st-echo-hint').length, 1, 'the cut hint is said once');
  assert.match(text('[data-card="cands"] .st-echo-hint'), /Нажмите на слово, чтобы убрать его из фразы/);
  chips(FIRST)[5].click();
  assert.equal(chips(FIRST)[5].getAttribute('aria-pressed'), 'true');
  assert.ok(chips(FIRST)[5].classList.contains('st-echo-cut'));
  assert.equal(row(FIRST).querySelector('.st-echo-res').textContent, 'уголки губ дрогнули в подобии');
  assert.deepEqual([...row(FIRST).children].map(node => node.classList[0]), ['st-echo-trim', 'st-echo-result', 'st-echo-meta', 'st-echo-acts']);
  chips(FIRST)[5].click();
  assert.equal(row(FIRST).querySelector('.st-echo-result'), null, 'tapping again brings the word back');
  assert.equal($$('.st-echo-cand:not(.st-echo-opener)').length, 5);
  act('more');
  assert.equal($$('.st-echo-cand:not(.st-echo-opener)').length, 8);
  assert.equal($$('.st-echo-opener .st-echo-w').length, 0, 'openers stay text');
});

const COLLAPSED = { settings: { candidates: 'collapsed' } };

test('collapsed mode keeps §13.1: phrase, count line, «В бан», «Оставить ▾», «Обрезать»', t => {
  const { $, $$, row, act } = setup(t, { patch: COLLAPSED });
  const first = row(FIRST);
  assert.equal(first.querySelector('.st-echo-cand-text').textContent, 'уголки губ дрогнули в подобии улыбки');
  assert.equal(first.querySelectorAll('.st-echo-w').length, 0, 'no word chips until «Обрезать»');
  assert.equal(first.querySelector('.st-echo-result'), null);
  assert.match(first.querySelector('.st-echo-meta').textContent, /9 из 60 ответов/);
  assert.equal(first.querySelector('[data-act="ban"]').textContent, 'В бан');
  assert.match(first.querySelector('[data-act="keep"]').textContent, /Оставить/);
  assert.equal(first.querySelector('[data-act="trim"]').textContent, 'Обрезать');
  // Five rows, then «Ещё N»; openers have their own group.
  assert.equal($$('.st-echo-cand:not(.st-echo-opener)').length, 5);
  assert.equal($('[data-act="more"]').textContent, 'Ещё 3');
  act('more');
  assert.equal($$('.st-echo-cand:not(.st-echo-opener)').length, 8);
  assert.equal($('[data-act="more"]').textContent, 'Свернуть');
  assert.equal($('.st-echo-grp').textContent, 'Зачины · начало ответа');
  assert.equal($$('.st-echo-opener').length, 2);
  assert.equal($('[data-card="cands"] .st-echo-pill').textContent, '10');
});

test('collapsed: «Обрезать» shows the word chips; tapping a word cuts it and the result line appears', t => {
  const { row, chips, text } = setup(t, { patch: COLLAPSED });
  row(FIRST).querySelector('[data-act="trim"]').click();
  assert.deepEqual(chips(FIRST).map(chip => chip.textContent), ['уголки', 'губ', 'дрогнули', 'в', 'подобии', 'улыбки']);
  assert.equal(row(FIRST).querySelector('[data-act="trim"]').textContent, 'Готово');
  assert.match(text('.st-echo-hint'), /Нажмите на слово, чтобы убрать его из фразы/);
  assert.equal(row(FIRST).querySelector('.st-echo-result'), null, 'no result line before a cut');
  chips(FIRST)[5].click();
  assert.equal(chips(FIRST)[5].getAttribute('aria-pressed'), 'true');
  assert.ok(chips(FIRST)[5].classList.contains('st-echo-cut'));
  assert.equal(row(FIRST).querySelector('.st-echo-res').textContent, 'уголки губ дрогнули в подобии');
  chips(FIRST)[5].click();
  assert.equal(row(FIRST).querySelector('.st-echo-result'), null, 'tapping again brings the word back');
});

test('a middle cut shows «…»; cutting every word disables «В бан»', t => {
  const { row, chips } = setup(t);
  chips(FIRST)[3].click();
  chips(FIRST)[4].click();
  assert.equal(row(FIRST).querySelector('.st-echo-res').textContent, 'уголки губ дрогнули … улыбки');
  for (const index of [0, 1, 2, 5]) chips(FIRST)[index].click();
  assert.equal(row(FIRST).querySelector('.st-echo-res').textContent, 'ничего не осталось');
  assert.equal(row(FIRST).querySelector('[data-act="ban"]').disabled, true);
});

test('collapsed: cut state and the open trimmer survive re-renders, folding the trimmer and rescans', t => {
  const { row, chips, runtime } = setup(t, { patch: COLLAPSED });
  row(FIRST).querySelector('[data-act="trim"]').click();
  chips(FIRST)[0].click();
  const node = row(FIRST);
  runtime.emit();
  runtime.set({ mined: 61 });
  assert.equal(row(FIRST), node, 'the row is patched in place');
  assert.equal(chips(FIRST)[0].getAttribute('aria-pressed'), 'true');
  row(FIRST).querySelector('[data-act="trim"]').click();
  assert.equal(chips(FIRST).length, 0);
  assert.equal(row(FIRST).querySelector('.st-echo-res').textContent, 'губ дрогнули в подобии улыбки', 'the result stays while folded');
  assert.match(row(FIRST).querySelector('.st-echo-meta').textContent, /9 из 61 ответа/);
});

test('«В бан» calls runtime.ban(key, cuts) and shows the undo toast; «Отменить» calls unban', async t => {
  const { row, chips, runtime, $, act } = setup(t);
  chips(FIRST)[5].click();
  chips(FIRST)[4].click();
  row(FIRST).querySelector('[data-act="ban"]').click();
  assert.deepEqual(runtime.callsOf('ban'), [[FIRST, [4, 5]]]);
  await flush();
  assert.equal(row(FIRST), undefined, 'the candidate left the list');
  const toast = $('.st-echo-toast');
  assert.equal(toast.getAttribute('role'), 'status');
  assert.match(toast.textContent, /^Добавлено в бан·Отменить$/);
  assert.equal(toast.querySelectorAll('button').length, 1, 'only undo, no alternative offer');
  const id = runtime.snapshot().bans.at(-1).id;
  act('toast-undo');
  assert.deepEqual(runtime.callsOf('unban'), [[id]]);
  assert.equal($('.st-echo-toast'), null);
  assert.ok(row(FIRST), 'undo brings the candidate back');
  assert.deepEqual(chips(FIRST).map(chip => chip.getAttribute('aria-pressed')), ['false', 'false', 'false', 'false', 'true', 'true']);
  assert.equal(row(FIRST).querySelector('.st-echo-res').textContent, 'уголки губ дрогнули в', 'cuts are kept for another try');
});

test('a character or chat switch closes the toast and drops drafts; undo can no longer touch the new character', async t => {
  const { $, $$, runtime, row, chips, act } = setup(t);
  const phrase = SECOND.words.join(' ');
  row(SECOND.key).querySelector('[data-act="keep"]').click();
  act('intentional');
  await flush();
  const undo = $('[data-act="toast-undo"]');
  assert.ok(undo, 'undo is offered for the first character');
  chips(FIRST)[0].click();
  $$('.st-echo-bt')[0].click();
  $('[data-act="rx"]').click();
  row(FIRST).querySelector('[data-act="keep"]').click();
  assert.ok($('.st-echo-bed') && $('[role="menu"]') && row(FIRST).querySelector('.st-echo-result'));
  // Within the four seconds: another character, where the same phrase was already intentional.
  runtime.set({ avatar: 'second-guide.png', chatId: 'chat-second', characterName: 'Второй', intentional: [phrase] });
  assert.equal($('.st-echo-toast'), null, 'the toast closed');
  undo.click();
  assert.deepEqual(runtime.callsOf('unmarkIntentional'), [], 'no undo ran');
  assert.deepEqual(runtime.snapshot().intentional, [phrase], "the second character's decision stays");
  assert.equal(chips(FIRST)[0].getAttribute('aria-pressed'), 'false', 'cuts are dropped');
  assert.equal(row(FIRST).querySelector('.st-echo-result'), null);
  assert.equal($('.st-echo-bed'), null, 'the ban editor closed');
  assert.equal($('[role="menu"]'), null, 'the menu closed');
  // A new chat of the same character is a switch too.
  row(FIRST).querySelector('[data-act="ban"]').click();
  await flush();
  assert.ok($('.st-echo-toast'));
  runtime.set({ chatId: 'chat-third' });
  assert.equal($('.st-echo-toast'), null);
});

test('an action still in flight when the character changes offers no undo afterwards', async t => {
  let release;
  const { $, runtime, row, act } = setup(t, { runtime: fake => {
    const original = fake.markIntentional;
    fake.markIntentional = (...args) => new Promise(resolve => { release = () => resolve(original(...args)); });
  } });
  row(SECOND.key).querySelector('[data-act="keep"]').click();
  act('intentional');
  runtime.set({ avatar: 'second-guide.png', chatId: 'chat-second' });
  release();
  await flush();
  assert.deepEqual(runtime.callsOf('markIntentional'), [[SECOND.words.join(' ')]]);
  assert.equal($('.st-echo-toast'), null, 'no toast, so no undo for the wrong character');
});

test('the undo toast hides after 4 s', async t => {
  const { timers, $, act } = setup(t, { options: { manualTimers: true } });
  act('ban-opener');
  await flush();
  assert.ok($('.st-echo-toast'));
  const timer = timers.find(item => item.ms === 4000);
  assert.ok(timer, 'a 4000 ms timer');
  timer.fn();
  assert.equal($('.st-echo-toast'), null);
});

test('the undo toast finds the new ban even when the runtime resolves to nothing', async t => {
  const { runtime, act } = setup(t, { runtime: fake => {
    const original = fake.banPattern;
    fake.banPattern = (...args) => original(...args).then(() => undefined);
  } });
  act('ban-pattern');
  await flush();
  const id = runtime.snapshot().bans.at(-1).id;
  act('toast-undo');
  assert.deepEqual(runtime.callsOf('unban'), [[id]]);
});

test('«Оставить ▾» opens a menu: «Это намеренно» → markIntentional, «Скрыть пока» → hide, both undoable', async t => {
  const { row, runtime, $, act, document } = setup(t);
  const keep = row(SECOND.key).querySelector('[data-act="keep"]');
  keep.click();
  assert.equal(keep.getAttribute('aria-expanded'), 'true');
  const items = [...row(SECOND.key).querySelectorAll('[role="menuitem"]')].map(item => item.textContent);
  assert.deepEqual(items, ['Это намеренно', 'Скрыть пока']);
  document.body.dispatchEvent(new document.defaultView.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(row(SECOND.key).querySelector('[role="menu"]'), null, 'a tap outside closes the menu');
  keep.click();
  act('intentional');
  assert.deepEqual(runtime.callsOf('markIntentional'), [['тишина повисла в воздухе']]);
  await flush();
  assert.match($('.st-echo-toast').textContent, /Отмечено как намеренное/);
  act('toast-undo');
  assert.deepEqual(runtime.callsOf('unmarkIntentional'), [['тишина повисла в воздухе']]);
  row(SECOND.key).querySelector('[data-act="keep"]').click();
  act('hide');
  assert.deepEqual(runtime.callsOf('hide'), [['тишина повисла в воздухе']]);
  await flush();
  assert.match($('.st-echo-toast').textContent, /Скрыто до пересчёта/);
  act('toast-undo');
  assert.deepEqual(runtime.callsOf('unhide'), [['тишина повисла в воздухе']]);
});

test('openers: «В бан» → banOpener, «Оставить» uses the opener text', t => {
  const { $$, runtime } = setup(t);
  const opener = $$('.st-echo-opener')[0];
  assert.equal(opener.querySelector('.st-echo-cand-text').textContent, 'Он медленно поднял взгляд…');
  assert.equal(opener.querySelector('[data-act="trim"]'), null);
  opener.querySelector('[data-act="keep"]').click();
  opener.querySelector('[data-act="hide"]').click();
  assert.deepEqual(runtime.callsOf('hide'), [['Он медленно поднял взгляд…']]);
  $$('.st-echo-opener')[0].querySelector('[data-act="ban-opener"]').click();
  assert.deepEqual(runtime.callsOf('banOpener'), [['тишин']]);
});

test('examples toggle with the phrase highlighted', t => {
  const { row } = setup(t);
  const link = row(FIRST).querySelector('[data-act="examples"]');
  assert.equal(link.textContent, 'примеры');
  link.click();
  const box = row(FIRST).querySelector('.st-echo-exs');
  assert.equal(box.querySelectorAll('p').length, 2);
  assert.equal(box.querySelector('p').textContent, '«Он отвёл глаза, и уголки губ дрогнули в подобии улыбки.»');
  assert.equal(box.querySelector('mark').textContent, 'уголки губ дрогнули в подобии улыбки');
  assert.equal(link.getAttribute('aria-expanded'), 'true');
  link.click();
  assert.equal(row(FIRST).querySelector('.st-echo-exs'), null);
});

test('✎ opens a text field with the trimmed phrase; Enter → banText', async t => {
  const { row, chips, runtime, type, press, document, $ } = setup(t);
  chips(FIRST)[5].click();
  row(FIRST).querySelector('[data-act="edit"]').click();
  const field = row(FIRST).querySelector('input');
  assert.equal(document.activeElement, field);
  assert.equal(field.value, 'уголки губ дрогнули в подобии');
  type(field, '  уголки губ дрогнули  ');
  press(field, 'Enter');
  assert.deepEqual(runtime.callsOf('banText'), [['уголки губ дрогнули']]);
  await flush();
  assert.match($('.st-echo-toast').textContent, /Добавлено в бан/);
  assert.equal(row(FIRST).querySelector('input'), null);
});

test('Escape leaves the text field without banning', t => {
  const { row, runtime, press } = setup(t);
  row(FIRST).querySelector('[data-act="edit"]').click();
  press(row(FIRST).querySelector('input'), 'Escape');
  assert.equal(row(FIRST).querySelector('input'), null);
  assert.equal(runtime.callsOf('banText').length, 0);
  assert.equal(row(FIRST).querySelectorAll('.st-echo-w').length, 6, 'back to the chips');
});

test('a focused field keeps its node, value and focus across re-renders; the scroller is kept', t => {
  const { row, runtime, type, document, $ } = setup(t);
  const scroller = $('.st-echo-scroll');
  row(FIRST).querySelector('[data-act="edit"]').click();
  const field = row(FIRST).querySelector('input');
  type(field, 'half-typed');
  const [first, second, ...rest] = fixture.candidates;
  runtime.set({ mined: 62, candidates: [second, first, ...rest] });
  assert.equal($('.st-echo-cand').dataset.key, `c:${second.key}`, 'the rows were reordered');
  assert.equal(row(FIRST).querySelector('input'), field);
  assert.equal(field.value, 'half-typed');
  assert.equal(document.activeElement, field);
  assert.equal($('.st-echo-scroll'), scroller);
  field.blur();
  runtime.emit();
  assert.equal(row(FIRST).querySelector('input').value, 'half-typed', 'the draft lives in UI state');
});

test('a ban chip opens the editor; the alternative saves via setAlt', t => {
  const { $, $$, runtime, type, press } = setup(t);
  assert.equal($$('.st-echo-bchip').length, 3);
  assert.equal($('.st-echo-bed'), null, 'no editor until a chip is tapped');
  const chip = $$('.st-echo-bt')[0];
  chip.click();
  assert.equal(chip.getAttribute('aria-expanded'), 'true');
  assert.match($('.st-echo-bed').textContent, /«сердце пропустило удар»/);
  assert.equal($('.st-echo-bed-l').textContent, 'Что писать вместо?');
  const field = $('#st-echo-alt');
  assert.equal(field.value, 'дыхание сбилось');
  type(field, 'сердце ухнуло вниз');
  $('[data-act="alt-ok"]').click();
  assert.deepEqual(runtime.callsOf('setAlt'), [[ALT_BAN.id, 'сердце ухнуло вниз']]);
  assert.match($('.st-echo-saved').textContent, /сохранено: сердце ухнуло вниз/);
  type($('#st-echo-alt'), 'пауза');
  press($('#st-echo-alt'), 'Enter');
  assert.deepEqual(runtime.callsOf('setAlt')[1], [ALT_BAN.id, 'пауза']);
  $('[data-act="alt-close"]').click();
  assert.equal($('.st-echo-bed'), null);
});

test('«Предложить» fills three suggestion chips; a tap puts one into the field', async t => {
  const { $, $$, runtime } = setup(t);
  $$('.st-echo-bt')[0].click();
  $('[data-act="suggest"]').click();
  assert.deepEqual(runtime.callsOf('suggestAlt'), [[ALT_BAN.id]]);
  await flush();
  assert.deepEqual($$('.st-echo-sg').map(item => item.textContent), ['дыхание сбилось', 'пальцы сжались сами собой', 'он ничего не сказал']);
  $$('.st-echo-sg')[1].click();
  assert.equal($('#st-echo-alt').value, 'пальцы сжались сами собой');
});

test('«Предложить» is hidden without a connection profile (snapshot.altProfile)', t => {
  const { $, $$ } = setup(t, { patch: { altProfile: false } });
  $$('.st-echo-bt')[0].click();
  assert.ok($('.st-echo-bed'));
  assert.equal($('[data-act="suggest"]'), null);
});

test('the regex sub-row shows the pattern and match count; mode select and toggle call setRegex', t => {
  const { $, $$, runtime, change } = setup(t);
  $$('.st-echo-bt')[0].click();
  const fold = $('[data-act="rx"]');
  assert.match(fold.textContent, /Регекс\s*вкл/);
  assert.equal($('.st-echo-rx'), null, 'folded by default');
  fold.click();
  assert.equal($('.st-echo-rx').textContent, ALT_BAN.findRegex);
  assert.match($('.st-echo-rx-b').textContent, /совпадений в последних 60: 5/);
  const select = $('.st-echo-rx-b select');
  assert.equal(select.value, 'prompt');
  assert.deepEqual([...select.options].map(option => option.textContent), ['только для модели', 'только на экране', 'везде']);
  change(select, 'both');
  assert.deepEqual(runtime.callsOf('setRegex'), [[ALT_BAN.id, true, 'both']]);
  const install = $('[data-act="rx-install"]');
  assert.equal(install.getAttribute('aria-pressed'), 'true');
  assert.equal(install.textContent, 'в регексы персонажа');
  install.click();
  assert.deepEqual(runtime.callsOf('setRegex')[1], [ALT_BAN.id, false, 'both']);
  assert.equal($('[data-act="rx-install"]').getAttribute('aria-pressed'), 'false');
});

test('«Где хранить» in the ban editor: setRegex(id, regex, mode, scope), the hint, «глоб.» while regex is on', t => {
  const { $, $$, runtime, change } = setup(t);
  $$('.st-echo-bt')[0].click();
  $('[data-act="rx"]').click();
  const [mode, scope] = $$('.st-echo-rx-b select');
  assert.equal(mode.closest('label').textContent.startsWith('Где действует'), true);
  assert.equal(scope.closest('label').querySelector('.st-echo-rx-l').textContent, 'Где хранить');
  assert.equal(mode.closest('label').nextElementSibling, scope.closest('label'), 'next to the mode');
  assert.deepEqual([...scope.options].map(option => [option.value, option.textContent]), [['character', 'у персонажа'], ['global', 'глобально']]);
  assert.equal(scope.value, 'character');
  assert.match($('.st-echo-rx-b').textContent, /У персонажа: внутри карточки, едет вместе с ней\. Глобально: в списке регексов таверны, для всех чатов\./);
  assert.equal($('.st-echo-m-glob'), null);
  change(scope, 'global');
  assert.deepEqual(runtime.callsOf('setRegex'), [[ALT_BAN.id, true, 'prompt', 'global']]);
  assert.equal($$('.st-echo-rx-b select')[1].value, 'global');
  const mark = $$('.st-echo-bchip')[0].querySelector('.st-echo-m-glob');
  assert.equal(mark.textContent, 'глоб.');
  assert.equal(mark.getAttribute('title'), 'глобальный регекс');
  assert.equal($('[data-act="rx-install"]').textContent, 'в глобальные регексы');
  $('[data-act="rx-install"]').click();
  assert.deepEqual(runtime.callsOf('setRegex')[1], [ALT_BAN.id, false, 'prompt']);
  assert.equal($('.st-echo-m-glob'), null, 'the mark needs the regex on');
  change($$('.st-echo-rx-b select')[1], 'character');
  assert.deepEqual(runtime.callsOf('setRegex')[2], [ALT_BAN.id, false, 'prompt', 'character']);
});

test('ban rows show «глоб.» for a global regex too', t => {
  const extra = [1, 2, 3].map(index => ({ ...fixture.bans[1], id: `b_0000000${index}`, text: `фраза ${index}`, seenAfter: 0 }));
  const global = { ...fixture.bans[0], regexScope: 'global' };
  const { $$ } = setup(t, { patch: { bans: [global, ...fixture.bans.slice(1), ...extra] } });
  const rows = $$('.st-echo-brow');
  assert.equal(rows.length, 6);
  assert.equal(rows[0].querySelector('.st-echo-m-glob').textContent, 'глоб.');
  assert.equal(rows.slice(1).some(row => row.querySelector('.st-echo-m-glob')), false);
});

test('regex controls are disabled while saving and in group chats; patterns get no regex', t => {
  const { $, $$, runtime } = setup(t, { patch: { busy: { rescan: false, alternatives: null, regex: ALT_BAN.id } } });
  $$('.st-echo-bt')[0].click();
  $('[data-act="rx"]').click();
  assert.equal($('[data-act="rx-install"]').disabled, true);
  assert.equal($('[data-act="rx-install"]').textContent, 'сохраняю…');
  assert.ok($$('.st-echo-rx-b select').every(select => select.disabled), 'mode and scope wait for the save');
  runtime.set({ busy: { rescan: false, alternatives: null, regex: null }, groupChat: true });
  assert.ok(!$('.st-echo-bed'), 'group chats show only the hint');
  assert.match($('.st-echo-scroll').textContent, /В групповых чатах Эхо пока не работает/);
  runtime.set({ groupChat: false });
  $$('.st-echo-bt')[2].click();
  assert.match($('.st-echo-bed').textContent, /Для приёмов регекс не строится/);
  assert.equal($('[data-act="rx"]'), null);
});

test('«в промпт» → setInject; the accent bar class follows the toggle', t => {
  const { $, runtime } = setup(t);
  const card = $('[data-card="bans"]');
  assert.ok(card.classList.contains('st-echo-on'));
  assert.equal($('[data-act="inject"]').textContent, 'в промпт');
  assert.equal($('.st-echo-caption').textContent, 'Действует на следующие ответы. Старые не меняются.');
  $('[data-act="inject"]').click();
  assert.deepEqual(runtime.callsOf('setInject'), [[false]]);
  assert.ok(card.classList.contains('st-echo-off'));
  assert.equal($('[data-act="inject"]').getAttribute('aria-pressed'), 'false');
});

test('«Показать блок» shows the text, RU/EN and the token estimate; RU/EN → setBlockLanguage', t => {
  const { $, $$, runtime, act } = setup(t);
  assert.equal($('.st-echo-block'), null);
  act('block');
  assert.match($('.st-echo-block').textContent, /^\[Avoid\] Phrases/);
  assert.match($('.st-echo-tok').textContent, /^~ \d+ токен/);
  const [ru, en] = $$('[data-act="block-lang"]');
  assert.equal(en.getAttribute('aria-pressed'), 'true');
  ru.click();
  assert.deepEqual(runtime.callsOf('setBlockLanguage'), [['ru']]);
  assert.match($('.st-echo-block').textContent, /^\[Избегай\] Фразы/);
  assert.equal($('.st-echo-block').getAttribute('lang'), 'ru');
  act('inject');
  assert.match($('.st-echo-tok').textContent, /выключено, в промпт не уходит/);
});

test('the view sheet: labelled sliders in order write updateSettings({ visual }), debounced while dragging, at once on release', async t => {
  const { $, $$, runtime, act, ui, dom } = setup(t);
  act('view');
  assert.equal($('.st-echo-sheet').getAttribute('role'), 'dialog');
  const rows = $$('.st-echo-slider').slice(1);
  assert.deepEqual(rows.map(row => row.querySelector('label > span').textContent), ['Текст', 'Чипы', 'Непрозрачность', 'Размытие', 'Скругление', 'Ширина']);
  const inputs = rows.map(row => row.querySelector('input[type="range"]'));
  assert.deepEqual(inputs.map(input => [input.min, input.max, input.step]),
    [['12', '18', '1'], ['28', '48', '1'], ['0.5', '1', '0.01'], ['0', '30', '1'], ['8', '24', '1'], ['60', '100', '1']]);
  assert.deepEqual(inputs.map(input => input.value), ['14', '36', '0.93', '14', '18', '80']);
  assert.deepEqual(rows.slice(0, 5).map(row => row.querySelector('output').textContent), ['14 px', '36 px', '0.93', '14 px', '18 px']);
  assert.ok(rows[5].classList.contains('st-echo-wide-only'), 'width only on wide screens');
  assert.ok(rows.slice(0, 5).every(row => !row.classList.contains('st-echo-wide-only')));
  const slide = (input, value, type) => { input.value = value; input.dispatchEvent(new dom.window.Event(type, { bubbles: true })); };
  slide(inputs[1], '40', 'input');
  slide(inputs[1], '42', 'input');
  assert.equal(runtime.callsOf('updateSettings').length, 0, 'nothing is written while the drag is younger than 150 ms');
  assert.equal(ui.element.style.getPropertyValue('--st-echo-chip'), '42px', 'the preview follows the thumb');
  assert.equal(rows[1].querySelector('output').textContent, '42 px');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(runtime.callsOf('updateSettings'), [[{ visual: { chipSize: 42 } }]]);
  assert.equal($$('.st-echo-slider input')[2], inputs[1], 'the slider node survives the re-render');
  slide(inputs[1], '44', 'input');
  slide(inputs[1], '44', 'change');
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ visual: { chipSize: 44 } }], 'the release writes at once');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(runtime.callsOf('updateSettings').length, 2, 'the pending drag write was folded into the release');
  assert.equal(ui.element.style.getPropertyValue('--st-echo-chip'), '44px');
  for (const [index, value, patch] of [[0, '16', { fontSize: 16 }], [2, '0.75', { opacity: 0.75 }], [3, '22', { blur: 22 }], [4, '12', { radius: 12 }], [5, '90', { widthVw: 90 }]]) {
    slide(inputs[index], value, 'change');
    assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ visual: patch }]);
  }
  assert.equal(ui.element.style.getPropertyValue('--st-echo-font'), '16px');
  assert.equal(ui.element.style.getPropertyValue('--st-echo-opacity'), '0.75');
  assert.equal(ui.element.style.getPropertyValue('--st-echo-radius'), '12px');
  assert.deepEqual($$('.st-echo-slider input').slice(1).map(input => input.value), ['16', '44', '0.75', '22', '12', '90']);
});

test('the view sheet: «Анимация» and «Чипы слов сразу» switches, then «Свернуть все карточки» and «Готово»', t => {
  const { $, $$, runtime, act, row, ui } = setup(t);
  act('view');
  assert.deepEqual([...$('.st-echo-sheet-b').children].map(node => node.classList[0]),
    ['st-echo-slider', 'st-echo-slider', 'st-echo-slider', 'st-echo-slider', 'st-echo-slider', 'st-echo-slider', 'st-echo-slider', 'st-echo-switches', 'st-echo-btn']);
  assert.deepEqual($$('.st-echo-switch').map(item => [item.getAttribute('role'), item.textContent, item.getAttribute('aria-checked')]),
    [['switch', 'Анимация', 'true'], ['switch', 'Чипы слов сразу', 'true'], ['switch', 'На весь экран на телефоне', 'false']]);
  act('phone-full');
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ visual: { phoneFull: true } }]);
  assert.equal($('[data-act="phone-full"]').getAttribute('aria-checked'), 'true');
  assert.equal(ui.element.dataset.stEchoPhone, 'full');
  act('phone-full');
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ visual: { phoneFull: false } }]);
  assert.equal(ui.element.dataset.stEchoPhone, undefined);
  act('motion');
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ visual: { motion: false } }]);
  assert.equal(ui.element.dataset.stEchoMotion, 'off');
  assert.equal($('[data-act="motion"]').getAttribute('aria-checked'), 'false');
  act('cand-mode');
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ candidates: 'collapsed' }]);
  assert.equal($('[data-act="cand-mode"]').getAttribute('aria-checked'), 'false');
  assert.ok(row(FIRST).querySelector('[data-act="trim"]'), 'collapsed rows are back');
  assert.equal(row(FIRST).querySelectorAll('.st-echo-w').length, 0);
  act('cand-mode');
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ candidates: 'chips' }]);
  assert.equal(row(FIRST).querySelectorAll('.st-echo-w').length, 6);
  act('fold-all');
  assert.ok(['cands', 'pats', 'bans'].every(id => $(`#st-echo-body-${id}`).hidden));
  assert.equal($('[data-act="fold-all"]').textContent, 'Развернуть все карточки');
  act('view-done');
  assert.equal($('.st-echo-sheet'), null);
  assert.equal($('[data-act="view"]').getAttribute('aria-expanded'), 'false');
});

test('swiping the view sheet down closes it', t => {
  const { $, act, dom } = setup(t);
  act('view');
  const header = $('.st-echo-sheet-h');
  const pointer = (type, y) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 7 });
    header.dispatchEvent(event);
  };
  pointer('pointerdown', 100);
  pointer('pointermove', 140);
  assert.equal($('.st-echo-sheet').style.transform, 'translateY(40px)');
  pointer('pointerup', 140);
  assert.ok($('.st-echo-sheet'), 'a short drag snaps back');
  pointer('pointerdown', 100);
  pointer('pointermove', 200);
  pointer('pointerup', 200);
  assert.equal($('.st-echo-sheet'), null);
});

test('sensors: three buttons with value and level word; a tap opens the chart; hidden when sensors is null', t => {
  const { $, $$, act, runtime } = setup(t);
  assert.deepEqual($$('.st-echo-sens').map(item => item.textContent),
    ['Повторы2.9 · высоко', 'За меня0.4 · низко', 'Движение1.3 · средне']);
  assert.ok($$('.st-echo-sens')[0].classList.contains('st-echo-c-red'));
  act('sensor', 2);
  assert.match($('.st-echo-sd').textContent, /Движение1\.3 \/ 4/);
  assert.ok($('.st-echo-sd svg polyline'));
  runtime.set({ sensors: null });
  assert.equal($('.st-echo-sensors'), null);
  assert.equal($('.st-echo-sd'), null);
});

test('patterns: every standard pattern, neutral bar, «Реже использовать» → banPattern; banned ones drop out', t => {
  const { $, $$, runtime } = setup(t);
  assert.deepEqual($$('.st-echo-pat-n').map(item => item.textContent),
    ['Не X, а Y', 'Фильтр-глаголы (заметила, почувствовал)', 'Отрицательное действие (не пошевелился)',
      'Словно / будто', 'Что-то / где-то', 'На мгновение / на миг'], 'aphorism is banned');
  assert.equal($('[data-card="pats"] .st-echo-card-sub').textContent, 'по 10 последним ответам');
  const first = $('.st-echo-pat');
  assert.match(first.querySelector('.st-echo-pat-k').textContent, /4 из 10 последних/);
  assert.equal(first.querySelector('.st-echo-bar > i').getAttribute('style'), 'width:40%');
  assert.equal(first.querySelector('.st-echo-pat-ex').textContent, '«Это был не страх, а что-то куда более древнее.»');
  assert.equal(first.querySelector('[data-act="ban-pattern"]').textContent, 'Реже использовать');
  first.querySelector('[data-act="ban-pattern"]').click();
  assert.deepEqual(runtime.callsOf('banPattern'), [['antithesis']]);
  assert.equal($$('.st-echo-pat').length, 5);
  runtime.set({ patterns: [] });
  assert.equal($('[data-card="pats"] .st-echo-empty').textContent, 'Приёмов нет.');
  assert.equal($('[data-card="pats"] .st-echo-card-sub'), null);
});

test('no Jev key: one calm line that opens the settings and can be dismissed; no strip; the patterns card stays', t => {
  let opened = 0;
  const { $, ui, act } = setup(t, { state: 'nojev', options: { onSettings: () => { opened++; } } });
  assert.equal($('.st-echo-sensors'), null);
  assert.ok($('[data-card="pats"]'), 'standard patterns need no Jev (SPEC §16.1)');
  assert.equal($('.st-echo-notice-b').textContent, 'Подключить анализ приёмов');
  act('settings');
  assert.equal(opened, 1);
  assert.equal(ui.element.hidden, true, 'the panel makes room for the settings');
  ui.open();
  act('jev-dismiss');
  assert.equal($('.st-echo-notice'), null);
  assert.ok($('[data-card="pats"]'));
});

test('patterns without Jev: miner counts, «нет данных · нужен Jev» for aphorism with no bar, still bannable', t => {
  const { $, $$, runtime } = setup(t, { state: 'nojev' });
  const rows = $$('.st-echo-pat'), byId = id => rows.find(row => row.dataset.key === `p:${id}`);
  assert.equal(rows.length, 7);
  assert.match(byId('simile').querySelector('.st-echo-pat-k').textContent, /5 из 10 последних/);
  assert.equal(byId('simile').querySelector('.st-echo-bar > i').getAttribute('style'), 'width:50%');
  const aphorism = byId('aphorism'), line = aphorism.querySelector('.st-echo-pat-k');
  assert.equal(line.textContent, 'нет данных · нужен Jev');
  assert.ok(line.classList.contains('st-echo-muted'));
  assert.equal(aphorism.querySelector('.st-echo-bar'), null, 'no bar without a count');
  assert.equal(aphorism.querySelector('.st-echo-pat-ex'), null);
  runtime.set({ jev: { ...fixture.jev } });
  assert.equal($('[data-key="p:aphorism"] .st-echo-pat-k').textContent, 'нет данных', 'Jev on, nothing scored yet');
  $('[data-key="p:aphorism"] [data-act="ban-pattern"]').click();
  assert.deepEqual(runtime.callsOf('banPattern'), [['aphorism']]);
  assert.equal($('[data-key="p:aphorism"]'), null);
  runtime.set({ language: 'en', jev: snapshotFor(fixture, 'nojev').jev, patterns: [{ id: 'filter', source: null, count: null, window: 0, rate: null, example: '' }] });
  assert.equal($('.st-echo-pat-k').textContent, 'no data');
});

test('without onSettings the drawer asks for the settings with a DOM event', t => {
  const { act, document } = setup(t, { state: 'nojev' });
  let asked = 0;
  document.addEventListener('sable-echo:settings', () => { asked++; });
  act('settings');
  assert.equal(asked, 1);
});

test('empty state: the calm message and «Добавить фразу вручную» → banText', async t => {
  const { $, runtime, act, type, press, document } = setup(t, { state: 'empty' });
  assert.equal($('[data-card="cands"] .st-echo-empty').textContent, 'Пока нет длинных ответов для анализа. Добавьте фразу вручную.');
  assert.equal($('[data-card="bans"]'), null, 'nothing else until there is a ban');
  assert.equal(act('manual').textContent, 'Добавить фразу вручную');
  const field = $('[data-draft="manual"]');
  assert.equal(document.activeElement, field);
  type(field, 'тишина повисла');
  press(field, 'Enter');
  assert.deepEqual(runtime.callsOf('banText'), [['тишина повисла']]);
  await flush();
  assert.ok($('[data-card="bans"]'), 'the ban list appears with the first ban');
  assert.match($('.st-echo-toast').textContent, /Добавлено в бан/);
});

test('card headers fold on tap', t => {
  const { $ } = setup(t);
  const head = $('[data-card="cands"] .st-echo-card-t');
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  head.click();
  assert.equal($('#st-echo-body-cands').hidden, true);
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  head.click();
  assert.equal($('#st-echo-body-cands').hidden, false);
});

test('more than five bans become rows with «снова: N за M ответов»', t => {
  const extra = [1, 2, 3].map(index => ({ ...fixture.bans[1], id: `b_0000000${index}`, text: `фраза ${index}`, seenAfter: 0 }));
  const { $, $$ } = setup(t, { patch: { bans: [...fixture.bans, ...extra] } });
  assert.equal($$('.st-echo-bchip').length, 0);
  assert.equal($$('.st-echo-brow').length, 6);
  const row = $$('.st-echo-brow').find(item => item.dataset.key === 'b:b_8d2e4b51');
  assert.equal(row.querySelector('.st-echo-m-seen').textContent, 'снова: 3 за 12 ответов');
  row.querySelector('[data-act="bedit"]').click();
  assert.equal($('.st-echo-brow.st-echo-sel + .st-echo-bed').querySelector('.st-echo-seen-long').textContent, 'Снова встретилось: 3 за 12 ответов');
});

test('ban chips show the alternative and regex marks; ✕ → unban', t => {
  const { $$, runtime } = setup(t);
  const chip = $$('.st-echo-bchip')[0];
  assert.equal(chip.querySelector('.st-echo-m-alt').textContent, '↷');
  assert.ok(chip.querySelector('.st-echo-m-rx'));
  assert.equal($$('.st-echo-bchip')[1].querySelector('.st-echo-m-seen').textContent, 'снова: 3 за 12 ответов');
  assert.match($$('.st-echo-bchip')[2].textContent, /приёмЗакрывающий афоризм/);
  chip.querySelector('[data-act="unban"]').click();
  assert.deepEqual(runtime.callsOf('unban'), [[ALT_BAN.id]]);
  assert.equal($$('.st-echo-bchip').length, 2);
});

test('intentional and hidden folds restore entries', t => {
  const { $, act, runtime } = setup(t);
  act('list', 0);
  assert.match($('[data-key="fold:intentional"]').textContent, /Намеренно \(1\).*«да, милорд»/);
  act('unmark');
  assert.deepEqual(runtime.callsOf('unmarkIntentional'), [['да, милорд']]);
  act('list', 0);
  act('unhide');
  assert.deepEqual(runtime.callsOf('unhide'), [['в глубине души']]);
});

test('hints have a ✕ that turns hints off', t => {
  const { $$, act, runtime } = setup(t);
  assert.deepEqual($$('.st-echo-hint > span').map(item => item.textContent),
    ['Нажмите на слово, чтобы убрать его из фразы.', 'Нажмите на чип, чтобы задать замену или регекс.']);
  act('hint-off');
  assert.deepEqual(runtime.callsOf('updateSettings'), [[{ hints: false }]]);
  assert.equal($$('.st-echo-hint').length, 0);
});

test('status line, rescan, Jev errors', t => {
  const { $, act, runtime } = setup(t);
  assert.equal($('.st-echo-status').textContent, 'Смотритель · 60 ответов · Jev вкл · после #214');
  act('rescan');
  assert.deepEqual(runtime.callsOf('rescan'), [[]]);
  runtime.set({ busy: { rescan: true, alternatives: null, regex: null } });
  assert.equal($('.st-echo-status').textContent, 'считаю…');
  assert.ok($('[data-act="rescan"]').classList.contains('st-echo-spin'));
  runtime.set({ busy: { rescan: false, alternatives: null, regex: null }, jev: { ...fixture.jev, error: { kind: 'credit', message: 'x' } } });
  assert.equal($('.st-echo-err').textContent, 'Jev: закончились кредиты');
  runtime.set({ enabled: false });
  assert.match($('.st-echo-scroll').textContent, /Эхо выключено в настройках/);
  assert.equal($('.st-echo-tab').hidden, true);
});

test('chat and model strings are rendered as text, never as markup', t => {
  const patch = {
    characterName: XSS,
    candidates: [{ ...fixture.candidates[0], words: [XSS, 'губ'], examples: [`${XSS} губ`] }],
    openers: [{ ...fixture.openers[0], text: XSS }],
    intentional: [XSS],
    patterns: [{ ...fixture.patterns[1], example: XSS }],
    bans: [{ ...fixture.bans[0], text: XSS, alt: XSS, findRegex: XSS }],
  };
  const { $, $$, act, ui } = setup(t, { patch });
  act('examples');
  act('list', 0);
  $$('.st-echo-bt')[0].click();
  act('rx');
  assert.equal(ui.element.querySelector('img, script'), null);
  assert.equal(globalThis.pwned, undefined);
  assert.ok($('.st-echo-status').textContent.includes(XSS));
  for (const selector of ['.st-echo-exs', '.st-echo-w', '.st-echo-opener', '.st-echo-pat-ex', '.st-echo-bt', '.st-echo-rx', '[data-key="fold:intentional"]']) {
    assert.ok($(selector).textContent.includes(XSS), selector);
  }
  assert.equal($('#st-echo-alt').value, XSS);
  const collapsed = setup(t, { patch: { ...patch, ...COLLAPSED } });
  assert.ok(collapsed.$('.st-echo-cand-text').textContent.includes(XSS));
  assert.equal(collapsed.ui.element.querySelector('img, script'), null);
});

test('English strings come from i18n', t => {
  const { $, $$ } = setup(t, { patch: { language: 'en' } });
  assert.equal($('.st-echo-title').textContent, 'Echo');
  assert.equal($('[data-card="cands"] .st-echo-card-n').textContent, 'Candidates');
  assert.equal($('[data-act="ban"]').textContent, 'Ban');
  assert.equal($('[data-act="ban-pattern"]').textContent, 'Use less often');
  assert.equal($('.st-echo-caption').textContent, 'Applies to future responses. Past responses stay unchanged.');
  assert.match($$('.st-echo-meta')[0].textContent, /9 of 60 replies/);
  assert.equal($('.st-echo-tab').getAttribute('aria-label'), 'Close Echo');
});

test('Escape closes the menu, then the sheet, then the panel', t => {
  const { $, act, ui, document } = setup(t);
  const escape = () => document.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  act('keep');
  act('view');
  assert.equal($('[role="menu"]'), null, 'the sheet closes the menu');
  act('view');
  act('keep');
  escape();
  assert.equal($('[role="menu"]'), null);
  act('view');
  escape();
  assert.equal($('.st-echo-sheet'), null);
  escape();
  assert.equal(ui.element.hidden, true);
});

test('unmount removes the tab, the panel and the menu entry and stops listening', t => {
  const dom = new JSDOM('<!doctype html><body><div id="extensionsMenu"></div></body>');
  t.after(() => dom.window.close());
  const runtime = createFakeRuntime(fixture);
  const ui = mountDrawer(runtime, { document: dom.window.document });
  assert.ok(dom.window.document.querySelector('.st-echo-drawer'));
  ui.unmount();
  assert.equal(dom.window.document.querySelector('.st-echo-drawer, .st-echo-tab, .st-echo-menu-entry'), null);
  assert.doesNotThrow(() => runtime.emit());
});

test('trimWords: ends drop, a middle run becomes one gap', () => {
  const words = ['его', 'глаза', 'на', 'миг', 'потемнели'];
  assert.deepEqual(trimWords(words, []), { text: 'его глаза на миг потемнели', parts: ['его глаза на миг потемнели'] });
  assert.deepEqual(trimWords(words, [0, 2, 3]), { text: 'глаза … потемнели', parts: ['глаза', 'потемнели'] });
  assert.deepEqual(trimWords(words, [0, 1, 2, 3, 4]), { text: '', parts: [] });
  assert.equal(trimWords(words, [4, 3]).text, 'его глаза на');
});

test('levelOf reads the colour as a level; change is inverted', () => {
  assert.equal(levelOf('repeats', 'red'), 'high');
  assert.equal(levelOf('speaks', 'green'), 'low');
  assert.equal(levelOf('change', 'red'), 'low');
  assert.equal(levelOf('change', 'green'), 'high');
  assert.equal(levelOf('change', 'amber'), 'mid');
  assert.equal(levelOf('repeats', 'purple'), null);
});

test('visualVars maps visual settings to --st-echo-* with Sable semantics', () => {
  const plain = visualVars(fixture.visual);
  assert.equal(plain.vars.font, '14px');
  assert.equal(plain.vars.width, '80vw');
  assert.equal(plain.vars.chip, '36px');
  assert.equal(plain.vars.accent, null, 'the default accent follows the ink in CSS');
  assert.equal(plain.vars['accent-ink-rgb'], '0,0,0');
  assert.deepEqual(plain.flags, { stEchoTone: null, stEchoMotion: null, stEchoPhone: null, stEchoSpacing: null, stEchoChip: null });
  const light = visualVars({ ...fixture.visual, base: '#F4EFE6', accent: '#7a3cff', motion: false, spacing: 'compact', chipSize: 30 });
  assert.equal(light.vars['base-rgb'], '244,239,230');
  assert.equal(light.vars['ink-rgb'], '0,0,0');
  assert.equal(light.vars.text, 'rgb(0,0,0)');
  assert.equal(light.vars.accent, '#7a3cff');
  assert.equal(light.vars['accent-ink-rgb'], inkFor('#7a3cff'));
  assert.equal(light.vars.chip, '30px');
  assert.equal(light.vars['chip-pad'], '8px');
  assert.deepEqual(light.flags, { stEchoTone: 'light', stEchoMotion: 'off', stEchoPhone: null, stEchoSpacing: 'compact', stEchoChip: 'compact' });
  assert.equal(visualVars({ ...fixture.visual, phoneFull: true }).flags.stEchoPhone, 'full', 'SPEC §19.3 full-width phone layout');
  assert.equal(visualVars({ ...fixture.visual, phoneFull: 'yes' }).flags.stEchoPhone, null);
  assert.equal(visualVars(null).vars.opacity, '0.93');
  assert.equal(visualVars({ chipSize: 'large' }).vars.chip, `${CHIP_SIZES.large}px`, 'v0.1 names still read');
  assert.equal(visualVars({ chipSize: 44 }).flags.stEchoChip, null, 'the tap-area extension is only for chips under 36 px');
  assert.deepEqual([28, 35.6, 48, 99, 10, '40', null, 'huge', true].map(chipPx), [28, 36, 48, 48, 28, 40, 36, 36, 36]);
  assert.equal(panelWidth(80, 1920), 768);
  assert.equal(panelWidth(80, 800), 420);
  assert.equal(panelWidth(100, 400), 400);
});

test('visual.motion = false reaches the panel as data-st-echo-motion="off"', t => {
  const { ui, runtime } = setup(t);
  runtime.set({ visual: { ...fixture.visual, motion: false } });
  assert.equal(ui.element.dataset.stEchoMotion, 'off');
  assert.equal(ui.element.style.getPropertyValue('--st-echo-opacity'), '0.93');
});

test('visualVars: the background picture is a panel-only layer with dim and fit, unsafe URLs never reach CSS', () => {
  const picture = 'data:image/png;base64,iVBORw0KGgo=';
  assert.deepEqual(visualVars(fixture.visual).bg, { vars: { 'bg-image': null, 'bg-dim': null }, flags: { stEchoBg: null, stEchoFit: null } });
  const cover = visualVars({ ...fixture.visual, bgImage: picture, bgDim: 0.3 }).bg;
  assert.deepEqual(cover, { vars: { 'bg-image': `url("${picture}")`, 'bg-dim': '0.3' }, flags: { stEchoBg: '1', stEchoFit: null } });
  assert.equal(visualVars({ bgImage: picture, bgFit: 'contain' }).bg.flags.stEchoFit, 'contain');
  assert.equal(visualVars({ bgImage: picture, bgFit: 'tile', bgDim: 5 }).bg.flags.stEchoFit, 'tile');
  assert.equal(visualVars({ bgImage: picture, bgDim: 5 }).bg.vars['bg-dim'], '0.9');
  assert.equal(visualVars({ bgImage: picture, bgFit: 'weird' }).bg.flags.stEchoFit, null);
  for (const bad of ['https://example.org/a").png', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=']) {
    assert.deepEqual(visualVars({ bgImage: bad, bgFit: 'tile' }).bg.flags, { stEchoBg: null, stEchoFit: null }, bad);
  }
});

test('a background picture paints the panel, never the edge tab, and goes away with «Убрать»', t => {
  const { ui, runtime, $ } = setup(t);
  const tab = $('.st-echo-tab'), picture = 'https://example.org/synthetic-gradient.png';
  assert.equal(ui.element.dataset.stEchoBg, undefined);
  runtime.set({ visual: { ...fixture.visual, bgImage: picture, bgDim: 0.6, bgFit: 'tile' } });
  assert.equal(ui.element.dataset.stEchoBg, '1');
  assert.equal(ui.element.dataset.stEchoFit, 'tile');
  assert.equal(ui.element.style.getPropertyValue('--st-echo-bg-image'), `url("${picture}")`);
  assert.equal(ui.element.style.getPropertyValue('--st-echo-bg-dim'), '0.6');
  assert.equal(tab.dataset.stEchoBg, undefined);
  assert.equal(tab.style.getPropertyValue('--st-echo-bg-image'), '');
  runtime.set({ visual: { ...fixture.visual, bgImage: null } });
  assert.equal(ui.element.dataset.stEchoBg, undefined);
  assert.equal(ui.element.dataset.stEchoFit, undefined);
  assert.equal(ui.element.style.getPropertyValue('--st-echo-bg-image'), '');
  assert.equal(ui.element.style.getPropertyValue('--st-echo-bg-dim'), '');
  // style.css: the layer, the wash of the base colour, the fits and the readable header backing.
  assert.match(css, /\.st-echo-drawer\[data-st-echo-bg="1"\]::before \{[^}]*z-index: -1;[^}]*var\(--st-echo-bg-dim, \.45\)[^}]*var\(--st-echo-bg-image, none\)/);
  assert.match(css, /\.st-echo-drawer\[data-st-echo-fit="contain"\]::before \{ background-size: 100% 100%, contain; \}/);
  assert.match(css, /\.st-echo-drawer\[data-st-echo-fit="tile"\]::before \{[^}]*repeat/);
  assert.match(css, /\.st-echo-drawer\[data-st-echo-bg="1"\] \.st-echo-hd \{ background: rgba\(var\(--st-echo-base-rgb, 14,14,18\), \.66\)/);
});

test('style.css: explicit fixed-panel height, full width on phones, motion off and reduced motion', () => {
  const rule = selector => css.match(new RegExp(`(^|\\n)${selector.replace(/[.[\]"=]/g, '\\$&')} \\{([^}]*)\\}`))?.[2] ?? '';
  const panel = rule('.st-echo-drawer');
  assert.match(panel, /position: fixed;/);
  assert.match(panel, /height: calc\(100dvh - var\(--st-echo-top, 0px\)\)/);
  assert.doesNotMatch(panel, /bottom: 0/);
  // SPEC §19.3: phones get a side panel of max(320px, widthVw); full width only with data-st-echo-phone="full".
  assert.match(css, /@media \(max-width: 699\.98px\) \{\s*\.st-echo-drawer, \.st-echo-tab \{ --st-echo-panel-w: min\(100vw, max\(320px, var\(--st-echo-width, 80vw\)\)\); \}\s*\.st-echo-drawer\[data-st-echo-phone="full"\], \.st-echo-tab\[data-st-echo-phone="full"\] \{ --st-echo-panel-w: 100vw; \}\s*\}/);
  assert.match(css, /@media \(max-width: 699\.98px\) \{ \.st-echo-drawer\[data-st-echo-phone="full"\] \{ border: 0; border-radius: 0; box-shadow: none; \} \}/);
  assert.match(css, /@media \(max-width: 699\.98px\) \{ \.st-echo-tab\[aria-expanded="true"\]\[data-st-echo-phone="full"\] \{ display: none; \} \}/, 'the edge tab stays next to a side panel');
  // SPEC §20.1: the pressed pin carries the accent fill of a pressed toggle.
  for (const selector of ['.st-echo-ib[aria-pressed="true"]', '.st-echo-tog[aria-pressed="true"]']) {
    assert.match(rule(selector), /color: rgb\(var\(--st-echo-acc-ink\)\); background: var\(--st-echo-acc\);/, selector);
  }
  assert.match(css, /\.st-echo-drawer\[data-st-echo-motion="off"\] \*[^{]*\{ animation: none !important; transition: none !important; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.st-echo-drawer, \.st-echo-drawer \*[^{]*\{ animation: none !important; transition: none !important; \}/);
  for (const name of ['opacity', 'blur', 'font', 'width', 'accent', 'radius', 'base-rgb', 'ink-rgb', 'accent-ink-rgb', 'text', 'chip']) {
    assert.ok(css.includes(`var(--st-echo-${name}`), name);
  }
});

test('i18n: both languages have the same keys, Russian plurals, fallbacks', () => {
  assert.deepEqual(Object.keys(STRINGS.ru).filter(key => !/\.(few|many)$/.test(key)).sort(),
    Object.keys(STRINGS.en).filter(key => !/\.(few|many)$/.test(key)).sort());
  for (const key of Object.keys(STRINGS.ru)) assert.match(key, /^(drawer|sensor|pattern|ban|view|hint|toast|settings)\./, key);
  const replies = count => translate('drawer.status.replies', 'ru', { count });
  assert.deepEqual([1, 2, 5, 21, 60].map(replies), ['1 ответ', '2 ответа', '5 ответов', '21 ответ', '60 ответов']);
  assert.equal(translate('drawer.status.replies', 'en', { count: 1 }), '1 reply');
  assert.equal(translate('drawer.status.replies', 'en', { count: 3 }), '3 replies');
  assert.equal(translate('ban.seen', 'ru', { seen: 3, count: 12 }), 'снова: 3 за 12 ответов');
  assert.equal(translate('ban.seen', 'ru', { seen: 1, count: 2 }), 'снова: 1 за 2 ответа');
  assert.equal(translate('drawer.title'), 'Эхо');
  assert.equal(translate('drawer.title', 'de'), 'Эхо');
  assert.equal(translate('nope.key', 'en'), 'nope.key');
  assert.equal(translate('pattern.filter.prompt', 'en'), 'filter verbs (noticed, felt) instead of direct action');
});

test('SPEC §19.1: sheet sliders are a themed track and knob under an invisible range input; the fill lives on the box', t => {
  const { $, $$, act, dom, runtime } = setup(t);
  act('view');
  const rows = $$('.st-echo-slider');
  for (const row of rows) {
    const box = row.querySelector('.st-echo-sl-box'), input = box.querySelector('input[type="range"]');
    assert.deepEqual([...row.children].slice(0, 2).map(node => node.className), ['st-echo-sheet-l', 'st-echo-sl-box']);
    assert.deepEqual([...box.children].map(node => node.className), ['st-echo-sl-track', 'st-echo-range st-echo-control']);
    assert.equal(box.firstElementChild.getAttribute('aria-hidden'), 'true');
    assert.equal(box.firstElementChild.firstElementChild.className, 'st-echo-sl-knob');
    assert.match(box.style.getPropertyValue('--st-echo-fill'), /^\d+%$/);
    assert.equal(input.getAttribute('style'), null, 'the input carries no inline style');
    assert.equal(input.dataset.view, box.dataset.fill);
    assert.equal(input.dataset.key, `range:${input.dataset.view}`);
    assert.equal(row.querySelector('label').getAttribute('for'), input.id);
  }
  // SPEC §19.2: one-line hints under the three size sliders only.
  assert.deepEqual(rows.map(row => row.querySelector('.st-echo-sl-hint')?.textContent ?? null),
    ['вся панель целиком', 'только шрифт', 'высота слов-чипов и кнопок рядом', null, null, null, null]);
  const box = rows[1].querySelector('.st-echo-sl-box'), input = box.querySelector('input');
  assert.equal(box.style.getPropertyValue('--st-echo-fill'), '33%', 'fontSize 14 of 12–18');
  input.value = '18'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(box.style.getPropertyValue('--st-echo-fill'), '100%', 'a drag moves the knob through the box');
  assert.equal(input.getAttribute('style'), null);
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ visual: { fontSize: 18 } }]);
  assert.equal($('[data-fill="fontSize"]').style.getPropertyValue('--st-echo-fill'), '100%', 'the re-render keeps the fill');
  const english = setup(t, { patch: { language: 'en' } });
  english.act('view');
  assert.deepEqual(english.$$('.st-echo-sl-hint').map(node => node.textContent), ['the whole panel', 'the font only', 'height of word chips and the buttons next to them']);
  const sheetCss = css.match(/\n\.st-echo-drawer \.st-echo-sl-box > input\.st-echo-range \{([^}]*)\}/)?.[1] ?? '';
  assert.match(sheetCss, /position: absolute; inset: 0;/);
  assert.match(sheetCss, /height: 28px;/);
  assert.match(sheetCss, /opacity: 0;/);
  assert.match(css, /\n\.st-echo-sl-box \{ position: relative; height: 28px;/);
  assert.match(css, /\n\.st-echo-sl-track \{[^}]*height: 4px; border-radius: 999px;/);
  assert.match(css, /\n\.st-echo-sl-knob \{\s*position: absolute; top: 50%; left: var\(--st-echo-fill, 0%\); width: 18px; height: 18px;/);
});

test('SPEC §20.1: the header is rescan, pin, view, close; the pin shows settings.pinned and a tap toggles it', t => {
  const { $, $$, act, runtime } = setup(t);
  assert.deepEqual($$('.st-echo-hd-row .st-echo-ib').map(element => element.dataset.act), ['rescan', 'pin', 'view', 'close']);
  const pin = () => $('[data-act="pin"]');
  assert.equal(pin().getAttribute('aria-pressed'), 'false', 'unpinned by default');
  assert.equal(pin().getAttribute('aria-label'), 'Закрепить');
  assert.equal(pin().getAttribute('title'), 'Закрепить');
  assert.ok(pin().querySelector('.st-echo-ico[data-icon="pin"] svg path'), 'a drawn glyph, not text');
  assert.equal(pin().textContent.trim(), '');
  act('pin');
  assert.deepEqual(runtime.callsOf('updateSettings'), [[{ pinned: true }]]);
  assert.equal(pin().getAttribute('aria-pressed'), 'true', 'rendered from the snapshot');
  assert.equal(pin().getAttribute('aria-label'), 'Закрепить', 'the label does not change with the state');
  act('pin');
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ pinned: false }]);
  assert.equal(pin().getAttribute('aria-pressed'), 'false');
});

test('SPEC §20.1: a pinned snapshot renders the pin pressed; the English label', t => {
  const { $, act, runtime } = setup(t, { patch: { settings: { pinned: true }, language: 'en' } });
  assert.equal($('[data-act="pin"]').getAttribute('aria-pressed'), 'true');
  assert.equal($('[data-act="pin"]').getAttribute('aria-label'), 'Pin');
  act('pin');
  assert.deepEqual(runtime.callsOf('updateSettings'), [[{ pinned: false }]]);
});

test('SPEC §19.3 and §20.1: unpinned, a tap outside closes the panel on a phone and on desktop; never from the tab or the entry', t => {
  const { $, ui, dom, document, runtime, act } = setup(t);
  const tapAt = target => target.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
  dom.window.innerWidth = 412;
  assert.equal(ui.element.dataset.stEchoPhone, undefined, 'side panel by default');
  assert.equal($('[data-act="pin"]').getAttribute('aria-pressed'), 'false');
  tapAt($('.st-echo-title'));
  assert.equal(ui.element.hidden, false, 'a tap inside stays open');
  act('view');
  tapAt(document.body);
  assert.equal(ui.element.hidden, true, 'phone side panel: a tap on the page closes the panel');
  assert.equal($('.st-echo-sheet'), null);
  ui.open();
  // The edge tab: pointerdown must not close, or the following click would reopen it.
  tapAt($('.st-echo-tab'));
  assert.equal(ui.element.hidden, false);
  $('.st-echo-tab').click();
  assert.equal(ui.element.hidden, true, 'the tab itself toggles');
  ui.open();
  tapAt($('.st-echo-menu-entry'));
  assert.equal(ui.element.hidden, false, 'the wand-menu entry toggles itself too');
  dom.window.innerWidth = 1024;
  act('keep');
  tapAt(document.body);
  assert.equal(ui.element.hidden, true, 'desktop closes too: SPEC §20.1 replaces the phone-only rule of §19.3');
  assert.equal($('[role="menu"]'), null);
  ui.open();
  dom.window.innerWidth = 412;
  runtime.set({ visual: { ...fixture.visual, phoneFull: true } });
  assert.equal(ui.element.dataset.stEchoPhone, 'full');
  tapAt(document.body);
  // The same rule, no special case: in the real layout the full-width panel covers the viewport (style.css), so
  // no tap lands outside it. jsdom has no geometry, so a synthetic tap on the body still counts as outside.
  assert.equal(ui.element.hidden, true, 'full width: the rule is unchanged');
  assert.equal(runtime.callsOf('updateSettings').length, 0);
});

test('SPEC §20.1: pinned, taps outside never close the panel at any width but still close the menu and the sheet', t => {
  const { $, ui, dom, document, runtime, act } = setup(t, { patch: { settings: { pinned: true } } });
  const tapAt = target => target.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
  const escape = () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal($('[data-act="pin"]').getAttribute('aria-pressed'), 'true');
  for (const width of [1024, 412]) {
    dom.window.innerWidth = width;
    act('keep');
    assert.ok($('[role="menu"]'));
    tapAt(document.body);
    assert.equal(ui.element.hidden, false, `pinned: stays open at ${width}px`);
    assert.equal($('[role="menu"]'), null, 'the «Оставить» menu still closes');
    act('view');
    assert.ok($('.st-echo-sheet'));
    tapAt(document.body);
    assert.equal($('.st-echo-sheet'), null, 'the ⚙ sheet still closes');
    assert.equal(ui.element.hidden, false);
  }
  tapAt($('.st-echo-tab'));
  assert.equal(ui.element.hidden, false, 'the tab never counts as outside');
  $('.st-echo-tab').click();
  assert.equal(ui.element.hidden, true, 'the tab still closes a pinned panel');
  ui.open();
  tapAt($('.st-echo-menu-entry'));
  assert.equal(ui.element.hidden, false, 'the entry never counts as outside');
  act('close');
  assert.equal(ui.element.hidden, true, '✕ still closes a pinned panel');
  ui.open();
  escape();
  assert.equal(ui.element.hidden, true, 'Escape still closes a pinned panel');
  ui.open();
  ui.close();
  assert.equal(ui.element.hidden, true, 'api.close() still closes a pinned panel');
  assert.equal(runtime.callsOf('updateSettings').length, 0);
});

test('SPEC §19.4: a successful regex install shows the reload note for 6 s; removal and a failed write do not', async t => {
  const { $, $$, act, timers, runtime } = setup(t, { options: { manualTimers: true } });
  const note = () => $('.st-echo-rx-saved');
  $$('.st-echo-bt')[1].click();          // a ban without a regex yet
  act('rx');
  assert.equal($('[data-act="rx-install"]').getAttribute('aria-pressed'), 'false');
  assert.equal(note(), null);
  act('rx-install'); await flush();
  assert.equal(runtime.snapshot().bans[1].regex, true);
  assert.equal(note().textContent, 'Появится в списке регексов после перезагрузки страницы');
  assert.equal(note().getAttribute('role'), 'status');
  const timer = timers.find(item => item.ms === 6000);
  assert.ok(timer, 'the note has a 6 s timer');
  timer.fn();
  assert.equal(note(), null, 'gone after 6 s');
  act('rx-install'); await flush();
  assert.equal(runtime.snapshot().bans[1].regex, false);
  assert.equal(note(), null, 'turning the regex off says nothing');
  // The runtime saves the record first and logs a failed write afterwards: no note then.
  const original = runtime.setRegex;
  runtime.setRegex = async (...args) => { await original(...args); runtime.set({ log: [{ at: 1, kind: 'regex', status: 'failed', error: { kind: 'other' } }] }); };
  act('rx-install'); await flush();
  assert.equal(runtime.snapshot().bans[1].regex, true);
  assert.equal(note(), null, 'a failed write shows no note');
  assert.equal(timers.filter(item => item.ms === 6000).length, 1);
});
