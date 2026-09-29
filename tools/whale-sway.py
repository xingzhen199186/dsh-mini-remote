#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「两帧并排」的立绘扭成 N 帧：只让头发按一条位移场摆动，身体逐像素不动。

为什么走这条路（用户 2026-09-29 定的方向）：一张立绘只有两帧，两帧只能表现两个姿势硬切，
再怎么调幅度也换不来"流畅"。头发这类**附属物**的运动规律在动画里叫"跟随与重叠动作"
（follow-through / overlapping action）：它总比身体晚一步、越靠末端摆幅越大、相位越滞后，
而且会过冲再回落；游戏里用弹簧骨骼（spring bone，一条带阻尼的骨链）驱动头发是同一件事的
物理版本。这里把这条规律写成一条位移场，逐帧采样：

    x(y, t) = 摆幅 · A(y) · sin(2π·k/N − φ(y)) · 渐隐(离身体的距离)

    A(y)  从发根 0 长到发梢 1——越末端摆得越大；
    φ(y)  从 0 滞到 --lag 度——越末端越晚（这就是"末端滞后"）；
    渐隐  越靠近身体位移越小，免得把身体边缘一起拖出去；
    另有竖直微调：横摆会把发丝拉长，按"发长不变"把它收回来（摆幅 40 像素时约 5~7 像素）。

**"身体不漂"是构造性的**：判定为身体的像素（不透明且发色权重 < BODY_W）直接从原图拷贝，
根本不经过重采样，所以逐像素一致。脚本自己会把这件事数一遍并打印出来——不是靠推理。

用法：
    python tools/whale-sway.py 基准.webp 输出.webp [--frames 6] [--amp 20] [--lag 150]

输入必须是一张标准立绘（760×330，两帧并排各 380×330）。输出是 380N×330 的雪碧图，
第 1..N/2 帧用输入的第 1 帧作身体、第 N/2+1..N 帧用输入的第 2 帧作身体（腿脚照旧瞬间换）。
"""
import argparse
import importlib.util
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

# 借人家模块来算（见 load_measure）会留下 __pycache__，而这个仓库没忽略它。
# 一个字节码目录不值得为它改 .gitignore，直接关掉写盘。
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
PW, PH = 380, 330

# 身体阈值：实心不透明、且几乎不是发色的像素算"身体"，原样拷贝。
# 为什么要求"几乎不是发色"而不是"不是发色"：发丝是一根根画的，每根的抗锯齿边权重都在
# 0.05~0.5 之间；把 0.2 当界会把整团头发的边都判成身体，于是头发被钉住、背景反被拽出鬼影
# （踩过：头发内 mean|dx| 只剩 0.08 像素，而背景里的 dx 有 20 像素）。
BODY_ALPHA = 200
BODY_W = 0.05
# 摆幅／相位的起止行：发根从第 40 行左右开始长（上面是发饰），发梢到第 230 行左右。
Y0, Y1 = 40.0, 230.0
# 渐隐：贴住身体的那几像素不动（否则会跟身体之间裂出一道缝），离开约 14 像素后完全自由。
FADE_NEAR, FADE_FAR = 3, 14
# 允许位移的最下面一行。基准帧里袜子从第 250 行左右开始、鞋到第 330 行，头发最低到第 255 行左右，
# 所以切在 265：保住整片袜子和鞋，也留住头发的全部摆动范围。这个行号是人工看基准帧定的，
# 不是脚本算的——判据不能用被测对象自己的遮罩来定义，否则遮罩错的时候判据一起失明。
MOTION_Y = 265


def load_measure():
    """借用 whale-measure.py 的发色权重与分段口径——同一个指标不该有两套实现。"""
    spec = importlib.util.spec_from_file_location('wm', str(HERE / 'whale-measure.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


WM = load_measure()


def smoothstep(u):
    u = min(max(u, 0.0), 1.0)
    return u * u * (3.0 - 2.0 * u)


def pixels_list(frame):
    """转成 Python int 的嵌套表。

    必须转：whale-measure 的 hair_weight 里做的是 b−r 这类相减，numpy 的 uint8 会溢出
    （踩过：拿到"overflow encountered in scalar subtract"，权重全错、质心一动不动）。
    """
    return np.asarray(frame).tolist()


# 每行头发权重到多少才算"这一行有头发"。每一行的权重实测只有 50~130（一条 50 行高的带
# 总共约 5000），门槛拍到 200 会让所有行都判成"没头发"——踩过，表现为"某个开关开了跟没开
# 一样"，数字一个都没变。这份诊断只用来量"冻结那两帧自己画的头发差多少"，不参与生成。
ROW_MIN = 25


def row_centroids(w):
    """每一行的头发加权质心（没有头发的行给 None）。"""
    out = []
    for y in range(PH):
        total = sum(w[y])
        if total < ROW_MIN:
            out.append(None)
        else:
            out.append(sum(v * x for x, v in enumerate(w[y])) / total)
    return out


def drawn_swing(w_a, w_b, face_a, face_b):
    """量冻结那两帧**自己画的**头发差了多少（相对脸）。

    这是这一轮必须先弄清的一件事：第 2 帧的头发是被画家画到另一边的。两帧交替播时，
    这笔画的差异会在换身体那一下整块跳过去。逐行量出来并扣掉两帧的脸站位差，4 条带报范围。
    正数表示第 2 帧那一行的头发（相对脸）比第 1 帧更靠右。
    """
    ca, cb = row_centroids(w_a), row_centroids(w_b)
    shift = face_b - face_a
    out = []
    for lo, hi in ((25, 70), (70, 120), (120, 180), (180, 260)):
        vals = [cb[y] - ca[y] - shift for y in range(lo, hi)
                if ca[y] is not None and cb[y] is not None]
        out.append((min(vals), max(vals)) if len(vals) >= 3 else None)
    return out


def fade_map(frame):
    """离身体多远才允许位移：贴着身体恒为 0，离开约 14 像素后恒为 1。

    做法是把"实心身体"掩膜放大再高斯模糊——模糊出来的就是"离身体的距离"的粗略形状。
    不用 scipy 的距离变换，是因为这一层只需要平滑过渡，不需要准确距离。
    """
    px = pixels_list(frame)
    arr = np.asarray(frame)
    alpha = arr[..., 3]
    w = np.array([[WM.hair_weight(px[y][x]) for x in range(PW)] for y in range(PH)])
    body = (alpha >= BODY_ALPHA) & (w < BODY_W)

    # 「允许位移」的像素：淡蓝（头发）且在第 MOTION_Y 行以上。
    # 为什么不能只判"不是身体"：立绘边缘是抗锯齿的，那些半透明轮廓像素既不是身体、也不是头发，
    # 却会被 fade 判成"离身体够远"而拿到非零位移——摘走一点、原处留一圈淡痕，就是重影；
    # 鞋底的软阴影同理，所以鞋底看起来像两片（用户 2026-09-29 报的"两条腿变四条腿"）。
    # 为什么还要排除深蓝：鞋是饱和的深蓝，发色判据会把它当头发，于是整只鞋被挪走。
    # r/g/b 都是 0~255，用 int16 免得相减溢出（踩过 uint8 溢出）。
    r = arr[..., 0].astype(np.int16)
    g = arr[..., 1].astype(np.int16)
    b = arr[..., 2].astype(np.int16)
    ys = np.arange(PH, dtype=np.int16)[:, None]
    motion = (b - r > 15) & (np.minimum(np.minimum(r, g), b) > 100) & (ys < MOTION_Y)

    mask = Image.fromarray((body * 255).astype(np.uint8), 'L')
    grown = mask.filter(ImageFilter.MaxFilter(2 * FADE_NEAR + 1))
    blur = grown.filter(ImageFilter.GaussianBlur((FADE_FAR - FADE_NEAR) / 2.0))
    d = np.asarray(blur).astype(np.float32) / 255.0
    fade = np.clip((1.0 - d - 0.10) / 0.55, 0.0, 1.0)
    fade = fade * fade * (3.0 - 2.0 * fade)
    fade[body] = 0.0
    fade[~motion] = 0.0
    return w, fade, body, motion


def field(fade, amp, lag_deg, phase):
    """这一帧的位移场：dx（往右为正）、dyl（向下取样多少像素＝把发丝按发长不变收回来）。"""
    ys = np.arange(PH, dtype=np.float32)[:, None]
    u = np.clip((ys - Y0) / (Y1 - Y0), 0.0, 1.0)
    a = u * u * (3.0 - 2.0 * u)               # A(y)：发根 0 → 发梢 1
    phi = math.radians(lag_deg) * a           # φ(y)：越末端越滞后
    dx = amp * a * np.sin(phase - phi) * fade
    length = np.maximum(ys - Y0, 0.0)          # 自由段长度
    dyl = length - np.sqrt(np.maximum(length * length - dx * dx, 0.0))
    return dx.astype(np.float32), dyl.astype(np.float32)


def warp(px, dx, dyl):
    """输出像素 (x,y) 取原图 (x−dx, y+dyl)。先乘 alpha 再插值，免得透明区把边缘染黑。"""
    img = px.astype(np.float32)
    a = img[..., 3:4] / 255.0
    prem = img[..., :3] * a
    hh, ww = a.shape[:2]
    yy, xx = np.mgrid[0:hh, 0:ww]
    sx = xx - dx
    sy = yy + dyl
    x0 = np.floor(sx).astype(np.int32)
    y0 = np.floor(sy).astype(np.int32)
    fx = (sx - x0)[..., None]
    fy = (sy - y0)[..., None]
    x0c, y0c = np.clip(x0, 0, ww - 1), np.clip(y0, 0, hh - 1)
    x1c, y1c = np.clip(x0 + 1, 0, ww - 1), np.clip(y0 + 1, 0, hh - 1)

    def g(m, yi, xi):
        return m[yi, xi]

    def bilerp(m):
        return (g(m, y0c, x0c) * (1 - fx) * (1 - fy) + g(m, y0c, x1c) * fx * (1 - fy)
                + g(m, y1c, x0c) * (1 - fx) * fy + g(m, y1c, x1c) * fx * fy)

    rgb = bilerp(prem)
    a_out = bilerp(a)
    rgb = np.where(a_out > 1e-6, rgb / np.maximum(a_out, 1e-6), 0.0)
    out = np.concatenate([rgb, a_out * 255.0], axis=-1)
    return np.clip(np.round(out), 0, 255).astype(np.uint8)


def band_centroids(frame_img):
    """一帧的四带加权质心（复用 whale-measure 的分带与权重口径）。"""
    px = pixels_list(frame_img.convert('RGBA'))
    w = [[WM.hair_weight(px[y][x]) for x in range(PW)] for y in range(PH)]
    out = []
    for _label, y0, y1 in WM.HAIR_BANDS:
        total, c, _lo, _hi = WM.band_stats(w, y0, y1, 0, PW)
        out.append(c if total >= WM.BAND_MIN else None)
    return out


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('src')
    ap.add_argument('out')
    ap.add_argument('--frames', type=int, default=6, help='总帧数，必须是偶数（默认 6）')
    ap.add_argument('--amp', type=float, default=15.0,
                    help='发梢的峰值横向摆幅（像素，默认 15）')
    ap.add_argument('--lag', type=float, default=300.0,
                    help='发梢相对发根的相位滞后（度，默认 300）')
    args = ap.parse_args()

    n = args.frames
    if n < 2 or n % 2:
        print(f'  ✗ --frames 要是 ≥2 的偶数：{n}')
        return 2

    im = Image.open(args.src).convert('RGBA')
    if im.size != (PW * 2, PH):
        print(f'  ✗ {args.src} 不是 {PW * 2}×{PH}：{im.size}')
        return 2
    srcs = [np.asarray(im.crop((0, 0, PW, PH))), np.asarray(im.crop((PW, 0, PW * 2, PH)))]
    maps = [fade_map(Image.fromarray(s)) for s in srcs]
    face = [WM.face_anchor(Image.fromarray(s)) for s in srcs]
    print(f'  ——冻结那两帧**自己画的**头发差多少（相对脸，逐行质心）——')
    drawn = drawn_swing(maps[0][0], maps[1][0], face[0], face[1])
    for (lo, hi), seg in zip(((25, 70), (70, 120), (120, 180), (180, 260)), drawn):
        print(f'    {lo:>3}-{hi:<3} 行：' + ('料太少' if seg is None
              else f'{seg[0]:+.1f} 到 {seg[1]:+.1f} 像素'))
    print('    （这一笔画的差异会在"换身体"那一下整块跳过去，是这一版消不掉的部分：'
          '身体要逐像素不动，两半就只能各用自己那一帧的头发）')

    sheets, frames, report = [], [], []
    for k in range(n):
        half = 0 if k < n // 2 else 1
        src = srcs[half]
        _w, fade, body, motion = maps[half]
        phase = 2.0 * math.pi * k / n
        dx, dyl = field(fade, args.amp, args.lag, phase)
        warped = warp(src, dx, dyl)
        # 身体、以及「不允许位移」的像素一律从原图逐字节拷贝，根本不经过重采样——
        # 于是重影在构造上不可能出现，而不是靠事后的指标去发现它。
        frame = np.where((body | ~motion)[..., None], src, warped)
        moved_body = int(np.count_nonzero(np.any(frame != src, axis=-1) & body))
        hair_moved = int(np.count_nonzero(np.any(frame != src, axis=-1) & ~body))
        alpha = frame[..., 3] > 128
        cols = np.where(alpha.any(axis=0))[0]
        margin = min(int(cols.min()), PW - 1 - int(cols.max())) if len(cols) else PW
        frames.append(Image.fromarray(frame))
        report.append((k, half + 1, float(np.abs(dx).max()), hair_moved, moved_body, margin))
        sheets.append(frame)

    sheet = Image.fromarray(np.concatenate(sheets, axis=1))
    sheet.save(args.out, 'WEBP', quality=95, method=6)

    print(f'  ✓ {args.out}（{sheet.size[0]}×{sheet.size[1]}，{n} 帧 × {PW}）')
    print(f'  摆幅 {args.amp:g} 像素（发梢峰值）／相位滞后 {args.lag:g}°／'
          f'A(y) 第 {Y0:.0f}→{Y1:.0f} 行由 0 长到 1')
    print(f'  {"帧":>3}{"身体来自":>9}{"该帧最大位移":>13}{"头发动过":>10}'
          f'{"身体动过":>9}{"离格边":>8}')
    for k, half, mx, hm, bm, mg in report:
        print(f'  {k + 1:>3}{f"原第{half}帧":>9}{mx:>13.1f}{hm:>10}{bm:>9}{mg:>8}')

    cents = [band_centroids(f) for f in frames]
    print('  ——四带加权质心（像素，帧 1 为 0）——')
    for i, (_l, y0, y1) in enumerate(WM.HAIR_BANDS):
        vals = [None if c[i] is None else c[i] - cents[0][i] for c in cents]
        if cents[0][i] is None:
            print(f'  {_l:<14}料太少')
            continue
        shown = ' '.join('—' if v is None else f'{v:+.1f}' for v in vals)
        span = max(v for v in vals if v is not None) - min(v for v in vals if v is not None)
        print(f'  {_l:<14}{shown}   峰峰值 {span:.1f}')

    half_i = n // 2
    shifts = []
    for i, (_l, _y0, _y1) in enumerate(WM.HAIR_BANDS):
        a, b = cents[0][i], cents[half_i][i]
        shifts.append(None if a is None or b is None else b - a)
    if all(s is not None for s in shifts):
        swing = shifts[1] - shifts[3]
        print(f'  ——老口径（第 1 帧 vs 第 {half_i + 1} 帧，与之前两帧版可比）——')
        print('  发根 {} / 上段 {} / 中段 {} / 发梢 {}  → 甩幅 {:.1f}'.format(
            *[f'{s:+.1f}' for s in shifts], swing))
    print('  ——逐帧步长（相邻帧的四带质心差，越均匀越顺）——')
    worst = 0.0
    for i, (label, _y0, _y1) in enumerate(WM.HAIR_BANDS):
        steps = []
        for k in range(1, n):
            a, b = cents[k - 1][i], cents[k][i]
            steps.append(None if a is None or b is None else b - a)
        if any(s is None for s in steps):
            print(f'  {label:<14}料太少')
            continue
        big = max(abs(s) for s in steps)
        worst = max(worst, big)
        mark = '  ← 换身体那一下' + ('' if abs(steps[half_i - 1]) < 15 else '（偏大）')
        print(f'  {label:<14}' + ' '.join(f'{s:+.1f}' for s in steps)
              + f'   最大 {big:.1f}（第 {steps.index(max(steps, key=abs)) + 1} 步{mark}）')
    bad = sum(r[4] for r in report)
    # 独立判据（顾问群 2026-09-29 的建议）：受保护区 = 第 MOTION_Y 行以下那片袜子和鞋，行号是
    # 人工看基准帧定的，**不看脚本自己的遮罩**。原来只报"身体动过 0 个"——而遮罩错把腿脚算成
    # 头发时，那条判据自动失明，重影就一路上了真机。必须在这里、在编码之前的内存里比。
    # 不比对写出来的文件：存的是有损 webp，重编码会让几千个像素自变，比了也没有意义。
    protected_bad = 0
    for k, f in enumerate(frames):
        src = srcs[0 if k < n // 2 else 1]
        d = np.abs(np.asarray(f).astype(np.int16) - src.astype(np.int16)).max(axis=2)
        protected_bad += int(np.count_nonzero(d[MOTION_Y:] > 0))
    print(f'  {"✓" if protected_bad == 0 else "✗"} 受保护区（第 {MOTION_Y} 行以下：袜子和鞋）'
          f'与冻结帧不一致的：{protected_bad} 个')
    print(f'  相邻帧最大步长 {worst:.1f} 像素')
    print(f'  {"✓" if bad == 0 else "✗"} 判定为身体的像素与冻结帧不一致的：{bad} 个')
    return 0 if bad == 0 and protected_bad == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
