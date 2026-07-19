import { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "default" | "compact";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    loading?: boolean;
}

export function Button({ className = "", variant = "secondary", size = "default", loading = false, disabled, children, ...props } : ButtonProps) {
    const classes = [ styles.button, styles[variant], size === "compact" ? styles.compact : "", loading ? styles.loading : "", className ].filter(Boolean).join(" ");
    return <button aria-busy={loading || undefined} className={classes} disabled={disabled || loading} {...props}>{children}</button>;
}
