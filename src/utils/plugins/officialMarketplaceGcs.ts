/**
 * inc-5046：从 GCS 镜像获取官方 marketplace，而非每次启动都从 GitHub 克隆。
 *
 * 后端（anthropic#317037）在 titanium squashfs 旁边发布仅含 marketplace 的 zip，
 * 以基础仓库 SHA 为键。此模块获取 `latest` 指针，与本地哨兵对比，
 * 当有新 SHA 时下载并解压 zip。调用者决定失败时的回退行为。
 */

import axios from 'axios'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { waitForScrollIdle } from '../../bootstrap/state.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { logEvent } from '../../services/analytics/index.js'
import { logForDebugging } from '../debug.js'
import { parseZipModes, unzipFile } from '../dxt/zip.js'
import { errorMessage, getErrnoCode } from '../errors.js'

type SafeString = AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

// 公共 GCS 存储桶的 CDN 前端域名（与原生二进制发布所用的存储桶相同
// —— nativeInstaller/download.ts:24 使用原始 GCS URL）。
// `{sha}.zip` 是内容寻址的，CDN 可以无限期缓存；
// `latest` 设有 Cache-Control: max-age=300，CDN 过期时间有界。
// 后端（anthropic#317037）填充此前缀。
const GCS_BASE =
  'https://downloads.claude.ai/claude-code-releases/plugins/claude-plugins-official'

// Zip 压缩路径相对于 seed 目录（marketplaces/claude-plugins-official/…），
// 以便 titanium seed 机制可以使用相同的 zip。
// 为笔记本电脑安装解压时去掉此前缀。
const ARC_PREFIX = 'marketplaces/claude-plugins-official/'

/**
 * 从 GCS 获取官方 marketplace 并解压到 installLocation。
 * 幂等 —— 下载约 3.5MB 的 zip 前先检查 `.gcs-sha` 哨兵。
 *
 * @param installLocation 解压目标位置（必须在 marketplacesCacheDir 内）
 * @param marketplacesCacheDir 插件 marketplace 缓存根目录 —— 由调用者传入
 *   （而非从 pluginDirectories 导入），以打破通过 marketplaceManager 的循环依赖
 * @returns 成功时返回获取的 SHA（包括无操作情况），任何失败时返回 null
 *   （网络、404、zip 解析）。调用者决定是否回退到 git。
 */
export async function fetchOfficialMarketplaceFromGcs(
  installLocation: string,
  marketplacesCacheDir: string,
): Promise<string | null> {
  // 纵深防御：此函数在原子交换期间执行 `rm(installLocation, {recursive})`。
  // 损坏的 known_marketplaces.json（gh-32793 —— WSL 上读取 Windows 路径、
  // 字面量波浪号、手动编辑）可能指向用户的项目。
  // 拒绝任何在 marketplace 缓存目录之外的路径。
  // 与 marketplaceManager.ts:~2392 的 refreshMarketplace() 保护相同，
  // 但在函数内部，以便覆盖所有调用者。
  const cacheDir = resolve(marketplacesCacheDir)
  const resolvedLoc = resolve(installLocation)
  if (resolvedLoc !== cacheDir && !resolvedLoc.startsWith(cacheDir + sep)) {
    logForDebugging(
      `fetchOfficialMarketplaceFromGcs: refusing path outside cache dir: ${installLocation}`,
      { level: 'error' },
    )
    return null
  }

  // 网络 + zip 解压与滚动帧竞争事件循环。
  // 这是一个即发即忘的启动调用 —— 延迟几百毫秒等待滚动稳定
  // 对用户来说是不可见的。
  await waitForScrollIdle()

  const start = performance.now()
  let outcome: 'noop' | 'updated' | 'failed' = 'failed'
  let sha: string | undefined
  let bytes: number | undefined
  let errKind: string | undefined

  try {
    // 1. latest 指针 —— 约 40 字节，后端设置 Cache-Control: no-cache,
    //    max-age=300。每次启动访问的代价足够小。
    const latest = await axios.get(`${GCS_BASE}/latest`, {
      responseType: 'text',
      timeout: 10_000,
    })
    sha = String(latest.data).trim()
    if (!sha) {
      // /latest 响应体为空 —— 后端配置错误。退出（返回 null），
      // 不要陷入永久损坏的空哨兵状态。
      throw new Error('latest pointer returned empty body')
    }

    // 2. 哨兵检查 —— 安装根目录下的 `.gcs-sha` 保存最后解压的 SHA。
    //    匹配意味着我们已有此内容。
    const sentinelPath = join(installLocation, '.gcs-sha')
    const currentSha = await readFile(sentinelPath, 'utf8').then(
      s => s.trim(),
      () => null, // ENOENT —— 首次获取，继续下载
    )
    if (currentSha === sha) {
      outcome = 'noop'
      return sha
    }

    // 3. 下载 zip 并解压到暂存目录，然后原子交换到位。
    //    解压中途崩溃会留下 .staging 目录（下次运行时删除），
    //    而非半写入的 installLocation。
    const zipResp = await axios.get(`${GCS_BASE}/${sha}.zip`, {
      responseType: 'arraybuffer',
      timeout: 60_000,
    })
    const zipBuf = Buffer.from(zipResp.data)
    bytes = zipBuf.length
    const files = await unzipFile(zipBuf)
    // fflate 不暴露 external_attr，因此我们自己解析中央目录以恢复可执行位。
    // 否则，hooks/scripts 会以 0644 解压，`sh -c "/path/script.sh"`
    //（hooks.ts:~1002）在 Unix 上会因 EACCES 失败。
    // Git 克隆原生保留 +x；此处使 GCS 与之同等。
    const modes = parseZipModes(zipBuf)

    const staging = `${installLocation}.staging`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    for (const [arcPath, data] of Object.entries(files)) {
      if (!arcPath.startsWith(ARC_PREFIX)) continue
      const rel = arcPath.slice(ARC_PREFIX.length)
      if (!rel || rel.endsWith('/')) continue // 前缀目录条目或子目录条目
      const dest = join(staging, rel)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, data)
      const mode = modes[arcPath]
      if (mode && mode & 0o111) {
        // 仅当设置了可执行位时才 chmod —— 跳过普通文件以节省系统调用。
        // 吞掉 EPERM/ENOTSUP（NFS root_squash、某些 FUSE 挂载）—— 失去 +x
        // 是 PR 前的行为，优于在解压中途中止。
        await chmod(dest, mode & 0o777).catch(() => {})
      }
    }
    await writeFile(join(staging, '.gcs-sha'), sha)

    // 原子交换：删除旧目录，重命名暂存目录。
    // 短暂的 installLocation 不存在窗口 —— 对于后台刷新可以接受
    //（如果在此处崩溃，调用者在下次启动时重试）。
    await rm(installLocation, { recursive: true, force: true })
    await rename(staging, installLocation)

    outcome = 'updated'
    return sha
  } catch (e) {
    errKind = classifyGcsError(e)
    logForDebugging(
      `Official marketplace GCS fetch failed: ${errorMessage(e)}`,
      { level: 'warn' },
    )
    return null
  } finally {
    // tengu_plugin_remote_fetch schema 与遥测 PR（.daisy/inc-5046/index.md）共享
    // —— 添加 source:'marketplace_gcs'。下方所有字符串值均为静态枚举或 git SHA
    // —— 不包含代码/文件路径/PII。
    logEvent('tengu_plugin_remote_fetch', {
      source: 'marketplace_gcs' as SafeString,
      host: 'downloads.claude.ai' as SafeString,
      is_official: true,
      outcome: outcome as SafeString,
      duration_ms: Math.round(performance.now() - start),
      ...(bytes !== undefined && { bytes }),
      ...(sha && { sha: sha as SafeString }),
      ...(errKind && { error_kind: errKind as SafeString }),
    })
  }
}

// 我们按名称上报的有界 errno 代码集合。其他内容归入
// fs_other，以保持仪表板基数可控。
const KNOWN_FS_CODES = new Set([
  'ENOSPC',
  'EACCES',
  'EPERM',
  'EXDEV',
  'EBUSY',
  'ENOENT',
  'ENOTDIR',
  'EROFS',
  'EMFILE',
  'ENAMETOOLONG',
])

/**
 * 将 GCS 获取错误分类到稳定的遥测桶中。
 *
 * v2.1.83+ 的遥测显示 50% 的失败落入 'other' ——
 * 其中 99.99% 同时设置了 sha+bytes，说明下载成功但解压/文件系统失败。
 * 此拆分使我们可以在切换 git 回退熔断开关前，
 * 判断失败是否可修复（错误的暂存目录、跨设备重命名）
 * 还是固有的（磁盘满、权限拒绝）。
 */
export function classifyGcsError(e: unknown): string {
  if (axios.isAxiosError(e)) {
    if (e.code === 'ECONNABORTED') return 'timeout'
    if (e.response) return `http_${e.response.status}`
    return 'network'
  }
  const code = getErrnoCode(e)
  // Node fs errno 代码为 E<大写>（ENOSPC、EACCES）。Axios 也设置
  // .code（ERR_NETWORK、ERR_BAD_OPTION、EPROTO）—— 不要将这些归入 fs 桶。
  if (code && /^E[A-Z]+$/.test(code) && !code.startsWith('ERR_')) {
    return KNOWN_FS_CODES.has(code) ? `fs_${code}` : 'fs_other'
  }
  // fflate 在 inflate/unzip 错误时设置数字 .code（0-14）—— 捕获
  // deflate 级别的损坏（"unexpected EOF"、"invalid block type"），
  // 这些是消息正则表达式会遗漏的。
  if (typeof (e as { code?: unknown })?.code === 'number') return 'zip_parse'
  const msg = errorMessage(e)
  if (/unzip|invalid zip|central directory/i.test(msg)) return 'zip_parse'
  if (/empty body/.test(msg)) return 'empty_latest'
  return 'other'
}
