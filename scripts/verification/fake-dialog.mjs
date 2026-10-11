/**
 * A stand-in for the shadcn dialog primitive, and ONLY for its portal.
 *
 * Base UI renders a modal through `DialogPrimitive.Portal`, which produces
 * nothing at all under `renderToStaticMarkup` — the real dialog server-renders
 * to an empty string. Stubbing these five wrappers as plain elements lets the
 * REAL `AwardPrizeDialog` be rendered with real props, so its warning, its
 * chooser and its buttons are genuinely on screen rather than grepped.
 *
 * It replaces the PORTAL, never any product logic: everything inside the
 * dialog is the component's own code.
 */
import { createElement } from 'react'

const passthrough = (slot) => {
  const Component = ({ children }) =>
    createElement('div', { 'data-slot': slot }, children)

  Component.displayName = slot

  return Component
}

export const Dialog = ({ children }) =>
  createElement('div', { 'data-slot': 'dialog' }, children)
export const DialogContent = passthrough('dialog-content')
export const DialogHeader = passthrough('dialog-header')
export const DialogTitle = passthrough('dialog-title')
export const DialogDescription = passthrough('dialog-description')
export const DialogClose = passthrough('dialog-close')
export const DialogTrigger = passthrough('dialog-trigger')
export const DialogFooter = passthrough('dialog-footer')
