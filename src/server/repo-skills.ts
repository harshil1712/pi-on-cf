import type { WorkspaceClient } from '@cloudflare/computer'
import { fromManifest, parseSkillMarkdown, type SkillManifest, type SkillManifestEntry, type SkillSource } from 'agents/skills'
import type { SessionTask } from '~/contract'

/**
 * Where a repository keeps its Agent Skills, as `<dir>/<name>/SKILL.md`:
 * the cross-client `.agents/skills`, then Claude Code's, pi's and GitHub
 * Copilot's. The first directory to define a name wins.
 */
export const REPO_SKILL_DIRS = ['.agents/skills', '.claude/skills', '.pi/skills', '.github/skills']

const ID = 'repo'
/** Files read per skill, and bytes per file; a skill past these is cut. */
const RESOURCE_LIMIT = 100
const RESOURCE_BYTES = 256 * 1024
const RESOURCE_EXCLUDE = ['**/node_modules', '**/.git']

/**
 * The skills in the session's cloned repository, as the Agents SDK's
 * `fromManifest()` source. A manifest is fixed when it is built, so this
 * reads the repository again on every refresh and swaps in a new one; a
 * clone, or a skill the agent writes, shows up at the next
 * `SkillCatalog.sync`. Without a clone it has no skills.
 */
export function repoSkills(workspace: () => Promise<WorkspaceClient>, task: () => SessionTask | null): SkillSource {
  let current: SkillSource | undefined
  const refresh = async () => {
    current = fromManifest(await readManifest(await workspace(), task()))
  }
  const source = async () => {
    if (!current) await refresh()
    return current!
  }
  return {
    id: ID,
    get fingerprint() {
      return current?.fingerprint ?? `${ID}:unread`
    },
    list: async () => (await source()).list(),
    load: async (name) => (await source()).load(name),
    readResource: async (name, path) => (await source()).readResource?.(name, path) ?? null,
    refresh,
  }
}

/** Every skill in the cloned repository, with its files, as a manifest. */
export async function readManifest(workspace: WorkspaceClient, task: SessionTask | null): Promise<SkillManifest> {
  const skills: SkillManifestEntry[] = []
  if (task) {
    for (const base of REPO_SKILL_DIRS.map((dir) => `${task.dir}/${dir}`)) {
      const entries = await workspace.fs.readdir(base).catch(() => [])
      for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory) continue
        const directory = `${base}/${entry.name}`
        const raw = await workspace.fs.readFile(`${directory}/SKILL.md`, 'utf8').catch(() => null)
        const parsed = raw === null ? null : parseSkillMarkdown(raw)
        if (!parsed?.name || !parsed.description || skills.some((skill) => skill.name === parsed.name)) continue
        skills.push({
          ...parsed,
          // The agent runs a skill's scripts with exec, so it needs to know where they are.
          body: `This skill is from the repository ${task.repo}, at ${directory}. Its files are there too; run its scripts from there.\n\n${parsed.body}`,
          rawContent: raw ?? undefined,
          resources: await readResources(workspace, directory),
        })
      }
    }
  }
  return { id: ID, fingerprint: `${ID}:${task?.dir ?? 'none'}:${hash(JSON.stringify(skills))}`, skills }
}

async function readResources(workspace: WorkspaceClient, directory: string): Promise<NonNullable<SkillManifestEntry['resources']>> {
  const found = await workspace.fs.find(directory, '**', { exclude: RESOURCE_EXCLUDE, limit: RESOURCE_LIMIT }).catch(() => [])
  const paths = found
    .filter((file) => file.type === 'file')
    .map((file) => file.path.slice(directory.length + 1))
    .filter((path) => path !== 'SKILL.md')
    .sort()
  const resources = await Promise.all(paths.map(async (path) => {
    const stat = await workspace.fs.stat(`${directory}/${path}`).catch(() => null)
    if (!stat || stat.size > RESOURCE_BYTES) return null
    const content = await workspace.fs.readFile(`${directory}/${path}`, 'utf8').catch(() => null)
    return content === null ? null : { path, kind: resourceKind(path), encoding: 'text' as const, size: stat.size, content }
  }))
  return resources.filter((resource) => resource !== null)
}

function resourceKind(path: string): 'reference' | 'script' | 'asset' | 'file' {
  if (path.startsWith('references/')) return 'reference'
  if (path.startsWith('scripts/')) return 'script'
  if (path.startsWith('assets/')) return 'asset'
  return 'file'
}

/** FNV-1a, as the SDK's R2 source fingerprints its index. */
function hash(text: string): string {
  let value = 2166136261
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619)
  return (value >>> 0).toString(16)
}
