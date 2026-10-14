import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

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
    // The session layer is framework-free L1: it owns the document, history and
    // solve scheduling and must run headless in node, so it may not reach into
    // React, the stores or the UI. The two pure handler tables under hooks/
    // keep an exact-path exemption until the adapter rewrite moves them into
    // session/; they import no React and no store. The negated entries are
    // gitignore-style and must come after the pattern they exempt.
    files: ['src/session/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: [
            'react', 'react-dom', 'three',
            'react/*', 'react-dom/*', 'three/*',
            '@react-three/*',
            '@/stores/*', '@/components/*', '@/pages/*', '@/hooks/*',
            '!@/hooks/mutationDispatch',
            '!@/hooks/mutationIdempotence',
          ],
          message: 'The session layer must stay headless: no React, three, stores, components, pages or hooks imports.',
        }],
      }],
    },
  },
])
