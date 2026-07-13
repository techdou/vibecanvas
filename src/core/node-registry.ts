import type { NodeDefinition } from './types.js'

export const NODE_REGISTRY: NodeDefinition[] = [
  {
    type: 'input.brief', version: '2.0.0', label: '创作需求', category: 'input', description: '输入自然语言创作目标、用途和限制条件。',
    inputs: [], outputs: [{ id: 'text', label: '需求文本', type: 'Text', required: true }],
    configFields: [{ key: 'text', label: '创作需求', type: 'textarea', default: '描述要创作的图片、用途、风格和必须保留的内容。' }], defaultSize: { width: 300, height: 190 }
  },
  {
    type: 'input.prompt', version: '2.0.0', label: '文本 Prompt', category: 'input', description: '直接提供最终或半成品 Prompt。',
    inputs: [], outputs: [{ id: 'text', label: 'Prompt', type: 'Text', required: true }],
    configFields: [{ key: 'text', label: 'Prompt', type: 'textarea', default: '' }]
  },
  {
    type: 'input.image', version: '2.0.0', label: '参考图片', category: 'input', description: '上传主体、风格、构图、色彩或角色一致性参考图。',
    inputs: [], outputs: [{ id: 'image', label: '图片', type: 'Image', required: true }],
    configFields: [
      { key: 'artifactId', label: '图片', type: 'image' },
      { key: 'role', label: '参考角色', type: 'select', default: 'style', options: [
        { label: '风格参考', value: 'style' }, { label: '主体参考', value: 'subject' }, { label: '构图参考', value: 'composition' },
        { label: '色彩参考', value: 'color' }, { label: '角色一致性', value: 'character' }
      ] }
    ], defaultSize: { width: 320, height: 320 }
  },
  {
    type: 'input.mask', version: '2.0.0', label: '编辑蒙版', category: 'input', description: '由 Mask Editor 生成的透明 PNG 蒙版。透明区域表示允许编辑。',
    inputs: [], outputs: [{ id: 'mask', label: '蒙版', type: 'Mask', required: true }],
    configFields: [{ key: 'artifactId', label: '蒙版', type: 'image' }], defaultSize: { width: 300, height: 300 }
  },
  {
    type: 'input.annotation', version: '2.0.0', label: '批注输入', category: 'input', description: '保存画布上的箭头、画笔和文字批注，供 Agent 解析修改意图。',
    inputs: [], outputs: [{ id: 'annotation', label: '批注图', type: 'Annotation', required: true }, { id: 'text', label: '批注文字', type: 'Text' }],
    configFields: [{ key: 'artifactId', label: '批注图', type: 'image' }, { key: 'text', label: '批注文字', type: 'textarea', default: '' }], defaultSize: { width: 300, height: 300 }
  },
  {
    type: 'utility.aspect-ratio', version: '2.0.0', label: '尺寸与比例', category: 'input', description: '定义生成图目标分辨率和画布比例。',
    inputs: [], outputs: [{ id: 'ratio', label: '尺寸', type: 'AspectRatio', required: true }],
    configFields: [
      { key: 'width', label: '宽度', type: 'number', default: 1024, min: 16, max: 3840, step: 16 },
      { key: 'height', label: '高度', type: 'number', default: 1024, min: 16, max: 3840, step: 16 }
    ]
  },
  {
    type: 'agent.prompt-architect', version: '2.0.0', label: 'Agent Prompt 设计', category: 'agent', description: '将创作需求和参考图角色整理为结构化视觉规范与最终 Prompt。',
    inputs: [{ id: 'brief', label: '创作需求', type: 'Text', required: true }, { id: 'references', label: '参考图', type: 'ImageArray', multiple: true }],
    outputs: [{ id: 'promptSpec', label: 'PromptSpec', type: 'PromptSpec', required: true }],
    configFields: [
      { key: 'strategy', label: '策略', type: 'select', default: 'dynamic', options: [
        { label: '动态设计', value: 'dynamic' }, { label: '忠实扩写', value: 'faithful' }, { label: '创意探索', value: 'creative' }
      ] },
      { key: 'extraConstraints', label: '额外约束', type: 'textarea', default: '' },
      { key: 'useOpenCode', label: '使用 OpenCode Agent', type: 'boolean', default: true }
    ]
  },
  {
    type: 'image.generate', version: '2.0.0', label: 'Image 2 文生图', category: 'generation', description: '通过 OpenAI 兼容 Images API 生成一张或多张高质量图片。',
    inputs: [{ id: 'prompt', label: 'Prompt', type: 'PromptSpec', required: true }, { id: 'size', label: '尺寸', type: 'AspectRatio' }],
    outputs: [{ id: 'images', label: '候选图片', type: 'ImageSet', required: true }, { id: 'metadata', label: '元数据', type: 'Metadata' }],
    configFields: [
      { key: 'quality', label: '质量', type: 'select', default: 'high', options: [
        { label: 'Low', value: 'low' }, { label: 'Medium', value: 'medium' }, { label: 'High', value: 'high' }, { label: 'Auto', value: 'auto' }
      ] },
      { key: 'candidateCount', label: '候选数量', type: 'number', default: 1, min: 1, max: 8 },
      { key: 'outputFormat', label: '格式', type: 'select', default: 'png', options: [
        { label: 'PNG', value: 'png' }, { label: 'WebP', value: 'webp' }, { label: 'JPEG', value: 'jpeg' }
      ] }
    ], defaultSize: { width: 340, height: 300 }
  },
  {
    type: 'image.edit', version: '2.0.0', label: 'Image 2 图生图', category: 'generation', description: '使用原图、多参考图、批注和可选蒙版进行定向编辑或变体生成。',
    inputs: [
      { id: 'source', label: '原图', type: 'Image', required: true }, { id: 'prompt', label: 'Prompt', type: 'PromptSpec', required: true },
      { id: 'references', label: '参考图', type: 'ImageArray', multiple: true }, { id: 'annotation', label: '批注图', type: 'Annotation' },
      { id: 'mask', label: '遮罩', type: 'Mask' }, { id: 'size', label: '尺寸', type: 'AspectRatio' }
    ],
    outputs: [{ id: 'images', label: '修订图片', type: 'ImageSet', required: true }, { id: 'metadata', label: '元数据', type: 'Metadata' }],
    configFields: [
      { key: 'quality', label: '质量', type: 'select', default: 'high', options: [
        { label: 'Low', value: 'low' }, { label: 'Medium', value: 'medium' }, { label: 'High', value: 'high' }
      ] },
      { key: 'candidateCount', label: '候选数量', type: 'number', default: 1, min: 1, max: 8 },
      { key: 'annotationInstruction', label: '批注补充说明', type: 'textarea', default: '根据批注区域修改，最终图不要包含批注痕迹、箭头或界面元素。' }
    ], defaultSize: { width: 340, height: 320 }
  },
  {
    type: 'image.resize', version: '2.0.0', label: '裁剪与缩放', category: 'processing', description: '本地调整图片尺寸，支持 contain、cover 和 fill。',
    inputs: [{ id: 'image', label: '图片', type: 'Image', required: true }, { id: 'size', label: '尺寸', type: 'AspectRatio' }],
    outputs: [{ id: 'image', label: '处理图片', type: 'Image', required: true }],
    configFields: [
      { key: 'width', label: '宽度', type: 'number', default: 1024, min: 16, max: 8192 }, { key: 'height', label: '高度', type: 'number', default: 1024, min: 16, max: 8192 },
      { key: 'fit', label: '适配', type: 'select', default: 'contain', options: [
        { label: 'Contain', value: 'contain' }, { label: 'Cover', value: 'cover' }, { label: 'Fill', value: 'fill' }
      ] }
    ]
  },
  {
    type: 'review.quality', version: '2.0.0', label: 'Agent Vision Review', category: 'agent', description: '先进行技术质量门，再由 OpenCode 视觉 Agent 比较需求符合度、主体、构图、文字和参考图遵循度。',
    inputs: [{ id: 'images', label: '候选图片', type: 'ImageSet', required: true }, { id: 'brief', label: '评审要求', type: 'Text' }],
    outputs: [{ id: 'selected', label: '最佳图片', type: 'Image', required: true }, { id: 'images', label: '评审后候选', type: 'ImageSet', required: true }, { id: 'report', label: '评审报告', type: 'EvaluationReport', required: true }],
    configFields: [
      { key: 'minimumScore', label: '最低分', type: 'number', default: 70, min: 0, max: 100 },
      { key: 'reviewMode', label: '评审模式', type: 'select', default: 'hybrid', options: [
        { label: '技术检查', value: 'technical' }, { label: 'OpenCode Agent', value: 'agent' }, { label: '混合评审', value: 'hybrid' }
      ] }
    ]
  },
  {
    type: 'control.human-select', version: '2.0.0', label: '候选图片选择器', category: 'control', description: '暂停工作流并在画布中以图片网格选择一个候选结果。',
    inputs: [{ id: 'images', label: '候选图片', type: 'ImageSet', required: true }], outputs: [{ id: 'selected', label: '选中图片', type: 'Image', required: true }],
    configFields: [{ key: 'selectedArtifactId', label: '已选 Artifact ID', type: 'text', default: '' }, { key: 'autoSelectSingle', label: '仅一张时自动选择', type: 'boolean', default: true }]
  },
  {
    type: 'workflow.subflow', version: '2.0.0', label: '子工作流', category: 'workflow', description: '运行保存的模板或嵌套工作流，将复杂创作步骤封装为一个节点。',
    inputs: [{ id: 'input', label: '输入', type: 'Any', multiple: true }], outputs: [{ id: 'output', label: '输出', type: 'Any' }, { id: 'metadata', label: '运行信息', type: 'Metadata' }],
    configFields: [{ key: 'templateId', label: '子工作流模板 ID', type: 'text', default: '' }, { key: 'inputNodeId', label: '输入节点 ID（可选）', type: 'text', default: '' }, { key: 'outputNodeId', label: '输出节点 ID', type: 'text', default: '' }], defaultSize: { width: 360, height: 240 }
  },
  {
    type: 'output.canvas', version: '2.0.0', label: '输出到画布', category: 'output', description: '将结果作为可继续分支的图片节点放到无限画布，支持真正原位替换。',
    inputs: [{ id: 'image', label: '图片', type: 'Image', required: true }], outputs: [{ id: 'artifact', label: '画布素材', type: 'ArtifactRef', required: true }],
    configFields: [
      { key: 'placement', label: '位置', type: 'select', default: 'right', options: [
        { label: '右侧', value: 'right' }, { label: '下方', value: 'below' }, { label: '原位替换', value: 'replace' }
      ] },
      { key: 'replaceNodeId', label: '替换目标节点 ID', type: 'text', default: '' },
      { key: 'markFinal', label: '标记为最终版本', type: 'boolean', default: false }
    ]
  },
  {
    type: 'canvas.note', version: '2.0.0', label: '便签', category: 'canvas', description: '自由画布中的说明或修改要求，可连接到 Prompt 设计节点。',
    inputs: [], outputs: [{ id: 'text', label: '文本', type: 'Text' }], configFields: [{ key: 'text', label: '内容', type: 'textarea', default: '添加创意说明。' }], defaultSize: { width: 280, height: 180 }
  },
  {
    type: 'canvas.annotation', version: '2.0.0', label: '画布批注', category: 'canvas', description: '保存对源图片的画笔、箭头和文字批注。',
    inputs: [{ id: 'source', label: '原图', type: 'Image' }], outputs: [{ id: 'annotation', label: '批注图', type: 'Annotation' }, { id: 'text', label: '批注文字', type: 'Text' }],
    configFields: [{ key: 'artifactId', label: '批注图', type: 'image' }, { key: 'sourceArtifactId', label: '源图片 ID', type: 'text' }, { key: 'text', label: '批注文字', type: 'textarea', default: '' }], defaultSize: { width: 340, height: 340 }
  },
  {
    type: 'canvas.image', version: '2.0.0', label: '图片素材', category: 'canvas', description: '画布上的生成结果或外部图片，可作为后续图生图输入并打开批注、蒙版编辑器。',
    inputs: [{ id: 'imageIn', label: '图片', type: 'Image' }], outputs: [{ id: 'image', label: '图片', type: 'Image', required: true }],
    configFields: [{ key: 'artifactId', label: '图片', type: 'image' }], defaultSize: { width: 380, height: 380 }
  }
]

export const NODE_REGISTRY_MAP = new Map(NODE_REGISTRY.map((definition) => [definition.type, definition]))
export function getNodeDefinition(type: string): NodeDefinition | undefined { return NODE_REGISTRY_MAP.get(type) }
export function defaultConfigForNode(type: string): Record<string, unknown> {
  const definition = getNodeDefinition(type)
  return definition ? Object.fromEntries(definition.configFields.filter((field) => field.default !== undefined).map((field) => [field.key, field.default])) : {}
}
