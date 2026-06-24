import { useEffect, useState } from 'react'
import type { PastedContent } from 'src/utils/config.js'
import { maybeTruncateInput } from './inputPaste.js'

type Props = {
  input: string
  pastedContents: Record<number, PastedContent>
  onInputChange: (input: string) => void
  setCursorOffset: (offset: number) => void
  setPastedContents: (contents: Record<number, PastedContent>) => void
}

export function useMaybeTruncateInput({
  input,
  pastedContents,
  onInputChange,
  setCursorOffset,
  setPastedContents,
}: Props) {
  // 跟踪是否已对当前输入值完成初始化
  const [hasAppliedTruncationToInput, setHasAppliedTruncationToInput] =
    useState(false)

  // 对来自 MessageSelector 的截断和粘贴图片处理输入。
  useEffect(() => {
    if (hasAppliedTruncationToInput) {
      return
    }

    if (input.length <= 10_000) {
      return
    }

    const { newInput, newPastedContents } = maybeTruncateInput(
      input,
      pastedContents,
    )

    onInputChange(newInput)
    setCursorOffset(newInput.length)
    setPastedContents(newPastedContents)
    setHasAppliedTruncationToInput(true)
  }, [
    input,
    hasAppliedTruncationToInput,
    pastedContents,
    onInputChange,
    setPastedContents,
    setCursorOffset,
  ])

  // 输入清空时（如提交后）重置 hasInitializedInput
  useEffect(() => {
    if (input === '') {
      setHasAppliedTruncationToInput(false)
    }
  }, [input])
}
