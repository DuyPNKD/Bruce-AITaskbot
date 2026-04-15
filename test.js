const express = require("express");
const app = express();

app.get("/", (req, res) => res.send("OK"));

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Test server chạy trên port ${PORT}`);
});

// Giữ server chạy
process.stdin.resume();
