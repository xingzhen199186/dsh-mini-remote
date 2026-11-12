# PDF.js（第三方，Apache License 2.0）

手机上的 WebView 不会自己渲染 PDF，所以把这个库发给手机，在页面里把每一页画到 canvas 上。

- 来源：<https://github.com/mozilla/pdf.js>，npm 包 `pdfjs-dist@3.11.174` 的 **legacy build**
  （选 legacy 是因为老 WebView 认不了新版 的模块语法）。
- 本目录只有两个运行时文件：`pdf.min.js`、`pdf.worker.min.js`，由 `/mini/vendor/pdfjs/` 这条路由发出。
- 许可：Apache License 2.0，全文见仓库根目录的 `android/licenses/APACHE-2.0.txt`。
- 升级方式：换掉这两个文件即可，不用改代码；文件名不带版本号，所以路由上给了长缓存，
  **换文件后必须重启**才会生效。
