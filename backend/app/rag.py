"""Knowledge ingestion, chunking, prompt-injection flagging and retrieval.

Two retrieval backends:
  keyword - deterministic TF-IDF cosine similarity (default, works offline, labelled as keyword retrieval)
  chroma  - vector search in ChromaDB using its local ONNX all-MiniLM-L6-v2 embedding model

"relevance" is a similarity score between the query and a chunk. It is NOT a probability that
the content is correct, and the UI labels it that way.

Retrieved document text is untrusted data. Chunks that contain instruction-like text aimed at
the agent (e.g. "bypass approval") are flagged at ingestion. Flagged chunks are still shown as
evidence (with a warning) but are never used as grounding for a recommendation, and nothing in a
document can alter policy, which is enforced in policy.py.
"""

from __future__ import annotations

import hashlib
import io
import math
import re
import threading
from collections import Counter
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import KnowledgeChunk, KnowledgeDocument

# ------------------------------------------------------------------ extraction
SUPPORTED_EXTENSIONS = {".md": "markdown", ".markdown": "markdown", ".txt": "text", ".pdf": "pdf"}
MIN_PDF_CHARS_PER_PAGE = 40


class ExtractionError(Exception):
    def __init__(self, status: str, message: str) -> None:
        super().__init__(message)
        self.status = status  # failed | ocr_required
        self.message = message


def detect_content_type(filename: str, data: bytes) -> str:
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    ctype = SUPPORTED_EXTENSIONS.get(ext)
    if ctype is None:
        raise ExtractionError("failed", f"Unsupported file type '{ext or 'none'}'. Upload PDF, TXT or Markdown.")
    if ctype == "pdf" and not data.startswith(b"%PDF"):
        raise ExtractionError("failed", "File has a .pdf extension but is not a PDF document.")
    if ctype != "pdf" and b"\x00" in data[:4096]:
        raise ExtractionError("failed", "File appears to be binary, not text.")
    return ctype


def extract_text(ctype: str, data: bytes) -> str:
    if ctype in ("markdown", "text"):
        try:
            return data.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ExtractionError("failed", "Text file is not valid UTF-8.") from exc
    # PDF: text layer only. Scanned PDFs need OCR, which is not configured in this prototype.
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise ExtractionError("failed", "PDF is encrypted; cannot extract text.")
        pages = [(p.extract_text() or "").strip() for p in reader.pages]
    except ExtractionError:
        raise
    except (PdfReadError, Exception) as exc:  # pypdf raises a variety of errors on malformed files
        raise ExtractionError("failed", f"PDF could not be read: {type(exc).__name__}") from exc
    text = "\n\n".join(p for p in pages if p)
    if not pages or len(text) < MIN_PDF_CHARS_PER_PAGE * max(1, len(pages)) // 2:
        raise ExtractionError(
            "ocr_required",
            "OCR required: the PDF has little or no extractable text layer (likely scanned). "
            "OCR is not configured in this prototype, so nothing was indexed.",
        )
    return text


# ------------------------------------------------------------------ injection flags
INJECTION_PATTERNS = [
    r"ignore (all |any )?(previous|prior|above) (instructions|rules|policies)",
    r"bypass (the )?(approval|policy|policies|review)",
    r"(skip|disable|turn off) (the )?(approval|human review|policy|safety)",
    r"auto[- ]?approve",
    r"no approval (is )?(needed|required)",
    r"you are now",
    r"system prompt",
    r"as an ai (agent|assistant),? you (must|should)",
    r"execute_sandbox_remediation",
]
_INJECTION_RE = re.compile("|".join(INJECTION_PATTERNS), re.IGNORECASE)


def injection_flags(text: str) -> list[str]:
    return ["untrusted_instructions"] if _INJECTION_RE.search(text) else []


# ------------------------------------------------------------------ chunking
@dataclass
class ChunkDraft:
    heading: str | None
    text: str
    start: int
    end: int


def chunk_text(text: str, max_chars: int = 900) -> list[ChunkDraft]:
    """Split by markdown headings, then pack paragraphs into chunks of at most max_chars."""
    sections: list[tuple[str | None, int, str]] = []
    heading: str | None = None
    buf: list[str] = []
    buf_start = 0
    pos = 0
    for line in text.splitlines(keepends=True):
        m = re.match(r"^#{1,4}\s+(.*)", line)
        if m:
            if "".join(buf).strip():
                sections.append((heading, buf_start, "".join(buf)))
            heading = m.group(1).strip()
            buf, buf_start = [], pos + len(line)
        else:
            if not buf:
                buf_start = pos
            buf.append(line)
        pos += len(line)
    if "".join(buf).strip():
        sections.append((heading, buf_start, "".join(buf)))

    chunks: list[ChunkDraft] = []
    for head, start, body in sections:
        paras = re.split(r"\n\s*\n", body)
        cur, cur_start, offset = "", start, start
        for para in paras:
            p = para.strip()
            idx = text.find(p, offset) if p else offset
            if not p:
                continue
            if cur and len(cur) + len(p) + 2 > max_chars:
                chunks.append(ChunkDraft(head, cur, cur_start, cur_start + len(cur)))
                cur, cur_start = "", idx
            if not cur:
                cur_start = idx
            cur = f"{cur}\n\n{p}" if cur else p
            offset = idx + len(p)
        if cur:
            chunks.append(ChunkDraft(head, cur, cur_start, cur_start + len(cur)))
    return chunks


# ------------------------------------------------------------------ indexing
def index_document(db: Session, doc: KnowledgeDocument, text: str) -> None:
    """(Re)build chunks for the current version. Old chunks are removed in the same transaction."""
    db.execute(delete(KnowledgeChunk).where(KnowledgeChunk.document_id == doc.id))
    drafts = chunk_text(text)
    doc.content_text = text
    doc.content_hash = hashlib.sha256(text.encode()).hexdigest()
    doc.trust_flags = injection_flags(text)
    for i, d in enumerate(drafts):
        db.add(
            KnowledgeChunk(
                id=f"{doc.id}:v{doc.version}:c{i}",
                document_id=doc.id,
                document_version=doc.version,
                chunk_index=i,
                heading=d.heading,
                text=d.text,
                char_start=d.start,
                char_end=d.end,
                flags=injection_flags(d.text),
            )
        )
    doc.chunk_count = len(drafts)
    doc.status = "indexed"
    doc.status_detail = None
    db.flush()
    backend = get_settings().retrieval_backend
    doc.indexed_backend = "keyword"
    if backend == "chroma":
        vector_store().replace_document(doc, db)
        doc.indexed_backend = "chroma"
    keyword_index.invalidate()


def remove_from_index(db: Session, doc: KnowledgeDocument) -> None:
    db.execute(delete(KnowledgeChunk).where(KnowledgeChunk.document_id == doc.id))
    doc.chunk_count = 0
    if get_settings().retrieval_backend == "chroma":
        vector_store().delete_document(doc.id)
    keyword_index.invalidate()


# ------------------------------------------------------------------ keyword retrieval
STOPWORDS = set(
    "a an and are as at be but by can cannot could do does for from has have how i if in into is it its "
    "me my no not of on or our so than that the their them then there these they this to too up was we "
    "were what when where which while who why will with you your am been being any all get got".split()
    # Domain-generic words that appear in almost every IT complaint and carry no topic signal.
    + "laptop office computer pc device machine issue problem help please today since morning keep keeps very "
      "work works working broken anymore again still just now".split()
)
MAX_CHUNKS_PER_DOCUMENT = 2
SYNONYMS = {
    "wi": "wifi", "wireless": "wifi", "wlan": "wifi", "ssid": "wifi",
    "outlook": "email", "mail": "email", "mailbox": "email", "e": "",
    "login": "signin", "logon": "signin", "sign": "signin", "password": "password",
    "locked": "lock", "lockout": "lock", "unlock": "lock",
    "printing": "print", "printer": "print", "prints": "print",
    "slow": "slow", "sluggish": "slow", "lag": "slow", "laggy": "slow", "freezing": "slow", "hang": "slow",
    "disconnect": "connect", "disconnecting": "connect", "disconnected": "connect", "connection": "connect",
    "connecting": "connect", "connected": "connect", "connectivity": "connect",
    "synchronise": "sync", "synchronize": "sync", "syncing": "sync", "synced": "sync",
}


def tokenize(text: str) -> list[str]:
    text = text.lower().replace("wi-fi", "wifi").replace("e-mail", "email").replace("log in", "login")
    out = []
    for tok in re.findall(r"[a-z0-9]+", text):
        if tok in STOPWORDS or len(tok) < 2:
            continue
        tok = SYNONYMS.get(tok, tok)
        if not tok:
            continue
        for suf in ("ing", "ed", "es", "s"):
            if len(tok) > 5 and tok.endswith(suf):
                tok = tok[: -len(suf)]
                break
        out.append(tok)
    return out


class KeywordIndex:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._built = False
        self._idf: dict[str, float] = {}
        self._vecs: dict[str, tuple[dict[str, float], float]] = {}

    def invalidate(self) -> None:
        with self._lock:
            self._built = False

    def _build(self, db: Session) -> None:
        rows = db.execute(
            select(KnowledgeChunk, KnowledgeDocument.title)
            .join(KnowledgeDocument, KnowledgeDocument.id == KnowledgeChunk.document_id)
            .where(KnowledgeDocument.status == "indexed")
        ).all()
        docs_tokens: dict[str, Counter] = {}
        df: Counter = Counter()
        for chunk, title in rows:
            toks = Counter(tokenize(f"{title} {title} {chunk.heading or ''} {chunk.text}"))
            docs_tokens[chunk.id] = toks
            df.update(toks.keys())
        n = max(1, len(docs_tokens))
        self._idf = {t: math.log((n + 1) / (c + 0.5)) + 1 for t, c in df.items()}
        self._vecs = {}
        for cid, toks in docs_tokens.items():
            vec = {t: (1 + math.log(c)) * self._idf[t] for t, c in toks.items()}
            norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
            self._vecs[cid] = (vec, norm)
        self._built = True

    def search(self, db: Session, query: str, k: int) -> list[tuple[str, float]]:
        with self._lock:
            if not self._built:
                self._build(db)
            q = Counter(tokenize(query))
            qvec = {t: (1 + math.log(c)) * self._idf.get(t, 0.0) for t, c in q.items() if t in self._idf}
            qnorm = math.sqrt(sum(v * v for v in qvec.values())) or 1.0
            scored = []
            for cid, (vec, norm) in self._vecs.items():
                dot = sum(w * vec.get(t, 0.0) for t, w in qvec.items())
                if dot > 0:
                    scored.append((cid, dot / (qnorm * norm)))
            scored.sort(key=lambda x: x[1], reverse=True)
            return scored[:k]


keyword_index = KeywordIndex()


# ------------------------------------------------------------------ vector retrieval (ChromaDB)
class VectorStore:
    COLLECTION = "agentops_kb_chunks"

    def __init__(self) -> None:
        import chromadb
        from chromadb.utils import embedding_functions

        settings = get_settings()
        settings.chroma_dir.mkdir(parents=True, exist_ok=True)
        self._client = chromadb.PersistentClient(path=str(settings.chroma_dir))
        self._ef = embedding_functions.DefaultEmbeddingFunction()  # local ONNX all-MiniLM-L6-v2
        self._col = self._client.get_or_create_collection(
            self.COLLECTION, embedding_function=self._ef, configuration={"hnsw": {"space": "cosine"}}
        )

    def delete_document(self, document_id: str) -> None:
        self._col.delete(where={"document_id": document_id})

    def replace_document(self, doc: KnowledgeDocument, db: Session) -> None:
        self.delete_document(doc.id)
        chunks = db.scalars(select(KnowledgeChunk).where(KnowledgeChunk.document_id == doc.id)).all()
        if not chunks:
            return
        self._col.add(
            ids=[c.id for c in chunks],
            documents=[f"{doc.title}\n{c.heading or ''}\n{c.text}" for c in chunks],
            metadatas=[{"document_id": doc.id, "version": c.document_version} for c in chunks],
        )

    def count(self) -> int:
        return self._col.count()

    def search(self, query: str, k: int) -> list[tuple[str, float]]:
        if self._col.count() == 0:
            return []
        res = self._col.query(query_texts=[query], n_results=min(k, self._col.count()))
        ids = res["ids"][0]
        dists = res["distances"][0] if res.get("distances") else [1.0] * len(ids)
        return [(cid, max(0.0, 1.0 - float(d))) for cid, d in zip(ids, dists)]


_vector_store: VectorStore | None = None
_vector_lock = threading.Lock()


def vector_store() -> VectorStore:
    global _vector_store
    with _vector_lock:
        if _vector_store is None:
            _vector_store = VectorStore()
        return _vector_store


# ------------------------------------------------------------------ search API
def backend_label(backend: str) -> str:
    return {
        "keyword": "Deterministic keyword retrieval (TF-IDF cosine) — not vector search",
        "chroma": "Vector search (ChromaDB, local all-MiniLM-L6-v2 embeddings)",
    }.get(backend, backend)


def search(db: Session, query: str, top_k: int, min_relevance: float, backend: str | None = None) -> dict[str, Any]:
    backend = backend or get_settings().retrieval_backend
    raw = vector_store().search(query, top_k * 4) if backend == "chroma" else keyword_index.search(db, query, top_k * 4)
    results = []
    per_doc: dict[str, int] = {}
    for cid, score in raw:
        chunk = db.get(KnowledgeChunk, cid)
        if chunk is None:
            continue  # stale vector entry; skip rather than cite a missing chunk
        doc = db.get(KnowledgeDocument, chunk.document_id)
        if doc is None or doc.status != "indexed" or chunk.document_version != doc.version:
            continue
        if per_doc.get(doc.id, 0) >= MAX_CHUNKS_PER_DOCUMENT:
            continue  # keep evidence diverse across sources
        per_doc[doc.id] = per_doc.get(doc.id, 0) + 1
        results.append(
            {
                "chunk_id": chunk.id,
                "document_id": doc.id,
                "slug": doc.slug,
                "title": doc.title,
                "category": doc.category,
                "version": doc.version,
                "heading": chunk.heading,
                "snippet": chunk.text[:600],
                "relevance": round(score, 3),
                "above_threshold": score >= min_relevance,
                "trust": "untrusted_instructions" if chunk.flags or doc.trust_flags else "standard",
                "chunk_flagged": bool(chunk.flags),
                "source": doc.source,
            }
        )
        if len(results) >= top_k:
            break
    return {
        "query": query,
        "backend": backend,
        "backend_label": backend_label(backend),
        "min_relevance": min_relevance,
        "results": results,
    }
