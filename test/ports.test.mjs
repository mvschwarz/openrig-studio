import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { allocatePorts } from "../tools/ports.mjs";

test("providers step over ports another studio is serving; the seat terminal comes after them", async () => {
  const busy = new Set([9320, 9321, 9322]); // another studio's public, runtime and first provider port
  const r = await allocatePorts({
    base: 9310,
    providers: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"],
    wantSeat: true,
    inUse: async (p) => busy.has(p),
  });
  const ports = [...r.providerPorts.values()];
  assert.equal(r.sdkPort, 9311);
  assert.deepEqual(ports, [9312, 9313, 9314, 9315, 9316, 9317, 9318, 9319, 9323, 9324, 9325]);
  assert.ok(!ports.some((p) => busy.has(p)));
  assert.equal(r.seatPort, 9326);
  assert.equal(new Set([...ports, r.seatPort]).size, ports.length + 1, "no port given twice");
});

test("nothing busy: the old layout exactly (n+2… for providers, then the terminal)", async () => {
  const r = await allocatePorts({
    base: 9440,
    providers: ["x", "y"],
    wantSeat: true,
    inUse: async () => false,
  });
  assert.deepEqual([...r.providerPorts.values(), r.seatPort], [9442, 9443, 9444]);
  assert.equal(
    (
      await allocatePorts({
        base: 9440,
        providers: ["x"],
        wantSeat: false,
        inUse: async () => false,
      })
    ).seatPort,
    null,
  );
});

test("against a REAL listener: the occupied port is skipped", async () => {
  const srv = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const busyPort = srv.address().port;
  const inUse = (p) =>
    new Promise((resolve) => {
      const s = net.connect(p, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
  try {
    const r = await allocatePorts({ base: busyPort - 2, providers: ["a"], wantSeat: false, inUse });
    assert.notEqual(r.providerPorts.get("a"), busyPort);
  } finally {
    srv.close();
  }
});
