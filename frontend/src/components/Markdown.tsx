import type { ReactNode } from "react";

/**
 * Minimal Markdown renderer for knowledge-base articles. It builds React elements directly and never
 * uses dangerouslySetInnerHTML, so document content cannot inject markup or scripts. Supports headings,
 * paragraphs, ordered/unordered lists, simple tables, **bold** and `code`.
 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith("**")
      ? <strong key={i++}>{tok.slice(2, -2)}</strong>
      : <code key={i++} className="rounded bg-slate-100 px-1 font-mono text-[12px]">{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source, highlight }: { source: string; highlight?: (block: string) => boolean }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const mark = (raw: string) => (highlight?.(raw) ? "bg-amber-50 ring-1 ring-amber-200 rounded-md -mx-2 px-2" : "");
  while (i < lines.length) {
    const line = lines[i];
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (!line.trim()) { i++; continue; }
    if (h) {
      const level = h[1].length;
      const cls = level === 1 ? "text-lg font-semibold mt-1" : level === 2 ? "text-[15px] font-semibold mt-5" : "text-sm font-semibold mt-4";
      blocks.push(level === 1 ? <h2 key={key++} className={cls}>{inline(h[2])}</h2> : <h3 key={key++} className={cls}>{inline(h[2])}</h3>);
      i++;
      continue;
    }
    if (/^\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        if (!/^\|[\s:-]+\|/.test(lines[i]) || /[a-z]/i.test(lines[i])) rows.push(lines[i].split("|").slice(1, -1).map((c) => c.trim()));
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div key={key++} className="my-3 overflow-x-auto">
          <table className="min-w-full text-[13px]">
            <thead><tr>{head.map((c, j) => <th key={j} className="border-b border-line px-2 py-1.5 text-left font-semibold">{inline(c)}</th>)}</tr></thead>
            <tbody>{body.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j} className="border-b border-line/60 px-2 py-1.5">{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      const raw = items.join("\n");
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key++} className={`my-2 space-y-1 pl-5 text-[13.5px] leading-relaxed ${ordered ? "list-decimal" : "list-disc"} ${mark(raw)}`}>
          {items.map((it, j) => <li key={j}>{inline(it)}</li>)}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\||\s*([-*]|\d+\.)\s)/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    const raw = para.join(" ");
    blocks.push(<p key={key++} className={`my-2 text-[13.5px] leading-relaxed text-ink-2 ${mark(raw)}`}>{inline(raw)}</p>);
  }
  return <div className="max-w-none">{blocks}</div>;
}
