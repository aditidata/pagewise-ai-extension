// ═══════════════════════════════════════════════════════════════
// PageWise AI — RAG Engine (rag.js)
// Main-thread coordinator for the RAG pipeline.
//
// Pipeline:
//  PDF text  →  chunk()  →  Web Worker embeds  →  IndexedDB store
//  Query     →  Web Worker embeds  →  cosine search  →  top-K chunks
//  top-K chunks  →  LLM (Groq/Ollama)  →  grounded answer
//
// IndexedDB schema:
//  DB: pagewise_rag
//  Store: embeddings  { key: pdfKey, chunks: [], vectors: [] }
// ═══════════════════════════════════════════════════════════════

const RAG = (() => {

  // ── Constants ───────────────────────────────────────────────
  const CHUNK_SIZE    = 400;   // words per chunk
  const CHUNK_OVERLAP = 80;    // word overlap between chunks
  const TOP_K         = 4;     // chunks retrieved per query
  const DB_NAME       = "pagewise_rag";
  const DB_VERSION    = 1;
  const STORE_NAME    = "embeddings";

  // ── State ────────────────────────────────────────────────────
  let worker      = null;
  let workerReady = false;
  let msgId       = 0;
  const pending   = {};  // msgId → { resolve, reject }

  // In-memory cache: pdfKey → { chunks, vectors }
  const memCache  = {};

  // ── Status callbacks (set by viewer.js) ──────────────────────
  let onStatus    = () => {};
  let onReady     = () => {};
  let onProgress  = () => {};

  // ── Init worker ──────────────────────────────────────────────
  function initWorker() {
    if (worker) return;
    worker = new Worker(chrome.runtime.getURL("rag-worker.js"));
    worker.onmessage = (e) => {
      const msg = e.data;

      if (msg.type === "model_loading") {
        onStatus("🧠 Loading embedding model...");
        return;
      }
      if (msg.type === "model_progress") {
        const pct = msg.total ? Math.round((msg.loaded / msg.total) * 100) : "?";
        onStatus(`📥 Downloading model: ${pct}%`);
        return;
      }
      if (msg.type === "model_ready") {
        workerReady = true;
        onStatus("✅ RAG engine ready");
        onReady();
        return;
      }
      if (msg.type === "model_error") {
        onStatus("❌ RAG model failed to load");
        return;
      }
      if (msg.type === "embed_progress") {
        const pct = Math.round((msg.done / msg.total) * 100);
        onProgress(pct, msg.done, msg.total);
        onStatus(`⚙️ Indexing PDF... ${pct}% (${msg.done}/${msg.total} chunks)`);
        return;
      }

      // Resolve pending promise
      if (msg.id !== undefined && pending[msg.id]) {
        pending[msg.id].resolve(msg);
        delete pending[msg.id];
      }
    };

    worker.onerror = (err) => {
      console.error("RAG worker error:", err);
      onStatus("❌ RAG worker error");
    };

    // Kick off model load immediately
    worker.postMessage({ type: "init" });
  }

  // ── Send message to worker, get promise ──────────────────────
  function sendToWorker(msg) {
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      pending[id] = { resolve, reject };
      worker.postMessage({ ...msg, id });
    });
  }

  // ── IndexedDB helpers ────────────────────────────────────────
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "pdfKey" });
        }
      };
      req.onsuccess  = (e) => resolve(e.target.result);
      req.onerror    = (e) => reject(e.target.error);
    });
  }

  async function dbSave(pdfKey, chunks, vectors) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put({ pdfKey, chunks, vectors, indexedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror    = (e) => reject(e.target.error);
    });
  }

  async function dbLoad(pdfKey) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req   = store.get(pdfKey);
      req.onsuccess = (e) => resolve(e.target.result || null);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  async function dbDelete(pdfKey) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.delete(pdfKey);
      tx.oncomplete = resolve;
      tx.onerror    = (e) => reject(e.target.error);
    });
  }

  // ── Text chunking ────────────────────────────────────────────
  // Splits all page texts into overlapping word-window chunks.
  // Each chunk remembers its source page number.
  function chunkDocument(pageTexts) {
    // pageTexts: { [pageNum]: "text..." }
    const chunks = [];

    Object.entries(pageTexts).forEach(([pageNum, text]) => {
      if (!text || text.trim().length < 30) return;
      const words = text.trim().split(/\s+/);
      let start   = 0;

      while (start < words.length) {
        const end    = Math.min(start + CHUNK_SIZE, words.length);
        const slice  = words.slice(start, end).join(" ");
        chunks.push({
          text:       slice,
          page:       parseInt(pageNum),
          chunkIndex: chunks.length,
          wordStart:  start,
          wordEnd:    end
        });
        if (end === words.length) break;
        start += CHUNK_SIZE - CHUNK_OVERLAP;
      }
    });

    return chunks;
  }

  // ── Public API ───────────────────────────────────────────────
  return {

    // Call once from viewer.js on startup
    init(statusCb, readyCb, progressCb) {
      onStatus   = statusCb   || onStatus;
      onReady    = readyCb    || onReady;
      onProgress = progressCb || onProgress;
      initWorker();
    },

    isReady() { return workerReady; },

    // Index a full PDF document.
    // pageTexts: { 1: "page 1 text", 2: "page 2 text", ... }
    // Returns: { chunks, vectors } (also cached in memory + IndexedDB)
    async indexDocument(pdfKey, pageTexts) {
      // Check memory cache first
      if (memCache[pdfKey]) {
        onStatus("✅ RAG index loaded from cache");
        return memCache[pdfKey];
      }

      // Check IndexedDB
      try {
        const stored = await dbLoad(pdfKey);
        if (stored && stored.chunks && stored.vectors) {
          memCache[pdfKey] = { chunks: stored.chunks, vectors: stored.vectors };
          onStatus(`✅ RAG index restored (${stored.chunks.length} chunks)`);
          return memCache[pdfKey];
        }
      } catch (e) { console.warn("RAG: IndexedDB load failed", e); }

      // Build fresh index
      onStatus("⚙️ Building RAG index...");
      const chunks = chunkDocument(pageTexts);

      if (!chunks.length) {
        onStatus("⚠️ No text found to index");
        return null;
      }

      onStatus(`⚙️ Embedding ${chunks.length} chunks...`);
      const result    = await sendToWorker({ type: "embed_chunks", chunks });
      const vectors   = result.embeddings;

      memCache[pdfKey] = { chunks, vectors };

      // Persist to IndexedDB (non-blocking)
      dbSave(pdfKey, chunks, vectors)
        .then(() => onStatus(`✅ RAG index saved (${chunks.length} chunks)`))
        .catch(e  => console.warn("RAG: IndexedDB save failed", e));

      return memCache[pdfKey];
    },

    // Retrieve top-K most relevant chunks for a query.
    // Returns array of { chunk, score } sorted by relevance.
    async retrieve(pdfKey, question, topK = 4) {
      const index = memCache[pdfKey];
      if (!index) return [];

      const result = await sendToWorker({
        type:       "query",
        question,
        embeddings: index.vectors,
        topK
      });

      return result.topIndices.map(({ index: i, score }) => ({
        chunk: index.chunks[i],
        score
      }));
    },

    // Build the context string to send to LLM from retrieved chunks.
    // Includes page citations.
    buildContext(retrieved) {
      if (!retrieved.length) return "";
      return retrieved
        .sort((a, b) => a.chunk.page - b.chunk.page) // sort by page for readability
        .map(r => `[Page ${r.chunk.page}]\n${r.chunk.text}`)
        .join("\n\n---\n\n");
    },

    // Get page numbers that were retrieved (for UI hints)
    getSourcePages(retrieved) {
      return [...new Set(retrieved.map(r => r.chunk.page))].sort((a,b)=>a-b);
    },

    // Check if a PDF has a cached index
    async hasIndex(pdfKey) {
      if (memCache[pdfKey]) return true;
      try {
        const stored = await dbLoad(pdfKey);
        return !!(stored && stored.chunks);
      } catch { return false; }
    },

    // Clear index for a PDF
    async clearIndex(pdfKey) {
      delete memCache[pdfKey];
      await dbDelete(pdfKey).catch(() => {});
    },

    // Stats for UI
    getStats(pdfKey) {
      const index = memCache[pdfKey];
      if (!index) return null;
      const pages = [...new Set(index.chunks.map(c => c.page))];
      return {
        chunks:   index.chunks.length,
        pages:    pages.length,
        minPage:  Math.min(...pages),
        maxPage:  Math.max(...pages)
      };
    }
  };

})();