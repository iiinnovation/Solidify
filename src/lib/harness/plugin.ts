import type { Tool } from '../tools/types'
import type { Hook, HookManager } from './hooks'

// Tool input/output types are erased at the registry boundary and restored by
// each tool's own schema and execute implementation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PluginTool = Tool<any, any>

export interface HarnessPlugin { id: string; version: string; tools?: PluginTool[]; hooks?: Hook[]; onLoad?: () => void | Promise<void>; onUnload?: () => void | Promise<void> }

export class PluginManager {
  private readonly plugins = new Map<string, { plugin: HarnessPlugin; dispose: () => Promise<void> }>()
  private readonly hooks: HookManager
  private readonly registerTool: (tool: PluginTool) => () => void
  constructor(hooks: HookManager, registerTool: (tool: PluginTool) => () => void) { this.hooks = hooks; this.registerTool = registerTool }
  async load(plugin: HarnessPlugin): Promise<() => Promise<void>> {
    if (this.plugins.has(plugin.id)) throw new Error(`Plugin '${plugin.id}' is already loaded`)
    const disposers: Array<() => void> = []
    try {
      for (const hook of plugin.hooks ?? []) disposers.push(this.hooks.register({ ...hook, priority: Math.max(100, hook.priority) }))
      for (const tool of plugin.tools ?? []) {
        const dispose = this.registerTool(tool)
        if (typeof dispose !== 'function') throw new Error(`Tool registry did not return a disposer for '${tool.name}'`)
        disposers.push(dispose)
      }
      await plugin.onLoad?.()
    } catch (error) {
      for (const dispose of [...disposers].reverse()) dispose()
      throw error
    }
    let disposed = false
    const dispose = async () => {
      if (disposed) return
      disposed = true
      for (const unregister of [...disposers].reverse()) unregister()
      this.plugins.delete(plugin.id)
      await plugin.onUnload?.()
    }
    this.plugins.set(plugin.id, { plugin, dispose })
    return dispose
  }
  async unload(id: string): Promise<void> { await this.plugins.get(id)?.dispose() }
  list(): HarnessPlugin[] { return [...this.plugins.values()].map(({ plugin }) => plugin) }
}
