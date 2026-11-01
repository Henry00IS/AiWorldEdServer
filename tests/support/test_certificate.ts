/**
 * Creates a throwaway self-signed TLS certificate for 127.0.0.1 and localhost
 * with WebCrypto, so TLS tests need no fixture key in the repository and no
 * external tool.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** PEM files of a test certificate and the directory holding them. */
export interface TestCertificate {
  readonly certificatePem: string;
  readonly certificateFile: string;
  readonly keyFile: string;
  readonly remove: () => void;
}

/**
 * Encodes a DER length.
 *
 * @param length Content length.
 * @returns Length bytes.
 */
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) bytes.unshift(remaining % 256);
  return [0x80 | bytes.length, ...bytes];
}

/**
 * Encodes one DER element.
 *
 * @param tag Tag byte.
 * @param contents Content bytes.
 * @returns Element bytes.
 */
function der(tag: number, ...contents: (number[] | Uint8Array)[]): number[] {
  const body = contents.flatMap((part) => [...part]);
  return [tag, ...derLength(body.length), ...body];
}

/**
 * Encodes an object identifier.
 *
 * @param dotted Dotted OID.
 * @returns OID element.
 */
function derOid(dotted: string): number[] {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const body = [first * 40 + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let value = arc >>> 7; value > 0; value >>>= 7) chunk.unshift((value & 0x7f) | 0x80);
    body.push(...chunk);
  }
  return der(0x06, body);
}

/**
 * Encodes an unsigned big-endian integer.
 *
 * @param bytes Magnitude bytes.
 * @returns INTEGER element.
 */
function derUnsignedInteger(bytes: Uint8Array): number[] {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = [...bytes.slice(start)];
  return der(0x02, (trimmed[0] ?? 0) & 0x80 ? [0, ...trimmed] : trimmed);
}

/**
 * Encodes a date as UTCTime.
 *
 * @param date Date to encode.
 * @returns UTCTime element.
 */
function derUtcTime(date: Date): number[] {
  const text = date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
  return der(0x17, new TextEncoder().encode(text));
}

/**
 * Builds the to-be-signed part of the certificate.
 *
 * @param spki DER public key info.
 * @returns TBSCertificate element.
 */
function testCertificateTbs(spki: Uint8Array): number[] {
  const name = der(0x30, der(0x31, der(0x30, derOid('2.5.4.3'), der(0x0c, new TextEncoder().encode('localhost')))));
  const dayMs = 86_400_000;
  const subjectAltName = der(0x30, der(0x82, new TextEncoder().encode('localhost')), der(0x87, [127, 0, 0, 1]));
  const extensions = der(0xa3, der(0x30, der(0x30, derOid('2.5.29.17'), der(0x04, subjectAltName))));
  return der(
    0x30,
    der(0xa0, der(0x02, [2])),
    derUnsignedInteger(crypto.getRandomValues(new Uint8Array(8))),
    der(0x30, derOid('1.2.840.10045.4.3.2')),
    name,
    der(0x30, derUtcTime(new Date(Date.now() - dayMs)), derUtcTime(new Date(Date.now() + dayMs))),
    name,
    spki,
    extensions,
  );
}

/**
 * Wraps DER bytes as PEM.
 *
 * @param label PEM label.
 * @param bytes DER bytes.
 * @returns PEM text.
 */
function testCertificatePem(label: string, bytes: Uint8Array): string {
  const lines =
    Buffer.from(bytes)
      .toString('base64')
      .match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * Signs the certificate body and assembles the DER certificate.
 *
 * @param keys ECDSA P-256 key pair.
 * @param tbs To-be-signed bytes.
 * @returns DER certificate.
 */
async function testCertificateSign(keys: CryptoKeyPair, tbs: number[]): Promise<Uint8Array> {
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new Uint8Array(tbs)),
  );
  const signature = der(0x30, derUnsignedInteger(raw.slice(0, 32)), derUnsignedInteger(raw.slice(32)));
  return new Uint8Array(der(0x30, tbs, der(0x30, derOid('1.2.840.10045.4.3.2')), der(0x03, [0], signature)));
}

/**
 * Creates a self-signed certificate valid for one day and writes the PEM files
 * to a fresh temporary directory.
 *
 * @returns Certificate PEM, file paths and a cleanup function.
 */
export async function testCertificateCreate(): Promise<TestCertificate> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const certificatePem = testCertificatePem('CERTIFICATE', await testCertificateSign(keys, testCertificateTbs(spki)));
  const keyPem = testCertificatePem(
    'PRIVATE KEY',
    new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey)),
  );
  const directory = mkdtempSync(join(tmpdir(), 'aiworlded-relay-tls-'));
  const certificateFile = join(directory, 'cert.pem');
  const keyFile = join(directory, 'key.pem');
  await Bun.write(certificateFile, certificatePem);
  await Bun.write(keyFile, keyPem);
  return {
    certificatePem,
    certificateFile,
    keyFile,
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}
