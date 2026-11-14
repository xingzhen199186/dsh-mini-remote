/**
 * 会话搜索的"料"（2026-11-14）。
 *
 * 只按标题匹配，而且只翻**已经加载到手机上的**会话——没展开过的工作区，
 * 手机根本不知道里面有哪些会话。**装作"没有"比说"还没加载"更坏**，
 * 所以这种情况单独用一个数记下来，界面上要如实说。
 *
 * 抽成纯函数是为了能单测：翻列表的正确性不该靠肉眼点一遍。
 */

/**
 * @param {Array<{id:string,title:string}>} workspaces 工作区（导航里那一层）
 * @param {Object<string,{sessions:Array<{id:string,title?:string}>}>} loaded 已加载的会话
 * @param {string} query 用户打进去的字
 * @returns {{query:string, rows:Array<{ws:string,id:string,title:string}>, hidden:number, empty:boolean}}
 */
function searchSessions(workspaces, loaded, query) {
  var q = String(query || '').trim().toLowerCase()
  var rows = []
  var hidden = 0
  var list = workspaces || []
  for (var i = 0; i < list.length; i++) {
    var ws = list[i] || {}
    var wsHit = String(ws.title || '').toLowerCase().indexOf(q) >= 0
    var got = loaded ? loaded[ws.id] : null
    if (!got) {
      // 这个工作区没加载过：工作区名命中就先告诉用户"点开才能看到"。
      if (wsHit) rows.push({ ws: ws.title || '', id: '', title: '（这个工作区还没展开，点开才能看到会话）' })
      else hidden += 1
      continue
    }
    var sessions = got.sessions || []
    for (var k = 0; k < sessions.length; k++) {
      var one = sessions[k] || {}
      var hit = wsHit || String(one.title || '').toLowerCase().indexOf(q) >= 0
      if (hit) rows.push({ ws: ws.title || '', id: one.id || '', title: one.title || '未命名会话' })
    }
  }
  return { query: String(query || ''), rows: rows, hidden: hidden, empty: rows.length === 0 }
}
