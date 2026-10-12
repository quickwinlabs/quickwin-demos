var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// .tsc-out/deskmon.js
import * as gui from "gui";
import * as os4 from "os";

// node_modules/quickwin/lib/ffi/bind.js
import * as ffi from "ffi";
import * as os2 from "os";
import * as std from "std";
import * as win from "win";

// node_modules/quickwin/lib/text-codec.js
var _labelMap = {
  "utf-8": "utf-8",
  "utf8": "utf-8",
  "unicode-1-1-utf-8": "utf-8",
  "utf-16": "utf-16le",
  "utf-16le": "utf-16le",
  "utf-16be": "utf-16be"
};
function _normalizeLabel(label) {
  if (!label)
    return "utf-8";
  const result = _labelMap[label.trim().toLowerCase()];
  if (result)
    return result;
  throw new RangeError(`The encoding label "${label}" is not supported`);
}
function _decodeUTF8(buf, fatal) {
  let out = "";
  for (let i = 0; i < buf.length; ) {
    const b2 = buf[i++];
    if (b2 < 128) {
      out += String.fromCharCode(b2);
      continue;
    }
    if (b2 < 192) {
      out += fatal ? (() => {
        throw new TypeError("unexpected continuation byte");
      })() : "\uFFFD";
      continue;
    }
    let c, min;
    if (b2 < 224) {
      if (i >= buf.length) {
        out += fatal ? (() => {
          throw new TypeError("incomplete utf-8");
        })() : "\uFFFD";
        break;
      }
      const b22 = buf[i++];
      if ((b22 & 192) !== 128) {
        out += "\uFFFD";
        continue;
      }
      c = (b2 & 31) << 6 | b22 & 63;
      min = 128;
    } else if (b2 < 240) {
      if (i + 1 >= buf.length) {
        out += fatal ? (() => {
          throw new TypeError("incomplete utf-8");
        })() : "\uFFFD";
        break;
      }
      const b22 = buf[i++];
      const b3 = buf[i++];
      if ((b22 & 192) !== 128 || (b3 & 192) !== 128) {
        out += "\uFFFD";
        continue;
      }
      c = (b2 & 15) << 12 | (b22 & 63) << 6 | b3 & 63;
      min = 2048;
    } else if (b2 < 248) {
      if (i + 2 >= buf.length) {
        out += fatal ? (() => {
          throw new TypeError("incomplete utf-8");
        })() : "\uFFFD";
        break;
      }
      const b22 = buf[i++];
      const b3 = buf[i++];
      const b4 = buf[i++];
      if ((b22 & 192) !== 128 || (b3 & 192) !== 128 || (b4 & 192) !== 128) {
        out += "\uFFFD";
        continue;
      }
      c = (b2 & 7) << 18 | (b22 & 63) << 12 | (b3 & 63) << 6 | b4 & 63;
      min = 65536;
    } else {
      out += fatal ? (() => {
        throw new TypeError("invalid utf-8 start");
      })() : "\uFFFD";
      continue;
    }
    if (c < min || c >= 55296 && c <= 57343 || c > 1114111) {
      out += fatal ? (() => {
        throw new TypeError("invalid utf-8 codepoint");
      })() : "\uFFFD";
      continue;
    }
    if (c <= 65535)
      out += String.fromCharCode(c);
    else {
      c -= 65536;
      out += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
    }
  }
  return out;
}
function _decodeUTF16(buf, le, fatal) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let out = "";
  for (let i = 0; i + 1 < buf.length; i += 2) {
    let c = dv.getUint16(i, le);
    if (c >= 55296 && c <= 56319) {
      i += 2;
      if (i + 1 >= buf.length) {
        out += fatal ? (() => {
          throw new TypeError("truncated surrogate pair");
        })() : "\uFFFD";
        break;
      }
      const c2 = dv.getUint16(i, le);
      if (c2 >= 56320 && c2 <= 57343) {
        out += String.fromCharCode(c, c2);
      } else {
        out += fatal ? (() => {
          throw new TypeError("invalid surrogate pair");
        })() : "\uFFFD";
        i -= 2;
      }
    } else if (c >= 56320 && c <= 57343) {
      out += fatal ? (() => {
        throw new TypeError("unexpected trailing surrogate");
      })() : "\uFFFD";
    } else {
      out += String.fromCharCode(c);
    }
  }
  return out;
}
var TextDecoderImpl = class {
  constructor(label, options) {
    __publicField(this, "_encoding");
    __publicField(this, "_fatal");
    __publicField(this, "_ignoreBOM");
    this._encoding = _normalizeLabel(label);
    this._fatal = options?.fatal ?? false;
    this._ignoreBOM = options?.ignoreBOM ?? false;
  }
  get encoding() {
    return this._encoding;
  }
  get fatal() {
    return this._fatal;
  }
  get ignoreBOM() {
    return this._ignoreBOM;
  }
  decode(buffer) {
    if (!buffer)
      return "";
    const arr = buffer instanceof Uint8Array ? buffer : buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (this._encoding === "utf-8") {
      return _decodeUTF8(arr, this._fatal);
    }
    const le = this._encoding === "utf-16le";
    let offset = 0;
    if (arr.length >= 2 && !this._ignoreBOM) {
      const bomLo = le ? arr[0] : arr[1];
      const bomHi = le ? arr[1] : arr[0];
      const bom = bomHi << 8 | bomLo;
      if (bom === 65279 || bom === 65534) {
        offset = 2;
      }
    }
    return _decodeUTF16(arr.slice(offset), le, this._fatal);
  }
};
var TextEncoderImpl = class {
  constructor(label) {
    __publicField(this, "_encoding");
    this._encoding = _normalizeLabel(label);
  }
  get encoding() {
    return this._encoding;
  }
  encode(input) {
    if (!input)
      return new Uint8Array(0);
    if (this._encoding === "utf-8") {
      const bytes = [];
      for (let i = 0; i < input.length; i++) {
        let c = input.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else if (c < 2048) {
          bytes.push(192 | c >> 6, 128 | c & 63);
        } else if (c < 55296 || c >= 57344) {
          bytes.push(224 | c >> 12, 128 | c >> 6 & 63, 128 | c & 63);
        } else {
          i++;
          const c2 = input.charCodeAt(i);
          c = 65536 + ((c & 1023) << 10) | c2 & 1023;
          bytes.push(240 | c >> 18, 128 | c >> 12 & 63, 128 | c >> 6 & 63, 128 | c & 63);
        }
      }
      return new Uint8Array(bytes);
    }
    const le = this._encoding === "utf-16le";
    const buf = new ArrayBuffer(input.length * 2);
    const dv = new DataView(buf);
    for (let i = 0; i < input.length; i++)
      dv.setUint16(i * 2, input.charCodeAt(i), le);
    return new Uint8Array(buf);
  }
};
if (typeof globalThis.TextDecoder === "undefined") {
  globalThis.TextDecoder = TextDecoderImpl;
}
if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder = TextEncoderImpl;
}

// node_modules/quickwin/lib/ffi/ctype.js
import { bufferPtr } from "ffi";
import * as os from "os";
var C_BASIC_TYPE = [
  "void",
  "u8",
  "i8",
  "u16",
  "i16",
  "u32",
  "i32",
  "u64",
  "i64",
  "f32",
  "f64",
  "ptr"
];
var PTR_TOKEN_RE = /^<([A-Za-z_]\w*|)>ptr(!|@[A-Za-z_]\w*)?$/;
function isCPtrToken(t) {
  return PTR_TOKEN_RE.test(t);
}
var VAL_TOKEN_RE = /^<([A-Za-z_]\w*)>$/;
function isCValToken(t) {
  return VAL_TOKEN_RE.test(t);
}
function valName(t) {
  const m = VAL_TOKEN_RE.exec(t);
  return m?.[1] || "";
}
function ptrName(t) {
  const m = PTR_TOKEN_RE.exec(t);
  return m?.[1] || "";
}
var cTokenToType = (t) => {
  if (isCPtrToken(t))
    return "ptr";
  if (isCValToken(t))
    throw new Error(`ffi: cTokenToType: by-value token "${t}" has no scalar slot type`);
  return t;
};
var PTR_SIZE = os.arch === "x64" ? 8 : 4;
var SizeAlign = {
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
  f32: 4,
  f64: 8
};
function normToken(t) {
  if (isCPtrToken(t)) {
    const m = PTR_TOKEN_RE.exec(t);
    const name = m?.[1] || "";
    const mod = m?.[2];
    return mod?.startsWith("@") ? `<${name}>ptr` : t;
  }
  if (isCValToken(t))
    return t;
  const at = t.indexOf("@");
  const base = at >= 0 ? t.slice(0, at) : t;
  const suffixOk = at < 0 || /^[A-Za-z_]\w*$/.test(t.slice(at + 1));
  if (suffixOk && base !== "ptr" && C_BASIC_TYPE.includes(base))
    return base;
  throw new Error("Unknown token: " + t);
}
function readScalar(dv, off, k) {
  switch (k) {
    case "u8":
      return dv.getUint8(off);
    case "i8":
      return dv.getInt8(off);
    case "u16":
      return dv.getUint16(off, true);
    case "i16":
      return dv.getInt16(off, true);
    case "u32":
      return dv.getUint32(off, true);
    case "i32":
      return dv.getInt32(off, true);
    case "u64":
      return dv.getBigUint64(off, true);
    case "i64":
      return dv.getBigInt64(off, true);
    case "f32":
      return dv.getFloat32(off, true);
    case "f64":
      return dv.getFloat64(off, true);
    case "ptr": {
      return PTR_SIZE === 8 ? Number(dv.getBigInt64(off, true)) : dv.getInt32(off, true);
    }
  }
}
function writeScalar(dv, off, { k, v }) {
  switch (k) {
    case "u8":
      dv.setUint8(off, Number(v));
      break;
    case "i8":
      dv.setInt8(off, Number(v));
      break;
    case "u16":
      dv.setUint16(off, Number(v), true);
      break;
    case "i16":
      dv.setInt16(off, Number(v), true);
      break;
    case "u32":
      dv.setUint32(off, v >>> 0, true);
      break;
    case "i32":
      dv.setUint32(off, v >>> 0, true);
      break;
    case "u64":
      dv.setBigUint64(off, v, true);
      break;
    case "i64":
      dv.setBigInt64(off, v, true);
      break;
    case "f32":
      dv.setFloat32(off, v, true);
      break;
    case "f64":
      dv.setFloat64(off, v, true);
      break;
    case "ptr": {
      if (v == null) {
        throw new Error("ffi: got null/undefined for a ptr slot; pass the imported NULL constant for empty");
      }
      if (PTR_SIZE === 8)
        dv.setBigUint64(off, BigInt.asUintN(64, BigInt(v)), true);
      else
        dv.setUint32(off, v >>> 0, true);
      break;
    }
  }
}
function writeSlot(dv, off, e) {
  const { k, v } = e;
  if (k === "u8" || k === "i8" || k === "u16" || k === "i16") {
    dv.setUint32(off, Number(v) >>> 0, true);
    return;
  }
  writeScalar(dv, off, e);
}
var PtrArrayBuffer = class extends ArrayBuffer {
  constructor(byteLength) {
    super(byteLength);
    __publicField(this, "ptr");
    this.ptr = bufferPtr(this);
  }
};

// node_modules/quickwin/lib/ffi/bind.js
function valCodec(name, encoders) {
  return encoders[name];
}
var _dllCache = /* @__PURE__ */ new Map();
function loadDll(dll) {
  const cached = _dllCache.get(dll);
  if (cached !== void 0)
    return cached;
  const loaded = win.LoadLibrary(dll);
  if (!loaded)
    throw new Error(`ffi-bind: LoadLibrary("${dll}") failed`);
  _dllCache.set(dll, loaded);
  return loaded;
}
function parseSig(sig) {
  const parts = sig.split(" -> ");
  if (parts.length !== 2) {
    throw new Error(`ffi-bind: invalid signature "${sig}" (expected "arg1 arg2 -> ret")`);
  }
  const rawArgs = parts[0].split(" ").filter((t) => t !== "");
  const argTokens = [];
  for (const raw of rawArgs) {
    const tok = normToken(raw);
    if (tok === "void") {
      throw new Error("Void can not in args");
    }
    argTokens.push(tok);
  }
  const retToken = normToken(parts[1]);
  if (isCValToken(retToken))
    throw new Error(`ffi-bind: "${sig}": by-value struct at the return position (<${valName(retToken)}>) is not supported \u2014 argument positions only; pass a struct out through an out-param slot instead (<N>ptr + caller buffer)`);
  return {
    argTokens,
    retToken,
    sig
  };
}
function makeFn(proc, sig, encoders, decoders) {
  const ps = parseSig(sig);
  for (const t of ps.argTokens) {
    if (!isCValToken(t))
      continue;
    const name = valName(t);
    const codec = valCodec(name, encoders);
    if (!codec || typeof codec.encode !== "function")
      throw new Error(`ffi-bind: ${sig}: by-value position <${name}> has no registered layout (available: ${Object.keys(encoders).join(", ") || "none"})`);
    if (typeof codec.size !== "number" || codec.size < 1)
      throw new Error(`ffi-bind: ${sig}: by-value position <${name}> requires a struct layout with size >= 1 (got ${codec.size}; non-struct codecs expose no size)`);
  }
  return (...a) => callPacked(proc, ps, a, encoders, decoders);
}
var IA32_ARG_SIZE = {
  u8: 4,
  i8: 4,
  u16: 4,
  i16: 4,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
  f32: 4,
  f64: 8,
  ptr: PTR_SIZE
};
var X64_MIN_SLOTS = 4;
function callPacked(proc, { argTokens, retToken, sig }, args, encoders, decoders) {
  const is64 = os2.arch === "x64";
  const getWidth = (t, is642) => {
    if (isCValToken(t))
      throw new Error(`ffi-bind: getWidth: by-value token "${t}" (dispatched by widthOf)`);
    if (is642)
      return 8;
    if (isCPtrToken(t))
      return PTR_SIZE;
    return IA32_ARG_SIZE[t];
  };
  const widthOf = (t) => {
    if (isCValToken(t)) {
      if (is64)
        return 8;
      const layout = valCodec(valName(t), encoders);
      if (!layout)
        throw new Error(`ffi-bind: <${valName(t)}> by-value position has no registered layout`);
      const size = layout.size;
      return size % 4 === 0 ? size : size + 4 - size % 4;
    }
    return getWidth(t, is64);
  };
  let total = 0;
  for (const t of argTokens)
    total += widthOf(t);
  if (is64 && argTokens.length < X64_MIN_SLOTS)
    total = X64_MIN_SLOTS * 8;
  const argFrame = new ArrayBuffer(total);
  const dv = new DataView(argFrame);
  const held = [];
  let off = 0;
  for (let i = 0; i < argTokens.length; i++) {
    const argToken = argTokens[i];
    const nonnull = argToken.endsWith("!");
    const arg = args[i];
    if (isCPtrToken(argToken)) {
      const name = ptrName(argToken);
      if (typeof arg === "number") {
        if (nonnull && arg === 0)
          throw new Error(`ffi-bind: ${sig}: arg#${i + 1} <${name}>ptr! got 0 (null pointer forbidden here; the token marks this position non-null)`);
        writeSlot(dv, off, { k: "ptr", v: arg });
      } else {
        if (arg === null || arg === void 0) {
          throw new Error(`ffi-bind: <${name}>ptr got ${String(arg)}; pass the imported NULL constant for an empty pointer`);
        }
        const codec = encoders[name];
        if (!codec) {
          throw new Error(name === "" ? `ffi-bind: <>ptr expects number (NULL | Ptr), got ${typeof arg}; use <BYTE>ptr with a PtrArrayBuffer (new PtrArrayBuffer(n)), or ffi.bufferPtr(buf) for an address` : `ffi-bind: unknown layout "<${name}>ptr" (available: ${Object.keys(encoders).join(", ") || "none"})`);
        }
        if (!codec.encode) {
          throw new Error(`ffi-bind: <${name}>ptr has no encoder (out-only codec)`);
        }
        const buf = codec.encode(arg);
        held.push(buf);
        const p = buf.ptr;
        if (typeof p !== "number")
          throw new Error("ffi-bind: codec.encode must return a PtrArrayBuffer, got plain ArrayBuffer");
        if (nonnull && p === 0)
          throw new Error(`ffi-bind: ${sig}: arg#${i + 1} <${name}>ptr! encode produced 0 (null pointer forbidden here)`);
        writeSlot(dv, off, { k: "ptr", v: p });
      }
    } else if (isCValToken(argToken)) {
      const name = valName(argToken);
      const codec = valCodec(name, encoders);
      if (!codec)
        throw new Error(`ffi-bind: ${sig}: arg#${i + 1} <${name}> by-value position has no registered layout`);
      if (arg === null || arg === void 0)
        throw new Error(`ffi-bind: <${name}> value position got ${String(arg)}; pass a struct object (use <${name}>ptr to pass a pointer)`);
      const size = codec.size;
      if (!is64 || size <= 8 && (size & size - 1) === 0) {
        codec.encode(arg, argFrame, off);
      } else {
        const buf = new ArrayBuffer(size + 15);
        const base = ffi.bufferPtr(buf);
        const pad = (16 - base % 16) % 16;
        codec.encode(arg, buf, pad);
        held.push(buf);
        writeSlot(dv, off, { k: "ptr", v: base + pad });
      }
    } else {
      writeSlot(dv, off, { k: argToken, v: arg });
    }
    off += widthOf(argToken);
  }
  const retBuf = new ArrayBuffer(8);
  const retIsFp = retToken === "f32" || retToken === "f64";
  ffi.ffiCall(proc, argFrame, retBuf, retIsFp ? 1 : 0);
  const raw = readRet(cTokenToType(retToken), retBuf);
  if (retToken.endsWith("!") && raw === 0)
    throw new Error(`ffi-bind: ${sig}: return ${retToken} got 0 (the token promises C never returns null here)`);
  if (isCPtrToken(retToken) && raw !== 0) {
    const name = ptrName(retToken);
    if (name !== "") {
      const codec = decoders[name];
      if (codec?.decode)
        return codec.decode(raw);
    }
  }
  return raw;
}
function readRet(ret, retBuf) {
  if (ret === "void")
    return void 0;
  return readScalar(new DataView(retBuf), 0, ret);
}
var WCHAR = {
  encode: (v) => {
    const u8 = new TextEncoder("utf-16le").encode(v + "\0");
    const out = new PtrArrayBuffer(u8.byteLength);
    new Uint8Array(out).set(u8);
    return out;
  },
  decode: (p) => {
    if (typeof p === "number") {
      let s2 = "";
      let addr = p;
      const start = addr;
      for (; ; ) {
        const lo = ffi.readByte(addr);
        const hi = ffi.readByte(addr + 1);
        if (lo === 0 && hi === 0)
          return s2;
        s2 += String.fromCharCode(lo | hi << 8);
        addr += 2;
        if (addr - start > 1 << 21) {
          throw new Error("ffi-bind: WCHAR decode exceeded 4MiB without NUL");
        }
      }
    }
    const u8 = new Uint8Array(p);
    const limit = u8.length & ~1;
    let s = "";
    for (let i = 0; i < limit; i += 2) {
      const c = u8[i] | u8[i + 1] << 8;
      if (c === 0)
        return s;
      s += String.fromCharCode(c);
    }
    return s;
  },
  alloc: (size = 256) => new PtrArrayBuffer(size * 2)
};
var BYTE = {
  encode: (v) => {
    if (!(v instanceof PtrArrayBuffer))
      throw new Error("ffi-bind: <BYTE>ptr wants a PtrArrayBuffer (new PtrArrayBuffer(n) / BYTE.alloc / struct.encode), not a plain ArrayBuffer");
    return v;
  },
  alloc: (byteLen) => new PtrArrayBuffer(byteLen)
};
var builtinCodecs = { WCHAR, BYTE };
function bind(dll, name, sig, encoders, decoders) {
  const proc = win.GetProcAddress(loadDll(dll), name);
  if (!proc)
    throw new Error(`ffi-bind: proc "${name}" not found in ${dll}`);
  const effDec = decoders ?? encoders;
  return makeFn(proc, sig, { ...builtinCodecs, ...encoders }, { ...builtinCodecs, ...effDec ?? {} });
}
var leakRegistry = new FinalizationRegistry((held) => {
  std.printf('[ffi] closure leaked (GCed without dispose): sig="%s" ptr=0x%x\n', held.sig, held.ptr);
});

// node_modules/quickwin/lib/ffi/struct.js
import * as ffi2 from "ffi";
function alignUp(v, a) {
  return v + a - 1 & ~(a - 1);
}
var isCNumberToken = (t) => SizeAlign[t] !== void 0;
function lower(v) {
  if (typeof v === "string") {
    const st = /^(u8|u16)\[(\d+)\]@(utf-8|utf-16le)$/.exec(v);
    if (st) {
      const length = Number(st[2]);
      if (!Number.isInteger(length) || length < 1)
        throw new Error(`ffi-struct: string length must be an integer >= 1, got ${length}`);
      const s2 = st[1] === "u8" ? 1 : 2;
      return { size: s2 * length, align: s2, type: { tag: "string", encoding: st[3] } };
    }
    const a = /^([^\[\]]+)\[(\d+)\]$/.exec(v);
    if (a) {
      const length = Number(a[2]);
      if (!Number.isInteger(length) || length < 1)
        throw new Error(`ffi-struct: array length must be an integer >= 1, got ${length}`);
      const el = lower(a[1]);
      if (el.type.tag === "bitfield")
        throw new Error("ffi-struct: bitfields cannot be array elements");
      return {
        size: el.size * length,
        align: el.align,
        type: { tag: "array", elementType: el.type, elementSize: el.size }
      };
    }
    const b2 = /^([A-Za-z_]\w*):(\d+)$/.exec(v);
    if (b2) {
      const rawUnit = b2[1];
      const unit = normToken(rawUnit);
      if (!isCNumberToken(unit) || unit === "f32" || unit === "f64")
        throw new Error(`ffi-struct: bitfield unit must be an integer type, got "${rawUnit}"`);
      const width = Number(b2[2]);
      const s2 = SizeAlign[unit];
      const cap = s2 * 8;
      if (!Number.isInteger(width) || width < 1)
        throw new Error(`ffi-struct: bitfield width must be an integer >= 1, got ${width}`);
      if (width > cap)
        throw new Error(`ffi-struct: bitfield width ${width} exceeds unit width ${cap}`);
      return { size: s2, align: s2, type: { tag: "bitfield", unit, bit: 0, width } };
    }
    const k = normToken(v);
    if (isCPtrToken(k))
      return { size: PTR_SIZE, align: PTR_SIZE, type: { tag: "basic", kind: "ptr" } };
    if (!isCNumberToken(k))
      throw new Error(`ffi-struct: unknown kind "${v}"`);
    const s = SizeAlign[k];
    return { size: s, align: s, type: { tag: "basic", kind: k } };
  }
  if (v && typeof v === "object") {
    const o = v;
    const tag = o["#"];
    if (tag === void 0)
      throw new Error(`ffi-struct: nested object value requires a '#' key ('struct' | 'union' | 'array')`);
    if (tag === "array" && "#pack" in o)
      throw new Error(`ffi-struct: '#pack' is only allowed on struct/union, got '${tag}'`);
    if (tag === "array") {
      const length = o["length"];
      if (!Number.isInteger(length) || length < 1)
        throw new Error(`ffi-struct: array length must be an integer >= 1, got ${String(length)}`);
      const el = lower(o["element"]);
      if (el.type.tag === "bitfield")
        throw new Error("ffi-struct: bitfields cannot be array elements");
      return {
        size: el.size * length,
        align: el.align,
        type: { tag: "array", elementType: el.type, elementSize: el.size }
      };
    }
    if (tag === "struct" || tag === "union") {
      const l = computeStructLayout(v);
      return { size: l.size, align: l.maxEffectiveAlign, type: { tag, fields: l.fields } };
    }
    throw new Error(`ffi-struct: unknown '#' declaration ${JSON.stringify(String(tag))}`);
  }
  throw new Error(`ffi-struct: invalid member value: ${String(v)}`);
}
function computeStructLayout(t) {
  const isStruct = t["#"] === "struct";
  const pack = t["#pack"] ?? 8;
  let maxEffectiveAlign = 1;
  let maxMemberSize = 0;
  const fields = [];
  let cursor = 0;
  let unitBase = -1;
  let unitBits = 0;
  let unitSize = 0;
  const flushUnit = () => {
    if (unitBase < 0)
      return;
    cursor = alignUp(unitBase + Math.ceil(unitBits / 8), unitSize);
    unitBase = -1;
  };
  for (const [rawName, v] of Object.entries(t)) {
    if (rawName.startsWith("#"))
      continue;
    const m = /^([^@]+)@(\d+)$/.exec(rawName);
    const name = m ? m[1] : rawName;
    const alignas = m ? Number(m[2]) : 0;
    const { size, align: natural, type } = lower(v);
    const nonnull = typeof v === "string" && v.endsWith("!");
    let align = natural;
    if (pack > 0)
      align = Math.min(pack, align);
    if (alignas)
      align = Math.max(align, alignas);
    if (type.tag === "bitfield") {
      if (name.startsWith("$"))
        throw new Error("ffi-struct: bitfield members must be named");
      if (!isStruct) {
        fields.push({ name, offset: 0, size, type: { ...type, bit: 0 } });
        maxEffectiveAlign = Math.max(maxEffectiveAlign, align);
        maxMemberSize = Math.max(maxMemberSize, size);
        continue;
      }
      const width = type.width;
      if (unitBase < 0 || size !== unitSize || unitBits + width > unitSize * 8) {
        if (unitBase >= 0)
          flushUnit();
        const offset2 = alignUp(cursor, align);
        unitBase = offset2;
        unitBits = 0;
        unitSize = size;
      }
      fields.push({
        name,
        offset: unitBase,
        // 单元基址（不是位域自己的地址）
        size,
        type: { ...type, bit: unitBits }
      });
      unitBits += width;
      maxEffectiveAlign = Math.max(maxEffectiveAlign, align);
      maxMemberSize = Math.max(maxMemberSize, size);
      continue;
    }
    flushUnit();
    const offset = alignUp(cursor, align);
    if (!name.startsWith("$")) {
      fields.push({ name, offset, size, type, ...nonnull ? { nonnull: true } : {} });
    } else {
      if (type.tag !== "struct" && type.tag !== "union")
        throw new Error(`ffi-struct: anonymous member "${name}" must be a struct/union`);
      for (const cf of type.fields)
        fields.push({ ...cf, offset: cf.offset + offset });
    }
    if (isStruct)
      cursor = offset + size;
    maxEffectiveAlign = Math.max(maxEffectiveAlign, align);
    maxMemberSize = Math.max(maxMemberSize, size);
  }
  flushUnit();
  return {
    size: isStruct ? alignUp(cursor, maxEffectiveAlign) : alignUp(maxMemberSize, maxEffectiveAlign),
    maxEffectiveAlign,
    fields
  };
}
function readUnitRaw(dv, off, unit) {
  const s = SizeAlign[unit];
  if (s === 1)
    return BigInt(dv.getUint8(off));
  if (s === 2)
    return BigInt(dv.getUint16(off, true));
  if (s === 4)
    return BigInt(dv.getUint32(off, true));
  return dv.getBigUint64(off, true);
}
function writeUnitRaw(dv, off, unit, v) {
  const s = SizeAlign[unit];
  if (s === 1) {
    dv.setUint8(off, Number(v & 0xffn));
    return;
  }
  if (s === 2) {
    dv.setUint16(off, Number(v & 0xffffn), true);
    return;
  }
  if (s === 4) {
    dv.setUint32(off, Number(v & 0xffffffffn), true);
    return;
  }
  dv.setBigUint64(off, v & 0xffffffffffffffffn, true);
}
function readBitfield(dv, off, t) {
  const w = BigInt(t.width);
  let v = readUnitRaw(dv, off, t.unit) >> BigInt(t.bit) & (1n << w) - 1n;
  if (t.unit[0] === "i" && v & 1n << w - 1n)
    v -= 1n << w;
  if (t.width > 53)
    return v;
  return Number(v);
}
function writeBitfield(dv, off, t, val) {
  const w = BigInt(t.width);
  const bit = BigInt(t.bit);
  const widthMask = (1n << w) - 1n;
  const posMask = widthMask << bit;
  const raw = readUnitRaw(dv, off, t.unit);
  const bits = (typeof val === "bigint" ? val : BigInt(Math.trunc(val))) & widthMask;
  writeUnitRaw(dv, off, t.unit, raw & ~posMask | bits << bit);
}
var stringEncoders = {
  "utf-8": new TextEncoder("utf-8"),
  "utf-16le": new TextEncoder("utf-16le")
};
var stringDecoders = {
  "utf-8": new TextDecoder("utf-8", { ignoreBOM: true }),
  "utf-16le": new TextDecoder("utf-16le", { ignoreBOM: true })
};
function readString(dv, off, size, enc) {
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset + off, size);
  const unit = enc === "utf-16le" ? 2 : 1;
  let end = size;
  for (let i = 0; i + unit <= size; i += unit) {
    if (bytes[i] === 0 && (unit === 1 || bytes[i + 1] === 0)) {
      end = i;
      break;
    }
  }
  return stringDecoders[enc].decode(bytes.subarray(0, end));
}
function writeString(dv, off, size, enc, v) {
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset + off, size);
  bytes.fill(0);
  const unit = enc === "utf-16le" ? 2 : 1;
  const cap = size - unit;
  if (cap <= 0)
    return;
  const src = stringEncoders[enc].encode(String(v ?? ""));
  bytes.set(src.subarray(0, Math.min(src.length, cap)));
}
function readArray(dv, off, size, t) {
  const count = t.elementSize > 0 ? size / t.elementSize : 0;
  const out = [];
  for (let i = 0; i < count; i++)
    out.push(readElement(dv, off + i * t.elementSize, t.elementType, t.elementSize));
  return out;
}
function writeArray(dv, off, size, t, v) {
  const count = t.elementSize > 0 ? size / t.elementSize : 0;
  const list = v ?? [];
  for (let i = 0; i < count; i++)
    writeElement(dv, off + i * t.elementSize, t.elementType, t.elementSize, list[i]);
}
function readElement(dv, off, t, size) {
  switch (t.tag) {
    case "basic":
      return readScalar(dv, off, t.kind);
    case "bitfield":
      return readBitfield(dv, off, t);
    case "string":
      return readString(dv, off, size, t.encoding);
    case "struct":
    case "union":
      return doDecode(dv, off, t.fields);
    case "array":
      return readArray(dv, off, size, t);
  }
}
function writeElement(dv, off, t, size, val) {
  switch (t.tag) {
    // TODO: remove this any
    case "basic":
      writeScalar(dv, off, { k: t.kind, v: val });
      break;
    // 直传（不 Number()）：writeBitfield 的 val 是 number | bigint，
    // 64 位单元走 bigint，先 Number() 会把 >2^53 的位域值截断。
    case "bitfield":
      writeBitfield(dv, off, t, val ?? 0);
      break;
    case "string":
      writeString(dv, off, size, t.encoding, val);
      break;
    case "struct":
    case "union":
      doEncode(dv, off, t.fields, val ?? {});
      break;
    case "array":
      writeArray(dv, off, size, t, val);
      break;
  }
}
function doDecode(dv, base, fields) {
  const out = {};
  for (const f of fields) {
    const v = readElement(dv, base + f.offset, f.type, f.size);
    if (f.nonnull && v === 0)
      throw new Error(`ffi-struct: decode: '!' field "${f.name}" got 0 (C did not fill it, or decode was called on an unfilled slot)`);
    out[f.name] = v;
  }
  return out;
}
function doEncode(dv, base, fields, v) {
  for (const f of fields) {
    if (v[f.name] === void 0)
      continue;
    writeElement(dv, base + f.offset, f.type, f.size, v[f.name]);
  }
}
function createStruct(t) {
  const { fields, size, maxEffectiveAlign } = computeStructLayout(t);
  return {
    __struct: t,
    size,
    structAlign: maxEffectiveAlign,
    decode: (p) => {
      if (typeof p === "number")
        return doDecode(new DataView(ffi2.readBytes(p, size)), 0, fields);
      return doDecode(new DataView(p), 0, fields);
    },
    alloc: ((n) => {
      if (n !== void 0 && (!Number.isInteger(n) || n < 1))
        throw new Error(`ffi-struct: alloc(n) requires an integer n >= 1 (PAB(0) never escapes \u2014 pass NULL for an empty pointer position)`);
      return new PtrArrayBuffer(size * (n ?? 1));
    }),
    encode: ((v, buf, offset) => {
      if (v === void 0 || v === null)
        throw new Error(`ffi-struct: encode(v) requires an argument; use alloc() for a zeroed out-param slot`);
      const out = buf ?? new PtrArrayBuffer(size);
      doEncode(new DataView(out), offset ?? 0, fields, v);
      return out;
    }),
    offsetOf: (name) => {
      for (const f of fields)
        if (f.name === name)
          return f.offset;
      throw new Error(`ffi-struct: no field "${name}"`);
    }
  };
}
function buildDecl(kind, member, pack) {
  const decl = { "#": kind };
  if (pack !== void 0)
    decl["#pack"] = pack;
  for (const [k, v] of Object.entries(member))
    if (!k.startsWith("#"))
      decl[k] = v;
  return decl;
}
function struct(a, b2, c) {
  const isNamed = typeof a === "string";
  const raw = isNamed ? b2 : a;
  const opts = isNamed ? c : b2;
  return createStruct(buildDecl("struct", raw, opts?.pack));
}

// node_modules/quickwin/lib/windows/user32.js
import * as os3 from "os";

// node_modules/quickwin/lib/windows/structs.js
var RECT = /* @__PURE__ */ struct("RECT", {
  left: "i32",
  top: "i32",
  right: "i32",
  bottom: "i32"
});
var POINT = /* @__PURE__ */ struct("POINT", {
  x: "i32",
  y: "i32"
});
var NMHDR = /* @__PURE__ */ struct("NMHDR", {
  hwndFrom: "<HWND>ptr",
  idFrom: "<>ptr",
  code: "i32"
});
var SYSTEMTIME = /* @__PURE__ */ struct("SYSTEMTIME", {
  wYear: "u16",
  wMonth: "u16",
  wDayOfWeek: "u16",
  wDay: "u16",
  wHour: "u16",
  wMinute: "u16",
  wSecond: "u16",
  wMilliseconds: "u16"
});
var NMDATETIMECHANGE = /* @__PURE__ */ struct("NMDATETIMECHANGE", {
  hdr: NMHDR.__struct,
  dwFlags: "u32",
  st: SYSTEMTIME.__struct
});
var LITEM = /* @__PURE__ */ struct("LITEM", {
  mask: "u32",
  iLink: "i32",
  state: "u32",
  stateMask: "u32",
  szID: "u16[48]@utf-16le",
  szUrl: "u16[2084]@utf-16le"
});
var NMLINK = /* @__PURE__ */ struct("NMLINK", {
  hdr: NMHDR.__struct,
  item: LITEM.__struct
});
var NMCUSTOMDRAW = /* @__PURE__ */ struct("NMCUSTOMDRAW", {
  hdr: NMHDR.__struct,
  dwDrawStage: "u32",
  hdc: "<HDC>ptr",
  rc: "i32[4]",
  dwItemSpec: "<>ptr",
  uItemState: "u32",
  lItemlParam: "<>ptr"
});
var NMLVCUSTOMDRAW = /* @__PURE__ */ struct("NMLVCUSTOMDRAW", {
  hdr: NMHDR.__struct,
  dwDrawStage: "u32",
  hdc: "<HDC>ptr",
  rc: "i32[4]",
  dwItemSpec: "<>ptr",
  uItemState: "u32",
  lItemlParam: "<>ptr",
  clrText: "u32",
  clrTextBk: "u32",
  iSubItem: "i32",
  dwItemType: "u32"
});
var NMLISTVIEW = /* @__PURE__ */ struct("NMLISTVIEW", {
  hdr: NMHDR.__struct,
  iItem: "i32",
  iSubItem: "i32",
  uNewState: "u32",
  uOldState: "u32",
  uChanged: "u32",
  ptAction: "i32[2]",
  lParam: "<>ptr"
});
var TVITEM = /* @__PURE__ */ struct("TVITEM", {
  mask: "u32",
  hItem: "<>ptr",
  state: "u32",
  stateMask: "u32",
  pszText: "<>ptr",
  cchTextMax: "i32",
  iImage: "i32",
  iSelectedImage: "i32",
  cChildren: "i32",
  lParam: "<>ptr"
});
var TVINSERTSTRUCT = /* @__PURE__ */ struct("TVINSERTSTRUCT", {
  hParent: "<>ptr",
  hInsertAfter: "<>ptr",
  item: TVITEM.__struct
});
var MSG = /* @__PURE__ */ struct("MSG", {
  hwnd: "<HWND>ptr",
  message: "u32",
  wParam: "<>ptr",
  lParam: "<>ptr",
  time: "u32",
  pt: POINT.__struct
});
var PAINTSTRUCT = /* @__PURE__ */ struct("PAINTSTRUCT", {
  hdc: "<HDC>ptr",
  fErase: "i32",
  rcPaint: RECT.__struct,
  fRestore: "i32",
  fIncUpdate: "i32",
  rgbReserved: "u8[32]"
});

// node_modules/quickwin/lib/windows/user32.js
var b = (name, sig, encoders) => bind("user32.dll", name, sig, encoders);
var _bProbe = b("GetDesktopWindow", " -> <HWND>ptr");
var LONG_PTR_SYM = os3.arch === "x64" ? "PtrW" : "W";
var GetWindowLongPtr = /* @__PURE__ */ b("GetWindowLong" + LONG_PTR_SYM, "<HWND>ptr i32@Gwlp -> <>ptr");
var SetWindowLongPtr = /* @__PURE__ */ b("SetWindowLong" + LONG_PTR_SYM, "<HWND>ptr i32@Gwlp <>ptr -> <>ptr");
var SystemParametersInfo = /* @__PURE__ */ b("SystemParametersInfoW", "u32 u32 <BYTE>ptr u32 -> i32");

// .tsc-out/deskmon.js
if (typeof globalThis.setTimeout === "undefined") {
  ;
  globalThis.setTimeout = (fn, _ms, ...a) => os4.setTimeout(() => fn(...a), _ms ?? 0);
}
var WM_TRAY = 32769;
var WM_NCHITTEST = 132;
var WM_SETFONT = 48;
var HTCAPTION = 2;
var SPI_GETWORKAREA = 48;
var IF_TYPE_SOFTWARE_LOOPBACK = 24;
var NET_RESET_BPS = 5e8;
var TICK_MS = 1e3;
var MON_W = 330;
var MON_H = 28;
var MENU_EXIT = 1;
var MENU_TOPMOST = 2;
var MAX_IF = 64;
var IFROW_SIZE = 860;
var IFROW_OFF_TYPE = 516;
var IFROW_OFF_IN = 552;
var IFROW_OFF_OUT = 556;
var FILETIME = /* @__PURE__ */ struct("FILETIME", {
  dwLowDateTime: "u32",
  dwHighDateTime: "u32"
});
var MEMORYSTATUSEX = /* @__PURE__ */ struct("MEMORYSTATUSEX", {
  dwLength: "u32",
  dwMemoryLoad: "u32",
  ullTotalPhys: "u64",
  ullAvailPhys: "u64",
  ullTotalPageFile: "u64",
  ullAvailPageFile: "u64",
  ullTotalVirtual: "u64",
  ullAvailVirtual: "u64",
  ullAvailExtendedVirtual: "u64"
});
var GetSystemTimes = bind("kernel32.dll", "GetSystemTimes", "<FILETIME>ptr <FILETIME>ptr <FILETIME>ptr -> i32");
var GlobalMemoryStatusEx = bind("kernel32.dll", "GlobalMemoryStatusEx", "<MEMORYSTATUSEX>ptr -> i32", { MEMORYSTATUSEX });
var GetIfTable = bind("iphlpapi.dll", "GetIfTable", "<>ptr <>ptr u32 -> u32");
var prevIdle = -1;
var prevKernel = -1;
var prevUser = -1;
function sampleCpu() {
  const i = FILETIME.alloc(), k = FILETIME.alloc(), u = FILETIME.alloc();
  if (!GetSystemTimes(i.ptr, k.ptr, u.ptr))
    return null;
  const toN = (buf) => {
    const d = FILETIME.decode(buf);
    return d.dwHighDateTime * 2 ** 32 + d.dwLowDateTime;
  };
  const idle = toN(i), kernel = toN(k), user = toN(u);
  if (prevIdle < 0) {
    prevIdle = idle;
    prevKernel = kernel;
    prevUser = user;
    return null;
  }
  const dTotal = kernel - prevKernel + (user - prevUser);
  const dIdle = idle - prevIdle;
  prevIdle = idle;
  prevKernel = kernel;
  prevUser = user;
  if (dTotal <= 0)
    return null;
  return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
}
function sampleMem() {
  const ms = MEMORYSTATUSEX.encode({ dwLength: MEMORYSTATUSEX.size });
  if (!GlobalMemoryStatusEx(ms.ptr))
    return null;
  const s = MEMORYSTATUSEX.decode(ms);
  const total = Number(s.ullTotalPhys);
  const avail = Number(s.ullAvailPhys);
  if (!(total > 0))
    return null;
  return Math.round((1 - avail / total) * 100);
}
var ifBuf = new PtrArrayBuffer(4 + MAX_IF * IFROW_SIZE);
var ifSize = new PtrArrayBuffer(4);
var prevNetIn = -1;
var prevNetOut = -1;
var prevNetMs = 0;
function sampleNet() {
  const dv = new DataView(ifBuf);
  dv.setUint32(0, ifBuf.byteLength, true);
  if (GetIfTable(ifBuf.ptr, ifSize.ptr, 1) !== 0)
    return null;
  const n = Math.min(dv.getUint32(0, true), MAX_IF);
  let inSum = 0, outSum = 0;
  for (let r = 0; r < n; r++) {
    const off = 4 + r * IFROW_SIZE;
    if (dv.getUint32(off + IFROW_OFF_TYPE, true) === IF_TYPE_SOFTWARE_LOOPBACK)
      continue;
    inSum += dv.getUint32(off + IFROW_OFF_IN, true);
    outSum += dv.getUint32(off + IFROW_OFF_OUT, true);
  }
  const now = Date.now();
  if (prevNetIn < 0) {
    prevNetIn = inSum;
    prevNetOut = outSum;
    prevNetMs = now;
    return null;
  }
  const dt = (now - prevNetMs) / 1e3;
  const dIn = inSum - prevNetIn >>> 0;
  const dOut = outSum - prevNetOut >>> 0;
  prevNetIn = inSum;
  prevNetOut = outSum;
  prevNetMs = now;
  if (dt <= 0)
    return null;
  return [
    dIn / dt < NET_RESET_BPS ? dIn / dt : 0,
    dOut / dt < NET_RESET_BPS ? dOut / dt : 0
  ];
}
function fmtRate(bps) {
  if (bps === null)
    return "\u2014";
  if (bps >= 1024 * 1024)
    return (bps / 1024 / 1024).toFixed(1) + " MB/s";
  if (bps >= 1024)
    return Math.round(bps / 1024) + " KB/s";
  return Math.round(bps) + " B/s";
}
var topmost = true;
var textHwnd = null;
gui.RegisterClass("DeskMon", (hwnd, msg, _w, lParam) => {
  if (!hwnd)
    return gui.DefWindowProc(hwnd, msg, _w, lParam);
  if (msg === WM_NCHITTEST)
    return HTCAPTION;
  if (msg === WM_TRAY) {
    if (lParam === 516 || lParam === 123) {
      gui.SetForegroundWindow(hwnd);
      const p = gui.GetCursorPos();
      const menu = gui.CreatePopupMenu();
      gui.AppendMenu(menu, 0, MENU_TOPMOST, topmost ? "\u53D6\u6D88\u7F6E\u9876(&T)" : "\u7A97\u53E3\u7F6E\u9876(&T)");
      gui.AppendMenu(menu, 2048, 0, "");
      gui.AppendMenu(menu, 0, MENU_EXIT, "\u9000\u51FA(&X)");
      const cmd = gui.TrackPopupMenu(menu, p ? p[0] : 0, p ? p[1] : 0, void 0, hwnd);
      gui.DestroyMenu(menu);
      if (cmd === MENU_EXIT) {
        gui.ShellNotifyIcon(2, { hwnd, uID: 1 });
        gui.PostQuitMessage(0);
      } else if (cmd === MENU_TOPMOST) {
        topmost = !topmost;
        gui.SetWindowPos(hwnd, topmost ? -1 : -2, 0, 0, 0, 0, 1 | 2);
      }
    }
    return 0;
  }
  if (msg === 16) {
    gui.ShowWindow(hwnd, 0);
    return 0;
  }
  return gui.DefWindowProc(hwnd, msg, _w, lParam);
});
var wa = RECT.alloc();
SystemParametersInfo(SPI_GETWORKAREA, 0, wa.ptr, 0);
var work = RECT.decode(wa);
var initX = (work.right || 1024) - MON_W - 8;
var initY = (work.bottom || 768) - MON_H - 8;
var hwndMain = gui.CreateWindow("DeskMon", "", -2147483648 | 268435456, initX, initY, MON_W, MON_H, null, null);
if (!hwndMain)
  os4.exit(1);
textHwnd = gui.CreateWindow("STATIC", "deskmon starting\u2026", 1073741824 | 268435456, 8, 5, MON_W - 16, MON_H - 10, hwndMain, null);
var font = gui.CreateSystemDpiFont();
if (textHwnd && font)
  gui.SendMessage(textHwnd, WM_SETFONT, font, 1);
gui.SetWindowPos(hwndMain, -1, 0, 0, 0, 0, 1 | 2);
var hIcon = gui.LoadAppIcon();
if (!hIcon)
  hIcon = gui.LoadImage(
    null,
    32512,
    1,
    0,
    0,
    32768
    /* gui.LoadImageFlag.SHARED */
  );
if (hIcon) {
  gui.ShellNotifyIcon(0, {
    hwnd: hwndMain,
    uID: 1,
    flags: 1 | 2,
    callbackMessage: WM_TRAY,
    hIcon
  });
}
function tick() {
  const cpu = sampleCpu();
  const mem = sampleMem();
  const net = sampleNet();
  const line = "\u2193 " + fmtRate(net ? net[0] : null) + "   \u2191 " + fmtRate(net ? net[1] : null) + "   \u5185\u5B58 " + (mem === null ? "--" : mem) + "%   CPU " + (cpu === null ? "--" : cpu) + "%";
  if (textHwnd)
    gui.SetWindowText(textHwnd, line);
  print(line);
  setTimeout(tick, TICK_MS);
}
print("deskmon started: " + MON_W + "x" + MON_H + " @(" + initX + "," + initY + ") topmost=" + topmost + " tick=" + TICK_MS + "ms");
setTimeout(tick, TICK_MS);
