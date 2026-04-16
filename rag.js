const RAG = (() => {
  let worker = null;
  let ready = false;
  let id = 0;
  const pending = {};
  let onStatus = () => {};
  let onReady = () => {};
  let onProgress = () => {};
  const cache = {};

  function initWorker() {
    if (worker) return;
    worker = new Worker(chrome.runtime.getURL("rag-worker.js"), { type: "module" });
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "model_loading") { onStatus("Loading AI model..."); return; }
      if (msg.type === "model_progress") {
        const pct = msg.total ? Math.round(msg.loaded / msg.total * 100) : 0;
        onStatus("Downloading model " + pct + "%");
        return;
      }
      if (msg.type === "model_ready") { ready = true; onStatus("RAG Ready"); onReady(true); return; }
      if (msg.type === "embed_progress") {
        const pct = Math.round(msg.done / msg.total * 100);
        onProgress(pct, msg.done, msg.total);
        return;
      }
      if (msg.type === "worker_error") { onStatus("Worker Error"); console.error(msg.error); return; }
      if (msg.id && pending[msg.id]) { pending[msg.id].resolve(msg); delete pending[msg.id]; }
    };
    worker.postMessage({ type: "init" });
  }

  function ask(payload) {
    return new Promise((resolve) => {
      const msgId = ++id;
      pending[msgId] = { resolve };
      worker.postMessage({ ...payload, id: msgId });
    });
  }

  function chunk(texts) {
    const chunks = [];
    Object.entries(texts).forEach(([page, text]) => {
      const words = text.split(/\s+/);
      for (let i = 0; i < words.length; i += 300) {
        chunks.push({ page: parseInt(page), text: words.slice(i, i + 300).join(" ") });
      }
    });
    return chunks;
  }

  return {
    init(status, readyCb, progress) {
      onStatus = status;
      onReady = readyCb;
      onProgress = progress;
      initWorker();
    },
    isReady() { return ready; },
    hasIndex(pdfKey) { return Promise.resolve(!!cache[pdfKey]); },
    getStats(pdfKey) {
      const db = cache[pdfKey];
      if (!db) return null;
      const pages = new Set(db.chunks.map(c => c.page)).size;
      return { chunks: db.chunks.length, pages };
    },
    getSourcePages(rows) {
      return [...new Set(rows.map(r => r.chunk.page))].sort((a, b) => a - b);
    },
    async indexDocument(pdfKey, pageTexts) {
      if (cache[pdfKey]) return cache[pdfKey];
      const chunks = chunk(pageTexts);
      const res = await ask({ type: "embed_chunks", chunks });
      cache[pdfKey] = { chunks, vectors: res.embeddings };
      return cache[pdfKey];
    },
    async retrieve(pdfKey, question, topK = 4) {
      const db = cache[pdfKey];
      if (!db) return [];
      const res = await ask({ type: "query", question, embeddings: db.vectors, topK });
      return res.topIndices.map((x) => ({ chunk: db.chunks[x.index], score: x.score }));
    },
    buildContext(rows) {
      return rows.map((r) => `[Page ${r.chunk.page}]\n${r.chunk.text}`).join("\n\n---\n\n");
    }
  };
})();
