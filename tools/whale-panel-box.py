#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""量立绘每一格里角色自身的留白，输出 JSON（给测试用）。

立绘是"若干格并排"的雪碧图，页面每次只显示一格（122×106 CSS 像素）。
取景对不对，取决于每格里角色摆在哪：
  · 脚离格底太远 → 人会显得悬空；
  · 头或头发顶到格边 → 缩放后会被切掉；
  · 左右留白差太多 → 人不在格子中间。
本脚本把这些留白量出来（透明通道，精确），单位是源图像素。
每格源图 380×330，显示成 122×106，所以 1 源像素 = 122/380 CSS 像素。

用法：python tools/whale-panel-box.py lib/art/work-8-sprinting.webp [更多文件...]
输出：一行 JSON 数组，每项 {file, panel, left, right, top, bottom, glyphW, glyphH}
"""
import json
import os
import sys

import numpy as np
from PIL import Image

PANEL_W, PANEL_H = 380, 330


def measure(path):
    im = Image.open(path)
    a = np.asarray(im)
    if a.ndim == 3 and a.shape[2] == 4:
        alpha = a[:, :, 3]
    else:                                   # 没有透明通道就按"非白"当角色
        rgb = a[:, :, :3] if a.ndim == 3 else a[:, :, None]
        alpha = ((rgb.astype(np.int32).sum(axis=2) < 720) * 255).astype(np.uint8)
    n = im.width // PANEL_W
    out = []
    for k in range(n):
        cell = alpha[:, k * PANEL_W:(k + 1) * PANEL_W]
        ys, xs = np.where(cell > 16)
        if len(xs) == 0:
            out.append({'file': os.path.basename(path), 'panel': k, 'empty': True})
            continue
        out.append({
            'file': os.path.basename(path),
            'panel': k,
            'left': int(xs.min()),
            'right': int(PANEL_W - 1 - xs.max()),
            'top': int(ys.min()),
            'bottom': int(PANEL_H - 1 - ys.max()),
            'glyphW': int(xs.max() - xs.min() + 1),
            'glyphH': int(ys.max() - ys.min() + 1),
            'empty': False,
        })
    return out


if __name__ == '__main__':
    files = sys.argv[1:]
    if not files:
        art = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'lib', 'art')
        files = [os.path.join(art, f'work-{i}-{n}.webp') for i, n in [
            (1, 'ready'), (2, 'reading'), (3, 'typing'), (4, 'checking'), (5, 'thinking'),
            (6, 'running'), (7, 'waiting'), (8, 'sprinting'), (9, 'talking')]]
    rows = []
    for f in files:
        rows.extend(measure(f))
    print(json.dumps(rows, ensure_ascii=False))
