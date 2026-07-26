// Browser-side, capability-scoped serial-log uploader.
// A console must be opened with #capture=<short-lived-token>; otherwise this
// class remains deliberately local-only and never contacts the relay.

export function captureTokenFromFragment(fragment) {
  if (!fragment || !fragment.startsWith("#")) return null;
  const token = new URLSearchParams(fragment.slice(1)).get("capture");
  return token && token.trim() ? token : null;
}

export class SerialCapture {
  constructor({endpoint, project, token, fetchFn = globalThis.fetch, onStatus = () => {}}) {
    this.endpoint = endpoint;
    this.project = project;
    this.token = token;
    this.fetchFn = fetchFn;
    this.onStatus = onStatus;
    this.enabled = Boolean(token);
    this.pending = "";
    this.timer = null;
    this.inFlight = null;
    this.maxQueuedChars = 64 * 1024;
  }

  enqueue(text) {
    if (!this.enabled || !text) return;
    this.pending = (this.pending + text).slice(-this.maxQueuedChars);
    if (this.pending.length >= 4096) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), 1000);
    }
  }

  async flush() {
    if (!this.enabled || !this.pending) return;
    if (this.inFlight) return this.inFlight;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const text = this.pending;
    this.pending = "";
    this.inFlight = this._post(text);
    try {
      await this.inFlight;
      this.onStatus("server capture active", "ok");
    } catch (error) {
      this.pending = (text + this.pending).slice(-this.maxQueuedChars);
      this.onStatus(`server capture paused: ${error.message}`, "err");
    } finally {
      this.inFlight = null;
    }
  }

  async _post(text) {
    const response = await this.fetchFn.call(globalThis, this.endpoint, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      keepalive: true,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({project: this.project, source: "web-serial", text}),
    });
    if (!response.ok) throw new Error(`relay HTTP ${response.status}`);
  }
}
