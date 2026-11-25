export class AutosaveController {
  #timer;
  #running;
  #latest;
  #pending = false;
  #blocked = false;
  #disposed = false;

  constructor({ save, debounceMs = 800, onState }) {
    this.save = save;
    this.debounceMs = debounceMs;
    this.onState = onState;
  }

  change(draft) {
    if (this.#disposed) return;
    this.#latest = draft;
    this.#pending = true;
    clearTimeout(this.#timer);
    if (this.#blocked || this.#running) return;
    this.onState('pending');
    this.#timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  flush() {
    clearTimeout(this.#timer);
    if (this.#disposed || this.#blocked) return Promise.resolve(false);
    if (this.#running) return this.#running;
    if (!this.#pending) return Promise.resolve(true);
    this.#running = this.#drain().finally(() => { this.#running = undefined; });
    return this.#running;
  }

  async #drain() {
    this.onState('saving');
    while (this.#pending && !this.#disposed) {
      const draft = this.#latest;
      this.#pending = false;
      try {
        await this.save(draft);
      } catch (error) {
        if (this.#disposed) return false;
        this.#blocked = true;
        this.#pending = true;
        this.onState(error?.code === 'BLOG_STALE_REVISION' ? 'conflict' : 'error', error);
        return false;
      }
    }
    if (this.#disposed) return false;
    this.onState('saved');
    return true;
  }

  retry() {
    this.#blocked = false;
    return this.flush();
  }

  dispose() {
    this.#disposed = true;
    this.#latest = undefined;
    this.#pending = false;
    clearTimeout(this.#timer);
  }
}
