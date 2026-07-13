import { useEffect, useRef, useState } from 'react'
import { Eraser, Pencil, RotateCcw, Save, Trash2, X } from 'lucide-react'
import type { ArtifactRef } from '../../core/types.js'

export function ImageMarkupEditor({ artifact, mode, onClose, onSave }: {
  artifact: ArtifactRef
  mode: 'annotation' | 'mask'
  onClose: () => void
  onSave: (blob: Blob, notes: string) => Promise<void>
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const history = useRef<ImageData[]>([])
  const [brush, setBrush] = useState(28)
  const [tool, setTool] = useState<'draw' | 'erase'>(mode === 'mask' ? 'erase' : 'draw')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [historySize, setHistorySize] = useState(0)

  const resetCanvas = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (mode === 'mask') {
      ctx.fillStyle = 'rgba(255,255,255,1)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
  }

  useEffect(() => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      const canvas = canvasRef.current!
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      history.current = []
      setHistorySize(0)
      resetCanvas()
    }
    image.src = artifact.url
  }, [artifact.url, mode])

  const snapshot = () => {
    const canvas = canvasRef.current!
    history.current.push(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height))
    if (history.current.length > 30) history.current.shift()
    setHistorySize(history.current.length)
  }
  const undo = () => {
    const previous = history.current.pop()
    if (previous) canvasRef.current!.getContext('2d')!.putImageData(previous, 0, 0)
    setHistorySize(history.current.length)
  }
  const clear = () => { snapshot(); resetCanvas() }
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }
  }
  const draw = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const p = point(event)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = brush * canvas.width / canvas.getBoundingClientRect().width
    ctx.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over'
    ctx.strokeStyle = mode === 'mask' ? 'rgba(255,255,255,1)' : 'rgba(239,68,68,0.95)'
    ctx.lineTo(p.x, p.y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(p.x, p.y)
  }
  const begin = (event: React.PointerEvent<HTMLCanvasElement>) => {
    snapshot()
    drawing.current = true
    canvasRef.current?.setPointerCapture(event.pointerId)
    const p = point(event)
    const ctx = canvasRef.current!.getContext('2d')!
    ctx.beginPath(); ctx.moveTo(p.x, p.y); draw(event)
  }
  const end = () => { drawing.current = false; canvasRef.current?.getContext('2d')?.beginPath() }
  const save = async () => {
    setSaving(true)
    try {
      const blob = await new Promise<Blob>((resolve, reject) => canvasRef.current!.toBlob((value) => value ? resolve(value) : reject(new Error('Canvas export failed.')), 'image/png'))
      await onSave(blob, notes)
      onClose()
    } finally { setSaving(false) }
  }
  return (
    <div className="modal-backdrop">
      <section className="modal-card markup-modal">
        <header><div><strong>{mode === 'mask' ? 'Mask Editor' : '批注工具'}</strong><small>{mode === 'mask' ? '透明区域允许模型编辑；白色区域保持保护。' : '用红色画笔标记区域，并填写精确修改要求。'}</small></div><button onClick={onClose}><X /></button></header>
        <div className="markup-toolbar">
          <button className={tool === 'draw' ? 'active' : ''} onClick={() => setTool('draw')}><Pencil size={15} />{mode === 'mask' ? '恢复保护' : '画笔'}</button>
          <button className={tool === 'erase' ? 'active' : ''} onClick={() => setTool('erase')}><Eraser size={15} />{mode === 'mask' ? '涂抹编辑区' : '橡皮'}</button>
          <button onClick={undo} disabled={!historySize}><RotateCcw size={15} />撤销</button>
          <button onClick={clear}><Trash2 size={15} />清空</button>
          <label>笔刷 <input type="range" min="4" max="80" value={brush} onChange={(e) => setBrush(Number(e.target.value))} /></label>
        </div>
        <div className="markup-stage">
          <img src={artifact.url} alt={artifact.fileName} />
          <canvas ref={canvasRef} className={mode === 'mask' ? 'mask-canvas' : ''} onPointerDown={begin} onPointerMove={draw} onPointerUp={end} onPointerCancel={end} />
        </div>
        <textarea placeholder="补充批注文字，例如：鹿角简化为三个分叉，保持脸部、姿态与配色不变。" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        <footer><button onClick={onClose}>取消</button><button className="primary" onClick={() => void save()} disabled={saving}><Save size={15} />{saving ? '保存中…' : '保存到画布'}</button></footer>
      </section>
    </div>
  )
}
