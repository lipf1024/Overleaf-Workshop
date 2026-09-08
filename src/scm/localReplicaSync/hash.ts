import { createHash } from 'crypto';

export function contentHash(content?: Uint8Array): string | undefined {
    if (content===undefined) { return undefined; }
    return createHash('sha256').update(content).digest('hex');
}

export function equalContent(a?: Uint8Array, b?: Uint8Array): boolean {
    if (a===undefined || b===undefined) { return a===b; }
    if (a.byteLength!==b.byteLength) { return false; }
    return Buffer.compare(Buffer.from(a), Buffer.from(b))===0;
}
