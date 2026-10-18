// Project state, undo/redo, and autosave to IndexedDB (media files included,
// so a refresh doesn't lose work). Media blobs live outside the undo history.
import { uid } from './util.js';

export const ASPECTS = {
  '16:9': [1280, 720],
  '9:16': [720, 1280],
  '1:1': [1080, 1080],
  '4:5': [864, 1080]
};

export const DEFAULT_TEXT_STYLE = {
  font: 'Noto Sans Lao',
  size: 48,
  bold: true,
  color: '#ffffff',
  stroke: '#000000',
  strokeWidth: 4,
  bg: false,
  bgColor: '#000000',
  bgOpacity: 0.6,
  shadow: true,
  x: 0.5,
  y: 0.5,
  anim: 'fade'
};

export const DEFAULT_SUB_STYLE = {
  ...DEFAULT_TEXT_STYLE,
  size: 40,
  y: 0.86,
  strokeWidth: 3,
  bg: true,
  bgOpacity: 0.45,
  anim: 'none',
  maxChars: 38,
  laoDigits: false
};

function emptyProject() {
  return {
    name: 'ໂປຣເຈັກໃໝ່',
    aspect: '16:9',
    tracks: { video: [], audio: [], text: [], subs: [], stickers: [], effects: [] },
    trackState: {},
    subStyle: { ...DEFAULT_SUB_STYLE }
  };
}

export const state = {
  project: emptyProject(),
  media: new Map(),   // id → { id, name, type, blob, url, duration, width, height, thumb, hasAudio }
  selection: null,    // { track, id }
  time: 0,
  playing: false,
  zoom: 60            // px per second
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(kind = 'project') {
  for (const fn of listeners) fn(kind);
  // 'edit' = live typing/slider change: saved, but panels aren't rebuilt
  if (kind === 'project' || kind === 'edit') scheduleSave();
}

// ---- undo / redo ----
const undoStack = [];
const redoStack = [];
const snapshot = () => JSON.stringify(state.project);

export function checkpoint() {
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}

export function commit(mutate) {
  checkpoint();
  mutate(state.project);
  emit('project');
}

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  state.project = JSON.parse(undoStack.pop());
  fixSelection();
  emit('project');
}

export function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  state.project = JSON.parse(redoStack.pop());
  fixSelection();
  emit('project');
}

function fixSelection() {
  // undo can bring back clips whose media file has since been deleted
  const t = state.project.tracks;
  t.video = t.video.filter(c => state.media.has(c.mediaId));
  t.audio = t.audio.filter(c => state.media.has(c.mediaId));
  t.stickers = t.stickers.filter(c => c.kind !== 'image' || state.media.has(c.mediaId));
  if (state.selection && !findClip(state.selection.track, state.selection.id)) state.selection = null;
}

// ---- queries ----
export function findClip(track, id) {
  return state.project.tracks[track]?.find(c => c.id === id) || null;
}

export function selectedClip() {
  return state.selection ? findClip(state.selection.track, state.selection.id) : null;
}

// timeline length of a clip: source range played at its speed
export function clipDuration(c) { return (c.out - c.in) / (c.speed || 1); }

// per-track hide / mute / lock (CapCut-style track header buttons)
export function trackFlag(track, flag) {
  const ts = state.project.trackState;
  return Boolean(ts && ts[track] && ts[track][flag]);
}

export const DEFAULT_TF = { scale: 1, x: 0, y: 0, rot: 0, opacity: 1, flip: false };
export const DEFAULT_ANIM = { inType: 'none', inDur: 0.5, outType: 'none', outDur: 0.5 };

// The main video track is magnetic (no gaps), like CapCut: start times are
// derived from order.
export function videoLayout() {
  let t = 0;
  return state.project.tracks.video.map(c => {
    const d = clipDuration(c);
    const item = { clip: c, start: t, end: t + d };
    t += d;
    return item;
  });
}

export function videoClipStart(id) {
  const item = videoLayout().find(l => l.clip.id === id);
  return item ? item.start : 0;
}

export function totalDuration() {
  const { tracks } = state.project;
  let d = videoLayout().reduce((m, l) => Math.max(m, l.end), 0);
  for (const c of tracks.audio) d = Math.max(d, c.start + clipDuration(c));
  for (const c of tracks.text) d = Math.max(d, c.end);
  for (const c of tracks.subs) d = Math.max(d, c.end);
  for (const c of tracks.stickers) d = Math.max(d, c.end);
  for (const c of tracks.effects) d = Math.max(d, c.end);
  return d;
}

export function sortTrack(name) {
  state.project.tracks[name].sort((a, b) => a.start - b.start);
}

export function newId() { return uid(); }

// A subtitle may carry a translation (`tr`) shown as a second line.
export function subDisplay(s) {
  return s.tr ? `${s.text}\n${s.tr}` : s.text;
}

// ---- persistence ----
const DB_NAME = 'lao-cut';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('media', { keyPath: 'id' });
        req.result.createObjectStore('project');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    tx('project', 'readwrite', s => s.put(snapshot(), 'current'))
      .then(() => { state.savedAt = new Date(); emit('saved'); })
      .catch(() => {});
  }, 800);
}

export async function persistMedia(m) {
  try {
    await tx('media', 'readwrite', s => s.put({
      id: m.id, name: m.name, type: m.type, blob: m.blob, hidden: Boolean(m.hidden),
      libId: m.libId, credit: m.credit, license: m.license
    }));
  } catch (e) {
    console.warn('ບັນທຶກໄຟລ໌ລົງເບົາເຊີບໍ່ໄດ້ (ພື້ນທີ່ອາດເຕັມ)', e);
  }
}

export async function deleteMedia(id) {
  try { await tx('media', 'readwrite', s => s.delete(id)); } catch (e) { /* ignore */ }
}

export async function loadSaved() {
  try {
    const json = await tx('project', 'readonly', s => s.get('current'));
    const media = await tx('media', 'readonly', s => s.getAll());
    return { project: json ? JSON.parse(json) : null, media: media || [] };
  } catch (e) {
    return { project: null, media: [] };
  }
}

export function resetProject() {
  checkpoint();
  state.project = emptyProject();
  state.selection = null;
  state.time = 0;
  emit('project');
}

export function loadProject(p) {
  const base = emptyProject();
  state.project = {
    ...base,
    ...p,
    tracks: { ...base.tracks, ...(p.tracks || {}) },
    subStyle: { ...base.subStyle, ...(p.subStyle || {}) }
  };
}
