import { FileText, Paperclip, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ACCEPT_ATTACHMENTS, MAX_FILES, addAttachments, type Attachment } from "../lib/attachments";
import { bytes } from "../lib/format";
import { Button, Modal } from "./ui";
import "../styles/attachments.css";

export function AttachmentList({ attachments, onRemove }: { attachments: Attachment[]; onRemove?: (id: string) => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = attachments.find((attachment) => attachment.id === openId);
  if (!attachments.length) return null;
  return (
    <>
      <ul className="pg-attachment-list" aria-label="Attachments">
        {attachments.map((file) => (
          <li key={file.id}>
            <button type="button" className="pg-file-preview" aria-label={`Preview ${file.name}`} onClick={() => setOpenId(file.id)}>
              {file.kind === "image"
                ? <img src={file.dataUrl} alt="" />
                : <FileText size={21} aria-hidden="true" />}
              <span className="pg-file-meta">
                <strong title={file.name}>{file.name}</strong>
                <small>{bytes(file.size)}</small>
              </span>
            </button>
            {onRemove && <button type="button" className="pg-file-remove" aria-label={`Remove ${file.name}`} onClick={() => onRemove(file.id)}>
              <X size={14} aria-hidden="true" />
            </button>}
          </li>
        ))}
      </ul>
      {open && <Modal open wide title={open.name} onClose={() => setOpenId(null)}>
        {open.kind === "image"
          ? <img className="pg-image-detail" src={open.dataUrl} alt={open.name} />
          : <pre className="pg-file-text">{open.text}</pre>}
      </Modal>}
    </>
  );
}

interface PickerProps {
  attachments: Attachment[];
  disabled?: boolean;
  onChange: (files: Attachment[]) => void;
  onReadingChange: (reading: boolean) => void;
}

export function AttachmentPicker({ attachments, disabled, onChange, onReadingChange }: PickerProps) {
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function choose(files: File[]) {
    if (!files.length || reading || disabled) return;
    setReading(true);
    onReadingChange(true);
    setError("");
    try {
      const next = await addAttachments(attachments, files);
      if (mounted.current) onChange(next);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not read the selected files.");
    } finally {
      if (mounted.current) {
        setReading(false);
        onReadingChange(false);
      }
    }
  }
  return (
    <div className="pg-attachment-picker">
      <input ref={input} type="file" multiple hidden accept={ACCEPT_ATTACHMENTS} aria-label="Attach files and images" onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        void choose(files);
      }} />
      <Button size="sm" variant="ghost" icon={<Paperclip size={15} aria-hidden="true" />}
        disabled={disabled || reading || attachments.length >= MAX_FILES} onClick={() => input.current?.click()}
        title="Attach text, code, a PDF, PNG, JPEG, or WebP">
        {reading ? "Reading files…" : "Attach files"}
      </Button>
      <AttachmentList attachments={attachments} onRemove={reading || disabled ? undefined : (id) => {
        setError("");
        onChange(attachments.filter((file) => file.id !== id));
      }} />
      {error && <p className="pg-attachment-error" role="alert">{error}</p>}
    </div>
  );
}
