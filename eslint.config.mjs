// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const LAYER_MESSAGE =
  'Hexagonal rule (MASTER_ORCHESTRATION_PROMPT §4.1): dependencies must point inward.';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/.venv/**',
      // Judge corpus: hostile and golden programs, kept exactly as written.
      'services/sandbox-svc/test/attacks/testdata/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Nest modules are decorated classes with static factory methods (AppModule.register).
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      // Raw driver access is reserved for @atlas/platform; services use withTenantTx/withSystemTx.
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'pg', message: 'Use Db/Tx from @atlas/platform.' }] },
      ],
    },
  },
  {
    files: ['packages/platform/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // Nest's DI needs runtime class references for constructor injection, so services
    // cannot convert every import into `import type`.
    files: ['services/**/src/**/*.ts', 'packages/platform/src/http/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    files: ['services/**/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@nestjs/*', 'pg', '@atlas/platform', 'zod'], message: LAYER_MESSAGE },
            {
              group: ['**/application/**', '**/infrastructure/**', '**/http/**'],
              message: LAYER_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['services/**/src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'pg', message: LAYER_MESSAGE }],
          patterns: [{ group: ['**/infrastructure/**', '**/http/**'], message: LAYER_MESSAGE }],
        },
      ],
    },
  },
  {
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off', 'no-restricted-imports': 'off' },
  },
);
