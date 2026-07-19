import { useEffect, useRef } from "react";

export function useModalDialog(open = true) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) {
            return;
        }

        const restoreFocus = () => {
            const target = returnFocusRef.current;
            returnFocusRef.current = null;
            if (target?.isConnected) {
                window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
            }
        };

        if (open && !dialog.open) {
            returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            dialog.showModal();
        } else if (!open && dialog.open) {
            dialog.close();
            restoreFocus();
        }

        return () => {
            if (dialog.open) {
                dialog.close();
            }
            if (open) {
                restoreFocus();
            }
        };
    }, [ open ]);

    return dialogRef;
}
