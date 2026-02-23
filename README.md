# 📘 PageWise AI — Local AI PDF Summarizer Chrome Extension

> Read smarter. Every page, instantly summarized — privately on your machine or via Groq cloud.

![PageWise AI](icons/icon128.png)

PageWise AI is a Chrome extension that summarizes PDF documents **page by page**, extracts keywords, and lets you **chat with your document** using AI. Choose between a **locally running LLM (Ollama)** for full privacy or **Groq API** for instant cloud-powered summaries — no setup required.

---

## ✨ Features

- 🧠 **Page-by-page AI summaries** — navigate your PDF and get an instant summary of each page
- 💬 **Chat with your PDF** — ask questions about the current page, AI answers from the content only
- 🔑 **AI keyword extraction** — key terms highlighted per page
- ⚙️ **Dual backend support** — switch between Groq API (cloud) and Ollama (local) from settings
- 📂 **Multi-PDF tab support** — open and switch between multiple PDFs at once
- ⚡ **Summarize All** — batch summarize every page with live progress
- 💾 **Summary caching** — revisit pages instantly without re-calling the model
- ⬇️ **Export summaries** — download all summaries as a `.txt` file
- 🌙 **Dark / Light mode** — toggle between themes
- 🔒 **100% local option** — with Ollama, no data ever leaves your machine

---

## 🖥️ Screenshot

| Feature | Description |
|---|---|
| Split-screen viewer | PDF on left, AI summary on right |
| Chat panel | Ask questions, get answers from page content |
| Settings page | Switch between Groq and Ollama backends |

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Chrome Extension | Manifest V3, JavaScript |
| PDF Rendering | PDF.js |
| Backend (Ollama mode) | Node.js + Express |
| Cloud AI | Groq API (llama-3.1-8b-instant) |
| Local AI | Ollama (llama3.2:1b) |
| Storage | Chrome Storage API |
| Fonts | Sora + JetBrains Mono |

---

## 🚀 Quick Start

### Option A — Groq API (Recommended, No Setup)

1. Get a **free Groq API key** at [console.groq.com](https://console.groq.com)
2. Install the extension (see below)
3. Click extension icon → ⚙️ Settings → select **Groq** → paste API key → Save
4. Open any local PDF in Chrome and click the extension

No terminal, no server, no installs needed.

---

### Option B — Ollama (Local, Private)

#### Prerequisites
- [Node.js](https://nodejs.org)
- [Ollama](https://ollama.ai)

#### Steps

**1. Clone the repo**
```bash
git clone https://github.com/YOUR_USERNAME/pagewise-ai-extension.git
cd pagewise-ai-extension
```

**2. Pull the AI model**
```bash
ollama pull llama3.2:1b
```

**3. Start the backend server**
```bash
cd backend
npm install
node server.js
```

You should see:
```
🚀 PageWise AI server running on http://localhost:5000
   Endpoints: /summarize  /keywords  /chat
```

**4. Load the extension in Chrome**
1. Go to `chrome://extensions`
2. Enable **Developer Mode** (top right)
3. Click **Load Unpacked**
4. Select the root `pagewise-ai-extension/` folder

**5. Configure settings**
- Click extension icon → ⚙️ Settings → select **Ollama** → Save

---

## ⚙️ Settings Page

The settings page lets you switch between backends:

```
AI Backend:
  ○ Groq API  — fast, free API key, works for anyone
  ● Ollama    — local, private, no internet needed
```

- **Groq:** Enter your free API key from console.groq.com
- **Ollama:** Make sure `node server.js` and `ollama serve` are running

---

## 📁 Project Structure

```
pagewise-ai-extension/
├── backend/
│   ├── server.js          # Express API (/summarize, /keywords, /chat)
│   └── package.json
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── pdfjs/
│   ├── pdf.min.js
│   └── pdf.worker.min.js
├── background.js
├── content.js
├── manifest.json
├── popup.html / popup.js
├── settings.html / settings.js   # Backend switcher UI
├── styles.css
├── viewer.html                    # Split-screen UI
└── viewer.js                      # Core logic
```

---

## 🔌 Backend API Endpoints

The local backend exposes 3 endpoints on `http://localhost:5000` (Ollama mode only):

### `POST /summarize`
```json
{ "text": "page content here..." }
```
Returns bullet-point summary for exam revision.

### `POST /keywords`
```json
{ "text": "page content here..." }
```
Returns array of 8 key terms.

### `POST /chat`
```json
{
  "question": "What is this page about?",
  "context": "page content here...",
  "history": []
}
```
Returns answer grounded in page content only.

---

## 🔒 Privacy

| Mode | Privacy |
|---|---|
| Ollama | ✅ 100% local — no data leaves your machine |
| Groq | ⚠️ Text sent to Groq's servers — see [Groq Privacy Policy](https://groq.com/privacy-policy/) |

---

## 🗺️ Roadmap

- [x] Page-by-page AI summaries
- [x] Chat with PDF
- [x] Dual backend (Groq + Ollama)
- [x] Multi-PDF tab support
- [x] Dark / Light mode
- [x] Export summaries
- [ ] Chrome Web Store / Edge Add-ons publish
- [ ] Highlight keywords directly on PDF canvas
- [ ] Auto-start backend (no manual server needed)
- [ ] User-selectable Groq models
- [ ] Save chat history per document
- [ ] Firefox support

---

## 🤝 Contributing

Contributions are welcome!

1. Fork the repo
2. Create a branch: `git checkout -b feature/your-feature`
3. Commit: `git commit -m "feat: add your feature"`
4. Push: `git push origin feature/your-feature`
5. Open a Pull Request

---

## 📄 License

MIT License — free to use, modify, and distribute.

---

## 👨‍💻 Author

Built by **Aditi** — [@aditidata](https://github.com/aditidata)

*Started as a frustrated student's exam-week project. Turned into something real.*

---

⭐ If this helped you study, please star the repo — it means a lot!
