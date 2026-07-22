/**
 * 箭头标注文档模型与纯函数。
 *
 * 设计原则:
 * - 所有标注使用归一化坐标 [0,1],避免画布显示尺寸变化影响落点。
 * - notes 使用稳定的人类可读格式,方便 provider 拼入 prompt,也便于人眼审查。
 * - 渲染相关代码依赖 DOM canvas,因此只放在组件层;这里只保留可测试的几何与序列化逻辑。
 */

export type AnnotationColor = 'red' | 'yellow' | 'orange'

export interface NormalizedPoint {
  /** 归一化横坐标 [0,1],相对源图宽度。 */
  x: number
  /** 归一化纵坐标 [0,1],相对源图高度。 */
  y: number
}

export interface ArrowAnnotation {
  id: string
  type: 'arrow'
  from: NormalizedPoint
  to: NormalizedPoint
  label: string
  color: AnnotationColor
}

export interface StrokeAnnotation {
  id: string
  type: 'stroke'
  /** 归一化点集,至少包含两个点。 */
  points: NormalizedPoint[]
  color: AnnotationColor
}

export interface TextAnnotation {
  id: string
  type: 'text'
  /** 归一化锚点 [0,1],文字标签左上角的位置。 */
  position: NormalizedPoint
  text: string
  color: AnnotationColor
}

export interface AnnotationDocument {
  arrows: ArrowAnnotation[]
  strokes: StrokeAnnotation[]
  texts: TextAnnotation[]
  /** 全局补充说明,例如”保持脸部与构图不变”。 */
  notes: string
}

/** 将归一化坐标格式化为可读百分比,固定保留一位小数。 */
export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/**
 * 计算箭头头部两个端点,返回 [左翼, 右翼]。
 *
 * @param from 起点像素坐标
 * @param to 终点像素坐标
 * @param size 箭头长度(像素),会作为两条翼线的近似长度
 */
export function arrowHeadPoints(from: { x: number; y: number }, to: { x: number; y: number }, size: number): [{ x: number; y: number }, { x: number; y: number }] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  // 单位方向向量
  const ux = dx / length
  const uy = dy / length
  // 顺时针与逆时针 90 度的法向量
  const nx = -uy
  const ny = ux
  // 翼线在主方向上回退 size,法向偏移 0.5 倍 size,形成对称箭头
  const back = size
  const side = 0.5 * size
  const baseX = to.x - ux * back
  const baseY = to.y - uy * back
  return [
    { x: baseX + nx * side, y: baseY + ny * side },
    { x: baseX - nx * side, y: baseY - ny * side }
  ]
}

/** 判断标注文档是否有可提交内容:至少一个箭头、一条非空笔画、一个非空文字或一段非空说明。 */
export function hasAnnotationContent(document: AnnotationDocument): boolean {
  if (document.arrows.length > 0) return true
  if (document.strokes.some((stroke) => stroke.points.length > 0)) return true
  if (document.texts.some((text) => text.text.trim())) return true
  return Boolean(document.notes.trim())
}

/**
 * 将标注文档序列化为稳定的人类可读 notes。
 *
 * 示例:
 * ```
 * 全局要求:保持脸部与构图不变。
 * 箭头 1:从 (20.0%, 70.0%) 指向 (55.0%, 45.0%);说明:把眼睛改成蓝色;颜色:red。
 * ```
 *
 * 注意:provider 端会把它整体作为 metadata.notes 拼入 image.edit prompt,
 * 因此这里不要输出 JSON,要保持自然语言可读。
 */
export function serializeAnnotationNotes(document: AnnotationDocument): string {
  const lines: string[] = []
  const notes = document.notes.trim()
  if (notes) lines.push(`全局要求：${notes}`)
  document.arrows.forEach((arrow, index) => {
    const segments = [
      `从 (${formatPercent(arrow.from.x)}, ${formatPercent(arrow.from.y)}) 指向 (${formatPercent(arrow.to.x)}, ${formatPercent(arrow.to.y)})`
    ]
    if (arrow.label.trim()) segments.push(`说明:${arrow.label.trim()}`)
    segments.push(`颜色:${arrow.color}`)
    lines.push(`箭头 ${index + 1}:${segments.join(';')}。`)
  })
  document.texts.forEach((text, index) => {
    if (text.text.trim()) {
      lines.push(`文字 ${index + 1}:位置 (${formatPercent(text.position.x)}, ${formatPercent(text.position.y)});内容:${text.text.trim()};颜色:${text.color}。`)
    }
  })
  return lines.join('\n')
}
