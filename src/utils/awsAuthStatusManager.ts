/**
 * 云提供商认证状态的单例管理器（AWS Bedrock、GCP Vertex）。
 * 在认证工具和 React 组件 / SDK 输出之间传递认证刷新状态。
 * SDK 的 'auth_status' 消息格式是提供商无关的，因此单个管理器
 * 可服务于所有提供商。
 *
 * 旧名称：最初仅限 AWS；现在用于所有云认证刷新流程。
 */

import { createSignal } from './signal.js'

export type AwsAuthStatus = {
  isAuthenticating: boolean
  output: string[]
  error?: string
}

export class AwsAuthStatusManager {
  private static instance: AwsAuthStatusManager | null = null
  private status: AwsAuthStatus = {
    isAuthenticating: false,
    output: [],
  }
  private changed = createSignal<[status: AwsAuthStatus]>()

  static getInstance(): AwsAuthStatusManager {
    if (!AwsAuthStatusManager.instance) {
      AwsAuthStatusManager.instance = new AwsAuthStatusManager()
    }
    return AwsAuthStatusManager.instance
  }

  getStatus(): AwsAuthStatus {
    return {
      ...this.status,
      output: [...this.status.output],
    }
  }

  startAuthentication(): void {
    this.status = {
      isAuthenticating: true,
      output: [],
    }
    this.changed.emit(this.getStatus())
  }

  addOutput(line: string): void {
    this.status.output.push(line)
    this.changed.emit(this.getStatus())
  }

  setError(error: string): void {
    this.status.error = error
    this.changed.emit(this.getStatus())
  }

  endAuthentication(success: boolean): void {
    if (success) {
      // 成功时完全清除状态
      this.status = {
        isAuthenticating: false,
        output: [],
      }
    } else {
      // 失败时保持输出可见
      this.status.isAuthenticating = false
    }
    this.changed.emit(this.getStatus())
  }

  subscribe = this.changed.subscribe

  // 清理，用于测试
  static reset(): void {
    if (AwsAuthStatusManager.instance) {
      AwsAuthStatusManager.instance.changed.clear()
      AwsAuthStatusManager.instance = null
    }
  }
}
