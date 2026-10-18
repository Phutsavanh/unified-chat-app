// AI editing assistant. The model gets a summary of the project plus the
// catalogue of what the editor can do, and answers with a short Lao reply and
// a list of actions. Actions are validated here and applied as one undo step,
// so the same flow works with both AI backends and nothing runs unchecked.
import { state, commit, undo, newId, sortTrack, videoLayout, totalDuration, DEFAULT_TEXT_STYLE, ASPECTS } from './store.js';
import { askAI } from './ai.js';
import { MUSIC, SFX } from './library/audio.js';
import { EFFECTS, TRANSITIONS, FILTERS, EMOJI, BADGES, ADJUST_DEFAULT } from './library/visual.js';
import { LAO_FONTS } from './lao.js';
import { escapeHtml } from './timeline.js';

const POS = { top: 0.16, center: 0.5, bottom: 0.8 };
const num = (v, d, min = -Infinity, max = Infinity) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

function catalogue(textPresets) {
  return [
    `text presets: ${textPresets.map((p, i) => `${i}=${p.name}`).join(', ')}`,
    `stickers: any emoji (e.g. ${Object.values(EMOJI).flat().slice(0, 30).join(' ')}) or badges: ${BADGES.map(b => `${b.id} (${b.name})`).join(', ')}`,
    `effects: ${EFFECTS.map(e => `${e.id} (${e.name})`).join(', ')}`,
    `transitions: ${TRANSITIONS.map(t => `${t.id} (${t.name})`).join(', ')}`,
    `filters: ${FILTERS.map(f => `${f.id} (${f.name})`).join(', ')}`,
    `music: ${MUSIC.map(m => `${m.id} (${m.name}, ${m.mood})`).join('; ')}`,
    `sound effects: ${SFX.map(s => `${s.id} (${s.name})`).join(', ')}`,
    `fonts: ${LAO_FONTS.map(f => f.family).join(', ')}`,
    `aspect ratios: ${Object.keys(ASPECTS).join(', ')}`
  ].join('\n');
}

function summary() {
  const p = state.project;
  const r = n => Math.round(n * 100) / 100;
  return JSON.stringify({
    name: p.name,
    aspect: p.aspect,
    duration: r(totalDuration()),
    playhead: r(state.time),
    videoClips: videoLayout().map((l, i) => {
      const m = state.media.get(l.clip.mediaId);
      return { clip: i + 1, name: m ? m.name : '?', type: m ? m.type : '?', start: r(l.start), end: r(l.end),
        filter: l.clip.filter ? l.clip.filter.id : null, transitionIn: l.clip.trans ? l.clip.trans.type : null, speed: l.clip.speed || 1 };
    }),
    subtitles: p.tracks.subs.slice(0, 60).map(s => ({ start: r(s.start), end: r(s.end), text: s.text })),
    texts: p.tracks.text.map(t => ({ start: r(t.start), end: r(t.end), text: t.text })),
    stickers: p.tracks.stickers.length,
    effects: p.tracks.effects.map(e => ({ effect: e.fx, start: r(e.start), end: r(e.end) })),
    audio: p.tracks.audio.map(a => ({ name: (state.media.get(a.mediaId) || {}).name, start: r(a.start) }))
  });
}

const ACTION_DOC = `Actions (all times in seconds on the timeline; omit "start" to use the playhead):
{"type":"addText","text":string,"start":n,"duration":n,"preset":index,"position":"top"|"center"|"bottom"}
{"type":"addSticker","emoji":string OR "badge":id,"start":n,"duration":n,"position":"top"|"center"|"bottom","x":0-1}
{"type":"addEffect","effect":id,"start":n,"duration":n}
{"type":"addTransition","transition":id,"clip":n (the clip AFTER the cut, 2..N) OR "all":true,"duration":0.2-2}
{"type":"setFilter","filter":id,"clips":"all" or [clip numbers],"amount":0-1}
{"type":"adjust","clips":"all" or [clip numbers],"brightness":-100..100,"contrast":-100..100,"saturation":-100..100,"temperature":-100..100,"vignette":0..100}
{"type":"addMusic","music":id,"start":n,"volume":0-1}
{"type":"addSound","sound":id,"start":n}
{"type":"subtitleStyle","font":string,"size":12-140,"color":"#rrggbb","position":"top"|"bottom","background":bool}
{"type":"setSpeed","clip":n,"speed":0.25-4}
{"type":"setAspect","aspect":string}`;

export function initAssistant({ $, toast, textPresets, addLibraryAudio, getStatus }) {
  const log = $('#aiChat');
  const turns = [];
  let ctl = null;

  function bubble(role, html) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  async function apply(actions) {
    const done = [];
    // audio needs rendering first (async); everything else is one commit
    const audio = [];
    for (const a of actions) {
      if (a.type === 'addMusic' && MUSIC.some(m => m.id === a.music)) audio.push(['music', a.music, num(a.start, state.time, 0), num(a.volume, 0.5, 0, 1)]);
      if (a.type === 'addSound' && SFX.some(s => s.id === a.sound)) audio.push(['sfx', a.sound, num(a.start, state.time, 0), 1]);
    }
    const audioMedia = [];
    for (const [kind, id, start, volume] of audio) audioMedia.push({ m: await addLibraryAudio(kind, id), start, volume, kind });

    const layout = videoLayout();
    const clipsOf = sel => sel === 'all' || sel === undefined ? layout.map(l => l.clip)
      : (Array.isArray(sel) ? sel : [sel]).map(n => layout[num(n, 0) - 1]).filter(Boolean).map(l => l.clip);

    commit(p => {
      for (const { m, start, volume, kind } of audioMedia) {
        p.tracks.audio.push({ id: newId(), mediaId: m.id, start, in: 0, out: m.duration, volume });
        done.push(kind === 'music' ? `ເພງ "${m.name}"` : `ສຽງ "${m.name}"`);
      }
      for (const a of actions) {
        const start = num(a.start, state.time, 0);
        const dur = num(a.duration, 3, 0.3, 60);
        switch (a.type) {
          case 'addText': {
            if (!a.text) break;
            const preset = textPresets[num(a.preset, 0, 0, textPresets.length - 1)];
            p.tracks.text.push({ id: newId(), start, end: start + dur, text: String(a.text).slice(0, 200),
              style: { ...DEFAULT_TEXT_STYLE, ...preset.style, y: POS[a.position] ?? 0.5 } });
            done.push(`ຂໍ້ຄວາມ "${String(a.text).slice(0, 20)}"`);
            break;
          }
          case 'addSticker': {
            const badge = BADGES.find(b => b.id === a.badge);
            if (!badge && !a.emoji) break;
            p.tracks.stickers.push({ id: newId(), start, end: start + dur, kind: badge ? 'badge' : 'emoji',
              value: badge ? badge.id : String(a.emoji).slice(0, 8), x: num(a.x, 0.5, 0, 1), y: POS[a.position] ?? 0.4,
              size: badge ? 0.4 : 0.22, rot: 0, anim: 'pop' });
            done.push(`ສະຕິກເກີ ${badge ? badge.name : a.emoji}`);
            break;
          }
          case 'addEffect':
            if (!EFFECTS.some(e => e.id === a.effect)) break;
            p.tracks.effects.push({ id: newId(), start, end: start + dur, fx: a.effect, amount: 1 });
            done.push(`ເອັບເຟັກ ${EFFECTS.find(e => e.id === a.effect).name}`);
            break;
          case 'addTransition': {
            if (!TRANSITIONS.some(t => t.id === a.transition)) break;
            const t = { type: a.transition, dur: num(a.duration, 0.6, 0.2, 2) };
            const targets = a.all ? p.tracks.video.slice(1) : [p.tracks.video[num(a.clip, 0) - 1]].filter((c, i) => c && num(a.clip, 0) > 1);
            targets.forEach(c => { c.trans = { ...t }; });
            if (targets.length) done.push(`ທຣານຊິຊັນ ${TRANSITIONS.find(x => x.id === t.type).name}`);
            break;
          }
          case 'setFilter': {
            const f = FILTERS.find(x => x.id === a.filter);
            if (!f) break;
            const ids = new Set(clipsOf(a.clips).map(c => c.id));
            p.tracks.video.forEach(c => {
              if (!ids.has(c.id)) return;
              if (f.id === 'none') delete c.filter; else c.filter = { id: f.id, amount: num(a.amount, 1, 0, 1) };
            });
            done.push(`ຟິວເຕີ ${f.name}`);
            break;
          }
          case 'adjust': {
            const ids = new Set(clipsOf(a.clips).map(c => c.id));
            p.tracks.video.forEach(c => {
              if (!ids.has(c.id)) return;
              const adj = { ...ADJUST_DEFAULT, ...c.adj };
              for (const k of ['brightness', 'contrast', 'saturation', 'temperature', 'vignette']) {
                if (a[k] !== undefined) adj[k] = num(a[k], 0, k === 'vignette' ? 0 : -100, 100);
              }
              c.adj = adj;
            });
            done.push('ປັບແຕ່ງສີ');
            break;
          }
          case 'subtitleStyle': {
            const s = p.subStyle;
            if (LAO_FONTS.some(f => f.family === a.font)) s.font = a.font;
            if (a.size !== undefined) s.size = num(a.size, s.size, 12, 140);
            if (/^#[0-9a-f]{6}$/i.test(a.color || '')) s.color = a.color;
            if (a.position) s.y = a.position === 'top' ? 0.12 : 0.86;
            if (typeof a.background === 'boolean') s.bg = a.background;
            done.push('ຮູບແບບຊັບ');
            break;
          }
          case 'setSpeed': {
            const c = p.tracks.video[num(a.clip, 0) - 1];
            if (!c) break;
            c.speed = num(a.speed, 1, 0.25, 4);
            done.push(`ຄວາມໄວຄລິບ ${a.clip} = ${c.speed}x`);
            break;
          }
          case 'setAspect':
            if (ASPECTS[a.aspect]) { p.aspect = a.aspect; done.push(`ອັດຕາສ່ວນ ${a.aspect}`); }
            break;
        }
      }
      for (const k of ['text', 'stickers', 'effects', 'audio']) sortTrack(k);
    });
    return done;
  }

  async function send(text) {
    if (!text.trim()) return;
    bubble('user', escapeHtml(text));
    const reply = bubble('bot', '<span class="thinking">ກຳລັງຄິດ...</span>');
    $('#aiSend').hidden = true;
    $('#aiStop').hidden = false;
    ctl = new AbortController();
    const history = turns.slice(-6).map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`).join('\n');
    const prompt = `You are the editing assistant inside LaoCut, a CapCut-style video editor for Lao creators. ` +
      `Talk to the user in Lao (Lao script only, modern spelling). Turn their request into editor actions.\n\n` +
      `What the editor offers:\n${catalogue(textPresets)}\n\n${ACTION_DOC}\n\n` +
      `Current project:\n${summary()}\n\n${history ? `Conversation so far:\n${history}\n\n` : ''}User: ${text}\n\n` +
      'Reply with only a JSON object: {"reply": short Lao message saying what you did or asking a question, "actions": [...]}. ' +
      'Use only ids from the lists. Keep text overlays short. If the request needs something the editor cannot do ' +
      '(for example speech recognition when there are no subtitles), say so in the reply and return no actions.';
    try {
      const out = await askAI(prompt, { json: true, status: getStatus(), signal: ctl.signal });
      const actions = Array.isArray(out && out.actions) ? out.actions.slice(0, 40) : [];
      const done = actions.length ? await apply(actions) : [];
      const msg = String((out && out.reply) || (done.length ? 'ແລ້ວໆ' : ''));
      reply.innerHTML = escapeHtml(msg) + (done.length
        ? `<ul class="did">${done.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul><button class="undo-ai">ຍົກເລີກການແກ້ໄຂນີ້</button>` : '');
      const undoBtn = reply.querySelector('.undo-ai');
      if (undoBtn) undoBtn.onclick = () => { undo(); undoBtn.disabled = true; undoBtn.textContent = 'ຍົກເລີກແລ້ວ'; };
      turns.push({ role: 'user', text }, { role: 'assistant', text: msg });
    } catch (e) {
      if (e && e.code === 'cancelled') reply.innerHTML = '<span class="muted">ຢຸດແລ້ວ</span>';
      else reply.innerHTML = `<span class="err">${escapeHtml(e.message || String(e))}</span>`;
    } finally {
      $('#aiSend').hidden = false;
      $('#aiStop').hidden = true;
      log.scrollTop = log.scrollHeight;
    }
  }

  $('#aiForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#aiInput').value;
    $('#aiInput').value = '';
    send(v);
  });
  $('#aiInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#aiForm').requestSubmit(); }
  });
  $('#aiStop').addEventListener('click', () => ctl && ctl.abort());
  $('#aiSuggest').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) send(b.textContent);
  });
}
