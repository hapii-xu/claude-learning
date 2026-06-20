/**
 * 基于 Fig spec 的命令前缀抽取。
 *
 * 给定命令名 + 参数数组 + 对应的 @withfig/autocomplete spec，遍历 spec
 * 以确定有意义的前缀延伸到参数的哪一层。
 * 例如 `git -C /repo status --short` → `git status`（spec 标明 -C 接一个
 * 参数，跳过它，找到 `status` 作为已知子命令）。
 *
 * 纯函数 (string, string[], CommandSpec) → ...，不依赖 parser。从
 * src/utils/bash/prefix.ts 中抽出，便于 PowerShell 的抽取器复用；
 * 外部 CLI（git、npm、kubectl）本身是 shell 无关的。
 */

import type { CommandSpec } from '../bash/registry.js'

const URL_PROTOCOLS = ['http://', 'https://', 'ftp://']

// 针对运行时拿不到 fig spec 的命令做覆盖（dynamic import 在
// native/node 构建里无法工作）。如果没有这些覆盖，calculateDepth 会
// 回退到 2，产生过宽的前缀。
export const DEPTH_RULES: Record<string, number> = {
  rg: 2, // 尽管路径是可变参数，pattern 参数仍是必需的
  'pre-commit': 2,
  // 拥有深层子命令树的 CLI 工具（如 gcloud scheduler jobs list）
  gcloud: 4,
  'gcloud compute': 6,
  'gcloud beta': 6,
  aws: 4,
  az: 4,
  kubectl: 3,
  docker: 3,
  dotnet: 3,
  'git push': 2,
}

const toArray = <T>(val: T | T[]): T[] => (Array.isArray(val) ? val : [val])

// 判断某个参数是否匹配已知子命令（大小写不敏感：PS 调用方传入原始大小写
// 的参数；fig spec 中的名字是小写）
function isKnownSubcommand(arg: string, spec: CommandSpec | null): boolean {
  if (!spec?.subcommands?.length) return false
  const argLower = arg.toLowerCase()
  return spec.subcommands.some(sub =>
    Array.isArray(sub.name)
      ? sub.name.some(n => n.toLowerCase() === argLower)
      : sub.name.toLowerCase() === argLower,
  )
}

// 根据 spec 判断某个 flag 是否接受参数，否则使用启发式判断
function flagTakesArg(
  flag: string,
  nextArg: string | undefined,
  spec: CommandSpec | null,
): boolean {
  // 检查 flag 是否在 spec.options 中
  if (spec?.options) {
    const option = spec.options.find(opt =>
      Array.isArray(opt.name) ? opt.name.includes(flag) : opt.name === flag,
    )
    if (option) return !!option.args
  }
  // 启发式：如果下一个参数不是 flag，也不是已知子命令，就假定它是 flag 的值
  if (spec?.subcommands?.length && nextArg && !nextArg.startsWith('-')) {
    return !isKnownSubcommand(nextArg, spec)
  }
  return false
}

// 跳过 flag 及其对应的值，找到第一个子命令
function findFirstSubcommand(
  args: string[],
  spec: CommandSpec | null,
): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg.startsWith('-')) {
      if (flagTakesArg(arg, args[i + 1], spec)) i++
      continue
    }
    if (!spec?.subcommands?.length) return arg
    if (isKnownSubcommand(arg, spec)) return arg
  }
  return undefined
}

export async function buildPrefix(
  command: string,
  args: string[],
  spec: CommandSpec | null,
): Promise<string> {
  const maxDepth = await calculateDepth(command, args, spec)
  const parts = [command]
  const hasSubcommands = !!spec?.subcommands?.length
  let foundSubcommand = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg || parts.length >= maxDepth) break

    if (arg.startsWith('-')) {
      // 特例：python -c 需要在 -c 之后立即停止
      if (arg === '-c' && ['python', 'python3'].includes(command.toLowerCase()))
        break

      // 检查应当纳入前缀的 isCommand/isModule flag
      if (spec?.options) {
        const option = spec.options.find(opt =>
          Array.isArray(opt.name) ? opt.name.includes(arg) : opt.name === arg,
        )
        if (
          option?.args &&
          toArray(option.args).some(a => a?.isCommand || a?.isModule)
        ) {
          parts.push(arg)
          continue
        }
      }

      // 对于带子命令的命令，跳过全局 flag 以定位到子命令
      if (hasSubcommands && !foundSubcommand) {
        if (flagTakesArg(arg, args[i + 1], spec)) i++
        continue
      }
      break // 遇到 flag 即停止（原有行为）
    }

    if (await shouldStopAtArg(arg, args.slice(0, i), spec)) break
    if (hasSubcommands && !foundSubcommand) {
      foundSubcommand = isKnownSubcommand(arg, spec)
    }
    parts.push(arg)
  }

  return parts.join(' ')
}

async function calculateDepth(
  command: string,
  args: string[],
  spec: CommandSpec | null,
): Promise<number> {
  // 跳过 flag 及其对应的值，找到第一个子命令
  const firstSubcommand = findFirstSubcommand(args, spec)
  const commandLower = command.toLowerCase()
  const key = firstSubcommand
    ? `${commandLower} ${firstSubcommand.toLowerCase()}`
    : commandLower
  if (DEPTH_RULES[key]) return DEPTH_RULES[key]
  if (DEPTH_RULES[commandLower]) return DEPTH_RULES[commandLower]
  if (!spec) return 2

  if (spec.options && args.some(arg => arg?.startsWith('-'))) {
    for (const arg of args) {
      if (!arg?.startsWith('-')) continue
      const option = spec.options.find(opt =>
        Array.isArray(opt.name) ? opt.name.includes(arg) : opt.name === arg,
      )
      if (
        option?.args &&
        toArray(option.args).some(arg => arg?.isCommand || arg?.isModule)
      )
        return 3
    }
  }

  // 使用已找到的 firstSubcommand 查找子命令 spec
  if (firstSubcommand && spec.subcommands?.length) {
    const firstSubLower = firstSubcommand.toLowerCase()
    const subcommand = spec.subcommands.find(sub =>
      Array.isArray(sub.name)
        ? sub.name.some(n => n.toLowerCase() === firstSubLower)
        : sub.name.toLowerCase() === firstSubLower,
    )
    if (subcommand) {
      if (subcommand.args) {
        const subArgs = toArray(subcommand.args)
        if (subArgs.some(arg => arg?.isCommand)) return 3
        if (subArgs.some(arg => arg?.isVariadic)) return 2
      }
      if (subcommand.subcommands?.length) return 4
      // 没有声明 args 的叶子子命令（git show、git log、git tag）：
      // 第 3 个词是临时性的（SHA、ref、tag 名）→ 会产生类似
      // PowerShell(git show 81210f8:*) 这样毫无价值的过细规则。
      // 与 isOptional 的情况不同 — `git fetch` 声明了可选的 remote/branch，
      // 而 `git fetch origin` 在 bash/prefix.test.ts:912 中被测为有意的
      // remote 限定。
      if (!subcommand.args) return 2
      return 3
    }
  }

  if (spec.args) {
    const argsArray = toArray(spec.args)

    if (argsArray.some(arg => arg?.isCommand)) {
      return !Array.isArray(spec.args) && spec.args.isCommand
        ? 2
        : Math.min(2 + argsArray.findIndex(arg => arg?.isCommand), 3)
    }

    if (!spec.subcommands?.length) {
      if (argsArray.some(arg => arg?.isVariadic)) return 1
      if (argsArray[0] && !argsArray[0].isOptional) return 2
    }
  }

  return spec.args && toArray(spec.args).some(arg => arg?.isDangerous) ? 3 : 2
}

async function shouldStopAtArg(
  arg: string,
  args: string[],
  spec: CommandSpec | null,
): Promise<boolean> {
  if (arg.startsWith('-')) return true

  const dotIndex = arg.lastIndexOf('.')
  const hasExtension =
    dotIndex > 0 &&
    dotIndex < arg.length - 1 &&
    !arg.substring(dotIndex + 1).includes(':')

  const hasFile = arg.includes('/') || hasExtension
  const hasUrl = URL_PROTOCOLS.some(proto => arg.startsWith(proto))

  if (!hasFile && !hasUrl) return false

  // 检查是否处于 python -m flag 之后（用于 module）
  if (spec?.options && args.length > 0 && args[args.length - 1] === '-m') {
    const option = spec.options.find(opt =>
      Array.isArray(opt.name) ? opt.name.includes('-m') : opt.name === '-m',
    )
    if (option?.args && toArray(option.args).some(arg => arg?.isModule)) {
      return false // 不要在 module 名处停止
    }
  }

  // 对于真实的文件/URL，无论上下文都一律停止
  return true
}
