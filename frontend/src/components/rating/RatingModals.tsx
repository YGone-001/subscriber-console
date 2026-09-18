"use client";
import React from "react";
import { ConfirmActionPanel, OperationNotice } from "@/components/OperationFeedback";

export function RatingModals(props: any) {
  const {
    t, notice, setNotice, pendingDeleteId, setPendingDeleteId, executeDelete, savingKey
  } = props;

  return (
    <>
      {notice && (
        <OperationNotice
          presentation="modal"
          tone={notice.type === "error" ? "danger" : "success"}
          title={notice.type === "error" ? t("error") : t("success")}
          message={notice.text}
          onClose={() => setNotice(null)}
        />
      )}
      {pendingDeleteId != null && (
        <ConfirmActionPanel
          presentation="modal"
          title={t("rating_del_confirm", { id: pendingDeleteId })}
          message={t("rating_del_desc")}
          confirmLabel={t("delete")}
          cancelLabel={t("cancel")}
          isWorking={savingKey === `delete:${pendingDeleteId}`}
          onConfirm={executeDelete}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}
    </>
  );
}
