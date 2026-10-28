import OBSWebSocket from "obs-websocket-js";
export class Obs {
  private client = new OBSWebSocket();
  private connected = false;
  constructor(
    private url: string,
    private password: string,
    private stopOnEnd: boolean,
    private status: (state: string) => void,
    private ended: () => void,
    private reconnecting: (active: boolean) => void,
  ) {
    this.client.on("ConnectionClosed", () => {
      this.connected = false;
      this.status("Disconnected");
      this.reconnecting(true);
    });
    this.client.on("StreamStateChanged", (event) => {
      // OBS auto-reconnects a dropped stream; a reconnecting output starts the watch,
      // a started/reconnected output clears it, and only a completed stop ends a show.
      if (
        event.outputState === "OBS_WEBSOCKET_OUTPUT_STARTED" ||
        event.outputState === "OBS_WEBSOCKET_OUTPUT_RECONNECTED"
      )
        this.reconnecting(false);
      else if (event.outputState.includes("RECONNECT")) this.reconnecting(true);
      // STARTING also has outputActive=false; only a completed stop ends a show.
      if (event.outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED") this.ended();
    });
  }
  async connect() {
    const url = new URL(this.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("OBS WebSocket must be local");
    await this.client.connect(this.url, this.password);
    this.connected = true;
    this.status("Connected");
    this.reconnecting(false);
  }
  async streaming() {
    if (!this.connected) await this.connect();
    return (await this.client.call("GetStreamStatus")).outputActive;
  }
  async readiness(overlayUrl: string) {
    if (!this.connected) await this.connect();
    const inputs = (
      await this.client.call("GetInputList", { inputKind: "browser_source" })
    ).inputs;
    let overlayConfigured = false;
    const expected = new URL(overlayUrl);
    for (const input of inputs) {
      const configured = await this.client.call("GetInputSettings", {
        inputName: String(input.inputName),
      });
      try {
        const url = new URL(String(configured.inputSettings.url));
        if (
          url.origin === expected.origin &&
          url.pathname === expected.pathname
        )
          overlayConfigured = true;
      } catch {
        /* Another browser source is not this overlay. */
      }
    }
    return { streaming: await this.streaming(), overlayConfigured };
  }
  async start() {
    if (!this.connected) await this.connect();
    if (await this.streaming()) return;
    await this.client.call("StartStream");
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      if (await this.streaming()) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("OBS did not confirm that streaming started");
  }
  async stop() {
    if (!this.stopOnEnd) return;
    if (!this.connected) await this.connect();
    if ((await this.client.call("GetStreamStatus")).outputActive)
      await this.client.call("StopStream");
    if ((await this.client.call("GetStreamStatus")).outputActive)
      throw new Error("OBS is still streaming");
    this.status("Stream stopped");
  }
  async close() {
    await this.client.disconnect();
  }
}
