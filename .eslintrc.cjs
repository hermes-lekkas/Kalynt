module.exports = {
    root: true,
    env: { browser: true, node: true, es2022: true },
    parser: '@typescript-eslint/parser',
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    plugins: ['react-hooks', '@typescript-eslint', 'security'],
    extends: ['eslint:recommended'],
    ignorePatterns: ['**/node_modules/**', '**/dist/**', '**/dist-electron/**', '**/release/**', '**/build/**', '**/bin/**', 'apps/mobile/**', '.claude/**'],
    rules: {
        // TypeScript checks declarations and unused symbols in these sources.
        'no-undef': 'off',
        'no-unused-vars': 'off',
        'no-empty': ['error', { allowEmptyCatch: true }],
        'react-hooks/rules-of-hooks': 'error'
    }
}
