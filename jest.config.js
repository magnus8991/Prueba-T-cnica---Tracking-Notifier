/** @type {import('jest').Config} */
// TS151002: aviso informativo de ts-jest con module "nodenext"; el código compila como CommonJS.
const tsTransform = { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: { ignoreCodes: [151002] } }] };

const base = {
  testEnvironment: 'node',
  transform: tsTransform,
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFiles: ['<rootDir>/test/support/load-test-env.ts'],
};

module.exports = {
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/migrate.ts'],
  coverageThreshold: {
    './src/domain/': { branches: 90, functions: 90, lines: 90, statements: 90 },
  },
  projects: [
    { ...base, displayName: 'unit', testMatch: ['<rootDir>/test/unit/**/*.spec.ts'] },
    { ...base, displayName: 'architecture', testMatch: ['<rootDir>/test/architecture/**/*.spec.ts'] },
    { ...base, displayName: 'integration', testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'], slowTestThreshold: 10 },
    { ...base, displayName: 'e2e', testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'], slowTestThreshold: 30 },
  ],
};
