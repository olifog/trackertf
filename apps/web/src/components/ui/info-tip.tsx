import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { InfoIcon } from "lucide-react";

import { cn } from "#/lib/utils";

/**
 * Small inline `ⓘ` trigger that reveals a short explanation on hover/focus.
 * Built on the Base UI Tooltip primitive so it shares the mauve/amber dark
 * theme popover tokens with `dialog.tsx` / `sheet.tsx`. Accessible: the trigger
 * is a real focusable button and the popup is announced by screen readers.
 *
 * Usage: `<InfoTip text="Short explanation." />` or `<InfoTip>Short text</InfoTip>`.
 */
function InfoTip({
  text,
  children,
  className,
  side = "top",
  ...props
}: Omit<TooltipPrimitive.Trigger.Props, "children"> & {
  text?: React.ReactNode;
  children?: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const content = text ?? children;
  return (
    <TooltipPrimitive.Provider delay={150} closeDelay={0}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger
          data-slot="info-tip-trigger"
          className={cn(
            "inline-flex size-3.5 shrink-0 cursor-help items-center justify-center align-middle text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:rounded-sm",
            className,
          )}
          {...props}
        >
          <InfoIcon className="size-3.5" />
          <span className="sr-only">More info</span>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Positioner side={side} sideOffset={6}>
            <TooltipPrimitive.Popup
              data-slot="info-tip"
              className={cn(
                "z-50 max-w-64 rounded-lg bg-popover px-2.5 py-1.5 text-xs leading-snug text-popover-foreground ring-1 ring-foreground/10 shadow-md duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              )}
            >
              {content}
            </TooltipPrimitive.Popup>
          </TooltipPrimitive.Positioner>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export { InfoTip };
