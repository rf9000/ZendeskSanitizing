import { describe, expect, test } from "bun:test";
import { createRestartingUpstream } from "@/upstream/restart.ts";
import { createLogger } from "@/logging.ts";
import type { SpawnedUpstream } from "@/upstream/child.ts";

function fakeChild() {
  let closeCb: (() => void) | undefined;
  const child: SpawnedUpstream & { die: () => void; closed: boolean } = {
    closed: false,
    async listTools() { return [{ name: "get_ticket", inputSchema: {} }]; },
    async callTool(name) { return { content: [{ type: "text", text: `ok:${name}` }] }; },
    async close() { child.closed = true; },
    onUnexpectedClose(cb) { closeCb = cb; },
    die() { closeCb?.(); },
  };
  return child;
}

const logger = () => createLogger({ level: "error", sink: () => {} });

describe("createRestartingUpstream", () => {
  test("delegates to the child and restarts once after an unexpected close", async () => {
    const children = [fakeChild(), fakeChild()];
    let spawns = 0;
    const up = await createRestartingUpstream({ factory: async () => children[spawns++]!, backoffMs: 10, logger: logger() });
    expect(spawns).toBe(1);
    await up.callTool("get_ticket", {});
    children[0]!.die();
    const err = await up.callTool("get_ticket", {}).catch((e) => e); // during backoff
    expect(String(err.message)).toContain("upstream unavailable");
    await new Promise((r) => setTimeout(r, 50));
    expect(spawns).toBe(2);
    expect((await up.callTool("get_ticket", {})).content[0]).toEqual({ type: "text", text: "ok:get_ticket" });
  });

  test("stays dead after the second unexpected close", async () => {
    const children = [fakeChild(), fakeChild(), fakeChild()];
    let spawns = 0;
    const up = await createRestartingUpstream({ factory: async () => children[spawns++]!, backoffMs: 5, logger: logger() });
    children[0]!.die();
    await new Promise((r) => setTimeout(r, 30));
    children[1]!.die();
    await new Promise((r) => setTimeout(r, 30));
    expect(spawns).toBe(2);
    const err = await up.listTools().catch((e) => e);
    expect(String(err.message)).toContain("upstream unavailable");
  });

  test("close() disables restarts", async () => {
    const children = [fakeChild(), fakeChild()];
    let spawns = 0;
    const up = await createRestartingUpstream({ factory: async () => children[spawns++]!, backoffMs: 5, logger: logger() });
    await up.close();
    expect(children[0]!.closed).toBe(true);
    children[0]!.die(); // simulate the close event arriving after close()
    await new Promise((r) => setTimeout(r, 30));
    expect(spawns).toBe(1);
  });

  test("close() during an in-flight restart does not attach the child spawned by that restart", async () => {
    const children = [fakeChild(), fakeChild()];
    let spawns = 0;
    let release!: (c: SpawnedUpstream) => void;
    const gate = new Promise<SpawnedUpstream>((r) => { release = r; });
    const factory = async () => {
      spawns++;
      return spawns === 1 ? children[0]! : gate;
    };
    const up = await createRestartingUpstream({ factory, backoffMs: 10, logger: logger() });
    children[0]!.die();
    await new Promise((r) => setTimeout(r, 20)); // past backoff — the second factory() call is now in flight, awaiting `gate`
    await up.close();
    release(children[1]!);
    await Promise.resolve();
    await Promise.resolve();
    expect(children[1]!.closed).toBe(true);
    const err = await up.listTools().catch((e) => e);
    expect(String(err.message)).toContain("upstream unavailable");
  });
});
