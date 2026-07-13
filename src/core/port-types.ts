const TYPE_COMPATIBILITY: Record<string, string[]> = {
  Any: ['Any', 'Text', 'PromptSpec', 'Image', 'ImageSet', 'ImageArray', 'Mask', 'Annotation', 'AspectRatio', 'EvaluationReport', 'ArtifactRef', 'Metadata', 'Boolean', 'Number'],
  ImageArray: ['Image', 'ImageSet', 'ImageArray'],
  ImageSet: ['ImageSet'], Image: ['Image'], Text: ['Text'], PromptSpec: ['PromptSpec'],
  Mask: ['Mask', 'Image'], Annotation: ['Annotation', 'Image'], AspectRatio: ['AspectRatio'], EvaluationReport: ['EvaluationReport'],
  ArtifactRef: ['ArtifactRef', 'Image'], Metadata: ['Metadata'], Boolean: ['Boolean'], Number: ['Number']
}

export function arePortTypesCompatible(sourceType: string, targetType: string): boolean {
  return targetType === 'Any' || (TYPE_COMPATIBILITY[targetType] ?? [targetType]).includes(sourceType)
}
