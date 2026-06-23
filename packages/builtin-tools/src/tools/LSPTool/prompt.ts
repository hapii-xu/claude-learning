export const LSP_TOOL_NAME = 'LSP' as const

export const DESCRIPTION = `与 Language Server Protocol (LSP) 服务器交互，获取代码智能特性。

支持的操作：
- goToDefinition：查找符号的定义位置
- findReferences：查找符号的所有引用
- hover：获取符号的悬停信息（文档、类型信息）
- documentSymbol：获取文档中的所有符号（函数、类、变量）
- workspaceSymbol：在整个工作区搜索符号
- goToImplementation：查找接口或抽象方法的实现
- prepareCallHierarchy：获取某位置处的调用层次项（函数/方法）
- incomingCalls：查找所有调用指定位置函数的函数/方法
- outgoingCalls：查找指定位置函数调用的所有函数/方法

所有操作都需要：
- filePath：要操作的文件
- line：行号（从 1 开始，与编辑器一致）
- character：字符偏移（从 1 开始，与编辑器一致）

注意：必须为该文件类型配置 LSP 服务器。如果没有可用的服务器，将返回错误。`
