// =====================================================
// 🌍 Where an OTP SMS goes (the apps send only the last 10 digits typed)
//
//   Automatic:
//     • 6, 7, 8, 9 …        → 🇮🇳 India (+91)
//     • 2, 3, 4, 5 …        → 🇺🇸🇨🇦 USA / Canada (+1)   (no Indian mobile starts with these)
//   Every other country → add the number ONCE in api.env (then: docker restart letsspeak-api):
//     OTP_COUNTRY_MAP=<what the student types>=<country code>[-<number to send>] , …
//     6175550100=1              🇺🇸 US number that starts with 6–9
//     7400123456=44             🇬🇧 UK  (student types 07400 123456 → app keeps 7400123456)
//     0501234567=971            🇦🇪 UAE (leading 0 is removed → +971 501234567)
//     0412345678=61             🇦🇺 Australia → +61 412345678
//     1511234567=49             🇩🇪 Germany (01511 234567)
//     6581234567=65-81234567    🇸🇬 Singapore: typed 65 8123 4567 → send +65 81234567
//   A number that is neither automatic nor in the list is refused with a clear message
//   (no SMS is wasted on a wrong country).
// =====================================================
const ten = (p) => String(p || "").replace(/\D/g, "").slice(-10);

const overrides = () => {
  const m = new Map();
  for (const part of String(process.env.OTP_COUNTRY_MAP || "").split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = ten(part.slice(0, i));
    const [ccRaw, numRaw] = part.slice(i + 1).split("-");
    const cc = String(ccRaw || "").replace(/\D/g, "");
    const num = String(numRaw || "").replace(/\D/g, "");
    if (key.length !== 10 || cc.length < 1 || cc.length > 3) continue;
    const number = num || key.replace(/^0+/, ""); // national number without the trunk 0
    if (number.length < 4 || number.length > 14) continue;
    m.set(key, { cc, number });
  }
  return m;
};

/** → { cc: "91", number: "9876543210" } or null when the country is unknown */
const destinationFor = (phone) => {
  const n = ten(phone);
  if (n.length !== 10) return null;
  const o = overrides().get(n);
  if (o) return o;
  if (/^[6-9]/.test(n)) return { cc: "91", number: n };
  if (/^[2-5]/.test(n) && String(process.env.OTP_AUTO_US || "on").toLowerCase() !== "off") {
    return { cc: "1", number: n };
  }
  return null;
};

/** kept for older code: "91" | "1" | other code, or "" when unknown */
const countryCodeFor = (phone) => (destinationFor(phone) || { cc: "" }).cc;

module.exports = { destinationFor, countryCodeFor };
