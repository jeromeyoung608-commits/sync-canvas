/** Tiny synchronous pub/sub. Every module talks through this, nobody imports a peer. */
export class EventBus {
  constructor() {
    this.handlers = new Map();
  }

  on(type, fn) {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(type, fn) {
    this.handlers.get(type)?.delete(fn);
  }

  emit(type, payload) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] handler for "${type}" threw`, err);
      }
    }
  }
}
