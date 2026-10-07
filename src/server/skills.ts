import type { Registry } from '@earendil-works/pi-durable'
import { skills } from 'agents/harness/pi'
import { r2, type SkillSource } from 'agents/skills'

/** Where skills live in the app's R2 bucket: `skills/<dir>/SKILL.md` plus resources. */
export const SKILLS_PREFIX = 'skills/'

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
 * `sync()` refreshes every source and reinstalls the extension when a
 * fingerprint moved; pi-durable replaces an extension installed under the
 * same name and uses it from the next model request, even mid-run.
 */
export class SkillCatalog {
  readonly #sources: readonly SkillSource[]
  #fingerprint: string | undefined
  #syncing: Promise<boolean> = Promise.resolve(false)

  constructor(sources: readonly SkillSource[]) {
    this.#sources = sources
  }

  /** Install the extension if it is missing or stale. Resolves `true` when it (re)installed. */
  sync(registry: Registry): Promise<boolean> {
    // One sync at a time: two would list the bucket twice and race to install.
    this.#syncing = this.#syncing.catch(() => false).then(() => this.#sync(registry))
    return this.#syncing
  }

  async #sync(registry: Registry): Promise<boolean> {
    if (this.#fingerprint !== undefined) {
      // A source that fails keeps its last index.
      await Promise.all(this.#sources.map(async (source) => {
        try {
          await source.refresh?.()
        } catch (error) {
          console.warn(`pi skills: could not refresh "${source.id}"`, error)
        }
      }))
      if (this.#current() === this.#fingerprint) return false
    }
    // `skills()` logs a source that fails to list and builds without it.
    const extension = await skills(this.#sources)
    // Read after `skills()`: a source's fingerprint is settled once it has listed.
    this.#fingerprint = this.#current()
    registry.install(extension)
    return true
  }

  #current(): string {
    return this.#sources.map((source) => `${source.id}:${source.fingerprint}`).join('|')
  }
}
