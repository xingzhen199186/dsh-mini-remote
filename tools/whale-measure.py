#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对照基准帧量一对立绘——口径全部照 docs/character.md 第四节的像素差／分区量法。

用法：
    python tools/whale-measure.py 基准.webp 候选.webp

量出来的东西：
  1. 三段帧间差异（上半身 12~160 / 腰腹 160~240 / 裙子以下 240~330），只统计两侧 alpha>128。
  2. 头发：先用色相把"冰蓝头发"挑出来（权重是连续的，不是硬阈值，免得抗锯齿边缘抖动被当成位移），
     再按四条横带（发根 25~70 / 上段 70~120 / 中段 120~180 / 发梢 180~260）分别量
     **整幅宽度的加权质心位移**（帧2 减帧1，正数=往右）和该带头发轮廓的最左/最右外缘。
     看的是这四个数的**形状**，不是大小：
       · 四项都接近 0（±2.3 像素以内）——头发根本没动（冻结的跑就是这样）；
       · 四项同向、幅度接近——整块平移，就是用户说的"像一整块硬塑料被挪过去"；
       · 发根几乎不动、越往发梢越大——甩出去；
       · **发梢与上段反号**——甩出去＋末端滞后。
     参照物是用户已经认可的冲刺：−8.5 / +50.1 / +7.5 / −35.7（同一个"发梢反号"的形状）。
     另外报"最佳对齐后的剩余形状差"：最优平移也只能重合到那个程度，说明它换了形状。
  3. 腿：裙子以下各行不透明段的横向位置（换脚判据）。
  4. 全身：外框、头顶行、脚底行、人物高度——防止整张图挪位或缩放；
     外加**脸的横向中心**，用来判断两帧之间人有没有横向漂（见 face_anchor）。
"""
import sys

from PIL import Image

PW, PH = 380, 330
SEGS = (('上半身', 12, 160), ('腰腹', 160, 240), ('裙子以下', 240, 330))
HAIR_BANDS = (('发根25-70', 25, 70), ('上段70-120', 70, 120),
              ('中段120-180', 120, 180), ('发梢180-260', 180, 260))
MAX_DX = 40
BAND_MIN = 120          # 这一带头发权重之和低于它就说"没料"，不给数


def panels(path):
    im = Image.open(path).convert('RGBA')
    if im.size != (PW * 2, PH):
        raise SystemExit(f'✗ {path} 不是 {PW * 2}×{PH}：{im.size}')
    return im.crop((0, 0, PW, PH)), im.crop((PW, 0, PW * 2, PH))


def clamp01(v):
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def hair_weight(px):
    """这一像素"是冰蓝头发"的程度 0~1。

    冰蓝头发：偏蓝（b>r）但**不饱和**（比裙子那种矢车菊蓝淡得多）；白色衣服 b≈r 得 0，
    皮肤 b<r 得 0，裙子饱和度高得 0。用连续权重而不是硬阈值：发丝边缘是抗锯齿的，
    硬阈值会在两帧之间来回翻，把噪声量成位移（基准帧两帧的掩膜互换 27.3% 就是这么来的）。
    """
    r, g, b, a = px
    if a <= 128:
        return 0.0
    mx = max(r, g, b)
    mn = min(r, g, b)
    s = 0.0 if mx == 0 else (mx - mn) / float(mx)
    return clamp01((b - r) / 40.0) * clamp01((0.55 - s) / 0.25)


def weight_map(frame):
    p = frame.load()
    return [[hair_weight(p[x, y]) for x in range(PW)] for y in range(PH)]


def seg_diff(a, b):
    pa, pb = a.load(), b.load()
    out = []
    for label, y0, y1 in SEGS:
        both = moved = 0
        for y in range(y0, y1):
            for x in range(PW):
                ra, ga, ba, aa = pa[x, y]
                rb, gb, bb, ab = pb[x, y]
                if aa > 128 and ab > 128:
                    both += 1
                    if max(abs(ra - rb), abs(ga - gb), abs(ba - bb)) > 24:
                        moved += 1
        out.append((label, moved / float(both) * 100 if both else 0.0, both))
    return out


def band_stats(w, y0, y1, x0, x1, thresh=0.5):
    """带内的权重和、加权质心、外缘（权重>0.5 的最小/最大 x）。"""
    total = sum(w[y][x] for y in range(y0, y1) for x in range(x0, x1))
    sx = sum(w[y][x] * x for y in range(y0, y1) for x in range(x0, x1))
    xs = [x for y in range(y0, y1) for x in range(x0, x1) if w[y][x] > thresh]
    c = sx / total if total > 1e-9 else None
    return total, c, (min(xs) if xs else None), (max(xs) if xs else None)


def fmt(v, digits=1):
    return '—' if v is None else f'{v:+.{digits}f}'


def hair_table(wa, wb, title):
    """按横带量头发：整幅宽度的加权质心位移 + 该带头发轮廓的最左/最右外缘。

    质心位移＝帧2 减帧1，正数表示这一带的头发整体往右走了多少像素。
    "发根几乎不动、越往发梢位移越大"是甩出去；"发梢比中段位移小"是末端滞后。
    """
    print(f'  ——{title}——')
    print(f'  {"带":<14}{"质心位移":>9}{"帧1外缘":>14}{"帧2外缘":>14}{"位移/发根":>10}')
    root_shift = None
    for label, y0, y1 in HAIR_BANDS:
        ta, ca, la, ra = band_stats(wa, y0, y1, 0, PW)
        tb, cb, lb, rb_ = band_stats(wb, y0, y1, 0, PW)
        if ta + tb < BAND_MIN or ca is None or cb is None:
            print(f'  {label:<14}{"料太少":>9}')
            continue
        shift = cb - ca
        if root_shift is None:
            root_shift = shift
        rel = f'{shift - root_shift:+.1f}'
        e1 = f'[{la},{ra}]' if la is not None else '—'
        e2 = f'[{lb},{rb_}]' if lb is not None else '—'
        print(f'  {label:<14}{shift:>+9.1f}{e1:>14}{e2:>14}{rel:>10}')


def hair_change(wa, wb):
    """两帧头发权重的平均绝对变化——注意它有噪声底（基准自己量出来不是 0）。"""
    n = s = 0.0
    for y in range(PH):
        for x in range(PW):
            s += abs(wa[y][x] - wb[y][x])
            n += 1
    return s / n


def best_iou(wa, wb, y0, y1, x0, x1):
    """这一带两帧头发的最佳横向重合率（1=形状完全一样）。"""
    best = 0.0
    for dx in range(-MAX_DX, MAX_DX + 1):
        inter = union = 0.0
        for y in range(y0, y1):
            for x in range(x0, x1):
                va = wa[y][x]
                j = x + dx
                vb = wb[y][j] if x0 <= j < x1 else 0.0
                union += max(va, vb)
                inter += min(va, vb)
        if union > 1e-9:
            best = max(best, inter / union)
    return best


def leg_rows(f, ys=(250, 270, 290, 300, 310, 318)):
    p = f.load()
    out = []
    for y in ys:
        runs, start = [], None
        for x in range(PW):
            on = p[x, y][3] > 128
            if on and start is None:
                start = x
            elif not on and start is not None:
                runs.append((start, x - 1))
                start = None
        if start is not None:
            runs.append((start, PW - 1))
        out.append((y, runs))
    return out


def leg_swap(f, y_top=235, y_bot=300):
    """跑这类姿势的换腿判据：y_top 那行通常有两段（抬起的鞋 ＋ 踩地的腿），
    y_bot 那行只剩踩地的那条。用 x 区间是否重叠把两条认出来，再各给一个中心。

    为什么不用第十四节写的那条"y=300 的中心换到另一侧"：跑这一张的踩地腿本来就在
    身体中轴附近（帧1 x190、帧2 x184），两帧都不换边；它的"换脚"是靠**抬起的膝盖／鞋**
    从画面左边换到右边表现的（帧1 抬起鞋 x168.5、帧2 x203.5）。这条误差已写进报告。
    """
    p = f.load()

    def runs(y):
        out, start = [], None
        for x in range(PW):
            on = p[x, y][3] > 128
            if on and start is None:
                start = x
            elif not on and start is not None:
                out.append((start, x - 1))
                start = None
        if start is not None:
            out.append((start, PW - 1))
        return out

    top, bot = runs(y_top), runs(y_bot)
    if not bot:
        return None
    b0, b1 = bot[0][0], bot[-1][1]

    def overlap(r):
        return max(0, min(r[1], b1) - max(r[0], b0) + 1)

    if not top:
        return None
    best = max(top, key=overlap)
    others = [r for r in top if r is not best]
    planted = (best[0] + best[1]) / 2.0
    raised = None
    for r in others:
        if overlap(r) * 2 < (r[1] - r[0] + 1):      # 自己大半在踩地腿之外，才算"抬起的那条"
            raised = (r[0] + r[1]) / 2.0
    return planted, raised


def leg_cells(f, y=300):
    """y=300 那一行不透明段的中心（踩地那条腿）。"""
    p = f.load()
    runs, start = [], None
    for x in range(PW):
        on = p[x, y][3] > 128
        if on and start is None:
            start = x
        elif not on and start is not None:
            runs.append((start, x - 1))
            start = None
    if start is not None:
        runs.append((start, PW - 1))
    return [(f'{(a + b) / 2.0:.0f}', b - a + 1) for a, b in runs]


def face_anchor(f):
    """脸（肤色像素）的横向中位数 x —— 判断"两帧之间人物有没有横向漂"的锚点。

    只在不透明外框上 45% 那段里找：Q 版角色的头占上半身一大截，而手臂和拳头在更下面，
    把它们算进来会把锚点往握拳那一侧拽。取中位数而不是平均数，几个散点不影响它。

    九张冻结基准帧上，这个锚点两帧相差 0~1 像素（唯一例外是设计上就要前倾的冲刺，22）。
    "跑"被冻住的那版是 1，而按人物外框居中拼出来的候选版是 73——播起来整个角色在左右跳。
    所以这个数也是 whale-pair.py --anchor-head 的依据：超出口径就该停下来看拼接那一步。
    """
    box = f.getchannel('A').getbbox()
    if not box:
        return None
    p = f.load()
    y1 = box[1] + int((box[3] - box[1]) * 0.45)
    xs = []
    for y in range(box[1], y1):
        for x in range(box[0], box[2]):
            r, g, b, a = p[x, y]
            if a > 128 and r > 205 and g > 165 and b > 150 and (r - b) > 18 and (r - g) < 70:
                xs.append(x)
    if not xs:
        return None
    xs.sort()
    return xs[len(xs) // 2]


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    base_path, cand_path = sys.argv[1], sys.argv[2]
    ba, bb = panels(base_path)
    ca, cb = panels(cand_path)

    print(f'基准 {base_path}')
    print(f'候选 {cand_path}')
    print('【一】三段帧间差异（只统计两侧 alpha>128）')
    sb, sc = seg_diff(ba, bb), seg_diff(ca, cb)
    for (label, x, n), (_, y, m) in zip(sb, sc):
        fb = f'{y:5.1f}%' if m else ' 无重叠'
        nb = f'{x:5.1f}%' if n else ' 无重叠'
        print(f'  {label:<8} 基准 {nb}（分母 {n}）  候选 {fb}（分母 {m}）')
    print(f'  基准两帧都不透明 {sb[0][2] + 0} / 候选——')

    print('【二】头发（正数=往右移）')
    wa1, wa2 = weight_map(ba), weight_map(bb)
    wc1, wc2 = weight_map(ca), weight_map(cb)
    hair_table(wa1, wa2, '基准')
    hair_table(wc1, wc2, '候选')
    print(f'  头发权重平均绝对变化：基准 {hair_change(wa1, wa2):.4f}；候选 {hair_change(wc1, wc2):.4f}')
    for label, y0, y1 in HAIR_BANDS:
        ib = min(best_iou(wa1, wa2, y0, y1, 0, PW // 2), best_iou(wa1, wa2, y0, y1, PW // 2, PW))
        ic = min(best_iou(wc1, wc2, y0, y1, 0, PW // 2), best_iou(wc1, wc2, y0, y1, PW // 2, PW))
        print(f'  {label:<14} 最佳对齐后的剩余形状差：基准 {100 - ib * 100:5.1f}%  候选 {100 - ic * 100:5.1f}%')

    print('【三】腿：裙子以下各行不透明段（帧1 ｜ 帧2）')
    rb, rc = leg_rows(ba), leg_rows(ca)
    rb2, rc2 = leg_rows(bb), leg_rows(cb)
    for i, (y, r) in enumerate(rb):
        print(f'  y={y:<4}基准 {str(r):<26} {rb2[i][1]}')
    for i, (y, r) in enumerate(rc):
        print(f'  y={y:<4}候选 {str(r):<26} {rc2[i][1]}')
    print(f'  基准 y=300 中心/宽度: 帧1 {leg_cells(ba)}  帧2 {leg_cells(bb)}')
    print(f'  候选 y=300 中心/宽度: 帧1 {leg_cells(ca)}  帧2 {leg_cells(cb)}')
    for tag, f1, f2 in (('基准', ba, bb), ('候选', ca, cb)):
        s1, s2 = leg_swap(f1), leg_swap(f2)
        line = lambda s: '—' if not s else f'踩地 {s[0]} 抬起 {"—" if s[1] is None else s[1]}'
        print(f'  {tag} 换腿（y=235）: 帧1 {line(s1)} ｜ 帧2 {line(s2)}')

    print('【四】全身位置与尺寸')
    for tag, f in (('基准帧1', ba), ('基准帧2', bb), ('候选帧1', ca), ('候选帧2', cb)):
        bx = f.getchannel('A').getbbox()
        print(f'  {tag}: 外框 {bx} 宽 {bx[2] - bx[0]} 高 {bx[3] - bx[1]} 中心x {(bx[0] + bx[2]) / 2.0:.0f}')
    for tag, f1, f2 in (('基准', ba, bb), ('候选', ca, cb)):
        a1, a2 = face_anchor(f1), face_anchor(f2)
        if a1 is None or a2 is None:
            print(f'  {tag} 脸中心 x：认不出脸（肤色像素一片都没有），这一项没法判')
            continue
        d = a2 - a1
        flag = '  ← 超过 ±5：人物在两帧之间横向漂了（该不动的动作要回看拼接那一步；' \
               '冲刺那种整体前倾的属已知情况）' if abs(d) > 5 else ''
        print(f'  {tag} 脸中心 x：帧1 {a1}  帧2 {a2}  差 {d:+d}{flag}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
