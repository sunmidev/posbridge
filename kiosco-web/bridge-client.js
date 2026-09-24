// Cliente del protocolo kiosco ↔ POS Bridge para navegador (y Node 22+ en las pruebas).
// Es el equivalente en JavaScript de BridgeClient de :core: mismo framing, mismo HMAC,
// misma recuperación por request_id.
//
// Frame: [u32 big-endian N][32 bytes HMAC-SHA256][JSON UTF-8]
// Transportes: WebSocket (WiFi) y Web Serial (Bluetooth RFCOMM, Chrome/Edge de escritorio).

export const PROTOCOL_VERSION = 1;
export const SDK_VERSION = 'web-0.1.0';
export const DEFAULT_WS_PORT = 8521;
export const BT_SERVICE_UUID = '6f0b3c7e-2a4d-4e3b-9a61-5b8a3c1d9e42';
export const BT_SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

const MAC_SIZE = 32;
const MAX_FRAME = 256 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class BridgeAuthError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'BridgeAuthError'; }
}
/** Error de una operación de contenido (MEDIA_*): code es un BRIDGE_* del Bridge. */
export class MediaError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'MediaError'; }
}
class TimeoutError extends Error {
  constructor(ms) { super(`Sin respuesta del Bridge en ${Math.round(ms / 1000)} s`); this.name = 'TimeoutError'; }
}

// ------------------------------------------------------------------ utilidades

export function base32Decode(text) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const out = [];
  let buffer = 0, bits = 0;
  for (const c of clean) {
    const v = A.indexOf(c);
    if (v < 0) throw new Error(`Carácter Base32 inválido: ${c}`);
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Base64 de bytes, en tramos para no reventar la pila con archivos grandes. */
export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Las partes de un archivo no van a la traza: son cientos de mensajes con Base64.
const UNTRACED = new Set(['PING', 'PONG', 'MEDIA_CHUNK', 'MEDIA_PROGRESS']);
const short = (id) => (id || '').slice(0, 8);

export function newRequestId() {
  return crypto.randomUUID ? crypto.randomUUID() : randomHex(16);
}

// ------------------------------------------------------------------ criptografía
// Si la página se abre por http://<IP> (contexto no seguro), el navegador no expone crypto.subtle.
// Para ese caso va una implementación en JavaScript de SHA-1, SHA-256, HMAC y PBKDF2. Da los mismos
// bytes que WebCrypto (lo verifican las pruebas) y solo se usa cuando WebCrypto no está.

let forceJsCrypto = false;
/** Para pruebas: obliga a usar la implementación en JavaScript aunque haya WebCrypto. */
export function useJsCrypto(on) { forceJsCrypto = !!on; }
const hasSubtle = () => !forceJsCrypto && typeof crypto !== 'undefined' && !!crypto.subtle;
/** 'webcrypto' o 'js': qué implementación se está usando. */
export const cryptoMode = () => (hasSubtle() ? 'webcrypto' : 'js');

const readBE = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];

const SHA1 = {
  out: 20, w: 80,
  init: () => Int32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0),
  compress(s, b, o, w) {
    for (let i = 0; i < 16; i++) w[i] = readBE(b, o + 4 * i);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = s[0], c1 = s[1], c = s[2], d = s[3], e = s[4];
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (c1 & c) | (~c1 & d) : i < 40 ? c1 ^ c ^ d : i < 60 ? (c1 & c) | (c1 & d) | (c & d) : c1 ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (c1 << 30) | (c1 >>> 2); c1 = a; a = t;
    }
    s[0] = (s[0] + a) | 0; s[1] = (s[1] + c1) | 0; s[2] = (s[2] + c) | 0; s[3] = (s[3] + d) | 0; s[4] = (s[4] + e) | 0;
  },
};

const K256 = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const ror = (x, n) => (x >>> n) | (x << (32 - n));

const SHA256 = {
  out: 32, w: 64,
  init: () => Int32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19),
  compress(s, b, o, w) {
    for (let i = 0; i < 16; i++) w[i] = readBE(b, o + 4 * i);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = (w[i - 16] + (ror(x, 7) ^ ror(x, 18) ^ (x >>> 3)) + w[i - 7] + (ror(y, 17) ^ ror(y, 19) ^ (y >>> 10))) | 0;
    }
    let a = s[0], c1 = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & c1) ^ (a & c) ^ (c1 & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = c1; c1 = a; a = (t1 + t2) | 0;
    }
    s[0] = (s[0] + a) | 0; s[1] = (s[1] + c1) | 0; s[2] = (s[2] + c) | 0; s[3] = (s[3] + d) | 0;
    s[4] = (s[4] + e) | 0; s[5] = (s[5] + f) | 0; s[6] = (s[6] + g) | 0; s[7] = (s[7] + h) | 0;
  },
};

/** Termina el hash de `msg` partiendo de `state`, que ya procesó `prefixLen` bytes (múltiplo de 64). */
function hashFrom(alg, state, prefixLen, msg) {
  const s = state.slice();
  const w = new Int32Array(alg.w);
  const full = msg.length - (msg.length % 64);
  for (let o = 0; o < full; o += 64) alg.compress(s, msg, o, w);
  const rest = msg.length - full;
  const tail = new Uint8Array(rest < 56 ? 64 : 128);
  tail.set(msg.subarray(full));
  tail[rest] = 0x80;
  const bits = (prefixLen + msg.length) * 8;
  const n = tail.length;
  const hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
  tail[n - 8] = hi >>> 24; tail[n - 7] = hi >>> 16; tail[n - 6] = hi >>> 8; tail[n - 5] = hi;
  tail[n - 4] = lo >>> 24; tail[n - 3] = lo >>> 16; tail[n - 2] = lo >>> 8; tail[n - 1] = lo;
  for (let o = 0; o < n; o += 64) alg.compress(s, tail, o, w);
  const out = new Uint8Array(alg.out);
  for (let i = 0; i < alg.out / 4; i++) { out[4 * i] = s[i] >>> 24; out[4 * i + 1] = s[i] >>> 16; out[4 * i + 2] = s[i] >>> 8; out[4 * i + 3] = s[i]; }
  return out;
}

/** HMAC con la clave ya procesada (los bloques ipad/opad se calculan una sola vez). */
function jsHmacFor(alg, key) {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? hashFrom(alg, alg.init(), 0, key) : key);
  const w = new Int32Array(alg.w);
  const si = alg.init(), so = alg.init();
  alg.compress(si, k.map((x) => x ^ 0x36), 0, w);
  alg.compress(so, k.map((x) => x ^ 0x5c), 0, w);
  return (data) => hashFrom(alg, so, 64, hashFrom(alg, si, 64, data));
}

function jsPbkdf2(alg, password, salt, iterations, length) {
  const mac = jsHmacFor(alg, password);
  const out = new Uint8Array(length);
  for (let block = 1, pos = 0; pos < length; block++) {
    const s = new Uint8Array(salt.length + 4);
    s.set(salt);
    s[salt.length] = block >>> 24; s[salt.length + 1] = block >>> 16; s[salt.length + 2] = block >>> 8; s[salt.length + 3] = block;
    let u = mac(s);
    const t = u.slice();
    for (let i = 1; i < iterations; i++) { u = mac(u); for (let j = 0; j < t.length; j++) t[j] ^= u[j]; }
    out.set(t.subarray(0, Math.min(t.length, length - pos)), pos);
    pos += t.length;
  }
  return out;
}

async function sha256(bytes) {
  if (hasSubtle()) return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return hashFrom(SHA256, SHA256.init(), 0, bytes);
}

async function hmac(key, data) {
  if (!hasSubtle()) return jsHmacFor(SHA256, key)(data);
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** Solo para las pruebas: compara la implementación JS con WebCrypto. */
export const _jsCrypto = {
  sha1: (b) => hashFrom(SHA1, SHA1.init(), 0, b),
  sha256: (b) => hashFrom(SHA256, SHA256.init(), 0, b),
  hmacSha256: (k, d) => jsHmacFor(SHA256, k)(d),
  pbkdf2Sha1: (p, s, it, len) => jsPbkdf2(SHA1, p, s, it, len),
};

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Código corto para escribir a mano: `K01-4827-1936` (ID del kiosco + PIN de 8 dígitos). */
export function parseShortCode(text) {
  const m = /^([A-Za-z0-9_]{1,16})[-\s]*([0-9]{4})[-\s]*([0-9]{4})$/.exec(String(text || '').trim());
  return m ? { kioskId: m[1].toUpperCase(), pin: m[2] + m[3] } : null;
}

export const PIN_ITERATIONS = 100_000;

/** Misma derivación que PairingPin.deriveKey del Bridge: PBKDF2-SHA1, sal = "sbp1-pin|" + ID. */
export async function derivePinKey(kioskId, pin) {
  if (!hasSubtle()) return jsPbkdf2(SHA1, enc.encode(pin), enc.encode(`sbp1-pin|${kioskId.toUpperCase()}`), PIN_ITERATIONS, 32);
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-1', salt: enc.encode(`sbp1-pin|${kioskId.toUpperCase()}`), iterations: PIN_ITERATIONS },
    base, 256,
  );
  return new Uint8Array(bits);
}

/** Acepta el código corto o el largo. Devuelve { kioskId, key, bridgeId, host, port, short }. */
export async function resolvePairingCode(text) {
  const s = parseShortCode(text);
  if (s) return { kioskId: s.kioskId, key: await derivePinKey(s.kioskId, s.pin), bridgeId: '', host: null, port: null, short: true };
  return { ...parsePairingCode(text), short: false };
}

/** Formato largo (se sigue aceptando): `SBP1;<kioskId>;<claveBase32>;<bridgeId>;<host>;<puerto>` */
export function parsePairingCode(text) {
  const parts = (text || '').trim().split(';');
  if (parts.length !== 6 || parts[0] !== 'SBP1') throw new Error('Código inválido: debe ser como K01-4827-1936');
  const key = base32Decode(parts[2]);
  if (key.length !== 32) throw new Error('La clave del código de emparejamiento no es válida');
  return {
    kioskId: parts[1],
    key,
    bridgeId: parts[3],
    host: parts[4] || null,
    port: parts[5] ? Number(parts[5]) : null,
  };
}

/** Acepta "4,44", "4.44", "4" o "1.234,56". Devuelve céntimos o null. */
export function parseAmount(text) {
  let t = String(text || '').trim().replace(/\s/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [ent, dec2 = ''] = t.split('.');
  const cents = Number(ent) * 100 + Number(dec2.padEnd(2, '0'));
  return cents > 0 && Number.isSafeInteger(cents) ? cents : null;
}

export function formatAmount(cents) {
  const ent = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${ent},${String(cents % 100).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ transportes

/** WiFi: WebSocket al POS (puerto TCP + 1, por defecto 8521). */
export function webSocketConnector(url) {
  return () => {
    let ws;
    return {
      name: 'ws',
      describe: url,
      open(onData, onClose) {
        return new Promise((resolve, reject) => {
          let opened = false;
          ws = new WebSocket(url);
          ws.binaryType = 'arraybuffer';
          ws.onopen = () => { opened = true; resolve(); };
          ws.onmessage = (e) => onData(new Uint8Array(e.data));
          ws.onerror = () => { if (!opened) reject(new Error(`No se pudo conectar a ${url}`)); };
          ws.onclose = () => {
            if (!opened) reject(new Error(`No se pudo conectar a ${url}`));
            else onClose(new Error('Conexión cerrada'));
          };
        });
      },
      async write(bytes) {
        if (!ws || ws.readyState !== 1) throw new Error('Conexión cerrada');
        ws.send(bytes);
      },
      close() { try { ws && ws.close(); } catch { /* nada */ } },
    };
  };
}

/** Bluetooth: puerto serie de Web Serial (RFCOMM del POS emparejado con esta computadora). */
export function serialConnector(port) {
  return () => {
    let reader, writer, closedByUs = false;
    const info = port.getInfo ? port.getInfo() : {};
    const cleanup = async () => {
      try { await reader?.cancel(); } catch { /* nada */ }
      try { reader?.releaseLock(); } catch { /* nada */ }
      try { writer?.releaseLock(); } catch { /* nada */ }
      try { await port.close(); } catch { /* nada */ }
    };
    return {
      name: 'bt',
      describe: info.bluetoothServiceClassId ? `Bluetooth ${info.bluetoothServiceClassId}` : 'puerto serie',
      async open(onData, onClose) {
        await port.open({ baudRate: 115200 }); // RFCOMM ignora la velocidad, pero la API la exige
        writer = port.writable.getWriter();
        reader = port.readable.getReader();
        (async () => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value && value.length) onData(value);
            }
          } catch { /* se cortó */ }
          if (!closedByUs) {
            closedByUs = true;
            await cleanup();
            onClose(new Error('Conexión Bluetooth cerrada'));
          }
        })();
      },
      async write(bytes) { await writer.write(bytes); },
      async close() {
        if (closedByUs) return;
        closedByUs = true;
        await cleanup();
      },
    };
  };
}

export async function requestBluetoothPort() {
  if (!('serial' in navigator)) throw new Error('Este navegador no tiene Web Serial. Use Chrome o Edge de escritorio.');
  // Sin filtros: aparecen los puertos serie normales (macOS crea /dev/cu.* para SPP) y además
  // los servicios RFCOMM con estos UUID de equipos emparejados.
  return navigator.serial.requestPort({ allowedBluetoothServiceClassIds: [BT_SERVICE_UUID, BT_SPP_UUID] });
}

// ------------------------------------------------------------------ sesión (canal autenticado)

class Session {
  constructor(conn, trace = () => {}) {
    this.conn = conn;
    this.trace = trace;
    this.buf = new Uint8Array(0);
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.key = null;
    this.sendSeq = 0;
    this.recvSeq = 0;
    this.chain = Promise.resolve();
    this.pingTimer = null;
  }

  async open() {
    await this.conn.open((d) => this.onData(d), (e) => this.onClose(e));
  }

  onData(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    while (this.buf.length >= 4) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0);
      if (len < MAC_SIZE + 2 || len > MAX_FRAME) {
        this.onClose(new Error(`Frame inválido (${len} bytes)`));
        this.conn.close();
        return;
      }
      if (this.buf.length < 4 + len) break;
      const frame = this.buf.slice(4, 4 + len);
      this.buf = this.buf.slice(4 + len);
      const f = { mac: frame.slice(0, MAC_SIZE), body: frame.slice(MAC_SIZE) };
      const w = this.waiters.shift();
      if (w) w.resolve(f); else this.queue.push(f);
    }
  }

  onClose(err) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    const e = err || new Error('Conexión cerrada');
    this.waiters.splice(0).forEach((w) => w.reject(e));
  }

  close() {
    this.onClose(new Error('Conexión cerrada por el kiosco'));
    this.conn.close();
  }

  readRaw(timeoutMs) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(new Error('Conexión cerrada'));
    return new Promise((resolve, reject) => {
      const w = {
        resolve: (f) => { clearTimeout(t); resolve(f); },
        reject: (e) => { clearTimeout(t); reject(e); },
      };
      const t = timeoutMs ? setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new TimeoutError(timeoutMs));
      }, timeoutMs) : null;
      this.waiters.push(w);
    });
  }

  async writeRaw(key, obj) {
    const body = enc.encode(JSON.stringify(obj));
    const mac = await hmac(key, body);
    const out = new Uint8Array(4 + MAC_SIZE + body.length);
    new DataView(out.buffer).setUint32(0, MAC_SIZE + body.length);
    out.set(mac, 4);
    out.set(body, 4 + MAC_SIZE);
    await this.conn.write(out);
  }

  /** Envía con seq creciente. Las escrituras se encadenan para que el seq no se desordene. */
  send(obj) {
    const p = this.chain.then(async () => {
      if (this.closed) throw new Error('Conexión cerrada');
      this.sendSeq += 1;
      const full = { ...obj, seq: this.sendSeq };
      await this.writeRaw(this.key, full);
      if (!UNTRACED.has(full.t)) this.trace('out', full);
    });
    this.chain = p.catch(() => {});
    return p;
  }

  async receive(timeoutMs) {
    const f = await this.readRaw(timeoutMs);
    if (!sameBytes(await hmac(this.key, f.body), f.mac)) throw new BridgeAuthError('BRIDGE_AUTH', 'HMAC inválido');
    const m = JSON.parse(dec.decode(f.body));
    if (!(Number(m.seq) > this.recvSeq)) throw new BridgeAuthError('BRIDGE_AUTH', 'seq repetido o fuera de orden');
    this.recvSeq = Number(m.seq);
    if (!UNTRACED.has(m.t)) this.trace('in', m);
    return m;
  }

  async handshake(kioskId, pairingKey, timeoutMs) {
    const cn = randomHex(16);
    await this.writeRaw(pairingKey, { t: 'HELLO', v: PROTOCOL_VERSION, kiosk_id: kioskId, nonce: cn, sdk: SDK_VERSION });
    const f = await this.readRaw(timeoutMs);
    const reply = JSON.parse(dec.decode(f.body));
    if (!sameBytes(await hmac(pairingKey, f.body), f.mac)) {
      if (reply.t === 'ERROR') throw new BridgeAuthError(reply.code || 'BRIDGE_AUTH', reply.message || 'Rechazado');
      throw new BridgeAuthError('BRIDGE_AUTH', 'Respuesta del Bridge con firma inválida');
    }
    if (reply.t !== 'HELLO_OK' || reply.echo !== cn) throw new BridgeAuthError('BRIDGE_AUTH', 'Handshake inválido');
    this.key = await hmac(pairingKey, enc.encode(`sbp1-session|${cn}|${reply.nonce}`));
    return reply.caps || {};
  }
}

// ------------------------------------------------------------------ cliente

/**
 * Resultados de execute():
 * - { kind: 'completed', requestId, result }   hubo respuesta (aprobada o no)
 * - { kind: 'busy', requestId, activeRequestId } POS ocupado, no se ejecutó nada
 * - { kind: 'rejected', requestId, code, message } rechazada sin ejecutar
 * - { kind: 'indeterminate', requestId, reason } se perdió la conexión después de enviar: consultar antes de reintentar
 */
export class BridgeClient {
  /** trace(direction, msg): cada mensaje del protocolo ('out' enviado, 'in' recibido), sin PING/PONG. */
  constructor({ connector, kioskId, pairingKey, appId, log = () => {}, trace = () => {}, config = {} }) {
    this.trace = trace;
    this.connector = connector;
    this.kioskId = kioskId;
    this.pairingKey = pairingKey;
    this.appId = appId;
    this.log = log;
    this.cfg = {
      ackTimeoutMs: 10_000,
      resultTimeoutMs: 240_000,
      pingIntervalMs: 30_000,
      handshakeTimeoutMs: 15_000,
      reconnectAttempts: 5,
      reconnectDelayMs: 2_000,
      ...config,
    };
    this.session = null;
    this.opening = null;
    this.opChain = Promise.resolve();
    this.caps = null;
  }

  get connected() { return !!this.session && !this.session.closed; }

  async connect() { return (await this.ensureSession()).caps; }

  async ensureSession() {
    if (this.session && !this.session.closed) return this.session;
    if (!this.opening) this.opening = this.openSession().finally(() => { this.opening = null; });
    return this.opening;
  }

  async openSession() {
    const conn = this.connector();
    const s = new Session(conn, (dir, m) => { try { this.trace(dir, m); } catch { /* nada */ } });
    try {
      await s.open();
      s.caps = await s.handshake(this.kioskId, this.pairingKey, this.cfg.handshakeTimeoutMs);
    } catch (e) {
      s.close();
      throw e;
    }
    this.caps = s.caps;
    s.pingTimer = setInterval(() => {
      s.send({ t: 'PING' }).catch(() => this.dropSession(s));
    }, this.cfg.pingIntervalMs);
    this.session = s;
    this.log('info', `Conectado al Bridge por ${conn.name} (${conn.describe})`);
    return s;
  }

  dropSession(s) {
    s.close();
    if (this.session === s) this.session = null;
  }

  disconnect() { if (this.session) this.dropSession(this.session); }

  /** Para pruebas: corta la conexión como si se cayera la red, sin avisar a la operación en curso. */
  killConnection() {
    const s = this.session;
    if (!s) return false;
    s.conn.close();
    s.onClose(new Error('Conexión cortada a propósito (prueba)'));
    return true;
  }

  lock(fn) {
    const run = this.opChain.then(fn, fn);
    this.opChain = run.catch(() => {});
    return run;
  }

  compra({ cedula, montoCentimos, cuenta = null, requestId = newRequestId() }, onStatus) {
    const params = { cedula, monto_centimos: montoCentimos };
    if (cuenta != null && cuenta !== '') params.cuenta = String(cuenta);
    return this.execute({ requestId, op: 'COMPRA', params }, onStatus);
  }
  anulacion({ requestId = newRequestId() } = {}, onStatus) { return this.execute({ requestId, op: 'ANULACION' }, onStatus); }
  anulacionPorAutorizacion({ codigoAutorizacion, requestId = newRequestId() }, onStatus) {
    return this.execute({ requestId, op: 'ANULACION_POR_AUTORIZACION', params: { codigo_autorizacion: codigoAutorizacion } }, onStatus);
  }
  cierre({ requestId = newRequestId() } = {}, onStatus) { return this.execute({ requestId, op: 'CIERRE' }, onStatus); }
  ultimaTransaccion({ requestId = newRequestId() } = {}, onStatus) { return this.execute({ requestId, op: 'ULTIMA_TRANSACCION' }, onStatus); }
  testComunicacion({ requestId = newRequestId() } = {}, onStatus) { return this.execute({ requestId, op: 'TEST_COMUNICACION' }, onStatus); }
  // Operaciones de configuración: 800 borrar lote, 805 borrar reverso, 430 conf. SIM, 440 conf. WiFi
  borrarLote({ requestId = newRequestId() } = {}, onStatus) { return this.execute({ requestId, op: 'BORRAR_LOTE' }, onStatus); }
  borrarReverso({ requestId = newRequestId() } = {}, onStatus) { return this.execute({ requestId, op: 'BORRAR_REVERSO' }, onStatus); }
  confSim({ requestId = newRequestId() } = {}, onStatus) { return this.execute({ requestId, op: 'CONF_SIM' }, onStatus); }
  confWifi({ requestId = newRequestId() } = {}, onStatus) { return this.execute({ requestId, op: 'CONF_WIFI' }, onStatus); }

  // ---------------------------------------------------------------- contenido de la pantalla del POS

  /** Un pedido MEDIA_* y su respuesta (se reconoce por "ref"). Lanza MediaError si el Bridge responde ERROR. */
  mediaRequest(msg, expect, timeoutMs = 30_000) {
    return this.lock(async () => {
      const s = await this.ensureSession();
      const ref = randomHex(6);
      await s.send({ ...msg, ref });
      while (true) {
        const m = await s.receive(timeoutMs);
        if (m.ref !== ref) continue; // restos de otra operación
        if (m.t === 'ERROR') throw new MediaError(m.code || 'ERROR', m.message || 'Error');
        if (expect.includes(m.t)) return m;
      }
    });
  }

  /** Lista rotativa actual: { items: [{id, kind, mime, name, size, seconds}], limits }. */
  async mediaList() {
    const m = await this.mediaRequest({ t: 'MEDIA_LIST' }, ['MEDIA_LIST_RESULT']);
    return { items: m.items || [], limits: m.limits || {} };
  }

  /** Borra un archivo de la lista. Pide el PIN de administrador del POS. */
  async mediaDelete(id, adminPin) {
    const m = await this.mediaRequest({ t: 'MEDIA_DELETE', id, admin_pin: adminPin }, ['MEDIA_LIST_RESULT']);
    return { items: m.items || [], limits: m.limits || {} };
  }

  /**
   * Sube un video o imagen al final de la lista rotativa. file: Blob/File, ArrayBuffer o Uint8Array.
   * seconds: tiempo en pantalla si es imagen. onProgress(enviados, total). signal: AbortSignal opcional.
   * Entre parte y parte se suelta el candado, así un cobro no espera a que termine un video pesado.
   */
  async mediaUpload(file, { name, seconds = 8, adminPin, signal } = {}, onProgress = () => {}) {
    const bytes = file instanceof Uint8Array ? file : new Uint8Array(file instanceof ArrayBuffer ? file : await file.arrayBuffer());
    const sha256Hex = hex(await sha256(bytes));
    const ready = await this.mediaRequest({
      t: 'MEDIA_BEGIN', name: name || file.name || 'archivo', size: bytes.length, sha256: sha256Hex, seconds, admin_pin: adminPin,
    }, ['MEDIA_READY']);
    const uploadId = ready.upload_id;
    const chunk = Number(ready.chunk_bytes) || 96 * 1024;
    try {
      let offset = 0;
      onProgress(0, bytes.length);
      while (offset < bytes.length) {
        if (signal?.aborted) throw new MediaError('CANCELADA', 'Carga cancelada');
        const part = bytes.subarray(offset, Math.min(offset + chunk, bytes.length));
        const p = await this.mediaRequest({ t: 'MEDIA_CHUNK', upload_id: uploadId, offset, data: bytesToBase64(part) }, ['MEDIA_PROGRESS']);
        offset = Number(p.received);
        onProgress(offset, bytes.length);
      }
      // El POS vuelve a calcular el SHA-256 del archivo completo: con videos grandes tarda unos segundos
      const done = await this.mediaRequest({ t: 'MEDIA_END', upload_id: uploadId }, ['MEDIA_DONE'], 120_000);
      return done.item;
    } catch (e) {
      if (this.connected) this.session.send({ t: 'MEDIA_ABORT', upload_id: uploadId }).catch(() => {});
      throw e;
    }
  }

  /** Consulta de solo lectura: no ejecuta nada en el POS. */
  consultar(requestId) {
    return this.lock(async () => {
      const s = await this.ensureSession();
      await s.send({ t: 'QUERY', request_id: requestId });
      while (true) {
        const m = await s.receive(this.cfg.ackTimeoutMs);
        if (m.t === 'QUERY_RESULT' && m.request_id === requestId) return { requestId, state: m.state, result: m.result || null };
      }
    });
  }

  /** Ejecuta con recuperación: si se cae la conexión, reconecta y reenvía el MISMO request_id. */
  execute(req, onStatus = () => {}) {
    return this.lock(async () => {
      const payload = { t: 'REQUEST', request_id: req.requestId, op: req.op, app_id: this.appId, params: req.params || {} };
      let attempts = 0;
      let delivered = false;
      let acked = false;
      while (true) {
        let s = null;
        try {
          s = await this.ensureSession();
          await s.send(payload);
          delivered = true;
          while (true) {
            const m = await s.receive(acked ? this.cfg.resultTimeoutMs : this.cfg.ackTimeoutMs);
            if (m.request_id && m.request_id !== req.requestId) continue; // mensaje viejo
            if (m.t === 'ACK') acked = true;
            else if (m.t === 'STATUS') {
              acked = true;
              try { onStatus({ requestId: req.requestId, status: m.status, detail: m.detail }); } catch { /* nada */ }
            } else if (m.t === 'RESULT') return { kind: 'completed', requestId: req.requestId, result: m.result };
            else if (m.t === 'BUSY') return { kind: 'busy', requestId: req.requestId, activeRequestId: m.active_request_id || null };
            else if (m.t === 'ERROR') return { kind: 'rejected', requestId: req.requestId, code: m.code || 'ERROR', message: m.message || 'Error' };
          }
        } catch (e) {
          if (e instanceof BridgeAuthError) {
            if (s) this.dropSession(s);
            throw e;
          }
          this.log('warn', `Conexión perdida en ${short(req.requestId)} (intento ${attempts + 1}): ${e.message}`);
          if (s) this.dropSession(s);
        }
        attempts += 1;
        if (attempts > this.cfg.reconnectAttempts) {
          return delivered
            ? { kind: 'indeterminate', requestId: req.requestId, reason: 'Se perdió la conexión con el POS después de enviar la operación' }
            : { kind: 'rejected', requestId: req.requestId, code: 'SDK_SIN_CONEXION', message: 'No se pudo conectar con el POS' };
        }
        await sleep(this.cfg.reconnectDelayMs * Math.min(attempts, 3));
      }
    });
  }
}
