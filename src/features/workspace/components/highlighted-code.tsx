import { code, createCodePlugin } from '@streamdown/code'
import { Streamdown } from 'streamdown'

const workspaceCode = createCodePlugin({ themes: ['github-dark', 'github-dark'] })

const languagesByExtension: Record<string, string> = {
  cjs: 'javascript',
  css: 'css',
  html: 'html',
  js: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  jsx: 'jsx',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  sh: 'shellscript',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'tsx',
  yaml: 'yaml',
  yml: 'yaml',
}

export function HighlightedMarkdown({ children, active }: { children: string; active: boolean }) {
  return (
    <Streamdown caret={active ? 'block' : undefined} controls={{ code: { download: false } }} isAnimating={active} plugins={{ code }}>
      {children}
    </Streamdown>
  )
}

export function HighlightedFile({ content, path }: { content: string; path: string }) {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  const language = languagesByExtension[extension] ?? 'text'
  const longestFence = Math.max(2, ...Array.from(content.matchAll(/`+/g), ([fence]) => fence.length))
  const fence = '`'.repeat(longestFence + 1)

  return (
    <>
      <pre className="sr-only"><code>{content}</code></pre>
      <Streamdown className="code-viewer" controls={false} lineNumbers plugins={{ code: workspaceCode }}>
        {`${fence}${language}\n${content}\n${fence}`}
      </Streamdown>
    </>
  )
}
