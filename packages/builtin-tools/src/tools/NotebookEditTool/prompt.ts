export const DESCRIPTION =
  '替换 Jupyter notebook 中特定单元格的内容。'
export const PROMPT = `完全替换 Jupyter notebook（.ipynb 文件）中特定单元格的内容为新的 source。Jupyter notebook 是一种交互式文档，结合了代码、文本和可视化，通常用于数据分析和科学计算。notebook_path 参数必须是绝对路径，不能是相对路径。cell_number 从 0 开始索引。使用 edit_mode=insert 可在 cell_number 指定的索引处添加新单元格。使用 edit_mode=delete 可删除 cell_number 指定索引处的单元格。`
