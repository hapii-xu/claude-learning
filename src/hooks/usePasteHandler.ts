import { basename } from 'path'
import React from 'react'
import { logError } from 'src/utils/log.js'
import { useDebounceCallback } from 'usehooks-ts'
import type { InputEvent, Key } from '@anthropic/ink'
import {
  getImageFromClipboard,
  isImageFilePath,
  PASTE_THRESHOLD,
  tryReadImageFromPath,
} from '../utils/imagePaste.js'
import type { ImageDimensions } from '../utils/imageResizer.js'
import { getPlatform } from '../utils/platform.js'

const CLIPBOARD_CHECK_DEBOUNCE_MS = 50
const PASTE_COMPLETION_TIMEOUT_MS = 100

type PasteHandlerProps = {
  onPaste?: (text: string) => void
  onInput: (input: string, key: Key) => void
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
}

export function usePasteHandler({
  onPaste,
  onInput,
  onImagePaste,
}: PasteHandlerProps): {
  wrappedOnInput: (input: string, key: Key, event: InputEvent) => void
  pasteState: {
    chunks: string[]
    timeoutId: ReturnType<typeof setTimeout> | null
  }
  isPasting: boolean
} {
  const [pasteState, setPasteState] = React.useState<{
    chunks: string[]
    timeoutId: ReturnType<typeof setTimeout> | null
  }>({ chunks: [], timeoutId: null })
  const [isPasting, setIsPasting] = React.useState(false)
  const isMountedRef = React.useRef(true)
  // 镜像 pasteState.timeoutId 但同步更新。当粘贴 + 一个
  // 按键到达同一个 stdin 块时，两次 wrappedOnInput 调用在
  // React 提交之前的同一个 discreteUpdates 批次中运行 —— 第二次调用
  // 读取到陈旧的 pasteState.timeoutId（null）并走 onInput 路径。如果
  // 那个按键是 Enter，它会提交旧输入，粘贴就丢失了。
  const pastePendingRef = React.useRef(false)

  const isMacOS = React.useMemo(() => getPlatform() === 'macos', [])

  React.useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const checkClipboardForImageImpl = React.useCallback(() => {
    if (!onImagePaste || !isMountedRef.current) return

    void getImageFromClipboard()
      .then(imageData => {
        if (imageData && isMountedRef.current) {
          onImagePaste(
            imageData.base64,
            imageData.mediaType,
            undefined, // no filename for clipboard images
            imageData.dimensions,
          )
        }
      })
      .catch(error => {
        if (isMountedRef.current) {
          logError(error as Error)
        }
      })
      .finally(() => {
        if (isMountedRef.current) {
          setIsPasting(false)
        }
      })
  }, [onImagePaste])

  const checkClipboardForImage = useDebounceCallback(
    checkClipboardForImageImpl,
    CLIPBOARD_CHECK_DEBOUNCE_MS,
  )

  const resetPasteTimeout = React.useCallback(
    (currentTimeoutId: ReturnType<typeof setTimeout> | null) => {
      if (currentTimeoutId) {
        clearTimeout(currentTimeoutId)
      }
      return setTimeout(
        (
          setPasteState,
          onImagePaste,
          onPaste,
          setIsPasting,
          checkClipboardForImage,
          isMacOS,
          pastePendingRef,
        ) => {
          pastePendingRef.current = false
          setPasteState(({ chunks }) => {
            // 连接块并过滤掉孤立的焦点序列
            // 这些序列在粘贴期间焦点事件被分割时出现
            const pastedText = chunks
              .join('')
              .replace(/\[I$/, '')
              .replace(/\[O$/, '')

            // 检查粘贴文本是否包含图像文件路径
            // 拖动多个图像时，它们可能以以下形式出现：
            // 1. 换行符分隔的路径（某些终端中常见）
            // 2. 空格分隔的路径（从 Finder 拖入时常见）
            // 对于空格分隔的路径，我们在绝对路径之前的空格上分割：
            // - Unix：后跟 `/` 的空格（例如 `/Users/...`）
            // - Windows：后跟驱动器号和 `:\` 的空格（例如 `C:\Users\...`）
            // 这有效是因为路径内的空格已被转义（例如 `file\ name.png`）
            const lines = pastedText
              .split(/ (?=\/|[A-Za-z]:\\)/)
              .flatMap(part => part.split('\n'))
              .filter(line => line.trim())
            const imagePaths = lines.filter(line => isImageFilePath(line))

            if (onImagePaste && imagePaths.length > 0) {
              const isTempScreenshot =
                /\/TemporaryItems\/.*screencaptureui.*\/Screenshot/i.test(
                  pastedText,
                )

              // 处理所有图像路径
              void Promise.all(
                imagePaths.map(imagePath => tryReadImageFromPath(imagePath)),
              ).then(results => {
                const validImages = results.filter(
                  (r): r is NonNullable<typeof r> => r !== null,
                )

                if (validImages.length > 0) {
                  // 成功读取至少一张图像
                  for (const imageData of validImages) {
                    const filename = basename(imageData.path)
                    onImagePaste(
                      imageData.base64,
                      imageData.mediaType,
                      filename,
                      imageData.dimensions,
                      imageData.path,
                    )
                  }
                  // 如果某些路径不是图像，将它们作为文本粘贴
                  const nonImageLines = lines.filter(
                    line => !isImageFilePath(line),
                  )
                  if (nonImageLines.length > 0 && onPaste) {
                    onPaste(nonImageLines.join('\n'))
                  }
                  setIsPasting(false)
                } else if (isTempScreenshot && isMacOS) {
                  // 对于不再存在的临时截图文件，尝试剪贴板
                  checkClipboardForImage()
                } else {
                  if (onPaste) {
                    onPaste(pastedText)
                  }
                  setIsPasting(false)
                }
              })
              return { chunks: [], timeoutId: null }
            }

            // 如果粘贴为空（用 Cmd+V 尝试粘贴图像时常见），
            // 检查剪贴板是否有图像（仅 macOS）
            if (isMacOS && onImagePaste && pastedText.length === 0) {
              checkClipboardForImage()
              return { chunks: [], timeoutId: null }
            }

            // 处理普通粘贴
            if (onPaste) {
              onPaste(pastedText)
            }
            // 粘贴完成后重置 isPasting 状态
            setIsPasting(false)
            return { chunks: [], timeoutId: null }
          })
        },
        PASTE_COMPLETION_TIMEOUT_MS,
        setPasteState,
        onImagePaste,
        onPaste,
        setIsPasting,
        checkClipboardForImage,
        isMacOS,
        pastePendingRef,
      )
    },
    [checkClipboardForImage, isMacOS, onImagePaste, onPaste],
  )

  // 粘贴检测现在通过 InputEvent 的 keypress.isPasted 标志完成，
  // 该标志由 keypress 解析器在检测到 bracketed paste 模式时设置。
  // 这避免了 stdin 上有多个监听器导致的竞争条件。
  // 之前我们这里有一个 stdin.on('data') 监听器，它与
  // App.tsx 中的 'readable' 监听器竞争，导致字符丢失。

  const wrappedOnInput = (input: string, key: Key, event: InputEvent): void => {
    // 从解析的 keypress 事件检测粘贴。
    // keypress 解析器为 bracketed paste 内的内容设置 isPasted=true。
    const isFromPaste = event.keypress.isPasted

    // 如果这是粘贴内容，设置 isPasting 状态以提供 UI 反馈
    if (isFromPaste) {
      setIsPasting(true)
    }

    // 处理大段粘贴（>PASTE_THRESHOLD 字符）
    // 通常我们一次收到一两个输入字符。如果我们
    // 收到超过阈值的字符，用户可能进行了粘贴。
    // 不幸的是 node 会批处理长粘贴，所以可能
    // 我们会看到例如 1024 个字符，然后在下一帧只有几个
    // 属于原始粘贴的字符。
    // 这个批处理数字并不一致。

    // 处理可能的图像文件名（即使它们短于粘贴阈值）
    // 拖动多个图像时，它们可能以换行符分隔或
    // 空格分隔的路径形式出现。在绝对路径之前的空格上分割：
    // - Unix：` /` - Windows：` C:\` 等。
    const hasImageFilePath = input
      .split(/ (?=\/|[A-Za-z]:\\)/)
      .flatMap(part => part.split('\n'))
      .some(line => isImageFilePath(line.trim()))

    // 处理空粘贴（macOS 上的剪贴板图像）
    // 当用户用 Cmd+V 粘贴图像时，终端发送一个空的
    // bracketed paste 序列。keypress 解析器将其作为 isPasted=true
    // 且输入为空发出。
    if (isFromPaste && input.length === 0 && isMacOS && onImagePaste) {
      checkClipboardForImage()
      // 由于没有文本内容需要处理，重置 isPasting
      setIsPasting(false)
      return
    }

    // 检查我们是否应该作为粘贴处理（来自 bracketed paste、大输入或延续）
    const shouldHandleAsPaste =
      onPaste &&
      (input.length > PASTE_THRESHOLD ||
        pastePendingRef.current ||
        hasImageFilePath ||
        isFromPaste ||
        (input.length >= 3 &&
          !key.return &&
          !key.tab &&
          !key.escape &&
          !key.upArrow &&
          !key.downArrow &&
          !key.leftArrow &&
          !key.rightArrow))

    if (shouldHandleAsPaste) {
      pastePendingRef.current = true
      setPasteState(({ chunks, timeoutId }) => {
        return {
          chunks: [...chunks, input],
          timeoutId: resetPasteTimeout(timeoutId),
        }
      })
      return
    }
    onInput(input, key)
    if (input.length > 10) {
      // 确保在其他任何多字符输入时关闭 setIsPasting，
      // 因为 stdin buffer 可能在任意点分块并在
      // 输入长度对 stdin buffer 来说太长时分割
      // 闭合转义序列。
      setIsPasting(false)
    }
  }

  return {
    wrappedOnInput,
    pasteState,
    isPasting,
  }
}
