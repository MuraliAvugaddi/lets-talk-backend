// 🌍 OTP destination for every kind of number the student app can send (10 digits)
const test = require("node:test");
const assert = require("node:assert/strict");
const { destinationFor, countryCodeFor } = require("../utils/phoneCountry");

const MAP = [
  "6175550100=1",          // 🇺🇸 US number that starts with 6
  "9175550123=1",          // 🇺🇸 US (917 New York)
  "7400123456=44",         // 🇬🇧 UK
  "0501234567=971",        // 🇦🇪 UAE
  "0412345678=61",         // 🇦🇺 Australia
  "1511234567=49",         // 🇩🇪 Germany
  "6581234567=65-81234567",// 🇸🇬 Singapore (8-digit number)
  "0551234567=966",        // 🇸🇦 Saudi Arabia
  "0612345678=33",         // 🇫🇷 France
  "0212345678=1",          // weird but valid entry
  "9123456789=974-33123456", // 🇶🇦 Qatar 8-digit, typed like an Indian number
  "bad, =1, 123=1, 98765=999-1, 9876543210=1234", // all ignored (invalid)
].join(",");

test.beforeEach(() => { process.env.OTP_COUNTRY_MAP = MAP; delete process.env.OTP_AUTO_US; });
test.afterEach(() => { delete process.env.OTP_COUNTRY_MAP; });

test("🇮🇳 India: 6/7/8/9 → +91, number unchanged", () => {
  for (const p of ["9876543210", "8123456789", "7000000000", "6300000000", "+91 98765 43210", "09876543210"]) {
    assert.deepEqual(destinationFor(p), { cc: "91", number: p.replace(/\D/g, "").slice(-10) });
  }
});

test("🇺🇸🇨🇦 USA / Canada: 2/3/4/5 → +1 automatically", () => {
  for (const p of ["2025550123", "3105550100", "4155550100", "5125550100", "+1 (416) 555-0199"]) {
    assert.equal(destinationFor(p).cc, "1");
  }
  assert.equal(destinationFor("+1 (416) 555-0199").number, "4165550199");
});

const cases = [
  ["🇺🇸 US starting 6", "6175550100", "1", "6175550100"],
  ["🇺🇸 US 917", "917-555-0123", "1", "9175550123"],
  ["🇬🇧 UK (typed 07400 123456)", "07400123456", "44", "7400123456"],
  ["🇦🇪 UAE (leading 0 removed)", "050 123 4567", "971", "501234567"],
  ["🇦🇺 Australia", "0412 345 678", "61", "412345678"],
  ["🇩🇪 Germany (typed 01511 234567)", "01511234567", "49", "1511234567"],
  ["🇸🇬 Singapore (number given)", "65 8123 4567", "65", "81234567"],
  ["🇸🇦 Saudi Arabia", "0551234567", "966", "551234567"],
  ["🇫🇷 France", "06 12 34 56 78", "33", "612345678"],
  ["🇶🇦 Qatar (looks Indian, mapped)", "9123456789", "974", "33123456"],
];
for (const [name, typed, cc, number] of cases) {
  test(`${name} → +${cc} ${number}`, () => assert.deepEqual(destinationFor(typed), { cc, number }));
}

test("map wins over India for a mapped 6–9 number; others stay India", () => {
  assert.equal(countryCodeFor("6175550100"), "1");
  assert.equal(countryCodeFor("6175550101"), "91");
});

test("invalid map entries are ignored, not crashing", () => {
  assert.equal(countryCodeFor("9876543210"), "91"); // "9876543210=1234" (4-digit code) ignored
});

test("unknown foreign number (starts 0 or 1, not mapped) → null (refused, no SMS)", () => {
  assert.equal(destinationFor("0509999999"), null);
  assert.equal(destinationFor("1234567890"), null);
  assert.equal(destinationFor("12345"), null);
});

test("OTP_AUTO_US=off → 2–5 numbers need the map too", () => {
  process.env.OTP_AUTO_US = "off";
  assert.equal(destinationFor("2025550123"), null);
});
