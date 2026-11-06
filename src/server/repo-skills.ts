import type { WorkspaceClient } from '@cloudflare/computer'
import { manifest, parseSkill, type SkillManifest, type SkillManifestEntry, type SkillSource } from 'agents/skills'
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
 * `manifest()` source. Each catalog listing reads the repository again and
 * swaps in a new manifest; resource reads use the manifest from that listing.
 * Without a clone it has no skills.
 */
export function repoSkills(workspace: () => PromiseLike<WorkspaceClient>, task: () => SessionTask | null): SkillSource {
  let current: SkillSource | undefined

  const refresh = async () => {
    current = manifest(await readManifest(await workspace(), task()))
  }

  return {
    id: ID,
    list: async () => {
      await refresh()

      return current!.list()
    },
    readResource: async (name, path) => {
      if (!current) await refresh()

      return current!.readResource(name, path)
    },
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
        const parsed = raw === null ? null : parseSkill(raw, { directory: entry.name })

        if (!parsed?.ok || skills.some((skill) => skill.name === parsed.value.name)) continue
        const { name, description, body, license, compatibility, metadata, allowedTools } = parsed.value
        skills.push({
          name,
          description,
          license,
          compatibility,
          metadata,
          allowedTools: allowedTools.join(' '),
          // The agent runs a skill's scripts with exec, so it needs to know where they are.
          body: `This skill is from the repository ${task.repo}, at ${directory}. Its files are there too; run its scripts from there.\n\n${body}`,
          resources: await readResources(workspace, directory),
        })
      }
    }
  }

  return { id: ID, skills }
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

    return content === null ? null : { path, kind: resourceKind(path), encoding: 'text' as const, content }
  }))

  return resources.filter((resource) => resource !== null)
}

function resourceKind(path: string): 'reference' | 'script' | 'asset' | 'file' {
  if (path.startsWith('references/')) return 'reference'

  if (path.startsWith('scripts/')) return 'script'

  if (path.startsWith('assets/')) return 'asset'

  return 'file'
}
