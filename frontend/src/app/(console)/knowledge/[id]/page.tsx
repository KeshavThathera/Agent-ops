"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { ArrowLeft, Archive, Download, FileUp, RefreshCw, ShieldAlert } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { Badge, Button, Card, CardHeader, cx, Dialog, ErrorState, Field, LoadingBlock, Notice, Tabs, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { fmtDate, label } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import type { Chunk, KnowledgeDoc } from "@/lib/types";

interface DocDetail { document: KnowledgeDoc; content: string; chunks: Chunk[] }

export default function KnowledgeDocPage() {
  return <Suspense fallback={<Card><LoadingBlock /></Card>}><DocView /></Suspense>;
}

function DocView() {
  const { id } = useParams<{ id: string }>();
  const target = useSearchParams().get("chunk");
  const { isAdmin, isStaff } = useSession();
  const toast = useToast();
  const data = useApi<DocDetail>(`/knowledge/${id}`, [id]);
  const [tab, setTab] = useState<"preview" | "chunks">(target ? "chunks" : "preview");
  const [busy, setBusy] = useState<string | null>(null);
  const [replace, setReplace] = useState(false);
  const targetRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (target && data.data) targetRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [target, data.data, tab]);

  if (data.error && !data.data) return <Card><ErrorState error={data.error} onRetry={data.reload} /></Card>;
  if (!data.data) return <Card><LoadingBlock rows={8} /></Card>;
  const { document: d, content, chunks } = data.data;
  const targetChunk = chunks.find((c) => c.id === target);
  const staleTarget = target && !targetChunk;

  const act = async (action: "reindex" | "archive") => {
    setBusy(action);
    try {
      await api.post(`/knowledge/${d.id}/${action}`);
      toast("success", action === "reindex" ? "Reindexed; old chunks were replaced in the same transaction" : "Archived and removed from the index");
      void data.reload();
    } catch (e) { toast("error", (e as ApiError).message); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      <Link href="/knowledge" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-4" aria-hidden />Knowledge base</Link>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">{d.title}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
              <Badge tone={d.status === "indexed" ? "green" : d.status === "archived" ? "slate" : "amber"}>{d.status === "ocr_required" ? "OCR required" : label(d.status)}</Badge>
              <span>v{d.version}</span><span>·</span><span>{d.source === "seed" ? "Seed article" : `Uploaded (${d.filename})`}</span><span>·</span>
              <span>{d.chunk_count} chunks</span><span>·</span><span>indexed with {d.indexed_backend ?? "—"}</span><span>·</span><span>updated {fmtDate(d.updated_at)}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">{d.tags.map((t) => <Badge key={t}>{t}</Badge>)}{d.category && <Badge tone="indigo">topic: {label(d.category)}</Badge>}</div>
          </div>
          {isAdmin && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<FileUp className="size-4" aria-hidden />} onClick={() => setReplace(true)}>Replace</Button>
              <Button size="sm" icon={<RefreshCw className="size-4" aria-hidden />} loading={busy === "reindex"} onClick={() => act("reindex")} disabled={d.status === "archived" || !content}>Reindex</Button>
              <Button size="sm" variant="ghost" icon={<Archive className="size-4" aria-hidden />} loading={busy === "archive"} onClick={() => act("archive")} disabled={d.status === "archived"}>Archive</Button>
              {isStaff && d.source === "upload" && <a href={`/api/knowledge/${d.id}/file`}><Button size="sm" variant="ghost" icon={<Download className="size-4" aria-hidden />}>Original</Button></a>}
            </div>
          )}
        </div>
        {d.trust_flags.length > 0 && (
          <div className="border-t border-line px-5 py-3">
            <Notice tone="red" title="Untrusted instructions detected" icon={<ShieldAlert className="size-4" aria-hidden />}>
              This document contains text that tries to instruct the agent (for example to skip approval). It is treated as untrusted data:
              it is shown as evidence with a warning, excluded from grounding recommendations, and cannot change policy, which the server enforces independently.
            </Notice>
          </div>
        )}
        {d.status_detail && <div className="border-t border-line px-5 py-3"><Notice tone="amber">{d.status_detail}</Notice></div>}
      </Card>
      {staleTarget && <Notice tone="amber">The cited chunk <span className="font-mono">{target}</span> belongs to an older version of this document. Showing the current version.</Notice>}

      <Tabs label="Document views" value={tab} onChange={setTab} tabs={[{ id: "preview", label: "Preview" }, { id: "chunks", label: "Chunks", count: chunks.length }]} />
      {tab === "preview" && (
        <Card><div className="px-5 py-4">
          {content ? <Markdown source={content} highlight={(raw) => !!targetChunk && targetChunk.text.includes(raw.slice(0, 60))} /> : <p className="text-sm text-muted">No extracted text.</p>}
        </div></Card>
      )}
      {tab === "chunks" && (
        <Card>
          <CardHeader title="Indexed chunks" subtitle="Chunk IDs encode document, version and position: <doc>:v<version>:c<index>" />
          <ol className="divide-y divide-line">
            {chunks.map((c) => (
              <li key={c.id} id={c.id} ref={c.id === target ? targetRef : undefined} className={cx("px-5 py-3", c.id === target && "bg-amber-50 ring-2 ring-inset ring-amber-300")}>
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span className="font-mono">{c.id}</span><span>· {c.heading ?? "(no heading)"}</span><span>· chars {c.char_start}–{c.char_end}</span>
                  {c.id === target && <Badge tone="amber">cited excerpt</Badge>}
                  {c.flags.length > 0 && <Badge tone="red">untrusted instructions</Badge>}
                </p>
                <p className="mt-1.5 whitespace-pre-line text-[13px] leading-relaxed text-ink-2">{c.text}</p>
              </li>
            ))}
          </ol>
        </Card>
      )}
      {isAdmin && <ReplaceDialog open={replace} doc={d} onClose={() => setReplace(false)} onDone={data.reload} />}
    </div>
  );
}

function ReplaceDialog({ open, doc, onClose, onDone }: { open: boolean; doc: KnowledgeDoc; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api.post<KnowledgeDoc>(`/knowledge/${doc.id}/replace`, fd);
      toast(r.status === "indexed" ? "success" : "error", r.status === "indexed" ? `Replaced with v${r.version}; previous chunks removed` : r.status_detail ?? "Not indexed");
      onDone();
      onClose();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Replace “${doc.title}”`} description={`Creates version v${doc.version + 1}. Chunks from older versions are deleted in the same transaction, so no stale duplicates remain.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!file} onClick={submit}>Replace</Button></>}>
      {error && <div className="mb-3"><Notice tone="red">{error}</Notice></div>}
      <Field label="New file" htmlFor="rep-file">
        <input id="rep-file" type="file" accept=".pdf,.txt,.md,.markdown" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-[13px]" />
      </Field>
    </Dialog>
  );
}
