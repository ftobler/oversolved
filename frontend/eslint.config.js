import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// The core folders must run headless in node: no React, no three, no stores,
// components, pages or hooks. The regex is shared with the session layer's
// original fence. A file joins CORE_ALLOW only while a migration is moving it;
// the list is empty when the split is complete.
const CORE_FILES = [
  'src/kernel/**/*.{ts,tsx}',
  'src/drive/**/*.{ts,tsx}',
  'src/session/**/*.{ts,tsx}',
  'src/persistence/**/*.{ts,tsx}',
  'src/registry/**/*.{ts,tsx}',
  'src/workspace/**/*.{ts,tsx}',
  'src/wasm-kernel/**/*.{ts,tsx}',
  'src/types/**/*.{ts,tsx}',
  'src/utils/core/**/*.{ts,tsx}',
  'src/utils/query/**/*.{ts,tsx}',
  'src/utils/measure/**/*.{ts,tsx}',
  'src/utils/yamlMutations/**/*.{ts,tsx}',
  'src/utils/geometry/**/*.{ts,tsx}',
]

const CORE_ALLOW = [
  // Empty: the misplaced core services, the shared types, the scheduler and the
  // command tables have moved to their headless homes.
]

export default defineConfig([
  globalIgnores(['dist', 'public/wasm']),  // public/wasm holds wasm-bindgen generated .d.ts files
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The core layer is framework-free: it owns the document, geometry, history,
    // persistence and solve scheduling and must run headless in node, so it may
    // not reach into React, three, the stores or the UI. A regex is used instead
    // of gitignore-style patterns because a negation cannot re-include a file
    // under an ignored directory. Tests are exempt: they may mount the UI to
    // drive core code, and the node smoke test covers the runtime wall.
    files: CORE_FILES,
    ignores: ['**/__tests__/**', '**/*.test.*'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^(?:react|react-dom|three)(?:/|$)|^@react-three/|^@/stores/|^@/components/|^@/pages/|^@/hooks/',
          message: 'The core must stay headless: no React, three, stores, components, pages or hooks imports.',
        }],
      }],
    },
  },
  ...CORE_ALLOW.map(file => ({
    files: [file],
    rules: { 'no-restricted-imports': 'off' },
  })),
  {
    // The session layer predates the wider core fence and keeps two pure handler
    // tables under hooks/ and the frozen transcript tables' type-only import
    // until the adapter rewrite moves them into session/ (they import no React
    // and no store). Every other core folder is covered by the block above.
    files: ['src/session/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^(?:react|react-dom|three)(?:/|$)|^@react-three/|^@/stores/|^@/components/|^@/pages/|^@/hooks/(?!mutationDispatch$|mutationIdempotence$|__tests__/historyTranscript$)',
          message: 'The session layer must stay headless: no React, three, stores, components, pages or hooks imports.',
        }],
      }],
    },
  },
])
