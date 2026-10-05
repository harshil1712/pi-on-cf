import type { FormEventHandler } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { InputArea } from '@cloudflare/kumo/components/input'

type PromptComposerProps = {
  input: string
  isReady: boolean
  isRunning: boolean
  onAbort: () => void
  onInputChange: (value: string) => void
  onSubmit: FormEventHandler<HTMLFormElement>
}

export function PromptComposer({ input, isReady, isRunning, onAbort, onInputChange, onSubmit }: PromptComposerProps) {
  return (
    <form className="prompt-form" onSubmit={onSubmit}>
      <label htmlFor="prompt">INSTRUCTION</label>
      <InputArea
        id="prompt"
        aria-label="INSTRUCTION"
        value={input}
        onValueChange={onInputChange}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
        placeholder={isRunning ? 'Steer Pi. It reads this after the current tool round...' : 'Ask Pi to inspect, create, or edit a file...'}
        rows={3}
        disabled={!isReady}
      />
      <div className="prompt-actions">
        <Button className="execute-button" type="submit" disabled={!isReady || !input.trim()}>
          {isRunning ? 'STEER' : isReady ? 'EXECUTE' : 'LOADING'}
          <span className="execute-arrow">↗</span>
        </Button>
        {isRunning && <Button className="execute-button abort-button" type="button" onClick={onAbort}>ABORT</Button>}
      </div>
    </form>
  )
}
