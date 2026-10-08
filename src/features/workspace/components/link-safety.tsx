import { useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Dialog } from '@cloudflare/kumo/components/dialog'
import { ArrowSquareOutIcon, CheckIcon, CopyIcon } from '@phosphor-icons/react'
import type { LinkSafetyConfig, LinkSafetyModalProps } from 'streamdown'

/**
 * GitHub links open at once: repositories, branches and the pull requests
 * Pi opens are the links its answers carry most.
 */
const TRUSTED = /^https:\/\/github\.com\//

/** Streamdown's link check, with its confirmation drawn in Kumo for every other link. */
export const LINK_SAFETY: LinkSafetyConfig = {
  enabled: true,
  onLinkCheck: (url) => TRUSTED.test(url),
  renderModal: (props) => <LinkSafetyDialog {...props} />,
}

function LinkSafetyDialog({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
  const [copied, setCopied] = useState(false)
  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog size="base" className="flex flex-col gap-3 p-6">
        <Dialog.Title className="text-lg font-semibold">Open external link?</Dialog.Title>
        <Dialog.Description className="text-kumo-subtle">Pi wrote this link. Check where it goes before you open it.</Dialog.Description>
        <code className="rounded-md bg-kumo-recessed px-3 py-2 font-mono text-xs break-all">{url}</code>
        <div className="mt-3 flex justify-end gap-2">
          <Button
            variant="secondary"
            icon={copied ? CheckIcon : CopyIcon}
            onClick={() => {
              void navigator.clipboard.writeText(url).then(() => setCopied(true))
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          <Button variant="primary" icon={ArrowSquareOutIcon} onClick={() => { onConfirm(); onClose() }}>Open link</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
