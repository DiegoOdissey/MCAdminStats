'use strict';
// Minimal NBT reader (Java Edition, big-endian). No dependencies.
// Handles gzip-compressed files such as world/playerdata/<uuid>.dat
const zlib = require('zlib');

function parseNBT(input) {
  let buf = input;
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  let p = 0;

  const readString = () => {
    const len = buf.readUInt16BE(p);
    p += 2;
    const s = buf.toString('utf8', p, p + len);
    p += len;
    return s;
  };

  const readPayload = (type) => {
    switch (type) {
      case 1: return buf.readInt8(p++);
      case 2: { const v = buf.readInt16BE(p); p += 2; return v; }
      case 3: { const v = buf.readInt32BE(p); p += 4; return v; }
      case 4: { const v = buf.readBigInt64BE(p); p += 8; return Number(v); }
      case 5: { const v = buf.readFloatBE(p); p += 4; return v; }
      case 6: { const v = buf.readDoubleBE(p); p += 8; return v; }
      case 7: { // byte array
        const len = buf.readInt32BE(p); p += 4;
        const v = buf.subarray(p, p + len); p += len; return v;
      }
      case 8: return readString();
      case 9: { // list
        const itemType = buf.readInt8(p++);
        const len = buf.readInt32BE(p); p += 4;
        const arr = new Array(Math.max(len, 0));
        for (let i = 0; i < len; i++) arr[i] = readPayload(itemType);
        return arr;
      }
      case 10: { // compound
        const obj = {};
        for (;;) {
          const t = buf.readInt8(p++);
          if (t === 0) break;
          const name = readString();
          obj[name] = readPayload(t);
        }
        return obj;
      }
      case 11: { // int array
        const len = buf.readInt32BE(p); p += 4;
        const arr = new Array(len);
        for (let i = 0; i < len; i++) { arr[i] = buf.readInt32BE(p); p += 4; }
        return arr;
      }
      case 12: { // long array
        const len = buf.readInt32BE(p); p += 4;
        const arr = new Array(len);
        for (let i = 0; i < len; i++) { arr[i] = Number(buf.readBigInt64BE(p)); p += 8; }
        return arr;
      }
      default:
        throw new Error('Unknown NBT tag type ' + type + ' at offset ' + p);
    }
  };

  const rootType = buf.readInt8(p++);
  if (rootType !== 10) throw new Error('NBT root is not a compound');
  readString(); // root name (usually empty)
  return readPayload(10);
}

module.exports = { parseNBT };
