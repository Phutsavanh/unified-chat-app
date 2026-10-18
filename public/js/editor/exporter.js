// Real-time export: plays the timeline from 0 while recording the preview
// canvas plus the Web Audio mix with MediaRecorder. Subtitles and text are
// burned in because they are drawn onto the canvas.
import { state, totalDuration } from './store.js';

const TYPES = [
  ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'],
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp9,opus', 'webm'],
  ['video/webm;codecs=vp8,opus', 'webm'],
  ['video/webm', 'webm']
];

export function supportedFormats() {
  if (typeof MediaRecorder === 'undefined') return [];
  return TYPES.filter(([t]) => MediaRecorder.isTypeSupported(t));
}

export async function exportVideo(player, { scale = 1, fps = 30, format = null, bitrate = 8e6, onProgress }) {
  const total = totalDuration();
  if (total <= 0) throw new Error('timeline ຫວ່າງເປົ່າ');
  const formats = supportedFormats();
  const chosen = formats.find(f => f[1] === format) || formats[0];
  if (!chosen) throw new Error('ເບົາເຊີນີ້ບໍ່ຮອງຮັບການບັນທຶກວິດີໂອ (ລອງ Chrome ຫຼື Edge)');

  player.pause();
  player.ensureAudio();
  player.resize(scale);
  player.exporting = true;
  const prevSel = state.selection;
  state.selection = null;

  const stream = player.canvas.captureStream(fps);
  for (const tr of player.recordDest.stream.getAudioTracks()) stream.addTrack(tr);
  const rec = new MediaRecorder(stream, { mimeType: chosen[0], videoBitsPerSecond: bitrate * scale });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);

  // let the first frame load before recording starts
  player.seek(0);
  await new Promise(r => setTimeout(r, 600));

  let cancelled = false;
  let failed = false;
  const done = new Promise(resolve => {
    rec.onstop = resolve;
    rec.onerror = () => { failed = true; player.pause(); resolve(); };
    player.onEnded = () => rec.state !== 'inactive' && rec.stop();
  });
  const timer = setInterval(() => onProgress && onProgress(state.time / total), 250);

  rec.start(1000);
  player.play();
  const cancel = () => { cancelled = true; player.pause(); if (rec.state !== 'inactive') rec.stop(); };
  exportVideo.cancel = cancel;
  await done;

  clearInterval(timer);
  player.onEnded = null;
  player.exporting = false;
  state.selection = prevSel;
  player.resize(1);
  stream.getVideoTracks().forEach(t => t.stop());
  if (failed) throw new Error('ການບັນທຶກວິດີໂອລົ້ມເຫຼວ — ລອງຄວາມລະອຽດຕ່ຳລົງ ຫຼື ຮູບແບບອື່ນ');
  if (cancelled) return null;
  return { blob: new Blob(chunks, { type: chosen[0].split(';')[0] }), ext: chosen[1] };
}
