// Sable Echo drawer (SPEC §13, §13.1, round 2 of §16). It talks only to the runtime of SPEC §15.
// The panel is rebuilt from (snapshot, UI state) on every change and morphed into the live tree, so the scroll
// position, focus, open editors and half-typed inputs survive re-renders. Every string from the chat or a model
// reaches the DOM as a text node or an attribute value, never as markup.
//
// Snapshot fields used beyond SPEC §15 (the glue has to provide them):
// - altProfile: bool — a connection profile for alternatives is set; «Предложить» is hidden without it.
// - bans[].findRegex: string — regexFor(words, cuts), shown in the regex sub-row.
// - bans[].sinceReplies: number — narrator replies since the ban, the period of «снова: N за M ответов».
// - ban / banOpener / banPattern / banText resolve to the new ban id; the undo toast calls unban(id).
//   (Without it the drawer falls back to the id that appeared in the next snapshot.)
import { t } from '../i18n.js';
import { BG_FITS, normalizeBgImage } from '../settings.js';

const SVG = 'http://www.w3.org/2000/svg';
const TOAST_MS = 4000;
const ROWS = 5;            // candidate rows before «Ещё N»
const CHIP_LIST = 5;       // ban chips up to this many entries; longer lists become rows
const SCORE_MAX = 4;       // Jev score scale (SPEC §5)
const SWIPE_CLOSE = 72;    // px the view sheet has to travel down to close
const MIN_PANEL = 420;     // desktop panel width floor, as in style.css
const SLIDE_MS = 150;      // a dragged slider writes at most this often; release writes at once
const RX_NOTE_MS = 6000;   // «появится в списке регексов после перезагрузки» stays this long after an install (SPEC §19.4)
/** v0.1 chip size names, still read when an old value reaches the drawer (settings migrate them, SPEC §16.3). */
export const CHIP_SIZES = Object.freeze({ compact: 28, normal: 36, large: 44 });
/** Chip height in px from visual.chipSize (number or v0.1 name), clamped to 28–48. */
export function chipPx(value) {
  const px = Number(Object.hasOwn(CHIP_SIZES, value) ? CHIP_SIZES[value] : value);
  return value === null || value === '' || typeof value === 'boolean' || !Number.isFinite(px) ? 36 : Math.min(48, Math.max(28, Math.round(px)));
}
/** The ⚙ view sliders of SPEC §16.3, in order. `wide` = only on screens of 700 px and more; `hint` = the one-line
 *  explanation under the size controls (SPEC §19.2). */
export const VIEW_SLIDERS = Object.freeze([
  { key: 'scale', label: 'view.scale', hint: 'view.hint.scale', min: 0.7, max: 1.2, step: 0.05, fallback: 1 },
  { key: 'fontSize', label: 'view.text', hint: 'view.hint.text', min: 12, max: 18, step: 1, fallback: 13 },
  { key: 'chipSize', label: 'view.chips', hint: 'view.hint.chips', min: 28, max: 48, step: 1, fallback: 36 },
  { key: 'opacity', label: 'view.opacity', min: 0.5, max: 1, step: 0.01, fallback: 0.93 },
  { key: 'blur', label: 'view.blur', min: 0, max: 30, step: 1, fallback: 13 },
  { key: 'radius', label: 'view.radius', min: 8, max: 24, step: 1, fallback: 18 },
  { key: 'widthVw', label: 'view.width', min: 60, max: 100, step: 1, fallback: 80, wide: true },
]);
const SENSORS = ['repeats', 'speaks', 'change'];
const COLOURS = ['green', 'amber', 'red'];
const REGEX_MODES = ['prompt', 'display', 'both'];
const REGEX_SCOPES = ['character', 'global'];
const JEV_ERRORS = ['key', 'credit', 'timeout', 'config', 'network', 'other'];
const CARDS = ['cands', 'pats', 'bans'];
const DEFAULT_ACCENT = '#f5f4ee';
const BLACK = '0,0,0', WHITE = '255,255,255';

// Stroke icons on a 24×24 grid, built with createElementNS (no markup strings).
const ICONS = {
  logo: [['circle', { cx: 5, cy: 12, r: 1.8, fill: 'currentColor', stroke: 'none' }], ['path', { d: 'M9 8.5a5 5 0 0 1 0 7' }],
    ['path', { d: 'M12.5 5.5a9.5 9.5 0 0 1 0 13', opacity: '.65' }], ['path', { d: 'M16 3a13 13 0 0 1 0 18', opacity: '.35' }]],
  refresh: [['path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }], ['path', { d: 'M20 4v5h-5' }]],
  gear: [['circle', { cx: 12, cy: 12, r: 3 }], ['circle', { cx: 12, cy: 12, r: 6.5 }],
    ['path', { d: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1' }]],
  x: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  pin: [['path', { d: 'M9 3h6v6l2.5 3.5h-11L9 9V3z' }], ['path', { d: 'M8 3h8' }], ['path', { d: 'M12 12.5V21' }]],
  pen: [['path', { d: 'M4 20h4L19 9l-4-4L4 16v4z' }], ['path', { d: 'M13.5 6.5l4 4' }]],
  ok: [['path', { d: 'M5 12.5l4.5 4.5L19 7' }]],
  undo: [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10a6 6 0 0 1 0 12h-3' }]],
  caret: [['path', { d: 'M7 10l5 5 5-5' }]],
  chevron: [['path', { d: 'M9 6l6 6-6 6' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
};

const hexRgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
const isHex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** WCAG 2 relative luminance of '#rrggbb'. */
export function luminance(hex) {
  const [r, g, b] = hexRgb(hex).map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Black or white ink ('r,g,b') for text on a colour, whichever has the higher contrast. */
export function inkFor(hex) {
  const light = luminance(hex);
  return (light + 0.05) / 0.05 >= 1.05 / (light + 0.05) ? BLACK : WHITE;
}

/** Visual settings (SPEC §11) as --st-echo-* properties (null = remove, style.css falls back to the default look)
 *  and data flags. Same names and meaning as Sable Trackers' --st-sable-*, plus --st-echo-chip (chip height).
 *  `bg` is the background picture of SPEC §17.2, for the panel only (never the edge tab or the settings block):
 *  --st-echo-bg-image (a CSS url(), only for a URL normalizeBgImage accepts), --st-echo-bg-dim, data-st-echo-bg
 *  and data-st-echo-fit (contain | tile; cover is the default look). */
export function visualVars(visual) {
  const v = visual && typeof visual === 'object' ? visual : {};
  const num = (value, fallback) => (value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback);
  const base = isHex(v.base) ? v.base.toLowerCase() : null;
  const ink = base ? inkFor(base) : null;
  const accent = isHex(v.accent) && v.accent.toLowerCase() !== DEFAULT_ACCENT ? v.accent.toLowerCase() : null;
  const chip = chipPx(v.chipSize);
  const image = normalizeBgImage(v.bgImage);
  return {
    vars: {
      opacity: String(num(v.opacity, 0.93)), blur: `${num(v.blur, 14)}px`, font: `${num(v.fontSize, 13)}px`, scale: String(num(v.scale, 1)),
      width: `${num(v.widthVw, 80)}vw`, radius: `${num(v.radius, 18)}px`,
      'base-rgb': base ? hexRgb(base).join(',') : null, 'ink-rgb': ink, accent,
      // The default accent follows the ink in style.css, so its own ink is the opposite of the panel ink.
      'accent-ink-rgb': accent ? inkFor(accent) : (ink ?? WHITE) === WHITE ? BLACK : WHITE,
      text: isHex(v.text) ? v.text : ink ? `rgb(${ink})` : null,
      chip: `${chip}px`, 'chip-pad': `${Math.round(chip * 0.375 - 3.5)}px`,
    },
    flags: {
      stEchoTone: ink ? (ink === BLACK ? 'light' : 'dark') : null,
      stEchoMotion: v.motion === false ? 'off' : null,
      // SPEC §19.3: phones get a right-anchored side panel unless the full-width layout was chosen.
      stEchoPhone: v.phoneFull === true ? 'full' : null,
      stEchoSpacing: v.spacing === 'compact' ? 'compact' : null,
      // Chips under 36 px keep a 36 px tap area through an invisible extension (style.css).
      stEchoChip: chip < 36 ? 'compact' : null,
    },
    bg: {
      vars: { 'bg-image': image ? `url("${image}")` : null, 'bg-dim': image ? String(Math.min(0.9, Math.max(0, num(v.bgDim, 0.45)))) : null },
      flags: { stEchoBg: image ? '1' : null, stEchoFit: image && BG_FITS.includes(v.bgFit) && v.bgFit !== 'cover' ? v.bgFit : null },
    },
  };
}

/** Display trim of SPEC §4: cut words at the ends drop, a cut run inside becomes a «…» gap. */
export function trimWords(words = [], cuts = []) {
  const cut = new Set(cuts), parts = [];
  let run = [];
  words.forEach((word, index) => {
    if (cut.has(index)) { if (run.length) parts.push(run.join(' ')); run = []; return; }
    run.push(word);
  });
  if (run.length) parts.push(run.join(' '));
  return { text: parts.join(' … '), parts };
}

/** The word next to a sensor value. Colour says good or bad; the word says how much, so `change` is inverted
 *  (red there means the story stands still: low movement). */
export function levelOf(id, colour) {
  if (!COLOURS.includes(colour)) return null;
  return (id === 'change' ? { green: 'high', amber: 'mid', red: 'low' } : { green: 'low', amber: 'mid', red: 'high' })[colour];
}

/** Desktop panel width in px for a widthVw value (style.css: clamp(420px, widthVw / 2, 100vw)). */
export function panelWidth(widthVw, viewport) {
  return Math.round(Math.min(viewport, Math.max(MIN_PANEL, viewport * widthVw / 200)));
}

/* ---------- morph: patch a live tree to match a freshly built one ---------- */

const keyOf = node => (node.nodeType === 1 ? node.getAttribute('data-key') : null);

function morphChildren(live, next) {
  const pool = new Map();
  for (const child of live.childNodes) { const key = keyOf(child); if (key !== null) pool.set(key, child); }
  let cursor = live.firstChild;
  for (const child of [...next.childNodes]) {
    const key = keyOf(child);
    let match = null;
    if (key !== null) {
      const found = pool.get(key);
      if (found && found.nodeName === child.nodeName) { match = found; pool.delete(key); }
    } else if (cursor && keyOf(cursor) === null && cursor.nodeName === child.nodeName) match = cursor;
    if (!match) { live.insertBefore(child, cursor); continue; }
    if (match === cursor) cursor = cursor.nextSibling;
    else live.insertBefore(match, cursor);
    patch(match, child);
  }
  while (cursor) { const after = cursor.nextSibling; cursor.remove(); cursor = after; }
}

function patch(live, next) {
  if (live.nodeType !== 1) { if (live.nodeValue !== next.nodeValue) live.nodeValue = next.nodeValue; return; }
  const sameIcon = live.getAttribute('data-icon') === next.getAttribute('data-icon');
  for (const { name } of [...live.attributes]) if (!next.hasAttribute(name)) live.removeAttribute(name);
  for (const { name, value } of [...next.attributes]) if (live.getAttribute(name) !== value) live.setAttribute(name, value);
  if (live.hasAttribute('data-icon')) { if (!sameIcon) live.replaceChildren(...next.childNodes); return; }
  // A focused field keeps what the user is typing; everything else follows the new state.
  const focused = live.ownerDocument.activeElement === live;
  if (live.tagName === 'INPUT' || live.tagName === 'TEXTAREA') {
    setValue(live, next.value);
    return;
  }
  morphChildren(live, next);
  if (live.tagName === 'SELECT' && !focused && live.value !== next.value) live.value = next.value;
}

export function dom(document) {
  function h(tag, attrs, ...kids) {
    const element = document.createElement(tag);
    let value;
    for (const [name, raw] of Object.entries(attrs ?? {})) {
      if (raw == null || raw === false) continue;
      if (name === 'class') element.className = String(raw).split(/\s+/).filter(Boolean).map(item => `st-echo-${item}`).join(' ');
      else if (name === 'value') value = raw;
      else element.setAttribute(name, raw === true ? '' : String(raw));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false || kid === '') continue;
      element.append(typeof kid === 'object' ? kid : String(kid));
    }
    if (['button', 'input', 'select'].includes(tag)) element.classList.add('st-echo-control');
    if (value !== undefined) element.value = String(value);
    return element;
  }
  return h;
}

export function setValue(input, value) {
  const next = String(value ?? '');
  if (input.ownerDocument.activeElement !== input && input.value !== next) input.value = next;
}

/* ---------- the drawer ---------- */

export function mountDrawer(runtime, { document = globalThis.document, language, onSettings } = {}) {
  const win = document.defaultView ?? globalThis;
  let snap = runtime.snapshot();
  // UI-only state: never persisted, keyed by candidate key / ban id so it survives re-renders and rescans.
  const ui = {
    open: false, sheet: false, menu: null, sensor: null, block: false, toast: null, jevDismissed: false,
    manual: null, ban: null, focus: null, live: null,
    folds: new Set(), lists: new Set(), more: new Set(),
    cuts: new Map(), trim: new Set(), examples: new Set(), edits: new Map(),
    alts: new Map(), suggestions: new Map(), rx: new Set(), cutHints: new Map(), altFailed: new Map(), rxNotes: new Map(),
  };
  const timers = new Set(), cleanups = [];
  let disposed = false;
  let toastSerial = 0, opener = null, swipe = null, slideTimer = null, slidePatch = null, bgImage = null;
  // The character and chat the UI state belongs to. Drafts and undo never cross a switch.
  const contextOf = state => JSON.stringify([state?.avatar ?? null, state?.chatId ?? null]);
  let context = contextOf(snap);
  /** A switch closes the toast, forgets its undo and drops every in-progress draft, menu and editor. */
  function switched() {
    toastSerial++;
    Object.assign(ui, { toast: null, menu: null, ban: null, manual: null, live: null, focus: null });
    for (const map of [ui.cuts, ui.edits, ui.alts, ui.suggestions, ui.cutHints, ui.altFailed, ui.rxNotes]) map.clear();
    for (const set of [ui.trim, ui.examples, ui.rx]) set.clear();
  }

  const lang = () => [snap?.language, language].find(value => value === 'ru' || value === 'en') ?? 'ru';
  const L = (key, vars) => t(key, lang(), vars);
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };
  const report = error => { console.warn('[sable-echo]', error); return null; };
  /** Runtime call that never throws into the UI; resolves to the method's result or null. */
  function call(method, ...args) {
    try { return Promise.resolve(runtime[method](...args)).catch(report); } catch (error) { return Promise.resolve(report(error)); }
  }

  const h = dom(document);
  const button = (cls, attrs, ...kids) => h('button', { type: 'button', class: cls, ...attrs }, ...kids);
  const iconButton = (act, name, label, attrs = {}, cls = '') =>
    button(`ib ${cls}`, { 'data-act': act, 'aria-label': label, title: label, ...attrs }, icon(name));
  function svg(tag, attrs) {
    const element = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
    return element;
  }
  function icon(name) {
    const wrap = document.createElement('span');
    wrap.className = 'st-echo-ico';
    wrap.setAttribute('data-icon', name);
    wrap.setAttribute('aria-hidden', 'true');
    const graphic = svg('svg', { viewBox: '0 0 24 24', focusable: 'false' });
    for (const [tag, attrs] of ICONS[name]) graphic.append(svg(tag, attrs));
    wrap.append(graphic);
    return wrap;
  }

  // Fixed roots: the panel, the edge tab, and an entry in SillyTavern's extensions (wand) menu when present.
  const drawer = document.createElement('aside');
  drawer.className = 'st-echo-drawer';
  drawer.id = 'st-echo-drawer';
  drawer.hidden = true;
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'st-echo-tab';
  tab.setAttribute('aria-controls', drawer.id);
  tab.append(icon('logo'), icon('chevron'));
  const entry = document.createElement('div');
  entry.className = 'list-group-item flex-container flexGap5 st-echo-menu-entry';
  entry.setAttribute('role', 'button');
  entry.setAttribute('aria-controls', drawer.id);
  entry.tabIndex = 0;
  const entryIcon = document.createElement('div');
  entryIcon.className = 'extensionsMenuExtensionButton';
  entryIcon.append(icon('logo'));
  const entryLabel = document.createElement('span');
  entry.append(entryIcon, entryLabel);
  document.body.append(tab, drawer);
  document.getElementById('extensionsMenu')?.append(entry);

  /* ---------- helpers over the snapshot ---------- */
  const visual = () => (snap.visual && typeof snap.visual === 'object' ? snap.visual : {});
  const bans = () => (Array.isArray(snap.bans) ? snap.bans.filter(Boolean) : []);
  const banById = id => bans().find(item => item.id === id);
  const candidate = key => (snap.candidates ?? []).find(item => item.key === key);
  const cutsOf = key => ui.cuts.get(key) ?? new Set();
  const sortedCuts = key => [...cutsOf(key)].sort((a, b) => a - b);
  const strings = list => (Array.isArray(list) ? list : []).map(item => (typeof item === 'string' ? item : item?.text))
    .filter(item => typeof item === 'string' && item);
  const toggle = (set, value) => { if (set.has(value)) set.delete(value); else set.add(value); };
  const score = value => (value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value).toFixed(1) : '—');
  const colourOf = value => (COLOURS.includes(value) ? value : 'none');
  function patternName(id) {
    const key = `pattern.${id}`, name = L(key);
    return name === key ? String(id) : name;
  }
  const banLabel = item => (item.kind === 'pattern' ? patternName(item.text) : item.text || (item.words ?? []).join(' '));
  const chipsMode = () => snap.settings?.candidates !== 'collapsed';   // SPEC §16.4, default 'chips'
  const phoneFull = () => visual().phoneFull === true;                   // SPEC §19.3, default false
  const pinned = () => snap.settings?.pinned === true;                  // SPEC §20.1: taps outside do not close
  const scopeOf = item => (REGEX_SCOPES.includes(item.regexScope) ? item.regexScope : 'character');
  const modeOf = item => (REGEX_MODES.includes(item.regexMode) ? item.regexMode : 'prompt');

  /* ---------- actions ---------- */
  /** Keyboard opens move focus into the panel; pointer and API opens do not (no stray focus ring on phones). */
  function open(source, focus = false) {
    opener = source ?? document.activeElement;
    ui.open = true;
    render();
    if (focus) drawer.querySelector('[data-act="close"]')?.focus();
  }
  function close(restoreFocus = true) {
    Object.assign(ui, { open: false, sheet: false, menu: null, toast: null });
    render();
    if (restoreFocus) opener?.focus?.();
  }
  function openSettings() {
    close(false);
    if (onSettings) onSettings();
    else document.dispatchEvent(new win.CustomEvent('sable-echo:settings'));
  }
  /** Undo toast for 4 s. `origin` is the context the action was taken in: no toast once it is gone, and the
   *  undo only runs while the same character and chat are shown. */
  function showToast(kind, undo, origin) {
    if (origin !== context) return;
    const serial = ++toastSerial;
    ui.toast = { kind, undo, serial, origin };
    render();
    const timer = win.setTimeout(() => {
      timers.delete(timer);
      if (ui.toast?.serial === serial) { ui.toast = null; render(); }
    }, TOAST_MS);
    timers.add(timer);
  }
  /** Any ban: call the runtime, then offer undo for the new record. */
  async function ban(method, args) {
    const before = new Set(bans().map(item => item.id)), origin = context;
    ui.menu = null;
    const result = await call(method, ...args);
    const id = (typeof result === 'string' && result) || result?.id || bans().find(item => !before.has(item.id))?.id;
    if (id) showToast('ban', () => call('unban', id), origin);
  }
  async function decide(method, undo, kind, text) {
    const origin = context;
    ui.menu = null;
    await call(method, text);
    showToast(kind, () => call(undo, text), origin);
  }
  /** A dragged slider previews at once and writes at most every SLIDE_MS; the release writes immediately. */
  function slide(key, value, release) {
    ui.live = { ...ui.live, [key]: value };
    slidePatch = { ...slidePatch, [key]: value };
    win.clearTimeout(slideTimer);
    slideTimer = null;
    if (release) {
      writeSlide();
      if (ui.live) delete ui.live[key];
    } else slideTimer = win.setTimeout(writeSlide, SLIDE_MS);
  }
  function writeSlide() {
    const patch = slidePatch;
    slideTimer = null;
    slidePatch = null;
    if (patch) void call('updateSettings', { visual: patch });
  }
  function submitEdit(key) {
    const text = (ui.edits.get(key) ?? '').trim();
    if (!text) return;
    ui.edits.delete(key);
    ui.trim.delete(key);
    void ban('banText', [text]);
  }
  function submitManual() {
    const text = (ui.manual ?? '').trim();
    if (!text) return;
    ui.manual = null;
    void ban('banText', [text]);
  }
  function saveAlt(id) {
    const text = (ui.alts.has(id) ? ui.alts.get(id) : banById(id)?.alt ?? '').trim();
    ui.alts.delete(id);
    if (document.activeElement?.dataset?.draft === 'alt') document.activeElement.blur();
    void call('setAlt', id, text);
  }
  async function suggest(id) {
    const origin = context, previousLog = snap.log?.[0];
    ui.altFailed.delete(id);
    const list = await call('suggestAlt', id);
    if (disposed || origin !== context) return;
    const failure = snap.log?.[0];
    if (failure !== previousLog && failure?.kind === 'alt' && failure.error?.kind === 'timeout') temporary(ui.altFailed, id, 3000);
    ui.suggestions.set(id, (Array.isArray(list) ? list : []).filter(item => typeof item === 'string' && item.trim()).slice(0, 3));
    render();
  }

  /** The install toggle; after a successful install the regex row says the script shows up after a reload (§19.4). */
  async function installRegex(item) {
    const id = item.id, enabling = !item.regex, origin = context, previousLog = snap.log?.[0];
    await call('setRegex', id, enabling, modeOf(item));
    if (disposed || origin !== context || !enabling || !banById(id)?.regex) return;
    const failure = snap.log?.[0];
    if (failure !== previousLog && failure?.kind === 'regex' && failure.status === 'failed') return;
    temporary(ui.rxNotes, id, RX_NOTE_MS);
    render();
  }

  function temporary(map, key, ms) {
    const previous = map.get(key);
    win.clearTimeout(previous); timers.delete(previous);
    const timer = win.setTimeout(() => { timers.delete(timer); map.delete(key); render(); }, ms);
    map.set(key, timer); timers.add(timer);
  }

  const ACTIONS = {
    'cut-hint': d => temporary(ui.cutHints, d.k, 4000),
    close: () => close(),
    rescan: () => { void call('rescan'); },
    pin: () => { void call('updateSettings', { pinned: !pinned() }); },
    view: () => { ui.sheet = !ui.sheet; ui.menu = null; },
    'view-done': () => { ui.sheet = false; },
    motion: () => { void call('updateSettings', { visual: { motion: visual().motion === false } }); },
    'cand-mode': () => { void call('updateSettings', { candidates: chipsMode() ? 'collapsed' : 'chips' }); },
    'phone-full': () => { void call('updateSettings', { visual: { phoneFull: !phoneFull() } }); },
    'fold-all': () => { ui.folds = CARDS.every(id => ui.folds.has(id)) ? new Set() : new Set(CARDS); },
    sensor: data => { ui.sensor = ui.sensor === data.id ? null : data.id; },
    fold: data => toggle(ui.folds, data.id),
    list: data => toggle(ui.lists, data.id),
    more: data => toggle(ui.more, data.id),
    examples: data => toggle(ui.examples, data.k),
    trim: data => {
      if (ui.trim.has(data.k) || ui.edits.has(data.k)) { ui.trim.delete(data.k); ui.edits.delete(data.k); } else ui.trim.add(data.k);
    },
    cut: data => {
      const cuts = new Set(cutsOf(data.k));
      toggle(cuts, Number(data.i));
      ui.cuts.set(data.k, cuts);
    },
    edit: data => {
      const item = candidate(data.k);
      ui.edits.set(data.k, item ? trimWords(item.words, sortedCuts(data.k)).text : '');
      ui.focus = `edit:${data.k}`;
    },
    'edit-ok': data => submitEdit(data.k),
    'edit-cancel': data => { ui.edits.delete(data.k); },
    ban: data => {
      if (!candidate(data.k)) return;
      ui.trim.delete(data.k);
      ui.examples.delete(data.k);
      void ban('ban', [data.k, sortedCuts(data.k)]);
    },
    'ban-opener': data => { void ban('banOpener', [data.k]); },
    'ban-pattern': data => { void ban('banPattern', [data.id]); },
    keep: data => { ui.menu = ui.menu === data.m ? null : data.m; },
    intentional: data => { void decide('markIntentional', 'unmarkIntentional', 'intentional', data.t); },
    hide: data => { void decide('hide', 'unhide', 'hidden', data.t); },
    unmark: data => { void call('unmarkIntentional', data.t); },
    unhide: data => { void call('unhide', data.t); },
    inject: () => { void call('setInject', !snap.inject?.enabled); },
    block: () => { ui.block = !ui.block; },
    'block-lang': data => { void call('setBlockLanguage', data.v); },
    bedit: data => { ui.ban = ui.ban === data.id ? null : data.id; },
    unban: data => { if (ui.ban === data.id) ui.ban = null; void call('unban', data.id); },
    'alt-ok': data => saveAlt(data.id),
    'alt-close': () => { ui.ban = null; },
    suggest: data => { void suggest(data.id); },
    pick: data => { ui.alts.set(data.id, (ui.suggestions.get(data.id) ?? [])[Number(data.i)] ?? ''); },
    rx: data => toggle(ui.rx, data.id),
    'rx-install': data => {
      const item = banById(data.id);
      if (item) void installRegex(item);
    },
    'hint-off': () => { void call('updateSettings', { hints: false }); },
    settings: () => openSettings(),
    'jev-dismiss': () => { ui.jevDismissed = true; },
    manual: () => { ui.manual = ''; ui.focus = 'manual'; },
    'manual-ok': () => submitManual(),
    'manual-cancel': () => { ui.manual = null; },
    'toast-undo': () => {
      const toast = ui.toast;
      ui.toast = null;
      if (toast?.origin === context) toast.undo?.();
    },
  };

  /* ---------- view ---------- */
  function hint(key) {
    return h('div', { class: 'hint', 'data-key': key },
      h('span', null, L(key)),
      button('hint-x', { 'data-act': 'hint-off', 'aria-label': L('hint.off'), title: L('hint.off') }, icon('x')));
  }

  function card(id, title, count, sub, extra, body, cls = '') {
    const folded = ui.folds.has(id);
    return h('section', { class: `card ${cls}`, 'data-key': `card:${id}`, 'data-card': id },
      h('div', { class: 'card-h' },
        button('card-t', { 'data-act': 'fold', 'data-id': id, 'aria-expanded': String(!folded), 'aria-controls': `st-echo-body-${id}` },
          h('span', { class: 'card-n' }, title),
          count != null && h('span', { class: 'pill' }, String(count)),
          sub && h('span', { class: 'card-sub' }, sub)),
        extra),
      h('div', { class: 'card-b', id: `st-echo-body-${id}`, hidden: folded }, body));
  }

  function statusLine() {
    if (snap.busy?.rescan) return L('drawer.status.scanning');
    const jev = snap.jev ?? {}, parts = [snap.characterName, L('drawer.status.replies', { count: snap.mined ?? 0 })];
    if (jev.enabled) parts.push(L(jev.busy ? 'drawer.status.jevBusy' : 'drawer.status.jev'));
    if (jev.enabled && !jev.busy && jev.lastMesId != null) parts.push(L('drawer.status.after', { id: jev.lastMesId }));
    return parts.filter(Boolean).join(' · ');
  }

  function header() {
    const busy = !!snap.busy?.rescan, error = snap.jev?.error?.kind, idle = !!snap.groupChat || snap.enabled === false;
    return h('header', { class: 'hd', 'data-key': 'hd' },
      h('div', { class: 'hd-row' },
        h('h2', { class: 'title' }, icon('logo'), h('span', null, L('drawer.title'))),
        iconButton('rescan', 'refresh', L('drawer.rescan'), { 'aria-busy': String(busy), disabled: idle }, busy ? 'spin' : ''),
        iconButton('pin', 'pin', L('drawer.pin'), { 'aria-pressed': String(pinned()) }),
        iconButton('view', 'gear', L('drawer.view'), { 'aria-expanded': String(ui.sheet), 'aria-haspopup': 'dialog' }),
        iconButton('close', 'x', L('drawer.close'))),
      h('div', { class: 'status' }, statusLine()),
      error && h('div', { class: 'status err' }, L(`drawer.jev.${JEV_ERRORS.includes(error) ? error : 'other'}`)));
  }

  function sensorStrip() {
    const sensors = snap.sensors;
    return h('div', { class: 'sensors', 'data-key': 'sensors' }, SENSORS.filter(id => sensors[id]).map(id => {
      const item = sensors[id], colour = colourOf(item.colour), level = levelOf(id, colour);
      return button(`sens c-${colour}`, { 'data-act': 'sensor', 'data-id': id, 'data-key': `sens:${id}`, 'aria-expanded': String(ui.sensor === id) },
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        h('span', { class: 'sens-t' },
          h('span', { class: 'sens-n' }, L(`sensor.${id}`)),
          h('span', { class: 'sens-v' }, h('b', null, score(item.value)), level && ` · ${L(`sensor.level.${level}`)}`)));
    }));
  }

  function sparkline(series) {
    const values = (Array.isArray(series) ? series : []).map(Number).filter(Number.isFinite).slice(-24);
    if (values.length < 2) return null;
    const W = 360, H = 64, P = 6, last = values.length - 1;
    const x = index => (P + index * (W - 2 * P) / last).toFixed(1);
    const y = value => (H - P - (Math.min(SCORE_MAX, Math.max(0, value)) / SCORE_MAX) * (H - 2 * P)).toFixed(1);
    const points = values.map((value, index) => `${x(index)},${y(value)}`).join(' ');
    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': L('sensor.chart') });
    for (const level of [1, 2, 3]) chart.append(svg('line', { class: 'st-echo-grid', x1: P, x2: W - P, y1: y(level), y2: y(level) }));
    chart.append(svg('polygon', { class: 'st-echo-area', points: `${x(0)},${H - P} ${points} ${x(last)},${H - P}` }),
      svg('polyline', { class: 'st-echo-line', points }),
      svg('circle', { class: 'st-echo-end', cx: x(last), cy: y(values[last]), r: 3.5 }));
    return h('div', { class: 'spark' }, chart);
  }

  function sensorCard() {
    const id = ui.sensor, item = snap.sensors?.[id];
    if (!item) return null;
    return h('section', { class: `card sd c-${colourOf(item.colour)}`, 'data-key': 'sd' },
      h('div', { class: 'sd-h' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('b', null, L(`sensor.${id}`)),
        h('span', { class: 'sd-v' }, score(item.value), h('small', null, ` ${L('sensor.scale')}`))),
      sparkline(item.series),
      h('div', { class: 'note' }, L('sensor.note')));
  }

  /** Example sentence with each kept fragment of the phrase highlighted, in order. */
  function marked(sentence, parts) {
    const low = sentence.toLowerCase(), out = [];
    let position = 0;
    for (const part of parts) {
      const needle = part.toLowerCase().replace(/[….,!?]+$/u, '');
      const at = needle ? low.indexOf(needle, position) : -1;
      if (at < 0) continue;
      out.push(sentence.slice(position, at), h('mark', null, sentence.slice(at, at + needle.length)));
      position = at + needle.length;
    }
    out.push(sentence.slice(position));
    return out;
  }

  function keepMenu(id, text) {
    const open = ui.menu === id;
    return h('div', { class: 'menu-wrap' },
      button('btn', { 'data-act': 'keep', 'data-m': id, 'aria-haspopup': 'menu', 'aria-expanded': String(open) }, L('drawer.cand.keep'), icon('caret')),
      open && h('div', { class: 'menu', role: 'menu' },
        button('menu-i', { role: 'menuitem', 'data-act': 'intentional', 'data-t': text }, L('drawer.cand.intentional')),
        button('menu-i', { role: 'menuitem', 'data-act': 'hide', 'data-t': text }, L('drawer.cand.hide'))));
  }

  function wordsBox(item, cuts, withHint = true) {
    return h('div', { class: 'trim', 'data-key': 'trim' },
      withHint && snap.hints && hint('hint.cut'),
      h('div', { class: 'trim-row' },
        button('scissors', { 'data-act': 'cut-hint', 'data-k': item.key, 'aria-label': L('hint.wordCut'), 'aria-expanded': String(ui.cutHints.has(item.key)) }, '✂'),
        h('div', { class: 'words' }, (item.words ?? []).map((word, index) => {
          const cut = cuts.has(index);
          return button(`w${cut ? ' cut' : ''}`, { 'data-act': 'cut', 'data-k': item.key, 'data-i': index, 'aria-pressed': String(cut),
            title: L(cut ? 'drawer.cand.keepWord' : 'drawer.cand.cutWord') }, word);
        })),
        iconButton('edit', 'pen', L('drawer.cand.edit'), { 'data-k': item.key }, 'ghost')),
      ui.cutHints.has(item.key) && h('p', { class: 'note cut-hint', role: 'status' }, L('hint.wordCut')));
  }

  function editBox(key) {
    return h('div', { class: 'editbox', 'data-key': 'edit' },
      h('input', { class: 'input', type: 'text', value: ui.edits.get(key) ?? '', 'data-key': 'edit-in', 'data-draft': 'edit', 'data-k': key,
        'data-fk': `edit:${key}`, enterkeyhint: 'done', autocomplete: 'off', spellcheck: 'false',
        placeholder: L('drawer.cand.editPlaceholder'), 'aria-label': L('drawer.cand.edit') }),
      iconButton('edit-ok', 'ok', L('drawer.cand.editBan'), { 'data-k': key }),
      iconButton('edit-cancel', 'x', L('drawer.cand.cancel'), { 'data-k': key }));
  }

  /** A candidate row. Chips mode (SPEC §16.4, default): the word chips are the phrase, then «→ result» once a word
   *  is cut, the count line, the actions. Collapsed mode (§13.1): bold phrase, count line, «Обрезать» opens chips. */
  function candidateRow(item) {
    const key = item.key, cuts = cutsOf(key), trimmed = trimWords(item.words ?? [], [...cuts]), chips = chipsMode();
    const full = (item.words ?? []).join(' '), editing = ui.edits.has(key), trimming = editing || ui.trim.has(key);
    const examples = (item.examples ?? []).filter(text => typeof text === 'string' && text).slice(0, 2);
    const showExamples = examples.length > 0 && ui.examples.has(key);
    const result = cuts.size > 0 && !editing && h('div', { class: 'result', 'data-key': 'result' },
      h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
      h('span', { class: trimmed.text ? 'res' : 'res none' }, trimmed.text || L('drawer.cand.nothing')));
    const words = editing ? editBox(key) : wordsBox(item, cuts, !chips);
    return h('div', { class: `cand${chips ? ' chips' : ''}`, 'data-key': `c:${key}` },
      chips ? [words, result] : h('div', { class: 'cand-text' }, full),
      h('div', { class: 'meta' },
        h('span', null, L('drawer.cand.count', { df: item.df ?? 0, count: snap.mined ?? 0 })),
        examples.length > 0 && [h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
          button('link', { 'data-act': 'examples', 'data-k': key, 'aria-expanded': String(showExamples) }, L('drawer.cand.examples'))]),
      showExamples && h('div', { class: 'exs', 'data-key': 'exs' },
        examples.map(sentence => h('p', null, '«', marked(sentence, trimmed.parts), '»'))),
      !chips && [trimming && words, result],
      h('div', { class: `acts${chips ? ' two' : ''}`, 'data-key': 'acts' },
        button('btn ban', { 'data-act': 'ban', 'data-k': key, disabled: !trimmed.text }, L('drawer.cand.ban')),
        keepMenu(`c:${key}`, full),
        !chips && button('link trim-link', { 'data-act': 'trim', 'data-k': key, 'aria-expanded': String(trimming) },
          L(trimming ? 'drawer.cand.trimDone' : 'drawer.cand.trim'))));
  }

  function openerRow(item) {
    return h('div', { class: 'cand opener', 'data-key': `o:${item.key}` },
      h('div', { class: 'cand-text' }, item.text ?? ''),
      h('div', { class: 'meta' }, h('span', null, L('drawer.cand.count', { df: item.df ?? 0, count: snap.mined ?? 0 }))),
      h('div', { class: 'acts', 'data-key': 'acts' },
        button('btn ban', { 'data-act': 'ban-opener', 'data-k': item.key }, L('drawer.cand.ban')),
        keepMenu(`o:${item.key}`, item.text ?? '')));
  }

  function limited(group, items, row) {
    const all = ui.more.has(group), rest = items.length - ROWS;
    return [...(all ? items : items.slice(0, ROWS)).map(row),
      rest > 0 && button('more', { 'data-act': 'more', 'data-id': group, 'data-key': `more:${group}`, 'aria-expanded': String(all) },
        all ? L('drawer.cand.less') : L('drawer.cand.more', { count: rest }))];
  }

  function listFold(id, labelKey, items, act) {
    if (!items.length) return null;
    const open = ui.lists.has(id);
    return h('div', { class: 'fold', 'data-key': `fold:${id}` },
      button('fold-h', { 'data-act': 'list', 'data-id': id, 'aria-expanded': String(open) }, L(labelKey, { count: items.length })),
      open && h('div', { class: 'fold-b' }, items.map(text => h('div', { class: 'fold-i', 'data-key': `i:${text}` },
        h('span', null, `«${text}»`),
        button('btn sm', { 'data-act': act, 'data-t': text }, icon('undo'), L('drawer.cand.restore'))))));
  }

  function manualBox() {
    if (ui.manual === null) return button('btn manual', { 'data-act': 'manual', 'data-key': 'manual-btn' }, icon('plus'), L('drawer.cand.manual'));
    return h('div', { class: 'editbox', 'data-key': 'manual' },
      h('input', { class: 'input', type: 'text', value: ui.manual, 'data-key': 'manual-in', 'data-draft': 'manual', 'data-fk': 'manual',
        enterkeyhint: 'done', autocomplete: 'off', placeholder: L('drawer.cand.manualPlaceholder'), 'aria-label': L('drawer.cand.manual') }),
      iconButton('manual-ok', 'ok', L('drawer.cand.editBan')),
      iconButton('manual-cancel', 'x', L('drawer.cand.cancel')));
  }

  function candidatesCard(few) {
    const candidates = (snap.candidates ?? []).filter(item => item?.key), openers = (snap.openers ?? []).filter(item => item?.key);
    const body = [];
    if (few) body.push(h('p', { class: 'empty' }, L('drawer.cand.few')), manualBox());
    else if (!candidates.length && !openers.length) body.push(h('p', { class: 'empty' }, L('drawer.cand.none')));
    else {
      // Chips mode shows the word chips on every row, so the cut hint is said once, above them.
      if (chipsMode() && snap.hints && candidates.length) body.push(hint('hint.cut'));
      body.push(...limited('c', candidates, candidateRow));
      if (openers.length) body.push(h('div', { class: 'grp', 'data-key': 'grp' }, L('drawer.cand.openers')), ...limited('o', openers, openerRow));
    }
    body.push(listFold('intentional', 'drawer.cand.intentionalFold', strings(snap.intentional), 'unmark'),
      listFold('hidden', 'drawer.cand.hiddenFold', strings(snap.hidden), 'unhide'));
    return card('cands', L('drawer.cand.title'), few ? null : candidates.length + openers.length,
      few ? null : L('drawer.cand.sub', { count: snap.mined ?? 0 }), null, body);
  }

  /** A pattern row (SPEC §16.1): count with a neutral bar, or «нет данных» when no source counted it. */
  function patternRow(item) {
    const name = patternName(item.id), known = item.count !== null && item.count !== '' && Number.isFinite(Number(item.count));
    const count = Math.max(0, Number(item.count) || 0), window = Math.max(1, Number(item.window) || 10);
    const jev = !!(snap.jev?.enabled && snap.jev?.configured);
    const missing = [L('pattern.noData'), item.id === 'aphorism' && !jev && L('pattern.needJev')].filter(Boolean).join(' · ');
    return h('div', { class: 'pat', 'data-key': `p:${item.id}` },
      h('div', { class: 'pat-h' }, h('span', { class: 'pat-n' }, name),
        h('span', { class: `pat-k${known ? '' : ' muted'}` }, known ? L('pattern.count', { count, window }) : missing)),
      known && h('div', { class: 'bar', role: 'meter', 'aria-label': name, 'aria-valuemin': 0, 'aria-valuemax': window, 'aria-valuenow': Math.min(count, window) },
        h('i', { style: `width:${Math.round(Math.min(1, count / window) * 100)}%` })),
      item.example && h('div', { class: 'pat-ex' }, `«${item.example}»`),
      h('div', { class: 'acts one' }, button('btn', { 'data-act': 'ban-pattern', 'data-id': item.id }, L('pattern.avoid'))));
  }

  /** Always present (no Jev needed); rows come from snapshot.patterns, banned patterns drop out. */
  function patternsCard() {
    const banned = new Set(bans().filter(item => item.kind === 'pattern').map(item => item.text));
    const all = (Array.isArray(snap.patterns) ? snap.patterns : []).filter(item => item?.id), rows = all.filter(item => !banned.has(item.id));
    const window = Math.max(0, ...rows.map(item => Number(item.window) || 0));
    return card('pats', L('pattern.title'), rows.length, window ? L('pattern.sub', { count: window }) : null, null,
      rows.length ? rows.map(patternRow) : h('p', { class: 'empty' }, L('pattern.none')));
  }

  const seenText = (item, key) => (item.seenAfter > 0 ? L(key, { seen: item.seenAfter, count: Number(item.sinceReplies) || 0 }) : '');
  function marks(item) {
    const seen = seenText(item, 'ban.seen');
    return [
      item.alt && h('span', { class: 'm-alt', role: 'img', title: L('ban.hasAlt'), 'aria-label': L('ban.hasAlt') }, '↷'),
      item.regex && h('span', { class: 'm-rx', role: 'img', title: L('ban.hasRegex'), 'aria-label': L('ban.hasRegex') }, '.*'),
      item.regex && scopeOf(item) === 'global' && h('span', { class: 'm-glob', title: L('ban.globalTitle') }, L('ban.globalMark')),
      seen && h('span', { class: 'm-seen' }, seen),
    ];
  }
  function banChip(item) {
    const open = ui.ban === item.id;
    return h('span', { class: `bchip${open ? ' sel' : ''}`, 'data-key': `b:${item.id}` },
      button('bt', { 'data-act': 'bedit', 'data-id': item.id, 'aria-expanded': String(open), title: L('ban.edit') },
        item.kind !== 'phrase' && h('span', { class: 'tag' }, L(`ban.kind.${item.kind}`)),
        h('span', { class: 't' }, banLabel(item)), marks(item)),
      button('bx', { 'data-act': 'unban', 'data-id': item.id, 'aria-label': `${L('ban.remove')}: ${banLabel(item)}`, title: L('ban.remove') }, icon('x')));
  }
  function banRow(item) {
    const open = ui.ban === item.id;
    return h('div', { class: `brow${open ? ' sel' : ''}`, 'data-key': `b:${item.id}` },
      button('brow-t', { 'data-act': 'bedit', 'data-id': item.id, 'aria-expanded': String(open), title: L('ban.edit') },
        item.kind !== 'phrase' && h('span', { class: 'tag' }, L(`ban.kind.${item.kind}`)),
        h('span', { class: 't' }, banLabel(item)), marks(item)),
      button('bx', { 'data-act': 'unban', 'data-id': item.id, 'aria-label': `${L('ban.remove')}: ${banLabel(item)}`, title: L('ban.remove') }, icon('x')));
  }

  function regexBox(item) {
    const id = item.id, open = ui.rx.has(id), saving = snap.busy?.regex === id, group = !!snap.groupChat;
    const mode = modeOf(item), scope = scopeOf(item);
    const select = (kind, value, values) => h('select', { class: 'input select', value, 'data-key': `rx-${kind}:${id}`,
      'data-change': `rx-${kind}`, 'data-id': id, disabled: group || saving }, values.map(option => h('option', { value: option }, L(`ban.${kind}.${option}`))));
    return h('div', { class: 'rx-box', 'data-key': 'rx' },
      button('fold-h', { 'data-act': 'rx', 'data-id': id, 'aria-expanded': String(open) },
        h('span', null, L('ban.regex')), h('span', { class: `rx-state${item.regex ? ' on' : ''}` }, L(item.regex ? 'ban.regexOn' : 'ban.regexOff'))),
      open && h('div', { class: 'rx-b' },
        h('code', { class: 'rx' }, item.findRegex || '—'),
        h('div', { class: 'note' }, L('ban.matches', { count: snap.mined ?? 0, matches: item.matches ?? 0 })),
        h('label', { class: 'rx-row' }, h('span', { class: 'rx-l' }, L('ban.mode')), select('mode', mode, REGEX_MODES)),
        h('label', { class: 'rx-row' }, h('span', { class: 'rx-l' }, L('ban.scope')), select('scope', scope, REGEX_SCOPES)),
        h('p', { class: 'note' }, L('ban.modeHint')),
        h('p', { class: 'note' }, L('ban.scopeHint')),
        button('tog', { 'data-act': 'rx-install', 'data-id': id, 'aria-pressed': String(!!item.regex), disabled: group || saving },
          L(saving ? 'ban.saving' : scope === 'global' ? 'ban.installGlobal' : 'ban.install')),
        ui.rxNotes.has(id) && h('p', { class: 'note rx-saved', role: 'status', 'data-key': 'rx-saved' }, L('ban.regexNote')),
        group && h('p', { class: 'note' }, L('ban.groupRegex'))));
  }

  function banEditor(item) {
    const id = item.id, draft = ui.alts.has(id) ? ui.alts.get(id) : item.alt ?? '';
    const list = ui.suggestions.get(id), thinking = snap.busy?.alternatives === id;
    return h('div', { class: 'bed', 'data-key': `bed:${id}`, role: 'group', 'aria-label': banLabel(item) },
      h('div', { class: 'bed-t' }, h('span', { class: 'k' }, L(`ban.kind.${item.kind}`)), h('span', null, `«${banLabel(item)}»`)),
      item.seenAfter > 0 && h('p', { class: 'seen-long' }, seenText(item, 'ban.seenLong')),
      h('label', { class: 'bed-l', for: 'st-echo-alt' }, L('ban.altLabel')),
      h('div', { class: 'row' },
        h('input', { class: 'input', id: 'st-echo-alt', type: 'text', value: draft, 'data-key': `alt-in:${id}`, 'data-draft': 'alt', 'data-id': id,
          'data-fk': `alt:${id}`, enterkeyhint: 'done', autocomplete: 'off', placeholder: L('ban.altPlaceholder') }),
        iconButton('alt-ok', 'ok', L('ban.save'), { 'data-id': id }),
        iconButton('alt-close', 'x', L('ban.closeEditor'), { 'data-id': id })),
      snap.altProfile && h('div', { class: 'sgs', 'data-key': 'sgs' },
        button('btn sm', { 'data-act': 'suggest', 'data-id': id, disabled: thinking, 'aria-busy': String(thinking) },
          L(thinking ? 'ban.suggesting' : ui.altFailed.has(id) ? 'ban.noAnswer' : 'ban.suggest')),
        (list ?? []).map((text, index) => button('sg', { 'data-act': 'pick', 'data-id': id, 'data-i': index }, text)),
        list && !list.length && h('span', { class: 'note' }, L('ban.noSuggestions'))),
      item.alt && h('div', { class: 'saved' }, L('ban.saved', { text: item.alt })),
      item.kind === 'pattern' ? h('p', { class: 'note rx-note' }, L('ban.patternNoRegex')) : regexBox(item));
  }

  function blockFold(on) {
    const open = ui.block, text = snap.block?.text ?? '', tokens = Number(snap.block?.tokens) || 0;
    const blockLang = snap.inject?.language === 'ru' ? 'ru' : 'en';
    return h('div', { class: 'fold block-fold', 'data-key': 'block' },
      button('fold-h', { 'data-act': 'block', 'aria-expanded': String(open) }, L(open ? 'ban.block.hide' : 'ban.block.show')),
      open && h('div', { class: 'fold-b' },
        h('div', { class: 'block-bar' },
          h('div', { class: 'seg tiny', role: 'group', 'aria-label': L('ban.block.lang') },
            ['ru', 'en'].map(code => button('', { 'data-act': 'block-lang', 'data-v': code, 'aria-pressed': String(blockLang === code) }, code.toUpperCase()))),
          h('span', { class: 'tok' }, L('ban.tokens', { count: tokens }), !on && ` ${L('ban.off')}`)),
        h('pre', { class: 'block', lang: blockLang }, text || L('ban.block.empty'))));
  }

  function banCard() {
    const list = bans(), on = !!snap.inject?.enabled, editing = list.find(item => item.id === ui.ban);
    const body = [h('p', { class: 'caption' }, L('ban.caption'))];
    if (!list.length) body.push(h('p', { class: 'empty' }, L('ban.empty')));
    else {
      if (snap.hints) body.push(hint('hint.chip'));
      if (list.length <= CHIP_LIST) body.push(h('div', { class: 'bchips', 'data-key': 'bchips' }, list.map(banChip)), editing && banEditor(editing));
      else body.push(h('div', { class: 'brows', 'data-key': 'brows' }, list.map(item => [banRow(item), item === editing && banEditor(item)])));
    }
    body.push(blockFold(on));
    return card('bans', L('ban.title'), list.length, null,
      button('tog', { 'data-act': 'inject', 'aria-pressed': String(on) }, L('ban.inject')), body, `ban-card ${on ? 'on' : 'off'}`);
  }

  /** Slider value in its range: the value being dragged, else the saved one, else the default look. */
  function sliderValue(spec) {
    const raw = ui.live?.[spec.key] ?? (spec.key === 'chipSize' ? chipPx(visual().chipSize) : visual()[spec.key]);
    const value = raw !== null && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : spec.fallback;
    return Math.min(spec.max, Math.max(spec.min, value));
  }
  function sliderText(spec, value) {
    if (spec.key === 'scale') return `${Math.round(value * 100)} %`;
    if (spec.key === 'widthVw') return `${panelWidth(value, win.innerWidth || 1024)} px`;
    return spec.key === 'opacity' ? value.toFixed(2) : `${value} px`;
  }
  const fill = (spec, value) => `--st-echo-fill:${Math.round((value - spec.min) / (spec.max - spec.min) * 100)}%`;
  /** SPEC §19.1: a themed track and knob (divs, filled through --st-echo-fill on their box) with the real range
   *  input stretched invisibly over them, so no host theme can inflate it and keyboard, touch and screen readers
   *  keep working. The input keeps data-view / data-key; the live drag updates the box style and the output. */
  function slider(spec) {
    const value = sliderValue(spec), id = `st-echo-v-${spec.key}`;
    return h('div', { class: `slider${spec.wide ? ' wide-only' : ''}`, 'data-key': `sl:${spec.key}` },
      h('label', { class: 'sheet-l', for: id }, h('span', null, L(spec.label)),
        h('output', { class: 'out', for: id, 'data-out': spec.key }, sliderText(spec, value))),
      h('div', { class: 'sl-box', style: fill(spec, value), 'data-fill': spec.key },
        h('div', { class: 'sl-track', 'aria-hidden': 'true' }, h('div', { class: 'sl-knob' })),
        h('input', { type: 'range', id, class: 'range', min: spec.min, max: spec.max, step: spec.step, value,
          'data-view': spec.key, 'data-key': `range:${spec.key}` })),
      spec.hint && h('p', { class: 'sl-hint' }, L(spec.hint)));
  }
  const toggleRow = (act, label, on) => button('switch', { role: 'switch', 'aria-checked': String(on), 'data-act': act, 'data-key': `sw:${act}` },
    h('span', { class: 'switch-l' }, label), h('span', { class: 'knob', 'aria-hidden': 'true' }));

  function viewSheet() {
    const allFolded = CARDS.every(id => ui.folds.has(id));
    return h('div', { class: 'sheet', role: 'dialog', 'aria-label': L('view.title'), 'data-key': 'sheet' },
      h('div', { class: 'sheet-h', 'data-swipe': '' }, h('span', { class: 'grip', 'aria-hidden': 'true' }), h('b', null, L('view.title'))),
      h('div', { class: 'sheet-b' },
        VIEW_SLIDERS.map(slider),
        h('div', { class: 'switches' },
          toggleRow('motion', L('view.motion'), visual().motion !== false),
          toggleRow('cand-mode', L('view.candidates'), chipsMode()),
          toggleRow('phone-full', L('view.phoneFull'), phoneFull())),
        button('btn wide', { 'data-act': 'fold-all' }, L(allFolded ? 'view.unfoldAll' : 'view.foldAll'))),
      h('div', { class: 'sheet-f' }, button('btn primary', { 'data-act': 'view-done' }, L('view.done'))));
  }

  function toastBox() {
    const toast = ui.toast;
    return h('div', { class: 'toast', role: 'status', 'aria-live': 'polite', 'data-key': `toast:${toast.serial}` },
      h('span', { class: 'toast-t' }, L(`toast.${toast.kind}`)),
      toast.undo && [h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'), button('toast-b', { 'data-act': 'toast-undo' }, L('toast.undo'))]);
  }

  function build() {
    const content = [];
    if (snap.groupChat) content.push(h('p', { class: 'notice calm', 'data-key': 'group' }, L('drawer.group')));
    else if (snap.enabled === false) {
      content.push(h('div', { class: 'notice calm', 'data-key': 'off' }, h('p', null, L('drawer.disabled')),
        button('btn sm', { 'data-act': 'settings' }, L('drawer.openSettings'))));
    } else {
      const few = (Number(snap.mined) || 0) < (Number(snap.minDf) || 3);
      if (!snap.jev?.configured && !ui.jevDismissed) {
        content.push(h('div', { class: 'notice', 'data-key': 'jev' },
          button('notice-b', { 'data-act': 'settings' }, icon('plus'), h('span', null, L('drawer.connectJev'))),
          iconButton('jev-dismiss', 'x', L('drawer.dismiss'), {}, 'ghost')));
      }
      if (!few && snap.sensors && snap.jev?.enabled !== false) content.push(sensorStrip(), sensorCard());
      content.push(candidatesCard(few));
      if (!few && Array.isArray(snap.patterns)) content.push(patternsCard());
      if (!few || bans().length) content.push(banCard());
      content.push(h('footer', { class: 'foot', 'data-key': 'foot' }, L('drawer.footer', { mined: snap.mined ?? 0, count: snap.replies ?? 0 })));
    }
    return [header(), h('div', { class: 'scroll', 'data-key': 'scroll' }, content), ui.sheet && viewSheet(), ui.toast && toastBox()];
  }

  function applyVisual() {
    const { vars, flags, bg } = visualVars({ ...visual(), ...ui.live });
    const apply = (element, props, data) => {
      for (const [name, value] of Object.entries(props)) {
        if (value === null) element.style.removeProperty(`--st-echo-${name}`);
        else element.style.setProperty(`--st-echo-${name}`, value);
      }
      for (const [name, value] of Object.entries(data)) {
        if (value === null) delete element.dataset[name];
        else element.dataset[name] = value;
      }
    };
    for (const element of [drawer, tab]) apply(element, vars, flags);
    // A data URL can be ~800 KB: it is set again only when it changes.
    const { 'bg-image': image, ...rest } = bg.vars;
    if (image !== bgImage) { apply(drawer, { 'bg-image': image }, {}); bgImage = image; }
    apply(drawer, rest, bg.flags);
  }

  function render() {
    applyVisual();
    drawer.lang = lang();
    drawer.hidden = !ui.open;
    drawer.setAttribute('aria-label', L('drawer.title'));
    const label = L(ui.open ? 'drawer.closePanel' : 'drawer.open');
    tab.title = label;
    tab.setAttribute('aria-label', label);
    tab.setAttribute('aria-expanded', String(ui.open));
    tab.hidden = snap.enabled === false;
    entry.setAttribute('aria-expanded', String(ui.open));
    entryLabel.textContent = L('drawer.title');
    const next = document.createElement('div');
    next.append(...build().filter(Boolean));
    morphChildren(drawer, next);
    if (ui.focus) {
      const wanted = ui.focus;
      ui.focus = null;
      const field = [...drawer.querySelectorAll('[data-fk]')].find(element => element.dataset.fk === wanted);
      if (field) { field.focus(); field.setSelectionRange?.(field.value.length, field.value.length); }
    }
  }

  /* ---------- events (delegated; every control carries data-act and its key) ---------- */
  listen(drawer, 'click', event => {
    const target = event.target.closest?.('[data-act]');
    if (!target || !drawer.contains(target) || target.disabled) return;
    const action = ACTIONS[target.dataset.act];
    if (!action) return;
    action(target.dataset);
    render();
  });
  listen(drawer, 'input', event => {
    const field = event.target, data = field.dataset ?? {};
    if (data.draft === 'edit') ui.edits.set(data.k, field.value);
    else if (data.draft === 'alt') ui.alts.set(data.id, field.value);
    else if (data.draft === 'manual') ui.manual = field.value;
    else if (data.view) {
      // A slider previews without a re-render, so the drag is never interrupted; writes are debounced.
      const spec = VIEW_SLIDERS.find(item => item.key === data.view), value = Number(field.value);
      if (!spec || !Number.isFinite(value)) return;
      slide(spec.key, value, false);
      applyVisual();
      field.closest('.st-echo-sl-box')?.setAttribute('style', fill(spec, value));
      const out = drawer.querySelector(`[data-out="${spec.key}"]`);
      if (out) out.textContent = sliderText(spec, value);
    }
  });
  listen(drawer, 'change', event => {
    const field = event.target, data = field.dataset ?? {};
    if (data.change === 'rx-mode' || data.change === 'rx-scope') {
      const item = banById(data.id);
      if (!item) return;
      if (data.change === 'rx-mode') void call('setRegex', item.id, !!item.regex, field.value);
      else void call('setRegex', item.id, !!item.regex, modeOf(item), field.value);
    } else if (data.view) {
      const spec = VIEW_SLIDERS.find(item => item.key === data.view), value = Number(field.value);
      if (spec && Number.isFinite(value)) slide(spec.key, value, true);
      render();
    }
  });
  listen(drawer, 'keydown', event => {
    const data = event.target.dataset ?? {};
    if (!data.draft || (event.key !== 'Enter' && event.key !== 'Escape')) return;
    event.preventDefault();
    const enter = event.key === 'Enter';
    if (data.draft === 'edit') { if (enter) submitEdit(data.k); else ui.edits.delete(data.k); }
    else if (data.draft === 'alt') { if (enter) saveAlt(data.id); else ui.ban = null; }
    else if (enter) submitManual();
    else ui.manual = null;
    render();
  });
  listen(document, 'keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || !ui.open) return;
    if (ui.menu) ui.menu = null;
    else if (ui.sheet) ui.sheet = false;
    else { close(); return; }
    render();
  });
  // A tap outside the panel closes it on every screen size unless it is pinned (SPEC §20.1), as in Sable Trackers;
  // the edge tab and the wand-menu entry toggle it themselves. The full-width phone layout has nothing outside
  // (style.css). Pinned or not, a tap outside closes the «Оставить» menu and the view sheet (changes are already saved).
  listen(document, 'pointerdown', event => {
    if (!ui.open) return;
    const target = event.target;
    if (!pinned() && !drawer.contains(target) && !tab.contains(target) && !entry.contains(target)) { close(false); return; }
    let changed = false;
    if (ui.menu && !target.closest?.('.st-echo-menu-wrap')) { ui.menu = null; changed = true; }
    if (ui.sheet && !target.closest?.('.st-echo-sheet, [data-act="view"]')) { ui.sheet = false; changed = true; }
    if (changed) render();
  });
  // Swiping the sheet down by its header closes it.
  listen(drawer, 'pointerdown', event => {
    if (!event.target.closest?.('[data-swipe]')) return;
    swipe = { id: event.pointerId, y: event.clientY, dy: 0 };
    event.target.setPointerCapture?.(event.pointerId);
  });
  listen(drawer, 'pointermove', event => {
    if (!swipe || event.pointerId !== swipe.id) return;
    swipe.dy = Math.max(0, event.clientY - swipe.y);
    const sheet = drawer.querySelector('.st-echo-sheet');
    if (sheet) sheet.style.transform = swipe.dy ? `translateY(${swipe.dy}px)` : '';
  });
  const endSwipe = event => {
    if (!swipe || event.pointerId !== swipe.id) return;
    const { dy } = swipe;
    swipe = null;
    drawer.querySelector('.st-echo-sheet')?.style.removeProperty('transform');
    if (dy > SWIPE_CLOSE) { ui.sheet = false; render(); }
  };
  listen(drawer, 'pointerup', endSwipe);
  listen(drawer, 'pointercancel', endSwipe);
  // A click with detail 0 came from the keyboard (Enter or Space on the focused control).
  listen(tab, 'click', event => (ui.open ? close(false) : open(tab, event.detail === 0)));
  listen(entry, 'click', event => open(entry, event.detail === 0));
  listen(entry, 'keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(entry, true); }
  });

  // subscribe() calls back right away (SPEC §15); the explicit render covers a runtime that does not.
  const unsubscribe = runtime.subscribe(next => {
    if (next) snap = next;
    const now = contextOf(snap);
    if (now !== context) { context = now; switched(); }
    render();
  });
  render();

  function unmount() {
    disposed = true;
    unsubscribe?.();
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const timer of timers) win.clearTimeout(timer);
    timers.clear();
    win.clearTimeout(slideTimer);
    drawer.remove();
    tab.remove();
    entry.remove();
  }
  return { unmount, open: () => open(), close: () => close(false), element: drawer };
}
