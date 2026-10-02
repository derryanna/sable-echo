import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { mountSettings, fitWithin, downscaleImage, encodeImageFile, formatValue, BG_MAX_SIDE, BG_QUALITY } from '../src/ui/settings.js';
import { BG_MAX_LENGTH } from '../src/settings.js';
import { createFakeRuntime } from './fakes/runtime.mjs';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/snapshot.json', import.meta.url)));
function setup(t, options = {}, fake = {}) {
  const dom = new JSDOM('<div id="extensions_settings2"></div>', { pretendToBeVisual: true });
  const runtime = createFakeRuntime(fixture, fake), document = dom.window.document;
  const ui = mountSettings(runtime, { document, ...options });
  t.after(() => { ui.unmount(); dom.window.close(); });
  const find = name => document.querySelector(`[name="${name}"]`);
  const click = action => document.querySelector(`[data-action="${action}"]`).click();
  const change = (name, value, event = 'change') => { const input = find(name); input.value = value; input.dispatchEvent(new dom.window.Event(event, { bubbles: true })); return input; };
  return { dom, document, runtime, ui, find, click, change };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
// A 1×1 PNG as a data URL: synthetic, small, accepted by normalizeBgImage.
const PICTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
test('renders all eight ordered groups and default fields', t => {
  const { document, find } = setup(t);
  assert.deepEqual([...document.querySelectorAll('[data-group]')].map(n => n.dataset.group), ['main','jev','miner','inject','alt','regex','visual','danger']);
  assert.equal(find('jev.apiKey').type, 'password');
  assert.equal(document.querySelector('[data-group=danger]').open, false);
  assert.equal(find('prompts.block').maxLength, 4000);
  assert.equal(document.querySelectorAll('[name^="jev.sensors."]').length, 7);
  assert.equal(document.body.textContent.includes('settings.'), false);
});
test('host selection persists and reveals custom fields', t => {
  const { find, change, runtime } = setup(t);
  assert.equal(find('jev.endpoint').parentElement.parentElement.hidden, true);
  change('jev.host', 'custom');
  assert.equal(find('jev.endpoint').parentElement.parentElement.hidden, false);
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ jev: { host: 'custom' } }]);
  change('jev.host', 'rout');
  assert.equal(find('jev.endpoint').parentElement.parentElement.hidden, true);
});
test('test button reports latency and translates failures', async t => {
  const { runtime, click, document } = setup(t);
  click('test'); await tick();
  assert.equal(runtime.callsOf('testJev').length, 1);
  assert.equal(document.querySelector('[data-result=jev]').textContent, 'ok · 412 мс');
  runtime.testJev = async () => ({ ok: false, error: { kind: 'key' } });
  click('test'); await tick();
  assert.match(document.querySelector('[data-result=jev]').textContent, /Ключ/);
});
test('range input debounces patches and preserves focused edits', async t => {
  const { change, runtime, find } = setup(t);
  change('visual.blur', '20', 'input'); change('visual.blur', '22', 'input');
  assert.equal(runtime.callsOf('updateSettings').length, 0);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.deepEqual(runtime.callsOf('updateSettings'), [[{ visual: { blur: 22 } }]]);
  const input = find('jev.apiKey'); input.focus(); input.value = 'unfinished'; runtime.emit();
  assert.equal(find('jev.apiKey'), input); assert.equal(input.value, 'unfinished');
});
test('Sable-shaped theme file applies only known visual keys, the background picture included', async t => {
  const { dom, find, runtime } = setup(t), file = find('themeFile');
  const sable = { format: 'sable-theme', version: 1, enabled: false,
    visual: { opacity: .8, fontSize: 16, bgImage: PICTURE, bgDim: .3, bgFit: 'tile', cardFill: .1, icons: 'emoji', unknown: true } };
  Object.defineProperty(file, 'files', { value: [new dom.window.File([JSON.stringify(sable)], 'sable-theme.json')] });
  file.dispatchEvent(new dom.window.Event('change'));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ visual: { opacity: .8, fontSize: 16, bgImage: PICTURE, bgDim: .3, bgFit: 'tile' } }]);
  assert.equal(runtime.snapshot().settings.visual.bgImage, PICTURE);
  assert.equal(find('bgUrl').placeholder, 'картинка из файла', 'a data URL is a picture from a file, not a link');
});
test('preview and request log render markup as text, newest first, clear works', t => {
  const { runtime, click, document } = setup(t);
  runtime.preview = () => ({ text: '<b>safe</b>', tokens: 0 }); click('preview');
  assert.equal(document.querySelector('[data-preview]').textContent, '<b>safe</b>');
  runtime.set({ log: [{ at: 1, kind: 'jev', status: 'ok', request: '<b>request</b>', response: 'old' }, { at: 2, kind: 'alt', status: 'ok', response: '<b>new</b>' }] });
  assert.match(document.querySelector('.st-echo-settings-log').textContent, /<b>new<\/b>/);
  assert.equal(document.querySelector('.st-echo-settings-body b'), null);
  click('clear'); assert.equal(document.querySelectorAll('.st-echo-settings-log').length, 0);
});
test('reset needs two taps and disarms when character changes', t => {
  const { click, runtime } = setup(t);
  click('reset'); assert.equal(runtime.callsOf('resetCharacter').length, 0);
  runtime.set({ avatar: 'synthetic.png' }); click('reset'); assert.equal(runtime.callsOf('resetCharacter').length, 0);
  click('reset'); assert.equal(runtime.callsOf('resetCharacter').length, 1);
});
test('drawer event opens settings and Jev, and unmount cancels pending writes', async t => {
  const { dom, document, change, runtime, ui } = setup(t);
  let clicks = 0; const wrap = document.createElement('div'); wrap.id = 'extensions-settings-button';
  const control = document.createElement('div'); control.className = 'drawer-toggle'; control.onclick = () => clicks++; wrap.append(control); document.body.append(wrap);
  document.dispatchEvent(new dom.window.Event('sable-echo:settings'));
  assert.equal(clicks, 1); await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(document.querySelector('.inline-drawer-content').hidden, false); assert.equal(wrap.style.display, '');
  change('visual.blur', '30', 'input'); ui.unmount();
  await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(runtime.callsOf('updateSettings').length, 0);
});
test('language changes update labels without replacing fields', t => {
  const { change, find, document } = setup(t), input = find('jev.apiKey');
  change('language', 'en'); assert.equal(find('jev.apiKey'), input); assert.match(document.body.textContent, /Danger zone/);
});

test('exports a Sable theme wrapper with visual keys only', async t => {
  const { dom, click } = setup(t);
  let blob, download;
  dom.window.URL.createObjectURL = value => { blob = value; return 'blob:synthetic'; };
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () { download = this.download; };
  click('export');
  const source = await new Promise(resolve => { const reader = new dom.window.FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob); });
  const data = JSON.parse(source);
  assert.equal(download, 'sable-echo-theme.json'); assert.equal(data.format, 'sable-theme');
  assert.equal(data.visual.fontSize, 14); assert.equal('jev' in data, false);
});
test('invalid theme reports an error without writing settings', async t => {
  const { dom, find, runtime, document } = setup(t);
  Object.defineProperty(find('themeFile'), 'files', { value: [{ text: async () => '{invalid' }] });
  find('themeFile').dispatchEvent(new dom.window.Event('change')); await tick();
  assert.equal(runtime.callsOf('updateSettings').length, 0); assert.match(document.body.textContent, /Не удалось прочитать тему/);
});
test('defaults use global document, fallback host and snapshot language', async t => {
  const previous = globalThis.document;
  const dom = new JSDOM('<div id="extensions_settings"></div>'); globalThis.document = dom.window.document;
  const runtime = createFakeRuntime({ ...fixture, language: 'en' }); const ui = mountSettings(runtime);
  t.after(() => { ui.unmount(); dom.window.close(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  assert.match(dom.window.document.body.textContent, /General/);
  dom.window.document.dispatchEvent(new dom.window.Event('sable-echo:settings'));
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(dom.window.document.querySelector('.inline-drawer-content').hidden, false);
});
test('number controls clamp the specified UI ranges', t => {
  const { change, runtime } = setup(t);
  change('miner.replies', '250'); change('inject.depth', '20');
  assert.deepEqual(runtime.callsOf('updateSettings'), [[{ miner: { replies: 200 } }], [{ inject: { depth: 10 } }]]);
});
test('real runtime exposes saved settings and profile names without shared mutable data', async t => {
  const { createRuntime } = await import('../src/run.js');
  const { createFakeST } = await import('./fakes/st.mjs');
  const st = createFakeST(), runtime = createRuntime(st.getContext);
  t.after(() => runtime.dispose());
  runtime.updateSettings({ jev: { host: 'custom', model: 'synthetic', apiKey: 'synthetic-key' }, miner: { replies: 90 }, altProfileId: 'side' });
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.settings.jev.model, 'synthetic'); assert.equal(snapshot.settings.miner.replies, 90);
  assert.equal(snapshot.settings.characters, undefined); assert.deepEqual(snapshot.profiles, [{ id: 'side', name: 'Side model' }]);
  snapshot.settings.jev.apiKey = 'changed'; assert.equal(runtime.snapshot().settings.jev.apiKey, 'synthetic-key');
  const dom = new JSDOM('<div id="extensions_settings2"></div>'); const ui = mountSettings(runtime, { document: dom.window.document });
  t.after(() => { ui.unmount(); dom.window.close(); });
  assert.equal(dom.window.document.querySelector('[name="jev.model"]').value, 'synthetic');
  assert.equal(dom.window.document.querySelector('[name="altProfileId"]').value, 'side');
});
test('round 2 controls: word chips checkbox, default regex scope with hints, chip size slider', async t => {
  const { find, change, runtime, document } = setup(t);
  const chips = find('candidates');
  assert.equal(chips.type, 'checkbox');
  assert.equal(chips.checked, true, 'chips is the default');
  assert.equal(chips.closest('[data-group]').dataset.group, 'main');
  assert.match(chips.parentElement.textContent, /Слова-чипы сразу/);
  chips.click();
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ candidates: 'collapsed' }]);
  assert.equal(find('candidates').checked, false);
  chips.click();
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ candidates: 'chips' }]);
  const scope = find('regexScope');
  assert.equal(scope.closest('[data-group]').dataset.group, 'regex');
  assert.deepEqual([...scope.options].map(o => [o.value, o.textContent]), [['character', 'У персонажа'], ['global', 'Глобально']]);
  assert.equal(scope.value, 'character');
  const regexText = document.querySelector('[data-group=regex]').textContent;
  assert.match(regexText, /Где хранить по умолчанию/);
  assert.match(regexText, /внутри карточки, едет вместе с ней/);
  assert.match(regexText, /во всех чатах/);
  change('regexScope', 'global');
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ regexScope: 'global' }]);
  const chip = find('visual.chipSize');
  assert.equal(chip.type, 'range');
  assert.deepEqual([chip.min, chip.max, chip.step], ['28', '48', '1']);
  assert.equal(chip.value, '36');
  const chipRow = chip.closest('.st-echo-settings-range');
  assert.ok(chipRow, 'same row style as the other sliders');
  assert.equal(chipRow.querySelector('output').textContent, '36px');
  change('visual.chipSize', '41', 'input');
  assert.equal(chipRow.querySelector('output').textContent, '41px');
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ visual: { chipSize: 41 } }]);
});

test('rows follow the Sable Trackers block: captions, checkbox_label, label-left rows, compact sliders', t => {
  const { document, click } = setup(t);
  const all = selector => [...document.querySelectorAll(`#st-echo-settings ${selector}`)];
  const header = document.querySelector('.inline-drawer-toggle.inline-drawer-header');
  assert.equal(header.querySelector('b').textContent, 'Sable Echo');
  const chevron = header.querySelector('.inline-drawer-icon');
  assert.ok(chevron.classList.contains('fa-circle-chevron-down') && chevron.classList.contains('down'));
  header.click();
  assert.ok(chevron.classList.contains('fa-circle-chevron-up') && chevron.classList.contains('up'));
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  // Every group opens with a small caption (upper case comes from style.css).
  assert.deepEqual(all('[data-group]').map(group => group.querySelector('.st-echo-settings-heading')?.textContent),
    ['Основное', 'Jev', 'Майнер', 'В промпт', 'Альтернативы', 'Регексы', 'Внешний вид', '⚠ Опасная зона']);
  // Checkboxes: SillyTavern's own markup, the box first, the caption after it.
  const boxes = all('input[type=checkbox]');
  assert.equal(boxes.length, 14);
  for (const box of boxes) {
    const row = box.parentElement;
    assert.equal(row.tagName, 'LABEL', box.name);
    assert.ok(row.classList.contains('checkbox_label') && row.classList.contains('st-echo-settings-check'), box.name);
    assert.equal(row.firstElementChild, box, `${box.name}: the box comes first`);
    assert.ok(row.textContent.trim(), box.name);
  }
  assert.match(document.querySelector('[name="jev.sensors.speaks"]').parentElement.textContent, /За игрока.*решённые за игрока/, 'sensor hint sits in its row');
  // Sliders (SPEC §19.1): label and value on one line, then a box with a div track + knob under the invisible range
  // input; the fill lives on the box. Order as in SPEC §19.2 (the size controls first).
  const ranges = all('input[type=range]');
  assert.deepEqual(ranges.map(input => input.name), ['visual.scale', 'visual.fontSize', 'visual.chipSize', 'visual.opacity', 'visual.blur', 'visual.radius', 'visual.widthVw', 'visual.bgDim']);
  for (const input of ranges) {
    assert.ok(input.classList.contains('st-echo-range-compact'), input.name);
    const box = input.parentElement, row = box.parentElement;
    assert.ok(box.classList.contains('st-echo-settings-slider'), input.name);
    assert.deepEqual([...box.children].map(child => child.className), ['st-echo-settings-track', 'st-echo-control st-echo-range-compact'], input.name);
    assert.equal(box.firstElementChild.firstElementChild.className, 'st-echo-settings-knob', input.name);
    assert.equal(box.firstElementChild.getAttribute('aria-hidden'), 'true', input.name);
    assert.ok(row.classList.contains('st-echo-settings-range'), input.name);
    assert.deepEqual([...row.children].slice(0, 3).map(child => child.tagName), ['LABEL', 'OUTPUT', 'DIV'], input.name);
    assert.equal(row.querySelector('label').getAttribute('for'), input.id, `${input.name}: the label targets the input`);
    assert.equal(row.querySelector('output').getAttribute('for'), input.id, input.name);
    assert.match(box.style.getPropertyValue('--st-echo-fill'), /^\d+(\.\d)?%$/, input.name);
    assert.equal(input.style.getPropertyValue('--st-echo-fill'), '', `${input.name}: the input stays bare`);
  }
  assert.equal(document.querySelector('[name="visual.opacity"]').closest('.st-echo-settings-range').querySelector('output').textContent, '93%');
  // Selects and text-like inputs: SillyTavern's text_pole, label on the left of the same row.
  for (const input of all('select, input[type=number], input[type=text], input[type=url], input[type=password]')) {
    assert.ok(input.classList.contains('text_pole'), input.name);
    const row = input.parentElement;
    assert.ok(row.classList.contains('st-echo-settings-row'), input.name);
    assert.ok(row.firstElementChild.classList.contains('st-echo-settings-label'), input.name);
    assert.equal(row.lastElementChild, input, input.name);
  }
  assert.ok(document.querySelector('[name="prompts.block"]').classList.contains('text_pole'));
  for (const node of all('button[data-action]')) assert.ok(node.classList.contains('menu_button'), node.dataset.action);
  for (const input of all('input, select, textarea')) {
    assert.equal(input.style.width, '', input.name); assert.equal(input.style.height, '', input.name);
  }
  // Colours: a swatch and «авто» in the right part of one row.
  const accent = document.querySelector('[name="visual.accent"]');
  assert.ok(accent.closest('.st-echo-settings-row').classList.contains('st-echo-settings-color'));
  assert.equal(accent.getAttribute('aria-label'), 'Акцент');
  assert.equal(accent.nextElementSibling.dataset.action, 'auto');
  click('auto');
});

test('style.css: compact sliders, theme-sized checkboxes, 13 px labels and 12 px hints, container query', () => {
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = selector => css.match(new RegExp(`(^|\\n)${escape(selector)} \\{([^}]*)\\}`))?.[2] ?? '';
  // SPEC §19.1: the native input is invisible and stretched over a 4 px div track with an 18 px div knob.
  const range = rule('.st-echo-settings .st-echo-settings-slider > input.st-echo-range-compact');
  assert.match(range, /position: absolute; inset: 0;/);
  assert.match(range, /width: 100%; height: 28px; min-height: 0;/);
  assert.match(range, /opacity: 0;/, 'the host paints its own range bar; at opacity 0 nothing shows');
  assert.match(range, /background: transparent;/);
  assert.match(rule('.st-echo-settings-slider'), /height: 28px;/);
  assert.match(rule('.st-echo-settings-track'), /height: 4px; border-radius: 999px;/);
  assert.match(rule('.st-echo-settings-track::before'), /width: var\(--st-echo-fill, 0%\);/);
  const knob = rule('.st-echo-settings-knob');
  assert.match(knob, /left: var\(--st-echo-fill, 0%\); width: 18px; height: 18px;/);
  assert.match(css, /@media \(max-width: 699\.98px\) \{ \.st-echo-settings-range\[data-wide\] \{ display: none; \} \}/, 'panel width is a desktop control');
  const settingsRules = [...css.slice(css.indexOf('.st-echo-settings {')).matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .map(([, selector, declarations]) => [selector.replace(/\/\*[\s\S]*?\*\//g, '').replace(/:not\([^)]*\)/g, '').trim(), declarations]);
  for (const [selector, declarations] of settingsRules.filter(([selector]) => /checkbox|settings-check/.test(selector))) {
    assert.doesNotMatch(declarations, /(^|[\s;])(width|height): 36px/, `no giant checkboxes: ${selector}`);
  }
  assert.match(rule('.st-echo-settings input[type="checkbox"]'), /min-height: 0;/);
  assert.ok(css.includes('.st-echo-settings :is(select, input:not([type="checkbox"]):not([type="range"]):not([type="color"])'), '36 px tap height skips checkboxes and sliders');
  assert.match(rule('.st-echo-settings-body'), /font-size: 13px;/);
  assert.match(rule('.st-echo-settings-hint'), /font-size: 12px;/);
  assert.match(rule('.st-echo-settings-heading'), /text-transform: uppercase;/);
  assert.match(rule('.st-echo-settings-row'), /grid-template-columns: minmax\(0, 1fr\) 45%;/);
  assert.match(css, /@container \(max-width: 480px\) \{\s*\.st-echo-settings-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});

test('background picture: file picker stores a shrunk data URL, too big and unreadable pictures are refused', async t => {
  const seen = [];
  let result = PICTURE;
  const encodeImage = async (file, options) => { seen.push([file.name, options.fill]); if (result instanceof Error) throw result; return result; };
  const { dom, document, find, runtime } = setup(t, { encodeImage });
  const pick = async name => {
    const input = find('bgFile');
    Object.defineProperty(input, 'files', { configurable: true, value: [new dom.window.File(['synthetic'], name, { type: 'image/png' })] });
    input.dispatchEvent(new dom.window.Event('change')); await tick();
  };
  const note = () => document.querySelector('[data-result=bg]').textContent;
  assert.equal(find('bgFile').accept, 'image/*');
  assert.equal(document.querySelector('[data-action=bgRemove]').disabled, true);
  assert.equal(find('visual.bgDim').disabled, true); assert.equal(find('visual.bgFit').disabled, true);
  assert.equal(document.querySelector('.st-echo-settings-thumb').textContent, 'нет фона');
  await pick('gradient.png');
  assert.deepEqual(seen, [['gradient.png', '#0e0e12']], 'transparent parts take the default dark glass');
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ visual: { bgImage: PICTURE } }]);
  const thumb = document.querySelector('.st-echo-settings-thumb');
  assert.match(thumb.style.backgroundImage, /^url\("?data:image\/png;base64,/);
  assert.equal(thumb.hasAttribute('data-empty'), false);
  assert.equal(find('bgUrl').value, '', 'a picture from a file is not shown as a link');
  assert.equal(document.querySelector('[data-action=bgRemove]').disabled, false);
  assert.equal(find('visual.bgDim').disabled, false);
  const writes = runtime.callsOf('updateSettings').length;
  result = `data:image/jpeg;base64,${'A'.repeat(BG_MAX_LENGTH)}`;
  await pick('huge.jpg');
  assert.equal(runtime.callsOf('updateSettings').length, writes, 'still over the limit after shrinking: nothing is stored');
  assert.match(note(), /больше 800 КБ/);
  result = new Error('decode');
  await pick('broken.png');
  assert.equal(runtime.callsOf('updateSettings').length, writes);
  assert.match(note(), /Не удалось прочитать картинку/);
  document.querySelector('[data-action=bgRemove]').click();
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ visual: { bgImage: null } }]);
  assert.equal(note(), '');
  assert.equal(thumb.hasAttribute('data-empty'), true);
});

test('background picture: a link is checked, emptying it removes a linked picture, dim and fit are written', async t => {
  const { document, find, change, runtime } = setup(t);
  const note = () => document.querySelector('[data-result=bg]').textContent;
  change('bgUrl', 'javascript:alert(1)');
  assert.equal(runtime.callsOf('updateSettings').length, 0);
  assert.match(note(), /http:\/\/ или https:\/\//);
  change('bgUrl', 'https://example.org/a b.png');
  assert.equal(runtime.callsOf('updateSettings').length, 0, 'spaces would break url("…")');
  change('bgUrl', '  https://example.org/paper.webp ');
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ visual: { bgImage: 'https://example.org/paper.webp' } }]);
  assert.equal(note(), '');
  assert.equal(find('bgUrl').value, 'https://example.org/paper.webp');
  change('visual.bgFit', 'contain');
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ visual: { bgFit: 'contain' } }]);
  assert.deepEqual([...find('visual.bgFit').options].map(o => o.textContent), ['Заполнить', 'Целиком', 'Плиткой']);
  change('visual.bgDim', '0.6');
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ visual: { bgDim: 0.6 } }]);
  assert.equal(find('visual.bgDim').closest('.st-echo-settings-range').querySelector('output').textContent, '60%');
  change('bgUrl', '');
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ visual: { bgImage: null } }]);
  // With a picture from a file, an empty link field leaves the picture alone.
  await runtime.updateSettings({ visual: { bgImage: PICTURE } });
  const writes = runtime.callsOf('updateSettings').length;
  change('bgUrl', '');
  assert.equal(runtime.callsOf('updateSettings').length, writes);
});

test('downscale helpers: fit within 1280 px, JPEG at 0.82 over the panel colour, no upscaling', async () => {
  assert.equal(BG_MAX_SIDE, 1280); assert.equal(BG_QUALITY, 0.82);
  assert.deepEqual(fitWithin(4000, 2000), { width: 1280, height: 640 });
  assert.deepEqual(fitWithin(900, 3000), { width: 384, height: 1280 });
  assert.deepEqual(fitWithin(300, 200), { width: 300, height: 200 });
  assert.deepEqual(fitWithin(0, 0), { width: 1, height: 1 });
  const fakeCanvas = () => {
    const ops = [];
    const context = { set fillStyle(value) { ops.push(['fillStyle', value]); }, set imageSmoothingQuality(value) { ops.push(['quality', value]); },
      fillRect: (...args) => ops.push(['fillRect', ...args]), drawImage: (image, ...args) => ops.push(['drawImage', image.id, ...args]) };
    return { ops, getContext: kind => (ops.push(['getContext', kind]), context), toDataURL: (...args) => (ops.push(['toDataURL', ...args]), 'data:image/jpeg;base64,AAAA') };
  };
  const canvas = fakeCanvas();
  assert.equal(downscaleImage({ id: 'photo', width: 2560, height: 1440 }, { canvas, fill: '#f4efe6' }), 'data:image/jpeg;base64,AAAA');
  assert.deepEqual([canvas.width, canvas.height], [1280, 720]);
  assert.deepEqual(canvas.ops, [['getContext', '2d'], ['fillStyle', '#f4efe6'], ['fillRect', 0, 0, 1280, 720], ['quality', 'high'],
    ['drawImage', 'photo', 0, 0, 1280, 720], ['toDataURL', 'image/jpeg', 0.82]]);
  // encodeImageFile: decode through createImageBitmap, draw on a fresh canvas, release the bitmap.
  let closed = false;
  const target = fakeCanvas(), bitmap = { id: 'bitmap', width: 640, height: 480, close: () => { closed = true; } };
  const fakeDocument = { defaultView: { createImageBitmap: async file => (assert.equal(file, 'file'), bitmap) }, createElement: tag => (assert.equal(tag, 'canvas'), target) };
  assert.equal(await encodeImageFile('file', { document: fakeDocument }), 'data:image/jpeg;base64,AAAA');
  assert.deepEqual([target.width, target.height], [640, 480]);
  assert.deepEqual(target.ops[1], ['fillStyle', '#0e0e12']);
  assert.equal(closed, true);
  assert.deepEqual([formatValue('opacity', 0.93), formatValue('bgDim', '0.45'), formatValue('widthVw', 80), formatValue('blur', 'x')], ['93%', '45%', '80vw', '']);
});

test('«Как в Sable Trackers» applies the Sable look, or says Sable Trackers was not found for a few seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const settle = async () => { for (let i = 0; i < 6; i++) await null; };
  const missing = setup(t);
  const button = missing.document.querySelector('[data-action=sable]');
  assert.equal(button.textContent, 'Как в Sable Trackers');
  assert.equal(button.closest('[data-group]').dataset.group, 'visual');
  button.click(); await settle();
  assert.equal(missing.runtime.callsOf('importSableVisual').length, 1);
  assert.equal(button.textContent, 'Sable Trackers не найден');
  missing.runtime.emit();
  assert.equal(button.textContent, 'Sable Trackers не найден', 'a re-render keeps the message');
  t.mock.timers.tick(3000);
  assert.equal(button.textContent, 'Как в Sable Trackers');
  const sable = { opacity: 0.8, blur: 6, fontSize: 13, widthVw: 70, accent: '#b388ff', base: '#0b0b14', text: null, radius: 12, motion: false,
    spacing: 'compact', bgImage: PICTURE, bgDim: 0.3, bgFit: 'contain', cardFill: 0.2, icons: 'emoji', chipStyle: 'outline' };
  const found = setup(t, {}, { sableVisual: sable });
  const apply = found.document.querySelector('[data-action=sable]');
  apply.click(); await settle();
  assert.equal(apply.textContent, 'Как в Sable Trackers');
  const { chipSize, ...visual } = found.runtime.snapshot().settings.visual;
  const { cardFill, icons, chipStyle, ...known } = sable;
  assert.deepEqual(visual, { scale: 1, phoneFull: false, ...known });
  assert.equal(chipSize, 36, 'Echo\'s own key stays');
  assert.equal(found.find('visual.opacity').value, '0.8');
  assert.equal(found.find('visual.bgFit').value, 'contain');
});

test('SPEC §19.2–§19.3: the appearance group order with the size hints, the phone layout switch, a desktop-only width row', t => {
  const { document, find, runtime } = setup(t);
  const grid = document.querySelector('[data-group=visual] > .st-echo-settings-grid');
  const describe = node => node.querySelector('input, select')?.name ?? node.textContent.trim();
  assert.deepEqual([...grid.children].slice(0, 11).map(describe),
    ['visual.scale', 'visual.fontSize', 'visual.chipSize', 'visual.spacing', 'воздух между элементами', 'visual.opacity', 'visual.blur', 'visual.radius', 'visual.widthVw', 'visual.motion', 'visual.phoneFull']);
  const rowOf = name => find(name).closest('.st-echo-settings-range');
  for (const [name, hint] of [['visual.scale', 'вся панель целиком'], ['visual.fontSize', 'только шрифт'], ['visual.chipSize', 'высота слов-чипов и кнопок рядом']]) {
    assert.equal(rowOf(name).querySelector('.st-echo-settings-hint').textContent, hint, name);
    assert.equal(rowOf(name).lastElementChild.className, 'st-echo-settings-hint', `${name}: the hint is the last line of the row`);
  }
  for (const name of ['visual.opacity', 'visual.blur', 'visual.radius', 'visual.widthVw', 'visual.bgDim']) assert.equal(rowOf(name).querySelector('.st-echo-settings-hint'), null, name);
  assert.equal(rowOf('visual.widthVw').hasAttribute('data-wide'), true, 'panel width is a desktop control');
  assert.equal(rowOf('visual.scale').hasAttribute('data-wide'), false);
  assert.equal(find('visual.spacing').closest('.st-echo-settings-row').nextElementSibling.textContent, 'воздух между элементами');
  const phone = find('visual.phoneFull');
  assert.equal(phone.type, 'checkbox');
  assert.equal(phone.checked, false, 'side panel by default');
  assert.ok(phone.parentElement.classList.contains('checkbox_label'));
  assert.match(phone.parentElement.textContent, /На весь экран на телефоне/);
  phone.click();
  assert.deepEqual(runtime.callsOf('updateSettings').at(-1), [{ visual: { phoneFull: true } }]);
  assert.equal(find('visual.phoneFull').checked, true);
  const english = setup(t, { language: 'en' });
  assert.deepEqual([...english.document.querySelectorAll('[data-group=visual] .st-echo-settings-hint')].slice(0, 4).map(node => node.textContent),
    ['the whole panel', 'the font only', 'height of word chips and the buttons next to them', 'air between elements']);
  assert.match(english.find('visual.phoneFull').parentElement.textContent, /Full screen on phones/);
});
