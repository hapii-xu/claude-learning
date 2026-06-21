import React from 'react';
import { type KeyboardEvent, Box } from '@anthropic/ink';
import { type OptionWithDescription, Select } from '../CustomSelect/select.js';

export type TreeNode<T> = {
  id: string | number;
  value: T;
  label: string;
  description?: string;
  dimDescription?: boolean;
  children?: TreeNode<T>[];
  metadata?: Record<string, unknown>;
};

type FlattenedNode<T> = {
  node: TreeNode<T>;
  depth: number;
  isExpanded: boolean;
  hasChildren: boolean;
  parentId?: string | number;
};

export type TreeSelectProps<T> = {
  /**
   * 要显示的树节点。
   */
  readonly nodes: TreeNode<T>[];

  /**
   * 节点被选中时的回调。
   */
  readonly onSelect: (node: TreeNode<T>) => void;

  /**
   * 按下取消时的回调。
   */
  readonly onCancel?: () => void;

  /**
   * 焦点节点变化时的回调。
   */
  readonly onFocus?: (node: TreeNode<T>) => void;

  /**
   * 通过 ID 指定焦点节点。
   */
  readonly focusNodeId?: string | number;

  /**
   * 可见选项的数量。
   */
  readonly visibleOptionCount?: number;

  /**
   * 选项的布局。
   */
  readonly layout?: 'compact' | 'expanded' | 'compact-vertical';

  /**
   * 当被禁用时，忽略用户输入。
   */
  readonly isDisabled?: boolean;

  /**
   * 当为 true 时，隐藏每个选项旁边的数字索引。
   */
  readonly hideIndexes?: boolean;

  /**
   * 用于判断节点是否初始展开的函数。
   * 若未提供，则所有节点初始均为折叠状态。
   */
  readonly isNodeExpanded?: (nodeId: string | number) => boolean;

  /**
   * 节点被展开时的回调。
   */
  readonly onExpand?: (nodeId: string | number) => void;

  /**
   * 节点被折叠时的回调。
   */
  readonly onCollapse?: (nodeId: string | number) => void;

  /**
   * 父节点的自定义前缀函数
   * @param isExpanded - 父节点当前是否展开
   * @returns 要显示的前缀字符串（默认：展开时 '▼ '，折叠时 '▶ '）
   */
  readonly getParentPrefix?: (isExpanded: boolean) => string;

  /**
   * 子节点的自定义前缀函数
   * @param depth - 子节点在树中的深度（从父节点开始 0 索引）
   * @returns 要显示的前缀字符串（默认：'  ▸ '）
   */
  readonly getChildPrefix?: (depth: number) => string;

  /**
   * 用户从第一项向上按下时的回调。
   * 如果提供，则导航不会回环到最后一项。
   */
  readonly onUpFromFirstItem?: () => void;
};

/**
 * TreeSelect 是一个通用组件，用于从分层树结构中选择项。
 * 它处理展开/折叠状态、键盘导航，并使用 Select 组件将树渲染为扁平列表。
 */
export function TreeSelect<T>({
  nodes,
  onSelect,
  onCancel,
  onFocus,
  focusNodeId,
  visibleOptionCount,
  layout = 'expanded',
  isDisabled = false,
  hideIndexes = false,
  isNodeExpanded,
  onExpand,
  onCollapse,
  getParentPrefix,
  getChildPrefix,
  onUpFromFirstItem,
}: TreeSelectProps<T>): React.ReactNode {
  // 跟踪哪些节点被展开（当不受外部控制时使用内部状态）
  const [internalExpandedIds, setInternalExpandedIds] = React.useState<Set<string | number>>(new Set());

  // 跟踪是否正在以编程方式设置焦点，以避免无限循环
  const isProgrammaticFocusRef = React.useRef(false);

  // 跟踪上次聚焦的 ID 以防止重复 focus 调用
  const lastFocusedIdRef = React.useRef<string | number | null>(null);

  // 判断节点是否展开（如果提供了外部函数则使用它，否则使用内部状态）
  const isExpanded = React.useCallback(
    (nodeId: string | number): boolean => {
      if (isNodeExpanded) {
        return isNodeExpanded(nodeId);
      }
      return internalExpandedIds.has(nodeId);
    },
    [isNodeExpanded, internalExpandedIds],
  );

  // 将树扁平化为线性列表以供 Select 组件使用
  const flattenedNodes = React.useMemo((): FlattenedNode<T>[] => {
    const result: FlattenedNode<T>[] = [];

    function traverse(node: TreeNode<T>, depth: number, parentId?: string | number): void {
      const hasChildren = !!node.children && node.children.length > 0;
      const nodeIsExpanded = isExpanded(node.id);

      result.push({
        node,
        depth,
        isExpanded: nodeIsExpanded,
        hasChildren,
        parentId,
      });

      // 仅当此节点展开时才遍历子节点
      if (hasChildren && nodeIsExpanded && node.children) {
        for (const child of node.children) {
          traverse(child, depth + 1, node.id);
        }
      }
    }

    for (const node of nodes) {
      traverse(node, 0);
    }

    return result;
  }, [nodes, isExpanded]);

  // 默认前缀函数
  const defaultGetParentPrefix = React.useCallback((isExpanded: boolean): string => (isExpanded ? '▼ ' : '▶ '), []);
  const defaultGetChildPrefix = React.useCallback((_depth: number): string => '  ▸ ', []);

  const parentPrefixFn = getParentPrefix ?? defaultGetParentPrefix;
  const childPrefixFn = getChildPrefix ?? defaultGetChildPrefix;

  // 根据树位置构建带有相应前缀的标签
  const buildLabel = React.useCallback(
    (flatNode: FlattenedNode<T>): string => {
      let prefix = '';

      if (flatNode.hasChildren) {
        // 带有子节点的父节点
        prefix = parentPrefixFn(flatNode.isExpanded);
      } else if (flatNode.depth > 0) {
        // 子节点
        prefix = childPrefixFn(flatNode.depth);
      }

      return prefix + flatNode.node.label;
    },
    [parentPrefixFn, childPrefixFn],
  );

  // 将扁平化节点转换为 Select 选项
  const options = React.useMemo((): OptionWithDescription<string | number>[] => {
    return flattenedNodes.map(flatNode => ({
      label: buildLabel(flatNode),
      description: flatNode.node.description,
      dimDescription: flatNode.node.dimDescription ?? true,
      value: flatNode.node.id,
    }));
  }, [flattenedNodes, buildLabel]);

  // 从节点 ID 到实际节点的映射，用于快速查找
  const nodeMap = React.useMemo(() => {
    const map = new Map<string | number, TreeNode<T>>();
    flattenedNodes.forEach(fn => map.set(fn.node.id, fn.node));
    return map;
  }, [flattenedNodes]);

  // 通过 ID 查找扁平化节点
  const findFlattenedNode = React.useCallback(
    (nodeId: string | number): FlattenedNode<T> | undefined => {
      return flattenedNodes.find(fn => fn.node.id === nodeId);
    },
    [flattenedNodes],
  );

  // 处理展开/折叠
  const toggleExpand = React.useCallback(
    (nodeId: string | number, shouldExpand: boolean) => {
      const flatNode = findFlattenedNode(nodeId);
      if (!flatNode || !flatNode.hasChildren) return;

      if (shouldExpand) {
        if (onExpand) {
          onExpand(nodeId);
        } else {
          setInternalExpandedIds(prev => new Set(prev).add(nodeId));
        }
      } else {
        if (onCollapse) {
          onCollapse(nodeId);
        } else {
          setInternalExpandedIds(prev => {
            const newSet = new Set(prev);
            newSet.delete(nodeId);
            return newSet;
          });
        }
      }
    },
    [findFlattenedNode, onExpand, onCollapse],
  );

  // 处理用于展开/折叠的左/右方向键
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!focusNodeId || isDisabled) return;

    const flatNode = findFlattenedNode(focusNodeId);
    if (!flatNode) return;

    if (e.key === 'right' && flatNode.hasChildren) {
      // 展开焦点节点（仅当其有子节点时）
      e.preventDefault();
      toggleExpand(focusNodeId, true);
    } else if (e.key === 'left') {
      if (flatNode.hasChildren && flatNode.isExpanded) {
        // 折叠焦点父节点
        e.preventDefault();
        toggleExpand(focusNodeId, false);
      } else if (flatNode.parentId !== undefined) {
        // 如果这是一个子节点，或者一个有父节点的折叠父节点，
        // 折叠其父节点并聚焦它
        e.preventDefault();
        isProgrammaticFocusRef.current = true;
        toggleExpand(flatNode.parentId, false);
        if (onFocus) {
          const parentNode = nodeMap.get(flatNode.parentId);
          if (parentNode) {
            onFocus(parentNode);
          }
        }
      }
    }
  };

  // 处理选择
  const handleChange = React.useCallback(
    (nodeId: string | number) => {
      const node = nodeMap.get(nodeId);
      if (!node) return;

      // 总是选中节点 - 展开/折叠由方向键处理
      onSelect(node);
    },
    [nodeMap, onSelect],
  );

  // 处理焦点变化
  const handleFocus = React.useCallback(
    (nodeId: string | number) => {
      // 如果是编程方式的焦点变化则跳过
      if (isProgrammaticFocusRef.current) {
        isProgrammaticFocusRef.current = false;
        return;
      }

      // 如果同一节点已经聚焦则跳过
      if (lastFocusedIdRef.current === nodeId) {
        return;
      }
      lastFocusedIdRef.current = nodeId;

      if (onFocus) {
        const node = nodeMap.get(nodeId);
        if (node) {
          onFocus(node);
        }
      }
    },
    [onFocus, nodeMap],
  );

  return (
    <Box tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Select
        options={options}
        onChange={handleChange}
        onFocus={handleFocus}
        onCancel={onCancel}
        defaultFocusValue={focusNodeId}
        visibleOptionCount={visibleOptionCount}
        layout={layout}
        isDisabled={isDisabled}
        hideIndexes={hideIndexes}
        onUpFromFirstItem={onUpFromFirstItem}
      />
    </Box>
  );
}
