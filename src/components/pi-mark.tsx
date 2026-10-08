import { cn } from '@cloudflare/kumo/utils'

/** The π mark, the one place the brand orange appears. */
export function PiMark({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center bg-pi-brand leading-none font-bold text-white',
        size === 'sm' ? 'size-6 rounded-md text-[15px]' : 'size-11 rounded-xl text-[26px]',
      )}
    >
      π
    </span>
  )
}
