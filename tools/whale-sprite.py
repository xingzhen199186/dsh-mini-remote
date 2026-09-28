#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一张"两格并排"的生成图切成 lib/art 用的 760×330 双帧 WebP。

用法：
    python tools/whale-sprite.py 生成图.png lib/art/work-9-talking.webp
    python tools/whale-sprite.py 生成图.png 输出.webp --freeze-below 168   # 成图第 168 行以下取自第一帧

为什么这么切：两帧**共用**同一套裁切与缩放（外框取两帧的并集），落点则从一张
现成立绘里量出来——这样新出的这张和其余八张一样高、脚底一样齐。分别按各自外框裁，
两帧会差一两个像素，播起来整个角色在抖，比不动还难看（2026-09-21 实测过这条）。

这是 2026-09-28 重写的：上一版丢在了临时目录里。
"""
import sys

from PIL import Image

# 洋红底的判定：min(r,b)-g 越小越"实心"，越大越"是背景洋红"。
# 纯洋红 #FF00FF 的这个值是 255，白色是 0，宝蓝色是负数。
MAGENTA_KEEP = 50
MAGENTA_DROP = 190
FAINT_DROP = 80                     # 不透明度低于这个值的边缘像素：扔掉，别反解
FRAME_H = 310                       # 人物高度，和其余八张对齐
PANEL_W, PANEL_H = 380, 330
SEAM_SAFE = 12                      # 源图里离中缝这么近还有内容，就说明两格挨太近
REF = 'lib/art/work-1-ready.webp'   # 量落点用的参照（其余八张里任意一张）


def clamp(v):
    return 0 if v < 0 else 255 if v > 255 else int(round(v))


def key_magenta(img):
    """洋红底转透明。

    边缘上被洋红染过的那一圈，不能只做"透明/不透明"两档——那样头发边会留一圈紫。
    所以按合成公式反解：观测色 = 前景色*a + 洋红底色*(1-a)，已知底色是 (255,0,255)，
    求出 a 再除回去。
    """
    img = img.convert('RGBA')
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            m = min(r, b) - g
            if m <= MAGENTA_KEEP:
                px[x, y] = (r, g, b, 255)
            elif m >= MAGENTA_DROP:
                px[x, y] = (0, 0, 0, 0)
            else:
                a = int(255 * (MAGENTA_DROP - m) / (MAGENTA_DROP - MAGENTA_KEEP))
                if a < FAINT_DROP:
                    # 极淡的边缘：反解要拿颜色除以很小的 a，会把噪声放大成紫色残渣
                    # （第一版就是这么留下 202 个洋红像素的）。人眼本来也看不见
                    # 这么淡的一圈，直接扔掉。
                    px[x, y] = (0, 0, 0, 0)
                    continue
                af = a / 255.0
                px[x, y] = (
                    clamp((r - (1 - af) * 255) / af),
                    clamp(g / af),
                    clamp((b - (1 - af) * 255) / af),
                    a,
                )
    return img


def seam_pixels(frame, half_w):
    """这一格在靠近中缝的那 12 像素里有多少不透明像素——不是 0 就说明两格挨太近。"""
    strip = frame.crop((half_w - SEAM_SAFE, 0, half_w, frame.size[1])).getchannel('A')
    hist = strip.histogram()
    return sum(hist[1:])


def clean_magenta(img, thresh=60):
    """把残留的洋红像素直接抹掉，返回（个数，这些像素的外框）。

    洋红在这个角色身上不可能出现——她的配色是蓝、白、肤色、淡蓝头发——所以这条硬阈值
    是安全的。为什么非要扫这一遍：缩放插值的振铃会在边缘产生过冲，把边缘像素推到洋红
    附近（第一版就是这么留下两百多个的，我先猜是"极淡边缘反解放大"，猜错了）。
    """
    px = img.load()
    xs, ys, n = [], [], 0
    for y in range(img.size[1]):
        for x in range(img.size[0]):
            r, g, b, a = px[x, y]
            if a > 0 and min(r, b) - g > thresh:
                xs.append(x)
                ys.append(y)
                n += 1
                px[x, y] = (0, 0, 0, 0)
    box = (min(xs), min(ys), max(xs), max(ys)) if n else None
    return n, box


def moved_ratio(a, b):
    """两帧真正动过的像素占比（任一通道差 > 24 就算动过）。"""
    pa, pb = a.load(), b.load()
    w, h = a.size
    moved = 0
    for y in range(h):
        for x in range(w):
            ra, ga, ba, aa = pa[x, y]
            rb, gb, bb, ab = pb[x, y]
            if max(abs(ra - rb), abs(ga - gb), abs(ba - bb), abs(aa - ab)) > 24:
                moved += 1
    return moved / float(w * h)


def freeze_below(a, b, y):
    """把 b 的第 y 行以下整段换成 a 的（含透明通道）。

    一格出两帧的生成图里，两格是**各画一遍**，不是复制：裙子上的图案、袜口条纹、
    腿和发丝都会各差一点。用户 2026-09-28 报「同一个动画的两张图片里裙子上的图案
    不一致」就是指这个。按姿势只该动手臂的那些立绘，把这条线以下整段取自第一帧，
    图案就不可能再"变"。
    """
    out = b.copy()
    out.paste(a.crop((0, y, a.size[0], a.size[1])), (0, y))
    return out


def count_diff_below(a, b, y):
    """两帧在第 y 行以下有多少像素不一致（任一通道差 > 24）。"""
    pa, pb = a.load(), b.load()
    w, h = a.size
    n = 0
    for yy in range(y, h):
        for x in range(w):
            ra, ga, ba, aa = pa[x, yy]
            rb, gb, bb, ab = pb[x, yy]
            if max(abs(ra - rb), abs(ga - gb), abs(ba - bb), abs(aa - ab)) > 24:
                n += 1
    return n


def main():
    if len(sys.argv) < 3:
        print('用法：python tools/whale-sprite.py 生成图 输出.webp [--freeze-below 行号] [--dx2 像素]')
        return 2
    src_path, out_path = sys.argv[1], sys.argv[2]
    freeze_y = None
    if '--freeze-below' in sys.argv:
        i = sys.argv.index('--freeze-below')
        if i + 1 >= len(sys.argv) or not sys.argv[i + 1].isdigit():
            print('  ✗ --freeze-below 后面要跟一个行号')
            return 2
        freeze_y = int(sys.argv[i + 1])
    # 第 2 帧整体横移多少像素（正数=往右）。给"基准帧本来就两帧站位不同"的动作复现站位用：
    # 冲刺的基准帧第 2 帧整个人比第 1 帧靠左 22 像素（按脸对齐会把这个差抹平，等于偷偷改了
    # 站位）。默认 0 = 两帧完全对齐。
    dx2 = 0
    if '--dx2' in sys.argv:
        i = sys.argv.index('--dx2')
        v = sys.argv[i + 1] if i + 1 < len(sys.argv) else ''
        if not v.lstrip('-').isdigit():
            print('  ✗ --dx2 后面要跟一个整数像素数（正数=第 2 帧往右挪）')
            return 2
        dx2 = int(v)

    src = Image.open(src_path)
    w, h = src.size
    half = (w // 2) & ~1  # 偶数，免得中缝那列像素归属含糊
    left = key_magenta(src.crop((0, 0, half, h)))
    right = key_magenta(src.crop((half, 0, w, h)))
    print(f'  源图 {w}×{h}，从 {half} 处切两格')

    bl, br = left.getchannel('A').getbbox(), right.getchannel('A').getbbox()
    if not bl or not br:
        print('  ✗ 有一格是空的——不猜，重出图')
        return 1
    for name, bb, frame in (('左格', bl, left), ('右格', br, right)):
        print(f'  {name}外框 {bb}，离中缝 {SEAM_SAFE}px 内不透明像素 {seam_pixels(frame, half)}')

    box = (min(bl[0], br[0]), min(bl[1], br[1]), max(bl[2], br[2]), max(bl[3], br[3]))
    fh = FRAME_H
    fw = int(round((box[2] - box[0]) * (fh / float(box[3] - box[1]))))
    if fw > PANEL_W - 8:                 # 姿势张得开也别顶穿到隔壁格
        s = (PANEL_W - 8) / float(fw)
        fw, fh = int(round(fw * s)), int(round(fh * s))
    print(f'  并集外框 {box} → 缩放后每帧 {fw}×{fh}（目标人物高 {FRAME_H}）')

    ref = Image.open(REF).convert('RGBA').crop((0, 0, PANEL_W, PANEL_H))
    rb = ref.getchannel('A').getbbox()
    cx = (rb[0] + rb[2]) / 2.0
    bottom = rb[3]
    print(f'  参照 {REF}：人物中心 x={cx}，脚底 y={bottom}')

    frames = []
    for i, frame in enumerate((left, right)):
        cut = frame.crop(box).resize((fw, fh), Image.Resampling.LANCZOS)
        n_mag, mag_box = clean_magenta(cut)
        if n_mag:
            print(f'  第 {i + 1} 帧缩放后扫掉洋红 {n_mag} 个像素，位置外框 {mag_box}')
        frames.append(cut)

    if freeze_y is not None:
        # 参数按**成图坐标**算（0～329，和量颜色、量差异时用的坐标一致）。帧本身只有 fh 高，
        # 贴在成图第 (bottom - fh) 行起，所以要减掉这段偏移——2026-09-28 就是这里差了 12 行，
        # 冻晚一截，裙子最上面十几行没罩住，量出来还有 2525 个不一致像素。
        cut_y = freeze_y - (bottom - fh)
        if cut_y <= 0:
            print(f'  ✗ --freeze-below {freeze_y} 太高了：人物从成图第 {bottom - fh} 行起，这条线会连手臂一起冻掉')
            return 2
        print(f'  成图第 {freeze_y} 行 = 这一帧的第 {cut_y} 行（帧贴在成图第 {bottom - fh} 行起）')
        before = count_diff_below(frames[0], frames[1], cut_y)
        frames[1] = freeze_below(frames[0], frames[1], cut_y)
        after = count_diff_below(frames[0], frames[1], cut_y)
        print(f'  第 {freeze_y} 行以下对齐到第一帧：原本 {before} 个不一致像素 → 现在 {after}')
        if after:
            print('  ✗ 对齐没生效，不写文件')
            return 1

    # 合成放在对齐之后：否则冻的是散帧，写出去的还是旧像素。
    out = Image.new('RGBA', (PANEL_W * 2, PANEL_H), (0, 0, 0, 0))
    for i, cut in enumerate(frames):
        dx = dx2 if i == 1 else 0
        out.alpha_composite(cut, (int(round(i * PANEL_W + cx - fw / 2.0)) + dx, bottom - fh))
    if dx2:
        print(f'  第 2 帧整体横移 {dx2:+d} 像素（复现基准帧两帧之间本来就有的站位差）')

    for i, f in enumerate(frames):
        bb = f.getchannel('A').getbbox()
        print(f'  输出第 {i + 1} 帧：宽 {bb[2] - bb[0]} 高 {bb[3] - bb[1]}')
    ratio = moved_ratio(frames[0], frames[1])
    print(f'  两帧动过的像素：{ratio * 100:.1f}%')
    left_magenta, mag_box = clean_magenta(out)
    print(f'  最终洋红残留：{left_magenta} 个像素 {mag_box or ""}')

    out.save(out_path, 'WEBP', quality=92, method=6)
    # 5% 这条线是量出来的，不是拍的：其余八张实测 3.8%～18.1%（最像的"等太久"是 7.4%），
    # 挥手这类只动一条手臂的姿势本来就是这个量级。
    ok = ratio >= 0.05 and fh >= FRAME_H * 0.98 and left_magenta == 0
    print(f'  {"✓ 通过" if ok else "✗ 没过"}：{out_path}（{out.size[0]}×{out.size[1]}）')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
