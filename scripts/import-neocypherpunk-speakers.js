/**
 * Import Neocypherpunk Summit 2026 speakers from s26ber.web3privacy.info
 *
 *   node scripts/import-neocypherpunk-speakers.js [html-path]       # create missing people + link event
 *   node scripts/import-neocypherpunk-speakers.js --fix-refs [html] # repair refs on imported speakers
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const PEOPLE = join(ROOT, 'people')
const EVENT_PATH = join(ROOT, '..', 'events', 'events', 'neocypherpunk-summit-berlin-2026', 'index.yaml')
const SITE = 'https://s26ber.web3privacy.info'
const args = process.argv.slice(2)
const FIX_REFS = args.includes('--fix-refs')
const HTML_PATH = args.find(a => !a.startsWith('--')) ?? '/tmp/ncs.html'

const ID_OVERRIDES = {
  'denis jaromil roio': 'jaromil',
  'rachel rose o leary': 'lunar-mining',
  'nick almond': 'dr-nick',
  'josh davila': 'joshua-davila',
  'peter szilagyi': 'peter-szilagyi',
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

function extractRefs(href) {
  if (!href) return {}
  const twitter = href.match(/(?:x\.com|twitter\.com)\/@?([^/?#]+)/i)?.[1]
  if (twitter) return { twitter }
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

function resolveId(name, existing) {
  const n = norm(name.replace(/^dr\.?\s+/i, ''))
  if (ID_OVERRIDES[n]) return ID_OVERRIDES[n]
  if (existing.has(n)) return existing.get(n)
  return slugify(name)
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

function buildPersonYaml({ name, org, desc, twitter, web, avatarFile }) {
  const lines = [
    `name: ${yamlEscape(titleCase(name.replace(/^DR /i, 'Dr ')))}`,
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

function eventSpeakerIds() {
  const yaml = readFileSync(EVENT_PATH, 'utf8')
  return yaml.match(/^speakers:\n((?:  - .+\n)+)/m)?.[1]
    .match(/^  - (.+)$/gm)
    .map(l => l.slice(4)) ?? []
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

async function main() {
  const html = readFileSync(HTML_PATH, 'utf8')
  const speakers = parseSpeakers(html)
  const existing = loadExisting()
  console.log(`Parsed ${speakers.length} speakers from event page\n`)

  if (FIX_REFS) {
    await fixRefs(speakers, existing)
    return
  }
  await importMissing(speakers, existing)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
