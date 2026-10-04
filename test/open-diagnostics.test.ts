// lsp_diagnostics against servers that only analyze opened documents (typescript-language-server,
// kotlin-lsp): the tool must open the file itself and wait for (or pull) a report, never answer
// "clean" from an empty cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { LspManager, nativeTypeScriptServers } from "../src/lsp-manager.js";
import { FileSync } from "../src/file-sync.js";
import { createDiagnosticsTool } from "../src/tools/diagnostics.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-lsp-opened.mjs", import.meta.url));

async function runDiagnostics(env: Record<string, string>): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "pi-lsp-open-"));
  writeFileSync(join(dir, "bad.ts"), "BAD\n");
  writeFileSync(join(dir, "good.ts"), "ok\n");
  const mgr = new LspManager(dir, { typescript: { command: process.execPath, args: [FAKE], env } });
  const sync = new FileSync(mgr);
  (mgr as any).setDocumentOpener?.((path: string, client: any) => (sync as any).ensureOpen(path, client));
  const tool = createDiagnosticsTool(mgr);
  const call = async (path: string) => {
    const r = await tool.execute("t", { path }, undefined as never, undefined as never, undefined as never);
    return (r.content[0] as { text: string }).text;
  };
  try {
    // First call starts the server; wait until it is up, as an agent retrying would.
    await call("bad.ts");
    for (let i = 0; i < 100 && !mgr.getRunningClient("typescript"); i++) await sleep(50);
    assert.ok(mgr.getRunningClient("typescript"), "fake server did not start");
    return [await call("bad.ts"), await call("good.ts")];
  } finally {
    await mgr.shutdownAll();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("push-only server: the tool opens the file and waits for its report", { timeout: 20_000 }, async () => {
  const [bad, good] = await runDiagnostics({});
  assert.match(bad, /fake type error/);
  assert.equal(good, "No diagnostics (clean).");
});

test("pull-capable server: the tool requests textDocument/diagnostic", { timeout: 20_000 }, async () => {
  const [bad, good] = await runDiagnostics({ FAKE_PULL: "1" });
  assert.match(bad, /fake type error/);
  assert.equal(good, "No diagnostics (clean).");
});

test("TypeScript 7 projects (no tsserver.js) use the project's native tsc --lsp", () => {
  const mk = (withTsserver: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lsp-ts7-"));
    mkdirSync(join(dir, "node_modules", "typescript", "lib"), { recursive: true });
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "typescript", "package.json"), "{}");
    writeFileSync(join(dir, "node_modules", ".bin", "tsc"), "");
    if (withTsserver) writeFileSync(join(dir, "node_modules", "typescript", "lib", "tsserver.js"), "");
    return dir;
  };
  const ts6 = mk(true);
  const ts7 = mk(false);
  try {
    assert.deepEqual(nativeTypeScriptServers(ts6), {});
    const native = nativeTypeScriptServers(ts7);
    assert.deepEqual(native.typescript, { command: join(ts7, "node_modules", ".bin", "tsc"), args: ["--lsp", "--stdio"] });
    assert.deepEqual(Object.keys(native).sort(), ["javascript", "javascriptreact", "typescript", "typescriptreact"]);
    // .pi-lsp.json still wins over the detected server.
    const custom = { command: "custom-ts", args: [] };
    const mgr = new LspManager(ts7, { typescript: custom });
    assert.deepEqual((mgr as any).serverConfigs.get("typescript"), custom);
    assert.equal((mgr as any).serverConfigs.get("javascript").command, join(ts7, "node_modules", ".bin", "tsc"));
  } finally {
    rmSync(ts6, { recursive: true, force: true });
    rmSync(ts7, { recursive: true, force: true });
  }
});
