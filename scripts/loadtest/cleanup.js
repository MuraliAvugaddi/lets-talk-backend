// 🧪 LOAD TEST — step 3: delete the test database (never the real one)
const mongoose = require("mongoose");
const uri = process.env.MONGO_URI || "";
if (!/loadtest/i.test(uri)) {
  console.error("❌ MONGO_URI must point to the 'loadtest' database");
  process.exit(1);
}
mongoose
  .connect(uri)
  .then(() => mongoose.connection.db.dropDatabase())
  .then(() => console.log("🧹 Test database deleted"))
  .catch((e) => console.error("❌", e.message))
  .finally(() => process.exit(0));
