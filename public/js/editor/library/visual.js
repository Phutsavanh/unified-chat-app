// Filters, adjustments, effects, transitions and drawn stickers. Everything is
// rendered with the 2D canvas so previews and exports look identical.

// ---------------------------------------------------------------- filters
// f: canvas filter functions (1 = neutral), tint: [color, strength] applied in
// soft-light, vignette: 0..1
export const FILTERS = [
  { id: 'none', name: 'ຕົ້ນສະບັບ' },
  { id: 'vivid', name: 'ສົດໃສ', f: { saturate: 1.45, contrast: 1.1 } },
  { id: 'gold', name: 'ທອງຫຼວງພະບາງ', f: { saturate: 1.2, contrast: 1.05 }, tint: ['#e8b54d', 0.3], vignette: 0.25 },
  { id: 'mekong', name: 'ແສງແລງແມ່ຂອງ', f: { saturate: 1.25 }, tint: ['#ff6b4a', 0.28] },
  { id: 'warm', name: 'ອົບອຸ່ນ', f: { saturate: 1.1 }, tint: ['#ff9a3c', 0.25] },
  { id: 'cool', name: 'ເຢັນສະບາຍ', tint: ['#3c8cff', 0.25] },
  { id: 'green', name: 'ທຳມະຊາດ', f: { saturate: 1.3 }, tint: ['#5bd16a', 0.18] },
  { id: 'pastel', name: 'ພາສເທວ', f: { saturate: 0.7, brightness: 1.12, contrast: 0.9 }, tint: ['#ffc6e0', 0.2] },
  { id: 'fade', name: 'ຈາງ', f: { contrast: 0.8, brightness: 1.1, saturate: 0.75 } },
  { id: 'vintage', name: 'ວິນເທດ', f: { sepia: 0.35, saturate: 0.8, contrast: 0.9, brightness: 1.05 }, tint: ['#f5d29b', 0.2], vignette: 0.4 },
  { id: 'film', name: 'ຟິມ', f: { contrast: 1.15, saturate: 0.85 }, tint: ['#2a9d8f', 0.12], vignette: 0.3 },
  { id: 'cinema', name: 'ຮູບເງົາ', f: { contrast: 1.2, saturate: 0.9, 'hue-rotate': -6 }, tint: ['#1b6e7a', 0.18], vignette: 0.35 },
  { id: 'tealorange', name: 'Teal & Orange', f: { contrast: 1.15, saturate: 1.2, 'hue-rotate': -8 }, tint: ['#ff9b54', 0.16] },
  { id: 'dramatic', name: 'ດຣາມາ', f: { contrast: 1.4, saturate: 0.9, brightness: 0.95 }, vignette: 0.5 },
  { id: 'night', name: 'ກາງຄືນ', f: { brightness: 0.8, saturate: 0.8, contrast: 1.1 }, tint: ['#2b4cff', 0.25] },
  { id: 'neon', name: 'ນີອອນ', f: { saturate: 1.8, contrast: 1.2, 'hue-rotate': 15 } },
  { id: 'sepia', name: 'ຊີເປຍ', f: { sepia: 0.85 } },
  { id: 'bw', name: 'ຂາວດຳ', f: { grayscale: 1, contrast: 1.15 } },
  { id: 'noir', name: 'ນົວ', f: { grayscale: 1, contrast: 1.5, brightness: 0.9 }, vignette: 0.45 },
  { id: 'soft', name: 'ນຸ້ມນວນ', f: { contrast: 0.92, brightness: 1.06, saturate: 1.05 }, tint: ['#ffe3c4', 0.15] }
];

export const ADJUST_DEFAULT = { brightness: 0, contrast: 0, saturation: 0, temperature: 0, hue: 0, vignette: 0, blur: 0 };
export const ADJUST_FIELDS = [
  ['brightness', 'ຄວາມແຈ້ງ'], ['contrast', 'ຄວາມຄົມຊັດ'], ['saturation', 'ຄວາມອີ່ມຕົວສີ'],
  ['temperature', 'ອຸນຫະພູມສີ (ເຢັນ ↔ ອຸ່ນ)'], ['hue', 'ໂທນສີ'], ['vignette', 'ຂອບມືດ'], ['blur', 'ຄວາມມົວ']
];

// Combined look of a clip: filter preset (with intensity) + manual adjustments.
export function clipLook(clip, unit = 1) {
  const fp = FILTERS.find(x => x.id === (clip.filter && clip.filter.id)) || FILTERS[0];
  const k = clip.filter ? clip.filter.amount ?? 1 : 0;
  const a = { ...ADJUST_DEFAULT, ...(clip.adj || {}) };
  const f = fp.f || {};
  const mul = (name, extra = 1) => (1 + ((f[name] ?? 1) - 1) * k) * extra;
  const parts = [];
  const bri = mul('brightness', 1 + a.brightness / 200);
  const con = mul('contrast', 1 + a.contrast / 160);
  const sat = mul('saturate', 1 + a.saturation / 100);
  const hue = (f['hue-rotate'] || 0) * k + a.hue * 1.8;
  if (bri !== 1) parts.push(`brightness(${bri.toFixed(3)})`);
  if (con !== 1) parts.push(`contrast(${con.toFixed(3)})`);
  if (sat !== 1) parts.push(`saturate(${Math.max(0, sat).toFixed(3)})`);
  if (f.sepia) parts.push(`sepia(${(f.sepia * k).toFixed(3)})`);
  if (f.grayscale) parts.push(`grayscale(${(f.grayscale * k).toFixed(3)})`);
  if (hue) parts.push(`hue-rotate(${hue.toFixed(1)}deg)`);
  if (a.blur > 0) parts.push(`blur(${(a.blur / 10 * unit).toFixed(2)}px)`);
  const tints = [];
  if (fp.tint) tints.push([fp.tint[0], fp.tint[1] * k]);
  if (a.temperature) tints.push([a.temperature > 0 ? '#ff9a3c' : '#3c8cff', Math.abs(a.temperature) / 100 * 0.35]);
  return {
    filter: parts.join(' ') || 'none',
    tints,
    vignette: Math.min(1, (fp.vignette || 0) * k + a.vignette / 100)
  };
}

// Colour grade: soft-light keeps contrast, a lighter 'color' pass actually
// moves the hue (soft-light alone is too subtle to notice).
export function drawTints(ctx, tints, W, H) {
  for (const [color, alpha] of tints) {
    if (alpha <= 0.001) continue;
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = Math.min(1, alpha * 2);
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'color';
    ctx.globalAlpha = Math.min(0.6, alpha * 0.6);
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

export function drawVignette(ctx, amount, W, H) {
  if (amount <= 0.001) return;
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) / 2);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${Math.min(0.9, amount * 0.85)})`);
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

// ---------------------------------------------------------------- effects (effects track)
export const EFFECTS = [
  { id: 'shake', name: 'ສັ່ນ', cat: 'motion' },
  { id: 'zoompulse', name: 'ຊູມເຕັ້ນຕາມຈັງຫວະ', cat: 'motion' },
  { id: 'kenburns', name: 'ຊູມຊ້າ (Ken Burns)', cat: 'motion' },
  { id: 'mirror', name: 'ກະຈົກ', cat: 'motion' },
  { id: 'flash', name: 'ແຟຣດ', cat: 'light' },
  { id: 'lightleak', name: 'ແສງຮົ່ວ', cat: 'light' },
  { id: 'glitch', name: 'ກລິດ', cat: 'retro' },
  { id: 'vhs', name: 'VHS ເທັບເກົ່າ', cat: 'retro' },
  { id: 'grain', name: 'ເມັດຟິມ', cat: 'retro' },
  { id: 'bwfx', name: 'ຂາວດຳ', cat: 'retro' },
  { id: 'letterbox', name: 'ຂອບຮູບເງົາ', cat: 'frame' },
  { id: 'vignettefx', name: 'ຂອບມືດ', cat: 'frame' },
  { id: 'blurfx', name: 'ມົວ', cat: 'frame' },
  { id: 'snow', name: 'ຫິມະຕົກ', cat: 'particle' },
  { id: 'rain', name: 'ຝົນຕົກ', cat: 'particle' },
  { id: 'hearts', name: 'ຫົວໃຈລອຍ', cat: 'particle' },
  { id: 'sparkles', name: 'ປະກາຍດາວ', cat: 'particle' },
  { id: 'confetti', name: 'ກະດາດສີ', cat: 'particle' },
  { id: 'bubbles', name: 'ຟອງລອຍ', cat: 'particle' },
  { id: 'lanterns', name: 'ໂຄມລອຍ (ບຸນ)', cat: 'particle' }
];
export const EFFECT_CATS = [['all', 'ທັງໝົດ'], ['motion', 'ເຄື່ອນໄຫວ'], ['light', 'ແສງ'], ['retro', 'ຍ້ອນຍຸກ'], ['frame', 'ກອບ'], ['particle', 'ອະນຸພາກ']];

// Transform contributed to the media layer at time t (seconds into the effect).
export function effectTransform(fx, t, dur, k, W, H) {
  const tr = { scale: 1, tx: 0, ty: 0, rot: 0, flip: false };
  switch (fx) {
    case 'shake': {
      const a = Math.min(W, H) * 0.012 * k;
      tr.tx = Math.sin(t * 47) * a + Math.sin(t * 29) * a * 0.5;
      tr.ty = Math.cos(t * 41) * a;
      tr.scale = 1.03;
      break;
    }
    case 'zoompulse': tr.scale = 1 + 0.07 * k * Math.pow(Math.abs(Math.sin(t * Math.PI * 2)), 4); break;
    case 'kenburns': tr.scale = 1 + 0.18 * k * Math.min(1, t / Math.max(0.1, dur)); break;
    case 'mirror': tr.flip = true; break;
  }
  return tr;
}

let grainCanvas = null;
function grain() {
  if (grainCanvas) return grainCanvas;
  grainCanvas = document.createElement('canvas');
  grainCanvas.width = grainCanvas.height = 256;
  const g = grainCanvas.getContext('2d');
  const img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return grainCanvas;
}

const hash = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

function particles(ctx, kind, t, k, W, H) {
  const unit = Math.min(W, H);
  const count = Math.round({ snow: 90, rain: 140, hearts: 22, sparkles: 40, confetti: 70, bubbles: 26, lanterns: 14 }[kind] * (0.4 + 0.6 * k));
  ctx.save();
  for (let i = 0; i < count; i++) {
    const r1 = hash(i), r2 = hash(i + 99), r3 = hash(i + 517);
    const speed = { snow: 0.08, rain: 0.9, hearts: 0.12, sparkles: 0, confetti: 0.22, bubbles: 0.1, lanterns: 0.05 }[kind] * (0.6 + r2);
    const rising = kind === 'hearts' || kind === 'bubbles' || kind === 'lanterns';
    let y = (r2 + t * speed) % 1.1 - 0.05;
    if (rising) y = 1.05 - y;
    const x = (r1 + Math.sin(t * (0.5 + r3) + i) * (kind === 'rain' ? 0 : 0.02)) % 1;
    const px = x * W, py = y * H;
    switch (kind) {
      case 'snow':
        ctx.fillStyle = 'rgba(255,255,255,.85)';
        ctx.beginPath(); ctx.arc(px, py, unit * (0.003 + r3 * 0.005), 0, Math.PI * 2); ctx.fill();
        break;
      case 'rain':
        ctx.strokeStyle = 'rgba(190,210,255,.45)'; ctx.lineWidth = unit * 0.0015;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - unit * 0.006, py + unit * 0.04); ctx.stroke();
        break;
      case 'hearts':
        ctx.globalAlpha = 0.85;
        ctx.font = `${unit * (0.03 + r3 * 0.03)}px sans-serif`;
        ctx.fillText(['❤️', '💖', '💕'][i % 3], px, py);
        break;
      case 'sparkles': {
        const tw = Math.max(0, Math.sin(t * (2 + r3 * 3) + i * 1.7));
        const s = unit * (0.006 + r3 * 0.012) * tw;
        ctx.fillStyle = `rgba(255,236,170,${0.9 * tw})`;
        ctx.beginPath();
        ctx.moveTo(px, py - s * 2); ctx.quadraticCurveTo(px, py, px + s * 2, py);
        ctx.quadraticCurveTo(px, py, px, py + s * 2); ctx.quadraticCurveTo(px, py, px - s * 2, py);
        ctx.quadraticCurveTo(px, py, px, py - s * 2); ctx.fill();
        break;
      }
      case 'confetti':
        ctx.save(); ctx.translate(px, py); ctx.rotate(t * (2 + r3 * 4) + i);
        ctx.fillStyle = ['#ff4d6d', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff'][i % 5];
        ctx.fillRect(-unit * 0.006, -unit * 0.003, unit * 0.012, unit * 0.006);
        ctx.restore();
        break;
      case 'bubbles':
        ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = unit * 0.002;
        ctx.beginPath(); ctx.arc(px, py, unit * (0.01 + r3 * 0.025), 0, Math.PI * 2); ctx.stroke();
        break;
      case 'lanterns': {
        // floating paper lanterns, like at Boun Ok Phansa
        const s = unit * (0.02 + r3 * 0.025);
        const g = ctx.createRadialGradient(px, py, 0, px, py, s * 2.2);
        g.addColorStop(0, 'rgba(255,200,90,.55)'); g.addColorStop(1, 'rgba(255,140,40,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, s * 2.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffb347';
        ctx.beginPath(); ctx.ellipse(px, py, s * 0.6, s * 0.8, 0, 0, Math.PI * 2); ctx.fill();
        break;
      }
    }
  }
  ctx.restore();
}

// Overlay drawn on top of the composed frame (before text and subtitles).
export function drawEffectOverlay(ctx, canvas, fx, t, dur, k, W, H) {
  switch (fx) {
    case 'flash': {
      const a = Math.max(0, 1 - (t % 0.5) / 0.25) * 0.7 * k;
      if (a > 0) { ctx.save(); ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.fillRect(0, 0, W, H); ctx.restore(); }
      break;
    }
    case 'lightleak': {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < 2; i++) {
        const x = W * (0.5 + 0.6 * Math.sin(t * 0.7 + i * 2.5)), y = H * (0.3 + 0.4 * Math.cos(t * 0.5 + i));
        const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(W, H) * 0.6);
        g.addColorStop(0, `rgba(255,${i ? 120 : 170},60,${0.5 * k})`); g.addColorStop(1, 'rgba(255,80,40,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      ctx.restore();
      break;
    }
    case 'glitch': {
      const s = Math.floor(t * 12);
      if (hash(s) < 0.55 * k + 0.1) {
        const off = W * 0.012 * k;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.35;
        ctx.drawImage(canvas, off, 0);
        ctx.drawImage(canvas, -off, 0);
        ctx.restore();
        for (let i = 0; i < 5; i++) {
          const y = hash(s * 7 + i) * H, h = H * 0.03 * (0.5 + hash(s + i * 3));
          const dx = (hash(s * 13 + i) - 0.5) * W * 0.08 * k;
          ctx.drawImage(canvas, 0, y, W, h, dx, y, W, h);
        }
      }
      break;
    }
    case 'vhs': {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1.5);
      ctx.globalAlpha = 0.08 * k;
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillStyle = ctx.createPattern(grain(), 'repeat');
      ctx.translate(Math.random() * 256, Math.random() * 256);
      ctx.fillRect(-256, -256, W + 512, H + 512);
      ctx.restore();
      ctx.save();
      const bandY = ((t * 0.15) % 1) * H;
      ctx.fillStyle = 'rgba(255,255,255,.06)';
      ctx.fillRect(0, bandY, W, H * 0.05);
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.min(W, H) * 0.045}px ui-monospace, monospace`;
      ctx.globalAlpha = 0.85;
      ctx.fillText('▶ PLAY', W * 0.05, H * 0.1);
      ctx.restore();
      break;
    }
    case 'grain': {
      ctx.save();
      ctx.globalAlpha = 0.14 * k;
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillStyle = ctx.createPattern(grain(), 'repeat');
      ctx.translate(Math.random() * 256, Math.random() * 256);
      ctx.fillRect(-256, -256, W + 512, H + 512);
      ctx.restore();
      break;
    }
    case 'bwfx':
      if ('filter' in ctx) {
        ctx.save(); ctx.filter = `grayscale(${k})`; ctx.drawImage(canvas, 0, 0); ctx.restore();
      }
      break;
    case 'blurfx':
      if ('filter' in ctx) {
        ctx.save(); ctx.filter = `blur(${(Math.min(W, H) / 120 * k).toFixed(1)}px)`; ctx.drawImage(canvas, 0, 0); ctx.restore();
      }
      break;
    case 'letterbox': {
      const bar = H * 0.11 * Math.min(1, t / 0.4) * (0.5 + 0.5 * k);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, bar);
      ctx.fillRect(0, H - bar, W, bar);
      break;
    }
    case 'vignettefx': drawVignette(ctx, 0.7 * k, W, H); break;
    case 'snow': case 'rain': case 'hearts': case 'sparkles': case 'confetti': case 'bubbles': case 'lanterns':
      particles(ctx, fx, t, k, W, H);
      break;
  }
}

// ---------------------------------------------------------------- transitions
// Stored on the incoming video clip: clip.trans = { type, dur }. The first
// half plays over the end of the previous clip, the second over the start of
// this one, so no two videos have to be decoded at once.
export const TRANSITIONS = [
  { id: 'fade', name: 'ຈາງຜ່ານສີດຳ' },
  { id: 'flash', name: 'ແຟຣດຂາວ' },
  { id: 'zoomin', name: 'ຊູມເຂົ້າ' },
  { id: 'zoomout', name: 'ຊູມອອກ' },
  { id: 'slideleft', name: 'ເລື່ອນຊ້າຍ' },
  { id: 'slideright', name: 'ເລື່ອນຂວາ' },
  { id: 'slideup', name: 'ເລື່ອນຂຶ້ນ' },
  { id: 'wipe', name: 'ປາດ' },
  { id: 'iris', name: 'ວົງມົນ' },
  { id: 'blur', name: 'ມົວ' },
  { id: 'spin', name: 'ໝູນ' },
  { id: 'glitch', name: 'ກລິດ' },
  { id: 'shake', name: 'ສັ່ນ' }
];

// q runs 0 → 1 approaching the cut from the outgoing side ("out") and 1 → 0
// leaving it on the incoming side ("in"); 1 means right at the cut.
export function transitionState(type, q, side, W, H) {
  const s = { scale: 1, tx: 0, ty: 0, rot: 0, overlay: null, blur: 0, wipe: 0, iris: 1, glitch: 0 };
  const e = q * q * (3 - 2 * q); // smoothstep
  const dir = side === 'out' ? -1 : 1;
  switch (type) {
    case 'fade': s.overlay = ['#000', e]; break;
    case 'flash': s.overlay = ['#fff', e]; break;
    case 'zoomin': s.scale = side === 'out' ? 1 + e * 0.6 : 1 + e * 0.25; s.overlay = ['#fff', e * 0.25]; break;
    case 'zoomout': s.scale = side === 'out' ? 1 - e * 0.25 : 1 + e * 0.5; break;
    // outgoing clip leaves towards one side, incoming arrives from the other
    case 'slideleft': s.tx = (side === 'out' ? -1 : 1) * e * W * 0.5; s.overlay = ['#000', e * 0.5]; break;
    case 'slideright': s.tx = (side === 'out' ? 1 : -1) * e * W * 0.5; s.overlay = ['#000', e * 0.5]; break;
    case 'slideup': s.ty = (side === 'out' ? -1 : 1) * e * H * 0.5; s.overlay = ['#000', e * 0.5]; break;
    case 'wipe': s.wipe = side === 'out' ? e : -e; break;
    case 'iris': s.iris = 1 - e; break;
    case 'blur': s.blur = e * Math.min(W, H) / 30; break;
    case 'spin': s.rot = dir * e * Math.PI * 0.5; s.scale = 1 + e * 0.4; s.overlay = ['#000', e * 0.4]; break;
    case 'glitch': s.glitch = e; break;
    case 'shake': s.tx = Math.sin(q * 60) * e * W * 0.03; s.ty = Math.cos(q * 47) * e * H * 0.03; s.scale = 1 + e * 0.08; break;
  }
  return s;
}

// ---------------------------------------------------------------- stickers
export const EMOJI = {
  ໜ້າ: '😀 😂 🤣 😊 😍 🥰 😘 😎 🤩 🥳 😮 😱 🤔 😴 😭 😤 😡 🤯 🥺 😇 🤗 🙄 😏 🤭'.split(' '),
  ມື: '👍 👎 👏 🙏 👌 ✌️ 🤟 💪 👉 👈 👆 👇 ✋ 🤝 🫶 🤙'.split(' '),
  ຫົວໃຈ: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💖 💯 ✨ ⭐ 🌟 🔥 💥 💫 ✅ ❌ ❓ ❗ 💡 🎯 🔔 📍'.split(' '),
  ອາຫານ: '🍚 🍜 🍲 🥗 🍗 🌶️ 🥭 🍌 🥥 🍍 🍉 🍺 🧋 ☕ 🍦 🎂'.split(' '),
  ທ່ຽວ: '🏯 🛕 ⛰️ 🌄 🌅 🏞️ 🌊 🚣 🛵 🚌 ✈️ 🎒 📸 🗺️ 🌴 🐘'.split(' '),
  ງານບຸນ: '🎉 🎊 🎁 🎈 🏮 🪔 🎆 🎇 🥁 🎵 🎶 🎤 🏆 🥇 💰 🛍️'.split(' ')
};

// Drawn stickers use the page's Lao web fonts (SVG images couldn't load them).
export const BADGES = [
  { id: 'subscribe', name: 'ກົດຕິດຕາມ' },
  { id: 'like', name: 'ກົດໄລກ໌' },
  { id: 'new', name: 'ໃໝ່!' },
  { id: 'sale', name: 'ລົດລາຄາ' },
  { id: 'hot', name: 'ຂາຍດີ' },
  { id: 'sabaidee', name: 'ສະບາຍດີ' },
  { id: 'thanks', name: 'ຂອບໃຈ' },
  { id: 'wow', name: 'ວ້າວ!' },
  { id: 'live', name: 'LIVE' },
  { id: 'arrow', name: 'ລູກສອນ' },
  { id: 'circle', name: 'ວົງເນັ້ນ' },
  { id: 'price', name: 'ປ້າຍລາຄາ' },
  { id: 'question', name: 'ຄຳຖາມ' },
  { id: 'location', name: 'ສະຖານທີ່' },
  { id: 'free', name: 'ຟຣີ' },
  { id: 'order', name: 'ສັ່ງເລີຍ' }
];

function pill(ctx, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(-w / 2 + r, -h / 2);
  ctx.arcTo(w / 2, -h / 2, w / 2, h / 2, r);
  ctx.arcTo(w / 2, h / 2, -w / 2, h / 2, r);
  ctx.arcTo(-w / 2, h / 2, -w / 2, -h / 2, r);
  ctx.arcTo(-w / 2, -h / 2, w / 2, -h / 2, r);
  ctx.closePath();
}

function burst(ctx, r, points = 14) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2;
    const rr = i % 2 ? r * 0.78 : r;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
}

function label(ctx, text, size, color = '#fff', weight = 700) {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px "Noto Sans Lao", "Noto Sans Thai", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, size * 0.04);
}

// Draws a badge centred on (0,0) inside a box of width `s`. Returns its height.
export function drawBadge(ctx, id, s) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = s * 0.04;
  ctx.shadowOffsetY = s * 0.02;
  let h = s * 0.32;
  switch (id) {
    case 'subscribe':
      ctx.fillStyle = '#e5242b'; pill(ctx, s, h, h / 2); ctx.fill(); ctx.shadowColor = 'transparent';
      label(ctx, '🔔 ກົດຕິດຕາມ', h * 0.42);
      break;
    case 'like':
      ctx.fillStyle = '#1877f2'; pill(ctx, s * 0.8, h, h / 2); ctx.fill(); ctx.shadowColor = 'transparent';
      label(ctx, '👍 ກົດໄລກ໌', h * 0.42);
      break;
    case 'order':
      ctx.fillStyle = '#16a34a'; pill(ctx, s * 0.85, h, h / 2); ctx.fill(); ctx.shadowColor = 'transparent';
      label(ctx, '🛒 ສັ່ງເລີຍ', h * 0.42);
      break;
    case 'new':
      h = s * 0.8; ctx.fillStyle = '#ffd60a'; burst(ctx, s * 0.4); ctx.fill(); ctx.shadowColor = 'transparent';
      label(ctx, 'ໃໝ່!', s * 0.2, '#b42318');
      break;
    case 'sale':
      h = s * 0.8; ctx.fillStyle = '#e5242b'; burst(ctx, s * 0.4, 18); ctx.fill(); ctx.shadowColor = 'transparent';
      label(ctx, 'ລົດ', s * 0.13); ctx.translate(0, s * 0.14); label(ctx, '50%', s * 0.13, '#ffd60a');
      break;
    case 'free':
      h = s * 0.8; ctx.fillStyle = '#7c3aed'; burst(ctx, s * 0.4, 16); ctx.fill(); ctx.shadowColor = 'transparent';
      label(ctx, 'ຟຣີ!', s * 0.2);
      break;
    case 'hot':
      ctx.fillStyle = '#ff5a1f'; pill(ctx, s * 0.75, h, h * 0.25); ctx.fill(); ctx.shadowColor = 'transparent';
      label(ctx, '🔥 ຂາຍດີ', h * 0.44);
      break;
    case 'sabaidee':
    case 'thanks': {
      const text = id === 'sabaidee' ? 'ສະບາຍດີ' : 'ຂອບໃຈ';
      ctx.fillStyle = '#e8b54d';
      ctx.beginPath();
      ctx.moveTo(-s / 2, -h / 2); ctx.lineTo(s / 2, -h / 2); ctx.lineTo(s / 2 - h * 0.3, 0); ctx.lineTo(s / 2, h / 2);
      ctx.lineTo(-s / 2, h / 2); ctx.lineTo(-s / 2 + h * 0.3, 0); ctx.closePath(); ctx.fill();
      ctx.shadowColor = 'transparent';
      label(ctx, `🙏 ${text}`, h * 0.44, '#2a1a00');
      break;
    }
    case 'wow':
      h = s * 0.7; ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.ellipse(0, -s * 0.04, s * 0.45, s * 0.28, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-s * 0.15, s * 0.18); ctx.lineTo(-s * 0.3, s * 0.34); ctx.lineTo(0, s * 0.2); ctx.fill();
      ctx.shadowColor = 'transparent'; ctx.translate(0, -s * 0.04);
      label(ctx, 'ວ້າວ!', s * 0.18, '#111');
      break;
    case 'question':
      h = s * 0.7; ctx.fillStyle = '#4cc9f0';
      ctx.beginPath(); ctx.ellipse(0, -s * 0.04, s * 0.42, s * 0.26, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(s * 0.12, s * 0.17); ctx.lineTo(s * 0.3, s * 0.33); ctx.lineTo(-s * 0.02, s * 0.2); ctx.fill();
      ctx.shadowColor = 'transparent'; ctx.translate(0, -s * 0.04);
      label(ctx, 'ແມ່ນຫຍັງ?', s * 0.12, '#0b2540');
      break;
    case 'live':
      ctx.fillStyle = '#e5242b'; pill(ctx, s * 0.55, h * 0.8, h * 0.12); ctx.fill(); ctx.shadowColor = 'transparent';
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(-s * 0.17, 0, h * 0.1, 0, Math.PI * 2); ctx.fill();
      ctx.translate(s * 0.04, 0); label(ctx, 'LIVE', h * 0.4);
      break;
    case 'price':
      ctx.fillStyle = '#ffd60a';
      ctx.beginPath(); ctx.moveTo(-s * 0.45, -h / 2); ctx.lineTo(s * 0.3, -h / 2); ctx.lineTo(s * 0.45, 0); ctx.lineTo(s * 0.3, h / 2); ctx.lineTo(-s * 0.45, h / 2); ctx.closePath(); ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(s * 0.3, 0, h * 0.09, 0, Math.PI * 2); ctx.fill();
      ctx.translate(-s * 0.06, 0); label(ctx, '99,000 ₭', h * 0.38, '#111');
      break;
    case 'location':
      ctx.fillStyle = 'rgba(17,21,31,.85)'; pill(ctx, s, h, h / 2); ctx.fill(); ctx.shadowColor = 'transparent';
      label(ctx, '📍 ນະຄອນຫຼວງວຽງຈັນ', h * 0.36);
      break;
    case 'arrow':
      h = s * 0.5; ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = s * 0.06; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(-s * 0.4, s * 0.15); ctx.quadraticCurveTo(-s * 0.05, -s * 0.25, s * 0.35, -s * 0.05); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s * 0.2, -s * 0.18); ctx.lineTo(s * 0.37, -s * 0.05); ctx.lineTo(s * 0.2, s * 0.08); ctx.stroke();
      break;
    case 'circle':
      h = s * 0.7; ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = s * 0.035;
      ctx.beginPath(); ctx.ellipse(0, 0, s * 0.45, s * 0.32, -0.1, 0.2, Math.PI * 2.05); ctx.stroke();
      break;
  }
  ctx.restore();
  return h;
}

// A small generated "landscape" (sky, mountains, river, sun) for filter thumbnails.
let sampleCanvas = null;
export function sampleScene() {
  if (sampleCanvas) return sampleCanvas;
  const c = document.createElement('canvas');
  c.width = 160; c.height = 100;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 70);
  sky.addColorStop(0, '#5aa9e6'); sky.addColorStop(1, '#ffd29d');
  g.fillStyle = sky; g.fillRect(0, 0, 160, 100);
  g.fillStyle = '#ffe08a'; g.beginPath(); g.arc(118, 38, 13, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#2f6b4f'; g.beginPath(); g.moveTo(0, 70); g.lineTo(40, 34); g.lineTo(75, 66); g.lineTo(110, 40); g.lineTo(160, 72); g.lineTo(160, 100); g.lineTo(0, 100); g.fill();
  g.fillStyle = '#d98c3a'; g.beginPath(); g.moveTo(66, 70); g.lineTo(74, 50); g.lineTo(82, 70); g.fill();
  g.fillStyle = '#3a7bbf'; g.fillRect(0, 80, 160, 20);
  g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(20, 86, 40, 2); g.fillRect(95, 91, 50, 2);
  g.fillStyle = '#e8b54d'; g.fillRect(70, 50, 8, 20);
  sampleCanvas = c;
  return c;
}

export function filterThumb(filter) {
  const src = sampleScene();
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const g = c.getContext('2d');
  const look = clipLook({ filter: { id: filter.id, amount: 1 } });
  if ('filter' in g) g.filter = look.filter;
  g.drawImage(src, 0, 0);
  g.filter = 'none';
  drawTints(g, look.tints, c.width, c.height);
  drawVignette(g, look.vignette, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

export function badgeThumb(id) {
  const c = document.createElement('canvas');
  c.width = 160; c.height = 110;
  const g = c.getContext('2d');
  g.translate(80, 55);
  drawBadge(g, id, 130);
  return c.toDataURL();
}
