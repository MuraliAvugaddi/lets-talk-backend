// 🔬 Reads a Node CPU profile and prints where the backend spent its time
//   node scripts/loadtest/profile-top.js /tmp/prof/CPU.....cpuprofile
const fs = require("fs");
const file = process.argv[2];
const p = JSON.parse(fs.readFileSync(file, "utf8"));
const nodes = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map();
const pkg = new Map();
let total = 0;
p.samples.forEach((id, i) => {
  const dt = p.timeDeltas[i] || 0;
  total += dt;
  const cf = nodes.get(id).callFrame;
  const url = cf.url || "";
  const where = url.includes("node_modules/")
    ? url.split("node_modules/")[1].split("/")[0]
    : url
    ? url.replace(/^.*\/app\//, "").replace(/^file:\/\//, "")
    : cf.functionName || "(native)";
  pkg.set(where, (pkg.get(where) || 0) + dt);
  const key = `${cf.functionName || "(anonymous)"}  ${where}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) || 0) + dt);
});
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
console.log(`\n🔬 Backend CPU profile (${(total / 1e6).toFixed(1)} s recorded)`);
console.log("— by package / file —");
for (const [k, v] of top(pkg, 15)) console.log(`${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
console.log("— by function —");
for (const [k, v] of top(self, 20)) console.log(`${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
