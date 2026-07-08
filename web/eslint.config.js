import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Build output and generated files are not linted.
  { ignores: ['dist', 'node_modules', 'coverage'] },

  // Application source (browser).
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2021,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // Classic react-hooks rules (as shipped by the Vite React+TS template).
      // The stricter React-Compiler ruleset in eslint-plugin-react-hooks v7
      // (set-state-in-effect, purity, refs) is intentionally not enabled here;
      // adopting it requires reworking several effect patterns and can be a
      // deliberate follow-up.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },

  // Test files also have the vitest/jsdom globals available.
  {
    files: ['src/**/*.{test,spec}.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...globals.vitest },
    },
  },

  // Node-context config files (vite/vitest configs use node globals).
  {
    files: ['*.{js,ts}'],
    languageOptions: {
      globals: globals.node,
    },
  },
)
