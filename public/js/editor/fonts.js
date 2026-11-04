// User fonts (.ttf/.otf/.woff/.woff2) added from the Text tab. Kept in the
// browser's IndexedDB so they load again next time, and registered with
// document.fonts so both the canvas and the font pickers can use them.
import { LAO_FONTS } from './lao.js';
import { uid } from './util.js';

const DB = 'lao-cut-fonts';
export const customFonts = []; // { id, family, label }

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('fonts', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction('fonts', mode);
    const r = fn(t.objectStore('fonts'));
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

async function register(rec) {
  const face = new FontFace(rec.family, await rec.blob.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  customFonts.push({ id: rec.id, family: rec.family, label: `${rec.family} (ຟອນຂອງຂ້ອຍ)` });
}

export async function loadCustomFonts() {
  try {
    const recs = await run('readonly', s => s.getAll());
    for (const r of recs || []) await register(r).catch(() => {});
  } catch (e) { /* IndexedDB unavailable: built-in fonts only */ }
}

export function allFonts() {
  return [...LAO_FONTS, ...customFonts];
}

export async function addFontFile(file) {
  if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) throw new Error('ຮອງຮັບສະເພາະໄຟລ໌ .ttf .otf .woff .woff2');
  if (file.size > 15 * 1024 * 1024) throw new Error('ໄຟລ໌ຟອນໃຫຍ່ເກີນ 15 MB');
  let family = file.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N} _-]/gu, ' ').trim().slice(0, 40) || 'My Font';
  const taken = new Set(allFonts().map(f => f.family.toLowerCase()));
  for (let n = 2; taken.has(family.toLowerCase()); n++) family = `${family.replace(/ \d+$/, '')} ${n}`;
  const rec = { id: uid(), family, blob: file };
  try {
    await register(rec);
  } catch (e) {
    throw new Error('ໄຟລ໌ນີ້ບໍ່ແມ່ນຟອນທີ່ເບົາເຊີອ່ານໄດ້');
  }
  await run('readwrite', s => s.put(rec)).catch(() => {});
  return customFonts[customFonts.length - 1];
}

export async function removeFont(id) {
  const i = customFonts.findIndex(f => f.id === id);
  if (i >= 0) customFonts.splice(i, 1);
  await run('readwrite', s => s.delete(id)).catch(() => {});
}
