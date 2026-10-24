import { lstat, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, relative, join, isAbsolute, dirname } from "node:path";
import { createHash } from "node:crypto";
import { git } from "./process.js";
export function safeRelative(path: string) {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes(":") ||
    path
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          p.toLowerCase() === ".git" ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
      ) ||
    /[\x00-\x1f]/.test(path)
  )
    throw Error("Unsafe repository path");
  return path;
}
export async function safePath(root: string, path: string) {
  safeRelative(path);
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw Error("Symlinks are forbidden");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return current;
}
export function protectedPath(path: string) {
  return /(^|\/)(tests?|__tests__|\.taskheist|acceptance)(\/|\.|$)|\.(test|spec)\.|(^|\/)AGENTS\.md$/i.test(
    path,
  );
}
export async function readRepo(root: string, path: string) {
  if (/(^|\/)(\.env(?:\..*)?|\.aws|\.ssh)|\.(pem|key)$/i.test(path))
    throw Error("Credential-like files are not readable");
  const p = await safePath(root, path);
  const stat = await lstat(p);
  if (!stat.isFile() || stat.size > 100000)
    throw Error("Read requires a regular file under 100KB");
  return readFile(p, "utf8");
}
export async function writeRepo(root: string, path: string, content: string) {
  if (path.split("/").some((p) => p.toLowerCase() === "node_modules"))
    throw Error("Dependency directory is protected");
  if (protectedPath(path)) throw Error("Protected verifier/acceptance file");
  const p = await safePath(root, path);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
}
export async function files(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    if (entry.name.toLowerCase() === ".git") continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw Error("Repository symlinks are not supported");
    if (entry.isDirectory()) result.push(...(await files(root, name)));
    else if (entry.isFile()) result.push(name);
    if (result.length > 3000) throw Error("MVP repository limit: 3000 files");
  }
  return result.sort();
}
export async function revision(root: string) {
  const hash = createHash("sha256");
  for (const name of await files(root)) {
    hash.update(name + "\0");
    hash.update(await readFile(join(root, name)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
export async function isolate(repo: string, dest: string) {
  const source = resolve(repo);
  if (!(await lstat(source)).isDirectory())
    throw Error("Repository must be a directory");
  const top = await git(["rev-parse", "--show-toplevel"], source);
  if (relative(source, top) !== "") throw Error("Use the Git repository root");
  if (await git(["status", "--porcelain"], source))
    throw Error(
      "Target repository must be clean; commit or stash changes first",
    );
  await git(["clone", "--local", "--no-hardlinks", "--", source, dest]);
  await files(dest);
  return dest;
}
