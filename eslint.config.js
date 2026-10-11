import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx,mjs}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  {
    files: ['**/*.jsx'],
    extends: [reactRefresh.configs.vite],
  },
  {
    files: ['src/**/*.{js,jsx}', 'tests/browser/**/*.{js,jsx,mjs}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: [
      'scripts/**/*.mjs',
      'tests/unit/**/*.mjs',
      'tests/legacy/**/*.mjs',
      'tests/db/**/*.mjs',
      'server/**/*.mjs',
      'netlify/functions/**/*.mjs',
      '*.config.{js,mjs,cjs}',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['tests/browser/**/*.{js,jsx,mjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
])
