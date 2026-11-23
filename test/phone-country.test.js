const test = require("node:test");
const assert = require("node:assert/strict");
const { countryCodeFor } = require("../utils/phoneCountry");

test("Indian mobiles stay +91", () => {
  for (const p of ["9876543210", "8123456789", "7000000000", "6300000000", "+91 98765 43210"]) {
    assert.equal(countryCodeFor(p), "91");
  }
});

test("10 digits starting 2-5 go to +1 (USA/Canada)", () => {
  assert.equal(countryCodeFor("2025550123"), "1");
  assert.equal(countryCodeFor("4155550100"), "1");
  assert.equal(countryCodeFor("5125550100"), "1");
});

test("OTP_COUNTRY_MAP overrides (US numbers that look Indian, other countries)", () => {
  process.env.OTP_COUNTRY_MAP = "6175550100=1, 7400123456=44, bad, 123=1";
  assert.equal(countryCodeFor("6175550100"), "1");
  assert.equal(countryCodeFor("7400123456"), "44");
  assert.equal(countryCodeFor("9876543210"), "91");
  delete process.env.OTP_COUNTRY_MAP;
});

test("OTP_AUTO_US=off keeps everything +91 unless mapped", () => {
  process.env.OTP_AUTO_US = "off";
  assert.equal(countryCodeFor("2025550123"), "91");
  delete process.env.OTP_AUTO_US;
});
