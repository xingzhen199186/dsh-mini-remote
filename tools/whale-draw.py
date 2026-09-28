#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""直连 OpenRouter 出一张图，**可以带参考图**——本仓库立绘重画的自用工具。

用法：
    python tools/whale-draw.py --prompt 提示词.txt --out 输出.png
    python tools/whale-draw.py --ref 参考图.png --prompt 提示词.txt --out 输出.png

为什么不用插件里的 edit_image：dsh-image-gen 的编辑路固定 POST 到
`<baseURL>/images/edits`，而 OpenRouter 没有这条路由（实测 404）。它的出图路
`/images/generations` 支持参考图，字段名是 `input_references`（实测：带这个字段时
模型会保住参考图的形状，只改提示词要求的部分；换成 `input_images` 会被忽略，
退化成纯文本出图）。所以这里自己打这个接口。

密钥从哪儿来：先看环境变量 OPENROUTER_API_KEY，没有就读 DSH 的 profile 配置
（~/.dsh/profiles/web/cordis.patch.yml 里的 openrouterKey）。只在这一进程里用，
不写文件、不回显、不打印。

模型与尺寸可用 --model / --size 覆盖，默认与插件里配的那条一致。
"""
import argparse
import base64
import json
import os
import re
import sys
import urllib.request

DEFAULT_MODEL = 'openai/gpt-image-2.5-sunburst'
ENDPOINT = 'https://openrouter.ai/api/v1/images/generations'
PATCH = os.path.join(os.path.expanduser('~'), '.dsh', 'profiles', 'web', 'cordis.patch.yml')


def api_key():
    key = os.environ.get('OPENROUTER_API_KEY', '').strip()
    if key:
        return key, '环境变量 OPENROUTER_API_KEY'
    try:
        text = open(PATCH, encoding='utf-8').read()
    except OSError as error:
        raise SystemExit(f'读不到 {PATCH}：{error}\n请设 OPENROUTER_API_KEY 后重试')
    found = re.search(r'openrouterKey:\s*(\S+)', text)
    if not found:
        raise SystemExit(f'{PATCH} 里没有 openrouterKey，请设 OPENROUTER_API_KEY 后重试')
    return found.group(1), PATCH


def data_url(path):
    with open(path, 'rb') as handle:
        blob = handle.read()
    ext = os.path.splitext(path)[1].lower()
    mime = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.webp': 'image/webp'}.get(ext)
    if mime is None:
        raise SystemExit(f'参考图只支持 png/jpg/webp：{path}')
    return f'data:{mime};base64,{base64.b64encode(blob).decode("ascii")}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', action='append', default=[], help='参考图，可重复给多张')
    ap.add_argument('--prompt', required=True, help='提示词文件（UTF-8 纯文本）')
    ap.add_argument('--out', required=True, help='输出 png 路径')
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--size', default='1024x1024')
    args = ap.parse_args()

    prompt = open(args.prompt, encoding='utf-8').read().strip()
    if not prompt:
        raise SystemExit('提示词文件是空的')

    body = {'model': args.model, 'prompt': prompt, 'size': args.size}
    if args.ref:
        body['input_references'] = [
            {'type': 'image_url', 'image_url': {'url': data_url(p)}} for p in args.ref
        ]

    key, source = api_key()
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body).encode('utf-8'),
        headers={'authorization': f'Bearer {key}', 'content-type': 'application/json'},
        method='POST',
    )
    print(f'  请求：{args.model}，参考图 {len(args.ref)} 张，密钥来自 {source}')
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            payload = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as error:
        detail = error.read().decode('utf-8', 'replace')[:400]
        raise SystemExit(f'✗ HTTP {error.code}：{detail}')

    items = payload.get('data') or []
    if not items:
        raise SystemExit('✗ 没拿到图：' + json.dumps(payload)[:400])
    first = items[0]
    if first.get('b64_json'):
        blob = base64.b64decode(first['b64_json'])
    elif first.get('url'):
        with urllib.request.urlopen(first['url'], timeout=300) as image:
            blob = image.read()
    else:
        raise SystemExit('✗ 返回里既没有 b64_json 也没有 url')
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'wb') as handle:
        handle.write(blob)
    usage = payload.get('usage')
    print(f'  ✓ {args.out}（{len(blob) / 1024:.0f} KB）' + (f' 用量 {usage}' if usage else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
