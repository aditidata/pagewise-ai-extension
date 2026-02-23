// Add this helper at the top of viewer.js
async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get("pagewise_config", (data) => {
      resolve(data.pagewise_config || { backend: "ollama" });
    });
  });
}

// Replace your getSummary function
async function getSummary(text) {
  const config = await getSettings();

  if (config.backend === "groq") {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.groqKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: config.groqModel || "llama-3.1-8b-instant",
          messages: [{ role: "user", content: `Summarize into bullet points for exam revision. Each bullet starts with •\n\n${text.slice(0, 3000)}` }],
          max_tokens: 1000
        })
      });
      const data = await res.json();
      return data.choices[0].message.content;
    } catch (err) {
      console.error("Groq error:", err);
      return "❌ Groq API call failed.";
    }
  } else {
    try {
      const url = config.ollamaUrl || "http://localhost:5000";
      const res = await fetch(`${url}/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      const data = await res.json();
      return data.summary;
    } catch { return "❌ Ollama server not running."; }
  }
}

// Replace your getKeywords function
async function getKeywords(text) {
  const config = await getSettings();

  if (config.backend === "groq") {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.groqKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: config.groqModel || "llama-3.1-8b-instant",
          messages: [{ role: "user", content: `Extract 8 keywords. Return ONLY a JSON array. Example: ["word1","word2"]\n\n${text.slice(0, 1500)}` }],
          max_tokens: 100
        })
      });
      const data = await res.json();
      const raw   = data.choices[0].message.content;
      const match = raw.match(/\[.*?\]/s);
      return match ? JSON.parse(match[0]) : [];
    } catch { return []; }
  } else {
    try {
      const url = config.ollamaUrl || "http://localhost:5000";
      const res = await fetch(`${url}/keywords`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      const data = await res.json();
      return data.keywords || [];
    } catch { return []; }
  }
}
// ── State ─────────────────────────────────────────────────
const summaryCache = {};   // { tabId: { pageNum: summary } }
const textCache    = {};   // { tabId: { pageNum: pageText } }
const chatHistory  = {};   // { tabId: [{ user, assistant }] }
let tabs           = [];   // [{ id, label, url, pdfDoc, currentPage }]
let activeTabId    = null;
let isLight        = false;

// ── DOM ───────────────────────────────────────────────────
const statusEl   = document.getElementById("status");
const canvas     = document.getElementById("pdf-canvas");
const ctx        = canvas.getContext("2d");
const summaryBox = document.getElementById("summary-box");
const pageInfo   = document.getElementById("page-info");
const loader     = document.getElementById("loader");
const summScroll = document.getElementById("summary-scroll");
const cacheTag   = document.getElementById("cache-tag");
const pageSlider = document.getElementById("page-slider");
const kwWrap     = document.getElementById("keywords-wrap");
const pageFlash  = document.getElementById("page-flash");
const tabsWrap   = document.getElementById("tabs-wrap");

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

// ── Theme toggle ──────────────────────────────────────────
document.getElementById("theme-btn").addEventListener("click", () => {
  isLight = !isLight;
  document.documentElement.setAttribute("data-theme", isLight ? "light" : "dark");
  document.getElementById("theme-btn").textContent = isLight ? "🌑" : "🌙";
});

// ── Tab management ────────────────────────────────────────
function createTab(url) {
  const id    = Date.now().toString();
  const label = decodeURIComponent(url.split("/").pop() || "PDF").slice(0, 24);
  tabs.push({ id, label, url, pdfDoc: null, currentPage: 1 });
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
    el.innerHTML = `<span class="tab-name" title="${tab.label}">📄 ${tab.label}</span><span class="tab-x" data-id="${tab.id}">✕</span>`;
    el.addEventListener("click", e => {
      if (!e.target.classList.contains("tab-x")) switchTab(tab.id);
    });
    el.querySelector(".tab-x").addEventListener("click", e => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    tabsWrap.appendChild(el);
  });
}

function switchTab(id) {
  activeTabId = id;
  renderTabs();
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;

  // Reset chat
  renderChatHistory(id);

  if (tab.pdfDoc) {
    pageSlider.max   = tab.pdfDoc.numPages;
    pageSlider.value = tab.currentPage;
    renderPage(tab.currentPage);
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
    summaryBox.innerHTML = "";
    kwWrap.innerHTML = "";
    activeTabId = null;
    renderTabs();
    return;
  }
  switchTab(tabs[tabs.length - 1].id);
}

function activeTab() { return tabs.find(t => t.id === activeTabId); }

// ── Load PDF ──────────────────────────────────────────────
async function loadPDF(url, tabId) {
  statusEl.textContent = "📄 Loading PDF...";
  showLoader();
  try {
    const pdf = await pdfjsLib.getDocument(url).promise;
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    tab.pdfDoc = pdf;
    pageSlider.max   = pdf.numPages;
    pageSlider.value = 1;
    statusEl.textContent = `✅ Loaded — ${pdf.numPages} pages`;
    renderPage(1);
  } catch (err) {
    statusEl.textContent = "❌ Error loading PDF: " + err.message;
    hideLoader();
  }
}

// ── Render page ───────────────────────────────────────────
async function renderPage(pageNum) {
  const tab = activeTab();
  if (!tab || !tab.pdfDoc) return;

  tab.currentPage = pageNum;
  flashPage();
  statusEl.textContent = `📄 Rendering page ${pageNum}...`;
  pageInfo.textContent  = `${pageNum} / ${tab.pdfDoc.numPages}`;
  pageSlider.value      = pageNum;

  document.getElementById("prev-page").disabled = pageNum <= 1;
  document.getElementById("next-page").disabled = pageNum >= tab.pdfDoc.numPages;

  try {
    const page     = await tab.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.5 });
    canvas.height  = viewport.height;
    canvas.width   = viewport.width;
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Extract text
    const textContent = await page.getTextContent();
    const pageText    = textContent.items.map(i => i.str).join(" ");
    textCache[tab.id][pageNum] = pageText;
    statusEl.textContent = `✅ Page ${pageNum} of ${tab.pdfDoc.numPages}`;

    // Summary
    if (summaryCache[tab.id][pageNum]) {
      showSummary(summaryCache[tab.id][pageNum], true);
    } else {
      showLoader();
      const [summary, keywords] = await Promise.all([
        getSummary(pageText),
        getKeywords(pageText)
      ]);
      summaryCache[tab.id][pageNum] = summary;
      showSummary(summary, false);
      renderKeywords(keywords);
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = "❌ " + err.message;
    hideLoader();
  }
}

// ── Summary helpers ───────────────────────────────────────
function showLoader() {
  loader.classList.add("active");
  summScroll.style.display = "none";
  cacheTag.style.display   = "none";
}

function hideLoader() {
  loader.classList.remove("active");
}

function showSummary(text, fromCache) {
  hideLoader();
  summScroll.style.display = "block";
  cacheTag.style.display   = fromCache ? "inline" : "none";
  renderHighlighted(text);
}

function renderHighlighted(text) {
  summaryBox.innerHTML = "";
  text.split("\n").forEach((line, i) => {
    const span    = document.createElement("span");
    const trimmed = line.trim();
    span.className = (trimmed.startsWith("•") || trimmed.startsWith("-") || trimmed.startsWith("*") || /^\d+\./.test(trimmed))
      ? "hl-line" : "pl-line";
    span.style.animationDelay = `${i * 35}ms`;
    span.textContent = line || "\u00A0";
    summaryBox.appendChild(span);
  });
}

function renderKeywords(keywords) {
  kwWrap.innerHTML = "";
  (keywords || []).forEach(word => {
    const tag = document.createElement("span");
    tag.className   = "kw-tag";
    tag.textContent = word;
    kwWrap.appendChild(tag);
  });
}

function flashPage() {
  pageFlash.classList.add("flash");
  setTimeout(() => pageFlash.classList.remove("flash"), 180);
}

// ── API calls ─────────────────────────────────────────────

async function askChat(question, context) {
  const config = await getSettings();
  const tab = activeTab();
  if (!tab) return "No PDF loaded.";

  if (config.backend === "groq") {
    try {
      const history  = chatHistory[tab.id] || [];
      const messages = [
        { role: "system", content: `Answer based ONLY on this page:\n\n${context.slice(0, 2000)}` },
        ...history.map(h => ([
          { role: "user",      content: h.user      },
          { role: "assistant", content: h.assistant }
        ])).flat(),
        { role: "user", content: question }
      ];
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.groqKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: config.groqModel || "llama-3.1-8b-instant",
          messages,
          max_tokens: 500
        })
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

// ── Navigation ────────────────────────────────────────────
document.getElementById("prev-page").addEventListener("click", () => {
  const tab = activeTab();
  if (tab && tab.currentPage > 1) renderPage(tab.currentPage - 1);
});

document.getElementById("next-page").addEventListener("click", () => {
  const tab = activeTab();
  if (tab && tab.pdfDoc && tab.currentPage < tab.pdfDoc.numPages)
    renderPage(tab.currentPage + 1);
});

pageSlider.addEventListener("input", () => {
  const tab = activeTab();
  const val = parseInt(pageSlider.value);
  if (tab && val !== tab.currentPage) renderPage(val);
});

// ── Copy ──────────────────────────────────────────────────
document.getElementById("copy-btn").addEventListener("click", () => {
  navigator.clipboard.writeText(summaryBox.innerText).then(() => {
    const btn = document.getElementById("copy-btn");
    btn.textContent = "✅ Copied!";
    setTimeout(() => btn.textContent = "📋 Copy Summary", 2000);
  });
});

// ── Export ────────────────────────────────────────────────
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
  const tab  = activeTab();
  if (!tab) return;
  const text = buildExportText(tab.id);
  if (!text) { alert("Navigate some pages first."); return; }
  const blob = new Blob([text], { type: "text/plain" });
  const a    = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "pagewise-summary.txt" });
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
      results[pg]              = summary;
    }

    // Live update
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
  const tab  = activeTab();
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

// ── Multi-tab: Add PDF ────────────────────────────────────
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
function renderChatHistory(tabId) {
  const msgs = document.getElementById("chat-messages");
  const hist = chatHistory[tabId] || [];
  if (!hist.length) {
    msgs.innerHTML = `<div class="chat-empty"><div class="ei">💬</div><div>Ask anything about this page.<br>AI answers from the page content.</div></div>`;
    return;
  }
  msgs.innerHTML = "";
  hist.forEach(h => {
    appendBubble("user", h.user);
    appendBubble("ai", h.assistant);
  });
}

function appendBubble(role, text) {
  const msgs = document.getElementById("chat-messages");
  // Remove empty state
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
  const input = document.getElementById("chat-input");
  const send  = document.getElementById("chat-send");
  const question = input.value.trim();
  if (!question) return;

  const tab = activeTab();
  if (!tab) return;

  const context = textCache[tab.id]?.[tab.currentPage] || "";
  input.value = "";
  send.disabled = true;

  appendBubble("user", question);
  const thinking = appendBubble("thinking", "⏳ thinking...");

  const answer = await askChat(question, context);

  thinking.remove();
  appendBubble("ai", answer);

  chatHistory[tab.id].push({ user: question, assistant: answer });
  send.disabled = false;
}

// ── Init: load first tab from URL ─────────────────────────
const params  = new URLSearchParams(window.location.search);
const fileUrl = params.get("file");

if (fileUrl) {
  createTab(fileUrl);
} else {
  statusEl.textContent = "❌ No PDF URL found.";
}