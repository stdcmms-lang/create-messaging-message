// Minimal RFC 6455 client built on node:http / node:https + node:net so test
// scripts can stay dependency-free. Implements only the surface used by the
// messaging tests: open / message / close / error events, send(string|Buffer),
// close(), readyState, and the static state constants.

import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { createHash, randomBytes } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export class WebSocket extends EventEmitter {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  constructor(url, opts = {}) {
    super();
    this.readyState = CONNECTING;
    this._socket = null;
    this._buf = Buffer.alloc(0);
    this._fragOp = 0;
    this._fragChunks = null;
    this._closeCode = undefined;
    this._closeReason = undefined;

    const u = new URL(url);
    const isTls = u.protocol === "wss:";
    const mod = isTls ? https : http;
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");

    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (isTls ? 443 : 80),
      path: (u.pathname || "/") + (u.search || ""),
      method: "GET",
      headers: {
        ...(opts.headers || {}),
        Host: u.host,
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
      },
    });

    const failConnect = (err) => {
      if (this.readyState === CLOSED) {
        return;
      }
      this.readyState = CLOSED;
      this._safeEmitError(err);
      this.emit("close", 1006, Buffer.alloc(0));
    };

    req.on("upgrade", (res, socket, head) => {
      if (res.headers["sec-websocket-accept"] !== expectedAccept) {
        socket.destroy();
        failConnect(new Error("invalid Sec-WebSocket-Accept"));
        return;
      }
      this._socket = socket;
      this.readyState = OPEN;
      socket.on("data", (chunk) => this._onData(chunk));
      socket.on("error", (err) => this._safeEmitError(err));
      socket.on("close", () => {
        if (this.readyState === CLOSED) {
          return;
        }
        this.readyState = CLOSED;
        this.emit(
          "close",
          this._closeCode ?? 1006,
          this._closeReason ?? Buffer.alloc(0),
        );
      });
      if (head && head.length) {
        this._onData(head);
      }
      this.emit("open");
    });

    req.on("response", (res) => {
      const status = res.statusCode;
      res.resume();
      req.destroy();
      failConnect(new Error(`unexpected server response: ${status}`));
    });

    req.on("error", failConnect);
    req.end();
  }

  _safeEmitError(err) {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    }
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      const frame = this._tryParse();
      if (!frame) {
        return;
      }
      this._handle(frame);
    }
  }

  _tryParse() {
    const b = this._buf;
    if (b.length < 2) {
      return null;
    }
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) {
        return null;
      }
      len = b.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) {
        return null;
      }
      const hi = b.readUInt32BE(off);
      const lo = b.readUInt32BE(off + 4);
      len = hi * 2 ** 32 + lo;
      off += 8;
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) {
        return null;
      }
      mask = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) {
      return null;
    }
    let payload = b.subarray(off, off + len);
    if (mask) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) {
        out[i] = payload[i] ^ mask[i & 3];
      }
      payload = out;
    }
    this._buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _handle({ fin, opcode, payload }) {
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) {
        this.emit("message", payload, opcode === 0x2);
      } else {
        this._fragOp = opcode;
        this._fragChunks = [payload];
      }
      return;
    }
    if (opcode === 0x0) {
      if (!this._fragChunks) {
        return;
      }
      this._fragChunks.push(payload);
      if (fin) {
        const data = Buffer.concat(this._fragChunks);
        const isBinary = this._fragOp === 0x2;
        this._fragOp = 0;
        this._fragChunks = null;
        this.emit("message", data, isBinary);
      }
      return;
    }
    if (opcode === 0x8) {
      let code = 1005;
      let reason = Buffer.alloc(0);
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.subarray(2);
      }
      this._closeCode = code;
      this._closeReason = reason;
      if (this.readyState === OPEN) {
        this.readyState = CLOSING;
        this._sendFrame(0x8, payload);
      }
      this._socket?.end();
      return;
    }
    if (opcode === 0x9) {
      this._sendFrame(0xa, payload);
      return;
    }
    // 0xa pong: ignore.
  }

  _sendFrame(opcode, payload) {
    const sock = this._socket;
    if (!sock || sock.destroyed) {
      return;
    }
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 0x80 | 127;
      header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    header[0] = 0x80 | opcode;
    const mask = randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) {
      masked[i] = payload[i] ^ mask[i & 3];
    }
    sock.write(Buffer.concat([header, mask, masked]));
  }

  send(data) {
    if (this.readyState !== OPEN) {
      throw new Error("WebSocket not open");
    }
    if (typeof data === "string") {
      this._sendFrame(0x1, Buffer.from(data, "utf8"));
    } else {
      this._sendFrame(0x2, Buffer.isBuffer(data) ? data : Buffer.from(data));
    }
  }

  close(code = 1000, reason = "") {
    if (this.readyState === CONNECTING) {
      this.readyState = CLOSING;
      this._socket?.destroy();
      return;
    }
    if (this.readyState !== OPEN) {
      return;
    }
    const r = Buffer.from(reason, "utf8");
    const payload = Buffer.allocUnsafe(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this._sendFrame(0x8, payload);
    this.readyState = CLOSING;
    this._socket?.end();
  }
}

export default WebSocket;
