#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一帧立绘的**裙摆那一段**从第一帧对齐到第二帧。

为什么是一次性工具：一格出两帧的生成图里，两格是各画一遍，裙摆的图案和裙边会各差一点，
严重的时候干脆是两种设计（一边白色荷叶边、一边直摆白线）。新出的立绘在切图时用
whale-sprite.py 的 --freeze-below 就能解决；**已经切好的那八张，源图早就不在了**，只能在
切好的 760×330 上做同样的事，于是有了这个。

用法：python tools/whale-freeze-band.py lib/art/work-2-reading.webp [--dry-run]

两件事都不写死：

* 切在哪一行——在第 182～204 行之间挑"跨线的相邻两行差 ÷ 画面自然的相邻两行差"最小的一行。
  第一帧的裙腰常常比第二帧高一两行，切线压在那儿就会出现一条看得见的横线（2026-09-28 实测
  过：读书那条线跨线差 65，而画面自然差只有 14）。
* 冻到哪一行——从第 200 行往下，找"最后一行宽度还达最宽处 60%"的位置，那就是裙边；再往下
  是两条腿（或一条抬起来的腿），宽窄会掉下来。腿和手里的道具一律不碰。

跳过条件：这一段两帧的轮廓差占裙面超过 45%。那种是整条裙子在动（跑、冲刺），冻了会把画面
撕开，不属于缺陷。
"""
import sys

from PIL import Image

TOP_MIN, TOP_MAX = 182, 204   # 切线候选
SKIRT_TOP = 200               # 裙边从这一行往下探
WIDE_RATIO = 0.60             # 宽度达最宽处这个比例以上，才算"这一段还是裙子"
ALPHA_TOLERANCE = 0.45        # 轮廓差占裙面超过这个比例，就是在动的裙子，跳过
FEATHER = 3                   # 切线上下各用几行做渐变，免得留一条硬边
PANEL_W, PANEL_H = 380, 330


def row_step(row_a, row_b):
    """两行之间：两边都不透明的列上，通道差的平均。没有可比的列就返回 None。"""
    n = 0
    total = 0
    for x in range(PANEL_W):
        ra, ga, ba, aa = row_a[x]
        rb, gb, bb, ab = row_b[x]
        if aa <= 128 or ab <= 128:
            continue
        total += max(abs(ra - rb), abs(ga - gb), abs(ba - bb))
        n += 1
    return (total / float(n)) if n else None


def pick_cut(a, b):
    """挑一条最看不出接缝的切线，返回（行号，接缝是自然差的几倍）。"""
    pa, pb = a.load(), b.load()
    best, best_ratio = TOP_MIN, None
    for y in range(TOP_MIN, TOP_MAX + 1):
        nat = row_step([pa[x, y - 1] for x in range(PANEL_W)], [pa[x, y] for x in range(PANEL_W)])
        seam = row_step([pb[x, y - 1] for x in range(PANEL_W)], [pa[x, y] for x in range(PANEL_W)])
        if not nat or seam is None:
            continue
        ratio = seam / nat
        if best_ratio is None or ratio < best_ratio:
            best, best_ratio = y, ratio
    return best, best_ratio


def blend_rows(dst, src, y, alpha):
    """把 src 的第 y 行按 alpha 混进 dst；透明通道不动（只柔化颜色，不改轮廓）。"""
    d, s = dst.load(), src.load()
    if y < 0 or y >= PANEL_H:
        return
    for x in range(PANEL_W):
        sr, sg, sb, sa = s[x, y]
        dr, dg, db, da = d[x, y]
        if sa <= 128:
            continue
        if da <= 128:
            d[x, y] = (sr, sg, sb, sa)
            continue
        d[x, y] = (int(round(dr + (sr - dr) * alpha)),
                   int(round(dg + (sg - dg) * alpha)),
                   int(round(db + (sb - db) * alpha)), da)


def skirt_bottom(frame):
    px = frame.load()
    widths = [sum(1 for x in range(PANEL_W) if px[x, y][3] > 128) for y in range(SKIRT_TOP, PANEL_H)]
    widest = max(widths) if widths else 0
    bottom = SKIRT_TOP
    for i, n in enumerate(widths):
        if n >= widest * WIDE_RATIO:
            bottom = SKIRT_TOP + i
    return bottom


def band_stats(a, b, y0, y1):
    """这一段里：轮廓不同的像素数、两边都不透明但颜色不同的像素数。"""
    pa, pb = a.load(), b.load()
    alpha_diff = colour_diff = 0
    for y in range(y0, y1 + 1):
        for x in range(PANEL_W):
            ra, ga, ba, aa = pa[x, y]
            rb, gb, bb, ab = pb[x, y]
            if aa != ab:
                alpha_diff += 1
            if aa > 128 and ab > 128 and max(abs(ra - rb), abs(ga - gb), abs(ba - bb)) > 24:
                colour_diff += 1
    return alpha_diff, colour_diff


def frames(im):
    return im.crop((0, 0, PANEL_W, PANEL_H)), im.crop((PANEL_W, 0, PANEL_W * 2, PANEL_H))


def main():
    if len(sys.argv) < 2:
        print('用法：python tools/whale-freeze-band.py 立绘.webp [--dry-run]')
        return 2
    path = sys.argv[1]
    dry = '--dry-run' in sys.argv
    short = path.replace('\\', '/').split('/')[-1]

    im = Image.open(path).convert('RGBA')
    a, b = frames(im)
    bottom = skirt_bottom(a)
    top, ratio = pick_cut(a, b)
    alpha_diff, colour_diff = band_stats(a, b, top, bottom)
    pa = a.load()
    opaque = sum(1 for y in range(top, bottom + 1) for x in range(PANEL_W) if pa[x, y][3] > 128)
    share = alpha_diff / float(opaque or 1)
    print('  %s：第 %d～%d 行（切线挑在 %d，接缝是画面自然差的 %.1f 倍）；轮廓差 %d（%.1f%%），颜色差 %d'
          % (short, top, bottom, top, ratio or 0, alpha_diff, share * 100, colour_diff))
    if alpha_diff == 0 and colour_diff == 0:
        print('    —— 这一段本来就一致，不用动')
        return 0
    if share > ALPHA_TOLERANCE:
        print('    ✗ 轮廓差占 %.1f%% > %.0f%%：整条裙子在动，冻了会撕开，跳过'
              % (share * 100, ALPHA_TOLERANCE * 100))
        return 3
    if dry:
        print('    （试跑，没写文件）')
        return 0

    b.paste(a.crop((0, top, PANEL_W, bottom + 1)), (0, top))
    # 硬切会在切线上留一条看得见的横线（量过：读书那张跨线差是画面自然差的 3.4 倍），
    # 所以上下各三行做渐变过渡过去。
    for i in range(1, FEATHER + 1):
        blend_rows(b, a, top - i, i / float(FEATHER + 1))
        blend_rows(b, a, bottom + i, 1 - i / float(FEATHER + 1))
    im.paste(b, (PANEL_W, 0))
    im.save(path, 'WEBP', quality=92, method=6)

    chk = Image.open(path).convert('RGBA')
    ca, cb = frames(chk)
    aa, cc = band_stats(ca, cb, top, bottom)
    print('    ✓ 已对齐并写回；压缩后再量：轮廓差 %d，颜色差 %d' % (aa, cc))
    return 0 if cc <= 40 else 4


if __name__ == '__main__':
    sys.exit(main())