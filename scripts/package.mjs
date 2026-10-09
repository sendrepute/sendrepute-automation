import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const files = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "package.json",
  "examples/classify-request.json",
  "examples/classify-response.schema.json",
  "examples/classify.sh",
  "examples/proxy.mjs",
  "examples/proxy-policy.mjs",
  "make/README.md",
  "zapier/README.md",
  "zapier/preflight.js",
  "zapier/validate-response.js",
  "src/customer-api/index.mjs",
  "src/customer-api/catalog.mjs",
  "src/customer-api/policy.mjs",
  "src/customer-api/client.mjs",
  "src/customer-api/admin.mjs",
  "src/customer-api/serve.mjs",
  "src/customer-api/intent-store.mjs",
  "src/customer-api/customer-api-operations.json",
  "src/customer-api/admin-ui.html",
  "examples/customer-console.mjs"
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; }

export async function buildZip() {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const relative of [...files].sort()) {
    const name = Buffer.from(`sendrepute-automation-recipes/${relative}`);
    const data = await readFile(path.join(root, relative));
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(33),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data
    ]);
    locals.push(local);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(0x0314), u16(20), u16(0), u16(0), u16(0), u16(33),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
      u16(0), u16(0), u16(0), u32(relative.endsWith(".sh") ? 0x81ed0000 : 0x81a40000),
      u32(offset), name
    ]));
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  return Buffer.concat([
    ...locals, directory, u32(0x06054b50), u16(0), u16(0), u16(files.length),
    u16(files.length), u32(directory.length), u32(offset), u16(0)
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist", "sendrepute-automation-recipes-0.2.0.zip"),
    await buildZip());
}