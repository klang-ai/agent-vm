import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'guest', 'eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      eqeqeq: 'error',
      'no-console': 'error',
      curly: ['error', 'multi-line'],
    },
  },
  {
    // node:test's describe/it return promises the runner tracks itself.
    files: ['src/test/**'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
);
