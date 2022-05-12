const worker = new Worker("./worker.js", { type: "module" });

/** @type {HTMLInputElement} */
const fileInput = document.getElementById("file");

fileInput.form.addEventListener("submit", (event) => {
  event.preventDefault();
});

/** @type {HTMLCanvasElement} */
const canvas = document.getElementById("canvas");
const context = canvas.getContext("bitmaprenderer");

worker.addEventListener("message", (event) => {
  canvas.width = event.data.width;
  canvas.height = event.data.height;
  context?.transferFromImageBitmap(event.data);
});

fileInput.addEventListener("change", (event) => {
  if (!fileInput.files || fileInput.files.length === 0) {
    return;
  }

  const file = fileInput.files.item(0);
  worker.postMessage(file);
});
