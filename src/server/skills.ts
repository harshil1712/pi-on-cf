import type { Registry } from '@earendil-works/pi-durable'
import { skills } from 'agents/harness/pi'
import { loadSkillCatalog, manifest, parseSkill, r2, type SkillCatalog as AgentSkillCatalog, type SkillSource } from 'agents/skills'
import skillCreator from './bundled-skills/skill-creator/SKILL.md?raw'
import skillCreatorLicense from './bundled-skills/skill-creator/references/LICENSE.txt?raw'

/** Where skills live in the app's R2 bucket: `skills/<dir>/SKILL.md` plus resources. */
export const SKILLS_PREFIX = 'skills/'

/**
 * Skills built into the application, from `src/server/bundled-skills`.
 * Listed before the bucket, so a shared skill cannot replace one.
 */
export const builtInSkills: SkillSource = builtIn()

function builtIn(): SkillSource {
  const parsed = parseSkill(skillCreator)

  if (!parsed.ok) throw parsed.error
  const { name, description, body, license, compatibility, metadata, allowedTools } = parsed.value

  return manifest({
    id: 'built-in',
    skills: [{
      name,
      description,
      body,
      license,
      compatibility,
      metadata,
      allowedTools: allowedTools.join(' '),
      resources: [{ path: 'references/LICENSE.txt', content: skillCreatorLicense }],
    }],
  })
}

/** The Agent Skills specification's name rule (agentskills.io/specification). */
export function isSkillName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
}

/**
 * Publish a skill to `skills/<name>/`, replacing every file of a shared skill
 * with that name. `files` maps paths inside the skill to their text.
 * New files go first and SKILL.md last, then stale files are deleted, so an
 * existing skill never disappears while it is replaced.
 */
export async function publishSkill(bucket: R2Bucket, name: string, files: ReadonlyMap<string, string>): Promise<void> {
  if (!isSkillName(name)) throw new Error(`"${name}" is not a valid skill name.`)
  const skillFile = files.get('SKILL.md')

  if (skillFile === undefined) throw new Error(`${name} has no SKILL.md.`)
  const parsed = parseSkill(skillFile)

  if (!parsed.ok) throw new Error('SKILL.md needs name and description frontmatter.')

  if (parsed.value.name !== name) throw new Error(`SKILL.md is named "${parsed.value.name}"; it must match its directory, "${name}".`)
  const listed = await builtInSkills.list()

  if (listed.ok && listed.value.skills.some(({ skill }) => skill.name === name)) throw new Error(`"${name}" is a built-in skill.`)

  const directory = `${SKILLS_PREFIX}${name}/`
  const paths = [...files.keys()].filter((path) => path !== 'SKILL.md').concat('SKILL.md')

  for (const path of paths) await bucket.put(`${directory}${path}`, files.get(path)!)
  const published = new Set(paths.map((path) => `${directory}${path}`))
  const stale = (await listKeys(bucket, directory)).filter((key) => !published.has(key))

  if (stale.length) await bucket.delete(stale)
}

/** A shared skill's files by their path inside the skill, or null if there is no such skill. */
export async function readSharedSkill(bucket: R2Bucket, name: string): Promise<Map<string, string> | null> {
  if (!isSkillName(name)) return null
  const directory = `${SKILLS_PREFIX}${name}/`
  const files = new Map<string, string>()

  for (const key of await listKeys(bucket, directory)) {
    const object = await bucket.get(key)

    if (object) files.set(key.slice(directory.length), await object.text())
  }

  return files.has('SKILL.md') ? files : null
}

/** Delete a shared skill; false if there was none. */
export async function deleteSharedSkill(bucket: R2Bucket, name: string): Promise<boolean> {
  if (!isSkillName(name)) return false
  const keys = await listKeys(bucket, `${SKILLS_PREFIX}${name}/`)

  if (!keys.length) return false
  // SKILL.md first, so a skill is never listed with only some of its files.
  const skillFile = `${SKILLS_PREFIX}${name}/SKILL.md`

  if (keys.includes(skillFile)) await bucket.delete(skillFile)
  // R2 refuses an empty list, which a skill of only SKILL.md would leave.
  const rest = keys.filter((key) => key !== skillFile)

  if (rest.length) await bucket.delete(rest)

  return true
}

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined

  do {
    const listed = await bucket.list({ prefix, cursor })
    keys.push(...listed.objects.map(({ key }) => key))
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)

  return keys
}

/**
 * The Agents SDK's R2 skill source over `skills/` in the app's bucket. It
 * caches its index and lists the bucket again at most once per
 * `refreshIntervalMs`, one minute by default.
 */
export function bucketSkills(bucket: R2Bucket, options: { refreshIntervalMs?: number } = {}): SkillSource {
  return r2(bucket, { prefix: SKILLS_PREFIX, id: 'r2:skills', ...options })
}

/**
 * Keeps pi's `agents.skills` extension in step with its sources.
 *
 * `skills()` resolves the sources once into a fixed catalog and a fixed
 * `activate_skill` name list, and `PiHarness` never rebuilds it, so a skill
 * added to the bucket stays invisible until the extension is built again.
 * `sync()` lists every source and reinstalls the extension when the catalog's
 * prompt fingerprint moved; pi-durable replaces an extension installed under
 * the same name and uses it from the next model request, even mid-run.
 */
export class SkillCatalog {
  readonly #createSources: () => readonly SkillSource[]
  #sources: readonly SkillSource[]
  #catalog: AgentSkillCatalog | undefined
  #fingerprint: string | undefined
  #syncing: Promise<boolean> = Promise.resolve(false)

  constructor(createSources: () => readonly SkillSource[]) {
    this.#createSources = createSources
    this.#sources = createSources()
  }

  /** Install the extension if it is missing or stale. Resolves `true` when it (re)installed. */
  sync(registry: Registry): Promise<boolean> {
    // One sync at a time: two would list the bucket twice and race to install.
    this.#syncing = this.#syncing.catch(() => false).then(() => this.#sync(registry))

    return this.#syncing
  }

  /**
   * Rebuild the catalog from fresh sources. A source rate-limits its own
   * refreshes, so this is how a session sees its own change at once.
   */
  reload(registry: Registry): Promise<boolean> {
    this.#syncing = this.#syncing.catch(() => false).then(() => {
      this.#sources = this.#createSources()
      this.#catalog = undefined
      this.#fingerprint = undefined

      return this.#sync(registry)
    })

    return this.#syncing
  }

  async #sync(registry: Registry): Promise<boolean> {
    const catalog = await loadSkillCatalog(this.#sources, { previous: this.#catalog })

    if (catalog.fingerprint === this.#fingerprint) {
      this.#catalog = catalog

      return false
    }

    // `skills()` logs source and parse diagnostics and builds the Pi tools over the catalog.
    const extension = await skills(this.#sources)
    this.#catalog = catalog
    this.#fingerprint = catalog.fingerprint
    registry.install(extension)

    return true
  }
}
