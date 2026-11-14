/**
 * 滚动跳动记录器（2026-11-14）。
 *
 * 用户报「执行时页面一直在上下跳」，但**从外面看不见是什么在动**：可能是底部那行在收放、
 * 可能是待办条、可能是轨迹区在长高、也可能是滚动被两边同时抢。
 *
 * 这里只做一件事：**在没人碰屏幕的情况下，滚动位置突然跳了**，就把那一刻的版面数字记一条。
 * 不记任何正文（只有数字和开关状态），一次最多几条，写进电脑上的 scratch/scroll-diag.log。
 *
 * 用它的方式：复现 → 我读日志 → 按"跳的时候哪个数字变了"定原因，不再靠猜。
 */
(function () {
  var main = document.getElementById('main')
  if (!main) return
  var LOG = '/mini/api/scroll-diag'
  var lastTop = main.scrollTop || 0
  var lastAt = Date.now()
  var touchedAt = 0
  var lastSentAt = 0
  var sent = 0

  document.addEventListener('touchstart', function () { touchedAt = Date.now() }, true)
  document.addEventListener('wheel', function () { touchedAt = Date.now() }, true)

  function num(el, prop) { return el ? (el[prop] || 0) : 0 }
  function hidden(id) {
    var el = document.getElementById(id)
    return el ? el.hidden === true : null
  }
  function count(sel) {
    try { return document.querySelectorAll(sel).length } catch (err) { return -1 }
  }

  // 开机自报一声：日志里连这一条都没有，就说明记录器根本没装进页面
  // （或者请求被挡了）——省得把"没记到"误当成"没跳动"。
  function send(body) {
    try {
      fetch(LOG, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      }).catch(function () {})
    } catch (err) {}
  }
  send({ tag: 'probe-hello', height: num(main, 'scrollHeight'), client: num(main, 'clientHeight') })

  // 高度突变单独记一条（2026-11-14 第二轮）：光看"滚动跳了"只能知道被顶回去，
  // 不知道是**谁**让它变矮。这里每 300 毫秒看一眼内容总高，一次变 200 以上就记。
  var lastHeight = num(main, 'scrollHeight')
  var lastSeenHeight = lastHeight
  setInterval(function () {
    // 只在跑任务时量：闲的时候页面不动，量了也是白耗电。
    if (!(typeof state === 'object' && state && state.running)) { lastHeight = num(main, 'scrollHeight'); return }
    var now = num(main, 'scrollHeight')
    if (Math.abs(now - lastHeight) < 200) { lastHeight = now; return }
    send({
      tag: 'height-change',
      from: lastHeight,
      to: now,
      delta: now - lastHeight,
      top: Math.round(main.scrollTop || 0),
      client: num(main, 'clientHeight'),
      mode: (typeof state === 'object' && state && state.mode) || '',
      liveLen: (typeof state === 'object' && state && state.live ? state.live.length : 0),
      running: !!(typeof state === 'object' && state && state.running),
      workHidden: hidden('work'),
      todoHidden: hidden('todoBar'),
      liveBlocks: count('#reply .live'),
      msgs: count('#reply .msg'),
    })
    lastHeight = now
    lastSeenHeight = now
  }, 300)

  main.addEventListener('scroll', function () {
    var now = Date.now()
    var top = main.scrollTop || 0
    var delta = top - lastTop
    var gap = now - lastAt
    lastTop = top
    lastAt = now

    // 慢滚、正常阅读、人手在滑——都不算"跳"。
    if (Math.abs(delta) < 60 || gap > 400) return
    if (now - touchedAt < 900) return
    // 一次复现最多记 40 条，且两条之间至少隔 300ms，别把日志刷爆。
    if (sent >= 40 || now - lastSentAt < 300) return
    sent++
    lastSentAt = now

    var body = {
      tag: 'scroll-jump',
      delta: delta,
      top: Math.round(top),
      height: num(main, 'scrollHeight'),
      prevHeight: lastSeenHeight,
      client: num(main, 'clientHeight'),
      mode: (typeof state === 'object' && state && state.mode) || '',
      liveLen: (typeof state === 'object' && state && state.live ? state.live.length : 0),
      running: !!(typeof state === 'object' && state && state.running),
      workHidden: hidden('work'),
      workDim: (function () {
        var el = document.getElementById('work')
        return el && el.className ? /dim/.test(el.className) : false
      })(),
      todoHidden: hidden('todoBar'),
      trajRows: count('.traj-entry, .traj-group'),
      liveBlocks: count('#reply .live'),
      noteHidden: (function () {
        var el = document.querySelector('.more-note')
        return el ? el.classList.contains('hide') : null
      })(),
    }
    try {
      fetch(LOG, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      }).catch(function () {})
    } catch (err) {}
  }, { passive: true })
})()
