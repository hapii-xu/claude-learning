import { TICK_TAG } from 'src/constants/xml.js'

export const SLEEP_TOOL_NAME = 'Sleep'

export const DESCRIPTION = '等待指定的时长'

export const SLEEP_TOOL_PROMPT = `等待指定的时长。用户可随时中断睡眠。

当用户让你睡眠或休息、无事可做，或在等待某事时，请使用本工具。

你可能会收到 <${TICK_TAG}> 提示——这些是周期性检查。在睡眠前先寻找有用的工作来做。

本工具可与其他工具并发调用——不会相互干扰。

请优先使用本工具而非 \`Bash(sleep ...)\`——它不会占用 shell 进程。

每次唤醒都会消耗一次 API 调用，但 prompt cache 在 5 分钟不活动后会失效——请合理权衡。`
