/** 引擎级可预期错误（脚本错误、上限、嵌套）。 */
export class WorkflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowError'
  }
}

/** workflow 已中止（killed）。 */
export class WorkflowAbortedError extends Error {
  constructor() {
    super('workflow has been aborted')
    this.name = 'WorkflowAbortedError'
  }
}
