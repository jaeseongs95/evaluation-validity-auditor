import { readFile } from "node:fs/promises";

export function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

export async function readJsonInput(args) {
  const file = argumentValue(args, "--input");
  if (file) return JSON.parse(await readFile(file, "utf8"));
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new Error("Provide JSON through stdin or --input.");
  return JSON.parse(raw);
}

export async function readJsonFile(args, name) {
  const file = argumentValue(args, name);
  if (!file) throw new Error(`${name} is required.`);
  return JSON.parse(await readFile(file, "utf8"));
}

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
