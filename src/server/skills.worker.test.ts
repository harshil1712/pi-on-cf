import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PiSession as TestPiSession } from '../server-test-entry'
import { SKILLS_PREFIX } from './skills'

const session = () => env.PiSession.getByName(crypto.randomUUID()) as unknown as DurableObjectStub<TestPiSession>

function skillFile(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`
}

async function clearBucket(): Promise<void> {
  const listed = await env.BUCKET.list()
  if (listed.objects.length) await env.BUCKET.delete(listed.objects.map(({ key }) => key))
}

describe('skills from R2', () => {
  beforeEach(clearBucket)

  it('offers no skills when the bucket has none', async () => {
    await env.BUCKET.put('elsewhere/notes.txt', 'not a skill')
    const result = await session().promptForTest('catalog')
    expect(result.text).toBe('catalog: none')
  })

  it('lists skills from the skills folder in the system prompt', async () => {
    await env.BUCKET.put(`${SKILLS_PREFIX}release-notes/SKILL.md`, skillFile('release-notes', 'Write release notes.', 'One line per change.'))
    // Outside the prefix, and nested too deep: neither is a skill.
    await env.BUCKET.put('other/SKILL.md', skillFile('outsider', 'Not in skills/.', 'x'))
    await env.BUCKET.put(`${SKILLS_PREFIX}group/nested/SKILL.md`, skillFile('nested', 'Too deep.', 'x'))

    const result = await session().promptForTest('catalog')
    expect(result.text).toContain('- release-notes: Write release notes.')
    expect(result.text).not.toContain('outsider')
    expect(result.text).not.toContain('nested')
  })

  it('activates a skill and returns its instructions and resources', async () => {
    await env.BUCKET.put(`${SKILLS_PREFIX}release-notes/SKILL.md`, skillFile('release-notes', 'Write release notes.', 'One line per change.'))
    await env.BUCKET.put(`${SKILLS_PREFIX}release-notes/references/style.md`, 'Use the past tense.')

    const result = await session().promptForTest('skill release-notes')
    expect(result.kinds).toContain('pi.tool-result')
    expect(result.text).toMatch(/^tool said:/)
    expect(result.text).toContain('One line per change.')
    expect(result.text).toContain('references/style.md')
  })

  it('reads a resource from the bucket when the model asks for it', async () => {
    await env.BUCKET.put(`${SKILLS_PREFIX}release-notes/SKILL.md`, skillFile('release-notes', 'Write release notes.', 'See the style guide.'))
    await env.BUCKET.put(`${SKILLS_PREFIX}release-notes/references/style.md`, 'Use the past tense.')
    await env.BUCKET.put(`${SKILLS_PREFIX}secret.md`, 'outside any skill')
    const pi = session()

    expect((await pi.promptForTest('resource release-notes references/style.md')).text).toContain('Use the past tense.')
    expect((await pi.promptForTest('resource release-notes ../secret.md')).text).toContain('Skill resource not found')
    expect((await pi.promptForTest('resource release-notes references/missing.md')).text).toContain('Skill resource not found')
  })

  it('skips a SKILL.md without a name and a description', async () => {
    await env.BUCKET.put(`${SKILLS_PREFIX}broken/SKILL.md`, '---\nname: broken\n---\nNo description.\n')
    await env.BUCKET.put(`${SKILLS_PREFIX}bare/SKILL.md`, 'No frontmatter at all.\n')
    await env.BUCKET.put(`${SKILLS_PREFIX}good/SKILL.md`, skillFile('good', 'A valid skill.', 'x'))

    const result = await session().promptForTest('catalog')
    expect(result.text).toContain('- good: A valid skill.')
    expect(result.text).not.toContain('broken')
    expect(result.text).not.toContain('bare')
  })

  it('picks up a skill added to the bucket after the session started', async () => {
    const pi = session()
    expect((await pi.promptForTest('catalog')).text).toBe('catalog: none')
    expect(await pi.syncSkillsForTest()).toBe(false)

    await env.BUCKET.put(`${SKILLS_PREFIX}deploy/SKILL.md`, skillFile('deploy', 'Deploy a Worker.', 'Run wrangler deploy.'))
    expect(await pi.syncSkillsForTest()).toBe(true)
    expect((await pi.promptForTest('catalog')).text).toContain('- deploy: Deploy a Worker.')
    expect((await pi.promptForTest('skill deploy')).text).toContain('Run wrangler deploy.')

    await env.BUCKET.delete(`${SKILLS_PREFIX}deploy/SKILL.md`)
    expect(await pi.syncSkillsForTest()).toBe(true)
    expect((await pi.promptForTest('catalog')).text).toBe('catalog: none')
  })
})
