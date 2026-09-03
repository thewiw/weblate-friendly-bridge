import tseslint from 'typescript-eslint';

export default tseslint.config(
  // public/ holds vendored third-party assets (Swagger UI bundle) — not our code.
  { ignores: ['dist/**', 'node_modules/**', 'public/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);