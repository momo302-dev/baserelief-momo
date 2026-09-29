#!/usr/bin/env python3
"""relief.py v5 — gambar → heightmap CNC (karakter sculptok, otomatis).
Butuh:  pip install pillow numpy scipy
Pemakaian:
    python relief.py masukan.png
    python relief.py masukan.png --shade      # + pratinjau sculpt
"""
import argparse
import numpy as np
from PIL import Image
from scipy import ndimage

# ── KONSTANTA (cermin CFG v5 — ubah berpasangan) ──
PAD_FRAC = 0.07
W_LUM, W_CHROMA = 0.75, 0.25
R_FORM, R_MID, MID_GAIN = 0.022, 0.0045, 0.35
LO_PCT, HI_PCT = 1.0, 99.2
OUT_LO, OUT_HI = 0.08, 0.97
RAMP_FRAC, RAMP_MIN, RAMP_MAX = 0.025, 16, 64
FINAL_BLUR = 0.004

def ss(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)

def box(img, r):
    return ndimage.uniform_filter(img, size=2 * r + 1, mode='reflect')

def guided(I, r, eps):
    mI = box(I, r)
    var = np.maximum(box(I * I, r) - mI * mI, 0)
    a = var / (var + eps)
    return box(a, r) * I + box(mI - a * mI, r)

def measure_background(rgb):
    b = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]]).astype(np.float32)
    bg = np.median(b, axis=0)
    d2 = ((b - bg) ** 2).sum(axis=1)
    return bg, float(np.clip(np.percentile(d2, 90) * 1.6 + 60, 400.0, 9025.0))

def load(path, max_dim):
    img = Image.open(path)
    has_alpha = img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info)
    img = img.convert('RGBA') if has_alpha else img.convert('RGB')
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
    mn, mx = rgb0.min(-1), rgb0.max(-1)
    chroma0 = (mx - mn) / 255.0
    gray = rgb0 @ np.array([0.2126, 0.7152, 0.0722], np.float32) / 255.0

    if alpha is not None and (alpha < 0.98).mean() > 0.02:
        mask = np.zeros((H, W), bool)
        mask[py:py + h0, px:px + w0] = alpha >= 0.5
        lum = np.zeros((H, W), np.float32); chroma = np.zeros((H, W), np.float32)
        lum[py:py + h0, px:px + w0] = gray * alpha
        chroma[py:py + h0, px:px + w0] = chroma0 * alpha
        return mask, lum, chroma

    canvas = np.full((H, W, 3), bg, np.float32)
    canvas[py:py + h0, px:px + w0] = rgb0
    d2 = ((canvas - bg) ** 2).sum(-1)
    lbl, _ = ndimage.label(d2 <= tol2)
    border = np.concatenate([lbl[0], lbl[-1], lbl[:, 0], lbl[:, -1]])
    bset = np.unique(border); bset = bset[bset != 0]
    mask = ndimage.binary_closing(~np.isin(lbl, bset), np.ones((3, 3), bool))
    mn2, mx2 = canvas.min(-1), canvas.max(-1)
    lum = canvas @ np.array([0.2126, 0.7152, 0.0722], np.float32) / 255.0
    chroma = (mx2 - mn2) / 255.0
    return mask, lum, chroma

def build(mask, lum, chroma):
    H, W = lum.shape
    mind = min(W, H)
    cover = mask.mean()
    full = cover < 0.02 or cover > 0.99
    if full:
        mask = np.ones_like(mask)
    dist = ndimage.distance_transform_edt(mask) if not full else np.full_like(lum, mind)

    src = np.where(mask, W_LUM * lum + W_CHROMA * chroma, 0).astype(np.float32)
    form = guided(src, max(3, round(R_FORM * mind)), 0.03)
    mid = guided(src, max(2, round(R_MID * mind)), 0.015)
    sig = form + MID_GAIN * (mid - form)

    lo, hi = np.percentile(sig[mask], [LO_PCT, HI_PCT])
    rng = max(hi - lo, 10 / 255)
    v = np.clip((sig - lo) / rng, 0, 1)
    val = np.where(mask, OUT_LO + (OUT_HI - OUT_LO) * v, 0.0)

    rw = float(np.clip(mind * RAMP_FRAC, RAMP_MIN, RAMP_MAX))
    h = val if full else ss(dist / rw) * val

    r = max(1, round(mind * FINAL_BLUR))
    h = np.clip(box(h, r), 0, 1)
    stats = dict(mode='FULL-FRAME' if full else 'SUBJEK', cover=cover,
                 g=MID_GAIN, rw=round(rw))
    return h, stats

def shade_lambert(h):
    """Pratinjau sculpt — perkiraan wujud pahatan."""
    gy, gx = np.gradient(h)
    STR = 30.0
    nx, ny, nz = -gx * STR, -gy * STR, np.ones_like(h)
    inv = 1 / np.sqrt(nx * nx + ny * ny + 1)
    L = np.array([-0.55, -0.55, 0.625]); L /= np.linalg.norm(L)
    d = np.clip(-nx * inv * L[0] - ny * inv * L[1] + inv * L[2], 0, 1)
    return np.clip(h * 0.28 + 0.78 * d, 0, 1)

def main():
    ap = argparse.ArgumentParser(description='Gambar → heightmap CNC (otomatis)')
    ap.add_argument('input')
    ap.add_argument('-o', '--output', default=None)
    ap.add_argument('--max-dim', type=int, default=2048)
    ap.add_argument('--invert', action='store_true')
    ap.add_argument('--shade', action='store_true')
    a = ap.parse_args()
    stem = a.input.rsplit('.', 1)[0]
    out = a.output or f'heightmap-16bit-{stem}.png'

    rgb0, alpha = load(a.input, a.max_dim)
    bg, tol2 = measure_background(rgb0)
    mask, lum, chroma = segment(rgb0, alpha, bg, tol2)
    h, st = build(mask, lum, chroma)
    if a.invert:
        h = np.where(mask, 1 - h, 0)

    out16 = np.clip(h * 65535 + 0.5, 0, 65535).astype(np.uint16)
    try:
        Image.fromarray(out16, mode='I;16').save(out)
    except Exception:
        Image.fromarray((h * 255).astype(np.uint8)).save(out)
        print('Catatan: PIL gagal menyimpan 16-bit → tersimpan 8-bit.')
    if a.shade:
        Image.fromarray((shade_lambert(h) * 255).astype(np.uint8)).save(f'sculpt-{stem}.png')
    print(f"OK {out} · mode={st['mode']} · subjek={st['cover']*100:.0f}% · rambat={st['rw']}px")

if __name__ == '__main__':
    main()
