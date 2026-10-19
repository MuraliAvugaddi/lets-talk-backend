// Run: npm test   (no database needed)
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_that_is_definitely_longer_than_32_chars";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:1/never-used";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// fake Cloudinary + DB (must be patched before the controller is loaded)
const cl = require("../utils/cloudinary");
const deleted = [];
cl.uploadBufferToCloudinary = async () => ({ secure_url: "https://res.cloudinary.com/x/new.jpg", public_id: "fees/new" });
cl.deleteFromCloudinary = async (id) => deleted.push(id);

const User = require("../Models/users");
const ID = "6ad1c36988b736c836a264ad";
const makeUser = (extra = {}) => ({
  _id: ID,
  feeStatus: "unpaid",
  feePaymentStatus: "not_submitted",
  feePaymentScreenshot: "",
  feeScreenshotPublicId: "",
  feeLanguage: "",
  englishAccess: { stage1: true },
  hindiAccess: { stage1: true },
  save: async function () { return this; },
  ...extra,
});
let current = makeUser();
User.findById = () => {
  const q = Promise.resolve(current);
  q.select = () => Promise.resolve(current);
  return q;
};

const express = require("express");
const app = express();
app.use(express.json());
app.use("/api/fee", require("../Routes/UserRoutes/feeRoute"));

const send = (server, method, path, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

// multipart body exactly like Flutter's http.MultipartFile.fromPath (no content type → octet-stream)
const multipart = (fields, file) => {
  const b = "----flutter" + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  parts.push(
    `--${b}\r\nContent-Disposition: form-data; name="screenshot"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`
  );
  const body = Buffer.concat([Buffer.from(parts.join("")), Buffer.from("fakejpegbytes"), Buffer.from(`\r\n--${b}--\r\n`)]);
  return { body, headers: { "Content-Type": `multipart/form-data; boundary=${b}`, "Content-Length": body.length } };
};

test("fee screenshot: phone upload (octet-stream) works, asks language, can be deleted", async () => {
  const server = app.listen(0);
  try {
    // 1) the old bug: Flutter sends application/octet-stream → must be accepted now
    current = makeUser();
    let m = multipart({ userId: ID, language: "Hindi" }, { name: "scaled_1000.jpg", type: "application/octet-stream" });
    let r = await send(server, "POST", "/api/fee/upload-fee-screenshot", m.body, m.headers);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(current.feePaymentStatus, "pending_verification");
    assert.equal(current.feeLanguage, "Hindi");
    assert.equal(current.feeScreenshotPublicId, "fees/new");
    assert.equal(r.body.canDelete, true);

    // 2) a PDF is still refused with a clear message
    m = multipart({ userId: ID }, { name: "receipt.pdf", type: "application/pdf" });
    r = await send(server, "POST", "/api/fee/upload-fee-screenshot", m.body, m.headers);
    assert.equal(r.status, 400);
    assert.match(r.body.message, /Only image files/);

    // 3) replacing removes the old Cloudinary file
    current = makeUser({ feePaymentStatus: "pending_verification", feePaymentScreenshot: "u", feeScreenshotPublicId: "fees/old" });
    m = multipart({ userId: ID, language: "English" }, { name: "a.png", type: "image/png" });
    r = await send(server, "POST", "/api/fee/upload-fee-screenshot", m.body, m.headers);
    assert.equal(r.status, 200);
    assert.ok(deleted.includes("fees/old"));
    assert.equal(current.feeLanguage, "English");

    // 4) status + delete
    r = await send(server, "GET", `/api/fee/my-status?userId=${ID}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.feePaymentStatus, "pending_verification");
    r = await send(server, "DELETE", `/api/fee/my-screenshot?userId=${ID}`);
    assert.equal(r.status, 200);
    assert.equal(current.feePaymentStatus, "not_submitted");
    assert.equal(current.feePaymentScreenshot, "");
    assert.ok(deleted.includes("fees/new"));

    // 5) a verified payment can't be deleted
    current = makeUser({ feeStatus: "paid", feePaymentStatus: "verified", feePaymentScreenshot: "u" });
    r = await send(server, "DELETE", `/api/fee/my-screenshot?userId=${ID}`);
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});

test("fee language: picked value, else guessed from enabled stages", () => {
  const { _internal } = require("../Controllers/UserContollers/feeController");
  assert.equal(_internal.feeLanguageOf({}, "hindi"), "Hindi");
  assert.equal(_internal.feeLanguageOf({ hindiAccess: { stage1: true }, englishAccess: {} }), "Hindi");
  assert.equal(_internal.feeLanguageOf({ englishAccess: { stage2: true } }), "English");
  const rows = _internal.withLanguage([{ name: "A", feeLanguage: "", hindiAccess: { stage1: true } }]);
  assert.equal(rows[0].feeLanguage, "Hindi");
  assert.equal(rows[0].hindiAccess, undefined);
});
