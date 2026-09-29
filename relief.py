#!/usr/bin/env python3
"""relief.py v3 — gambar → heightmap CNC (otomatis). Cermin engine.js v3.
Pemakaian:
    python relief.py masukan.png
    python relief.py masukan.png -o hasil.png --max-dim 2048 --invert
Butuh:  pip install pillow numpy scipy
"""
import argparse
import numpy as np
from PIL import Image
from scipy import ndimage

# ── KONSTANTA (cermin CFG di engine.js v3 — ubah berpasangan) ──
PAD_FRAC   = 0.07
RAMP_FRAC  = 0.03
DOME_FRAC  = 0.38
BULGE_MIN  = 0.80
CENTER     = 0.50     # slab abu-abu interior
SCULPT_AMP = 0.30     # amplitudo bentuk besar (signed)
DET_AMP    = 0.14     # batas lembut detail (tanh)
G1_T, G1_LO, G1_HI = 0.035, 0.5, 3.5
G2_T, G2_LO, G2_HI = 0.022, 0.4, 4.0
LO_PCT, HI_PCT = 2, 98
SMOOTH_FRAC = 0.0025

def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)

def box(img, r):
    return ndimage.uniform_filter(img, size=2 * r + 1, mode='reflect')

def guided(I, r, eps):
    mI = box(I, r)
    var = np.maximum(box(I * I, r) - mI * mI, 0)
    a = var / (var + eps)
    b = mI - a * mI
    return box(a, r) * I + box(b, r)

def measure_background(rgb):
    b = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]]).astype(np.float32)
    bg = np.median(b, axis=0)
    d2 = ((b - bg) ** 2).sum(axis=1)
    tol2 = np.percentile(d2, 90) * 1.6 + 60
    return bg, float(np.clip(tol2, 400.0, 9025.0))

def load(path, max_dim):
    img = Image.open(path)
    has_alpha = img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info)
    img = (img.convert('RGBA') if has_alpha else img.convert('RGB'))
    w, h = img.size
    sc = min(1.0, max_dim / max(w, h))
    w0, h0 = max(4, round(w * sc)), max(4, round(h * sc))
    img = img.resize((w0, h0), Image.LANCZOS)
    arr = np.asarray(img).astype(np.float32)
    return arr[..., :3], (arr[..., 3] / 255.0 if has_alpha else None)

def segment(rgb0, alpha, bg, tol2):
    h0, w0 = rgb0.shape[:2]
    px, py = round(w0 * PAD_FRAC), round(h0 * PAD_FRAC)
    W, H = w0 + 2 * px, h0 + 2 * py
    gray = rgb0 @ np.array([0.2126, 0.7152, 0.0722], np.float32) / 255.0

    if alpha is not None and (alpha < 0.98).mean() > 0.02:
        mask = np.zeros((H, W), bool)
        mask[py:py + h0, px:px + w0] = alpha >= 0.5
        lum = np.zeros((H, W), np.float32)
        lum[py:py + h0, px:px + w0] = gray * alpha
        return mask, lum

    canvas = np.full((H, W, 3), bg, np.float32)
    canvas[py:py + h0, px:px + w0] = rgb0
    d2 = ((canvas - bg) ** 2).sum(-1)
    near = d2 <= tol2
    lbl, _ = ndimage.label(near)
    border = np.concatenate([lbl[0], lbl[-1], lbl[:, 0], lbl[:, -1]])
    bset = np.unique(border); bset = bset[bset != 0]
    mask = ndimage.binary_closing(~np.isin(lbl, bset), np.ones((3, 3), bool))
    lum = canvas @ np.array([0.2126, 0.7152, 0.0722], np.float32) / 255.0
    return mask, lum

def build(mask, lum):
    """v3: slab terpusat + modulasi bertanda + soft-clip tanh."""
    H, W = lum.shape
    mind = min(W, H)
    cover = mask.mean()
    full = cover < 0.02 or cover > 0.99
    if full:
        mask = np.ones_like(mask)

    dist = ndimage.distance_transform_edt(mask) if not full else np.full_like(lum, mind)
    dmax = max(dist.max(), 1.0)

    R1 = max(4, round(0.018 * mind)); R2 = max(2, round(0.004 * mind))
    base = guided(lum, R1, 0.04)
    mid  = guided(lum, R2, 0.02)
    micro, fine = mid - base, lum - mid

    # auto-level BERTANDA: persentil 2–98 → -1..+1 (dipusatkan, anti-blowout)
    vals = base[mask]
    lo, hi = np.percentile(vals, [LO_PCT, HI_PCT])
    rng = max(hi - lo, 8 / 255)
    v = np.clip((base - lo) / rng, 0, 1)
    base = np.where(mask, v * 2 - 1, 0.5).astype(np.float32)

    # auto-gain dari RMS
    rms = lambda a: float(np.sqrt((a[mask] ** 2).mean())) if mask.any() else 0.0
    g1 = float(np.clip(G1_T / max(rms(micro), 1e-4), G1_LO, G1_HI))
    g2 = float(np.clip(G2_T / max(rms(fine), 1e-4), G2_LO, G2_HI))

    # merge: x = CENTER + SCULPT·base + DET_AMP·tanh(det/DET_AMP)
    rw = float(np.clip(mind * RAMP_FRAC, 24, 140))
    rise = np.ones_like(lum) if full else smoothstep(dist / rw)
    bul = np.ones_like(lum) if full else BULGE_MIN + (1 - BULGE_MIN) * smoothstep(dist / (DOME_FRAC * dmax))
    det = g1 * micro + g2 * fine
    x = CENTER + SCULPT_AMP * base + DET_AMP * np.tanh(det / DET_AMP)
    h = np.clip(rise * bul * x, 0, 1)

    r = max(1, round(mind * SMOOTH_FRAC))
    h = np.clip(box(h, r), 0, 1)
    h[~mask] = 0
    stats = dict(mode='FULL-FRAME' if full else 'SUBJEK', cover=cover, g1=g1, g2=g2, rw=round(rw))
    return h, stats

def main():
    ap = argparse.ArgumentParser(description='Gambar → heightmap CNC (otomatis)')
    ap.add_argument('input')
    ap.add_argument('-o', '--output', default=None)
    ap.add_argument('--max-dim', type=int, default=2048)
    ap.add_argument('--invert', action='store_true')
    a = ap.parse_args()
    out = a.output or f'heightmap-16bit-{a.input.rsplit(".",1)[0]}.png'

    rgb0, alpha = load(a.input, a.max_dim)
    bg, tol2 = measure_background(rgb0)
    mask, lum = segment(rgb0, alpha, bg, tol2)
    h, st = build(mask, lum)
    if a.invert:
        h = np.where(mask, 1 - h, 0)

    out16 = np.clip(h * 65535 + 0.5, 0, 65535).astype(np.uint16)
    try:
        Image.fromarray(out16, mode='I;16').save(out)
    except Exception:
        Image.fromarray((h * 255).astype(np.uint8)).save(out)
        print('Catatan: PIL gagal menyimpan 16-bit → tersimpan 8-bit.')
    print(f"OK {out} · mode={st['mode']} · subjek={st['cover']*100:.0f}% · "
          f"gain={st['g1']:.2f}/{st['g2']:.2f} · rambat={st['rw']}px")

if __name__ == '__main__':
    main()
