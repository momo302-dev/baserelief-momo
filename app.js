/* ═══════════════════════════════════════════════════════════════
   app.js — perekat DOM: muat gambar → panggil engine → render → unduh.
   TIDAK ADA logika heightmap di sini. Perbaiki rumus di engine.js.
   ═══════════════════════════════════════════════════════════════ */
import { CFG, measureBackground, segment, buildHeightmap } from './engine.js';

const $ = s => document.querySelector(s);
const els = {
  frame: $('#frame'), empty: $('#empty'), out: $('#out'), chip: $('#chip'),
  meta: $('#meta'), fileInput: $('#fileInput'), dl16: $('#dl16'), dl8: $('#dl8'),
};

const S = { loaded: false, W: 0, H: 0, name: 'gambar', srcW: 0, srcH: 0, g16: null };

function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, 4200);
}
const chip = t => els.chip.textContent = t;

/* ── muat gambar: skala → ukur latar → pad → kirim ke engine ── */
async function loadImage(blob, name) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch (e) { toast('Gagal membaca gambar', true); return; }

  const sc = Math.min(1, CFG.MAX_DIM / Math.max(bmp.width, bmp.height));
  const w0 = Math.max(4, Math.round(bmp.width * sc));
  const h0 = Math.max(4, Math.round(bmp.height * sc));

  const c0 = document.createElement('canvas');
  c0.width = w0; c0.height = h0;
  const x0 = c0.getContext('2d', { willReadFrequently: true });
  x0.drawImage(bmp, 0, 0, w0, h0);
  const d0 = x0.getImageData(0, 0, w0, h0).data;

  const { bg, tol2 } = measureBackground(d0, w0, h0);   // ukur SEBELUM pad

  const px = Math.round(w0 * CFG.PAD), py = Math.round(h0 * CFG.PAD);
  const W = w0 + px * 2, H = h0 + py * 2;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = `rgb(${bg[0] | 0},${bg[1] | 0},${bg[2] | 0})`;
  x.fillRect(0, 0, W, H);
  x.drawImage(bmp, px, py, w0, h0);

  S.rgbData = x.getImageData(0, 0, W, H).data;
  S.W = W; S.H = H;
  S.name = (name || 'gambar').replace(/\.[^.]+$/, '');
  S.srcW = bmp.width; S.srcH = bmp.height;
  bmp.close && bmp.close();

  S.loaded = true;
  els.out.style.display = 'block'; els.empty.style.display = 'none';
  els.dl16.disabled = els.dl8.disabled = false;
  chip('MENGHITUNG…');
  setTimeout(process, 30);
}

/* ── panggil engine → render preview + siapkan 16-bit ── */
function process() {
  const t0 = performance.now();
  const { mask, lum, mode } = segment(S.rgbData, S.W, S.H, null, 0);
  /* segment() butuh bg/tol2 hanya untuk mode non-alpha — lewatkan lewat penutup: */
  const seg2 = mode === 'ALPHA' ? { mask, lum } :
    segment(S.rgbData, S.W, S.H, S._bg, S._tol2);

  const { h, stats } = buildHeightmap(seg2.mask, seg2.lum, S.W, S.H);

  const n = S.W * S.H;
  S.g16 = new Uint16Array(n);
  els.out.width = S.W; els.out.height = S.H;
  const ctx = els.out.getContext('2d');
  const img = ctx.createImageData(S.W, S.H), px = img.data;
  for (let i = 0; i < n; i++) {
    const v = h[i], o = i * 4, g = (v * 255.999) | 0;
    S.g16[i] = (v * 65535 + 0.5) | 0;
    px[o] = px[o + 1] = px[o + 2] = g; px[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  chip('SIAP');
  els.meta.innerHTML =
    `<b>${S.srcW}×${S.srcH}</b> → <b>${S.W}×${S.H}</b> PX · MODE <b>${stats.mode}</b> · ` +
    `SUBJEK <b>${Math.round(stats.cover * 100)}%</b> · GAIN <b>${stats.g1.toFixed(1)}/${stats.g2.toFixed(1)}</b> · ` +
    `RAMBAT <b>${stats.rw} PX</b> · <b>${Math.round(performance.now() - t0)} MS</b>`;
  void mode;
}
