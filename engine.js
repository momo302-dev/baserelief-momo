/* ═══════════════════════════════════════════════════════════════
   engine.js — inti perhitungan heightmap (MURNI, tanpa DOM).
   Semua angka penyetelan ada di CFG. Ubah di sini, bukan di app.js.
   Pipeline: segmentasi → distance field → guided filter →
             auto-level → auto-gain → merge → halus → stretch.
   ═══════════════════════════════════════════════════════════════ */
export const CFG = {
  MAX_DIM: 1600,        // sisi terpanjang proses (px)
  PAD: 0.07,            // bingkai 7% agar rambat tepi selalu punya ruang
  RAMP_FRAC: 0.03,      // lebar emergence = 3% sisi terpendek (min 24 px, maks 140)
  DOME_FRAC: 0.38,      // kubah mencapai puncak pada 38% jarak-maks
  SLAB: 0.32,           // lantai abu-abu interior (anti "gelap total")
  SCULPT: 0.68,         // porsi sculpt dari auto-level luminance
  BULGE_MIN: 0.72,      // tinggi bahu kubah di dekat tepi
  G1_TARGET: 0.045, G1_MIN: 0.6, G1_MAX: 4.0,   // auto-gain detail sedang
  G2_TARGET: 0.030, G2_MIN: 0.5, G2_MAX: 5.0,   // auto-gain detail halus
  LO_PCT: 1, HI_PCT: 99,                        // persentil auto-level dasar
  SMOOTH_FRAC: 0.003,   // radius smoothing akhir = 0.3% sisi terpendek
  TOP_PCT: 99.6,        // persentil puncak → dipetakan ke putih penuh
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

/* ── guided filter self-guided (edge-preserving → look "dipahat") ── */
export function guidedSelf(src, W, H, R, eps, out) {
  const n = W * H;
  const mI = new Float32Array(n), a = new Float32Array(n), b = new Float32Array(n);
  const ma = new Float32Array(n), mb = new Float32Array(n), tmp = new Float32Array(n);
  blur(src, mI, tmp, W, H, R);                       // mean(I)
  for (let i = 0; i < n; i++) { const d = src[i] - mI[i]; a[i] = d * d; }
  blur(a, b, tmp, W, H, R);                          // var(I)
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

/* ── ukur warna & toleransi latar dari tepi gambar ASLI (sebelum pad) ── */
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

/* ── segmentasi subjek: alpha, atau flood-fill jarak warna dari tepi ── */
export function segment(rgbData, W, H, bg, tol2) {
  const n = W * H;
  const lum = new Float32Array(n);
  const mask = new Uint8Array(n);
  let transp = 0;
  for (let i = 3; i < n * 4; i += 4) if (rgbData[i] < 250) transp++;
  let mode;
  if (transp > n * 0.02) {
    mode = 'ALPHA';
    for (let i = 0; i < n; i++) {
      const o = i * 4, a = rgbData[o + 3];
      mask[i] = a >= 128 ? 1 : 0;
      lum[i] = (rgbData[o] * 0.2126 + rgbData[o + 1] * 0.7152 + rgbData[o + 2] * 0.0722) / 255 * (a / 255);
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
      const o = i * 4;
      lum[i] = (rgbData[o] * 0.2126 + rgbData[o + 1] * 0.7152 + rgbData[o + 2] * 0.0722) / 255;
    }
  }
  /* rapikan tepi mask: close 1 px */
  {
    const t1 = new Float32Array(n), t2 = new Float32Array(n);
    for (let i = 0; i < n; i++) t1[i] = mask[i];
    blur(t1, t2, t1, W, H, 1);
    for (let i = 0; i < n; i++) mask[i] = t2[i] > 0.5 ? 1 : 0;
  }
  return { mask, lum, mode };
}

/* ── bangun heightmap (otomatis penuh) — mengembalikan h 0..1 ── */
export function buildHeightmap(mask, lum, W, H) {
  const n = W * H, mind = Math.min(W, H), C = CFG;

  /* 1 · coverage & fallback full-frame */
  let cnt = 0; for (let i = 0; i < n; i++) cnt += mask[i];
  const cover = cnt / n;
  const fullFrame = cover < 0.02 || cover > 0.99;
  if (fullFrame) mask.fill(1);

  /* 2 · distance field: emergence + kubah */
  const dist = new Float32Array(n);
  let dmax = 1;
  if (!fullFrame) {
    edt(mask, W, H, dist);
    for (let i = 0; i < n; i++) if (dist[i] > dmax) dmax = dist[i];
  } else dist.fill(mind);

  /* 3 · guided filter: dasar (sculpt) + sedang → band detail */
  const base = new Float32Array(n), mid = new Float32Array(n);
  guidedSelf(lum, W, H, Math.max(6, Math.round(0.022 * mind)), 0.05, base);
  guidedSelf(lum, W, H, Math.max(2, Math.round(0.005 * mind)), 0.02, mid);
  const micro = new Float32Array(n), fine = new Float32Array(n);
  for (let i = 0; i < n; i++) { micro[i] = mid[i] - base[i]; fine[i] = lum[i] - mid[i]; }

  /* 4 · auto-level dasar di dalam subjek → kurva kosinus (anti hard-clip) */
  {
    const hist = new Uint32Array(256); let m2 = 0;
    for (let i = 0; i < n; i++) if (mask[i]) { hist[Math.min(255, (base[i] * 255) | 0)]++; m2++; }
    if (!m2) m2 = n;
    let acc = 0, lo = 0, hi = 255;
    for (let b = 0; b < 256; b++) { acc += hist[b]; if (acc >= m2 * C.LO_PCT / 100) { lo = b; break; } }
    acc = 0;
    for (let b = 255; b >= 0; b--) { acc += hist[b]; if (acc >= m2 * C.HI_PCT / 100) { hi = b; break; } }
    const rng = Math.max(8, hi - lo) / 255;
    for (let i = 0; i < n; i++) {
      let v = mask[i] ? (base[i] - lo / 255) / rng : 0;
      v = clamp(v, 0, 1);
      base[i] = 0.5 - 0.5 * Math.cos(Math.PI * v);
    }
  }

  /* 5 · auto-gain detail dari RMS (pengganti slider DETAIL) */
  const rms = arr => {
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) if (mask[i]) { s += arr[i] * arr[i]; c++; }
    return c ? Math.sqrt(s / c) : 0;
  };
  const g1 = clamp(C.G1_TARGET / Math.max(rms(micro), 1e-4), C.G1_MIN, C.G1_MAX);
  const g2 = clamp(C.G2_TARGET / Math.max(rms(fine), 1e-4), C.G2_MIN, C.G2_MAX);

  /* 6 · MERGE — emergence S-curve × kubah × slab+sculpt, + detail ter-gate */
  const h = new Float32Array(n);
  const rw = clamp(mind * C.RAMP_FRAC, 24, 140);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) { h[i] = 0; continue; }
    const d = dist[i];
    const rise = fullFrame ? 1 : ss(d / rw);
    const bul  = fullFrame ? 1 : C.BULGE_MIN + (1 - C.BULGE_MIN) * ss(d / (C.DOME_FRAC * dmax));
    const v = rise * bul * (C.SLAB + C.SCULPT * base[i]) + rise * (g1 * micro[i] + g2 * fine[i]);
    h[i] = clamp(v, 0, 1);
  }

  /* 7 · smoothing akhir ringan */
  {
    const r = Math.max(1, Math.round(mind * C.SMOOTH_FRAC));
    const t = new Float32Array(n);
    blur(h, t, new Float32Array(n), W, H, r);
    for (let i = 0; i < n; i++) h[i] = clamp(t[i], 0, 1);
  }

  /* 8 · peregangan puncak → putih penuh (lantai & latar tidak disentuh) */
  let hiV = 1;
  {
    const hist = new Uint32Array(256); let c2 = 0;
    for (let i = 0; i < n; i++) if (mask[i] && h[i] > 0.02) { hist[Math.min(255, (h[i] * 255) | 0)]++; c2++; }
    if (c2) {
      let acc = 0;
      for (let b = 255; b >= 0; b--) { acc += hist[b]; if (acc >= c2 * (100 - C.TOP_PCT) / 100) { hiV = b / 255; break; } }
      if (hiV < 1) for (let i = 0; i < n; i++) h[i] = clamp(h[i] / hiV, 0, 1);
    }
  }
  return { h, stats: { mode: fullFrame ? 'FULL-FRAME' : 'SUBJEK', cover, g1, g2, rw: Math.round(rw) } };
}
