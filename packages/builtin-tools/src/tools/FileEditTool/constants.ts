// 独立文件以避免循环依赖
export const FILE_EDIT_TOOL_NAME = 'Edit'

// 授予会话级别访问项目 .hclaude/ 文件夹的权限模式
export const CLAUDE_FOLDER_PERMISSION_PATTERN = '/.hclaude/**'

// 授予会话级别访问全局 ~/.hclaude/ 文件夹的权限模式
export const GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.hclaude/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
