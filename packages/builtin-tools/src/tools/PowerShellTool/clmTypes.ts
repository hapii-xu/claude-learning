/**
 * PowerShell Constrained Language Mode（约束语言模式）允许的类型列表。
 *
 * 当 PS 在 AppLocker/WDAC 系统锁定下运行时，Microsoft 的 CLM 会将
 * .NET 类型的使用限制在该白名单内。任何不在此集合中的类型都被视为
 * 对不可信代码执行不安全。
 *
 * 我们反向使用该列表：不在集合中的类型字面量 → 询问。一次规范化检查
 * 即可替代逐一枚举危险类型（命名管道、反射、进程派生、P/Invoke 封送等）。
 * 该列表由 Microsoft 维护。
 *
 * 来源：https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_language_modes
 *
 * 规范化：条目以小写存储，同时保留短名和全名（两者都存在时）。
 * PS 会在运行时将类型加速器（如 [int]）解析为 System.Int32；
 * 我们按 AST 输出的字面文本进行匹配。
 */
export const CLM_ALLOWED_TYPES: ReadonlySet<string> = new Set(
  [
    // 类型加速器（AST TypeName.Name 中出现的短名）
    // 安全检查：'adsi' 和 'adsisearcher' 已移除。两者都是 Active Directory
    // Service Interface 类型，在强转时会执行网络绑定：
    //   [adsi]'LDAP://evil.com/...' → 连接到 LDAP 服务器
    //   [adsisearcher]'(objectClass=user)' → 绑定到 AD 并查询
    // Microsoft 的 CLM 允许这些类型是因为它面向可信域中的 Windows 管理员；
    // 我们屏蔽它们是因为目标不会被校验。
    'alias',
    'allowemptycollection',
    'allowemptystring',
    'allownull',
    'argumentcompleter',
    'argumentcompletions',
    'array',
    'bigint',
    'bool',
    'byte',
    'char',
    'cimclass',
    'cimconverter',
    'ciminstance',
    // 'cimsession' 已移除 — 见下方 wmi/adsi 注释
    'cimtype',
    'cmdletbinding',
    'cultureinfo',
    'datetime',
    'decimal',
    'double',
    'dsclocalconfigurationmanager',
    'dscproperty',
    'dscresource',
    'experimentaction',
    'experimental',
    'experimentalfeature',
    'float',
    'guid',
    'hashtable',
    'int',
    'int16',
    'int32',
    'int64',
    'ipaddress',
    'ipendpoint',
    'long',
    'mailaddress',
    'norunspaceaffinity',
    'nullstring',
    'objectsecurity',
    'ordered',
    'outputtype',
    'parameter',
    'physicaladdress',
    'pscredential',
    'pscustomobject',
    'psdefaultvalue',
    'pslistmodifier',
    'psobject',
    'psprimitivedictionary',
    'pstypenameattribute',
    'ref',
    'regex',
    'sbyte',
    'securestring',
    'semver',
    'short',
    'single',
    'string',
    'supportswildcards',
    'switch',
    'timespan',
    'uint',
    'uint16',
    'uint32',
    'uint64',
    'ulong',
    'uri',
    'ushort',
    'validatecount',
    'validatedrive',
    'validatelength',
    'validatenotnull',
    'validatenotnullorempty',
    'validatenotnullorwhitespace',
    'validatepattern',
    'validaterange',
    'validatescript',
    'validateset',
    'validatetrusteddata',
    'validateuserdrive',
    'version',
    'void',
    'wildcardpattern',
    // 安全检查：'wmi'、'wmiclass'、'wmisearcher'、'cimsession' 已移除。
    // WMI 类型强转会执行 WMI 查询，可能针对远程计算机（网络请求），
    // 并访问危险类如 Win32_Process。cimsession 创建 CIM 会话（到远程主机的网络连接）。
    //   [wmi]'\\evil-host\root\cimv2:Win32_Process.Handle="1"' → 远程 WMI
    //   [wmisearcher]'SELECT * FROM Win32_Process' → 运行 WQL 查询
    // 移除理由同上 adsi/adsisearcher。
    'x500distinguishedname',
    'x509certificate',
    'xml',
    // 解析为 System.* 的加速器的全名（AST 可能输出任一形式）
    'system.array',
    'system.boolean',
    'system.byte',
    'system.char',
    'system.datetime',
    'system.decimal',
    'system.double',
    'system.guid',
    'system.int16',
    'system.int32',
    'system.int64',
    'system.numerics.biginteger',
    'system.sbyte',
    'system.single',
    'system.string',
    'system.timespan',
    'system.uint16',
    'system.uint32',
    'system.uint64',
    'system.uri',
    'system.version',
    'system.void',
    'system.collections.hashtable',
    'system.text.regularexpressions.regex',
    'system.globalization.cultureinfo',
    'system.net.ipaddress',
    'system.net.ipendpoint',
    'system.net.mail.mailaddress',
    'system.net.networkinformation.physicaladdress',
    'system.security.securestring',
    'system.security.cryptography.x509certificates.x509certificate',
    'system.security.cryptography.x509certificates.x500distinguishedname',
    'system.xml.xmldocument',
    // System.Management.Automation.* — PS 专属加速器的全限定等价形式
    'system.management.automation.pscredential',
    'system.management.automation.pscustomobject',
    'system.management.automation.pslistmodifier',
    'system.management.automation.psobject',
    'system.management.automation.psprimitivedictionary',
    'system.management.automation.psreference',
    'system.management.automation.semanticversion',
    'system.management.automation.switchparameter',
    'system.management.automation.wildcardpattern',
    'system.management.automation.language.nullstring',
    // Microsoft.Management.Infrastructure.* — CIM 加速器的全限定等价形式
    // 安全检查：cimsession 的全限定形式已移除 — 与短名相同的网络绑定风险
    // （创建到远程主机的 CIM 会话）。
    'microsoft.management.infrastructure.cimclass',
    'microsoft.management.infrastructure.cimconverter',
    'microsoft.management.infrastructure.ciminstance',
    'microsoft.management.infrastructure.cimtype',
    // 剩余短名加速器的全限定等价形式
    // 安全检查：DirectoryEntry/DirectorySearcher/ManagementObject/
    // ManagementClass/ManagementObjectSearcher 的全限定形式已移除 —
    // 与短名 adsi/adsisearcher/wmi/wmiclass/wmisearcher 相同的网络绑定风险
    // （LDAP 绑定、远程 WMI）。见上方短名移除注释。
    'system.collections.specialized.ordereddictionary',
    'system.security.accesscontrol.objectsecurity',
    // 允许类型的数组也被允许（例如 [string[]]）
    // normalizeTypeName 在查找前会去掉 []，因此这里存储基础名
    'object',
    'system.object',
    // ModuleSpecification — 全限定名
    'microsoft.powershell.commands.modulespecification',
  ].map(t => t.toLowerCase()),
)

/**
 * 规范化来自 AST TypeName.FullName 或 TypeName.Name 的类型名。
 * 处理数组后缀（[]）和泛型方括号。
 */
export function normalizeTypeName(name: string): string {
  // 去掉数组后缀："String[]" → "string"（允许类型的数组也被允许）
  // 去掉泛型参数："List[int]" → "list"（保守策略 — 即使类型参数安全，
  // 泛型包装器也可能不安全，因此我们检查外层类型）
  return name
    .toLowerCase()
    .replace(/\[\]$/, '')
    .replace(/\[.*\]$/, '')
    .trim()
}

/**
 * 当 typeName（来自 AST）位于 Microsoft 的 CLM 白名单中时返回 true。
 * 不在此集合中的类型会触发询问 — 它们会访问 CLM 屏蔽的系统 API。
 */
export function isClmAllowedType(typeName: string): boolean {
  return CLM_ALLOWED_TYPES.has(normalizeTypeName(typeName))
}
