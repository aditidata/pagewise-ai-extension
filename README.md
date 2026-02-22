# 📘 PageWise AI — Local AI PDF Summarizer Chrome Extension

> Read smarter. Every page, instantly summarized — privately, on your machine.

![PageWise AI](icons/icon128.png)
<img width="1914" height="961" alt="Screenshot 2026-02-23 000615" src="https://github.com/user-attachments/assets/c49354af-1834-4e96-9f19-880c0bf33dc8" />
<img width="1914" height="967" alt="Screenshot 2026-02-23 000658" src="https://github.com/user-attachments/assets/28ea2b1f-1e88-4770-9372-2590f3d021db" />
<img width="1920" height="1080" alt="Screenshot (488)" src="https://github.com/user-attachments/assets/2c1e77e5-9784-4ca4-bc24-3ada04f28a5f" />


PageWise AI is a Chrome extension that uses a **locally running LLM (Ollama)** to summarize PDF documents page by page, extract keywords, and let you **chat with your document** — all without sending any data to the cloud.

---

## ✨ Features

- 🧠 **Page-by-page AI summaries** — navigate your PDF and get an instant summary of each page
- 💬 **Chat with your PDF** — ask questions about the current page, AI answers from the content only
- 🔑 **AI keyword extraction** — key terms highlighted per page
- 📂 **Multi-PDF tab support** — open and switch between multiple PDFs at once
- ⚡ **Summarize All** — batch summarize every page with live progress
- 💾 **Summary caching** — revisit pages instantly without re-calling the model
- ⬇️ **Export summaries** — download all summaries as a `.txt` file
- 🌙 **Dark / Light mode** — toggle between themes
- 🔒 **100% local & private** — no data leaves your machine

---

## 🖥️ Demo

| Split-screen viewer | Chat with PDF |
|---|---|
| PDF on left, AI summary on right | Ask questions, get answers from page content |

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Chrome Extension | Manifest V3, JavaScript |
| PDF Rendering | PDF.js |
| Backend | Node.js + Express |
| Local AI | Ollama (llama3.2:1b) |
| Styling | CSS Variables, Sora + JetBrains Mono |

---

## 📦 Prerequisites

Before using PageWise AI, you need:

1. **Node.js** — [Download here](https://nodejs.org)
2. **Ollama** — [Download here](https://ollama.ai)
3. **llama3.2:1b model** pulled locally

---

## 🚀 Setup & Installation

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/pagewise-ai-extension.git
cd pagewise-ai-extension
```

### 2. Pull the AI model

```bash
ollama pull llama3.2:1b
```

### 3. Start the backend server

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

### 4. Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer Mode** (top right toggle)
3. Click **Load Unpacked**
4. Select the root `pagewise-ai-extension/` folder

### 5. Use it!

1. Open any PDF file in Chrome (local files work best — enable "Allow access to file URLs" in extension settings)
2. Click the **PageWise AI** icon in your toolbar
3. Click **Check Current Page**
4. The viewer opens with your PDF and AI summary side by side

---

## 📁 Project Structure

```
pagewise-ai-extension/
├── backend/
│   ├── server.js          # Express API (summarize, keywords, chat)
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
├── popup.html
├── popup.js
├── styles.css
├── viewer.html            # Split-screen UI
└── viewer.js              # Core logic (tabs, render, cache, chat)
```

---

## 🔌 API Endpoints

The local backend exposes 3 endpoints on `http://localhost:5000`:

### `POST /summarize`
Summarizes page text into bullet points.
```json
{ "text": "page content here..." }
```

### `POST /keywords`
Extracts 8 key terms from the page.
```json
{ "text": "page content here..." }
```

### `POST /chat`
Answers a question based on page context.
```json
{
  "question": "What is this page about?",
  "context": "page content here...",
  "history": []
}
```

---

## 🔒 Privacy

PageWise AI is **fully local**:
- No PDF content is sent to external servers
- All AI processing runs on `localhost` via Ollama
- No analytics, no tracking, no accounts

---

## 🗺️ Roadmap

- [ ] Chrome Web Store publish
- [ ] Auto-start backend (no manual server needed)
- [ ] Support for more Ollama models (user selectable)
- [ ] Highlight keywords directly on the PDF canvas
- [ ] Save chat history per document
- [ ] Firefox support

---

## 🤝 Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

1. Fork the repo
2. Create a branch: `git checkout -b feature/your-feature`
3. Commit: `git commit -m "feat: add your feature"`
4. Push: `git push origin feature/your-feature`
5. Open a Pull Request

---

## 📄 License

MIT License — feel free to use, modify, and distribute.

---

## 👨‍💻 Author

Built by **Aditi** — [@aditidata]([https://github.com/aditidata])

---

⭐ If you found this useful, please star the repo — it helps a lot!


