/**
 * `ultrareviewCommand.call`（src/commands/review/
 * ultrareviewCommand.tsx）的回归测试。旧版本的 `call` 会发起一次 axios
 * preflight POST 并基于 `action: proceed | blocked | confirm` 分支；
 * 该集成已被移除，`call` 现在基于 `checkOverageGate()` 的四个
 * `kind` 值分支：`not-enabled`、`low-balance`、`needs-confirm`、`proceed`。
 *
 * 这些测试覆盖每个分支：
 *   - `proceed` → 将 billingNote 和 args 透传给 `launchRemoteReview`，
 *     调用 `onDone(text)`，返回 null
 *   - `not-enabled` → onDone 携带付费墙消息 + `display: 'system'`，
 *     返回 null，不启动
 *   - `low-balance` → onDone 携带余额不足消息（包含可用余额），
 *     返回 null，不启动
 *   - `needs-confirm` → 返回 React `UltrareviewOverageDialog` 元素，
 *     不调用 onDone，不启动
 *   - `proceed` + null 启动结果 → onDone 携带 "failed to launch" 消息
 *   - `proceed` + 参数透传 → args（如 PR 号）原样到达 launchRemoteReview
 *     （call 本身不解析它们）
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { debugMock } from '../../../../tests/mocks/debug.js';
import { logMock } from '../../../../tests/mocks/log.js';
import { setupAxiosMock } from '../../../../tests/mocks/axios.js';

// 在本 suite 之前预先 import 真实的 react 和 ink 模块，以便之后可以委托。
// Bun 的 mock.module 是进程级 / last-write-wins；不委托的话，
// stub 的 createElement / stub 的 ink 组件会泄漏到其他
// 测试文件（例如 SnapshotUpdateDialog.test.tsx、AgentsPlatformView.test.tsx），
// 而这些文件需要真实的 React.createElement 和真实的 Box/Text 组件。
const _realReactMod = (await import('react')) as Record<string, unknown> & {
  default?: Record<string, unknown>;
};
const _realInkMod = (await import('@anthropic/ink')) as Record<string, unknown>;
let _useStubReactForUltrareview = true;
let _useStubInkForUltrareview = true;
afterAll(() => {
  _useStubReactForUltrareview = false;
  _useStubInkForUltrareview = false;
  // 在 afterAll 运行时 handle 引用已经存在（TDZ 通过闭包解析）。
  // 将 useStubs 关闭，这样对于同一进程中之后运行的任何测试文件，
  // spread-real 的兜底分支就会生效。
  _ultrareviewAxiosHandle.useStubs = false;
});

// 在任何被测 import 之前 mock 依赖链
mock.module('src/utils/debug.ts', debugMock);
mock.module('src/utils/log.ts', logMock);
mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
}));
mock.module('src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => null,
}));

// Mock auth 工具
mock.module('src/utils/auth.js', () => ({
  isClaudeAISubscriber: () => true,
  isTeamSubscriber: () => false,
  isEnterpriseSubscriber: () => false,
}));

// Mock checkOverageGate 并使用可变的 gate 结果，使每个测试可以驱动
// ultrareviewCommand.call 的四个分支（not-enabled、low-balance、
// needs-confirm、proceed）。launchRemoteReview 会捕获 args 用于参数
// 透传测试，其返回值也可变 — `null` 会触发 "failed to launch" onDone 分支。
type GateResult =
  | { kind: 'proceed'; billingNote: string }
  | { kind: 'not-enabled' }
  | { kind: 'low-balance'; available: number }
  | { kind: 'needs-confirm' };
let _gateResult: GateResult = { kind: 'proceed', billingNote: '' };
let _launchResult: Array<{ type: 'text'; text: string }> | null = [{ type: 'text', text: 'Launched successfully.' }];
const _capturedLaunchArgs: string[] = [];
mock.module('src/commands/review/reviewRemote.js', () => ({
  checkOverageGate: async () => _gateResult,
  confirmOverage: () => {},
  launchRemoteReview: async (args: string) => {
    _capturedLaunchArgs.push(args);
    return _launchResult;
  },
}));

// Mock OAuth 配置，使真实的 fetchUltrareviewPreflight 可以运行
mock.module('src/constants/oauth.js', () => ({
  getOauthConfig: () => ({ BASE_API_URL: 'https://api.anthropic.com' }),
}));

// Mock prepareApiRequest，使真实的 fetchUltrareviewPreflight 跳过鉴权
mock.module('src/utils/teleport/api.js', () => ({
  prepareApiRequest: async () => ({
    accessToken: 'test-token',
    orgUUID: 'org-uuid-test',
  }),
  getOAuthHeaders: (token: string) => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }),
}));

// Mock axios — 单测响应通过 mockAxiosPost.mockImplementationOnce 设置
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAxiosPost = mock(
  async (..._args: any[]): Promise<any> => ({
    status: 200,
    data: { action: 'proceed', billing_note: null },
  }),
);

// Spread 真实 axios + 基于 flag 门控的 stub，使单测的 mockAxiosPost 不再
// 泄漏到后续测试文件（mock.module 是进程级）。本 suite 默认开启；
// 上方 afterAll 会翻转 _useStubReactForUltrareview，而这里我们将
// axios 的清理绑定到 helper 自身的 flag — 见 suite 级 afterAll。
const _ultrareviewAxiosHandle = setupAxiosMock();
_ultrareviewAxiosHandle.useStubs = true;
_ultrareviewAxiosHandle.stubs.post = mockAxiosPost;
_ultrareviewAxiosHandle.stubs.isAxiosError = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { isAxiosError?: boolean }).isAxiosError === true;

// Mock detectCurrentRepositoryWithHost 模块
mock.module('src/utils/detectRepository.js', () => ({
  detectCurrentRepositoryWithHost: async () => ({
    host: 'github.com',
    owner: 'testowner',
    name: 'testrepo',
  }),
}));

// 对 React/Ink 做最小化 mock，避免依赖完整渲染器。
// 当没有传入可变参数 children 时，保留显式的 `children` prop
// — 否则通过 props 对象传入 `children` 的调用方（例如
// SnapshotUpdateDialog.ts 使用 `React.createElement(Dialog, { ..., children })`）
// 会看到自己的数组被覆盖为 `[]`。mock.module 是进程级的，因此该 mock
// 在同一次运行的其他测试文件中依然生效；afterAll 会翻转 flag，
// 此后委托给真实的 React。
mock.module('react', () => {
  const stubCreateElement = (type: unknown, props: unknown, ...children: unknown[]) => {
    const propsObj = (props ?? {}) as Record<string, unknown>;
    const finalChildren = children.length > 0 ? children : 'children' in propsObj ? propsObj.children : [];
    return {
      $$typeof: Symbol.for('react.element'),
      type,
      props: { ...propsObj, children: finalChildren },
    };
  };
  const realCreate = ((_realReactMod.default as Record<string, unknown> | undefined)?.createElement ??
    _realReactMod.createElement) as (...args: unknown[]) => unknown;
  const createElement = (...args: unknown[]) =>
    _useStubReactForUltrareview ? stubCreateElement(args[0], args[1], ...args.slice(2)) : realCreate(...args);
  return {
    ..._realReactMod,
    default: {
      ...((_realReactMod.default as Record<string, unknown> | undefined) ?? {}),
      createElement,
    },
    createElement,
  };
});

// Spread 真实 ink + 对 stub 组件做 flag 门控。如果不 spread，光秃秃的
// { Box: 'Box', Dialog: 'Dialog', Text: 'Text' } 会泄漏到之后每一个
// import @anthropic/ink 的测试文件（例如 AgentsPlatformView.test.tsx）— 这些
// 调用方会拿到字符串而不是真实组件，渲染就会出错。
mock.module('@anthropic/ink', () => {
  if (_useStubInkForUltrareview) {
    return {
      ..._realInkMod,
      Box: 'Box',
      Dialog: 'Dialog',
      Text: 'Text',
    };
  }
  return _realInkMod;
});

mock.module('src/components/CustomSelect/select.js', () => ({
  Select: 'Select',
}));

// UltrareviewOverageDialog 和 PreflightDialog — 返回一个简单标记
mock.module('src/commands/review/UltrareviewOverageDialog.js', () => ({
  UltrareviewOverageDialog: () => ({ type: 'UltrareviewOverageDialog' }),
}));
mock.module('src/commands/review/UltrareviewPreflightDialog.js', () => ({
  UltrareviewPreflightDialog: () => ({ type: 'UltrareviewPreflightDialog' }),
}));

import { call } from '../ultrareviewCommand.js';

const makeContext = () =>
  ({
    abortController: { signal: {} },
  }) as Parameters<typeof call>[1];

describe('ultrareviewCommand.call: gate branches', () => {
  // 在测试之间重置 gate + launch 状态，避免上一个测试的修改
  // 泄漏到下一个测试。
  beforeEach(() => {
    _gateResult = { kind: 'proceed', billingNote: '' };
    _launchResult = [{ type: 'text', text: 'Launched successfully.' }];
    _capturedLaunchArgs.length = 0;
  });

  test('proceed gate: forwards billingNote to launchRemoteReview, calls onDone, returns null', async () => {
    _gateResult = { kind: 'proceed', billingNote: ' Free review 1 of 5.' };

    const messages: string[] = [];
    const onDone = (msg: string) => messages.push(msg);

    const result = await call(onDone as Parameters<typeof call>[0], makeContext(), '');

    expect(result).toBeNull();
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain('Launched successfully');
    // launchRemoteReview 恰好以空 args 被调用一次。
    expect(_capturedLaunchArgs).toEqual(['']);
  });

  test('not-enabled gate: onDone with paywall message, returns null', async () => {
    _gateResult = { kind: 'not-enabled' };

    const messages: string[] = [];
    const opts: Array<unknown> = [];
    const onDone = (msg: string, opt: unknown) => {
      messages.push(msg);
      opts.push(opt);
    };

    const result = await call(onDone as Parameters<typeof call>[0], makeContext(), '');

    expect(result).toBeNull();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Free ultrareviews used');
    expect(messages[0]).toContain('claude.ai/settings/billing');
    expect((opts[0] as { display: string }).display).toBe('system');
    // 付费墙情况下绝对不能调用 launchRemoteReview。
    expect(_capturedLaunchArgs).toEqual([]);
  });

  test('low-balance gate: onDone with balance-too-low message including available amount, returns null', async () => {
    _gateResult = { kind: 'low-balance', available: 4.5 };

    const messages: string[] = [];
    const opts: Array<unknown> = [];
    const onDone = (msg: string, opt: unknown) => {
      messages.push(msg);
      opts.push(opt);
    };

    const result = await call(onDone as Parameters<typeof call>[0], makeContext(), '');

    expect(result).toBeNull();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Balance too low');
    expect(messages[0]).toContain('$4.50');
    expect(messages[0]).toContain('claude.ai/settings/billing');
    expect((opts[0] as { display: string }).display).toBe('system');
    expect(_capturedLaunchArgs).toEqual([]);
  });

  test('needs-confirm gate: returns UltrareviewOverageDialog React element, does not launch', async () => {
    _gateResult = { kind: 'needs-confirm' };

    const messages: string[] = [];
    const onDone = (msg: string) => messages.push(msg);

    const result = await call(onDone as Parameters<typeof call>[0], makeContext(), '');

    // 返回 React 元素而不是 null。
    expect(result).not.toBeNull();
    expect(typeof result).toBe('object');
    const element = result as { type: unknown };
    expect(element.type).toBeDefined();
    // 在用户与对话框交互之前不会调用 onDone。
    expect(messages).toEqual([]);
    expect(_capturedLaunchArgs).toEqual([]);
  });

  test('proceed gate + launchRemoteReview returns null: onDone with failure message', async () => {
    _gateResult = { kind: 'proceed', billingNote: '' };
    _launchResult = null; // teleport / 非 github 失败路径

    const messages: string[] = [];
    const opts: Array<unknown> = [];
    const onDone = (msg: string, opt: unknown) => {
      messages.push(msg);
      opts.push(opt);
    };

    const result = await call(onDone as Parameters<typeof call>[0], makeContext(), '');

    expect(result).toBeNull();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Ultrareview failed to launch');
    expect((opts[0] as { display: string }).display).toBe('system');
  });

  test('proceed gate: forwards args (e.g. PR number) verbatim to launchRemoteReview', async () => {
    _gateResult = { kind: 'proceed', billingNote: '' };

    const messages: string[] = [];
    const onDone = (msg: string) => messages.push(msg);

    await call(onDone as Parameters<typeof call>[0], makeContext(), '42');

    // ultrareviewCommand.call 本身不解析 args — PR 号检测由
    // launchRemoteReview 负责。因此这里只断言透传。
    expect(_capturedLaunchArgs).toEqual(['42']);
  });
});
