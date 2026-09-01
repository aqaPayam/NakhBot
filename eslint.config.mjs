import eslint from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'deploy/terraform/**/.terraform/**',
      'eslint.config.mjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'domain', pattern: 'packages/domain/src/**' },
        { type: 'application', pattern: 'packages/application/src/**' },
        { type: 'contracts', pattern: 'packages/contracts/src/**' },
        {
          type: 'infrastructure',
          pattern:
            'packages/{persistence-postgres,queue-redis,telegram,media-r2,observability,config,localization}/src/**',
        },
        { type: 'adapter', pattern: 'apps/*/src/**' },
        { type: 'testkit', pattern: 'packages/testkit/src/**' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            {
              from: { element: { type: 'domain' } },
              allow: { to: { element: { type: 'domain' } } },
            },
            {
              from: { element: { type: 'contracts' } },
              allow: { to: { element: { type: 'contracts' } } },
            },
            {
              from: { element: { type: 'application' } },
              allow: {
                to: { element: { types: { anyOf: ['application', 'domain', 'contracts'] } } },
              },
            },
            {
              from: { element: { type: 'infrastructure' } },
              allow: {
                to: {
                  element: {
                    types: { anyOf: ['infrastructure', 'application', 'domain', 'contracts'] },
                  },
                },
              },
            },
            {
              from: { element: { type: 'adapter' } },
              allow: {
                to: {
                  element: {
                    types: {
                      anyOf: ['adapter', 'infrastructure', 'application', 'domain', 'contracts'],
                    },
                  },
                },
              },
            },
            {
              from: { element: { type: 'testkit' } },
              allow: {
                to: {
                  element: {
                    types: {
                      anyOf: ['testkit', 'application', 'domain', 'contracts', 'infrastructure'],
                    },
                  },
                },
              },
            },
          ],
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nakh/*/src/*', '@nakh/*/*'],
              message: 'Import another package only through its public index.',
            },
          ],
        },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
);
