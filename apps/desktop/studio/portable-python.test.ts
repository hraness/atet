import { expect, test } from "bun:test";
import { join } from "node:path";

for (const directory of ["drivers", "education"]) test(`studio ${directory} boundaries pass without installed native engines`, async () => {
  const python = process.platform === "darwin" ? "/usr/bin/python3" : Bun.which("python3");
  expect(python).toBeDefined();
  const child = Bun.spawn([python!, "-B", "-m", "unittest", "discover", "-s", join(import.meta.dir, directory), "-p", "test_*.py"], {
    stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 30_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exitCode, output: `${stdout}${stderr}` }).toMatchObject({ exitCode: 0 });
}, 35_000);
