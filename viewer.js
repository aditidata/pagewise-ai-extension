const params = new URLSearchParams(window.location.search);
const fileUrl = params.get("file");

const statusEl = document.getElementById("status");
const canvas = document.getElementById("pdf-canvas");
const ctx = canvas.getContext("2d");

// Tell PDF.js where worker is
pdfjsLib.GlobalWorkerOptions.workerSrc = "pdfjs/pdf.worker.min.js";

if (!fileUrl) {
  statusEl.textContent = "❌ No PDF URL found.";
} else {
  statusEl.textContent = "📄 Loading PDF...";

  pdfjsLib
    .getDocument(fileUrl)
    .promise.then(async (pdf) => {
      statusEl.textContent = `✅ PDF loaded (Total pages: ${pdf.numPages})`;

      // 🔹 Get first page
      const page = await pdf.getPage(1);

      // 🔹 Render page
      const viewport = page.getViewport({ scale: 1.5 });
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      await page.render({
        canvasContext: ctx,
        viewport: viewport,
      }).promise;

      // 🔥 Extract text
      const textContent = await page.getTextContent();
      const textItems = textContent.items.map(item => item.str);
      const pageText = textItems.join(" ");

      console.log("📘 Extracted Page Text:");
      console.log(pageText);

      // show preview in UI
      const preview = pageText.slice(0, 200);
      statusEl.textContent += `\n🧠 Text extracted: "${preview}..."`;
    })
    .catch((err) => {
      console.error(err);
      statusEl.textContent = "❌ Error loading PDF: " + err.message;
    });
}