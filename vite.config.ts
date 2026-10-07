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
    // Foldkit JS plugin removed for now: with `jsPlugins` set, oxlint switches
    // to fixed-size allocators (one ~4 GiB reservation per thread) and panics at
    // startup in `crates/oxc_allocator/src/pool/fixed_size.rs` on machines with
    // no swap / strict memory overcommit accounting. Upstream: the Linux-side
    // variant is still open (oxc-project/oxc#20331, fix PR oxc-project/oxc#27356;
    // full allocator revamp oxc-project/oxc#20513), the Windows-only fix was
    // oxc-project/oxc#22124. Re-enable once the upstream fix lands:
    // jsPlugins: [{ name: 'foldkit', specifier: '@foldkit/oxlint-plugin' }],
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
      // Foldkit rules disabled with the plugin above. Re-enable together with
      // `jsPlugins` once oxc-project/oxc#20331 is fixed upstream:
      // 'foldkit/no-switch-on-message-tag': 'error',
      // 'foldkit/prefer-command-mapmessage': 'error',
      // 'foldkit/prefer-option-over-nullable-in-model': 'error',
      // 'foldkit/require-fold-for-child-update-result': 'error',
    },
  },
})
