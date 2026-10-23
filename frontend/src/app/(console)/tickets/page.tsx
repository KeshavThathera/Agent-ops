"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { Badge, Card, cx, EmptyState, ErrorState, Input, LoadingBlock, PageHeader, Pagination, Select, StatusBadge } from "@/components/ui";
import { qs } from "@/lib/api";
import { fmtDate, label, PRIORITY_TONE, TICKET_STATUS, WORKFLOW_STATUS } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import type { Page, Ticket, User } from "@/lib/types";

const COLUMNS: Array<{ key: string; label: string; sort?: string }> = [
  { key: "id", label: "Ticket", sort: "number" },
  { key: "title", label: "Title", sort: "title" },
  { key: "category", label: "Category" },
  { key: "priority", label: "Priority", sort: "priority" },
  { key: "status", label: "Ticket status", sort: "status" },
  { key: "workflow", label: "Workflow status" },
  { key: "requester", label: "Requester" },
  { key: "assignee", label: "Assignee" },
  { key: "created", label: "Created", sort: "created_at" },
  { key: "updated", label: "Updated", sort: "updated_at" },
];

export default function TicketsPage() {
  const { isStaff, user } = useSession();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("");
  const [assignee, setAssignee] = useState("");
  const [origin, setOrigin] = useState("");
  const [sort, setSort] = useState("created_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  useEffect(() => { const t = setTimeout(() => { setQuery(q); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const path = `/tickets${qs({ q: query, status, category, priority, assignee_id: assignee, origin, sort, order, page, page_size: 15 })}`;
  const data = useApi<Page<Ticket>>(path, [path]);
  const engineers = useApi<User[]>(isStaff ? "/users" : null, [isStaff]);

  const sortBy = (s?: string) => {
    if (!s) return;
    if (sort === s) setOrder(order === "asc" ? "desc" : "asc");
    else { setSort(s); setOrder(s === "title" ? "asc" : "desc"); }
  };
  const filter = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLSelectElement>) => { setter(e.target.value); setPage(1); };

  return (
    <>
      <PageHeader
        title={isStaff ? "Tickets" : "My tickets"}
        description="Ticket status is the support record seen by the requester. Workflow status is the automation's execution state. They are tracked separately."
      />
      <Card className="overflow-hidden">
        <div className="grid gap-2 border-b border-line p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(5,minmax(0,1fr))]">
          <label className="relative block">
            <span className="sr-only">Search tickets</span>
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-slate-400" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, description or TKT-number" className="pl-8" />
          </label>
          <Select aria-label="Filter by status" value={status} onChange={filter(setStatus)}>
            <option value="">All statuses</option>
            {Object.entries(TICKET_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
          <Select aria-label="Filter by category" value={category} onChange={filter(setCategory)}>
            <option value="">All categories</option>
            {["vpn", "wifi", "account", "email", "printer", "performance", "unclassified", "security_policy", "other"].map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </Select>
          <Select aria-label="Filter by priority" value={priority} onChange={filter(setPriority)}>
            <option value="">All priorities</option>
            {["critical", "high", "medium", "low"].map((p) => <option key={p} value={p}>{label(p)}</option>)}
          </Select>
          {isStaff ? (
            <Select aria-label="Filter by assignee" value={assignee} onChange={filter(setAssignee)}>
              <option value="">Any assignee</option>
              <option value="unassigned">Unassigned</option>
              {user && <option value={user.id}>Assigned to me</option>}
              {engineers.data?.filter((u) => u.role !== "employee" && u.id !== user?.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          ) : <div className="hidden lg:block" />}
          <Select aria-label="Filter by data source" value={origin} onChange={filter(setOrigin)}>
            <option value="">All sources</option><option value="live">Live runs</option><option value="seed">Seeded demo</option><option value="eval">Evaluation</option>
          </Select>
        </div>

        {data.error && <ErrorState error={data.error} onRetry={data.reload} />}
        {!data.data && !data.error && <LoadingBlock rows={6} />}
        {data.data && data.data.items.length === 0 && <EmptyState title="No tickets match" body="Adjust the filters, or submit a support request." />}
        {data.data && data.data.items.length > 0 && (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="min-w-full text-[13px]">
                <thead className="bg-slate-50 text-left text-xs text-muted">
                  <tr>
                    {COLUMNS.filter((c) => isStaff || c.key !== "assignee").map((c) => (
                      <th key={c.key} scope="col" className="whitespace-nowrap px-3 py-2 font-medium" aria-sort={c.sort && sort === c.sort ? (order === "asc" ? "ascending" : "descending") : undefined}>
                        {c.sort ? (
                          <button type="button" onClick={() => sortBy(c.sort)} className="inline-flex items-center gap-1 hover:text-ink">
                            {c.label}
                            {sort === c.sort && (order === "asc" ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />)}
                          </button>
                        ) : c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.data.items.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-50/70">
                      <td className="whitespace-nowrap px-3 py-2.5"><Link href={`/tickets/${t.id}`} className="font-medium text-indigo-700 hover:underline">{t.display_id}</Link></td>
                      <td className="max-w-[18rem] px-3 py-2.5"><Link href={`/tickets/${t.id}`} className="line-clamp-1 text-ink hover:underline">{t.title}</Link>{t.origin !== "live" && <span className="text-[11px] text-muted">{t.origin === "seed" ? "seed data" : "evaluation"}</span>}</td>
                      <td className="whitespace-nowrap px-3 py-2.5">{label(t.category)}</td>
                      <td className="px-3 py-2.5"><Badge tone={PRIORITY_TONE[t.priority]}>{t.priority}</Badge></td>
                      <td className="px-3 py-2.5"><StatusBadge meta={TICKET_STATUS} value={t.status} /></td>
                      <td className="px-3 py-2.5"><StatusBadge meta={WORKFLOW_STATUS} value={t.workflow_status} live={false} /></td>
                      <td className="whitespace-nowrap px-3 py-2.5">{t.requester?.name}</td>
                      {isStaff && <td className="whitespace-nowrap px-3 py-2.5">{t.assignee?.name ?? <span className="text-muted">Unassigned</span>}</td>}
                      <td className="whitespace-nowrap px-3 py-2.5 text-muted">{fmtDate(t.created_at)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-muted">{fmtDate(t.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-line md:hidden">
              {data.data.items.map((t) => (
                <li key={t.id}>
                  <Link href={`/tickets/${t.id}`} className="block px-4 py-3 hover:bg-slate-50">
                    <p className="flex items-center justify-between gap-2 text-[13px]"><span className="font-medium text-indigo-700">{t.display_id}</span><span className="text-xs text-muted">{fmtDate(t.created_at)}</span></p>
                    <p className={cx("mt-0.5 text-[13.5px] font-medium text-ink")}>{t.title}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <StatusBadge meta={TICKET_STATUS} value={t.status} />
                      <Badge tone={PRIORITY_TONE[t.priority]}>{t.priority}</Badge>
                      <Badge tone="slate">{label(t.category)}</Badge>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            <Pagination page={page} pageSize={15} total={data.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
