const express = require("express");
const app = express();

app.get("/", (_, res) => {
  res.send("🟢 Server is alive");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Listening on ${PORT}`);
});
