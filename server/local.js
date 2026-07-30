// Local all-in-one entry point.  ->  npm start
//
// Sets LOCAL_MODE in JS rather than as a shell env var so the same command works
// in cmd.exe, PowerShell and bash without needing cross-env. Then hands off to
// the normal server, which sees the flag and starts the scraper + auto-ingest.
process.env.LOCAL_MODE = "1";

// Local runs are single-user on localhost, so there's no reason to keep the
// service "awake" — that's a cloud-hosting concern only.
process.env.KEEPALIVE = process.env.KEEPALIVE || "off";

await import("./index.js");
