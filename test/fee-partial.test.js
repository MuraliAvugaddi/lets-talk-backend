// 💰 Part payment: ₹1,500 of ₹2,700 → partial (₹1,200 left) → ₹1,200 later → paid
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_that_is_definitely_longer_than_32_chars";
const test = require("node:test");
const assert = require("node:assert/strict");

const notify = require("../utils/notify");
const sent = [];
notify.feePartial = (id, amount, balance, total) => sent.push(["partial", amount, balance, total]);
notify.feeApproved = () => sent.push(["paid"]);
notify.feeRejected = () => sent.push(["rejected"]);

const User = require("../Models/users");
const ID = "64b000000000000000000009";
const user = {
  _id: ID,
  feeStatus: "unpaid",
  feePaymentStatus: "pending_verification",
  feePaymentScreenshot: "https://img/1.jpg",
  feeLanguage: "English",
  feeAmountDue: 0,
  feeAmountPaid: 0,
  feePayments: [],
  async save() {},
};
User.findById = async () => user;

const { verifyFeePayment } = require("../Controllers/UserContollers/feeController");
const call = (body) =>
  new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    verifyFeePayment({ body: { userId: ID, ...body }, user: { _id: "a", name: "Admin" } }, res);
  });

test("half now, rest later", async () => {
  let r = await call({ status: "verified", amount: 1500, totalFee: 2700 });
  assert.equal(r.code, 200);
  assert.equal(user.feePaymentStatus, "partial");
  assert.equal(user.feeStatus, "unpaid");
  assert.equal(r.body.feeBalance, 1200);
  assert.deepEqual(sent.at(-1), ["partial", 1500, 1200, 2700]);

  // student uploads the rest → admin approves ₹1,200
  user.feePaymentStatus = "pending_verification";
  r = await call({ status: "verified", amount: 1200 });
  assert.equal(user.feePaymentStatus, "verified");
  assert.equal(user.feeStatus, "paid");
  assert.equal(r.body.feeAmountPaid, 2700);
  assert.equal(r.body.feeBalance, 0);
  assert.equal(user.feePayments.length, 2);
  assert.deepEqual(sent.at(-1), ["paid"]);
});

test("old admin app (no amount) = full payment; bad amount refused", async () => {
  Object.assign(user, { feeStatus: "unpaid", feePaymentStatus: "pending_verification", feeAmountDue: 0, feeAmountPaid: 0, feePayments: [] });
  assert.equal((await call({ status: "verified", amount: 0 })).code, 400);
  const r = await call({ status: "verified" });
  assert.equal(r.code, 200);
  assert.equal(user.feeStatus, "paid");
});
