/** Reads a pg_dump from stdin and uploads it to R2. Run by scripts/backup.sh. */
import process from "node:process";

const required = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT"] as const;
for (const k of required) if (!process.env[k]) throw new Error(`${k} is not set`);

const client = new Bun.S3Client({
  accessKeyId: process.env["R2_ACCESS_KEY_ID"] as string,
  secretAccessKey: process.env["R2_SECRET_ACCESS_KEY"] as string,
  endpoint: process.env["R2_ENDPOINT"] as string,
  bucket: process.env["R2_BUCKET"] ?? "trackertf-backups",
});

const chunks: Uint8Array[] = [];
for await (const chunk of Bun.stdin.stream()) chunks.push(chunk as Uint8Array);
const data = Buffer.concat(chunks);
if (data.length < 1024) throw new Error(`dump suspiciously small (${data.length} bytes)`);

const key = `pg/trackertf-${new Date().toISOString().slice(0, 10)}.dump`;
await client.write(key, data);
console.log(`uploaded ${key} (${(data.length / 1024 / 1024).toFixed(1)} MiB)`);
process.exit(0);
