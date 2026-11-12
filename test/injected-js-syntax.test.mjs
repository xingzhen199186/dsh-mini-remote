import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 注入到网页里的那几段 JS，编译期查不出错——Java 字符串语法永远是对的。
 * 只有真的在手机上跑起来才会发现：一段报错，整块界面就不渲染，
 * 用户看到的是"设置页里那些行凭空消失了"（2026-11-12 真机）。
 *
 * 这个测试把 Java 里的字符串拼回 JS，再交给引擎解析。
 */

const SOURCE = new URL('../android/app/src/main/java/com/dsh/miniremote/MainActivity.java', import.meta.url)

function unescapeJava(value) {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c !== '\\') { out += c; continue }
    const n = value[i + 1]
    if (n === 'n') { out += '\n'; i++ }
    else if (n === 't') { out += '\t'; i++ }
    else if (n === 'r') { out += '\r'; i++ }
    else if (n === '"') { out += '"'; i++ }
    else if (n === '\\') { out += '\\'; i++ }
    else if (n === 'u') { out += String.fromCharCode(parseInt(value.substr(i + 2, 4), 16)); i += 5 }
    else { out += n; i++ }
  }
  return out
}

/** 把 `private static final String NAME = "..." + "..." ;` 拼成真实脚本，跳过 Java 注释。 */
function extract(source, name) {
  const marker = `private static final String ${name} = `
  const start = source.indexOf(marker)
  if (start < 0) return null
  const end = source.indexOf(';\n', start)
  const expr = source.slice(start + marker.length, end)
  let out = ''
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]
    if (c === '/' && expr[i + 1] === '/') { while (i < expr.length && expr[i] !== '\n') i++; continue }
    if (c === '/' && expr[i + 1] === '*') {
      i += 2
      while (i < expr.length && !(expr[i] === '*' && expr[i + 1] === '/')) i++
      i++
      continue
    }
    if (c === '"') {
      let j = i + 1
      let literal = ''
      while (j < expr.length) {
        if (expr[j] === '\\') { literal += expr[j] + expr[j + 1]; j += 2; continue }
        if (expr[j] === '"') break
        literal += expr[j]; j++
      }
      out += unescapeJava(literal)
      i = j
    }
  }
  return out
}

const source = readFileSync(SOURCE, 'utf8')

test('注入到网页里的脚本必须是合法的 JS', () => {
  for (const name of ['BRIDGE_UI_JS', 'SETTINGS_UI_JS', 'BACK_UI_JS']) {
    const code = extract(source, name)
    assert.ok(code && code.length > 100, `${name} 没找到或太短`)
    assert.doesNotThrow(() => new Function(code), `${name} 有语法错误，注入后会整块不渲染`)
  }
})

test('注入脚本里不许出现能截断字符串的裸单引号', () => {
  // 2026-11-12 真机：指引里写了 echo 'allow-external-apps = true'，
  // 单引号落在单引号包裹的字符串里，把整段探测脚本截断，手机桥与屏幕操作整块消失。
  // 现在那段指引挪去了别处，但这条规矩要留着：命令里的单引号必须写成 &#39; 或转义。
  const code = extract(source, 'BRIDGE_UI_JS')
  assert.doesNotMatch(code, /echo '[^']*'/, '命令里的单引号要转义或写成实体')
})
