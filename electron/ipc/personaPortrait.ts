// Persona portrait resolver
// ============================================================
// Looks up a portrait image for a persona by id. Resolution order:
//   1. ~/.lit-manager/agent/personas/<id>/portrait.{jpg,jpeg,png,webp}
//      (user-overridable per-persona — takes precedence over bundled slugs)
//   2. <appRoot>/skills/<slug>/portrait.{jpg,jpeg,png,webp}
//      where slug is derived from persona.skill.skillSlug (preferred) or
//      a normalized canonicalName. Matches the bundled skills directory
//      (hegel, kant, confucius, ...).
//
// Returns a data URL (base64) rather than a file:// path — simpler to slot
// into <img src={...} /> without worrying about Electron's file:// sandbox
// rules for renderer-side image loads.
//
// Kept in its own file so the canonical personas IPC stays frozen; this
// handler can be removed cleanly without touching personas.ts.

import { ipcMain, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { safeLoadJsonOrBackup } from './library'
import type { Persona } from '../../src/types/library'

const DATA_DIR = path.join(app.getPath('home'), '.lit-manager')
const PERSONAS_DIR = path.join(DATA_DIR, 'agent', 'personas')

// Bundled skills live in the project root / resources (dev vs packaged).
// In dev: cwd or app.getAppPath() + 'skills'. In packaged: resources/skills.
function bundledSkillsDir(): string[] {
  const candidates = [
    path.join(app.getAppPath(), 'skills'),
    path.join(process.resourcesPath || '', 'skills'),
    path.join(process.cwd(), 'skills'),
  ]
  return candidates.filter(Boolean)
}

const EXT_CANDIDATES = ['jpeg', 'jpg', 'png', 'webp'] as const
const MIME_BY_EXT: Record<(typeof EXT_CANDIDATES)[number], string> = {
  jpeg: 'image/jpeg',
  jpg:  'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
}

async function tryReadAsDataUrl(filePath: string, ext: (typeof EXT_CANDIDATES)[number]): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) return null
    const buf = await fs.readFile(filePath)
    return `data:${MIME_BY_EXT[ext]};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

async function findInDir(dir: string): Promise<string | null> {
  for (const ext of EXT_CANDIDATES) {
    const p = path.join(dir, `portrait.${ext}`)
    const dataUrl = await tryReadAsDataUrl(p, ext)
    if (dataUrl) return dataUrl
  }
  return null
}

/** Best-effort slug inference for a persona. Prefers the stored
 *  skill.skillSlug (set at synthesize / import time), else derives a latin
 *  slug by stripping non-ascii chars from canonicalName. Used only as a
 *  lookup key against the bundled skills/ dir; if no match, falls through. */
function inferSlug(persona: Persona): string[] {
  const out: string[] = []
  const raw = persona.skill?.skillSlug?.trim()
  if (raw) out.push(raw.toLowerCase())
  // Canonical-name fallback: lowercase, latin-only, no punctuation
  const canon = (persona.canonicalName || persona.name || '').toLowerCase()
  const latin = canon.replace(/[^a-z0-9]/g, '')
  if (latin && !out.includes(latin)) out.push(latin)
  // Common CJK → pinyin-ish shortcuts for bundled skills
  const CJK_MAP: Record<string, string> = {
    '黑格尔': 'hegel', '康德': 'kant', '柏拉图': 'plato',
    '亚里士多德': 'aristotle', '孔子': 'confucius',
    '老子': 'laozi', '王阳明': 'wangyangming',
    '韦伯': 'weber', '马克斯·韦伯': 'weber',
    '涂尔干': 'durkheim', '埃米尔·涂尔干': 'durkheim',
  }
  const mapped = CJK_MAP[canon.trim()] || CJK_MAP[(persona.name || '').trim()]
  if (mapped && !out.includes(mapped)) out.push(mapped)
  return out
}

export function registerPersonaPortraitIpc(): void {
  ipcMain.handle('persona-get-portrait', async (_event, personaId: string): Promise<{
    success: boolean
    dataUrl?: string
    source?: 'user' | 'bundled' | 'none'
    error?: string
  }> => {
    try {
      // 1) Per-persona user override in the data dir
      const userDir = path.join(PERSONAS_DIR, personaId)
      const userHit = await findInDir(userDir)
      if (userHit) return { success: true, dataUrl: userHit, source: 'user' }

      // Load persona to learn slug
      const personaFile = path.join(PERSONAS_DIR, `${personaId}.json`)
      const persona = await safeLoadJsonOrBackup<Persona | null>(personaFile, null)
      if (!persona) return { success: true, source: 'none' }

      // 2) Bundled skills/<slug>/portrait.*
      const slugs = inferSlug(persona)
      for (const baseDir of bundledSkillsDir()) {
        for (const slug of slugs) {
          if (!slug) continue
          const hit = await findInDir(path.join(baseDir, slug))
          if (hit) return { success: true, dataUrl: hit, source: 'bundled' }
        }
      }
      return { success: true, source: 'none' }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })
}
