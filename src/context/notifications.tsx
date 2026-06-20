import type * as React from 'react';
import { useCallback, useEffect } from 'react';
import { useAppStateStore, useSetAppState } from 'src/state/AppState.js';
import type { Theme } from '../utils/theme.js';

type Priority = 'low' | 'medium' | 'high' | 'immediate';

type BaseNotification = {
  key: string;
  /**
   * 此通知使其失效的通知的键。
   * 如果通知被作废，它将从队列中移除，
   * 并且如果当前正在显示，则立即清除。
   */
  invalidates?: string[];
  priority: Priority;
  timeoutMs?: number;
  /**
   * 合并具有相同键的通知，类似于 Array.reduce()。
   * 当队列中或当前正在显示的通知中存在匹配键时，
   * 以 fold(累加器, 传入) 的方式调用。
   * 返回合并后的通知（应该继续传递 fold 以便未来的合并）。
   */
  fold?: (accumulator: Notification, incoming: Notification) => Notification;
};

type TextNotification = BaseNotification & {
  text: string;
  color?: keyof Theme;
};

type JSXNotification = BaseNotification & {
  jsx: React.ReactNode;
};

type AddNotificationFn = (content: Notification) => void;
type RemoveNotificationFn = (key: string) => void;

export type Notification = TextNotification | JSXNotification;

const DEFAULT_TIMEOUT_MS = 8000;

// 跟踪当前超时，以便在即时通知到来时清除它
let currentTimeoutId: NodeJS.Timeout | null = null;

export function useNotifications(): {
  addNotification: AddNotificationFn;
  removeNotification: RemoveNotificationFn;
} {
  const store = useAppStateStore();
  const setAppState = useSetAppState();

  // 在当前通知结束或队列改变时处理队列
  const processQueue = useCallback(() => {
    setAppState(prev => {
      const next = getNext(prev.notifications.queue);
      if (prev.notifications.current !== null || !next) {
        return prev;
      }

      currentTimeoutId = setTimeout(
        (setAppState, nextKey, processQueue) => {
          currentTimeoutId = null;
          setAppState(prev => {
            // 按键比较而非引用，以处理重新创建的通知
            if (prev.notifications.current?.key !== nextKey) {
              return prev;
            }
            return {
              ...prev,
              notifications: {
                queue: prev.notifications.queue,
                current: null,
              },
            };
          });
          processQueue();
        },
        next.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        setAppState,
        next.key,
        processQueue,
      );

      return {
        ...prev,
        notifications: {
          queue: prev.notifications.queue.filter(_ => _ !== next),
          current: next,
        },
      };
    });
  }, [setAppState]);

  const addNotification = useCallback<AddNotificationFn>(
    (notif: Notification) => {
      // 处理即时优先级通知
      if (notif.priority === 'immediate') {
        // 清除任何现有超时，因为我们正在显示新的即时通知
        if (currentTimeoutId) {
          clearTimeout(currentTimeoutId);
          currentTimeoutId = null;
        }

        // 为即时通知设置超时
        currentTimeoutId = setTimeout(
          (setAppState, notif, processQueue) => {
            currentTimeoutId = null;
            setAppState(prev => {
              // 按键比较而非引用，以处理重新创建的通知
              if (prev.notifications.current?.key !== notif.key) {
                return prev;
              }
              return {
                ...prev,
                notifications: {
                  queue: prev.notifications.queue.filter(_ => !notif.invalidates?.includes(_.key)),
                  current: null,
                },
              };
            });
            processQueue();
          },
          notif.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          setAppState,
          notif,
          processQueue,
        );

        // 立即显示即时通知
        setAppState(prev => ({
          ...prev,
          notifications: {
            current: notif,
            queue:
              // 仅当当前通知不是即时时才重新排队
              [...(prev.notifications.current ? [prev.notifications.current] : []), ...prev.notifications.queue].filter(
                _ => _.priority !== 'immediate' && !notif.invalidates?.includes(_.key),
              ),
          },
        }));
        return; // 重要：即时通知退出 addNotification
      }

      // 处理非即时通知
      setAppState(prev => {
        // 检查是否可以折叠到具有相同键的现有通知中
        if (notif.fold) {
          // 如果键匹配，折叠到当前通知
          if (prev.notifications.current?.key === notif.key) {
            const folded = notif.fold(prev.notifications.current, notif);
            // 为折叠后的通知重置超时
            if (currentTimeoutId) {
              clearTimeout(currentTimeoutId);
              currentTimeoutId = null;
            }
            currentTimeoutId = setTimeout(
              (setAppState, foldedKey, processQueue) => {
                currentTimeoutId = null;
                setAppState(p => {
                  if (p.notifications.current?.key !== foldedKey) {
                    return p;
                  }
                  return {
                    ...p,
                    notifications: {
                      queue: p.notifications.queue,
                      current: null,
                    },
                  };
                });
                processQueue();
              },
              folded.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              setAppState,
              folded.key,
              processQueue,
            );

            return {
              ...prev,
              notifications: {
                current: folded,
                queue: prev.notifications.queue,
              },
            };
          }

          // 如果键匹配，折叠到队列中的通知
          const queueIdx = prev.notifications.queue.findIndex(_ => _.key === notif.key);
          if (queueIdx !== -1) {
            const folded = notif.fold(prev.notifications.queue[queueIdx]!, notif);
            const newQueue = [...prev.notifications.queue];
            newQueue[queueIdx] = folded;
            return {
              ...prev,
              notifications: {
                current: prev.notifications.current,
                queue: newQueue,
              },
            };
          }
        }

        // 仅当尚未存在时才添加到队列（防止重复）
        const queuedKeys = new Set(prev.notifications.queue.map(_ => _.key));
        const shouldAdd = !queuedKeys.has(notif.key) && prev.notifications.current?.key !== notif.key;

        if (!shouldAdd) return prev;

        const invalidatesCurrent =
          prev.notifications.current !== null && notif.invalidates?.includes(prev.notifications.current.key);

        if (invalidatesCurrent && currentTimeoutId) {
          clearTimeout(currentTimeoutId);
          currentTimeoutId = null;
        }

        return {
          ...prev,
          notifications: {
            current: invalidatesCurrent ? null : prev.notifications.current,
            queue: [
              ...prev.notifications.queue.filter(
                _ => _.priority !== 'immediate' && !notif.invalidates?.includes(_.key),
              ),
              notif,
            ],
          },
        };
      });

      // 添加通知后处理队列
      processQueue();
    },
    [setAppState, processQueue],
  );

  const removeNotification = useCallback<RemoveNotificationFn>(
    (key: string) => {
      setAppState(prev => {
        const isCurrent = prev.notifications.current?.key === key;
        const inQueue = prev.notifications.queue.some(n => n.key === key);

        if (!isCurrent && !inQueue) {
          return prev;
        }

        if (isCurrent && currentTimeoutId) {
          clearTimeout(currentTimeoutId);
          currentTimeoutId = null;
        }

        return {
          ...prev,
          notifications: {
            current: isCurrent ? null : prev.notifications.current,
            queue: prev.notifications.queue.filter(n => n.key !== key),
          },
        };
      });

      processQueue();
    },
    [setAppState, processQueue],
  );

  // 如果初始状态中有通知，则在挂载时处理队列。
  // 命令式读取（不使用 useAppState）——挂载专用的 effect 中的
  // 订阅会是多余的，并会使每个调用方在队列变化时重新渲染。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (store.getState().notifications.queue.length > 0) {
      processQueue();
    }
  }, []);

  return { addNotification, removeNotification };
}

const PRIORITIES: Record<Priority, number> = {
  immediate: 0,
  high: 1,
  medium: 2,
  low: 3,
};
export function getNext(queue: Notification[]): Notification | undefined {
  if (queue.length === 0) return undefined;
  return queue.reduce((min, n) => (PRIORITIES[n.priority] < PRIORITIES[min.priority] ? n : min));
}
