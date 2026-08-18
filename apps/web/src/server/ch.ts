import { type Ch, createChFromEnv } from "@trackertf/clickhouse";

let ch: Ch | undefined;
export function getCh(): Ch {
  ch ??= createChFromEnv();
  return ch;
}
