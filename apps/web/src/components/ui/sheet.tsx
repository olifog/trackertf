import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";

import { cn } from "#/lib/utils";

/**
 * Side-anchored drawer built on the same Base UI Dialog primitive as
 * `dialog.tsx`. Used for the mobile nav; slides in from a screen edge instead
 * of the centered popup.
 */
function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/40 duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = "left",
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "left" | "right";
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 z-50 flex h-full w-72 max-w-[80vw] flex-col gap-4 bg-popover p-4 text-popover-foreground ring-1 ring-foreground/10 duration-200 outline-none data-open:animate-in data-closed:animate-out",
          side === "left"
            ? "left-0 border-r data-open:slide-in-from-left data-closed:slide-out-to-left"
            : "right-0 border-l data-open:slide-in-from-right data-closed:slide-out-to-right",
          className,
        )}
        {...props}
      >
        {children}
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

export { Sheet, SheetClose, SheetContent, SheetOverlay, SheetPortal, SheetTrigger };
