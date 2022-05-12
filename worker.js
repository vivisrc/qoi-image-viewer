self.importScripts("./qoi.js");

let debugLogUrl;

self.addEventListener("message", async (event) => {
  const stream = event.data.stream();

  const { width, height, pixels, log } = await getQoiPixelData(stream);
  const bitmap = await createImageBitmap(new ImageData(pixels, width, height));

  if (debugLogUrl) URL.revokeObjectURL(debugLogUrl);
  debugLogUrl = URL.createObjectURL(
    new Blob([log.join("\n")], { type: "text/plain" })
  );
  console.log("debug log:", debugLogUrl);

  self.postMessage(bitmap, [bitmap]);
});
