import { describe, expect, it } from 'vitest'
import {
  arrowHeadPoints,
  hasAnnotationContent,
  serializeAnnotationNotes,
  type AnnotationDocument
} from '../src/web/lib/image-annotation.js'

describe('image annotations', () => {
  it('serializes normalized arrow positions and labels into readable notes', () => {
    const document: AnnotationDocument = {
      arrows: [{
        id: 'arrow-1',
        type: 'arrow',
        from: { x: 0.2, y: 0.7 },
        to: { x: 0.55, y: 0.45 },
        label: '把眼睛改成蓝色',
        color: 'red'
      }],
      strokes: [],
      texts: [],
      notes: '保持脸部与构图不变。'
    }

    expect(serializeAnnotationNotes(document)).toBe([
      '全局要求：保持脸部与构图不变。',
      '箭头 1:从 (20.0%, 70.0%) 指向 (55.0%, 45.0%);说明:把眼睛改成蓝色;颜色:red。'
    ].join('\n'))
  })

  it('serializes text annotations with their position', () => {
    const document: AnnotationDocument = {
      arrows: [],
      strokes: [],
      texts: [{
        id: 'text-1',
        type: 'text',
        position: { x: 0.3, y: 0.8 },
        text: '背景换成蓝天',
        color: 'yellow'
      }],
      notes: ''
    }

    expect(serializeAnnotationNotes(document)).toBe(
      '文字 1:位置 (30.0%, 80.0%);内容:背景换成蓝天;颜色:yellow。'
    )
  })

  it('calculates a symmetric arrow head at the target point', () => {
    const [left, right] = arrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 20)
    expect(left.x).toBeCloseTo(80)
    expect(right.x).toBeCloseTo(80)
    expect(left.y).toBeCloseTo(10)
    expect(right.y).toBeCloseTo(-10)
  })

  it('requires a visible mark or a written instruction', () => {
    expect(hasAnnotationContent({ arrows: [], strokes: [], texts: [], notes: '  ' })).toBe(false)
    expect(hasAnnotationContent({ arrows: [], strokes: [], texts: [], notes: '只调整背景' })).toBe(true)
    expect(hasAnnotationContent({ arrows: [], strokes: [], texts: [{ id: 't', type: 'text', position: { x: 0.5, y: 0.5 }, text: '改这里', color: 'red' }], notes: '' })).toBe(true)
  })
})
