# Pagewise AI RAG Toggle Fix - TODO Steps

## Plan Breakdown (Approved)
1. **✅ [DONE] Understanding**: Confirmed bug - rag-worker.js importScripts("../lib/transformers.min.js") fails in worker context → Xenova=null → model error → RAG broken.
2. **Edit rag-worker.js**: Fix import to absolute chrome.runtime.getURL(); add Xenova null-check.
3. **Test**: Reload extension → toggle RAG ON → verify model load (green badge), indexing, whole-doc chat (multi-page citations); OFF → current page.
4. **Cleanup**: Minor viewer.js auto-index + toggle persist (optional polish).
5. **Complete**.

## Progress
- [✅] Step 2: Edit rag-worker.js (importScripts fixed to chrome.runtime.getURL(); Xenova retry logic added)
- [ ] Step 3: Test & verify

