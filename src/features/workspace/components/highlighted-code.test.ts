import { describe, expect, it } from 'vitest'
import { languageForPath, parseFrontmatter } from './highlighted-code'

describe('languageForPath', () => {
  it.each([
    ['/workspace/src/index.ts', 'ts'],
    ['/workspace/main.go', 'go'],
    ['/workspace/lib.rs', 'rs'],
    ['/workspace/wrangler.toml', 'toml'],
    ['/workspace/config.yml', 'yml'],
    ['/workspace/server.mjs', 'javascript'],
    ['/workspace/logo.svg', 'xml'],
    ['/workspace/Dockerfile', 'dockerfile'],
    ['/workspace/.env.local', 'dotenv'],
    ['/workspace/notes.unknownext', 'text'],
    ['/workspace/LICENSE', 'text'],
  ])('%s → %s', (path, language) => {
    expect(languageForPath(path)).toBe(language)
  })
})

describe('parseFrontmatter', () => {
  it('splits SKILL.md-style frontmatter from the body', () => {
    const { entries, body } = parseFrontmatter('---\nname: my-skill\ndescription: "Does a thing"\n---\n# Title\n')
    expect(entries).toEqual([['name', 'my-skill'], ['description', 'Does a thing']])
    expect(body).toBe('# Title\n')
  })

  it('folds and keeps block scalars', () => {
    const { entries } = parseFrontmatter('---\nfolded: >\n  one\n  two\nliteral: |\n  a\n  b\n---\n')
    expect(entries).toEqual([['folded', 'one two'], ['literal', 'a\nb']])
  })

  it('leaves documents without frontmatter untouched', () => {
    expect(parseFrontmatter('# Just markdown\n---\n')).toEqual({ entries: [], body: '# Just markdown\n---\n' })
  })
})
