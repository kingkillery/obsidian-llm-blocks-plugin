/**
 * Minimal WebSocket client built on Node.js net.Socket.
 *
 * Obsidian's Electron renderer uses Chromium's WebSocket, which sends
 * `Origin: app://obsidian.md`. The Codex app-server rejects that origin,
 * producing a silent code=1006 failure. Using net.Socket directly lets us
 * set `Origin: http://localhost` and bypass the restriction entirely.
 *
 * The public interface mirrors window.WebSocket closely enough that
 * CodexWebSocketClient can swap it in with minimal changes.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const netModule  = require('net')    as typeof import('net');
const cryptoMod  = require('crypto') as typeof import('crypto');

type ReadyState = 0 | 1 | 2 | 3;

export class NodeWebSocket {
	static readonly CONNECTING: 0 = 0;
	static readonly OPEN:       1 = 1;
	static readonly CLOSING:    2 = 2;
	static readonly CLOSED:     3 = 3;

	readonly CONNECTING: 0 = 0;
	readonly OPEN:       1 = 1;
	readonly CLOSING:    2 = 2;
	readonly CLOSED:     3 = 3;

	onopen:    (() => void) | null = null;
	onclose:   ((ev: { code: number; reason: string }) => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onerror:   (() => void) | null = null;

	private _readyState: ReadyState = 0;
	get readyState(): ReadyState { return this._readyState; }

	private socket: import('net').Socket | null = null;
	private headersDone  = false;
	private headerBuf    = '';
	private frameBuf     = Buffer.alloc(0);

	constructor(url: string) {
		const parsed = new URL(url);
		const host   = parsed.hostname;
		const port   = parseInt(parsed.port) || 80;
		const path   = (parsed.pathname || '/') + (parsed.search || '');

		const key = cryptoMod.randomBytes(16).toString('base64');
		const handshake = [
			`GET ${path} HTTP/1.1`,
			`Host: ${host}:${port}`,
			`Upgrade: websocket`,
			`Connection: Upgrade`,
			`Sec-WebSocket-Key: ${key}`,
			`Sec-WebSocket-Version: 13`,
			`Origin: http://localhost`,
			``,
			``,
		].join('\r\n');

		const sock = netModule.createConnection({ host, port }, () => {
			sock.write(handshake);
		});
		this.socket = sock;

		sock.on('data',  (chunk: Buffer)  => this.onData(chunk));
		sock.on('error', ()               => {
			this._readyState = 3;
			if (this.onerror)  this.onerror();
			if (this.onclose)  this.onclose({ code: 1006, reason: '' });
		});
		sock.on('close', () => {
			if (this._readyState !== 3) {
				this._readyState = 3;
				if (this.onclose) this.onclose({ code: 1006, reason: '' });
			}
		});
	}

	send(data: string): void {
		if (this._readyState !== 1 || !this.socket) return;
		this.socket.write(this.encodeFrame(0x1, Buffer.from(data, 'utf8')));
	}

	close(): void {
		if (this._readyState >= 2 || !this.socket) return;
		this._readyState = 2;
		try { this.socket.write(this.encodeFrame(0x8, Buffer.alloc(0))); } catch { /* noop */ }
		this.socket.destroy();
		this._readyState = 3;
	}

	// ── internals ──────────────────────────────────────────────────────────────

	private onData(chunk: Buffer): void {
		if (!this.headersDone) {
			// Accumulate as binary string to preserve all byte values.
			this.headerBuf += chunk.toString('binary');
			const end = this.headerBuf.indexOf('\r\n\r\n');
			if (end === -1) return;

			const firstLine   = this.headerBuf.slice(0, this.headerBuf.indexOf('\r\n'));
			const afterHdrs   = this.headerBuf.slice(end + 4);

			if (!firstLine.startsWith('HTTP/1.1 101')) {
				this._readyState = 3;
				if (this.onerror) this.onerror();
				if (this.onclose) this.onclose({ code: 1006, reason: 'Handshake rejected' });
				this.socket?.destroy();
				return;
			}

			this.headersDone = true;
			this._readyState  = 1;
			if (this.onopen) this.onopen();

			if (afterHdrs.length > 0) {
				this.frameBuf = Buffer.concat([
					this.frameBuf,
					Buffer.from(afterHdrs, 'binary'),
				]);
				this.parseFrames();
			}
			return;
		}

		this.frameBuf = Buffer.concat([this.frameBuf, chunk]);
		this.parseFrames();
	}

	private parseFrames(): void {
		while (this.frameBuf.length >= 2) {
			const b0     = this.frameBuf[0];
			const b1     = this.frameBuf[1];
			const opcode = b0 & 0x0f;
			const masked = (b1 & 0x80) !== 0;
			let payLen   = b1 & 0x7f;
			let offset   = 2;

			if (payLen === 126) {
				if (this.frameBuf.length < 4) return;
				payLen = this.frameBuf.readUInt16BE(2);
				offset = 4;
			} else if (payLen === 127) {
				if (this.frameBuf.length < 10) return;
				// Use the low 32 bits — payloads > 4 GB won't occur here.
				payLen = this.frameBuf.readUInt32BE(6);
				offset = 10;
			}

			const maskLen = masked ? 4 : 0;
			const total   = offset + maskLen + payLen;
			if (this.frameBuf.length < total) return;

			let payload = this.frameBuf.slice(offset + maskLen, total);
			if (masked) {
				const mask     = this.frameBuf.slice(offset, offset + 4);
				const unmasked = Buffer.alloc(payLen);
				for (let i = 0; i < payLen; i++) unmasked[i] = payload[i] ^ mask[i % 4];
				payload = unmasked;
			}

			this.frameBuf = this.frameBuf.slice(total);

			switch (opcode) {
				case 0x0: // continuation (treat as text)
				case 0x1: // text
					if (this.onmessage) this.onmessage({ data: payload.toString('utf8') });
					break;
				case 0x8: { // close
					const code   = payLen >= 2 ? payload.readUInt16BE(0) : 1000;
					const reason = payLen  >  2 ? payload.slice(2).toString('utf8') : '';
					this._readyState = 3;
					if (this.onclose) this.onclose({ code, reason });
					this.socket?.destroy();
					break;
				}
				case 0x9: // ping → pong
					this.socket?.write(this.encodeFrame(0xA, payload));
					break;
				// 0xA pong: ignore
			}
		}
	}

	/** Encode a single WebSocket frame (client→server, masked). */
	private encodeFrame(opcode: number, payload: Buffer): Buffer {
		const len  = payload.length;
		const mask = cryptoMod.randomBytes(4);
		let   hdr: Buffer;

		if (len < 126) {
			hdr = Buffer.alloc(6);
			hdr[0] = 0x80 | opcode;
			hdr[1] = 0x80 | len;
			mask.copy(hdr, 2);
		} else if (len < 65536) {
			hdr = Buffer.alloc(8);
			hdr[0] = 0x80 | opcode;
			hdr[1] = 0x80 | 126;
			hdr.writeUInt16BE(len, 2);
			mask.copy(hdr, 4);
		} else {
			hdr = Buffer.alloc(14);
			hdr[0] = 0x80 | opcode;
			hdr[1] = 0x80 | 127;
			hdr.writeBigUInt64BE(BigInt(len), 2);
			mask.copy(hdr, 10);
		}

		const masked = Buffer.alloc(len);
		for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
		return Buffer.concat([hdr, masked]);
	}
}
