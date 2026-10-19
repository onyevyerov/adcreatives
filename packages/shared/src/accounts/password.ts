import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from "node:crypto";

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

const N = 16384;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
/** Межа N з рядка хеша: захист від «дорогого» підробленого рядка. */
const MAX_N = 1 << 20;

function scryptAsync(plain: string, salt: Buffer, keyLen: number, cost: { N: number; r: number; p: number }) {
  // Запас пам'яті понад 128·N·r, інакше дефолтний maxmem (32 МБ) відхиляє дорожчі параметри.
  const opts: ScryptOptions = { ...cost, maxmem: 256 * cost.N * cost.r + 32 * 1024 * 1024 };
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(plain, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Хеш пароля: `scrypt$N$r$p$<salt b64url>$<hash b64url>`. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(plain, salt, KEY_BYTES, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Перевірка за сталий час; невалідний формат `stored` → false (не виняток). */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map((v) => (/^\d+$/.test(v ?? "") ? Number(v) : Number.NaN));
  if (!n || !r || !p || n > MAX_N || (n & (n - 1)) !== 0 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const key = await scryptAsync(plain, salt, expected.length, { N: n, r, p });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/**
 * Заздалегідь згенерований хеш (тієї ж вартості): `login` для неіснуючого e-mail перевіряє пароль
 * проти нього, щоб час відповіді не видавав, чи існує акаунт.
 */
export const DUMMY_PASSWORD_HASH =
  "scrypt$16384$8$1$jVGBaAXFwhjxApG0SV79RA$rz-uyzGS1XeyCPaSJXBE4hjl8-8mPyMpG9GWYFiaIueWqEFBU8qYvaAAVoEC68TfsDUSnthVyltL73sqwggIrg";
