// Settings block in SillyTavern's extensions tab (SPEC §11, §17.1–§17.3). Structure and sizes follow the Sable
// Trackers block: small upper-case group captions, one row per control (label left, control right), SillyTavern's
// own checkbox_label / text_pole / menu_button markup so the theme styles the controls, compact sliders. Every
// write goes through the runtime (SPEC §15); nothing here talks to SillyTavern directly.
import { t } from '../i18n.js';
import { BG_FITS, BG_MAX_LENGTH, DEFAULTS, normalizeBgImage, normalizeSettings } from '../settings.js';
import { dom, setValue, visualVars } from './drawer.js';

const get = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const patchFor = (path, value) => path.split('.').reverse().reduce((patch, key) => ({ [key]: patch }), value);
const dump = value => typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
const visualKeys = Object.keys(DEFAULTS.visual);
const NOTE_MS = 3000;                 // «Sable Trackers не найден» stays on the button this long
const URL_PLACEHOLDER = 'https://…';
const DEFAULT_BASE = '#0e0e12';       // the default dark glass; JPEG has no alpha, so transparent parts get it
// What an automatic colour swatch shows (dimmed): the default accent, the dark glass, the theme text.
const SWATCH = { 'visual.accent': '#f5f4ee', 'visual.base': DEFAULT_BASE, 'visual.text': '#eeeae7' };

// Slider readouts as in Sable Trackers: fractions in percent, sizes with their unit.
const PERCENT = new Set(['opacity', 'bgDim']);
const UNITS = { blur: 'px', fontSize: 'px', widthVw: 'vw', radius: 'px', chipSize: 'px' };
/** Readout of a visual slider value, e.g. ('opacity', 0.93) → '93%', ('blur', 14) → '14px'. */
export function formatValue(key, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (key === 'scale') return `${Math.round(n * 100)} %`;
  return PERCENT.has(key) ? `${Math.round(n * 100)}%` : `${n}${UNITS[key] ?? ''}`;
}

// Background pictures from a file (SPEC §17.2): long side at most BG_MAX_SIDE px, JPEG at BG_QUALITY.
export const BG_MAX_SIDE = 1280;
export const BG_QUALITY = 0.82;
/** Size that fits within max × max with the same aspect ratio; never upscales, never below 1 px. */
export function fitWithin(width, height, max = BG_MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
/** Draws a decoded picture (anything drawImage takes, with its size) on `canvas`, shrunk to BG_MAX_SIDE, and
 *  returns a JPEG data URL. `fill` paints under the picture first. */
export function downscaleImage(image, { canvas, fill = DEFAULT_BASE } = {}) {
  const { width, height } = fitWithin(image.naturalWidth || image.width, image.naturalHeight || image.height);
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = fill; context.fillRect(0, 0, width, height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', BG_QUALITY);
}
/** Browser only: decodes an image file and returns it as a shrunk JPEG data URL (downscaleImage). */
export async function encodeImageFile(file, { document = globalThis.document, fill = DEFAULT_BASE } = {}) {
  const bitmap = await document.defaultView.createImageBitmap(file);
  try { return downscaleImage(bitmap, { canvas: document.createElement('canvas'), fill }); } finally { bitmap.close?.(); }
}

export function mountSettings(runtime, { document = globalThis.document, language, encodeImage = encodeImageFile } = {}) {
  const host = document?.querySelector('#extensions_settings2') ?? document?.querySelector('#extensions_settings');
  if (!host) return { unmount() {} };
  const win = document.defaultView, h = dom(document), labels = [], fields = [], cleanups = [], timers = new Map();
  let snap = runtime.snapshot(), disposed = false, armed = false, resetTimer, logSignature, sableMissing = false, sableTimer;
  const settings = () => normalizeSettings(snap.settings ?? { ...snap, jev: { ...DEFAULTS.jev, ...snap.jev } });
  const lang = () => language ?? snap.language ?? 'ru';
  const L = (key, vars) => t(`settings.${key}`, lang(), vars);
  // [node, i18n key, attribute (textContent when omitted)]; re-applied on every render.
  const label = (node, key, attribute) => { labels.push([node, key, attribute]); return node; };
  const text = (tag, key, attrs = {}) => label(h(tag, attrs), key);
  /** SillyTavern's own classes stay unprefixed, so the theme styles the control. */
  const st = (node, ...classes) => { node.classList.add(...classes); return node; };
  const listen = (node, event, fn) => { node.addEventListener(event, fn); cleanups.push(() => node.removeEventListener(event, fn)); };
  const root = h('div', { class: 'settings', id: 'st-echo-settings' });
  const drawer = st(h('div'), 'inline-drawer');
  const header = st(h('button', { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'st-echo-settings-body' }), 'inline-drawer-toggle', 'inline-drawer-header');
  const chevron = st(h('i', { 'aria-hidden': 'true' }), 'inline-drawer-icon', 'fa-solid', 'fa-circle-chevron-down', 'down');
  header.append(text('b', 'title'), chevron);
  const body = st(h('div', { class: 'settings-body', id: 'st-echo-settings-body', hidden: true }), 'inline-drawer-content');
  root.append(drawer); drawer.append(header, body); host.append(root);
  const notice = h('output', { class: 'settings-hint settings-notice', role: 'status' }); body.append(notice);
  async function call(method, ...args) {
    try { return await runtime[method](...args); }
    catch { if (!disposed) notice.textContent = L('error.other'); return null; }
  }
  const write = (path, value) => call('updateSettings', patchFor(path, value));
  function expand(open) {
    body.hidden = !open; body.style.display = open ? 'block' : 'none'; header.setAttribute('aria-expanded', String(open));
    chevron.classList.toggle('down', !open); chevron.classList.toggle('up', open);
    chevron.classList.toggle('fa-circle-chevron-down', !open); chevron.classList.toggle('fa-circle-chevron-up', open);
  }
  // SillyTavern toggles every .inline-drawer-toggle from a document handler; this block opens and closes itself.
  listen(header, 'click', event => { event.stopPropagation(); expand(body.hidden); });

  /* ---------- building blocks (Sable Trackers' structure) ---------- */
  /** A group: an upper-case caption and a grid of rows (two per line in a wide column, one on phones). */
  function group(id) {
    const danger = id === 'danger';
    const node = h(danger ? 'details' : 'section', { class: `settings-group ${danger ? 'settings-danger' : ''}`, 'data-group': id });
    const caption = text('h4', `group.${id}`, { class: 'settings-heading' });
    if (danger) node.append(h('summary', null, caption)); else node.append(caption);
    const grid = h('div', { class: 'settings-grid' }); node.append(grid);
    body.append(node); return grid;
  }
  const hint = (parent, key) => { const node = text('p', key, { class: 'settings-hint' }); parent.append(node); return node; };
  const buttons = parent => { const node = h('div', { class: 'settings-buttons' }); parent.append(node); return node; };
  function button(parent, key, fn, cls = '') {
    const node = st(text('button', key, { type: 'button', 'data-action': key, class: cls }), 'menu_button');
    parent.append(node); listen(node, 'click', fn); return node;
  }
  // `toggle` = [on, off] values for a checkbox that edits a two-value setting (e.g. candidates: chips / collapsed).
  function control(path, type, { choices, range, toggle } = {}) {
    const input = h(type === 'select' ? 'select' : type === 'textarea' ? 'textarea' : 'input', { name: path });
    if (!['select', 'textarea'].includes(type)) input.type = type;
    if (['select', 'textarea', 'number', 'text', 'url', 'password'].includes(type)) st(input, 'text_pole');
    if (type === 'number') input.inputMode = 'numeric';
    if (type === 'range') input.classList.add('st-echo-range-compact');
    if (choices) for (const [value, key] of choices) input.append(text('option', key, { value }));
    if (range) [input.min, input.max, input.step] = range;
    const output = type === 'range' ? h('output', { class: 'settings-value' }) : null;
    const field = { input, path, type, output, toggle };
    fields.push(field);
    const save = () => {
      timers.delete(path);
      let value = type === 'checkbox' ? input.checked : input.value;
      if (toggle) value = toggle[value ? 0 : 1];
      if (range) {
        if (value === '' || !Number.isFinite(Number(value))) return;
        value = Math.min(Number(input.max), Math.max(Number(input.min), Number(value)));
        if (Number(input.step) === 1) value = Math.round(value);
        input.value = String(value);
      }
      if (path === 'prompts.block') value = value.slice(0, 4000);
      if (!disposed) write(path, value === '' && path === 'altProfileId' ? null : value);
    };
    listen(input, 'change', () => { clearTimeout(timers.get(path)); save(); });
    if (type === 'range') listen(input, 'input', () => {
      showRange(field); clearTimeout(timers.get(path)); timers.set(path, setTimeout(save, 150));
    });
    return field;
  }
  /** SillyTavern checkbox: the box first, then the caption (and an optional one-line hint under it). */
  function check(parent, path, { toggle, sub } = {}) {
    const { input } = control(path, 'checkbox', { toggle });
    const caption = h('span', { class: 'settings-label' }, text('span', path));
    if (sub) caption.append(text('small', sub));
    parent.append(st(h('label', { class: 'settings-check' }, input, caption), 'checkbox_label'));
    return input;
  }
  /** Label left, control right (number inputs, selects: ~45% of the row; text inputs a little wider). */
  function row(parent, path, type, options) {
    const { input } = control(path, type, options);
    const wide = ['text', 'url', 'password'].includes(type);
    parent.append(h('label', { class: `settings-row ${wide ? 'settings-text' : ''}` }, text('span', path, { class: 'settings-label' }), input));
    return input;
  }
  /** Themed slider (SPEC §19.1): label and value on one line, then a box with a div track and knob (placed through
   *  --st-echo-fill on the box) under the invisible, full-size range input. `hint` adds the one-line explanation
   *  of SPEC §19.2; `wide` marks a desktop-only row (style.css hides it on phones). */
  function slider(parent, path, range, { hint: hintKey, wide } = {}) {
    const field = control(path, 'range', { range }), { input, output } = field;
    input.id = `st-echo-s-${path.replace(/\W+/g, '-')}`; output.setAttribute('for', input.id);
    field.box = h('div', { class: 'settings-slider' }, h('div', { class: 'settings-track', 'aria-hidden': 'true' }, h('div', { class: 'settings-knob' })), input);
    const row = h('div', { class: 'settings-range', 'data-wide': wide ? '' : null }, label(h('label', { class: 'settings-label', for: input.id }), path), output, field.box);
    if (hintKey) hint(row, hintKey);
    parent.append(row);
    return input;
  }
  function showRange({ input, output, path, box }) {
    const min = Number(input.min), max = Number(input.max), value = Number(input.value);
    output.textContent = formatValue(path.split('.').pop(), input.value);
    (box ?? input).style.setProperty('--st-echo-fill', `${max > min ? Math.round((value - min) / (max - min) * 1000) / 10 : 0}%`);
  }
  const choices = values => values.map(value => [value, `choice.${value}`]);

  /* ---------- groups, in SPEC §11 order ---------- */
  const main = group('main'); check(main, 'enabled'); row(main, 'language', 'select', { choices: choices(['ru', 'en']) }); check(main, 'hints');
  check(main, 'candidates', { toggle: ['chips', 'collapsed'] });

  const jev = group('jev'); row(jev, 'jev.host', 'select', { choices: choices(['rout', 'openrouter', 'nanogpt', 'custom']) });
  const custom = h('div', { class: 'settings-cells' }); jev.append(custom); row(custom, 'jev.endpoint', 'url'); row(custom, 'jev.model', 'text');
  const key = row(jev, 'jev.apiKey', 'password'); key.autocomplete = 'off'; hint(jev, 'keyHint');
  const testRow = buttons(jev), testResult = h('output', { role: 'status', 'data-result': 'jev', class: 'settings-result' });
  const test = button(testRow, 'test', async () => {
    test.disabled = true; testResult.textContent = L('testing');
    const result = await call('testJev');
    if (disposed) return;
    test.disabled = false;
    testResult.textContent = result?.ok ? L('testOk', { ms: Math.round(result.ms) }) : L(`error.${['key', 'credit', 'timeout', 'config', 'network'].includes(result?.error?.kind) ? result.error.kind : 'other'}`);
  });
  testRow.append(testResult); check(jev, 'jev.enabled');
  for (const id of Object.keys(DEFAULTS.jev.sensors)) check(jev, `jev.sensors.${id}`, { sub: `sensor.${id}` });

  const miner = group('miner');
  for (const [id, min, max] of [['replies', 20, 200], ['minChars', 100, 600], ['minDf', 2, 6]]) row(miner, `miner.${id}`, 'number', { range: [min, max, 1] });

  const inject = group('inject'); check(inject, 'inject.enabled'); row(inject, 'inject.depth', 'number', { range: [0, 10, 1] });
  row(inject, 'inject.language', 'select', { choices: choices(['en', 'ru']) });

  const alt = group('alt'), profiles = row(alt, 'altProfileId', 'select'); hint(alt, 'altHint');

  const regex = group('regex'); row(regex, 'regexDefault', 'select', { choices: choices(['prompt', 'display', 'both']) });
  for (const mode of ['prompt', 'display', 'both']) hint(regex, `regex.${mode}`);
  row(regex, 'regexScope', 'select', { choices: choices(['character', 'global']) });
  for (const scope of ['character', 'global']) hint(regex, `scope.${scope}`);

  // SPEC §19.2 order: the size controls with their hints, then the glass, then layout switches, colours, background.
  const visual = group('visual');
  for (const [id, min, max, step, options] of [['scale', 0.7, 1.2, .05, { hint: 'visual.scaleHint' }], ['fontSize', 12, 24, 1, { hint: 'visual.fontSizeHint' }],
    ['chipSize', 28, 48, 1, { hint: 'visual.chipSizeHint' }]]) slider(visual, `visual.${id}`, [min, max, step], options);
  row(visual, 'visual.spacing', 'select', { choices: choices(['compact', 'cozy', 'roomy']) }); hint(visual, 'visual.spacingHint');
  for (const [id, min, max, step, options] of [['opacity', 0, 1, .01], ['blur', 0, 40, 1], ['radius', 0, 40, 1], ['widthVw', 20, 100, 1, { wide: true }]]) slider(visual, `visual.${id}`, [min, max, step], options);
  check(visual, 'visual.motion'); check(visual, 'visual.phoneFull');
  // Colours: a swatch plus «авто», which stores the default (dark glass / theme text).
  const autoButtons = [];
  for (const id of ['accent', 'base', 'text']) {
    const { input } = control(`visual.${id}`, 'color');
    label(input, `visual.${id}`, 'aria-label');
    const pair = h('span', { class: 'settings-pair' }, input);
    const auto = button(pair, 'auto', () => write(`visual.${id}`, DEFAULTS.visual[id]), 'settings-auto');
    visual.append(h('div', { class: 'settings-row settings-color' }, text('span', `visual.${id}`, { class: 'settings-label' }), pair));
    autoButtons.push([auto, id]);
  }

  // Background picture (SPEC §17.2): a file (shrunk to a JPEG data URL, so phone and PC share it) or an http(s) link.
  const bgBlock = h('div', { class: 'settings-wide settings-bgblock' }); visual.append(bgBlock);
  const thumbText = h('span');
  const thumb = label(h('div', { class: 'settings-thumb', role: 'img' }, thumbText), 'visual.bgImage', 'aria-label');
  const bgFile = h('input', { type: 'file', name: 'bgFile', accept: 'image/*', hidden: true });
  const bgButtons = h('div', { class: 'settings-buttons' });
  button(bgButtons, 'bgFile', () => bgFile.click());
  const bgRemove = button(bgButtons, 'bgRemove', () => { bgNote.textContent = ''; write('visual.bgImage', null); });
  bgBlock.append(text('span', 'visual.bgImage', { class: 'settings-label settings-caption' }), h('div', { class: 'settings-bg' }, thumb, bgButtons), bgFile);
  const bgUrl = st(h('input', { type: 'url', name: 'bgUrl', inputmode: 'url', autocomplete: 'off', spellcheck: 'false' }), 'text_pole');
  bgBlock.append(h('label', { class: 'settings-row settings-text' }, text('span', 'bgUrl', { class: 'settings-label' }), bgUrl));
  const bgNote = h('output', { role: 'status', class: 'settings-hint settings-note', 'data-result': 'bg' }); bgBlock.append(bgNote);
  const bgDim = slider(visual, 'visual.bgDim', [0, 0.9, 0.01]);
  const bgFit = row(visual, 'visual.bgFit', 'select', { choices: choices(BG_FITS) });
  hint(visual, 'bgHint');
  function storeImage(value, failure) {
    if (typeof value === 'string' && value.trim().length > BG_MAX_LENGTH) { bgNote.textContent = L('bgTooBig'); return; }
    const image = normalizeBgImage(value);
    if (!image) { bgNote.textContent = L(failure); return; }
    bgNote.textContent = ''; write('visual.bgImage', image);
  }
  listen(bgFile, 'change', async () => {
    const selected = bgFile.files?.[0]; bgFile.value = ''; if (!selected) return;
    let url;
    try { url = await encodeImage(selected, { document, fill: settings().visual.base ?? DEFAULT_BASE }); }
    catch { if (!disposed) bgNote.textContent = L('bgReadFailed'); return; }
    if (!disposed) storeImage(url, 'bgReadFailed');
  });
  listen(bgUrl, 'change', () => {
    const value = bgUrl.value.trim(), current = settings().visual.bgImage;
    // Emptying the field removes a linked picture; a picture from a file is removed with «Убрать».
    if (value) storeImage(value, 'bgBadUrl');
    else if (current && !current.startsWith('data:')) { bgNote.textContent = ''; write('visual.bgImage', null); }
  });
  let thumbImage = null;
  function renderBackground(values) {
    const image = values.visual.bgImage, fromFile = !!image?.startsWith('data:');
    // normalizeSettings allows only quote- and bracket-free URLs; a data URL is only re-set when it changes.
    if (image !== thumbImage) { thumb.style.backgroundImage = image ? `url("${image}")` : ''; thumbImage = image; }
    thumb.toggleAttribute('data-empty', !image);
    thumbText.textContent = image ? '' : L('bgNone');
    bgRemove.disabled = !image; bgDim.disabled = !image; bgFit.disabled = !image;
    setValue(bgUrl, image && !fromFile ? image : '');
    bgUrl.placeholder = fromFile ? L('bgFromFile') : URL_PLACEHOLDER;
  }

  // «Как в Sable Trackers» (SPEC §17.3), then the theme file round trip.
  const themeRow = buttons(visual);
  const sable = button(themeRow, 'sable', async () => {
    const applied = await call('importSableVisual');
    if (disposed || applied !== false) return;
    sableMissing = true; sable.textContent = L('sableMissing'); clearTimeout(sableTimer);
    sableTimer = setTimeout(() => { sableMissing = false; sable.textContent = L('sable'); }, NOTE_MS);
  });
  const file = h('input', { type: 'file', name: 'themeFile', accept: '.json,application/json', hidden: true }); themeRow.append(file);
  button(themeRow, 'export', () => {
    const url = win.URL.createObjectURL(new win.Blob([JSON.stringify({ format: 'sable-theme', version: 1, visual: settings().visual }, null, 2)], { type: 'application/json' }));
    const link = h('a', { href: url, download: 'sable-echo-theme.json', hidden: true }); root.append(link); link.click(); link.remove();
    setTimeout(() => win.URL.revokeObjectURL(url), 1000);
  });
  button(themeRow, 'import', () => file.click());
  // A theme file of either extension: every visual key Echo knows applies (bgImage, bgDim and bgFit included).
  listen(file, 'change', async () => {
    const selected = file.files?.[0]; file.value = ''; if (!selected) return;
    try {
      const source = typeof selected.text === 'function' ? await selected.text() : await new Promise((resolve, reject) => {
        const reader = new win.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(selected);
      });
      const data = JSON.parse(source.replace(/^﻿/, '')), raw = data?.visual ?? data;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
      const known = Object.fromEntries(visualKeys.filter(id => Object.hasOwn(raw, id)).map(id => [id, raw[id]]));
      if (!Object.keys(known).length) throw new Error();
      if (disposed) return;
      await call('updateSettings', { visual: known }); notice.textContent = L('imported');
    } catch { if (!disposed) notice.textContent = L('invalidTheme'); }
  });

  const danger = group('danger');
  const template = control('prompts.block', 'textarea').input; template.maxLength = 4000; template.rows = 6;
  danger.append(h('label', { class: 'settings-stack settings-wide' }, text('span', 'prompts.block', { class: 'settings-label' }), template));
  hint(danger, 'templateHint');
  const blockRow = buttons(danger); button(blockRow, 'default', () => write('prompts.block', null));
  const preview = h('pre', { class: 'settings-dump settings-wide', 'data-preview': '', hidden: true });
  button(blockRow, 'preview', () => { preview.textContent = runtime.preview().text; preview.hidden = false; });
  async function copy(value) {
    try { await win.navigator.clipboard.writeText(value); notice.textContent = L('copied'); }
    catch { notice.textContent = L('copyFailed'); }
  }
  button(blockRow, 'copy', () => copy(preview.textContent)); danger.append(preview);
  danger.append(text('h5', 'log', { class: 'settings-sub settings-wide' })); const logs = h('div', { class: 'settings-wide' }); danger.append(logs);
  const logRow = buttons(danger); button(logRow, 'clear', () => call('clearLog')); button(logRow, 'copyLog', () => copy(dump(snap.log ?? [])));
  const reset = button(buttons(danger), 'reset', async () => {
    if (!armed) { armed = true; reset.textContent = L('confirmReset'); resetTimer = setTimeout(disarm, 4000); return; }
    disarm(); await call('resetCharacter');
  });
  function disarm() { armed = false; clearTimeout(resetTimer); reset.textContent = L('reset'); }

  let previousAvatar = snap.avatar, profileSignature;
  function render(next) {
    if (disposed) return;
    if (next.avatar !== previousAvatar) disarm(); previousAvatar = next.avatar; snap = next;
    const values = settings(); root.lang = lang();
    for (const [node, key, attribute] of labels) { if (attribute) node.setAttribute(attribute, L(key)); else node.textContent = L(key); }
    if (armed) reset.textContent = L('confirmReset');
    if (sableMissing) sable.textContent = L('sableMissing');
    const signature = JSON.stringify([snap.profiles, values.altProfileId, lang()]);
    if (signature !== profileSignature) {
      profileSignature = signature;
      profiles.replaceChildren(h('option', { value: '' }, L('none')), ...(snap.profiles ?? []).map(p => h('option', { value: p.id }, p.name)));
      if (values.altProfileId && !(snap.profiles ?? []).some(p => p.id === values.altProfileId)) profiles.append(h('option', { value: values.altProfileId }, L('unavailable')));
    }
    for (const field of fields) {
      const { input, path, type, output, toggle } = field, value = get(values, path);
      if (type === 'checkbox') input.checked = toggle ? value === toggle[0] : !!value;
      else if (!timers.has(path)) setValue(input, value ?? SWATCH[path] ?? '');
      if (output) showRange(field);
    }
    custom.hidden = values.jev.host !== 'custom';
    for (const [auto, id] of autoButtons) auto.setAttribute('aria-pressed', String(values.visual[id] === DEFAULTS.visual[id]));
    renderBackground(values);
    for (const [name, value] of Object.entries(visualVars(values.visual).vars)) {
      if (value === null) root.style.removeProperty(`--st-echo-${name}`); else root.style.setProperty(`--st-echo-${name}`, value);
    }
    const nextLog = JSON.stringify([snap.log, lang()]);
    if (logSignature !== nextLog) {
      logSignature = nextLog;
      logs.replaceChildren(...[...(snap.log ?? [])].sort((a, b) => b.at - a.at).map(entry => {
        const status = ['ok', 'error', 'skipped'].includes(entry.status) ? entry.status : 'error';
        return h('details', { class: 'settings-log' }, h('summary', {}, `${entry.kind === 'alt' ? L('group.alt') : L('group.jev')} · ${L(`status.${status}`)} · ${L('ms', { ms: entry.ms ?? 0 })}`),
          h('h5', { class: 'settings-sub' }, L('request')), h('pre', { class: 'settings-dump' }, dump(entry.request)),
          h('h5', { class: 'settings-sub' }, L('response')), h('pre', { class: 'settings-dump' }, dump(entry.response ?? entry.error)));
      }));
      if (!logs.childNodes.length) logs.append(h('p', { class: 'settings-hint' }, L('emptyLog')));
    }
  }
  let openTimer;
  const openSettings = () => {
    // Open SillyTavern's own Extensions drawer through its toggle; never force display on the host's elements.
    const hidden = !host.getClientRects().length;
    if (hidden) document.querySelector('#extensions-settings-button .drawer-toggle')?.click();
    const go = () => { expand(true); jev.parentElement.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); };
    if (hidden) { clearTimeout(openTimer); openTimer = win.setTimeout(go, 400); } else go();
  };
  listen(document, 'sable-echo:settings', openSettings);
  const unsubscribe = runtime.subscribe(render);
  return { unmount() { disposed = true; unsubscribe(); cleanups.forEach(fn => fn()); timers.forEach(clearTimeout); clearTimeout(resetTimer); clearTimeout(sableTimer); clearTimeout(openTimer); root.remove(); } };
}
