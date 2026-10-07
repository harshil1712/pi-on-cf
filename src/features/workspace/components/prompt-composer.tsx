import type { FormEventHandler } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { InputArea } from '@cloudflare/kumo/components/input'
import { ArrowUpIcon, StopIcon } from '@phosphor-icons/react'

type PromptComposerProps = {
  input: string
  isReady: boolean
  isRunning: boolean
  onAbort: () => void
  onInputChange: (value: string) => void
  onSubmit: FormEventHandler<HTMLFormElement>
}

export function PromptComposer({ input, isReady, isRunning, onAbort, onInputChange, onSubmit }: PromptComposerProps) {
  const sendLabel = isRunning ? 'Steer' : 'Send'

  return (
    <>
      {/* The form draws the field, as Kumo's InputGroup does, so the actions sit inside it. */}
      <form className="flex items-end gap-2 rounded-xl bg-kumo-control p-2 ring ring-kumo-line focus-within:ring-[1.5px] focus-within:ring-kumo-focus/50" onSubmit={onSubmit}>
        <InputArea
          id="prompt"
          aria-label="Message Pi"
          className="min-h-10 flex-1 bg-transparent px-1.5 ring-0 focus:ring-0"
          value={input}
          onValueChange={onInputChange}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder={!isReady ? 'Connecting…' : isRunning ? 'Steer Pi — it reads this after the current step' : 'Ask Pi to inspect, create, or edit files'}
          autoResize
          maxRows={10}
          disabled={!isReady}
        />
        <div className="flex gap-1.5">
          {isRunning && (
            <Button type="button" variant="secondary" shape="square" onClick={onAbort} aria-label="Stop" title="Stop" icon={<StopIcon weight="fill" />} />
          )}
          <Button type="submit" variant="primary" shape="square" disabled={!isReady || !input.trim()} aria-label={sendLabel} title={`${sendLabel} (Enter)`} icon={<ArrowUpIcon weight="bold" />} />
        </div>
      </form>
      <p className="mx-1 mt-1.5 text-center text-xs text-kumo-subtle max-md:hidden">
        <kbd className="font-medium">Enter</kbd> to send · <kbd className="font-medium">Shift</kbd>+<kbd className="font-medium">Enter</kbd> for a new line
      </p>
    </>
  )
}
