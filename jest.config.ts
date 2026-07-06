export default {
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
  testTimeout: 30000,
  moduleNameMapper: {
    '^@/(.*)\\.js$': '<rootDir>/src/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    // Whole runtime surface. Justified excludes only:
    //   index.ts  — process bootstrap (cluster fork, signal handlers); needs a
    //               live process, not unit-coverable
    //   logger.ts — pino transport config, no meaningful branches
    //   types/    — no runtime code
    'src/**/*.ts',
    '!src/index.ts',
    '!src/middleware/logger.ts',
    '!src/types/**',
    '!node_modules/**',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  maxWorkers: 1,
};
