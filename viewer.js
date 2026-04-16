// ── Settings ──────────────────────────────────────────────
async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get("pagewise_config", data =>
      resolve(data.pagewise_config || { backend: "ollama" }));
  });
}

// ── AI: getSummary ────────────────────────────────────────
async function getSummary(text) {
  if (!text || text.trim().length < 20) return "⚠️ Not enough text on this page to summarize.";
  const config = await getSettings();
  if (config.backend === "groq") {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.groqModel || "llama-3.1-8b-instant",
          messages: [{ role: "user", content: `Summarize this text for exam revision. Rules:
- Split into clear sections with a short heading in format: ## Heading
- Under each heading write 2-4 bullet points starting with "•"
- Within bullet points, wrap the single most important term or phrase in **double asterisks**
- Keep each bullet to 1 concise sentence
- Leave a blank line between sections
- Do NOT write paragraphs

Text:
${text.slice(0, 3000)}` }],
          max_tokens: 1000
        })
      });
      const data = await res.json();
      return data.choices[0].message.content;
    } catch { return "❌ Groq API call failed."; }
  } else {
    try {
      const url = config.ollamaUrl || "http://localhost:5000";
      const res = await fetch(`${url}/summarize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const data = await res.json();
      return data.summary;
    } catch { return "❌ Ollama server not running."; }
  }
}

// ── AI: getKeywords ───────────────────────────────────────
async function getKeywords(text) {
  if (!text || text.trim().length < 20) return [];
  const config = await getSettings();
  if (config.backend === "groq") {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.groqModel || "llama-3.1-8b-instant",
          messages: [{ role: "user", content: `Extract 8 keywords. Return ONLY a JSON array. Example: ["word1","word2"]\n\n${text.slice(0, 1500)}` }],
          max_tokens: 100
        })
      });
      const data = await res.json();
      const raw = data.choices[0].message.content;
      const match = raw.match(/\[.*?\]/s);
      return match ? JSON.parse(match[0]) : [];
    } catch { return []; }
  } else {
    try {
      const url = config.ollamaUrl || "http://localhost:5000";
      const res = await fetch(`${url}/keywords`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const data = await res.json();
      return data.keywords || [];
    } catch { return []; }
  }
}

// ── App State ─────────────────────────────────────────────
const summaryCache = {};
const textCache    = {};
const chatHistory  = {};

let tabs        = [];
let activeTabId = null;
let isLight     = false;

// ── RAG State ─────────────────────────────────────────────
let isRagMode = false;  // global toggle for chat panel
let ragReady  = false;  // RAG engine ready

// RAG callbacks
function updateRagStatus(msg) {
  const el = document.getElementById("rag-status");
  if (el) el.textContent = msg;
}

function updateRagReady(ready) {
  ragReady = ready;
  updateRagBadge(ready);
}

function updateRagProgress(pct, done, total) {
  const bar = document.getElementById("rag-progress-bar");
  if (bar) {
    bar.style.width = pct + "%";
    bar.parentElement.style.display = "block";
  }
}

function updateRagBadge(ready) {
  const badge = document.getElementById("rag-badge");
  if (!badge) return;
  badge.className = "rag-badge " + (ready ? "ready" : "loading");
  badge.title = ready ? "RAG index ready — full PDF chat enabled" : "Building RAG index...";
}

// ── RAG Toggle ────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const ragToggle = document.getElementById("rag-toggle");
  const ragLabel  = document.getElementById("rag-mode-label");
  
  if (ragToggle) {
    ragToggle.addEventListener("click", () => {
      isRagMode = !isRagMode;
      ragToggle.classList.toggle("active", isRagMode);
      
      if (ragLabel) {
        ragLabel.textContent = isRagMode ? "🧠 Full Doc RAG" : "📄 This Page";
      }
      
      const tab = activeTab();
      if (tab && isRagMode && ragReady && !tab.hasRagIndex) {
        indexDocumentForTab(tab);
      }
    });
  }
});

// ── Highlight State ───────────────────────────────────────
let highlights    = {};         // { pdfKey: [{ id, page, color, rect, note }] }
let hlMode        = false;      // are we in highlight mode?
let selectedColor = "yellow";
let isDragging    = false;
let dragStart     = null;       // { x, y } in canvas coords
let dragEnd       = null;

// ── DOM refs ──────────────────────────────────────────────
const statusEl    = document.getElementById("status");
// Static canvases removed — multi-page scroll uses per-page canvases
const noop2d = { clearRect:()=>{}, fillRect:()=>{}, beginPath:()=>{}, fill:()=>{}, roundRect:()=>{}, rect:()=>{} };
const canvas     = { width:0, height:0, getContext:()=>noop2d };
const hlCanvas   = { width:0, height:0, getContext:()=>noop2d };
const dragCanvas = { width:0, height:0, getContext:()=>noop2d };
const ctx        = noop2d;
const hlCtx      = noop2d;
const dragCtx    = noop2d;
const summaryBox  = document.getElementById("summary-box");
const pageInfo    = document.getElementById("page-info");
const loader      = document.getElementById("loader");
const summScroll  = document.getElementById("summary-scroll");
const cacheTag    = document.getElementById("cache-tag");
const pageSlider  = document.getElementById("page-slider");
const kwWrap      = document.getElementById("keywords-wrap");
const pageFlash   = { classList:{ add:()=>{}, remove:()=>{} } };
const tabsWrap    = document.getElementById("tabs-wrap");
const canvasWrap  = { classList:{ add:()=>{}, remove:()=>{} } };
const hlActionBar = document.getElementById("hl-action-bar");
const hlModeBtn   = document.getElementById("hl-mode-btn");

pdfjsLib.GlobalWorkerOptions.workerSrc = "pdfjs/pdf.worker.min.js";

// ── Panel switching ───────────────────────────────────────
document.querySelectorAll(".panel-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".panel-tab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel-section").forEach(s => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("panel-" + btn.dataset.panel).classList.add("active");
  });
});

// ── Theme ─────────────────────────────────────────────────
document.getElementById("theme-btn").addEventListener("click", () => {
  isLight = !isLight;
  document.documentElement.setAttribute("data-theme", isLight ? "light" : "dark");
  document.getElementById("theme-btn").textContent = isLight ? "🌑" : "🌙";
  redrawHighlights();
});

// ══════════════════════════════════════════════════════════
// HIGHLIGHT MODE
// ══════════════════════════════════════════════════════════

// Enter / exit highlight mode
hlModeBtn.addEventListener("click", () => {
  hlMode = true;
  hlActionBar.classList.remove("hidden");
  hlModeBtn.style.background  = "var(--accent)";
  hlModeBtn.style.color       = "#fff";
  hlModeBtn.style.borderColor = "var(--accent)";
  document.querySelectorAll(".drag-overlay").forEach(d => {
    d.style.pointerEvents = "auto";
    d.style.cursor = "crosshair";
  });
  statusEl.textContent = "✏ Highlight mode ON — drag over text to highlight";
});

document.getElementById("hl-done-btn").addEventListener("click", exitHlMode);

function exitHlMode() {
  hlMode = false;
  hlActionBar.classList.add("hidden");
  hlModeBtn.style.background  = "";
  hlModeBtn.style.color       = "";
  hlModeBtn.style.borderColor = "";
  document.querySelectorAll(".drag-overlay").forEach(d => {
    d.style.pointerEvents = "none";
    d.style.cursor        = "";
    d.getContext("2d").clearRect(0, 0, d.width, d.height);
  });
  isDragging = false;
  const tab = activeTab();
  if (tab) statusEl.textContent = `✅ ${tab.pdfDoc?.numPages} pages loaded`;
}

// Color picker in action bar
document.querySelectorAll(".hl-color-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".hl-color-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    selectedColor = btn.dataset.color;
  });
});

// ── Get mouse position relative to canvas ────────────────
function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  // Scale mouse coords to canvas pixel space
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top)  * scaleY
  };
}

// ── Drag events are now handled per-page in setupDragOnAllPages() ──────────

// Draw live preview rect while dragging
function drawDragRect() {
  dragCtx.clearRect(0, 0, dragCanvas.width, dragCanvas.height);
  if (!dragStart || !dragEnd) return;

  const rect = normalizeRect(dragStart, dragEnd);
  const colorMap = {
    yellow: "rgba(247,201,72,0.35)",
    green:  "rgba(74,222,128,0.3)",
    blue:   "rgba(79,195,247,0.3)",
    pink:   "rgba(248,113,113,0.3)"
  };
  const borderMap = {
    yellow: "rgba(247,201,72,0.9)",
    green:  "rgba(74,222,128,0.9)",
    blue:   "rgba(79,195,247,0.9)",
    pink:   "rgba(248,113,113,0.9)"
  };

  dragCtx.fillStyle   = colorMap[selectedColor];
  dragCtx.strokeStyle = borderMap[selectedColor];
  dragCtx.lineWidth   = 1.5;

  dragCtx.beginPath();
  dragCtx.rect(rect.x, rect.y, rect.w, rect.h);
  dragCtx.fill();
  dragCtx.stroke();
}

// Normalize rect so x/y is always top-left
function normalizeRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y)
  };
}

// Save the dragged rect as a highlight
function saveHighlightRect(rect) {
  const tab = activeTab();
  if (!tab) return;
  const key = getPdfKey();
  if (!highlights[key]) highlights[key] = [];

  // Extract text under the rect from PDF text items
  const note = extractTextFromRect(rect, tab.id, tab.currentPage);

  const hl = {
    id:    Date.now().toString(),
    page:  tab.currentPage,
    color: selectedColor,
    rect,
    note: note || `Highlighted area (page ${tab.currentPage})`
  };

  highlights[key].push(hl);
  saveHighlights();
  redrawHighlights();
  renderHighlightsList();
  updateHighlightCount();

  statusEl.textContent = `✅ Highlight saved!`;
  setTimeout(() => {
    if (hlMode) statusEl.textContent = "✏ Highlight mode ON — drag over text to highlight";
  }, 1500);
}

// Extract text items that fall within a canvas rect
// Uses overlap detection instead of center-point — catches partial words at edges
function extractTextFromRect(rect, tabId, pageNum) {
  const items = textItemsCache[tabId]?.[pageNum];
  if (!items) return "";

  // Expand rect slightly to catch items at boundaries
  const pad = 4;
  const rx1 = rect.x - pad, ry1 = rect.y - pad;
  const rx2 = rect.x + rect.w + pad, ry2 = rect.y + rect.h + pad;

  const matched = items.filter(item => {
    // Check if item rect overlaps with selection rect
    const ix1 = item.x, iy1 = item.y;
    const ix2 = item.x + item.w, iy2 = item.y + item.h;
    return ix1 < rx2 && ix2 > rx1 && iy1 < ry2 && iy2 > ry1;
  });

  // Sort by y (line) then x (reading order)
  matched.sort((a, b) => {
    const lineDiff = Math.round(a.y / 8) - Math.round(b.y / 8);
    return lineDiff !== 0 ? lineDiff : a.x - b.x;
  });

  return matched.map(i => i.str).join(" ").replace(/\s+/g, " ").trim();
}



// ── Text items cache (for text extraction under rects) ────
const textItemsCache = {}; // { tabId: { pageNum: [{x,y,w,h,str}] } }

function cacheTextItems(textContent, viewport, tabId, pageNum) {
  if (!textItemsCache[tabId]) textItemsCache[tabId] = {};
  const canvasHeight = viewport.height;

  textItemsCache[tabId][pageNum] = textContent.items
    .filter(item => item.str.trim())
    .map(item => {
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const x  = tx[4];
      const y  = canvasHeight - tx[5];
      const h  = Math.abs(tx[3]);
      const w  = item.width * viewport.scale;
      return { x, y: y - h, w, h, str: item.str };
    });
}

// ── Draw saved highlights on hlCanvas ────────────────────
const colorMap = {
  yellow: "rgba(247,201,72,0.45)",
  green:  "rgba(74,222,128,0.4)",
  blue:   "rgba(79,195,247,0.4)",
  pink:   "rgba(248,113,113,0.4)"
};

function drawHighlightOnCanvas(hlc, hl) {
  const hctx = hlc.getContext("2d");
  hctx.fillStyle = colorMap[hl.color] || colorMap.yellow;
  const r = hl.rect;
  hctx.beginPath();
  if (hctx.roundRect) hctx.roundRect(r.x, r.y, r.w, r.h, 3);
  else hctx.rect(r.x, r.y, r.w, r.h);
  hctx.fill();
}

function redrawHighlights() {
  const key = getPdfKey();
  if (!key || !highlights[key]) return;

  // Group by page
  const byPage = {};
  highlights[key].forEach(hl => {
    if (!byPage[hl.page]) byPage[hl.page] = [];
    byPage[hl.page].push(hl);
  });

  // Draw on each page's hl canvas
  const currentTabId = activeTabId;
  Object.entries(byPage).forEach(([pg, hls]) => {
    const block = document.getElementById(`page-block-${currentTabId}-${pg}`);
    if (!block) return;
    const hlc  = block.querySelector(".hl-overlay");
    if (!hlc) return;
    const hctx = hlc.getContext("2d");
    hctx.clearRect(0, 0, hlc.width, hlc.height);
    hls.forEach(hl => drawHighlightOnCanvas(hlc, hl));
  });
}

// ── Highlights list panel ─────────────────────────────────
function renderHighlightsList() {
  const hlList = document.getElementById("hl-list");
  const key = getPdfKey();
  const hls = (key && highlights[key]) ? highlights[key] : [];

  if (!hls.length) {
    hlList.innerHTML = `<div class="hl-empty"><div class="ei">🖊</div><div>No highlights yet.<br>Click 🖊 Highlight in toolbar,<br>then drag over PDF text.</div></div>`;
    return;
  }

  hlList.innerHTML = "";
  [...hls].sort((a, b) => a.page - b.page).forEach(hl => {
    const item = document.createElement("div");
    item.className = "hl-item";

    // Color map for the text background
    const bgMap = {
      yellow: "rgba(247,201,72,0.22)",
      green:  "rgba(74,222,128,0.18)",
      blue:   "rgba(79,195,247,0.18)",
      pink:   "rgba(248,113,113,0.18)"
    };
    const borderMap = {
      yellow: "#f7c948",
      green:  "#4ade80",
      blue:   "#4fc3f7",
      pink:   "#f87171"
    };

    const hasText  = hl.note && !hl.note.startsWith("Highlighted area");
    const textHtml = hasText
      ? `<div class="hl-item-text-block" style="background:${bgMap[hl.color]};border-left:3px solid ${borderMap[hl.color]}">${hl.note}</div>`
      : `<div class="hl-item-text-block hl-item-no-text" style="border-left:3px solid ${borderMap[hl.color]}">⚠ No text extracted — image or non-selectable region</div>`;

    item.innerHTML = `
      <div class="hl-item-header">
        <div class="hl-item-dot dot-${hl.color}"></div>
        <span class="hl-item-page">Page ${hl.page}</span>
        <span class="hl-item-color-label">${hl.color}</span>
        <button class="hl-item-delete" data-id="${hl.id}">✕</button>
      </div>
      ${textHtml}
    `;

    item.querySelector(".hl-item-text-block").addEventListener("click", () => {
      renderPage(hl.page);
      document.querySelectorAll(".panel-tab").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".panel-section").forEach(s => s.classList.remove("active"));
      document.querySelector("[data-panel='summary']").classList.add("active");
      document.getElementById("panel-summary").classList.add("active");
    });
    item.querySelector(".hl-item-delete").addEventListener("click", () => deleteHighlight(hl.id));
    hlList.appendChild(item);
  });
}

function deleteHighlight(id) {
  const key = getPdfKey();
  if (!key) return;
  highlights[key] = highlights[key].filter(h => h.id !== id);
  saveHighlights();
  redrawHighlights();
  renderHighlightsList();
  updateHighlightCount();
}

function updateHighlightCount() {
  const key   = getPdfKey();
  const count = (key && highlights[key]) ? highlights[key].length : 0;
  document.getElementById("hl-count-badge").textContent  = `${count} saved`;
  document.getElementById("hl-tab-count").textContent    = count > 0 ? `${count} ` : "";
}

function saveHighlights() {
  chrome.storage.local.set({ pagewise_highlights: highlights });
}

async function loadHighlights() {
  return new Promise(resolve => {
    chrome.storage.local.get("pagewise_highlights", data => {
      highlights = data.pagewise_highlights || {};
      resolve();
    });
  });
}

// ── Export highlights ─────────────────────────────────────
document.getElementById("hl-export-btn").addEventListener("click", () => {
  const key = getPdfKey();
  const hls = (key && highlights[key]) ? highlights[key] : [];
  if (!hls.length) { alert("No highlights to export."); return; }

  let out = `PageWise AI — Highlights\n${key}\n${"=".repeat(40)}\n\n`;
  const byPage = {};
  hls.forEach(h => { if (!byPage[h.page]) byPage[h.page] = []; byPage[h.page].push(h); });
  Object.keys(byPage).sort((a,b)=>a-b).forEach(pg => {
    out += `PAGE ${pg}\n${"-".repeat(20)}\n`;
    byPage[pg].forEach(h => { out += `[${h.color.toUpperCase()}] ${h.note}\n`; });
    out += "\n";
  });

  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([out], { type: "text/plain" })),
    download: "pagewise-highlights.txt"
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById("hl-clear-btn").addEventListener("click", () => {
  const key = getPdfKey();
  if (!key) return;
  if (!confirm("Clear all highlights for this PDF?")) return;
  highlights[key] = [];
  saveHighlights();
  redrawHighlights();
  renderHighlightsList();
  updateHighlightCount();
});

// ══════════════════════════════════════════════════════════
// FILE UPLOAD — DOCX / PPTX / TXT / MD
// ══════════════════════════════════════════════════════════

document.getElementById("upload-file-btn").addEventListener("click", () => {
  document.getElementById("file-input").click();
});

document.getElementById("file-input").addEventListener("change", async (e) => {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  for (let i = 0; i < files.length; i++) {
    await openFileAsTab(files[i]);
  }
  e.target.value = "";
});

// Drag-drop onto the pdf-pane
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", async e => {
  e.preventDefault();
  const files = e.dataTransfer.files;
  if (!files) return;
  for (let i = 0; i < files.length; i++) {
    await openFileAsTab(files[i]);
  }
});

async function openFileAsTab(file) {
  const ext  = file.name.split(".").pop().toLowerCase();

  if (ext === "pdf") {
    const url = URL.createObjectURL(file);
    createTab(url, file.name.slice(0, 28));
    return;
  }

  if (!["docx","pptx","txt","md"].includes(ext)) {
    alert(`Unsupported file type: .${ext}\nSupported: PDF, DOCX, PPTX, TXT, MD\n\nLegacy formats like .doc and .ppt are not supported. Please convert them to .docx or .pptx.`);
    return;
  }

  // Non-PDF — create doc tab
  const id = Date.now().toString() + "-" + Math.random().toString(36).substr(2, 5);
  tabs.push({ id, label: file.name.slice(0, 28), url: null, pdfDoc: null, currentPage: 1, isDoc: true, docFile: file });
  summaryCache[id] = {};
  textCache[id]    = {};
  chatHistory[id]  = [];
  renderTabs();
  // Instead of manually doing everything, we now use switchTab which caches the active tab before switching!
  switchTab(id);
}

async function switchDocTab(id, file, ext) {
  // activeTabId and caching are now handled by switchTab before this gets called.
  const pdfPane = document.getElementById("pdf-pane") || document.getElementById("pdf-pane");
  if (activeTabId === id) {
    pdfPane.innerHTML = `<div class="doc-loading"><div class="loader-ring"></div><div class="doc-loading-text">Extracting from ${file.name}...</div></div>`;
  }

  document.querySelector(".slider-wrap").style.display = "none";
  document.querySelector(".nav-group").style.display   = "none";
  statusEl.textContent = `📂 Loading ${file.name}...`;

  try {
    let pages = []; // array of { pageNum, text }

    if (ext === "txt" || ext === "md") {
      const text = await file.text();
      // Split into ~500 word chunks as "pages"
      const words  = text.split(/\s+/);
      const size   = 500;
      for (let i = 0; i < words.length; i += size) {
        pages.push({ pageNum: pages.length + 1, text: words.slice(i, i + size).join(" ") });
      }
      if (!pages.length) pages = [{ pageNum: 1, text }];

    } else if (ext === "docx") {
      if (typeof mammoth === "undefined") {
        throw new Error("Mammoth library not found. Please run:\nInvoke-WebRequest -Uri 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js' -OutFile 'lib\\mammoth.min.js'");
      }
      const arrayBuf = await file.arrayBuffer();
      const result   = await mammoth.extractRawText({ arrayBuffer: arrayBuf });
      const text     = result.value;
      const paras    = text.split(/\n{2,}/);
      // Group paragraphs into ~400-word pages
      let chunk = [], count = 0;
      paras.forEach(p => {
        const wc = p.split(/\s+/).length;
        if (count + wc > 400 && chunk.length) {
          pages.push({ pageNum: pages.length + 1, text: chunk.join("\n\n") });
          chunk = []; count = 0;
        }
        chunk.push(p); count += wc;
      });
      if (chunk.length) pages.push({ pageNum: pages.length + 1, text: chunk.join("\n\n") });

    } else if (ext === "pptx") {
      pages = await extractPptxPages(file);
    }

    if (!pages.length) {
      if (activeTabId === id) pdfPane.innerHTML = `<div class="doc-error">⚠ Could not extract text from this file.</div>`;
      return;
    }

    // Store text cache
    const tab = tabs.find(t => t.id === id);
    if (!tab) return;
    tab.docPages  = pages;
    tab.totalPages = pages.length;
    pages.forEach(p => { textCache[id][p.pageNum] = p.text; });

    // Update UI only if still active
    if (activeTabId === id) {
      const slider = document.getElementById("page-slider");
      slider.max   = pages.length;
      slider.value = 1;
      document.querySelector(".slider-wrap").style.display = "flex";
      document.querySelector(".nav-group").style.display   = "flex";
      pageInfo.textContent = `1 / ${pages.length}`;
      document.getElementById("prev-page").disabled = true;
      document.getElementById("next-page").disabled = pages.length <= 1;

      renderDocPage(id, 1);
      statusEl.textContent = `✅ ${file.name} — ${pages.length} section${pages.length > 1 ? "s" : ""}`;
    }

    // Always fetch summary regardless of active, so they process in background
    loadSummaryForPage(tab, 1);

  } catch (err) {
    console.error("File load error:", err);
    if (activeTabId === id) {
      pdfPane.innerHTML = `<div class="doc-error">❌ Error: ${err.message}</div>`;
      statusEl.textContent = "❌ Failed to load file";
    }
  }
}

function renderDocPage(tabId, pageNum) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab || !tab.docPages) return;

  tab.currentPage = pageNum;
  pageInfo.textContent = `${pageNum} / ${tab.totalPages}`;
  document.getElementById("page-slider").value = pageNum;
  document.getElementById("prev-page").disabled = pageNum <= 1;
  document.getElementById("next-page").disabled = pageNum >= tab.totalPages;

  const page = tab.docPages.find(p => p.pageNum === pageNum);
  if (!page) return;

  const pdfPane = document.getElementById("pdf-pane");
  pdfPane.innerHTML = "";

  const block = document.createElement("div");
  block.className = "doc-page-block";

  const label = document.createElement("div");
  label.className   = "page-scroll-label";
  label.textContent = `Section ${pageNum} of ${tab.totalPages}`;

  const content = document.createElement("div");
  content.className   = "doc-page-content";
  content.textContent = page.text;

  block.appendChild(label);
  block.appendChild(content);
  pdfPane.appendChild(block);

  loadSummaryForPage(tab, pageNum);
}

// Extract PPTX slides as pages using JSZip
async function extractPptxPages(file) {
  if (typeof JSZip === "undefined") {
    throw new Error("JSZip library not found. Please run:\nInvoke-WebRequest -Uri 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js' -OutFile 'lib\\jszip.min.js'");
  }
  const zip    = await JSZip.loadAsync(await file.arrayBuffer());
  const slides = [];

  // Find all slide XML files
  const slideFiles = Object.keys(zip.files)
    .filter(n => n.match(/^ppt\/slides\/slide\d+\.xml$/))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)?.[0] || 0);
      const nb = parseInt(b.match(/\d+/)?.[0] || 0);
      return na - nb;
    });

  for (const sf of slideFiles) {
    const xml  = await zip.files[sf].async("string");
    const text = extractTextFromXml(xml);
    if (text.trim()) slides.push({ pageNum: slides.length + 1, text: text.trim() });
  }
  return slides;
}

// Strip XML tags and extract text content
function extractTextFromXml(xml) {
  // Get all <a:t> text elements (DrawingML text)
  const matches = xml.match(/<a:t[^>]*>([^<]+)<\/a:t>/g) || [];
  return matches
    .map(m => m.replace(/<[^>]+>/g, "").trim())
    .filter(Boolean)
    .join(" ");
}

// ══════════════════════════════════════════════════════════
// PDF LOADING & RENDERING
// ══════════════════════════════════════════════════════════

function createTab(url, label) {
  const id  = Date.now().toString() + "-" + Math.random().toString(36).substr(2, 5);
  const lbl = label || decodeURIComponent(url.split("/").pop() || "PDF").slice(0, 24);
  tabs.push({ id, label: lbl, url, pdfDoc: null, currentPage: 1 });
  summaryCache[id] = {};
  textCache[id]    = {};
  chatHistory[id]  = [];
  renderTabs();
  switchTab(id);
}

function renderTabs() {
  tabsWrap.innerHTML = "";
  tabs.forEach(tab => {
    const el = document.createElement("div");
    el.className = "tab" + (tab.id === activeTabId ? " active" : "");
    const icon = tab.isDoc ? getDocIcon(tab.label) : "📄";
    el.innerHTML = `<span class="tab-name" title="${tab.label}">${icon} ${tab.label}</span><span class="tab-x" data-id="${tab.id}">✕</span>`;
    el.addEventListener("click", e => { if (!e.target.classList.contains("tab-x")) switchTab(tab.id); });
    el.querySelector(".tab-x").addEventListener("click", e => { e.stopPropagation(); closeTab(tab.id); });
    tabsWrap.appendChild(el);
  });
}

function getDocIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  return { docx: "📝", ppt: "📊", pptx: "📊", txt: "📃", md: "📋" }[ext] || "📄";
}

function switchTab(id) {
  // Save current pane state before switching away
  const prevTab = tabs.find(t => t.id === activeTabId);
  if (prevTab && activeTabId !== id) {
    const pane = document.getElementById("pdf-pane");
    prevTab._paneNodes = Array.from(pane.childNodes);
  }

  activeTabId = id;
  renderTabs();
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  renderChatHistory(id);
  renderHighlightsList();
  updateHighlightCount();
  const pdfKey = getPdfKeyForTab(tab);
  loadFcCache(id, pdfKey);

  // Doc tab
  if (tab.isDoc) {
    document.querySelector(".slider-wrap").style.display = tab.docPages ? "flex" : "none";
    document.querySelector(".nav-group").style.display   = tab.docPages ? "flex" : "none";
    if (tab.docPages) {
      renderDocPage(id, tab.currentPage);
    } else {
      const ext = tab.docFile?.name.split(".").pop().toLowerCase();
      switchDocTab(id, tab.docFile, ext);
    }
    // Restore summary
    if (summaryCache[id]?.[tab.currentPage]) {
      showSummary(summaryCache[id][tab.currentPage], true);
    }
    return;
  }

  // PDF tab
  document.querySelector(".slider-wrap").style.display = "flex";
  document.querySelector(".nav-group").style.display   = "flex";

  if (tab.pdfDoc) {
    pageSlider.max   = tab.pdfDoc.numPages;
    pageSlider.value = tab.currentPage;
    pageInfo.textContent = `${tab.currentPage} / ${tab.pdfDoc.numPages}`;
    document.getElementById("prev-page").disabled = tab.currentPage <= 1;
    document.getElementById("next-page").disabled = tab.currentPage >= tab.pdfDoc.numPages;

    // Restore saved pane nodes if available, otherwise re-render
    if (tab._paneNodes) {
      const pane = document.getElementById("pdf-pane");
      pane.innerHTML = "";
      tab._paneNodes.forEach(node => pane.appendChild(node));
      setupScrollObserver(tab);
      setupDragOnAllPages(tab);
      redrawHighlights();
    } else {
      renderPage(tab.currentPage);
    }

    // Restore summary
    if (summaryCache[id]?.[tab.currentPage]) {
      showSummary(summaryCache[id][tab.currentPage], true);
    } else {
      loadSummaryForPage(tab, tab.currentPage);
    }
  } else {
    loadPDF(tab.url, id);
  }
}

function closeTab(id) {
  tabs = tabs.filter(t => t.id !== id);
  delete summaryCache[id];
  delete textCache[id];
  delete chatHistory[id];
  if (tabs.length === 0) {
    statusEl.textContent = "No PDFs open.";
    canvas.width = 0; canvas.height = 0;
    hlCanvas.width = 0; hlCanvas.height = 0;
    dragCanvas.width = 0; dragCanvas.height = 0;
    summaryBox.innerHTML = "";
    kwWrap.innerHTML = "";
    activeTabId = null;
    renderTabs();
    return;
  }
  switchTab(tabs[tabs.length - 1].id);
}

function activeTab() { return tabs.find(t => t.id === activeTabId); }
function getPdfKey() {
  const tab = activeTab();
  if (!tab) return null;
  return decodeURIComponent(tab.url.split("/").pop() || tab.url);
}

async function loadPDF(url, tabId) {
  // Strip any accidental surrounding quotes
  url = url.replace(/^["']+|["']+$/g, "").trim();
  statusEl.textContent = "📄 Loading PDF...";
  showLoader();
  try {
    const pdf = await pdfjsLib.getDocument(url).promise;
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    tab.pdfDoc = pdf;
    tab.hasRagIndex = false;  // Reset RAG flag

    if (activeTabId !== tabId) return;

    pageSlider.max   = pdf.numPages;
    pageSlider.value = 1;
    statusEl.textContent = `✅ Loaded — ${pdf.numPages} pages`;
    renderPage(1);

  } catch (err) {
    if (activeTabId === tabId) {
      statusEl.textContent = "❌ Error loading PDF: " + err.message;
      hideLoader();
    }
  }
}

// ── RAG Document Indexing ─────────────────────────────────
async function indexDocumentForTab(tab) {
  const pdfKey = getPdfKeyForTab(tab);
  updateRagStatus("🔍 Checking RAG cache...");
  
  // Check if already indexed
  const hasIndex = await RAG.hasIndex(pdfKey);
  if (hasIndex) {
    tab.hasRagIndex = true;
    const stats = RAG.getStats(pdfKey);
    updateRagStatus(`✅ RAG restored (${stats?.chunks || 0} chunks)`);
    updateRagReady(true);
    return;
  }

  // Build pageTexts from cache
  const pageTexts = {};
  Object.keys(textCache[tab.id] || {}).forEach(pg => {
    pageTexts[parseInt(pg)] = textCache[tab.id][pg];
  });

  if (!Object.keys(pageTexts).length) {
    updateRagStatus("⚠️ No text to index");
    return;
  }

  try {
    const index = await RAG.indexDocument(pdfKey, pageTexts);
    if (index) {
      tab.hasRagIndex = true;
      const stats = RAG.getStats(pdfKey);
      updateRagStatus(`✅ RAG indexed (${stats.chunks} chunks, ${stats.pages} pages)`);
      updateRagReady(true);
    }
  } catch (err) {
    console.error("RAG indexing failed:", err);
    updateRagStatus("❌ RAG indexing failed");
  }
}

// RAG indexing removed
function getPdfKeyForTab(tab) {
  if (tab.isDoc && tab.docFile) return decodeURIComponent(tab.docFile.name);
  if (!tab.url) return "unknown_doc_" + tab.id;
  return decodeURIComponent(tab.url.split("/").pop() || tab.url);
}

function updateRagStatus(msg) {
  const el = document.getElementById("rag-status");
  if (el) el.textContent = msg;
}

function updateRagBadge(ready) {
  const badge = document.getElementById("rag-badge");
  if (!badge) return;
  badge.className = "rag-badge " + (ready ? "ready" : "loading");
  badge.title     = ready ? "RAG index ready — full PDF chat enabled" : "Building RAG index...";
}

async function renderPage(pageNum) {
  const tab = activeTab();
  if (!tab || !tab.pdfDoc) return;

  tab.currentPage = pageNum;
  pageInfo.textContent = `${pageNum} / ${tab.pdfDoc.numPages}`;
  pageSlider.value     = pageNum;
  document.getElementById("prev-page").disabled = pageNum <= 1;
  document.getElementById("next-page").disabled = pageNum >= tab.pdfDoc.numPages;

  // If all pages already rendered, just scroll to that page
  const existing = document.getElementById(`page-block-${tab.id}-${pageNum}`);
  if (existing) {
    existing.scrollIntoView({ behavior: "smooth", block: "start" });
    updateCurrentPageFromScroll(pageNum, tab);
    return;
  }

  // First load — render all pages
  await renderAllPages(tab);
}

async function renderAllPages(tab) {
  if (!tab || !tab.pdfDoc) return;
  const pdfPane = document.getElementById("pdf-pane");
  pdfPane.innerHTML = ""; // clear

  const numPages = tab.pdfDoc.numPages;
  statusEl.textContent = `📄 Loading ${numPages} pages...`;

  // Get pane width — wait a frame if needed so layout is complete
  await new Promise(r => requestAnimationFrame(r));
  const paneW = Math.max(pdfPane.clientWidth - 48, 600);

  for (let pg = 1; pg <= numPages; pg++) {
    const block = document.createElement("div");
    block.id           = `page-block-${tab.id}-${pg}`;
    block.className    = "page-scroll-block";
    block.dataset.page = pg;

    const label = document.createElement("div");
    label.className   = "page-scroll-label";
    label.textContent = `PAGE ${pg}`;
    block.appendChild(label);

    const wrap = document.createElement("div");
    wrap.className = "canvas-wrap";

    const cv  = document.createElement("canvas");
    const hlc = document.createElement("canvas");
    const dgc = document.createElement("canvas");
    hlc.className = "hl-overlay";
    hlc.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
    dgc.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";

    wrap.appendChild(cv);
    wrap.appendChild(hlc);
    wrap.appendChild(dgc);
    block.appendChild(wrap);
    pdfPane.appendChild(block);

    try {
      const page     = await tab.pdfDoc.getPage(pg);
      const unscaled = page.getViewport({ scale: 1 });
      const scale    = Math.max(0.5, Math.min(paneW / unscaled.width, 2.0));
      const viewport = page.getViewport({ scale });

      cv.width  = hlc.width  = dgc.width  = Math.floor(viewport.width);
      cv.height = hlc.height = dgc.height = Math.floor(viewport.height);

      const renderCtx = cv.getContext("2d");
      await page.render({ canvasContext: renderCtx, viewport }).promise;

      const textContent = await page.getTextContent();
      const pageText    = textContent.items.map(i => i.str).join(" ");
      textCache[tab.id][pg] = pageText;
      cacheTextItems(textContent, viewport, tab.id, pg);

      tab.canvases       = tab.canvases || {};
      tab.canvases[pg]   = { cv, hlc, dgc, viewport };

      statusEl.textContent = `📄 Rendered ${pg} / ${numPages}`;
    } catch (e) {
      console.error("Page render error pg", pg, e);
      cv.width = paneW; cv.height = 200;
      const ec = cv.getContext("2d");
      ec.fillStyle = "#1a1a2e";
      ec.fillRect(0, 0, cv.width, cv.height);
      ec.fillStyle = "#f87171";
      ec.font = "14px monospace";
      ec.fillText(`⚠ Error rendering page ${pg}`, 20, 100);
    }
  }

  statusEl.textContent = `✅ ${numPages} pages loaded — scroll to read`;

  // Cache the rendered pane for tab switching
  const currentTab = tabs.find(t => t.id === tab.id);
  if (currentTab) currentTab._paneNodes = null; // will be saved on next switchTab

  // Draw highlights on all pages
  redrawHighlights();

  // Setup scroll observer to update current page + summary
  setupScrollObserver(tab);

  // Scroll to currentPage
  const target = document.getElementById(`page-block-${tab.id}-${tab.currentPage}`);
  if (target) target.scrollIntoView({ block: "start" });

  // Load summary for first page
  loadSummaryForPage(tab, tab.currentPage);

  // Setup drag highlight on all pages
  setupDragOnAllPages(tab);
}

// ── Scroll observer — updates page number as user scrolls ─
function setupScrollObserver(tab) {
  const pdfPane = document.getElementById("pdf-pane");
  const observer = new IntersectionObserver((entries) => {
    let best = null, bestRatio = 0;
    entries.forEach(e => {
      if (e.isIntersecting && e.intersectionRatio > bestRatio) {
        bestRatio = e.intersectionRatio;
        best = e.target;
      }
    });
    if (best) {
      const pg = parseInt(best.dataset.page);
      if (pg !== tab.currentPage) {
        tab.currentPage = pg;
        pageInfo.textContent = `${pg} / ${tab.pdfDoc.numPages}`;
        pageSlider.value     = pg;
        document.getElementById("prev-page").disabled = pg <= 1;
        document.getElementById("next-page").disabled = pg >= tab.pdfDoc.numPages;
        loadSummaryForPage(tab, pg);
      }
    }
  }, { root: pdfPane, threshold: [0.3, 0.6] });

  document.querySelectorAll(".page-scroll-block").forEach(b => observer.observe(b));
  tab._scrollObserver = observer;
}

function updateCurrentPageFromScroll(pageNum, tab) {
  tab.currentPage = pageNum;
  pageInfo.textContent = `${pageNum} / ${tab.pdfDoc.numPages}`;
  pageSlider.value     = pageNum;
  loadSummaryForPage(tab, pageNum);
}

async function loadSummaryForPage(tab, pg) {
  const pageText = textCache[tab.id]?.[pg];
  if (!pageText) return;
  if (summaryCache[tab.id][pg]) {
    showSummary(summaryCache[tab.id][pg], true);
    return;
  }
  showLoader();
  const [summary, keywords] = await Promise.all([getSummary(pageText), getKeywords(pageText)]);
  summaryCache[tab.id][pg] = summary;
  showSummary(summary, false);
  renderKeywords(keywords);
}

// ── Setup drag highlight events on all page canvases ──────
function setupDragOnAllPages(tab) {
  document.querySelectorAll(".page-scroll-block").forEach(block => {
    const pg  = parseInt(block.dataset.page);
    const dgc = block.querySelector(".drag-overlay");
    const hlc = block.querySelector(".hl-overlay");
    if (!dgc) return;

    let dragging = false, start = null;
    const dctx = dgc.getContext("2d");

    dgc.addEventListener("mousedown", e => {
      if (!hlMode) return;
      dragging = true;
      const r  = dgc.getBoundingClientRect();
      start    = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    dgc.addEventListener("mousemove", e => {
      if (!dragging || !hlMode) return;
      const r   = dgc.getBoundingClientRect();
      const cur = { x: e.clientX - r.left, y: e.clientY - r.top };
      dctx.clearRect(0, 0, dgc.width, dgc.height);
      dctx.fillStyle = colorMap[selectedColor] + "55";
      dctx.fillRect(start.x, start.y, cur.x - start.x, cur.y - start.y);
    });
    dgc.addEventListener("mouseup", e => {
      if (!dragging || !hlMode) return;
      dragging = false;
      const r   = dgc.getBoundingClientRect();
      const end = { x: e.clientX - r.left, y: e.clientY - r.top };
      dctx.clearRect(0, 0, dgc.width, dgc.height);
      const rect = {
        x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
        w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y)
      };
      if (rect.w > 5 && rect.h > 5) saveHighlightRectOnPage(rect, pg, hlc, tab);
    });
    dgc.addEventListener("mouseleave", () => {
      if (dragging) { dragging = false; dctx.clearRect(0, 0, dgc.width, dgc.height); }
    });

    // Enable/disable pointer events based on hlMode
    dgc.style.pointerEvents = hlMode ? "auto" : "none";
  });
}

function saveHighlightRectOnPage(rect, pg, hlc, tab) {
  const key = getPdfKey();
  if (!highlights[key]) highlights[key] = [];
  const note = extractTextFromRect(rect, tab.id, pg);
  const hl   = { id: Date.now().toString(), page: pg, color: selectedColor, rect, note: note || `Highlighted area (page ${pg})` };
  highlights[key].push(hl);
  saveHighlights();
  drawHighlightOnCanvas(hlc, hl);
  renderHighlightsList();
  updateHighlightCount();
  statusEl.textContent = `✅ Highlight saved on page ${pg}!`;
  setTimeout(() => { statusEl.textContent = hlMode ? "✏ Highlight mode ON" : `✅ ${tab.pdfDoc.numPages} pages loaded`; }, 1500);
}

// ── Summary helpers ───────────────────────────────────────
function showLoader() {
  loader.classList.add("active");
  summScroll.style.display = "none";
  cacheTag.style.display   = "none";
}
function hideLoader() { loader.classList.remove("active"); }

function showSummary(text, fromCache) {
  hideLoader();
  summScroll.style.display = "block";
  cacheTag.style.display   = fromCache ? "inline" : "none";
  renderHighlighted(text);
}

function renderHighlighted(text) {
  summaryBox.innerHTML = "";
  let delay = 0;

  text.split("\n").forEach(line => {
    const trimmed = line.trim();

    // Blank line → small spacer
    if (!trimmed) {
      const sp = document.createElement("div");
      sp.style.height = "10px";
      summaryBox.appendChild(sp);
      return;
    }

    const el = document.createElement("div");
    el.style.cssText = `animation: sli .22s ease both; animation-delay: ${delay}ms`;
    delay += 25;

    // ## Heading
    if (trimmed.startsWith("## ") || trimmed.startsWith("# ")) {
      el.className   = "sum-heading";
      el.textContent = trimmed.replace(/^#+\s*/, "");

    // Bullet point
    } else if (/^[•\-\*]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      el.className  = "sum-bullet";
      const content = trimmed.replace(/^[•\-\*]\s*/, "").replace(/^\d+\.\s*/, "");
      el.innerHTML  = `<span class="sum-dot">•</span><span class="sum-content">${parseBold(content)}</span>`;

    // Fallback plain line
    } else {
      el.className  = "sum-plain";
      el.innerHTML  = parseBold(trimmed);
    }

    summaryBox.appendChild(el);
  });
}

// **bold** → highlighted span
function parseBold(text) {
  return text.replace(/\*\*(.+?)\*\*/g,
    '<mark class="sum-mark">$1</mark>');
}

// Keyword color palette — cycles through 6 colors
const KW_COLORS = [
  { text: "#7b68ee", bg: "rgba(123,104,238,0.12)", border: "rgba(123,104,238,0.25)" }, // purple
  { text: "#38bdf8", bg: "rgba(56,189,248,0.12)",  border: "rgba(56,189,248,0.25)"  }, // blue
  { text: "#34d399", bg: "rgba(52,211,153,0.12)",  border: "rgba(52,211,153,0.25)"  }, // green
  { text: "#fbbf24", bg: "rgba(251,191,36,0.12)",  border: "rgba(251,191,36,0.25)"  }, // yellow
  { text: "#f472b6", bg: "rgba(244,114,182,0.12)", border: "rgba(244,114,182,0.25)" }, // pink
  { text: "#fb923c", bg: "rgba(251,146,60,0.12)",  border: "rgba(251,146,60,0.25)"  }, // orange
];

function renderKeywords(keywords) {
  kwWrap.innerHTML = "";
  (keywords || []).forEach((word, i) => {
    const c   = KW_COLORS[i % KW_COLORS.length];
    const tag = document.createElement("span");
    tag.className   = "kw-tag";
    tag.textContent = word;
    tag.style.color       = c.text;
    tag.style.background  = c.bg;
    tag.style.borderColor = c.border;
    tag.style.animationDelay = `${i * 40}ms`;
    tag.style.animation = "sli .3s ease both";
    kwWrap.appendChild(tag);
  });
}

function flashPage() {
  pageFlash.classList.add("flash");
  setTimeout(() => pageFlash.classList.remove("flash"), 180);
}

// ── Navigation ────────────────────────────────────────────
document.getElementById("prev-page").addEventListener("click", () => {
  const tab = activeTab();
  if (!tab) return;
  if (tab.isDoc && tab.currentPage > 1) renderDocPage(tab.id, tab.currentPage - 1);
  else if (tab.pdfDoc && tab.currentPage > 1) renderPage(tab.currentPage - 1);
});
document.getElementById("next-page").addEventListener("click", () => {
  const tab = activeTab();
  if (!tab) return;
  if (tab.isDoc && tab.currentPage < tab.totalPages) renderDocPage(tab.id, tab.currentPage + 1);
  else if (tab.pdfDoc && tab.currentPage < tab.pdfDoc.numPages) renderPage(tab.currentPage + 1);
});
pageSlider.addEventListener("input", () => {
  const tab = activeTab();
  const val = parseInt(pageSlider.value);
  if (!tab || val === tab.currentPage) return;
  if (tab.isDoc) renderDocPage(tab.id, val);
  else renderPage(val);
});

// ── Copy ──────────────────────────────────────────────────
document.getElementById("copy-btn").addEventListener("click", () => {
  navigator.clipboard.writeText(summaryBox.innerText).then(() => {
    const btn = document.getElementById("copy-btn");
    btn.textContent = "✅ Copied!";
    setTimeout(() => btn.textContent = "📋 Copy Summary", 2000);
  });
});

// ── Export summaries ──────────────────────────────────────
function buildExportText(tabId) {
  const cache = summaryCache[tabId] || {};
  if (!Object.keys(cache).length) return null;
  let out = "PageWise AI — Summaries\n" + "=".repeat(40) + "\n\n";
  Object.keys(cache).sort((a,b)=>a-b).forEach(pg => {
    out += `PAGE ${pg}\n${"-".repeat(20)}\n${cache[pg]}\n\n`;
  });
  return out;
}

document.getElementById("export-btn").addEventListener("click", () => {
  const tab = activeTab();
  if (!tab) return;
  const text = buildExportText(tab.id);
  if (!text) { alert("Navigate some pages first."); return; }
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([text], { type: "text/plain" })),
    download: "pagewise-summary.txt"
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Summarize All ─────────────────────────────────────────
document.getElementById("summarize-all-btn").addEventListener("click", async () => {
  const tab = activeTab();
  if (!tab || !tab.pdfDoc) return;
  const modal = document.getElementById("all-pages-modal");
  const body  = document.getElementById("all-pages-body");
  modal.classList.add("open");
  body.innerHTML = `<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:30px">⏳ Processing ${tab.pdfDoc.numPages} pages...</div>`;
  const results = {};
  for (let pg = 1; pg <= tab.pdfDoc.numPages; pg++) {
    if (summaryCache[tab.id][pg]) {
      results[pg] = summaryCache[tab.id][pg];
    } else {
      const page = await tab.pdfDoc.getPage(pg);
      const tc   = await page.getTextContent();
      const text = tc.items.map(i => i.str).join(" ");
      textCache[tab.id][pg]    = text;
      const summary = await getSummary(text);
      summaryCache[tab.id][pg] = summary;
      results[pg] = summary;
    }
    body.innerHTML = "";
    Object.keys(results).sort((a,b)=>a-b).forEach(p => {
      const block = document.createElement("div");
      block.className = "page-block";
      block.innerHTML = `<div class="page-block-h">PAGE ${p}</div><div class="page-block-b">${results[p]}</div>`;
      body.appendChild(block);
    });
    if (pg < tab.pdfDoc.numPages) {
      const prog = Object.assign(document.createElement("div"), {
        style: "color:var(--text-muted);font-size:11.5px;text-align:center;padding:8px",
        textContent: `Processing page ${pg+1} of ${tab.pdfDoc.numPages}...`
      });
      body.appendChild(prog);
    }
  }
});

document.getElementById("export-all-btn").addEventListener("click", () => {
  const tab = activeTab();
  if (!tab) return;
  const text = buildExportText(tab.id);
  if (!text) return;
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([text], {type:"text/plain"})),
    download: "pagewise-all-summaries.txt"
  });
  a.click();
});

["close-all-modal","close-all-modal2"].forEach(id =>
  document.getElementById(id).addEventListener("click", () =>
    document.getElementById("all-pages-modal").classList.remove("open")));

// ── Add PDF modal ─────────────────────────────────────────
document.getElementById("add-tab-btn").addEventListener("click", () => {
  document.getElementById("add-pdf-modal").classList.add("open");
  document.getElementById("new-pdf-url").value = "";
  setTimeout(() => document.getElementById("new-pdf-url").focus(), 100);
});
document.getElementById("close-add-modal").addEventListener("click", () =>
  document.getElementById("add-pdf-modal").classList.remove("open"));
document.getElementById("open-new-pdf").addEventListener("click", () => {
  const url = document.getElementById("new-pdf-url").value.trim();
  if (!url) { alert("Please enter a PDF URL."); return; }
  document.getElementById("add-pdf-modal").classList.remove("open");
  createTab(url);
});
document.getElementById("new-pdf-url").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("open-new-pdf").click();
});

// ── Chat ──────────────────────────────────────────────────
async function askChat(question, context) {
  const config  = await getSettings();
  const tab     = activeTab();
  if (!tab) return "No PDF loaded.";

  tab._lastSourcePages = [tab.currentPage];

  // ── Call LLM ───────────────────────────────────────────────
  const modeNote = "Answer based ONLY on this page text.";

  if (config.backend === "groq") {
    try {
      const history  = chatHistory[tab.id] || [];
      const messages = [
        { role: "system", content: `${modeNote}\n\n${context.slice(0, 3500)}` },
        ...history.slice(-6).map(h => ([
          { role: "user",      content: h.user      },
          { role: "assistant", content: h.assistant }
        ])).flat(),
        { role: "user", content: question }
      ];
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.groqModel || "llama-3.1-8b-instant", messages, max_tokens: 600 })
      });
      const data = await res.json();
      return data.choices[0].message.content;
    } catch { return "❌ Groq chat failed."; }
  } else {
    try {
      const url = config.ollamaUrl || "http://localhost:5000";
      const res = await fetch(`${url}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, context, history: chatHistory[tab.id] || [] })
      });
      const data = await res.json();
      return data.answer;
    } catch { return "❌ Ollama server not running."; }
  }
}

function renderChatHistory(tabId) {
  const msgs = document.getElementById("chat-messages");
  const hist = chatHistory[tabId] || [];
  if (!hist.length) {
    msgs.innerHTML = `<div class="chat-empty"><div class="ei">💬</div><div>Ask anything about this page.<br>AI answers from the page content.</div></div>`;
    return;
  }
  msgs.innerHTML = "";
  hist.forEach(h => { appendBubble("user", h.user); appendBubble("ai", h.assistant); });
}

function appendBubble(role, text) {
  const msgs = document.getElementById("chat-messages");
  const empty = msgs.querySelector(".chat-empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = "bubble " + role;
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

document.getElementById("chat-send").addEventListener("click", sendChat);
document.getElementById("chat-input").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

async function sendChat() {
  const input    = document.getElementById("chat-input");
  const send     = document.getElementById("chat-send");
  const question = input.value.trim();
  if (!question) return;
  const tab = activeTab();
  if (!tab) return;
  
  // ── Get context based on RAG toggle ──────────────────────
  let context = "";
  const useRag = isRagMode && ragReady && tab.hasRagIndex;
  
  if (useRag) {
    const pdfKey = getPdfKeyForTab(tab);
    const retrieved = await RAG.retrieve(pdfKey, question, 4);
    context = RAG.buildContext(retrieved);
    tab._lastSourcePages = RAG.getSourcePages(retrieved);
  } else {
    context = textCache[tab.id]?.[tab.currentPage] || "";
    tab._lastSourcePages = [tab.currentPage];
  }
  
  input.value   = "";
  send.disabled = true;
  appendBubble("user", question);
  const thinking = appendBubble("ai", "⏳ thinking...");
  
  const answer = await askChat(question, context);
  thinking.remove();
  appendBubble("ai", answer);
  
  // ── Show source citations if RAG or multi-page ───────────
  if (tab._lastSourcePages?.length > 1 || useRag) {
    appendSourceCitation(tab._lastSourcePages);
  }
  
  chatHistory[tab.id].push({ user: question, assistant: answer });
  send.disabled = false;
}

function appendSourceCitation(pages) {
  const msgs = document.getElementById("chat-messages");
  const div  = document.createElement("div");
  div.className = "bubble-citation";
  div.innerHTML = `📄 Sources: ${pages.map(p =>
    `<span class="cite-page" data-page="${p}">p.${p}</span>`
  ).join(" ")}`;
  // Click page citation → jump to that page
  div.querySelectorAll(".cite-page").forEach(el => {
    el.addEventListener("click", () => {
      renderPage(parseInt(el.dataset.page));
      // Switch back to summary tab
      document.querySelectorAll(".panel-tab").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".panel-section").forEach(s => s.classList.remove("active"));
      document.querySelector("[data-panel='summary']").classList.add("active");
      document.getElementById("panel-summary").classList.add("active");
    });
  });
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

// ══════════════════════════════════════════════════════════
// FLASHCARD GENERATOR
// ══════════════════════════════════════════════════════════

const flashcardCache = {}; // { tabId: { pageNum: [{q, a}] } }
let fcCards      = [];     // current deck
let fcIndex      = 0;      // current card index
let fcFlipped    = false;

// ── Generate flashcards via AI ────────────────────────────
async function generateFlashcards(text, pageNum) {
  const config = await getSettings();
  const prompt = `Generate exactly 6 flashcards from this text for exam revision.
Return ONLY a valid JSON array, no explanation, no markdown, no backticks.
Format exactly like this: [{"q":"question here","a":"answer here"},{"q":"...","a":"..."}]

Text:
${text.slice(0, 2500)}`;

  if (config.backend === "groq") {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.groqModel || "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: "You are a flashcard generator. Always respond with ONLY a JSON array, nothing else." },
            { role: "user", content: prompt }
          ],
          max_tokens: 1000
        })
      });
      const data = await res.json();
      console.log("Groq flashcard raw:", data.choices?.[0]?.message?.content);
      return parseFlashcardJSON(data.choices[0].message.content);
    } catch (e) { console.error("Groq FC error:", e); return []; }

  } else {
    // Ollama — call the model directly via /api/generate, not the backend /chat
    try {
      const ollamaBase = (config.ollamaUrl || "http://localhost:11434").replace("localhost:5000", "localhost:11434");
      const model      = config.ollamaModel || "llama3.2:1b";

      const res = await fetch(`${ollamaBase}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: { temperature: 0.3 }
        })
      });
      const data = await res.json();
      console.log("Ollama flashcard raw:", data.response);
      return parseFlashcardJSON(data.response);
    } catch (e) {
      console.error("Ollama FC error:", e);
      // Fallback: try via backend server
      try {
        const url = config.ollamaUrl || "http://localhost:5000";
        const res = await fetch(`${url}/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: prompt })
        });
        const data = await res.json();
        console.log("Backend FC fallback raw:", data.summary);
        return parseFlashcardJSON(data.summary);
      } catch (e2) { console.error("Backend FC fallback error:", e2); return []; }
    }
  }
}

function parseFlashcardJSON(raw) {
  if (!raw) return [];

  // Strip markdown fences
  let clean = raw.replace(/```json|```/gi, "").trim();

  // Try direct parse
  try {
    const direct = JSON.parse(clean);
    if (Array.isArray(direct)) return direct.filter(c => c.q && c.a).slice(0, 8);
  } catch {}

  // Find [ ... ] block
  const start = clean.indexOf("[");
  const end   = clean.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const arr = JSON.parse(clean.slice(start, end + 1));
      if (Array.isArray(arr)) return arr.filter(c => c.q && c.a).slice(0, 8);
    } catch {}
  }

  // Regex: extract every {"q":"...","a":"..."} object individually
  const cards = [];
  const re = /\{\s*"q"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"a"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    cards.push({ q: m[1].replace(/\\"/g, '"'), a: m[2].replace(/\\"/g, '"') });
  }
  if (cards.length) return cards.slice(0, 8);

  console.error("Flashcard parse failed. Raw:", clean.slice(0, 400));
  return [];
}

// ── Trigger generation from Summary tab button ────────────
document.getElementById("generate-fc-btn")?.addEventListener("click", async () => {
  const tab = activeTab();
  if (!tab) return;
  const pageNum = tab.currentPage;
  const text    = textCache[tab.id]?.[pageNum] || "";

  if (!text || text.trim().length < 50) {
    alert("Not enough text on this page to generate flashcards.");
    return;
  }

  // Switch to flashcards tab
  switchToPanel("flashcards");

  // Check cache first
  if (!flashcardCache[tab.id]) flashcardCache[tab.id] = {};
  if (flashcardCache[tab.id][pageNum]) {
    loadDeck(flashcardCache[tab.id][pageNum], pageNum);
    return;
  }

  // Show loader
  showFcLoader(true);

  try {
    const cards = await generateFlashcards(text, pageNum);
    if (!cards.length) {
      showFcLoader(false);
      showFcEmpty("AI couldn't generate cards.\nTry a different page.");
      return;
    }
    flashcardCache[tab.id][pageNum] = cards;
    saveFcCache();
    loadDeck(cards, pageNum);
  } catch (err) {
    console.error("FC generation error:", err);
    showFcLoader(false);
    showFcEmpty("Generation failed. Check your AI settings.");
  }
});

// ── Load a deck into the UI ───────────────────────────────
function loadDeck(cards, pageNum) {
  fcCards   = cards;
  fcIndex   = 0;
  fcFlipped = false;

  showFcLoader(false);
  document.getElementById("fc-empty").style.display  = "none";
  document.getElementById("fc-stage").style.display  = "flex";
  document.getElementById("fc-footer").style.display = "flex";

  const tab = activeTab();
  document.getElementById("fc-page-badge").textContent = `Page ${pageNum}`;
  document.getElementById("fc-count-badge").textContent = `${cards.length} cards`;
  document.getElementById("fc-tab-count").textContent   = cards.length > 0 ? `${cards.length} ` : "";

  renderFcCard();
  renderFcDots();
}

// ── Render current card ───────────────────────────────────
function renderFcCard() {
  const card = fcCards[fcIndex];
  if (!card) return;

  document.getElementById("fc-question").textContent = card.q;
  document.getElementById("fc-answer").textContent   = card.a;

  // Reset flip
  fcFlipped = false;
  document.getElementById("fc-card").classList.remove("flipped");

  // Progress
  document.getElementById("fc-progress-text").textContent = `${fcIndex + 1} / ${fcCards.length}`;
  const pct = ((fcIndex + 1) / fcCards.length) * 100;
  document.getElementById("fc-progress-bar").style.width = pct + "%";

  // Nav buttons
  document.getElementById("fc-prev").disabled = fcIndex === 0;
  document.getElementById("fc-next").disabled = fcIndex === fcCards.length - 1;

  // Dots
  document.querySelectorAll(".fc-dot").forEach((d, i) => {
    d.classList.toggle("active", i === fcIndex);
  });
}

// ── Render dot indicators ─────────────────────────────────
function renderFcDots() {
  const wrap = document.getElementById("fc-dots");
  wrap.innerHTML = "";
  fcCards.forEach((_, i) => {
    const dot = document.createElement("div");
    dot.className = "fc-dot" + (i === fcIndex ? " active" : "");
    dot.addEventListener("click", () => { fcIndex = i; renderFcCard(); });
    wrap.appendChild(dot);
  });
}

// ── Flip card on click ────────────────────────────────────
document.getElementById("fc-card")?.addEventListener("click", () => {
  fcFlipped = !fcFlipped;
  document.getElementById("fc-card").classList.toggle("flipped", fcFlipped);
});

// ── Navigation ────────────────────────────────────────────
document.getElementById("fc-prev")?.addEventListener("click", () => {
  if (fcIndex > 0) { fcIndex--; renderFcCard(); }
});
document.getElementById("fc-next")?.addEventListener("click", () => {
  if (fcIndex < fcCards.length - 1) { fcIndex++; renderFcCard(); }
});

// Keyboard navigation (← →  space)
document.addEventListener("keydown", (e) => {
  const fcPanel = document.getElementById("panel-flashcards");
  if (!fcPanel?.classList.contains("active")) return;
  if (e.key === "ArrowRight" && fcIndex < fcCards.length - 1) { fcIndex++; renderFcCard(); }
  if (e.key === "ArrowLeft"  && fcIndex > 0)                  { fcIndex--; renderFcCard(); }
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    fcFlipped = !fcFlipped;
    document.getElementById("fc-card").classList.toggle("flipped", fcFlipped);
  }
});

// ── Regenerate ────────────────────────────────────────────
document.getElementById("fc-regen-btn")?.addEventListener("click", async () => {
  const tab = activeTab();
  if (!tab) return;
  const pageNum = tab.currentPage;
  // Clear cache for this page
  if (flashcardCache[tab.id]) delete flashcardCache[tab.id][pageNum];

  document.getElementById("fc-stage").style.display  = "none";
  document.getElementById("fc-footer").style.display = "none";
  showFcLoader(true);

  try {
    const text  = textCache[tab.id]?.[pageNum] || "";
    const cards = await generateFlashcards(text, pageNum);
    if (!cards.length) { showFcLoader(false); showFcEmpty("Couldn't generate cards."); return; }
    if (!flashcardCache[tab.id]) flashcardCache[tab.id] = {};
    flashcardCache[tab.id][pageNum] = cards;
    saveFcCache();
    loadDeck(cards, pageNum);
  } catch { showFcLoader(false); showFcEmpty("Generation failed."); }
});

// ── Export to Anki-compatible .txt ────────────────────────
document.getElementById("fc-export-btn")?.addEventListener("click", () => {
  if (!fcCards.length) return;
  const tab     = activeTab();
  const pdfName = getPdfKey() || "pagewise";
  const pageNum = tab?.currentPage || "?";

  // Anki format: Q[tab]A  (importable as Basic note type)
  let out = `#separator:tab\n#html:false\n#notetype:Basic\n`;
  out    += `#deck:PageWise - ${pdfName} - Page ${pageNum}\n\n`;
  fcCards.forEach(c => { out += `${c.q}\t${c.a}\n`; });

  const a = Object.assign(document.createElement("a"), {
    href:     URL.createObjectURL(new Blob([out], { type: "text/plain" })),
    download: `pagewise-flashcards-p${pageNum}.txt`
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Helpers ───────────────────────────────────────────────
function showFcLoader(show) {
  document.getElementById("fc-loader").style.display = show ? "flex" : "none";
  if (show) {
    document.getElementById("fc-stage").style.display  = "none";
    document.getElementById("fc-footer").style.display = "none";
    document.getElementById("fc-empty").style.display  = "none";
  }
}

function showFcEmpty(msg) {
  const el = document.getElementById("fc-empty");
  el.style.display = "flex";
  el.innerHTML     = `<div class="ei">🃏</div><div>${msg.replace(/\n/g, "<br>")}</div>`;
}

function switchToPanel(name) {
  document.querySelectorAll(".panel-tab").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".panel-section").forEach(s => s.classList.remove("active"));
  document.querySelector(`[data-panel='${name}']`).classList.add("active");
  document.getElementById(`panel-${name}`).classList.add("active");
}

// Persist flashcard cache across sessions
function saveFcCache() {
  // Store per pdfKey in chrome.storage
  const key = getPdfKey();
  if (!key) return;
  const tab = activeTab();
  if (!tab) return;
  const data = flashcardCache[tab.id] || {};
  chrome.storage.local.set({ [`fc_${key}`]: data });
}

async function loadFcCache(tabId, pdfKey) {
  return new Promise(resolve => {
    chrome.storage.local.get(`fc_${pdfKey}`, data => {
      if (data[`fc_${pdfKey}`]) flashcardCache[tabId] = data[`fc_${pdfKey}`];
      resolve();
    });
  });
}

// ══════════════════════════════════════════════════════════
// FULL DOCUMENT SUMMARY
// ══════════════════════════════════════════════════════════

document.getElementById("generate-full-summ-btn")?.addEventListener("click", async () => {
  const tab = activeTab();
  if (!tab) return;
  
  // Aggregate text from all pages
  const pages = textCache[tab.id];
  if (!pages || Object.keys(pages).length === 0) {
    alert("No text found. Wait for the document to finish loading, or ensure the file has text.");
    return;
  }
  
  const loader = document.getElementById("fs-loader");
  const scroll = document.getElementById("fs-scroll");
  const empty  = document.getElementById("fs-empty");
  const box    = document.getElementById("fs-summary-box");
  const footer = document.getElementById("fs-footer");

  empty.style.display  = "none";
  scroll.style.display = "none";
  footer.style.display = "none";
  loader.style.display = "flex";
  
  // Concatenate all text
  let fullText = "";
  for (let i = 1; i <= Object.keys(pages).length; i++) {
    if (pages[i]) fullText += `\n--- Page ${i} ---\n` + pages[i];
  }
  
  // Truncate to avoid blowing up context window (e.g. max ~15000 chars for small models)
  if (fullText.length > 20000) {
    fullText = fullText.slice(0, 20000) + "\n...[TRUNCATED_DUE_TO_LENGTH]...";
  }

  const prompt = `You are an expert analyst. Provide a comprehensive summary of the WHOLE document provided below.
Break your summary into logical sections using markdown headers (## Header).
Use bullet points for key takeaways. Keep it professional and concise.

DOCUMENT CONTENT:
${fullText}`;

  const config = await getSettings();
  
  if (config.backend === "groq") {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ 
          model: config.groqModel || "llama-3.1-8b-instant", 
          messages: [{ role: "user", content: prompt }], 
          max_tokens: 1500 
        })
      });
      const data = await res.json();
      const ans = data.choices[0].message.content;
      
      loader.style.display = "none";
      scroll.style.display = "block";
      footer.style.display = "flex";
      renderHighlightedSummary(ans, box);
    } catch (err) {
      loader.style.display = "none";
      empty.style.display  = "flex";
      empty.innerHTML = `<div class="ei">❌</div><div>Gross error generating full summary.<br>${err.message}</div>`;
    }
  } else {
    try {
      const url = config.ollamaUrl || "http://localhost:5000";
      const res = await fetch(`${url}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Fallback or old local API
        body: JSON.stringify({ question: prompt, context: prompt, history: [] })
      });
      const data = await res.json();
      
      loader.style.display = "none";
      scroll.style.display = "block";
      footer.style.display = "flex";
      renderHighlightedSummary(data.answer, box);
    } catch {
      loader.style.display = "none";
      empty.style.display  = "flex";
      empty.innerHTML = `<div class="ei">❌</div><div>Failed to reach Ollama backend. Ensure it is running.</div>`;
    }
  }
});

function renderHighlightedSummary(text, container) {
  container.innerHTML = "";
  let delay = 0;
  text.split("\n").forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) {
       const sp = document.createElement("div");
       sp.style.height = "10px";
       container.appendChild(sp);
       return;
    }
    const el = document.createElement("div");
    el.style.cssText = `animation: sli .22s ease both; animation-delay: ${delay}ms`;
    delay += 25;
    
    if (trimmed.startsWith("## ") || trimmed.startsWith("# ")) {
      el.className = "sum-heading";
      el.textContent = trimmed.replace(/^#+\s*/, "");
    } else if (/^[•\-\*]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      el.className  = "sum-bullet";
      const content = trimmed.replace(/^[•\-\*]\s*/, "").replace(/^\d+\.\s*/, "");
      el.innerHTML  = `<span class="sum-dot">•</span><span class="sum-content">${parseBold(content)}</span>`;
    } else {
      el.className  = "sum-plain";
      el.innerHTML  = parseBold(trimmed);
    }
    container.appendChild(el);
  });
}

document.getElementById("fs-copy-btn")?.addEventListener("click", () => {
  const t = document.getElementById("fs-summary-box")?.innerText || "";
  if (!t) return;
  navigator.clipboard.writeText(t);
  const btn = document.getElementById("fs-copy-btn");
  btn.textContent = "✅ Copied!";
  setTimeout(() => btn.textContent = "📋 Copy", 2000);
});

// ── Init ──────────────────────────────────────────────────
async function init() {
  // Init RAG engine
  if (typeof RAG !== "undefined") {
    RAG.init(updateRagStatus, updateRagReady, updateRagProgress);
  }

  await loadHighlights();

  const params  = new URLSearchParams(window.location.search);
  let fileUrl = params.get("file");
  if (fileUrl) {
    // Strip any accidental surrounding quotes
    fileUrl = fileUrl.replace(/^["']+|["']+$/g, "").trim();
    // Ensure proper file:/// format for local paths
    if (fileUrl.match(/^[A-Za-z]:\\/)) {
      fileUrl = "file:///" + fileUrl.replace(/\\/g, "/");
    }
    // Check if it's a non-PDF file
    const extMatch = fileUrl.match(/\.(docx|pptx|txt|md)(?:\?.*)?$/i);
    if (extMatch) {
      if (fileUrl.startsWith("file:///")) {
        statusEl.textContent = "Cannot load local MS Office file automatically.";
        alert("Chrome security policy blocks local non-PDF documents from loading automatically via URL. Please click the 📂 File button at the top left to manually select your " + extMatch[1].toUpperCase() + " file.");
        return;
      }
      statusEl.textContent = "📂 Fetching document...";
      fetch(fileUrl)
        .then(res => res.blob())
        .then(blob => {
          const fileName = decodeURIComponent(fileUrl.split("/").pop().split("?")[0]) || `document.${extMatch[1]}`;
          const file = new File([blob], fileName, { type: blob.type });
          openFileAsTab(file);
        })
        .catch(err => {
          console.error("Fetch error:", err);
          createTab(fileUrl);
        });
    } else {
      createTab(fileUrl);
    }
  } else {
    statusEl.textContent = "Open a document or use the 📂 File button to upload.";
  }
}

init();