// The four built-in feature ids, in the order the tree draws them. Single source
// so a new built-in plane is added here and every consumer follows.
export const BUILTIN_FEATURE_IDS: ReadonlySet<string> = new Set([
  'Origin', 'Top', 'Front', 'Right',
])
