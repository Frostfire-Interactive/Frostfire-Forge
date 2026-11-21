import crypto from "crypto";

export async function hash(password: string) {
  return await Bun.password.hash(password);
}

export async function verify(password: string, hash: string) {
  return await Bun.password.verify(password, hash);
}

export function randomBytes(size: number) {
  return crypto.randomBytes(size).toString("hex");
}