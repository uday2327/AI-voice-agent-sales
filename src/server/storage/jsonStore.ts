import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDir, "../../..");

export const resolveFromProjectRoot = (...segments: string[]) =>
  path.join(projectRoot, ...segments);

export const readJsonFile = async <T>(...segments: string[]): Promise<T> => {
  const filePath = resolveFromProjectRoot(...segments);
  const content = await readFile(filePath, "utf8");

  return JSON.parse(content) as T;
};

export const writeJsonFile = async <T>(
  value: T,
  ...segments: string[]
): Promise<string> => {
  const filePath = resolveFromProjectRoot(...segments);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");

  return filePath;
};
