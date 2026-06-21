const NO_VALUE = Symbol('NO_VALUE')

export async function lastX<A>(as: AsyncGenerator<A>): Promise<A> {
  let lastValue: A | typeof NO_VALUE = NO_VALUE
  for await (const a of as) {
    lastValue = a
  }
  if (lastValue === NO_VALUE) {
    throw new Error('No items in generator')
  }
  return lastValue
}

export async function returnValue<A>(
  as: AsyncGenerator<unknown, A>,
): Promise<A> {
  let e
  do {
    e = await as.next()
  } while (!e.done)
  return e.value
}

type QueuedGenerator<A> = {
  // biome-ignore lint/suspicious/noConfusingVoidType: void matches AsyncGenerator<A, void> return type
  done: boolean | void
  // biome-ignore lint/suspicious/noConfusingVoidType: void matches AsyncGenerator<A, void> yield type
  value: A | void
  generator: AsyncGenerator<A, void>
  promise: Promise<QueuedGenerator<A>>
}

// 并发运行所有生成器直至并发上限，值到达时立即 yield
export async function* all<A>(
  generators: AsyncGenerator<A, void>[],
  concurrencyCap = Infinity,
): AsyncGenerator<A, void> {
  const next = (generator: AsyncGenerator<A, void>) => {
    const promise: Promise<QueuedGenerator<A>> = generator
      .next()
      .then(({ done, value }) => ({
        done,
        value,
        generator,
        promise,
      }))
    return promise
  }
  const waiting = [...generators]
  const promises = new Set<Promise<QueuedGenerator<A>>>()

  // 启动初始批次直到并发上限
  while (promises.size < concurrencyCap && waiting.length > 0) {
    const gen = waiting.shift()!
    promises.add(next(gen))
  }

  while (promises.size > 0) {
    const { done, value, generator, promise } = await Promise.race(promises)
    promises.delete(promise)

    if (!done) {
      promises.add(next(generator))
      // TODO: 清理此处
      if (value !== undefined) {
        yield value as Awaited<A>
      }
    } else if (waiting.length > 0) {
      // 当一个生成器完成时启动新的生成器
      const nextGen = waiting.shift()!
      promises.add(next(nextGen))
    }
  }
}

export async function toArray<A>(
  generator: AsyncGenerator<A, void>,
): Promise<A[]> {
  const result: A[] = []
  for await (const a of generator) {
    result.push(a)
  }
  return result
}

export async function* fromArray<T>(values: T[]): AsyncGenerator<T, void> {
  for (const value of values) {
    yield value
  }
}
