export function claudeModelSupportsEffort(model: string): boolean {
  return !model
    .trim()
    .toLowerCase()
    .split(/[-_.]/)
    .includes('haiku')
}
