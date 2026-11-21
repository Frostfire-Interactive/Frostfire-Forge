#!/usr/bin/env bun

import fs from "node:fs";
import { ensureLocalCertificate, getCertificateStatus } from "./local_cert.ts";

const certPath = process.env.TLS_CERT_PATH;
const keyPath = process.env.TLS_KEY_PATH;
const caPath = process.env.TLS_CA_PATH;

if (!certPath || !keyPath) {
  console.error("TLS_CERT_PATH and TLS_KEY_PATH must be set to generate a local WebTransport certificate.");
  process.exit(1);
}

const force = process.argv.includes("--force");

const generated = await ensureLocalCertificate({ certPath, keyPath, caPath, force });

if (generated) {
  console.log(`Certificate SHA-256: ${generated.hash}`);
  console.log(`Saved to ${certPath} and ${keyPath}`);
} else if (fs.existsSync(certPath)) {
  const status = getCertificateStatus(fs.readFileSync(certPath, "utf8"));
  if (!status.parseable || status.expired) {
    if (!status.selfSigned) {
      console.error(
        `Certificate at ${certPath} is EXPIRED (valid: ${status.validFrom} -> ${status.validTo}) and CA-signed, ` +
        `so it cannot be auto-regenerated. Renew it via your CA (local mkcert setups: \`bun renew-lan-cert\`), ` +
        `or re-run with --force to replace it with a self-signed certificate ` +
        `(changes the pin; Safari/iOS will reject self-signed leaves).`
      );
      process.exit(1);
    }
    console.error(`Certificate at ${certPath} is expired or unreadable. Re-run with --force to replace it.`);
    process.exit(1);
  }
  console.log(`Certificate at ${certPath} is valid until ${status.validTo}. No changes made.`);
  if ((status.daysRemaining ?? 0) < 3) {
    console.log(`WARNING: it expires in ${status.daysRemaining} days. Renew soon to avoid client handshake failures.`);
  }
} else {
  console.log("Local WebTransport certificate is already valid. No changes made.");
}
