/**
 * dsh-chat-loli 的工具收窄守卫。
 *
 * 为什么这个文件在预设包里：预设只控制「agent 平面」的工具行（bash / fs /
 * skill / todo / subagent …），宿主进程级的全局工具（terminal_* / browser_* /
 * cua_* / lan_gateway / MCP 资源 …）不在预设的管辖范围，任何会话都继承。
 * 这个预设对外承诺「没有 shell、没有文件读写」，那个承诺有一半得靠这里兑现。
 *
 * 做法：在 `agent/created` 时判定 agent 绑定的预设；命中目标预设就给该 agent
 * 加一层工具遮罩。依据是 dsh-agent 的文档契约：
 *
 *   Agent.ctx 是这个 agent 的 scoped context —— 通过它做的注册（tools、prompt
 *   sections、variables、event listeners、restrictions）只作用于该 agent，
 *   并在销毁时自动撤销。
 *
 * 遮罩只作用于「全局层」，预设自己 scoped 注册的工具不受影响，所以本预设的
 * web_search / web_fetch 仍然可见。
 *
 * 名字清单在运行时用 ctx.tools.schemas()（省略 scope = 全局视图）现算，
 * 而不是硬编码：`restrict` 对未知名字会抛错，这样进程里装了什么就遮什么。
 */

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'chat-loli-guard'

/** 需要的宿主服务。 */
export const inject = ['tools', 'agentPresets', 'agents']

const DEFAULTS = {
  preset: 'dsh-chat-loli',
  keep: [],
}

/**
 * 读取一个活着的 agent 用的是哪个预设。
 *
 * 主路径是 `composedPreset`；退回 `inspectCompositions` 是因为它按 agent 的
 * 绑定查精确 revision，语义更窄但也更可靠。两条都拿不到就当没绑定，
 * 直接放行（宁可不动，也不要误伤别的会话）。
 *
 * @param ctx - 插件所在的宿主 context。
 * @param agent - 目标 agent。
 * @returns 预设 id，或 undefined。
 */
function presetOf(ctx, agent) {
  try {
    const id = ctx.agentPresets.composedPreset(agent.ctx)
    if (id) return id
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    return ctx.agentPresets.inspectCompositions(agent.ctx)[0]?.id
  } catch {
    return undefined
  }
}

/**
 * 给一个 agent 装上工具遮罩。
 *
 * @param ctx - 插件所在的宿主 context。
 * @param agent - 刚创建（或刚切换预设）的 agent。
 * @param presetId - 要收窄的预设 id。
 * @param keep - 额外保留的全局工具名。
 * @param applied - 已经处理过的 agent 集合，避免重复叠加。
 * @returns 是否真的装了遮罩。
 */
function tighten(ctx, agent, presetId, keep, applied) {
  if (!agent || typeof agent !== 'object' || applied.has(agent)) return false
  if (presetOf(ctx, agent) !== presetId) return false

  let deny
  try {
    // 省略 scope 参数 = 全局视图，所以这里拿到的是「宿主级」工具，不含
    // 预设 scoped 注册的名字（那些名字传给 restrict 会直接报错）。
    deny = ctx.tools
      .schemas()
      .map((schema) => schema.name)
      .filter((toolName) => !keep.has(toolName))
  } catch (error) {
    ctx.logger?.warn?.('chat-loli-guard: 读取全局工具失败：%s', String(error?.message ?? error))
    return false
  }

  if (deny.length === 0) return false

  try {
    agent.ctx.tools.restrict({ deny })
  } catch (error) {
    ctx.logger?.warn?.('chat-loli-guard: 收窄失败（preset=%s）：%s', presetId, String(error?.message ?? error))
    return false
  }

  applied.add(agent)
  ctx.logger?.info?.('chat-loli-guard: 已对预设 %s 隐藏 %d 个宿主级工具', presetId, deny.length)
  return true
}

/**
 * 注册监听。
 *
 * 监听器在 `agent/created` 这一轮里执行，AgentLoop 会等到监听器全部结束才
 * 放行排队输入，所以遮罩在第一次请求之前就已就位。任何异常都被吞掉：
 * `agent/created` 里抛出会让创建失败，不该为了收窄工具把会话弄挂。
 *
 * @param ctx - 宿主 context。
 * @param config - `{ preset?, keep? }`。
 */
export function apply(ctx, config = {}) {
  const presetId = typeof config.preset === 'string' && config.preset ? config.preset : DEFAULTS.preset
  const keep = new Set(Array.isArray(config.keep) ? config.keep : DEFAULTS.keep)
  const applied = new WeakSet()

  // 新建或 resume 出来的 agent —— 这是主要入口。
  ctx.on('agent/created', ({ agent }) => {
    tighten(ctx, agent, presetId, keep, applied)
  })

  // 会话从别的预设切进目标预设。切换不会重新触发 agent/created，所以补这条。
  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    if (agentPreset !== presetId) return
    const agent = ctx.agents.get(sessionId)
    if (agent) tighten(ctx, agent, presetId, keep, applied)
  })
}

export default { name, inject, apply }
