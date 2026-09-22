/**
 * 从 DSH 会话事件流里，只捞出两样东西：
 *   1. 用户真正发出的指令（不是插件注入的合成上下文）
 *   2. Agent 一轮任务的最终回复（不是中间的工具调用和思考）
 *
 * 依据 DSH 0.1.5-rc.2 实测的事件契约：
 *   SessionEvent = { type, seq, time, data }
 *   - turn/start      data: { turn }
 *   - user/message    data: UserMessage          （data.source.kind === 'user' 才是人发的）
 *   - assistant/message data: { turn, step, message: AssistantMessage, stream, usage? }
 *   - turn/end        data: { turn, reason: { kind } }
 *   reason.kind ∈ completed | aborted | blocked | error | max-tokens | interrupted
 */

/** 只取真正面向用户可见的 text 块，丢掉 reasoning / tool-call / image。 */
export function visibleText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text)
    }
  }
  return parts.join('\n\n').trim()
}

/**
 * 这条助手消息是不是「中间步骤」。
 *
 * 判据：内容里有没有工具调用块。**有就是中间步骤**——模型先写一句「我先看看…」，
 * 再发起工具调用，那句话说到底只是它自己的旁白，不是给你的回答。
 *
 * 依据 dsh-llm 的类型定义（lib/types/types.d.ts）：
 *   TextBlock      { type: 'text',      text }              面向用户的可见文字
 *   ReasoningBlock { type: 'reasoning', text }              思考内容，与可见文字明确区分
 *   ToolCallBlock  { type: 'tool-call', id, name, arguments }
 *
 * 用户 2026-09-21 实机报的「手机端我看回答过来的是思考过程」，就是这里漏了：
 * 原来只要一条消息有文字就记下来，于是一轮里最后那条旁白被当成了回答。
 */
export function isIntermediateStep(content) {
  if (!Array.isArray(content)) return false
  return content.some((block) => block && block.type === 'tool-call')
}

/**
 * 这段文字里是不是夹着工具调用的原始标记。
 *
 * 实机见过：一条助手消息的 text 块里既有旁白，又有没被解析掉的
 * `<parameter name="edit">…`。那属于协议，不是给人读的话——
 * 用户在手机上看到的就是这个（2026-09-21 反馈里贴出来的原文）。
 *
 * 判据故意写窄：只认工具调用那几种标记的开头，不碰别的尖括号内容。
 * 写宽了会误伤——用户完全可能正当地跟你讨论一段 XML 或 HTML。
 */
const TOOL_MARKUP = /<parameter\s+name\s*=|<\s*function_calls\s*>|<invoke\s+name\s*=/

export function looksLikeToolMarkup(text) {
  return typeof text === 'string' && TOOL_MARKUP.test(text)
}

/**
 * 一轮任务的累计器。
 *
 * 一个 turn 可能包含多个 step（模型多次调用工具），每个 step 都会落一条
 * assistant/message。
 *
 * **只有「不含工具调用」的那一条才是最终回答。** 带工具调用的那些是中间步骤，
 * 里面的文字是模型的旁白（「编辑没生效，我重做一下」这种），不是给你的回答——
 * 原来把它们也记下来，于是用户看到的是「思考过程」。
 *
 * 一轮跑完却始终没出现这样一条（被中断、或卡在工具里出不来），那就**没有回答可推**，
 * 推空。宁可什么都不显示，也不能把旁白冒充成回答。
 */
export function createTurnTracker() {
  /** @type {Map<string, { turn: number|null, lastText: string, userText: string, interrupted: boolean }>} */
  const bySession = new Map()

  function slot(sessionId) {
    let s = bySession.get(sessionId)
    if (!s) {
      s = { turn: null, lastText: '', userText: '', interrupted: false }
      bySession.set(sessionId, s)
    }
    return s
  }

  return {
    /**
     * 喂入一条会话事件。
     * @returns {{kind:'user', text:string}|{kind:'reply', text:string, reason:string}|null}
     *          需要推送到手机时返回动作，否则返回 null。
     */
    feed(sessionId, event) {
      if (!event || typeof event.type !== 'string') return null
      const s = slot(sessionId)

      switch (event.type) {
        case 'turn/start':
          s.turn = event.data?.turn ?? s.turn
          s.lastText = ''
          s.interrupted = false
          return null

        case 'user/message': {
          // 只认人发的；agent.inject() 的合成上下文（文件变更通知、skill 内容等）
          // 的 source.kind 是 'plugin'，必须排除，否则手机里会冒出莫名其妙的消息。
          if (event.data?.source?.kind !== 'user') return null
          const text = visibleText(event.data.content)
          if (!text) return null
          s.userText = text
          // 带上 id：手机自己发出去的指令，注入后也会以这条事件回来，
          // 调用方要靠 id 把它认出来、不要记第二笔（见 index.js 的 injectedIds）。
          return { kind: 'user', text, id: event.data?.id }
        }

        case 'assistant/message': {
          const content = event.data?.message?.content
          // 中间步骤的文字是旁白，不是回答——跳过。见上面 isIntermediateStep 的说明。
          if (isIntermediateStep(content)) return null
          const text = visibleText(content)
          if (!text) return null
          // 夹着工具调用原始标记的文字不是给人读的，同样不能推。
          if (looksLikeToolMarkup(text)) return null
          s.lastText = text
          /**
           * 被中止的那一轮，会把「已经吐出来的那一段」作为一个 assistant/message
           * 落下来，带 interrupted: true（见 dsh-session 的类型注释：
           * "A turn cancelled mid-stream finalizes its delivered text/reasoning
           * prefix as this event with `interrupted: true`; undispatched tool calls
           * are absent."）。
           *
           * **那个「没派发的工具调用不在里面」是这里的关键**：中止的那条消息通常
           * 一个 tool-call 块都没有，于是 isIntermediateStep 放它过去、被当成最终
           * 回答。手机上就会莫名其妙出现半句话——看着像模型答崩了。
           * 所以必须单独认这个标记，让手机知道「这是你按停的那半句」。
           */
          s.interrupted = event.data?.interrupted === true
          return null
        }

        case 'turn/end': {
          const reason = event.data?.reason?.kind ?? 'completed'
          const text = s.lastText
          const userText = s.userText
          const interrupted = s.interrupted
          s.lastText = ''
          s.userText = ''
          s.interrupted = false
          // 被取消/出错的轮次，以及卡在工具里没跑出回答的轮次，都没有什么可推的。
          if (!text) return null
          return { kind: 'reply', text, reason, userText, interrupted }
        }

        default:
          return null
      }
    },

    /** 会话销毁时清掉累计器，避免长期运行下 Map 无限增长。 */
    forget(sessionId) {
      bySession.delete(sessionId)
    },
  }
}
