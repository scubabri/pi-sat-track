/**
 * Latest-click-wins guard for toggles saved on the server and echoed back in
 * a broadcast ("profiles", "state"). A broadcast sent before the server has
 * processed this client's latest "*-set" carries the old value; applying it
 * would flip the toggle back (e.g. Footprints off -> on within ~0.5 s: the
 * echo of "off" lands after the "on" click).
 *
 * Usage: seq = guard.begin(["footprints"]) right before sending
 * { type: "...-set", footprints, seq }. The server answers the sender with
 * { type: "set-ack", seq } after its broadcasts (one socket = in order), so
 * anything received after the ack already includes that set. While a field is
 * held, incoming values for it are ignored; on release (ack, or timeoutMs if
 * the ack never comes, e.g. reconnect) onRelease(fields) re-applies the latest
 * server payload. Seqs are shared by every guard on the page, so any ack for
 * seq S also covers this client's earlier sets.
 */
(function (root) {
  let seqCounter = 0;
  function createSetGuard(opts) {
    const o = opts || {};
    const timeoutMs = o.timeoutMs || 5000;
    const pending = new Map(); // field -> { seq, timer }
    const fire = (fields) => { if (fields.length && typeof o.onRelease === "function") o.onRelease(fields); };
    return {
      begin(fields) {
        const seq = ++seqCounter;
        for (const f of fields) {
          const prev = pending.get(f);
          if (prev) clearTimeout(prev.timer);
          const timer = setTimeout(() => {
            const p = pending.get(f);
            if (p && p.seq === seq) { pending.delete(f); fire([f]); }
          }, timeoutMs);
          pending.set(f, { seq, timer });
        }
        return seq;
      },
      ack(seq) {
        if (!Number.isFinite(seq)) return;
        const done = [];
        for (const [f, p] of pending) if (p.seq <= seq) { clearTimeout(p.timer); pending.delete(f); done.push(f); }
        fire(done);
      },
      held(f) { return pending.has(f); },
    };
  }
  root.createSetGuard = createSetGuard;
  if (typeof module !== "undefined" && module.exports) module.exports = { createSetGuard };
})(typeof window !== "undefined" ? window : globalThis);
