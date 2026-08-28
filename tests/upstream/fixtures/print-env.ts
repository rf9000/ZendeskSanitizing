// Minimal helper spawned by tests/upstream/child.spawn.test.ts: dumps this process's env as JSON
// to stdout so the parent test can assert on exactly what a real spawned child receives.
console.log(JSON.stringify(process.env));
