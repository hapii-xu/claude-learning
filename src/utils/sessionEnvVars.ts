/**
 * 会话级环境变量，通过 /env 命令设置。
 * 仅应用于派生的子进程（通过 bash provider 的 env 覆盖），
 * 不会影响 REPL 进程本身。
 */
const sessionEnvVars = new Map<string, string>()

export function getSessionEnvVars(): ReadonlyMap<string, string> {
  return sessionEnvVars
}

export function setSessionEnvVar(name: string, value: string): void {
  sessionEnvVars.set(name, value)
}

export function deleteSessionEnvVar(name: string): void {
  sessionEnvVars.delete(name)
}

export function clearSessionEnvVars(): void {
  sessionEnvVars.clear()
}
