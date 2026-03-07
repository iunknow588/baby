export class ChatWsClient {
  private ws?: WebSocket

  connect(url: string) {
    this.ws = new WebSocket(url)
  }

  send(payload: unknown) {
    this.ws?.send(JSON.stringify(payload))
  }

  close() {
    this.ws?.close()
  }
}
