const eslint = require('@eslint/js');
const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');

module.exports = [
  eslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // Disable base rules that are covered by TypeScript
      'no-unused-vars': 'off',
      'no-undef': 'off',

      // TypeScript-specific rules
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      // General rules
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Every entry in tsconfig.json's `exclude` needs a match here: `files`
    // below globs all of src/**/*.ts, but parserOptions.project points at
    // tsconfig.json, so anything tsc excludes is not in the TS program and
    // @typescript-eslint/parser cannot parse it.
    ignores: [
      'dist/**',
      'node_modules/**',
      '**/*.test.ts',
      'jest.config.js',
      '*.js',
      'src/dashboard/**',
      'src/__mocks__/**',
      'src/__test-setup__/**',
    ],
  },
];
