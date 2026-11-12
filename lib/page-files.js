/**
 * 文件预览（2026-11-12 从 page-ui 拆出来）。
 *
 * 这一份只管"把文件变成能在手机上看的样子"：正文里点开的文件、发送前的预览、
 * 以及发送后附件里的 Word/Excel/PDF。**不碰聊天、不碰面板**——那些在 page-ui。
 *
 * 拆出来的理由很实在：这一块最近长得最快（docx/xlsx/pdf 三条路），
 * 和输入框、操作面板挤在一份里，改一处要翻很远。
 */

  // ---------- 正文里点开的文件（2026-11-03） ----------
  // 只读抽屉：点正文里的路径 → 取 /mini/file → 原文或图片。文本塞进 <pre> 的
  // textContent，不拼 HTML——文件内容是数据，不是模板。
  var fileViewText = '';

  function closeFileView() {
    $('fileView').classList.remove('open');
    fileViewText = '';
  }

  function openFileView(path) {
    var panel = $('fileView');
    var body = $('fileBody');
    var title = $('fileTitle');
    fileViewText = '';
    title.textContent = String(path).split(/[\\/]/).pop() || '文件';
    body.innerHTML = '<div class="file-note">正在读取…</div>';
    panel.classList.add('open');
    fetch('/mini/file?p=' + encodeURIComponent(path), { credentials: 'same-origin' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (res) {
        if (!res.ok || !res.j || res.j.ok !== true) {
          body.innerHTML = '<div class="file-note">'
            + escapeHtml((res.j && res.j.error) || '读不到这个文件') + '</div>';
          return;
        }
        title.textContent = res.j.name || title.textContent;
        if (/\.(png|jpe?g|webp|gif|svg)$/i.test(res.j.name || path)) {
          body.innerHTML = '<img class="file-img" src="' + imageSrc(String(path)) + '" alt="">';
          return;
        }
        if (res.j.pdf) { showPdf(path, res.j.name || path, body); return; }
        fileViewText = String(res.j.text || '');
        var note = res.j.kind ? '<div class="file-note">已从 '
          + (res.j.kind === 'xlsx' ? 'Excel' : 'Word') + ' 里取出文字，只显示内容、不还原排版。</div>' : '';
        body.innerHTML = note + fileRenderHtml(res.j.name || path, fileViewText);
      })
      .catch(function () {
        body.innerHTML = '<div class="file-note">连不上电脑，稍后再试。</div>';
      });
  }


  function previewUpload(i) {
    var f = (state.uploads || [])[Number(i)];
    if (!f || !f.file) { toast('这个文件在电脑上，手机上不留副本'); return; }
    if (/^image\//.test(f.file.type || '')) { openImgView(URL.createObjectURL(f.file)); return; }
    // 文本预览是整份读进内存的：太大就别读，免得手机卡住。
    if (f.file.size > 2 * 1024 * 1024) { toast('文件太大，手机上不预览'); return; }
    var name = f.name || '';
    if (/\.docx$/i.test(name)) { previewDocx(f); return; }
    if (/\.pdf$/i.test(name)) { previewPdf(f); return; }
    if (!ATTACH_TEXT_NAME.test(name)) { toast('这个格式手机上不能预览，去电脑上看原件'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      showFileText(name || '文件', String(reader.result || ''));
    };
    reader.onerror = function () { toast('这个文件读不出来'); };
    reader.readAsText(f.file);
  }
  /** PDF：电脑浏览器能画，安卓 WebView 画不了。 */
  function showPdf(path, name, body) {
    renderPdfInto(body, { url: '/mini/file?raw=1&p=' + encodeURIComponent(path), withCredentials: true }, name);
  }
  function showFileText(title, text) {
    var body = $('fileBody'), head = $('fileTitle'), panel = $('fileView');
    if (!body || !panel) return;
    if (head) head.textContent = title;
    body.innerHTML = '<pre class="file-pre">' + escapeHtml(text) + '</pre>';
    panel.classList.add('open');
  }
  /** PDF（还没发出去的文件）：本地字节直接交给 PDF.js，不用先传。 */
  function previewPdf(f) {
    var panel = $('fileView'), body = $('fileBody'), title = $('fileTitle');
    if (!body || !panel) return;
    if (title) title.textContent = f.name || 'PDF';
    panel.classList.add('open');
    body.innerHTML = '<div class="file-note">正在渲染…</div>';
    f.file.arrayBuffer()
      .then(function (buf) { renderPdfInto(body, { data: buf }, f.name || 'PDF'); })
      .catch(function () { body.innerHTML = '<div class="file-note">这个 PDF 读不出来。</div>'; });
  }
  /** docx（还没发出去的文件）：拆出 document.xml，去掉标签只留文字。 */
  function previewDocx(f) {
    showFileText(f.name || '文件', '正在解析…');
    docxToText(f.file).then(function (text) {
      fileViewText = text;
      showFileText(f.name || '文件', text || '（这个文档里没有文字）');
    }).catch(function (err) {
      var body = $('fileBody');
      if (body) body.innerHTML = '<div class="file-note">'
        + escapeHtml('这个 Word 文档打不开：' + ((err && err.message) || '格式不支持')) + '。去电脑上看原件。</div>';
    });
  }
  async function docxToText(file) {
    var buf = new Uint8Array(await file.arrayBuffer());
    var view = new DataView(buf.buffer);
    var eocd = -1;
    for (var i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 docx');
    var n = view.getUint16(eocd + 10, true), p = view.getUint32(eocd + 16, true);
    for (var k = 0; k < n; k++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      var method = view.getUint16(p + 10, true), csize = view.getUint32(p + 20, true);
      var nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true);
      var commentLen = view.getUint16(p + 32, true), localOff = view.getUint32(p + 42, true);
      var entry = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
      if (entry === 'word/document.xml') {
        var start = localOff + 30 + view.getUint16(localOff + 26, true) + view.getUint16(localOff + 28, true);
        var data = buf.subarray(start, start + csize);
        if (method !== 0) {
          if (typeof DecompressionStream !== 'function') throw new Error('这台手机的浏览器不支持解压 docx');
          data = new Uint8Array(await new Response(
            new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
        }
        return new TextDecoder().decode(data)
          .replace(/<w:tab[^>]*\/>/g, '\t')
          .replace(/<w:br[^>]*\/>/g, '\n')
          .replace(/<\/w:p>/g, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
          .replace(/\n{3,}/g, '\n\n').trim();
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error('这个 docx 里没有正文');
  }
  // ---------- 轨迹详情里的附件原件（2026-11-05） ----------
  // 图片全屏看；文本类进只读抽屉；其余如实说手机上打不开，不假装支持。
  var ATTACH_TEXT_NAME = /\.(md|markdown|txt|log|json|jsonc|ya?ml|toml|ini|conf|cfg|js|mjs|cjs|ts|tsx|jsx|vue|css|scss|less|html?|xml|svg|csv|tsv|py|sh|ps1|bat|cmd|rs|go|java|kt|kts|c|h|cpp|hpp|hh|sql)$/i;

  /** 附件的 Word/Excel：让电脑取字（手机解不动）。 */
  function openOfficeAttachment(id, name) {
    var panel = $('fileView'), body = $('fileBody'), title = $('fileTitle');
    fileViewText = '';
    if (title) title.textContent = name || '附件';
    if (panel) panel.classList.add('open');
    if (body) body.innerHTML = '<div class="file-note">正在解析…</div>';
    var url = '/mini/api/attachment-text?sessionId=' + encodeURIComponent(state.boundSessionId || '')
      + '&id=' + encodeURIComponent(id);
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (!j || j.ok !== true) {
          if (body) body.innerHTML = '<div class="file-note">' + escapeHtml((j && j.error) || '读不出这个文件') + '</div>';
          return;
        }
        fileViewText = String(j.text || '');
        var note = '<div class="file-note">已从 ' + (j.kind === 'xlsx' ? 'Excel' : 'Word')
          + ' 里取出文字，只显示内容、不还原排版。</div>';
        if (body) body.innerHTML = note + fileRenderHtml(j.name || name, fileViewText);
      })
      .catch(function () { if (body) body.innerHTML = '<div class="file-note">连不上电脑，稍后再试。</div>'; });
  }
  /** 附件的 PDF：电脑浏览器能画，安卓 WebView 画不了。 */
  function openPdfAttachment(id, name) {
    var panel = $('fileView'), body = $('fileBody'), title = $('fileTitle');
    if (title) title.textContent = name || 'PDF';
    if (panel) panel.classList.add('open');
    if (!body) return;
    renderPdfInto(body, { url: attachmentUrl(id), withCredentials: true }, name || 'PDF');
  }
  /** 在页面里把 PDF 画出来：安卓 WebView 自己不画，所以统一用 PDF.js 画到 canvas（2026-11-12）。 */
  function renderPdfInto(body, source, name) {
    body.innerHTML = '<div class="file-note">正在渲染 PDF…</div>';
    loadPdfJs().then(function (pdfjs) {
      return pdfjs.getDocument(source).promise;
    }).then(function (doc) {
      body.innerHTML = '';
      var pages = doc.numPages;
      var wrap = document.createElement('div');
      wrap.className = 'pdf-pages';
      var note = document.createElement('div');
      note.className = 'file-note';
      note.textContent = '共 ' + pages + ' 页' + (pages > PDF_FIRST_PAGES ? '，先显示前 ' + PDF_FIRST_PAGES + ' 页' : '');
      body.appendChild(wrap);
      body.appendChild(note);
      var shown = 0;
      function drawNext() {
        if (shown >= pages) return Promise.resolve();
        shown++;
        return doc.getPage(shown).then(function (page) {
          var vp1 = page.getViewport({ scale: 1 });
          var viewport = page.getViewport({ scale: Math.min(2, (body.clientWidth || 360) / vp1.width) });
          var canvas = document.createElement('canvas');
          canvas.width = viewport.width; canvas.height = viewport.height; canvas.className = 'pdf-page';
          wrap.appendChild(canvas);
          return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
        });
      }
      var chain = Promise.resolve();
      for (var i = 0; i < Math.min(pages, PDF_FIRST_PAGES); i++) chain = chain.then(drawNext);
      return chain.then(function () {
        if (pages <= PDF_FIRST_PAGES) return;
        var more = document.createElement('button');
        more.className = 'btn';
        more.textContent = '继续看后面的 ' + (pages - PDF_FIRST_PAGES) + ' 页';
        more.addEventListener('click', function () {
          more.remove();
          var c = Promise.resolve();
          for (var k = PDF_FIRST_PAGES; k < pages; k++) c = c.then(drawNext);
        });
        body.appendChild(more);
      });
    }).catch(function (err) {
      body.innerHTML = '<div class="file-note">这个 PDF 打不开：'
        + escapeHtml((err && err.message) || '格式不支持') + '。去电脑上看原件。</div>';
    });
  }

  /** PDF.js 只取一次；第一次点 PDF 时加载。 */
  var PDF_FIRST_PAGES = 3, pdfjsPromise = null;
  function loadPdfJs() {
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = '/mini/vendor/pdfjs/pdf.min.js';
      script.onload = function () {
        try {
          var lib = window.pdfjsLib;
          if (!lib) throw new Error('PDF.js 没加载上');
          lib.GlobalWorkerOptions.workerSrc = '/mini/vendor/pdfjs/pdf.worker.min.js';
          resolve(lib);
        } catch (err) { reject(err); }
      };
      script.onerror = function () { reject(new Error('取不到 PDF.js')); };
      document.head.appendChild(script);
    });
    return pdfjsPromise;
  }
