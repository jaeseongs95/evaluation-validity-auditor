import { readFile } from "node:fs/promises";

export async function readJsonArgument(args) {
  const inputIndex = args.indexOf("--input");
  if (inputIndex >= 0) {
    const file = args[inputIndex + 1];
    if (!file) throw new Error("--input requires a file path.");
    return JSON.parse(await readFile(file, "utf8"));
  }
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new Error("Provide JSON through stdin or --input.");
  return JSON.parse(raw);
}

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
