/**
 * Service worker —— 它只为一件存在：让手机能发**系统通知**。
 *
 * 为什么非要有它：手机浏览器上 `new Notification()` 会直接抛 TypeError，
 * 唯一能发系统通知的入口是 `ServiceWorkerRegistration.showNotification()`。
 * 换句话说，「锁屏也能收到提醒」这件事的前提，是先有一个 service worker。
 *
 * 它自己不做任何后台工作：不缓存、不拦截请求、不在后台跑逻辑。收到页面递来的
 * 一句话就发一条通知，用户点了就回到页面。就这样。
 *
 * 2026-09-25 才加。在此之前这条路是关着的——service worker 要求安全上下文，
 * 而当时三条连接路径全是明文 http。Tailscale 那条路接上 HTTPS 之后才成立。
 *
 * **注意作用域**：页面在 `/mini`，不在 `/mini/` 底下。这个文件从 `/mini/sw.js`
 * 发出去，默认作用域只到 `/mini/`，够不着那个页面。所以服务器发它的时候必须带上
 * `Service-Worker-Allowed: /`（见 lib/server.js），把作用域放开到根。
 */

// 新的立刻接管。它没有任何状态要迁移，不该让用户「刷新两次才生效」。
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// 通知由页面直接调 `registration.showNotification()` 发出，不经过这里——
// 页面本来就能调那个方法，绕一道消息传递只是多一层可能出错的地方。
// 这个文件在这儿只负责两件页面做不到的事：**让注册成立**，以及**接住点击**。
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data && event.notification.data.url
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // 页面已经开着就切过去，别再开一个——用户要的是「回到刚才那页」。
      for (const c of all) {
        if (typeof c.focus === 'function') return c.focus()
      }
      if (url && self.clients.openWindow) return self.clients.openWindow(url)
    })(),
  )
})
