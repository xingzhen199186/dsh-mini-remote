/**
 * 改动对照（2026-11-14）。
 *
 * 工具行原来只把参数原样铺出来：`old_string` 和 `new_string` 两段长文本挨着放，
 * 想看出"到底改了什么"得自己在两段里来回找。这里把它画成**增删对照**：
 * 删掉的标红、加上的标绿，没动的照常。
 *
 * 用的是最朴素的行级最长公共子序列——够用，而且不会像字符级 diff 那样
 * 把一行中文碎成看不清的片段。
 */

/** 参与比较的行数上限：超过就只比开头这么多，如实告诉调用方"被截了"。 */
var DIFF_MAX_LINES = 400

function diffLines(oldText, newText) {
  var a = String(oldText == null ? '' : oldText).split('\n')
  var b = String(newText == null ? '' : newText).split('\n')
  var cut = false
  if (a.length > DIFF_MAX_LINES) { a = a.slice(0, DIFF_MAX_LINES); cut = true }
  if (b.length > DIFF_MAX_LINES) { b = b.slice(0, DIFF_MAX_LINES); cut = true }

  // LCS 表：行数上限 400，表最多 16 万格，手机上算得动。
  var n = a.length, m = b.length
  var table = []
  for (var i = 0; i <= n; i++) table.push(new Array(m + 1).fill(0))
  for (var i2 = n - 1; i2 >= 0; i2--) {
    for (var j2 = m - 1; j2 >= 0; j2--) {
      table[i2][j2] = a[i2] === b[j2]
        ? table[i2 + 1][j2 + 1] + 1
        : Math.max(table[i2 + 1][j2], table[i2][j2 + 1])
    }
  }

  var rows = []
  var x = 0, y = 0
  while (x < n && y < m) {
    if (a[x] === b[y]) { rows.push({ type: 'same', text: a[x] }); x++; y++ }
    else if (table[x + 1][y] >= table[x][y + 1]) { rows.push({ type: 'del', text: a[x] }); x++ }
    else { rows.push({ type: 'add', text: b[y] }); y++ }
  }
  while (x < n) { rows.push({ type: 'del', text: a[x] }); x++ }
  while (y < m) { rows.push({ type: 'add', text: b[y] }); y++ }
  return { rows: rows, cut: cut }
}

/** 从工具参数里认出一对"改前 / 改后"；认不出来返回 null。 */
function editPair(rawArgs) {
  var a = rawArgs
  if (typeof rawArgs === 'string') {
    try { a = JSON.parse(rawArgs) } catch (err) { return null }
  }
  if (!a || typeof a !== 'object') return null
  var pairs = [
    ['old_string', 'new_string'],
    ['oldText', 'newText'],
    ['old_str', 'new_str'],
    ['search', 'replace'],
  ]
  for (var i = 0; i < pairs.length; i++) {
    var before = a[pairs[i][0]]
    var after = a[pairs[i][1]]
    if (typeof before === 'string' && typeof after === 'string') {
      return { before: before, after: after }
    }
  }
  return null
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * 画成对照。只在"真的改了东西"时返回内容——两边一样就返回空串，
 * 让调用方别为一次没改动的调用画一块红绿。
 */
function diffHtml(before, after) {
  if (before === after) return ''
  var out = diffLines(before, after)
  var rows = out.rows.map(function (one) {
    var sign = one.type === 'add' ? '+' : one.type === 'del' ? '-' : ' '
    return '<div class="diff-row diff-' + one.type + '"><span class="diff-sign">' + sign
      + '</span>' + escapeHtml(one.text) + '</div>'
  })
  return '<div class="diff">' + rows.join('')
    + (out.cut ? '<div class="diff-row diff-cut">（改动太长，只对照了前 ' + DIFF_MAX_LINES + ' 行）</div>' : '')
    + '</div>'
}
