#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把两张"单人格"生成图拼成一张两格并排的洋红底图，交给 whale-sprite.py 切。

用法：
    python tools/whale-pair.py 第一帧.png 第二帧.png 拼接.png
    python tools/whale-sprite.py 拼接.png lib/art/work-2-reading.webp

为什么要多这一道：过去是**一张图里画两格**，模型两格各画一遍，于是图案、条纹、
腿和发丝都会各差一点（用户 2026-09-28 报的裙子不一致，以及 2026-09-28 报的
"上半身和下半身割裂"）。现在两帧不再同图生成：第一帧单独出，第二帧由第一帧
**编辑**而来（只改该动的地方），本脚本再把它们并排拼回去——两帧出自同一张画，
除了该动的部位以外天生逐像素一致。

拼的时候两帧**共用同一个缩放因子**（高的那张定到 TARGET_H，另一张按同比例），
这样"第二帧的人忽然大了一圈"不可能发生；脚底对齐在同一个基线上。
"""
import sys

from PIL import Image

MAGENTA_KEEP = 50        # 与 whale-sprite.py 同一套判据：min(r,b)-g
PANEL = 1024             # 每格边长；输出 2048×1024，whale-sprite.py 按宽对半切
TARGET_H = 900           # 拼图里人物高度（后面切图会统一缩到 310）
BASE = 990               # 脚底基线
MARGIN = 40              # 贴边留白，避免人物顶到格子边缘


def is_magenta(px):
    r, g, b = px[0], px[1], px[2]
    return min(r, b) - g > MAGENTA_KEEP


def background_ok(img, step=7):
    """四边取样，确认底是洋红——不是就别往下走，宁可让人去重出图。"""
    px = img.load()
    w, h = img.size
    bad = 0
    total = 0
    for x in range(0, w, step):
        for y in (2, h - 3):
            total += 1
            if not is_magenta(px[x, y]):
                bad += 1
    for y in range(0, h, step):
        for x in (2, w - 3):
            total += 1
            if not is_magenta(px[x, y]):
                bad += 1
    return bad / float(total)


def alpha_box(img):
    """人物外框：非洋红像素的范围。"""
    px = img.load()
    w, h = img.size
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if not is_magenta(px[x, y]):
                if x < x0:
                    x0 = x
                if y < y0:
                    y0 = y
                if x > x1:
                    x1 = x
                if y > y1:
                    y1 = y
    if x1 < 0:
        return None
    return (x0, y0, x1 + 1, y1 + 1)


def main():
    if len(sys.argv) < 4:
        print('用法：python tools/whale-pair.py 第一帧 第二帧 输出.png')
        return 2
    paths = sys.argv[1:3]
    imgs = [Image.open(p).convert('RGB') for p in paths]

    for p, im in zip(paths, imgs):
        ratio = background_ok(im)
        print(f'  {p}：{im.size[0]}×{im.size[1]}，四边非洋红占比 {ratio * 100:.1f}%')
        if ratio > 0.02:
            print('  ✗ 底不是纯洋红（#FF00FF 平底）——重出这张，别在这里硬抠')
            return 1

    boxes = [alpha_box(im) for im in imgs]
    if not any(boxes):
        print('  ✗ 两张里一张人物都没有')
        return 1
    for p, b in zip(paths, boxes):
        if not b:
            print(f'  ✗ {p} 里找不到人物（整张都是洋红）')
            return 1

    tallest = max(b[3] - b[1] for b in boxes)
    scale = TARGET_H / float(tallest)
    for p, b in zip(paths, boxes):
        print(f'  {p}：人物 {b[2] - b[0]}×{b[3] - b[1]} → 缩放 {scale:.3f} 后 '
              f'{int(round((b[2] - b[0]) * scale))}×{int(round((b[3] - b[1]) * scale))}')

    out = Image.new('RGB', (PANEL * 2, PANEL), (255, 0, 255))
    for i, (im, b) in enumerate(zip(imgs, boxes)):
        cut = im.crop(b)
        w = int(round(cut.size[0] * scale))
        h = int(round(cut.size[1] * scale))
        cut = cut.resize((w, h), Image.Resampling.LANCZOS)
        if w > PANEL - MARGIN * 2:
            print(f'  ✗ 第 {i + 1} 帧缩放后宽 {w} 顶到了格子边，重出（姿势别张这么开）')
            return 1
        out.paste(cut, (i * PANEL + (PANEL - w) // 2, BASE - h))

    out.save(sys.argv[3], 'PNG')
    print(f'  ✓ {sys.argv[3]}（{out.size[0]}×{out.size[1]}，两帧共用缩放 {scale:.3f}）')
    print('    下一步：python tools/whale-sprite.py ' + sys.argv[3] + ' 输出.webp')
    return 0


if __name__ == '__main__':
    sys.exit(main())
