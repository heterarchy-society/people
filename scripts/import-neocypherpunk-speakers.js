/**
 * Import Neocypherpunk Summit 2026 speakers from s26ber.web3privacy.info
 *
 *   node scripts/import-neocypherpunk-speakers.js [html-path]            # create missing people + link event
 *   node scripts/import-neocypherpunk-speakers.js --fix-refs [html]      # repair refs on imported speakers
 *   node scripts/import-neocypherpunk-speakers.js --update-existing [html] # enrich pre-existing speaker profiles
 *   node scripts/import-neocypherpunk-speakers.js --audit [html]             # report suspect imports
 *   node scripts/import-neocypherpunk-speakers.js --import-team [html]       # create/link summit team as organizers
 *   node scripts/import-neocypherpunk-speakers.js --dedupe-avatars           # remove avatar-alt files identical to primary
 */
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join, extname } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = join(import.meta.dirname, '..')
const PEOPLE = join(ROOT, 'people')
const EVENT_PATH = join(ROOT, '..', 'events', 'events', 'neocypherpunk-summit-berlin-2026', 'index.yaml')
const SITE = 'https://s26ber.web3privacy.info'
const ALT_AVATAR = 'avatar-alt'
const args = process.argv.slice(2)
const FIX_REFS = args.includes('--fix-refs')
const UPDATE_EXISTING = args.includes('--update-existing')
const AUDIT = args.includes('--audit')
const IMPORT_TEAM = args.includes('--import-team')
const DEDUPE_AVATARS = args.includes('--dedupe-avatars')
const HTML_PATH = args.find(a => !a.startsWith('--')) ?? '/tmp/ncs.html'

const ORG_TWITTER = new Set(['web3privacy', 'winprivacy'])

const SKIP_SUMMIT_AVATAR = new Set(['jaromil'])

const ID_OVERRIDES = {
  'denis jaromil roio': 'jaromil',
  'rachel rose o leary': 'lunar-mining',
  'nick almond': 'dr-nick',
  'josh davila': 'joshua-davila',
  'peter szilagyi': 'peter-szilagyi',
}

const TEAM_ID_OVERRIDES = {
  mykola: 'mykola-siusko',
  pg: 'pg',
  beth: 'beth-mccarthy',
  robert: 'robert-degroot',
  coinmandeer: 'coinmandeer',
  teresa: 'teresa-neppi',
  federico: 'federico',
  jensei: 'jensei',
  dani: 'dani-saturn',
}

const TEAM_DISPLAY_NAMES = {
  beth: 'Beth McCarthy',
  teresa: 'Teresa Neppi',
  federico: 'Federico',
  jensei: 'Jensei',
  dani: 'Dani',
}

function slugify(name) {
  return name.toLowerCase()
    .normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/^dr\.?\s+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

function titleCase(name) {
  let s = name.trim()
  if (/^DR\.?\s/i.test(s)) s = 'Dr ' + s.replace(/^DR\.?\s+/i, '')
  return s.split(/\s+/).map(w => {
    if (/^[a-z0-9_]+$/i.test(w) && w.includes('_')) return w
    if (w.includes('-')) {
      return w.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('-')
    }
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  }).join(' ')
}

function loadExisting() {
  const byName = new Map()
  for (const dir of readdirSync(PEOPLE)) {
    const yamlPath = join(PEOPLE, dir, 'index.yaml')
    if (!existsSync(yamlPath)) continue
    const y = readFileSync(yamlPath, 'utf8')
    const name = y.match(/^name:\s*"?(.+?)"?\s*$/m)?.[1]?.trim()
    if (name) byName.set(norm(name.replace(/"/g, '')), dir)
    for (const alt of y.match(/^altNames:\n((?:  - .+\n)+)/m)?.[1]?.match(/  - (.+)/g) ?? []) {
      byName.set(norm(alt.replace(/^  - /, '').replace(/"/g, '')), dir)
    }
    byName.set(norm(dir.replace(/-/g, ' ')), dir)
  }
  return byName
}

function loadExistingByTwitter() {
  const byTwitter = new Map()
  for (const dir of readdirSync(PEOPLE)) {
    const yamlPath = join(PEOPLE, dir, 'index.yaml')
    if (!existsSync(yamlPath)) continue
    const tw = readFileSync(yamlPath, 'utf8').match(/^  twitter: (.+)$/m)?.[1]
    if (tw) byTwitter.set(tw.toLowerCase(), dir)
  }
  return byTwitter
}

function isSuspiciousTwitter(handle) {
  if (!handle) return false
  const h = handle.toLowerCase()
  return h.length <= 3 || ORG_TWITTER.has(h)
}

function extractRefs(href) {
  if (!href) return {}
  const twitter = href.match(/(?:x\.com|twitter\.com)\/@?([^/?#]+)/i)?.[1]
  if (twitter && !isSuspiciousTwitter(twitter)) return { twitter }
  if (/^https?:\/\//i.test(href)) return { web: href }
  return {}
}

function parseCard(href, block) {
  const img = block.match(/<img src="\.\/img\/([^"]+)"/)?.[1]
  const name = block.match(/speaker-name">([^<]+)<\/div>/)?.[1]?.trim()
  const mild = [...block.matchAll(/class="mt-1 text-sm text-mild">([^<]*)<\/div>/g)].map(m => m[1].trim())
  if (!img || !name) return null
  if (img.includes('beldex') || img.includes('sponsors-')) return null
  if (/^(MORE SPEAKERS|BELDEX|RADICLE)$/i.test(name.replace(/<br>.*/, ''))) return null
  return {
    name: name.replace(/<br>.*/g, '').trim(),
    org: mild[0] ?? '',
    desc: mild[1] ?? '',
    img,
    href,
    ...extractRefs(href),
  }
}

export function parseSpeakers(html) {
  const start = html.indexOf('<div id="speakers"')
  const end = html.indexOf('MORE SPEAKERS', start)
  if (start < 0 || end < start) throw new Error('Could not locate speakers section in HTML')
  const section = html.slice(start, end)

  const speakers = []
  const anchorRe = /<a href="([^"]*)"[^>]*\bperson-item\b[^>]*>([\s\S]*?)<\/a>/g
  const divRe = /<div class="hover:bg-white hover:text-black person-item border border-white\/30">\s*<div>\s*<img src="\.\/img\/([^"]+)"[\s\S]*?speaker-name">([^<]+)<\/div>\s*<div class="mt-1 text-sm text-mild">([^<]*)<\/div>\s*<div class="mt-1 text-sm text-mild">([^<]*)<\/div>\s*<\/div>\s*<\/div>/g

  let m
  while ((m = anchorRe.exec(section))) {
    const card = parseCard(m[1], m[2])
    if (card) speakers.push(card)
  }
  while ((m = divRe.exec(section))) {
    speakers.push({
      name: m[2].trim(),
      org: m[3].trim(),
      desc: m[4].trim(),
      img: m[1],
      href: '',
    })
  }
  return speakers
}

export function parseTeam(html) {
  const start = html.indexOf('<div id="team"')
  if (start < 0) throw new Error('Could not locate team section in HTML')
  const end = html.indexOf('<!-- Volunteer Section -->', start)
  const section = html.slice(start, end > start ? end : undefined)
  const re = /<div class="team-member">\s*<div class="team-avatar">\s*<img src="\.\/img\/([^"]+)" alt="([^"]*)">\s*<\/div>\s*<h3 class="team-name">([^<]+)<\/h3>\s*<a href="([^"]*)"[^>]*class="team-handle"[^>]*>([^<]*)<\/a>\s*<\/div>/g
  const team = []
  let m
  while ((m = re.exec(section))) {
    const label = m[3].trim()
    const [name, ...roleParts] = label.split(/\s+x\s+/i)
    team.push({
      name: name.trim(),
      role: roleParts.join(' x ').trim(),
      img: m[1],
      imgAlt: m[2].trim(),
      href: m[4].trim(),
      handle: m[5].trim(),
      ...extractRefs(m[4].trim()),
    })
  }
  return team
}

function resolveId(name, existing) {
  const n = norm(name.replace(/^dr\.?\s+/i, ''))
  if (ID_OVERRIDES[n]) return ID_OVERRIDES[n]
  if (existing.has(n)) return existing.get(n)
  return slugify(name)
}

function resolveTeamId(member, existing, byTwitter) {
  if (member.twitter && byTwitter.has(member.twitter.toLowerCase())) {
    return byTwitter.get(member.twitter.toLowerCase())
  }
  const n = norm(member.name)
  if (TEAM_ID_OVERRIDES[n]) return TEAM_ID_OVERRIDES[n]
  if (existing.has(n)) return existing.get(n)
  return slugify(TEAM_DISPLAY_NAMES[n] ?? member.name)
}

function teamDisplayName(member) {
  return TEAM_DISPLAY_NAMES[norm(member.name)] ?? titleCase(member.name)
}

function avatarExt(urlPath) {
  const ext = extname(urlPath.split('?')[0]).slice(1).toLowerCase()
  if (ext === 'jpeg') return 'jpg'
  if (['jpg', 'png', 'webp'].includes(ext)) return ext
  return 'jpg'
}

async function downloadAvatar(imgPath, destPath) {
  const url = `${SITE}/img/${imgPath.replace(/^\/+/, '')}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  writeFileSync(destPath, Buffer.from(await res.arrayBuffer()))
}

function yamlEscape(s) {
  if (/[:#\[\]{}&*!|>'"%@`]/.test(s) || s.includes('\n')) return JSON.stringify(s)
  return s
}

function refsYaml({ twitter, web }) {
  if (!twitter && !web) return ''
  const lines = ['refs:']
  if (twitter) lines.push(`  twitter: ${twitter}`)
  if (web) lines.push(`  web: ${yamlEscape(web)}`)
  return lines.join('\n')
}

function buildPersonYaml({ name, org, desc, twitter, web, avatarFile, formatName = true }) {
  const display = formatName ? titleCase(name.replace(/^DR /i, 'Dr ')) : name
  const lines = [
    `name: ${yamlEscape(display)}`,
    `avatar: ${avatarFile}`,
  ]
  if (org) lines.push(`caption: ${yamlEscape(org)}`)
  if (desc) lines.push(`description: >\n  ${desc}`)
  const refs = refsYaml({ twitter, web })
  if (refs) lines.push(refs)
  return lines.join('\n') + '\n'
}

function stripRefs(yaml) {
  return yaml.replace(/\nrefs:\n(?:  .+\n)+/g, '\n').replace(/\nrefs:\n  .+$/g, '')
}

function upsertRefs(yaml, refs) {
  const base = stripRefs(yaml).replace(/\n+$/, '')
  const block = refsYaml(refs)
  return block ? `${base}\n${block}\n` : `${base}\n`
}

function mergeRefs(yaml, { twitter, web }) {
  if (!twitter && !web) return yaml
  const existingTw = yaml.match(/^  twitter: (.+)$/m)?.[1]
  const existingWeb = yaml.match(/^  web: (.+)$/m)?.[1]
  if (!yaml.match(/^refs:/m)) {
    return upsertRefs(yaml, { twitter, web })
  }
  let next = yaml
  if (twitter && !existingTw && !isSuspiciousTwitter(twitter)) {
    next = next.replace(/^refs:\n/m, `refs:\n  twitter: ${twitter}\n`)
  }
  if (web && !existingWeb) {
    next = next.replace(/^refs:\n/m, `refs:\n  web: ${yamlEscape(web)}\n`)
  }
  return next
}

function fieldBlock(yaml, key) {
  if (key === 'description') {
    const m = yaml.match(/^description: >\n([\s\S]*?)(?=\n(?:[a-zA-Z][\w-]*:|$))/m)
    return m?.[1]?.replace(/^  /gm, '').trim() ?? null
  }
  const m = yaml.match(new RegExp(`^${key}:\\s*"?(.+?)"?\\s*$`, 'm'))
  return m?.[1]?.trim() ?? null
}

function upsertCaption(yaml, caption) {
  if (!caption || fieldBlock(yaml, 'caption')) return yaml
  const lines = yaml.split('\n')
  const avatarIdx = lines.findIndex(l => /^avatar:/.test(l))
  const insertAt = avatarIdx >= 0 ? avatarIdx + 1 : 1
  lines.splice(insertAt, 0, `caption: ${yamlEscape(caption)}`)
  return lines.join('\n')
}

function upsertDescription(yaml, desc) {
  if (!desc || fieldBlock(yaml, 'description')) return yaml
  const block = `description: >\n  ${desc}\n`
  if (/^refs:/m.test(yaml)) return yaml.replace(/^refs:/m, `${block}refs:`)
  return `${yaml.replace(/\n+$/, '')}\n${block}`
}

function listAltNames(yaml) {
  const block = yaml.match(/^altNames:\n((?:  - .+\n)+)/m)?.[1] ?? ''
  return block.match(/^  - (.+)$/gm)?.map(l => l.slice(4).trim()) ?? []
}

function upsertAltName(yaml, name) {
  const display = titleCase(name.replace(/^DR /i, 'Dr '))
  const current = fieldBlock(yaml, 'name')?.replace(/^"|"$/g, '')
  const existing = new Set([
    norm(current ?? ''),
    ...listAltNames(yaml).map(n => norm(n.replace(/^"|"$/g, ''))),
  ])
  if (!display || existing.has(norm(display))) return yaml
  if (/^altNames:/m.test(yaml)) {
    return yaml.replace(/^(altNames:\n(?:  - .+\n)+)/m, `$1  - ${yamlEscape(display)}\n`)
  }
  const lines = yaml.split('\n')
  const avatarIdx = lines.findIndex(l => /^avatar:/.test(l))
  lines.splice(avatarIdx + 1, 0, 'altNames:', `  - ${yamlEscape(display)}`)
  return lines.join('\n')
}

function listAvatarsAlt(yaml) {
  const block = yaml.match(/^avatarsAlt:\n((?:  - .+\n)+)/m)?.[1] ?? ''
  return block.match(/^  - (.+)$/gm)?.map(l => l.slice(4).trim()) ?? []
}

function upsertAvatarsAlt(yaml, filename) {
  if (listAvatarsAlt(yaml).includes(filename)) return yaml
  if (/^avatarsAlt:/m.test(yaml)) {
    return yaml.replace(/^(avatarsAlt:\n(?:  - .+\n)*)/m, `$1  - ${filename}\n`)
  }
  const lines = yaml.split('\n')
  const avatarIdx = lines.findIndex(l => /^avatar:/.test(l))
  lines.splice(avatarIdx + 1, 0, 'avatarsAlt:', `  - ${filename}`)
  return lines.join('\n')
}

function removeAvatarsAlt(yaml, filename) {
  const alts = listAvatarsAlt(yaml).filter(a => a !== filename)
  if (alts.length === listAvatarsAlt(yaml).length) return yaml
  if (alts.length === 0) {
    return yaml.replace(/\n?avatarsAlt:\n(?:  - .+\n)+/m, '\n').replace(/^\n+/, '')
  }
  return yaml.replace(/^avatarsAlt:\n(?:  - .+\n)+/m, `avatarsAlt:\n${alts.map(a => `  - ${a}`).join('\n')}\n`)
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function avatarMatchesPrimary(dir, yaml, candidate) {
  const primary = fieldBlock(yaml, 'avatar')
  if (!primary || candidate === primary) return true
  const primaryPath = join(dir, primary)
  const candidatePath = join(dir, candidate)
  if (!existsSync(primaryPath) || !existsSync(candidatePath)) return false
  return fileHash(primaryPath) === fileHash(candidatePath)
}

function dedupeAltNames(yaml) {
  const block = yaml.match(/^altNames:\n((?:  - .+\n)+)/m)
  if (!block) return yaml
  const seen = new Set()
  const items = []
  for (const raw of block[1].match(/^  - (.+)$/gm).map(l => l.slice(4).trim())) {
    const key = norm(raw.replace(/^"|"$/g, ''))
    if (seen.has(key)) continue
    seen.add(key)
    items.push(raw)
  }
  return yaml.replace(/^altNames:\n(?:  - .+\n)+/m, `altNames:\n${items.map(i => `  - ${i}`).join('\n')}\n`)
}

function existedBeforeSummitImport(id) {
  try {
    execSync(`git cat-file -e 'c62c99d^:people/${id}/index.yaml'`, { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function summarizeChanges(before, after) {
  const parts = []
  if (fieldBlock(before, 'caption') !== fieldBlock(after, 'caption') && fieldBlock(after, 'caption')) {
    parts.push(`caption: ${fieldBlock(after, 'caption')}`)
  }
  if (!fieldBlock(before, 'description') && fieldBlock(after, 'description')) parts.push('description')
  if (stripRefs(before) !== stripRefs(after)) parts.push('refs')
  if (listAltNames(before).length !== listAltNames(after).length) parts.push('altNames')
  if (listAvatarsAlt(before).length !== listAvatarsAlt(after).length) parts.push('avatar alt')
  return parts.join(', ') || 'unchanged'
}

async function updateExistingProfiles(speakers, existing) {
  const byId = new Map(speakers.map(sp => [resolveId(sp.name, existing), sp]))
  let updated = 0

  for (const id of eventSpeakerIds()) {
    if (!existedBeforeSummitImport(id)) continue

    const sp = byId.get(id)
    const path = join(PEOPLE, id, 'index.yaml')
    if (!sp || !existsSync(path)) continue

    const dir = join(PEOPLE, id)
    let yaml = readFileSync(path, 'utf8')
    const before = yaml

    yaml = upsertCaption(yaml, sp.org)
    yaml = upsertDescription(yaml, sp.desc)
    yaml = mergeRefs(yaml, { twitter: sp.twitter, web: sp.web })
    yaml = upsertAltName(yaml, sp.name)
    yaml = dedupeAltNames(yaml)

    const ext = avatarExt(sp.img)
    const altFile = `${ALT_AVATAR}.${ext}`
    const altPath = join(dir, altFile)
    const alreadyAlt = listAvatarsAlt(yaml).includes(altFile)
    if (!SKIP_SUMMIT_AVATAR.has(id) && !alreadyAlt && sp.img) {
      if (!existsSync(altPath)) await downloadAvatar(sp.img, altPath)
      if (!avatarMatchesPrimary(dir, yaml, altFile)) {
        yaml = upsertAvatarsAlt(yaml, altFile)
      } else {
        unlinkSync(altPath)
        console.log(`  ~ ${id} — skipped ${altFile} (same as primary)`)
      }
    }

    if (yaml !== before) {
      writeFileSync(path, yaml.endsWith('\n') ? yaml : `${yaml}\n`)
      console.log(`  ✓ ${id} — ${summarizeChanges(before, yaml)}`)
      updated++
    }
  }

  console.log(`\nUpdated ${updated} existing profiles`)
}

function eventSpeakerIds() {
  const yaml = readFileSync(EVENT_PATH, 'utf8')
  return yaml.match(/^speakers:\n((?:  - .+\n)+)/m)?.[1]
    .match(/^  - (.+)$/gm)
    .map(l => l.slice(4)) ?? []
}

function auditProfiles(speakers, existing) {
  const byId = new Map(speakers.map(sp => [resolveId(sp.name, existing), sp]))
  const issues = []

  for (const id of eventSpeakerIds()) {
    const sp = byId.get(id)
    const path = join(PEOPLE, id, 'index.yaml')
    if (!sp) {
      issues.push({ id, level: 'high', msg: 'on event list but missing from parsed summit speakers' })
      continue
    }
    if (!existsSync(path)) {
      issues.push({ id, level: 'high', msg: 'missing index.yaml' })
      continue
    }

    const y = readFileSync(path, 'utf8')
    const tw = y.match(/^  twitter: (.+)$/m)?.[1]
    const avatar = fieldBlock(y, 'avatar')
    const avatarPath = join(PEOPLE, id, avatar)

    if (sp.img.includes('//') || sp.img.includes(',')) {
      issues.push({ id, level: 'medium', msg: `site image path looks broken: ${sp.img}` })
    }
    if (sp.href && isSuspiciousTwitter(sp.href.match(/(?:x\.com|twitter\.com)\/@?([^/?#]+)/i)?.[1])) {
      issues.push({ id, level: 'high', msg: `site links to bad twitter handle (${sp.href})` })
    }
    if (tw && isSuspiciousTwitter(tw)) {
      issues.push({ id, level: 'high', msg: `profile has suspicious twitter: ${tw}` })
    }
    if (tw && sp.twitter && tw.toLowerCase() !== sp.twitter.toLowerCase()) {
      issues.push({ id, level: 'high', msg: `twitter mismatch: db=${tw} site=${sp.twitter}` })
    }
    if (avatar && existsSync(avatarPath)) {
      const size = readFileSync(avatarPath).length
      if (size < 8000) issues.push({ id, level: 'medium', msg: `${avatar} is very small (${size} bytes)` })
      if (size > 500_000) issues.push({ id, level: 'low', msg: `${avatar} is large (${Math.round(size / 1024)}KB)` })
    } else if (avatar) {
      issues.push({ id, level: 'high', msg: `missing avatar file ${avatar}` })
    }
    for (const alt of listAvatarsAlt(y)) {
      if (!existsSync(join(PEOPLE, id, alt))) {
        issues.push({ id, level: 'high', msg: `missing avatarsAlt file ${alt}` })
      }
    }
    const altNorms = listAltNames(y).map(n => norm(n.replace(/^"|"$/g, '')))
    if (altNorms.length !== new Set(altNorms).size) {
      issues.push({ id, level: 'high', msg: 'duplicate altNames (case/spelling variants)' })
    }
    if (!sp.href && !sp.twitter && !sp.web) {
      issues.push({ id, level: 'low', msg: 'no link on summit card' })
    }
  }

  const order = { high: 0, medium: 1, low: 2 }
  issues.sort((a, b) => order[a.level] - order[b.level] || a.id.localeCompare(b.id))
  console.log(`Audit: ${issues.length} issue(s)\n`)
  for (const i of issues) console.log(`[${i.level}] ${i.id}: ${i.msg}`)
  if (issues.some(i => i.level === 'high')) process.exitCode = 1
}

async function fixRefs(speakers, existing) {
  const byId = new Map()
  for (const sp of speakers) {
    byId.set(resolveId(sp.name, existing), sp)
  }

  let updated = 0
  for (const id of eventSpeakerIds()) {
    const sp = byId.get(id)
    if (!sp) {
      console.warn(`  ? ${id} not found on event page`)
      continue
    }
    const path = join(PEOPLE, id, 'index.yaml')
    if (!existsSync(path)) continue

    const yaml = readFileSync(path, 'utf8')
    const next = upsertRefs(yaml, { twitter: sp.twitter, web: sp.web })
    if (next !== yaml) {
      writeFileSync(path, next)
      const label = sp.twitter ? `twitter: ${sp.twitter}` : sp.web ? `web: ${sp.web}` : '(no link)'
      console.log(`  ✓ ${id} → ${label}`)
      updated++
    }
  }
  console.log(`\nUpdated refs on ${updated} profiles`)
}

async function importMissing(speakers, existing) {
  const speakerIds = []
  let created = 0
  let skipped = 0

  for (const sp of speakers) {
    const id = resolveId(sp.name, existing)
    speakerIds.push(id)
    const dir = join(PEOPLE, id)

    if (existsSync(join(dir, 'index.yaml'))) {
      console.log(`  ✓ ${id} (exists)`)
      skipped++
      continue
    }

    mkdirSync(dir, { recursive: true })
    const avatarFile = `avatar.${avatarExt(sp.img)}`
    await downloadAvatar(sp.img, join(dir, avatarFile))
    writeFileSync(join(dir, 'index.yaml'), buildPersonYaml({ ...sp, avatarFile }), 'utf8')
    existing.set(norm(sp.name), id)
    console.log(`  + ${id}`)
    created++
  }

  const uniqueIds = [...new Set(speakerIds)]
  const eventYaml = readFileSync(EVENT_PATH, 'utf8')
  const speakersBlock = uniqueIds.map(id => `  - ${id}`).join('\n')
  const withoutSpeakers = eventYaml.replace(/^speakers:\n(?:  - .+\n)+/m, '')
  writeFileSync(EVENT_PATH, withoutSpeakers.replace(
    /^description: >-/m,
    `speakers:\n${speakersBlock}\ndescription: >-`,
  ), 'utf8')

  console.log(`\nCreated ${created} people, reused ${skipped} existing`)
  console.log(`Linked ${uniqueIds.length} speakers on neocypherpunk-summit-berlin-2026`)
}

function upsertEventOrganizers(organizers) {
  const yaml = readFileSync(EVENT_PATH, 'utf8')
  const block = organizers.map(({ id, role }) => {
    if (role) return `  - id: ${id}\n    role: ${yamlEscape(role)}`
    return `  - ${id}`
  }).join('\n')
  if (/^organizers:\n/m.test(yaml)) {
    return yaml.replace(/^organizers:\n[\s\S]*?(?=^description:)/m, `organizers:\n${block}\n`)
  }
  return yaml.replace(/^description: >-/m, `organizers:\n${block}\ndescription: >-`)
}

async function importTeam(team, existing, byTwitter) {
  const organizers = []
  let created = 0
  let reused = 0

  for (const member of team) {
    const id = resolveTeamId(member, existing, byTwitter)
    organizers.push({ id, role: member.role })
    const dir = join(PEOPLE, id)
    const yamlPath = join(dir, 'index.yaml')

    if (existsSync(yamlPath)) {
      let yaml = readFileSync(yamlPath, 'utf8')
      const before = yaml
      yaml = mergeRefs(yaml, { twitter: member.twitter, web: member.web })
      yaml = upsertAltName(yaml, teamDisplayName(member))
      if (yaml !== before) writeFileSync(yamlPath, yaml.endsWith('\n') ? yaml : `${yaml}\n`)
      console.log(`  ✓ ${id} (exists)`)
      reused++
      continue
    }

    mkdirSync(dir, { recursive: true })
    const avatarFile = `avatar.${avatarExt(member.img)}`
    await downloadAvatar(member.img, join(dir, avatarFile))
    writeFileSync(yamlPath, buildPersonYaml({
      name: teamDisplayName(member),
      desc: '',
      twitter: member.twitter,
      web: member.web,
      avatarFile,
      formatName: false,
    }), 'utf8')
    existing.set(norm(member.name), id)
    if (member.twitter) byTwitter.set(member.twitter.toLowerCase(), id)
    console.log(`  + ${id}`)
    created++
  }

  writeFileSync(EVENT_PATH, upsertEventOrganizers(organizers), 'utf8')
  console.log(`\nCreated ${created} people, reused ${reused} existing`)
  console.log(`Linked ${organizers.length} organizers on neocypherpunk-summit-berlin-2026`)
}

function dedupeAvatars() {
  let removed = 0
  for (const id of eventSpeakerIds()) {
    const dir = join(PEOPLE, id)
    const path = join(dir, 'index.yaml')
    if (!existsSync(path)) continue
    let yaml = readFileSync(path, 'utf8')
    const before = yaml
    for (const alt of [...listAvatarsAlt(yaml)]) {
      const altPath = join(dir, alt)
      if (!existsSync(altPath)) {
        yaml = removeAvatarsAlt(yaml, alt)
        continue
      }
      if (avatarMatchesPrimary(dir, yaml, alt)) {
        unlinkSync(altPath)
        yaml = removeAvatarsAlt(yaml, alt)
        console.log(`  ✓ ${id} — removed ${alt} (duplicate of ${fieldBlock(yaml, 'avatar')})`)
        removed++
      }
    }
    if (yaml !== before) {
      writeFileSync(path, yaml.endsWith('\n') ? yaml : `${yaml}\n`)
    }
  }
  console.log(`\nRemoved ${removed} duplicate avatar-alt file(s)`)
}

async function main() {
  const html = readFileSync(HTML_PATH, 'utf8')
  const speakers = parseSpeakers(html)
  const existing = loadExisting()
  console.log(`Parsed ${speakers.length} speakers from event page\n`)

  if (FIX_REFS) {
    await fixRefs(speakers, existing)
    return
  }
  if (AUDIT) {
    auditProfiles(speakers, existing)
    return
  }
  if (UPDATE_EXISTING) {
    await updateExistingProfiles(speakers, existing)
    return
  }
  if (IMPORT_TEAM) {
    const team = parseTeam(html)
    const byTwitter = loadExistingByTwitter()
    console.log(`Parsed ${team.length} team members from event page\n`)
    await importTeam(team, existing, byTwitter)
    return
  }
  if (DEDUPE_AVATARS) {
    dedupeAvatars()
    return
  }
  await importMissing(speakers, existing)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
