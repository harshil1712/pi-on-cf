import type { FormEventHandler } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { InputArea } from '@cloudflare/kumo/components/input'
import { ArrowUp, Square } from 'lucide-react'

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
      <form className="prompt-form" onSubmit={onSubmit}>
        <InputArea
          id="prompt"
          aria-label="Message Pi"
          value={input}
          onValueChange={onInputChange}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder={!isReady ? 'Connecting…' : isRunning ? 'Steer Pi — it reads this after the current step' : 'Ask Pi to inspect, create, or edit files'}
          rows={1}
          disabled={!isReady}
        />
        <div className="prompt-actions">
          {isRunning && (
            <Button type="button" variant="secondary" shape="square" onClick={onAbort} aria-label="Stop" title="Stop" icon={<Square size={13} fill="currentColor" />} />
          )}
          <Button type="submit" variant="primary" shape="square" disabled={!isReady || !input.trim()} aria-label={sendLabel} title={`${sendLabel} (Enter)`} icon={<ArrowUp size={16} />} />
        </div>
      </form>
      <p className="composer-hint"><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</p>
    </>
  )
}
