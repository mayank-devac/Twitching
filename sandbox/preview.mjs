import { chromium } from "playwright";
await chromium.launchServer({
  host: "0.0.0.0",
  port: 9222,
  wsPath: process.env.PREVIEW_WS_PATH,
  headless: true,
  args: ["--disable-background-networking", "--dns-prefetch-disable"],
});
