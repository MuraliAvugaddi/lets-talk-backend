// 📚 Study material upload / list / compress (no real Cloudinary / DB)
const test = require("node:test");
const assert = require("node:assert/strict");

const cloud = require("../utils/cloudinary");
let uploaded = [];
let deleted = [];
cloud.uploadMaterialPdf = async (buf, name) => {
  uploaded.push(name);
  return { url: `https://cdn/${name}.pdf`, publicId: `pid_${name}_${uploaded.length}`, bytes: buf.length };
};
cloud.deleteFromCloudinary = async (id) => deleted.push(id);

const StudyMaterial = require("../Models/studyMaterial");
const db = [];
StudyMaterial.find = () => ({ sort: () => ({ lean: async () => db.map((d) => ({ ...d })) }) });
StudyMaterial.findOne = (q) => ({
  lean: async () => {
    const d = db.find((x) => x.language === q.language && x.stage === q.stage && x.day === q.day);
    return d ? { ...d } : null;
  },
});
StudyMaterial.findOneAndUpdate = (q, upd) => ({
  lean: async () => {
    let d = db.find((x) => x.language === q.language && x.stage === q.stage && x.day === q.day);
    if (!d) {
      d = { _id: `id${db.length + 1}`, ...upd.$setOnInsert, version: 0 };
      db.push(d);
    }
    Object.assign(d, upd.$set);
    d.version += upd.$inc.version;
    return { ...d };
  },
});

const ctrl = require("../Controllers/UserContollers/materialController");
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(1000, 65)]);

const call = (fn, req) =>
  new Promise((resolve) => {
    const res = {
      code: 200,
      status(c) {
        this.code = c;
        return this;
      },
      set() {
        return this;
      },
      json(b) {
        resolve({ code: this.code, body: b });
      },
    };
    fn({ io: null, user: { _id: "a1", name: "Admin" }, query: {}, body: {}, params: {}, ...req }, res);
  });

test("material: upload, replace (version 2, old file deleted), list by stage, rejects non-PDF", async () => {
  const a = await call(ctrl.uploadMaterial, {
    body: { language: "english", stage: "Stage 6", day: "Day 1", title: "Intro" },
    file: { buffer: PDF, originalname: "a.pdf" },
  });
  assert.equal(a.code, 200);
  assert.equal(a.body.material.version, 1);
  assert.equal(a.body.material.stage, "stage6");

  const b = await call(ctrl.uploadMaterial, {
    body: { language: "English", stage: "stage6", day: "1" },
    file: { buffer: PDF, originalname: "b.pdf" },
  });
  assert.equal(b.body.material.version, 2);
  assert.equal(b.body.material.title, "Intro"); // keeps the old title
  assert.equal(deleted.length, 1); // old Cloudinary file removed

  await call(ctrl.uploadMaterial, {
    body: { language: "Hindi", stage: "stage7", day: "3", title: "H" },
    file: { buffer: PDF, originalname: "c.pdf" },
  });
  const list = await call(ctrl.listMaterials, { query: { language: "English", stage: "stage6" } });
  assert.equal(list.body.materials.length, 1);
  const all = await call(ctrl.listMaterials, { query: {} });
  assert.equal(all.body.materials.length, 2);

  const bad = await call(ctrl.uploadMaterial, {
    body: { language: "English", stage: "stage6", day: "2" },
    file: { buffer: Buffer.from("hello not a pdf"), originalname: "x.pdf" },
  });
  assert.equal(bad.code, 400);
  const badDay = await call(ctrl.uploadMaterial, {
    body: { language: "English", stage: "stage6", day: "99" },
    file: { buffer: PDF },
  });
  assert.equal(badDay.code, 400);
});

test("pdf compressor never breaks an upload (no gs / small file → original)", async () => {
  const { compressPdf } = require("../utils/pdfCompress");
  const r = await compressPdf(PDF);
  assert.equal(r.compressed, false);
  assert.equal(r.buffer, PDF);
});
