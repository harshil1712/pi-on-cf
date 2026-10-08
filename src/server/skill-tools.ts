import type { WorkspaceClient } from '@cloudflare/computer'
import { Type } from '@earendil-works/pi-ai'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { deleteSharedSkill, isSkillName, publishSkill, readSharedSkill } from './skills'
import { WORKSPACE_ROOT } from './workspace-root'

/** Where the agent drafts and edits skills: `/workspace/skills/<name>/`. */
const SKILL_DRAFTS = `${WORKSPACE_ROOT}/skills`

const nameParameter = Type.Object({
  name: Type.String({ description: 'The skill name: lowercase letters, digits, and single hyphens.' }),
})

type SkillToolsOptions = {
  bucket: R2Bucket
  workspace: WorkspaceClient
  /** Called after a shared skill changes, so this session sees it at once. */
  onChange: () => Promise<unknown>
}

/**
 * The agent's tools for shared skills. Every session sees a shared skill,
 * so the agent drafts one in its workspace with the ordinary file tools and
 * publishes the whole directory with `save_skill`.
 */
export function createSkillTools({ bucket, workspace, onChange }: SkillToolsOptions): ToolRegistration[] {
  return [
    {
      name: 'open_skill',
      description: `Copy a shared skill's files into ${SKILL_DRAFTS}/<name>/, replacing anything there, so you can change them with the file tools and publish the result with save_skill. Built-in skills cannot be opened.`,
      parameters: nameParameter as unknown as ToolRegistration['parameters'],
      replay: 'safe',
      async execute(args) {
        const { name } = args as { name: string }
        const files = await readSharedSkill(bucket, name)
        if (!files) return failure(`There is no shared skill named "${name}".`)
        const directory = `${SKILL_DRAFTS}/${name}`
        await workspace.fs.rm(directory, { recursive: true, force: true })
        for (const [path, content] of files) {
          const target = `${directory}/${path}`
          await workspace.fs.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
          await workspace.fs.writeFile(target, content)
        }
        return success(`Copied ${name} to ${directory}/: ${[...files.keys()].sort().join(', ')}.`)
      },
    },
    {
      name: 'save_skill',
      description: `Publish ${SKILL_DRAFTS}/<name>/ as a shared skill that every session can use, creating it or replacing every file of the shared skill with that name. The directory needs a SKILL.md whose frontmatter name matches the directory name.`,
      parameters: nameParameter as unknown as ToolRegistration['parameters'],
      replay: 'safe',
      async execute(args) {
        const { name } = args as { name: string }
        if (!isSkillName(name)) return failure(`"${name}" is not a valid skill name.`)
        const directory = `${SKILL_DRAFTS}/${name}`
        const files = new Map<string, string>()
        const found = await workspace.fs.find(directory, '**').catch(() => [])
        for (const entry of found) {
          if (entry.type === 'file') files.set(entry.path.slice(directory.length + 1), await workspace.fs.readFile(entry.path, 'utf8'))
        }
        if (!files.size) return failure(`${directory}/ has no files.`)
        try {
          await publishSkill(bucket, name, files)
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error))
        }
        await onChange()
        return success(`Saved ${name} with ${files.size} file(s). Every session can use it now; other sessions pick it up within a minute.`)
      },
    },
    {
      name: 'delete_skill',
      description: 'Delete a shared skill, so no session can use it. Only do this when the user asks. Built-in skills cannot be deleted.',
      parameters: nameParameter as unknown as ToolRegistration['parameters'],
      replay: 'safe',
      async execute(args) {
        const { name } = args as { name: string }
        if (!(await deleteSharedSkill(bucket, name))) return failure(`There is no shared skill named "${name}".`)
        await onChange()
        return success(`Deleted ${name}. Other sessions stop offering it within a minute.`)
      },
    },
  ]
}

function success(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function failure(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}
