/* ═══════════════════════════════════════════════════════════════
   app.js — perekat DOM: muat gambar → panggil engine → render → unduh.
   TIDAK ADA logika heightmap di sini. Perbaiki rumus di engine.js.

   v2 (perbaikan duplikasi):
   · measureBackground() dipanggil TEPAT SEKALI di loadImage(), sebelum padding
   · hasilnya disimpan di S._bg / S._tol2
   · process() memanggil segment() TEPAT SEKALI memakai data itu
   ═══════════════════════════════════════════════════════════════ */
import { CFG, measureBackground, segment, buildHeightmap } from './engine.js';

const $ = s => document.querySelector(s);
const els = {
  frame: $('#frame'), empty: $('#empty'), out: $('#out'), chip: $('#chip'),
  meta: $('#meta'), fileInput: $('#fileInput'), dl16: $('#dl16'), dl8: $('#dl8'),
};

const S = {
  loaded: false,
  W: 0, H: 0, n: 0,
  name: 'gambar', srcW: 0, srcH: 0,
  rgbData: null,           // piksel gambar TER-PAD (RGBA)
  _bg: null, _tol2: 0,     // hasil ukur latar (dari gambar asli, pra-pad)
  g16: null,               // buffer keluaran 16-bit
};

function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 320);
  }, 4200);
}
const chip = t => { els.chip.textContent = t; };

/* ── 1 · muat gambar ──────────────────────────────────────────── */
async function loadImage(blob, name) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch (e) { toast('Gagal membaca gambar', true); return; }

  const sc = Math.min(1, CFG.MAX_DIM / Math.max(bmp.width, bmp.height));
  const w0 = Math.max(4, Math.round(bmp.width * sc));
  const h0 = Math.max(4, Math.round(bmp.height * sc));

  /* 1a · gambar asli terskala — sumber pengukuran latar */
  const c0 = document.createElement('canvas');
  c0.width = w0; c0.height = h0;
  const x0 = c0.getContext('2d', { willReadFrequently: true });
  x0.drawImage(bmp, 0, 0, w0, h0);
  const d0 = x0.getImageData(0, 0, w0, h0).data;

  /* 1b · ukur warna & toleransi latar SEKALI — sebelum padding */
  const { bg, tol2 } = measureBackground(d0, w0, h0);
  S._bg = bg;
  S._tol2 = tol2;

  /* 1c · pad dengan warna latar itu → flood-fill selalu punya seed */
  const px = Math.round(w0 * CFG.PAD), py = Math.round(h0 * CFG.PAD);
  const W = w0 + px * 2, H = h0 + py * 2;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = `rgb(${bg[0] | 0},${bg[1] | 0},${bg[2] | 0})`;
  x.fillRect(0, 0, W, H);
  x.drawImage(bmp, px, py, w0, h0);

  S.rgbData = x.getImageData(0, 0, W, H).data;
  S.W = W; S.H = H; S.n = W * H;
  S.name = (name || 'gambar').replace(/\.[^.]+$/, '');
  S.srcW = bmp.width; S.srcH = bmp.height;
  bmp.close && bmp.close();

  S.loaded = true;
  els.out.style.display = 'block';
  els.empty.style.display = 'none';
  els.dl16.disabled = els.dl8.disabled = false;
  chip('MENGHITUNG…');
  setTimeout(process, 30);
}

/* ── 2 · pipeline — segmentasi TEPAT SEKALI ───────────────────── */
function process() {
  const t0 = performance.now();

  const seg = segment(S.rgbData, S.W, S.H, S._bg, S._tol2);
  const { h, stats } = buildHeightmap(seg.mask, seg.lum, S.W, S.H);

  /* render preview 8-bit + simpan buffer 16-bit */
  S.g16 = new Uint16Array(S.n);
  els.out.width = S.W; els.out.height = S.H;
  const ctx = els.out.getContext('2d');
  const img = ctx.createImageData(S.W, S.H), px = img.data;
  for (let i = 0; i < S.n; i++) {
    const v = h[i], o = i * 4, g = (v * 255.999) | 0;
    S.g16[i] = (v * 65535 + 0.5) | 0;
    px[o] = px[o + 1] = px[o + 2] = g;
    px[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  chip('SIAP');
  els.meta.innerHTML =
    `<b>${S.srcW}×${S.srcH}</b> → <b>${S.W}×${S.H}</b> PX · ` +
    `MODE <b>${seg.mode}</b>${stats.mode === 'FULL-FRAME' ? ' · <b>FALLBACK PENUH</b>' : ''} · ` +
    `SUBJEK <b>${Math.round(stats.cover * 100)}%</b> · ` +
    `GAIN <b>${stats.g1.toFixed(1)}/${stats.g2.toFixed(1)}</b> · ` +
    `RAMBAT <b>${stats.rw} PX</b> · ` +
    `<b>${Math.round(performance.now() - t0)} MS</b>`;
}

/* ── 3 · encoder PNG 16-bit grayscale (tanpa library) ─────────── */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(b, s, l) {
  let c = 0xFFFFFFFF;
  for (let i = s; i < s + l; i++) c = crcTable[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function adler32(b) {
  let a = 1, s = 0;
  for (let i = 0; i < b.length; i++) { a = (a + b[i]) % 65521; s = (s + a) % 65521; }
  return ((s << 16) | a) >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 4 + data.length));
  return out;
}
function png16(gray, W, H) {
  const raw = new Uint8Array(H * (1 + W * 2));
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0;
    for (let x = 0; x < W; x++) {
      const v = gray[y * W + x];
      raw[p++] = v >> 8; raw[p++] = v & 255;
    }
  }
  const nB = Math.ceil(raw.length / 65535);
  const z = new Uint8Array(2 + raw.length + nB * 5 + 4);
  z[0] = 0x78; z[1] = 0x01;
  let q = 2, off = 0;
  while (off < raw.length) {
    const len = Math.min(65535, raw.length - off);
    const fin = off + len >= raw.length ? 1 : 0;
    z[q++] = fin; z[q++] = len & 255; z[q++] = len >> 8;
    z[q++] = (~len) & 255; z[q++] = ((~len) >> 8) & 255;
    z.set(raw.subarray(off, off + len), q);
    q += len; off += len;
  }
  const ad = adler32(raw);
  z[q++] = (ad >>> 24) & 255; z[q++] = (ad >>> 16) & 255;
  z[q++] = (ad >>> 8) & 255;  z[q++] = ad & 255;

  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W); dv.setUint32(4, H);
  ihdr[8] = 16; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return new Blob(
    [sig, chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))],
    { type: 'image/png' }
  );
}
function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Tersimpan: ' + name);
}

/* ── 4 · unduhan ──────────────────────────────────────────────── */
els.dl16.addEventListener('click', () => {
  if (!S.g16) return;
  save(png16(S.g16, S.W, S.H), `heightmap-16bit-${S.name}.png`);
});
els.dl8.addEventListener('click', () => {
  if (!S.loaded) return;
  els.out.toBlob(b => save(b, `heightmap-8bit-${S.name}.png`), 'image/png');
});

/* ── 5 · sumber gambar ────────────────────────────────────────── */
function useFile(f) {
  if (!f || !f.type.startsWith('image/')) { toast('Berkas bukan gambar', true); return; }
  loadImage(f, f.name);
}
els.fileInput.addEventListener('change', e => { useFile(e.target.files[0]); e.target.value = ''; });
els.empty.addEventListener('click', () => els.fileInput.click());
els.out.addEventListener('click', () => els.fileInput.click());
['dragover', 'drop'].forEach(ev => window.addEventListener(ev, e => e.preventDefault()));
els.frame.addEventListener('dragover', () => els.frame.classList.add('hot'));
els.frame.addEventListener('dragleave', () => els.frame.classList.remove('hot'));
els.frame.addEventListener('drop', e => {
  els.frame.classList.remove('hot');
  useFile([...e.dataTransfer.files].find(f => f.type.startsWith('image/')));
});
window.addEventListener('paste', e => {
  const it = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
  if (it) useFile(it.getAsFile());
});
