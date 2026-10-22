// 2,000 students at once must not mean 2,000 Stream "get call" requests.
process.env.JWT_SECRET = "test_secret_that_is_definitely_longer_than_32_chars";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-used";
const test = require("node:test");
const assert = require("node:assert/strict");
const { _internal } = require("../Controllers/UserContollers/streamController");

test("2,000 students checking one class → 1 Stream request", async () => {
  let gets = 0;
  const call = { get: async () => { gets++; await new Promise((r) => setTimeout(r, 20)); return { call: { ended_at: null, custom: {} } }; } };
  const results = await Promise.all(Array.from({ length: 2000 }, () => _internal.readCallState(call, "english_stage1_seca_class_test")));
  assert.equal(gets, 1);
  assert.ok(results.every((r) => r.started && !r.ended));
  await _internal.readCallState(call, "english_stage1_seca_class_test"); // still cached
  assert.equal(gets, 1);
});

test("class not started yet (404) is cached briefly, not an error", async () => {
  let gets = 0;
  const call = { get: async () => { gets++; const e = new Error("nf"); e.metadata = { responseCode: 404 }; throw e; } };
  const a = await Promise.all(Array.from({ length: 300 }, () => _internal.readCallState(call, "hindi_stage2_class_test")));
  assert.equal(gets, 1);
  assert.ok(a.every((r) => !r.started && !r.ended));
});

test("other Stream errors are not cached", async () => {
  let gets = 0;
  const call = { get: async () => { gets++; throw new Error("rate limited"); } };
  await assert.rejects(_internal.readCallState(call, "x_err"));
  await assert.rejects(_internal.readCallState(call, "x_err"));
  assert.equal(gets, 2);
});
