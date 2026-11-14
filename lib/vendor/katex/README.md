# KaTeX（第三方，MIT License）

手机上看公式用。页面里第一次遇到公式才加载，不拖慢首屏。

- 来源：<https://github.com/KaTeX/KaTeX>，npm 包 `katex@0.16.11` 的 `dist/`
- 只有三类文件：`katex.min.js`、`katex.min.css`、`fonts/KaTeX_*.woff2|woff`
- 由 `/mini/vendor/katex/` 这条路由发出（**白名单 + 不许出现 `..`**）
- 许可：MIT，见 <https://github.com/KaTeX/KaTeX/blob/main/LICENSE>
- 升级：换掉这些文件即可，不用改代码；**换了要重启 DSH**（路由会按名字缓存）
