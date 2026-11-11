import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import { cn } from 'cn'

function Switch({ className, ...props }: SwitchPrimitive.Root.Props): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer group/switch ml-switch relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full bg-[var(--switch-off)] p-[3px] shadow-[inset_0_0_0_1px_var(--control)] transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 data-checked:bg-[var(--switch-on)] data-checked:shadow-none',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="ml-switch-thumb pointer-events-none block h-4 w-4 rounded-full bg-[var(--switch-thumb-off)] shadow-[var(--shadow-raise)] transition-[translate,width] duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] group-active/switch:w-5 motion-reduce:transition-none data-checked:translate-x-4 data-checked:bg-[var(--switch-thumb-on)] data-checked:group-active/switch:translate-x-3"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
