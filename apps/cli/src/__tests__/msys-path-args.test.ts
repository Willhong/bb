import { describe, expect, it } from "vitest";
import { resolveMsysRoot, restoreMsysPosixArgs } from "../msys-path-args.js";

const gitBashEnv = {
  MSYSTEM: "MINGW64",
  EXEPATH: "C:\\Program Files\\Git\\bin",
};

function restore(
  argv: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    existing?: string[];
  } = {},
): string[] {
  const existing = new Set(options.existing ?? []);
  return restoreMsysPosixArgs({
    argv,
    env: options.env ?? gitBashEnv,
    platform: options.platform ?? "win32",
    exists: (path) => existing.has(path),
  });
}

describe("restoreMsysPosixArgs", () => {
  it("restores a POSIX path Git Bash rewrote under its install root", () => {
    expect(
      restore([
        "file",
        "read",
        "--host",
        "host_mac",
        "C:/Program Files/Git/Users/me/project/notes.md",
      ]),
    ).toEqual([
      "file",
      "read",
      "--host",
      "host_mac",
      "/Users/me/project/notes.md",
    ]);
  });

  it("restores the value of an --option=value argument", () => {
    expect(restore(["--root=C:/Program Files/Git/Users/me/project"])).toEqual([
      "--root=/Users/me/project",
    ]);
  });

  it("keeps paths with spaces intact after restoring", () => {
    expect(restore(["C:/Program Files/Git/Users/me/My Docs/a b.txt"])).toEqual(
      ["/Users/me/My Docs/a b.txt"],
    );
  });

  it("matches the install root case-insensitively", () => {
    expect(restore(["c:/program files/git/home/me/x"])).toEqual([
      "/home/me/x",
    ]);
  });

  it("keeps a rewritten path that exists on this machine", () => {
    const bash = "C:/Program Files/Git/usr/bin/bash.exe";
    expect(restore([bash], { existing: [bash] })).toEqual([bash]);
  });

  it("leaves native Windows paths outside the install root alone", () => {
    expect(
      restore([
        "C:/Users/me/AppData/Local/Temp/y",
        "C:\\Users\\me\\file.txt",
        "--prompt=hello",
      ]),
    ).toEqual([
      "C:/Users/me/AppData/Local/Temp/y",
      "C:\\Users\\me\\file.txt",
      "--prompt=hello",
    ]);
  });

  it("does nothing outside an MSYS shell", () => {
    const argv = ["C:/Program Files/Git/Users/me/x"];
    expect(restore(argv, { env: { EXEPATH: gitBashEnv.EXEPATH } })).toEqual(
      argv,
    );
  });

  it("does nothing on non-Windows platforms", () => {
    const argv = ["C:/Program Files/Git/Users/me/x"];
    expect(restore(argv, { platform: "darwin" })).toEqual(argv);
  });
});

describe("resolveMsysRoot", () => {
  it("derives the install root from EXEPATH ending in bin or usr\\bin", () => {
    expect(resolveMsysRoot(gitBashEnv)).toBe("C:/Program Files/Git/");
    expect(
      resolveMsysRoot({ MSYSTEM: "MSYS", EXEPATH: "D:\\msys64\\usr\\bin\\" }),
    ).toBe("D:/msys64/");
  });

  it("returns null without MSYSTEM or EXEPATH", () => {
    expect(resolveMsysRoot({ EXEPATH: "C:\\Program Files\\Git\\bin" })).toBe(
      null,
    );
    expect(resolveMsysRoot({ MSYSTEM: "MINGW64" })).toBe(null);
  });
});
