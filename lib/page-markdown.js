/**
 * Markdown 渲染（2026-11-12 从 page-core 拆出来）。
 *
 * 手写的最小实现，不引依赖——页面是单文件、免构建的，不能有打包步骤。
 * 顺序要求：**先转义，再上标签**，模型的输出一律当数据看待。
 * 这一块是全部渲染的地基：聊天、轨迹、文件预览都走它。
 */

  // ---------------- Markdown 渲染 ----------------
  // 手写的最小实现，不引依赖（这个页面是单文件、免构建的）。
  //
  // 顺序不能换：**先转义，再上标签**。模型吐出来的东西一律当纯文本，
  // 只把它写成的那几种语法变成 HTML——绝不让原文里的标签生效。
  // 认不出来的语法原样留着：宁可少渲染，不能吃掉内容。
  var CODE_SLOT = '\u0000';

  /**
   * 正文里的图片地址 → 真正去取的地址。三种写法见下面 mdInline 那段注释。
   *
   * 判据只有一条：**不是 http(s) 就走同源**。所以 `javascript:`、`data:` 这类
   * 永远不会出现在 src 里；认不出的地址最多是取回来 404，不会变成别的东西。
   *
   * 放在这里而不是立绘那一段（artUrl 旁边）：页面测试是从 escapeHtml 抠到复制按钮
   * 那一小段的，放外面就测不到真代码了。
   */
  function imageSrc(src) {
    if (/^https?:\/\//i.test(src)) return src;
    var name = src.replace(/\\/g, '/').replace(/^\.\//, '');
    if (/^lib\/art\//i.test(name)) name = name.slice(8);
    if (/^[a-z0-9-]+(\.webp)?$/i.test(name)) return artUrl(name.replace(/(\.webp)?$/i, ''));
    // **不拼令牌**：这条路和别的接口一样，靠浏览器自动带上的设备 cookie 认人。
    return '/mini/art/?p=' + encodeURIComponent(src);
  }

  /** 正文里哪些行内代码算"一个文件"：有白名单里的扩展名，且不是命令/通配符。 */
  var FILE_EXT_RE = /\.(md|markdown|txt|log|json|jsonc|yml|yaml|toml|ini|conf|cfg|js|mjs|cjs|ts|tsx|jsx|vue|css|scss|less|html|htm|xml|svg|csv|tsv|py|sh|ps1|bat|cmd|rs|go|java|kt|kts|c|h|cpp|hpp|hh|sql|png|jpe?g|webp|gif)$/i;

  function isFilePath(code) {
    var s = String(code).trim();
    if (!s || s.length > 300) return false;
    // 通配符、重定向、引号、命令拼接里的东西一律不算路径——那些是命令，不是文件。
    if (/[*?[\]{}<>"'`|$]/.test(s)) return false;
    if (!FILE_EXT_RE.test(s)) return false;
    return /[\\/]/.test(s) || /^[A-Za-z0-9._-]+$/.test(s);
  }

  /** 可点的文件：label 已经渲染好（行内代码那段传的是 <code>…</code>）。 */
  function fileLink(path, label) {
    return '<button type="button" class="file-link" data-file="' + path + '">' + (label || path) + '</button>';
  }

  /** 文件抽屉里怎么显示：Markdown 走渲染，其余走等宽原文（原文必须转义，内容是数据不是模板）。 */
  function fileRenderHtml(name, text) {
    var body = String(text || '');
    var empty = body ? '' : '（这个文件是空的）';
    if (/\.(md|markdown)$/i.test(String(name || ''))) {
      return '<div class="md file-md">' + mdToHtml(body || empty) + '</div>';
    }
    return '<pre class="file-text">' + escapeHtml(body || empty) + '</pre>';
  }

  function mdInline(raw) {
    // 行内代码先挖出来换成占位符。不这么做的话，`**x**` 这种字面量
    // 会被后面的粗体规则吃掉，代码里写的东西就显示错了。
    var codes = [];
    var out = escapeHtml(raw).replace(/`([^`]+)`/g, function (_, code) {
      codes.push(code);
      return CODE_SLOT + (codes.length - 1) + CODE_SLOT;
    });
    out = out
      // 图片：![说明](地址)。地址三种写法，判断在 imageSrc 里——
      //   ① 完整 http(s) 链接：原样用，手机直接去那个网站取图；
      //   ② 一个名字（如 out-demo，`.webp` 可带可不带）：走立绘通道 /mini/art/<名字>.webp，
      //      只认 lib/art/ 下「小写字母数字连字符 + .webp」的文件名；写成
      //      `lib/art/out-demo.webp` 这样带前缀的也认（2026-09-28 助手这么写过，手机上成了破图标）；
      //   ③ 电脑上一张图的位置（绝对路径，或相对项目根）：走 /mini/art/?p=…，PNG/JPG/WEBP/GIF 都行，
      //      不要求先拷进 lib/art。
      // 三者之外的一律按 ③ 拼成同源路径，所以 `javascript:`、`data:` 这类进不了 src。
      // 必须排在下面那条链接规则前面：否则 `![x](y)` 里的 `[x](y)` 会先被链接规则
      // 吃掉，只剩下一个光秃秃的感叹号。
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, alt, src) {
        return '<img class="md-img" src="' + imageSrc(src) + '" alt="' + alt + '"'
          + ' loading="lazy" referrerpolicy="no-referrer">';
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, label, target) {
        // http(s) 还是外链；其余一律当成电脑上的文件——点开是只读抽屉，不是跳转。
        if (/^https?:\/\//i.test(target)) {
          return '<a href="' + target + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
        }
        return fileLink(target, label);
      })
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
        '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    return out.replace(new RegExp(CODE_SLOT + '(\\d+)' + CODE_SLOT, 'g'), function (_, i) {
      var code = codes[+i];
      if (isFilePath(code)) return fileLink(code, '<code>' + code + '</code>');
      return '<code>' + code + '</code>';
    });
  }

  function codeBlock(raw, lang) {
    // data-copy 里放转义后的原文，读回来时浏览器会自动还原成原始字符。
    var attr = escapeHtml(raw);
    return '<div class="code"><div class="code-head">'
      + (lang ? '<span class="lang">' + escapeHtml(lang) + '</span>' : '<span></span>')
      + '<button class="copy" type="button" aria-label="复制代码" title="复制代码"'
      + ' data-copy="' + attr + '">' + ICON_COPY + '</button></div>'
      + '<pre><code>' + attr + '</code></pre></div>';
  }

  function isBlockStart(line) {
    return /^\s*```/.test(line)
      || /^\s*#{1,6}\s/.test(line)
      || /^\s*[-*+]\s/.test(line)
      || /^\s*\d+[.)]\s/.test(line)
      || /^\s*>/.test(line)
      || /^\s*\|/.test(line)
      || /^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line);
  }

  function mdToHtml(src) {
    var lines = String(src).split('\n');
    var html = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];

      // 围栏代码块：内容只转义，不走行内规则
      var fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        var buf = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1; }
        i += 1;
        html.push(codeBlock(buf.join('\n'), fence[1]));
        continue;
      }

      if (!line.trim()) { i += 1; continue; }

      var h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        var n = h[1].length;
        html.push('<h' + n + '>' + mdInline(h[2]) + '</h' + n + '>');
        i += 1;
        continue;
      }

      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { html.push('<hr>'); i += 1; continue; }

      if (/^\s*[-*+]\s+/.test(line)) {
        var ul = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          ul.push('<li>' + mdInline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>');
          i += 1;
        }
        html.push('<ul>' + ul.join('') + '</ul>');
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        var ol = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          ol.push('<li>' + mdInline(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>');
          i += 1;
        }
        html.push('<ol>' + ol.join('') + '</ol>');
        continue;
      }

      if (/^\s*>/.test(line)) {
        var quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        html.push('<blockquote>' + mdToHtml(quote.join('\n')) + '</blockquote>');
        continue;
      }

      // 表格：当前行是 | … |，下一行是 |---|---| 这种分隔行
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        var cells = function (l) {
          return l.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); });
        };
        var head = cells(line);
        i += 2;
        var body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body.push(cells(lines[i])); i += 1; }
        html.push('<table><thead><tr>'
          + head.map(function (c) { return '<th>' + mdInline(c) + '</th>'; }).join('')
          + '</tr></thead><tbody>'
          + body.map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + mdInline(c) + '</td>'; }).join('') + '</tr>';
          }).join('')
          + '</tbody></table>');
        continue;
      }

      // 段落：连续的非空、非块起始行合成一段
      var para = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { para.push(lines[i]); i += 1; }
      html.push('<p>' + para.map(mdInline).join('<br>') + '</p>');
    }
    return html.join('');
  }

  // 复制。navigator.clipboard 要求安全上下文（HTTPS），手机走局域网明文 HTTP 时
  // 它是 undefined——所以必须有 execCommand 这条退路，否则按钮点下去毫无反应。
