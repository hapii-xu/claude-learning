export const LIST_MCP_RESOURCES_TOOL_NAME = 'ListMcpResourcesTool'

export const DESCRIPTION = `
列出已配置 MCP 服务器上的可用资源。
每个资源对象都包含一个 'server' 字段，指示其所属服务器。

用法示例：
- 列出所有服务器的全部资源：\`listMcpResources\`
- 列出某个服务器的资源：\`listMcpResources({ server: "myserver" })\`
`

export const PROMPT = `
列出已配置 MCP 服务器上的可用资源。
每个返回的资源都会包含所有标准 MCP 资源字段，以及一个 'server' 字段
指示该资源所属的服务器。

参数：
- server（可选）：要获取资源的特定 MCP 服务器名称。若未提供，
  将返回所有服务器的资源。
`
