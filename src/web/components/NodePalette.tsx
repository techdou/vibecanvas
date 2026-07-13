import { Bot, Boxes, FileInput, ImagePlus, SlidersHorizontal, StickyNote } from 'lucide-react'
import type { NodeDefinition } from '../../core/types.js'

interface Props {
  registry: NodeDefinition[]
  onAdd: (nodeType: string) => void
}

const categoryLabels: Record<string, string> = {
  input: '输入', agent: 'Agent', generation: '图像生成', processing: '图像处理', control: '控制', output: '输出', canvas: '自由画布'
}

const icons = [FileInput, Bot, ImagePlus, SlidersHorizontal, Boxes, StickyNote]

export function NodePalette({ registry, onAdd }: Props) {
  const grouped = registry.reduce<Record<string, NodeDefinition[]>>((acc, item) => {
    ;(acc[item.category] ??= []).push(item)
    return acc
  }, {})
  const groups = Object.entries(grouped)
  return (
    <aside className="palette panel-shell">
      <div className="panel-title"><Boxes size={17} /><span>节点库</span></div>
      <p className="panel-help">点击添加节点；在画布上拖动节点并连接对应端口。</p>
      <div className="palette-scroll">
        {groups.map(([category, definitions], groupIndex) => {
          const GroupIcon = icons[groupIndex % icons.length]
          return (
            <section key={category} className="palette-group">
              <h3><GroupIcon size={14} /> {categoryLabels[category] || category}</h3>
              {definitions?.map((definition) => (
                <button key={definition.type} className="palette-item" onClick={() => onAdd(definition.type)} title={definition.description}>
                  <span>{definition.label}</span><small>{definition.type}</small>
                </button>
              ))}
            </section>
          )
        })}
      </div>
    </aside>
  )
}
