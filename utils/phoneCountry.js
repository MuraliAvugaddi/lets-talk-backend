// =====================================================
// 🌍 Which country an OTP goes to (the apps only send 10 digits)
//
//   • Indian mobiles always start with 6, 7, 8 or 9 → +91
//   • 10 digits starting with 2, 3, 4 or 5 can't be Indian → USA / Canada (+1)
//   • Foreign numbers starting with 6–9 (e.g. US 617…, 718…, 917…) → add them in api.env:
//       OTP_COUNTRY_MAP=6175550100=1,9175550123=1,7400123456=44
//     (number=country code, comma separated; restart the api after a change)
// =====================================================
const ten = (p) => String(p || "").replace(/\D/g, "").slice(-10);

const overrides = () => {
  const m = new Map();
  for (const part of String(process.env.OTP_COUNTRY_MAP || "").split(",")) {
    const [p, cc] = part.trim().split("=");
    const n = ten(p);
    const c = String(cc || "").replace(/\D/g, "");
    if (n.length === 10 && c.length >= 1 && c.length <= 3) m.set(n, c);
  }
  return m;
};

/** "91" | "1" | other country code (digits only) */
const countryCodeFor = (phone) => {
  const n = ten(phone);
  const o = overrides().get(n);
  if (o) return o;
  if (/^[2-5]\d{9}$/.test(n) && String(process.env.OTP_AUTO_US || "on").toLowerCase() !== "off") return "1";
  return "91";
};

module.exports = { countryCodeFor };
