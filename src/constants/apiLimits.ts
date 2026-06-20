/**
 * Anthropic API 限制
 *
 * 这些常量定义了由 Anthropic API 强制执行的服务器端限制。
 * 保持本文件无依赖以防止循环导入。
 *
 * 最后核对日期：2025-12-22
 * 来源：api/api/schemas/messages/blocks/ 和 api/api/config.py
 *
 * 后续：参见 issue #13240 了解从服务器动态获取限制的计划。
 */

// =============================================================================
// 图片限制
// =============================================================================

/**
 * 最大 base64 编码后的图片大小（由 API 强制执行）。
 * 当 base64 字符串长度超过此值时，API 会拒绝图片。
 * 注意：这是 base64 长度，不是原始字节数。Base64 会使体积增大约 33%。
 */
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024 // 5 MB

/**
 * 编码后仍能保持在 base64 限制之内的目标原始图片大小。
 * Base64 编码使体积变为原来的 4/3，因此推导出最大原始大小：
 * raw_size * 4/3 = base64_size → raw_size = base64_size * 3/4
 */
export const IMAGE_TARGET_RAW_SIZE = (API_IMAGE_MAX_BASE64_SIZE * 3) / 4 // 3.75 MB

/**
 * 客户端图片缩放的最大尺寸限制。
 *
 * 注意：API 会在服务端将大于 1568px 的图片缩放（来源：
 * encoding/full_encoding.py），但该处理在服务端完成，不会导致错误。
 * 这些客户端限制（2000px）略大一些，以便在合适的时候保留图片质量。
 *
 * API_IMAGE_MAX_BASE64_SIZE（5MB）是真正的硬性限制，超过则会触发 API 错误。
 */
export const IMAGE_MAX_WIDTH = 2000
export const IMAGE_MAX_HEIGHT = 2000

// =============================================================================
// PDF 限制
// =============================================================================

/**
 * 编码后仍能符合 API 请求限制的最大原始 PDF 文件大小。
 * API 对单个请求的总大小限制为 32MB。Base64 编码会使体积增大约
 * 33%（4/3），因此 20MB 原始 → 约 27MB base64，为对话上下文留出余量。
 */
export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024 // 20 MB

/**
 * API 接受的 PDF 最大页数。
 */
export const API_PDF_MAX_PAGES = 100

/**
 * 超过此大小阈值的 PDF 会被提取为页面图片，
 * 而不是以 base64 文档块形式发送。仅适用于
 * 第一方 API；非第一方始终使用提取方式。
 */
export const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024 // 3 MB

/**
 * 页面提取路径下的最大 PDF 文件大小。超过此大小的
 * PDF 会被拒绝，以避免处理超大文件。
 */
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024 // 100 MB

/**
 * Read 工具单次调用通过 pages 参数最多可提取的页数。
 */
export const PDF_MAX_PAGES_PER_READ = 20

/**
 * 页数超过此值的 PDF 在 @ 提及时会采用引用方式处理，
 * 而不会被内联进上下文。
 */
export const PDF_AT_MENTION_INLINE_THRESHOLD = 10

// =============================================================================
// 媒体限制
// =============================================================================

/**
 * 单次 API 请求允许的最大媒体项数量（图片 + PDF）。
 * API 超过此限制时会返回令人困惑的错误。
 * 我们在客户端进行校验，以提供清晰的错误信息。
 */
export const API_MAX_MEDIA_PER_REQUEST = 100
