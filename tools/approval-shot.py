# -*- coding: utf-8 -*-
"""给审批卡出图：390x844，深浅各一张。

和 I:\DSH\make-ui-shots.py 同一套路（Chrome 无头窗口最小 500px，用 iframe 框出 390 宽，
截图后裁掉），但只渲染审批卡这一屏。样式**从真页面里取**，所以主题令牌、圆角、主按钮
颜色都是产品代码里那一份，不是抄的。
"""
import os
import subprocess
import tempfile
from PIL import Image

SRC = r"I:\极简遥控器\极简遥控器\lib\page.html"
OUT = r"I:\极简遥控器\极简遥控器\docs"
# 渲染用的包装页面是中间件，不是产物：放系统临时目录，别在 docs/ 里留垃圾。
# 2026-09-27 踩过一次——手动删了之后重跑又生成，因为清理靠人手，不靠工具。
TMP = os.path.join(tempfile.gettempdir(), 'approval-shot')
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
W, H = 390, 844

html = open(SRC, encoding='utf-8').read()
style = html[html.index('<style>') + len('<style>'):html.index('</style>')]

CARD = """<div id="approveCard" class="on">
  <div class="ahead">电脑被拦下来了，等你拍板</div>
  <div class="atool">它要让「pwsh」动手</div>
  <div class="areason">这条命令会动到工作区以外的文件，要你点头才跑。</div>
  <div class="acmd">Remove-Item -Recurse -Force I:\\DSH\\tmp-build
New-Item -ItemType Directory I:\\DSH\\tmp-build</div>
  <div class="afoot">
    <button id="approveDeny" type="button">拒绝</button>
    <button id="approveAllow" type="button">同意</button>
  </div>
</div>"""

WRAP = """<!doctype html><html lang="zh-CN"__THEME__><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>measuring</title><style>__STYLE__</style></head>
<body>__CARD__</body></html>"""

FRAME = """<!doctype html><html><head><meta charset="utf-8"><title>measuring</title>
<style>html,body{margin:0;background:#000;overflow:hidden}
iframe{border:0;display:block;width:__W__px;height:__H__px}</style></head>
<body><iframe id="f" src="__SRC__"></iframe></body></html>"""

os.makedirs(OUT, exist_ok=True)
os.makedirs(TMP, exist_ok=True)
for name, theme in (('approval-card-dark', ''), ('approval-card-light', ' data-theme="light"')):
    open(os.path.join(TMP, name + '.html'), 'w', encoding='utf-8').write(
        WRAP.replace('__STYLE__', style).replace('__CARD__', CARD).replace('__THEME__', theme))
    open(os.path.join(TMP, 'frame-' + name + '.html'), 'w', encoding='utf-8').write(
        FRAME.replace('__SRC__', name + '.html').replace('__W__', str(W)).replace('__H__', str(H)))
    png = os.path.join(OUT, name + '.png')
    url = 'file:///' + os.path.join(TMP, 'frame-' + name + '.html').replace('\\', '/')
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
                    '--allow-file-access-from-files', '--force-device-scale-factor=2',
                    '--virtual-time-budget=3000', '--window-size=500,%d' % H,
                    '--screenshot=' + png, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.path.exists(png):
        im = Image.open(png)
        im.crop((0, 0, W * 2, min(H * 2, im.height))).save(png)
        # 顺手出一份手机通道能认的 webp。页面只认 /mini/art/<小写字母数字连字符>.webp、
        # 名字以 out- 开头（lib/art/.npmignore 写明这类不进发布包）。
        # **少了这一步，就会出现"电脑上看得到、手机上是个破图标"**——2026-09-27 报过一次。
        im.convert('RGB').save(
            r"I:\极简遥控器\极简遥控器\lib\art\out-" + name + ".webp", 'WEBP', quality=90, method=6)
    print('%-22s 手机版已出' % name)