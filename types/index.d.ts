// This process's token, so a status file or busy marker it wrote is told from one another
// process wrote for the same conversation. Held by the host across reloads of the mod.
export type Owner = string

declare module 'claude-code' {
  interface PluginState {
    'cache-keepalive': { owner: Owner }
  }
}
