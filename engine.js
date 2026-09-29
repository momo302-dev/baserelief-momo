/* ═══════════════════════════════════════════════════════════════
   engine.js v5 — karakter sculptok: smoothed-grayscale relief.
   Pipeline sengaja MINIMAL:
     sinyal → halus kuat (clay) → normalisasi persentil →
     emergence ramp → blur akhir.
   Tidak ada kubah / auto-gain / tanh — dibuang karena menjadi
   sumber kegagalan versi sebelumnya.
   ═══════════════════════════════════════════════════════════════ */
export const CFG = {
  MAX_DIM: 1600,
  PAD: 0.07,
  W_LUM: 0.75,          // bobot luminance
  W_CHROMA: 0.25,       // bobot chroma (angkat elemen berwarna; 0 utk foto)
  R_FORM: 0.022,        // radius halus BESAR = kekuatan "clay" (slider smooth sculptok)
  R_MID: 0.0045,        // radius sedang → definisi bentuk antara
  MID_GAIN: 0.35,       // porsi definisi sedang (0 = full clay, 1 = lebih tajam)
  LO_PCT: 1.0,          // persentil gelap subjek → lantai
  HI_PCT: 99.2,         // persentil terang subjek → puncak
  OUT_LO: 0.08,         // nilai lembah interior (jangan 0 → tetap terbaca)
  OUT_HI: 0.97,         // nilai puncak (jangan 1 → tanpa plateau putih)
  RAMP_FRAC: 0.025,     // lebar emergence = 2.5% sisi terpendek
  RAMP_MIN: 16, RAMP_MAX: 64,
  FINAL_BLUR: 0.004,    // blur akhir: bahu siluet membulat
};

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const ss = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);

/* ── box blur separable, O(n) ── */
export function boxBlurH(src, dst, W, H, r) {
  const inv = 1 / (2 * r + 1), last = W - 1;
  for (let y = 0; y < H; y++) {
    const row = y * W; let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + (x < 0 ? 0 : x > last ? last : x)];
    for (let x = 0; x < W; x++) {
      dst[row + x] = sum * inv;
      const xa = x + r + 1, xd = x - r;
      sum += src[row + (xa > last ? last : xa)] - src[row + (xd < 0 ? 0 : xd)];
    }
  }
}
export function boxBlurV(src, dst, W, H, r) {
  const inv = 1 / (2 * r + 1), last = H - 1;
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += src[(y < 0 ? 0 : y > last ? last : y) * W + x];
    for (let y = 0; y < H; y++) {
      dst[y * W + x] = sum * inv;
      const ya = y + r + 1, yd = y - r;
      sum += src[(ya > last ? last : ya) * W + x] - src[(yd < 0 ? 0 : yd) * W + x];
    }
  }
}
export function blur(src, dst, tmp, W, H, r) {
  boxBlurH(src, tmp, W, H, r); boxBlurV(tmp, dst, W, H, r);
}

/* ── guided filter self-guided (halus kuat, tepi terjaga) ── */
export function guidedSelf(src, W, H, R, eps, out) {
  const n = W * H;
  const mI = new Float32Array(n), a = new Float32Array(n), b = new Float32Array(n);
  const ma = new Float32Array(n), mb = new Float32Array(n), tmp = new Float32Array(n);
  blur(src, mI, tmp, W, H, R);
  for (let i = 0; i < n; i++) { const d = src[i] - mI[i]; a[i] = d * d; }
  blur(a, b, tmp, W, H, R);
  for (let i = 0; i < n; i++) { const v = b[i]; a[i] = v / (v + eps); }
  for (let i = 0; i < n; i++) b[i] = mI[i] * (1 - a[i]);
  blur(a, ma, tmp, W, H, R); blur(b, mb, tmp, W, H, R);
  for (let i = 0; i < n; i++) out[i] = ma[i] * src[i] + mb[i];
}

/* ── exact euclidean distance transform (Felzenszwalb) ── */
function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -1e12; z[1] = 1e12;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = 1e12;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k]; d[q] = dq * dq + f[v[k]];
  }
}
export function edt(mask, W, H, out) {
  const m = Math.max(W, H);
  const f = new Float64Array(m), d = new Float64Array(m);
  const v = new Int32Array(m), z = new Float64Array(m + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = mask[y * W + x] ? 1e12 : 0;
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) out[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) f[x] = out[row + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) out[row + x] = Math.sqrt(d[x]);
  }
}

/* ── ukur warna & toleransi latar dari tepi gambar ASLI ── */
export function measureBackground(data, w, h) {
  const nb = 2 * (w + h);
  const R = new Float32Array(nb), G = new Float32Array(nb), B = new Float32Array(nb);
  let q = 0;
  const take = i => { R[q] = data[i]; G[q] = data[i + 1]; B[q] = data[i + 2]; q++; };
  for (let x = 0; x < w; x++) { take(x * 4); take(((h - 1) * w + x) * 4); }
  for (let y = 1; y < h - 1; y++) { take(y * w * 4); take((y * w + w - 1) * 4); }
  const med = a => { const s = Float32Array.from(a).sort(); return s[s.length >> 1]; };
  const bg = [med(R), med(G), med(B)];
  const d2 = new Float32Array(nb);
  for (let i = 0; i < nb; i++) {
    const dr = R[i] - bg[0], dg = G[i] - bg[1], db = B[i] - bg[2];
    d2[i] = dr * dr + dg * dg + db * db;
  }
  const tol2 = Math.min(9025, Math.max(400, Float32Array.from(d2).sort()[Math.floor(nb * 0.9)] * 1.6 + 60));
  return { bg, tol2 };
}

/* ── segmentasi subjek + lum & chroma ── */
export function segment(rgbData, W, H, bg, tol2) {
  const n = W * H;
  const lum = new Float32Array(n);
  const chroma = new Float32Array(n);
  const mask = new Uint8Array(n);
  let transp = 0;
  for (let i = 3; i < n * 4; i += 4) if (rgbData[i] < 250) transp++;
  let mode;
  if (transp > n * 0.02) {
    mode = 'ALPHA';
    for (let i = 0; i < n; i++) {
      const o = i * 4, a = rgbData[o + 3] / 255;
      mask[i] = rgbData[o + 3] >= 128 ? 1 : 0;
      const r = rgbData[o], g = rgbData[o + 1], b = rgbData[o + 2];
      lum[i] = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255 * a;
      chroma[i] = (Math.max(r, g, b) - Math.min(r, g, b)) / 255 * a;
    }
  } else {
    const bgm = new Uint8Array(n), stack = new Int32Array(n); let sp = 0;
    const push = i => {
      if (!bgm[i]) {
        const o = i * 4, dr = rgbData[o] - bg[0], dg = rgbData[o + 1] - bg[1], db = rgbData[o + 2] - bg[2];
        if (dr * dr + dg * dg + db * db <= tol2) { bgm[i] = 1; stack[sp++] = i; }
      }
    };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (sp > 0) {
      const i = stack[--sp], xx = i % W, yy = (i / W) | 0;
      if (xx > 0) push(i - 1); if (xx < W - 1) push(i + 1);
      if (yy > 0) push(i - W); if (yy < H - 1) push(i + W);
    }
    for (let i = 0; i < n; i++) mask[i] = bgm[i] ? 0 : 1;
    mode = 'LATAR-OTOMATIS';
    for (let i = 0; i < n; i++) {
      const o = i * 4, r = rgbData[o], g = rgbData[o + 1], b = rgbData[o + 2];
      lum[i] = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
      chroma[i] = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    }
  }
  { /* close 1 px */
    const t1 = new Float32Array(n), t2 = new Float32Array(n);
    for (let i = 0; i < n; i++) t1[i] = mask[i];
    blur(t1, t2, t1, W, H, 1);
    for (let i = 0; i < n; i++) mask[i] = t2[i] > 0.5 ? 1 : 0;
  }
  return { mask, lum, chroma, mode };
}

/* ═══════════════════════════════════════════════════════════════
   buildHeightmap v5 — minimal & deterministik.
   ═══════════════════════════════════════════════════════════════ */
export function buildHeightmap(mask, lum, chroma, W, H) {
  const n = W * H, mind = Math.min(W, H), C = CFG;

  /* 1 · coverage & fallback */
  let cnt = 0; for (let i = 0; i < n; i++) cnt += mask[i];
  const cover = cnt / n;
  const fullFrame = cover < 0.02 || cover > 0.99;
  if (fullFrame) mask.fill(1);

  /* 2 · distance field (emergence saja — TIDAK ada kubah) */
  const dist = new Float32Array(n);
  if (!fullFrame) edt(mask, W, H, dist);
  else dist.fill(mind);

  /* 3 · sinyal gabungan lum+chroma */
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++)
    src[i] = mask[i] ? C.W_LUM * lum[i] + C.W_CHROMA * chroma[i] : 0;

  /* 4 · dua skala guided: clay besar + definisi antara */
  const form = new Float32Array(n), mid = new Float32Array(n);
  guidedSelf(src, W, H, Math.max(3, Math.round(C.R_FORM * mind)), 0.03, form);
  guidedSelf(src, W, H, Math.max(2, Math.round(C.R_MID * mind)), 0.015, mid);
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) sig[i] = form[i] + C.MID_GAIN * (mid[i] - form[i]);

  /* 5 · normalisasi persentil dalam subjek → jendela OUT_LO..OUT_HI */
  const hist = new Uint32Array(256); let m2 = 0;
  for (let i = 0; i < n; i++) if (mask[i]) { hist[Math.min(255, (sig[i] * 255) | 0)]++; m2++; }
  if (!m2) m2 = n;
  let acc = 0, lo = 0, hi = 255;
  for (let b = 0; b < 256; b++) { acc += hist[b]; if (acc >= m2 * C.LO_PCT / 100) { lo = b; break; } }
  acc = 0;
  for (let b = 255; b >= 0; b--) { acc += hist[b]; if (acc >= m2 * C.HI_PCT / 100) { hi = b; break; } }
  const rng = Math.max(10, hi - lo) / 255;

  const val = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) { val[i] = 0; continue; }
    let v = (sig[i] - lo / 255) / rng;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    val[i] = C.OUT_LO + (C.OUT_HI - C.OUT_LO) * v;
  }

  /* 6 · emergence ramp */
  const rw = clamp(mind * C.RAMP_FRAC, C.RAMP_MIN, C.RAMP_MAX);
  const h = new Float32Array(n);
  if (fullFrame) h.set(val);
  else for (let i = 0; i < n; i++) h[i] = ss(dist[i] / rw) * val[i];

  /* 7 · blur akhir — bahu siluet membulat ke hitam */
  {
    const r = Math.max(1, Math.round(mind * C.FINAL_BLUR));
    const t = new Float32Array(n), tmp = new Float32Array(n);
    blur(h, t, tmp, W, H, r);
    for (let i = 0; i < n; i++) h[i] = clamp(t[i], 0, 1);
  }

  return {
    h,
    stats: { mode: fullFrame ? 'FULL-FRAME' : 'SUBJEK', cover, g: C.MID_GAIN, rw: Math.round(rw) },
  };
}
