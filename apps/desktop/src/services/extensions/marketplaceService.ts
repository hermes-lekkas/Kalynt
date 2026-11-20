/**
 * Open VSX Marketplace Service
 * Provides access to the Open VSX registry for downloading VS Code extensions
 */

import { ExtensionGallery, ExtensionQueryOptions, ExtensionVersion } from '../../types/extensions'

const OPENVSX_API_URL = 'https://open-vsx.org/api'
const DEFAULT_PAGE_SIZE = 20

interface OpenVSXSearchResult {
  extensions: Array<{
    namespace: string
    name: string
    version: string
    publishedBy: {
      loginName: string
    }
    displayName?: string
    description?: string
    categories?: string[]
    tags?: string[]
    releaseDate?: string
    lastUpdatedDate?: string
    timestamp?: string
    files?: {
      download?: string
      icon?: string
    }
  }>
}

interface OpenVSXExtensionDetails {
  namespace: string
  name: string
  version: string
  publishedBy?: {
    loginName: string
  }
  displayName?: string
  description?: string
  categories?: string[]
  tags?: string[]
  releaseDate?: string
  lastUpdatedDate?: string
  timestamp?: string
  allVersions?: Record<string, string>
  versions?: Array<{
    version: string
    lastUpdated?: string
  }>
  files?: {
    download?: string
    manifest?: string
    readme?: string
    changelog?: string
    license?: string
    icon?: string
  }
}

class MarketplaceService {
  private cache: Map<string, { data: unknown; timestamp: number }> = new Map()
  private cacheTTL = 5 * 60 * 1000 // 5 minutes

  /**
   * Search for extensions in the Open VSX marketplace
   */
  async searchExtensions(options: ExtensionQueryOptions = {}): Promise<ExtensionGallery[]> {
    const {
      searchText = '',
      categories = [],
      sortBy = 'relevance',
      sortOrder = 'descending',
      pageSize = DEFAULT_PAGE_SIZE,
      pageNumber = 1
    } = options

    try {
      const params = new URLSearchParams()
      if (searchText) params.set('query', searchText)
      if (categories.length > 0) params.set('category', categories.join(','))
      params.set('size', String(pageSize))
      params.set('offset', String((pageNumber - 1) * pageSize))

      const sortMap: Record<string, string> = {
        'none': 'relevance',
        'lastUpdated': 'timestamp',
        'title': 'name',
        'publisherName': 'namespace',
        'installCount': 'downloadCount',
        'publishedDate': 'relevance',
        'averageRating': 'averageRating',
        'weightedRating': 'weightedRating'
      }
      params.set('sortBy', sortMap[sortBy] || 'relevance')
      params.set('sortOrder', sortOrder === 'ascending' ? 'asc' : 'desc')

      const cacheKey = `search:${params.toString()}`
      const cached = this.getFromCache<OpenVSXSearchResult>(cacheKey)

      if (cached) {
        return this.mapSearchResults(cached)
      }

      const response = await fetch(`${OPENVSX_API_URL}/-/search?${params.toString()}`)

      if (!response.ok) {
        throw new Error(`Marketplace search failed: ${response.status} ${response.statusText}`)
      }

      const result: OpenVSXSearchResult = await response.json()
      this.setCache(cacheKey, result)

      return this.mapSearchResults(result)
    } catch (error) {
      console.error('[Marketplace] Search failed:', error)
      throw error
    }
  }

  /**
   * Fetches raw Open VSX metadata for an extension (latest or specific version), cached.
   */
  private async fetchRawExtensionDetails(
    namespace: string,
    name: string,
    version?: string
  ): Promise<OpenVSXExtensionDetails> {
    const isSpecific = version && version !== 'latest'
    const cacheKey = isSpecific
      ? `version:${namespace}.${name}:${version}`
      : `details:${namespace}.${name}`
    const cached = this.getFromCache<OpenVSXExtensionDetails>(cacheKey)
    if (cached) return cached

    const url = isSpecific
      ? `${OPENVSX_API_URL}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
      : `${OPENVSX_API_URL}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`

    const response = await fetch(url)
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(
          isSpecific
            ? `Extension version not found: ${namespace}.${name}@${version}`
            : `Extension not found: ${namespace}.${name}`
        )
      }
      throw new Error(`Failed to get extension details: ${response.status}`)
    }

    const details: OpenVSXExtensionDetails = await response.json()
    this.setCache(cacheKey, details)
    return details
  }

  /**
   * Get extension details
   */
  async getExtensionDetails(namespace: string, name: string): Promise<ExtensionGallery> {
    try {
      const details = await this.fetchRawExtensionDetails(namespace, name)
      return this.mapExtensionDetails(details)
    } catch (error) {
      console.error('[Marketplace] Get details failed:', error)
      throw error
    }
  }

  /**
   * Get specific version of an extension
   */
  async getExtensionVersion(namespace: string, name: string, version: string): Promise<ExtensionGallery> {
    try {
      const details = await this.fetchRawExtensionDetails(namespace, name, version)
      return this.mapExtensionDetails(details)
    } catch (error) {
      console.error('[Marketplace] Get version failed:', error)
      throw error
    }
  }

  /**
   * Download extension VSIX file using Open VSX's canonical `files.download` URL.
   */
  async downloadExtension(
    namespace: string,
    name: string,
    version: string,
    onProgress?: (downloaded: number, total: number) => void
  ): Promise<Blob> {
    try {
      const downloadUrl = await this.getActualDownloadUrl(namespace, name, version)
      const response = await fetch(downloadUrl)

      if (!response.ok) {
        throw new Error(`Failed to download extension: ${response.status}`)
      }

      const total = parseInt(response.headers.get('content-length') || '0', 10)

      if (!onProgress || !response.body) {
        return await response.blob()
      }

      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let downloaded = 0

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        chunks.push(value)
        downloaded += value.length
        onProgress(downloaded, total)
      }

      const allChunks = new Uint8Array(downloaded)
      let position = 0
      for (const chunk of chunks) {
        allChunks.set(chunk, position)
        position += chunk.length
      }

      return new Blob([allChunks])
    } catch (error) {
      console.error('[Marketplace] Download failed:', error)
      throw error
    }
  }

  /**
   * Get fallback download URL for an extension
   */
  getDownloadUrl(namespace: string, name: string, version: string): string {
    return `${OPENVSX_API_URL}/${namespace}/${name}/${version}/file/${namespace}.${name}-${version}.vsix`
  }

  /**
   * Resolves the canonical Open VSX VSIX download URL from `details.files.download`
   * (properly supporting platform-specific packages and resolving `'latest'`).
   */
  async getActualDownloadUrl(namespace: string, name: string, version: string): Promise<string> {
    console.log(`[Marketplace] Resolving download URL for ${namespace}.${name}@${version}`)

    try {
      const details = await this.fetchRawExtensionDetails(namespace, name, version)

      // Prefer the authoritative Open VSX `files.download` URL when present
      if (details.files?.download) {
        console.log('[Marketplace] Resolved download URL from details.files.download:', details.files.download)
        return details.files.download
      }

      const actualVersion = version === 'latest' ? details.version : version
      if (!actualVersion) {
        throw new Error('Could not determine version from extension details')
      }

      const fallbackUrl = this.getDownloadUrl(namespace, name, actualVersion)
      console.log('[Marketplace] Resolved fallback download URL:', fallbackUrl)
      return fallbackUrl
    } catch (error) {
      console.error('[Marketplace] Failed to resolve download URL:', error)
      throw new Error(`Failed to get download URL for ${namespace}.${name}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Get popular extensions
   */
  async getPopularExtensions(limit: number = 20): Promise<ExtensionGallery[]> {
    return this.searchExtensions({
      sortBy: 'installCount',
      sortOrder: 'descending',
      pageSize: limit,
      pageNumber: 1
    })
  }

  /**
   * Get recently updated extensions
   */
  async getRecentlyUpdated(limit: number = 20): Promise<ExtensionGallery[]> {
    return this.searchExtensions({
      sortBy: 'lastUpdated',
      sortOrder: 'descending',
      pageSize: limit,
      pageNumber: 1
    })
  }

  /**
   * Get extensions by category
   */
  async getExtensionsByCategory(category: string, limit: number = 20): Promise<ExtensionGallery[]> {
    return this.searchExtensions({
      categories: [category],
      pageSize: limit,
      pageNumber: 1
    })
  }

  /**
   * Get recommended extensions (based on installed extensions)
   */
  async getRecommendedExtensions(installedIds: string[], limit: number = 10): Promise<ExtensionGallery[]> {
    try {
      const recommendations: ExtensionGallery[] = []
      const seenIds = new Set(installedIds)

      for (const id of installedIds.slice(0, 5)) {
        const [namespace, name] = id.split('.')
        if (!namespace || !name) continue

        try {
          const extension = await this.getExtensionDetails(namespace, name)

          if (extension.categories && extension.categories.length > 0) {
            const similar = await this.searchExtensions({
              categories: extension.categories.slice(0, 2),
              pageSize: 5
            })

            for (const ext of similar) {
              if (!seenIds.has(ext.id) && !recommendations.find(r => r.id === ext.id)) {
                recommendations.push(ext)
                if (recommendations.length >= limit) break
              }
            }
          }
        } catch {
          // Skip if extension not found
        }

        if (recommendations.length >= limit) break
      }

      return recommendations
    } catch (error) {
      console.error('[Marketplace] Get recommendations failed:', error)
      return []
    }
  }

  // Private helpers

  private mapSearchResults(result: OpenVSXSearchResult): ExtensionGallery[] {
    if (!result.extensions) return []

    return result.extensions.map(ext => {
      const updated = ext.lastUpdatedDate || ext.timestamp || new Date().toISOString()
      const files: ExtensionVersion['files'] = []
      if (ext.files?.download) {
        files.push({ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: ext.files.download })
      }
      if (ext.files?.icon) {
        files.push({ assetType: 'Microsoft.VisualStudio.Services.Icons.Default', source: ext.files.icon })
      }

      return {
        id: `${ext.namespace}.${ext.name}`,
        name: ext.name,
        displayName: ext.displayName || ext.name,
        shortDescription: ext.description || '',
        publisher: {
          displayName: ext.publishedBy?.loginName || ext.namespace,
          publisherId: ext.namespace,
          publisherName: ext.namespace
        },
        versions: [{
          version: ext.version,
          lastUpdated: updated,
          assetUri: `${OPENVSX_API_URL}/${ext.namespace}/${ext.name}/${ext.version}`,
          fallbackAssetUri: `${OPENVSX_API_URL}/${ext.namespace}/${ext.name}`,
          files
        }],
        categories: ext.categories || [],
        tags: ext.tags || [],
        releaseDate: ext.releaseDate || updated,
        publishedDate: ext.releaseDate || updated,
        lastUpdated: updated
      }
    })
  }

  private mapExtensionDetails(details: OpenVSXExtensionDetails): ExtensionGallery {
    const defaultTimestamp = details.lastUpdatedDate || details.timestamp || new Date().toISOString()
    const mappedVersions: ExtensionVersion[] = []
    const seen = new Set<string>()

    // Primary version returned by Open VSX (includes authoritative `files` URLs)
    if (details.version) {
      const primaryFiles: ExtensionVersion['files'] = []
      if (details.files?.download) {
        primaryFiles.push({
          assetType: 'Microsoft.VisualStudio.Services.VSIXPackage',
          source: details.files.download
        })
      }
      if (details.files?.manifest) {
        primaryFiles.push({
          assetType: 'Microsoft.VisualStudio.Code.Manifest',
          source: details.files.manifest
        })
      }
      if (details.files?.icon) {
        primaryFiles.push({
          assetType: 'Microsoft.VisualStudio.Services.Icons.Default',
          source: details.files.icon
        })
      }

      mappedVersions.push({
        version: details.version,
        lastUpdated: defaultTimestamp,
        assetUri: `${OPENVSX_API_URL}/${details.namespace}/${details.name}/${details.version}`,
        fallbackAssetUri: `${OPENVSX_API_URL}/${details.namespace}/${details.name}`,
        files: primaryFiles
      })
      seen.add(details.version)
    }

    // Open VSX returns `allVersions` as a `{ [version]: versionApiUrl }` map
    if (details.allVersions && typeof details.allVersions === 'object') {
      for (const [ver, url] of Object.entries(details.allVersions)) {
        if (!ver || ver === 'latest' || ver === 'pre-release' || seen.has(ver)) continue
        seen.add(ver)
        mappedVersions.push({
          version: ver,
          lastUpdated: defaultTimestamp,
          assetUri: typeof url === 'string' && url ? url : `${OPENVSX_API_URL}/${details.namespace}/${details.name}/${ver}`,
          fallbackAssetUri: `${OPENVSX_API_URL}/${details.namespace}/${details.name}`,
          files: []
        })
      }
    }

    // Backwards compatibility if a proxy/fixture provides a `versions` array
    if (Array.isArray(details.versions)) {
      for (const v of details.versions) {
        if (!v?.version || seen.has(v.version)) continue
        seen.add(v.version)
        mappedVersions.push({
          version: v.version,
          lastUpdated: v.lastUpdated || defaultTimestamp,
          assetUri: `${OPENVSX_API_URL}/${details.namespace}/${details.name}/${v.version}`,
          fallbackAssetUri: `${OPENVSX_API_URL}/${details.namespace}/${details.name}`,
          files: []
        })
      }
    }

    return {
      id: `${details.namespace}.${details.name}`,
      name: details.name,
      displayName: details.displayName || details.name,
      shortDescription: details.description || '',
      publisher: {
        displayName: details.publishedBy?.loginName || details.namespace,
        publisherId: details.namespace,
        publisherName: details.namespace
      },
      versions: mappedVersions,
      categories: details.categories || [],
      tags: details.tags || [],
      releaseDate: details.releaseDate || defaultTimestamp,
      publishedDate: details.releaseDate || defaultTimestamp,
      lastUpdated: defaultTimestamp
    }
  }

  private getFromCache<T>(key: string): T | null {
    const cached = this.cache.get(key)
    if (!cached) return null

    if (Date.now() - cached.timestamp > this.cacheTTL) {
      this.cache.delete(key)
      return null
    }

    return cached.data as T
  }

  private setCache(key: string, data: unknown): void {
    this.cache.set(key, { data, timestamp: Date.now() })
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear()
  }
}

// Export singleton
export const marketplaceService = new MarketplaceService()
export default marketplaceService
