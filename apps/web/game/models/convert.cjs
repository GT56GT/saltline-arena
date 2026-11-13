const { chromium } = require("playwright");
const fs = require("fs");
(async () => {
  const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl"] });
  const p = await b.newPage();
  p.on("pageerror", (e) => console.log("ERR", e.message));
  await p.goto("http://127.0.0.1:8812/convert.html"); await p.waitForFunction(() => window.ready);
  const r = await p.evaluate(() => window.convert());
  console.log(r.log.join("\n"));
  fs.writeFileSync("operator.glb", Buffer.from(r.b64, "base64"));
  console.log("glb bytes", fs.statSync("operator.glb").size);
  await b.close();
})();
