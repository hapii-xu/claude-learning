import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 无需 mock — multiStore.ts 是纯 fs 操作，没有 log/debug/bun:bundle 副作用。

describe('multiStore', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'multi-store-test-'))
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    delete process.env['CLAUDE_CONFIG_DIR']
  })

  test('无 store 时 listStores 返回空数组', async () => {
    const { listStores } = await import('../multiStore.js')
    expect(listStores()).toEqual([])
  })

  test('createStore 创建 store 目录', async () => {
    const { createStore, listStores } = await import('../multiStore.js')
    createStore('my-store')
    expect(listStores()).toContain('my-store')
  })

  test('store 已存在时 createStore 抛出异常', async () => {
    const { createStore } = await import('../multiStore.js')
    createStore('duplicate')
    expect(() => createStore('duplicate')).toThrow('already exists')
  })

  test('setEntry 与 getEntry 读写一致', async () => {
    const { createStore, setEntry, getEntry } = await import('../multiStore.js')
    createStore('notes')
    setEntry('notes', 'hello', '# Hello\nThis is a note.')
    expect(getEntry('notes', 'hello')).toBe('# Hello\nThis is a note.')
  })

  test('key 不存在时 getEntry 返回 null', async () => {
    const { createStore, getEntry } = await import('../multiStore.js')
    createStore('empty-store')
    expect(getEntry('empty-store', 'nonexistent')).toBeNull()
  })

  test('跨 store 隔离：不同 store 中的条目不互相渗透', async () => {
    const { createStore, setEntry, getEntry } = await import('../multiStore.js')
    createStore('store-a')
    createStore('store-b')
    setEntry('store-a', 'shared-key', 'value-from-a')
    setEntry('store-b', 'shared-key', 'value-from-b')
    expect(getEntry('store-a', 'shared-key')).toBe('value-from-a')
    expect(getEntry('store-b', 'shared-key')).toBe('value-from-b')
  })

  test('listEntries 返回 store 中的所有 key', async () => {
    const { createStore, setEntry, listEntries } = await import(
      '../multiStore.js'
    )
    createStore('listing')
    setEntry('listing', 'alpha', 'a')
    setEntry('listing', 'beta', 'b')
    const entries = listEntries('listing')
    expect(entries).toContain('alpha')
    expect(entries).toContain('beta')
  })

  test('deleteEntry 删除条目并返回 true', async () => {
    const { createStore, setEntry, deleteEntry, getEntry } = await import(
      '../multiStore.js'
    )
    createStore('del-store')
    setEntry('del-store', 'to-remove', 'temp')
    expect(deleteEntry('del-store', 'to-remove')).toBe(true)
    expect(getEntry('del-store', 'to-remove')).toBeNull()
  })

  test('条目不存在时 deleteEntry 返回 false', async () => {
    const { createStore, deleteEntry } = await import('../multiStore.js')
    createStore('del-store-2')
    expect(deleteEntry('del-store-2', 'ghost')).toBe(false)
  })

  test('archiveStore 将目录重命名并添加 .archived 后缀', async () => {
    const { createStore, archiveStore, listStores, listAllStores } =
      await import('../multiStore.js')
    createStore('to-archive')
    archiveStore('to-archive')
    expect(listStores()).not.toContain('to-archive')
    expect(listAllStores()).toContain('to-archive.archived')
  })

  test('大条目读写一致（>500KB）', async () => {
    const { createStore, setEntry, getEntry } = await import('../multiStore.js')
    createStore('large')
    const largeValue = 'A'.repeat(512 * 1024)
    setEntry('large', 'big-entry', largeValue)
    expect(getEntry('large', 'big-entry')).toBe(largeValue)
  })

  test('Unicode key 被拒绝（PR-0a 的路径安全策略）', async () => {
    const { createStore, setEntry } = await import('../multiStore.js')
    createStore('unicode-store')
    // Unicode key 现在由 validateKey 拒绝，以保持路径安全语义的 OS 可移植性，
    // 并使权限规则内容安全。value 仍可包含 unicode——只有 key 受约束。
    expect(() =>
      setEntry('unicode-store', '日本語キー', 'value with 日本語'),
    ).toThrow(/invalid key chars/i)
  })

  test('包含 unicode 的 value 仍可正常存储（只有 key 受约束）', async () => {
    const { createStore, setEntry, getEntry } = await import('../multiStore.js')
    createStore('unicode-value-store')
    setEntry('unicode-value-store', 'ascii_key', 'value with 日本語 ✓')
    expect(getEntry('unicode-value-store', 'ascii_key')).toBe(
      'value with 日本語 ✓',
    )
  })

  test('向后兼容：已存在的 a_b.md 文件仍可通过 a_b key 读取', async () => {
    // 模拟 PR-0a 之前的状态：用户写了 setEntry('s', 'a_b', X)
    // 或 setEntry('s', 'a/b', X)——两者都在磁盘上生成 a_b.md。PR-0a 之后，
    // 新的 validateKey 拒绝 'a/b' 但接受 'a_b'。已有的 a_b.md 文件
    // 必须仍能通过 getEntry('s', 'a_b') 读取。
    const { createStore, getEntry } = await import('../multiStore.js')
    createStore('compat-store')
    const storeDir = join(tmpDir, 'local-memory', 'compat-store')
    writeFileSync(join(storeDir, 'a_b.md'), 'legacy content')
    expect(getEntry('compat-store', 'a_b')).toBe('legacy content')
  })

  test('key 碰撞回归：a/b 被拒绝，不再与 a_b 碰撞', async () => {
    const { createStore, setEntry, getEntry } = await import('../multiStore.js')
    createStore('regression-store')
    // a_b 合法，可存储
    setEntry('regression-store', 'a_b', 'value-from-underscore')
    // a/b 现在被拒绝（PR-0a 之前会与 a_b 碰撞）
    expect(() =>
      setEntry('regression-store', 'a/b', 'value-from-slash'),
    ).toThrow(/invalid key chars/i)
    // a_b 仍保持正确的值（未被覆盖）
    expect(getEntry('regression-store', 'a_b')).toBe('value-from-underscore')
  })

  test('Windows 保留名称 NUL 被拒绝（在 Windows 上会静默丢失数据）', async () => {
    const { createStore, setEntry } = await import('../multiStore.js')
    createStore('win-reserved')
    expect(() => setEntry('win-reserved', 'NUL', 'lost')).toThrow(
      /windows reserved/i,
    )
  })

  test('以点开头的 key 被拒绝（如 .gitconfig）', async () => {
    const { createStore, setEntry } = await import('../multiStore.js')
    createStore('hidden-keys')
    expect(() => setEntry('hidden-keys', '.gitconfig', 'x')).toThrow(
      /leading dot/i,
    )
  })
})

// ── I3 / E1：路径遍历回归测试 ──────────────────────────────────────────────────
// 所有这些测试在修复落地之前都必须抛出异常（测试的不变量是：
// 非法 store 名称在任何文件 I/O 发生之前就被拒绝）。

describe('multiStore：路径遍历拒绝（E1 回归）', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'multi-store-sec-'))
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    delete process.env['CLAUDE_CONFIG_DIR']
  })

  test('store 名称 ".." 被拒绝', async () => {
    const { setEntry } = await import('../multiStore.js')
    expect(() => setEntry('..', 'key', 'value')).toThrow()
  })

  test('store 名称 "a/b" 被拒绝', async () => {
    const { setEntry } = await import('../multiStore.js')
    expect(() => setEntry('a/b', 'key', 'value')).toThrow()
  })

  test('store 名称 "a\\\\b" 被拒绝', async () => {
    const { setEntry } = await import('../multiStore.js')
    expect(() => setEntry('a\\b', 'key', 'value')).toThrow()
  })

  test('包含 null 字节的 store 名称被拒绝', async () => {
    const { setEntry } = await import('../multiStore.js')
    expect(() => setEntry('foo\x00bar', 'key', 'value')).toThrow()
  })

  test('store 名称 "C:hack"（Windows 驱动器前缀）被拒绝', async () => {
    const { setEntry } = await import('../multiStore.js')
    expect(() => setEntry('C:hack', 'key', 'value')).toThrow()
  })

  test('解析后超出 base 目录的 store 名称被拒绝', async () => {
    const { setEntry } = await import('../multiStore.js')
    // 可能逃逸的编码风格路径
    expect(() => setEntry('../escape', 'key', 'value')).toThrow()
  })

  test('store 名称过长（>255 字符）被拒绝', async () => {
    const { setEntry } = await import('../multiStore.js')
    const longName = 'a'.repeat(256)
    expect(() => setEntry(longName, 'key', 'value')).toThrow()
  })

  test('validateStoreName: accepted store name passes', async () => {
    const { createStore } = await import('../multiStore.js')
    // Should NOT throw
    expect(() => createStore('valid-store-name')).not.toThrow()
  })

  test('D2: value >1MB is rejected', async () => {
    const { createStore, setEntry } = await import('../multiStore.js')
    createStore('size-test')
    const bigValue = 'X'.repeat(1_048_577) // 1MB + 1 byte
    expect(() => setEntry('size-test', 'big', bigValue)).toThrow()
  })
})

// ── M5 (codecov-100 audit #9): getEntryBounded short-read handling ──────────
// The audit flagged that the old loop returned a `readBytes`-sized buffer
// even if readSync delivered fewer bytes (e.g. file truncated mid-read),
// with `truncated=false`. Test pins the new behavior: short reads surface
// as `truncated=true`, and the returned value's length matches what was
// actually read (no trailing zero bytes).

describe('multiStore: getEntryBounded short-read handling (M5 audit #9)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'multi-store-bounded-'))
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    delete process.env['CLAUDE_CONFIG_DIR']
  })

  test('getEntryBounded: full read with file <= maxBytes returns truncated=false', async () => {
    const { createStore, setEntry, getEntryBounded } = await import(
      '../multiStore.js'
    )
    createStore('bounded')
    setEntry('bounded', 'small', 'hello')
    const result = getEntryBounded('bounded', 'small', 1024)
    expect(result).not.toBeNull()
    expect(result!.value).toBe('hello')
    expect(result!.truncated).toBe(false)
  })

  test('getEntryBounded: file larger than maxBytes returns truncated=true and prefix only', async () => {
    const { createStore, setEntry, getEntryBounded } = await import(
      '../multiStore.js'
    )
    createStore('bounded')
    setEntry('bounded', 'big', 'X'.repeat(2048))
    const result = getEntryBounded('bounded', 'big', 100)
    expect(result).not.toBeNull()
    expect(result!.value.length).toBe(100)
    expect(result!.value).toBe('X'.repeat(100))
    expect(result!.truncated).toBe(true)
  })

  test('getEntryBounded: returned value has no trailing zero bytes (audit #9 regression)', async () => {
    // The old code returned `buf.toString('utf8')` directly — if readSync
    // delivered fewer bytes than the buffer was allocated for (statSync
    // saw 100 bytes but only 50 were readable by readSync), the returned
    // string would have 50 trailing NUL bytes ( ) silently. The new
    // code uses subarray(0, offset) so the returned string length matches
    // exactly what was read.
    const { createStore, setEntry, getEntryBounded } = await import(
      '../multiStore.js'
    )
    createStore('bounded')
    setEntry('bounded', 'exact', 'a'.repeat(50))
    const result = getEntryBounded('bounded', 'exact', 100)
    expect(result).not.toBeNull()
    // 50-byte file, read with cap of 100 → readBytes=50, buf is 50 bytes,
    // value is exactly 50 bytes with no trailing NULs.
    expect(result!.value.length).toBe(50)
    expect(result!.value).toBe('a'.repeat(50))
    expect(result!.value).not.toContain(' ')
    expect(result!.truncated).toBe(false)
  })

  test('getEntryBounded: returns null for missing entry', async () => {
    const { createStore, getEntryBounded } = await import('../multiStore.js')
    createStore('bounded')
    expect(getEntryBounded('bounded', 'missing', 1024)).toBeNull()
  })
})
