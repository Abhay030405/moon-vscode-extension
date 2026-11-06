// Tools never read, list or search files that usually hold secrets (.env, keys, credential
// files). The patterns come from config (safety.secretFileGlobs / secretFileExceptions).

import picomatch from "picomatch";
import type { MoonConfig } from "../shared/config.js";

export class SecretGuard {
  private readonly isSecretGlob: (path: string) => boolean;
  private readonly isException: (path: string) => boolean;

  constructor(settings: MoonConfig["safety"]) {
    const options = { dot: true, nocase: true };
    this.isSecretGlob = picomatch(settings.secretFileGlobs, options);
    this.isException = picomatch(settings.secretFileExceptions, options);
  }

  /** `rel` is a project-relative path with "/" separators. */
  isSecret(rel: string): boolean {
    return this.isSecretGlob(rel) && !this.isException(rel);
  }
}
