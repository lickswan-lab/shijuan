export interface OnlineSearchRequest {
  siteUrl: string
  query: string
  maxPages?: number
  useSiteSession?: boolean
}

export interface OnlineSearchResult {
  id: string
  title: string
  url: string
  fileName: string
  extension: string
  sourcePageUrl: string
  sourcePageTitle?: string
  contentType?: string
  sizeBytes?: number
  verified: boolean
}

export interface OnlineSearchResponse {
  success: boolean
  searchedUrl?: string
  scannedPages?: number
  usedSiteSession?: boolean
  sessionCookieCount?: number
  results: OnlineSearchResult[]
  warnings?: string[]
  error?: string
}

export interface OnlineDownloadRequest {
  url: string
  fileName?: string
  title?: string
  useSiteSession?: boolean
}

export interface OnlineDownloadResponse {
  success: boolean
  absPath?: string
  fileName?: string
  title?: string
  error?: string
}

export interface OnlineSiteLoginRequest {
  siteUrl: string
  loginUrl?: string
}

export interface OnlineSiteLoginResponse {
  success: boolean
  origin?: string
  error?: string
}

export interface OnlineSiteSessionRequest {
  siteUrl: string
}

export interface OnlineSiteSessionStatus {
  success: boolean
  origin?: string
  hasSession?: boolean
  cookieCount?: number
  error?: string
}
