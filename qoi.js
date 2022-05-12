// reference: https://qoiformat.org/qoi-specification.pdf

const QOI_HEADER_MAGIC = new Uint8Array(
  "qoif".split("").map((char) => char.codePointAt(0))
);

// magic + u32 width + u32 height + u8 channels + u8 colorspace
const QOI_HEADER_SIZE = QOI_HEADER_MAGIC.length + (32 + 32 + 8 + 8) / 8;

const CHANNELS_RGB = 3;
const CHANNELS_RGBA = 4;
const SUPPORTED_CHANNEL_MODES = [CHANNELS_RGB, CHANNELS_RGBA];

const COLORSPACE_SRGB = 0;
const COLORSPACE_LINEAR = 1;
const SUPPORTED_COLORSPACE_MODES = [COLORSPACE_SRGB, COLORSPACE_LINEAR];

const OP_RGB_BITS = 0b11111110;
const OP_RGBA_BITS = 0b11111111;
const OP_INDEX_BITS = 0b00000000;
const OP_DIFF_BITS = 0b01000000;
const OP_LUMA_BITS = 0b10000000;
const OP_RUN_BITS = 0b11000000;

const OP_NONE_ID = -1;
const OP_HEAD_ID = -2;
const OP_RGB_ID = 1;
const OP_RGBA_ID = 2;
const OP_INDEX_ID = 3;
const OP_DIFF_ID = 4;
const OP_LUMA_ID = 5;
const OP_RUN_ID = 6;

const INDEX_ARRAY_SIZE = 64;

/**
 * @param {Uint8Array} buffer
 * @returns {{ width: number, height: number, channels: number, colorspace: number }}
 */
function parseQoiHeaderBytes(buffer) {
  if (!QOI_HEADER_MAGIC.every((byte, i) => buffer[i] === byte)) {
    throw new Error("QOI header magic bytes do not match");
  }

  const width =
    (buffer[4] << 24) | (buffer[5] << 16) | (buffer[6] << 8) | buffer[7];
  const height =
    (buffer[8] << 24) | (buffer[9] << 16) | (buffer[10] << 8) | buffer[11];

  const channels = buffer[12];
  if (!SUPPORTED_CHANNEL_MODES.includes(channels)) {
    throw new Error("Unrecognised channels mode in header", channels);
  }
  const colorspace = buffer[13];
  if (!SUPPORTED_COLORSPACE_MODES) {
    throw new Error("Unrecognised colorsace mode in header", colorspace);
  }

  return { width, height, channels, colorspace };
}

/**
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Promise<{ width: number, height: number, pixels: Uint8ClampedArray }>}
 */
async function getQoiPixelData(stream) {
  const reader = stream.getReader();

  let seenHeader = false;
  const headerBuffer = new Uint8Array(QOI_HEADER_SIZE);
  let headerBufferOffset = 0;

  let width;
  let height;
  let channels;
  let colorspace;

  /** @type {Uint8ClampedArray} */
  let pixels;
  let pixelOffset = 0;

  let lastPixel = new Uint8ClampedArray([0, 0, 0, 255]);
  const indexValues = new Uint8ClampedArray(INDEX_ARRAY_SIZE * 4);

  let op = OP_HEAD_ID;
  const opBuffer = new Uint8ClampedArray(4);
  let opOffset = 0;

  const log = [];

  for (
    let result = await reader.read();
    !result.done;
    result = await reader.read()
  ) {
    const bytes = result.value;

    for (const byte of bytes) {
      if (op === OP_NONE_ID) log.push("");
      log.push(
        `BYTE   hex=${byte.toString(16).padStart(2, "0")} bin=${byte
          .toString(2)
          .padStart(8, "0")}`
      );

      if (!seenHeader) {
        headerBuffer[headerBufferOffset] = byte;
        headerBufferOffset++;

        if (headerBufferOffset !== 14) continue;

        ({ width, height, channels, colorspace } =
          parseQoiHeaderBytes(headerBuffer));
        seenHeader = true;
        pixels = new Uint8ClampedArray(width * height * 4);
        log.push(
          `HEAD   width=${width} height=${height} channels=${channels} colorspace=${colorspace}`
        );
        op = OP_NONE_ID;
        continue;
      }

      if (pixelOffset >= pixels.length) {
        const trailerOffset = pixelOffset - pixels.length;

        if (
          (trailerOffset < 7 && byte !== 0) ||
          (trailerOffset === 7 && byte !== 1) ||
          trailerOffset > 7
        ) {
          throw new Error("Trailer bytes mismatch");
        }

        log.push(`TAIL   offset=${trailerOffset}`);

        pixelOffset++;
        continue;
      }

      if (op === OP_NONE_ID) {
        if (byte === OP_RGB_BITS) op = OP_RGB_ID;
        if (byte === OP_RGBA_BITS) op = OP_RGBA_ID;

        if (op === OP_NONE_ID) {
          const twoBitTag = byte & 0b11000000;
          if (twoBitTag === OP_INDEX_BITS) op = OP_INDEX_ID;
          if (twoBitTag === OP_DIFF_BITS) op = OP_DIFF_ID;
          if (twoBitTag === OP_LUMA_BITS) op = OP_LUMA_ID;
          if (twoBitTag === OP_RUN_BITS) op = OP_RUN_ID;
        }
      }

      if (op === OP_RGB_ID) {
        if (opOffset > 0) opBuffer[opOffset - 1] = byte;
        opOffset++;
        if (opOffset <= 3) continue;

        opBuffer[3] = lastPixel[3];
        lastPixel.set(opBuffer);
        pixels.set(lastPixel, pixelOffset);
        pixelOffset += 4;

        log.push(
          `RGB    r=${lastPixel[0]} g=${lastPixel[1]} b=${lastPixel[2]}`
        );
      }

      if (op === OP_RGBA_ID) {
        if (opOffset > 0) opBuffer[opOffset - 1] = byte;
        opOffset++;
        if (opOffset <= 4) continue;

        lastPixel.set(opBuffer);
        pixels.set(lastPixel, pixelOffset);
        pixelOffset += 4;

        log.push(
          `RGBA   r=${lastPixel[0]} g=${lastPixel[1]} b=${lastPixel[2]} a=${lastPixel[3]}`
        );
      }

      if (op === OP_INDEX_ID) {
        const index = (byte & 0b00111111) << 2;
        lastPixel.set(indexValues.slice(index, index + 4));
        pixels.set(lastPixel, pixelOffset);

        log.push(`INDEX  i=${index >> 2}`);

        pixelOffset += 4;
      }

      if (op === OP_DIFF_ID) {
        const diffRed = -2 + ((byte & 0b00110000) >> 4);
        const diffGreen = -2 + ((byte & 0b00001100) >> 2);
        const diffBlue = -2 + (byte & 0b00000011);

        log.push(`DIFF   r=${diffRed} g=${diffGreen} b=${diffBlue}`);

        lastPixel[0] = ((lastPixel[0] + diffRed) | 0x100) & 0xff;
        lastPixel[1] = ((lastPixel[1] + diffGreen) | 0x100) & 0xff;
        lastPixel[2] = ((lastPixel[2] + diffBlue) | 0x100) & 0xff;

        pixels.set(lastPixel, pixelOffset);
        pixelOffset += 4;
      }

      if (op === OP_LUMA_ID) {
        if (opOffset === 0) {
          opBuffer[0] = byte & 0b00111111;
          opOffset++;
          continue;
        }

        const diffGreen = -32 + opBuffer[0];

        const diffRed = diffGreen + (-8 + ((byte & 0b11110000) >> 4));
        const diffBlue = diffGreen + (-8 + (byte & 0b00001111));

        log.push(`LUMA   r=${diffRed} g=${diffGreen} b=${diffBlue}`);

        lastPixel[0] = ((lastPixel[0] + diffRed) | 0x100) & 0xff;
        lastPixel[1] = ((lastPixel[1] + diffGreen) | 0x100) & 0xff;
        lastPixel[2] = ((lastPixel[2] + diffBlue) | 0x100) & 0xff;

        pixels.set(lastPixel, pixelOffset);
        pixelOffset += 4;
      }

      if (op === OP_RUN_ID) {
        log.push(`RUN    length=${(byte & 0b00111111) + 1}`);

        for (
          let runLength = (byte & 0b00111111) + 1;
          runLength !== 0;
          runLength--
        ) {
          pixels.set(lastPixel, pixelOffset);
          pixelOffset += 4;
        }
      }

      const index =
        (lastPixel[0] * 3 +
          lastPixel[1] * 5 +
          lastPixel[2] * 7 +
          lastPixel[3] * 11) %
        64;
      indexValues.set(lastPixel, index << 2);

      log.push(
        `STORE  i=${index} r=${lastPixel[0]} g=${lastPixel[1]} b=${lastPixel[2]} a=${lastPixel[3]}`
      );

      op = OP_NONE_ID;
      opBuffer.fill(0);
      opOffset = 0;
    }
  }

  return { width, height, pixels, log };
}
