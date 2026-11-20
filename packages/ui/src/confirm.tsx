// A small in-app confirmation dialog (styles live in THEME_CSS), shared by the Mac app and the extension, for actions that
// cannot be undone (cancelling a recording, deleting one). Usage:
//   const [confirmDialog, confirm] = useConfirm();
//   if (await confirm({ title, message, confirmLabel })) …;   and render {confirmDialog} once.

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { t } from "./i18n";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button; default true, since this dialog guards destructive actions. */
  danger?: boolean;
}

export function useConfirm(): [React.ReactNode, (options: ConfirmOptions) => Promise<boolean>] {
  const [request, setRequest] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  const ask = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    setRequest((previous) => {
      previous?.resolve(false);
      return { ...options, resolve };
    });
  }), []);

  useEffect(() => {
    const element = dialog.current;
    if (!request || !element) return;
    if (!element.open) element.showModal();
    // Focus the safe choice, so Enter or Space never confirms by accident.
    cancelButton.current?.focus();
  }, [request]);

  const close = (ok: boolean) => {
    request?.resolve(ok);
    setRequest(null);
    dialog.current?.close();
  };

  const node = (
    <dialog ref={dialog} className="mc-confirm" aria-labelledby={titleId} aria-describedby={request?.message ? messageId : undefined}
      onCancel={(event) => { event.preventDefault(); close(false); }}
      onClick={(event) => { if (event.target === dialog.current) close(false); }}>
      {request && <div className="mc-confirm-body">
        <h2 id={titleId}>{request.title}</h2>
        {request.message && <p id={messageId}>{request.message}</p>}
        <div className="mc-confirm-actions">
          <button ref={cancelButton} type="button" className="btn" onClick={() => close(false)}>{request.cancelLabel ?? t("Cancel")}</button>
          <button type="button" className={`btn ${request.danger === false ? "btn-primary" : "btn-destructive"}`} onClick={() => close(true)}>{request.confirmLabel}</button>
        </div>
      </div>}
    </dialog>
  );
  return [node, ask];
}

