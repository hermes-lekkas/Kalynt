/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
/**
 * IPC handlers for Dependency Manager
 */

import { ipcMain, BrowserWindow } from 'electron'
import { getDependencyManager } from '../terminal/dependencyManager'

export function registerDependencyHandlers(getMainWindow: () => BrowserWindow | null): void {
    const dependencyManager = getDependencyManager()

    dependencyManager.setWindowGetter(getMainWindow)

    // Detect package manager in workspace
    ipcMain.handle('deps:detect', async (_event, workspacePath: string) => {
        const manager = await dependencyManager.detectPackageManager(workspacePath)
        return manager ? {
            success: true,
            manager: {
                name: manager.name,
                command: manager.command,
                manifestFile: manager.manifestFile,
                lockFile: manager.lockFile,
                languageId: manager.languageId
            }
        } : { success: false, error: 'No package manager detected' }
    })

    // Get package manager for language
    ipcMain.handle('deps:getForLanguage', async (_event, languageId: string) => {
        const manager = dependencyManager.getPackageManagerForLanguage(languageId)
        return manager ? {
            success: true,
            manager: {
                name: manager.name,
                command: manager.command,
                manifestFile: manager.manifestFile,
                languageId: manager.languageId
            }
        } : { success: false, error: `No package manager for language: ${languageId}` }
    })

    // Install a package
    ipcMain.handle('deps:install', async (_event, packageName: string, options: {
        workspacePath: string
        global?: boolean
        dev?: boolean
        version?: string
    }) => {
        return dependencyManager.installPackage(packageName, options)
    })

    // Install all dependencies from manifest
    ipcMain.handle('deps:installAll', async (_event, workspacePath: string) => {
        return dependencyManager.installAllDependencies(workspacePath)
    })

    // Uninstall a package
    ipcMain.handle('deps:uninstall', async (_event, packageName: string, workspacePath: string) => {
        return dependencyManager.uninstallPackage(packageName, workspacePath)
    })

    // Update package(s)
    ipcMain.handle('deps:update', async (_event, packageName: string | null, workspacePath: string) => {
        return dependencyManager.updatePackage(packageName, workspacePath)
    })

    // List installed packages
    ipcMain.handle('deps:list', async (_event, workspacePath: string) => {
        return dependencyManager.listPackages(workspacePath)
    })

    // Initialize new project
    ipcMain.handle('deps:init', async (_event, managerName: string, workspacePath: string) => {
        return dependencyManager.initProject(managerName, workspacePath)
    })

    // Get supported package managers
    ipcMain.handle('deps:getSupportedManagers', async () => {
        return dependencyManager.getSupportedManagers().map(m => ({
            name: m.name,
            command: m.command,
            languageId: m.languageId,
            manifestFile: m.manifestFile
        }))
    })

    // Kill running operation
    ipcMain.handle('deps:kill', async (_event, operationId: string) => {
        return dependencyManager.killOperation(operationId)
    })

    console.log('[Main] Dependency manager IPC handlers registered')
}
