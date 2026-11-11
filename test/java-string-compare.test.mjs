import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 静态检查：Java 里不许用 == / != 比较字符串。
 *
 * 为什么单独做这一条（2026-11-12）：`card.mode == ConfirmationState.TASK` 比的是对象，
 * 而档位每次都是从设置里读出来的新对象，条件永远为假——"允许"只放行一次、不记授权，
 * 表现为每步都弹卡。这类错误不报错、不崩，只是**静静地永远不成立**，靠读代码很容易漏。
 */

const SRC = 'android/app/src'

function javaFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...javaFiles(full))
    else if (name.endsWith('.java')) out.push(full)
  }
  return out
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
}

test('Java 源码里没有用 == / != 比较字符串', () => {
  const offenders = []
  for (const file of javaFiles(SRC)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    // 收集声明过的类型，按名字判断是不是字符串
    const types = new Map()
    for (const m of text.matchAll(/\b(String|int|long|boolean|double|float|char|byte|short)\s+([A-Za-z_]\w*)\s*[;=,)]/g)) {
      if (!types.has(m[2])) types.set(m[2], m[1])
    }
    text.split('\n').forEach((line, index) => {
      for (const m of line.matchAll(/([A-Za-z_][\w.]*)\s*(==|!=)\s*([A-Za-z_][\w.]*)/g)) {
        const [, a, op, b] = m
        if (a === 'null' || b === 'null' || b === 'true' || b === 'false') continue
        const ta = types.get(a.split('.').pop())
        const tb = types.get(b.split('.').pop())
        if (ta === 'String' || tb === 'String') {
          offenders.push(`${file}:${index + 1}  ${line.trim()}`)
        }
      }
    })
  }
  assert.deepEqual(offenders, [], `字符串必须用 equals 比较：\n${offenders.join('\n')}`)
})
