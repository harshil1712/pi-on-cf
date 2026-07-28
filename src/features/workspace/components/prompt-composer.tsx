import type { FormEventHandler } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { InputArea } from '@cloudflare/kumo/components/input'

type PromptComposerProps = {
  input: string
  isReady: boolean
  isResetting: boolean
  isRunning: boolean
  onAbort: () => void
  onInputChange: (value: string) => void
  onSubmit: FormEventHandler<HTMLFormElement>
}

export function PromptComposer({ input, isReady, isResetting, isRunning, onAbort, onInputChange, onSubmit }: PromptComposerProps) {
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
        placeholder="Ask Pi to inspect, create, or edit a file..."
        rows={3}
        disabled={isRunning || isResetting || !isReady}
      />
      <Button className="execute-button" type={isRunning ? 'button' : 'submit'} onClick={isRunning ? onAbort : undefined} disabled={!isRunning && (isResetting || !isReady || !input.trim())}>
        {isRunning ? 'ABORT' : isReady ? 'EXECUTE' : 'LOADING'}
        <span className="execute-arrow">↗</span>
      </Button>
    </form>
  )
}
