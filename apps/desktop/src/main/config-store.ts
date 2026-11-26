// Desktop settings (`<userData>/desktop.json`, mode 0600). The device token is stored only as
// OS-encrypted ciphertext (Electron safeStorage: macOS Keychain, Windows DPAPI, Linux Secret
// Service); it is decrypted in memory and handed to the daemon through an environment variable at
// spawn time, never written in plaintext.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

export interface TokenCipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

/** A plain file name (no folder, no separator), as the AppImage's file name is kept (07.13.1, Pitfall 6). */
const FileName = z.string().regex(/^[^/\\]{1,255}$/);

const StoredConfig = z.object({
  version: z.literal(1).default(1),
  webUrl: z.string().nullable().default(null),
  apiUrl: z.string().nullable().default(null),
  deviceId: z.string().nullable().default(null),
  organizationId: z.string().nullable().default(null),
  deviceName: z.string().nullable().default(null),
  /** base64 safeStorage ciphertext of the device token. */
  encryptedToken: z.string().nullable().default(null),
  onboarded: z.boolean().default(false),
  /**
   * 07.13.1 (Pitfall 6): the AppImage's file name at the last start, so a renamed file after an update is announced
   * once. A file name only, never its folder; an unreadable value is dropped on its own, never the other settings.
   */
  lastAppImageName: FileName.optional().catch(undefined),
});
export type StoredConfig = z.infer<typeof StoredConfig>;

export class ConfigStore {
  private data: StoredConfig = StoredConfig.parse({});
  readonly file: string;

  constructor(
    userDataDir: string,
    private readonly cipher: TokenCipher,
  ) {
    this.file = join(userDataDir, "desktop.json");
  }

  async load(): Promise<void> {
    try {
      this.data = StoredConfig.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      this.data = StoredConfig.parse({});
    }
  }

  get config(): Readonly<StoredConfig> {
    return this.data;
  }

  get paired(): boolean {
    return this.data.encryptedToken !== null;
  }

  async update(patch: Partial<Omit<StoredConfig, "version" | "encryptedToken">>): Promise<void> {
    const next = { ...patch };
    // A path or an over-long name is refused: the stored name stays as it was.
    if (next.lastAppImageName !== undefined && !FileName.safeParse(next.lastAppImageName).success)
      delete next.lastAppImageName;
    this.data = { ...this.data, ...next };
    await this.save();
  }

  async setDevice(input: {
    deviceId: string;
    organizationId: string | null;
    deviceName: string;
    token: string;
  }): Promise<void> {
    if (!this.cipher.isAvailable()) {
      throw new Error(
        "Secure storage (the Keychain, Credential Manager or a Secret Service keyring) is not available, so the device token cannot be stored safely.",
      );
    }
    const encryptedToken = this.cipher.encrypt(input.token).toString("base64");
    this.data = {
      ...this.data,
      deviceId: input.deviceId,
      organizationId: input.organizationId,
      deviceName: input.deviceName,
      encryptedToken,
    };
    await this.save();
  }

  /** Decrypted token for spawning the daemon, or null if unpaired/undecryptable. */
  token(): string | null {
    if (!this.data.encryptedToken || !this.cipher.isAvailable()) return null;
    try {
      return this.cipher.decrypt(Buffer.from(this.data.encryptedToken, "base64"));
    } catch {
      return null;
    }
  }

  async unpair(): Promise<void> {
    this.data = {
      ...this.data,
      deviceId: null,
      organizationId: null,
      encryptedToken: null,
      onboarded: false,
    };
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
    await chmod(this.file, 0o600).catch(() => undefined);
  }
}
