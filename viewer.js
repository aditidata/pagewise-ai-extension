const params = new URLSearchParams(window.location.search);
const fileUrl = params.get("file");

const statusEl = document.getElementById("status");
const canvas = document.getElementById("pdf-canvas");
const ctx = canvas.getContext("2d");

// 🔥 Tell PDF.js where worker is
pdfjsLib.GlobalWorkerOptions.workerSrc = "pdfjs/pdf.worker.min.js";

if (!fileUrl) {
  statusEl.textContent = "❌ No PDF URL found.";
} else {
  statusEl.textContent = "📄 Loading PDF...";

  pdfjsLib
    .getDocument(fileUrl)
    .promise.then((pdf) => {
      statusEl.textContent = `✅ PDF loaded (Total pages: ${pdf.numPages})`;

      return pdf.getPage(1);
    })
    .then((page) => {
      const viewport = page.getViewport({ scale: 1.5 });

      canvas.height = viewport.height;
      canvas.width = viewport.width;

      const renderContext = {
        canvasContext: ctx,
        viewport: viewport,
      };

      return page.render(renderContext).promise;
    })
    .catch((err) => {
      console.error(err);
      statusEl.textContent = "❌ Error loading PDF: " + err.message;
    });
}