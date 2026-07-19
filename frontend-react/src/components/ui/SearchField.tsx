import { InputHTMLAttributes } from "react";
import { Icon } from "@/components/Icon";
import styles from "./SearchField.module.css";

export function SearchField({ label, ...props } : InputHTMLAttributes<HTMLInputElement> & { label: string }) {
    return <label className={styles.field}><Icon name="search" size={15} /><span className="sr-only">{label}</span><input {...props} /></label>;
}
