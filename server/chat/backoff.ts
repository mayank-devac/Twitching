// The 1s..30s doubling delay every chat reconnect and token refresh shares.
export class Backoff {
  private delay = 1000;
  reset() {
    this.delay = 1000;
  }
  next() {
    const delay = this.delay;
    this.delay = Math.min(30000, this.delay * 2);
    return delay;
  }
}
// One pending reconnect at a time, spaced by the shared backoff.
export class Reconnect {
  private timer?: ReturnType<typeof setTimeout>;
  private backoff = new Backoff();
  constructor(private connect: () => void) {}
  get pending() {
    return this.timer !== undefined;
  }
  connected() {
    this.backoff.reset();
  }
  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, this.backoff.next());
  }
  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
