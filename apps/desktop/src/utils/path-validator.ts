/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import path from 'path-browserify'

export interface PathValidationResult {
    valid: boolean
    error?: string
    normalizedPath?: string
}

/**
 * Check if a path is absolute (works for both POSIX and Windows paths)
 * path-browserify doesn't properly detect Windows absolute paths like C:\...
 */
function isAbsolutePath(filePath: string): boolean {
    // POSIX absolute path
    if (filePath.startsWith('/')) return true
    // Windows absolute path (C:\, D:\, etc.)
    if (/^[A-Za-z]:[\\/]/.test(filePath)) return true
    // UNC path (\\server\share)
    if (filePath.startsWith('\\\\')) return true
    return false
}

/**
 * Validates that a file path is safe and within workspace bounds
 * Prevents path traversal attacks by ensuring paths don't escape workspace
 * 
 * @param targetPath - Path to validate (can be relative or absolute)
 * @param workspacePath - Root workspace directory (null if no workspace set)
 * @returns Validation result with normalized path if valid
 */
export function validatePath(
    targetPath: string,
    workspacePath: string | null
): PathValidationResult {
    // Check for empty or invalid input
    if (!targetPath || typeof targetPath !== 'string') {
        return {
            valid: false,
            error: 'Invalid path: path must be a non-empty string'
        }
    }

    // Check for null bytes (common attack vector)
    if (targetPath.includes('\0')) {
        return {
            valid: false,
            error: 'Invalid path: contains null bytes'
        }
    }

    const windows = /^[A-Za-z]:[\\/]/.test(workspacePath || targetPath) || /^(\\\\|\/\/)/.test(workspacePath || targetPath)
    const normalize = (value: string) => {
        const unc = windows && /^(\\\\|\/\/)/.test(value)
        const result = path.normalize(windows ? value.replace(/\\/g, '/') : value)
        return unc ? '/' + result : result
    }

    // If no workspace is set, we can't validate bounds
    // This allows file operations before workspace is opened
    if (!workspacePath) {
        // Still normalize the path for consistency
        const normalized = normalize(targetPath)
        return {
            valid: true,
            normalizedPath: normalized
        }
    }

    try {
        // Normalize both paths to handle different separators and relative segments
        const normalizedTarget = normalize(targetPath)
        const normalizedWorkspace = normalize(workspacePath)

        // For relative paths, resolve against workspace
        // Use custom isAbsolutePath to properly handle Windows paths
        const resolvedPath = isAbsolutePath(normalizedTarget)
            ? normalizedTarget
            : windows ? `${normalizedWorkspace}/${normalizedTarget}` : path.join(normalizedWorkspace, normalizedTarget)

        // Normalize the resolved path to remove any remaining relative segments
        const finalPath = normalize(resolvedPath)

        // Check if the final path is within workspace bounds
        // Convert to forward slashes for consistent comparison
        const finalPathForward = windows ? finalPath.toLowerCase() : finalPath
        const workspaceForward = (windows ? normalizedWorkspace.toLowerCase() : normalizedWorkspace).replace(/\/+$/, '') || '/'
        const prefix = workspaceForward === '/' ? '/' : workspaceForward + '/'

        if (finalPathForward !== workspaceForward && !finalPathForward.startsWith(prefix)) {
            return {
                valid: false,
                error: `Access denied: path "${targetPath}" is outside workspace boundaries`
            }
        }

        return {
            valid: true,
            normalizedPath: finalPath
        }
    } catch (error) {
        return {
            valid: false,
            error: `Path validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
        }
    }
}

/**
 * Validates multiple paths at once
 * Useful for batch operations
 * 
 * @param paths - Array of paths to validate
 * @param workspacePath - Root workspace directory
 * @returns Array of validation results in same order as input
 */
export function validatePaths(
    paths: string[],
    workspacePath: string | null
): PathValidationResult[] {
    return paths.map(p => validatePath(p, workspacePath))
}

/**
 * Validates a path and throws an error if invalid
 * Convenient for operations that should fail fast
 * 
 * @param targetPath - Path to validate
 * @param workspacePath - Root workspace directory
 * @returns Normalized path if valid
 * @throws Error if path is invalid
 */
export function validatePathOrThrow(
    targetPath: string,
    workspacePath: string | null
): string {
    const result = validatePath(targetPath, workspacePath)

    if (!result.valid) {
        throw new Error(result.error || 'Path validation failed')
    }

    return result.normalizedPath!
}
