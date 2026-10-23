"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { FileUp, Search, ShieldAlert } from "lucide-react";
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, Notice, PageHeader, Select, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { fmtDate, label } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import type { KnowledgeDoc, SearchResult } from "@/lib/types";

const STATUS_TONE = { indexed: "green", ocr_required: "amber", failed: "red", archived: "slate" } as const;

export default function KnowledgePage() {
  const { isAdmin, status } = useSession();
  const [filter, setFilter] = useState("");
  const docs = useApi<KnowledgeDoc[]>("/knowledge", []);
  const [upload, setUpload] = useState(false);
  const shown = docs.data?.filter((d) => !filter || `${d.title} ${d.tags.join(" ")} ${d.slug}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <PageHeader
        title="Knowledge base"
        description={<>Articles are chunked with source metadata and indexed for retrieval. Current backend: <span className="font-medium text-ink-2">{status?.retrieval_label}</span>.</>}
        actions={isAdmin && <Button variant="primary" icon={<FileUp className="size-4" aria-hidden />} onClick={() => setUpload(true)}>Upload document</Button>}
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Card className="overflow-hidden">
          <div className="border-b border-line p-3">
            <label className="relative block max-w-sm">
              <span className="sr-only">Filter articles</span>
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-slate-400" aria-hidden />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by title or tag" className="pl-8" />
            </label>
          </div>
          {docs.error && <ErrorState error={docs.error} onRetry={docs.reload} />}
          {!docs.data && !docs.error && <LoadingBlock rows={8} />}
          {shown?.length === 0 && <EmptyState title="No articles match" />}
          {!!shown?.length && (
            <div className="overflow-x-auto">
              <table className="min-w-full text-[13px]">
                <thead className="bg-slate-50 text-left text-xs text-muted">
                  <tr>{["Article", "Tags", "Source", "Version", "Indexing", "Chunks", "Updated"].map((h) => <th key={h} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {shown.map((d) => (
                    <tr key={d.id} className="hover:bg-slate-50/70">
                      <td className="px-3 py-2.5">
                        <Link href={`/knowledge/${d.id}`} className="font-medium text-indigo-700 hover:underline">{d.title}</Link>
                        {d.trust_flags.length > 0 && <span className="mt-0.5 flex items-center gap-1 text-[11.5px] font-medium text-red-700"><ShieldAlert className="size-3.5" aria-hidden />Contains untrusted instructions</span>}
                      </td>
                      <td className="px-3 py-2.5"><div className="flex max-w-[14rem] flex-wrap gap-1">{d.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div></td>
                      <td className="px-3 py-2.5">{d.source === "seed" ? "Seed" : "Upload"}<span className="block text-[11px] text-muted">{d.content_type}</span></td>
                      <td className="px-3 py-2.5 tabular-nums">v{d.version}</td>
                      <td className="px-3 py-2.5"><Badge tone={STATUS_TONE[d.status]}>{d.status === "ocr_required" ? "OCR required" : label(d.status)}</Badge></td>
                      <td className="px-3 py-2.5 tabular-nums">{d.chunk_count}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-muted">{fmtDate(d.updated_at, false)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <RetrievalTester />
      </div>
      {isAdmin && <UploadDialog open={upload} onClose={() => setUpload(false)} onDone={docs.reload} />}
    </>
  );
}

function RetrievalTester() {
  const { status } = useSession();
  const [query, setQuery] = useState("");
  const [res, setRes] = useState<SearchResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (e: FormEvent) => {
    e.preventDefault();
    if (query.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try { setRes(await api.post<SearchResult>("/knowledge/search", { query })); }
    catch (err) { setError(err as ApiError); }
    finally { setBusy(false); }
  };
  return (
    <Card className="h-fit">
      <CardHeader title="Test retrieval" subtitle={status?.retrieval_backend === "chroma" ? "Vector search over indexed chunks" : "Deterministic keyword retrieval (TF-IDF) — not vector search"} icon={<Search className="size-4" aria-hidden />} />
      <form onSubmit={run} className="flex gap-2 p-4">
        <label htmlFor="rq" className="sr-only">Query</label>
        <Input id="rq" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. vpn session expired" />
        <Button type="submit" variant="primary" loading={busy}>Search</Button>
      </form>
      {error && <ErrorState error={error} />}
      {res && (
        <div className="border-t border-line">
          <p className="px-4 pt-3 text-xs text-muted">Threshold {res.min_relevance}. Relevance is similarity, not a probability that the content is correct.</p>
          {res.results.length === 0 ? <EmptyState title="No chunks matched" body="The agent would ask a clarifying question or route to human review rather than invent guidance." /> : (
            <ul className="divide-y divide-line">
              {res.results.map((r) => (
                <li key={r.chunk_id} className="px-4 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/knowledge/${r.document_id}?chunk=${encodeURIComponent(r.chunk_id)}`} className="truncate text-[13px] font-medium text-indigo-700 hover:underline">{r.title}</Link>
                    <span className={r.above_threshold ? "text-xs font-medium text-ink" : "text-xs text-muted"}>{r.relevance.toFixed(3)}</span>
                  </div>
                  <p className="text-[11.5px] text-muted">{r.heading} · {r.chunk_id}</p>
                  {r.trust !== "standard" && <Badge tone="red" className="mt-1">untrusted instructions</Badge>}
                  <p className="mt-1 line-clamp-2 text-xs text-ink-2">{r.snippet}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function UploadDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KnowledgeDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("title", title);
    fd.append("tags", tags);
    if (category) fd.append("category", category);
    try {
      const doc = await api.post<KnowledgeDoc>("/knowledge/upload", fd);
      setResult(doc);
      onDone();
      if (doc.status === "indexed") toast("success", `Indexed “${doc.title}” into ${doc.chunk_count} chunks`);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const close = () => { setFile(null); setTitle(""); setTags(""); setResult(null); setError(null); onClose(); };
  return (
    <Dialog open={open} onClose={close} title="Upload knowledge document" description="Text PDFs, TXT and Markdown up to 5 MB. Scanned PDFs are marked “OCR required” (OCR is not configured)."
      footer={<><Button onClick={close}>Close</Button><Button variant="primary" loading={busy} disabled={!file || title.trim().length < 3} onClick={submit}>Upload and index</Button></>}>
      <div className="space-y-4">
        {error && <Notice tone="red" title="Upload failed">{error}</Notice>}
        {result && (
          <Notice tone={result.status === "indexed" ? "green" : result.status === "ocr_required" ? "amber" : "red"} title={result.status === "indexed" ? "Indexed" : result.status === "ocr_required" ? "OCR required" : "Not indexed"}>
            {result.status === "indexed" ? `${result.chunk_count} chunks created.` : result.status_detail}
            {result.trust_flags.length > 0 && " Instruction-like text was detected; it will be shown as untrusted and never used to change policy."}
          </Notice>
        )}
        <Field label="File" htmlFor="kb-file" required>
          <input id="kb-file" type="file" accept=".pdf,.txt,.md,.markdown" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, "")); }}
            className="block w-full text-[13px] file:mr-3 file:rounded-md file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-[13px] file:font-medium file:text-indigo-700" />
        </Field>
        <Field label="Title" htmlFor="kb-title" required><Input id="kb-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
        <Field label="Tags" htmlFor="kb-tags" hint="Comma separated"><Input id="kb-tags" value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
        <Field label="Topic" htmlFor="kb-cat" hint="Grounding a fix requires a trusted article on the fix's topic.">
          <Select id="kb-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">General</option>
            {["vpn", "wifi", "account", "email", "printer", "performance"].map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
