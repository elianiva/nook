import { defineConfig } from 'vite-plus'

/** Directories that hold agent scratch state or build output, never sources. */
const ignored = [
  '.agents/**',
  '.claude/**',
  '.cursor/**',
  '.pi/**',
  'dist/**',
  '.turbo/**',
  '.alchemy/**',
  '.wrangler/**',
]

export default defineConfig({
  fmt: {
    ignorePatterns: [...ignored, '**/*.d.ts'],
    semi: false,
    singleQuote: true,
    trailingComma: 'all',
  },
  lint: {
    ignorePatterns: ignored,
    options: {
      typeAware: true,
      typeCheck: true,
    },
    plugins: ['typescript', 'unicorn', 'oxc'],
    jsPlugins: [{ name: 'foldkit', specifier: '@foldkit/oxlint-plugin' }],
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'typescript/no-explicit-any': 'error',
      'foldkit/no-switch-on-message-tag': 'error',
      'foldkit/prefer-command-mapmessage': 'error',
      'foldkit/prefer-option-over-nullable-in-model': 'error',
      'foldkit/require-fold-for-child-update-result': 'error',
    },
  },
})
