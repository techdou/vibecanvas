import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight, Eraser, MousePointer2, Pencil, RotateCcw, Save, Trash2, Type, X
} from 'lucide-react'
import type { ArtifactRef } from '../../core/types.js'
import {
  arrowHeadPoints, hasAnnotationContent, serializeAnnotationNotes,
  type AnnotationColor, type AnnotationDocument, type ArrowAnnotation, type NormalizedPoint, type TextAnnotation
} from '../lib/image-annotation.js'

type AnnotationTool = 'select' | 'arrow' | 'text' | 'brush'

const COLOR_OPTIONS: Array<{ value: AnnotationColor; label: string; hex: string }> = [
  { value: 'red', label: '红', hex: '#ef4444' },
  { value: 'yellow', label: '黄', hex: '#facc15' },
  { value: 'orange', label: '橙', hex: '#f97316' }
]

const COLOR_HEX: Record<AnnotationColor, string> = { red: '#ef4444', yellow: '#facc15', orange: '#f97316' }

interface PendingArrow {
  from: NormalizedPoint
  to: NormalizedPoint
}

interface PendingText {
  position: NormalizedPoint
  text: string
}

export function ImageMarkupEditor({ artifact, mode, onClose, onSave }: {
  artifact: ArtifactRef
  mode: 'annotation' | 'mask'
  onClose: () => void
  onSave: (blob: Blob, notes: string) => Promise<void>
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const drawing = useRef(false)
  const history = useRef<ImageData[]>([])
  const pendingArrowRef = useRef<PendingArrow | null>(null)
  const selectedIdRef = useRef<string | undefined>(undefined)
  const [brush, setBrush] = useState(28)
  const [tool, setTool] = useState<'draw' | 'erase'>(mode === 'mask' ? 'erase' : 'draw')
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>('arrow')
  const [currentColor, setCurrentColor] = useState<AnnotationColor>('red')
  const [arrows, setArrows] = useState<ArrowAnnotation[]>([])
  const [texts, setTexts] = useState<TextAnnotation[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [editingText, setEditingText] = useState('')
  const [pendingText, setPendingText] = useState<PendingText | null>(null)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [historySize, setHistorySize] = useState(0)
  const [imageNaturalSize, setImageNaturalSize] = useState({ width: 1024, height: 1024 })

  selectedIdRef.current = selectedId

  // ----- Mask 模式初始化 -----
  const resetMaskCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (mode === 'mask') {
      ctx.fillStyle = 'rgba(255,255,255,1)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
  }, [mode])

  useEffect(() => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      imageRef.current = image
      const canvas = canvasRef.current!
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      setImageNaturalSize({ width: image.naturalWidth, height: image.naturalHeight })
      history.current = []
      setHistorySize(0)
      resetMaskCanvas()
    }
    image.src = artifact.url
  }, [artifact.url, mode, resetMaskCanvas])

  // ----- 坐标转换 -----
  const toNormalized = useCallback((event: React.PointerEvent<HTMLCanvasElement>): NormalizedPoint => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const x = (event.clientX - rect.left) * canvas.width / rect.width
    const y = (event.clientY - rect.top) * canvas.height / rect.height
    return {
      x: Math.max(0, Math.min(1, x / canvas.width)),
      y: Math.max(0, Math.min(1, y / canvas.height))
    }
  }, [])

  // ----- 绘制 annotation overlay(箭头 + 文字 + 画笔 raster) -----
  const drawOverlay = useCallback(() => {
    if (mode !== 'annotation') return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    // 不 clearRect — 画笔 raster 已在 canvas 上。只叠加矢量元素。
    // 但需要重绘矢量元素时先擦掉旧的矢量层:用 ImageData 快照 + 恢复策略太重。
    // 简化方案:每次重绘时先 clearRect,然后用 snapshot 保存的画笔 ImageData 恢复。
    // 更实际的方案:把画笔也用矢量点集保存。但当前 brush 直接画 raster。
    // 折中:用 offscreen 保存画笔层,每次重绘时先 clearRect 再 composite。
    // 这里采用最简单方案:用 history.last 作为画笔底图。
    const brushLayer = history.current.length > 0 ? history.current[history.current.length - 1] : null
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (brushLayer) ctx.putImageData(brushLayer, 0, 0)

    const scaleX = canvas.width
    const scaleY = canvas.height

    // 箭头
    for (const arrow of arrows) {
      const isSelected = arrow.id === selectedIdRef.current
      const color = COLOR_HEX[arrow.color]
      const fromPx = { x: arrow.from.x * scaleX, y: arrow.from.y * scaleY }
      const toPx = { x: arrow.to.x * scaleX, y: arrow.to.y * scaleY }
      drawArrowShape(ctx, fromPx, toPx, color, isSelected, scaleX)
      if (arrow.label.trim()) drawLabel(ctx, toPx, arrow.label.trim(), color, scaleX, scaleY)
    }

    // 文字标注
    for (const text of texts) {
      if (!text.text.trim()) continue
      const isSelected = text.id === selectedIdRef.current
      const posPx = { x: text.position.x * scaleX, y: text.position.y * scaleY }
      drawTextLabel(ctx, posPx, text.text.trim(), COLOR_HEX[text.color], isSelected, scaleX)
    }

    // 拖拽中的预览箭头
    const pending = pendingArrowRef.current
    if (pending) {
      const fromPx = { x: pending.from.x * scaleX, y: pending.from.y * scaleY }
      const toPx = { x: pending.to.x * scaleX, y: pending.to.y * scaleY }
      ctx.globalAlpha = 0.6
      drawArrowShape(ctx, fromPx, toPx, COLOR_HEX[currentColor], false, scaleX)
      ctx.globalAlpha = 1
    }
  }, [mode, arrows, texts, currentColor])

  useEffect(() => { drawOverlay() }, [drawOverlay])

  // ----- Mask raster 操作 -----
  const snapshot = useCallback(() => {
    const canvas = canvasRef.current!
    history.current.push(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height))
    if (history.current.length > 30) history.current.shift()
    setHistorySize(history.current.length)
  }, [])

  const undo = useCallback(() => {
    if (mode === 'mask') {
      const previous = history.current.pop()
      if (previous) canvasRef.current!.getContext('2d')!.putImageData(previous, 0, 0)
      setHistorySize(history.current.length)
    } else {
      // annotation: 撤销最后一个矢量元素
      if (arrows.length > 0 && (!selectedId || arrows[arrows.length - 1].id === selectedId)) {
        setArrows((current) => current.slice(0, -1))
      } else if (texts.length > 0) {
        setTexts((current) => current.slice(0, -1))
      } else {
        // 没有矢量元素时撤销画笔
        const previous = history.current.pop()
        if (previous) {
          canvasRef.current!.getContext('2d')!.putImageData(previous, 0, 0)
          setHistorySize(history.current.length)
        }
      }
      setSelectedId(undefined)
    }
  }, [mode, arrows, texts, selectedId])

  const drawMaskStroke = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const rect = canvas.getBoundingClientRect()
    const p = { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = brush * canvas.width / rect.width
    ctx.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over'
    ctx.strokeStyle = mode === 'mask' ? 'rgba(255,255,255,1)' : 'rgba(239,68,68,0.85)'
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
  }, [brush, mode, tool])

  // ----- 指针事件 -----
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode === 'mask') {
      snapshot()
      drawing.current = true
      canvasRef.current?.setPointerCapture(event.pointerId)
      const rect = canvasRef.current!.getBoundingClientRect()
      const canvas = canvasRef.current!
      const p = { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }
      const ctx = canvas.getContext('2d')!
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      drawMaskStroke(event)
      return
    }

    const point = toNormalized(event)
    canvasRef.current?.setPointerCapture(event.pointerId)

    if (annotationTool === 'arrow') {
      pendingArrowRef.current = { from: point, to: point }
    } else if (annotationTool === 'text') {
      // 先放一个空文字，进入编辑状态
      const newText: TextAnnotation = {
        id: `text-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'text',
        position: point,
        text: '',
        color: currentColor
      }
      setTexts((current) => [...current, newText])
      setSelectedId(newText.id)
      setEditingText('')
      setPendingText({ position: point, text: '' })
    } else if (annotationTool === 'brush') {
      snapshot()
      drawing.current = true
      const canvas = canvasRef.current!
      const ctx = canvas.getContext('2d')!
      const rect = canvas.getBoundingClientRect()
      const px = (event.clientX - rect.left) * canvas.width / rect.width
      const py = (event.clientY - rect.top) * canvas.height / rect.height
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = brush * canvas.width / rect.width
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = 'rgba(239,68,68,0.85)'
      ctx.beginPath()
      ctx.moveTo(px, py)
    } else if (annotationTool === 'select') {
      const hit = findAnnotationAtPoint(arrows, texts, point, imageNaturalSize)
      setSelectedId(hit?.id)
    }
  }, [mode, annotationTool, snapshot, drawMaskStroke, toNormalized, arrows, texts, imageNaturalSize, brush, currentColor])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode === 'mask') { drawMaskStroke(event); return }
    if (annotationTool === 'arrow' && pendingArrowRef.current) {
      pendingArrowRef.current = { ...pendingArrowRef.current, to: toNormalized(event) }
      drawOverlay()
      return
    }
    if (annotationTool === 'brush' && drawing.current) {
      const canvas = canvasRef.current!
      const ctx = canvas.getContext('2d')!
      const rect = canvas.getBoundingClientRect()
      const px = (event.clientX - rect.left) * canvas.width / rect.width
      const py = (event.clientY - rect.top) * canvas.height / rect.height
      ctx.lineTo(px, py)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(px, py)
    }
  }, [mode, annotationTool, drawMaskStroke, drawOverlay, toNormalized])

  const onPointerUp = useCallback(() => {
    if (mode === 'mask') {
      drawing.current = false
      canvasRef.current?.getContext('2d')?.beginPath()
      return
    }
    if (annotationTool === 'arrow' && pendingArrowRef.current) {
      const { from, to } = pendingArrowRef.current
      const distance = Math.hypot((to.x - from.x) * imageNaturalSize.width, (to.y - from.y) * imageNaturalSize.height)
      if (distance > 12) {
        const newArrow: ArrowAnnotation = {
          id: `arrow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'arrow',
          from,
          to,
          label: '',
          color: currentColor
        }
        setArrows((current) => [...current, newArrow])
        setSelectedId(newArrow.id)
        setEditingText('')
      }
      pendingArrowRef.current = null
    }
    if (annotationTool === 'brush') {
      // 画笔结束后保存 raster 快照
      snapshot()
      drawing.current = false
      canvasRef.current?.getContext('2d')?.beginPath()
    }
  }, [mode, annotationTool, currentColor, imageNaturalSize, snapshot])

  // ----- 选中元素操作 -----
  const selectedArrow = arrows.find((item) => item.id === selectedId)
  const selectedText = texts.find((item) => item.id === selectedId)

  const updateSelectedLabel = useCallback((label: string) => {
    if (!selectedId) return
    setArrows((current) => current.map((item) => item.id === selectedId ? { ...item, label } : item))
  }, [selectedId])

  const updateSelectedText = useCallback((text: string) => {
    if (!selectedId) return
    setTexts((current) => current.map((item) => item.id === selectedId ? { ...item, text } : item))
    setEditingText(text)
  }, [selectedId])

  const changeSelectedColor = useCallback((color: AnnotationColor) => {
    if (!selectedId) { setCurrentColor(color); return }
    setArrows((current) => current.map((item) => item.id === selectedId ? { ...item, color } : item))
    setTexts((current) => current.map((item) => item.id === selectedId ? { ...item, color } : item))
    setCurrentColor(color)
  }, [selectedId])

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    setArrows((current) => current.filter((item) => item.id !== selectedId))
    setTexts((current) => current.filter((item) => item.id !== selectedId))
    setSelectedId(undefined)
    setEditingText('')
  }, [selectedId])

  const clearAll = useCallback(() => {
    if (mode === 'mask') {
      snapshot()
      resetMaskCanvas()
    } else {
      snapshot()
      const canvas = canvasRef.current
      if (canvas) canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height)
      setArrows([])
      setTexts([])
      setSelectedId(undefined)
      setEditingText('')
    }
  }, [mode, snapshot, resetMaskCanvas])

  // ----- 保存 -----
  const canSubmit = useMemo(() => {
    if (mode === 'mask') return true
    const document: AnnotationDocument = { arrows, strokes: [], texts, notes }
    return hasAnnotationContent(document)
  }, [mode, arrows, texts, notes])

  const save = useCallback(async () => {
    setSaving(true)
    try {
      if (mode === 'mask') {
        const blob = await new Promise<Blob>((resolve, reject) => canvasRef.current!.toBlob((value) => value ? resolve(value) : reject(new Error('Canvas export failed.')), 'image/png'))
        await onSave(blob, notes)
        onClose()
        return
      }

      // annotation: 只输出标注层(透明背景 + 箭头 + 文字 + 画笔),不包含源图。
      // 这样文件极小(几十 KB),避免超过 Image API 4MB 限制。
      // 源图通过 edit 工作流的 source 字段单独传递。
      const sourceImage = imageRef.current
      if (!sourceImage) throw new Error('源图未加载。')
      const offscreen = document.createElement('canvas')
      offscreen.width = sourceImage.naturalWidth
      offscreen.height = sourceImage.naturalHeight
      const ctx = offscreen.getContext('2d')!
      // 不 drawImage(sourceImage) — 标注层保持透明背景
      // 只叠加 overlay canvas 上的画笔 raster
      const overlayCanvas = canvasRef.current
      if (overlayCanvas) ctx.drawImage(overlayCanvas, 0, 0)

      const annotationDoc: AnnotationDocument = { arrows, strokes: [], texts, notes }
      const blob = await new Promise<Blob>((resolve, reject) => offscreen.toBlob((value) => value ? resolve(value) : reject(new Error('Annotation export failed.')), 'image/png'))
      await onSave(blob, serializeAnnotationNotes(annotationDoc))
      onClose()
    } finally { setSaving(false) }
  }, [mode, arrows, texts, notes, onClose, onSave])

  return (
    <div className="modal-backdrop">
      <section className="modal-card markup-modal">
        <header>
          <div>
            <strong>{mode === 'mask' ? 'Mask Editor' : '箭头标注修改'}</strong>
            <small>{mode === 'mask'
              ? '透明区域允许模型编辑;白色区域保持保护。'
              : '在图上画箭头或放文字标注指向要修改的区域,填写说明后按标注生成。'}</small>
          </div>
          <button onClick={onClose}><X /></button>
        </header>

        {mode === 'annotation' ? (
          <>
            <div className="markup-toolbar">
              <button className={annotationTool === 'arrow' ? 'active' : ''} onClick={() => setAnnotationTool('arrow')}><ArrowRight size={15} />箭头</button>
              <button className={annotationTool === 'text' ? 'active' : ''} onClick={() => setAnnotationTool('text')}><Type size={15} />文字</button>
              <button className={annotationTool === 'select' ? 'active' : ''} onClick={() => setAnnotationTool('select')}><MousePointer2 size={15} />选择</button>
              <button className={annotationTool === 'brush' ? 'active' : ''} onClick={() => setAnnotationTool('brush')}><Pencil size={15} />画笔</button>
              <span className="toolbar-divider" />
              {COLOR_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={`color-chip ${currentColor === option.value ? 'active' : ''}`}
                  style={{ background: option.hex }}
                  onClick={() => changeSelectedColor(option.value)}
                  title={option.label}
                />
              ))}
              <button onClick={undo}><RotateCcw size={15} />撤销</button>
              <button onClick={clearAll}><Trash2 size={15} />清空</button>
              <label>笔刷 <input type="range" min="4" max="80" value={brush} onChange={(e) => setBrush(Number(e.target.value))} /></label>
            </div>

            {/* 选中元素的内联编辑面板 */}
            {selectedArrow ? (
              <div className="annotation-edit-bar">
                <span className="edit-label">箭头说明</span>
                <input
                  type="text"
                  value={selectedArrow.label}
                  onChange={(e) => updateSelectedLabel(e.target.value)}
                  placeholder="描述这个箭头指向的修改要求…"
                  autoFocus
                />
                <button onClick={deleteSelected}><Trash2 size={13} />删除</button>
              </div>
            ) : null}
            {selectedText ? (
              <div className="annotation-edit-bar">
                <span className="edit-label">文字标注</span>
                <input
                  type="text"
                  value={editingText || selectedText.text}
                  onChange={(e) => updateSelectedText(e.target.value)}
                  placeholder="输入文字标注内容…"
                  autoFocus
                />
                <button onClick={deleteSelected}><Trash2 size={13} />删除</button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="markup-toolbar">
            <button className={tool === 'draw' ? 'active' : ''} onClick={() => setTool('draw')}><Pencil size={15} />恢复保护</button>
            <button className={tool === 'erase' ? 'active' : ''} onClick={() => setTool('erase')}><Eraser size={15} />涂抹编辑区</button>
            <button onClick={undo} disabled={!historySize}><RotateCcw size={15} />撤销</button>
            <button onClick={clearAll}><Trash2 size={15} />清空</button>
            <label>笔刷 <input type="range" min="4" max="80" value={brush} onChange={(e) => setBrush(Number(e.target.value))} /></label>
          </div>
        )}

        <div className="markup-stage">
          <img src={artifact.url} alt={artifact.fileName} />
          <canvas
            ref={canvasRef}
            className={mode === 'mask' ? 'mask-canvas' : ''}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </div>

        <textarea
          placeholder={mode === 'mask'
            ? '补充蒙版说明…'
            : '全局补充要求,例如:保持脸部、姿态与配色不变,只修改标注指向的区域。'}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
        />

        <footer>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void save()} disabled={saving || !canSubmit}>
            <Save size={15} />{saving ? '保存中…' : mode === 'mask' ? '保存到画布' : '按标注生成'}
          </button>
        </footer>
      </section>
    </div>
  )
}

// ===== 绘制辅助函数 =====

function drawArrowShape(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, color: string, selected: boolean, scaleX: number) {
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(3, scaleX * 0.006)
  ctx.lineCap = 'round'
  if (selected) { ctx.shadowColor = color; ctx.shadowBlur = 12 } else { ctx.shadowBlur = 0 }
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()

  const headSize = Math.max(18, scaleX * 0.028)
  const [leftWing, rightWing] = arrowHeadPoints(from, to, headSize)
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(leftWing.x, leftWing.y)
  ctx.lineTo(rightWing.x, rightWing.y)
  ctx.closePath()
  ctx.fill()
  ctx.shadowBlur = 0

  if (selected) {
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.setLineDash([6, 4])
    ctx.beginPath()
    ctx.arc(to.x, to.y, Math.max(22, scaleX * 0.03), 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
  }
}

function drawLabel(ctx: CanvasRenderingContext2D, anchor: { x: number; y: number }, text: string, color: string, scaleX: number, scaleY: number) {
  const fontSize = Math.max(16, scaleX * 0.022)
  ctx.font = `600 ${fontSize}px system-ui, sans-serif`
  ctx.textBaseline = 'top'
  const padX = fontSize * 0.4
  const padY = fontSize * 0.3
  const metrics = ctx.measureText(text)
  const textW = metrics.width + padX * 2
  const textH = fontSize + padY * 2
  const labelX = Math.min(anchor.x + 12, scaleX - textW - 4)
  const labelY = Math.min(anchor.y + 12, scaleY - textH - 4)
  ctx.fillStyle = 'rgba(0,0,0,0.72)'
  ctx.fillRect(labelX, labelY, textW, textH)
  ctx.fillStyle = color
  ctx.fillRect(labelX, labelY, 4, textH)
  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, labelX + padX, labelY + padY)
}

function drawTextLabel(ctx: CanvasRenderingContext2D, pos: { x: number; y: number }, text: string, color: string, selected: boolean, scaleX: number) {
  const fontSize = Math.max(18, scaleX * 0.024)
  ctx.font = `700 ${fontSize}px system-ui, sans-serif`
  ctx.textBaseline = 'top'
  const padX = fontSize * 0.5
  const padY = fontSize * 0.35
  const metrics = ctx.measureText(text)
  const textW = metrics.width + padX * 2
  const textH = fontSize + padY * 2
  if (selected) { ctx.shadowColor = color; ctx.shadowBlur = 16 } else { ctx.shadowBlur = 4 }
  ctx.fillStyle = 'rgba(0,0,0,0.8)'
  ctx.fillRect(pos.x, pos.y, textW, textH)
  ctx.shadowBlur = 0
  ctx.fillStyle = color
  ctx.fillRect(pos.x, pos.y, 4, textH)
  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, pos.x + padX, pos.y + padY)

  if (selected) {
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.setLineDash([5, 3])
    ctx.strokeRect(pos.x - 2, pos.y - 2, textW + 4, textH + 4)
    ctx.setLineDash([])
  }
}

/**
 * 命中测试:找到点击位置附近的标注元素(箭头线段/终点 或 文字框)。
 * 命中区域扩大到 5% 图片尺寸,优先匹配最近的元素。
 */
function findAnnotationAtPoint(arrows: ArrowAnnotation[], texts: TextAnnotation[], point: NormalizedPoint, imageSize: { width: number; height: number }): { id: string } | undefined {
  const thresholdPx = Math.max(imageSize.width, imageSize.height) * 0.05
  const pointPx = { x: point.x * imageSize.width, y: point.y * imageSize.height }
  let best: { id: string } | undefined
  let bestDist = Infinity

  // 检查文字框(矩形命中)
  for (const text of texts) {
    if (!text.text.trim()) continue
    const fontSize = Math.max(18, imageSize.width * 0.024)
    const posPx = { x: text.position.x * imageSize.width, y: text.position.y * imageSize.height }
    // 近似文字框宽高(命中测试不需要精确)
    const approxW = text.text.length * fontSize * 0.6 + fontSize
    const approxH = fontSize * 1.7
    if (pointPx.x >= posPx.x && pointPx.x <= posPx.x + approxW && pointPx.y >= posPx.y && pointPx.y <= posPx.y + approxH) {
      const dist = 0 // 矩形命中优先级最高
      if (dist < bestDist) { bestDist = dist; best = { id: text.id } }
    }
  }
  if (best) return best

  // 检查箭头(点到线段距离 + 终点命中)
  for (const arrow of arrows) {
    const fromPx = { x: arrow.from.x * imageSize.width, y: arrow.from.y * imageSize.height }
    const toPx = { x: arrow.to.x * imageSize.width, y: arrow.to.y * imageSize.height }
    const distToLine = pointToSegmentDistance(pointPx, fromPx, toPx)
    const distToEnd = Math.hypot(toPx.x - pointPx.x, toPx.y - pointPx.y)
    const dist = Math.min(distToLine, distToEnd)
    if (dist < thresholdPx && dist < bestDist) { bestDist = dist; best = { id: arrow.id } }
  }

  return best
}

function pointToSegmentDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const projX = a.x + t * dx
  const projY = a.y + t * dy
  return Math.hypot(p.x - projX, p.y - projY)
}
