// =====================================================
// 🗜 PDF COMPRESSOR (in the middle: admin upload → compress → Cloudinary)
//
// Uses Ghostscript ("gs") when it is installed on the server: images inside
// the PDF are shrunk to a good phone-reading quality (≈150 dpi). Usually
// 40–80 % smaller → faster downloads for students + less Cloudinary usage.
//   • gs not installed / fails / result not smaller → the ORIGINAL is used
//     (upload never breaks because of compression)
//   • install once on the server:  apk add ghostscript   (Alpine)
//                               or apt-get install -y ghostscript (Debian)
// =====================================================
const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

let gsChecked = null; // true / false after the first check

const hasGhostscript = () =>
  new Promise((resolve) => {
    if (gsChecked !== null) return resolve(gsChecked);
    execFile("gs", ["--version"], { timeout: 5000 }, (err) => {
      gsChecked = !err;
      if (!gsChecked) console.warn("ℹ️ Ghostscript (gs) not installed — PDFs are uploaded without compression.");
      resolve(gsChecked);
    });
  });

/**
 * @param {Buffer} input original PDF
 * @returns {Promise<{ buffer: Buffer, compressed: boolean }>}
 */
const compressPdf = async (input) => {
  if (!Buffer.isBuffer(input) || input.length < 200 * 1024) return { buffer: input, compressed: false }; // < 200 KB: not worth it
  if (!(await hasGhostscript())) return { buffer: input, compressed: false };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdfz-"));
  const src = path.join(dir, "in.pdf");
  const out = path.join(dir, "out.pdf");
  try {
    await fs.writeFile(src, input);
    await new Promise((resolve, reject) =>
      execFile(
        "gs",
        [
          "-sDEVICE=pdfwrite",
          "-dCompatibilityLevel=1.5",
          "-dPDFSETTINGS=/ebook", // 150 dpi images — sharp on phones
          "-dDetectDuplicateImages=true",
          "-dCompressFonts=true",
          "-dNOPAUSE",
          "-dQUIET",
          "-dBATCH",
          `-sOutputFile=${out}`,
          src,
        ],
        { timeout: 120000 },
        (err) => (err ? reject(err) : resolve())
      )
    );
    const result = await fs.readFile(out);
    // keep it only when it is really smaller (some PDFs are already small)
    if (result.length > 1024 && result.length < input.length * 0.95) return { buffer: result, compressed: true };
    return { buffer: input, compressed: false };
  } catch (e) {
    console.warn("⚠️ PDF compression skipped:", e.message);
    return { buffer: input, compressed: false };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

module.exports = { compressPdf, hasGhostscript };
