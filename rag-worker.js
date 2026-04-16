import { pipeline, env } from "./lib/transformers.min.js";

let embedder = null;
let ready = false;
let loading = null;

async function loadModel() {
  if (ready) return;
  if (loading) return loading;
  loading = (async () => {
    self.postMessage({ type: "model_loading" });
    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    embedder = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      {
        progress_callback: (p) => {
          self.postMessage({ type: "model_progress", loaded: p.loaded || 0, total: p.total || 0 });
        }
      }
    );
    ready = true;
    self.postMessage({ type: "model_ready" });
  })();
  return loading;
}

async function embed(text) {
  await loadModel();
  const out = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

self.onmessage = async (e) => {
  const msg = e.data;
  const { type, id } = msg;
  try {
    if (type === "init") { await loadModel(); return; }
    if (type === "embed_chunks") {
      const vectors = [];
      for (let i = 0; i < msg.chunks.length; i++) {
        const vec = await embed(msg.chunks[i].text);
        vectors.push(vec);
        self.postMessage({ type: "embed_progress", done: i + 1, total: msg.chunks.length, id });
      }
      self.postMessage({ type: "embed_done", embeddings: vectors, id });
      return;
    }
    if (type === "query") {
      const q = await embed(msg.question);
      const scored = msg.embeddings.map((v, i) => ({ index: i, score: cosine(q, v) }));
      scored.sort((a, b) => b.score - a.score);
      self.postMessage({ type: "query_result", topIndices: scored.slice(0, msg.topK || 4), id });
      return;
    }
  } catch (err) {
    self.postMessage({ type: "worker_error", error: err.message, id });
  }
};
