// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const FRAMEWORK_AND_INFRA = [
  { group: ['@nestjs/*', 'nestjs-*', 'pg', 'pg-*', 'zod', 'pino', 'pino-*', 'prom-client', 'express', 'yaml'], message: 'El núcleo (domain/application) no depende de frameworks ni librerías de infraestructura.' },
  { group: ['node:*', 'crypto', 'http', 'https', 'fs', 'net', 'dns'], message: 'El núcleo no usa APIs de Node: exponga un puerto.' },
  { group: ['**/infrastructure/**', '../infrastructure', '../../infrastructure'], message: 'El núcleo no importa adaptadores.' },
];

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-console': 'error',
    },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...FRAMEWORK_AND_INFRA, { group: ['**/application/**', '../application', '../../application'], message: 'El dominio no conoce la capa de aplicación.' }] },
      ],
    },
  },
  {
    files: ['src/application/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: FRAMEWORK_AND_INFRA }] },
  },
  {
    files: ['scripts/**/*.mjs', 'docker/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['**/*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
