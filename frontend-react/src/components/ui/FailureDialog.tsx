import { useId } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/primitives/Button";
import { useModalDialog } from "./useModalDialog";
import styles from "./FailureDialog.module.css";

export interface FailureDialogDetail {
    label: string;
    value: string;
}

interface FailureDialogProps {
    open: boolean;
    title: string;
    description: string;
    message: string;
    details?: FailureDialogDetail[];
    onClose: () => void;
    actionLabel?: string;
    actionLoading?: boolean;
    onAction?: () => void;
}

export function FailureDialog({ open, title, description, message, details = [], onClose, actionLabel, actionLoading, onAction } : FailureDialogProps) {
    const dialogRef = useModalDialog(open);
    const titleId = useId();
    const descriptionId = useId();

    return (
        <dialog
            aria-describedby={descriptionId}
            aria-labelledby={titleId}
            className={styles.dialog}
            onCancel={event => {
                event.preventDefault();
                onClose();
            }}
            onClick={event => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
            ref={dialogRef}
        >
            <div className={styles.content}>
                <div className={styles.heading}>
                    <span className={styles.icon}><Icon name="alert" size={22} /></span>
                    <div><h2 id={titleId}>{title}</h2><p id={descriptionId}>{description}</p></div>
                </div>
                {details.length > 0 && <dl className={styles.details}>{details.map(detail => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}</dl>}
                <div className={styles.message} role="alert"><span>错误结果</span><pre>{message}</pre></div>
                <div className={styles.actions}>{actionLabel && onAction && <Button loading={actionLoading} onClick={onAction}>{actionLabel}</Button>}<Button autoFocus variant="primary" onClick={onClose}>关闭</Button></div>
            </div>
        </dialog>
    );
}
