import { useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Dialog } from '@cloudflare/kumo/components/dialog'
import { Input } from '@cloudflare/kumo/components/input'

type RenameSessionDialogProps = {
  /** The current name; the field starts with it each time the dialog opens. */
  name: string | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Receives the trimmed name, or `undefined` to clear it. */
  onRename: (name: string | undefined) => void
}

export function RenameSessionDialog({ name, open, onOpenChange, onRename }: RenameSessionDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="base" className="p-6">
        {/* Mounted per opening, so the field resets to the current name; the dialog focuses it first. */}
        <RenameForm
          name={name}
          onCancel={() => onOpenChange(false)}
          onSubmit={(next) => {
            onOpenChange(false)
            onRename(next)
          }}
        />
      </Dialog>
    </Dialog.Root>
  )
}

function RenameForm({ name, onCancel, onSubmit }: { name: string | undefined; onCancel: () => void; onSubmit: (name: string | undefined) => void }) {
  const [value, setValue] = useState(name ?? '')
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(value.trim() || undefined)
      }}
    >
      <Dialog.Title className="text-lg font-semibold">Rename session</Dialog.Title>
      <Input label="Name" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Untitled" maxLength={120} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary">Save</Button>
      </div>
    </form>
  )
}

type DeleteSessionDialogProps = {
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDelete: () => void
}

export function DeleteSessionDialog({ name, open, onOpenChange, onDelete }: DeleteSessionDialogProps) {
  return (
    <Dialog.Root role="alertdialog" open={open} onOpenChange={onOpenChange}>
      <Dialog size="base" className="flex flex-col gap-3 p-6">
        <Dialog.Title className="text-lg font-semibold">Delete session?</Dialog.Title>
        <Dialog.Description className="text-kumo-subtle">
          {name} and its workspace files will be deleted. This cannot be undone.
        </Dialog.Description>
        <div className="mt-3 flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} variant="secondary">Cancel</Button>} />
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false)
              onDelete()
            }}
          >
            Delete
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
