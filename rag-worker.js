// ═══════════════════════════════════════════════════════════════
// PageWise AI — RAG Web Worker
// Runs entirely off the main thread.
// Responsibilities:
//   1. Load transformers.js + all-MiniLM-L6-v2 (sentence embeddings)
//   2. Embed an array of text chunks → float32 vectors
//   3. Embed a query string → float32 vector
//   4. Compute cosine similarity → return top-K chunk indices
// ═══════════════════════════════════════════════════════════════
importScripts(chrome.runtime.getURL("lib/transformers.min.js"));

// Use WASM backend (works in Chrome extension context)
self.env = self.env || {};

let embedder = null;
let modelReady = false;

// ── Load model on first message ───────────────────────────────
async function loadModel() {
  if (modelReady) return;
  self.postMessage({ type: "model_loading" });
  try {
    const { pipeline } = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js").catch(() => self);
    // Use Xenova namespace exposed by importScripts
    embedder = await Xenova.pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      { progress_callback: (p) => {
          if (p.status === "downloading") {
            self.postMessage({ type: "model_progress", loaded: p.loaded, total: p.total, file: p.file });
          }
        }
      }
    );
    modelReady = true;
    self.postMessage({ type: "model_ready" });
  } catch (err) {
    self.postMessage({ type: "model_error", error: err.message });
  }
}

// ── Embed a single string → Float32Array ─────────────────────
async function embed(text) {
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(output.data); // plain array for structured clone
}

// ── Cosine similarity between two vectors ────────────────────
function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

// ── Message handler ───────────────────────────────────────────
self.onmessage = async (e) => {
  const { type, id } = e.data;

  // 1. INIT — load the model
  if (type === "init") {
    await loadModel();
    return;
  }

  // 2. EMBED_CHUNKS — embed array of { text, page, chunkIndex }
  if (type === "embed_chunks") {
    if (!modelReady) await loadModel();
    const { chunks } = e.data;
    const embeddings = [];
    for (let i = 0; i < chunks.length; i++) {
      const vec = await embed(chunks[i].text);
      embeddings.push(vec);
      // Report progress every 5 chunks
      if (i % 5 === 0 || i === chunks.length - 1) {
        self.postMessage({ type: "embed_progress", done: i + 1, total: chunks.length, id });
      }
    }
    self.postMessage({ type: "embed_done", embeddings, id });
    return;
  }

  // 3. QUERY — embed query, find top-K chunks
  if (type === "query") {
    if (!modelReady) await loadModel();
    const { question, embeddings, topK = 4 } = e.data;
    const qVec = await embed(question);
    const scores = embeddings.map((vec, i) => ({ i, score: cosineSim(qVec, vec) }));
    scores.sort((a, b) => b.score - a.score);
    const topIndices = scores.slice(0, topK).map(s => ({ index: s.i, score: s.score }));
    self.postMessage({ type: "query_result", topIndices, id });
    return;
  }
};