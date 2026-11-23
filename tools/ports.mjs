// Port allocation for a studio box. The public port (n) and the runtime (n+1) are the studio's identity and stay
// fixed. Providers take ports from n+2 upward and the seat terminal the next one after them, SKIPPING any port another
// process is already serving, so two studios on one machine (say a dev studio and an everyday one) run side by side
// instead of one refusing to start because its provider range ran into the other's ports. The guard in studio.mjs
// still checks every port before anything binds, so a race between allocation and bind is refused, not half-started.
export async function allocatePorts({ base, providers, wantSeat, inUse, scan = 200 }) {
  const taken = new Set([base, base + 1]);
  let next = base + 2;
  const nextFree = async () => {
    for (let i = 0; i < scan; i++, next++) {
      if (taken.has(next)) continue;
      if (await inUse(next)) continue; // someone else is serving it: step over, don't collide
      taken.add(next);
      return next++;
    }
    throw new Error(`no free port within ${scan} of ${base + 2}`);
  };
  const providerPorts = new Map();
  for (const pkg of providers) providerPorts.set(pkg, await nextFree());
  const seatPort = wantSeat ? await nextFree() : null;
  return { sdkPort: base + 1, providerPorts, seatPort };
}
