// Eager-load all icon SVGs once so any module can look them up by filename
// at runtime. Keys are absolute (e.g. `/src/assets/icons/<name>.svg`).
export const iconModules = import.meta.glob('@/assets/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>
