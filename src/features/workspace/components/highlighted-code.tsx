import { code, createCodePlugin } from '@streamdown/code'
import type { BundledLanguage } from 'shiki'
import { Streamdown } from 'streamdown'
import { CODE_VIEWER } from './code-viewer'

const workspaceCode = createCodePlugin({ themes: ['github-light', 'github-dark'] })

/** Extensions Shiki doesn't recognise by name. Everything else is tried as-is (ts, py, go, rs, toml, ...). */
const languagesByExtension: Record<string, string> = {
  cjs: 'javascript',
  cts: 'typescript',
  htm: 'html',
  markdown: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  svg: 'xml',
  tf: 'terraform',
  txt: 'text',
}

const languagesByFilename: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.gitignore': 'text',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])

function fileName(path: string) {
  return path.split('/').pop()?.toLowerCase() ?? ''
}

function extension(path: string) {
  const name = fileName(path)
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index + 1) : ''
}

export function isMarkdownPath(path: string) {
  return MARKDOWN_EXTENSIONS.has(extension(path))
}

export function languageForPath(path: string) {
  const name = fileName(path)
  if (languagesByFilename[name]) return languagesByFilename[name]
  if (name.startsWith('.env')) return 'dotenv'
  if (name.startsWith('dockerfile')) return 'dockerfile'
  const ext = extension(path)
  const language = languagesByExtension[ext] ?? ext
  return language && workspaceCode.supportsLanguage(language as BundledLanguage) ? language : 'text'
}

function fenced(content: string, language: string) {
  const longestFence = Math.max(2, ...Array.from(content.matchAll(/`+/g), ([fence]) => fence.length))
  const fence = '`'.repeat(longestFence + 1)
  return `${fence}${language}\n${content}\n${fence}`
}

type Frontmatter = { entries: Array<[string, string]>; body: string }

/**
 * Splits leading YAML frontmatter (as in SKILL.md) into top-level key/value
 * pairs. Nested structures are kept as their raw indented text.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)
  if (!match) return { entries: [], body: content }

  const entries: Array<[string, string, string[]]> = []
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line)
    if (field) entries.push([field[1]!, field[2]!.trim(), []])
    else if (entries.length > 0) entries.at(-1)![2].push(line.trim())
  }

  return {
    entries: entries.map(([key, value, rest]) => {
      // `|` keeps line breaks, `>` folds them; quotes are presentation only.
      if (/^[|>][+-]?$/.test(value)) return [key, rest.join(value.startsWith('|') ? '\n' : ' ').trim()]
      const joined = [value, ...rest].filter(Boolean).join(' ')
      return [key, joined.replace(/^(['"])([\s\S]*)\1$/, '$2')]
    }),
    body: content.slice(match[0].length),
  }
}

export function HighlightedMarkdown({ children, active }: { children: string; active: boolean }) {
  return (
    <Streamdown caret={active ? 'block' : undefined} controls={{ code: { download: false } }} isAnimating={active} plugins={{ code }}>
      {children}
    </Streamdown>
  )
}

export function HighlightedFile({ content, path }: { content: string; path: string }) {
  return (
    <>
      <pre className="sr-only"><code>{content}</code></pre>
      <Streamdown className={CODE_VIEWER} controls={false} lineNumbers mode="static" plugins={{ code: workspaceCode }}>
        {fenced(content, languageForPath(path))}
      </Streamdown>
    </>
  )
}

export function MarkdownFile({ content }: { content: string }) {
  const { entries, body } = parseFrontmatter(content)

  return (
    <div className="markdown-viewer min-h-0 min-w-0 overflow-auto px-5 pt-4 pb-8 text-sm leading-relaxed wrap-anywhere">
      {entries.length > 0 && (
        <dl className="mb-5 divide-y divide-kumo-hairline overflow-hidden rounded-lg border border-kumo-hairline text-xs">
          {entries.map(([key, value]) => (
            <div key={key} className="grid grid-cols-[minmax(72px,max-content)_minmax(0,1fr)] gap-3 px-3 py-1.75">
              <dt className="font-mono text-kumo-subtle">{key}</dt>
              <dd className="whitespace-pre-wrap">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <Streamdown mode="static" controls={{ code: { download: false } }} plugins={{ code: workspaceCode }}>
        {body}
      </Streamdown>
    </div>
  )
}
