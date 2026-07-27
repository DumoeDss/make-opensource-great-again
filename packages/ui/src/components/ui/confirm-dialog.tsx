/**
 * ConfirmDialog - 通用确认弹窗组件 (ported from omnicross, MIT).
 *
 * 替代 window.confirm，提供符合项目风格的确认对话框。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/cn';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { Button } from './button';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'destructive' | 'default';
  onConfirm: () => void;
  /** Root testid; the ok/cancel buttons derive `${testid}-ok-btn`/`-cancel-btn`. */
  testid?: string;
  /** Explicit trigger for controlled dialogs so focus restoration is deterministic. */
  returnFocusRef?: React.RefObject<HTMLElement>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  variant = 'destructive',
  onConfirm,
  testid = 'dialog-confirm',
  returnFocusRef,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const capturedFocusRef = React.useRef<HTMLElement | null>(null);
  const okLabel = confirmLabel ?? t('ui.confirmDefault');
  const noLabel = cancelLabel ?? t('ui.cancelDefault');
  const handleConfirm = () => {
    onOpenChange(false);
    onConfirm();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm"
        hideCloseButton
        data-testid={testid}
        onOpenAutoFocus={() => {
          if (!returnFocusRef?.current && document.activeElement instanceof HTMLElement) {
            capturedFocusRef.current = document.activeElement;
          }
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current ?? capturedFocusRef.current;
          capturedFocusRef.current = null;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            data-testid={`${testid}-cancel-btn`}
          >
            {noLabel}
          </Button>
          <Button
            type="button"
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            onClick={handleConfirm}
            data-testid={`${testid}-ok-btn`}
            data-variant={variant}
            className={cn('px-4')}
          >
            {okLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
