module.exports = {
    root: true,
    env: { browser: true, node: true, es2022: true },
    parser: '@typescript-eslint/parser',
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    plugins: ['react-hooks', '@typescript-eslint', 'security'],
    extends: ['eslint:recommended'],
    ignorePatterns: ['**/node_modules/**', '**/dist/**', '**/dist-electron/**', '**/release/**', '**/build/**', '**/bin/**', '.claude/**'],
    rules: {
        // TypeScript checks type/global declarations; @typescript-eslint/no-unused-vars enforces unused symbols.
        'no-undef': 'off',
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': ['error', {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrors: 'none'
        }],
        'no-empty': ['error', { allowEmptyCatch: true }],
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'warn',
        'security/detect-unsafe-regex': 'warn'
    }
}
