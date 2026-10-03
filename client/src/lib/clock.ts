/**
 * NTP-style clock offset estimation: offset = serverTime - clientTime at the
 * moment the server stamped its reply, corrected for one-way network delay
 * by taking the lowest-RTT sample. serverNow() = Date.now() + offset.
 */
export class ClockSync {
  private offset = 0;
  private bestRtt = Infinity;

  sample(clientSendTime: number, serverTime: number, clientRecvTime: number) {
    const rtt = clientRecvTime - clientSendTime;
    if (rtt < this.bestRtt) {
      this.bestRtt = rtt;
      // Assume symmetric latency: server saw the request at clientSendTime + rtt/2.
      const estimatedServerNowAtRecv = serverTime + rtt / 2;
      this.offset = estimatedServerNowAtRecv - clientRecvTime;
    }
  }

  resetRttFloor() {
    // Allow re-converging after reconnect/offset drift, keep offset as a prior.
    this.bestRtt = Infinity;
  }

  now(): number {
    return Date.now() + this.offset;
  }

  getOffset() {
    return this.offset;
  }
}

export const clock = new ClockSync();
