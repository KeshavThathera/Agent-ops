"""Optional vector backend: ChromaDB with its local ONNX embedding model.

Skipped when chromadb is not installed. The first run downloads the ~80 MB model into ~/.cache/chroma.
"""

from __future__ import annotations

import importlib.util

import pytest

from tests.conftest import NEHA, RIYA, detail, drain, login, submit

pytestmark = [pytest.mark.slow, pytest.mark.skipif(importlib.util.find_spec("chromadb") is None, reason="chromadb not installed")]


@pytest.fixture()
def chroma_client(tmp_path, monkeypatch, client):
    monkeypatch.setenv("RETRIEVAL_BACKEND", "chroma")
    from app import config, rag
    from app.db import session_scope
    from app.models import KnowledgeDocument

    config.get_settings.cache_clear()
    rag._vector_store = None
    with session_scope() as db:  # index the seeded KB into the vector store
        for doc in db.query(KnowledgeDocument).all():
            rag.index_document(db, doc, doc.content_text)
    yield client
    rag._vector_store = None


def test_vector_retrieval_ranks_relevant_article_and_drives_workflow(chroma_client):
    client = chroma_client
    login(client, NEHA)
    res = client.post("/api/knowledge/search", json={"query": "laptop will not join the wireless network"}).json()
    assert res["backend"] == "chroma"
    assert res["results"][0]["slug"] == "wifi-connectivity"
    login(client, RIYA)
    wf = submit(client, "My laptop cannot connect to the office VPN.")
    drain()
    d = detail(client, wf)
    assert d["workflow"]["status"] == "awaiting_approval"
    assert any(e["slug"] == "vpn-troubleshooting" for e in d["evidence"])


def test_vector_replace_leaves_no_stale_vectors(chroma_client):
    from app import rag

    client = chroma_client
    login(client, NEHA)
    doc = client.post("/api/knowledge/upload", data={"title": "Dock guide"},
                      files={"file": ("d.md", b"# Dock\n\nReseat the USB-C dock cable.", "text/markdown")}).json()
    before = rag.vector_store().count()
    client.post(f"/api/knowledge/{doc['id']}/replace", files={"file": ("d.txt", b"Dock v2: power-cycle the dock.", "text/plain")})
    assert rag.vector_store().count() == before  # one chunk replaced by one chunk
    hits = client.post("/api/knowledge/search", json={"query": "dock"}).json()["results"]
    assert all(h["version"] == 2 for h in hits if h["document_id"] == doc["id"])
