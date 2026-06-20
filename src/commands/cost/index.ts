/**
 * /cost —— /usage 的别名（v2.1.118 上游对齐）。
 *
 * /usage 是主命令；/cost 和 /stats 作为别名注册。
 * 此文件重新导出统一的 usage 命令，这样任何直接从 cost/index
 * 导入的代码仍然能获得正确的 Command 对象。
 */
export { default } from '../usage/index.js'
